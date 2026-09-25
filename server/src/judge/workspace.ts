import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { config } from '../config.js';

export interface Workspace {
  readonly root: string;
  path(...parts: string[]): string;
  write(rel: string, content: string | Buffer): Promise<string>;
  /** 把仓库内的静态资源（如 Harness.java）复制进沙箱 */
  copyFrom(absSource: string, rel: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** `cleanup()` 的重试次数（Windows 上句柄释放是几十毫秒级的事，四次够到 ~0.4s 窗口）。 */
const CLEANUP_ATTEMPTS = 4;

/**
 * 每次判题一个独立目录（rule.md C1：只写 data/judge，且清理前校验前缀防误删）。
 */
export async function createWorkspace(tag: string): Promise<Workspace> {
  const base = config.judgeWorkDir;
  await mkdir(base, { recursive: true });
  const safe = tag.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  const root = await mkdtemp(join(base, `${safe}-`));

  const resolveRel = (rel: string) => {
    const full = join(root, rel);
    if (!full.startsWith(root)) throw new Error(`沙箱路径越界: ${rel}`);
    return full;
  };

  const writeFileTo = async (rel: string, content: string | Buffer): Promise<string> => {
    const full = resolveRel(rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, typeof content === 'string' ? 'utf8' : undefined);
    return full;
  };

  const workspace: Workspace = {
    root,
    path: (...parts: string[]) => resolveRel(join(...parts)),
    write: writeFileTo,
    async copyFrom(absSource, rel) {
      return writeFileTo(rel, await readFile(absSource));
    },
    async cleanup() {
      if (!root.startsWith(base)) throw new Error(`拒绝删除非判题目录: ${root}`);
      await removeWithRetry(root);
    },
  };

  return workspace;
}

/**
 * 带重试的删除。Windows 上"进程刚死、目录还锁着"是真的（`rm` 抛 EBUSY / EPERM），
 * 而调用方普遍写成 `dispose().catch(() => undefined)` —— 不重试就等于**安静地攒孤儿目录**：
 * 判题与调试每跑一轮留一个，谁都不报错，直到 `data/judge` 攒出几百个。
 * 重试窗口 ~0.4s，够句柄释放；仍然删不掉就照实抛出（吞掉才是真把孤儿藏起来）。
 */
export async function removeWithRetry(
  root: string,
  opts: { attempts?: number; baseDelayMs?: number; remove?: (dir: string) => Promise<void> } = {},
): Promise<void> {
  const attempts = opts.attempts ?? CLEANUP_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? 40;
  const remove = opts.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(root);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * 数一下沙箱目录。**给断言用的时候要传 prefix**：判题与 IDE 的沙箱同住一个目录，
 * 而测试文件是并行跑的 —— 数"一共几个"等于让别的用例能随时把你的断言弄红
 * （调试会话就在旁边建它自己的沙箱）。
 */
export async function countJudgeWorkspaces(prefix?: string): Promise<number> {
  try {
    const names = await readdir(config.judgeWorkDir);
    return prefix ? names.filter((n) => n.startsWith(prefix)).length : names.length;
  } catch {
    return 0;
  }
}

export interface SweepOptions {
  /** 多久没动过就算残留。默认 `SWEEP_MAX_AGE_MS`。 */
  maxAgeMs?: number;
  now?: () => Date;
}

/**
 * 残留判定的时限。**这条数值是一个约束，不是偏好**：清扫只看目录 mtime、不问有没有进程在用，
 * 所以它必须大于"任何可能活着的沙箱"的最长寿命（判题单次上限、IDE 会话的空闲回收 + 宽限期）。
 * 那条约束由 `judge-workspace.test.ts` 钉住 —— 抬高超时的人不会想到来这里改数字。
 */
export const SWEEP_MAX_AGE_MS = 3_600_000;

/**
 * 回收某个暂存目录下"很久没动过"的子目录。
 * 只碰直接子目录、只碰目录、且必须超过时限 —— 正在用的一律不动。
 * 两处调用：判题沙箱（进程被杀时 runner 的 finally 不跑）与 Spark 的 blockmgr 暂存
 * （常驻 JVM 每次重启都留下一批没人认领的目录）。
 */
export async function sweepStaleDirs(base: string, opts: SweepOptions = {}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? SWEEP_MAX_AGE_MS;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const full = join(base, name);
    if (!full.startsWith(`${base}${sep}`)) continue;
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue; // 普通文件不是暂存目录，留着别乱动
    if (nowMs - info.mtimeMs < maxAgeMs) continue;
    try {
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 删不掉就留给下一次：清扫是加分项，不能变成启动失败的原因
    }
  }
  return removed;
}

/** 判题沙箱残留（data/judge）。 */
export function sweepStaleWorkspaces(opts: SweepOptions = {}): Promise<number> {
  return sweepStaleDirs(config.judgeWorkDir, opts);
}
