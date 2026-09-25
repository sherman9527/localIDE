import type { Redis } from 'ioredis';
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
import { checkRedisCommand } from '../../exec/guards.js';
import {
  commandLines,
  connect,
  nextJudgeDb,
  normalizeReply,
  redisMajorIsUsable,
  send,
  sendBatch,
  tokenizeRedis,
} from '../../exec/redis.js';
import { registerRunner } from '../registry.js';
import { errorResult, progressReporter, summarize } from '../util.js';

/**
 * redis 判题器。连接、发命令、回复归一都在 `exec/redis.ts`（与网页 IDE 共用），
 * 这里只剩判分口径：期望值比较，以及"失败要点名到哪一条用例"。
 */

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeReply(a)) === JSON.stringify(normalizeReply(b));
}

export const redisRunner: Runner = {
  kind: 'redis',

  async probe() {
    let redis: Redis | undefined;
    try {
      redis = await connect(nextJudgeDb());
      if ((await redis.ping()) !== 'PONG') return false;
      // 版本也在这条探测里：见 `exec/redis.ts` 的 `redisMajorIsUsable`（apt 的 6.0.16 会让
      // 用 `XAUTOCLAIM` / `EXPIRE … GT` 的题目报成"参考解没过"，那是最难读的报错形状）
      return redisMajorIsUsable(await redis.info('server'));
    } catch {
      return false;
    } finally {
      redis?.disconnect();
    }
  },

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const started = Date.now();
    const timeoutMs = question.runner?.timeoutMs ?? config.judge.defaultTimeoutMs;
    const progress = progressReporter(started, timeoutMs, onEvent);
    const db = nextJudgeDb();
    const setup = (question.runner?.setup ?? []).map(tokenizeRedis).filter((t) => t.length > 0);
    const cases = question.cases ?? [];

    const userCommands = commandLines(req.submission).map(tokenizeRedis);
    if (userCommands.length === 0) {
      return errorResult('sandbox', '没有检测到任何 Redis 命令', Date.now() - started);
    }
    // 用例里的校验命令也要过白名单：customCases 来自请求体，不过检查就等于给外部输入开了后门
    const caseCommands = cases.flatMap((testCase) => (Array.isArray(testCase.input) ? (testCase.input as string[]).map(tokenizeRedis) : []));
    for (const command of [...setup, ...userCommands, ...caseCommands]) {
      const check = checkRedisCommand(command);
      if (!check.ok) return errorResult('forbidden', check.reason ?? '命令被白名单拒绝', Date.now() - started);
    }

    let redis: Redis | undefined;
    try {
      redis = await connect(db);
      progress('run');
      await redis!.flushdb();
      for (const command of setup) {
        // 预置语句与提交内容走同一份白名单（上面 checkRedisCommand 已经拦过一遍），
        // 这里不再开任何"setup 可以例外"的口子 —— 原先那句"允许 setup 直接写 FLUSHDB"
        // 是假的：flushdb/flushall 都在 REDIS_FORBIDDEN 里，到不了这一行。
        // 沙箱自己那一下清库是上面的 redis.flushdb()，由 runner 代做，不经过考生命令流。
        await send(redis!, command);
      }
      const answers: unknown[] = [];
      for (const command of userCommands) {
        answers.push(await send(redis!, command));
      }

      progress('collect');
      const results: JudgeCaseResult[] = [];
      for (const [index, testCase] of cases.entries()) {
        const verify = Array.isArray(testCase.input) ? (testCase.input as string[]).map(tokenizeRedis) : [];
        let actual: unknown;
        if (verify.length > 0) {
          actual = verify.length === 1 ? await send(redis!, verify[0] as string[]) : await sendBatch(redis!, verify);
        } else {
          actual = answers[index];
        }
        const expected = testCase.expected;
        results.push(
          same(actual, expected)
            ? { name: testCase.name, passed: true }
            : {
                name: testCase.name,
                passed: false,
                expected: normalizeReply(expected),
                actual: normalizeReply(actual),
                message: `期望 ${JSON.stringify(normalizeReply(expected))}，实际 ${JSON.stringify(normalizeReply(actual))}`,
              },
        );
      }
      return summarize(results, Date.now() - started);
    } catch (err) {
      return errorResult('runtime', truncateLog(`判题过程失败：${(err as Error).message ?? String(err)}`), Date.now() - started);
    } finally {
      if (redis) {
        await redis.flushdb().catch(() => undefined);
        redis.disconnect();
      }
    }
  },
};

registerRunner(redisRunner);
