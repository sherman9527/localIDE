import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import type { NotebookFile } from '@arena/shared';

/**
 * 把仓库里的示例 notebook 铺进工作目录，**只补缺**。
 * `seeded` 说的是"这一次复制了它"，不是"文件存在" —— 前端用它区分"新铺的示例"与"你已有的那一份"。
 * 已存在的目标一律不碰：覆盖用户写的东西这件事不会报错，是本仓库最恨的那类静默损坏。
 */
export async function seedNotebooks(opts: { srcDir?: string; dstDir?: string } = {}): Promise<NotebookFile[]> {
  const srcDir = opts.srcDir ?? config.notebook.seedDir;
  const dstDir = opts.dstDir ?? config.notebook.workDir;
  await mkdir(dstDir, { recursive: true });

  const entries = await readdir(srcDir).catch(() => [] as string[]); // 没有示例目录不算错
  const out: NotebookFile[] = [];
  for (const name of entries.filter((n) => n.endsWith('.ipynb')).sort()) {
    const dstPath = join(dstDir, name);
    const already = await stat(dstPath).then(() => true).catch(() => false);
    if (already) {
      out.push({ file: name, seeded: false });
      continue;
    }
    await copyFile(join(srcDir, name), dstPath);
    out.push({ file: name, seeded: true });
  }
  return out;
}
