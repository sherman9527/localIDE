import { NOTEBOOK_KERNELS } from '@arena/shared';

/**
 * notebook 执行证据的**两处提取**（从 `server/test/notebooks/kernel.test.ts` 原样搬来，WI-90 Task 1 Step 2）。
 *
 * 为什么要搬而不是复制第三份：`kernel.test.ts`（A1 的 smoke 那一档）与 `tutorials.test.ts`（WI-90 的教程那一档）
 * 判的是同一件事的两半 —— "从 `jupyter nbconvert --to notebook --execute --stdout` 那份输出里只取
 * stdout 行与出错 cell 的条目"，以及"`execFileSync` 非 0 退出时说清是哪一种坏法"。
 * 这两件的教训都不是审美：它们在上一轮终审里被逐条打磨过（有界证据 / allow_errors 的分工 / 枚举里必须有 timeout 这一条自己），
 * 抄第二份的地方会各自漂，而漂掉的那一份**不会报错**，只会在下一次故障里给出比不判更差的报告。
 *
 * ⚠ 不要把它做成"从测试文件 import 测试文件"：`kernel.test.ts` 一被 import 就带着它那些
 * `describe.skipIf` 与 `beforeAll`（真的 `ensureIdeEnv`）在别人的档位里跑一遍。
 * ⇒ 工具住在**非** `.test.ts` 的模块里（本仓库的同类做法：`server/test/notebooks/` 下同目录的 helper）。
 * 它不在 `verify-coverage.test.ts` 的孤儿判据对象里（那条只收 `*.test.ts`），
 * 但它在 `server/tsconfig.test.json` 的 include 覆盖面里（`test` 目录下的全部 `.ts`）⇒ 类型检查照跑，
 * 覆盖面由 `typecheck-coverage.test.ts` 那条"不存在没被任何 tsconfig 认领的测试文件"钉住。
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
 * `code` 那份是**调用方映射过的形状**（`scalaKernelProbe.ts` 的 `evidenceShapedExecError` 与
 * `tutorials.test.ts` 那组手搓判据都把数字放在 `code` 上）—— 两种都要认，否则那一层 shim 会把真故障
 * 又搬回错支（这正是本轮修掉的那个病的另一种走法）。
 */
function exitEvidence(exitCode: string, from: 'status' | 'code', budget?: NbconvertBudget): string {
  return (
    `nbconvert 以 code=${exitCode} 非 0 退出（这个数取自 error 的 \`${from}\` 键 —— **进程自己的退出码**，不是 node 的错误名）⇒ ` +
    '这**不是**「某个 cell 抛了异常」：那种情况 --ExecutePreprocessor.allow_errors=True 会让它退 0、错误落成 output_type=error，' +
    '由「执行时抛异常的 cell」那条结构化断言报出 cell 号与异常名。非 0 退出说的是这一档跑不起来：' +
    `${NOTEBOOK_KERNELS.pyspark} 没注册 / venv 解释器缺失（这一档容器组第一条用例判的就是这个前提）、` +
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
