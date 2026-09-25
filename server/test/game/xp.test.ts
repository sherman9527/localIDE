import { describe, expect, it } from 'vitest';
import { XP_RULES, xpForAttempt } from '@arena/shared';
import {
  bestPerQuestion,
  grantDailySetBonus,
  isPassing,
  loadAttemptSummary,
  summarizeAttempts,
  xpForCodeAttempt,
  xpForGradeAttempt,
} from '../../src/game/xp.js';
import { BareFakeStore, FakeStore, attemptOf, newAttempt, shiftDay } from './fixtures.js';

const DAY = '2026-09-19';

describe('xp 规则（单个 attempt）', () => {
  it('代码题：pass 15 / fail 2 / error 0', () => {
    expect(xpForCodeAttempt('pass')).toBe(XP_RULES.pass);
    expect(xpForCodeAttempt('fail')).toBe(XP_RULES.fail);
    expect(xpForCodeAttempt('error')).toBe(XP_RULES.error);
    expect(xpForCodeAttempt('needs_human')).toBe(XP_RULES.fail);
  });

  it('主观题：round(score / maxScore * 20)，上限 20', () => {
    expect(xpForGradeAttempt(10, 10)).toBe(XP_RULES.subjectiveMax);
    expect(xpForGradeAttempt(7, 10)).toBe(14);
    expect(xpForGradeAttempt(0, 10)).toBe(0);
    expect(xpForGradeAttempt(3, 0)).toBe(0);
    // 与 shared 的唯一口径保持一致
    expect(xpForGradeAttempt(4, 10)).toBe(xpForAttempt('pass', { score: 4, maxScore: 10 }));
  });

  it('isPassing 只认 pass', () => {
    expect(isPassing(attemptOf({ questionId: 'a', status: 'pass' }))).toBe(true);
    expect(isPassing(attemptOf({ questionId: 'a', status: 'fail' }))).toBe(false);
    expect(isPassing(attemptOf({ questionId: 'a', status: 'error' }))).toBe(false);
  });
});

describe('bestPerQuestion — 同题重复提交只计最佳一次', () => {
  it('取 xp 最大的那次；同分时取**更早**那次（历史日的 XP 不许被后来的重做搬走）', () => {
    const attempts = [
      attemptOf({ questionId: 'alg-java-0001', xp: 15, status: 'pass' }),
      attemptOf({ questionId: 'alg-java-0001', xp: 2, status: 'fail' }),
      attemptOf({ questionId: 'alg-java-0001', xp: 15, status: 'pass', createdAt: `${DAY}T23:00:00.000Z` }),
      attemptOf({ questionId: 'sql-mysql-0001', xp: 2, status: 'fail' }),
    ].map((r, i) => ({ ...r, id: i + 1 }));
    expect(bestPerQuestion(attempts).map((r) => r.id)).toEqual([1, 4]);
    // 与输入顺序无关
    expect(bestPerQuestion([...attempts].reverse()).map((r) => r.id)).toEqual([1, 4]);
    expect(bestPerQuestion(attempts).map((r) => r.questionId)).toEqual(['alg-java-0001', 'sql-mysql-0001']);
  });

  it('失败重交不会把最佳成绩从 pass 降回 fail', () => {
    const attempts = [
      attemptOf({ questionId: 'q', xp: 15, status: 'pass', id: 1 }),
      attemptOf({ questionId: 'q', xp: 2, status: 'fail', id: 2 }),
    ];
    const summary = summarizeAttempts(attempts);
    expect(summary.totalXp).toBe(15);
    expect(summary.byDay.get(DAY)?.xp).toBe(15);
    expect(summary.byQuestion.get('q')?.status).toBe('pass');
  });

  it('假 store 的 bestByQuestion 与真实现 bestPerQuestion 同口径', async () => {
    const store = new FakeStore();
    await store.record(newAttempt({ questionId: 'q1', day: DAY, xp: 15, status: 'pass' }));
    await store.record(newAttempt({ questionId: 'q1', day: shiftDay(DAY, 3), xp: 15, status: 'pass' }));
    await store.record(newAttempt({ questionId: 'q2', day: DAY, xp: 2, status: 'fail' }));
    await store.record(newAttempt({ questionId: 'q2', day: shiftDay(DAY, 1), xp: 15, status: 'pass' }));

    const fake = [...(await store.bestByQuestion()).values()].map((r) => r.id).sort((a, b) => a - b);
    const real = bestPerQuestion(await store.allAttempts()).map((r) => r.id).sort((a, b) => a - b);
    expect(fake).toEqual(real);
    // 方向也要钉死：q1 两次同分，算更早那天
    expect((await store.bestByQuestion()).get('q1')?.day).toBe(DAY);
  });
});

describe('summarizeAttempts — 按天聚合（best 记在最佳那次所在日）', () => {
  it('同分重做不追溯抽走旧一天的 XP（否则历史连击会被事后打断）', () => {
    const attempts = [
      attemptOf({ questionId: 'q1', day: DAY, xp: 15, status: 'pass', id: 1 }),
      attemptOf({ questionId: 'q2', day: DAY, xp: 15, status: 'pass', id: 2 }),
      // 几天后重做 q2，分数一样：q2 的 15 XP 必须仍算在 DAY，不能搬到 D+3
      attemptOf({ questionId: 'q2', day: shiftDay(DAY, 3), xp: 15, status: 'pass', id: 3 }),
    ];
    const summary = summarizeAttempts(attempts);
    expect(summary.byDay.get(DAY)?.xp).toBe(30);
    expect(summary.byDay.get(shiftDay(DAY, 3))?.xp).toBe(0);
    expect(summary.totalXp).toBe(30);
  });

  it('跨天最佳值归当天', () => {
    const attempts = [
      attemptOf({ questionId: 'q1', day: DAY, xp: 2, status: 'fail', id: 1 }),
      attemptOf({ questionId: 'q1', day: shiftDay(DAY, 1), xp: 15, status: 'pass', id: 2 }),
      attemptOf({ questionId: 'q2', day: shiftDay(DAY, 1), xp: 20, status: 'pass', kind: 'grade', id: 3 }),
    ];
    const summary = summarizeAttempts(attempts);
    expect(summary.byDay.get(DAY)?.xp).toBe(0);
    expect(summary.byDay.get(shiftDay(DAY, 1))?.xp).toBe(35);
    expect(summary.totalXp).toBe(35);
    expect(summary.byDay.get(DAY)?.answered).toBe(1);
    expect(summary.byDay.get(DAY)?.passed).toBe(0);
    expect(summary.byDay.get(shiftDay(DAY, 1))?.answered).toBe(2);
  });

  it('bonusDays 叠加进对应日并计入 totalXp', () => {
    const attempts = [attemptOf({ questionId: 'q1', day: DAY, xp: 30, id: 1 })];
    const summary = summarizeAttempts(attempts, { bonusDays: [DAY, shiftDay(DAY, 1)] });
    expect(summary.byDay.get(DAY)?.xp).toBe(40);
    expect(summary.byDay.get(shiftDay(DAY, 1))?.xp).toBe(10);
    expect(summary.totalXp).toBe(50);
  });

  it('空表：totalXp 0 且无日期', () => {
    const summary = summarizeAttempts([]);
    expect(summary.totalXp).toBe(0);
    expect(summary.byDay.size).toBe(0);
  });
});

describe('grantDailySetBonus — 套餐完成奖励幂等', () => {
  it('同一日重复发放只 +10 一次', async () => {
    const store = new FakeStore();
    const first = await grantDailySetBonus(store, DAY);
    const second = await grantDailySetBonus(store, DAY);
    expect(first.granted).toBe(true);
    expect(first.xp).toBe(XP_RULES.dailySetBonus);
    expect(second.granted).toBe(false);
    const summary = await loadAttemptSummary(store);
    expect(summary.totalXp).toBe(XP_RULES.dailySetBonus);
    expect(summary.bonusDays.has(DAY)).toBe(true);
  });

  it('store 无 settings 能力时静默跳过（不炸接口）', async () => {
    const store = new BareFakeStore();
    const res = await grantDailySetBonus(store, DAY);
    expect(res.granted).toBe(false);
    await expect(loadAttemptSummary(store)).resolves.toMatchObject({ totalXp: 0 });
  });
});

describe('loadAttemptSummary — 从 attempts 表推导', () => {
  it('读取 store 的全部 attempt 与已发放奖励', async () => {
    const store = new FakeStore();
    await store.record(newAttempt({ questionId: 'q1', day: DAY, xp: 15 }));
    await store.record(newAttempt({ questionId: 'q1', day: DAY, xp: 2, status: 'fail' }));
    await store.record(newAttempt({ questionId: 'q2', day: DAY, xp: 15 }));
    await grantDailySetBonus(store, DAY);
    const summary = await loadAttemptSummary(store);
    expect(summary.byQuestion.size).toBe(2);
    expect(summary.totalXp).toBe(15 + 15 + 10);
    expect(summary.byDay.get(DAY)?.xp).toBe(40);
    expect(summary.xpOn(DAY)).toBe(40);
    expect(summary.xpOn(shiftDay(DAY, 1))).toBe(0);
  });

  it('calendar(endDay, days) 缺失日补 0 且按时间升序', async () => {
    const store = new FakeStore();
    await store.record(newAttempt({ questionId: 'q1', day: DAY, xp: 15 }));
    const summary = await loadAttemptSummary(store);
    const calendar = summary.calendar(DAY, 5);
    expect(calendar.map((c) => c.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', DAY]);
    expect(calendar[0]).toEqual({ date: '2026-09-15', xp: 0, answered: 0, passed: 0 });
    expect(calendar[4]).toEqual({ date: DAY, xp: 15, answered: 1, passed: 1 });
  });
});
