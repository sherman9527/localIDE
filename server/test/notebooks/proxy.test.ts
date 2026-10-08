import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as nodeHttpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
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
 * - **凭据**：全程 canary，永不打印；断言里可以判"响应体不含 token"，失败消息不许把值打出来。
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

const CANARY = 'proxy-test-token-7d3a'; // 永不打印；只在断言里比对
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
 * 按路径分三种回话：回显 / 302+Location / 无 CSP 的 HTML —— 响应的**搬运方向**也要有被测对象。
 * 只回显请求的那一版判不住"上游的 302 被我们改成 200"这种故障。
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

beforeAll(async () => {
  upstreamPort = await startEcho();
});

beforeEach(async () => {
  seen.length = 0;
  made = await injectApp({ token: CANARY, upstreamPort });
  appPort = made.port;
});

afterEach(async () => {
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
   * ⚠ **这一档不能照 `notebook-api.test.ts` 那样"由被测请求产生那条日志"**：反代的成功路径走
   * `reply.hijack()`，Fastify 从此不再碰这条响应（`node_modules/fastify/lib/reply.js:134-154` 的
   * `hijack()` 只是打 `kReplyHijacked` 标记，而 `onResponse` 挂在 `reply.send()` 那条收尾链上），
   * 于是**被代理的请求一条日志都不会写**，`existsSync(log.file())` 会在每一个代理用例里假红。
   * 所以这里由 afterEach 自己经**同一份模块图**的 log 模块塞一条 marker 记录（`logInfo`），
   * 于是"marker 在 flush 之后的文件里"就是"排空排在删之前"的实测证据，不依赖被测路径会不会写日志。
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
    expect(code.filter((line) => line.includes('guardNotebookProxy(')).length, '隧道里应当**只有一处**调用守卫（判据本体住 proxyGuard.ts）').toBe(1);
    expect(code.join('\n'), '隧道不许自带第二套对端判据（那是 status.ts 那一半的语义，折进来会把"照样给链接"变成 403）').not.toMatch(/isLocalPeer|isLoopbackHostHeader|localGatewayAddresses/);
  });
});
