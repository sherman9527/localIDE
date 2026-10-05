import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NotebookPrepareResponse, NotebookStatusResponse } from '@arena/shared';
import { config } from '../../src/config.js';
import type { GradePort, JudgePort } from '../../src/ports.js';
import { FakeBank, FakeStore, fixedClock, seedQuestions } from '../game/fixtures.js';

/**
 * Task 8：notebook 的两个路由 + 接线形状。
 *
 * 这里判的**不是**"notebookStatus 算得对不对"（那是 `server/test/notebooks/status.test.ts` 的活），
 * 而是三件只有"挂上 HTTP 之后"才成立的事：
 * ① 路由真的存在（WI-87 的学费：一次编辑把 `app.post(...)` 并进注释，整条路由被吞掉，
 *    而"切片里 indexOf 路径字符串"的断言照样绿 ⇒ 判据必须是**行首**，不是包含）；
 * ② token 的释放判据是**内核给的 socket 对端地址**，不是客户端自报的 Host 头（评审 M-1）；
 * ③ `notebookStatus` 的第三种响应形状（Jupyter 在跑但 publicUrl 配坏 ⇒ running:true + reason + 没有 url）
 *    必须被路由**原样透传**，不许在路由里被抹平成"要么给链接、要么没在跑"两态（评审第二条裁定）。
 */

/** `ensureIdeEnv` 的替身：它在容器里是分钟级的真活，单测里只许被"看见有没有被调用"。 */
const envSpy = vi.hoisted(() => ({ ensureIdeEnv: vi.fn() }));
vi.mock('../../src/ide/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ide/env.js')>()),
  ensureIdeEnv: envSpy.ensureIdeEnv,
}));

const CANARY = 'notebook-api-token-canary-6f2c';
/** 永不可能是任何机器默认网关的地址（TEST-NET-3，RFC 5737）。 */
const FOREIGN_PEER = '203.0.113.9';

const stubJudge: JudgePort = {
  async run(): Promise<never> {
    throw new Error('notebook 路由测试不判题');
  },
  async probe(): Promise<boolean> {
    return false;
  },
};
const stubGrade: GradePort = {
  async grade(): Promise<never> {
    throw new Error('notebook 路由测试不评分');
  },
  async available(): Promise<boolean> {
    return false;
  },
};

/** 假 Jupyter：两个端点都照常答 200，用来把"running:true"这几条形状在宿主上跑出来。 */
function jupyterUp(): void {
  const fake = async (u: string | URL): Promise<unknown> =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => ({ kernels: { 'arena-pyspark': { spec: { display_name: 'PySpark (arena)' } } } }) }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) };
  vi.stubGlobal('fetch', vi.fn(fake) as unknown as typeof fetch);
}

interface Injected {
  app: FastifyInstance;
  /** 注入 ARENA_DATA_DIR 之后重新 import 的那份 config（期望值一律从它派生，不写死端口/目录） */
  cfg: typeof config;
  dataDir: string;
}

let opened: FastifyInstance[] = [];
let madeDirs: string[] = [];

/**
 * 每个用例一套临时数据目录 + 显式 env。
 * 为什么非要注入 ARENA_DATA_DIR：路由里的 GET 会**真的**调 `seedNotebooks()`，
 * 默认目录就是 `config.notebook.workDir` ⇒ 不注入的话单测往真人的 `data/notebooks/` 里铺文件
 * （WI-40 的隔离纪律：可写状态不许落在"换了数据目录却只换一半"的那个位置）。
 */
async function injectApp(env: Partial<{ token: string; publicUrl: string }>): Promise<Injected> {
  const dataDir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'notebook-api-'));
  madeDirs.push(dataDir);
  const keys = ['ARENA_DATA_DIR', 'ARENA_JUPYTER_TOKEN', 'ARENA_NOTEBOOK_PUBLIC_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ARENA_DATA_DIR = dataDir;
  if (env.token !== undefined) process.env.ARENA_JUPYTER_TOKEN = env.token;
  if (env.publicUrl !== undefined) process.env.ARENA_NOTEBOOK_PUBLIC_URL = env.publicUrl;
  vi.resetModules();
  try {
    const cfg = (await import('../../src/config.js')).config;
    const { buildApp } = await import('../../src/api/app.js');
    const app = await buildApp({
      judge: stubJudge,
      grade: stubGrade,
      bank: new FakeBank(seedQuestions()),
      store: new FakeStore(),
      clock: fixedClock('2026-09-19'),
    });
    opened.push(app);
    return { app, cfg, dataDir };
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

afterEach(async () => {
  for (const app of opened) await app.close();
  opened = [];
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const dir of madeDirs) await rm(dir, { recursive: true, force: true });
  madeDirs = [];
});

describe('notebook 路由接线', () => {
  const app = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');

  for (const path of ['/notebook/status', '/notebook/prepare-env']) {
    it(`${path} 以独立一行的 app.get/app.post 注册`, () => {
      const hit = app
        .split('\n')
        .some((l) => /^\s*app\.(get|post)\(`\$\{api\}\/notebook\//.test(l) && l.includes(path));
      expect(hit, `${path} 没有被注册成独立一行的路由（被同行注释吞掉就是这个形状）`).toBe(true);
    });
  }
});

describe('GET /api/notebook/status', () => {
  it('没起 Jupyter 时 status 仍是 200 + running:false（页面不许白屏，也不许 500）', async () => {
    // 宿主上 Docker 是关的：真 fetch 打 127.0.0.1:8888 必然吃闭门羹 —— 这条要的就是那个形状。
    const { app } = await injectApp({ token: CANARY });
    const res = await app.inject({ method: 'GET', url: '/api/notebook/status', headers: { host: '127.0.0.1:7788' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotebookStatusResponse;
    expect(typeof body.running).toBe('boolean');
    expect(Array.isArray(body.kernels)).toBe(true);
    expect(Array.isArray(body.notebooks)).toBe(true);
    if (!body.running) {
      expect((body.reason ?? '').trim(), 'running:false 却没有 reason ⇒ 界面上只剩"不可用"三个字').not.toBe('');
    }
  });

  it('这个 GET 顺手把示例铺进**本实例自己的**数据目录（契约里 notebooks 就是这么来的）', async () => {
    // token 故意给空：铺示例不该依赖"Jupyter 起没起"，页面第一次打开就该看得见文件。
    const { app, cfg } = await injectApp({ token: '' });
    const res = await app.inject({ method: 'GET', url: '/api/notebook/status', headers: { host: '127.0.0.1:7788' } });
    const body = res.json() as NotebookStatusResponse;
    expect(body.running).toBe(false);
    expect(body.notebooks.map((n) => n.file)).toContain('00-smoke-pyspark.ipynb');
    expect(existsSync(join(cfg.notebook.workDir, '00-smoke-pyspark.ipynb')), 'seed 落在别处 ⇒ 页面列出的文件 Jupyter 打不开').toBe(true);
  });

  it('伪造 Host: 127.0.0.1 的非本机对端拿不到 token（评审 M-1：Host 头是客户端写的）', async () => {
    jupyterUp();
    const { app, cfg } = await injectApp({ token: CANARY });
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebook/status',
      remoteAddress: FOREIGN_PEER,
      headers: { host: '127.0.0.1:7788' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotebookStatusResponse;
    expect(body.running, '假 Jupyter 在答 ⇒ 这一条判的是 token 释放，不是探活').toBe(true);
    expect(body.url, '链接照给（它本来就只在本机能打开），但里面不许有凭据').toBe(`${cfg.notebook.publicUrl}/tree`);
    expect(JSON.stringify(body), 'token 出现在响应的**任何**字段里都算泄漏').not.toContain(CANARY);
  });

  it('真回环对端 + 一句别的 Host 头 ⇒ 照样给 token（头只剩展示价值，不参与判定）', async () => {
    jupyterUp();
    const { app, cfg } = await injectApp({ token: CANARY });
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebook/status',
      remoteAddress: '127.0.0.1',
      headers: { host: 'evil.example.com:7788' },
    });
    const body = res.json() as NotebookStatusResponse;
    expect(body.url).toBe(`${cfg.notebook.publicUrl}/tree?token=${CANARY}`);
  });

  /**
   * 评审 M-1 的另一半：旧判据是一条 IPv6 正则，`::1:7788` 这个**非回环字面量**会被它认成本机。
   * socket 地址永远不带端口，所以这里直接拿那个字面量当对端地址打进去 —— 换掉判据之前它是拿得到 token 的。
   */
  it('::1:7788 不是回环（旧正则的假阳性）', async () => {
    jupyterUp();
    const { app } = await injectApp({ token: CANARY });
    const res = await app.inject({ method: 'GET', url: '/api/notebook/status', remoteAddress: '::1:7788' });
    expect(JSON.stringify(res.json() as NotebookStatusResponse)).not.toContain(CANARY);
  });

  /**
   * 第三种形状：`running:true` + `reason` + **没有 url**（publicUrl 被 env 配坏，链接拼不出来）。
   * 路由必须在 spread 时把它原样带出去；把它抹平成"要么有链接、要么没在跑"就等于
   * 让页面在"点开它"和"没在运行"之间二选一，而那两句都是假话（服务确实在跑，链接确实给不出）。
   */
  it('publicUrl 配坏时仍透传"在跑但没有链接"这一态（既不降级成 500，也不假装没在跑）', async () => {
    jupyterUp();
    const { app } = await injectApp({ token: CANARY, publicUrl: 'not a url' });
    const res = await app.inject({ method: 'GET', url: '/api/notebook/status', remoteAddress: '127.0.0.1' });
    expect(res.statusCode, 'env 写错不是服务端崩，500 里读不到原因（正是本仓库最恨的静默）').toBe(200);
    const body = res.json() as NotebookStatusResponse;
    expect(body.running).toBe(true);
    expect(body.url).toBeUndefined();
    expect(body.reason).toMatch(/ARENA_NOTEBOOK_PUBLIC_URL/);
    expect(body.kernels.map((k) => k.id)).toContain('arena-pyspark');
  });
});

describe('POST /api/notebook/prepare-env', () => {
  it('建 venv 只发生在这个显式 POST 上，GET 一次都不碰（venv 是分钟级的活）', async () => {
    jupyterUp();
    envSpy.ensureIdeEnv.mockResolvedValue({});
    const { app } = await injectApp({ token: CANARY });

    await app.inject({ method: 'GET', url: '/api/notebook/status', remoteAddress: '127.0.0.1' });
    expect(envSpy.ensureIdeEnv.mock.calls, 'status 会被轮询 ⇒ 读路径里建环境是错的').toHaveLength(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notebook/prepare-env',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as NotebookPrepareResponse).toEqual({ ok: true });
    expect(envSpy.ensureIdeEnv.mock.calls).toHaveLength(1);
    // 建的是**哪个**环境：kernel 的 argv 指着 python 那一族，换成 node 就白建了
    const [arg] = envSpy.ensureIdeEnv.mock.calls[0] as [ { id: string } ];
    expect(arg.id).toBe('python');
  });

  it('ensureIdeEnv 抛错 ⇒ 200 + ok:false + 那句原因（不是 500，页面才说得出为什么）', async () => {
    envSpy.ensureIdeEnv.mockRejectedValue(new Error('venv 创建超时'));
    const { app } = await injectApp({ token: CANARY });
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebook/prepare-env',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NotebookPrepareResponse;
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('venv 创建超时');
  });
});
