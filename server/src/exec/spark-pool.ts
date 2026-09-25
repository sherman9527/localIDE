/**
 * 常驻 Spark worker 池（判题与网页 IDE 共用）。
 *
 * 为什么从 `judge/runners/pyspark.ts` 搬出来：IDE 也要跑 PySpark，而**冷启动一个
 * SparkSession 要 3~10s**，再起一个会话等于把镜像里那份 JVM 内存翻倍；共用一个池
 * 就必须共用一套排队规则 —— 于是判题优先级的取舍也摆到台面上（见 spark-queue.ts）。
 *
 * 这里没有走 runProcess：判题进程是**跨请求存活**的（复用后 <1s），而 runProcess 的
 * 语义是"一次性进程、输入写满即关"。约定仍然守住：argv 数组、不经 shell、超时必杀；
 * 且杀完必须换一个新 worker，否则半截请求的残留状态会污染后续请求。
 * 唯一的例外是 `pysparkAvailable()`——那是一次性探测，正好就是 runProcess 的语义。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { runProcess } from '../judge/process.js';
import { sweepStaleDirs } from '../judge/workspace.js';
import { PriorityQueue, type SparkPriority } from './spark-queue.js';

export const WORKER_FILE = join(config.repoRoot, 'server', 'src', 'judge', 'spark_worker.py');
const READY_PREFIX = 'ARENA_READY ';
const RESULT_PREFIX = 'ARENA_RESULT ';
const FATAL_PREFIX = 'ARENA_FATAL ';
/** JVM 运行期暂存（warehouse / shuffle）：留在 data/ 下但在 data/judge 外，保证沙箱清理断言成立。 */
const SCRATCH_DIR = join(config.dataDir, '.spark-worker');
const STDERR_CAP = 32_000;
export const SUPPORTED_ENTRIES = new Set(['function', 'sql', 'script']);

/**
 * PySpark 是否可用（判题与 IDE 共用这一条判据）：worker 脚本在 + `import pyspark` 成功。
 * 探"pyspark 能不能 import"而不是"python3 在不在"——客户端在但库没装，跑起来照样失败。
 */
export async function pysparkAvailable(): Promise<boolean> {
  if (!existsSync(WORKER_FILE)) return false;
  const python = process.env.ARENA_PYTHON ?? 'python3';
  const check = await runProcess(python, ['-c', 'import pyspark'], { timeoutMs: 60_000 });
  return check.code === 0;
}

export interface SparkCasePayload {
  name: string;
  input?: unknown;
  expected?: unknown;
}

export interface SparkRequestPayload {
  entry: string;
  code: string;
  setup: string[];
  orderSensitive: boolean;
  cases: SparkCasePayload[];
  /**
   * 'ide' = 跑一段脚本、回 stdout + 一个表格预览，**没有用例**。
   * 判题请求不带这个字段，行为与之前完全一致（协议是加法，不是改语义）。
   */
  mode?: 'ide';
  rowLimit?: number;
}

export interface SparkCaseOutcome {
  name?: string;
  status?: string;
  expected?: string;
  actual?: string;
  message?: string;
  traceback?: string;
  rowCount?: number;
}

export interface SparkTable {
  columns: string[];
  rows: string[][];
  truncated: boolean;
  totalRows: number;
}

export interface SparkResponse {
  id?: number;
  ok?: boolean;
  cases?: SparkCaseOutcome[];
  error?: { stage?: string; message?: string; traceback?: string };
  elapsedMs?: number;
  sparkVersion?: string;
  /** mode='ide' 才有：进程内收集到的用户 print（判题模式那些被改道到 stderr 了） */
  stdout?: string;
  table?: SparkTable | null;
}

export class SparkTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Spark 判题超时（>${timeoutMs}ms）`);
    this.name = 'SparkTimeoutError';
  }
}

interface Pending {
  resolve: (value: SparkResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

class SparkPool {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readyError: string | null = null;
  private pending = new Map<number, Pending>();
  private queue = new PriorityQueue<SparkResponse>();
  private seq = 0;
  private stderrTail = '';
  private lineSink: ((line: string) => void) | null = null;

  get stderr(): string {
    return this.stderrTail;
  }

  /**
   * 串行队列：同一时刻只有一个请求在飞（共用一个 JVM 的 stdout，两个请求并发必然互相读走）。
   * `priority` 只影响"还没开始的谁先走"：判题 > IDE，且不抢占正在跑的那个。
   */
  request(
    payload: SparkRequestPayload,
    timeoutMs: number,
    onLine?: (line: string) => void,
    priority: SparkPriority = 'judge',
  ): Promise<SparkResponse> {
    return this.queue.submit(() => this.dispatch(payload, timeoutMs, onLine), priority);
  }

  private dispatch(payload: SparkRequestPayload, timeoutMs: number, onLine?: (line: string) => void): Promise<SparkResponse> {
    // sink 与 stderr 尾巴都必须在"真正开始执行"这一刻绑定：入队时赋值会让后到的请求
    // 覆盖前一个的 sink，于是 A 的编译错误与 print 全被推给 B 的 SSE
    this.lineSink = onLine ?? null;
    this.stderrTail = '';
    const id = ++this.seq;
    let settleResolve: (value: SparkResponse) => void = () => undefined;
    let settleReject: (reason: Error) => void = () => undefined;
    const response = new Promise<SparkResponse>((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    // 计时器覆盖"会话启动 + 执行"整段，保证一次判题不会突破 timeoutMs
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.reject(new SparkTimeoutError(timeoutMs));
      this.stop(true);
    }, timeoutMs);
    this.pending.set(id, { resolve: settleResolve, reject: settleReject, timer });

    void this.ensure().then(
      (child) => {
        if (!this.pending.has(id)) return; // 已经超时回收
        try {
          child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
        } catch (err) {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new Error(`worker stdin 写入失败：${(err as Error).message}`));
        }
      },
      (err: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return response;
  }

  private async ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.ready) {
      await this.ready;
      if (!this.child) throw new Error(this.readyError ?? 'spark worker 已退出');
      return this.child;
    }
    if (!existsSync(WORKER_FILE)) throw new Error(`找不到 spark worker 脚本：${WORKER_FILE}`);
    await mkdir(SCRATCH_DIR, { recursive: true });
    // 走到这里说明当前没有活着的 JVM：上一轮 Spark 留下的 blockmgr 目录已经没人认领了
    // （常驻会话每次重启都攒一批，实测 25MB/160 个），只清一小时前的，避免和并发启动互踩。
    await sweepStaleDirs(join(SCRATCH_DIR, 'spark-local'), { maxAgeMs: 3_600_000 });
    const python = process.env.ARENA_PYTHON ?? 'python3';
    const child = spawn(python, [WORKER_FILE], {
      cwd: SCRATCH_DIR,
      env: {
        ...process.env,
        ARENA_SPARK_SCRATCH: SCRATCH_DIR,
        PYSPARK_PYTHON: python,
        PYSPARK_DRIVER_PYTHON: python,
        PYTHONUNBUFFERED: '1',
        SPARK_LOCAL_IP: '127.0.0.1',
        no_proxy: '127.0.0.1,localhost',
      },
      // 独立进程组：清理时能连 JVM 子进程一起收掉，不留孤儿 java
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.readyError = null;
    let markReady: () => void = () => undefined;
    let markFailed: (err: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    this.ready = ready;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4_000_000) buffer = buffer.slice(-200_000);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith(READY_PREFIX)) {
          const info = this.readJson(line, READY_PREFIX.length);
          this.lineSink?.(`[spark] 常驻会话就绪 version=${info?.sparkVersion ?? '?'}（后续判题复用，不再付冷启动时间）`);
          markReady();
        } else if (line.startsWith(FATAL_PREFIX)) {
          const info = this.readJson(line, FATAL_PREFIX.length);
          const message = `SparkSession 启动失败：${info?.error?.message ?? '(无详情)'}`;
          this.readyError = message;
          markFailed(new Error(message));
        } else {
          this.handleResultLine(line);
        }
        index = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_CAP);
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (line) this.lineSink?.(line);
      }
    });
    child.on('error', (err: Error) => {
      this.readyError = `worker 进程启动失败：${err.message}`;
      markFailed(new Error(this.readyError));
      this.teardown(child);
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        this.readyError = `spark worker 异常退出（code=${code ?? 'null'} signal=${signal ?? '-'}）\n${this.stderrTail}`;
        markFailed(new Error(this.readyError));
      }
      this.teardown(child);
    });

    try {
      await ready;
    } catch (err) {
      this.stop(true);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return child;
  }

  private readJson(line: string, prefixLen: number): SparkResponse | null {
    try {
      return JSON.parse(line.slice(prefixLen)) as SparkResponse;
    } catch {
      return null;
    }
  }

  private handleResultLine(line: string): void {
    if (!line.startsWith(RESULT_PREFIX)) return; // 用户代码 print()/df.show() 的噪声，忽略
    const response = this.readJson(line, RESULT_PREFIX.length);
    if (!response || typeof response.id !== 'number') return;
    const entry = this.pending.get(response.id);
    if (!entry) return; // 已被超时回收
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  private teardown(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) {
      this.child = null;
      this.ready = null;
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(this.readyError ?? 'spark worker 已退出'));
    }
    this.pending.clear();
  }

  private killTree(child: ChildProcessWithoutNullStreams): void {
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

  /** 关停：force=false 时先发 shutdown 让 JVM 自己退出，等不到再 SIGKILL 整个进程组。 */
  async stop(force = false): Promise<void> {
    const child = this.child;
    if (!child) {
      this.pending.clear();
      return;
    }
    if (!force) {
      const gone = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        child.stdin.write(`${JSON.stringify({ action: 'shutdown', id: -1 })}\n`);
        await gone;
      } catch {
        /* 忽略，下面兜底强杀 */
      }
    }
    if (this.child !== child) {
      this.child = null;
      this.ready = null;
      return;
    }
    this.killTree(child);
    this.teardown(child);
  }
}

let pool: SparkPool | null = null;
let exitHooked = false;

export function getPool(): SparkPool {
  if (!pool) {
    pool = new SparkPool();
    if (!exitHooked) {
      exitHooked = true;
      const shutdown = () => {
        pool?.stop(true);
      };
      process.once('exit', shutdown);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
  }
  return pool;
}

/** 供测试与进程收尾调用：关掉常驻 worker（连带 JVM），避免挂着不退出。 */
export async function stopSparkPool(): Promise<void> {
  const active = pool;
  pool = null;
  if (!active) return;
  await active.stop();
}
