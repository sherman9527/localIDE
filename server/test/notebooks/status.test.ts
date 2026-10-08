import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { NOTEBOOK_KERNELS, type NotebookStatusResponse } from '@arena/shared';
import { config } from '../../src/config.js';
import { notebookStatus, parseProcNetRoute } from '../../src/notebooks/status.js';

/**
 * 评审 M8：把"日志里不许出现 token"从**源码正则**换成**行为判据**。
 * 原来那两条 `expect(src).not.toMatch(/logInfo\([^)]*token/)` 挡不住真正的泄漏写法 ——
 * `logInfo('notebook','status',{ url })` 里既没有 "token" 这个词、而 url 的 query 里就躺着 token，
 * 正则一片绿，日志里全是可复制的凭据。现在改判"调用发生过什么"：把日志出口与 console 全接成替身，
 * 用一个 canary 当 token 跑遍各条分支，任何一次日志调用里都不许出现它。
 * 这里 mock 掉整个 `log.js`（其余导出保留真实现），是为了让"将来谁在这儿加一行 logInfo"落在判据里。
 */
const logSpy = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock('../../src/log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/log.js')>()),
  ...logSpy,
}));

/** 把一次调用的实参压成可搜索的文本：字符串原样、对象走 inspect（JSON.stringify 会把 URL 实例压成 {}）。 */
function argsText(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6, breakLength: 10_000 }))).join(' ');
}

/**
 * `GET /api/kernelspecs` 的回话。这份 fixture 的自我声明是"世界实际发的是什么"的那份记录，
 * 所以它**不许在被声称逐字的情况下带编造值**（评审 I-5 —— 上一版就是这么坏的：
 * `arena-pyspark` 的 `env` 是手抄的，而且抄错了：真值除了 warehouse.dir 还带
 * `--conf spark.driver.extraJavaOptions=-Dderby.system.home=…`、`--master local[2]`、
 * `--driver-memory 512m` 与 `pyspark-shell` 尾缀，env 里也漏了 `SPARK_LOCAL_IP` 与
 * `PYSPARK_DRIVER_PYTHON`。把我们自己发出去的那个 kernel 引错，正是这一轮要停止做的事）。
 *
 * 现在分两层保真，各按各自的方式：
 * ① `arena-pyspark` 那一条的 `argv` / `env` / `display_name` / `language` / `interrupt_mode` /
 *   `metadata` 是**读**出来的（`docker/jupyter/kernels/arena-pyspark/kernel.json`，就是 Dockerfile
 *   COPY 进镜像的那份）—— Jupyter 在 `spec` 那一层回的就是这个文件的键，所以这一支不可能与真值漂移。
 * ② `python3` 那一条是 ipykernel 自带的、仓库里没有对应文件，所以它是**抄的**，抄的是 2026-10-08
 *   从跑着的 arena 容器里 `curl -H "Authorization: token $…" http://127.0.0.1:8888/api/kernelspecs`
 *   拿到的原值（`argv:["python","-m","ipykernel_launcher","-f","{connection_file}"]`、`env:{}`、
 *   `display_name:"Python 3 (ipykernel)"`、`language:"python"`、`interrupt_mode:"signal"`、
 *   `metadata:{debugger:true}`、`kernel_protocol_version:""`）。
 *   ⚠ `kernel_protocol_version` 那个**空串是真值**，不是编的（评审 I-5 说它是编的 —— 那一条不成立：
 *   jupyter 对没在 kernel.json 里声明这一键的 spec 就回空串，实测连 `arena-pyspark` 那一支也是 `""`，
 *   所以下面 ① 那支也补了一个 `''`，两支形状一致）。这一支会随 ipykernel 版本漂 —— 漂了不影响
 *   任何断言（没有解析器读这些叶子），但别把它当成"当下实测过的值"。
 *
 * ⚠ 顶层那个映射叫 **`kernelspecs`**，不叫 `kernels`。这份 fixture 以前按 `kernels` 写，
 * 于是 mock 与实现**同一个错**：十一条 tests 全绿，而第五页在用户眼前说
 * 「探到的 kernel 表里没有 arena-pyspark ⇒ 跑一次 `./start.sh --rebuild`」——
 * 那个 kernel 其实注册着，并且刚在容器档里真跑通过 Spark（评审实测）。
 * 按想象中的键名写的 fixture 修不了这个 bug，它只会替 bug 作证。
 * 真正判住"解析的键必须与真回话同源"的是容器档那条 `kernel.test.ts`
 * 「对着真 Jupyter 解 kernelspecs」—— 它不经过任何 mock，基准是盘上那份 kernel.json。
 *
 * 三个容易写错的形状都留在这份 fixture 里：
 * ① 标签嵌在 `kernelspecs[<id>].spec.display_name`，不在 entry 顶层；
 * ② `default` 指着的 `python3` 本身也是一条 kernel（少收一条 = 界面列的与 Jupyter 自己列的不是一回事）；
 * ③ entry 还带着 `name` / `resources` 两个兄弟键（解析按 entries 走，多余键不该改变结果）。
 */
const SHIPPED_KERNEL_FILE = join(config.repoRoot, 'docker', 'jupyter', 'kernels', NOTEBOOK_KERNELS.pyspark, 'kernel.json');
// 读不到就响亮地停在这里（同 notebook-image.test.ts 的先例）：这一支 fixture 的真值只有这一个来源，
// 悄悄退回一份手抄的常量 = 把评审 I-5 刚修掉的那个坏形状重新请回来。
if (!existsSync(SHIPPED_KERNEL_FILE)) {
  throw new Error(
    `${SHIPPED_KERNEL_FILE} 不存在 ⇒ NOTEBOOK_KERNELS.pyspark（当前值 '${NOTEBOOK_KERNELS.pyspark}'）` +
      '与 docker/jupyter/kernels/ 下的目录名分叉了：改常量要同时改目录（和 Dockerfile 的 COPY 目标）。',
  );
}
const SHIPPED_KERNEL_SPEC = JSON.parse(readFileSync(SHIPPED_KERNEL_FILE, 'utf8')) as {
  argv: string[];
  display_name: string;
  language: string;
  interrupt_mode?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
};
const KERNELSPECS_BODY = {
  default: 'python3',
  kernelspecs: {
    python3: {
      name: 'python3',
      spec: {
        argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        env: {},
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        interrupt_mode: 'signal',
        metadata: { debugger: true },
        kernel_protocol_version: '',
      },
      resources: {},
    },
    'arena-pyspark': {
      name: NOTEBOOK_KERNELS.pyspark,
      spec: {
        ...SHIPPED_KERNEL_SPEC,
        // jupyter 给每一条 spec 都补这一键（实测 ""，见上面 ②），而 kernel.json 里没有它 ⇒ 单独补。
        kernel_protocol_version: '',
      },
      resources: {},
    },
  },
};

const fake = () =>
  vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => KERNELSPECS_BODY }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }) as unknown as typeof fetch;

/**
 * 只有 `/api/status` 回那个状态码，kernelspecs 照常答 200。
 * 故意做成"半个坏"：两个端点各有各的守卫，若假 fetch 两边一律 403，删掉任意一支都会被另一支
 * 替它说出一句对的话 ⇒ 那条变异测不出来（评审要的就是"每一支都独立被判住"）。
 * kernelspecs 那份 body 用**真形状的空表**（`kernelspecs: {}`，即"一个 kernel 都没注册"是 Jupyter
 * 真会给的合法回话），不是旧那份 `{ kernels: {} }` —— 后者是同一个键名幻觉的第二次落笔。
 */
const statusDeny = (status = 403) =>
  (vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => ({ default: 'python3', kernelspecs: {} }) }
      : { status, json: async () => ({}) }
  ) as unknown as typeof fetch);

/** 只有 /api/kernelspecs 坏掉：状态码非 200，body 是 HTML（json() 必抛 SyntaxError）。 */
const kernelspecsBoom = (status: number) =>
  (vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }
  ) as unknown as typeof fetch);

const refuses = (message: string) =>
  (vi.fn(async () => {
    throw new Error(message);
  }) as unknown) as typeof fetch;

// 每条用例都显式给 tokenOverride：宿主上 config.notebook.token 是空的（compose 才设它），
// 不显式覆盖的话第 1 条会在"没配 token 就 running:false"那条早退分支上红 —— 那是环境差，不是实现错。
// hostHeader 同批发下去是 **C-1** 的结果：token 释放现在读的是**合取**（对端本机 **且** Host 是本机字面量），
// 这一份是"两半都对"的基准形状，各条用例只在要判某一半时单独改掉那一半。
const TOK = { tokenOverride: 'test-token', hostHeader: '127.0.0.1:7788' };

/**
 * 造「token 那个**键**在不在」的入参。
 * 为什么判的是键而不是值：compose 给 arena/tools 的是 `${ARENA_JUPYTER_TOKEN:-}` 插值，
 * 于是那两个容器里"键在、值为空"= token 从没生成；dev/e2e 连键都没有（notebook-compose ⑥ 钉的形状）
 * = 这个实例按设计不参与 notebook。两句话的修法相反，所以两条文案要各判一次。
 *
 * ⚠ **终审 I-2 改了这里的实现，没改它判的事**：这一版以前是真的去改 `process.env`，而那个动作今天
 * 已经判不到任何东西了 —— `config.ts` 把这个键**读完就从 process.env 摘掉**（凭据不许经由
 * `{ ...process.env }` 被每一个判题子进程继承），所以"键在不在"在生产里是**读的那一刻记下的一个布尔**
 * （`config.notebook.tokenKeyPresent`）。现场写 process.env 既不生效、也测不出"不生效"这件事本身。
 * ⇒ 这里注入那个布尔。剩下的两层各由别处判：「摘之前记下形状」这个动作 =
 * `server/test/regression/ide-env-isolation.test.ts` 的 D 组；「容器里 compose 到底给没给这个键」=
 * `server/test/notebooks/kernel.test.ts`（读的也是记下来的那份，理由写在那里）。
 */
const tokenKeyShape = (present: boolean) => ({ tokenKeyPresent: present });

describe('notebookStatus', () => {
  it('服务在跑：running + 带 token 的本机地址 + kernel 就绪', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK });
    expect(res.running).toBe(true);
    // 期望值从 config 派生（评审 M9）：原来这里写死 `http://127.0.0.1:7789`，
    // 于是"宿主端口换个号"会同时改掉 compose 与 config 而这条测试独自红 —— 那是冤红，
    // 冤红教给下一个人的是"改测试里的数字"，而不是"看谁真的漂移了"。
    expect(res.url).toBe(`${config.notebook.publicUrl}/tree?token=test-token`);
    // 两条都要在，且标签来自 `spec.display_name`（不是 id、不是顶层）：
    // 这一句以前只期望 arena-pyspark 一条，因为 fixture 里就只有那一条 —— 真回话两条都列，
    // 少收 python3 的代价是"界面显示的 kernel 清单与 Jupyter 自己列的不是一回事"，没人会当 bug 报。
    expect(res.kernels).toEqual([
      { id: 'python3', label: 'Python 3 (ipykernel)', ready: true },
      { id: 'arena-pyspark', label: 'PySpark (arena)', ready: true },
    ]);
  });

  it('探不到 ⇒ running:false，且 reason 能区分"没起"与"超时"（修的是不同东西）', async () => {
    const res = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: (vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown) as typeof fetch,
    });
    expect(res.running).toBe(false);
    expect(res.reason).toContain('ECONNREFUSED');
    expect(res.kernels).toEqual([]);
  });

  it('非本机对端拿不到 token（链接照给，token 不外泄）', async () => {
    const res = await notebookStatus({ peerAddress: '192.168.1.20', fetchImpl: fake(), ...TOK });
    expect(res.url).toBeDefined();
    expect(res.url).not.toContain('token=');
  });

  /**
   * 评审 M-1 的两半（旧的 LOOPBACK 正则换成按地址族判定）：
   * ① 认法要覆盖 IPv6 的真形状 —— socket 给的是裸 `::1`，双栈监听时 IPv4 对端写成
   *    `::ffff:127.0.0.1`，`127.0.0.0/8` 整段都是本机（不止 .1）；
   * ② **旧判据的假阳性必须单独钉**：`::1:7788` 是一条合法 IPv6 地址（展开成 `0:0:0:0:0:0:1:7788`），
   *    而旧那条 `...|::1)(:\d+)?$` 把它当"回环 + 端口"⇒ 一个非本机字面量换到了 token。
   *    socket 地址永远不带端口，所以这里不给任何"尾巴上带冒号就当端口"的宽容。
   * ③ 同一条道理（评审 Fix-1 的 Minor）：`remoteAddress` 也**永远不是主机名**，所以 `'localhost'`
   *    这个字面量不该有本机资格 —— 旧正则里那个 `|localhost` 分支是从 Host 头时代抄过来的死代码，
   *    留着它等于给"哪天有人把某个自报字符串塞进对端地址"预留一条通到凭据的路。
   * 方向也要各断一边：漏认本机 = 用户得手贴 token（那条静默降级）；多认外来者 = 泄漏。
   */
  it('本机对端的认法覆盖 IPv6 两种写法，而 `::1:7788` / `localhost` 这类字面量不在其内', async () => {
    for (const peer of ['::1', '127.0.0.1', '127.0.0.42', '::ffff:127.0.0.1']) {
      const res = await notebookStatus({ peerAddress: peer, fetchImpl: fake(), ...TOK });
      expect(res.url, `${peer} 是本机 ⇒ 不给 token 就得让用户手贴`).toContain('token=test-token');
    }
    for (const peer of ['192.168.1.20', '::ffff:192.168.1.20', '::1:7788', '10.0.0.1', '', '127', '127.0.0', 'localhost']) {
      const res = await notebookStatus({ peerAddress: peer, fetchImpl: fake(), ...TOK });
      expect(res.url, `${peer} 不是本机 ⇒ token 不许出现在响应里`).not.toContain('token=');
    }
  });

  /**
   * 容器那一半：`./start.sh` 起的 arena 里，宿主浏览器的请求经 docker-proxy / NAT 进来，
   * 对端是**这张网桥的网关**（172.18.0.1 那一类），永远不会是 127.0.0.1。
   * 只认回环的判据不会报错，它会安静地让容器里的页面永远拿不到 token ⇒ 点开就是 Jupyter 登录页，
   * 而界面一片绿 —— 正是本仓库付过学费的那类静默降级。
   * 判据仍不是客户端给的：网关地址来自 `/proc/net/route`（内核告诉我谁是出口），测试走注入的那一份。
   */
  it('对端是本容器自己的默认网关（docker 网桥）⇒ 视为本机，给 token', async () => {
    const gw = { gatewayAddresses: ['172.18.0.1'] };
    const via = await notebookStatus({ peerAddress: '172.18.0.1', fetchImpl: fake(), ...TOK, ...gw });
    expect(via.url, '容器部署里这就是"本机点开"的唯一形状 ⇒ 不给 token 等于功能没上').toContain('token=test-token');
    // 同一台机器上的另一个容器地址不是网关 ⇒ 不给（这条判据不是"172.x 都算本机"）
    const sibling = await notebookStatus({ peerAddress: '172.18.0.7', fetchImpl: fake(), ...TOK, ...gw });
    expect(sibling.url).not.toContain('token=');
  });

  /**
   * **C-1（终审）把上一轮的这条断言反过来了**，这里把新旧两句话都留在原地，免得下一位再吵一遍：
   * 上一轮反对的是「**Host 单独说话**」—— `Host: 127.0.0.1:7788` 任何人都写得出来，照着它发凭据
   * 等于把 token 发给局域网里任意一个请求。那一条裁决今天**仍然成立**，被推翻的只有
   * 「Host 完全不参与判定」这半句。
   *
   * 现在的判据是**合取**：`isLocalPeer(对端)` **且** Host 头的 hostname 是本机字面量。
   * 合取严格强于任何一半，所以两个方向都要有独立的红：
   * ① 只有 Host 对（局域网里伪造头的那个）⇒ 不给 —— 上面 `192.168.1.20` 那条与下面表里那一行判它；
   * ② 只有对端对（**DNS rebinding**：受害者浏览器把攻击域名的 A 记录改成 `127.0.0.1`，
   *    socket 对端**就是**回环，而响应与攻击页同源 ⇒ 页面上的 JS 读得到 `url` 里那个 token，
   *    拿到的是"能在容器里以 root 执行任意代码"的长期凭据：写在 `.env`、重启不换）⇒ 也不给。
   * 只留 ① 的那一半判据时 ② 是绿的，这就是这一轮补的东西。
   *
   * `Host: localhost:7789` 这一行是**故意钉住的决定**：`localhost` 是名字不是地址，
   * 但 rebinding 要的是"域名解析到我控制的 IP"，把 localhost 解析走等于让攻击者域名 = localhost，
   * 那种 DNS 任何正经解析器都不接受；而 `http://localhost:7788` 是用户真会敲的第二个写法
   * （`start.ps1` 的健康检查就用它）。放行它、并在这里钉住，比"松一半让某个写法进来"更好。
   */
  it('token 释放是合取：对端本机 **且** Host 是本机字面量（C-1：DNS rebinding 拿不到 token）', async () => {
    const gw = { gatewayAddresses: ['172.18.0.1'] };
    const cases: Array<{ peer: string; host: string | undefined; want: boolean; why: string }> = [
      { peer: '127.0.0.1', host: '127.0.0.1:7788', want: true, why: '宿主直跑：两半都对' },
      { peer: '127.0.0.1', host: 'localhost:7789', want: true, why: 'localhost 写法（上面那段决定）' },
      { peer: '::1', host: '[::1]:7788', want: true, why: 'IPv6 回环的带括号写法' },
      { peer: '172.18.0.1', host: '127.0.0.1:7788', want: true, why: '容器部署里用户真实的那条路：对端=网桥网关、Host=宿主回环' },
      { peer: '127.0.0.1', host: 'evil.example.com:7788', want: false, why: 'DNS rebinding：对端确实是回环' },
      { peer: '172.18.0.1', host: 'rebinding.example:7788', want: false, why: '同一半在容器部署里也否决' },
      { peer: '192.168.1.20', host: '127.0.0.1:7788', want: false, why: '伪造头（上一轮 M-1 的形状，必须继续红）' },
      { peer: '::1:7788', host: '127.0.0.1:7788', want: false, why: '非回环字面量当对端（旧 IPv6 正则的假阳性）' },
      { peer: '127.0.0.1', host: '127.0.0.1.evil.example', want: false, why: '以本机字面量开头的域名不是本机地址' },
      { peer: '127.0.0.1', host: '127.0.0.1:7788:99', want: false, why: '多一个冒号的 Host 是坏值 ⇒ fail closed' },
      { peer: '127.0.0.1', host: '', want: false, why: '没有 Host 头 ⇒ fail closed' },
      { peer: '127.0.0.1', host: undefined, want: false, why: 'Host 头缺席（HTTP/1.0 或被人摘掉）⇒ fail closed' },
    ];
    for (const c of cases) {
      // ⚠ `...TOK` 必须在**前面**：它带着基准那份 `hostHeader`，放后面会把用例自己那个 Host 顶掉
      // （第一版就是这么错的 —— 于是"外来 Host"那一行拿着本机 Host 跑，红在测试自己写的断言上）。
      const res = await notebookStatus({ ...TOK, ...gw, peerAddress: c.peer, hostHeader: c.host, fetchImpl: fake() });
      if (c.want) {
        expect(res.url, `${c.why}：两半都成立却不给 token ⇒ 用户得手贴（静默降级那一侧）`).toContain('token=test-token');
      } else {
        expect(res.url, `${c.why}：这一半不成立却给了 token ⇒ 泄漏`).not.toContain('token=');
        expect(JSON.stringify(res), `${c.why}：token 出现在任何字段里都算泄漏`).not.toContain('test-token');
      }
    }
  });

  /**
   * 缺的那一半不许靠"调用方忘了传"蒙过去：`hostHeader` 是**必填**入参（类型层面就要求每个调用点
   * 表态），而 `undefined` 走的是 fail-closed 那一支。这条判的是接线的形状，不是文案。
   */
  it('路由忘传 Host 头时不给 token（新增入参不许有"忘了也照样绿"的形状）', async () => {
    const noHost = await notebookStatus({ ...TOK, peerAddress: '127.0.0.1', hostHeader: undefined, fetchImpl: fake() });
    expect(noHost.running).toBe(true);
    expect(noHost.url, '没给 Host 头 ⇒ 合取判不上 ⇒ 宁可不给（用户至多手贴一次 token）').not.toContain('token=');
  });

  it('超时与"没起"给的 reason 必须不同（同一个 reason 会让人去查错的地方）', async () => {
    const res = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: (vi.fn(async () => {
        throw new Error('This operation was aborted');
      }) as unknown) as typeof fetch,
    });
    expect(res.reason).toMatch(/超时/);
  });

  it('没配 token 时如实报，不假装能用', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK, tokenOverride: '' });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
  });

  /**
   * 评审 I-2：`status.ts` 里"HTTP 状态码不是 200"那一支原先**没有任何假 fetch 会走到** ——
   * 五条用例全返回 200。后果是把那个分支删掉、或者干脆在 403 上也回 `running:true`，
   * 十二 tests 照样绿；而后者正是 token 重新生成之后的形状：旧 token 换来一句 403，
   * 界面写"kernel 就绪"，其实一次鉴权都没过。403 的文案还必须点名 token，
   * 因为"服务在跑但不认识我"是唯一一句读者能直接行动的失败。
   */
  it('Jupyter 答 403 ⇒ running:false，且明说 token 不匹配（不许读成"kernel 就绪"）', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: statusDeny(), ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/403/);
    expect(res.reason, '只说"返回 403" ⇒ 读者不知道该去重新拿 token 还是去重启服务').toMatch(/token 不匹配/);
    expect(res.kernels).toEqual([]);
    expect(res.url, '鉴权都没过还发一条能点开的链接 ⇒ 前端把它渲染成"就绪"，正是这句谎').toBeUndefined();
  });

  /**
   * 评审 I-3：`/api/kernelspecs` 原来不判状态码就直接 `.json()`，两种坏法都没人管：
   * ① HTML body ⇒ json() 抛 SyntaxError ⇒ 被下面那个 catch 说成"Jupyter 未在监听"
   *    （它在监听，是它答得不像话），于是读者去重启一个正在好好干的服务；
   * ② body 恰好可解析成 JSON ⇒ `running:true, kernels:[]` 且没有 reason，界面一片空白。
   * 判据形状照 /api/status 那条，而且**共用同一个 reason builder** —— 所以这里还断言
   * "403 发生在哪个端点上，说出来的话一字不差"，否则两条文案各漂移一份没人知道。
   */
  it('kernelspecs 的回话同样判状态码：500 的 HTML body 不许被说成"未在监听"', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: kernelspecsBoom(500), ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toBe('Jupyter 返回 500');
    expect(res.reason, '把 HTTP 状态说成"未在监听" ⇒ 让人去查一个正在答话的服务').not.toMatch(/未在监听|Unexpected|SyntaxError/);
    expect(res.kernels).toEqual([]);

    const ks403 = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: kernelspecsBoom(403), ...TOK });
    const st403 = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: statusDeny(403), ...TOK });
    expect(ks403.reason, '两个端点各写一份 403 的文案 ⇒ 将来只改一处，读者看到的两句话不一样').toBe(st403.reason);
  });

  /**
   * 评审 I-2 的另一半："`running:false` ⇒ `reason` 非空"是 `shared/src/notebook.ts` 里写死的契约，
   * 但每条用例只判自己那一句文案，谁都没判"有没有人 return 了一句空话"。
   * 这条是不变式：把所有失败形状过一遍，空/空白 reason 一律红。
   * 空 reason 的症状就是本项目反复付过代价的那类静默降级 —— 界面上只剩"不可用"三个字，没有为什么。
   */
  it('每一条 running:false 都带一句非空的 reason（不变式，逐条覆盖失败形状）', async () => {
    const probes: Array<[string, () => Promise<NotebookStatusResponse>]> = [
      ['没给 token', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK, tokenOverride: '' })],
      ['token 键存在但为空', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK, tokenOverride: '', ...tokenKeyShape(true) })],
      ['连不上（ECONNREFUSED）', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: refuses('connect ECONNREFUSED 127.0.0.1:8888'), ...TOK })],
      ['探活超时', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: refuses('The operation was aborted due to timeout'), ...TOK })],
      ['/api/status 403', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: statusDeny(403), ...TOK })],
      ['/api/status 500', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: statusDeny(500), ...TOK })],
      ['kernelspecs 500 + HTML body', () => notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: kernelspecsBoom(500), ...TOK })],
    ];
    const ran: Array<{ label: string; res: NotebookStatusResponse }> = [];
    for (const [label, probe] of probes) ran.push({ label, res: await probe() });
    const failed = ran.filter((x) => x.res.running === false);
    expect(failed.length, '一条失败形状都没跑出来 ⇒ 这条不变式在空转').toBeGreaterThanOrEqual(6);
    for (const { label, res } of failed) {
      expect(typeof res.reason, `${label}：running:false 却没有 reason 字段（契约写在 NotebookStatusResponse 上）`).toBe('string');
      expect((res.reason ?? '').trim(), `${label}：running:false 的 reason 是空的 ⇒ 前端只能显示"不可用"，没有为什么`).not.toBe('');
    }
  });

  /**
   * 评审 M5：`new URL(config.notebook.publicUrl + '/tree')` 原先在 try **外面**。
   * publicUrl 是 env 可覆盖的（ARENA_NOTEBOOK_PUBLIC_URL），一个坏值会让整个函数 reject，
   * 而 Task 8 把它挂在 GET 路由上 ⇒ 前端拿到 500，500 里没有 reason 可读，
   * 那句"kernel 就绪"整块消失 —— 症状与"Jupyter 真坏了"一模一样。
   * 这条判三点：不 reject、不把"在跑"改口成"没在跑"、链接缺失时点名坏掉的那一行 env。
   */
  it('publicUrl 是坏值时不许 reject：给不出链接，但要给得出原因', async () => {
    const saved = process.env.ARENA_NOTEBOOK_PUBLIC_URL;
    process.env.ARENA_NOTEBOOK_PUBLIC_URL = 'not a url';
    vi.resetModules();
    let res: NotebookStatusResponse;
    try {
      const mod = await import('../../src/notebooks/status.js');
      res = await mod.notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK });
    } finally {
      if (saved === undefined) delete process.env.ARENA_NOTEBOOK_PUBLIC_URL;
      else process.env.ARENA_NOTEBOOK_PUBLIC_URL = saved;
      vi.resetModules();
    }
    expect(res.running, '链接拼不出来 ≠ Jupyter 没在跑 ⇒ 这里必须仍是 true').toBe(true);
    // 长度从真回话派生（两条 spec），断的是"链接坏了不许把 kernel 表一起吞掉"，不是那个数字本身
    expect(res.kernels).toHaveLength(Object.keys(KERNELSPECS_BODY.kernelspecs).length);
    expect(res.url).toBeUndefined();
    expect(res.reason).toMatch(/ARENA_NOTEBOOK_PUBLIC_URL/);
  });

  it('token 不进日志（它出现在本机 URL 里是点开用的，进日志就留痕了）', async () => {
    const CANARY = 'canary-4f2e9b71';
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const collect = () =>
      [
        ...Object.values(logSpy).flatMap((fn) => fn.mock.calls.map(argsText)),
        ...consoleSpies.flatMap((s) => s.mock.calls.map((c) => argsText(c as unknown[]))),
      ].join('\n');
    try {
      // 三条分支各走一遍：成功（url 里就躺着 token）、非本机且非网关（url 给但不带 token）、失败（reason 可能拼进 url）
      await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), tokenOverride: CANARY, hostHeader: '127.0.0.1:7788' });
      await notebookStatus({ peerAddress: '192.168.1.20', fetchImpl: fake(), tokenOverride: CANARY, hostHeader: '127.0.0.1:7788' });
      await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: refuses('connect ECONNREFUSED'), tokenOverride: CANARY, hostHeader: '127.0.0.1:7788' });
      // C-1 的第四趟：本机对端 + 外来 Host（url 里躺着 token 的那一态被否掉的那一态）也要过一遍收集器
      await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), tokenOverride: CANARY, hostHeader: 'evil.example.com:7788' });
      const seen = collect();
      expect(seen, `有日志调用把 token 打印出来了 ⇒ 它会留在 data/logs 里，删不掉历史：\n${seen}`).not.toContain(CANARY);
      // 判据自己也要被判（否则"什么都没收集到"也看起来像成功）：
      // 故意泄漏一次，收集器必须当场看得见那个 canary。
      logSpy.logInfo('notebook', 'selfcheck', { url: `http://127.0.0.1:7789/tree?token=${CANARY}` });
      expect(collect(), '收集器看不见 logInfo 的字段 ⇒ 上面那条断言是在空转').toContain(CANARY);
    } finally {
      for (const s of consoleSpies) s.mockRestore();
      for (const fn of Object.values(logSpy)) fn.mockClear();
    }
  });

  /**
   * 上面第 5 条只管"要点名 ARENA_JUPYTER_TOKEN"，管不出**该不该去修**。
   * 评审在 Task 3+4 抓到的就是这一句双重误导：dev 里 entrypoint 说"缺 ARENA_JUPYTER_TOKEN"，
   * 可 token 其实就在 .env 里、用户也确实走了 ./start.sh —— 他照着提示修一遍，什么都没坏可修。
   * 所以"这个实例刻意不给"（compose 只给 arena/tools 透传）与"从没生成"必须是两条不同的话，
   * 且只有后者带修复指令。
   */
  it('token 缺席分两种成因：刻意不给（dev/e2e）不许读起来像故障，从没生成才给修复指令', async () => {
    const noKey = await notebookStatus({ ...TOK, tokenOverride: '', peerAddress: '127.0.0.1', fetchImpl: fake(), ...tokenKeyShape(false) });
    const emptyKey = await notebookStatus({ ...TOK, tokenOverride: '', peerAddress: '127.0.0.1', fetchImpl: fake(), ...tokenKeyShape(true) });
    expect(noKey.running).toBe(false);
    expect(emptyKey.running).toBe(false);
    expect(noKey.reason).not.toBe(emptyKey.reason);
    // 两条都得点名那个变量，否则读者不知道自己该看哪一行配置
    expect(noKey.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
    expect(emptyKey.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
    // 只有"从没生成"给修复指令
    expect(emptyKey.reason).toMatch(/start\.sh/);
    expect(emptyKey.reason).toMatch(/\.env/);
    // 承重的那条：刻意不给的那条**不许**出现修复指令（它出现了就等于让人去修没坏的东西）
    expect(noKey.reason, '刻意不给的那条给出了修复指令 ⇒ 它读起来就是故障，正是 T34 那句双重误导').not.toMatch(/start\.sh|\.env|生成/);
    // 且要正面说出"设计如此"，光靠"没有修复指令"推不出结论
    expect(noKey.reason).toMatch(/按设计|不是故障/);
  });

  /**
   * 上面那条走的是**注入点**，所以它判不出"生产路径读的是哪一份记录"。这一条不注入，
   * 期望值从 `config.notebook.tokenKeyPresent` 派生（评审 M9 的纪律：别写死只在一档成立的答案）——
   * 于是宿主（没这个键 ⇒ false）与容器交付档（compose 给了 ⇒ true）跑的是同一条断言、各判各的那一支。
   * 它判住的是：I-2 把键摘掉之后，`missingTokenReason()` 没有退化成"永远说按设计不给"。
   */
  it('不注入 tokenKeyPresent 时取的是 config 里记下的那一份（摘掉键之后文案不许一起漂掉）', async () => {
    const res = await notebookStatus({ ...TOK, tokenOverride: '', peerAddress: '127.0.0.1', fetchImpl: fake() });
    expect(res.running).toBe(false);
    if (config.notebook.tokenKeyPresent) {
      expect(res.reason, '这个进程的环境里有过那个键（compose 给了）⇒ 该说"从没生成"，说"按设计不给"就是让人不去修坏了的东西')
        .toMatch(/从没生成/);
    } else {
      expect(res.reason, '这个进程从没拿到那个键 ⇒ 该说"按设计不给"，喊"缺 ARENA_JUPYTER_TOKEN"就是 T34 那句双重误导')
        .toMatch(/按设计|不是故障/);
    }
  });

  /**
   * 第 4 条钉的是**文案分类**（拿到一个 abort 样的拒绝该怎么说），它钉不住"超时这件事真有人负责"：
   * 那个假 fetch 自己就把 abort 文案抛出来了，删掉实现里的 AbortSignal 它照样绿。
   * 这条把接线本身判上 —— 探活会被前端轮询（Task 9），没有 deadline 的请求遇到"在听但不答"的
   * jupyter 会永远挂着，而"永远挂着"在界面上长得跟"慢但迟早出结果"一模一样。
   * 后半段用真形状：AbortSignal.timeout 到点给的是 DOMException(TimeoutError)，undici 还会把它
   * 包一层 "fetch failed" ⇒ 分类必须顺着 cause 链看，不然真实的超时会被报成"没在监听"。
   */
  it('超时的来源是真接上的 AbortSignal，不是错误文案里恰好写了 abort', async () => {
    // ① 接线：递给 fetch 的 init.signal 必须存在，且到点会自己中止
    let handed: AbortSignal | null | undefined;
    const recorder =
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        handed = init?.signal;
        return { status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
    // 评审 M6：deadline 从 20ms 提到 200ms、停顿从 150ms 提到 500ms。
    // 20ms 在原机上靠的是"下一拍一定还没到点"这个概率 —— 宿主满载（判题/构建同时在跑）时
    // 那个"没中止"的断言会冤红，而冤红的门禁教人的是"重跑一次"，不是"这里真坏了"。
    // 500 > 200 留了两倍余量，仍然判得住"删掉 AbortSignal.timeout"那一次变异。
    await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: recorder, timeoutMs: 200, ...TOK });
    expect(handed, '没把 AbortSignal 交给 fetch ⇒ "在听但不答"的 Jupyter 会永远拖住这个探活请求（删掉 AbortSignal.timeout 本条就该红）').toBeTruthy();
    expect(handed!.aborted, 'timeoutMs 比这条 fake 的耗时还长，不该一出去就已中止').toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(handed!.aborted, '那个 signal 到点不会自己中止 ⇒ 递出去的不是超时用的 AbortSignal').toBe(true);

    // ② 真分类：服务器挂着不答，请求以"被自己的 deadline 中止"结束
    const hang = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const s = init?.signal;
      return await new Promise<Response>((_res, rej) => {
        // 兜底：实现若不接 deadline，这个请求就永远不会自己结束 —— 1.5s 后带一句指得准的话失败，
        // 别把整轮验证拖到 vitest 的 60s 超时。（这句话故意不含 timeout/abort，免得被误分类成超时。）
        const backstop = setTimeout(() => rej(new Error('探活的请求没有中止来源：它不会自己结束')), 1_500);
        if (s) s.addEventListener('abort', () => (clearTimeout(backstop), rej(s.reason)));
      });
    }) as unknown as typeof fetch;

    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: hang, timeoutMs: 30, ...TOK });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/超时/);
    expect(res.reason).not.toMatch(/ECONNREFUSED|未在监听|不会自己结束/);
  });

  /**
   * 真的 `fetch` 失败时顶层永远只是 `TypeError: fetch failed`，事实埋在 cause 里。
   * 上面第 2 条那个 `Error('ECONNREFUSED')` 钉不住这条 —— 它没有链。
   * 而"未在监听：fetch failed"是一句读者无法据此行动的话（沉默降级换了个说法而已），
   * 所以分类与文案都必须顺着 cause 链看；这条钉的就是容器里真拿到的那个形状（Task 10 会撞见）。
   */
  it('undici 的包装不许把事实吃掉：文案用 cause 里那句，分类也顺着链看', async () => {
    const wrapped = (cause: unknown) =>
      (vi.fn(async () => {
        throw new TypeError('fetch failed', { cause });
      }) as unknown) as typeof fetch;

    const refused = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: wrapped(new Error('connect ECONNREFUSED 127.0.0.1:8888')),
    });
    expect(refused.reason).toContain('connect ECONNREFUSED 127.0.0.1:8888');
    expect(refused.reason, '只剩顶层那句"fetch failed" ⇒ 三种故障读成同一条，没人能据此行动').not.toMatch(/fetch failed/);

    // 同一层包装、换掉 cause ⇒ 分类必须跟着换（这就是"顺着链看"与"只看顶层"的差别）。
    // cause 用真形状：AbortSignal.timeout 到点放进 signal.reason 的就是这个 DOMException。
    const timedOut = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: wrapped(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    });
    expect(timedOut.reason).toMatch(/超时/);
    expect(timedOut.reason).not.toContain('ECONNREFUSED');
  });
});

/**
 * `parseProcNetRoute` 是"容器里那个 token 到底给不给"的输入源，而 Docker 没起的这一档没法在真容器里
 * 跑它 —— 唯一能判住"这行解析对不对"的机会就是把**真实的表文本**喂给这个纯函数。
 * 列依次是 Iface / Destination / Gateway / Flags / Ref / Use / Metric / Priority / State / Mask，
 * 而网关是**小端十六进制**（`010012AC` = 172.18.0.1）。判四件事：
 * ① 默认路由那行的网关被正确解出来；② 非默认路由（子网那一行）不许混进来；
 * ③ 多张路由表 / 两张网卡时逐条收齐且去重；④"这一行根本没有网关"（Gateway=00000000）与坏值都不算网关。
 * 第 ④ 条是 fail-closed：把 `0.0.0.0` 收进表里，等于给一个不存在的地址发"本机"资格。
 */
describe('parseProcNetRoute（容器里"本机"的判据来源）', () => {
  const HEADER = 'Iface\tDestination\tGateway\tFlags\tRef\tUse\tMetric\tPriority\tState\tMask';
  /** 按内核的列顺序拼一行；解析只看 Destination 与 Gateway 那两列，但形状要像真的表（列序错了这条就跟着红）。 */
  const row = (iface: string, destination: string, gateway: string, flags = '0003'): string =>
    [iface, destination, gateway, flags, '0', '0', '100', '0', iface].join('\t');
  const table = (...rows: string[]): string => [HEADER, ...rows].join('\n');

  it('docker 网桥那张表：默认路由的网关解成 172.18.0.1，子网那一行不进来', () => {
    const text = table(row('eth0', '00000000', '010012AC'), row('eth0', '000012AC', '00000000', '0001'));
    expect(parseProcNetRoute(text)).toEqual(['172.18.0.1']);
  });

  it('多个默认路由（多张路由表 / 两张网卡）逐条收齐，重复的那条不算两遍', () => {
    const text = table(
      row('eth0', '00000000', '010012AC'),
      row('eth1', '00000000', '020012AC'),
      row('eth0', '00000000', '010012AC'),
    );
    expect(parseProcNetRoute(text)).toEqual(['172.18.0.1', '172.18.0.2']);
  });

  it('Gateway=00000000 的默认路由（链路内直连，没有网关）不许把 0.0.0.0 当成网关', () => {
    expect(parseProcNetRoute(table(row('eth0', '00000000', '00000000', '0001')))).toEqual([]);
  });

  it('只有表头 / 空文本 / 坏掉的十六进制 ⇒ 空表（读不出来就是"只认回环"，不是故障）', () => {
    expect(parseProcNetRoute(HEADER)).toEqual([]);
    expect(parseProcNetRoute('')).toEqual([]);
    // 短一截、非 hex、整列缺失这三种坏行都不许造出一个地址
    const junk = table(
      row('eth0', '00000000', '010012A'),
      row('eth0', '00000000', 'ZZZZZZZZ'),
      ['eth0', '00000000', '0003'].join('\t'),
    );
    expect(parseProcNetRoute(junk)).toEqual([]);
  });
});
