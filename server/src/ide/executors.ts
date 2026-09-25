import { join } from 'node:path';
import type { IdeReply, IdeRunResponse, IdeTable } from '@arena/shared';
import { assertSetupSql, checkRedisCommand, hasVersionComment, splitStatements } from '../exec/guards.js';
import { createScratchDb, disposeScratchDb, parseTsv, runSql } from '../exec/mysql.js';
import { logWarn } from '../log.js';
import {
  commandLines,
  connect,
  IDE_DB_INDEX,
  normalizeReply,
  REQUIRED_REDIS_MAJOR,
  redisMajorIsUsable,
  send,
  tokenizeRedis,
} from '../exec/redis.js';
import { runProcess } from '../judge/process.js';
import { createWorkspace } from '../judge/workspace.js';
import { SPARK_JVM_FLAGS, scalaClasspaths, scalaSparkAvailable } from '../exec/spark-scala.js';
import { SparkTimeoutError, getPool, pysparkAvailable } from '../exec/spark-pool.js';
import type { IdeNonCommandProbe } from './languages.js';
import { IDE_LIMITS } from './languages.js';

/**
 * IDE 的两种"非进程"执行形态：SQL 与 Redis。
 *
 * 它们与判题共用同一套底座（`exec/*`）与同一份白名单 —— 这是刻意的：
 * IDE 连的是**同一个** mysqld 与 redis-server，如果它绕过白名单，就等于给
 * `SHUTDOWN` / `INTO OUTFILE` / `FLUSHALL` 开了一条后门。
 *
 * 与判题的差别只在"允许多语句 + 不比对期望值"：
 *  - SQL：允许 DDL/DML（跑在一次性库里），最后一个结果集当表格回；
 *  - Redis：逐条命令回回复。
 * 两者每次运行都从空库开始 —— 宁可让你把前置语句一起贴进来，
 * 也不让 IDE 里攒出一库没人知道来源的脏数据。
 */

function base(durationMs: number): IdeRunResponse {
  return {
    status: 'ok',
    stage: 'run',
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs,
    stdoutCapChars: IDE_LIMITS.stdoutCapChars,
    table: null,
    replies: null,
  };
}

function rejected(message: string, durationMs: number): IdeRunResponse {
  return { ...base(durationMs), status: 'rejected', stage: 'submit', exitCode: null, message };
}

function failed(message: string, durationMs: number, stderr = ''): IdeRunResponse {
  return { ...base(durationMs), status: 'runtime_error', exitCode: null, message, stderr };
}

// 语句级守卫：IDE 与判题的预置语句走同一条判据（禁文件、禁权限、禁系统库、禁版本注释）。
// 版本注释必须在**切句之前**查：切句器会把它当普通注释丢掉，于是"没有语句"先返回、
// 守卫根本没机会看到（判题侧就是先查再切）。写成 // 而不是块注释，是因为块注释
// 里出现 `星号斜杠` 会提前结束注释 —— 这个坑我刚踩过一次。
function guardSql(raw: string, statements: readonly string[]): string | null {
  if (hasVersionComment(raw)) return '禁止 /*! ... */ 版本注释（服务端会执行其中的内容）';
  try {
    assertSetupSql([...statements]);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function runIdeSql(code: string, setup: string, timeoutMs: number): Promise<IdeRunResponse> {
  const started = Date.now();
  const statements = splitStatements(code);
  const setupStatements = splitStatements(setup);

  const violation = guardSql(`${setup}\n${code}`, [...setupStatements, ...statements]);
  if (violation) return rejected(`语句被白名单拒绝：${violation}`, Date.now() - started);
  if (statements.length === 0) return rejected('没有检测到任何 SQL 语句', Date.now() - started);

  const scratch = await createScratchDb('ide', timeoutMs);
  if (!scratch.db) return failed(`建临时库失败：${scratch.error ?? ''}`, Date.now() - started);
  const db = scratch.db;

  try {
    for (const [index, statement] of setupStatements.entries()) {
      const seeded = await runSql(statement, db, undefined, timeoutMs);
      if (seeded.code !== 0) {
        return failed(`第 ${index + 1} 条预置语句失败：${seeded.stderr.trim() || seeded.stdout.trim()}`, Date.now() - started, seeded.stderr);
      }
    }

    let last: { columns: string[]; rows: string[][] } = { columns: [], rows: [] };
    let lastKind = '';
    for (const [index, statement] of statements.entries()) {
      const answer = await runSql(statement, db, undefined, timeoutMs);
      if (answer.timedOut) {
        return { ...base(Date.now() - started), status: 'timeout', timedOut: true, exitCode: null, message: `第 ${index + 1} 条语句超过 ${timeoutMs}ms` };
      }
      if (answer.code !== 0) {
        return failed(
          `第 ${index + 1} 条语句失败：${answer.stderr.trim() || answer.stdout.trim()}`,
          Date.now() - started,
          answer.stderr,
        );
      }
      const parsed = parseTsv(answer.stdout);
      if (parsed.columns.length > 0) {
        last = parsed;
        lastKind = 'rows';
      } else if (answer.stderr.trim()) {
        return failed(`第 ${index + 1} 条语句：${answer.stderr.trim()}`, Date.now() - started, answer.stderr);
      }
    }

    const limit = IDE_LIMITS.tableRowLimit;
    const table: IdeTable | null =
      lastKind === 'rows'
        ? { columns: last.columns, rows: last.rows.slice(0, limit), truncated: last.rows.length > limit, rowLimit: limit }
        : null;
    const ran = `已执行 ${setupStatements.length + statements.length} 条语句（含 ${setupStatements.length} 条预置）` +
      (table ? `，最后一个结果集 ${last.rows.length} 行` : '，没有返回结果集');
    return { ...base(Date.now() - started), stdout: ran, table };
  } finally {
    await disposeScratchDb(db);
  }
}

/** Redis 没有内建的命令级超时（一个 O(N) 命令能挂着不放），所以自己包一层。 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '(nil)';
  return JSON.stringify(normalizeReply(value));
}

export async function runIdeRedis(code: string, setup: string, timeoutMs: number): Promise<IdeRunResponse> {
  const started = Date.now();
  const userCommands = commandLines(code).map(tokenizeRedis).filter((c) => c.length > 0);
  const setupCommands = commandLines(setup).map(tokenizeRedis).filter((c) => c.length > 0);
  if (userCommands.length === 0) return rejected('没有检测到任何 Redis 命令', Date.now() - started);

  for (const command of [...setupCommands, ...userCommands]) {
    const check = checkRedisCommand(command);
    if (!check.ok) return rejected(`命令被白名单拒绝：${check.reason ?? command[0]}`, Date.now() - started);
  }

  let redis: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    redis = await connect(IDE_DB_INDEX);
    await redis.flushdb();
    for (const command of setupCommands) await send(redis, command);

    const replies: IdeReply[] = [];
    for (const command of userCommands) {
      const outcome = await withTimeout(send(redis, command), timeoutMs);
      if (outcome === 'timeout') {
        return {
          ...base(Date.now() - started),
          status: 'timeout',
          timedOut: true,
          exitCode: null,
          message: `命令 ${command.join(' ')} 超过 ${timeoutMs}ms 未返回`,
          replies,
        };
      }
      replies.push({ command: command.join(' '), reply: asText(outcome) });
    }
    const ran = `已执行 ${setupCommands.length + userCommands.length} 条命令（含 ${setupCommands.length} 条预置）`;
    return { ...base(Date.now() - started), stdout: ran, replies };
  } catch (err) {
    return failed(`Redis 执行失败：${(err as Error).message ?? String(err)}`, Date.now() - started);
  } finally {
    if (redis) {
      // 跑完就清干净：下一个运行、以及判题用的那些 index，都不该看到这里的键
      await redis.flushdb().catch(() => undefined);
      redis.disconnect();
    }
  }
}

/** 非命令型语言的可探性：对着真实的后端/栈探，不是"客户端在不在"。 */
export async function probeAvailability(kind: IdeNonCommandProbe): Promise<boolean> {
  if (kind === 'mysql') {
    const check = await runSql('SELECT 1', undefined, undefined, 5_000).catch(() => null);
    return check !== null && check.code === 0;
  }
  if (kind === 'pyspark') return pysparkAvailable();
  if (kind === 'spark-scala') return scalaSparkAvailable();
  let redis: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    redis = await connect(IDE_DB_INDEX);
    if ((await withTimeout(redis.ping(), 4_000)) !== 'PONG') return false;
    const info = await withTimeout(redis.info('server'), 4_000);
    if (redisMajorIsUsable(info)) return true;
    logWarn('ide', 'redis-major-version-unexpected', {
      found: /redis_version:([^\s]+)/.exec(info)?.[1] ?? '未知',
      want: `${REQUIRED_REDIS_MAJOR}.x`,
    });
    return false;
  } catch {
    return false;
  } finally {
    redis?.disconnect();
  }
}

/**
 * Spark 两种执行形态（①）。实测数字：PySpark 预热后一次 0.3~6.7s，Spark Scala 一遍 15.4s（含真编译）。
 *
 * PySpark 复用**判题那个常驻 worker**：冷启动一次 SparkSession 实测要 8.9s（WI-09 量的），
 * 再起一个会话等于把镜像里那份 JVM 内存翻倍。代价摆在这里：
 * 池同一时刻只允许一个请求在飞，所以 IDE 跑 Spark 会排在判题后面（priority='ide'），
 * UI 必须把"已经等了多久"显示出来，而不是让人以为点没生效。
 *
 * Spark Scala 没有常驻池可言（每次都要 scalac 真编译），所以它走"编译 + 一次 JVM 运行"，
 * 与判题共用 classpath 组装规则（`exec/spark-scala.ts`）—— 编译器与运行期的 Scala
 * 标准库版本不一致会"编译过但运行期 NoSuchMethodError"，这条只能有一处实现。
 */
export async function runIdePyspark(
  code: string,
  setup: string,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<IdeRunResponse> {
  const started = Date.now();
  const statements = splitStatements(setup);
  const pool = getPool();
  try {
    const response = await pool.request(
      {
        entry: 'script',
        mode: 'ide',
        code,
        setup: statements,
        orderSensitive: false,
        cases: [],
        rowLimit: IDE_LIMITS.tableRowLimit,
      },
      timeoutMs,
      onLine,
      'ide',
    );
    const error = response.error;
    if (error) {
      return {
        ...base(Date.now() - started),
        status: error.stage === 'compile' ? 'compile_error' : 'runtime_error',
        stage: error.stage === 'compile' ? 'compile' : 'run',
        exitCode: null,
        stdout: response.stdout ?? '',
        stderr: `${error.message ?? ''}\n${error.traceback ?? ''}`.trim(),
        message: error.message,
      };
    }
    const table = response.table
      ? { columns: response.table.columns, rows: response.table.rows, truncated: response.table.truncated, rowLimit: IDE_LIMITS.tableRowLimit }
      : null;
    return { ...base(Date.now() - started), stdout: response.stdout ?? '', table };
  } catch (err) {
    const timedOut = err instanceof SparkTimeoutError;
    return {
      ...base(Date.now() - started),
      status: timedOut ? 'timeout' : 'runtime_error',
      timedOut,
      exitCode: null,
      message: timedOut ? `Spark 运行超过 ${timeoutMs}ms（常驻会话已被重启）` : `Spark 会话不可用：${(err as Error).message}`,
    };
  }
}

const SCALA_OBJECT = /\bobject\s+Solution\b/;
const SCALA_MAIN = /\bdef\s+main\s*\(/;

/**
 * Spark 的 JVM 日志全打在 stderr，格式是 `26/09/24 18:11:37 INFO SparkContext: ...`。
 * IDE 里一次成功的运行会因此被几百行不属于用户的日志淹没（PySpark 那条不会，因为
 * worker 的 stdout 是进程内收集的），所以只保留 WARN/ERROR 与真正的异常栈。
 */
const SPARK_INFO_LINE = /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} INFO /;
const SPARK_NOISE_LINE = /Using Spark's default log4j profile/;

/** scalac 单独封顶的时间。注册表里 spark-scala 的预算必须容得下"编译 + 运行"两段。 */
export const SPARK_SCALA_COMPILE_CAP_MS = 60_000;

export function foldSparkInfoLogs(stderr: string): { text: string; folded: number } {
  const kept: string[] = [];
  let folded = 0;
  for (const line of stderr.split('\n')) {
    if (SPARK_INFO_LINE.test(line) || SPARK_NOISE_LINE.test(line)) folded += 1;
    else kept.push(line);
  }
  const text = kept.join('\n').trim();
  return { folded, text: folded > 0 && text ? `${text}\n（已折叠 ${folded} 行 Spark INFO 日志）` : text || (folded ? `（已折叠 ${folded} 行 Spark INFO 日志，无其他输出）` : '') };
}

export async function runIdeSparkScala(
  code: string,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<IdeRunResponse> {
  const started = Date.now();
  if (!SCALA_OBJECT.test(code) || !SCALA_MAIN.test(code)) {
    return rejected('必须写成 `object Solution { def main(args: Array[String]): Unit = ... }`（IDE 要真跑出 main）', Date.now() - started);
  }
  const { compile, run } = await scalaClasspaths();
  if (compile.length === 0) {
    return { ...base(Date.now() - started), status: 'rejected', stage: 'submit', exitCode: null, message: '找不到 Scala 编译器（镜像里的 spark jars 不在）' };
  }
  const workspace = await createWorkspace('ide-spark');
  // Spark 的 INFO 日志全在 stderr，一次运行能轻松写出几 MB —— 不封顶就是给响应体埋雷。
  const cap = IDE_LIMITS.stdoutCapChars;
  const opts = { cwd: workspace.root, onLine, maxOutputChars: cap + 4096 };
  try {
    await workspace.write('Solution.scala', code);
    await workspace.write('classes/.keep', '');
    // 编译与运行**共享**同一个预算：两段各给 timeoutMs 会变成"最多 2×timeout 才回话"，
    // 而 UI 上那条 120s 的提示就成了假话。编译封顶 60s（scalac 实测 2.5~5s，超 60s 是没救的）。
    const compiled = await runProcess(
      'java',
      ['-Xmx1g', '-cp', compile.join(':'), 'scala.tools.nsc.Main', '-classpath', compile.join(':'), '-d', 'classes', 'Solution.scala'],
      { ...opts, timeoutMs: Math.min(60_000, timeoutMs) },
    );
    if (compiled.code !== 0) {
      const detail = `${compiled.stderr}\n${compiled.stdout}`.trim();
      return {
        ...base(Date.now() - started),
        status: 'compile_error',
        stage: 'compile',
        exitCode: compiled.code,
        stderr: detail.slice(0, cap),
        truncated: detail.length >= cap,
        timedOut: compiled.timedOut,
      };
    }
    const ran = await runProcess('java', [...SPARK_JVM_FLAGS, '-cp', [join(workspace.root, 'classes'), ...run].join(':'), 'Solution'], {
      ...opts,
      timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)),
    });
    const shown = foldSparkInfoLogs(ran.stderr);
    return {
      ...base(Date.now() - started),
      status: ran.timedOut ? 'timeout' : ran.code === 0 ? 'ok' : 'runtime_error',
      exitCode: ran.code,
      stdout: ran.stdout.slice(0, cap),
      stderr: shown.text.slice(0, cap),
      truncated: ran.stdout.length >= cap || shown.text.length >= cap,
      timedOut: ran.timedOut,
    };
  } finally {
    await workspace.cleanup();
  }
}
