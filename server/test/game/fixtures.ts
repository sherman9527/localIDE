import { Question, type CategoryId, type JudgeKind, type Language, type Question as BankQuestion } from '@arena/shared';
import type { AttemptRow, BankPort, Clock, ProgressStore } from '../../src/ports.js';

/**
 * 测试题库：覆盖 7 个类别的"可判分题（主栈候选）+ 主观题（副栈候选）"两种形态。
 * 全部用 Question.parse 走真实 zod 校验，避免 fixture 与线上 schema 漂移。
 */
const REF_MARKER = 'REFERENCE-SOLUTION-MUST-NEVER-LEAK';
const ANSWER_MARKER = 'REFERENCE-ANSWER-MUST-NEVER-LEAK';

const CATEGORY_LANG: Partial<Record<JudgeKind, Language>> = {
  'java-junit': 'java',
  'react-vitest': 'typescript',
  mysql: 'sql',
  redis: 'sql',
  pyspark: 'python',
  'spark-scala': 'java',
  'llm-rubric': 'markdown',
};

export interface MakeQuestionInput {
  id: string;
  category: CategoryId;
  judgeKind: JudgeKind;
  difficulty?: 'senior' | 'principal';
  title?: string;
  statement?: string;
  tags?: string[];
  company?: string;
  estimatedMinutes?: number;
}

export function makeQuestion(input: MakeQuestionInput): BankQuestion {
  const { id, category, judgeKind } = input;
  const subjective = judgeKind === 'llm-rubric';
  const source: Record<string, unknown> = {
    origin: subjective ? 'manual' : 'jd',
    jds: subjective ? [] : [{ url: 'https://example.com/jd', title: 'senior data engineer', crawledAt: '2026-09-01' }],
    ingestedAt: `2026-09-01T00:00:00.000Z`,
    era: '2026',
  };
  if (input.company) source.company = input.company;
  const draft: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    category,
    difficulty: input.difficulty ?? 'senior',
    title: input.title ?? `${id} 题目：设计并实现高并发下的幂等处理链路`,
    statement:
      input.statement ??
      `${id}：请用该栈实现一个可判分的方案，说明背压、退避与去重策略，并让全部测试用例通过（senior 深度）。`,
    judgeKind,
    language: CATEGORY_LANG[judgeKind],
    tags: input.tags ?? ['idempotency', 'retry'],
    estimatedMinutes: input.estimatedMinutes ?? 20,
    source,
  };
  if (subjective) {
    draft.rubric = {
      maxScore: 10,
      points: [
        { label: '指出背压与退避的取舍', weight: 6, criteria: '提到有界队列/指数退避+抖动' },
        { label: '给出可观测的失败处理', weight: 4, criteria: '提到指标与重放策略' },
      ],
    };
    draft.answer = `${ANSWER_MARKER}：本题要点是背压 + 指数退避 + 幂等键去重。`;
  } else {
    draft.cases = [
      { name: '空输入返回空结果', input: [], expected: [], visible: true },
      { name: '重复事件只处理一次', input: ['a', 'a'], expected: ['a'], visible: true },
      { name: '乱序事件按键聚合', input: ['b', 'a', 'b'], expected: ['b', 'a'], visible: true },
    ];
    draft.runner = {
      entry: 'function',
      timeoutMs: 20_000,
      referenceSolution: `${REF_MARKER} class Solution { public List<String> run(List<String> in) { return in; } }`,
    };
    // 真题库里 67 道代码题**全部**带 answer，假题库也得带 ——
    // 否则 expectNoAnswerLeak 对代码题答案是空跑（marker 根本不在样本里）。
    draft.answer = `${ANSWER_MARKER}：代码题要点（单遍扫描 + 幂等键去重）。`;
  }
  return Question.parse(draft) as BankQuestion;
}

export const REFERENCE_SOLUTION_MARKER = REF_MARKER;
export const REFERENCE_ANSWER_MARKER = ANSWER_MARKER;

/** 一份"够大且每类都有题"的题库；daily 的确定性/跨天变化测试靠它。 */
export function seedQuestions(): BankQuestion[] {
  const out: BankQuestion[] = [];
  const push = (q: BankQuestion) => out.push(q);
  for (let i = 1; i <= 6; i++) push(makeQuestion({ id: `alg-java-${String(i).padStart(4, '0')}`, category: 'algorithms', judgeKind: 'java-junit' }));
  for (let i = 1; i <= 4; i++) push(makeQuestion({ id: `sql-mysql-${String(i).padStart(4, '0')}`, category: 'sql', judgeKind: 'mysql' }));
  for (let i = 1; i <= 2; i++) push(makeQuestion({ id: `sql-redis-${String(i).padStart(4, '0')}`, category: 'sql', judgeKind: 'redis' }));
  for (let i = 1; i <= 2; i++) push(makeQuestion({ id: `sql-rub-${String(i).padStart(4, '0')}`, category: 'sql', judgeKind: 'llm-rubric' }));
  for (let i = 1; i <= 3; i++) push(makeQuestion({ id: `bd-py-${String(i).padStart(4, '0')}`, category: 'big-data', judgeKind: 'pyspark' }));
  for (let i = 1; i <= 2; i++) push(makeQuestion({ id: `bd-scala-${String(i).padStart(4, '0')}`, category: 'big-data', judgeKind: 'spark-scala' }));
  for (let i = 1; i <= 2; i++) push(makeQuestion({ id: `bd-rub-${String(i).padStart(4, '0')}`, category: 'big-data', judgeKind: 'llm-rubric' }));
  for (let i = 1; i <= 3; i++) push(makeQuestion({ id: `fe-ts-${String(i).padStart(4, '0')}`, category: 'frontend', judgeKind: 'react-vitest' }));
  push(makeQuestion({ id: `fe-rub-0001`, category: 'frontend', judgeKind: 'llm-rubric' }));
  for (let i = 1; i <= 3; i++) push(makeQuestion({ id: `sd-rub-${String(i).padStart(4, '0')}`, category: 'system-design', judgeKind: 'llm-rubric' }));
  for (let i = 1; i <= 2; i++) push(makeQuestion({ id: `ag-rub-${String(i).padStart(4, '0')}`, category: 'agent-design', judgeKind: 'llm-rubric' }));
  push(makeQuestion({ id: `hi-rub-0001`, category: 'hot-interviews', judgeKind: 'llm-rubric', company: 'ByteDance' }));
  // N-17：标签下拉按频次收敛，fixture 里得有"出现次数不到阈值"的标签才测得到那条判据
  out[0]!.tags = [...out[0]!.tags, 'rare-pair'];
  out[1]!.tags = [...out[1]!.tags, 'rare-pair'];
  out[2]!.tags = [...out[2]!.tags, 'rare-single'];
  return out;
}

/** 内存 BankPort：visible 过滤软删除，与 loader.visibleQuestions 语义一致。 */
export class FakeBank implements BankPort {
  hidden = new Set<string>();
  ingested: unknown[] = [];
  constructor(public questions: BankQuestion[] = seedQuestions()) {}
  async all(): Promise<BankQuestion[]> {
    return [...this.questions];
  }
  async visible(): Promise<BankQuestion[]> {
    return this.questions.filter((q) => !this.hidden.has(q.id));
  }
  async byId(id: string): Promise<BankQuestion | undefined> {
    return this.questions.find((q) => q.id === id);
  }
  async hide(id: string): Promise<void> {
    if (!this.questions.some((q) => q.id === id)) throw new Error(`unknown question ${id}`);
    this.hidden.add(id);
  }
  async unhide(id: string): Promise<void> {
    this.hidden.delete(id);
  }
  async hiddenIds(): Promise<Set<string>> {
    return new Set(this.hidden);
  }
  async ingest(drafts: readonly unknown[]): Promise<unknown> {
    this.ingested.push(...drafts);
    return { added: [] };
  }
}

/**
 * 只记录 attempt 的最小 ProgressStore：**没有** settings 能力
 * （`asSettingsStore()` 会判成 null），用来验"记不住当日套餐时游戏层照样跑"。
 */
export class BareFakeStore implements ProgressStore {
  private rows: AttemptRow[] = [];
  private seq = 0;

  async record(attempt: Omit<AttemptRow, 'id'>): Promise<AttemptRow> {
    const row: AttemptRow = { ...attempt, id: ++this.seq };
    this.rows.push(row);
    return row;
  }
  async attemptsByDay(day: string): Promise<AttemptRow[]> {
    return this.rows.filter((r) => r.day === day);
  }
  async allAttempts(): Promise<AttemptRow[]> {
    return [...this.rows];
  }
  async historyFor(questionId: string, limit: number): Promise<AttemptRow[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    return this.rows.filter((r) => r.questionId === questionId).slice(-n).reverse();
  }
  async bestByQuestion(): Promise<Map<string, AttemptRow>> {
    const best = new Map<string, AttemptRow>();
    for (const row of this.rows) {
      // 与真 store 一致：同分取更早（rows 按 id 升序入栈），否则 XP 会被后一次作答偷走
      const prev = best.get(row.questionId);
      if (!prev || row.xp > prev.xp) best.set(row.questionId, row);
    }
    return best;
  }
  async bestXpFor(questionId: string): Promise<number> {
    return this.rows.filter((r) => r.questionId === questionId).reduce((m, r) => Math.max(m, r.xp), 0);
  }
  async close(): Promise<void> {
    this.rows = [];
  }
}

/** 内存 ProgressStore（带 settings）；要"没有 settings 能力"就用 BareFakeStore。 */
export class FakeStore extends BareFakeStore {
  private kv = new Map<string, string>();

  async getSetting(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async setSetting(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
}

export function fixedClock(iso: string): Clock {
  const now = new Date(`${iso}T12:00:00`);
  return { now: () => now };
}

export function shiftDay(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export const attemptOf = (over: Partial<AttemptRow> & { questionId: string }): AttemptRow => ({
  id: over.id ?? 0,
  questionId: over.questionId,
  category: over.category ?? 'algorithms',
  kind: over.kind ?? 'judge',
  status: over.status ?? 'pass',
  score: over.score ?? null,
  maxScore: over.maxScore ?? null,
  xp: over.xp ?? 15,
  passed: over.passed ?? 1,
  failed: over.failed ?? 0,
  durationMs: over.durationMs ?? 1200,
  createdAt: over.createdAt ?? `${over.day ?? '2026-09-19'}T09:00:00.000Z`,
  day: over.day ?? '2026-09-19',
  ...(over.detail === undefined ? {} : { detail: over.detail }),
});

/** 给 ProgressStore.record 用：去掉自增 id。 */
export const newAttempt = (over: Parameters<typeof attemptOf>[0]): Omit<AttemptRow, 'id'> => {
  const { id: _id, ...rest } = attemptOf(over);
  void _id;
  return rest;
};
