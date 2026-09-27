import { existsSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { runProcess } from '../judge/process.js';
import type { IdeLanguage } from './languages.js';

/**
 * IDE 的依赖环境：一个"环境对象"，而不是散在各处的解释器路径。
 *
 * 为什么要有这个文件：IDE 里一门语言有**三条执行路径**（一次性运行、REPL、行断点），
 * 它们原本各自写着裸 `python3` / 裸 `java -cp .`。依赖一旦要生效，只改一条就会出现
 * "装了但 REPL 里 import 不到"这种零报错的不一致 —— 所以路径与环境变量必须只有一个来源。
 *
 * 三条硬约束（都有对应闸门守着）：
 * ① 一切用户装的东西只落在 `data/ide-env/` 下，判题永远看不到它
 *    （`server/test/regression/ide-env-isolation.test.ts` 守）。
 * ② 本文件**不写 `process.env`**：判题的 env 是 `{...process.env, ...opts.env}`，
 *    写全局等于把 ① 从后门拆掉。要注入就注入到子进程的 env 参数上。
 * ③ `ideEnvFor` 是纯函数（只算路径、不建目录）；建目录是 `ensureIdeEnv` 的活。
 *    分开的理由：清单会被面板反复读，读一次就建一次环境是错的。
 */

/**
 * 环境根目录。**默认落在 dataDir 下，但容器里必须由 compose 指到卷上** ——
 * 这不是风格问题：`data/` 是 Windows 的 bind mount，venv 要写几千个小文件，实测
 * 同一个 `python3 -m venv` 在 `/opt` 是 1.76s、在 `/app/data` 是 **87.2s**（慢 50 倍），
 * 直接撞穿创建超时。⇒ 容器里 `ARENA_IDE_ENV_DIR=/opt/arena-ide-env`（命名卷，
 * 既快又能跨 rebuild 保留）；宿主 `--dev` 没有这个变量，退回 dataDir 照常可用。
 */
export const IDE_ENV_ROOT = process.env.ARENA_IDE_ENV_DIR ?? join(config.dataDir, 'ide-env');

/**
 * 环境按**运行时家族**分，不按语言 id —— javascript 与 typescript 必须共用同一个
 * node_modules，否则用户要为同一份包装两次、还得猜哪门语言看得见它。
 */
export type IdeEnvFamily = 'python' | 'node' | 'java' | 'scala';

const FAMILY_BY_LANGUAGE: Partial<Record<IdeLanguage['id'], IdeEnvFamily>> = {
  python: 'python',
  java: 'java',
  javascript: 'node',
  typescript: 'node',
  'spark-scala': 'scala',
};

export function envFamilyOf(language: IdeLanguage): IdeEnvFamily | undefined {
  return FAMILY_BY_LANGUAGE[language.id];
}

/**
 * 没有环境的语言要有一句**说得出口的理由**。清单与 reset 都要用，
 * 所以只写一份 —— 两处各写一遍，将来一定有一处变成假话。
 */
const UNSUPPORTED_REASON: Partial<Record<IdeLanguage['id'], string>> = {
  c: 'C 的依赖只能靠镜像预装（apt），运行期装不了',
  cpp: 'C++ 的依赖只能靠镜像预装（apt），运行期装不了',
  mysql: 'SQL 的"依赖"是那个 mysqld 本身，不是包',
  redis: 'Redis 的"依赖"是那个 redis-server 本身，不是包',
  pyspark: 'PySpark 的解释器由 Spark 会话池持有，而那个池与判题共用 —— 单独开环境会撞红线',
};

export function envUnsupportedReason(language: IdeLanguage): string {
  return UNSUPPORTED_REASON[language.id] ?? `${language.label} 没有可安装的依赖环境`;
}

/** venv 的目录布局随平台变（Windows 是 Scripts/python.exe），所以只有这一处知道它长什么样。 */
export function venvPythonPath(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'python', 'Scripts', 'python.exe')
    : join(root, 'python', 'bin', 'python');
}

/** venv 自己的 site-packages 父目录（清单只扫这里 ⇒ "用户装的"与"镜像带的"天然分开） */
export function venvSitePackagesRoot(root: string): string {
  return join(root, 'python', 'lib');
}

export function familyDir(root: string, family: IdeEnvFamily): string {
  return join(root, family);
}

export interface IdeEnv {
  /** 覆盖注册表里的解释器；undefined 表示沿用语言自己的命令 */
  executable?: string;
  /** 只给子进程，绝不写进 process.env */
  env: NodeJS.ProcessEnv;
  /** javac/java 的 -cp 追加项；`lib/*` 是 javac 自己支持的通配 */
  classpath: string[];
  nodeModulesDir?: string;
}

/** 纯计算：不碰文件系统。 */
export function ideEnvFor(language: IdeLanguage, root: string = IDE_ENV_ROOT): IdeEnv {
  const family = envFamilyOf(language);
  const env: IdeEnv = { env: {}, classpath: [] };
  if (!family) return env; // c / cpp / mysql / redis / pyspark：本期没有环境（理由见设计 §6）

  if (family === 'python') {
    env.executable = venvPythonPath(root);
    return env; // 不设 PYTHONPATH：venv 自己解析，设了反而会让系统 python3 也看见用户包
  }
  if (family === 'node') {
    env.nodeModulesDir = join(familyDir(root, 'node'), 'node_modules');
    env.env.NODE_PATH = env.nodeModulesDir;
    return env;
  }
  // javac 的 `-cp` 会**顶掉**默认的"当前目录"，所以 `.` 必须显式带上，
  // 否则用户代码连自己写的同目录类都找不到（实测过一次：只给 lib/* 就报找不到 Main）。
  env.classpath = ['.', join(familyDir(root, family), 'lib', '*')];
  if (family === 'java') env.classpath.push(config.junitJar); // 镜像带的，不算"用户自装"
  return env;
}

/**
 * 语言表里的 classpath 占位符。注册表是静态字面量，而 classpath 要在运行期才知道
 * （卷路径、junit jar 都来自 config），所以表里放这个记号、由 resolveCommand 展开。
 */
export const IDE_CLASSPATH_ARG = '@@CLASSPATH@@';

/** 把环境套到一条命令上：解释器换成 venv 的、classpath 占位符展开。 */
export function resolveCommand(cmd: { command: string; args: readonly string[] }, env: IdeEnv): { command: string; args: string[] } {
  const args = cmd.args.map((a) => (a === IDE_CLASSPATH_ARG ? env.classpath.join(pathDelimiter) : a));
  return { command: env.executable ?? cmd.command, args };
}

const pathDelimiter = process.platform === 'win32' ? ';' : ':';

export interface IdeEnvPaths {
  measureBytes(): Promise<number>;
}

export function ideEnvPaths(root: string): IdeEnvPaths {
  return { measureBytes: () => sumBytes(root) };
}

/** 目录不存在算 0 而不是抛错 —— 面板要在"还没装过任何东西"的状态下也能拉清单。 */
export async function sumBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = await stat(p);
      total += st.isDirectory() ? await sumBytes(p) : st.size;
    } catch {
      continue; // 边算边被删：少算一点好过整条查询失败
    }
  }
  return total;
}

/**
 * 建环境。每个家族一把锁：两个请求同时首次进入会各建一次 venv，
 * 而"建一半被另一个覆盖"留下的正是一个 import 不到又不报错的环境。
 */
const ensuring = new Map<IdeEnvFamily, Promise<void>>();

async function buildFamily(family: IdeEnvFamily): Promise<void> {
  if (family === 'python') {
    if (existsSync(venvPythonPath(IDE_ENV_ROOT))) return;
    const target = familyDir(IDE_ENV_ROOT, 'python');
    // 必须先建好 cwd：spawn 的 cwd 不存在时，Node 报的是 `spawn python3 ENOENT` ——
    // 一个指向命令名的错，极易被读成"容器里没装 python"（实测就是这样绕了一圈）。
    await mkdir(IDE_ENV_ROOT, { recursive: true });
    // --system-site-packages 不是可省的：不开它，镜像里预装的 pandas 在 IDE 里反而 import 不到，
    // 那是倒退。区分"用户装的"靠只扫 venv 自己的 site-packages，不靠把系统包挡在外面。
    const res = await runProcess('python3', ['-m', 'venv', '--system-site-packages', target], {
      cwd: IDE_ENV_ROOT,
      timeoutMs: 120_000,
    });
    if (res.code !== 0) {
      throw new Error(`创建 IDE 的 python 环境失败（exit ${res.code}）：${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    return;
  }
  await mkdir(join(familyDir(IDE_ENV_ROOT, family), 'lib'), { recursive: true });
}

export async function ensureIdeEnv(language: IdeLanguage): Promise<IdeEnv> {
  const family = envFamilyOf(language);
  if (!family) return ideEnvFor(language);
  const pending = ensuring.get(family);
  if (!pending) {
    const task = buildFamily(family).finally(() => ensuring.delete(family));
    ensuring.set(family, task);
    await task;
  } else {
    await pending;
  }
  return ideEnvFor(language);
}
