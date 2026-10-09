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
import { Badge, Loading } from '../components/AsyncState';

/**
 * 第五页：Jupyter notebook（A1 档 + WI-94 的内嵌）。
 *
 * 状态卡是这里唯一由后端说话的地方，后端给得出的四种形状各一句，**不许合并**（后端已经按"修的是不同东西"分了 reason）：
 *   ① 在跑且给得出链接 → 「运行中」+ 一个能点开的地址；
 *   ② 没在跑 → 「没在运行」+ 后端那句原因 + "做题不受影响"（判题不经过这个服务）；
 *   ③ kernel 没就绪 → 「准备环境」按钮 —— 缺的是 IDE 那份 venv，不是用户的写法；
 *   ④ 在跑、但 publicUrl 被 env 配坏（`running:true` + `reason` + 没有 url）：这一态既不是
 *      "点开它"也不是"没在运行"，两句都是谎。它必须自己占一块，还要点名坏掉的那一行 env
 *      —— 症状（页面没有链接）与"服务没起"一模一样，能区分它们的只有那句话。
 *
 * ⑤ WI-94 Task 6 加进来的第五件事：**notebook 现在内嵌在这一页里**（左文件树 + 右 notebook），
 *    不再是"跳出去开一个独立标签页"。它带出一条与上面四态正交的规矩：
 *    **内嵌这一路不带凭据** —— src 只是同源路径（`/jupyter/…`），token 由服务端在反代里注入，
 *    守卫不过就在隧道里回 403/503，那个 JSON 会直接显示在 iframe 里。于是这一路**没有**
 *    "tokenless"那一态了（那一态说的是②③④那把**逃生链接**：在新标签页打开时要手贴一次 token），
 *    页面上也永远不该出现带 token 的 notebook URL（钉在 `web/test/notebook.test.tsx`）。
 *    ①②③④ 各态下 iframe 只有一态出现：`view.kind === 'open'`。`running:false` 时那棵子树结构上
 *    到不了，摆一个空 iframe 就是说谎（e2e 那个实例永远是 `running:false`，它的判据建立在这条上）。
 *
 * 那几句边界话常驻，不随状态切换收起（IDE 那边同一课）：①环境共用（判题用的是另一套解释器，
 * 绝对路径拦不住）、②CPU 不在这页管辖内、③答案可读不是安全边界、
 * ④只在本机打得开。用户在"要装包"和"要撞墙"的两个时刻都需要它们，而那正是状态最难看的时候。
 * （`db08cf8` 把第一句拆成了两句，所以这里今天是 5 段 = 上面 4 件事；逐字契约在
 * `web/test/notebook.test.tsx` 的 `boundarySentences`，浏览器层只钉名词：`tests/e2e/notebook-page.spec.ts`。）
 * WI-94 Task 6 按用户批的范围把这五段**折进一个 `<details>`**：措辞一字不改、DOM 里常驻，
 * 只是默认收成一行 —— 判据分两层：单元层钉"是 `<details>` 且默认折着 + 五段逐字仍在 DOM"，
 * 浏览器层钉"展开之后那五段真的可见"（折叠着的元素在 Playwright 里 `textContent` 照样读得到，
 * 所以只数段落数抓不到"忘了展开"，那一半必须由可见性判据负责）。
 *
 * 还有一条**与上面四态正交**的诊断：`seedError`（示例铺不进去，评审 I-1）。它不许并进那四态里 ——
 * 并进去就把"磁盘/挂载的事"说成"服务的事"了；状态那一行此刻照旧说实话，这一句只在示例那一块说。
 * 左栏那份列表（`notebookFiles`）用的是**同一条纪律的孪生**：有 `error` ⇒「这一次读不到」，
 * `files:[]` 且没有 `error` ⇒「目录里就是没有」，**还没读到** ⇒ 两句都不许说，
 * **那一发整请求失败**（404 / 连不上，评审 I-1）⇒ 第三句「这一次没读到左栏那份列表」+ 错误文本。
 * 三句两两互斥（同一条三元链，结构上不可能同时出现），少任何一句都是一次静默降级。
 *
 * 这里**不做定时轮询**：状态一栏有个「刷新状态」按钮，「准备环境」完成后自动重读一次。
 * 理由是那个 GET 会顺手铺示例（`server/src/api/app.ts` 的路由里），定时轮询=定时做一遍磁盘 I/O；
 * 而"这一页开着不动时状态本来就不会自己变"。真要轮询，等 Task 10 拿着容器里的数据再决定。
 * 「刷新状态」重读的是这一页**全部**读出来的真相（状态 + 左栏那份列表）：只重读前者时，用户在
 * Jupyter 里新建一份笔记再回来按刷新，树里还是旧的那两份 —— 那是"拿旧真相冒充新真相"。
 */

/**
 * 后端那四种形状的判别：只看后端给的三个字段（running / url / reason），不在前端再造一套真相。
 * `loading` / `unreachable` 是前端自己的两个读态（还没读到 / 这次读失败），不代表 Jupyter 的任何状态。
 */
type StatusView =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'down'; reason: string }
  | { kind: 'nolink'; reason: string }
  | { kind: 'open' };

function viewOf(data: NotebookStatusResponse | null, error: string | null): StatusView {
  if (!data) {
    // 一次都没读到过：这时候 error 就是"这一页现在什么都不知道"
    if (error) return { kind: 'unreachable' };
    return { kind: 'loading' };
  }
  if (!data.running) return { kind: 'down', reason: data.reason ?? '后端没给原因（契约要求 running:false 必填 reason）' };
  if (!data.url) return { kind: 'nolink', reason: data.reason ?? '后端没给原因（契约要求这一态必须说清坏在哪一行）' };
  return { kind: 'open' };
}

/**
 * 状态卡里的一个分组壳：**没有内容就整个不渲染**。
 *
 * 每条分隔线的意思是"上面那组说完了"。壳在而内容全是 `null` 时，页面上会出现一条
 * **没有任何话的空白带加一根分隔线** —— 读者会去找那句被"漏掉"的话，而它根本不存在。
 * 最常见的那一态（在跑、一切正常）本来会挂两条这种空带。
 *
 * 这条只在真浏览器里看得见，两档自动化都照不出来：jsdom 没有布局（空壳与有内容的壳在
 * `textContent` 判据下一模一样），而 e2e 那个实例是 `running:false`（诊断那一组本来就有话）。
 * 它是 Step 3 第 8 条那两张截图（1440 / 480）里看见的，实测读数：`.nb-group` 四个，其中两个
 * `childElementCount: 0` 却 `height: 17px`、`borderTopWidth: 0.67px`。
 *
 * 判据分两层：`web/test/notebook.test.tsx` 数渲染出来的壳（DOM 形状），
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
  /** 探到的 kernel 表里压根没有那个 pyspark 档：镜像级注册没了，「准备环境」修不了它 ⇒ 得说清区别。 */
  const missingSpec = data?.running === true && !kernels.some((k) => k.id === NOTEBOOK_KERNELS.pyspark);
  /** 链接里没有 token = 后端判过这个连接不是本机（判据在 socket 上，不在这里）。界面要提前说破。 */
  const tokenless = view.kind === 'open' && !(data?.url ?? '').includes('token=');

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
        <span className="muted small">本机 Jupyter · kernel 用的是网页 IDE 那份环境</span>
      </div>

      <section className="card" data-testid="notebook-status-card">
        <div className="card-head">
          <h3 className="card-title">运行时</h3>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={reloadStatus} disabled={loading} data-testid="notebook-reload">
            {loading ? '读取中…' : '刷新状态'}
          </button>
        </div>

        <Group>
          <div data-testid="notebook-status">
            {view.kind === 'loading' ? <Loading label="正在读 notebook 状态…" cards={1} /> : null}
            {view.kind === 'open' ? <p role="status">运行中 · Jupyter 在本机答话</p> : null}
            {view.kind === 'down' ? <p role="status">没在运行</p> : null}
            {view.kind === 'nolink' ? <p role="status">在跑，但地址给不出来</p> : null}
            {view.kind === 'unreachable' ? <p role="status">状态读不到</p> : null}
          </div>

          {view.kind === 'open' ? (
            <div className="row-wrap row">
              <a className="btn btn-primary" href={data?.url} target="_blank" rel="noreferrer" data-testid="notebook-open">
                在新标签页打开
              </a>
              <span className="tiny faint">
                这一页右边已经内嵌了一份，左栏点文件名就切过去；这把是给"想要整个 Jupyter 界面"的人用的逃生链接。
              </span>
            </div>
          ) : null}
        </Group>

        {tokenless ? (
          <p className="banner banner-warning" data-testid="notebook-tokenless">
            这条链接里没有 token：后端判过这个连接不是本机（token 只发给本机那些连接）。
            用上面那把「在新标签页打开」时会在 Jupyter 的登录页停一下，要手贴一次 token；这不是 Jupyter 坏了。
            右边内嵌那一栏不走这条链接、也不带凭据：守卫不过它会直接在 iframe 里回一个 403。
          </p>
        ) : null}

        <Group>
          {/* ④ 这一态单独一块：给不出链接 ≠ 没在跑。坏的是 ARENA_NOTEBOOK_PUBLIC_URL 那一行 env。
              措辞刻意绕开"没在运行"那四个字 —— 它们是另一态的话，两句同时出现读者就分不清了。
              role 用 status 不用 alert（评审 Fix-1 的 Minor）：这是"配置坏了"的诊断，不是"你刚才那次
              操作失败了"；alert 会打断屏幕阅读器当前的朗读，而邻块（down / tokenless / spec-missing）
              说的同一类事并没有各自升级成报警。 */}
          {view.kind === 'nolink' ? (
            <p className="banner banner-warning" data-testid="notebook-nolink" role="status">
              <span>Jupyter 确实在答话，只是这个实例拼不出能点开的链接 ⇒ 别按"服务没起"去处理，重启它修不了这一态。</span>
              <span className="tiny mono">{view.reason}</span>
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

          {missingSpec ? (
            <p className="banner banner-warning" data-testid="notebook-spec-missing">
              探到的 kernel 表里没有 <span className="mono">{NOTEBOOK_KERNELS.pyspark}</span> —— 那是镜像级的注册，
              「准备环境」修不了它。多半是镜像没按 Dockerfile 重建：跑一次 <span className="mono">./start.sh --rebuild</span>。
            </p>
          ) : null}
        </Group>

        <Group>
          {/* kernel 没就绪（venv 还没建）与"表里没有 spec"是两件事：只有前者这个按钮有用。 */}
          {blocked.length > 0 ? (
            <div className="row-wrap row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void prepare();
                }}
                disabled={preparing}
                data-testid="notebook-prepare"
              >
                {preparing ? '准备中…' : '准备环境'}
              </button>
              <span className="tiny faint">
                {blocked.map((k) => k.id).join('、')} 现在跑不起来：{blocked.map((k) => k.reason ?? '原因未给').join('；')}
              </span>
            </div>
          ) : null}

          {prepareLog ? (
            <p className="banner" data-testid="notebook-prepare-result" role="status">
              {prepareLog}
            </p>
          ) : null}
        </Group>

        <Group>
          <div className="small nb-group-label">这一页读到的示例（"这次铺了什么"，与左边那棵"目录里现在有什么"是两件事）</div>
          {data && data.notebooks.length > 0 ? (
            <div className="row-wrap row tiny" data-testid="notebook-files">
              {data.notebooks.map((n) => (
                <span key={n.file} className="row">
                  <span className="mono">{n.file}</span>
                  <Badge tone={n.seeded ? 'primary' : 'plain'}>{n.seeded ? '这次新铺的' : '已存在，没动它'}</Badge>
                </span>
              ))}
            </div>
          ) : null}

          {/* 评审 I-1 的前端那一半：后端现在把"示例铺不进去"单独成一个字段（`seedError`），
              因为它与"没有示例"修的是不同东西 —— 前者查挂载/磁盘/权限，后者本来就没示例。
              混着说的症状是读者去翻示例目录，而该修的是只读挂载。
              语气仍按"配置/IO 诊断"写：运行时那一块（上面几行）此刻照旧说实话，这一行不宣称服务坏了。 */}
          {data?.seedError ? (
            <p className="banner banner-warning" data-testid="notebook-seed-error" role="status">
              <span>示例这次没能铺进工作目录 —— 这是"铺不进去"，不是"没有示例"，也与 Jupyter 在不在跑无关。</span>
              <span className="tiny mono">{data.seedError}</span>
            </p>
          ) : null}

          {data && !data.seedError && data.notebooks.length === 0 ? (
            <p className="tiny faint" data-testid="notebook-files-empty">
              工作目录里现在没有示例：那是<span className="mono">没有</span>，不是铺失败（铺失败上面会单独点名原因）。
            </p>
          ) : null}
        </Group>
      </section>

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
                   `useAsync` 失败那一支保留 `prev.data`（`web/src/lib/hooks.ts:41`），所以旧的那几份**还挂在
                   上面的列表里** —— 此时一句都不说就是拿上一轮的真相冒充刚读到的（状态卡对同一件事早有先例：
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
                   "目录里现在没有笔记" —— 那是把"还不知道"说成"没有"，与本文件里 `notebook-files-empty`
                   （判的是 `data &&`）与 `seedError` 那条纪律同型。brief 原稿那段少了这一半，
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
              为什么不是后端那把 `notebook-open` 的绝对地址：那串带的是 `http://127.0.0.1:7789/…`，
              iframe 里的请求就会从"我们这条同源通道"变成"往另一台主机发跨源请求"。用户用
              `http://localhost:7788` 打开页面时，浏览器给这些请求判 `cross-site` ⇒ Jupyter 的
              Host/Origin 守卫（`--ServerApp.allow_remote_access=False`）直接拒，症状是 iframe 里
              一片 403 / 登录页，而我们这一页、单测、E2E 全绿。相对路径让浏览器按当前文档的
              origin 解析：`localhost` 与 `127.0.0.1` 两种打开方式各自都是同源，走的都是我们
              那条反代（HTTP + websocket 两条通道都已就位）。
              URL 里也**不许**有 token：凭据只在服务端注入，守卫不过就在隧道里回 403/503。
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
            summary 用 .card-title 保住原来那颗标题的视觉档位；五段话**逐字**搬进来，
            措辞由 `web/test/notebook.test.tsx` 的 `boundarySentences` 钉着，不要顺手改写。 */}
        <details className="nb-boundary-details">
          <summary className="card-title">这页跟判题有什么关系（5 条边界，点开看）</summary>
          <div className="col small">
            <p>
              notebook 的 kernel 与 IDE 共用同一份环境，判题用的是另一套解释器 —— <strong>这是默认，不是这道页面上的强制</strong>。
            </p>
            <p>
              <span className="mono">!pip3 install</span> 命中哪个 pip 由 <span className="mono">PATH</span> 决定：
              服务那边把 IDE 那份 venv 前置在 PATH 上，所以默认装进的是 notebook 自己的环境。但绝对路径拦不住 ——{' '}
              <span className="mono">!/usr/local/bin/pip3 install X</span> 装进的就是判题那套解释器，
              改的是你之后每道题的判题结果（红线①的承诺由闸门守着，不由这一页守着）。
            </p>
            <p>
              这一页也管不住 <strong>CPU</strong>：kernel 自带{' '}
              <span className="mono">--master local[2] --driver-memory 512m</span>，
              那是判题池之外的第二个 Spark JVM —— 「判题优先、IDE 排队、不抢占」那套安排看不见它，
              笔记本里跑重活时，被判题的那道 Spark 题可能被推向超时。
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
