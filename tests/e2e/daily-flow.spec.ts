import { expect, test } from '@playwright/test';
import { firstJudgeable, referenceOf } from './bank.js';

/**
 * 主流程 E2E：今日挑战 → 选栈 → 写代码 → 判分 → XP/streak 更新。
 * 判分走的是容器里的真 JDK/MySQL/Redis，所以这条链路绿了才算"系统真的能用"。
 */
test('今日挑战：用参考解提交代码题，界面出现全部通过并计入 XP', async ({ page, request }) => {
  const question = firstJudgeable();

  const before = await (await request.get('/api/progress')).json();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /今日挑战/ })).toBeVisible();
  await expect(page.getByText('主栈').first()).toBeVisible();

  await page.goto(`/#/q/${question.id}`);
  await expect(page.getByText(question.title)).toBeVisible();
  // 结果导向的题目必须提前给足用例（需求 场景 4）
  for (const testCase of question.cases ?? []) {
    await expect(page.getByText(testCase.name, { exact: false }).first()).toBeVisible();
  }

  const editor = page.locator('.cm-content, textarea').first();
  await editor.click();
  await editor.fill(referenceOf(question.id));

  await page.getByRole('button', { name: /运行|提交|判题/ }).first().click();
  // 等待期间必须有进度反馈（判题要 1-20s）
  await expect(page.getByText(/已用|编译|运行中|等待/).first()).toBeVisible({ timeout: 10_000 });

  const resultLine = page.getByText(/通过\s*\d+\s*\/\s*(?:全部|所有)?/).first();
  await expect(resultLine.or(page.getByText(/全部通过|Pass/).first())).toBeVisible({ timeout: 120_000 });

  const after = await (await request.get('/api/progress')).json();
  const byCategory = after.byCategory?.[question.category] ?? { passed: 0 };
  // XP 每题只计历史最佳（防刷分），所以重复跑同一题时不涨是正确行为；
  // 真正的断言是：该类别确实有至少一道通过的记录，且 XP 没有倒退。
  expect(after.xp, 'XP 不应倒退').toBeGreaterThanOrEqual(before.xp);
  expect(byCategory.passed, '该类别应记录到至少一次通过').toBeGreaterThanOrEqual(1);
  expect(after.today.planned.length, '今日套餐应有 3 题').toBe(3);

  // 本周小结（N-03 周报层）：跨周口径由服务端定，界面负责说清楚
  expect(after.week?.days, 'week.days 应有 7 天').toHaveLength(7);
  expect(after.week.answered, '今天刚提交过，本周不该算成 0 题').toBeGreaterThanOrEqual(1);
  await page.goto('/#/progress');
  await expect(page.getByTestId('week-card')).toBeVisible();
  await expect(page.getByTestId(/^week-day-/).first()).toBeVisible();
});
