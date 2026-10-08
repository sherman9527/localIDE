import { existsSync } from 'node:fs';
import { createServer, request as nodeHttpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JUPYTER_BASE_URL, NOTEBOOK_PREFIX } from '@arena/shared';
import { config } from '../../src/config.js';
import { guardNotebookProxy } from '../../src/notebooks/proxyGuard.js';
import { localGatewayAddresses } from '../../src/notebooks/status.js';

/**
 * WI-94 Task 3 容器档：`/jupyter/*` 同源反代打在**真 Jupyter** 上。
 *
 * ## 为什么这里打的是"已经跑着的那个 7788"，而不是自己 `buildApp` 一个
 *
 * 这一档要判的是**生产形状叠起来**之后还成立：`app.ts` 那个整 origin 的 Host 钩子 + 反代隧道 +
 * 守卫 + 真 jupyter + 真凭据。自己在测试里搭一个 app 会把第一层换成"我以为的那一层"，
 * 而 brief 第 4 条（Host 写 `rebinding.example:7788` ⇒ `bad_host`）判的**恰恰就是那一层盖住了
 * `/jupyter/*` 这棵树** —— 只有真进程能判。宿主档（`proxy.test.ts`）用假上游 + 自己搭的 app，
 * 是因为它要判的是"字节怎么搬"，那一半需要一台会回显的假上游。
 *
 * ## 探针为什么不能用 fetch
 *
 * `fetch` 会把你给的 Host 换成 URL 那个权威（`kernel.test.ts:301-310` 在本机实测过：同一份
 * `headers:{host:'…'}`，`node:http` 那侧收到自定义值、fetch 收到 `127.0.0.1:7791`）。
 * 本档有两条用例的**全部价值**在"Host 是我发的"上（4 与 6），所以走 `node:http` 自己发；
 * 这条 plumbing 本身由下面常驻那一组的 echo 服务器判住（宿主就能红，不必等容器）。
 *
 * ## 门控（与 `kernel.test.ts` 完全一致的合取）
 *
 * `describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)`，另留一组**永远会跑**的解释断言。
 * ⚠ 这两个标识符的**大小写是承重的**（评审 I-4）：`verify-coverage.test.ts` 的 `gateVars()` 用
 * `\b([A-Z][A-Z0-9_]{2,})\b` 从 `skipIf(...)` 的条件回指 `const` 声明再取 `process.env.X`。
 * 改成小写会让本文件从「孤儿检查」里静默退出、`env` 前缀降级成装饰、这一整组可以永远不再跑而**零条红**。
 *
 * ## 凭据纪律
 *
 * 断言**不许**把凭据值写进失败消息：`expect(body).not.toContain(token)` 这种朴素写法在红的时候会把
 * "期望不包含的那一串"原样印进报告（本档第一版就是这样，一条红就把长期凭据写进了测试输出）。
 * 所以判"含不含凭据"一律走 `holdsToken()` 那一个布尔；值本身也从不进任何 `console`。token 为空时这条判据没有意义 ⇒ 前置断言会把它说成一句话而不是空过。
 *
 * ## 这一档替 Task 2 还的那笔账（评审 I-3）
 *
 * `guardNotebookProxy` 里 `input.gatewayAddresses ?? localGatewayAddresses()` 的**缺省那一支**在宿主档
 * 是空转（Windows 没有 `/proc` ⇒ 那张表恒为空），宿主 19 个调用点又全部注入 ⇒ 把它改成 `?? []` 时
 * 宿主一片绿。只有真容器能判它，所以本档有一条**不注入**的。
 * ⚠ 诚实的边界：那一态在本档是**函数层**的判据，不是 HTTP 层的 —— 2026-10-09 在这台容器里实测过
 * 两条能把对端做成"网桥网关"的路，都不通：① 从容器里拨 `host.docker.internal:7788`（compose 给了
 * `extra_hosts: host-gateway`，名字解析得到，但连接**超时**：发布端口绑在宿主回环上，那张网桥上没人听
 * 7788）；② 从容器里绑一个非本机源地址发包（要 `ip_nonlocal_bind` + CAP_NET_ADMIN，arena 没有）。
 * ⇒ "对端 = 网关"这个态只有**宿主上的客户端**能造出来（真用户走的就是这条路：浏览器 → 宿主的
 * `127.0.0.1:7788` → docker-proxy/NAT → 容器看到的对端是这张网桥的网关）。把它做成一条会红的 HTTP
 * 闸门需要"从宿主打真容器"的判据档（Task 9 的浏览器/E2E 那一档是唯一自然的位置），本档先把
 * **函数 + 真 /proc** 那一半钉死，并在报告里把这一层差距写出来，不假装 HTTP 层判到了。
 */

/** compose 的 arena / dev / tools 各设 `ARENA_IN_CONTAINER: "1"`；宿主永不设。 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
/** compose **只给 arena** 设 `ARENA_NOTEBOOK_SERVICE: "1"`（服务身份）。 */
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';

/** 容器里那个跑着的 API（`server/src/index.ts` 用 `config.port` 起的，compose 发布成宿主的 127.0.0.1:7788）。 */
const APP_PORT = config.port;
const PROBE_TIMEOUT_MS = 10_000;
/** 永不可能是任何机器默认网关的地址（TEST-NET-3，RFC 5737）—— I-3 那条的反向对照。 */
const FOREIGN_GATEWAY_SHAPE = '203.0.113.9';

function nonLoopbackIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/**
 * 带自定义头打一次真 socket，拿状态码 + body + 响应头。
 * 与宿主档那份同形状但**独立**：这一档的对端/Host 取值来自容器，两档不该共享夹具
 * （共享夹具就是"一处改坏两处一起假绿"的形状）。
 */
function probe(opts: {
  connectHost?: string;
  port?: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      {
        host: opts.connectHost ?? '127.0.0.1',
        port: opts.port ?? APP_PORT,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('探针超时')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** `Host` 写成本机字面量（合取的第二半由外层 origin 钩子判，那一半必须**点头**才走得到守卫）。 */
const LOCAL_HOST_HEADER = () => ({ host: `127.0.0.1:${APP_PORT}` });
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

/**
 * **直连上游**（绕过反代）打一次，作为"反代这一层到底改了什么"的基准。
 * 凭据在这里是测试自己按 `Authorization: token` 那份形状加的 —— 与隧道写的是同一个头，
 * 于是"经不加这一行"这件事才是被测对象而不是假设。值永不进任何断言消息（见 `holdsToken`）。
 */
function upstreamProbe(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const data = init.body !== undefined ? Buffer.from(init.body, 'utf8') : null;
    const headers: Record<string, string> = {
      authorization: `token ${config.notebook.token}`,
      ...(init.headers ?? {}),
    };
    if (data) headers['content-length'] = String(data.length);
    const req = nodeHttpRequest(
      { host: '127.0.0.1', port: config.notebook.port, path, method: init.method ?? 'GET', headers, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('上游探针超时')));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 判"这一份里有没有那个凭据"，**只回布尔** —— 断言消息里永远拿不到值本身。
 * ⚠ 不能用 `expect(body).not.toContain(config.notebook.token)`：vitest 失败时会把"期望不包含的那一串"
 * 印进报告（本档第一版就是这样，一条红就把长期凭据写进了测试输出）。这条纪律是派发词的凭据纪律，
 * 而"朴素写法会泄漏"是实测撞出来的，不是推演。
 */
const holdsToken = (value: string): boolean => value.includes(config.notebook.token);

/** 从响应体里取 error 码（拿不到 JSON 就给 null，让调用方把"不是我们的 403"说清楚）。 */
function errorOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

// ──────────────────── 常驻：探针这条 plumbing 本身（宿主就能红） ────────────────────

/**
 * 本档有两条用例的判据是"我发出去的 Host 头原样到达服务器"（4 与 6）。
 * 如果 plumbing 坏了（Node 自己把 Host 换成 URL 权威），那两条会**假绿**：守卫看到的是合法 Host，
 * 于是"外来 Host 被拒"从来没被真的喂过一次。这一组不依赖容器，也不需要反代 ——
 * 它判的是"档里那两条在讲什么"，红在这里说明整档的 Host 类判据都不可信。
 */
describe('本档的 Host 探针（常驻，宿主也跑）', () => {
  let echo: Server | null = null;
  let echoPort = 0;
  let lastHost: string | undefined;

  beforeAll(async () => {
    const srv = createServer((req, res) => {
      lastHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    echo = srv;
    echoPort = (srv.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (!echo) return;
    const srv = echo;
    echo = null;
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('node:http 的探针能把自定义 Host 原样送到，而 fetch 会把 Host 换成 URL 那个权威', async () => {
    const evil = 'rebinding.example:7788';
    lastHost = undefined;
    const raw = await probe({ port: echoPort, path: `${JUPYTER_BASE_URL}tree`, headers: { host: evil } });
    expect(raw.status, 'echo 服务器没答话 ⇒ 本条没有判据对象（先修这一档的夹具，别修断言）').toBe(200);
    expect(lastHost, 'node:http 探针没能把自定义 Host 送到 ⇒ 本档所有"外来 Host"用例都是假的').toBe(evil);

    const viaFetch = await fetch(`http://127.0.0.1:${echoPort}${JUPYTER_BASE_URL}tree`, { headers: { host: evil } });
    expect(viaFetch.status).toBe(200);
    expect(lastHost, 'fetch 竟然把自定义 Host 送到了 ⇒ 上面那条不再是"只有 node:http 能发"，本档的注释要改').not.toBe(evil);
    expect(lastHost).toBe(`127.0.0.1:${echoPort}`);
  });
});

// ──────────────────── 常驻：门控本身 ────────────────────

describe('本档容器那一组的门控（常驻，宿主也跑）', () => {
  /**
   * 两半各自都要能红（与 `kernel.test.ts` 的常驻那一组同一个形状，不许只写一条等式）：
   * ① 标了服务身份却没有 token 键 ⇒ 上面那一整组会红在"503 / 隧道不打 jupyter"，
   *    而毛病其实在 compose 那一行透传（`notebook-compose.test.ts` ⑤ 会先在那里红，这里给第二份证据）；
   * ② 有 token 键却不在容器里 ⇒ 那一整组会在**本该跑它的地方**静默跳过 = 装饰。
   * 宿主上两条都为真：compose 不给宿主设任何标记，而服务端进程从不加载 `.env` ⇒ `tokenKeyPresent` 是假的。
   */
  it('服务标记 / token 键与容器标记必须互相圆得上（合取的两半各自能红）', () => {
    expect(
      !NOTEBOOK_SERVICE || config.notebook.tokenKeyPresent,
      '标了 ARENA_NOTEBOOK_SERVICE=1 而这个进程没有 ARENA_JUPYTER_TOKEN 那个键 ⇒ 上面那一整组会红在' +
        '"503 notebook_not_configured"，而真正的毛病是 compose 的透传行被删了（先查 compose.yml，别查反代）',
    ).toBe(true);
    expect(
      !config.notebook.tokenKeyPresent || IN_CONTAINER,
      '这个进程拿到了 ARENA_JUPYTER_TOKEN 却没设 ARENA_IN_CONTAINER ⇒ 上面那一整组会在**本该跑它的地方**' +
        '静默跳过（报告里的"N skipped"就是它唯一的痕迹）。三种可能按顺序排：① 这一档在容器外被手动跑而 env 漏了；' +
        '② compose 的容器标记行漂移（notebook-compose.test.ts ⑦ 会先红）；③ 服务端把凭据读进来了却没摘干净',
    ).toBe(true);
  });

  it('这一档的探针打的是"跑着的那个实例"的端口，不是本测试进程自己起的', () => {
    // 唯一的判据就是那一行读数：`config.port` 必须仍是 compose 发布（并绑回环）的那个 7788。
    // 它漂了（有人把 ARENA_PORT 改掉而本档还在读默认值）时，症状是"上面那一整组全红在连不上"，
    // 而毛病在这里 —— 所以这条要在**宿主也能跑**的那一组里。
    expect(config.port, '本档探针打的端口读的是 config.port，compose 若把它改掉就要在这里红给你看').toBe(7788);
  });
});

// ──────────────────────────── 容器档：真 Jupyter ────────────────────────────

describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)('/jupyter 同源反代打在真 Jupyter 上（容器档）', () => {
  /** 本档任何一条都要有凭据可注入才有意义（`token` 为空时 `not.toContain(token)` 恒真 = 空判）。 */
  beforeAll(() => {
    expect(
      config.notebook.token.length,
      '容器里这个实例没有 token ⇒ 反代恒为 503，本档的 1/2/5/6 都没有判据对象。' +
        '先按 ./start.sh 生成 `.env` 里那一份（值本身不会被打印出来）',
    ).toBeGreaterThan(0);
  });

  /**
   * 第 1 条：正路。同时判四件事 —— 隧道通、页面上的**响应体里没有凭据**（凭据是注入式而不是透传的证据：
   * 我们只把它写进 header，浏览器那份从来没见过它）、`frame-ancestors` 是我们写的（第五页要嵌它），
   * 以及"守卫真的在位"这件事的反面证据（被拒的话这里会是 403 而不是 200）。
   */
  it('GET /jupyter/tree（回环对端 + 本机 Host + same-origin）⇒ 200 的 HTML，且这一层没有把凭据加进去', async () => {
    const res = await probe({ path: `${JUPYTER_BASE_URL}tree`, headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } });
    expect(res.status, `树页拿到 ${res.status}：隧道与 jupyter 之间任何一环坏了都是这里红（不是"页面本来就这样"）`).toBe(200);
    expect(res.headers['content-type'] ?? '', '反代没有把上游的 content-type 原样搬回来').toContain('text/html');
    expect(res.body.toLowerCase(), '回来的不是那份 HTML ⇒ 可能被 SPA 兜底吃了').toContain('<html');
    expect(String(res.headers['content-security-policy'] ?? ''), '第五页要嵌这个页面，frame-ancestors 必须由我们写掉').toContain("frame-ancestors 'self'");

    // 凭据这一半**与 brief 不同**（brief 写的是"body 里没有 token"，那条在真容器里必红）：
    // Notebook 7 自己就把 token 写进树页那份内嵌 PageConfig 里 —— 2026-10-09 实测：
    // 直连上游（不经反代、同样带 Authorization 头）拿到的那份 HTML 里就有 `"token": "<值>"`。
    // 于是"body 不含 token"判的不是"我们没注入"，而是一条根本不成立的前提；照它落地会把闸门写成常驻红。
    // 这里改成判**差分**：经隧道这一份"含不含凭据"必须与直连上游那一份**一模一样** ——
    // 那才是"隧道只做搬运、没有往页面里加凭据"的可判形状（红在这里 = 我们这一层多了东西，或少了上游有的东西）。
    const direct = await upstreamProbe(`${JUPYTER_BASE_URL}tree`, { headers: SAME_ORIGIN });
    expect(direct.status, '直连上游的树页没答 200 ⇒ 这条差分没有基准（先排 jupyter 在不在听，别改断言）').toBe(200);
    expect(holdsToken(res.body), '经隧道的树页与直连上游的树页在"含不含凭据"上不一致 ⇒ 搬运那一半坏了（我们这层多加了东西）').toBe(holdsToken(direct.body));
    // 上游那份确实自带凭据（今天的事实，不是我们的作为）：把它钉成一条会被读到的断言，
    // 而不是让下一个人以为页面是干净的 —— Task 9 的 iframe 设计要拿它当前提（见报告的分歧记录）。
    expect(holdsToken(direct.body), '实测前提变了：Notebook 7 不再把 token 写进树页的 PageConfig ⇒ 上面那条差分与 Task 9 的假设要一起重读').toBe(true);
    // 而**我们自己写的那一半**（响应头）里必须有而且只能有那三样搬运过的东西，不许出现凭据：
    // 失败消息只回布尔，永不回显 header 值（值里可能带 cookie）。
    expect(Object.entries(res.headers).every(([, v]) => !holdsToken(Array.isArray(v) ? v.join(',') : String(v)))).toBe(true);
  });

  /** 第 2 条：`Sec-Fetch-Site` **缺席**= 非浏览器（本机 curl / 探针 / 健康检查），必须放行。 */
  it('同一条不带 Sec-Fetch-Site ⇒ 仍 200（缺席按"不是浏览器发的"处理，不许把它当成 cross-site）', async () => {
    const res = await probe({ path: `${JUPYTER_BASE_URL}tree`, headers: { ...LOCAL_HOST_HEADER() } });
    expect(res.status, `不带 Sec-Fetch-Site 得到 ${res.status}（期望 200）⇒ 守卫把"缺席"写成了拒绝，本机 curl 与测试探针全被判死`).toBe(200);
  });

  /** 第 3 条：`cross-site` ⇒ 403 + `notebook_cross_site`，而且这是**我们**那层的 403。 */
  it('Sec-Fetch-Site: cross-site ⇒ 403 notebook_cross_site（别人页面里的 iframe 嵌不进来）', async () => {
    const res = await probe({
      path: `${JUPYTER_BASE_URL}tree`,
      headers: { ...LOCAL_HOST_HEADER(), 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(errorOf(res.body), '403 但不是守卫那一条 ⇒ 拦你的是别的东西（多半是外层 Host 钩子），这条判的就不是它想判的').toBe('notebook_cross_site');
    expect(holdsToken(res.body), '否决消息里出现凭据 ⇒ 那句话把外部输入与长期凭据一起回显了（本仓库的纪律）').toBe(false);
  });

  /**
   * 第 4 条：Host 写外来值 ⇒ 403，而且 error 是 `bad_host`。
   * 这条判的是"整个 origin 的钩子确实盖住了 `/jupyter/*` 这棵树"（反代那棵是 wildcard 注册的，
   * 钩子住在根实例上 ⇒ 天然覆盖；但"天然"两个字在这仓库里从来不算判据）。
   */
  it('Host: rebinding.example:7788 ⇒ 403 bad_host（外层 origin 钩子盖住 /jupyter 这棵树）', async () => {
    const res = await probe({
      path: `${JUPYTER_BASE_URL}tree`,
      headers: { host: 'rebinding.example:7788', ...SAME_ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(errorOf(res.body), '这条要的是**外层钩子**那一个码；换成守卫的码说明两层被折成了一层').toBe('bad_host');
    expect(
      res.body.includes('rebinding.example'),
      '钩子的消息回显了发出去的那个 Host 值 ⇒ 外部输入进响应体/日志（本仓库的纪律，判据是这条布尔）',
    ).toBe(false);
  });

  /**
   * 第 5 条：一次**真**写操作穿过隧道（body 逐字节搬运真的没坏 —— 上游 `base/handlers.py` 的
   * `get_json_body` 要 `json.loads` 得动）。键顺序与非 ASCII 是探针：任何 `JSON.parse→stringify`
   * 都会改这两样。⚠ **这条里不许出现 `_xsrf`**：2026-10-09 在真容器里读源码（jupyter_server 2.21.1）
   * 的结论是"注入 token 的请求被算成 token 认证，origin 与 xsrf 两道检查直接跳过"
   * （`auth/login.py:243-257`、`auth/identity.py:533-542`、`base/handlers.py:530-542`）⇒ 带着 `_xsrf`
   * 的 2xx 同时被"代理剥了它"和"上游本来就跳过"两种解释满足 = 什么都不判。
   * 也不给镜像加 `allowed_origins`：同一个理由。
   *
   * ### 方法与 brief 不同：PUT，不是 POST（实测，`data/wi94-t3-probe2-out.json` 那份对照）
   *
   * brief 写的是 `POST /api/contents/smoke-<ts>.ipynb ⇒ 2xx`。真容器里那个形状**永远 404**
   * （`{"message":"No such directory: smoke-….ipynb"}`）：jupyter 的 POST 是"**在这个目录里新建一份**"
   * ——路径必须是目录、名字从 body 的 `name` 取；"把这份内容存到这个路径"是 **PUT**（201/200），
   * 删除是 DELETE（204）。所以这里 PUT 为主，并把"POST 那个文件路径在两边都 404"一起钉成断言：
   * 下一个人把方法改回 POST 时，红的会是他而不是这条闸门悄悄失效。
   *
   * ### 收尾删除的断言**不许放在 finally 里**
   *
   * 第一版就是那么写的，症状很难查：try 里第一条 expect 抛出去之后，finally 里那条也抛，
   * 而后一条**盖掉前一条** ⇒ 报告只显示"收尾删除 404"，真正的坏点在 try 里（POST 404）。
   * 现在 finally 只记录状态码，断言放在 try/finally 之后。
   */
  it('PUT 一份真 notebook 穿过隧道 → 读回来 → 删掉（body 逐字节搬运，不带 _xsrf）', async () => {
    const name = `wi94-proxy-smoke-${process.pid}.ipynb`;
    const path = `${JUPYTER_BASE_URL}api/contents/${name}`;
    // 键顺序（`type` 在 `content` 前）+ 非 ASCII + 转义引号 + 一个 JSON 里能看出顺序的数字写法 `1.0`：
    // parse→stringify 会动这几样。⚠ `'\\'` 与 `\\"` 的层数：JS 串里要留下"反斜杠 + 引号"两个字符才是合法 JSON。
    const body = '{"type":"notebook","content":{"cells":[{"cell_type":"markdown","metadata":{},"source":"中文 é \\"引号\\" 1.0"}],"metadata":{},"nbformat":4,"nbformat_minor":5}}';
    let cleanup = 0;
    try {
      const saved = await probe({
        path,
        method: 'PUT',
        headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        body,
      });
      expect(saved.status, `上游对这份 body 回 ${saved.status}（期望 200/201）：不是 2xx 就是"字节被改过"或"没算成 token 认证"；` +
        '400/404 的差别在这里读不到（响应体不贴进消息 —— 它是外部输入），排第一步是把这条 PUT 原样打给 127.0.0.1:' +
        config.notebook.port + ' 绕过反代对照').toBeLessThanOrEqual(299);
      expect(saved.status).toBeGreaterThanOrEqual(200);

      const read = await probe({ path: `${path}?content=1`, headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } });
      expect(read.status, '刚存好就读不到 ⇒ 存的位置与读的位置不是同一个（路径被反代改写过的形状）').toBe(200);
      // ⚠ 这里**不能**断"响应体里有 `中文` 这三个字"：jupyter 存盘与回话时都会重新序列化那份模型
      // （非 ASCII 被转成 `\uXXXX`、键顺序是它自己的）——2026-10-09 实测，第一版红在
      // 「expected '{"name":"wi94-proxy-smoke-…"}' to contain '中文'」，而那**不是**代理的锅。
      // 所以判**解析之后相等**：送出去的 cell 正文与读回来的 cell 正文逐字符相同。
      // "我们的请求字节没被 parse 过"那一半由上面的 201/200 判住（body 若被改写，`get_json_body` 就坏了）。
      const model = JSON.parse(read.body) as { content?: { cells?: Array<{ cell_type?: string; source?: string }> } };
      const source = model.content?.cells?.[0]?.source ?? '';
      expect(source, 'cell 正文读回来的与送出去的不是同一串 ⇒ 这份 JSON 在隧道里被改过').toContain('中文');
      expect(source, '转义引号没活过往返').toContain('"引号"');
      expect(model.content?.cells?.[0]?.cell_type, 'cell 类型没回来 ⇒ 那份 notebook 不是被原样存的').toBe('markdown');
      expect(read.body, '?content=1 没生效 ⇒ 参数在隧道里被丢了（读回来的是一份只有元数据的模型）').toContain('cell_type');
      // 响应方向的"逐字节不改写"用**同一份文件的直连回话**做基准（不受上游重新序列化影响：两边都比一遍）。
      const directRead = await upstreamProbe(`${path}?content=1`);
      expect(directRead.status, '直连上游读同一份文件没给 200 ⇒ 这条差分没有基准').toBe(200);
      expect(read.body, '经隧道读回来的与直连读回来的不是同一串字节 ⇒ 搬运那一半改了响应体').toBe(directRead.body);

      // 把 brief 那个形状钉成实测：同一条路径的 POST **不是 2xx**，而经隧道与直连必须给同一个答案。
      // 实测两种坏法（都测到过一次）：文件不存在时 404「No such directory: <name>.ipynb」，
      // 文件已存在时 400 —— 共同点是"POST 到一份文件的路径"在 jupyter 那里根本不是"存这份内容"。
      // 这里**不钉死那个数字**（它取决于文件在不在），钉的是"不是 2xx" + "两层一致"：
      // 前者拦 brief 那句"POST ⇒ 2xx"，后者拦"反代把上游的 4xx 改写成别的东西"。
      const postFile = await probe({
        path,
        method: 'POST',
        headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN, 'content-type': 'application/json' },
        body: '{"type":"notebook","content":{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}}',
      });
      const postDirect = await upstreamProbe(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"type":"notebook","content":{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}}',
      });
      expect(postFile.status, 'brief 那个"POST 到一个文件路径"在上游不是 2xx；经隧道与直连不一致才是反代的锅').toBe(postDirect.status);
      expect(postDirect.status, `上游对 POST 一个文件路径回了 ${postDirect.status} ⇒ 本档那段"该用 PUT"的实测记录要重读 contents API`).toBeGreaterThanOrEqual(400);
    } finally {
      const gone = await probe({ path, method: 'DELETE', headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } });
      cleanup = gone.status;
    }
    expect([200, 204], '收尾删除没成功 ⇒ 真人的 data/notebooks 里留下一份测试文件（WI-40 的隔离纪律）').toContain(cleanup);
  });

  /**
   * 第 6 条：从**非回环**的容器地址打自己的 7788，Host 也写那个地址 ⇒ 403。
   * 判的是"整个 origin 的钩子对非本机 Host 一律拒"，与第 4 条的区别是这里的对端**也是**本机之外的形状
   * （eth0 不是回环，也不是这张网桥的网关 ⇒ 守卫那一半也会点头否决）。
   * 对照断言（"回环上同一个请求是 200"）在第 1 条，两条各判一件事，缺一条会把故障说错（`kernel.test.ts` 的写法）。
   */
  it('从 eth0 地址打自己（Host 也是 eth0）⇒ 403，而回环上同一条是 200', async () => {
    const addrs = nonLoopbackIpv4Addresses();
    expect(
      addrs.length,
      '这个 netns 里没有任何非回环 IPv4 ⇒ 本条没有判据对象。arena 按 compose 应该有一条 eth0（172.18.0.x）；' +
        '真一个都没有说明它跑在 host/无网络模式下，那"发布端口"这个前提本身就不成立（先修判据的适用范围，别删断言）',
    ).toBeGreaterThan(0);
    const addr = addrs[0]!;
    const res = await probe({
      connectHost: addr,
      path: `${JUPYTER_BASE_URL}tree`,
      headers: { host: `${addr}:${APP_PORT}`, ...SAME_ORIGIN },
    });
    expect(res.status, `Host 写成 ${addr}（非本机字面量）却得到 ${res.status} ⇒ 两层 Host 判据至少有一层不在位`).toBe(403);
  });

  /**
   * 第 7 条：对端 = eth0（非本机）**但 Host 写回环字面量** ⇒ 403 `notebook_proxy_refused`。
   * 这条是**守卫的对端那一半**在真实 HTTP 上唯一的代表：外层钩子只看 Host，它在这里点头，
   * 于是走得到守卫 —— 那种"对端本机 + Host 外来"造不出来的组合，反过来是造得出来的。
   * 它同时是"把 `guardNotebookProxy` 整块换成 `{ ok: true }`"那一次变异在容器档的红（brief Step 6 ① 预测的
   * 3/4/6 里，4 与 6 其实红不了：那两条由外层钩子判，与守卫无关 —— 见报告的分歧记录）。
   */
  it('对端 = eth0 而 Host 写回环字面量 ⇒ 403 notebook_proxy_refused（守卫的对端那一半，不是钩子）', async () => {
    const addrs = nonLoopbackIpv4Addresses();
    expect(addrs.length, '没有非回环 IPv4 ⇒ 本条没有判据对象（同上一条的理由）').toBeGreaterThan(0);
    const addr = addrs[0]!;
    const res = await probe({
      connectHost: addr,
      path: `${JUPYTER_BASE_URL}tree`,
      headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN },
    });
    expect(res.status, `对端 ${addr} 既不是回环也不是这张网桥的网关，却被放行（${res.status}）⇒ 对端那一半被摘掉了`).toBe(403);
    expect(errorOf(res.body), '这个码必须是守卫那一个；换成 bad_host 说明拦它的是外层钩子，本条就没判到守卫').toBe('notebook_proxy_refused');
    expect(res.body, '否决消息不许回显对端地址（外部输入会进日志）').not.toContain(addr);
    // 对照：同一个 Host、同一条路径，从回环打必须 200 —— 否则"403"也可以由"整棵树都挂了"给出。
    const control = await probe({ path: `${JUPYTER_BASE_URL}tree`, headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } });
    expect(control.status, '对照组坏了（回环上都不通）⇒ 上面那条 403 与守卫无关').toBe(200);
  });

  /**
   * 第 8 条 = **替 Task 2 还的那笔账（评审 I-3）**：生产路径**不注入** `gatewayAddresses`，
   * 于是守卫走的是 `?? localGatewayAddresses()` 那一支 —— 它读的是这个 netns 的真 `/proc/net/route`。
   * 把那一支改成 `?? []` 时宿主档 19 个调用点全绿（它们全都注入），只有这里红：
   * 这一条用的是**内核真的告诉这个容器**的那个网关地址，不是字符串字面量。
   * 为什么是函数层而不是 HTTP 层：见文件头那句"诚实的边界"（两条能造出"对端=网关"的路都实测不通）。
   * 反向对照（外来地址 + 同样不注入）必须有：否则"`gateways.some(...)` 改成恒真"也能满足第一条。
   */
  it('不注入 gatewayAddresses 时，守卫读的是这个容器自己的路由表（I-3 那笔账）', async () => {
    // 与 `kernel.test.ts` 那条"真 /proc 发现"同一个缝：拿一份**新模块实例**，绕开模块级缓存
    // （`gatewayOnce` 没有导出的清理口子，而本档 import 的 config 早就把那张表算过一次的可能存在）。
    vi.resetModules();
    const { localGatewayAddresses: fresh } = await import('../../src/notebooks/status.js');
    const gateways = fresh();
    expect(
      gateways.length,
      '/proc/net/route 解不出默认网关 ⇒ "对端 == 我自己的网关"这一支没有判据对象，' +
        '而 compose 部署里宿主浏览器那条路走的就是这一支（先查这个 netns 有没有默认路由，别改断言）',
    ).toBeGreaterThan(0);
    const gw = gateways[0]!;

    // 生产那一支：**不传 gatewayAddresses**，也**不传 token**（守卫自己从 config 读，与隧道同一个入口）。
    const viaRealGateway = guardNotebookProxy({ peerAddress: gw, hostHeader: `127.0.0.1:${APP_PORT}`, secFetchSite: 'same-origin' });
    expect(
      viaRealGateway,
      `对端 = 这张网桥的网关（${gw}，从 /proc/net/route 读的）却被拒 ⇒ 守卫的缺省网关那一支坏了` +
        '（`?? localGatewayAddresses()` 被改成 `?? []` 就是这个形状：宿主档全绿，容器里用户的每一条请求 403）',
    ).toEqual({ ok: true });

    const viaForeign = guardNotebookProxy({ peerAddress: FOREIGN_GATEWAY_SHAPE, hostHeader: `127.0.0.1:${APP_PORT}`, secFetchSite: 'same-origin' });
    expect(viaForeign.ok, '外来对端在**不注入**的形状上被放行 ⇒ 上面那条的对照不存在，第一条等于恒真').toBe(false);
    if (!viaForeign.ok) expect(viaForeign.error).toBe('notebook_proxy_refused');
    // `isLocalPeer` 不许把整段私网都算本机：邻居容器不是"这台机器"。
    const neighbor = guardNotebookProxy({ peerAddress: '172.18.0.7', hostHeader: `127.0.0.1:${APP_PORT}`, secFetchSite: 'same-origin' });
    expect(neighbor.ok, '邻居容器（同网段、不是网关）被当成本机 ⇒ 信任面从"这台机器"涨到"这张网桥上的任何进程"').toBe(false);
  });

  /**
   * 第 9 条：`/jupyter`（不带尾斜杠）不许多么 404、多么被 SPA 兜底吃掉。
   * 症状写清楚：那条兜底回的是 **200 + index.html** —— 人在地址栏手敲 `/jupyter` 时看到的是整个应用，
   * 不是"这一页不存在"，所以这里必须断状态码，不能断"有没有响应"。
   */
  it('手敲 /jupyter（不带尾斜杠）⇒ 302 到 /jupyter/，不是 200 + index.html', async () => {
    const res = await probe({ path: NOTEBOOK_PREFIX, headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } });
    expect(res.status, 'SPA 兜底会把它回成 200，看起来"能用"但落点是整个应用 ⇒ 这条判的就是那个 302 补位跳转在不在').toBe(302);
    expect(res.headers.location).toBe(`${JUPYTER_BASE_URL}`);
  });

  /**
   * 第 10 条：反代不抢原来的地盘 —— 生产实例上 `/api/health` 与 `/` 都还是原来的东西。
   * 这一条在容器里判的是"路由真的挂在那棵子树上、没有覆盖根 `/*`"，宿主档判的是同一个形状但用假上游。
   */
  it('反代不抢地盘：/api/health 仍是 200 的 JSON', async () => {
    const res = await probe({ path: '/api/health', headers: LOCAL_HOST_HEADER() });
    expect(res.status).toBe(200);
    // 判 **content-type** 而不是"有没有响应"：SPA 兜底对任何 GET 都回 200 + index.html，
    // 只看状态码的话"路由被 /jupyter 那棵树盖住了"这种故障会绿着过去。
    expect(String(res.headers['content-type']), '/api/health 回来的不是 JSON ⇒ 根路由被反代挤掉了').toContain('application/json');
    expect(errorOf(res.body) ?? '', '健康检查回了一个 error 码').toBe('');
  });
});

/** `existsSync` 只在常驻那一组用来把"为什么跳过"写成可判的东西（别让读者去猜这台是不是容器）。 */
const HAS_PROC = existsSync('/proc');
describe('I-3 那条为什么必须住在容器档（常驻）', () => {
  it('没有 /proc 的那一档里，缺省网关那一支本来就是空转 ⇒ 这一档必须在容器里跑过才算数', () => {
    // 这条**永远会跑**，把"宿主档为什么判不到"写成断言而不是注释：
    // 宿主上 localGatewayAddresses() 必然是空表，于是"不注入 + 网关对端"在宿主没有判据对象。
    const hostSeen = localGatewayAddresses();
    if (HAS_PROC) {
      // 有 /proc 却不解不出网关 = 这台的路由表与 compose 的前提不符（本仓库在 tools/dev 那两档真见过）
      expect(hostSeen.length, '/proc 存在但解不出默认网关 ⇒ 上面那条 I-3 用例没有判据对象').toBeGreaterThan(0);
    } else {
      expect(hostSeen, 'Windows / macOS 宿主上没有 /proc ⇒ 那张表恒为空，"缺省那一支"在宿主档不可能有判据' +
        '（这就是它必须住在容器档的理由，不是本条在偷懒）').toEqual([]);
    }
  });
});
