import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';

export interface HiddenItem {
  id: string;
  at: string;
  reason?: string;
}

export interface HiddenFile {
  version: 1;
  items: HiddenItem[];
  /** 文件读得出内容却认不出条目时的原样备份路径；此时禁止再往回写，否则会清空软删除账本 */
  unreadable?: string;
}

const EMPTY: HiddenFile = { version: 1, items: [] };

async function preserve(file: string, raw: string, why: string): Promise<string> {
  const backup = `${file}.corrupt-${Date.now()}`;
  await writeFile(backup, raw, 'utf8').catch(() => {});
  console.warn(`[bank] ${file} ${why}；原内容已留证到 ${backup}`);
  return backup;
}

export async function loadHidden(file: string = config.hiddenFile): Promise<HiddenFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { ...EMPTY, items: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HiddenFile>;
    const rawItems = Array.isArray(parsed.items) ? parsed.items : null;
    // 判"是不是空账本"要看**形状**，不能拿字符串比：saveHidden 写的是带缩进的多行 JSON，
    // 而按紧凑字面量比对会让每个"恢复完最后一题"的账本都被误判成损坏 ——
    // 后果是每读一次留一个 .corrupt 备份，之后 hide/unhide 全部抛错（移除按钮直接坏掉）。
    if (rawItems) {
      const items = rawItems.filter((i): i is HiddenItem => typeof i?.id === 'string');
      if (items.length === rawItems.length) return { version: 1, items };
      // items 是数组但有条目认不出来：照原样留着，别让下一次写把它抹掉
      const backup = await preserve(file, raw, `有 ${rawItems.length - items.length} 条软删除记录认不出 id`);
      return { version: 1, items: [], unreadable: backup };
    }
    if (!raw.trim()) return { version: 1, items: [] }; // 空文件 = 还没有账本
    const backup = await preserve(file, raw, '是合法 JSON 但读不出软删除条目（期望 {"version":1,"items":[{"id":...}]}）');
    return { version: 1, items: [], unreadable: backup };
  } catch {
    // 内容损坏时不炸启动，但一定要留下证据，并且不让后续写覆盖掉它
    const backup = await preserve(file, raw, '不是合法 JSON');
    return { version: 1, items: [], unreadable: backup };
  }
}

/** 账本读不懂时拒绝改写 —— 静默覆盖等于把"已移除的题目"全部复活。 */
function assertWritable(data: HiddenFile, file: string): void {
  if (data.unreadable) {
    throw new Error(`拒绝写入 ${file}：现有内容读不出条目（备份在 ${data.unreadable}）。请先人工修好该文件再操作。`);
  }
}

/** 原子写：先写 tmp 再 rename，避免并发判题/刷新时读到半个文件。 */
async function saveHidden(file: string, data: HiddenFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export interface HideOptions {
  file?: string;
  reason?: string;
  now?: () => Date;
}

export async function hide(id: string, opts: HideOptions = {}): Promise<HiddenFile> {
  const file = opts.file ?? config.hiddenFile;
  const data = await loadHidden(file);
  assertWritable(data, file);
  if (data.items.some((i) => i.id === id)) return data;
  const item: HiddenItem = { id, at: (opts.now ?? (() => new Date()))().toISOString() };
  if (opts.reason) item.reason = opts.reason;
  const next = { version: 1 as const, items: [...data.items, item] };
  await saveHidden(file, next);
  return next;
}

export async function unhide(id: string, opts: { file?: string } = {}): Promise<HiddenFile> {
  const file = opts.file ?? config.hiddenFile;
  const data = await loadHidden(file);
  assertWritable(data, file);
  const next = { version: 1 as const, items: data.items.filter((i) => i.id !== id) };
  if (next.items.length === data.items.length) return data;
  await saveHidden(file, next);
  return next;
}

export async function hiddenIds(file: string = config.hiddenFile): Promise<Set<string>> {
  const data = await loadHidden(file);
  return new Set(data.items.map((i) => i.id));
}

