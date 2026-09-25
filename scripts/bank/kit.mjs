/**
 * 题库侧公共件：读题、schema 约束摘要、草稿规范化与校验。
 *
 * 为什么不依赖 server/dist：脚本必须能在"刚 clone 下来、还没 build"时被人类跑到，
 * 因此这里直接解析 content/questions 下的 json，并用 @arena/shared 的 Question schema 校验，
 * 与 server/src/bank/loader.ts 同一套规则（规则只有一份，在 shared 里）。
 * 只有"写题"这件事必须走 server/dist/bank/ingest.js —— 那是唯一的写入口，不允许第二份实现。
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, classifyLocation } from '../jd/lib.mjs';
import { loadShared } from '../kb/kit.mjs';

export const BANK_DIR = join(ROOT, 'content', 'questions');
export const JD_CACHE_DIR = join(ROOT, 'content', 'jd-cache');
export const SKILLS_FILE = join(JD_CACHE_DIR, 'skills.json');
export const HIDDEN_FILE = join(ROOT, 'content', 'hidden.json');

export const DRAFT_ORIGIN_ALLOWLIST = ['manual', 'jd', 'cli', 'history'];

/** 读全库（含软删除题——刷新脚本要知道"历史上出过什么"才能避免重复出题）。 */
export async function loadQuestions(dir = BANK_DIR) {
  const shared = await loadShared();
  const files = [];
  if (existsSync(dir)) walk(dir, files);
  const questions = [];
  const errors = [];
  for (const file of files.sort()) {
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      errors.push({ file, message: `JSON 解析失败：${err.message}` });
      continue;
    }
    const items = Array.isArray(raw) ? raw : [raw];
    items.forEach((item, index) => {
      const parsed = shared.Question.safeParse(item);
      if (!parsed.success) {
        errors.push({
          file: items.length > 1 ? `${file}#${index}` : file,
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
      }
      questions.push(parsed.data);
    });
  }
  const hidden = await loadHiddenIds();
  return {
    shared,
    questions,
    errors,
    hiddenIds: hidden,
    visible: questions.filter((q) => !hidden.has(q.id)),
  };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.json') && !['hidden.json', 'package.json', 'schema.json'].includes(entry.name)) out.push(full);
  }
}

async function loadHiddenIds() {
  if (!existsSync(HIDDEN_FILE)) return new Set();
  try {
    const raw = JSON.parse(await readFile(HIDDEN_FILE, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return new Set(items.map((i) => String(i.id ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function isExecutable(kind) {
  return kind !== 'llm-rubric';
}

export function statsByCategory(questions) {
  const stats = new Map();
  for (const q of questions) {
    const s = stats.get(q.category) ?? {
      category: q.category,
      total: 0,
      code: 0,
      rubric: 0,
      kinds: {},
      tags: new Set(),
      solvableCode: 0,
    };
    s.total += 1;
    s.kinds[q.judgeKind] = (s.kinds[q.judgeKind] ?? 0) + 1;
    if (isExecutable(q.judgeKind)) {
      s.code += 1;
      if (q.runner?.referenceSolution) s.solvableCode += 1;
    } else {
      s.rubric += 1;
    }
    for (const t of q.tags) s.tags.add(t);
    stats.set(q.category, s);
  }
  return stats;
}

/** 供 INDEX.md 与生成器复用：某考点被哪些题目覆盖（含 modern: 前缀与 knowledgeRef 兜底）。 */
export function coveredQuestionIds(point, questions) {
  const needle = point.tag.toLowerCase();
  return questions
    .filter((q) =>
      q.tags.some((t) => {
        const v = t.toLowerCase();
        return v === needle || v === `modern:${needle}` || (v.includes(':') && v.endsWith(`:${needle}`));
      }),
    )
    .map((q) => q.id);
}

/** shared 里的类别↔判分方式映射，直接读常量而不是手抄，避免 prompt 与契约漂移。 */
export function schemaBrief(shared, category) {
  const kinds = shared.CATEGORY_JUDGE_KINDS[category] ?? [];
  const lines = [
    `顶层字段（不得增删）：schemaVersion, id(可省略), category, difficulty, title, statement, judgeKind, language, tags, cases, rubric, answer, runner, estimatedMinutes, source`,
    `本类别 category="${category}" 允许的 judgeKind 只有：${kinds.join(' | ')}`,
    `difficulty ∈ senior | principal（不接受 easy/medium）`,
    `tags：1~6 个，kebab-case，允许 modern: 前缀（例："modern:streaming-aqe"）`,
    `statement：至少 20 字，建议用中文 markdown，含"背景 / 你要实现的入口 / 约定(不变式) / 输出契约"`,
    `estimatedMinutes：1~90 的整数（缺省 20）`,
    `language ∈ java | typescript | sql | python | markdown`,
    `source（草稿期字段）：{ origin, company?, role?, location?, jds[], knowledgeRef?, era?, addedBy? }，origin ∈ manual | jd | cli | history`,
    `origin="jd" 时 jds[] 必须至少 1 条：{ url(绝对地址), title(≥3字), crawledAt }`,
    `location ∈ shanghai | us | remote | other`,
  ];
  if (kinds.some(isExecutable)) {
    lines.push(
      `代码题（judgeKind=${kinds.filter(isExecutable).join(', ')}）必须：cases[] ≥ 3 个 { name, input, expected, visible?, note? }，且 runner.referenceSolution 是完整可编译/可运行的参考解，runner.naiveSolution 是"看着像答案但必然不过"的朴素解`,
      `runner 可选字段：className, method, signature, entry(function|script|sql，只有 pyspark 读), files[{path,content}], setup[], orderSensitive, timeoutMs(1..180000)`,
    );
  }
  if (kinds.includes('llm-rubric')) {
    lines.push(
      `主观题（judgeKind=llm-rubric）必须：rubric.maxScore=10，rubric.points[] ≥ 3 个 { label, weight(正整数), criteria }，weight 合计恰好 10；且不得带 cases、不得带 runner`,
    );
  }
  return lines.join('\n');
}

function pickKeys(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

export function jdRefFromEntry(entry) {
  return {
    url: entry.url,
    title: entry.title.slice(0, 300),
    crawledAt: entry.crawledAt,
    ...(entry.company ? { company: entry.company } : {}),
  };
}

/** 题库闸门（server/test/bank/content.test.ts）认的 tag 形状；中文/空格 tag 会让整库变红，必须挡在入库前。 */
const TAG_RE = /^[a-z0-9][a-z0-9:._-]*$/;

export function sanitizeTags(tags, { fallback = [] } = {}) {
  const kept = [];
  const dropped = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw).trim().toLowerCase().replace(/\s+/g, '-');
    (TAG_RE.test(t) ? kept : dropped).push(t || String(raw));
  }
  const unique = [...new Set(kept)].slice(0, 6);
  if (unique.length === 0) return { tags: [...new Set(fallback.map((t) => String(t).toLowerCase()))].filter((t) => TAG_RE.test(t)).slice(0, 3), dropped };
  return { tags: unique, dropped };
}

/**
 * 把模型（或离线草稿文件）给的原始对象收敛成 QuestionDraft。
 * 只做"契约要求的"修正：剥掉 schema 不认的键、补默认值、把 origin/jds 调成正经出处。
 * 返回 { draft, notes, problems }；problems 非空表示不该入库。
 */
export async function normalizeDraft(raw, { category, jdPool = [], shared, fallbackTags = [], notes: baseNotes = [] } = {}) {
  const sharedMod = shared ?? (await loadShared());
  const notes = [...baseNotes];
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { draft: null, notes, problems: ['不是 JSON 对象'] };
  }
  const draft = { ...raw };

  if (draft.category !== category) {
    notes.push(`category 从 "${draft.category}" 改写为 "${category}"（题目必须落在请求的类别里）`);
    draft.category = category;
  }
  if (draft.schemaVersion === undefined) draft.schemaVersion = 1;
  else if (draft.schemaVersion !== 1) {
    notes.push(`schemaVersion 从 ${draft.schemaVersion} 修正为 1`);
    draft.schemaVersion = 1;
  }
  if (draft.estimatedMinutes === undefined) draft.estimatedMinutes = 20;
  if (draft.difficulty !== 'senior' && draft.difficulty !== 'principal') {
    notes.push(`difficulty "${draft.difficulty}" 非法 → senior（需求：只对标 senior/principal）`);
    draft.difficulty = 'senior';
  }

  const allowedKinds = sharedMod.CATEGORY_JUDGE_KINDS[category] ?? [];
  if (!allowedKinds.includes(draft.judgeKind)) {
    const guess = allowedKinds.length === 1 ? allowedKinds[0] : allowedKinds.includes('llm-rubric') ? 'llm-rubric' : allowedKinds[0];
    if (!guess) problems.push(`类别 ${category} 没有可用 judgeKind`);
    else {
      notes.push(`judgeKind "${draft.judgeKind}" 不属于本类别 → ${guess}`);
      draft.judgeKind = guess;
    }
  }

  if (Array.isArray(draft.tags)) {
    const { tags: fixed, dropped } = sanitizeTags(draft.tags, { fallback: [...fallbackTags, category] });
    if (dropped.length > 0) notes.push(`丢掉不合规 tag（闸门只认 kebab-case）：${dropped.join(', ')}`);
    if (fixed.length !== new Set(draft.tags).size) notes.push('tags 去重/小写化');
    draft.tags = fixed;
  } else {
    problems.push('tags 缺失或不是数组');
    draft.tags = [];
  }
  if (draft.tags.length === 0) problems.push(`tags 至少 1 个且必须是 kebab-case（本次给的都不合规；兜底用 "${category}" 也失败）`);

  const source = { ...pickKeys(draft.source ?? {}, ['company', 'role', 'location', 'origin', 'jds', 'knowledgeRef', 'era', 'addedBy']) };
  if (!DRAFT_ORIGIN_ALLOWLIST.includes(source.origin)) {
    notes.push(`source.origin "${source.origin}" 非法 → cli（脚本生成的题）`);
    source.origin = 'cli';
  }
  source.jds = Array.isArray(source.jds) ? source.jds : [];
  if (source.origin === 'jd') {
    const known = new Map(jdPool.map((e) => [e.url, e]));
    const kept = source.jds
      .map((jd) => (typeof jd === 'string' ? { url: jd, title: known.get(jd)?.title ?? jd.slice(0, 120), crawledAt: known.get(jd)?.crawledAt ?? new Date().toISOString() } : jd))
      .filter((jd) => jd?.url && known.has(jd.url))
      .map((jd) => jdRefFromEntry(known.get(jd.url)));
    const unique = [...new Map(kept.map((j) => [j.url, j])).values()];
    if (unique.length === 0) {
      if (jdPool.length === 0) {
        problems.push('source.origin=jd 但本地没有任何 JD 缓存可引用（先跑 node scripts/jd/fetch.mjs 或 --offline 走 history 样本）');
      } else {
        source.jds = unique.concat(jdPool.slice(0, 2).map(jdRefFromEntry));
        notes.push('source.jds 里的 url 不在缓存里 → 换成实际喂给模型的 JD 前 2 条');
      }
    } else {
      source.jds = unique;
      if (unique.length !== source.jds.length) notes.push('丢掉了缓存里不存在的 source.jds 条目');
    }
  } else {
    source.jds = source.jds.filter((jd) => typeof jd?.url === 'string' && jd.url);
  }
  if (category === 'hot-interviews' && !source.company) {
    if (jdPool[0]?.company) {
      source.company = jdPool[0].company;
      notes.push(`hot-interviews 缺 source.company → 用 JD 里的 "${source.company}"`);
    } else problems.push('hot-interviews 必须带 source.company（需求：高频题显示来源公司）');
  }
  if (!source.era) source.era = String(new Date().getFullYear());
  if (!source.addedBy) source.addedBy = 'bank-generate-cli';
  if (source.location && !['shanghai', 'us', 'remote', 'other'].includes(source.location)) {
    const guess = classifyLocation(source.location);
    notes.push(`source.location "${source.location}" → ${guess}`);
    source.location = guess;
  }
  draft.source = source;

  if (draft.judgeKind === 'llm-rubric') {
    delete draft.cases;
    delete draft.runner;
    const rubric = draft.rubric;
    if (!rubric || !Array.isArray(rubric.points) || rubric.points.length < 3) {
      problems.push('主观题缺 rubric.points（需要 ≥3 条，权重合计 10）');
    } else {
      rubric.maxScore = 10;
      rubric.points = rubric.points
        .map((p) => ({
          label: String(p.label ?? '').trim(),
          weight: Number(p.weight),
          ...(p.criteria ? { criteria: String(p.criteria).trim() } : {}),
        }))
        .filter((p) => p.label.length >= 2 && Number.isInteger(p.weight) && p.weight > 0);
      const sum = rubric.points.reduce((s, p) => s + p.weight, 0);
      if (rubric.points.length < 3) problems.push(`rubric.points 规范化后只剩 ${rubric.points.length} 条（需 ≥3）`);
      else if (sum !== 10) problems.push(`rubric 权重合计 ${sum} ≠ 10（不自动改分，避免把考点权重改错）`);
    }
  } else {
    delete draft.rubric;
    const cases = Array.isArray(draft.cases) ? draft.cases : [];
    if (cases.length < 3) problems.push(`代码题 cases 只有 ${cases.length} 个（闸门要求 ≥3，且至少 1 个边界用例）`);
    draft.cases = cases.map((c, i) => ({
      name: String(c?.name ?? `case-${i + 1}`).slice(0, 200),
      input: c?.input,
      expected: c?.expected,
      visible: c?.visible === undefined ? true : Boolean(c.visible),
      ...(c?.note ? { note: String(c.note) } : {}),
    }));
    const runner = { ...pickKeys(draft.runner ?? {}, ['className', 'method', 'signature', 'entry', 'files', 'setup', 'orderSensitive', 'timeoutMs', 'referenceSolution', 'naiveSolution']) };
    if (!runner.referenceSolution) problems.push('代码题缺 runner.referenceSolution（判题矩阵无法自证）');
    if (!runner.naiveSolution) notes.push('缺 runner.naiveSolution：题能入库，但反向判分矩阵测不到（建议重出）');
    if (runner.timeoutMs !== undefined) {
      const t = Number(runner.timeoutMs);
      // 以前这里是"超范围就删掉"——删掉等于退回 schema 默认 20s，Spark 题必然超时，
      // 而草稿看起来一切正常。改成报 problem，让出题的人当场知道。
      if (!Number.isInteger(t) || t <= 0 || t > 180_000) {
        problems.push(`runner.timeoutMs=${runner.timeoutMs} 不在 1..180000 的整数范围内（schema 会直接拒收）`);
      }
    }
    draft.runner = runner;
    if (!draft.language) draft.language = defaultLanguage(draft.judgeKind);
  }
  if (draft.language === undefined) delete draft.language;
  if (!draft.answer) notes.push('缺 answer（参考答案要点）——主观题评分与复盘会受影响');
  if (typeof draft.title !== 'string' || draft.title.trim().length < 6) problems.push('title 需要 ≥6 字');
  if (typeof draft.statement !== 'string' || draft.statement.trim().length < 20) problems.push('statement 需要 ≥20 字');
  if (draft.id !== undefined && !/^[a-z0-9][a-z0-9._-]{3,60}$/.test(String(draft.id))) {
    notes.push(`非法 id "${draft.id}" 已删除，交给 ingest 自动编号`);
    delete draft.id;
  }
  return { draft, notes, problems };
}

function defaultLanguage(judgeKind) {
  switch (judgeKind) {
    case 'java-junit':
      return 'java';
    case 'react-vitest':
      return 'typescript';
    case 'mysql':
    case 'redis':
      return 'sql';
    case 'pyspark':
      return 'python';
    case 'spark-scala':
      return 'java';
    case 'llm-rubric':
      return 'markdown';
    default:
      return undefined;
  }
}

/** zod 的 strict 模式会因模型多写的键整条拒收；这里按报错把多余键剥掉再试一次。 */
export function stripUnrecognized(parsed, draft) {
  const issues = parsed.error?.issues ?? [];
  const dropped = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    const path = issue.path ?? [];
    let target = draft;
    for (const key of path) {
      if (target == null) break;
      target = target[key];
    }
    if (!target || typeof target !== 'object') continue;
    for (const key of issue.keys ?? []) {
      if (key in target) {
        delete target[key];
        dropped.push([...path, key].join('.') || key);
      }
    }
  }
  return dropped;
}
