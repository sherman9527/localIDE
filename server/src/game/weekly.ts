import { CATEGORY_IDS, XP_RULES, addDays, isValidDate } from '@arena/shared';
import type { CategoryId, WeekDayStat, WeekSummary, WeekWindow } from '@arena/shared';
import type { AttemptRow } from '../ports.js';
import { isPassing } from './xp.js';

/**
 * 本周小结（N-03 的"周报"层）：雷达图看的是全历史，这里只看这一周 ——
 * 间隔重复要的是"这周哪一类还在漏"，而不是"你总共考得怎么样"。
 */

/** 周一为一周之始（本地日历口径，不做 ISO 时区换算）。 */
export function weekWindow(day: string): WeekWindow {
  if (!isValidDate(day)) return { start: day, end: day };
  const weekday = new Date(`${day}T00:00:00`).getDay();
  const sinceMonday = (weekday + 6) % 7;
  const start = addDays(day, -sinceMonday);
  return { start, end: addDays(start, 6) };
}

const dayInWindow = (day: string, window: WeekWindow): boolean => day >= window.start && day <= window.end;

const inWindow = (row: AttemptRow, window: WeekWindow): boolean => dayInWindow(row.day, window);

/** 评分链故障不算做过也不算挂：那是基础设施的问题，混进来会把正确率算低。 */
const counts = (row: AttemptRow): boolean => row.status !== 'needs_human';

export function summarizeWeek(
  attempts: readonly AttemptRow[],
  window: WeekWindow,
  opts: { bonusDays?: Set<string> } = {},
): WeekSummary {
  const rows = attempts.filter((row) => counts(row) && inWindow(row, window));

  // 每题只认本周最好那次（与 bestByQuestion 同一口径：同分取更早）
  const best = new Map<string, AttemptRow>();
  for (const row of rows) {
    const prev = best.get(row.questionId);
    if (!prev || row.xp > prev.xp) best.set(row.questionId, row);
  }

  const days: WeekDayStat[] = [];
  const span = isValidDate(window.start) && isValidDate(window.end) ? 7 : 1;
  for (let i = 0; i < span; i++) {
    const date = addDays(window.start, i);
    const onDay = rows.filter((row) => row.day === date);
    days.push({
      date,
      answered: onDay.length,
      passed: onDay.filter((row) => isPassing(row)).length,
      xp: onDay.reduce((sum, row) => sum + row.xp, 0),
    });
  }

  const byCategory: Partial<Record<CategoryId, { answered: number; passed: number; accuracy: number }>> = {};
  for (const category of CATEGORY_IDS) {
    const items = [...best.values()].filter((row) => row.category === category);
    if (items.length === 0) continue;
    const passed = items.filter((row) => isPassing(row)).length;
    byCategory[category] = { answered: items.length, passed, accuracy: passed / items.length };
  }

  const answered = best.size;
  const passedCount = [...best.values()].filter((row) => isPassing(row)).length;
  // 与顶部"累计 XP"同一条规则：每题只计最佳 + 成套的那几天各 +10。
  // 用"每次提交累加"会让本周大于累计（重做同一题也累），同一屏两个数互相打脸。
  const bestXp = [...best.values()].reduce((sum, row) => sum + row.xp, 0);
  const bonusInWeek = [...(opts.bonusDays ?? [])].filter((day) => dayInWindow(day, window)).length;

  let weakest: WeekSummary['weakest'] = null;
  // 按 CATEGORY_IDS 顺序扫，并列时"做得更多的"胜出，全同则保留靠前的 —— 结果必须可复现
  for (const category of CATEGORY_IDS) {
    const stat = byCategory[category];
    if (!stat) continue;
    if (
      !weakest ||
      stat.accuracy < weakest.accuracy ||
      (stat.accuracy === weakest.accuracy && stat.answered > weakest.answered)
    ) {
      weakest = { category, answered: stat.answered, passed: stat.passed, accuracy: stat.accuracy };
    }
  }

  return {
    start: window.start,
    end: window.end,
    days,
    answered,
    passed: passedCount,
    accuracy: answered > 0 ? passedCount / answered : 0,
    xp: bestXp + bonusInWeek * XP_RULES.dailySetBonus,
    byCategory,
    weakest,
  };
}
