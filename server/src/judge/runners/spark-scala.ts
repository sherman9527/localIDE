import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { SPARK_JVM_FLAGS, scalaClasspaths, scalaSparkAvailable } from '../../exec/spark-scala.js';
import { runProcess } from '../process.js';
import { registerRunner } from '../registry.js';
import { createWorkspace } from '../workspace.js';
import { errorResult, lineReporter, progressReporter, summarize } from '../util.js';

/**
 * spark-scala runner：把考生写的 Scala object 与 harness 一起 `scalac` 真编译，
 * 再用真 Spark（local[*]）跑每个用例，按结果行比对 —— 与 pyspark 同一套 JSON 用例契约。
 *
 * 与 pyspark 的区别：那边是常驻 worker（省 JVM/Spark 冷启动），这边每次都要编译，
 * 冷启动无法复用，因此超时默认走 `config.judge.sparkTimeoutMs`（90s）而不是 20s。
 * harness 直接引用 `<object>.solve(df)`，签名不对会在**编译期**报错，不用反射猜。
 */

const HARNESS_FILE = join(config.repoRoot, 'server', 'src', 'judge', 'harness', 'ArenaScalaHarness.scala');
const RESULTS_FILE = 'arena-results.json';
const CASES_FILE = 'cases.json';
const OBJECT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

interface HarnessOutcome {
  name?: string;
  status?: string;
  message?: string;
  expected?: string;
  actual?: string;
}

interface HarnessReport {
  setupError?: string | null;
  cases?: HarnessOutcome[];
}

export const sparkScalaRunner: Runner = {
  kind: 'spark-scala',

  async probe() {
    // harness 是本 runner 独有的要求（IDE 直接跑用户的 main，不需要它）
    if (!existsSync(HARNESS_FILE)) return false;
    return scalaSparkAvailable();
  },

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const started = Date.now();
    const timeoutMs = question.runner?.timeoutMs ?? config.judge.sparkTimeoutMs;
    const progress = progressReporter(started, timeoutMs, onEvent);
    const logLine = lineReporter(onEvent);

    const target = question.runner?.className ?? 'Solution';
    if (!OBJECT_NAME_RE.test(target)) return errorResult('forbidden', `非法 object 名：${target}`, elapsed(started));

    const cases = question.cases ?? [];
    if (cases.length === 0) return errorResult('sandbox', '题目没有测试用例', elapsed(started));
    if (!req.submission.trim()) return errorResult('sandbox', '提交内容为空', elapsed(started));

    const method = question.runner?.method ?? 'solve';
    if (!new RegExp(`def\\s+${method}\\s*\\(`).test(req.submission)) {
      return errorResult(
        'sandbox',
        `spark-scala 题要求 object ${target} 里存在 def ${method}(df: org.apache.spark.sql.DataFrame): org.apache.spark.sql.DataFrame`,
        elapsed(started),
      );
    }

    const ws = await createWorkspace(question.id);
    try {
      const { compile, run } = await scalaClasspaths();
      if (compile.length === 0) return errorResult('unavailable', `找不到 Scala 编译器（${config.scalaJarDir} 为空）`, elapsed(started));

      await ws.write(
        CASES_FILE,
        JSON.stringify({
          orderSensitive: question.runner?.orderSensitive === true,
          setup: question.runner?.setup ?? [],
          cases: cases.map((testCase) => ({ name: testCase.name, input: testCase.input, expected: testCase.expected })),
        }),
      );
      await ws.write(`${target}.scala`, req.submission);
      // scalac 的 -d 目标目录必须先存在（它不会自己建目录）
      await ws.write('classes/.keep', '');
      const harness = (await readFile(HARNESS_FILE, 'utf8')).replace(/__SOLVE_TARGET__\./g, `${target}.`);
      await ws.write('ArenaScalaHarness.scala', harness);

      progress('compile');
      const compiled = await runProcess(
        'java',
        [
          '-Xmx1g',
          '-cp',
          compile.join(':'),
          'scala.tools.nsc.Main',
          '-classpath',
          compile.join(':'),
          '-d',
          'classes',
          `${target}.scala`,
          'ArenaScalaHarness.scala',
        ],
        { cwd: ws.root, timeoutMs, onLine: logLine },
      );
      if (compiled.code !== 0) {
        return errorResult(
          'compile',
          truncateLog(`Scala 编译失败：\n${compiled.stderr || compiled.stdout}`, 400, 6_000),
          elapsed(started),
          compiled.timedOut,
        );
      }

      progress('run');
      const ran = await runProcess(
        'java',
        [
          ...SPARK_JVM_FLAGS,
          '-cp',
          [`classes`, ...run].join(':'),
          'ArenaScalaHarness',
          CASES_FILE,
          RESULTS_FILE,
        ],
        { cwd: ws.root, timeoutMs, onLine: logLine },
      );
      if (ran.timedOut) {
        return errorResult(
          'timeout',
          truncateLog(`Spark 判题超过 ${timeoutMs}ms 未返回\n${ran.stderr}`, 400, 6_000),
          elapsed(started),
          true,
        );
      }

      progress('collect');
      const raw = await readFile(ws.path(RESULTS_FILE), 'utf8').catch(() => null);
      if (!raw) {
        return errorResult(
          'sandbox',
          truncateLog(`harness 没写出结果（exit=${ran.code}）\n${ran.stderr || ran.stdout}`, 400, 6_000),
          elapsed(started),
        );
      }
      let report: HarnessReport;
      try {
        report = JSON.parse(raw) as HarnessReport;
      } catch (err) {
        return errorResult('sandbox', truncateLog(`harness 输出不是合法 JSON：${(err as Error).message}\n${raw}`, 400, 4_000), elapsed(started));
      }
      if (report.setupError) {
        return errorResult('runtime', truncateLog(`判题环境错误：${report.setupError}`, 400, 6_000), elapsed(started));
      }

      const outcomes = report.cases ?? [];
      if (outcomes.length !== cases.length) {
        return errorResult(
          'sandbox',
          truncateLog(`harness 上报 ${outcomes.length} 个用例，与题目 ${cases.length} 个不符`, 400, 2_000),
          elapsed(started),
        );
      }
      const results: JudgeCaseResult[] = outcomes.map((outcome, index) => {
        const name = outcome.name ?? cases[index]?.name ?? `用例 ${index + 1}`;
        if (outcome.status === 'pass') return { name, passed: true };
        return {
          name,
          passed: false,
          message: outcome.message ?? '结果不一致',
          ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
          ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
        };
      });
      return { ...summarize(results, elapsed(started)), logs: truncateLog(ran.stderr || '', 200, 2_000) };
    } catch (err) {
      return errorResult('sandbox', truncateLog(`判题器内部错误：${(err as Error).message}`, 400, 4_000), elapsed(started));
    } finally {
      await ws.cleanup();
    }
  },
};

function elapsed(started: number): number {
  return Date.now() - started;
}

registerRunner(sparkScalaRunner);
