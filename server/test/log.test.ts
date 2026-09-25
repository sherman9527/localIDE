import { readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Question, type JudgeResult, type Question as BankQuestion } from '@arena/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_DIR, flushLogs, logInfo, newTraceId, parseRetentionDays, purgeOldLogs, RETENTION_DAYS, logFileFor } from '../src/log.js';
import { config } from '../src/config.js';
import { registerRunner, runJudge } from '../src/judge/registry.js';

/** 日志必须落在仓库内、可按 traceId 捞、并按保留期清理（需求：加日志模块，28 天内）。 */

async function readToday(): Promise<Record<string, unknown>[]> {
  await flushLogs();
  return readFileSync(logFileFor(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  await flushLogs();
});

describe('结构化日志', () => {
  it('写入 data/logs/arena-<日期>.log，一行一个 JSON', async () => {
    const traceId = newTraceId('test');
    logInfo('test', 'hello', { traceId, answer: 42 });
    const records = await readToday();
    const mine = records.find((r) => r.traceId === traceId && r.event === 'hello');
    expect(mine).toMatchObject({ module: 'test', level: 'info', answer: 42 });
    expect(typeof mine?.time).toBe('string');
    // 仍在仓库内（rule.md C1），但测试写 test-logs，不与容器真实日志抢同一个文件
    expect(LOG_DIR.startsWith(join(config.repoRoot, 'data'))).toBe(true);
    expect(LOG_DIR.endsWith(process.env.NODE_ENV === 'test' ? 'test-logs' : 'logs')).toBe(true);
  });

  it('traceId 能把一次判题的 start/done 串起来', async () => {
    const fake: BankQuestion = Question.parse({
      id: 'alg-java-log-0001',
      category: 'algorithms',
      difficulty: 'senior',
      title: '日志测试用的题目标题',
      statement: '这道题只用于验证判题日志是否带上了同一个 traceId，因此它的实现与语义都不重要。',
      judgeKind: 'java-junit',
      tags: ['logging'],
      cases: [{ name: '占位用例', input: [[]], expected: 0 }],
      runner: { referenceSolution: 'class Solution{}' },
      source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z' },
    });
    registerRunner({
      kind: 'java-junit',
      async probe() {
        return true;
      },
      async run(): Promise<JudgeResult> {
        return { status: 'pass', passed: 1, failed: 0, total: 1, failedCases: [], passedCases: ['占位用例'], durationMs: 5 };
      },
    });

    const result = await runJudge({ questionId: fake.id, submission: 'x' }, fake);
    expect(result.traceId, '判题结果必须回传 traceId 给前端').toBeTruthy();
    const records = await readToday();
    const chain = records.filter((r) => r.traceId === result.traceId);
    expect(chain.map((r) => r.event)).toEqual(expect.arrayContaining(['start', 'done']));
    expect(chain.every((r) => r.questionId === fake.id)).toBe(true);
  });

  it('超过保留期的日志文件被清掉，非日志文件不碰', async () => {
    const stale = join(LOG_DIR, 'arena-2020-01-01.log');
    const keep = join(LOG_DIR, 'arena-2020-01-02-important.txt');
    const old = new Date('2020-01-01T00:00:00Z');
    writeFileSync(stale, '{}\n');
    writeFileSync(keep, '不要删我');
    utimesSync(stale, old, old);
    utimesSync(keep, old, old);
    const removed = await purgeOldLogs();
    expect(removed).toContain('arena-2020-01-01.log');
    expect(readdirSync(LOG_DIR)).toContain('arena-2020-01-02-important.txt');
    expect(RETENTION_DAYS).toBe(28);
    rmSync(keep, { force: true });
  });

  it('保留期坏值不许悄悄关掉 28 天上限', () => {
    expect(parseRetentionDays(undefined)).toBe(28);
    expect(parseRetentionDays('')).toBe(28);
    expect(parseRetentionDays('28d')).toBe(28); // NaN 会让 `mtime < NaN` 恒 false → 一个都不删
    expect(parseRetentionDays('abc')).toBe(28);
    expect(parseRetentionDays('0')).toBe(28);
    expect(parseRetentionDays('-5')).toBe(28);
    expect(parseRetentionDays('14')).toBe(14);
    expect(parseRetentionDays('7.9')).toBe(7);
  });
});
