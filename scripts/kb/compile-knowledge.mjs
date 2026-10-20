#!/usr/bin/env node
/**
 * 生成 content/knowledge/INDEX.md：类别 × 考点数 × 已出题数 × 未覆盖考点。
 *
 *   node scripts/kb/compile-knowledge.mjs          # npm run kb:index
 *
 * 数据源：
 *   - content/knowledge/<category>/README.md 的考点矩阵表格（表头含「考点 / 可出题形式 / 建议 judgeKind」）
 *   - content/questions 题库（软删除题不计入"已出题"，但仍列进"历史去重池"）
 *   - content/jd-cache/skills.json（存在时用来指出"JD 很热但矩阵里没有对应考点"的缺口）
 *
 * 覆盖判定：题目的 tags[]（含元标签前缀）里出现考点 tag 即算覆盖。
 * 只认**显式写在矩阵第 1 列反引号里的 tag**；没写 tag 的行无法机器判定，会单独统计并提示补 tag。
 * 第 1 列没写 tag 的行仍会拿"标签推出来的 slug"去撞一次题目 —— 但那类命中**单独报**
 * （`仅派生 slug 命中`）：中文名一改，"哪些考点已出题"就跟着悄悄换。
 *
 * 只读的缝（不写文件；未知参数一律拒绝，绝不允许退化成"整份生成 + 写盘"）：
 *   node scripts/kb/compile-knowledge.mjs --orphan-audit-json     # 分口径的审计 JSON（闸门判它）
 *   node scripts/kb/compile-knowledge.mjs --print-markdown [--timestamp <ISO>]   # 把"今天会写成什么"打到 stdout
 *       （新鲜度闸门用它按提交里那个时间戳重算一遍，再与 `content/knowledge/INDEX.md` 逐字节比）
 *
 * 为什么不把这些规则写在脚本里而要从 @arena/shared 拿：`modern:` 曾经在这里被硬写成
 * `raw.replace(/^modern:/, '')`，于是"什么算时代标记"在仓库里有两份（第二份是 N-17 立的 `TAG_ERA_PREFIXES`）。
 * 报告口径与折叠层分叉的症状极难看破：同一个 `modern:x` 一边算同一个考点、另一边算脱钩。
 */
import { join } from 'node:path';
import { UsageError, isMain, parseArgs, rel, writeTextAtomic } from '../jd/lib.mjs';
import { loadShared, readCategoryKnowledge, KNOWLEDGE_DIR } from './kit.mjs';
import { SKILLS_FILE, loadQuestions, statsByCategory, coveredQuestionIds, isExecutable } from '../bank/kit.mjs';
import { readFile } from 'node:fs/promises';

const CODE_FORM = 'code';

export function clipCell(text, max = 60) {
  const s = String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 算出这份报表需要的全部数据（无副作用；`--orphan-audit-json` 与生成路径共用它，
 * 所以"闸门判的分区"与"报表里印的分区"不可能是两套口径）。
 *
 * `ARENA_KB_DIR` 只换**读**的目录（闸门用它造一行"没有显式 tag 但标签能切出 slug"的矩阵，
 * 证明派生 slug 那一档不是装饰）。默认走 `content/knowledge`，与 `npm run kb:index` 逐字节同一条路。
 * ⚠ 它**不换**写路径：这条脚本只写 `content/knowledge/INDEX.md` 这一个文件，且只走生成那条路。
 */
export async function computeKnowledgeReport({ knowledgeDir = process.env.ARENA_KB_DIR || KNOWLEDGE_DIR } = {}) {
  const shared = await loadShared();
  const categories = [...shared.CATEGORY_IDS];
  const { questions, errors, hiddenIds } = await loadQuestions();
  const stats = statsByCategory(questions);
  const visible = questions.filter((q) => !hiddenIds.has(q.id));

  const knowledge = [];
  for (const category of categories) {
    knowledge.push(await readCategoryKnowledge(category, { validKinds: [...shared.JUDGE_KINDS], dir: join(knowledgeDir, category) }));
  }

  const rows = [];
  const detail = [];
  for (const kb of knowledge) {
    const catVisible = visible.filter((q) => q.category === kb.category);
    const covered = [];
    const uncovered = [];
    const untrackable = [];
    const derivedOnly = [];
    const auditPoints = [];
    for (const point of kb.points) {
      const ids = coveredQuestionIds(point, catVisible);
      if (!point.hasExplicitTag) {
        untrackable.push(point);
        // 派生 slug 的命中单独一档：它今天能把题目撞上来，改一次中文名就换了目标（报表必须说实话说它脆）
        if (ids.length > 0) derivedOnly.push({ point, ids });
        auditPoints.push({ tag: point.tag, label: point.label, hasExplicitTag: false, matchedBy: ids.length > 0 ? 'derived' : 'none', covered: false, questionIds: ids });
        continue;
      }
      (ids.length > 0 ? covered : uncovered).push({ point, ids });
      auditPoints.push({ tag: point.tag, label: point.label, hasExplicitTag: true, matchedBy: 'explicit', covered: ids.length > 0, questionIds: ids });
    }
    const s = stats.get(kb.category);
    const kinds = Object.entries(s?.kinds ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || '—';
    rows.push({
      category: kb.category,
      label: shared.CATEGORY_META[kb.category]?.label ?? kb.category,
      points: kb.points.length,
      explicitPoints: kb.points.length - untrackable.length,
      codePoints: kb.points.filter((p) => p.forms.includes(CODE_FORM)).length,
      rubricPoints: kb.points.filter((p) => p.form === 'rubric' && !p.forms.includes(CODE_FORM)).length,
      questions: catVisible.length,
      code: catVisible.filter((q) => isExecutable(q.judgeKind)).length,
      rubric: catVisible.filter((q) => !isExecutable(q.judgeKind)).length,
      covered: covered.length,
      uncovered: uncovered.length,
      untrackable: untrackable.length,
      derivedOnly: derivedOnly.length,
      ratio: covered.length + uncovered.length === 0 ? '—' : `${Math.round((covered.length / (covered.length + uncovered.length)) * 100)}%`,
      kinds,
      topics: kb.topicFiles.length,
      readmeMissing: kb.readmeMissing,
    });
    const orphans = findOrphanTags(shared, catVisible, kb.points);
    detail.push({ kb, covered, uncovered, untrackable, derivedOnly, auditPoints, orphanTags: orphans.tags, orphanSpellings: orphans.spellings, orphanMeta: orphans.meta, orphanPointGaps: orphans.pointGaps });
  }

  const jdGaps = await findJdGaps(knowledge, shared);
  return {
    shared,
    rows,
    detail,
    jdGaps,
    parseErrors: errors,
    hiddenCount: hiddenIds.size,
    total: questions.length,
    categories,
  };
}

/** `--orphan-audit-json` 的输出：真实题库 + 真实矩阵算出来的分区，闸门判它的**性质**而不是判一份抄本。 */
export function buildOrphanAudit(report) {
  const { shared, rows, detail } = report;
  const categories = rows.map((r) => {
    const d = detail.find((x) => x.kb.category === r.category);
    const orphans = d.orphanTags.map((o) => ({ ...o, role: shared.classifyOrphanTag(o.tag) }));
    const meta = orphans.filter((o) => o.role !== 'point-gap');
    const pointGaps = orphans.filter((o) => o.role === 'point-gap');
    return {
      category: r.category,
      points: d.auditPoints,
      totalPoints: r.points,
      explicitPoints: r.explicitPoints,
      untrackablePoints: r.untrackable,
      covered: r.covered,
      uncovered: r.uncovered,
      derivedOnly: d.derivedOnly.map((x) => x.point.tag),
      ratio: r.ratio,
      orphans,
      orphanSpellings: d.orphanSpellings,
      orphanTotal: orphans.length,
      orphanMeta: meta.length,
      orphanPointGaps: pointGaps.length,
    };
  });
  return {
    categories,
    eraPrefixTruth: [...shared.TAG_ERA_PREFIXES],
    metaPrefixTruth: [...shared.TAG_META_PREFIXES],
    companyTruth: [...shared.QUESTION_COMPANIES],
  };
}

/**
 * 题目带了 tag，但该类别矩阵里没有任何考点含这个 tag —— 题面与知识库脱钩。
 * 剥前缀只认 `TAG_ERA_PREFIXES` 那一份（时代折叠的同一张表），命中判定沿用 coveredQuestionIds 的口径。
 * ⚠ 返回**三个数**而不是一个：元标签（时代/出处标记、纯公司名）本来就不该有考点行，
 * 只有 pointGaps 才是"该补一行矩阵"的可行动数。合成一个数报出去，报表就会长期催一件不存在的事。
 */
function findOrphanTags(shared, catQuestions, points) {
  const known = new Set();
  for (const p of points) {
    if (p.hasExplicitTag) known.add(p.tag.toLowerCase());
    known.add(p.tag.toLowerCase());
  }
  const orphans = new Map();
  for (const q of catQuestions) {
    for (const raw of q.tags) {
      const lower = String(raw).toLowerCase();
      const eraPrefix = shared.TAG_ERA_PREFIXES.find((p) => lower.startsWith(p.toLowerCase()));
      const stripped = eraPrefix ? lower.slice(eraPrefix.length) : lower;
      if (!known.has(stripped)) orphans.set(raw, [...(orphans.get(raw) ?? []), q.id]);
    }
  }
  // ⚠ 按**剥掉时代前缀之后的形**去重，再分类（评审 I1）：`modern:x` 与 `x` 是同一个考点，
  // 分两条报会把同一件事催两次；而"带着 `modern:` 前缀"本身**不构成"这是元标签"** ——
  // 剥完之后矩阵里仍然没有对应行，那就是一个真缺口穿着标记的外衣。
  // 只有 `company:*` 与纯公司名才是真的元标签（出处/公司维度，本来就不该有考点行）。
  const byConcept = new Map();
  for (const [tag, ids] of orphans.entries()) {
    const eraPrefix = shared.TAG_ERA_PREFIXES.find((x) => tag.toLowerCase().startsWith(x.toLowerCase()));
    const stripped = eraPrefix ? tag.toLowerCase().slice(eraPrefix.length) : tag.toLowerCase();
    const entry = byConcept.get(stripped) ?? { tag: stripped, spellings: new Set(), ids: new Set() };
    entry.spellings.add(tag);
    for (const id of ids) entry.ids.add(id);
    byConcept.set(stripped, entry);
  }
  const tags = [...byConcept.values()]
    .map((e) => ({ tag: e.tag, spellings: [...e.spellings].sort(), ids: [...e.ids].sort() }))
    .sort((a, b) => b.ids.length - a.ids.length);
  const isMeta = (t) => shared.isMetaOrphanTag(t);
  return {
    tags,
    // 写法数与概念数都报出去：只报一个的话，"92 种写法"与"74 个概念"会被读成同一个东西
    spellings: orphans.size,
    meta: tags.filter((t) => isMeta(t.tag)),
    pointGaps: tags.filter((t) => !isMeta(t.tag)),
  };
}

/** JD 里被反复提到、但知识库矩阵里找不到对应考点的技术栈 —— 需求 19"先整理知识库再出题"的缺口信号。 */
async function findJdGaps(knowledge, shared) {
  let payload;
  try {
    payload = JSON.parse(await readFile(SKILLS_FILE, 'utf8'));
  } catch {
    return null;
  }
  const skills = Array.isArray(payload) ? payload : (payload.skills ?? []);
  const gaps = [];
  for (const skill of skills.slice(0, 40)) {
    const points = knowledge.find((kb) => kb.category === skill.category)?.points ?? [];
    const text = points.map((p) => `${p.tag} ${p.label} ${p.senior} ${p.modern} ${p.jdSkill}`).join(' ').toLowerCase();
    const hit = text.includes(skill.tag) || text.includes(String(skill.label).toLowerCase()) || text.includes(skill.tag.replace(/-/g, ' '));
    if (!hit) gaps.push(skill);
  }
  void shared;
  return { generatedAt: payload?.generatedAt, gaps };
}

/**
 * 生成 = 算 + 渲染 + 写盘。**写盘只有这一处**，且只有"没有参数"这一条路会走到它。
 * 渲染是纯函数（`renderKnowledgeIndex`），所以 `--print-markdown` 能在不碰文件的前提下
 * 把"今天重新生成会写成什么样"整份打出来 —— 新鲜度闸门（`knowledge-index.test.ts`）判的就是这个。
 * ⚠ 为什么需要那条缝：`npm run kb:index` 不在任何 `verify.sh` 阶段里，`INDEX.md` 是人手提交的，
 * 于是"改了矩阵 README 忘了重跑"与"有人手改了报表"都不会红（历史上进过一次 `d01bdfc`）。
 */
export async function compileKnowledgeIndex({ now = new Date().toISOString() } = {}) {
  const report = await computeKnowledgeReport();
  const markdown = renderKnowledgeIndex(report, { now });
  const out = join(KNOWLEDGE_DIR, 'INDEX.md');
  await writeTextAtomic(out, markdown);
  return { out, markdown, rows: report.rows, detail: report.detail, jdGaps: report.jdGaps, parseErrors: report.parseErrors };
}

/**
 * 纯渲染：数据 + 一个时间戳 → 那份 markdown。**没有任何 I/O、没有 `new Date()`**。
 * 时间戳做成参数而不是当场取，才有"按提交里那个时间重算一遍再逐字节比"这种判法；
 * 留在函数里取的话，每一次重算都必然与文件不同，闸门只能要么放宽（=废掉）要么常红。
 */
export function renderKnowledgeIndex({ rows, detail, jdGaps, parseErrors, hiddenCount, total, categories }, { now }) {
  const lines = [
    '# 知识库索引（自动生成，请勿手改）',
    '',
    '> 由 `npm run kb:index`（`node scripts/kb/compile-knowledge.mjs`）生成。',
    `> 生成时间：${now}`,
    `> 输入：\`content/knowledge/<类别>/README.md\` 考点矩阵（${categories.length} 类）+ 题库 ${total} 题（其中软删除 ${hiddenCount} 题不计入"已出题"）。`,
    '> 覆盖判定：题目 `tags[]`（去掉时代前缀，前缀表 = `shared` 的 `TAG_ERA_PREFIXES`）命中矩阵第 1 列反引号里的 tag 即算已覆盖；',
    '> 未写反引号 tag 的行列进「无显式 tag（无法判定）」单独统计，其中**靠标签派生 slug 撞上的**另列一档（改中文名就会变，脆）。',
    '> 脱钩标签分两个口径：**元标签**（只有 `company:*` 前缀与纯公司名，规则 = `shared` 的 `classifyOrphanTag`）本来就不该有考点行；⚠ 带 `modern:` 的脱钩**算缺口不算元**：剥掉前缀之后矩阵里仍然没有那一行，那就是一个真考点穿着标记的外衣（评审 I1）；',
    '> **考点缺口**才是"该给矩阵补一行"的可行动数 —— 只看合起来的 N 会被元标签撑到失真。',
    '',
    '## 类别总览',
    '',
    '| 类别 | 考点数 | 含 code 形式 | 含 rubric 形式 | 无显式 tag（无法判定） | 仅派生 slug 命中（脆） | 语料篇数 | 已出题（可见） | 代码题 | 主观题 | 已覆盖考点 | 未覆盖考点 | 覆盖率 | 脱钩标签（元/缺口） | 判分方式分布 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const d = detail.find((x) => x.kb.category === r.category);
    lines.push(
      `| [\`${r.category}\`](./${r.category}/README.md) ${r.label} | ${r.points} | ${r.codePoints} | ${r.rubricPoints} | ${r.untrackable} | ${r.derivedOnly} | [${r.topics}](./${r.category}/README.md#语料文件) | ${r.questions} | ${r.code} | ${r.rubric} | ${r.covered} | ${r.uncovered} | ${r.ratio} | ${d ? d.orphanTags.length : 0}（元 ${d ? d.orphanMeta.length : 0}/缺口 ${d ? d.orphanPointGaps.length : 0}；写法 ${d ? d.orphanSpellings : 0}） | ${r.kinds} |`,
    );
  }
  const totalPoints = rows.reduce((s, r) => s + r.points, 0);
  const totalCovered = rows.reduce((s, r) => s + r.covered, 0);
  const totalTrackable = rows.reduce((s, r) => s + r.covered + r.uncovered, 0);
  const totalOrphans = detail.reduce((s, d) => s + d.orphanTags.length, 0);
  const totalSpellings = detail.reduce((s, d) => s + (d.orphanSpellings ?? 0), 0);
  const totalMeta = detail.reduce((s, d) => s + d.orphanMeta.length, 0);
  lines.push('');
  lines.push(
    `**合计**：${totalPoints} 个考点，其中 ${totalTrackable} 个可机器判定覆盖，已覆盖 ${totalCovered} 个（${totalTrackable ? Math.round((totalCovered / totalTrackable) * 100) : 0}%）；题库 ${total} 题。`,
  );
  lines.push(
    `**脱钩考点合计**：${totalOrphans} 个概念（${totalSpellings} 种写法）= 元标签 ${totalMeta} 个 + **考点缺口 ${totalOrphans - totalMeta} 个**（后者才是"该补一行矩阵"的清单）。`,
  );
  if (parseErrors.length > 0) {
    lines.push('');
    lines.push(`## ⚠ 题库里有 ${parseErrors.length} 个非法/坏文件（会被 loader 跳过，也是覆盖统计的噪音）`);
    lines.push('');
    for (const err of parseErrors.slice(0, 20)) lines.push(`- \`${rel(err.file)}\`：${err.message}`);
    if (parseErrors.length > 20) lines.push(`- …另有 ${parseErrors.length - 20} 个`);
    lines.push('', '修复：`npm run bank:check` 看完整报错。');
  }

  lines.push('', '## 未覆盖考点（"该出什么题"的直接答案）');
  for (const d of detail) {
    const kb = d.kb;
    if (kb.readmeMissing) {
      lines.push('');
      lines.push(`### \`${kb.category}\`｜缺 README.md`);
      lines.push('');
      lines.push(`需要 ${rel(join(kb.dir, 'README.md'))}（表头含「考点 / 可出题形式 / 建议 judgeKind」的矩阵）。`);
      continue;
    }
    if (d.uncovered.length === 0 && d.orphanTags.length === 0 && d.untrackable.length === 0) {
      lines.push('', `### \`${kb.category}\`｜${kb.points.length} 考点全部已覆盖 ✅`);
      continue;
    }
    lines.push('', `### \`${kb.category}\`｜未覆盖 ${d.uncovered.length} / 可判定 ${d.uncovered.length + d.covered.length} 个考点`);
    if (d.uncovered.length > 0) {
      lines.push('', '待出题（建议形式与 judgeKind 取自矩阵）：', '');
      for (const { point } of d.uncovered.slice(0, 40)) {
        lines.push(
          `- \`${point.tag}\` ${point.label}｜形式 ${point.forms.join('/')}｜judgeKind ${point.judgeKinds.join('/') || '(未标)'}｜JD 能力项：${clipCell(point.jdSkill, 40) || '—'}`,
        );
      }
      if (d.uncovered.length > 40) lines.push(`- …另有 ${d.uncovered.length - 40} 个，见 \`${kb.category}/README.md\``);
    }
    if (d.untrackable.length > 0) {
      lines.push('', `**无法自动判定覆盖（第 1 列没写反引号 tag）：${d.untrackable.length} 行** —— 修法：把考点名改成 \`中文名（\`tag-id\`）\` 格式，然后重跑本脚本。`);
      lines.push('', d.untrackable.slice(0, 8).map((p) => `- ${p.label}`).join('\n') + (d.untrackable.length > 8 ? `\n- …另有 ${d.untrackable.length - 8} 行` : ''));
    }
    if (d.derivedOnly.length > 0) {
      lines.push(
        '',
        `**⚠ 仅靠派生 slug 命中题目（第 1 列没有反引号 tag，命中目标是从中文名切出来的）：${d.derivedOnly.length} 行** —— 这类"已覆盖"是脆的：`,
      );
      lines.push(
        '   给这一行改个中文名，覆盖统计就换目标（而且没有任何东西会红）。修法同上：把 tag 写进反引号 —— 形如 中文名（`tag-id`） —— 别依赖切词。',
        '',
        d.derivedOnly.slice(0, 8).map(({ point, ids }) => `- ${point.label}（派生 slug \`${point.tag}\`，命中 ${ids.length} 题：${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '…' : ''}）`).join('\n') +
          (d.derivedOnly.length > 8 ? `\n- …另有 ${d.derivedOnly.length - 8} 行` : ''),
      );
    }
    if (d.orphanTags.length > 0) {
      lines.push(
        '',
        `**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：${d.orphanTags.length} 个概念 / ${d.orphanSpellings} 种写法（元标签 ${d.orphanMeta.length} / 考点缺口 ${d.orphanPointGaps.length}）**`,
      );
      lines.push(
        `   要处理的是那 **${d.orphanPointGaps.length} 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。`,
      );
      lines.push('   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）：' + (d.orphanMeta.length ? ` ${d.orphanMeta.length} 个。` : ' 本类别没有。'));
      const listed = d.orphanPointGaps.length > 0 ? d.orphanPointGaps : d.orphanTags;
      lines.push('', listed.slice(0, 8).map((o) => `- \`${o.tag}\`（${o.ids.length} 题：${o.ids.slice(0, 3).join(', ')}${o.ids.length > 3 ? '…' : ''}）`).join('\n'));
      if (listed.length > 8) lines.push(`- …另有 ${listed.length - 8} 个考点缺口（完整清单：\`--orphan-audit-json\`）`);
    }
  }

  lines.push('', '## JD 热度 vs 知识库缺口');
  if (!jdGaps) {
    lines.push('', '`content/jd-cache/skills.json` 不存在或读不动 —— 跑 `node scripts/jd/extract-skills.mjs --offline` 生成后重跑本脚本。');
  } else if (jdGaps.gaps.length === 0) {
    lines.push('', `skills.json（生成于 ${jdGaps.generatedAt ?? '?'}）里的热点全部能在对应类别矩阵里找到考点，无缺口 ✅`);
  } else {
    lines.push('', `skills.json（生成于 ${jdGaps.generatedAt ?? '?'}）里有 ${jdGaps.gaps.length} 个热点在对应类别矩阵里找不到考点，建议在 README 里补行：`, '');
    for (const gap of jdGaps.gaps.slice(0, 15)) {
      lines.push(`- \`${gap.tag}\`（${gap.label}）→ 应补进 \`content/knowledge/${gap.category}/README.md\`｜JD 提及 ${gap.mentions} 次，来自 ${gap.companies.join('/') || '?'}`);
    }
  }

  lines.push('', '## 下一步（脚本串起来的顺序）', '');
  lines.push('```bash');
  lines.push('node scripts/jd/fetch.mjs --company Airbnb     # 真抓 JD 进 content/jd-cache（只增不减）');
  lines.push('node scripts/jd/extract-skills.mjs             # JD → 技术栈权重 skills.json');
  lines.push('npm run bank:refresh -- --dry-run              # 按上面"未覆盖考点"逐类别试跑');
  lines.push('npm run bank:refresh                           # 真入库（qodercli 优先，失败自动降级 copilot）');
  lines.push('npm run kb:index                               # 重生成这份 INDEX.md');
  lines.push('node scripts/curriculum.mjs                    # 重排 30 天课表');
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** 脚本认识的参数；不在这里的就是打错了的。`--timestamp` 是带值的（其余都是开关）。 */
const BOOLEAN_FLAGS = ['orphan-audit-json', 'print-markdown'];
const VALUE_FLAGS = ['timestamp'];
const KNOWN_FLAGS = [...BOOLEAN_FLAGS, ...VALUE_FLAGS];

/**
 * 参数解析单独一条判据：**未知参数一律拒绝**。
 * 为什么这条要紧：`content/` 在容器里是 bind mount，而默认那条路会**写** `INDEX.md`。
 * 打错一个字母的 flag 要是被忽略，测试就会顺手把报表重新生成一遍 ——
 * "报表过期"这个故障从此被验证过程自己修好（本仓库点名的"闸门被自己的跑法喂绿"）。
 */
export function parseCliArgs(argv) {
  // 先按**名字**逐个核一遍再交给 parseArgs：parseArgs 对未知 flag 报的是"缺少参数值"（它把下一个 token 当值），
  // 那句报错既没说"这名字我不认识"、也不稳定（未知 flag 放在最后一个 token 时根本没得吃）。
  // 这条脚本唯一该被允许的行为是"生成并写文件"与"只读地报数"，中间不许有第三种"看起来跑了但跑的是默认那条"。
  for (const token of argv) {
    if (!token.startsWith('--') || token === '--') continue;
    const name = token.slice(2).split('=')[0];
    if (!KNOWN_FLAGS.includes(name)) throw new UsageError(`未知参数：--${name}｜这条脚本只认 ${KNOWN_FLAGS.map((f) => `--${f}`).join(' / ')}（不忽略多余参数：忽略 = 打错的只读缝退化成"生成并写文件"）`);
  }
  const args = parseArgs(argv, { booleans: BOOLEAN_FLAGS });
  const extra = args._ ?? [];
  if (extra.length > 0) throw new UsageError(`未知参数：${extra.map((u) => `"${u}"`).join(' ')}（这条脚本不收位置参数）`);
  return args;
}

/**
 * `--timestamp` 校形状：必须是能被 `Date.parse` 认下来的 ISO 串。
 * 判据方向：坏时间**报错退出**，不许"退回当场取一个" —— 闸门要的正是"按文件里那个时间重算"，
 * 悄悄换一次时间会让比对永远对不上，而红话说的是"报表过期"（那是假指控）。
 */
function validTimestamp(raw) {
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) throw new UsageError(`--timestamp 需要 ISO 时间，收到 "${raw}"`);
  return new Date(t).toISOString();
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  // 只读的审计缝：闸门（server/test/regression/knowledge-index.test.ts）判的是**真实题库 + 真实矩阵**的分区，
  // 不是自己在测试里重算一份（重算的那份永远不会因为"实现算错了"而红）。
  if (args['orphan-audit-json']) {
    const report = await computeKnowledgeReport();
    process.stdout.write(`${JSON.stringify(buildOrphanAudit(report))}\n`);
    return;
  }

  // 新鲜度闸门用的第二条只读缝：把"今天会写成什么样"打到 stdout，**不碰文件**。
  // `--timestamp` 让调用方能拿提交那份里写着的生成时间重算一遍，从而做**逐字节**比对；
  // 不给它一个可注入的时间，"重新生成"永远与文件差一行时间戳，比对就只能放宽成"忽略那一行" ——
  // 而放宽之后，"有人手改了报表里另一个数"也跟着被忽略了。
  if (args['print-markdown']) {
    const now = args.timestamp ? validTimestamp(args.timestamp) : new Date().toISOString();
    const report = await computeKnowledgeReport();
    process.stdout.write(renderKnowledgeIndex(report, { now }));
    return;
  }

  const result = await compileKnowledgeIndex();
  console.log(`INDEX.md 已生成 → ${rel(result.out)}`);
  const totalPoints = result.rows.reduce((s, r) => s + r.points, 0);
  const totalCovered = result.rows.reduce((s, r) => s + r.covered, 0);
  const totalTrackable = result.rows.reduce((s, r) => s + r.covered + r.uncovered, 0);
  console.log(
    `  类别 ${result.rows.length} 个｜考点 ${totalPoints} 个（可判定 ${totalTrackable}）｜已覆盖 ${totalCovered}｜未覆盖 ${totalTrackable - totalCovered}`,
  );
  for (const r of result.rows) {
    const d = result.detail.find((x) => x.kb.category === r.category);
    console.log(
      `  - ${r.category.padEnd(15)} 考点 ${String(r.points).padStart(2)} 已出题 ${String(r.questions).padStart(2)}（代码 ${r.code}/主观 ${r.rubric}）未覆盖 ${String(r.uncovered).padStart(2)} 无tag ${String(r.untrackable).padStart(2)} 派生命中 ${String(r.derivedOnly).padStart(2)} 脱钩 ${String(d?.orphanTags.length ?? 0).padStart(3)}（元 ${d?.orphanMeta.length ?? 0}/缺口 ${d?.orphanPointGaps.length ?? 0}）`,
    );
  }
  if (result.jdGaps) console.log(`  JD 热点无对应考点：${result.jdGaps.gaps.length} 个${result.jdGaps.gaps.length ? `（${result.jdGaps.gaps.slice(0, 6).map((g) => g.tag).join(', ')}…）` : ''}`);
  if (result.parseErrors.length > 0) {
    console.error(`✗ 题库里有 ${result.parseErrors.length} 个坏文件，先跑 npm run bank:check 修掉`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
      return;
    }
    console.error(`✗ 知识库索引生成失败：${err?.stack ?? err}`);
    process.exit(1);
  });
}
