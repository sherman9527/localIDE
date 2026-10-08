import { existsSync, readFileSync } from 'node:fs';
import { config } from '../config.js';
import { isLoopbackAddressLiteral, isLoopbackHostHeader } from '../net/localOrigin.js';
import { venvPythonPath } from '../ide/env.js';
import { NOTEBOOK_KERNELS, type NotebookKernel, type NotebookStatusResponse } from '@arena/shared';

/**
 * 页面上允许出现的 kernel（终审 I-4）。从 `NOTEBOOK_KERNELS` 派生 ⇒ A2 加 `arena-scala`
 * 只需要在那一处加一条，这里自动跟着长（"第四处字面量"是本仓库反复付学费的形状）。
 */
const ARENA_KERNEL_IDS: readonly string[] = Object.values(NOTEBOOK_KERNELS);

/**
 * 「这个请求能不能拿到 token」—— 终审 C-1 之后它是**合取**，两半都要点头：
 *
 * 1. `isLocalPeer(对端地址)`：判据是**内核给的 socket 对端地址**，不是客户端自报的头（评审 M-1：
 *    任何人都能把 `Host:` 写成 `127.0.0.1:7788`，照着它发凭据等于把 token 发给局域网里任意一个请求）。
 * 2. `isLoopbackHostHeader(Host 头)`（`server/src/net/localOrigin.ts`）：**只有**第一半不够 ——
 *    DNS rebinding 里受害者浏览器把攻击者的域名改成 `127.0.0.1`，socket 对端**就是**回环，
 *    而响应与攻击页同源 ⇒ 页面上的 JS 读得到 `url` 里那个 token（一个能在容器里以 root 执行任意代码
 *    的服务的**长期**凭据：躺在 `.env`、重启不换）。这时还认得出"这个 Host 不是本机"的只剩头本身。
 *
 * **这不与上一轮那条裁决冲突**（会读成冲突，是因为那句话写成了"Host 头不参与判定"）：
 * 那一句反对的是 **Host 单独说话**，而合取严格强于任何一半 —— 伪造头的用例（LAN 对端 +
 * `Host: 127.0.0.1:7788`）与 `::1:7788` 那个非回环字面量今天**都还得红**，
 * `server/test/notebooks/status.test.ts` 的合取表把两个方向各钉了一次。
 *
 * 第一半为什么必须带"默认网关"那一支 —— 它决定这个功能在**唯一会启用它的部署**里生不生效，
 * 所以这条必须写在代码里，否则换判据的动作会把功能静默关掉：
 * - 宿主直跑（`npm run dev`）：浏览器 → `127.0.0.1:7788` ⇒ 对端就是 `127.0.0.1` / `::1`。
 * - compose（`./start.sh`，也是唯一拿到 `ARENA_JUPYTER_TOKEN` 的实例）：浏览器 → 宿主的
 *   `127.0.0.1:7788` → docker-proxy / NAT 在**宿主那侧**拨容器的 eth0 ⇒ 容器里看到的对端是
 *   这张网桥的网关（`172.18.0.1` 那一类），**永远不会是 127.0.0.1**。
 * 只认回环的后果不是"更安全"，而是"这个功能在容器里从来拿不到 token"—— 点开链接撞
 * Jupyter 的登录页，而页面一片绿（Task 7 那份注释警告过的正是这种静默降级）。
 * 所以第二条判据是"对端 == 我自己的默认网关"：它成立说明报文是从宿主的那个网桥接口进来的，
 * 也就是那台跑着 Jupyter 的机器。而这在今天不会放大暴露面 —— compose 把每个发布端口都只绑在
 * 宿主的 127.0.0.1 上（闸门 `compose-ports.test.ts`），到不了这个服务的地址谈不上"被漏 token"，
 * 想冒充网关得先能在我的 netns 里发包，那已经是宿主本地的权限了。
 * 代价也照实说：宿主直跑时"默认网关"通常是路由器，那一台会被当成本机。今天打不开任何东西，
 * 因为服务端从不加载 `.env`（只有 compose / start.sh 读它）⇒ dev 进程根本没有 token；
 * 将来若给 dev 也接上 token，先把 `ARENA_HOST` 设成 `127.0.0.1`（那时对端只会是回环）。
 *
 * 还有：不拿正则扫地址字符串（评审 M-1 的另一半）。旧判据
 * `^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$` 会把 `::1:7788` 这个**非回环字面量**认成本机 ——
 * 冒号在 IPv6 里是地址的一部分，不是"地址:端口"的分隔符。socket 地址本来就不带端口，
 * 所以这里按地址族逐条判，不做任何"尾巴上可能带端口"的宽容匹配。
 * 同一串 `::1:7788` 在 Host 那一半也判"不是本机"（`hostHeaderHostname` 见到第二个冒号给 null）——
 * 同一个字面量不许在两处各解释一遍。
 */
const TOKEN_KEY = 'ARENA_JUPYTER_TOKEN';

/** `/proc/net/route` 里的网关是小端十六进制（`010012AC` = 172.18.0.1）。 */
function hexLittleEndianToIpv4(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes.join('.');
}

/**
 * 从 `/proc/net/route` 的正文里取出**默认路由**的网关（小端十六进制）。
 * 单独拆出来是因为 Docker 没起的这一档没法在真容器里验它：唯一能判住"这行解析对不对"的机会
 * 就是拿真实的表文本喂给这个纯函数（`server/test/notebooks/status.test.ts` 的 `parseProcNetRoute` 那一组）。
 * 只认 Destination=00000000 那些行；一张网卡都可能有多个默认路由（多路由表），逐条收齐。
 * Gateway 写成 `00000000` 的那些行要跳过：那是"链路内直连、没有网关"的默认路由，
 * 把 `0.0.0.0` 当成网关收进表里，等于给一个不存在的地址发凭据资格 —— 这条按 fail-closed 处理。
 */
export function parseProcNetRoute(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] !== '00000000') continue;
    if (cols[2] === '00000000') continue;
    const gw = hexLittleEndianToIpv4(cols[2] ?? '');
    if (gw) found.add(gw);
  }
  return [...found];
}

/**
 * 本进程所在网络命名空间的默认网关 = 宿主那一侧的网桥地址（容器部署里"本机"就长这个样子）。
 * 读的是 `/proc/net/route`，不是"我猜网段 +1"：那是内核告诉我谁是出口，不是我的猜测。
 * Windows / macOS 宿主上没有这个文件 ⇒ 空数组 ⇒ 退成"只认回环"（那些实例本来也没 token）。
 * 缓存一次就够：容器的网络在整个生命周期里不变，而这个判据每次 status 都要用（页面会刷新它）。
 */
let gatewayOnce: string[] | null = null;
export function localGatewayAddresses(): string[] {
  if (gatewayOnce) return gatewayOnce;
  try {
    gatewayOnce = parseProcNetRoute(readFileSync('/proc/net/route', 'utf8'));
  } catch {
    // 没有 /proc（宿主）不是故障：这一路判据就是"只认回环"
    gatewayOnce = [];
  }
  return gatewayOnce;
}

/**
 * 对端地址是不是"这台机器自己"。`gateways` 做成参数是为了让判据可注入、可测
 * （默认那条走 `localGatewayAddresses()`，测试不必依赖跑它的那台机器有什么网络）。
 * 输入只有 `socket.remoteAddress`：它是内核给的**地址字面量**，不是名字 —— 所以这里不接受
 * `'localhost'` 这类主机名（评审 Fix-1 的 Minor：旧 LOOPBACK 正则里那个 `|localhost` 分支是从
 * Host 头时代抄过来的死代码，今天永远匹配不上，留着它只是给"哪天有人往对端地址里塞自报字符串"
 * 预留一条通向凭据的路）。要认的就按地址族认，认不上就不给。
 * 回环那一半的判据住在 `net/localOrigin.ts:isLoopbackAddressLiteral`（Host 那一半与它必须同源），
 * 这里只加"网桥网关"那一支。
 */
export function isLocalPeer(rawAddress: string | undefined, gateways: string[] = localGatewayAddresses()): boolean {
  const addr = (rawAddress ?? '').trim().toLowerCase();
  if (!addr) return false;
  if (isLoopbackAddressLiteral(addr)) return true;
  // 双栈监听时 Node 把 IPv4 对端写成 `::ffff:127.0.0.1`，网桥网关也是这个形状
  const ip = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  /**
   * 网桥那一半（容器部署里"本机"唯一的形状）。**它的安全性是派生的，不是自证的**：
   * 成立的前提是 compose 里每一个发布端口都只绑在宿主的 `127.0.0.1` 上
   * （闸门 `server/test/regression/compose-ports.test.ts`）—— 那个不变量一旦破（哪天有人写
   * `"8888:8888"` 或去掉 `127.0.0.1:` 前缀），"能打到这个服务"就不再等价于"已经在宿主上了"，
   * 而同一张网桥上的任意进程都能拿 `172.18.0.1` 这个源地址来要凭据 ⇒ 这一支的信任面随之变大。
   * 改 compose 端口的人看不见这条注释就等于没写过，所以动那一侧时把它一起读一遍。
   */
  return gateways.some((gw) => gw.toLowerCase() === ip);
}

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
 *
 * **终审 I-2 之后这个布尔是"记下来的"，不是"现场问的"**：`config.ts` 把这个键读完就从
 * `process.env` 摘掉了（判题子进程走 `{ ...process.env }` 继承，凭据不许躺在那条路上），
 * 所以这里再写 `TOKEN_KEY in process.env` 会**永远**得到 false ⇒ 容器里那句"从没生成（有得修）"
 * 静默漂成"按设计不给（不用修）" —— 正是评审 T34 那条双重误导的复活，而且复活在修好了它的那次改动里。
 * 默认值取 `config.notebook.tokenKeyPresent`（读的那一刻记下的），入参只是给测试的注入点
 * （与 `tokenOverride` 同一形状：生产路径不传，走的就是 config 那份记录）。
 */
function missingTokenReason(tokenKeyPresent: boolean): string {
  return tokenKeyPresent
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
  // `abort` 这一支今天唯一能触发它的是我们自己那个 deadline（AbortSignal.timeout）。
  // 路由层的请求取消（AbortController）**已被明确排除在 A1 之外** —— 这里不留"Task 8 会接进来"的
  // 前向引用（那份接线从来没被批准，注释替实现许愿是本仓库记过的另一类债）。
  // 真接的那天再看这里：那时"用户取消了"会走进这一支、被说成"探活超时"。
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
  /** 真实对端地址（Fastify 的 `request.raw.socket.remoteAddress`）—— 合取的第一半的唯一输入 */
  peerAddress: string;
  /**
   * 请求的 Host 头 —— 合取的第二半（终审 C-1）。**必填**是刻意的：新增入参若有默认值，
   * "调用方忘了传"就会变成"忘了也照样给 token"。传 `undefined` 走 fail-closed（不给）。
   * 它从不单独放行任何东西：只在本机字面量上点头，其余一律否决（见 `net/localOrigin.ts`）。
   */
  hostHeader: string | undefined;
  /**
   * 「这个实例的环境里有没有 token 那个**键**」—— 只影响 `running:false` 时**说哪一句**
   * （从没生成 vs 按设计不给，两者修的是相反的东西）。缺省取 `config.notebook.tokenKeyPresent`，
   * 那是 I-2 里"摘掉之前记下的"那一份；入参存在的唯一理由是测试要能把两句话各判一次
   * （现场改 `process.env` 已经判不到任何事了：那个键在 config 加载时就没了）。
   */
  tokenKeyPresent?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  tokenOverride?: string;
  /** 注入点：默认取本容器自己的默认网关（`localGatewayAddresses()`）。测试靠它把"网桥网关"那一类判住而不依赖机器。 */
  gatewayAddresses?: string[];
}): Promise<NotebookStatusResponse> {
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1500;
  const token = input.tokenOverride ?? config.notebook.token;
  const empty: NotebookStatusResponse = { running: false, kernels: [], notebooks: [] };

  if (!token) return { ...empty, reason: missingTokenReason(input.tokenKeyPresent ?? config.notebook.tokenKeyPresent) };

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
    // ⚠ 键名以**真回话**为准：`GET /api/kernelspecs` 的顶层是 `{default, kernelspecs}`，
    // **没有 `kernels` 这个键**（2026-10-08 从跑着的容器里 curl 过，标签嵌在
    // `kernelspecs[<id>].spec.display_name` 那一层）。这里曾经读 `body.kernels`，于是
    // `kernels` 永远是空表，而 `/api/status` 是 200 —— 第五页于是在用户眼前说
    // 「探到的 kernel 表里没有 arena-pyspark ⇒ 跑一次 ./start.sh --rebuild」，
    // 而那个 kernel 其实注册着、并且刚在容器档里通过它跑完一份 Spark notebook。
    // 那句谎给的操作是拆掉一个能用的镜像，比"少显示一个 badge"贵得多。
    // 三份单测 fixture 当年与这个 bug 同源地写着 `kernels`，所以 mock 全绿救不了它 ——
    // 判住这件事的是 `server/test/notebooks/kernel.test.ts` 那条**不经过 mock** 的容器档闸门
    // （直接调这个函数打真 Jupyter）。改这一行之前先去读那条。
    const body = (await ks.json()) as { kernelspecs?: Record<string, { spec?: { display_name?: string } }> };
    /**
     * **终审 I-4：这一份表要过 arena 自己的 allow-list，不许"照 Jupyter 列的都给"。**
     *
     * 为什么"全列"是被否掉的那个方案（它看起来更"诚实"：界面显示的与服务器列的一致）：
     * `/api/kernelspecs` 里排在前面的是**镜像自带的 `Python 3 (ipykernel)`** —— 那正是
     * 红线①要拦在判题环境外面的那个系统解释器（`docker/Dockerfile` 装的 pyspark/pandas 那一套）。
     * 把它列出来，它带的就是**绿徽标**（ready 与"能不能跑"是两件事，用户读到的是"能跑"），
     * 于是这一页变成"邀请用户去用那个不该用的环境"：在**全新卷**上（I-1 那一态）尤其成立 ——
     * arena-pyspark 起不来，用户退而选第二个，`!pip3 install` 直接落进判题那套。
     * 这一页是**入口**不是 Jupyter 本身，它没有义务替 Jupyter 转发一份它自己的全局清单。
     *
     * "那要是我们自己的 kernel 没注册了呢"——不靠"全列"发现：`Notebook.tsx` 的
     * `missingSpec`（表里没有 `NOTEBOOK_KERNELS.pyspark` ⇒ `notebook-spec-missing` 那条横幅，
     * 文案是"多半是镜像没按 Dockerfile 重建 ⇒ ./start.sh --rebuild"）正是为那一件事准备的，
     * 而且过滤之后它更准：以前 python3 在场会让这张表非空、看着像"有 kernel 可用"。
     */
    const listed = Object.entries(body.kernelspecs ?? {}).filter(([id]) => ARENA_KERNEL_IDS.includes(id));
    /**
     * **终审 I-1：`ready` 过去在这里恒为 true**，于是一整条规格要求的状态在生产里不可达 ——
     * `web/src/pages/Notebook.tsx` 的 `blocked`（`kernels.filter(k => !k.ready)`）永远是空表
     * ⇒「准备环境」按钮永远不渲染 ⇒ `POST /api/notebook/prepare-env` 永远没有调用方
     * ⇒ `NotebookKernel.reason` 永远没有值（契约与规格都要的那一态：spec `:159`、`:174-175`）。
     *
     * 后果不是"少一个按钮"：`arena-pyspark` 的 argv 指的是**懒创建**的 IDE venv
     * （`docker/jupyter/kernels/arena-pyspark/kernel.json` 里那条解释器路径 —— 镜像从来不含它，
     * `ARENA_IDE_ENV_DIR` 那个命名卷在首次显式创建之前是空的）。于是**全新卷**上这一页写着
     * 「运行中」+ 绿徽标、README 说"选它然后 Run All"，用户按下去起不来；而这时如果用页面上
     * 另一条 kernel（镜像自带的系统解释器）兜底，`!pip3 install` 就装进**判题那套**环境 ——
     * 红线①正好在被 entrypoint 那段警告为它而写的状态下踩掉。
     *
     * 判的是**解释器在不在**（一次本地 stat），不是"本进程有没有跑过 ensureIdeEnv"那种内存状态：
     * 那个状态跨不过重启，而这一页是要被轮询的。路径一律从 `venvPythonPath(config.ideEnvDir)` 派生 ——
     * **不写死 `/opt/arena-ide-env`**，也**不加"Windows 上就跳过"的平台分支**：
     * 台账 `Ruling(T2-C 修正)` 记着那条分支的后果（宿主档恒为真 = 这条判据在唯一每天跑它的那一档
     * 永不生效）。宿主直跑时 `config.ideEnvDir` 是 `data/ide-env`，解释器同样还没建 ⇒
     * 这一态在宿主也真实存在，不是为容器编出来的。
     *
     * ⚠ 这里**只 stat、绝不创建**：分钟级的 venv 不许挂在会被轮询的只读路径上
     * （与本文件顶部那段、以及 prepare-env 那条路由的注释同一条纪律）。
     */
    const venvInterpreter = venvPythonPath(config.ideEnvDir);
    const venvReady = existsSync(venvInterpreter);
    kernels = listed.map(([id, v]) => {
      const needsVenv = id === NOTEBOOK_KERNELS.pyspark;
      const kernel: NotebookKernel = { id, label: v.spec?.display_name ?? id, ready: !needsVenv || venvReady };
      if (needsVenv && !venvReady) {
        kernel.reason =
          `环境还没建：这条 kernel 的解释器指向 IDE 那份 venv（${venvInterpreter}），而它还不存在 —— ` +
          'venv 是**懒创建**的，镜像里从来不含它，所以"服务在跑"与"能跑代码"是两件事。' +
          '现在选它只会得到"起不来"。按「准备环境」建一次（第一次几十秒到两分钟，建在命名卷上、跨重启保留）。' +
          '在那之前**别拿另一条 kernel 兜底**：那是镜像自带的系统解释器，`!pip3 install` 装进去的包会落到判题那套环境里（红线①）。';
      }
      return kernel;
    });
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
    // **合取**（终审 C-1）：对端是本机 **且** Host 头是本机字面量，两半都要点头。
    // 只有对端说话 ⇒ DNS rebinding 拿得到 token（对端确实是回环）；只有头说话 ⇒ 局域网里
    // 伪造 `Host: 127.0.0.1:7788` 的那个拿得到（评审 M-1 的原始形状）。
    // 非本机连接**照样给链接**，只是里面没有凭据 —— 不给链接才是静默降级。
    if (isLocalPeer(input.peerAddress, input.gatewayAddresses) && isLoopbackHostHeader(input.hostHeader)) {
      u.searchParams.set('token', token);
    }
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
