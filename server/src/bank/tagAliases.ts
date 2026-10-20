import { readFile } from 'node:fs/promises';
import { TAG_ALIASES_SCHEMA_VERSION, type TagAliasGroup, type TagAliasRegistry } from '@arena/shared';
import { config } from '../config.js';

/**
 * 标签同义词表的读取口（N-17 的另一半）。读法照 `bank/hide.ts`：同一份 `content/` 目录、
 * 同一个"读不到不炸启动"的姿势，路径同样从 `config.tagsAliasesFile` 来（两档共用：
 * `content/` 在 compose 里是 bind mount，改词表不需要重建镜像，而 `server/**` 是烤进镜像的）。
 *
 * ## 坏掉的形状一律降级成"没有词表"，而不是"半份词表"
 *
 * 三种坏法：文件不存在 / 不是合法 JSON / 形状不对（含 `schemaVersion` 不是这一版认的那个）。
 * 共同处理 = **一声响亮的 warn + 返回空表**，于是归并层整体消失、界面回到 N-17 上半段的样子。
 *
 * 为什么不"跳过坏的那一组、其余照常用"：facet 的 count 会从"同组题数之和"变成"这组里恰好没坏的那几项之和"，
 * 那种数字没人能从界面上看出来，而它看起来是绿的。整体退回不归并至少是一个**可解释**的状态，
 * 而且 `server/test/bank/content.test.ts` 那组闸门会把"读出 0 组"当场判红（静默降级是本仓库最怕的坏法）。
 *
 * warn 只响一次（按消息去重）：这里每次 `/api/bank` 都会读文件，一条坏消息刷满日志会淹掉别的线索。
 */
let lastWarned = '';

function warnOnce(message: string): void {
  if (lastWarned === message) return;
  lastWarned = message;
  console.warn(message);
}

function isGroup(value: unknown): value is TagAliasGroup {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Record<string, unknown>;
  return typeof g.canonical === 'string' && Array.isArray(g.aliases) && g.aliases.every((a) => typeof a === 'string');
}

/** 读词表。默认读 `config.tagsAliasesFile`；测试与脚本可以传别的路径（只有路径可变，判据不变）。 */
export async function loadTagAliases(file: string = config.tagsAliasesFile): Promise<TagAliasGroup[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    warnOnce(`[tags] 读不到 ${file}（${(err as Error).message}）：本轮不做同义归并，标签按题目里的原词分开放`);
    return [];
  }
  let parsed: Partial<TagAliasRegistry> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<TagAliasRegistry>;
  } catch {
    warnOnce(`[tags] ${file} 不是合法 JSON：本轮不做同义归并（题目数据本来也没被改过）`);
    return [];
  }
  if (parsed?.schemaVersion !== TAG_ALIASES_SCHEMA_VERSION) {
    warnOnce(
      `[tags] ${file} 的 schemaVersion=${JSON.stringify(parsed?.schemaVersion)}，这一版只认 ${TAG_ALIASES_SCHEMA_VERSION}：` +
        '本轮不做同义归并（宁可不并，也不要按猜出来的形状并错概念）',
    );
    return [];
  }
  if (!Array.isArray(parsed.groups) || !parsed.groups.every(isGroup)) {
    warnOnce(`[tags] ${file} 读不出 groups[{canonical,aliases[]}]：本轮不做同义归并`);
    return [];
  }
  lastWarned = ''; // 读通了就把上一次的抱怨清掉，换一份坏文件还能再响一次
  return parsed.groups;
}
