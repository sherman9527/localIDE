import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * 全流程结构化日志（需求：出故障要能 trace、能修）。
 * - 一律写仓库内的 `data/logs/arena-YYYY-MM-DD.log`（rule.md C1）
 * - JSONL：每行一个对象，含 time / level / module / event / traceId
 * - 保留 28 天，超期文件在启动时与每天定时清理
 * - 写日志绝不许把业务打挂：失败只在 stderr 说一句，且串行化写入
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  time: string;
  level: LogLevel;
  module: string;
  event: string;
  traceId?: string;
  msg?: string;
  ms?: number;
  [key: string]: unknown;
}

// 测试进程和容器共用同一个 data/ 目录（bind mount 上跨进程追加不保证原子），
// 混写会把真实日志行打断成半行 —— 测试日志单独一个目录。
export const LOG_DIR = join(config.dataDir, process.env.NODE_ENV === 'test' ? 'test-logs' : 'logs');

/**
 * 保留期必须真的落到一个天数上：`Number('28d')=NaN` 会让 `mtime < NaN` 恒 false，
 * "最多存 28 天"于是悄悄失效；空串又会变成 1 天，把日志提前删光。
 */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 28;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 28;
}

export const RETENTION_DAYS = parseRetentionDays(process.env.ARENA_LOG_RETENTION_DAYS);

let writeChain: Promise<void> = Promise.resolve();
let warnedOnce = false;

export function newTraceId(prefix = 't'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * 一个进程一个文件（`arena-<日期>-p<pid>.log`）。
 * 多个 worker/容器共用同一个目录追加写同一份文件时，跨进程 append 并不保证原子，
 * 实测会把日志行打断成半行（`tail-logs` 里表现为 unparseable）—— 分文件从根上避免。
 */
export function logFileFor(day = new Date().toISOString().slice(0, 10), pid = process.pid): string {
  return join(LOG_DIR, `arena-${day}-p${pid}.log`);
}

function write(record: LogRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  writeChain = writeChain
    .then(async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(logFileFor(), line, 'utf8');
    })
    .catch((err: Error) => {
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn(`[log] 写日志失败（业务不受影响）：${err.message}`);
      }
    });
}

function emit(level: LogLevel, module: string, event: string, fields: Record<string, unknown> = {}): void {
  if (level === 'debug' && process.env.ARENA_LOG_LEVEL !== 'debug') return;
  const { traceId, msg, ms, ...rest } = fields as { traceId?: string; msg?: string; ms?: number };
  write({ time: new Date().toISOString(), level, module, event, traceId, msg, ms, ...rest });
}

export const logInfo = (module: string, event: string, fields?: Record<string, unknown>) => emit('info', module, event, fields);
export const logWarn = (module: string, event: string, fields?: Record<string, unknown>) => emit('warn', module, event, fields);
export const logError = (module: string, event: string, fields?: Record<string, unknown>) => emit('error', module, event, fields);
export const logDebug = (module: string, event: string, fields?: Record<string, unknown>) => emit('debug', module, event, fields);

/** 统一把 Error 变成可检索的字段（stack 截断，避免一行几 KB）。 */
export function errorFields(err: unknown): { msg: string; stack?: string } {
  const error = err as Error;
  return { msg: error?.message ?? String(err), stack: error?.stack ? error.stack.split('\n').slice(0, 6).join(' | ') : undefined };
}

/** 等所有已排队的写入落盘（测试与优雅退出用）。 */
export async function flushLogs(): Promise<void> {
  await writeChain;
}

/**
 * 删除超过 RETENTION_DAYS 的日志文件。返回被删掉的文件名。
 * 按文件 mtime 判断，且只认 arena-*.log —— 不碰目录里的其他东西。
 */
export async function purgeOldLogs(now = new Date()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    return [];
  }
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  const removed: string[] = [];
  for (const name of entries) {
    if (!name.startsWith('arena-') || !name.endsWith('.log')) continue;
    const full = join(LOG_DIR, name);
    const info = await stat(full).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await unlink(full).catch(() => undefined);
      removed.push(name);
    }
  }
  return removed;
}

let timer: NodeJS.Timeout | undefined;

/** 启动时清一次，之后每天清一次（unref，不阻止进程退出）。 */
export function startLogMaintenance(): void {
  void purgeOldLogs().then((removed) => {
    // "跑了但没删"也要可证，否则清理逻辑坏掉与今天确实没到期文件在日志里长得一样
    logInfo('log', 'retention.check', { removed, retentionDays: RETENTION_DAYS });
  });
  timer = setInterval(() => void purgeOldLogs(), 86_400_000);
  timer.unref?.();
}

export function stopLogMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
