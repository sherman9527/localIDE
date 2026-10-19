// @vitest-environment jsdom
import './dom-shim';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 第五页（Jupyter notebook）。
 *
 * 这里判的不是"好不好看"，而是**界面不许说假话**——各态各说什么、什么时候不许说：
 * ① 在跑 ⇒ 一个点得开的**同源**链接 `/jupyter/tree`（WI-98：链接里从来没有凭据；
 *    "这条连接过不过守卫"由后端的 `localPeer` 说话，false ⇒ 点开会被 403，横幅必须说破）；
 * ② 没在跑 ⇒ 必须说清"做题不受影响"，并且**不许渲染那个链接**（给一条点开就是浏览器报错的死链，
 *    比不给链接更坏 —— 本项目管这叫静默降级）；
 * ③ kernel 没就绪 ⇒ 给「准备环境」按钮，而不是让人对着 kernel 启动失败猜自己的写法；
 * ④ ~~`running:true` + `reason` + 没有 url（publicUrl 被 env 配坏的 `nolink` 态）~~
 *    **WI-98 整块删除**：链接是编译期派生的同源路径，没有任何 env 能让它坏 ⇒ 这一态结构上
 *    不可能再发生，留着分支与用例就是装饰判据（"删判据必须说清判的对象为什么不存在了"—— 这就是说明；
 *    实现与后端用例里的同一段理由见 `server/src/notebooks/status.ts` 与 `status.test.ts`）。
 * 那几句边界话（共用环境——按 kernel 点名 / 绝对路径拦不住 / CPU 两个 JVM 的真实量级 /
 * Scala 报错形状 / Scala 不支持补全·悬浮·中断 / 答案可读不是安全边界 / 只在本机打得开，
 * 逐字清单见下面的 `boundarySentences`）在任何一态都常驻。
 *
 * ## WI-94 Task 6 加进来的那一维：notebook 现在**内嵌在这一页里**，不是"跳出去开一个标签页"
 *
 * 于是多了四件要钉的事，每件都对应一种会说谎的形状：
 * ① iframe 的 `src` 是**同源相对路径**（`/jupyter/…`，由 `@arena/shared` 那三个常量派生）。
 *    写死 `http://127.0.0.1:7789/…` 的话，用 `localhost` 打开页面的人就变成跨源，浏览器给这个
 *    iframe 判 `cross-site` ⇒ 被 Jupyter 的 Host/Origin 守卫拒（症状是 iframe 里一片 403/登录页，
 *    而我们这一页一切照绿）。断言里那句 `not.toContain('token')` 钉的是 WI-94 的**目的本身**：
 *    凭据只在服务端注入，页面结构上拿不到它。
 *    **WI-98 之后逃生链接与 iframe 共用这条纪律** —— 它也不含 token 也不是绝对地址，
 *    所以"页面永远不许出现带 token 的 notebook URL"从"iframe 那一半 + 链接那一半两套判据"
 *    收成一条：**整页 DOM 文本里不许出现 `token=`**（下面「服务在跑」那条判的就是整页）。
 * ② `running:false` 时**不许**有 iframe、也**不许**打那次 `notebookFiles`。那棵子树在这个实例上
 *    结构上到不了（e2e 那个实例永远是这一态，它的判据就建立在这条上）；摆一个空 iframe 是说谎。
 * ③ 左栏那份列表的两种"空"各占一处：有 `error` ⇒「这一次读不到」；`files:[]` 且没有 `error` ⇒
 *    「目录里就是没有」。**还没读到**则是第三种形状 —— 既不是说谎的时刻，也不许抢答"没有"
 *    （下面那条 pending 的用例钉的就是它；`seedError` 那对用例是同一个纪律的先例）。
 *    第四种（评审 I-1）：**那一发整请求失败**（404 / 连不上）⇒ 第三句 `notebook-tree-unread` 说话，
 *    三句两两互斥。它不是③的重复：③说的是"请求跑完了、服务端答不出目录"，这一句说的是"没有答复"。
 *    第五种（Task 7c 按裁定补）：**旧列表还挂着、这一轮刷新失败**（`listing && filesError`）⇒
 *    `notebook-tree-stale` 说"这次没读到，下面是上一次读到的"。四句是同一条三元链的四个分支 ⇒ 结构上互斥。
 * ④ 换状态要真的换到 DOM 上：点左栏某份笔记 ⇒ **同一个 iframe 节点**换 `src`（换节点=每次点击都
 *    重启一遍 Jupyter 页面，那是功能故障，不是审美问题）。
 *
 * 顺带一条被删掉的东西：内核徽章那一排（`notebook-kernels`）没了，但 `blocked`（「准备环境」）与
 * `missingSpecIds`（该 `--rebuild`）两条诊断必须还在 —— 它们修的是两件不同的事。
 *
 * ## 2026-10-10 用户点名的布局简化（这一档删的是容器，不是话）
 *
 * 「运行时」卡壳（`notebook-status-card`）、`card-head` 那层标题、"这次铺了什么"整块
 * （`notebook-files` / `notebook-files-empty`）按批的范围删掉，三把按钮并入 page-head 工具条。
 * 随块消失的判据只有两条：open 态列得出 `00-smoke-pyspark.ipynb`、对照态必现 `notebook-files-empty`
 * —— 它们判的对象已经不在这页上了。补回来的是三条：① 卡壳/标题/那块在 open 与 down **两态**都必不出现
 * （"用户点名删的东西，删没删要能被判住，而不是靠人眼"；down 态是那块清单以前**必出现**的一态，
 * 只测 open 态分不清"删掉了"与"恰好没数据"）；② 状态句两两互斥的**总判据**（原来散在各条用例的
 * 点名式 toBeNull，加第五、第六句时没人回头补得起来，这条一次顶满；WI-98 把 `nolink` 删掉后
 * 它从五句收成四句 —— 串与用例**同时**删，只删一边它自己就会红，那是设计如此）；
 * ③ seedError 横幅换家到横幅区后仍必现 —— 它是话，不是容器。状态行的话逐字未动，边界话逐字未动
 *（当时五段；WI-91b Task 5 接入第二条 kernel 后长到七段，逐字契约始终只有 `boundarySentences` 这一份）
 * （`boundarySentences` 契约原样）。
 */

const status = vi.fn();
const prepare = vi.fn();
const files = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    notebookStatus: () => status(),
    notebookPrepareEnv: () => prepare(),
    notebookFiles: () => files(),
  },
}));

import Notebook from '../src/pages/Notebook';
import { JUPYTER_BASE_URL, NOTEBOOK_KERNELS, NOTEBOOK_TREE_PATH, notebookDocPath } from '@arena/shared';

/**
 * 夹具里那份"后端给的链接"。**WI-98 之后它就是同源常量 `NOTEBOOK_TREE_PATH`** ——
 * 这一页只渲染 `res.url`、从不自己拼路径（`notebook-open` 那条断言钉的就是这件事），
 * 所以夹具直接用 `@arena/shared` 的常量，而不是抄一份 `http://127.0.0.1:7789/…?token=x`：
 * 抄旧形状的字面量会把"链接曾经是绝对地址 + 长期凭据"伪装成今天仍然成立的形状，
 * 而"页面不许出现带 token 的 notebook URL"这条总判据（下面逐条判）会先被夹具自己喂绿。
 */
const TREE = NOTEBOOK_TREE_PATH;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * 左栏那份列表**每个用到 open 态的用例都要有一份**：不给默认值的话，没设 mock 的用例里
 * `api.notebookFiles()` 回的是 `undefined`，`useAsync` 会在 `undefined.then(...)` 上当场抛 ——
 * 那种红说的是"这个用例忘了摆夹具"，不是"页面坏了"。单条用例再覆盖一次即可。
 */
beforeEach(() => {
  files.mockResolvedValue({ files: [] });
});

/**
 * 左栏那四句形状**任何两句都不同时出现**的总判据（Task 7d 补）。
 *
 * 为什么已有的一堆 `queryByTestId(...).toBeNull()` 还不算这条：它们是"从某一支的视角逐个点名另几支"，
 * 点名是手写死的 —— 第四句加进来时没人回头给前三条补 `toBeNull()`（本轮之前 `-unread` 那条就没点 `-stale`），
 * 于是"漏点对"会静默通过。这一条一次顶满 6 对：新增第五、第六句时它自动把它们收进正则，不需要谁记得。
 *
 * 它判的是**结构**而不是内容：`data-testid` 前缀 `notebook-tree-` 下还挂着 `notebook-tree`（容器）与
 * `notebook-tree-item`（列表项），所以用 `^(...)$` 全匹配只取那四句话本身。
 * `toHaveLength(0 或 1)` 而不是 `<= 1`：0 只允许出现在"还没读回来"那一态，写松就把"四句全哑"也放过了。
 */
const treeLinesSpeaking = (): string[] =>
  screen.queryAllByTestId(/^notebook-tree-(error|unread|stale|empty)$/).map((el) => el.getAttribute('data-testid') ?? '?');

/**
 * 工作树根的绝对路径。不用 `new URL('../src/App.tsx', import.meta.url)`：jsdom 下那个 url 没有 file:
 * 协议，readFileSync 直接 "The URL must be of scheme file"。而两种跑法（仓库根 `npx vitest run web/test`
 * 与 `npm test -w @arena/web`）的 cwd 差一层，所以按候选根找，找不到就把原因说出来。
 * 原来这份住在「打包与路由形状」那个 describe 里；现在夹具也要读盘上的镜像工件（见 `kernelLabel`）
 * ⇒ 提到模块级共用，**不在两处各抄一份**（"两处各写一遍"的账见
 * `server/test/regression/notebook-contract.test.ts` 里那条同族判据）。
 */
const repoFile = (rel: string): string => {
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const candidate = join(base, rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 ${rel}（cwd=${process.cwd()}）⇒ 这条判据没在读你要改的那份工作树文件`);
};

/**
 * kernel 的 `display_name` **读镜像工件** `docker/jupyter/kernels/<id>/kernel.json` ——
 * 与 `server/test/notebooks/status.test.ts` 里 `SHIPPED_KERNEL_SPEC` 同一条来源纪律（评审 Minor-5：
 * 这一度是手抄的，而且和 server 那侧抄的**不一致**：这里 'Scala (Toree)'、那边
 * 'Scala (Toree, WI-91 探索)'）。夹具抄错不会让任何断言红，它只会让判据去判一个镜像里根本不存在的
 * 字符串 —— 而 `display_name` 本体的改名归 Task 5（它在镜像构建上下文里），本档不碰。
 */
const kernelLabel = (id: string): string => {
  const rel = join('docker', 'jupyter', 'kernels', id, 'kernel.json');
  let file: string;
  try {
    file = repoFile(rel);
  } catch {
    // 分叉时报"哪个名字对不上"，不要只丢一句"找不到文件"让人去猜是哪一侧改的
    // （notebook-image.test.ts / notebook-contract.test.ts 里同一条判据、同一句解释）
    throw new Error(
      `${rel} 不存在 ⇒ NOTEBOOK_KERNELS 登记的 '${id}' 与 docker/jupyter/kernels/ 下的目录名分叉了：` +
        '改常量要同时改目录（和 Dockerfile 的 COPY 目标）。',
    );
  }
  return (JSON.parse(readFileSync(file, 'utf8')) as { display_name?: string }).display_name ?? id;
};

/**
 * 注册表里"解释器住在那份**懒创建** venv 里"的那几条（`needsVenv` 是条目数据，WI-96 的账）。
 * 只有它们能合法地以 `ready:false` 出现在夹具里 —— 上面文件头那条纪律（"夹具写成不可能的形状，
 * 判出来的绿就只对不可能的输入成立"）在这里靠这份派生来保证，不是靠人记得。
 */
const VENV_BAKED_IDS: readonly string[] = Object.values(NOTEBOOK_KERNELS).filter((k) => k.needsVenv).map((k) => k.id);

/** 「准备环境」修得了的那一态里，后端给的原因原话（前端只做逐条拼接，不改写）。 */
const MISSING_VENV_REASON = '解释器不存在：/opt/arena-ide-env/python/bin/python';

/**
 * 后端列出的那张 kernel 表（夹具=**输入**，允许出现镜像里的目录名；**期望值**一律另派生）。
 * `venvMissing` 的两个语义各自独立于注册表有几条：**整张注册表都在场**是这一族的默认，
 * 因为评审 Important-2 抓到的正是"只列 pyspark 一条"的旧夹具在新注册表形状下会
 * **顺带**触发 `notebook-spec-missing`（"探到的表里缺了注册表那条 ⇒ ./start.sh --rebuild"）——
 * 那与那些用例判的事（按钮、seedError、iframe src、点一次重读一遍…）毫无关系，
 * 却把"没有失败却不点名才是假警报"这类用例的前提自己涂掉了。
 * 派生自注册表 ⇒ 以后多一条 kernel，这里不必改一个字也仍然代表"全都注册了"。
 */
const arenaKernels = (venvMissing = false): Array<{ id: string; label: string; ready: boolean; reason?: string }> =>
  Object.values(NOTEBOOK_KERNELS).map((k) =>
    venvMissing && VENV_BAKED_IDS.includes(k.id)
      ? { id: k.id, label: kernelLabel(k.id), ready: false, reason: MISSING_VENV_REASON }
      : { id: k.id, label: kernelLabel(k.id), ready: true },
  );

const up = {
  running: true,
  url: TREE,
  /** WI-98：后端把合取的结论（这条连接过不过守卫）随响应送出；基准夹具是"本机连接"那一半。 */
  localPeer: true,
  // ⚠ 清单里**只有 arena 自己注册的那几条**（终审 I-4）：后端会把 Jupyter 列出的
  // `Python 3 (ipykernel)` 滤掉，所以"服务端回了 python3"这种形状在这一档里是不存在的。
  // 下面那几条 `ready:false` 的夹具因此一律走 `arenaKernels(true)` —— 夹具写成不可能的形状，
  // 判出来的"前端接得住这一态"就只对不可能的输入成立（本项目要的反面正是这种绿）。
  // ⚠ WI-91b Task 3 + 评审 Important-2：这份"一切正常"的基准 = **整张注册表都在场且都就绪**，
  //   少一条就把"横幅态"（该 rebuild）当成了健康态；表本身与标签都由 `arenaKernels()` 派生。
  kernels: arenaKernels(),
  notebooks: [{ file: '00-smoke-pyspark.ipynb', seeded: true }],
};

describe('Notebook 第五页', () => {
  it('服务在跑：给可点开的地址（同源），且内核徽章那一排已经没了（WI-94 Task 6）', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
    // 链接就是那个同源 url 本身，不由前端二次拼（第二处真相）；它既不含 scheme 也不含 token
    const href = screen.getByTestId('notebook-open').getAttribute('href');
    expect(href).toBe(NOTEBOOK_TREE_PATH);
    expect(href, '逃生链接变成绝对地址 ⇒ localhost / 127.0.0.1 两种打开方式之一必跨源，与 iframe 那条同判据').not.toMatch(/^https?:/);
    expect(href, '凭据不进 URL —— WI-98 的目的本身（旧版这里断的是 `?token=x` 原样透传，形状整个反了）').not.toContain('token');
    // 整页 DOM 文本都不许出现 token 串（真浏览器层另有一条同判据，e2e）
    expect(screen.getByTestId('notebook-page').textContent ?? '', '页面上任何一处出现 token 串都算泄漏（含内嵌、链接、横幅回显）').not.toContain('token');
    // 徽章那一排删了 ⇒ 那句 label 在 DOM 上再没有任何来源。留着这条断言不是为了"徽章没了"这口气，
    // 是为了**这一排的删除没有顺手把 kernels 这个数据源一起搬走**：blocked / missingSpecIds 两块还靠它。
    expect(screen.queryByTestId('notebook-kernels')).toBeNull();
    // Task 3：整张注册表都在探到的表里（`up` 就是这份基准）⇒ "没注册"横幅**不许**无中生有。
    // 这一句是 missingSpecIds 改造成"逐条点名"后的反向对照：只点缺的，不点在场的。
    // ⚠ 它只覆盖"一切就绪"那一态；反向对照的完整版本（含 blocked 那一态）在下面那组循环用例。
    expect(screen.queryByTestId('notebook-spec-missing'), '表里两条都在却挂"没注册"横幅 ⇒ 叫人去 rebuild 一个没坏的镜像（新版的静默降级形状）').toBeNull();
    expect(screen.getByTestId('notebook-page').textContent).not.toContain('PySpark (arena)');
    // 「这次铺了什么」那份清单整块删掉了（用户点名，2026-10-10）：这里原来断的是"open 态列得出
    // 00-smoke-pyspark.ipynb" —— 判的对象没了，断言随块搬家成"它必不出现"，专门那条见
    // 「卡壳与那块确实没了」（open 与 down 两态各查一次，别只信这一眼的 null）。
    expect(screen.queryByTestId('notebook-files')).toBeNull();
    // 反向也要判：全都就绪时不许挂一个"准备环境"按钮（给了就是让人白点）
    expect(screen.queryByTestId('notebook-prepare')).toBeNull();
  });

  /**
   * 反向对照的**总判据**（评审 Important-2）：原来"注册表全在场 ⇒ 不挂 rebuild 横幅"只在 `up`
   * 那一态判过一次，而那句话的适用面是"任何把整张注册表列出来的状态"——包括**有 kernel 起不来**那一态。
   * 两轴是正交的：`notebook-spec-missing` 判"注册表条目在不在探到的表里"，`blocked` 判"这条就绪没有"，
   * 只在一切就绪时判"不报警"，等于让"blocked 那一态顺带叫用户 rebuild 一个没坏的镜像"这种假警报
   * 没有任何判据看着（而那正是旧夹具的形状）。列表派生自注册表 ⇒ 加一条 kernel 这里不必改一个字。
   */
  const fullRegistryStates: Array<[string, Array<{ id: string; label: string; ready: boolean; reason?: string }>]> = [
    ['整张注册表都在且都就绪', arenaKernels()],
    ['整张注册表都在、needsVenv 那条缺 venv', arenaKernels(true)],
  ];
  for (const [label, kernels] of fullRegistryStates) {
    it(`注册表全在场 ⇒「spec 没注册」横幅不出现（${label}）`, async () => {
      status.mockResolvedValue({ running: true, url: TREE, localPeer: true, kernels, notebooks: [] });
      render(<Notebook />);
      await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
      expect(screen.queryByTestId('notebook-spec-missing'), `${label}：整张注册表都在场却挂"没注册"横幅 ⇒ 假警报，叫人 rebuild 一个没坏的镜像`).toBeNull();
      // 那句操作也不许以别的形式漏出去（横幅是它唯一的载体；页面文本层再判一次，防"换个壳继续喊"）
      expect(screen.getByTestId('notebook-page').textContent ?? '', `${label}：横幅没了但那句 ./start.sh --rebuild 还挂在别处`).not.toContain('./start.sh --rebuild');
    });
  }

  /**
   * **横幅区不许出现空的分组壳。** 这一条是 Step 3 第 8 条（真浏览器截图）暴露出来的缺陷，
   * 不是审美：壳自带上下留白（2026-10-10 布局简化前还各带一条 `border-top`），于是"壳在而内容
   * 全是 `null`"时页面上出现的是一段**没有任何话的空白带** —— 读者会去找那句被"漏掉"的话，
   * 而它根本不存在。
   *
   * 为什么两档自动化原本都照不出来（也是这条为什么要配一个 e2e 兄弟判据）：
   *  · jsdom 没有布局 —— 空壳与有内容的壳在 `textContent` 判据下长得一模一样，所以这里只能判
   *    **DOM 形状**（壳的数量、每个壳有没有子节点）；
   *  · e2e 那个实例永远是 `running:false`，横幅区此刻本来就有话（那句"做题不受影响"）
   *    ⇒ "壳的真实盒子不塌陷"由 `tests/e2e/notebook-page.spec.ts` 量高度钉住。
   *
   * 简化后全场只剩这一个壳，三种读法各数一次，"1"和"0"都不是被写死的巧合：
   *  · open 且一切正常：壳必须存在，由逃生链接那句解释撑着（把壳删掉也在这条红）；
   *  · down：诊断那句"做题不受影响"撑着（把它一起删掉=把"没在跑"那句话说没了，同一条红）；
   *  · 还没读到（loading）：横幅区没有任何一句话可说 ⇒ **整块缺席** —— "空则不渲染"在新布局
   *    里的形状；壳要是还在，页面上就是状态行下面一段没有话的空白。
   */
  it('横幅区不许出现空的分组壳：留白后面必须真有一句话（真浏览器实测发现的缺陷）', async () => {
    status.mockResolvedValue(up);
    files.mockResolvedValue({ files: ['01-a.ipynb'] });
    const first = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    const openGroups = [...document.querySelectorAll('.nb-group')];
    expect(
      openGroups.length,
      '在跑且一切正常时多出来的分组壳 ⇒ 状态行下面出现没有话的空白带（壳本身又必须存在：逃生链接那句解释住在里面）',
    ).toBe(1);
    for (const g of openGroups) expect(g.childElementCount, '空的 .nb-group 还挂在 DOM 上').toBeGreaterThan(0);
    first.unmount();

    // 换一态：这一态横幅区有话要说（那句"做题不受影响"），壳必须还在，且不是靠解释句撑的
    status.mockResolvedValue({ running: false, reason: '这个实例没有被给予 ARENA_JUPYTER_TOKEN …', kernels: [], notebooks: [] });
    const second = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-down')).toBeTruthy());
    const downGroups = [...document.querySelectorAll('.nb-group')];
    expect(downGroups.length, '诊断那一组此刻有内容，壳必须存在（把它一起删掉=把"没在跑"那句话说没了）').toBe(1);
    for (const g of downGroups) expect(g.childElementCount, '空的 .nb-group 还挂在 DOM 上').toBeGreaterThan(0);
    second.unmount();

    // 第三态：一次都没读到过 ⇒ 横幅区一句可选的话都没有 ⇒ 整块不渲染（连壳都不许留）
    status.mockReturnValue(new Promise(() => {}));
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-status').textContent).toContain('正在读 notebook 状态'));
    expect(document.querySelectorAll('.nb-group').length, 'loading 态留着空壳 ⇒ 状态行下面是一段没有话的空白带').toBe(0);
  });

  /**
   * 用户点名的简化要能被判住（派发词第 3 条：删没删不许靠人眼）。卡壳、标题「运行时」、
   * "这次铺了什么"那块在 open 与 down **两态**都必不出现 —— down 态是那块清单以前**必出现**的
   * 一态（`GET /api/notebook/status` 顺带铺示例，`data.notebooks` 与在不在跑无关；夹具故意给一份
   * notebooks，判的就是"就算后端还回着那份数据，页面也不列它"）。
   * 浏览器层有同一件事的兄弟判据（`tests/e2e/notebook-page.spec.ts` 数 count 0）。
   */
  it('「运行时」卡壳与「这次铺了什么」那块确实没了（open 与 down 两态各查一次）', async () => {
    const absentChecks = (state: string): void => {
      expect(screen.queryByTestId('notebook-status-card'), `${state}：卡壳又回来了 ⇒ 用户点名"去掉运行时这张卡"没守住`).toBeNull();
      expect(screen.queryByRole('heading', { name: '运行时' }), `${state}：「运行时」标题又回来了`).toBeNull();
      expect(screen.queryByTestId('notebook-files'), `${state}：那份带徽标的示例清单又回来了`).toBeNull();
      expect(screen.queryByTestId('notebook-files-empty'), `${state}：那句"没有示例"又回来了`).toBeNull();
      expect(screen.getByTestId('notebook-page').textContent ?? '', `${state}：那块的小标题还在`).not.toContain('这一页读到的示例');
    };

    status.mockResolvedValue(up);
    files.mockResolvedValue({ files: ['01-a.ipynb'] });
    const first = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    absentChecks('open');
    first.unmount();

    status.mockResolvedValue({
      running: false,
      reason: 'Jupyter 未在监听：ECONNREFUSED',
      kernels: [],
      notebooks: [{ file: '00-smoke-pyspark.ipynb', seeded: false }],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-down')).toBeTruthy());
    absentChecks('down');
  });

  /**
   * **WI-98 把这一族从"链接里没有 token"改成"这条连接过不过守卫"（`localPeer`）**，
   * 理由写在 `server/src/notebooks/status.ts` 与简报 §1.4：链接是同源路径，**本机连接也没有 token**，
   * 旧判据 `!url.includes('token=')` 会把每一台本机用户都误报成"非本机" —— 那句话改了含义才活着，
   * 删掉它才是静默降级（"话不许静默消失"的纪律）。三句内容逐条判：
   * ①会被拒的是守卫不是服务（"403"+"守卫"）；②这不是故障（"不是 Jupyter 坏了"）；
   * ③这一页设计上只在宿主本机用（"只在宿主本机"+"不是漏配" —— 手机/iPad 是 2026-10-05 的决定）。
   * 派发词那条"顺手加一条"：`localPeer:false` 时页面上**仍然没有** token 串 —— 说实话的横幅
   * 不许顺手把凭据印出来安慰读者。
   */
  it('localPeer:false（非本机连接）⇒ 当场说破"会被守卫直接 403"，说明这不是故障，且页面上仍然没有 token 串', async () => {
    status.mockResolvedValue({ ...up, localPeer: false });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    const hint = screen.getByTestId('notebook-not-local');
    expect(hint.textContent, '①被拒的必须是守卫，不是"服务坏了/链接坏了"').toContain('403');
    expect(hint.textContent).toContain('守卫');
    expect(hint.textContent, '②这不是故障 —— 读者照旧不许被引导去重启一个正在好好干的服务').toContain('不是 Jupyter 坏了');
    expect(hint.textContent, '③设计上只在宿主本机用（手机/iPad 不是漏配）').toContain('只在宿主本机');
    expect(hint.textContent).toContain('不是漏配');
    expect(screen.getByTestId('notebook-page').textContent ?? '', '横幅说实话不许顺带印凭据').not.toContain('token');
  });

  /** 对照的那一态单独一个 it：同一次 render 里换 mock 值换不掉已经挂上去的那句话。 */
  it('localPeer:true（本机连接）⇒ 那句"会被 403"不许出现（旧判据按 url 里没有 token 推，会把这一态误报 —— 这正是含义搬家后必须单独钉的一行）', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.queryByTestId('notebook-not-local'), '两句话同时出现 ⇒ 读者分不清自己是不是本机；按旧形状推更是人人误报').toBeNull();
  });

  /**
   * 四句状态话的**总判据**（派发词那条"任何两句不许同时出现"）：每一态渲染一次，
   * `notebook-status` 里出现的句子**恰好一个**，且必须等于该态那句。
   * 为什么已有的点名式 `queryByTestId(...).toBeNull()` 不算这条：它们只从某一态的视角手点另几态，
   * 加第五、第六句时没人回头补对点（`notebook-tree-*` 那族就漏过一回，见 `treeLinesSpeaking` 的注释）——
   * 这条一视同仁地扫全部句子。几句同住一处三元链（`web/src/pages/Notebook.tsx`），
   * 这条只会更好判，**不许放宽成"至少一个"或"至多一个"**：toEqual([expected]) 同时钉住"说了"与"只说了这句"。
   * ⚠ **WI-98：从五句收成四句** —— '在跑，但地址给不出来'（`nolink`）与它的渲染分支**同时**删除，
   * 串留着而分支没了 ⇒ 本条红，分支留着而串没了 ⇒ 那条 mock 到不了任何句子（toEqual 落空）同样红。
   * 这条总判据是 2026-10-11 补的，它就是设计来在"只改一边"时红的 —— 那一红是路标，不是回归。
   */
  const statusSentences = ['运行中 · Jupyter 在本机答话', '没在运行', '状态读不到', '正在读 notebook 状态'];
  it('四态状态行两两互斥：每一态恰好说一句，任何两句不同时出现（总判据；nolink 随 WI-98 删除）', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['在跑', () => status.mockResolvedValue(up), '运行中 · Jupyter 在本机答话'],
      ['没在跑', () => status.mockResolvedValue({ running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] }), '没在运行'],
      // （原第三条「在跑但链接坏」随 nolink 态整块删除 —— 它的成因是"env 能把链接拼坏"，
      //  而 WI-98 之后链接是同源常量，`running:true` + 没有 `url` 在契约与实现里都不再可达。）
      ['这次读不到', () => status.mockRejectedValue(new Error('连不上本地服务')), '状态读不到'],
      ['还没读到', () => status.mockReturnValue(new Promise(() => {})), '正在读 notebook 状态'],
    ];
    for (const [label, set, expected] of cases) {
      set();
      const { unmount } = render(<Notebook />);
      // 先等那一句话题上台（前面几态是"loading → 目标态"的两段式渲染，不等就会拿 loading 那帧来判）
      await waitFor(() => expect(screen.getByTestId('notebook-status').textContent).toContain(expected));
      const spoken = statusSentences.filter((s) => (screen.getByTestId('notebook-status').textContent ?? '').includes(s));
      expect(spoken, `「${label}」这一态的状态行说了 ${spoken.length} 句（应恰好 1 句：「${expected}」）`).toEqual([expected]);
      unmount();
    }
  });

  /* ─────────── WI-94 Task 6：这一页现在**内嵌** notebook（左树 + 右 iframe） ─────────── */

  /**
   * 内嵌这条路的第一判据是 **src 的形状**：同源相对路径 + 默认落在"文件管理" + **不带 token**。
   * 三条各拦一件具体的事：
   *  - 绝对地址（把 `127.0.0.1:7789` 写进页面）在"用 localhost 打开"那次变成跨源 ⇒ iframe 被判
   *    `cross-site`、被 Jupyter 的守卫拒；而页面自己一切照绿，坏只在 iframe 里那片 403。
   *  - 默认落 `notebookDocPath(...)` 会假设目录里至少有一份示例（Task 6 派发词里那句"计划原稿自相矛盾"
   *    的裁定：默认是"文件管理"）。
   *  - URL 里出现 token 就把 WI-94 的目的本身抵消掉了（凭据只在服务端注入）。
   * 最后一条**在 WI-98 反着钉了一次**：旧版这里断的是"逃生链接照旧是后端给的那个带 token 的绝对
   * 地址"（内嵌与跳出两套形状）；现在两条路共用同一条纪律 —— 链接也必须是同源、不含凭据。
   * 注意页面仍然只是**渲染后端给的那条 `url`**（不在前端二次拼，这条没变），所以"同源"这一半
   * 真正判的是后端契约（`server` 那侧的 `toBe(NOTEBOOK_TREE_PATH)`），这里判的是"页面不改写它、
   * 也不另拼一条" —— 一把尺子现在量得到两条路，是因为两条路本来就是同一条。
   */
  it('running:true 时页面渲染同源 iframe，默认落在"文件管理"，src 是 `/jupyter/` 且**不含 token**', async () => {
    status.mockResolvedValue({ ...up, kernels: [], notebooks: [] });
    files.mockResolvedValue({ files: ['01-skew.ipynb'] });
    render(<Notebook />);
    const frame = await screen.findByTestId('notebook-frame');
    expect(frame.getAttribute('src')).toBe(JUPYTER_BASE_URL);
    expect(frame.getAttribute('src'), '凭据不进页面（这一条是整个 WI-94 的目的）').not.toContain('token');
    expect(frame.getAttribute('src'), '绝对地址 ⇒ localhost / 127.0.0.1 两种打开方式之一必跨源').not.toMatch(/^https?:/);
    const href = screen.getByTestId('notebook-open').getAttribute('href');
    expect(href, '逃生链接不再是后端给的那条同源路径 ⇒ 前端在二次拼链接（第二处真相）').toBe(NOTEBOOK_TREE_PATH);
    expect(href, 'WI-98：页面永远不许出现带 token 的 notebook URL —— iframe 与链接现在共用这一条').not.toContain('token');
    expect(href).not.toMatch(/^https?:/);
  });

  /**
   * 「换一次状态再看 DOM」这一档的单元层版本：只看首屏等于没测。
   * `toBe(frame)` 那条是**节点身份**判据：给 iframe 挂 `key={selected}` 或用两个不同的 iframe 分支
   * 都会让它红 —— 而那两种写法的症状不是报错，是"每点一次左栏就把 Jupyter 页面重启一遍"。
   */
  it('左栏点一份笔记 ⇒ iframe 的 src 换过去（换一次状态再看 DOM，不看首屏就算白测）', async () => {
    status.mockResolvedValue({ ...up, kernels: [], notebooks: [] });
    files.mockResolvedValue({ files: ['01-skew.ipynb', '02-partitions.ipynb'] });
    render(<Notebook />);
    const frame = await screen.findByTestId('notebook-frame');
    expect(frame.getAttribute('src')).toBe(`${JUPYTER_BASE_URL}`); // 默认落在文件管理
    // ⚠ `findAllByTestId` 而不是 `getAllByTestId`：iframe 只等 status，左栏要等**第二次**读
    //   （listing 的 effect 在 data.running 翻真之后才发），两者不是同一次微任务。
    //   本轮 verify:fast 实测：单文件跑 `getAll` 绿、整片并行跑红在"找不到 notebook-tree-item" ——
    //   那种红说的是"这一档负载下 listing 还没回来"，不是"页面坏了"。
    const items = await screen.findAllByTestId('notebook-tree-item');
    expect(items).toHaveLength(2);
    // `!` 不是敷衍：上一条刚数过 2，这里越界只可能是有人在数与点之间改了夹具
    fireEvent.click(items[1]!);
    expect(screen.getByTestId('notebook-frame').getAttribute('src')).toBe(notebookDocPath('02-partitions.ipynb'));
    expect(screen.getByTestId('notebook-frame')).toBe(frame); // 同一个 iframe 节点换 src，不重挂（重挂=每次点击都重启 jupyter 页面）
    fireEvent.click(screen.getByTestId('notebook-manage'));
    expect(screen.getByTestId('notebook-frame').getAttribute('src')).toBe(`${JUPYTER_BASE_URL}`);
  });

  /**
   * 派发词里那条硬规矩的最小版本：`/jupyter` 这个字面量在 `web/` 里不许自己长第二份。
   * 判的是 iframe 的 src **等于 shared 派生值**（`JUPYTER_BASE_URL` / `notebookDocPath`），
   * 与上一条合起来 = "页面只消费派生值"。前缀分家时的症状是"iframe 里每个资源都 404"，
   * 而三档验证全绿 —— 见 `server/test/regression/notebook-contract.test.ts` 里同一条纪律的先例。
   */
  it('文件名里带空格 / 中文时 src 走逐段 encode，不是把整串塞进路径', async () => {
    status.mockResolvedValue(up);
    files.mockResolvedValue({ files: ['我的 笔记#1.ipynb'] });
    render(<Notebook />);
    const frame = await screen.findByTestId('notebook-frame');
    // 同上：等的是**左栏那一次读**，不是 iframe 那一次
    fireEvent.click(await screen.findByTestId('notebook-tree-item'));
    // 期望值是**字面量**：写成 notebookDocPath(...) 就退化成自证（shared/test/notebook-path.test.ts 的理由）
    expect(frame.getAttribute('src')).toBe('/jupyter/notebooks/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0%231.ipynb');
  });

  /**
   * `seedError` 那条纪律的孪生：两种"空"各占一处。
   * `notebookFiles` 的语义（Task 5 已钉死）：`files:[]` **且没有** `error` = 目录里就是没有；
   * 有 `error` = 这一次读不到。把后者说成前者就是本仓库最恨的静默降级 ——
   * 读者会去翻一个本来有文件的目录，而该查的是权限/挂载。
   */
  it('文件列表读不到时补一句"读不到"，不把空列表说成"没有笔记"（seedError 那条纪律的孪生）', async () => {
    status.mockResolvedValue({ ...up, kernels: [], notebooks: [] });
    files.mockResolvedValue({ files: [], error: '读不到 notebook 工作目录（EPERM）：permission denied' });
    render(<Notebook />);
    // ⚠ 这里不用 brief 原稿的 toHaveTextContent / toBeInTheDocument：本仓库没有装 @testing-library/jest-dom
    //   （全仓 grep 无一处使用），而这一档的规矩是不引新依赖 —— 判据逐条翻成本文件既有的写法。
    const line = await screen.findByTestId('notebook-tree-error');
    expect(line.textContent).toContain('读不到 notebook 工作目录');
    expect(line.textContent).toContain('EPERM');
    expect(screen.queryByTestId('notebook-tree-empty'), '读不到时说"目录里没有"就是第二条谎').toBeNull();
    expect(treeLinesSpeaking(), '四句里同时说了两句 = 那条三元链被拆成了独立 if').toHaveLength(1);
  });

  /**
   * 第三种形状：**还没读到**。brief 原稿那段代码是 `(listing?.files ?? []).length === 0` 就报"没有"，
   * 于是首屏一定会闪一句"目录里现在没有笔记"——而这一次读还没回来。这一页对同一个纪律早有先例
   * （`seedError` 那对"铺不进去 vs 没有示例"、左栏的"读不到 vs 没有"都是同一条），所以这里补一条把它钉住：
   * pending 的那一会儿两种话都不许说。
   * 破坏性验证（本轮实测，见 task-6-report.md）：去掉 `listing &&` 守卫 ⇒ 本条红。
   */
  it('列表还没读回来时不许抢答"目录里现在没有笔记"，也不许报"读不到"', async () => {
    status.mockResolvedValue(up);
    files.mockReturnValue(new Promise(() => {})); // 永远 pending：只可能出现的形状就是"还没读到"
    render(<Notebook />);
    await screen.findByTestId('notebook-frame');
    expect(screen.queryByTestId('notebook-tree-empty'), '没读到就说"没有"，是与 seedError 同型的谎').toBeNull();
    expect(screen.queryByTestId('notebook-tree-error')).toBeNull();
    expect(treeLinesSpeaking(), 'pending 那一态四句都不该说（说了就是抢答）').toHaveLength(0);
  });

  /**
   * **第四种形状：那一发整请求失败**（非 2xx / 连不上）—— 评审 I-1，也是本轮开发中真实发生过的形状：
   * 旧容器上 `curl /api/notebook/files` 回 404，而页面一句话都不说（`useAsync` 的 `error` 当时没被解构），
   * 左栏只剩"文件管理"一项 ⇒ 读者只会以为目录被清空了。同一个文件对 status 早有先例
   * （「这次没读到，下面显示的是上一次读到的状态」），左栏没有 ⇒ 本轮补上，并由这条钉住。
   *
   * 三句话**互斥**是这条的形状判据：
   *  - `notebook-tree-empty`   = "读过，目录里就是没有"；
   *  - `notebook-tree-error`   = **服务端**在响应里回了 `error` 字段（"我读了，读不到"）；
   *  - `notebook-tree-unread`  = 连那一发都没跑完（本条）—— 它必须带错误文本，否则"没读到"仍是半句谎
   *    （读者分不清 404「路由不在」与「连不上」，那两件修的是不同东西）。
   *
   * 破坏性验证（本轮实测，红法见 task-7a-report.md）：把页面里 `!listing && filesError` 那一支删掉 ⇒ 本条红。
   */
  it('那一发整请求失败（404 / 连不上）⇒ 左栏说一句"这一次没读到列表"并带上错误文本，且不抢答另外两句', async () => {
    status.mockResolvedValue(up);
    files.mockRejectedValue(new Error('HTTP 404'));
    render(<Notebook />);
    const line = await screen.findByTestId('notebook-tree-unread');
    expect(line.textContent).toContain('这一次没读到');
    expect(line.textContent, '不带上错误文本 = 只说"没读到"，读者分不清是路由不在还是连不上').toContain('HTTP 404');
    expect(screen.queryByTestId('notebook-tree-empty'), '没读到却说"目录里没有" = 把不知道说成没有').toBeNull();
    expect(screen.queryByTestId('notebook-tree-error'), '那句"读不到"判的是服务端给的 error 字段，这一发压根没有响应').toBeNull();
    expect(treeLinesSpeaking(), '四句里同时说了两句 = 那条三元链被拆成了独立 if').toHaveLength(1);
  });

  /**
   * **第五种形状：手上还挂着上一轮读到的列表，而这一轮刷新失败**（`listing && filesError`）。
   * 状态那一行对同一件事早有先例（`error && data` ⇒「这次没读到，下面显示的是上一次读到的状态」），
   * 左栏过去没有：列还显示旧的那两份、一句"这次没读到"都不说 = 拿上一轮的真相冒充刚读到的
   * （本项目在桥 token 上付过同一次学费）。Task 7a 把它登记成"没有判据"，本轮（7c）按裁定补上。
   *
   * 判据要同时钉住两头，缺一头都是假绿：
   *  - 只钉"新句在场" ⇒ 有人把它写成"每次都说话"（连一次都没读到过也在说）也判不住；
   *  - 只钉"旧列表还在" ⇒ 有人把 `useAsync` 改成失败时清空 data（那变成"没有笔记"那句谎）也判不住。
   * 四句**互斥**由渲染点那一条三元链的结构保证（`web/src/pages/Notebook.tsx` 的 `notebook-tree-*` 链）。
   * 下面把另三句逐个 `toBeNull()` 是**点名式**的、会漏点对（第四句加进来时前三条并没回头补），
   * 所以另有 `treeLinesSpeaking()` 那条总判据一次顶满 6 对 —— 叠出同时两句，就是那条链被拆成独立 `if` 的第一天。
   */
  it('上一轮列表还在、这一轮刷新失败 ⇒ 左栏说"这次没读到，下面是上一次读到的"，且不抢答另三句', async () => {
    status.mockResolvedValue(up);
    files.mockResolvedValueOnce({ files: ['01-skew.ipynb', '02-partitions.ipynb'] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getAllByTestId('notebook-tree-item')).toHaveLength(2));
    expect(screen.queryByTestId('notebook-tree-stale'), '第一轮就报"这次没读到" = 这一轮明明读到了').toBeNull();

    // 换掉默认实现 ⇒ 从下一次请求起整发失败（`useAsync` 失败那一支保留 prev.data，见 web/src/lib/hooks.ts:41）
    files.mockRejectedValue(new Error('HTTP 503'));
    fireEvent.click(screen.getByTestId('notebook-reload'));

    const line = await screen.findByTestId('notebook-tree-stale');
    expect(line.textContent).toContain('这次没读到');
    expect(line.textContent, '不带上错误文本 = 只说"没读到"，读者查不到坏在哪').toContain('HTTP 503');
    expect(screen.getAllByTestId('notebook-tree-item'), '那句话讲的是"下面是上一次读到的"，旧列表被清空就成了两句互相打脸').toHaveLength(2);
    expect(screen.queryByTestId('notebook-tree-empty'), '这一轮没读到 ⇒ 不许说"目录里现在没有笔记"').toBeNull();
    expect(screen.queryByTestId('notebook-tree-error'), '那句是服务端给的 error 字段，这一发压根没有响应体').toBeNull();
    expect(screen.queryByTestId('notebook-tree-unread'), '那句判的是"一次都没读到过"，这里手上明明有一份旧的').toBeNull();
    expect(treeLinesSpeaking(), '四句里同时说了两句 = 那条三元链被拆成了独立 if').toHaveLength(1);
  });

  /**
   * 内嵌这一态在 `running:false` 时必须整块不出现（派发词第②条）。
   * 为什么这条不能只靠 e2e：e2e 那个实例结构上只有这一态，"不该有 iframe"在那里是**默认成立**的
   * ——页面压根没渲染过那块，谁都不知道它是因为判据还是因为没接线。这一条在单元层把两半都钉住：
   * 不渲染子树 + 连那次 readdir 都不必发（服务没起时打它只会多一条 503 的噪声）。
   */
  it('running:false 时**没有** iframe、没有树 —— 那棵子树结构上到不了，写一个空 iframe 就是谎', async () => {
    status.mockResolvedValue({ running: false, reason: '这个实例没有被给予 ARENA_JUPYTER_TOKEN …', kernels: [], notebooks: [] });
    render(<Notebook />);
    expect(await screen.findByTestId('notebook-down')).toBeTruthy();
    expect(screen.queryByTestId('notebook-frame')).toBeNull();
    expect(screen.queryByTestId('notebook-tree')).toBeNull();
    expect(files).not.toHaveBeenCalled(); // 服务没起时连那次 readdir 都不必发
  });

  // WI-98：原来钉在这里的两条 `nolink` 用例（"在跑但 publicUrl 配坏时也不许出现 iframe" 与
  // "在跑但 publicUrl 配坏：既不说『点开它』，也不说『没在运行』"）**整块删除**，判的对象没了：
  // 它们钉的是 `running:true` + `reason` + 没有 `url` 这一态，而它唯一的成因是
  // "链接由 `new URL(ARENA_NOTEBOOK_PUBLIC_URL + …)` 拼、env 能被配坏"。现在链接是编译期派生的
  // 同源常量，`running:true` 恒带 `url` ⇒ 这一态在契约与实现里都不可达，继续摆一个 `running:true`
  // 却没有 `url` 的 mock 只会**伪造**一态然后判前端接得住一个不存在的输入（本仓库明确要的反面）。
  // 同源纪律的另一半（"running:false 不许有 iframe"）由上面那条守着，一行没松。

  /**
   * 删掉的只有徽章那一排。`blocked`（venv 没建 ⇒ 「准备环境」修得了）与 `missingSpecIds`
   * （探到的表里缺了注册表里**哪几条** ⇒ 镜像级注册，得 `--rebuild`）是两件不同的事，
   * 删错任何一个就是删掉一条真实的诊断路径。
   * ⚠ 评审 Important-2：这条判的是"两件事分得开"，那夹具就得**每半只坏一件事** ——
   * 上一半"注册表全在场、venv 没建"（rebuild 横幅必不出现），下一半"表整个是空的"（按钮必不出现）。
   * 旧形状里上一半只列 pyspark 一条，于是它同时坏两件事，"分清"那句只是注释里的声称。
   */
  it('内核徽章那一排没了，但「准备环境」与「spec 没注册」两条还在（前者修 venv，后者修镜像）', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      // 整张注册表都在场、只有 needsVenv 那条起不来 ⇒ 这一态**只**该说"准备环境"那一件事
      kernels: arenaKernels(true),
      notebooks: [],
    });
    const first = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    expect(screen.queryByTestId('notebook-kernels')).toBeNull();
    // 评审 Important-2：这一半的 premise 是"blocked 与 spec-missing 是**两件不同的事**"。
    // 于是"venv 没建"这一态必须**只**说前者：整张注册表都在场时那条 rebuild 横幅必不出现 ——
    // 旧夹具只列 arena-pyspark 一条，注册表长出 scala 之后页面就在这里顺带挂上横幅，
    // 这条用例上半句混着说两件事、下半句再"分清两件事"，它自己的前提被自己的夹具拆了。
    expect(screen.queryByTestId('notebook-spec-missing'), 'venv 没建 ≠ spec 没注册：整张注册表都在场却叫人 ./start.sh --rebuild').toBeNull();
    first.unmount();

    status.mockResolvedValue({ running: true, url: TREE, localPeer: true, kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-spec-missing')).toBeTruthy());
    // 反向那一半（同一条"两件事"的判据）：表整个是空的 ⇒ blocked 是空表 ⇒「准备环境」按钮必不出现，
    // 否则这一态与上面那态在 DOM 上就没差别了，"分清"也就无从判起。
    expect(screen.queryByTestId('notebook-prepare'), '整张表都没注册时给「准备环境」= 让人白点：建 venv 不会多出 kernelspec').toBeNull();
    expect(screen.queryByTestId('notebook-kernels')).toBeNull();
  });

  /**
   * 「刷新状态」重读的是**这一页的全部真相**，不是只有运行时那一半。
   * 只重读 status 的话，用户在 Jupyter 里新建了一份笔记、回到这一页按刷新，左栏还是旧的那两份 ——
   * 那是"拿旧真相冒充新真相"（本项目在桥 token 上付过同一次学费）。
   */
  it('按「刷新状态」也会重读左栏那份列表', async () => {
    status.mockResolvedValue(up);
    files.mockResolvedValue({ files: ['01-skew.ipynb'] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getAllByTestId('notebook-tree-item')).toHaveLength(1));
    expect(files).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('notebook-reload'));
    await waitFor(() => expect(files).toHaveBeenCalledTimes(2));
  });

  /**
   * 边界卡折成 `<details>`（用户批的第 4 件：措辞由本文件钉着，只是收成一行）。
   * 这里判两件事：折叠结构真的存在（有人顺手把 `<details>` 拆回常开会红），
   * 而**默认是折着的**（默认展开就等于没折叠）。DOM 上边界话还在 —— jsdom 里折叠不影响
   * `textContent`，所以上面那组 `boundarySentences` 用例照旧全过；"看不见"那一半归 e2e，
   * 由 `tests/e2e/notebook-page.spec.ts` 里"先展开再断可见"那条钉。
   * ⚠ 段落数 5 → 7 是 WI-91b Task 5：接入 Scala kernel 后新增两段（报错形状、补全/悬浮/中断不支持），
   * 且"共用环境 / pip / CPU"三段改成按-kernel 点名。计数判据**两头都咬**：少一段红（删话），
   * 多一段也红（话与契约分家）—— 它必须跟着 boundarySentences 同批改，改一边这条就红。
   */
  it('边界卡是折起来的 `<details>`，但七段话逐字仍在 DOM 上', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-boundary')).toBeTruthy());
    const details = screen.getByTestId('notebook-boundary').querySelector('details');
    expect(details, '边界卡不是 <details> ⇒ 用户批的"压成一行/折叠"这件没做').not.toBeNull();
    expect(details!.hasAttribute('open'), '默认展开 ⇒ 折叠这一态根本没生效').toBe(false);
    expect(screen.getByTestId('notebook-boundary').querySelectorAll('p')).toHaveLength(7);
  });

  /**
   * WI-91b Task 5 ③（页面上不许出现 Scala 的 language_info.version）。
   * 事实（探索档与 WI-91b 计划 §0 定案）：Toree 制品自报的 `language_info.version` 是它编译期的
   * **2.12.15**，而镜像里真正加载的是 Spark 3.5.5 带的 **2.12.18**（类路径让 /opt/spark/jars 赢，
   * 见 kernel.json 的 arena_classpath_note）。两个数**都不许**显示给这一页：
   * 前者是 kernel 亲口说的谎，后者虽然是真的但来源不是这个自报字段 —— 放上去就是把一个
   * "对不上任何协议读数"的版本号供成界面事实。今天页面上没有任何组件渲染 language_info，
   * 所以这条判据钉的是"保持这样"：它是"不显示"这句话唯一能长牙的形式
   *（破坏性验证：往 page-head 那句里塞一个 `2.12.15`，本条必须红 —— 读数在 task-5-report.md）。
   */
  it('页面上任何一态都不许出现 Scala 的 language_info.version（2.12.15 与 2.12.18 都不行）', async () => {
    const versionStates: Array<[string, unknown]> = [
      ['在跑', up],
      ['没在跑', { running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] }],
      ['非本机连接', { running: true, url: TREE, localPeer: false, kernels: [], notebooks: [] }],
    ];
    for (const [label, value] of versionStates) {
      status.mockResolvedValue(value);
      const { container, unmount } = render(<Notebook />);
      await waitFor(() => expect(screen.getByTestId('notebook-boundary')).toBeTruthy());
      expect(
        screen.getByTestId('notebook-page').textContent ?? '',
        `${label} 态把 2.12.x 印给了用户 ⇒ language_info.version（谎报 2.12.15 / 实载 2.12.18）上了页面（Task 5 ③）`,
      ).not.toMatch(/2\.12\.\d+/);
      // 判 innerHTML 而不是只判文本：版本塞进 title/aria-label 这类 attribute 时 textContent 是瞎的
      expect(container.innerHTML, `${label} 态的 DOM（含 attribute）里出现 2.12.x`).not.toMatch(/2\.12\.\d+/);
      unmount();
    }
  });

  it('没在运行：说清"做题不受影响"，并且不给死链接', async () => {
    status.mockResolvedValue({ running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-status').textContent).toContain('没在运行'));
    expect(screen.getByTestId('notebook-page').textContent).toContain('做题不受影响');
    expect(screen.queryByTestId('notebook-open')).toBeNull();
    // reason 必须原样上屏：三个失败原因修的是不同东西，合成一句"不可用"会让人去查错的地方
    expect(screen.getByTestId('notebook-page').textContent).toContain('Jupyter 未在监听：ECONNREFUSED');
  });

  it('kernel 没就绪（venv 还没建）：给「准备环境」按钮，而不是让人对着报错猜', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      // I-4 之后后端只会列 arena 自己那几条 kernel；Task 3 之后"那几条"= **整张注册表** ⇒ 夹具派生自注册表，
      // 谁 blocked 由条目数据 `needsVenv` 决定（评审 Important-2：只列 pyspark 会顺带挂上 rebuild 横幅）
      kernels: arenaKernels(true),
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    expect(screen.getByTestId('notebook-page').textContent).toContain('解释器不存在');
  });

  // （原「在跑但 publicUrl 配坏：既不说"点开它"，也不说"没在运行"」用例随 `nolink` 态一起整块删除，
  //  理由见上面那段 WI-98 注释：链接不再是 env 能拼坏的绝对地址，这一态结构上不可达。）

  /**
   * 「准备环境」不能是个摆设：点下去要真的打那个 POST（venv 只在显式动作里建），
   * 而且建完要重新读一次状态 —— 否则按钮按完界面还停在"没就绪"，用户以为没生效。
   */
  it('点「准备环境」= 一次显式 POST + 一次状态重读', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      // I-4 之后后端只会列 arena 自己那几条 kernel；Task 3 之后"那几条"= **整张注册表** ⇒ 夹具派生自注册表，
      // 谁 blocked 由条目数据 `needsVenv` 决定（评审 Important-2：只列 pyspark 会顺带挂上 rebuild 横幅）
      kernels: arenaKernels(true),
      notebooks: [],
    });
    prepare.mockResolvedValue({ ok: true });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    expect(status).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('notebook-prepare'));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('准备环境失败时把原因摊开说，不许"点了没反应"', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      // I-4 之后后端只会列 arena 自己那几条 kernel；Task 3 之后"那几条"= **整张注册表** ⇒ 夹具派生自注册表，
      // 谁 blocked 由条目数据 `needsVenv` 决定（评审 Important-2：只列 pyspark 会顺带挂上 rebuild 横幅）
      kernels: arenaKernels(true),
      notebooks: [],
    });
    prepare.mockResolvedValue({ ok: false, reason: 'venv 创建超时' });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    fireEvent.click(screen.getByTestId('notebook-prepare'));
    await waitFor(() => expect(screen.getByTestId('notebook-prepare-result').textContent).toContain('venv 创建超时'));
  });

  /**
   * 评审 Fix-1 的 Minor：「准备环境」那句话讲的是**那一轮**动作。
   * 成功之后留着"环境建好了，正在重读…"，用户再手动刷新一次，界面就成了"这句话在替新一轮说话"——
   * 那是最轻的一种假话，但仍然是假话（而且它会一直挂着到下一次点按钮）。
   */
  it('手动刷新状态时收掉上一轮「准备环境」那句话', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      // I-4 之后后端只会列 arena 自己那几条 kernel；Task 3 之后"那几条"= **整张注册表** ⇒ 夹具派生自注册表，
      // 谁 blocked 由条目数据 `needsVenv` 决定（评审 Important-2：只列 pyspark 会顺带挂上 rebuild 横幅）
      kernels: arenaKernels(true),
      notebooks: [],
    });
    prepare.mockResolvedValue({ ok: true });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    fireEvent.click(screen.getByTestId('notebook-prepare'));
    await waitFor(() => expect(screen.getByTestId('notebook-prepare-result')).toBeTruthy());
    fireEvent.click(screen.getByTestId('notebook-reload'));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(
      screen.queryByTestId('notebook-prepare-result'),
      '上一轮"环境建好了，正在重读…"还挂在页面上 ⇒ 它现在在替这一轮说话',
    ).toBeNull();
  });

  /**
   * 评审 I-1 的前端那一半：`seedError` 是"示例铺不进去"，与"没有示例"是两件事。
   * 混起来的症状很难查：磁盘只读 / ENOSPC 时界面写着"没有示例"，读者就会去翻示例目录，
   * 而该修的是挂载。这一行必须是**一句 config/IO 诊断**，不许读成"服务坏了"，
   * 也不许抢走状态那一行（此刻仍然照说"运行中"）。
   * 2026-10-10 布局简化：那条与 `notebook-files-empty` 的互斥断言随块搬家了 —— "没有示例"那句
   * 按用户批的范围整片删掉，互斥对象没了；这条现在判的是"换家之后 seedError 仍在、仍是一句诊断"
   * （它是话不是容器，删它=静默降级，所以这一半判据一个字没松）。
   */
  it('示例铺不进去：单独说一句原因，且不许把状态行带跑', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      kernels: arenaKernels(),
      notebooks: [],
      seedError: '示例没能铺进工作目录（这一条与 Jupyter 在不在跑无关）：EEXIST: file already exists, mkdir',
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-seed-error')).toBeTruthy());
    const line = screen.getByTestId('notebook-seed-error');
    expect(line.textContent).toContain('EEXIST');
    // role 必须是 status：它是"某一半没做成"，不是"整个服务不可用"（alert 会把朗读打断成故障）
    expect(line.getAttribute('role')).toBe('status');
    // 状态那一半不许被带跑：seed 坏了 Jupyter 照样在跑
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
  });

  /** 对照的那一态：没有 seedError 时不许凭空报"铺不进去"（假警报那一半的判据）。
   *  这条原来等的是 `notebook-files-empty` 必现 —— 那句与"这次铺了什么"那块一起按用户批的范围删了，
   *  所以搬家后的判据只剩"不许有假警报"；真报的那一半由上一条守着。两半合起来才是互斥。
   *  ⚠ 评审 Important-2：判"假警报"的用例自己**不许**在喂一份会触发别的警报的夹具 ——
   *  旧夹具只列 arena-pyspark 一条，注册表长出 scala 之后它一边断"没有失败却不点名才是假警报"、
   *  一边让页面顺带挂上 rebuild 那条横幅。现在夹具是整张注册表（`arenaKernels()`），
   *  并把"这一态一条警报都不许响"判满。 */
  it('没有 seedError 时不许报"铺不进去"（对照态：没有失败却不点名，才是假警报）', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      kernels: arenaKernels(),
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.queryByTestId('notebook-seed-error'), '没有失败却报一句失败 = 最响的假警报').toBeNull();
    expect(screen.queryByTestId('notebook-spec-missing'), '对照态自己挂着"spec 没注册"横幅 ⇒ 判假警报的用例就在报假警报').toBeNull();
    expect(screen.queryByTestId('notebook-prepare'), '全都就绪的对照态出现「准备环境」= 让人白点，也是另一种假警报').toBeNull();
  });

  /**
   * 每一句一条都不能省（Step 4；`db08cf8` 之后清单从 3 句长到 7 句，WI-91b Task 5 接入第二条 kernel
   * 后长到 13 句，用例名里的"三句"就是这么一路留下的假话 —— 名字不改是历史，清单与逐字判据必须跟上），
   * 而且**换一态再看**：
   * 只在"在跑"那态显示，等于在用户最该看见的时候（他要开始装包 / 开 notebook 了）把它收走。
   * 评审 Fix-1 的 Minor：一态一个 `it` —— 一个循环里三态共用一条用例名，红的时候只知道
   * "有一句不在"，得再翻代码才知道是哪一态掉的。
   */
  const boundarySentences = [
    // ⚠ 终审 I-5：这一组第一句原样是「这些包与 IDE 共用同一份环境，判题器看不到」——
    // 那是把**一个默认**写成了**一道保证**：`!/usr/local/bin/pip3 install X` 落进的就是判题那套解释器，
    // 这一页拦不住它（拦的是闸门 `notebook-env-isolation.test.ts` 与 `ide-env-isolation.test.ts`）。
    // 同理漏掉的第二件事是 CPU：kernel 自带 `--master local[2] --driver-memory 512m`，
    // 那是「判题优先、IDE 排队、不抢占」那套安排**看不见**的第二个 Spark JVM。
    // 所以这里换成"说是默认 + 说破拦不住 + 说破 CPU 不在这道页管辖内"的四句，一句都不许省。
    // ⚠ WI-91b Task 5：接入第二条 kernel 之后，"共用环境"与"pip 装进哪套"两句**必须点名到 kernel**
    //（arena-pyspark 与 IDE 共用 venv，arena-scala-toree 是镜像里的独立 Java 进程、压根不碰它），
    // CPU 那句要带 Scala 侧**真实的 JVM 量级**（`-Xmx2g -Dspark.master=local[2]`，读自
    // `docker/jupyter/kernels/arena-scala-toree/kernel.json`，不是把 Python 那两个数抄第二遍）；
    // 再加 Scala 侧两件（报错形状 `Unknown Error`/空堆栈帧、补全·悬浮·中断三样不支持）。清单只增。
    '判题用的是另一套解释器',
    '这是默认，不是这道页面上的强制',
    '完全不碰 IDE 那份 venv',
    '装进的就是判题那套解释器',
    '那是判题池之外的第二个 Spark JVM',
    '-Xmx2g -Dspark.master=local[2]',
    'Unknown Error',
    '报错有，但堆栈帧没有，能看的那句话在错误消息里',
    '这三样不支持',
    '悬浮文档',
    'notebook 里能读到题库的参考答案',
    '这不是安全边界',
    '只在浏览器本机打开：地址是 127.0.0.1，手机 / iPad 访问不了',
  ];
  const boundaryCases: Array<[string, unknown]> = [
    ['在跑', up],
    ['没在跑', { running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] }],
    // 第三态原来是「在跑但没链接」（nolink，env 配坏）—— WI-98 删掉了那一态（见上面那段说明）；
    // 换成本档今天真实存在的第三形状：**在跑但这条连接过不了守卫**。边界话在它上面同样必须常驻
    // （"只在浏览器本机打开"那一句与 localPeer 说的正是同一件事，缺席就是最响的谎）。
    ['非本机连接', { running: true, url: TREE, localPeer: false, kernels: [], notebooks: [] }],
  ];
  for (const [label, value] of boundaryCases) {
    it(`三句边界话在「${label}」这一态都常驻`, async () => {
      status.mockResolvedValue(value);
      render(<Notebook />);
      await waitFor(() => expect(screen.getByTestId('notebook-page')).toBeTruthy());
      const text = screen.getByTestId('notebook-page').textContent ?? '';
      for (const s of boundarySentences) {
        expect(text, `${label} 这一态少了那句：${s}`).toContain(s);
      }
    });
  }

  /**
   * 「kernel 表里没有 arena-pyspark」与「kernel 没就绪」是两种坏法，修的是不同东西：
   * 前者是镜像级的 kernelspec 注册（要 `./start.sh --rebuild`），后者缺的是 IDE 那份 venv（按钮修得了）。
   * 混在一起的症状是用户对着「准备环境」点了半天，而缺的那一层根本不在 venv 里 —— 界面必须说破区别。
   * ⚠ WI-91b Task 3：横幅改成"注册表里缺哪条点哪条"（旧实现只 key 在 pyspark 上，
   * 半接入的镜像会少点一条的名 = 静默）。三态各判一次：全缺 ⇒ 两条都点名；只缺 scala ⇒ 只点 scala；
   * 只缺 pyspark ⇒ 只点 pyspark。期望的 id 一律从 `NOTEBOOK_KERNELS` 派生。
   */
  it('kernel 表里没有 arena-pyspark：说清"准备环境修不了它"，并且不给那个按钮', async () => {
    status.mockResolvedValue({ running: true, url: TREE, localPeer: true, kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-spec-missing')).toBeTruthy());
    const banner = screen.getByTestId('notebook-spec-missing');
    expect(banner.textContent).toContain('./start.sh --rebuild');
    // 表整个是空的 ⇒ 注册表里**每一条**都缺，逐条点名（点名清单派生自注册表，不写死）
    for (const id of Object.values(NOTEBOOK_KERNELS).map((k) => k.id)) {
      expect(banner.textContent, `探到的表里缺了 ${id} 却不点它的名 ⇒ "半接入"被读成"没问题"（Task 3）`).toContain(id);
    }
    expect(screen.queryByTestId('notebook-prepare'), '建 venv 不会多出那个 spec ⇒ 给按钮就是让人白点').toBeNull();
  });

  /**
   * Task 3 的两态对照（派发词点名要加的）："表里有没有"从**一条**变成**逐条**之后，
   * 横幅不许再把在场的条目一起点名 —— 那会把用户支去 rebuild 一个其实只少一条的镜像，
   * 也不许把缺的那条咽下去 —— 那正是"半接入"的静默形状。
   */
  it('spec-missing 只点缺的那条：只注册 pyspark ⇒ 点 scala 的名；只注册 scala ⇒ 点 pyspark 的名（各自都不点在场那条）', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      kernels: [{ id: NOTEBOOK_KERNELS.pyspark.id, label: kernelLabel(NOTEBOOK_KERNELS.pyspark.id), ready: true }],
      notebooks: [],
    });
    const first = render(<Notebook />);
    const b1 = await screen.findByTestId('notebook-spec-missing');
    expect(b1.textContent, '表里没有 scala ⇒ 必须点它的名，否则"镜像只注册了一半"就静默了').toContain(NOTEBOOK_KERNELS.scala.id);
    expect(b1.textContent, 'pyspark 明明在场，不许连它一起点名（那是叫人 rebuild 一个没坏的注册）').not.toContain(NOTEBOOK_KERNELS.pyspark.id);
    expect(b1.textContent).toContain('./start.sh --rebuild');
    first.unmount();

    status.mockResolvedValue({
      running: true,
      url: TREE,
      localPeer: true,
      kernels: [{ id: NOTEBOOK_KERNELS.scala.id, label: kernelLabel(NOTEBOOK_KERNELS.scala.id), ready: true }],
      notebooks: [],
    });
    render(<Notebook />);
    const b2 = await screen.findByTestId('notebook-spec-missing');
    expect(b2.textContent, '表里没有 pyspark ⇒ 必须点它的名（旧实现只 key 在 scala 缺席这一侧）').toContain(NOTEBOOK_KERNELS.pyspark.id);
    expect(b2.textContent, 'scala 在场，不许被顺带点名').not.toContain(NOTEBOOK_KERNELS.scala.id);
  });

  /**
   * 刷新失败而手上还有上一次读到的东西：状态照旧显示，但必须补一句"这次没读到"。
   * 少了那一句，界面就是在**拿旧真相冒充新真相**（桥 token 那次付过同样的学费）。
   */
  it('刷新失败时不许拿旧状态冒充新状态', async () => {
    status.mockResolvedValueOnce(up).mockRejectedValue(new Error('连不上本地服务'));
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    fireEvent.click(screen.getByTestId('notebook-reload'));
    await waitFor(() => expect(screen.getByTestId('notebook-error').textContent).toContain('这次没读到'));
    expect(screen.getByTestId('notebook-error').textContent).toContain('连不上本地服务');
    // 上一次的状态仍在（不白屏），但那一行"运行中"必须与"这次没读到"同时成立
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
  });

  it('状态读不到（服务没起 / 500）时不白屏，且仍说得出那句"不是安全边界"', async () => {
    status.mockRejectedValue(new Error('连不上本地服务'));
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-error')).toBeTruthy());
    expect(screen.queryByTestId('notebook-open')).toBeNull();
    // 状态那一栏自己也要说"不知道"：读不到时它不许停在"加载中…"（那是永远等不到的第三种谎）
    expect(screen.getByTestId('notebook-status').textContent).toContain('状态读不到');
    expect(screen.getByTestId('notebook-page').textContent).toContain('连不上本地服务');
    expect(screen.getByTestId('notebook-page').textContent).toContain('这不是安全边界');
  });
});

/**
 * 这一组不在 DOM 里，判的是**打包形状**：第五页必须还是那片懒加载的。
 * 两条断言各守一头：第一条（`const Notebook = lazy(...)` 必须独立成行）才是"懒加载"本身的判据 ——
 * 换成静态 import、并进注释都会让它红；第二条钉的是 App.tsx 自己没有 `import Notebook` 这一行。
 * 但它们都只读得到 App.tsx，看不见"别的页面把 Notebook 静态拉回去"这种**传导性拖回** ——
 * 那一半由 `scripts/check-bundle.mjs` 的 `FORBIDDEN_IN_ENTRY['notebook-page']`（产物层，
 * 判这一页自己的 data-testid）接管。实测（本轮破坏性验证）：把 `lazy` 换成静态 import、重新构建后
 * check-bundle **exit 1**，红在首屏 chunk 命中 "notebook-page" 那一行（体积那关反而过得去：
 * 78.5KB/84KB —— 所以盯住它的确实是包含判据而不是预算）。源码形状 + 产物包含，两把尺子各管一段。
 */
describe('Notebook 的打包与路由形状', () => {
  /** `repoFile` 现在住在模块顶层（夹具读镜像工件时也要它），这里直接用那一份，不再本地抄第二份。 */
  const app = readFileSync(repoFile(join('web', 'src', 'App.tsx')), 'utf8');

  it('App.tsx 里 Notebook 是 lazy 那一片，且没有被静态 import 拉回首屏', () => {
    const lines = app.split('\n');
    expect(
      lines.some((l) => /^\s*const Notebook = lazy\(\(\) => import\('\.\/pages\/Notebook'\)\)/.test(l)),
      'lazy 那行必须以独立一行的 `const Notebook = lazy(...)` 存在（并进注释 = 整片回落到首屏）',
    ).toBe(true);
    expect(
      lines.some((l) => /^import\s+Notebook\s+from\s+['"]\.\/pages\/Notebook['"]/.test(l)),
      '出现静态 import ⇒ Notebook 被拖进首屏那一份 JS',
    ).toBe(false);
  });

  it('router.tsx 认得 /notebook（第五页有入口，NAV 也有它）', async () => {
    // 行为判据而不是"源码里出现过这个字符串"：被同行注释吞掉时字符串还在，路由却回 unknown
    const { parseRoute } = await import('../src/router');
    expect(parseRoute('#/notebook').name).toBe('notebook');
    expect(parseRoute('#/notebook?x=1').query.get('x')).toBe('1');
    expect(parseRoute('#/nosuchpage').name).toBe('unknown');
    // 导航第 5 项：写在 App.tsx 的 NAV 里，链接与页面名同源
    expect(app).toContain("{ href: '/notebook', label: 'Notebook', name: 'notebook' }");
  });
});
