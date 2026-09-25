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
import { runProcess } from '../process.js';
import { registerRunner } from '../registry.js';
import { createWorkspace } from '../workspace.js';
import { errorResult, lineReporter, progressReporter, summarize } from '../util.js';

const HARNESS_DIR = join(config.repoRoot, 'server', 'src', 'judge', 'harness');
const RESULTS_FILE = 'arena-results.json';
const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

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

export const javaJUnitRunner: Runner = {
  kind: 'java-junit',

  async probe() {
    if (!existsSync(config.junitJar)) return false;
    const check = await runProcess('javac', ['-version'], { timeoutMs: 15_000 });
    return check.code === 0;
  },

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const signature = question.runner?.signature?.trim();
    if (!signature) return errorResult('sandbox', '题目缺少 runner.signature（形如 int[] twoSum(int[] nums, int target)）', 0);

    const className = question.runner?.className ?? 'Solution';
    if (!CLASS_NAME_RE.test(className)) return errorResult('forbidden', `非法类名：${className}`, 0);

    const timeoutMs = question.runner?.timeoutMs ?? config.judge.defaultTimeoutMs;
    const cases = question.cases ?? [];
    if (cases.length === 0) return errorResult('sandbox', '题目没有测试用例', 0);

    // 指针结构题（N-04）：签名里出现才注入内置类 —— 一律注入会跟考生自己写的同名类撞编译
    const pointerTypes = (['ListNode', 'TreeNode'] as const).filter((name) => new RegExp(`\\b${name}\\b`).test(signature));
    const redefined = pointerTypes.find((name) => new RegExp(`\\b(class|interface|enum|record)\\s+${name}\\b`).test(req.submission));
    if (redefined) {
      return errorResult(
        'compile',
        `这道题的签名用到 ${redefined}，判题器会提供同名类；请把你自己写的 ${redefined} 定义删掉，直接用内置的那个`,
        0,
      );
    }

    const started = Date.now();
    const progress = progressReporter(started, timeoutMs, onEvent);
    const logLine = lineReporter(onEvent);
    const ws = await createWorkspace(question.id);

    try {
      await ws.copyFrom(join(HARNESS_DIR, 'Harness.java'), 'src/arena/Harness.java');
      await ws.copyFrom(join(HARNESS_DIR, 'ArenaTest.java'), 'src/arena/ArenaTest.java');
      for (const name of pointerTypes) {
        await ws.copyFrom(join(HARNESS_DIR, `${name}.java`), `${name}.java`);
      }
      await ws.write(`${className}.java`, req.submission);
      await ws.write(
        'cases.json',
        JSON.stringify(
          cases.map((c) => ({
            name: c.name,
            input: c.input ?? [],
            expected: c.expected,
            ...(c.expectThrow ? { expectThrow: c.expectThrow } : {}),
          })),
        ),
      );
      await ws.write('method.txt', signature);

      progress('compile');
      const compile = await runProcess(
        'javac',
        [
          '-J-Xmx256m',
          '-encoding',
          'UTF-8',
          '-nowarn',
          '-Xlint:none',
          '-proc:none',
          '-cp',
          config.junitJar,
          '-d',
          'out',
          'src/arena/Harness.java',
          'src/arena/ArenaTest.java',
          ...pointerTypes.map((name) => `${name}.java`),
          `${className}.java`,
        ],
        { cwd: ws.root, timeoutMs, onLine: logLine },
      );
      if (compile.timedOut) return errorResult('timeout', '编译超时', Date.now() - started, true);
      if (compile.code !== 0) {
        return errorResult('compile', truncateLog(`${compile.stderr}\n${compile.stdout}`), Date.now() - started);
      }

      progress('run');
      const test = await runProcess(
        'java',
        [
          // 必须显式设上限：不设 -Xmx 时 JVM 按容器可见内存的 1/4 起算，一个失控提交能把
          // 同容器里的 mysqld 顶成 OOM 目标，之后所有 SQL 判题一起挂掉
          '-Xmx512m',
          '-XX:MaxRAM=640m',
          '-XX:+UseSerialGC',
          '-Xss4m',
          '-Dfile.encoding=UTF-8',
          '-Dstdout.encoding=UTF-8',
          '-Dstderr.encoding=UTF-8',
          `-Darena.cases=${join(ws.root, 'cases.json')}`,
          `-Darena.method=${join(ws.root, 'method.txt')}`,
          `-Darena.class=${className}`,
          `-Darena.results=${join(ws.root, RESULTS_FILE)}`,
          '-jar',
          config.junitJar,
          'execute',
          '--class-path',
          join(ws.root, 'out'),
          '--select-class',
          'arena.ArenaTest',
          '--details',
          'summary',
          '--disable-banner',
        ],
        { cwd: ws.root, timeoutMs, onLine: logLine },
      );
      progress('collect');
      if (test.timedOut) {
        return errorResult(
          'timeout',
          `判题超时（>${timeoutMs}ms）：常见于死循环、递归无终止或复杂度过高`,
          Date.now() - started,
          true,
        );
      }

      const raw = await readFile(join(ws.root, RESULTS_FILE), 'utf8').catch(() => undefined);
      if (!raw) {
        return errorResult('runtime', truncateLog(`${test.stdout}\n${test.stderr}`), Date.now() - started);
      }

      const report = JSON.parse(raw) as HarnessReport;
      if (report.setupError) {
        return errorResult('runtime', truncateLog(report.setupError), Date.now() - started);
      }

      const outcomes = report.cases ?? [];
      if (outcomes.length !== cases.length) {
        return errorResult(
          'runtime',
          `判题器只回收了 ${outcomes.length}/${cases.length} 个用例结果，进程可能被系统杀掉`,
          Date.now() - started,
        );
      }

      const results: JudgeCaseResult[] = outcomes.map((outcome, index) => ({
        name: outcome.name ?? cases[index]?.name ?? `case-${index + 1}`,
        passed: outcome.status === 'pass',
        expected: outcome.expected,
        actual: outcome.actual,
        message: outcome.message,
      }));

      return summarize(results, Date.now() - started);
    } finally {
      await ws.cleanup();
    }
  },
};

registerRunner(javaJUnitRunner);
