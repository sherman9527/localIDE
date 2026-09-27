import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, consumeIdeEnvDir } from '../../src/config.js';
import { runProcess } from '../../src/judge/process.js';

/**
 * 红线一：IDE 的依赖环境（`data/ide-env/`）绝不允许出现在判题进程里。
 *
 * 为什么风险是真实的而不是理论上的：判题的 env 构造是
 * `judge/process.ts:31` 与 `exec/spark-pool.ts:191` 两处的 `{ ...process.env, ...opts.env }`。
 * 于是"给 IDE 注入环境"有一条极其顺手、又正好毁掉判题可复现性的写法 ——
 * 在服务端启动时写一句 `process.env.PYTHONPATH = ...`。它不会报错，只会让
 * "用户今天在 IDE 里装的包"改变"明天判题的结果"，而 `docker/BUILDINFO.md` 承诺的是
 * 重建镜像即可复现。⇒ 这条闸门必须在功能存在之前先立住。
 *
 * 四条断言各守一层，缺一不可：
 *   A 行为：真的走一次 runProcess，看子进程拿到的 env 里有没有 ide-env。
 *   B 全局：服务进程自己的 process.env 必须干净（A 之所以成立是因为 B）。
 *   B2 机制：B 在容器里成立是因为 config 把 ARENA_IDE_ENV_DIR 读完就摘掉 —— 那个动作本身要能验，
 *            否则 B 只是在赌"这台机器没设过这个变量"（容器里就是设过的，见下）。
 *   C 源码：判题目录不许引用 ide-env；IDE 目录不许写 process.env。
 *
 * B 为什么不能只靠"宿主上没这个变量"就算通过：compose 给 arena / dev / e2e 三个服务都显式设了
 * `ARENA_IDE_ENV_DIR=/opt/arena-ide-env`（venv 建在 bind mount 上要 87s，必须指到命名卷），
 * 所以容器里服务进程的 process.env 天生带它，而它会被每一个判题子进程继承。
 * 这条闸门第一次在容器交付档跑红（宿主全绿），修法是把变量在 config 里消费掉，而不是在判题层过滤
 * —— 后者要求判题层知道 IDE 有这套东西，那正是红线一不想要的。
 */

const IDE_ENV_MARKER = 'ide-env';

function envLooksClean(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && v.includes(IDE_ENV_MARKER))
    .map(([k]) => k);
}

describe('红线一：IDE 依赖环境不许污染判题', () => {
  it('B 服务进程自己的 env 里没有任何 ide-env 路径（两处 ...process.env 的根）', () => {
    expect(
      envLooksClean(process.env),
      'IDE 的环境被写进了服务进程全局 —— 判题子进程会经由 `{...process.env}` 继承它',
    ).toEqual([]);
  });

  it('B2 config 把 ARENA_IDE_ENV_DIR 读完就摘掉（B 靠的是这个动作，不是"这台机器没设过"）', () => {
    const key = 'ARENA_IDE_ENV_DIR';
    const original = process.env[key];
    try {
      process.env[key] = join(config.dataDir, 'ide-env-probe');
      expect(consumeIdeEnvDir(), '没读到刚设的值 ⇒ 容器里卷路径会被静默换成默认值（venv 创建要 87s）').toContain('ide-env-probe');
      expect(process.env[key], '读完没摘掉 ⇒ 每一个判题子进程都会继承它，红线一当场作废').toBeUndefined();
      // 摘掉之后必须回到默认值：IDE 与判题必须算出同一个根，否则面板列的包和 IDE 用的包不是一份
      expect(consumeIdeEnvDir()).toBe(join(config.dataDir, 'ide-env'));
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('A 真的起一个判题子进程，它看到的 env 里没有 ide-env', async () => {
    // 走真实路径而不是复述常量：runProcess 就是判题所有 runner 的那个出口。
    // 用 node 是因为它在宿主与容器里都在，这条断言要能在快档跑。
    const res = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { cwd: config.repoRoot, timeoutMs: 20_000, env: { ARENA_JUDGE_PROBE: '1' } },
    );
    expect(res.timedOut, '探测进程超时').toBe(false);
    const seen = JSON.parse(res.stdout || '{}') as Record<string, string | undefined>;
    expect(
      envLooksClean(seen),
      `判题子进程从 process.env 继承了带 ide-env 的变量：${envLooksClean(seen).join(', ')}`,
    ).toEqual([]);
  });

  const walkTs = (absDir: string, out: string[]): string[] => {
    for (const name of readdirSync(absDir)) {
      const p = join(absDir, name);
      if (statSync(p).isDirectory()) walkTs(p, out);
      else if (/\.ts$/.test(name)) out.push(p);
    }
    return out;
  };
  const srcFiles = (dir: string): string[] => walkTs(join(config.repoRoot, dir), []);

  it('C1 判题与执行层的源码里不许出现 ide-env（要注入也只许注入 IDE 那三条路径）', () => {
    const offenders: string[] = [];
    for (const dir of ['server/src/judge', 'server/src/exec']) {
      for (const f of srcFiles(dir)) {
        if (readFileSync(f, 'utf8').includes(IDE_ENV_MARKER)) offenders.push(relative(config.repoRoot, f));
      }
    }
    expect(offenders, `判题/执行层引用了 IDE 环境目录：${offenders.join(', ')}`).toEqual([]);
  });

  it('C2 IDE 侧不许写 process.env（那是经由继承漏进判题的唯一通路）', () => {
    const offenders: string[] = [];
    for (const f of srcFiles('server/src/ide')) {
      const text = readFileSync(f, 'utf8');
      // 只抓赋值形态；读取（process.env.X）是合法的，比如 ARENA_PYTHON
      for (const line of text.split(/\r?\n/)) {
        if (/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test(line) || /process\.env\[[^\]]+\]\s*=[^=]/.test(line)) {
          offenders.push(`${relative(config.repoRoot, f)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, `IDE 代码在往全局 process.env 写值：\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * 反向对照：上面那几条如果"天生就绿"，它们可能只是在什么也没看。
 * 这里主动制造污染，确认闸门真的会拦 —— 这是本仓库"破坏性验证"要求的一部分。
 */
describe('红线的守卫自身也要被验（反向对照）', () => {
  it('把 ide-env 写进 process.env 之后，B 那条判据必须判为脏', () => {
    const key = 'ARENA_PROBE_CONTAMINATE';
    process.env[key] = join(config.dataDir, 'ide-env', 'python', 'site-packages');
    try {
      expect(envLooksClean(process.env)).toContain(key);
    } finally {
      delete process.env[key];
    }
    // 撤掉之后必须重新变干净，否则 B 的断言是在赌执行顺序
    expect(envLooksClean(process.env)).toEqual([]);
  });

  it('C2 的正则真的抓得住赋值写法（给它一个样本必须命中）', () => {
    const sample = '  process.env.PYTHONPATH = "/app/data/ide-env/python";';
    expect(/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test(sample)).toBe(true);
    // 而合法的读取不许误报，否则这条闸门会变成没人敢碰的噪音源
    expect(/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test('  const py = process.env.ARENA_PYTHON ?? "python3";')).toBe(false);
  });

  it('C1 的扫描真的读到了东西（扫空目录等于这条闸门在空转）', () => {
    const judgeDir = join(config.repoRoot, 'server', 'src', 'judge');
    const walked: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n)) walked.push(p);
      }
    };
    walk(judgeDir);
    expect(walked.length, `没在 ${relative(config.repoRoot, judgeDir)} 扫到任何 .ts，说明 C1 在空转`).toBeGreaterThan(5);
    // 顺带确认 execFileSync 可用（下面的 git 断言依赖它，坏环境要在这里早暴露）
    expect(() => execFileSync('git', ['--version'], { encoding: 'utf8' })).not.toThrow();
  });
});
