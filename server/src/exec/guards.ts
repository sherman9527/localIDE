/**
 * 沙箱语句/命令白名单（判题与网页 IDE **共用同一份**）。
 *
 * 为什么在 `exec/` 而不是 `judge/`：白名单是"怎么安全地执行"的属性，不是"怎么判分"的属性。
 * IDE 要跑 SQL/Redis 就必须吃同一套限制 —— 否则 IDE 成了一条绕过 `SHUTDOWN` /
 * `INTO OUTFILE` / `FLUSHALL` 的后门，而它连的是**同一个** mysqld 与 redis-server。
 * 边界测试（`server/test/ide/boundary.test.ts`）继续禁止 IDE 引判题 runner / 题库 / 游戏，
 * 但允许、并且鼓励它引这一层。
 *
 * 目标不是对抗恶意攻击者（单机自用），而是防止一句写歪的 SQL 把 `arena` 业务库或
 * 整台 MySQL 打穿，从而污染后续判题（需求 spec: 越权语句被拒绝）。
 */

const SQL_ALLOWED_START = [
  'select',
  'with',
  'insert',
  'update',
  'delete',
  'replace',
  'create',
  'alter',
  'drop',
  'truncate',
  'call',
  'explain',
  'describe',
  'show',
  'set',
  'lock',
  'unlock',
];

// mysqld 会执行"版本注释"（斜杠星号后紧跟感叹号，可带 5 位版本号）里的内容，而切句器把它当普通注释丢掉。
const VERSION_COMMENT = /\/\*!/;

// 判"原始文本"里有没有版本注释 —— 必须在**切句之前**用。
// 切完再查等于没查：切句器会把版本注释当普通注释丢掉，于是守卫看到的是干净的语句，
// 而"要不要把原文交给服务器执行"这个决定早在切句那一刻就做完了。
// IDE 第一次实现就是踩在这里（新加的测试当场把它抓了出来）。
export function hasVersionComment(text: string): boolean {
  return VERSION_COMMENT.test(text);
}

const SQL_FORBIDDEN_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\binto\s+(out|dump)file\b/i, why: '禁止写文件（INTO OUTFILE / DUMPFILE）' },
  { re: /\bload_file\s*\(/i, why: '禁止读取本机文件（LOAD_FILE）' },
  { re: /\bload\s+data\b/i, why: '禁止 LOAD DATA' },
  { re: /\bgrant\b|\brevoke\b/i, why: '禁止改权限' },
  { re: /\bshutdown\b/i, why: '禁止关闭数据库' },
  { re: /\bset\s+global\b/i, why: '禁止改全局变量' },
  { re: /\bsql_log_bin\b/i, why: '禁止改 binlog 开关' },
  { re: /\b(mysql|performance_schema|sys)\s*\./i, why: '禁止访问系统库' },
  { re: /\buse\s+(mysql|sys|performance_schema)\b/i, why: '禁止切库到系统库' },
];

/** 出题用的预置语句（建表/灌数）放宽到允许 DDL，但同样禁文件与权限类。 */
export function assertSetupSql(statements: readonly string[]): void {
  for (const statement of statements) {
    const trimmed = statement.trim().replace(/;\s*$/, '');
    if (!trimmed) continue;
    assertNoForbidden(trimmed);
  }
}

export interface SqlCheck {
  ok: boolean;
  reason?: string;
}

/** 考生提交：允许单条查询（可带 CTE），或最多 1 条前置 SET SESSION。 */
export function checkSubmissionSql(submission: string): SqlCheck {
  if (VERSION_COMMENT.test(submission)) return { ok: false, reason: '禁止 /*! ... */ 版本注释（服务端会执行其中的内容）' };
  const statements = splitStatements(submission);
  if (statements.length === 0) return { ok: false, reason: '没有检测到任何 SQL 语句' };
  if (statements.length > 1) {
    const allSetSession = statements.slice(0, -1).every((s) => /^set\s+session\b/i.test(s));
    if (!(allSetSession && statements.length === 2)) {
      return { ok: false, reason: '一次只允许提交一条查询语句（可前置一条 SET SESSION ...）' };
    }
  }
  const final = statements[statements.length - 1] as string;
  const head = final.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!SQL_ALLOWED_START.includes(head)) return { ok: false, reason: `不允许的语句类型：${head || '(空)'}` };
  const forbidden = forbiddenHit(final);
  if (forbidden) return { ok: false, reason: forbidden };
  if (!/^(select|with|explain|describe|show)/i.test(final.trim())) {
    return { ok: false, reason: '答案必须是返回结果集的查询（SELECT / WITH / EXPLAIN）' };
  }
  return { ok: true };
}

function forbiddenHit(statement: string): string | undefined {
  for (const { re, why } of SQL_FORBIDDEN_PATTERNS) if (re.test(statement)) return why;
  return undefined;
}

function assertNoForbidden(statement: string): void {
  if (VERSION_COMMENT.test(statement)) {
    throw new Error(`禁止 /*! ... */ 版本注释（服务端会执行其中的内容）；出错的预置语句：${statement.slice(0, 80)}`);
  }
  const hit = forbiddenHit(statement);
  if (hit) throw new Error(`${hit}；出错的预置语句：${statement.slice(0, 80)}`);
}

/**
 * 单遍扫描切句：字符串字面量、反引号标识符、`--` 行注释、`/* *\/` 块注释都要正确跳过，
 * 否则 `SELECT 'a;b'` 会被误判成多条语句。
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (quote) {
      current += ch;
      if (ch === '\\' && quote !== '`') {
        current += sql[++i] ?? '';
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      current += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      current += ' ';
      continue;
    }
    if (ch === ';') {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const REDIS_FORBIDDEN = new Set([
  'flushall',
  'flushdb',
  'config',
  'debug',
  'shutdown',
  'save',
  'bgsave',
  'bgrewriteaof',
  'keys',
  'monitor',
  'slaveof',
  'replicaof',
  'module',
  'migrate',
  'sort',
  'object',
  'select',
  'swapdb',
  'acl',
  'script',
  'eval',
  'evalsha',
  'fcall',
  'latency',
]);

export function checkRedisCommand(args: readonly string[]): SqlCheck {
  const name = (args[0] ?? '').toLowerCase();
  if (!name) return { ok: false, reason: '空命令' };
  if (REDIS_FORBIDDEN.has(name)) return { ok: false, reason: `不允许的命令：${name.toUpperCase()}` };
  return { ok: true };
}
