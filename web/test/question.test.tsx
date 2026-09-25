// @vitest-environment jsdom
import './dom-shim';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  results: [] as unknown[],
  gate: null as Promise<void> | null,
  gate2: null as Promise<void> | null,
  progress: null as unknown,
  judgeCalls: 0,
  gradeCalls: 0,
  hideCalls: [] as string[],
  submissions: [] as { questionId: string; submission: string }[],
  history: [] as unknown[],
  attemptHistoryCalls: 0,
}));

vi.mock('../src/api', async () => {
  const fix = await import('./fixtures');
  return {
    api: {
      question: async (id: string) => ({
        question: id === fix.SUBJECTIVE_QUESTION.id ? fix.SUBJECTIVE_QUESTION : fix.CODE_QUESTION,
      }),
      judgeStream: async (req: { questionId: string; submission: string }, onEvent: (e: unknown) => void) => {
        state.judgeCalls += 1;
        state.submissions.push({ questionId: req.questionId, submission: req.submission });
        if (state.gate) await state.gate;
        for (const e of state.events) onEvent(e);
        if (state.gate2) await state.gate2;
        return state.results.shift() ?? null;
      },
      grade: async () => {
        state.gradeCalls += 1;
        if (state.gate) await state.gate;
        return fix.GRADE_RESPONSE;
      },
      hide: async (id: string) => {
        state.hideCalls.push(id);
        return fix.hideResponse(id);
      },
      progress: async () =>
        state.progress ?? fix.progressResponse({ today: { planned: [], answered: [], passed: [], done: false } }),
      attempts: async (id: string) => {
        state.attemptHistoryCalls += 1;
        return { questionId: id, attempts: state.history };
      },
    },
  };
});

import QuestionPage from '../src/pages/Question';
import JudgeResultPanel from '../src/components/JudgeResultPanel';
import RunningPanel from '../src/components/RunningPanel';
import type { JudgeEvent, JudgeResult } from '@arena/shared';
import {
  CODE_QUESTION,
  JUDGE_ERROR,
  JUDGE_FAIL,
  JUDGE_PASS,
  JUDGE_STREAM_EVENTS,
  SUBJECTIVE_QUESTION,
  progressResponse,
} from './fixtures';
function setRun(events: JudgeEvent[], results: JudgeResult[]) {
  state.events = events;
  state.results = results;
}

async function open(id: string = CODE_QUESTION.id): Promise<void> {
  const ui = render(<QuestionPage id={id} />);
  await ui.findByTestId('question-header');
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /运行用例/ }));
}

beforeEach(() => {
  cleanup();
  window.location.hash = '/';
  localStorage.clear();
  state.events = [];
  state.results = [];
  state.gate = null;
  state.gate2 = null;
  state.progress = null;
  state.judgeCalls = 0;
  state.gradeCalls = 0;
  state.hideCalls = [];
  state.submissions = [];
  state.history = [];
  state.attemptHistoryCalls = 0;
});

describe('答题页 · 结果导向用例', () => {
  it('提交前就完整展示用例的输入与期望', async () => {
    await open();
    const table = screen.getByTestId('case-table');
    for (const c of CODE_QUESTION.cases!) expect(within(table).getByText(c.name)).toBeTruthy();
    expect(within(table).getByText('[[0,1]]')).toBeTruthy();
    expect(within(table).getByText(/\[3,3,5,-1\]/)).toBeTruthy();
    expect(state.judgeCalls).toBe(0);
    expect(document.querySelector('.cm-content')).toBeTruthy();
  });

  it('点下去就进入运行态，不必等判题回来（再按 SSE 展示阶段/耗时/日志）', async () => {
    setRun(JUDGE_STREAM_EVENTS.slice(0, 3), [JUDGE_FAIL]);
    let release1!: () => void;
    let release2!: () => void;
    state.gate = new Promise<void>((r) => {
      release1 = r;
    });
    state.gate2 = new Promise<void>((r) => {
      release2 = r;
    });
    await open();

    // 判题流被 gate 卡住、一个事件都还没回来，此时就能拿到运行态卡片 —— 这才是"不等判题"的证据。
    // 原来这里量的是 100ms 墙钟：它测的是机器负载不是应用行为，判题矩阵并行跑时会漂到 115ms 假红。
    submit();
    const running = screen.getByTestId('judge-running');
    expect(running.textContent).toContain('判题中');
    expect(screen.queryByTestId('judge-result')).toBeNull();

    await act(async () => release1());
    expect(within(running).getByText('编译中')).toBeTruthy();
    expect(within(running).getByText('已用 3.2s / 上限 20s')).toBeTruthy();
    expect(within(running).getByText('[junit] running PairsTest')).toBeTruthy();
    expect(screen.queryByTestId('judge-result')).toBeNull();

    await act(async () => release2());
    const result = await screen.findByTestId('judge-result');
    expect(within(result).getByText('通过 1 / 失败 2')).toBeTruthy();
    expect(within(result).getByText('耗时 4.2s')).toBeTruthy();
  });

  it('运行态文案覆盖 compile / run / collect 三个阶段', () => {
    const a = render(<RunningPanel phase="run" elapsedMs={1200} timeoutMs={20000} logs={[]} />);
    expect(a.getByText('运行中')).toBeTruthy();
    expect(a.getByText('已用 1.2s / 上限 20s')).toBeTruthy();
    a.unmount();
    const b = render(<RunningPanel phase="collect" elapsedMs={18400} timeoutMs={20000} logs={['a', 'b']} />);
    expect(b.getByText('收集中结果')).toBeTruthy();
    expect(b.getByText('已用 18.4s / 上限 20s')).toBeTruthy();
  });

  it('部分失败时显示"通过 1 / 失败 2"，两个失败用例名可见', async () => {
    setRun([], [JUDGE_FAIL]);
    await open();
    submit();
    const result = await screen.findByTestId('judge-result');
    expect(within(result).getByText('通过 1 / 失败 2')).toBeTruthy();
    expect(within(result).getByText('空输入返回 0')).toBeTruthy();
    expect(within(result).getByText('包含重复元素')).toBeTruthy();
    expect(within(result).getByText('有唯一解')).toBeTruthy();
  });

  it('最终结果覆盖 SSE 那一版时，不许把用户已展开的用例收起来', () => {
    // 真实链路会 setResult 两次：SSE 推一版、最终结果再覆盖一版（引用变了，用例还是那批）。
    // 面板原先用 useEffect 在引用变化时 setOpen({})，于是"刚点开就被弹回去"——
    // 判题越快、两条更新挨得越近，用户越容易撞上（负载下才复现，所以它躲过了单跑）。
    const { rerender } = render(<JudgeResultPanel result={JUDGE_FAIL} />);
    const panel = screen.getByTestId('judge-result');
    fireEvent.click(within(panel).getByTestId('expand-case-0'));
    expect(within(panel).getByTestId('case-detail-0')).toBeTruthy();

    rerender(<JudgeResultPanel result={{ ...JUDGE_FAIL }} />);
    expect(
      within(panel).queryByTestId('case-detail-0'),
      '新一轮结果一到就把用户展开的行收起了：展开状态不该绑在 result 引用上',
    ).toBeTruthy();
  });

  it('换了一批用例（名字不同）时，旧的展开状态不许套到新的行上', () => {
    const { rerender } = render(<JudgeResultPanel result={JUDGE_FAIL} />);
    const panel = screen.getByTestId('judge-result');
    fireEvent.click(within(panel).getByTestId('expand-case-0'));

    const other: JudgeResult = {
      ...JUDGE_FAIL,
      failedCases: [{ name: '另一个用例', passed: false, expected: 'x', actual: 'y' }],
    };
    rerender(<JudgeResultPanel result={other} />);
    expect(within(panel).queryByTestId('case-detail-0')).toBeNull();
  });

  it('失败用例可展开看期望 vs 实际', async () => {
    setRun([], [JUDGE_FAIL]);
    await open();
    submit();
    const result = await screen.findByTestId('judge-result');
    expect(within(result).queryByText('null')).toBeNull();
    fireEvent.click(within(result).getByTestId('expand-case-0'));
    const detail = within(result).getByTestId('case-detail-0');
    expect(within(detail).getByText('期望')).toBeTruthy();
    expect(within(detail).getByText('实际')).toBeTruthy();
    expect(within(detail).getByText('null')).toBeTruthy();
  });

  it('status=error 明确区分"运行失败"与答案错，并展示截断日志', async () => {
    setRun([], [JUDGE_ERROR]);
    await open();
    submit();
    const result = await screen.findByTestId('judge-result');
    const banner = within(result).getByTestId('run-error-banner');
    expect(banner.textContent).toContain('运行失败');
    expect(banner.textContent).toContain('不是答案错误');
    expect(within(result).getByText(/cannot find symbol/)).toBeTruthy();
    expect(within(result).queryByText('通过 0 / 失败 0')).toBeNull();
  });

  it('保留历史最佳：本次失败不清除"历史最佳：通过"', async () => {
    setRun([], [JUDGE_PASS, JUDGE_FAIL]);
    await open();
    submit();
    await screen.findByTestId('judge-result');
    expect(screen.getByTestId('best-badge').textContent).toContain('历史最佳：通过');

    submit();
    const result = await screen.findByTestId('judge-result');
    await waitFor(() => expect(within(result).getByText('通过 1 / 失败 2')).toBeTruthy());
    expect(screen.getByTestId('best-badge').textContent).toContain('历史最佳：通过');
    expect(localStorage.getItem('arena:best:alg-java-0001')).toBe('pass');
  });

  it('服务端已记录该题通过时，一进来就显示历史最佳', async () => {
    state.progress = progressResponse({
      today: { planned: [CODE_QUESTION.id], answered: [CODE_QUESTION.id], passed: [CODE_QUESTION.id], done: false },
    });
    setRun([], [JUDGE_FAIL]);
    await open();
    expect(screen.getByTestId('best-badge').textContent).toContain('历史最佳：通过');
    submit();
    const result = await screen.findByTestId('judge-result');
    expect(within(result).getByText('通过 1 / 失败 2')).toBeTruthy();
    expect(screen.getByTestId('best-badge')).toBeTruthy();
  });

  it('Ctrl/Cmd+Enter 直接提交当前代码', async () => {
    setRun([], [JUDGE_FAIL]);
    await open();
    fireEvent.keyDown(document.querySelector('.cm-content')!, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(state.judgeCalls).toBe(1));
    expect(state.submissions[0]!.questionId).toBe(CODE_QUESTION.id);
  });

  it('恢复上次草稿到编辑器', async () => {
    localStorage.setItem('arena:draft:alg-java-0001', 'class Draft {\n  int x = 1;\n}');
    await open();
    await waitFor(() => expect(document.querySelector('.cm-content')!.textContent).toContain('class Draft'));
  });

  it('移除这题调用软删除接口并跳回今日页', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /移除这题/ }));
    await waitFor(() => expect(state.hideCalls).toEqual([CODE_QUESTION.id]));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });
});

describe('答题页 · 主观题', () => {
  it('用 textarea 作答，评分后给出分数、bonus/gaps 与逐项 rubric 表', async () => {
    const ui = render(<QuestionPage id={SUBJECTIVE_QUESTION.id} />);
    await ui.findByTestId('answer-textarea');
    expect(screen.queryByTestId('case-table')).toBeNull();
    fireEvent.change(screen.getByTestId('answer-textarea'), { target: { value: '用 outbox + 幂等重放' } });
    fireEvent.click(screen.getByRole('button', { name: /评分/ }));
    const panel = await screen.findByTestId('rubric-panel');
    expect(within(panel).getByText('7/10')).toBeTruthy();
    expect(within(panel).getByText('给出了 outbox + 幂等重放的组合方案')).toBeTruthy();
    expect(within(panel).getByText('没有给出跨区延迟预算')).toBeTruthy();
    const table = within(panel).getByTestId('rubric-table');
    expect(within(table).getByText('一致性模型选择')).toBeTruthy();
    expect(within(table).getAllByText('命中')).toHaveLength(2);
    expect(within(table).getByText('未命中')).toBeTruthy();
    expect(within(table).getByText('3/3')).toBeTruthy();
    expect(within(table).getByText('4/4')).toBeTruthy();
    expect(within(table).getByText('0/3')).toBeTruthy();
    expect(within(table).getByText(/每小时对账/)).toBeTruthy();
    expect(within(panel).getByText(/qodercli/)).toBeTruthy();
    expect(within(panel).getByText('耗时 3.4s')).toBeTruthy();
    // 评分出问题时要能顺着 trace 号去捞日志
    expect(within(panel).getByTestId('grade-trace').textContent).toContain('grade-trace-fixture');
    expect(state.gradeCalls).toBe(1);
  });

  it('作答前只给考点标签，不泄漏权重', async () => {
    const ui = render(<QuestionPage id={SUBJECTIVE_QUESTION.id} />);
    await ui.findByTestId('answer-textarea');
    expect(screen.getAllByText('可观测性与对账')).toHaveLength(1);
    expect(screen.queryByText('0/3')).toBeNull();
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    expect(screen.getByText(/答完才公开/)).toBeTruthy();
  });

  it('评分进行中也有运行态反馈，避免看起来卡死', async () => {
    let release!: () => void;
    state.gate = new Promise<void>((r) => {
      release = r;
    });
    const ui = render(<QuestionPage id={SUBJECTIVE_QUESTION.id} />);
    await ui.findByTestId('answer-textarea');
    fireEvent.click(screen.getByRole('button', { name: /评分/ }));
    expect(screen.getByTestId('grade-running').textContent).toContain('评分中');
    await act(async () => release());
    await screen.findByTestId('rubric-panel');
  });
});

describe('答题页 · 提交历史（N-05 判题历史回看）', () => {
  it('进页面就能看到历史卡片，一行说清那天挂在哪个用例', async () => {
    state.history = [
      {
        id: 7,
        questionId: CODE_QUESTION.id,
        kind: 'judge',
        status: 'fail',
        score: null,
        maxScore: null,
        xp: 2,
        passed: 1,
        failed: 2,
        durationMs: 4200,
        createdAt: '2026-09-18T09:12:00.000Z',
        day: '2026-09-18',
        detail: {
          v: 1,
          kind: 'judge',
          failedCases: [{ name: '窗口边界不吞事件', passed: false, expected: '1', actual: '2' }],
          submission: 'class Old { int f() { return 2; } }',
        },
      },
    ];
    await open();
    const rows = await screen.findAllByTestId('attempt-row');
    expect(rows[0]?.textContent).toContain('2026-09-18');
    expect(rows[0]?.textContent).toContain('窗口边界不吞事件');
    fireEvent.click(rows[0]!.querySelector('[data-testid="expand-attempt"]')!);
    expect((await screen.findByTestId('attempt-detail')).textContent).toContain('class Old');
  });

  it('提交一次之后历史自动重取，不用刷新页面', async () => {
    await open();
    const before = state.attemptHistoryCalls;
    setRun(JUDGE_STREAM_EVENTS, [JUDGE_PASS]);
    submit();
    await screen.findByTestId('judge-result');
    await waitFor(() => expect(state.attemptHistoryCalls).toBeGreaterThan(before));
  });
});
