import type { CategoryId, JudgeErrorKind, JudgeKind, Language, PublicQuestion, StackHealth } from '@arena/shared';
import { CATEGORY_META } from '@arena/shared';

export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export const secsShort = (ms: number): string => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;

/** 用例的 input/expected 是任意 JSON，界面上统一用紧凑 JSON 展示。 */
export function formatValue(value: unknown): string {
  if (value === undefined) return '（无）';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const PHASE_LABEL: Record<'compile' | 'run' | 'collect', string> = {
  compile: '编译中',
  run: '运行中',
  collect: '收集中结果',
};

export const ERROR_KIND_LABEL: Record<JudgeErrorKind, string> = {
  compile: '编译没通过',
  timeout: '判题超时',
  runtime: '运行时崩了',
  forbidden: '用了判题器禁止的东西',
  sandbox: '沙箱没起来',
  unavailable: '该栈当前不可用',
};

export const JUDGE_KIND_LABEL: Record<JudgeKind, string> = {
  'java-junit': 'Java + JUnit',
  'react-vitest': 'React + Vitest',
  mysql: 'MySQL',
  redis: 'Redis',
  pyspark: 'PySpark',
  'spark-scala': 'Spark Scala',
  'llm-rubric': '主观题评分',
};

export const PROVIDER_LABEL: Record<string, string> = {
  qodercli: '本机 qodercli',
  copilot: '本机 copilot',
  manual: '人工自检清单',
};

export const DIFFICULTY_LABEL: Record<'senior' | 'principal', string> = {
  senior: 'senior',
  principal: 'principal',
};

/** /api/health 的 stacks 键与类别的对应关系（container-runtime spec：不可判分要显式说明）。 */
const STACK_PROBES: Partial<Record<CategoryId, string[]>> = {
  frontend: ['react'],
  algorithms: ['java'],
  sql: ['mysql', 'redis'],
  'big-data': ['pyspark', 'spark'],
};

export type StackState = 'ok' | 'down' | 'unknown';

export function stackState(category: CategoryId, health: StackHealth | null | undefined): StackState {
  const probes = STACK_PROBES[category];
  if (!health || !probes) return 'unknown';
  const known = probes.map((p) => health.stacks[p]).filter((v): v is boolean => typeof v === 'boolean');
  if (known.length === 0) return 'unknown';
  return known.some((v) => v) ? 'ok' : 'down';
}

export function editorLanguageOf(question: PublicQuestion): Language {
  return question.language ?? CATEGORY_META[question.category].editorLanguage;
}

export function isSubjective(question: { judgeKind: JudgeKind }): boolean {
  return question.judgeKind === 'llm-rubric';
}

export function accentOf(category: CategoryId): string {
  return CATEGORY_META[category].accent;
}

/** 还差几题才能续签：按"每题最多 pass 拿 15 XP"保守估算。 */
export function questionsToStreak(xpToday: number, threshold: number, perPass: number): number {
  const left = threshold - xpToday;
  if (left <= 0) return 0;
  return Math.max(1, Math.ceil(left / perPass));
}

export function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${Number(m)} 月 ${Number(d)} 日`;
}
