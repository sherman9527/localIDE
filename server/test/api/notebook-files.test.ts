import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, type NotebookFilesResponse } from '@arena/shared';
import { config } from '../../src/config.js';
import { listNotebookFiles } from '../../src/notebooks/files.js';
import type { GradePort, JudgePort } from '../../src/ports.js';
import { FakeBank, FakeStore, fixedClock, seedQuestions } from '../game/fixtures.js';

/**
 * WI-94 Task 5：`GET /api/notebook/files` —— 第五页左栏那棵树的数据源。
 *
 * 为什么是服务端读目录、不是透传 `/jupyter/api/contents`：那棵树上的列目录要求 Jupyter 在跑，
 * 而页面在 Jupyter 没起来时**也必须**如实显示"目录里有 3 份笔记，服务没起"。
 * 判据里有两句方向相反的话各占一条用例：**"没有"**（`files:[]` 且无 `error`）与
 * **"读不到"**（`files:[]` 且有 `error`）—— 把后者说成前者就是本仓库最恨的静默降级
 * （`shared/src/notebook.ts` 的 `seedError` 是同一条纪律的孪生）。
 *
 * 隔离：照 `notebook-api.test.ts` 的 `injectApp` 注入 `ARENA_DATA_DIR` 到临时目录 ——
 * `workDir` 默认就是真人的 `data/notebooks/`，不注入的话单测会去数用户自己写的笔记（WI-40），
 * 而且本文件**绝不**在真人数据目录里创建/删除任何东西。
 */

const stubJudge: JudgePort = {
  async run(): Promise<never> {
    throw new Error('notebook files 路由测试不判题');
  },
  async probe(): Promise<boolean> {
    return false;
  },
};
const stubGrade: GradePort = {
  async grade(): Promise<never> {
    throw new Error('notebook files 路由测试不评分');
  },
  async available(): Promise<boolean> {
    return false;
  },
};

interface Injected {
  app: FastifyInstance;
  /** 注入 ARENA_DATA_DIR 之后重新 import 的那份 config（期望值从它派生，不写死目录） */
  cfg: typeof config;
  dataDir: string;
  /** `cfg.notebook.workDir` —— 此刻**不保证存在**（"目录不存在"恰恰是一条要判的形状） */
  dir: string;
}

let opened: FastifyInstance[] = [];
let madeDirs: string[] = [];
let logHandles: { flush: () => Promise<void>; file: () => string }[] = [];

/**
 * 每个用例一套临时数据目录（`vi.resetModules()` 之后 config 才读得到新 env）。
 * afterEach 里"先排空日志再删目录"的顺序连同判据一起照抄 `notebook-api.test.ts`（评审 I-2 的竞态纪律）。
 */
async function injectApp(): Promise<Injected> {
  const dataDir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'notebook-files-'));
  madeDirs.push(dataDir);
  const key = 'ARENA_DATA_DIR';
  const saved = process.env[key];
  delete process.env[key];
  process.env[key] = dataDir;
  vi.resetModules();
  try {
    const cfg = (await import('../../src/config.js')).config;
    const { buildApp } = await import('../../src/api/app.js');
    // resetModules 之后 app 用的是**新的那一份** log 模块（各自的 LOG_DIR）；
    // 文件顶部那份静态 import 写的是仓库默认 data/，排空它判不到本用例（同 notebook-api.test.ts）。
    const { flushLogs, logFileFor } = await import('../../src/log.js');
    logHandles.push({ flush: flushLogs, file: logFileFor });
    const app = await buildApp({
      judge: stubJudge,
      grade: stubGrade,
      bank: new FakeBank(seedQuestions()),
      store: new FakeStore(),
      clock: fixedClock('2026-09-19'),
    });
    opened.push(app);
    return { app, cfg, dataDir, dir: cfg.notebook.workDir };
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

afterEach(async () => {
  for (const app of opened) await app.close();
  opened = [];
  /**
   * 排空再删（评审 I-2，与 notebook-api.test.ts 同一条）：onResponse 钩子的日志写入是排队异步的，
   * rm 先跑完会撞 ENOENT/ENOTEMPTY，把宿主 pre-commit 偶尔撞红。
   * existsSync 是把"顺序"本身钉住的判据：摘掉 flush 就当场确定地红，而不是留下要运气差才撞上的竞态。
   */
  for (const log of logHandles) {
    await log.flush();
    expect(
      existsSync(log.file()),
      'flush 之后日志文件仍不在盘上 ⇒ 要么排空没排在删目录之前（本条守卫存在的理由），要么这个用例一个请求都没发（那它也不该建 app）',
    ).toBe(true);
  }
  logHandles = [];
  for (const dir of madeDirs) await rm(dir, { recursive: true, force: true });
  madeDirs = [];
});

describe('GET /api/notebook/files', () => {
  it('目录里有两份笔记 ⇒ 只列 .ipynb，按名字排，别的文件不出现', async () => {
    const { app, dir } = await injectApp();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'b.ipynb'), '{}');
    await writeFile(join(dir, 'a.ipynb'), '{}');
    await writeFile(join(dir, 'checkpoint.txt'), 'x');
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual(['a.ipynb', 'b.ipynb']);
  });

  it('目录是空的 ⇒ files:[] 且没有 error（"没有"与"读不到"必须两句话）', async () => {
    const { app, dir } = await injectApp();
    await mkdir(dir, { recursive: true });
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` });
    const body = res.json() as NotebookFilesResponse;
    expect(body.files).toEqual([]);
    expect(body.error, '空目录不是故障；这里一旦出现 error 就是"把没有说成坏了"').toBeUndefined();
  });

  it('目录不存在 ⇒ files:[] 且没有 error：那是还没铺过示例，不是故障（铺失败的判据是 status 那条 seedError）', async () => {
    const { app, dir } = await injectApp();
    await mkdir(dir, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    const body = (await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` })).json() as NotebookFilesResponse;
    expect(body).toEqual({ files: [] });
  });

  it('工作目录读不了 ⇒ files:[] + error，且那句说的是"读不到"', async () => {
    // chmod 000 在 Windows 上拦不住任何东西（ACL 不是 mode bits）⇒ 这一条用"名字是一个文件而不是目录"
    // 来造一个必然会失败的 readdir：跨平台、且不需要提权。skipIf 不用 try/catch（报告会写 skipped）。
    // （实测本宿主：readdir 一个普通文件 = ENOTDIR；目录不存在 = ENOENT —— 两者必须分属两句话。）
    const tmp = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'notebook-files-direct-'));
    madeDirs.push(tmp);
    const filePath = join(tmp, 'not-a-dir');
    await writeFile(filePath, 'x');
    const body = listNotebookFiles(filePath);
    expect(body.files).toEqual([]);
    expect(body.error, 'readdir 一个文件必须给 error，而不是空表').toContain('读不到 notebook 工作目录');
    expect(body.error).toMatch(/ENOTDIR|EINVAL|EPERM/); // 平台差异只落在错误码上，不落在"有没有这句话"上
  });

  it('路由真的在（行首判据，不是 indexOf）', async () => {
    const { app } = await injectApp();
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');
    // 行首判据（WI-87 的学费）：`^ {2}` 就是"两个空格开头"（lint 嫌数字面空格数易误读，语义完全相同）——
    // 路由被并进注释、被缩进到别的块里、或整个消失，这里都必须红。
    expect(/^ {2}app\.get\(`\$\{api\}\/notebook\/files`/m.test(src), 'WI-87 的学费：一次编辑把路由并进注释，indexOf 断言照样绿').toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` })).statusCode).toBe(200);
  });
});
