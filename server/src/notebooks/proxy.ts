import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JUPYTER_BASE_URL, NOTEBOOK_PREFIX } from '@arena/shared';
import { config } from '../config.js';
import { guardNotebookProxy, type ProxyVerdict } from './proxyGuard.js';

export interface NotebookUpstream {
  host: string;
  port: number;
}

/**
 * 为什么手写而不引 `http-proxy` / `@fastify/http-proxy`：**不引新依赖**这条是硬约束
 * （传递包 `ws` 不算依赖 —— 把它当直接依赖用，下次装包树一变就静默没掉）。
 * 代价是这一层只有 ~120 行、只做"搬运"，任何"聪明"的改写（改 body、猜路径、拼 URL）都不许有。
 *
 * ## 这一层与 `proxyGuard.ts` 的分工（Task 2 的裁定，不许在这里破）
 *
 * 放行判据**只有一处**：`verdictFor()` 里那一次 `guardNotebookProxy(...)` 调用。这里不许再写第二条
 * `isLocalPeer` / `isLoopbackHostHeader` —— 它们与 `notebooks/status.ts` 是**共用的判据、相反的动作**：
 * status 那边合取不成立时**照样给链接**、只是不附凭据（"不给链接才是静默降级"就是为那句写的），
 * 守卫这里不成立时**否决整个请求**。把两边折成一个函数会把前一支变成 403。
 *
 * ## 否决消息的形状
 *
 * 不回显任何外部输入（Host 头值、对端地址），也不"为了排查"加日志 —— 那句话会进响应体、而拒绝访问
 * 会被记进日志（`api/app.ts` 那条 origin 钩子立了同一个先例）。判据本体在 `proxyGuard.test.ts`。
 */

/** RFC 7230 的逐跳头：这些**不许**转发到上游，也不许从上游搬回浏览器。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * 摘掉客户端查询里的 token，再按 `viaQuery` 决定要不要把我们那份附上。
 * `viaQuery=false` 走 header（HTTP 请求），`true` 走查询串（**websocket 握手只能走这条** ——
 * 浏览器给原生 WebSocket 设不了请求头）。两种通道共用同一个函数，是为了让"客户端塞的 token 一定被摘"
 * 这件事只有一处实现。`_xsrf` 不动：那是 jupyter 自己给页面的字段，摘了会把 POST 全打死。
 */
export function proxiedPath(rawUrl: string, token: string, viaQuery: boolean): string {
  const cut = rawUrl.indexOf('?');
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? '' : rawUrl.slice(cut + 1));
  params.delete('token');
  if (viaQuery) params.set('token', token);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * 上游看到的那份头。三件重写各有必要，都不是"整理一下"：
 * - `host`：jupyter 的 `check_host()` 在 `allow_remote_access=False` 下只放"回环形状"，
 *   而浏览器给 7788 的那个 Host（`127.0.0.1:7788`）到上游看就成了"别的服务"（端口是它的真相的一部分）。
 * - `origin`：**保留这一条重写，但它的必要性已在真容器里读过源码（2026-10-09，jupyter_server 2.21.1），
 *   结论与直觉相反** —— `auth/login.py:243-257` 的 `get_user_token` 认 URL 参数与 `Authorization` 头两种，
 *   命中就把这一次请求标成 token 认证；`auth/identity.py:533-542`（`should_check_origin`）与
 *   `base/handlers.py:530-542`（`check_xsrf_cookie`）都对 token 认证的请求**直接放行**，
 *   于是 `check_origin()` 的"Origin 的 netloc 必须等于 Host"（`base/handlers.py:437-465`）根本不会被问到。
 *   ⇒ 内嵌这条路**不需要**给镜像加 `c.ServerApp.allowed_origins`，也不需要把 `_xsrf` 供成对
 *     （容器档那条真写操作因此**故意不带** `_xsrf`：带着它的 2xx 会被两种解释同时满足，什么都不判）。
 *   ⇒ 那也就不该把这条重写当"必须"来写注释：它是**纵深防御**（万一哪天 token 不再每次注入，
 *   症状会是一整片 403 "Blocking Cross Origin"，而不是一个能读的错误），不是当前功能的前提。
 * - `authorization`：凭据只在这一行出现，且**只在服务端**（页面上任何链接都不含 token）。
 */
export function buildUpstreamHeaders(client: IncomingHttpHeaders, upstreamAuthority: string, token: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(client)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin') continue;
    out[lower] = value;
  }
  out['host'] = upstreamAuthority;
  out['origin'] = `http://${upstreamAuthority}`;
  out['authorization'] = `token ${token}`;
  return out;
}

/**
 * 响应方向：搬头部 + 把"能不能被嵌"这条自己写掉。
 * 上游若已经限了 frame-ancestors 就不重复 —— 重复 directive 会让整条 CSP 失效。
 * `set-cookie` 单独走一遍是因为 Node 把它藏在 `getSetCookie()` 里（`Object.entries` 那一份可能是数组，
 * 也可能不是：同一个键在两条路径上形状不同，写一遍就够，别在循环里猜）。
 */
function responseHeaders(inbound: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (v === undefined || k === 'set-cookie') continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k === 'content-security-policy' || k === 'x-frame-options') continue;
    out[k] = v;
  }
  const cookies = inbound['set-cookie'];
  if (cookies !== undefined) out['set-cookie'] = cookies;
  const csp = inbound['content-security-policy'];
  const has = typeof csp === 'string' && /frame-ancestors/i.test(csp);
  out['content-security-policy'] = has ? csp : `${typeof csp === 'string' && csp ? `${csp}; ` : ''}frame-ancestors 'self'`;
  out['x-frame-options'] = 'SAMEORIGIN';
  return out;
}

const asHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function refuse(reply: FastifyReply, verdict: Extract<ProxyVerdict, { ok: false }>): void {
  void reply.code(verdict.status).send({ error: verdict.error, message: verdict.message } satisfies { error: string; message: string });
}

/** 守卫的三个输入从这里取：对端是内核给的，Host/Sec-Fetch-Site 是头 —— 见 proxyGuard.ts 顶部。 */
function verdictFor(request: FastifyRequest, gatewayAddresses?: string[]): ProxyVerdict {
  return guardNotebookProxy({
    peerAddress: request.raw.socket.remoteAddress ?? '',
    hostHeader: asHeader(request.headers.host),
    secFetchSite: asHeader(request.headers['sec-fetch-site']),
    ...(gatewayAddresses === undefined ? {} : { gatewayAddresses }),
  });
}

/**
 * 101 的回话头部。**不许**照搬 HTTP 通道那套 `responseHeaders()`，两处形状都不同：
 * - `Upgrade` 与 `Connection` **必须转发**（RFC 6455 的握手回话要带它们；Firefox 缺 `Connection` 直接判握手失败）。
 *   "逐跳头不许转发"讲的是**已建立的普通请求**之间，握手是例外 —— 把它"顺手修正"回一般规则，
 *   本仓库只有宿主档那条按字节读的判据抓得住（浏览器侧的故障要换个浏览器才看得见，E2E 用的是 Edge）。
 * - 数组值要写成**多行**（`set-cookie` 折成一行的话浏览器只收到一条畸形 cookie —— Task 3 评审 I-B 的 ws 那一半）。
 * - 不写 CSP/XFO：那两个头管的是"这个**文档**能不能被嵌"，握手回话不是文档。
 */
function upgradeResponseLines(headers: IncomingHttpHeaders): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === ':status') continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) && lower !== 'upgrade' && lower !== 'connection') continue;
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
  }
  return lines;
}

/** 握手被否决时的回话：JSON + 明确的状态码。静默断连是这一层最难查的故障（"页面转圈、控制台什么都不说"）。 */
function rejectUpgrade(socket: Duplex, status: number, body: { error: string; message: string }): void {
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Not Found'}\r\n` +
      `content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
  );
  socket.destroy();
}

/** Node 22.21+/24 上有这个可写属性（宿主 24.10.0 与容器 24.10.0 实测都是 `function`）；更旧的没有。 */
type NarrowableServer = HttpServer & { shouldUpgradeCallback?: (req: IncomingMessage) => boolean };

/**
 * 只认领 `/jupyter/` 那棵子树的 upgrade，返回"这台 Node 支持收窄吗"。
 * 为什么必须显式收窄（读的是容器里 Node 24 的 `_http_server.js` 源码，不是推测）：
 * `parserOnIncoming` 里 `req.upgrade = … || !!server.shouldUpgradeCallback(req)`，而默认那一份是
 * `() => this.listenerCount('upgrade') > 0` ⇒ **我们一开始听 `upgrade`，整台服务器的 upgrade 都不再走路由**；
 * 而派发之前 Node 已经把这条 socket 的 parser 拆了（`onParserExecuteCommon`），所以"不归我们就不管"
 * 在监听者里是**做不到的** —— 剩下的只有两种：客户端挂死，或者我们显式回话。收窄之后
 * `GET /api/health` 那种"带 Upgrade 头的握手"仍旧由原来的路由回答，隧道一行都不碰（宿主档钉着这条）。
 * ⚠ 这里是**整体替换**而不是"与默认那份合取"：默认那份回答的是"有没有人听 upgrade"，
 * 而那件事从我们接线起恒为真 —— 合取它等于没收窄。代价是：若将来别的插件也想听 upgrade，
 * 它必须在**我们之后**设这个属性（或由它自己判前缀），否则两边会互相覆盖 —— 那条写进注释里，
 * 因为"两个通道各吃一次对方的地盘"正是本仓库反复付学费的形状。
 */
function claimJupyterUpgrades(server: NarrowableServer): boolean {
  if (typeof server.shouldUpgradeCallback !== 'function') return false;
  server.shouldUpgradeCallback = (req: IncomingMessage) => (req.url ?? '').startsWith(JUPYTER_BASE_URL);
  return true;
}

/**
 * 第二条通道：内核 ↔ 页面的 websocket（`/jupyter/api/kernels/<id>/channels`）。
 * `jupyter_server` 在这一条上跑的是**执行** —— 这一条不通，内嵌就是个只能看不能跑的截图。
 * 它有两个 HTTP 隧道没有的性质，每一个都决定了这里的一行：
 * ① 浏览器给原生 WebSocket **加不了请求头** ⇒ 凭据只能走 `?token=`（`proxiedPath(…, true)`），
 *    而客户端自己塞的那一份**必须摘掉**（两份同时在场时 jupyter 读哪个是未定义行为）—— 复用 HTTP 那
 *    一份 `proxiedPath`，就是为了"摘"这件事只有的一处实现；
 * ② 它**不走路由**，所以 Fastify 的 `onRequest` 钩子与上面那个 HTTP handler 都碰不到它 ⇒
 *    **守卫必须在这里再调一次同一个 `guardNotebookProxy`**，否则"能打开页面"就变成了"能绕过页面执行代码"。
 *    这一次调用与 HTTP 那一次不是重复：判据仍然只有一套（`proxyGuard.ts`），
 *    `proxy.test.ts` 那条结构判据数的就是"每条通道各一次、全文件仅此两次"。
 * `head`（握手之后已经到了一截的字节）在隧道建好之后写进**对侧的 socket**，不写进 `upstreamReq`：
 * 那个请求没有 content-length，往它身上写字节会变成 chunked，把握手打成乱码。
 */
export function attachNotebookUpgrade(
  server: NarrowableServer,
  deps: { upstream: NotebookUpstream; authority: string; gatewayAddresses?: string[] },
): void {
  const narrowing = claimJupyterUpgrades(server);
  server.on('upgrade', (req, socket, head) => {
    // 每条 socket 的 'error' 都必须就地接住：这一层的对端随时可能被浏览器/上游半路砍断，
    // 而逃出去的 'error' 事件会**把整个进程带走**（本项目有过同类事故：一条 void 掉的 async 拒绝
    // 让 Node 按 unhandled rejection 结束了服务；这里死掉的会是 arena 本身）。
    socket.on('error', () => socket.destroy());
    const url = req.url ?? '';
    if (!url.startsWith(JUPYTER_BASE_URL)) {
      // 收窄成功时这一支到不了（Node 不会把别人的 upgrade 交给我们）；到得了的唯一原因是这台 Node
      // 没有那个开关 ⇒ 我们的监听者已经吃下了整台服务器的 upgrade ⇒ 静默 = 客户端挂死，所以显式回一句再断。
      if (narrowing) return;
      rejectUpgrade(socket, 404, {
        error: 'notebook_upgrade_not_ours',
        message: '同源反代只隧道 /jupyter/ 那一棵子树的 websocket；这一条不是它的。' +
          '（这台 Node 太旧，没有 `http.Server` 的 `shouldUpgradeCallback`，我们没法只认领自己那棵子树，' +
          '只能对不归自己的握手明确说"不是我的"而不是让你挂在那里等。）',
      });
      return;
    }
    // 守卫必须在**注入凭据之前** —— 与 HTTP 那一条同一个理由，越权的那一半就发生在这两行之间。
    // ⚠ 事件给的 `socket` 在类型上是 `Duplex`（没有 `remoteAddress`），对端地址从 `req.socket` 取 ——
    //   与 HTTP 那一条 `request.raw.socket.remoteAddress` 是同一个对象，两条通道的输入因此同源。
    const verdict = guardNotebookProxy({
      peerAddress: req.socket.remoteAddress ?? '',
      hostHeader: asHeader(req.headers.host),
      secFetchSite: asHeader(req.headers['sec-fetch-site']),
      ...(deps.gatewayAddresses === undefined ? {} : { gatewayAddresses: deps.gatewayAddresses }),
    });
    if (!verdict.ok) return rejectUpgrade(socket, verdict.status, { error: verdict.error, message: verdict.message });
    const token = config.notebook.token;
    const upstreamReq = httpRequest({
      host: deps.upstream.host,
      port: deps.upstream.port,
      method: 'GET',
      path: proxiedPath(url, token, true), // 握手只能走查询串（上面①）
      headers: {
        ...buildUpstreamHeaders(req.headers, deps.authority, token),
        // `buildUpstreamHeaders` 按一般规则把这两个逐跳头剥掉了（HTTP 通道那样才对）；
        // 握手这一支必须自己带上，否则打出去的是"一个带 WebSocket 头的普通 GET"，jupyter 回 400。
        upgrade: asHeader(req.headers.upgrade) ?? 'websocket',
        connection: 'Upgrade',
      },
    });
    upstreamReq.on('upgrade', (ures, usocket, uhead) => {
      usocket.on('error', () => socket.destroy()); // 同上：这一侧逃出去的 'error' 也会带走进程
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${upgradeResponseLines(ures.headers).join('\r\n')}\r\n\r\n`);
      if (head && head.length) usocket.write(head);
      if (uhead && uhead.length) socket.write(uhead);
      usocket.pipe(socket);
      socket.pipe(usocket);
      socket.on('close', () => usocket.destroy());
      usocket.on('close', () => socket.destroy());
    });
    upstreamReq.on('response', (res) => {
      // 上游不肯升级（403/404/503）：把状态码原样回给客户端再断 —— 静默断连最难查
      socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}\r\nconnection: close\r\n\r\n`);
      res.resume();
      socket.destroy();
    });
    upstreamReq.on('error', () => socket.destroy());
    socket.on('close', () => upstreamReq.destroy()); // 浏览器切页/关 iframe ⇒ 上游那个握手续着也没用
    upstreamReq.end();
  });
}

export function registerNotebookProxy(app: FastifyInstance, deps: { upstream?: NotebookUpstream; gatewayAddresses?: string[] } = {}): void {
  const upstream: NotebookUpstream = deps.upstream ?? { host: '127.0.0.1', port: config.notebook.port };
  const authority = `${upstream.host}:${upstream.port}`;

  // `/jupyter`（不带尾斜杠）不在 `/*` 的匹配里。补一条纯跳转，别把它 404 掉 —— 人会手敲它。
  // ⚠ 真的"404"不会发生：SPA 的 notFound 兜底会回 200 + index.html，症状是"看起来能用但落点错了"。
  app.get(NOTEBOOK_PREFIX, (_request, reply) => {
    void reply.redirect(JUPYTER_BASE_URL);
  });

  app.register(
    async (scope) => {
      // body 一律**不解析**：原样搬运。Fastify 的内容类型表在封装层是**克隆**的
      // （`node_modules/fastify/lib/content-type-parser.js` 的 `buildContentTypeParser`：
      // `customParsers = new Map(c.customParsers.entries())`），所以这里删掉继承来的 json/text 不影响根实例。
      // 为什么非删不可：默认的 JSON 解析会把 body 变成对象，代理再 stringify 就改了字节
      // （键顺序、非 ASCII、`1.0` 这种数字写法），而 jupyter 的 contents API 收的就是这种"看起来一样"的 body。
      scope.removeContentTypeParser(['application/json', 'text/plain']);
      // `'*'` 住在 customParsers 的空串键上（`content-type-parser.js` 的 `add`），是所有未命中类型的兜底；
      // 回调里的 `payload` 就是原始流，`done(null, payload)` 之后 `request.body` 仍是这个 Readable。
      scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload as unknown as Record<string, never>));

      const handler = (request: FastifyRequest, reply: FastifyReply): void => {
        // 守卫必须在**注入凭据之前**：反过来越权的那一半就发生在这两行之间。
        const verdict = verdictFor(request, deps.gatewayAddresses);
        if (!verdict.ok) return refuse(reply, verdict);
        const token = config.notebook.token;
        reply.hijack(); // 从这里往后的字节归我们，Fastify 不再写这条响应（`onSend` 不跑；⚠ `onResponse` **仍然会跑**，见测试档那段）
        const upstreamReq = httpRequest(
          {
            host: upstream.host,
            port: upstream.port,
            method: request.method,
            path: proxiedPath(request.url ?? '/', token, false),
            headers: buildUpstreamHeaders(request.headers, authority, token),
          },
          (ures) => {
            reply.raw.writeHead(ures.statusCode ?? 502, responseHeaders(ures.headers));
            ures.pipe(reply.raw);
            ures.on('error', () => reply.raw.destroy());
          },
        );
        upstreamReq.on('error', (err) => {
          if (reply.raw.headersSent) return reply.raw.destroy();
          const payload = JSON.stringify({
            error: 'notebook_upstream_unreachable',
            message: `同源反代打不到容器里的 Jupyter（${authority}）：${err.message}。` +
              '这与"你不许用"是两件事 —— 前者是那个进程没起来（缺 token / 镜像没带 Jupyter / 跑过又掉了）。',
          });
          reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) });
          reply.raw.end(payload);
        });
        const body = request.body as unknown;
        if (body instanceof Readable) {
          body.pipe(upstreamReq);
          body.on('error', () => upstreamReq.destroy());
        } else {
          upstreamReq.end();
        }
        // 浏览器断开（切页、关 iframe）⇒ 上游也断。反过来上游断，pipe 会把 reply.raw 收尾。
        reply.raw.on('close', () => upstreamReq.destroy());
      };

      scope.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/*', handler });
    },
    { prefix: NOTEBOOK_PREFIX },
  );

  // 第二条通道（Task 4）：`/jupyter/api/kernels/<id>/channels` 那条 websocket。
  // 它**不在上面那棵树里**（`scope.route` 只管路由表），只能挂在 `app.server` 的 `upgrade` 事件上 ——
  // 于是守卫、凭据注入、逐跳头例外都要在那里重来一遍（判据本体仍然只有 `proxyGuard.ts` 那一份）。
  attachNotebookUpgrade(app.server as unknown as NarrowableServer, { upstream, authority, ...(deps.gatewayAddresses === undefined ? {} : { gatewayAddresses: deps.gatewayAddresses }) });
}
