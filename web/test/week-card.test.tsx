// @vitest-environment jsdom
import './dom-shim';
import { cleanup, render, screen } from '@testing-library/react';
import type { WeekSummary } from '@arena/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WeekSummaryCard from '../src/components/WeekSummaryCard';

const week = (over: Partial<WeekSummary> = {}): WeekSummary => ({
  start: '2026-09-14',
  end: '2026-09-20',
  days: [
    { date: '2026-09-14', answered: 3, passed: 2, xp: 32 },
    { date: '2026-09-15', answered: 0, passed: 0, xp: 0 },
    { date: '2026-09-16', answered: 3, passed: 3, xp: 45 },
    { date: '2026-09-17', answered: 0, passed: 0, xp: 0 },
    { date: '2026-09-18', answered: 2, passed: 1, xp: 17 },
    { date: '2026-09-19', answered: 3, passed: 2, xp: 30 },
    { date: '2026-09-20', answered: 0, passed: 0, xp: 0 },
  ],
  answered: 8,
  passed: 6,
  accuracy: 0.75,
  xp: 124,
  byCategory: {
    algorithms: { answered: 3, passed: 3, accuracy: 1 },
    sql: { answered: 3, passed: 1, accuracy: 1 / 3 },
  },
  weakest: { category: 'sql', answered: 3, passed: 1, accuracy: 1 / 3 },
  ...over,
});

const emptyWeek = (): WeekSummary =>
  week({
    days: week().days.map((d) => ({ ...d, answered: 0, passed: 0, xp: 0 })),
    answered: 0,
    passed: 0,
    accuracy: 0,
    xp: 0,
    byCategory: {},
    weakest: null,
  });

afterEach(() => {
  cleanup();
});

describe('WeekSummaryCard — 本周小结', () => {
  it('给范围、总量与七天格子', () => {
    render(<WeekSummaryCard week={week()} />);
    const card = screen.getByTestId('week-card');
    expect(card.textContent).toContain('09-14');
    expect(card.textContent).toContain('09-20');
    expect(card.textContent).toContain('8');
    expect(card.textContent).toContain('124');
    // 口径要写在脸上：这屏顶上就是"累计 XP"，两个数不解释就会被当成互相矛盾
    expect(card.textContent).toContain('计入');
    expect(card.textContent).toContain('每题只算最好那次');
    expect(screen.getAllByTestId(/^week-day-/)).toHaveLength(7);
  });

  it('点名这周最弱的一类，并说清是几题里过了几题', () => {
    render(<WeekSummaryCard week={week()} />);
    const hint = screen.getByTestId('week-weakest');
    expect(hint.textContent).toContain('SQL 与存储');
    expect(hint.textContent).toContain('33%');
    expect(hint.textContent).toContain('3 题里过了 1 题');
  });

  it('只列本周真练过的类别，没练的不占位', () => {
    render(<WeekSummaryCard week={week()} />);
    const rows = screen.getAllByTestId(/^week-cat-/);
    expect(rows.map((r) => r.getAttribute('data-category'))).toEqual(['sql', 'algorithms']);
  });

  it('这周什么都没做就直说，不编一个"最弱类别"', () => {
    render(<WeekSummaryCard week={emptyWeek()} />);
    expect(screen.getByTestId('week-empty').textContent).toContain('这周还没开始');
    expect(screen.queryByTestId('week-weakest')).toBeNull();
    expect(screen.queryAllByTestId(/^week-cat-/)).toHaveLength(0);
  });

  it('格子带可读标签（只看图的人也能知道哪天做了什么）', () => {
    render(<WeekSummaryCard week={week()} />);
    const cell = screen.getByTestId('week-day-2026-09-16');
    expect(cell.getAttribute('aria-label')).toContain('2026-09-16');
    expect(cell.getAttribute('aria-label')).toContain('3');
    expect(screen.getByTestId('week-day-2026-09-15').getAttribute('aria-label')).toContain('没做');
  });
});
