import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QUESTION_COMPANIES, TAG_ERA_PREFIXES, TAG_META_PREFIXES, classifyOrphanTag, isMetaOrphanTag } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * N-11 第一发：`content/knowledge/INDEX.md` 那个"题目 tag 在矩阵里找不到对应考点（脱钩）：N 个"
 * 里混着两类东西 —— **元标签**（`modern:` 时代标记、`company:` 出处标记、纯公司名）本来就不该有考点行，
 * **考点缺口**才是"该补一行矩阵"的可行动数。原来两者一起报，N 被元标签撑到失真
 * （实测 frontend/algorithms/sql = 92/245/216，其中元标签 18/40/39），
 * 于是"下一步出什么题"这份报表一直在催一件不存在的事。
 *
 * 判据走脚本的 `--orphan-audit-json` 这条**只读**缝：它把真实题库 + 真实矩阵算成 JSON，
 * 这里判它的**分区性质**（互斥、全覆盖、数字来自 shared 那三张表）。
 * 为什么不用 `import` 那个 .mjs：`server/tsconfig.test.json` 不收 JS，跨语言 import 会让类型检查
 * 变成"这个文件没人判过"（`typecheck-coverage` 判的那件事）。先例：`bank-baseline.test.ts` 走
 * `--baseline-info`，本仓库的脚本缝就是这个形状。
 * ⚠ 这条缝**绝不写文件**（`--orphan-audit-json` 与 `--print-markdown` 都是只算不写）：
 * `content/` 在容器里是 bind mount，测试要是顺手重新生成了 `INDEX.md`，"报表过期"这个故障
 * 就会被验证过程自己修好 —— 那正是本仓库点名的"闸门被自己的跑法喂绿"。
 */

const SCRIPT = join(config.repoRoot, 'scripts', 'kb', 'compile-knowledge.mjs');

interface AuditPoint {
  tag: string;
  label: string;
  hasExplicitTag: boolean;
  covered: boolean;
  matchedBy: 'explicit' | 'derived' | 'none';
  questionIds: string[];
  /**
   * N-24：命中这一行的**题目标签原词**（去重排序）。报表必须说得出"这一行是靠哪种写法算成已覆盖的"，
   * 否则 `company:airbnb` 混进 `airbnb` 那一行的时候，数字与它的解释会一起变绿。
   */
  hitTags?: string[];
}

interface AuditCategory {
  category: string;
  points: AuditPoint[];
  totalPoints: number;
  explicitPoints: number;
  untrackablePoints: number;
  covered: number;
  uncovered: number;
  /** 没有显式 tag、但被派生 slug 撞上了题目的行 —— "改个中文名就会变"的那批脆弱行 */
  derivedOnly: string[];
  ratio: string;
  orphans: { tag: string; role: string; ids: string[] }[];
  orphanTotal: number;
  /** 写法数（同一个概念的多种拼法，含带时代前缀的那些）—— 与上面的概念数分列。 */  orphanSpellings: number;
  orphanMeta: number;
  orphanPointGaps: number;
}

interface Audit {
  categories: AuditCategory[];
  metaPrefixTruth: string[];
  eraPrefixTruth: string[];
  companyTruth: string[];
}

function runAudit(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: config.repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    env: { ...process.env, ...env },
  });
}

function readAudit(): Audit {
  const r = runAudit(['--orphan-audit-json']);
  expect(r.status, `--orphan-audit-json 退出 ${r.status}：\n${r.stderr}\n${r.stdout.slice(0, 800)}`).toBe(0);
  try {
    return JSON.parse(r.stdout) as Audit;
  } catch (err) {
    throw new Error(`--orphan-audit-json 输出的不是 JSON（${(err as Error).message}）：\n${r.stdout.slice(0, 800)}`);
  }
}

describe('INDEX.md 的元标签 vs 考点缺口分区（N-11 第一发）', () => {
  const audit = readAudit();
  const byCategory = (name: string) => audit.categories.find((c) => c.category === name);

  it('这条缝是只读的：跑它不许改动 INDEX.md，而打错的参数不许退化成"生成并写文件"', () => {
    const file = join(config.repoRoot, 'content', 'knowledge', 'INDEX.md');
    const before = readFileSync(file, 'utf8');
    const again = runAudit(['--orphan-audit-json']);
    expect(again.status, `第二次调用退出 ${again.status}：${again.stderr.slice(0, 400)}`).toBe(0);
    expect(readFileSync(file, 'utf8'), '跑一次审计就把 INDEX.md 重写了 ⇒ "报表过期"会被验证过程自己修好，freshness 那条判据从此空转').toBe(before);
    // 打错一个字母的 flag 必须拒绝：否则它会走默认那条"生成 + 写文件"的路（上面那半句就永远判不到真故障）
    const bogus = runAudit(['--orphan-audit-jsn']);
    expect(bogus.status, '未知参数被忽略并退 0 ⇒ 缝的名字不值钱，打错就变成"整份重新生成并写盘"').not.toBe(0);
    expect(`${bogus.stdout}${bogus.stderr}`, '拒绝未知参数要说出是哪一个，否则排查的人会以为脚本坏了').toMatch(/未知参数：--orphan-audit-jsn/);
    expect(readFileSync(file, 'utf8'), '未知参数那条路居然还是写了文件').toBe(before);
    // 位置参数同样拒绝（`kb:index 别的` 不该悄悄变成"照常生成"）
    const positional = runAudit(['--print']);
    expect(positional.status, '位置参数被吞掉了').not.toBe(0);
    expect(`${positional.stdout}${positional.stderr}`, '报错要点名那个位置参数').toMatch(/未知参数：--?print|"--print"/);
    expect(readFileSync(file, 'utf8'), '拒绝路径上也不许碰文件').toBe(before);
  });

  it('每个类别：元标签 + 考点缺口 = 脱钩总数，且三个分项也自洽（分区不是并列的两句话）', () => {
    for (const c of audit.categories) {
      expect(c.orphanTotal, `${c.category}：orphanTotal 与 orphans[] 长度不一致（分了口径却没落到条目上）`).toBe(c.orphans.length);
      expect(c.orphanMeta + c.orphanPointGaps, `${c.category}：元标签 ${c.orphanMeta} + 考点缺口 ${c.orphanPointGaps} ≠ 脱钩 ${c.orphanTotal}`).toBe(c.orphanTotal);
      const roles = c.orphans.map((o) => o.role);
      expect(roles.filter((x) => x !== 'point-gap').length, `${c.category}：非 point-gap 的条目数与 orphanMeta 对不上`).toBe(c.orphanMeta);
      expect(roles.filter((x) => x === 'point-gap').length, `${c.category}：point-gap 的条目数与 orphanPointGaps 对不上`).toBe(c.orphanPointGaps);
    }
  });

  it('元标签绝不进考点缺口（互斥判据用 @arena/shared 那份真表，不在这里抄副本）', () => {
    const bad: string[] = [];
    for (const c of audit.categories) {
      for (const o of c.orphans) {
        const expected = classifyOrphanTag(o.tag);
        if (o.role !== expected) bad.push(`${c.category}：${o.tag} 报告归成 ${o.role}，shared 的判据说是 ${expected}`);
        if (o.role === 'point-gap' && isMetaOrphanTag(o.tag)) bad.push(`${c.category}：元标签 ${o.tag} 被算进了考点缺口`);
        if (o.role !== 'point-gap' && !isMetaOrphanTag(o.tag)) bad.push(`${c.category}：${o.tag} 不是元标签却被免检了`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('脚本用的是 shared 的那三张表，不是自己抄的字面量（第四份字面量就是这个仓库反复付的账）', () => {
    const src = readScript();
    expect(src, '脚本没有调 shared 的归类判据 ⇒ 报告侧自己写了一套"什么叫元标签"').toMatch(/classifyOrphanTag|isMetaOrphanTag/);
    expect(src, '脚本里还留着写死的 modern: 剥离（那条前缀表只许住在 shared）').not.toMatch(/replace\(\/\^modern:/);
    expect(src, '脚本里不许再写一份公司清单').not.toMatch(/const COMPANIES\s*=/);
    // 缝自己报出来的"它当时用的那三份表"必须与 shared 现在的值相等（它是运行期读出来的，不是注释）
    expect(audit.eraPrefixTruth, '脚本读到的时代前缀与 TAG_ERA_PREFIXES 不一致').toEqual([...TAG_ERA_PREFIXES]);
    expect(audit.metaPrefixTruth, '脚本读到的元标签前缀与 TAG_META_PREFIXES 不一致').toEqual([...TAG_META_PREFIXES]);
    expect(audit.companyTruth, '脚本读到的公司清单与 QUESTION_COMPANIES 不一致').toEqual([...QUESTION_COMPANIES]);
  });

  it('分口径真的在分：概念与写法分列、时代前缀不再当免检理由（评审 I1 改的就是这一条的前提）', () => {
    // 这一条原来判的是"每类元标签 > 0"。I1 之后那个前提没了：**带 `modern:` 的脱钩是穿着标记外衣的真缺口**，
    // 剥完前缀仍然找不到矩阵行，就不该被免检。所以这里改判三件事，每一件都比"元标签 > 0"更难被做假：
    let deduped = 0;
    for (const name of ['frontend', 'algorithms', 'sql', 'hot-interviews']) {
      const c = byCategory(name);
      expect(c, `报表里没有类别 ${name}（CATEGORY_IDS 与脚本读的那份不一致）`).toBeDefined();
      expect(c!.orphanTotal, `${name}：一个脱钩概念都没有 ⇒ 下面两条判据都会空转，先查口径`).toBeGreaterThan(0);
      expect(c!.orphanPointGaps, `${name}：缺口为 0 ⇒ 所有脱钩都被免检了，这条报表就没用了`).toBeGreaterThan(0);
      expect(
        c!.orphanTotal,
        `${name}：概念数(${c!.orphanTotal}) 大于写法数(${c!.orphanSpellings}) ⇒ 去重反了`,
      ).toBeLessThanOrEqual(c!.orphanSpellings);
      if (c!.orphanTotal < c!.orphanSpellings) deduped++;
      // 时代前缀**不是**免检理由：报表里不许有 role=era-meta 的条目（有就说明分类器又按前缀放行了）
      const exempt = c!.orphans.filter((o) => o.role === 'era-meta');
      expect(exempt, `${name}：有脱钩仅因带 \`modern:\` 前缀就被算成元标签 ⇒ 真缺口被藏起来（I1 的病灶）：${exempt.map((o) => o.tag).join(', ')}`).toEqual([]);
    }
    expect(deduped, '没有任何一类出现"多种写法合成一个概念" ⇒ 去重那条路没生效，写法数与概念数会永远相等').toBeGreaterThan(0);
    // 元标签这一桶必须还装着**真元标签**（公司维度），否则"分口径"退化成"全算缺口"
    const companyMeta = audit.categories.flatMap((c) => c.orphans.filter((o) => o.role === 'company-meta' || o.role === 'company-name-meta'));
    expect(companyMeta.length, '一个元标签都没有 ⇒ 分类器可能整个不认了（那 N 又变回失真数）').toBeGreaterThan(0);
    console.log(
      `[脱钩分口径] ${audit.categories.map((c) => `${c.category} 概念 ${c.orphanTotal}/写法 ${c.orphanSpellings}（元 ${c.orphanMeta}/缺口 ${c.orphanPointGaps}）`).join('｜')}
` +
        `  去重生效的类别 ${deduped} 个；真元标签（公司维度）${companyMeta.length} 个：${companyMeta.map((o) => o.tag).join(', ')}`,
    );
  });

  it('hot-interviews 里那两个 company: 标签确实被分到元标签（它们是出处标记，不是考点）', () => {
    const c = byCategory('hot-interviews');
    const companyMeta = c!.orphans.filter((o) => o.role === 'company-meta').map((o) => o.tag);
    expect(companyMeta, 'company:* 没被分到元标签 ⇒ 报表还会催"给矩阵补一行"').toContain('company:airbnb');
    expect(companyMeta, 'company:* 没被分到元标签 ⇒ 报表还会催"给矩阵补一行"').toContain('company:apple');
    // 反面：公司名开头的**考点**不许被顺手免检（`airbnb-search-ranking` 是一条真考点）
    for (const name of QUESTION_COMPANIES) {
      const prefixed = c!.orphans.filter((o) => o.tag.toLowerCase().startsWith(`${name.toLowerCase()}-`));
      for (const o of prefixed) expect(o.role, `${o.tag} 是"公司名 + 考点"的写法，不是元标签`).toBe('point-gap');
    }
  });

  it('派生 slug 命中要单独报出来：那些行"改个中文名"就会悄悄变覆盖（脆弱，不是已判定）', () => {
    for (const c of audit.categories) {
      const derived = c.points.filter((p) => p.matchedBy === 'derived');
      expect(c.derivedOnly.sort(), `${c.category}：derivedOnly 清单与实际命中的行不一致`).toEqual(derived.map((p) => p.tag).sort());
      // 只有**没有显式 tag**的行才可能走派生 slug；显式行永远不该出现在这一档里
      for (const p of derived) expect(p.hasExplicitTag, `${c.category}：带显式 tag 的行被记成"仅派生 slug 命中"（口径坏了）`).toBe(false);
      for (const p of c.points) if (p.hasExplicitTag) expect(p.matchedBy, `${c.category}：显式 tag 的行 ${p.tag} 的 matchedBy 不该是 derived`).not.toBe('derived');
    }
    console.log(`[派生 slug] ${audit.categories.map((c) => `${c.category} ${c.derivedOnly.length}`).join('｜')}`);
  });

  it('覆盖率的口径与显式 tag 的行数自洽（ratio 是 — 当且仅当没有一行可判定）', () => {
    for (const c of audit.categories) {
      expect(c.explicitPoints + c.untrackablePoints, `${c.category}：显式 + 无显式 ≠ 总行数`).toBe(c.totalPoints);
      expect(c.covered + c.uncovered, `${c.category}：已覆盖 + 未覆盖 ≠ 可判定行数`).toBe(c.explicitPoints);
      const expectRatio = c.explicitPoints === 0 ? '—' : `${Math.round((c.covered / c.explicitPoints) * 100)}%`;
      expect(c.ratio, `${c.category}：覆盖率 ${c.ratio} 与按可判定行算出的 ${expectRatio} 不一致`).toBe(expectRatio);
    }
  });
});

/**
 * 真实仓库里 `derivedOnly` 今天全是 0（没 tag 的行第 1 列都是中文，切出来的 slug 撞不到任何题目）。
 * "0 == 0" 看起来像通过，其实什么都判不到 —— 所以这一档单独造一份矩阵，让那条兜底**真的命中一次**，
 * 再看它被记到哪一档。两条用例是一对：少了反面那条，"全 0"与"兜底坏了"在报表里长得一模一样。
 */
describe('仅派生 slug 命中那一档（N-11：为什么"看起来已覆盖"不等于"已判定覆盖"）', () => {
  const MATRIX_HEAD = '| 考点 | senior 深度要点 | 可出题形式 | 建议 judgeKind |\n| --- | --- | --- | --- |\n';

  /** 造一个只有 frontend 一份 README 的临时知识库根（只读缝，脚本不会往里写）。 */
  function fixture(firstCell: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'arena-kb-fixture-'));
    mkdirSync(join(dir, 'frontend'), { recursive: true });
    writeFileSync(join(dir, 'frontend', 'README.md'), `${MATRIX_HEAD}| ${firstCell} | 要点 | code | react-vitest |\n`, 'utf8');
    scratch.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('没有显式 tag 的行被题目命中时 ⇒ 记进 derivedOnly，而不是 covered（改中文名就会换目标的那种命中）', () => {
    // `Data Fetching` 切出来的 slug 是 data-fetching，真题库 fe-react-0001/0002 正好挂着它
    const fe = readAuditAt(fixture('Data Fetching'));
    expect(fe.totalPoints, '夹具那一行没被矩阵解析出来（表头列名对不上？）').toBe(1);
    expect(fe.explicitPoints, '这行没有反引号 tag，不该算显式').toBe(0);
    expect(fe.derivedOnly, '兜底命中了题目却没被记进 derivedOnly ⇒ 报表把"脆命中"报成了"无法判定"').toEqual(['data-fetching']);
    expect(fe.covered, '仅派生 slug 的命中不许混进 covered（那会把覆盖率报成判定过的）').toBe(0);
    expect(fe.ratio, '一个可判定行都没有时覆盖率必须还是 —，不是 0% 也不是 100%').toBe('—');
    expect(fe.points[0]?.matchedBy, '这一行的 matchedBy 该是 derived').toBe('derived');
    expect((fe.points[0]?.questionIds ?? []).length, '夹具命中 0 道题 ⇒ 上面那三条在空转（真题库的 data-fetching 标签变了？）').toBeGreaterThan(0);
  });

  it('反面（对照组）：同一行写成 `中文名（\u0060tag-id\u0060）` ⇒ 换到 explicit/covered，derivedOnly 变空', () => {
    const fe = readAuditAt(fixture('数据获取与竞态（`data-fetching`）'));
    expect(fe.explicitPoints, '写了反引号 tag 却仍被当成无显式 ⇒ 判定读的不是 parsePointCell 那一份').toBe(1);
    expect(fe.derivedOnly, '有显式 tag 的行不该再走派生 slug 那一档').toEqual([]);
    expect(fe.covered, '显式 tag 命中真题库，这条该算已覆盖').toBe(1);
    expect(fe.ratio).toBe('100%');
    expect(fe.points[0]?.tag, '考点 tag 该是反引号里那个，而不是切出来的中文 slug').toBe('data-fetching');
    expect(fe.points[0]?.matchedBy).toBe('explicit');
  });
});

/**
 * N-24：覆盖判定的**不对称性**是设计本身，不是巧合 ——
 * `modern:x` 覆盖考点 `x`（时代标记是同一个考点的新写法），`company:airbnb` 不覆盖考点 `airbnb`
 * （那是出处标记，与"这道题考什么"无关）。旧实现用的是 `v.endsWith(':' + needle)` 那条通用后缀匹配，
 * 于是**任何**前缀都算覆盖：矩阵里出现一行 `airbnb` 时，INDEX.md 会把两道"来自 Airbnb 的题"
 * 报成"覆盖了 airbnb 这个考点"。两侧都要钉住，只钉一侧的话"全禁"与"全都行"都绿。
 *
 * 判据走的是与上面同一个只读缝 + 同一份真题库（夹具只换**矩阵**，题库一个字不动）：
 * 因此红的是"生成器的覆盖判定"，不是测试里那份自己算的口径。
 */
describe('覆盖只认精确与时代前缀（N-24：任意前缀算覆盖 = 报表说谎）', () => {
  /** 真题库 + 真矩阵那一份审计（与上面 describe 同一份口径，这里只是为了取 hot-interviews 的前提）。 */
  const live = readAudit();
  const MATRIX_HEAD = '| 考点 | senior 深度要点 | 可出题形式 | 建议 judgeKind |\n| --- | --- | --- | --- |\n';

  /** 造一份只含指定几行考点的临时知识库根（未列出的类别按"缺 README"处理，不影响要判的那一类）。 */
  function fixtureRows(entries: { category: string; cell: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'arena-kb-prefix-probe-'));
    for (const { category, cell } of entries) {
      mkdirSync(join(dir, category), { recursive: true });
      writeFileSync(join(dir, category, 'README.md'), `${MATRIX_HEAD}| ${cell} | 要点 | rubric | llm-rubric |\n`, 'utf8');
    }
    scratch.push(dir);
    return dir;
  }

  /** 夹具审计退出 0 并取出指定类别那一条（夹具每类只有一行）。 */
  function probeRow(kbDir: string, category: string): AuditCategory {
    const r = runAudit(['--orphan-audit-json'], { ARENA_KB_DIR: kbDir });
    expect(r.status, `夹具审计退出 ${r.status}：\n${r.stderr.slice(0, 600)}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as Audit;
    const c = parsed.categories.find((x) => x.category === category);
    expect(c, `夹具审计里没有 ${category}`).toBeDefined();
    return c!;
  }

  it('反面（那条会说谎的匹配）：`company:airbnb` 不覆盖矩阵里一行考点 `airbnb`', () => {
    // 前提必须先成立：真题库的 hot-interviews 里确实挂着 `company:airbnb`（否则 covered=0 只是"没题"）
    const real = live.categories.find((c) => c.category === 'hot-interviews')!;
    expect(real.orphans.some((o) => o.tag === 'company:airbnb'), '题库里已经没有 company:airbnb 了 ⇒ 这条判据在空转（要换一条真存在的出处标签，不许放宽判据）').toBe(true);

    const probed = probeRow(fixtureRows([{ category: 'hot-interviews', cell: '来源公司高频考点（`airbnb`）' }]), 'hot-interviews');
    expect(probed.explicitPoints, '夹具那一行的反引号 tag 没被认成显式').toBe(1);
    expect(probed.covered, 'covered=1 ⇒ 出处标记 company:airbnb 被当成了考点覆盖（INDEX.md 那个百分比就是说谎的数）').toBe(0);
    expect(probed.points[0]?.hitTags ?? [], '这一行的命中写法清单该是空的').toEqual([]);
    expect(probed.ratio, '一行都没覆盖时覆盖率该是 0%，不是 —（— 的含义是"无法判定"）').toBe('0%');
  });

  it('正面：`modern:react19-actions` 覆盖矩阵里一行考点 `react19-actions`（时代标记是同一个考点）', () => {
    const probed = probeRow(fixtureRows([{ category: 'frontend', cell: 'React 19 Actions 三件套（`react19-actions`）' }]), 'frontend');
    expect(probed.covered, 'covered=0 ⇒ 时代折叠那一半被顺手禁掉了（modern: 就是为它立的表）').toBe(1);
    const hitTags = probed.points[0]?.hitTags ?? [];
    expect(hitTags.length, 'hitTags 没被报出来 ⇒ "靠哪种写法算成已覆盖"这件事报表里读不到').toBeGreaterThan(0);
    for (const t of hitTags) {
      expect(TAG_ERA_PREFIXES.some((p) => t.toLowerCase().startsWith(p.toLowerCase())), `命中写法 ${t} 既不是裸形也不是时代前缀形`).toBe(true);
    }
    console.log(`[覆盖命中写法] react19-actions 这一行靠 ${hitTags.join(', ')} 命中（时代前缀表 = ${[...TAG_ERA_PREFIXES].join('/') || '空'}）`);
  });

  it('真实题库的每一处覆盖命中都在允许集合里（测试自己按 shared 那张表重算一遍）', () => {
    // 这一条不采信生成器的分类：它拿**报出来的原词**按 TAG_ERA_PREFIXES 重新推一遍"该不该算命中"。
    // 上面两条夹具钉的是"换了矩阵就会红"，这一条钉的是"今天真题库的每一处命中都经得起复核"。
    const offenders: string[] = [];
    let prefixedOnlyRows = 0;
    for (const c of live.categories) {
      for (const p of c.points) {
        if (!p.hasExplicitTag || !p.covered) continue;
        expect(p.hitTags, `${c.category}/${p.tag}：覆盖命中却不报命中的写法 ⇒ 这一条在空转`).toBeDefined();
        let hasExact = false;
        for (const t of p.hitTags ?? []) {
          const lower = t.toLowerCase();
          const needle = p.tag.toLowerCase();
          const eraPrefix = TAG_ERA_PREFIXES.find((x) => lower.startsWith(x.toLowerCase()));
          const allowed = lower === needle || (eraPrefix !== undefined && lower.slice(eraPrefix.length) === needle);
          if (!allowed) offenders.push(`${c.category}/${p.tag} ← ${t}（前缀不在 TAG_ERA_PREFIXES 里）`);
          if (lower === needle) hasExact = true;
        }
        if (!hasExact) prefixedOnlyRows += 1;
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    expect(prefixedOnlyRows, '没有任何一行是"仅靠带前缀的写法命中"的 ⇒ 正面那条夹具可能在空转').toBeGreaterThan(0);
    console.log(`[覆盖命中的形状] 全库 ${prefixedOnlyRows} 行仅靠带前缀的写法命中，前缀全部在 TAG_ERA_PREFIXES 里`);
  });
});

const scratch: string[] = [];

function readAuditAt(kbDir: string): AuditCategory {
  const r = runAudit(['--orphan-audit-json'], { ARENA_KB_DIR: kbDir });
  expect(r.status, `夹具审计退出 ${r.status}：\n${r.stderr.slice(0, 600)}`).toBe(0);
  const parsed = JSON.parse(r.stdout) as Audit;
  const fe = parsed.categories.find((c) => c.category === 'frontend');
  expect(fe, '夹具里没有 frontend 这一类（CATEGORY_IDS 读法变了？）').toBeDefined();
  return fe!;
}

/**
 * **门禁自己也要被门禁**（`.qoder/rules/dev_verify_workflow.md` 第 3 条）。
 * `npm run kb:index` 不在任何 `verify.sh` 阶段里 ⇒ `content/knowledge/INDEX.md` 是人手提交的，
 * 于是"改了矩阵 README 忘了重跑"与"有人手改了报表里的某个数"都不会红
 * （历史上真漏过一次：`d01bdfc`）。这条判据把"报表过期"从"没人看得见"变成"当天红"。
 *
 * ⚠ 不用 `git`：`.dockerignore` 排掉 `.git` ⇒ 任何 shelling out 到 git 的判据在容器档里必然空转。
 * 这里比的两侧（重新渲染的结果 与 工作树里那份文件）在两档都存在，`content/` 是 bind mount。
 */
describe('INDEX.md 的新鲜度（重新生成必须逐字节等于提交的那份）', () => {
  const FILE = join(config.repoRoot, 'content', 'knowledge', 'INDEX.md');
  const committed = readFileSync(FILE, 'utf8');
  const stamp = /^> 生成时间：(\S+)$/m.exec(committed)?.[1];

  it('提交的那份里有一行可解析的「生成时间」（它是这条比对能成立的前提）', () => {
    expect(stamp, '报表开头那句 `> 生成时间：…` 没了或改写了 ⇒ 比对没有基准，去改 renderKnowledgeIndex 的头部').toBeDefined();
    expect(Number.isNaN(Date.parse(stamp!)), `生成时间 "${stamp}" 不是可解析的时间，重算时拿不到同一个字符串`).toBe(false);
  });

  it('按提交里那个时间重算 ⇒ 与文件逐字节相等（红话会指出差在哪一行）', () => {
    const before = readFileSync(FILE, 'utf8');
    const r = runAudit(['--print-markdown', '--timestamp', stamp!]);
    expect(r.status, `--print-markdown 退出 ${r.status}：\n${r.stderr.slice(0, 600)}`).toBe(0);
    expect(readFileSync(FILE, 'utf8'), '--print-markdown 写了文件 ⇒ 它会把自己判的这条闸门喂绿').toBe(before);
    if (r.stdout === committed) return;
    const a = r.stdout.split('\n');
    const b = committed.split('\n');
    const diff: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) diff.push(`第 ${i + 1} 行｜重新生成：${(a[i] ?? '(无)').slice(0, 120)}｜文件里：${(b[i] ?? '(无)').slice(0, 120)}`);
    }
    throw new Error(
      `INDEX.md 与"按同一时间重新生成的那份"不一致（改了矩阵没重跑 kb:index，或有人手改了报表）：\n` +
        `${diff.slice(0, 10).join('\n')}${diff.length > 10 ? `\n…另有 ${diff.length - 10} 行` : ''}`,
    );
  });

  it('反面（对照，防"恒等"）：换一个时间重算 ⇒ 必然与文件不同，而且只差那一行', () => {
    const r = runAudit(['--print-markdown', '--timestamp', '2000-01-01T00:00:00.000Z']);
    expect(r.status, `退出 ${r.status}：\n${r.stderr.slice(0, 400)}`).toBe(0);
    expect(r.stdout).not.toBe(committed);
    const a = r.stdout.split('\n');
    const b = committed.split('\n');
    const diffIdx = a.map((line, i) => (line !== b[i] ? i : -1)).filter((i) => i >= 0);
    expect(diffIdx, `换时间戳只该改动「生成时间」那一行，实际差了 ${diffIdx.length} 行 ⇒ 判据里"逐字节相等"的另一半没了保障`).toEqual([3]);
    expect(a[3], '改动的那行必须是时间戳').toContain('生成时间：2000-01-01T00:00:00.000Z');
  });

  it('--timestamp 打非 ISO 要拒绝，不许悄悄退回 now()（那样比对永远"差一行时间戳"）', () => {
    const r = runAudit(['--print-markdown', '--timestamp', '昨天下午']);
    expect(r.status, '非法时间被吞掉并退 0 ⇒ 闸门拿到的其实是"此刻"的那份，比对会假红/假绿说不清').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`, '报错要点名是 timestamp 的问题').toMatch(/timestamp/);
  });

  it('这条缝也不许改动 INDEX.md（与 --orphan-audit-json 同一条纪律）', () => {
    const before = readFileSync(FILE, 'utf8');
    runAudit(['--print-markdown', '--timestamp', '2000-01-01T00:00:00.000Z']);
    expect(readFileSync(FILE, 'utf8'), '--print-markdown 落盘了 ⇒ 它把"报表过期"这个自己该判的故障顺手修掉').toBe(before);
  });
});

/**
 * 脚本源码，**去掉注释行**（判的是代码里那份抄本，不是注释里那段"以前抄过"的历史 ——
 * 后者会被保留下来正是本仓库的写法：教训要写在文件里，但不许因此被当成还在犯的错）。
 */
function readScript(): string {
  return readFileSync(SCRIPT, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}
