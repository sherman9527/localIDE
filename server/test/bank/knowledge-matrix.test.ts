import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyOrphanTag } from '@arena/shared';
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
 */

const SCRIPT = join(config.repoRoot, 'scripts', 'kb', 'compile-knowledge.mjs');
/** 与 `scripts/kb/kit.mjs` 的 parsePointCell、`content.test.ts` 的题目 tag 判据同一条正则。 */
const TAG_RE = /^[a-z0-9][a-z0-9:._-]*$/;

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
      if (!TAG_RE.test(p.tag)) bad.push(`${p.label} 的 tag "${p.tag}" 不是题目用的那种形状`);
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
