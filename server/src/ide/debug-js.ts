import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { IDE_SESSION_LIMITS, type DebugAction, type DebugVar } from '@arena/shared';
import { createWorkspace, type Workspace } from '../judge/workspace.js';
import { clipRepr, type DebugBackend, type DebugHandle, type LaunchResult } from './debug-backend.js';

/**
 * JavaScript 后端（WI-82）：`node --inspect-brk` + Chrome DevTools Protocol。
 *
 * 为什么不用自己写 WebSocket 帧：Node 18 起有内置的 `WebSocket`（undici），
 * 而 CDP 只是"JSON 报文走 ws"，所以这里没有新依赖，也没有手写协议。
 *
 * **`--inspect-brk` 就是那个启动 gate**。调试器最容易踩的坑是"程序在断点装好之前就跑完了"
 * —— 直接 `--inspect` 正是这样（实测过）。`-brk` 让 VM 停在第一条语句上等我们：
 * 连上 → `Debugger.enable` → 把断点装完 → `Debugger.resume`。
 * 所以启动时那个 `reason: 'Break on start'` 的暂停**不能报给界面** —— 它是装断点的窗口，
 * 报出去等于用户第一次按调试就莫名其妙停在第 1 行。
 *
 * 与另两家比，CDP 是有 schema 的协议（`Debugger.paused` 直接给 callFrames 与 scopeChain），
 * 不用像 jdb 那样按文本猜。但变量值要再发一次 `Runtime.getProperties` 才拿得到 ——
 * `paused` 里只给 objectId，那是个引用，不查就只剩 `[object Object]`。
 *
 * 一个顺序上的讲究：**子进程的 exit 监听在这里注册，比会话管理器早**。
 * 谁先注册谁先结算，于是"程序正常跑完"报成 `exited`（事实），
 * 而不是管理器那条兜底的"调试进程退出了，请重新开始调试"（听起来像出错）。
 */

const WS_URL_RE = /Debugger listening on (ws:\/\/\S+)/;
/** node 写在 stderr 上的调试器广播，不是用户程序的输出（stderr 整条会进输出，所以必须在这里挡住）。 */
const INSPECTOR_NOISE_RE = /^(Debugger listening|Debugger attached|Waiting for the debugger|For more information|DevTools listening|Warning: )/;

type CdpValue = {
  type?: string;
  subtype?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
};
type CdpProperty = { name: string; value?: CdpValue; get?: boolean };
type CdpFrame = {
  functionName?: string;
  /** 这一帧在哪个文件里。不等于我们那份 ⇒ 行号不能往编辑器上报 */
  url?: string;
  location?: { lineNumber?: number };
  scopeChain?: { type?: string; object?: { objectId?: string } }[];
};
type CdpEvent = { method: string; params?: Record<string, unknown> };

// 启动这一路**没有自己的超时常量**：等 ws URL 与等第一个暂停共用管理器传进来的 `startupBudgetMs`
// （见 launch 里的 remainingMs）。后端各自编一个更小的数，就会在机器忙时抢着放弃并把"慢"报成"错"。
// 事件泵那一等也没有超时，也不该有：它的三条唤醒路都是"resolve 型"（下一条停点 / 子进程退出 /
// socket 断开），而一条会 reject 的等待足够把整个服务带走（unhandled rejection ⇒ Node 结束进程）。

const STEP_COMMAND: Record<DebugAction, string> = {
  continue: 'Debugger.resume',
  next: 'Debugger.stepOver',
  stepIn: 'Debugger.stepInto',
  stepOut: 'Debugger.stepOut',
};

function describeValue(prop: CdpProperty): DebugVar {
  const value = prop.value;
  if (!value) {
    // 两种"没有值"要分开说：取值器是我们**没去求值**（求值会跑用户代码），
    // 而 TDZ 里的 const 是真的还没有值 —— 停在第 7 行时 `answer` 就是这种，
    // 它比"这个变量不存在"更准确（JS 的声明提升让名字先于赋值出现在作用域里）
    return prop.get
      ? { name: prop.name, type: 'getter', repr: '<取值器，未求值>' }
      : { name: prop.name, type: 'uninitialized', repr: '<声明了，还没赋值>' };
  }
  const raw =
    value.description ??
    value.unserializableValue ??
    (typeof value.value === 'string' ? JSON.stringify(value.value) : String(value.value));
  const { repr, truncated } = clipRepr(raw);
  const subtype = value.subtype && value.subtype !== 'null' ? `(${value.subtype})` : '';
  return {
    name: prop.name,
    type: `${value.type ?? ''}${subtype}`,
    repr,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * 等 ws URL：node 起得慢要等，起不来（语法错误）则子进程先退。
 * 超时时间由调用方给（**不要**在这里编一个比管理器更小的数）。
 */
function waitForWsUrl(child: ChildProcess, read: () => string | null, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (value: string | null): void => {
      clearTimeout(timer);
      clearInterval(poll);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = (): void => done(read());
    const timer = setTimeout(() => done(read()), timeoutMs);
    child.once('exit', onExit);
    const poll = setInterval(() => {
      const url = read();
      if (url) done(url);
    }, 25);
    poll.unref?.();
  });
}

export const jsBackend: DebugBackend = {
  kind: 'javascript',
  async launch({ code, breakpoints, startupBudgetMs, emit }): Promise<LaunchResult> {
    const workspace: Workspace = await createWorkspace('debug');
    const cleanup = async (): Promise<void> => {
      await workspace.cleanup().catch(() => undefined);
    };
    /**
     * 启动这一路（等 ws URL → 连上 → 装断点 → 放行 → 等第一个暂停）**共用管理器给的这一份预算**，
     * 而不是各自再编一个数：自己编小的那个会在机器忙时抢着放弃，然后把"慢"报成"错"。
     */
    const launchedAt = Date.now();
    const remainingMs = (): number => Math.max(2_000, startupBudgetMs - (Date.now() - launchedAt));
    const file = await workspace.write('main.js', code);
    const url = pathToFileURL(file).href;

    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', file], {
      cwd: workspace.root,
      // 独立进程组：没有这一条，管理器那套"按进程组收"在 linux 上对 js 后端失效
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderrText = '';
    let wsUrl: string | null = null;
    let exited = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => emit({ type: 'output', text: chunk }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const found = WS_URL_RE.exec(chunk);
      if (found?.[1] && !wsUrl) {
        wsUrl = found[1];
        return;
      }
      if (INSPECTOR_NOISE_RE.test(chunk.trimStart())) return;
      stderrText += chunk;
      // 用户自己的 stderr（console.error 等）也是"这段时间里程序打出的字"，
      // 只攒到最后一条错误里 = 平时看不见（契约写的是 stdout + stderr）
      emit({ type: 'output', text: chunk });
    });
    /** 一句话说清是哪种失败。管理器不猜，所以这句得由唯一知道答案的地方给。 */
    const failureMessage = (text: string): string =>
      text.includes('SyntaxError')
        ? '代码有语法错误，程序没跑起来'
        : text.includes('Error:')
          ? '程序抛了未捕获的异常'
          : '调试结束';

    // 注册得比会话管理器早：程序跑完要先结算，而不是落到那条兜底的"调试进程退出了"。
    // 非零退出不是"跑完"：node 把 SyntaxError / 未捕获异常都写在 stderr 上并以 1 退出，
    // 那种情况报 error 才说清了发生了什么。
    child.once('exit', (exitCode) => {
      if (exited) return;
      exited = true;
      if (!wsUrl) return; // 还没连上就退了：由 waitForWsUrl 那条路径处理
      const code = exitCode ?? 0;
      const text = stderrText.trim();
      if (code === 0) emit({ type: 'exited', code });
      else emit({ type: 'error', text: text || `程序以退出码 ${code} 结束`, message: failureMessage(text) });
    });
    const childExited = new Promise<'exit'>((resolve) => {
      // 已经退过就要立刻给答案：`once('exit')` 不会补发，否则下面两个 race 会一直干等
      if (exited) resolve('exit');
      else child.once('exit', () => resolve('exit'));
    });

    const seen = await waitForWsUrl(child, () => wsUrl, remainingMs());
    if (!seen) {
      // 两种"没有 URL"要分开说：**进程还活着**只是慢（机器忙），与"一跑就退了"（语法错误）是两回事。
      // 旧代码在这里一律写"没起调试端口就退出了" —— 实测机器忙时它就是假的（进程根本没退）。
      const stillRunning = !exited && child.exitCode === null;
      if (stillRunning) killQuietly(child); // 挂着调试器不接管的 node 会永久停着，必须收
      await cleanup();
      return {
        ok: false,
        event: {
          type: 'error',
          text: stderrText.trim() || (stillRunning ? 'node 一直没报出调试端口' : 'node 没起调试端口就退出了'),
          message: stillRunning
            ? '调试端口迟迟没起来（这台机器此刻太忙？）—— 再按一次调试即可'
            : failureMessage(stderrText),
        },
      };
    }

    let ws: WebSocket;
    try {
      ws = await openSocket(seen);
    } catch (err) {
      killQuietly(child);
      await cleanup();
      return { ok: false, event: { type: 'error', text: `连不上 node 的调试端口：${(err as Error).message}` } };
    }

    let nextId = 1;
    const pendingCalls = new Map<number, (v: unknown) => void>();
    const pausedQueue: CdpEvent[] = [];
    const pausedWaiters: ((event: CdpEvent) => void)[] = [];

    ws.addEventListener('message', (ev: { data: string | Buffer | ArrayBuffer }) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
      } catch {
        return; // 认不出的报文：丢掉，别把会话带崩
      }
      if (msg.id !== undefined && pendingCalls.has(msg.id)) {
        const settleCall = pendingCalls.get(msg.id)!;
        pendingCalls.delete(msg.id);
        settleCall(msg.error ? { __cdpError: msg.error.message } : msg.result);
        return;
      }
      if (msg.method === 'Runtime.executionContextDestroyed') {
        /**
         * 脚本跑完了。**实测**：只要调试器还连着，node 就不退出（打印完 stdout 之后一直挂着），
         * 所以这里必须主动断开 —— 断开后子进程约 70ms 内以退出码 0 结束，
         * 由上面那个 exit 监听结算成 `exited`（非零码则结算成 error）。
         */
        try {
          ws.close();
        } catch {
          /* 已经关了 */
        }
        return;
      }
      if (msg.method === 'Debugger.paused' && msg.params) {
        const event: CdpEvent = { method: msg.method, params: msg.params };
        const waiter = pausedWaiters.shift();
        if (waiter) waiter(event);
        else pausedQueue.push(event);
      }
    });

    const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<T>((resolve) => pendingCalls.set(id, resolve as (v: unknown) => void));
    };

    /**
     * 下一条 `Debugger.paused`。队列保证"每次命令只结算一个停点"，不会把上一条的残留发给这一条。
     *
     * **不给 `timeoutMs` 就永远不会 reject** —— 事件泵要的是这种（见下面那段注释）：
     * 泵里任何一条会 reject 的输入都能把整个服务带走，因为泵是 `void (async () => {...})()`，
     * 逃出来的拒绝没人接 ⇒ Node 按 unhandled rejection 结束进程。
     */
    const nextPaused = (timeoutMs?: number): Promise<CdpEvent> => {
      const queued = pausedQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<CdpEvent>((resolve, reject) => {
        const waiter = (event: CdpEvent): void => {
          clearTimeout(timer);
          resolve(event);
        };
        const timer = timeoutMs
          ? setTimeout(() => {
              // 必须把自己从数组里摘掉：留着的话下一个事件会被这个已经死掉的 waiter 吃掉，
              // 于是"少一个事件"变成永久错位（每条单步都拿到上一次的停点）
              const at = pausedWaiters.indexOf(waiter);
              if (at >= 0) pausedWaiters.splice(at, 1);
              reject(new Error(`等不到下一个停点（${timeoutMs}ms）`));
            }, timeoutMs)
          : undefined;
        pausedWaiters.push(waiter);
      });
    };

    const readLocals = async (frame: CdpFrame): Promise<{ vars: DebugVar[]; dropped: number }> => {
      const scope =
        frame.scopeChain?.find((s) => s.type === 'local') ??
        frame.scopeChain?.find((s) => s.type && s.type !== 'global');
      const objectId = scope?.object?.objectId;
      if (!objectId) return { vars: [], dropped: 0 };
      const result = (await call<{ result?: CdpProperty[] }>('Runtime.getProperties', {
        objectId,
        ownProperties: true,
      })) as { result?: CdpProperty[] } | undefined;
      const props = (result?.result ?? []).filter((p) => !p.name.startsWith('_') && p.name !== 'this');
      const limit = IDE_SESSION_LIMITS.maxLocals;
      return { vars: props.slice(0, limit).map(describeValue), dropped: Math.max(0, props.length - limit) };
    };

    /** 这个暂停是用户要的停点吗（还是只是"VM 等完了"那个启动暂停）。 */
    const isUserStop = (event: CdpEvent): boolean => {
      const params = event.params ?? {};
      // **实测**：断点打在程序第一行时，V8 把用户断点与启动暂停合成一个 `reason: 'ambiguous'`
      // 且 `hitBreakpoints` 非空 —— 无条件当成"启动窗口"丢掉，第一行的断点就永远不停
      // （python 与 jdb 都会停，三家行为必须一致）。
      return (Array.isArray(params.hitBreakpoints) && params.hitBreakpoints.length > 0) || params.reason === 'ambiguous';
    };

    const report = async (event: CdpEvent): Promise<void> => {
      const params = event.params ?? {};
      const reason = String(params.reason ?? '');
      if (reason === 'exception') {
        const detail = params.data as { exception?: { description?: string } } | undefined;
        const text = detail?.exception?.description ?? '抛了异常';
        emit({ type: 'error', text, message: failureMessage(text) });
        return;
      }
      const frame = (params.callFrames as CdpFrame[] | undefined)?.[0];
      if (!frame) return;
      /**
       * 步进了 node 内部文件（`stepInto` 会走进标准库）。那个 `lineNumber` 是**别的文件**的行号，
       * 报上去编辑器就会把 ▶ 画到用户代码的同名行上 —— 所以这里不给行号，只说清在哪。
       */
      if (frame.url && frame.url !== url) {
        emit({
          type: 'stopped',
          func: frame.functionName || undefined,
          reason: 'step',
          locals: [],
          message: `停在你这份文件之外（${frame.url.replace(/^.*\//, '')}）—— 那里没有源码可高亮，按步出回来`,
        });
        return;
      }
      const { vars, dropped } = await readLocals(frame);
      // **实测**：命中断点时 V8 报的 reason 是 `other`，断点 id 在 `hitBreakpoints` 里
      // （不是直觉上的 'breakpoint'）。按 reason 分会把每个断点都标成"单步"。
      const hitBreakpoints = Array.isArray(params.hitBreakpoints) && params.hitBreakpoints.length > 0;
      emit({
        type: 'stopped',
        line: (frame.location?.lineNumber ?? 0) + 1,
        func: frame.functionName || undefined,
        reason: hitBreakpoints ? 'breakpoint' : 'step',
        locals: vars,
        ...(dropped > 0
          ? { message: `局部变量只给前 ${IDE_SESSION_LIMITS.maxLocals} 个，还有 ${dropped} 个没列出` }
          : {}),
      });
    };

    /**
     * 启动序列。`--inspect-brk` 让 VM 停在"等调试器"的状态，而**不发这一条它就一直等**：
     * 实测不发时 `Debugger.paused` 永远不来（连接、两个 enable 都成功，只会刷 scriptParsed）。
     * 所以顺序是固定的：enable → 装断点 → 放行 → 才拿到第一个暂停。
     * 这就是 WI-82 里说的"启动 gate"，只是 node 把"停"与"放行"拆成了两个动作。
     */
    let startup: CdpEvent | null;
    try {
      await call('Runtime.enable');
      await call('Debugger.enable');
      for (const line of breakpoints) {
        await call('Debugger.setBreakpointByUrl', { url, lineNumber: Math.max(0, line - 1), columnNumber: 0 });
      }
      await call('Runtime.runIfWaitingForDebugger');
      startup = (await Promise.race([
        nextPaused(remainingMs()).then((event) => event),
        childExited.then(() => null),
      ])) as CdpEvent | null;
    } catch (err) {
      // 任何一步抛出都要连子进程与沙箱一起收：`--inspect-brk` 在没有调试器接入时会永久挂起，
      // 只删目录不杀进程 = 留一个孤儿 node；只杀进程不删目录 = 攒垃圾
      closeSocket(ws);
      killQuietly(child);
      await cleanup();
      return {
        ok: false,
        event: { type: 'error', text: `调试器没接上：${(err as Error).message}`, message: '没能连上 node 的调试器' },
      };
    }
    if (!startup) {
      // 语法错误：VM 一跑就死，连第一个停点都没有
      closeSocket(ws);
      await cleanup();
      return {
        ok: false,
        event: {
          type: 'error',
          text: stderrText.trim() || 'node 没跑到第一个停点就退出了',
          message: failureMessage(stderrText),
        },
      };
    }
    // 第一个暂停通常只是"VM 等完了"（'Break on start'）—— 那是我们装断点的窗口，不是用户要的停点。
    // 但断点打在程序第一行时它就是真停点（见 isUserStop），所以这里必须分情况。
    if (isUserStop(startup)) await report(startup);
    else void call('Debugger.resume');

    /**
     * 事件泵。**它等的那一条永远不许 reject**：用户停在断点上想几十秒再按继续是正常操作，
     * 而泵是 `void (async () => {...})()` —— 逃出来的一条拒绝没有接盘者，Node 会按
     * unhandled rejection **结束整个进程**（实测：停在断点 30 秒后不动，服务就没了，
     * 界面表现为"所有请求突然全部连不上"）。
     * ⇒ 泵只被" resolve 型"的输入叫醒：下一条停点、子进程没了、调试 socket 断了。
     */
    const socketGone = new Promise<null>((resolve) => {
      ws.addEventListener('close', () => resolve(null));
      ws.addEventListener('error', () => resolve(null));
    });
    void (async () => {
      for (;;) {
        const which = await Promise.race([
          nextPaused().then((event) => ({ event } as const)),
          childExited.then(() => null),
          socketGone,
        ]);
        if (!which) return;
        try {
          await report(which.event);
        } catch {
          // 读变量失败（比如对象已经被回收）也要继续泵，否则整个会话就此失聪
          emit({ type: 'stopped', reason: 'step', locals: [], message: '停住了，但变量没读出来' });
        }
      }
    })();

    const handle: DebugHandle = {
      child,
      send: (action) => {
        void call(STEP_COMMAND[action]);
      },
      requestExit: () => {
        // 只断开调试器：VM 于是继续跑完并自己退出。硬杀由管理器在 stopGraceMs 之后兜底 ——
        // 在这里就 SIGKILL 的话，"让它自己跑完"这句注释永远不会成立。
        closeSocket(ws);
      },
      dispose: async () => {
        closeSocket(ws);
        await cleanup();
      },
    };
    return { ok: true, handle };
  },
};

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 10_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket 连接失败'));
    });
  });
  return ws;
}

/** CONNECTING 状态下 close() 会当场抛（规范如此），而 requestExit 常常就在那一刻被调。 */
function closeSocket(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
  } catch {
    /* 已经关了 */
  }
}

function killQuietly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经不在了 */
  }
}
