import { expect, test } from '@playwright/test';
import { firstJudgeable, referenceOf } from './bank.js';

/**
 * 参考答案面板（WI-58）：答前可看，但**只有题目详情这一个口子**带答案。
 * 两条断言各守一边，缺一条就是半成品：
 * ① 界面真能展开看到参考解 —— 单测里能看到不等于用户在浏览器里看得到；
 * ② 今日套餐 / 题库列表的响应里确实没有答案 —— 那里有了就等于 C7 的口子开了。
 */
test('题目详情页能展开参考答案；答案不出现在其他接口', async ({ page, request }) => {
  const question = firstJudgeable('algorithms');
  const signature = question.runner?.signature ?? '';
  expect(referenceOf(question.id), '题目要有参考解').toContain(signature);

  await page.goto(`/#/q/${question.id}`);
  const card = page.getByTestId('reference-answer');
  await expect(card).toBeVisible();

  // 默认收起，且正文根本不在 DOM 里（不是 visibility:hidden 那种"看不见但其实都在"）
  await expect(page.getByTestId('reference-body')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '展开' })).toHaveAttribute('aria-expanded', 'false');

  await card.getByRole('button', { name: '展开' }).click();
  const body = page.getByTestId('reference-body');
  await expect(body).toBeVisible();
  // 断到签名而不是断到"class Solution"：前者证明渲染的就是这道题的那份参考解
  await expect(body.locator('pre').first()).toContainText(signature);

  const surfaces: readonly (readonly [string, string])[] = [
    ['今日套餐', await (await request.get('/api/challenge/today')).text()],
    ['题库列表', await (await request.get('/api/bank')).text()],
    ['提交历史', await (await request.get('/api/attempts?questionId=' + question.id)).text()],
  ];
  for (const [label, text] of surfaces) {
    expect(text, `${label} 的响应里出现了 answer 字段`).not.toContain('"answer"');
    expect(text, `${label} 的响应里出现了参考解`).not.toContain('referenceSolution');
  }
});
