import { z } from 'zod';
import { CATEGORY_JUDGE_KINDS, CATEGORY_IDS, JUDGE_KINDS, LANGUAGES } from './taxonomy.js';
import type { CategoryId, JudgeKind } from './taxonomy.js';

const QuestionId = z.string().regex(/^[a-z0-9][a-z0-9._-]{3,60}$/, 'id 需形如 alg-java-0001');

export const JdRef = z
  .object({
    url: z.string().url(),
    title: z.string().min(3),
    crawledAt: z.string().min(4),
    company: z.string().min(1).optional(),
  })
  .strict();

const SourceCore = {
  company: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  /**
   * 出题依据的岗位所在地。枚举刻意收窄（防止变成自由文本没法筛），
   * 但必须覆盖题库里真实出现过的城市 —— 字节是北京、阿里是杭州，
   * 没有这两个值时它们只能退写成 `other`，那就是题库在说假话。
   */
  location: z.enum(['shanghai', 'beijing', 'hangzhou', 'us', 'remote', 'other']).optional(),
  origin: z.enum(['manual', 'jd', 'cli', 'history']),
  jds: z.array(JdRef).default([]),
  /** 指向 content/knowledge/<category>/<file>.md 的考点出处 */
  knowledgeRef: z.string().min(1).optional(),
  /** 出题依据的年份，用于卡"是否还在覆盖当年技术" */
  era: z.string().regex(/^\d{4}$/, 'era 形如 2026').optional(),
  addedBy: z.string().min(1).optional(),
};

export const SourceDraft = z.object(SourceCore).strict();
export const Source = z.object({ ...SourceCore, ingestedAt: z.string().min(1) }).strict();

export const TestCase = z
  .object({
    name: z.string().min(2),
    input: z.unknown(),
    expected: z.unknown(),
    /** 默认提前展示：结果导向的题目要求"给足测试用例"（需求 场景 4） */
    visible: z.boolean().default(true),
    /**
     * 契约型用例：期望的是"必须抛这个异常"（expected 填异常简单类名，如 ArithmeticException）。
     * 没有它就只能把"应当报错"的要求写进题面，判不了分。
     */
    expectThrow: z.string().min(1).optional(),
    /**
     * 契约型用例的**消息**要求。`expectThrow` 只到异常类名，两道"都该抛"的用例
     * 会被收敛成同一件事（本仓库出过一次题：入参多包一层数组，
     * "整个入参为 null"与"某个元素为 null"测的其实是同一条路径）。
     * 消费方是出题管线：`scripts/bank/drafts/<公司>/precheck.py` 拿它核对参考解抛的消息，
     * 以及 react-vitest 题据此生成 `toThrow(msg)` 断言 —— 判题器本身读的还是 expectThrow。
     */
    throwMessage: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const RubricPoint = z
  .object({
    label: z.string().min(2),
    weight: z.number().int().positive(),
    /** 评分时给模型的判据说明，答完题才对用户可见 */
    criteria: z.string().min(1).optional(),
  })
  .strict();

export const Rubric = z
  .object({
    maxScore: z.literal(10),
    points: z.array(RubricPoint).min(2),
    notes: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => r.points.reduce((sum, p) => sum + p.weight, 0) === r.maxScore, {
    message: 'rubric.points[].weight 合计必须等于 maxScore(10)',
  });

/**
 * 单题 `runner.timeoutMs` 的硬上限。**这个数同时是"一个判题沙箱最多能活多久"** ——
 * `judge/workspace.ts` 的残留清扫只看目录 mtime、不问有没有进程在用，
 * 所以它的时限必须明显大于这里，否则启动清扫会删掉一个正在被使用的沙箱（那条不变量有测试钉住）。
 */
export const RUNNER_TIMEOUT_CAP_MS = 180_000;

export const RunnerConfig = z
  .object({
    className: z.string().min(1).optional(),
    /** 提交内容落盘的相对路径（react 题常用 `src/Counter.tsx` 让测试按真实工程结构 import） */
    submissionPath: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    signature: z.string().min(1).optional(),
    /** 只有 pyspark runner 真的读它（function 取返回值 / script 跑整段 / sql 走 spark.sql）。
     *  java、react 靠 className、method、submissionPath 定位入口，与本字段无关；
     *  曾经的 'class' 没有任何 runner 实现，写进去只会让题目在判题矩阵里报错。 */
    entry: z.enum(['function', 'script', 'sql']).default('function'),
    files: z
      .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
      .optional(),
    /** mysql: 建表/灌数语句；redis: 预置命令 */
    setup: z.array(z.string()).optional(),
    orderSensitive: z.boolean().default(false),
    // Scala Spark 题要真编译再跑，上限比其它栈高一档（runner 默认 90s）
    timeoutMs: z.number().int().positive().max(RUNNER_TIMEOUT_CAP_MS).default(20_000),
    /** 参考解：runner 回归矩阵靠它自证"题目可解且判分正确" */
    referenceSolution: z.string().min(1).optional(),
    /**
     * 一段"看起来像答案但必然不过"的朴素解（要能编译/运行）。
     * 判题矩阵用它证明判题器不是橡皮图章——只有 referenceSolution 单边通过是发现不了
     * "判题器永远返回 pass"这类 bug 的。
     */
    naiveSolution: z.string().min(1).optional(),
  })
  .strict();

const QuestionShape = {
  schemaVersion: z.literal(1).default(1),
  id: QuestionId,
  category: z.enum(CATEGORY_IDS),
  difficulty: z.enum(['senior', 'principal']),
  title: z.string().min(6),
  statement: z.string().min(20),
  judgeKind: z.enum(JUDGE_KINDS),
  language: z.enum(LANGUAGES).optional(),
  tags: z.array(z.string().min(1)).min(1),
  cases: z.array(TestCase).min(1).optional(),
  rubric: Rubric.optional(),
  /** 参考答案要点（仅 server 内部使用，任何对外响应必须剥离） */
  answer: z.string().min(1).optional(),
  runner: RunnerConfig.optional(),
  estimatedMinutes: z.number().int().positive().max(90).default(20),
  source: Source,
};

const DraftShape = { ...QuestionShape, id: QuestionId.optional(), source: SourceDraft };

type RuleInput = {
  category?: unknown;
  judgeKind?: unknown;
  cases?: unknown;
  rubric?: unknown;
  runner?: unknown;
  answer?: unknown;
  source?: unknown;
};

const EXECUTABLE_KINDS: readonly string[] = JUDGE_KINDS.filter((k) => k !== 'llm-rubric');

function applyBusinessRules(data: RuleInput, ctx: z.RefinementCtx) {
  const kind = data.judgeKind as string | undefined;
  const category = data.category as string | undefined;
  const source = data.source as { origin?: string; jds?: unknown[]; company?: string } | undefined;

  if (kind && category && !CATEGORY_JUDGE_KINDS[category as keyof typeof CATEGORY_JUDGE_KINDS]?.includes(kind as never)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['judgeKind'],
      message: `类别 ${category} 不允许用 ${kind} 判题（允许：${CATEGORY_JUDGE_KINDS[category as keyof typeof CATEGORY_JUDGE_KINDS].join(', ')}）`,
    });
  }

  if (kind === 'llm-rubric') {
    if (!data.rubric) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rubric'], message: '主观题必须带 10 分制 rubric' });
    if (data.cases) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: '主观题不应携带可执行用例' });
  } else if (EXECUTABLE_KINDS.includes(kind ?? '')) {
    if (!data.cases || (data.cases as unknown[]).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: '代码题必须至少 1 个测试用例' });
    }
    const runner = data.runner as { referenceSolution?: string } | undefined;
    if (!runner?.referenceSolution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runner', 'referenceSolution'],
        message: '代码题必须携带参考解，供 runner 回归矩阵自证',
      });
    }
  }

  if (source?.origin === 'jd' && !(source.jds?.length ?? 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'jds'], message: 'origin=jd 必须至少一条 JD 出处' });
  }

  if (category === 'hot-interviews' && !source?.company) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'company'],
      message: '高频面试题必须标注来源公司（需求 场景 2）',
    });
  }
}

export const Question = z.object(QuestionShape).strict().superRefine(applyBusinessRules);
export type Question = z.infer<typeof Question>;

/** 刷新/生成脚本产出的草稿：可缺 id 与 ingestedAt，入库时补齐。 */
export const QuestionDraft = z.object(DraftShape).strict().superRefine(applyBusinessRules);
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export function toDraft(q: Question): QuestionDraft {
  const source = { ...q.source } as Record<string, unknown>;
  delete source.ingestedAt;
  return { ...q, source } as unknown as QuestionDraft;
}

export interface PublicRubric {
  maxScore: number;
  pointLabels: string[];
  points?: z.infer<typeof RubricPoint>[];
}

/**
 * 参考答案（文字要点 + 代码题的参考解）。
 *
 * 为什么单独一个形状、而不是给 `PublicQuestion` 加两个可选字段：
 * `publicQuestion()` 有 7 个调用方（今日套餐、题库列表、判题/评分响应、提交历史…），
 * 一旦让它能带上答案，"只有题目详情页给答案"就退化成一句约定。
 * 分成两个形状之后，其余端点想泄漏得先改签名 —— 边界是构造出来的，不靠人记得。
 *
 * 口径（rule.md C7，2026-09-21 用户拍板改成"答前可看"）：
 * 参考答案与参考解在题目详情页随取随给；rubric 的 `points`/`criteria` 仍然答完才展开。
 */
export interface QuestionReference {
  /** 题面要点与推导；没写就不给（不编造空串，前端要能如实说"这题没留档"） */
  answer?: string;
  /** 代码题的参考解正文；主观题没有这个 */
  solution?: string;
}

export function questionReference(q: Question): QuestionReference {
  const answer = q.answer?.trim();
  const solution = q.runner?.referenceSolution?.trim();
  return {
    ...(answer ? { answer } : {}),
    ...(solution ? { solution } : {}),
  };
}

/** 对外题目形态：绝不含 answer / runner.referenceSolution（走 `questionReference` 才有）。 */
export type PublicQuestion = Omit<Question, 'answer' | 'runner' | 'rubric'> & { rubric?: PublicRubric };

export function publicQuestion(q: Question, opts: { revealRubric?: boolean } = {}): PublicQuestion {
  const { answer: _answer, runner: _runner, rubric, ...rest } = q as Question & Record<string, unknown>;
  void _answer;
  void _runner;
  const out: Record<string, unknown> = { ...rest };
  const cases = (rest.cases ?? []) as { visible?: boolean }[];
  if (cases.some((c) => c.visible === false)) {
    // 隐藏用例只留名字：不剥的话 DevTools 里就能看到 expected，"隐藏"就成了前端装饰
    out.cases = cases.map((c) => (c.visible === false ? { name: (c as { name?: string }).name, input: null, expected: null, visible: false } : c));
  }
  if (rubric) {
    const revealed: PublicRubric = {
      maxScore: rubric.maxScore,
      pointLabels: rubric.points.map((p) => p.label),
    };
    // 答完并评分后才展开权重与判据（体验优先：反馈要具体）
    if (opts.revealRubric) revealed.points = rubric.points;
    out.rubric = revealed;
  }
  return out as unknown as PublicQuestion;
}

/**
 * 题库列表的一行（N-15）：够筛、够渲染、够排序 —— 就是不带 `statement` 与 `cases`。
 *
 * 体积比在 `BankResponse` 那边记着（真题库 252 题：完整形态 980KB → 列表行 72KB）。
 * 列表页对那两个字段各只有一个用途：`cases` 只为"几个用例"这个徽章，
 * `statement` 只为关键词搜索 —— 前者换成 `caseCount`，后者换成一次服务端搜索（它搜的是完整题面）。
 * 顺带收紧 C7 的失手面积：列表响应少带一类字段，就少一次"下次忘了剥"的机会。
 */
export interface BankRow {
  id: string;
  title: string;
  category: CategoryId;
  difficulty: 'senior' | 'principal';
  judgeKind: JudgeKind;
  tags: string[];
  company?: string;
  caseCount: number;
}

export function publicBankRow(q: Question): BankRow {
  return {
    id: q.id,
    title: q.title,
    category: q.category,
    difficulty: q.difficulty,
    judgeKind: q.judgeKind,
    tags: [...q.tags],
    ...(q.source.company ? { company: q.source.company } : {}),
    // 主观题没有用例；代码题给数量而不是内容
    caseCount: q.judgeKind === 'llm-rubric' ? 0 : (q.cases?.length ?? 0),
  };
}
