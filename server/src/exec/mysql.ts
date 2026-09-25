import { config } from '../config.js';
import { runProcess } from '../judge/process.js';

/**
 * MySQL 执行底座（判题与网页 IDE 共用）。
 *
 * 这里只放"怎么把语句送到 mysqld 再把结果读回来"，不放任何判分口径
 * （期望值比较、失败粒度那些留在 `judge/runners/mysql.ts`）。
 * 搬出来的动机与 `exec/guards.ts` 同源：IDE 也要跑 SQL，而它必须和判题共用
 * ①同一份白名单、②同一套临时库命名与清理，否则两边规则必然漂移
 * （本仓库为"两份实现各说各话"付过不止一次学费）。
 */

/** 客户端兜底：真正的时间上限是题目里的 max_execution_time，这里只保证 mysql 进程不会挂着不走。 */
export const CLIENT_GRACE_MS = 2_000;

function mysqlArgs(db?: string): string[] {
  return [
    `--socket=${config.mysql.socket}`,
    `--user=${config.mysql.user}`,
    '--batch',
    '--raw',
    '--wait',
    '--connect-timeout=5',
    '--default-character-set=utf8mb4',
    '--force=false',
    ...(db ? [`--database=${db}`] : []),
  ];
}

export async function runSql(
  statement: string,
  db?: string,
  onLine?: (line: string) => void,
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const res = await runProcess('mysql', [...mysqlArgs(db), '-e', statement], { timeoutMs, onLine });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
}

/** `mysql --batch` 的输出是第一行表头的 TSV；空结果集连表头都没有（这是构造上判不了空表的原因，见 docs/JUDGING.md）。 */
export function parseTsv(stdout: string): { columns: string[]; rows: string[][] } {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const header = lines[0] as string;
  return { columns: header.split('\t'), rows: lines.slice(1).map((line) => line.split('\t')) };
}

/**
 * 建一个一次性库。前缀写死 `arena_`：判题后的残留检查（"不许留下 arena_% 库"）
 * 与 IDE 的清理走同一把尺子。
 */
export async function createScratchDb(label: string, timeoutMs = 20_000): Promise<{ db: string; error?: string }> {
  const db = `arena_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now().toString(36)}`;
  const create = await runSql(
    `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
    undefined,
    undefined,
    timeoutMs,
  );
  if (create.code !== 0) return { db: '', error: create.stderr };
  return { db };
}

/**
 * 删掉一次性库。**先踢连接再删库**：客户端被杀不等于服务端查询结束，
 * 孤儿查询持有该库的元数据锁，`DROP DATABASE` 会一直等下去，临时库就永久留在实例里。
 */
export async function disposeScratchDb(db: string): Promise<void> {
  const list = await runSql(
    `SELECT Id FROM information_schema.PROCESSLIST WHERE DB = '${db}' AND Id <> CONNECTION_ID();`,
    undefined,
    undefined,
    5_000,
  ).catch(() => undefined);
  for (const id of list ? parseTsv(list.stdout).rows.flat() : []) {
    if (/^\d+$/.test(id)) await runSql(`KILL ${id};`, undefined, undefined, 5_000).catch(() => undefined);
  }
  await runSql(`DROP DATABASE IF EXISTS \`${db}\`;`, undefined, undefined, 10_000).catch(() => undefined);
}
