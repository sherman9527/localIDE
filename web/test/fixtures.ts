import type {
  CategoriesResponse,
  GradePostResponse,
  HideResponse,
  JudgePostResponse,
  ProgressResponse,
  StackHealth,
  TodayResponse,
} from '@arena/shared';
import { CATEGORY_IDS } from '@arena/shared';
import type { JudgeEvent, JudgeResult, PublicQuestion, RubricVerdict } from '@arena/shared';

export const CODE_QUESTION: PublicQuestion = {
  schemaVersion: 1,
  id: 'alg-java-0001',
  category: 'algorithms',
  difficulty: 'senior',
  title: '去重后的所有两数配对',
  statement: [
    '## 题目',
    '',
    '给定整数数组 `nums` 与 `target`，返回所有**不重复**的两数下标配对。',
    '',
    '```java',
    'List<int[]> pairs(int[] nums, int target);',
    '```',
    '',
    '| 输入 | 期望 |',
    '| --- | --- |',
    '| `[]` | `[]` |',
    '| `[2,7,11], 9` | `[[0,1]]` |',
    '',
    '要求 O(n) 平均复杂度。',
  ].join('\n'),
  judgeKind: 'java-junit',
  language: 'java',
  tags: ['数组', '哈希表'],
  estimatedMinutes: 25,
  source: {
    origin: 'jd',
    company: 'Apple',
    role: 'Senior Software Engineer',
    location: 'shanghai',
    era: '2026',
    jds: [{ url: 'https://example.com/jd/1', title: 'Apple Senior SDE', crawledAt: '2026-09-01' }],
    ingestedAt: '2026-09-01T00:00:00.000Z',
  },
  cases: [
    { name: '空输入返回 0', input: { nums: [], target: 9 }, expected: [], visible: true },
    { name: '有唯一解', input: { nums: [2, 7, 11], target: 9 }, expected: [[0, 1]], visible: true },
    { name: '包含重复元素', input: { nums: [3, 3, 5, -1], target: 6 }, expected: [[0, 1], [2, 3]], visible: true },
  ],
};

export const SUBJECTIVE_QUESTION: PublicQuestion = {
  schemaVersion: 1,
  id: 'sys-design-0007',
  category: 'system-design',
  difficulty: 'principal',
  title: '设计一个跨区域一致的对账服务',
  statement: '请设计一个 **跨区域** 的支付对账服务，说明一致性模型、失败重试与可观测性。\n\n- 约束：日均 2 亿笔\n- 输出：架构图 + 口径',
  judgeKind: 'llm-rubric',
  language: 'markdown',
  tags: ['分布式', '对账'],
  estimatedMinutes: 30,
  source: {
    origin: 'manual',
    company: 'Airbnb',
    role: 'Staff Engineer',
    jds: [],
    ingestedAt: '2026-09-02T00:00:00.000Z',
  },
  rubric: {
    maxScore: 10,
    pointLabels: ['一致性模型选择', '失败重试与幂等', '可观测性与对账'],
  },
};

export const JUDGE_FAIL: JudgeResult = {
  status: 'fail',
  passed: 1,
  failed: 2,
  total: 3,
  failedCases: [
    { name: '空输入返回 0', passed: false, expected: '[]', actual: 'null' },
    { name: '包含重复元素', passed: false, expected: '[[0,1],[2,3]]', actual: '[[0,1],[0,2]]' },
  ],
  passedCases: ['有唯一解'],
  durationMs: 4210,
};

export const JUDGE_PASS: JudgeResult = {
  status: 'pass',
  passed: 3,
  failed: 0,
  total: 3,
  failedCases: [],
  passedCases: ['空输入返回 0', '有唯一解', '包含重复元素'],
  durationMs: 3900,
};

export const JUDGE_ERROR: JudgeResult = {
  status: 'error',
  passed: 0,
  failed: 0,
  total: 3,
  failedCases: [],
  passedCases: [],
  errorKind: 'compile',
  logs: 'AlgJava0001Test.java:12: error: cannot find symbol\n  var got = solver.pairs(nums, 9);\n      ^',
  durationMs: 1730,
};

export const JUDGE_STREAM_EVENTS: JudgeEvent[] = [
  { type: 'queued', questionId: CODE_QUESTION.id },
  { type: 'progress', phase: 'compile', elapsedMs: 3200, timeoutMs: 20000 },
  { type: 'log', line: '[junit] running PairsTest' },
  { type: 'progress', phase: 'run', elapsedMs: 4100, timeoutMs: 20000 },
  { type: 'result', result: JUDGE_FAIL },
];

export const RUBRIC_VERDICT: RubricVerdict = {
  score: 7,
  maxScore: 10,
  bonus: ['给出了 outbox + 幂等重放的组合方案'],
  gaps: ['没有给出跨区延迟预算'],
  rubricBreakdown: [
    { label: '一致性模型选择', hit: true, earned: 3 },
    { label: '失败重试与幂等', hit: true, earned: 4 },
    {
      label: '可观测性与对账',
      hit: false,
      earned: 0,
      nextStep: '补一句"每小时对账，差异 > 0 立即告警"',
    },
  ],
  provider: 'qodercli',
  model: 'qoder-cli',
  durationMs: 3400,
  raw: '{"score":7}',
};

export const GRADE_RESPONSE: GradePostResponse = {
  verdict: RUBRIC_VERDICT,
  traceId: 'grade-trace-fixture',
  question: {
    ...SUBJECTIVE_QUESTION,
    rubric: {
      maxScore: 10,
      pointLabels: ['一致性模型选择', '失败重试与幂等', '可观测性与对账'],
      points: [
        { label: '一致性模型选择', weight: 3 },
        { label: '失败重试与幂等', weight: 4 },
        { label: '可观测性与对账', weight: 3 },
      ],
    },
  },
};

export function todayResponse(over: Partial<TodayResponse> = {}): TodayResponse {
  const secondCode: PublicQuestion = { ...CODE_QUESTION, id: 'sql-mysql-0003', title: '窗口函数取每个用户最近一单' };
  return {
    date: '2026-09-19',
    plan: {
      date: '2026-09-19',
      main: { category: 'algorithms', count: 2, reason: 'default' },
      side: { category: 'system-design', count: 1 },
    },
    questions: [CODE_QUESTION, secondCode, SUBJECTIVE_QUESTION],
    reviewIds: [],
    progress: { answered: 1, passed: 1, xpToday: 17, streakSafe: false },
    ...over,
  };
}

export function categoriesResponse(): CategoriesResponse {
  return {
    categories: CATEGORY_IDS.map((id, i) => ({
      id,
      label: id,
      stack: id,
      total: 12 + i,
      hidden: i % 3,
      todayPlanned: id === 'algorithms' ? 2 : id === 'system-design' ? 1 : 0,
    })),
  };
}

export function stackHealth(over: Partial<StackHealth> = {}): StackHealth {
  return {
    ok: true,
    version: '0.1.0',
    stacks: { java: true, react: true, mysql: true, redis: true, pyspark: true, spark: true },
    llmProviders: ['qodercli'],
    ...over,
  };
}

export function progressResponse(over: Partial<ProgressResponse> = {}): ProgressResponse {
  return {
    xp: 470,
    xpToday: 25,
    streakDays: 6,
    streakLongest: 11,
    league: { id: 'gold', label: '黄金', nextAt: 1000 },
    achievements: [
      { id: 'streak-7', label: '七日连签', hint: '连续 7 天达到续签门槛', unlocked: true },
      { id: 'first-perfect', label: '满分主观', hint: '任一主观题拿到 10/10', unlocked: false },
      { id: 'all-stacks', label: '全栈出手', hint: '7 个类别各至少通过 1 题', unlocked: false },
      { id: 'spark-10', label: '数据工程十连', hint: 'big-data 类别累计通过 10 题', unlocked: true },
    ],
    today: { planned: ['alg-java-0001'], answered: ['alg-java-0001'], passed: ['alg-java-0001'], done: true },
    review: { tracked: 2, dueToday: 1, oldestDays: 9 },
    week: {
      start: '2026-09-14',
      end: '2026-09-20',
      days: [
        { date: '2026-09-14', answered: 3, passed: 2, xp: 32 },
        { date: '2026-09-15', answered: 0, passed: 0, xp: 0 },
        { date: '2026-09-16', answered: 3, passed: 3, xp: 45 },
        { date: '2026-09-17', answered: 0, passed: 0, xp: 0 },
        { date: '2026-09-18', answered: 2, passed: 1, xp: 17 },
        { date: '2026-09-19', answered: 3, passed: 2, xp: 30 },
        { date: '2026-09-20', answered: 0, passed: 0, xp: 0 },
      ],
      answered: 8,
      passed: 6,
      accuracy: 0.75,
      xp: 124,
      byCategory: {
        algorithms: { answered: 3, passed: 3, accuracy: 1 },
        frontend: { answered: 2, passed: 2, accuracy: 1 },
        sql: { answered: 3, passed: 1, accuracy: 1 / 3 },
      },
      weakest: { category: 'sql', answered: 3, passed: 1, accuracy: 1 / 3 },
    },
    calendar: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      xp: (i * 7) % 40,
      answered: i % 4,
      passed: i % 3,
    })),
    byCategory: {
      sql: { answered: 5, passed: 4, accuracy: 0.8, xp: 62 },
      algorithms: { answered: 8, passed: 6, accuracy: 0.75, xp: 92 },
    },
    ...over,
  };
}

export function hideResponse(id: string, hidden = true): HideResponse {
  return { id, hidden };
}

export function judgePostResponse(result: JudgeResult = JUDGE_FAIL): JudgePostResponse {
  return { result };
}
