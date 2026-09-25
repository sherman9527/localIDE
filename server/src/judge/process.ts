import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
  /** 每行 stdout/stderr 回调，用于 SSE 进度推送 */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  maxOutputChars?: number;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * 判题进程统一出口：超时必杀（SIGKILL 兜底），输出限量累积，避免把几 MB 日志灌进响应。
 */
export function runProcess(command: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const maxChars = opts.maxOutputChars ?? 64_000;
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      windowsHide: true,
      // 让子进程自成一组的组长，超时才能连它 fork 出来的孙子一起杀（仅 linux；Windows 没有进程组）
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (target === 'stdout') {
        if (stdout.length < maxChars) stdout += chunk;
      } else if (stderr.length < maxChars) {
        stderr += chunk;
      }
      if (opts.onLine) {
        for (const line of chunk.split('\n')) {
          if (line.trim()) opts.onLine(line, target);
        }
      }
    };

    child.stdout.on('data', (buf: Buffer) => append('stdout', buf.toString('utf8')));
    child.stderr.on('data', (buf: Buffer) => append('stderr', buf.toString('utf8')));

    const killer = setTimeout(() => {
      timedOut = true;
      // 杀进程组而不是只杀直接子进程：javac/java 会再 fork，只杀父进程会留下一堆跑满 CPU 的孤儿
      const signal = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          child.kill(sig);
        }
      };
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 2_000).unref();
    }, opts.timeoutMs);
    killer.unref();

    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    child.on('error', (err) => {
      append('stderr', String((err as Error).message ?? err));
      finish(-1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/**
 * 杀掉一个子进程**及其进程组**。
 *
 * 单独 `child.kill()` 只杀得到直接子进程：jshell / jdb / python 都会另起一个干活的孩子，
 * 留下它就是"服务停了还挂着一台 JVM"。所以启动时要 `detached: true`（Linux/macOS）拿到自己的
 * 进程组，这里才能按组收。Windows 没有这套语义，只能退化成杀单个进程。
 */
export function killProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean }): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经不在了 */
    }
  }
}

