import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * ⑤ 权限那三支分开设判据，少一支就会退回上一轮的洞（`chmod 600` 那支是 dead code 而 S6 全绿）：
 *    文本里两句在不在（纯文本，不需要 bash ⇒ 放在永远跑的块里）+ **哪一支真的被调用**
 *    （桩掉 chmod 打点，NTFS 上也判得动）+ 落盘 mode 对不对（只在认 chmod 的文件系统上跑，
 *    跳过理由由一条"两个独立口径必须一致"的常驻判据守着）。
 * ⑥ 后置条件的报错只许报**长度**、不许报**值**（值就是 token）—— sh/ps 两侧各一条。
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

/**
 * 用来抓"报错把值印出来"的探针值。它**只允许出现在 .env 文件里**：写进 .env 是本分（那本来就是
 * token 的唯一来源），印进控制台 / 错误记录 / 任何被重定向出去的日志是越界 —— 而 .env 里放的是桥 token
 * 与 `--allow-root` 的 Jupyter token，`start.ps1` 自己的注释就写着"只在本机之间传递，不进日志"。
 */
const SECRET_VALUE = 'SECRETCANTEXISTONLYINTHEFILENOTINTHELOG';

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
  chmodCalls: () => string[];
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
    // 只有开了 observeChmod 的用例才会有这个文件（桩的实现见 runSh）
    chmodCalls: () => (existsSync(join(dir, 'chmod-calls.log')) ? readFileSync(join(dir, 'chmod-calls.log'), 'utf8').split('\n').filter(Boolean) : []),
  };
}

/**
 * 把抠出来的实现装进临时目录跑。
 * `failMv` 是把 `mv` 换成同名 shell 函数（bash 里函数优先于外部命令）注入失败：
 * 'all' = 每次都不让 mv 成功；数字 = 只让第 N 次失败（用来分别命中 start_bridge 里的两个调用点）。
 * `observeChmod` 用同一个机制把 `chmod` 桩成打点函数（原样转发给 command chmod，不改行为）：
 * 于是"**哪一支 chmod 被调用了**"在**不记 mode 的文件系统上也看得见** —— 上一轮的洞正是
 * "两句 chmod 都在文本里、但首启那一支永远跑不到"，只看 mode 的判据在 NTFS 上根本抓不到它。
 */
function runSh(body: string, opts: { seed?: string | null; env?: Record<string, string>; failMv?: 'all' | 'none' | number; observeChmod?: boolean } = {}): Run {
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
    // chmod 桩：实现里那两句都带 `2>/dev/null`，往 stderr 打点会被吞掉（实测踩过）⇒ 记到文件里。
    // 原样转发给 command chmod ⇒ 真实 mode 该改还是改，本桩只负责"哪一支被调用"看得见。
    ...(opts.observeChmod ? ['chmod() { printf \'%s\\n\' "$*" >>chmod-calls.log; command chmod "$@"; }'] : []),
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
    // 强制按 UTF-8 输出：否则 PS 5.1 写重定向 stdout 用的是控制台代码页（本机 gb2312），
    // 下面那些**中文**断言（如"报错里只许报长度"那句要匹配的 `读回 N 个字符`）在这台机器上永远读不到原字。
    // 这是 harness 的观测口径，不改 start.ps1 的行为（实测：加这一行之前 stdout 是 mojibake、之后可正解）。
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
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
  // BOM 必须带上：PS 5.1 读无 BOM 的 UTF-8 .ps1 会按 ANSI(本机 gb2312/CP936) 解码，
  // 中文注释与字符串字面量的字节被重新配对成别的码点（mojibake）⇒ harness 自己的语法都可能坏掉、
  // 里头的中文值也不再是原来那串。写侧的 .env 会被同一种再编码损坏毁掉（见 start.ps1 的 -Encoding UTF8
  // 与下面那条"中文注释原样保留"的判据）。
  // 更正一处旧说法：这里曾经写"尾字节把紧跟的 0x0A 吃掉 ⇒ 两行并一行"，那不是主机制，也只在
  // "该行非 ASCII 字节数为奇数、行尾留下悬空前导字节"时偶然发生（CP936 的前导字节遇到非法 trail 时
  // 会连非法字节一起吃掉并输出 '?'）；本仓库基准文件实测默认读与 -Encoding UTF8 读都是 4 行。
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

/** 口径 A（绝对）：`chmod 600` 之后 `stat` 报的是不是正好 0600。Git Bash/NTFS 上不是（实测仍报 644）。 */
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

/**
 * 口径 B（相对，且换一把工具）：两个文件**分别**显式设成 0644 / 0600，看报出来的 mode 会不会不同。
 * 故意与口径 A 三处都不同 —— 用 node 自己的 `chmodSync`（不依赖 chmod 可执行文件）、判"是否不同"
 * （不依赖 umask 恰好让新建文件是 0644）：
 * ① 整卷 fmask 把所有文件都报成 0600 时 A 说"记"、B 说"不记"；
 * ② 只有"新建文件的初始 mode 本来就不一样"能骗到 B，而那种情况 A 也照样是假的。
 * 两条一致才说明"下面那条 mode 判据被跳过"的理由真的是"这个文件系统不记 mode"。
 */
function fsHonorsChmodByContrast(dir: string): boolean {
  const a = join(dir, 'mode-644');
  const b = join(dir, 'mode-600');
  writeFileSync(a, 'x\n', 'utf8');
  writeFileSync(b, 'x\n', 'utf8');
  chmodSync(a, 0o644);
  chmodSync(b, 0o600);
  try {
    return (statSync(a).mode & 0o777) !== (statSync(b).mode & 0o777);
  } catch {
    return false;
  }
}

const fsRecordsMode = fsHonorsChmod(newDir('chmod-probe'));
const contrastRecordsMode = fsHonorsChmodByContrast(newDir('chmod-contrast'));
/** 实际 mode 那两条行为判据的开关：除了文件系统认不认 chmod，还要有 bash 才谈得上跑 sh 的实现。 */
const honorsChmod = hasBash && fsRecordsMode;

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

  /**
   * 权限那句判据的地基。**上一轮它在 describe.skipIf(!hasBash) 里** ⇒ 没有 bash 的宿主上这条
   * 也会静默不跑，而它是纯文本判据、压根不需要 bash —— 现在提到这个永远跑的块里。
   *
   * 但"两句都在文本里"上一轮被证明**不够**：`chmod 600 "$tmp"` 那一支当时是 dead code
   * （门它的是 `touch "$ENV_FILE"` **之后**的 `[ -f "$ENV_FILE" ]`，而 touch 无条件建文件 ⇒ 恒为真），
   * 文本判据 S6 全绿、行为从来没发生过。所以这里钉的是**形状**：首启那一支必须由"touch 之前算出来的
   * flag"门住。真正"哪一支被调用"由 bash 侧那条桩判据判（NTFS 上也判得动），落盘 mode 由 it.skipIf 那条判。
   */
  it('write_env_key 里给 tmp 设权限的两支都在，且首启那支不是被 touch 之后的 [ -f ] 门住的死代码', () => {
    const carries = /chmod\b[^\n]*--reference="\$\{?ENV_FILE\}?"/.test(SH_WRITE);
    const creates = /chmod\s+600\s+"\$tmp"/.test(SH_WRITE);
    expect(
      [carries && '有原文件：抄它的 mode', creates && '首启：0600'].filter(Boolean),
      'start.sh 的 write_env_key 里少了给 tmp 设权限的那句 ⇒ mv 落的是 tmp 的 umask 默认 mode（通常 0644），' +
        '会把手工加固过的 0600 .env 静默降回 0644（.env 里是桥 token 与 --allow-root 的 Jupyter token）',
    ).toEqual(['有原文件：抄它的 mode', '首启：0600']);

    const touchAt = SH_WRITE.indexOf('touch "$ENV_FILE"');
    expect(touchAt, 'start.sh 的 write_env_key 里找不到 touch "$ENV_FILE" ⇒ 本条判据要跟着实现同步（不许静默空转）').toBeGreaterThanOrEqual(0);
    const flagAt = SH_WRITE.indexOf('firstCreate=1');
    expect(flagAt, '找不到首启判定 firstCreate=1 ⇒ "按 0600 新建"那一支八成又回到 touch 之后的 [ -f "$ENV_FILE" ] 上，而那必然为真 = dead code').toBeGreaterThanOrEqual(0);
    expect(flagAt, '首启判定必须发生在 touch **之前**：touch 之后 [ -f ] 恒为真，用它门 0600 那支就是写一段跑不到的代码').toBeLessThan(touchAt);
    const armAt = SH_WRITE.search(/\n[ \t]*chmod\s+600\s+"\$tmp"/);
    expect(armAt, '找不到 chmod 600 "$tmp" 这条**语句**（注释里提一句不算，实测第一版就被注释里那句"chmod 600 之后仍报 644"骗过）⇒ 本条判据要跟着实现同步').toBeGreaterThanOrEqual(0);
    expect(SH_WRITE.slice(0, armAt), 'chmod 600 那一支的门禁条件里看不到 [ "$firstCreate" = 1 ] ⇒ 它又被 touch 之后的 [ -f "$ENV_FILE" ] 门住了（那一行恒为真 = dead code）').toContain('[ "$firstCreate" = 1 ]');
  });

  it('那条 mode 行为判据"被跳过"的理由必须站得住：两个独立口径要给同一个答案（永远跑）', () => {
    // 上一轮这里写的是 `if (!honorsChmod) expect(honorsChmod).toBe(false)` —— 那是同义反复，
    // 把同一个布尔念一遍，永远不可能红，正是本仓库点名的"装饰品"。
    // 现在比的是**两个不同口径**（口径 A：git bash 的 chmod + "是不是正好 0600"；
    // 口径 B：node 的 chmodSync + "两个文件的 mode 是否不同"），它们谁都可能单独骗人，对不上就是真故障：
    // 要么下面那条 it.skipIf 在空转，要么它跳过的理由根本不是"这个文件系统不记 mode"。
    // （形状照 publish-identity.test.ts:81-84：companion 做的是另一个判断。）
    expect(
      contrastRecordsMode,
      `口径 A（chmod 600 → 是否正好 0600）说"这台机器${fsRecordsMode ? '记' : '不记'} mode"，` +
        `口径 B（644/600 两文件对照）说"${contrastRecordsMode ? '记' : '不记'}" ⇒ 对不上：` +
        '下面那两条看落盘 mode 的判据要么在空转，要么它们 skipIf 的理由是别的故障（不是"文件系统不记 chmod"）——两种都不许当"跳过"混过去',
    ).toBe(fsRecordsMode);
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

  it('后置条件：值落不进 .env 就必须响亮失败（"写短了但 rc=0"不许成立），且只报长度不报值', () => {
    // 带换行的值落盘会变成两行，read_env_key 只能读回第一行 ⇒ 正是"短了却成功"的形状
    const r = runSh(`write_env_key ARENA_MULTI $'line1\\n${SECRET_VALUE}'`);
    expect(r.rc, '值里带换行 ⇒ 读回来对不上，这种"改写成功"必须判红').not.toBe(0);
    expect(r.err).toContain('ARENA_MULTI');
    // 值本身（= token）不许出现在控制台或错误输出里：整个 run 被重定向时那就是"进日志"
    expect(`${r.out}${r.err}`, '读回不一致的报错把值印出来了 ⇒ token 泄进控制台/重定向的日志（只许报长度）').not.toContain(SECRET_VALUE);
    expect(r.err, '长度要留下来：短了 = 值里带换行，长了 = 被别的进程改写过 —— 报长度足够定位，不需要值').toMatch(/读回 \d+ 字节 \/ 期望 \d+ 字节/);
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
   * 上一轮缺的那一条：两句 chmod 都在文本里、S6 全绿，但"首启 ⇒ 0600"那一支从来没跑到过
   * （门它的是 `touch` 之后的 `[ -f "$ENV_FILE" ]`，恒为真）。看**哪一支被调用**就不需要文件系统
   * 认 mode —— 桩掉 chmod 打点即可，所以这条在 NTFS 上也判得动（本机实测它红过）。
   */
  it('首启走的确实是 chmod 600 那一支、有原文件时走 --reference（桩掉 chmod 看调用）', () => {
    const fresh = runSh("write_env_key ARENA_FIRST 'one'", { seed: null, observeChmod: true });
    expect(fresh.rc, `首启改写返回 ${fresh.rc}：${fresh.err}`).toBe(0);
    const freshCalls = fresh.chmodCalls().join(' | ');
    const again = runSh("write_env_key ARENA_SECOND 'two'", { observeChmod: true });
    expect(again.rc, `改写返回 ${again.rc}：${again.err}`).toBe(0);
    const againCalls = again.chmodCalls().join(' | ');
    // 首启：走 0600 那支。上一轮的形态是"两句 chmod 都在文本里、S6 全绿，而这一支从来没被调用过"
    // —— 门它的是 touch 之后的 [ -f ]（恒为真）。看调用而不是看落盘 mode，NTFS 上也判得动。
    expect(freshCalls, '首启时 chmod 一次都没被调用 ⇒ 新 .env 落在 umask 默认（Linux 上 0644），"按 0600 新建"那句是死的').toMatch(/(^| )600 \.env\.tmp\./);
    expect(freshCalls, '首启却去抄"原文件"的 mode ⇒ 又回到 touch 之后 [ -f ] 恒为真那个洞（它抄的是 touch 刚建出来的那份默认 mode）').not.toContain('--reference');
    // 有原文件：抄它的 mode，不替它决定 0600（那会把故意放宽过的 .env 悄悄改严）
    expect(againCalls, '有原文件时应当抄它的 mode（chmod --reference），实际调用是：' + againCalls).toContain('--reference=.env');
    expect(againCalls, '有原文件时也走了 0600 那支 ⇒ firstCreate 的判定写反了').not.toMatch(/(^| )600 \.env\.tmp\./);
  });

  it.skipIf(!honorsChmod)('（能记 mode 的文件系统上）改写不会把 .env 的 0600 降回默认', () => {
    const r = runSh("chmod 600 \"$ENV_FILE\"\nwrite_env_key ARENA_P 'v'");
    expect(r.rc).toBe(0);
    expect((statSync(join(r.dir, '.env')).mode & 0o777).toString(8), '改写把 .env 的权限降回默认了').toBe('600');
  });

  it.skipIf(!honorsChmod)('（能记 mode 的文件系统上）首启新建的 .env 就是 0600', () => {
    // 与上面那条成对：上面判"有原文件 ⇒ 抄"，这条判"没原文件 ⇒ 0600"。
    // 本机（NTFS）跑不了 ⇒ it.skipIf（报告会写 skipped，不静默），跳过理由由上面那条双口径判据守着。
    const r = runSh("write_env_key ARENA_FIRST 'one'", { seed: null });
    expect(r.rc, `首启改写返回 ${r.rc}：${r.err}`).toBe(0);
    expect((statSync(join(r.dir, '.env')).mode & 0o777).toString(8), '首启新建的 .env 不是 0600 ⇒ chmod 600 那一支没跑到（或又被 [ -f ] 门成死代码）').toBe('600');
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
      expect(text.split(/\r?\n/), `丢了这一行：${keep}（机制是**再编码损坏**：PS 5.1 不带 -Encoding 时按本机 ANSI=gb2312/CP936 解码，` +
        'UTF-8 的多字节序列被重新配对成别的码点 —— 实测那一行 13 个汉字（39 字节）默认读进来是 20 个错码点，' +
        '再按 UTF-8 写回去 39 字节变 48 字节，那行中文就永久坏掉了。行切分在这儿没变（实测默认与 -Encoding UTF8 都是 4 行）：' +
        '上一轮把机制记成"尾字节吞掉紧跟的 0x0A ⇒ 两行并一行"是记错了 —— 合并只在"该行非 ASCII 字节数为奇数、' +
        '行尾留下悬空前导字节"时偶然发生（实测 x=1\\n释\\ny=2 会 2 行 vs 3 行），不是本判据抓的东西）').toContain(keep);
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

  it('后置条件（ps1 与 sh 同判据）：值落不进 .env 就必须抛，不许"短了但成功"，且只报长度不报值', () => {
    const cut = 13; // 把探针值拆成两段字面量：连 harness 源码里都不出现完整的它，错误回显源码行也骗不过下面那条
    const r = runPs(
      [
        `$secret = ('${SECRET_VALUE.slice(0, cut)}' + '${SECRET_VALUE.slice(cut)}')`,
        "$v = [string]::Join([char]10, @('line1', $secret))",
        'Write-EnvKey "ARENA_MULTI" $v',
        "Write-Host 'MARKER-AFTER'",
      ].join('\r\n'),
    );
    expect(r.rc, '值里带换行 ⇒ 读回来对不上，这种"改写成功"必须判红').not.toBe(0);
    expect(r.out, '异常没穿出调用方').not.toContain('MARKER-AFTER');
    // 上一轮这里印的是 '$got' / '$value'：$ErrorActionPreference='Stop' 下那句话同时进控制台与错误记录，
    // 而值就是 token ⇒ 把"只在本机之间传递，不进日志"自己破掉了。
    expect(`${r.out}${r.err}`, '读回不一致的报错把值印出来了 ⇒ token 泄进控制台/错误记录/转录（只许报长度）').not.toContain(SECRET_VALUE);
    expect(r.out, '长度要留下来：短了 = 值里带换行，长了 = 被别的进程改写过 —— 报长度足够定位，不需要值').toMatch(/读回 \d+ 个字符 \/ 期望 \d+ 个字符/);
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
