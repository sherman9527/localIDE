// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  today: null as unknown,
  categories: null as unknown,
  health: null as unknown,
  progress: null as unknown,
}));

vi.mock('../src/api', async () => {
  const fix = await import('./fixtures');
  void fix;
  return {
    api: {
      today: () => Promise.resolve(state.today),
      categories: () => Promise.resolve(state.categories),
      health: () => Promise.resolve(state.health),
      progress: () => Promise.resolve(state.progress),
    },
  };
});

import Today from '../src/pages/Today';
import { CATEGORY_LIST } from '@arena/shared';
import type { StackHealth } from '@arena/shared';
import { CODE_QUESTION, SUBJECTIVE_QUESTION, categoriesResponse, progressResponse, stackHealth, todayResponse } from './fixtures';

async function renderToday(
  over: Parameters<typeof todayResponse>[0] = {},
  health: StackHealth = stackHealth(),
  progressOver: Parameters<typeof progressResponse>[0] = {},
) {
  state.today = todayResponse(over);
  state.categories = categoriesResponse();
  state.health = health;
  state.progress = progressResponse(progressOver);
  const ui = render(<Today />);
  await ui.findAllByTestId('category-card');
  return ui;
}

beforeEach(() => {
  cleanup();
  window.location.hash = '/';
  vi.unstubAllGlobals();
});

describe('今日挑战页', () => {
  it('渲染 7 个类别卡（中文名 + 技术栈副标题）', async () => {
    await renderToday();
    const cards = screen.getAllByTestId('category-card');
    expect(cards).toHaveLength(7);
    for (const meta of CATEGORY_LIST) {
      const card = cards.find((el) => el.dataset.category === meta.id)!;
      expect(within(card).getByText(meta.label)).toBeTruthy();
      expect(within(card).getByText(meta.stack)).toBeTruthy();
    }
  });

  it('今日套餐渲染 3 道题，点击题目卡跳到 /q/<id>', async () => {
    await renderToday();
    const items = screen.getAllByTestId('plan-item');
    expect(items).toHaveLength(3);
    fireEvent.click(items[1]!);
    expect(window.location.hash).toBe('#/q/sql-mysql-0003');
  });

  it('套餐进度显示 完成 X/3、今日 XP、连续天数与续签缺口', async () => {
    await renderToday({ progress: { answered: 1, passed: 1, xpToday: 17, streakSafe: false } });
    expect(screen.getByTestId('set-progress').textContent).toContain('完成 1/3');
    expect(screen.getByTestId('set-progress').textContent).toContain('今日 XP 17');
    expect(screen.getByTestId('set-progress').textContent).toContain('连续 6 天');
    expect(screen.getByText(/再完成 1 题即可续签/)).toBeTruthy();
  });

  it('XP 已达门槛时提示已够续签', async () => {
    await renderToday({ progress: { answered: 2, passed: 2, xpToday: 30, streakSafe: true } });
    expect(screen.getByText(/今日 XP 已够续签/)).toBeTruthy();
    expect(screen.queryByText(/再完成 \d+ 题即可续签/)).toBeNull();
  });

  it('套餐全部做完时显示完成态', async () => {
    await renderToday({ progress: { answered: 3, passed: 3, xpToday: 40, streakSafe: true } });
    expect(screen.getByTestId('today-done').textContent).toContain('今日已完成');
  });

  it('答过但不全对时不许谎报"今日已完成"', async () => {
    await renderToday(
      { progress: { answered: 3, passed: 3, xpToday: 17, streakSafe: false } },
      stackHealth(),
      { today: { planned: [], answered: ['a', 'b', 'c'], passed: ['a'], done: false } },
    );
    expect(screen.queryByTestId('today-done')).toBeNull();
    expect(screen.getByTestId('set-progress').textContent).toContain('完成 3/3');
  });

  it('题库为空时走空态而不是白屏', async () => {
    await renderToday({ questions: [] });
    expect(screen.getByTestId('state-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('plan-item')).toHaveLength(0);
  });

  it('接口失败时给出可重试的中文错误，不暴露堆栈', async () => {
    state.today = Promise.reject(new Error('boom'));
    state.categories = Promise.resolve(categoriesResponse());
    state.health = Promise.resolve(stackHealth());
    state.progress = Promise.resolve(progressResponse());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Today />);
    await screen.findByTestId('state-error');
    expect(screen.getByTestId('state-error').textContent).toContain('今日挑战加载失败');
    expect(screen.getByTestId('state-error').textContent).not.toContain('at ');
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
    spy.mockRestore();
  });

  it('该栈不可判分时标出来而不是静默失败', async () => {
    await renderToday({}, stackHealth({ stacks: { java: true, pyspark: false } }));
    const card = screen.getAllByTestId('category-card').find((el) => el.dataset.category === 'big-data')!;
    expect(within(card).getByText('暂不可判分')).toBeTruthy();
  });
});

describe('今日套餐 — 复习位（WI-41）', () => {
  it('reviewIds 指向的那道题挂"复习"徽章，其余不挂', async () => {
    const ui = await renderToday({ reviewIds: ['sql-mysql-0003'] });
    const labels = (await ui.findAllByTestId('plan-item')).map((el) => el.textContent ?? '');
    expect(labels.filter((t) => t.includes('复习'))).toHaveLength(1);
    expect(labels.find((t) => t.includes('复习'))).toContain('窗口函数');
  });

  it('没有复习题时界面上不出现"复习"字样', async () => {
    const ui = await renderToday({});
    const labels = (await ui.findAllByTestId('plan-item')).map((el) => el.textContent ?? '');
    expect(labels.some((t) => t.includes('复习'))).toBe(false);
  });

  it('分组按槽位数而不是类别：跨类别的复习题仍留在主菜里', async () => {
    const ui = await renderToday({ reviewIds: ['sql-mysql-0003'] });
    const main = ui.container.querySelector<HTMLElement>('.plan-group[data-role="main"]')!;
    const titles = within(main).getAllByTestId('plan-item').map((el) => el.textContent ?? '');
    expect(titles).toHaveLength(2);
    expect(titles.some((t) => t.includes('窗口函数'))).toBe(true);
  });
});

describe('今日套餐 — 自适应题量的说明（N-01）', () => {
  it('降量时说明"最近正确率偏低"，并给出今天的题数', async () => {
    const ui = await renderToday({
      plan: {
        date: '2026-09-19',
        main: { category: 'algorithms', count: 1, reason: 'adaptive-low' },
        side: { category: 'system-design', count: 1 },
      },
      questions: [CODE_QUESTION, SUBJECTIVE_QUESTION],
    });
    const hint = await ui.findByTestId('adaptive-hint');
    expect(hint.textContent).toContain('最近正确率偏低');
    expect(hint.textContent).toContain('1 题');
  });

  it('默认口径时不出现解释（不无事生非）', async () => {
    const ui = await renderToday({});
    await ui.findAllByTestId('plan-item');
    expect(ui.queryByTestId('adaptive-hint')).toBeNull();
  });
});

describe('今日套餐 — 主栈口径要说清含不含复习（WI-41 的界面补漏）', () => {
  it('主栈槽位被复习题占掉时，hero 里注明"其中 N 道是复习"', async () => {
    const ui = await renderToday({ reviewIds: ['sql-mysql-0003'] });
    await ui.findAllByTestId('plan-item');
    expect(ui.container.querySelector('.hero-sub')?.textContent).toContain('其中 1 道是复习');
  });

  it('没有复习时不多嘴', async () => {
    const ui = await renderToday({});
    await ui.findAllByTestId('plan-item');
    expect(ui.container.querySelector('.hero-sub')?.textContent).not.toContain('复习');
  });
});
