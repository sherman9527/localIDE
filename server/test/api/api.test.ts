import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  CATEGORY_IDS,
  TAG_FACET_MIN_COUNT,
  type AttemptsResponse,
  type BankResponse,
  type CategoriesResponse,
  type GradePostResponse,
  type HideResponse,
  type JudgeEvent,
  type JudgeKind,
  type JudgePostResponse,
  type JudgeRequest,
  type JudgeResult,
  type ProgressResponse,
  type Question,
  type QuestionDetailResponse,
  type RubricVerdict,
  type StackHealth,
  type TodayResponse,
} from '@arena/shared';
import type { BankPort, Clock, GradePort, JudgePort, ProgressStore } from '../../src/ports.js';
import type {
  DebugSessionsResponse,
  DebugStartResponse,
  DebugStepResponse,
  DebugStopResponse,
  IdeLanguagesResponse,
  ReplFeedResponse,
  ReplSessionsResponse,
  ReplStartResponse,
  ReplStopResponse,
} from '@arena/shared';
import { findLanguage } from '../../src/ide/languages.js';
import { buildApp } from '../../src/api/app.js';
import { BareFakeStore, FakeBank, FakeStore, REFERENCE_ANSWER_MARKER, REFERENCE_SOLUTION_MARKER, fixedClock, newAttempt, seedQuestions } from '../game/fixtures.js';
import { parseBook } from '../../src/game/review.js';

/** 内存假 judge：只通过 JudgePort 相遇，绝不 import 真实判题实现（Task 6/7 由他人交付）。 */
class FakeJudge implements JudgePort {
  calls: JudgeRequest[] = [];
  result: JudgeResult = {
    status: 'pass',
    passed: 3,
    failed: 0,
    total: 3,
    failedCases: [],
    passedCases: ['空输入返回空结果', '重复事件只处理一次', '乱序事件按键聚合'],
    durationMs: 1234,
  };
  available = new Set<JudgeKind>(['java-junit', 'mysql', 'react-vitest', 'pyspark']);
  throws = false;

  async run(req: JudgeRequest, _question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> {
    this.calls.push(req);
    onEvent?.({ type: 'progress', phase: 'compile', elapsedMs: 40, timeoutMs: 20_000 });
    await new Promise((r) => setTimeout(r, 5));
    onEvent?.({ type: 'log', line: '[junit] 3 tests found' });
    await new Promise((r) => setTimeout(r, 5));
    onEvent?.({ type: 'progress', phase: 'collect', elapsedMs: 1200, timeoutMs: 20_000 });
    if (this.throws) throw new Error('judge exploded');
    // 真实 registry 会把 traceId 回写到结果里，假判题器照做，才能测出"链路断在 app 层"
    return req.traceId ? { ...this.result, traceId: req.traceId } : this.result;
  }
  async probe(kind: JudgeKind): Promise<boolean> {
    if (kind === 'spark-scala') throw new Error('probe exploded');
    return this.available.has(kind);
  }
}

class FakeGrade implements GradePort {
  verdict: RubricVerdict = {
    score: 8,
    maxScore: 10,
    bonus: ['提到指数退避'],
    gaps: ['没讲重放幂等键'],
    rubricBreakdown: [
      { label: '指出背压与退避的取舍', hit: true, earned: 6 },
      { label: '给出可观测的失败处理', hit: true, earned: 2, nextStep: '补一句重放策略' },
    ],
    provider: 'qodercli',
    durationMs: 900,
    raw: '{}',
  };
  calls = 0;
  /** 评分链是否可用（判题器与它是两条独立通路，互不影响） */
  canGrade = true;
  lastTraceId: string | undefined;
  async available(): Promise<boolean> {
    return this.canGrade;
  }
  async grade(_question: Question, _answer: string, traceId?: string): Promise<RubricVerdict> {
    this.calls++;
    this.lastTraceId = traceId;
    return this.verdict;
  }
}

let app: FastifyInstance;
let bank: BankPort & FakeBank;
let store: FakeStore & ProgressStore;
let judge: FakeJudge;
let grade: FakeGrade;
const clock: Clock = fixedClock('2026-09-19');

async function ok<T>(res: { statusCode: number; json: () => unknown }): Promise<T> {
  expect(res.statusCode).toBeLessThan(400);
  return res.json() as T;
}

beforeEach(async () => {
  bank = new FakeBank(seedQuestions());
  store = new FakeStore();
  judge = new FakeJudge();
  grade = new FakeGrade();
  app = await buildApp({ judge, grade, bank, store, clock });
});

afterEach(async () => {
  await app.close();
});

const allQuestions = () => bank.questions;
const codeQuestions = () => allQuestions().filter((q) => q.judgeKind !== 'llm-rubric');
const rubricQuestion = () => allQuestions().find((q) => q.judgeKind === 'llm-rubric')!;
const today = async () => ok<TodayResponse>(await app.inject({ method: 'GET', url: '/api/challenge/today' }));

/** 答案不泄漏（rule.md C7）的统一断言。 */
function expectNoAnswerLeak(body: string, { allowRubricPoints = false }: { allowRubricPoints?: boolean } = {}) {
  expect(body).not.toContain('referenceSolution');
  expect(body).not.toContain(REFERENCE_SOLUTION_MARKER);
  expect(body).not.toContain(REFERENCE_ANSWER_MARKER);
  expect(body).not.toContain('"answer"');
  if (!allowRubricPoints) {
    expect(body).not.toContain('"criteria"');
    expect(body).not.toMatch(/"points"\s*:/);
  }
}

describe('GET /api/health', () => {
  it('并发探测各栈，不可用/探测抛错的栈标成 false（不 500）', async () => {
    const body = await ok<StackHealth>(await app.inject({ method: 'GET', url: '/api/health' }));
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.stacks['java-junit']).toBe(true);
    expect(body.stacks['react-vitest']).toBe(true);
    expect(body.stacks['mysql']).toBe(true);
    expect(body.stacks['pyspark']).toBe(true);
    expect(body.stacks['redis']).toBe(false);
    expect(body.stacks['spark-scala']).toBe(false);
    expect(body.stacks['java']).toBe(true);
    expect(body.stacks['react']).toBe(true);
    expect(body.stacks['llm']).toBe(true);
    expect(body.llmProviders.length).toBeGreaterThan(0);
  });

  it('判题器全挂不影响主观题评分链的可用性（两条通路解耦）', async () => {
    judge.available = new Set();
    const body = await ok<StackHealth>(await app.inject({ method: 'GET', url: '/api/health' }));
    expect(body.stacks['java-junit']).toBe(false);
    expect(body.stacks['pyspark']).toBe(false);
    expect(body.stacks['llm-rubric']).toBe(true);
    expect(body.stacks.llm).toBe(true);
  });

  it('评分链全档不可用时 llm-rubric 如实报 false（不把"能起服务"当"能评分"）', async () => {
    grade.canGrade = false;
    const body = await ok<StackHealth>(await app.inject({ method: 'GET', url: '/api/health' }));
    expect(body.stacks['llm-rubric']).toBe(false);
    expect(body.stacks.llm).toBe(false);
  });

  it('judge 全不可用时仍 200', async () => {
    judge.available = new Set();
    grade.canGrade = false;
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StackHealth;
    expect(Object.values(body.stacks).every((v) => v === false)).toBe(true);
  });
});

describe('GET /api/categories', () => {
  it('7 个类别都有 total/hidden/todayPlanned', async () => {
    const body = await ok<CategoriesResponse>(await app.inject({ method: 'GET', url: '/api/categories' }));
    expect(body.categories.map((c) => c.id)).toEqual([...CATEGORY_IDS]);
    for (const c of body.categories) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.stack.length).toBeGreaterThan(0);
      expect(c.total).toBeGreaterThan(0);
      expect(c.hidden).toBe(0);
    }
    expect(body.categories.reduce((s, c) => s + c.todayPlanned, 0)).toBe(3);
  });

  it('hide 之后 hidden 计数增加、total 不变（题库只增不减）', async () => {
    const before = await ok<CategoriesResponse>(await app.inject({ method: 'GET', url: '/api/categories' }));
    await bank.hide('sql-mysql-0001');
    const after = await ok<CategoriesResponse>(await app.inject({ method: 'GET', url: '/api/categories' }));
    const sql = (c: CategoriesResponse) => c.categories.find((x) => x.id === 'sql')!;
    expect(sql(after).hidden).toBe(1);
    expect(sql(after).total).toBe(sql(before).total);
  });
});

describe('GET /api/challenge/today', () => {
  it('返回 2 道可判分 + 1 道主观，且不含答案', async () => {
    const body = await today();
    expect(body.date).toBe('2026-09-19');
    expect(body.questions).toHaveLength(3);
    expect(body.plan.main.count).toBe(2);
    expect(body.plan.side.count).toBe(1);
    expect(body.questions.slice(0, 2).every((q) => q.judgeKind !== 'llm-rubric')).toBe(true);
    expect(body.questions[2]!.judgeKind).toBe('llm-rubric');
    expect(body.questions[2]!.rubric?.pointLabels.length).toBeGreaterThan(0);
    expect(body.progress).toEqual({ answered: 0, passed: 0, xpToday: 0, streakSafe: false });
    expectNoAnswerLeak(JSON.stringify(body));
  });

  it('带 category 时返回该栈 practice 池，但套餐与完成判定不变', async () => {
    const plain = await today();
    const withCat = await ok<TodayResponse>(await app.inject({ method: 'GET', url: '/api/challenge/today?category=big-data' }));
    expect(withCat.plan).toEqual(plain.plan);
    expect(withCat.questions.map((q) => q.id)).toEqual(plain.questions.map((q) => q.id));
    expect(withCat.practice!.length).toBeGreaterThan(0);
    expect(withCat.practice!.every((q) => q.category === 'big-data')).toBe(true);
    expectNoAnswerLeak(JSON.stringify(withCat));
  });

  it('未知类别 400；重复请求题目一致', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/challenge/today?category=nope' });
    expect(bad.statusCode).toBe(400);
    expect(await today()).toEqual(await today());
  });
});

describe('GET /api/questions/:id（参考答案的唯一出口）', () => {
  it('代码题：含用例（含 expected）+ 参考解 + 文字要点', async () => {
    const target = codeQuestions()[0]!;
    const body = await ok<QuestionDetailResponse>(await app.inject({ method: 'GET', url: `/api/questions/${target.id}` }));
    expect(body.question.id).toBe(target.id);
    expect(body.question.cases?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.question.cases)).toContain('expected');
    expect(body.reference.solution).toContain(REFERENCE_SOLUTION_MARKER);
    expect(body.reference.answer).toContain(REFERENCE_ANSWER_MARKER);
    // 答案只能从 reference 出来：question 本体依旧是剥干净的形状
    expectNoAnswerLeak(JSON.stringify(body.question));
  });

  it('主观题：给要点但不给参考解，也不给 rubric 判据（判据仍答完才展开）', async () => {
    const body = await ok<QuestionDetailResponse>(await app.inject({ method: 'GET', url: `/api/questions/${rubricQuestion().id}` }));
    expect(body.question.rubric?.maxScore).toBe(10);
    expect(body.question.rubric).not.toHaveProperty('points');
    expect(body.reference.answer).toContain(REFERENCE_ANSWER_MARKER);
    expect(body.reference.solution).toBeUndefined();
    const missing = await app.inject({ method: 'GET', url: '/api/questions/no-such-question' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/judge', () => {
  it('traceId 贯穿 HTTP → 判题器（一次提交的日志能一条链捞完）', async () => {
    const q = codeQuestions()[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/judge',
      headers: { 'x-trace-id': 'judge-trace-1' },
      payload: { questionId: q.id, submission: 'class Solution{}' },
    });
    expect(res.headers['x-trace-id']).toBe('judge-trace-1');
    expect(judge.calls[0]).toMatchObject({ traceId: 'judge-trace-1' });
    expect((res.json() as JudgePostResponse).result.traceId).toBe('judge-trace-1');
  });

  it('同步兜底：记 attempts + 返回历史最佳', async () => {
    const q = codeQuestions()[0]!;
    const first = await ok<JudgePostResponse>(
      await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'class Solution{}' } }),
    );
    expect(first.result.status).toBe('pass');
    expect(first.best ?? null).toBeNull();
    let rows = await store.allAttempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ questionId: q.id, category: q.category, kind: 'judge', status: 'pass', xp: 15, day: '2026-09-19' });
    expect(judge.calls[0]).toMatchObject({ questionId: q.id, submission: 'class Solution{}', language: q.language });

    judge.result = {
      ...judge.result,
      status: 'fail',
      passed: 1,
      failed: 2,
      failedCases: [{ name: '乱序事件按键聚合', passed: false }],
      passedCases: [],
    };
    const second = await ok<JudgePostResponse>(
      await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'wrong' } }),
    );
    expect(second.best).toMatchObject({ status: 'pass' });
    expect(typeof second.best!.at).toBe('string');
    rows = await store.allAttempts();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.xp).toBe(2);
    expectNoAnswerLeak(JSON.stringify(second));
  });

  it('判分 llm-rubric 题 → 400；未知题 → 404；缺 submission → 400', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: rubricQuestion().id, submission: 'x' } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: 'nope', submission: 'x' } });
    expect(missing.statusCode).toBe(404);
    const noBody = await app.inject({ method: 'POST', url: '/api/judge', payload: {} });
    expect(noBody.statusCode).toBe(400);
  });

  it('judge 抛错 → 500 JSON，不写脏 attempt', async () => {
    judge.throws = true;
    const res = await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: codeQuestions()[0]!.id, submission: 'x' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty('error');
    expect((await store.allAttempts()).length).toBe(0);
  });
});

describe('POST /api/judge/stream（SSE：等待可见）', () => {
  const frames = (payload: string): JudgeEvent[] =>
    payload
      .split('\n\n')
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6).trim()),
      )
      .filter((lines) => lines.length > 0)
      .map((lines) => JSON.parse(lines[0]!) as JudgeEvent);

  it('依次收到 queued / progress / result，最后一条必为 result', async () => {
    const q = codeQuestions()[0]!;
    const res = await app.inject({ method: 'POST', url: '/api/judge/stream', payload: { questionId: q.id, submission: 'class Solution{}' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = frames(res.payload);
    expect(events[0]).toMatchObject({ type: 'queued', questionId: q.id });
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'log')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type).toBe('result');
    if (last.type === 'result') expect(last.result.status).toBe('pass');
    expect(res.payload.endsWith('\n\n')).toBe(true);
    expectNoAnswerLeak(res.payload);
    expect((await store.allAttempts())[0]).toMatchObject({ questionId: q.id, kind: 'judge', xp: 15 });
  });

  it('judge 抛错时仍以 result 收尾并结束流，且不记录 infra 失败', async () => {
    judge.throws = true;
    const res = await app.inject({ method: 'POST', url: '/api/judge/stream', payload: { questionId: codeQuestions()[0]!.id, submission: 'x' } });
    const events = frames(res.payload);
    const last = events.at(-1)!;
    expect(last.type).toBe('result');
    if (last.type === 'result') {
      expect(last.result.status).toBe('error');
      expect(last.result.logs).toContain('judge exploded');
    }
    expect(await store.allAttempts()).toHaveLength(0);
  });

  it('非法题/非法 body 在 hijack 之前返回 JSON 错误', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/judge/stream', payload: { questionId: 'nope', submission: 'x' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).not.toContain('text/event-stream');
    const rub = await app.inject({ method: 'POST', url: '/api/judge/stream', payload: { questionId: rubricQuestion().id, submission: 'x' } });
    expect(rub.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: '/api/judge/stream', payload: { submission: 'x' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /api/grade', () => {
  it('评分后展开 rubric 权重，并记录 grade attempt', async () => {
    const rub = rubricQuestion();
    const body = await ok<GradePostResponse>(
      await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: rub.id, answer: '我会用有界队列 + 指数退避' } }),
    );
    expect(body.verdict.score).toBe(8);
    expect(body.question.rubric?.points?.length).toBeGreaterThan(0);
    expect(body.question.rubric!.points!.reduce((s, p) => s + p.weight, 0)).toBe(10);
    const rows = await store.allAttempts();
    // 8/10 已过 GRADE_PASS_RATIO(0.6) 及格线 → 记 pass；xp 仍按比例折算
    expect(rows[0]).toMatchObject({ questionId: rub.id, kind: 'grade', score: 8, maxScore: 10, xp: 16, status: 'pass' });
    expect(JSON.stringify(body)).not.toContain(REFERENCE_ANSWER_MARKER);
    expect(JSON.stringify(body)).not.toContain('referenceSolution');
    expect(grade.calls).toBe(1);
  });

  it('降级到 manual 不是"考了 0 分"：记 needs_human、不占分数、不算当日作答', async () => {
    const rub = rubricQuestion();
    grade.verdict = { ...grade.verdict, provider: 'manual', score: 0 };
    const body = await ok<GradePostResponse>(
      await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: rub.id, answer: '答了但机器没评' } }),
    );
    expect(body.verdict.provider).toBe('manual');
    const rows = await store.allAttempts();
    expect(rows[0]).toMatchObject({ questionId: rub.id, kind: 'grade', status: 'needs_human', score: null, maxScore: null, xp: 0 });
    const today = await ok<TodayResponse>(await app.inject({ method: 'GET', url: '/api/challenge/today' }));
    expect(today.progress.answered).toBe(0);
  });

  it('traceId 贯穿 HTTP → 评分链（"为什么给这个分"要能一条日志链看完）', async () => {    const rub = rubricQuestion();
    const res = await app.inject({
      method: 'POST',
      url: '/api/grade',
      headers: { 'x-trace-id': 'grade-trace-1' },
      payload: { questionId: rub.id, answer: '我会给容量估算与降级路径' },
    });
    expect(res.headers['x-trace-id']).toBe('grade-trace-1');
    expect(grade.lastTraceId).toBe('grade-trace-1');
    expect((res.json() as GradePostResponse).traceId).toBe('grade-trace-1');
  });

  it('判代码题走 grade → 400；未知题 → 404；缺 answer → 400', async () => {
    const code = await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: codeQuestions()[0]!.id, answer: 'x' } });
    expect(code.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: 'nope', answer: 'x' } });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: rubricQuestion().id } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /api/progress', () => {
  async function answerPlan(score: 'full' | 'weak') {
    const plan = await today();
    for (const q of plan.questions.filter((x) => x.judgeKind !== 'llm-rubric')) {
      const pass = score === 'full';
      judge.result = { ...judge.result, status: pass ? 'pass' : 'fail', passed: pass ? 3 : 0, failed: pass ? 0 : 3 };
      await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'x' } });
    }
    for (const q of plan.questions.filter((x) => x.judgeKind === 'llm-rubric')) {
      grade.verdict = { ...grade.verdict, score: score === 'full' ? 10 : 4 };
      await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: q.id, answer: '答一点' } });
    }
    return plan;
  }

  it('30 天日历缺失日补 0；含段位、成就、按类别统计', async () => {
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.calendar).toHaveLength(30);
    expect(body.calendar.at(-1)!.date).toBe('2026-09-19');
    expect(body.calendar.slice(0, 29).every((c) => c.xp === 0 && c.answered === 0 && c.passed === 0)).toBe(true);
    expect(body.achievements.map((a) => a.id)).toEqual(['streak-7', 'first-perfect', 'all-stacks', 'spark-10']);
    expect(body.achievements.every((a) => !a.unlocked)).toBe(true);
    expect(body.league).toEqual({ id: 'bronze', label: '青铜', nextAt: 150 });
    expect(body.today.done).toBe(false);
    expect(body.xp).toBe(0);
    expect(body.byCategory).toEqual({});
  });

  it('完成套餐：+10 奖励、today.done、streak 续签', async () => {
    const plan = await answerPlan('full');
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    const plannedIds = plan.questions.map((q) => q.id);
    // 15 + 15 + 20 + 10
    expect(body.xpToday).toBe(60);
    expect(body.xp).toBe(60);
    expect(body.streakDays).toBe(1);
    expect(body.streakLongest).toBe(1);
    expect(body.today).toEqual({ planned: plannedIds, answered: plannedIds, passed: plannedIds, done: true });
    expect(body.achievements.find((a) => a.id === 'first-perfect')!.unlocked).toBe(true);
    expect(body.league.id).toBe('bronze');
    const progress = (await today()).progress;
    expect(progress).toEqual({ answered: 3, passed: 3, xpToday: 60, streakSafe: true });
    const cat = body.byCategory[plan.plan.main.category]!;
    expect(cat).toEqual({ answered: 2, passed: 2, accuracy: 1, xp: 30 });
  });

  it('只答 1 道题不足以续签，重复提交不刷分', async () => {
    const plan = await today();
    const q = plan.questions.find((x) => x.judgeKind !== 'llm-rubric')!;
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'x' } });
    }
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.xpToday).toBe(15);
    expect(body.xp).toBe(15);
    expect(body.streakDays).toBe(0);
    const progress = (await today()).progress;
    expect(progress).toEqual({ answered: 1, passed: 1, xpToday: 15, streakSafe: false });
  });

  it('主观题 4/10 不算通过，套餐完成态按每题最佳判定', async () => {
    const plan = await answerPlan('weak');
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.today.answered).toEqual(plan.questions.map((q) => q.id));
    expect(body.today.passed).toEqual([]);
    expect(body.today.done).toBe(false);
    // 2 道 fail(2xp) + 1 道 4/10(8xp) = 12 → 不够续签
    expect(body.xpToday).toBe(12);
    expect(body.streakDays).toBe(0);
  });
});

describe('GET /api/bank', () => {
  it('默认排除软删除题；includeHidden=1 才列出', async () => {
    await bank.hide('alg-java-0001');
    const list = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }));
    expect(list.total).toBe(allQuestions().length - 1);
    expect(list.rows.map((q) => q.id)).not.toContain('alg-java-0001');
    expect(list.hiddenIds).toEqual(['alg-java-0001']);
    expectNoAnswerLeak(JSON.stringify(list));

    const all = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?includeHidden=1' }));
    expect(all.total).toBe(allQuestions().length);
    expect(all.rows.map((q) => q.id)).toContain('alg-java-0001');
  });

  it('按 category / difficulty / tag / q 过滤', async () => {
    const byCat = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?category=big-data' }));
    expect(byCat.rows.every((q) => q.category === 'big-data')).toBe(true);
    expect(byCat.total).toBe(7);

    const byDiff = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?difficulty=principal' }));
    expect(byDiff.rows).toEqual([]);

    const byTag = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?tag=retry' }));
    expect(byTag.total).toBeGreaterThan(0);
    const noTag = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?tag=nope-nope' }));
    expect(noTag.total).toBe(0);

    const byQ = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?q=alg-java-0002' }));
    expect(byQ.rows.map((q) => q.id)).toEqual(['alg-java-0002']);
    const byWord = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?q=幂等' }));
    expect(byWord.total).toBeGreaterThan(0);

    const combined = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?category=sql&difficulty=senior&tag=idempotency' }));
    expect(combined.total).toBe(8);
    const badCat = await app.inject({ method: 'GET', url: '/api/bank?category=nope' });
    expect(badCat.statusCode).toBe(400);
    const badDiff = await app.inject({ method: 'GET', url: '/api/bank?difficulty=junior' });
    expect(badDiff.statusCode).toBe(400);
  });
});

describe('hide / unhide 端点', () => {
  it('hide 后题库列表消失，unhide 恢复；未知 id 404', async () => {
    const id = 'sql-mysql-0002';
    const hidden = await ok<HideResponse>(await app.inject({ method: 'POST', url: `/api/questions/${id}/hide`, payload: { reason: '已掌握' } }));
    expect(hidden).toEqual({ id, hidden: true });
    const list = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }));
    expect(list.rows.map((q) => q.id)).not.toContain(id);
    const shown = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?includeHidden=1' }));
    expect(shown.hiddenIds).toContain(id);

    const back = await ok<HideResponse>(await app.inject({ method: 'DELETE', url: `/api/questions/${id}/hide` }));
    expect(back).toEqual({ id, hidden: false });
    const again = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }));
    expect(again.rows.map((q) => q.id)).toContain(id);

    const missing = await app.inject({ method: 'POST', url: '/api/questions/nope/hide' });
    expect(missing.statusCode).toBe(404);
  });

  it('hide 影响今日套餐（已移除题目不入池）', async () => {
    const plan = await today();
    const victim = plan.questions[0]!.id;
    await app.inject({ method: 'POST', url: `/api/questions/${victim}/hide` });
    const after = await today();
    expect(after.questions.map((q) => q.id)).not.toContain(victim);
    expect(after.questions).toHaveLength(3);
  });
});

describe('错误与 SPA 回退', () => {
  it('未知 /api 路由返回 JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('非 /api 的 GET 在没有前端产物时返回 JSON 404', async () => {
    // 显式指向一个不存在的 dist：仓库里 web/dist 一旦被构建出来，默认路径就会返回 index.html
    const spa = await buildApp({ judge, grade, bank, store, clock, webDist: join(process.cwd(), 'data', 'test-tmp', 'no-such-dist') });
    const res = await spa.inject({ method: 'GET', url: '/progress' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    await spa.close();
  });

  it('有 dist 时静态资源可取、深链回 index.html、/api 仍是 JSON 404', async () => {
    const dist = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'dist-'));
    try {
      await mkdir(join(dist, 'assets'), { recursive: true });
      await writeFile(join(dist, 'index.html'), '<!doctype html><title>daily-arena</title>', 'utf8');
      await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf8');
      const spa = await buildApp({ judge, grade, bank, store, clock, webDist: dist });
      const page = await spa.inject({ method: 'GET', url: '/progress' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('daily-arena');
      const asset = await spa.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');
      // 构建之后才落盘的资源也必须能取到：vite 每次换 chunk 哈希，靠启动时扫目录当索引就会整页白屏
      await writeFile(join(dist, 'assets', 'late-9f3a2c.js'), 'console.log(2)', 'utf8');
      const late = await spa.inject({ method: 'GET', url: '/assets/late-9f3a2c.js' });
      expect(late.statusCode).toBe(200);
      expect(late.headers['content-type']).toContain('javascript');
      const missingAsset = await spa.inject({ method: 'GET', url: '/assets/nope.js' });
      expect(missingAsset.statusCode).toBe(200);
      expect(missingAsset.headers['content-type']).toContain('text/html');
      const apiMiss = await spa.inject({ method: 'GET', url: '/api/nope' });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.headers['content-type']).toContain('application/json');
      const health = await spa.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      await spa.close();
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe('复习排期写路径（WI-41）', () => {
  const readBook = async () => parseBook(await store.getSetting('review:book'));
  const codeQuestion = () => bank.questions.find((q) => q.judgeKind === 'java-junit')!;

  it('今日套餐响应带 reviewIds；没有到期题时是空数组', async () => {
    const body = await ok<TodayResponse>(await app.inject({ method: 'GET', url: '/api/challenge/today' }));
    expect(body.reviewIds).toEqual([]);
  });

  it('判错 → 排期落盘并排到明天；随后答对一次仍留在册（连续两次 pass 才升档）', async () => {
    const q = codeQuestion();
    judge.result = {
      ...judge.result,
      status: 'fail',
      passed: 1,
      failed: 2,
      total: 3,
      passedCases: ['空输入返回空结果'],
      failedCases: [
        { name: '重复事件只处理一次', passed: false },
        { name: '乱序事件按键聚合', passed: false },
      ],
    };
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'class Solution{}' } });
    expect((await readBook()).entries[q.id]).toMatchObject({ reps: 0, last: 'fail', due: '2026-09-20' });

    judge.result = { ...judge.result, status: 'pass', passed: 3, failed: 0, passedCases: ['a', 'b', 'c'], failedCases: [] };
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'class Solution{}' } });
    expect((await readBook()).entries[q.id]).toMatchObject({ reps: 0, last: 'pass', due: '2026-09-20' });
  });

  it('第一次就做对的题不进复习本', async () => {
    const q = codeQuestion();
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'class Solution{}' } });
    expect((await readBook()).entries[q.id]).toBeUndefined();
  });

  it('有到期题时今日套餐把它顶进槽位，并标在 reviewIds', async () => {
    // 先用"没有 settings 能力"的 store 探一次今天的默认套餐，才知道哪道题不在里面
    const probe = await buildApp({ judge, grade, bank, store: new BareFakeStore(), clock });
    const plain = await ok<TodayResponse>(await probe.inject({ method: 'GET', url: '/api/challenge/today' }));
    await probe.close();
    const candidate = bank.questions.find(
      (q) => q.judgeKind === 'java-junit' && !plain.questions.some((p) => p.id === q.id),
    )!;
    await store.setSetting('review:book', JSON.stringify({ entries: { [candidate.id]: { reps: 0, due: '2026-09-19', last: 'fail', lastDay: '2026-09-18' } } }));

    const body = await ok<TodayResponse>(await app.inject({ method: 'GET', url: '/api/challenge/today' }));
    expect(body.reviewIds).toEqual([candidate.id]);
    expect(body.questions.map((q) => q.id)).toContain(candidate.id);
    expect(body.questions).toHaveLength(3);
  });

  it('评分降级成 needs_human 时不动排期（基础设施故障不该记成"这题你不会"）', async () => {
    const q = bank.questions.find((x) => x.judgeKind === 'llm-rubric')!;
    grade.verdict = { ...grade.verdict, provider: 'manual' };
    const res = await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: q.id, answer: '我的设计' } });
    expect(res.statusCode).toBe(200);
    const body = await ok<GradePostResponse>(res);
    expect(body.verdict.provider).toBe('manual');
    // needs_human 不进排期（回填也一样）：那道题此刻"没人判过"，不是"你不会"
    expect((await readBook()).entries[q.id]).toBeUndefined();
  });

  it('进度接口报错题本：在册 / 今日到期 / 最久没碰', async () => {
    await store.setSetting('review:book', JSON.stringify({ entries: {
      a: { reps: 0, due: '2026-09-19', last: 'fail', lastDay: '2026-09-10' },
      b: { reps: 1, due: '2026-09-25', last: 'fail', lastDay: '2026-09-18' },
    } }));
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.review).toEqual({ tracked: 2, dueToday: 1, oldestDays: 9 });
  });

  it('主观题判分后按结果排期：低分进本、高分升档', async () => {
    const q = bank.questions.find((x) => x.judgeKind === 'llm-rubric')!;
    grade.verdict = { ...grade.verdict, score: 4, maxScore: 10 };
    await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: q.id, answer: '勉强答对一半' } });
    expect((await readBook()).entries[q.id]).toMatchObject({ last: 'fail', due: '2026-09-20' });

    grade.verdict = { ...grade.verdict, score: 10, maxScore: 10 };
    await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: q.id, answer: '完整方案' } });
    expect((await readBook()).entries[q.id]).toMatchObject({ reps: 0, last: 'pass' });
  });
});

describe('GET /api/attempts — 判题历史回看（N-05）', () => {
  const history = async (questionId: string, limit?: number) =>
    ok<AttemptsResponse>(
      await app.inject({ method: 'GET', url: `/api/attempts?questionId=${questionId}${limit === undefined ? '' : `&limit=${limit}`}` }),
    );

  it('正式提交后，历史里能看到逐用例结果和当时写的正文', async () => {
    const q = codeQuestions()[0]!;
    judge.result = { ...judge.result, status: 'fail', passed: 1, failed: 2, total: 3, failedCases: [{ name: '空输入', passed: false, expected: '[]', actual: 'NPE', message: 'boom' }], logs: 'Main.java:3: error' };
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'class A { int f() { return 1; } }' } });

    const body = await history(q.id);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({ questionId: q.id, kind: 'judge', status: 'fail', passed: 1, failed: 2 });
    expect(body.attempts[0]!.detail?.failedCases?.[0]).toMatchObject({ name: '空输入', actual: 'NPE' });
    expect(body.attempts[0]!.detail?.logs).toContain('error');
    expect(body.attempts[0]!.detail?.submission).toContain('class A');
  });

  it('主观题历史带评分点命中情况与不足项', async () => {
    const q = rubricQuestion();
    await app.inject({ method: 'POST', url: '/api/grade', payload: { questionId: q.id, answer: '我会用有界队列 + 指数退避' } });
    const body = await history(q.id);
    expect(body.attempts[0]?.detail?.kind).toBe('grade');
    expect(body.attempts[0]?.detail?.rubric).toHaveLength(2);
    expect(body.attempts[0]?.detail?.gaps).toEqual(['没讲重放幂等键']);
    expect(body.attempts[0]?.detail?.submission).toContain('有界队列');
  });

  it('自测不进历史：不记分的事不该污染复盘', async () => {
    const q = codeQuestions()[0]!;
    await app.inject({
      method: 'POST',
      url: '/api/judge',
      payload: { questionId: q.id, submission: 'x', customCases: [{ input: [1], expected: 1 }] },
    });
    expect((await history(q.id)).attempts).toEqual([]);
  });

  it('多次提交按新的在前，limit 生效', async () => {
    const q = codeQuestions()[0]!;
    for (const code of ['v1', 'v2', 'v3']) {
      await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: code } });
    }
    const all = await history(q.id);
    expect(all.attempts.map((a) => a.detail?.submission)).toEqual(['v3', 'v2', 'v1']);
    expect((await history(q.id, 2)).attempts).toHaveLength(2);
  });

  it('没有历史就是空数组，不是 404（没答过是正常状态）', async () => {
    expect((await history('no-such-question')).attempts).toEqual([]);
  });

  it('老数据没有留档 → detail 为 null，而不是假装"没有失败用例"', async () => {
    const q = codeQuestions()[0]!;
    await store.record(newAttempt({ questionId: q.id, detail: null }));
    const body = await history(q.id);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]?.detail).toBeNull();
  });

  it('缺 questionId → 400；越大的 limit 被夹到上限而不是把库捞空', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/attempts' });
    expect(missing.statusCode).toBe(400);
    const q = codeQuestions()[0]!;
    const capped = await ok<AttemptsResponse>(await app.inject({ method: 'GET', url: `/api/attempts?questionId=${q.id}&limit=9999` }));
    expect(capped.attempts).toEqual([]);
  });

  it('历史响应里不出现参考答案与评分判据（红线 C7）', async () => {
    const q = codeQuestions()[0]!;
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: q.id, submission: 'x' } });
    const res = await app.inject({ method: 'GET', url: `/api/attempts?questionId=${q.id}` });
    expectNoAnswerLeak(res.body);
  });
});

describe('GET /api/progress 的本周小结（N-03 周报层）', () => {
  it('按周一起算、只算这一周，上周的提交不进来看', async () => {
    // 时钟是 2026-09-19（周六）→ 本周一 2026-09-14、本周日 2026-09-20
    await store.record(newAttempt({ questionId: 'alg-java-0001', day: '2026-09-10', status: 'fail', xp: 2 }));
    await app.inject({ method: 'POST', url: '/api/judge', payload: { questionId: codeQuestions()[0]!.id, submission: 'x' } });

    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.week.start).toBe('2026-09-14');
    expect(body.week.end).toBe('2026-09-20');
    expect(body.week.days.map((d) => d.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    // 上周那次 fail 不该把本周正确率拉下来
    expect(body.week.accuracy).toBe(1);
    expect(body.week.weakest).toEqual({ category: codeQuestions()[0]!.category, answered: 1, passed: 1, accuracy: 1 });
  });

  it('这周什么都没做就说什么都没做（0 题、没有"最弱的一类"）', async () => {
    const body = await ok<ProgressResponse>(await app.inject({ method: 'GET', url: '/api/progress' }));
    expect(body.week.answered).toBe(0);
    expect(body.week.xp).toBe(0);
    expect(body.week.weakest).toBeNull();
  });
});

describe('IDE 的 REPL 端点（WI-77）', () => {
  it('languages 里带 replKind，而且只给真有交互式运行时的语言', async () => {
    const body = await ok<IdeLanguagesResponse>(await app.inject({ method: 'GET', url: '/api/ide/languages' }));
    expect(body.languages.filter((l) => l.replKind).map((l) => l.id).sort()).toEqual([
      'java', 'javascript', 'python',
    ]);
    // 预算也在这份响应里：UI 显示"最长等多久"不许自己抄一份常量
    for (const lang of body.languages) {
      expect(typeof lang.timeoutMs, lang.id).toBe('number');
      expect(lang.timeoutMs, lang.id).toBeGreaterThan(0);
    }
  });

  it('坏输入一律走"会话没了/这门语言没有 REPL"这条 200 通道，不把 HTTP 500 甩给用户', async () => {
    const noLang = await app.inject({ method: 'POST', url: '/api/ide/repl/start', body: {} });
    expect(noLang.statusCode).toBe(200);
    expect((noLang.json() as ReplStartResponse).session).toBeNull();

    const noRepl = await ok<ReplStartResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/repl/start', body: { language: 'markdown' } }),
    );
    expect(noRepl.session).toBeNull();
    expect(noRepl.message).toMatch(/没有 REPL/);

    const feedMissing = await ok<ReplFeedResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/repl/feed', body: { sessionId: 'nope', line: 'print(1)' } }),
    );
    expect(feedMissing.status).toBe('gone');

    const stopped = await ok<ReplStopResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/repl/stop', body: { sessionId: 'nope' } }),
    );
    expect(stopped.ok).toBe(false);
  });

  it('GET /ide/repl 报当前会话数与上限（UI 用它显示 "N / 2"）', async () => {
    const body = await ok<ReplSessionsResponse>(await app.inject({ method: 'GET', url: '/api/ide/repl' }));
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.maxSessions).toBe(2);
    expect(body.idleMs).toBe(5 * 60_000);
  });
});

describe('IDE 的行断点端点（WI-81）', () => {
  it('languages 里带 debugKind，而且只给真写了后端的语言', async () => {
    const body = await ok<IdeLanguagesResponse>(await app.inject({ method: 'GET', url: '/api/ide/languages' }));
    expect(body.languages.filter((l) => l.debugKind).map((l) => l.id).sort()).toEqual([
      'java', 'javascript', 'python',
    ]);
    expect(findLanguage('mysql')?.debugKind, 'SQL 没有可调试的常驻程序').toBeUndefined();
  });

  it('坏输入一律 200 + 一条看得懂的话，不把 HTTP 500 甩给用户', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/ide/debug/start', body: {} });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as DebugStartResponse).session).toBeNull();

    const noDebug = await ok<DebugStartResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/debug/start', body: { language: 'markdown', code: 'x', breakpoints: [1] } }),
    );
    expect(noDebug.session).toBeNull();
    expect(noDebug.message).toMatch(/没有行断点/);
    expect(noDebug.status, '压根没起会话与"起过后没了"是两件事').toBe('rejected');

    const stepped = await ok<DebugStepResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/debug/step', body: { sessionId: 'nope', action: 'next' } }),
    );
    expect(stepped.status).toBe('gone');

    const stopped = await ok<DebugStopResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/debug/stop', body: { sessionId: 'nope' } }),
    );
    expect(stopped.ok).toBe(false);
  });

  it('认不出的单步走法被拒，而不是被猜成 continue', async () => {
    const body = await ok<DebugStepResponse>(
      await app.inject({ method: 'POST', url: '/api/ide/debug/step', body: { sessionId: 'nope', action: 'stepSideways' } }),
    );
    expect(body.status).toBe('rejected');
    expect(body.message).toContain('stepSideways');
  });

  it('断点行号只收正整数：NaN / 0 / 负数 / 字符串都不许进到会话语义里', async () => {
    const body = await ok<DebugStartResponse>(
      await app.inject({
        method: 'POST',
        url: '/api/ide/debug/start',
        body: { language: 'markdown', code: 'x', breakpoints: [0, -3, 1.5, '2', null, 7] },
      }),
    );
    // 这条验的是路由层没把脏数据原样转发：markdown 没有调试器，所以只会拿到一句拒绝
    expect(body.session).toBeNull();
    expect(body.status).toBe('rejected');
  });

  it('GET /ide/debug 报会话数与上限（一个编辑器只调一个程序）', async () => {
    const body = await ok<DebugSessionsResponse>(await app.inject({ method: 'GET', url: '/api/ide/debug' }));
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.maxSessions).toBe(1);
    expect(body.idleMs).toBe(5 * 60_000);
  });
});

describe('GET /api/bank 的列表行（N-15 的瘦身）', () => {
  it('只带"够筛、够渲染"的字段：没有题面、没有用例内容、没有 rubric 与答案', async () => {
    const body = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?includeHidden=1' }));
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.rows.length);

    const codeRow = body.rows.find((r) => r.judgeKind !== 'llm-rubric')!;
    expect(codeRow.caseCount, "徽章要的是'几个用例'，不是整个用例数组").toBe(3);
    const subjRow = body.rows.find((r) => r.judgeKind === 'llm-rubric')!;
    expect(subjRow.caseCount, '主观题没有用例，就该报 0 而不是空数组').toBe(0);

    const raw = JSON.stringify(body);
    expectNoAnswerLeak(raw);
    // 整段题面与用例都不该出现在列表响应里（这才是这次要省的那九成字节）
    expect(raw).not.toContain('背压、退避与去重策略');
    expect(raw).not.toContain('乱序事件按键聚合');

    // 白名单而不是精确键集：company 是可选字段，写死会把"有公司标签"当成违规
    const allowed = new Set(['id', 'title', 'category', 'difficulty', 'judgeKind', 'tags', 'company', 'caseCount']);
    for (const row of body.rows) {
      for (const key of Object.keys(row)) {
        expect(allowed.has(key), `${row.id} 带了列表不该有的字段：${key}`).toBe(true);
      }
    }
  });

  it('题面正文的搜索由服务端做：客户端那份列表里没有正文，搜不到就得由服务端补', async () => {
    // "背压"只出现在 statement 里（标题与标签都没有），所以这条只在服务端搜索成立时才绿
    const hit = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?q=' + encodeURIComponent('背压') }));
    expect(hit.rows.length, '题面里有"背压"，服务端必须搜得到').toBeGreaterThan(0);

    const miss = await ok<BankResponse>(
      await app.inject({ method: 'GET', url: '/api/bank?q=' + encodeURIComponent('这句话题库里不可能有') }),
    );
    expect(miss.rows).toEqual([]);
  });

  it('筛选项按全库算：一搜索就把下拉里的选项筛掉，看起来像"题库少了"', async () => {
    const plain = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }));
    const narrowed = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?category=sql&q=背压' }));
    expect(narrowed.rows.length).toBeLessThan(plain.rows.length);
    expect(narrowed.tags, 'tags 是筛选项，不是筛选结果').toEqual(plain.tags);
    expect(narrowed.companies).toEqual(plain.companies);
    expect(narrowed.unlabeled).toBe(plain.unlabeled);
    expect(narrowed.hiddenIds).toEqual(plain.hiddenIds);
  });

  it('标签下拉只列常用的那几个（963 项的 select 等于没有）：阈值以下不进 facet，但算进总数', async () => {
    const body = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }));
    const names = body.tags.map((t) => t.name);
    expect(names, '常用的两个标签该在下拉里').toEqual(expect.arrayContaining(['idempotency', 'retry']));
    expect(names, '只出现 1~2 次的标签不该占下拉的位置').not.toContain('rare-pair');
    expect(names).not.toContain('rare-single');
    // 挡住不等于丢了：tagCount 报的是全库不同标签数，界面靠它说清"还有 N 个只能搜"
    expect(body.tagCount).toBeGreaterThan(body.tags.length);
    expect(body.tags.every((t) => t.count >= TAG_FACET_MIN_COUNT), JSON.stringify(body.tags)).toBe(true);
    const counts = body.tags.map((t) => t.count);
    expect(counts.slice(1).every((n, i) => counts[i]! >= n), '按频次降序，常用项在最上面').toBe(true);
    const sortedByName = [...body.tags].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    expect(
      body.tags.filter((t) => t.count === counts[0]).map((t) => t.name),
      '同频的按名字排，否则两次请求下拉会跳',
    ).toEqual(sortedByName.filter((t) => t.count === counts[0]).map((t) => t.name));
  });

  it('被频次挡住的那个标签没丢：关键词搜得到它，也还能当筛选值用', async () => {
    const hit = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?q=' + encodeURIComponent('rare-pair') }));
    expect(hit.rows.length, 'haystack 里含 tags，搜稀有标签必须命中').toBeGreaterThan(0);
    const filtered = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?tag=rare-single' }));
    expect(filtered.rows.map((r) => r.id), '下拉里没有它，不代表它不能当筛选值').toEqual(['alg-java-0003']);
    expect(filtered.tags, '筛选项仍按全库算').toEqual((await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank' }))).tags);
  });

  it('公司桶：有标签的按题数从多到少排，没标签的单独计数（不给入口就只能靠关键词猜）', async () => {
    const body = await ok<BankResponse>(await app.inject({ method: 'GET', url: '/api/bank?includeHidden=1' }));
    const counts = body.companies.map((c) => c.count);
    expect(counts.slice(1).every((n, i) => counts[i]! >= n), JSON.stringify(counts)).toBe(true);
    const totalLabeled = counts.reduce((a, b) => a + b, 0);
    expect(totalLabeled + body.unlabeled).toBe(body.rows.length);
    expect(body.rows.filter((r) => r.company).length).toBe(totalLabeled);
  });
});
