#!/usr/bin/env node
/**
 * 用本机 CLI（qodercli → bridge → copilot）给某个类别新增题目草稿并入库（只增不减）。
 *
 *   node scripts/bank/generate-with-cli.mjs --category big-data --n 5 --dry-run
 *   node scripts/bank/generate-with-cli.mjs --category system-design --n 2
 *   node scripts/bank/generate-with-cli.mjs --category sql --n 3 --offline   # 读 content/jd-cache/drafts/sql.json
 *
 * 流程：知识库考点（未覆盖优先）+ 现有题目标题（去重）+ skills.json 的 JD 权重 + shared 的 schema 摘要
 *      → 组 prompt → 问 CLI → 抽 JSON 数组 → 规范化/校验 → ingest() 落盘（append-only）。
 * 退出码：0=有题入库或纯 dry-run；1=一条都没成功（模型输出不可用 / 全部被拒）；2=用法错误。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  UsageError,
  isMain,
  parseArgs,
  readPositiveInt,
  readCachedJds,
  rel,
  writeJsonAtomic,
} from '../jd/lib.mjs';
import { loadAllKnowledge, loadShared } from '../kb/kit.mjs';
import {
  BANK_DIR,
  JD_CACHE_DIR,
  SKILLS_FILE,
  coveredQuestionIds,
  loadQuestions,
  normalizeDraft,
  schemaBrief,
  statsByCategory,
  stripUnrecognized,
} from './kit.mjs';
import { askLlm, extractJsonArray, LlmUnavailableError } from './cli.mjs';

export const USAGE =
  '用法：node scripts/bank/generate-with-cli.mjs --category <' +
  'frontend|algorithms|sql|system-design|big-data|agent-design|hot-interviews' +
  '> --n <1..10> [--dry-run] [--offline] [--timeout-ms N] [--drafts-out <file>]';

export function draftsFileFor(category) {
  return join(JD_CACHE_DIR, 'drafts', `${category}.json`);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 选考点：优先"题库里还没被 tags 覆盖"的；同分时按该考点文本里出现的 JD 热点标签提及数加权。 */
export function pickKnowledgePoints(points, questions, { limit, skills }) {
  const skillRows = skills?.skills ?? [];
  const scored = points.map((point) => {
    const haystack = `${point.label} ${point.senior} ${point.modern} ${point.jdSkill}`.toLowerCase();
    let jdScore = 0;
    for (const row of skillRows) {
      if (haystack.includes(row.tag) || haystack.includes(String(row.label).toLowerCase())) jdScore += row.mentions;
    }
    const covered = coveredQuestionIds(point, questions).length;
    return { point, covered, score: (covered === 0 ? 100_000 : 0) + jdScore + (point.hasExplicitTag ? 20 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.point.tag.localeCompare(b.point.tag));
  return scored.slice(0, limit).map((s) => ({ ...s.point, coveredByExisting: s.covered }));
}

/** 给 prompt 的 JD 素材：本类别 skills 命中的 JD，最多 maxCount 条，返回条目 + 允许引用的 url 集合。 */
export async function pickJdMaterial(category, skills, { maxCount = 4, excerptChars = 700 } = {}) {
  const entries = await readCachedJds(JD_CACHE_DIR);
  if (entries.length === 0) return { entries: [], note: 'content/jd-cache 为空：题目只能按 origin=cli/history 出（先跑 node scripts/jd/fetch.mjs）' };
  const tagsForCategory = new Set(
    (skills?.skills ?? [])
      .filter((s) => s.category === category)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 12)
      .map((s) => s.tag),
  );
  const scored = entries.map((entry) => {
    const haystack = `${entry.title}\n${entry.excerpt}`.toLowerCase();
    let score = 0;
    for (const tag of tagsForCategory) if (haystack.includes(tag.replace(/-/g, ' ')) || haystack.includes(tag)) score += 1;
    if (entry.sourceType === 'history-manual') score -= 5; // 真抓的单条 JD（有具体职位 url）优先，人工汇总样本兜底
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url));
  return {
    entries: scored
      .slice(0, maxCount)
      .map((s) => ({ ...s.entry, excerpt: clip(s.entry.excerpt, excerptChars) })),
    note: '',
  };
}

/** 组 prompt：字段名与 judgeKind 白名单都要写死，模型才不会自由发挥。 */
export function buildPrompt({ shared, category, n, points, existingTitles, skills, jdEntries, bankStats }) {
  const kinds = shared.CATEGORY_JUDGE_KINDS[category];
  const topSkills = (skills?.skills ?? [])
    .filter((s) => s.category === category)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 10)
    .map((s) => `- ${s.tag}（${s.label}）：JD 提及 ${s.mentions} 次，来自 ${s.companies.join('/') || '未知公司'}`)
    .join('\n');
  const pointLines = points
    .map((p, i) =>
      [
        `考点 ${i + 1}｜tag=${p.hasExplicitTag ? p.tag : '（矩阵这行没写 kebab tag，请自拟 2~3 个，形如 flink-state-runtime）'}｜名称=${p.label}｜可出题形式=${p.forms.join('/')}｜建议 judgeKind=${p.judgeKinds.join('/') || '(按类别白名单)'}`,
        `   senior 深度要点：${clip(p.senior, 500)}`,
        `   2025-2026 新实践：${clip(p.modern, 500)}`,
        `   JD 能力项：${clip(p.jdSkill, 160)}`,
        p.coveredByExisting > 0 ? `   （题库已有 ${p.coveredByExisting} 题覆盖此 tag，请换一个切入角度或更深一层）` : `   （题库尚未覆盖此 tag）`,
      ].join('\n'),
    )
    .join('\n');
  const jdLines = jdEntries
    .map((e) => `- [${e.company}] ${e.title}｜${e.location}｜${e.url}\n  摘录：${clip(e.excerpt, 700)}`)    .join('\n');
  const titleLines = existingTitles.slice(0, 60).map((t) => `- ${t}`).join('\n');

  return [
    `你是资深技术面试官，为本地刷题系统出**senior / principal 级**题目。只输出结果，不要解释、不要道歉、不要输出思考过程。`,
    ``,
    `## 任务`,
    `为类别 category="${category}" 出 ${n} 道题。**只输出一个 JSON 数组**（长度 ${n}），数组里每个元素是一个题目草稿对象；除 JSON 外不得输出任何字符（不要 markdown 代码块、不要前后说明文字）。`,
    ``,
    `## 题目 JSON 的字段约束（严格遵守，多余字段会导致入库被拒）`,
    schemaBrief(shared, category),
    ``,
    `## 本类别允许的 judgeKind 白名单（只能从这里选，写错即被拒）`,
    `${kinds.join(' | ')}`,
    ``,
    `## 该类别知识库考点（出题必须落在这些考点上；tags 里必须含对应 tag，且只能是 kebab-case 英文——中文 tag 会被题库闸门拒绝）`,
    pointLines || '(考点矩阵为空，请先补 content/knowledge/' + category + '/README.md)',
    ``,
    `## JD 技术栈热度（决定"该出什么题"，优先出提及次数高的方向）`,
    topSkills || '(没有 skills.json，先跑 node scripts/jd/extract-skills.mjs)',
    ``,
    `## 可用于 source.jds 的 JD（origin="jd" 时 jds[].url 只能逐字复制下列地址；不在列表里的地址会被丢弃）`,
    jdLines || '(本地无 JD 缓存，此时 source.origin 请用 "history" 或 "cli"，且 jds 留空数组)',
    ``,
    `## 题库已有题目标题（禁止重复或近重复：换考点、换数据规模、换故障场景）`,
    titleLines || '(该类别暂无题目)',
    ``,
    `## 质量红线（会被人类逐项检查）`,
    `- 题面必须包含**具体规模数字与故障场景**（QPS/数据量/延迟/成本至少三项），并要求候选人给出可核对的推导。`,
    `- 不得写八股（"什么是 X"）；必须考"X 在什么条件下会坏 / 如何证明它对"。`,
    `- 必须含 2025-2026 年的新实践（tags 里用 modern: 前缀标出）。`,
    `- 代码题：cases 至少 3 个（含 1 个边界用例，name 里出现"空/边界/超大/重复/并列/零"等词），expected 必须是**具体值**；runner.referenceSolution 是完整可运行解（Java 需含 public class Solution；PySpark 需能在 local[*] 跑，禁止依赖 HDFS/Kafka/Hive Metastore）；runner.naiveSolution 是一段能跑但必然不过的朴素解。`,
    `- 主观题：rubric.points ≥3 条，每条 weight 为正整数且合计恰好 10，criteria 要写"答到什么程度算命中/未命中"。`,
    `- source 里写 knowledgeRef="content/knowledge/${category}/README.md#${points[0]?.tag ?? '考点'}"、era="${new Date().getFullYear()}"、addedBy="bank-generate-cli"。`,
    `- 全部中文题面（专有名词保留英文）。单题 statement 控制在 1200 字以内。`,
    ``,
    `## 输出格式示例（只示范结构，内容必须换成你出的题；注意当前类别可判分方式 ${kinds.join('/')}）`,
    JSON.stringify(
      kinds.includes('llm-rubric')
        ? [
            {
              category,
              difficulty: 'senior',
              title: '……（≥6 字）',
              statement: '## 背景\n……\n## 交付物\n……\n## 追问\n……',
              judgeKind: 'llm-rubric',
              language: 'markdown',
              tags: ['考点tag', 'modern:xxxx'],
              rubric: { maxScore: 10, points: [{ label: '……', weight: 4, criteria: '……' }], notes: '……' },
              answer: '参考答案要点（含数字推导）',
              estimatedMinutes: 30,
              source: { origin: 'jd', company: 'Airbnb', location: 'us', jds: [{ url: '逐字复制上面给过的 JD 地址', title: 'JD 标题', crawledAt: '上面给过的 crawledAt 时间' }], knowledgeRef: 'content/knowledge/.../README.md#tag', era: String(new Date().getFullYear()), addedBy: 'bank-generate-cli' },
            },
          ]
        : [
            {
              category,
              difficulty: 'senior',
              title: '……（≥6 字）',
              statement: '## 背景\n……\n## 你要实现的入口\n……\n## 约定(不变式)\n……',
              judgeKind: kinds[0],
              language: 'java',
              tags: ['考点tag', 'modern:xxxx'],
              cases: [{ name: '边界：空输入', input: [], expected: 0, visible: true, note: '为什么这组能区分' }],
              runner: { className: 'Solution', signature: 'int f(int[] a)', entry: 'function', timeoutMs: 15000, referenceSolution: 'public class Solution { ... }', naiveSolution: 'public class Solution { ...必然过不了的写法... }' },
              answer: '思路与复杂度',
              estimatedMinutes: 20,
              source: { origin: 'jd', company: 'Apple', location: 'shanghai', jds: [{ url: '逐字复制上面给过的 JD 地址', title: 'JD 标题', crawledAt: '上面给过的 crawledAt 时间' }], knowledgeRef: 'content/knowledge/.../README.md#tag', era: String(new Date().getFullYear()), addedBy: 'bank-generate-cli' },
            },
          ],
      null,
      1,
    ),
    ``,
    `现在输出 ${n} 道题的 JSON 数组。题库该类别现有 ${bankStats} 题。`,
  ].join('\n');
}

export async function loadSkillsSafe() {
  if (!existsSync(SKILLS_FILE)) {
    return { missing: true, skills: [], weightsByCategory: {}, note: `缺 ${rel(SKILLS_FILE)}：先跑 node scripts/jd/extract-skills.mjs` };
  }
  try {
    const raw = JSON.parse(await readFile(SKILLS_FILE, 'utf8'));
    const skills = Array.isArray(raw) ? raw : (raw.skills ?? []);
    const weightsByCategory = (!Array.isArray(raw) && raw.weightsByCategory) || {};
    const skillWeights = {};
    for (const s of skills) skillWeights[s.tag] = s.mentions;
    return { missing: false, skills, weightsByCategory, skillWeights };
  } catch (err) {
    return { missing: true, skills: [], weightsByCategory: {}, skillWeights: {}, note: `${rel(SKILLS_FILE)} 解析失败：${err.message}` };
  }
}

/**
 * 生成流程（dry-run / 正式都走这里）。返回 { drafts, rejected, notes, provider, promptChars }。
 */
export async function generateDrafts(opts) {
  const shared = await loadShared();
  const category = opts.category;
  if (!shared.CATEGORY_IDS.includes(category)) {
    throw new UsageError(`--category 必须是 ${shared.CATEGORY_IDS.join(' | ')}，收到 "${category}"`);
  }
  const n = opts.n;
  const { questions } = await loadQuestions(opts.bankDir ?? BANK_DIR);
  const stats = statsByCategory(questions);
  const bankStats = stats.get(category)?.total ?? 0;
  const knowledge = await loadAllKnowledge({ categories: [category] });
  const kb = knowledge[0];
  if (kb.readmeMissing) {
    throw new UsageError(`缺考点矩阵文件 ${rel(join(kb.dir, 'README.md'))}——没有它无法保证出题落在考点上，请先补该文件（需求 19：先知识库再题库）`);
  }
  if (kb.points.length === 0) {
    throw new UsageError(`${rel(join(kb.dir, 'README.md'))} 里没解析出考点表格行；表格需要表头含「考点 / 可出题形式 / 建议 judgeKind」`);
  }
  const skills = await loadSkillsSafe();
  if (skills.missing) console.warn(`⚠ ${skills.note}`);

  const points = pickKnowledgePoints(kb.points, questions, { limit: n, skills });
  const { entries: jdEntries, note: jdNote } = await pickJdMaterial(category, skills);
  if (jdNote) console.warn(`⚠ ${jdNote}`);

  const existingTitles = questions.filter((q) => q.category === category).map((q) => q.title);
  const prompt = buildPrompt({ shared, category, n, points, existingTitles, skills, jdEntries, bankStats });
  console.log(
    `prompt ${prompt.length} 字符｜考点 ${points.length} 个（${points.map((p) => p.tag).join(', ')}）｜JD 素材 ${jdEntries.length} 条`,
  );

  let rawText;
  let provider = 'offline-drafts';
  if (opts.offline) {
    const file = opts.draftsFile ?? draftsFileFor(category);
    if (!existsSync(file)) {
      throw new UsageError(
        `--offline 需要现成草稿，但 ${rel(file)} 不存在。两种办法：\n` +
          `  1) 去掉 --offline，让脚本调本机 qodercli/copilot 生成；\n` +
          `  2) 手工把 QuestionDraft[] JSON 数组写进 ${rel(file)}（字段见 npm run bank:generate -- --help）。`,
      );
    }
    const raw = JSON.parse(await readFile(file, 'utf8'));
    rawText = JSON.stringify(Array.isArray(raw) ? raw : (raw.drafts ?? []));
    provider = `offline-drafts(${rel(file)})`;
  } else {
    const answer = await askLlm(prompt, { timeoutMs: opts.timeoutMs });
    rawText = answer.text;
    provider = answer.provider;
  }

  const array = extractJsonArray(rawText);
  const kebab = /^[a-z0-9][a-z0-9:._-]*$/;
  const fallbackTags = [...points.map((p) => p.tag), category].filter((t) => kebab.test(String(t)));
  const drafts = [];
  const rejected = [];
  for (const [index, raw] of array.entries()) {
    const { draft, notes, problems } = await normalizeDraft(raw, {
      category,
      jdPool: jdEntries,
      shared,
      fallbackTags,
      notes: [`provider=${provider}`],
    });
    if (problems.length > 0) {
      rejected.push({ index, id: raw?.id, title: clip(raw?.title, 60), errors: problems });
      continue;
    }
    let parsed = shared.QuestionDraft.safeParse(draft);
    if (!parsed.success) {
      const dropped = stripUnrecognized(parsed, draft);
      if (dropped.length > 0) {
        notes.push(`剥掉 schema 不认的字段：${[...new Set(dropped)].join(', ')}`);
        parsed = shared.QuestionDraft.safeParse(draft);
      }
    }
    if (!parsed.success) {
      rejected.push({
        index,
        id: draft.id,
        title: clip(draft.title, 60),
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      continue;
    }
    drafts.push(parsed.data);
    for (const note of notes) console.log(`  · 草稿 #${index + 1}：${note}`);
  }
  return { category, drafts, rejected, provider, promptChars: prompt.length, points, jdEntries, skillsNote: skills.missing ? skills.note : '' };
}

export function printDryRun(result) {
  console.log(`\n--dry-run：拿到 ${result.drafts.length} 条草稿（拒绝 ${result.rejected.length} 条），provider=${result.provider}，不落盘。`);
  for (const [index, draft] of result.drafts.slice(0, 3).entries()) {
    console.log(`\n草稿 ${index + 1}《${draft.title}》`);
    console.log(`  id(待 ingest 分配) category=${draft.category} judgeKind=${draft.judgeKind} difficulty=${draft.difficulty} language=${draft.language ?? '-'} 预计 ${draft.estimatedMinutes}min`);
    console.log(`  tags: ${(draft.tags ?? []).join(', ')}`);
    console.log(`  statement: ${draft.statement.length} 字，开头：${clip(draft.statement, 90)}`);
    if (draft.rubric) {
      const sum = draft.rubric.points.reduce((s, p) => s + p.weight, 0);
      console.log(`  rubric: ${draft.rubric.points.length} 个考点，权重合计 ${sum}（${sum === 10 ? 'OK' : '必须是 10'}）：${draft.rubric.points.map((p) => `${p.label}=${p.weight}`).join(', ')}`);
    }
    if (draft.cases) {
      console.log(`  cases: ${draft.cases.length} 个（${draft.cases.map((c) => c.name).slice(0, 3).join(' / ')}${draft.cases.length > 3 ? ' …' : ''}）`);
      console.log(`  runner: referenceSolution=${draft.runner?.referenceSolution ? `${draft.runner.referenceSolution.length} 字` : '缺失'} naiveSolution=${draft.runner?.naiveSolution ? `${draft.runner.naiveSolution.length} 字` : '缺失'} entry=${draft.runner?.entry ?? '-'}`);
    }
    console.log(`  source: origin=${draft.source.origin} company=${draft.source.company ?? '-'} jds=${(draft.source.jds ?? []).length} 条 era=${draft.source.era ?? '-'}`);
  }
  if (result.drafts.length > 3) console.log(`\n…另外 ${result.drafts.length - 3} 条只列标题：`);
  for (const draft of result.drafts.slice(3)) console.log(`  - ${draft.title}`);
  for (const item of result.rejected) console.log(`  ✗ 草稿 #${item.index + 1}《${item.title}》被拒：${item.errors.join('; ')}`);
}

async function ingestDrafts(drafts, category) {
  const file = join(ROOT, 'server', 'dist', 'bank', 'ingest.js');
  if (!existsSync(file)) {
    throw new UsageError(
      `找不到题库唯一写入口 ${rel(file)}。先跑 npm run build（或 npm run build -w shared && npm run build -w server）再重跑；\n` +
        `  只想看草稿形状请加 --dry-run；想完全不碰 CLI 就用 --offline（读 content/jd-cache/drafts/${category}.json）。`,
    );
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.ingest !== 'function') {
    throw new UsageError(`${rel(file)} 里没有导出 ingest()——server 构建可能不完整，重跑 npm run build -w server`);
  }
  const report = await mod.ingest(drafts);
  console.log(`\n入库报告（category=${category}）：`);
  console.log(mod.formatReport(report));
  return report;
}

/**
 * 单个类别的完整一次跑：生成 → （dry-run 打印 | 存草稿 + ingest 入库）。
 * 供 CLI 与 refresh-bank 共用，返回结构化摘要（失败不抛，写进 error 字段）。
 */
export async function runGenerate(opts) {
  const category = opts.category;
  const summary = { category, n: opts.n, dryRun: Boolean(opts.dryRun), added: 0, skipped: 0, rejected: 0, drafts: 0, provider: '', error: null };
  try {
    const result = await generateDrafts({ ...opts, draftsFile: opts.draftsFile });
    summary.provider = result.provider;
    summary.drafts = result.drafts.length;
    summary.rejected = result.rejected.length;
    summary.points = result.points.map((p) => p.tag);
    if (opts.dryRun) {
      printDryRun(result);
      if (result.drafts.length === 0) summary.error = `dry-run：没有可用草稿（拒绝 ${result.rejected.length} 条）`;
      else if (result.rejected.length > 0) summary.notes = `${result.rejected.length} 条被拒（未入库）`;
      return summary;
    }
    if (result.drafts.length === 0) {
      summary.error = `一条可用草稿都没有（拒绝 ${result.rejected.length} 条）`;
      for (const item of result.rejected) console.error(`  - #${item.index + 1}《${item.title}》：${item.errors.join('; ')}`);
      console.error(`  下一步：把 --n 调小到 2、或加 --timeout-ms 300000 再试；仍失败就手工写 content/jd-cache/drafts/${category}.json 后用 --offline。`);
      return summary;
    }
    if (!opts.skipDraftArchive) {
      const file = opts.draftsOut ? join(process.cwd(), opts.draftsOut) : draftsFileFor(category);
      await writeJsonAtomic(file, { category, provider: result.provider, generatedAt: new Date().toISOString(), drafts: result.drafts });
      console.log(`草稿已存档：${rel(file)}（下次可用 --offline 复用）`);
    }
    const report = await ingestDrafts(result.drafts, category);
    summary.added = report.added.length;
    summary.skipped = report.skippedDuplicate.length;
    summary.rejected += report.rejected.length;
    summary.ingestReport = report;
    const after = await loadQuestions(BANK_DIR);
    const stats = statsByCategory(after.questions);
    console.log(
      `题库现状：共 ${after.questions.length} 题，${category} ${stats.get(category)?.total ?? 0} 题` +
        `（代码题 ${stats.get(category)?.code ?? 0} / 主观题 ${stats.get(category)?.rubric ?? 0}）`,
    );
    if (report.added.length === 0) console.warn('⚠ 没有新题入库（全是重复或被拒）。已有题目未受影响。');
    return summary;
  } catch (err) {
    if (err instanceof UsageError || err instanceof LlmUnavailableError) {
      summary.error = err.message.split('\n')[0];
      console.error(`✗ ${err.message}`);
      return summary;
    }
    throw err;
  }
}

function argsToOpts(args) {
  return {
    category: args.category,
    n: readPositiveInt(args.n, '--n', 5),
    offline: Boolean(args.offline),
    dryRun: Boolean(args['dry-run']),
    timeoutMs: args['timeout-ms'] === undefined ? undefined : readPositiveInt(args['timeout-ms'], '--timeout-ms', 180_000),
    draftsFile: args['drafts-file'] ? join(process.cwd(), args['drafts-file']) : undefined,
    draftsOut: args['drafts-out'],
    skipDraftArchive: Boolean(args['no-drafts']),
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'offline', 'help', 'no-drafts'] });
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
    return;
  }
  if (args.help) {
    console.log(`${USAGE}\n\n离线草稿文件位置：content/jd-cache/drafts/<category>.json（{ drafts: QuestionDraft[] } 或 QuestionDraft[]）`);
    console.log('provider 探测：node scripts/bank/cli.mjs');
    return;
  }
  try {
    if (!args.category) throw new UsageError(`缺 --category 参数\n${USAGE}`);
    const opts = argsToOpts(args);
    if (opts.n > 10) throw new UsageError(`--n=${opts.n} 太大：一次最多 10 题（否则模型输出常被截断）`);
    const summary = await runGenerate(opts);
    if (!args['dry-run']) console.log('建议接着跑：npm run bank:check && npm run kb:index && node scripts/curriculum.mjs');
    else console.log('\n（--dry-run：没有写题库，也没有写 drafts；去掉该参数才真正入库）');
    if (summary.error) process.exit(1);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}\n${USAGE}`);
      process.exit(2);
      return;
    }
    console.error(`✗ 生成失败：${err?.stack ?? err}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
