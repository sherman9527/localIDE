import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QuestionDraft, Question, type CategoryId, type JudgeKind, type Question as BankQuestion, type QuestionDraft as Draft } from '@arena/shared';
import { config } from '../config.js';
import { loadBank } from './loader.js';

export interface IngestOptions {
  dir?: string;
  hiddenFile?: string;
  now?: () => Date;
}

export interface AddedItem {
  id: string;
  file: string;
}

export interface SkippedItem {
  id?: string;
  reason: 'duplicate-id' | 'same-statement';
  existingId: string;
}

export interface RejectedItem {
  index: number;
  id?: string;
  errors: string[];
}

export interface IngestReport {
  added: AddedItem[];
  skippedDuplicate: SkippedItem[];
  rejected: RejectedItem[];
  total: number;
}

const CATEGORY_PREFIX: Record<CategoryId, string> = {
  frontend: 'fe',
  algorithms: 'alg',
  sql: 'sql',
  'system-design': 'sys',
  'big-data': 'bd',
  'agent-design': 'ag',
  'hot-interviews': 'hot',
};

const KIND_SHORT: Record<JudgeKind, string> = {
  'java-junit': 'java',
  'react-vitest': 'react',
  mysql: 'mysql',
  redis: 'redis',
  pyspark: 'pyspark',
  'spark-scala': 'scala',
  'llm-rubric': 'rubric',
};

/** 题面归一化：抹掉空白与中英标点差异，让"同一道题的不同排版"撞车。 */
export function statementHash(statement: string): string {
  const normalized = statement
    .toLowerCase()
    .replace(/[\s\u{3000}]+/gu, '')
    .replace(/[，。、；：！？“”‘’（）《》【】,.;:!?"'()<>\-\u{2014}\u{2013}]/gu, '');
  return createHash('sha1').update(normalized).digest('hex');
}

function nextId(category: CategoryId, kind: JudgeKind, existing: Iterable<string>): string {
  const prefix = `${CATEGORY_PREFIX[category]}-${KIND_SHORT[kind]}-`;
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/**
 * 题库唯一的写入口：append-only。
 * 已存在的 id / 文件一律跳过，绝不覆盖、绝不删除（需求 场景 9 + rule.md C5）。
 */
export async function ingest(drafts: readonly Draft[], opts: IngestOptions = {}): Promise<IngestReport> {
  const dir = opts.dir ?? config.bankDir;
  const now = opts.now ?? (() => new Date());
  const report: IngestReport = { added: [], skippedDuplicate: [], rejected: [], total: drafts.length };

  const { questions } = await loadBank(dir);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const byHash = new Map<string, BankQuestion>();
  for (const q of questions) byHash.set(statementHash(q.statement), q);

  for (const [index, draft] of drafts.entries()) {
    const parsed = QuestionDraft.safeParse(draft);
    if (!parsed.success) {
      report.rejected.push({
        index,
        id: draft?.id,
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      continue;
    }

    const id = parsed.data.id ?? nextId(parsed.data.category, parsed.data.judgeKind, byId.keys());
    const hash = statementHash(parsed.data.statement);
    const sameStatement = byHash.get(hash);
    if (sameStatement && sameStatement.id !== id) {
      report.skippedDuplicate.push({ id, reason: 'same-statement', existingId: sameStatement.id });
      continue;
    }
    if (byId.has(id)) {
      report.skippedDuplicate.push({ id, reason: 'duplicate-id', existingId: id });
      continue;
    }

    const full = {
      ...parsed.data,
      id,
      source: { ...parsed.data.source, ingestedAt: now().toISOString() },
    };
    const validated = Question.safeParse(full);
    if (!validated.success) {
      report.rejected.push({
        index,
        id,
        errors: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      continue;
    }

    const file = join(dir, validated.data.category, `${id}.json`);
    await mkdir(join(dir, validated.data.category), { recursive: true });
    const existed = await writeFile(file, `${JSON.stringify(validated.data, null, 2)}\n`, { flag: 'wx' })
      .then(() => false)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') return true;
        throw err;
      });
    // 撞车说明磁盘上已有一个"同 id 但 loader 没收录"的文件（坏 JSON / 文件名≠id）。
    // 把它记成 added 会让刷新脚本以为新题已入库、下一轮不再补 —— 只增不减在这里会变成"悄悄变没"。
    if (existed) {
      report.rejected.push({ index, id, errors: [`目标文件已存在但没被题库 loader 收录（内容不合规或文件名与内部 id 不一致）：${file}`] });
      continue;
    }

    byId.set(id, validated.data);
    byHash.set(hash, validated.data);
    report.added.push({ id, file });
  }

  return report;
}

export function formatReport(report: IngestReport): string {
  const lines = [
    `入库 ${report.added.length} / 跳过 ${report.skippedDuplicate.length} / 拒绝 ${report.rejected.length}（候选 ${report.total}）`,
    ...report.added.map((a) => `  + ${a.id}`),
    ...report.skippedDuplicate.map((s) => `  = ${s.id ?? '?'} (${s.reason} vs ${s.existingId})`),
    ...report.rejected.map((r) => `  ! #${r.index} ${r.id ?? ''} ${r.errors.join('; ')}`),
  ];
  return lines.join('\n');
}
