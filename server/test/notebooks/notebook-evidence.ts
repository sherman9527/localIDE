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
 * `execFileSync('jupyter', ['nbconvert', …])` **非 0 退出**时该说的那句话（评审 I-1 的后半）。
 * 加了 `--ExecutePreprocessor.allow_errors=True` 之后，这条路只剩「这一档根本跑不起来」那一类故障
 * （kernel 起不来 / DeadKernelError / stdout 撑破 maxBuffer），它们与「某个 cell 抛了异常」是两件事：
 * 后者现在是数据（`output_type=error` → `executedNotebookEvidence` 报「cell 号 + 异常名」），不再是异常。
 * 这里不许把 node 原样的 `err.message` 抛出去：它整段拼进了 stderr（Spark 的 stderr 无上界），
 * 一次失败就把测试报告写成日志转储 —— 那正是本文件把断言从整本 notebook 收进「三行」的同一个理由。
 *
 * 一条**已知的局限**（评审 minor：只记账，不改行为）：这里只读 `e.code`，不读 `e.signal` 与 `e.killed`，
 * 而下面那句"非 0 退出说的是这一档跑不起来"枚举的四条原因里**漏了 `timeout: 180_000`** ——
 * `execFileSync` 超时是 SIGTERM 杀进程（`code` 是 undefined、`killed` 是 true），所以真撞超时的时候
 * 这句话会印成 `code=(没有 code)` 再附上四条此刻并不成立的原因。看到那行时**先想超时**
 * （Spark 冷启动撑到 180s 是现实可能，本文件那条用例的预算也只有 200s），别按那四条去查 kernel 注册。
 * 把 signal/killed 一起判读要动行为，留给有测试兜着的那一轮做。
 */
export function nbconvertCrashEvidence(err: unknown): string {
  const e = err as { code?: number | string; stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  return (
    `nbconvert 以 code=${e.code ?? '(没有 code)'} 非 0 退出 ⇒ 这**不是**「某个 cell 抛了异常」：` +
    '那种情况 --ExecutePreprocessor.allow_errors=True 会让它退 0、错误落成 output_type=error，' +
    '由「执行时抛异常的 cell」那条结构化断言报出 cell 号与异常名。非 0 退出说的是这一档跑不起来：' +
    `${NOTEBOOK_KERNELS.pyspark} 没注册 / venv 解释器缺失（见「venv 的解释器真的在」那条）、` +
    'DeadKernelError（Spark 崩在半路）、stdout 撑破了 maxBuffer，' +
    // 枚举里必须有**这一条自己**：execFileSync 的 `timeout: 180_000` 到点会直接杀掉 nbconvert，
    // code 一样非 0 —— 而它过去不在列出的原因里，于是最常见的坏法（Spark 冷启动撑到预算尽头）
    // 被印成"四条此刻并不成立的原因"，把人往 kernel 注册那三条上赶（函数上方那段警告说的是同一件事）。
    '或这条用例自己的 180s 预算到点（先想这一条，再去看上面那三条）。' +
    `stderr ${stderr.length} 字节 / stdout ${stdout.length} 字节，只贴 stderr 末尾 ${STDERR_TAIL} 字符：\n` +
    stderr.slice(-STDERR_TAIL)
  );
}

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
