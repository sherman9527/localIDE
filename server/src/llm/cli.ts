import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { truncateLog } from '@arena/shared';
import { llmSettings } from './settings.js';

/**
 * 本机 CLI provider 的公共引擎：args 模板渲染 + 空临时目录 + 超时杀进程 + 非零退出抛错。
 * 抛错即视为该 provider 失败，由 rubric.ts 降级到下一档。
 */

export const PROMPT_PLACEHOLDER = '%PROMPT%';

export type CliProviderKind = 'qodercli' | 'copilot';

export interface CliSpec {
  kind: CliProviderKind;
  bin: string;
  argsTemplate: readonly string[];
  timeoutMs: number;
}

export interface CliResult {
  text: string;
  model?: string;
  durationMs: number;
}

/** 报错文案里要给用户的"改哪里"指针——出问题时的第一份文档就是这里。 */
const HINTS: Record<CliProviderKind, { bin: string; args: string; timeout: string }> = {
  qodercli: { bin: 'ARENA_QODER_BIN / config.llm.qoderBin', args: 'ARENA_QODER_ARGS / config.llm.qoderArgs', timeout: 'ARENA_LLM_TIMEOUT_MS' },
  copilot: { bin: 'ARENA_COPILOT_BIN / config.llm.copilotBin', args: 'ARENA_COPILOT_ARGS / config.llm.copilotArgs', timeout: 'ARENA_LLM_TIMEOUT_MS' },
};

/** `%PROMPT%` 只替换成**一个 argv 元素**；模板里没写占位符时追加到末尾（避免静默丢掉候选人答案）。 */
export function renderArgs(template: readonly string[], prompt: string): string[] {
  const out: string[] = [];
  let placed = false;
  for (const token of template) {
    if (token === PROMPT_PLACEHOLDER) {
      out.push(prompt);
      placed = true;
    } else if (typeof token === 'string' && token.includes(PROMPT_PLACEHOLDER)) {
      out.push(token.split(PROMPT_PLACEHOLDER).join(prompt));
      placed = true;
    } else {
      out.push(String(token));
    }
  }
  if (!placed) out.push(prompt);
  return out;
}

/** `--model x` / `-m x` / `--model=x`：CLI 侧唯一能拿到模型名的地方（输出里通常没有）。 */
export function modelFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = /^--?m(odel)?=(.+)$/i.exec(a);
    if (eq && eq[2]) return eq[2];
    if (/^--?m(odel)?$/i.test(a)) {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) return next;
    }
  }
  return undefined;
}

const NATIVE_SUFFIXES = ['.exe', '.com'];
const BATCH_SUFFIXES = ['.cmd', '.bat'];
const IS_WIN = process.platform === 'win32';

/**
 * 不 spawn 就能判断"装了没有"——health check 不想每次都付一次进程启动成本。
 * Windows 上的优先级很重要：
 * 1. 先在全 PATH 里找**原生 exe**（两轮扫描，原生优先于垫片）；
 * 2. 只有 `.cmd/.bat` 垫片时（npm 全局安装的典型形态）也返回它，由 runCli 给出"改配原生 exe"的明确报错。
 *    绝不退化成"把候选人答案拼进 cmd 命令行"——cmd 的引号规则挡不住 `& | >`，那是注入面。
 */
export async function locateBin(bin: string): Promise<string | null> {
  const name = IS_WIN && /\.(exe|com|cmd|bat)$/i.test(bin) ? bin.replace(/\.(exe|com|cmd|bat)$/i, '') : bin;
  const explicitBatch = IS_WIN && /\.(cmd|bat)$/i.test(bin);
  const suffixes = IS_WIN ? (explicitBatch ? [''] : (/\./.test(bin) ? [''] : [...NATIVE_SUFFIXES, ...BATCH_SUFFIXES])) : [''];

  if (bin.includes('/') || bin.includes('\\') || isAbsolute(bin)) {
    for (const suffix of suffixes) if (await isFile(bin + suffix)) return bin + suffix;
    return null;
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const suffix of suffixes) {
    for (const dir of dirs) {
      const candidate = join(dir, name + suffix);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 这个路径能不能在不经过 shell 的前提下直接 spawn。 */
export function isBatchShim(path: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(path);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 空临时目录：模型（哪怕被误配成带工具的 CLI）也碰不到仓库文件（rule.md C1 的目录边界）。 */
export async function createRunDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = join(llmSettings().dataDir, 'llm-tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'run-'));
  return {
    dir,
    cleanup: async () => {
      // 只删自己建的 run-*，base 目录留着复用（避免并发评分互删）
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function runCli(spec: CliSpec, prompt: string): Promise<CliResult> {
  const started = Date.now();
  const args = renderArgs(spec.argsTemplate, prompt);
  const hints = HINTS[spec.kind];
  const resolved = await locateBin(spec.bin);
  if (!resolved) throw new Error(`${spec.kind} 未安装或不在 PATH 上（bin="${spec.bin}"，改配请用 ${hints.bin}）`);
  if (isBatchShim(resolved)) {
    throw new Error(
      `${spec.kind} 解析到 .cmd 垫片（${resolved}）：不经过 cmd 就无法执行它，而经 cmd 就等于把候选人答案拼进命令行（注入面）。` +
        `请把 bin 指向原生 exe（${hints.bin}）`,
    );
  }
  const run = await createRunDir();

  try {
    const { stdout, stderr, code, timedOut } = await spawnCollect({
      file: resolved,
      args,
      cwd: run.dir,
      timeoutMs: spec.timeoutMs,
      kind: spec.kind,
    });
    const durationMs = Date.now() - started;
    if (timedOut) {
      throw new Error(`${spec.kind} 超时 ${spec.timeoutMs}ms 已被杀死（timeout），用 ${hints.timeout} 调超时、用 ${hints.args} 换参数`);
    }
    if (code !== 0) {
      throw new Error(`${spec.kind} 非零退出 exit ${code}：${truncateLog(stderr || stdout, 5, 400)}`);
    }
    const text = stdout.trim();
    if (!text) throw new Error(`${spec.kind} 输出为空（可能未登录或参数已随 CLI 版本失效）`);
    return { text, model: modelFromArgs(args), durationMs };
  } finally {
    await run.cleanup();
  }
}

interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  kind: CliProviderKind;
}

function spawnCollect(opts: SpawnOptions): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // shell:false + argv 数组：prompt 永远只是一个参数，不进 shell 解析（防注入）
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`${opts.kind} 无法启动 ${opts.file}：${(err as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.stdin?.end();

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${opts.kind} 调用失败：${err.message}`));
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: timedOut ? null : code, timedOut });
    });
  });
}
