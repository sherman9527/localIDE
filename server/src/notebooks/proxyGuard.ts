import { config } from '../config.js';
import { isLoopbackHostHeader } from '../net/localOrigin.js';
import { isLocalPeer, localGatewayAddresses, missingTokenReason } from './status.js';

/**
 * 见 `HANDOVER.md` 的 WI-94：7788 一旦注入 token，"谁能把报文发到 7788"就等价于
 * "谁能在容器里以 root 执行代码"。所以这一层是**三条的合取**，任一缺席即否决：
 * ① `isLocalPeer(对端)` —— 内核给的地址，客户端改不动；compose 里宿主浏览器经网桥 NAT 进来
 *    对端是**网关**而非回环，所以"网关"这一支必须留着，否则功能在唯一启用它的部署里恒关。
 * ② `isLoopbackHostHeader(Host)` —— 拦 DNS rebinding（那一战里对端**就是**回环）。
 * ③ `Sec-Fetch-Site ∈ {same-origin, none, 缺席}` —— ①② 都拦不住"别人页面里的 iframe 直接把
 *    `http://127.0.0.1:7788/jupyter/…` 嵌进去"：那种请求 Host 是真的本机字面量、对端真的是
 *    受害者自己，只有这个头还认得出"发起它的是另一个站点"。
 *
 * 三件否决各一个 error 码 + 各一个状态码：503 = 这台机器上根本没有 notebook 服务（该去启动），
 * 403 `notebook_proxy_refused` = 不是本机（该去查访问来源），403 `notebook_cross_site` = 页面
 * 是别人家的（该去查谁在嵌这个 iframe）。把它们并成一句就是把三种修法写成同一件事（本项目的老账）。
 *
 * 消息里**绝不回显**读到的头值 / 地址：它们是外部输入、会进日志（`api/app.ts` 那条 origin 钩子
 * 立了同一个先例）。也绝不出现 token。
 *
 * ## 为什么住在一个**纯函数**里，而不是写在两条隧道各自里面
 *
 * Task 3 的 HTTP handler 与 Task 4 的 websocket `upgrade` 处理者**只调这一个函数**，
 * 隧道里不再判任何一条 —— 两条通道各写一遍判据，就是本仓库反复付学费的那个形状（桥 token WI-86、
 * notebook 前缀 Task 1）。三条输入能被逐组合判住的地方只有这里：真实 HTTP 路径上
 * "对端本机 + Host 外来"那一态**造不出来**（`api/app.ts` 的第一个 onRequest 钩子先按整个 origin 判 403），
 * 所以判据归这张表，HTTP/ws 两层只归"接线在不在"（Task 3 Step 5 / Task 4 Step 3）。
 *
 * ## ⚠ 分支顺序是判据的一部分
 *
 * Sec-Fetch-Site 那一段必须**先**判"带逗号（多值）"**再**判集合：`'same-origin, cross-site'`
 * 既含允许值又含禁止值，按集合判会放行。顺手写成 `site.split(',')[0]` 更糟 —— 看着更宽容，
 * 实际是把这一半守卫关掉（攻击页面只要把允许值排在前面）。判住它的两条都在
 * `server/test/notebooks/proxyGuard.test.ts`：那一行的 error/status，加上"消息说的是不止一个值"
 * 那一条（两种拒绝共用同一个码，只有消息能把顺序区别显出来 —— 见那里的注释）。
 */

const ALLOWED_SEC_FETCH_SITE = new Set(['same-origin', 'none']);

export type ProxyVerdict = { ok: true } | { ok: false; status: number; error: string; message: string };

const REFUSED =
  '这个服务的边界历来是"只绑宿主回环"（compose-ports.test.ts），不是鉴权；' +
  '要把别的机器也接进来，得先给它加一套真正的鉴权，而不是把这一层关掉。';

export function guardNotebookProxy(input: {
  /** `socket.remoteAddress`（内核给的那一半，客户端改不动）；ws upgrade 拿不到时调用方传 `''` ⇒ fail closed */
  peerAddress: string;
  /** 请求的 Host 头；缺席传 `undefined` ⇒ fail closed。**必填**：新增入参不许有"忘了也照样绿"的形状 */
  hostHeader: string | undefined;
  /** `Sec-Fetch-Site`；非浏览器请求没有这个头 ⇒ `undefined` 放行（本机 curl 与测试探针还要活着） */
  secFetchSite: string | undefined;
  /** 注入点：默认取本容器自己的默认网关（与 `notebookStatus()` 同一个，测试靠它把"网桥网关"那一类判住） */
  gatewayAddresses?: string[];
  /** 注入点：默认取 `config.notebook.token`（生产路径不传，与 `tokenOverride` 同一形状） */
  token?: string;
  /** 注入点：默认取 `config.notebook.tokenKeyPresent` —— 终审 I-2 记下来的那一份，不许现场问 process.env */
  tokenKeyPresent?: boolean;
}): ProxyVerdict {
  const token = input.token ?? config.notebook.token;
  if (!token) {
    return {
      ok: false,
      status: 503,
      error: 'notebook_not_configured',
      message: `这条同源反代不起作用，因为${missingTokenReason(input.tokenKeyPresent ?? config.notebook.tokenKeyPresent)}`,
    };
  }
  const gateways = input.gatewayAddresses ?? localGatewayAddresses();
  const localPeer = isLocalPeer(input.peerAddress, gateways);
  const localHost = isLoopbackHostHeader(input.hostHeader);
  if (!localPeer || !localHost) {
    const which = !localPeer
      ? 'socket 对端地址不是本机（既不是回环，也不是这个进程自己的默认网关）'
      : 'Host 头不是本机字面量（本机形状只有 localhost 与 127.0.0.0/8 四段齐全的地址与 [::1]）';
    return { ok: false, status: 403, error: 'notebook_proxy_refused', message: `反代不给这个请求注入凭据：${which}。${REFUSED}` };
  }
  const site = input.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== '') {
    if (site.includes(',')) {
      return {
        ok: false,
        status: 403,
        error: 'notebook_cross_site',
        message: `Sec-Fetch-Site 带了不止一个值 —— 浏览器不会这么发，叠加出来的不可信。${REFUSED}`,
      };
    }
    if (!ALLOWED_SEC_FETCH_SITE.has(site)) {
      // 这里**不打印读到的值**（brief 那版拼了 `${site}`，与本文件顶上那段纪律矛盾：
      // 头值是客户端给的，curl 能写任意串，而这句话会进日志 —— 照 `api/app.ts` 那条钩子的先例闭嘴）。
      return {
        ok: false,
        status: 403,
        error: 'notebook_cross_site',
        message: `Sec-Fetch-Site 说这个请求不是从本页面发起的（允许的值只有 same-origin、none 与不带这个头；收到的那个值不打印在这里 —— 它是外部输入，会进日志）。${REFUSED}`,
      };
    }
  }
  return { ok: true };
}
