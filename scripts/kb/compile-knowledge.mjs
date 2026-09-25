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
 * 覆盖判定：题目的 tags[]（含 modern: 前缀）里出现考点 tag 即算覆盖。
 * 只认**显式写在矩阵第 1 列反引号里的 tag**；没写 tag 的行无法机器判定，会单独统计并提示补 tag。
 */
import { join } from 'node:path';
import { UsageError, isMain, rel, writeTextAtomic } from '../jd/lib.mjs';
import { loadShared, readCategoryKnowledge, KNOWLEDGE_DIR } from './kit.mjs';
import { SKILLS_FILE, loadQuestions, statsByCategory, coveredQuestionIds, isExecutable } from '../bank/kit.mjs';
import { readFile } from 'node:fs/promises';

const CODE_FORM = 'code';

export function clipCell(text, max = 60) {
  const s = String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function compileKnowledgeIndex() {
  const shared = await loadShared();
  const categories = [...shared.CATEGORY_IDS];
  const { questions, errors, hiddenIds } = await loadQuestions();
  const stats = statsByCategory(questions);
  const visible = questions.filter((q) => !hiddenIds.has(q.id));

  const knowledge = [];
  for (const category of categories) {
    knowledge.push(await readCategoryKnowledge(category, { validKinds: [...shared.JUDGE_KINDS] }));
  }

  const rows = [];
  const detail = [];
  for (const kb of knowledge) {
    const catVisible = visible.filter((q) => q.category === kb.category);
    const covered = [];
    const uncovered = [];
    const untrackable = [];
    for (const point of kb.points) {
      if (!point.hasExplicitTag) {
        untrackable.push(point);
        continue;
      }
      const ids = coveredQuestionIds(point, catVisible);
      (ids.length > 0 ? covered : uncovered).push({ point, ids });
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
      ratio: covered.length + uncovered.length === 0 ? '—' : `${Math.round((covered.length / (covered.length + uncovered.length)) * 100)}%`,
      kinds,
      topics: kb.topicFiles.length,
      readmeMissing: kb.readmeMissing,
    });
    detail.push({ kb, covered, uncovered, untrackable, orphanTags: findOrphanTags(catVisible, kb.points) });
  }

  const jdGaps = await findJdGaps(knowledge, shared);
  const markdown = renderMarkdown({ rows, detail, jdGaps, parseErrors: errors, hiddenCount: hiddenIds.size, total: questions.length, categories });
  const out = join(KNOWLEDGE_DIR, 'INDEX.md');
  await writeTextAtomic(out, markdown);
  return { out, rows, jdGaps, parseErrors: errors };
}

/** 题目带了 tag，但该类别矩阵里没有任何考点含这个 tag —— 说明题面与知识库脱钩了。 */
function findOrphanTags(catQuestions, points) {
  const known = new Set();
  for (const p of points) {
    if (p.hasExplicitTag) known.add(p.tag.toLowerCase());
    known.add(p.tag.toLowerCase());
  }
  const orphans = new Map();
  for (const q of catQuestions) {
    for (const raw of q.tags) {
      const tag = raw.replace(/^modern:/, '').toLowerCase();
      if (!known.has(tag)) orphans.set(raw, [...(orphans.get(raw) ?? []), q.id]);
    }
  }
  return [...orphans.entries()].map(([tag, ids]) => ({ tag, ids })).sort((a, b) => b.ids.length - a.ids.length);
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

function renderMarkdown({ rows, detail, jdGaps, parseErrors, hiddenCount, total, categories }) {
  const now = new Date().toISOString();
  const lines = [
    '# 知识库索引（自动生成，请勿手改）',
    '',
    '> 由 `npm run kb:index`（`node scripts/kb/compile-knowledge.mjs`）生成。',
    `> 生成时间：${now}`,
    `> 输入：\`content/knowledge/<类别>/README.md\` 考点矩阵（${categories.length} 类）+ 题库 ${total} 题（其中软删除 ${hiddenCount} 题不计入"已出题"）。`,
    '> 覆盖判定：题目 `tags[]`（去掉 `modern:` 前缀）命中矩阵第 1 列反引号里的 tag 即算已覆盖；未写反引号 tag 的行列在「无显式 tag」里单独统计。',
    '',
    '## 类别总览',
    '',
    '| 类别 | 考点数 | 含 code 形式 | 含 rubric 形式 | 无显式 tag（无法判定） | 语料篇数 | 已出题（可见） | 代码题 | 主观题 | 已覆盖考点 | 未覆盖考点 | 覆盖率 | 判分方式分布 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| [\`${r.category}\`](./${r.category}/README.md) ${r.label} | ${r.points} | ${r.codePoints} | ${r.rubricPoints} | ${r.untrackable} | [${r.topics}](./${r.category}/README.md#语料文件) | ${r.questions} | ${r.code} | ${r.rubric} | ${r.covered} | ${r.uncovered} | ${r.ratio} | ${r.kinds} |`,
    );
  }
  const totalPoints = rows.reduce((s, r) => s + r.points, 0);
  const totalCovered = rows.reduce((s, r) => s + r.covered, 0);
  const totalTrackable = rows.reduce((s, r) => s + r.covered + r.uncovered, 0);
  lines.push('');
  lines.push(
    `**合计**：${totalPoints} 个考点，其中 ${totalTrackable} 个可机器判定覆盖，已覆盖 ${totalCovered} 个（${totalTrackable ? Math.round((totalCovered / totalTrackable) * 100) : 0}%）；题库 ${total} 题。`,
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
      lines.push('', `**无法自动判定覆盖（第 1 列没写反引号 tag）：${d.untrackable.length} 行** —— 修法：把考点名改成 \`中文名（\`tag-id\`）\` 格式，然后重跑本脚本。`)
      lines.push('', d.untrackable.slice(0, 8).map((p) => `- ${p.label}`).join('\n') + (d.untrackable.length > 8 ? `\n- …另有 ${d.untrackable.length - 8} 行` : ''));
    }
    if (d.orphanTags.length > 0) {
      lines.push('', `**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：${d.orphanTags.length} 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。`);
      lines.push('', d.orphanTags.slice(0, 8).map((o) => `- \`${o.tag}\`（${o.ids.length} 题：${o.ids.slice(0, 3).join(', ')}${o.ids.length > 3 ? '…' : ''}）`).join('\n'));
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

async function main() {
  try {
    const result = await compileKnowledgeIndex();
    console.log(`INDEX.md 已生成 → ${rel(result.out)}`);
    const totalPoints = result.rows.reduce((s, r) => s + r.points, 0);
    const totalCovered = result.rows.reduce((s, r) => s + r.covered, 0);
    const totalTrackable = result.rows.reduce((s, r) => s + r.covered + r.uncovered, 0);
    console.log(
      `  类别 ${result.rows.length} 个｜考点 ${totalPoints} 个（可判定 ${totalTrackable}）｜已覆盖 ${totalCovered}｜未覆盖 ${totalTrackable - totalCovered}`,
    );
    for (const r of result.rows) {
      console.log(`  - ${r.category.padEnd(15)} 考点 ${String(r.points).padStart(2)} 已出题 ${String(r.questions).padStart(2)}（代码 ${r.code}/主观 ${r.rubric}）未覆盖 ${String(r.uncovered).padStart(2)} 无tag ${r.untrackable}`);
    }
    if (result.jdGaps) console.log(`  JD 热点无对应考点：${result.jdGaps.gaps.length} 个${result.jdGaps.gaps.length ? `（${result.jdGaps.gaps.slice(0, 6).map((g) => g.tag).join(', ')}…）` : ''}`);
    if (result.parseErrors.length > 0) {
      console.error(`✗ 题库里有 ${result.parseErrors.length} 个坏文件，先跑 npm run bank:check 修掉`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
      return;
    }
    console.error(`✗ 知识库索引生成失败：${err?.stack ?? err}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
