// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ progress: null as unknown }));

vi.mock('../src/api', () => ({
  api: { progress: () => Promise.resolve(state.progress) },
}));

import Progress from '../src/pages/Progress';
import { progressResponse } from './fixtures';

async function renderProgress(over: Parameters<typeof progressResponse>[0] = {}) {
  state.progress = progressResponse(over);
  const ui = render(<Progress />);
  const card = await ui.findByTestId('review-card');
  return { ui, card };
}

beforeEach(() => {
  cleanup();
});

describe('进度页 — 错题本卡片（WI-41）', () => {
  it('报出在册 / 今日到期 / 最久没碰三个数', async () => {
    const { card } = await renderProgress({ review: { tracked: 5, dueToday: 2, oldestDays: 30 } });
    expect(card.textContent).toContain('在册 5 题');
    expect(card.textContent).toContain('今日到期 2 题');
    expect(card.textContent).toContain('最久没碰 30 天');
    // 说清"复习不额外加菜"，否则人会觉得今天的量变大了
    expect(card.textContent).toContain('每天仍是 3 题');
  });

  it('空册时给下一步指引，而不是摆一排 0', async () => {
    const { card } = await renderProgress({ review: { tracked: 0, dueToday: 0, oldestDays: null } });
    expect(card.textContent).toContain('还没有待复习的题');
    expect(card.textContent).not.toContain('在册');
  });
});
