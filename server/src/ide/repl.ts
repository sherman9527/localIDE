/**
 * 网页 IDE 的 REPL 会话（WI-77）。
 *
 * 与"点一次运行"的差别只有一件事：**状态要活着** —— 上一句定义的变量、函数、import，
 * 下一句还能用。所以这里必须养一个跨请求存活的子进程（同 `exec/spark-pool.ts` 的取舍），
 * 而不是每次 `runProcess` 起一个新的。
 *
 * 三件不能靠猜的事，都在容器里实测过（见 memo 里程碑 AQ）：
 * 1. **一句什么时候算完**：喂完用户那行后再喂一条"打印哨兵行"的语句，看到
 *    `ARENA_REPL:<seq>` 这一行就算完。猜提示符不行 —— python 的提示符在 stderr，
 *    node 的在 stdout，jshell 的还带 `$2 ==>` 前缀，三家都不一样。
 * 2. **python 的 stdout 必须不缓冲**：管道下它默认块缓冲，实测整段输出一个字都不回，
 *    直到进程被杀才丢在缓冲区里 ⇒ `-u` + `PYTHONUNBUFFERED=1`。
 * 3. **提示符噪声在哪一路**：python 的 `>>> ` 全在 stderr（traceback 也在那儿），
 *    node / jshell 的提示符在 stdout。所以两条流都要收，并按语言各剥各的提示符。
 *
 * 威胁模型同 `ide/runner.ts`：本机单用户工具，这里的超时/上限是为了"跑飞了别把服务挂住"，
 * 不是多租户沙箱。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ReplFeedResponse, ReplFeedStatus, ReplSessionInfo } from '@arena/shared';
import { IDE_SESSION_LIMITS } from '@arena/shared';
import { killProcessTree } from '../judge/process.js';
import { IDE_LIMITS, findLanguage, type IdeLanguageId } from './languages.js';

/**
 * 三条纪律的数值都在 `shared` 的 `IDE_SESSION_LIMITS` 里（调试会话用的是同一份）：
 * 这里只是给 REPL 这一侧起各自的名字。**别再抄一份数字**，那等于"改一边忘一边"。
 */
export const REPL_MAX_SESSIONS = IDE_SESSION_LIMITS.replMaxSessions;
export const REPL_IDLE_MS = IDE_SESSION_LIMITS.idleMs;

const STOP_GRACE_MS = IDE_SESSION_LIMITS.stopGraceMs;

/**
 * 出参直接用 `shared` 里的线格式类型：这里再声明一遍"响应长什么样"，
 * 就是给"前端与后端各一份真相"开门（IDE 的其它端点也是这么做的）。
 */
export interface ReplSpec {
  command: string;
  args: string[];
  env?: Readonly<Record<string, string>>;
  /** 喂完用户输入后补一个空行：python 靠它结束 def / for 块（顶层空行是无操作） */
  blankLineAfter: boolean;
  /** 打印哨兵的那条语句（三家语法都不一样，只能各写一条） */
  marker: (seq: number) => string;
  /** 各家的提示符长什么样（python 在 stderr，node / jshell 在 stdout） */
  prompt: RegExp;
  /** 报错落在哪一路：python 的 traceback 在 stderr，node / jshell 在 stdout */
  errorStream: 'stdout' | 'stderr';
  /** 报错的判据（解释器自己打的固定前缀，不是猜提示符） */
  errorPattern: RegExp;
  /**
   * 单句预算。**jshell 的第一句要付编译器与 REPL 自身的初始化（实测 >10s）**，
   * 用命令型语言那 10s 会把"其实能用"的会话一上来就判死。
   */
  feedTimeoutMs: number;
  exit: string;
}

/** node 的引导脚本：banner 与 `undefined` 回显都要关掉，否则每一句都带一行噪声。 */
const NODE_BOOTSTRAP = "require('repl').start({banner:false,ignoreUndefined:true,useGlobal:true,prompt:'> '})";

export const replLanguages: Partial<Record<IdeLanguageId, ReplSpec>> = {
  python: {
    command: 'python3',
    args: ['-u', '-i', '-q'],
    env: { PYTHONUNBUFFERED: '1' },
    blankLineAfter: true,
    marker: (seq) => `print("ARENA_REPL:${seq}")`,
    // python 的提示符全在 stderr，而且是**连着吐**的（`>>> >>> >>> `），锚在行首只能剥掉第一个
    prompt: />>> |\.\.\. /g,
    errorStream: 'stderr',
    errorPattern: /Error|Exception|Traceback/,
    feedTimeoutMs: IDE_LIMITS.timeoutMs,
    exit: 'exit()',
  },
  javascript: {
    command: process.execPath,
    args: ['-e', NODE_BOOTSTRAP],
    blankLineAfter: false,
    marker: (seq) => `console.log("ARENA_REPL:${seq}")`,
    prompt: /^(?:> )+/gm,
    errorStream: 'stdout',
    errorPattern: /^Uncaught /m,
    feedTimeoutMs: IDE_LIMITS.timeoutMs,
    exit: '.exit',
  },
  java: {
    // `--execution local`：不另起一台远程执行 JVM（默认行为会再 fork 一个，内存直接翻倍）。
    // 强制英文：jshell 的报错前缀（`|  Exception`）跟着 JVM 语言走，中文环境下这条判据会失效。
    command: 'jshell',
    args: ['-q', '--execution', 'local', '-J-Duser.language=en'],
    blankLineAfter: false,
    marker: (seq) => `System.out.println("ARENA_REPL:${seq}");`,
    prompt: /^(?:jshell> )+/gm,
    errorStream: 'stdout',
    // 不能锚行首：jshell 回显用户那一行时**不带换行**，异常文本是接在回显后面的
    // （`…("bad")|  Exception java.lang.IllegalStateException: bad`），锚了就永远匹配不上。
    errorPattern: /\|\s+(Exception|Error)\b/,
    feedTimeoutMs: 45_000,
    exit: '/exit',
  },
};

/**
 * 出参形状用 shared 里的线格式类型（`ReplFeedResponse` / `ReplSessionInfo`）：
 * 这里再声明一遍就是"前后端各一份真相"。只有 `startRepl` 的返回是模块自己的形态 ——
 * 会话数与上限由路由层补齐，不该让这一层去猜响应体长什么样。
 */
export interface ReplStartResult {
  session: { id: string; language: IdeLanguageId; label: string } | null;
  message?: string;
}

interface Turn {
  seq: number;
  stdout: string;
  stderr: string;
  resolve: (result: ReplFeedResponse) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  id: string;
  language: IdeLanguageId;
  spec: ReplSpec;
  child: ChildProcessWithoutNullStreams;
  turn: Turn | null;
  seq: number;
  lastUsedAt: number;
  dead: boolean;
  /** 串行队列：一句没结束就不许喂下一句（否则哨兵会串台） */
  queue: Promise<unknown>;
}

const sessions = new Map<string, Session>();

function stripPrompts(spec: ReplSpec, text: string): string {
  return text.replace(spec.prompt, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 只留"这一句自己的输出"。
 *
 * jshell 在非 tty 下会**回显被提交的那一行**（`System.out.println("ARENA_REPL:1")`），
 * 所以定界不能拿 substring 找 —— 那样会把回显当成结束点，于是每一句的输出都串到下一句里去
 * （第一版就是这么错的）。改成认"行尾是哨兵"；这里再把所有含哨兵的整行走掉，
 * 剩下的就只可能是解释器回显我那条定界语句。
 */
function keepOnlyOutput(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes('ARENA_REPL:'))
    .join('\n');
}

/** 结算当前这一句：哨兵行之前的那段就是这一句的输出。 */
function settle(session: Session, turn: Turn, status: ReplFeedStatus, extraNote = ''): void {
  if (session.turn === turn) session.turn = null;
  clearTimeout(turn.timer);
  const spec = session.spec;
  const out = stripPrompts(spec, keepOnlyOutput(turn.stdout));
  const err = stripPrompts(spec, keepOnlyOutput(turn.stderr));
  const transcript = [out, err].filter(Boolean).join('\n');
  turn.resolve({
    status,
    output: extraNote ? `${transcript}${transcript ? '\n' : ''}${extraNote}` : transcript,
  });
}

function failTurn(session: Session, status: ReplFeedStatus, note: string): void {
  const turn = session.turn;
  if (turn) settle(session, turn, status, note);
}

function pumpStdout(session: Session, chunk: string): void {
  const turn = session.turn;
  if (!turn) return;
  turn.stdout += chunk;
  const marker = `ARENA_REPL:${turn.seq}`;
  const lines = turn.stdout.split('\n');
  // **行尾**匹配而不是整行相等：node 与 jshell 的提示符不带换行，
  // 哨兵那行实际长成 `> > ARENA_REPL:1` / `jshell> ARENA_REPL:1`（python 干净是因为它的提示符在 stderr）。
  // 解释器回显的语句本身以 `")` 结尾，所以不会被误判成结束点。
  const index = lines.findIndex((line) => line.trimEnd().endsWith(marker));
  if (index < 0) return;
  // 哨兵行里剩下的只有提示符；之后的内容是解释器给下一条的提示（那时我还没写下一句）
  turn.stdout = lines.slice(0, index).join('\n');
  session.turn = null;
  const spec = session.spec;
  const body = spec.errorStream === 'stdout' ? turn.stdout : turn.stderr;
  settle(session, turn, spec.errorPattern.test(stripPrompts(spec, body)) ? 'error' : 'ok');
}

function attach(session: Session): void {
  session.child.stdout.setEncoding('utf8');
  session.child.stderr.setEncoding('utf8');
  session.child.stdout.on('data', (chunk: string) => pumpStdout(session, chunk));
  session.child.stderr.on('data', (chunk: string) => {
    if (session.turn) session.turn.stderr += chunk;
  });
  session.child.on('error', (err: Error) => {
    session.dead = true;
    failTurn(session, 'gone', `会话进程起不来：${err.message}`);
    sessions.delete(session.id);
  });
  session.child.on('exit', (code, signal) => {
    if (!session.dead) {
      session.dead = true;
      failTurn(session, 'gone', `会话已退出（code=${code ?? 'null'} signal=${signal ?? '-'}），请重开会话`);
    }
    sessions.delete(session.id);
  });
}

export async function startRepl(language: string): Promise<ReplStartResult> {
  const id = findLanguage(language)?.id;
  const spec = id ? replLanguages[id] : undefined;
  const label = findLanguage(language)?.label ?? language;
  if (!id || !spec) {
    return { session: null, message: `${label} 没有 REPL（这门语言的执行形态是一次性运行，或这台机器没有它的交互式运行时）` };
  }
  if (sessions.size >= REPL_MAX_SESSIONS) {
    return {
      session: null,
      message: `已有 ${sessions.size} 个会话在跑（上限 ${REPL_MAX_SESSIONS}）。REPL 会话是常驻进程，先关掉一个再开。`,
    };
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...(spec.env ?? {}) },
      // 独立进程组：超时要连解释器 fork 出来的子进程一起收，别留孤儿
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    return { session: null, message: `起不来 ${spec.command}：${(err as Error).message}` };
  }
  const session: Session = {
    id: randomUUID(),
    language: id,
    spec,
    child,
    turn: null,
    seq: 0,
    lastUsedAt: Date.now(),
    dead: false,
    queue: Promise.resolve(),
  };
  attach(session);
  sessions.set(session.id, session);
  ensureSweeper();
  return { session: { id: session.id, language: id, label } };
}

function runTurn(session: Session, line: string, timeoutMs: number): Promise<ReplFeedResponse> {
  if (session.dead || !session.child.stdin.writable) {
    return Promise.resolve({ status: 'gone', output: '这个会话已经不在了（超时作废或进程退出），请重开会话' });
  }
  const spec = session.spec;
  const seq = ++session.seq;
  return new Promise<ReplFeedResponse>((resolve) => {
    const timer = setTimeout(() => {
      // 超时的会话状态不可知：可能还在死循环里吃 CPU。杀掉，不留"看起来还能用"的会话
      session.dead = true;
      killProcessTree(session.child);
      sessions.delete(session.id);
      failTurn(session, 'timeout', `这一句超过 ${timeoutMs}ms，会话已作废`);
    }, timeoutMs);
    session.turn = { seq, stdout: '', stderr: '', resolve, timer };
    const payload = `${line}\n${spec.blankLineAfter ? '\n' : ''}${spec.marker(seq)}\n`;
    try {
      session.child.stdin.write(payload);
    } catch (err) {
      clearTimeout(timer);
      session.turn = null;
      resolve({ status: 'gone', output: `写入失败：${(err as Error).message}` });
    }
  });
}

export function feedRepl(sessionId: string, line: string, timeoutMs?: number): Promise<ReplFeedResponse> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Promise.resolve({ status: 'gone', output: `没有这个会话（${sessionId}）：可能已被空闲回收或超时作废` });
  }
  session.lastUsedAt = Date.now();
  const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : session.spec.feedTimeoutMs;
  const run = () => runTurn(session, line, budget);
  const result = session.queue.then(run, run);
  // 队列只保证"一句一句来"，本身不许变成未处理拒绝
  session.queue = result.then(() => undefined, () => undefined);
  return result;
}

export async function stopRepl(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  session.dead = true;
  failTurn(session, 'gone', '会话已关闭');
  try {
    session.child.stdin.end(`${session.spec.exit}\n`);
  } catch {
    /* 已经不在了，下面兜底 */
  }
  const gone = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_GRACE_MS);
    session.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await gone;
  if (!session.child.killed) killProcessTree(session.child);
  return true;
}

export function replSessions(): ReplSessionInfo[] {
  const now = Date.now();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    language: s.language,
    busy: s.turn !== null,
    idleMs: now - s.lastUsedAt,
  }));
}

/**
 * 回收空闲会话。**正在跑一句的会话不许杀** —— 那等于把用户唯一那条"跑飞了"的命令
 * 变成一次静默丢失；它有自己的超时。
 */
export async function sweepIdleReplSessions(nowMs: number, maxIdleMs: number): Promise<string[]> {
  const killed: string[] = [];
  for (const [id, session] of [...sessions.entries()]) {
    if (session.turn) continue;
    if (nowMs - session.lastUsedAt <= maxIdleMs) continue;
    killed.push(id);
    await stopRepl(id);
  }
  return killed;
}

let sweeper: NodeJS.Timeout | null = null;
let exitHooked = false;

function ensureSweeper(): void {
  if (!sweeper) {
    sweeper = setInterval(() => {
      void sweepIdleReplSessions(Date.now(), REPL_IDLE_MS);
    }, 60_000);
    sweeper.unref?.();
  }
  if (!exitHooked) {
    exitHooked = true;
    // 服务退出时连会话进程一起收：容器停了还挂着 python/jshell 就是漏进程
    process.once('exit', () => {
      for (const session of sessions.values()) killProcessTree(session.child);
    });
  }
}

/** 供测试与收尾：关掉所有会话。 */
export async function stopAllRepl(): Promise<void> {
  for (const id of [...sessions.keys()]) await stopRepl(id);
}
