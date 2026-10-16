import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * WI-93：Jupyter 掉了要自己能回来，不许再靠"人再跑一次 ./start.sh"。
 *
 * 症状是实测出来的（不是推理）：容器里 `pkill -f jupyter-notebook` 之后 8888 一直空着，
 * `/api/notebook/status` 老实报 `running:false`（这一半本来就是诚实的），但**没有任何东西会把它再起回来**。
 *
 * 判据两层，分工与 `env-write-atomicity.test.ts` 一样：
 * ① 结构（永远跑，不需要 bash）—— 钉"循环 + 退避 + 上限 + 追加日志 + 后台调用"这五件事还在文本里。
 *    光有行为判据不够：有人把上限删掉换成 `while true`，行为测试在 max=3 的桩下照样绿。
 * ② 行为（有 bash 才跑）—— 把 `start_jupyter` **本体从 entrypoint.sh 里抠出来真跑**，
 *    用桩替掉 `jupyter`（bash 里函数优先于外部命令，与 env-write-atomicity 桩 mv/chmod 同一手法）
 *    与 `sleep`（把退避序列记到文件里，这样"隔了多久"不需要真等）。
 *
 * ⚠ 一处坦白：循环里"活了 ≥60s 就把失败计数清零"那一条**只有结构判据覆盖**，行为判据没判它 ——
 * 它要 60 秒墙钟才走到，而为了测它把每轮验证拖一分钟不是划算的买卖。
 * 写在这里而不是不写：这一条是"偶发一次崩溃不要把之后所有重启都推到 60s 退避"的保险，
 * 真出问题时的排查入口是这条注释指的那一行。
 */

const ENTRY = readFileSync(join(config.repoRoot, 'docker', 'entrypoint.sh'), 'utf8');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

/** 抠出 `start_jupyter() {` 到它顶格的 `}`（与 env-write-atomicity 的 extractShFn 同一口径）。 */
function extractFn(name: string): string {
  const lines = ENTRY.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  expect(at, `entrypoint.sh 里找不到 ${name}() { ⇒ 函数改名或挪走了，本闸门要同步改（不许静默空转）`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = at; i < lines.length; i++) {
    const l = lines[i] as string;
    out.push(l);
    if (i > at && /^\}/.test(l)) return out.join('\n');
  }
  throw new Error(`entrypoint.sh 的 ${name}() 找不到顶格的 } ⇒ 本闸门的抠取逻辑要同步`);
}

const FN = extractFn('start_jupyter');

describe('Jupyter 的监督循环（WI-93）：结构判据（不需要 bash，永远跑）', () => {
  it('start_jupyter 里是一个**有上限**的重启循环，而不是一次性后台起进程', () => {
    for (const [need, why] of [
      [/while\s*:\s*;\s*do/, '没有循环 ⇒ Jupyter 掉了还是没人管（这就是 WI-93 原本的病）'],
      [/rc=\$\?/, '不接退出码 ⇒ 重启日志里的 rc 是编的，掉过一次看不出来'],
      [/\[\s*"\$fail"\s*-ge\s*"\$\{ARENA_JUPYTER_RESTART_MAX:-\d+\}"/, '重启没有上限 ⇒ 8888 被占时它会无限刷日志，把"其实起不来"藏进噪音里'],
      [/sleep\s+"\$wait"/, '退避之间不睡 ⇒ 失败得越快转得越快'],
      [/dur.*-ge\s*60/, '没有"活够 60s 就清零"那一条 ⇒ 一次偶发崩溃会把之后所有重启都推到长退避上'],
    ] as const) {
      expect(FN, why).toMatch(need);
    }
    // 日志必须**追加**：`>` 会在每次重启时把上一份截掉，于是"它掉过、掉了几次"这件事自己先从日志里消失
    expect(FN, 'notebook-server.log 不许用 > 重定向 ⇒ 每次重启都会截掉上一份，重启历史自己先没了').toMatch(/>>"\$\{nb_root\}\/notebook-server\.log"/);
    // 那条命令的**收尾行**不许再挂 `&`（挂了就没人接退出码，监督循环等于不在）。
    // 判"收尾行整行"而不是"命令之后不许出现 &"：循环体里本来就有 `&&` 与 `2>&1`，那样判是误伤。
    const lastLine = FN.split('\n').find((l) => /notebook-server\.log" 2>&1/.test(l)) ?? '';
    expect(lastLine.trim(), 'jupyter 那条命令必须以 `2>&1` 收尾、末尾不许有 & ⇒ 后台起来就没人接它的退出码').toBe('>>"${nb_root}/notebook-server.log" 2>&1');
  });

  it('两道原有的守卫没被这次改动挪走：缺 token 先不起，且在 mkdir 之前', () => {
    const guardAt = FN.search(/ARENA_JUPYTER_TOKEN:-\}/);
    expect(guardAt, 'token 必填那道守卫不见了 ⇒ 会起一个无鉴权的 notebook 服务（那是 .env 唯一来源那条纪律的反面）').toBeGreaterThanOrEqual(0);
    const mkAt = FN.search(/mkdir\s+-p/);
    expect(mkAt, '找不到 mkdir 那道落点 ⇒ 本条判据要跟着实现同步').toBeGreaterThanOrEqual(0);
    expect(guardAt, '缺 token 的早退必须在 mkdir **之前**：不参与 notebook 的实例不该在真人 data/ 里留目录（WI-40 的隔离纪律）').toBeLessThan(mkAt);
    const loopAt = FN.search(/while\s*:/);
    expect(guardAt, '守卫若被挪进循环里，每一次重启都会重新判 ⇒ 必须仍在循环之前').toBeLessThan(loopAt);
  });

  it('调用处是后台起监督，主进程仍然是 exec 的那个应用', () => {
    // 调用处：只认"以 start_jupyter 开头且不是定义"那一行（定义那行也以它开头）
    const call = ENTRY.split('\n').find((l) => /^start_jupyter\b(?!\s*\()/.test(l)) ?? '';
    expect(call, '`start_jupyter` 的调用处不见了 ⇒ 谁在起 notebook？本条判据要跟着同步').toMatch(/&\s*(#.*)?$/);
    const execAt = ENTRY.indexOf('exec "$@"');
    expect(execAt, 'entrypoint 末尾必须还是 `exec "$@"`：容器主进程是应用，不是监督循环').toBeGreaterThanOrEqual(0);
    expect(ENTRY.slice(0, execAt).indexOf('start_jupyter &'), '监督循环要在 exec 之前就被放到后台').toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!hasBash)('Jupyter 的监督循环（WI-93）：把实现抠出来真跑（桩掉 jupyter 与 sleep）', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  type Outcome = { rc: number | null; out: string; err: string; logs: string; sleeps: string[]; nbLog: string };

  /**
   * 在临时目录里真跑一次抠出来的 start_jupyter。
   * `script` 是桩 `jupyter` 的函数体（决定这次"运行"怎么结束）；`max` 是重启上限；
   * `seedLog` 用来验"追加不截断"：先往 notebook-server.log 里写一行标记，跑完之后它必须还在。
   */
  function runSupervisor(script: string, opts: { max?: string; seedLog?: string } = {}): Outcome {
    const dir = mkdtempSync(join(tmpdir(), 'arena-jupytersup-'));
    scratch.push(dir);
    const nbRoot = join(dir, 'data');
    const shell = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log() { printf "[log] %s\\n" "$*" >>"' + join(dir, 'entrypoint.log') + '"; }',
      // 桩掉 sleep：退避"隔多久"记到文件里，于是这条判据不需要真等（同一手法见 env-write-atomicity 的 mv/chmod 桩）
      'sleep() { printf \'%s\\n\' "$1" >>"' + join(dir, 'sleeps.txt') + '"; }',
      'jupyter() { ' + script + ' }',
      'mkdir() { command mkdir "$@"; }', // 真建目录：函数里那道 mkdir 要落盘，但也只落在本临时目录
      '# ↓↓↓ 从 docker/entrypoint.sh 当场抠出来的本体（不是副本） ↓↓↓',
      // 落点用**环境变量**传进去，而不是把路径文本替进脚本里：替进去的那份会被 bash 再解析一遍，
      // 而 Windows 路径的反斜杠在非引号上下文里是转义符（实测 `""C:\a\b""` 变成 `Cab`），
      // 于是桩写到一个谁也找不到的相对文件名上 —— 判据看着"日志没追加"，其实是量具放错了地方。
      FN.replace(/\$\{ARENA_DATA_DIR:-\/app\/data\}/g, () => '${ARENA_DATA_DIR}'),
      '# ↑↑↑ 以上是实现本体 ↑↑↑',
      'ARENA_JUPYTER_TOKEN=gate-token',
      'ARENA_JUPYTER_RESTART_MAX=' + (opts.max ?? '10'),
      'start_jupyter',
      'printf "RC=%s\\n" "$?"',
    ].join('\n');
    writeFileSync(join(dir, 'harness.sh'), shell, 'utf8');
    if (opts.seedLog !== undefined) {
      // 先建出 nb_root：函数体里那道 mkdir 是 bash 跑的，而这里要在它之前把标记行放进去
      mkdirSync(join(nbRoot, 'notebooks'), { recursive: true });
      writeFileSync(join(nbRoot, 'notebook-server.log'), opts.seedLog, 'utf8');
    }
    const r = spawnSync('bash', ['harness.sh'], { cwd: dir, encoding: 'utf8', shell: false, env: { ...process.env, ARENA_DATA_DIR: nbRoot } });
    const p = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
    return {
      rc: r.status,
      out: r.stdout ?? '',
      err: r.stderr ?? '',
      logs: p('entrypoint.log'),
      sleeps: p('sleeps.txt').split('\n').filter(Boolean),
      nbLog: existsSync(join(nbRoot, 'notebook-server.log')) ? readFileSync(join(nbRoot, 'notebook-server.log'), 'utf8') : '',
    };
  }

  it('连续快速失败会重启到上限然后停手，退避是 2、4 递增，且日志是追加不是截断', () => {
    const r = runSupervisor('printf "stub: boom\\n"; return 3;', { max: '3', seedLog: 'MARKER-BEFORE-RESTART\n' });
    expect(r.rc, `harness 自己出错了：${r.err}`).toBe(0);
    // max=3 ⇒ 失败 1 次退避一次、失败 2 次退避一次、第 3 次到上限停手 ⇒ sleep 被叫两次
    expect(r.sleeps, '退避序列不对（应当是 2 的幂、且在到上限时停）').toEqual(['2', '4']);
    expect(r.logs, '停手那一句必须说清"不再重启"、几次、以及最后一次 rc').toMatch(/不再重启/);
    expect(r.logs, '重启日志要带上退出码：rc=3 是"谁把进程杀了"的第一条线索').toMatch(/rc=3/);
    expect(r.logs, '每次重启都要留一行，否则"掉过几次"读不出来').toMatch(/再起（连续快速失败 1\/3）/);
    expect(r.logs, '进入监督那句要在**循环之前**打一次（它说的是开始监督，不是说它活着）').toMatch(/进入监督循环/);
    expect(r.logs.split('进入监督循环').length - 1, '开始监督那句不该在每次重启时重复打').toBe(1);
    expect(r.nbLog, 'notebook-server.log 被截断了 ⇒ 重启历史自己先从日志里消失').toContain('MARKER-BEFORE-RESTART');
    expect(r.nbLog, 'stub 的输出要落进日志（追加之后仍然接得上）').toContain('stub: boom');
  });

  it('上限 = 1 时一次快速失败就停手，且不睡（这是"起不来就如实不起"那一档，不是崩溃循环）', () => {
    const r = runSupervisor('return 1;', { max: '1' });
    expect(r.rc, `harness 自己出错了：${r.err}`).toBe(0);
    expect(r.sleeps, '到上限就停手 ⇒ 一次都不该睡').toEqual([]);
    expect(r.logs, '一次失败也要留下一行可查的日志').toMatch(/不再重启/);
    expect(r.logs, '上限=1 时第一次失败就应当是"连续 1 次"').toMatch(/连续 1 次/);
  });

  it('缺 token 时整个监督根本不启动（早退的形状不许被循环改坏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-jupyternoto-'));
    scratch.push(dir);
    const nbRoot = join(dir, 'data');
    const shell = ['#!/usr/bin/env bash', 'set -uo pipefail', 'log() { printf "[log] %s\\n" "$*" >>"' + join(dir, 'l') + '"; }',
      'jupyter() { return 0; }', FN.replace(/\$\{ARENA_DATA_DIR:-\/app\/data\}/g, () => '${ARENA_DATA_DIR}'),
      'ARENA_JUPYTER_TOKEN=; start_jupyter; printf "RC=%s\\n" "$?"'].join('\n');
    writeFileSync(join(dir, 'h.sh'), shell, 'utf8');
    const env = { ...process.env };
    delete env.ARENA_JUPYTER_TOKEN; // 模拟"这个实例没被透传 token"（e2e / dev 的形状）
    const r = spawnSync('bash', ['h.sh'], { cwd: dir, encoding: 'utf8', shell: false, env: { ...env, ARENA_DATA_DIR: nbRoot } });
    const logs = existsSync(join(dir, 'l')) ? readFileSync(join(dir, 'l'), 'utf8') : '';
    expect(r.stdout, `早退必须返回 0（notebook 起不来不许拖垮做题）：${r.stdout}${r.stderr}`).toContain('RC=0');
    expect(logs, '要说清"因为缺 token 所以没起"，而不是静悄悄').toMatch(/缺 ARENA_JUPYTER_TOKEN/);
    expect(logs, '缺 token 时不该进入监督循环（否则每 2 秒重试一次一个永远起不来的服务）').not.toMatch(/进入监督循环|再起/);
    expect(existsSync(join(dir, 'data')), '缺 token 的实例连目录都不该在真人 data/ 里留下').toBe(false);
  });
});
