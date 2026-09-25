import { describe, expect, it, vi } from 'vitest';
import { Question } from '@arena/shared';
import type { LlmProvider } from '../../src/llm/provider.js';

/** 只关心"降级有没有留下可查的痕迹"，所以把日志模块换成探针（不落盘）。 */
const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();
vi.mock('../../src/log.js', () => ({
  logInfo: (...args: unknown[]) => logInfo(...args),
  logWarn: (...args: unknown[]) => logWarn(...args),
  logError: (...args: unknown[]) => logError(...args),
  logDebug: () => undefined,
  newTraceId: () => 'trace-fixed',
  errorFields: (err: unknown) => ({ msg: String(err) }),
  flushLogs: async () => undefined,
  purgeOldLogs: async () => [],
  startLogMaintenance: () => undefined,
  stopLogMaintenance: () => undefined,
  LOG_DIR: '/tmp/arena-test-logs',
  RETENTION_DAYS: 28,
}));

const { grade } = await import('../../src/llm/rubric.js');

const question = Question.parse({
  id: 'sys-design-log-0001',
  category: 'system-design',
  difficulty: 'senior',
  title: '降级路径要不要写进日志',
  statement: '设计一个多租户导出服务，说明限流与失败重试。',
  judgeKind: 'llm-rubric',
  tags: ['rate-limit'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '限流策略', weight: 5, criteria: '给出租户级配额与突发处理' },
      { label: '失败重试', weight: 5, criteria: '幂等键 + 退避' },
    ],
  },
  answer: '参考解：令牌桶 + 幂等键。',
  source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19' },
});

function provider(kind: LlmProvider['kind'], opts: { available?: boolean; error?: Error; reply?: string } = {}): LlmProvider {
  return {
    kind,
    async available() {
      if (opts.error) throw opts.error;
      return opts.available ?? true;
    },
    async complete() {
      if (opts.error) throw opts.error;
      return opts.reply ?? '{"score":7,"rubricBreakdown":[]}';
    },
  };
}

describe('评分降级必须留痕（需求：出故障能 trace、能 fix）', () => {
  it('每一档为什么没用都被记成 warn，并带上 traceId 与题目', async () => {
    const v = await grade(question, '我的答案', [
      provider('qodercli', { available: false }),
      provider('copilot', { error: new Error('copilot 未登录') }),
      provider('bridge', { reply: '不是 JSON' }),
    ]);
    expect(v.provider).toBe('manual');

    const fallback = logWarn.mock.calls.filter(([m, e]) => m === 'grade' && e === 'fallback');
    expect(fallback.length).toBeGreaterThan(0);
    const reasons = JSON.stringify(fallback);
    expect(reasons).toContain('qodercli');
    expect(reasons).toContain('copilot 未登录');
    expect(reasons).toContain('无法解析');
    expect(fallback[0]![2]).toMatchObject({ questionId: question.id });
  });

  it('评分完成写 info，且带上调用方传进来的 traceId', async () => {
    await grade(question, '我的答案', [provider('bridge', { reply: '{"score":9,"rubricBreakdown":[]}' })], 'grade-trace-9');
    const done = logInfo.mock.calls.find(([m, e]) => m === 'grade' && e === 'done');
    expect(done?.[2]).toMatchObject({ traceId: 'grade-trace-9', provider: 'bridge', score: 9 });
  });
});
