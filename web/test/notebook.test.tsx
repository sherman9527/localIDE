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
 * 三句话（共用环境 / 答案可读不是安全边界 / 只在本机打得开）在任何一态都常驻。
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const up = {
  running: true,
  url: 'http://127.0.0.1:7789/tree?token=x',
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
    expect(screen.getByTestId('notebook-open').getAttribute('href')).toBe('http://127.0.0.1:7789/tree?token=x');
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
    status.mockResolvedValue({ ...up, url: 'http://127.0.0.1:7789/tree' });
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
      url: 'http://127.0.0.1:7789/tree',
      kernels: [{ id: 'python3', label: 'Python 3', ready: false, reason: '解释器不存在' }],
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
  });

  /**
   * 「准备环境」不能是个摆设：点下去要真的打那个 POST（venv 只在显式动作里建），
   * 而且建完要重新读一次状态 —— 否则按钮按完界面还停在"没就绪"，用户以为没生效。
   */
  it('点「准备环境」= 一次显式 POST + 一次状态重读', async () => {
    status.mockResolvedValue({
      running: true,
      url: 'http://127.0.0.1:7789/tree',
      kernels: [{ id: 'python3', label: 'Python 3', ready: false, reason: '解释器不存在' }],
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
      url: 'http://127.0.0.1:7789/tree',
      kernels: [{ id: 'python3', label: 'Python 3', ready: false, reason: '解释器不存在' }],
      notebooks: [],
    });
    prepare.mockResolvedValue({ ok: false, reason: 'venv 创建超时' });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
    fireEvent.click(screen.getByTestId('notebook-prepare'));
    await waitFor(() => expect(screen.getByTestId('notebook-prepare-result').textContent).toContain('venv 创建超时'));
  });

  /**
   * 三句话一条都不能省（Step 4），而且**换一态再看**：
   * 只在"在跑"那态显示，等于在用户最该看见的时候（他要开始装包 / 开 notebook 了）把它收走。
   */
  it('三句边界话在每一态都常驻', async () => {
    const sentences = [
      '这些包与 IDE 共用同一份环境，判题器看不到',
      'notebook 里能读到题库的参考答案',
      '这不是安全边界',
      '只在浏览器本机打开：地址是 127.0.0.1，手机 / iPad 访问不了',
    ];
    const cases: Array<[string, unknown]> = [
      ['在跑', up],
      ['没在跑', { running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] }],
      [
        '在跑但没链接',
        { running: true, reason: 'ARENA_NOTEBOOK_PUBLIC_URL 不是合法 URL', kernels: [], notebooks: [] },
      ],
    ];
    for (const [label, value] of cases) {
      status.mockResolvedValue(value);
      render(<Notebook />);
      await waitFor(() => expect(screen.getByTestId('notebook-page')).toBeTruthy());
      const text = screen.getByTestId('notebook-page').textContent ?? '';
      for (const s of sentences) {
        expect(text, `${label} 这一态少了那句：${s}`).toContain(s);
      }
      cleanup();
      vi.clearAllMocks();
    }
  });

  /**
   * 「kernel 表里没有 arena-pyspark」与「kernel 没就绪」是两种坏法，修的是不同东西：
   * 前者是镜像级的 kernelspec 注册（要 `./start.sh --rebuild`），后者缺的是 IDE 那份 venv（按钮修得了）。
   * 混在一起的症状是用户对着「准备环境」点了半天，而缺的那一层根本不在 venv 里 —— 界面必须说破区别。
   */
  it('kernel 表里没有 arena-pyspark：说清"准备环境修不了它"，并且不给那个按钮', async () => {
    status.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7789/tree', kernels: [], notebooks: [] });
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

  it('状态读不到（服务没起 / 500）时不白屏，且仍说得出那三句', async () => {
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
 * 为什么要在测试里读源码，而不是交给 `scripts/check-bundle.mjs`：那把尺子只比体积。
 * 实测（Task 9 的破坏性验证）：把 `lazy` 换成静态 import 之后 `check-bundle.mjs` **照样绿** ——
 * 首屏从 76.2KB 涨到 78.3KB gzip（预算 84KB），1 JS + 1 CSS 的形状没变，Notebook 那片 2.6KB 只是
 * 从"按需加载"列表里消失，页面与产物检查都说不出"它被拖回首屏了"。所以"不许进首屏"这条判据
 * 只能写在源码形状上（与 Task 8 那条路由判据同一类：看结构，不看包含）。
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
