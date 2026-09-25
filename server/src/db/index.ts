import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseAttemptDetail, serializeAttemptDetail, todayIso } from '@arena/shared';
import { config } from '../config.js';
import type { AttemptRow, ProgressStore } from '../ports.js';

/**
 * SQLite 持久层（只依赖 Node 内置 node:sqlite，不引入 better-sqlite3）。
 * Node 22/23 下 node:sqlite 需要 `--experimental-sqlite`，且某些构建里根本没有该模块，
 * 因此 driver 做成可注入的：默认 node:sqlite，退路是自己传一个同形状 driver。
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface SqlDriver {
  readonly name: string;
  open(file: string): SqlDatabase;
}

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): SqlRow | undefined;
  all(...params: unknown[]): SqlRow[];
}
interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);

/** 默认 driver：node:sqlite 的 DatabaseSync（首用时才解析，缺失时给出可操作报错）。 */
export const nodeSqliteDriver: SqlDriver = {
  name: 'node:sqlite',
  open(file: string): SqlDatabase {
    let mod: { DatabaseSync: new (f: string) => NodeSqliteDatabase };
    try {
      mod = requireModule('node:sqlite') as typeof mod;
    } catch (err) {
      throw new Error(
        `无法加载 node:sqlite（${(err as Error).message}）。Node 22/23 请以 --experimental-sqlite 启动，` +
          `或给 openProgressStore 注入自定义 driver。`,
      );
    }
    const db = new mod.DatabaseSync(file);
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...params: SqlValue[]) => stmt.run(...params.map(normalizeParam)),
          get: (...params: SqlValue[]) => stmt.get(...params.map(normalizeParam)),
          all: (...params: SqlValue[]) => stmt.all(...params.map(normalizeParam)),
        };
      },
      close: () => db.close(),
    };
  },
};

/** node:sqlite 不接受 undefined，布尔也不在支持列表里 —— 统一兜底成 null / 0-1。 */
function normalizeParam(value: SqlValue | boolean | undefined): null | number | bigint | string | Uint8Array {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

const DDL = `
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER,
  max_score INTEGER,
  xp INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  day TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);
CREATE INDEX IF NOT EXISTS attempts_question ON attempts(question_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * 当前 schema 版本，写在 PRAGMA user_version 上。
 * v2：attempts 加 detail 列（逐用例结果留档，N-05）。
 */
export const SCHEMA_VERSION = 2;

/** v1 建出来的库没有这一列，升级时按列是否存在决定要不要 ALTER。 */
const ADDED_COLUMNS: { version: number; column: string; ddl: string }[] = [
  { version: 2, column: 'detail', ddl: 'ALTER TABLE attempts ADD COLUMN detail TEXT' },
];

/** ProgressStore 之外的附加能力（计划缓存、奖励发放）；测试假 store 可以完全不实现。 */
export interface SettingsStore {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

/** store 是否支持 settings；不支持时调用方必须能降级（不缓存、不发奖励）。 */
export function asSettingsStore(store: ProgressStore | unknown): SettingsStore | null {
  const candidate = store as Partial<SettingsStore> | null | undefined;
  if (!candidate || typeof candidate.getSetting !== 'function' || typeof candidate.setSetting !== 'function') return null;
  return candidate as SettingsStore;
}

export interface ProgressStoreOptions {
  /** 默认 config.dbFile（仓库内，rule.md C1） */
  file?: string;
  driver?: SqlDriver;
  /** day 缺省时的兜底时钟 */
  now?: () => Date;
  /** 是否执行迁移；默认 true */
  migrate?: boolean;
}

const BEST_SQL = `
SELECT id, question_id, category, kind, status, score, max_score, xp, passed, failed, duration_ms, created_at, day
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY xp DESC, id ASC) AS rn
  FROM attempts
)
WHERE rn = 1
ORDER BY id
`;

const ROW_COLUMNS = 'id, question_id, category, kind, status, score, max_score, xp, passed, failed, duration_ms, created_at, day';

/** detail 是留档正文，一版可能几十 KB，只有真要复盘的查询才带上它。 */
const ROW_COLUMNS_WITH_DETAIL = `${ROW_COLUMNS}, detail`;

export class SqliteProgressStore implements ProgressStore, SettingsStore {
  private closed = false;

  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
    readonly file: string = ':memory:',
  ) {}

  /** 幂等迁移：CREATE IF NOT EXISTS + 按列存在性补列 + PRAGMA user_version 记账。 */
  static migrate(db: SqlDatabase, version = SCHEMA_VERSION): number {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // :memory: 或只读文件系统不支持 WAL 时静默降级
    }
    db.exec(DDL);
    const current = toNumber(db.prepare('PRAGMA user_version').get()?.user_version);
    if (current < version) {
      // 新建库的 DDL 里已经带了新列，所以补列只看"列在不在"，不看版本号——否则 v2 新库会被 ALTER 撞一次
      const existing = new Set(
        (db.prepare('PRAGMA table_info(attempts)').all() as { name?: unknown }[]).map((c) => String(c.name)),
      );
      for (const added of ADDED_COLUMNS) {
        if (added.version <= version && !existing.has(added.column)) db.exec(added.ddl);
      }
      db.exec(`PRAGMA user_version = ${version}`);
    }
    return toNumber(db.prepare('PRAGMA user_version').get()?.user_version);
  }

  get userVersion(): number {
    return toNumber(this.db.prepare('PRAGMA user_version').get()?.user_version);
  }

  private rowToAttempt(row: SqlRow | undefined, withDetail = false): AttemptRow | undefined {
    if (!row) return undefined;
    const attempt: AttemptRow = {
      id: toNumber(row.id),
      questionId: String(row.question_id),
      category: String(row.category),
      kind: row.kind === 'grade' ? 'grade' : 'judge',
      status: String(row.status),
      score: toNullableNumber(row.score),
      maxScore: toNullableNumber(row.max_score),
      xp: toNumber(row.xp),
      passed: toNumber(row.passed),
      failed: toNumber(row.failed),
      durationMs: toNumber(row.duration_ms),
      createdAt: String(row.created_at),
      day: String(row.day),
    };
    // detail 只由带它的查询带回来：汇总类查询没必要把每份提交正文捞进内存
    if (withDetail) {
      attempt.detail = parseAttemptDetail(row.detail === null || row.detail === undefined ? null : String(row.detail));
    }
    return attempt;
  }

  async record(attempt: Omit<AttemptRow, 'id'>): Promise<AttemptRow> {
    const day = attempt.day?.trim() ? attempt.day : todayIso(this.now());
    const createdAt = attempt.createdAt || new Date(this.now().getTime()).toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO attempts (question_id, category, kind, status, score, max_score, xp, passed, failed, duration_ms, created_at, day, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.questionId,
        attempt.category,
        attempt.kind,
        attempt.status,
        attempt.score ?? null,
        attempt.maxScore ?? null,
        Math.trunc(attempt.xp),
        Math.trunc(attempt.passed),
        Math.trunc(attempt.failed),
        Math.trunc(attempt.durationMs),
        createdAt,
        day,
        attempt.detail ? serializeAttemptDetail(attempt.detail) : null,
      );
    const id = toNumber(info.lastInsertRowid);
    const stored = this.rowToAttempt(this.db.prepare(`SELECT ${ROW_COLUMNS_WITH_DETAIL} FROM attempts WHERE id = ?`).get(id), true);
    if (!stored) throw new Error(`写入 attempt 后读不到 id=${id}`);
    return stored;
  }

  async attemptsByDay(day: string): Promise<AttemptRow[]> {
    const rows = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM attempts WHERE day = ? ORDER BY id`).all(day);
    return rows.map((row) => this.rowToAttempt(row)!).filter(Boolean);
  }

  async historyFor(questionId: string, limit: number): Promise<AttemptRow[]> {
    const rows = this.db
      .prepare(`SELECT ${ROW_COLUMNS_WITH_DETAIL} FROM attempts WHERE question_id = ? ORDER BY id DESC LIMIT ?`)
      .all(questionId, Math.max(0, Math.trunc(limit)));
    return rows.map((row) => this.rowToAttempt(row, true)!).filter(Boolean);
  }

  async allAttempts(): Promise<AttemptRow[]> {
    const rows = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM attempts ORDER BY id`).all();
    return rows.map((row) => this.rowToAttempt(row)!).filter(Boolean);
  }

  async bestByQuestion(): Promise<Map<string, AttemptRow>> {
    const rows = this.db.prepare(BEST_SQL).all();
    const out = new Map<string, AttemptRow>();
    for (const row of rows) {
      const attempt = this.rowToAttempt(row);
      if (attempt) out.set(attempt.questionId, attempt);
    }
    return out;
  }

  async bestXpFor(questionId: string): Promise<number> {
    const row = this.db.prepare('SELECT COALESCE(MAX(xp), 0) AS xp FROM attempts WHERE question_id = ?').get(questionId);
    return toNumber(row?.xp);
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    const value = row.value;
    return value === null || value === undefined ? null : String(value);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** 打开（并按需迁移）SQLite 进度库。 */
export function openProgressStore(opts: ProgressStoreOptions = {}): SqliteProgressStore {
  const driver = opts.driver ?? nodeSqliteDriver;
  const raw = opts.file ?? config.dbFile;
  const file = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = driver.open(file);
  const store = new SqliteProgressStore(db, opts.now, file);
  if (opts.migrate !== false) SqliteProgressStore.migrate(db);
  return store;
}
