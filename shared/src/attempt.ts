import type { JudgeCaseResult, JudgeErrorKind, JudgeResult, LlmProviderKind, RubricPointVerdict } from './judge.js';

/**
 * 判题历史留档（N-05）：每次正式提交除了"过没过、拿多少 XP"，
 * 还要能回看"挂在哪个用例、当时写了什么"，否则复盘只能靠记忆。
 *
 * 存在 attempts.detail 这一列里（JSON 文本），所以它有版本号和体积预算：
 * 判题日志和提交正文都是外部输入，不设上限就能把进度库撑爆。
 */

export const ATTEMPT_DETAIL_VERSION = 1;

/** 单条留档序列化后的字节上限。超了按 `drop` 顺序逐级瘦身，不是直接拒绝写。 */
export const ATTEMPT_DETAIL_BUDGET_BYTES = 12_000;

/** 各分量的硬上限（字节）。留档是给"人看"的，宁可不全也不要不可读。 */
export const ATTEMPT_DETAIL_CAPS = {
  submission: 4096,
  logs: 2048,
  caseName: 128,
  caseField: 256,
  failedCases: 20,
  passedCaseNames: 20,
  rubricPoints: 20,
  rubricLabel: 128,
  rubricNextStep: 192,
  listItems: 10,
  listItem: 128,
} as const;

export interface AttemptDetail {
  /** 留档格式版本；读侧只认 `ATTEMPT_DETAIL_VERSION`，将来加字段就 bump */
  v: typeof ATTEMPT_DETAIL_VERSION;
  kind: 'judge' | 'grade';
  /** 代码题：失败用例（判题器报什么就存什么，形状与 JudgeResult 对齐） */
  failedCases?: JudgeCaseResult[];
  /** 代码题：通过用例只留名字，不重复存期望/实际 */
  passedCaseNames?: string[];
  errorKind?: JudgeErrorKind;
  /** 代码题：截断后的判题日志（编译诊断 / traceback） */
  logs?: string;
  /** 主观题：逐评分点命中情况 */
  rubric?: RubricPointVerdict[];
  bonus?: string[];
  gaps?: string[];
  provider?: LlmProviderKind;
  /** 当时的提交正文（代码或答案）—— 复盘"我上次到底写了什么" */
  submission?: string;
  /** 正文被裁剪时的原长度，UI 据此说明"这是截断后的" */
  submissionChars?: number;
}

const encoder = new TextEncoder();

function byteLen(text: string): number {
  return encoder.encode(text).length;
}

/** 按字节裁剪，且不切断码点（中文一个字 3 字节，切一半就是一堆问号）。 */
function clipBytes(text: string, max: number): { text: string; clipped: boolean } {
  if (byteLen(text) <= max) return { text, clipped: false };
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = byteLen(ch);
    if (bytes + size > max) break;
    bytes += size;
    out += ch;
  }
  return { text: out, clipped: true };
}

function clipList(items: readonly string[], max: number, cap: number): string[] {
  return items.slice(0, max).map((item) => clipBytes(String(item), cap).text);
}

export function detailFromJudge(result: JudgeResult, submission: string): AttemptDetail {
  const detail: AttemptDetail = { v: ATTEMPT_DETAIL_VERSION, kind: 'judge' };
  detail.failedCases = result.failedCases.slice(0, ATTEMPT_DETAIL_CAPS.failedCases).map((c) => ({
    name: clipBytes(String(c.name), ATTEMPT_DETAIL_CAPS.caseName).text,
    passed: c.passed,
    ...(c.expected === undefined ? {} : { expected: clipBytes(String(c.expected), ATTEMPT_DETAIL_CAPS.caseField).text }),
    ...(c.actual === undefined ? {} : { actual: clipBytes(String(c.actual), ATTEMPT_DETAIL_CAPS.caseField).text }),
    ...(c.message === undefined ? {} : { message: clipBytes(String(c.message), ATTEMPT_DETAIL_CAPS.caseField).text }),
  }));
  detail.passedCaseNames = clipList(result.passedCases, ATTEMPT_DETAIL_CAPS.passedCaseNames, ATTEMPT_DETAIL_CAPS.caseName);
  if (result.errorKind) detail.errorKind = result.errorKind;
  if (result.logs) detail.logs = clipBytes(result.logs, ATTEMPT_DETAIL_CAPS.logs).text;
  attachSubmission(detail, submission);
  return detail;
}

export function detailFromGrade(verdict: RubricVerdictLike, answer: string): AttemptDetail {
  const detail: AttemptDetail = { v: ATTEMPT_DETAIL_VERSION, kind: 'grade' };
  detail.rubric = (verdict.rubricBreakdown ?? []).slice(0, ATTEMPT_DETAIL_CAPS.rubricPoints).map((point) => ({
    label: clipBytes(String(point.label), ATTEMPT_DETAIL_CAPS.rubricLabel).text,
    hit: point.hit,
    earned: point.earned,
    ...(point.nextStep === undefined ? {} : { nextStep: clipBytes(String(point.nextStep), ATTEMPT_DETAIL_CAPS.rubricNextStep).text }),
  }));
  detail.bonus = clipList(verdict.bonus ?? [], ATTEMPT_DETAIL_CAPS.listItems, ATTEMPT_DETAIL_CAPS.listItem);
  detail.gaps = clipList(verdict.gaps ?? [], ATTEMPT_DETAIL_CAPS.listItems, ATTEMPT_DETAIL_CAPS.listItem);
  if (verdict.provider) detail.provider = verdict.provider;
  attachSubmission(detail, answer);
  return detail;
}

/** 只取 detail 用得上的那几项，避免把 `raw`（provider 原始输出）也存进库。 */
interface RubricVerdictLike {
  bonus?: string[];
  gaps?: string[];
  provider?: LlmProviderKind;
  rubricBreakdown?: RubricPointVerdict[];
}

function attachSubmission(detail: AttemptDetail, source: string): void {
  const text = String(source ?? '');
  const { text: kept, clipped } = clipBytes(text, ATTEMPT_DETAIL_CAPS.submission);
  if (text) detail.submission = kept;
  if (clipped) detail.submissionChars = text.length;
}

type DropStep = 'logs' | 'passedCaseNames' | 'caseFields' | 'gradeLists' | 'submission' | 'cases';

/** 瘦身的顺序就是"可牺牲程度"的顺序：先丢体积最大的日志，最后才丢用例名。 */
const DROP_ORDER: DropStep[] = ['logs', 'passedCaseNames', 'caseFields', 'gradeLists', 'submission', 'cases'];

export function serializeAttemptDetail(detail: AttemptDetail): string {
  let candidate: AttemptDetail = { ...detail };
  const fits = (value: AttemptDetail): boolean => byteLen(JSON.stringify(value)) <= ATTEMPT_DETAIL_BUDGET_BYTES;
  if (fits(candidate)) return JSON.stringify(candidate);
  for (const step of DROP_ORDER) {
    candidate = drop(candidate, step);
    if (fits(candidate)) return JSON.stringify(candidate);
  }
  return JSON.stringify(candidate);
}

function drop(detail: AttemptDetail, step: DropStep): AttemptDetail {
  const next: AttemptDetail = { ...detail, v: ATTEMPT_DETAIL_VERSION, kind: detail.kind };
  switch (step) {
    case 'logs':
      delete next.logs;
      return next;
    case 'passedCaseNames':
      delete next.passedCaseNames;
      return next;
    case 'caseFields':
      // 用例名和一句话报错留下——"挂在哪"比"期望啥实际啥"更值钱
      next.failedCases = (detail.failedCases ?? []).map((c) => ({ name: c.name, passed: c.passed, ...(c.message ? { message: c.message } : {}) }));
      return next;
    case 'gradeLists':
      delete next.bonus;
      delete next.gaps;
      delete next.rubric;
      return next;
    case 'submission':
      // 正文退到最小可用：告诉用户"当时写了那么长"，但不占预算
      next.submission = clipBytes(detail.submission ?? '', 512).text;
      if (detail.submissionChars === undefined && byteLen(detail.submission ?? '') > 512) {
        next.submissionChars = detail.submission?.length;
      }
      return next;
    case 'cases':
      delete next.failedCases;
      return next;
  }
}

/** 读侧宽容：坏数据当"没有留档"，不能让一条历史把整个页面带走。 */
export function parseAttemptDetail(raw: string | null | undefined): AttemptDetail | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.v !== ATTEMPT_DETAIL_VERSION) return null;
  if (value.kind !== 'judge' && value.kind !== 'grade') return null;
  const detail: AttemptDetail = { v: ATTEMPT_DETAIL_VERSION, kind: value.kind };
  if (Array.isArray(value.failedCases)) {
    detail.failedCases = value.failedCases
      .filter((c): c is JudgeCaseResult => !!c && typeof c === 'object' && typeof (c as JudgeCaseResult).name === 'string')
      .map((c) => ({ name: c.name, passed: !!c.passed, ...(c.expected === undefined ? {} : { expected: c.expected }), ...(c.actual === undefined ? {} : { actual: c.actual }), ...(c.message === undefined ? {} : { message: c.message }) }));
  }
  if (Array.isArray(value.passedCaseNames)) detail.passedCaseNames = value.passedCaseNames.map(String);
  if (typeof value.errorKind === 'string') detail.errorKind = value.errorKind as JudgeErrorKind;
  if (typeof value.logs === 'string') detail.logs = value.logs;
  if (Array.isArray(value.rubric)) {
    detail.rubric = value.rubric.filter(
      (p): p is RubricPointVerdict => !!p && typeof p === 'object' && typeof (p as RubricPointVerdict).label === 'string',
    );
  }
  if (Array.isArray(value.bonus)) detail.bonus = value.bonus.map(String);
  if (Array.isArray(value.gaps)) detail.gaps = value.gaps.map(String);
  if (typeof value.provider === 'string') detail.provider = value.provider as LlmProviderKind;
  if (typeof value.submission === 'string') detail.submission = value.submission;
  if (typeof value.submissionChars === 'number') detail.submissionChars = value.submissionChars;
  return detail;
}
