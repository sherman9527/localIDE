import {
  truncateLog,
  type JudgeCaseResult,
  type JudgeErrorKind,
  type JudgeEvent,
  type JudgeRequest,
  type JudgeResult,
  type Question,
  type Runner,
} from '@arena/shared';
import { config } from '../../config.js';
import { registerRunner } from '../registry.js';
import { createWorkspace } from '../workspace.js';
import { errorResult, lineReporter, progressReporter, summarize } from '../util.js';
import {
  SUPPORTED_ENTRIES,
  SparkTimeoutError,
  getPool,
  pysparkAvailable,
  type SparkRequestPayload,
  type SparkResponse,
} from '../../exec/spark-pool.js';


/**
 * pyspark runner：把题目与提交喂给常驻 Spark worker（池与协议在 `exec/spark-pool.ts`），
 * 这里只做判分口径：按用例名回收结果、把 worker 的 stage 映射成 errorKind、
 * 以及"参考解必须过 / 朴素解必须挂"所依赖的期望-实际对照。
 */

function errorKindForStage(stage: string | undefined): JudgeErrorKind {
  if (stage === 'compile') return 'compile';
  if (stage === 'protocol' || stage === 'worker') return 'sandbox';
  return 'runtime';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export const pysparkRunner: Runner = {
  kind: 'pyspark',

  // 可用性判据住在 exec/：IDE 的"这门语言能不能跑"与判题矩阵必须探同一件事
  probe: pysparkAvailable,

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const timeoutMs = question.runner?.timeoutMs ?? config.judge.sparkTimeoutMs;
    const progress = progressReporter(started, timeoutMs, onEvent);
    const logLine = lineReporter(onEvent);

    const cases = question.cases ?? [];
    if (cases.length === 0) return errorResult('sandbox', '题目没有测试用例', elapsed());
    if (!req.submission.trim()) return errorResult('sandbox', '提交内容为空', elapsed());
    const entry = question.runner?.entry ?? 'function';
    if (!SUPPORTED_ENTRIES.has(entry)) {
      return errorResult('sandbox', `pyspark runner 不支持 runner.entry='${entry}'（可用：function / sql / script）`, elapsed());
    }

    const payload: SparkRequestPayload = {
      entry,
      code: req.submission,
      setup: asStringArray(question.runner?.setup),
      orderSensitive: question.runner?.orderSensitive ?? false,
      cases: cases.map((c) => ({ name: c.name, input: c.input, expected: c.expected })),
    };

    progress('compile');
    const active = getPool();

    const result = await (async (): Promise<JudgeResult> => {
      progress('run');
      let response: SparkResponse;
      try {
        response = await active.request(payload, timeoutMs, logLine);
      } catch (err) {
        if (err instanceof SparkTimeoutError) {
          return errorResult(
            'timeout',
            truncateLog(`Spark 判题超时（>${timeoutMs}ms），已杀掉 worker 并重启。常见原因：数据量过大、join 倾斜、死循环。`),
            elapsed(),
            true,
          );
        }
        return errorResult('sandbox', truncateLog(`spark worker 不可用：${(err as Error).message ?? String(err)}`), elapsed());
      }

      progress('collect');
      const outcomes = response.cases ?? [];
      const runtime = outcomes.find((o) => o.status === 'runtime');
      if (runtime || response.error) {
        const error = response.error;
        return errorResult(
          runtime ? 'runtime' : errorKindForStage(error?.stage),
          truncateLog(`${error?.message ?? runtime?.message ?? '用户代码异常'}\n${error?.traceback ?? runtime?.traceback ?? ''}`),
          elapsed(),
        );
      }
      if (outcomes.length === 0) {
        return errorResult(
          'runtime',
          truncateLog(`worker 没有返回任何用例结果（worker 状态已重置）\n${active.stderr}`),
          elapsed(),
        );
      }

      const rest = [...outcomes];
      const results: JudgeCaseResult[] = [];
      for (const testCase of cases) {
        const index = rest.findIndex((o) => o.name === testCase.name);
        const hit = index >= 0 ? rest.splice(index, 1)[0] : undefined;
        if (!hit) {
          results.push({
            name: testCase.name,
            passed: false,
            expected: JSON.stringify(testCase.expected ?? null),
            message: '判题 worker 没有回收该用例结果（用例名与测试文件不一致，或进程中途被杀）',
          });
          continue;
        }
        const passed = hit.status === 'pass';
        results.push({
          name: testCase.name,
          passed,
          expected: passed ? undefined : hit.expected ?? JSON.stringify(testCase.expected ?? null),
          actual: passed ? undefined : hit.actual,
          message: passed ? undefined : hit.message,
        });
      }
      for (const extra of rest) {
        results.push({
          name: extra.name ?? '额外用例',
          passed: extra.status === 'pass',
          expected: extra.expected,
          actual: extra.actual,
          message: extra.message,
        });
      }

      return summarize(results, elapsed());
    })();

    await writeAuditTrail(question.id, req.submission, payload, result);
    return result;
  },
};

/**
 * 审计产物：Spark 判题本身不落盘（会话常驻、JVM 暂存在 data/.spark-worker），
 * 但每次判题仍然开一个工作区把"提交 + 用例 + 结果"留一份，写完立刻按 C1 清理。
 * 放在结果收集之后而不是包住整次判题，是为了让常驻会话期间 data/judge 保持空
 * ——并发跑的其它判题 suite 会断言该目录已被清理。
 */
async function writeAuditTrail(
  questionId: string,
  submission: string,
  payload: SparkRequestPayload,
  result: JudgeResult,
): Promise<void> {
  const ws = await createWorkspace(questionId);
  try {
    await ws.write('submission.py', submission);
    await ws.write('request.json', JSON.stringify(payload));
    await ws.write('result.json', JSON.stringify(result));
  } finally {
    await ws.cleanup();
  }
}

registerRunner(pysparkRunner);
