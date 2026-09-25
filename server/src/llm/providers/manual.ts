import type { Question, RubricPointVerdict, RubricVerdict } from '@arena/shared';
import type { LlmProvider } from '../provider.js';

/**
 * 最后兜底：不调 CLI、不发网络，只把 rubric 摊成一张**自检表**让人逐条确认。
 * `score: null` 表示"机器没资格给分"——由调用方（game 层）转成 `needs_human`。
 * 之所以 available() 恒 true：它不可能失败，一旦允许它失败就没有不抛 5xx 的路径了。
 */
export type ManualVerdict = Omit<RubricVerdict, 'score'> & { score: null };

export const MANUAL_FALLBACK_MAX_SCORE = 10;

function pointsOf(question: Question) {
  return question.rubric?.points ?? [];
}

export function manualChecklist(question: Question): RubricPointVerdict[] {
  return pointsOf(question).map((p) => ({
    label: p.label,
    hit: false,
    earned: 0,
    nextStep: p.criteria ? `自查：是否答到"${p.criteria}"（这条值 ${p.weight} 分）` : `自查：这条考点（${p.label}，${p.weight} 分）你答到了吗？`,
  }));
}

export function manualVerdict(question: Question, reason?: string): ManualVerdict {
  const points = pointsOf(question);
  const why = reason?.trim() ? `原因：${reason.trim()}` : '原因：本机 LLM provider 不可用或输出无法解析。';
  const header = question.rubric
    ? `${why}\n下面是逐项自检表，勾完即为你的得分（满分 ${question.rubric.maxScore}）。`
    : `${why}\n题目缺少 rubric（question.rubric 为空），无法给出结构化评分，请人工判分。`;
  return {
    score: null,
    maxScore: question.rubric?.maxScore ?? MANUAL_FALLBACK_MAX_SCORE,
    bonus: [],
    gaps: points.map((p) => `${p.label}（${p.weight} 分）待自查`),
    rubricBreakdown: manualChecklist(question),
    provider: 'manual',
    durationMs: 0,
    raw: header,
  };
}

/** manual provider 拿不到题目（接口只给 prompt），故用一个占位 rubric 让返回形状合法。 */
const NO_QUESTION_STUB = {
  rubric: {
    maxScore: 10,
    points: [
      { label: '请在页面上查看本题 rubric 考点', weight: 5 },
      { label: '逐条自查是否答到', weight: 5 },
    ],
  },
} as unknown as Question;

/** 交给只需要"一段文本"的调用方（形状与 LLM 输出一致，score=null 表示待人工）。 */
export function manualSelfCheckJson(question: Question = NO_QUESTION_STUB, reason?: string): string {
  const v = manualVerdict(question, reason);
  return JSON.stringify({
    score: null,
    bonus: v.bonus,
    gaps: v.gaps,
    rubricBreakdown: v.rubricBreakdown,
    note: v.raw,
  });
}

export const manualProvider: LlmProvider = {
  kind: 'manual',
  async available() {
    return true;
  },
  async complete() {
    // 不接题目上下文也没关系：grade() 会用题目自己重建自检表。
    return manualSelfCheckJson(undefined, 'manual provider 自检表');
  },
};
