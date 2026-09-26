import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { IDE_ENV_ROOT, ensureIdeEnv, ideEnvFor, ideEnvPaths, venvPythonPath } from '../../src/ide/env.js';
import { IDE_LANGUAGES, findLanguage } from '../../src/ide/languages.js';
import { ideAvailability } from '../../src/ide/runner.js';

/**
 * IDE 依赖环境的**地基**：一个"环境对象"。
 *
 * 这一批只验两件事，因为它们决定了后面所有东西的形状：
 * ① 纯计算与副作用必须分开 —— `ideEnvFor` 只算路径，不许顺手建目录。
 *    否则"读一下清单"就会创建环境，而清单是要在面板上反复拉的。
 * ② 环境只许存在于 `data/ide-env/` 下（红线一）。这里断言的是"路径确实长这样"，
 *    真正的"不许漏进判题"由 `server/test/regression/ide-env-isolation.test.ts` 守。
 *
 * 纪律同 REPL 与调试那批：需要真 venv 的用例在宿主机上 skip（宿主没装 python），
 * 全绿要在容器里看。
 */

const available = await ideAvailability();
const guarded = (id: string) => (available[id] === true ? it : it.skip);

const python = findLanguage('python')!;
const node = findLanguage('javascript')!;

describe('ideEnvFor：纯计算，不带副作用', () => {
  it('环境根不在 judge/ 下（在那儿就会被沙箱清扫顺手收掉用户装的包）', () => {
    expect(isAbsolute(IDE_ENV_ROOT), `IDE_ENV_ROOT 必须是绝对路径：${IDE_ENV_ROOT}`).toBe(true);
    expect(IDE_ENV_ROOT.startsWith(config.judgeWorkDir), 'IDE 环境不许落在判题沙箱目录里').toBe(false);
  });

  /**
   * 容器里必须由 compose 把环境指到卷上。实测同一个 `python3 -m venv`：
   * `/opt` 1.76s，bind mount 的 `/app/data` **87.2s** —— 慢 50 倍会直接撞穿创建超时，
   * 而且症状是"第一次用 IDE 就卡住"，没人会猜到是挂载类型。
   * 这条断言守的是那个配置别被悄悄删掉。
   */
  it('compose 把 arena 的 IDE 环境放在 bind mount 之外', () => {
    const y = readFileSync(join(config.repoRoot, 'compose.yml'), 'utf8');
    const arena = y.slice(y.indexOf('  arena:'), y.indexOf('  tools:'));
    const dir = /ARENA_IDE_ENV_DIR:\s*(\S+)/.exec(arena)?.[1];
    expect(dir, 'arena 服务没设 ARENA_IDE_ENV_DIR ⇒ 环境会落在 bind mount 上，创建要 87s').toBeTruthy();
    expect(dir!.startsWith('/app/data/'), 'IDE 环境不许落在 bind mount 的 data 下').toBe(false);
    expect(arena).toContain(`${dir!}`); // 该路径要真的挂出来，否则 rebuild 就没了
  });

  it('python 的解释器指向 venv 自己，而不是系统 python3', () => {
    const env = ideEnvFor(python);
    expect(env.executable).toBe(venvPythonPath(IDE_ENV_ROOT));
    expect(env.executable).toContain(join('ide-env', 'python'));
  });

  it('python 不靠 PYTHONPATH 生效（venv 自己解析 site-packages）', () => {
    // 这条断言是在挡一个具体的错误方向：有人图省事写 PYTHONPATH 指到 venv，
    // 那会让系统 python3 也看见用户包 —— 判题用的正是系统 python3。
    const env = ideEnvFor(python);
    expect(env.env.PYTHONPATH).toBeUndefined();
  });

  it('java / scala 把各自的 lib 目录挂进 classpath（按运行时家族分，不是按语言 id）', () => {
    const cases = [
      ['java', join('ide-env', 'java', 'lib')],
      ['spark-scala', join('ide-env', 'scala', 'lib')],
    ] as const;
    for (const [id, expected] of cases) {
      const cp = ideEnvFor(findLanguage(id)!).classpath;
      expect(cp.some((e) => e.includes(expected)), `${id} 的 classpath 应含 ${expected}`).toBe(true);
    }
  });

  it('javascript 与 typescript 共用同一个 node 环境（否则同一份包装两次）', () => {
    const js = ideEnvFor(findLanguage('javascript')!);
    const ts = ideEnvFor(findLanguage('typescript')!);
    expect(ts.nodeModulesDir).toBe(js.nodeModulesDir);
    expect(ts.env.NODE_PATH).toBe(js.env.NODE_PATH);
  });

  it('node 的模块根指向 ide-env/node，并且 NODE_PATH 也指过去', () => {
    const env = ideEnvFor(node);
    expect(env.nodeModulesDir).toBe(join(IDE_ENV_ROOT, 'node', 'node_modules'));
    expect(env.env.NODE_PATH).toBe(env.nodeModulesDir);
  });

  it('调用它不许创建任何目录（读清单会反复调它）', () => {
    const before = existsSync(IDE_ENV_ROOT);
    for (const lang of IDE_LANGUAGES) ideEnvFor(lang);
    expect(existsSync(IDE_ENV_ROOT), 'ideEnvFor 有副作用：它把环境目录建出来了').toBe(before);
  });

  it('sql / redis / c 这类"依赖是服务端或只能预装"的语言拿到空环境而不是报错', () => {
    for (const id of ['mysql', 'redis', 'c', 'cpp', 'pyspark']) {
      const env = ideEnvFor(findLanguage(id)!);
      expect(env.classpath, `${id} 本期不该有环境`).toEqual([]);
      expect(env.executable).toBeUndefined();
      expect(env.nodeModulesDir).toBeUndefined();
    }
  });
});

describe('体积统计（面板要显示"该 reset 了"的依据）', () => {
  it('不存在的环境算出来是 0，不是 NaN 也不是抛错', async () => {
    const bytes = await ideEnvPaths(join(IDE_ENV_ROOT, 'no-such-family')).measureBytes();
    expect(bytes).toBe(0);
  });

  it('真的能量到字节数（往临时目录写 1KB 就该被算进去）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arena-env-size-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'python', 'lib', 'site-packages'), { recursive: true });
    await writeFile(join(dir, 'python', 'lib', 'site-packages', 'blob.bin'), Buffer.alloc(1024));
    const bytes = await ideEnvPaths(dir).measureBytes();
    expect(bytes).toBeGreaterThanOrEqual(1024);
  });
});

describe('ensureIdeEnv：真建 venv（容器档）', () => {
  guarded('python')(
    '建出来的 venv 能 import 镜像预装的 pandas —— 这就是 --system-site-packages 必须开的原因',
    async () => {
      const env = await ensureIdeEnv(python);
      expect(env.executable).toBeTruthy();
      const { runProcess } = await import('../../src/judge/process.js');
      const res = await runProcess(env.executable!, ['-c', 'import pandas,sys;print(sys.version_info[0])'], {
        cwd: await mkdtemp(join(config.judgeWorkDir, 'ide-env-probe-')),
        timeoutMs: 60_000,
      });
      expect(res.code, `venv 里 import pandas 失败：${res.stderr.slice(0, 300)}`).toBe(0);
    },
    90_000,
  );

  guarded('python')(
    '幂等：第二次调用不许重建（重建会抹掉用户已装的包）',
    async () => {
      const first = await ensureIdeEnv(python);
      const dir = join(IDE_ENV_ROOT, 'python');
      // pyvenv.cfg 是 venv 创建时才写的文件：它的 mtime 变了就说明"又建了一次"。
      const cfg = join(dir, 'pyvenv.cfg');
      expect(existsSync(cfg), 'venv 缺 pyvenv.cfg，说明它不是 venv 而是手工目录').toBe(true);
      const cfgMtime = (await stat(cfg)).mtimeMs;
      const second = await ensureIdeEnv(python);
      expect(second.executable).toBe(first.executable);
      expect((await stat(cfg)).mtimeMs, 'pyvenv.cfg 被重写 ⇒ 环境被重建，用户装的包会没').toBe(cfgMtime);
    },
    90_000,
  );

  guarded('python')(
    '并发首次调用只建一次（两把同时跑会把 venv 建坏）',
    async () => {
      const [a, b] = await Promise.all([ensureIdeEnv(python), ensureIdeEnv(python)]);
      expect(a.executable).toBe(b.executable);
      expect(existsSync(venvPythonPath(IDE_ENV_ROOT))).toBe(true);
    },
    90_000,
  );
});
