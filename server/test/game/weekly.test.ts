import { describe, expect, it } from 'vitest';
import type { AttemptRow } from '../../src/ports.js';
import { summarizeWeek, weekWindow } from '../../src/game/weekly.js';
import { newAttempt } from './fixtures.js';

const attempt = (over: Partial<AttemptRow> & { questionId: string }): AttemptRow =>
  newAttempt({ category: 'algorithms', status: 'pass', xp: 15, day: '2026-09-16', ...over }) as AttemptRow;

describe('weekWindow — 本周从周一到周日', () => {
  it('周中某天回到本周一、推到本周日', () => {
    expect(weekWindow('2026-09-16')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
  });

  it('周一与周日各自就是边界（不能滑到下一周）', () => {
    expect(weekWindow('2026-09-14')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
    expect(weekWindow('2026-09-20')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
  });

  it('跨年那周不串周', () => {
    expect(weekWindow('2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
  });
});

describe('summarizeWeek — 本周小结（N-03 的周报层）', () => {
  const window = { start: '2026-09-14', end: '2026-09-20' };

  it('窗口外的提交一条都不算', () => {
    const rows = [attempt({ questionId: 'a', day: '2026-09-13' }), attempt({ questionId: 'b', day: '2026-09-21' })];
    const week = summarizeWeek(rows, window);
    expect(week.answered).toBe(0);
    expect(week.xp).toBe(0);
  });

  it('同一题重做只算一次，按本周最好那次定通过与否', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', status: 'fail', xp: 2, day: '2026-09-15' }),
        attempt({ questionId: 'a', status: 'pass', xp: 15, day: '2026-09-16' }),
      ],
      window,
    );
    expect(week.answered).toBe(1);
    expect(week.passed).toBe(1);
  });

  it('评分链故障（needs_human）既不算做过也不算挂：那是基础设施的问题', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', status: 'pass' }),
        attempt({ questionId: 'c', status: 'needs_human', kind: 'grade', xp: 0, score: null, maxScore: null }),
      ],
      window,
    );
    expect(week.answered).toBe(1);
    expect(week.accuracy).toBe(1);
  });

  it('七天都要有格子，没练的那天是 0 而不是缺项', () => {
    const week = summarizeWeek([attempt({ questionId: 'a', day: '2026-09-16', xp: 15 })], window);
    expect(week.days.map((d) => d.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(week.days[2]).toEqual({ date: '2026-09-16', answered: 1, passed: 1, xp: 15 });
    expect(week.days[0]).toEqual({ date: '2026-09-14', answered: 0, passed: 0, xp: 0 });
  });

  it('本周 XP 与顶部"累计 XP"同一口径：同一题重做不重复计', () => {
    // 累计 XP 的规则是"每题只计历史最佳"（防刷分）。本周若改成"每次提交累加"，
    // 就会出现"本周 368 > 累计 94"这种同屏两个数互相打脸的结果 —— 进度页真长这样过。
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', status: 'fail', xp: 2, day: '2026-09-15' }),
        attempt({ questionId: 'a', status: 'pass', xp: 15, day: '2026-09-16' }),
        attempt({ questionId: 'a', status: 'pass', xp: 15, day: '2026-09-17' }),
      ],
      window,
    );
    expect(week.xp).toBe(15);
  });

  it('套餐完成奖励算进本周（只算本周那几天，且按天幂等）', () => {
    const bonusDays = new Set(['2026-09-16', '2026-09-13']);
    const week = summarizeWeek([attempt({ questionId: 'a', day: '2026-09-16', xp: 15 })], window, { bonusDays });
    // 15（该题本周最佳）+ 10（9-16 成套）；9-13 在窗口外，不算
    expect(week.xp).toBe(25);
  });

  it('每天格子仍是"当天提交次数"口径（与近 30 天日历一致）', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', status: 'fail', xp: 2, day: '2026-09-14' }),
        attempt({ questionId: 'b', status: 'pass', xp: 15, day: '2026-09-14' }),
      ],
      window,
    );
    expect(week.days[0]?.xp).toBe(17);
    expect(week.xp).toBe(17);
  });

  it('按类别分开统计，只列出本周真练过的', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', category: 'algorithms' }),
        attempt({ questionId: 's', category: 'sql', status: 'fail', xp: 2 }),
        attempt({ questionId: 's2', category: 'sql', status: 'fail', xp: 2 }),
      ],
      window,
    );
    expect(Object.keys(week.byCategory).sort()).toEqual(['algorithms', 'sql']);
    expect(week.byCategory.sql).toEqual({ answered: 2, passed: 0, accuracy: 0 });
    expect(week.byCategory['agent-design']).toBeUndefined();
  });

  it('最弱的一类点名给出来；本周什么都没练就别说"最弱"', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', category: 'algorithms' }),
        attempt({ questionId: 'b', category: 'sql', status: 'fail', xp: 2 }),
        attempt({ questionId: 'c', category: 'sql', status: 'pass' }),
      ],
      window,
    );
    expect(week.weakest).toEqual({ category: 'sql', answered: 2, passed: 1, accuracy: 0.5 });
    expect(summarizeWeek([], window).weakest).toBeNull();
  });

  it('并列取做得更多的那类（练得多的问题更值得先看）', () => {
    const week = summarizeWeek(
      [
        attempt({ questionId: 'a', category: 'algorithms', status: 'fail', xp: 2 }),
        attempt({ questionId: 'b', category: 'sql', status: 'fail', xp: 2 }),
        attempt({ questionId: 'c', category: 'sql', status: 'fail', xp: 2 }),
      ],
      window,
    );
    expect(week.weakest?.category).toBe('sql');
  });
});
