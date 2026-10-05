import { config } from '../config.js';
import type { NotebookKernel, NotebookStatusResponse } from '@arena/shared';

/**
 * 只有回环来源才附 token。**IPv6 的两种写法都要认**（评审 M7）：
 * Host 头里是带方括号的 `[::1]:7788`，而某些实现（以及直接读 `req.socket.remoteAddress` 的调用方）
 * 递过来的是裸 `::1`。漏掉它们的后果是 fail-closed（本机也拿不到 token ⇒ 用户得自己粘），
 * 不是外泄 —— 但"在本机点开还要手贴 token"就是那句"链接照给但打不开"的静默降级。
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;
const TOKEN_KEY = 'ARENA_JUPYTER_TOKEN';

async function jupyterApi(path: string, token: string, doFetch: typeof fetch, timeoutMs: number): Promise<Response> {
  return doFetch(`http://127.0.0.1:${config.notebook.port}${path}`, {
    headers: token ? { Authorization: `token ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * token 缺席的**两种成因**必须说成两句话，因为它们的修法相反（评审 T34 抓到的双重误导）：
 * entrypoint 对 dev 喊"缺 ARENA_JUPYTER_TOKEN"，可那个 token 其实就好好躺在 .env 里、
 * 用户也确实走的 ./start.sh —— 他照着提示修一遍，什么都没坏可修。
 *
 * 判据是"这个服务的进程环境里有没有这个**键**"，不是"值是不是空"：
 * compose 给 arena / tools 的是 `${ARENA_JUPYTER_TOKEN:-}` 插值 ⇒ 值没生成时拿到的是**空串**，
 * 而 dev / e2e 那一行压根不存在（`notebook-compose.test.ts` 的 ⑤⑥ 钉的就是这两半）。
 * 所以"键在、值为空"= 接上了但从没生成（有得修），"键都没有"= 这个实例按设计不参与 notebook。
 * `config` 把两者都读成空串（`?? ''`），所以这一处只能直接看 process.env 的键 ——
 * 读的是**形状**不是值，token 的值仍然只从 config 走。
 */
function missingTokenReason(): string {
  return TOKEN_KEY in process.env
    ? `${TOKEN_KEY} 是空的 ⇒ token 从没生成过：跑一次 ./start.sh（首启会生成并写进 .env），容器拿到它才会有 notebook`
    : `这个实例没有被给予 ${TOKEN_KEY}（compose 只给 arena / tools 透传，dev 与 e2e 故意不给 —— 那是 WI-40 的隔离规则）` +
      `⇒ 按设计这里不跑 Jupyter，不是需要你修的故障；notebook 在正常启动的那个实例里（${config.notebook.publicUrl}）`;
}

/**
 * 沿 cause 链最多三层收集 name+message。
 * 为什么要走链：真的 `fetch` 失败时顶层永远只是 `TypeError: fetch failed`，事实埋在 cause 里
 * （`connect ECONNREFUSED 127.0.0.1:8888` / `The operation was aborted due to timeout`）。
 * 只看顶层的话，三种故障会读成同一句"未在监听：fetch failed"—— 而这三条修的是不同东西。
 * `detail` 取**最深的那条消息**（那才是事实），`text` 是给分类用的全集。
 */
function errorChain(err: unknown): { text: string; detail: string } {
  const texts: string[] = [];
  let detail = '';
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const e = cur as { name?: unknown; message?: unknown; cause?: unknown };
    const message = typeof e.message === 'string' ? e.message : '';
    texts.push(String(e.name ?? ''), message);
    if (message) detail = message;
    cur = e.cause;
  }
  return { text: texts.join(' ').toLowerCase(), detail };
}

/** 超时/中止的样子：AbortSignal.timeout 给的是 DOMException(TimeoutError)，文案里有 timeout。 */
function isTimeoutish(text: string): boolean {
  // `abort` 这一支今天唯一能触发它的是我们自己那个 deadline；Task 8 会把路由层的请求取消
  // （AbortController）接进来，那时"用户取消了"会被说成"探活超时"—— 到那一步要一起改这里。
  return /timeout|timed out|abort/.test(text);
}

/**
 * HTTP 状态码 → 一句话。**两个端点共用同一个 builder**（评审 I-3）：
 * `/api/kernelspecs` 原来不判状态码就直接 `json()`，于是 403/500 有两种坏法 ——
 * ① HTML body 让 `json()` 抛 SyntaxError，被下面那个 catch 说成"Jupyter 未在监听"（它在监听，
 *    是它答得不像话）；② body 恰好能解析 ⇒ `running:true, kernels:[]` 且没有 reason，
 *    界面显示"没有可用 kernel"却一句解释都没有。真实场景就是 token 重新生成之后：
 *    旧 token 的 403 被读成"kernel 就绪但列表是空的"。
 */
function httpReason(status: number): string {
  return `Jupyter 返回 ${status}${status === 403 ? '（token 不匹配）' : ''}`;
}

/**
 * 只做"读"：探 `/api/status` + 列 `/api/kernelspecs`。
 * 重活（建 venv）不挂在这里 —— 这个接口会被前端轮询，把分钟级的创建塞进读路径是错的
 * （IDE 同样把 ensureIdeEnv 挂在显式动作上，不挂在语言列表上）。
 */
export async function notebookStatus(input: {
  hostHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  tokenOverride?: string;
}): Promise<NotebookStatusResponse> {
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1500;
  const token = input.tokenOverride ?? config.notebook.token;
  const empty: NotebookStatusResponse = { running: false, kernels: [], notebooks: [] };

  if (!token) return { ...empty, reason: missingTokenReason() };

  let kernels: NotebookKernel[] = [];
  try {
    const status = await jupyterApi('/api/status', token, doFetch, timeoutMs);
    // 判状态码而不是 `Response.ok`：注入的假 fetch（测试里 `fake()` 的形状）只带 status / json 两个字段，
    // 判 `.ok` 会把"探到了、200"读成失败 —— 而假阴性最难查（症状是 running:false 加一句
    // "Jupyter 返回 200"，没人会去怀疑探活本身是好的）。
    if (status.status !== 200) {
      return { ...empty, reason: httpReason(status.status) };
    }
    const ks = await jupyterApi('/api/kernelspecs', token, doFetch, timeoutMs);
    // 这一句是评审 I-3 补的：kernelspecs 的回话同样是外部输入，判据必须和 /api/status 那条一样。
    if (ks.status !== 200) {
      return { ...empty, reason: httpReason(ks.status) };
    }
    const body = (await ks.json()) as { kernels?: Record<string, { spec?: { display_name?: string } }> };
    kernels = Object.entries(body.kernels ?? {}).map(([id, v]) => ({ id, label: v.spec?.display_name ?? id, ready: true }));
  } catch (err) {
    // 三条 reason 对应三件不同的事，不许合成一句"连不上"：
    // 超时 = 有人在听但不答（多半是 jupyter 卡住）；未在监听 = 进程根本没起；HTTP 状态 = token 不对。
    const { text, detail } = errorChain(err);
    return { ...empty, reason: isTimeoutish(text) ? 'Jupyter 无响应（探活超时）' : `Jupyter 未在监听：${detail || String(err)}` };
  }

  // 链接是在**已经探到 Jupyter 在跑**之后拼的，所以这一步坏掉不许把结果说成"未在监听"，
  // 更不许让 promise reject —— Task 8 会把这个函数直接挂在 GET 路由上，reject 出去就是 500，
  // 而 500 没有 reason 可读（前端那句"kernel 就绪"会整块消失，读者看不到任何原因，正是本仓库最恨的静默）。
  // 坏值来自 env（ARENA_NOTEBOOK_PUBLIC_URL），这里不写第二份默认值：那会造出端口的第五处真相，
  // 而"给不出链接 + 说清是哪一行坏了"比"给一个可能是错的链接"更可行动。
  let url: string;
  try {
    const u = new URL(`${config.notebook.publicUrl}/tree`);
    if (LOOPBACK.test(input.hostHeader)) u.searchParams.set('token', token);
    url = u.toString();
  } catch {
    return {
      running: true,
      kernels,
      notebooks: [],
      reason:
        `Jupyter 在跑，但 ARENA_NOTEBOOK_PUBLIC_URL="${config.notebook.publicUrl}" 不是合法 URL ⇒ 给不出能点开的链接。` +
        '这是那一行 env 坏了，不是 Jupyter 的故障',
    };
  }
  return { running: true, url, kernels, notebooks: [] };
}
