import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, QUESTION_COMPANIES, TAG_ERA_PREFIXES, TAG_META_PREFIXES, classifyOrphanTag, isTagShaped } from '@arena/shared';
import { config } from '../../src/config.js';

/**
 * N-11 第二发：`content/knowledge/frontend/README.md` 那 20 行考点从此有显式 tag。
 *
 * 判的是**矩阵自己的形状**（每行都带可机器判定的 tag），不是题目的 tags ——
 * 已入库的 23 道 frontend 题一个字节都没动（板上 ③ 那条决定：回填与否等命名用满一个季度再定）。
 * 所以这条闸门是"往后新增的行不许退化"，而**不是**"追溯性地判老题不合规"。
 *
 * 走的是 `compile-knowledge.mjs --orphan-audit-json` 那条只读缝（与报表同一个解析器、同一份口径）：
 * 测试自己再 `readFileSync` + 正则切一遍表格的话，它判的就是"测试里那份解析"，
 * 而生成器那份解析坏了它永远看不见（本仓库反复付账的那类"自证"）。
 *
 * N-24 补的两件事：① 形状判据不再在这里抄一份（`isTagShaped` 来自 shared，见 `content.test.ts` 那份对表）；
 * ② "考点 tag 不许是元标签形状"从 `frontend` 一类扩到**全部七类** —— 只有 frontend 有这道判据时，
 * 其余六类随时能加出一行 `airbnb`，而 `coveredQuestionIds` 那条任意前缀后缀匹配会拿 `company:airbnb`
 * 把它判成"已覆盖"（覆盖率因此说谎）。两条判据是同一个洞的两半：一半管行 tag 别长成元标签，
 * 一半管元标签就算长这样也不许算覆盖。
 */

const SCRIPT = join(config.repoRoot, 'scripts', 'kb', 'compile-knowledge.mjs');

interface Row {
  category: string;
  totalPoints: number;
  explicitPoints: number;
  untrackablePoints: number;
  covered: number;
  uncovered: number;
  ratio: string;
  points: { tag: string; label: string; hasExplicitTag: boolean; matchedBy: string }[];
}

function rows(): Row[] {
  const r = spawnSync(process.execPath, [SCRIPT, '--orphan-audit-json'], {
    cwd: config.repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  expect(r.status, `--orphan-audit-json 退出 ${r.status}：\n${r.stderr.slice(0, 600)}`).toBe(0);
  const parsed = JSON.parse(r.stdout) as { categories: Row[] };
  return parsed.categories;
}

describe('frontend 考点矩阵必须每行都可机器判定（N-11 第二发）', () => {
  const all = rows();
  const fe = all.find((c) => c.category === 'frontend');

  it('20 行考点全部带显式反引号 tag，一个"无法判定"的都不留', () => {
    expect(fe, '审计里没有 frontend 这一类（CATEGORY_IDS 读法变了？）').toBeDefined();
    const missing = fe!.points.filter((p) => !p.hasExplicitTag).map((p) => p.label);
    expect(missing, `这些行第 1 列没有 \`tag-id\`，覆盖率对它们永远算不出来：${missing.join(' / ')}`).toEqual([]);
    expect(fe!.untrackablePoints, '报表还在报"无显式 tag 的行"⇒ 上面那条与生成器读的不是同一份').toBe(0);
    expect(fe!.explicitPoints, '行数与可判定行数不等').toBe(fe!.totalPoints);
    // 20 行是这份矩阵自己的口径（README 末尾那句"上表 20 行"）；少一行意味着有人删了考点行，
    // 那是要在评审里说一件事，不是顺手改一个数 —— 所以这里判"不少于 20"而不是"恰好 20"。
    expect(fe!.totalPoints, '考点行数少于 20：有人删了行？').toBeGreaterThanOrEqual(20);
  });

  it('每个 tag 都是 kebab-case、类别内不重复、不带类别前缀、也不是元标签', () => {
    const bad: string[] = [];
    const seen = new Map<string, string>();
    for (const p of fe!.points) {
      if (!isTagShaped(p.tag)) bad.push(`${p.label} 的 tag "${p.tag}" 不是题目用的那种形状`);
      if (p.tag.startsWith('frontend-') || p.tag.startsWith('fe-')) bad.push(`${p.tag} 带了类别前缀（约定是 kebab-case 无前缀，见 system-design/big-data）`);
      if (p.tag !== p.tag.toLowerCase()) bad.push(`${p.tag} 有大写`);
      const prev = seen.get(p.tag);
      if (prev) bad.push(`${p.tag} 被两行共用（${prev} 与 ${p.label}）⇒ 覆盖统计会把两行算成一行的题`);
      seen.set(p.tag, p.label);
      if (classifyOrphanTag(p.tag) !== 'point-gap') bad.push(`${p.tag} 是元标签的形状（时代/出处/公司名），不能当考点 tag`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('覆盖率从 — 变成算得出来的数（这一发的存在理由）', () => {
    expect(fe!.ratio, 'frontend 覆盖率还是 — ⇒ 一行可判定的都没有，补 tag 没生效').not.toBe('—');
    expect(fe!.covered + fe!.uncovered, '可判定行数与覆盖+未覆盖不等').toBe(fe!.explicitPoints);
    expect(fe!.covered, `老题里已经有挂着这些 tag 的（13/20 行本该命中），covered=0 ⇒ join 那条路断了`).toBeGreaterThan(0);
    console.log(`[frontend 覆盖率] ${fe!.covered}/${fe!.explicitPoints} = ${fe!.ratio}（改这一发之前是 —）`);
    const hit = fe!.points.filter((p) => p.matchedBy === 'explicit' && p.tag);
    console.log(`[frontend 命中的行] ${hit.length} 行有显式 tag；派生 slug 兜底命中 ${fe!.points.filter((p) => p.matchedBy === 'derived').length} 行`);
  });

  it('其余六类不许被这一发顺手改坏（只有 frontend 在本发的射程内）', () => {
    const others = all.filter((c) => c.category !== 'frontend');
    expect(others.length, '少了类别').toBe(6);
    // algorithms / sql 的 20 行仍然没 tag —— 这是**已知的**、板上写明"下次另议"的状态，不是回归。
    // 判的是"它们没被改动"：行数与无 tag 行数仍是 20/20 与 21/20。
    const al = others.find((c) => c.category === 'algorithms')!;
    expect([al.totalPoints, al.untrackablePoints], 'algorithms 的行数/无 tag 行数变了：这一发不该碰它').toEqual([20, 20]);
    const sq = others.find((c) => c.category === 'sql')!;
    expect([sq.totalPoints, sq.untrackablePoints], 'sql 的行数/无 tag 行数变了：这一发不该碰它').toEqual([21, 20]);
    for (const c of others.filter((x) => !['algorithms', 'sql'].includes(x.category))) {
      expect(c.untrackablePoints, `${c.category}：这一发之前它就已经全带 tag 了，现在却冒出无 tag 的行 ⇒ 生成器读错了文件`).toBe(0);
    }
  });
});

/**
 * N-24：矩阵行 tag 的"不许是元标签形状"这条，今天只对 `frontend` 判（上面那个 describe）。
 * 剩下六类随时能加出一行 `airbnb` —— 而旧版 `coveredQuestionIds` 拿题目上的 `company:airbnb`
 * 就能把这一行判成"已覆盖"（出处标记不是考点，于是 INDEX.md 里那个覆盖率数字在说假话）。
 * 这里把判据按 shared 那三张表（`TAG_ERA_PREFIXES` / `TAG_META_PREFIXES` / `QUESTION_COMPANIES`）
 * 扩到全部七类：判的是**矩阵自己的形状**，与"题目的 tags 长什么样"无关，所以不追溯老题、不动 `content/questions/**`。
 *
 * 只管**有显式反引号 tag** 的行：没有 tag 的行那个 name 是从中文切出来的派生 slug（含汉字），
 * 按形状判它们全都会红，而红话说的是"补 tag"—— 那件事由上面 `untrackablePoints` 那两条催，不靠这条。
 */
describe('七类矩阵的行 tag 都不许是元标签形状（N-24，原来只管 frontend）', () => {
  const all = rows();
  const explicit = all.flatMap((c) => c.points.filter((p) => p.hasExplicitTag).map((p) => ({ ...p, category: c.category })));

  /** 一个行 tag 的"元标签形状"投诉；返回 null 表示这行是考点形状。判据全部来自 shared 那三张表。 */
  const metaComplaint = (tag: string): string | null => {
    const lower = String(tag).toLowerCase();
    const metaPrefix = TAG_META_PREFIXES.find((p) => lower.startsWith(p.toLowerCase()));
    if (metaPrefix) return `带了出处前缀 "${metaPrefix}"（那是"这道题来自哪家"，不是考点）`;
    const eraPrefix = TAG_ERA_PREFIXES.find((p) => lower.startsWith(p.toLowerCase()));
    if (eraPrefix) return `带了时代前缀 "${eraPrefix}"（矩阵行要标的是裸形考点，折叠层会替它把两种写法合成一个）`;
    const company = QUESTION_COMPANIES.find((c) => c.toLowerCase() === lower);
    if (company) return `整标签就是出处公司名 "${company}"（考点矩阵里不该有一行叫公司名）`;
    return null;
  };

  it('三张表都不是空的，且这条判据真的会拒绝那三种形状（不是恒绿的装饰）', () => {
    expect([...QUESTION_COMPANIES].length, '公司表空了 ⇒ 上面那条"纯公司名"判据就是在空转').toBeGreaterThan(0);
    expect([...TAG_META_PREFIXES].length, '出处前缀表空了 ⇒ 同上').toBeGreaterThan(0);
    expect([...TAG_ERA_PREFIXES].length, '时代前缀表空了 ⇒ 同上，而且覆盖判定会连合法命中一起拒掉').toBeGreaterThan(0);
    // 正例：`airbnb-search-ranking` 是一条真考点（N-11 第一发就是这么分口径的）
    expect(metaComplaint('airbnb-search-ranking'), '真考点被顺手免检了 ⇒ 这条判据会把矩阵管成一行都不许加').toBeNull();
    const complained = ['company:airbnb', 'airbnb', 'modern:streaming-aqe'].map((t) => `${t} ⇒ ${metaComplaint(t) ?? '没拒绝'}`);
    expect(metaComplaint('company:airbnb'), '出处前缀没被拒绝（那三种形状里最会骗人的那一种）').not.toBeNull();
    expect(metaComplaint('airbnb'), '纯公司名没被拒绝').not.toBeNull();
    expect(metaComplaint('modern:streaming-aqe'), '时代前缀形没被拒绝').not.toBeNull();
    console.log(`[行 tag 判据自检] ${complained.join('｜')}`);
  });

  it('七个类别都在审计里，且有显式 tag 的行够多（这条判据不是在小样本上空转）', () => {
    expect(all.map((c) => c.category).sort(), '审计里的类别与 shared 的 CATEGORY_IDS 不一致').toEqual([...CATEGORY_IDS].sort());
    expect(explicit.length, `只有 ${explicit.length} 行带显式 tag ⇒ 这条判据几乎不判任何东西（2026-10-20 实测是 107 行）`).toBeGreaterThanOrEqual(100);
  });

  it('每一行的 tag 过形状、不是元标签形状、类别内不重复', () => {
    const bad: string[] = [];
    const seen = new Map<string, string>();
    for (const p of explicit) {
      if (!isTagShaped(p.tag)) bad.push(`${p.category}/${p.tag}（${p.label}）不是题目用的那种形状`);
      if (p.tag !== p.tag.toLowerCase()) bad.push(`${p.category}/${p.tag} 有大写`);
      const complaint = metaComplaint(p.tag);
      if (complaint) bad.push(`${p.category}/${p.tag}（${p.label}）${complaint}`);
      // 与 classifyOrphanTag 同源：这里与报告那侧不许有第二种"什么叫元标签"
      const role = classifyOrphanTag(p.tag);
      if ((complaint === null) !== (role === 'point-gap')) {
        bad.push(`${p.category}/${p.tag}：本文件的元标签判据与 shared 的 classifyOrphanTag 分叉了（${complaint ?? '考点'} vs role=${role}）`);
      }
      const key = `${p.category}::${p.tag}`;
      const prev = seen.get(key);
      if (prev) bad.push(`${p.category} 的 tag "${p.tag}" 被两行共用（${prev} 与 ${p.label}）⇒ 覆盖统计会把两行算成一行的题`);
      seen.set(key, p.label);
    }
    expect(bad, bad.join('\n')).toEqual([]);
    console.log(`[七类行 tag] 检查了 ${explicit.length} 行：${all.map((c) => `${c.category} ${c.points.filter((p) => p.hasExplicitTag).length}`).join('｜')}`);
  });
});
