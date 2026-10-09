import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';
import { venvPythonPath } from '../../src/ide/env.js';
import { TUTORIAL_CLAIMS, TUTORIAL_TIMEOUT_MS, markerOf } from './tutorial-claims.js';
import { executedNotebookEvidence, nbconvertCrashEvidence } from './notebook-evidence.js';

/**
 * 教程 notebook 的**可运行性**闸门（WI-90 子项目 B，Task 1 = 闸门本体；教程本身是 Task 2/3/4）。
 * 只在"那个跑着 notebook 服务的容器"里有执行判据对象：门控写在**文件里**（合取两个变量），
 * 形状照 `kernel.test.ts` / `embed.test.ts`，理由也相同 ——
 * `server/test/notebooks/` 这个目录本来就被「单元测试」阶段扫（宿主与 dev / tools 一样扫），
 * 所以"只在阶段名里点这个文件"根本挡不住它在没有 Jupyter 的机器上跑（评审 T10-1）。
 * ⚠ 这两个标识符的**大小写是承重的**（评审 I-4）：`verify-coverage.test.ts` 的 `gateVars()` 用
 * `\b([A-Z][A-Z0-9_]{2,})\b` 从 `skipIf(...)` 的条件回指 `const` 声明，再从中取 `process.env.X`。
 * 改成 camelCase ⇒ `gateVars()` 解不出变量名 ⇒ 本文件从「env 门控」那条判据里静默退出，
 * 阶段命令上的 `env` 前缀降级成装饰（同一课见 `kernel.test.ts` 那段「这两个标识符的**大小写是承重的**」）。
 * ⚠ 引用别的文件一律用**用例名/注释锚**，不用行号 —— 本仓库的既有教训就是"行号会漂"（`kernel.test.ts` 自己
 * 就把一处注释从"`:35`"订正成"那条早就挪窝了"）。
 *
 * ## 给教程作者的两条规矩（评审 m1；篇 2/3 照这个形状写，写歪了会红在这里）
 *
 * **m1（slug 的命名粒度）**：注册表是"本篇结论的**索引**"，所以**一个 marker 只能 gate 一个结论**。
 * 一个 code cell 里想放多条 `assert` 只有两种合法形状：
 * ① 它们是**同一个结论的不同侧面**（前提/对照/边界可以搭同一条 marker 的车，但要在 cell 的注释里写明
 *    "这条 marker gate 的是哪一句结论、这几条 assert 各自是它的哪一面"）；② 否则**拆 slug**（一个结论一个 marker）。
 * 反面就是篇 1 落地时的形状：`hot-key-dominates` 顺带 gate 了"错量法对倾斜不敏感"这条**关于度量**的结论，
 * `salting-halves-max-partition` 顺带 gate 了"中间态不再倾斜" —— 两个下标各挂 2~3 件事，
 * 于是"哪条结论坏了"要从红话往下读 cell 才知道。本轮不动注册表（改它等于改 marker 契约，要三篇一起改），
 * 但**新写的篇 2/3 不许再这样**；下标与结论一旦不是一一对应，本文件那条"marker 单元必须有 assert"
 * 也只能证明"有人判了"，证明不了"判的是那句结论"。
 *
 * **M1（结论层拦不住的最后一处）**：执行层 + marker 双向相等拦得住"删 assert 又删 print"，
 * 但**删 assert、留着那行 print** 只需一处编辑，就能让一条方向性结论没人判而整档全绿 ——
 * 而 Ruling(B1) 的立身理由恰恰是"有人把 assert 删了"。常驻那组的「每条已登记 marker 所在的那个 code cell
 * 里必须有 assert」判的就是它，判据取的是**盘上的 notebook 源码**（不是容器里 nbconvert 的输出）：
 * 同一份字节，但在 45s 的宿主档就有牙、每次提交都跑，破坏性验证也当场能做（见下面那两条变异）。
 * ⚠ 它的**射程要说清楚**：判的是"那个 cell 里至少有一条语句级的 `assert`"，即"有人在判这件事"；
 * 它**不判阈值对不对**、也不判那条 assert 与 marker 说的那句结论是否同一件事 ——
 * 那半边（把阈值上收进注册表、marker 行尾带实测数值）被有意记账给交付档（评审 M1 的第 ② 半），本轮不做。
 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';

/** `execFileSync` 的预算：nbconvert 自己的秒级超时之外再给一段收尾，否则两层的数字撞在一起分不出谁到点。 */
const EXEC_SLACK_MS = 15_000;
const EXEC_TIMEOUT_MS = TUTORIAL_TIMEOUT_MS + EXEC_SLACK_MS;
/**
 * cell 级超时（**秒**，nbclient 那层按秒算）。它同时是：发给 nbconvert 的参数、
 * 以及崩溃消息里要点名给排查者的那个数 —— 两处共用一个常量，因为"报错说的秒数"与"实际发出去的秒数"
 * 各写一份就是评审 M2 抓的那种漂。
 */
const CELL_TIMEOUT_S = Math.floor(TUTORIAL_TIMEOUT_MS / 1000);
/**
 * vitest 那一层的预算**必须大于** `execFileSync` 的预算（常驻那组判这条不等式）。
 * 反过来的形状是真实的坑：`vitest.config.ts` 的 `testTimeout` 是 60s，而规格给单篇教程的预算是 90s ——
 * 照默认值写，一篇**正常偏慢**的教程会先被 vitest 打死，报出来的是 `Test timed out in 60000ms`，
 * 而不是 `nbconvertCrashEvidence()` 那句"先想超时"（那条函数存在的意义就是把超时说清）。
 */
const IT_TIMEOUT_MS = TUTORIAL_TIMEOUT_MS + 30_000;

/** 目录里以这个前缀开头的那一篇是 A1 的 smoke，由 `kernel.test.ts` 判（这里跑它 = 容器里多起一次 Spark）。 */
const SMOKE_PREFIX = '00-';
/** `kernel.test.ts` 认领 smoke 的那一篇的文件名 —— 清单完整性用它堵"新写一篇偏也叫 `00-*`"这个洞。 */
const SMOKE_FILE = '00-smoke-pyspark.ipynb';

/**
 * 执行一篇教程的 nbconvert 参数。形状判据在常驻那一组（宿主就有牙），容器那一组用它真跑 ——
 * 两边共用同一个构造点，所以"常驻那条钉住的"与"容器那条实际发出去的"是同一个数组，不是两份会漂的真相。
 */
function nbconvertArgv(notebook: string): string[] {
  return [
    'nbconvert',
    '--to',
    'notebook',
    '--execute',
    // 解析器读的是这份 stdout（执行后的整本 notebook）。少了它，`--stdout` 没写出来 ⇒ 拿不到 JSON。
    '--stdout',
    /**
     * **必带**（`kernel.test.ts` 那条「smoke notebook 跑完并打出 venv ok」里已经趟过一次）：不带的话 cell 一报错 nbclient 就抛、
     * nbconvert 退非 0、`execFileSync` 就地 throw ⇒ 下面那份"取 stdout 行与 error 条目"的解析
     * **一行都执行不到**，承诺的有界证据（cell 号 + 异常名）在最该出现的那一次缺席，
     * 报告里剩下的是 node 把整段 Spark stderr 拼进 message。
     */
    '--ExecutePreprocessor.allow_errors=True',
    // 单位是**秒**（nbclient 的 `ExecutePreprocessor.timeout` 按秒算），所以这里从毫秒预算推导；
    // "推导出来的是秒而不是毫秒"由常驻那条按量级判住（`120` 当成 ms 写会推导出 0 秒）。
    `--ExecutePreprocessor.timeout=${CELL_TIMEOUT_S}`,
    notebook,
  ];
}

/** RegExp 源码里一个字面量要参与匹配时的转义（教程文件名会带 `.`，不转义就变成"任意字符"）。 */
const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 从 stdout 行里收**本篇前缀**下打出来的所有结论 slug（反向核对用）。 */
function printedSlugs(stdout: string[], file: string): string[] {
  const re = new RegExp(`WI90\\[${escapeForRegExp(file.replace(/\.ipynb$/, ''))}\\]\\[([a-z0-9][a-z0-9-]{0,60})\\] OK`, 'g');
  const found = new Set<string>();
  for (const line of stdout) {
    for (const m of line.matchAll(re)) found.add(m[1]!);
  }
  return [...found].sort();
}

/**
 * 盘上那份 notebook 的**源码单元**（只取 code cell，`source` 按 nbformat 可以是串或按行数组）。
 * 常驻那组那两条"源码级"判据读的就是它 —— 读盘而不是读容器里 nbconvert 的输出，为的是同一份字节
 * 在 45s 的宿主档就有牙（每次提交都跑），而不是等一次 10-20 分钟的容器验证才发现结论没人判了。
 */
function codeCellSources(notebookPath: string): string[] {
  const nb = JSON.parse(readFileSync(notebookPath, 'utf8')) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
  return (nb.cells ?? [])
    .filter((c) => c.cell_type === 'code')
    .map((c) => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? '')));
}

/**
 * "这个单元里真的有人在判"的判据：取**语句级**的 `assert`（行首允许缩进），所以
 * 注释里写一句 `# assert ...`、或把结论只留在 `print` 里都不算数。
 * 写在同一行的复合语句（`x = 1; assert x`）这里不收 —— 那种写法本身就该拆成两行。
 */
const hasStatementAssert = (src: string): boolean => src.split('\n').some((line) => /^\s*assert\b/.test(line));

/**
 * 两层判据，缺任何一层都会放过一种真实的坏法：
 * ① **执行层**：`output_type === 'error'` 的 cell 数必须为 0，且 kernel 是 `arena-pyspark`。
 *    ⚠ kernel 那条不是装饰：`metadata.kernelspec.name` 写成 `python3` 的教程照样跑得绿，
 *    而它跑在**镜像自带的系统解释器**上 —— 那正是红线①要拦在判题环境外面的那个，
 *    于是"教程里 `!pip3 install` 装进哪套环境"从教学变成了踩线示范。
 * ② **结论层**（`TUTORIAL_CLAIMS`）：每篇声明的方向性结论都必须打出 marker。
 *    只看"没报错"抓不到**有人把 assert 删了**（Ruling(B1)）：删掉之后零异常，而结论那一半没人管了。
 *    期望值住在被测文件**外面**的注册表里，理由就在同一句里：期望值若由 notebook 自己声明，
 *    "删一条结论"就同时删掉了判据。
 * ②' 反向（规格 §6 的"配套判据"）：**notebook 打出的标记集合必须等于注册表里的那一组**。
 *    只有正向核对时留着一个对称的坏法："结论已经反了、闸门正在红"的人可以把**注册表里那条 slug 删掉**
 *    来让它变绿 —— 正向核对从此再也不问起它，而那篇教程照旧把错的结论教给读者。
 *    多一条（写了结论没登记）与少一条（登记了却没打印）在这里都红。
 */
describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)('教程 notebook 容器里真执行', () => {
  /** 全新卷上 IDE venv 还不存在 ⇒ nbconvert 会挂在"解释器文件找不到"，那不是教程坏了。
   *  这一条把那种前提**说成前提**（`kernel.test.ts` 那个 `beforeAll` 的注释「全新卷上 venv 还不存在」是同一课）。
   *  ⚠ 它故意不是 `beforeAll` 里的"静默跳过"：本仓库的规矩是前提不成立要说成一条红/一条话，
   *  不是 `return`。容器档走 `./start.sh --verify` 时，前面的「Notebook 运行时」阶段已经由
   *  `kernel.test.ts` 的 `beforeAll` 把 venv 建出来了（幂等，锁在 `server/src/ide/env.ts`），
   *  所以这一条在正常路径上是绿的；单独跑本文件时它是那句"请先按页面「准备环境」"。 */
  it('IDE venv 必须已存在（否则这一档的判据对象不成立，先按页面「准备环境」）', () => {
    const interpreter = venvPythonPath(config.ideEnvDir);
    expect(existsSync(interpreter), `venv 解释器不在 ${interpreter} ⇒ arena-pyspark kernel 起不来（它就是 kernel.json 的 argv[0]）。` + '这一条不是教程坏了，是前置条件没满足：跑一次页面「准备环境」，或先跑容器档的「Notebook 运行时」阶段（它的 beforeAll 会建）。').toBe(true);
  });

  for (const [file, claims] of Object.entries(TUTORIAL_CLAIMS)) {
    it(
      `${file}：跑通、kernel 对、每条方向性结论都打出 marker`,
      () => {
        const notebook = join(config.notebook.seedDir, file);
        expect(existsSync(notebook), `注册表里有 ${file} 而 ${config.notebook.seedDir} 里没有这个文件 ⇒ 有人删了教程没删注册表（或写错文件名）`).toBe(true);

        let raw: string;
        try {
          raw = execFileSync('jupyter', nbconvertArgv(notebook), { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
        } catch (err) {
          // 这一条路**不该**是"某个 cell 抛了异常"：allow_errors=True 保证那种情况退 0、错误落成数据。
          // 走到这里说的是"这一档跑不起来"（kernel 没注册 / venv 缺失 / DeadKernelError / 撑破 maxBuffer / 到点）。
          // 预算要**由这里传进去**（评审 M2）：公共件原来带着 `kernel.test.ts` 的 180s/200s 一起被搬过来，
          // 而这一档到点的是 135s —— 教程超时是最可能的真故障，报成别人的数字就等于把人赶去查隔壁文件。
          throw new Error(nbconvertCrashEvidence(err, { execTimeoutMs: EXEC_TIMEOUT_MS, cellTimeoutS: CELL_TIMEOUT_S }));
        }
        const { stdout, errors } = executedNotebookEvidence(raw);

        // ① 执行层
        expect(errors, `${file} 有 cell 抛异常（只有 cell 号与异常名，不带 traceback 正文）：\n${errors.join('\n')}`).toEqual([]);

        const kernelspec = (JSON.parse(raw) as { metadata?: { kernelspec?: { name?: string } } }).metadata?.kernelspec?.name;
        expect(
          kernelspec,
          `${file} 跑在内核 ${kernelspec} 上而不是 ${NOTEBOOK_KERNELS.pyspark} ⇒ 它可能在**镜像自带的系统解释器**上跑，` +
            '教程里 `!pip3 install` 装进去的就是判题子进程看得见的那套 site-packages（红线①）。' +
            `改的是 notebook 的 metadata.kernelspec.name（要写成 ${NOTEBOOK_KERNELS.pyspark}），不是这条断言`,
        ).toBe(NOTEBOOK_KERNELS.pyspark);

        // ② 结论层：正向（注册表里每条都必须出现）
        const missing: string[] = [];
        for (const slug of claims) {
          const marker = markerOf(file, slug);
          if (!stdout.some((line) => line.includes(marker))) missing.push(marker);
        }
        expect(missing, `${file} 没打出这些结论标记：${missing.join(' , ')}` + ' ⇒ 那条结论被删了、被改跑了、assert 根本没执行，或 marker 的格式与 `markerOf()` 不是同一个串（Ruling(B1)）').toEqual([]);

        // ②' 结论层：反向（notebook 打出的集合不许多出注册表里有的）
        const printed = printedSlugs(stdout, file);
        const unregistered = printed.filter((s) => !claims.includes(s));
        expect(unregistered, `${file} 打出了注册表里没有的结论标记：${unregistered.join(' , ')} ⇒ 有人往教程里加了一条方向性结论却没登记，` + '于是那条结论**没有任何判据守着**（它对闸门是隐形的，读者却会当教程结论看）。登记进 `tutorial-claims.ts` 才是修法，删掉 print 不是').toEqual([]);
        // 双向相等（少了的那条由上面正向那条报，这里把"两个集合相等"这句本身钉住，报错更短也更好读）。
        expect(printed, `${file} 打出的 WI90 标记集合与注册表不一致（期望 ${JSON.stringify([...claims].sort())}，实际 ${JSON.stringify(printed)}）` + ' ⇒ 多一条少一条都红：多的是"有结论没登记"，少的是"登记了却没打印"（结论被删/改跑/marker 漂格式）').toEqual([...claims].sort());
      },
      IT_TIMEOUT_MS,
    );
  }
});

// ──────────────────── 常驻：宿主档也要跑的那一组 ────────────────────

/**
 * 这一组**不需要 Jupyter**：判的是"盘上的目录"与"内存里的注册表"是否互相圆得上、
 * 注册表自己的形状是否合法、发出去的 nbconvert 参数是否还是那一套。
 * ⇒ 它刻意放在容器那一组外面：同一句判据在 `verify:fast`（约 45s，每次提交都跑）就有牙，
 * 不必等一次 10-20 分钟的容器验证。"新写一篇忘了接闸门"这种坏法最贵的地方是**发现得晚**，不是发现不了。
 */
describe('教程闸门的常驻判据（宿主也跑）', () => {
  /** 清单完整性（双向）。 */
  it('content/notebooks 里的每篇教程都必须在注册表里，注册表里也不许有目录里没有的文件', () => {
    const inDir = readdirSync(config.notebook.seedDir)
      .filter((f) => f.endsWith('.ipynb'))
      .sort();
    const tutorials = inDir.filter((f) => !f.startsWith(SMOKE_PREFIX));
    const registered = Object.keys(TUTORIAL_CLAIMS).sort();
    expect(registered, `注册表与目录不一致。\n目录里的教程（非 ${SMOKE_PREFIX} 那一篇）：${JSON.stringify(tutorials)}\n注册表：${JSON.stringify(registered)}\n` + '⇒ 少了就是"新写一篇忘了接闸门"（页面看得到、文件树看得到，只有没人跑它）；多了就是"删了教程没删注册表"或文件名写错').toEqual(tutorials);

    // `00-` 是上面那条的**排除项**，所以它自己必须是个封闭集合：否则"新写一篇取名 00-intro.ipynb"
    // 就从这道闸门旁边走过去了 —— 这一条就是那个洞的盖子（它归 kernel.test.ts 判，那里只判 smoke 那一篇）。
    const smokes = inDir.filter((f) => f.startsWith(SMOKE_PREFIX));
    expect(
      smokes,
      `${config.notebook.seedDir} 里以 ${SMOKE_PREFIX} 开头的文件必须恰好是 ${SMOKE_FILE}（那一篇由 kernel.test.ts 真跑）。现在这张表是 ${JSON.stringify(smokes)} ⇒ 两种坏法之一：` +
        `①有人**新写了一篇 ${SMOKE_PREFIX} 开头的教程** —— 它落在上面那条的排除项里，于是不会被任何一道"可运行"闸门跑（改名 01-/02-/03- 并在 tutorial-claims.ts 登记才是修法）；` +
        `②${SMOKE_FILE} 被删了或改名了 —— 那 kernel.test.ts 那条「smoke notebook 跑完并打出 venv ok」也会红，两处红说的是同一件事，先查哪个是真的动过。`,
    ).toEqual([SMOKE_FILE]);
    expect(Object.keys(TUTORIAL_CLAIMS).filter((f) => f.startsWith(SMOKE_PREFIX)), `注册表里不许出现 ${SMOKE_PREFIX} 开头那一篇：它由 kernel.test.ts 真跑，这里再跑一遍 = 容器档多起一次 Spark（40-90s），而两次结果不构成两条判据`).toEqual([]);
  });

  /**
   * 注册表形状。`>0` 那条（brief Step 1）不在这里：Task 1 还没有教程，空表是**正确状态**，
   * 硬写"注册表非空"就是一条常驻在 `verify:fast` 里的红。它想判的东西由上面那条双向判住 ——
   * 第一篇教程一落地，"有教程而注册表是空的"就红在那里，而且是宿主档红。
   */
  it('注册表非空时每条 slug 形状合法（marker 拼错 ⇒ 那条判据永远只能靠人肉看）', () => {
    for (const [file, claims] of Object.entries(TUTORIAL_CLAIMS)) {
      expect(file.endsWith('.ipynb'), `注册表的 key 必须是文件名：${file}`).toBe(true);
      expect(/[/\\]/.test(file), `注册表的 key 只是文件名，不带目录分隔符：${file}`).toBe(false);
      // "每篇至少一条结论"：一条都没有的教程 = 执行层过了但结论层是空的 = Ruling(B1) 要防的那件事。
      expect(claims.length, `${file} 在注册表里一条结论都没登记 ⇒ 这道闸门对它只剩"没报错"，` + '而"没报错"正是本仓库记过的不够的那一半（有人把 assert 删了照样绿）').toBeGreaterThan(0);
      expect(new Set(claims).size, `${file} 的 slug 有重复 ⇒ marker 核对做了两遍同一件事`).toBe(claims.length);
      for (const slug of claims) expect(slug, `${file} 的 slug 形状不合：${slug}`).toMatch(/^[a-z0-9][a-z0-9-]{2,60}$/);
    }
  });

  /**
   * marker 的格式有一份**独立字面量基准**。为什么要有：`markerOf()` 是 notebook 那边（Python 里手敲的
   * `print("WI90[...][...] OK")`）与闸门这边唯一的共同真相，而计划/规格/教程正文写的都是**字面量**。
   * 有人把 `markerOf()` 改成 `WI90/<篇>/<slug>`（"更清晰"）之后，容器里每条 marker 断言都会红，
   * 而红出来的话指着**教程**（"那条结论被删了"）—— 一次冤红 + 一句指错方向的报错，比不判更贵（本仓库有先例）。
   * 基准在测试里，与被测的 `markerOf()` 不同源，所以它会红在 45s 的宿主档、并说出该改哪一边。
   */
  it('marker 的字面形状钉在这里（与规格 §6 / 计划 Ruling(B1) 同一串），markerOf 漂了先在这里红', () => {
    expect(markerOf('01-skew-and-hot-keys.ipynb', 'salting-wins'), 'markerOf() 与规格里那串字面量不一致 ⇒ 教程里手敲的 print 与闸门核对的 marker 会各自漂').toBe('WI90[01-skew-and-hot-keys][salting-wins] OK');
    expect(markerOf('02-x.ipynb', 'a-b'), '只有 .ipynb 后缀被去掉，目录/其它点号不动').toBe('WI90[02-x][a-b] OK');
  });

  /**
   * **M1（评审）：marker 所在的那个 code cell 里必须有语句级 `assert`。**
   * 它堵的是执行层与结论层都圆不上的那一处编辑：把 `assert` 删掉、留着下面那行 `print("WI90[...] OK")` ⇒
   * 零异常、marker 全打到、双向相等照过 —— 一条方向性结论从此没人判，而全档绿。
   * 同一份判据还顺手判死另一种"定向蒙人"：把 marker 改成循环里拼出来的 print（`for slug in [...]: print(f"WI90[…][{slug}] OK")`）
   * 之后 stdout 看起来完全正确，但**字面量**在源码里根本不存在 ⇒ 下面第一条 `hits` 为空就是它，
   * 所以红话要说清"marker 必须是字面量"。
   * ⚠ 射程（评审 M1 第 ② 半不做，这里就只判到这一层）：**有没有人判**，不判**阈值对不对**、
   * 也不判那条 assert 与 marker 那句结论是否同一件事。那半边要动三篇的写法与注册表形状，记账给交付档。
   * 破坏性验证（两条变异，宿主档实测）：① 删掉一条 assert 留着它的 marker print；② 四条 marker 塞进一个不 assert 的循环。
   */
  it('每条已登记 marker 所在的那个 code cell 里必须至少有一条 assert（删 assert 留 print 不许绿）', () => {
    for (const [file, claims] of Object.entries(TUTORIAL_CLAIMS)) {
      const sources = codeCellSources(join(config.notebook.seedDir, file));
      for (const slug of claims) {
        const marker = markerOf(file, slug);
        const hits = sources.map((src, idx) => ({ src, idx })).filter((c) => c.src.includes(marker));
        expect(
          hits.length,
          `${file} 的结论 ${slug}：marker 字面量「${marker}」在**任何** code cell 源码里都不存在 ⇒ ` +
            '两种坏法之一：①那行 print 被删了/改了格式（容器档那条也会红，两处说的是同一件事）；' +
            '②print 被挪进循环或函数里用 f-string 拼出来 —— 执行层看到的输出是对的，但**闸门读的是字节**，' +
            '拼出来的 marker 让"这条结论被判过"重新变成人肉检查。改的是教程（把那行字面量 print 与它的断言放回同一个单元），不是删这条判据',
        ).toBeGreaterThan(0);
        for (const hit of hits) {
          expect(
            hasStatementAssert(hit.src),
            `${file} 的结论 ${slug}：打印 marker 的那个 code cell（本篇第 ${hit.idx + 1} 个 code cell）里**一条语句级 assert 都没有** ⇒ ` +
              `那行「${marker}」现在是**没有证据的自报**：执行层零异常、结论层双向相等都会绿，` +
              '而 Ruling(B1) 立身的那件事（有人把 assert 删了）恰好发生在这里。' +
              '改的是教程正文：把那条判断该结论的 assert 加回这个单元（押确定量，别押耗时），不是删这条判据、也不是删 marker',
          ).toBe(true);
        }
      }
    }
  });

  /**
   * **m6（评审）：篇 1 导语承诺"最后一个单元是 `spark.stop()`：闸门跑完不留活内核"，
   * 而这条承诺原本一个字都没判** —— 承诺写在教程里、判据不存在，就是本仓库点过名的"文档比代码先行"。
   * 补成结构性判据：每篇已登记教程的**最后一个 code cell** 源码里必须有 `spark.stop()`。
   * 为什么能常驻：它判的是盘上的字节，与 Jupyter 无关；删掉那一行的坏法在宿主档就红。
   * 为什么值得判（不是审美）：容器档是一篇接一篇跑的，前一篇留着活内核 ⇒ 下一篇文章性地多一个 JVM
   * （内存与那句 120s 预算都是它的受害者，而红出来像"新那篇太慢"）。WI-93 记的是同一类"没人收尾"的账。
   */
  it('每篇教程的最后一个 code cell 必须 spark.stop()（导语那句承诺要有牙）', () => {
    for (const file of Object.keys(TUTORIAL_CLAIMS)) {
      const sources = codeCellSources(join(config.notebook.seedDir, file));
      expect(sources.length, `${file} 一个 code cell 都没有 ⇒ 它不可运行，marker 那两条也无从谈起（先确认文件名没写错）`).toBeGreaterThan(0);
      const last = sources[sources.length - 1]!;
      expect(
        last,
        `${file} 的最后一个 code cell 里没有 \`spark.stop()\`（它现在是：${JSON.stringify(last.slice(0, 80))}）⇒ ` +
          '教程导语那句"闸门跑完不留活内核"就成了假话，且容器档下一篇教程会多背一个活着的 Spark JVM（预算与内存都是它的账）。' +
          '改的是教程：把 stop 放回最后一个单元（`print("stopped")` 之类的收尾可以跟在它后面，但 stop 不许被删），不是删这条判据',
      ).toContain('spark.stop()');
    }
  });

  /** 参数形状（`allow_errors=True` 这一条尤其）。这一组在宿主就有牙，不必等一次真崩溃才知道解析器没跑。 */
  it('nbconvert 的参数形状：allow_errors=True / --stdout 必须在，timeout 由毫秒预算按秒推导', () => {
    const argv = nbconvertArgv('/tmp/whatever.ipynb');
    expect(argv[0], '第一个参数是子命令').toBe('nbconvert');
    // 少 `--ExecutePreprocessor.allow_errors=True` ⇒ cell 报错变成 throw，结构化证据（cell 号 + 异常名）一行都拿不到。
    expect(argv, '少了 allow_errors=True ⇒ 回到"cell 一报错整条路就 throw"那个已趟过的坑').toContain('--ExecutePreprocessor.allow_errors=True');
    // 少 `--stdout` ⇒ 执行后的 notebook 不落在这份 stdout 上 ⇒ 解析器读到的是空串/别的文本，errors 会说"不是 notebook JSON"。
    expect(argv, '少了 --stdout ⇒ executedNotebookEvidence 拿不到执行后的 notebook JSON').toContain('--stdout');
    expect(argv).toContain('--execute');
    expect(argv.slice(argv.indexOf('--to'), argv.indexOf('--to') + 2), '--to 的值必须是 notebook（默认 markdown 那份不是 JSON）').toEqual(['--to', 'notebook']);

    const timeoutFlags = argv.filter((a) => a.startsWith('--ExecutePreprocessor.timeout='));
    expect(timeoutFlags, 'nbconvert 的 cell 级超时必须给且只给一次（默认是 30s，Spark 冷启动会撞穿它）').toHaveLength(1);
    const seconds = Number(timeoutFlags[0]!.split('=')[1]);
    // 单位判据：nbclient 那层是**秒**。把 120（当成毫秒写的值）传进来会推导出 0 秒 ⇒ 每个 cell 立刻超时，
    // 症状长得像"教程坏了"。所以判"推导出的秒数落在合理区间"，而不是判那个字面量。
    expect(seconds >= 30 && seconds <= 600, `--ExecutePreprocessor.timeout 推导出来是 ${seconds} 秒，不在 30~600 之间 ⇒ 单位写错或 TUTORIAL_TIMEOUT_MS 的量级漂了（它是毫秒）`).toBe(true);
    expect(IT_TIMEOUT_MS, `vitest 那一层的预算（${IT_TIMEOUT_MS}）必须大于 execFileSync 的（${EXEC_TIMEOUT_MS}），否则先打死的是 vitest，报出来的是 "Test timed out"（说不到那句"先想超时"）`).toBeGreaterThan(EXEC_TIMEOUT_MS);
  });

  /**
   * **M2（评审）：`nbconvertCrashEvidence()` 自己的形状判据。**
   * 它过去只在崩溃路径执行 —— **绿跑永远碰不到它**，所以"它说的那句话对不对"这件事本身没人判过；
   * 抽成两档共用的公共件之后，一次漂移的爆炸半径翻倍（评审 M2）。判三件事：
   * ① **有界**：喂 10000 字节的 stderr（Spark 的真实日志实践上没有上界），消息不许跟着长；
   * ② **说得出超时**：消息里必须出现"预算"与 timeout/超时 —— 这是这条函数存在的意义，
   *    少了它，被 SIGTERM 杀掉的那种红就只剩"这一档跑不起来"三条不相干的猜测；
   * ③ **不许拿着别人的数字说话**：带 budget 的那次必须点出**本档**的 135s/120s、且**不出现** 180
   *    （180 是 `kernel.test.ts` 的预算；逐字搬运时它跟着搬进了公共件，于是教程超时会被报成隔壁文件的数字，
   *    把人引去查一个没跑过的实例 —— 评审 M2 抓的就是这一条）；不带 budget 的那次不许出现**任何**裸秒数点名。
   */
  it('nbconvertCrashEvidence 的形状：消息有界、枚举里必须有超时、预算由调用方给而不是写死', () => {
    const huge = 'x'.repeat(10_000);
    // 被 SIGTERM 杀掉（execFileSync 超时的形状：没有 code，killed=true）
    const killedMsg = nbconvertCrashEvidence({ killed: true, signal: 'SIGTERM', stdout: huge, stderr: huge }, { execTimeoutMs: EXEC_TIMEOUT_MS, cellTimeoutS: CELL_TIMEOUT_S });
    expect(killedMsg.length, `崩溃消息必须**有界**（实际 ${killedMsg.length} 字符）⇒ stderr 的搬运要有上限`).toBeLessThan(2_000);
    expect(killedMsg, '超时那一支要说得出"预算"，否则读报告的人只剩三条不相干的猜测').toContain('预算');
    expect(killedMsg, '超时那一支要说得出 timeout/超时').toMatch(/timeout|超时/);
    expect(killedMsg, 'killed=true 那一支不许照着"以 code=… 非 0 退出"那三条讲（那种情况下压根没有 exit code，照那段讲就是把人往 kernel 注册上赶）').not.toContain('以 code=');
    expect(killedMsg, `带 budget 的那次要点名**本档**的 execFileSync 预算（${Math.round(EXEC_TIMEOUT_MS / 1000)}s）`).toContain(`${Math.round(EXEC_TIMEOUT_MS / 1000)}s`);
    expect(killedMsg, `带 budget 的那次要点名**本档**的 cell 级超时（${CELL_TIMEOUT_S}s）`).toContain(`${CELL_TIMEOUT_S}s`);
    // ③ 这条是 M2 的本体：公共件里不许留着隔壁文件的预算。
    expect(killedMsg, '消息里不许出现 180（那是 kernel.test.ts 的 execFileSync 预算，本档根本没用它）').not.toMatch(/\b180\b/);

    // 不带 budget 的那一支（`kernel.test.ts` 就是这种调用形状）：仍然要有"预算到点"这一条，只是不许点名秒数。
    const unnamed = nbconvertCrashEvidence({ killed: true, signal: 'SIGTERM', stdout: huge, stderr: huge });
    expect(unnamed.length, `不点名那一支同样要有界（实际 ${unnamed.length} 字符）`).toBeLessThan(2_000);
    expect(unnamed, '不点名也要说得出"预算到点"这回事').toContain('预算');
    expect(unnamed, '公共件不许替调用方猜秒数（135/120 是本档的，180 是隔壁的，都不许写死在这里）').not.toMatch(/(135|120|180)s/);

    // 真的非 0 退出（有 code）那一支：枚举里必须仍然留着超时这一条，否则一次"重构掉那句提醒"就把最可能的坏法删了。
    const codeMsg = nbconvertCrashEvidence({ code: 1, stderr: huge }, { execTimeoutMs: EXEC_TIMEOUT_MS, cellTimeoutS: CELL_TIMEOUT_S });
    expect(codeMsg, '非 0 退出那一支的枚举里不许丢掉超时/预算这一条（它是最常见的那一种）').toContain('预算');
    expect(codeMsg, '有 code 时才许说"非 0 退出"').toContain('非 0 退出');
    expect(codeMsg.length, `非 0 退出那一支也要有界（实际 ${codeMsg.length} 字符）`).toBeLessThan(2_000);
  });

  /**
   * **门控本身**（形状照 `kernel.test.ts` 那组"容器档的门控本身"）：合取的每一半都要能各自红。
   * 本仓库的规矩：跳过要用 `skipIf`（报告会写 "N skipped"）而不是 `try/catch → return`，
   * 并且**另起一条永远会跑的断言**解释"为什么会是 skip"（见 `.qoder/rules/dev_verify_workflow.md` 第 3 条）。
   * 这里没有用"镜像级 kernel 文件在不在"当另一半 —— 那是 `kernel.test.ts` 已经判过的对象，
   * 在这儿再抄一遍那个绝对路径就成了第四处真相（布局的权威在 Dockerfile + notebook-image.test.ts）。
   * 这条闸门自己的另一半是**执行工具**：`nbconvert` 这个 CLI。规格 §6 那句
   * "Jupyter 不在时不许静默绿"判的就是它 —— 而且只有在注册表还是空表的时候才真正需要它：
   * 表空 ⇒ 容器那一组一条执行用例都不生成 ⇒ "Jupyter 根本不在"会表现为一整组安静地不跑。
   */
  it('标了服务身份的那台必须有 nbconvert（否则这一组会安静地什么都不判）', () => {
    expect(
      !NOTEBOOK_SERVICE || IN_CONTAINER,
      '设了 ARENA_NOTEBOOK_SERVICE=1 却没设 ARENA_IN_CONTAINER ⇒ 上面那一整组会在**本该跑它的地方**静默跳过' + '（compose 那一行的漂移由 notebook-compose.test.ts ⑦ 先红；这里判的是"这一档的进程环境里两半齐不齐"）',
    ).toBe(true);
    // 只在"自称服务实例"的那台才探（宿主探一次是白探，还可能被本机 Anaconda 的 PATH 骗过去）；
    // 探不到就是红 —— `||` 的右半为假才红，所以这里是 fail-closed，不是"探不到就算了"。
    const nbconvertAvailable = !NOTEBOOK_SERVICE || hasNbconvert();
    expect(
      nbconvertAvailable,
      `设了 ARENA_NOTEBOOK_SERVICE=1，这台就是该真跑教程的那一个实例，可「jupyter nbconvert --version」跑不通 ⇒ ` +
        '这一档的执行层与结论层都没有执行工具（镜像里没带 Jupyter / PATH 没接上）。' +
        '注册表还是空表时，容器那一组一条用例都不生成，这件事本来**完全静默** —— 红在这里就是它的意思',
    ).toBe(true);
  });
});

/** `jupyter nbconvert --version` 通不通（stderr 不进消息，只回布尔；消息里绝不带 subprocess 的原文）。 */
function hasNbconvert(): boolean {
  try {
    execFileSync('jupyter', ['nbconvert', '--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}
