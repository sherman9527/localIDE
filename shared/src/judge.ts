import type { JudgeKind, Language } from './taxonomy.js';
import type { Question } from './question.js';

export type JudgeStatus = 'pass' | 'fail' | 'error' | 'needs_human';

export type JudgeErrorKind = 'compile' | 'timeout' | 'runtime' | 'forbidden' | 'sandbox' | 'unavailable';

export interface JudgeCaseResult {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

/** 判题协议：runner 只报事实，XP 与进度由 game 层算。 */
export interface JudgeResult {
  status: JudgeStatus;
  passed: number;
  failed: number;
  total: number;
  /** 只放失败项，前端直接展开（需求 场景 4：pass 多少、fail 多少、失败的是哪个） */
  failedCases: JudgeCaseResult[];
  /** 通过项的名字，供 UI 打勾；不重复放 expected/actual */
  passedCases: string[];
  errorKind?: JudgeErrorKind;
  /** 截断后的原始日志（编译诊断 / traceback / mysql stderr） */
  logs?: string;
  durationMs: number;
  timedOut?: boolean;
  /** 判题链路的追踪号；出问题时 `npm run logs -- --trace <id>` 能捞出全过程 */
  traceId?: string;
}

export interface JudgeRequest {
  questionId: string;
  submission: string;
  /** react 题可提交多文件 */
  extraFiles?: { path: string; content: string }[];
  language?: Language;
  /** 贯穿 API → 判题 → 日志的追踪号；不传则由服务端生成 */
  traceId?: string;
  /**
   * 用例来自哪里。'request' 表示是答题者在自测面板里贴进来的 ——
   * 有状态的判题器（mysql/redis）必须据此把它当"外部输入"再过一遍白名单，
   * 否则就等于给请求内容开了一条绕过守卫的通道。
   */
  caseSource?: 'bank' | 'request';
}

/** 判题是长耗时操作（Java 3-8s、Spark 首次 10-20s），因此走 SSE 而不是单次 JSON。 */
export type JudgeEvent =
  | { type: 'queued'; questionId: string }
  | { type: 'progress'; phase: 'compile' | 'run' | 'collect'; elapsedMs: number; timeoutMs: number }
  | { type: 'log'; line: string }
  | { type: 'result'; result: JudgeResult };

export interface RubricPointVerdict {
  label: string;
  hit: boolean;
  /** 命中给了几分 */
  earned: number;
  /** 未命中时"下一句该补什么" */
  nextStep?: string;
}

/**
 * `bridge` = 宿主机 CLI 桥（容器里跑时，qodercli.exe 这类宿主二进制进不了 linux 容器，
 * 由 scripts/llm-bridge.mjs 在本机代跑）；`manual` = 前两档都不可用时的人肉自检表。
 */
export type LlmProviderKind = 'qodercli' | 'copilot' | 'bridge' | 'manual';

/** 主观题评分结果（需求 场景 8：满分 10、得分、加分点、不足点）。 */
export interface RubricVerdict {
  score: number;
  maxScore: number;
  bonus: string[];
  gaps: string[];
  rubricBreakdown: RubricPointVerdict[];
  provider: LlmProviderKind;
  model?: string;
  durationMs: number;
  /** provider 原始输出，便于排查解析问题 */
  raw: string;
}

export interface Runner {
  kind: JudgeKind;
  /** runner 自检：容器里该栈是否可用（/api/health 用它填 stacks） */
  probe(): Promise<boolean>;
  run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult>;
}

/** 统一日志截断，避免把几 MB 编译输出灌进响应。 */
export function truncateLog(text: string, maxLines = 20, maxChars = 4000): string {
  const lines = text.split('\n');
  const clipped = lines.length > maxLines ? [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`] : lines;
  const joined = clipped.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}...[truncated]` : joined;
}
