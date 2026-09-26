import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import {
  IDE_ENV_ROOT,
  ensureIdeEnv,
  ideEnvFor,
  ideEnvPaths,
  venvPythonPath,
  venvSitePackagesRoot,
} from '../../src/ide/env.js';
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

/**
 * T3：一门语言在 IDE 里有**三条**执行路径（一次性运行、REPL、行断点），
 * 它们必须用同一个环境。只接一条是这里最容易犯的错，而且不报错 ——
 * 用户看到的是"我明明装了，REPL 里 import 不到"。
 *
 * 哨兵是手工放进环境目录的，不走 pip/npm：这条测试要验的是"路径接通没有"，
 * 不是"网络与镜像源好不好"。
 */
describe('T3 三条执行路径共用同一环境', () => {
  const sentinel = 'arena_env_sentinel';

  /** 往 venv 自己的 site-packages 里放一个模块（等价于"用户装过了"）。 */
  async function plantPythonSentinel(): Promise<void> {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const site = await firstSitePackages();
    await mkdir(join(site, sentinel), { recursive: true });
    await wf(join(site, `${sentinel}.py`), `MARKER = "from-venv"\n`);
  }

  async function firstSitePackages(): Promise<string> {
    const { readdir } = await import('node:fs/promises');
    const libDir = venvSitePackagesRoot(IDE_ENV_ROOT);
    const pythons = await readdir(libDir);
    const first = pythons[0];
    if (!first) throw new Error(`venv 里没有 python 版本目录：${libDir}`);
    return join(libDir, first, 'site-packages');
  }

  guarded('python')('一次性运行读得到 venv 里的模块', async () => {
    await ensureIdeEnv(python);
    await plantPythonSentinel();
    const { runIdeCode } = await import('../../src/ide/runner.js');
    const res = await runIdeCode({
      language: 'python',
      code: `import ${sentinel}; print(${sentinel}.MARKER)`,
    });
    expect(res.stdout, `run 路径没读到 venv：${res.stderr.slice(0, 200)}`).toContain('from-venv');
  });

  guarded('python')('REPL 会话读得到 venv 里的模块', async () => {
    await ensureIdeEnv(python);
    await plantPythonSentinel();
    const { startRepl, feedRepl, stopRepl } = await import('../../src/ide/repl.js');
    const started = await startRepl('python');
    expect(started.session, `REPL 起不来，这条用例没有意义：${started.message ?? ''}`).not.toBeNull();
    const sessionId = started.session!.id;
    try {
      const fed = await feedRepl(sessionId, `import ${sentinel}; print(${sentinel}.MARKER)`);
      expect(fed.output, `REPL 路径没读到 venv（status=${fed.status}）：${fed.output.slice(0, 200)}`).toContain('from-venv');
    } finally {
      await stopRepl(sessionId);
    }
  });

  guarded('python')(
    '行断点调试用的也是 venv（用 sys.prefix 认，它等于 venv 根才算数）',
    async () => {
      await ensureIdeEnv(python);
      const { pythonBackend } = await import('../../src/ide/debug-python.js');
      const { IDE_SESSION_LIMITS } = await import('@arena/shared');
      let out = '';
      const launched = await pythonBackend.launch({
        code: 'import sys\nprint("PREFIX=" + sys.prefix)\n',
        breakpoints: [],
        startupBudgetMs: IDE_SESSION_LIMITS.debugStartTimeoutMs,
        emit: (e) => {
          if (e.type === 'output') out += e.text;
        },
      });
      if (!launched.ok) throw new Error(`调试后端起不来：${'text' in launched.event ? launched.event.text : launched.event.type}`);
      try {
        launched.handle.send('continue');
        await new Promise((r) => setTimeout(r, 2500));
      } finally {
        await launched.handle.dispose();
      }
      const venvRoot = join(IDE_ENV_ROOT, 'python');
      expect(out, '调试会话一条 stdout 都没有，这条用例没有意义').toContain('PREFIX=');
      // 直接比字符串：容器里 IDE_ENV_ROOT 是 posix 路径，不需要任何斜杠归一化
      expect(out, `调试用的是系统 python 而不是 venv（期望前缀 ${venvRoot}）`).toContain(`PREFIX=${venvRoot}`);
    },
    90_000,
  );

  // 宿主可能装了 javac 却没有容器里那个 /opt/junit —— 只认 jar 真的在，才算这条用例的前提成立。
  const javaGuarded = guarded('java');
  const guardedJava = (name: string, fn: () => Promise<void>) =>
    existsSync(config.junitJar) ? javaGuarded(name, fn) : it.skip(name);

  guardedJava('IDE 里能 import JUnit（判题一直可以，IDE 不行是 bug 不是设计）', async () => {
    const { runIdeCode } = await import('../../src/ide/runner.js');
    const res = await runIdeCode({
      language: 'java',
      code: [
        'import org.junit.jupiter.api.Test;',
        'public class Main {',
        '  @Test void t() {}',
        '  public static void main(String[] a) { System.out.println("junit-visible"); }',
        '}',
      ].join('\n'),
    });
    expect(res.stderr, 'javac 找不到 junit ⇒ IDE 的 -cp 没和判题对齐').not.toMatch(/程序包|package .* does not exist/);
    expect(res.stdout).toContain('junit-visible');
  });
});

/**
 * T4：结构闸门。上面那三条行为断言只在"环境接错时会红"；这条守的是**以后新加的执行路径**
 * 绕过 `resolveCommand` 的情况 —— 那正是"三条路径同源"这个约定被悄悄破坏的方式，
 * 而且加一条路径不会让任何现有测试变红。
 */
describe('T4 执行路径必须经过环境解析（结构闸门）', () => {
  const read = (rel: string): string => readFileSync(join(config.repoRoot, 'server', 'src', 'ide', rel), 'utf8');

  it('调试后端不许出现字面量 python3（不留兜底，兜底等于允许环境没接上）', () => {
    expect(read('debug-python.ts')).not.toContain("'python3'");
  });

  it('REPL 不许把注册表里的默认命令直接 spawn —— 必须经过 resolveCommand', () => {
    const src = read('repl.ts');
    expect(src, 'REPL 要先解析环境再起进程').toMatch(/spawn\(\s*cmd\.command/);
    expect(src, 'REPL 里出现直接 spawn(spec.command) 就等于绕过环境').not.toMatch(/spawn\(\s*spec\.command/);
  });

  it('一次性运行的 compile 与 run 共用同一次环境解析（各算一遍会出现"编译看得见、运行时看不见"）', () => {
    const src = read('runner.ts');
    expect(src.match(/ensureIdeEnv\(/g)?.length ?? 0, 'runner 里只应解析一次环境').toBe(1);
    expect(src).toMatch(/resolveCommand\(language\.compile/);
    expect(src).toMatch(/resolveCommand\(language\.run/);
  });
});
