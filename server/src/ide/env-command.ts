import { join } from 'node:path';
import type { IdeEnvCommandWindow } from '@arena/shared';
import { config } from '../config.js';
import { runProcess } from '../judge/process.js';
import {
  IDE_ENV_ROOT,
  ensureIdeEnv,
  envFamilyOf,
  envUnsupportedReason,
  familyDir,
  venvPythonPath,
  type IdeEnvFamily,
} from './env.js';
import type { IdeLanguage } from './languages.js';

/**
 * IDE 的"命令窗口"：让用户自己装依赖。
 *
 * 核心约束是**它不是 shell**。全仓库的进程纪律是 `shell:false` + argv 数组，
 * 一旦这里写成 `sh -c <用户输入>`，"没有任何用户输入进得去"那句审计结论就作废了。
 * 所以：程序名与子命令走枚举，其余参数原样进 argv。用户照样写 `pip3 install requests==2.31`，
 * 但 `;` `|` `$()` 在这里只是字符。
 *
 * 第二条约束是**装到哪里**：`pip3` 必须被改写成"venv 自己的 python -m pip"。
 * 直接跑系统 `pip3` 会把包写进系统 site-packages —— 而判题用的就是那个解释器，
 * 等于从后门把 IDE 环境漏进判题（红线一）。
 */

export interface EnvCommandOk {
  ok: true;
  command: string;
  args: string[];
  /** 给人看的最终命令行（含服务端注入的部分），界面回显用 */
  label: string;
}
export interface EnvCommandReject {
  ok: false;
  reason: string;
}
export type EnvCommandParse = EnvCommandOk | EnvCommandReject;

/** 装包比跑代码慢得多，不能沿用运行的 10s；但也不能无限等。 */
export const IDE_ENV_COMMAND_TIMEOUT_MS = 180_000;

const PYTHON_PROGRAMS = new Set(['pip', 'pip3', 'python', 'python3']);
const PYTHON_SUBCOMMANDS = new Set(['install', 'uninstall', 'list', 'freeze', 'show']);
/** 会把包装到别处去的参数 —— 一旦允许，"环境只存在于 ide-env"这句话就不成立了 */
const PYTHON_ESCAPE_FLAGS = ['--target', '--prefix', '-t', '--root', '--editable', '-e'];

const NODE_PROGRAMS = new Set(['npm']);
const NODE_SUBCOMMANDS = new Set(['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'ls', 'list']);
const NODE_ESCAPE_FLAGS = ['--global', '-g', '--prefix', '-C', '--no-package-lock'];

/** 数组下标在 `noUncheckedIndexedAccess` 下是 `string | undefined`，所以到处都要显式收口。 */
function flagName(arg: string): string {
  return arg.split('=')[0] ?? arg;
}

function normalizePython(argv: string[]): { sub: string; rest: string[] } | string {
  const [program, ...tail] = argv;
  if (!program || !PYTHON_PROGRAMS.has(program)) return `程序 ${program ?? '(空)'} 不在白名单里（这里只许 pip/pip3/python/python3）`;
  let sub: string | undefined;
  let rest: string[];
  if (program === 'python' || program === 'python3') {
    if (tail[0] !== '-m' || tail[1] !== 'pip') return 'python 只许 `-m pip …` 这种写法';
    sub = tail[2];
    rest = tail.slice(3);
  } else {
    sub = tail[0];
    rest = tail.slice(1);
  }
  if (!sub || !PYTHON_SUBCOMMANDS.has(sub)) {
    return `子命令 ${sub ?? '(空)'} 不在白名单里（只许 ${[...PYTHON_SUBCOMMANDS].join(' / ')}）`;
  }
  const escaped = rest.filter((a) => PYTHON_ESCAPE_FLAGS.includes(flagName(a)));
  if (escaped.length) return `不允许改变安装位置的参数：${escaped.join(' ')}（环境只在 IDE 里，装到别处会影响判题）`;
  if (sub === 'install' && !rest.some((a) => !a.startsWith('-'))) return 'install 至少要给一个包名或本地路径';
  return { sub, rest };
}

function normalizeNode(argv: string[], nodeRoot: string): { sub: string; rest: string[] } | string {
  const [program, ...tail] = argv;
  if (!program || !NODE_PROGRAMS.has(program)) return `程序 ${program ?? '(空)'} 不在白名单里（这里只许 npm）`;
  const sub = tail[0];
  const rest = tail.slice(1);
  if (!sub || !NODE_SUBCOMMANDS.has(sub)) {
    return `子命令 ${sub ?? '(空)'} 不在白名单里（只许 ${[...NODE_SUBCOMMANDS].join(' / ')}）`;
  }
  const escaped = rest.filter((a) => NODE_ESCAPE_FLAGS.includes(flagName(a)));
  if (escaped.length) {
    return `不允许全局或换目录安装：${escaped.join(' ')}（--prefix 由服务端注入到 IDE 环境里，写它等于越权）`;
  }
  return { sub, rest: [...rest, '--prefix', nodeRoot] };
}

/**
 * 命令窗口开不开 —— 一处判据，面板与 `parseEnvCommand` 共用（两边说不一样的话就是 bug）。
 * 关着的两类不许并成一句"不支持"：java/scala **有**环境（jar 丢进 lib 这条路是通的），
 * 只是没有一条能把传递依赖解析对的 install 命令 —— 所以要说清"该怎么做"，而不是只说不行。
 */
export function commandWindowFor(language: IdeLanguage, root: string = IDE_ENV_ROOT): IdeEnvCommandWindow {
  const family = envFamilyOf(language);
  if (family === 'python') return { open: true, example: 'pip3 install requests' };
  if (family === 'node') return { open: true, example: 'npm install left-pad' };
  if (!family) return { open: false, reason: envUnsupportedReason(language) };
  return {
    open: false,
    reason:
      `${language.label} 的依赖是 jar 文件：放进 ${join(familyDir(root, family), 'lib')} 就会进 classpath。` +
      '不开命令窗口是因为传递依赖要一起解析成 classpath，一条 install 装不对。',
  };
}

export function parseEnvCommand(language: IdeLanguage, argv: readonly string[]): EnvCommandParse {
  const cleaned = [...argv].map((a) => String(a)).filter((a) => a.trim() !== '');
  if (cleaned.length === 0) return { ok: false, reason: '命令是空的' };

  const family = envFamilyOf(language);
  const window = commandWindowFor(language);
  if (!window.open) return { ok: false, reason: window.reason };

  if (family === 'python') {
    const norm = normalizePython(cleaned);
    if (typeof norm === 'string') return { ok: false, reason: norm };
    const command = venvPythonPath(IDE_ENV_ROOT);
    const args = ['-m', 'pip', norm.sub, ...norm.rest];
    return { ok: true, command, args, label: `${command} ${args.join(' ')}` };
  }

  const nodeRoot = join(IDE_ENV_ROOT, 'node');
  const norm = normalizeNode(cleaned, nodeRoot);
  if (typeof norm === 'string') return { ok: false, reason: norm };
  const args = [norm.sub, ...norm.rest];
  return { ok: true, command: 'npm', args, label: `npm ${args.join(' ')}` };
}

export interface EnvCommandOutcome {
  status: 'ok' | 'failed' | 'rejected' | 'busy' | 'timeout';
  output: string;
  code: number | null;
}

/**
 * 同一族同时只许一个安装。两个 pip 并发写同一个 site-packages 会留下"装了一半"的目录，
 * 那种环境 import 得到模块但内容不对 —— 比直接失败难查得多。
 */
const running = new Map<IdeEnvFamily, Promise<EnvCommandOutcome>>();

export function envCommandBusy(family: IdeEnvFamily): boolean {
  return running.has(family);
}

export async function runEnvCommand(
  language: IdeLanguage,
  argv: readonly string[],
  onChunk: (chunk: string) => void,
): Promise<EnvCommandOutcome> {
  const parsed = parseEnvCommand(language, argv);
  if (!parsed.ok) {
    onChunk(parsed.reason);
    return { status: 'rejected', output: parsed.reason, code: null };
  }

  const family = envFamilyOf(language)!;
  if (envCommandBusy(family)) {
    const msg = `${language.label} 已有一个安装在跑，等它结束再装下一个（并发写同一个环境会留下装了一半的包）`;
    onChunk(msg);
    return { status: 'busy', output: msg, code: null };
  }

  const task = (async (): Promise<EnvCommandOutcome> => {
    try {
      await ensureIdeEnv(language);
    } catch (err) {
      // 环境建不出来（比如这台机器没有 python）要成为一条**可读的失败**，
      // 而不是让端点抛 500 —— 用户看到的应该是"这门语言的环境准备失败：…"。
      const message = (err as Error).message;
      onChunk(message);
      return { status: 'failed', output: message, code: null };
    }
    onChunk(`$ ${parsed.label}\n`);
    const res = await runProcess(parsed.command, parsed.args, {
      cwd: config.dataDir,
      timeoutMs: IDE_ENV_COMMAND_TIMEOUT_MS,
      maxOutputChars: 200_000,
      // 复用 runProcess 已有的行回调（判题 SSE 用的就是它），不另加一套流式出口
      onLine: (line) => onChunk(`${line}\n`),
    });
    const output = `${res.stdout}${res.stderr}`;
    if (res.timedOut) {
      const msg = `安装超时（上限 ${IDE_ENV_COMMAND_TIMEOUT_MS / 1000}s）\n${output}`;
      onChunk(msg);
      return { status: 'timeout', output: msg, code: res.code };
    }
    const status = res.code === 0 ? 'ok' : 'failed';
    if (status === 'failed') onChunk(`\n退出码 ${res.code}\n`);
    return { status, output, code: res.code };
  })();

  running.set(family, task);
  try {
    return await task;
  } finally {
    running.delete(family);
  }
}
