import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
 * 阶段命令上的 `env` 前缀降级成装饰（同一课见 `kernel.test.ts:51`）。
 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';

/** `execFileSync` 的预算：nbconvert 自己的秒级超时之外再给一段收尾，否则两层的数字撞在一起分不出谁到点。 */
const EXEC_SLACK_MS = 15_000;
const EXEC_TIMEOUT_MS = TUTORIAL_TIMEOUT_MS + EXEC_SLACK_MS;
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
     * **必带**（`kernel.test.ts:392` 那段已经趟过一次）：不带的话 cell 一报错 nbclient 就抛、
     * nbconvert 退非 0、`execFileSync` 就地 throw ⇒ 下面那份"取 stdout 行与 error 条目"的解析
     * **一行都执行不到**，承诺的有界证据（cell 号 + 异常名）在最该出现的那一次缺席，
     * 报告里剩下的是 node 把整段 Spark stderr 拼进 message。
     */
    '--ExecutePreprocessor.allow_errors=True',
    // 单位是**秒**（nbclient 的 `ExecutePreprocessor.timeout` 按秒算），所以这里从毫秒预算推导；
    // "推导出来的是秒而不是毫秒"由常驻那条按量级判住（`120` 当成 ms 写会推导出 0 秒）。
    `--ExecutePreprocessor.timeout=${Math.floor(TUTORIAL_TIMEOUT_MS / 1000)}`,
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
   *  这一条把那种前提**说成前提**（`kernel.test.ts:351` 同一课）。
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
          throw new Error(nbconvertCrashEvidence(err));
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
    expect(smokes, `${config.notebook.seedDir} 里以 ${SMOKE_PREFIX} 开头的教程必须恰好是 ${SMOKE_FILE}（那一一篇由 kernel.test.ts 判）。` + `现在这张表是 ${JSON.stringify(smokes)} ⇒ 有人新写了一篇 00- 开头的教程，它不会被任何一道"可运行"闸门跑` + `；改名（01-/02-/03-）并在 tutorial-claims.ts 登记才是修法`).toEqual([SMOKE_FILE]);
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
      expect(file.includes('/'), `注册表的 key 只是文件名，不带目录：${file}`).toBe(false);
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
