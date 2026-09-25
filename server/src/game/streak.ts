import { DAILY_STREAK_THRESHOLD_XP, daysBetween, isValidDate, previousDay } from '@arena/shared';
import type { Clock, ProgressStore } from '../ports.js';
import { loadAttemptSummary, type AttemptSummary } from './xp.js';
import { todayIso } from '@arena/shared';

/** 续签门槛：当日（含套餐完成奖励）累计 XP 达标才算"这一天出勤"。 */
export const STREAK_THRESHOLD_XP = DAILY_STREAK_THRESHOLD_XP;

export interface Streak {
  streakDays: number;
  streakLongest: number;
}

/** 达标日集合：只由 attempts + 已发放奖励推导，不额外存表。 */
export function qualifiedDays(summary: AttemptSummary, threshold = STREAK_THRESHOLD_XP): Set<string> {
  const out = new Set<string>();
  for (const [day, totals] of summary.byDay) {
    if (totals.xp >= threshold) out.add(day);
  }
  return out;
}

/** 今日是否已经续签（false 时前端提示"再完成 X XP 即可续签"）。 */
export function isStreakSafe(summary: AttemptSummary, today: string, threshold = STREAK_THRESHOLD_XP): boolean {
  return summary.xpOn(today) >= threshold;
}

/** 距离续签还差多少 XP。 */
export function xpToThreshold(xpToday: number, threshold = STREAK_THRESHOLD_XP): number {
  return Math.max(0, threshold - xpToday);
}

/**
 * 当前连签：今日达标则从今天往前数；今日未达标但昨天达标则停在昨天（今天还没过完，不清零）。
 * 断签后重新达标只从 1 开始（spec：断签重置）。
 */
export function computeStreak(qualified: ReadonlySet<string>, today: string): Streak {
  if (!isValidDate(today)) return { streakDays: 0, streakLongest: 0 };
  const has = (day: string): boolean => qualified.has(day);
  const anchor = has(today) ? today : has(previousDay(today)) ? previousDay(today) : null;
  let streakDays = 0;
  if (anchor) {
    let cursor = anchor;
    while (has(cursor)) {
      streakDays++;
      cursor = previousDay(cursor);
    }
  }
  return { streakDays, streakLongest: longestRun(qualified) };
}

/** 历史最长连签。 */
export function longestRun(qualified: ReadonlySet<string>): number {
  const days = [...qualified].filter(isValidDate).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of days) {
    run = prev !== null && daysBetween(prev, day) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

export interface StreakSnapshot {
  today: string;
  streak: Streak;
  xpToday: number;
  safe: boolean;
  summary: AttemptSummary;
  qualified: Set<string>;
}

export function resolveToday(date: string | undefined, clock: Clock | undefined): string {
  if (date && isValidDate(date)) return date;
  return todayIso((clock ?? { now: () => new Date() }).now());
}

export async function loadStreak(store: ProgressStore, opts: { clock?: Clock; today?: string } = {}): Promise<StreakSnapshot> {
  const summary = await loadAttemptSummary(store);
  return snapshotStreak(summary, opts);
}

/** 今日未达标但昨天达标时链仍"活着"（今天还没过完），所以 streakDays 不清零、只是 safe=false。 */
export function snapshotStreak(summary: AttemptSummary, opts: { clock?: Clock; today?: string } = {}): StreakSnapshot {
  const today = resolveToday(opts.today, opts.clock);
  const qualified = qualifiedDays(summary);
  return {
    today,
    streak: computeStreak(qualified, today),
    xpToday: summary.xpOn(today),
    safe: isStreakSafe(summary, today),
    summary,
    qualified,
  };
}
