import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, hashSeed, isValidDate, mulberry32, pickForDay, shuffleWithSeed } from '../src/day.js';

interface Item {
  id: string;
  category: string;
}

const pool: Item[] = Array.from({ length: 30 }, (_, i) => ({
  id: `q-${String(i + 1).padStart(2, '0')}`,
  category: i % 2 === 0 ? 'sql' : 'frontend',
}));

describe('pickForDay — 每日确定性选题（需求 场景 4）', () => {
  it('同一天同一类别两次选题结果完全一致', () => {
    const a = pickForDay(pool, '2026-09-19', 'sql', 3);
    const b = pickForDay(pool, '2026-09-19', 'sql', 3);
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
  });

  it('只从该类别里选，且不重复', () => {
    const picked = pickForDay(pool, '2026-09-19', 'sql', 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((q) => q.id)).size).toBe(5);
    expect(picked.every((q) => q.category === 'sql')).toBe(true);
  });

  it('跨天组合不同', () => {
    const d1 = pickForDay(pool, '2026-09-19', 'sql', 3).map((q) => q.id);
    const d2 = pickForDay(pool, '2026-09-20', 'sql', 3).map((q) => q.id);
    expect(d1).not.toEqual(d2);
  });

  it('候选不足时返回全部候选而不报错', () => {
    const small = pool.filter((q) => q.category === 'sql').slice(0, 2);
    expect(small).toHaveLength(2);
    expect(pickForDay(small, '2026-09-19', 'sql', 5)).toHaveLength(2);
  });

  it('空池返回空数组（今日挑战页据此提示"该栈暂无题目"）', () => {
    expect(pickForDay([], '2026-09-19', 'sql', 3)).toEqual([]);
  });

  it('非法日期抛错，避免静默产生不稳定题目', () => {
    expect(() => pickForDay(pool, '2026-9-19', 'sql', 3)).toThrow(/date/);
    expect(() => pickForDay(pool, 'yesterday', 'sql', 3)).toThrow(/date/);
  });

  it('池顺序不影响选择结果（防止文件读取顺序改变当天题目）', () => {
    const reversed = [...pool].reverse();
    expect(pickForDay(reversed, '2026-09-19', 'sql', 3).map((q) => q.id)).toEqual(
      pickForDay(pool, '2026-09-19', 'sql', 3).map((q) => q.id),
    );
  });
});

describe('底层工具', () => {
  it('hashSeed 对同一字符串稳定、对不同字符串敏感', () => {
    expect(hashSeed('2026-09-19|sql')).toBe(hashSeed('2026-09-19|sql'));
    expect(hashSeed('2026-09-19|sql')).not.toBe(hashSeed('2026-09-19|frontend'));
  });

  it('mulberry32 产出 [0,1) 且同种子同序列', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = Array.from({ length: 5 }, r1);
    const seq2 = Array.from({ length: 5 }, r2);
    expect(seq1).toEqual(seq2);
    expect(seq1.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('shuffleWithSeed 是排列而非取样', () => {
    const ids = shuffleWithSeed(pool, '2026-09-19|sql').map((q) => q.id).sort();
    expect(ids).toEqual(pool.map((q) => q.id).sort());
  });

  it('isValidDate 只接受 YYYY-MM-DD 且真实存在', () => {
    expect(isValidDate('2026-09-19')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-9-1')).toBe(false);
  });

  it('addDays 按 UTC 日历日推进，跨月跨年与 0 都稳', () => {
    expect(addDays('2026-09-19', 1)).toBe('2026-09-20');
    expect(addDays('2026-09-19', 0)).toBe('2026-09-19');
    expect(addDays('2026-09-19', -1)).toBe('2026-09-18');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01'); // 2026 不是闰年
    expect(() => addDays('2026-2-27', 1)).toThrow(/YYYY-MM-DD/);
  });

  it('addDays 与 daysBetween 互为逆运算（排期算出的 due 能被"到期了吗"读回来）', () => {
    for (const n of [1, 3, 7, 14, 30, 60]) {
      expect(daysBetween('2026-09-19', addDays('2026-09-19', n))).toBe(n);
    }
  });
});
