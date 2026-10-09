import { describe, expect, it } from 'vitest';
import { notebookDocPath } from '../src/notebook.js';

/**
 * 评审 I-4：`notebookDocPath()` 的"**逐段** encode"这一维必须有**字面量期望**的判据。
 *
 * 为什么这一档就要写、不等 Task 6：Task 6 brief 第 37 行那条断言写的是
 * `expect(frame.getAttribute('src')).toBe(notebookDocPath('02-partitions.ipynb'))` ——
 * 期望值与被测物同源，于是"逐段 encode"这个行为**永不可证伪**：把函数体改成整串
 * `encodeURIComponent(file)`，Task 6 那条照样绿，而症状是"文件名里带空格 / 中文 / `#` 的那份笔记
 * 在 iframe 里 404"，而 `content/notebooks` 里那份 `00-smoke-pyspark.ipynb` 名字安全 ⇒ 继续绿。
 * （复审 m9 记一句实况：当年这里写的是"目前**唯一**那份"，WI-90 的 `01-`/`02-` 教程落地后已经不作数了。
 * **结论一个字没动** —— 目录里现在这几份的文件名仍然只含 `[0-9a-z.-]`，一个需要 encode 的字符都没有，
 * 所以这个故障在它们身上照样是哑的，这一档的判据对象只能是下面那些**手写的**多段/空格/中文名字。）
 * 这是本仓库在 `kernels` / `kernelspecs` fixture 上付过学费的同一种形状（见
 * `server/test/regression/notebook-contract.test.ts` 里那段"键名当年与实现同源写错"）。
 *
 * ⚠ 下面每一条期望值都是**手写的字面量**。不许改成由 `notebookDocPath(...)` 或
 * `NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL` 派生 —— 派生一次，这个文件就退化成自证。
 *
 * 破坏性验证（2026-10-09 两次各改坏一次 `shared/src/notebook.ts` 的函数体，跑
 * `npx vitest run shared/test/notebook-path.test.ts`，退出码单独 echo）：
 * ① 改成**整串** `encodeURIComponent(file)` ⇒ `DV_I4_EXIT=1`、`Tests 1 failed | 3 passed (4)`，
 *    红的**只有**多段那一条：`expected '/jupyter/notebooks/a%20b%2Fc%20d%3Fe.…' to be
 *    '/jupyter/notebooks/a%20b/c%20d%3Fe.ip…'`（`%2F` 就在 received 里）。
 *    ⚠ 这一条实测顺手推翻了我自己写注释时的一个推测：**"空格 / 中文 / # 那几条也会跟着红"是错的**
 *    —— 名字里没有 `/` 时整串 encode 与逐段 encode 逐字节相同，所以那三条对这一维是**空转**的；
 *    能把"整串 encode"这个故障判住的**只有多段那一条**。那三条不是白写（见 ②），但它们判的是另一维。
 * ② 改成**完全不 encode**（`${file}` 原样拼）⇒ `DV_I4B_EXIT=1`、`Tests 3 failed | 1 passed (4)`，
 *    received 分别是 `…/我的 笔记#1.ipynb`、`…/q?mark.ipynb`、`…/a b/c d?e.ipynb`
 *    ⇒ 空格 / 中文 / `#` / `?` 这几维各自都有判据。两次变异互为对照：**整串 encode 只有多段那条会红，
 *    完全不 encode 只有名字安全那条不红** —— 少任一类样本，就有一类错法没人管。
 * 还原：②之后用 `git checkout -- shared/src/notebook.ts` 把整个函数体退回原样（①的形状是被 ② 覆盖掉的，
 * 中间没有单独还原过一次），还原后 `npx vitest run shared/test/notebook-path.test.ts` ⇒ `Tests 4 passed (4)`。
 */
describe('notebookDocPath 的逐段 encode（期望值是字面量，不由被测函数派生）', () => {
  it('名字安全的文件名：前缀与 /notebooks/ 原样出现', () => {
    expect(notebookDocPath('00-smoke-pyspark.ipynb')).toBe('/jupyter/notebooks/00-smoke-pyspark.ipynb');
  });

  it('空格与中文与 # 在同一段里各自编码（# 不编码会被读成 fragment ⇒ 路径截断）', () => {
    expect(notebookDocPath('我的 笔记#1.ipynb')).toBe(
      '/jupyter/notebooks/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0%231.ipynb',
    );
  });

  it('? 编码成 %3F（不编码它会被读成 query string ⇒ jupyter 找的是 "q"）', () => {
    expect(notebookDocPath('q?mark.ipynb')).toBe('/jupyter/notebooks/q%3Fmark.ipynb');
  });

  it('多段路径里的 "/" 保持原样：整串 encode 会把它吃成 %2F ⇒ jupyter 当成一段路径，打不开文件', () => {
    expect(notebookDocPath('a b/c d?e.ipynb')).toBe('/jupyter/notebooks/a%20b/c%20d%3Fe.ipynb');
  });
});
