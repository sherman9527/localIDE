/**
 * 每篇教程必须打出的**结论 slug**（WI-90 Task 1；闸门按这份表核对 marker，Ruling(B1)）。
 *
 * 它故意住在 notebook **外面**：期望值若由被测文件自己声明，"删一条结论"就同时删掉了判据 ——
 * 那种判据不是松，是**根本没有**（`server/test/notebooks/tutorials.test.ts` 的注释里写的是同一件事）。
 *
 * key = notebook 的**文件名**（不含目录，含 `.ipynb`），必须与 `content/notebooks/` 里的每一篇
 * 非 `00-` 教程一一对应：多一条、少一条都会红在 `tutorials.test.ts` 常驻那一组的
 * 「清单完整性」上（那条在宿主就红，不用等一次容器验证）。
 * `00-smoke-pyspark.ipynb` **不许**出现在这张表里 —— 它由 `kernel.test.ts` 真跑，
 * 这里再登记一遍等于在容器档里多起一次 Spark（40-90s），而两次执行不构成两条判据。
 *
 * slug 的形状 `[a-z0-9-]`：它要出现在 marker 里、也要出现在失败消息里，别放空格与中文。
 * 形状判据在同一条常驻断言里（`tutorials.test.ts`）。
 *
 * ⚠ 空表是 Task 1 的**正确状态**（教程是 Task 2/3/4 的交付物）。
 * 那时这张表一旦有了条目而 `content/notebooks/` 里还没有对应的文件，红的是"注册表与目录不一致"，
 * 反过来（有文件没条目）红的是同一句 —— 两个方向都是它，所以"加了教程忘了接闸门"不会静默。
 */
export const TUTORIAL_CLAIMS: Record<string, string[]> = {};

/**
 * 单篇教程的执行预算（**毫秒**）。规格给的目标是"单篇 ≤ 90s"，这里留 120s 是余量不是预算。
 * 注意单位：nbclient 的 `--ExecutePreprocessor.timeout` 按**秒**算，所以传出去之前要除 1000
 * （那一步与"除完的量级还在 30~600 之间"由 `tutorials.test.ts` 常驻那组判住）。
 */
export const TUTORIAL_TIMEOUT_MS = 120_000;

/**
 * marker 的字面形状（规格 §6 / 计划 Ruling(B1)：`WI90[<篇>][<结论 slug>] OK`）。
 * 教程那边是手敲的 `print("WI90[01-skew-and-hot-keys][salting-wins] OK")`，闸门这边按它核对 ——
 * 两边唯一的粘线就是这个函数，所以它的格式由 `tutorials.test.ts` 里那份**独立字面量基准**判住：
 * 有人把它改成别的写法（"更清晰"），红在 45s 的宿主档并说出该改哪一边，
 * 而不是让容器里每条 marker 断言红着指责一篇没坏的教程。
 */
export function markerOf(file: string, slug: string): string {
  return `WI90[${file.replace(/\.ipynb$/, '')}][${slug}] OK`;
}
