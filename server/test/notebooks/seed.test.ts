import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { seedNotebooks } from '../../src/notebooks/seed.js';

/**
 * 唯一的硬规矩是**不许覆盖**：用户写的内容只在 data/notebooks（bind mount），
 * 而 content/notebooks 每次 build 都进镜像 —— 无条件复制的话，一次 `--rebuild` 就吃掉人家的改动，
 * 而且一声不响。所以"改了还在"必须是断言，不能靠实现记得判断。
 */
async function dirs(): Promise<{ src: string; dst: string }> {
  const base = await mkdtemp(join(tmpdir(), 'arena-seed-'));
  const src = join(base, 'src');
  await mkdir(src, { recursive: true });
  return { src, dst: join(base, 'dst') };
}

describe('seedNotebooks', () => {
  it('目标缺失时复制并报告复制了哪几份', async () => {
    const { src, dst } = await dirs();
    await writeFile(join(src, 'a.ipynb'), '{"cells":[],"metadata":{"kernelspec":{"name":"arena-pyspark"}}}', 'utf8');
    const out = await seedNotebooks({ srcDir: src, dstDir: dst });
    expect(out).toEqual([{ file: 'a.ipynb', seeded: true }]);
    await expect(readFile(join(dst, 'a.ipynb'), 'utf8')).resolves.toContain('arena-pyspark');
  });

  it('用户改过的文件不许被还原', async () => {
    const { src, dst } = await dirs();
    await mkdir(dst, { recursive: true });
    await writeFile(join(src, 'a.ipynb'), '{"cells":[],"metadata":{}}', 'utf8');
    await writeFile(join(dst, 'a.ipynb'), '{"cells":[{"cell_type":"markdown","source":"我写的东西"}],"metadata":{}}', 'utf8');
    const out = await seedNotebooks({ srcDir: src, dstDir: dst });
    expect(out).toEqual([{ file: 'a.ipynb', seeded: false }]);
    await expect(readFile(join(dst, 'a.ipynb'), 'utf8')).resolves.toContain('我写的东西');
  });

  it('只认 .ipynb，别的文件不搬', async () => {
    const { src, dst } = await dirs();
    await writeFile(join(src, 'README.md'), 'x', 'utf8');
    await writeFile(join(src, 'b.ipynb'), '{"cells":[]}', 'utf8');
    expect(await seedNotebooks({ srcDir: src, dstDir: dst })).toEqual([{ file: 'b.ipynb', seeded: true }]);
  });
});
