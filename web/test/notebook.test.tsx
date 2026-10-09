// @vitest-environment jsdom
import './dom-shim';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 第五页（Jupyter notebook）。
 *
 * 这里判的不是"好不好看"，而是**界面不许说假话**——三态各说什么、什么时候不许说：
 * ① 在跑且给得出链接 ⇒ 一个能点开的地址（本机才有 token；非本机时链接照样在，只是要手贴）；
 * ② 没在跑 ⇒ 必须说清"做题不受影响"，并且**不许渲染那个链接**（给一条点开就是浏览器报错的死链，
 *    比不给链接更坏 —— 本项目管这叫静默降级）；
 * ③ kernel 没就绪 ⇒ 给「准备环境」按钮，而不是让人对着 kernel 启动失败猜自己的写法；
 * ④ 评审第二条裁定的**第三种形状**：`running:true` + `reason` + **没有 url**
 *    （publicUrl 被 env 配坏）。它既不是"点开它"也不是"没在运行"，必须单独一态：
 *    说成前者是谎（链接不存在），说成后者也是谎（服务确实在跑）。
 * 那几句边界话（共用环境 / 绝对路径拦不住 / CPU / 答案可读不是安全边界 / 只在本机打得开，
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
 * ② `running:false` 时**不许**有 iframe、也**不许**打那次 `notebookFiles`。那棵子树在这个实例上
 *    结构上到不了（e2e 那个实例永远是这一态，它的判据就建立在这条上）；摆一个空 iframe 是说谎。
 * ③ 左栏那份列表的两种"空"各占一处：有 `error` ⇒「这一次读不到」；`files:[]` 且没有 `error` ⇒
 *    「目录里就是没有」。**还没读到**则是第三种形状 —— 既不是说谎的时刻，也不许抢答"没有"
 *    （下面那条 pending 的用例钉的就是它；`seedError` 那对用例是同一个纪律的先例）。
 *    第四种（评审 I-1）：**那一发整请求失败**（404 / 连不上）⇒ 第三句 `notebook-tree-unread` 说话，
 *    三句两两互斥。它不是③的重复：③说的是"请求跑完了、服务端答不出目录"，这一句说的是"没有答复"。
 * ④ 换状态要真的换到 DOM 上：点左栏某份笔记 ⇒ **同一个 iframe 节点**换 `src`（换节点=每次点击都
 *    重启一遍 Jupyter 页面，那是功能故障，不是审美问题）。
 *
 * 顺带一条被删掉的东西：内核徽章那一排（`notebook-kernels`）没了，但 `blocked`（「准备环境」）与
 * `missingSpec`（该 `--rebuild`）两条诊断必须还在 —— 它们修的是两件不同的事。
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
import { JUPYTER_BASE_URL, NOTEBOOK_TREE_PATH, notebookDocPath } from '@arena/shared';

/**
 * 夹具里那份"后端给的链接"（WI-94 Task 1 之后它带 `/jupyter` 前缀）。
 * 路径从 `@arena/shared` 派生而不是在本文件再长一遍字面量：这一页**只渲染 `res.url`**、
 * 从不自己拼路径（`notebook-open` 那条断言钉的就是这件事），所以夹具里的串应当与后端
 * 真的会给的那个形状同源 —— 抄一份写死的字面量，判的就只是"我抄得对不对"。
 */
const TREE = `http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}`;

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

const up = {
  running: true,
  url: `${TREE}?token=x`,
  // ⚠ 清单里**只有 arena 自己注册的那几条**（终审 I-4）：后端会把 Jupyter 列出的
  // `Python 3 (ipykernel)` 滤掉，所以"服务端回了 python3"这种形状在这一档里是不存在的。
  // 下面那几条 `ready:false` 的夹具因此也都写成 arena-pyspark —— 夹具写成不可能的形状，
  // 判出来的"前端接得住这一态"就只对不可能的输入成立（本项目要的反面正是这种绿）。
  kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
  notebooks: [{ file: '00-smoke-pyspark.ipynb', seeded: true }],
};

describe('Notebook 第五页', () => {
  it('服务在跑：给可点开的地址，且内核徽章那一排已经没了（WI-94 Task 6）', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
    // 链接就是那个 url 本身，不由前端二次拼（端口写死在页面里 = 第二处真相）
    expect(screen.getByTestId('notebook-open').getAttribute('href')).toBe(`${TREE}?token=x`);
    // 徽章那一排删了 ⇒ 那句 label 在 DOM 上再没有任何来源。留着这条断言不是为了"徽章没了"这口气，
    // 是为了**这一排的删除没有顺手把 kernels 这个数据源一起搬走**：blocked / missingSpec 两块还靠它。
    expect(screen.queryByTestId('notebook-kernels')).toBeNull();
    expect(screen.getByTestId('notebook-page').textContent).not.toContain('PySpark (arena)');
    expect(screen.getByTestId('notebook-page').textContent).toContain('00-smoke-pyspark.ipynb');
    // 反向也要判：全都就绪时不许挂一个"准备环境"按钮（给了就是让人白点）
    expect(screen.queryByTestId('notebook-prepare')).toBeNull();
  });

  /**
   * **状态卡里不许出现空的分组壳。** 这一条是 Step 3 第 8 条（真浏览器截图）暴露出来的缺陷，
   * 不是审美：每个 `.nb-group` 带一条 `border-top` + 一段 `--space-4` 留白，于是"壳在而内容全是
   * `null`"时页面上出现的是一条**没有任何话的空白带加一根分隔线** —— 而分隔线的意思是
   * "上面那组说完了"，读者会去找那句并不存在的话。最常见的那一态（在跑、一切正常）本来挂两条。
   *
   * 为什么两档自动化原本都照不出来（也是这条为什么要配一个 e2e 兄弟判据）：
   *  · jsdom 没有布局 —— 空壳与有内容的壳在 `textContent` 判据下长得一模一样，所以这里只能判
   *    **DOM 形状**（壳的数量、每个壳有没有子节点）；
   *  · e2e 那个实例永远是 `running:false`，诊断那一组本来就有话，只有「准备环境」那一组是空的
   *    ⇒ "空壳真的占 17px 高并画出线"由 `tests/e2e/notebook-page.spec.ts` 量真实高度钉住。
   *
   * 两态各数一次，是为了让"2"不是被写死的巧合：有话说的那一组必须**出现**，没话说的那一组必须
   * **不存在**（只判"没有空壳"的话，把壳全删掉也能绿）。
   */
  it('状态卡里不许出现空的分组壳：分隔线后面必须真有一句话（真浏览器实测发现的缺陷）', async () => {
    status.mockResolvedValue(up);
    files.mockResolvedValue({ files: ['01-a.ipynb'] });
    const first = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    const openGroups = [...document.querySelectorAll('.nb-group')];
    expect(
      openGroups.length,
      '在跑且一切正常时多出来的分组壳 ⇒ 页面上是空白带 + 分隔线（诊断组与准备环境组此刻都没有话说）',
    ).toBe(2);
    for (const g of openGroups) expect(g.childElementCount, '空的 .nb-group 还挂在 DOM 上').toBeGreaterThan(0);
    first.unmount();

    // 换一态：这一态诊断组有话要说（那句"做题不受影响"），它必须出现 —— 于是总共三组
    status.mockResolvedValue({ running: false, reason: '这个实例没有被给予 ARENA_JUPYTER_TOKEN …', kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-down')).toBeTruthy());
    const downGroups = [...document.querySelectorAll('.nb-group')];
    expect(
      downGroups.length,
      '诊断那一组此刻有内容，壳必须存在（把它一起删掉=把"没在跑"那句话说没了）；而「准备环境」那一组仍然没有话，不许出现',
    ).toBe(3);
    for (const g of downGroups) expect(g.childElementCount, '空的 .nb-group 还挂在 DOM 上').toBeGreaterThan(0);
  });

  /**
   * 后端只在"这个连接是本机"时往链接里放 token（判据是 socket 对端，见 Task 8）。
   * 于是非本机连接的形状是：**有链接、没有 token** —— 点开会在 Jupyter 的登录页停一下。
   * 界面不许把这口气咽掉：不说的话，读者只会以为"这个服务坏了"，而事实是他不是本机。
   */
  it('链接里没有 token ⇒ 当场说破"要贴一次 token"，并说明这不是故障', async () => {
    status.mockResolvedValue({ ...up, url: TREE });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    const hint = screen.getByTestId('notebook-tokenless');
    expect(hint.textContent).toContain('token');
    expect(hint.textContent).toContain('不是 Jupyter 坏了');
  });

  /** 对照的那一态单独一个 it：同一次 render 里换 mock 值换不掉已经挂上去的那句话。 */
  it('链接里带 token（本机连接）⇒ 那句"要贴 token"不许出现', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.queryByTestId('notebook-tokenless'), '两句话同时出现 ⇒ 读者分不清自己是不是本机').toBeNull();
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
   * 最后一条钉的是"逃生链接照旧是后端给的那个带 token 的绝对地址" —— 内嵌与跳出不共用一条 URL，
   * 谁也不许替谁说话。
   */
  it('running:true 时页面渲染同源 iframe，默认落在"文件管理"，src 是 `/jupyter/` 且**不含 token**', async () => {
    status.mockResolvedValue({ ...up, url: `http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}?token=x`, kernels: [], notebooks: [] });
    files.mockResolvedValue({ files: ['01-skew.ipynb'] });
    render(<Notebook />);
    const frame = await screen.findByTestId('notebook-frame');
    expect(frame.getAttribute('src')).toBe(JUPYTER_BASE_URL);
    expect(frame.getAttribute('src'), '凭据不进页面（这一条是整个 WI-94 的目的）').not.toContain('token');
    expect(frame.getAttribute('src'), '绝对地址 ⇒ localhost / 127.0.0.1 两种打开方式之一必跨源').not.toMatch(/^https?:/);
    expect(screen.getByTestId('notebook-open').getAttribute('href')).toBe(`http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}?token=x`);
  });

  /**
   * 「换一次状态再看 DOM」这一档的单元层版本：只看首屏等于没测。
   * `toBe(frame)` 那条是**节点身份**判据：给 iframe 挂 `key={selected}` 或用两个不同的 iframe 分支
   * 都会让它红 —— 而那两种写法的症状不是报错，是"每点一次左栏就把 Jupyter 页面重启一遍"。
   */
  it('左栏点一份笔记 ⇒ iframe 的 src 换过去（换一次状态再看 DOM，不看首屏就算白测）', async () => {
    status.mockResolvedValue({ ...up, url: `http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}`, kernels: [], notebooks: [] });
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
  });

  /**
   * 第三种形状：**还没读到**。brief 原稿那段代码是 `(listing?.files ?? []).length === 0` 就报"没有"，
   * 于是首屏一定会闪一句"目录里现在没有笔记"——而这一次读还没回来。这一页对同一个纪律已经有先例
   * （`notebook-files-empty` 判的是 `data &&` 读过之后），所以这里补一条把它钉住：
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

  /**
   * 「在跑但链接给不出来」（nolink）这一态同样不许出现 iframe：iframe 要的是**路径**，
   * 而这一态坏掉的正是"拼不出可点开的地址"那半 —— 但同源前缀其实还在，所以这不是理所当然的，
   * 它是 `view.kind === 'open'` 这一个门。用例只钉一件事：nolink 时没有 iframe。
   */
  it('在跑但 publicUrl 配坏时也不许出现 iframe（那一态的门与"没在跑"共用一个 kind）', async () => {
    status.mockResolvedValue({
      running: true,
      reason: 'Jupyter 在跑，但 ARENA_NOTEBOOK_PUBLIC_URL="not a url" 不是合法 URL',
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-nolink')).toBeTruthy());
    expect(screen.queryByTestId('notebook-frame')).toBeNull();
  });

  /**
   * 删掉的只有徽章那一排。`blocked`（venv 没建 ⇒ 「准备环境」修得了）与 `missingSpec`
   * （表里没有 arena-pyspark ⇒ 镜像级注册，得 `--rebuild`）是两件不同的事，
   * 删错任何一个就是删掉一条真实的诊断路径。
   */
  it('内核徽章那一排没了，但「准备环境」与「spec 没注册」两条还在（前者修 venv，后者修镜像）', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: false, reason: '解释器不存在：/opt/arena-ide-env/python/bin/python' }],
      notebooks: [],
    });
    const first = render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    expect(screen.queryByTestId('notebook-kernels')).toBeNull();
    first.unmount();

    status.mockResolvedValue({ running: true, url: TREE, kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-spec-missing')).toBeTruthy());
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
   * 边界卡折成 `<details>`（用户批的第 4 件：措辞一字不动，只是收成一行）。
   * 这里判两件事：折叠结构真的存在（有人顺手把 `<details>` 拆回常开会红），
   * 而**默认是折着的**（默认展开就等于没折叠）。DOM 上五段话还在 —— jsdom 里折叠不影响
   * `textContent`，所以上面那组 `boundarySentences` 用例照旧全过；"看不见"那一半归 e2e，
   * 由 `tests/e2e/notebook-page.spec.ts` 里"先展开再断可见"那条钉。
   */
  it('边界卡是折起来的 `<details>`，但五段话逐字仍在 DOM 上', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-boundary')).toBeTruthy());
    const details = screen.getByTestId('notebook-boundary').querySelector('details');
    expect(details, '边界卡不是 <details> ⇒ 用户批的"压成一行/折叠"这件没做').not.toBeNull();
    expect(details!.hasAttribute('open'), '默认展开 ⇒ 折叠这一态根本没生效').toBe(false);
    expect(screen.getByTestId('notebook-boundary').querySelectorAll('p')).toHaveLength(5);
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
      // I-4 之后后端只会列 arena 自己那几条 kernel ⇒ 这一态的夹具必须是 arena-pyspark
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: false, reason: '解释器不存在：/opt/arena-ide-env/python/bin/python' }],
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    expect(screen.getByTestId('notebook-page').textContent).toContain('解释器不存在');
  });

  /**
   * 评审第二条裁定：第三个响应形状（在跑，但链接拼不出来）必须是独立一态。
   * 判三件事：不渲染"点开它"、不渲染"没在运行"、把 env 那一行的名字显示出来。
   */
  it('在跑但 publicUrl 配坏：既不说"点开它"，也不说"没在运行"', async () => {
    status.mockResolvedValue({
      running: true,
      reason: 'Jupyter 在跑，但 ARENA_NOTEBOOK_PUBLIC_URL="not a url" 不是合法 URL ⇒ 给不出能点开的链接。这是那一行 env 坏了，不是 Jupyter 的故障',
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-nolink')).toBeTruthy());
    expect(screen.queryByTestId('notebook-open'), '链接根本不存在 ⇒ 给一个就是死链').toBeNull();
    const text = screen.getByTestId('notebook-page').textContent ?? '';
    expect(text).not.toContain('没在运行');
    expect(screen.getByTestId('notebook-status').textContent).toContain('地址给不出来');
    expect(text, '坏的是哪一行 env 必须点名，否则读者只会去重启一个正在好好干的服务').toContain('ARENA_NOTEBOOK_PUBLIC_URL');
    // 评审 Fix-1 的 Minor：这一态是"配置坏了"的诊断，不是"某个操作失败了"。
    // `role="alert"` 会让屏幕阅读器**打断**当前朗读来播报它 —— 邻块（down / tokenless / spec-missing）
    // 说的是同一类事，用的是同一档语气，不该只有这一块被升级成报警。
    expect(screen.getByTestId('notebook-nolink').getAttribute('role')).toBe('status');
  });

  /**
   * 「准备环境」不能是个摆设：点下去要真的打那个 POST（venv 只在显式动作里建），
   * 而且建完要重新读一次状态 —— 否则按钮按完界面还停在"没就绪"，用户以为没生效。
   */
  it('点「准备环境」= 一次显式 POST + 一次状态重读', async () => {
    status.mockResolvedValue({
      running: true,
      url: TREE,
      // I-4 之后后端只会列 arena 自己那几条 kernel ⇒ 这一态的夹具必须是 arena-pyspark
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: false, reason: '解释器不存在：/opt/arena-ide-env/python/bin/python' }],
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
      // I-4 之后后端只会列 arena 自己那几条 kernel ⇒ 这一态的夹具必须是 arena-pyspark
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: false, reason: '解释器不存在：/opt/arena-ide-env/python/bin/python' }],
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
      // I-4 之后后端只会列 arena 自己那几条 kernel ⇒ 这一态的夹具必须是 arena-pyspark
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: false, reason: '解释器不存在：/opt/arena-ide-env/python/bin/python' }],
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
   * 也不许抢走运行时那一块（状态卡此刻仍然照说"运行中"）。
   */
  it('示例铺不进去：单独说一句原因，且不许说成"没有示例"', async () => {
    status.mockResolvedValue({
      running: true,
      url: `${TREE}?token=x`,
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
      notebooks: [],
      seedError: '示例没能铺进工作目录（这一条与 Jupyter 在不在跑无关）：EEXIST: file already exists, mkdir',
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-seed-error')).toBeTruthy());
    const line = screen.getByTestId('notebook-seed-error');
    expect(line.textContent).toContain('EEXIST');
    // role 必须是 status：它是"某一半没做成"，不是"整个服务不可用"（alert 会把朗读打断成故障）
    expect(line.getAttribute('role')).toBe('status');
    // 两种"空"不许同时出现，否则读者分不清是没有还是铺失败
    expect(screen.queryByTestId('notebook-files-empty')).toBeNull();
    // 运行时那一半不许被带跑：seed 坏了 Jupyter 照样在跑
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
  });

  /** 对照的那一态：真的一个示例都没有（源目录是空的）⇒ 只许说"没有"，不许凭空报一个铺失败的错。 */
  it('没有示例 ≠ 铺不进去：没有 seedError 时只说"没有"，不渲染那句诊断', async () => {
    status.mockResolvedValue({
      running: true,
      url: `${TREE}?token=x`,
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-files-empty')).toBeTruthy());
    expect(screen.queryByTestId('notebook-seed-error'), '没有失败却报一句失败 = 最响的假警报').toBeNull();
  });

  /**
   * 每一句一条都不能省（Step 4；`db08cf8` 之后清单从 3 句长到 7 句，用例名里的"三句"就是这么留下的假话），
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
    '判题用的是另一套解释器',
    '这是默认，不是这道页面上的强制',
    '装进的就是判题那套解释器',
    '那是判题池之外的第二个 Spark JVM',
    'notebook 里能读到题库的参考答案',
    '这不是安全边界',
    '只在浏览器本机打开：地址是 127.0.0.1，手机 / iPad 访问不了',
  ];
  const boundaryCases: Array<[string, unknown]> = [
    ['在跑', up],
    ['没在跑', { running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] }],
    ['在跑但没链接', { running: true, reason: 'ARENA_NOTEBOOK_PUBLIC_URL 不是合法 URL', kernels: [], notebooks: [] }],
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
   */
  it('kernel 表里没有 arena-pyspark：说清"准备环境修不了它"，并且不给那个按钮', async () => {
    status.mockResolvedValue({ running: true, url: TREE, kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-spec-missing')).toBeTruthy());
    expect(screen.getByTestId('notebook-spec-missing').textContent).toContain('./start.sh --rebuild');
    expect(screen.queryByTestId('notebook-prepare'), '建 venv 不会多出那个 spec ⇒ 给按钮就是让人白点').toBeNull();
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
  /**
   * 不用 `new URL('../src/App.tsx', import.meta.url)`：jsdom 下那个 url 没有 file: 协议，
   * readFileSync 直接 "The URL must be of scheme file"。而两种跑法（仓库根 `npx vitest run web/test`
   * 与 `npm test -w @arena/web`）的 cwd 差一层，所以按候选根找，找不到就把原因说出来。
   */
  const repoFile = (rel: string): string => {
    for (const base of [process.cwd(), join(process.cwd(), '..')]) {
      const candidate = join(base, rel);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`找不到 ${rel}（cwd=${process.cwd()}）⇒ 这条形状判据没在读你要改的那份源码`);
  };
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
