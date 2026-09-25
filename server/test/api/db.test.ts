import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detailFromJudge, todayIso } from '@arena/shared';
import { asSettingsStore, nodeSqliteDriver, openProgressStore, SCHEMA_VERSION, type SqlDriver } from '../../src/db/index.js';
import type { ProgressStore } from '../../src/ports.js';
import { newAttempt } from '../game/fixtures.js';

const require = createRequire(import.meta.url);
type RawDb = {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[]; get(): Record<string, unknown> | undefined; run(...params: unknown[]): unknown };
  close(): void;
};
const openRaw = (file: string): RawDb => {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => RawDb };
  return new DatabaseSync(file);
};

let dir: string;
let file: string;
const stores: ProgressStore[] = [];

const open = (now = () => new Date('2026-09-19T09:30:00')) => {
  const store = openProgressStore({ file, now });
  stores.push(store);
  return store;
};

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'db-'));
  file = join(dir, 'arena.db');
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('node:sqlite 可用性（不加 flag 也能跑）', () => {
  it('默认 driver 就是 node:sqlite 的 DatabaseSync', () => {
    expect(typeof nodeSqliteDriver.open).toBe('function');
    const db = nodeSqliteDriver.open(':memory:');
    db.exec('CREATE TABLE t(a INTEGER)');
    db.prepare('INSERT INTO t(a) VALUES(?)').run(1);
    expect(db.prepare('SELECT a FROM t').all()).toEqual([{ a: 1 }]);
    db.close();
  });
});

describe('openProgressStore — schema 与迁移', () => {
  it('建表 + 索引 + WAL + user_version（幂等，可重复打开）', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'alg-java-0001' }));
    await store.close();
    // 再开两次：迁移必须幂等，历史数据不丢
    const again = open();
    await again.record(newAttempt({ questionId: 'alg-java-0002' }));
    const third = open();
    const db = openRaw(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
    const objects = db.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all() as { type: string; name: string }[];
    expect(objects.map((o) => o.name).filter((n) => n.startsWith('attempts') || n === 'settings').sort()).toEqual([
      'attempts',
      'attempts_day',
      'attempts_question',
      'settings',
    ]);
    expect(objects.some((o) => o.type === 'table' && o.name === 'settings')).toBe(true);
    db.close();
    expect((await third.allAttempts()).map((r) => r.questionId)).toEqual(['alg-java-0001', 'alg-java-0002']);
  });

  it('注入自定义 driver 也能跑（node:sqlite 需要 flag 的环境有退路）', async () => {
    let opens = 0;
    const driver: SqlDriver = {
      name: 'spy-node-sqlite',
      open(target: string) {
        opens++;
        return nodeSqliteDriver.open(target);
      },
    };
    const store = openProgressStore({ file: join(dir, 'injected.db'), driver });
    stores.push(store);
    const row = await store.record(newAttempt({ questionId: 'sql-mysql-0001' }));
    expect(opens).toBe(1);
    expect(row.id).toBe(1);
    expect((await store.attemptsByDay('2026-09-19')).map((r) => r.questionId)).toEqual(['sql-mysql-0001']);
  });
});

describe('SCHEMA_VERSION 1→2：给 attempts 加 detail 列（N-05 判题历史留档）', () => {
  /** 手搭一个 v1 形状的库：没有 detail 列，user_version=1，且已有一条真实数据。 */
  const makeV1Db = (rows: { questionId: string; day: string }[] = [{ questionId: 'alg-java-0001', day: '2026-09-19' }]) => {
    const db = openRaw(file);
    db.exec(`
CREATE TABLE attempts (
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
  day TEXT NOT NULL
);
CREATE INDEX attempts_day ON attempts(day);
CREATE INDEX attempts_question ON attempts(question_id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
PRAGMA user_version = 1;
`);
    const insert = db.prepare(
      `INSERT INTO attempts (question_id, category, kind, status, score, max_score, xp, passed, failed, duration_ms, created_at, day)
       VALUES (?, 'algorithms', 'judge', 'fail', NULL, NULL, 2, 0, 1, 100, '2026-09-19T08:00:00.000Z', ?)`,
    );
    for (const row of rows) insert.run(row.questionId, row.day);
    db.close();
  };

  const columnsOf = (): string[] => {
    const db = openRaw(file);
    try {
      return (db.prepare('PRAGMA table_info(attempts)').all() as { name: string }[]).map((c) => c.name);
    } finally {
      db.close();
    }
  };

  it('v1 库升级后 detail 列出现，老数据一条不丢、读成"没有留档"', async () => {
    makeV1Db();
    expect(columnsOf()).not.toContain('detail');

    const store = open();
    expect(store.userVersion).toBe(2);
    expect(columnsOf()).toContain('detail');

    const rows = await store.historyFor('alg-java-0001', 5);
    expect(rows.map((r) => r.questionId)).toEqual(['alg-java-0001']);
    // 迁移前那次提交确实没存过用例结果 —— 读成 null，由 UI 说明，而不是编个空数组假装看过
    expect(rows[0]?.detail).toBeNull();
  });

  it('迁移幂等：同一份 v1 库连开三次不报错，列不会重复加', async () => {
    makeV1Db();
    const first = open();
    await first.close();
    const second = open();
    await second.record(newAttempt({ questionId: 'alg-java-0002' }));
    await second.close();
    const third = open();
    expect(third.userVersion).toBe(2);
    expect(columnsOf().filter((c) => c === 'detail')).toHaveLength(1);
    expect((await third.allAttempts()).map((r) => r.questionId)).toEqual(['alg-java-0001', 'alg-java-0002']);
  });

  it('新建库直接就是 v2（迁移不能只服务升级路径）', async () => {
    const store = open();
    expect(store.userVersion).toBe(2);
    expect(columnsOf()).toContain('detail');
  });

  it('库里 detail 是坏 JSON → 读成 null，不能带崩整个历史列表', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'alg-java-0001' }));
    const raw = openRaw(file);
    raw.prepare(`UPDATE attempts SET detail = ? WHERE question_id = ?`).run('{"v":1,', 'alg-java-0001');
    raw.close();
    const rows = await store.historyFor('alg-java-0001', 5);
    expect(rows[0]?.detail).toBeNull();
  });

  it('detail 往返：写进去的逐用例结果原样读出来', async () => {
    const store = open();
    const detail = detailFromJudge(
      {
        status: 'fail',
        passed: 1,
        failed: 1,
        total: 2,
        passedCases: ['常规'],
        failedCases: [{ name: '空输入', passed: false, expected: '[]', actual: 'NPE' }],
        durationMs: 100,
      },
      'class A{}',
    );
    await store.record(newAttempt({ questionId: 'alg-java-0001', detail }));
    const [row] = await store.historyFor('alg-java-0001', 5);
    expect(row?.detail).toEqual(detail);
  });

  it('historyFor：按题目取最近 N 次，新的在前', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'q1', createdAt: '2026-09-19T08:00:00.000Z', day: '2026-09-19' }));
    await store.record(newAttempt({ questionId: 'q1', createdAt: '2026-09-20T08:00:00.000Z', day: '2026-09-20' }));
    await store.record(newAttempt({ questionId: 'q2', createdAt: '2026-09-21T08:00:00.000Z', day: '2026-09-21' }));
    await store.record(newAttempt({ questionId: 'q1', createdAt: '2026-09-22T08:00:00.000Z', day: '2026-09-22' }));
    const history = await store.historyFor('q1', 2);
    expect(history.map((r) => r.day)).toEqual(['2026-09-22', '2026-09-20']);
    expect(history[0]?.id).toBeGreaterThan(history[1]?.id ?? 0);
    expect(await store.historyFor('nope', 5)).toEqual([]);
  });
});

describe('ProgressStore 往返', () => {
  it('record 写全字段并回读，score 可为 null', async () => {
    const store = open();
    const row = await store.record({
      ...newAttempt({ questionId: 'alg-java-0001', category: 'algorithms', day: '2026-09-19' }),
      score: null,
      maxScore: null,
      xp: 15,
      passed: 3,
      failed: 0,
      durationMs: 4321,
      createdAt: '2026-09-19T09:00:00.000Z',
    });
    expect(row.id).toBe(1);
    expect(row).toMatchObject({
      questionId: 'alg-java-0001',
      category: 'algorithms',
      kind: 'judge',
      status: 'pass',
      score: null,
      maxScore: null,
      xp: 15,
      passed: 3,
      failed: 0,
      durationMs: 4321,
      createdAt: '2026-09-19T09:00:00.000Z',
      day: '2026-09-19',
    });
    const graded = await store.record(
      newAttempt({ questionId: 'sd-rub-0001', category: 'system-design', kind: 'grade', status: 'pass', score: 10, maxScore: 10, xp: 20, day: '2026-09-20' }),
    );
    expect(graded.id).toBe(2);
    expect(graded.score).toBe(10);
    expect(graded.maxScore).toBe(10);
  });

  it('attemptsByDay / allAttempts 按写入顺序返回', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'a', day: '2026-09-19' }));
    await store.record(newAttempt({ questionId: 'b', day: '2026-09-20' }));
    await store.record(newAttempt({ questionId: 'c', day: '2026-09-20' }));
    expect((await store.attemptsByDay('2026-09-20')).map((r) => r.questionId)).toEqual(['b', 'c']);
    expect((await store.attemptsByDay('2026-08-01')).map((r) => r.questionId)).toEqual([]);
    expect((await store.allAttempts()).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('bestXpFor 取历史最佳；未答过的题为 0', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'q1', xp: 2, status: 'fail', day: '2026-09-19' }));
    await store.record(newAttempt({ questionId: 'q1', xp: 15, day: '2026-09-20' }));
    await store.record(newAttempt({ questionId: 'q1', xp: 2, status: 'fail', day: '2026-09-21' }));
    expect(await store.bestXpFor('q1')).toBe(15);
    expect(await store.bestXpFor('nope')).toBe(0);
  });

  it('bestByQuestion 同分时取更早那次（与 xp.bestPerQuestion 同口径，历史日不被后来重做抽走）', async () => {
    const store = open();
    await store.record(newAttempt({ questionId: 'q1', xp: 15, day: '2026-09-19' }));
    await store.record(newAttempt({ questionId: 'q1', xp: 15, day: '2026-09-25' }));
    await store.record(newAttempt({ questionId: 'q2', xp: 20, kind: 'grade', score: 10, maxScore: 10, day: '2026-09-19' }));
    const best = await store.bestByQuestion();
    expect([...best.keys()]).toEqual(['q1', 'q2']);
    expect(best.get('q1')!.day).toBe('2026-09-19');
    expect(best.get('q2')!.xp).toBe(20);
  });

  it('day 缺失时用注入时钟的本地日期兜底', async () => {
    const store = open(() => new Date('2026-09-19T23:30:00'));
    const row = await store.record({ ...newAttempt({ questionId: 'q-day' }), day: '' });
    expect(row.day).toBe(todayIso(new Date('2026-09-19T23:30:00')));
    expect((await store.attemptsByDay(todayIso(new Date('2026-09-19T23:30:00')))).map((r) => r.questionId)).toEqual(['q-day']);
  });

  it('mkdir 由 store 负责：db 文件在嵌套目录里也能创建', async () => {
    const nested = join(dir, 'deep', 'deeper', 'arena.db');
    const store = openProgressStore({ file: nested });
    stores.push(store);
    await store.record(newAttempt({ questionId: 'q-nested' }));
    expect((await store.allAttempts())).toHaveLength(1);
  });
});

describe('settings 表（计划缓存/奖励发放用）', () => {
  it('get/set/覆盖/删除，并且 asSettingsStore 能识别', async () => {
    const store = open();
    const settings = asSettingsStore(store);
    expect(settings).not.toBeNull();
    expect(await settings!.getSetting('missing')).toBeNull();
    await settings!.setSetting('plan:2026-09-19', JSON.stringify({ main: 'sql' }));
    expect(await settings!.getSetting('plan:2026-09-19')).toContain('sql');
    await settings!.setSetting('plan:2026-09-19', JSON.stringify({ main: 'big-data' }));
    expect(await settings!.getSetting('plan:2026-09-19')).toContain('big-data');
    await store.record(newAttempt({ questionId: 'q1' }));
    // 重启后 settings 仍在
    await store.close();
    const reopened = open();
    expect(await asSettingsStore(reopened)!.getSetting('plan:2026-09-19')).toContain('big-data');
    expect((await reopened.allAttempts()).map((r) => r.id)).toEqual([1]);
  });

  it('非 settings 能力的 store 返回 null（调用方须能降级）', () => {
    expect(asSettingsStore({ fake: true } as unknown as ProgressStore)).toBeNull();
  });
});
