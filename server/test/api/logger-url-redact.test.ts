import { mkdtemp, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GradePort, JudgePort } from '../../src/ports.js';
import { FakeBank, FakeStore, fixedClock, seedQuestions } from '../game/fixtures.js';

/**
 * WI-94 Task 7d 第 2 件：**Fastify 自己那一份 pino 日志**里的 `req.url` 不再带出 token 值。
 *
 * 上一轮（Task 7a）收的是 `app.ts` 的 `onResponse` 那一行，它写进 `data/logs/`。但 `index.ts` 传的是
 * `logger: true` ⇒ pino 自己还会往 **stdout** 打 `incoming request` / 500 那几行，`req.url` 原样在场
 * （2026-10-09 实测：`{"req":{"method":"GET","url":"/probe?token=<值>…"},"msg":"incoming request"}`）。
 * stdout 走的是 `docker logs` 与 `./start.sh --logs` —— **"只在 stdout、不在 data/logs"不是安全边界**，
 * 所以本轮把它一起收掉（`app.ts` 的 `logOptionsOf()`）。
 *
 * 四条判据各挡一种假绿：
 *  ① **先证非空再判不含**：`incoming request` 必须真被 sink 收到，行数与请求数对齐。
 *     少了这一条，"每一行都不含 canary"会因为"压根没收到行"而空转成立 —— 与容器档
 *     "先证区间非空再判 skip"是同一条纪律。
 *  ② **不含 canary**（收窄发生过）。
 *  ③ **含路径与其余参数**（`/api/health` 与 `x=1` 逐字在场）：这是方向相反的那一半 ——
 *     实测 `redact: {paths:['req.url']}` 用默认 censor 会整条变成 `"url":"[Redacted]"`，
 *     那也叫"不含凭据"，但 `npm run logs -- --trace <id>` 那条排查链路就断了。
 *  ④ **反向对照**：不接 redact 的那条路（裸 Fastify、同一个 pino、同一个 req serializer）实测**确实**带出
 *     canary。少了这条，②可能判的是"这个形状根本走不到日志里"的死前提。
 *
 * ⚠ 失败消息的纪律：本文件**绝不**把 sink 的原始行放进断言消息或期望值 —— 收窄坏掉时那些行里就带着凭据。
 * ②的证据只用**行号**，③④的证据只用布尔值（红了打印的是 `false`，不是整行）。
 * 两个方向都要防：既不许把 canary 之外的凭据形状写进消息，也不许让"红"本身变成第二处泄漏。
 */

const CANARY = 'logger-url-redact-canary-4c1d';
/** 期望的占位形状（与文件日志那一处同一个值，判"遮发生过"而不是"整条抹掉"）。 */
const MASKED = '[已隐藏]';

const stubJudge: JudgePort = {
  async run(): Promise<never> {
    throw new Error('日志收窄测试不判题');
  },
  async probe(): Promise<boolean> {
    return false;
  },
};
const stubGrade: GradePort = {
  async grade(): Promise<never> {
    throw new Error('日志收窄测试不评分');
  },
  async available(): Promise<boolean> {
    return false;
  },
};

/** 内存 sink（pino 的 `stream`）。 */
function collect(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    // 按行拆开：今天 pino 一次 write 一行，但判据不该依赖那个假设（一次 write 两行也要逐行判）
    lines: () => chunks.join('').split('\n').filter((l) => l.trim() !== ''),
  };
}

/** `'sink'` = pino 指到内存 sink；`'true'` = 生产那一支（只查级别，不发请求 ⇒ 不会往 stdout 带 URL）。 */
type LoggerChoice = 'sink' | 'true';

interface Injected {
  app: FastifyInstance;
  lines: () => string[];
}

let opened: FastifyInstance[] = [];
let madeDirs: string[] = [];
let logHandles: { flush: () => Promise<void> }[] = [];
const closed = new WeakSet<FastifyInstance>();

/** close 两次没意义（Fastify 会走第二遍 teardown），而本文件的用例**必须**先 close 才能拿到完整的行。 */
async function closeApp(app: FastifyInstance): Promise<void> {
  if (closed.has(app)) return;
  closed.add(app);
  await app.close();
}

/**
 * 临时 `ARENA_DATA_DIR`（WI-40 隔离纪律，照 `notebook-api.test.ts`）：每一发请求都会走 `onResponse`
 * 那份文件日志，不注入就写进真人的 `data/logs/`。
 */
async function injectApp(choice: LoggerChoice): Promise<Injected> {
  const dataDir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'logger-url-redact-'));
  madeDirs.push(dataDir);
  const key = 'ARENA_DATA_DIR';
  const saved = process.env[key];
  delete process.env[key];
  process.env[key] = dataDir;
  vi.resetModules();
  try {
    const sink = collect();
    const { buildApp } = await import('../../src/api/app.js');
    const { flushLogs } = await import('../../src/log.js');
    logHandles.push({ flush: flushLogs });
    const app = await buildApp({
      judge: stubJudge,
      grade: stubGrade,
      bank: new FakeBank(seedQuestions()),
      store: new FakeStore(),
      clock: fixedClock('2026-10-10'),
      // ⚠ `level: 'debug'` 而不是 'info'：判据覆盖的是"这个 app 能打出的**所有**行"，放宽只增不减
      logger: choice === 'true' ? true : { level: 'debug', stream: sink.stream },
    });
    opened.push(app);
    return { app, lines: sink.lines };
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

const isIncoming = (line: string): boolean => line.includes('"msg":"incoming request"');

afterEach(async () => {
  for (const app of opened) await closeApp(app);
  opened = [];
  // 先排空再删目录（评审 I-2 那条竞态，与 notebook-api.test.ts 同）
  for (const log of logHandles) await log.flush();
  logHandles = [];
  for (const dir of madeDirs) await rm(dir, { recursive: true, force: true });
  madeDirs = [];
});

describe('Fastify 自带那一份 pino 日志的 URL 收窄（WI-94 Task 7d）', () => {
  it('带 ?token= 的请求打出的每一行都不含凭据值，但路径与其余参数逐字在场', async () => {
    const { app, lines } = await injectApp('sink');
    const requests = [
      `/api/health?token=${CANARY}&x=1`, // 中段键 + 尾随参数
      `/api/no-such-route-here?token=${CANARY}`, // 404：本 app 自带 setNotFoundHandler，框架那句带 URL 的 msg 不该出现
      `/jupyter/api/contents?token=${CANARY}`, // 反代未配置 ⇒ 503：错误行同样带 req
      `/api/health?TOKEN=${CANARY}`, // 大写键（与文件日志共用同一条正则，不许分叉）
      '/api/health', // 无凭据的对照：原样在场，且不该被顺手遮掉
    ];
    for (const url of requests) await app.inject({ method: 'GET', url });
    await closeApp(app); // 排空 pino 的待写行，之后 lines() 才是完整的一份

    const all = lines();
    const incoming = all.filter(isIncoming);
    // ①
    expect(incoming.length, `sink 只收到 ${incoming.length} 行 incoming request，应有 ${requests.length} 行 —— 前提不成立时"不含凭据"是假绿`).toBe(requests.length);
    // ②
    const offending = all.map((l, i) => (l.includes(CANARY) ? i : -1)).filter((i) => i >= 0);
    expect(offending, `有 ${offending.length} 行把那个 canary 带了出去（行号：${offending.join(',')}）。原始行不打印：失败消息本身不许变成第二处泄漏`).toHaveLength(0);
    // ③
    expect(incoming.some((l) => l.includes('/api/health')), '一行都不含路径 ⇒ 用的是整条遮（"url":"[Redacted]"），traceId 那条排查链路被切断').toBe(true);
    expect(
      incoming.some((l) => l.includes(`token=${MASKED}`) && l.includes('x=1')),
      `没有"只剥 token 这一个键、其余逐字保留"的那道形状 ⇒ 要么没剥，要么连其余参数一起糊掉了（期望含 token=${MASKED} 与 x=1）`,
    ).toBe(true);
    expect(incoming.some((l) => l.includes(`TOKEN=${MASKED}`)), '大写 TOKEN= 没被剥 ⇒ 与文件日志那一处分叉了').toBe(true);
    // 对照：没有查询串的那一发必须**原样**在场。写成 `"url":"/api/health"`（带收尾引号）才区分得开上面那一发
    expect(incoming.some((l) => l.includes('"url":"/api/health"')), '无 token 那一发不在场或被动过 ⇒ 收窄变成了"逢 url 就改"，日志就不再是那次请求的原样').toBe(true);
    // ①的补充：404 / 503 那两发也要真被扫到，否则②对它们是空判
    expect(all.some((l) => l.includes('/api/no-such-route-here')), '404 那一发在 sink 里没有行').toBe(true);
    expect(all.some((l) => l.includes('/jupyter/api/contents')), '503（反代未配置）那一发在 sink 里没有行').toBe(true);
  });

  it('对照：同一个 pino、同一条 req serializer，不配 redact 时确实把 canary 带进 req.url', async () => {
    const sink = collect();
    const bare = Fastify({ logger: { level: 'debug', stream: sink.stream } });
    opened.push(bare);
    bare.get('/probe', async () => ({ ok: true }));
    await bare.inject({ method: 'GET', url: `/probe?token=${CANARY}&x=1` });
    await closeApp(bare);

    const incoming = sink.lines().filter(isIncoming);
    expect(incoming.length, '对照那一发压根没打出行 ⇒ 这条判据的机器形状变了，上面三条的绿要重估').toBe(1);
    // 这里**故意**断言"含 canary"：它判的是泄漏真实存在。断言只看布尔与位置，不回显 canary。
    expect(incoming[0]!.includes(CANARY), '不配 redact 也不带了？那上面三条可能判的是一个已经不存在的问题').toBe(true);
    expect(incoming[0]!.includes('"url":"/probe?token='), '泄漏的位置不在 req.url 了 ⇒ Fastify 的 req serializer 换形状，redact 的路径要跟着重测').toBe(true);
  });

  /**
   * 生产那一支（`index.ts` 的 `logger: true`）没有绕过去的口子：`logOptionsOf()` 对两种入参加的是
   * **同一个** censor（函数引用相同），所以上面那条 sink 判据直接适用于生产。
   * 附一条 `app.log.level === 'info'`：把 `true` 换成配置对象之后级别不许漂移
   * （实测 Fastify `createLogger` 走 `level = level || 'info'`，与本断言同源）。
   */
  it('logger:true 与注入 sink 那两支共用一份 redact，且不改默认级别', async () => {
    vi.resetModules();
    const { logOptionsOf } = await import('../../src/api/app.js');

    const optionsOf = (input: ReturnType<typeof logOptionsOf>) => {
      if (typeof input === 'boolean') throw new Error('期望拿到的是 pino 配置对象');
      return input;
    };
    const redactOf = (input: ReturnType<typeof logOptionsOf>) => {
      const r = optionsOf(input).redact;
      if (r === undefined) return { paths: [] as string[], censor: undefined as unknown };
      if (Array.isArray(r)) return { paths: r, censor: undefined as unknown };
      return { paths: r.paths ?? [], censor: r.censor };
    };

    const fromTrue = logOptionsOf(true);
    const fromSink = logOptionsOf({ level: 'debug', stream: collect().stream });

    expect(redactOf(fromTrue).paths, '生产那一支没挂 req.url ⇒ "凭据不进日志"只在调用方没配 logger 时才成立').toContain('req.url');
    expect(redactOf(fromSink).paths, '注入 sink 那一支没挂 req.url').toContain('req.url');
    expect(redactOf(fromSink).censor, '两支的 censor 不是同一个实现 ⇒ sink 那条判据测不到生产那一支').toBe(redactOf(fromTrue).censor);
    // 先判"是不是函数"再调用：censor 被摘掉（退回 pino 默认的整体遮）时，少了这一句这里会抛
    // "censor is not a function" —— 那句话说的是测试自己写得脆，而不是缺陷。
    expect(typeof redactOf(fromTrue).censor, 'censor 缺席 ⇒ pino 用默认 censor，实测整条变 "url":"[Redacted]"、路径一起没掉').toBe('function');

    const censor = redactOf(fromTrue).censor as (value: unknown, path: string[]) => unknown;
    // censor 拿到的是**序列化之前**的字段值（实测 path=['req','url']），所以这一步就该得到收窄后的 URL 原文
    expect(String(censor(`/probe?token=${CANARY}&x=1`, ['req', 'url']))).toBe(`/probe?token=${MASKED}&x=1`);
    expect(censor(undefined, ['req', 'url']), '非字符串值被拼成了字符串 ⇒ 会把别的日志形状打坏').toBe(undefined);
    expect(censor(42, ['req', 'url']), '非字符串值被改写了').toBe(42);

    expect(logOptionsOf(undefined), '不传 logger 时不许被顺手打开').toBe(false);
    expect(logOptionsOf(false), '显式关日志的那一支不许被翻案（traceId 那条链路靠的是我们自己那一份文件日志）').toBe(false);
    // 调用方自己配的 redact 不许被丢掉：路径并进来，而 req.url 仍在其中
    expect(redactOf(logOptionsOf({ redact: ['ssn'] })).paths).toEqual(['ssn', 'req.url']);

    const production = await injectApp('true');
    expect(production.app.log.level, 'logger:true 换成配置对象之后级别漂移了（生产排查口径会被改掉）').toBe('info');
    await closeApp(production.app);
  });
});
