import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 出处审计：每家公司已入库的题，必须还能由它自己那批生成器逐字段复现。
 *
 * 为什么单独一条闸门：`bank:add` 是追加式的（C5），入库之后没有正规"再同步"出口，
 * 于是"手改了库里的题、生成器还是老文案"这件事只会以两种方式暴露 ——
 * 要么下次重生成草稿把修好的改回坏的，要么某道题的出处根本没人能再算出来。
 * 首跑就抓到四处前者（`alg-java-0030/0031`、`sql-mysql-0016/0019`）与一处后者
 * （DeepSeek `alg-java-0021`：一道没有任何生成器草稿的代码题）。
 *
 * 只在最终验收跑（ARENA_FULL_GATE=1）：它会真的执行六家生成器，
 * 出题过程中"草稿已写、题未入库"是正常状态，那时报红只会误导排查。
 */
const FULL_GATE = process.env.ARENA_FULL_GATE === '1';
const script = join(config.repoRoot, 'scripts', 'bank', 'drafts', 'check_provenance.py');

const python = ['python3', 'python']
  .map((cmd) => ({ cmd, res: spawnSync(cmd, ['--version'], { encoding: 'utf8' }) }))
  .find(({ res }) => res.status === 0)?.cmd ?? null;

describe.skipIf(!FULL_GATE)('题库出处可复现（生成器 ↔ 题库逐字段）', () => {
  it('审计脚本在（没有它这条闸门就是装饰）', () => {
    expect(existsSync(script), `找不到 ${script}`).toBe(true);
  });

  it('六家生成器都能逐字段复现已入库的题（代码题必须有草稿；主观题无草稿只报数）', () => {
    const res = spawnSync(python as string, [script], {
      cwd: config.repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
      // 不指定就按 Windows 的 cp936 输出，脚本里的 `✅`/`↔` 会把 print 直接炸掉
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    console.log(res.stdout.trim().slice(-2500));
    expect(res.stdout.trim().length, '审计没有任何输出（等于没查）').toBeGreaterThan(100);
    expect(res.status, `出处审计失败：\n${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout, '审计里出现了 PROVENANCE 或 DRIFT').not.toMatch(/PROVENANCE|DRIFT/);
  });
});
