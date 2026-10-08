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
 * 全程用 canary 当 token / 当头值 / 当地址：**每一个**否决分支的 message 里都不许出现它们 ——
 * 外部输入会进日志，而这一层读到的每一个字段都是客户端给的（`api/app.ts` 那条 origin 钩子立了
 * 同一个先例："收到的那个值不打印在这里"）。覆盖面住在 `REFUSAL_SHAPES` 那份形状清单里，
 * 而"清单没漏支"本身也有一条判据（见下面「否决形状清单 = …」那一条与补牙轮那张表里的 `SELF` 行）。
 *
 * ## 破坏性验证（2026-10-09 实测，brief 那四次 + 本档补的 ⑤⑥，六次都跑了；
 * ## 命令 `npx vitest run server/test/notebooks/proxyGuard.test.ts`）
 *
 * 基准：`23 passed`、exit 0。每次变异后立刻还原，`git status` 与 `git diff` 已核
 * （①–④ 在提交 `c38a1c7` 之前跑；⑤⑥ 是提交后补的，还原判据换成"`git diff HEAD` 空 = 与提交逐字节一致"，
 * ⑥ 另加一条"那行代码原样在位"的 grep 复核）。
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
 * | ⑥（额外一次，判本档补的"网关单独放行"那条）把 `gateways` 改成 `[]`（= "收紧成只认回环"） | brief 没提 | **1 failed \|\| 22 passed，exit 1** —— 红的**只有**「对端是网桥网关 + 本机 Host ⇒ 放行」那一条（`expected { ok: false, status: 403, … } to deeply equal { ok: true }`）。⇒ 这把"表里 11 行判不住这种收紧"从推理变成实测：brief 那 16 条在"功能在唯一启用它的部署里恒关"这一态上**照绿** |
 *
 * ④ 就是"还原并确认全绿"：`23 passed`、exit 0，`git diff` 空（工作树与那一笔提交逐字节一致）。
 *
 * ③ 那一条是本文件与 brief 的**实质分歧**：brief 说"删掉预检 ⇒ 那一行必须红"，实测不红。
 * 所以这张表对"顺序"的判据住在消息里，不在 error/status 里 —— 读代码的人若把消息当成可有可无的文案，
 * 顺序就失去唯一可见的证据（那也正是 ③b 那种写法能活过 review 的原因）。
 *
 * ## 补牙轮（同日，评审 I-1 / I-2 / I-4；**只动本测试文件，实现一行没改**）
 *
 * 评审那 18 次变异里有三次是 **23 passed / exit 0**（M9「把 `${token}` 拼进 Sec-Fetch 两支消息」、
 * M18「对端那一半就地重写成朴素等值表」、M14「空串不再按缺席处理」）⇒ 三条"闸门判不住"的形状。
 * 本档补的判据（见下面三段带 `I-1` / `I-2` 标题的注释）与**逐条复现**的结果，命令同样是
 * `npx vitest run server/test/notebooks/proxyGuard.test.ts`；基准换成补完后的 **`32 passed`、exit 0**。
 * 变异跑在 `server/src/notebooks/proxyGuard.ts` 上（临时脚本 + `/tmp` 里的原件备份，跑完立即还原，
 * `git status` 每次复核 ⇒ 收尾只有本测试文件有改动），没有一条靠 Edit 留在实现里：
 *
 * | 变异 | 补牙前（评审实测） | 补牙后（本档实测） |
 * | --- | --- | --- |
 * | `M9` 两支 Sec-Fetch 消息各拼上 `（凭据 ${token}）` | **23 passed / exit 0** | **3 failed \|\| 29 passed，exit 1** —— 红的是「否决消息不回显（403 Sec-Fetch 非法值）」、「…（403 Sec-Fetch 多值）」两支各一条 + "Sec-Fetch-Site 那两支…也不出现 token"那一条 |
 * | `M18` 对端那一半换成朴素等值表（`'127.0.0.1'` / `'172.18.0.1'` / `gateways.some`） | **23 passed / exit 0** | **2 failed \|\| 30 passed，exit 1** —— 红的是 `::1` 与 `::ffff:127.0.0.1` 那两条（朴素表把本机判成外来） |
 * | `M19`（本档另造，隔离 ③）在共享谓词之上再放宽 `peer.startsWith('172.18.')` | —— | **1 failed \|\| 31 passed，exit 1** —— 红的**只有**「邻居容器 `172.18.0.7` ⇒ 否决」那一条。⇒ 诚实的边界：③ 对 `M18` **不红**（朴素等值表也否决它），它判的是"整段都算本机"这一族 |
 * | `M14` 空串不再按"缺席"处理（删掉 `site !== ''`） | **23 passed / exit 0** | **1 failed \|\| 31 passed，exit 1** —— 红的是补了三形的"Sec-Fetch-Site 缺席的三种写法…放行"（评审 N-1 那个决定从此有判据） |
 * | `SELF`（对**本档自己**做破坏性验证）从 `REFUSAL_SHAPES` 删掉一形 | —— | **1 failed \|\| 30 passed，exit 1** —— 红的正是「否决形状清单 = 实现里那 5 个否决分支逐个列全」那一条 ⇒ "列全"这件事判得住，不是注释（`dev_verify_workflow.md` 第三条：门禁自己也要被门禁） |
 *
 * I-4（名字承诺 > 判据）这一遍审出的四处，**都当场处理了**，没留"以后再改"：
 * ① 「三种否决的 message 里都没有 token」→ 实际只覆盖 5 支里的 3 支 ⇒ 改成按分支逐个列全 + 每形一条独立用例；
 * ② 「Sec-Fetch-Site 缺席…放行」→ 只判 `undefined` 一形 ⇒ 名字与断言一起补成三形；
 * ③ 「多值那条说的是"不止一个值"，**不是**"不是从本页面发起的"」→ 只断了单向 ⇒ 补成双向（评审 N-3 提的那个"互不含对方关键词"）；
 * ④ 「Host 是 localhost …（判据与 token 那一半同源，不许在这里另写一套）」→ 本条只判"放行"，"不许另写一套"住在表里第 2 行
 *    （评审 M16 实测：改写的只有那一行红）⇒ 把名字里那句承诺摘掉，改成指向 M16 的注释。
 */

const TOK = 'canary-token-not-printed-4a1b';
/** 三条输入都点头的基准（宿主直跑那条路）。表里每一行都在它之上只坏一件事。 */
const LOCAL = { peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', secFetchSite: 'same-origin' };
/** 冒充一个客户端自报的 Sec-Fetch-Site 值，只用在"消息不许回显"那一族（形状清单的两形 + 那一条独立用例）。 */
const HEADER_CANARY = 'canary-header-value-not-printed-7c3d';
/** 以下三个也是 canary：喂给哪一半，那一半就是客户端给的（Host / 对端 / 注入的网关表）。 */
const HOST_CANARY = 'canary-host.example:7788';
const PEER_CANARY = '192.168.9.9';
/** 注入的网关表只给这一条 ⇒ "对端那一支不许把网关地址抄进消息"也顺带有了判据。 */
const GW_CANARY = '172.18.0.1';

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

  /**
   * I-4 审出来的第二条"名字 > 判据"：原名只写"缺席"，而实现里"缺席"是**三种写法**
   * （`secFetchSite?.trim().toLowerCase()` 后 `undefined` / `''` / 纯空白都算没给 —— 中间件把值擦成
   * 空串、curl `-H 'Sec-Fetch-Site;'` 都会给后两种），断言却只判 `undefined` 那一形。
   * 于是"空串/纯空白按缺席处理"这个**决定**零判据（评审 M14 实测 0 红）。这里把三形都喂进去，
   * 名字与判据就相等了；方向也要读对：这一条红的是"有人把空值当成禁止值"⇒ 本机 curl / 探针被 403。
   */
  it('Sec-Fetch-Site 缺席的三种写法（不给这个头 / 空串 / 纯空白）都算"不是浏览器发的"⇒ 放行（本机 curl 与测试探针还要活着）', () => {
    for (const site of [undefined, '', '   '] as const) {
      expect(
        guardNotebookProxy({ ...LOCAL, secFetchSite: site, token: TOK, gatewayAddresses: [] }),
        `secFetchSite=${JSON.stringify(site)}`,
      ).toEqual({ ok: true });
    }
  });

  /**
   * I-4 审出来的第三条（改名字，不改判据）：原来括号里写"判据与 token 那一半同源，不许在这里另写一套"，
   * 而这一条只断"localhost 放行" —— **"不许另写一套"这件事不住在这里**，它由表里第 2 行
   * （`127.0.0.1.evil.example`）判：评审 M16 实测把 Host 那一半就地重写成
   * `includes('127.0.0.1') || startsWith('localhost')` 时**只有那一行红**。名字里不再承诺本条判不到的东西。
   */
  it('Host 是 localhost 这个名字也放行（本机字面量的第二种写法：start.ps1 的健康检查就用它）', () => {
    expect(guardNotebookProxy({ ...LOCAL, hostHeader: 'localhost:7788', token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  /**
   * 网关那一半单独成立时是**放行**（否则功能在唯一启用它的部署里恒关），表里那行只判了"它 + 坏 Host"。
   * ⚠ I-4 审出来的一处"名字 > 判据"，处理方式是**说明而非改判据**：括号里"compose 里宿主浏览器真实走的
   * 那条路"是部署事实，本档判不住（这一条形对 `gatewayAddresses` 用的是**注入点**；生产缺省那一支
   * `?? localGatewayAddresses()` 零判据 = 评审 I-3/M11，归 Task 3 的容器档，宿主档没有 `/proc`）。
   * 这一条今天判的是"注入的网关表里那一条 ⇒ 放行"，名字里的部署话是给下一档的指向标，不是本条的功劳。
   */
  it('对端是网桥网关 + 本机 Host ⇒ 放行（compose 里宿主浏览器真实走的那条路）', () => {
    expect(guardNotebookProxy({ ...LOCAL, peerAddress: '172.18.0.1', token: TOK, gatewayAddresses: ['172.18.0.1'] })).toEqual({ ok: true });
  });

  /**
   * ### I-2 的补牙（评审 M18）：对端这一半"必须是 `isLocalPeer` 那一份"原来零判据
   *
   * 评审实测：把那一半就地重写成朴素等值表（`peer === '127.0.0.1' || peer === '172.18.0.1' ||
   * gateways.some(...)`，即 M18）⇒ **23 passed / exit 0**，一条都不红。根因很机械：表里那些对端形状
   * （`127.0.0.1` / `192.168.1.20` / `203.0.113.9` / `172.18.0.1` / `''`）**朴素写法也能给出同样的答案**，
   * 于是"复用共享谓词"这件事只剩注释在担保。下面三条挑的就是"朴素写法会判错、共享谓词判对（或反之）"的形状，
   * 且期望值是**硬编码字面量**，没有一条从 `isLocalPeer` 算出来 —— 本仓库在 `kernelspecs` 键名上付过
   * "mock 与 bug 同源 ⇒ 单测全绿"的学费，这一族判据的价值全在"它们与朴素写法不一样"上：
   * ① `::1` —— 朴素等值表把本机判成外来（IPv6 回环不是那两个字符串），共享谓词按地址族认 ⇒ 放行；
   * ② `::ffff:127.0.0.1` —— 同理，`::ffff:` 那一截只有 `isLoopbackAddressLiteral` 会摘；
   * ③ `172.18.0.7`（注入的网关只有 `172.18.0.1`）—— **反方向**：它对 M18 不红（朴素等值表也否决它，
   *    这句是实测不是推测），它拦的是第三种将来会写出来的"整段都算本机"（`startsWith('172.18.')`，
   *    本档实测为 M19 ⇒ 只有这一条红）。
   *
   * 形状不是假想的：2026-10-09 在宿主用真 socket 探过（临时脚本，仓库里没留文件）—— 监听 `::` 的**双栈**
   * server 收到来自 `127.0.0.1` 的连接时 `socket.remoteAddress` = `"::ffff:127.0.0.1"`；客户端拨 `::1`
   * 时 = `"::1"`；监听 `127.0.0.1` 时 = `"127.0.0.1"`。同一族形状在
   * `server/test/notebooks/status.test.ts`（谓词层）已经钉过，这三条钉的是**守卫把这半接进了合取**，
   * 不是把那段断言抄一遍。
   */
  it('对端是 IPv6 回环 ::1 ⇒ 放行（朴素等值表会把本机判成外来 = 功能在 IPv6 上静默关）', () => {
    expect(guardNotebookProxy({ ...LOCAL, peerAddress: '::1', token: TOK, gatewayAddresses: ['172.18.0.1'] })).toEqual({ ok: true });
  });

  it('对端是双栈监听写出的 IPv4-mapped 形状 ::ffff:127.0.0.1 ⇒ 放行（那一截只有共享谓词会摘）', () => {
    expect(guardNotebookProxy({ ...LOCAL, peerAddress: '::ffff:127.0.0.1', token: TOK, gatewayAddresses: ['172.18.0.1'] })).toEqual({ ok: true });
  });

  it('对端是同一张网桥上的邻居容器 172.18.0.7 ⇒ 否决（"整段 172.18 都算本机"不是判据）', () => {
    const v = refused(guardNotebookProxy({ ...LOCAL, peerAddress: '172.18.0.7', token: TOK, gatewayAddresses: ['172.18.0.1'] }));
    expect(v.error).toBe('notebook_proxy_refused');
    expect(v.status).toBe(403);
    expect(v.message.includes('172.18.0.7'), v.message).toBe(false);
  });

  /**
   * ⚠ 这一条判的是**分支顺序**，而顺序是判据的一部分：`'same-origin, cross-site'` 既含允许值又含禁止值，
   * 先按集合判会把它放行；反过来"先判多值"若被删掉，它会掉进下面那个集合分支 —— **error 码与状态码
   * 都一模一样**，所以光看那两个字段这条顺序是不可测的（brief 说删掉预检会让这一行红，实测不红，
   * 见文件顶部那段破坏性验证记录）。能把它俩分开的只有消息说的是哪一句，于是这里钉消息。
   */
  it('多值那条说的是"不止一个值"，不是"不是从本页面发起的"（先判多值再判集合，顺序是判据）', () => {
    const multi = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: 'same-origin, cross-site', gatewayAddresses: [] }));
    const single = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: 'cross-site', gatewayAddresses: [] }));
    expect(multi.message).toContain('不止一个值');
    expect(single.message).not.toContain('不止一个值');
    // I-4 审出来的"名字 > 判据"：名字明写"不**是**'不是从本页面发起的'"，而原来只断了单向
    // （`single` 不含"不止一个值"），`multi` 那句反向承诺没人判。补成双向，名字才等于判据。
    expect(multi.message).not.toContain('不是从本页面发起的');
    expect(single.message).toContain('不是从本页面发起的');
  });

  /**
   * 凭据纪律：**每一个**否决分支的 message 里都不许出现 token，也不许出现喂进去的客户端自报值。
   *
   * ⚠ I-1 的补牙（评审 M9 实测）：这一条原来只喂 `{hostHeader:'evil.example'} / {peerAddress:'192.168.9.9'} /
   * `{token:''}` 三个 patch ⇒ 走的是 host / peer / 503 三支，把 `（凭据 ${token}）` 拼进 Sec-Fetch 那两支的
   * 消息里（M9）时**23 passed / exit 0**，全绿带着一处泄漏。现在按 `proxyGuard.ts` 里实际存在的
   * `return { ok: false }` **逐个列全**（五个分支，六种输入形状 —— Host 那一支给外来与缺席两形）：
   * ① 无 token（503）② 对端不是本机 ③ Host 不是本机字面量（与②同一个 error/status，只有消息分得开）
   * ④ Sec-Fetch-Site 多值 ⑤ Sec-Fetch-Site 非法值（与④同一个 error/status，也只有消息分得开）。
   * 形状清单本身也有判据（下一条），不然"逐个列全"这句又只是注释。
   *
   * 两个设计点：
   * 1. 每一形只坏**它那一半**（其余两半照旧点头），否则回显会由别的支背走、红的位置对不上；
   * 2. 循环体先 `refused()`（断"确实否决了"）再断 `toContain(这一支自己的那句话)` —— 这两步是给**空转**上的锁：
   *    原来那版拿 `(v as ...).message ?? ''` 直接做三条 `not.toContain`，若某一形其实被放行（message 是
   *    undefined），三条断言会集体恒真通过。先 `toContain` 才能保证"这一形真的走到了这一支"，
   *    后面的 `not.toContain` 才是在判事。
   * ① 那一形的 `!includes(TOK)` 是**恒真**的（那个分支的 token 本就是空串）——留着它钉的是"空串也不会被拼进
   * 消息"，真正判住 503 那句话内容的是"用的就是 status.ts 那一份"那一条（评审 M17 实测 2 红）。
   * ⚠ 不拿 `LOCAL` 里的每个字段做 blanket 断言：`localhost` 与 `127.0.0.0/8` 本来就出现在那两句**静态**说明
   * 文字里（"本机形状只有 localhost 与 127.0.0.0/8 …"），禁它们会红得莫名其妙。
   */
  const REFUSAL_SHAPES: Array<{
    name: string;
    patch: Partial<Parameters<typeof guardNotebookProxy>[0]>;
    wantError: string;
    wantStatus: number;
    /** 这一支自己的那句话（两支共用同一个 error+status 时，它是"确实走到了这一支"的唯一证据） */
    wantClause: string;
    /** 喂进去的外部输入字面量，一个都不许出现在 message 里 */
    literals: string[];
  }> = [
    {
      name: '503 无 token',
      patch: { token: '' },
      wantError: 'notebook_not_configured',
      wantStatus: 503,
      wantClause: '这条同源反代不起作用',
      literals: [],
    },
    {
      name: '403 对端外来',
      patch: { peerAddress: PEER_CANARY },
      wantError: 'notebook_proxy_refused',
      wantStatus: 403,
      wantClause: 'socket 对端地址不是本机',
      literals: [PEER_CANARY, GW_CANARY],
    },
    {
      name: '403 Host 外来',
      patch: { hostHeader: HOST_CANARY },
      wantError: 'notebook_proxy_refused',
      wantStatus: 403,
      wantClause: 'Host 头不是本机字面量',
      // 带端口与裸域名各查一遍：只查全串的话，"拼去了端口的回显"会漏过去。
      literals: [HOST_CANARY, 'canary-host.example', GW_CANARY],
    },
    {
      name: '403 Host 缺席',
      patch: { hostHeader: undefined },
      wantError: 'notebook_proxy_refused',
      wantStatus: 403,
      wantClause: 'Host 头不是本机字面量',
      literals: [GW_CANARY],
    },
    {
      name: '403 Sec-Fetch 非法值',
      patch: { secFetchSite: HEADER_CANARY },
      wantError: 'notebook_cross_site',
      wantStatus: 403,
      wantClause: '不是从本页面发起的',
      literals: [GW_CANARY],
    },
    {
      name: '403 Sec-Fetch 多值',
      patch: { secFetchSite: `same-origin, ${HEADER_CANARY}` },
      wantError: 'notebook_cross_site',
      wantStatus: 403,
      wantClause: '不止一个值',
      literals: [GW_CANARY],
    },
  ];
  for (const shape of REFUSAL_SHAPES) {
    it(`否决消息不回显（${shape.name}）：既没有 token，也没有喂进去的头值/地址`, () => {
      const v = refused(guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: [GW_CANARY], ...shape.patch }));
      expect(v.error, shape.name).toBe(shape.wantError);
      expect(v.status, shape.name).toBe(shape.wantStatus);
      expect(v.message, shape.name).toContain(shape.wantClause);
      expect(v.message.includes(TOK), `${shape.name} ⇒ ${v.message}`).toBe(false);
      expect(v.message.includes(HEADER_CANARY), `${shape.name} ⇒ ${v.message}`).toBe(false);
      for (const literal of shape.literals) {
        expect(v.message.includes(literal), `${shape.name} 回显了 ${literal} ⇒ ${v.message}`).toBe(false);
      }
    });
  }

  /**
   * "闸门自己也要被门禁"（`dev_verify_workflow.md` 第三条）：上一条那一族用例的覆盖面是"五个分支逐个列全"，
   * 而覆盖面住在**形状清单**里 —— 有人删掉一形（或将来加了第六个分支没接线），这里红，
   * 而不是让"不回显"悄悄退回 M9 那次的 3/5。期望值是手抄的实现分支清单（`proxyGuard.ts` 里那五处
   * `return { ok: false }`：503 一支、合取两支靠 `which` 分、Sec-Fetch 两支），**不是从实现算出来的**。
   */
  it('否决形状清单 = 实现里那 5 个否决分支逐个列全（少一形就红，"不回显"不许只判得住 3 支）', () => {
    const identities = [...new Set(REFUSAL_SHAPES.map((s) => `${s.wantStatus}/${s.wantError}/${s.wantClause}`))].sort();
    expect(identities).toEqual([
      '403/notebook_cross_site/不是从本页面发起的',
      '403/notebook_cross_site/不止一个值',
      '403/notebook_proxy_refused/Host 头不是本机字面量',
      '403/notebook_proxy_refused/socket 对端地址不是本机',
      '503/notebook_not_configured/这条同源反代不起作用',
    ]);
    // 六形 = 五支 + Host 那一支多给一形（外来 / 缺席）。加形时这一句也要跟着改，判据在名字里。
    expect(REFUSAL_SHAPES.length).toBe(6);
  });

  /**
   * 这一条是 ⑤ 那一行实测的承担者（原 brief 把值拼成 `（${site}）`，与它自己顶上那段"绝不回显"矛盾）：
   * 把消息换回 brief 那版时，本文件**只有这一条**红（22 条照绿），且失败输出里就把 canary 印了出来。
   * ⚠ "会进日志"这半步是**设计上的推论**（Task 3 的日志接线还不存在）；实测到的部分是"canary 会随
   * 这句话回到发起方手里"。`HEADER_CANARY` 冒充的是客户端自报的 Sec-Fetch-Site 值 ——
   * 浏览器只发那几个枚举，但 curl 能发任意串。
   */
  it('Sec-Fetch-Site 那两支（多值/非法值）的消息既不回显读到的值，也不出现 token（它是外部输入，会进日志）', () => {
    for (const site of [HEADER_CANARY, `same-origin, ${HEADER_CANARY}`]) {
      const v = refused(guardNotebookProxy({ ...LOCAL, token: TOK, secFetchSite: site, gatewayAddresses: [] }));
      expect(v.error).toBe('notebook_cross_site');
      expect(v.status).toBe(403);
      expect(v.message.includes(HEADER_CANARY), v.message).toBe(false);
      // 这一句是 I-1 的另一半（评审 M9 原来 0 红）：上面那个循环把 token 喂在**非空**的位置上，
      // 所以"消息里不许拼 `${token}`"在这里是可判的，与"不回显头值"同形。
      expect(v.message.includes(TOK), v.message).toBe(false);
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
