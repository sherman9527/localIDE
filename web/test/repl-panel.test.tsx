// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplFeedResponse, ReplSessionsResponse, ReplStartResponse } from '@arena/shared';

/**
 * IDE 的 REPL 面板（WI-77）。
 *
 * 这里最要紧的不是"能发消息"，而是**名额**：会话是一个活着的解释器进程，
 * 上限只有 2 个。漏关一次（换语言、关标签页）就少一个名额，全漏光之后
 * 面板会一直说"先关掉一个"而界面上没有任何可关的东西 —— 所以卸载与 pagehide
 * 都必须真的通知后端，而且被拒时必须给一个出口。
 */

const start = vi.fn();
const feed = vi.fn();
const stop = vi.fn();
const sessions = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    ideReplStart: (body: { language: string }) => start(body),
    ideReplFeed: (body: { sessionId: string; line: string }) => feed(body),
    // opts 只在真传了的时候才转发：否则每个断言都要写一个 ", undefined"，
    // 而"普通关闭没带 keepalive"这件事本身不值得在每个用例里重复一遍
    ideReplStop: (body: { sessionId: string }, opts?: { keepalive?: boolean }) =>
      opts ? stop(body, opts) : stop(body),
    ideReplSessions: () => sessions(),
  },
}));

const started = (id: string): ReplStartResponse => ({
  session: { id, language: 'python', label: 'Python 3' },
  sessions: 1,
  maxSessions: 2,
});
const sessionList = (ids: string[]): ReplSessionsResponse => ({
  sessions: ids.map((id) => ({ id, language: 'python', busy: false, idleMs: 1000 })),
  maxSessions: 2,
  idleMs: 5 * 60_000,
});
const fed = (over: Partial<ReplFeedResponse> = {}): ReplFeedResponse => ({
  status: 'ok',
  output: '42',
  ...over,
});

async function openPanel() {
  const { default: ReplPanel } = await import('../src/components/ReplPanel');
  return render(<ReplPanel language="python" label="Python 3" />);
}

async function typeAndSend(text: string) {
  const input = await screen.findByTestId('ide-repl-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTestId('ide-repl-send'));
}

describe('REPL 面板', () => {
  beforeEach(() => {
    start.mockReset().mockResolvedValue(started('s1'));
    feed.mockReset().mockResolvedValue(fed());
    stop.mockReset().mockResolvedValue({ ok: true, sessions: 0 });
    sessions.mockReset().mockResolvedValue(sessionList([]));
  });

  afterEach(() => {
    cleanup();
  });

  it('第一句自动开会话，问与答都留在记录里', async () => {
    await openPanel();
    expect(start).not.toHaveBeenCalled();
    await typeAndSend('print(6 * 7)');

    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ language: 'python' });
    expect(feed).toHaveBeenCalledWith({ sessionId: 's1', line: 'print(6 * 7)' });

    const log = await screen.findByTestId('ide-repl-log');
    expect(log.textContent).toContain('print(6 * 7)');
    expect(log.textContent).toContain('42');
  });

  it('第二句不再重开会话（会话就是那个进程，重开等于把变量清空）', async () => {
    await openPanel();
    await typeAndSend('x = 41');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    await typeAndSend('print(x + 1)');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('会话没了（回收 / 超时）：这条之后下一句会重开一个新会话，而不是对着死进程打字', async () => {
    feed.mockResolvedValueOnce(fed({ status: 'gone', output: '没有这个会话' }));
    await openPanel();
    await typeAndSend('print(1)');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    const log = await screen.findByTestId('ide-repl-log');
    expect(log.textContent).toContain('没有这个会话');

    // 开会话时往名额条里"乐观记"的那一条必须被服务端的真相覆盖掉，
    // 否则界面一直显示"会话 1 / 2"，而那个进程其实早没了（名额其实已经空出来）
    await waitFor(() =>
      expect(screen.getByTestId('ide-repl-count').textContent!.replace(/\s+/g, ' ').trim()).toBe('会话 0 / 2'),
    );

    await typeAndSend('print(2)');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('等回显期间敲的下一句不许被抹掉（清草稿只能清"发出去的那一句"）', async () => {
    let release: ((value: ReplFeedResponse) => void) | undefined;
    feed.mockReturnValueOnce(new Promise<ReplFeedResponse>((resolve) => (release = resolve)));
    await openPanel();
    await typeAndSend('x = 1');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));

    // 第一句还没回来时就敲第二句：setDraft('') 无条件清空会把这句吞掉，
    // 于是输入框空了、按钮永远灰着（E2E 抓到过一次）
    const input = screen.getByTestId('ide-repl-input');
    fireEvent.change(input, { target: { value: 'print(x)' } });
    release?.(fed({ output: '1' }));
    await waitFor(() => expect(screen.getByTestId('ide-repl-send').hasAttribute('disabled')).toBe(false));
    expect((input as HTMLTextAreaElement).value).toBe('print(x)');
  });

  it('关会话的按钮真的通知后端，并把面板回到"未开会话"', async () => {
    await openPanel();
    await typeAndSend('x = 1');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '关会话' }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 's1' }));
    expect((await screen.findByTestId('ide-repl-note')).textContent).toContain('会话已关闭');
  });

  it('卸载必须关会话（换语言、离开页面都不许留孤儿解释器）', async () => {
    const view = await openPanel();
    await typeAndSend('x = 1');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));

    cleanup();
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 's1' }));
    expect(view.baseElement).toBeTruthy();
  });

  it('Enter 送句、Shift+Enter 只换行（python 的 def 块要能一次贴整块）', async () => {
    await openPanel();
    const input = await screen.findByTestId('ide-repl-input');
    fireEvent.change(input, { target: { value: 'def f():' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(feed).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    expect(feed).toHaveBeenCalledWith({ sessionId: 's1', line: 'def f():' });
  });

  it('开会话被拒（会话数已满）时，把原因显示出来而不是静默无反应', async () => {
    start.mockResolvedValue({
      session: null,
      message: '已有 2 个会话在跑（上限 2）。REPL 会话是常驻进程，先关掉一个再开。',
      sessions: 2,
      maxSessions: 2,
    } as ReplStartResponse);
    await openPanel();
    await typeAndSend('print(1)');
    const note = await screen.findByTestId('ide-repl-note');
    expect(note.textContent).toContain('已有 2 个会话在跑');
    expect(feed).not.toHaveBeenCalled();
  });

  it('直接关标签页（pagehide）也要通知后端，而且得是 keepalive', async () => {
    await openPanel();
    await typeAndSend('x = 1');
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    stop.mockClear();

    // 浏览器正在卸载页面：不带 keepalive 的请求会被直接丢掉，那个解释器就白占一个名额
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 's1' }, { keepalive: true }));
  });

  it('名额被残留占住时看得见（会话 2 / 2）并且能一键回收', async () => {
    sessions.mockResolvedValue(sessionList(['orphan-a', 'orphan-b']));
    await openPanel();

    const count = await screen.findByTestId('ide-repl-count');
    await waitFor(() =>
      expect(count.textContent!.replace(/\s+/g, ' ').trim()).toBe('会话 2 / 2'),
    );

    const reclaim = await screen.findByTestId('ide-repl-reclaim');
    sessions.mockResolvedValueOnce(sessionList([])); // 回收之后服务端就没会话了
    fireEvent.click(reclaim);

    await waitFor(() => expect(stop).toHaveBeenCalledWith({ sessionId: 'orphan-a' }));
    expect(stop).toHaveBeenCalledWith({ sessionId: 'orphan-b' });
    const note = await screen.findByTestId('ide-repl-note');
    expect(note.textContent).toContain('已回收 2 个会话');
    await waitFor(() => expect(screen.queryByTestId('ide-repl-reclaim')).toBeNull());
  });
});
