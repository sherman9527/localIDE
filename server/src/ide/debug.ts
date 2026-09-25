/**
 * 网页 IDE 的**行断点**会话（WI-81 / WI-82）。
 *
 * 这一层只管"跨请求存活的子进程"的纪律：名额、空闲回收、单步超时、串行队列、
 * 一次命令对一个停点事件。**怎么跟具体的调试器说话在各家后端里**
 * （`debug-python.ts` 说 JSON，`debug-java.ts` 驱动 jdb），加一门语言不用碰这里。
 *
 * 与 REPL（`ide/repl.ts`）共用 `IDE_SESSION_LIMITS` 那三条数值 —— 面对的是同一类资源。
 * 两条只有调试才有的规矩：
 * 1. **会话是一次性的**：程序跑完 / 抛异常 / 单步超时之后进程就退了，会话跟着没。
 *    留一个"看起来还能单步"的空壳，比让用户重按一次调试糟糕得多。
 * 2. `rejected` 与 `gone` 分开：前者是压根没起会话（这门语言没有断点、名额已满），
 *    后者是起过之后没了。界面要说的话不一样。
 *
 * 威胁模型同 `ide/runner.ts`：本机单用户工具，超时与上限是为了"跑飞了别把服务挂住"，
 * 不是多租户沙箱。
 */

import { randomUUID } from 'node:crypto';
import {
  IDE_SESSION_LIMITS,
  type DebugAction,
  type DebugEvent,
  type DebugSessionInfo,
  type DebugStartResponse,
  type DebugStepResponse,
  type IdeDebugKind,
} from '@arena/shared';
import { killProcessTree } from '../judge/process.js';
import { IDE_LIMITS, findLanguage, type IdeLanguageId } from './languages.js';
import type { BackendEvent, DebugBackend, DebugHandle } from './debug-backend.js';
import { javaBackend } from './debug-java.js';
import { jsBackend } from './debug-js.js';
import { pythonBackend } from './debug-python.js';

export const DEBUG_MAX_SESSIONS = IDE_SESSION_LIMITS.debugMaxSessions;
export const DEBUG_IDLE_MS = IDE_SESSION_LIMITS.idleMs;
export const DEBUG_STEP_TIMEOUT_MS = IDE_SESSION_LIMITS.stepTimeoutMs;
export const DEBUG_START_TIMEOUT_MS = IDE_SESSION_LIMITS.debugStartTimeoutMs;

/** 加了新后端要登记在这里；没登记的语言拿不到 `debugKind`（界面上也就没有可点的行号槽）。 */
const BACKENDS: Partial<Record<IdeDebugKind, DebugBackend>> = {
  python: pythonBackend,
  java: javaBackend,
  javascript: jsBackend,
};

interface Pending {
  resolve: (event: DebugEvent) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  id: string;
  language: IdeLanguageId;
  label: string;
  handle: DebugHandle;
  pending: Pending | null;
  /**
   * 在飞 + 在排的命令数。**为什么不用 `pending !== null` 当"忙"**：命令是排进队列的，
   * `pending` 要到下一微任务才装上，而"这条不许被回收杀掉"必须在**调用那一刻**成立。
   */
  outstanding: number;
  lastUsedAt: number;
  dead: boolean;
  /** 自上次命令以来用户程序打出的字，随下一次停点一起回 */
  output: string;
  /** 串行队列：上一条没结算就不许发下一条（否则两条命令抢同一个停点） */
  queue: Promise<unknown>;
}

const sessions = new Map<string, Session>();

function takeOutput(session: Session): string {
  const out = session.output;
  session.output = '';
  return out.trim();
}

function appendOutput(session: Session, text: string): void {
  if (session.output.length >= IDE_LIMITS.stdoutCapChars) return;
  session.output += text;
}

function settle(session: Session, event: DebugEvent): void {
  const pending = session.pending;
  if (!pending) return;
  session.pending = null;
  clearTimeout(pending.timer);
  const transcript = [takeOutput(session), event.output ?? ''].filter(Boolean).join('\n');
  pending.resolve({ ...event, output: transcript || undefined });
}

/** 会话到此为止：结算还在等的那条命令、从名额里摘掉、把进程与临时文件收干净。 */
async function finish(session: Session, event: DebugEvent): Promise<void> {
  if (session.dead) return;
  session.dead = true;
  sessions.delete(session.id);
  settle(session, event);
  const child = session.handle?.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    // 先请它自己退（jdb 的 quit 会连它起的被调试 JVM 一起收），等不到再硬杀整组
    try {
      session.handle.requestExit();
    } catch {
      /* 管道已经断了，下面硬杀兜底 */
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), IDE_SESSION_LIMITS.stopGraceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) killProcessTree(child);
  }
  await session.handle?.dispose().catch(() => undefined);
}

function handleEvent(session: Session, event: BackendEvent): void {
  if (session.dead) return;
  switch (event.type) {
    case 'output':
      appendOutput(session, event.text);
      return;
    case 'stopped':
      settle(session, {
        status: 'stopped',
        line: event.line,
        reason: event.reason,
        func: event.func,
        locals: event.locals,
        message: event.message,
      });
      return;
    case 'exited':
      void finish(session, {
        status: 'exited',
        message: event.code ? `程序以退出码 ${event.code} 结束` : undefined,
      });
      return;
    case 'error':
      // 消息由后端给：它才知道是"语法错误没跑起来"还是"跑到一半抛异常"。
      // 管理器这里下结论就会说谎（SyntaxError 曾被报成"用户代码抛了异常"）。
      void finish(session, { status: 'error', output: event.text, message: event.message ?? '调试结束' });
      return;
  }
}

function waitForEvent(session: Session, timeoutMs: number): Promise<DebugEvent> {
  return new Promise<DebugEvent>((resolve) => {
    const timer = setTimeout(() => {
      // 超时的进程状态不可知：可能正卡在死循环里吃 CPU。杀掉并作废，不留"看起来还能单步"的会话
      void finish(session, { status: 'timeout', message: `这一步超过 ${timeoutMs}ms，会话已作废` });
    }, timeoutMs);
    session.pending = { resolve, timer };
  });
}

function debuggable(language: string): { id: IdeLanguageId; label: string; kind: IdeDebugKind } | null {
  const found = findLanguage(language);
  if (!found?.debugKind || !BACKENDS[found.debugKind]) return null;
  return { id: found.id, label: found.label, kind: found.debugKind };
}

function rejected(message: string): DebugStartResponse {
  return { status: 'rejected', session: null, sessions: sessions.size, maxSessions: DEBUG_MAX_SESSIONS, message };
}

/**
 * 把一次"发命令 + 等停点"排进这个会话的串行队列，并同步记账。
 *
 * 记账必须在**调用那一刻**发生（`outstanding += 1`），不能等队列轮到自己：
 * 否则"这个会话正忙"晚一微任务才成立，空闲回收就能杀掉一条正在排队的命令。
 */
function enqueue(session: Session, run: () => Promise<DebugEvent>): Promise<DebugEvent> {
  session.outstanding += 1;
  const result = session.queue.then(run, run);
  const settled = result.then(
    (event) => {
      session.outstanding -= 1;
      return event;
    },
    (err: unknown) => {
      session.outstanding -= 1;
      throw err;
    },
  );
  // 队列本身永远不许变成未处理拒绝（一次失败不能把后面的命令全带崩）
  session.queue = settled.then(() => undefined, () => undefined);
  return settled;
}

function sendAndWait(session: Session, budget: number, send: () => void): Promise<DebugEvent> {
  return enqueue(session, () => {
    // 会话已经作废（前一条命令失败、被停止、进程退了）：排队轮到时**当场**给答案。
    // 少了这一条，死会话队列里的那条命令会去等一个永远不来的停点事件，
    // 而它的超时结算又被 finish 的 dead 守卫挡掉 —— 于是这条 promise 永不落地，
    // 队列是 Promise 链，后面排队的每一条一起卡死（表现为"界面永远转圈"，要重启服务才好）。
    if (session.dead) return Promise.resolve<DebugEvent>({ status: 'gone', message: '调试会话已经不在了，重新按调试即可' });
    const waited = waitForEvent(session, budget);
    try {
      send();
    } catch (err) {
      void finish(session, { status: 'gone', message: `写入调试进程失败：${(err as Error).message}` });
    }
    return waited;
  });
}

export async function startDebug(
  language: string,
  code: string,
  breakpoints: number[],
  timeoutMs?: number,
): Promise<DebugStartResponse> {
  const target = debuggable(language);
  if (!target) {
    return rejected(`${language} 没有行断点（这台机器上没有可行的调试机制，或这门语言的执行形态不驻留）`);
  }
  const backend = BACKENDS[target.kind]!;
  const session: Session = {
    id: randomUUID(),
    language: target.id,
    label: target.label,
    handle: null as unknown as DebugHandle, // launch 返回前没人碰得到它：那期间的事件先进 early 队列
    pending: null,
    outstanding: 0,
    lastUsedAt: Date.now(),
    dead: false,
    output: '',
    queue: Promise.resolve(),
  };
  /**
   * **先占名额再 await**。检查与占位之间只要隔着一次 await（launch 里的 javac 是几百毫秒级的），
   * 两个并发请求就都能通过 `size >= 上限`，于是上限 1 实际起 2 个常驻进程。
   * 单线程救不了这个：需要的是"检查与登记之间不放手"。
   */
  if (sessions.size >= DEBUG_MAX_SESSIONS) {
    return rejected(
      `已有 ${sessions.size} 个调试会话在跑（上限 ${DEBUG_MAX_SESSIONS}）。调试会话是常驻进程，先停掉一个再开。`,
    );
  }
  sessions.set(session.id, session);
  ensureSweeper();

  /** 后端在 launch 里就可能开始吐事件（jdb 编译只要几百毫秒），先攒着，会话建好再灌进去。 */
  const early: BackendEvent[] = [];
  // 第一次停点的预算比单步宽：java 要付 javac + jdb 起 JVM，js 要付连上调试端口并放行。
  // **由管理器算好再交给后端**：后端自己造一个更小的数就会抢着放弃，把"慢"报成"错"。
  const startBudget = timeoutMs && timeoutMs > 0 ? timeoutMs : DEBUG_START_TIMEOUT_MS;
  let launched;
  try {
    launched = await backend.launch({
      code,
      breakpoints,
      startupBudgetMs: startBudget,
      emit: (event) => {
        if (session.handle) handleEvent(session, event);
        else early.push(event);
      },
    });
  } catch (err) {
    sessions.delete(session.id);
    return rejected(`起不来调试器：${(err as Error).message}`);
  }
  if (!launched.ok) {
    sessions.delete(session.id);
    const event = launched.event;
    return {
      status: 'error',
      output: event.type === 'error' ? event.text : event.type,
      message: event.type === 'error' ? (event.message ?? '没能开始调试') : '没能开始调试',
      session: null,
      sessions: sessions.size,
      maxSessions: DEBUG_MAX_SESSIONS,
    };
  }

  session.handle = launched.handle;
  const child = launched.handle.child;
  // 进程自己没了：走 finish（它会连"请它退 → 等 → 硬杀 → 删沙箱"一起做完）
  child.on('error', (err: Error) => void finish(session, { status: 'gone', message: `调试进程起不来：${err.message}` }));
  child.on('exit', () => void finish(session, { status: 'gone', message: '调试进程退出了，请重新开始调试' }));

  const event = await sendAndWait(session, startBudget, () => {
    for (const queued of early.splice(0)) handleEvent(session, queued);
  });
  const alive = !session.dead;
  return {
    ...event,
    session: alive ? { id: session.id, language: session.language, label: session.label } : null,
    sessions: sessions.size,
    maxSessions: DEBUG_MAX_SESSIONS,
  };
}

export function stepDebug(sessionId: string, action: DebugAction, timeoutMs?: number): Promise<DebugStepResponse> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Promise.resolve({
      status: 'gone',
      action,
      sessions: sessions.size,
      message: `没有这个调试会话（${sessionId}）：程序跑完、出错或已被空闲回收`,
    });
  }
  session.lastUsedAt = Date.now();
  const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : DEBUG_STEP_TIMEOUT_MS;
  return sendAndWait(session, budget, () => session.handle.send(action)).then((event) => ({
    ...event,
    action,
    sessions: sessions.size,
  }));
}

export async function stopDebug(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  await finish(session, { status: 'gone', message: '调试会话已停止' });
  return true;
}

export function debugSessions(): DebugSessionInfo[] {
  const now = Date.now();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    language: s.language,
    busy: s.outstanding > 0,
    idleMs: now - s.lastUsedAt,
  }));
}

/**
 * 回收空闲会话。**正在等单步结果的那条不许杀** —— 那等于把用户唯一那条"跑飞了"的命令
 * 变成一次静默丢失；它有自己的超时。
 */
export async function sweepIdleDebugSessions(nowMs: number, maxIdleMs: number): Promise<string[]> {
  const killed: string[] = [];
  for (const [id, session] of [...sessions.entries()]) {
    if (session.outstanding > 0) continue;
    if (nowMs - session.lastUsedAt <= maxIdleMs) continue;
    killed.push(id);
    await stopDebug(id);
  }
  return killed;
}

let sweeper: NodeJS.Timeout | null = null;
let exitHooked = false;

function ensureSweeper(): void {
  if (!sweeper) {
    sweeper = setInterval(() => {
      void sweepIdleDebugSessions(Date.now(), DEBUG_IDLE_MS);
    }, 60_000);
    sweeper.unref?.();
  }
  if (!exitHooked) {
    exitHooked = true;
    // 服务退出时连调试进程一起收：容器停了还挂着 jdb / python3 就是漏进程
    process.once('exit', () => {
      for (const session of sessions.values()) {
        if (session.handle) killProcessTree(session.handle.child);
      }
    });
  }
}

/** 供测试与收尾：关掉所有会话。 */
export async function stopAllDebug(): Promise<void> {
  for (const id of [...sessions.keys()]) await stopDebug(id);
}
