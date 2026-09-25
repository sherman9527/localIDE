import { expect, test } from '@playwright/test';

/**
 * 网页 IDE（WI-64）在真浏览器里的端到端路径。
 *
 * 为什么单测 + 容器矩阵绿了还要这一条：javascript 与 typescript 曾经就是那样坏着的 ——
 * 沙箱落在 type:module 的仓库里（require 变成 ESM）＋ tsc 从沙箱向上把仓库的 @types/react-dom
 * 拖进编译。两条都是"界面照常渲染、点运行才炸"，而炸的又是**注册表里那份 sample**。
 * 所以这里跑的是用户真会跑的东西：浏览器里选语言 → 改代码 → 点运行 → 看 stdout。
 */

const STDIN = '21\n';
/** 六段程序都打印同一个 `ide-e2e 42`：断言只有一处，改语言清单时不会漏掉谁。 */
const PROGRAMS: readonly (readonly [string, string])[] = [
  ['python', 'print("ide-e2e", int(input()) * 2)\n'],
  ['java', 'import java.util.Scanner;\n'
    + 'public class Main { public static void main(String[] a) {\n'
    + '  int n = new Scanner(System.in).nextInt();\n'
    + '  System.out.println("ide-e2e " + (n * 2));\n'
    + '} }\n'],
  ['javascript', 'const n = parseInt(require("fs").readFileSync(0, "utf8"), 10);\n'
    + 'console.log("ide-e2e " + n * 2);\n'],
  ['typescript', 'const n: number = parseInt(require("fs").readFileSync(0, "utf8"), 10);\n'
    + 'console.log("ide-e2e " + n * 2);\n'],
  ['c', '#include <stdio.h>\n'
    + 'int main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("ide-e2e %d\\n", n * 2); return 0; }\n'],
  ['cpp', '#include <iostream>\n'
    + 'int main() { int n; std::cin >> n; std::cout << "ide-e2e " << n * 2 << std::endl; }\n'],
];

const EDITOR = '[aria-label="IDE 代码编辑器"]';

test('选语言 → 写代码 → 运行：六门语言都真出结果', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await expect(select).toBeVisible();

  const options = select.locator('option');
  // 注册表 + 4：mysql / redis / pyspark / spark-scala 不走 stdout（它们有自己的断言）。
  // 写死 +4 是有意的 —— 以后加语言却不给它任何端到端覆盖，这里会先红。
  await expect(options).toHaveCount(PROGRAMS.length + 4);
  // 镜像里少一个工具链就是"选得到、跑不动"，这里直接指名是谁
  await expect(select.locator('option', { hasText: '本机不可用' })).toHaveCount(0);

  for (const [id, code] of PROGRAMS) {
    await select.selectOption(id);
    const editor = page.locator(EDITOR);
    await editor.click();
    await editor.fill(code);
    // 标准输入框由 <label> 包裹，用可读的标签名定位而不是"第几个 textarea"
    await page.getByLabel(/标准输入/).fill(STDIN);

    await page.getByRole('button', { name: /运行/ }).click();
    const panel = page.getByLabel('运行结果');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel, `${id} 没跑成功`).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
    await expect(panel.locator('pre').first()).toContainText('ide-e2e 42');
  }

  expect(consoleErrors, `控制台报错：${consoleErrors.join(' | ')}`).toEqual([]);
});


test('格式化按钮在真浏览器里改动编辑器内容（复用答题页那套规则）', async ({ page }) => {
  await page.goto('/#/ide');
  const doc = page.locator('.cm-content');
  await page.getByLabel('语言').selectOption('mysql');
  // 先等"换语言带出的样例"真的落地，再改内容：换语言会异步 setCode(样例)，
  // 抢在它之前打字，格式化拿到的 state 与界面显示的 doc 就不是同一份（第一版就是这么误报的）。
  await expect(doc).toContainText('一次性库');

  await doc.click();
  // 故意写成一行小写关键词：sql-formatter 会把关键词大写并拆行
  await page.keyboard.press('Control+A');
  await page.keyboard.type('select a, b from t where a > 1;');
  await expect(doc).toHaveText('select a, b from t where a > 1;');

  await page.getByRole('button', { name: /格式化/ }).click();
  await expect(page.getByTestId('ide-format-note')).toHaveText(/已格式化/);
  // 断言用自动重试的 toContainText，而不是先 innerText 抓一张快照再比 —— 后者会读到
  // React 还没写回视图的那一刻，把"生效了"读成"没生效"。
  await expect(doc).toContainText('SELECT');
  await expect(doc).toContainText('WHERE');
});

test('SQL 与 Redis：结果走表格 / 逐条回复，且预置语句框只在需要时出现', async ({ page }) => {
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await expect(select).toBeVisible();

  // python 不该有预置框（有的话说明它是按"第几个 textarea"定位的，而不是按语言）
  await select.selectOption('python');
  await expect(page.getByTestId('ide-setup')).toHaveCount(0);

  await select.selectOption('mysql');
  const setupBox = page.getByTestId('ide-setup');
  await expect(setupBox).toBeVisible();
  await setupBox.fill(`CREATE TABLE t (id INT, status VARCHAR(8) NOT NULL);
INSERT INTO t VALUES (1,'paid'),(2,'paid'),(3,'refunded');`);
  const editor = page.locator(EDITOR);
  await editor.click();
  await editor.fill('SELECT status, COUNT(*) AS n FROM t GROUP BY status ORDER BY status;');
  await page.getByRole('button', { name: /运行/ }).click();
  const sqlPanel = page.getByLabel('运行结果');
  await expect(sqlPanel).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
  await expect(sqlPanel.locator('table')).toBeVisible();
  await expect(sqlPanel.getByRole('cell', { name: 'paid' })).toBeVisible();
  await expect(sqlPanel.getByRole('cell', { name: '3' })).toHaveCount(0); // n 是 2 不是 3
  await expect(sqlPanel.getByRole('cell', { name: '2' })).toBeVisible();

  await select.selectOption('redis');
  await page.getByTestId('ide-setup').fill(`ZADD lb 10 a
ZADD lb 20 b`);
  await editor.click();
  await editor.fill('ZREVRANGE lb 0 -1 WITHSCORES');
  await page.getByRole('button', { name: /运行/ }).click();
  const redisPanel = page.getByLabel('运行结果');
  await expect(redisPanel).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
  await expect(redisPanel.getByText('逐条回复')).toBeVisible();
  await expect(redisPanel.getByText('"b"').first()).toBeVisible();

  // 白名单在真界面上也生效：被拒时给的是"未执行 + 原因"，不是一个空结果
  await editor.click();
  await editor.fill('FLUSHALL');
  await page.getByRole('button', { name: /运行/ }).click();
  await expect(redisPanel).toHaveAttribute('data-status', 'rejected', { timeout: 30_000 });
  await expect(redisPanel.getByText(/FLUSHALL/)).toBeVisible();
});

test('PySpark：常驻会话里的预置 SQL 与表格结果，在真界面上看得见', async ({ page }) => {
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await select.selectOption('pyspark');
  // Spark 的预算与命令型语言不同，界面必须说清楚（否则一次十几秒的运行看起来像卡死）
  await expect(page.getByTestId('ide-budget')).toHaveText(/最长 120s/);
  const setupBox = page.getByTestId('ide-setup');
  await expect(setupBox).toBeVisible();
  await setupBox.fill('CREATE OR REPLACE TEMP VIEW vw_ide_e2e AS SELECT 7 AS n UNION ALL SELECT 8 AS n');
  const editor = page.locator(EDITOR);
  await editor.click();
  await editor.fill('print(f"spark rows={spark.table(\'vw_ide_e2e\').count()}")\nresult = spark.table("vw_ide_e2e")\n');
  await page.getByRole('button', { name: /运行/ }).click();
  const panel = page.getByLabel('运行结果');
  // 第一次跑要付 SparkSession 冷启动（实测 8.9s），判题刚跑完时还要排队 —— 给到 150s 而不是 60s
  await expect(panel).toHaveAttribute('data-status', 'ok', { timeout: 150_000 });
  await expect(panel.locator('pre').first()).toContainText('spark rows=2');
  await expect(panel.getByRole('cell', { name: '7' })).toBeVisible();

  // 视图不该留给下一次运行（会话是与判题共用的，每次运行都在自己的 newSession 里）。
  // 两处都必须显式清：① 预置框还写着 CREATE VIEW 的话，第二次运行会自己把视图重建出来，
  // 这条断言就什么都没验；② 探针要带 count() 这种**动作** —— spark.table() 本身惰性，
  // 不触发解析就看不出视图已不在，同样会假绿。
  await setupBox.fill('');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('spark.table("vw_ide_e2e").count()');
  await page.getByRole('button', { name: /运行/ }).click();
  await expect(panel).toHaveAttribute('data-status', 'runtime_error', { timeout: 150_000 });
});

test('REPL 会话：上一句定义的变量，下一句读得回来（跨句状态是真的）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });   // 并排只在 ≥1100px 生效，别跟着默认视口漂
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await select.selectOption('python');
  const panel = page.getByLabel('REPL 会话');
  await expect(panel).toBeVisible();
  const log = page.getByTestId('ide-repl-log');

  // 位置是这一条的重点之一（用户原话："放在下面感觉不容易使用"）：断言几何而不是"元素存在"。
  // 对齐的是**整栏**（.ide-side），不是面板自己：调试面板加进来之后它排在 REPL 上面。
  const editorBox = await page.locator('.ide-pane').boundingBox();
  const sideBox = await page.locator('.ide-side').boundingBox();
  expect(editorBox && sideBox, '编辑器与右栏都要有尺寸').toBeTruthy();
  expect(sideBox!.x).toBeGreaterThanOrEqual(editorBox!.x + editorBox!.width - 2);   // 在右边
  expect(Math.abs(sideBox!.y - editorBox!.y)).toBeLessThan(4);                      // 同一行，没掉到下面
  await expect(panel.locator('xpath=ancestor::div[contains(@class,"ide-side")]')).toHaveCount(1);

  const input = page.getByTestId('ide-repl-input');
  await input.fill('answer = 6 * 7');
  await page.getByTestId('ide-repl-send').click();
  // 第一句要等解释器起进程（python 冷启动），后面几句才是真的快
  await expect(log).toContainText('answer = 6 * 7', { timeout: 60_000 });
  await expect(page.getByTestId('ide-repl-count')).toHaveText('会话 1 / 2');

  await input.fill('print(answer)');
  await page.getByTestId('ide-repl-send').click();
  await expect(log).toContainText('42');

  // 关会话要真的通知后端（会话是活进程，漏关就是攒孤儿解释器）
  await page.getByRole('button', { name: '关会话' }).click();
  await expect(page.getByTestId('ide-repl-note')).toContainText('会话已关闭');
  await expect(page.getByTestId('ide-repl-count')).toHaveText('会话 0 / 2');

  // 没有交互式运行时的语言不该出现这个面板
  await select.selectOption('mysql');
  await expect(page.getByLabel('REPL 会话')).toHaveCount(0);
});

/**
 * 行断点的整条路：点行号 → 停在那一行 → 看得到变量 → 单步会走。
 *
 * 最后那半条（换语言之后面板必须跟着没）不是顺手加的：两个面板一度共用同一个
 * `key={active.id}`，React 在同一份 children 数组里看到重复 key，于是 python 的调试面板
 * 赖在 DOM 上不走（切到 mysql 还在，按下去发的是 python 的代码与语言）。
 * 单测看不到这件事 —— 它只渲染一个面板。
 */
test('行断点：点行号下断点 → 停在那一行并看到变量；换语言面板跟着没', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await select.selectOption('python');
  await expect(page.getByLabel('行断点调试')).toBeVisible();

  await page.locator('.cm-gutter-breakpoints .cm-gutterElement').nth(6).click();   // 第 7 行：循环体里的 print
  await expect(page.locator('.cm-bp-dot')).toHaveCount(1);

  await page.getByTestId('ide-debug-start').click();
  await expect(page.getByTestId('ide-debug-where')).toContainText('停在第 7 行', { timeout: 60_000 });
  const locals = page.getByTestId('ide-debug-locals');
  await expect(locals).toContainText('i');
  await expect(locals).toContainText('name');
  // 停在这一行 = 这一行还没执行：i 是循环第 1 轮绑上的，name 来自第 3 行
  await expect(locals.locator('code').first()).toContainText('sys');
  // 一行**只有一个**标记：停在自己的断点上 = 红点套一圈主色（不再是"红点 + ▶"两个叠在一起），
  // 而"停在哪一行"由行号那一列说（涂主色加粗）。
  await expect(page.locator('.cm-bp-dot.cm-bp-active')).toHaveCount(1);
  await expect(page.locator('.cm-bp-here')).toHaveCount(0);
  await expect(page.locator('.cm-line.cm-bp-line')).toHaveCount(1);

  await page.getByTestId('ide-debug-next').click();
  await expect(page.getByTestId('ide-debug-where')).toContainText('停在第 6 行');
  // 第 6 行没有断点 ⇒ 这一行才轮到 ▶ 说话，红点那圈主色也该退掉
  await expect(page.locator('.cm-bp-here')).toHaveCount(1);
  await expect(page.locator('.cm-bp-dot.cm-bp-active')).toHaveCount(0);

  await select.selectOption('mysql');
  await expect(page.getByLabel('行断点调试')).toHaveCount(0);
  await expect(page.locator('.cm-gutter-breakpoints')).toHaveCount(0);
});

/**
 * Java 的那一条走的是**另一台机器上的另一套解析**（jdb 的文本输出），所以它在宿主上跑有意义：
 * chunk 竞态与"变量名被类型前缀吃掉"两个 bug 都只在 Windows 上现形，
 * 而容器里的单测看不到它们。
 */
test('行断点（Java）：jdb 停在点的那一行，变量名是完整的', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await select.selectOption('java');
  const editor = page.locator(EDITOR);
  await editor.click();
  await editor.fill(
    'public class Main {\n    public static void main(String[] args) {\n        int total = 0;\n        for (int i = 1; i <= 3; i++) {\n            total = total + i;\n        }\n    }\n}\n',
  );
  await page.locator('.cm-gutter-breakpoints .cm-gutterElement').nth(4).click();   // 第 5 行
  await page.getByTestId('ide-debug-start').click();
  await expect(page.getByTestId('ide-debug-where')).toContainText('停在第 5 行', { timeout: 90_000 });

  const names = page.getByTestId('ide-debug-locals').locator('tbody th');
  await expect(names).toContainText(['args', 'total', 'i']);   // 名字被吃掉时会剩 's' / 'l'
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByTestId('ide-debug-note')).toContainText('已停止');
});

/**
 * JS 这一条钉的是评审逮到的**界面后果**：断点打在程序**第一行**时，V8 把用户断点与"启动暂停"
 * 合成一个 `reason: 'ambiguous'`。后端只要按"第一个暂停是给我们装断点用的"把它无条件丢掉，
 * 界面上看到的就是"按了调试、直接跑完"—— 用户读到的是"我的断点没生效"。
 * ｜容器里同有一条单测验这个事实，为什么还留这一条：两者经过的层不同（这里多了 HTTP、
 * 真编辑器、真 DOM），而"第一行"恰好是 gutter 索引与行号差一最容易露馅的地方。
 */
test('行断点（JS）：断点打在程序第一行也要停，TDZ 里的变量要写明"还没赋值"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/ide');
  const select = page.getByLabel('语言');
  await select.selectOption('javascript');
  const editor = page.locator(EDITOR);
  await editor.click();
  await editor.fill("const total = 41;\nconst answer = total + 1;\nconsole.log('answer=' + answer);\n");

  await page.locator('.cm-gutter-breakpoints .cm-gutterElement').nth(0).click();   // 就是第 1 行
  await expect(page.locator('.cm-bp-dot')).toHaveCount(1);
  await page.getByTestId('ide-debug-start').click();
  await expect(page.getByTestId('ide-debug-where')).toContainText('停在第 1 行（命中断点', { timeout: 90_000 });

  const locals = page.getByTestId('ide-debug-locals');
  await expect(locals).toContainText('total');
  // 停在第 1 行 = 这一行还没执行：JS 的名字先于赋值就在作用域里（TDZ），
  // 所以既不能像 python 那样"根本没这个名字"，也不能显示成 undefined
  await expect(locals).toContainText('<声明了，还没赋值>');

  await page.getByTestId('ide-debug-next').click();
  await expect(page.getByTestId('ide-debug-where')).toContainText('停在第 2 行');
  await expect(locals).toContainText('41');

  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByTestId('ide-debug-note')).toContainText('已停止');
});

/**
 * 直接关标签页：名额必须马上回来。
 *
 * 这条是被真实故障逼出来的 —— 浏览器测试连着跑几轮之后，2 个会话名额全被"上次没关的页面"
 * 占住，之后每次开会话都被拒，而界面上没有任何可关的东西。React 的卸载 cleanup 在这种路径下
 * 根本不会跑，所以组件另挂了 pagehide + keepalive；这里验的是**那条路真的通**（单测只能验到
 * 组件发了带 keepalive 的请求，验不到浏览器是否真的把它送出去）。
 */
test('关掉标签页要立刻交回 REPL 名额（不能等 5 分钟空闲回收）', async ({ page, request }) => {
  await page.goto('/#/ide');
  await page.getByLabel('语言').selectOption('python');
  await page.getByTestId('ide-repl-input').fill('print("slot-open")');
  await page.getByTestId('ide-repl-send').click();

  // 就绪信号取服务端真相，不取"记录里出现了这串字"：输入本身一进记录就含它，那条断言是假绿
  const liveCount = async () => {
    const body = await (await request.get('/api/ide/repl')).json();
    return body.sessions.length as number;
  };
  await expect.poll(liveCount, { timeout: 60_000 }).toBe(1);

  await page.close();   // 不是 goto：要的就是"用户直接关页面"这条不走 cleanup 的路径
  await expect.poll(liveCount, { timeout: 15_000 }).toBe(0);
});

test('编译失败显示成编译失败，而不是"运行成功但没输出"', async ({ page }) => {
  await page.goto('/#/ide');
  await page.getByLabel('语言').selectOption('java');
  const editor = page.locator(EDITOR);
  await editor.click();
  await editor.fill('public class Main { void main( }\n');

  await page.getByRole('button', { name: /运行/ }).click();
  const panel = page.getByLabel('运行结果');
  await expect(panel).toHaveAttribute('data-status', 'compile_error', { timeout: 60_000 });
  await expect(panel.getByText('编译失败')).toBeVisible();
  await expect(panel.getByText('阶段 compile')).toBeVisible();
  await expect(panel.locator('pre').first()).toContainText('error');
});

test('IDE 不碰题目侧的任何接口（解耦边界）', async ({ page }) => {
  const questionCalls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/\/api\/(questions|bank|challenge|attempts|history|selftest)\b/.test(url)) questionCalls.push(url);
  });

  await page.goto('/#/ide');
  await expect(page.getByLabel('语言')).toBeVisible();
  await page.getByRole('button', { name: /运行/ }).click();
  await expect(page.getByLabel('运行结果')).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });

  expect(questionCalls, `IDE 页面请求了题目接口：${questionCalls.join(' | ')}`).toEqual([]);
});
