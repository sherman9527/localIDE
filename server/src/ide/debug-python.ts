import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DebugVar } from '@arena/shared';
import { config } from '../config.js';
import { writeLine, type BackendEvent, type DebugBackend, type DebugHandle, type LaunchResult } from './debug-backend.js';

/**
 * Python 后端（WI-81）：起 `debug_python.py`，双向一行一个 JSON。
 * 协议的第四条规矩（协议独占 stdout/stdin 等）写在驱动脚本里，不在这里重复。
 */
export const PYTHON_DRIVER_FILE = join(config.repoRoot, 'server', 'src', 'ide', 'debug_python.py');

/** 驱动脚本说的那几种话。收成宽松形状：这是子进程的 stdout，不是自家模块的返回值。 */
interface DriverEvent {
  event?: string;
  stream?: string;
  text?: string;
  line?: number;
  func?: string;
  reason?: string;
  locals?: DebugVar[];
  message?: string;
  code?: number;
}

function failureMessage(text: string): string {
  if (text.includes('File "main.py"') && text.includes('SyntaxError')) return '代码有语法错误，程序没跑起来';
  if (text.includes('Traceback') || /Error|Exception/.test(text)) return '程序抛了未捕获的异常';
  return '调试结束';
}

function toBackendEvent(raw: DriverEvent): BackendEvent | null {
  switch (raw.event) {
    case 'output':
      return { type: 'output', text: raw.text ?? '' };
    case 'stopped':
      return {
        type: 'stopped',
        // 驱动不会给 0；真给了就当"没有行号"，别让界面写出"停在第 0 行"
        line: raw.line ? raw.line : undefined,
        func: raw.func,
        reason: raw.reason === 'step' ? 'step' : 'breakpoint',
        // 长度与 truncated 由驱动决定（它才知道 repr 有多长），这里不再二次截断 ——
        // 重切一遍会把 truncated 这个标记丢掉，界面就看不出是"被截断"还是"值本来就这么短"
        locals: raw.locals ?? [],
        message: raw.message,
      };
    case 'exited':
      return { type: 'exited', code: raw.code ?? 0 };
    case 'error': {
      const text = raw.text ?? '';
      return { type: 'error', text, message: raw.message ?? failureMessage(text) };
    }
    default:
      return null;
  }
}

export const pythonBackend: DebugBackend = {
  kind: 'python',
  async launch({ code, breakpoints, emit }): Promise<LaunchResult> {
    if (!existsSync(PYTHON_DRIVER_FILE)) {
      return { ok: false, event: { type: 'error', text: `调试驱动脚本不在预期位置：${PYTHON_DRIVER_FILE}` } };
    }
    const child = spawn('python3', ['-u', PYTHON_DRIVER_FILE], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      // 独立进程组：超时要连用户代码 fork 出来的子进程一起收，别留孤儿
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        let parsed: DriverEvent;
        try {
          parsed = JSON.parse(text) as DriverEvent;
        } catch {
          // 不是 JSON 的行（例如 python 自己的 fatal）也要看得见，否则"界面上什么都没发生"最难查
          emit({ type: 'output', text: `${text}\n` });
          continue;
        }
        const event = toBackendEvent(parsed);
        if (event) emit(event);
        else emit({ type: 'output', text: `${String(parsed.event ?? text)}\n` });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => emit({ type: 'output', text: chunk }));

    const handle: DebugHandle = {
      child: child as ChildProcessWithoutNullStreams,
      send: (action) => {
        writeLine(child.stdin, JSON.stringify({ cmd: 'step', action }), (reason) =>
          emit({ type: 'error', text: `写不进调试进程：${reason}`, message: '调试进程已经不在了' }),
        );
      },
      // 驱动的读命令循环看到 EOF 就自己结束，不需要硬杀
      requestExit: () => {
        if (child.stdin.writable) child.stdin.end();
      },
      dispose: async () => {},
    };
    writeLine(
      child.stdin,
      JSON.stringify({
        cmd: 'run',
        code,
        breakpoints: breakpoints.filter((n) => Number.isInteger(n) && n >= 1),
      }),
      (reason) => emit({ type: 'error', text: `写不进调试进程：${reason}`, message: '调试进程已经不在了' }),
    );
    return { ok: true, handle };
  },
};
