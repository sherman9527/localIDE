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
 * 那不是一条会成立的条件：非本机的连接页面**照样**渲染那把链接（钉住它的是
 * `web/test/notebook.test.tsx` 里「localPeer:false」那条用例，它要求的是"当场说破会被守卫 403"
 * 而不是把链接藏掉 —— WI-98 之前那句话是"要手贴一次 token"，话换了，纪律没换）。
 * 照原稿写成断言它只会红，而最省事的"修法"是给非本机用户隐藏链接 —— 那正是本项目单测守着不许发生的
 * **静默降级**。所以这一条不写。（容器部署里宿主浏览器的对端正是 `isLocalPeer` 点头的那一支 ——
 * 回环或本进程默认网关，判据在 `server/src/notebooks/status.ts`。）
 *
 * ## 为什么 `ARENA_NOTEBOOK_PUBLIC_URL` 配坏那一态整块删除（WI-98，不再是"不在这里断言"）
 *
 * 那一态（`running:true` + `reason` + 没有 `url`，前端 `notebook-nolink` 横幅）的成因是
 * "链接由 env 拼绝对地址、env 可能被配坏"。现在逃生链接是编译期派生的同源路径 `/jupyter/tree`，
 * 没有任何 env 能让它坏 ⇒ **判的对象结构上不存在了**，原来钉它的正反两句（单元层两条用例 +
 * 这里那句"『Jupyter 确实在答话』不许出现"的反向判据）随实现一起删。留一句 `toHaveCount(0)`
 * 去判一个已不存在的 testid 的"缺席"，就是一条永远不会红的装饰判据（本仓库对装饰判据的态度
 * 见 WI-104/WI-109）。浏览器这一层换了一条**能红**的来顶：整页 DOM 文本里不许出现 `token=`
 * （`web/test/notebook.test.tsx` 同款判据的真浏览器层重钉一次 —— 派发词 §3 那条新增）。
 *
 * ## 这个文件断的三件（+ 顺手钉住的谎）
 * ① 打开 `#/notebook` 看得到 `notebook-status` 那句状态（懒加载那一片 JS 在 Edge 里真挂上了、路由答了）；
 * ② `notebook-open` 在这个真实的缺失态里 count 0，并且**换一次状态再看**：按「刷新状态」重读之后、
 *    切走 `#/` 再切回来之后，它都不出现，也没有第二个残留面板（WI-81 那一类 key 复用故障）；
 * ③ console 的 error 与 warning **都为 0**（本项目那三个静默降级都是这么暴露的，只看 error 会漏）。
 * 另：这一态不许顺带说别的态的假话 —— `notebook-spec-missing` / `notebook-prepare` 都不出现
 * （它们给的是修不了当前故障的操作：venv 与 --rebuild 都救不了"没给 token"）；
 * **且整页 DOM 文本里不许出现 `token=`**（WI-98：这一页从头到尾没有任何一处把凭据写进 URL，
 * 真浏览器层再钉一次单元层的同一条 —— 原 `notebook-nolink` 那句反向判据随块删除，理由见上一节）。
 *
 * ## WI-94 Task 6 加进来的三件，以及"为什么只有这些能在这里诚实判"
 * ④ **`running:false` 那一屏不许出现内嵌那一块**（`notebook-frame` / `notebook-tree` 各 count 0）。
 *    这条在这个实例上是**能判的**：服务确实没在跑，而页面的门是按 `view.kind === 'open'` 关的；
 *    把那一支改成"照旧渲染一个空 iframe"（派发词里要求的破坏性验证之一），这里当场红。
 *    反过来，"内嵌的 iframe 真打开了一份笔记"这件事**不能**在这里断 —— 那需要 `running:true`，
 *    等于要 e2e 拿到 token，拆掉 `notebook-compose.test.ts` 的 ⑥/③ 两条隔离判据。
 *    所以浏览器层这一档钉的是**缺席**，真跑通 notebook 那一眼归 `./start.sh --verify` 的容器档与宿主实测。
 * ⑤ **边界卡现在是折起来的 `<details>`**（用户批的第 4 件）。判据必须"先展开、再断可见"：
 *    折叠着的 `<p>` 仍在 DOM 里，`textContent()` 与 `toHaveCount()` 都读得到它 ——
 *    所以只数段落数的话，"忘了展开"与"展开后根本看不见"这两种故障**都不会红**。
 *    真正有牙的是那句 `toBeVisible()`：删掉前面那次 `.click()` 它必红（本轮实测见 task-6-report.md）。
 * ⑥ **空的分组壳不许留在页面上**。这一条是"真浏览器那一眼"（Step 3 第 8 条的两张截图）暴露的缺陷，
 *    两档自动化原本都照不出来：jsdom 没有布局（空壳与有内容的壳在 `textContent` 判据下长得一样），
 *    这里的实例是 `running:false` —— 横幅区此刻有那句"做题不受影响"撑着，壳**必须存在且不塌陷**；
 *    "空则整块不渲染"的缺席那一半（loading 态壳数必须为 0）在单元层数 DOM 形状，这里量真实盒子。
 *
 * ## 2026-10-10 用户点名的布局简化动到哪一句（本文件的判据搬家而不是放宽）
 *
 * 卡壳（`notebook-status-card`）、标题「运行时」、"这次铺了什么"那块（`notebook-files`）按批的范围
 * 整片删掉，三把按钮并入 page-head 工具条。判据随之搬家：`notebook-status-card` 由"count 1"变
 * "count 0"（缺席判据，第一例）、`notebook-files` 由"列得出 smoke"变 count 0（同例），并新增
 * 「运行时」标题必不出现。逐字没动的：状态话、边界话（当时五段）、横幅措辞；按钮显隐的判据一条没少
 * （down 态 `notebook-open` / `notebook-prepare` 依旧 count 0 —— 它们现在住在工具条里，这条 e2e
 * 恰好是最真的验证，因为这个实例**永远**是 down）。
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
  // **WI-98 新增（真浏览器层）**：这一页的 DOM 文本里不许出现 `token=` —— 单元层
  // （`web/test/notebook.test.tsx`「服务在跑」那条整页判据）钉的是渲染形状，这里钉的是
  // **真后端 + 真浏览器**这一路：响应体经页面渲染后仍然没有任何凭据进 DOM。
  // 点名 `token=` 而不是裸 `token`：那句 missing-token 诊断**必须**提 `ARENA_JUPYTER_TOKEN`
  // 这个键名（读者据此才知道去查哪一行 env），判"整个词不许出现"会撞自己的诊断话。
  expect(pageText, 'DOM 文本里出现 token= ⇒ 凭据又回到 URL 形状了（WI-98 消掉的就是它）').not.toContain('token=');

  // 三句边界话在这一态也得常驻（用户最该看见它们的时刻正是状态最难看的时候）。
  // 但**逐字的文案契约只该有一份**：那份在单元层 —— `web/test/notebook.test.tsx` 里的
  // `boundarySentences` × `backendStates`（在跑 / 没在跑 / 非本机连接这三态各跑一遍，18 句逐字）。
  // 这里原来把最长那句整句抄了一遍，于是改个标点会红的是 E2E 而不是单测（评审 minor）——
  // 那类红教人的是"两处都得改"，不是"这里真坏了"。
  // ⇒ 最长那句换成 testid + 结构判据：`notebook-boundary` 那一块可见，里面每个 <p> 是一句边界话
  //   （少一句就是这里红），且其中恰好一条提到 `127.0.0.1` —— 那是**契约事实**
  //   （宿主侧两个发布端口只绑回环，`compose-ports.test.ts` 钉着），不是措辞。
  // ⚠ 段落数的历史：原稿"恰好三个 <p>"更正为 5（`db08cf8` 把"环境共用"拆成两句），
  //   WI-91b Task 5 又长到 **7**（接入第二条 kernel：新增 Scala 报错形状与"补全/悬浮文档/中断三样各有各的真相"两段，
  //   且"共用环境 / pip / CPU"改成按-kernel 点名）。计数判据两头都咬：少一段（删话）与多一段
  //   （话与契约分家）都会红 —— 它必须与 boundarySentences、summary 里的"7 条边界"同批改。
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
  // ③ WI-91b Task 5 新增：`Unknown Error` 是协议里的字面量（不是中文措辞，抄它不算抄文案），
  //    钉的是"Scala 报错形状那段边界话还在"——整段删掉它当场消失，改写措辞它不动。
  expect(pageText, 'Scala 的报错形状那段（ename 恒为 Unknown Error）没了 ⇒ 页面又开始用 Python 的经验许诺 Scala').toContain('Unknown Error');
  // ⚠ WI-94 Task 6 之后这块折进了 `<details>`：**先展开再断**。
  // 顺序是刻意的：`.click()` 排在任何边界判据之前，因为折叠状态下
  // `toHaveCount(7)` 与 `textContent()` 都**照样成立**（折叠不删 DOM），于是"忘了展开"这一种
  // 故障只能由下面那句 `toBeVisible()` 抓到 —— 而它必须在展开之后跑，否则它抓的是"没展开"这件事
  // 本身，红得没有信息量。破坏性验证（本轮实测）：删掉这次 `.click()` ⇒ 本文件红的恰是可见性那句。
  const boundary = page.getByTestId('notebook-boundary');
  await expect(boundary).toBeVisible();
  await page.getByText('这页跟判题有什么关系').click();
  await expect(boundary.locator('p'), '边界块段数不是 7 ⇒ 有人整句删掉了边界话，或让 DOM 与 boundarySentences 契约分家（这一态共 7 段）').toHaveCount(7);
  await expect(boundary.locator('p').filter({ hasText: '127.0.0.1' }), '那一块里没有提到回环地址的那句 ⇒ 三种说法之一被删了').toHaveCount(1);
  // 展开之后这七段是真的**看得见**，不是只是挂在 DOM 上（折叠时它们对读者等于不存在）
  await expect(boundary.locator('p').filter({ hasText: '127.0.0.1' })).toBeVisible();

  // 2026-10-10 用户点名的布局简化 —— 删没删要靠判据而不是人眼。这一态（running:false）正是
  // "这次铺了什么"那块以前**必出现**的一态（GET 顺手铺示例，`data.notebooks` 与在不在跑无关，
  // 原稿在这里断的是"列得出那份 smoke"）；现在它、卡壳、标题「运行时」都必须整片不在。
  // `notebook-status-card` 以前钉的是 count 1（第二例里），判据**搬家**成了这里的 count 0。
  await expect(page.getByTestId('notebook-files')).toHaveCount(0);
  await expect(page.getByTestId('notebook-files-empty')).toHaveCount(0);
  await expect(page.getByTestId('notebook-status-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '运行时' })).toHaveCount(0);
  expect(pageText, '那块的小标题还在 ⇒ "这次铺了什么"没删干净').not.toContain('这一页读到的示例');

  // **空的分组壳不许留在页面上**（真浏览器那一眼实测发现的缺陷，见 task-6-report.md）。
  //    壳带上下留白（简化前还带一条 border-top），所以"壳在而内容全是 null"的症状是状态行下面
  //    多出**没有话的空白带** —— 那是布局事实，jsdom 照不出来（单元层只能数 DOM 形状 + 壳数），
  //    所以这一半判据必须在这里量真实盒子。这一态（running:false）里那个唯一的壳由"做题不受影响"撑着。
  const groupBoxes = await page.$$eval('.nb-group', (els) =>
    els.map((e) => ({
      children: e.childElementCount,
      height: Math.round(e.getBoundingClientRect().height),
      borderTop: getComputedStyle(e).borderTopWidth,
    })),
  );
  expect(groupBoxes.length, '一个壳都没有 ⇒ 这一态那句"做题不受影响"没人说了（诊断话不许连壳一起删）').toBeGreaterThan(0);
  for (const g of groupBoxes) {
    expect(g.children, '空的 .nb-group 还挂在页面上 ⇒ 多出一条没有话的空白带').toBeGreaterThan(0);
  }

  // ④ WI-94 Task 6：`running:false` 这一屏不许出现内嵌那一块 —— 那棵子树在这个实例上结构上到不了，
  //   摆一个空 iframe 就是谎（`web/src/pages/Notebook.tsx` 的门是 `view.kind === 'open'`）。
  //   这一条与"这一页不 iframe 里真跑通了什么"无关，它判的是**缺席**。
  //   （简化前这里还有一句对照 —— "`notebook-files` 照旧出现而 `notebook-tree` 不出现"，两个 testid
  //   一家一半；那块按用户批的范围删了，对照的左边那一半搬到了上面的 count 0 判据，这一半原样。）
  await expect(page.getByTestId('notebook-frame'), '服务没在跑却渲染 iframe ⇒ 读者对着一个空白框查一个不存在的服务').toHaveCount(0);
  await expect(page.getByTestId('notebook-tree')).toHaveCount(0);
  await expect(page.getByTestId('notebook-embed')).toHaveCount(0);

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
  // WI-94 Task 6：这一态连那次 readdir 都不必发。判的是**网络层**而不是 DOM ——
  // 「按钮按下去多发一个请求」不会在任何 DOM 断言上留痕，而它的症状是控制台里一排 503。
  const fileRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/notebook/files')) fileRequests.push(req.url());
  });
  await page.goto('/#/notebook');
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);
  // 内嵌那一块整片不在（首屏）
  await expect(page.getByTestId('notebook-frame')).toHaveCount(0);

  await page.getByTestId('notebook-reload').click();
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);
  // 「刷新状态」现在会同时重读左栏那份列表 —— 但 `running` 不是真值时那一支**不发请求**，
  // 所以按完之后网络层还是零次 /api/notebook/files（单元层那条 `expect(files).not.toHaveBeenCalled()`
  // 钉的是同一件事，两层的故障面不同：这里抓的是"真的打出去了"）。
  await expect(page.getByTestId('notebook-frame')).toHaveCount(0);
  expect(fileRequests, '服务没在跑却打了那次 readdir ⇒ 页面在按一个它已经知道不存在的接口').toEqual([]);

  // 一块面板一个实例：重复 key / 复用挂载在这里的表现就是"两个运行时状态行"或"按完钮多出一个是非不明的"
  await expect(page.getByTestId('notebook-status')).toHaveCount(1);
  // （原来这里还有一条 `notebook-status-card` 的 count 1 —— 卡壳按 2026-10-10 用户点名的简化删了，
  // "面板唯一"现在由上面那句判；卡壳自己的判据搬成第一例里的 count 0 缺席判据，不许再长回来。）

  // 这一态不许说别的态的假话。（原来这里还有一句 `notebook-nolink` 的 count 0 —— WI-98 随
  // `nolink` 态整块删除：testid 没了，留一句"判一个不存在的 testid 的缺席"就是装饰判据。）
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
  // 内嵌那块是"这一页自己的"东西：切走再切回最容易留尸体的就是它（一个挂着 Jupyter 的 iframe
  // 残在别的页面底下，症状是"我在做题，页面左边多出一个笔记本"）。
  await expect(page.getByTestId('notebook-embed')).toHaveCount(0);

  await page.goto('/#/');
  await expect(page.getByTestId('notebook-page')).toHaveCount(0);
  await expect(page.getByTestId('notebook-frame')).toHaveCount(0);
  await expect(page.getByTestId('notebook-tree')).toHaveCount(0);

  await page.goto('/#/notebook');
  await expect(page.getByTestId('notebook-page')).toHaveCount(1);
  await expect(page.getByTestId('notebook-status')).toContainText('没在运行');
  await expect(page.getByTestId('notebook-open')).toHaveCount(0);
  await expect(page.getByTestId('notebook-frame')).toHaveCount(0);

  expectQuietConsole(seen);
});
