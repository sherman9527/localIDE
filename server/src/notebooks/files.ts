import { readdirSync } from 'node:fs';
import { config } from '../config.js';
import type { NotebookFilesResponse } from '@arena/shared';

/**
 * 只读列目录：一次 readdirSync，不 stat 内容、不解析 ipynb。
 * 这个接口会被前端在每次进页面时调用，重活不许挂在读路径上（与 `status.ts` 顶部那条纪律同一条）。
 * ENOENT 归"没有"而非"坏了"：一个从没铺过示例的实例里那个目录本来就不存在，
 * 把它说成故障会让人去查磁盘，而该发生的事是"铺一份示例"（那正是同一个 GET 顺带做的 seed）。
 */
export function listNotebookFiles(dir: string = config.notebook.workDir): NotebookFilesResponse {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ipynb'))
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
