import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 评审 I-4：`seedNotebooks()` 的**默认目录**必须是从 config 派生的那一个。
 *
 * 为什么现有闸门兜不住它：`notebook-contract.test.ts` 那条叶子名判据比的是
 * `docker/entrypoint.sh` ↔ `config`，它**从不打开 seed.ts**。所以把这里写成
 * `join(config.repoRoot,'data','notebooks')` 不会撞红任何东西 —— 而症状正是那条闸门
 * 自己写的错误文案：示例铺在一个目录、Jupyter 打开的是另一个，页面里就是空的，一声不响。
 * （宿主默认 env 下 `config.notebook.workDir` 恰好**等于**那个写死值，所以"不传参调一次、
 * 断言参数相等"还不够 —— 必须把 `ARENA_DATA_DIR` 注入成仓库之外的目录，两者才会分叉。
 * 这与 `notebook-contract.test.ts` 那条「workDir / warehouseDir 跟着注入的 ARENA_DATA_DIR 走」是
 * 同一个道理：派生关系只能在 env 被换掉之后判。）
 *
 * 为什么用 mock 而不是真跑：默认值就是**真人那份 `data/`**，宿主测试里照它跑一次就会
 * 在人家目录下建目录、写文件（本仓库的隔离纪律，见 WI-40）。这里 `node:fs/promises` 的
 * 四个具名导入全被替身接管 ⇒ 真字节一个都不会落盘，而"落到哪儿"仍然是可断言的参数。
 */

/** 替身：只换 seed 用到的那四个，其余保持真实现（`config.ts` 用的是 node:fs 的同步 API，不受影响）。 */
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => [] as Array<{ name: string; isFile: () => boolean }>),
  stat: vi.fn(async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  copyFile: vi.fn(async () => undefined),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, ...fsMock };
});

/** 仓库之外的哨兵数据目录：写死 `repoRoot/data` 的实现与它必然对不上。 */
const SENTINEL = resolve(join(tmpdir(), 'arena-seed-defaults-gate'));

/** 注入 env 后重新 import config 与 seed（两者必须是同一份新实例，否则判的是缓存里的旧值）。 */
async function loadInjected() {
  const saved = process.env.ARENA_DATA_DIR;
  process.env.ARENA_DATA_DIR = SENTINEL;
  vi.resetModules();
  try {
    const [{ config }, seed] = await Promise.all([import('../../src/config.js'), import('../../src/notebooks/seed.js')]);
    return { config, seedNotebooks: seed.seedNotebooks };
  } finally {
    if (saved === undefined) delete process.env.ARENA_DATA_DIR;
    else process.env.ARENA_DATA_DIR = saved;
    vi.resetModules();
  }
}

/** 已出现过的所有路径参数（mkdir/readdir/stat/copyFile 的每一个字符串实参）。 */
function everyPathArg(): string[] {
  const out: string[] = [];
  for (const fn of Object.values(fsMock)) {
    for (const call of fn.mock.calls) for (const a of call) if (typeof a === 'string') out.push(a);
  }
  return out;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('seedNotebooks 的默认目录（不传参数那一条路径）', () => {
  afterEach(() => {
    for (const fn of Object.values(fsMock)) fn.mockClear();
  });

  it('dstDir 默认 = 注入后的 config.notebook.workDir，而不是写死的仓库 data/notebooks', async () => {
    const { config, seedNotebooks } = await loadInjected();
    // 空转防护：注入没生效的话 workDir 就等于那个写死值，下面的断言全在自证
    expect(config.dataDir, 'ARENA_DATA_DIR 注入没生效 ⇒ 这条闸门退化成"两个相同的表达式比相等"').toBe(SENTINEL);
    const workDir = join(SENTINEL, 'notebooks');
    expect(config.notebook.workDir, 'config 自己没派生对 ⇒ 先修 config，别改这条判据').toBe(workDir);
    expect(
      workDir,
      '哨兵目录必须与"写死 repoRoot/data"不同，否则本条判据毫无力量',
    ).not.toBe(join(config.repoRoot, 'data', 'notebooks'));

    fsMock.readdir.mockResolvedValueOnce([{ name: 'a.ipynb', isFile: () => true }]);
    const out = await seedNotebooks(); // ← 一个参数都不给，判的就是 DEFAULT

    expect(out).toEqual([{ file: 'a.ipynb', seeded: true }]);
    expect(fsMock.mkdir, 'mkdir 的参数不是 config.notebook.workDir ⇒ 默认目录被写死了').toHaveBeenCalledWith(workDir, { recursive: true });
    expect(fsMock.stat).toHaveBeenCalledWith(join(workDir, 'a.ipynb'));
    expect(fsMock.copyFile).toHaveBeenCalledWith(join(config.notebook.seedDir, 'a.ipynb'), join(workDir, 'a.ipynb'));
  });

  it('srcDir 默认 = config.notebook.seedDir，且整次调用不碰真人 data/ 一个字节', async () => {
    const { config, seedNotebooks } = await loadInjected();
    fsMock.readdir.mockResolvedValueOnce([{ name: 'a.ipynb', isFile: () => true }]);
    await seedNotebooks();

    expect(config.notebook.seedDir).toBe(join(config.repoRoot, 'content', 'notebooks'));
    expect(fsMock.readdir).toHaveBeenCalledWith(config.notebook.seedDir, { withFileTypes: true });
    // 承重的那条：真人那份 data/ 里 `notebooks` 恰好是默认值时会写进去，这里判"根本没打算写"
    const realData = join(config.repoRoot, 'data');
    const touched = everyPathArg().filter((p) => inside(p, realData));
    expect(touched, `默认路径落进了真人实例的 ${realData}（WI-40 的隔离纪律）：${JSON.stringify(touched)}`).toEqual([]);
  });
});
