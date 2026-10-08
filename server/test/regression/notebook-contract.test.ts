import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NOTEBOOK_KERNELS, NOTEBOOK_TREE_PATH, JUPYTER_BASE_URL } from '@arena/shared';
import { config } from '../../src/config.js';
import { notebookStatus } from '../../src/notebooks/status.js';

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

/**
 * entrypoint 的**代码视图**：丢掉整行注释（同 notebook-env-isolation 的 ①）。
 * 单独抽出来是因为现在有**两条**判据都要读启动行（ip 与 allow_remote_access）：各写一份 filter
 * 的那天下掉一份，就会有一条判据开始在注释里读配置 —— "注释里写一句就骗绿"是这个文件已经付过学费的形状。
 */
function codeView(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** 从代码视图里解出 `--ServerApp.<flag>=` 的取值；引号先剥掉，否则 `"127.0.0.1"` / `"False"` 会躲过判据。 */
function flagValues(text: string, flag: string): string[] {
  return [...codeView(text).matchAll(new RegExp(`--ServerApp\\.${flag}=(\\S+)`, 'g'))]
    .map((m) => (m[1] ?? '').replaceAll(/["']/g, ''))
    .filter((v) => v !== '');
}

/** entrypoint 的**代码视图**里所有 --ServerApp.ip= 的取值（丢掉整行注释，同 notebook-env-isolation 的 ①）。 */
function serverAppIpValues(text: string): string[] {
  return flagValues(text, 'ip');
}

/** 同上，取 --ServerApp.allow_remote_access= 的取值。 */
function allowRemoteAccessValues(text: string): string[] {
  return flagValues(text, 'allow_remote_access');
}

/**
 * 假 Jupyter 上游，给下面那条「给页面的链接与探活都带前缀」用 —— 形状照
 * `server/test/api/notebook-api.test.ts` 的 `jupyterUp()`，区别是这里**返回** `typeof fetch`
 * 注进 `notebookStatus({ fetchImpl })`，不 stubGlobal（本文件别的用例还在读真文件，别搅动全局）。
 * ⚠ 顶层键必须是 `kernelspecs`、标签在 `[<id>].spec.display_name`，**不是** `kernels`：
 * 那份 fixture 当年与实现同源地写错过，于是宿主档一片绿而第五页在用户眼前说"kernel 没注册"
 * （2026-10-08 实测；判住键名的是容器档那条不打 mock 的闸门）。
 *
 * `seenUrls`（评审 I-3 补的）：分流用的是 `.includes('/api/kernelspecs')` —— **带不带 `/jupyter`
 * 都命中**，所以这份 fixture 在 URL 那一维上是空转的：摘掉 `status.ts` 里 `jupyterApi()` 的
 * 前缀，两次探活会打到根路径（实测那里给 404），而假上游照样回 200。要么把分流改成精确匹配
 * （那会让"前缀只在一处加"这个副产品变成脆弱点），要么**把被请求的 URL 记下来单独判**。
 * 选后者：这一维本来就该由一条判据说话，不该靠 fixture 的巧合。
 */
function fakeUp(seenUrls: string[] = []) {
  return vi.fn(async (u: string | URL) => {
    const url = String(u);
    seenUrls.push(url);
    return url.includes('/api/kernelspecs')
      ? {
          status: 200,
          json: async () => ({
            default: NOTEBOOK_KERNELS.pyspark,
            kernelspecs: {
              [NOTEBOOK_KERNELS.pyspark]: {
                name: NOTEBOOK_KERNELS.pyspark,
                spec: { display_name: 'PySpark (arena)' },
                resources: {},
              },
            },
          }),
        }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) };
  }) as unknown as typeof fetch;
}

/**
 * `publicUrl` 自带的 base path，**去掉尾斜杠**后的样子：默认 env（`http://127.0.0.1:7789`）是空串，
 * 同源反代挂在子路径上的部署（`…/arena`）是 `/arena`。
 * 为什么判 pathname 必须把它算进期望值（评审 I-1 实测）：`new URL('http://127.0.0.1:7789').pathname`
 * 给的是 `'/'` 而不是空串，所以既不能直接拼、也不能拿字面量 `${NOTEBOOK_TREE_PATH}` 比 ——
 * 后者在 `ARENA_NOTEBOOK_PUBLIC_URL` 带 base path 时**冤红**（实际链接是 `/arena/jupyter/tree`，
 * 前缀好好在那儿），而冤红教给下一个人的是"改测试里的数字"。
 */
function publicUrlBasePath(publicUrl: string): string {
  return new URL(publicUrl).pathname.replace(/\/$/, '');
}

/** 链接的 pathname；`url` 缺席时把"为什么没给"当成值报出来（红得有信息，而不是让 `new URL('')` 抛 TypeError）。 */
function linkPathname(res: { url?: string; reason?: string }): string {
  if (!res.url) return `（没有 url${res.reason ? `：${res.reason}` : ''}）`;
  return new URL(res.url).pathname;
}

/** 注入 env 重新 import `notebookStatus`（`loadConfigWith` 的同一条路子，只是这一次要的是 status 那一层）。 */
async function loadStatusWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['ARENA_DATA_DIR', 'ARENA_DB_FILE', 'ARENA_JUPYTER_TOKEN', 'ARENA_NOTEBOOK_PUBLIC_URL']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  try {
    return (await import('../../src/notebooks/status.js')).notebookStatus as typeof notebookStatus;
  } finally {
    Object.assign(process.env, saved);
    // 再清一次模块图：否则后面某条用例动态 import 到的还是"带着 base path 的那份 config"
    vi.resetModules();
  }
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
   * Host 头守卫（防 DNS rebinding）的**静态前身** —— 与上面那条 ip 判据同一个归属划分：
   * 行为终判在 `server/test/notebooks/kernel.test.ts`「Host 守卫在位」（要 Docker、要真 Jupyter），
   * 本条只保证"删掉这一项"或"把它改成 True"在**宿主档 verify:fast** 里就红，不必等一整轮容器验证。
   *
   * 为什么这一条值得单独钉，而不是给上面那条凑数（实测 jupyter_server 2.21.1 的源码，不是推理）：
   * `serverapp.py` 的 `@default("allow_remote_access")` 写的是 `return not addr.is_loopback` ——
   * **ip 一绑到非回环，那个默认值就是 True**，而 `base/handlers.py` 的 `check_host()` 第一行
   * `if self.settings.get("allow_remote_access", False): return True` ⇒ 守卫整块关闭
   * （改之前实测：`Host: rebinding.example:7789` 得到 302，照收）。
   * 上一轮为了让发布端口打得通，ip **必须**绑 0.0.0.0 ⇒ "改 ip"与"关守卫"是同一次动作的两面，
   * 只钉 ip 那一面不够，这里要显式的 False。
   *
   * 方向也一并钉住：谁若为了"让 eth0 那条可达性闸门从 403 变回 302"把它松回 True，那是拿保护换一个数字
   * —— 那条闸门判的是"有没有真实 HTTP 应答"，403 恰恰证明包转到了、有 jupyter 在按 Host 做决定。
   */
  it('entrypoint 必须显式 --ServerApp.allow_remote_access=False（绑非回环时 jupyter 默认把 Host 守卫关掉）', () => {
    const values = allowRemoteAccessValues(entrypointText());
    expect(
      values.length,
      `${ENTRYPOINT_REL} 的启动行里没有 --ServerApp.allow_remote_access= 这一项 ⇒ jupyter 按 ip=0.0.0.0 把默认值算成 True，` +
        '于是 check_host() 第一行就放行，防 DNS rebinding 的 Host 守卫整块关闭。' +
        '症状不是"别人能连进来"（宿主侧只绑 127.0.0.1:7789，compose-ports.test.ts 钉着），' +
        '而是"受害者自己的浏览器替攻击者打隧道"：token 登录之后靠 cookie 认后续请求，只剩这一道还认得出 Host 不是本机。' +
        '行为终判在 server/test/notebooks/kernel.test.ts 的「Host 守卫在位」',
    ).toBeGreaterThan(0);
    const notFalse = values.filter((v) => !/^false$/i.test(v));
    expect(
      notFalse,
      `--ServerApp.allow_remote_access 里有不是 False 的值：${JSON.stringify(notFalse)}（实际值 ${JSON.stringify(values)}）` +
        '⇒ 守卫又被关回去了（True / 1 都是关）。这一项与 --ServerApp.ip=0.0.0.0 是一对：' +
        '绑非回环是"发布端口打得通"的修复（kernel.test.ts 那条 DNAT 闸门判它），显式 False 是"守卫别随之关闭"',
    ).toEqual([]);
  });

  /**
   * 上面那条的**判据本身**（常驻反例，喂字符串不喂仓库文件）：与 ip 那组同一个规矩 ——
   * 注释不算配置、值解得出、非 False 必须翻脸。少了这一组，把 codeView 的 filter 去掉、
   * 或把 `/^false$/i` 松成"只要出现过 False 就算"，都不会有任何东西红。
   */
  it('allow_remote_access 判据自己的反例：注释不算配置、True/1 不放行、False 认得大小写与引号', () => {
    const launch = '  jupyter notebook --allow-root --ServerApp.ip=0.0.0.0 --ServerApp.allow_remote_access=%s \\\n';
    expect(allowRemoteAccessValues('  jupyter notebook --ServerApp.ip=0.0.0.0 --ServerApp.port=8888 \\\n'), '没有这一项时不该解出值（那条"删掉这一项"的红另有其句）').toEqual([]);
    expect(allowRemoteAccessValues('#   jupyter notebook --ServerApp.allow_remote_access=False\n'), '注释被当成了启动行 ⇒ 在注释里写一句就能骗绿').toEqual([]);
    const notFalse = (text: string) => allowRemoteAccessValues(text).filter((v) => !/^false$/i.test(v));
    for (const bad of ['True', 'true', '1', '"True"']) {
      expect(notFalse(launch.replace('%s', bad)), `${bad} 是"守卫关掉"那一类，必须留在待判红的清单里`).toEqual([bad.replaceAll(/["']/g, '')]);
    }
    for (const ok of ['False', 'false', '"False"', "'False'"]) {
      expect(notFalse(launch.replace('%s', ok)), `${ok} 是放行值，不该出现在"守卫没开"的清单里`).toEqual([]);
    }
    // 只出现过一次"False"字样的行不算放行值（判的是这一项的**值**，不是文件里有没有这个词）
    expect(allowRemoteAccessValues(launch.replace('%s', 'False')).length, '正式启动行该解出恰好一个值').toBe(1);
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

  /**
   * WI-94 的前提：Jupyter 自己就挂在 `/jupyter/` 下。判的是**取值等于 shared 里那份真相**，
   * 不是"启动行里出现过 base_url"—— 后者在有人把值改成 `/nb/` 时照样绿，而那时页面上的
   * 反代前缀与 jupyter 的 base_url 分家，症状是"iframe 里全 404"，一片绿。
   *
   * 破坏性验证（2026-10-09 三种形状各改坏一次 `docker/entrypoint.sh` 的启动行，跑完即还原；
   * 三次都是**只有本条红**：`Tests 1 failed | 15 passed (16)`，退出码 1）：
   * ① 删掉这一项（Task 1 落地之前的状态）⇒ 红在第一句 `toHaveLength(1)`：
   *    `base_url 必须恰好一处，实际解出 0 处：[]（0 处 ⇒ …）: expected [] to have a length of 1 but got +0`；
   * ② 把值改成 `--ServerApp.base_url=/nb/` ⇒ 红在第二句，两个值都在消息里：
   *    `entrypoint 里的 base_url 是 "/nb/" 而前缀的真相是 "/jupyter/"（shared/src/notebook.ts）…：
   *     expected '/nb/' to be '/jupyter/' // Object.is equality`。
   *
   * ③ 把这一项**复制成两行**（补新的没删旧的）—— 上一版在这里只写了推论（"没测过的形状…
   * 会撞在同一条 `toHaveLength(1)` 上"），本轮按评审 M-2 实测掉了它：`DV_DUP_EXIT=1`、仍然只有本条红，
   * 红在第一句，消息把条数与两个值一起报出来：
   *   `base_url 必须恰好一处，实际解出 2 处：["/jupyter/","/jupyter/"]（0 处 ⇒ …；多于 1 处 ⇒ …）:
   *    expected [ '/jupyter/', '/jupyter/' ] to have a length of 1 but got 2`
   *   ⇒ 上一版的消息在这种形状下说的是"启动行里**没有** --ServerApp.base_url"，而真实故障是有两处 ——
   *   那句会把第一次来的人支去**加一条**而不是删一条。现在两种形状（0 处 / 多于 1 处）各有一句解释。
   */
  it('entrypoint 的 --ServerApp.base_url 必须就是 shared 的 JUPYTER_BASE_URL（不多不少、恰好一处）', () => {
    const values = flagValues(entrypointText(), 'base_url');
    expect(
      values,
      `base_url 必须恰好一处，实际解出 ${values.length} 处：${JSON.stringify(values)}` +
        '（0 处 ⇒ jupyter 挂在根路径上，同源反代 `/jupyter/*` 会把它的 /static、/api、/login 全撞进 7788 自己的树里；' +
        '多于 1 处 ⇒ 后一条覆盖前一条，两处会分家，而分家之后的症状是 iframe 里每个资源都 404）',
    ).toHaveLength(1);
    expect(values[0], `entrypoint 里的 base_url 是 "${values[0]}" 而前缀的真相是 "${JUPYTER_BASE_URL}"（shared/src/notebook.ts）⇒ 两边分家时症状是 iframe 里每个资源都 404，而三档验证谁都不会红`).toBe(JUPYTER_BASE_URL);
  });

  /**
   * 钉的是**链接的前缀**与**两次探活的 URL 前缀**，两维各一条断言。
   *
   * 为什么链接那一条只看 pathname（评审 I-1，本轮订正；那两条证据是评审 2026-10-09 实测的）：
   * 上一版在这里写的是"整串相等（含 `?token=x`）"，然后**另加**一句 pathname 判据，注释声称它提供
   * 独立保护 —— 两句都不成立：① 默认 env 下第一句一旦成立第二句必然成立，而第一句一失败 vitest
   * 就在第一个 `expect` 抛出、第二句根本不被执行（上一轮报告自己就记了这条实测）；
   * ② `ARENA_NOTEBOOK_PUBLIC_URL` 带 base path 时第一句仍然成立而第二句**冤红**
   * （评审实测 `expected '/arena/jupyter/tree' to be '/jupyter/tree'`，指责的却是一个不存在的硬编码）。
   * 现在把这一条的对象收窄成**前缀本身**（pathname），token 那一维不在这里判 —— 它由
   * `server/test/notebooks/status.test.ts` 的合取表钉（那条从一开始就是整串相等、含 token）。
   *
   * 破坏性验证（2026-10-09 三次各改坏一次，跑本文件，退出码单独 echo；基线 `Tests 16 passed (16)`）：
   * ① `status.ts` 拼链接那处退回字面量 `/tree` ⇒ `DV_I1_EXIT=1`、`Tests 2 failed | 14 passed (16)`：
   *    本条的第一句 + 下面那条 base path 用例各翻一次脸（同一个故障在两维上）——
   *    `链接的 pathname 是 "/tree" 而派生值是 "/jupyter/tree" …: expected '/tree' to be '/jupyter/tree'`
   *    `带 base path 的部署下，前缀必须接在 "http://127.0.0.1:7789/arena" 之后: expected '/arena/tree' to be '/arena/jupyter/tree'`
   *    ⇒ 这一句红得不冤枉：那两条判的确实都是"前缀在不在链接里"；
   * ② 摘掉 `jupyterApi()` 里的 `${JUPYTER_BASE_URL}` ⇒ `DV_I3_EXIT=1`、**只有本条红**
   *    （`Tests 1 failed | 15 passed (16)`），红在第二句，received 是
   *    `["http://127.0.0.1:8888api/status","http://127.0.0.1:8888api/kernelspecs"]`（端口后面直接粘上
   *    `api/…`，前缀没了）⇒ **这就是评审 I-3 要的那次"宿主档必须红"**：评审对改之前的同一个变异
   *    实测过"宿主档 14 条契约判据与整条 `verify:fast` 都照绿"（`.includes('/api/kernelspecs')`
   *    分流不看前缀），会红的只有容器档那条不打 mock 的闸门；
   * ③ `ARENA_NOTEBOOK_PUBLIC_URL='http://127.0.0.1:7789/arena'` 整文件跑 ⇒ `ENV_PUB_URL_EXIT=1`、
   *    `Tests 1 failed | 15 passed (16)`，红的**只有**第 1 条用例那句"默认 publicUrl 就是这个"的取值判据
   *    （`expected 'http://127.0.0.1:7789/arena' to be 'http://127.0.0.1:7789'` —— env 敏感的本来之判，
   *    不在本轮六条里，评审也没把它列成 finding）；单独点本条 ⇒ `ENV_PUB_GATE2_EXIT=0`、
   *    `Tests 1 passed | 15 skipped (16)` ⇒ I-1 的那个冤红不复存在。
   */
  it('给页面的链接与探活都带前缀：config.notebook.publicUrl + JUPYTER_BASE_URL 派生，不许写死 /tree', async () => {
    const seenUrls: string[] = [];
    const res = await notebookStatus({ peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', tokenOverride: 'x', fetchImpl: fakeUp(seenUrls), gatewayAddresses: [] });
    const actualPath = linkPathname(res);
    const expectPath = `${publicUrlBasePath(config.notebook.publicUrl)}${NOTEBOOK_TREE_PATH}`;
    expect(actualPath, `链接的 pathname 是 "${actualPath}" 而派生值是 "${expectPath}" ⇒ 拼链接那一处没跟着前缀的真相走（与 token 无关）`).toBe(expectPath);
    expect(
      seenUrls,
      '两次探活打的是 ' + JSON.stringify(seenUrls) + ` ⇒ \`jupyterApi\` 里没拼 JUPYTER_BASE_URL（status.ts 那句"前缀在这里加、只在这里加"是假的）。` +
        '这一维假 fixture 判不到：它按 .includes("/api/kernelspecs") 分流，带不带前缀都命中、都回 200，' +
        '于是摘掉前缀之后第五页会对着一台活着的 Jupyter 说"返回 404"（实测根路径给 404），而这一档全绿 —— 本条就是补在那里的',
    ).toEqual([
      `http://127.0.0.1:${config.notebook.port}${JUPYTER_BASE_URL}api/status`,
      `http://127.0.0.1:${config.notebook.port}${JUPYTER_BASE_URL}api/kernelspecs`,
    ]);
  });

  /**
   * 评审 I-1 的那个冤红形状，钉成常驻判据：`ARENA_NOTEBOOK_PUBLIC_URL` 带 base path
   * （同源反代挂在子路径上，正是 WI-94 后面几档要支持的部署形状）时，前缀必须**挂在 base path 之后**
   * 而不是把它挤掉，也不许有条判据因为它而翻脸。期望值是**字面量**，不由被测实现派生。
   */
  it('ARENA_NOTEBOOK_PUBLIC_URL 带 base path 时前缀仍然接在它后面（I-1 的冤红形状不留原位）', async () => {
    const BASE = 'http://127.0.0.1:7789/arena';
    const statusWithBase = await loadStatusWith({ ARENA_NOTEBOOK_PUBLIC_URL: BASE });
    const res = await statusWithBase({ peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', tokenOverride: 'x', fetchImpl: fakeUp(), gatewayAddresses: [] });
    // 空转防护：注入没生效时下面这条会退化成上一条的复读
    expect(res.url, `注入的 publicUrl 没进链接 ⇒ env 那一层没生效（本条就在空转）：${JSON.stringify(res)}`).toContain(BASE);
    expect(linkPathname(res), `带 base path 的部署下，前缀必须接在 "${BASE}" 之后`).toBe('/arena/jupyter/tree');
  });

  /**
   * 「两个实现」这句话的判据本体（`start.sh` 与 `start.ps1` 是同一套判据的两个实现，改了其一必须改其二）。
   * 期望值 `7789${JUPYTER_BASE_URL}login` 是从 shared 那份真相派生的，不是写死的 `'/jupyter/login'`。
   *
   * 破坏性验证（上一轮实测过一次；本轮因为文件里多了用例，2026-10-09 又各重跑一次，
   * 记的是**本轮**的数字：**只**把 `start.ps1` 的探测退回 `/login`、`start.sh` 保持带前缀
   * ⇒ `DV_PS_PROBE_EXIT=1`、**只有本条红**（`Tests 1 failed | 15 passed (16)`），且红的是**第二句**
   * （先 `toContain` sh 通过、再 ps 翻脸），说明它判的确实是"两边同步"而不是"sh 那边有没有"）。
   * 失败消息逐字：
   *   `start.ps1 与 start.sh 不同步 ⇒ 两个人照着不同的一句话修不同的东西:
   *    expected '\ufeff# 游戏启动脚本（Windows PowerShell 对等实…' to contain '7789/jupyter/login'`
   * 顺带一条实测副产品：那条消息里 ps1 正文以 `\ufeff` 开头 ⇒ 本文件的读取看见的是带 BOM 的字节，
   * BOM 判据（`scripts-syntax.test.ts`）与本条互不掩盖。
   *
   * 反方向本轮也重跑了一次（**只**把 `start.sh` 的探测退回 `/login`、`start.ps1` 保持带前缀
   * ⇒ `DV_SH_PROBE_EXIT=1`、仍然**只有本条红**（`Tests 1 failed | 15 passed (16)`），红的是**第一句**）：
   *   `start.sh 的 report_notebook 还在探 /login ⇒ …永远拿到 **404**（实测：/login → 404，000 只在没人监听时
   *    时才出现）…: expected '#!/usr/bin/env bash\n# 游戏启动脚本（需求 场景 2…' to contain '7789/jupyter/login'`
   * ⇒ 两句断言各自都能独立翻脸，"两个实现"不是靠一句 `&&` 糊在一起的。
   *
   * ⚠ 这一条的**症状描述**在实施中被实测订正过一次，写在这里免得下一个人按旧说法排查：
   * 计划/brief 原稿写的是"base_url 一改它就永远 **000**，横幅说未就绪（假阴性）"。从跑着的容器里实测：
   * `…/login` → **404**、`…/jupyter/login` → 200、`…/tree` → 404、`…/jupyter/tree` → 302
   * （宿主 7789 那侧一模一样）。`000` 只在"没人监听"时才出现 ⇒ 旧写法实际走的是**成功分支**：
   * 横幅打印"已应答 HTTP 404"再附一条打不开的链接，那是**假阳性**（探活形同虚设），比假阴性更难发现。
   * 判据本身（"文本里必须出现派生出来的那条路径"）不受这个订正影响 —— 变的只是它解释故障的那句话。
   */
  it('start.sh 与 start.ps1 里那条探测也带前缀（同一套判据的两个实现）', () => {
    const probe = `7789${JUPYTER_BASE_URL}login`;      // 期望值派生，不写死 '/jupyter/login'
    const sh = readFileSync(join(config.repoRoot, 'start.sh'), 'utf8');
    const ps = readFileSync(join(config.repoRoot, 'start.ps1'), 'utf8');
    expect(sh, 'start.sh 的 report_notebook 还在探 /login ⇒ base_url 一改它就永远拿到 **404**（实测：/login → 404，' +
      '000 只在没人监听时才出现），于是横幅照走成功分支、打印"已应答 HTTP 404"再附一条打不开的链接 ⇒ 探活形同虚设（假阳性）').toContain(probe);
    expect(ps, 'start.ps1 与 start.sh 不同步 ⇒ 两个人照着不同的一句话修不同的东西').toContain(probe);
  });

  /**
   * 评审 I-2：横幅里那条**用户真正会点开的链接**（`say` / `Write-Host` 那一行）以前一句判据都没有 ——
   * 评审实测过"把 `start.sh` 的横幅退回 `/tree` ⇒ 整条 `npm run verify:fast` `EXIT=0`"。
   * 上面那条只查探测（`…/jupyter/login`），两条是不同的行：探测坏了是"探活形同虚设"，
   * 横幅坏了是"每一个跑 ./start.sh 的人第一次看到的都是点不开的链接"，症状与 Task 1 想防的完全同形。
   *
   * ⚠ **必须走 `codeView()`**：`start.sh` 注释 ④ 里**现在就含** `7789/jupyter/tree`
   * （本轮 Minor-1 又往那一段加了年代标记，串还在），直接 `toContain(sh)` 会被注释喂绿 ——
   * 与本文件「注释不算配置」那条纪律同源（见 `codeView` 的注释：各写一份 filter 的那天下掉一份，
   * 就会有一条判据开始在注释里读配置）。上面那两条**探测**判据今天没被注释喂到（数过，见 ③ 后面那段普查），
   * 但那是运气不是设计 ⇒ 新加的这两句一律走剥离后的视图。
   *
   * 破坏性验证（2026-10-09 三次，跑完即还原；全文件基线 `Tests 16 passed (16)`）：
   * ① **只**把 `start.sh` 的 `report_notebook` 末尾那句横幅退回 `7789/tree` ⇒ `DV_I2_SH_EXIT=1`、
   *    **只有本条红**（`Tests 1 failed | 15 passed (16)`），红在**第一句**：
   *    `start.sh 的横幅还在给 /tree ⇒ …: expected 'set -uo pipefail\ncd "$(dirname "$0")…' to contain '7789/jupyter/tree'`
   *    —— received 以 `set -uo pipefail` 开头而不是 `#!/usr/bin/env bash` ⇒ 视图确实是剥离过注释的；
   *    而这一次变异里 `start.sh` 的**注释仍然带着正确的** `7789/jupyter/tree`，它没能把这一句喂绿；
   * ② **只**把 `start.ps1` 的 `Report-Notebook` 末尾那句 `Write-Host` 退回 `7789/tree` ⇒ `DV_I2_PS_EXIT=1`、
   *    只有本条红（`Tests 1 failed | 15 passed (16)`），红在**第二句**
   *    （`start.ps1 的横幅与 start.sh 不同步…: expected 'param(\n  [switch]$Rebuild,\n  [switc…' to contain …`）
   *    ⇒ 两句各自都能独立翻脸，"两个实现"不是靠一句 `&&` 糊起来的；
   * ③ 反向对照：**只**把 `start.sh` 注释 ④ 里那条给人照抄的 curl 的路径改成 `7789/tree`、`say` 那行不动
   *    ⇒ `DV_I2_COMMENT_EXIT=0`、`Tests 16 passed (16)` ⇒ 注释里的对错不参与判据
   *    （否则每次写排障注释都像是在改闸门，而 ① 已经证明反方向不成立：注释里的正确值喂不绿它）。
   * 另一次普查（同一轮，按行分类数出来的）：`7789/jupyter/login` 在两个脚本的非注释行各 1 处、注释 0 处；
   * `7789/jupyter/tree` 在 `start.sh` 是**非注释行 1 处 + 注释行 1 处**、`start.ps1` 非注释行 1 处、注释 0 处
   * ⇒ 探测那两句今天没被注释喂到，但横幅这一句**只要不走 codeView 就必然被 `start.sh` 的注释 ④ 喂绿**。
   */
  it('start.sh 与 start.ps1 的横幅里那条链接也带前缀（用户点开的那一条，判据走注释剥离后的视图）', () => {
    const link = `7789${NOTEBOOK_TREE_PATH}`;          // 期望值派生，不写死 '/jupyter/tree'
    const shView = codeView(readFileSync(join(config.repoRoot, 'start.sh'), 'utf8'));
    const psView = codeView(readFileSync(join(config.repoRoot, 'start.ps1'), 'utf8'));
    // 空转防护：codeView 把整行注释丢掉之后，两个视图里确实还剩东西（filter 坏了这里先红，
    // 而不是让下面两句"在注释里读到配置"然后绿得毫无意义）
    expect(shView.length, 'start.sh 的代码视图是空的 ⇒ codeView 的 filter 坏了').toBeGreaterThan(100);
    expect(psView.length, 'start.ps1 的代码视图是空的 ⇒ codeView 的 filter 坏了').toBeGreaterThan(100);
    expect(shView, 'start.sh 的横幅还在给 /tree ⇒ base_url 之后那条链接必 404，而这是跑 ./start.sh 的人看到的第一句话').toContain(link);
    expect(psView, 'start.ps1 的横幅与 start.sh 不同步 ⇒ 两个人照着不同的一句话修不同的东西').toContain(link);
  });
});
