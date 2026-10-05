import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { NotebookStatusResponse } from '@arena/shared';
import { config } from '../../src/config.js';
import { notebookStatus } from '../../src/notebooks/status.js';

/**
 * 评审 M8：把"日志里不许出现 token"从**源码正则**换成**行为判据**。
 * 原来那两条 `expect(src).not.toMatch(/logInfo\([^)]*token/)` 挡不住真正的泄漏写法 ——
 * `logInfo('notebook','status',{ url })` 里既没有 "token" 这个词、而 url 的 query 里就躺着 token，
 * 正则一片绿，日志里全是可复制的凭据。现在改判"调用发生过什么"：把日志出口与 console 全接成替身，
 * 用一个 canary 当 token 跑遍各条分支，任何一次日志调用里都不许出现它。
 * 这里 mock 掉整个 `log.js`（其余导出保留真实现），是为了让"将来谁在这儿加一行 logInfo"落在判据里。
 */
const logSpy = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock('../../src/log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/log.js')>()),
  ...logSpy,
}));

/** 把一次调用的实参压成可搜索的文本：字符串原样、对象走 inspect（JSON.stringify 会把 URL 实例压成 {}）。 */
function argsText(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6, breakLength: 10_000 }))).join(' ');
}

const fake = () =>
  vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => ({ default: 'python', kernels: { 'arena-pyspark': { name: 'arena-pyspark', spec: { display_name: 'PySpark (arena)' } } } }) }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }) as unknown as typeof fetch;

/** /api/status 直接回一个状态码（kernelspecs 不会被问到，因为第一个请求就早退了）。 */
const statusDeny = (status = 403) =>
  (vi.fn(async () => ({ status, json: async () => ({}) }) as unknown) as typeof fetch);

/** 只有 /api/kernelspecs 坏掉：状态码非 200，body 是 HTML（json() 必抛 SyntaxError）。 */
const kernelspecsBoom = (status: number) =>
  (vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }
  ) as unknown as typeof fetch);

const refuses = (message: string) =>
  (vi.fn(async () => {
    throw new Error(message);
  }) as unknown) as typeof fetch;

// 每条用例都显式给 tokenOverride：宿主上 config.notebook.token 是空的（compose 才设它），
// 不显式覆盖的话第 1 条会在"没配 token 就 running:false"那条早退分支上红 —— 那是环境差，不是实现错。
const TOK = { tokenOverride: 'test-token' };

/**
 * 在"ARENA_JUPYTER_TOKEN 这个**键**存在与否"受控的情况下跑一条断言。
 * 为什么要控制键而不是值：compose 给 arena/tools 的是 `${ARENA_JUPYTER_TOKEN:-}` 插值，
 * 于是那两个容器里"键在、值为空"= token 从没生成；dev/e2e 连键都没有（notebook-compose ⑥ 钉的形状）
 * = 这个实例按设计不参与 notebook。config 把两者都读成空串，所以只能就地管这个键。
 * 存亡都要还原 —— 别的用例（和别的测试文件）看到的是进来的那份环境。
 */
async function withTokenKey(value: string | undefined, run: () => Promise<NotebookStatusResponse>): Promise<NotebookStatusResponse> {
  const key = 'ARENA_JUPYTER_TOKEN';
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

describe('notebookStatus', () => {
  it('服务在跑：running + 带 token 的本机地址 + kernel 就绪', async () => {
    const res = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), ...TOK });
    expect(res.running).toBe(true);
    // 期望值从 config 派生（评审 M9）：原来这里写死 `http://127.0.0.1:7789`，
    // 于是"宿主端口换个号"会同时改掉 compose 与 config 而这条测试独自红 —— 那是冤红，
    // 冤红教给下一个人的是"改测试里的数字"，而不是"看谁真的漂移了"。
    expect(res.url).toBe(`${config.notebook.publicUrl}/tree?token=test-token`);
    expect(res.kernels).toEqual([{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }]);
  });

  it('探不到 ⇒ running:false，且 reason 能区分"没起"与"超时"（修的是不同东西）', async () => {
    const res = await notebookStatus({
      hostHeader: '127.0.0.1:7788',
      ...TOK,
      fetchImpl: (vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown) as typeof fetch,
    });
    expect(res.running).toBe(false);
    expect(res.reason).toContain('ECONNREFUSED');
    expect(res.kernels).toEqual([]);
  });

  it('非回环来源拿不到 token（链接照给，token 不外泄）', async () => {
    const res = await notebookStatus({ hostHeader: '192.168.1.20:7788', fetchImpl: fake(), ...TOK });
    expect(res.url).toBeDefined();
    expect(res.url).not.toContain('token=');
  });

  /**
   * 评审 M7（钉上新加的那两支，否则"补了 IPv6"只是注释里的一句话）：
   * IPv6 本机有两种写法 —— Host 头带方括号 `[::1]:7788`，或裸 `::1`。
   * 漏认的后果是 fail-closed（本机也得自己粘 token，那次摩擦正是这条链接要消灭的），
   * 而反过来把局域网地址认成回环才是泄漏 —— 所以两边都要断言，不能只断一边。
   */
  it('回环的认法覆盖 IPv6 两种写法，且局域网/域名照样被挡在外面', async () => {
    for (const host of ['::1', '[::1]:7788', 'localhost:7788', '127.0.0.1']) {
      const res = await notebookStatus({ hostHeader: host, fetchImpl: fake(), ...TOK });
      expect(res.url, `${host} 是本机 ⇒ 不给 token 就得让用户手贴`).toContain('token=test-token');
    }
    for (const host of ['192.168.1.20:7788', '::ffff:192.168.1.20', 'arena.example.com:7788']) {
      const res = await notebookStatus({ hostHeader: host, fetchImpl: fake(), ...TOK });
      expect(res.url, `${host} 不是回环 ⇒ token 不许出现在响应里`).not.toContain('token=');
    }
  });

  it('超时与"没起"给的 reason 必须不同（同一个 reason 会让人去查错的地方）', async () => {
    const res = await notebookStatus({
      hostHeader: '127.0.0.1:7788',
      ...TOK,
      fetchImpl: (vi.fn(async () => {
        throw new Error('This operation was aborted');
      }) as unknown) as typeof fetch,
    });
    expect(res.reason).toMatch(/超时/);
  });

  it('没配 token 时如实报，不假装能用', async () => {
    const res = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: '' });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
  });

  /**
   * 评审 I-2：`status.ts` 里"HTTP 状态码不是 200"那一支原先**没有任何假 fetch 会走到** ——
   * 五条用例全返回 200。后果是把那个分支删掉、或者干脆在 403 上也回 `running:true`，
   * 十二 tests 照样绿；而后者正是 token 重新生成之后的形状：旧 token 换来一句 403，
   * 界面写"kernel 就绪"，其实一次鉴权都没过。403 的文案还必须点名 token，
   * 因为"服务在跑但不认识我"是唯一一句读者能直接行动的失败。
   */
  it('Jupyter 答 403 ⇒ running:false，且明说 token 不匹配（不许读成"kernel 就绪"）', async () => {
    const res = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: statusDeny(), ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/403/);
    expect(res.reason, '只说"返回 403" ⇒ 读者不知道该去重新拿 token 还是去重启服务').toMatch(/token 不匹配/);
    expect(res.kernels).toEqual([]);
    expect(res.url, '鉴权都没过还发一条能点开的链接 ⇒ 前端把它渲染成"就绪"，正是这句谎').toBeUndefined();
  });

  /**
   * 评审 I-3：`/api/kernelspecs` 原来不判状态码就直接 `.json()`，两种坏法都没人管：
   * ① HTML body ⇒ json() 抛 SyntaxError ⇒ 被下面那个 catch 说成"Jupyter 未在监听"
   *    （它在监听，是它答得不像话），于是读者去重启一个正在好好干的服务；
   * ② body 恰好可解析成 JSON ⇒ `running:true, kernels:[]` 且没有 reason，界面一片空白。
   * 判据形状照 /api/status 那条，而且**共用同一个 reason builder** —— 所以这里还断言
   * "403 发生在哪个端点上，说出来的话一字不差"，否则两条文案各漂移一份没人知道。
   */
  it('kernelspecs 的回话同样判状态码：500 的 HTML body 不许被说成"未在监听"', async () => {
    const res = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: kernelspecsBoom(500), ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toBe('Jupyter 返回 500');
    expect(res.reason, '把 HTTP 状态说成"未在监听" ⇒ 让人去查一个正在答话的服务').not.toMatch(/未在监听|Unexpected|SyntaxError/);
    expect(res.kernels).toEqual([]);

    const ks403 = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: kernelspecsBoom(403), ...TOK });
    const st403 = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: statusDeny(403), ...TOK });
    expect(ks403.reason, '两个端点各写一份 403 的文案 ⇒ 将来只改一处，读者看到的两句话不一样').toBe(st403.reason);
  });

  /**
   * 评审 I-2 的另一半："`running:false` ⇒ `reason` 非空"是 `shared/src/notebook.ts` 里写死的契约，
   * 但每条用例只判自己那一句文案，谁都没判"有没有人 return 了一句空话"。
   * 这条是不变式：把所有失败形状过一遍，空/空白 reason 一律红。
   * 空 reason 的症状就是本项目反复付过代价的那类静默降级 —— 界面上只剩"不可用"三个字，没有为什么。
   */
  it('每一条 running:false 都带一句非空的 reason（不变式，逐条覆盖失败形状）', async () => {
    const probes: Array<[string, () => Promise<NotebookStatusResponse>]> = [
      ['没给 token', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: '' })],
      ['token 键存在但为空', () => withTokenKey('', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: '' }))],
      ['连不上（ECONNREFUSED）', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: refuses('connect ECONNREFUSED 127.0.0.1:8888'), ...TOK })],
      ['探活超时', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: refuses('The operation was aborted due to timeout'), ...TOK })],
      ['/api/status 403', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: statusDeny(403), ...TOK })],
      ['/api/status 500', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: statusDeny(500), ...TOK })],
      ['kernelspecs 500 + HTML body', () => notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: kernelspecsBoom(500), ...TOK })],
    ];
    const ran: Array<{ label: string; res: NotebookStatusResponse }> = [];
    for (const [label, probe] of probes) ran.push({ label, res: await probe() });
    const failed = ran.filter((x) => x.res.running === false);
    expect(failed.length, '一条失败形状都没跑出来 ⇒ 这条不变式在空转').toBeGreaterThanOrEqual(6);
    for (const { label, res } of failed) {
      expect(typeof res.reason, `${label}：running:false 却没有 reason 字段（契约写在 NotebookStatusResponse 上）`).toBe('string');
      expect((res.reason ?? '').trim(), `${label}：running:false 的 reason 是空的 ⇒ 前端只能显示"不可用"，没有为什么`).not.toBe('');
    }
  });

  /**
   * 评审 M5：`new URL(config.notebook.publicUrl + '/tree')` 原先在 try **外面**。
   * publicUrl 是 env 可覆盖的（ARENA_NOTEBOOK_PUBLIC_URL），一个坏值会让整个函数 reject，
   * 而 Task 8 把它挂在 GET 路由上 ⇒ 前端拿到 500，500 里没有 reason 可读，
   * 那句"kernel 就绪"整块消失 —— 症状与"Jupyter 真坏了"一模一样。
   * 这条判三点：不 reject、不把"在跑"改口成"没在跑"、链接缺失时点名坏掉的那一行 env。
   */
  it('publicUrl 是坏值时不许 reject：给不出链接，但要给得出原因', async () => {
    const saved = process.env.ARENA_NOTEBOOK_PUBLIC_URL;
    process.env.ARENA_NOTEBOOK_PUBLIC_URL = 'not a url';
    vi.resetModules();
    let res: NotebookStatusResponse;
    try {
      const mod = await import('../../src/notebooks/status.js');
      res = await mod.notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), ...TOK });
    } finally {
      if (saved === undefined) delete process.env.ARENA_NOTEBOOK_PUBLIC_URL;
      else process.env.ARENA_NOTEBOOK_PUBLIC_URL = saved;
      vi.resetModules();
    }
    expect(res.running, '链接拼不出来 ≠ Jupyter 没在跑 ⇒ 这里必须仍是 true').toBe(true);
    expect(res.kernels).toHaveLength(1);
    expect(res.url).toBeUndefined();
    expect(res.reason).toMatch(/ARENA_NOTEBOOK_PUBLIC_URL/);
  });

  it('token 不进日志（它出现在本机 URL 里是点开用的，进日志就留痕了）', async () => {
    const CANARY = 'canary-4f2e9b71';
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const collect = () =>
      [
        ...Object.values(logSpy).flatMap((fn) => fn.mock.calls.map(argsText)),
        ...consoleSpies.flatMap((s) => s.mock.calls.map((c) => argsText(c as unknown[]))),
      ].join('\n');
    try {
      // 三条分支各走一遍：成功（url 里就躺着 token）、非回环（url 给但不带 token）、失败（reason 可能拼进 url）
      await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: CANARY });
      await notebookStatus({ hostHeader: '192.168.1.20:7788', fetchImpl: fake(), tokenOverride: CANARY });
      await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: refuses('connect ECONNREFUSED'), tokenOverride: CANARY });
      const seen = collect();
      expect(seen, `有日志调用把 token 打印出来了 ⇒ 它会留在 data/logs 里，删不掉历史：\n${seen}`).not.toContain(CANARY);
      // 判据自己也要被判（否则"什么都没收集到"也看起来像成功）：
      // 故意泄漏一次，收集器必须当场看得见那个 canary。
      logSpy.logInfo('notebook', 'selfcheck', { url: `http://127.0.0.1:7789/tree?token=${CANARY}` });
      expect(collect(), '收集器看不见 logInfo 的字段 ⇒ 上面那条断言是在空转').toContain(CANARY);
    } finally {
      for (const s of consoleSpies) s.mockRestore();
      for (const fn of Object.values(logSpy)) fn.mockClear();
    }
  });

  /**
   * 上面第 5 条只管"要点名 ARENA_JUPYTER_TOKEN"，管不出**该不该去修**。
   * 评审在 Task 3+4 抓到的就是这一句双重误导：dev 里 entrypoint 说"缺 ARENA_JUPYTER_TOKEN"，
   * 可 token 其实就在 .env 里、用户也确实走了 ./start.sh —— 他照着提示修一遍，什么都没坏可修。
   * 所以"这个实例刻意不给"（compose 只给 arena/tools 透传）与"从没生成"必须是两条不同的话，
   * 且只有后者带修复指令。
   */
  it('token 缺席分两种成因：刻意不给（dev/e2e）不许读起来像故障，从没生成才给修复指令', async () => {
    const noKey = await withTokenKey(undefined, () =>
      notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: '' }),
    );
    const emptyKey = await withTokenKey('', () =>
      notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: fake(), tokenOverride: '' }),
    );
    expect(noKey.running).toBe(false);
    expect(emptyKey.running).toBe(false);
    expect(noKey.reason).not.toBe(emptyKey.reason);
    // 两条都得点名那个变量，否则读者不知道自己该看哪一行配置
    expect(noKey.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
    expect(emptyKey.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
    // 只有"从没生成"给修复指令
    expect(emptyKey.reason).toMatch(/start\.sh/);
    expect(emptyKey.reason).toMatch(/\.env/);
    // 承重的那条：刻意不给的那条**不许**出现修复指令（它出现了就等于让人去修没坏的东西）
    expect(noKey.reason, '刻意不给的那条给出了修复指令 ⇒ 它读起来就是故障，正是 T34 那句双重误导').not.toMatch(/start\.sh|\.env|生成/);
    // 且要正面说出"设计如此"，光靠"没有修复指令"推不出结论
    expect(noKey.reason).toMatch(/按设计|不是故障/);
  });

  /**
   * 第 4 条钉的是**文案分类**（拿到一个 abort 样的拒绝该怎么说），它钉不住"超时这件事真有人负责"：
   * 那个假 fetch 自己就把 abort 文案抛出来了，删掉实现里的 AbortSignal 它照样绿。
   * 这条把接线本身判上 —— 探活会被前端轮询（Task 9），没有 deadline 的请求遇到"在听但不答"的
   * jupyter 会永远挂着，而"永远挂着"在界面上长得跟"慢但迟早出结果"一模一样。
   * 后半段用真形状：AbortSignal.timeout 到点给的是 DOMException(TimeoutError)，undici 还会把它
   * 包一层 "fetch failed" ⇒ 分类必须顺着 cause 链看，不然真实的超时会被报成"没在监听"。
   */
  it('超时的来源是真接上的 AbortSignal，不是错误文案里恰好写了 abort', async () => {
    // ① 接线：递给 fetch 的 init.signal 必须存在，且到点会自己中止
    let handed: AbortSignal | null | undefined;
    const recorder =
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        handed = init?.signal;
        return { status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
    // 评审 M6：deadline 从 20ms 提到 200ms、停顿从 150ms 提到 500ms。
    // 20ms 在原机上靠的是"下一拍一定还没到点"这个概率 —— 宿主满载（判题/构建同时在跑）时
    // 那个"没中止"的断言会冤红，而冤红的门禁教人的是"重跑一次"，不是"这里真坏了"。
    // 500 > 200 留了两倍余量，仍然判得住"删掉 AbortSignal.timeout"那一次变异。
    await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: recorder, timeoutMs: 200, ...TOK });
    expect(handed, '没把 AbortSignal 交给 fetch ⇒ "在听但不答"的 Jupyter 会永远拖住这个探活请求（删掉 AbortSignal.timeout 本条就该红）').toBeTruthy();
    expect(handed!.aborted, 'timeoutMs 比这条 fake 的耗时还长，不该一出去就已中止').toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(handed!.aborted, '那个 signal 到点不会自己中止 ⇒ 递出去的不是超时用的 AbortSignal').toBe(true);

    // ② 真分类：服务器挂着不答，请求以"被自己的 deadline 中止"结束
    const hang = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const s = init?.signal;
      return await new Promise<Response>((_res, rej) => {
        // 兜底：实现若不接 deadline，这个请求就永远不会自己结束 —— 1.5s 后带一句指得准的话失败，
        // 别把整轮验证拖到 vitest 的 60s 超时。（这句话故意不含 timeout/abort，免得被误分类成超时。）
        const backstop = setTimeout(() => rej(new Error('探活的请求没有中止来源：它不会自己结束')), 1_500);
        if (s) s.addEventListener('abort', () => (clearTimeout(backstop), rej(s.reason)));
      });
    }) as unknown as typeof fetch;

    const res = await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: hang, timeoutMs: 30, ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/超时/);
    expect(res.reason).not.toMatch(/ECONNREFUSED|未在监听|不会自己结束/);
  });

  /**
   * 真的 `fetch` 失败时顶层永远只是 `TypeError: fetch failed`，事实埋在 cause 里。
   * 上面第 2 条那个 `Error('ECONNREFUSED')` 钉不住这条 —— 它没有链。
   * 而"未在监听：fetch failed"是一句读者无法据此行动的话（沉默降级换了个说法而已），
   * 所以分类与文案都必须顺着 cause 链看；这条钉的就是容器里真拿到的那个形状（Task 10 会撞见）。
   */
  it('undici 的包装不许把事实吃掉：文案用 cause 里那句，分类也顺着链看', async () => {
    const wrapped = (cause: unknown) =>
      (vi.fn(async () => {
        throw new TypeError('fetch failed', { cause });
      }) as unknown) as typeof fetch;

    const refused = await notebookStatus({
      hostHeader: '127.0.0.1:7788',
      ...TOK,
      fetchImpl: wrapped(new Error('connect ECONNREFUSED 127.0.0.1:8888')),
    });
    expect(refused.reason).toContain('connect ECONNREFUSED 127.0.0.1:8888');
    expect(refused.reason, '只剩顶层那句"fetch failed" ⇒ 三种故障读成同一条，没人能据此行动').not.toMatch(/fetch failed/);

    // 同一层包装、换掉 cause ⇒ 分类必须跟着换（这就是"顺着链看"与"只看顶层"的差别）。
    // cause 用真形状：AbortSignal.timeout 到点放进 signal.reason 的就是这个 DOMException。
    const timedOut = await notebookStatus({
      hostHeader: '127.0.0.1:7788',
      ...TOK,
      fetchImpl: wrapped(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    });
    expect(timedOut.reason).toMatch(/超时/);
    expect(timedOut.reason).not.toContain('ECONNREFUSED');
  });
});
