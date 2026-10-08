// @vitest-environment jsdom
import './dom-shim';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
 */

const status = vi.fn();
const prepare = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    notebookStatus: () => status(),
    notebookPrepareEnv: () => prepare(),
  },
}));

import Notebook from '../src/pages/Notebook';
import { NOTEBOOK_TREE_PATH } from '@arena/shared';

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
  it('服务在跑：给可点开的地址 + kernel 徽章', async () => {
    status.mockResolvedValue(up);
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
    // 链接就是那个 url 本身，不由前端二次拼（端口写死在页面里 = 第二处真相）
    expect(screen.getByTestId('notebook-open').getAttribute('href')).toBe(`${TREE}?token=x`);
    expect(screen.getByTestId('notebook-page').textContent).toContain('PySpark (arena)');
    expect(screen.getByTestId('notebook-page').textContent).toContain('00-smoke-pyspark.ipynb');
    // 反向也要判：全都就绪时不许挂一个"准备环境"按钮（给了就是让人白点）
    expect(screen.queryByTestId('notebook-prepare')).toBeNull();
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
