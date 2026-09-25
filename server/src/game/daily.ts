import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CATEGORY_IDS,
  DAILY_PLAN,
  isValidDate,
  pickForDay,
  publicQuestion,
  shuffleWithSeed,
  type CategoryId,
  type DailyPlan,
  type PublicQuestion,
  type Question,
} from '@arena/shared';
import type { AttemptRow, BankPort, Clock, ProgressStore } from '../ports.js';
import { asSettingsStore } from '../db/index.js';
import { config } from '../config.js';
import { resolveToday } from './streak.js';
import { dueIds, loadBook, type ReviewBook } from './review.js';
import { ADAPTIVE_RULE, planMainCount, recentAccuracy } from './adaptive.js';
import type { MainCountReason } from '@arena/shared';

/**
 * 每日挑战编排（daily-challenge/spec）。
 * 主栈 = 2 道可判分代码题；副栈 = 另一类的 1 道主观题；
 * 类别与题目都按 `date` 做确定性种子选取，content/curriculum/*.json 存在则覆盖。
 * 已软删除的题目来自 bank.visible()，永远不进池；被 hide 后从候补池补足。
 * 有到期复习题时（WI-41）它**顶掉一个槽位**而不是加菜 —— "每天 3 题"的承诺不随复习变动。
 */

export const PRACTICE_POOL_SIZE = 4;

/** 可判分（进主栈）= 非 llm-rubric。 */
export function isJudgeable(q: Pick<Question, 'judgeKind'>): boolean {
  return q.judgeKind !== 'llm-rubric';
}

export interface CurriculumEntry {
  main: CategoryId;
  side: CategoryId;
}

interface CachedPlan {
  date: string;
  main: CategoryId;
  side: CategoryId;
  /** 当天定下来的主栈题量口径（N-01），缓存命中时照原样报出去，避免"同一天两种说法" */
  mainReason: MainCountReason;
  mainIds: string[];
  sideIds: string[];
  /** 复习题会替换掉 main/side 的某个槽位（槽位总数不变），这里只记它是哪一道 */
  reviewIds: string[];
}

const planKey = (date: string): string => `daily:plan:${date}`;

function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * 读排课：`content/curriculum/*.json`，形状 `{ "2026-10-01": {main, side} }`
 * （也接受 `{ days: { ... } }` 包一层）。坏文件只忽略，不阻断选题。
 */
export async function loadCurriculum(dir: string = config.curriculumDir): Promise<Map<string, CurriculumEntry>> {
  const out = new Map<string, CurriculumEntry>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const root = parsed as Record<string, unknown>;
    const body = (root && typeof root.days === 'object' && root.days !== null ? root.days : root) as
      | Record<string, unknown>
      | unknown[];
    // 两种形状都要认：手写/单测用的 `{"YYYY-MM-DD": {main, side}}` 映射，
    // 以及 scripts/curriculum.mjs 真正产出的 `days: [{date, main, side}, ...]` 数组。
    const rows: [string, unknown][] = Array.isArray(body)
      ? body.map((row) => {
          const rec = (row ?? {}) as Record<string, unknown>;
          return [String(rec.date ?? ''), row] as [string, unknown];
        })
      : Object.entries(body);
    for (const [date, value] of rows) {
      if (!isValidDate(date)) continue;
      const entry = value as Partial<CurriculumEntry> | null;
      if (!entry || !isCategoryId(entry.main) || !isCategoryId(entry.side)) continue;
      out.set(date, { main: entry.main, side: entry.side });
    }
  }
  return out;
}

function groupByCategory(pool: readonly Question[]): Map<CategoryId, Question[]> {
  const map = new Map<CategoryId, Question[]>();
  for (const q of pool) {
    const list = map.get(q.category) ?? [];
    list.push(q);
    map.set(q.category, list);
  }
  return map;
}

/** 按 `${date}|${slot}` 种子的确定性类别顺序（与 pickForDay 同一套 FNV-1a + mulberry32）。 */
function categoryOrder(date: string, slot: 'main' | 'side'): CategoryId[] {
  return shuffleWithSeed(
    CATEGORY_IDS.map((id) => ({ id, category: id as string })),
    `${date}|${slot}`,
  ).map((c) => c.id as CategoryId);
}

function preferredOrAuto(
  preferred: CategoryId | undefined,
  order: CategoryId[],
  groups: Map<CategoryId, Question[]>,
  exclude: CategoryId | undefined,
): CategoryId | undefined {
  if (preferred && preferred !== exclude && (groups.get(preferred)?.length ?? 0) > 0) return preferred;
  const usable = order.filter((category) => category !== exclude && (groups.get(category)?.length ?? 0) > 0);
  return usable[0];
}

export interface DailyPlanDeps {
  /** 缺省用 clock（注入时钟即可复现任意一天的套餐） */
  date?: string;
  bank: BankPort;
  store: ProgressStore;
  clock?: Clock;
  curriculumDir?: string;
}

export interface PlannedDay {
  plan: DailyPlan;
  questions: PublicQuestion[];
  /** questions 里哪几道是"到期复习"顶进来的（槽位总数不变，只是身份不同） */
  reviewIds: string[];
}

async function readCachedPlan(store: ProgressStore, date: string): Promise<CachedPlan | null> {
  const settings = asSettingsStore(store);
  if (!settings) return null;
  const raw = await settings.getSetting(planKey(date)).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedPlan;
    if (!parsed || parsed.date !== date || !isCategoryId(parsed.main) || !isCategoryId(parsed.side)) return null;
    if (!Array.isArray(parsed.mainIds) || !Array.isArray(parsed.sideIds)) return null;
    if (parsed.mainIds.length + parsed.sideIds.length === 0) return null;
    // 老缓存没有 reviewIds / mainReason 字段 —— 认它，只是当天不标复习、按默认口径报题量
    const reviewIds = Array.isArray(parsed.reviewIds) ? parsed.reviewIds.filter((id): id is string => typeof id === 'string') : [];
    const mainReason: MainCountReason =
      parsed.mainReason === 'adaptive-low' || parsed.mainReason === 'adaptive-high' ? parsed.mainReason : 'default';
    return { ...parsed, reviewIds, mainReason };
  } catch {
    return null;
  }
}

async function writeCachedPlan(store: ProgressStore, cached: CachedPlan): Promise<void> {
  const settings = asSettingsStore(store);
  if (!settings) return;
  await settings.setSetting(planKey(cached.date), JSON.stringify(cached)).catch(() => undefined);
}

/** 今日套餐：同日两次调用 deep-equal（算法本身确定 + settings 缓存兜住题库漂移）。 */
export async function planForDay(deps: DailyPlanDeps): Promise<PlannedDay> {
  const date = resolveToday(deps.date, deps.clock);
  const visible = await deps.bank.visible();
  const byId = new Map(visible.map((q) => [q.id, q]));
  const curriculum = await loadCurriculum(deps.curriculumDir ?? config.curriculumDir);
  const entry = curriculum.get(date);

  const cached = await readCachedPlan(deps.store, date);
  const cachedStillValid = cached ? validateCachedPlan(cached, byId, entry) : false;
  if (cached && cachedStillValid) {
    return {
      plan: {
        date,
        main: { category: cached.main, count: cached.mainIds.length, reason: cached.mainReason },
        side: { category: cached.side, count: cached.sideIds.length },
      },
      questions: [...cached.mainIds, ...cached.sideIds].map((id) => publicQuestion(byId.get(id)!)),
      reviewIds: cached.reviewIds,
    };
  }

  const judgeable = visible.filter(isJudgeable);
  const subjective = visible.filter((q) => !isJudgeable(q));
  const judgeableGroups = groupByCategory(judgeable);
  const subjectiveGroups = groupByCategory(subjective);
  const mainOrder = categoryOrder(date, 'main');
  const sideOrder = categoryOrder(date, 'side');

  // 主栈优先挑题量够 2 道的类别，其次退到"有 1 道也算"
  const autoMain =
    mainOrder.find((category) => (judgeableGroups.get(category)?.length ?? 0) >= DAILY_PLAN.mainQuestions) ??
    preferredOrAuto(undefined, mainOrder, judgeableGroups, undefined);
  const mainCategory = preferredOrAuto(entry?.main, mainOrder, judgeableGroups, undefined) ?? autoMain ?? mainOrder[0]!;
  const sideCategory =
    preferredOrAuto(entry?.side, sideOrder, subjectiveGroups, mainCategory) ??
    sideOrder.find((category) => category !== mainCategory) ??
    CATEGORY_IDS.find((category) => category !== mainCategory)!;

  // 主栈题量按近 7 天正确率微调（N-01）；available 用该类别的实际可判题数，
  // 否则"加一道"会变成"从只有 2 题的类别里变出第 3 题"。
  const availableMain = mainCategory ? (judgeableGroups.get(mainCategory)?.length ?? 0) : 0;
  const mainCount = planMainCount(
    recentAccuracy(await deps.store.allAttempts(), date),
    DAILY_PLAN.mainQuestions,
    availableMain,
  );

  const mainPicks = mainCategory ? pickForDay(judgeable, date, mainCategory, mainCount.count) : [];
  const sidePicks = sideCategory ? pickForDay(subjective, date, sideCategory, DAILY_PLAN.sideQuestions) : [];

  const slots: { main: Question[]; side: Question[] } = { main: [...mainPicks], side: [...sidePicks] };
  const reviewIds: string[] = [];
  const review = pickReview({
    book: await loadBook(deps.store, date),
    date,
    byId,
    slots,
    mainCategory,
    sideCategory,
  });
  if (review) {
    // 顶掉"同形态那一组"的最后一个槽位：槽位数不变，所以套餐完成判定、XP 上限都不用改
    const group = isJudgeable(review) ? 'main' : 'side';
    slots[group][slots[group].length - 1] = review;
    reviewIds.push(review.id);
  }

  await writeCachedPlan(deps.store, {
    date,
    main: mainCategory,
    side: sideCategory,
    mainReason: mainCount.reason,
    mainIds: slots.main.map((q) => q.id),
    sideIds: slots.side.map((q) => q.id),
    reviewIds,
  });

  return {
    plan: {
      date,
      main: { category: mainCategory, count: slots.main.length, reason: mainCount.reason },
      side: { category: sideCategory, count: slots.side.length },
    },
    questions: [...slots.main, ...slots.side].map((q) => publicQuestion(q)),
    reviewIds,
  };
}

/**
 * 选今天顶槽位的复习题。优先级：今天主栈类别里的代码题 → 副栈类别里的主观题 →
 * 任意代码题 → 任意主观题；都要求"仍然可见"且没被今天的新题选中。
 */
function pickReview(opts: {
  book: ReviewBook;
  date: string;
  byId: Map<string, Question>;
  slots: { main: Question[]; side: Question[] };
  mainCategory: CategoryId;
  sideCategory: CategoryId;
}): Question | null {
  const picked = new Set([...opts.slots.main, ...opts.slots.side].map((q) => q.id));
  const due = dueIds(opts.book, opts.date)
    .map((id) => opts.byId.get(id))
    .filter((q): q is Question => !!q && !picked.has(q.id));
  const tiers: ((q: Question) => boolean)[] = [
    (q) => isJudgeable(q) && q.category === opts.mainCategory && opts.slots.main.length > 0,
    (q) => !isJudgeable(q) && q.category === opts.sideCategory && opts.slots.side.length > 0,
    (q) => isJudgeable(q) && opts.slots.main.length > 0,
    (q) => !isJudgeable(q) && opts.slots.side.length > 0,
  ];
  for (const tier of tiers) {
    const hit = due.find(tier);
    if (hit) return hit;
  }
  return null;
}

/** 缓存只有在"题仍在可见题库、形态未变、排课没改口径"时才有效。 */
function validateCachedPlan(cached: CachedPlan, byId: Map<string, Question>, entry: CurriculumEntry | undefined): boolean {
  if (entry && (entry.main !== cached.main || entry.side !== cached.side)) return false;
  if (cached.mainIds.length > ADAPTIVE_RULE.maxMain || cached.sideIds.length > DAILY_PLAN.sideQuestions) return false;
  if (cached.reviewIds.length > 1) return false;
  const review = new Set(cached.reviewIds);
  for (const id of cached.reviewIds) {
    if (!cached.mainIds.includes(id) && !cached.sideIds.includes(id)) return false;
  }
  for (const id of cached.mainIds) {
    const q = byId.get(id);
    if (!q) return false;
    // 复习题是"外来的"，只要求仍然可见；类别约束只对新题成立
    if (review.has(id)) continue;
    if (!isJudgeable(q) || q.category !== cached.main) return false;
  }
  for (const id of cached.sideIds) {
    const q = byId.get(id);
    if (!q) return false;
    if (review.has(id)) continue;
    if (isJudgeable(q) || q.category !== cached.side) return false;
  }
  return true;
}

/** 单独选栈的练习池；只影响可练内容，不参与套餐完成判定。 */
export async function practicePool(deps: DailyPlanDeps & { category: CategoryId }): Promise<PublicQuestion[]> {
  const date = resolveToday(deps.date, deps.clock);
  const visible = await deps.bank.visible();
  const picks = pickForDay(visible, date, deps.category, PRACTICE_POOL_SIZE);
  const ordered = [...picks.filter(isJudgeable), ...picks.filter((q) => !isJudgeable(q))];
  return ordered.map((q) => publicQuestion(q));
}

export interface PlanProgress {
  answered: string[];
  passed: string[];
  done: boolean;
}

/** 完成态只看套餐内的题（自由练习只加 XP）。同题多次提交按当日最佳。 */
export function evaluatePlanProgress(plan: DailyPlan, questions: readonly PublicQuestion[], attempts: readonly AttemptRow[]): PlanProgress {
  const today = attempts.filter((a) => a.day === plan.date);
  const answered: string[] = [];
  const passed: string[] = [];
  for (const question of questions) {
    // needs_human（评分链故障降级）不算"这道题做过"，否则基础设施故障会永久卡住当日套餐
    const rows = today.filter((a) => a.questionId === question.id && a.status !== 'needs_human');
    if (rows.length === 0) continue;
    answered.push(question.id);
    const best = rows.reduce((a, b) => (b.xp > a.xp || (b.xp === a.xp && b.id > a.id) ? b : a));
    if (best.status === 'pass') passed.push(question.id);
  }
  return { answered, passed, done: questions.length > 0 && answered.length === questions.length && passed.length === questions.length };
}
