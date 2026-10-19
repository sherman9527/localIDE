import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';
import { formatProbeResult, probeScalaKernel } from './scalaKernelProbe.js';
import { executedNotebookScratchPath, nbconvertCrashEvidence, nbconvertExecuteToFileArgv, readExecutedNotebookFile, removeExecutedNotebookScratch, type ExecutedNotebook } from './notebook-evidence.js';

/**
 * WI-91b Task 4：一条 Scala smoke 进**容器档**闸门。
 *
 * ## 形状（T4-1 的裁决，写进提交信息，不默默选）
 *
 * 这条 smoke **不进** `tutorials.test.ts`。那道闸门有三条按 **Python 形状**写的判据
 * （`metadata.kernelspec.name === arena-pyspark`、最后一个 code cell 必须 `spark.stop()`、
 * marker 单元必须有语句级 `assert`），而探索档记的 Toree 缺陷 ④ 说 `spark.stop()` 在 Scala 侧会在
 * teardown 炸一个 shutdown hook —— 把 Scala 夹具塞进那三条里，得到的是一条**永远红**或**永远不判**的判据。
 * ⇒ 独立文件、独立容器档阶段（`verify.sh` 里「Scala kernel 真跑（WI-91b Task 4）」），
 * 复用 Task 1 改好的量具（`./notebook-evidence.ts` 的落盘读法），**不写第二个读取器**。
 *
 * ## 两层：常驻组（宿主也跑）+ 容器组（真跑 Toree）
 *
 * 分组的理由与 `tutorials.test.ts` 同一课：`server/test/notebooks/` 这个目录本来就被「单元测试」阶段扫，
 * 所以"只在阶段名里点这个文件"挡不住它在没有 Jupyter 的机器上跑（评审 T10-1）。
 * 常驻组判的是**接线事实**（门控合取、id 来自注册表、夹具在盘上且形状还是判据假设的那一副、
 * `verify.sh` 认领本文件的那两条阶段长什么样）—— 它在 `verify:fast`（约 2 分半，每次提交都跑）就有牙，
 * 不必等一次 10-20 分钟的容器验证。容器组才真起 Toree JVM。
 *
 * ## 容器组判的五条（简报三条 + T4-2 特意补的一条 + T4-5 ② 钉成判据的一条）
 *
 * ① `alive=42` 在 stdout（整行相等，不是子串）⇒ 跨 cell 状态活着；
 * ② `rows=6` 在 stdout ⇒ 真起了一个活的 SparkSession 并且数出 6 行（`rows=60` 不许过）；
 * ③ 负例夹具（摘掉定义那一格）必须报 `error` 且 `alive=42` **不许**出现；
 * ④ 负例那次报错的 `evalue` 必须是非空字符串 —— 这是 T4-2 补的，理由不是审美：
 *    Toree 缺陷 ② 是 `ename` 恒为 `Unknown Error`、`traceback` 恒为 `[]`，于是 `evalue` 是用户唯一
 *    **能行动**的文本。Task 5 要把"编译错误没有 traceback，有用的文本在 evalue 里"这句话放上页面，
 *    而一句没有闸门垫着的页面话正是本仓库被烧过的那种形状。
 *    ⚠ 这一条要读**原始 notebook**（`notebookEvidence()` 只往上抛 `ename`），所以它是一次**聚焦的**
 *    `readExecutedNotebookFile`，不是第二个提取器；提取器仍是唯一那份。
 * ⑤ 真跑过一次之后，夹具目录 / 仓库根 / 真人笔记目录里不许多出 `metastore_db` / `derby.log` /
 *    `spark-warehouse` —— 本轮实测的 kernel CWD 就是**夹具目录**，所以"今天没落"是当前装配的事实
 *    （catalog 是 in-memory、没开 `enableHiveSupport()`），不是保证。钉成判据的理由写在 `SPARK_SCRATCH_NAMES` 上方。
 *
 * ## 门控（T4-3）
 *
 * `describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)` —— 合取写在**文件里**，不只写在阶段名上。
 * ⚠ 这两个标识符的**大小写是承重的**：`verify-coverage.test.ts` 的 `gateVars()` 用
 * `\b([A-Z][A-Z0-9_]{2,})\b` 从 `skipIf(...)` 的条件回指 `const` 声明，再取 `process.env.X`。
 * 改成 camelCase ⇒ 那条 env 判据静默退出，阶段命令上的 `env` 前缀降级成装饰（`tutorials.test.ts` 同一课）。
 * 阶段那一侧还要配 `--reporter=json --outputFile=data/verify-scala-kernel.json` **加上**
 * `node scripts/assert-ran.mjs … --require-no-skips`：本文件的常驻组在容器里也绿，于是"容器组整片被跳掉"
 * 在报告里长得像"跑过了"（WI-90 Task 5 实测过：`10 passed / 4 skipped` 而 vitest 自己 exit 0）。
 * 容器档里这一档**没有"合法跳过"这个东西** ⇒ 判据是 0 skipped。
 *
 * ## kernel id 只有一份真相
 *
 * 容器组要的 kernel 名取自 `NOTEBOOK_KERNELS.scala.id`（Task 3 落地的注册表）。本文件的**源码里不许出现那条
 * id 的字面量** —— 常驻组那条判据就是钉这件事，钉法是"扫本文件的字节"（字面量本身由三段拼出来，
 * 否则这条判据自己就是它要找的东西）。
 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';

/** 容器组要的 kernel id —— **只**从注册表取（T4-3/T4-4 的"不许手写"就是判这一行）。 */
const SCALA_KERNEL_ID = NOTEBOOK_KERNELS.scala.id;

/**
 * 一次真跑的预算（**毫秒**，给 `execFileSync` 的 `timeout`）。与 `scalaKernelProbe.ts` 的默认值同数：
 * Scala kernel 冷启动 + 第一次起 SparkSession 比 Python 侧慢，而"这条路太慢所以被判死"与
 * "预算给小了"必须分得开 ⇒ 预算是一个常量，不是散在三处的字面量。
 * cell 级超时按同一个数推导（秒），与 `tutorials.test.ts` 那对常量的推导方式同形。
 */
const RUN_TIMEOUT_MS = 240_000;
/**
 * vitest 那一层的预算**必须大于** `execFileSync` 的预算（常驻组判这条不等式）。
 * 反过来的形状是真实的坑：`vitest.config.ts` 的 `testTimeout` 是 60s，照默认值写，一次**正常偏慢**的
 * 冷启动会先被 vitest 打死，报出来的是 `Test timed out in 60000ms` 而不是 `nbconvertCrashEvidence()`
 * 那句"先想超时"（那条函数存在的意义就是把超时说清）。
 */
const IT_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000;
/** cell 级超时（**秒**，nbclient 那层按秒算）；与探针里 `Math.max(30, …)` 那一式同形。 */
const CELL_TIMEOUT_S = Math.max(30, Math.floor(RUN_TIMEOUT_MS / 1000));

/** 「Scala kernel 真跑」那条阶段的标签与 assert-ran 的打印标签、以及那份 json 报告的相对路径（常驻组按这些回指 `verify.sh`）。 */
const RAN_REPORT = 'data/verify-scala-kernel.json';
const ASSERT_RAN_LABEL = 'Scala kernel';

/** 两份夹具（判据本体）的目录；从**本文件**的位置派生，不依赖 cwd：容器里这里是 `/app/server/test/notebooks/`。 */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * 容器组要跑的夹具与各自的期望。这张表**不是文档**：
 * - 负例那两行判据（③④）跑的 notebook 路径由它派生；
 * - 正例那一行由常驻那条判据钉住"它就是 `scalaKernelProbe.ts` 默认跑的那一份"（容器组的正例故意不传路径，
 *   好让探针自己那两条 `language_info` 身份判据生效 —— 那是本里程碑唯一不能放过"造假 kernel"的牙）；
 * - 常驻那条"表必须与盘上的夹具**双向相等**"于是堵住了两种坏法：**新写一份夹具忘了让它被跑**，
 *   以及**把负例那一行删掉**（删掉之后 `NEGATIVE_FIXTURE` 退成一个不存在的路径，容器组当场红，
 *   表与盘也当场不等 —— 见下面那条用例）。
 */
const RUN_PLAN: ReadonlyArray<{ readonly file: string; readonly kind: 'positive' | 'negative' }> = [
  { file: '99-probe-scala.ipynb', kind: 'positive' },
  { file: '99-probe-scala-no-def.ipynb', kind: 'negative' },
];

/** 表里 `negative` 那一行（负例判据的判据对象）。没有那一行 ⇒ 这里给一个**不存在**的路径，让容器组响亮地红。 */
const NEGATIVE_PLAN = RUN_PLAN.find((p) => p.kind === 'negative');
const NEGATIVE_FIXTURE = join(FIXTURE_DIR, NEGATIVE_PLAN?.file ?? '(RUN_PLAN 里没有 negative 那一行)');
/** 表里 `positive` 那一行的文件名（常驻那条拿它与探针默认夹具比；容器组走探针默认值，不走这里）。 */
const POSITIVE_PLAN = RUN_PLAN.find((p) => p.kind === 'positive');
const POSITIVE_FIXTURE_NAME = POSITIVE_PLAN?.file ?? '(RUN_PLAN 里没有 positive 那一行)';
/** 正例在盘上的完整路径（只给常驻那两条形状判据用 —— 容器组真跑时走探针的默认值）。 */
const DEFAULT_FIXTURE = join(FIXTURE_DIR, POSITIVE_FIXTURE_NAME);
/** `scalaKernelProbe.ts` 里那行 `new URL('./fixtures/<名字>.ipynb', …)` 的原文（判"表说的"与"探针真跑的"是同一份）。 */
const PROBE_SOURCE = readFileSync(join(FIXTURE_DIR, '..', 'scalaKernelProbe.ts'), 'utf8');

/** 本文件相对仓库根的路径（`verify.sh` 的阶段清单里写的就是它）。 */
const THIS_FILE_REL = fileURLToPath(import.meta.url).slice(config.repoRoot.length + 1).split(/[\\/]/).join('/');
/** 本文件的源码 —— 那条"不许手写 kernel id"的判据读的就是它。 */
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8');
/** `verify.sh` 的原文（认领判据读它；认领事实的**主**守卫在 `regression/verify-coverage.test.ts`，这里只收本文件自己的那张回执，见下面那条用例的注释）。 */
const VERIFY_SH = readFileSync(join(config.repoRoot, 'scripts', 'verify.sh'), 'utf8');

/**
 * 被扫的那条 id 字面量**拼出来而不写出来**：写出来本文件就含有了它要找的字节，那条判据会红在自己身上
 * （`verify-coverage.test.ts` 的 `manualGate()` 记过同一课 —— 散文里引用一串字面量不等于申报）。
 * 正对照在下面那条用例里：先证明"这一串确实就是要找的那一串"，再判"源码里没有它"。
 */
const ID_LITERAL = ['arena', 'scala', 'toree'].join('-');

/** notebook 的 cell（夹具是**未执行**的源码，这里只读 `cell_type` 与 `source`）。 */
interface FixtureCell {
  cellType: string;
  source: string;
}

/** 取盘上那份 notebook 的全部 cell（`source` 按 nbformat 可以是串或按行数组）。 */
function fixtureCells(path: string): FixtureCell[] {
  const nb = JSON.parse(readFileSync(path, 'utf8')) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
  return (nb.cells ?? []).map((c) => ({ cellType: c.cell_type ?? '(没有 cell_type)', source: Array.isArray(c.source) ? c.source.join('') : (c.source ?? '') }));
}

/**
 * 执行后的 notebook 里**每一条 `output_type === 'error'` 的原始条目**。
 * ⚠ 这不是第二个提取器：`notebookEvidence()` 仍是"stdout 行 + 出错 cell 条目"的唯一那份，它往上只抛
 * `cell N: <ename>`；`evalue`/`traceback` 这两个字段它按设计不收（traceback 正文可以任意长，进报告就等于没进）。
 * 本函数只为 T4-2 那一条补的判据服务（"有用的文本在 evalue 里"这句话要有牙），
 * 读的仍是 `readExecutedNotebookFile()` 出来的**同一个对象**，不二次 parse。
 */
function rawErrorOutputs(nb: ExecutedNotebook): Array<{ index: number; ename: unknown; evalue: unknown; traceback: unknown }> {
  const out: Array<{ index: number; ename: unknown; evalue: unknown; traceback: unknown }> = [];
  nb.cells.forEach((cell, i) => {
    const outputs = (cell as { outputs?: unknown })?.outputs;
    if (!Array.isArray(outputs)) return;
    for (const entry of outputs) {
      const o = entry as { output_type?: string; ename?: unknown; evalue?: unknown; traceback?: unknown };
      if (o.output_type !== 'error') continue;
      out.push({ index: i, ename: o.ename, evalue: o.evalue, traceback: o.traceback });
    }
  });
  return out;
}

/** 一次负例真跑的**实测记录**（报告要贴真读数，不是"应该长这样"；这一档一次只有一行，不是日志转储）。 */
function describeErrorOutputs(errors: Array<{ index: number; ename: unknown; evalue: unknown; traceback: unknown }>): string {
  return errors.map((e) => `cell ${e.index}: ename=${JSON.stringify(e.ename)} evalueLen=${typeof e.evalue === 'string' ? e.evalue.length : '非字符串'} traceback=${Array.isArray(e.traceback) ? `数组 ${e.traceback.length} 项` : JSON.stringify(e.traceback)}`).join('\n  ');
}

/**
 * Spark / Derby 那些"跟着 JVM 的 CWD 走"的落盘产物名（本轮 T4-5 ② 实测：Toree 那个 JVM 的 CWD 就是
 * **夹具所在的目录** `/app/server/test/notebooks/fixtures`，因为 nbclient 用 notebook 的目录当 kernel 的 cwd）。
 * 今天一次 `range(6).count()` 不物化任何表、catalog 是 in-memory（没开 `enableHiveSupport()`），
 * 所以那三样在三个根下**一个都不存在** —— 但这是**当前形状的事实**，不是保证：
 * 教程里一旦出现 `writeTo` / `enableHiveSupport`，`metastore_db` 与 `derby.log` 就会落进**源码树**
 * （容器里那一份随镜像走，dev 容器把源码 bind 进去 ⇒ 直接落进工作树），而 `content/**` 是真人挂载。
 * ⇒ 这条判据把"今天没落"钉成"不许落"，红了会说清是该给 kernel 设 `derby.system.home`
 *   （`arena-pyspark` 那份 kernel.json 就是这么写的）还是该把 cell 改掉，不是靠人记得回去看。
 */
const SPARK_SCRATCH_NAMES = ['metastore_db', 'derby.log', 'spark-warehouse'];

/** 三个根（夹具目录 = 实测的 kernel CWD、仓库根、真人笔记的 seedDir）里那些名字的命中。 */
function sparkScratchEntries(): string[] {
  const roots = [FIXTURE_DIR, config.repoRoot, config.notebook.seedDir];
  const found: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (SPARK_SCRATCH_NAMES.includes(entry)) found.push(`${root}/${entry}`);
    }
  }
  return found;
}

/** 盘上那份 notebook 声明的 `metadata.kernelspec.name`（seedDir 那条判据读它；读不到给 null，不给空串）。 */
function declaredKernel(file: string): string | null {
  try {
    const nb = JSON.parse(readFileSync(join(config.notebook.seedDir, file), 'utf8')) as { metadata?: { kernelspec?: { name?: unknown } } };
    const name = nb.metadata?.kernelspec?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

// ──────────────── verify.sh 认领事实的**窄**解析器（只收本文件那张回执） ────────────────

/** 取值单独占一个 token 的带值选项（与 `verify-coverage.test.ts` 的 `VALUE_OPTS` 同族，这里只需要这几条）。 */
const STAGE_VALUE_OPTS = new Set(['--exclude', '--reporter', '--outputfile', '--output-file']);

interface VitestStage {
  label: string;
  /** `run "…"` 后面的整条命令文本（用来判 env 前缀与那两个 reporter 参数是否在**命令行上**）。 */
  command: string;
  /** 位置参数（= 这条阶段真的会跑的路径）。 */
  patterns: string[];
  /** `--exclude` 的取值（= 这条阶段明确不跑的路径）。 */
  excludes: string[];
  /** 命令行上 `NAME=value` 形式的变量名。 */
  vars: string[];
}

/**
 * 把 `verify.sh` 里的 vitest 阶段拆成"跑哪些路径 / 排除哪些 / 设了哪些变量"。
 * ⚠ **主守卫是 `server/test/regression/verify-coverage.test.ts`**（孤儿文件、`--exclude` 要有别人接、
 * env 门控必须被"设了那个变量"的阶段认领 —— 它判所有文件）。这里重复一份窄解析不是为了取代它，
 * 而是因为 `verify-coverage` **不看** `--require-no-skips`：全仓 grep 过，那个开关今天只有
 * `assert-ran.mjs` 自己与被测阶段命令行认识它 ⇒ "摘掉 `--require-no-skips`" 这一串在所有既有守卫里
 * 一个都不红（Task 4 破坏性验证 ② 的实测就是它）。所以本文件自己收一张回执，红话由这里说。
 */
function vitestStages(script: string): VitestStage[] {
  const out: VitestStage[] = [];
  for (const line of script.split(/\r?\n/)) {
    const m = /^run\s+"([^"]*)"\s+(.*)$/.exec(line.trim());
    const label = m?.[1];
    const command = m?.[2];
    if (!label || !command) continue;
    const vitest = /npx vitest run (.+)$/.exec(command);
    if (!vitest?.[1]) continue;
    const patterns: string[] = [];
    const excludes: string[] = [];
    const tokens = vitest[1].trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]!;
      if (!tok.startsWith('-')) {
        patterns.push(tok.replace(/^\.\//, '').replaceAll('\\', '/'));
        continue;
      }
      const name = tok.split('=')[0]!.toLowerCase();
      if (STAGE_VALUE_OPTS.has(name) && !tok.includes('=')) i += 1; // 带值选项的**取值**不是路径参数
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === '--exclude') {
        excludes.push((tokens[i + 1] ?? '').replace(/^\.\//, '').replaceAll('\\', '/'));
        i += 1;
      }
    }
    out.push({ label, command, patterns, excludes, vars: [...command.matchAll(/\b([A-Z][A-Z0-9_]{2,})=[^\s]+/g)].map((v) => v[1]!) });
  }
  return out;
}

/** `run "…" … node scripts/assert-ran.mjs …` 那些命令行原文。 */
function assertRanCommands(script: string): string[] {
  return script.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^run\s+"[^"]*"\s+.*scripts\/assert-ran\.mjs\s/.test(l));
}

// ──────────────────── 容器组：真起一条 Toree JVM ────────────────────

describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)('Scala kernel 在容器里真跑（WI-91b Task 4）', () => {
  /**
   * ①② 跨 cell 状态 + 活 SparkSession。
   * `ok` 是三条一起成立（`stateSurvived && sparkSession && errors.length === 0`）的**总结**，
   * 但判据一条条分开写：合在一起判的话，红了只剩一句"不行"，而这一档最贵的信息是**哪一半**不行
   * （状态没活 = kernel 是分段编译器；rows 不对 = Spark 装配/classpath 没挂上；有 error = cell 抛了）。
   * ⚠ "真跑的是哪条 kernel"的证据在 `language_info`（探针内部判它），**不在** `metadata.kernelspec.name`：
   * 实测 nbconvert 的 `--ExecutePreprocessor.kernel_name` 覆盖不改写声明名。这里不重抄那条判据。
   */
  it('默认夹具：alive=42 与 rows=6 都在（整行相等），且零 error', async () => {
    const scratchBefore = sparkScratchEntries();
    const r = await probeScalaKernel(SCALA_KERNEL_ID);
    console.log(`[scala-kernel] 默认夹具读数：\n${formatProbeResult(r)}`);
    expect(r.stateSurvived, `stdout 里没有**整行等于** alive=42 的条目 ⇒ 跨 cell 状态没活过来（"编译一段跑一段"那种分段编译器就长这样）。读数：\n${formatProbeResult(r)}`).toBe(true);
    expect(r.sparkSession, `stdout 里没有**整行等于** rows=6 的条目 ⇒ 没有真起一个活的 SparkSession 并数出 6 行（rows=60 不算，那条把 range 的 id 之和与行数混掉的坏法就是这么放过去的）。读数：\n${formatProbeResult(r)}`).toBe(true);
    expect(r.errors, `有 cell 抛异常/前提不成立（cell N: … 是数据，probe: … 是这一档的接线坏了 —— 后者不要去处查 Scala）：\n${formatProbeResult(r)}`).toEqual([]);
    // 结构读数：落盘那份**整本** notebook 的 cell 数。它判的是"这次真跑的就是这把尺子"，不是探针的 ok 公式
    // （`ok` 由上面三条决定，再判它一次是一条永远不会红的装饰 —— 本仓库管那种形状叫"装饰性判据"）。
    expect(r.cells, `执行后的 notebook 读出 ${r.cells} 个 cell，不是 4 ⇒ 要么夹具变了，要么落盘/读法只拿到半本 —— 上面那两条 marker 的含义跟着漂。读数：\n${formatProbeResult(r)}`).toBe(4);
    // ⑤ 落点（T4-5 ② 钉成的判据）：真起过一次 SparkSession 之后，源码树/夹具目录/真人笔记目录里不许多出
    // Spark 的那三样产物。跑之前先记一份、跑之后比一份 —— 比"只查事后"多一层：它把"本来就有"与"这次长出来的"分开。
    const scratchAfter = sparkScratchEntries();
    expect(scratchAfter, `Scala kernel 真跑过一次之后，这几个根里出现了 Spark/Derby 的落盘产物：${JSON.stringify(scratchAfter)}（跑之前是 ${JSON.stringify(scratchBefore)}）` + ' ⇒ 实测的 kernel CWD 就是夹具目录，所以 metastore_db / derby.log 会落在**源码树**里（dev 容器还把源码 bind 出去 = 直接落进工作树）。' + '改的是那条 kernel 的装配（照 arena-pyspark 那份 kernel.json 的写法给 `-Dderby.system.home=` 指到 data 下，并把 warehouse 指到 config.notebook.warehouseDir），**不是**把这三个名字从名单里划掉').toEqual(scratchBefore);
  }, IT_TIMEOUT_MS);

  /**
   * ③ 负例：摘掉定义那一格之后，`doubled` 在它自己的历史里从没被绑定过。
   * 主夹具的绿 + 这一份的红，两条一起才叫"跨 cell 状态活着，而且不是整本一次性编译"
   * （单看这一份的红什么都证明不了 —— 一条连 Scala 都不认的 kernel 也红）。
   * ⚠ `errors` 里要的是 `cell N: …` 那一族。`probe: …` 那一族说的是**判据的前提**不成立
   * （nbconvert 没跑起来 / 落盘结果读不出 / scratch 没删净），那种红去处查接线，不是查 Scala。
   */
  it('负例夹具（摘掉定义那一格）：必须报 error，且 alive=42 不许出现', async () => {
    const r = await probeScalaKernel(SCALA_KERNEL_ID, NEGATIVE_FIXTURE);
    console.log(`[scala-kernel] 负例夹具读数：\n${formatProbeResult(r)}`);
    expect(r.errors.length, `负例一条 error 都没有 ⇒ 要么 kernel 把"未定义符号"吞成了 warning/正常输出，要么它压根没在执行这份夹具。读数：\n${formatProbeResult(r)}`).toBeGreaterThan(0);
    expect(r.errors.filter((e) => e.startsWith('probe: ')), `这一档的**前提**不成立（下面这些是接线故障，不是 Scala 的结果；先查 kernel 注册与落盘读法，再谈这份负例）。读数：\n${formatProbeResult(r)}`).toEqual([]);
    expect(r.stateSurvived, `负例里居然打出了 alive=42 ⇒ 这份 notebook 的历史里从没绑定过 doubled，能做到这件事的只有"整本一次性编译再按 cell 切输出"的假 kernel（本里程碑唯一不能放过的那一种）。读数：\n${formatProbeResult(r)}`).toBe(false);
  }, IT_TIMEOUT_MS);

  /**
   * ④ T4-2 补的那一条：负例那次报错必须带**可用的 `evalue` 文本**。
   * 一次聚焦的落盘读法（探针不暴露原始 notebook，而 `evalue` 只在原始 notebook 里），
   * 参数、选址、收尾删除全部走 `./notebook-evidence.ts` 的同一套公共件 —— 不写第二个读取器。
   * ⚠ 这一条**故意不判**"traceback 必须是空数组"：那是 Toree 缺陷 ② 的现状，不是本仓库要的不变量
   *    —— 哪天上游把 traceback 补上了，页面那句话要跟着改，但"evalue 里有可用文本"仍然成立。
   *    现状的读数（`ename` / `evalue` 长度 / traceback 项数）由下面那行 `console.log` 记进验证日志，
   *    是**证据**而不是判据。
   */
  it('负例的 error 必须带非空 evalue（页面那句"有用的文本在 evalue 里"不许是空话）', () => {
    const executedPath = executedNotebookScratchPath('wi91b-task4-evalue');
    let nb: ExecutedNotebook | null = null;
    let crash: string | null = null;
    /** "删净与否"取自 `removeExecutedNotebookScratch` 的返回值（不许丢弃返回值再 `existsSync` 二次推导 —— 同一事实两个出处）。 */
    let scratchLeft: boolean;
    try {
      try {
        execFileSync('jupyter', nbconvertExecuteToFileArgv(NEGATIVE_FIXTURE, executedPath, CELL_TIMEOUT_S, SCALA_KERNEL_ID), { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
      } catch (err) {
        crash = nbconvertCrashEvidence(err, { execTimeoutMs: RUN_TIMEOUT_MS, cellTimeoutS: CELL_TIMEOUT_S });
      }
      if (crash === null) nb = readExecutedNotebookFile(executedPath);
    } finally {
      scratchLeft = !removeExecutedNotebookScratch(executedPath);
    }
    // 断言在 try/finally **之外**（形状照 embed.test.ts 的收尾删除判据）：finally 里的断言会盖掉 try 里真正的坏点。
    if (crash !== null) throw new Error(`nbconvert 没跑起来 ⇒ evalue 这一条判据没有对象。${crash}`);
    if (nb === null) throw new Error('nbconvert 退了 0 但落盘的执行结果读不出来 ⇒ evalue 这一条没有对象（那一层的接线话由 readExecutedNotebookFile 自己说，这里不替它编）。');
    expect(scratchLeft, `scratch 没删净：${executedPath} 还留在实例的数据目录里（WI-40 隔离纪律）。先去查它为什么删不掉（权限/句柄），别把它读成"这条 kernel 不行"`).toBe(false);

    const errors = rawErrorOutputs(nb);
    expect(errors.length, '负例这份执行后的 notebook 里没有 `output_type === "error"` 的条目 ⇒ 这一条判据没有对象。上面那条负例用例判的是"必须有 error"，两条都红说的是同一件事').toBeGreaterThan(0);
    console.log(`[scala-kernel] 负例 evalue 实测（证据，不是判据）：\n  ${describeErrorOutputs(errors)}`);
    for (const e of errors) {
      expect(typeof e.evalue, `cell ${e.index} 的 evalue 不是字符串（实际类型 ${typeof e.evalue}，值 ${JSON.stringify(e.evalue)?.slice(0, 120)}）⇒ 页面那句"有用的文本在 evalue 里"在这里是假话，Task 5 的文案要改，不是把这条判据删掉`).toBe('string');
      expect((e.evalue as string).trim() !== '', `cell ${e.index} 的 evalue 是空串/全空白 ⇒ 用户拿到的是"Unknown Error + 空 evalue + 空 traceback"三件套，那一句页面文案就是空话。修的是 kernel 的报错通路（或改文案），不是删这条判据`).toBe(true);
    }
  }, IT_TIMEOUT_MS);
});

// ──────────────────── 常驻组：宿主档也要跑的那一组 ────────────────────

/**
 * 这一组**不需要 Jupyter、不需要 Toree**：判的是盘上的字节、注册表里的数据、以及 `verify.sh` 的认领形状。
 * ⇒ 同一句判据在 `verify:fast` 就有牙、每次提交都跑。"新加一条闸门忘了接门禁"这种坏法最贵的地方是**发现得晚**。
 */
describe('Scala kernel 闸门的常驻判据（宿主也跑）', () => {
  /**
   * 门控合取本身（形状照 `tutorials.test.ts` / `kernel.test.ts`）。
   * ⚠ 这一条**永远会跑**：它存在的理由是"上面那一整组安静地什么都不判"这件事要有人说话
   * （`.qoder/rules/dev_verify_workflow.md` 第 3 条：跳过要用 `skipIf`，并且另起一条永远会跑的断言解释为什么会是 skip）。
   */
  it('门控的两半各自能红：设了服务身份却没设容器身份 ⇒ 容器那一组会安静地整片 skip', () => {
    expect(
      !NOTEBOOK_SERVICE || IN_CONTAINER,
      '设了 ARENA_NOTEBOOK_SERVICE=1 却没设 ARENA_IN_CONTAINER ⇒ 上面那一整组会在**本该跑它的地方**静默跳过' + '（compose 那一行的漂移由 notebook-compose.test.ts ⑦ 先红；这里判的是"这一档的进程环境里两半齐不齐"）',
    ).toBe(true);
    // 两条门控变量名**写在文件里**、由阶段命令行显式设一遍 —— 这是 T4-3 的形状，不是可选的便利。
    expect(
      VERIFY_SH,
      `verify.sh 里没有任何一条阶段在本文件的门控里设过 ARENA_IN_CONTAINER/ARENA_NOTEBOOK_SERVICE ⇒ 容器组永远不会跑（主守卫是 verify-coverage 那条 env 判据，这里要的是本文件自己那张回执）`,
    ).toMatch(/ARENA_IN_CONTAINER=1[^\n]*ARENA_NOTEBOOK_SERVICE=1[^\n]*scala-kernel\.test\.ts/);
  });

  /**
   * kernel id 只有一份真相（Task 3 落地的注册表）。两种坏法各堵一种：
   * ① 有人在测试里手抄那条 id ⇒ 注册表改了而测试不改，闸门继续判那条**已经不存在**的 kernel 并绿着；
   * ② 容器组忘了读注册表、把 id 传成 `undefined`/空串 ⇒ nbconvert 会退回 notebook 自己声明的那条
   *   （夹具声明的是占位名 `scala`），于是"跑的是哪条 kernel"这件事静默换掉了。
   */
  it('kernel id 来自注册表：本文件的源码里不许出现那条 id 的字面量，而调用点必须真的读 NOTEBOOK_KERNELS', () => {
    // 正对照：先证明"这一串就是那条 id"，否则下面那条 not.toContain 会因为拼错串而永远绿（空判）。
    expect(ID_LITERAL, '拼出来的那串与注册表里的 scala id 不是同一个串 ⇒ 上面那条"不许出现字面量"的判据现在是在扫一个不存在的东西（空判）').toBe(SCALA_KERNEL_ID);
    expect(OWN_SOURCE, '本文件的源码里出现了 kernel id 的字面量 ⇒ 注册表一改这里不会红，闸门就判起了过去那条 kernel。修法是回到 NOTEBOOK_KERNELS.scala.id').not.toContain(ID_LITERAL);
    expect(OWN_SOURCE, '容器组那几处调用没有真的从注册表取 id ⇒ nbconvert 会静默退回夹具声明的那条占位 kernel（"跑的是哪条"这件事换了对象而读数照样绿）').toContain('NOTEBOOK_KERNELS.scala.id');
    // needsVenv:false 是这条 kernel 不依赖 IDE venv 的**唯一**结构化表达 ⇒ 本档不许长出一条"请先按页面准备环境"的前置用例。
    expect(NOTEBOOK_KERNELS.scala.needsVenv, '注册表里 scala 那条现在要 venv 了 ⇒ 上面那一整组的前置条件要跟着改（并且要先想清楚是不是真的改了解释器位置），不能让它继续"看起来跑得通"').toBe(false);
    // 两条 arena kernel 的 id 不许撞车（撞了则 allow-list 与"跑的是哪条 kernel"那两条判据一起失去意义）。
    // 判**整张表**而不是判这两条的相等：写成 `scala.id === pyspark.id` 会被 TS 判成"字面量类型永不相等"
    // （TS2367，`as const` 之后那两个串类型没有重叠），而第三条 kernel 一登记，那种两条各写一次的判据就又成了第三处真相。
    const ids: string[] = Object.values(NOTEBOOK_KERNELS).map((k) => k.id);
    expect(new Set(ids).size, `注册表里有重复的 kernel id：${JSON.stringify(ids)} ⇒ "跑的是哪条 kernel"这类判据分不开对象，status.ts 的 allow-list 也会少一条`).toBe(ids.length);
  });

  /**
   * 夹具清单的**双向相等**（形状照 `tutorials.test.ts` 那条"注册表与目录双向相等"，理由也是同一句）：
   * 少一行 = 盘上有一份夹具从此没有任何用例跑它（"闸门跑过了"是假的）；多一行 = 表在替一份不存在的夹具作证。
   * ⚠ 这张表必须**被读**才不是装饰：负例那两条判据的路径由它派生（删掉 negative 那一行 ⇒ 那两条当场红在"夹具不在"），
   * 正例那一行由下面那条与探针的默认值比（容器组的正例不传路径，好让探针那两条 `language_info` 身份判据生效）。
   * ⚠ **射程要说清楚**：它拦得住"把表里那一行删掉"与"把夹具文件删掉/改名"，拦不住"只删 `it()` 而留着表里那一行"
   * —— 后者是"判据观察自己的删除"这一类，任何按表判的闸门都做不到（`tutorials.test.ts` 的注册表同局限）。
   * 那条路今天由 review 与"某几个文件的断言条数只增不减"这两条外部约束堵着，别以为这里有牙。
   */
  it('RUN_PLAN 必须与盘上的 99-probe-scala* 夹具双向相等，且 positive 那一行就是探针默认跑的那一份', () => {
    const onDisk = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('99-probe-scala') && f.endsWith('.ipynb')).sort() : [];
    const planned = RUN_PLAN.map((p) => p.file).sort();
    expect(planned, `表里是 ${JSON.stringify(planned)}，盘上是 ${JSON.stringify(onDisk)} ⇒ 两种坏法：①**新写一份夹具没加进表**（它从此没人跑，而页面/probe 那边看着像"Scala 的判据都过了"）；` + '②**把某一行从表里删掉**（那份夹具还在盘上、还在被 git 跟踪，只是没有判据了 —— 删判据最便宜的写法就是删一行）。修法是把它加回表**并**写上对应的期望，不是把盘上那份删掉').toEqual(onDisk);
    expect(RUN_PLAN.filter((p) => p.kind === 'positive').length, 'positive 那一行必须恰好一条（两条正例 = 两条期望互相覆盖，一条红会被另一条的解释掩盖）').toBe(1);
    expect(RUN_PLAN.filter((p) => p.kind === 'negative').length, 'negative 那一行必须恰好一条：主夹具的绿 + 负例的红**两条一起**才叫"跨 cell 状态活着，而且不是整本一次性编译"').toBe(1);
    // 表说的正例 ≠ 探针真跑的那一份 ⇒ 上面那些"正例三条判据"判的其实是另一本 notebook。
    const probeDefault = /new URL\('\.\/fixtures\/([^']+)\.ipynb', import\.meta\.url\)/.exec(PROBE_SOURCE)?.[1];
    expect(probeDefault, '读不出 `scalaKernelProbe.ts` 里那行默认夹具 URL ⇒ 这条判据没有对象（探针那一行改名了？去看它是不是换了判据对象）').toBeTruthy();
    expect(`${probeDefault}.ipynb`, `探针默认跑的是 ${probeDefault}.ipynb，而表里的 positive 那一行写的是 ${POSITIVE_FIXTURE_NAME} ⇒ 容器组那条正例判据（它不传路径，走探针默认值）与这张表已经不是同一份 notebook 了` + '（不传路径是刻意的：只有默认夹具那一次会判 `language_info` 的 kernel 身份，那是本里程碑不能放过"造假 kernel"的牙）。改的是一次对齐一次，两处不许各写一份',).toBe(POSITIVE_FIXTURE_NAME);
  });

  /** 默认夹具的形状（判据假设的那一副还在不在）。漂了的代价不是难看，是 marker 的含义跟着变。 */
  it('默认夹具还在，且形状还是三条判据假设的那一副（1 markdown + 3 code）', () => {
    expect(existsSync(DEFAULT_FIXTURE), `默认夹具不在 ${DEFAULT_FIXTURE} ⇒ 探针会 throw（那是接线错误，不是"这条 kernel 不行"）。server/** 烤在镜像里：改完要重建容器并核 md5`).toBe(true);
    const cells = fixtureCells(DEFAULT_FIXTURE);
    expect(cells.length, '默认夹具现在不是 4 个 cell ⇒ 三条判据的**下标含义**跟着漂（探针里 EXPECTED_CELLS 也是 4，两处红说的是同一件事）').toBe(4);
    expect(cells[0]!.cellType, '默认夹具的第一个 cell 必须是 markdown（它是那张"三个 code cell 各判什么"的表）').toBe('markdown');
    const code = cells.filter((c) => c.cellType === 'code');
    expect(code.length, '默认夹具的 code cell 数不是 3 ⇒ alive/rows/spark.stop 这三条判据各对应哪一格已经说不清了').toBe(3);
    const aliveCell = code.find((c) => c.source.includes('alive='));
    expect(aliveCell, '没有哪个 code cell 打 alive ⇒ 判据 ① 失去了对象').toBeTruthy();
    expect(aliveCell!.source.includes('doubled'), '打 alive 的那一格没有引用 doubled ⇒ 它是写死的 "alive=42"，判据 ① 从此永远绿（一条装饰）').toBe(true);
    expect(aliveCell!.source.includes('42'), '打 alive 的那一格里出现了字面量 42 ⇒ 同上：那个 42 可能是写死的，不是从上一格的 val 取来的').toBe(false);
    const rowsCell = code.find((c) => c.source.includes('rows='));
    expect(rowsCell, '没有哪个 code cell 打 rows ⇒ 判据 ② 失去了对象').toBeTruthy();
    expect(rowsCell!.source.includes('count()'), '打 rows 的那一格不是在数行数（count()）⇒ rows=6 与"id 之和"这类读数分不开，判据 ② 的含义变了').toBe(true);
    expect(code[code.length - 1]!.source.includes('spark.stop()'), '最后一个 code cell 没有 spark.stop() ⇒ 容器档会留下一个活着的 Spark JVM 给隔壁那些档位背内存账（tutorials.test.ts 那条同形判据的理由）').toBe(true);
  });

  /**
   * 负例夹具的关键性质：**全本没有任何地方绑定过 `doubled`**，而引用它的那一格确实存在、
   * 并且就住在 `nb.cells` 的 0 基下标 1 上。判下标不是为了好看：这份文件是**反面**判据的载体
   * （"摘掉定义那一格"是它相对主夹具唯一的差异），有人再插一格进去，它就变成了另一份 notebook，
   * 而容器组那条"负例必须报 error"的含义会跟着换对象 —— 那种坏法在容器里可能照样红、照样绿，只有这里说得清。
   */
  it('负例夹具还在，且它确实"引用 doubled 而全本没定义过"（一次性编译的假 kernel 没有退路）', () => {
    expect(existsSync(NEGATIVE_FIXTURE), `负例夹具不在 ${NEGATIVE_FIXTURE} ⇒ 判据 ③④ 没有对象`).toBe(true);
    const cells = fixtureCells(NEGATIVE_FIXTURE);
    expect(cells.length, '负例夹具现在不是 3 个 cell（1 markdown + 2 code）⇒ 它是从默认夹具摘掉**定义那一格**得来的，格数变了就要回来看这两条判据的下标').toBe(3);
    const code = cells.filter((c) => c.cellType === 'code');
    expect(code.length, '负例夹具的 code cell 数不是 2').toBe(2);
    expect(cells.some((c) => c.source.includes('val doubled')), '负例夹具里出现了 `val doubled` ⇒ 它不再是负例：主夹具与它给出同样的读数，"不是整本一次性编译"这句话就没有对照了').toBe(false);
    const refIndex = cells.findIndex((c) => c.cellType === 'code' && c.source.includes('doubled'));
    expect(refIndex, '负例夹具里没有引用 doubled 的 code cell ⇒ 这份文件与主夹具的差异已经不是"摘掉定义"').toBeGreaterThan(-1);
    expect(refIndex, '引用 doubled 的那个 code cell 不在 0 基下标 1 ⇒ 容器组那条"第一条 error 落在 cell 1"的含义变了，跟着这里一起改').toBe(1);
    expect(cells[refIndex]!.source.includes('alive='), '引用 doubled 的那一格不打 alive ⇒ 判据 ③（alive=42 不许出现）在这份夹具上没有对象').toBe(true);
  });

  /**
   * 计划 R1 记的那笔账（Task 4 的 brief 原本写的是"或把探索夹具转正成 `content/notebooks/04-scala-smoke.ipynb`"）：
   * 那条路会让 `tutorials.test.ts` 的注册表双向闭集红，而**不许**为它再加一个排除前缀
   * （排除前缀正是那道闸门刚堵上的绕过口）。⇒ Scala 那份永远住在 `server/test/notebooks/fixtures/`。
   */
  it('Scala 夹具不许搬进 seedDir（那里每一篇都必须声明跑在 arena-pyspark 上）', () => {
    const seeded = existsSync(config.notebook.seedDir) ? readdirSync(config.notebook.seedDir).filter((f) => f.endsWith('.ipynb')) : [];
    const wrong = seeded.filter((f) => declaredKernel(f) !== NOTEBOOK_KERNELS.pyspark.id);
    expect(
      wrong,
      `${config.notebook.seedDir} 里这些 notebook 声明的 kernelspec.name 不是 ${NOTEBOOK_KERNELS.pyspark.id}：${wrong.map((f) => `${f}=${JSON.stringify(declaredKernel(f))}`).join(' , ')} ⇒ 两种坏法之一：` +
        '①有人把 Scala 的 smoke 放进了 seedDir —— `tutorials.test.ts` 那条注册表双向闭集会红，而它另外三条按 Python 形状的判据' +
        '（末格 `spark.stop()`、marker 单元必须有 `assert`）对 Toree 根本不成立（Toree 缺陷 ④：Scala 侧 spark.stop() 会在收尾炸 shutdown hook），' +
        `排除前缀又不许加（那正是那道闸门刚堵上的绕过口）⇒ Scala 的夹具请放回 ${FIXTURE_DIR}，由本文件的容器组判；\n` +
        '②某篇教程的 kernelspec.name 被改坏了 —— 那种写法会让它跑在镜像自带的系统解释器上（红线①），tutorials 的容器组也会在这里红。',
    ).toEqual([]);
  });

  /** 预算的两层关系（形状照 `tutorials.test.ts` 那条参数形状判据）。 */
  it('本档的预算：vitest 那一层大于 execFileSync 那一层，cell 级超时由毫秒预算按秒推导且落在合理区间', () => {
    expect(IT_TIMEOUT_MS, `vitest 的预算（${IT_TIMEOUT_MS}）必须大于 execFileSync 的（${RUN_TIMEOUT_MS}），否则先打死的是 vitest，报出来的是 "Test timed out"（说不到那句"先想超时"）`).toBeGreaterThan(RUN_TIMEOUT_MS);
    const seconds = CELL_TIMEOUT_S;
    expect(seconds >= 30 && seconds <= 600, `cell 级超时推导出来是 ${seconds} 秒，不在 30~600 之间 ⇒ 单位写错或 RUN_TIMEOUT_MS 的量级漂了（它是毫秒）`).toBe(true);
  });

  /**
   * `verify.sh` 的认领回执（T4-3/T4-4）。四种坏法各红一条：
   * ① 专门阶段整条没建（本文件不在任何阶段的**位置参数**里）；
   * ② 建了但命令行上没设那两个门控变量（容器里"整片 skip 仍 exit 0"）；
   * ③ 建了、变量也设了，但没配 `assert-ran … --require-no-skips`（**全仓今天没有任何一条既有守卫看这个开关**，
   *    所以这一条是本文件自己收的账 —— 破坏性验证 ② 的实测就是它）；
   * ④ 建了专门阶段却忘了在容器分支 `--exclude` 本文件（于是"单元测试"阶段扫目录时**再起一次**真 Toree JVM）。
   * ⚠ 主守卫是 `regression/verify-coverage.test.ts`（它判所有文件的孤儿/排除/env 三件事）；这里只收本文件这张回执，
   *    解析器因此写得很窄，不许长成第二份通用实现。
   */
  it('verify.sh 认领本文件：一条设齐两个门控变量 + 落 json 报告的阶段，外加一条 --require-no-skips 的 assert-ran', () => {
    const stages = vitestStages(VERIFY_SH);
    const claiming = stages.filter((s) => s.patterns.includes(THIS_FILE_REL));
    expect(
      claiming.map((s) => s.label),
      `没有任何一条 vitest 阶段把 ${THIS_FILE_REL} 当**位置参数**点名（找到的阶段是：${stages.map((s) => s.label).join(' | ')}）⇒ 容器那一组一行都不跑。` + '接线写在 scripts/verify.sh 的 NB_SERVICE=1 分支里，格式必须是 `run "<标签>" env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run ' + THIS_FILE_REL + ' --reporter=json --outputFile=' + RAN_REPORT + '`',
    ).toEqual([expect.any(String)]);
    const stage = claiming[0]!;

    for (const v of ['ARENA_IN_CONTAINER', 'ARENA_NOTEBOOK_SERVICE']) {
      expect(stage.vars, `阶段「${stage.label}」的**命令行**上没有 ${v}=1 ⇒ 容器里那一组会整片 skip 而 vitest 仍 exit 0。` + '（verify-coverage 那条 env 判据读的是命令行文本，看不见容器继承来的那份 env）').toContain(v);
    }
    expect(stage.command, `阶段「${stage.label}」没有 --reporter=json ⇒ 下一条 assert-ran 没有报告可读（读上一次留下的旧 json 比没有闸门更坏）`).toContain('--reporter=json');
    expect(stage.command, `阶段「${stage.label}」的 --outputFile 不是 ${RAN_REPORT} ⇒ 与 assert-ran 那一条引用的路径各写一份就会漂`).toContain(`--outputFile=${RAN_REPORT}`);

    const companions = assertRanCommands(VERIFY_SH).filter((c) => c.includes(RAN_REPORT));
    expect(companions.length, `${RAN_REPORT} 这份报告没有被任何一条 assert-ran 阶段引用 ⇒ "整片 skip 仍 exit 0"这件事没人判`).toBe(1);
    const companion = companions[0]!;
    expect(companion, '那条 assert-ran 没带 --require-no-skips ⇒ 本文件的常驻组在容器里也绿，"容器组整片被跳掉"会看起来像 10 passed / 4 skipped 而 vitest exit 0（摘掉这一个开关今天不会红在任何既有守卫上，红只能红在这里）').toContain('--require-no-skips');
    expect(companion, `那条 assert-ran 的打印标签里没有「${ASSERT_RAN_LABEL}」⇒ 报告里那一句认不出是哪一档`).toContain(ASSERT_RAN_LABEL);

    const excluded = stages.filter((s) => s.excludes.includes(THIS_FILE_REL));
    expect(excluded.length, `容器分支的"单元测试"阶段没有 --exclude ${THIS_FILE_REL} ⇒ 它会随目录扫到本文件，与专门阶段**各起一次**真 Toree JVM（评审 I-1 记的那笔账）`).toBe(1);
    expect(excluded[0]!.label, `--exclude 本文件的那条阶段与专门点名它的那条**同名** ⇒ 那是 if/else 的两个分支，同名的另一支不会多跑一个文件`).not.toBe(stage.label);

    const skipMessage = VERIFY_SH.split(/\r?\n/).find((l) => l.includes('跳过 notebook kernel 真跑')) ?? '';
    expect(skipMessage, 'verify.sh 那条黄字的"跳过 notebook kernel 真跑"里没点名本文件 ⇒ 宿主档读的人会以为只是少跑了 kernel/embed/教程三档，' + '不知道 Scala 这一档也跳了（它已经在容器里、只是没在那个服务实例里）。把这一档加进那句提示').toContain('scala-kernel.test.ts');
  });
});
