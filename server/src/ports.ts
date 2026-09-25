import type { AttemptDetail, JudgeEvent, JudgeRequest, JudgeResult, RubricVerdict } from '@arena/shared';
import type { Question, QuestionDraft, JudgeKind } from '@arena/shared';

/**
 * 各子系统之间只通过这里的端口相遇（rule.md C4：题库与游戏解耦）。
 * 具体实现由 composition root（src/index.ts）注入，测试直接塞假实现。
 */
export interface JudgePort {
  run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult>;
  probe(kind: JudgeKind): Promise<boolean>;
}

export interface GradePort {
  /** traceId 由 HTTP 层传进来，让"这一次评分"在日志里可追 */
  grade(question: Question, answer: string, traceId?: string): Promise<RubricVerdict>;
  /** 评分链此刻到底能不能拿到模型输出（manual 兜底不算可用——它只是自检表） */
  available(): Promise<boolean>;
}

export interface BankPort {
  all(): Promise<Question[]>;
  visible(): Promise<Question[]>;
  byId(id: string): Promise<Question | undefined>;
  hide(id: string, reason?: string): Promise<void>;
  unhide(id: string): Promise<void>;
  hiddenIds(): Promise<Set<string>>;
  ingest(drafts: readonly QuestionDraft[]): Promise<unknown>;
}

export interface AttemptRow {
  id: number;
  questionId: string;
  category: string;
  kind: 'judge' | 'grade';
  status: string;
  score: number | null;
  maxScore: number | null;
  xp: number;
  passed: number;
  failed: number;
  durationMs: number;
  createdAt: string;
  day: string;
  /**
   * 逐用例结果 / 评分点命中 + 当时提交的正文（N-05 复盘用）。
   * null = 这一条没有留档：v1 时代的老数据，或库里是坏 JSON。
   */
  detail?: AttemptDetail | null;
}

export interface ProgressStore {
  record(attempt: Omit<AttemptRow, 'id'>): Promise<AttemptRow>;
  attemptsByDay(day: string): Promise<AttemptRow[]>;
  bestByQuestion(): Promise<Map<string, AttemptRow>>;
  allAttempts(): Promise<AttemptRow[]>;
  /** 某一题的提交历史，新的在前（N-05 复盘面板）。 */
  historyFor(questionId: string, limit: number): Promise<AttemptRow[]>;
  bestXpFor(questionId: string): Promise<number>;
  /**
   * 当日套餐缓存等键值设置（缺了它就没法记住"今天选了哪几题"）。
   * 可选能力：调用方必须先过 `asSettingsStore()`，不要直接 store.getSetting。
   */
  getSetting?(key: string): Promise<string | null>;
  setSetting?(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/** 让 game 层可注入时钟，streak 测试不必等真过一天。 */
export interface Clock {
  now(): Date;
}
