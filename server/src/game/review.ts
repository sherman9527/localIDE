import {
  addDays,
  daysBetween,
  isValidDate,
  REVIEW_LADDER,
  REVIEW_TOP_STEP,
  type ReviewBook,
  type ReviewEntry,
} from '@arena/shared';
import { asSettingsStore } from '../db/index.js';
import type { AttemptRow, ProgressStore } from '../ports.js';

/**
 * 复习排期（WI-41）：SM-2 的二值退化。
 * 完整 SM-2 要一个 0-5 的"回忆质量"评分，本系统只有 pass/fail 与用时，所以
 * pass 升一档、fail 跌回第一档，且要"这次 pass 且上次也 pass"才升 —— 少一次侥幸做对的运气。
 * 这里全是纯函数：读写 settings 的脏活留给 store 层，跨天行为才测得动。
 */

export type { ReviewBook, ReviewEntry };

export const REVIEW_KEY = 'review:book';

const TOP_INDEX = REVIEW_LADDER.length - 1;

function stepFor(reps: number): number {
  return REVIEW_LADDER[Math.max(0, Math.min(reps, TOP_INDEX))] ?? REVIEW_TOP_STEP;
}

/** 不在册且这次做对 → 不入本（复习只服务"错过的题"）。 */
export function advanceEntry(
  entry: ReviewEntry | undefined,
  opts: { passed: boolean; today: string },
): ReviewEntry | null {
  const { passed, today } = opts;
  if (!entry) {
    return passed ? null : { reps: 0, due: addDays(today, 1), last: 'fail', lastDay: today };
  }
  if (!passed) {
    return { reps: 0, due: addDays(today, stepFor(0)), last: 'fail', lastDay: today };
  }
  const reps = entry.last === 'pass' ? Math.min(entry.reps + 1, TOP_INDEX) : entry.reps;
  return { reps, due: addDays(today, stepFor(reps)), last: 'pass', lastDay: today };
}

export function recordAttempt(
  book: ReviewBook,
  opts: { questionId: string; passed: boolean; today: string },
): ReviewBook {
  const next = advanceEntry(book.entries[opts.questionId], opts);
  const entries = { ...book.entries };
  if (next) entries[opts.questionId] = next;
  else delete entries[opts.questionId];
  return { ...book, entries };
}

/** 到期判定含"今天"；先按到期日、再按 id 排，保证同一天两次调用拿到同一份顺序。 */
export function dueIds(book: ReviewBook, today: string): string[] {
  return Object.entries(book.entries)
    .filter(([, entry]) => entry.due <= today)
    .sort(([idA, a], [idB, b]) =>
      a.due < b.due ? -1 : a.due > b.due ? 1 : idA < idB ? -1 : idA > idB ? 1 : 0,
    )
    .map(([id]) => id);
}

export function bookStats(book: ReviewBook, today: string): { tracked: number; dueToday: number; oldestDays: number | null } {
  const entries = Object.values(book.entries);
  let oldest: number | null = null;
  for (const entry of entries) {
    const idle = daysBetween(entry.lastDay, today);
    if (oldest === null || idle > oldest) oldest = idle;
  }
  return { tracked: entries.length, dueToday: entries.filter((e) => e.due <= today).length, oldestDays: oldest };
}

const isEntry = (value: unknown): value is ReviewEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.reps === 'number' &&
    Number.isInteger(v.reps) &&
    v.reps >= 0 &&
    typeof v.last === 'string' &&
    (v.last === 'pass' || v.last === 'fail') &&
    typeof v.due === 'string' &&
    isValidDate(v.due) &&
    typeof v.lastDay === 'string' &&
    isValidDate(v.lastDay)
  );
};

/** 存量数据坏掉时退回空本，而不是把整个游戏层带崩（settings 里可能是任何形状）。 */
export function parseBook(raw: string | null | undefined): ReviewBook {
  const empty: ReviewBook = { entries: {} };
  if (!raw || !raw.trim()) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const source = (parsed as { entries?: unknown }).entries;
  if (typeof source !== 'object' || source === null) return empty;
  const entries: Record<string, ReviewEntry> = {};
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (!isEntry(value)) continue;
    entries[id] = { reps: value.reps, due: value.due, last: value.last, lastDay: value.lastDay };
  }
  const seededAt = (parsed as { seededAt?: unknown }).seededAt;
  return typeof seededAt === 'string' ? { seededAt, entries } : { entries };
}

export function serializeBook(book: ReviewBook): string {
  return JSON.stringify(book);
}

/**
 * 老数据不该白记：把"最近一次真判过的作答没通过"的题一次性请进复习本。
 * `needs_human` 是评分链故障（没人判过），跳过它继续往前看 —— 一次降级不该抹掉"你确实错过"的事实。
 * 到期日排在最近一次作答的第二天：早就该复习了，不该从今天再等一档。
 */
export function seedBook(attempts: readonly AttemptRow[], today: string, seededAt?: string): ReviewBook {
  const latest = new Map<string, AttemptRow>();
  for (const row of attempts) {
    if (row.status === 'needs_human') continue;
    const seen = latest.get(row.questionId);
    if (!seen || row.day > seen.day || (row.day === seen.day && row.createdAt >= seen.createdAt)) {
      latest.set(row.questionId, row);
    }
  }
  const entries: Record<string, ReviewEntry> = {};
  for (const [id, row] of [...latest].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (row.status === 'pass') continue;
    const lastDay = isValidDate(row.day) ? row.day : today;
    entries[id] = { reps: 0, due: addDays(lastDay, stepFor(0)), last: 'fail', lastDay };
  }
  return { seededAt: seededAt ?? new Date().toISOString(), entries };
}

/**
 * 读复习本。settings 里还没有这个键时，先从历史 attempts 回填一次 ——
 * 老数据不该白记（今天之前错过的题，今天就该出现在复习位上）。
 * 回填只在"键不存在"时发生一次，之后以本为准（空本也算回填过，不会每次重算）。
 */
export async function loadBook(store: ProgressStore, today: string): Promise<ReviewBook> {
  const settings = asSettingsStore(store);
  if (!settings) return { entries: {} };
  const raw = await settings.getSetting(REVIEW_KEY).catch(() => null);
  if (raw) return parseBook(raw);
  const seeded = seedBook(await store.allAttempts().catch(() => []), today);
  await settings.setSetting(REVIEW_KEY, serializeBook(seeded)).catch(() => undefined);
  return seeded;
}

/**
 * 判分/评分之后更新排期。store 不支持 settings 时静默返回 null ——
 * 复习是加分项，绝不能把它变成判分主流程的故障点。
 */
export async function applyAttempt(
  store: ProgressStore,
  opts: { questionId: string; passed: boolean; today: string },
): Promise<ReviewBook | null> {
  const settings = asSettingsStore(store);
  if (!settings) return null;
  const next = recordAttempt(await loadBook(store, opts.today), opts);
  await settings.setSetting(REVIEW_KEY, serializeBook(next)).catch(() => undefined);
  return next;
}
