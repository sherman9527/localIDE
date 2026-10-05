import { useCallback, useState } from 'react';
import { NOTEBOOK_KERNELS, type NotebookStatusResponse } from '@arena/shared';
import { api } from '../api';
import { errorMessage, isAbort } from '../lib/errors';
import { useAsync } from '../lib/hooks';
import { Badge, Loading } from '../components/AsyncState';

/**
 * 第五页：Jupyter notebook（A1 档）。
 *
 * 状态卡是这里唯一由后端说话的地方，后端给得出的四种形状各一句，**不许合并**（后端已经按"修的是不同东西"分了 reason）：
 *   ① 在跑且给得出链接 → 「运行中」+ 一个能点开的地址；
 *   ② 没在跑 → 「没在运行」+ 后端那句原因 + "做题不受影响"（判题不经过这个服务）；
 *   ③ kernel 没就绪 → 「准备环境」按钮 —— 缺的是 IDE 那份 venv，不是用户的写法；
 *   ④ 在跑、但 publicUrl 被 env 配坏（`running:true` + `reason` + 没有 url）：这一态既不是
 *      "点开它"也不是"没在运行"，两句都是谎。它必须自己占一块，还要点名坏掉的那一行 env
 *      —— 症状（页面没有链接）与"服务没起"一模一样，能区分它们的只有那句话。
 *
 * 三句话常驻，不随状态切换收起（IDE 那边同一课）：①环境共用、②答案可读不是安全边界、
 * ③只在本机打得开。用户在"要装包"和"要撞墙"的两个时刻都需要它们，而那正是状态最难看的时候。
 *
 * 还有一条**与上面四态正交**的诊断：`seedError`（示例铺不进去，评审 I-1）。它不许并进那四态里 ——
 * 并进去就把"磁盘/挂载的事"说成"服务的事"了；状态那一行此刻照旧说实话，这一句只在示例那一块说。
 *
 * 这里**不做定时轮询**：状态一栏有个「刷新状态」按钮，「准备环境」完成后自动重读一次。
 * 理由是那个 GET 会顺手铺示例（`server/src/api/app.ts` 的路由里），定时轮询=定时做一遍磁盘 I/O；
 * 而"这一页开着不动时状态本来就不会自己变"。真要轮询，等 Task 10 拿着容器里的数据再决定。
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

export default function Notebook() {
  const { data, loading, error, reload } = useAsync((signal) => api.notebookStatus({ signal }), []);
  const [preparing, setPreparing] = useState(false);
  const [prepareLog, setPrepareLog] = useState<string | null>(null);

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
   */
  const reloadStatus = useCallback(() => {
    setPrepareLog(null);
    reload();
  }, [reload]);

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
              打开 Jupyter
            </a>
            <span className="tiny faint">示例在 Jupyter 左侧的文件列表里点开。</span>
          </div>
        ) : null}

        {tokenless ? (
          <p className="banner banner-warning" data-testid="notebook-tokenless">
            这条链接里没有 token：后端判过这个连接不是本机（token 只发给本机那些连接）。
            点开会在 Jupyter 的登录页停一下，要手贴一次 token；这不是 Jupyter 坏了。
          </p>
        ) : null}

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

        {kernels.length > 0 ? (
          <div className="row-wrap row" data-testid="notebook-kernels">
            {kernels.map((k) => (
              <Badge key={k.id} tone={k.ready ? 'success' : 'danger'} title={k.reason ?? (k.ready ? '可以拿来跑' : undefined)}>
                {k.label}
                {k.ready ? '' : '（没就绪）'}
              </Badge>
            ))}
          </div>
        ) : null}

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
      </section>

      <section className="card" data-testid="notebook-boundary">
        <div className="card-head">
          <h3 className="card-title">这页跟判题有什么关系</h3>
        </div>
        <div className="col small">
          <p>
            这些包与 IDE 共用同一份环境，<strong>判题器看不到</strong>。notebook 里 <span className="mono">!pip3 install</span>{' '}
            装的东西不会让判题多用一分，也不会让判题少跑一秒。
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
      </section>
    </div>
  );
}
