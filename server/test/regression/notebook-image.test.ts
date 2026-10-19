import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * kernelspec 有三条各自会咬人的判据：
 * ① 必须装在**镜像级**目录 —— 装进 venv 的话，WI-87 的「重置环境」会把 kernel 一起删掉，
 *    而界面只显示"打不开"，不解释为什么；
 * ② argv[0] 必须等于 compose 里 ARENA_IDE_ENV_DIR 派生出来的解释器路径 —— 写死字面量就是
 *    第二处真相，compose 一改就悄悄不成立（本仓库对这类"两处各写一遍"栽过很多次）。
 *    venv **内部布局**（python/bin/python）的权威在 server/src/ide/env.ts:venvPythonPath 的
 *    Linux 分支，这里不 import 该函数来派生期望值，原因是它就是没法 import：本闸门跑在宿主
 *    （Windows 开发机 + verify:fast），venvPythonPath 在 win32 返回 `<root>\python\Scripts\python.exe`
 *    —— 分隔符、文件名、root 前缀三处都和 kernel.json（Linux 工件）对不上；把
 *    process.platform 按下去再调用也不行，env.ts 顶层 `import { join } from 'node:path'`
 *    绑的是**加载时平台**的 join。import ⇒ 闸门在宿主永红。折中路由（评审控制方裁定）：
 *    本文件核对 compose 派生的根 + kernel.json 文件内相等断言（argv[0] ↔ PYSPARK_DRIVER_PYTHON）
 *    消掉第四处字面量，布局漂移由 kernel.json 的 metadata.arena_sync_note 指回 env.ts。
 * ③ Spark 的配置只能待在 PYSPARK_SUBMIT_ARGS 里，且必须以 `pyspark-shell` 收尾：
 *    写成普通环境变量**完全没效果**，少了尾缀则 --conf 会被当成应用参数。
 */

const root = config.repoRoot;
/**
 * kernel 目录名从注册表（`NOTEBOOK_KERNELS` 各条目的 `id`）派生，不写字面量：本闸门验的就是
 * "只有一份真相"，而它自己再抄一份的话，常量改了这条闸门反而看不见（还绿在旧目录上），
 * 反过来把字面量当真相又会让"常量 ↔ 镜像工件"的分叉无人看管。
 * ⚠ WI-91b Task 3（裁定 T3-4）：读**注册表全体**，不许只读 pyspark —— 新登记的
 * `arena-scala-toree` 的 kernel.json 与它的 Dockerfile COPY 行必须落在同一份真相的管辖下。
 */
interface KernelSpecJson {
  argv: string[];
  display_name: string;
  language?: string;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
}
const SPECS_BY_ID: Record<string, KernelSpecJson> = {};
for (const k of Object.values(NOTEBOOK_KERNELS)) {
  const specFile = join(root, 'docker', 'jupyter', 'kernels', k.id, 'kernel.json');
  // 分叉时报"哪个名字对不上"，不要只丢一句 ENOENT 让人去猜是哪一侧改的
  // （notebook-contract.test.ts 里有同一条判据、带同一句解释；这里再挡一次是因为本文件读得更深）。
  if (!existsSync(specFile)) {
    throw new Error(
      `${specFile} 不存在 ⇒ NOTEBOOK_KERNELS 登记的 '${k.id}' 与 docker/jupyter/kernels/ 下的目录名分叉了：` +
        '改常量要同时改目录（和 Dockerfile 的 COPY 目标），否则前端的 kernel 永远 ready:false',
    );
  }
  SPECS_BY_ID[k.id] = JSON.parse(readFileSync(specFile, 'utf8')) as KernelSpecJson;
}
/** pyspark 那一条的深度判据（argv/venv/SUBMIT_ARGS）沿用这份 —— 它们只对该 kernel 成立。 */
const kernel = SPECS_BY_ID[NOTEBOOK_KERNELS.pyspark.id]!;
const compose = readFileSync(join(root, 'compose.yml'), 'utf8');
const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8');

/**
 * 注册表逐条的镜像工件闸门（Task 3 / T3-4）：每条登记的 kernel 都要有
 * ① 工作树里的 kernelspec 目录（上面模块级已响亮地判过存在，这里是可报告的断言层）、
 * ② Dockerfile 把它 COPY 进**镜像级** `/usr/local/share/jupyter/kernels/<id>/` 的行。
 * 派生自注册表 ⇒ 加一条 kernel 忘了落工件，这里红；反过来工件在、注册表没登记，
 * `notebook-contract.test.ts` 那份钉死的 id 清单红。两向合起来才是"一份真相"。
 */
describe('注册表逐条：每条 kernel 的 kernelspec 都被 Dockerfile COPY 进镜像级目录', () => {
  for (const k of Object.values(NOTEBOOK_KERNELS)) {
    it(`${k.id}：kernelspec 工件在场且被 COPY`, () => {
      expect(
        existsSync(join(root, 'docker', 'jupyter', 'kernels', k.id, 'kernel.json')),
        `${k.id} 在工作树 docker/jupyter/kernels/ 下没有 kernel.json ⇒ 注册表说它有这条 kernel，工件却不在`,
      ).toBe(true);
      const kernelLines = dockerfile.split('\n').filter((l) => /jupyter\/kernels/.test(l));
      expect(
        kernelLines.some((l) => /^COPY\s/.test(l) && l.includes(`/usr/local/share/jupyter/kernels/${k.id}/`)),
        `Dockerfile 没有把 ${k.id} 的 kernelspec 放进 /usr/local/share/jupyter/kernels/${k.id}/ 的 COPY 行 ⇒ 镜像里没有它，页面会永远报"没注册"`,
      ).toBe(true);
    });
  }
});

describe(`${NOTEBOOK_KERNELS.pyspark.id} kernelspec`, () => {
  it('argv 指向 venv 解释器：compose 三处 ARENA_IDE_ENV_DIR 均为绝对路径且一致，PYSPARK_DRIVER_PYTHON 与 argv[0] 同值', () => {
    // 旧判据只吃三处（arena / dev / e2e 三个服务块里各自的 `ARENA_IDE_ENV_DIR:` 那一行 ——
    // 按服务名定位，不写行号：行号会漂，上一轮这里就漂成了 `:44/:134/:173` 那种"今天对、下轮错"的引用）
    // 里的**第一处**，
    // dev/e2e 漂移无人看管；且 \S+ 会把 YAML 引号一并捕获，`ARENA_IDE_ENV_DIR: "/opt/arena-ide-env"`
    // 这种语义等价的写法会冤红。现在：只认以 `/` 开头的值（引号可选），三处必须全部命中且相等。
    const matches = [...compose.matchAll(/^\s*ARENA_IDE_ENV_DIR:\s*"?(\/[^\s"]*)"?\s*$/gm)];
    expect(
      matches.length,
      'compose 应有 3 处绝对路径的 ARENA_IDE_ENV_DIR（arena/dev/e2e 各一）；不是 3 就说明有服务改了写法（相对路径不算）',
    ).toBe(3);
    const dirs = Array.from(new Set(matches.map((m) => m[1])));
    expect(
      dirs.length,
      `三个服务的 ARENA_IDE_ENV_DIR 分叉了：${dirs.join(' | ')} ⇒ kernel 的解释器在某个服务里指向不存在的目录`,
    ).toBe(1);
    const dir = dirs[0];
    // 字面量 python/bin/python 是 env.ts Linux 分支的镜像：那边的布局一改，这里与 kernel.json 必须同步。
    expect(kernel.argv[0]).toBe(`${dir}/python/bin/python`);
    // kernel.json 里 PYSPARK_DRIVER_PYTHON 与 argv[0] 是同一条路径的第四份抄写，文件内相等断言把它钉死。
    expect(kernel.env?.PYSPARK_DRIVER_PYTHON, 'PYSPARK_DRIVER_PYTHON 必须与 argv[0] 完全一致').toBe(kernel.argv[0]);
    expect(kernel.argv).toEqual(expect.arrayContaining(['-m', 'ipykernel_launcher', '{connection_file}']));
    // 本文件头部 ② 那句「布局漂移由 kernel.json 的 metadata.arena_sync_note 指回 env.ts」过去只是
    // **注释里的声称**：没有任何判据看过这份 note 在不在。有人删掉 metadata 里那一项，那句声称照样
    // "成立"，而下一个改 `venvPythonPath` 的人就丢了这条唯一指向 kernel.json 的回程线索（第四处真相
    // 就是这么养出来的）。现在它有一条 expect。
    expect(
      kernel.metadata?.arena_sync_note ?? '',
      'kernel.json 的 metadata.arena_sync_note 必须在场并点名 server/src/ide/env.ts —— notebook-image.test.ts 头部 ② 的声称靠这一行撑着',
    ).toMatch(/env\.ts/);
  });

  it('display_name 不写死 Spark 版本（版本号只在 Dockerfile 的 ARG 里）', () => {
    expect(kernel.display_name).toBe('PySpark (arena)');
    expect(kernel.display_name).not.toMatch(/3\.\d+\.\d+/);
  });

  it('Spark 配置走 PYSPARK_SUBMIT_ARGS：--conf/--master 等必须排在 pyspark-shell 尾缀之前', () => {
    const args = (kernel.env?.PYSPARK_SUBMIT_ARGS ?? '').trim();
    // 尾缀是**位置**属性，不是"出现过"：pyspark 拿 ` pyspark-shell` 这个结尾区分 submit 参数与应用参数。
    // 旧断言 toContain('pyspark-shell') 对 `pyspark-shell --master local[2] ...`（挪到最前）和
    // 嵌在别的 token 里的散字符串都照样绿；改成只出现在结尾、且前面还有 --conf/--master 才算过。
    expect(args, 'PYSPARK_SUBMIT_ARGS 必须以独立 token pyspark-shell 收尾').toMatch(/ pyspark-shell$/);
    const beforeTail = args.slice(0, args.lastIndexOf(' pyspark-shell'));
    expect(beforeTail).toContain('--master local[2]');
    // warehouse/Derby 的**叶子名**从 config.notebook.warehouseDir 派生（第四处真相，见
    // notebook-contract.test.ts 里那条同源判据）；`/app/data` 那半截是**故意写死**的字面量 ——
    // kernelspec 是构建期 COPY 进镜像的静态文件，运行时改不了，它只在"arena 容器没被显式设
    // ARENA_DATA_DIR"时与 entrypoint 的 ${nb_root} 重合（kernel.json 的 metadata 里也写了这条巧合）。
    const whLeaf = basename(config.notebook.warehouseDir);
    expect(beforeTail).toContain(`spark.sql.warehouse.dir=/app/data/${whLeaf}/wh`);
    expect(beforeTail).toContain(`-Dderby.system.home=/app/data/${whLeaf}/derby`);
    expect(kernel.env?.SPARK_LOCAL_IP).toBe('127.0.0.1');
  });

  it('Dockerfile 用 COPY 把它落进镜像级目录、构建期用 jupyter kernelspec list 当场断言，且没有 ipykernel install --user 这类写法', () => {
    // 旧判据 find(l => l.includes('arena-pyspark/kernel.json')) 只取第一条命中，而 COPY 行与
    // 自检 RUN 行都含这个子串：删 COPY 留自检 ⇒ 命中的是 RUN 行、形状"像对"，"kernel 没进镜像"判绿；
    // 再往 venv 里 COPY 一份，只要镜像级 COPY 排在前面，旧 ipykernel 正则也看不见。
    // 现在两刀都换成对**全体相关行**的判定。
    const kernelLines = dockerfile.split('\n').filter((l) => /jupyter\/kernels/.test(l));
    expect(
      kernelLines.some((l) => /^COPY\s/.test(l) && l.includes(`/usr/local/share/jupyter/kernels/${NOTEBOOK_KERNELS.pyspark.id}/`)),
      `Dockerfile 没有把 kernelspec 放进 /usr/local/share/jupyter/kernels/${NOTEBOOK_KERNELS.pyspark.id}/ 的 COPY 行`,
    ).toBe(true);
    expect(
      kernelLines.filter((l) => /arena-ide-env/.test(l)),
      'kernelspec 出现在 IDE venv 路径里 —— 「重置环境」（server/src/ide/reset.ts）会把 kernel 一起删掉',
    ).toEqual([]);
    expect(dockerfile, '构建期自检消失了 ⇒ kernel 没了要等用户点开界面才发现').toMatch(/jupyter kernelspec list/);
    expect(dockerfile).not.toMatch(/ipykernel install[^\n]*(--user|arena-ide-env)/);
  });
});
