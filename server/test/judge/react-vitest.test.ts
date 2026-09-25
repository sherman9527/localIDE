import { readdir } from 'node:fs/promises';
import { Question, type JudgeResult, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { runJudge } from '../../src/judge/registry.js';
import { reactVitestRunner } from '../../src/judge/runners/react-vitest.js';

/**
 * react-vitest runner（需求 场景 3/4/16）：沙箱内真跑 vitest + jsdom，按用例粒度回报。
 * 依赖镜像内的 linux node_modules（/app/node_modules）；宿主机（windows 二进制 / 无依赖）整体 skip。
 */

/** 题面脚手架：测试文件由出题人写，用例名必须与 cases[].name 一字不差。 */
const TEST_FILE = `import { fireEvent, render, screen } from "@testing-library/react";
import Counter from "./Solution";

it("渲染 label 与初始值", () => {
  render(<Counter label="库存" initial={2} />);
  expect(screen.getByTestId("counter-label").textContent).toBe("库存");
  expect(screen.getByTestId("counter-value").textContent).toBe("2");
});

it("点击加号后值自增", () => {
  render(<Counter label="库存" initial={2} max={5} />);
  fireEvent.click(screen.getByTestId("inc"));
  expect(screen.getByTestId("counter-value").textContent).toBe("3");
});

it("达到 max 时加号按钮禁用", () => {
  render(<Counter label="库存" initial={4} max={5} />);
  fireEvent.click(screen.getByTestId("inc"));
  const btn = screen.getByTestId("inc") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
});

it("onChange 依次收到新值与旧值", () => {
  const calls: number[][] = [];
  render(<Counter label="库存" initial={1} onChange={(next, prev) => calls.push([next, prev])} />);
  fireEvent.click(screen.getByTestId("inc"));
  fireEvent.click(screen.getByTestId("dec"));
  expect(calls).toEqual([[2, 1], [1, 2]]);
});
`;

const CORRECT = `import { useState } from "react";

export interface CounterProps {
  label: string;
  initial?: number;
  min?: number;
  max?: number;
  onChange?: (next: number, prev: number) => void;
}

export default function Counter({ label, initial = 0, min = 0, max = 10, onChange }: CounterProps) {
  const [value, setValue] = useState(initial);
  const step = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next === value) return;
    setValue(next);
    onChange?.(next, value);
  };
  return (
    <div>
      <span data-testid="counter-label">{label}</span>
      <span data-testid="counter-value">{value}</span>
      <button data-testid="dec" disabled={value <= min} onClick={() => step(-1)}>-</button>
      <button data-testid="inc" disabled={value >= max} onClick={() => step(1)}>+</button>
    </div>
  );
}
`;

/** 不做 clamp、不管 disabled：前两个用例侥幸通过，边界用例必挂。 */
const WRONG = `import { useState } from "react";

export default function Counter({ label, initial = 0, onChange }: any) {
  const [value, setValue] = useState(initial);
  const step = (delta: number) => {
    const next = value + delta;
    setValue(next);
    onChange?.(next, value);
  };
  return (
    <div>
      <span data-testid="counter-label">{label}</span>
      <span data-testid="counter-value">{value}</span>
      <button data-testid="dec" onClick={() => step(-1)}>-</button>
      <button data-testid="inc" onClick={() => step(1)}>+</button>
    </div>
  );
}
`;

/** 语法错误：vite 转译阶段就炸 → error(compile)，不能算成用例不通过。 */
const BROKEN = `export default function Counter() {
  const value: = 3;
  return <span>{value}</span>;
}
`;

/** import 期抛异常：用例根本没跑 → error(runtime)。 */
const THROWS = `throw new Error("boom at module scope");

export default function Counter() {
  return null;
}
`;

function makeQuestion(overrides: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'fe-react-harness-0001',
    category: 'frontend',
    difficulty: 'senior',
    title: '实现受控边界计数器 Counter',
    statement: '实现 Counter 组件：展示 label 与当前值，加减按钮在 min/max 边界处禁用，并通过 onChange 回调上报新旧值。',
    judgeKind: 'react-vitest',
    language: 'typescript',
    tags: ['react', 'hooks', 'testing-library'],
    cases: [
      { name: '渲染 label 与初始值', input: { initial: 2 }, expected: 'label=库存 value=2' },
      { name: '点击加号后值自增', input: { initial: 2, clicks: ['inc'] }, expected: '3' },
      { name: '达到 max 时加号按钮禁用', input: { initial: 4, max: 5, clicks: ['inc'] }, expected: 'disabled=true' },
      { name: 'onChange 依次收到新值与旧值', input: { initial: 1, clicks: ['inc', 'dec'] }, expected: '[[2,1],[1,2]]' },
    ],
    runner: {
      entry: 'function',
      files: [{ path: 'counter.test.tsx', content: TEST_FILE }],
      timeoutMs: 20_000,
      referenceSolution: CORRECT,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...overrides,
  }) as BankQuestion;
}

/** 必须顶层 await：describe 回调在 collect 阶段执行，beforeAll 里再赋值来不及。 */
const available = await reactVitestRunner.probe().catch(() => false);
if (!available) console.warn('[judge] 本机无 linux node_modules/vitest，react-vitest 判题测试跳过（容器内会跑）');

/** 本 fixture 的题目 id 前缀（并发跑的其它判题 suite 也会往 data/judge 里开沙箱）。 */
const MY_PREFIXES = ['fe-react-harness-0001'];
const isMine = (name: string) => MY_PREFIXES.some((p) => name.startsWith(p));

/**
 * 判题后无残留（需求 场景 6/14/18）。
 * 自己的沙箱是硬断言；目录整体清空只能等 —— 并发跑的其它判题 suite（以及另一个容器，
 * 因为 ./data 是共享挂载）也会在这里开沙箱，所以对非本 fixture 的残留只告警。
 */
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  let leftovers: string[] = [];
  do {
    leftovers = await readdir(config.judgeWorkDir).catch(() => []);
    if (!leftovers.some(isMine)) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);
  expect(leftovers.filter(isMine), `判题沙箱未清理：${leftovers.filter(isMine).join(', ')}`).toEqual([]);
  const foreign = leftovers.filter((name) => !isMine(name));
  if (foreign.length) console.warn(`[react-vitest] data/judge 仍有别的 suite 的沙箱（并发判题，非本文件残留）：${foreign.join(', ')}`);
});

const guarded = available ? it : it.skip;

describe('react-vitest runner', () => {
  guarded('参考解全部用例通过，且 compile/run/collect 三阶段都有进度事件', async () => {
    const phases: string[] = [];
    const result = await runJudge({ questionId: 'x', submission: CORRECT }, makeQuestion(), (e) => {
      if (e.type === 'progress') phases.push(e.phase);
    });
    // 带上 status/logs：这条曾在容器全量矩阵里挂过一次（单跑与复跑都过），
    // 而裸断言只留下 "expected 'runtime' to be undefined" —— 判题器的日志全丢了，
    // 无法判断是超时、jsdom 起不来还是资源竞争。复现成本 = 再跑一遍整套矩阵。
    expect(result.errorKind, `status=${result.status} logs=${result.logs ?? ''}`).toBeUndefined();
    expect(result.logs ?? '').toEqual('');
    expect(result.status, `errorKind=${result.errorKind} logs=${result.logs ?? ''}`).toBe('pass');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(4);
    expect(result.failedCases).toEqual([]);
    expect(result.passedCases.sort()).toEqual(
      ['onChange 依次收到新值与旧值', '渲染 label 与初始值', '点击加号后值自增', '达到 max 时加号按钮禁用'].sort(),
    );
    expect(phases).toEqual(['compile', 'run', 'collect']);
  }, 120_000);

  guarded('错误解只挂掉的用例被点名（需求 场景 4）', async () => {
    const result = await runJudge({ questionId: 'x', submission: WRONG }, makeQuestion());
    expect(result.status).toBe('fail');
    expect(result.errorKind).toBeUndefined();
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.failedCases.map((c) => c.name)).toEqual(['达到 max 时加号按钮禁用']);
    const mismatch = result.failedCases[0] as JudgeResult['failedCases'][number];
    expect(mismatch.expected).toBe('true');
    expect(mismatch.actual).toBe('false');
    expect(mismatch.message).toMatch(/expected/i);
    expect(mismatch.message).not.toMatch(/\u001b\[/);
  }, 120_000);

  guarded('转译失败归类 error(compile) 而不是 fail', async () => {
    const result = await runJudge({ questionId: 'x', submission: BROKEN }, makeQuestion());
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('compile');
    expect(result.logs).toMatch(/Transform failed|Unexpected|error/i);
    expect(result.logs!.split('\n').length).toBeLessThanOrEqual(21);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(0);
  }, 120_000);

  guarded('模块期异常归类 error(runtime) 并带原始报错', async () => {
    const result = await runJudge({ questionId: 'x', submission: THROWS }, makeQuestion());
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('runtime');
    expect(result.logs).toMatch(/boom at module scope/);
    expect(result.failed).toBe(0);
  }, 120_000);

  guarded('题面缺测试文件时直接报沙箱错误', async () => {
    const q = makeQuestion({
      runner: { entry: 'function', files: [], timeoutMs: 20_000, referenceSolution: CORRECT },
    });
    const result = await runJudge({ questionId: 'x', submission: CORRECT }, q);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('sandbox');
  }, 30_000);

  guarded('extraFiles 路径穿越被拒绝（需求 场景 6）', async () => {
    const result = await runJudge(
      { questionId: 'x', submission: CORRECT, extraFiles: [{ path: '../../escape.ts', content: 'export const a = 1;' }] },
      makeQuestion(),
    );
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('forbidden');
    expect(result.logs).toMatch(/escape\.ts/);
  }, 30_000);

  guarded('extraFiles 不许覆盖判题器保留文件（否则贴一份同名假测试就能把错误解判成 pass）', async () => {
    const q = makeQuestion();
    const testPath = (q.runner?.files ?? []).find((f) => /\.test\./.test(f.path))?.path ?? 'solution.test.tsx';
    for (const path of [testPath, 'vitest.config.mjs', 'results.json', 'arena.setup.mjs']) {
      const result = await runJudge(
        { questionId: 'x', submission: WRONG, extraFiles: [{ path, content: 'it("占位", () => { expect(1).toBe(1); });' }] },
        q,
      );
      expect(result.status, path).toBe('error');
      expect(result.errorKind, path).toBe('forbidden');
      expect(result.logs, path).toMatch(/保留文件名|非法文件名/);
    }
  }, 30_000);

  guarded('extraFiles 支持多文件提交并被 Solution 引用', async () => {
    const q = makeQuestion({
      runner: {
        entry: 'function',
        files: [
          {
            path: 'multi.test.tsx',
            content: `import { render, screen } from "@testing-library/react";
import Counter from "./Solution";
import { LABEL } from "./labels";

it("引用了提交里的第二个文件", () => {
  render(<Counter label={LABEL} initial={0} />);
  expect(screen.getByTestId("counter-label").textContent).toBe("multi-file");
});
`,
          },
        ],
        timeoutMs: 20_000,
        referenceSolution: CORRECT,
      },
      cases: [{ name: '引用了提交里的第二个文件', input: {}, expected: 'multi-file' }],
    });
    const result = await runJudge(
      { questionId: 'x', submission: CORRECT, extraFiles: [{ path: 'labels.ts', content: 'export const LABEL = "multi-file";' }] },
      q,
    );
    expect(result.logs ?? '').toEqual('');
    expect(result.status).toBe('pass');
    expect(result.total).toBe(1);
  }, 120_000);
});

/** N-06：提交落盘位置由 runner.submissionPath 表达，className 只留给类名本义。 */
describe('react-vitest 的 submissionPath', () => {
  const CASE_NAME = '按 submissionPath 落盘后可被测试 import';
  const pathTest = (importPath: string): string =>
    'import { render, screen } from "@testing-library/react";\n' +
    `import Counter from "${importPath}";\n\n` +
    `it("${CASE_NAME}", () => {\n` +
    '  render(<Counter label="库存" initial={2} />);\n' +
    '  expect(screen.getByTestId("counter-value").textContent).toBe("2");\n' +
    '});\n';
  // 用例名必须与测试里的 it() 一字不差，否则没匹配到断言会伪装成判题失败
  const PATH_CASES = [{ name: CASE_NAME, input: { initial: 2 }, expected: 'value=2' }];

  const questionFor = (importPath: string, runnerExtra: Record<string, unknown>) =>
    makeQuestion({
      cases: PATH_CASES,
      runner: {
        entry: 'function',
        files: [{ path: 'counter.test.tsx', content: pathTest(importPath) }],
        timeoutMs: 20_000,
        referenceSolution: CORRECT,
        ...runnerExtra,
      },
    });

  it('runner.submissionPath 决定提交落在哪个文件', async () => {
    const question = questionFor('./src/Counter', { submissionPath: 'src/Counter.tsx' });
    const result = await runJudge({ questionId: question.id, submission: CORRECT }, question);
    expect(result.status, result.logs).toBe('pass');
  });

  it('className 不再被当成提交文件名（它只表示类名）', async () => {
    const question = questionFor('./src/Counter', { className: 'src/Counter.tsx' });
    const result = await runJudge({ questionId: question.id, submission: CORRECT }, question);
    // 提交落在默认的 Solution.tsx，测试里的 ./src/Counter 解析不到 → 必须失败而不是侥幸通过
    expect(result.status, 'className 仍在被当作落盘路径用').not.toBe('pass');
  });
});
