// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugStartResponse, DebugStepResponse } from '@arena/shared';

/**
 * IDE 的调试面板（WI-81）。
 *
 * 与 REPL 面板同一套命门：**会话是一个活着的子进程**，而且名额只有 1 个。
 * 所以卸载、关标签页、代码被改过都必须真的把它关掉 ——
 * 漏一次就是"下一次调试永远说名额已满"，而界面上没有任何可关的东西。
 *
 * 另一条这里特别验的：**代码改了之后行号就不对了**。停在第 5 行的会话，
 * 用户删掉两行再按"继续"，拿到的行号指的是另一句话 —— 那比报错更糟，是骗人。
 */

const start = vi.fn();
const step = vi.fn();
const stop = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    ideDebugStart: (body: { language: string }) => start(body),
    ideDebugStep: (body: { sessionId: string; action: string }) => step(body),
    ideDebugStop: (body: { sessionId: string }, opts?: { keepalive?: boolean }) =>
      opts ? stop(body, opts) : stop(body),
  },
}));

import DebugPanel from '../src/components/DebugPanel';

const CODE = 'x = 40\ny = x + 2\nprint(y)\n';

const stopped = (over: Partial<DebugStepResponse> = {}): DebugStartResponse => ({
  status: 'stopped',
  line: 2,
  reason: 'breakpoint',
  func: '<module>',
  locals: [{ name: 'x', type: 'int', repr: '40' }],
  session: { id: 'd1', language: 'python', label: 'Python 3' },
  sessions: 1,
  maxSessions: 1,
  ...over,
});
const stepped = (over: Partial<DebugStepResponse> = {}): DebugStepResponse => ({
  status: 'stopped',
  line: 3,
  reason: 'step',
  func: '<module>',
  locals: [{ name: 'y', type: 'int', repr: '42' }],
  action: 'next',
  sessions: 1,
  ...over,
});

interface PanelProps {
  language: string;
  label: string;
  code: string;
  breakpoints: number[];
  onStoppedLine: (line: number | null) => void;
}

function renderPanel(props: Partial<PanelProps> = {}) {
  return render(
    <DebugPanel
      language="python"
      label="Python 3"
      code={CODE}
      breakpoints={[2]}
      onStoppedLine={() => {}}
      {...props}
    />,
  );
}

describe('调试面板', () => {
  beforeEach(() => {
    start.mockReset().mockResolvedValue(stopped());
    step.mockReset().mockResolvedValue(stepped());
    stop.mockReset().mockResolvedValue({ ok: true, sessions: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it('开始调试把代码与断点一起交出去，并显示停在哪一行、变量是什么', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ language: 'python', code: CODE, breakpoints: [2] }),
    );

    await screen.findByTestId('ide-debug-where');
    expect(screen.getByTestId('ide-debug-where').textContent).toContain('第 2 行');
    expect(screen.getByTestId('ide-debug-locals').textContent).toContain('x');
    expect(screen.getByTestId('ide-debug-locals').textContent).toContain('40');
  });

  it('四种走法各发各的动作，行号跟着更新', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(step).not.toHaveBeenCalled());

    for (const [testId, action] of [
      ['ide-debug-continue', 'continue'],
      ['ide-debug-next', 'next'],
      ['ide-debug-stepIn', 'stepIn'],
      ['ide-debug-stepOut', 'stepOut'],
    ] as const) {
      step.mockResolvedValueOnce(stepped({ action, line: 7 }));
      fireEvent.click(screen.getByTestId(testId));
      await waitFor(() => expect(step).toHaveBeenCalledWith({ sessionId: 'd1', action }));
      await waitFor(() => expect(screen.getByTestId('ide-debug-where').textContent).toContain('第 7 行'));
    }
  });

  it('程序跑完：按钮收回"开始调试"，并说清会话已经不在了', async () => {
    step.mockResolvedValueOnce({
      status: 'exited',
      action: 'continue',
      sessions: 0,
      output: '42\n',
      message: '程序跑完了',
    } as DebugStepResponse);
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('ide-debug-continue'));

    await waitFor(() => expect(screen.getByTestId('ide-debug-where').textContent).toContain('跑完'));
    expect(screen.queryByTestId('ide-debug-next')).toBeNull();
    expect(screen.getByTestId('ide-debug-where').textContent).toContain('42');
  });

  it('起不来（名额被占 / 这门语言没有断点）：把原因显示出来，不是静默无反应', async () => {
    start.mockResolvedValueOnce({
      status: 'rejected',
      session: null,
      sessions: 1,
      maxSessions: 1,
      message: '已有 1 个调试会话在跑（上限 1）。先停掉一个再开。',
    } as DebugStartResponse);
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    const note = await screen.findByTestId('ide-debug-note');
    expect(note.textContent).toContain('上限 1');
    expect(step).not.toHaveBeenCalled();
  });

  it('手动停止：通知后端，并把"停在第 N 行"一起收掉（留着就是在说一件已经不成立的事）', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(screen.getByTestId('ide-debug-where').textContent).toContain('第 2 行'));

    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'd1' }));
    await waitFor(() => expect(screen.getByTestId('ide-debug-where').textContent).not.toContain('停在第 2 行'));
    expect(screen.getByTestId('ide-debug-note').textContent).toContain('已停止');
    expect(screen.queryByTestId('ide-debug-next')).toBeNull();
  });

  it('调试请求还在飞的时候切走：刚建好的会话要当场关掉，不许没人记账', async () => {
    // 卸载 cleanup 只能关"当时已知"的会话；这一刻 sessionRef 还是空的，
    // 于是回显里那个新会话会成为孤儿 —— 占死那唯一的名额，下一个页面永远开不起来。
    //（WI-80 修的是"关标签页"那条路，这是同一个故障的另一个入口）
    let release: (v: DebugStartResponse) => void = () => {};
    start.mockReturnValueOnce(new Promise<DebugStartResponse>((resolve) => { release = resolve; }));
    const view = renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(stop).not.toHaveBeenCalled();

    release(stopped());
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'd1' }));
  });

  it('卸载必须关会话（换语言、离开页面都不许留孤儿调试进程）', async () => {
    const view = renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'd1' }));
  });

  it('直接关标签页也要通知后端，而且得是 keepalive', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    stop.mockClear();

    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'd1' }, { keepalive: true }));
  });

  it('会话期间改了代码：立刻作废并说明"行号已经对不上"，不许拿旧停点继续', async () => {
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    rerender(
      <DebugPanel
        language="python"
        label="Python 3"
        code="x = 40\nprint(x)\n"
        breakpoints={[2]}
        onStoppedLine={() => {}}
      />,
    );
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'd1' }));
    const note = await screen.findByTestId('ide-debug-note');
    expect(note.textContent).toMatch(/行号|改了/);
    expect(step).not.toHaveBeenCalled();
  });

  it('没打断点也能按：那是"跑一遍"，但要说清会发生什么', async () => {
    start.mockResolvedValueOnce({
      status: 'exited',
      session: null,
      sessions: 0,
      maxSessions: 1,
      output: '42\n',
    } as DebugStartResponse);
    renderPanel({ breakpoints: [] });
    // 提示单独一个元素：按钮上只写"调试"（用户明确要求过按钮不许带尾巴）
    expect(screen.getByTestId('ide-debug-start').textContent).toBe('调试');
    expect(screen.getByTestId('ide-debug-hint').textContent).toContain('一路跑完');
    fireEvent.click(screen.getByTestId('ide-debug-start'));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ language: 'python', code: CODE, breakpoints: [] }));
    // 跑完之后 session 也是 null，但那不是"这门语言开不了调试"：不许凭空报一条错
    await waitFor(() => expect(screen.getByTestId('ide-debug-where').textContent).toContain('跑完了'));
    expect(screen.getByTestId('ide-debug-where').textContent).toContain('42');
    expect(screen.queryByTestId('ide-debug-note')).toBeNull();
  });
});
