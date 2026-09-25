/**
 * 按 "日期 + 类别" 做确定性选题：不依赖数据库也能保证同一天题目稳定。
 */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** FNV-1a 32 位：把 `date|category` 折成种子。 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 先按 id 排序再洗牌，保证候选池的文件读取顺序不影响当天题目。
 */
export function shuffleWithSeed<T extends { id: string }>(items: readonly T[], seedText: string): T[] {
  const out = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32(hashSeed(seedText));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export interface Pickable {
  id: string;
  category: string;
}

export function pickForDay<T extends Pickable>(
  pool: readonly T[],
  date: string,
  category: string,
  count: number,
): T[] {
  if (!isValidDate(date)) {
    throw new Error(`invalid date "${date}"，需要 YYYY-MM-DD`);
  }
  if (count <= 0) return [];
  const candidates = pool.filter((q) => q.category === category);
  return shuffleWithSeed(candidates, `${date}|${category}`).slice(0, count);
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 用于 streak 的"上一个自然日"。 */
export function previousDay(date: string): string {
  if (!isValidDate(date)) throw new Error(`invalid date "${date}"，需要 YYYY-MM-DD`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d - 1));
  return probe.toISOString().slice(0, 10);
}

/** 复习排期用：按 UTC 日历日推进（不用本地时区，避免跨夏令时把"明天"算成今天）。 */
export function addDays(date: string, delta: number): string {
  if (!isValidDate(date)) throw new Error(`invalid date "${date}"，需要 YYYY-MM-DD`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  if (!isValidDate(from) || !isValidDate(to)) throw new Error('daysBetween 需要 YYYY-MM-DD');
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
