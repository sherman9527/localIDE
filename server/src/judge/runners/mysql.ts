import {
  truncateLog,
  type JudgeCaseResult,
  type JudgeEvent,
  type JudgeRequest,
  type JudgeResult,
  type Question,
  type Runner,
} from '@arena/shared';
import { config } from '../../config.js';
import { registerRunner } from '../registry.js';
import { assertSetupSql, checkSubmissionSql } from '../../exec/guards.js';
import { CLIENT_GRACE_MS, createScratchDb, disposeScratchDb, parseTsv, runSql } from '../../exec/mysql.js';
import { errorResult, lineReporter, progressReporter, summarize } from '../util.js';

function normalize(value: unknown): string {
  // 期望值里的 SQL NULL 会写成 JSON null，而 mysql 批处理输出用字符串 "NULL" 表示 —— 两者必须归一到同一个值
  if (value === null) return 'null';
  const text = String(value ?? '').trim();
  if (text === 'NULL' || text === '\\N') return 'null';
  const asNumber = Number(text);
  if (text !== '' && Number.isFinite(asNumber)) return String(Math.round(asNumber * 1e6) / 1e6);
  return text.toLowerCase();
}

function rowKey(row: readonly unknown[]): string {
  return row.map(normalize).join('|');
}

function expectedRowsOf(raw: unknown): { columns: string[] | undefined; rows: readonly (readonly unknown[])[]; orderSensitive: boolean } {
  if (Array.isArray(raw)) return { columns: undefined, rows: raw, orderSensitive: false };
  const shape = raw as { columns?: string[]; rows?: readonly (readonly unknown[])[]; orderSensitive?: boolean };
  return { columns: shape?.columns, rows: shape?.rows ?? [], orderSensitive: shape?.orderSensitive === true };
}

export const mysqlRunner: Runner = {
  kind: 'mysql',

  async probe() {
    const check = await runSql('SELECT 1', undefined);
    return check.code === 0;
  },

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const started = Date.now();
    const timeoutMs = question.runner?.timeoutMs ?? config.judge.defaultTimeoutMs;
    const progress = progressReporter(started, timeoutMs, onEvent);
    const logLine = lineReporter(onEvent);
    const setup = question.runner?.setup ?? [];
    const cases = question.cases ?? [];

    const submissionCheck = checkSubmissionSql(req.submission);
    if (!submissionCheck.ok) {
      return errorResult('forbidden', submissionCheck.reason ?? 'SQL 被白名单拒绝', Date.now() - started);
    }

    try {
      assertSetupSql(setup);
    } catch (err) {
      return errorResult('sandbox', `题目预置语句非法：${(err as Error).message}`, Date.now() - started);
    }
    // 自测面板贴进来的语句属于"外部输入"，必须按考生提交的标准过守卫，
    // 不能借"预置语句允许 DDL"这条通道以 root 执行任意 DDL/DCL
    if (req.caseSource === 'request') {
      for (const testCase of cases) {
        for (const statement of Array.isArray(testCase.input) ? (testCase.input as string[]) : []) {
          const check = checkSubmissionSql(statement);
          if (!check.ok) return errorResult('forbidden', `自测用例「${testCase.name}」的语句不被允许：${check.reason}`, Date.now() - started);
        }
      }
    } else {
      try {
        assertSetupSql(cases.flatMap((c) => (Array.isArray(c.input) ? (c.input as string[]) : [])));
      } catch (err) {
        return errorResult('sandbox', `题目预置语句非法：${(err as Error).message}`, Date.now() - started);
      }
    }

    progress('compile');
    const clientTimeoutMs = timeoutMs + CLIENT_GRACE_MS;
    const scratch = await createScratchDb(question.id, clientTimeoutMs);
    if (!scratch.db) {
      return errorResult('sandbox', truncateLog(`建判题库失败：${scratch.error ?? ''}`), Date.now() - started);
    }
    const db = scratch.db;

    try {
      const results: JudgeCaseResult[] = [];
      let executed = 0;

      for (const testCase of cases) {
        progress('run');
        const seed = [...setup, ...(Array.isArray(testCase.input) ? (testCase.input as string[]) : [])];
        for (const statement of seed) {
          const seeded = await runSql(statement, db, logLine, clientTimeoutMs);
          if (seeded.code !== 0) {
            return errorResult(
              'sandbox',
              truncateLog(`题目预置语句执行失败（${testCase.name}）：${seeded.stderr}`),
              Date.now() - started,
            );
          }
        }

        const answer = await runSql(
          `SET SESSION max_execution_time=${timeoutMs}; SET SESSION lock_wait_timeout=5; ${req.submission.replace(/;\s*$/, '')}`,
          db,
          logLine,
          clientTimeoutMs,
        );
        executed += 1;
        if (answer.timedOut) {
          results.push({ name: testCase.name, passed: false, message: `查询超过 ${timeoutMs}ms 未返回` });
          continue;
        }
        if (answer.code !== 0) {
          return errorResult(
            'runtime',
            truncateLog(`你的 SQL 在 ${testCase.name} 上执行失败：${answer.stderr}\n${answer.stdout}`),
            Date.now() - started,
          );
        }

        const actual = parseTsv(answer.stdout);
        const expected = expectedRowsOf(testCase.expected);
        const compareOrder = expected.orderSensitive || question.runner?.orderSensitive === true;
        const actualKeys = actual.rows.map(rowKey);
        const expectedKeys = expected.rows.map(rowKey);
        const mismatches: string[] = [];

        if (expected.columns && expected.columns.join('|').toLowerCase() !== actual.columns.map((c) => c.toLowerCase()).join('|')) {
          mismatches.push(`列名不一致：期望 [${expected.columns.join(', ')}]，实际 [${actual.columns.join(', ')}]`);
        }
        if (actualKeys.length !== expectedKeys.length) {
          mismatches.push(`行数不一致：期望 ${expectedKeys.length} 行，实际 ${actualKeys.length} 行`);
        } else {
          const a = compareOrder ? actualKeys : [...actualKeys].sort();
          const b = compareOrder ? expectedKeys : [...expectedKeys].sort();
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
              mismatches.push(`第 ${i + 1} 行不一致：期望 [${b[i]}]，实际 [${a[i]}]`);
              break;
            }
          }
        }

        results.push(
          mismatches.length === 0
            ? { name: testCase.name, passed: true }
            : {
                name: testCase.name,
                passed: false,
                expected: expected.rows,
                actual: actual.rows,
                message: mismatches.join('; '),
              },
        );
      }

      progress('collect');
      if (executed === 0) return errorResult('runtime', '没有任何用例被执行', Date.now() - started);
      return summarize(results, Date.now() - started);
    } finally {
      // 踢掉这个库上的孤儿连接再删库 —— 细节见 exec/mysql.ts 的 disposeScratchDb
      await disposeScratchDb(db);
    }
  },
};

registerRunner(mysqlRunner);
