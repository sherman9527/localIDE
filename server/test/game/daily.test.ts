import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORY_IDS, DAILY_PLAN, type CategoryId, type PublicQuestion } from '@arena/shared';
import { evaluatePlanProgress, isJudgeable, planForDay, practicePool } from '../../src/game/daily.js';
import { BareFakeStore, FakeBank, FakeStore, attemptOf, makeQuestion, newAttempt, seedQuestions, shiftDay } from './fixtures.js';

let bank: FakeBank;
let store: FakeStore;
let tmpDirs: string[] = [];

const dates = (start = '2026-09-19', n = 14) => Array.from({ length: n }, (_, i) => shiftDay(start, i));

beforeEach(() => {
  bank = new FakeBank(seedQuestions());
  store = new FakeStore();
});

afterEach(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs = [];
});

async function writeCurriculum(map: Record<string, { main: string; side: string }>): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'curriculum-'));
  tmpDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plan.json'), JSON.stringify(map), 'utf8');
  return dir;
}

const idsOf = (qs: PublicQuestion[]) => qs.map((q) => q.id);

describe('planForDay — 确定性（场景：同日重复请求题目一致）', () => {
  it('同一天两次调用结果 deep-equal', async () => {
    const a = await planForDay({ date: '2026-09-19', bank, store });
    const b = await planForDay({ date: '2026-09-19', bank, store });
    expect(b).toEqual(a);
  });

  it('没有 settings 能力的 store 也一样稳定（算法本身确定）', async () => {
    const bare = new BareFakeStore();
    const a = await planForDay({ date: '2026-09-21', bank, store: bare });
    const b = await planForDay({ date: '2026-09-21', bank, store: bare });
    expect(b).toEqual(a);
    expect(a.questions).toHaveLength(DAILY_PLAN.mainQuestions + DAILY_PLAN.sideQuestions);
  });

  it('跨天套餐类别与题目都会变化', async () => {
    const seenCategories = new Set<CategoryId>();
    let changed = 0;
    let prev: string | null = null;
    for (const date of dates()) {
      const { plan, questions } = await planForDay({ date, bank, store: new BareFakeStore() });
      const key = JSON.stringify({ plan, ids: idsOf(questions) });
      if (prev !== null && key !== prev) changed++;
      prev = key;
      seenCategories.add(plan.main.category);
    }
    expect(changed).toBeGreaterThan(8);
    expect(seenCategories.size).toBeGreaterThan(1);
  });

  it('套餐形态：主栈 2 道可判分题 + 副栈 1 道主观题，类别互不相同', async () => {
    for (const date of dates()) {
      const { plan, questions } = await planForDay({ date, bank, store });
      expect(plan.date).toBe(date);
      expect(questions).toHaveLength(plan.main.count + plan.side.count);
      expect(plan.main.count).toBe(DAILY_PLAN.mainQuestions);
      expect(plan.side.count).toBe(DAILY_PLAN.sideQuestions);
      expect(plan.main.category).not.toBe(plan.side.category);
      const main = questions.slice(0, plan.main.count);
      const side = questions.slice(plan.main.count);
      for (const q of main) {
        expect(q.category).toBe(plan.main.category);
        expect(isJudgeable(q)).toBe(true);
      }
      for (const q of side) {
        expect(q.category).toBe(plan.side.category);
        expect(isJudgeable(q)).toBe(false);
      }
    }
  });

  it('返回的是脱敏题（无 runner / answer，rubric 无 points 明细）', async () => {
    const { questions } = await planForDay({ date: '2026-09-19', bank, store });
    const raw = JSON.stringify(questions);
    expect(raw).not.toContain('referenceSolution');
    expect(raw).not.toContain('REFERENCE-SOLUTION-MUST-NEVER-LEAK');
    expect(raw).not.toContain('REFERENCE-ANSWER-MUST-NEVER-LEAK');
    for (const q of questions) {
      expect(q).not.toHaveProperty('runner');
      expect(q).not.toHaveProperty('answer');
      if (q.rubric) expect(q.rubric).not.toHaveProperty('points');
    }
  });
});

describe('planForDay — 软删除题必须不出现（需求 场景 10）', () => {
  it('被 hide 的题在任何一天都不进套餐，且候补池补足到约定题量', async () => {
    // 先确认这题在池子里（不排除全部日期都选它，只要求它"曾经可选"）
    const target = 'alg-java-0002';
    expect(await bank.byId(target)).toBeDefined();
    await bank.hide(target);
    for (const date of dates()) {
      const { questions } = await planForDay({ date, bank, store: new BareFakeStore() });
      expect(idsOf(questions)).not.toContain(target);
      expect(questions).toHaveLength(DAILY_PLAN.mainQuestions + DAILY_PLAN.sideQuestions);
      for (const q of questions) expect(bank.hidden.has(q.id)).toBe(false);
    }
  });

  it('命中缓存套餐后题目被 hide → 重新计算并补题（不再泄漏已删题）', async () => {
    const first = await planForDay({ date: '2026-10-05', bank, store });
    const victim = first.questions[0]!.id;
    await bank.hide(victim);
    const second = await planForDay({ date: '2026-10-05', bank, store });
    expect(idsOf(second.questions)).not.toContain(victim);
    expect(second.questions).toHaveLength(3);
    expect(second.plan.main.category).toBeDefined();
  });

  it('cache 与无 cache（bare store）在题库未变时给出同一套餐', async () => {
    const cached = await planForDay({ date: '2026-10-06', bank, store });
    const bare = await planForDay({ date: '2026-10-06', bank, store: new BareFakeStore() });
    expect(idsOf(bare.questions)).toEqual(idsOf(cached.questions));
    expect(bare.plan).toEqual(cached.plan);
  });
});

describe('planForDay — 30 天排课覆盖（content/curriculum/*.json）', () => {
  it('按排课覆盖主/副栈类别', async () => {
    const dir = await writeCurriculum({ '2026-10-01': { main: 'big-data', side: 'system-design' } });
    const { plan, questions } = await planForDay({ date: '2026-10-01', bank, store, curriculumDir: dir });
    expect(plan.main.category).toBe('big-data');
    expect(plan.side.category).toBe('system-design');
    expect(questions.slice(0, 2).map((q) => q.category)).toEqual(['big-data', 'big-data']);
    expect(questions.slice(0, 2).every(isJudgeable)).toBe(true);
    expect(questions[2]!.category).toBe('system-design');
    // 排课日同样确定性（没有到期复习时 reviewIds 恒为空）
    const again = await planForDay({ date: '2026-10-01', bank, store, curriculumDir: dir });
    expect(again).toEqual({ plan, questions, reviewIds: [] });
  });

  it('认得 scripts/curriculum.mjs 真正写出的形状（days 是数组，不是日期映射）', async () => {
    const dir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'curriculum-array-'));
    tmpDirs.push(dir);
    await writeFile(
      join(dir, '2026-10.json'),
      JSON.stringify({
        version: 1,
        month: '2026-10',
        days: [
          { date: '2026-10-01', main: 'sql', side: 'system-design', mainPicks: [], sidePicks: [] },
          { date: '2026-10-02', main: 'big-data', side: 'agent-design', mainPicks: [], sidePicks: [] },
        ],
      }),
      'utf8',
    );
    const first = await planForDay({ date: '2026-10-01', bank, store, curriculumDir: dir });
    expect(first.plan.main.category).toBe('sql');
    expect(first.plan.side.category).toBe('system-design');
    const second = await planForDay({ date: '2026-10-02', bank, store, curriculumDir: dir });
    expect(second.plan.main.category).toBe('big-data');
    expect(second.plan.side.category).toBe('agent-design');
  });

  it('仓库里真实排课文件可解析（≥25 天），且每天的计划就是文件里写的那一行', async () => {
    const curriculumDir = join(process.cwd(), 'content', 'curriculum');
    const raw = JSON.parse(await readFile(join(curriculumDir, '2026-10.json'), 'utf8')) as {
      days: { date: string; main: string; side: string }[];
    };
    expect(raw.days.length, '排课天数不足 —— curriculum.mjs 没跑或跑崩了').toBeGreaterThanOrEqual(25);

    // 期望值**从文件里读**，绝不写死某一天的类别：加题之后重跑 `node scripts/curriculum.mjs`
    // 会整月重排（题库一变，配比分配就变），写死的那一天会在**正确操作**上报红。
    // 这里仍然防住"排课静默失效"：解析不出来就会走日期算法兜底，抽样的 5 天里几乎不可能全撞上。
    for (const day of raw.days.filter((_, i) => i % 7 === 0)) {
      const { plan } = await planForDay({ date: day.date, bank, store, curriculumDir });
      expect(plan.main.category, `${day.date} 主栈应取排课的 ${day.main}，拿到别的值=排课没生效`).toBe(day.main);
      expect(plan.side.category, `${day.date} 副栈应取排课的 ${day.side}，拿到别的值=排课没生效`).toBe(day.side);
    }
  });

  it('排课指定的主栈无可判分题时回落，不崩', async () => {
    const dir = await writeCurriculum({ '2026-10-02': { main: 'system-design', side: 'agent-design' } });
    const { plan, questions } = await planForDay({ date: '2026-10-02', bank, store, curriculumDir: dir });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.slice(0, plan.main.count).every(isJudgeable)).toBe(true);
    expect(plan.main.category).not.toBe(plan.side.category);
    expect(CATEGORY_IDS).toContain(plan.main.category);
  });

  it('排课文件损坏时忽略并继续按算法选题', async () => {
    const dir = await writeCurriculum({});
    await writeFile(join(dir, 'broken.json'), '{ nope', 'utf8');
    await writeFile(join(dir, 'plan.json'), JSON.stringify({ '2026-10-03': { main: 'sql', side: 'agent-design' } }), 'utf8');
    const { plan } = await planForDay({ date: '2026-10-03', bank, store, curriculumDir: dir });
    expect(plan.main.category).toBe('sql');
    expect(plan.side.category).toBe('agent-design');
  });

  it('没有 curriculum 目录时正常工作', async () => {
    const { plan } = await planForDay({ date: '2026-10-04', bank, store, curriculumDir: join(process.cwd(), 'data', 'test-tmp', 'missing-dir') });
    expect(CATEGORY_IDS).toContain(plan.main.category);
  });
});

describe('planForDay — 题库稀疏时的降级', () => {
  it('只剩 1 道可判分题时主栈只给 1 道，主观题仍来自别的类别', async () => {
    const thin = new FakeBank([
      makeQuestion({ id: 'alg-java-9001', category: 'algorithms', judgeKind: 'java-junit' }),
      makeQuestion({ id: 'sd-rub-9001', category: 'system-design', judgeKind: 'llm-rubric' }),
    ]);
    const { plan, questions } = await planForDay({ date: '2026-11-01', bank: thin, store });
    expect(plan.main.count).toBe(1);
    expect(plan.side.count).toBe(1);
    expect(idsOf(questions)).toEqual(['alg-java-9001', 'sd-rub-9001']);
  });

  it('完全没有主观题时只返回主栈', async () => {
    const onlyCode = new FakeBank([
      makeQuestion({ id: 'alg-java-9002', category: 'algorithms', judgeKind: 'java-junit' }),
      makeQuestion({ id: 'alg-java-9003', category: 'algorithms', judgeKind: 'java-junit' }),
    ]);
    const { plan, questions } = await planForDay({ date: '2026-11-02', bank: onlyCode, store });
    expect(plan.side.count).toBe(0);
    expect(questions).toHaveLength(2);
  });
});

describe('practicePool — 选栈练习池不改变套餐', () => {
  it('返回指定类别的题且全部脱敏、稳定', async () => {
    const a = await practicePool({ date: '2026-09-19', category: 'sql', bank, store });
    const b = await practicePool({ date: '2026-09-19', category: 'sql', bank, store });
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
    for (const q of a) expect(q.category).toBe('sql');
    expect(JSON.stringify(a)).not.toContain('referenceSolution');
    const plan = await planForDay({ date: '2026-09-19', bank, store });
    expect(idsOf(a).length).toBeGreaterThan(0);
    expect(plan.plan).toBeDefined();
  });

  it('不含被 hide 的题；类别无题时返回空数组', async () => {
    await bank.hide('sql-mysql-0001');
    const pool = await practicePool({ date: '2026-09-19', category: 'sql', bank, store });
    expect(idsOf(pool)).not.toContain('sql-mysql-0001');
    const empty = await practicePool({ date: '2026-09-19', category: 'hot-interviews', bank: new FakeBank([]), store });
    expect(empty).toEqual([]);
  });
});

describe('evaluatePlanProgress — 完成判定只看套餐内 3 题', () => {
  const plan = {
    date: '2026-09-19',
    main: { category: 'sql' as CategoryId, count: 2, reason: 'default' as const },
    side: { category: 'system-design' as CategoryId, count: 1 },
  };
  const questions = [
    { id: 'q1' },
    { id: 'q2' },
    { id: 'q3' },
  ] as unknown as PublicQuestion[];

  it('空作答 → 未完成', () => {
    expect(evaluatePlanProgress(plan, questions, [])).toEqual({ answered: [], passed: [], done: false });
  });

  it('套餐外自由练习不影响完成态', () => {
    const attempts = [attemptOf({ questionId: 'other-1', day: '2026-09-19', status: 'pass' })];
    expect(evaluatePlanProgress(plan, questions, attempts)).toEqual({ answered: [], passed: [], done: false });
  });

  it('三题都通过 → done', () => {
    const attempts = ['q1', 'q2', 'q3'].flatMap((id, i) => [
      attemptOf({ questionId: id, day: '2026-09-19', status: 'fail', xp: 2, passed: 0, failed: 1, createdAt: `2026-09-19T0${i}:00:00.000Z` }),
      attemptOf({ questionId: id, day: '2026-09-19', status: 'pass', createdAt: `2026-09-19T1${i}:00:00.000Z` }),
    ]);
    expect(evaluatePlanProgress(plan, questions, attempts)).toEqual({ answered: ['q1', 'q2', 'q3'], passed: ['q1', 'q2', 'q3'], done: true });
  });

  it('只答 2 题 → 未完成', () => {
    const attempts = ['q1', 'q2'].map((id) => attemptOf({ questionId: id, day: '2026-09-19' }));
    const res = evaluatePlanProgress(plan, questions, attempts);
    expect(res.answered).toEqual(['q1', 'q2']);
    expect(res.done).toBe(false);
  });

  it('昨天的 pass 不算今天', () => {
    const attempts = ['q1', 'q2', 'q3'].map((id) => attemptOf({ questionId: id, day: '2026-09-18' }));
    expect(evaluatePlanProgress(plan, questions, attempts).done).toBe(false);
  });
});

describe('planForDay — 到期复习插入（WI-41）', () => {
  const entry = (due: string, reps = 0) => ({ reps, due, last: 'fail' as const, lastDay: '2026-09-01' });

  async function storeWith(entries: Record<string, ReturnType<typeof entry>>): Promise<FakeStore> {
    const s = new FakeStore();
    await s.setSetting('review:book', JSON.stringify({ entries }));
    return s;
  }

  it('只有"到期日 <= 今天"的题才会被排进来', async () => {
    const before = await planForDay({ date: '2026-09-19', bank, store });
    const dueId = bank.questions.find(
      (q) => q.category === before.plan.main.category && isJudgeable(q) && !before.questions.some((p) => p.id === q.id),
    )!.id;

    const future = new FakeStore();
    await future.setSetting('review:book', JSON.stringify({ entries: { [dueId]: entry('2026-09-25') } }));
    const notYet = await planForDay({ date: '2026-09-19', bank, store: future });
    expect(notYet.reviewIds).toEqual([]);
    expect(idsOf(notYet.questions)).toEqual(idsOf(before.questions));

    const today = new FakeStore();
    await today.setSetting('review:book', JSON.stringify({ entries: { [dueId]: entry('2026-09-19') } }));
    const scheduled = await planForDay({ date: '2026-09-19', bank, store: today });
    expect(scheduled.reviewIds).toEqual([dueId]);
  });

  it('代码题到期 → 顶掉主栈最后一题的"新题"名额，槽位数与总题数都不变', async () => {
    const before = await planForDay({ date: '2026-09-19', bank, store });
    const mainCategory = before.plan.main.category;
    const dueId = bank.questions.find((q) => q.category === mainCategory && !before.questions.some((p) => p.id === q.id))!.id;

    const store2 = new FakeStore();
    await store2.setSetting('review:book', JSON.stringify({ entries: { [dueId]: entry('2026-09-19') } }));
    const after = await planForDay({ date: '2026-09-19', bank, store: store2 });

    expect(after.reviewIds).toEqual([dueId]);
    expect(after.questions).toHaveLength(DAILY_PLAN.mainQuestions + DAILY_PLAN.sideQuestions);
    expect(idsOf(after.questions)).toContain(dueId);
    // "每天 3 题"的承诺不变：复习是换掉一道新题，不是加菜，也不是减餐
    expect(after.plan.main.count).toBe(DAILY_PLAN.mainQuestions);
    expect(after.plan.side.count).toBe(DAILY_PLAN.sideQuestions);
    expect(idsOf(after.questions).slice(0, after.plan.main.count)).toContain(dueId);
  });

  it('主观题到期 → 占副栈那个槽位，主栈不动', async () => {
    const before = await planForDay({ date: '2026-09-19', bank, store });
    const dueId = bank.questions.find(
      (q) => q.judgeKind === 'llm-rubric' && !before.questions.some((p) => p.id === q.id),
    )!.id;
    const store2 = new FakeStore();
    await store2.setSetting('review:book', JSON.stringify({ entries: { [dueId]: entry('2026-09-19') } }));

    const after = await planForDay({ date: '2026-09-19', bank, store: store2 });
    expect(after.reviewIds).toEqual([dueId]);
    expect(after.plan.main.count).toBe(DAILY_PLAN.mainQuestions);
    expect(after.plan.side.count).toBe(DAILY_PLAN.sideQuestions);
    expect(idsOf(after.questions)).toContain(dueId);
    expect(idsOf(after.questions).slice(after.plan.main.count)).toEqual([dueId]);
  });

  it('同日到期多题 → 优先今天主栈类别里的那道', async () => {
    const before = await planForDay({ date: '2026-09-21', bank, store });
    const mainCategory = before.plan.main.category;
    const inMain = bank.questions.find((q) => q.category === mainCategory && isJudgeable(q) && !before.questions.some((p) => p.id === q.id))!.id;
    const elsewhere = bank.questions.find((q) => q.category !== mainCategory && isJudgeable(q))!.id;
    const store2 = new FakeStore();
    await store2.setSetting('review:book', JSON.stringify({ entries: { [elsewhere]: entry('2026-09-20'), [inMain]: entry('2026-09-20') } }));

    const after = await planForDay({ date: '2026-09-21', bank, store: store2 });
    expect(after.reviewIds).toEqual([inMain]);
  });

  it('到期题已被移除 → 不排它，套餐照旧', async () => {
    const before = await planForDay({ date: '2026-09-19', bank, store });
    const gone = 'alg-java-0006';
    await bank.hide(gone);
    const store2 = new FakeStore();
    await store2.setSetting('review:book', JSON.stringify({ entries: { [gone]: entry('2026-09-19') } }));
    const after = await planForDay({ date: '2026-09-19', bank, store: store2 });
    expect(after.reviewIds).toEqual([]);
    expect(idsOf(after.questions)).toEqual(idsOf(before.questions));
  });

  it('到期题恰好是今天已选中的新题 → 不重复占位、也不顶掉自己', async () => {
    const before = await planForDay({ date: '2026-09-19', bank, store });
    const already = before.questions[0]!.id;
    const store2 = new FakeStore();
    await store2.setSetting('review:book', JSON.stringify({ entries: { [already]: entry('2026-09-19') } }));
    const after = await planForDay({ date: '2026-09-19', bank, store: store2 });
    expect(after.reviewIds).toEqual([]);
    expect(after.plan.main.count).toBe(DAILY_PLAN.mainQuestions);
    expect(idsOf(after.questions)).toEqual(idsOf(before.questions));
  });

  it('store 没有 settings 能力 → 不排复习也不炸', async () => {
    const bare = new BareFakeStore();
    const res = await planForDay({ date: '2026-09-19', bank, store: bare });
    expect(res.reviewIds).toEqual([]);
    expect(res.questions).toHaveLength(DAILY_PLAN.mainQuestions + DAILY_PLAN.sideQuestions);
  });

  it('复习也进当日缓存：同日两次调用 deep-equal，复习题被移除后重算', async () => {
    const before = await planForDay({ date: '2026-09-22', bank, store });
    const dueId = bank.questions.find(
      (q) => q.category === before.plan.main.category && isJudgeable(q) && !before.questions.some((p) => p.id === q.id),
    )!.id;
    const s = await storeWith({ [dueId]: entry('2026-09-22') });

    const first = await planForDay({ date: '2026-09-22', bank, store: s });
    const second = await planForDay({ date: '2026-09-22', bank, store: s });
    expect(first.reviewIds).toEqual([dueId]);
    expect(second).toEqual(first);

    await bank.hide(dueId);
    const third = await planForDay({ date: '2026-09-22', bank, store: s });
    expect(third.reviewIds).toEqual([]);
    expect(idsOf(third.questions)).not.toContain(dueId);
  });
});

describe('planForDay — 难度自适应接线（N-01）', () => {
  async function storeWith(day: string, xp: number, status: 'pass' | 'fail', n: number): Promise<FakeStore> {
    const s = new FakeStore();
    for (let i = 0; i < n; i++) {
      await s.record(
        newAttempt({
          questionId: `alg-java-000${i + 1}`,
          category: 'algorithms',
          day,
          status,
          xp,
          passed: status === 'pass' ? 1 : 0,
          failed: status === 'pass' ? 0 : 1,
        }),
      );
    }
    return s;
  }

  it('近 7 天全对且该类别题够 → 主栈加到 3 题并带上理由', async () => {
    const dir = await writeCurriculum({ '2026-10-05': { main: 'algorithms', side: 'system-design' } });
    const res = await planForDay({ date: '2026-10-05', bank, store: await storeWith('2026-10-01', 15, 'pass', 6), curriculumDir: dir });
    expect(res.plan.main).toMatchObject({ category: 'algorithms', count: 3, reason: 'adaptive-high' });
    expect(res.questions.filter((q) => q.category === 'algorithms')).toHaveLength(3);
  });

  it('近 7 天大多做错 → 主栈降到 1 题', async () => {
    const dir = await writeCurriculum({ '2026-10-05': { main: 'algorithms', side: 'system-design' } });
    const res = await planForDay({ date: '2026-10-05', bank, store: await storeWith('2026-10-01', 2, 'fail', 6), curriculumDir: dir });
    expect(res.plan.main).toMatchObject({ count: 1, reason: 'adaptive-low' });
  });

  it('题量口径进了当日缓存：同一天第二次调用理由与题数都不变', async () => {
    const dir = await writeCurriculum({ '2026-10-06': { main: 'algorithms', side: 'system-design' } });
    const s = await storeWith('2026-10-02', 15, 'pass', 6);
    const first = await planForDay({ date: '2026-10-06', bank, store: s, curriculumDir: dir });
    expect(first.plan.main.reason).toBe('adaptive-high');
    // 之后就算做错一堆，今天也不该改口（否则进度条会自己缩）
    await storeWith('2026-10-06', 2, 'fail', 3).then(async (extra) => {
      for (const row of await extra.allAttempts()) await s.record(row);
    });
    const again = await planForDay({ date: '2026-10-06', bank, store: s, curriculumDir: dir });
    expect(again.plan.main).toEqual(first.plan.main);
    expect(again.questions.map((q) => q.id)).toEqual(first.questions.map((q) => q.id));
  });

  it('主栈类别题不够时不加量（自适应不能变出没有的题）', async () => {
    // 把 sql 的可判分题削到 2 道（只剩 redis 两道）：主栈仍是 sql，但"加到 3 题"物理做不到
    const small = new FakeBank(seedQuestions().filter((q) => !(q.category === 'sql' && q.judgeKind === 'mysql')));
    const dir = await writeCurriculum({ '2026-10-07': { main: 'sql', side: 'system-design' } });
    const res = await planForDay({ date: '2026-10-07', bank: small, store: await storeWith('2026-10-03', 15, 'pass', 6), curriculumDir: dir });
    expect(res.plan.main.category).toBe('sql');
    expect(res.plan.main.count).toBe(2);
    expect(res.plan.main.reason).not.toBe('adaptive-high');
  });
});
