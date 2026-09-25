import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { firstJudgeable, referenceOf } from './bank.js';

interface AttemptDto {
  id: number;
  status: string;
  passed: number;
  failed: number;
  detail: { kind: string; submission?: string } | null;
}

async function attemptsOf(api: APIRequestContext, questionId: string): Promise<AttemptDto[]> {
  const body = await (await api.get(`/api/attempts?questionId=${questionId}&limit=30`)).json();
  return body.attempts as AttemptDto[];
}

const row = (page: Page, id: number) => page.locator(`[data-testid="attempt-row"][data-attempt-id="${id}"]`);

/**
 * N-05 判题历史回看：提交过一次，"挂在哪个用例、当时写了什么"就得留在服务端，
 * 刷新之后还能看到 —— 只验界面不验接口会把"其实刷新就没了"这件事放过去。
 *
 * 两条约束都是这一轮踩出来的：
 * ① 整个套件共用同一个隔离实例的库，所以只认"本次新增的那两条"（按 id 差集），不数总行数；
 * ② 等判题必须盯 judge-result 卡：历史行的摘要文案长得和"通过 N / 失败 0"一样，
 *    拿全局文本等会被上一行残留满足，测试就会赶在判题跑完之前 reload。
 */
test('提交历史留档到服务端：刷新后仍能看到两次提交与失败原因', async ({ page, request }) => {
  const question = firstJudgeable('algorithms');
  const marker = `HISTORY_${Date.now().toString(36)}`;
  const caseCount = question.cases?.length ?? 0;
  expect(caseCount, '题目要有用例，否则"挂在哪个用例"没得验').toBeGreaterThan(0);
  const before = await attemptsOf(request, question.id);

  await page.goto(`/#/q/${question.id}`);
  const editor = page.locator('.cm-content, textarea').first();
  const run = page.getByRole('button', { name: /运行|提交|判题/ }).first();
  const result = page.getByTestId('judge-result');

  // 第一次：故意交一份编译不过的，历史要留下"为什么没过"和当时那份代码
  await editor.click();
  await editor.fill(`// ${marker}\nthis is not valid java !!!`);
  await run.click();
  await expect(result.getByText(/运行失败|编译失败/).first()).toBeVisible({ timeout: 180_000 });

  // 第二次：参考解全过
  await editor.click();
  await editor.fill(referenceOf(question.id));
  await run.click();
  await expect(result.getByText('全部用例通过')).toBeVisible({ timeout: 180_000 });

  const after = await attemptsOf(request, question.id);
  const mine = after.filter((a) => !before.some((b) => b.id === a.id));
  expect(mine.map((a) => a.status), '两次提交都该落库且新的在前').toEqual(['pass', 'error']);
  expect(mine[0]!.passed).toBe(caseCount);
  expect(mine[0]!.failed).toBe(0);
  expect(mine[1]!.detail?.kind).toBe('judge');
  expect(mine[1]!.detail?.submission).toContain(marker);

  // 刷新：验的是服务端留档，不是页面里那点 state
  await page.reload();
  await expect(row(page, mine[0]!.id)).toContainText(`通过 ${caseCount} / 失败 0`);
  await expect(row(page, mine[1]!.id)).toContainText('运行失败');
  const idsInDom = await page.locator('[data-testid="attempt-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-attempt-id')));
  expect(idsInDom.indexOf(String(mine[0]!.id))).toBeLessThan(idsInDom.indexOf(String(mine[1]!.id)));

  await row(page, mine[1]!.id).getByTestId('expand-attempt').click();
  await expect(row(page, mine[1]!.id).getByTestId('attempt-detail')).toContainText(marker);
});

/** 自测跑的是自定义用例，不该污染复盘用的提交历史。 */
test('自测不进历史', async ({ page, request }) => {
  const question = firstJudgeable('frontend');
  const firstCase = (question.cases ?? [])[0];
  if (!firstCase) throw new Error(`${question.id} 没有用例，自测 spec 无从下手`);

  const before = await attemptsOf(request, question.id);

  await page.goto(`/#/q/${question.id}`);
  await page.locator('.cm-content, textarea').first().fill(question.runner?.referenceSolution ?? '');
  await page.locator('details.selftest summary').click();
  const args = Array.isArray(firstCase.input) ? firstCase.input : [firstCase.input];
  await page.getByTestId('selftest-input').fill(`${args.map((a) => JSON.stringify(a)).join(', ')} => ${JSON.stringify(firstCase.expected)}`);
  await page.getByTestId('selftest-run').click();
  await expect(page.getByTestId('selftest-result')).toContainText('通过', { timeout: 180_000 });

  const after = await attemptsOf(request, question.id);
  expect(after.map((a) => a.id), '自测不该写进提交历史').toEqual(before.map((a) => a.id));
});
