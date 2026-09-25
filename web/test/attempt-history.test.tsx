// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptDetail, AttemptHistoryEntry } from '@arena/shared';

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  error: null as string | null,
  calls: [] as { questionId: string; limit?: number }[],
}));

vi.mock('../src/api', () => ({
  api: {
    attempts: async (questionId: string, opts: { limit?: number } = {}) => {
      state.calls.push({ questionId, limit: opts.limit });
      if (state.error) throw new Error(state.error);
      return { questionId, attempts: state.entries };
    },
  },
}));

import AttemptHistory from '../src/components/AttemptHistory';

const judgeEntry = (over: Partial<AttemptHistoryEntry> = {}, detail?: AttemptDetail | null): AttemptHistoryEntry => ({
  id: 1,
  questionId: 'alg-java-0001',
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
  detail:
    detail ?? {
      v: 1,
      kind: 'judge',
      failedCases: [{ name: '空输入返回空结果', passed: false, expected: '[]', actual: 'NullPointerException' }],
      passedCaseNames: ['重复事件只处理一次'],
      submission: 'class Solution { List<Integer> f(List<Integer> in) { return in; } }',
    },
  ...over,
});

/** 第 i 行（接口给什么顺序就什么顺序），行内 testid 不带下标，靠作用域取。 */
async function rowAt(i: number) {
  const rows = await screen.findAllByTestId('attempt-row');
  const row = rows[i];
  if (!row) throw new Error(`只有 ${rows.length} 行，取不到第 ${i} 行`);
  return row;
}

async function expandRow(i: number) {
  const row = await rowAt(i);
  fireEvent.click(within(row).getByTestId('expand-attempt'));
  return within(row);
}

beforeEach(() => {
  state.entries = [];
  state.error = null;
  state.calls = [];
});

afterEach(() => {
  cleanup();
});

describe('AttemptHistory — 判题历史回看（N-05）', () => {
  it('默认只给结论：哪天、过几个挂几个、挂在哪个用例名上', async () => {
    state.entries = [judgeEntry()];
    render(<AttemptHistory questionId="alg-java-0001" />);
    const row = await rowAt(0);
    expect(row.textContent).toContain('空输入返回空结果');
    expect(row.textContent).toContain('2026-09-18');
    expect(row.textContent).toContain('通过 1');
    // 期望/实际属于细节，默认不摊开
    expect(row.textContent).not.toContain('NullPointerException');
  });

  it('展开一条才看到期望 vs 实际和当时写的正文', async () => {
    state.entries = [judgeEntry()];
    render(<AttemptHistory questionId="alg-java-0001" />);
    const detail = await expandRow(0);
    await waitFor(() => expect(detail.getByTestId('attempt-detail').textContent).toContain('NullPointerException'));
    expect(detail.getByTestId('attempt-detail').textContent).toContain('class Solution');
    // 收起时那行"挂在「…」"摘要展开后要收掉，否则同一串用例名在屏上出现两遍
    expect(detail.queryByTestId('failed-summary')).toBeNull();
  });

  it('编译没过的那次不要写"这次没有失败用例"（自相矛盾）', async () => {
    state.entries = [judgeEntry({ status: 'error' }, { v: 1, kind: 'judge', failedCases: [], errorKind: 'compile', logs: 'Solution.java:2: error' })];
    render(<AttemptHistory questionId="alg-java-0001" />);
    const body = await expandRow(0);
    const text = body.getByTestId('attempt-detail').textContent ?? '';
    expect(text).toContain('编译没通过');
    expect(text).not.toContain('没有失败用例');
  });

  it('多条按接口给的顺序排（新的在前由服务端决定），各自可独立展开', async () => {
    state.entries = [
      judgeEntry({ id: 9, day: '2026-09-20', status: 'pass', passed: 3, failed: 0 }),
      judgeEntry({ id: 8, day: '2026-09-18' }),
    ];
    render(<AttemptHistory questionId="alg-java-0001" />);
    expect(await screen.findAllByTestId('attempt-row')).toHaveLength(2);
    expect((await rowAt(0)).textContent).toContain('2026-09-20');
    expect((await rowAt(1)).textContent).toContain('2026-09-18');
    const opened = await expandRow(0);
    expect(opened.getByTestId('attempt-detail')).toBeTruthy();
    // 另一行没被顺带展开：行内没有 detail
    expect(within(await rowAt(1)).queryByTestId('attempt-detail')).toBeNull();
  });

  it('v1 时代的老提交：明说"没有留档"，不拿空用例列表装成"全都过了"', async () => {
    state.entries = [judgeEntry({ detail: null })];
    render(<AttemptHistory questionId="alg-java-0001" />);
    const detail = await expandRow(0);
    expect(detail.getByTestId('attempt-detail').textContent).toContain('没有留档');
  });

  it('正文被裁剪过要说清楚，否则用户会以为自己写的是半截代码', async () => {
    const detail: AttemptDetail = { v: 1, kind: 'judge', failedCases: [], submission: 'class A{}', submissionChars: 48_000 };
    state.entries = [judgeEntry({ detail })];
    render(<AttemptHistory questionId="alg-java-0001" />);
    const body = await expandRow(0);
    expect(body.getByTestId('attempt-detail').textContent).toContain('48000');
  });

  it('主观题历史给评分点命中与不足项（复盘"下一步该补什么"）', async () => {
    state.entries = [
      judgeEntry(
        { id: 3, kind: 'grade', questionId: 'sd-rub-0001', status: 'pass', score: 6, maxScore: 10, passed: 1, failed: 1 },
        {
          v: 1,
          kind: 'grade',
          rubric: [
            { label: '指出背压与退避的取舍', hit: true, earned: 6 },
            { label: '给出可观测的失败处理', hit: false, earned: 0, nextStep: '补一句重放策略' },
          ],
          gaps: ['没讲重放幂等键'],
          submission: '我会用有界队列',
        },
      ),
    ];
    render(<AttemptHistory questionId="sd-rub-0001" />);
    const body = await expandRow(0);
    const text = body.getByTestId('attempt-detail').textContent ?? '';
    expect(text).toContain('给出可观测的失败处理');
    expect(text).toContain('补一句重放策略');
    expect(text).toContain('没讲重放幂等键');
  });

  it('没有历史就直说，并留一句"提交后这里会有内容"', async () => {
    render(<AttemptHistory questionId="alg-java-0001" />);
    expect(await screen.findByTestId('attempt-history-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('attempt-row')).toHaveLength(0);
  });

  it('拉历史失败不能带崩题目页（只在本卡片位置说明）', async () => {
    state.error = 'boom';
    render(<AttemptHistory questionId="alg-java-0001" />);
    const box = await screen.findByTestId('attempt-history-error');
    expect(box.textContent).toContain('boom');
  });

  it('每次提交后 bump 变化会重新拉取', async () => {
    const { rerender } = render(<AttemptHistory questionId="alg-java-0001" bump={0} />);
    await waitFor(() => expect(state.calls).toHaveLength(1));
    rerender(<AttemptHistory questionId="alg-java-0001" bump={1} />);
    await waitFor(() => expect(state.calls).toHaveLength(2));
    expect(state.calls[1]?.questionId).toBe('alg-java-0001');
  });
});
