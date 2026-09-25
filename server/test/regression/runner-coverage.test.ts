import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JUDGE_KINDS, type JudgeKind } from '@arena/shared';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 每个判题器都必须有"正解 pass + 近似错解 fail"的双向往返测试（WI-31 的同类问题，N-10）。
 * 起因：`regression-guard` spec 曾声称 `verify.sh` 会检查 `tests/fixtures/submissions/<kind>`，
 * 而那个目录从来是空的 —— 于是"新加一个 runner 只测了正解"没人报警，而只测正解的判题器
 * 恰恰是最危险的（"能跑但类型不对"的错法也会是绿的，见 memo 里程碑 G 的 int[][] 教训）。
 */

/** 不走 server/test/judge/ 的形态：llm-rubric 由 server/test/llm/* 覆盖。 */
const COVERED_ELSEWHERE: Partial<Record<JudgeKind, string>> = {
  'llm-rubric': 'server/test/llm/rubric.test.ts',
};

const JUDGE_TEST_DIR = join(config.repoRoot, 'server', 'test', 'judge');

/** 双向的机械判据：文件里既要断言过 pass，也要断言过"不是 pass"。 */
function hasBothDirections(source: string): { pass: boolean; fail: boolean } {
  return {
    pass: /toBe\('pass'\)|status\)\.toBe\('pass'|全部通过/.test(source),
    fail:
      /toBe\('fail'\)|toBe\('error'\)|not\.toBe\('pass'\)|toBe\('needs_human'\)|必须被判不通过|不通过/.test(source),
  };
}

describe('每个 judgeKind 都有双向往返测试', () => {
  const files = existsSync(JUDGE_TEST_DIR) ? readdirSync(JUDGE_TEST_DIR) : [];

  for (const kind of JUDGE_KINDS) {
    it(`${kind} 有对应的 runner 测试`, () => {
      const elsewhere = COVERED_ELSEWHERE[kind];
      if (elsewhere) {
        expect(existsSync(join(config.repoRoot, elsewhere)), `${kind} 声称由 ${elsewhere} 覆盖，但文件不存在`).toBe(true);
        return;
      }
      expect(files, `缺 server/test/judge/${kind}.test.ts —— 新 runner 必须自带正解/错解两个方向`).toContain(`${kind}.test.ts`);
    });
  }

  it('runner 测试文件里两个方向都在（只测正解等于没测）', () => {
    const thin = files
      .filter((name) => name.endsWith('.test.ts') && name !== 'guards.test.ts')
      .filter((name) => {
        const source = readFileSync(join(JUDGE_TEST_DIR, name), 'utf8');
        const { pass, fail } = hasBothDirections(source);
        return !(pass && fail);
      });
    expect(thin, `这些 runner 测试缺正解或错解方向：${thin.join(', ')}`).toEqual([]);
  });

  it('题库里用到的每个 judgeKind 都在 JUDGE_KINDS 里（防止题型跑没测的形态）', () => {
    const bankDir = join(config.repoRoot, 'content', 'questions');
    const used = new Set<JudgeKind>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(readFileSync(full, 'utf8')) as { judgeKind?: JudgeKind };
            if (parsed?.judgeKind) used.add(parsed.judgeKind);
          } catch {
            /* 半写入的题目文件由题库闸门管，这里不重复报错 */
          }
        }
      }
    };
    if (existsSync(bankDir)) walk(bankDir);
    const unknown = [...used].filter((kind) => !(JUDGE_KINDS as readonly JudgeKind[]).includes(kind));
    expect(unknown, `题库里出现了没注册的 judgeKind：${unknown.join(', ')}`).toEqual([]);
    for (const kind of used) {
      if (COVERED_ELSEWHERE[kind]) continue;
      expect(files, `题库用了 ${kind}，但没有 server/test/judge/${kind}.test.ts`).toContain(`${kind}.test.ts`);
    }
  });
});
