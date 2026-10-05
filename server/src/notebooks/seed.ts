import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { NotebookFile } from '@arena/shared';

/**
 * 把仓库里的示例 notebook 铺进工作目录，**只补缺**。
 * `seeded` 说的是"这一次复制了它"，不是"文件存在" —— 前端用它区分"新铺的示例"与"你已有的那一份"。
 * 已存在的目标一律不碰：覆盖用户写的东西这件事不会报错，是本仓库最恨的那类静默损坏。
 *
 * 默认目录**只从 config 取**（`seedDir` / `workDir`），不许在这里出现字面路径：
 * 写死 `join(config.repoRoot,'data','notebooks')` 的回归不会撞红任何契约闸门（那条比的是
 * entrypoint ↔ config，压根不打开这个文件），症状正是它自己写的那句 ——
 * 示例铺在一个目录、Jupyter 打开的是另一个，页面里就是空的，一声不响。
 * 判据在 `server/test/notebooks/seed-defaults.test.ts`（fs 全 mock，不碰真人 `data/`）。
 */
export async function seedNotebooks(opts: { srcDir?: string; dstDir?: string } = {}): Promise<NotebookFile[]> {
  const srcDir = opts.srcDir ?? config.notebook.seedDir;
  const dstDir = opts.dstDir ?? config.notebook.workDir;
  await mkdir(dstDir, { recursive: true });

  // withFileTypes + isFile()（评审 M12）：光看名字尾巴 `.ipynb` 不够 —— 一个恰好叫
  // `x.ipynb` 的**目录**（手工建过、或某个工具留的）会让 `copyFile` 抛 EISDIR/EPERM，
  // 而这里的异常是没有兜底的：整个 seed 直接 reject，一个示例都铺不出来。
  // 这里不猜"为什么会留一个目录"，只保证它不该把整件事打断。
  const entries = await readdir(srcDir, { withFileTypes: true }).catch(() => [] as Dirent[]); // 没有示例目录不算错
  const names = entries.filter((e) => e.isFile() && e.name.endsWith('.ipynb')).map((e) => e.name).sort();
  const out: NotebookFile[] = [];
  for (const name of names) {
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
