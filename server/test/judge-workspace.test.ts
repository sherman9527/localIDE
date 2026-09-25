import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { missingScaffolds } from '../src/judge/runners/react-vitest.js';
import {
  countJudgeWorkspaces,
  createWorkspace,
  removeWithRetry,
  sweepStaleDirs,
  sweepStaleWorkspaces,
  SWEEP_MAX_AGE_MS,
} from '../src/judge/workspace.js';

/**
 * 判题沙箱的残留清扫。
 * 每次判题建一个目录、finally 里删 —— 但进程被杀（容器重启、OOM、Ctrl+C）时 finally 不会跑，
 * 那些目录就永远留在 data/judge 里：一次 Spark 作业能占几十 MB，攒几天就是几百 MB 的垃圾，
 * 而且没人知道它们为什么在那儿。启动时扫一次"一小时没动过"的目录即可，正在判的不会误删。
 */

const HOUR = 3_600_000;
let base: string;
const made: string[] = [];

const sandbox = async (name: string, ageMs: number) => {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Solution.java'), 'public class Solution{}', 'utf8');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  made.push(dir);
  return dir;
};

beforeEach(async () => {
  base = config.judgeWorkDir;
  await mkdir(base, { recursive: true });
});

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('sweepStaleWorkspaces — 启动时回收判题沙箱残留', () => {
  it('只删超过时限的目录，正在判的（刚写过）一个都不碰', async () => {
    const stale = await sandbox('sweep-old-1', 3 * HOUR);
    const fresh = await sandbox('sweep-new-1', 1_000);
    const removed = await sweepStaleWorkspaces({ maxAgeMs: HOUR });
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await readdir(base);
    expect(left).toContain('sweep-new-1');
    expect(left).not.toContain('sweep-old-1');
    expect(made).toContain(stale);
    expect(made).toContain(fresh);
  });

  it('数得清还剩几个（这个计数同时是启动日志里的可观测点）', async () => {
    await sandbox('sweep-count-1', 1_000);
    expect(await countJudgeWorkspaces()).toBeGreaterThanOrEqual(1);
  });

  it('顶层的普通文件不是沙箱，跳过而不是报错', async () => {
    // 这条**必须用临时目录**：`maxAgeMs: 0` 的语义是"一个都不放过"，
    // 打在共享的 data/judge 上就会把并发在跑的兄弟沙箱一起删掉
    // —— `server/test/regression/reference-solutions` 与被判题 suite 是同一批 worker 里跑的，
    // 症状是别人的 harness 半路消失（esbuild: Could not resolve .../vitest.config.mjs）。
    const tmp = await mkdtemp(join(config.dataDir, 'judge-sweep-test-'));
    made.push(tmp);
    await writeFile(join(tmp, 'sweep-stray.txt'), 'x', 'utf8');
    await mkdir(join(tmp, 'sweep-live-1'), { recursive: true });
    // `now` 是注入的，不赌时钟：Windows 上刚建目录的 mtime 可以比 Date.now() 晚几十毫秒，
    // 那样 `maxAgeMs: 0` 反而"还没到龄"一条都不删 —— 容器里绿、宿主上红就是它。
    await expect(sweepStaleDirs(tmp, { maxAgeMs: 0, now: () => new Date(Date.now() + HOUR) })).resolves.toBe(1);
    const left = await readdir(tmp);
    expect(left).toContain('sweep-stray.txt');       // 普通文件留着不乱动
    expect(left).not.toContain('sweep-live-1');      // 目录按 maxAge=0 删掉，证明删的是目录
  });
});

/**
 * WI-72 的取证钩子：react-vitest 沙箱偶发 `Could not resolve .../vitest.config.mjs`，
 * 而这句话同时兼容"没写成"与"写成了但 spawn 前被删"。runner 现在在 spawn 前 stat 一次，
 * 这个函数就是那次 stat —— 它自己必须先被测过，否则"下次复发时看日志"又是一句空话。
 */
describe('missingScaffolds — spawn 前的脚手架存在性检查', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(config.dataDir, 'judge-scaffold-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('全都在就是空清单；少一个只报那一个（相对路径原样回，日志里要能对着工作区看）', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'vitest.config.mjs'), 'export default {}', 'utf8');
    await writeFile(join(dir, 'src', 'Solution.tsx'), 'export default 1', 'utf8');
    const paths = ['vitest.config.mjs', 'src/Solution.tsx'];
    expect(await missingScaffolds(dir, paths)).toEqual([]);
    await rm(join(dir, 'src', 'Solution.tsx'));
    expect(await missingScaffolds(dir, paths)).toEqual(['src/Solution.tsx']);
  });

  it('整个目录不见了也要报成缺失，而不是把 ENOENT 抛出去', async () => {
    expect(await missingScaffolds(join(dir, 'never-created'), ['vitest.config.mjs'])).toEqual(['vitest.config.mjs']);
  });

  it('接线本身也要有闸门：spawn 之前必须查一次，查到的要落日志', () => {
    // 单元测试只证明"探测器会响"，不证明"runner 真的在叫它"。WI-72 复发的唯一价值
    // 就是日志里那条区分，所以这条接线被人顺手删掉时必须有人挡一下。
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'judge', 'runners', 'react-vitest.ts'), 'utf8');
    const lastWrite = src.lastIndexOf('await ws.write(');
    const guard = src.indexOf('await missingScaffolds(ws.root', lastWrite); // 写完之后的那一次
    const spawn = src.indexOf('const run = await runProcess(');
    expect(lastWrite, '没找到脚手架落盘的地方（文件结构变了，请同步这条断言）').toBeGreaterThan(-1);
    expect(guard, '落盘之后没有再 stat 一次 —— WI-72 的探测器被删了').toBeGreaterThan(lastWrite);
    expect(spawn, '没找到 spawn 点（文件结构变了，请同步这条断言）').toBeGreaterThan(-1);
    expect(guard, 'stat 必须在 vitest 启动之前，否则区分不了"没写成"与"跑一半被删"').toBeLessThan(spawn);
    expect(src.slice(guard, spawn)).toContain("logWarn('judge', 'react-scaffold-missing'");
    expect(src).toContain("logWarn('judge', 'react-resolve-failed'");
  });
});

describe('removeWithRetry — 删不掉的沙箱要重试，不能安静攒孤儿', () => {
  /**
   * Windows 上"进程刚死、目录还锁着"是真的（`rm` 抛 EBUSY / EPERM），而调用方普遍写成
   * `dispose().catch(() => undefined)` —— 不重试就等于**每次调试留一个目录且谁都不报错**。
   * 那是门禁偶发红里"调试沙箱没收干净"的另一半成因。
   * ｜前两条注入 `remove` 而不是真造一把锁：Linux 上 `rm` 对开着的句柄照样成功，
   * 拿真锁写断言只会得到一条"只在某台机器上才有意义"的测试。
   */
  it('前两次失败、第三次成功 ⇒ 结算成成功，且真的试到第三次', async () => {
    let calls = 0;
    await removeWithRetry(join(base, 'whatever'), {
      baseDelayMs: 1,
      remove: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      },
    });
    expect(calls).toBe(3);
  });

  it('一直失败就把最后一次的错抛出去（吞掉才是真把孤儿藏起来）', async () => {
    let calls = 0;
    await expect(
      removeWithRetry(join(base, 'whatever'), {
        attempts: 2,
        baseDelayMs: 1,
        remove: async () => {
          calls += 1;
          throw new Error('EPERM: 目录还锁着');
        },
      }),
    ).rejects.toThrow('EPERM');
    expect(calls).toBe(2);
  });

  it('cleanup 走的就是这条重试（真句柄：释放之后目录必须真的没了）', async () => {
    const ws = await createWorkspace('wslock');
    made.push(ws.root);
    const held = await ws.write('held.txt', 'x');
    const handle = await open(held, 'r');
    setTimeout(() => void handle.close(), 150);
    await ws.cleanup();
    expect(existsSync(ws.root), '重试之后目录还在').toBe(false);
  });
});

describe('清扫的时限是一个约束，不是一个偏好（WI-72 的两条候选之一）', () => {
  /**
   * 清扫**只看目录 mtime，不问有没有进程在用**。所以"时限多大"不是风格问题：
   * 只要有一种沙箱能合法地活过它，启动清扫就会去删别人正在用的目录 ——
   * 那正是 WI-72 那个"harness 半路消失"的候选机制之一。
   * 这条测试的作用是把那句话变成会红的断言：以后谁抬高超时或空闲回收，这里先炸。
   */
  it('默认时限必须明显大于"任何可能活着的沙箱"的最长寿命', async () => {
    const { IDE_LIMITS } = await import('../src/ide/languages.js');
    const { IDE_SESSION_LIMITS } = await import('@arena/shared');
    const { RUNNER_TIMEOUT_CAP_MS } = await import('@arena/shared');
    const longestAlive = Math.max(
      RUNNER_TIMEOUT_CAP_MS, // 一道题的判题上限（schema 卡死）
      IDE_LIMITS.maxTimeoutMs, // 一次 IDE 运行
      IDE_SESSION_LIMITS.idleMs + IDE_SESSION_LIMITS.stopGraceMs, // 一个常驻会话（REPL / 调试）
    );
    expect(SWEEP_MAX_AGE_MS, `清扫时限 ${SWEEP_MAX_AGE_MS} 必须大于最长寿命 ${longestAlive}`)
      .toBeGreaterThan(longestAlive);
    // 两倍余量：mtime 只在"写文件"时刷新，慢任务可能长时间不动目录但仍活着
    expect(SWEEP_MAX_AGE_MS).toBeGreaterThan(longestAlive * 2);
  });

  /**
   * 机制本身也要有证据，不能只在注释里声称"正在用的一律不动"。
   * 实测（两台都测过）：**开着句柄挡不住删除** —— Node 在 Windows 上打开文件时默认带
   * `FILE_SHARE_DELETE`，POSIX 更是本来就不挡。所以唯一挡住清扫的只有 mtime 那道时限。
   * （写这条之前我以为 Windows 会挡，那是假设不是事实 —— 断言按量到的写。）
   */
  it('只看 mtime：过期目录即使有进程开着句柄也会被删（两台都是）', async () => {
    const dir = await sandbox('live-handle', 2 * 3_600_000); // mtime 两小时前
    const handle = await open(join(dir, 'Solution.java'), 'r');   // sandbox() 写的就是这个文件
    const removed = await sweepStaleWorkspaces({ maxAgeMs: 3_600_000, now: () => new Date() });
    await handle.close();
    expect(removed, 'mtime 一到就删，进程还开着句柄也照删 ⇒ 时限是唯一防线').toBe(1);
    expect(existsSync(dir)).toBe(false);
  });
});
