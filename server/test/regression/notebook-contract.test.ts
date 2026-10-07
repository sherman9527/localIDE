import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * Task 5 的契约闸门：类型住在 `shared`（服务端与页面共用一份真相，同 `shared/src/ide.ts` 的先例），
 * 路径住在 `config`。这里钉的是**取值**而不是类型（类型由 `npm run typecheck` 管）：
 * 端口、目录这些一旦有两处各写一份，漂移的那处不会报错，只会让人拿到打不开的链接
 * （本项目在桥 token 上撞过同一次，WI-86）。
 *
 * 三条"看着像断言、其实什么都没管"的坑，这一版各补了一条真判据：
 * ① **派生**不能在同进程同 env 里比：`join(config.dataDir, …)` 当期望值时，
 *    一个写死 `join(repoRoot,'data','notebooks')` 的实现照样绿（两边用的是同一份 env）。
 *    ⇒ 下面那条用注入的 `ARENA_DATA_DIR` 重新 import config（`server/test/config.test.ts` 的现成路子）。
 * ② **叶子名是第四处真相**：`notebooks` / `notebook-warehouse` 同时写在
 *    `server/src/config.ts:92-93`、`docker/entrypoint.sh:82`、`docker/jupyter/kernels/arena-pyspark/kernel.json:13`
 *    和测试里。只改 config.ts 的话 seed 会把示例铺进 Jupyter 不服务的目录 —— 症状是"铺了示例但页面里没有"，
 *    静默。⇒ 有一条按 `config.notebook.*` 派生期望值去查 entrypoint 的文本。
 * ③ **负向断言要看结构不是看字符串**：`warehouseDir` 里 `not.toContain('judge')` 有两种错法 ——
 *    checkout 的路径本身含 "judge" 时冤红；把 `judgeWorkDir` 的叶子（config.ts:60）改名时反而永远抓不到。
 *    ⇒ 换成"谁在谁的子树里"。
 */

/** child 是否落在 parent 这棵子树里（路径包含关系，不是"字符串里出现过"）。 */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel.split(/[\\/]/)[0] !== '..';
}

/** 注入 env 重新 import config（照 server/test/config.test.ts:30-36 的 harness）。 */
async function loadConfigWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const key of ['ARENA_DATA_DIR', 'ARENA_DB_FILE', 'ARENA_JUPYTER_TOKEN', 'ARENA_NOTEBOOK_PUBLIC_URL']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return (await import('../../src/config.js')).config;
  } finally {
    Object.assign(process.env, saved);
  }
}

/**
 * 注入用的数据目录：故意取在**仓库之外**（宿主默认那份是 `<repoRoot>/data`），
 * 这样"写死 repoRoot/data"与"写死 /app/data"两种实现都会跟期望值对不上。
 */
const INJECTED_DATA = resolve(join(homedir(), '.arena-notebook-envgate-data'));

const ENTRYPOINT_REL = join('docker', 'entrypoint.sh');
const entrypointText = () => readFileSync(join(config.repoRoot, ENTRYPOINT_REL), 'utf8');

/**
 * 启动行里 `--ServerApp.ip=` 的**值是不是容器回环**。判的是回环这一类，不是某个具体字面量：
 * 127.0.0.0/8 整段（不止 .1）、`::1`、`localhost` 三个写法都算同一个陷阱。
 */
const CONTAINER_LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|localhost|ip6-localhost)$/i;

/** entrypoint 的**代码视图**里所有 --ServerApp.ip= 的取值（丢掉整行注释，同 notebook-env-isolation 的 ①）。 */
function serverAppIpValues(text: string): string[] {
  const code = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  return [...code.matchAll(/--ServerApp\.ip=(\S+)/g)]
    .map((m) => (m[1] ?? '').replaceAll(/["']/g, ''))
    .filter((v) => v !== '');
}

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
    // seedDir 是 config.notebook 里唯一一个"不从 dataDir 派生"的键（它是仓库里的只读示例），
    // 加它之前这个键零覆盖：写错成 dataDir 下的话，seed 会把示例铺进可写目录、仓库里那份就没人看了。
    expect(config.notebook.seedDir).toBe(join(config.repoRoot, 'content', 'notebooks'));
  });

  /**
   * 上面那两条是"env 盲"的：期望值与实现在同一个进程、同一份 env 里算出来，
   * `ARENA_DATA_DIR` 没设（宿主默认状态）时写死的实现也过。
   * 这条把变量注进去再 import 一次，判据才真的叫"从 dataDir 派生"（WI-40：只换一半的那个故障）。
   */
  it('workDir / warehouseDir 跟着注入的 ARENA_DATA_DIR 走（不是写死的 data/）', async () => {
    const injected = await loadConfigWith({ ARENA_DATA_DIR: INJECTED_DATA });
    expect(injected.dataDir, '注入没生效 ⇒ 下面两条断言在空转').toBe(INJECTED_DATA);
    expect(injected.notebook.workDir).toBe(join(INJECTED_DATA, 'notebooks'));
    expect(injected.notebook.warehouseDir).toBe(join(INJECTED_DATA, 'notebook-warehouse'));
    // 直接点名两种"写死"的形状，免得只看到"路径不相等"不知道该改哪：
    expect(injected.notebook.workDir, 'workDir 写死在仓库默认 data/ 下 ⇒ 换数据目录只换了一半（WI-40）').not.toBe(
      join(config.repoRoot, 'data', 'notebooks'),
    );
    expect(injected.notebook.warehouseDir, 'warehouseDir 写死了容器内的 /app/data ⇒ entrypoint 换目录时它不换').not.toBe(
      '/app/data/notebook-warehouse',
    );
    // seedDir 是**故意不跟** dataDir 走的（仓库里的只读示例）：这条钉住"只有那两个目录跟着走"。
    expect(injected.notebook.seedDir).toBe(join(config.repoRoot, 'content', 'notebooks'));
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

  /**
   * 叶子名的单一真相（评审 Important 3）。为什么只能按文本查 entrypoint：那是个 shell 脚本，
   * 宿主上没法"import 一个 bash 变量"，而它的 `${nb_root}` 正是从 `ARENA_DATA_DIR` 派生的那一个
   * （docker/entrypoint.sh:81）—— 与 config.ts 用的是同一个总开关，只差目录叶子名。
   * 判据形状照 notebook-env-isolation.test.ts:233 那条（对 entrypoint 文本做结构断言）。
   *
   * 顺带写明一处**已知的巧合**，免得下一个人以为它也是动态的：
   * `docker/jupyter/kernels/arena-pyspark/kernel.json` 里的 warehouse/Derby 路径是**绝对字面量**
   * `/app/data/notebook-warehouse`（kernelspec 是构建期 COPY 进镜像的静态文件，运行时改不了），
   * 它只在"arena 容器没被显式设 ARENA_DATA_DIR"时与这里的派生值重合。今天 compose 确实没设。
   */
  it('目录叶子名只有一份真相：entrypoint 里的路径就是从 config 派生出来的那两个', () => {
    const entry = entrypointText();
    expect(/\$\{nb_root\}/.test(entry), `${ENTRYPOINT_REL} 里已经没有 \${nb_root} 这个变量 ⇒ 本条判据的锚点没了（先修判据，别改目录名）`).toBe(true);
    const workLeaf = basename(config.notebook.workDir);
    const whLeaf = basename(config.notebook.warehouseDir);
    // 空转防护：叶子名取空/取到 "." 时下面几条 toContain 会变得毫无意义
    expect(workLeaf).toBe('notebooks');
    expect(whLeaf).toBe('notebook-warehouse');
    // 承重的那条是 **root_dir**：seed 铺进 config.notebook.workDir，Jupyter 服务的必须是同一个目录，
    // 只查 mkdir 会漏掉"目录建了但服务的是别处"（症状就是"铺了示例但页面里没有"）。
    expect(
      entry,
      `${ENTRYPOINT_REL} 的 --ServerApp.root_dir 不是 "\${nb_root}/${workLeaf}" ⇒ 它与 server/src/config.ts 的 ` +
        'workDir 分叉了：notebook 的示例铺在一个目录、Jupyter 打开的是另一个，页面里就是空的，一声不响。',
    ).toContain(`--ServerApp.root_dir="\${nb_root}/${workLeaf}"`);
    // warehouse 的两个子目录由 entrypoint 建、kernel.json 按同名绝对路径写死（叶子名分叉 ⇒ spark 自己新建一份，
    // 而界面按 config 那份清理工件 → 清了个寂寞）
    for (const sub of ['wh', 'derby']) {
      expect(
        entry,
        `${ENTRYPOINT_REL} 里没有 "\${nb_root}/${whLeaf}/${sub}" ⇒ warehouse 叶子名与 config.ts 分叉，两处会各建一棵目录树`,
      ).toContain(`\${nb_root}/${whLeaf}/${sub}`);
    }
  });

  /**
   * 监听地址的不变量（Task 10 实测到的缺陷；裁决 R1 + R3）。
   * **为什么不是把旧字面量 `127.0.0.1` 换成 `0.0.0.0` 就收工**（R3 明令不许只是翻字符串）：
   * 计划原文那两条 —— "只听容器内 127.0.0.1:8888" 与 "发布成宿主 127.0.0.1:7789" —— **本身就互相矛盾**：
   * 发布的端口是 DNAT 到**容器的 eth0 地址**的，不是转到它的回环，所以前者一成立后者就必然打不通
   * （实测：容器里 `curl 127.0.0.1:8888/tree` → 302，`curl $(hostname -i):8888/tree` → 000，宿主 7789 → 000，
   * 而容器档那一片判据全走回环 ⇒ 整片绿、用户的链接是死的）。
   * ⇒ 钉的是**真正要紧的那两条不变量**，各自有归属：
     * ① 宿主侧的发布映射绑回环 ⇒ `compose-ports.test.ts`（全局）+ `notebook-compose.test.ts` ①（这条映射本身），
   *    这一处**不放松**，本条也不碰它；
   * ② 容器里的监听必须答得出 DNAT 目标 ⇒ 终判是 `server/test/notebooks/kernel.test.ts`
   *    「发布端口的 DNAT 目标上也必须有人在听」（要 Docker、要真容器），**本条是它的静态前身**：
   *    不依赖 Docker 就拦住"有人把 ip 改回回环那一类"与"把这一项删掉"
   *    —— 删掉比改回更阴：jupyter 自己的默认 ip 就是 `localhost`，症状与当初一字不差。
   * 局限也写清楚（别把它当成终判）：值若是变量展开（`--ServerApp.ip="${X:-0.0.0.0}"`），静态这层看不出来，
   * 那一档由 ② 的行为判据兜。判据只看代码行（整行注释不算），否则注释里写一句就骗绿 —— 同 notebook-env-isolation ①。
   */
  it('entrypoint 不许把 jupyter 只监听在容器回环上（发布端口 DNAT 到 eth0；只听回环等于没发布）', () => {
    const values = serverAppIpValues(entrypointText());
    expect(
      values.length,
      `${ENTRYPOINT_REL} 的启动行里没有 --ServerApp.ip= 这一项 ⇒ jupyter 退回它自己的默认值 "localhost"，` +
        '那就是只听容器回环：宿主 127.0.0.1:7789 永远 000（DNAT 的目标是容器的 eth0 地址），' +
        '而容器档的判据全走回环 ⇒ 看起来一切正常、功能其实打不开。把这一项加回来（不能是回环那一类），' +
        '行为侧的终判在 server/test/notebooks/kernel.test.ts 的「DNAT 目标」那条',
    ).toBeGreaterThan(0);
    const loopback = values.filter((v) => CONTAINER_LOOPBACK.test(v));
    expect(
      loopback,
      `--ServerApp.ip=${loopback.join(', ')} 是**容器回环** ⇒ 这正是 Task 10 那个缺陷的形状：` +
        'compose 把 127.0.0.1:7789:8888 DNAT 到容器的 eth0，回环上的监听收不到那条转发。' +
        '旧计划写的那个字面量就是陷阱本身（"只听容器内回环"与"发布到宿主"不能同时成立）；' +
        '真正的边界一直是「宿主侧绑回环 + token 必填」那两道，改 ip 请连同它们的注释一起想清楚',
    ).toEqual([]);
  });

  /**
   * 上面那条的判据本身（常驻反例，喂的是**字符串**不是仓库文件）：
   * 三种"看着像有闸门其实什么都没判"的形状各一条 —— 正则解不出值、注释骗绿、回环写法漏网。
   * 没有这一组的话，把 filter 的 `^\s*#` 去掉、或把 CONTAINER_LOOPBACK 写宽一点，都不会有任何东西翻脸。
   */
  it('监听地址判据自己的反例：解得出值、认得回环那一类、注释不算配置', () => {
    const launch = '  jupyter notebook --allow-root --ServerApp.ip=%s --ServerApp.port=8888 \\\n';
    expect(serverAppIpValues('  jupyter notebook --allow-root --ServerApp.port=8888 \\\n'), '没有 --ServerApp.ip= 时不该解出值（那条"删掉这一项"的红另有其句）').toEqual([]);
    for (const bad of ['127.0.0.1', '127.0.0.42', '::1', 'localhost', 'IP6-localhost']) {
      expect(CONTAINER_LOOPBACK.test(bad), `${bad} 是回环那一类，判据不许放过它`).toBe(true);
    }
    for (const ok of ['0.0.0.0', '*', '172.18.0.2']) {
      expect(CONTAINER_LOOPBACK.test(ok), `${ok} 不是回环，判成陷阱就是冤红`).toBe(false);
    }
    // 整行注释里的陷阱写法不算配置（与 notebook-env-isolation ① 同一个道理）
    expect(serverAppIpValues('#   jupyter notebook --ServerApp.ip=127.0.0.1\n'), '注释被当成了启动行 ⇒ 在注释里写一句就能骗绿').toEqual([]);
    expect(serverAppIpValues(launch.replace('%s', '0.0.0.0')), '真正的启动行必须解得出值').toEqual(['0.0.0.0']);
    // 引号包裹的写法也要能识别成回环（值里的引号先剥掉，否则 "127.0.0.1" 会躲过判据）
    expect(serverAppIpValues(launch.replace('%s', '"127.0.0.1"')), '带引号的回环写法躲过了判据').toEqual(['127.0.0.1']);
  });

  /**
   * notebook 与判题沙箱必须是两棵树（评审 Minor：把子串判据换成结构判据）。
   * 判题跑完会清空 `data/judge`：notebook 的 Spark warehouse / Derby 混进去就是互删，且不报错。
   */
  it('notebook 的目录与判题沙箱互不包含（结构判据，与路径里有没有 "judge" 这个词无关）', () => {
    const cases: Array<[string, string]> = [
      [config.notebook.warehouseDir, 'notebook.warehouseDir'],
      [config.notebook.workDir, 'notebook.workDir'],
    ];
    for (const [dir, label] of cases) {
      expect(isInside(dir, config.judgeWorkDir), `${label} 落在 judgeWorkDir（${config.judgeWorkDir}）里面 ⇒ 判题收尾清空会连笔记的数据一起删`).toBe(false);
      expect(isInside(config.judgeWorkDir, dir), `judgeWorkDir 落在 ${label} 里面 ⇒ notebook 侧的清理会删掉判题现场（红线一）`).toBe(false);
    }
    // 两个 notebook 目录自己也不许套在一起（warehouse 套住 workDir 的话，清 warehouse 会连笔记一起删）
    expect(isInside(config.notebook.workDir, config.notebook.warehouseDir), '笔记文件落在 warehouse 里 ⇒ 清 warehouse 会删掉用户笔记').toBe(false);
    expect(isInside(config.notebook.warehouseDir, config.notebook.workDir), 'warehouse 落在笔记目录里 ⇒ 界面"清空工作区"会删掉 spark 数据').toBe(false);
  });

  /**
   * 常驻反例：把"为什么不用 `not.toContain('judge')`"变成可执行的判据（评审 Minor）。
   * 前两条是被换掉的那条断言的两种错法，后两条是它本来就对的情形 —— 判据本身退化时这里会红。
   */
  it('isInside 本身认得那两种"名字判"会犯的错', () => {
    const judge = join('/data', 'judge');
    // ① 冤红：checkout 目录本身叫 judge-systems，notebook 与判题沙箱根本不在一棵树上
    //    （子串判据在这里会红，而实际什么都没坏）
    const checkout = join('/work', 'judge-systems', 'data');
    expect(isInside(join(checkout, 'notebook-warehouse'), join(checkout, 'judge')), '路径里有 "judge" 这个词就被判红 ⇒ 那是名字巧合，不是包含关系').toBe(false);
    // ② 漏判：judgeWorkDir 的叶子改名成 sandbox，warehouse 真的套在它里面，而字符串里没有 "judge"
    expect(isInside(join(judge, 'notebook-warehouse'), judge), '真正的包含关系必须判红，不管叶子叫什么名').toBe(true);
    expect(isInside(join('/data', 'sandbox', 'notebook-warehouse'), join('/data', 'sandbox'))).toBe(true);
    // ③ 同一目录不是"在里面"（相等时 relative 得空串，别把它读成"互相包含"）
    expect(isInside(judge, judge)).toBe(false);
  });
});
