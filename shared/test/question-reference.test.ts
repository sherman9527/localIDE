import { describe, expect, it } from 'vitest';
import { Question, publicQuestion, questionReference } from '../src/question.js';

/**
 * 参考答案的唯一出口（rule.md C7 改口径后：答案在题目详情页答前即可看，
 * 但**只有这一处** —— 所以这里同时钉住"publicQuestion 依旧剥光"）。
 */

const codeQuestion = Question.parse({
  id: 'alg-java-0001',
  category: 'algorithms',
  difficulty: 'senior',
  title: '在严格 O(n) 空间约束下定位重复区间',
  statement: '给定按时间排序的事件流，找出最长的一段连续区间，使得区间内 user_id 不重复。',
  judgeKind: 'java-junit',
  language: 'java',
  tags: ['sliding-window'],
  cases: [{ name: '空输入返回 0', input: [], expected: 0 }],
  answer: '单遍哈希记 last-seen，左指针只前进不回退。',
  runner: { className: 'Solution', referenceSolution: 'class Solution { int solve(int[] a){ return 0; } }' },
  source: { origin: 'manual', ingestedAt: '2026-09-19T02:00:00.000Z' },
});

const rubricQuestion = Question.parse({
  id: 'sys-rubric-0001',
  category: 'system-design',
  difficulty: 'principal',
  title: '对话与批量混跑的推理集群怎么选型',
  statement: '线上同时跑对话与批量生成时，你选 PD 分离还是加机器？给出判断依据而不是立场。',
  judgeKind: 'llm-rubric',
  tags: ['llm-inference'],
  rubric: { maxScore: 10, points: [{ label: '瓶颈假设验证', weight: 6, criteria: '是否先给可执行判据' }, { label: '故障模式', weight: 4 }] },
  answer: '先证明 prefill/decode 互相阻塞，再谈分离。',
  source: { origin: 'manual', company: 'DeepSeek', ingestedAt: '2026-09-19T02:00:00.000Z' },
});

describe('questionReference', () => {
  it('代码题同时给文字要点与参考解', () => {
    const ref = questionReference(codeQuestion);
    expect(ref.answer).toContain('单遍哈希');
    expect(ref.solution).toBe('class Solution { int solve(int[] a){ return 0; } }');
  });

  it('主观题只有要点，没有参考解', () => {
    const ref = questionReference(rubricQuestion);
    expect(ref.answer).toContain('先证明');
    expect(ref.solution).toBeUndefined();
  });

  it('题目没有写要点时不编造空串（前端要能如实说"这题没留档"）', () => {
    const bare = Question.parse({ ...codeQuestion, answer: undefined });
    expect(questionReference(bare).answer).toBeUndefined();
  });

  it('publicQuestion 依旧不带 answer / referenceSolution —— 放宽只发生在详情这一处', () => {
    const json = JSON.stringify({
      detailQuestion: publicQuestion(codeQuestion),
      todayLike: [publicQuestion(codeQuestion), publicQuestion(rubricQuestion)],
    });
    expect(json).not.toContain('单遍哈希');
    expect(json).not.toContain('referenceSolution');
    expect(json).not.toContain('class Solution');
    expect(json).not.toContain('"answer"');
  });
});
