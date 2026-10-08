import { expect, test, type Page } from '@playwright/test';

/**
 * 第五页（Jupyter notebook）在**真浏览器**里的路径（Task 10 Step 5，用的是 brief 里更正后的那条）。
 *
 * ## 先说清这个实例里"诚实的形状"是哪一种，因为它决定这个文件能断什么
 *
 * `compose.yml` 的 e2e 服务**故意不透传** `ARENA_JUPYTER_TOKEN`（WI-40 的隔离规则：它挂的是 `./data`
 * 读写，给了 token 就是给隔离实例开一条通往真人笔记的读写路径），entrypoint 那条"缺 token 就不起"
 * 的守卫于是让这个容器里**没有 Jupyter**。两条判据钉死了它：
 * `server/test/regression/notebook-compose.test.ts` ⑥（e2e / dev 必须拿不到 token）与
 * ③（e2e 的块里不许出现 7789 / 8888 这两个端口）。
 * ⇒ 这里 `/api/notebook/status` 的稳定形状就是 `running:false` + 那句 missing-token 的 reason
 * （2026-10-08 实测原值：`{"running":false,"kernels":[],"notebooks":[{…}],"reason":"这个实例没有被
 *   给予 ARENA_JUPYTER_TOKEN（compose 只给 arena / tools 透传，dev 与 e2e 故意不给 —— 那是 WI-40 的
 *   隔离规则）⇒ 按设计这里不跑 Jupyter，不是需要你修的故障；…"}`）。
 *
 * ## 为什么这里没有 brief 原稿那条"非回环 ⇒ 不出现 notebook-open"
 *
 * 那不是一条会成立的条件：无 token 但服务在跑时页面**照样**渲染那个链接（钉住它的是
 * `web/test/notebook.test.tsx:65-72`，它要求的是"当场说破要贴一次 token"而不是把链接藏掉）。
 * 照原稿写成断言它只会红，而最省事的"修法"是给非本机用户隐藏链接 —— 那正是本项目单测守着不许发生的
 * **静默降级**。所以这一条不写。（容器里非回环的那个对端正是**拿得到 token** 的那一支，判据在
 * `server/src/notebooks/status.ts` 的 `isLocalPeer`：回环或本进程默认网关。）
 *
 * ## 为什么 `ARENA_NOTEBOOK_PUBLIC_URL` 配坏那一态不在这里断言
 *
 * 它的前置条件是 `running:true`（`web/src/pages/Notebook.tsx` 的 `viewOf`：`!running` 先返回 `down`），
 * 而这个实例结构上到不了 `running:true` —— 要它就得给 e2e 透传 token，等于拆掉上面 ⑥/③ 两条隔离判据。
 * 这里**不**用 `page.route` 伪造一份"在跑"的回话去凑那条断言：伪造载荷下"链接不存在"是 fixture 自己
 * 保证的，产品行为一分没测到，而真 Jupyter 的任何东西都没被碰。那一态由
 * `web/test/notebook.test.tsx:108-126` 在单元层钉住；浏览器这一层能诚实钉的是**反着的那半** ——
 * 服务确实没在跑时，那句「Jupyter 确实在答话」（`notebook-nolink`）不许出现，出现就是谎。
 *
 * ## 这个文件断的三件（+ 顺手钉住的谎）
 * ① 打开 `#/notebook` 看得到 `notebook-status` 那句状态（懒加载那一片 JS 在 Edge 里真挂上了、路由答了）；
 * ② `notebook-open` 在这个真实的缺失态里 count 0，并且**换一次状态再看**：按「刷新状态」重读之后、
 *    切走 `#/` 再切回来之后，它都不出现，也没有第二个残留面板（WI-81 那一类 key 复用故障）；
 * ③ console 的 error 与 warning **都为 0**（本项目那三个静默降级都是这么暴露的，只看 error 会漏）。
 * 另：这一态不许顺带说另外三态的假话 —— `notebook-nolink` / `notebook-spec-missing` /
 * `notebook-prepare` 都不出现（后两个给的是修不了当前故障的操作：venv 与 --rebuild 都救不了"没给 token"）。
 */

type Collected = { errors: string[]; warnings: string[] };

/** 监听器必须在 `goto` 之前挂上：懒加载 chunk 的加载失败与首帧的 React 告警都发生在导航那一刻。 */
function watchConsole(page: Page): Collected {
  const seen: Collected = { errors: [], warnings: [] };
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') seen.errors.push(msg.text());
    else if (type === 'warning') seen.warnings.push(msg.text());
  });
  // 未捕获的异常走 pageerror，不进 console 流；它坏的时候症状恰好是"页面渲染了但按钮按不动"。
  page.on('pageerror', (err) => seen.errors.push(String(err)));
  return seen;
}

function expectQuietConsole(seen: Collected): void {
  expect(seen.errors, `console error 必须为 0，实测：${seen.errors.join(' | ')}`).toEqual([]);
  expect(seen.warnings, `console warning 必须为 0，实测：${seen.warnings.join(' | ')}`).toEqual([]);
}

test('打开 #/notebook：状态文案上屏，而这个没有 Jupyter 的实例里不给死链接', async ({ page }) => {
  const seen = watchConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/notebook');

  await expect(page.getByTestId('notebook-status')).toBeVisible();
  // 状态那行说实话：这个实例里的 jupyter 从来就没被起过（缺 token ⇒ entrypoint 的守卫）
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');

  // ② 的核心：链接不存在 ⇒ 不许渲染它（点开就是浏览器报错的死链比不给链接更坏）
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);

  // 缺失态必须自带"做题不受影响"（判题不经过这个服务）与后端那句原因，两个都在 DOM 上
  await expect(page.getByTestId('notebook-down')).toContainText('做题不受影响');
  await expect(page.getByRole('heading', { level: 2, name: 'Notebook' })).toBeVisible();
  // reason 原样上屏，并且点名坏掉的是哪一行 env —— 只写"不可用"会让人去重启一个正在好好干的服务
  const pageText = (await page.getByTestId('notebook-page').textContent()) ?? '';
  expect(pageText).toContain('ARENA_JUPYTER_TOKEN');
  expect(pageText, '这句是"按设计不跑"的诊断，不是故障 ⇒ 不许把它读成要你修的东西').toContain('不是需要你修的故障');

  // 三句边界话在这一态也得常驻（用户最该看见它们的时刻正是状态最难看的时候）。
  // 但**逐字的文案契约只该有一份**：那份在单元层 —— `web/test/notebook.test.tsx` 里的
  // `boundarySentences` × `boundaryCases`（在跑 / 没在跑 / 链接坏掉这三态各跑一遍，7 句逐字）。
  // 这里原来把最长那句整句抄了一遍，于是改个标点会红的是 E2E 而不是单测（评审 minor）——
  // 那类红教人的是"两处都得改"，不是"这里真坏了"。
  // ⇒ 最长那句换成 testid + 结构判据：`notebook-boundary` 那一块可见，里面每个 <p> 是一句边界话
  //   （少一句就是这里红），且其中恰好一条提到 `127.0.0.1` —— 那是**契约事实**
  //   （宿主侧两个发布端口只绑回环，`compose-ports.test.ts` 钉着），不是措辞。
  // ⚠ 段落数今天不是 3 而是 **5**：`db08cf8`（终审 I-5）把"环境共用"那一句拆成了两句
  //   （判题用的是另一套解释器 / 绝对路径拦不住 + CPU 不在这页管辖内），而这条计数判据
  //   一直排在两句字面判据**之后**，字面先红 ⇒ 计数从来没跑到过，没人看见它也已经过期。
  //   （原 finding 写的是"恰好三个 <p>"，按 `Notebook.tsx` 现场更正为 5。）
  // 剩下两句**不抄整句、只钉住那句里搬不走的名词**，两个判据各自拦一件具体的事。
  // 顺序也有讲究：这两条排在结构判据**之前**，为的是"少哪一句就报哪一句"——
  // 计数判据谁先红都只会说"少了一段"，读的人还得自己回去数是哪一句没了。
  // ① `另一套解释器`（钉"判题跑的是另一个解释器"这条事实，即"在这里装的包判题看不见"）。
  //    为什么不是 `解释器`：隔壁那段（`!/usr/local/bin/pip3 install X`）也有"解释器"三个字，
  //    整段删掉它照样命中 ⇒ 判据变哑；`另一套` 是"分裂成两套"这个事实的承载词，
  //    改措辞（"走的是另一套解释器"）留得下，删句子必然红。
  // ② `安全边界`（钉"读得到参考答案这件事**不是**一道安全边界"那条声明）。
  //    为什么不带"这不是"那三个字：那正是 `db08cf8` 之前被改坏过的那半句连接词，钉住它 = 又抄了一遍文案；
  //    而这一整页只有这一段用"边界"这个比喻（另一处"边界"在源码注释里，不在 DOM 里），
  //    所以这个词在页面上是唯一的 ⇒ 删掉那一句它当场消失，换成"这里不构成安全边界"它不动。
  expect(pageText, '那句"判题用的是另一套解释器"没了 ⇒ 页面又把共用环境写成了一道保证').toContain('另一套解释器');
  expect(pageText, '那句"这不是安全边界"没了 ⇒ 参考答案的可读性被静默写成了保密性').toContain('安全边界');
  const boundary = page.getByTestId('notebook-boundary');
  await expect(boundary).toBeVisible();
  await expect(boundary.locator('p'), '边界块少了一段 ⇒ 有人整句删掉了边界话（这一态共 5 段）').toHaveCount(5);
  await expect(boundary.locator('p').filter({ hasText: '127.0.0.1' }), '那一块里没有提到回环地址的那句 ⇒ 三种说法之一被删了').toHaveCount(1);

  // 示例清单与"在不在跑"无关：GET 顺手铺示例，所以 running:false 时也列得出那一份 smoke
  await expect(page.getByTestId('notebook-files')).toContainText('00-smoke-pyspark.ipynb');

  expectQuietConsole(seen);
});

/**
 * 「换一次状态再看 DOM」——只截一张"刚进来长什么样"抓不到"切走之后有没有清理干净"。
 * 这里能真实切换的状态就是重读一次：点「刷新状态」会再打一遍那条 GET，
 * 而这一态的判据是"点完什么都没变"——链接不会因为多读一次就凭空出现，
 * 状态文案也不许因为读到第二次而暂时落到"加载中…"就不回来（那是永远等不到的第三种谎）。
 */
test('按「刷新状态」重读之后：链接依旧不出现，面板不重复、不残留', async ({ page }) => {
  const seen = watchConsole(page);
  await page.goto('/#/notebook');
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);

  await page.getByTestId('notebook-reload').click();
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);

  // 一块面板一个实例：重复 key / 复用挂载在这里的表现就是"两个运行时块"或"按完钮多出一个是非不明的"
  await expect(page.getByTestId('notebook-status')).toHaveCount(1);
  await expect(page.getByTestId('notebook-status-card')).toHaveCount(1);

  // 这一态不许说另外三态的假话
  await expect(page.getByTestId('notebook-nolink'), '服务没在跑，那句"Jupyter 确实在答话"就是谎').toHaveCount(0);
  await expect(page.getByTestId('notebook-spec-missing'), '这里没人探过 kernel 表，那句"跑一次 ./start.sh --rebuild"是指错方向').toHaveCount(0);
  await expect(page.getByTestId('notebook-prepare'), '缺的是 token，不是 venv ⇒ 给按钮就是让人白点').toHaveCount(0);
  // 读成功的时候不许挂"这次没读到"
  await expect(page.getByTestId('notebook-error'), '读到 200 却说读不到，是另一种静默降级').toHaveCount(0);

  expectQuietConsole(seen);
});

/**
 * 路由这一层的清理：`#/notebook` 是懒加载那一片（`web/test/notebook.test.tsx` 钉着它的打包形状），
 * 切走再切回会重跑一次挂载。判两件事：回来之后还是那一块、链接还是不出现；
 * 切走之后第五页的东西不留尸体（WI-81 那次是"切到 mysql 之后 python 的面板还赖在页面上"）。
 */
test('切走 #/ 再切回来：第五页不重复挂载，也不留残留', async ({ page }) => {
  const seen = watchConsole(page);
  await page.goto('/#/notebook');
  await expect(page.getByTestId('notebook-page')).toHaveCount(1);

  await page.goto('/#/');
  await expect(page.getByTestId('notebook-page')).toHaveCount(0);

  await page.goto('/#/notebook');
  await expect(page.getByTestId('notebook-page')).toHaveCount(1);
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);

  expectQuietConsole(seen);
});
