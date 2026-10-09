import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, request as nodeHttpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type AddressInfo, type Socket as NetSocket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JUPYTER_BASE_URL, NOTEBOOK_PREFIX } from '@arena/shared';
import { config } from '../../src/config.js';
import { guardNotebookProxy } from '../../src/notebooks/proxyGuard.js';
import { localGatewayAddresses } from '../../src/notebooks/status.js';

/**
 * WI-94 **Task 3 与 Task 4 的容器档**：`/jupyter/*` 同源反代（HTTP 隧道 + websocket 隧道）打在**真 Jupyter** 上。
 * （Task 4b 那两条"穿过隧道真跑一行代码 / cross-site 的 ws 握手"也在本文件里，不在别处。）
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
 * ## 凭据纪律（两个方向都要各判一次）
 *
 * 断言**不许**把凭据值写进失败消息：`expect(body).not.toContain(token)` 这种朴素写法在红的时候会把
 * "期望不包含的那一串"原样印进报告（本档第一版就是这样，一条红就把长期凭据写进了测试输出）。
 * 所以判"含不含凭据"一律走 `holdsToken()` 那一个布尔；值本身也从不进任何 `console`。token 为空时这条判据没有意义 ⇒ 前置断言会把它说成一句话而不是空过。
 *
 * ⚠ 另一半是 Task 3 评审 I-A / Task 4 评审 I-4 补的，`proxy.test.ts` 顶部"纪律"那一段写的就是这句话：
 * **actual 里可能含真凭据的断言，也不许把 actual 交给 matcher** —— `toContain`/`toBe` 红的时候打印的是
 * **actual**（`Failed Tests` 那一块的 `Received:` 是完整未截断的字符串），不只是 `not.toContain` 会打印期望值。
 * 本档第 1 条"回来的确实是那份 HTML"原来正是 `expect(res.body.toLowerCase()).toContain('<html')`，而**同一条
 * 用例下面**自己钉着"经隧道与直连的那份树页都含真凭据"（jupyter 把 token 写进 PageConfig）⇒ 一次偶发红就把
 * 整页（含小写化后的 token）写进测试输出。现在它先算布尔、再判布尔：**"页面形状"这一类判据不碰 body 本身**。
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

// ──────────── Task 4b：手工 websocket 客户端（判的是隧道，不是 RFC 6455 的实现） ────────────

/**
 * 这一小块**故意手搓**（掩码、扩展长度、拆帧），三条理由都承重：
 * ① 不引新依赖是硬约束，而 `ws` 在这里只是传递包 —— 把它当直接依赖用，下次装包树一变就静默没掉；
 * ② 要判的是"**我们那层**在 101 之后搬运字节"，拿现成客户端会把隧道的毛病与库的行为混成一锅；
 * ③ 浏览器原生 WebSocket 不给请求头 ⇒ 生产上凭据只能走查询串，只有手搓才看得见我们发出去的每一个字节。
 *
 * 实测的形状（2026-10-09 在跑着的容器里，见 task-4b-report.md §2 原文）：
 * - `POST /jupyter/api/sessions` ⇒ **201**，`model.kernel.id` 直接可用；`model.kernel.execution_state` 是
 *   `"starting"`，而且**会一直停在 `starting`** —— REST 那份状态是 jupyter 从 iopub 抄来的，
 *   而没有 ws 客户端接上时它压根不读 iopub。⇒ **不许"先轮询 execution_state 等到 idle 再连 ws"**：
 *   那条在这个容器里永远等不到（第一版照 brief 写成轮询就会挂在这上面）。
 * - 握手回话的头：`HTTP/1.1 101 Switching Protocols` + `server: TornadoServer/6.5.10` +
 *   `upgrade: websocket` + `connection: Upgrade` + `sec-websocket-accept` + 一条 `set-cookie`；**没有凭据**。
 * - 帧：opcode `0x1`（text），信封的 `channel` 在**顶层**（`iopub` / `shell`），
 *   `parent_header` 是**扁平的**（`parent_header.msg_id`，不是 `parent_header.header.msg_id`）。
 * - ⚠ 头几帧是**内核自己的启动/回放 status**，它们的 `parent_header.msg_id` 不是我们的那条 ——
 *   所以"收到一条 stream 里带 42"必须**按 parent msg_id 认领**，否则会拿别人的输出当自己的功劳（假绿）。
 * - ⚠ 一次 TCP chunk 里会**同时到好几帧**（实测 chunk 尺寸 `[631, 4311]`、`[625, 6807]`），
 *   而一帧也可能跨两个 chunk ⇒ 拆帧必须带"剩字节"记账，不能按 chunk 一条一条解。
 * - ⚠ 我们那条 `execute_request` 的 JSON 是 **242~332 字节** ⇒ 走的是"16 位扩展长度"那一档。
 *   第一版探针把长度字节写成 `0x80 | payload.length`（>125 时溢出），jupyter 收到畸形帧、
 *   **一帧都不回**：症状与"隧道坏了"一模一样。这就是"先手测再落地"救下来的那条。
 */

/** RFC 6455 握手校验的固定串：`sec-websocket-accept = base64(SHA1(key + 这个))`。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 客户端→服务端**必须** mask；`payload.length > 125` 时必须走 126/127 两档扩展（见上面那条实测）。 */
function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
  const fixed: number[] = [0x81]; // FIN | text
  const extra: Buffer[] = [];
  if (payload.length < 126) fixed.push(0x80 | payload.length);
  else if (payload.length < 65536) {
    fixed.push(0x80 | 126);
    const l = Buffer.alloc(2);
    l.writeUInt16BE(payload.length);
    extra.push(l);
  } else {
    fixed.push(0x80 | 127);
    const l = Buffer.alloc(8);
    l.writeBigUInt64BE(BigInt(payload.length));
    extra.push(l);
  }
  return Buffer.concat([Buffer.from(fixed), ...extra, maskKey, masked]);
}

/** 服务端→客户端**不许** mask ⇒ 只有 2/4/10 字节头。返回"能解出来的帧"与"还没齐的尾巴"。 */
function decodeServerFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const opcode = (buf[off] ?? 0) & 0x0f;
    const first = buf[off + 1] ?? 0;
    const masked = (first & 0x80) !== 0;
    let len = first & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      head = 10;
    }
    if (masked) head += 4;
    if (buf.length - off < head + len) break;
    frames.push({ opcode, payload: buf.subarray(off + head, off + head + len) });
    off += head + len;
  }
  return { frames, rest: buf.subarray(off) };
}

interface WsConn {
  socket: NetSocket;
  statusLine: string;
  /** 整个握手回话的头（含状态行）。里面有 `set-cookie` ⇒ 永不放进任何断言消息，只许取具体头名。 */
  head: string;
  headers: Record<string, string[]>;
  /** 头之后**已经到达**的字节（`rejectUpgrade` 那句 JSON 就落在这里）。 */
  rest: Buffer;
  /** 没等到 `\r\n\r\n` 就对侧就断了 ⇒ 三态里的"握手根本没成形"。 */
  endedBeforeHead: boolean;
}

function parseHeadBlock(head: string): { statusLine: string; headers: Record<string, string[]> } {
  const lines = head.split('\r\n');
  const headers: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const cut = line.indexOf(':');
    if (cut < 0) continue;
    const key = line.slice(0, cut).trim().toLowerCase();
    (headers[key] ??= []).push(line.slice(cut + 1).trim());
  }
  return { statusLine: lines[0] ?? '', headers };
}

/**
 * 打开一条真 socket、发出 ws 握手、等回话的头。**'error' 与 'close' 都就地接住**：
 * 被 `rejectUpgrade` 断掉是这条路径的**正常结局之一**，而逃出去的 'error' 会
 * **把整个 vitest worker 崩掉、一个结论都没有**（Task 4 宿主档实测；本仓库同类事故是那条
 * `void` 掉的 async 拒绝把服务带走）。
 */
function openNotebookWs(opts: { pathWithQuery: string; headers: Record<string, string>; deadlineMs: number }): Promise<WsConn> {
  return new Promise((resolve) => {
    const socket = net.connect(APP_PORT, '127.0.0.1');
    let acc = Buffer.alloc(0);
    let settled = false;
    const finish = (endedBeforeHead: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cut = acc.indexOf('\r\n\r\n');
      const headLen = cut < 0 ? acc.length : cut;
      const parsed = parseHeadBlock(acc.subarray(0, headLen).toString('utf8'));
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      resolve({ socket, ...parsed, head: acc.subarray(0, headLen).toString('utf8'), rest: cut < 0 ? Buffer.alloc(0) : acc.subarray(cut + 4), endedBeforeHead });
    };
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.includes('\r\n\r\n')) finish(false);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(true), opts.deadlineMs);
    socket.on('error', () => finish(true));
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('connect', () => {
      const lines = Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`GET ${opts.pathWithQuery} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    });
  });
}

const WS_HANDSHAKE_DEADLINE_MS = 15_000;

/** 握手请求头：`Host` 必须是本机字面量（外层 origin 钩子先看它），`Sec-WebSocket-Key` 是 16 字节随机数的 base64。 */
function wsHandshakeHeaders(pathKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${APP_PORT}`,
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': pathKey,
    'sec-websocket-version': '13',
    ...extra,
  };
}

const expectedAcceptOf = (key: string): string => createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');

/**
 * 信封里**只留判据要的那几个字段**：原文可能含 cookie / 内部路径，而且失败消息会打印 actual，
 * 所以这里一次性收窄，调用方拿不到整串（凭据纪律的另一半：Task 3 实测过两种泄露方向）。
 */
interface JupyterEnvelopeLite {
  msgType: string;
  channel: string;
  parentMsgId: string;
  contentStatus: string;
  textHas42: boolean;
}

function toEnvelopeLite(raw: string): JupyterEnvelopeLite {
  let m: Record<string, unknown> = {};
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { msgType: '', channel: '', parentMsgId: '', contentStatus: '', textHas42: false };
  }
  const header = (m.header ?? {}) as Record<string, unknown>;
  const parent = (m.parent_header ?? {}) as Record<string, unknown>;
  const content = (m.content ?? {}) as Record<string, unknown>;
  return {
    msgType: String(header.msg_type ?? ''),
    channel: String(m.channel ?? ''),
    parentMsgId: String(parent.msg_id ?? ''), // 实测：扁平，不是 parent_header.header.msg_id
    contentStatus: String(content.status ?? ''),
    textHas42: String(content.text ?? '').includes('42'),
  };
}

interface FrameDrain {
  envelopes: JupyterEnvelopeLite[];
  nonTextOpcodes: number[];
  timedOut: boolean;
  /** 搬运的字节里出现过凭据 —— 只回布尔，值永不在场。 */
  leakedToken: boolean;
}

/** 一直读到 `stopWhen` 命中 / 对侧断 / 超时。三态里的第二、第三态靠它给结论。 */
async function drainFrames(conn: WsConn, opts: { deadlineMs: number; stopWhen: (e: JupyterEnvelopeLite) => boolean }): Promise<FrameDrain> {
  const envelopes: JupyterEnvelopeLite[] = [];
  const nonTextOpcodes: number[] = [];
  let leakedToken = false;
  let buffer = conn.rest;
  conn.rest = Buffer.alloc(0);
  let closed = false;
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeServerFrames(buffer);
    buffer = rest;
    for (const f of frames) {
      if (f.opcode !== 0x1) {
        nonTextOpcodes.push(f.opcode);
        continue;
      }
      const text = f.payload.toString('utf8');
      if (holdsToken(text)) leakedToken = true;
      envelopes.push(toEnvelopeLite(text));
    }
  };
  const onClose = () => {
    closed = true;
  };
  conn.socket.on('data', onData);
  conn.socket.on('close', onClose);
  conn.socket.on('end', onClose);
  const deadline = Date.now() + opts.deadlineMs;
  let timedOut = true;
  while (Date.now() < deadline && !closed) {
    if (envelopes.some(opts.stopWhen)) {
      timedOut = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (envelopes.some(opts.stopWhen)) timedOut = false;
  conn.socket.removeListener('data', onData);
  conn.socket.removeListener('close', onClose);
  conn.socket.removeListener('end', onClose);
  return { envelopes, nonTextOpcodes, timedOut, leakedToken };
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
    // 评审 I-4（Task 3 的 I-A 那一笔账，随本档补上）：**形状判据也不许把 body 交给 matcher**。
    // 这份树页含真凭据（下面那条差分自己钉着），而 `toContain` 红的时候打印的是完整的 actual。
    // 判据本身一个字没松：还是"回来的必须是那份 HTML"，只是先算布尔、再判布尔。
    // 两个形状的差别是**在真容器里量的**（2026-10-09，同一条用例、同一个跑着的实例，只换断言形状）：
    //   旧形状红 ⇒ `1 failed | 15 passed (16)`、exit 1、报告 5980 字节、含 1 块 `Received:`，
    //     其中那份真凭据**逐字节**出现 0 次、**忽略大小写**出现 1 次 —— 与评审那句诚实定级吻合
    //     （`start.sh` 的 token 是 `A-Za-z0-9` 大小写敏感，`.toLowerCase()` 让它当场不可直接用；
    //      但任何去掉 `toLowerCase()` 的改写就变成逐字泄露，所以形状本身必须换掉）；
    //   新形状红 ⇒ 同样 `1 failed | 15 passed (16)`、exit 1，但报告 2138 字节、凭据出现 **0** 次（两种判法都是 0）。
    //   两次变异都**只换容器里那一份**（`docker cp` 进去、跑完把原字节 cp 回去），宿主工作树全程没动过；
    //   收尾再 `up -d --build` 一次，并核过 `/app` 那一份与宿主 md5 逐字相同。日志只在容器 /tmp 里落地并当场删掉。
    const looksHtml = res.body.toLowerCase().includes('<html');
    expect(looksHtml, '回来的不是那份 HTML ⇒ 可能被 SPA 兜底吃了（只回布尔：整页正文不进报告，那里头有 PageConfig 的凭据）').toBe(true);
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

  /**
   * **整个 WI-94 的功能判据**（brief Task 4 Step 3）：穿过那条隧道，**在一个真内核上执行一行代码，
   * 把结果读回来**。前面十条状态码全对也不等于"运行按钮能用" —— HTTP 那棵树通、
   * `upgrade` 那半条没接上，是完全可能的两种坏法（本仓库有过"接线在不在"判不出来的先例）。
   *
   * ### 为什么用 `python3` 而不用 `arena-pyspark`
   * 这一条判的是**通道**，与哪个内核无关；`arena-pyspark` 那份 180 秒的 JVM 启动已经有
   * `kernel.test.ts` 在判（那条 smoke 归它）。把 Spark 塞进每条容器判据会让整个阶段变成分钟级。
   *
   * ### 为什么是 sessions 而不是直接 POST kernels（两条都手测过）
   * 实测（`/tmp/wi94-t4b-probe4.out`）两条都成立：`POST /api/sessions` ⇒ **201** + `model.kernel.id`，
   * 随后 `GET .../channels?session_id=…` ⇒ **101**；`POST /api/kernels` ⇒ **201**，
   * 随后 `GET .../channels`（不带 session_id）⇒ 同样 **101**。选前者是因为**浏览器走的就是这条**
   * （notebook 页面先建 session），而且顺带钉住"DELETE session 会把它的内核一起带走"
   * （实测：session ⇒ 204，随后那个 kernel ⇒ **404**）—— 收尾不留活内核正是这条的形状。
   *
   * ### 三态三种话
   * ① 握手没 101（`registerNotebookProxy` 里那次 `attachNotebookUpgrade` 没接上 / 守卫把本机探针拒了 /
   *    jupyter 没在听）→ 查接线与上游；② 101 了但**一帧都没回** → 查 101 之后那两行 `pipe` 与 `head` 字节；
   *    ③ 回了但不是我们要的那条（parent msg_id 对不上 / 全是内核自己的 status）→ 查搬运有没有改字节。
   *    三条各有各的失败消息，不许合成一句"ws 不通"。
   *
   * ### 断言放在 try/finally **之外**（Task 3 实测的教训）
   * finally 里只记录状态码不做断言：try 里第一条 expect 抛出后，finally 里的断言会再抛并**盖掉**前一条，
   * 报告只显示收尾的坏点。收尾本身（DELETE）无条件执行，所以红的时候也不留活内核。
   */
  it('穿过隧道真跑一行代码：POST sessions → 手工 ws 握手 101 → execute_request → 读回 42 → 内核删干净', async () => {
    const nbPath = `wi94-ws-smoke-${process.pid}-${Date.now()}.ipynb`;
    const msgId = `wi94-msg-${process.pid}-${Date.now()}`;
    const wsKey = randomBytes(16).toString('base64'); // 16 字节随机数的 base64（RFC 6455 §1.3）
    // 键顺序与 Task 3 那条一样是探针的一部分：这份 body 不许被 parse→stringify 过。
    const sessionBody = JSON.stringify({ name: nbPath, path: nbPath, type: 'notebook', kernel: { name: 'python3' } });
    let sessionId = '';
    let kernelId = '';
    let conn: WsConn | null = null;
    let deleteSessionStatus = 0;
    let kernelAfterDelete = 0;
    let healthAfter = 0;
    let tunnelStatusAfter = 0;
    try {
      const created = await probe({
        path: `${JUPYTER_BASE_URL}api/sessions`,
        method: 'POST',
        headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(sessionBody)) },
        body: sessionBody,
      });
      expect(created.status, `POST /jupyter/api/sessions 回 ${created.status}（实测 201）⇒ 先分清是隧道坏了还是 jupyter 变了：` +
        '把同一条 POST 原样打 127.0.0.1:' + config.notebook.port + ' 加 Authorization 对照，两边一致才是上游的形状变了').toBe(201);
      const model = JSON.parse(created.body) as { id?: string; kernel?: { id?: string; execution_state?: string } };
      sessionId = model.id ?? '';
      kernelId = model.kernel?.id ?? '';
      expect(sessionId.length, 'sessions 回话里没有 model.id ⇒ 下面那句 DELETE 没有对象，收尾纪律判不了').toBeGreaterThan(0);
      expect(kernelId.length, 'sessions 回话里没有 model.kernel.id ⇒ 没有可连的 channels 地址（三态之外的第四态：那条 POST 的形状变了）').toBeGreaterThan(0);
      // 实测事实钉成断言：REST 那份 execution_state 此刻是 "starting"，**而且不连 ws 就永远停在 starting**。
      // 把它钉住是因为它是"下一个人为何不许改成轮询 idle"的答案（见文件里那段手搓 ws 的注释）。
      expect(model.kernel?.execution_state, '实测前提变了：jupyter 不再从 REST 报 "starting" ⇒ 本档那段"不许轮询 execution_state"' +
        '（它没有 ws 客户端时不读 iopub）要重读').toBe('starting');

      conn = await openNotebookWs({
        pathWithQuery: `${JUPYTER_BASE_URL}api/kernels/${kernelId}/channels?session_id=${sessionId}`,
        headers: wsHandshakeHeaders(wsKey),
        deadlineMs: WS_HANDSHAKE_DEADLINE_MS,
      });
      // 三态之一：握手没 101。
      expect(conn.endedBeforeHead, 'ws 握手连一个完整的头都没等到（对侧直接断了 / 15s 超时）⇒ 这台 Node 的 upgrade 派发' +
        '或 `attachNotebookUpgrade` 的接线问题；对照宿主档 `proxy.test.ts` 那条"上游不肯升级 ⇒ 至少有一句状态行"').toBe(false);
      expect(conn.statusLine, 'ws 握手回的是「' + (conn.endedBeforeHead ? '(一句完整头都没等到)' : conn.statusLine) + '」而不是 101 ⇒ 三态之一（没升级）。' +
        '排的顺序：① `registerNotebookProxy` 末尾那次 `attachNotebookUpgrade(...)` 还在不在；' +
        '② 守卫有没有把这条本机探针拒掉（403 的话 body 里有 error 码，见 cross-site 那一条的写法）；' +
        '③ 上游有没有肯升级（400/403 是 jupyter 答的：隧道注入的凭据没被认）。状态行原样搬回客户端是 Task 4 那条' +
        '"静默断连最难查"的判据，所以这里能读到数字本身就说明有一件事没坏').toBe('HTTP/1.1 101 Switching Protocols');
      // `sec-websocket-accept` 必须由**我们发出去的那个 key** 算出来：这一条把"101 是真握手"钉住，
      // 而不是某个中间层自己编了一句状态行（重复 key 那类"React 只报 warning 而界面在撒谎"的形状）。
      expect(conn.headers['sec-websocket-accept']?.[0], '101 但没有正确的 sec-websocket-accept ⇒ 那句握手回话不是 ws 端点给的').toBe(expectedAcceptOf(wsKey));
      // 这两个逐跳头在握手回话里**必须转发**（RFC 6455；Firefox 缺 Connection 直接判失败）—— 见 proxy.ts 那段"不许照搬 HOP_BY_HOP"。
      expect(conn.headers['upgrade']?.[0]).toBe('websocket');
      expect(conn.headers['connection']?.[0]).toBe('Upgrade');
      // 凭据纪律：握手回话里有 `set-cookie`（会话 cookie），所以整块头**不交给 matcher**，只走这个布尔。
      expect(holdsToken(conn.head), '握手回话的头里出现隧道注入给上游的那份凭据 ⇒ 我们把自己的长期凭据写回了客户端').toBe(false);

      conn.socket.write(encodeClientTextFrame(JSON.stringify({
        header: { msg_id: msgId, msg_type: 'execute_request', version: '5.3', username: '', session: 's1', date: new Date().toISOString() },
        parent_header: {}, metadata: {},
        // brief 那个形状（只有 code/silent）实测就够：jupyter 会补 store_history 等默认值
        // （它的告警"No channel specified, assuming shell"只说明信封少一个字段，不影响执行）。
        content: { code: 'print(6*7)', silent: false },
        buffers: [],
      })));
      const drain = await drainFrames(conn, {
        deadlineMs: 25_000,
        stopWhen: (e) => e.msgType === 'execute_reply' && e.parentMsgId === msgId,
      });
      // 三态之二：101 了但一帧都没回。
      expect(drain.envelopes.length, '握手成功之后**一帧都没收到** ⇒ 三态之二：101 之后那半条管道没接上' +
        '（`usocket.pipe(socket)` / `socket.pipe(usocket)` 少一行，或 `head` 那截字节被写进了 upstreamReq 把握手打成乱码）' +
        `。非 text 帧收到 ${drain.nonTextOpcodes.length} 条`).toBeGreaterThan(0);
      // 三态之三：回了，但不是我们要的那条。**按 parent msg_id 认领**是这条的全部意义 ——
      // 实测头几帧是内核自己的启动/回放 status（parent 不是我们的 msg_id），不按 parent 认领就会拿别人的输出当功劳。
      const ours = drain.envelopes.filter((e) => e.parentMsgId === msgId);
      expect(ours.length, `回了 ${drain.envelopes.length} 帧，但没有一帧的 parent_header.msg_id 是我们发出去的那条 ⇒ 三态之三：` +
        '搬运改过字节（掩码/扩展长度/分帧解错都会是这个症状），或请求根本没进内核').toBeGreaterThan(0);
      expect(ours.some((e) => e.msgType === 'stream' && e.channel === 'iopub' && e.textHas42),
        'execute_reply 收到了，但没有一条 iopub `stream` 里带着那行代码的输出 ⇒ 执行通了而**输出**没搬回来').toBe(true);
      expect(ours.filter((e) => e.msgType === 'execute_reply').map((e) => e.contentStatus).join(','), '内核答的不是 ok').toBe('ok');
      expect(drain.timedOut, `等 execute_reply 等到超时（共收到 ${drain.envelopes.length} 帧）`).toBe(false);
      // 凭据纪律的另一半：**搬运回来的所有帧**里都不许有那份凭据（隧道是注入不是透传）。
      expect(drain.leakedToken, '内核回话的帧里出现隧道注入的凭据 ⇒ 上游把我们的 Authorization 回显进了协议消息').toBe(false);
    } finally {
      conn?.socket.destroy();
      // finally 里**只记数字不断言**（Task 3 实测：那里的断言会盖掉 try 里真正的坏点）。
      // 收尾无条件：红了也不把内核留给真人（WI-93 记过"Jupyter 无守护"，反面就是"容器档留下一排活内核"）。
      if (sessionId) deleteSessionStatus = await probe({ path: `${JUPYTER_BASE_URL}api/sessions/${sessionId}`, method: 'DELETE', headers: LOCAL_HOST_HEADER() }).then((r) => r.status, () => 0);
      if (kernelId) kernelAfterDelete = await probe({ path: `${JUPYTER_BASE_URL}api/kernels/${kernelId}`, headers: LOCAL_HOST_HEADER() }).then((r) => r.status, () => 0);
      healthAfter = await probe({ path: '/api/health', headers: LOCAL_HOST_HEADER() }).then((r) => r.status, () => 0);
      tunnelStatusAfter = await probe({ path: `${JUPYTER_BASE_URL}api/status`, headers: { ...LOCAL_HOST_HEADER(), ...SAME_ORIGIN } }).then((r) => r.status, () => 0);
    }

    // ── try/finally 之后的断言：只有主链全对才会走到这里 ──
    expect([200, 204], `收尾 DELETE session 回 ${deleteSessionStatus}（实测 204）⇒ 那个内核还在跑着，本档在污染真人的实例`).toContain(deleteSessionStatus);
    expect(kernelAfterDelete, `删掉 session 之后那个 kernel 还读得到（${kernelAfterDelete}）⇒ 实测"DELETE session 会把它的内核一起带走"（随后应为 404）` +
      '这个前提变了，收尾要改成显式 DELETE /api/kernels/<id>').toBe(404);
    // "隧道不会把宿主进程带走"的判据本体（本项目有过一条 `void` 掉的 async 拒绝把整个服务带走的事故）：
    // 上面那个 socket 是**升级过**的连接，`destroy()` 之后服务端那一半也在隧道自己的记账里。
    expect(healthAfter, `跑完一条真 ws 隧道之后 /api/health 是 ${healthAfter}（期望 200）⇒ 7788 那个进程已经不在了`).toBe(200);
    expect(tunnelStatusAfter, `跑完一条真 ws 隧道之后隧道的 /jupyter/api/status 是 ${tunnelStatusAfter}（期望 200）⇒ 进程活着而这棵子树坏了`).toBe(200);
  }, 120_000);

  /**
   * 第二条通道的守卫（容器档那一半）：**HTTP 拦住了不等于 ws 也拦住了**。
   * `upgrade` 不走路由 ⇒ Fastify 的 `onRequest` 钩子与 HTTP handler 都碰不到它；把
   * `attachNotebookUpgrade` 里那次 `guardNotebookProxy` 摘掉，上面那条"真跑代码"照绿，
   * 而"别人页面里的 iframe 能不能连进来执行代码"这件事就没有任何判据了。
   * 这条就是这个摘掉的动作在容器档唯一的红（宿主档 `proxy.test.ts` 那条判的是同一件事的假上游形状）。
   */
  it('ws 握手也要过守卫：Sec-Fetch-Site: cross-site ⇒ 不是 101 而是 403 + notebook_cross_site', async () => {
    const key = randomBytes(16).toString('base64');
    const conn = await openNotebookWs({
      pathWithQuery: `${JUPYTER_BASE_URL}api/kernels/deadbeef-not-used/channels`,
      headers: wsHandshakeHeaders(key, { 'sec-fetch-site': 'cross-site' }),
      deadlineMs: WS_HANDSHAKE_DEADLINE_MS,
    });
    try {
      // 两种坏法分开说：① 一句状态行都没等到（被静默断连，最难查的那种）②有回话但不是我们的 403。
      expect(conn.statusLine, 'cross-site 的 ws 握手回的是「' + (conn.endedBeforeHead ? '(一句状态行都没等到)' : conn.statusLine) + '」而不是 403 ⇒ ' +
        '`upgrade` 事件里那次 `guardNotebookProxy` 不在位。这条就是"HTTP 上拦住了"与"另一条通道也拦住了"那笔差额的' +
        '判据本体：把它摘掉，上面那条"真跑一行代码"照绿，而别人页面里的 iframe 就能连进来执行代码').toMatch(/^HTTP\/1\.1 403\b/);
      // 内核 id 是编的：守卫必须在**打上游之前**就否决，否则到的会是 jupyter 的 400/404 而不是我们那句 403。
      expect(errorOf(conn.rest.toString('utf8')), '403 但不是守卫那一条 ⇒ 拦它的是别的东西，这条判的就不是它想判的').toBe('notebook_cross_site');
      expect(holdsToken(conn.head) || holdsToken(conn.rest.toString('utf8')), '否决回话里出现凭据 ⇒ 那句话把长期凭据回显了').toBe(false);
    } finally {
      conn.socket.destroy();
    }
  }, 30_000);
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
