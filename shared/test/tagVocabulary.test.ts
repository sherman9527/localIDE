import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TAG_ALIASES_SCHEMA_VERSION,
  TAG_ERA_PREFIXES,
  TAG_META_PREFIXES,
  TAG_SHAPE_PATTERN,
  buildTagAliasMap,
  canonicalTag,
  classifyOrphanTag,
  countQuestionsByCanonicalTag,
  foldEraTagGroups,
  isMetaOrphanTag,
  isTagShaped,
  tagCoverageHit,
  tagMatches,
  type OrphanTagRole,
  type TagAliasGroup,
} from '../src/tagVocabulary.js';
import { QUESTION_COMPANIES } from '../src/taxonomy.js';

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

/**
 * N-11 的第一发：`INDEX.md` 那个"脱钩标签 N 个"里混着两类完全不同的东西 ——
 * 元标签（`modern:` 时代标记、`company:` 出处标记、纯公司名）本来就不该有考点行，
 * 而考点缺口才是"该补一行矩阵"的那个数。把它们混在一起报，N 就被元标签撑到失真
 * （实测 frontend/algorithms/sql 三类是 92/245/216，其中元标签 18/40/39）。
 * 归类规则因此**必须只有一份**，且用的是 shared 已有的那两张表（`TAG_ERA_PREFIXES`、
 * `QUESTION_COMPANIES`），不许报告侧再抄一个 `['modern:','classic:']` —— 那正是本仓库反复付账的"第四份字面量"。
 */
describe('classifyOrphanTag（元标签 vs 考点缺口：报告口径的唯一判据）', () => {
  it('时代前缀 ⇒ era-meta，且用的是 TAG_ERA_PREFIXES 那一份而不是本地抄一份', () => {
    expect(classifyOrphanTag('modern:react19-actions')).toBe('era-meta');
    for (const prefix of TAG_ERA_PREFIXES) {
      expect(classifyOrphanTag(`${prefix}anything`), `${prefix} 不在时代前缀表里却被折了/被认了`).toBe('era-meta');
    }
  });

  it('company: 前缀 ⇒ company-meta（前缀表也只有一份）', () => {
    expect(TAG_META_PREFIXES).toContain('company:');
    expect(classifyOrphanTag('company:airbnb')).toBe('company-meta');
    expect(classifyOrphanTag('COMPANY:APPLE')).toBe('company-meta');
  });

  it('整个标签就是一个已知公司名 ⇒ company-name-meta；公司名来自 QUESTION_COMPANIES', () => {
    expect(QUESTION_COMPANIES.length, '公司清单空了 ⇒ 这一路判据在空转').toBeGreaterThan(0);
    for (const company of QUESTION_COMPANIES) {
      expect(classifyOrphanTag(company.toLowerCase()), `${company} 没被认成公司名元标签 ⇒ 题库侧与报告侧的公司清单又分叉了`).toBe('company-name-meta');
      expect(classifyOrphanTag(company), `${company}（原样大小写）该同样命中`).toBe('company-name-meta');
    }
  });

  it('其余一律 point-gap —— 这才是"该补一行考点"的可行动数', () => {
    expect(classifyOrphanTag('race-condition')).toBe('point-gap');
    expect(classifyOrphanTag('llm-inference')).toBe('point-gap');
    // 公司名只是**前缀**的场景不是元标签：airbnb-search-ranking 是一条考点，少一个字都不算
    expect(classifyOrphanTag('airbnb-search-ranking')).toBe('point-gap');
    // 带冒号的未知前缀不许被顺手归进元标签（那会把真缺口藏起来）
    expect(classifyOrphanTag('vendor:whatever')).toBe('point-gap');
  });

  it('规则可注入（闸门要能证"换一张表结论就变"，而不是信一份硬编码副本）', () => {
    const injected = { eraPrefixes: ['era2:'], metaPrefixes: [], companies: ['Zeta'] };
    expect(classifyOrphanTag('modern:x', injected)).toBe('point-gap');
    expect(classifyOrphanTag('era2:x', injected)).toBe('era-meta');
    expect(classifyOrphanTag('company:airbnb', injected)).toBe('point-gap');
    expect(classifyOrphanTag('zeta', injected)).toBe('company-name-meta');
  });

  it('元标签与考点缺口互斥且覆盖全部（isMetaOrphanTag 就是它的补集）', () => {
    const samples = ['modern:x', 'company:x', 'airbnb', 'plain-gap', 'classic:x'];
    const roles: OrphanTagRole[] = ['era-meta', 'company-meta', 'company-name-meta', 'point-gap'];
    for (const s of samples) {
      const role = classifyOrphanTag(s);
      expect(roles, `${s} 归到了名单外的类别 ${role}（报告那侧就会漏计）`).toContain(role);
      expect(isMetaOrphanTag(s), `${s}：isMetaOrphanTag 与 classifyOrphanTag 说的不是同一件事`).toBe(role !== 'point-gap');
    }
    // classic: 今天库里一个都没有（那个 classic:true 是测试夹具的形状），所以它**不是**元标签
    expect(TAG_ERA_PREFIXES).toEqual(['modern:']);
    expect(classifyOrphanTag('classic:x')).toBe('point-gap');
  });

  it('空串与畸形输入不炸、退成 point-gap（报告生成器不许因为一道脏标签整个挂掉）', () => {
    expect(classifyOrphanTag('')).toBe('point-gap');
    expect(classifyOrphanTag('company:')).toBe('company-meta');
  });
});
describe('评审 C1：折叠的目标必须先过 alias 表（真题里 `inference-gateway` 是 `llm-gateway` 组的 alias）', () => {
  it('裸形自己是某个组的 alias 时，`modern:裸形` 要挂到那个组的规范名上，不许造出 a→b→c 的链', () => {
    const registry: TagAliasGroup[] = [{ canonical: 'llm-gateway', aliases: ['inference-gateway'], reason: '同义' }];
    const { groups, folded } = foldEraTagGroups(registry, ['inference-gateway', 'modern:inference-gateway', 'llm-gateway']);
    expect(folded.map((f) => f.canonical), '不能挂到 inference-gateway 上 —— 那是个 alias').toEqual(['llm-gateway']);
    const map = buildTagAliasMap(groups);
    expect(canonicalTag('modern:inference-gateway', map), '一条查表就该到终点，两跳的链没人能从界面上看出来').toBe('llm-gateway');
    // 反面：旧写法（只查 canonicalByLower）会把这一对挂到 alias 上，于是同一考点占两个下拉位
    expect(map.has('inference-gateway'), 'alias 不该被折叠层再登记一次成为规范名').toBe(true);
    expect(map.get('inference-gateway')).toBe('llm-gateway');
  });

  it('某组已经拿 `modern:x` 当规范名时，折叠不越权（评审 C1b：否则会把那一组的手写判决劈成两半）', () => {
    const registry: TagAliasGroup[] = [
      { canonical: 'modern:mysql8-window-functions', aliases: ['modern:mysql8-window'], reason: '同一概念的两种写法，与不带前缀的 window-functions 是两档，永不互并' },
    ];
    const { folded } = foldEraTagGroups(registry, ['modern:mysql8-window-functions', 'mysql8-window-functions']);
    expect(folded, '裸形出现了也不许把这条挂过去 —— 那等于改写手写裁决').toEqual([]);
  });
});

/**
 * N-24 第一半：**标签形状**判据只有这一份。
 *
 * 这条正则原本抄在七处（`content.test.ts` ×2、`knowledge-matrix.test.ts`、`scripts/kb/kit.mjs`、
 * `scripts/bank/kit.mjs`、`generate-with-cli.mjs`、`subjective_gen.py`），其中两处还在注释里自称
 * "同一条正则"而没有任何东西保证 —— 自称而不判，就是"下一次有人只改一处"的账。
 * ⚠ 这里判**行为**不判字面量：把 `^[a-z0-9]…` 再抄一遍进测试就成了第八份抄本，
 * 改一次形状要同时动八个地方，而"漏改一处"的代价从"红"变成"没人发现"。
 * 字面量那一侧的对表在 `server/test/bank/content.test.ts`（Python 那条 import 不动 shared，只能用源码文本比）。
 */
describe('isTagShaped：标签形状判据（N-24）', () => {
  it('接受题库与矩阵里真实存在的那几种形状（含带前缀的写法）', () => {
    for (const t of [
      'window-functions',
      'modern:streaming-aqe',
      'company:airbnb',
      'classic:true',
      'a',
      'ts-strict-compilation',
      'react19-actions',
      'data.quality_v2-x:y1',
      '0',
    ]) {
      expect(isTagShaped(t), `${t} 该是合法形状（题库里就这么写的）`).toBe(true);
    }
  });

  it('拒绝会让整库变红的形状：大写、空格、中文、开头符号、空串', () => {
    for (const t of ['', ' React', 'React Hooks', '中文标签', '-leading', '_leading', ':colon-first', 'has space', 'has/slash', 'tab\tinside']) {
      expect(isTagShaped(t), `${JSON.stringify(t)} 不该被判成合法标签`).toBe(false);
    }
  });

  it('判据不是"看起来宽松"：同一个串的接受/拒绝必须与 TAG_SHAPE_PATTERN 那条正则同源', () => {
    // 这一条防的是"isTagShaped 里另写一份、常量只是摆设"的形状（导出常量却没人用它）
    expect(new RegExp(TAG_SHAPE_PATTERN).source).toBe(TAG_SHAPE_PATTERN);
    for (const t of ['window-functions', 'modern:x', 'React Hooks', '', '-x']) {
      expect(isTagShaped(t), `${JSON.stringify(t)}：isTagShaped 与 TAG_SHAPE_PATTERN 说的不是同一件事`).toBe(new RegExp(TAG_SHAPE_PATTERN).test(t));
    }
  });
});

/**
 * N-24 第二半：**考点覆盖**只认精确与时代前缀，不认任意前缀。
 *
 * 旧实现（`scripts/bank/kit.mjs:116`）用的是 `v.includes(':') && v.endsWith(':' + needle)`，
 * 于是矩阵里一行考点标 `airbnb`，会被题目上的 `company:airbnb`（那是**出处**标记，不是考点）判成"已覆盖"
 * —— 报表里那个覆盖率数字就此在说假话。同一行还留着一条 `modern:${needle}` 死支（被下一行的通用式包含），
 * 而 `modern:` 这个字面量是该表(`TAG_ERA_PREFIXES`)的第四份抄本。
 * 这一族不对称（`modern:` 折、`company:` 不折）在 `classifyOrphanTag` 那侧早就立好了，
 * 覆盖这一侧以前只是没跟上。
 */
describe('tagCoverageHit：考点覆盖只认精确与时代前缀（N-24）', () => {
  it('裸形精确命中算 exact', () => {
    expect(tagCoverageHit('react19-actions', 'react19-actions')).toBe('exact');
    expect(tagCoverageHit('React19-Actions', 'react19-actions'), '匹配是大小写不敏感的（读路径历来如此）').toBe('exact');
  });

  it('`modern:x` 覆盖考点 `x`（时代标记是同一个考点的新写法）', () => {
    expect(tagCoverageHit('modern:streaming-aqe', 'streaming-aqe')).toBe('era');
    expect(tagCoverageHit('MODERN:iceberg-v3', 'iceberg-v3'), '前缀匹配也要大小写不敏感').toBe('era');
  });

  it('反面（这一条就是那个会撒谎的数）：`company:airbnb` 不覆盖考点 `airbnb`', () => {
    expect(tagCoverageHit('company:airbnb', 'airbnb'), '出处标记不是考点 —— 让它算覆盖，INDEX.md 的覆盖率就在说假话').toBeNull();
    expect(tagCoverageHit('company:apple', 'apple')).toBeNull();
    // 任意前缀一律不算：新加一个前缀不会自动获得"算覆盖"的资格（要算得先进 TAG_ERA_PREFIXES）
    expect(tagCoverageHit('whatever:airbnb', 'airbnb')).toBeNull();
    expect(tagCoverageHit('classic:airbnb', 'airbnb'), 'classic: 故意不在表里（题库今天一个都没有）').toBeNull();
  });

  it('时代前缀只剥**一层整段**：`modern:legacy:x` 不覆盖 `x`，但覆盖 `legacy:x`', () => {
    expect(tagCoverageHit('modern:legacy:x', 'x'), '前缀里还藏着别的段就不是纯时代标记').toBeNull();
    expect(tagCoverageHit('modern:legacy:x', 'legacy:x')).toBe('era');
  });

  it('不做子串命中：`x-y` 不覆盖 `x`，`x` 也不覆盖 `y:x`', () => {
    expect(tagCoverageHit('airbnb-search-ranking', 'airbnb'), '公司名 + 考点是一条真考点，但它不等于那个公司名').toBeNull();
    expect(tagCoverageHit('airbnb', 'company:airbnb'), '反方向同样不成立').toBeNull();
  });

  it('前缀表是判据的唯一出处：把表换空，`modern:x` 就不再覆盖 `x`（闸门要能证明这一点）', () => {
    expect(tagCoverageHit('modern:x', 'x', { eraPrefixes: [] })).toBeNull();
    expect(tagCoverageHit('modern:x', 'x', { eraPrefixes: ['modern:'] })).toBe('era');
    expect(TAG_ERA_PREFIXES.length, '时代表空了 ⇒ 上面那条规则注入判据就是空转').toBeGreaterThan(0);
  });

  it('畸形输入不炸（报表生成器不能因为一道脏标签整个挂掉）', () => {
    expect(tagCoverageHit('', 'x')).toBeNull();
    expect(tagCoverageHit('x', '')).toBeNull();
  });
});
