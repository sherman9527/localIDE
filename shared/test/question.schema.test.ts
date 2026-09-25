import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, JUDGE_KINDS } from '../src/taxonomy.js';
import { Question, QuestionDraft, publicQuestion, toDraft, type PublicQuestion } from '../src/question.js';

/**
 * 契约层是题库系统与游戏系统的唯一边界（需求 场景 7）。
 * 这里钉死三件事：结构可校验、来源可追溯、答案不泄漏（rule.md C7）。
 */

const base = {
  id: 'alg-java-0001',
  category: 'algorithms',
  difficulty: 'senior',
  title: '在严格 O(n) 空间约束下定位重复区间',
  statement: '给定按时间排序的事件流，找出最长的一段连续区间，使得区间内 user_id 不重复。要求给出 Java 实现。',
  judgeKind: 'java-junit',
  tags: ['sliding-window', 'java'],
  cases: [
    { name: '空输入返回 0', input: [], expected: 0 },
    { name: '全不重复返回全长', input: [1, 2, 3], expected: 3 },
    { name: '中间重复截断', input: [1, 2, 1, 3], expected: 3 },
  ],
  runner: { className: 'Solution', method: 'solve', referenceSolution: 'class Solution { int solve(int[] a){ return 0; } }' },
  source: {
    origin: 'jd',
    company: 'Apple',
    ingestedAt: '2026-09-19T02:00:00.000Z',
    jds: [{ url: 'https://example.com/jd/1', title: 'Apple Data Engineer, Shanghai', crawledAt: '2026-09-18' }],
  },
} as const;

describe('QuestionSchema', () => {
  it('接受一道结构完整的代码题', () => {
    const parsed = Question.safeParse(base);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });

  it('缺少入库时间 source.ingestedAt 被拒绝（需求 场景 9）', () => {
    const bad = structuredClone(base) as Record<string, unknown>;
    (bad.source as Record<string, unknown>).ingestedAt = undefined;
    expect(Question.safeParse(bad).success).toBe(false);
  });

  it('难度只允许 senior / principal（需求 场景 11）', () => {
    const bad = { ...base, difficulty: 'junior' };
    expect(Question.safeParse(bad).success).toBe(false);
  });

  it('未知 judgeKind 被拒绝', () => {
    const bad = { ...base, judgeKind: 'flink-cluster' };
    expect(Question.safeParse(bad).success).toBe(false);
  });

  it('未知 category 被拒绝', () => {
    const bad = { ...base, category: 'devops' };
    expect(Question.safeParse(bad).success).toBe(false);
  });

  it('origin=jd 的题必须带 JD 出处（防止来源丢失）', () => {
    const bad = structuredClone(base) as unknown as { source: { jds: unknown[] } };
    bad.source.jds = [];
    expect(Question.safeParse(bad).success).toBe(false);
  });

  it('代码题必须带测试用例与参考解，用于 runner 自证回归', () => {
    const noCases = { ...base, cases: [] };
    expect(Question.safeParse(noCases).success).toBe(false);
    const noRef = { ...base, runner: { ...base.runner, referenceSolution: undefined } };
    expect(Question.safeParse(noRef).success).toBe(false);
  });

  it('主观题必须带 10 分制 rubric 且不需要 cases', () => {
    const subjective = {
      ...base,
      id: 'sys-design-0001',
      category: 'system-design',
      judgeKind: 'llm-rubric',
      cases: undefined,
      runner: undefined,
      statement: '为 Airbnb 设计一个支持每秒 5 万次价格更新的报价服务，说明一致性取舍。',
      rubric: {
        maxScore: 10,
        points: [
          { label: '识别出写放大与分片键', weight: 3 },
          { label: '给出降级与幂等方案', weight: 3 },
          { label: '量化容量与延迟预算', weight: 2 },
          { label: '提到 2026 年的新实践', weight: 2 },
        ],
      },
    };
    const parsed = Question.safeParse(subjective);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });

  it('主观题 rubric 至少要 2 个考点且 maxScore 为 10（需求 场景 8）', () => {
    const subjective = {
      ...base,
      id: 'sys-design-0003',
      category: 'system-design',
      judgeKind: 'llm-rubric',
      cases: undefined,
      runner: undefined,
      rubric: { maxScore: 5, points: [{ label: '只有考点', weight: 5 }] },
    };
    expect(Question.safeParse(subjective).success).toBe(false);
  });

  it('hot-interviews 类别必须标来源公司（需求 场景 2：显示来源公司）', () => {
    const noCompany = {
      ...base,
      category: 'hot-interviews',      judgeKind: 'llm-rubric',
      cases: undefined,
      runner: undefined,
      rubric: { maxScore: 10, points: [{ label: 'A', weight: 5 }, { label: 'B', weight: 5 }] },
      source: { ...base.source, company: undefined },
    };
    expect(Question.safeParse(noCompany).success).toBe(false);
  });

  it('taxonomy 常量彼此不重叠且被 schema 使用', () => {
    expect(CATEGORY_IDS).toHaveLength(7);
    expect(JUDGE_KINDS).toContain('pyspark');
    expect(new Set([...CATEGORY_IDS, ...JUDGE_KINDS]).size).toBe(CATEGORY_IDS.length + JUDGE_KINDS.length);
  });
});

describe('publicQuestion — 答案不泄漏（rule.md C7）', () => {
  it('剥离参考解与 rubric 权重，但保留可见用例（需求 场景 3/4）', () => {
    const pub = publicQuestion(Question.parse(base)) as unknown as Record<string, unknown>;
    const json = JSON.stringify(pub);
    expect(json).not.toContain('referenceSolution');
    expect(json).not.toContain('class Solution');
    expect(pub.runner).toBeUndefined();
    expect(pub.answer).toBeUndefined();
    // 用例提前给足：只看结果
    const cases = pub.cases as { expected: unknown }[];
    expect(cases).toHaveLength(3);
    expect(cases[0]).toHaveProperty('expected');
  });

  it('主观题只暴露考点标签与满分，不暴露权重', () => {
    const subjective = Question.parse({
      ...base,
      id: 'sys-design-0002',
      category: 'system-design',
      judgeKind: 'llm-rubric',
      cases: undefined,
      runner: undefined,
      rubric: { maxScore: 10, points: [{ label: '容量估算', weight: 4 }, { label: '一致性取舍', weight: 6 }] },
    });
    const pub = publicQuestion(subjective) as unknown as { rubric: Record<string, unknown> };
    expect(pub.rubric.maxScore).toBe(10);
    expect(pub.rubric.pointLabels).toContain('容量估算');
    expect(JSON.stringify(pub.rubric)).not.toContain('weight');
  });

  it('visible:false 的用例不下发输入与期望（"隐藏"不能只在浏览器里做）', () => {
    const withHidden = Question.parse({
      ...base,
      cases: [
        { name: '普通用例', input: [1, 2], expected: 3, visible: true },
        { name: '隐藏用例', input: [9, 9], expected: 18, visible: false, note: '边界九' },
      ],
    });
    const pub = publicQuestion(withHidden) as unknown as { cases: Record<string, unknown>[] };
    const json = JSON.stringify(pub);
    expect(json).not.toContain('"expected":18');
    expect(json).not.toContain('边界九');
    expect(pub.cases[1]).toMatchObject({ name: '隐藏用例', visible: false, input: null, expected: null });
    expect(pub.cases[0]).toHaveProperty('expected', 3);
  });

  it('publicQuestion 的返回类型可被前端安全使用（无 answer 字段）', () => {
    const pub: PublicQuestion = publicQuestion(Question.parse(base));
    expect(pub.id).toBe('alg-java-0001');
    expect('answer' in pub).toBe(false);
    expect('runner' in pub).toBe(false);
  });
});

describe('QuestionDraft — 入库前的草稿形态', () => {
  it('草稿允许缺 ingestedAt，ingest 时补齐', () => {
    const draft = toDraft(Question.parse(base));
    const parsed = QuestionDraft.safeParse({ ...draft, source: { origin: 'manual', jds: [] } });
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });
});
