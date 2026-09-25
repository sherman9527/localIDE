import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 门禁自己的守卫：verify.sh 的每个阶段是**按路径清单**跑测试的，
 * 所以"新加的测试文件没进任何一条清单"会让它永远不被执行，而流水线照样全绿
 * （实测抓到两例：server/test/log.test.ts 与 config.test.ts 躺在那里没人跑）。
 */

const ROOT = config.repoRoot;

interface Stage {
  label: string;
  vars: string[];
  patterns: string[];
}

/** 解析 verify.sh 里的 vitest 阶段：`run "名字" env A=1 npx vitest run <路径...>`。 */
function stages(): Stage[] {
  const script = readFileSync(join(ROOT, 'scripts', 'verify.sh'), 'utf8');
  const out: Stage[] = [];
  for (const line of script.split(/\r?\n/)) {
    const m = /^run\s+"([^"]*)"\s+(.*)$/.exec(line.trim());
    if (!m?.[1] || !m[2]) continue;
    const body = m[2];
    const vitest = /npx vitest run (.+)$/.exec(body);
    if (!vitest?.[1]) continue;
    out.push({
      label: m[1],
      vars: [...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})=[^\s]+/g)].map((v) => v[1]!),
      patterns: vitest[1]
        .trim()
        .split(/\s+/)
        .filter((a) => a && !a.startsWith('-'))
        .map((a) => a.replace(/^\.\//, '').replaceAll('\\', '/')),
    });
  }
  return out;
}

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.browser.ts')) {
        out.push(full.slice(ROOT.length + 1).split(sep).join('/'));
      }
    }
  };
  for (const ws of ['shared', 'server', 'web']) {
    const dir = resolve(ROOT, ws, 'test');
    if (existsSync(dir)) walk(dir);
  }
  return out;
}

function claimed(file: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes('*')) {
      // 只支持脚本里实际用到的形态：目录 + 单层通配（bash 会展开 server/test/*.test.ts）
      const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      return re.test(file);
    }
    return file === p || file.startsWith(`${p}/`);
  });
}

/**
 * 某个测试文件的 skipIf/runIf 到底看哪个环境变量。
 * 只从门控条件本身往回找：`describe.skipIf(!FULL_GATE)` → 找 `const FULL_GATE = process.env.X`。
 * 不做"全文扫 process.env"，否则 `process.env.PATH` 之类的噪音会把闸门刷成假红
 * （实测 provider.test.ts 的 runIf(process.platform) 就被这样误判过一次）。
 */
function gateVars(file: string): string[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const vars = new Set<string>();
  for (const m of text.matchAll(/\b(?:describe|it)\.(?:skipIf|runIf)\(\s*([^)]*?)\s*\)\s*\(/g)) {
    const cond = m[1] ?? '';
    for (const direct of cond.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) vars.add(direct[1]!);
    for (const ident of cond.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = ident[1]!;
      if (name.startsWith('ARENA_') || name.startsWith('SKIP_')) continue; // 已经是环境变量本身
      const decl = new RegExp(`(?:const|let)\\s+${name}\\s*=([^;]*);`, 's').exec(text);
      for (const env of (decl?.[1] ?? '').matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) vars.add(env[1]!);
    }
  }
  return [...vars];
}

/** 作者明知它是手动闸门 —— 写了这行就是"我知道它默认不跑，别替我报警"。 */
function declaresManualGate(file: string): boolean {
  return readFileSync(resolve(ROOT, file), 'utf8').includes('verify-gate: manual');
}

describe('verify.sh 覆盖到每一个测试文件', () => {
  const all = stages();
  const patterns = all.flatMap((s) => s.patterns);

  it('脚本里确实有 vitest 阶段（防止改名把守卫一起废掉）', () => {
    expect(patterns.length).toBeGreaterThan(3);
  });

  it('没有"谁都不跑"的孤儿测试文件', () => {
    const orphans = testFiles().filter((f) => !claimed(f, patterns));
    expect(orphans, `这些测试文件不在 verify.sh 任何阶段的路径清单里：${orphans.join(', ')}`).toEqual([]);
  });

  it('env 门控的闸门必须被"设了那个变量"的阶段认领', () => {
    // "躺在某个阶段的路径清单里"不等于"真跑过"：skipIf(!ARENA_FULL_GATE) 的文件
    // 只要和某个同名目录一起被认领就算通过，而那条闸门可以从来没用开过变量执行过
    // （实测 provenance.test.ts 就是这样：阶段 35 跑整个 bank 目录但不设变量，
    //   设变量的那条只点名了 content）。
    const stranded = testFiles()
      .map((f) => ({ file: f, vars: gateVars(f) }))
      .filter((x) => x.vars.length > 0 && !declaresManualGate(x.file))
      .filter((x) => !all.some((s) => claimed(x.file, s.patterns) && s.vars.some((v) => x.vars.includes(v))));
    expect(
      stranded,
      `这些测试用 skipIf 门控，但没有任何"设了对应变量"的阶段认领它们：${stranded
        .map((x) => `${x.file}(${x.vars.join(',')})`)
        .join(', ')}`,
    ).toEqual([]);
  });
});
