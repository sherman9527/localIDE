import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 项目根不能靠固定的 ../../.. 推断：源码直跑（vitest 别名）、dist 运行、容器挂载下的
 * 深度都不一样，猜错会把判题沙箱写到文件系统根目录。因此一律向上查找标记文件。
 */
function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth++) {
    const looksLikeRoot =
      existsSync(join(dir, 'content', 'questions')) &&
      existsSync(join(dir, 'server', 'src')) &&
      existsSync(join(dir, 'package.json'));
    if (looksLikeRoot) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

const repoRoot = process.env.ARENA_ROOT ?? findRepoRoot(import.meta.dirname);

/**
 * `ARENA_DATA_DIR` 是"所有可写产物"的总开关：db、判题沙箱、日志、spark 暂存都从它派生。
 * 漏一个（比如 db 仍写死 data/arena.db）就会让"换一个数据目录"变成"只换了一半"——
 * E2E 想隔离却照样改动真人进度（WI-40 的起因）。单条路径仍可用 ARENA_DB_FILE 等显式覆盖。
 */
const dataDir = process.env.ARENA_DATA_DIR ?? join(repoRoot, 'data');

/** 全部路径默认落在仓库目录内（rule.md C1）。 */
export const config = {
  repoRoot,
  port: Number(process.env.ARENA_PORT ?? 7788),
  host: process.env.ARENA_HOST ?? '0.0.0.0',
  bankDir: process.env.ARENA_BANK_DIR ?? join(repoRoot, 'content', 'questions'),
  curriculumDir: process.env.ARENA_CURRICULUM_DIR ?? join(repoRoot, 'content', 'curriculum'),
  hiddenFile: process.env.ARENA_HIDDEN_FILE ?? join(repoRoot, 'content', 'hidden.json'),
  dataDir,
  dbFile: process.env.ARENA_DB_FILE ?? join(dataDir, 'arena.db'),
  judgeWorkDir: join(dataDir, 'judge'),
  webDist: join(repoRoot, 'web', 'dist'),
  junitJar: process.env.ARENA_JUNIT_JAR ?? '/opt/junit/junit-platform-console-standalone.jar',
  scalaJarDir: process.env.ARENA_SCALA_JARS ?? '/opt/scala',
  sparkJarsDir: process.env.ARENA_SPARK_JARS ?? '/opt/spark-jars',
  mysql: {
    socket: process.env.ARENA_MYSQL_SOCKET ?? '/var/run/mysqld/mysqld.sock',
    user: process.env.ARENA_MYSQL_USER ?? 'root',
  },
  redis: {
    url: process.env.ARENA_REDIS_URL ?? 'redis://127.0.0.1:6379',
  },
  /** 主观题评分 provider 链，按顺序尝试 */
  llm: {
    providers: (process.env.ARENA_LLM_PROVIDERS ?? 'qodercli,copilot,manual').split(',').map((s) => s.trim()),
    qoderBin: process.env.ARENA_QODER_BIN ?? 'qodercli',
    copilotBin: process.env.ARENA_COPILOT_BIN ?? 'copilot',
    timeoutMs: Number(process.env.ARENA_LLM_TIMEOUT_MS ?? 180_000),
    /** 容器内跑时指向宿主机上的 scripts/llm-bridge.mjs；空则 bridge 档直接判为不可用 */
    bridgeUrl: (process.env.ARENA_LLM_BRIDGE_URL ?? '').replace(/\/$/, ''),
    bridgeToken: process.env.ARENA_LLM_BRIDGE_TOKEN ?? '',
  },
  judge: {
    defaultTimeoutMs: 20_000,
    sparkTimeoutMs: 90_000,
  },
} as const;

