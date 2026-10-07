import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
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
 * ⇒ 判据必须自己知道「现在在不在该跑它的那个容器里」：容器那一组用
 *   `describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)`（**合取**，评审 I-2；报告会写「N skipped」，
 *   「跳过」这件事看得见），另留一组**永远会跑**的解释断言，
 *   说出「为什么会跳过」并且两个方向都判得住（本仓库的规矩：`try/catch → return` 式的静默早退
 *   不算闸门，见 `.qoder/rules/dev_verify_workflow.md` 第 3 条与 `publish-identity.test.ts` 的先例）。
 *
 * **为什么是合取，不是单看 `ARENA_IN_CONTAINER`**（评审 I-2 采纳自复核者，且覆盖上一轮的裁决）：
 * compose 给 arena / dev / tools 三台都标了「这是容器」，而 `tools` 是这仓库**写在文档里的验证机位**
 * （compose.yml 那段 + start.sh 记的「在 tools 里跑曾经静默跳掉 mysql/redis 判题」），
 * 人在里面 `npm run verify` 是既成行为不是假设。可它没有 `ARENA_IDE_ENV_DIR`（只有 arena/dev/e2e 三处有）
 * ⇒ `config.ideEnvDir` 退回 `dataDir/ide-env` = Windows 的 bind mount（compose.yml 自己记的 87.2s vs 1.76s）
 * ⇒ 下面那个 `beforeAll` 会先在真人的 `data/` 上试建 venv、再撞穿 200s 预算，报出来的是「venv 创建失败」，
 * 而真正的毛病是「跑错了服务」——一条错认对象的红比一条不跑更贵。
 * 分辨服务身份**不能**用「`/proc` 里有没有带 `--ServerApp.root_dir=` 的进程」：那正是下面那条 PATH 判据要
 * **找**的东西，拿它当门控 = 自我循环（它永远不会红，也证明不了任何事）。所以用 compose 给的第二个标记
 * `ARENA_NOTEBOOK_SERVICE`，分布由 `notebook-compose.test.ts` ⑦ 钉（只给 arena）。
 * 常驻那两条（下面「门控本身」那一组）判的是合取的两半各自能不能圆不上：
 * 标了服务身份却没有 kernel 文件 ⇒ 红（镜像没按 Dockerfile 构建）；
 * kernel 文件在场却连容器标记都没有 ⇒ 红（那一整组会在**本该跑它的地方**静默跳过）。
 * dev / tools（容器标记有、服务标记没有）两条都不许红 —— 那正是 I-2 要的形状。
 */

/** kernel 落在镜像级目录（不是 venv 里）—— 见 Dockerfile 那条 COPY 与 notebook-image.test.ts。 */
const KERNEL_FILE = `/usr/local/share/jupyter/kernels/${NOTEBOOK_KERNELS.pyspark}/kernel.json`;
const TOKEN_KEY = 'ARENA_JUPYTER_TOKEN';
/**
 * ⚠ 这两个标识符的**大小写是承重的**（评审 I-4）：`verify-coverage.test.ts` 的 `gateVars()` 用
 * `\b([A-Z][A-Z0-9_]{2,})\b` 从 `skipIf(...)` 的条件回指 `const` 声明，再从中取 `process.env.X`。
 * 把它们改成计划里的小写 `inContainer` / `notebookService`，`gateVars()` 就解不出变量名 ⇒
 * 这个文件从「孤儿检查」里静默退出、阶段命令上的 `env` 前缀降级成装饰、
 * 容器那一组可以永远不再跑而**零条红** —— 正是本仓库记过的「闸门一直是装饰」那一类。
 * （`gateVars()` 本身不动：把它扩到 camelCase 是对共享闸门的分支级改动，控制器已记入终审台账。）
 */
/** compose 的 arena / dev / tools 各设 `ARENA_IN_CONTAINER: "1"`；宿主永不设（宿主档靠它门控）。 */
const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
/** compose **只给 arena** 设 `ARENA_NOTEBOOK_SERVICE: "1"`（服务身份，见上面那段与 notebook-compose ⑦）。 */
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';
/** 有没有真 `/proc` 可读：Windows / macOS 宿主没有。下面那条「真 /proc 发现」靠它显式 skip（评审 I-3）。 */
const HAS_PROC = existsSync('/proc');


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

/** nbconvert 那份输出里，断言消息最多可以带走这么多字符（评审 minor：别把 32MB 打进报告）。 */
const EVIDENCE_CAP = 400;

/**
 * 从 `jupyter nbconvert --to notebook --execute --stdout` 的输出里只取**两样**：
 * cell 打到 stdout 的那些行，和出错 cell 的异常名。
 * 那份输出是「执行后的整本 notebook」（JSON，里面还有富输出／base64），`maxBuffer` 给到 32MB ——
 * 断言直接压在整串上时，一次失败会把整个 JSON 抄进测试报告（评审 I-4/minor：
 * 「`expect(out).toContain('venv ok')` 失败时会 dump 整本 notebook」）。
 * notebook 的导语对用户承诺的就三行（`python …` / `rows 15` / `venv ok`），判据压在那几行上，
 * 结论一样强（少一行照样红），报告里能读。
 * 解析不出 JSON 时给的是**截断后**的原文，不是全文 —— 「看不懂它输出了什么」也要看得见，但不能拿 32MB 换。
 * 形状判据在常驻那一组（`假 executed-notebook JSON`），所以这条 plumbing 在宿主上就有牙，
 * 不必等容器（容器里那次真跑只是它的一个用例）。
 */
function executedNotebookEvidence(raw: string): { stdout: string[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stdout: [], errors: [`输出不是 notebook JSON：${raw.slice(0, EVIDENCE_CAP)}`] };
  }
  const cells = (parsed as { cells?: unknown })?.cells;
  if (!Array.isArray(cells)) return { stdout: [], errors: [`notebook JSON 里没有 cells 数组：${raw.slice(0, EVIDENCE_CAP)}`] };
  const stdout: string[] = [];
  const errors: string[] = [];
  cells.forEach((cell, i) => {
    const outputs = (cell as { outputs?: unknown })?.outputs;
    if (!Array.isArray(outputs)) return;
    for (const entry of outputs) {
      const o = entry as { output_type?: string; name?: string; text?: string | string[]; ename?: string };
      if (o.output_type === 'stream' && o.name === 'stdout') {
        // `text` 按 nbformat 可以是「一整块字符串」也可以是「一行一个元素的数组」，两种都要收。
        const text = Array.isArray(o.text) ? o.text.join('') : (o.text ?? '');
        stdout.push(...text.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
      } else if (o.output_type === 'error') {
        // 只留 cell 号与异常名：traceback 正文可以任意长，它进报告就等于没进。
        errors.push(`cell ${i}: ${o.ename ?? '(没有 ename)'}`);
      }
    }
  });
  return { stdout, errors };
}

// ──────────────────── DNAT 目标探测（"发布端口打不到 loopback 监听"的判据） ────────────────────

/** 一次探测的等待上限：同一个 bridge 网络里的往返是毫秒级；超过这个值就按"没人听"处理。 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 本容器 netns 里的**非回环 IPv4**（eth0 那一类）—— 那正是发布端口被 DNAT 过去的目标地址。
 *
 * **为什么选 `os.networkInterfaces()` 而不是 `hostname -i`，也不用解析 `/proc/net/fib`**
 * （裁决 R2 要我说清选的是哪个、为什么）：
 * ① `hostname -i` 走的是 hostname 解析（/etc/hosts + resolver）。镜像里 hostname 一旦被写成解析到
 *    127.0.0.1（`--add-host`、`network_mode: host`、某些 base 镜像的 hosts 行都会），它给的就是**回环** ——
 *    于是"判据自己先坏"，而且坏的形状与它要判的那个 bug 一模一样（看起来像在回环上就通了）。
 * ② `/proc/net/fib*` 要解析内核的十六进制路由/前缀树，列序与格式随内核版本漂；本文件读 /proc
 *    是因为进程 PATH **只有**那里一个来源，而接口表有正经 API，没理由换更脆的那条路。
 * ③ `networkInterfaces()` 直接来自这个 netns，并用 `internal` 把回环单独标出来 ⇒
 *    "只听回环"与"根本没起来"能各说各话 —— 而这两种故障正是下面两条探测要分开的东西。
 */
function nonLoopbackIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/**
 * 探一次 HTTP。**只区分两种结果**，因为这个缺陷的判据就是这一刀：
 * `{status}` ⇒ 有人在听（200/302/403 都算 —— 302 是"要 token"，403 可能是 jupyter 的 Host 守卫，
 * 两种都是"端口上有 jupyter 应答"，与"连不上"是完全不同的故障）；
 * `{error}` ⇒ 没人听（ECONNREFUSED / 超时 / DNS 形状错误）。
 * 故意**不带 token**：带 token 就要把凭据拼进 URL、拼进错误消息，而这里判的是"有没有人在听"。
 * （`start.sh` 的 `report_notebook` 用的是同一个判据形状：只看有没有 HTTP 应答，不判语义。）
 */
async function probeHttp(url: string): Promise<{ status: number } | { error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return { status: res.status };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const cause = e.cause?.code ?? e.cause?.message ?? '';
    return { error: [`${e.name ?? 'Error'}: ${e.message ?? String(err)}`, cause].filter(Boolean).join(' / ') };
  }
}

/** 探测结果的一行可读证据（失败消息靠它把"两种故障"分开说）。 */
const probeLine = (url: string, r: { status: number } | { error: string }): string =>
  `${url} ⇒ ${'status' in r ? `HTTP ${r.status}（有人在听）` : `没有 HTTP 应答（${r.error}）`}`;

// ──────────────────────────── 容器档：真跑 ────────────────────────────

/**
 * 门控是**合取**（评审 I-2）：`ARENA_IN_CONTAINER` 说的是「这是容器」（arena / dev / tools 都是），
 * `ARENA_NOTEBOOK_SERVICE` 说的才是「这就是那个跑着 notebook 服务的实例」（compose 只给 arena）。
 * 少一条都会让这一组在**没有那些前置条件的服务**里跑起来，而两台的坏法不同（compose 的 arena 块各写了一遍）：
 * tools 连 `ARENA_IDE_ENV_DIR` 都没有（那三处 = arena / dev / e2e）⇒ 下面那个 `beforeAll` 会先在
 * `./data`（bind mount，87.2s vs 1.76s）上试建 venv，报出来的是「venv 创建失败」而毛病是「跑错了服务」；
 * dev 有卷、用的也是 arena 那个镜像（kernel 文件在），但它按 notebook-compose ⑥ 拿不到 token
 * ⇒ 没有跑着的 jupyter ⇒ PATH / token 键 / 路由表那三条红在「错服务」上。
 * 两个条件都不成立时这一组整片 skip，报告写出「N skipped」，常驻那两条解释为什么。
 */
describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)('arena-pyspark kernel 在容器里真能起 Spark', () => {
  /** kernel 的解释器是**懒创建**的 venv，warehouse 目录由 entrypoint 建 —— 都是前置条件，不是被测物。 */
  let venvPrepareError: string | null = null;

  /**
   * ⚠ 重复 round-1 §2.2 那种「宿主强行带标记」的形状证明时，两个变量都要指到临时目录，**不只 IDE**：
   * `ARENA_IDE_ENV_DIR=<临时>` 之外还要 `ARENA_DATA_DIR=<临时>` —— 这个 `beforeAll` 在任何前置检查
   * **之前**就会建 `notebook-warehouse/{wh,derby}`（评审 minor），只换 IDE 目录的那次 demo
   * 已经把两个空目录写进了真人的 `data/`。它们本身无害（entrypoint 也会建），但「为了试闸门脏一次数据目录」
   * 是本仓库不想要的形状（E2E 的隔离纪律同理）。
   */
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
    const raw = execFileSync(
      'jupyter',
      ['nbconvert', '--to', 'notebook', '--execute', '--stdout', notebook],
      { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
    );
    // 断言压在「notebook 导语承诺的那三行」上，不压在整本执行后 notebook 上（见 executedNotebookEvidence 那段）：
    // 少任何一行照样红，而失败消息只带那几行，不带 32MB。
    const { stdout, errors } = executedNotebookEvidence(raw);
    expect(errors, `执行时抛异常的 cell（只有 cell 号与异常名，不带 traceback 正文）：${errors.join(' / ')}`).toEqual([]);
    const shown = JSON.stringify(stdout);
    expect(stdout, `少「venv ok」⇒ 红线①那条 assert 没成立（解释器不在 IDE venv 里），实际 stdout 行：${shown}`).toContain('venv ok');
    // rows 15 = spark.range(6) 的 id **之和** 0+1+2+3+4+5（行数会是 6 —— 评审 I-1 把两边对齐成同一个算式）
    expect(stdout, `少「rows 15」⇒ Spark 那次聚合没真跑（15 是 range(6) 的 id 之和，不是行数 6），实际 stdout 行：${shown}`).toContain('rows 15');
    const pythonLine = stdout.filter((l) => l.startsWith('python '));
    expect(pythonLine, `「python <解释器>」应当恰好一条（cell 2 打的是 sys.executable），实际：${JSON.stringify(pythonLine)}`).toHaveLength(1);
    // 旧写法是 `expect(out).not.toMatch(/Traceback/)`（扫整本 JSON）。这条把它收进"小集合"里：
    // stdout 不许出现 Traceback 字样，判据强度不丢，但失败消息只带那几行。
    // 真出异常时走的是上面那条 errors（nbformat 把它落成 output_type=error），这条兜的是"异常被当成文本打出来"。
    expect(stdout.filter((l) => l.includes('Traceback')), `stdout 里出现了 Traceback 字样：${shown}`).toEqual([]);
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
  it('容器里 ARENA_JUPYTER_TOKEN 这个键存在（只判形状，绝不回显值）', () => {
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

  /**
   * 这两条是「从宿主 / 浏览器点进去」那一侧在容器档里的唯一代表（裁决 R2：要一条**会红的**闸门，
   * 不要一条横幅）。为什么横幅不算：`start.sh` 的 `report_notebook` 探到 7789 没应答只打印一行就
   * `return 0` ⇒ 「./start.sh --verify 通过」与「用户的链接是死的」可以同时成立，而且这次**确实同时成立了**。
   *
   * 缺陷本体（实测，不是推理）：发布的端口是 **DNAT 到容器的 eth0 地址**，不是它的回环。
   * 于是 `--ServerApp.ip=127.0.0.1` 这种写法在容器里怎么 curl 都通、宿主上 `127.0.0.1:7789` 永远 `000`。
   * 本仓库的容器档**全部走回环**（status.ts 探的也是 `http://127.0.0.1:8888`），
   * 所以那一整档全绿的时候功能其实是打不开的 ⇒ 只有「非回环地址上有没有人在听」这一判才拦得住。
   * 两条各判一件事，缺一条都会把故障说错：
   * ① 回环有人在听 ⇒ 「jupyter 起来了」（这条在缺陷当时是**绿的**，它没坏，它是证据）；
   * ② DNAT 目标有人在听 ⇒ 「发布端口打得到」（这条当时是**红的**，它才是闸门）。
   */
  it('容器回环上有 jupyter 在听（证明服务起来了 —— 这一条不是那个缺陷，它是对照）', async () => {
    const url = `http://127.0.0.1:${config.notebook.port}/tree`;
    const res = await probeHttp(url);
    expect('status' in res, `${probeLine(url, res)} ⇒ 容器里连回环都不应答：jupyter 压根没起来（缺 token / 镜像没带 Jupyter / 端口被占），与本条要对照的那个「绑定地址」缺陷无关`).toBe(true);
  });

  it('发布端口的 DNAT 目标（容器自己的非回环 IPv4）上也必须有人在听（只听容器 loopback ⇒ 宿主 7789 打不到）', async () => {
    const addrs = nonLoopbackIpv4Addresses();
    expect(
      addrs.length,
      '这个 netns 里没有任何非回环 IPv4 接口 ⇒ 本条没有判据对象。arena 容器按 compose 的网络配置应该有一条 eth0（172.18.0.x）；' +
        '真一个都没有说明它跑在 host/无网络模式下，那「发布端口」这个前提本身就不成立了（先修这条判据的适用范围，别删断言）',
    ).toBeGreaterThan(0);
    // 回环那一侧同时探一次，只为把失败消息写成「一边通一边不通」——那才是这个缺陷的指纹。
    // 它的正题判据在上面那条（对照）。
    const loopback = `http://127.0.0.1:${config.notebook.port}/tree`;
    const loopbackRes = await probeHttp(loopback);
    for (const addr of addrs) {
      const url = `http://${addr}:${config.notebook.port}/tree`;
      const res = await probeHttp(url);
      // 两种故障要说两种话（本文件的规矩：报错得说得出该去查什么）：
      // 回环通而这里不通 = 绑定地址坏了；两边都不通 = jupyter 压根没起来，这条判据在这里还没有对象。
      const verdict =
        'status' in loopbackRes
          ? '⇒ **容器里监听在 loopback ⇒ 发布端口打不到**：compose 把 127.0.0.1:7789:8888 DNAT 到容器的 ' +
            `${addr}（不是它的 127.0.0.1），回环上的监听永远收不到这条转发。` +
            '症状是宿主 curl 7789 得 000、页面第五项报「Jupyter 不可用」，而容器档一切正常（本仓库的容器判据全走回环，' +
            '所以整片绿也发现不了）。改的是 docker/entrypoint.sh 的 --ServerApp.ip（要听 DNAT 目标那个地址），' +
            '边界仍然是「宿主侧只绑回环 + token」那两道（compose-ports.test.ts / notebook-compose.test.ts ① 钉着）'
          : '⇒ 但回环上也没人应答，那就不是绑定地址的问题，而是 **jupyter 根本没起来**（缺 token / ' +
            '镜像还是没带 Jupyter 的旧版 / 端口被占）——先按上面那条对照断言说的三点排，这条 DNAT 判据要等回环通了才谈得上';
      expect('status' in res, `${probeLine(url, res)}，而 ${probeLine(loopback, loopbackRes)}。${verdict}`).toBe(true);
    }
  });
});

// ──────────────────────────── 常驻：宿主档也要跑的那一组 ────────────────────────────

describe('容器档的门控本身（常驻，宿主也跑）', () => {
  /**
   * 「为什么上面那组没跑」必须有人管，而且合取的**两半各自**都要判得住（同 `publish-identity.test.ts` 的形状）。
   * 上面那一组的门控是 `IN_CONTAINER && NOTEBOOK_SERVICE`，所以这里不能只留一条等式：
   * 等式 `IN_CONTAINER === hasKernel` 在 dev 里会**假红**（dev 用的就是 arena 那个镜像 ⇒ kernel 文件在，
   * 而它按设计不是那个跑 notebook 服务的实例），在「compose 把 ARENA_NOTEBOOK_SERVICE 那行删了」的
   * arena 里又**判不出**任何东西（标记与文件都还在，等式照样成立）。评审 I-2 要的是两个方向分开、
   * 各自都真能红：
   * ① 服务身份 ⇔ 它的**前置产物**：标了 `ARENA_NOTEBOOK_SERVICE` 却没有镜像级 kernel 文件 ⇒ 红。
   *    只有 arena 会走到这一半（compose 只给它），红了说的是「镜像没按 Dockerfile 构建」，
   *    而那正是 `./start.sh --rebuild` 能修的东西（arena 有 `build:`  stanza；tools 的
   *    `arena-deps:dev` 没有，所以旧形状那句建议在 tools 里根本用不上 —— 现在也不会在 tools 红）。
   * ② 前置产物 ⇐ 容器标记：kernel 文件在场却连 `ARENA_IN_CONTAINER` 都没有 ⇒ 红（这一档会在
   *    **本该跑它的地方**静默跳过，那就是装饰）。
   * dev / tools 两条都为真而不红：它们有容器标记 ⇒ ② 真；没有服务标记 ⇒ ① 真。
   * 宿主两条也都为真：没有服务标记、也没有那个文件。
   * 写成两个 `expect` 而不是 `if (...) expect(...)`：永远会跑的断言里不许有早退（本仓库第 3 条硬约束），
   * 条件不成立的那一半以「为真」的形式参与判定，报告里看到的仍然是一条跑过的断言。
   */
  it('服务标记 / 容器标记与 kernel 文件必须互相圆得上（合取的两半各自能红）', () => {
    const hasKernel = existsSync(KERNEL_FILE);
    expect(
      !NOTEBOOK_SERVICE || hasKernel,
      `标了 ARENA_NOTEBOOK_SERVICE=1 却没有 ${KERNEL_FILE} ⇒ 这个容器自称是跑 notebook 服务的那个实例，` +
        '镜像里却没有 kernels COPY：要么镜像没按 Dockerfile 构建（该 ./start.sh --rebuild —— 对 arena 有效，' +
        'tools 那个 arena-deps:dev 没有 build stanza，重建它得另外走），要么这一档跑在没按 compose 起的容器里。' +
        '症状：上面那一组会红在「kernel 文件在镜像级目录」那句上，而它说的前置条件本来就缺',
    ).toBe(true);
    expect(
      !hasKernel || IN_CONTAINER,
      `这台机器上有 ${KERNEL_FILE}，却没设 ARENA_IN_CONTAINER=1 ⇒ 上面那一整组会在**本该跑它的地方**静默跳过` +
        '。三种可能，按顺序排：① compose 里 arena 那行容器标记漂移了（notebook-compose.test.ts ⑦ 会先在这里红）；' +
        '② 这一档跑在一个没被重建／没被标记的容器里（./start.sh --verify 会 up -d 重建，正常路径不该见到）；' +
        '③ **这台宿主上的 MSYS / Linux 类安装真的把 arena-pyspark 放进了 /usr/local/share/jupyter/kernels**' +
        '（那是本机自己的 kernel 目录，与 compose 无关 —— 别去改那三行 env，改的是这一条判据的适用范围，' +
        '并把这句话写进它旁边的注释）',
    ).toBe(true);
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
        // ip 的值跟着 docker/entrypoint.sh 走（0.0.0.0）：这份 fixture 的名字承诺"就是 entrypoint 起的那一条"，
        // 让它留着旧字面量只会教下一个人抄错 —— 而抄错的代价是发布端口打不到（DNAT 目标是容器 eth0，不是回环）。
        '--ServerApp.ip=0.0.0.0',
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
      // maxRetries 不是装饰：Windows 上杀毒/索引服务会临时按住刚写出来的文件句柄，
      // `rmSync(recursive)` 这时给的是 EPERM/EBUSY —— 一条**宿主档**的闸门会因为"清理没扫干净"翻脸，
      // 而本仓库对"会周期性假红"的闸门有明确过敏记录（写死假 pid 撞上活 pid 那条是同一类）。
      // 重试三次（每次 100ms）之后还删不掉，那才是真出了问题，让它红。
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  /**
   * 从 nbconvert 那份「执行后 notebook」里取证据的那一半（`executedNotebookEvidence`）也判在宿主上，
   * 理由与上面那条一样：容器里那条真跑的断言现在压在「notebook 承诺的三行」上，
   * 而**这层提取**在 Docker 起来之前唯一能判住的地方就是喂一份假的执行后 notebook。
   * 它判的是两件事，缺一件都会让容器那条红变得没法读：
   * ① 只收 stdout 的行（stderr 与富输出不许混进来 —— 混进来 `toContain('venv ok')` 就又开始吃整本 JSON）；
   * ② 出错 cell 要有名字，而**解析不了输入时消息里只能带截断后的原文**（评审 minor：
   *   原来那条 `expect(out).toContain('venv ok')` 失败时把 maxBuffer 那份 32MB 全抄进报告）。
   */
  it('假 executed-notebook JSON：只取 stdout 行、error 给 cell 号与异常名、解析不了要给截断', () => {
    const good = JSON.stringify({
      cells: [
        { cell_type: 'markdown', outputs: [] },
        { cell_type: 'code', outputs: [{ output_type: 'stream', name: 'stdout', text: ['python /opt/arena-ide-env/python/bin/python\n'] }] },
        {
          cell_type: 'code',
          outputs: [
            { output_type: 'stream', name: 'stderr', text: ['26/05/01 00:00:00 WARN NativeCodeLoader: ...\n'] },
            { output_type: 'stream', name: 'stdout', text: 'rows 15\n' }, // text 也可以是一整串（不只有数组形态）
            { output_type: 'execute_result', data: { 'text/plain': ['6'] } },
          ],
        },
        { cell_type: 'code', outputs: [{ output_type: 'stream', name: 'stdout', text: ['venv ok\n'] }] },
      ],
    });
    const ev = executedNotebookEvidence(good);
    expect(ev.errors, '正常的执行结果不该报 error cell').toEqual([]);
    // stderr 那条 WARN 与 execute_result 都不许进 stdout 行集合（否则"三行"这个判据就被污染成整本 JSON）
    expect(ev.stdout, '只该收到 notebook 承诺的那三行 stdout').toEqual([
      'python /opt/arena-ide-env/python/bin/python',
      'rows 15',
      'venv ok',
    ]);

    // 出错 cell：--execute 通常会直接抛，但"错误被 notebook 吃掉"那份 JSON 也算得上一份证据，
    // 这时消息里要看得见是哪个 cell 的哪个异常，而不是靠 traceBack 全文。
    const bad = JSON.stringify({
      cells: [
        { cell_type: 'code', outputs: [{ output_type: 'error', ename: 'AssertionError', evalue: 'assert 落地在系统解释器', traceback: ['x'.repeat(5000)] }] },
      ],
    });
    expect(executedNotebookEvidence(bad).errors, 'error 输出要落成「cell 号: 异常名」').toEqual(['cell 0: AssertionError']);
    expect(executedNotebookEvidence(bad).stdout, 'error 里的 traceback 不该被当成 stdout 行').toEqual([]);

    // 解析不了（被 maxBuffer 截断 / 根本不是 notebook）：证据必须**有界**，否则一次失败就是一条没法读的报告
    const huge = `${'y'.repeat(10_000)}`;
    const broken = executedNotebookEvidence(`{ 这不是 JSON …（尾部还有 ${huge}）`);
    expect(broken.stdout, '解析不了就不该有"stdout 行"').toEqual([]);
    expect(broken.errors.length, '解析不了要给一条 error').toBe(1);
    const only = broken.errors[0] ?? '';
    expect(only, 'error 要说清是解析不了').toContain('不是 notebook JSON');
    expect(only.length, `失败消息的长度被上限判住（实际 ${only.length}）`).toBeLessThan(1000);
  });

  /**
   * 真 /proc 上跑一遍同一个发现函数（评审 T10-2 要求的「宿主侧自检」）：
   * **发起查询的进程永远不许出现在结果里**。
   * 但它**必须有判据对象**才算数（评审 I-3）：本机是 Windows，Node 看不见 `/proc` ⇒
   * `readdirSync('/proc')` 抛 ENOENT ⇒ `listProcs()` 给空表 ⇒ `found` 为空 ⇒
   * `not.toContain(process.pid)` 空过、下面那个循环一行都没执行。
   * round-1 的报告把它写成「宿主侧实测证据」，而它在这里是一条看不见的 no-op ——
   * 正是本仓库那条「看起来跑了其实没跑」的失败类。
   * ⇒ 按规矩用 `it.skipIf(!HAS_PROC)`，让报告自己写出「N skipped」（不是 `try/catch → return`）。
   * 顺带把「有 /proc 就必须真读到进程」钉上：那条 `readdir` 抛/被 hidepid 挡住的形状给的是红，
   * 不是又一层空转。plumbing 的真判据仍然是上面那条**假 /proc 树**（d7/d8 两次变异证明它有牙）。
   */
  it.skipIf(!HAS_PROC)('真 /proc 发现：结果里不含本进程，且每个命中者都像服务', () => {
    const procs = listProcs();
    expect(
      procs.length,
      `/proc 存在（existsSync 判过）却一个进程都读不到 ⇒ 本条没有判据对象：` +
        '要么 readdir 被权限/hidepid 挡住，要么这台根本不是 Linux（那这条本来就该 skip）',
    ).toBeGreaterThan(0);
    const found = jupyterServerPids(procs, process.pid);
    expect(found, `发现结果里出现了本进程 pid ${process.pid} ⇒ 判据会把自己当成 jupyter 服务，PATH 那条必红`).not.toContain(process.pid);
    for (const pid of found) {
      const argv = procs.find((p) => p.pid === pid)?.argv ?? [];
      // 服务本体必然带 root_dir（分类器的第二个条件），这里再独立判一次：判据与分类器不一致时先在这里红。
      expect(argv.some((a) => a.startsWith('--ServerApp.root_dir=')), `pid ${pid} 被认成 jupyter 服务，但 argv 里没有 root_dir：${redactArgv(argv)}`).toBe(true);
    }
  });
});
