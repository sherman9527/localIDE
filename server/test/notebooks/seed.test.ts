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

  /**
   * 评审 M12：光看名字尾巴 `.ipynb` 会把**目录**也认成示例。
   * 那不会只少一个文件 —— `copyFile` 对目录抛 EISDIR/EPERM，而这个函数没有兜底 catch，
   * 于是整次 seed reject：一个示例都铺不出来，而调用方（Task 8 的 prepare）拿到的是一个 500。
   * 目录从哪来的不重要（手工 `mkdir content/notebooks/foo.ipynb` 就能复现），重要的是它不该打断。
   */
  it('名字恰好以 .ipynb 结尾的目录不是示例：跳过它，且整次 seed 不许 reject', async () => {
    const { src, dst } = await dirs();
    await mkdir(join(src, 'not-a-notebook.ipynb'), { recursive: true });
    await writeFile(join(src, 'keep.ipynb'), '{"cells":[],"metadata":{}}', 'utf8');
    const out = await seedNotebooks({ srcDir: src, dstDir: dst });
    expect(out, '目录被当成示例 ⇒ copyFile 会抛，整次 seed reject').toEqual([{ file: 'keep.ipynb', seeded: true }]);
    await expect(readFile(join(dst, 'keep.ipynb'), 'utf8')).resolves.toContain('cells');
  });
});
