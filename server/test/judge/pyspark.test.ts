import { readdir } from 'node:fs/promises';
import { Question, type JudgeResult, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { runJudge } from '../../src/judge/registry.js';
import { pysparkRunner } from '../../src/judge/runners/pyspark.js';
import { stopSparkPool } from '../../src/exec/spark-pool.js';

/**
 * pyspark runner（需求 场景 3/4/16）：常驻 SparkSession worker + 行分隔 JSON 协议，
 * 真跑 PySpark / Spark SQL 并按行集合判分。宿主机无 pyspark 时整体 skip（容器内会跑）。
 */

const SCHEMA = 'user_id string, amount double';

/** entry=function：用户写 def solve(df) 返回 DataFrame。 */
const FUNC_CORRECT = `import pyspark.sql.functions as F


def solve(df):
    return (
        df.groupBy("user_id")
          .agg(
              F.coalesce(F.sum("amount"), F.lit(0.0)).alias("total"),
              F.count("*").alias("n"),
          )
          .select("user_id", "total", "n")
    )
`;

/** 用 avg 代替 sum、countDistinct 代替 count：空输入用例侥幸通过，其余全挂。 */
const FUNC_WRONG = `import pyspark.sql.functions as F


def solve(df):
    return (
        df.groupBy("user_id")
          .agg(F.avg("amount").alias("total"), F.countDistinct("user_id").alias("n"))
    )
`;

const FUNC_THROWS = `def solve(df):
    raise ValueError("boom in user code")
`;

const SQL_CORRECT = 'SELECT user_id, SUM(amount) AS total FROM orders GROUP BY user_id ORDER BY total DESC';
const SQL_WRONG = 'SELECT user_id, COUNT(amount) AS total FROM orders GROUP BY user_id ORDER BY total DESC';

const SQL_SETUP = [
  `CREATE OR REPLACE TEMP VIEW orders AS SELECT * FROM VALUES ('seed', CAST(0 AS DOUBLE)) AS t(user_id, amount)`,
];

const ORDER_CASE = {
  name: '按 GMV 倒序输出',
  input: {
    view: 'orders',
    rows: [
      { user_id: 'a', amount: 10.0 },
      { user_id: 'a', amount: 20.0 },
      { user_id: 'b', amount: 5.0 },
    ],
  },
  expected: [
    { user_id: 'b', total: 5.0 },
    { user_id: 'a', total: 30.0 },
  ],
};

function makeQuestion(overrides: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'bd-pyspark-harness-0001',
    category: 'big-data',
    difficulty: 'senior',
    title: '订单流按 user_id 聚合 GMV 与笔数',
    statement: '给定订单 DataFrame（user_id, amount），按 user_id 聚合出 total（金额求和，全为 null 时记 0）与 n（笔数），返回 DataFrame。',
    judgeKind: 'pyspark',
    language: 'python',
    tags: ['spark', 'dataframe', 'aggregation'],
    cases: [
      { name: '空输入返回空结果', input: { rows: [], schema: SCHEMA }, expected: [] },
      {
        name: '单用户多笔金额求和',
        input: {
          rows: [
            { user_id: 'a', amount: 10.0 },
            { user_id: 'a', amount: 5.0 },
          ],
        },
        expected: [{ user_id: 'a', total: 15.0, n: 2 }],
      },
      {
        name: '多用户聚合且与行序无关',
        input: {
          rows: [
            { user_id: 'a', amount: 10.0 },
            { user_id: 'b', amount: 5.0 },
            { user_id: 'a', amount: 20.0 },
          ],
        },
        expected: [
          { user_id: 'b', total: 5.0, n: 1 },
          { user_id: 'a', total: 30.0, n: 2 },
        ],
      },
      {
        name: '金额全为 null 时记 0 但笔数照算',
        input: {
          rows: [
            { user_id: 'z', amount: null },
            { user_id: 'z', amount: null },
          ],
          schema: SCHEMA,
        },
        expected: [{ user_id: 'z', total: 0, n: 2 }],
      },
    ],
    runner: {
      entry: 'function',
      timeoutMs: 90_000,
      referenceSolution: FUNC_CORRECT,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...overrides,
  }) as BankQuestion;
}

function makeSqlQuestion(overrides: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'bd-sparksql-harness-0001',
    category: 'big-data',
    difficulty: 'senior',
    title: 'Spark SQL：按用户汇总订单金额',
    statement: '对临时视图 orders(user_id, amount) 写一段 Spark SQL，按 user_id 汇总金额并输出 user_id 与 total（按 total 倒序）。',
    judgeKind: 'pyspark',
    language: 'sql',
    tags: ['spark-sql', 'aggregation'],
    cases: [ORDER_CASE],
    runner: {
      entry: 'sql',
      setup: SQL_SETUP,
      timeoutMs: 90_000,
      referenceSolution: SQL_CORRECT,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...overrides,
  }) as BankQuestion;
}

/** 必须顶层 await：describe 回调在 collect 阶段执行，beforeAll 里再赋值来不及。 */
const available = await pysparkRunner.probe().catch(() => false);
if (!available) console.warn('[judge] 本机无 pyspark，pyspark 判题测试跳过（容器内会跑）');

/** 本 fixture 的题目 id 前缀（并发跑的其它判题 suite 也会往 data/judge 里开沙箱）。 */
const MY_PREFIXES = ['bd-pyspark-harness-0001', 'bd-sparksql-harness-0001'];
const isMine = (name: string) => MY_PREFIXES.some((p) => name.startsWith(p));

/**
 * 判题后无残留（需求 场景 6/14/18）：自己的沙箱硬断言；
 * 并发跑的其它判题 suite（含另一个容器，./data 是共享挂载）也会开沙箱，故只告警。
 */
afterAll(async () => {
  await stopSparkPool();
  const deadline = Date.now() + 30_000;
  let leftovers: string[] = [];
  do {
    leftovers = await readdir(config.judgeWorkDir).catch(() => []);
    if (!leftovers.some(isMine)) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);
  expect(leftovers.filter(isMine), `判题沙箱未清理：${leftovers.filter(isMine).join(', ')}`).toEqual([]);
  const foreign = leftovers.filter((name) => !isMine(name));
  if (foreign.length) console.warn(`[pyspark] data/judge 仍有别的 suite 的沙箱（并发判题，非本文件残留）：${foreign.join(', ')}`);
});

const guarded = available ? it : it.skip;

describe('pyspark runner', () => {
  let firstDurationMs = 0;
  let reuseDurationMs = 0;

  guarded('参考解（function）全部用例通过，且默认行序不敏感', async () => {
    const result = await runJudge({ questionId: 'x', submission: FUNC_CORRECT }, makeQuestion());
    firstDurationMs = result.durationMs;
    expect(result.errorKind).toBeUndefined();
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(4);
    expect(result.passedCases).toContain('金额全为 null 时记 0 但笔数照算');
  }, 240_000);

  guarded('整数面值的 double 列必须能建框（题库经 Node 序列化会把 512.0 变成 512）', async () => {
    // 真实成因：ingest 用 JSON.stringify 落盘，`512.0` 被写成 `512`；
    // 而 PySpark 的 DoubleType 不接受 int → CANNOT_ACCEPT_OBJECT_IN_TYPE，
    // 症状是"参考解跑不起来"，看起来像题目写错，其实是 runner 的类型口径。
    const result = await runJudge(
      { questionId: 'x', submission: FUNC_CORRECT },
      makeQuestion({
        cases: [
          {
            name: '退化：金额写成整数面值（512 / 1024，不带 .0）',
            input: {
              rows: [
                { user_id: 'a', amount: 512 },
                { user_id: 'a', amount: 1024 },
              ],
              schema: SCHEMA,
            },
            expected: [{ user_id: 'a', total: 1536, n: 2 }],
          },
        ],
      }),
    );
    expect(result.errorKind, `被判成 ${result.errorKind}：${result.logs}`).toBeUndefined();
    expect(result.status).toBe('pass');
  }, 240_000);

  guarded('第二次判题复用 SparkSession（明显更快）', async () => {
    const result = await runJudge({ questionId: 'x', submission: FUNC_CORRECT }, makeQuestion());
    reuseDurationMs = result.durationMs;
     
    console.log(
      `[pyspark-timing] 首次判题（含会话启动）= ${firstDurationMs}ms；复用会话判题 = ${reuseDurationMs}ms`,
    );
    expect(result.status).toBe('pass');
    expect(reuseDurationMs).toBeGreaterThan(0);
    expect(reuseDurationMs).toBeLessThan(firstDurationMs / 2);
  }, 240_000);

  guarded('错误解 fail 且点名失败用例（含 expected/actual）', async () => {
    const result = await runJudge({ questionId: 'x', submission: FUNC_WRONG }, makeQuestion());
    expect(result.status).toBe('fail');
    expect(result.errorKind).toBeUndefined();
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(3);
    expect(result.failedCases.map((c) => c.name)).toEqual([
      '单用户多笔金额求和',
      '多用户聚合且与行序无关',
      '金额全为 null 时记 0 但笔数照算',
    ]);
    const mismatch = result.failedCases[0] as JudgeResult['failedCases'][number];
    expect(String(mismatch.expected)).toContain('total');
    expect(String(mismatch.expected)).toContain('15');
    expect(String(mismatch.actual)).toContain('7.5');
    expect(mismatch.message).toBeTruthy();
  }, 240_000);

  guarded('用户代码抛异常归类 error(runtime) 而不是 fail', async () => {
    const result = await runJudge({ questionId: 'x', submission: FUNC_THROWS }, makeQuestion());
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('runtime');
    expect(result.logs).toMatch(/ValueError/);
    expect(result.logs).toMatch(/boom in user code/);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(0);
  }, 240_000);

  guarded('Spark SQL 题（entry=sql）按结果判 pass，且三阶段都有进度事件', async () => {
    const phases: string[] = [];
    const result = await runJudge({ questionId: 'x', submission: SQL_CORRECT }, makeSqlQuestion(), (e) => {
      if (e.type === 'progress') phases.push(e.phase);
    });
    expect(result.logs ?? '').toEqual('');
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(1);
    expect(phases).toEqual(['compile', 'run', 'collect']);
  }, 240_000);

  guarded('Spark SQL 写错判 fail 并给出期望/实际行', async () => {
    const result = await runJudge({ questionId: 'x', submission: SQL_WRONG }, makeSqlQuestion());
    expect(result.status).toBe('fail');
    expect(result.failedCases.map((c) => c.name)).toEqual(['按 GMV 倒序输出']);
    const mismatch = result.failedCases[0] as JudgeResult['failedCases'][number];
    expect(String(mismatch.expected)).toContain('30');
    expect(String(mismatch.actual)).toContain('2');
  }, 240_000);

  guarded('orderSensitive=true 时行序不同即判失败', async () => {
    const result = await runJudge(
      { questionId: 'x', submission: SQL_CORRECT },
      makeSqlQuestion({
        runner: { ...makeSqlQuestion().runner, orderSensitive: true },
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.failedCases[0]?.message).toMatch(/行序/);
  }, 240_000);

  guarded('并发提交两个请求不串台（协议按 id 匹配 + 串行队列）', async () => {
    const [good, bad] = await Promise.all([
      runJudge({ questionId: 'x', submission: SQL_CORRECT }, makeSqlQuestion()),
      runJudge({ questionId: 'x', submission: SQL_WRONG }, makeSqlQuestion()),
    ]);
    expect(good.status).toBe('pass');
    expect(bad.status).toBe('fail');
  }, 240_000);

  guarded('卡死的作业被判超时，且 worker 自动重启不影响后续请求', async () => {
    const HANGING = 'import time\n\n\ndef solve(df):\n    time.sleep(120)\n    return df\n';
    const result = await runJudge(
      { questionId: 'x', submission: HANGING },
      makeQuestion({ runner: { ...makeQuestion().runner, timeoutMs: 6_000 } }),
    );
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('timeout');
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(30_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(5_000);

    const after = await runJudge({ questionId: 'x', submission: SQL_CORRECT }, makeSqlQuestion());
    expect(after.logs ?? '').toEqual('');
    expect(after.status).toBe('pass');
  }, 300_000);
});
