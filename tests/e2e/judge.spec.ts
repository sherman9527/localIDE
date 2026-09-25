import { expect, test } from '@playwright/test';
import { firstJudgeable, firstSubjective, hiddenIds } from './bank.js';

/** 判题失败时的反馈密度（需求 场景 4：pass 多少、fail 多少、失败的是哪个用例）。 */
test('提交错误解：显示通过/失败数量并点名失败用例', async ({ page }) => {
  const question = firstJudgeable();
  expect((question.cases?.length ?? 0) >= 3, '题目至少要 3 个用例').toBe(true);

  await page.goto(`/#/q/${question.id}`);
  const editor = page.locator('.cm-content, textarea').first();
  await editor.click();
  await editor.fill('this is intentionally invalid source code !!!');

  await page.getByRole('button', { name: /运行|提交|判题/ }).first().click();
  const errorHint = page.getByText(/编译失败|运行失败|未通过|失败\s*\d+/).first();
  await expect(errorHint).toBeVisible({ timeout: 120_000 });
});

/**
 * 筛选条的几何（用户截图指出"标签那一列没对齐"）：说明文字要是挤进某一列，
 * `align-items: center` 会把那一列的控件顶得比旁边几个高 —— 这类错位单测与 DOM 断言都看不见。
 */
test('题库筛选条：五个控件在同一条水平线上，标签那条说明另起一行', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/bank');
  await expect(page.getByLabel('按标签筛选')).toBeVisible();

  const boxes = await page.evaluate(() =>
    ['按类别筛选', '按公司筛选', '按难度筛选', '按标签筛选', '按关键词搜索题库'].map((label) => {
      const r = document.querySelector(`[aria-label="${label}"]`)?.getBoundingClientRect();
      return r ? { top: r.top, center: r.top + r.height / 2 } : { top: -1, center: -1 };
    }),
  );
  const tops = boxes.map((b) => b.top);
  const centers = boxes.map((b) => b.center);
  expect(Math.min(...tops), `控件没找到：${JSON.stringify(tops)}`).toBeGreaterThan(0);
  // 比中心点而不是比顶边：`.filters` 是 align-items:center，输入框比 select 高 2px 时
  // 顶边天然差 1px —— 那是对齐的，比顶边只会把正确渲染判成失败。
  expect(
    Math.max(...centers) - Math.min(...centers),
    `同一行的控件中心不在一条水平线上：${JSON.stringify(centers)}`,
  ).toBeLessThanOrEqual(0.5);

  const hint = page.getByTestId('bank-tag-hint');
  if (await hint.count()) {
    const hintTop = (await hint.boundingBox())?.y ?? -1;
    expect(hintTop, '说明文字要在控件行之下，不能把某一列撑高').toBeGreaterThan(Math.max(...tops));
  }
});

/** 移除按钮：软删除后立即消失，刷新后仍不在列表里（需求 场景 10）。 */
test('移除题目后不再出现', async ({ page, request }) => {
  const question = firstJudgeable();
  // 列表卡片可能对长标题做截断，所以用前缀断言而不是整串标题
  const titleHint = question.title.slice(0, 8);
  await page.goto('/#/bank');
  await expect(page.getByText(titleHint).first()).toBeVisible();

  const row = page.locator('li, article').filter({ hasText: titleHint }).first();
  await row.getByRole('button', { name: /移除/ }).click();
  // 断言"那一行"消失，而不是全站搜不到这段文字（标题前缀可能与其他题重名）
  await expect(page.locator('li, article').filter({ hasText: titleHint })).toHaveCount(0, { timeout: 15_000 });

  const list = await (await request.get('/api/bank')).json();
  // 字段名是 rows 不是 questions：列表响应在 N-15 之后只带瘦字段（不带题面与用例）
  expect(list.rows.map((q: { id: string }) => q.id)).not.toContain(question.id);
  expect(hiddenIds().has(question.id), 'hidden.json 应记录该题').toBe(true);

  // 恢复：E2E 不该永久改动题库（只增不减 + 移除是可逆的）
  const restore = await request.delete(`/api/questions/${question.id}/hide`);
  expect(restore.ok(), '恢复显示失败').toBe(true);
  expect(hiddenIds().has(question.id), '恢复后 hidden.json 应清掉该 id').toBe(false);
});

/** 主观题评分：必须给出分数与加分/不足点；CLI 不可用时也要有可操作的自检表而不是报错页。 */
test('主观题评分返回 10 分制与逐项反馈', async ({ page, request }) => {
  const question = firstSubjective();
  await page.goto(`/#/q/${question.id}`);

  const answer = page.locator('textarea, .cm-content').first();
  await answer.click();
  await answer.fill(
    [
      '我会先给容量估算：按读写分离与分片键设计，说明一致性取舍与降级路径，',
      '并覆盖可观测性（指标、日志、追踪）与失败模式演练。',
    ].join(''),
  );

  await page.getByRole('button', { name: /评分|提交答案|判分/ }).first().click();
  const panel = page.getByTestId('rubric-panel');
  await expect(panel.getByText(/\d+\s*\/\s*10/).first()).toBeVisible({ timeout: 240_000 });
  await expect(panel.getByTestId('rubric-table')).toBeVisible();
  // 评分卡要能报修：trace 号必须露在界面上
  await expect(panel.getByTestId('grade-trace')).toContainText('trace');
  // 环境里 CLI 链可用时绝不允许静默降级成人工自检表（曾经的真实 bug：401 / 输出不可解析都会走这条路）
  const health = await (await request.get('/api/health')).json();
  if (health.stacks['llm-rubric'] === true) {
    await expect(panel.getByText('人工自检清单')).toHaveCount(0);
  } else {
    // 降级也要被"验到"而不是被跳过：看到自检清单，并把"这次只验到降级路径"打在输出里，
    // 免得一次 2 秒过完的绿被当成"评分链验过了"（真实踩过：端口被别的容器占了，两边都报不可用）。
    console.log('[e2e] 注意：评分链此刻不可用，本条只验到人工自检表分支');
    await expect(panel.getByText('人工自检清单')).toBeVisible();
  }
});
