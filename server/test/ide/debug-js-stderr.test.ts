import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import type { BackendEvent, LaunchResult } from '../../src/ide/debug-backend.js';
import { jsBackend } from '../../src/ide/debug-js.js';
import { honestMessage, startDebug } from '../../src/ide/debug.js';

/**
 * WI-105：js 调试后端的 stderr 必须**按行**判协议，不许按 chunk 判。
 *
 * 病灶（`debug-js.ts` 里原先那一行 `WS_URL_RE.exec(chunk)`）：node 把
 * `Debugger listening on ws://127.0.0.1:<port>/<uuid>` 写成一行，而**chunk 边界由负载决定** ——
 * 管道窗口、同进程其它 fd 的写、Node 每次 read 的大小都会挪动它。边界落在 URL 中间时
 * `\S+` 就在 chunk 末尾停下 ⇒ 拿到一条被截断的 URL ⇒ 连不上 ⇒ 而那条失败事件**没有 message**
 * ⇒ 管理器落到 `?? '没能开始调试'` ⇒ 界面与测试看到的都是同一句什么都没说的好话
 * （`memo.md` 里那条冤红原文 `起不来：没能开始调试` 就是这个形状）。
 *
 * **为什么这里用假子进程**：这一族的判据必须是**可控的 chunk 边界**。拿真 node 去赌
 * "这次会不会正好断在 URL 中间"就是 WI-92 那条随机红的另一种写法 —— 它今天绿、明天红，
 * 而绿的时候什么都证明不了。所以 `spawn` 被换成一个"调用一次 `writeStderr` 就是一个 chunk"的假流：
 * 断点在哪、几个 chunk、有没有换行、进程什么时候退，全部由用例决定。
 * ｜另一侧的对照在这里：`server/test/ide/debug.test.ts` 那批用例跑的是**真 node**（单 chunk 的
 * ｜正常形状），它们一条都没被改过，也不该被改 —— 那批绿才说明"修好的不只是新路径"。
 *
 * 沙箱按进程分目录（WI-92 的第二条）：这个文件也会建 `debug-*` 目录，而别家门禁数的正是个数。
 */
const SHARED_JUDGE_ROOT = config.judgeWorkDir;
const OWNED_JUDGE_ROOT = join(SHARED_JUDGE_ROOT, `test-pid-${process.pid}`);
(config as { judgeWorkDir: string }).judgeWorkDir = OWNED_JUDGE_ROOT;

interface FakeStream {
  on(event: string, fn: (arg?: unknown) => void): unknown;
  once(event: string, fn: (arg?: unknown) => void): unknown;
  off(event: string, fn: (arg?: unknown) => void): unknown;
  emit(event: string, arg?: unknown): void;
  setEncoding(): unknown;
}

interface FakeChild {
  stdout: FakeStream;
  stderr: FakeStream;
  exitCode: number | null;
  killSignals: string[];
  on(event: string, fn: (arg?: unknown) => void): unknown;
  once(event: string, fn: (arg?: unknown) => void): unknown;
  off(event: string, fn: (arg?: unknown) => void): unknown;
  emit(event: string, arg?: unknown): void;
  kill(signal?: string): boolean;
  /** 一次调用 = **一个** stderr chunk：边界由这条用例决定，不由真实调度决定 */
  writeStderr(chunk: string): void;
  /** 进程退出：`exit` 之后补 `end`，与真管道的先后一致（EOF 在数据之后） */
  exit(code: number): void;
}

const harness = vi.hoisted(() => {
  type Handler = (arg?: unknown) => void;
  interface Slot {
    fn: Handler;
    once: boolean;
  }
  /** 同步派发的最小 EventEmitter：`feed` 里发生的 emit 必须在本轮就看得见的顺序上成立 */
  class Signals {
    private map = new Map<string, Slot[]>();
    private slot(event: string): Slot[] {
      const found = this.map.get(event);
      if (found) return found;
      const created: Slot[] = [];
      this.map.set(event, created);
      return created;
    }
    on(event: string, fn: Handler): this {
      this.slot(event).push({ fn, once: false });
      return this;
    }
    once(event: string, fn: Handler): this {
      this.slot(event).push({ fn, once: true });
      return this;
    }
    off(event: string, fn: Handler): this {
      const list = this.slot(event);
      const at = list.findIndex((s) => s.fn === fn);
      if (at >= 0) list.splice(at, 1);
      return this;
    }
    emit(event: string, arg?: unknown): void {
      for (const slot of [...this.slot(event)]) {
        if (slot.once) this.off(event, slot.fn);
        slot.fn(arg);
      }
    }
  }
  class FakeStream extends Signals {
    setEncoding(): this {
      return this;
    }
  }
  class FakeChild extends Signals {
    stdout = new FakeStream();
    stderr = new FakeStream();
    exitCode: number | null = null;
    killSignals: string[] = [];
    kill(signal?: string): boolean {
      this.killSignals.push(signal ?? 'SIGTERM');
      return true;
    }
    writeStderr(chunk: string): void {
      this.stderr.emit('data', chunk);
    }
    exit(code: number): void {
      this.exitCode = code;
      this.emit('exit', code);
      this.stderr.emit('end');
      this.stdout.emit('end');
    }
  }
  const children: FakeChild[] = [];
  const waiters: ((child: FakeChild) => void)[] = [];
  return {
    children,
    spawn(): FakeChild {
      const child = new FakeChild();
      children.push(child);
      waiters.shift()?.(child);
      return child;
    },
    nextChild(): Promise<FakeChild> {
      return new Promise<FakeChild>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: () => harness.spawn() };
});

/** `--inspect-brk` 真会给的这一行（实测：行尾是 `\r\n`，端口随机，路径段是 uuid 形状的会话凭据）。 */
const WS_UUID = '40bb51c0-1724-4dc6-91d2-d6e42047466e';
const WS_PORT = '54321';
const INSPECTOR_LINE = `Debugger listening on ws://127.0.0.1:${WS_PORT}/${WS_UUID}\r\n`;
/** 断在 host 与端口之间：前一片自己就能被 `\S+` 匹配掉（这正是老实现上当的地方）。 */
const CUT_AT = 'Debugger listening on ws://127.0.0.1:5'.length;
const SPLIT_CHUNKS = [INSPECTOR_LINE.slice(0, CUT_AT), INSPECTOR_LINE.slice(CUT_AT)];

const CODE = ['const total = 40;', 'const answer = total + 2;'].join('\n');

async function launchWithChunks(
  chunks: string[],
  afterFeed?: (child: FakeChild) => void,
  budgetMs = 8_000,
): Promise<{ result: LaunchResult; events: BackendEvent[]; child: FakeChild }> {
  const events: BackendEvent[] = [];
  const awaitedChild = harness.nextChild();
  const launching = jsBackend.launch({
    code: CODE,
    breakpoints: [2],
    startupBudgetMs: budgetMs,
    emit: (event) => {
      events.push(event);
    },
  });
  const child = await withDeadline(awaitedChild, 'launch 没有 spawn（假 child_process 没接上，用例本身写坏了）');
  for (const chunk of chunks) child.writeStderr(chunk);
  // 没有 URL 的用例要让 launch 落地，否则它会等满预算、沙箱目录也还在：退出即收摊
  afterFeed?.(child);
  if (!chunks.some((c) => c.includes('Debugger listening'))) child.exit(1);
  const result = await withDeadline(launching, 'launch 没有返回（等 ws URL 或连端口那一段没有落地）');
  return { result, events, child };
}

function withDeadline<T>(promise: Promise<T>, why: string, ms = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等了 ${ms}ms 还没落地：${why}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? new Error(`${why}：${err.message}`) : new Error(why));
      },
    );
  });
}

function outputText(events: BackendEvent[]): string {
  return events.filter((e) => e.type === 'output').map((e) => (e.type === 'output' ? e.text : '')).join('');
}

function errorEvent(result: LaunchResult): Extract<BackendEvent, { type: 'error' }> {
  if (result.ok) throw new Error(`期望 launch 失败并给出诊断事件，实际 it ok:true（会话已建立）`);
  if (result.event.type !== 'error') throw new Error(`期望 error 事件，实际 ${result.event.type}`);
  return result.event;
}

async function debugSandboxes(): Promise<string[]> {
  const names = await readdir(config.judgeWorkDir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('debug-')).sort();
}

let sandboxBaseline: string[] = [];

beforeEach(() => {
  harness.children.length = 0;
});

beforeEach(async () => {
  sandboxBaseline = await debugSandboxes();
});

afterEach(async () => {
  // 这一份沙箱根是本进程独有的（`test-pid-<pid>`），所以"回到基线"在这里等价于"别攒孤儿目录"
  const deadline = Date.now() + 30_000;
  for (;;) {
    const extras = (await debugSandboxes()).filter((n) => !sandboxBaseline.includes(n));
    if (extras.length === 0) return;
    if (Date.now() > deadline) throw new Error(`调试沙箱没收干净（本进程独有目录，不是排队）：${extras.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe('js 调试后端的 stderr 协议解析（按行，不按 chunk）', () => {
  it('URL 行断在两个 chunk 之间（边界落在 host 与端口之间）：拿到的必须是完整 URL', async () => {
    const { result } = await launchWithChunks(SPLIT_CHUNKS);
    const event = errorEvent(result);
    // 老实现在这里拿到 `ws://127.0.0.1:5`（`\S+` 在 chunk 尾停下），于是连的是根本不存在的端口
    expect(
      event.message,
      `失败必须带一句"说清是哪一步"的话（老形状：只有 text，没有 message ⇒ 管理器落到"没能开始调试"）。实际 event=${JSON.stringify(event)}`,
    ).toBeTruthy();
    expect(event.message, `消息里要出现**重新拼好的那个端口**，否则就是还在按 chunk 匹配：${event.message}`).toContain(WS_PORT);
  });

  it('对照：完整一行在**一个 chunk** 里到达时，结论与断开那次逐字相同（别只在新路径上对）', async () => {
    const split = errorEvent((await launchWithChunks(SPLIT_CHUNKS)).result);
    const whole = errorEvent((await launchWithChunks([INSPECTOR_LINE])).result);
    expect(whole, 'chunk 边界不该改变任何结论').toEqual(split);
    expect(whole.message).toContain(WS_PORT);
  });

  it('node 那条 URL 的**后半截不许漏进用户输出**（半行不许就当普通字发出去）', async () => {
    const { events } = await launchWithChunks(SPLIT_CHUNKS);
    const leaked = outputText(events);
    expect(leaked, `调试器的广播不是用户的输出：${JSON.stringify(leaked)}`).not.toContain(WS_UUID);
    expect(leaked).not.toContain('ws://');
  });

  it('没有换行的最后一行也要判（flush）：URL 正好停在进程退出那一刻时仍然要连它', async () => {
    // 两个条件叠在一起：断成两片（按 chunk 判会截断）**且**整行没有换行（不 flush 就永远丢一行）
    const tail = INSPECTOR_LINE.slice(0, -2);
    const { result, child } = await launchWithChunks([tail.slice(0, CUT_AT), tail.slice(CUT_AT)], (c) => c.exit(0));
    const event = errorEvent(result);
    expect(
      event.message,
      `尾块没 flush 就等于"永远丢一行"（这里丢的正是 ws URL）：event=${JSON.stringify(event)}`,
    ).toContain(WS_PORT);
    expect(event.message).toContain(WS_PORT);
    expect(child.killSignals, '连不上端口之后要把挂着调试器的 node 收掉').toContain('SIGKILL');
  });

  it('用户打到 stderr 的字**不许**等换行才发（调试面板的实时性不能退化成整行一发）', async () => {
    const events: BackendEvent[] = [];
    const awaitedChild = harness.nextChild();
    const launching = jsBackend.launch({ code: CODE, breakpoints: [], startupBudgetMs: 8_000, emit: (e) => events.push(e) });
    const child = await withDeadline(awaitedChild, 'launch 没有 spawn');
    // ⚠ 断言在中间失败也要让子进程"退一次"：否则这条 launch 会挂着等满预算，
    // 沙箱目录跟着留在 afterEach 的账上 —— 一个失败拖垮一整批（WI-92 记过的那条连锁）。
    try {
      child.writeStderr('progress-1');
      expect(
        outputText(events),
        '这一条判的是"实时性没被改成整行才发"：没有换行的一段普通输出要当场出去',
      ).toContain('progress-1');
      child.writeStderr('-progress-2\r\n');
      expect(outputText(events), '拼起来必须还是原来那串字节（不许重复、不许吞）').toBe('progress-1-progress-2\r\n');
    } finally {
      child.exit(0);
      await withDeadline(launching, 'launch 没落地');
    }
  });

  it('可疑行超过上界时要强行切开并**说清**（缓冲不许无界：一个不写换行的进程吃不掉内存）', async () => {
    // 上界的契约写在这里（生产侧那份叫 `STDERR_HOLD_CAP`）：用例只观察行为，不回读常量
    const CAP = 8_000;
    const events: BackendEvent[] = [];
    const awaitedChild = harness.nextChild();
    const launching = jsBackend.launch({ code: CODE, breakpoints: [], startupBudgetMs: 8_000, emit: (e) => events.push(e) });
    const child = await withDeadline(awaitedChild, 'launch 没有 spawn');
    try {
      // 一行"看着像 node 的协议行"却没写完的输出：必须被扣住（否则协议就判不住），但只能扣到上界
      child.writeStderr('Debugger listening on ' + 'a'.repeat(CAP - 30));
      expect(outputText(events), '还没到上界时这条仍在攒行，不该提前发出去').toBe('');
      child.writeStderr('b'.repeat(40));
      const text = outputText(events);
      expect(
        text,
        '越过上界必须"说清"：要么当场切开这段输出并留一句话，否则内存无界而界面还一片安静',
      ).toMatch(/没写完|截断|切开/);
      expect(text.length, `切开的代价是"不再攒行"，不是丢字：已发出去的字节要接近已喂入的字节`).toBeGreaterThanOrEqual(CAP - 30);
    } finally {
      child.exit(0);
      await withDeadline(launching, 'launch 没落地');
    }
  });
});

describe('失败消息不许在链条里被换成空话（WI-105 第 2 点）', () => {
  it('经管理器这条路：后端给的那句话必须原样到达调用方，而不是"没能开始调试"', async () => {
    const direct = errorEvent((await launchWithChunks(SPLIT_CHUNKS)).result);
    const awaitedChild = harness.nextChild();
    const startedPromise = startDebug('javascript', CODE, [2], 8_000);
    const child = await withDeadline(awaitedChild, 'startDebug 没有 spawn');
    for (const chunk of SPLIT_CHUNKS) child.writeStderr(chunk);
    const started = await withDeadline(startedPromise, 'startDebug 没落地');
    expect(started.status).toBe('error');
    expect(started.session).toBeNull();
    expect(
      started.message,
      `这条红的就是 WI-92 那条冤红的形状：后端说了真话，管理器把它换成"没能开始调试"`,
    ).toBe(direct.message);
    expect(started.message).not.toBe('没能开始调试');
    expect(started.message).toContain('连不上 node 的调试端口');
  });

  /**
   * 管理器自己的兜底也单独判一次（上面那条只覆盖"后端记得给 message"的世界）。
   * 判的是"**没记得**"那一半：后端漏了 message 时，管理器要搬出它给的 `text`，而不是留一句空话。
   * 少了这一条，"补上 message"就只是某个后端的自觉 —— 而下一家后端会忘。
   */
  it('后端漏给 message 时，管理器要把后端给的那段字带上（兜底不许是"只剩兜底"）', () => {
    expect(honestMessage('后端给的话', '一堆诊断原文', '没能开始调试')).toBe('后端给的话');
    expect(honestMessage(undefined, 'node: SyntaxError 在第 1 行', '没能开始调试')).toBe(
      '没能开始调试：node: SyntaxError 在第 1 行',
    );
    expect(honestMessage(undefined, '   ', '没能开始调试')).toBe('没能开始调试');
    expect(honestMessage(undefined, undefined, '调试结束')).toBe('调试结束');
    // message 会进响应体、也会进日志：`text` 是无界字符串（一次 traceback 几十 KB 很正常），必须截
    const long = honestMessage(undefined, 'x'.repeat(5000), '调试结束');
    expect(long.startsWith('调试结束：'), long).toBe(true);
    expect(long.length).toBeLessThanOrEqual('调试结束：'.length + 201);
  });

  it('node 的 ws URL 不许原样出现在任何一条消息里（uuid 那一段是会话凭据）', async () => {
    const { result } = await launchWithChunks(SPLIT_CHUNKS);
    const whole = JSON.stringify(result);
    expect(whole, 'uuid 形状的会话标识进了消息 = 凭据外泄（同 `notebooks/*` 那把尺子）').not.toContain(WS_UUID);
    expect(whole).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(whole).toContain(WS_PORT);
  });

  it('URL 少了会话标识段时，消息要自己说得出"这条像是被截断的"', async () => {
    const noSessionId = `Debugger listening on ws://127.0.0.1:${WS_PORT}\r\n`;
    const event = errorEvent((await launchWithChunks([noSessionId])).result);
    expect(event.message).toMatch(/截断|不完整|少了/);
    expect(event.message).toContain(WS_PORT);
  });
});
