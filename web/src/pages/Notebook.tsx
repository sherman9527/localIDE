import { Children, useCallback, useState, type ReactNode } from 'react';
import {
  JUPYTER_BASE_URL,
  NOTEBOOK_KERNELS,
  notebookDocPath,
  type NotebookFilesResponse,
  type NotebookStatusResponse,
} from '@arena/shared';
import { api } from '../api';
import { errorMessage, isAbort } from '../lib/errors';
import { useAsync } from '../lib/hooks';
import { Loading } from '../components/AsyncState';

/**
 * 第五页：Jupyter notebook（A1 档 + WI-94 的内嵌 + 2026-10-10 用户点名的布局简化）。
 *
 * 简化动的是**容器**，不是话：「运行时」卡壳（`notebook-status-card`）、`card-head` 那层标题、
 * 以及"这一页读到的示例（这次铺了什么）"整块（`notebook-files` 那份带徽标的清单 + `notebook-files-empty`
 * 那句）按用户批的范围删掉了，三把按钮并进顶部的 `page-head` 工具条。删没删由判据钉，不靠人眼：
 * `web/test/notebook.test.tsx` 与 `tests/e2e/notebook-page.spec.ts` 里各有一条"这几样必不出现"。
 *
 * 状态那一行是这里唯一由后端说话的地方，后端给得出的三种形状 + 前端自己的两个读态各一句，**不许合并**
 * （后端已经按"修的是不同东西"分了 reason）：
 *   ① 在跑 → 「运行中」+ 工具条里一把**同源** `/jupyter/tree` 的链接（WI-98：链接里没有也**不该有**
 *      任何凭据 —— 它和 iframe 走同一条服务端注入的反代，"这条连接过不过守卫"由 `localPeer` 说话）；
 *   ② 没在跑 → 「没在运行」+ 后端那句原因 + "做题不受影响"（判题不经过这个服务）；
 *   ③ kernel 没就绪 → 工具条里的「准备环境」按钮 —— 缺的是 IDE 那份 venv，不是用户的写法；
 *   ④ ~~在跑、但 publicUrl 被 env 配坏（`running:true` + `reason` + 没有 url）~~
 *      **WI-98 整块删除**：这一态唯一的成因是"链接由 `new URL(env …)` 拼、env 可能被配坏"。
 *      链接现在是编译期常量派生的同源路径，**没有任何 env 能让它坏** —— 留着分支就是一条永远不会红的
 *      装饰判据（本仓库对装饰判据的态度见 WI-104/WI-109；`server/src/notebooks/status.ts` 里同一段理由）。
 * 再加前端自己的两个读态「状态读不到」（unreachable）与「还没读到」（loading），一共四句话同住
 * `notebook-status` 那一处三元链 —— "任何两句同时出现"结构上不可能，总判据是
 * `web/test/notebook.test.tsx` 的「四态状态行两两互斥」。（这段理由原来写在状态卡的卡头注释里；
 * 卡壳删的时候**不许把它一起删**，它就是"为什么各态不许合并"的原件。）
 *
 * ⑤ WI-94 Task 6 加进来的第五件事：**notebook 现在内嵌在这一页里**（左文件树 + 右 notebook），
 *    不再是"跳出去开一个独立标签页"。它带出一条与上面各态正交的规矩：
 *    **内嵌这一路不带凭据** —— src 只是同源路径（`/jupyter/…`），token 由服务端在反代里注入，
 *    守卫不过就在隧道里回 403/503，那个 JSON 会直接显示在 iframe 里。
 *    **WI-98 把逃生链接并进了同一条纪律**：`notebook-open` 的 href 也是同源路径、也不带凭据，
 *    于是过去那把"链接里有/没有 token"的尺子整个作废 —— 页面上永远不该出现带 token 的 notebook URL
 *    （钉在 `web/test/notebook.test.tsx`，现在压的是**整页 DOM 文本**）。
 *    后端判到的那一半结论改由 `localPeer` 字段送达：`false` ⇒ 这条连接过不了守卫，
 *    这一页与那把链接点出去都是 403（`notebook-not-local` 那句横幅，见下）。
 *    ①②③ 各态下 iframe 只有一态出现：`view.kind === 'open'`。`running:false` 时那棵子树结构上
 *    到不了，摆一个空 iframe 就是说谎（e2e 那个实例永远是 `running:false`，它的判据建立在这条上）。
 *    ⚠ 布局简化没有碰这一维：Jupyter 没起时右边那棵树**渲染不出来**，所以状态话与横幅区必须留着 ——
 *    把"少一块 UI"做成"把话也删掉"，页面就只剩一张边界卡，那正是 WI-94 修掉的"空白 iframe 就是说谎"。
 *
 * 那几句边界话常驻，不随状态切换收起（IDE 那边同一课）：①环境共用（**按 kernel 分开说**：
 * Python 那条与判题用的是另一套解释器、Scala 那条连 IDE venv 都不碰；绝对路径拦不住）、
 * ②CPU 不在这页管辖内（两条 kernel 各起一个判题池之外的 Spark JVM，量级各写各的）、
 * ③Scala 侧的报错形状（`Unknown Error` + 空堆栈帧）与那三样各自的真相（补全有 / 悬浮文档没有 /
 *   中断按下去无可观察效果 —— 2026-10-20 真浏览器实测；Task 5 初稿把三条一起写成"不支持"，
 *   其中"补全不支持"被实测推翻，见 `task-5-report.md` 的修复轮）、
 * ④答案可读不是安全边界、⑤只在本机打得开。用户在"要装包"和"要撞墙"的两个时刻都需要它们，
 * 而那正是状态最难看的时候。
 * （`db08cf8` 把第一句拆成了两句，那是 5 段的起点；WI-91b Task 5 接入第二条 kernel 后长到 7 段 ——
 * 逐字契约在 `web/test/notebook.test.tsx` 的 `boundarySentences`，浏览器层只钉名词：
 * `tests/e2e/notebook-page.spec.ts`。）
 * WI-94 Task 6 按用户批的范围把边界块**折进一个 `<details>`**（当时 5 段，那次措辞一字不改、只加折叠）：
 * DOM 里常驻，只是默认收成一行 —— 判据分两层：单元层钉"是 `<details>` 且默认折着 + 七段逐字仍在 DOM"，
 * 浏览器层钉"展开之后这七段真的可见"（折叠着的元素在 Playwright 里 `textContent` 照样读得到，
 * 所以只数段落数抓不到"忘了展开"，那一半必须由可见性判据负责）。
 * WI-91b Task 5 改的是**措辞契约本身**（5→7 段 + 按 kernel 点名），三层（页面 / 单元逐字 / e2e 计数）
 * 同批一起走，改一边另两边红 —— 折叠纪律那一条没动。
 *
 * 还有一条**与上面几态正交**的诊断：`seedError`（示例铺不进去，评审 I-1）。它不许并进状态那几句里 ——
 * 并进去就把"磁盘/挂载的事"说成"服务的事"了；状态那一行此刻照旧说实话。它原来挂在示例那一块里，
 * 块按用户批的范围删掉后它**换家到横幅区**：话留着，容器没了（删掉这句话才是静默降级 ——
 * 磁盘只读时页面必须还会说"铺不进去"，而不是哑掉）。它旁边那句"没有示例"随块一起删是批过的：
 * "这次铺了什么"与左边那棵"目录里现在有什么"是两件事，前者整块不要了，后者一字未动。
 * 左栏那份列表（`notebookFiles`）用的是**同一条纪律的孪生**：有 `error` ⇒「这一次读不到」，
 * `files:[]` 且没有 `error` ⇒「目录里就是没有」，**还没读到** ⇒ 两句都不许说，
 * **那一发整请求失败**（404 / 连不上，评审 I-1）⇒ 第三句「这一次没读到左栏那份列表」+ 错误文本。
 * 三句两两互斥（同一条三元链，结构上不可能同时出现），少任何一句都是一次静默降级。
 *
 * 这里**不做定时轮询**：工具条上有一把「刷新状态」，「准备环境」完成后自动重读一次。
 * 理由是那个 GET 会顺手铺示例（`server/src/api/app.ts` 的路由里），定时轮询=定时做一遍磁盘 I/O；
 * 而"这一页开着不动时状态本来就不会自己变"。（A1 原稿那句"等 Task 10 拿着容器里的数据再决定"已经过期 ——
 * Task 10 交付完了，容器档那批读数也在了，所以要不要轮询**现在就是一次可决定的事**，不再欠数据；
 * 加了轮询就要同时回答"多久一次、页面不可见时停不停"，那是 WI-97/WI-93 那一族的账。）
 * 「刷新状态」重读的是这一页**全部**读出来的真相（状态 + 左栏那份列表）：只重读前者时，用户在
 * Jupyter 里新建一份笔记再回来按刷新，树里还是旧的那两份 —— 那是"拿旧真相冒充新真相"。
 */

/**
 * 后端形状的判别：只看后端给的字段，不在前端再造一套真相。
 * `loading` / `unreachable` 是前端自己的两个读态（还没读到 / 这次读失败），不代表 Jupyter 的任何状态。
 * **WI-98 删掉了 `nolink`**（旧第四态"在跑，但地址给不出来"）：它的成因是链接由 env 拼、可能被配坏，
 * 而现在 `url` 是后端送出的编译期同源常量（`NOTEBOOK_TREE_PATH`），没有任何 env 能让它坏 ——
 * `running:true` 恒带 `url`，这一态在契约与实现里都不可达，留着就是一条永远不会红的装饰分支
 * （理由全文见 `server/src/notebooks/status.ts` 的链接一节与简报 WI-98 §1.2）。
 */
type StatusView =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'down'; reason: string }
  | { kind: 'open' };

function viewOf(data: NotebookStatusResponse | null, error: string | null): StatusView {
  if (!data) {
    // 一次都没读到过：这时候 error 就是"这一页现在什么都不知道"
    if (error) return { kind: 'unreachable' };
    return { kind: 'loading' };
  }
  if (!data.running) return { kind: 'down', reason: data.reason ?? '后端没给原因（契约要求 running:false 必填 reason）' };
  return { kind: 'open' };
}

/**
 * 横幅区的分组壳：**没有内容就整个不渲染**。
 *
 * 壳与上下留白的意思是"这里有话要说"。壳在而内容全是 `null` 时，页面上会出现状态行下面一段
 * **没有任何话的空白带** —— 读者会去找那句被"漏掉"的话，而它根本不存在。2026-10-10 的布局简化
 * 之后全场只剩这一个壳：状态行是"永远有一句话"的常驻块，不再需要壳；会整块缺席的只有横幅区。
 *
 * 这条只在真浏览器里看得见，两档自动化都照不出来：jsdom 没有布局（空壳与有内容的壳在
 * `textContent` 判据下一模一样），而 e2e 那个实例是 `running:false`（诊断那一组本来就有话）。
 * 它原是 Step 3 第 8 条那两张截图（1440 / 480）里量出来的（实测读数：`.nb-group` 四个，其中两个
 * `childElementCount: 0` 却 `height: 17px`、`borderTopWidth: 0.67px` —— 那是四组时代的数据，
 * 今天组数变了，"空壳占地方"这个故障面没变）。
 *
 * 判据分两层：`web/test/notebook.test.tsx` 数渲染出来的壳（DOM 形状，含 loading 态"壳必须为 0"），
 * `tests/e2e/notebook-page.spec.ts` 量每个壳的真实高度（布局）。
 *
 * ⚠ 空与不空**由 children 自己算**（`Children.toArray` 会把 `null` / `undefined` / `false` 全丢掉），
 * 不是在调用点上再写一遍 `hasDiagnostics = ...`。后者要在每一组里抄一份"子条件之和"，
 * 而抄的那一份会和原件各自漂移：加了新横幅忘了加进总和 ⇒ 又变成空壳，且没有任何一处会红。
 */
function Group({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return items.length === 0 ? null : <div className="nb-group">{items}</div>;
}

export default function Notebook() {
  const { data, loading, error, reload } = useAsync((signal) => api.notebookStatus({ signal }), []);
  const [preparing, setPreparing] = useState(false);
  const [prepareLog, setPrepareLog] = useState<string | null>(null);
  /** 左栏选中：`null` = "文件管理"（Jupyter 自己的树视图），字符串 = 那份笔记。 */
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * 左栏那棵树的数据源。两条与"界面不许说假话"直接相关的决定，都偏离了 brief 原稿（理由写在这儿）：
   *
   * ① **`running` 不是真值时连请求都不发**：服务没起时那次 readdir 只会多一条 503 噪声，
   *    而这一态界面本来就不渲染那一块（摆一个空树=谎）。
   * ② 那个"不读"的分支回的是 **`null`，不是 `{ files: [] }`**。原稿写的是后者，而后者是一个
   *    "读过、且目录里就是没有"的形状：`useAsync` 在换依赖重发时会把上一轮的 `data` 留着
   *    （`setState({ data: prev.data, loading: true })`），于是 running 刚从 false 翻成 true 的那一会儿，
   *    页面上挂着的就是那份占位空数组 ⇒ "目录里现在没有笔记"在**这一次读还没回来**时上了屏。
   *    那正是 `seedError` 那一族纪律要拦的谎（把"还不知道"说成"没有"），而拦法就是把"还不知道"
   *    在类型里表示出来：`null` = 没读过，`{files: []}` = 读过、真的没有。
   * ③ `error` **必须解构出来**（评审 I-1）：`files:[]` 无 `error` 是"没有"、有 `error` 是服务端说"读不到"，
   *    而**整发请求失败**（404 / 连不上）时那两个字段都不在场 —— 不接 `error` 的话左栏就一句话都不说，
   *    读者只会以为目录被清空了。这个形状不是假想：本轮开发中旧容器上那条路由真的回过 404。
   */
  const { data: listing, error: filesError, reload: reloadFiles } = useAsync<NotebookFilesResponse | null>(
    (signal) => (data?.running ? api.notebookFiles({ signal }) : Promise.resolve(null)),
    [data?.running],
  );

  const view = viewOf(data, error);
  const kernels = data?.kernels ?? [];
  const blocked = kernels.filter((k) => !k.ready);
  /**
   * 探到的 kernel 表里缺了**注册表里的哪几条**就点哪条（WI-91b Task 3）：镜像级注册没了，
   * 「准备环境」修不了它 ⇒ 得说清区别。旧实现只 key 在 pyspark 一条上，scala 接入后
   * "半接入的镜像"（只 COPY 了一条 kernelspec）会被它读成"没问题"—— 那正是静默降级那一族。
   */
  const missingSpecIds: string[] =
    data?.running === true
      ? Object.values(NOTEBOOK_KERNELS).map((k) => k.id).filter((id) => !kernels.some((k) => k.id === id))
      : [];
  /**
   * WI-98：这一族从"链接里没有 token"（`!url.includes('token=')`）改成**读后端的 `localPeer`**。
   * 旧判据在新形状下会把每一台本机连接都误报成"非本机"（链接里本来就从来没有 token）——
   * 那句话改了含义才活着（"话不许静默消失"的纪律）：现在说实话的是"这条连接过不过服务端守卫"，
   * 判据与 `proxyGuard.ts` 同源（对端 ∧ Host 的合取，算在后端）。
   * ⚠ 判的是 `=== false` 而不是 `!data.localPeer`：字段缺席（旧后端 / 坏响应）时**不许**凭空喊
   * "你会被 403" —— 那是另一种静默的谎。契约把它定为必填，正常路径永远带着 true/false 之一。
   */
  const guardRefused = view.kind === 'open' && data?.localPeer === false;

  const prepare = useCallback(async () => {
    setPreparing(true);
    setPrepareLog('正在准备环境：第一次要几十秒到两分钟（venv 建在命名卷上），这期间可以放着不管。');
    try {
      const res = await api.notebookPrepareEnv();
      // 说完成与否，然后重读一次状态 —— 停在"还没就绪"上不刷新，用户会以为按钮没生效
      setPrepareLog(res.ok ? '环境建好了，正在重读 kernel 状态…' : `没建成：${res.reason ?? '后端没给原因'}`);
      reload();
    } catch (err) {
      if (isAbort(err)) return;
      setPrepareLog(`没建成：${errorMessage(err) || '请求失败'}`);
    } finally {
      setPreparing(false);
    }
  }, [reload]);

  /**
   * 「刷新状态」要把上一轮那句话收掉（评审 Fix-1 的 Minor）：
   * `prepareLog` 讲的是**那一轮动作**的结果，手动刷新之后它还挂在页面上，就是在替新一轮说话。
   * 注意 `prepare()` 里用的仍是原 `reload()`：那次自动重读正是"环境建好了，正在重读…"所指向的事，
   * 自己把它擦掉就成了"按了按钮什么都没发生"。
   * 左栏那份列表（`reloadFiles`）跟着一起重读：这一页按钮上的名字叫"刷新状态"，读者期待的是
   * "把这一页读出来的东西都重新读一遍"，只重读一半就是拿旧的那两份冒充刚读的。
   */
  const reloadStatus = useCallback(() => {
    setPrepareLog(null);
    reload();
    reloadFiles();
  }, [reload, reloadFiles]);

  return (
    <div data-testid="notebook-page">
      <div className="page-head">
        <h2>Notebook</h2>
        <span className="muted small">本机 Jupyter · Python kernel 用的是网页 IDE 那份环境；Scala kernel 是镜像里独立的 JVM，不碰那份环境</span>
        <span className="spacer" />
        {/* 三把按钮并进这条工具条（用户点名"按钮合并到下面"；档位全是既有 .btn 系，不引新样式类）。
            「在新标签页打开」只在 open 态渲染：给一条点开就是浏览器报错的死链比不给更坏（静默降级），
            「准备环境」只在 blocked.length > 0 时渲染：全都就绪、或"缺的是 token 不是 venv"那一态，
            给按钮都是让人白点。两把的**缺席**各有判据（web/test 的 down/unreachable 两条 +
            e2e 在这个真实缺失态里钉的 count 0；原 nolink 那条缺席判据随态删除）。
            href 就是后端给的 `url` 原样（WI-98 后是同源 `/jupyter/tree`，不含凭据）——
            前端**不拼第二段**，那会造出路径的第二处真相。 */}
        <button type="button" className="btn btn-sm" onClick={reloadStatus} disabled={loading} data-testid="notebook-reload">
          {loading ? '读取中…' : '刷新状态'}
        </button>
        {view.kind === 'open' ? (
          <a className="btn btn-sm btn-primary" href={data?.url} target="_blank" rel="noreferrer" data-testid="notebook-open">
            在新标签页打开
          </a>
        ) : null}
        {blocked.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void prepare();
            }}
            disabled={preparing}
            data-testid="notebook-prepare"
          >
            {preparing ? '准备中…' : '准备环境'}
          </button>
        ) : null}
      </div>

      {/* 一行状态：后端三种形状各一句 + 前端两个读态，一共四句，**不许合并** —— 各修什么、
          为什么合并就等于"有一态没人说话"，见文件顶注释（那段理由原来就住在被删掉的卡头里，
          搬家搬的是它）。四句同住这一处三元链，互斥由结构保证；逐字与互斥的判据都在
          `web/test/notebook.test.tsx`。（原第五句「在跑，但地址给不出来」随 `nolink` 态删除，WI-98。） */}
      <div data-testid="notebook-status">
        {view.kind === 'loading' ? <Loading label="正在读 notebook 状态…" cards={1} /> : null}
        {view.kind === 'open' ? <p role="status">运行中 · Jupyter 在本机答话</p> : null}
        {view.kind === 'down' ? <p role="status">没在运行</p> : null}
        {view.kind === 'unreachable' ? <p role="status">状态读不到</p> : null}
      </div>

      {/* 横幅区：状态行之外所有"此刻还有话要说"的都堆在这一个壳里，空则整块不渲染（Group 的规矩）。
          open 解释句 / guardRefused（原 tokenless，WI-98 改了含义没让话消失）/ down / 两条 error /
          missingSpecIds / blocked 那句原因 / prepareLog / seedError —— 每条各修一件不同的事，
          合并即"有一件事没人说"；逐句措辞由测试钉着。（原 `nolink` 那条随状态删除，见文件顶注释。） */}
      <Group>
        {/* 逃生链接的解释句：原来贴在按钮旁边，按钮上工具条后话留在原地（"这把/上面那把"指的就是
            工具条里那一把 —— 它确实在这句话的上面）。WI-98：这把链接现在与内嵌同纪律（同源、无凭据）。 */}
        {view.kind === 'open' ? (
          <p className="tiny faint">
            这一页右边已经内嵌了一份，左栏点文件名就切过去；这把是给"想要整个 Jupyter 界面"的人用的逃生链接。
          </p>
        ) : null}

        {/* WI-98：这句从"链接里没有 token ⇒ 要手贴一次"改成"这条连接过不了守卫 ⇒ 点开会直接 403"。
            含义搬家而不是删掉（"话不许静默消失"的纪律）；三句内容逐条由
            `web/test/notebook.test.tsx`「localPeer:false」那条钉死：①被拒的是守卫不是服务、
            ②这不是故障、③设计上只在宿主本机用（手机/iPad 不是漏配 —— 用户 2026-10-05 的决定）。
            role 用 status 不用 alert：邻块（down / spec-missing）说的是同一类事，同一档语气。 */}
        {guardRefused ? (
          <p className="banner banner-warning" data-testid="notebook-not-local" role="status">
            这一页与上面那把「在新标签页打开」的链接都要经服务端守卫：这一条连接不是本机形状 ⇒ 点出去会被直接拒（403）。
            被拒的是守卫，不是 Jupyter 坏了，也不是链接坏了 —— 这不是故障。
            这一页设计上只在宿主本机使用：手机 / iPad 明确不支持，那是决定，不是漏配。
          </p>
        ) : null}

        {view.kind === 'down' ? (
          <p className="banner banner-warning" data-testid="notebook-down">
            <span>做题不受影响：判题走的是另一条执行底座，不经过这个服务。</span>
            <span className="tiny mono">{view.reason}</span>
          </p>
        ) : null}

        {/* 刷新失败而手上还有上一次读到的东西：状态照旧显示，但必须补一句"这次没读到"，
            否则界面是在拿旧真相冒充新真相（本项目在桥 token 上付过同一次学费）。 */}
        {error && data ? (
          <p className="banner banner-danger" data-testid="notebook-error" role="alert">
            <span>这次没读到，下面显示的是上一次读到的状态。</span>
            <span className="tiny mono">{error}</span>
          </p>
        ) : null}
        {error && !data ? (
          <p className="banner banner-danger" data-testid="notebook-error" role="alert">
            <span>状态没读到，做题不受影响。</span>
            <span className="tiny mono">{error}</span>
          </p>
        ) : null}

        {missingSpecIds.length > 0 ? (
          <p className="banner banner-warning" data-testid="notebook-spec-missing">
            探到的 kernel 表里没有 <span className="mono">{missingSpecIds.join('、')}</span> —— 那是镜像级的注册，
            「准备环境」修不了它。多半是镜像没按 Dockerfile 重建：跑一次 <span className="mono">./start.sh --rebuild</span>。
          </p>
        ) : null}

        {/* 「准备环境」的按钮本体在工具条，这句"为什么点它"留在横幅区：kernel 没就绪（venv 还没建）
            与"表里没有 spec"是两件事：只有前者那把按钮修得了。 */}
        {blocked.length > 0 ? (
          <p className="tiny faint">
            {blocked.map((k) => k.id).join('、')} 现在跑不起来：{blocked.map((k) => k.reason ?? '原因未给').join('；')}
          </p>
        ) : null}

        {prepareLog ? (
          <p className="banner" data-testid="notebook-prepare-result" role="status">
            {prepareLog}
          </p>
        ) : null}

        {/* 评审 I-1 的前端那一半：后端把"示例铺不进去"单独成一个字段（`seedError`），因为它与
            "没有示例"修的是不同东西 —— 前者查挂载/磁盘/权限，后者本来就没示例。混着说的症状是读者
            去翻示例目录，而该修的是只读挂载。（"没有示例"那句连同它所在的示例清单一起，按 2026-10-10
            用户批的范围删了；这句话因此只否定误解、不再引用页面上的另一块。）
            语气仍按"配置/IO 诊断"写：状态那一行此刻照旧说实话，这一句不宣称服务坏了。 */}
        {data?.seedError ? (
          <p className="banner banner-warning" data-testid="notebook-seed-error" role="status">
            <span>示例这次没能铺进工作目录 —— 这是"铺不进去"，不是"没有示例"，也与 Jupyter 在不在跑无关。</span>
            <span className="tiny mono">{data.seedError}</span>
          </p>
        ) : null}
      </Group>

      {view.kind === 'open' ? (
        <section className="card" data-testid="notebook-embed">
          <div className="nb-split">
            <div className="nb-tree" data-testid="notebook-tree">
              <div className="nb-tree-head small">笔记</div>
              <button
                type="button"
                className={`nb-tree-item${selected === null ? ' is-active' : ''}`}
                data-testid="notebook-manage"
                aria-current={selected === null ? 'true' : undefined}
                onClick={() => setSelected(null)}
              >
                文件管理
              </button>
              {(listing?.files ?? []).map((f) => (
                <button
                  type="button"
                  key={f}
                  className={`nb-tree-item${selected === f ? ' is-active' : ''}`}
                  data-testid="notebook-tree-item"
                  aria-current={selected === f ? 'true' : undefined}
                  onClick={() => setSelected(f)}
                >
                  {f.replace(/\.ipynb$/i, '')}
                </button>
              ))}
              {listing?.error ? (
                <p className="tiny faint" data-testid="notebook-tree-error">
                  {listing.error}
                </p>
              ) : /* ⚠ 第四种形状（评审 I-1）：那一发**整请求失败**（非 2xx / 连不上）⇒ 响应体里既没有
                   `files` 也没有服务端的 `error` 字段，上面那两句都不成立，于是这一句必须自己说。
                   判据是 `!listing && filesError`，与上下几支**结构互斥**（同一个三元，任何两句不可能同时渲染）：
                   少了这一支，左栏就是一片不解释的空白 —— 本轮开发中旧容器上那条路由回 404 时就是这个形状。
                   ⚠ 这一支刻意**只判 `!listing`**（一次都没读到过）：手上还挂着旧列表是**第五种**形状，
                   由下面那一支接管（Task 7c 按裁定补，此前它一句都不说）。 */
              !listing && filesError ? (
                <p className="tiny faint" data-testid="notebook-tree-unread">
                  这一次没读到左栏那份列表（不是"目录里没有"，也不是"服务端说读不到"—— 那一发压根没有答复）：
                  <span className="mono">{filesError}</span>
                </p>
              ) : /* ⚠ 第五种形状（Task 7c）：`listing && filesError` = 上一轮读回来了、这一轮刷新整发失败。
                   `useAsync` 失败那一支保留 `prev.data`（`web/src/lib/hooks.ts` 的失败分支），所以旧的那几份**还挂在
                   上面的列表里** —— 此时一句都不说就是拿上一轮的真相冒充刚读到的（状态那一行对同一件事早有先例：
                   「这次没读到，下面显示的是上一次读到的状态」）。
                   它排在 `notebook-tree-empty` **之前**不是随手放的：旧的列表恰好是空的（上一轮"没有"、这一轮
                   "没读到"）时，先报"没读到"才是真话 —— 让"目录里现在没有笔记"赢就会把"还不知道"说成"没有"，
                   正是本文件第三条注释那条纪律的反面。
                   与第一支（服务端在响应里给了 `error` 字段）的重叠由链序决定：上一轮带 `listing.error` 而这一轮
                   又整发失败时，说出去的是**服务端那句原话**，这一支不抢（那句至少还是读回来过的东西）。
                   判据：`web/test/notebook.test.tsx`「上一轮列表还在、这一轮刷新失败 ⇒ …不抢答另三句」。 */
              listing && filesError ? (
                <p className="tiny faint" data-testid="notebook-tree-stale">
                  这次没读到，下面列的是上一次读到的那一份：<span className="mono">{filesError}</span>
                </p>
              ) : /* ⚠ 这里必须判 `listing &&`（= "这一次读回来了"），不能写
                   `(listing?.files ?? []).length === 0`：后者在"还没读回来"时也是 0，于是首屏会闪一句
                   "目录里现在没有笔记" —— 那是把"还不知道"说成"没有"，与本文件 `seedError` 那条纪律同型
                   （"这一次读过了吗"决定"没有"这句话有没有资格说出口）。brief 原稿那段少了这一半，
                   已按先例补上（加上上面那条"占位值改成 null"，两半合起来才真的拦得住；
                   `web/test/notebook.test.tsx` 那条 pending 的用例就是它的破坏性验证）。 */
              listing && listing.files.length === 0 ? (
                <p className="tiny faint" data-testid="notebook-tree-empty">
                  目录里现在没有笔记：那是<span className="mono">没有</span>，不是读不到（读不到上面会单独点名）。
                </p>
              ) : null}
            </div>
            {/*
              src 只能是**同源相对路径**（`/jupyter/…`，全部由 `@arena/shared` 那三个常量派生）。
              为什么必须同源：绝对地址（旧的 `http://127.0.0.1:7789/…`）会让 iframe 里的请求从
              "我们这条同源通道"变成"往另一台主机发跨源请求"。用户用 `http://localhost:7788` 打开页面时，
              浏览器给这些请求判 `cross-site` ⇒ Jupyter 的 Host/Origin 守卫
              （`--ServerApp.allow_remote_access=False`）直接拒，症状是 iframe 里一片 403 / 登录页，
              而我们这一页、单测、E2E 全绿。相对路径让浏览器按当前文档的 origin 解析：`localhost` 与
              `127.0.0.1` 两种打开方式各自都是同源，走的都是我们那条反代（HTTP + websocket 两条通道都已就位）。
              URL 里也**不许**有 token：凭据只在服务端注入，守卫不过就在隧道里回 403/503。
              ⚠ WI-98 之后逃生链接（`notebook-open` 的 href）与这一路**共用同一条纪律** —— 它也是
              同源路径、也不带凭据；过去这把 iframe 是唯一不带凭据的、逃生链接是唯一的例外，现在例外没了。
              两条仍然各由一处派生（这里 `JUPYTER_BASE_URL` / `notebookDocPath`，那里只渲染后端 `url`），
              不因为形状相同就把两处折成一处 —— 默认落点（文件管理 vs tree）是两件事。
            */}
            <iframe
              className="nb-frame"
              data-testid="notebook-frame"
              title="Jupyter notebook"
              src={selected === null ? `${JUPYTER_BASE_URL}` : notebookDocPath(selected)}
            />
          </div>
        </section>
      ) : null}

      <section className="card" data-testid="notebook-boundary">
        {/* WI-94 Task 6 按用户批的范围把这块折起来一行（判的是可见性，不是删除）：
            summary 用 .card-title 保住原来那颗标题的视觉档位；边界话逐字由
            `web/test/notebook.test.tsx` 的 `boundarySentences` 钉着，不要顺手改写。
            WI-91b Task 5 把它从 5 段长到 7 段："共用环境 / pip 装哪套"两句改成**按 kernel 点名**
            （arena-pyspark 共用 IDE venv、arena-scala-toree 是镜像里独立的 Java 进程，方向相反），
            CPU 那句带上两条 kernel **各自**的 JVM 量级（量级由 `web/test/notebook.test.tsx` 从
            `docker/jupyter/kernels/<id>/kernel.json` **派生**后逐条钉住，页面与 README/ARCHITECTURE/JUDGING
            同源于工件，不许谁抄谁），再补 Scala 侧两件（报错形状 ename=Unknown Error 且空堆栈帧；
            补全/悬浮文档/中断三样的真相）。都不许美化。
            ⚠ 修复轮（2026-10-20）：第七段初稿把三样一并写成"不支持"，真浏览器实测推翻其中一条
            （补全会出面板），现在按**三条各自的实测**逐条说，并带上读数日期 —— 边界话的来源要在句子里。 */}
        <details className="nb-boundary-details">
          <summary className="card-title">这页跟判题有什么关系（7 条边界，点开看）</summary>
          <div className="col small">
            <p>
              两条 kernel 的「共用环境」不是同一件事：
              <strong>Python kernel</strong>（arena-pyspark）与 IDE 共用同一份环境，判题用的是另一套解释器 —— <strong>这是默认，不是这道页面上的强制</strong>；
              <strong>Scala kernel</strong>（arena-scala-toree）跑的是镜像里独立的 Java 进程，<strong>完全不碰 IDE 那份 venv</strong> —— venv 在不在与它无关，「准备环境」那把按钮也修不到它头上。
            </p>
            <p>
              <span className="mono">!pip3 install</span> 命中哪个 pip 由 <span className="mono">PATH</span> 决定 —— 这句只对 <strong>Python kernel</strong> 成立：服务那边把 IDE 那份 venv 前置在 PATH 上，所以默认装进的是 notebook 自己的环境。但绝对路径拦不住 ——
              <span className="mono">!/usr/local/bin/pip3 install X</span> 装进的就是判题那套解释器，改的是你之后每道题的判题结果（红线①的承诺由闸门守着，不由这一页守着）。
            </p>
            <p>
              这一页也管不住 <strong>CPU</strong>：
              <strong>Python kernel</strong> 自带 <span className="mono">--master local[2] --driver-memory 512m</span>，那是判题池之外的第二个 Spark JVM；
              <strong>Scala kernel</strong> 另起一个 <span className="mono">-Xmx2g -Dspark.master=local[2]</span> 的 JVM —— 两个 JVM 都不在队列里。「判题优先、IDE 排队、不抢占」那套安排看不见这两个，笔记本里跑重活时，被判题的那道 Spark 题可能被推向超时。
            </p>
            <p>
              <strong>Scala kernel</strong> 的报错形状与 Python 那条不同：编译错误的
              <span className="mono">ename</span> 恒为 <span className="mono">Unknown Error</span>，而且<strong>没有堆栈帧</strong> —— 报错有，但堆栈帧没有，能看的那句话在错误消息里（容器档负例夹具实测）。
            </p>
            <p>
              <strong>Scala kernel</strong> 这三样各有各的真相，界面按 2026-10-20 真浏览器实测说（同一本 Scala notebook，逐条量的）：
              <strong>补全有</strong> —— <span className="mono">val abcd = 123</span> 求值之后，在新格敲 <span className="mono">abc</span> 按 Tab 会弹补全面板；
              <strong>悬浮文档没有</strong> —— 两次 hover 都没有出面板；
              <strong>中断可以按，但没有可观察效果</strong> —— <span className="mono">Thread.sleep(60000)</span> 起跑 2 秒后按工具条那颗「Interrupt the kernel」，那一格照样跑到底出了结果，那条 JVM 也还活着（既不掐停正在跑的 cell，也不会把 kernel 弄死）。
            </p>
            <p>
              notebook 里能读到题库的参考答案 —— <strong>这不是安全边界</strong>。工作目录只是让默认视图干净，
              绝对路径读得到；它是练习工具，不是考官。
            </p>
            <p>
              <strong>只在浏览器本机打开：地址是 127.0.0.1，手机 / iPad 访问不了</strong>。
              两个端口都只绑在宿主的回环上，这不是漏配。
            </p>
          </div>
        </details>
      </section>
    </div>
  );
}
