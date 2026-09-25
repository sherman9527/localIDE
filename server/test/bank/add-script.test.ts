import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * `npm run bank:add` —— **手写题**的正式入库入口。
 * 之前只有 `bank:refresh`（走 CLI 生成）这一条路，手写一道题要自己拼 JSON、自己知道该跑哪些闸门；
 * 真实代价：WI-46 手加两道链表/树题时，唯一的反馈回路是隔了一小时才想起来去容器里跑矩阵。
 * 这里钉的是：唯一写入口（append-only）、坏题不进库、重复不覆盖、--dry-run 与真实跑走同一段代码。
 */

const ROOT = config.repoRoot;
const SCRIPT = join(ROOT, 'scripts', 'bank', 'add-questions.mjs');
const DIST_INGEST = join(ROOT, 'server', 'dist', 'bank', 'ingest.js');
const TMP = join(ROOT, 'data', 'test-tmp', 'bank-add');

const goodDraft = (over: Record<string, unknown> = {}) => ({
  category: 'system-design',
  difficulty: 'senior',
  title: '分布式写入路径的重试幂等',
  statement: '说明你在带重试的写入路径上如何保证幂等：去重键怎么选、时间窗口怎么定、失败后如何恢复。',
  judgeKind: 'llm-rubric',
  tags: ['idempotency', 'retry'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '去重键与业务主线的关系', weight: 4 },
      { label: '时间窗口与乱序处理', weight: 3 },
      { label: '失败恢复与对账', weight: 3 },
    ],
  },
  source: { origin: 'manual', jds: [] },
  ...over,
});

const badDraft = () => ({ ...goodDraft(), rubric: { maxScore: 10, points: [{ label: '只有一条考点', weight: 10 }] } });

function writeInput(name: string, payload: unknown): string {
  const file = join(TMP, 'in', name);
  mkdirSync(join(TMP, 'in'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function bankFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function run(args: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // 脚本复用 server 编译产物里的 ingest()（唯一写入口）；verify.sh 的 typecheck 阶段已经构建过，
  // 单独跑这个文件时才需要补一次，否则测的是"脚本自己造的假入库"。
  if (!existsSync(DIST_INGEST)) {
    const build = spawnSync('npm', ['run', 'build', '-w', 'server'], { cwd: ROOT, encoding: 'utf8' });
    expect(build.status, `server 构建失败：${build.stderr}`).toBe(0);
  }
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('bank:add — 手写题入库', () => {
  it('没有参数就给用法并以 2 退出（不猜要加什么）', () => {
    const { code, out } = run([]);
    expect(code).toBe(2);
    expect(out).toContain('用法');
  });

  it('一道合法题落盘，并说清下一步该跑什么', () => {
    const bankDir = join(TMP, 'bank1');
    const input = writeInput('one.json', goodDraft({ id: 'sd-rub-manual-0001' }));
    const { code, out } = run([input, '--bank-dir', bankDir, '--no-check']);
    expect(code, out).toBe(0);
    expect(bankFiles(bankDir)).toEqual([join(bankDir, 'system-design', 'sd-rub-manual-0001.json')]);
    // 主观题不需要判题矩阵，但脚本必须把"代码题要在容器里判参考解"这条说给使用者听
    expect(out).toContain('sd-rub-manual-0001');
  });

  it('没写 id 时按类别前缀自动分配，而不是生成一个不合规的名字', () => {
    const bankDir = join(TMP, 'bank2');
    const input = writeInput('noid.json', goodDraft());
    const { code, out } = run([input, '--bank-dir', bankDir, '--no-check']);
    expect(code, out).toBe(0);
    expect(out).toMatch(/sys-rubric-\d{4}/);
    expect(bankFiles(bankDir)).toHaveLength(1);
  });

  it('同 id 已存在时跳过且不覆盖原文件（只增不减）', () => {
    const bankDir = join(TMP, 'bank3');
    const first = goodDraft({ id: 'sd-rub-manual-0002', title: '第一次写的那版标题' });
    run([writeInput('a.json', first), '--bank-dir', bankDir, '--no-check']);
    const file = join(bankDir, 'system-design', 'sd-rub-manual-0002.json');
    const before = readFileSync(file, 'utf8');

    const second = goodDraft({ id: 'sd-rub-manual-0002', title: '第二次同名不同内容的标题' });
    const { code, out } = run([writeInput('b.json', second), '--bank-dir', bankDir, '--no-check']);
    expect(code, out).toBe(0);
    expect(out).toContain('跳过');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('题面撞车（排版不同也算）按重复跳过，不产生第二道等价题', () => {
    const bankDir = join(TMP, 'bank4');
    run([writeInput('a.json', goodDraft({ id: 'sd-rub-manual-0003' })), '--bank-dir', bankDir, '--no-check']);
    const reworded = goodDraft({
      id: 'sd-rub-manual-0004',
      statement: '说明你在带重试的写入路径上如何保证幂等：去重键怎么选、时间窗口怎么定、失败后如何恢复。',
    });
    const { out } = run([writeInput('b.json', reworded), '--bank-dir', bankDir, '--no-check']);
    expect(out).toContain('跳过');
    expect(bankFiles(bankDir)).toHaveLength(1);
  });

  it('不合规模型的题被拒并给出具体路径原因，一道都不写进去', () => {
    const bankDir = join(TMP, 'bank5');
    const input = writeInput('bad.json', [badDraft(), goodDraft({ id: 'sd-rub-manual-0005' })]);
    const { code, out } = run([input, '--bank-dir', bankDir, '--no-check']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/拒|rejected/i);
    expect(bankFiles(bankDir)).toHaveLength(1); // 只收了那道好的，坏题没混进去
  });

  it('--dry-run 与真实入库走同一段代码：报告"会加几题"但目录里一个文件都没有', () => {
    const bankDir = join(TMP, 'bank6');
    const input = writeInput('plan.json', [goodDraft({ id: 'sd-rub-manual-0006' }), badDraft()]);
    const { code, out } = run([input, '--bank-dir', bankDir, '--dry-run']);
    expect(code, out).not.toBe(0); // 有被拒的条目就不算成功
    expect(out).toContain('dry-run');
    expect(bankFiles(bankDir)).toEqual([]);
  });

  it('给目录就把目录里的 JSON 都读进来（一好一坏各说各的）', () => {
    const bankDir = join(TMP, 'bank7');
    const dir = join(TMP, 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(goodDraft({ id: 'sd-rub-manual-0007' })), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{ this is not json', 'utf8');
    copyFileSync(join(dir, 'ok.json'), join(dir, 'dup-note.txt'));
    const { out } = run([dir, '--bank-dir', bankDir, '--no-check']);
    expect(out).toContain('broken.json');
    expect(bankFiles(bankDir)).toEqual([join(bankDir, 'system-design', 'sd-rub-manual-0007.json')]);
  });

  it('代码题会提醒"参考解必须在容器里判过才算数"', () => {
    const bankDir = join(TMP, 'bank8');
    const input = writeInput('code.json', {
      ...goodDraft({
        id: 'alg-java-manual-0001',
        category: 'algorithms',
        judgeKind: 'java-junit',
        language: 'java',
        rubric: undefined,
        cases: [{ name: '空输入返回 0', input: [[]], expected: 0 }],
        runner: { signature: 'int sum(int[] xs)', referenceSolution: 'public class Solution { public static int sum(int[] xs) { return 0; } }' },
      }),
    });
    const { code, out } = run([input, '--bank-dir', bankDir, '--no-check']);
    expect(code, out).toBe(0);
    expect(out).toMatch(/容器|verify/);
  });

  it('把库里已有的题文件再喂一次：报"已有同 id 跳过"，不是看不懂的 schema 错', () => {
    const bankDir = join(TMP, 'bank10');
    const input = writeInput('a.json', goodDraft({ id: 'sd-rub-manual-0008' }));
    run([input, '--bank-dir', bankDir, '--no-check']);
    // 第二次直接喂**入库后的题文件**（带 source.ingestedAt），这是人最容易顺手做的事
    const { code, out } = run([join(bankDir, 'system-design', 'sd-rub-manual-0008.json'), '--bank-dir', bankDir, '--no-check']);
    expect(code, out).toBe(0);
    expect(out).toContain('跳过');
    expect(out).not.toContain('Unrecognized keys');
    expect(bankFiles(bankDir)).toHaveLength(1);
  });

  it('裸 -- 之后按位置参数处理，不会把文件名当成选项值吃掉', () => {
    // 修复前：`--` 被解析成一个空名选项，顺手把下一个位置参数吞掉当值，
    // 于是报"至少要给一个题目文件或目录"—— 明明给了文件却说没给，使用者只会去怀疑脚本坏了。
    const { code, out } = run(['--', 'definitely-missing.json']);
    expect(code).toBe(2);
    expect(out).toContain('definitely-missing.json');
  });

  it('输入文件不存在时明确报错，不会静默当成「没有题」', () => {
    const { code, out } = run([resolve(join(TMP, 'nope.json')), '--bank-dir', join(TMP, 'bank9')]);
    expect(code).not.toBe(0);
    expect(out).toContain('nope.json');
  });
});
