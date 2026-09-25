import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
import { logWarn } from '../../log.js';
import { runProcess } from '../process.js';
import { registerRunner } from '../registry.js';
import { createWorkspace } from '../workspace.js';
import { errorResult, lineReporter, progressReporter, summarize } from '../util.js';

/**
 * react-vitest runner：沙箱内真跑 vitest（需求 场景 3/4/16）。
 *
 * 关键取舍：**不 npm install**。工作区落在 `<repo>/data/judge/<id>-<ts>`，而依赖装在
 * `<repo>/node_modules`（容器里是 `/app/node_modules`），node / vite 的逐级向上查找天然命中，
 * 所以沙箱里 MUST NOT 写 package.json —— 一旦写了，vite 会把沙箱当 package root，
 * 依赖解析与 optimizeDeps 都会指向空目录而炸掉。代价是沙箱只能用镜像里已有的依赖版本。
 */

const RESULTS_FILE = 'results.json';
/** 用户提交的默认落盘位置；题目可用 runner.submissionPath 显式改成 `src/Counter.tsx` 这类路径。 */
const DEFAULT_SUBMISSION = 'Solution.tsx';
const SAFE_FILE_RE = /^[\w@][\w@./-]*\.(tsx|ts|jsx|js|mjs|cjs|css)$/;
const TEST_FILE_RE = /\.(test|spec)\.(tsx|ts|jsx|js|mjs|cjs)$/;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** vitest 2.1 的 json reporter 复用 jest 形状：`expected <实际> to be <期望>`。 */
const ASSERTION_RE =
  /^AssertionError:?\s*expected\s+(.+?)\s+(to be|to deeply equal|to equal|to include|to have length|to match|to be close to|to be greater than|to be less than)\s+(.+?)\s*(?:\/\/.*)?$/;
const QUERY_RE = /Unable to find an element[^:]*:\s*(.+)/;

/** 依赖候选目录：容器（/app）优先，宿主机跑测时退回仓库根。 */
function nodeModulesCandidates(): string[] {
  const list = [process.env.ARENA_NODE_MODULES, '/app/node_modules', join(config.repoRoot, 'node_modules')];
  return [...new Set(list.filter((v): v is string => Boolean(v)))];
}

/** 沙箱能用的判定标准：vitest 入口 + 配置里 import 的三个包都在同一个 node_modules 下。 */
function detectNodeModules(): string | null {
  for (const dir of nodeModulesCandidates()) {
    if (!existsSync(join(dir, 'vitest', 'vitest.mjs'))) continue;
    if (!existsSync(join(dir, '@vitejs', 'plugin-react'))) continue;
    if (!existsSync(join(dir, 'jsdom'))) continue;
    if (!existsSync(join(dir, '@testing-library', 'react'))) continue;
    return dir;
  }
  return null;
}

function sandboxConfig(testTimeoutMs: number): string {
  return `import react from "@vitejs/plugin-react";

export default {
  clearScreen: false,
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["**/*.test.tsx", "**/*.test.ts", "**/*.test.jsx", "**/*.test.js", "**/*.spec.tsx", "**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./arena.setup.mjs"],
    globals: true,
    fileParallelism: false,
    testTimeout: ${testTimeoutMs},
    hookTimeout: ${testTimeoutMs},
    reporters: ["json"],
    outputFile: { json: "${RESULTS_FILE}" },
  },
};
`;
}

/** RTL 不会自己 cleanup（vitest 未开 globals 时），同一文件里多次 render 会互相污染。 */
const SETUP_SOURCE = `import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
`;

interface VitestAssertion {
  ancestorTitles?: string[];
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
}

interface VitestFileResult {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}

interface VitestReport {
  numTotalTests?: number;
  success?: boolean;
  testResults?: VitestFileResult[];
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 失败信息压成一行人可读的（去掉 ANSI 色码与堆栈）。 */
function readLine(messages: readonly string[] | undefined, wsRoot: string): string | undefined {
  const raw = messages?.find((m) => m && m.trim());
  if (!raw) return undefined;
  const line = raw
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^❯/.test(l) && !/\(node_modules\//.test(l))
    .join(' ')
    .replaceAll(`${wsRoot}/`, '')
    .replaceAll(wsRoot, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return undefined;
  return line.length > 400 ? `${line.slice(0, 400)}...` : line;
}

function parseExpectedActual(line: string | undefined): { expected?: string; actual?: string } {
  if (!line) return {};
  const hit = ASSERTION_RE.exec(line);
  if (hit) {
    const unquote = (v: string) => v.replace(/^['"]|['"]$/g, '').trim();
    // vitest 的措辞是 "expected <实际值> to be <期望值>"
    return { actual: unquote(hit[1] ?? ''), expected: unquote(hit[3] ?? '') };
  }
  const query = QUERY_RE.exec(line);
  if (query) return { expected: query[1]?.trim() };
  return {};
}

function submissionPathOf(question: Question): string {
  const raw = question.runner?.submissionPath?.trim();
  if (raw && !raw.includes('..') && !raw.startsWith('/') && SAFE_FILE_RE.test(raw)) return raw;
  return DEFAULT_SUBMISSION;
}

function classifyCollection(errors: string[]): JudgeErrorKind {
  return /transform failed|vite:esbuild|esbuild|syntaxerror|parse error|unexpected token|unexpected end|is not valid inside an html comment/i.test(
    errors.join('\n'),
  )
    ? 'compile'
    : 'runtime';
}

/** 用例名与 vitest 断言名的匹配：全名 → 标题 → 后缀（允许 describe 包一层前缀）。 */
function findAssertion(
  entries: { assertion: VitestAssertion; file: VitestFileResult }[],
  used: Set<VitestAssertion>,
  caseName: string,
) {
  const target = caseName.trim();
  const alive = entries.filter((e) => !used.has(e.assertion));
  return (
    alive.find((e) => (e.assertion.fullName ?? '').trim() === target) ??
    alive.find((e) => (e.assertion.title ?? '').trim() === target) ??
    alive.find((e) => (e.assertion.fullName ?? '').trim().endsWith(target))
  );
}

/**
 * 脚手架"写完还在不在"。WI-72 的取证钩子。
 *
 * 偶发的 `Could not resolve <ws>/vitest.config.mjs`（445ms 就挂、单跑全过）里，vitest 只会
 * 报"解析不到"，而这句话同时兼容两种真相：文件从来没写成 / 写成了但在 spawn 之前被删了。
 * 两者处置完全不同（前者是写盘问题，后者是有人在扫兄弟沙箱），所以 spawn 前必须自己 stat 一次，
 * 并把结果写进日志 —— 否则下一次复发时还是只能靠猜。
 */
export async function missingScaffolds(root: string, paths: readonly string[]): Promise<string[]> {
  const gone: string[] = [];
  for (const rel of paths) {
    try {
      await stat(join(root, rel));
    } catch {
      gone.push(rel);
    }
  }
  return gone;
}

export const reactVitestRunner: Runner = {
  kind: 'react-vitest',

  async probe() {
    const dir = detectNodeModules();
    if (!dir) return false;
    const check = await runProcess(process.execPath, ['--version'], { timeoutMs: 15_000 });
    return check.code === 0;
  },

  async run(req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const timeoutMs = question.runner?.timeoutMs ?? config.judge.defaultTimeoutMs;
    const progress = progressReporter(started, timeoutMs, onEvent);
    const logLine = lineReporter(onEvent);

    const nodeModules = detectNodeModules();
    if (!nodeModules) {
      return errorResult('unavailable', `找不到可用的 vitest 依赖目录（候选：${nodeModulesCandidates().join(', ')}）`, elapsed());
    }

    const cases = question.cases ?? [];
    if (cases.length === 0) return errorResult('sandbox', '题目没有测试用例', elapsed());
    if (!req.submission.trim()) return errorResult('sandbox', '提交内容为空', elapsed());

    const files = question.runner?.files ?? [];
    if (files.length === 0) {
      return errorResult('sandbox', '题目缺少 runner.files（测试文件与脚手架）', elapsed());
    }
    if (!files.some((f) => TEST_FILE_RE.test(f.path))) {
      return errorResult('sandbox', 'runner.files 里没有任何 *.test.tsx / *.spec.ts 测试文件，无法判题', elapsed());
    }

    const extra = req.extraFiles ?? [];
    const bad = [...files, ...extra].find((f) => !SAFE_FILE_RE.test(f.path));
    if (bad) return errorResult('forbidden', `非法文件名（只允许相对路径的 ts/tsx/js/jsx/css）：${bad.path}`, elapsed());
    // extraFiles 是答题者提供的：绝不能覆盖判题器自己的配置、结果文件与题目测试文件，
    // 否则"贴一份同名假测试"就能把任意错误解判成 pass（判题器变成橡皮图章）
    const submission = submissionPathOf(question);
    const protectedPaths = new Set([submission, 'vitest.config.mjs', 'arena.setup.mjs', RESULTS_FILE, ...files.map((f) => f.path)]);
    const collision = extra.find((f) => protectedPaths.has(f.path));
    if (collision) return errorResult('forbidden', `extraFiles 不允许使用判题器保留文件名：${collision.path}`, elapsed());

    const ws = await createWorkspace(question.id);
    try {
      progress('compile');
      const perCaseMs = Math.max(5_000, Math.floor(timeoutMs * 0.5));
      await ws.write('vitest.config.mjs', sandboxConfig(perCaseMs));
      await ws.write('arena.setup.mjs', SETUP_SOURCE);
      for (const file of extra) await ws.write(file.path, file.content);
      await ws.write(submission, req.submission);
      // 题目自带的测试文件最后落盘：任何同名覆盖都赢不过判题依据
      for (const file of files) await ws.write(file.path, file.content);

      const scaffolds = ['vitest.config.mjs', 'arena.setup.mjs', submission, ...extra.map((f) => f.path), ...files.map((f) => f.path)];
      const goneBefore = await missingScaffolds(ws.root, scaffolds);
      if (goneBefore.length > 0) {
        logWarn('judge', 'react-scaffold-missing', { questionId: question.id, workspace: ws.root, missing: goneBefore });
        return errorResult(
          'sandbox',
          `判题脚手架落盘后不见了：${goneBefore.join(', ')}（工作区 ${ws.root}）。这不是你提交内容的问题，` +
            '是沙箱被半路清理了 —— 同一道题重跑一次通常就好，反复出现请看 data/logs 里的 react-scaffold-missing。',
          elapsed(),
        );
      }

      progress('run');
      const run = await runProcess(
        process.execPath,
        [join(nodeModules, 'vitest', 'vitest.mjs'), 'run', '--root', '.', '--config', 'vitest.config.mjs'],
        {
          cwd: ws.root,
          timeoutMs,
          onLine: logLine,
          // React 的 production 构建里没有 act()，@testing-library/react 会直接崩。
          // 容器里 NODE_ENV=production 是给服务端用的，判题沙箱必须按测试环境跑。
          env: { NODE_ENV: 'test' },
        },
      );
      // 报"解析不到"时补一次死后检查：spawn 前明明在、跑完不在了 ⇒ 是运行期间被删的，
      // 与"从来没写成"是两条不同的线索（WI-72 至今没定根因，就差这条区分）。
      if (/Could not resolve\b/.test(`${run.stderr}\n${run.stdout}`)) {
        logWarn('judge', 'react-resolve-failed', {
          questionId: question.id,
          workspace: ws.root,
          missingAfterRun: await missingScaffolds(ws.root, scaffolds),
        });
      }
      progress('collect');
      if (run.timedOut) {
        return errorResult(
          'timeout',
          truncateLog(`判题超时（>${timeoutMs}ms），已强制结束 vitest 进程。常见原因：组件渲染死循环、effect 无限触发、测试未加超时上限。\n${run.stdout}\n${run.stderr}`),
          elapsed(),
          true,
        );
      }

      const raw = await readFile(join(ws.root, RESULTS_FILE), 'utf8').catch(() => undefined);
      if (!raw) {
        return errorResult('runtime', truncateLog(`${run.stdout}\n${run.stderr}`), elapsed());
      }

      let report: VitestReport;
      try {
        report = JSON.parse(raw) as VitestReport;
      } catch {
        return errorResult('runtime', truncateLog(`results.json 解析失败：${raw.slice(0, 2000)}\n${run.stderr}`), elapsed());
      }

      const entries = (report.testResults ?? []).flatMap((file) =>
        (file.assertionResults ?? []).map((assertion) => ({ assertion, file })),
      );
      const fileErrors = (report.testResults ?? [])
        .filter((file) => (file.message ?? '').trim())
        .map((file) => `${file.name ?? 'suite'}: ${String(file.message).replace(ANSI_RE, '')}`);

      // 一个用例都没跑起来 = 代码没编译过 / 模块期就炸，属 error 不属 fail
      if (entries.length === 0) {
        return errorResult(
          classifyCollection(fileErrors),
          truncateLog([...fileErrors, run.stdout, run.stderr].filter(Boolean).join('\n')),
          elapsed(),
        );
      }

      const used = new Set<VitestAssertion>();
      const results: JudgeCaseResult[] = [];
      for (const testCase of cases) {
        const hit = findAssertion(entries, used, testCase.name);
        if (!hit) {
          results.push({
            name: testCase.name,
            passed: false,
            expected: stringify(testCase.expected),
            message: `判题器没有回收该用例结果（测试文件未收集到或被跳过）${fileErrors[0] ? `：${fileErrors[0]}` : ''}`,
          });
          continue;
        }
        used.add(hit.assertion);
        const status = hit.assertion.status ?? 'failed';
        const passed = status === 'passed';
        const line = passed ? undefined : readLine(hit.assertion.failureMessages, ws.root);
        const diff = parseExpectedActual(line);
        results.push({
          name: testCase.name,
          passed,
          expected: diff.expected ?? (passed ? undefined : stringify(testCase.expected)),
          actual: diff.actual ?? (passed ? undefined : line),
          message:
            line ??
            (status === 'passed'
              ? undefined
              : `用例状态为 ${status}（未执行即不计通过）${hit.file.message ? `：${hit.file.message}` : ''}`),
        });
      }

      // 题目文件里多出来的断言也要参与判分，避免"藏用例"导致误判 pass
      for (const entry of entries) {
        if (used.has(entry.assertion)) continue;
        used.add(entry.assertion);
        const name = entry.assertion.fullName ?? entry.assertion.title ?? '额外用例';
        const passed = entry.assertion.status === 'passed';
        const line = passed ? undefined : readLine(entry.assertion.failureMessages, ws.root);
        const diff = parseExpectedActual(line);
        results.push({
          name,
          passed,
          expected: diff.expected,
          actual: diff.actual ?? (passed ? undefined : line),
          message: line,
        });
      }

      return summarize(results, elapsed());
    } finally {
      await ws.cleanup();
    }
  },
};

registerRunner(reactVitestRunner);
