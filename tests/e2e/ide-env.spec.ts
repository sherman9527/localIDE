import { expect, test } from '@playwright/test';

/**
 * IDE 依赖环境面板在真浏览器里的路径。
 *
 * **这里不装真包**：装包要联网，而 E2E 一旦依赖外部索引就会随机红，
 * 那种红没人敢信。"装 → 用 → reset → 再用不到"的完整闭环由
 * `server/test/ide/env-lifecycle.test.ts` 在容器里用本地路径安装验掉（不依赖网络）。
 *
 * E2E 负责的是只有真浏览器才看得见的东西：
 * ① 面板真的挂在右栏、换语言后只剩一个实例（WI-81 那类 key 复用故障）；
 * ② 白名单的拒绝要一路穿到界面上说得出原因 —— 后端拒了但界面没显示，等于用户点了没反应；
 * ③ console 里 error 与 warning 都为 0（本项目三个"静默降级"都是这么暴露的）。
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/ide');
  await expect(page.getByRole('heading', { name: '网页 IDE' })).toBeVisible();
});

const panel = (page: import('@playwright/test').Page) => page.getByTestId('ide-env');

test('环境面板出现在右栏，并常驻"判题器看不到"这句话', async ({ page }) => {
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('ide-env-command')).toBeVisible();
  await expect(page.getByTestId('ide-env-reset')).toBeVisible();
  await expect(panel(page).getByText(/判题器看不到/)).toBeVisible();
});

test('换语言后面板只剩一个实例，且没有 React 重复 key 告警', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') warnings.push(msg.text());
  });

  await expect(panel(page)).toHaveCount(1);
  await page.getByLabel('语言').selectOption('java');
  await expect(panel(page)).toHaveCount(1);
  await page.getByLabel('语言').selectOption('python');
  await expect(panel(page)).toHaveCount(1);

  expect(warnings.filter((w) => w.includes('unique "key"'))).toEqual([]);
});

test('白名单拒绝要一路穿到界面上：输入 sh -c 会看到被拒的原因，而不是"点了没反应"', async ({ page }) => {
  const input = page.getByTestId('ide-env-command');
  await input.fill('sh -c echo hi');
  await page.getByTestId('ide-env-run').click();

  const log = page.getByTestId('ide-env-log');
  await expect(log).toBeVisible();
  await expect(log).toContainText('白名单');
});

test('空命令不给执行（避免把 "$ " 这种空行灌进日志冒充输出）', async ({ page }) => {
  await expect(page.getByTestId('ide-env-run')).toBeDisabled();
  await page.getByTestId('ide-env-command').fill('   ');
  await expect(page.getByTestId('ide-env-run')).toBeDisabled();
});

test('切到没有依赖环境的语言：给原因，并且不出现命令输入框', async ({ page }) => {
  await page.getByLabel('语言').selectOption('c');
  await expect(page.getByTestId('ide-env-unsupported')).toBeVisible();
  await expect(page.getByTestId('ide-env-unsupported')).toContainText('apt');
  await expect(page.getByTestId('ide-env-command')).toHaveCount(0);
});

test('pip3 list 能跑通并把输出显示出来（不联网，验的是整条 SSE 通路）', async ({ page }) => {
  await page.getByTestId('ide-env-command').fill('pip3 list');
  await page.getByTestId('ide-env-run').click();

  const log = page.getByTestId('ide-env-log');
  await expect(log).toContainText('$ pip3 list');
  // pip 的表头一定在输出里；没有它就是说流断了
  await expect(log).toContainText('Package', { timeout: 60_000 });
});

test('重置要二次确认；确认后日志报告释放的体积', async ({ page }) => {
  let dialogMessage = '';
  page.on('dialog', async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });

  await page.getByTestId('ide-env-reset').click();
  await expect(page.getByTestId('ide-env-log')).toContainText('已重置', { timeout: 60_000 });
  // 确认框必须说清会关掉活的会话 —— 只写"确定吗"等于没告知后果
  expect(dialogMessage).toContain('REPL');
});
