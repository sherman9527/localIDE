/**
 * 标签词表的**同义归并层**（N-17 的另一半）。
 *
 * ## 为什么是"读时归并"，而不是清洗题库
 *
 * `content/questions/**` 里的 258 道题一共挂出 900 多种写法（实测数见 `server/test/bank/content.test.ts`
 * 打印的读数），同一个考点常有 2~3 种拼法。要修它，最直觉的做法是改题目的 `tags[]`，但那两条路都堵着：
 * - 红线 C5：已入库的题目是**追加式**的，改动要一次显式清洗批次 + 出处复核；
 * - 机械上更硬：`Question` 是 `.strict()` 的，加字段会连锁打断 loader / ingest / 出题脚本，
 *   而 `scripts/bank/drafts/check_provenance.py` 的指纹覆盖除 id/schemaVersion/ingestedAt 之外的**每个键** ——
 *   改 `tags[]` 等于把所有题目的出处指纹改掉。
 *
 * 所以这一层只做一件事：**词表（canonical + aliases）存在题库之外，读取与聚合时才生效。**
 * 题目文件一个字节都不动，卡片与详情页上的标签徽章也仍然显示原词 —— 那是实话。
 *
 * ## 为什么住在 shared
 *
 * facet 计数（server）、服务端标签筛选（server）、客户端标签筛选（web）是**同一件事的三个读者**。
 * 任何一处自己再写一遍"什么算同一个标签"，两边就会悄悄分叉：症状是"下拉里选它少一道、
 * 直接敲 URL 不少"，而两边的测试都是绿的。所以判据只有这一份，
 * 闸门写在 `server/test/bank/content.test.ts` 的"归并判据只有一份"那条。
 *
 * ## 形状上的两条纪律
 *
 * ① 这里**没有 I/O**（不 import 任何 `node:` 内置模块）：shared 同时被 web 打包与测试直接引用，
 *    读文件是 `server/src/bank/tagAliases.ts` 的职责。
 * ② 归并是**单跳**的：`alias → canonical` 一次查表就返回。词表里如果出现链
 *    （a→b 且 b→c），这一层会停在 b —— 那种形状由闸门判红，不在这里"聪明地"解析，
 *    因为一次解析两跳之后，没人能从界面上看出这个名字为什么是它。
 */

/** 词表文件的 schema 版本。写文件、读文件、判文件都读这一个数，不许各写一个 1。 */
export const TAG_ALIASES_SCHEMA_VERSION = 1;

/**
 * 一组同义写法。`canonical` 可以是题库里已有的标签（常态），
 * 也可以是只通过归并才出现的**新拼法** —— 那种情况必须在 `reason` 里说清为什么要另起一个名字。
 */
export interface TagAliasGroup {
  canonical: string;
  aliases: string[];
  /** 一行说清"这几个写法为什么是同一件事"。闸门要求非空；不确定的组合就不该进词表。 */
  reason?: string;
}

/** `content/tags-aliases.json` 的形状。 */
export interface TagAliasRegistry {
  schemaVersion: number;
  groups: TagAliasGroup[];
}

/** 对外响应里带出的最小形状：给客户端做筛选用的判据输入（`reason` 是给人读的，不进响应）。 */
export interface TagAliasGroupPublic {
  canonical: string;
  aliases: string[];
}

/** alias（小写）→ canonical。查表键一律小写：服务端历史上就是大小写不敏感匹配的。 */
export function buildTagAliasMap(groups: readonly TagAliasGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const alias of group.aliases ?? []) {
      // 单跳：不做链式解析（链由 content.test.ts 那组闸门拦掉）
      map.set(alias.toLowerCase(), group.canonical);
    }
  }
  return map;
}

/**
 * 一个标签在这个词表下的规范名。**未登记就原样返回**（包括大小写）：
 * facet 的名字必须是题目里存的那个原词，归并层不许顺手改写没被登记的写法。
 */
export function canonicalTag(tag: string, map: ReadonlyMap<string, string>): string {
  return map.get(tag.toLowerCase()) ?? tag;
}

/**
 * facet 计数：每道题对它**涉及的每个规范名**贡献 1。
 *
 * 两条口径同时钉在这里，因为它们是最容易被"顺手改错"的两件事：
 * - **同组写法求和**：`window-function` 的题要算进 `window-functions`，否则归并没有意义；
 * - **一题只数一次**：一道题同时挂了 `data-quality` 与 `dqc`（真题里 sql-mysql-0019 就是这样）时，
 *   数成 2 会把"这道题被几个人问过"变成"这种拼法出现过几次"。
 */
export function countQuestionsByCanonicalTag(
  tagLists: Iterable<readonly string[]>,
  map: ReadonlyMap<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tags of tagLists) {
    for (const tag of new Set(tags.map((t) => canonicalTag(t, map)))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 这道题算不算"带了这个标签"。服务端 `?tag=` 与题库页的客户端筛选都调它。
 *
 * 语义：**同一个组内的任何写法互相命中** —— 请求 canonical 能筛到只写 alias 的题，
 * 请求 alias 也能筛到只写 canonical 的题（下拉里已经看不到 alias 了，但手敲 URL 与历史链接不能失效）。
 * 词表为空时退化成"小写精确匹配"，与归并层存在之前的服务端行为逐字一致。
 */
export function tagMatches(
  rawTags: readonly string[],
  requestedTag: string,
  map: ReadonlyMap<string, string>,
): boolean {
  const needle = canonicalTag(requestedTag.toLowerCase(), map);
  return rawTags.some((tag) => canonicalTag(tag.toLowerCase(), map) === needle);
}

/** 词表 → 响应里给客户端的那份最小形状。 */
export function publicTagAliasGroups(groups: readonly TagAliasGroup[]): TagAliasGroupPublic[] {
  return groups.map((g) => ({ canonical: g.canonical, aliases: [...(g.aliases ?? [])] }));
}

/**
 * 时代标记前缀（N-17 第二次量出来的那一族）。
 *
 * `modern:` 标的是"这个考点在 2025-2026 又新了一遍"，**不是另一个考点**。仓库自己的另外两条读路径
 * 早就这么认了：`scripts/bank/kit.mjs` 的覆盖判定对 `x:tag` 做后缀匹配，`scripts/kb/compile-knowledge.mjs`
 * 直接剥 `modern:` —— 只有 facet 这一条不认，于是 `privacy-engineering`(2) 与 `modern:privacy-engineering`(10)
 * 被拆成两个下拉项，各自都不到门槛。
 *
 * 只列 `modern:`。`classic:` 今天题库里**一个都没有**（那个 `classic:true` 是测试夹具里的形状），
 * 语义上也不是同义词标记 —— 加进来就是"为了对称猜一条规则"，等真出现再说。
 */
export const TAG_ERA_PREFIXES = ['modern:'] as const;

/** 时代折叠的结果：补完的组，以及**这一轮实际折了哪些**（给闸门与界面说实话用）。 */
export interface EraFoldResult {
  groups: TagAliasGroup[];
  folded: TagAliasGroupPublic[];
}

/**
 * 把 `modern:x` 折进 `x`，**只在该裸形真的存在于题库时**。
 *
 * 为什么是条件式而不是一律剥前缀：全库 172 个 `modern:` 标签里只有 21 个有裸形同伴，
 * 一律剥会把另外 151 个 facet 的**名字**改掉（`modern:iceberg-v3` → `iceberg-v3`）却什么也没合并 ——
 * 那是拿用户看得见的标签去换一个不变的数字。
 *
 * 折出来的组与手写的词表走同一张表、同一个 `canonicalTag`，所以三条读路径（facet 求和、服务端筛选、
 * 客户端筛选）自动同源。词表已经管过的写法**不越权改写**（手写的裁决优先）。
 */
export function foldEraTagGroups(groups: readonly TagAliasGroup[], tagsPresent: Iterable<string>): EraFoldResult {
  const present = new Set<string>();
  for (const t of tagsPresent) present.add(t.toLowerCase());
  const base = buildTagAliasMap(groups);
  /** canonical（小写）→ 词表里那组真正用的规范名：折出来的组要挂到同一个名字上。 */
  const canonicalByLower = new Map<string, string>();
  for (const g of groups) canonicalByLower.set(g.canonical.toLowerCase(), g.canonical);

  const byTarget = new Map<string, string[]>();
  for (const raw of present) {
    const prefix = TAG_ERA_PREFIXES.find((x) => raw.startsWith(x));
    if (!prefix) continue;
    const bare = raw.slice(prefix.length);
    if (!bare || !present.has(bare)) continue;
    if (base.has(raw)) continue;
    const canonical = canonicalByLower.get(bare) ?? bare;
    if (canonical === raw) continue;
    const bucket = byTarget.get(canonical);
    if (bucket) bucket.push(raw);
    else byTarget.set(canonical, [raw]);
  }

  const extra: TagAliasGroup[] = [];
  const folded: TagAliasGroupPublic[] = [];
  for (const [canonical, aliases] of [...byTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = aliases.sort();
    extra.push({
      canonical,
      aliases: sorted,
      reason: `时代标记折叠：\`modern:\` 标的是"${canonical}"这个考点在 2025-2026 又新了一遍，不是另一个考点（规则见 shared/src/tagVocabulary.ts 的 TAG_ERA_PREFIXES）`,
    });
    folded.push({ canonical, aliases: sorted });
  }
  return { groups: [...groups, ...extra], folded };
}
