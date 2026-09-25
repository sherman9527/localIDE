import type { CategoryId } from './taxonomy.js';
import type { JudgeStatus, RubricVerdict } from './judge.js';

/** XP 规则：代码题只看结果；主观题按 10 分制折算，上限 20。 */
export const XP_RULES = {
  pass: 15,
  fail: 2,
  error: 0,
  subjectiveMax: 20,
  /** 完成"今日套餐"（2 代码 + 1 主观）的额外奖励 */
  dailySetBonus: 10,
} as const;

/** 续签门槛：只答 1 题不足以续签，避免"打开一下就算打卡"的注水。 */
export const DAILY_STREAK_THRESHOLD_XP = 20;

/** 每日套餐：一个主栈 2 道代码题 + 一个副栈 1 道主观题，目标 45-60 分钟。 */
export const DAILY_PLAN = {
  mainQuestions: 2,
  sideQuestions: 1,
  targetMinutes: 50,
} as const;

export interface DailyPlan {
  date: string;
  main: { category: CategoryId; count: number; reason: MainCountReason };
  side: { category: CategoryId; count: number };
}

/** 主栈题量为什么是这个数（界面上要能一句话说清，见 N-01）。 */
export type MainCountReason = 'default' | 'adaptive-low' | 'adaptive-high';

/**
 * 复习间隔档位（天）。完整 SM-2 要一个 0-5 的"回忆质量"人工评分，本系统只有 pass/fail 与用时，
 * 硬套就是假装实现 —— 所以这里是它的**二值退化**：pass 升一档、fail 直接回第一档，
 * 且只有"这次 pass"与"上次也 pass"同时成立才升档（连续两次 pass 才升）。
 */
export const REVIEW_LADDER = [1, 3, 7, 14, 30, 60] as const;

/** 到顶之后仍按最后一档继续排（不做"毕业"，少一个状态就少一处漂移）。
 *  生产代码（server/src/game/review.ts）与测试读的是同一个常量 —— 别在这儿再算一遍。 */
export const REVIEW_TOP_STEP: number = REVIEW_LADDER[REVIEW_LADDER.length - 1] ?? 60;

export interface ReviewEntry {
  /** 连续 pass 次数：决定下一次落在阶梯的哪一档 */
  reps: number;
  /** 下次该复习的日期（YYYY-MM-DD） */
  due: string;
  /** 最近一次结果 */
  last: 'pass' | 'fail';
  /** 最近一次作答日（YYYY-MM-DD） */
  lastDay: string;
}

/**
 * 复习本：游戏层的排期状态，存在 settings 的单个键里（与 daily:plan、daily-set-bonus 同一模式）。
 * `seededAt` 只在"从历史 attempts 回填过一次"之后出现，避免每次读都重算。
 */
export interface ReviewBook {
  seededAt?: string;
  entries: Record<string, ReviewEntry>;
}

export function xpForAttempt(
  status: JudgeStatus,
  verdict?: Pick<RubricVerdict, 'score' | 'maxScore'>,
): number {
  if (verdict) {
    const ratio = verdict.maxScore > 0 ? verdict.score / verdict.maxScore : 0;
    return Math.round(ratio * XP_RULES.subjectiveMax);
  }
  switch (status) {
    case 'pass':
      return XP_RULES.pass;
    case 'fail':
      return XP_RULES.fail;
    case 'needs_human':
      return XP_RULES.fail;
    case 'error':
      return XP_RULES.error;
  }
}

export const LEAGUES = [
  { id: 'bronze', label: '青铜', minXp: 0 },
  { id: 'silver', label: '白银', minXp: 150 },
  { id: 'gold', label: '黄金', minXp: 450 },
  { id: 'platinum', label: '铂金', minXp: 1000 },
  { id: 'diamond', label: '钻石', minXp: 2000 },
] as const;

export type LeagueId = (typeof LEAGUES)[number]['id'];

export type LeagueTier = (typeof LEAGUES)[number];

export function leagueFor(xp: number): { id: LeagueId; label: string; nextAt: number | null } {
  let current: LeagueTier = LEAGUES[0]!;
  let next: LeagueTier | undefined;
  for (const league of LEAGUES) {
    if (xp >= league.minXp) current = league;
    else if (!next) next = league;
  }
  return { id: current.id, label: current.label, nextAt: next?.minXp ?? null };
}

export const ACHIEVEMENTS = [
  { id: 'streak-7', label: '七日连签', hint: '连续 7 天达到续签门槛' },
  { id: 'first-perfect', label: '满分主观', hint: '任一主观题拿到 10/10' },
  { id: 'all-stacks', label: '全栈出手', hint: '7 个类别各至少通过 1 题' },
  { id: 'spark-10', label: '数据工程十连', hint: 'big-data 类别累计通过 10 题' },
] as const;

/** 一周的边界（周一为一周之始，本地日历口径）。 */
export interface WeekWindow {
  start: string;
  end: string;
}

export interface WeekDayStat {
  date: string;
  /** 当天提交次数（含同一题重做） */
  answered: number;
  passed: number;
  xp: number;
}

/** 本周小结：雷达图看全历史，这里只看这一周 —— 间隔重复关心的是"这周哪类还在漏"。 */
export interface WeekSummary extends WeekWindow {
  days: WeekDayStat[];
  /** 本周做过的题数（按题去重） */
  answered: number;
  /** 本周最好成绩算通过的题数 */
  passed: number;
  accuracy: number;
  /** 本周累计 XP（按每次提交累加，与日历同一口径） */
  xp: number;
  byCategory: Partial<Record<CategoryId, { answered: number; passed: number; accuracy: number }>>;
  /** 本周练过的类别里正确率最低的那个；什么都没练则为 null */
  weakest: { category: CategoryId; answered: number; passed: number; accuracy: number } | null;
}
