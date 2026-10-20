import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TAG_ALIASES_SCHEMA_VERSION,
  buildTagAliasMap,
  canonicalTag,
  countQuestionsByCanonicalTag,
  foldEraTagGroups,
  TAG_ERA_PREFIXES,
  tagMatches,
  type TagAliasGroup,
} from '../src/tagVocabulary.js';

/**
 * N-17 的另一半：标签词表的**同义归并**层（纯函数，无 I/O）。
 *
 * 为什么这层必须住在 shared：服务端算 facet、服务端筛标签、客户端筛标签是**同一件事的三个读者**。
 * 任何一处自己写一遍"怎么算同一个标签",两边就会悄悄分叉（本仓库反复撞过的那条"一个真相"）。
 * 所以这个文件里同时钉住：
 * ① 归并语义（alias → canonical 单跳、未命中即原样）；
 * ② facet 计数口径（同组写法求和，但**一道题只数一次**）；
 * ③ 筛选语义（服务端与客户端必须逐字一致）；
 * ④ shared 不许自己碰磁盘（读文件是 server 那一侧的事）。
 */

const GROUPS: TagAliasGroup[] = [
  { canonical: 'window-functions', aliases: ['window-function'], reason: '单复数两种写法' },
  { canonical: 'data-quality', aliases: ['dqc'], reason: '缩写与全称' },
  { canonical: 'llm-gateway', aliases: ['inference-gateway'], reason: '同一层网关的两种叫法' },
];

describe('buildTagAliasMap / canonicalTag', () => {
  it('把每条 alias 指回 canonical，未登记的标签原样返回（身份映射）', () => {
    const map = buildTagAliasMap(GROUPS);
    expect(canonicalTag('window-function', map)).toBe('window-functions');
    expect(canonicalTag('dqc', map)).toBe('data-quality');
    expect(canonicalTag('backpressure', map)).toBe('backpressure');
    expect(canonicalTag('window-functions', map)).toBe('window-functions');
  });

  it('查表大小写不敏感（服务端历史行为就是 lowercase），返回值保留词表里的写法', () => {
    const map = buildTagAliasMap(GROUPS);
    expect(canonicalTag('DQC', map)).toBe('data-quality');
    expect(canonicalTag('Window-Function', map)).toBe('window-functions');
    // 未命中时**不许**顺手改写大小写：facet 的名字必须是题目里存的那个原词
    expect(canonicalTag('BackPressure', map)).toBe('BackPressure');
  });

  it('只做单跳：链式登记（a→b 且 b→c）不会在这里被解析成 c —— 那种形状由闸门拦掉', () => {
    const map = buildTagAliasMap([
      { canonical: 'b', aliases: ['a'] },
      { canonical: 'c', aliases: ['b'] },
    ]);
    expect(canonicalTag('a', map)).toBe('b');
  });

  it('空词表 ⇒ 一切原样（没有 content/tags-aliases.json 时功能必须照常）', () => {
    const map = buildTagAliasMap([]);
    expect(map.size).toBe(0);
    expect(canonicalTag('dqc', map)).toBe('dqc');
  });

  it('词表版本号是 shared 里的一个数，文件与闸门都读它（两边不许各写一个 1）', () => {
    expect(TAG_ALIASES_SCHEMA_VERSION).toBe(1);
  });
});

describe('countQuestionsByCanonicalTag（facet 计数的唯一口径）', () => {
  it('同组写法的题数**求和**，这就是"归并真的在归并"的读数', () => {
    const map = buildTagAliasMap(GROUPS);
    const counts = countQuestionsByCanonicalTag(
      [['window-function'], ['window-functions'], ['window-functions'], ['backpressure']],
      map,
    );
    expect(counts.get('window-functions'), '2 道写 window-functions + 1 道写 window-function').toBe(3);
    expect(counts.get('backpressure')).toBe(1);
    expect(counts.has('window-function'), 'alias 不再单独成为一个 facet').toBe(false);
  });

  it('一道题同时挂了同组的两种写法时**只数一次**（否则"题数"会被拼法虚增）', () => {
    const map = buildTagAliasMap(GROUPS);
    const counts = countQuestionsByCanonicalTag([['data-quality', 'dqc'], ['dqc']], map);
    expect(counts.get('data-quality'), '真题里 sql-mysql-0019 就是这个形状：两种写法同题共挂').toBe(2);
    expect(counts.size).toBe(1);
  });

  it('同一道题内重复的同一个标签也只数一次（题库闸门另有"标签不许重复"的判据，这里不靠它）', () => {
    const map = buildTagAliasMap([]);
    expect(countQuestionsByCanonicalTag([['a', 'a']], map).get('a')).toBe(1);
  });
});

describe('tagMatches（服务端与客户端共用的筛选判据）', () => {
  const map = buildTagAliasMap(GROUPS);

  it('按 canonical 筛，能筛到只写了 alias 的题', () => {
    expect(tagMatches(['window-function'], 'window-functions', map)).toBe(true);
  });

  it('按 alias 筛，也能筛到只写了 canonical 的题（同一个概念不该因为选了哪个名字而少一半）', () => {
    expect(tagMatches(['window-functions'], 'window-function', map)).toBe(true);
  });

  it('跨组不串：没登记的标签还是精确（大小写不敏感）匹配', () => {
    expect(tagMatches(['backpressure'], 'BackPressure', map)).toBe(true);
    expect(tagMatches(['backpressure'], 'pressure', map)).toBe(false);
    expect(tagMatches(['inference-gateway'], 'data-quality', map)).toBe(false);
  });

  it('空词表时退化成"原样比较"，与归并层存在前的行为逐字一致', () => {
    const empty = buildTagAliasMap([]);
    expect(tagMatches(['dqc'], 'data-quality', empty)).toBe(false);
    expect(tagMatches(['dqc'], 'DQC', empty)).toBe(true);
  });

  it('词表里没有的标签不会因为大小写差异被并进来（归并只认词表登记的那一条路）', () => {
    expect(tagMatches(['Window-Functions'], 'window-functions', map)).toBe(true);
    expect(canonicalTag('window-functions', map)).toBe('window-functions');
  });
});

describe('这一层的形状（shared 是三方共用的，形状本身就是判据）', () => {
  it('shared 不许自己碰磁盘：读文件是 server 侧的事，否则 web 打包会把它一起拖进去', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/tagVocabulary.ts', import.meta.url)), 'utf8');
    expect(src, 'tagVocabulary.ts 里出现了 node: 内置模块导入').not.toMatch(/from\s+'node:/);
    expect(src, 'tagVocabulary.ts 里出现了读文件的动作').not.toMatch(/readFileSync\s*\(|createReadStream\s*\(/);
  });
});


describe('foldEraTagGroups（时代标记折叠：modern:x 折进 x，但只在裸形真的存在时）', () => {
  it('裸形存在才折：modern:x 进 x 的组；没有裸形同伴的 modern:y **一个字都不改**', () => {
    const { groups, folded } = foldEraTagGroups([], ['privacy-engineering', 'modern:privacy-engineering', 'modern:iceberg-v3']);
    expect(folded.map((f) => f.canonical), '只有有裸形同伴的那条该被折').toEqual(['privacy-engineering']);
    expect(folded[0]?.aliases, '上一条已经断言只折出一条；这里用 ?. 让"根本没折到"也照样红').toEqual(['modern:privacy-engineering']);
    const map = buildTagAliasMap(groups);
    expect(canonicalTag('modern:iceberg-v3', map), '一律剥前缀会把 151 个 facet 的名字改掉却什么也没合并 —— 这条钉住"不做成那样"').toBe('modern:iceberg-v3');
  });

  it('手写词表优先：已经登记过的写法不被折叠改写，折出来的组挂到手写的那个 canonical 上', () => {
    const registry: TagAliasGroup[] = [{ canonical: 'window-functions', aliases: ['window-function', 'modern:window-functions'], reason: '手写裁决' }];
    const { groups, folded } = foldEraTagGroups(registry, ['window-functions', 'modern:window-functions']);
    expect(folded, '这条写法词表已经管过，折叠不越权').toEqual([]);
    const map = buildTagAliasMap(groups);
    expect(canonicalTag('modern:window-functions', map)).toBe('window-functions');
  });

  it('折出来的组挂在既有的 canonical 上（裸形自己也是某个组的规范名时不另起名字）', () => {
    const registry: TagAliasGroup[] = [{ canonical: 'llm-gateway', aliases: ['inference-gateway'], reason: '同义' }];
    const { groups, folded } = foldEraTagGroups(registry, ['llm-gateway', 'modern:llm-gateway']);
    expect(folded.map((f) => f.canonical)).toEqual(['llm-gateway']);
    const map = buildTagAliasMap(groups);
    // 三种写法互相命中同一个概念：手写的 alias、裸形、时代前缀形
    expect(tagMatches(['modern:llm-gateway'], 'inference-gateway', map), '跨两条归并路径还该是同一个筛选项').toBe(true);
  });

  it('只认 modern: 这一个前缀；classic: 与其它带冒号的前缀一律不折', () => {
    expect(TAG_ERA_PREFIXES).toEqual(['modern:']);
    const { folded } = foldEraTagGroups([], ['company:airbnb', 'airbnb', 'classic:foo', 'foo']);
    expect(folded, '非时代前缀不是同义词标记，折了就是猜').toEqual([]);
  });

  it('大小写与排序稳定：同一批标签折两次结果逐字相等（响应要进客户端缓存，顺序不该漂）', () => {
    const tags = ['Modern:Beta', 'beta', 'Modern:Alpha', 'alpha'];
    const a = foldEraTagGroups([], tags);
    const b = foldEraTagGroups([], [...tags].reverse());
    expect(JSON.stringify(b.folded)).toEqual(JSON.stringify(a.folded));
  });
});
