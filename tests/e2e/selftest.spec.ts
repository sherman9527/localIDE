import { expect, test } from '@playwright/test';
import { firstJudgeable } from './bank.js';

/**
 * 自测通道：一行一组自定义用例，只给反馈、不写答题记录、不给 XP。
 * 这条断言的是"不记分"这个契约 —— 否则用户可以用自测反复刷 XP。
 */
test('自测用例不写 attempt、不影响进度', async ({ page, request }) => {
  const question = firstJudgeable();
  await page.goto('/#/');
  const before = await (await request.get('/api/progress')).json();

  const cases = (question.cases ?? []).slice(0, 2).map((c) => ({ name: c.name, input: c.input, expected: c.expected }));
  expect(cases.length, '题目至少要有 2 个用例可用于自测').toBeGreaterThanOrEqual(2);

  const res = await request.post('/api/judge', {
    data: { questionId: question.id, submission: question.runner?.referenceSolution, customCases: cases },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  expect(body.mode).toBe('test');
  expect(body.result.status).toBe('pass');
  expect(body.result.total).toBe(cases.length);

  const after = await (await request.get('/api/progress')).json();
  expect(after.xp, '自测不该加 XP').toBe(before.xp);
  expect(after.byCategory?.[question.category]?.answered ?? 0).toBe(before.byCategory?.[question.category]?.answered ?? 0);
});

test('自测在界面上可完成：填一行用例并看到通过统计', async ({ page }) => {
  const question = firstJudgeable();
  await page.goto(`/#/q/${question.id}`);
  const firstCase = (question.cases ?? [])[0];
  if (!firstCase) throw new Error(`${question.id} 至少要有 1 个用例，自测 spec 无从下手`);

  await page.locator('.cm-content, textarea').first().fill(question.runner?.referenceSolution ?? '');
  // 自测面板是 <details>，必须先点开 summary 才能填里面的 textarea
  await page.locator('details.selftest summary').click();
  const input = page.getByTestId('selftest-input');
  const args = Array.isArray(firstCase.input) ? firstCase.input : [firstCase.input];
  await input.fill(`${args.map((a) => JSON.stringify(a)).join(', ')} => ${JSON.stringify(firstCase.expected)}`);
  await page.getByTestId('selftest-run').click();
  await expect(page.getByTestId('selftest-result')).toContainText('通过', { timeout: 120_000 });
});
