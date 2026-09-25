import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Redis 执行底座（判题与网页 IDE 共用）。
 *
 * 与 `exec/mysql.ts`、`exec/guards.ts` 同一个理由：IDE 也要真发命令，
 * 它必须和判题共用①同一套连接与回复归一、②同一份白名单、③同一套"库位分配"。
 * 判分口径（期望值比较、失败粒度）不在这里。
 */

/**
 * 判题用独立 db index，绝不碰 0 号库；每次判题前先 FLUSHDB 自己的库。
 *
 * 15 号库**留给网页 IDE**（`IDE_DB_INDEX`）：IDE 的会话是用户随时手点、时长不可预测的，
 * 与判题错开一个 index，才不会互相 flushdb 掉对方正在看的数据。
 */
export const JUDGE_DBS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const IDE_DB_INDEX = 15;

let cursor = 0;

export function nextJudgeDb(): number {
  const db = JUDGE_DBS[cursor % JUDGE_DBS.length] as number;
  cursor += 1;
  return db;
}

function parseUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

export async function connect(db: number): Promise<Redis> {
  const redis = new Redis({
    ...parseUrl(config.redis.url),
    db,
    lazyConnect: true,
    connectTimeout: 4_000,
    maxRetriesPerRequest: 1,
  });
  // 没起 redis 时 ioredis 会 emit error 事件；不挂这个监听宿主上会打一堆 Unhandled error 噪音
  redis.on('error', () => undefined);
  await redis.connect();
  return redis;
}

/** 题目依赖的 Redis 大版本：`XAUTOCLAIM`、`EXPIRE … GT/LT` 这些命令都是 7 才有的。 */
export const REQUIRED_REDIS_MAJOR = '7';

/**
 * 栈探测里的版本守卫，判据是 `INFO server` 的文本（纯函数，好测）。
 *
 * 为什么不能只 PING：2026-09-25 实测 —— 镜像在 Redis 7 源码下载失败后**静默退回 apt 的 6.0.16**，
 * 而栈健康照报 `redis:true`；四道用 7 专属命令的题一路判到"参考解没过"才炸，
 * 那是最容易被误读成"题目写坏了"的报错形状。版本是**题目依赖**，不是偏好。
 * 拿不到版本号时放行：不把探测本身的失败算成"栈不可用"，那会让人去查错方向。
 */
export function redisMajorIsUsable(info: string): boolean {
  const major = /redis_version:(\d+)\./.exec(info)?.[1];
  return major === undefined || major === REQUIRED_REDIS_MAJOR;
}

export async function send(redis: Redis, command: readonly string[]): Promise<unknown> {
  const name = command[0] as string;
  return redis.call(name, command.slice(1) as never[]);
}

export async function sendBatch(redis: Redis, commands: readonly (readonly string[])[]): Promise<unknown[]> {
  const batch = redis.pipeline();
  for (const command of commands) batch.call(command[0] as string, command.slice(1) as never[]);
  const replied = (await batch.exec()) as [Error | null, unknown][] | null;
  if (!replied) return [];
  return replied.map(([err, value]) => (err ? `ERROR: ${err.message}` : value));
}

/** 按空白切 token，支持双引号/单引号包裹（Redis CLI 习惯写法）。 */
export function tokenizeRedis(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 多行命令序列；`#` / `//` 开头是注释。 */
export function commandLines(submission: string): string[] {
  return submission
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));
}

/** 回复归一：Buffer / 大整数 / 数字字符串 / 对象键序 都要收敛成同一个可比形态。 */
export function normalizeReply(value: unknown): unknown {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map(normalizeReply);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeReply(v)] as const);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) return String(Math.round(asNumber * 1e6) / 1e6);
    return value;
  }
  return String(value);
}
