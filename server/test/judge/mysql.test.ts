import { Question, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { runProcess } from '../../src/judge/process.js';
import { probeStacks, runJudge } from '../../src/judge/registry.js';
import { splitStatements } from '../../src/exec/guards.js';
import '../../src/judge/runners/mysql.js';

/**
 * MySQL 判题用容器里的真 MySQL 8（不是 SQLite 替身），否则窗口函数与
 * ONLY_FULL_GROUP_BY 这类真正拉开差距的行为就判不出来。
 */
const stacks = await probeStacks();
const mysqlAvailable = stacks['mysql'] === true;
if (!mysqlAvailable) console.warn('[judge] 无可用 MySQL，mysql 判题测试跳过（容器内会跑）');

const guarded = mysqlAvailable ? it : it.skip;

const SETUP = [
  'DROP TABLE IF EXISTS orders',
  `CREATE TABLE orders (id INT PRIMARY KEY, rep_id INT NOT NULL, amount DECIMAL(10,2) NOT NULL, created_at DATE NOT NULL)`,
  `INSERT INTO orders VALUES (1,1,100.00,'2026-01-01'),(2,1,250.50,'2026-01-03'),(3,2,80.00,'2026-01-02'),(4,2,90.00,'2026-01-05'),(5,3,10.00,'2026-01-04')`,
];

/** MySQL 里唯一确定的"每组最大"写法：窗口函数或相关子查询，这里用 ROW_NUMBER。 */
const REFERENCE = `
SELECT rep_id, id, amount
FROM (
  SELECT rep_id, id, amount, ROW_NUMBER() OVER (PARTITION BY rep_id ORDER BY amount DESC) AS rn
  FROM orders
) ranked
WHERE rn = 1
ORDER BY rep_id`;

const WRONG_ROW_COUNT = 'SELECT rep_id, id, amount FROM orders WHERE amount >= 80 ORDER BY rep_id';

// 经典的"裸列 + GROUP BY"写法，在 MySQL 8 默认 ONLY_FULL_GROUP_BY 下直接报错
const ILLEGAL_GROUP_BY = 'SELECT rep_id, id, MAX(amount) AS amount FROM orders GROUP BY rep_id';

function makeQuestion(over: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'sql-mysql-harness-0001',
    category: 'sql',
    difficulty: 'senior',
    title: '取每个销售的最大一单（含并列与空表边界）',
    statement: '在 orders 表中写出每个 rep_id 金额最大的那一单的 rep_id、id、amount，按 rep_id 升序输出。',
    judgeKind: 'mysql',
    language: 'sql',
    tags: ['window-function', 'mysql8'],
    cases: [
      { name: '基础数据', input: [], expected: [[1, 2, 250.5], [2, 4, 90], [3, 5, 10]] },
      {
        name: '新人大单改写结果',
        input: [`INSERT INTO orders VALUES (6,1,400.00,'2026-02-01')`],
        expected: [[1, 6, 400], [2, 4, 90], [3, 5, 10]],
      },
      { name: '空表返回空结果集', input: ['DELETE FROM orders'], expected: [] },
    ],
    runner: { setup: SETUP, referenceSolution: REFERENCE, timeoutMs: 8_000 },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...over,
  }) as BankQuestion;
}

async function listScratchDatabases(): Promise<string[]> {
  const res = await runProcess(
    'mysql',
    [`--socket=${config.mysql.socket}`, `--user=${config.mysql.user}`, '-N', '-e', "SHOW DATABASES LIKE 'arena_%'"],
    { timeoutMs: 8_000 },
  );
  return res.stdout.split('\n').filter(Boolean);
}

afterAll(async () => {
  const leftovers = await listScratchDatabases();
  expect(leftovers, `判题临时库未清理：${leftovers.join(', ')}`).toEqual([]);
});

describe('mysql runner', () => {
  guarded('窗口函数参考解三组用例全过', async () => {
    const result = await runJudge({ questionId: 'x', submission: REFERENCE }, makeQuestion());
    expect(result.status, result.logs ?? '').toBe('pass');
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
  }, 90_000);

  guarded('行数不对时按用例点名并给出期望/实际', async () => {
    const result = await runJudge({ questionId: 'x', submission: WRONG_ROW_COUNT }, makeQuestion());
    expect(result.status).toBe('fail');
    expect(result.failed).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failedCases.map((c) => c.name)).toContain('基础数据');
    expect(result.failedCases[0]!.message).toMatch(/行数不一致/);
  }, 90_000);

  guarded('ONLY_FULL_GROUP_BY 下报错归 error 而非 fail', async () => {
    const result = await runJudge({ questionId: 'x', submission: ILLEGAL_GROUP_BY }, makeQuestion());
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('runtime');
    expect(result.logs).toMatch(/ONLY_FULL_GROUP_BY|1055/);
  }, 90_000);

  guarded('/*!SHUTDOWN*/ 版本注释被拒且没把 mysqld 关掉', async () => {
    const question = makeQuestion();
    const result = await runJudge({ questionId: 'x', submission: 'SELECT 1 /*!SHUTDOWN*/' }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('forbidden');
    expect(result.logs).toMatch(/版本注释/);
    // 服务端还活着：正常参考解仍能判 pass
    const alive = await runJudge({ questionId: question.id, submission: REFERENCE }, question);
    expect(alive.status, alive.logs ?? '').toBe('pass');
  }, 60_000);

  guarded('自测用例里的语句按考生提交标准把关（不许借"预置语句"通道跑 DDL）', async () => {
    const question = makeQuestion({
      cases: [{ name: '危险用例', input: ['CREATE USER zz IDENTIFIED BY "x"'], expected: [] }],
    });
    const result = await runJudge({ questionId: question.id, submission: 'SELECT 1 AS a', caseSource: 'request' }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('forbidden');
    expect(result.logs).toMatch(/自测用例/);
  }, 60_000);

  guarded('越权语句被拒绝', async () => {
    const question = makeQuestion();
    const drop = await runJudge({ questionId: 'x', submission: 'DROP DATABASE mysql' }, question);
    expect(drop.status).toBe('error');
    expect(drop.errorKind).toMatch(/forbidden|sandbox/);

    const multiple = await runJudge({ questionId: 'x', submission: 'SELECT 1; SELECT 2' }, question);
    expect(multiple.errorKind).toBe('forbidden');
    expect(multiple.logs).toMatch(/一条/);
  }, 90_000);

  guarded('判题后不留下临时库', async () => {
    await runJudge({ questionId: 'x', submission: REFERENCE }, makeQuestion());
    expect(await listScratchDatabases()).toEqual([]);
  }, 90_000);

  it('splitStatements 不被字符串与注释里的分号骗过', () => {
    expect(splitStatements("SELECT 'a;b' /* x;y */ FROM t; -- tail;")).toEqual(["SELECT 'a;b'   FROM t"]);
  });
});
