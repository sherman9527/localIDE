/**
 * 知识库（content/knowledge/<category>/README.md 考点矩阵）解析公共件。
 *
 * compile-knowledge（生成 INDEX.md）、generate-with-cli（挑考点出题）、
 * refresh-bank（算类别缺口）共用这一份解析，避免三处规则漂移。
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../jd/lib.mjs';

export const KNOWLEDGE_DIR = join(ROOT, 'content', 'knowledge');

/** 与 shared/src/taxonomy.ts 的 CATEGORY_IDS 一致；shared/dist 可用时以它为准。 */
export const FALLBACK_CATEGORIES = [
  'frontend',
  'algorithms',
  'sql',
  'system-design',
  'big-data',
  'agent-design',
  'hot-interviews',
];

export async function loadShared() {
  try {
    return await import('@arena/shared');
  } catch (err) {
    try {
      return await import(join(ROOT, 'shared', 'dist', 'index.js'));
    } catch {
      throw new Error(
        `无法加载 @arena/shared（${err.message}）。先跑 npm run build -w shared 再执行本脚本。`,
      );
    }
  }
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const HEADER_ALIASES = {
  point: ['考点', '考点名', '知识点'],
  senior: ['senior 深度要点', 'senior深度要点', '深度要点'],
  modern: ['2025-2026 新实践', '新实践', '2025 新实践'],
  form: ['可出题形式', '出题形式', '形式'],
  judgeKind: ['建议 judgekind', '建议judgekind', 'judgekind', '判分方式'],
  jdSkill: ['jd 能力项', '能力项', 'jd'],
  company: ['来源公司', '公司'],
};

function headerIndex(cells) {
  const map = {};
  cells.forEach((cell, index) => {
    const norm = cell.replace(/[*_`]/g, '').trim().toLowerCase();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[key] === undefined && aliases.some((a) => norm === a || norm.startsWith(a))) map[key] = index;
    }
  });
  return map;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

/** 第 1 列 → { tag, label, hasExplicitTag }：`中文名（\`tag-id\`）` 或纯中文名。 */
export function parsePointCell(cell) {
  const tags = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  const explicit = tags.find((t) => /^[a-z0-9][a-z0-9:._-]*$/.test(t) && !t.startsWith('http'));
  const label = cell
    .replace(/`[^`]*`/g, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[：:、,，\s]*[/-]*\s*$/, '')
    .trim();
  const derived = label
    .replace(/【([^】]*)】/g, '$1-')
    .replace(/[/、,，:：\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return { tag: explicit ?? (derived || 'untagged'), label, hasExplicitTag: Boolean(explicit) };
}

function parseForms(raw) {
  const text = (raw ?? '').toLowerCase();
  const forms = ['code', 'rubric'].filter((f) => text.includes(f));
  return { forms: forms.length ? forms : ['rubric'], primary: forms[0] ?? 'rubric' };
}

function parseKinds(raw, validKinds) {
  const tokens = (raw ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const kinds = tokens.filter((t) => validKinds.includes(t));
  return [...new Set(kinds)];
}

/**
 * 解析一份 README 里的考点矩阵表格。
 * 没有表格时返回空数组 —— 调用方（INDEX 生成器）会把它作为"缺矩阵"报出来。
 */
export function parseMatrix(markdown, { validKinds = [] } = {}) {
  const lines = markdown.split(/\r?\n/);
  const points = [];
  let cols = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      cols = null;
      continue;
    }
    const cells = splitRow(line);
    if (isSeparatorRow(cells)) continue;
    if (cols === null) {
      const candidate = headerIndex(cells);
      cols = candidate.point !== undefined && candidate.form !== undefined ? candidate : false;
      if (cols === false) continue;
      continue;
    }
    if (!cols) continue;
    const label = cells[cols.point];
    if (!label) continue;
    const { tag, label: pointLabel, hasExplicitTag } = parsePointCell(label);
    const forms = parseForms(cols.form !== undefined ? cells[cols.form] : '');
    const kinds = parseKinds(cols.judgeKind !== undefined ? cells[cols.judgeKind] : '', validKinds);
    points.push({
      tag,
      label: pointLabel,
      hasExplicitTag,
      form: forms.primary,
      forms: forms.forms,
      judgeKinds: kinds,
      senior: cols.senior !== undefined ? (cells[cols.senior] ?? '') : '',
      modern: cols.modern !== undefined ? (cells[cols.modern] ?? '') : '',
      jdSkill: cols.jdSkill !== undefined ? (cells[cols.jdSkill] ?? '') : '',
      company: cols.company !== undefined ? (cells[cols.company] ?? '') : '',
    });
  }
  return points;
}

export async function readCategoryKnowledge(category, { validKinds = [] } = {}) {
  const dir = join(KNOWLEDGE_DIR, category);
  const readmePath = join(dir, 'README.md');
  const topicFiles = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort()
    : [];
  if (!existsSync(readmePath)) {
    return { category, dir, readmePath, readmeMissing: true, points: [], topicFiles };
  }
  const markdown = await readFile(readmePath, 'utf8');
  const points = parseMatrix(markdown, { validKinds });
  const baselineLine = markdown
    .split(/\r?\n/)
    .find((l) => l.startsWith('>') && /版本|基线|核实|定位/.test(l));
  return {
    category,
    dir,
    readmePath,
    readmeMissing: false,
    points,
    topicFiles,
    title: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? category,
    baseline: baselineLine?.replace(/^>\s*/, '').trim() ?? '',
  };
}

export async function loadAllKnowledge({ categories } = {}) {
  const shared = await loadShared().catch(() => null);
  const validKinds = shared ? [...shared.JUDGE_KINDS] : [];
  const ids = categories ?? (shared ? [...shared.CATEGORY_IDS] : [...FALLBACK_CATEGORIES]);
  const out = [];
  for (const id of ids) out.push(await readCategoryKnowledge(id, { validKinds }));
  return out;
}

export { ROOT, join as pjoin };
