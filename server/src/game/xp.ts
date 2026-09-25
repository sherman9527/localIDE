import { CATEGORY_IDS, XP_RULES, isValidDate, previousDay, xpForAttempt, type CategoryId, type CategoryProgress, type JudgeStatus } from '@arena/shared';
import type { AttemptRow, ProgressStore } from '../ports.js';
import { asSettingsStore } from '../db/index.js';

/**
 * XP 记账口径（progress-gamification/spec）：
 * - 每题只计历史最佳一次（重复提交不刷分）；
 * - 最佳那次记在它所属的自然日上，因此 sum(byDay.xp) === totalXp；
 * - 完成当日套餐的 +10 记为"已发放奖励日"，发放本身幂等。
 */

const BONUS_KEY = 'daily:setBonusDays';

export interface DayTotals {
  xp: number;
  answered: number;
  passed: number;
}

export interface AttemptSummary {
  attempts: AttemptRow[];
  /** 每题最佳那次（按 id 升序） */
  bestRows: AttemptRow[];
  byQuestion: Map<string, AttemptRow>;
  byDay: Map<string, DayTotals>;
  byCategory: Map<CategoryId, CategoryProgress>;
  bonusDays: Set<string>;
  totalXp: number;
  xpOn(day: string): number;
  calendar(endDay: string, days: number): { date: string; xp: number; answered: number; passed: number }[];
}

/** 代码题：pass 15 / fail 2 / error 0（唯一口径来自 shared）。 */
export function xpForCodeAttempt(status: JudgeStatus): number {
  return xpForAttempt(status);
}

/** 主观题：round(score / maxScore * 20)，上限 XP_RULES.subjectiveMax。 */
export function xpForGradeAttempt(score: number, maxScore: number): number {
  const raw = xpForAttempt('pass', { score: Math.max(0, score), maxScore: Math.max(0, maxScore) });
  return Math.min(XP_RULES.subjectiveMax, raw);
}

/** 主观题算"通过"的最低得分率（spec 未定，这里取 6/10 及格线）。 */
export const GRADE_PASS_RATIO = 0.6;

export function gradeStatus(score: number, maxScore: number): JudgeStatus {
  return maxScore > 0 && score / maxScore >= GRADE_PASS_RATIO ? 'pass' : 'fail';
}

export function isPassing(attempt: Pick<AttemptRow, 'status'>): boolean {
  return attempt.status === 'pass';
}

/** 每题最佳：xp 最大者胜出；**同分时取更早那次**，让历史日的 XP 一旦落定就不被后来的重做抽走。 */
export function bestPerQuestion(attempts: readonly AttemptRow[]): AttemptRow[] {
  const best = new Map<string, AttemptRow>();
  // 先按 id 升序，保证"同分取更早"不依赖调用方给的数组顺序
  for (const attempt of [...attempts].sort((a, b) => a.id - b.id)) {
    const prev = best.get(attempt.questionId);
    if (!prev || attempt.xp > prev.xp) best.set(attempt.questionId, attempt);
  }
  return [...best.values()].sort((a, b) => a.id - b.id);
}

export function summarizeAttempts(attempts: readonly AttemptRow[], opts: { bonusDays?: Iterable<string> } = {}): AttemptSummary {
  const bonusDays = new Set([...(opts.bonusDays ?? [])].filter((day) => isValidDate(day)));
  const byQuestion = new Map(bestPerQuestion(attempts).map((row) => [row.questionId, row]));
  const bestRows = [...byQuestion.values()].sort((a, b) => a.id - b.id);

  const byDay = new Map<string, DayTotals>();
  const dayOf = (day: string): DayTotals => {
    let totals = byDay.get(day);
    if (!totals) {
      totals = { xp: 0, answered: 0, passed: 0 };
      byDay.set(day, totals);
    }
    return totals;
  };
  for (const attempt of attempts) {
    const totals = dayOf(attempt.day);
    totals.answered += 1;
    if (isPassing(attempt)) totals.passed += 1;
  }
  for (const row of bestRows) dayOf(row.day).xp += row.xp;
  for (const day of bonusDays) dayOf(day).xp += XP_RULES.dailySetBonus;

  const answeredByCategory = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    const set = answeredByCategory.get(attempt.category) ?? new Set<string>();
    set.add(attempt.questionId);
    answeredByCategory.set(attempt.category, set);
  }
  const byCategory = new Map<CategoryId, CategoryProgress>();
  for (const category of CATEGORY_IDS) {
    const answeredIds = answeredByCategory.get(category);
    if (!answeredIds?.size) continue;
    let xp = 0;
    let passed = 0;
    for (const questionId of answeredIds) {
      const row = byQuestion.get(questionId);
      if (!row) continue;
      xp += row.xp;
      if (isPassing(row)) passed += 1;
    }
    const answered = answeredIds.size;
    byCategory.set(category, { answered, passed, accuracy: answered > 0 ? passed / answered : 0, xp });
  }

  const totalXp = bestRows.reduce((sum, row) => sum + row.xp, 0) + bonusDays.size * XP_RULES.dailySetBonus;

  return {
    attempts: [...attempts],
    bestRows,
    byQuestion,
    byDay,
    byCategory,
    bonusDays,
    totalXp,
    xpOn: (day: string) => (isValidDate(day) ? (byDay.get(day)?.xp ?? 0) : 0),
    calendar: (endDay: string, days: number) => {
      const window: string[] = [];
      let cursor = endDay;
      for (let i = 0; i < days; i++) {
        window.unshift(cursor);
        cursor = previousDay(cursor);
      }
      return window.map((date) => {
        const totals = byDay.get(date);
        return { date, xp: totals?.xp ?? 0, answered: totals?.answered ?? 0, passed: totals?.passed ?? 0 };
      });
    },
  };
}

/** 已发放的套餐完成奖励日（settings 单键 JSON 数组，避免要求 store 具备 list 能力）。 */
export async function loadBonusDays(store: ProgressStore): Promise<Set<string>> {
  const settings = asSettingsStore(store);
  if (!settings) return new Set();
  const raw = await settings.getSetting(BONUS_KEY).catch(() => null);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((day): day is string => typeof day === 'string' && isValidDate(day)));
  } catch {
    return new Set();
  }
}

export interface BonusGrant {
  granted: boolean;
  xp: number;
  days: string[];
}

/** 幂等发放"完成今日套餐 +10"。store 不支持 settings 时静默跳过（不炸接口）。
 *  没有 clock 参数是有意为之：日期由调用方算好传进来（`plan.date`），这里再读一次时钟只会
 *  出现"套餐是昨天完成、奖励记在今天"这种两套时钟的缝。 */
export async function grantDailySetBonus(store: ProgressStore, day: string): Promise<BonusGrant> {
  if (!isValidDate(day)) return { granted: false, xp: 0, days: [] };
  const settings = asSettingsStore(store);
  if (!settings) return { granted: false, xp: 0, days: [] };
  const days = [...(await loadBonusDays(store))];
  if (days.includes(day)) return { granted: false, xp: 0, days };
  const next = [...days, day].sort();
  await settings.setSetting(BONUS_KEY, JSON.stringify(next)).catch(() => undefined);
  return { granted: true, xp: XP_RULES.dailySetBonus, days: next };
}

export async function loadAttemptSummary(store: ProgressStore): Promise<AttemptSummary> {
  const [attempts, bonusDays] = await Promise.all([store.allAttempts(), loadBonusDays(store)]);
  return summarizeAttempts(attempts, { bonusDays });
}
