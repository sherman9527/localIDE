import { type Question as BankQuestion } from '@arena/shared';
import { describe, expect, it } from 'vitest';
import { visibleQuestions } from '../../src/bank/loader.js';
import { probeStacks, runJudge } from '../../src/judge/registry.js';
import { registerOptionalRunners } from '../../src/judge/runners/index.js';

/**
 * 题库自证矩阵（需求 场景 4 + rule.md C9）：
 * 1) 每题的参考解必须真的通过判题器 —— 否则题目不可解或用例写错；
 * 2) 带 naiveSolution 的题，朴素解必须不通过 —— 否则判题器是橡皮图章。
 * 用 ARENA_CATEGORY=algorithms,sql 可以只跑部分类别（容器内验证时用）。
 */
await registerOptionalRunners();
const stacks = await probeStacks();
const bank = await visibleQuestions();

const only = (process.env.ARENA_CATEGORY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const executable = bank.filter(
  (q) => q.judgeKind !== 'llm-rubric' && (only.length === 0 || only.includes(q.category)),
);

const supported = executable.filter((q) => stacks[q.judgeKind] === true);
const skipped = executable.filter((q) => stacks[q.judgeKind] !== true);

console.log(
  `[matrix] 代码题 ${executable.length} 道，本次可判 ${supported.length} 道，跳过（栈不可用）${skipped.length} 道；栈：${JSON.stringify(stacks)}`,
);

/**
 * "跳过 N 道"以前只是一行普通输出，于是被读成"跑了，只是慢"。
 * 真实事故：`docker compose run --rm tools` 覆盖了 entrypoint，镜像里自管的
 * mysqld / redis-server 没起来 ⇒ 全部 mysql/redis 题静默跳过，而 vitest 全绿
 * （`assert-ran.mjs` 只断言"至少跑到过一条"，抓不住"跳掉一半"）。
 * 宿主机上栈本来就不齐，所以默认只警告；容器内验证请带 `ARENA_REQUIRE_STACKS=1` 直接判红。
 */
if (skipped.length > 0) {
  const kinds = [...new Set(skipped.map((q) => q.judgeKind))].join(', ');
  console.warn(
    `[matrix] ⚠ ${skipped.length} 道没被判（栈不可用：${kinds}）。在容器里跑验证请用 ` +
      '`docker compose exec arena …`——tools 容器不起 mysqld/redis-server。',
  );
  if (process.env.ARENA_REQUIRE_STACKS === '1') {
    it('栈齐：没有题因不可用而被跳过（ARENA_REQUIRE_STACKS=1）', () => {
      expect(skipped.map((q) => `${q.id}:${q.judgeKind}`), `跳过：${kinds}`).toEqual([]);
    });
  }
}

if (executable.length === 0) {
  it('题库里还没有可执行题目（先跑内容生成）', () => {
    expect(executable.length).toBe(0);
  });
}

describe.each(supported)('$id（$category / $judgeKind）', (question) => {
  const q = question as BankQuestion;

  it('参考解通过全部用例', async () => {
    const submission = q.runner?.referenceSolution;
    expect(submission, '题目缺 referenceSolution').toBeTruthy();
    const result = await runJudge({ questionId: q.id, submission: submission as string }, q);
    expect(
      result.status,
      `参考解没过：${result.errorKind ?? ''} ${result.logs ?? ''} 失败用例=${result.failedCases
        .map((c) => `${c.name}(${c.message ?? ''})`)
        .join(' | ')}`,
    ).toBe('pass');
    expect(result.total).toBe(q.cases?.length ?? 0);
  }, 150_000);

  const naive = q.runner?.naiveSolution;
  if (naive) {
    it('朴素解必须被判不通过（判题器不是橡皮图章）', async () => {
      const result = await runJudge({ questionId: q.id, submission: naive }, q);
      expect(result.status, `朴素解竟然通过了：${JSON.stringify(result).slice(0, 300)}`).not.toBe('pass');
    }, 150_000);
  }
});

describe('题目结构完整性', () => {
  it('每道代码题都有 referenceSolution 且至少 3 个用例', () => {
    for (const q of executable) {
      expect(q.runner?.referenceSolution, `${q.id} 缺参考解`).toBeTruthy();
      expect((q.cases?.length ?? 0) >= 3, `${q.id} 用例数 ${q.cases?.length} < 3`).toBe(true);
    }
  });

  it('schemaVersion 与 id 规范一致', () => {
    for (const q of bank) {
      expect(q.id.startsWith(`${shortCategory(q.category)}-`), `${q.id} 前缀与类别不符`).toBe(true);
    }
  });
});

function shortCategory(category: string): string {
  const map: Record<string, string> = {
    frontend: 'fe',
    algorithms: 'alg',
    sql: 'sql',
    'system-design': 'sys',
    'big-data': 'bd',
    'agent-design': 'ag',
    'hot-interviews': 'hot',
  };
  return map[category] ?? 'q';
}
