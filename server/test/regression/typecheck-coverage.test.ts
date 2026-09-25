import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 类型检查覆盖面守卫（WI-31）。
 * 起因：`GradePort` 加 `available()` 时假实现漏改，编译器一声不吭——因为 tsconfig 只 include `src`。
 * 这里钉死两件事：1) 每个测试目录都被某个 tsconfig 认领；2) 认领它的 include 与根 typecheck 脚本都还在。
 * 只查配置、不跑 tsc（跑一次要几十秒，不该塞进 pre-commit 快子集）。
 */

/** 各 workspace 的测试目录 → 负责它的 tsconfig。 */
const COVERAGE: Record<string, string> = {
  'shared/test': 'shared/tsconfig.test.json',
  'server/test': 'server/tsconfig.test.json',
  'web/test': 'web/tsconfig.json',
  'tests/e2e': 'tests/tsconfig.json',
};

function readJson(file: string): { include?: string[]; compilerOptions?: Record<string, unknown> } {
  const raw = readFileSync(join(config.repoRoot, file), 'utf8');
  const parse = (text: string) =>
    JSON.parse(text) as { include?: string[]; compilerOptions?: Record<string, unknown> };
  try {
    return parse(raw);
  } catch {
    // tsconfig 允许注释；只在裸解析失败时才剥行注释——剥块注释会把 glob 中间那段也吃掉
    return parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  }
}

/** include 里的 glob 归一化成目录（去掉尾部斜杠加通配的部分），再与测试文件所在目录比对。 */
function claimedDirs(tsconfigPath: string): string[] {
  const json = readJson(tsconfigPath);
  const base = join(config.repoRoot, tsconfigPath, '..');
  return (json.include ?? []).map((pattern) => resolve(base, pattern.replace(/\/?\*\*.*$/, '')));
}

describe('tsconfig 覆盖测试文件', () => {
  for (const [testDir, tsconfigPath] of Object.entries(COVERAGE)) {
    it(`${testDir} 由 ${tsconfigPath} 认领`, () => {
      const claimed = claimedDirs(tsconfigPath);
      const dir = join(config.repoRoot, testDir);
      const owner = claimed.find((c) => c === dir || dir.startsWith(c + sep));
      expect(owner, `${tsconfigPath} 的 include 里没有 ${testDir}：${JSON.stringify(claimed)}`).toBeTruthy();
    });

    it(`${tsconfigPath} 是 noEmit（不污染 build 产物）`, () => {
      expect(readJson(tsconfigPath).compilerOptions?.noEmit).toBe(true);
    });
  }

  it('不存在没被任何 tsconfig 认领的测试文件', () => {
    const claimed = [...new Set(Object.values(COVERAGE).flatMap(claimedDirs))];
    const orphans: string[] = [];
    const scan = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { recursive: true })) {
        const file = String(entry);
        if (!/\.tsx?$/.test(file)) continue;
        const abs = resolve(dir, file);
        if (!claimed.some((c) => abs === c || abs.startsWith(c + sep))) orphans.push(abs);
      }
    };
    for (const entry of readdirSync(config.repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', 'dist', 'data', '.git'].includes(entry.name)) continue;
      scan(join(config.repoRoot, entry.name, 'test'));
      scan(join(config.repoRoot, entry.name, 'e2e'));
    }
    expect(orphans, `这些测试文件所在目录还没接进类型检查：${orphans.join(', ')}`).toEqual([]);
  });
});

describe('npm run typecheck 把每个 tsconfig 都跑上', () => {
  const root = JSON.parse(readFileSync(join(config.repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const build = root.scripts.typecheck ?? '';
  const chain = `${build} ${root.scripts['typecheck:tests'] ?? ''}`;

  it('生产构建（tsc -b）覆盖三个 workspace', () => {
    for (const project of ['shared', 'server', 'web']) {
      expect(build, `tsc -b 少了 ${project}`).toMatch(new RegExp(`tsc -b[^&]*\\b${project}\\b`));
    }
  });

  it('测试项目逐个被 -p 点名，且不是 --dry 之类的空跑', () => {
    // web 的 test 目录本来就在它的 tsconfig include 里，由 tsc -b web 覆盖
    for (const tsconfigPath of ['shared/tsconfig.test.json', 'server/tsconfig.test.json', 'tests/tsconfig.json']) {
      expect(chain, `${tsconfigPath} 没接进 typecheck`).toContain(`-p ${tsconfigPath}`);
    }
    expect(chain).not.toMatch(/--dry|--noCheck/);
  });
});
