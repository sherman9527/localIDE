import type { LlmProviderKind, Question, RubricPointVerdict, RubricVerdict } from '@arena/shared';
import type { LlmProvider } from './provider.js';
import type { GradePort } from '../ports.js';
import { truncateLog } from '@arena/shared';
import { errorFields, logError, logInfo, logWarn } from '../log.js';
import { resolveProviders } from './provider.js';
import { manualVerdict } from './providers/manual.js';

/** shared 只导出了 Rubric 的 zod schema（值），没导出推导类型，所以从 Question 反推。 */
type RubricPointItem = NonNullable<Question['rubric']>['points'][number];

/**
 * 主观题评分（需求场景 8：满分 10、得分、加分点、不足点）。
 * 唯一职责：把"题面 + rubric + 候选人答案"喂给本机 CLI，再把输出**解析成可追溯的结构**。
 * 任何 provider 失败/输出不可解析 → 降级下一档；全部失败 → manual 自检表，**永不抛错**（接口层不报 5xx）。
 */

export const DEFAULT_MAX_SCORE = 10;
/** raw 最多留 4000 字符（shared 的 truncateLog 负责截断标记）。 */
export const RAW_MAX_CHARS = 4_000;

interface ModelVerdict {
  score: number;
  bonus: string[];
  gaps: string[];
  rubricBreakdown: RubricPointVerdict[];
}

function rubricOf(question: Question) {
  return question.rubric ?? null;
}

/**
 * prompt 只放三样东西：题面 statement、rubric 考点（label + weight + criteria）、候选人答案。
 * 刻意不放：题目 title/id/tags/source、参考解 `question.answer`、任何本机路径
 * （规格「提示词与题目内容边界」+ rule.md C7 的泄漏面最小化）。
 */
export function buildPrompt(question: Question, answer: string): string {
  const rubric = rubricOf(question);
  const maxScore = rubric?.maxScore ?? DEFAULT_MAX_SCORE;
  const points = rubric?.points ?? [];
  const lines: string[] = [
    '你是一名严格的资深技术面试官，正在为 Apple / Airbnb 的 senior 面试给一道主观题（系统设计 / agent 设计 / 高频面试）打分。',
    '你的任务是纯评分：不要调用任何工具，不要读写文件，不要追问，不要输出评分之外的文字。',
    '',
    '## 题目',
    question.statement.trim(),
    '',
    `## 评分细则（满分 ${maxScore} 分，权重合计即满分）`,
    ...points.map((p, i) => `${i + 1}. ${p.label} —— 权重 ${p.weight} 分${p.criteria ? `：${p.criteria}` : ''}`),
    ...(rubric?.notes ? ['', '## 出题人补充判据', rubric.notes] : []),
    '',
    '## 候选人答案',
    answer.trim() || '（空：候选人未作答）',
    '',
    '## 输出格式（严格遵守）',
    '只输出一个 JSON 对象，不要 markdown 代码块，前后不要解释文字。形状：',
    '{"score":8,"bonus":["..."],"gaps":["..."],"rubricBreakdown":[{"label":"容量估算","hit":true,"earned":3,"nextStep":"补一句 QPS 到存储层的换算"}]}',
    '硬性约束：',
    `- score 是 0..${maxScore} 的整数；满分由题目固定为 ${maxScore}，不要输出 maxScore 字段。`,
    '- rubricBreakdown 必须逐条覆盖上面每一个考点，label 与考点名称逐字一致（不新增、不改名、不合并）。',
    '- 整数打分：hit=true 时 earned 必须等于该考点权重，hit=false 时 earned 必须为 0，禁止 2.5 这类半分。',
    '- 字符串值里不要出现英文双引号 "，需要引用原文改用「」（否则整份输出会被判为不可解析）。',
    '- 有未命中项时，rubricBreakdown[].nextStep 必须写"下一句该补什么"（一句话、可执行）。',
    `- bonus / gaps 各 1-4 条，每条一句话；score 一般等于各条 earned 之和，若整体判断不同就以 score 为准。`,
    '- 答得空泛就给低分，不要用"清晰/完整"这类空话换分。',
  ];
  return lines.join('\n');
}

/** 剥 ```json fence（含未闭合的），返回候选文本串列表。 */
function fenceCandidates(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? '');
  const openFence = /```(?:json|JSON)?\s*([\s\S]*)$/g.exec(text);
  if (openFence?.[1]) out.push(openFence[1]);
  out.push(text);
  return out;
}

/** 从 start 处的 `{` 起取一段**平衡**的花括号文本（字符串内的括号与转义引号不计数）。 */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAttempt(slice: string): Record<string, unknown> | null {
  const repaired = repairJsonish(slice);
  return tryParseObject(slice) ?? tryParseObject(repaired) ?? tryParseObject(escapeStrayQuotes(repaired));
}

/** 一个对象"像在评本题"的程度：命中的考点数 → 有没有 score 键。 */
function relevanceOf(obj: Record<string, unknown>, labels: readonly string[]): number {
  const breakdown = Array.isArray(obj.rubricBreakdown) ? obj.rubricBreakdown : Array.isArray(obj.breakdown) ? obj.breakdown : [];
  const given = new Set(
    breakdown
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).label : undefined))
      .filter((l): l is string => typeof l === 'string'),
  );
  const hits = labels.filter((label) => given.has(label)).length;
  return hits * 10 + (obj.score === undefined ? 0 : 1);
}

/**
 * 取**最像在给本题打分**的那个对象，而不是"第一个"。
 * 模型经常先复述一遍 prompt 里的示例 JSON（那是个完全合法的对象，label 还可能撞名），
 * 只认第一个就会产出一份"没人评过的 8/10"；第一个残缺时也只认第一个则会白等 40-70s。
 */
export function extractJsonObject(text: string, rubricLabels: readonly string[] = []): Record<string, unknown> | null {
  let best: { obj: Record<string, unknown>; rank: number; at: number } | null = null;
  let offset = 0;
  for (const candidate of fenceCandidates(text)) {
    for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
      const slice = balancedSlice(candidate, start);
      if (!slice) continue;
      const parsed = parseAttempt(slice);
      if (parsed) {
        const at = offset + start;
        const rank = relevanceOf(parsed, rubricLabels);
        // 同分取更靠后的：示例通常在前面，正式结论在后面
        if (!best || rank > best.rank || (rank === best.rank && at > best.at)) best = { obj: parsed, rank, at };
        start += slice.length - 1;
      }
    }
    offset += candidate.length + 1;
  }
  return best?.obj ?? null;
}

function tryParseObject(slice: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(slice);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 模型偶尔吐尾逗号 / 单引号 key，这里做一次最小修复（修不好就降级，不做语义猜测）。 */
function repairJsonish(slice: string): string {
  return slice
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']*?)'\s*:/g, '$1"$2":');
}

/**
 * 模型爱把候选人答案里的英文引号原样抄进字符串（`"用"展示价≠成交价"当红线"`），
 * 这一条就足以让整份评分 JSON 作废 —— 而一次评分要等 30-70s，丢掉太贵。
 * 判据：字符串内遇到 `"` 时往后看一个非空白字符，只有 `, } ] :` 或结尾才当它是真正的收尾，
 * 其余一律转义。已转义的 `\"` 原样保留。
 */
function escapeStrayQuotes(slice: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }
    let j = i + 1;
    while (j < slice.length && /\s/.test(slice[j]!)) j++;
    const next = slice[j];
    if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
      inString = false;
      out += ch;
    } else {
      out += '\\"';
    }
  }
  return out;
}

function toNumberOr(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

const normalizeLabel = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

function matchPoint(label: string, points: readonly RubricPointItem[]): RubricPointItem | undefined {
  const trimmed = label.trim();
  return points.find((p) => p.label === trimmed) ?? points.find((p) => normalizeLabel(p.label) === normalizeLabel(trimmed));
}

/**
 * 解析模型输出 → 归一化评分。返回 null 表示"这次调用算失败"，由 grade() 降级。
 * 归一化规则（规格「分数越界被 clamp」+「逐项 rubric 反馈」）：
 * - maxScore 只认题目；模型给的一律丢弃；
 * - score clamp 到 0..maxScore 并取整；
 * - label 必须匹配题面考点，不匹配的丢弃；
 * - earned 只能是该考点权重或 0（整数打分）；
 * - breakdown 之和与 score 差异 >1 时**以 score 为准但保留 breakdown**（前端两栏都显示）；
 * - 题目里没被模型提到的考点补一条未命中，保证反馈密度。
 */
export function parseModelOutput(raw: string, question: Question): ModelVerdict | null {
  const rubric = rubricOf(question);
  if (!rubric) return null;
  const obj = extractJsonObject(raw, rubric.points.map((p) => p.label));
  if (!obj) return null;

  const maxScore = rubric.maxScore;
  const scoreRaw = toNumberOr(obj.score, null);
  if (scoreRaw === null) return null;
  const score = Math.min(maxScore, Math.max(0, Math.round(scoreRaw)));

  const points = rubric.points;
  const breakdownRaw = Array.isArray(obj.rubricBreakdown) ? obj.rubricBreakdown : Array.isArray(obj.breakdown) ? obj.breakdown : [];
  const byLabel = new Map<string, RubricPointVerdict>();
  for (const item of breakdownRaw as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? rec.label : '';
    const point = label ? matchPoint(label, points) : undefined;
    if (!point) continue; // 模型自己造的考点（或拼错的名字）直接丢弃
    if (byLabel.has(point.label)) continue; // 重复条目以先出现的为准
    const earnedRaw = toNumberOr(rec.earned, 0) ?? 0;
    const hit = rec.hit === true || (typeof rec.hit !== 'boolean' && earnedRaw >= point.weight);
    byLabel.set(point.label, {
      label: point.label,
      hit,
      earned: hit ? point.weight : 0,
      ...(typeof rec.nextStep === 'string' && rec.nextStep.trim() ? { nextStep: rec.nextStep.trim() } : {}),
    });
  }
  const rubricBreakdown: RubricPointVerdict[] = [];
  for (const p of points) {
    const found = byLabel.get(p.label);
    rubricBreakdown.push(
      found ?? {
        label: p.label,
        hit: false,
        earned: 0,
        nextStep: p.criteria ? `模型没提到这条，自查是否答到：${p.criteria}` : `模型没提到「${p.label}」这条（值 ${p.weight} 分）`,
      },
    );
  }

  const gaps = toStringList(obj.gaps);
  const missing = rubricBreakdown.filter((b) => !b.hit).map((b) => b.label);
  return {
    score,
    bonus: toStringList(obj.bonus),
    gaps: gaps.length ? gaps : missing.map((l) => `未命中考点：${l}`),
    rubricBreakdown,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 评分主流程。`providers` 一般由测试注入假实现；生产留空走 `config.llm.providers` 链。
 */
export async function grade(question: Question, answer: string, providers?: LlmProvider[], traceId?: string): Promise<RubricVerdict> {
  const startedAt = Date.now();
  const reasons: string[] = [];
  /** 降级不静默：每一档为什么没用都要落一条 warn，排查时不必重跑。 */
  const giveUpOn = (kind: LlmProviderKind, reason: string) => {
    reasons.push(`${kind}: ${reason}`);
    logWarn('grade', 'fallback', { traceId, questionId: question.id, provider: kind, msg: reason });
  };
  const finish = (kind: LlmProviderKind, model: string | undefined, v: ModelVerdict, raw: string): RubricVerdict => {
    const verdict: RubricVerdict = {
      score: v.score,
      maxScore: rubricOf(question)?.maxScore ?? DEFAULT_MAX_SCORE,
      bonus: v.bonus,
      gaps: v.gaps,
      rubricBreakdown: v.rubricBreakdown,
      provider: kind,
      ...(model ? { model } : {}),
      durationMs: Date.now() - startedAt,
      raw: truncateLog(raw, 200, RAW_MAX_CHARS),
    };
    logInfo('grade', 'done', {
      traceId,
      questionId: question.id,
      provider: kind,
      score: verdict.score,
      maxScore: verdict.maxScore,
      ms: verdict.durationMs,
    });
    return verdict;
  };

  if (!rubricOf(question)) {
    giveUpOn('manual', '题目缺少 rubric（question.rubric 为空），无法按考点评分');
    const m = manualVerdict(question, reasons.join('；'));
    return { ...m, score: 0, durationMs: Date.now() - startedAt };
  }

  const chain = providers?.length ? providers : resolveProviders();
  const prompt = buildPrompt(question, answer);

  try {
    for (const provider of chain) {
      if (provider.kind === 'manual') continue; // 终态兜底，循环外统一出自检表
      try {
        if (!(await provider.available())) {
          giveUpOn(provider.kind, '本机不可用（未安装 / 未登录 / 参数失效），跳过');
          continue;
        }
        const raw = await provider.complete(prompt);
        const parsed = parseModelOutput(raw, question);
        if (!parsed) {
          giveUpOn(provider.kind, `输出无法解析成规定 JSON（片段：${raw.slice(0, 160).replace(/\s+/g, ' ')}）`);
          continue;
        }
        return finish(provider.kind, provider.model, parsed, raw);
      } catch (err) {
        giveUpOn(provider.kind, errMsg(err));
      }
    }
  } catch (err) {
    reasons.push(`评分流程内部异常：${errMsg(err)}`);
    logError('grade', 'crashed', { traceId, questionId: question.id, ...errorFields(err) });
  }

  const manual = manualVerdict(question, `全部 provider 失败 → 转人工自检。${reasons.join('；')}`);
  return { ...manual, score: 0, durationMs: Date.now() - startedAt };
}

/** 评分链是否真能拿到模型输出：短路探测，第一档可用就返回；manual 不算。 */
async function anyProviderAvailable(providers?: LlmProvider[]): Promise<boolean> {
  const chain = providers?.length ? providers : resolveProviders();
  for (const provider of chain) {
    if (provider.kind === 'manual') continue;
    try {
      if (await provider.available()) return true;
    } catch {
      // 探测本身失败按"这一档不可用"处理，继续下一档
    }
  }
  return false;
}

/** 给 composition root 注入用：把"可选的 provider 链"绑成端口的两个方法。 */
export function createGrader(providers?: LlmProvider[]): GradePort {
  return {
    grade: (question: Question, answer: string, traceId?: string) => grade(question, answer, providers, traceId),
    available: () => anyProviderAvailable(providers),
  };
}
