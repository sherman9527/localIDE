import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { missingTokenReason } from '../../src/notebooks/status.js';
import { guardNotebookProxy, type ProxyVerdict } from '../../src/notebooks/proxyGuard.js';

/**
 * WI-94 Task 2：反代的放行判据 = **对端本机 ∧ Host 是本机字面量 ∧ Sec-Fetch-Site 不是别人家的页面**，
 * 三者的合取住在一个纯函数里，这张表逐组合判它。
 *
 * ## 为什么要在**函数层面**判，而不是"在 HTTP 上测一遍就够了"
 *
 * A1 那一轮学到的教训是「**走 HTTP 的判据会被外层遮住**」：`server/src/api/app.ts` 的**第一个**
 * onRequest 钩子已经把"Host 不是本机字面量"的**整个 origin** 判 403，于是「对端本机 + Host 外来」
 * 这一态在真实 HTTP 路径上**根本造不出来** —— 请求走不到反代那一层（`app.ts` 那里把这句记成
 * "那不是漏接线，是这一层的效果"，`server/test/api/notebook-api.test.ts` 的四条判的就是外层）。
 * 合取的三个输入只有在这里才能被逐个隔离：每一行只坏一件事，坏的那一件必须自己红。
 * HTTP 与 websocket 两层（Task 3 / Task 4）**只调这个函数、不再判任何一条**，所以这张表就是判据本体。
 *
 * ## 认领与档位
 *
 * `scripts/verify.sh` 里「单元测试（shared + exec + regression + notebooks + server 根级）」那条阶段
 * 扫 `server/test/notebooks/` ⇒ 这一档在**宿主档每天在跑**，没有 env 门控（认领判据：
 * `server/test/regression/verify-coverage.test.ts`）。本文件不需要 Jupyter、不需要 Docker。
 *
 * ## 凭据纪律
 *
 * 全程用一个 canary 当 token / 当头值：任何一条否决的 message 里都不许出现它 ——
 * 外部输入会进日志，而这一层读到的每一个字段都是客户端给的（`api/app.ts` 那条 origin 钩子立了
 * 同一个先例："收到的那个值不打印在这里"）。
 *
 * ## 破坏性验证（2026-10-09 实测，brief 那四次 + 本档补的 ⑤，五次都跑了；
 * ## 命令 `npx vitest run server/test/notebooks/proxyGuard.test.ts`）
 *
 * 基准：`23 passed`、exit 0。每次变异后立刻还原，`git status` 与 `git diff` 已核
 * （①–④ 在那一笔提交 `c38a1c7` 之前跑；⑤ 是提交后补的，还原判据换成"`git diff` 空 = 与提交逐字节一致"）。
 * 表里是 **brief 预测 vs 实测** —— 四处预测与实际不同（①②③⑤），都记在这儿，
 * 因为下一档会照这些句子决定判据放哪：
 *
 * | 变异 | brief 预测 | 实测 |
 * | --- | --- | --- |
 * | ① `!localPeer \|\| !localHost` → `!localPeer` | 4 行 Host 相关红 | **5 failed \|\| 18 passed，exit 1** —— 表里第 7 行（网关对端 + 外来 Host）也是 Host 那一半判的，brief 数漏了一行。报的都是 `{"ok":true}: expected true to be false` |
 * | ② 集合加 `'cross-site'` | cross-site 与 same-site 两行红 | **2 failed \|\| 21 passed，exit 1** —— 只有 cross-site 那行红；`same-site` 那行**没红**（往集合里加的是 `cross-site`，`same-site` 本来就不在集合里，照旧被拒 ⇒ 这一行判不住这个变异，它判的是另一件事）。第二条红的是「多值那条…顺序是判据」（它下半句用 `cross-site` 取反消息身份） |
 * | ③ 删掉"先判多值"那两行 | 多值那行必须红 | **1 failed \|\| 22 passed，exit 1** —— 红的是**消息身份那一条**，`'Sec-Fetch-Site 有两个值'` 那行**没红**：整串 `'same-origin, cross-site'` 落在集合分支上，error 与 status 与预检分支**逐字节相同**，光看那两个字段这条顺序是不可测的。⇒ 这一档补了 `toContain('不止一个值')` 那条，顺序才有了可见证据 |
 * | ③b 顺手写成 `site.split(',')[0]`（brief 点名最危险的那种"更宽容"） | —— | **3 failed \|\| 20 passed，exit 1** —— 多值那行 + 消息身份那一条 + "不回显 Sec-Fetch-Site 值"那一条一起红（三条都拿到 `{"ok":true}`）。这是四次里红得最多的一次：那个写法确实把守卫关掉了一半，而且关得掉在三层判据上 |
 * | ⑤（额外一次，判 brief 那个回显缺陷）把消息换回 brief 那版 `（${site}）` | brief 没提 | **1 failed \|\| 22 passed，exit 1** —— 红的**只有**"不回显读到的值"这一条，而且它的失败消息里就把 canary 印了出来（`说这个请求不是从本页面发起的（canary-header-value-not-printed-7c3d）`）。⇒ 这句是实测不是推测：**brief 给的那 11 行加它自己的"三种否决都不回显"那条判不住这个回显**（那三条 patch 走的是 host / peer / token 分支，回显住在第四支），照原样落地就是全绿带着一处泄漏 |
 *
 * ④ 就是"还原并确认全绿"：`23 passed`、exit 0，`git diff` 空（工作树与那一笔提交逐字节一致）。
 *
 * ③ 那一条是本文件与 brief 的**实质分歧**：brief 说"删掉预检 ⇒ 那一行必须红"，实测不红。
 * 所以这张表对"顺序"的判据住在消息里，不在 error/status 里 —— 读代码的人若把消息当成可有可无的文案，
 * 顺序就失去唯一可见的证据（那也正是 ③b 那种写法能活过 review 的原因）。
 */

const TOK = 'canary-token-not-printed-4a1b';
/** 三条输入都点头的基准（宿主直跑那条路）。表里每一行都在它之上只坏一件事。 */
const LOCAL = { peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', secFetchSite: 'same-origin' };
/** 只用在"消息不许回显"那一条：它冒充一个客户端自报的 Sec-Fetch-Site 值。 */
const HEADER_CANARY = 'canary-header-value-not-printed-7c3d';

/** 取否决那条的字段（表里已经判过 ok:false，这里只是让 TS 知道形状，顺带把重复的取反断言收一处）。 */
function refused(v: ProxyVerdict): Extract<ProxyVerdict, { ok: false }> {
  expect(v.ok, JSON.stringify(v)).toBe(false);
  return v as Extract<ProxyVerdict, { ok: false }>;
}

describe('反代守卫：三个输入的合取', () => {
  it('三条都点头 ⇒ 放行', () => {
    expect(guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  /**
   * 表里每一行只坏一件事。每行都给出**该红的那个 error 码**，因为"红了"不够 ——
   * 三态共一句话的写法会把"这台机器上没有 Jupyter"说成"你不许用"（评审 T34 那句双重误导的同形）。
   *
   * ⚠ 网关那一行（`172.18.0.1`）**不是**"红的一行"：网桥网关在容器部署里就是"本机"
   * （compose 把宿主浏览器经 NAT 打进来时，容器里看到的对端是网关而不是回环），所以它单独是**放行**的。
   * 表里把它和坏 Host 放在一起，判的是"放行不等于免检"——对端这一半点头时，Host 那一半还得点头。
   */
  const TABLE: Array<[string, Partial<Parameters<typeof guardNotebookProxy>[0]>, string, number]> = [
    ['Host 是外来域名（rebinding 那一半）', { hostHeader: 'evil.example:7788' }, 'notebook_proxy_refused', 403],
    ['Host 是 127.0.0.1.evil.example（以本机字面量开头的域名）', { hostHeader: '127.0.0.1.evil.example' }, 'notebook_proxy_refused', 403],
    ['Host 缺席（HTTP/1.0 或被摘掉）', { hostHeader: undefined }, 'notebook_proxy_refused', 403],
    ['Host 是裸 IPv6 的歧义写法 ::1:7788', { hostHeader: '::1:7788' }, 'notebook_proxy_refused', 403],
    ['对端是局域网地址（伪造 Host 也没用）', { peerAddress: '192.168.1.20' }, 'notebook_proxy_refused', 403],
    ['对端是 TEST-NET（永不可能是任何机器的网关）', { peerAddress: '203.0.113.9' }, 'notebook_proxy_refused', 403],
    ['对端是网桥网关（compose 里宿主浏览器那一支）⇒ 放行，所以这里反过来测它被摘掉 Host 时仍红', { peerAddress: '172.18.0.1', hostHeader: 'evil.example' }, 'notebook_proxy_refused', 403],
    ['Sec-Fetch-Site: cross-site（别人的页面里嵌我们）', { secFetchSite: 'cross-site' }, 'notebook_cross_site', 403],
    ['Sec-Fetch-Site: same-site（同站不同源，localhost 与 127.0.0.1 之间）', { secFetchSite: 'same-site' }, 'notebook_cross_site', 403],
    ['Sec-Fetch-Site 有两个值（浏览器不会这么发 ⇒ 不可信）', { secFetchSite: 'same-origin, cross-site' }, 'notebook_cross_site', 403],
    ['这个实例没有 token ⇒ 503，且**不是** 403', { token: '' }, 'notebook_not_configured', 503],
  ];
  for (const [name, patch, wantError, wantStatus] of TABLE) {
    it(name, () => {
      const v = guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: ['172.18.0.1'], ...patch });
      expect(v.ok, JSON.stringify(v)).toBe(false);
      const bad = v as Extract<ProxyVerdict, { ok: false }>;
      expect(bad.error).toBe(wantError);
      expect(bad.status).toBe(wantStatus);
    });
  }

  /**
   * brief 那 11 行之外补的两条，各钉一个"调用方会踩的形状"：
   * ① 对端地址缺席 —— `@types/node/net.d.ts:330` 把 socket 那一侧定成
   *   `readonly remoteAddress: string | undefined`，而守卫的入参是 `string`（brief 定的签名，本档没改），
   *   所以 Task 4 的调用点**必然**要把 undefined 映射成什么；这一条钉的就是"映射成 `''` 走 fail-closed"，
   *   否则那个映射是个洞 —— 而表里那 11 行一行都不会红（它们拿的都是能解析的地址）。
   */
  it('对端地址缺席（ws upgrade 拿不到 remoteAddress 时映射成的空串）⇒ 否决', () => {
    const v = refused(guardNotebookProxy({ ...LOCAL, peerAddress: '', token: TOK, gatewayAddresses: [] }));
    expect(v.error).toBe('notebook_proxy_refused');
    expect(v.status).toBe(403);
  });

  /**
   * ② `Sec-Fetch-Site: none` 是**允许值**（地址栏直接输入的导航、无来源），它住在集合里。
   * 没有这一条，"有人把 none 从集合里删掉"不会让任何断言红 —— 而那一删的代价是浏览器手敲地址
   * 也打不开这一页（又一种静默降级）。
   */
  it('Sec-Fetch-Site: none 放行（地址栏直接敲的导航不是别人家的页面）', () => {
    expect(guardNotebookProxy({ ...LOCAL, secFetchSite: 'none', token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  it('Sec-Fetch-Site 缺席 = 不是浏览器发的 ⇒ 放行（本机 curl 与测试探针还要活着）', () => {
    expect(guardNotebookProxy({ ...LOCAL, secFetchSite: undefined, token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  it('Host 是 localhost 这个名字也放行（判据与 token 那一半同源，不许在这里另写一套）', () => {
    expect(guardNotebookProxy({ ...LOCAL, hostHeader: 'localhost:7788', token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  /** 网关那一半单独成立时是**放行**（否则功能在唯一启用它的部署里恒关），表里那行只判了"它 + 坏 Host"。 */
  it('对端是网桥网关 + 本机 Host ⇒ 放行（compose 里宿主浏览器真实走的那条路）', () => {
    expect(guardNotebookProxy({ ...LOCAL, peerAddress: '172.18.0.1', token: TOK, gatewayAddresses: ['172.18.0.1'] })).toEqual({ ok: true });
  });

  /**
   * ⚠ 这一条判的是**分支顺序**，而顺序是判据的一部分：`'same-origin, cross-site'` 既含允许值又含禁止值，
   * 先按集合判会把它放行；反过来"先判多值"若被删掉，它会掉进下面那个集合分支 —— **error 码与状态码
   * 都一模一样**，所以光看那两个字段这条顺序是不可测的（brief 说删掉预检会让这一行红，实测不红，
   * 见文件顶部那段破坏性验证记录）。能把它俩分开的只有消息说的是哪一句，于是这里钉消息。
   */
  it('多值那条说的是"不止一个值"，不是"不是从本页面发起的"（先判多值再判集合，顺序是判据）', () => {
    const multi = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: 'same-origin, cross-site', gatewayAddresses: [] }));
    expect(multi.message).toContain('不止一个值');
    const single = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: 'cross-site', gatewayAddresses: [] }));
    expect(single.message).not.toContain('不止一个值');
  });

  /**
   * 凭据纪律：否决消息里不许出现它读到的任何外部输入值，也不许出现 token。
   * `HEADER_CANARY` 那一支钉的是 Sec-Fetch-Site 那一半 —— 浏览器只发那几个枚举，但 curl 能发任意串，
   * 而这句话是要回给发起方的响应体（拒绝访问按本仓库的写法还会被记日志）。brief 给的实现把值拼进了
   * 消息，与它自己顶上那段"绝不回显"矛盾，这里按纪律改成不打印。
   * ⚠ "会进日志"这半步是**设计上的推论**（Task 3 的日志接线还不存在）；实测的部分是 ⑤ 那一行：
   * 把消息换回 brief 那版，本文件只有这一条红（22 条照绿），canary 还被印在失败消息里。
   */
  it('三种否决的 message 里都没有 token，也没有客户端自报的头/地址', () => {
    for (const patch of [{ hostHeader: `evil.example` }, { peerAddress: '192.168.9.9' }, { token: '' }] as const) {
      const v = guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: [], ...patch });
      const message = (v as Extract<ProxyVerdict, { ok: false }>).message ?? '';
      expect(message.includes(TOK), message).toBe(false);
      expect(message.includes('192.168.9.9'), message).toBe(false);
      expect(message.includes('evil.example'), message).toBe(false);
    }
  });

  it('Sec-Fetch-Site 那一支的消息不回显读到的值（它是外部输入，会进日志）', () => {
    for (const site of [HEADER_CANARY, `same-origin, ${HEADER_CANARY}`]) {
      const v = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: site, gatewayAddresses: [] }));
      expect(v.error).toBe('notebook_cross_site');
      expect(v.status).toBe(403);
      expect(v.message.includes(HEADER_CANARY), v.message).toBe(false);
    }
  });

  it('没 token 那句话区分"从没生成"与"按设计不给"（复用 status.ts 那份，不再写第二份）', () => {
    const never = guardNotebookProxy({ ...LOCAL, token: '', tokenKeyPresent: true, gatewayAddresses: [] });
    const byDesign = guardNotebookProxy({ ...LOCAL, token: '', tokenKeyPresent: false, gatewayAddresses: [] });
    expect((never as { message: string }).message).toContain('从没生成');
    expect((byDesign as { message: string }).message).toContain('按设计');
    expect((byDesign as { message: string }).message).not.toContain('从没生成');
  });

  /**
   * "复用同一段话"不能只在注释里声称 —— 上一轮就是靠注释把"两处各写一遍"留到了下一次漂移。
   * 这三句判的是**同一份文本**：消息里必须含 `status.ts` 那份 `missingTokenReason()` 的原话，
   * 所以守卫里再抄一份迟早会有一遍不更新（两半各改一次时这里红，不靠人记得）。
   * 最后一钉的是"不注入 `tokenKeyPresent` 时取的是 config 里**读的那一刻记下的**那一份"（终审 I-2：
   * 那个键在 config 加载时就从 process.env 摘掉了，现场再问 `in process.env` 永远得到 false）——
   * 期望值由**同一个 config 对象**派生，所以这一句在有无 `ARENA_JUPYTER_TOKEN` 的机器上都成立。
   */
  it('503 那句话用的就是 status.ts 那一份，不是这里另写的', () => {
    for (const present of [true, false]) {
      const v = refused(guardNotebookProxy({ ...LOCAL, token: '', tokenKeyPresent: present, gatewayAddresses: [] }));
      expect(v.message).toContain(missingTokenReason(present));
    }
    const defaulted = refused(guardNotebookProxy({ ...LOCAL, token: '', gatewayAddresses: [] }));
    expect(defaulted.message).toContain(missingTokenReason(config.notebook.tokenKeyPresent));
  });

  /**
   * precedence 钉在这里，是因为 Task 3/4 只调一次这个函数、看不到内部的顺序：
   * 没有 token 时**先**说"这台机器上没有 notebook 服务"（503），而不是"你不许用"（403）——
   * 那种实例里根本没有凭据可发，泄漏不了任何东西，而读者能照那句去做（启动它）。
   * 反过来的话，本机用户会在没配 Jupyter 时收到一句指责他来源不正的话（三种修法被说成一件）。
   */
  it('没 token 且 Host 外来 ⇒ 仍是 503 那一句（没凭据可漏，而那句才是可行动的）', () => {
    const v = refused(guardNotebookProxy({ ...LOCAL, hostHeader: 'evil.example:7788', token: '', gatewayAddresses: [] }));
    expect(v.status).toBe(503);
    expect(v.error).toBe('notebook_not_configured');
  });
});
