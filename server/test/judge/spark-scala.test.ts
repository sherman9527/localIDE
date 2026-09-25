import { readdir } from 'node:fs/promises';
import { Question, type JudgeEvent, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { probeStacks, runJudge } from '../../src/judge/registry.js';
import '../../src/judge/runners/spark-scala.js';

/**
 * spark-scala 判题器：真 scalac 编译 + 真 Spark local[*] 跑。
 * 用例契约与 pyspark 完全一致（input={rows,schema}，expected=行对象数组），
 * 所以出题时两种栈可以共用同一份数据。宿主机没有 Scala 编译器时整个 suite 跳过。
 */

const REFERENCE = `import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions.max

object Solution {
  def solve(df: DataFrame): DataFrame =
    df.groupBy("city").agg(max("gmv").as("gmv")).select("city", "gmv")
}`;

// 把 max 换成 min：只有一个城市的用例侥幸相同，其余必须挂
const WRONG = `import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions.min

object Solution {
  def solve(df: DataFrame): DataFrame =
    df.groupBy("city").agg(min("gmv").as("gmv")).select("city", "gmv")
}`;

const BROKEN = `import org.apache.spark.sql.DataFrame

object Solution {
  def solve(df: DataFrame): DataFrame = df.groupBy("city").agg(max("gmv"))  // 缺括号与 import
}`;

const NO_SOLVE = `object Solution {
  def notTheContract(df: org.apache.spark.sql.DataFrame): org.apache.spark.sql.DataFrame = df
}`;

function rows(): { city: string; gmv: number }[] {
  return [
    { city: 'LA', gmv: 120.5 },
    { city: 'LA', gmv: 300.25 },
    { city: 'NYC', gmv: 80 },
    { city: 'NYC', gmv: 80 },
    { city: 'SF', gmv: 42.125 },
  ];
}

function makeQuestion(over: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'bd-scala-harness-0001',
    category: 'big-data',
    difficulty: 'senior',
    title: 'Scala Spark：每个城市的最大成交额',
    statement: '给定 host_sales 明细，用 Scala Spark 输出每个城市的最大 gmv（列 city、gmv）。',
    judgeKind: 'spark-scala',
    language: 'scala',
    tags: ['spark', 'aggregation'],
    cases: [
      {
        name: '全量数据每城取最大',
        input: { rows: rows(), schema: 'city string, gmv double' },
        expected: [
          { city: 'LA', gmv: 300.25 },
          { city: 'NYC', gmv: 80 },
          { city: 'SF', gmv: 42.125 },
        ],
      },
      {
        name: '单城单行',
        input: { rows: [{ city: 'LA', gmv: 7 }], schema: 'city string, gmv double' },
        expected: [{ city: 'LA', gmv: 7 }],
      },
      {
        // pyspark 在 WI-61 上栽过的正是这里：题库走 JSON.stringify，整数面值的 `.0` 会被磨掉，
        // 于是 `512.0` 到判题器手里变成 int 512。Scala 侧靠"声明 schema + 让 Spark 解析 JSON"天然免疫，
        // 这条用例把结论钉死 —— 哪天 harness 改成用行对象建框，它会立刻红。
        name: '整数面值的 double 列（Node 序列化会磨掉 .0）',
        input: { rows: [{ city: 'LA', gmv: 512 }, { city: 'LA', gmv: 8 }], schema: 'city string, gmv double' },
        expected: [{ city: 'LA', gmv: 512 }],
      },
      {
        name: '空表边界',
        input: { rows: [], schema: 'city string, gmv double' },
        expected: [],
      },
    ],
    runner: {
      className: 'Solution',
      method: 'solve',
      signature: 'solve(df: DataFrame): DataFrame',
      referenceSolution: REFERENCE,
      timeoutMs: 120_000,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...over,
  }) as BankQuestion;
}

const stacks = await probeStacks();
const available = stacks['spark-scala'] === true;
if (!available) console.warn('[judge] 无 Scala 编译器/Spark jars，spark-scala 判题测试跳过（容器内会跑）');

const guarded = available ? it : it.skip;

const leakedDirs = async (): Promise<string[]> => {
  const names = await readdir(config.judgeWorkDir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith('bd-scala-harness-0001'));
};

describe('spark-scala runner', () => {
  guarded('参考解全部用例通过，且三个阶段都有进度事件', async () => {
    const question = makeQuestion();
    const events: JudgeEvent[] = [];
    const result = await runJudge({ questionId: question.id, submission: REFERENCE }, question, (e) => events.push(e));
    expect(result.status, result.logs ?? '').toBe('pass');
    // 从题目本身取分母：写死 3 的话，加一条用例会红在计数上，看起来像判题器坏了
    expect(result.passed).toBe(question.cases?.length);
    expect(result.failed).toBe(0);
    // 长耗时判题必须看得见进度：编译 / 运行 / 收集三个阶段都要推事件（'result' 由 API 的 SSE 层补）
    expect(events[0]?.type).toBe('queued');
    const phases = events.filter((e) => e.type === 'progress').map((e) => (e.type === 'progress' ? e.phase : ''));
    expect(phases).toEqual(expect.arrayContaining(['compile', 'run', 'collect']));
  }, 240_000);

  guarded('错误解 fail 且点名失败用例（含期望/实际）', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: question.id, submission: WRONG }, question);
    expect(result.status).toBe('fail');
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const failed = result.failedCases[0]!;
    expect(failed.name).toContain('全量数据');
    expect(failed.expected).toBeTruthy();
    expect(failed.actual).toBeTruthy();
  }, 240_000);

  guarded('编译失败归类 error:compile 而不是 fail', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: question.id, submission: BROKEN }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('compile');
    expect(result.logs).toMatch(/error/i);
  }, 240_000);

  guarded('提交里没有 def solve 时给出可读契约错误', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: question.id, submission: NO_SOLVE }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('sandbox');
    expect(result.logs).toMatch(/def solve/);
  }, 240_000);

  guarded('判题后本 suite 的沙箱清理干净', async () => {
    expect(await leakedDirs()).toEqual([]);
  });
});

afterAll(async () => {
  if (!available) return;
  const leaked = await leakedDirs();
  expect(leaked, `spark-scala 沙箱未清理：${leaked.join(', ')}`).toEqual([]);
});
