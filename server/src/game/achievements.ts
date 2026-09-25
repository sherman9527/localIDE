import { ACHIEVEMENTS, CATEGORY_IDS, type CategoryId } from '@arena/shared';
import type { Clock, ProgressStore } from '../ports.js';
import { isPassing, loadAttemptSummary, type AttemptSummary } from './xp.js';
import { computeStreak, qualifiedDays, resolveToday, type Streak } from './streak.js';

/**
 * 四个成就全部从 attempts 推导，不额外存表（spec：段位/成就只读，不引入对抗）。
 * - streak-7    连续 7 个达标日（历史最长或当前）
 * - first-perfect 任一主观题拿到满分
 * - all-stacks   7 类各至少通过 1 题
 * - spark-10     big-data 累计通过 10 道不同的题
 */
export interface AchievementState {
  id: string;
  label: string;
  hint: string;
  unlocked: boolean;
}

const STREAK_GOAL = 7;
const SPARK_GOAL = 10;

function passedQuestionIds(summary: AttemptSummary, category?: CategoryId): Set<string> {
  const out = new Set<string>();
  for (const attempt of summary.attempts) {
    if (!isPassing(attempt)) continue;
    if (category && attempt.category !== category) continue;
    out.add(attempt.questionId);
  }
  return out;
}

export function evaluateAchievements(summary: AttemptSummary, streak: Streak): AchievementState[] {
  const categoriesPassed = new Set<CategoryId>();
  for (const attempt of summary.attempts) {
    if (isPassing(attempt)) categoriesPassed.add(attempt.category as CategoryId);
  }
  const perfectSubjective = summary.attempts.some(
    (a) => a.kind === 'grade' && a.maxScore !== null && a.maxScore > 0 && a.score !== null && a.score >= a.maxScore,
  );
  const unlocked: Record<string, boolean> = {
    'streak-7': Math.max(streak.streakDays, streak.streakLongest) >= STREAK_GOAL,
    'first-perfect': perfectSubjective,
    'all-stacks': CATEGORY_IDS.every((category) => categoriesPassed.has(category)),
    'spark-10': passedQuestionIds(summary, 'big-data').size >= SPARK_GOAL,
  };
  return ACHIEVEMENTS.map((achievement) => ({
    id: achievement.id,
    label: achievement.label,
    hint: achievement.hint,
    unlocked: unlocked[achievement.id] ?? false,
  }));
}

export interface AchievementSnapshot {
  summary: AttemptSummary;
  streak: Streak;
  achievements: AchievementState[];
}

export async function loadAchievements(store: ProgressStore, opts: { clock?: Clock; today?: string } = {}): Promise<AchievementSnapshot> {
  const summary = await loadAttemptSummary(store);
  const today = resolveToday(opts.today, opts.clock);
  const streak = computeStreak(qualifiedDays(summary), today);
  return { summary, streak, achievements: evaluateAchievements(summary, streak) };
}
