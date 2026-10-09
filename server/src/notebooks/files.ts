import { readdirSync } from 'node:fs';
import { config } from '../config.js';
import type { NotebookFilesResponse } from '@arena/shared';

/**
 * 只读列目录：一次 readdirSync，不 stat 内容、不解析 ipynb。
 * 这个接口会被前端在每次进页面时调用，重活不许挂在读路径上（与 `status.ts` 顶部那条纪律同一条）。
 * ENOENT 归"没有"而非"坏了"：一个从没铺过示例的实例里那个目录本来就不存在，把它说成故障会让人去查磁盘，
 * 而该发生的事是"铺一份示例" —— 铺的动作挂在**同一个页面进入时的 `/api/notebook/status` 那一发**上
 * （`server/src/api/app.ts` 的 status 路由调 `seedNotebooks()`），**这个接口自己不铺**：
 * `app.ts` 里那条 files 路由只有 `listNotebookFiles()` 一个调用。把两句混成"同一个 GET 顺带做的 seed"
 * 会让读者把"目录一直不存在"读成自愈失败（评审 M-1）。
 *
 * 过滤器认 `isFile() || isSymbolicLink()`（评审 M-4）：只认 `isFile()` 的话，**软链进来的 `.ipynb`
 * 既不报错也不出现** ⇒ 界面报"目录里现在没有笔记"，而真相是"有，但我的过滤器看不见"—— 那是第三句
 * 没人说过的谎，"没有"与"读不到"那两句判据都覆盖不到它。软链指向哪儿、目标存不存在，不是这个只读
 * 列目录该判断的事（打开它的是 Jupyter，它自己会说不存在）；这里要的只是"这个名字在目录里"。
 * ⚠ 判据 `server/test/api/notebook-files.test.ts` 那条软链用例在**建不了软链的平台上会 skip**
 * （Windows 无开发者模式时 `symlinkSync` = `EPERM`，本机实测），同文件另有一条永远会跑的 it 说清原因。
 */
export function listNotebookFiles(dir: string = config.notebook.workDir): NotebookFilesResponse {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.ipynb'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
    return { files };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 只豁免 ENOENT（"还没有目录" = "还没有示例"）。brief 的代码里原本还并写了 ENOTDIR，
    // 那是与它自己的测试相矛盾的 bug：readdir 一个**普通文件**在本机实测就是 ENOTDIR
    // （`server/test/api/notebook-files.test.ts` 第四条靠它造"必然会失败的 readdir"），
    // 一并豁免会把"读不到"说成"没有"—— 正是本仓库最恨的静默降级（seedError 那条纪律的反面）。
    if (code === 'ENOENT') return { files: [] };
    return { files: [], error: `读不到 notebook 工作目录（${code ?? '未知原因'}）：${(err as Error).message}` };
  }
}
