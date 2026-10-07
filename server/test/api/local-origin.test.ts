import { describe, expect, it } from 'vitest';
import { hostHeaderHostname, isLoopbackAddressLiteral, isLoopbackHostHeader } from '../../src/net/localOrigin.js';

/**
 * 「什么算本机字面量」这一半的判据（终审 C-1）。住在 `server/src/net/localOrigin.ts`，
 * 有两个调用方：`notebooks/status.ts`（要不要往链接里附 token）与 `api/app.ts`（整个 API 认不认这次请求）。
 *
 * 这里判的是**形状**（端口切分 + 地址族判定），行为层的合取在
 * `server/test/notebooks/status.test.ts`（注入层）与 `server/test/api/notebook-api.test.ts`（路由层）。
 * 三层各判一件事，是因为这一半坏掉的形状不是报错，而是"给了一个不该给的 token"或"该给的时候不给"
 * —— 后者是本仓库反复记过的那种静默降级（用户点开撞 Jupyter 登录页，界面一片绿）。
 */

describe('hostHeaderHostname（Host 头里取 hostname：取不出来就给 null）', () => {
  const cases: Array<[string | undefined | null, string | null, string]> = [
    ['127.0.0.1:7788', '127.0.0.1', 'IPv4 + 端口'],
    ['127.0.0.1', '127.0.0.1', 'IPv4 没端口'],
    ['LOCALHOST:7788', 'localhost', '大小写不敏感（头是 HTTP 的，客户端怎么发都有）'],
    ['[::1]:7788', '::1', 'IPv6 的带端口写法（方括号是 RFC 规定的）'],
    ['[::1]', '::1', 'IPv6 没端口'],
    ['localhost', 'localhost', '名字没端口'],
    ['127.0.0.1:0', '127.0.0.1', '端口 0 也算端口形状'],
    ['', null, '空串'],
    ['   ', null, '只有空白'],
    [undefined, null, '缺席'],
    [null, null, 'null'],
    [':7788', null, '只有端口没有 hostname'],
    ['127.0.0.1:not-a-port', null, '端口位不是数字 ⇒ 坏值，不猜'],
    ['127.0.0.1:7788:99', null, '两个冒号：既可能是 IPv6 也可能是"地址:端口"，有歧义就不切'],
    ['::1:7788', null, '裸 IPv6（没方括号）：同一个字面量在 isLocalPeer 那边也被判"不是本机"'],
    ['[]', null, '方括号里没有东西'],
    ['[::1]x', null, '方括号后面跟的不是端口'],
  ];
  for (const [input, want, why] of cases) {
    it(`${JSON.stringify(input)} ⇒ ${want === null ? 'null' : JSON.stringify(want)}（${why}）`, () => {
      expect(hostHeaderHostname(input), why).toBe(want);
    });
  }
});

describe('isLoopbackHostHeader（合取的第二半：Host 是不是本机字面量）', () => {
  const yes = [
    '127.0.0.1:7788',
    '127.0.0.1',
    'localhost:7788',
    'localhost:7789',
    'localhost',
    '[::1]:7788',
    '127.0.0.42:7788',
    '[::ffff:127.0.0.1]:7788',
  ];
  for (const host of yes) {
    it(`${host} ⇒ 本机形状（不给 token 就等于让用户手贴，那是静默降级那一侧）`, () => {
      expect(isLoopbackHostHeader(host), host).toBe(true);
    });
  }

  const no = [
    // rebinding 的本体：域名解析到 127.0.0.1，但 Host 说的是那个域名
    'evil.example.com:7788',
    'rebinding.example',
    // 以本机字面量**开头**的域名不是地址
    '127.0.0.1.evil.example',
    'localhost.evil.example',
    'evil.localhost',
    // 本机上的别的地址 / 别机器的地址
    '10.0.0.1:7788',
    '192.168.1.20:7788',
    '172.18.0.1:7788',
    '0.0.0.0:7788',
    // 短得可疑的 IPv4：四段不齐就不算（与 isLocalPeer 同一口径）。
    // 代价照实说：`127.1` 在 inet_aton 的短写法里**确实**到本机，这里不放行 —— 症状只是
    // "那一次点开要手贴 token"，而不是"给了不该给的人"。两半共用同一个分类函数，
    // 所以这个决定对**对端地址**与 **Host 头**是同一条，不会出现一边认一边不认。
    '127.0.0:7788',
    '127.1:7788',
    '127:7788',
    '127.0.0.256:7788',
    // 坏值一律 fail closed
    '',
    '   ',
    undefined,
    null,
    ':7788',
    '::1:7788',
    '127.0.0.1:7788:99',
  ];
  for (const host of no) {
    it(`${JSON.stringify(host)} ⇒ 不是本机形状（这一半不点头，token 就不许出现）`, () => {
      expect(isLoopbackHostHeader(host), String(host)).toBe(false);
    });
  }

  /**
   * 同源判据（这一条是"为什么把回环那半抽出来"的理由）：
   * Host 里的地址字面量与 socket 对端地址走**同一个**分类函数，于是同一个串在两处不可能各说一套。
   * 反例形状：`::1:7788` —— 旧那条 LOOPBACK 正则把它当"回环 + 端口"放过，而按地址族判它不是回环。
   */
  it('地址字面量的判定与对端那一半同源（`::1:7788` 在两处都是"不是本机"）', () => {
    expect(isLoopbackAddressLiteral('::1:7788'), '裸 IPv6 不是回环地址').toBe(false);
    expect(isLoopbackHostHeader('::1:7788'), '同一个字面量在 Host 这一半也不是本机').toBe(false);
    expect(isLoopbackAddressLiteral('127.0.0.1')).toBe(true);
    expect(isLoopbackAddressLiteral('localhost'), '名字不是地址：只有 isLoopbackHostHeader 认它').toBe(false);
    expect(isLoopbackAddressLiteral('::ffff:127.0.0.1'), '双栈写法要剥掉前缀再判').toBe(true);
    expect(isLoopbackAddressLiteral('::ffff:192.168.1.20')).toBe(false);
  });
});
