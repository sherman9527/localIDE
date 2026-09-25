import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Question } from '@arena/shared';
import { HIDDEN_FILE } from './env.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BANK_DIR = process.env.ARENA_BANK_DIR ?? join(REPO_ROOT, 'content', 'questions');

export function allQuestions(): Question[] {
  const out: Question[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json') && entry.name !== 'hidden.json') {
        try {
          // 内容 agent 会并发改题库，半写入的文件跳过而不是让整条 E2E 崩掉
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as Question | Question[];
          out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          /* 忽略还没写完的题目文件 */
        }
      }
    }
  };
  walk(BANK_DIR);
  return out;
}

/** 被测实例用的软删账本（独立实例下是 data/e2e/hidden.json，见 env.ts）。 */
export function hiddenIds(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')) as { items?: { id: string }[] };
    return new Set((parsed.items ?? []).map((i) => i.id));
  } catch {
    return new Set();
  }
}

/** E2E 直接读题库拿参考解（API 故意不返回它，见 rule.md C7）。 */
export function referenceOf(id: string): string {
  const question = allQuestions().find((q) => q.id === id);
  const solution = question?.runner?.referenceSolution;
  if (!solution) throw new Error(`题库里找不到 ${id} 的参考解`);
  return solution;
}

export function firstJudgeable(category?: string): Question {
  const hidden = hiddenIds();
  const found = allQuestions().find(
    (q) => q.judgeKind !== 'llm-rubric' && !hidden.has(q.id) && (!category || q.category === category),
  );
  if (!found) throw new Error(`题库里没有可判分题目${category ? `（类别 ${category}）` : ''}，先跑内容生成`);
  return found;
}

export function firstSubjective(category?: string): Question {
  const hidden = hiddenIds();
  const found = allQuestions().find(
    (q) => q.judgeKind === 'llm-rubric' && !hidden.has(q.id) && (!category || q.category === category),
  );
  if (!found) throw new Error('题库里没有主观题');
  return found;
}
