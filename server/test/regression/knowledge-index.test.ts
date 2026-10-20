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

  it('分口径真的分到了东西：三类报表里元标签 > 0（全归 point-gap 等于这条是装饰）', () => {
    for (const name of ['frontend', 'algorithms', 'sql', 'hot-interviews']) {
      const c = byCategory(name);
      expect(c, `报表里没有类别 ${name}（CATEGORY_IDS 与脚本读的那份不一致）`).toBeDefined();
      expect(c!.orphanTotal, `${name}：一个脱钩标签都没有 ⇒ 下面那条"元标签 > 0"会空转，先查口径`).toBeGreaterThan(0);
      expect(c!.orphanMeta, `${name}：元标签数为 0 ⇒ 分类器没在分（或前缀/公司表漂了），N 还是那个失真数`).toBeGreaterThan(0);
      expect(c!.orphanPointGaps, `${name}：考点缺口为 0 ⇒ 所有脱钩都被免检了，那这条报表就没用了`).toBeGreaterThan(0);
      expect(c!.orphanPointGaps, `${name}：考点缺口不小于脱钩总数 ⇒ 元标签根本没被分出去`).toBeLessThan(c!.orphanTotal);
    }
    const era = audit.categories.flatMap((c) => c.orphans.filter((o) => o.role === 'era-meta'));
    const company = audit.categories.flatMap((c) => c.orphans.filter((o) => o.role === 'company-meta'));
    console.log(
      `[脱钩分口径] ${audit.categories.map((c) => `${c.category} ${c.orphanTotal}（元 ${c.orphanMeta}/缺口 ${c.orphanPointGaps}）`).join('｜')}\n` +
        `  其中时代前缀 ${era.length} 个、company: 前缀 ${company.length} 个、纯公司名 ${audit.categories.flatMap((c) => c.orphans.filter((o) => o.role === 'company-name-meta')).length} 个`,
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
 * 脚本源码，**去掉注释行**（判的是代码里那份抄本，不是注释里那段"以前抄过"的历史 ——
 * 后者会被保留下来正是本仓库的写法：教训要写在文件里，但不许因此被当成还在犯的错）。
 */
function readScript(): string {
  return readFileSync(SCRIPT, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}
