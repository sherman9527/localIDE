import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { IDE_SESSION_LIMITS, type DebugStartResponse } from '@arena/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import type { BackendEvent, LaunchResult } from '../../src/ide/debug-backend.js';
import { pythonBackend } from '../../src/ide/debug-python.js';
import { IDE_LANGUAGES, findLanguage } from '../../src/ide/languages.js';
import { ideAvailability } from '../../src/ide/runner.js';
import {
  DEBUG_IDLE_MS,
  DEBUG_MAX_SESSIONS,
  debugSessions,
  startDebug,
  stepDebug,
  stopAllDebug,
  stopDebug,
  sweepIdleDebugSessions,
} from '../../src/ide/debug.js';

/**
 * 网页 IDE 的**行断点**（WI-81，Python 先做）。
 *
 * 这一批验的不是"能起进程"，而是三件只有真调试器才给的东西：
 * ① 停在**我点的那一行**（不是下一行、不是"跑完了"）；
 * ② 停下来时**局部变量读得到值**（读不到必须说读不到，不许给一个看起来像的值）；
 * ③ 单步语义站得住：`next` 不进函数、`stepIn` 进函数。
 * 一个"把代码整段跑完再报结果"的假实现会在 ①②③ 上全红。
 *
 * 与 REPL 同一套纪律：宿主机没有 python3 的用例 skip，全绿要在容器里看；
 * 每条用例自己关会话（会话就是活进程，漏关等于攒孤儿占名额）。
 *
 * **WI-92 定下的形状**："会话没起来"必须报成一句说清**哪一步**没起来的话。
 * 旧写法把 `started.session`（起不来时就是 `null`）交给 `finally { stopDebug(started.session!.id) }`，
 * 于是断言里那句真话（status / message / 输出）被 `TypeError: Cannot read properties of null` 顶掉 ——
 * 红就变成"无法判定的红"：分不清是产品缺功能还是测试自己崩了，而本仓库整套 TDD 靠的就是这个判断。
 * 所以要活会话一律走 `startLiveSession` / `withDebug`：它们带**有界**重试（花的还是调用方本来
 * 就声明了的那份启动预算，不是新加的秒数），并把每一次尝试的原文留在最终消息里。
 * 同一族还有第二条：`两个并发的 start` 与 `afterEach` 都比的是"**沙箱会不会回到基线**"
 * （`waitForSandboxesBackTo`，有界收敛），而不是"第 5 秒那一刻它在不在" —— Windows 的
 * delete-pending 在负载下能让一次正常收尾超过 5s，而"当场比一次"会把这件事说成一次泄漏。
 */

const available = await ideAvailability();
const guarded = (id: string) => (available[id] === true ? it : it.skip);

const lines = (...ls: string[]): string => ls.join('\n');

/**
 * 这一份文件的调试沙箱放进**自己进程**的子目录（`data/judge/test-pid-<pid>`）。
 *
 * 为什么（WI-92 本轮实测撞出来的第三条）：`data/judge` 是宿主与容器共享的挂载点，
 * 而这里的断言形态是"数目录个数"（"调试期间沙箱要比基线多一个"、"收尾要回到基线"），
 * 可调试沙箱的名字是 `debug-` + mkdtemp 的随机后缀 —— **认不出谁家**。
 * 于是同机另一个 `verify:fast`（或 E2E、或浏览器里正开着的一段调试）建一个沙箱，
 * 就能把我这一条弄红：本轮实测到两次，一次 `调试期间沙箱要在：expected 2 to be 1`，
 * 一次 `停在断点上 31 秒` 的 afterEach 等满超时。那不是判题器坏了，是两条门禁在互相误伤，
 * 而 pre-commit 撞上它只能重跑 —— 正是本仓库记过的"会偶发冤红的闸门比没有闸门更坏"。
 * 判题那侧早就遇到过同一件事，办法是"只认自家前缀"（`java-junit` / `spark-scala` / `pyspark`），
 * 这里既然认不出前缀，就按进程分目录。
 * `config` 是 `as const`（编译期只读、运行时没冻结），这一处是**有意的**改道，只影响本 worker，
 * 且只改沙箱根：日志、库、IDE 环境都还在原来那份 `data/` 下。
 */
const SHARED_JUDGE_ROOT = config.judgeWorkDir;
const OWNED_JUDGE_ROOT = join(SHARED_JUDGE_ROOT, `test-pid-${process.pid}`);
(config as { judgeWorkDir: string }).judgeWorkDir = OWNED_JUDGE_ROOT;

/** 调试沙箱与判题沙箱落在同一个目录下，按 tag 前缀认（收尾必须清干净）。 */
async function debugSandboxes(): Promise<string[]> {
  const names = await readdir(config.judgeWorkDir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('debug-')).sort();
}

/**
 * 等**这一条用例自己造的**沙箱消失。
 *
 * 两条都不顺手：① 收尾是异步的（管理器不为删目录卡住响应），所以要比"没有新的"而不是"没了"；
 * ② 不能断言"目录为空" —— 同一份 data/judge 可能正被另一个进程的用调试会话占着
 * （浏览器里开着一段调试就会留一个目录），那与本次测试无关，拿它当基线就是自己给自己造 flaky。
 *
 * **判据是收敛，不是时钟读数**（WI-92 这轮实测撞出来的）：负载下 `rm` 要跟 libuv 线程池
 * （默认 4 条）排队，而产品侧 `workspace.cleanup()` 只重试 ~0.4s、各家 `dispose()` 又都写成
 * `.catch(() => undefined)` —— 删除失败是**静默**的。于是"N 秒还没回到基线"混着两种完全不同的事实：
 * "再等 200ms 就没了"与"永远不会没"。旧写法把两者都写成一句 `调试沙箱没收干净`，
 * 等于把一次排队说成一次泄漏（与本仓库那条"冤红教人重跑"是同一族）。
 * ⇒ 上限放宽到 30s **不是**把红藏深：真漏掉的目录（产品删失败）不会自己消失，那条照样撞红，
 * 而且消息里带上"等了多久、是哪几个"，以及为什么这一次不是排队。
 */
async function waitForSandboxesBackTo(
  baseline: string[],
  opts: { timeoutMs?: number; why?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const seen = new Set(baseline);
  const beganAt = Date.now();
  const deadline = beganAt + timeoutMs;
  for (;;) {
    const now = await debugSandboxes();
    const extras = now.filter((n) => !seen.has(n));
    if (extras.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${opts.why ?? '调试沙箱收尾'}：等了 ${Date.now() - beganAt}ms 仍没回到基线：${extras.join(', ')}\n` +
          '    —— 30s 还不消失就不是"删除在排队"：产品侧删除失败是静默的' +
          '（workspace.cleanup 只重试 ~0.4s，各家 dispose 都 .catch(() => undefined)），' +
          '这一条要往"攒孤儿目录"那边查，不是往测试自己这边查。',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let sandboxBaseline: string[] = [];

beforeEach(async () => {
  sandboxBaseline = await debugSandboxes();
});

afterEach(async () => {
  // 断言失败也要收进程：漏一个会话就等于占死那唯一的名额，
  // 于是后面每一条都变成"rejected"—— 一个失败拖垮一整批，最难查的那种连锁
  await stopAllDebug();
  await waitForSandboxesBackTo(sandboxBaseline);
});

afterAll(async () => {
  // 收掉本进程那份沙箱根（afterEach 已经把里面的会话清掉了）。路径由上面的 join 生成，
  // 只可能是 `data/judge/test-pid-<pid>`，删不到共享沙箱根本身。
  // 真删不掉（Windows 上刚杀完的句柄还没放）就留给服务启动那一次清扫：
  // `sweepStaleWorkspaces` 会把超过一小时的直接子目录收掉，所以这里不判红、也不会静默攒垃圾。
  await rm(OWNED_JUDGE_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

async function withDebug(
  code: string,
  breakpoints: number[],
  body: (id: string) => Promise<void>,
  timeoutMs?: number,
  language = 'python',
): Promise<void> {
  const { id } = await startLiveSession(language, code, breakpoints, timeoutMs);
  try {
    await body(id);
  } finally {
    await stopDebug(id);
  }
}

/**
 * 一次 `startDebug` 里"哪一步没起来"的摘要，按排查顺序排：状态 → 管理器给的话 → 会话名额 → 子进程的字。
 * 输出只留**头部 200 字**：出错时最有用的是那句报错本体（SyntaxError / 找不到 java 都在最前面），
 * 而尾部通常是 node 自己的堆栈 —— 整段灌进失败消息只会把真正那两句挤出人眼。
 */
function startDetail(r: DebugStartResponse): string {
  const out = (r.output ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `status=${r.status}｜message=${r.message ?? '（无）'}｜会话数=${r.sessions}/${r.maxSessions}${out ? `｜输出头部=${out}` : ''}`;
}

function launchDetail(result: Extract<LaunchResult, { ok: false }>): string {
  const { event } = result;
  const text = 'text' in event ? (event.text ?? '').replace(/\s+/g, ' ').slice(0, 200) : event.type;
  const message = 'message' in event ? (event.message ?? '（无）') : '（无）';
  return `event=${event.type}｜message=${message}｜text=${text}`;
}

/**
 * "等到它真起来"的形状：**有界**重试，每次尝试的原文都留在最终消息里。
 *
 * 为什么重试不是把红藏起来（WI-92）：这条等的是**产品契约里本来就允许慢**的那一段
 * （`startDebug` 的第一个停点预算、后端那句"再按一次调试即可"说的就是同一件事）。
 * 三道界一条都不能少：
 * ① 总耐心 = 调用方**本来就声明了**的那份预算，不是新加的秒数（把超时调大才是藏）；
 * ② 尝试次数上限，避免"立刻失败"变成空转；
 * ③ 用完还不行 ⇒ 抛的是**一句说清哪一步没起来**的失败（列出每一次尝试），
 *    所以"永远起不来"的真回归照样红，而且比原来更响。
 * 反过来说，一次都没起来时**绝不用 `session!` 去撞一个 `TypeError`** ——
 * 那是本仓库最贵的一种红：它把真故障盖成测试自身的崩溃，于是"红是因为缺功能还是因为测试自己坏了"
 * 无法判定，而整套 TDD 都靠这句判据。
 */
async function untilReady<T>(
  label: string,
  patienceMs: number,
  maxAttempts: number,
  attempt: () => Promise<{ ok: boolean; value?: T; detail: string }>,
): Promise<T> {
  const beganAt = Date.now();
  const details: string[] = [];
  for (let n = 1; n <= maxAttempts; n += 1) {
    const result = await attempt();
    if (result.ok && result.value !== undefined) return result.value;
    details.push(`第 ${n} 次（+${Date.now() - beganAt}ms）：${result.detail}`);
    if (Date.now() - beganAt >= patienceMs) break;
  }
  throw new Error(
    `${label}：${details.length} 次尝试用完 ${patienceMs}ms 耐心仍没起来\n` +
      details.map((d) => `    ${d}`).join('\n') +
      `\n    —— 这是"起不来"，不是断言失败：按上面每一步的 status/event 定位是 spawn、调试端口还是第一个停点。`,
  );
}

/** 起一个**必须真起来**的会话：拿到的一定是活会话的 id，`finally` 里的收尾因此不可能踩到 null。 */
async function startLiveSession(
  language: string,
  code: string,
  breakpoints: number[],
  timeoutMs?: number,
): Promise<{ id: string; started: DebugStartResponse }> {
  const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : IDE_SESSION_LIMITS.debugStartTimeoutMs;
  return untilReady(
    `调试会话（${language}，断点 ${breakpoints.length ? breakpoints.join(',') : '无'}）`,
    budget,
    3,
    async () => {
      const started = await startDebug(language, code, breakpoints, timeoutMs);
      const session = started.session;
      return session
        ? { ok: true, value: { id: session.id, started }, detail: '' }
        : { ok: false, detail: startDetail(started) };
    },
  );
}

describe('调试注册表', () => {
  it('只有"这台机器真有可行机制、且适配器真写了"的语言声明 debugKind', () => {
    expect(IDE_LANGUAGES.filter((l) => l.debugKind).map((l) => l.id).sort()).toEqual([
      'java', 'javascript', 'python',
    ]);
    for (const id of ['python', 'java', 'javascript'] as const) {
      expect(findLanguage(id)?.debugKind, id).toBeTruthy();
    }
    expect(findLanguage('mysql')?.debugKind, 'SQL 没有可调试的常驻程序').toBeUndefined();
  });

  it('名额与空闲回收与 REPL 共用同一份纪律（改一处两处一起动）', () => {
    expect(DEBUG_MAX_SESSIONS).toBe(1); // 一个编辑器同时只调一个程序
    expect(DEBUG_IDLE_MS).toBe(5 * 60_000);
  });

  /**
   * python 驱动是**另一门语言起的进程**，import 不到 shared 的常量，只能带字面量副本 ——
   * 而这类副本真的漂移过（240 与 200 同时存在，文档写的又是第三个数）。
   * 所以拿文件比对钉住它：改 shared 的那个数时，这条会红着提醒你把驱动一起改。
   */
  it('python 驱动里那两个上限必须就是 shared 的那两个（它 import 不到，只能抄）', async () => {
    const driver = await readFile(new URL('../../src/ide/debug_python.py', import.meta.url), 'utf8');
    for (const [name, limit] of [
      ['VAR_REPR_CHARS', IDE_SESSION_LIMITS.varReprChars],
      ['MAX_LOCALS', IDE_SESSION_LIMITS.maxLocals],
    ] as const) {
      const found = new RegExp(`^${name} = (\\d+)$`, 'm').exec(driver);
      expect(found, `驱动里要有「${name} = 数字」这一行（换了写法就得换判据，别让它溜过闸门）`).toBeTruthy();
      expect(Number(found?.[1]), name).toBe(limit);
    }
  });
});

describe('断点与单步', () => {
  guarded('python')('停在点的那一行，且那一行**还没执行**', async () => {
    const code = lines('x = 40', 'y = x + 2', 'print("tail")');
    const { id, started } = await startLiveSession('python', code, [2]);
    try {
      expect(started.status).toBe('stopped');
      expect(started.line).toBe(2);
      expect(started.reason).toBe('breakpoint');
      const names = (started.locals ?? []).map((v) => v.name);
      expect(names).toContain('x'); // 第 1 行跑完了
      expect(names).not.toContain('y'); // 第 2 行还没跑
    } finally {
      await stopDebug(id);
    }
  });

  guarded('python')('next 不进函数（函数体里的行不许拦），stepIn 才进', async () => {
    const code = lines('def twice(n):', '    return n * 2', '', 'a = twice(21)', 'b = a + 1');
    await withDebug(code, [4], async (id) => {
      const next = await stepDebug(id, 'next');
      expect(next.status).toBe('stopped');
      expect(next.line, 'next 应该跨过函数调用停在下一行').toBe(5);
      expect(next.func).toBe('<module>');
    });
    await withDebug(code, [4], async (id) => {
      const into = await stepDebug(id, 'stepIn');
      expect(into.status).toBe('stopped');
      expect(into.line, 'stepIn 应该进到函数体里那一行').toBe(2);
      expect(into.func).toBe('twice');
    });
  });

  guarded('python')('stepOut 跑完当前函数，停在调用者的下一行', async () => {
    const code = lines('def f():', '    return 1', '', 'x = f()', 'y = 2');
    await withDebug(code, [4], async (id) => {
      expect((await stepDebug(id, 'stepIn')).line).toBe(2); // 先进到函数体里
      const out = await stepDebug(id, 'stepOut');
      expect(out.status).toBe('stopped');
      expect(out.line, '步出应该回到调用它的那一行之后').toBe(5);
      expect(out.func).toBe('<module>');
    });
  });

  guarded('python')('多个断点按执行顺序命中，continue 一路跑到会话结束', async () => {
    const code = lines('a = 1', 'b = 2', 'c = 3');
    await withDebug(code, [1, 3], async (id) => {
      expect((await stepDebug(id, 'continue')).line).toBe(3);
      const done = await stepDebug(id, 'continue');
      expect(done.status).toBe('exited');
      // 会话已经没了：再单步必须说"会话不在了"，而不是转圈或返回上一行的状态
      expect((await stepDebug(id, 'next')).status).toBe('gone');
    });
  });

  guarded('python')('没打断点就是"跑一遍"：状态是 exited，输出照收，会话当场没有', async () => {
    const started = await startDebug('python', lines('print("one")', 'print("two")'), []);
    expect(started.status).toBe('exited');
    expect(started.session, '程序已经跑完，留着会话就是留一个占名额的空进程').toBeNull();
    expect(started.output).toContain('one');
    expect(started.output).toContain('two');
  });

  guarded('python')('越界的断点号：不许假装停得住，跑完就是跑完', async () => {
    const started = await startDebug('python', lines('print(1)'), [999]);
    expect(started.status, '那一行不存在 ⇒ 永远命中不了，只能是跑完').toBe('exited');
    expect(started.session).toBeNull();
  });
});

describe('停下来时能看到什么', () => {
  guarded('python')('print 的输出走独立事件：归到"下一次停"上，且不污染协议', async () => {
    const code = lines('print("before")', 'z = 1', 'print("after")');
    const { id, started } = await startLiveSession('python', code, [2]);
    try {
      // 停在第 2 行 = 第 2 行还没跑，所以第 1 行的 print 已经攒到了，第 3 行的还没有
      expect(started.status).toBe('stopped');
      expect(started.output).toContain('before');
      expect(started.output).not.toContain('after');

      const next = await stepDebug(id, 'next');
      expect(next.line).toBe(3);
      expect(next.output ?? '', '停在第 3 行时那句 print 还没执行').not.toContain('after');

      const done = await stepDebug(id, 'continue');
      expect(done.status).toBe('exited');
      expect(done.output).toContain('after');
    } finally {
      await stopDebug(id);
    }
  });

  guarded('python')('过长的值被截断并标明，而不是把整坨塞进响应', async () => {
    const { id, started } = await startLiveSession('python', lines("s = 'x' * 5000", 't = 1'), [2]);
    const s = started.locals?.find((v) => v.name === 's');
    expect(s, 's 在第 1 行就赋好值了，停在第 2 行时读得到').toBeTruthy();
    // 上限就是 shared 里那一个数。写 400 等于容许"驱动切 240、node 切 200"这种漂移存在
    expect(s!.repr.length).toBeLessThanOrEqual(IDE_SESSION_LIMITS.varReprChars);
    expect(s!.truncated).toBe(true);
    expect(s!.type).toBe('str');
    await stopDebug(id);
  });

  guarded('python')('局部变量里不许混进驱动脚本自己的名字', async () => {
    // 断点打在第三行：停在哪一行的**上一行**才算跑完，第 2 行的 ok 在第 2 行还没执行时读不到
    const { id, started } = await startLiveSession('python', lines('__shadow = 1', 'ok = 2', 'done = 3'), [3]);
    const names = (started.locals ?? []).map((v) => v.name);
    expect(names).toContain('ok');
    expect(names).not.toContain('__shadow');
    for (const name of names) expect(name.startsWith('__'), `${name} 是双下划线名`).toBe(false);
    await stopDebug(id);
  });
});

describe('失败路径', () => {
  guarded('python')('用户代码抛异常：报 error 并带 traceback，会话作废', async () => {
    const code = lines('x = 1', 'raise ValueError("boom")', 'x = 2');
    const { id, started } = await startLiveSession('python', code, [1]);
    expect(started.line).toBe(1);
    const res = await stepDebug(id, 'continue');
    expect(res.status).toBe('error');
    expect(res.output).toContain('ValueError');
    expect(res.output).toContain('boom');
    expect(debugSessions(), '出错之后进程就退了，不能留一个"看起来还能单步"的会话').toEqual([]);
    expect((await stepDebug(id, 'next')).status).toBe('gone');
  });

  guarded('python')('语法错误立刻报错，而不是"跑了但没输出"', async () => {
    const started = await startDebug('python', 'def broken(:\n    pass', [1]);
    expect(started.status).toBe('error');
    expect(started.output).toContain('SyntaxError');
    expect(started.session).toBeNull();
  });

  guarded('python')('卡住（死循环）：超时后会话作废，不把请求挂住', async () => {
    // 断点放在循环**之后**：那一行永远到不了，才会真的等满预算
    const code = lines('import time', 'while True:', '    time.sleep(0.2)', 'x = 1');
    const started = await startDebug('python', code, [4], 1_500);
    expect(started.status).toBe('timeout');
    expect(started.session).toBeNull();
    expect(debugSessions()).toEqual([]);
  });

  it('没有这个会话时单步返回 gone（不 500、不转圈）', async () => {
    const res = await stepDebug('nope', 'next');
    expect(res.status).toBe('gone');
  });

  guarded('python')('这门语言没有调试器：明说，不起进程', async () => {
    const res = await startDebug('markdown', 'x', [1]);
    expect(res.session).toBeNull();
    expect(res.message).toContain('没有');
  });
});

  guarded('java')('两个并发的 start 只许起一个会话（名额是 1，不是"看起来 1"）', async () => {
    // 检查与占位之间只要隔着一次 await，两个请求就都能通过"还剩几个"的判断，
    // 于是真的起两个常驻进程 —— 上限写 1 实际 2。
    // 用 java 来验：它的 launch 里有一次几百毫秒的 javac（窗口最长，最容易撞上）；
    // 也因此在宿主机上跑得到 —— 只挂在 python 上的话，宿主那条路就永远是 skip。
    const [a, b] = await Promise.all([
      startDebug('java', JAVA_SOURCE, [9]),
      startDebug('java', JAVA_SOURCE, [10]),
    ]);
    const ok = [a, b].filter((r) => r.session !== null);
    // **这一条必须与"两个都起来了"分开报**（WI-92）：这一族的红是"一个都没起来"（javac/ JVM 起太慢），
    // 而旧写法只有一条 `toHaveLength(1)`，于是机器忙时的"起不来"会被读成"上限形同虚设"——
    // 一句假话指向一段根本没坏的产品代码。
    if (ok.length === 0) {
      throw new Error(
        `两个并发 start 一个会话都没起来（这不是名额问题，是起不来）：\n` +
          `    A ${startDetail(a)}\n` +
          `    B ${startDetail(b)}\n` +
          `    —— 上面必须有且只有一路是 status=stopped；两路都是 error/rejected 就按各自的 message 定位。`,
      );
    }
    expect(ok, '两个都起来了：上限形同虚设').toHaveLength(1);
    expect(debugSessions()).toHaveLength(1);
    await stopAllDebug();
    // 这里原来是**当场** `expect(await debugSandboxes()).toEqual(sandboxBaseline)`：
    // 刚被杀掉的会话在 Windows 上常处于"删除已受理、句柄还没释放"的 delete-pending 状态，
    // 于是同一句断言会在负载下随机红 —— 而红的消息指向"被拒的那一路留了沙箱"这句根本没发生的事。
    // 换成同一把收敛判据（有界等待）：真留下孤儿目录照样撞红，只是不再把排队说成泄漏。
    await waitForSandboxesBackTo(sandboxBaseline, { why: '被拒的那一路不许留下沙箱' });
  });

describe('名额与回收', () => {
  guarded('python')('同时只许一个调试会话（一个编辑器只调一个程序）', async () => {
    const { id: firstId } = await startLiveSession('python', 'x = 1', [1]);
    const second = await startDebug('python', 'y = 1', [1]);
    expect(second.session).toBeNull();
    expect(second.message).toContain('上限');
    expect(debugSessions()).toHaveLength(1);
    await stopDebug(firstId);
    expect(debugSessions()).toHaveLength(0);
  });

  guarded('python')('没到点的杀不掉，过点的杀掉（两条分开断，否则阈值改成 0 也全绿）', async () => {
    const { id } = await startLiveSession('python', 'x = 1', [1]);
    expect(await sweepIdleDebugSessions(Date.now(), DEBUG_IDLE_MS)).toEqual([]);
    expect(debugSessions().find((s) => s.id === id)).toBeTruthy();

    expect(await sweepIdleDebugSessions(Date.now() + DEBUG_IDLE_MS + 1_000, DEBUG_IDLE_MS)).toEqual([id]);
    expect(debugSessions()).toEqual([]);
  });

  guarded('python')('正在等单步结果的那条不许被回收杀掉', async () => {
    // 停在第 2 行 → continue 会跑那段 sleep：这几秒里会话既"空闲超时"又"正在忙"
    const { id } = await startLiveSession('python', lines('import time', 'time.sleep(2)', 'y = 1'), [2]);
    const pending = stepDebug(id, 'continue');
    expect(await sweepIdleDebugSessions(Date.now() + DEBUG_IDLE_MS * 2, DEBUG_IDLE_MS)).toEqual([]);
    expect(debugSessions().find((s) => s.id === id)).toBeTruthy();
    expect((await pending).status).toBe('exited');
  });

  guarded('python')('前一条把会话弄死之后，排在队里的第二条要**当场**给 gone（不许等满单步预算）', async () => {
    // 现场是"用户在界面上连点两下继续"：两条都在会话还活着时排进队列，
    // 第一条跑到底把会话作废（`sessions` 里已删），第二条轮到时只剩一个死对象。
    // 少了队列里那句"死了就当场回答"，它会去等一个永不到来的停点，
    // 而它的超时结算又被 `finish` 的 dead 守卫挡掉 ⇒ 这条 promise 永不落地，
    // 队列是 Promise 链，后面每一条一起卡死（界面上就是"永远转圈"）。
    const { id, started } = await startLiveSession('python', lines('a = 1', 'b = 2'), [1]);
    expect(started.line).toBe(1);
    const at = Date.now();
    const [first, second] = await Promise.all([stepDebug(id, 'continue'), stepDebug(id, 'continue')]);
    const waited = Date.now() - at;
    expect(first.status).toBe('exited');
    expect(second.status).toBe('gone');
    expect(waited, `第二条把整条队列钉住了 ${waited}ms，而单步预算是 ${IDE_SESSION_LIMITS.stepTimeoutMs}ms`)
      .toBeLessThan(IDE_SESSION_LIMITS.stepTimeoutMs / 2);
  });

  guarded('python')('stopAll 把活着的会话收干净（服务收尾不许留孤儿进程）', async () => {
    const { id } = await startLiveSession('python', 'x = 1', [1]);
    expect(debugSessions().map((s) => s.id)).toEqual([id]);
    await stopAllDebug();
    expect(debugSessions()).toEqual([]);
  });
});

describe('后端接缝本身', () => {
  /**
   * 管理器有"会话死了就当场回答"的守卫，但**判定与真正 write 之间仍有窗口**：
   * 子进程恰好在那几微秒里退出。`child.stdin.write` 的失败是**异步**的
   * （`ERR_STREAM_WRITE_AFTER_END`），而 'error' 事件没人听就等于在事件循环里抛成 uncaughtException
   * ⇒ 崩的是整个服务，不是这一个请求。这条用例直接对着后端打，绕过管理器的守卫。
   */
  guarded('python')('写进一个刚退出的调试进程：要变成一条 error 事件，不是把服务崩掉', async () => {
    let events: BackendEvent[] = [];
    // 这一条绕开管理器直接打后端，所以"后端起不来"在这里同样是真的会发生的（容器档实测过一次），
    // 而旧写法抛的是一句 `后端起不来，这条用例没有意义` —— 它既没说是哪一步起不来，
    // 也没把后端自己给的那句话带出来，读的人只能重跑碰运气。现在走同一条"有界重试 + 原文上报"。
    const handle = await untilReady(
      'python 调试后端（直接 launch，不经管理器）',
      IDE_SESSION_LIMITS.debugStartTimeoutMs,
      3,
      async () => {
        events = [];
        const result = await pythonBackend.launch({
          code: lines('x = 1'),
          breakpoints: [],
          startupBudgetMs: IDE_SESSION_LIMITS.debugStartTimeoutMs,
          emit: (event) => {
            events.push(event);
          },
        });
        return result.ok
          ? { ok: true, value: result.handle, detail: '' }
          : { ok: false, detail: launchDetail(result) };
      },
    );
    // 没有断点 ⇒ 驱动跑完就自己结束。等一下让它真的没了（这条测的是"写进死管道"）
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(events.some((e) => e.type === 'exited')).toBe(true);

    // 关掉会话时会给 stdin 收尾（`end()`）—— **那之后再写**就是 `ERR_STREAM_WRITE_AFTER_END` 的现场。
    // 管理器那条"死了就当场回答"只挡住排到队尾的命令，挡不住判定与 write 之间那几微秒的竞态。
    handle.requestExit();
    expect(() => handle.send('next')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      events.some((e) => e.type === 'error'),
      '写失败必须变成一条可结算的事件，否则调用方只能等满超时（界面上就是永远转圈）',
    ).toBe(true);
    await handle.dispose();
  });
});

// 行号是这套用例的主角，所以源码按 1 起写清楚：
// 1 function twice(value) {   2   const doubled = value * 2;   3   return doubled;   4 }
// 6 const total = 40;   7 const answer = total + 2;   8 console.log(answer)   9 console.log(twice)   10 console.log(done)
const JS_SOURCE = lines(
  'function twice(value) {',
  '  const doubled = value * 2;',
  '  return doubled;',
  '}',
  '',
  'const total = 40;',
  'const answer = total + 2;',
  'console.log("answer=" + answer);',
  'console.log("twice=" + twice(answer));',
  'console.log("done");',
);

describe('JavaScript 行断点（CDP）', () => {
  guarded('javascript')('停在第 7 行：第 6 行的 total 读得到，第 7 行的 answer 还没有', async () => {
    const { id, started } = await startLiveSession('javascript', JS_SOURCE, [7], 30_000);
    try {
      expect(started.status, started.output ?? started.message).toBe('stopped');
      expect(started.line).toBe(7);
      expect(started.reason).toBe('breakpoint');
      const names = (started.locals ?? []).map((v) => v.name);
      expect(names).toContain('total');
      expect(started.locals?.find((v) => v.name === 'total')?.repr).toBe('40');
      // CDP 给类型（value.type / subtype），jdb 不给 —— 各说各的真话，不统一编一个
      expect(started.locals?.find((v) => v.name === 'total')?.type).toBe('number');
      // JS 与另两家不同：`const answer` 的名字**已经在这个作用域里**（只是还没赋值，TDZ），
      // 所以不能像 python 那样"看不见"，但也不能显示成 undefined —— 那是两回事
      const answer = started.locals?.find((v) => v.name === 'answer');
      expect(answer?.repr).toBe('<声明了，还没赋值>');
      expect(answer?.type).toBe('uninitialized');
    } finally {
      await stopDebug(id);
    }
  });

  guarded('javascript')('断点打在程序**第一行**也要停（V8 那里报的是 ambiguous，不是 breakpoint）', async () => {
    // 启动时那个"Break on start"暂停不能无条件丢掉：断点在第一行时，
    // V8 把用户断点与启动暂停合并成 reason 'ambiguous' + hitBreakpoints，
    // 直接 resume 就等于这一行永远不停（python / jdb 都会停，三家行为必须一致）
    const { id, started } = await startLiveSession(
      'javascript',
      lines('const first = 1;', 'console.log(first);'),
      [1],
      30_000,
    );
    try {
      expect(started.status, started.output ?? started.message).toBe('stopped');
      expect(started.line).toBe(1);
      expect(started.reason).toBe('breakpoint');
      expect(started.locals?.find((v) => v.name === 'first')?.repr).toBe('<声明了，还没赋值>');
    } finally {
      await stopDebug(id);
    }
  });

  guarded('javascript')('next 不进函数、stepIn 进函数、stepOut 回到调用者', async () => {
    await withDebug(
      JS_SOURCE,
      [8],
      async (id) => {
        const over = await stepDebug(id, 'next');
        expect(over.status).toBe('stopped');
        expect(over.line, 'next 该停在第 9 行，而不是停进 twice() 里').toBe(9);

        const into = await stepDebug(id, 'stepIn');
        expect(into.status).toBe('stopped');
        expect(into.line, '步入该进到函数体第一行').toBe(2);
        expect(into.func).toBe('twice');
        expect(into.locals?.find((v) => v.name === 'value')?.repr).toBe('42');

        const out = await stepDebug(id, 'stepOut');
        expect(out.status).toBe('stopped');
        // 步出停在**调用它的那一行**（V8 的 stepOut 语义），不是它的下一行 ——
        // 与 java 那侧一致：jdb 的 `step up` 也是回到调用行。别写成"下一行"骗自己。
        expect(out.line).toBe(9);
        expect(out.func ?? '').not.toBe('twice');
      },
      30_000,
      'javascript',
    );
  });

  guarded('javascript')('continue 跑到结束：状态是 exited，stdout 照收', async () => {
    await withDebug(
      JS_SOURCE,
      [7],
      async (id) => {
        const done = await stepDebug(id, 'continue');
        expect(done.status).toBe('exited');
        expect(done.output).toContain('answer=42');
        expect(done.output).toContain('twice=84');
        // node 把"调试器接上了"写在 stderr 上。它不是用户程序的输出，而 stderr 现在会进输出
        // （为了让 `console.error` 看得见）—— 不加过滤，这两句每次调试都会出现在界面上。
        expect(done.output).not.toMatch(/Debugger attached|Waiting for the debugger/);
      },
      30_000,
      'javascript',
    );
  });

  /**
   * 停在断点上"什么都不做"超过泵那一等，服务必须还活着。
   *
   * 这是一条**服务器会被带走**的回归：泵是 `void (async () => {...})()`，旧实现里它每轮等 30s，
   * 用户只要在断点上停顿半分钟，那条等待就 reject、拒绝没人接 ⇒ Node 按 unhandled rejection
   * 结束进程。界面表现是"所有请求突然全部连不上"，而日志里只有一句"等不到下一个停点"。
   * 修法不是把 30s 调大，而是让泵那一等**永远不会 reject**（唤醒路只有停点 / 子进程退出 / socket 断开）。
   */
  guarded('javascript')(
    '停在断点上 31 秒不按任何键：服务不许被一条没人接的拒绝带走（泵那一等过去是 30s）',
    async () => {
      const { id, started } = await startLiveSession('javascript', JS_SOURCE, [6], 30_000);
      expect(started.status, started.output ?? started.message).toBe('stopped');
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const next = await stepDebug(id, 'next');
      expect(next.status, `空闲 31s 之后单步已经问不到了（${next.message ?? next.status}）—— 泵被一条超时带走`).toBe('stopped');
      expect(debugSessions().map((s) => s.id)).toContain(id);
      await stopDebug(id);
    },
    70_000,
  );

  guarded('javascript')('用户自己打到 stderr 的字要看得见（过滤噪音不许顺手把它一起滤掉）', async () => {
    const code = lines("console.error('bad-news');", "console.log('fine');");
    const started = await startDebug('javascript', code, [], 30_000);
    expect(started.status, started.message).toBe('exited');
    expect(started.output).toContain('bad-news');
    expect(started.output).toContain('fine');
    expect(debugSessions()).toEqual([]);
  });

  guarded('javascript')('语法错误：node 起不来就报 error，别留一个转圈的会话', async () => {
    const started = await startDebug('javascript', 'const broken = ;\n', [1], 30_000);
    expect(started.status).toBe('error');
    expect(started.session).toBeNull();
    expect(started.output).toMatch(/SyntaxError/);
    expect(debugSessions()).toEqual([]);
  });

  guarded('javascript')('未捕获异常：报 error 并带异常名', async () => {
    const code = lines('const ready = 1;', 'throw new RangeError("nope");');
    const { id, started } = await startLiveSession('javascript', code, [1], 30_000);
    expect(started.status).toBe('stopped');
    const res = await stepDebug(id, 'continue');
    expect(res.status, res.output ?? res.message).toBe('error');
    expect(res.output).toContain('RangeError');
    expect(debugSessions()).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   Java：驱动 jdb。格式是**实测出来的**（见 memo 里程碑 AU）：
     Breakpoint hit: "thread=main", Main.main(), line=9 bci=3
     Step completed: "thread=main", Main.twice(), line=3 bci=0
     The application exited
     locals → "Method arguments:" / "Local variables:" 两节，每行 `名字 = 值`
   两个坑：① `javac` 不带 `-g` 时 jdb 明说"Local variable information not
   available"，所以调试那份必须自己带 `-g` 编；② jdb 的 `locals` **不给类型**，
   所以 DebugVar.type 只能留空 —— 编一个类型上去就是骗人。
   -------------------------------------------------------------------------- */
// 变量名**故意全用多字符**：jdb 的 `locals` 行是 `int total = 40` 这种形状，
// 解析时类型前缀一旦写得能吃掉名字，`args` 就会变成 `s` —— 单字符名看不出这种错位
// （真在浏览器里翻过一次，当时的用例里全是 x / y）
const JAVA_SOURCE = lines(
  'public class Main {',
  '    static int twice(int value) {',
  '        int doubled = value * 2;',
  '        return doubled;',
  '    }',
  '',
  '    public static void main(String[] args) {',
  '        int total = 40;',
  '        int answer = total + 2;',
  '        System.out.println("sum=" + twice(answer));',
  '    }',
  '}',
);

describe('Java 行断点（jdb）', () => {
  guarded('java')('停在第 9 行：第 8 行的 x 读得到，第 9 行的 y 还没有', async () => {
    const { id, started } = await startLiveSession('java', JAVA_SOURCE, [9]);
    try {
      expect(started.status, started.output ?? started.message).toBe('stopped');
      expect(started.line).toBe(9);
      expect(started.reason).toBe('breakpoint');
      const names = (started.locals ?? []).map((v) => v.name);
      expect(names).toContain('total');
      expect(names).not.toContain('answer');
      expect(started.locals?.find((v) => v.name === 'total')?.repr).toBe('40');
      // 方法参数也在 locals 里，名字必须完整（错位时会剩个 's'）
      expect(names).toContain('args');
    } finally {
      await stopDebug(id);
    }
  });

  guarded('java')('step over 不进函数，step 才进；continue 跑到结束并收到 stdout', async () => {
    await withDebug(JAVA_SOURCE, [9], async (id) => {
      const over = await stepDebug(id, 'next');
      expect(over.status).toBe('stopped');
      expect(over.line, 'next 该停在第 10 行，而不是跳进 twice() 里').toBe(10);

      const into = await stepDebug(id, 'stepIn');
      expect(into.line, 'step 该进到 twice() 的函数体里').toBe(3);
      expect(into.reason).toBe('step');
      // 函数入参的名字要完整、值要对；jdb 的 locals 不给类型，宁可空着也不按值猜 int/long
      const value = into.locals?.find((v) => v.name === 'value');
      expect(value, `locals 给的是 ${JSON.stringify(into.locals?.map((v) => v.name))}`).toBeTruthy();
      expect(value?.repr).toBe('42');
      expect(value?.type ?? '').toBe('');
      expect(into.locals?.map((v) => v.name)).not.toContain('doubled');

      const done = await stepDebug(id, 'continue');
      expect(done.status).toBe('exited');
      expect(done.output).toContain('sum=84');
    }, undefined, 'java');
  });

  guarded('java')('同一份 Main.java 里的辅助类也算"你的代码"（要给行号）', async () => {
    // jdb 报的是 `Point.move()` 这种没有包名的类；只有 java.* / jdk.* 才是库。
    // 把前者判成"Main.java 之外"就会谎称"没有源码可高亮"，而它就在编辑器里。
    const code = lines(
      'class Point {',
      '    int x = 1;',
      '    int bump() {',
      '        x = x + 1;',
      '        return x;',
      '    }',
      '}',
      '',
      'public class Main {',
      '    public static void main(String[] args) {',
      '        Point p = new Point();',
      '        System.out.println(p.bump());',
      '    }',
      '}',
    );
    await withDebug(
      code,
      [12],
      async (id) => {
        const into = await stepDebug(id, 'stepIn');
        expect(into.status).toBe('stopped');
        expect(into.func, `实际停在 ${JSON.stringify(into)}`).toContain('bump');
        expect(into.line, 'Point 与 Main 在同一份 Main.java 里，行号必须给').toBe(4);
        expect(into.message ?? '').not.toContain('之外');
      },
      undefined,
      'java',
    );
  });

  guarded('java')('编译不过：报 error 并带 javac 的话，不起会话', async () => {
    const started = await startDebug('java', 'public class Main { void main( }\n', [1]);
    expect(started.status).toBe('error');
    expect(started.session).toBeNull();
    expect(started.output).toMatch(/error|错误/);
  });

  guarded('java')('未捕获异常：报 error 并带异常信息，会话作废', async () => {
    const code = lines(
      'public class Main {',
      '    public static void main(String[] args) {',
      '        int x = 1;',
      '        throw new IllegalStateException("boom");',
      '    }',
      '}',
    );
    const { id, started } = await startLiveSession('java', code, [3]);
    expect(started.status).toBe('stopped');
    const res = await stepDebug(id, 'continue');
    expect(res.status, res.output ?? res.message).toBe('error');
    expect(res.output).toContain('IllegalStateException');
    expect(debugSessions()).toEqual([]);
  });

  guarded('java')('会话结束必须把沙箱目录收掉（每次调试都留一份 .class 是攒垃圾）', async () => {
    const { id, started } = await startLiveSession('java', JAVA_SOURCE, [9]);
    expect(started.status).toBe('stopped');
    expect(
      (await debugSandboxes()).length,
      '调试期间沙箱要在（.class 与源码都放那儿）',
    ).toBe(sandboxBaseline.length + 1);
    await stopDebug(id);
    await waitForSandboxesBackTo(sandboxBaseline);
  });
});
