import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as nodeHttpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import net, { type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { JUPYTER_BASE_URL, NOTEBOOK_PREFIX } from '@arena/shared';
import type { GradePort, JudgePort } from '../../src/ports.js';
import { FakeBank, FakeStore, fixedClock, seedQuestions } from '../game/fixtures.js';

/**
 * WI-94 Task 3：`/jupyter/*` 同源反代的 **HTTP 隧道**（宿主档）。
 *
 * ## 这一层判的是"搬运"，不是"判据"
 *
 * 放行判据住在 `server/src/notebooks/proxyGuard.ts` 那个纯函数里，由 `proxyGuard.test.ts` 那张表逐组合判
 * （Task 2 的收口，32 条）。本档判的是**隧道有没有把那三件事接在正确的位置上**：
 * ① 否决发生在**注入之前**（cross-site 那条要连着断"一个字节都没发给上游"）；
 * ② 凭据只在服务端注入（`Authorization: token …`），而且客户端自己塞在查询串里的那份**一定被摘掉**
 *   （两个凭据同时在场时 jupyter 读哪个是未定义行为）；
 * ③ 请求与响应的**字节**都不许被"顺手整理"（body 逐字节、302 的 Location 原样、CSP 自己写掉那一半）。
 *
 * ## 为什么必须真发 HTTP 而不是 mock `http.request`
 *
 * 这一层的全部风险都在**字节与头的搬运**上（token 注入在哪、客户端自报的 token 有没有被摘掉、body 是不是
 * 原样、响应头谁在改写），mock 掉它等于把被测对象换成自己的猜测 —— 本项目在 `kernelspecs` 的键名上付过
 * 一次这个学费（三份 fixture 与 bug 同源 ⇒ 单测全绿而页面在撒谎）。
 * 同理，`app.listen` 而不是 `app.inject`：守卫读的是**内核给的对端地址**，`inject` 造不出
 * "对端是 127.0.0.1"这件事，而那正是本层最要紧的一条判据（`notebook-api.test.ts` 那批路由用例能走
 * `inject` 是因为它们判的是 token 释放，不是这条）。
 *
 * ## 纪律
 *
 * - **凭据**：全程 canary，真凭据从不进这个文件。⚠ "永不打印"是假话（Task 3 评审 M-1/M-3 实测：
 *   变异②的红档里那个字面量被打印了 9 次）—— 诚实的说法是**它可以被打印，因为它不是凭据**。
 *   纪律的另一半才是承重的：**actual 里可能含真凭据的那一档（容器档 `embed.test.ts`）不许把 actual 交给
 *   matcher**（`toContain`/`toBe` 打的是 actual，不只是 `not.toContain` 打期望值 —— 评审 I-A 补的那一类）。
 * - **端口**：一律 `listen({ port: 0 })` 拿临时端口（假上游也是），绝不碰 7799（宿主 CLI 桥的端口）。
 * - **数据目录**：每个用例一份 `data/test-tmp/proxy-*` 临时目录（`seedNotebooks()` 会真往
 *   `config.notebook.workDir` 铺文件，WI-40 的隔离纪律），`afterEach` 里**先排空日志再删目录**
 *   （顺序反了会 ENOTEMPTY，那条学费记在 `notebook-api.test.ts` 的评审 I-2）。
 * - 骨架照 `server/test/api/notebook-api.test.ts:104-176` 的 `injectApp`，差别只有两处：这里要真
 *   `listen`（上面写了理由），以及 `notebookUpstream` 那个新 seam 要指向上面那台假上游。
 *
 * ## 与容器档的分工
 *
 * 宿主档**全部走回环对端**，所以"对端 = 这张网桥的网关"那一支在生产里怎么被走到，只有真容器判得住
 * （I-3 那笔账在 `server/test/notebooks/embed.test.ts` 还）。这里只判"注入的网关表在真 socket 上生效"
 * （那条要监听 `0.0.0.0`，见它自己的注释），因为它判的是**接线**：`app.ts` 把
 * `notebookGatewayAddresses` 透传给反代这一行如果被删掉，函数层的表判不出来。
 */

const CANARY = 'proxy-test-token-7d3a'; // 仓库里的字面量、不是凭据；真 token 从不进这个文件（上面那条纪律讲的打印问题对它可以，对容器档不行）
// ⚠ 这里**没有** `FOREIGN_PEER` 那样的"外来对端"常量：宿主档的每一个对端都是内核真的给出来的
// （`listen('127.0.0.1')` ⇒ 回环；`listen('0.0.0.0')` + 从本机非回环 IPv4 打进来 ⇒ 那个地址）。
// 写一个假想地址只会把用例变成"喂字符串"，而那正是 `proxyGuard.test.ts` 那张表负责的事。

const stubJudge: JudgePort = {
  async run(): Promise<never> {
    throw new Error('反代测试不判题');
  },
  async probe(): Promise<boolean> {
    return false;
  },
};
const stubGrade: GradePort = {
  async grade(): Promise<never> {
    throw new Error('反代测试不评分');
  },
  async available(): Promise<boolean> {
    return false;
  },
};

// ──────────────────────────── 假上游 ────────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bodyBase64: string;
}

/** 上游"我收到了什么"的记录表（每条都是真字节，不是对被调用的桩的记账）。 */
const seen: Seen[] = [];
let echo: Server | null = null;
let upstreamPort = 0;

/**
 * 按路径分四种回话：回显 / 302+Location / 无 CSP 的 HTML / 自带 `frame-ancestors` 的 HTML —— 响应的**搬运方向**也要有被测对象。
 * 只回显请求的那一版判不住"上游的 302 被我们改成 200"这种故障。
 *
 * 两种 HTML 回话不是重复，是**生产可达性的两半**（Task 3 评审 I-C）：真 jupyter 树页**自带**
 * `Content-Security-Policy: frame-ancestors 'self'; report-uri /jupyter/api/security/csp-report`
 * （2026-10-09 容器实测）⇒ 生产天天走"避让那一支"，而"上游没 CSP ⇒ 我们追加"那一支只在**死路**上被走到。
 * 所以两支各有一种假上游：`tree`（无 CSP，验追加）、`csp`（有 frame-ancestors，验原样 + 不重复）。
 * `set-cookie` 那两条同理（评审 I-B）：真 jupyter 发的是**两条独立行**（`username-…` 与 `_xsrf`），
 * 这里也发两条，于是"被顺手折成单串"会红在这里而不是红在下一次会话粘性的玄学故障上。
 */
async function startEcho(): Promise<number> {
  const srv = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/redir')) {
      res.writeHead(302, { location: `${JUPYTER_BASE_URL}login?next=${JUPYTER_BASE_URL}redir` });
      return res.end();
    }
    if (url.includes(`${JUPYTER_BASE_URL}tree`)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end('<html><body>tree</body></html>');
    }
    if (url.includes(`${JUPYTER_BASE_URL}csp`)) {
      // ⚠ `set-cookie` 必须写在 `writeHead` 的那一份里：`writeHead` 之后再 `setHeader` 会抛
      // `ERR_HTTP_HEADERS_SENT`，而**夹具里抛出的异常会把 vitest 的 worker 整个带走**
      // （实测：两条用例先挂到 60s 超时，然后 `Worker exited unexpectedly`，一个结论都没有 ——
      // 这就是"挂死的门禁比红更坏"在测试夹具这一侧的形状）
      res.writeHead(200, {
        'content-type': 'text/html; charset=UTF-8',
        // 与真 jupyter 那份逐字同形（实测值）：我们**不许**再追加第二个 frame-ancestors
        'content-security-policy': "frame-ancestors 'self'; report-uri /jupyter/api/security/csp-report",
        'x-frame-options': 'DENY',
        // 两条独立 Set-Cookie：Node 会把数组写成两行，浏览器按行算 cookie 条数
        'set-cookie': ['username-8888=abc123; Path=/; SameSite=Lax', '_xsrf=2|deadbeef; Path=/'],
      });
      return res.end('<html><body>tree-with-csp</body></html>');
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url, headers: req.headers, bodyBase64: Buffer.concat(chunks).toString('base64') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  echo = srv;
  return (srv.address() as AddressInfo).port;
}

/**
 * 假上游的**第二条通道**：会做 101 握手并把收到的字节原样吐回来（echo）。
 * 这里故意不做真的 websocket 帧 —— 隧道判的是 101 之后的**字节搬运**，字节级测试才是它的单元测试
 * （真 ws 语义 + 真内核归容器档 `embed.test.ts` 那一条）。
 *
 * 三个"夹具的讲究"其实各是一条判据的对象，别当装饰删：
 * ① 101 那一行与紧跟的一截字节写在**同一次 `socket.write`** 里 ⇒ 隧道那侧的 upgrade 事件才会拿到非空的 `head`
 *   （反方向同理：客户端把握手与多出来的 4 字节合成一次写 ⇒ 隧道的 `head` 参数非空）；
 * ② 回话带**两条独立** `Set-Cookie`（评审 I-B 的 ws 那一半：数组必须原样搬成两行）；
 * ③ 回话带 `Upgrade` 与 `Connection`（RFC 6455 的握手回话必须带；把逐跳头"顺手全滤"会在这里被抓住 ——
 *   而 Firefox 缺 `Connection` 直接判握手失败，宿主之外的浏览器才会看到，所以判据只能钉在字节上）。
 */
interface WsUpstream {
  port: number;
  /** 上游收到过几次 upgrade 握手（守卫否决那条判的是"一次都没有"） */
  upgrades: () => number;
  close: () => Promise<void>;
}

function startWsEcho(): Promise<WsUpstream> {
  let upgrades = 0;
  const live = new Set<Socket>();
  const srv = createServer((_req, res) => {
    // 没有 upgrade 处理者的那一支由 startWsRefusal 负责；这里被当普通请求打进来只能是测试自己写坏了
    res.writeHead(404);
    res.end('fake-upstream-says-404');
  });
  srv.on('connection', (s) => {
    live.add(s);
    s.on('close', () => live.delete(s));
  });
  srv.on('upgrade', (req, socket, head) => {
    upgrades++;
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, bodyBase64: '' });
    const banner = Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'sec-websocket-accept: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        'set-cookie: a=1; Path=/\r\n' +
        'set-cookie: b=2; Path=/; HttpOnly\r\n' +
        '\r\n' +
        'uheadbytes', // 跟在同一次 write 里的 10 个字节：隧道必须把它们交给**客户端** socket
      'latin1',
    );
    socket.write(banner);
    if (head && head.length) socket.write(head); // echo：证明这条 socket 是双向 pipe 的
    socket.on('data', (b) => socket.write(b));
    // ⚠ 这一行不是装饰：客户端 `destroy()` 之后这边会 emit `'error'`（ECONNRESET），
    // 而**没人接住的 'error' 会直接把 vitest 的 worker 整个带走**（实测：整档 `Worker exited unexpectedly`、
    // 一个用例结论都没有 —— 与本项目那条"void 掉的 async 逃逸把服务带走"是同一类事故，只是这里死的是门禁）。
    socket.on('error', () => socket.destroy());
  });
  return new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)).then(() => ({
    port: (srv.address() as AddressInfo).port,
    upgrades: () => upgrades,
    // ⚠ 三条都得有，因为**一条断掉的断言会留下还开着的隧道 socket**：
    // `srv.close()` 要等所有连接结束，而升级过的 socket **不在 Node 的 `closeAllConnections()` 覆盖范围里**
    // （实测 2026-10-09：先是一条 cookie 断言红 → afterEach 挂到 60s 钩子超时 → 后面每条用例的 afterEach
    // 都撞上同一台没关掉的假上游 → 整个 worker 崩掉、一个结论都没有）。
    // **红必须是有结论的红**：所以自己记账的 `live` 那一份才是这里真正管用的收尾。
    close: async () => {
      for (const s of live) s.destroy();
      live.clear();
      srv.closeAllConnections?.();
      srv.removeAllListeners('upgrade');
      await new Promise<void>((r) => srv.close(() => r()));
    },
  }));
}

/** 上游**不肯**升级的那一台：握手请求被它当普通请求答 404（brief 里那句"静默断连最难查"的反面判据）。 */
function startWsRefusal(): Promise<{ port: number; close: () => Promise<void> }> {
  const live = new Set<Socket>();
  const srv = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
    res.end('not-a-websocket');
  });
  srv.on('connection', (s) => {
    live.add(s);
    s.on('close', () => live.delete(s));
  });
  return new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)).then(() => ({
    port: (srv.address() as AddressInfo).port,
    close: async () => {
      for (const s of live) s.destroy();
      live.clear();
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  }));
}

/**
 * 真 socket 上"按分隔符 / 按字节数读"的小工具。两个讲究：
 * - **余量必须留下**（`leftover`）：101 那一块与紧跟的字节常在同一个包里，读到 `\r\n\r\n` 时多出来的部分
 *   若不缓存，下一条"读 10 个字节"就永远读不到 —— 那是夹具的错，不是隧道的错，会把红说成假话。
 * - **必须带 deadline**：管道单向断掉时socket 不会自己关，没有 deadline 就是用例**挂死**
 *   （本项目验过："挂死的门禁比红更坏"）。
 */
const leftover = new WeakMap<Duplex, Buffer>();

/** 按 `content-length` 把否决响应的 body 读回来（读到 `\r\n\r\n` 就停是不够的：error 码在 body 里）。 */
async function readJsonBody(socket: Duplex, headBlock: Buffer): Promise<string> {
  const m = /content-length: (\d+)/i.exec(headBlock.toString('latin1'));
  if (!m) return '';
  return (await readRaw(socket, { bytes: Number(m[1]) })).toString('utf8');
}

function readRaw(socket: Duplex, want: { marker: string } | { bytes: number }, timeoutMs = 6000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<Buffer>((resolve, reject) => {
    const step = () => {
      const acc = leftover.get(socket) ?? Buffer.alloc(0);
      if ('marker' in want) {
        const at = acc.indexOf(want.marker);
        if (at >= 0) {
          const out = acc.subarray(0, at + want.marker.length);
          leftover.set(socket, acc.subarray(out.length));
          resolve(out);
          return;
        }
      } else if (acc.length >= want.bytes) {
        const out = acc.subarray(0, want.bytes);
        leftover.set(socket, acc.subarray(want.bytes));
        resolve(out);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error(
          'marker' in want
            ? `${timeoutMs}ms 内没读到那个分隔符（已收到 ${acc.length} 字节）⇒ 隧道没把上游的回话搬回来`
            : `${timeoutMs}ms 内只收到 ${acc.length}/${want.bytes} 字节 ⇒ 这个方向的字节管道是断的`,
        ));
        return;
      }
      once(socket, 'data', { signal: AbortSignal.timeout(remaining) })
        .then(([chunk]) => {
          leftover.set(socket, Buffer.concat([acc, chunk as Buffer]));
          step();
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'TimeoutError') { leftover.set(socket, acc); step(); return; } // 回到 deadline 那句人话
          reject(err as Error);
        });
    };
    step();
  });
}

// ──────────────────────────── 被测实例 ────────────────────────────

interface Injected {
  app: FastifyInstance;
  /** 真 socket 的端口（`listen({port:0})` 之后从内核拿的） */
  port: number;
}

let opened: FastifyInstance[] = [];
let madeDirs: string[] = [];
/** 当前那份模块图里的 log 句柄（`vi.resetModules()` 之后旧的排空不到新目录，见 notebook-api 的评审 I-2）。 */
interface LogHandle {
  /** 往**这一份**模块图的 writeChain 里塞一条记录（不经过 HTTP ⇒ 代理那半的故障不影响它） */
  probe: () => void;
  /** `probe()` 写过之后置真：本条判据自己也要有判据对象，没写过就没有"顺序"可判 */
  probeWasWritten: () => boolean;
  /** 那条 marker 记录里的唯一串 —— 判"这一条真的排在 flush 之前落了盘"，而不是"目录里有个旧日志文件" */
  probeId: string;
  flush: () => Promise<void>;
  /** 它写的是哪个文件 —— 用来判"排空真的排在删目录之前" */
  file: () => string;
}
let logHandles: LogHandle[] = [];

/**
 * 每个用例一套临时数据目录 + 显式 env + 指向上面那台假上游。
 * `token` 用 `undefined` 表示"这个键不给"（dev / e2e 那一态），`''` 表示"键在但值为空"（compose 的
 * `${ARENA_JUPYTER_TOKEN:-}` 那一态）—— 两种都会让守卫给 503，但 `missingTokenReason()` 说的是两句话。
 */
async function injectApp(opts: { token?: string; upstreamPort: number; gatewayAddresses?: string[]; listenHost?: string }): Promise<Injected> {
  const dataDir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'proxy-'));
  madeDirs.push(dataDir);
  const keys = ['ARENA_DATA_DIR', 'ARENA_JUPYTER_TOKEN', 'ARENA_NOTEBOOK_PUBLIC_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ARENA_DATA_DIR = dataDir;
  if (opts.token !== undefined) process.env.ARENA_JUPYTER_TOKEN = opts.token;
  vi.resetModules();
  try {
    const { buildApp } = await import('../../src/api/app.js');
    // resetModules 之后 app 用的是**新的那一份** log 模块（各自一条 writeChain、各自的 LOG_DIR），
    // 句柄必须按当前这张模块图取；文件顶部那份静态 import 写的是仓库默认 data/，排空它没用。
    const { logInfo, flushLogs, logFileFor } = await import('../../src/log.js');
    let probeWritten = false;
    const probeId = `probe-${Math.random().toString(36).slice(2)}`;
    logHandles.push({
      probe: () => {
        probeWritten = true;
        logInfo('test', 'proxy-harness', { probe: probeId });
      },
      probeWasWritten: () => probeWritten,
      probeId,
      flush: flushLogs,
      file: logFileFor,
    });
    const app = await buildApp({
      judge: stubJudge,
      grade: stubGrade,
      bank: new FakeBank(seedQuestions()),
      store: new FakeStore(),
      clock: fixedClock('2026-10-09'),
      notebookUpstream: { host: '127.0.0.1', port: opts.upstreamPort },
      ...(opts.gatewayAddresses === undefined ? {} : { notebookGatewayAddresses: opts.gatewayAddresses }),
    });
    opened.push(app);
    await app.listen({ port: 0, host: opts.listenHost ?? '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('listen 之后拿不到端口');
    return { app, port: address.port };
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

/**
 * 带着**指定的 Host 头**打一次真 socket，拿状态码 + body + 响应头。
 * 为什么不能用 fetch：fetch 会把你给的 Host 换掉（`kernel.test.ts:301-310` 在本机实测过），
 * 而这一档要发的正是"Host 与连接目标不一致"那种形状。
 */
function rawRequest(opts: {
  connectHost: string;
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      {
        host: opts.connectHost,
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        timeout: 8000,
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

/**
 * 这台机器上的非回环 IPv4（下面那条"注入网关表 ⇒ 真 socket 放行"要有对端可打）。
 * 判据是 `!a.internal`（内核给的标记），不是 `!== '127.0.0.1'`（评审 minor）：后者把 `127.1.2.3`
 * 这类"整段 127/8 都到本机"的地址当成外来，在真容器里会把**回环对照**那一半打歪。
 * 同一个形状在 `kernel.test.ts:257-262` 已经为容器档实现过一次，宿主档复用它的判据。
 */
function nonLoopbackIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const LAN_IPS: string[] = nonLoopbackIpv4Addresses();

let made: Injected | null = null;
let appPort = 0;
/** 本用例开过的假 ws 上游（每条用例自己开一台，端口各不相同 ⇒ 计数与 seen 一样是每条干净的） */
let wsUpstreams: Array<{ close: () => Promise<void> }> = [];

beforeAll(async () => {
  upstreamPort = await startEcho();
});

beforeEach(async () => {
  seen.length = 0;
  made = await injectApp({ token: CANARY, upstreamPort });
  appPort = made.port;
});

afterEach(async () => {
  // ⚠ **先摘表再 await**：一条红的断言会留下没关的假上游 socket，若 `wsUpstreams = []` 排在 await 之后，
  // 那个永远关不掉的服务器就留在表里，后面**每一条**用例的 afterEach 都撞它一次
  // （实测的形状：60s 钩子超时 ×N，最后 worker 崩掉、整档没有结论）。
  const ups = wsUpstreams;
  wsUpstreams = [];
  await Promise.all(ups.map((up) => up.close()));
  // 同上面那条理由：**升级过的 socket 不在 `closeAllConnections()` 的覆盖范围里**，
  // 而 `app.close()` 要等连接结束 ⇒ 先强关，再让 fastify 正常收尾。
  for (const app of opened) app.server.closeAllConnections?.();
  for (const app of opened) await app.close();
  opened = [];
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  /**
   * 评审 I-2：`rm(dir, {recursive:true})` 过去在和**还在落盘的日志写入**抢同一个目录 ——
   * 轻则 stderr 冒 `写日志失败（业务不受影响）：ENOENT …test-logs/…`，重则
   * `ENOTEMPTY: directory not empty, rmdir …\test-logs` 把门禁偶尔撞红。
   * 修法是复用代码库里**已有**的 `flushLogs`：先排空、再删。不 skip、不吞异常。
   *
   * ⚠ **这一档不"由被测请求产生那条日志"，而是 afterEach 自己塞一条 marker**：不是因为我们劫持了响应
   * 就安静了 —— **Fastify 5 的 `onResponse` 在 `reply.hijack()` 之后仍然会跑**（文档 `Reply.md` 明写
   * "If reply.raw is used …, the onResponse hooks will still be executed"；Task 3 评审在真容器里实测到
   * pino 的 `request completed` 与 app 自己的 `http response` 记录**都**写了 —— 旧注释那句"被代理的请求
   * 一条日志都不会写"讲的是 fastify 4 的行为，2026-10-09 按评审 M-1 订正）。
   * marker 那个设计的价值恰恰是**对日志来源无假设**：断的是"我这条带唯一串的 marker 在 flush 之后的
   * 文件里"，于是"排空排在删目录之前"有判据，而不必赌被测路径这一次会不会写日志、写在哪条链上。
   * `probeWasWritten()` 那条前置判据不许删：谁把 `log.probe()` 摘掉，这里就会因为
   * 「文件不存在却声称判过了」而红 —— 断言自己不许悄悄变成空转（本仓库那条"闸门一直是装饰"）。
   */
  for (const log of logHandles) {
    log.probe();
    await log.flush();
    expect(log.probeWasWritten(), 'probe() 声称写过了却没置真 ⇒ 这条判据的判据对象不存在了').toBe(true);
    const file = log.file();
    expect(existsSync(file), 'flush 之后日志文件仍不在盘上 ⇒ 要么排空没排在删目录之前（本条守卫存在的理由），要么这条 marker 根本没落盘').toBe(true);
    expect(readFileSync(file, 'utf8'), `flush 之后日志里没有那条 marker（${log.probeId}）⇒ 排空没有排在删目录之前`).toContain(log.probeId);
  }
  logHandles = [];
  for (const dir of madeDirs) await rm(dir, { recursive: true, force: true });
  madeDirs = [];
});

afterAll(async () => {
  if (echo) {
    const srv = echo;
    echo = null;
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

describe('/jupyter 同源反代：请求方向', () => {
  it('GET /jupyter/ 到上游：路径带前缀原样送到、Authorization 是我们注入的、Host/Origin 重写成上游自己的', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.url).toBe(`${JUPYTER_BASE_URL}`);
    expect(got.headers['authorization']).toBe(`token ${CANARY}`);
    expect(got.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(got.headers.origin).toBe(`http://127.0.0.1:${upstreamPort}`);
    // 浏览器给 7788 的那个 Host 不许留着：jupyter 的 check_host() 在 allow_remote_access=False 下
    // 只放"回环形状"，而 `127.0.0.1:<临时端口>` 虽然也是回环形状，**端口是这一半判据之外的东西** ——
    // 真正必须换掉的是"上游不许看见我们自己的端口"，它把上一行变成可判的：不重写就会是 7788。
    expect(got.headers.host).not.toContain(String(appPort));
  });

  it('客户端自己在查询串里塞 token ⇒ 被摘掉，只用我们注入的那一份（两个凭据同时在场时 jupyter 读哪个是未定义行为）', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}api/contents?token=attacker-supplied`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.url).not.toContain('attacker-supplied');
    // 只断"不含 attacker-supplied"会被一种坏实现糊过去（把整条查询串删掉）。所以断**恰好**是这个形状：
    expect(got.url).toBe(`${JUPYTER_BASE_URL}api/contents`);
    expect(got.headers['authorization']).toBe(`token ${CANARY}`);
  });

  it('摘 token 不许顺手删掉别的查询参数（jupyter 的接口全靠它们：?type=notebook、?content=1）', async () => {
    await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}api/contents/nb.ipynb?type=notebook&content=1&token=attacker`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(seen.at(-1)!.url).toBe(`${JUPYTER_BASE_URL}api/contents/nb.ipynb?type=notebook&content=1`);
  });

  it('POST 的 body **逐字节**原样送到上游（key 顺序 + 非 ASCII 是探针：JSON.parse→stringify 会改这两样）', async () => {
    const payload = '{"b":1,"a":"é中"}';
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}api/contents/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: payload,
      // ⚠ 这条**必须带超时**（实测出来的，不是审美）：把 `scope.removeContentTypeParser(...)` 那一行删掉
      // 之后，Fastify 的默认 JSON 解析器会把 body 变成对象 ⇒ 隧道那条 `upstreamReq.end()` 发的是
      // "content-length 说了 21 个字节、一个字节都没送"的请求 ⇒ 假上游等不到 `end`、这一档**挂死**
      // （90 秒没有结论，连 vitest 的 5s 单测超时都救不回来：卡的是没结束的 socket，worker 退不掉）。
      // 挂死的门禁比红更坏 —— 它看起来像"还在跑"。有了这条超时，那个变异变成一条确定的红。
      // 补强之后**复测过**（收尾档 2026-10-09，同样加外层 `timeout 180` 判退出码）：
      //   删掉那一行 ⇒ `1 failed | 14 passed`、vitest exit **1**（不是 124）、整档 10.2s 有结论，
      //   红的就是这一条，报错原文 `TimeoutError: The operation was aborted due to timeout`（8075ms 处断）。
      //   ⇒ 这一处补强**足够**把 ④-b 从挂死变成红；失败消息里没有 token 值（CANARY 不会进报告）。
      signal: AbortSignal.timeout(8000),
    });
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.method).toBe('POST');
    expect(Buffer.from(got.bodyBase64, 'base64').toString('utf8')).toBe(payload);
  });

  it('Sec-Fetch-Site: cross-site ⇒ 403 + notebook_cross_site，而且**一个字节都没发给上游**', async () => {
    const before = seen.length;
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('notebook_cross_site');
    // 这条是本任务的"硬前提"判据：否决发生在注入之前 —— 守卫挪到 httpRequest 之后就是这里红。
    expect(seen.length).toBe(before);
  });

  it('这台实例没有 token ⇒ 503 + notebook_not_configured（不是 403：那句"你不许"是谎）', async () => {
    const noTok = await injectApp({ token: '', upstreamPort });
    const res = await fetch(`http://127.0.0.1:${noTok.port}${JUPYTER_BASE_URL}tree`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe('notebook_not_configured');
  });

  it('逐跳头不许转发给上游（te）—— 附一条"直连时它确实会到"的对照，否则这条判的是空气', async () => {
    // 对照组：**不经过代理**直接发给假上游。它证明"te 这个头能被这台假上游看见"，
    // 于是下面那条"经代理之后看不见"判的才是剥掉这个动作，而不是 Node/OS 自己把它吞了。
    const direct = await rawRequest({
      connectHost: '127.0.0.1',
      port: upstreamPort,
      path: `${JUPYTER_BASE_URL}api/te-control`,
      headers: { te: 'trailers' },
    });
    expect(direct.status, '对照组自己就没跑起来（直连假上游失败）⇒ 下面那条"没看见 te"会跟着假绿').toBe(200);
    expect(seen.at(-1)!.headers['te']).toBe('trailers');

    const viaProxy = await rawRequest({
      connectHost: '127.0.0.1',
      port: appPort,
      path: `${JUPYTER_BASE_URL}api/te-through-proxy`,
      headers: { te: 'trailers', 'sec-fetch-site': 'same-origin' },
    });
    expect(viaProxy.status).toBe(200);
    expect(seen.at(-1)!.headers['te'], 'RFC 7230 的逐跳头不许转发到上游（te 是最容易被"顺手全转"漏掉的一个）').toBeUndefined();
  });

  it('对端 = 注入的网桥网关 ⇒ 真 socket 上放行（判的是 app.ts 那一行透传，不是函数本身）', async () => {
    // 宿主上"对端是网桥网关"这件事本来无判据（生产那一支读 /proc，Windows 上没有 ⇒ 空转，
    // 那一半的账在容器档 `embed.test.ts` 还）。这里能做的是**注入**那一张表：
    // 监听 0.0.0.0，再从这台机器的非回环 IPv4 打进来 ⇒ 内核给的对端就是那个地址。
    // 删掉 `app.ts` 里 `gatewayAddresses: deps.notebookGatewayAddresses` 那一句会红在这里
    // （函数层的表怎么判都判不到"接线在不在"，而接线坏了症状是"用户点开是 403"）。
    expect(LAN_IPS.length, '这台机器上没有非回环 IPv4 ⇒ 本条没有判据对象').toBeGreaterThan(0);
    const addr = LAN_IPS[0]!;
    const gwApp = await injectApp({ token: CANARY, upstreamPort, gatewayAddresses: [addr], listenHost: '0.0.0.0' });
    // Host 必须写成本机字面量：合取的另一半由**外层 origin 钩子**先判（`fetch` 还会把 Host 换成 URL 那个权威，
    // 所以这里用 rawRequest 自己发头 —— 那条实测记在 kernel.test.ts:301-310）。
    const ok = await rawRequest({
      connectHost: addr,
      port: gwApp.port,
      path: `${JUPYTER_BASE_URL}api/gateway-peer`,
      headers: { host: `127.0.0.1:${gwApp.port}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(ok.status, `对端 ${addr} 已被声明为这张网桥的网关，却被拒（${ok.status}）⇒ 网关那一半在隧道里没生效`).toBe(200);
    // **不许只看 200**：这一档的红是"没有那条路由"，而 SPA 回退对任何 GET 都回 200 + index.html ——
    // 那样这条用例会被"功能不存在"糊过去（本项目在 `kernelspecs` 键名上付过一次"假绿"的学费）。
    // 所以断的是**这份 body 来自假上游**：`{}` + 记录表里确实有这一段路径。
    expect(ok.body, '200 但回的不是上游那份 JSON ⇒ 是 SPA 回退，不是反代').toBe('{}');
    expect(seen.some((s) => s.url === `${JUPYTER_BASE_URL}api/gateway-peer`), '假上游没收到这一段路径 ⇒ 那个 200 与反代无关').toBe(true);
    // 回环对照：**注入了网关表的那一个**对端（127.0.0.1，不在表里但是回环）也必须放行 ——
    // 注入这个入参的语义是"往本机那一类里加一条"，不许把回环那一支换成替换（那是"收紧成只认注入表"，
    // 症状是容器里 curl 自己反而 403）。
    const loopbackControl = await rawRequest({
      connectHost: '127.0.0.1',
      port: gwApp.port,
      path: `${JUPYTER_BASE_URL}api/loopback-still-ok`,
      headers: { host: `127.0.0.1:${gwApp.port}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(loopbackControl.status, '回环对端在注入了网关表的实例里也必须放行（注入不许把回环那一支关掉）').toBe(200);
    expect(loopbackControl.body).toBe('{}');
  });

  it.skipIf(LAN_IPS.length === 0)(
    '对端不是本机（非回环、也不在注入的表里）⇒ 403 notebook_proxy_refused，即使 Host 写的是 127.0.0.1',
    async () => {
      // 这一条判的是**隧道的对端那一半**（`proxyGuard.test.ts` 判的是函数，外层 origin 钩子拦的是 Host，
      // "对端外来 + Host 本机"这个组合在真实 HTTP 上只有这里造得出来）。
      const addr = LAN_IPS[0]!;
      const foreign = await injectApp({ token: CANARY, upstreamPort, gatewayAddresses: [], listenHost: '0.0.0.0' });
      const res = await rawRequest({
        connectHost: addr,
        port: foreign.port,
        path: `${JUPYTER_BASE_URL}tree`,
        headers: { host: `127.0.0.1:${foreign.port}` },
      });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { error?: string }).error).toBe('notebook_proxy_refused');
      expect(res.body, '否决消息不许回显对端地址（外部输入会进日志）').not.toContain(addr);
      expect(seen.length, '否决发生在注入之前 ⇒ 上游不该看见这一次').toBe(0);
    },
  );
});

describe('/jupyter 同源反代：响应方向与路由地盘', () => {
  it('响应方向也搬运：上游回 text/html 时我们给它补上 frame-ancestors，并原样搬 302 的 Location', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}redir`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${JUPYTER_BASE_URL}login?next=${JUPYTER_BASE_URL}redir`); // 上游自己带前缀，我们不重写
    const doc = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(doc.headers.get('content-type')).toContain('text/html');
    expect(doc.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(doc.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  /**
   * 评审 I-C：**避让那一支才是生产天天走的支**（真 jupyter 树页自带
   * `Content-Security-Policy: frame-ancestors 'self'; report-uri …`，2026-10-09 容器实测），
   * 而上一条测的是"上游没 CSP ⇒ 追加"那一支 —— 那一支在生产里不可达。
   * ⚠ 断言的形状是**计数**，不是 `toContain`：重复 `frame-ancestors` 会让浏览器把**整条 CSP 作废**
   * （CSP 规范的 fail 方式），而 `toContain` 在重复的 header 里照样命中 ⇒ 上一档那两条就是这么绿着放过故障的。
   * 破坏性验证（2026-10-09 实测）：把 `responseHeaders()` 里 `has ? csp : …` 那一支删成"永远追加"
   * ⇒ 本条红在"directive 出现了 2 次"，而上一条与容器档那条照绿。
   */
  it('上游自带 frame-ancestors 时**原样转发、不追加**（重复 directive 会让整条 CSP 在浏览器里作废）', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}csp`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    const sent = 'frame-ancestors \'self\'; report-uri /jupyter/api/security/csp-report';
    const out = res.headers.get('content-security-policy') ?? '';
    // ① 原样：输出**恰等于**输入（一个字节都不许多 —— 追加的那半在下面那条计数里）
    expect(out, '上游那份 CSP 被我们改写过 ⇒ 不许"顺手补"，它已经限了 frame-ancestors').toBe(sent);
    // ② 计数：这是本条真正的那颗牙（`toBe` 的红会打印两边，但**重复**这种形状只有数出来才判得住）
    const occurrences = (out.match(/frame-ancestors/gi) ?? []).length;
    expect(occurrences, 'frame-ancestors 出现不止一次 ⇒ 浏览器把整条 CSP 作废（静默的浏览器层失效，页面照旧能用）').toBe(1);
    // ③ XFO 也归我们写：上游那份 `DENY` 会被我们的 SAMEORIGIN 覆盖（嵌不进来的是上一段那个 403 判的语义）
    expect(res.headers.get('x-frame-options'), 'XFO 由这一层统一写 SAMEORIGIN；上游的 DENY/自定义值不许留下').toBe('SAMEORIGIN');
    // ④ 逐跳头不许从上游搬回浏览器（ws 的 101 那一支才有例外，见下面 websocket 那一组）
    expect(out, 'CSP 里被追加了 upgrade/connection 之类的东西 ⇒ 过滤器被改写').not.toMatch(/upgrade/i);
  });

  /**
   * 评审 I-B：**多值 `Set-Cookie` 的搬运此前零判据**（两档 grep `set-cookie` 都是 0 命中）。
   * 实测今天的行为是对的（真 jupyter 发 2 条独立行，隧道原样搬），但"顺手折成单串"之后
   * jupyter 的会话 cookie 与 `_xsrf` 会**静默丢**：主流程靠每请求注入 `Authorization` 还能走，
   * 于是页面照常用、没人报警，直到下一次登录流/会话粘性故障才现形且难归因。
   * 判据用**数组长度**（fetch 的 `getSetCookie()` 与 node:http 的数组两条都判：两条路径形状不同，
   * Node 把 `set-cookie` 藏在 `getSetCookie()` 里，见 `proxy.ts` 那段注释）。
   */
  it('上游的两条 Set-Cookie 必须是**两条**（不许被折成一串 —— 会话与 _xsrf 会静默丢）', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}csp`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length, `上游发了 2 条 Set-Cookie，客户端只收到 ${cookies.length} 条 ⇒ 被折成了一串（浏览器会把它们当一条畸形 cookie 丢掉）`).toBe(2);
    expect(cookies[0]).toBe('username-8888=abc123; Path=/; SameSite=Lax');
    expect(cookies[1]).toBe('_xsrf=2|deadbeef; Path=/');
    // 对照组走 node:http 那一侧（fetch 与 node 的 header 归一化不同：两边都得是两条才算搬对了）
    const raw = await rawRequest({
      connectHost: '127.0.0.1',
      port: appPort,
      path: `${JUPYTER_BASE_URL}csp`,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(raw.status).toBe(200);
    const rawCookies = raw.headers['set-cookie'];
    expect(Array.isArray(rawCookies), 'node:http 那侧收到的不是数组 ⇒ 只剩一条了').toBe(true);
    expect((rawCookies ?? []).length, 'node:http 那侧的 Set-Cookie 条数与 fetch 不一致 ⇒ 有一边被合成了单串').toBe(2);
  });

  it('上游没在听（ECONNREFUSED）⇒ 502 + 一句"容器里的 Jupyter 没起来"，而不是把 socket 挂死', async () => {
    const down = await injectApp({ token: CANARY, upstreamPort: 1 }); // 1 端口没人听
    const res = await fetch(`http://127.0.0.1:${down.port}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('notebook_upstream_unreachable');
    expect(body.message ?? '', '这句话要说得出去查 jupyter，而不是把"你不许"与"它没起来"说成同一件事').toContain('127.0.0.1:1');
    expect(JSON.stringify(body), '连 502 的响应里都不许出现凭据').not.toContain(CANARY);
  });

  it('反代不抢 SPA 的地盘：/jupyter 之外的路径仍走原来的路由（`/` 是 index.html，`/api/health` 照常）', async () => {
    const health = await fetch(`http://127.0.0.1:${appPort}/api/health`);
    expect(health.status).toBe(200);
    // 反代注册的是 `/jupyter/*`，`/jupyter`（不带尾斜杠）不在通配里 —— 人会手敲它，不许 404 掉。
    const bare = await fetch(`http://127.0.0.1:${appPort}${NOTEBOOK_PREFIX}`, { redirect: 'manual' });
    expect(bare.status, '没有那条补位跳转时这里会是 200 + index.html（SPA 回退），看起来"能用"但落点错了').toBe(302);
    expect(bare.headers.get('location')).toBe(`${JUPYTER_BASE_URL}`);
  });
});

// ──────────────────── 第二条通道：websocket 隧道 ────────────────────

/**
 * WI-94 Task 4：内核↔页面那条 websocket（`/jupyter/api/kernels/<id>/channels`）。
 *
 * 为什么单独一组：**它不在路由表里**。`app.server.on('upgrade', …)` 是唯一能碰到它的地方，
 * 于是 Fastify 的 `onRequest` 钩子与 HTTP 那侧的 handler **都**不会替我们判任何东西 ⇒
 * 守卫必须在 `upgrade` 事件里再调一次同一个 `guardNotebookProxy`（`proxyGuard.ts` 顶部那段"两条通道
 * 只调这一个函数"的分工，Task 4 就是它的另一半）。"HTTP 上拦住了"在这档**不等于**"另一条通道也拦住了"
 * —— 那是 brief Step 4 变异②的实测对象。
 *
 * 这里**不做真的 websocket 帧**：隧道判的是 101 之后的**字节搬运**，字节级测试才是它的单元测试；
 * 真 ws 语义 + 真内核 + 真帧往返归容器档（`embed.test.ts` 那条"跑起来一次"）。
 */
describe('/jupyter 同源反代：websocket 隧道（第二条通道）', () => {
  /** 浏览器那侧的握手长这样：GET + 那两个逐跳头 + key/version。**没有** Authorization（原生 WebSocket 加不了头）。 */
  function handshakeRequest(opts: {
    port: number;
    path: string;
    secFetchSite?: string;
    extraHeaders?: string;
    tail?: Buffer;
  }): Promise<{ socket: Duplex; headBlock: Buffer }> {
    const sock = net.connect(opts.port, '127.0.0.1');
    // 同上面那条纪律：客户端这边被对端 RST 时的 'error' 必须就地接住，否则死的是整个 worker
    // （而"用例挂到超时才给结论"是最难读的红）。断连之后 `readRaw` 会撞到它自己的 deadline，那句话才是结论。
    sock.on('error', () => undefined);
    return once(sock, 'connect')
      .then(() => {
        const text =
          `GET ${opts.path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${opts.port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          (opts.secFetchSite === undefined ? '' : `Sec-Fetch-Site: ${opts.secFetchSite}\r\n`) +
          (opts.extraHeaders ?? '') +
          '\r\n';
        sock.write(Buffer.concat([Buffer.from(text, 'latin1'), opts.tail ?? Buffer.alloc(0)]));
        return readRaw(sock, { marker: '\r\n\r\n' }).then((headBlock) => ({ socket: sock as Duplex, headBlock }));
      });
  }

  it('ws 握手：上游拿到 ?token=（我们那份），客户端塞的那份被摘，101 之后双向字节都到得了', async () => {
    const up = await startWsEcho();
    wsUpstreams.push(up);
    const wsApp = await injectApp({ token: CANARY, upstreamPort: up.port });
    const { socket, headBlock } = await handshakeRequest({
      port: wsApp.port,
      path: `${JUPYTER_BASE_URL}api/kernels/deadbeef/channels?session_id=1&token=injected-by-client`,
      secFetchSite: 'same-origin',
      // 两条 Cookie + 两条子协议：`joinDuplicateHeaders` 默认 false ⇒ node 两侧都给数组，
      // 于是"数组进、数组出"在**握手方向**上也有判据（评审 §12.2：I-B 那颗牙对 ws 同样适用）。
      // `te` 是**故意多发**的一条：逐跳头的例外只能开在 101 **回话**那一支，请求方向仍然不许漏。
      extraHeaders: 'Cookie: a=1\r\nCookie: b=2\r\nSec-WebSocket-Protocol: p1\r\nSec-WebSocket-Protocol: p2\r\nte: trailers\r\n',
    });
    const head = headBlock.toString('latin1');
    expect(head.startsWith('HTTP/1.1 101'), `握手没成 101（回来的第一行是 ${JSON.stringify(head.split('\r\n')[0] ?? '')}）`).toBe(true);
    expect(head.toLowerCase()).toContain('sec-websocket-accept');
    // 101 的**两个头例外**：`Upgrade` 与 `Connection` 是"这是一个 101"的组成部分（RFC 6455 的握手回话必须带，
    // Firefox 缺 `Connection` 直接判失败）。把它们按"逐跳头不许转发"的一般规则"顺手修正"掉，
    // 本仓库只有这一条判据抓得住 —— 宿主之外的浏览器才会看到那个故障。
    expect(head.toLowerCase()).toContain('upgrade: websocket');
    expect(head.toLowerCase()).toContain('connection: upgrade');
    // 评审 I-B 的 ws 那一半：两条 Set-Cookie 必须是两行（折成一行浏览器只收到一条畸形 cookie）
    expect((head.toLowerCase().match(/set-cookie:/g) ?? []).length, '上游 101 里的 Set-Cookie 条数被改了 ⇒ 会话 cookie 会静默丢').toBe(2);

    // 隧道建好之后按字节 echo：证明这条 socket 是**双向** pipe 的，不是只把客户端那半连上。
    // ⚠ 先把假上游写在 101 **同一个包里**的那 10 个字节读掉：不读的话这里"echo 回来的 4 个字节"
    //   实际读到的是 `uhea`（那是夹具的字节顺序问题，红起来会把"隧道坏了"这句话撒成谎 ——
    //   2026-10-09 实测到的第一红就是这个形状：`expected [117,104,101,97] to deeply equal [1,2,170,187]`）。
    //   那一支自己的判据在下面那条"同一个包里跟来的字节"用例里。
    const uhead = await readRaw(socket, { bytes: 10 });
    expect(uhead.toString('latin1'), '假上游写在 101 同一包里的字节没搬过来（下面那条 echo 判据的前提）').toBe('uheadbytes');
    socket.write(Buffer.from([0x01, 0x02, 0xaa, 0xbb]));
    const echoed = await readRaw(socket, { bytes: 4 });
    expect([...echoed]).toEqual([0x01, 0x02, 0xaa, 0xbb]);
    socket.destroy();
    // 上游那一侧收到的握手：我们的 token 在、客户端塞的那份没了
    const got = seen.at(-1)!;
    expect(got.method).toBe('UPGRADE');
    expect(got.url).toContain(`token=${CANARY}`);
    expect(got.url).not.toContain('injected-by-client');
    // 别的查询参数不许被"摘 token"顺手带走（ws 的 session_id 就是这个形状）
    expect(got.url).toContain('session_id=1');
    // 握手方向的多值头原样搬运（评审 §12.2：I-B 那颗牙对 ws 同样适用）—— 数组进、数组出
    expect(got.headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(got.headers['authorization'], '凭据也写进了 header 那一份（查询串是给浏览器用的，这两份并存是设计：见 proxy.ts）').toBe(`token ${CANARY}`);
    // ⚠ 实测到的形状与直觉不同：客户端发**两条** `Cookie:` / 两条 `Sec-WebSocket-Protocol:` 行时，
    // 上游各收到**一条**（`a=1; b=2` 与 `p1, p2`）。那不是隧道的作为，是 Node 的归一化 ——
    // 服务端侧 `_http_server.js` 对重复头分别按 `'; '`（cookie 这类）与 `', '`（其余）合并，
    // 客户端侧 `_http_outgoing.js` 的 `_storeHeader` 又对非 `set-cookie` 的数组值 `join('; ')`
    // （2026-10-09 用 `node -e` 起一台 echo 服务器单独测过，不经隧道也是这个形状）。
    // ⇒ 这里判的是"**两条值都没丢、顺序没乱**"（把数组写成 `String(v)` 或 `v[0]` 的写法会在这里红），
    // **不判行数**；行数的判据在**回话方向**（上面那条 `set-cookie` == 2 行），那一支才是
    // 我们自己的代码写的（`upgradeResponseLines`：数组 → 多行）。
    expect(String(got.headers['cookie']), '两条 Cookie 合并后丢了第二条').toBe('a=1; b=2');
    expect(String(got.headers['sec-websocket-protocol']), '子协议合并后丢了第二条').toBe('p1, p2');
    // 逐跳头例外**只在握手这一支**：其余逐跳头仍然不许漏到上游
    expect(got.headers['te'], 'te 之类的逐跳头被搬进了握手请求 ⇒ 例外写得太宽了').toBeUndefined();
  });

  it('握手同一个包里就跟来的字节：客户端那截写进上游 socket、上游那截写进客户端 socket（都不许写进 upstreamReq）', async () => {
    const up = await startWsEcho();
    wsUpstreams.push(up);
    const wsApp = await injectApp({ token: CANARY, upstreamPort: up.port });
    // 客户端把握手与 4 个字节**合成一次写** ⇒ 它们到隧道这边就是 upgrade 事件的 `head`（非空）。
    // 上游同样把 101 与 `uheadbytes` 合成一次写 ⇒ 隧道要交给我们的是 `uhead`。
    // 为什么这两支要紧：`head` 若写进那个没有 content-length 的 `upstreamReq`，Node 会改成 chunked
    // 编码再发出去 ⇒ 握手被写成乱码，症状是"偶尔连不上、复现不了"。
    const { socket, headBlock } = await handshakeRequest({
      port: wsApp.port,
      path: `${JUPYTER_BASE_URL}api/kernels/cafe/channels`,
      secFetchSite: 'same-origin',
      tail: Buffer.from([0x10, 0x20, 0x30, 0x40]),
    });
    expect(headBlock.toString('latin1').startsWith('HTTP/1.1 101')).toBe(true);
    const uhead = await readRaw(socket, { bytes: 10 });
    expect(uhead.toString('latin1'), '上游 101 之后同一包里的字节没到客户端 ⇒ `uhead` 那一支坏了').toBe('uheadbytes');
    const echoed = await readRaw(socket, { bytes: 4 });
    expect([...echoed], '客户端握手同一包里的尾字节没到上游 ⇒ `head` 那一支坏了（或被写进了 upstreamReq）').toEqual([0x10, 0x20, 0x30, 0x40]);
    socket.destroy();
  });

  it('ws 也要过守卫：cross-site 的握手被拒（403 + JSON），且上游一个 upgrade 都没收到', async () => {
    const up = await startWsEcho();
    wsUpstreams.push(up);
    const wsApp = await injectApp({ token: CANARY, upstreamPort: up.port });
    const before = up.upgrades();
    const { socket, headBlock } = await handshakeRequest({
      port: wsApp.port,
      path: `${JUPYTER_BASE_URL}api/kernels/deadbeef/channels`,
      secFetchSite: 'cross-site',
    });
    const head = headBlock.toString('latin1');
    expect(/^HTTP\/1\.1 403/.test(head), `跨站握手没被守卫否决（第一行是 ${JSON.stringify(head.split('\r\n')[0] ?? '')}）⇒ "能打开页面"就变成了"能绕过页面执行代码"`).toBe(true);
    expect(head.toLowerCase()).toContain('content-type: application/json');
    // error 码在 **body** 里（头块只读到 `\r\n\r\n`）：这一半判的是"否决说的是哪一件事"
    const body = await readJsonBody(socket, headBlock);
    expect((JSON.parse(body) as { error?: string }).error, '403 但不是守卫那一条 ⇒ 拦它的是别的东西').toBe('notebook_cross_site');
    // 否决消息里不许回显外部输入，也不许出现凭据
    expect(body.toLowerCase()).not.toContain(CANARY.toLowerCase());
    expect(up.upgrades(), `上游收到了 ${up.upgrades() - before} 次 upgrade ⇒ 否决发生在**发给上游之后**`).toBe(before);
    socket.destroy();
  });

  it('这台实例没有 token ⇒ ws 握手也是 503 + notebook_not_configured（不许"能握手但没凭据可用"）', async () => {
    const up = await startWsEcho();
    wsUpstreams.push(up);
    const noTok = await injectApp({ token: '', upstreamPort: up.port });
    const { socket, headBlock } = await handshakeRequest({
      port: noTok.port,
      path: `${JUPYTER_BASE_URL}api/kernels/deadbeef/channels`,
      secFetchSite: 'same-origin',
    });
    const head = headBlock.toString('latin1');
    expect(/^HTTP\/1\.1 503/.test(head), '没有 token 时握手应当被明确否决（503），而不是升级到一半再断').toBe(true);
    const body = await readJsonBody(socket, headBlock);
    expect(body, '那句话必须是"这台没有 notebook 服务"，不是"你不许"').toContain('notebook_not_configured');
    expect(body.toLowerCase(), '503 的响应里不许出现凭据').not.toContain(CANARY.toLowerCase());
    expect(up.upgrades(), '上游不该看见这一次握手').toBe(0);
    socket.destroy();
  });

  it('上游不肯升级（回 4xx）⇒ 客户端收到那句状态行，而不是静默断连', async () => {
    const refusal = await startWsRefusal();
    wsUpstreams.push(refusal);
    const wsApp = await injectApp({ token: CANARY, upstreamPort: refusal.port });
    const { socket, headBlock } = await handshakeRequest({
      port: wsApp.port,
      path: `${JUPYTER_BASE_URL}api/kernels/deadbeef/channels`,
      secFetchSite: 'same-origin',
    });
    const head = headBlock.toString('latin1');
    // 静默断连是这一层最难查的故障（"页面转圈、控制台什么都不说"）：状态码必须原样回话
    expect(/^HTTP\/1\.1 404/.test(head), `上游不肯升级时应当把它的 4xx 回话搬给客户端（第一行是 ${JSON.stringify(head.split('\r\n')[0] ?? '')}）`).toBe(true);
    expect(head.toLowerCase()).toContain('connection: close');
    socket.destroy();
  });

  /**
   * "反代不抢地盘"在 upgrade 这一层的版本。为什么必须有：
   * Node 的 `http.Server` 只要**有**人听 `upgrade`，就**所有** upgrade 都交给监听者，而且派发之前
   * 已经把这条 socket 的 parser 拆了（容器里 `node -e "process.binding('natives')._http_server"` 读到的
   * `parserOnIncoming` / `onParserExecuteCommon`：`req.upgrade = … || !!server.shouldUpgradeCallback(req)`，
   * 于是默认 `shouldUpgradeCallback = () => this.listenerCount('upgrade') > 0` 一变 true，
   * 请求就**不再**走 requestListener）。⇒ 一句 `return` 会让别人家的 upgrade 客户端**挂死**，
   * 而"挂死的门禁比红更坏"是本项目写进规则的教训。
   * 做法：把 `server.shouldUpgradeCallback` 收窄成"只认领 `/jupyter/` 那棵子树"，非我们那棵原样交回
   * 给 Node 的默认判据（实测：宿主 Node 24.10.0 与容器 Node 24.10.0 都有那个可写属性）。
   */
  it('不是 /jupyter/ 那棵子树的 upgrade 我们不接管：那条仍走原来的路由，且不挂死', async () => {
    const wsApp = await injectApp({ token: CANARY, upstreamPort });
    const server = wsApp.app.server;
    const narrowingAvailable = typeof (server as { shouldUpgradeCallback?: unknown }).shouldUpgradeCallback === 'function';
    // 永远会跑的解释断言：这台 Node 上有没有那个开关决定我们走哪一支（不许"以为劫持了就安静了"）
    expect(
      narrowingAvailable || true,
      '本条按两种 Node 形状都成立：有 shouldUpgradeCallback ⇒ 交回路由；没有 ⇒ 显式回话再断，两者都不许挂死',
    ).toBe(true);
    const { socket, headBlock } = await handshakeRequest({
      port: wsApp.port,
      path: '/api/health', // 别人的地盘：健康检查，不该被隧道吃掉
      secFetchSite: 'same-origin',
    });
    const head = headBlock.toString('latin1');
    expect(head.startsWith('HTTP/1.1 101'), '非 /jupyter/ 的 upgrade 被隧道劫走了').toBe(false);
    if (narrowingAvailable) {
      // 交回原来的路由 ⇒ 今天的行为不变：`/api/health` 仍是 200 的 JSON
      expect(head.split('\r\n')[0], '收窄后的判据把这条交回了路由，但路由没答话（回来的第一行不对）').toBe('HTTP/1.1 200 OK');
      expect(head.toLowerCase()).toContain('content-type: application/json');
    } else {
      // 这台 Node 没有那个开关：隧道必须**显式**回一句话再断（静默 = 挂死）
      expect(/^HTTP\/1\.1 4\d\d/.test(head), '没有 shouldUpgradeCallback 时，不归我们的 upgrade 必须被显式拒绝而不是挂死').toBe(true);
    }
    socket.destroy();
  });
});

describe('隧道自己的两个纯函数（Task 4 的 websocket 通道共用同一份）', () => {
  it('proxiedPath：HTTP 通道只摘不附，握手通道把我们的那份附进查询串', async () => {
    const { proxiedPath } = await import('../../src/notebooks/proxy.js');
    expect(proxiedPath('/jupyter/api/contents?token=evil', CANARY, false)).toBe('/jupyter/api/contents');
    expect(proxiedPath('/jupyter/api/contents?a=1&token=evil', CANARY, false)).toBe('/jupyter/api/contents?a=1');
    // 浏览器给原生 WebSocket 设不了请求头 ⇒ 握手只能走查询串（`viaQuery=true`），
    // 而它**不许**把客户端那份留下：先删再设，所以 evil 不会与 CANARY 同时在场上。
    const ws = proxiedPath('/jupyter/api/kernels/abc/channels?token=evil', CANARY, true);
    expect(ws).toContain(`token=${encodeURIComponent(CANARY)}`);
    expect(ws).not.toContain('evil');
    expect(proxiedPath('/jupyter/tree', CANARY, false)).toBe('/jupyter/tree');
  });

  it('buildUpstreamHeaders：逐跳头剥掉、host/origin/authorization 三样重写，其余原样', async () => {
    const { buildUpstreamHeaders } = await import('../../src/notebooks/proxy.js');
    const out = buildUpstreamHeaders(
      {
        host: '127.0.0.1:7788',
        origin: 'http://127.0.0.1:7788',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        cookie: 'jupyter-token-server=jts',
        'x-custom': 'keep-me',
        'content-type': 'application/json',
      },
      '127.0.0.1:8888',
      CANARY,
    );
    expect(out['host']).toBe('127.0.0.1:8888');
    expect(out['origin']).toBe('http://127.0.0.1:8888');
    expect(out['authorization']).toBe(`token ${CANARY}`);
    expect(out['te']).toBeUndefined();
    expect(out['connection']).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    // `upgrade` 也在逐跳表里 —— Task 4 的握手要**另外**自己带它，不许靠这里漏过去的一份。
    expect(out['upgrade']).toBeUndefined();
    expect(out['x-custom']).toBe('keep-me');
    expect(out['cookie']).toBe('jupyter-token-server=jts');
    expect(out['content-type']).toBe('application/json');
  });

  it('那三件重写不许写成"status.ts 那个合取"：守卫否决的是整个请求，status 只是不附凭据', async () => {
    // 结构判据（不是文案判据）：proxy.ts 里唯一的放行判断必须是 guardNotebookProxy 那**一处**调用。
    // 这条拦的是"顺手在隧道里再判一条"（本仓库反复付学费的形状：两条通道各写一遍判据）。
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(process.cwd(), 'server', 'src', 'notebooks', 'proxy.ts'), 'utf8');
    // 只数**代码行**（第一版数全文，结果被文件头那段注释里的函数名撞成 2 —— 注释不是第二次调用）。
    const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    // ⚠ Task 4 之后这个数是 **2**，不是 1：**两条通道各一次**（HTTP handler 里一次、`upgrade` 事件里一次，
    // 调的是同一个函数）。"只有一处"讲的是"**只有一套判据**"，不是"**只调用一次**"：
    // websocket 不在路由表里，Fastify 的钩子与 HTTP handler 都碰不到它，所以它**必须**再调一次，
    // 否则"能打开页面"就变成"能绕过页面执行代码"（Task 4 变异②摘掉的正是 upgrade 里那一次）。
    // 摘掉任何一次 ⇒ 计数变 1 ⇒ 本条红；而那一次被摘的**行为**后果由上面那两条 cross-site 用例判。
    expect(code.filter((line) => line.includes('guardNotebookProxy(')).length, '隧道应当**每条通道各一次**调用同一个守卫（HTTP 一次 + upgrade 一次；判据本体住 proxyGuard.ts）').toBe(2);
    expect(code.join('\n'), '隧道不许自带第二套对端判据（那是 status.ts 那一半的语义，折进来会把"照样给链接"变成 403）').not.toMatch(/isLocalPeer|isLoopbackHostHeader|localGatewayAddresses/);
  });
});
