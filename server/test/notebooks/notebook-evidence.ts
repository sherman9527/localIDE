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
 * `execFileSync('jupyter', ['nbconvert', …])` **非 0 退出**时该说的那句话（评审 I-1 的后半）。
 * 加了 `--ExecutePreprocessor.allow_errors=True` 之后，这条路只剩「这一档根本跑不起来」那一类故障
 * （kernel 起不来 / DeadKernelError / stdout 撑破 maxBuffer / 预算到点），它们与「某个 cell 抛了异常」是两件事：
 * 后者现在是数据（`output_type=error` → `executedNotebookEvidence` 报「cell 号 + 异常名」），不再是异常。
 * 这里不许把 node 原样的 `err.message` 抛出去：它整段拼进了 stderr（Spark 的 stderr 无上界），
 * 一次失败就把测试报告写成日志转储 —— 那正是 `kernel.test.ts` 把断言从整本 notebook 收进「三行」的同一个理由。
 *
 * ⚠ **预算数字只能由调用方传**（评审 M2）。这份 plumbing 现在被两档共用而两档的预算不同：
 * `kernel.test.ts` 那条 smoke 用例是 execFileSync 180s / vitest 200s，`tutorials.test.ts` 那边是
 * execFileSync 135s / vitest 150s / cell 120s。搬过来时逐字照抄的那几句仍在说 `180_000` 与"本文件那条用例的
 * 预算也只有 200s" ⇒ 教程超时（**这条闸门最可能的真故障**）会被报成别人的数字，把人赶去查隔壁文件。
 * 不传 `budget` 就是刻意允许的形状（`kernel.test.ts` 没改，它继续吃那句不点名的话），不是漏接线。
 *
 * 评审 M2 的另一半：`execFileSync` 的超时是 SIGTERM 杀进程 —— `code` 是 `undefined`、`killed` 是 `true`，
 * 而这里过去**只读 `e.code`**，于是最常见的坏法被印成"这一档跑不起来"那三条此刻并不成立的原因。
 * 现在 `killed`/`signal` 一起判读，超时单独成一支。行为敢这么改是因为它有了自己的**形状判据**
 * （`tutorials.test.ts` 常驻那组「nbconvertCrashEvidence 的形状」）：抽成公共件之前它只在崩溃路径执行、
 * 绿跑永远碰不到，一次漂移的爆炸半径在两档之间翻倍。
 */
export function nbconvertCrashEvidence(err: unknown, budget?: NbconvertBudget): string {
  const e = err as { code?: number | string; signal?: string | number; killed?: boolean; stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const tail = `stderr ${stderr.length} 字节 / stdout ${stdout.length} 字节，只贴 stderr 末尾 ${STDERR_TAIL} 字符：\n` + stderr.slice(-STDERR_TAIL);
  // 「被信号杀掉」与「非 0 退出」是两种红：前者没有 code，按后面那三条查会白跑一趟。
  if (e.killed === true || (e.code === undefined && e.signal !== undefined)) {
    return (
      `nbconvert 被 signal=${e.signal ?? '(未知)'} 终止（killed=true、没有 exit code）⇒ **先想超时/预算**，` +
      `${timeoutWording(budget)}。` +
      '这一支与"非 0 退出"那三类故障是两件事：这里进程是被外力结束的，`code` 天生为空，' +
      'kernel 注册与 venv 那些假设**不成立也不被判**（它们各有自己的用例）。' +
      tail
    );
  }
  return (
    `nbconvert 以 code=${e.code ?? '(没有 code)'} 非 0 退出 ⇒ 这**不是**「某个 cell 抛了异常」：` +
    '那种情况 --ExecutePreprocessor.allow_errors=True 会让它退 0、错误落成 output_type=error，' +
    '由「执行时抛异常的 cell」那条结构化断言报出 cell 号与异常名。非 0 退出说的是这一档跑不起来：' +
    `${NOTEBOOK_KERNELS.pyspark} 没注册 / venv 解释器缺失（这一档容器组第一条用例判的就是这个前提）、` +
    'DeadKernelError（Spark 崩在半路）、stdout 撑破了 maxBuffer，' +
    // 枚举里必须有**这一条自己**：到点时被 SIGTERM 杀掉，code 一样非 0/为空 ——
    // 它过去不在列出的原因里，于是最常见的坏法被印成"几条此刻并不成立的原因"（函数上方那段警告说的同一件事）。
    `或${timeoutWording(budget)}（先想这一条，再去看上面那三条）。` + tail
  );
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
