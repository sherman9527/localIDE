import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * notebook 执行证据的**三处提取**（前两件从 `server/test/notebooks/kernel.test.ts` 原样搬来，WI-90 Task 1 Step 2；
 * 第三件 `realExecError` —— "造真 error 的造法" —— 是 WI-107 从 `kernel.test.ts` 与 `tutorials.test.ts` 各一份的
 * 状态里合并进来的）。
 *
 * 为什么要搬而不是复制第三份：`kernel.test.ts`（A1 的 smoke 那一档）与 `tutorials.test.ts`（WI-90 的教程那一档）
 * 判的是同一件事的两半 —— "从 `jupyter nbconvert --to notebook --execute --stdout` 那份输出里只取
 * stdout 行与出错 cell 的条目"，以及"`execFileSync` 非 0 退出时说清是哪一种坏法"。
 * 这两件的教训都不是审美：它们在上一轮终审里被逐条打磨过（有界证据 / allow_errors 的分工 / 枚举里必须有 timeout 这一条自己），
 * 抄第二份的地方会各自漂，而漂掉的那一份**不会报错**，只会在下一次故障里给出比不判更差的报告。
 *
 * ⚠ 第三件（造法）同源的理由与前两件**不一样**，别混着宣称：前两件漂了会少判，而造法漂了的最坏形状是
 * "两边各自都绿，但喂的是两个不同的对象" ⇒ "同一个公共件只有一组真对象在判它"这句话悄悄不成立，
 * 而它的坏法没有任何一条红会来通知（实测见 `realExecError` 的注释）。
 *
 * ⚠ 不要把它做成"从测试文件 import 测试文件"：`kernel.test.ts` 一被 import 就带着它那些
 * `describe.skipIf` 与 `beforeAll`（真的 `ensureIdeEnv`）在别人的档位里跑一遍。
 * ⇒ 工具住在**非** `.test.ts` 的模块里（本仓库的同类做法：`server/test/notebooks/` 下同目录的 helper）。
 * 它不在 `verify-coverage.test.ts` 的孤儿判据对象里（那条只收 `*.test.ts`），
 * 但它在 `server/tsconfig.test.json` 的 include 覆盖面里（`test` 目录下的全部 `.ts`）⇒ 类型检查照跑，
 * 覆盖面由 `typecheck-coverage.test.ts` 那条"不存在没被任何 tsconfig 认领的测试文件"钉住。
 * 现在这个模块自己会 `execFileSync` 起子进程（只有 `realExecError` 用得到，判读那几件不碰它），
 * 所以**import 它不再有副作用**：模块加载时什么都不跑，起进程只在被调用时。
 *
 * ## WI-91b Task 1 起的**接口层**（名称与错误语义是给 Task 2..5 的契约，不是实现细节）
 *
 * 背景：Apache Toree 会把两行 interpreter 注册表打在 `jupyter nbconvert --stdout` 的 JSON **前面**，
 * 旧读法（`JSON.parse(整个 stdout)`）抛的那句话与"kernel 真的坏了"长得一模一样。本层把两件事分开：
 *
 * - `readExecutedNotebook(text)` —— **严格**读法，返回 `ExecutedNotebook`。判"这份文本能不能读成执行后的
 *   notebook"：整段 parse 不通时先试"从第一个 `{` 起切"（容忍实测的 Toree **前缀**形状；后缀不收，收它是
 *   新判据要带新测试），切完仍不通、或读出来却没有 `cells` 数组 ⇒ **throw**。绝不静默返回 `{cells: []}`
 *   —— 那会把"kernel 坏了"读成"这本 notebook 没有 cell"（派发词硬约束）。抛出的话只说"读不出这份文本"，
 *   **不**替进程层编"跑不起来"（那句话的职权在 `nbconvertCrashEvidence`，它吃 execFileSync 的 error，这里吃文本）。
 * - `readExecutedNotebookFile(executedNotebookPath)` —— **容器档入口**（R2 钉死的签名：吃执行后 notebook 的
 *   **文件路径**，Task 4 复用）。读文件 + 交给 `readExecutedNotebook`；文件不在/读不动也 throw，话说"结果文件
 *   这一层的接线坏了"这一层。
 * - 主路径是 **(a)**（brief Step 3 的首选，裁决记录在此）：`nbconvertExecuteToFileArgv` 用
 *   `--output-dir <目录> --output <文件名>` 把执行后的 notebook **落盘**，垃圾行留在 stderr，JSON 天生干净。
 *   ⚠ **前缀容忍的作用域**（评审轮更正 —— 此前这一句谎报旧门也沾了这份容忍）："从第一个 `{` 起切"的第二道
 *   **只服务 `readExecutedNotebook` / `readExecutedNotebookFile` 这两扇门**（形状是 (b)，判据是 notebook-evidence.test.ts
 *   的逐字污染夹具）。今天仍走 `--stdout` 的旧门（`kernel.test.ts` 的 smoke 与假 JSON 判据、`tutorials.test.ts` 的
 *   marker 判据 —— 它们吃的是 `executedNotebookEvidence`：整段严格 `JSON.parse` + 宽松 error 语义）**没有这份容忍**：
 *   把 Toree 污染的 stdout 喂给那扇门，得到的是「输出不是 notebook JSON：(Scala,org…」的一条**数据**条目，
 *   而不是被读出来。这个不对称**是刻意的**（改量具 ≠ 放宽判据）：给 stdout 门加前缀容忍是**另一道门的判据变更**，
 *   要单独的裁决与它自己的测试，不许顺手 —— 且**现需至今为零** —— 不是"只注册了一条 kernel"（`NOTEBOOK_KERNELS` 现在两条，这句话在 Task 3 之后就已经假过一次），
 *   而是**没有任何一份 Scala notebook 会走到这扇门前**：Scala 的夹具按裁决住在 `server/test/notebooks/fixtures/`，
 *   题闸门 `tutorials.test.ts` 判的仍是"每篇都跑在 `arena-pyspark` 上"，而 N-20 把"每篇期望哪条 kernel"
 *   记成注册表自带字段 —— **那一天**才是重新裁决这扇门的时刻（届时按现需改判据，别按今天这句话改）。分界由 notebook-evidence.test.ts 的「宽松门对前缀垃圾仍报 输出不是 notebook JSON」钉成被验事实；
 *   **下游作者（Task 4）读到这里时不要以为 stdout 门已防污染** —— Task 4 走的是文件门（`readExecutedNotebookFile`）。
 * - `executedNotebookScratchPath(tag)` / `removeExecutedNotebookScratch(path)` —— 落盘临时文件的**唯一**选址与
 *   收尾实现：住在实例自己的数据目录（`config.dataDir`，即 `ARENA_DATA_DIR` 跟着走的那棵树；WI-40 隔离纪律），
 *   **不进** `config.notebook.workDir`（那是真人的笔记工作区）。删除返回"删净与否"，调用方把它落成一条错误/断言
 *   （形状照 `embed.test.ts` 的收尾删除判据：断言放 try/finally 之外，finally 只记账）。
 * - `notebookEvidence(nb)` —— "只取 stdout 行与出错 cell 条目"的那份循环现在**只有一份**：宽松门
 *   `executedNotebookEvidence(raw)`（语义不变：解析不了给有界 error 条目而不是 throw，`kernel.test.ts` 的常驻
 *   判据钉着它）与严格门读出的 notebook 都走这一个提取器。两扇门两套真相是会漂的那种写法（WI-107 那一课）。
 */

/** nbconvert 那份输出里，断言消息最多可以带走这么多字符（评审 minor：别把 32MB 打进报告）。 */
const EVIDENCE_CAP = 400;

/**
 * node 那句 `Command failed:` 里能塞多少 stderr 就塞多少（实测过 Spark 的日志实践上没有上界），
 * 所以崩溃消息里的 stderr 只留这么多字符。判据要的是"这一档跑不起来"这一事实，不是它的整本日志。
 */
const STDERR_TAIL = 800;

/**
 * 崩溃消息的**总长**上限。`STDERR_TAIL` 只管得住"搬了多少 stderr"，管不住分支正文自己变长
 * —— 兜底那一支要把原 error 的消息带出来，而 `execFileSync` 的 `err.message` 里整段拼着 stderr。
 * 最后一道闸放在出口上，且超限时**先切尾巴**：被切掉的只能是那段 stderr，不能是指路的那几句正文。
 */
const EVIDENCE_HARD_CAP = 1_700;

/** 兜底那一支能带走多少"原 error 的名 + 消息"（同一个"无上界"问题的另一个入口，所以同样要有界）。 */
const ERR_TEXT_CAP = 300;

/** 调用方这一档的预算，由使用它的测试文件传进来（见 `nbconvertCrashEvidence` 的注释）。 */
export interface NbconvertBudget {
  /** 调用方给 `execFileSync` 的 `timeout`（**毫秒**） */
  execTimeoutMs: number;
  /** 调用方传给 `--ExecutePreprocessor.timeout` 的 cell 级超时（**秒**） */
  cellTimeoutS: number;
}

/** 预算到点时该说的那半句（有调用方就点名，没有就不点名 —— 公共件不许猜别人的秒数）。 */
function timeoutWording(budget?: NbconvertBudget): string {
  if (!budget) return '这条用例自己的 execFileSync 预算到点（秒数看本阶段的命令与该测试文件里的预算常量，公共件不点名）';
  return `这条用例的 execFileSync 预算 ${Math.round(budget.execTimeoutMs / 1000)}s 到点（cell 级超时 ${budget.cellTimeoutS}s；两者都在调用方那个测试文件里推导，这里不各写一份）`;
}

/**
 * node 那份 error 上判读用到的字段。**全部按 `unknown` 收**，形状由下面那张实测表决定。
 * 这不是吹毛求疵：旧写法 `code?: number | string` 把"code 可能是退出码"写进了类型，
 * 而真 error 的 `code` 只会是字符串错误名 —— 类型替错事实说了话，判读就照着错的那半活了一整轮。
 */
interface ExecErrorShape {
  code?: unknown;
  status?: unknown;
  signal?: unknown;
  killed?: unknown;
  name?: unknown;
  message?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 可以印进消息的"字段值"：字符串/数字/布尔原样，`null`、`undefined`、对象一律算"没有"。 */
function tokenOf(v: unknown): string | null {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** node 的 errno 名长这样（ENOENT / ETIMEDOUT / ENOBUFS）。字符串 `code` 只有匹配它才算"错误名"。 */
const SPAWN_ERROR_NAME = /^[A-Z][A-Z0-9_]+$/;

/** 截断并且**留下痕迹**（悄悄变短 = 下一次读的人会以为原文本来就这么长）。 */
function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…（已截断，原长 ${text.length}）`;
}

/** 整条消息的最后一道闸：超限就切掉尾部（尾部正是那段 stderr），并说明切掉了多少。 */
function capEvidence(msg: string): string {
  if (msg.length <= EVIDENCE_HARD_CAP) return msg;
  const note = `…（整条消息也到了上限 ${EVIDENCE_HARD_CAP}，原长 ${msg.length}；被切掉的只有尾部那段 stderr）`;
  return msg.slice(0, Math.max(0, EVIDENCE_HARD_CAP - note.length)) + note;
}

/**
 * 原 error 的"名 + 消息"，**截断**。
 * `String()` 对 `Object.create(null)` 那一类会抛"Cannot convert object to primitive value" ⇒ 这里必须接住：
 * 兜底那一支的职责是"把看见的东西说出来"，不是自己再抛一次、把判读抹掉（本仓库那条
 * 「`void` 一个 async 就要保证它永不 reject」是同一条规矩的另一个方向：**报错的那段代码不许在报错时坏掉**）。
 */
function describeError(err: unknown): string {
  const e = (err ?? {}) as ExecErrorShape;
  const name = asString(e.name) || 'Error';
  const message = asString(e.message);
  if (message !== '') return clip(`${name}: ${message}`, ERR_TEXT_CAP);
  let raw: string;
  try {
    raw = String(err);
  } catch {
    raw = '(这份 error 连 String() 都转不出来)';
  }
  return clip(`${name}（没有 message）／原值 ${raw}`, ERR_TEXT_CAP);
}

/** 「被外力结束」那一族的共同开头。signal 有没有是两种话，不许混成一句"跑不起来"。 */
function externalHead(signal: string | null, spawnCode: string | null, killed: boolean): string {
  const parts = [signal !== null ? `signal=${signal}` : 'signal 没有（node 没给出名字）'];
  if (spawnCode !== null) parts.push(`node 的错误名 code=${spawnCode}（那是错误名，**不是退出码**）`);
  if (killed) parts.push('killed=true');
  return `nbconvert ${signal !== null ? '被信号终止' : '被 node 结束'}：${parts.join('、')}，没有退出码可用`;
}

/**
 * 「进程被外力结束」那一支。真形状三种（都在 `nbconvertCrashEvidence` 上方那张实测表里，不是推理）：
 * 到点（ETIMEDOUT）、撑破缓冲（ENOBUFS），以及没有任何 node 错误名、只带 signal/killed 的那一种（人手或 OOM killer）。
 * 支内还要按 node 那个错误名再分一次：**"该改秒数"与"该改缓冲上限"是两句不同的话**，
 * 合成一句就等于其中一半在替另一半撒谎。
 */
function externalEvidence(signal: string | null, spawnCode: string | null, killed: boolean, budget?: NbconvertBudget): string {
  const head = externalHead(signal, spawnCode, killed);
  if (spawnCode === 'ENOBUFS') {
    return (
      `${head} ⇒ **是 stdout/stderr 撑破了 maxBuffer**，不是预算到点：node 的实现是一旦超过 maxBuffer 就用 SIGTERM ` +
      '把子进程结束掉，所以它在形状上长得像"被杀"，而该改的是调用方的 `maxBuffer`，不是那两个秒数。' +
      '这一档的 stdout 是「执行后的整本 notebook」（里面还有 base64 富输出），它长**是预期的**。' +
      'kernel 注册 / venv 那些假设在这里**没有被判**（它们各有自己的用例）。'
    );
  }
  if (spawnCode === null || spawnCode === 'ETIMEDOUT') {
    // 没有错误名 + SIGTERM 时，超时仍然是**第一位**的怀疑对象：execFileSync 到点用的就是 SIGTERM。
    return (
      `${head} ⇒ **先想超时/预算**：${timeoutWording(budget)}。` +
      '这一支与"以退出码表达失败"那一种是两件事：进程是被外力结束的，退出码天生为空，' +
      'kernel 注册与 venv 那些假设**不成立也不被判**（它们各有自己的用例）。' +
      (spawnCode === null ? '（人手 Ctrl-C / OOM killer 那一类也收在这一支：node 不给错误名，两者的差别去 stderr 那一段找。）' : '')
    );
  }
  return (
    `${head} ⇒ 外力给的 signal 配一个 node 错误名 code=${spawnCode}，这一条判不出更细的种类：` +
    '按那个错误名去查 node 的 errno 表。**不许**顺手读成"预算到点"，也不许顺手读成 kernel 没注册 —— 那是另外两支的话。'
  );
}

/**
 * 「命令压根没被执行」那一支：spawn 级失败，进程没起来过，所以既没有退出码也没有超时可言。
 * 它必须**单独成一支**：这一种的修法是把可执行文件/权限修好，而"非 0 退出"那三条前提在这里一个都没有对象。
 */
function spawnEvidence(spawnCode: string): string {
  const which =
    spawnCode === 'ENOENT'
      ? '`jupyter` 这个**可执行文件不在** PATH 里：宿主档没有它是**正常**的（真跑归容器档），容器里红在这里才是镜像/PATH 坏了。'
      : spawnCode === 'EACCES' || spawnCode === 'EPERM'
        ? '那个文件找到了但**不可执行**（权限位、挂载带 noexec、或它根本不是本机可执行格式）。'
        : `按 node 的错误名 code=${spawnCode} 去查那一份 errno 表（这一支能保证的只有"进程没被起来过"，具体原因只有这个错误名知道）。`;
  return (
    `nbconvert 这条命令**根本没被执行**：spawn 失败 code=${spawnCode}（那是 node 的错误名，**不是退出码**）。${which} ` +
    '这一支里 kernel 注册 / venv / 预算那些假设**都还没有对象**：命令连跑都没跑起来，退出码与超时都无从谈起。'
  );
}

/**
 * 「进程自己非 0 退出」那一支。`from` 说的是这个数取自哪个键：真 error 只有 `status` 这一种，
 * `code` 那份是**调用方映射过的形状** —— 今天唯一的生产者是 `tutorials.test.ts` 里那组手搓判据
 * （它把数字放在 `code` 上）。⚠ 原先的另一个生产者 `scalaKernelProbe.ts` 的 `evidenceShapedExecError`
 * 已随 WI-91 的探针改造删掉（2026-10-11 全仓 grep 命中 0），所以这里不是留着向后兼容的壳子：
 * 这一支**仍有对象**，删它会让那组手搓判据失去可说的形状；哪天 `tutorials.test.ts` 也不再用 `code`，连着删。
 * 两种都要认，否则那一层 shim 会把真故障
 * 又搬回错支（这正是本轮修掉的那个病的另一种走法）。
 */
function exitEvidence(exitCode: string, from: 'status' | 'code', budget?: NbconvertBudget): string {
  return (
    `nbconvert 以 code=${exitCode} 非 0 退出（这个数取自 error 的 \`${from}\` 键 —— **进程自己的退出码**，不是 node 的错误名）⇒ ` +
    '这**不是**「某个 cell 抛了异常」：那种情况 --ExecutePreprocessor.allow_errors=True 会让它退 0、错误落成 output_type=error，' +
    '由「执行时抛异常的 cell」那条结构化断言报出 cell 号与异常名。非 0 退出说的是这一档跑不起来：' +
    `${NOTEBOOK_KERNELS.pyspark.id} 没注册 / venv 解释器缺失（这一档容器组第一条用例判的就是这个前提）、` +
    // 枚举里必须有**这一条自己**：到点时被 SIGTERM 杀掉，退出码一样是空的 ——
    // 它过去不在列出的原因里，于是最常见的坏法被印成"几条此刻并不成立的原因"（函数上方那段警告说的同一件事）。
    'DeadKernelError（Spark 崩在半路）、stdout 撑破了 maxBuffer（那一种 node 通常带 ENOBUFS + SIGTERM，会落到上面那一支；' +
    `落在这里说明是 jupyter 自己退的非 0），或${timeoutWording(budget)}（先想这一条，再去看上面那几条）。`
  );
}

/** 兜底：三支的字段一个都没有。**静默是这一支最贵的坏法**，所以它必须把原 error 的名与消息带出来。 */
function unknownEvidence(err: unknown): string {
  return (
    'nbconvert 失败了，但这份 error 里**既没有 status、也没有 signal、也没有 code** ⇒ 判不出它是上面哪一种坏法' +
    `（兜底这一条不许静默，也不许猜成三支中的任何一支）。原 error：${describeError(err)}。` +
    '走到这里通常是两件事之一：失败发生在**起进程之前**（参数拼装、夹具路径不在），' +
    '或者递进来的根本不是 `execFileSync` 抛的那个对象（那一份必然带 status / signal / code 三者之一）。'
  );
}

/**
 * `execFileSync('jupyter', ['nbconvert', …])` 失败时该说的那句话（评审 I-1 的后半）。
 * 加了 `--ExecutePreprocessor.allow_errors=True` 之后，这条路只剩「这一档根本跑不起来」那一类故障
 * （kernel 起不来 / DeadKernelError / stdout 撑破 maxBuffer / 预算到点），它们与「某个 cell 抛了异常」是两件事：
 * 后者现在是数据（`output_type=error` → `executedNotebookEvidence` 报「cell 号 + 异常名」），不再是异常。
 * 这里不许把 node 原样的 `err.message` 抛出去：它整段拼进了 stderr（Spark 的 stderr 无上界），
 * 一次失败就把测试报告写成日志转储 —— 那正是 `kernel.test.ts` 把断言从整本 notebook 收进「三行」的同一个理由。
 *
 * ⚠ **判读依据的两条事实（本轮就是被它们咬的，下一个人改这里时要知道）**：
 * **真实 error 的退出码在 `status` 上，而 `signal` 在非正常退出时是 `null`（不是 `undefined`）。**
 * `code` 只装 node 的 **spawn 级错误名**（`ENOENT` / `ETIMEDOUT` / `ENOBUFS` 那一类**字符串**），
 * `execFileSync` 这一条路上 `killed` 甚至压根不存在。旧判据写的是
 * `e.killed === true || (e.code === undefined && e.signal !== undefined)` ——
 * `null !== undefined` 成立、`code` 又真的是 undefined，于是**每一条真故障**（`{status:1, signal:null}`）
 * 都落进"被信号终止 ⇒ 先想超时/预算"那一支，而会指路的那一支（kernel 没注册 / venv 缺失 / DeadKernelError）
 * 永远走不到。旧形状判据喂的是手搓的 `{code: 1, …}`，所以它在全绿下面把这句话说了个反
 * （本仓库为这个形状付过两次学费：桥 token、`kernels` vs `kernelspecs`）。
 *
 * 本机实测（宿主 Windows / node v24.14.1，`scalaKernelProbe.ts` 在容器 node v24.10.0 里量到同一套形状）：
 *
 * | 真实故障 | node 那份 error | 该走哪一支 |
 * | --- | --- | --- |
 * | 进程自己非 0 退出（kernel 没注册、notebook 不合法…） | `{status:3, signal:null}`，`code`/`killed` 都没有 | 非 0 退出（报 `code=3`） |
 * | `execFileSync` 的 `timeout` 到点 | `{code:'ETIMEDOUT', status:null, signal:'SIGTERM'}` | 外力 ⇒ 预算到点（点名调用方的秒数） |
 * | stdout/stderr 撑破 `maxBuffer` | `{code:'ENOBUFS', status:null, signal:'SIGTERM'}` | 外力 ⇒ **改 maxBuffer，不是改秒数** |
 * | 可执行文件不在（宿主档没有 jupyter） | `{code:'ENOENT', status:null, signal:null}` | spawn 那一支（单独一句） |
 * | 三者都没有（普通 `Error`、`{}`） | 只有 `name`/`message`（或都没有） | 兜底：带出原 error 的名与消息 |
 *
 * ⇒ **分支顺序是判出来的**：「外力」排在「字符串 code」之前，因为到点与撑破缓冲这两种是**同一个对象里
 * 既有字符串 code 又有 signal=SIGTERM**；先判 code 就会把"预算到点"读成"可执行文件不在"。
 *
 * ⚠ **预算数字只能由调用方传**（评审 M2）。这份 plumbing 被多档共用而各档预算不同
 * （`kernel.test.ts` 那条 smoke 是 180s、`tutorials.test.ts` 那边是 135s/120s、`scalaKernelProbe.ts` 又是一个数），
 * 公共件里写死任何一份都是在替别人说话。不传 `budget` 是刻意允许的形状（那一支照样说得出"预算到点"，只是不点名秒数）。
 *
 * 形状判据：`kernel.test.ts` 常驻那组「nbconvertCrashEvidence 吃真 error 的四支判读」——
 * 每条都**真的 spawn 一个子进程**去拿 node 抛的那个 error，外加 `tutorials.test.ts` 那组手搓形状的判据
 * （它管"预算不许写死"与"消息有界"，真 error 那一组管"分支必须按真形状走"）。
 */
export function nbconvertCrashEvidence(err: unknown, budget?: NbconvertBudget): string {
  const e = (err ?? {}) as ExecErrorShape;
  const stdout = asString(e.stdout);
  const stderr = asString(e.stderr);
  const tail = `\nstderr ${stderr.length} 字节 / stdout ${stdout.length} 字节，只贴 stderr 末尾 ${STDERR_TAIL} 字符：\n${stderr.slice(-STDERR_TAIL)}`;

  const signal = tokenOf(e.signal);
  const killed = e.killed === true;
  // 字符串且长得像 errno 名 ⇒ node 的错误名。像 `'(没有退出码)'` 那种字符串是调用方塞的占位，不算错误名，
  // 让它落到兜底那一支（那里会说"这是什么"，而不是替它编一个"可执行文件不在"）。
  const spawnCode = typeof e.code === 'string' && SPAWN_ERROR_NAME.test(e.code) ? e.code : null;
  // 退出码：真 error 在 `status`（数字）；数字 `code` 是映射过的形状（见 `exitEvidence` 的 `from`）。
  const exitCode = typeof e.status === 'number' ? { value: String(e.status), from: 'status' as const } : typeof e.code === 'number' ? { value: String(e.code), from: 'code' as const } : null;

  const externallyKilled = signal !== null || killed || spawnCode === 'ETIMEDOUT' || spawnCode === 'ENOBUFS';
  const body = externallyKilled
    ? externalEvidence(signal, spawnCode, killed, budget)
    : spawnCode !== null
      ? spawnEvidence(spawnCode)
      : exitCode !== null
        ? exitEvidence(exitCode.value, exitCode.from, budget)
        : unknownEvidence(err);
  return capEvidence(`${body}${tail}`);
}

/**
 * 从 `jupyter nbconvert --to notebook --execute --stdout` 的输出里只取**两样**：
 * cell 打到 stdout 的那些行，和出错 cell 的异常名。
 * 那份输出是「执行后的整本 notebook」（JSON，里面还有富输出／base64），`maxBuffer` 给到 32MB ——
 * 断言直接压在整串上时，一次失败会把整个 JSON 抄进测试报告（评审 I-4/minor：
 * 「`expect(out).toContain('venv ok')` 失败时会 dump 整本 notebook」）。
 * 「导语只承诺三行」是 **`kernel.test.ts` 那一篇 smoke** 的形状（`python …` / `rows 15` / `venv ok`）；
 * `tutorials.test.ts` 那边压的是 marker 行与 error 条目，同一层提取、不同的判据对象。
 * 解析不出 JSON 时给的是**截断后**的原文，不是全文 —— 「看不懂它输出了什么」也要看得见，但不能拿 32MB 换。
 * 形状判据：`kernel.test.ts` 常驻那组的「假 executed-notebook JSON」，所以这条 plumbing 在宿主上就有牙，
 * 不必等容器（容器里那次真跑只是它的一个用例）。
 */
export function executedNotebookEvidence(raw: string): { stdout: string[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stdout: [], errors: [`输出不是 notebook JSON：${raw.slice(0, EVIDENCE_CAP)}`] };
  }
  const cells = (parsed as { cells?: unknown })?.cells;
  if (!Array.isArray(cells)) return { stdout: [], errors: [`notebook JSON 里没有 cells 数组：${raw.slice(0, EVIDENCE_CAP)}`] };
  return notebookEvidence(parsed as ExecutedNotebook);
}

// ──────── WI-91b Task 1：执行后 notebook 的严格读法（接口层，见文件头） ────────

/** 执行后 notebook 的 metadata 里今天被判的那两个字段；其余按原样过（索引签名收着，见文件头接口段）。 */
export interface ExecutedNotebookMetadata {
  kernelspec?: { name?: unknown; [k: string]: unknown };
  language_info?: { name?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * `readExecutedNotebook` / `readExecutedNotebookFile` 读出来的对象形状。
 * `cells` 被读法**钉成数组**（nbformat 的不变量：空 notebook 也是 `[]`，所以"没有 cells 数组"与
 * "`cells` 是空数组"是两种坏法，读法只放行后者）；这正是派发词那条硬约束的结构化表达。
 */
export interface ExecutedNotebook {
  cells: unknown[];
  metadata?: ExecutedNotebookMetadata;
  [k: string]: unknown;
}

/** 抛错消息里带多少"原文开头"：要看得见症状（前缀是什么字符），又不许把整本 notebook 抄进报告。 */
const READ_PREVIEW = 200;

/** 预览：JSON.stringify 包一层，让换行/引号在报告里**显形**（裸拼会让下一个人把两行垃圾读成一行）。 */
const previewOf = (text: string): string => JSON.stringify(text.length <= READ_PREVIEW ? text : `${text.slice(0, READ_PREVIEW)}…`);

/** "整段读不成 notebook JSON"那一支的话。两支话（这一支与"缺 cells"那一支）不许合并：合并就抹掉了两种坏法的区分。 */
function unreadableNotebookError(text: string, reason: unknown, tried: string): Error {
  return new Error(
    `这份文本读不出来（不是"执行后的 notebook JSON"）（${tried}）⇒ 原报错：${clip(describeError(reason), 200)}。` +
      `文本共 ${text.length} 字符，开头是：${previewOf(text)}。` +
      '⚠ 这句话只判"这份文本读不成 notebook JSON"这一件事，**不判** kernel 坏没坏、nbconvert 有没有正常结束 —— ' +
      '那是 `nbconvertCrashEvidence` 按进程 error 说的另一句话（不同对象、不同职权，混着说就是本仓库记过的"指错方向的报错"）。' +
      '这里也**绝不**静默返回 `{cells: []}` —— 那会把"kernel 坏了"读成"这本 notebook 没有 cell"。',
  );
}

/** "读出来的是合法 JSON，但不是执行后的 notebook"那一支的话。 */
function notAnExecutedNotebookError(text: string): Error {
  return new Error(
    `读出来的是合法 JSON，但它不是"执行后的 notebook"：里面没有 cells 数组（nbformat 的不变量是 cells 恒为数组，空 notebook 也是 []）` +
      `⇒ 文本共 ${text.length} 字符，开头是：${previewOf(text)}。` +
      '这与"整段不是合法 JSON"是两种坏法，两句话不许合并；这一支同样不判 kernel 坏没坏（职权划分见 `readExecutedNotebook` 上方注释）。',
  );
}

/**
 * 把"执行后 notebook 的那份文本"读成 `ExecutedNotebook`，读不出就**抛**（语义契约在文件头）。
 *
 * 今天（WI-91b Task 1）的容忍形状：JSON 对象**之前**的垃圾行 —— Toree 实测在 `--stdout` 的 JSON 前先打两行
 * interpreter 注册表（`(Scala,org.apache.toree.…@1015a4b9)`）。做法是"整段 parse 不通时，从第一个 `{` 起切再试一次"
 * （形状 (b) 收在**读法**里当第二道防线；主路径是 (a) 落盘，见文件头与 `nbconvertExecuteToFileArgv`）。
 * **后缀不收**：JSON 之后还有尾巴说明这份输出的形状根本不在本轮实测里，宽容它=猜它。
 * ⚠ 已知边界：垃圾行里若自己带 `{`，第一个 `{` 就不是 JSON 的开头 ⇒ 两支都读不出时红话会给原文开头，
 * 那不是谎报（它说的是"读不出"这个事实）。真撞上那种形状再收紧切法，别在这里顺手放宽。
 */
export function readExecutedNotebook(text: string): ExecutedNotebook {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    if (start > 0) {
      // 第二道防线（形状 (b)，判据是 notebook-evidence.test.ts 的逐字污染夹具）：整段 parse 不通时，
      // 把**第一个 `{` 之前**的字节当前缀垃圾跳过再试一次 —— Toree 的注册表行就长在那个位置。
      try {
        candidate = JSON.parse(text.slice(start));
      } catch (err2) {
        throw unreadableNotebookError(text, err2, `从第一个 { （第 ${start} 字符）起切后仍失败，前缀那 ${start} 字符被跳过`);
      }
    } else {
      // start 为 -1（整段没有 `{`）或 0（切了等于没切，整段 parse 已经试过了）：直接报，不假装努力过。
      throw unreadableNotebookError(text, err, start < 0 ? '整段里连一个 { 都没有，前缀容忍帮不上' : '第一个 { 就在开头，切了等于没切');
    }
  }
  const cells = (candidate as { cells?: unknown } | null)?.cells;
  if (!Array.isArray(cells)) throw notAnExecutedNotebookError(text);
  return candidate as ExecutedNotebook;
}

/**
 * **容器档入口**（R2 钉死的签名）：执行后的 notebook 由 `--output` 落盘，这里吃**文件路径**。
 * 文件读不动 ⇒ 抛，话说的是"结果文件这一层的接线"：那与"这份结果读不成 notebook"（`readExecutedNotebook` 的
 * 两支）和"进程自己怎么坏的"（`nbconvertCrashEvidence`）是三句话，各判各的对象。
 */
export function readExecutedNotebookFile(executedNotebookPath: string): ExecutedNotebook {
  let text: string;
  try {
    text = readFileSync(executedNotebookPath, 'utf8');
  } catch (err) {
    throw new Error(
      `读不到 nbconvert 该落盘的执行后 notebook：${executedNotebookPath} ⇒ 结果文件不在或读不动（命令没跑完整 / 路径算错 / scratch 目录被删）。` +
        `原报错：${clip(describeError(err), 200)}。⚠ 这一句判的是"结果文件"这层接线；进程那边到底怎么坏的归 \`nbconvertCrashEvidence\`（吃 execFileSync 的 error），` +
        '把两句混成一句就是"工具读不出"被读成"kernel 坏了"的又一次复发。',
    );
  }
  return readExecutedNotebook(text);
}

/** scratch 落在 `config.dataDir` 下的子目录名（数据目录跟着 `ARENA_DATA_DIR` 走；不进 `config.notebook.workDir`，那是真人的笔记工作区）。 */
const SCRATCH_SUBDIR = 'notebook-exec-scratch';

/** 同一毫秒内的去重计数：pid+Date.now 在同一毫秒的两次调用会撞名（两条真跑互删的形状）。 */
let scratchSeq = 0;

/**
 * 主路径 (a) 的落盘位置：**实例自己的数据目录**下的唯一 .ipynb（WI-40 隔离纪律 —— E2E/换实例时 `ARENA_DATA_DIR`
 * 指到哪，scratch 就跟到哪，绝不落进源码树或系统 tmp）。目录顺手 `mkdir -p` 出来：不赌 nbconvert 会不会自己建
 * `--output-dir`。调用方**必须**收尾 `removeExecutedNotebookScratch`（探针/Task 4 各有一条"残留即错"的判据）。
 */
export function executedNotebookScratchPath(tag: string): string {
  const dir = join(config.dataDir, SCRATCH_SUBDIR);
  mkdirSync(dir, { recursive: true });
  scratchSeq += 1;
  return join(dir, `${tag}-${process.pid}-${Date.now()}-${scratchSeq}.ipynb`);
}

/**
 * 删掉落盘的执行结果并**回话删净与否**（`false` = 还在）。调用方把它落成一条 error/断言，
 * 而不是在这里 throw —— finally 里 throw 会盖掉 try 里真正的坏点（`embed.test.ts` 实测过的那一课）。
 * `maxRetries` 照 `kernel.test.ts` 常驻用例的教训：Windows 的索引/杀软会临时按住刚写出的文件句柄给 EPERM。
 */
export function removeExecutedNotebookScratch(executedPath: string): boolean {
  try {
    rmSync(executedPath, { force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 删失败的后果由返回值说（existsSync 还指着它在，就是没删净），这里不再往外抛第二次故障。
  }
  return !existsSync(executedPath);
}

/**
 * 主路径 (a) 的 nbconvert 参数：执行后的 notebook **落盘**到 `executedPath`，不再走 `--stdout`。
 * `--output` 只吃文件名、目录交给 `--output-dir`：nbconvert 跨版本对"--output 自己带路径"的语义不一致，
 * 这对组合是稳的（形状判据在 notebook-evidence.test.ts，宿主就有牙）。
 * `allow_errors=True` 的由来与 `tutorials.test.ts` / `kernel.test.ts` 同一课：少了它，cell 一报错整条路就 throw，
 * 结构化证据（cell 号 + 异常名）一行都拿不到。
 */
export function nbconvertExecuteToFileArgv(notebookPath: string, executedPath: string, cellTimeoutS: number, kernelName?: string): string[] {
  const argv = [
    'nbconvert',
    '--to',
    'notebook',
    '--execute',
    '--output-dir',
    dirname(executedPath),
    '--output',
    basename(executedPath),
    '--ExecutePreprocessor.allow_errors=True',
    `--ExecutePreprocessor.timeout=${cellTimeoutS}`,
  ];
  if (kernelName) argv.push(`--ExecutePreprocessor.kernel_name=${kernelName}`);
  argv.push(notebookPath);
  return argv;
}

/**
 * 从**已读出的** notebook 取那两样证据（stdout 行 / 出错 cell 条目）。
 * 这份循环现在只有这一个住处：宽松门 `executedNotebookEvidence` 与严格门 `readExecutedNotebook(…)` 的结果
 * 都从这里过（"两扇门两套真相会漂"是 WI-107 记过的同一课）。逐行 trim、去空行、error 只留 cell 号与异常名，
 * 语义与抽入前逐字一致。
 */
export function notebookEvidence(nb: ExecutedNotebook): { stdout: string[]; errors: string[] } {
  const stdout: string[] = [];
  const errors: string[] = [];
  nb.cells.forEach((cell, i) => {
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

// ──────── 造**真 error** 的造法（两个测试文件共用的一份，WI-107） ────────

/**
 * `execFileSync` 失败时那种"注定要失败"的场景，一种对应 `nbconvertCrashEvidence` 上方实测表的一行。
 * 做成**判别联合**而不是"一个 kind 字符串 + 一堆互不相干的选项"：选项与场景不匹配时编译期就该红，
 * 而运行时静悄悄少给一个参数（比如 timeout 没传）会让造出来的对象根本不是那一行的形状 ——
 * 那正是本轮要根掉的东西在造法这一侧的化身。
 */
export type RealExecErrorSpec =
  /** 进程自己非 0 退出（最常见的那一种真故障：kernel 没注册、notebook 不合法…） */
  | { kind: 'nonZeroExit'; exitCode?: number; noiseBytes?: number }
  /** 调用方给的 `timeout` 真的到点（node 给 SIGTERM + `ETIMEDOUT`） */
  | { kind: 'execTimeout'; timeoutMs: number; noiseBytes?: number }
  /** 可执行文件不在 PATH 里（宿主档没有 jupyter 就是这一种，spawn 级失败） */
  | { kind: 'spawnEnoent' }
  /** stdout 撑破 `maxBuffer`（node 给 SIGTERM + `ENOBUFS`，结论与"预算到点"是两件事） */
  | { kind: 'maxBufferOverflow'; maxBufferBytes?: number };

/** 一个谁都起得来、但永远起不成的可执行文件名（`spawnEnoent` 那一行用；带 WI 前缀免得撞真工具）。 */
const MISSING_EXECUTABLE = 'arena-no-such-executable-wi92-xyz';
/** 挂住不返回的源码（`execTimeout` 那一行用：要的是真 SIGTERM，不是"我们假装是 SIGTERM"）。 */
const HANG_SCRIPT = 'setTimeout(() => {}, 1_000_000_000)';
/** `maxBufferOverflow` 那一行往 stdout 写这么多字符，远大于任何调用方给的缓冲上限。 */
const OVERFLOW_BYTES = 200_000;

/** 先往 stdout/stderr 各写 `bytes` 个字符、再跑 `tail`。`bytes` 为 0 时就是 `tail` 本身。 */
const noiseScript = (bytes: number, tail: string): string =>
  bytes > 0 ? `process.stdout.write('y'.repeat(${bytes})); process.stderr.write('x'.repeat(${bytes})); ${tail}` : tail;

/**
 * **跑一次真 spawn**，把 node 抛出来的那个 error 原样交出去 —— `kernel.test.ts` 与 `tutorials.test.ts`
 * 两边判的都是它，不再各写一份造法（WI-107）。
 *
 * 为什么要同源，理由不是 DRY 本身：这两档判的是**同一个公共件的错误形状**，而形状判据的可信度取决于
 * "喂进去的那个对象真的是 node 造的"。两份造法可以各自漂（一份显式设 `stdio`、一份没设；一份带 40KB 噪声、
 * 一份没有），漂完之后两边喂的就不是同一个对象，于是"两边都有牙"这句话只在那一边成立 ——
 * 而坏掉的时候没有任何一条红会来通知你（实测：把 `kernel.test.ts` 那份造法换成手搓的 `{status:3, signal:null}`，
 * 本文件那一组的①照样绿、`tutorials.test.ts` 整档 exit 0）。⇒ 造法住在这里，两边 import。
 *
 * 三个不许退化的点：
 * ① **没抛就是红**，不许"那就喂一份手搓的"——那正是 `584c249` 修掉的那个病（全绿下面把话说反）。
 * ② `stdio` 显式设成 pipe：默认那一种会把子进程的 stderr **转发到父进程 stderr**，
 *    于是噪声那 40KB 会同时刷进测试报告 —— 而"报告不许是日志转储"恰恰是这套 plumbing 存在的理由。
 * ③ 噪声是**参数**不是造法的一部分：`tutorials.test.ts` 那条"有界"判据要在真字节上判（空 stderr 是空判），
 *    `kernel.test.ts` 那几组不需要。两种都从同一份 `noiseScript` 出来，所以字节数不同而形状相同。
 *
 * 返回 `Record<string, unknown>`：调用方要拿 `err.status` / `err.signal` / `err.code` **先钉形状再喂**
 * （少了钉形状那一段，"造真 error"这件事自己坏掉时判据只是安静地喂进别的东西）。
 *
 * ⚠ 这些形状是在**宿主 Windows / node v24.14.1** 上逐键量出来的（`killed` 键压根不存在、非 0 退出时
 * `code` 键也不存在）。容器那一档（Linux node）跑的是同一组常驻判据，所以形状若在两个平台不一致，
 * 红会红在这里 —— 那正是这里要的判据，不是需要绕过的麻烦。
 */
export function realExecError(spec: RealExecErrorSpec): Record<string, unknown> {
  const run = (): unknown => {
    switch (spec.kind) {
      case 'nonZeroExit':
        return execFileSync(process.execPath, ['-e', noiseScript(spec.noiseBytes ?? 0, `process.exit(${spec.exitCode ?? 3})`)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      case 'execTimeout':
        return execFileSync(process.execPath, ['-e', noiseScript(spec.noiseBytes ?? 0, HANG_SCRIPT)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: spec.timeoutMs,
        });
      case 'spawnEnoent':
        return execFileSync(MISSING_EXECUTABLE, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      case 'maxBufferOverflow':
        return execFileSync(process.execPath, ['-e', `console.log('x'.repeat(${OVERFLOW_BYTES}))`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: spec.maxBufferBytes ?? 1024,
        });
    }
  };
  try {
    // `run()` 的返回值**故意不用**：这条造法的唯一产出就是那个 error —— 子进程正常退出说明命令写错了，
    // 而"拿一个成功结果当 error 喂判据"正是本函数要防的那种谎，所以宁可抛。
    run();
  } catch (err) {
    return err as Record<string, unknown>;
  }
  throw new Error('execFileSync 没有抛 ⇒ 这一条没有真 error 可喂（node 的行为变了，或者这里的命令写错了）。把"没抛"当成通过，就是又造一个绿下面的谎');
}
