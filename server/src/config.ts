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

/**
 * IDE 的用户依赖环境目录。这个环境变量**读一次就从 process.env 摘掉**，因为判题子进程的环境
 * 是 `{ ...process.env, ...opts.env }`（`judge/process.ts`、`exec/spark-pool.ts` 两处）：
 * compose 必须把它设给服务进程（venv 建在 bind mount 上要 87s，见 compose.yml 那条注释），
 * 于是只要它留在 process.env 里，每一道题的运行都会看见 IDE 装了什么 ——
 * 而 `docker/BUILDINFO.md` 承诺的是"重建镜像即可复现"。
 * 摘在这里而不是在判题层过滤，是为了让判题层**根本不需要知道 IDE 有这套东西**（红线一）。
 * 闸门：`server/test/regression/ide-env-isolation.test.ts` 的 B（摘干净了）+ B2（这个动作本身有效）。
 */
const IDE_ENV_DIR_KEY = 'ARENA_IDE_ENV_DIR';

/** 导出只为让闸门能验"读完就摘"这个动作，不是给业务代码调用的第二入口。 */
export function consumeIdeEnvDir(): string {
  const raw = process.env[IDE_ENV_DIR_KEY];
  delete process.env[IDE_ENV_DIR_KEY];
  return raw && raw.trim() ? raw.trim() : join(dataDir, 'ide-env');
}

/**
 * Jupyter 的 token。**与上面 `ARENA_IDE_ENV_DIR` 同一套处理，且理由更强**（终审 I-2）：
 * compose 把它透传给 arena（`${ARENA_JUPYTER_TOKEN:-}`），而判题子进程的环境是
 * `{ ...process.env, ...opts.env }`（`judge/process.ts`）⇒ 只要它留在 process.env 里，
 * **每一道提交的代码都能读到一个能在容器里以 root 执行任意代码的服务的长期凭据**。
 * 能力上今天大致中性（被判的代码本来就在那张 netns 里裸跑 root，而桥 token 躺在那儿更久），
 * 但"判题层根本不需要知道"这条原则不该为它破例 —— 破一次例，下一个凭据就顺着同一条路进来。
 *
 * 记下来的 `tokenKeyPresent` 不是多余的字段：`missingTokenReason()` 判的是**键在不在**而不是值空不空
 * （"接上了但从没生成"与"按设计不给"修的是相反的东西，评审 T34 那句双重误导就是把它俩说成一句话造成的），
 * 而摘掉之后 process.env 里就再也没了这个键 —— 所以"Presence"这件事必须在读的那一刻记下来。
 * 容器档那条闸门（`server/test/notebooks/kernel.test.ts` 的 token 键用例）读的也是这个记录。
 * 闸门：`server/test/regression/ide-env-isolation.test.ts`（B 摘干净 + B2 摘这个动作有效 + 新的 D 那组）。
 */
const JUPYTER_TOKEN_KEY = 'ARENA_JUPYTER_TOKEN';

export interface ConsumedJupyterToken {
  token: string;
  tokenKeyPresent: boolean;
}

/** 导出只为让闸门能验"读完就摘 + 摘之前记下形状"这个动作，不是给业务代码调用的第二入口。 */
export function consumeJupyterToken(): ConsumedJupyterToken {
  const raw = process.env[JUPYTER_TOKEN_KEY];
  // **键在不在**要在删之前记下：`?? ''` 那种写法会把"没给"与"给了空串"读成同一件事
  const tokenKeyPresent = raw !== undefined;
  delete process.env[JUPYTER_TOKEN_KEY];
  return { token: raw ?? '', tokenKeyPresent };
}

const jupyterToken = consumeJupyterToken();

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
  ideEnvDir: consumeIdeEnvDir(),
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
  /**
   * Jupyter notebook（A1 档）。形状照 `mysql` / `redis`：一组同类配置缩在一个键下，
   * 而不是往顶层再撒四个 `notebookXxx`。
   *
   * - `token` **只从环境变量读、不给默认值**：唯一来源是 `.env`（`./start.sh` 首启生成，
   *   compose 只把它透传给 arena / tools，e2e 与 dev 故意拿不到 ⇒ 它们不会起重复的 server 写真人笔记）。
   *   这里若给个兜底默认值，容器与宿主就会各拿一份，症状是"打印出来的链接打不开"——
   *   与 WI-86 的桥 token 漂移同一类，而两边都是绿色的。
   * - `workDir` / `warehouseDir` 从 `dataDir` 派生（不是写死 `/app/data`）：这是 WI-40 的隔离纪律，
   *   entrypoint 那侧用的是同一个变量。写死会让"换一个数据目录"只换一半。
   * - `warehouseDir` 与 `judgeWorkDir`（`data/judge`）**必须是两棵树**：判题跑完会清空 data/judge，
   *   notebook 的 Spark warehouse / Derby 混进去就是互删，且没有任何报错。
   *   闸门：`server/test/regression/notebook-contract.test.ts`。
   */
  notebook: {
    port: Number(process.env.ARENA_JUPYTER_PORT ?? 8888),
    // 宿主机上的地址：compose 把 8888 发布到 127.0.0.1:7789，前端拿它拼链接
    publicUrl: process.env.ARENA_NOTEBOOK_PUBLIC_URL ?? 'http://127.0.0.1:7789',
    // ⚠ 这里是**唯一**允许读这份凭据的地方，而且读的是 `consumeJupyterToken()` 的返回值、
    // **不是 `process.env`**：那一行会先把键从 process.env 摘掉（见上面 I-2 那段），
    // 照着 `process.env.ARENA_JUPYTER_TOKEN` 写会永远读到空串 —— 症状不是报错，是
    // `notebookStatus()` 在每一步早退成 `running:false`（这一版就踩过：容器档 8 条路由用例一起红，
    // 而红的是"Jupyter 没在跑"，离毛病隔着一层）。
    token: jupyterToken.token,
    /**
     * "这个实例的环境里**有没有**这个键"—— 与"值空不空"是两件事，而且**只能在这个键还在的时候**记下来
     * （摘掉之后就再也问不出来了）。`missingTokenReason()` 判的是它，判据不能反过来读 process.env。
     */
    tokenKeyPresent: jupyterToken.tokenKeyPresent,
    workDir: join(dataDir, 'notebooks'),
    warehouseDir: join(dataDir, 'notebook-warehouse'),
    seedDir: join(repoRoot, 'content', 'notebooks'),
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

