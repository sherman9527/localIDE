/**
 * 网页 IDE 的传输层契约（WI-64）。
 *
 * 独立于题库/判题的类型：IDE 只提交"代码 + 输入"，拿回"输出 + 退出码"，
 * 不产生 attempt、不计 XP、不出现在任何题目相关的响应里。
 * 解耦由 `server/test/ide/boundary.test.ts` 把住，不是靠约定。
 */
import type { Language } from './taxonomy.js';

export type IdeRunStatus = 'ok' | 'compile_error' | 'runtime_error' | 'timeout' | 'rejected';
/** 失败发生在哪一段：提交校验 / 编译 / 运行。UI 靠它决定把错误标在哪个面板上。 */
export type IdeRunStage = 'submit' | 'compile' | 'run';

/**
 * 一种语言在 IDE 里"怎么被跑起来"：
 *  - command：写文件 →（可选编译）→ 起进程，看 stdout/退出码；
 *  - sql：在一次性库里执行语句，最后一个结果集当表格回；
 *  - redis：在专用 db index 上按行发命令，逐条回回复；
 *  - spark-python：喂给判题那个常驻 SparkSession（排队，判题优先）；
 *  - spark-scala：每次真 scalac 编译再启一个 JVM（无常驻可言）。
 */
export type IdeExecution = 'command' | 'sql' | 'redis' | 'spark-python' | 'spark-scala';

export interface IdeTable {
  columns: string[];
  rows: string[][];
  /** 被 IDE 的展示上限截断过（不是"结果只有这么多行"） */
  truncated: boolean;
  rowLimit: number;
}

export interface IdeReply {
  command: string;
  reply: string;
}

export interface IdeLanguageInfo {
  id: string;
  label: string;
  fileName: string;
  sample: string;
  hint: string;
  /** 编辑器高亮用哪一种（前端不再自己按 id 猜 —— 那等于第二份真相） */
  editorLanguage: Language;
  execution: IdeExecution;
  /** 这门语言的运行预算（Spark 要 120s，命令型语言 10s）—— UI 用它告诉用户"最多等多久" */
  timeoutMs: number;
  /** 这门语言能不能开 REPL 会话（判据是镜像里有交互式运行时，不是"应该有"） */
  replKind?: boolean;
  /**
   * 这门语言的**行断点**由谁实现（`python` = 常驻子进程里的 `sys.settrace`）。
   * 与 `replKind` 分开是有意的：能逐句求值 ≠ 能停在某一行看变量。
   * 只有机制当场实测过的语言才给值，否则界面上就不该出现可点的行号槽。
   */
  debugKind?: IdeDebugKind;
  /** 有值才显示"预置语句"框；写清楚它每次运行都会重来一遍 */
  setupLabel?: string;
  /** 这台机器上现在到底能不能跑（现探，不是"镜像里应该装了"） */
  available: boolean;
}

export interface IdeLimits {
  maxCodeChars: number;
  maxStdinChars: number;
  maxSetupChars: number;
  timeoutMs: number;
  /** 任何语言的硬上限；Spark 这类慢栈靠 per-language timeoutMs 往上要，但不许超过这一档 */
  maxTimeoutMs: number;
  stdoutCapChars: number;
  /** 表格最多给多少行（SQL 一次 SELECT 可能几十万行，全塞进响应只会让页面卡住） */
  tableRowLimit: number;
}

export interface IdeLanguagesResponse {
  languages: IdeLanguageInfo[];
  limits: IdeLimits;
}

export interface IdeRunRequest {
  language: string;
  code: string;
  stdin?: string;
  /**
   * 预置语句（sql：CREATE/INSERT…；redis：ZADD/SET…）。
   * 每次运行都在**全新的临时库/index**上执行，所以"上一次建的表"不会留下来 ——
   * 这是刻意的：宁可让你把前置语句一起贴进来，也不让 IDE 里攒出一库没人知道来源的脏数据。
   */
  setup?: string;
}

export interface IdeRunResponse {
  status: IdeRunStatus;
  stage: IdeRunStage;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdoutCapChars: number;
  message?: string;
  /** sql / spark-python 执行形态：最后一个结果集 */
  table?: IdeTable | null;
  /** redis 执行形态：逐条命令的回复 */
  replies?: IdeReply[] | null;
}

/* ---------------------------------------------------------------------------
   REPL 会话（WI-77）。取代当初"断点 + 查看变量"那条需求：真断点要 DAP 与挂起进程，
   而"逐句求值、看变量"这件事交互式会话本来就能做到九成。
   传输是**一问一答**而不是 SSE：每句都有天然的结束点（哨兵行），
   上 SSE 只会多出一套重连/状态机而拿不到别的东西。
   --------------------------------------------------------------------------- */

export type ReplFeedStatus = 'ok' | 'error' | 'timeout' | 'gone';

export interface ReplSessionInfo {
  id: string;
  language: string;
  /** 正在等这一句的回显（空闲回收不许杀它） */
  busy: boolean;
  idleMs: number;
}

export interface ReplStartRequest {
  language: string;
}

export interface ReplStartResponse {
  /** null = 这门语言没有 REPL、或会话数已满；原因写在 message 里，界面照原样显示 */
  session: { id: string; language: string; label: string } | null;
  message?: string;
  /** 现在有几个会话活着 —— UI 用它显示 "1 / 2" */
  sessions: number;
  maxSessions: number;
}

export interface ReplFeedRequest {
  sessionId: string;
  line: string;
}

export interface ReplFeedResponse {
  status: ReplFeedStatus;
  /**
   * 这一句的全部回显：stdout 与 stderr 合在一起（python 的 traceback 在 stderr，
   * node / jshell 的报错在 stdout，而提示符又混在同一路里）。
   * gone / timeout 时这里装的就是"为什么不在了"—— 界面照原样显示，不再另设一个错误位。
   */
  output: string;
}

export interface ReplStopRequest {
  sessionId: string;
}

export interface ReplStopResponse {
  ok: boolean;
  sessions: number;
}

export interface ReplSessionsResponse {
  sessions: { id: string; language: string; busy: boolean; idleMs: number }[];
  maxSessions: number;
  idleMs: number;
}

/* ---------------------------------------------------------------------------
   行断点 / 单步调试（WI-81）。与 REPL 是两件事：REPL 问"这一句返回什么"，
   断点问"走到这一行时变量长什么样"。机制按语言各异（python 用 sys.settrace、
   java 用 jdb 挂管道、js 用 Node inspector），但**协议只有一份**：
   起一个常驻子进程 → 跑到第一个停点 → 反复"继续 / 下一步 / 步入 / 步出" → 退出或作废。

   传输仍然一问一答（同 REPL）：每个命令都有天然的结束点 = 下一个停点事件，
   没有"中途流式输出"的需求 —— 用户代码 print 出来的东西随下一个停点一起回。
   --------------------------------------------------------------------------- */

/** 已落地的调试机制。加新值必须同时有对应的 `server/src/ide/debug-<kind>.ts` 后端。 */
export type IdeDebugKind = 'python' | 'java' | 'javascript';

/**
 * 单步的四种走法（语义与主流调试器一致，测试里逐条钉住）：
 * `continue` 跑到下一个断点、`next` 同帧迈一行（**不进函数**）、
 * `stepIn` 迈一行（**有调用就进去**）、`stepOut` 跑完当前函数回到调用者。
 */
export type DebugAction = 'continue' | 'next' | 'stepIn' | 'stepOut';

/** 一次命令之后为什么停下来。`step` = 单步迈到的下一站；`breakpoint` = 命中断点。 */
export type DebugStopReason = 'breakpoint' | 'step';

/**
 * `stopped` / `exited` / `error` 是调试器给的事实；
 * `gone` / `timeout` 是会话自身没了（回收、进程被杀、单步超预算）—— 这时界面必须说清
 * "会话不在了"，而不是把按钮留着让人继续点。
 * `rejected` 是**压根没起会话**（这门语言没有调试机制、名额已满、驱动脚本不在）：
 * 与 `gone` 分开是因为前者没有"上次还在的会话"可指认，界面该说的是"为什么不开"。
 */
export type DebugStatus = 'stopped' | 'exited' | 'error' | 'gone' | 'timeout' | 'rejected';

export interface DebugVar {
  name: string;
  /** `type(v).__name__` 那一类；读不到类型时是 `unknown` */
  type: string;
  /** 值的短表示，超上限会被截断并置 `truncated` */
  repr: string;
  truncated?: boolean;
}

export interface DebugEvent {
  status: DebugStatus;
  /** 1 起的行号，只有 `stopped` 才有意义 */
  line?: number;
  reason?: DebugStopReason;
  /** 所在函数名（python 的模块顶层是 `<module>`）—— 用来解释"步入进到哪了" */
  func?: string;
  locals?: DebugVar[];
  /** 自上次命令以来用户代码打出的全部 stdout + stderr */
  output?: string;
  /** 给"停在不了 / 变量读不出来"这类诚实说明留的位置；`gone`/`timeout` 时装原因 */
  message?: string;
}

export interface DebugStartRequest {
  language: string;
  code: string;
  /** 1 起的行号；越界的行号就是"永远命中不了"，不报错也不假装停得住 */
  breakpoints: number[];
}

export interface DebugStartResponse extends DebugEvent {
  session: { id: string; language: string; label: string } | null;
  sessions: number;
  maxSessions: number;
}

export interface DebugStepRequest {
  sessionId: string;
  action: DebugAction;
}

export interface DebugStepResponse extends DebugEvent {
  action: DebugAction;
  sessions: number;
}

export interface DebugStopRequest {
  sessionId: string;
}

export interface DebugStopResponse {
  ok: boolean;
  sessions: number;
}

export interface DebugSessionInfo {
  id: string;
  language: string;
  /** 正在等这一次单步的结果（空闲回收不许杀它） */
  busy: boolean;
  idleMs: number;
}

export interface DebugSessionsResponse {
  sessions: DebugSessionInfo[];
  maxSessions: number;
  idleMs: number;
}

/**
 * 常驻会话（REPL 与调试）的三条纪律**写在这里一次**：名额、空闲回收、关进程的宽限期。
 * 两边各抄一份常量，就是"改了一边忘了另一边"的入口 —— 它们面对的是同一类资源：
 * 一个跨请求活着的子进程。
 */
export const IDE_SESSION_LIMITS = {
  replMaxSessions: 2,
  /** 一个编辑器同时只调一个程序：调试会话比 REPL 更占（跑的是整段代码） */
  debugMaxSessions: 1,
  idleMs: 5 * 60_000,
  stopGraceMs: 2_000,
  /** 单步预算：正常单步是毫秒级，给到 10s 是为了"用户代码里真有个慢循环"时能体面收场 */
  stepTimeoutMs: 10_000,
  /**
   * **第一次**停点的预算。比单步宽是因为它包含"把调试器拉起来"的全部开销：
   * java 要付 javac + jdb 起两台 JVM，js 要付起 --inspect-brk 并连上 ws。
   * 拿 10s 去卡它会稳定误报超时（实测 java 冷启动接近这个数）。
   */
  debugStartTimeoutMs: 30_000,
  /** 一个变量值的表示上限（一个 5000 字的字符串不该整坨进响应） */
  varReprChars: 240,
  /** 一次最多给多少个局部变量（超了在 message 里说明被截断） */
  maxLocals: 60,
} as const;
