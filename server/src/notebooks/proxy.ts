import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
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
        reply.hijack(); // 从这里往后的字节归我们，Fastify 不再碰这条响应（onResponse 也不会跑，见测试档那段）
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
}
