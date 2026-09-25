import { Question, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { config } from '../../src/config.js';
import { probeStacks, runJudge } from '../../src/judge/registry.js';
import { REQUIRED_REDIS_MAJOR, redisMajorIsUsable, tokenizeRedis } from '../../src/exec/redis.js';
import '../../src/judge/runners/redis.js';

/**
 * Redis 判题：考生写命令序列，用例用只读命令验证状态。
 * 依赖容器内的 redis-server（宿主机一般没有），探测不到时整组跳过。
 */

const stacks = await probeStacks();
const redisAvailable = stacks['redis'] === true;
if (!redisAvailable) console.warn('[judge] 无可用 Redis，redis 判题测试跳过（容器内会跑）');

const guarded = redisAvailable ? it : it.skip;

function makeQuestion(over: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'sql-redis-harness-0001',
    category: 'sql',
    difficulty: 'senior',
    title: '用 Redis 有序集合实现打赏榜 Top-K 并处理同分',
    statement: '给出一段 Redis 命令序列：把三位用户的打赏写入 board 有序集合，并保证按打赏额从高到低能取到前两名。',
    judgeKind: 'redis',
    tags: ['redis', 'zset'],
    cases: [
      { name: '榜单按分数倒序', input: ['ZREVRANGE board 0 -1 WITHSCORES'], expected: ['bob', '30', 'carol', '20', 'alice', '10'] },
      { name: '榜内成员数', input: ['ZCARD board'], expected: 3 },
      { name: 'alice 的排名', input: ['ZREVRANK board alice'], expected: 2 },
    ],
    runner: {
      setup: ['DEL board'],
      referenceSolution: ['ZADD board 10 alice', 'ZADD board 30 bob', 'ZADD board 20 carol'].join('\n'),
      timeoutMs: 10_000,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...over,
  }) as BankQuestion;
}

afterAll(async () => {
  const redis = new Redis({ host: new URL(config.redis.url).hostname, port: Number(new URL(config.redis.url).port || 6379), db: 3 });
  await redis.flushdb();
  redis.disconnect();
});

describe('redis runner', () => {
  guarded('命令序列构建的榜单状态全部通过', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: question.id, submission: question.runner!.referenceSolution as string }, question);
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(3);
    expect(result.failedCases).toEqual([]);
  }, 60_000);

  guarded('忘了 WITHSCORES 时失败用例被点名', async () => {
    const question = makeQuestion();
    const submission = ['ZADD board 10 alice', 'ZADD board 30 bob', 'ZADD board 20 carol'].join('\n');
    const wrong = await runJudge({ questionId: question.id, submission }, {
      ...question,
      cases: [
        { name: '带分数的榜单', input: ['ZRANGE board 0 -1'], expected: ['x'] },
        ...question.cases!.slice(1),
      ],
    } as BankQuestion);
    expect(wrong.status).toBe('fail');
    expect(wrong.failed).toBe(1);
    expect(wrong.failedCases[0]!.name).toBe('带分数的榜单');
    expect(wrong.failedCases[0]!.message).toContain('期望');
  }, 60_000);

  guarded('FLUSHALL 被白名单拒绝且不污染其它库', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: question.id, submission: 'FLUSHALL' }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('forbidden');
    expect(result.logs).toMatch(/FLUSHALL/);
    const probe = new Redis({ host: new URL(config.redis.url).hostname, port: 6379, db: 0 });
    expect(await probe.ping()).toBe('PONG');
    probe.disconnect();
  }, 60_000);

  guarded('用例自带的校验命令也要过白名单（自测用例来自请求体，不能成为后门）', async () => {
    const question = makeQuestion({
      cases: [{ name: '危险用例', input: ['FLUSHALL'], expected: 'OK' }],
    });
    const result = await runJudge({ questionId: question.id, submission: 'PING', caseSource: 'request' }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('forbidden');
    expect(result.logs).toMatch(/FLUSHALL/);
  }, 60_000);

  guarded('两次判题互不污染（每次清空 scratch db）', async () => {
    const question = makeQuestion();
    const first = await runJudge({ questionId: question.id, submission: 'ZADD board 1 a\nZADD board 2 b' }, {
      ...question,
      cases: [{ name: '只有两个成员', input: ['ZCARD board'], expected: 2 }],
    } as BankQuestion);
    expect(first.status).toBe('pass');
    const second = await runJudge({ questionId: question.id, submission: question.runner!.referenceSolution as string }, question);
    expect(second.status).toBe('pass');
    expect(second.passed).toBe(3);
  }, 60_000);

  guarded('tokenizeRedis 支持引号参数', () => {
    expect(tokenizeRedis('SET k "hello world" EX 60')).toEqual(['SET', 'k', 'hello world', 'EX', '60']);
  });
});

/**
 * 栈探测里的版本守卫。起因是一次真实构建：Redis 7 的源码下载失败，Dockerfile 的兜底
 * 静默退回 apt 的 6.0.16，而栈健康照报 `redis:true`（它只 PING）—— 四道用 `XAUTOCLAIM` /
 * `EXPIRE … GT` 的题一路判到"参考解没过"才炸，那是最容易被误读成"题目写坏了"的报错形状。
 */
describe('Redis 版本是题目依赖，不是偏好', () => {
  it('7.x 放行；6.x 判不可用；探测拿不到版本号时不背锅', () => {
    expect(redisMajorIsUsable('# Server\r\nredis_version:7.2.7\r\nos:Linux')).toBe(true);
    expect(redisMajorIsUsable('redis_version:6.0.16')).toBe(false);
    expect(redisMajorIsUsable('redis_mode:standalone\r\n')).toBe(true); // 读不到版本 ≠ 版本不对
  });

  guarded('这台机器上跑着的 redis 必须就是那个大版本（否则镜像构建退化了，当场报）', async () => {
    const redis = new Redis({
      host: new URL(config.redis.url).hostname,
      port: Number(new URL(config.redis.url).port || 6379),
      db: 3,
    });
    try {
      const info = await redis.info('server');
      expect(
        redisMajorIsUsable(info),
        `现在是 redis_version:${/redis_version:([^\s]+)/.exec(info)?.[1]}，题目依赖 ${REQUIRED_REDIS_MAJOR}.x`,
      ).toBe(true);
    } finally {
      redis.disconnect();
    }
  });
});
