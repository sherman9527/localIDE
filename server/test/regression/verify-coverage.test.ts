import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 门禁自己的守卫：verify.sh 的每个阶段是**按路径清单**跑测试的，
 * 所以"新加的测试文件没进任何一条清单"会让它永远不被执行，而流水线照样全绿
 * （实测抓到两例：server/test/log.test.ts 与 config.test.ts 躺在那里没人跑）。
 *
 * 它判的全是"认领"，所以**认领的反义词也归它判**（WI-103）：一条阶段说 `--exclude X` 的时候，
 * 守卫必须听得见"排除"这半句 —— 把它当成"这条阶段跑了 X"就等于让守卫替坏人说谎。
 * 下面每条判据都走 `stageClaims`（路径命中 **且** 没被这条阶段自己排除），不留旁路。
 */

const ROOT = config.repoRoot;

interface Stage {
  label: string;
  vars: string[];
  patterns: string[];
  /**
   * 这条阶段用 `--exclude` 明确**不跑**的那些路径（WI-103）。
   * 它们绝不能进 `patterns`：`--exclude X` 说的是"这一档不跑 X"，把它记成一条认领就是替它说了反话，
   * 而反话的方向恰好是最贵的那种（见 `stageClaims`）。
   */
  excludes: string[];
  /**
   * 这条阶段用 `--reporter=json --outputFile=<路径>` 写出的那份报告（WI-102 的配对判据要用）。
   * 它是"这一档会留下一份可以拿去断言'真的跑过了'的证据"这句话的唯一写法。
   */
  outputs: string[];
}

/**
 * vitest 里"取值单独占一个 token"的选项（`--exclude <glob>` 这种两 token 形状）。
 * 为什么必须有这张表（WI-103 的本体）：`patterns` 的老判据是"以 `-` 开头的 token 丢掉"，
 * 于是**紧跟在选项后面的那个值**被留下来并算作一条认领 —— 而 `--exclude X` 说的恰好是反面。
 * 真撞过的后果：`verify.sh` 的容器分支用三条 `--exclude` 把 kernel / embed / tutorials 摘出去（评审 I-1 的去重），
 * `stages()` 却把它们记成"这条阶段跑了它们" ⇒ 把下面那条专门阶段整条删掉，孤儿判据一个字都不会红
 * （`testFiles()` 那条 `!claimed(...)` 为假）。
 * 表只列脚本里可能用到的那些；`--flag=value` 那种写法天然是一个 token 且以 `-` 开头，已经被丢掉。
 * ⚠ 表里**漏一条**未知带值选项，代价是"把它的值误当认领"（漏红）而不是多红 —— 所以下面那条
 * 「解析器认得 --exclude」把表与脚本的一致性单独判住，不许这张表 quietly 过期。
 */
const VALUE_OPTS = new Set(['--exclude', '--reporter', '--outputfile', '--output-file', '--project', '--dir', '--config', '--shard', '--wait', '--retry']);

/** 取值要单独记一笔的选项：排除（excludes）与产出的 json 报告（outputs）。 */
const OPTION_SINKS: Record<string, 'excludes' | 'outputs'> = {
  '--exclude': 'excludes',
  '--outputfile': 'outputs',
  '--output-file': 'outputs',
};

const normalize = (token: string): string => token.replace(/^\.\//, '').replaceAll('\\', '/');

/** 把 `npx vitest run` 后面那串 token 拆成"认领的路径 / 被排除的路径 / 产出的报告"三堆。 */
function splitArgs(tokens: string[]): { patterns: string[]; excludes: string[]; outputs: string[] } {
  const patterns: string[] = [];
  const excludes: string[] = [];
  const outputs: string[] = [];
  const push = (sink: 'excludes' | 'outputs', value: string) => {
    if (sink === 'excludes') excludes.push(normalize(value));
    else outputs.push(normalize(value));
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === '') continue;
    if (!tok.startsWith('-')) {
      /**
       * 引号 / `$` 开头的是 **shell 展开**（`"${ARR[@]}"` 那种）：静态解析看不见它展开成什么 ⇒ 不许当成认领。
       * 旧注释教作者"别这么写，否则记成一条假路径"；现在改成"这么写就等于没有认领"——
       * **假认领比漏认领贵得多**：漏的那一半有孤儿判据去追，假的那一半什么都追不到（它看起来是绿的）。
       * 后果是作者必须把路径点名写出来，而点名写出来的路径才能被这条守卫判住。
       */
      if (/^["'`$]/.test(tok)) continue;
      patterns.push(normalize(tok));
      continue;
    }
    const eq = tok.indexOf('=');
    const name = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase();
    if (eq !== -1) {
      // `--flag=value`：取值在同一个 token 里，整条不是路径参数 —— 但 outputFile 那一份要记进 outputs。
      const sink = OPTION_SINKS[name];
      if (sink) push(sink, tok.slice(eq + 1));
      continue;
    }
    if (VALUE_OPTS.has(name)) {
      const value = tokens[i + 1];
      i += 1; // 带值选项的**取值**属于这个选项，不是位置参数（WI-103 修的就是这一行）
      const sink = OPTION_SINKS[name];
      if (sink && value) push(sink, value);
    }
  }
  return { patterns, excludes, outputs };
}

const verifyScript = (): string => readFileSync(join(ROOT, 'scripts', 'verify.sh'), 'utf8');

/** 解析 verify.sh 里的 vitest 阶段：`run "名字" env A=1 npx vitest run <路径...>`。 */
function stages(): Stage[] {
  const script = verifyScript();
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
      ...splitArgs(vitest[1].trim().split(/\s+/)),
    });
  }
  return out;
}

/** `run "名字" … node scripts/assert-ran.mjs <那份 json> …` 的那些阶段（WI-102 的配对判据要用）。 */
interface AssertRanCall {
  label: string;
  report: string;
}

/**
 * 解析 assert-ran 那几条阶段引用了哪个报告文件。
 * 为什么要单独解析：assert-ran 判的是"这一档真的执行过用例"，而它读的是**上一条 vitest 阶段写出的那份 json**。
 * 那条 vitest 阶段整条消失时，`data/*.json` 是 bind mount 上的**上一次留下的旧文件**，assert-ran 拿着旧报告
 * 照样报绿 —— 于是"专门阶段被删了"既不红在 vitest（没跑就是没跑，没人问它），也不红在 assert-ran。
 * 这正是 WI-102 点名的"assert-ran 那一半也救不了"，下面那条配对判据堵的就是它。
 */
function assertRanStages(): AssertRanCall[] {
  const out: AssertRanCall[] = [];
  for (const line of verifyScript().split(/\r?\n/)) {
    const m = /^run\s+"([^"]*)"\s+.*scripts\/assert-ran\.mjs\s+(\S+)/.exec(line.trim());
    if (!m?.[1] || !m[2]) continue;
    out.push({ label: m[1], report: normalize(m[2]) });
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
 * 一条阶段"认领"某个文件 = 它的路径清单命中这个文件，**并且它自己没有把这个文件 `--exclude` 掉**。
 * 后半是 WI-103 加的：少了它，`--exclude X` 会被读成"这条阶段跑了 X"（同一个 token 既被当成认领又被当成
 * 排除，而守卫只听见前半句）⇒ 被排除掉一整片的目录看起来仍有人跑，"专门阶段被删了"这件事在孤儿判据上
 * 一个字都不会红。下面每条判据都走这里，不留 `claimed(file, patterns)` 的旁路。
 */
function stageClaims(stage: Stage, file: string): boolean {
  return claimed(file, stage.patterns) && !claimed(file, stage.excludes);
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

  /**
   * 一条**成立**的"手动闸门"申报：那行注释里点的阶段必须 (a) 真实存在、(b) 确实认领了这个文件。
   * 只有成立时它才把文件从下面那条 env 判据里摘出去；不成立的申报**什么都不豁免**（红由
   * 本文件最后那条新用例说清，env 那条也会顺带红 —— 两处红说的是同一件事，先查注释）。
   */
  const manualGateOk = (file: string): boolean => {
    const { declared, label } = manualGate(file);
    if (!declared || !label) return false;
    return all.some((s) => s.label === label && stageClaims(s, file));
  };

  /**
   * "解析器还认得这份脚本吗" —— 原来这条写的是 `expect(patterns.length).toBeGreaterThan(3)`，
   * 而今天 patterns 有 20 多个 ⇒ 删掉 17 条阶段它照样绿（WI-90 收尾轮的审计把这种门叫装饰）。
   * 换成**自洽判据**，不留会腐烂的魔法数：脚本原文里 `npx vitest run` 出现的次数，
   * 必须等于解析出的阶段数。有人改了 `run "…"` 的写法而没同步这里的正则 ⇒ 两个数当场对不上；
   * 一条阶段都解析不出来 ⇒ 第二个判据（>0）红。
   */
  it('脚本里确实有 vitest 阶段（防止改名把守卫一起废掉）', () => {
    const raw = readFileSync(join(ROOT, 'scripts', 'verify.sh'), 'utf8');
    const occurrences = (raw.match(/npx vitest run/g) ?? []).length;
    expect(occurrences, 'verify.sh 里一条 `npx vitest run` 都没有 ⇒ 这个守卫在空转，去查脚本是不是被改写了').toBeGreaterThan(0);
    expect(
      all.length,
      `解析出 ${all.length} 条 vitest 阶段，而脚本原文里有 ${occurrences} 处 \`npx vitest run\` ⇒ 这里的正则与那边的写法对不上了`,
    ).toBe(occurrences);
  });

  it('没有"谁都不跑"的孤儿测试文件', () => {
    // 走 stageClaims 而不是"把所有阶段的 patterns 摊平"：摊平之后 A 阶段的 `--exclude X`
    // 会被 B 阶段的目录认领盖住，而**排除与认领本来就是每条阶段自己的事**（WI-103）。
    const orphans = testFiles().filter((f) => !all.some((s) => stageClaims(s, f)));
    expect(orphans, `这些测试文件不在 verify.sh 任何阶段的路径清单里（或被那条阶段自己 --exclude 掉了）：${orphans.join(', ')}`).toEqual([]);
  });

  /**
   * **WI-103 的第二半：排除必须有接住它的那一边。**
   * `--exclude` 的语义是"这一档不跑它，交给别处跑"（`verify.sh` 里那三条是为了评审 I-1 的去重：
   * 容器分支扫整个 `server/test/notebooks/`，而下面两条专门阶段又点名同样的文件 ⇒ 真 Spark 起两次）。
   * 只把取值从"认领"里摘掉还不够 —— 那只是不再撒谎；这句话才是有牙的那一半：
   * **被摘出去的文件必须由另一条阶段认领**，否则它就是被排除到了没人跑的地方。
   * ⚠ "另一条"要**换个阶段名**：`verify.sh` 里「单元测试…」那两条是同一个阶段的 if/else 两个分支
   *（容器那一条排除、宿主那一条扫目录）。让"同名的另一分支"算认领就等于什么都没判 ——
   * 真跑的那一支不会因为另一支的存在而多跑一个文件。
   * 于是"删掉那条专门阶段"这一串会红在这里（今天它不红 —— 那正是 WI-103 登记的形状）。
   */
  it('被 --exclude 摘出去的文件必须由**另一条不同名**的阶段认领（排除不是新的家）', () => {
    const seen = new Set<string>();
    const homeless: string[] = [];
    for (const stage of all) {
      for (const ex of stage.excludes) {
        for (const file of testFiles()) {
          if (!claimed(file, [ex])) continue;
          const elsewhere = all.some((s) => s.label !== stage.label && stageClaims(s, file));
          // 去重：if/else 的两个分支各报一次同一件事是两条噪音，不是一条新判据
          const line = `${stage.label}：--exclude ${ex} 把 ${file} 摘了出去，而没有任何**别的名字**的阶段认领它`;
          if (!elsewhere && !seen.has(line)) {
            seen.add(line);
            homeless.push(line);
          }
        }
      }
    }
    expect(
      homeless,
      `这些文件被 --exclude 摘出去之后没有人接：\n${homeless.join('\n')}\n` +
        '⇒ 两种坏法之一：①那条**专门阶段**（点名跑它的那一条）被删了或改了名 —— 排除的前提"交给别处跑"当场不成立，' +
        '这个文件在容器档里一行都不会执行；\n' +
        '②`--exclude` 写错了路径（打空的排除不会被执行，而"打空"在 vitest 里不报错）。' +
        '**把 --exclude 删掉不是修法**：那会让同一个文件被两条阶段各跑一遍（评审 I-1 记的那笔 40-90s 的账）',
    ).toEqual([]);
  });

  /**
   * **解析器与脚本的一致性单独判一次**（`.qoder/rules/dev_verify_workflow.md` 第 3 条：装饰性判据要被抓出来）。
   * 上面那条只在 `stages()` 真解析出 excludes 时才有对象；而"解析器悄悄不认识 `--exclude` 了"
   * （有人重排 `VALUE_OPTS` 表、或脚本换成 `"${ARR[@]}"` 那种展开）会让它**退化成空判** —— 空判比红更坏，
   * 因为它看起来是绿的。⇒ 这条数的是脚本里的 `--exclude` token，与 `VALUE_OPTS` 那张表**无关**，
   * 所以两边任一侧漂了都会红在这里（脚本那侧的计数是独立写的，不复用 splitArgs）。
   * ⚠ `written > 0` 也是判据的一部分：`verify.sh` 今天靠 `--exclude` 去重（评审 I-1），
   * 那条设计若被撤掉，这条判据要**跟着改并在 memo 里记账**，不许让它静默变成"两边都是 0，所以相等"。
   */
  it('解析器认得 --exclude：脚本里写了几条排除，stages() 就必须解析出几条（否则上面那条是空判）', () => {
    const script = verifyScript();
    let written = 0;
    for (const line of script.split(/\r?\n/)) {
      const vitest = /^run\s+"[^"]*"\s+.*npx vitest run (.+)$/.exec(line.trim())?.[1];
      if (!vitest) continue;
      const tokens = vitest.trim().split(/\s+/);
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] === '--exclude') {
          written += 1;
          i += 1;
        }
      }
    }
    const parsed = all.reduce((n, s) => n + s.excludes.length, 0);
    expect(written, 'verify.sh 的 vitest 阶段里一条 `--exclude` 都没有 ⇒ 这条判据没有对象。今天那三条是评审 I-1 的去重（容器分支扫目录 + 两条专门阶段点名），' + '要撤它得连带把专门阶段与这段判据一起改掉并在 memo.md 记账，不是让它静默变成 0 == 0').toBeGreaterThan(0);
    expect(parsed, `脚本里写了 ${written} 条 --exclude，而 stages() 只解析出 ${parsed} 条 ⇒ 解析器与脚本已经不一致：漏掉的那些排除会被当成"认领"（WI-103 的形状），被排除的文件于是看起来还在跑。` + '改的是 stages() 里那张 VALUE_OPTS 表（或 splitArgs 的分支），不是脚本').toBe(written);
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
      .filter((x) => !all.some((s) => stageClaims(s, x.file) && x.vars.every((v) => s.vars.includes(v))));
    expect(
      stranded,
      `这些测试用 skipIf 门控，但没有任何"设了对应变量"的阶段认领它们：${stranded
        .map((x) => `${x.file}(${x.vars.join(',')})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  /**
   * **WI-102：一条成立的申报不许替"被交接出去的那一档"免检。**
   * 上面那条 env 判据有个出口：作者写 `verify-gate: manual` 就是认账"这一档我手动跑"。
   * 那条申报的形状已经被判住（真实存在 + 确实认领本文件），但形状成立 ≠ 语义成立：
   * 「写一条指着**目录阶段**的申报 + 把那条**专门阶段**删掉」这一串里，申报指的是真话（目录阶段确实认领它、
   * 确实不设变量），而环境判据因此把这个文件摘出去 —— 专门阶段消失后没有人跑容器那一组，
   * 而 `assert-ran` 那一半也救不了（它自己的阶段引用那份 json，见下面那条配对判据）。
   * ⇒ **判据不许回指文件自己写的注释**，要回指脚本已经说过的那句话：脚本里有一条 `--exclude 这个文件`，
   *   说的就是"这一档不跑它，**交给接得住它的那一条**"。所以被排除（且原本落在同一条阶段的目录清单里）的
   *   门控文件，必须有一条**设了它全部门控变量**的阶段认领它。申报在这里**不豁免** ——
   *   作者不能一边让脚本说"交给别处"，一边让注释说"我自己手动跑"。
   * ⚠ 这条只覆盖"被 --exclude 交接出去"的那批（今天 = kernel / embed / tutorials）。
   *   为什么不给**每一个**门控变量都钉一条"必须存在设了它的阶段"：`server/test/llm/real.test.ts` 那条
   *   `ARENA_LLM_REAL` 是**真手动档**（没有任何阶段设过它，申报指的是真话），照字面写那条 WI 的修法
   *   会在它身上误红 —— 而那恰好会教下一个人"给申报加个豁免"，豁免一加，本条要堵的那一串又回来了。
   *   判据的对象因此挂在**脚本的排除**上，而不是挂在"有没有阶段设过这个变量"上。
   */
  it('被 --exclude 交接出去的门控文件：必须有一条**设了它全部变量**的阶段认领（申报在这里不豁免）', () => {
    const stranded: string[] = [];
    for (const file of testFiles()) {
      const vars = gateVars(file);
      if (vars.length === 0) continue;
      // "交接出去"= 同一条阶段既按路径清单命中它、又自己把它排除掉（打空的排除不算交接，那是另一条判据管的）
      const handedOff = all.some((s) => claimed(file, s.patterns) && claimed(file, s.excludes));
      if (!handedOff) continue;
      const caught = all.some((s) => stageClaims(s, file) && vars.every((v) => s.vars.includes(v)));
      if (!caught) {
        stranded.push(`${file}（门控变量：${vars.join(',')}）被目录阶段的 --exclude 交接出去，而没有任何"设齐这些变量"的阶段认领它`);
      }
    }
    expect(
      stranded,
      `这些文件被交接出去之后没有人接住：\n${stranded.join('\n')}\n` +
        '⇒ 那条**专门阶段**（在命令行上 `env` 里设了这些变量的那一条）被删了、改名了，或被摘掉了 env 前缀。' +
        '写一条 `verify-gate: manual` 的申报**修不了这一条**：申报豁免的是上面那条 env 判据，而这里判的是脚本' +
        '自己已经说过的"交给别处跑"。要么把专门阶段加回来，要么真的撤掉这个门控（连带删掉那些容器档用例），' +
        '而不是留一条注释替它免检',
    ).toEqual([]);
  });

  /**
   * **WI-102 的第二半：`assert-ran` 引用的那份报告必须有活着的生产者。**
   * `assert-ran.mjs` 的判据是"这一档真的执行过用例 / 一条都不许跳"，但它读的是**磁盘上那份 json**。
   * `data/` 是 bind mount：上一条 vitest 阶段整条被删掉之后，旧的 `data/verify-tutorials.json` 还留在那里，
   * 于是 assert-ran 拿着**上一次的报告**报绿 —— 这正是 WI-102 里那句"专门阶段消失 ⇒ 连'整片 skip'都不会被观测到"。
   * ⇒ 配对判住：每条 assert-ran 阶段引用的报告路径，必须由某条 vitest 阶段的 `--outputFile=<同一路径>` 生产。
   * 这条同样**与申报无关**（它判的是阶段集合的结构，一行注释都影响不了它）。
   */
  it('每条 assert-ran 引用的报告，必须由某条 vitest 阶段的 --outputFile 生产（不许读上一次留下的旧 json）', () => {
    const calls = assertRanStages();
    const produced = new Set(all.flatMap((s) => s.outputs));
    // 判据对象的守卫要数 **assert-ran 阶段本身**有几条 —— 不是数 orphans：orphans 为空既可能是"全都有生产者"
    // （好），也可能是"一条都没解析出来"（判据空转）。把两者混在一个数上，空转就长得像通过。
    expect(calls.length, 'verify.sh 里一条 assert-ran 阶段都没解析出来 ⇒ 这条判据没有对象（解析器或脚本漂了）。' + '今天有三条（判题矩阵、教程闸门、WI-91b Task 4 的 Scala kernel 闸门）；真要撤 assert-ran 那套，连带把这条判据改掉并在 memo 记账').toBeGreaterThan(0);
    const orphans = calls.filter((c) => !produced.has(c.report));
    expect(
      orphans,
      `这些 assert-ran 阶段引用了没人生产的报告：${orphans.map((c) => `${c.label} → ${c.report}`).join(', ')}\n` +
        '⇒ 写那份 json 的那条 vitest 阶段（`--reporter=json --outputFile=` 那一条）被删了或改了路径。' +
        '现在 assert-ran 会读**上一次留下的旧报告**并报绿 —— 那比没有这条闸门更坏，因为它让人相信"跑过了"。' +
        '改的是脚本（把生产那份报告的阶段加回来），不是把 assert-ran 删掉',
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
      // 用 stageClaims 而不是 `claimed(file, patterns)`：申报说的"那条阶段按目录认领我"在**排除掉我的那一支**里不成立。
      // 同名两条是 if/else 的两个分支，所以取"任一支真的认领"才算数（与 manualGateOk 同一个判据，不许两处各写一份）。
      if (!all.some((s) => s.label === label && stageClaims(s, file))) {
        bad.push(`${file}：申报的「${stage.label}」确实存在，但它的路径清单不认领这个文件（或被那条阶段自己 --exclude 掉了）⇒ 记错了账本`);
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

  /**
   * **WI-102 的第三半：申报那句"但那里从不设门控变量"必须是真话。**
   * 现存的每一句申报写的都是同一个格式（"由「某阶段」按目录认领，但那里从不设门控变量，所以它是手动档"）。
   * 上面那条形状判据核了**前半句**（阶段存在 + 确实认领本文件），后半句今天一个字都没判 ⇒
   * 一条指着"其实设了变量的那条阶段"的申报，可以把文件从 env 判据里摘出去而永远不红 ——
   * 那是"判据回指作者自己写的注释"这种形状的死角，也是"交接出去"那条覆盖不到的另一半
   * （没有被任何 `--exclude` 提到的文件走的就是这条路）。
   * ⚠ 判"任一同名分支设了该文件的门控变量就算谎"：if/else 的两个分支是同一个阶段的两副面孔，
   *   只要有一支在命令行上设过，那句"从不设"就不成立。
   * 今天这条判据是绿的：唯一的申报在 `server/test/llm/real.test.ts`，它指的「游戏后端与前端测试」不设任何变量。
   */
  it('申报说"那里从不设门控变量" ⇒ 被指的那条阶段（任一同名分支）都不许设本文件的门控变量（申报不许说谎）', () => {
    const lying: string[] = [];
    for (const file of testFiles()) {
      const { declared, label } = manualGate(file);
      if (!declared || !label) continue;
      const vars = gateVars(file);
      if (vars.length === 0) continue;
      for (const s of all) {
        if (s.label !== label) continue;
        const set = s.vars.filter((v) => vars.includes(v));
        if (set.length > 0) {
          lying.push(`${file}：申报说「${label}」从不设门控变量，而它的命令行确实设了 ${set.join(',')} ⇒ 既然那条阶段满足 env 判据，这条申报除了把文件从判据里摘出去之外什么都不做`);
        }
      }
    }
    expect(
      lying,
      `申报的语义与脚本不符：\n${lying.join('\n')}\n` +
        '⇒ 改法是**删掉那行申报**（那条阶段设了变量，env 判据本来就过，不需要作者认账），' +
        '**不是**把变量从阶段命令行上摘掉 —— 后者会让这一档真的不再跑',
    ).toEqual([]);
  });
});
