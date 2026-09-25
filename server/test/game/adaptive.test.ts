import { describe, expect, it } from 'vitest';
import type { AttemptRow } from '../../src/ports.js';
import { ADAPTIVE_RULE, planMainCount, recentAccuracy } from '../../src/game/adaptive.js';

/**
 * 难度自适应（N-01）：只调"主栈题量"这一个旋钮，且只在 1..3 之间。
 * 这里测的是规则本身（纯函数 + 注入日期），不碰 store —— 接线在 daily.test.ts 里测。
 */

const DAY = '2026-09-20';

const row = (over: Partial<AttemptRow> & { questionId: string }): AttemptRow => ({
  id: 1,
  category: 'algorithms',
  kind: 'judge',
  status: 'pass',
  score: null,
  maxScore: null,
  xp: 15,
  passed: 1,
  failed: 0,
  durationMs: 1000,
  createdAt: `${DAY}T09:00:00.000Z`,
  day: DAY,
  ...over,
});

/** 造 n 道题的结果：pass/fail 交替可控。 */
function history(passes: number, fails: number, dayOffset = -1): AttemptRow[] {
  const day = new Date(Date.parse(`${DAY}T00:00:00Z`) + dayOffset * 86_400_000).toISOString().slice(0, 10);
  const out: AttemptRow[] = [];
  for (let i = 0; i < passes; i++) out.push(row({ questionId: `p${i}`, status: 'pass', day }));
  for (let i = 0; i < fails; i++) out.push(row({ questionId: `f${i}`, status: 'fail', passed: 0, failed: 1, xp: 2, day }));
  return out;
}

describe('recentAccuracy — 只看窗口内的"每题最好结果"', () => {
  it('空历史给 null（没数据就不假装判断）', () => {
    expect(recentAccuracy([], DAY)).toBeNull();
  });

  it('窗口外的作答不算', () => {
    const old = history(0, 6, -(ADAPTIVE_RULE.windowDays + 3));
    expect(recentAccuracy(old, DAY)).toBeNull();
  });

  it('同一题重复作答只算最好那次（fail 之后 pass 记 pass）', () => {
    const mixed = [...history(0, 3), ...history(3, 0)];
    // 上面是 3 道只 fail 过 + 3 道 pass 过：按"每题最好"应为 6 题 3 通过
    expect(recentAccuracy(mixed, DAY)).toMatchObject({ questions: 6, passed: 3 });
    const sameQuestion = [row({ questionId: 'q', status: 'fail', passed: 0, failed: 1, xp: 2 }), row({ questionId: 'q', status: 'pass' })];
    expect(recentAccuracy(sameQuestion, DAY)).toMatchObject({ questions: 1, passed: 1 });
  });

  it('needs_human 不参与正确率（那是没人判过，不是不会）', () => {
    const rows = [...history(2, 0), row({ questionId: 'n', status: 'needs_human', kind: 'grade', passed: 0, failed: 1, xp: 0 })];
    expect(recentAccuracy(rows, DAY)).toMatchObject({ questions: 2, passed: 2 });
  });
});

describe('planMainCount — 主栈题量的三档规则', () => {
  it('没数据时保持默认 2 题', () => {
    expect(planMainCount(null, 2).count).toBe(2);
    expect(planMainCount({ questions: 2, passed: 0, ratio: 0 }, 2).count).toBe(2); // 样本太少，不据此加减
  });

  it('连续做不好就降到 1 题，并把原因带出来', () => {
    const verdict = planMainCount(recentAccuracy(history(1, 8), DAY), 2);
    expect(verdict.count).toBe(1);
    expect(verdict.reason).toBe('adaptive-low');
  });

  it('稳定全对才加到 3 题', () => {
    const verdict = planMainCount(recentAccuracy(history(9, 0), DAY), 2);
    expect(verdict.count).toBe(3);
    expect(verdict.reason).toBe('adaptive-high');
  });

  it('中间地带保持默认，且理由写 default', () => {
    const verdict = planMainCount(recentAccuracy(history(4, 3), DAY), 2);
    expect(verdict.count).toBe(2);
    expect(verdict.reason).toBe('default');
  });

  it('题目不够时不许加量（自适应不能变出题库里没有的题）', () => {
    const verdict = planMainCount(recentAccuracy(history(9, 0), DAY), 2, 2);
    expect(verdict.count).toBe(2);
    expect(verdict.reason).not.toBe('adaptive-high');
  });

  it('下限 1：再差也不能当天 0 题（0 题等于断签）', () => {
    const verdict = planMainCount(recentAccuracy(history(0, 20), DAY), 2);
    expect(verdict.count).toBe(1);
  });
});
