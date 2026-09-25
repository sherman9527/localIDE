import { addDays, type MainCountReason } from '@arena/shared';
import type { AttemptRow } from '../ports.js';

/**
 * 难度自适应（N-01）：只动"主栈题量"这一个旋钮，而且只在 1..3 之间。
 * 目的是让连续做不好的人当天负担降下来（而不是继续被 3 题压着断签），
 * 稳定全对的人才加量。规则必须能一句话说清，否则界面上没法解释为什么是 1 题或 3 题。
 */

export const ADAPTIVE_RULE = {
  /** 只看最近这些天的作答 */
  windowDays: 7,
  /** 样本少于这个数就不据此加减（避免"做过 1 题刚好错"就降量） */
  minSamples: 5,
  /** 窗口内正确率低于它 → 主栈减 1 */
  lowRatio: 0.4,
  /** 高于或等于它 → 主栈加 1（前提：题库有题可加） */
  highRatio: 0.8,
  minMain: 1,
  maxMain: 3,
} as const;

export type { MainCountReason };

export interface AccuracyWindow {
  questions: number;
  passed: number;
  ratio: number;
}

/**
 * 窗口内"每道题的最好一次"的正确率。
 * 两个刻意的口径：needs_human 整条跳过（那是没人判过，不是不会）；同题重复作答只算最好那次。
 */
export function recentAccuracy(attempts: readonly AttemptRow[], date: string): AccuracyWindow | null {
  const from = addDays(date, -ADAPTIVE_RULE.windowDays);
  const best = new Map<string, AttemptRow>();
  for (const row of attempts) {
    if (row.status === 'needs_human') continue;
    if (row.day < from || row.day > date) continue;
    const seen = best.get(row.questionId);
    const better =
      !seen ||
      row.passed > seen.passed ||
      (row.passed === seen.passed && row.xp >= seen.xp && row.id >= seen.id);
    if (better) best.set(row.questionId, row);
  }
  const rows = [...best.values()];
  if (rows.length === 0) return null;
  const passed = rows.filter((r) => r.status === 'pass').length;
  return { questions: rows.length, passed, ratio: passed / rows.length };
}

export function planMainCount(
  window: AccuracyWindow | null,
  base: number,
  available = Number.MAX_SAFE_INTEGER,
): { count: number; reason: MainCountReason } {
  const ceiling = Math.min(ADAPTIVE_RULE.maxMain, available);
  if (!window || window.questions < ADAPTIVE_RULE.minSamples) {
    return { count: Math.min(base, Math.max(ADAPTIVE_RULE.minMain, ceiling)), reason: 'default' };
  }
  if (window.ratio < ADAPTIVE_RULE.lowRatio) {
    return {
      count: Math.max(ADAPTIVE_RULE.minMain, Math.min(base, ADAPTIVE_RULE.maxMain) - 1),
      reason: 'adaptive-low',
    };
  }
  if (window.ratio >= ADAPTIVE_RULE.highRatio) {
    const up = Math.min(base + 1, Math.max(ADAPTIVE_RULE.minMain, ceiling));
    if (up > base) return { count: up, reason: 'adaptive-high' };
  }
  return { count: Math.min(base, Math.max(ADAPTIVE_RULE.minMain, ceiling)), reason: 'default' };
}
