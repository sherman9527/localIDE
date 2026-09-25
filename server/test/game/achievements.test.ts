import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, type CategoryId } from '@arena/shared';
import { evaluateAchievements, loadAchievements } from '../../src/game/achievements.js';
import { computeStreak, qualifiedDays } from '../../src/game/streak.js';
import { summarizeAttempts } from '../../src/game/xp.js';
import { FakeStore, attemptOf, fixedClock, newAttempt, shiftDay } from './fixtures.js';

const DAY = '2026-09-19';
const unlockedIds = (list: { id: string; unlocked: boolean }[]) => list.filter((a) => a.unlocked).map((a) => a.id);

const grade = (questionId: string, score: number, day = DAY) =>
  attemptOf({ questionId, day, kind: 'grade', status: score === 10 ? 'pass' : 'fail', score, maxScore: 10, xp: score * 2 });

describe('evaluateAchievements', () => {
  it('顺序与 id 与 ACHIEVEMENTS 完全一致，未达成时全部 locked', () => {
    const summary = summarizeAttempts([]);
    const list = evaluateAchievements(summary, { streakDays: 0, streakLongest: 0 });
    expect(list.map((a) => a.id)).toEqual([...ACHIEVEMENTS.map((a) => a.id)]);
    expect(list.every((a) => a.unlocked === false)).toBe(true);
    expect(list.find((a) => a.id === 'streak-7')?.hint).toContain('7');
  });

  it('streak-7：连续 7 个达标日点亮（当前或历史最长）', () => {
    const rows = [];
    let id = 1;
    for (let i = 6; i >= 0; i--) {
      const day = shiftDay(DAY, -i);
      rows.push(attemptOf({ questionId: `a-${day}`, day, id: id++, xp: 15 }), attemptOf({ questionId: `b-${day}`, day, id: id++, xp: 15 }));
    }
    const summary = summarizeAttempts(rows);
    const streak = computeStreak(qualifiedDays(summary), DAY);
    expect(streak.streakDays).toBe(7);
    expect(unlockedIds(evaluateAchievements(summary, streak))).toContain('streak-7');

    const six = summarizeAttempts(rows.slice(2));
    expect(unlockedIds(evaluateAchievements(six, computeStreak(qualifiedDays(six), DAY)))).not.toContain('streak-7');
  });

  it('first-perfect：任一主观题 10/10', () => {
    const near = summarizeAttempts([grade('sd-rub-0001', 9)]);
    expect(unlockedIds(evaluateAchievements(near, { streakDays: 0, streakLongest: 0 }))).not.toContain('first-perfect');
    const perfect = summarizeAttempts([grade('sd-rub-0001', 9), grade('sd-rub-0002', 10)]);
    expect(unlockedIds(evaluateAchievements(perfect, { streakDays: 0, streakLongest: 0 }))).toContain('first-perfect');
  });

  it('all-stacks：7 类各至少通过 1 题；只有 6 类时不亮', () => {
    const cats: CategoryId[] = ['frontend', 'algorithms', 'sql', 'system-design', 'big-data', 'agent-design'];
    const six = summarizeAttempts(cats.map((category, i) => attemptOf({ questionId: `q-${category}`, category, id: i + 1, xp: 15 })));
    expect(unlockedIds(evaluateAchievements(six, { streakDays: 0, streakLongest: 0 }))).not.toContain('all-stacks');
    const seven = summarizeAttempts([...cats, 'hot-interviews' as CategoryId].map((category, i) => attemptOf({ questionId: `p-${category}`, category, id: i + 1, xp: 15 })));
    expect(unlockedIds(evaluateAchievements(seven, { streakDays: 0, streakLongest: 0 }))).toContain('all-stacks');
  });

  it('spark-10：big-data 累计通过 10 题（同题重交不重复计）', () => {
    const rows = [];
    for (let i = 1; i <= 9; i++) rows.push(attemptOf({ questionId: `bd-${i}`, category: 'big-data', id: i, xp: 15 }));
    const nine = summarizeAttempts(rows);
    expect(unlockedIds(evaluateAchievements(nine, { streakDays: 0, streakLongest: 0 }))).not.toContain('spark-10');
    rows.push(attemptOf({ questionId: 'bd-1', category: 'big-data', id: 100, xp: 15 }));
    expect(unlockedIds(evaluateAchievements(summarizeAttempts(rows), { streakDays: 0, streakLongest: 0 }))).not.toContain('spark-10');
    rows.push(attemptOf({ questionId: 'bd-10', category: 'big-data', id: 101, xp: 15 }));
    expect(unlockedIds(evaluateAchievements(summarizeAttempts(rows), { streakDays: 0, streakLongest: 0 }))).toContain('spark-10');
  });

  it('fail 计数不算通过', () => {
    const rows = Array.from({ length: 12 }, (_, i) => attemptOf({ questionId: `bd-f-${i}`, category: 'big-data', id: i + 1, xp: 2, status: 'fail', passed: 0, failed: 1 }));
    const list = evaluateAchievements(summarizeAttempts(rows), { streakDays: 0, streakLongest: 0 });
    expect(unlockedIds(list)).toEqual([]);
  });
});

describe('loadAchievements — 从 attempts 表推导（无额外存储）', () => {
  it('store 里只有 attempts 也能算出全部四个成就状态', async () => {
    const store = new FakeStore();
    for (let i = 0; i < 2; i++) await store.record(newAttempt({ questionId: `sd-rub-${i}`, category: 'system-design', kind: 'grade', status: 'pass', score: 10, maxScore: 10, xp: 20, day: DAY }));
    const res = await loadAchievements(store, { clock: fixedClock(DAY) });
    expect(res.streak).toBeDefined();
    expect(res.achievements.find((a) => a.id === 'first-perfect')?.unlocked).toBe(true);
    expect(res.achievements.find((a) => a.id === 'all-stacks')?.unlocked).toBe(false);
    expect(res.achievements).toHaveLength(ACHIEVEMENTS.length);
  });
});
