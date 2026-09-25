import { describe, expect, it } from 'vitest';
import { DAILY_STREAK_THRESHOLD_XP } from '@arena/shared';
import { computeStreak, isStreakSafe, loadStreak, qualifiedDays, xpToThreshold } from '../../src/game/streak.js';
import { grantDailySetBonus, summarizeAttempts } from '../../src/game/xp.js';
import { FakeStore, attemptOf, fixedClock, newAttempt, shiftDay } from './fixtures.js';

const DAY = '2026-09-19';
const pass = (questionId: string, day: string, id: number) => attemptOf({ questionId, day, id, xp: 15, status: 'pass' });

/** 连续 n 天（末日为 endDay）各 2 道 pass，即每日 30 XP。 */
const runOfDays = (n: number, endDay: string) => {
  const rows = [];
  let id = 1;
  for (let i = n - 1; i >= 0; i--) {
    const day = shiftDay(endDay, -i);
    rows.push(pass(`q-${day}-a`, day, id++), pass(`q-${day}-b`, day, id++));
  }
  return rows;
};

describe('qualifiedDays — 当日 XP 达标才算续签', () => {
  it('门槛是 20 XP：1 道代码题（15）不够，2 道才够', () => {
    const one = summarizeAttempts([pass('q1', DAY, 1)]);
    expect(qualifiedDays(one)).toEqual(new Set());
    expect(isStreakSafe(one, DAY)).toBe(false);

    const two = summarizeAttempts([pass('q1', DAY, 1), pass('q2', DAY, 2)]);
    expect([...qualifiedDays(two)]).toEqual([DAY]);
    expect(isStreakSafe(two, DAY)).toBe(true);
    expect(DAILY_STREAK_THRESHOLD_XP).toBe(20);
  });

  it('套餐完成奖励让"1 道 pass + 完成套餐"也达标', async () => {
    const store = new FakeStore();
    await store.record(newAttempt({ questionId: 'q1', day: DAY, xp: 15 }));
    await store.record(newAttempt({ questionId: 'q2', day: DAY, xp: 15 }));
    await store.record(newAttempt({ questionId: 'q3', day: DAY, xp: 15 }));
    await grantDailySetBonus(store, DAY);
    const { summary, streak } = await loadStreak(store, { clock: fixedClock(DAY) });
    expect(summary.xpOn(DAY)).toBe(55);
    expect(streak.streakDays).toBe(1);
  });

  it('重复提交同一题不刷分，因此不构成续签', () => {
    const summary = summarizeAttempts([
      attemptOf({ questionId: 'q1', day: DAY, id: 1, xp: 15 }),
      attemptOf({ questionId: 'q1', day: DAY, id: 2, xp: 15 }),
      attemptOf({ questionId: 'q1', day: DAY, id: 3, xp: 15 }),
    ]);
    expect(summary.totalXp).toBe(15);
    expect(qualifiedDays(summary).size).toBe(0);
    expect(xpToThreshold(summary.xpOn(DAY))).toBe(5);
  });
});

describe('computeStreak — 连续自然日', () => {
  it('7 个连续达标日 → streakDays 7', () => {
    const summary = summarizeAttempts(runOfDays(7, DAY));
    expect(computeStreak(qualifiedDays(summary), DAY)).toEqual({ streakDays: 7, streakLongest: 7 });
  });

  it('断签后重置为 1（3 天前有记录、昨日无、今日达标）', () => {
    const summary = summarizeAttempts([...runOfDays(4, shiftDay(DAY, -3)), ...runOfDays(1, DAY)]);
    const res = computeStreak(qualifiedDays(summary), DAY);
    expect(res.streakDays).toBe(1);
    expect(res.streakLongest).toBe(4);
  });

  it('今日还没达标时不立刻清零（昨日链仍在），但 streakSafe=false', () => {
    const summary = summarizeAttempts([...runOfDays(2, shiftDay(DAY, -1)), pass('q-today', DAY, 99)]);
    const res = computeStreak(qualifiedDays(summary), DAY);
    expect(res.streakDays).toBe(2);
    expect(res.streakLongest).toBe(2);
    expect(isStreakSafe(summary, DAY)).toBe(false);
  });

  it('全部断签 → 0', () => {
    const summary = summarizeAttempts(runOfDays(3, shiftDay(DAY, -10)));
    expect(computeStreak(qualifiedDays(summary), DAY)).toEqual({ streakDays: 0, streakLongest: 3 });
  });

  it('空历史 → 0/0', () => {
    expect(computeStreak(new Set<string>(), DAY)).toEqual({ streakDays: 0, streakLongest: 0 });
  });

  it('同日多题只算 1 天', () => {
    const summary = summarizeAttempts([
      pass('a', DAY, 1),
      pass('b', DAY, 2),
      pass('c', DAY, 3),
      pass('d', DAY, 4),
    ]);
    expect(computeStreak(qualifiedDays(summary), DAY).streakDays).toBe(1);
  });
});

describe('loadStreak — 注入时钟 + store', () => {
  it('用假 Clock 造日期，不必等真过一天', async () => {
    const store = new FakeStore();
    for (const row of runOfDays(3, '2026-09-21')) await store.record(newAttempt(row));
    const on21 = await loadStreak(store, { clock: fixedClock('2026-09-21') });
    expect(on21.today).toBe('2026-09-21');
    expect(on21.streak.streakDays).toBe(3);
    expect(on21.xpToday).toBe(30);

    const on22 = await loadStreak(store, { clock: fixedClock('2026-09-22') });
    expect(on22.streak.streakDays).toBe(3);
    expect(on22.safe).toBe(false);
    await store.record(newAttempt({ questionId: 'q-22-a', day: '2026-09-22', xp: 15 }));
    await store.record(newAttempt({ questionId: 'q-22-b', day: '2026-09-22', xp: 15 }));
    const after = await loadStreak(store, { clock: fixedClock('2026-09-22') });
    expect(after.streak.streakDays).toBe(4);
    expect(after.safe).toBe(true);
  });

  it('空库不炸', async () => {
    const res = await loadStreak(new FakeStore(), { clock: fixedClock(DAY) });
    expect(res).toMatchObject({ today: DAY, xpToday: 0, safe: false });
    expect(res.streak).toEqual({ streakDays: 0, streakLongest: 0 });
  });
});
