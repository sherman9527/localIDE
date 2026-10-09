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

/**
 * 作者明知它是手动闸门 —— 写了这行就是"我知道它默认不跑，别替我报警"。
 * ⚠ **但申报必须指着"认领这个文件的那条阶段"说**（WI-90 Task 5 补的，原判据是一个 `includes`）：
 * 旧形状 `text.includes('verify-gate: manual')` 把**整个文件**从 env 判据里摘出去，而后面写什么都不重要 ⇒
 * "加一行这样的注释 + 删掉那条专门阶段"就能让执行层彻底消失、报告里一行都没有（评审绕过口 2）。
 * 现在要求：`verify-gate: manual` 那一行里带一个 **「阶段名」**，且那个名字 (a) 真实存在于 `stages()`、
 * (b) 确实认领了这个文件 —— 两半各堵一种坏法：(a) 堵"随手编一个名字"，(b) 堵"指着一条毫不相干的阶段"
 * （编不出 `(a)` 就红在本文件最后那条新用例上，红话会说出该怎么写）。
 * 同一行只认第一个「」：申报是给机器读的，不是给散文留的空位。
 * ⚠ **申报必须是"独立的一行"**（去掉注释符之后以 `verify-gate: manual` 开头）：散文里引用这串字面量
 * （本文件下面那条新用例的注释就是这种引用）不算申报 —— 判据是"作者在申报"，不是"这串字符出现过"。
 * 实测过反例：判据写成 `text.includes(...)` 时，**本文件自己的注释**被当成申报 ⇒ 守卫红在自己身上。
 */
function manualGate(file: string): { declared: boolean; label: string | null } {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:\/\*+|\*+|\/\/)/, '').trim();
    if (!line.startsWith('verify-gate: manual')) continue;
    const m = /「([^」]+)」/.exec(line);
    return { declared: true, label: m?.[1] ?? null };
  }
  return { declared: false, label: null };
}

describe('verify.sh 覆盖到每一个测试文件', () => {
  const all = stages();
  const patterns = all.flatMap((s) => s.patterns);

  /**
   * 一条**成立**的"手动闸门"申报：那行注释里点的阶段必须 (a) 真实存在、(b) 确实认领了这个文件。
   * 只有成立时它才把文件从下面那条 env 判据里摘出去；不成立的申报**什么都不豁免**（红由
   * 本文件最后那条新用例说清，env 那条也会顺带红 —— 两处红说的是同一件事，先查注释）。
   */
  const manualGateOk = (file: string): boolean => {
    const { declared, label } = manualGate(file);
    if (!declared || !label) return false;
    return all.some((s) => s.label === label && claimed(file, s.patterns));
  };

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
      .filter((x) => x.vars.length > 0 && !manualGateOk(x.file))
      // ⚠ **`every` 只能取在 `x.vars` 上**（这条是被撞出来的，不是审美选择）：
      // 判据要说的等式是「认领它的那条阶段，把这一文件门控要的变量**全都**设了」⇒ 量词落在文件那几个门上。
      // 写成 `s.vars.every(...)`（"阶段设的每个变量都在文件的门里"）看着是同义的，其实是**空判**：
      // `s.vars` 为空时 `[].every()` 恒真，而「单元测试」那条阶段就是 0 个变量、又按目录认领了
      // `server/test/notebooks/` ⇒ kernel.test.ts 永远不算搁浅。实测（本轮终审的破坏性验证）：
      // 把 `ARENA_NOTEBOOK_SERVICE=1` 从 kernel 那条阶段里摘掉，`s.vars.every` 那一版仍 3 passed，
      // 而下面这一版当场红。`some` 的老问题是同一条的反面（只设一个变量就算数），两版都不是"全设了"。
      .filter((x) => !all.some((s) => claimed(x.file, s.patterns) && x.vars.every((v) => s.vars.includes(v))));
    expect(
      stranded,
      `这些测试用 skipIf 门控，但没有任何"设了对应变量"的阶段认领它们：${stranded
        .map((x) => `${x.file}(${x.vars.join(',')})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  /**
   * **申报口自己的判据**（WI-90 Task 5，评审绕过口 2）。上面那条 env 判据有一个"作者主动认账"的出口
   * （`verify-gate: manual`），而出口若不核内容就等于没有：旧判据只 `includes('verify-gate: manual')`，
   * 于是任意一行注释就能把一个文件从整条 env 判据里摘出去，配不上任何真实阶段。
   * ⚠ 这条用例**永远会跑**（不门控、不 skip）—— 它判的是注释的形状，与 Jupyter / 判题栈无关。
   * 三种坏法各自红：①写了申报却没有「阶段名」；②名字是编的（`stages()` 里找不到）；
   * ③名字真存在但**不认领这个文件**（指着隔壁阶段说"我这边的账记在那儿"）。
   * 破坏性验证（宿主档实测）：往 `kernel.test.ts` 写 `verify-gate: manual —— 由「不存在的阶段」手动跑` ⇒ 红；
   * 改成真实的「单元测试（shared + exec + regression + notebooks + server 根级）」⇒ 绿。
   */
  it('申报"手动闸门"的注释必须指着一个真实存在、且确实认领了这个文件的阶段', () => {
    const labels = all.map((s) => s.label);
    const bad: string[] = [];
    for (const file of testFiles()) {
      const { declared, label } = manualGate(file);
      if (!declared) continue;
      if (!label) {
        bad.push(`${file}：写了 verify-gate: manual 但那一行里没有「阶段名」⇒ 申报无法核对，等于免检金牌`);
        continue;
      }
      if (!labels.includes(label)) {
        bad.push(`${file}：申报的「${label}」在 verify.sh 的 vitest 阶段里不存在（编的名字，或者那条阶段已经被删了）`);
        continue;
      }
      const stage = all.find((s) => s.label === label)!;
      if (!claimed(file, stage.patterns)) {
        bad.push(`${file}：申报的「${label}」确实存在，但它的路径清单不认领这个文件 ⇒ 记错了账本`);
      }
    }
    expect(
      bad,
      `verify-gate: manual 的申报形状不成立：\n${bad.join('\n')}\n` +
        '⇒ 修法是在那一行里点上"这条文件实际由哪条阶段认领"的阶段名，例如 ' +
        '`verify-gate: manual —— 由「' +
        (labels[0] ?? '某阶段') +
        '」按目录认领，但那里从不设门控变量，所以它是手动档`。' +
        '**把这条判据删掉不是修法**：删掉它 = 任何一行注释都能让一个 env 门控的闸门从执行层彻底消失',
    ).toEqual([]);
  });
});
