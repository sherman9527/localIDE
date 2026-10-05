import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * Task 5 的契约闸门：类型住在 `shared`（服务端与页面共用一份真相，同 `shared/src/ide.ts` 的先例），
 * 路径住在 `config`。这里钉的是**取值**而不是类型（类型由 `npm run typecheck` 管）：
 * 端口、目录这些一旦有两处各写一份，漂移的那处不会报错，只会让人拿到打不开的链接
 * （本项目在桥 token 上撞过同一次，WI-86）。
 *
 * `warehouseDir` 那条 `not.toContain('judge')` 是唯一的"负向"断言，也是最重要的一条：
 * 判题跑完会清空 `data/judge`，notebook 的 Spark warehouse / Derby 若落在同一棵树里，
 * 就是"做过一次题 → 笔记本里的表没了"或反过来互删。这种删除不会报错，只会静默丢数据。
 */
describe('notebook 契约与配置', () => {
  it('config.notebook 各字段都在 dataDir 下，且不碰判题沙箱目录', () => {
    expect(config.notebook.publicUrl).toBe('http://127.0.0.1:7789');
    expect(config.notebook.port).toBe(8888);
    // 路径比较用 join() 而不是模板里的 `/`：config 那边是 join 出来的（Windows 宿主上是 `\`），
    // 写死分隔符的期望值在 verify:fast 真正跑的那台机器（宿主）上必然冤红。
    // 仓库既有写法同理：config.test.ts 用 resolve(DATA_DIR, 'judge')、
    // ide-env-isolation.test.ts 用 join(config.dataDir, 'ide-env')。
    expect(config.notebook.workDir).toBe(join(config.dataDir, 'notebooks'));
    expect(config.notebook.warehouseDir).toBe(join(config.dataDir, 'notebook-warehouse'));
    expect(config.notebook.warehouseDir, '混进判题沙箱目录就会互删（判题跑完要清空 data/judge）').not.toContain('judge');
  });

  it('kernel id 只有一份真相（entrypoint、镜像、前端、测试都用这个常量）', () => {
    expect(NOTEBOOK_KERNELS.pyspark).toBe('arena-pyspark');
  });

  /**
   * 上面那条用例的名字写着"镜像也用这个常量"，但只比字符串本身是**自证**：改常量、不改
   * `docker/jupyter/kernels/` 的目录名，它照样绿，而界面上的 kernel 会永远 ready:false。
   * 这条把名字与工件钉在一起 —— 判据是"按常量拼出来的路径存在"，纯读文件，宿主可跑（不需要 Docker）。
   */
  it('常量与镜像里的 kernelspec 目录同名（否则"一份真相"只是说说）', () => {
    const specFile = join(config.repoRoot, 'docker', 'jupyter', 'kernels', NOTEBOOK_KERNELS.pyspark, 'kernel.json');
    expect(
      existsSync(specFile),
      `${NOTEBOOK_KERNELS.pyspark} 在 docker/jupyter/kernels/ 下没有同名目录 ⇒ 常量与镜像工件分叉了：` +
        'kernelspec 改名的话要同时改 shared/src/notebook.ts，否则前端列不出可用 kernel',
    ).toBe(true);
  });
});
