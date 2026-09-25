import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Question, type Question as BankQuestion } from '@arena/shared';
import { config } from '../config.js';
import { loadHidden } from './hide.js';

export interface BankError {
  file: string;
  message: string;
}

export interface Bank {
  questions: BankQuestion[];
  errors: BankError[];
}

async function* walkJson(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJson(full);
    } else if (entry.name.endsWith('.json') && !NON_QUESTION_FILES.has(entry.name)) {
      yield full;
    }
  }
}

/** 题库目录里可能出现的非题目文件（例如测试把 hidden.json 放在同目录）。 */
const NON_QUESTION_FILES = new Set(['hidden.json', 'package.json', 'schema.json']);

/** 坏文件只记 error、不阻断整库加载 —— 题库能被持续刷新的前提。 */
export async function loadBank(dir: string = config.bankDir): Promise<Bank> {
  const questions: BankQuestion[] = [];
  const errors: BankError[] = [];
  const seen = new Map<string, string>();

  for await (const file of walkJson(dir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      errors.push({ file, message: `JSON 解析失败：${(err as Error).message}` });
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    items.forEach((item, index) => {
      const result = Question.safeParse(item);
      if (!result.success) {
        errors.push({
          file: items.length > 1 ? `${file}#${index}` : file,
          message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
      }
      const previous = seen.get(result.data.id);
      if (previous) {
        errors.push({ file, message: `重复 id ${result.data.id}（先出现在 ${previous}）` });
        return;
      }
      seen.set(result.data.id, file);
      questions.push(result.data);
    });
  }

  questions.sort((a, b) => a.source.ingestedAt.localeCompare(b.source.ingestedAt) || a.id.localeCompare(b.id));
  return { questions, errors };
}

export interface VisibleOptions {
  dir?: string;
  hiddenFile?: string;
}

/** 题库的对外读取口：已软删除的题目在这里被剔除（需求 场景 10）。 */
export async function visibleQuestions(opts: VisibleOptions = {}): Promise<BankQuestion[]> {
  const { questions, errors } = await loadBank(opts.dir);
  if (errors.length > 0) {
    for (const err of errors) console.warn(`[bank] 跳过坏题目 ${err.file}: ${err.message}`);
  }
  const hidden = await loadHidden(opts.hiddenFile);
  const hiddenIds = new Set(hidden.items.map((i) => i.id));
  return questions.filter((q) => !hiddenIds.has(q.id));
}
