// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankResponse, BankRow } from '@arena/shared';

/**
 * 题库页的筛选契约。
 *
 * 这个文件是补空洞的：题库页此前**一条测试都没有**，而"公司"这一档是刚加的 ——
 * 没有测试就等于"我加了个下拉，它明天还在不在、筛得对不对，全靠下次有人手点"。
 *
 * N-15 之后响应里没有题面正文了，所以这里同时钉住两件事：
 * 列表用的是 `rows` / `caseCount` / `company` 这套瘦字段，
 * 而关键词是**带着 q 去问服务端**的（客户端已经没有正文可搜）。
 */

const state = vi.hoisted(() => ({
  bank: null as BankResponse | null,
  calls: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock('../src/api', () => ({
  api: {
    bank: (query: Record<string, unknown>) => {
      state.calls.push(query);
      // 只在**重取**时失败（首次成功）：模拟"列表在手、这次搜索没通"
      if (state.fail) return Promise.reject(new Error('搜索服务没响应'));
      return Promise.resolve(state.bank);
    },
    hide: () => Promise.resolve({ ok: true }),
    unhide: () => Promise.resolve({ ok: true }),
  },
}));

import Bank from '../src/pages/Bank';

const row = (id: string, title: string, over: Partial<BankRow> = {}): BankRow => ({
  id,
  title,
  category: 'sql',
  difficulty: 'senior',
  judgeKind: 'mysql',
  tags: ['idempotency', 'retry'],
  caseCount: 3,
  ...over,
});

const ROWS: BankRow[] = [
  row('alg-java-0001', 'Airbnb 的预订区间锁', { category: 'algorithms', judgeKind: 'java-junit', company: 'Airbnb' }),
  row('sql-mysql-0002', '拼多多的库存扣减', { company: 'PDD' }),
  row('sys-rubric-0003', '字节的服务降级设计', {
    category: 'system-design',
    judgeKind: 'llm-rubric',
    difficulty: 'principal',
    company: 'ByteDance',
    caseCount: 0,
  }),
  row('fe-react-0004', '早期没标公司的组件题', { category: 'frontend', judgeKind: 'react-vitest' }),
];

const FACETS = {
  tags: [
    { name: 'idempotency', count: 4 },
    { name: 'retry', count: 4 },
  ],
  // 全库不同标签比下拉里的多：那部分只能靠关键词搜（N-17 的收敛就是为这个）
  tagCount: 12,
  companies: [
    { name: 'Airbnb', count: 1 },
    { name: 'PDD', count: 1 },
    { name: 'ByteDance', count: 1 },
  ],
  unlabeled: 1,
};

async function renderBank(over: Partial<BankResponse> = {}) {
  state.fail = false;
  state.bank = { rows: ROWS, hiddenIds: [], total: ROWS.length, ...FACETS, ...over };
  const view = render(<Bank />);
  await screen.findByText(`${ROWS.length} 题`);
  return view;
}

function titleOf(rowEl: HTMLElement): string {
  return within(rowEl).getByRole('button', { name: /^(?!移除|恢复)/ }).textContent ?? '';
}

describe('题库页的公司筛选', () => {
  beforeEach(() => {
    cleanup();
    state.calls.length = 0;
  });

  it('下拉列出题库里真出现过的公司，并单列"未标公司"这一档', async () => {
    await renderBank();
    const select = screen.getByLabelText('按公司筛选') as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain('all');
    expect(values).toContain('Airbnb');
    expect(values).toContain('PDD');
    expect(values).toContain('ByteDance');
    // 早期那批没有公司标签，它们必须还能被筛出来，而不是"选任何公司都少一批、
    // 选全部又看不出少了谁"
    expect(values).toContain('(none)');
    expect(within(select).getByRole('option', { name: /未标公司/ })).toBeTruthy();
  });

  it('选一家公司只剩它的题，计数标题跟着变成"筛选后"', async () => {
    await renderBank();
    fireEvent.change(screen.getByLabelText('按公司筛选'), { target: { value: 'PDD' } });
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(titleOf(within(list).getAllByRole('listitem')[0] as HTMLElement)).toContain('拼多多');
    await screen.findByText('1 题（筛选后）');
  });

  it('"未标公司"只给没有 company 的题', async () => {
    await renderBank();
    fireEvent.change(screen.getByLabelText('按公司筛选'), { target: { value: '(none)' } });
    const list = await screen.findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(titleOf(items[0] as HTMLElement)).toContain('早期没标公司');
  });

  it('公司与类别/难度/标签是"与"的关系，且清空筛选一次回到全部', async () => {
    await renderBank();
    fireEvent.change(screen.getByLabelText('按公司筛选'), { target: { value: 'ByteDance' } });
    fireEvent.change(screen.getByLabelText('按难度筛选'), { target: { value: 'principal' } });
    const list = await screen.findByRole('list');
    for (const item of within(list).getAllByRole('listitem')) {
      expect(titleOf(item)).toContain('字节');
    }
    fireEvent.click(screen.getByRole('button', { name: /清空筛选/ }));
    await screen.findByText(`${ROWS.length} 题`);
    expect(screen.queryByText('（筛选后）')).toBeNull();
  });

  it('徽章上的用例数来自 caseCount（响应里已经没有 cases 了）', async () => {
    await renderBank();
    const list = await screen.findByRole('list');
    const texts = within(list).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(texts.some((t) => t.includes('3 个用例'))).toBe(true);
    expect(texts.some((t) => t.includes('主观题'))).toBe(true);
  });

  it('关键词是带着 q 去问服务端的（客户端那份列表里没有题面正文）', async () => {
    await renderBank();
    expect(state.calls.at(-1)?.q, '没输关键词时不该带 q').toBeUndefined();

    fireEvent.change(screen.getByLabelText('按关键词搜索题库'), { target: { value: '背压' } });
    await vi.waitFor(() => expect(state.calls.at(-1)?.q).toBe('背压'));
    // 标题上如实说明当前是在搜索结果里（不然"3 题"会被读成题库只有 3 题）
    expect((await screen.findByText(/搜索「背压」/)).textContent).toContain('搜索「背压」');
  });

  it('搜索失败不许把整页换成错误态：列表留在原地，并说清"这是上一次的结果"', async () => {
    await renderBank();
    state.fail = true;
    fireEvent.change(screen.getByLabelText('按关键词搜索题库'), { target: { value: '背压' } });

    const banner = await screen.findByText(/这一次没取到/);
    expect(banner.textContent).toContain('上一次的结果');
    // 关键：不能悄悄显示旧结果当新结果，也不能把已经看到的列表丢掉
    expect(await screen.findByRole('list')).toBeTruthy();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(ROWS.length);
    expect(screen.queryByText('题库加载失败')).toBeNull();
  });
});

describe('题库页的标签下拉（N-17：963 项的 select 等于没有）', () => {
  beforeEach(() => {
    cleanup();
    state.calls.length = 0;
  });

  it('只列服务端给的常用标签，选项上带出现次数', async () => {
    await renderBank();
    const select = screen.getByLabelText('按标签筛选') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['all', 'idempotency', 'retry']);
    expect(select.options[1]!.textContent).toContain('4');
  });

  it('有标签被频次挡住时，界面要说清"另有几个只能搜"，而不是让人以为题库只有这些标签', async () => {
    await renderBank();
    const hint = screen.getByTestId('bank-tag-hint');
    expect(hint.textContent).toContain('2 个');
    expect(hint.textContent).toContain('10 个');
    expect(hint.textContent).toContain('关键词');
  });

  it('全库标签都进了下拉（没东西被挡住）时不许出现那句提示', async () => {
    await renderBank({ tagCount: FACETS.tagCount - 10 });
    expect(screen.queryByTestId('bank-tag-hint')).toBeNull();
  });
});
