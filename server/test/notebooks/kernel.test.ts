import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';
import { ensureIdeEnv, venvPythonPath } from '../../src/ide/env.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * Task 10：容器档「真跑」。
 *
 * Task 1 那条结构断言说的是「entrypoint 写了那行 PATH」；这里说的是「**它真的生效**」：
 * 用 kernel 的解释器把 smoke notebook 真跑一遍，cell 4 的 assert 必须成立。
 * 只有结构那条的话，PATH 前缀写错位置、或后面的 export 把它覆盖掉，都看不出来。
 *
 * **为什么门控写在文件里，而不是只写在 verify.sh 的阶段上**（评审 T10-1：计划文本的前提是假的）：
 * `scripts/verify.sh` 的「单元测试（shared + exec + regression + notebooks + server 根级）」那一条
 * 本来就把整个 `server/test/notebooks/` 扫进**宿主档**（`npm run verify:fast` 也走它）。
 * 所以「只在容器阶段点名这个文件」根本挡不住宿主跑它 —— 文件一放进这个目录宿主就会跑它，
 * 而宿主既没有 arena-pyspark 的 kernel 文件、也没有 jupyter CLI、更没有跑着的 Jupyter。
 * ⇒ 判据必须自己知道「现在在不在容器里」：容器那一组用 `describe.skipIf(!IN_CONTAINER)`
 *   （报告会写「N skipped」，「跳过」这件事看得见），另留一组**永远会跑**的解释断言，
 *   说出「为什么会跳过」并且两个方向都判得住（本仓库的规矩：`try/catch → return` 式的静默早退
 *   不算闸门，见 `.qoder/rules/dev_verify_workflow.md` 第 3 条与 `publish-identity.test.ts` 的先例）。
 *   常驻那条同时判两个方向：标了容器标记却没有 kernel 文件 ⇒ 红（镜像没按 Dockerfile 构建，
 *   或有人在宿主上手动设了这个变量）；有 kernel 文件却没标 ⇒ 红（这一档会在**本该跑它的地方**静默跳过）。
 */

/** kernel 落在镜像级目录（不是 venv 里）—— 见 Dockerfile 那条 COPY 与 notebook-image.test.ts。 */
const KERNEL_FILE = `/usr/local/share/jupyter/kernels/${NOTEBOOK_KERNELS.pyspark}/kernel.json`;
const TOKEN_KEY = 'ARENA_JUPYTER_TOKEN';
/** compose 的 arena / dev / tools 各设 `ARENA_IN_CONTAINER: "1"`；宿主永不设（宿主档靠它门控）。 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';

// ──────────────────────────── /proc 扫描（不用 pgrep，见下面那段注释） ────────────────────────────

interface Proc {
  pid: number;
  argv: string[];
}

/** `/proc/<pid>/cmdline` 是 NUL 分隔；内核线程与「刚扫完就退出」的进程都给空串。 */
function readArgv(pid: number, procDir = '/proc'): string[] {
  try {
    return readFileSync(`${procDir}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** 本 netns 里的进程清单。没有 /proc（Windows / macOS 宿主）就是空表 —— 那一档这组本来也不该跑。 */
function listProcs(procDir = '/proc'): Proc[] {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .map((n) => ({ pid: Number(n), argv: readArgv(Number(n), procDir) }))
    .filter((p) => p.argv.length > 0);
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * 「这个 argv 是不是 arena 那个 notebook 服务本体」。
 * **不用 `pgrep -f 'jupyter notebook'`**（评审 T10-2）：`pgrep -f` 扫的是完整命令行，
 * 而 `bash -c "pgrep -f 'jupyter notebook'"` 里那条 bash 自己的命令行**就写着这个 pattern** ⇒
 * 发起查询的进程会进候选名单，接着对它读 PATH，于是「PATH 前缀坏了」这种冤红随时会来。
 * 这里根本不经过 shell：自己读 /proc，再按 argv 的形状逐条分类，并且显式排掉自己。
 * 三个条件缺一不可：
 * ① 启动的是 `jupyter-notebook` 脚本 / `jupyter notebook` 子命令 / `python -m notebook` 那三种形状之一；
 * ② argv 里有 `--ServerApp.root_dir=` —— 它是 entrypoint 那一行的固定参数，且由
 *    `notebook-contract.test.ts` 钉住（改那一行的人会撞上那条闸门，不是悄悄失配）。
 *    这一条把 `jupyter-nbconvert`（本文件自己起的子进程，继承的是**测试**的 PATH）、
 *    `jupyter-kernelspec`、`jupyter-server` 这些「也挂在 jupyter 名下但不该被 PATH 判据管」的进程挡在门外；
 * ③ 不是自己（见 `jupyterServerPids` 的 selfPid）。
 * **认得的边界也写下来**：只认 exec 出来的真 argv。`bash -c "jupyter notebook ..."` 这种把整条命令
 * 塞进**一个** argv 元素的形状不被认作服务 —— 宁可红在「容器里没有正在跑的 jupyter ⇒ 前置条件不成立」
 * 那句（它说得出该去查什么），也不回到 `pgrep -f` 那种「把发起查询的进程自己也扫进来」的判据。
 * 下面「argv 分类器逐形状判住」那一组把这些判据喂给**假 /proc**，所以宿主上也是真判据；
 * 「是服务」的三种形状各一条，「像但不是」那一类每个条件至少一条反例 —— 删掉任意一个条件都会有一行翻脸
 * （实施时真的翻过脸：第一版少了 ② 的反例，把 `&& arenaServer` 整段删掉时 13 条一条都不红，是破坏性验证抓出来的）。
 */
function isJupyterServer(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const names = argv.map(baseName);
  const notebookScript = names.some((n) => /^jupyter[-_]notebook(\.exe)?$/.test(n));
  const notebookModule = argv.some((a, i) => a === '-m' && argv[i + 1] === 'notebook');
  const notebookSubcommand = names.some((n) => /^jupyter(\.exe)?$/.test(n)) && argv.includes('notebook');
  const arenaServer = argv.some((a) => a.startsWith('--ServerApp.root_dir='));
  return (notebookScript || notebookModule || notebookSubcommand) && arenaServer;
}

function jupyterServerPids(procs: Proc[], selfPid = process.pid): number[] {
  return procs.filter((p) => p.pid !== selfPid && isJupyterServer(p.argv)).map((p) => p.pid);
}

/**
 * 某个进程的 PATH。读不到（进程刚退出 / 没权限）给 null 让调用方说清是哪一个，不静默给空串 ——
 * 空串会被读成「PATH 首项不是 venv」，而那正是本条要判的形状，混进「读不到」就分不开两种故障了。
 */
function pathOfPid(pid: number, procDir = '/proc'): string | null {
  try {
    const entry = readFileSync(`${procDir}/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('PATH='));
    return entry === undefined ? null : entry.slice('PATH='.length);
  } catch {
    return null;
  }
}

/**
 * 把 argv 压成一句可以放进断言消息的话 —— **先把 token 遮掉**。
 * entrypoint 是按 `--ServerApp.token="${ARENA_JUPYTER_TOKEN}"` 传的，它就躺在服务进程的 argv 里；
 * 断言消息会进测试报告，报告会被复制粘贴。调试信息要够，凭据一个字都不许进去。
 */
function redactArgv(argv: string[]): string {
  return argv.map((a) => (a.startsWith('--ServerApp.token=') ? '--ServerApp.token=<REDACTED>' : a)).join(' ');
}

// ──────────────────────────── 容器档：真跑 ────────────────────────────

describe.skipIf(!IN_CONTAINER)('arena-pyspark kernel 在容器里真能起 Spark', () => {
  /** kernel 的解释器是**懒创建**的 venv，warehouse 目录由 entrypoint 建 —— 都是前置条件，不是被测物。 */
  let venvPrepareError: string | null = null;

  beforeAll(async () => {
    // 全新卷上 venv 还不存在，nbconvert 会挂在「解释器文件找不到」——
    // 症状长得像 kernel 坏了，其实是前置条件没满足。先建出来（幂等，同一处实现的锁在 env.ts 里）。
    const lang = findLanguage('python');
    expect(lang, '语言表里没有 python ⇒ 本文件的前置条件不成立').toBeTruthy();
    try {
      await ensureIdeEnv(lang!);
    } catch (err) {
      // 「建不出来」不在这里判红：它由下面那条「venv 的解释器真的在」判，并把原因一并说出来。
      // hook 里抛出去会把整组压成同一条错误信息（包括与本条无关的那几条），那是最难查的形状。
      venvPrepareError = err instanceof Error ? err.message : String(err);
    }
    // Spark 的 warehouse / Derby 的 system home：kernel.json 里是**绝对字面量**（kernelspec 是构建期
    // COPY 进镜像的静态文件），运行时只有 entrypoint 会建它们。没有 token 的实例（dev / e2e）压根不起
    // jupyter ⇒ 目录也就不存在，于是「全新卷上跑一次 notebook」会撞一个长得像 Spark 坏的 Derby 报错。
    // 与上面 venv 那条是同一类前置（T10 ↔ WI-87 那条裁决的延伸），所以在这里一起补齐。
    try {
      mkdirSync(join(config.notebook.warehouseDir, 'wh'), { recursive: true });
      mkdirSync(join(config.notebook.warehouseDir, 'derby'), { recursive: true });
    } catch {
      // 建不出来照样由 notebook 那条用例的报错说明（这里吞的是 mkdir，不是断言）。
    }
  }, 200_000);

  it('kernel 文件在镜像级目录', () => {
    expect(existsSync(KERNEL_FILE), `${KERNEL_FILE} 不存在 —— 本条只在容器里成立（宿主没有它）`).toBe(true);
  });

  it('venv 的解释器真的在（缺它就是「kernel 起不来」的假象来源）', () => {
    // 路径从 venvPythonPath() 派生，不在这里再拼一遍 `${dir}/python/bin/python`（T2-C 那条裁决：
    // 布局的权威是 server/src/ide/env.ts，测试里多一处字面量就多一处会漂移的真相）。
    const interpreter = venvPythonPath(config.ideEnvDir);
    expect(
      existsSync(interpreter),
      `${interpreter} 不存在 ⇒ ensureIdeEnv 没把 venv 建出来${venvPrepareError ? `，它报的是：${venvPrepareError}` : ''}` +
        '；kernel 的 argv[0] 指着它，缺了就是「kernel 起不来」的假象',
    ).toBe(true);
  });

  it('smoke notebook 跑完并打出 venv ok（证明解释器落在 IDE venv，Spark 起得来）', () => {
    const notebook = join(config.notebook.seedDir, '00-smoke-pyspark.ipynb');
    expect(existsSync(notebook), `${notebook} 不在 ⇒ content/ 那份只读挂载没进来，本条没有对象`).toBe(true);
    const out = execFileSync(
      'jupyter',
      ['nbconvert', '--to', 'notebook', '--execute', '--stdout', notebook],
      { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
    );
    expect(out).toContain('venv ok');
    expect(out).toMatch(/rows 15/); // cell 3 打的是 spark.range(6) 的 id **之和** = 0+1+2+3+4+5 = 15（行数会是 6 —— 评审 I-1 把两边对齐成同一个算式）
    expect(out).not.toMatch(/Traceback/);
  }, 200_000);

  /**
   * 这条才是「PATH 前缀真的生效」的行为证据，nbconvert 给不了它：
   * nbconvert 是**测试进程**自己起的子进程，继承的是测试的 env；而 Task 3 那条
   * `PATH=... jupyter notebook ...` 是命令前缀，只进 notebook 服务那个进程。
   * 于是「结构断言写了但没人守」的风险就在这里 —— 直接读那个活进程的 environ。
   * 内核起的所有 kernel 都从它 fork，所以 PATH 首项对了，`!pip3 install` 就落在 venv。
   */
  it('运行中的 jupyter 进程，PATH 的第一项就是 venv 的 python/bin', () => {
    const procs = listProcs();
    expect(procs.length, '读不到 /proc 里任何一个进程 ⇒ 本条没有判据对象（这里既然跑进来了，就应该是容器）').toBeGreaterThan(0);
    const pids = jupyterServerPids(procs);
    expect(
      pids.length,
      '容器里没有正在跑的 jupyter notebook ⇒ 前置条件不成立（Task 3/4 没落地，或这个实例没被给予 token：' +
        'dev / e2e 按设计不透传 token 所以本来就没有，容器档要打在 ./start.sh --verify 起的那个 arena 容器里）',
    ).toBeGreaterThan(0);
    const expectedFirst = dirname(venvPythonPath(config.ideEnvDir));
    for (const pid of pids) {
      // 消息里只放 pid 与 PATH，不放 argv：argv 里躺着 --ServerApp.token=（见 redactArgv 那段）。
      const raw = pathOfPid(pid);
      expect(raw !== null, `pid ${pid} 的 /proc/<pid>/environ 读不到（进程刚退出？权限？）⇒ 判不了它的 PATH`).toBe(true);
      const first = (raw ?? '').split(':')[0] ?? '';
      expect(
        first.replace(/\/+$/, ''),
        `pid ${pid} 的 PATH 首项不是 IDE venv（实际首项「${first}」，期望「${expectedFirst}」）` +
          '⇒ entrypoint 那句 `PATH=... jupyter notebook` 前缀没生效或被后面的 export 覆盖了' +
          '——症状是 notebook 里 `!pip3 install` 装进系统解释器（=判题那套），而界面一片绿',
      ).toBe(expectedFirst);
    }
  });

  /**
   * 评审 T10-3 ①：Task 7 那句「这个实例没被给予 token，是按设计」的分支全靠
   * **键在不在**（`status.ts` 的 `missingTokenReason()`），而此前它只有 compose 插值那行的推断撑着。
   * 这里把它变成闸门：arena 容器里这个键必须存在（值可以是空的 —— 「接上了但从没生成」也是它该说的另一句话）。
   */
  it('容器里 ARENA_JUPYTER_TOKEN 这个**键**存在（只判形状，绝不回显值）', () => {
    // 值可能是真的凭据：断言一律走布尔，消息里不插值 —— vitest 失败时打印的是 true/false，不是它。
    expect(TOKEN_KEY in process.env, `${TOKEN_KEY} 这个键不在容器进程环境里 ⇒ compose 那一行透传被删了；` +
      '而 status.ts 的 missingTokenReason() 会因此从「token 从没生成（有得修）」漂成「这个实例按设计不参与 notebook」' +
      '（dev / e2e 那一支）——症状是要人去修没坏的东西，或不去修坏了的东西').toBe(true);
    const value = process.env[TOKEN_KEY] ?? '';
    expect(
      value === '' || !/\s/.test(value),
      `${TOKEN_KEY} 里含空白/换行 ⇒ entrypoint 的 --ServerApp.token="..." 与拼进 URL query 的那一份会各自被截断（值本身不打出来）`,
    ).toBe(true);
  });

  /**
   * 评审 T10-3 ②：网关那一半的**前提** —— 容器 netns 里 `/proc/net/route` 真能解出默认网关。
   * 宿主上那条正向用例（`status.test.ts`）靠的是注入的那份网关表；解析真路由表这一路在 Docker
   * 起来之前从没被真执行过。它坏掉的形状不是报错，是**静默降级成只认回环**：容器里看到的对端
   * 永远是网桥网关（172.18.0.1 那一类），于是本机点开也拿不到 token ⇒ 点开就是 Jupyter 登录页，
   * 而页面一片绿（status.ts 顶部那段注释写的正是这一类）。
   */
  it('容器 netns 里读得出默认网关 ⇒「对端 == 我自己的网关」那条判据有真路由表撑着', async () => {
    // 缝：`localGatewayAddresses()` 的缓存是模块级私有变量（gatewayOnce），没有导出的清理口子。
    // 与其为测试改生产代码的可见性，不如按本仓库既有的做法拿一份**新模块实例**
    // （`status.test.ts` 处理 publicUrl 漂移用的是同一个缝），保证读进来的是这一趟真的 /proc/net/route。
    vi.resetModules();
    const { localGatewayAddresses } = await import('../../src/notebooks/status.js');
    const gateways = localGatewayAddresses();
    expect(
      gateways.length,
      '/proc/net/route 解不出默认网关 ⇒ isLocalPeer() 的网关那一半静默失效，容器里的本机点开永远拿不到 token' +
        '（要么这张表没有默认路由，要么解析对不上内核的列序/小端十六进制）',
    ).toBeGreaterThan(0);
    for (const gw of gateways) {
      expect(/^(\d{1,3}\.){3}\d{1,3}$/.test(gw), `解出来的「网关」不是点分十进制 IPv4：${gw}`).toBe(true);
      expect(gw !== '0.0.0.0', '网关是 0.0.0.0 ⇒ parseProcNetRoute 那条「直连默认路由没有网关」的 fail-closed 被绕过了').toBe(true);
    }
  });
});

// ──────────────────────────── 常驻：宿主档也要跑的那一组 ────────────────────────────

describe('容器档的门控本身（常驻，宿主也跑）', () => {
  /**
   * 「为什么上面那组没跑」必须有人管，而且两个方向都判得住（同 `publish-identity.test.ts` 的形状）：
   * 这条在宿主上判的是「没标记 ⇒ 这里确实没有 kernel 文件」，在容器里判的是「标了 ⇒ 镜像真是按
   * Dockerfile 建的那个」，在「有人在容器外手动设了变量」时判的是「那是假前提」。
   */
  it('容器标记与 kernel 文件必须同时成立 / 同时不成立', () => {
    const hasKernel = existsSync(KERNEL_FILE);
    expect(
      IN_CONTAINER,
      hasKernel
        ? `这台机器上有 ${KERNEL_FILE}，却没设 ARENA_IN_CONTAINER=1 ⇒ 上面那一整组会在**本该跑它的地方**静默跳过` +
          '（compose 里那三行 env 漂移了，或验证跑在了一个没被标记的容器里）'
        : `标了 ARENA_IN_CONTAINER=1 却没有 ${KERNEL_FILE} ⇒ 要么镜像没按 Dockerfile 构建（该 ./start.sh --rebuild），` +
          '要么这台根本不是容器（宿主机上手动设了这个变量 —— 容器档的门控不能这么试）',
    ).toBe(hasKernel);
  });

  /**
   * 判据的判据：分类器逐形状判住，**包括评审 T10-2 那个自我命中的形状**。
   * 这一组在宿主上也是真判据 —— 它不需要 Jupyter，喂的是假 /proc 的 argv 表，
   * 所以「Docker 没起」不会让它变成装饰。
   */
  const FIXTURES: Array<{ name: string; argv: string[]; want: boolean }> = [
    {
      name: 'entrypoint 起的真服务（jupyter 已 exec 成 jupyter-notebook 脚本）',
      argv: [
        '/usr/local/bin/python3.11',
        '/usr/local/bin/jupyter-notebook',
        '--allow-root',
        '--no-browser',
        '--ServerApp.ip=127.0.0.1',
        '--ServerApp.port=8888',
        '--ServerApp.port_retries=0',
        '--ServerApp.token=abc123',
        '--ServerApp.root_dir=/app/data/notebooks',
      ],
      want: true,
    },
    { name: '尚未 exec 的 launcher 形状 `jupyter notebook ...`', argv: ['/usr/local/bin/jupyter', 'notebook', '--allow-root', '--ServerApp.root_dir=/app/data/notebooks'], want: true },
    { name: '同一家族的另一种写法 `python -m notebook`', argv: ['/opt/arena-ide-env/python/bin/python', '-m', 'notebook', '--ServerApp.root_dir=/app/data/notebooks'], want: true },
    // 下面三条是「①成立但②不成立」那一类：三种"确实是 jupyter notebook 起来了、但不是 entrypoint 那个服务"的形状。
    // 它们必须判 false —— 否则 PATH 那条判据会把"某人随手在 shell 里起的 / 只问了一下版本的"
    // 也算成服务，而那些进程的 PATH 本来就不该是 venv（冤红，且症状与"前缀真的坏了"一模一样）。
    { name: '人手敲的 `jupyter-notebook --version`（问版本，不是服务）', argv: ['/usr/local/bin/python3.11', '/usr/local/bin/jupyter-notebook', '--version'], want: false },
    { name: '人手敲的 `jupyter notebook`（没有 root_dir ⇒ 不是 entrypoint 起的那个）', argv: ['/usr/local/bin/jupyter', 'notebook', '--no-browser'], want: false },
    { name: '`python -m notebook` 但没带 root_dir（同上，不是那个服务）', argv: ['/usr/local/bin/python3.11', '-m', 'notebook', '--ServerApp.port=9999'], want: false },
    { name: '发起查询的 bash -c（命令行里就写着 pattern）⇒ 绝不能进候选', argv: ['/usr/bin/bash', '-c', "pgrep -f 'jupyter notebook' || true"], want: false },
    { name: 'pgrep 进程本身', argv: ['pgrep', '-f', 'jupyter notebook'], want: false },
    { name: '本文件自己起的 jupyter-nbconvert（继承的是测试的 PATH）', argv: ['/usr/local/bin/python3.11', '/usr/local/bin/jupyter-nbconvert', '--to', 'notebook', '--execute', '--stdout', '/app/content/notebooks/00-smoke-pyspark.ipynb'], want: false },
    { name: 'jupyter-kernelspec list（构建期自检那条）', argv: ['/usr/local/bin/python3.11', '/usr/local/bin/jupyter-kernelspec', 'list'], want: false },
    { name: 'jupyter-server（不是 notebook 子命令）', argv: ['/usr/local/bin/jupyter-server', '--ServerApp.root_dir=/app/data/notebooks', '--port=8888'], want: false },
    { name: '从服务 fork 出来的内核 ipykernel_launcher', argv: ['/opt/arena-ide-env/python/bin/python', '-m', 'ipykernel_launcher', '-f', '/tmp/kernel-1234.json'], want: false },
    { name: '文件名里恰好含 pattern 的编辑器', argv: ['/usr/local/bin/vim', '/app/data/notebooks/jupyter notebook.ipynb'], want: false },
    { name: 'argv 是空的进程（内核线程 / 刚退出）', argv: [], want: false },
  ];

  for (const fix of FIXTURES) {
    it(`argv 分类器：${fix.name}`, () => {
      expect(isJupyterServer(fix.argv), `分类结果与期望不符，argv=${redactArgv(fix.argv)}`).toBe(fix.want);
    });
  }

  /**
   * 候选名单那一半：分类器判"是不是服务"，`jupyterServerPids` 还得把**自己**摘掉（评审 T10-2 的正题）。
   * 这里喂的假表故意把"与本进程 pid 相同、argv 完全像服务"那一条放进去 ——
   * 结果必须只剩那两条真服务，摘不干净就是 pgrep 那个自我命中的形状换了个实现重演一遍。
   * 另两条是"也带着 jupyter 字样但不该进候选"的噪声（被扫的那条 bash -c 与 pgrep 自己）。
   */
  it('候选名单：服务留在表里，pgrep 那类噪声与自己被摘掉', () => {
    const serverArgv = ['/usr/local/bin/python3.11', '/usr/local/bin/jupyter-notebook', '--ServerApp.root_dir=/app/data/notebooks'];
    const launcherArgv = ['/usr/local/bin/jupyter', 'notebook', '--ServerApp.root_dir=/app/data/notebooks'];
    const noisyBash = ['/usr/bin/bash', '-c', "pgrep -f 'jupyter notebook' || true"];
    // 假 pid 从**本进程的 pid** 派生：写死 12345 那一类数字在 Windows / Git Bash 上真可能撞上某个
    // 活着的 pid（本项目的老毛病：会周期性冤红的闸门教人的是"重跑一次"，不是"这里真坏了"）。
    const pidA = process.pid + 1;
    const pidB = process.pid + 2;
    const pidC = process.pid + 3;
    const pidD = process.pid + 4;
    const procs: Proc[] = [
      { pid: 1, argv: ['/sbin/init'] },
      { pid: pidA, argv: serverArgv },
      { pid: pidB, argv: launcherArgv },
      { pid: process.pid, argv: serverArgv }, // "自己长得和服务一模一样"这一类必须靠 pid 摘掉，不靠运气
      { pid: pidC, argv: noisyBash },
      { pid: pidD, argv: ['pgrep', '-f', 'jupyter notebook'] },
    ];
    expect(jupyterServerPids(procs, process.pid), '候选名单与期望不符').toEqual([pidA, pidB]);
    // 反向对照（本仓库的规矩：光"两边都没匹配"看起来也像成功）：整张表里没有服务时必须是空表，
    // 而上面那条如果因为某个条件被删掉而把噪声收进来，就已经在这里翻脸了。
    expect(jupyterServerPids([{ pid: pidC, argv: noisyBash }], process.pid), 'pgrep 那条 bash -c 被收进候选了').toEqual([]);
  });

  /**
   * 读的那一半（`listProcs` / `pathOfPid`）也判在宿主上：容器档那条 PATH 断言的全部 plumbing 就是
   * 「NUL 分隔的 cmdline」「NUL 分隔的 environ 里挑 PATH=」「读不到要给 null」这三件事，
   * 而 Docker 没起的这一档唯一能判住它们的机会就是喂一棵**假 /proc 树**（同 `status.test.ts`
   * 拿真实表文本喂 `parseProcNetRoute` 的做法）。
   * 不这么做的话，"容器里那条永远只能到容器里才知道对不对"——而它的报错形状（PATH 首项不对）
   * 与"我读错了分隔符"长得一模一样。
   */
  it('假 /proc 树：cmdline 与 environ 的读法判得住，读不到要给 null（不是给空串）', () => {
    const dir = join(tmpdir(), `arena-fake-proc-${process.pid}-${Date.now()}`);
    const put = (pid: number, file: string, entries: string[]) => {
      mkdirSync(join(dir, String(pid)), { recursive: true });
      writeFileSync(join(dir, String(pid), file), entries.join('\0'), 'utf8');
    };
    try {
      // 目录名同样从 process.pid 派生（同上面那条的理由：写死的假 pid 撞上活 pid 就是一条偶发冤红）
      const pidServer = process.pid + 1;
      const pidEmpty = process.pid + 2;
      const pidNoEnviron = process.pid + 3;
      put(pidServer, 'cmdline', ['/usr/local/bin/python3.11', '/usr/local/bin/jupyter-notebook', '--ServerApp.root_dir=/app/data/notebooks', '--ServerApp.token=abc', '']);
      put(pidServer, 'environ', ['HOME=/root', 'PATH=/opt/arena-ide-env/python/bin:/usr/local/bin:/usr/bin', 'LANG=C']);
      put(pidEmpty, 'cmdline', ['', '']); // 空 cmdline（内核线程 / 刚退出那一类）
      put(pidNoEnviron, 'cmdline', ['pgrep', '-f', 'jupyter notebook']); // 有 cmdline、没有 environ
      mkdirSync(join(dir, 'not-a-pid'), { recursive: true }); // 目录名不是数字 ⇒ 不该被当成进程

      const procs = listProcs(dir);
      expect(procs.map((p) => p.pid).sort((a, b) => a - b), '假 /proc 的进程表读出来不对（分隔符或过滤）').toEqual([pidServer, pidNoEnviron]);
      expect(jupyterServerPids(procs, process.pid), '从这棵树里挑出来的服务应当只有那一个').toEqual([pidServer]);
      expect(pathOfPid(pidServer, dir)).toBe('/opt/arena-ide-env/python/bin:/usr/local/bin:/usr/bin');
      expect(pathOfPid(pidNoEnviron, dir), '读不到 environ 要给 null：给空串会被读成"PATH 首项不是 venv"，两种故障就分开了').toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 真 /proc 上跑一遍同一个发现函数（评审 T10-2 要求的「宿主侧自检」）：
   * **发起查询的进程永远不许出现在结果里**。宿主上没有 /proc ⇒ 结果是空表，这条同样成立；
   * 在 Linux 宿主（没起容器、但 Node 看得见 /proc）上它扫的是真进程表，判据一样。
   */
  it('真 /proc 发现：结果里不含本进程，且每个命中者都像服务', () => {
    const procs = listProcs();
    const found = jupyterServerPids(procs, process.pid);
    expect(found, `发现结果里出现了本进程 pid ${process.pid} ⇒ 判据会把自己当成 jupyter 服务，PATH 那条必红`).not.toContain(process.pid);
    for (const pid of found) {
      const argv = procs.find((p) => p.pid === pid)?.argv ?? [];
      // 服务本体必然带 root_dir（分类器的第二个条件），这里再独立判一次：判据与分类器不一致时先在这里红。
      expect(argv.some((a) => a.startsWith('--ServerApp.root_dir=')), `pid ${pid} 被认成 jupyter 服务，但 argv 里没有 root_dir：${redactArgv(argv)}`).toBe(true);
    }
  });
});
