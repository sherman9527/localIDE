import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NotebookStatusResponse } from '@arena/shared';
import { config } from '../../src/config.js';
import { notebookStatus } from '../../src/notebooks/status.js';

const fake = () =>
  vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => ({ default: 'python', kernels: { 'arena-pyspark': { name: 'arena-pyspark', spec: { display_name: 'PySpark (arena)' } } } }) }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }) as unknown as typeof fetch;

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
    expect(res.url).toContain('http://127.0.0.1:7789/tree?token=test-token');
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

  it('token 不进日志（它出现在本机 URL 里是点开用的，进日志就留痕了）', async () => {
    // 实现里不许有任何 console.* 或 logInfo 带 token；这条用源码级判据兜住，因为
    // 真日志要起服务才拿得到，而"忘了打这行"的代价是不可撤回的历史日志。
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'notebooks', 'status.ts'), 'utf8');
    expect(src).not.toMatch(/logInfo\([^)]*token/);
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*token/);
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
    await notebookStatus({ hostHeader: '127.0.0.1:7788', fetchImpl: recorder, timeoutMs: 20, ...TOK });
    expect(handed, '没把 AbortSignal 交给 fetch ⇒ "在听但不答"的 Jupyter 会永远拖住这个探活请求（删掉 AbortSignal.timeout 本条就该红）').toBeTruthy();
    expect(handed!.aborted, 'timeoutMs 比这条 fake 的耗时还长，不该一出去就已中止').toBe(false);
    await new Promise((r) => setTimeout(r, 150));
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
