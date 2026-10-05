import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * `.env` 改写的**常驻**闸门（评审 Important 1）。
 *
 * 上一轮那两条加固（rc=1 与 rc=2 走成同一条路那一类、"调用方必须停下"）是靠临时目录里
 * 一次性的证明脚本跑的，跑完就删了 ⇒ 仓库里没有任何东西拦得住"有人把
 * `grep -v … || : >"$tmp"` 抄回来"。而 `dev_verify_workflow.md` 第 3 条就是"门禁自己也要被门禁"。
 *
 * 判据的对象是**仓库里那两份实现本身**，不是副本：
 * ① 从 `start.sh` / `start.ps1` 当场抠出函数本体再执行（先例：commit-identity.test.ts:23-34、
 *    scripts-syntax.test.ts:68-84 都从测试里 spawnSync 真 bash）。抠不到 / 抠出来是空壳 ⇒ 判红，
 *    不许"函数改名 ⇒ 闸门静默变成装饰品"。
 * ② `ENV_FILE` / `$EnvFile` 一律落在临时目录；仓库那份真 `.env` 一个字节都不许被读或被写
 *    （文件末尾的 afterAll 哨兵只比 size/mtime，永远不读内容 —— 里面是 token）。
 * ③ 行为判据三组：非法/带正则元字符的键名 ⇒ 非零返回码**且 `.env` 逐字节没动**；
 *    `mv` / `Move-Item` 注入失败 ⇒ **调用方**（start_bridge / Start-Bridge）非零，不是只有 helper 非零；
 *    普通追加/覆写 ⇒ 别的键与中文注释原样保留、不引入 CR/BOM、写完读回来就是写进去的那个值。
 * ④ 再加一条结构判据，兜住"③ 全靠入口键名闸门还在才成立"这件事：把"键名进正则"与
 *    "失败被吞成截空"直接钉在代码文本上，并用内联的旧实现当常驻反例
 *    （形状照 notebook-env-isolation.test.ts 的"判据自己也进 fixture"）。
 */

const SH_SRC = readFileSync(join(config.repoRoot, 'start.sh'), 'utf8');
const PS_SRC = readFileSync(join(config.repoRoot, 'start.ps1'), 'utf8');

const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const hasPs = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;

/** 追加/覆写用例的基准 .env：两条注释（其一含中文，验 UTF-8 原样穿过）+ 两个已有键，LF 行尾。 */
const SEED = [
  '# arena token source of truth (do not commit)',
  'OTHER_KEY=keep-me',
  '# 中文注释：桥 token 与 notebook token 都只写在这里',
  'ARENA_PORT=7788',
  '',
].join('\n');
const SEED_BYTES = Buffer.from(SEED, 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ 临时目录与哨兵 */

const scratch: string[] = [];
const REPO_ENV = join(config.repoRoot, '.env');
let repoEnvStat: { size: number; mtimeMs: number } | null = null;

function newDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `arena-envgate-${tag}-`));
  scratch.push(dir);
  return dir;
}

beforeAll(() => {
  if (existsSync(REPO_ENV)) {
    const st = statSync(REPO_ENV);
    repoEnvStat = { size: st.size, mtimeMs: st.mtimeMs };
  }
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  if (repoEnvStat) {
    const st = statSync(REPO_ENV);
    // 只比元数据：这个文件里装着桥 token 与 Jupyter token，本闸门既不读它也不写它
    expect(st.size, '仓库真 .env 的大小变了 ⇒ 本闸门写到了仓库目录（判据设计错误，不是实现的问题）').toBe(repoEnvStat.size);
    expect(st.mtimeMs, '仓库真 .env 的 mtime 变了 ⇒ 本闸门写过仓库目录里那份').toBe(repoEnvStat.mtimeMs);
  }
});

/* ------------------------------------------------------------------ 抠实现 */

/** bash 函数本体：`name() {` 到顶格的 `}`；单行定义（`name() { … }`）也认。 */
function extractShFn(name: string): string {
  const lines = SH_SRC.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  expect(at, `start.sh 里找不到 ${name}() { ⇒ 函数改名或挪走了，本闸门要同步改（不许静默空转）`).toBeGreaterThanOrEqual(0);
  const def = lines[at] as string;
  if (/\}\s*$/.test(def)) return def;
  const out = [def];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^\}/.test(l)) return [...out, l].join('\n');
    out.push(l);
  }
  throw new Error(`start.sh 的 ${name}() 找不到顶格的 } ⇒ 书写风格变了，本闸门的抠取逻辑要同步`);
}

/** powershell 函数本体：`function Name` 起，到花括号配平（单行定义也认）。 */
function extractPsFn(name: string): string {
  const lines = PS_SRC.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^function\\s+${name}\\b`).test(l));
  expect(at, `start.ps1 里找不到 function ${name} ⇒ 函数改名或挪走了，本闸门要同步改（不许静默空转）`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  let depth = 0;
  for (let i = at; i < lines.length; i++) {
    const l = lines[i] as string;
    out.push(l);
    for (const ch of l) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) return out.join('\n');
  }
  throw new Error(`start.ps1 的 function ${name} 花括号没配平 ⇒ 抠取逻辑要同步`);
}

const shGlobals = SH_SRC.split('\n')
  .filter((l) => /^(ENV_FILE|BRIDGE_PID)=/.test(l))
  .join('\n');

const SH_READ = extractShFn('read_env_key');
const SH_WRITE = extractShFn('write_env_key');
const SH_READ_TOKEN = extractShFn('read_env_token');
const SH_WRITE_TOKEN = extractShFn('write_env_token');
const SH_READ_JUPYTER = extractShFn('read_env_jupyter_token');
const SH_WRITE_JUPYTER = extractShFn('write_env_jupyter_token');
const SH_BRIDGE = extractShFn('start_bridge');

const PS_READ = extractPsFn('Read-EnvKey');
const PS_WRITE = extractPsFn('Write-EnvKey');
const PS_READ_TOKEN = extractPsFn('Read-EnvToken');
const PS_WRITE_TOKEN = extractPsFn('Write-EnvToken');
const PS_READ_JUPYTER = extractPsFn('Read-EnvJupyterToken');
const PS_WRITE_JUPYTER = extractPsFn('Write-EnvJupyterToken');
const PS_BRIDGE = extractPsFn('Start-Bridge');

/* ------------------------------------------------------------------ bash harness */

type Run = {
  rc: number | null;
  out: string;
  err: string;
  dir: string;
  bytes: () => Buffer | null;
  text: () => string;
  tmps: () => string[];
};

function resultOf(dir: string, r: { status: number | null; stdout?: string; stderr?: string }): Run {
  const envPath = join(dir, '.env');
  return {
    rc: r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    dir,
    bytes: () => (existsSync(envPath) ? readFileSync(envPath) : null),
    text: () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''),
    tmps: () => readdirSync(dir).filter((f) => f.startsWith('.env.tmp.')),
  };
}

/**
 * 把抠出来的实现装进临时目录跑。
 * `failMv` 是把 `mv` 换成同名 shell 函数（bash 里函数优先于外部命令）注入失败：
 * 'all' = 每次都不让 mv 成功；数字 = 只让第 N 次失败（用来分别命中 start_bridge 里的两个调用点）。
 */
function runSh(body: string, opts: { seed?: string | null; env?: Record<string, string>; failMv?: 'all' | 'none' | number } = {}): Run {
  const dir = newDir('sh');
  if (opts.seed !== null) writeFileSync(join(dir, '.env'), opts.seed ?? SEED, 'utf8');
  const failMv = String(opts.failMv ?? 'none');
  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    '# ↓↓↓ 从仓库里的 start.sh 当场抠出来的本体（不是副本） ↓↓↓',
    extractShFn('say'),
    extractShFn('fail'),
    shGlobals,
    'ENV_FILE=".env" # harness 自己再钉一次：cwd 已经是临时目录，任何写入都不许落到仓库去',
    SH_READ,
    SH_WRITE,
    SH_READ_TOKEN,
    SH_WRITE_TOKEN,
    SH_READ_JUPYTER,
    SH_WRITE_JUPYTER,
    SH_BRIDGE,
    '# ↑↑↑ 以上是实现本体；以下是桩 —— 只为了让 start_bridge 不会真去起桥、不碰 :7799 ↑↑↑',
    'bridge_probe() { echo ours; }',
    'stop_bridge() { :; }',
    'stop_bridge_on_port() { return 0; }',
    'MV_N=0',
    'mv() {',
    '  MV_N=$((MV_N + 1))',
    `  if [ "${failMv}" = "all" ] || [ "$MV_N" = "${failMv}" ]; then`,
    '    echo "[harness] 注入：第 ${MV_N} 次 mv 失败（模拟磁盘满 / 目标被别的进程占着）" >&2',
    '    return 1',
    '  fi',
    '  command mv "$@"',
    '}',
    body,
  ].join('\n');
  writeFileSync(join(dir, 'harness.sh'), script, 'utf8');
  const r = spawnSync('bash', ['harness.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  return resultOf(dir, r);
}

/** bash 单引号安全引用：键名里带空格/引号/正则元字符时也要当一个参数传进去。 */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ PowerShell harness */

function runPs(body: string, opts: { seed?: string | null; env?: Record<string, string>; failMove?: boolean; bridge?: boolean } = {}): Run {
  const dir = newDir('ps');
  if (opts.seed !== null) writeFileSync(join(dir, '.env'), opts.seed ?? SEED, 'utf8');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '# ↓↓↓ 从仓库里的 start.ps1 当场抠出来的本体（不是副本） ↓↓↓',
    PS_READ,
    PS_WRITE,
    PS_READ_TOKEN,
    PS_WRITE_TOKEN,
    PS_READ_JUPYTER,
    PS_WRITE_JUPYTER,
    // 真 Start-Bridge 本体（只有需要它的用例装），后面那几个桩让它在"探针=ours"这一步就 return：
    // 不碰 :7799、不起 node、不杀任何进程。
    ...(opts.bridge ? [PS_BRIDGE, 'function Get-BridgeState([string]$token) { return "ours" }', 'function Stop-Bridge { }', 'function Stop-BridgeOnPort { return $true }', 'function Write-TextFile([string]$path, [string]$text) { }'] : []),
    // PS 里函数优先于 cmdlet ⇒ 同名函数就把 Move-Item 换掉（注入失败用的就是这个）
    ...(opts.failMove ? ['function Move-Item { param([string]$Path, [string]$Destination, [switch]$Force, [switch]$PassThru, $ErrorAction) throw "注入：Move-Item 失败（目标被占用 / 磁盘满）" }'] : []),
    // harness 的落点：临时目录里那份（真仓库那份永远不参与）
    `$EnvFile = Join-Path '${dir.replace(/'/g, "''")}' '.env'`,
    body,
  ].join('\r\n');
  const file = join(dir, 'harness.ps1');
  // BOM 必须带上：PS 5.1 读无 BOM 的 UTF-8 .ps1 会按 ANSI(本机 GBK) 解码，
  // 中文注释的尾字节会被当成双字节字符的前导字节 —— 它会把紧跟的换行一起吃掉，两行并成一行，
  // 于是 harness 自己的语法都可能坏掉。本闸门要防的就是同一个机制（见 Write-EnvKey 的 -Encoding UTF8）。
  writeFileSync(file, '\uFEFF' + script + '\r\n', 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'harness.ps1'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  return resultOf(dir, r);
}

/* ------------------------------------------------------------------ 结构判据（④） */

/**
 * "把失败吞成一条正常路径"的形状 —— 评审 Important 1 要永久拦的那一类。
 * 只看代码行：整行注释里写着 grep/sed 不算实现（同 notebook-env-isolation.test.ts 的判据①）。
 */
function silentSwallowPatterns(body: string, what: string): string[] {
  const hits: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/\bgrep\b.*["']\^?\$\{?key\b/.test(line)) hits.push(`${what}: 键名被当**正则**喂给 grep（未闭合字符类 ⇒ exit 2；里面的 . 是通配 ⇒ 静默删掉别人的键）：${line}`);
    if (/\bsed\b.*["']s?\/\^?\$\{?key/.test(line)) hits.push(`${what}: 键名被当**正则**喂给 sed：${line}`);
    if (/\|\|\s*:\s*>/.test(line)) hits.push(`${what}: 失败被 "|| : >…" 吞成"把临时文件截空" ⇒ 报错那次 .env 只剩新键那一行，而 rc=0：${line}`);
    if (/>\s*"\$\{?(ENV_FILE|EnvFile)\}?"/.test(line)) hits.push(`${what}: 直接重定向进 .env 本体 ⇒ 一边读一边把原文件截断（旧写法的截断窗口）：${line}`);
    if (/\b(grep|awk)\b.*2>\s*\/dev\/null.*\|\|/.test(line)) hits.push(`${what}: stderr 被丢掉又用 || 兜底 ⇒ 分不清"没匹配上"与"真报错"：${line}`);
  }
  return hits;
}

/** 旧实现的原文（`git show a69ea53:start.sh`），逐字抄来当常驻反例：判据必须认得这三种形状。 */
const OLD_GREP_LINE = '  grep -v "^${key}=" "$ENV_FILE" >"$tmp" 2>/dev/null || : >"$tmp"';
const OLD_SED_LINE = '  sed -i "s/^${key}=.*/${key}=${val}/" "$ENV_FILE"';
const OLD_TRUNCATE_LINE = '  grep -v "^KEY=x" "$ENV_FILE" >"$ENV_FILE"';

/** 这台机器的文件系统到不到位 chmod 的 mode（Git Bash/NTFS 上不到位：实测 chmod 600 后 stat 仍报 644）。 */
function fsHonorsChmod(dir: string): boolean {
  const f = join(dir, 'mode-probe');
  writeFileSync(f, 'x\n', 'utf8');
  spawnSync('chmod', ['600', f], { shell: false });
  try {
    return (statSync(f).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

const honorsChmod = hasBash && fsHonorsChmod(newDir('chmod-probe'));

/* ------------------------------------------------------------------ 用例 */

describe('闸门真的在守东西（空转防护 + 结构判据）', () => {
  it('start.sh 那几个函数都抠到了，且不是空壳', () => {
    for (const [name, text] of [
      ['read_env_key', SH_READ],
      ['write_env_key', SH_WRITE],
      ['read_env_token', SH_READ_TOKEN],
      ['write_env_token', SH_WRITE_TOKEN],
      ['read_env_jupyter_token', SH_READ_JUPYTER],
      ['write_env_jupyter_token', SH_WRITE_JUPYTER],
      ['start_bridge', SH_BRIDGE],
    ] as const) {
      expect(text.length, `start.sh 的 ${name} 只抠到 ${text.length} 字节 ⇒ 抠取逻辑对不上现在的写法`).toBeGreaterThan(30);
      expect(text.split('\n')[0], `${name} 的第一行必须是它自己的定义`).toMatch(new RegExp(`^${name}\\(\\)\\s*\\{`));
    }
    // start_bridge 依赖这四个 wrapper：少抽一个就会得到"command not found ⇒ 读回空 ⇒ 又生成一份 token"
    // 这种与判题无关的假绿（第一版就是这么红的，顺手把它钉成判据）
    for (const dep of ['read_env_token', 'write_env_token', 'read_env_jupyter_token', 'write_env_jupyter_token']) {
      expect(SH_BRIDGE, `start_bridge 不再调用 ${dep} ⇒ 本闸门的 harness 要同步`).toContain(dep);
    }
    // 判据的落点必须在 ENV_FILE 上，而不是写死的仓库路径
    expect(SH_WRITE).toContain('"$ENV_FILE"');
    expect(shGlobals, 'start.sh 里 ENV_FILE 的赋值形状变了 ⇒ 检查 harness 的临时目录接管还成立吗').toContain('ENV_FILE=".env"');
  });

  it('start.ps1 的对等实现同样抠到了（两份实现一套判据）', () => {
    for (const [name, text] of [
      ['Read-EnvKey', PS_READ],
      ['Write-EnvKey', PS_WRITE],
      ['Read-EnvToken', PS_READ_TOKEN],
      ['Write-EnvToken', PS_WRITE_TOKEN],
      ['Read-EnvJupyterToken', PS_READ_JUPYTER],
      ['Write-EnvJupyterToken', PS_WRITE_JUPYTER],
      ['Start-Bridge', PS_BRIDGE],
    ] as const) {
      expect(text.length, `start.ps1 的 function ${name} 只抠到 ${text.length} 字节`).toBeGreaterThan(30);
      expect(text.split('\n')[0], `${name} 的第一行必须是它自己的定义`).toMatch(new RegExp(`^function\\s+${name}\\b`));
    }
    expect(PS_WRITE).toContain('$EnvFile');
    expect(PS_WRITE).toContain('Move-Item');
    expect(PS_READ).toContain('Select-String');
    expect(PS_BRIDGE).toContain('Write-EnvToken');
    expect(PS_BRIDGE).toContain('Write-EnvJupyterToken');
  });

  it('结构判据认得旧实现（把旧代码的形状喂给它必须红，否则这条闸门是空的）', () => {
    expect(silentSwallowPatterns(OLD_GREP_LINE, '旧 grep 写法').length, '旧那行 grep -v … || : >"$tmp" 没被判据认出来 ⇒ 那一类故障又没人守了').toBeGreaterThanOrEqual(3);
    expect(silentSwallowPatterns(OLD_SED_LINE, '旧 sed 写法').length).toBeGreaterThanOrEqual(1);
    expect(silentSwallowPatterns(OLD_TRUNCATE_LINE, '直接截断原文件').length).toBeGreaterThanOrEqual(1);
    // 反向锚：现在这份正确实现不许被判据误伤
    expect(silentSwallowPatterns(SH_WRITE, '当前 write_env_key')).toEqual([]);
  });

  it('两个实现至少有一个真的在跑（都不在就是闸门空转）', () => {
    const mode = hasBash && hasPs ? 'both' : hasBash ? 'sh-only' : hasPs ? 'ps-only' : 'none';
    expect(mode, '这台机器既没有 bash 也没有 powershell.exe ⇒ 下面整片行为判据一条都没跑（不许当"跳过"混过去）').not.toBe('none');
  });
});

describe.skipIf(!hasBash)('bash 侧行为：write_env_key / start_bridge（start.sh 的本体）', () => {
  const BAD_KEYS = ['ARENA_[oops=', 'ARENA.TOK', 'ARENA TOK', '1LEADING', 'BAD-KEY', 'ARENA$X', '"];drop'];

  it('非法/带正则元字符的键名 ⇒ 非零返回码，且 .env 逐字节没动、不留 tmp', () => {
    for (const key of BAD_KEYS) {
      const r = runSh(`write_env_key ${q(key)} 'fresh-token'`);
      expect(r.rc, `键名 '${key}' 居然改写成功了（期望被入口键名闸门拒绝）`).not.toBe(0);
      const after = r.bytes() as Buffer;
      expect(sha(after), `键名 '${key}' 这次失败前后 .env 字节不同 ⇒ 原文件被动过`).toBe(sha(SEED_BYTES));
      expect(r.text(), `键名 '${key}' 的新值写进去了`).not.toContain('fresh-token');
      expect(r.tmps(), `失败之后还留着 ${r.tmps().join(', ')} ⇒ 带 token 的中间文件不该出现在这条路径上`).toEqual([]);
    }
  });

  it('空键名也拒绝（${1:?} 那条入口形状）', () => {
    const r = runSh('write_env_key "" "v"');
    expect(r.rc).not.toBe(0);
    expect(sha(r.bytes() as Buffer)).toBe(sha(SEED_BYTES));
  });

  it('追加：别的键与中文注释原样保留、不引入 CR/BOM、读回来就是写进去的值', () => {
    const r = runSh("write_env_key ARENA_NEW 'abc123'\nprintf 'READBACK=%s\\n' \"$(read_env_key ARENA_NEW)\"");
    expect(r.rc, `write_env_key 返回 ${r.rc}：${r.err}`).toBe(0);
    const lines = r.text().split('\n');
    for (const keep of [
      '# arena token source of truth (do not commit)',
      'OTHER_KEY=keep-me',
      '# 中文注释：桥 token 与 notebook token 都只写在这里',
      'ARENA_PORT=7788',
    ]) {
      expect(lines, `丢了这一行：${keep}`).toContain(keep);
    }
    expect(lines.filter((l) => l.startsWith('ARENA_NEW=')).length).toBe(1);
    expect(r.out, '读完对不上 ⇒ "整份重写成功"这句话是假的').toContain('READBACK=abc123');
    const bytes = r.bytes() as Buffer;
    expect(bytes.includes(0x0d), '.env 里出现了 CR 字节').toBe(false);
    expect(bytes.subarray(0, 3).toString('hex'), '.env 被加了 BOM').not.toBe('efbbbf');
    expect(r.tmps(), '成功之后不该留 tmp').toEqual([]);
  });

  it('覆写同名键：只剩一行、值换成新的、别的键不受牵连', () => {
    const r = runSh("write_env_key ARENA_PORT '7799'\nprintf 'READBACK=%s\\n' \"$(read_env_key ARENA_PORT)\"");
    expect(r.rc).toBe(0);
    const lines = r.text().split('\n');
    expect(lines.filter((l) => l.startsWith('ARENA_PORT=')).length).toBe(1);
    expect(lines).toContain('ARENA_PORT=7799');
    expect(lines).toContain('OTHER_KEY=keep-me');
    expect(r.out).toContain('READBACK=7799');
  });

  it('连写四次同名键：还是只剩一行，值是最后一次', () => {
    const r = runSh("write_env_key ARENA_R 'r1'\nwrite_env_key ARENA_R 'r2'\nwrite_env_key ARENA_R 'r3'\nwrite_env_key ARENA_R 'r4'");
    expect(r.rc).toBe(0);
    const lines = r.text().split('\n');
    expect(lines.filter((l) => l.startsWith('ARENA_R=')).length).toBe(1);
    expect(lines).toContain('ARENA_R=r4');
    expect(r.tmps()).toEqual([]);
  });

  it('值里的正则/sed/分隔符元字符逐个存活（比对的是"落进 .env 的那一整行"与字面量 KEY=值）', () => {
    const val = String.raw`A|B&C\D/E+F=G H  I$J*K?L "q"z`;
    const r = runSh(`write_env_key ARENA_META ${q(val)}\nprintf 'READBACK=%s\\n' "$(read_env_key ARENA_META)"`);
    expect(r.rc).toBe(0);
    const line = r.text().split('\n').find((l) => l.startsWith('ARENA_META='));
    expect(line, '.env 里没有 ARENA_META 这一行').toBe(`ARENA_META=${val}`);
    expect(r.out).toContain(`READBACK=${val}`);
  });

  it('空值是合法的"清空"：那一行还在、读回来是空串', () => {
    const r = runSh("write_env_key ARENA_PORT ''\nprintf 'READBACK=[%s]\\n' \"$(read_env_key ARENA_PORT)\"");
    expect(r.rc, `空值被拒了：${r.err}`).toBe(0);
    expect(r.text().split('\n')).toContain('ARENA_PORT=');
    expect(r.out).toContain('READBACK=[]');
  });

  it('.env 不存在（首启）也能写对，且不产生 BOM/CR', () => {
    const r = runSh("write_env_key ARENA_FIRST 'one'", { seed: null });
    expect(r.rc).toBe(0);
    expect(r.text()).toBe('ARENA_FIRST=one\n');
    const bytes = r.bytes() as Buffer;
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.subarray(0, 3).toString('hex')).not.toBe('efbbbf');
  });

  it('后置条件：值落不进 .env 就必须响亮失败（"写短了但 rc=0"不许成立）', () => {
    // 带换行的值落盘会变成两行，read_env_key 只能读回第一行 ⇒ 正是"短了却成功"的形状
    const r = runSh("write_env_key ARENA_MULTI $'line1\\nline2'");
    expect(r.rc, '值里带换行 ⇒ 读回来对不上，这种"改写成功"必须判红').not.toBe(0);
    expect(r.err).toContain('ARENA_MULTI');
  });

  it('mv 坏在第一次（桥 token）⇒ 调用方（start_bridge）停下，不是只有 helper 返回非零', () => {
    // 故意只让**第一次** mv 失败：第二次（notebook token）是好的，所以"照样往下跑"会留下
    // "桥的键没落地、notebook 的键落了"这种半截状态 —— 用 failMv:'all' 是抓不到第一个
    // `|| return 1` 被拿掉的（第二个会替它把 rc 变红），实测就是这样漏过一次。
    const r = runSh('start_bridge', {
      env: { ARENA_LLM_BRIDGE_TOKEN: 'fresh-token' },
      failMv: 1,
    });
    expect(r.rc, 'mv 都失败了 start_bridge 还返回 0 ⇒ 第一个 `|| return 1` 没了（带着新 token 继续跑 = WI-86 的错配）').not.toBe(0);
    expect(r.err).toContain('.env');
    // 没建 data/ = 它在任何后续动作（compose、起桥）之前就停了
    expect(existsSync(join(r.dir, 'data')), 'start_bridge 在写不进 .env 之后照样往下跑了（建出 data/）').toBe(false);
    expect(sha(r.bytes() as Buffer), '.env 在这次失败的改写里被动过').toBe(sha(SEED_BYTES));
    expect(r.text(), 'fresh-token 落进了 .env（本该失败）').not.toContain('fresh-token');
    expect(r.tmps().length, 'mv 失败时要把新内容留着给人手工合并').toBe(1);
  });

  it('第二个调用点（notebook token）也一样：mv 坏在第二次 ⇒ start_bridge 停下', () => {
    const r = runSh('start_bridge', { env: { ARENA_LLM_BRIDGE_TOKEN: 'fresh-token' }, failMv: 2 });
    expect(r.rc, 'write_env_jupyter_token 的返回值没人接 ⇒ 桥 token 落新值、notebook token 没落地却当成功').not.toBe(0);
    const text = r.text();
    expect(text).toContain('ARENA_LLM_BRIDGE_TOKEN=fresh-token'); // 第一次写成功了
    expect(text, 'Jupyter token 明明没写进去').not.toContain('ARENA_JUPYTER_TOKEN=');
    expect(existsSync(join(r.dir, 'data'))).toBe(false);
  });

  it('成功路径仍然正常：start_bridge 写完返回 0，已存在的 notebook token 不被换掉', () => {
    const r = runSh('start_bridge', {
      seed: `${SEED}ARENA_JUPYTER_TOKEN=existing-jt\n`,
      env: { ARENA_LLM_BRIDGE_TOKEN: 'fresh-token' },
    });
    expect(r.rc, `start_bridge 正常路径返回 ${r.rc}：${r.err}`).toBe(0);
    const lines = r.text().split('\n');
    expect(lines).toContain('ARENA_LLM_BRIDGE_TOKEN=fresh-token');
    expect(lines).toContain('ARENA_JUPYTER_TOKEN=existing-jt'); // 已存在就不换（每次换 token 会让容器与 .env 各拿一份）
    expect(lines.filter((l) => l.startsWith('ARENA_JUPYTER_TOKEN=')).length).toBe(1);
    expect(r.tmps()).toEqual([]);
    expect((r.bytes() as Buffer).includes(0x0d), '出现 CR').toBe(false);
  });

  /**
   * 权限那句判据的地基（永远跑）：mv 用的是 tmp 的 mode，不抄就把手加固过的 0600 降回 0644
   * —— 而 .env 里是桥 token 与那个 `--allow-root` 的 Jupyter token。
   */
  it('write_env_key 里有给 tmp 设权限的那句（行为判据能不能跑都依赖它还在）', () => {
    // 两个分支都要在：有原文件 ⇒ 照抄它的 mode（不然手工加固被降回 umask 默认）；
    // 首启没有原文件可抄 ⇒ 按最严的 0600 建。少任何一个分支都是"某条路径上把 token 文件的权限放宽"。
    const carries = /chmod\b[^\n]*--reference="\$\{?ENV_FILE\}?"/.test(SH_WRITE);
    const creates = /chmod\s+600\s+"\$tmp"/.test(SH_WRITE);
    expect(
      [carries && '有原文件：抄它的 mode', creates && '首启：0600'].filter(Boolean),
      'start.sh 的 write_env_key 里少了给 tmp 设权限的那句 ⇒ mv 落的是 tmp 的 umask 默认 mode（通常 0644），' +
        '会把手工加固过的 0600 .env 静默降回 0644（.env 里是桥 token 与 --allow-root 的 Jupyter token）',
    ).toEqual(['有原文件：抄它的 mode', '首启：0600']);
    if (!honorsChmod) {
      // 这一句是"为什么会看到 1 skipped"的常驻解释（同 publish-identity.test.ts 的形状）：
      // 宿主是 Git Bash/NTFS，chmod 不改变 stat 报的 mode（实测 chmod 600 之后仍报 644），
      // 所以下面那条行为判据只能到真 Linux 文件系统（容器档）上跑。
      expect(honorsChmod, '本条 skipped 的理由：这台机器的文件系统不记录 chmod 的 mode').toBe(false);
    }
  });

  it.skipIf(!honorsChmod)('（能记 mode 的文件系统上）改写不会把 .env 的 0600 降回默认', () => {
    const r = runSh("chmod 600 \"$ENV_FILE\"\nwrite_env_key ARENA_P 'v'");
    expect(r.rc).toBe(0);
    expect((statSync(join(r.dir, '.env')).mode & 0o777).toString(8), '改写把 .env 的权限降回默认了').toBe('600');
  });
});

describe.skipIf(!hasPs)('powershell 侧行为：Write-EnvKey / Start-Bridge（start.ps1 的本体）', () => {
  it('非法键名 ⇒ 抛错、调用方停下、原文件一字节没动、不留 tmp', () => {
    for (const key of ['ARENA_[oops', 'ARENA.TOK', 'BAD-KEY', '1LEADING']) {
      const r = runPs(`Write-EnvKey '${key}' 'fresh-token'\nWrite-Host 'MARKER-AFTER'`);
      expect(r.rc, `键名 '${key}' 居然写成功了（期望键名闸门拒绝）`).not.toBe(0);
      expect(r.out, '调用方没停下：MARKER 居然打印了').not.toContain('MARKER-AFTER');
      expect(sha(r.bytes() as Buffer)).toBe(sha(SEED_BYTES));
      expect(r.tmps()).toEqual([]);
    }
  });

  it('追加/覆写：别的键与中文注释原样保留（写侧的 Get-Content 必须显式 -Encoding UTF8）、不引入 CR/BOM、读回同值', () => {
    const r = runPs(
      [
        'Write-EnvKey "ARENA_NEW" "abc123"',
        'Write-Host ("LINES=" + @(Get-Content $EnvFile -Encoding UTF8).Count)',
        'Write-Host ("READBACK=" + (Read-EnvKey "ARENA_NEW"))',
        'Write-EnvKey "ARENA_PORT" "7799"',
        '$p = @(Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_.StartsWith("ARENA_PORT=") })',
        'Write-Host ("PORTLINES=" + $p.Count)',
        'Write-Host ("READPORT=" + (Read-EnvKey "ARENA_PORT"))',
      ].join('\r\n'),
    );
    expect(r.rc, `Write-EnvKey 抛了：${r.err}`).toBe(0);
    const text = r.text();
    for (const keep of [
      '# arena token source of truth (do not commit)',
      'OTHER_KEY=keep-me',
      '# 中文注释：桥 token 与 notebook token 都只写在这里',
    ]) {
      expect(text.split(/\r?\n/), `丢了这一行：${keep}（PS 5.1 不带 -Encoding 时按 ANSI 读：UTF-8 的尾字节被当 GBK 双字节字符的前导字节，` +
        '把紧跟的那个 0x0A 一起吃掉 ⇒ 相邻两行合并、那行键从 .env 里消失，整段中文也变成再编码后的错字节）').toContain(keep);
    }
    expect(r.out).toContain('LINES=5');
    expect(r.out).toContain('READBACK=abc123');
    expect(r.out, '同名键没被压成一行').toContain('PORTLINES=1');
    expect(r.out, '覆写后的值读不回来').toContain('READPORT=7799');
    expect(text).toContain('ARENA_PORT=7799');
    const bytes = r.bytes() as Buffer;
    expect(bytes.includes(0x0d), '.env 里出现 CR').toBe(false);
    expect(bytes.subarray(0, 3).toString('hex'), '.env 被加了 BOM（compose 读第一行会多个隐形字符）').not.toBe('efbbbf');
  });

  it('后置条件（ps1 与 sh 同判据）：值落不进 .env 就必须抛，不许"短了但成功"', () => {
    const r = runPs(
      [
        "$v = [string]::Join([char]10, @('line1', 'line2'))",
        'Write-EnvKey "ARENA_MULTI" $v',
        "Write-Host 'MARKER-AFTER'",
      ].join('\r\n'),
    );
    expect(r.rc, '值里带换行 ⇒ 读回来对不上，这种"改写成功"必须判红').not.toBe(0);
    expect(r.out, '异常没穿出调用方').not.toContain('MARKER-AFTER');
  });

  it('Move-Item 失败 ⇒ 异常穿出真的 Start-Bridge（调用方被迫停下）', () => {
    const r = runPs('Start-Bridge\nWrite-Host \'MARKER-AFTER-CALLER\'', {
      env: { ARENA_LLM_BRIDGE_TOKEN: 'fresh-token' },
      failMove: true,
      bridge: true,
    });
    expect(r.rc).not.toBe(0);
    expect(r.out, '异常没穿出 Start-Bridge ⇒ 调用方会带着"进程环境新值、.env 旧值"继续跑').not.toContain('MARKER-AFTER-CALLER');
    expect(existsSync(join(r.dir, 'data')), 'Start-Bridge 在写不进 .env 之后照样往下跑了（建出 data/）').toBe(false);
    expect(sha(r.bytes() as Buffer), '.env 被动过').toBe(sha(SEED_BYTES));
    expect(r.text()).not.toContain('fresh-token');
  });

  it('加固过的 .env 改写之后 ACL 一模一样（Move-Item 搬的是 tmp 那份继承默认）', () => {
    const r = runPs(
      [
        '$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
        '$acl = Get-Acl $EnvFile',
        '[void]$acl.SetAccessRuleProtection($true, $false)',
        'foreach ($ace in @($acl.Access)) { [void]$acl.RemoveAccessRule($ace) }',
        '[void]$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, "Modify", "Allow")))',
        'Set-Acl -Path $EnvFile -AclObject $acl',
        'Write-Host ("HARDEN=" + @((Get-Acl $EnvFile).Access).Count)',
        '$before = (Get-Acl $EnvFile).Sddl',
        'Write-EnvKey "ARENA_ACL" "v"',
        'Write-Host ("AFTER=" + (Get-Acl $EnvFile).Sddl)',
        'Write-Host ("BEFORE=" + $before)',
      ].join('\r\n'),
    );
    expect(r.rc, `harness 自己出错了：${r.err}`).toBe(0);
    expect(r.out, '加固没做成 ⇒ 这条判据在空转（这个卷不支持 Set-Acl？').toContain('HARDEN=1');
    const before = /BEFORE=(\S+)/.exec(r.out)?.[1] ?? '';
    const after = /AFTER=(\S+)/.exec(r.out)?.[1] ?? '';
    expect(before.length, '取不到加固后的 SDDL ⇒ 判据空转').toBeGreaterThan(10);
    // .env 里是桥 token 与 notebook 的 Jupyter token，而那个 Jupyter 是 --allow-root 起的：
    // 不抄 ACL 的话改写会把"只允许当前用户"降回目录继承来的 SY/BA FullControl
    expect(after, '改写把 .env 的 ACL 换成了 tmp 那份（继承默认）⇒ 人手加固被静默抹掉').toBe(before);
  });

  it('成功路径：Start-Bridge 正常写完桥 token、不动已有的 notebook token 并返回', () => {
    const r = runPs('Start-Bridge\nWrite-Host ("JT=" + (Read-EnvJupyterToken))', {
      seed: `${SEED}ARENA_JUPYTER_TOKEN=existing-jt\n`,
      env: { ARENA_LLM_BRIDGE_TOKEN: 'fresh-token' },
      bridge: true,
    });
    expect(r.rc, `正常路径返回 ${r.rc}：${r.err}`).toBe(0);
    expect(r.text()).toContain('ARENA_LLM_BRIDGE_TOKEN=fresh-token');
    expect(r.out).toContain('JT=existing-jt');
    expect(r.tmps()).toEqual([]);
  });
});
