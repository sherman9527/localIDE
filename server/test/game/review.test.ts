import { describe, expect, it } from 'vitest';
import { BareFakeStore, FakeStore } from './fixtures.js';
import { daysBetween } from '@arena/shared';
import type { AttemptRow } from '../../src/ports.js';
import { REVIEW_LADDER, REVIEW_TOP_STEP } from '@arena/shared';
import {
  advanceEntry,
  applyAttempt,
  bookStats,
  loadBook,
  dueIds,
  parseBook,
  recordAttempt,
  seedBook,
  serializeBook,
  type ReviewBook,
} from '../../src/game/review.js';

/**
 * 复习排期（WI-41）。这一层刻意做成纯函数：给定"今天"和"这次对没对"就能算出下次到期，
 * 所以跨天/升降档这些最容易出错的地方都能在这里钉死，不必等真过一天。
 */

const TODAY = '2026-09-20';

const attempt = (over: Partial<AttemptRow> & { questionId: string }): AttemptRow => ({
  id: 1,
  category: 'algorithms',
  kind: 'judge',
  status: 'pass',
  score: null,
  maxScore: null,
  xp: 15,
  passed: 1,
  failed: 0,
  durationMs: 1000,
  createdAt: `${over.day ?? TODAY}T09:00:00.000Z`,
  day: TODAY,
  ...over,
});

describe('advanceEntry — SM-2 的二值退化', () => {
  it('没在册且这次对了 → 不入本（复习只服务"错过的题"）', () => {
    expect(advanceEntry(undefined, { passed: true, today: TODAY })).toBeNull();
  });

  it('没在册且这次错了 → 入本，明天第一次复习', () => {
    const next = advanceEntry(undefined, { passed: false, today: TODAY });
    expect(next).toMatchObject({ reps: 0, last: 'fail', lastDay: TODAY, due: '2026-09-21' });
  });

  it('连续两次 pass 才升档：第一次 pass 只是"回到同一档再来一遍"', () => {
    const failed = advanceEntry(undefined, { passed: false, today: TODAY })!;
    const firstPass = advanceEntry(failed, { passed: true, today: '2026-09-21' })!;
    expect(firstPass.reps).toBe(0);
    expect(firstPass.due).toBe('2026-09-22'); // 仍是第 0 档（1 天）
    const secondPass = advanceEntry(firstPass, { passed: true, today: '2026-09-22' })!;
    expect(secondPass.reps).toBe(1);
    expect(secondPass.due).toBe('2026-09-25'); // 第 1 档（3 天）
  });

  it('一旦答错就跌回第 0 档（明天再来），不保留之前的进度', () => {
    const advanced = advanceEntry({ reps: 4, due: '2026-10-20', last: 'pass', lastDay: TODAY }, { passed: false, today: TODAY })!;
    expect(advanced).toMatchObject({ reps: 0, last: 'fail', due: '2026-09-21' });
  });

  it('档位到顶之后停在最后一档，不会越界', () => {
    let entry = advanceEntry(undefined, { passed: false, today: TODAY })!;
    for (let i = 0; i < REVIEW_LADDER.length + 3; i++) {
      entry = advanceEntry(entry, { passed: true, today: entry.due })!;
    }
    expect(entry.reps).toBe(REVIEW_LADDER.length - 1);
    const again = advanceEntry(entry, { passed: true, today: entry.due })!;
    expect(daysBetween(again.lastDay, again.due)).toBe(REVIEW_TOP_STEP);
  });
});

describe('recordAttempt / dueIds / stats', () => {
  const book: ReviewBook = {
    entries: {
      'alg-java-0001': { reps: 0, due: '2026-09-19', last: 'fail', lastDay: '2026-09-18' },
      'sql-mysql-0002': { reps: 1, due: TODAY, last: 'fail', lastDay: '2026-09-17' },
      'bd-py-0001': { reps: 2, due: '2026-09-18', last: 'fail', lastDay: '2026-09-10' },
      'fe-ts-0001': { reps: 3, due: '2026-10-30', last: 'pass', lastDay: '2026-09-19' },
    },
  };

  it('到期判定含"今天"，且排序稳定（先按到期日再按 id，同日也有确定顺序）', () => {
    expect(dueIds(book, TODAY)).toEqual(['bd-py-0001', 'alg-java-0001', 'sql-mysql-0002']);
    expect(dueIds(book, '2026-09-18')).toEqual(['bd-py-0001']);
    expect(dueIds({ entries: {} }, TODAY)).toEqual([]);
  });

  it('统计卡片要的三个数：在册 / 今日到期 / 最久没碰', () => {
    expect(bookStats(book, TODAY)).toEqual({ tracked: 4, dueToday: 3, oldestDays: 10 });
    expect(bookStats({ entries: {} }, TODAY)).toEqual({ tracked: 0, dueToday: 0, oldestDays: null });
  });

  it('recordAttempt 不改原 book（纯函数，防止排期被就地改写）', () => {
    const snapshot = JSON.stringify(book);
    const next = recordAttempt(book, { questionId: 'alg-java-0001', passed: true, today: TODAY });
    expect(JSON.stringify(book)).toBe(snapshot);
    expect(next.entries['alg-java-0001']!.last).toBe('pass');
    expect(next).not.toBe(book);
  });

  it('答错过的题被做对到顶之后仍在册，只是间隔拉到最长', () => {
    let b: ReviewBook = { entries: {} };
    b = recordAttempt(b, { questionId: 'q', passed: false, today: TODAY });
    for (let i = 0; i < 12; i++) {
      const due = b.entries['q']!.due;
      b = recordAttempt(b, { questionId: 'q', passed: true, today: due });
    }
    expect(b.entries['q']!.reps).toBe(REVIEW_LADDER.length - 1);
    expect(dueIds(b, b.entries['q']!.due)).toEqual(['q']);
  });
});

describe('parseBook / serializeBook — 存量数据坏掉时不许把整个游戏层带崩', () => {
  it('null、空串、坏 JSON、形状不对一律退回空本', () => {
    for (const raw of [null, undefined, '', '   ', '{', 'not json', '[]', '"a"', '{"entries":null}']) {
      expect(parseBook(raw as string | null)).toEqual({ entries: {} });
    }
  });

  it('逐条校验：坏条目丢掉、好条目留下，多余字段忽略', () => {
    const raw = JSON.stringify({
      seededAt: '2026-09-19T00:00:00.000Z',
      entries: {
        good: { reps: 2, due: '2026-09-25', last: 'pass', lastDay: '2026-09-20', extra: 1 },
        badReps: { reps: 'x', due: '2026-09-25', last: 'pass', lastDay: '2026-09-20' },
        badDate: { reps: 1, due: '2026-9-25', last: 'pass', lastDay: '2026-09-20' },
        badLast: { reps: 1, due: '2026-09-25', last: 'maybe', lastDay: '2026-09-20' },
      },
    });
    const book = parseBook(raw);
    expect(book.seededAt).toBe('2026-09-19T00:00:00.000Z');
    expect(Object.keys(book.entries)).toEqual(['good']);
    expect(book.entries['good']).toEqual({ reps: 2, due: '2026-09-25', last: 'pass', lastDay: '2026-09-20' });
    expect(serializeBook(book)).toContain('"good"');
  });

  it('往返一致：serialize → parse 不丢排期', () => {
    const book: ReviewBook = { seededAt: 'x', entries: { a: { reps: 1, due: '2026-09-21', last: 'fail', lastDay: TODAY } } };
    expect(parseBook(serializeBook(book))).toEqual(book);
  });
});

describe('seedBook — 从历史 attempts 回填一次（老数据不该白记）', () => {
  it('每题只看最后一次"真判过"的作答：pass 不入本，fail/error 入本并排到次日', () => {
    const attempts: AttemptRow[] = [
      attempt({ questionId: 'a', status: 'fail', day: '2026-09-10' }),
      attempt({ questionId: 'a', status: 'pass', day: '2026-09-12' }), // 后来做对了
      attempt({ questionId: 'b', status: 'error', day: '2026-09-11' }),
      attempt({ questionId: 'd', status: 'pass', day: '2026-09-08' }),
    ];
    const book = seedBook(attempts, TODAY);
    expect(Object.keys(book.entries)).toEqual(['b']);
    expect(book.entries['b']).toMatchObject({ reps: 0, last: 'fail', lastDay: '2026-09-11', due: '2026-09-12' });
    expect(book.seededAt).toBeTruthy();
  });

  it('needs_human 是"没人判过"，不算错题：跳过它，回看上一次真判过的结果', () => {
    const attempts: AttemptRow[] = [
      attempt({ questionId: 'wrong-then-broken', status: 'fail', day: '2026-09-10' }),
      attempt({ questionId: 'wrong-then-broken', status: 'needs_human', kind: 'grade', day: '2026-09-14' }),
      attempt({ questionId: 'right-then-broken', status: 'pass', day: '2026-09-11' }),
      attempt({ questionId: 'right-then-broken', status: 'needs_human', kind: 'grade', day: '2026-09-15' }),
      attempt({ questionId: 'only-broken', status: 'needs_human', kind: 'grade', day: '2026-09-16' }),
    ];
    const book = seedBook(attempts, TODAY);
    expect(Object.keys(book.entries)).toEqual(['wrong-then-broken']);
  });

  it('回填是幂等的：同一批 attempts 再算一次结果相同', () => {
    const attempts = [attempt({ questionId: 'x', status: 'fail', day: '2026-09-15' })];
    expect(seedBook(attempts, TODAY, 'seeded')).toEqual(seedBook(attempts, TODAY, 'seeded'));
  });

  it('同一天到期的多题按 id 定序（否则"今天复习哪道"会随对象键顺序漂）', () => {
    const b: ReviewBook = {
      entries: {
        'z-题': { reps: 0, due: TODAY, last: 'fail', lastDay: '2026-09-19' },
        'a-题': { reps: 0, due: TODAY, last: 'fail', lastDay: '2026-09-19' },
        'm-题': { reps: 1, due: '2026-09-18', last: 'fail', lastDay: '2026-09-17' },
      },
    };
    expect(dueIds(b, TODAY)).toEqual(['m-题', 'a-题', 'z-题']);
  });

  it('空历史 → 空本但仍标记已回填（避免每次请求重算）', () => {
    expect(seedBook([], TODAY)).toEqual({ seededAt: expect.any(String), entries: {} });
  });
});

describe('loadBook / applyAttempt — 与 store 的往返（判分之后排期要真落盘）', () => {
  it('判分结果写回排期：答对升档、答错明天再来', async () => {
    const store = new FakeStore();
    let book = await loadBook(store, TODAY);
    expect(book.entries).toEqual({});

    book = (await applyAttempt(store, { questionId: 'q1', passed: false, today: TODAY }))!;
    expect(book.entries['q1']).toMatchObject({ reps: 0, last: 'fail', due: '2026-09-21' });
    expect(dueIds(await loadBook(store, '2026-09-21'), '2026-09-21')).toEqual(['q1']);

    book = (await applyAttempt(store, { questionId: 'q1', passed: true, today: '2026-09-21' }))!;
    expect(book.entries['q1']).toMatchObject({ reps: 0, last: 'pass', due: '2026-09-22' });
    book = (await applyAttempt(store, { questionId: 'q1', passed: true, today: '2026-09-22' }))!;
    expect(book.entries['q1']).toMatchObject({ reps: 1, due: '2026-09-25' });
  });

  it('一次做对不出库（可能只是运气），只把到期日往后推一档', async () => {
    const store = new FakeStore();
    await applyAttempt(store, { questionId: 'q2', passed: false, today: TODAY });
    let book = await loadBook(store, TODAY);
    expect(Object.keys(book.entries)).toEqual(['q2']);
    book = (await applyAttempt(store, { questionId: 'q2', passed: true, today: TODAY }))!;
    expect(book.entries['q2']).toMatchObject({ reps: 0, last: 'pass', due: '2026-09-21' });
  });

  it('第一次读会把历史里的错题回填进来，并且只回填一次', async () => {
    const store = new FakeStore();
    await store.record(attempt({ questionId: 'old-fail', status: 'fail', day: '2026-09-10' }));
    await store.record(attempt({ questionId: 'old-pass', status: 'pass', day: '2026-09-11' }));

    const book = await loadBook(store, TODAY);
    expect(Object.keys(book.entries)).toEqual(['old-fail']);
    expect(book.entries['old-fail']).toMatchObject({ due: '2026-09-11', lastDay: '2026-09-10' });
    expect(book.seededAt).toBeTruthy();

    // 之后新答错的题不该被回填逻辑覆盖
    await applyAttempt(store, { questionId: 'new-fail', passed: false, today: TODAY });
    const again = await loadBook(store, TODAY);
    expect(Object.keys(again.entries).sort()).toEqual(['new-fail', 'old-fail']);
  });

  it('store 没有 settings 能力 → 读写都静默降级（复习是加分项，不能卡住判分主流程）', async () => {
    const bare = new BareFakeStore();
    await bare.record(attempt({ questionId: 'x', status: 'fail', day: '2026-09-10' }));
    expect(await loadBook(bare, TODAY)).toEqual({ entries: {} });
    expect(await applyAttempt(bare, { questionId: 'x', passed: false, today: TODAY })).toBeNull();
  });

  it('settings 里是坏数据 → 退回空本而不是把 /api/judge 带崩', async () => {
    const store = new FakeStore();
    await store.setSetting('review:book', '{oops');
    expect(await loadBook(store, TODAY)).toEqual({ entries: {} });
    const after = await applyAttempt(store, { questionId: 'y', passed: false, today: TODAY });
    expect(Object.keys(after!.entries)).toEqual(['y']);
  });
});
