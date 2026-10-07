/**
 * 「这个请求是不是**从这台机器上的本机地址**发来的」里与 **Host 头**有关的那一半（终审 C-1）。
 *
 * 为什么单独成一个模块，而不是写在 `notebooks/status.ts` 里：它有**两个**调用方，而两个调用方
 * 各自都在别处（`notebooks/status.ts` 决定要不要往链接里附凭据；`api/app.ts` 决定整个 API 要不要
 * 认这次请求）。判据若住在任意一侧，另一侧就得反向 import 它 —— 于是"什么算本机字面量"这份真相
 * 会在两个目录里各长一遍，而这类"两处各写一遍"正是本仓库反复付过学费的形状（WI-86 的桥 token、
 * `notebook-image.test.ts` 里那条第四处字面量）。
 *
 * ## 它只是**合取的一半**，而且从不单独放行任何东西
 *
 * 上一轮（评审 M-1）的裁决是「token 释放判的是内核给的 socket 对端地址，**不是**客户端自报的 Host 头」，
 * 那句反对的是 **Host 单独说话**：任何人都能把头写成 `127.0.0.1:7788`，照着它发凭据等于把 token
 * 发给局域网里任意一个请求。那一条今天**没有被推翻**。
 * C-1 补的是另一头：**DNS rebinding** —— 受害者浏览器先把攻击者的域名解析到攻击者服务器、读完
 * 之后再改成 `127.0.0.1`，于是 socket 对端**确实**是回环（`isLocalPeer` 会点头），而响应与攻击页同源，
 * 页面上的 JS 就读得到 `url` 里那个 token（一个能在容器里以 root 执行任意代码的服务的长期凭据：
 * 躺在 `.env`、重启不换）。这时唯一还认得出"这个 Host 不是本机"的信息就是 Host 头本身。
 * ⇒ 判据 = `isLocalPeer(对端)` **且** `isLoopbackHostHeader(Host)`。合取严格强于任何一半：
 * 伪造头（对端不是本机）与 rebinding（头不是本机）各自都还得红 —— 两侧的用例都在
 * `server/test/notebooks/status.test.ts` 与 `server/test/api/notebook-api.test.ts` 里钉着。
 *
 * ## 为什么这一半也是"可以被绕过"的那一半（诚实的边界）
 *
 * 攻击者若能让**报文真的**从本机某处发进来（本机上的任意进程就能用 raw socket 伪造源地址），
 * 而 Host 又写成 `localhost`，合取两半都成立 —— 那种前提已经不是"远程网页"而是"本机已失守"，
 * 今天每一道基于对端地址的判据都同样拦不住它（`isLocalPeer` 顶部那段写了同一件事）。
 * 这一半拦的是**远程页面**那条路，别把它读成"从此 Host 可信"。
 */

/** Host 头里端口那一截的合法形状：要么没有，要么 `:` + 1~5 位数字。别的（再一个冒号、字母）一律算坏值。 */
const PORT_TAIL = /^:\d{1,5}$|^\s*$/;

/**
 * 从 Host 头里取出 hostname（小写、不含端口）。**取不出来就给 null**，调用方按 fail-closed 处理。
 *
 * 三种写法都要照顾到，而且不许用"最后一个冒号之后是端口"那种宽容切法：
 * - `127.0.0.1:7788` / `localhost:7788`：IPv4 与名字都只允许一个冒号。
 * - `[::1]:7788`：IPv6 必须带方括号（RFC 3986/RFC 7230 都是这么规定的，浏览器也只会这么发）。
 * - `::1:7788`：**裸 IPv6 里冒号是地址的一部分**，不是"地址:端口"的分隔符 —— 这一串既可能读成
 *   `::1` 端口 7788，也可能读成 `::1:7788` 这个完整地址（它展开是 `0:0:0:0:0:0:1:7788`，**不是回环**）。
 *   有歧义就不猜：`isLocalPeer` 那边同一个形状已经被判过"不是本机"（评审 M-1 的另一半），
 *   这里保持同一个答案，别让同一个字面量在两处各解释一次。
 */
export function hostHeaderHostname(value: string | undefined | null): string | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 2) return null; // `[]` / `[x]` 这类坏形状：方括号里得有东西
    if (!PORT_TAIL.test(raw.slice(end + 1))) return null;
    return raw.slice(1, end);
  }
  const first = raw.indexOf(':');
  if (first < 0) return raw; // 没有端口
  if (raw.indexOf(':', first + 1) >= 0) return null; // 第二个冒号 ⇒ 裸 IPv6，有歧义 ⇒ fail closed
  if (!PORT_TAIL.test(raw.slice(first))) return null;
  return first === 0 ? null : raw.slice(0, first); // `:7788` 这种"只有端口"的坏值
}

/**
 * 一个字面量是不是"这台机器自己"的**地址**（不含任何"网关也算"的放宽 —— 那一半只在
 * `notebooks/status.ts` 的 `isLocalPeer` 里成立，而且它成立的前提是 compose 把发布端口都绑在
 * 宿主回环上，见那里的注释与 `compose-ports.test.ts`）。
 * 输入是**已经摘掉端口**的字面量；`'localhost'` 这类名字**不算**地址（走 `isLoopbackHostHeader` 那侧）。
 */
export function isLoopbackAddressLiteral(literal: string): boolean {
  const addr = literal.trim().toLowerCase();
  if (addr === '') return false;
  // 双栈监听时 Node 把 IPv4 对端写成 `::ffff:127.0.0.1`；Host 头里几乎不会出现这一支，但同一份判据只写一遍
  const ip = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  if (ip === '::1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    n = n * 256 + octet;
  }
  // 127.0.0.0/8 **整段**都是回环（`127.1.2.3` 也到本机），但四段必须齐全：`127.0.0` / `127.1` / `127`
  // 这些 inet_aton 短写法**不算**（宁可不给 token，也不给一个"两半解释不一样"的字面量 —— 代价见测试里那句）
  return (n >>> 24) === 127;
}

/**
 * Host 头是不是"本机形状"：`localhost` 这个**名字**，或一个回环**地址字面量**，端口可有可无。
 *
 * `localhost` 为什么放行（这是个**决定**，不是漏判，钉在 `status.test.ts` 的合取表里）：
 * rebinding 要的是"我控制的域名解析到 127.0.0.1"，而把 `localhost` 这个名字解析到别处需要受害者
 * 本机 DNS/hosts 已经被人改过 —— 那已经不是这一半拦得住的那一类攻击。反过来，
 * `http://localhost:7788` 是用户真会敲的第二个写法（`start.ps1` 的健康检查用的就是它），
 * 判它红等于把功能在最常见的写法上关掉。
 *
 * 不放行的：任何别的名字（`evil.example.com`、以本机字面量开头的域名 `127.0.0.1.evil.example`）、
 * 坏值（空、多冒号、只有端口、端口不是数字），以及 inet_aton 的 IPv4 短写法（`127.1`）——
 * 短写法在系统解析里确实到本机，但这里两半都要求四段齐全：**同一个字面量在对端与 Host 上必须有
 * 同一个答案**，而 `isLocalPeer` 那一半本来就不收短写法（`status.test.ts` 钉着 `127` / `127.0.0` 不给）。
 * 判它不通过的代价是"这一次点开要手贴一次 token"，判它通过的代价是"两半各解释一遍"。
 */
export function isLoopbackHostHeader(value: string | undefined | null): boolean {
  const host = hostHeaderHostname(value);
  if (host === null || host === '') return false;
  if (host === 'localhost') return true;
  return isLoopbackAddressLiteral(host);
}
