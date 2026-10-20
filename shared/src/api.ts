import type { CategoryId } from './taxonomy.js';
import type { AttemptDetail } from './attempt.js';
import type { JudgeEvent, JudgeResult, RubricVerdict } from './judge.js';
import type { BankRow, PublicQuestion, QuestionReference } from './question.js';
import type { DailyPlan, LeagueTier, WeekSummary } from './game.js';

export const API_PREFIX = '/api';

export interface StackHealth {
  ok: boolean;
  version: string;
  stacks: Record<string, boolean>;
  llmProviders: string[];
}

export interface CategorySummary {
  id: CategoryId;
  label: string;
  stack: string;
  total: number;
  hidden: number;
  /** 该类别今日套餐内的题数 */
  todayPlanned: number;
}

export interface CategoriesResponse {
  categories: CategorySummary[];
}

export interface TodayResponse {
  date: string;
  plan: DailyPlan;
  /** 主栈 2 道代码题 + 副栈 1 道主观题 */
  questions: PublicQuestion[];
  /** questions 里哪些是"到期复习"插入的题（游戏层信息，不进题目契约） */
  reviewIds: string[];
  /** 单独选栈练习时的补充池 */
  practice?: PublicQuestion[];
  progress: {
    answered: number;
    passed: number;
    xpToday: number;
    streakSafe: boolean;
  };
}

export interface QuestionResponse {
  question: PublicQuestion;
}

/**
 * 题目详情：比通用形态多带一份参考答案。
 * 这是答案面向答题者的**唯一**出口（其余响应一律只出 `QuestionResponse` 那一类形状）。
 */
export interface QuestionDetailResponse extends QuestionResponse {
  reference: QuestionReference;
}

/** 自测用例：一行一组，`输入 => 期望`，值一律用 JSON 写（服务端拿它现造用例，不记分）。 */
export interface CustomCase {
  name?: string;
  input: readonly unknown[];
  expected: unknown;
}

export interface JudgePostRequest {
  questionId: string;
  submission: string;
  extraFiles?: { path: string; content: string }[];
  /** 客户端可带上语言提示；服务端最终以题目 language 为准 */
  language?: string;
  /** 传了就是一次"自测"：只跑这些用例，不写 attempt、不给 XP */
  customCases?: readonly CustomCase[];
}

/** POST /api/judge/stream 返回 SSE，事件体即 JudgeEvent；此响应为兜底的同步结果。 */
export interface JudgePostResponse {
  result: JudgeResult;
  best?: { status: JudgeResult['status']; at: string } | null;
  /** 本次是自测（不记分）还是正式提交 */
  mode?: 'official' | 'test';
  /** 本次作答带来的 XP 增量（重复提交已通过的题可能是 0） */
  xpDelta?: number;
  xpToday?: number;
  /** 出问题时把这串号报给我，`npm run logs -- --trace <id>` 就能捞到整条链路 */
  traceId?: string;
}

export interface GradePostRequest {
  questionId: string;
  answer: string;
}

export interface GradePostResponse {
  verdict: RubricVerdict;
  /** 评分完成后才展开 rubric 权重与判据 */
  question: PublicQuestion;
  /** 评分链路的追踪号（provider 失败/降级时靠它查日志） */
  traceId?: string;
}

/** 一次正式提交的留档（N-05 复盘）：过没过 + 挂在哪个用例 + 当时写了什么。 */
export interface AttemptHistoryEntry {
  id: number;
  questionId: string;
  kind: 'judge' | 'grade';
  status: string;
  score: number | null;
  maxScore: number | null;
  xp: number;
  passed: number;
  failed: number;
  durationMs: number;
  createdAt: string;
  day: string;
  /** null = 这一条没有留档（v1 时代的老数据），UI 要说明而不是显示"没有失败用例" */
  detail: AttemptDetail | null;
}

export interface AttemptsResponse {
  questionId: string;
  attempts: AttemptHistoryEntry[];
}

export interface CategoryProgress {
  answered: number;
  passed: number;
  accuracy: number;
  xp: number;
}

export interface ProgressResponse {
  xp: number;
  xpToday: number;
  streakDays: number;
  streakLongest: number;
  league: { id: LeagueTier['id']; label: string; nextAt: number | null };
  achievements: { id: string; label: string; hint: string; unlocked: boolean }[];
  today: { planned: string[]; answered: string[]; passed: string[]; done: boolean };
  /** 错题本（间隔重复）：在册待复习数 / 今日到期数 / 最久没碰的天数 */
  review: { tracked: number; dueToday: number; oldestDays: number | null };
  /** 本周小结（周一至今日所在周日） */
  week: WeekSummary;
  calendar: { date: string; xp: number; answered: number; passed: number }[];
  byCategory: Partial<Record<CategoryId, CategoryProgress>>;
}

export interface BankQuery {
  category?: CategoryId;
  difficulty?: 'senior' | 'principal';
  tag?: string;
  q?: string;
  includeHidden?: boolean;
}

/**
 * 列表响应（N-15）：只带"够筛、够渲染、够排序"的字段，**不带 `statement` 与 `cases`**。
 *
 * 那两个字段在整表响应里占 ~93%（实测 252 题：完整形态 980KB → 列表行 72KB），
 * 而列表页对它们各只有一个用途：`cases` 只为"几个用例"这个徽章（换成 `caseCount`），
 * `statement` 只为关键词搜索（换成服务端 `q=` —— 客户端本来就不该留一份正文）。
 * 顺带收紧 C7 的失手面积：列表少带一类字段，就少一次"下次忘了剥"的机会。
 *
 * `tags` / `companies` 是**筛选项本身**，按全库算而不是按筛选结果算 ——
 * 否则一搜索，下拉里的选项就会自己缩水，看起来像"题库里没这些标签了"。
 */
/**
 * 标签下拉的频次门槛（N-17）。**放在 shared 是因为界面也要照它说话**：
 * 服务端按它筛 facet，界面按它解释"为什么这里只有几十个、而题库里有近千种写法"。（**故意不写具体数**：这两个数随题库漂移，写进注释就一定会过期 —— 实测数在 `HANDOVER.md` 的 N-17 条目里带日期存着。）
 * 阈值以下的标签没丢：`q=` 的 haystack 里有 tags，搜得到也还能当 `tag=` 的筛选值用。
 *
 * 归并层（`tagVocabulary.ts`）落地之后，这个 3 判的是**规范名合起来的题数**，
 * 不是某一种拼法出现的次数 —— 这正是这一层存在的理由：一道题写 `window-function`、
 * 另一道写 `window-functions`，分开数谁都不到门槛，合起来才配占一个下拉位。
 */
export const TAG_FACET_MIN_COUNT = 3;

export interface BankResponse {
  rows: BankRow[];
  hiddenIds: string[];
  total: number;
  /**
   * 出现 ≥ `TAG_FACET_MIN_COUNT` 次的标签，按频次降序、同频按名字。
   * 名字是**规范名**（词表归并后），`count` 是"同组写法合起来的题数"—— 见 `tagGroups`。
   */
  tags: { name: string; count: number }[];
  /**
   * 全库**不同写法**数（原词口径，不只是下拉里这些）：让界面说清被频次挡住的那部分有多少。
   *
   * ⚠ 它与 `tags.length` 数的不是同一个东西，谁都不许被"顺手统一"成另一个：
   * 这里数的是**题目里真实存着多少种拼法**（数据没被改过，这个数就必须按原词算），
   * `tags` 数的是**归并后还剩几个筛选项**。加了归并层之后，前者的下降才是词表在做的事，
   * 后者的上升（同一个考点从几种写法收拢成一个）是它的结果。
   */
  tagCount: number;
  /**
   * 同义词表本身（canonical + aliases）。
   * 客户端筛标签要用它 —— 题库页除关键词外全在客户端筛，服务端再对也无济于事，
   * 所以判据必须随响应到这里，两边调同一个 `tagMatches`，不许各猜一次。
   * 只带筛选要用的两个字段：`reason` 是给人看的，不进响应。
   */
  tagGroups: { canonical: string; aliases: string[] }[];
  companies: { name: string; count: number }[];
  /** 没有公司标签的题数：早期按类别出的那批不是"没数据"，是一个真实存在的桶 */
  unlabeled: number;
}

export interface HideResponse {
  id: string;
  hidden: boolean;
}

export type { JudgeEvent };
