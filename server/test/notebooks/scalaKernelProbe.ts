/**
 * WI-91（子项目 A2：镜像里的真 Scala kernel）三条候选路径**共用的探针执行器**。
 *
 * ## 它是什么、不是什么
 *
 * 这一档不是"实现一个功能"，是**限时探索**：Almond → Toree → 自包 `IMain`，三条都要用同一把尺子量，
 * 而尺子的本体是 `fixtures/99-probe-scala.ipynb` 那三个 code cell。本文件只做一件事 ——
 * 把那份夹具丢给**指定的一条 kernel** 真跑一遍，把三条判据的读数结构化返回。
 *
 * 它**刻意不是** `*.test.ts`：探索期一结束它就删掉或转正，不许在这里长成一条常驻闸门。
 * 但它在 `server/tsconfig.test.json` 的 include（`test` 目录下全部 `.ts`）覆盖面里 ⇒
 * `npm run verify:fast` 的 typecheck 照跑，
 * 而 `verify-coverage.test.ts`（只收 `*.test.ts`）不会要求它被某个阶段认领 —— 这是设计，不是漏接线。
 *
 * ## 夹具为什么在 `server/test/notebooks/fixtures/`，不在 `content/notebooks/`
 *
 * WI-90 落地的题闸门（`tutorials.test.ts` 那条「content/notebooks 里的每篇教程都必须在注册表里」）判的是
 * "`content/notebooks/` 里除 `00-smoke-pyspark.ipynb` 之外每一篇都必须注册过、且必须跑在 `arena-pyspark` 上"。
 * 一篇 Scala 夹具放进去 = 让一条真 Scala kernel 被当成 Python 教程判 ⇒ 宿主 45s 那一档就常驻红。
 * 而**不许**为它再加一个 `99-` 排除前缀：排除前缀正是那道闸门刚堵上的绕过口。
 *
 * ## 判据的两条硬规矩（写坏一条，整把尺子就变成装饰）
 *
 * 1. **`stateSurvived` 取的是 stdout 里出现 `alive=42` 这一行，不是"第二个 cell 没报错"。**
 *    报错与否取决于 kernel 怎么实现（吞成 warning？整段编译失败报成 `output_type=error`？三种实现三种红法），
 *    而 `alive=42` 只取决于**状态到底活没活** —— 那才是这一档唯一想判的东西。
 * 2. **两行 marker 都取"整行相等"而不是 `includes`。** 因为 cell 3 打的是 `rows=6`，而 `rows=60`
 *    也 `includes('rows=6')` —— 一个把 `range(60)` 或 id 之和打出来的 kernel 会替一条它没做到的事作证。
 *    提取器（`notebook-evidence.ts` 的 `executedNotebookEvidence`）已经把每行 `trim()` 过，所以整行相等
 *    既不受行尾换行影响，也不放宽到子串。
 *
 * ## "真跑的是哪条 kernel" 的证据在 `language_info`，**不在** `metadata.kernelspec.name`
 *
 * 实测（2026-10-10，容器 `daily-arena` / nbconvert 7.17.1）：`--ExecutePreprocessor.kernel_name=python3`
 * **确实**覆盖成功（三个 cell 报出来的是 Python 的 `SyntaxError`），但执行后 notebook 里
 * `metadata.kernelspec.name` **仍是夹具自己声明的 `scala`** —— nbclient 只改写 `metadata.language_info`
 * （那次回话里它是 `{name: "python", version: "3.10.12"}`）。所以：
 * - `tutorials.test.ts` 那条「`metadata.kernelspec.name === arena-pyspark`」的判据**不能搬到这里**：
 *   它读的是 notebook **声明**的那条，用覆盖参数跑时它永远读不到真跑的那条（会一直红，或一直绿得没意义）。
 *   这里改成判 `language_info.name`：它由**内核自己**在 `kernel_info` 回话里报上来，
 *   所以"覆盖被哪个版本忽略了"与"这条 kernel 挂着 Scala 的名字、内核其实是 IPython"（**造假 kernel**，
 *   本里程碑唯一不能放过的那一种）都会在这里红。判据只在**跑默认夹具时**生效（调用方自己指 notebookPath
 *   时语义已经换了，见 `probeScalaKernel` 里那段）。它只认"观察到 python 系语言"这一件事 ——
 *   不拿"必须等于 scala"去卡，因为 Almond / Toree / 自包 `IMain` 各自报什么字符串正是本探索要量的东西，
 *   不该由尺子替它们定。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executedNotebookEvidence, nbconvertCrashEvidence } from './notebook-evidence.js';

/** 探针夹具（判据本体）。从**本模块**的位置派生，不依赖 cwd：容器里这里是 `/app/server/test/notebooks/…`。 */
const FIXTURE_URL = new URL('./fixtures/99-probe-scala.ipynb', import.meta.url);

/** 跨 cell 状态的判据行（夹具 cell 2 的 `println(s"alive=$doubled")` 在状态活着时的唯一输出）。 */
const STATE_MARKER = 'alive=42';
/** 活 SparkSession 的判据行（`range(6).count()` = 行数 6；与 `00-smoke-pyspark.ipynb` 的 `rows 15` 刻意不同串）。 */
const SPARK_MARKER = 'rows=6';

/**
 * 整档预算（**毫秒**，给 `execFileSync` 的 `timeout`）。默认 240s：Scala kernel 冷启动 +
 * 第一次起 SparkSession（JVM + Spark 的 2.12.18 那套 jar）比 Python 侧更慢，而这里要给三条路径同一个数 ——
 * "这条路太慢所以被判死"与"预算给小了"必须能分开，所以预算是参数而不是散在三处的字面量。
 * cell 级超时按同一个数推导（秒），与 `tutorials.test.ts` 那对常量的推导方式同形。
 */
const DEFAULT_TIMEOUT_MS = 240_000;

/** 夹具当前的形状：1 个 markdown + 3 个 code。漂了说明夹具被动过，而三处判据的含义也跟着变了。 */
const EXPECTED_CELLS = 4;

/**
 * 夹具里必须还在的三段源码。判**源码字面量**而不是判运行结果的理由与 `tutorials.test.ts` 那条
 * 「marker 所在的那个 code cell 里必须有 assert」相同：**期望值不许由被测文件自己声明**，
 * 但判据的**来源**（`alive=42` / `rows=6` 这两个串）必须还能从夹具里读出来它是怎么打出来的 ——
 * 有人把 cell 2 改成 `println("alive=42")`（写死）时，`stateSurvived` 会变成一条永远绿的装饰，
 * 而这条快照判据会在这里红。
 */
const REQUIRED_SNIPPETS: ReadonlyArray<{ readonly snippet: string; readonly why: string }> = [
  { snippet: 'val doubled = 6 * 7', why: 'cell 1 必须是"算一次并绑到 val"，否则 cell 2 的 alive 就不是跨 cell 取的值' },
  { snippet: 'println(s"alive=$doubled")', why: 'cell 2 必须**引用 cell 1 的 val**；写死成 "alive=42" 这条判据就死了' },
  { snippet: 'rows=${spark.range(6).count()}', why: 'cell 3 必须打行数（6），不是 id 之和（15）—— 与 smoke 那篇区分开的就是这一串' },
  { snippet: 'spark.stop()', why: '最后一个 code cell 收尾，不给下一次探针留活 JVM' },
];

/** 一次探针的全部读数。字段含义写在这里，因为 Task 2/3/4 都只读这一份。 */
export interface ProbeResult {
  /** `stateSurvived && sparkSession && errors.length === 0`。三条一起成立才算"这条路径做到了"。 */
  ok: boolean;
  /** **请求的那条** kernel 名（= 传入参数）。注意它不是"实测跑的那条"：见文件顶部 `language_info` 那段。 */
  kernelName: string;
  /** 执行后 notebook 的 cell 总数；夹具当前是 4。0 表示压根没拿到可解析的 notebook。 */
  cells: number;
  /** notebook 里 `stream/stdout` 那些行（由 `executedNotebookEvidence()` 提取，已逐行 trim、去空行）。 */
  stdout: string[];
  /**
   * 两族条目，前缀分得很开：
   * - `cell <0 基下标>: <ename>` —— 某个 cell 抛了异常（`allow_errors=True` 保证这类是**数据**不是崩溃）；
   * - `probe: <…>` —— 判据自己的前提不成立：nbconvert 没跑起来 / 拿的是假读数（kernel 身份不符）。
   * 读的人要看的是前缀：红在第二族时**不要**去查 Scala，要查 kernel 注册与这条探针的接线。
   */
  errors: string[];
  /** stdout 里有**整行**等于 `alive=42` 的条目 ⇒ 跨 cell 状态活着。 */
  stateSurvived: boolean;
  /** stdout 里有**整行**等于 `rows=6` 的条目 ⇒ 起了一个活的 SparkSession 并且真数出 6 行。 */
  sparkSession: boolean;
  /** 这一趟 nbconvert 的墙钟（毫秒），含 kernel 冷启动。 */
  elapsedMs: number;
}

/** 把 notebook 源码取出来（`source` 按 nbformat 可以是串或按行数组）—— 只为上面的快照判据服务。 */
function codeCellSources(notebookPath: string): string[] {
  const nb = JSON.parse(readFileSync(notebookPath, 'utf8')) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
  return (nb.cells ?? [])
    .filter((c) => c.cell_type === 'code')
    .map((c) => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? '')));
}

/**
 * 夹具形状自检（只在跑默认夹具时判；调用方显式给了 `notebookPath` 时**不判** ——
 * 反面自测会把一份"故意不是夹具"的 notebook 指进来跑，那时候形状不符才是预期）。
 * 判不住的东西也一并列在这里：它只判**盘上的字节**，所以 kernel 坏没坏、Spark 起没起得来它一个字都不判；
 * 它买到的只是"红了之后能确定红的是 kernel，不是有人把夹具改了"。
 */
function fixtureShapeProblem(notebookPath: string): string | null {
  let sources: string[];
  let totalCells: number;
  try {
    const nb = JSON.parse(readFileSync(notebookPath, 'utf8')) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    totalCells = (nb.cells ?? []).length;
    sources = codeCellSources(notebookPath);
  } catch (err) {
    return `夹具解析不了：${err instanceof Error ? err.message : String(err)}`;
  }
  if (totalCells !== EXPECTED_CELLS) return `夹具现在有 ${totalCells} 个 cell（判据是按 ${EXPECTED_CELLS} 个 = 1 markdown + 3 code 写的）`;
  if (sources.length !== 3) return `夹具的 code cell 数是 ${sources.length}，不是 3`;
  const joined = sources.join('\n');
  for (const s of REQUIRED_SNIPPETS) if (!joined.includes(s.snippet)) return `夹具里读不到源码字面量「${s.snippet}」—— ${s.why}`;
  return null;
}


/**
 * nbconvert 的参数形状。与 `tutorials.test.ts` 的 `nbconvertArgv()` 同一套，只多一条 `kernel_name` 覆盖。
 * 为什么不 import 那份：它是**测试文件里的私有函数**，而本仓库明写"不许从测试文件 import 测试文件"
 * （一被 import 就带着别人的 `describe.skipIf` 与 `beforeAll(ensureIdeEnv)` 在探针这一档跑一遍）。
 * 两处**共用**的那两件工具（提取与崩溃措辞）住在 `./notebook-evidence.ts`，这里就是从那儿 import 的。
 *
 * `allow_errors=True` 是**必带**的那一条（同一课在 `kernel.test.ts` 与 `tutorials.test.ts` 各趟过一次）：
 * 不带它，cell 一报错 nbclient 就抛、nbconvert 退非 0 ⇒ 三条判据里最要的"哪个 cell 怎么坏的"那半
 * 一行都拿不到，反面自测（Step 4）要的"三个 cell 各自怎么样"的完整读数也就没有形状。
 */
function nbconvertArgv(kernelName: string, notebookPath: string, cellTimeoutS: number): string[] {
  return [
    'nbconvert',
    '--to',
    'notebook',
    '--execute',
    // 执行后的整本 notebook 落在这份 stdout 上；少了它，提取器读到的就是空串/别的文本。
    '--stdout',
    '--ExecutePreprocessor.allow_errors=True',
    `--ExecutePreprocessor.timeout=${cellTimeoutS}`,
    // 覆盖夹具声明的那条 kernelspec（实测：覆盖生效，但输出里的 metadata.kernelspec.name 不改写 —— 见文件顶部）。
    `--ExecutePreprocessor.kernel_name=${kernelName}`,
    notebookPath,
  ];
}

/**
 * 把一次读数压成**一段可以直接贴进报告**的文本。三条路径共用它，理由与 `notebook-evidence.ts` 那段一样：
 * 每个任务各自手写一份打印 = 三份会漂的真相，而漂掉的那一份不会报错，只会在下一次故障里给出比不判更差的报告。
 * ⚠ 它只打印 stdout 的前 20 行并附总行数（Spark 的 stdout 偶尔会带一大堆），断言不许压在这段文本上。
 */
export function formatProbeResult(r: ProbeResult): string {
  const head = `kernel=${r.kernelName} ok=${r.ok} cells=${r.cells} elapsed=${Math.round(r.elapsedMs / 1000)}s`;
  const verdict = `stateSurvived(${STATE_MARKER})=${r.stateSurvived} sparkSession(${SPARK_MARKER})=${r.sparkSession} errors=${r.errors.length}`;
  const errors = r.errors.length === 0 ? '' : `\nerrors:\n${r.errors.map((e) => `  - ${e.slice(0, 400)}`).join('\n')}`;
  const shown = r.stdout.slice(0, 20);
  const out = shown.length === 0 ? '' : `\nstdout(${r.stdout.length} 行，贴前 ${shown.length} 行):\n${shown.map((l) => `  | ${l}`).join('\n')}`;
  return `${head}\n${verdict}${errors}${out}`;
}

/**
 * 用**指定的一条 kernel** 真跑一遍探针夹具。
 *
 * 前置条件（本函数不检查，检查了就是替 compose/镜像撒谎）：`jupyter` CLI 与被评的 kernel 都得在**这台机器**上；
 * 今天这一条只在 `arena` 容器里成立（宿主既没有 jupyter 也没有 kernel），而 `server/**` 是烤进镜像的 ⇒
 * 改完本文件要 `docker compose up -d --build arena` 并核对容器里那份的 md5，否则跑的是旧字节。
 *
 * 不抛异常的两类（它们都是**数据点**，不是调用错误）：
 * - 某个 cell 抛异常 → `errors` 里落成 `cell N: <ename>`（`allow_errors=True` 保证 nbconvert 退 0）；
 * - nbconvert 整档跑不起来（kernel 没注册 / DeadKernelError / 到点）→ `errors` 里落成一条 `probe:` 开头的
 *   `nbconvertCrashEvidence()` 消息，`cells=0`、`stdout=[]`。探索期一定撞得到这一类，所以它不许是 throw。
 * 抛异常的一类：夹具不在 / 默认夹具形状与判据不符 —— 那是接线错误，报成"这条路径不行"是撒谎。
 */
export async function probeScalaKernel(kernelName: string, notebookPath?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  const startedAt = Date.now();
  const nbPath = notebookPath ? resolve(notebookPath) : fileURLToPath(FIXTURE_URL);
  const usingDefaultFixture = notebookPath === undefined;
  if (!existsSync(nbPath)) {
    throw new Error(`探针夹具不在：${nbPath} ⇒ content/** 是 bind mount、server/** 烤在镜像里，这一份走的是后者：先 docker compose up -d --build arena 再核 md5`);
  }
  if (usingDefaultFixture) {
    const problem = fixtureShapeProblem(nbPath);
    if (problem) throw new Error(`探针夹具的形状与判据不圆：${problem}。改的若是夹具，就要同时回来改这里两行 marker 的含义；改的若不是夹具，先查构建没把新字节烤进来`);
  }

  /** 整档预算（毫秒）与 cell 级预算（秒）取自同一个参数：两处各写一份就是"报错说的秒数与实际发的秒数不是同一个数"。 */
  const cellTimeoutS = Math.max(30, Math.floor(timeoutMs / 1000));
  let raw = '';
  let crash: string | null = null;
  try {
    raw = execFileSync('jupyter', nbconvertArgv(kernelName, nbPath, cellTimeoutS), { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // 直接把 `execFileSync` 抛出来的那个 error 递给公共件：`nbconvertCrashEvidence` 现在按**真形状**分支
    // （退出码读 `status`、node 错误名读字符串 `code`、`signal` 为 `null` 不算"被信号终止" —— 提交 584c249），
    // Task 1 这里那层 `evidenceShapedExecError` 字段映射因此变成冗余的，已删。
    // 留着它的代价不是行数而是**判据的归属**：它替公共件决定了"哪一种坏法说哪一句话"，
    // 而那句话的正确性由 kernel.test.ts 的「吃真 error 的四支判读」负责钉 —— 两边各决定一次，
    // 漂移的时候读报告的人分不清是哪一侧错了。
    crash = nbconvertCrashEvidence(err, { execTimeoutMs: timeoutMs, cellTimeoutS });
  }

  const errors: string[] = [];
  const stdout: string[] = [];
  let cells = 0;
  if (crash !== null) {
    // 崩溃时**不调**提取器：raw 是空串，喂进去只会得到一条"输出不是 notebook JSON"，
    // 而真正的原因是 kernel 起不来 / 到点 —— 那句会把人从根因赶去查 JSON 格式。
    errors.push(`probe: nbconvert 没有跑起来 ⇒ ${crash}`);
  } else {
    const evidence = executedNotebookEvidence(raw);
    stdout.push(...evidence.stdout);
    errors.push(...evidence.errors);
    // 两处结构读数（cell 总数、内核报上来的 language_info）。刻意不写成第三份"提取器"：
    // 它判的不是证据，是"这份输出到底是不是那本 notebook"这一层前提。
    try {
      const nb = JSON.parse(raw) as { cells?: unknown; metadata?: { language_info?: { name?: unknown } } };
      cells = Array.isArray(nb.cells) ? nb.cells.length : 0;
      const lang = nb.metadata?.language_info?.name;
      const observed = typeof lang === 'string' ? lang : null;
      // **只在跑默认夹具时判**（两条判据管的是同一件事：这份读数是不是**这把尺子**的读数）：
      // 调用方显式给 notebookPath 时（反面自测③会把一篇 Python 教程指进来）语义已经换了，
      // 拿"Scala 尺子"的身份判据去判它就是把工具用错门，而不是故障。
      if (usingDefaultFixture && observed && /^python/i.test(observed)) {
        errors.push(
          `probe: 请求的 kernel 是 ${kernelName}，而它在 kernel_info 回话里报自己的语言是 ${observed} ⇒ **这条 kernel 不是 Scala 的**` +
            '。两种形状，按顺序排：' +
            `①${kernelName} 本身是一条 Python kernel 换了个名字（本里程碑的"造假 kernel"就长这样：挂着 Scala 的名、` +
            '内核是 IPython，于是 Scala 语法永远跑不通而"kernel 已注册"这条检查是全绿的）；' +
            '②nbconvert 版本漂了、`--ExecutePreprocessor.kernel_name` 不再覆盖，整本静默跑在镜像自带的 python3 上' +
            '（实测 7.17.1 的覆盖是生效的，但生效时**不会**改写输出里的 metadata.kernelspec.name，所以这一条只能靠 language_info 判）。' +
            '先修身份这件事，再读 stateSurvived/sparkSession —— 此刻那两个 false 说的都是 python 的事实，不是那条 kernel 的',
        );
      }
    } catch {
      // 走到这里说明提取器已经给过一条"不是 notebook JSON"的 error（同一份 raw、同一个原因），不再重复。
    }
  }

  // 整行相等，不是子串：理由见文件顶部第 2 条（rows=6 与 rows=60）。
  const stateSurvived = stdout.some((line) => line === STATE_MARKER);
  const sparkSession = stdout.some((line) => line === SPARK_MARKER);

  return {
    ok: stateSurvived && sparkSession && errors.length === 0,
    kernelName,
    cells,
    stdout,
    errors,
    stateSurvived,
    sparkSession,
    elapsedMs: Date.now() - startedAt,
  };
}
