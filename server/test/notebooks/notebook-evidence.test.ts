import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { executedNotebookEvidence, executedNotebookScratchPath, nbconvertExecuteToFileArgv, notebookEvidence, readExecutedNotebook, readExecutedNotebookFile, removeExecutedNotebookScratch } from './notebook-evidence.js';

/**
 * WI-91b Task 1：**量具本体的形状判据**（宿主档，纯函数 + 盘上往返，不需要 Jupyter）。
 *
 * 判据只判一件事：**"工具读不出"不许被读成"kernel 坏了"**。
 * Apache Toree 会在 `jupyter nbconvert --stdout` 的 JSON 前面先打两行 interpreter 注册表
 * （`(Scala,org.apache.toree.kernel.interpreter.scala.ScalaInterpreter@…)` 那种），
 * 而旧读法是 `JSON.parse(整个 stdout)` ⇒ 它抛的那句话与"kernel 真的坏了"长得一模一样
 * （本仓库最恨的静默降级形状）。本文件钉住修好之后的读法：
 * - `readExecutedNotebook(text)`：**严格**读法 —— 容忍 JSON 对象**之前的**垃圾行（实测的 Toree 形状只有前缀），
 *   但"整段都不是合法 JSON"时**必须抛**（绝不静默返回 `{cells: []}` —— 那会把"kernel 坏了"读成"这本 notebook 没有 cell"）。
 * - `readExecutedNotebookFile(path)`：容器档入口（R2 钉死的接口，Task 4 复用）—— 主路径 (a)：nbconvert 用
 *   `--output` 落盘，JSON 从**文件**里读，垃圾行留在 stderr 里根本进不了判据对象。
 * - `executedNotebookEvidence(raw)` 的**宽松**语义（解析不了给有界 error 条目而不是 throw）**不变** ——
 *   它是 `kernel.test.ts` / `tutorials.test.ts` 现有 stdout 档的判据对象，收紧它就是放宽/改写别人的判据（越界）。
 *
 * 为什么新建文件而不是并进 `embed.test.ts`：本文件判的是 `notebook-evidence.ts` 这层**公共件**，
 * embed 档判的是反代隧道；混在一起会让"量具坏了"与"隧道坏了"共用一个红标签。
 * 接线：`server/test/notebooks/` 整个目录已被 verify.sh 的「单元测试」阶段扫（宿主与容器都扫），
 * 本文件没有 env 门控的 describe ⇒ 无需任何新阶段认领（`verify-coverage.test.ts` 按目录认领判它）。
 */

/** 跑一次 fn：抛了给 message，没抛给 null（"必须抛"的判据要能区分"抛了"与"静默返回了个东西"）。 */
function captureThrow(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** 本文件在 dataDir scratch 目录里造过的文件（afterAll 清扫；"scratch 不许留在工作区"的同类纪律）。 */
const createdFiles: string[] = [];

function scratchFile(tag: string): string {
  const p = executedNotebookScratchPath(tag);
  createdFiles.push(p);
  return p;
}

afterAll(() => {
  // 先删文件，再试图收掉**空**目录（不为测试把自己的 scratch 树留在实例数据目录里）。
  for (const f of createdFiles) removeExecutedNotebookScratch(f);
  const dir = join(config.dataDir, 'notebook-exec-scratch');
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 目录扫不干净不是判据（判据是"本文件造的文件都没留下"，下面每条自己钉）；留着空目录不等于留 scratch。
  }
});

describe('readExecutedNotebook：严格读法（Toree 污染的前缀不许被读成"kernel 坏了"）', () => {
  it('Task 1 存在的理由：前面混了两行 kernel 注册表、后面才是合法 notebook JSON 的那份 stdout，必须被读出来（brief Step 1 逐字夹具）', () => {
    // 一份"前面混了两行垃圾、后面才是合法 notebook JSON"的 stdout，必须被读出来
    const polluted = '(Scala,org.apache.toree.kernel.interpreter.scala.ScalaInterpreter@1015a4b9)\n' + '(SQL,org.apache.toree.kernel.interpreter.sql.SqlInterpreter@1acb74ad)\n' + JSON.stringify({ cells: [], metadata: { kernelspec: { name: 'x' } } });
    const nb = readExecutedNotebook(polluted);
    expect(nb.cells).toEqual([]);
    // 读出来的必须是**那本 notebook 整体**而不是"凑一个空 cells 交差"：metadata 也得在场。
    // 这一条同时是"空 cells 是合法读数"的证据 —— 它与"读不出"的区别就是抛不抛（Task 2..5 全部踩在这个区分上）。
    expect(nb.metadata?.kernelspec?.name, '跳过前缀后整本 notebook 都要在，不只是 cells 这一项').toBe('x');
  });

  it('干净的整段 JSON（落盘主路径 (a) 的正常形状）原样读出；文件末尾多一个换行也算干净', () => {
    const text = JSON.stringify({ cells: [{ cell_type: 'code', outputs: [] }], metadata: { kernelspec: { name: 'arena-pyspark' } } });
    expect(readExecutedNotebook(text).cells.length).toBe(1);
    expect(readExecutedNotebook(`${text}\n`).cells.length, '落盘文件末尾带换行是常态，不许因此走成"读不出"').toBe(1);
  });

  it('形状判据：整段都不是合法 JSON ⇒ **必须抛**（绝不静默返回 {cells: []} —— 那会把"kernel 坏了"读成"这本 notebook 没有 cell"）', () => {
    const junkCases = [
      '',
      '这不是 JSON',
      'jupyter: nbconvert: command not found',
      '<html><body>500 Internal Server Error</body></html>',
    ];
    for (const junk of junkCases) {
      const msg = captureThrow(() => readExecutedNotebook(junk));
      expect(msg, `「${junk.slice(0, 40)}」必须抛 ⇒ 静默返回（比如 {cells: []}）就是把"kernel 坏了"读成"notebook 是空的"（派发词的硬约束）`).not.toBeNull();
      expect(msg, `抛了也要说清判的是"读不出这份文本"（实际开头：${msg?.slice(0, 120)}）`).toContain('读不出来');
      // 红话纪律：读取层只判"文本→notebook"这件事，**不许**替进程层编一句"跑不起来"——
      // 那句话归 nbconvertCrashEvidence（它吃的是 execFileSync 的 error，这里吃的是文本）。
      expect(msg).not.toContain('跑不起来');
    }
  });

  it('形状判据的另一半：合法 JSON 但没有 cells 数组 ⇒ 也要抛，且话要与"整段读不出来"分开', () => {
    const msg = captureThrow(() => readExecutedNotebook(JSON.stringify({ metadata: { kernelspec: { name: 'x' } } })));
    expect(msg, '没有 cells 数组的 JSON 不是"执行后的 notebook"，静默放行 = 把结构缺件读成空 notebook').not.toBeNull();
    expect(msg).toContain('cells 数组');
    expect(msg).not.toContain('读不出来');
    // 前缀污染 + 缺 cells：跳过前缀之后仍按"缺 cells"这一支报（两支的正交性）。
    const pollutedNoCells = '(Scala,org.apache.toree.kernel.interpreter.scala.ScalaInterpreter@1015a4b9)\n' + JSON.stringify({ metadata: {} });
    expect(captureThrow(() => readExecutedNotebook(pollutedNoCells))).toContain('cells 数组');
  });

  it('失败消息有界：200KB 的不可读垃圾不许整段进报告', () => {
    const huge = 'y'.repeat(200_000);
    const msg = captureThrow(() => readExecutedNotebook(huge));
    expect(msg, '整段没有 { 的超长垃圾必须走"读不出来"那一支').not.toBeNull();
    expect(msg!.length, `失败消息现在 ${msg!.length} 字符 ⇒ 预览要截断（与 EVIDENCE_CAP 同一族纪律）`).toBeLessThan(1_000);
  });

  it('只容忍**前缀**垃圾，不容忍尾注（实测的 Toree 形状只有前缀；要收后缀是新判据，得带自己的测试）', () => {
    const msg = captureThrow(() => readExecutedNotebook('{"cells": [], "metadata": {}}\n[info] shutdown complete'));
    expect(msg, 'JSON 之后还有尾巴时"从第一个 { 切"读不出来 ⇒ 这一支必须抛而不是猜').not.toBeNull();
    expect(msg).toContain('读不出来');
  });

  it('读出的 notebook 与 stdout 宽松提取器（executedNotebookEvidence）取同一套证据 ⇒ 两扇门不许两套真相', () => {
    const good = JSON.stringify({
      cells: [
        { cell_type: 'markdown', outputs: [] },
        { cell_type: 'code', outputs: [{ output_type: 'stream', name: 'stdout', text: ['alive=42\n'] }] },
        { cell_type: 'code', outputs: [{ output_type: 'stream', name: 'stderr', text: ['WARN ignored\n'] }] },
        { cell_type: 'code', outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['6'] } }] },
        { cell_type: 'code', outputs: [{ output_type: 'error', ename: 'SyntaxError', evalue: 'x', traceback: ['t'.repeat(5_000)] }] },
      ],
    });
    // 严格入口（reader → notebookEvidence）与既有宽松入口（整段 stdout → executedNotebookEvidence）
    // 必须对同一本 notebook 给**逐字段相同**的证据；两份循环各写一份就是"两扇门的真相会漂"（WI-107 那一课）。
    expect(notebookEvidence(readExecutedNotebook(good))).toEqual(executedNotebookEvidence(good));
    expect(notebookEvidence(readExecutedNotebook(good)).stdout, '只收 stdout 行：stderr 与 execute_result 不许混进来').toEqual(['alive=42']);
    expect(notebookEvidence(readExecutedNotebook(good)).errors, '出错 cell 落成「cell 号: 异常名」').toEqual(['cell 4: SyntaxError']);
  });

  it('宽松门保持旧语义（解析不了给一条有界 error 而不是 throw）⇒ 钉住"两种语义不许被顺手统一"', () => {
    const broken = executedNotebookEvidence('{ 这不是 JSON');
    expect(broken.errors, 'kernel.test.ts 的常驻判据吃的是这条旧语义：宽松门自己改成 throw 会把隔壁整档撞红').toEqual(['输出不是 notebook JSON：{ 这不是 JSON']);
    expect(broken.stdout).toEqual([]);
    // 而严格门对同样的输入**必须抛**（派发词硬约束）：两扇门各自的形状在这条用例里同框钉死。
    expect(captureThrow(() => readExecutedNotebook('{ 这不是 JSON'))).not.toBeNull();
  });
});

describe('readExecutedNotebookFile：容器档从落盘文件读（Task 4 复用的接口）', () => {
  it('往返：写进实例数据目录的 scratch → 读回 → 删净（scratch 不许留在工作区）', () => {
    const p = scratchFile('wi91b-unit-roundtrip');
    const text = JSON.stringify({ cells: [{ cell_type: 'code', outputs: [] }, { cell_type: 'code', outputs: [] }], metadata: { kernelspec: { name: 'arena-scala' } } });
    writeFileSync(p, text, 'utf8');
    const nb = readExecutedNotebookFile(p);
    expect(nb.cells.length, '落盘读回来的 cell 数必须就是写进去的').toBe(2);
    expect(removeExecutedNotebookScratch(p), '删完必须确认没了（embed.test.ts 收尾删除判据的同形状）').toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it('文件不在 ⇒ 抛，且话说的是"结果文件读不到"这一层，不谎报进程坏法', () => {
    const msg = captureThrow(() => readExecutedNotebookFile(join(config.dataDir, 'notebook-exec-scratch', 'wi91b-unit-definitely-not-here.ipynb')));
    expect(msg, '退 0 但文件没写出来（路径算错/目录被动）是接线层故障，必须抛').not.toBeNull();
    expect(msg).toContain('读不到');
    expect(msg).not.toContain('跑不起来');
  });

  it('文件内容混了前缀垃圾也读得出（读法容忍对落盘入口同样生效 ⇒ 两扇门一套判据）', () => {
    const p = scratchFile('wi91b-unit-polluted');
    writeFileSync(p, '(Scala,org.apache.toree.kernel.interpreter.scala.ScalaInterpreter@1015a4b9)\n' + JSON.stringify({ cells: [], metadata: { kernelspec: { name: 'wi91b-fake-skip' } } }), 'utf8');
    const nb = readExecutedNotebookFile(p);
    expect(nb.cells).toEqual([]);
    // 判 metadata 而不是只看 cells：静默降级成 `{cells: []}` 的读法过得了"空 cells"，过不了"这本 notebook 里
    // 写着的 kernelspec 也必须在场"（destructive 实测：mutation "解析不了就回 {cells: []}" 曾悄悄穿过只判 cells 的版本）。
    expect(nb.metadata?.kernelspec?.name, '读回的必须是那本 notebook 本身，不是凑数的空壳').toBe('wi91b-fake-skip');
    expect(removeExecutedNotebookScratch(p)).toBe(true);
  });
});

describe('executedNotebookScratchPath：scratch 落在实例自己的数据目录（WI-40 纪律）', () => {
  it('根在 config.dataDir 下（ARENA_DATA_DIR 换目录时它跟着换）、名以 .ipynb 结尾、两次调用必不相同', () => {
    const p1 = scratchFile('wi91b-unit-path');
    const p2 = scratchFile('wi91b-unit-path');
    expect(p1).not.toBe(p2);
    expect(dirname(p1), `scratch 必须住在实例数据目录（今天 ${config.dataDir}）里，而不是工作区源码树或系统 tmp`).toBe(join(config.dataDir, 'notebook-exec-scratch'));
    expect(p1.endsWith('.ipynb'), '落盘产物是 notebook，扩展名照 nbconvert 的习惯').toBe(true);
    expect(existsSync(dirname(p1)), 'scratch 目录要被调用方建出来（不赌 nbconvert 会不会自己建 --output-dir）').toBe(true);
    expect(removeExecutedNotebookScratch(p1)).toBe(true);
    expect(removeExecutedNotebookScratch(p2)).toBe(true);
  });
});

describe('nbconvertExecuteToFileArgv：主路径 (a) 的参数形状', () => {
  const NB = '/app/content/notebooks/00.ipynb';
  const OUT = '/app/data/notebook-exec-scratch/probe-1-2.ipynb';

  it('--output/--output-dir 在、--stdout **不在**（JSON 不再走 stdout 就是本次修复的本体）、notebook 路径排最后', () => {
    const argv = nbconvertExecuteToFileArgv(NB, OUT, 120, 'arena-scala');
    expect(argv[0], '第一个参数是子命令').toBe('nbconvert');
    expect(argv.slice(argv.indexOf('--to'), argv.indexOf('--to') + 2), '--to 的值必须是 notebook（默认 markdown 那份不是 JSON）').toEqual(['--to', 'notebook']);
    expect(argv).toContain('--execute');
    expect(argv, '少了 allow_errors=True ⇒ 回到"cell 一报错整条路就 throw"那个已趟过的坑').toContain('--ExecutePreprocessor.allow_errors=True');
    // 这条是 (a) 与旧读法的分界：出现 --stdout 就说明执行结果又被当成 stdout 读，Toree 的注册表行会再次污染它。
    expect(argv, '主路径 (a) 下执行后的 notebook 走 --output 落盘，--stdout 必须退役 ⇒ 它回来就是往"整段 stdout 当 JSON"的老坑退').not.toContain('--stdout');
    const outDir = argv.indexOf('--output-dir');
    expect(outDir, '--output-dir 必须在').toBeGreaterThan(-1);
    expect(argv[outDir + 1]).toBe(dirname(OUT));
    const out = argv.indexOf('--output');
    expect(out, '--output 必须在').toBeGreaterThan(-1);
    expect(argv[out + 1]).toBe('probe-1-2.ipynb');
    expect(argv[out + 1], '--output 只许吃文件名（目录归 --output-dir；跨 nbconvert 版本对"--output 带路径"的语义不一致）').not.toContain('/');
    expect(argv[argv.length - 1], '被执行的 notebook 排在参数最后').toBe(NB);
  });

  it('cell 级超时只给一次；kernel_name 覆盖只在给了名字时出现（python3 反例自测与 arena-scala 都走这一个构造点）', () => {
    const withKernel = nbconvertExecuteToFileArgv(NB, OUT, 120, 'python3');
    expect(withKernel).toContain('--ExecutePreprocessor.kernel_name=python3');
    const timeoutFlags = withKernel.filter((a) => a.startsWith('--ExecutePreprocessor.timeout='));
    expect(timeoutFlags, 'cell 级超时必须给且只给一次（默认 30s，Spark 冷启动会撞穿它）').toHaveLength(1);
    expect(timeoutFlags[0]).toBe('--ExecutePreprocessor.timeout=120');
    const noKernel = nbconvertExecuteToFileArgv(NB, OUT, 240);
    expect(noKernel.filter((a) => a.startsWith('--ExecutePreprocessor.kernel_name')), '不指名 kernel 时不许发出一个空的 kernel_name 覆盖').toEqual([]);
  });
});
