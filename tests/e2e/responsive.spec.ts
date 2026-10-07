import { expect, test } from '@playwright/test';

/**
 * 视口边界闸门。
 *
 * 为什么单独立一条：2026-09-24 那轮"修窄屏"本身就是靠人眼看的 —— 我先修了 390px，
 * 结果在 768/1440 **新造出**横向滚动（给芯片里的非文本项加 `flex:none`，内容顶破芯片），
 * 而单测与原有 E2E 全绿。"必须在真浏览器里看过"这条规矩只覆盖了"看的人当时看了哪一页、
 * 哪个宽度"，没看过的宽度就等于没验。这里把"看过"变成断言。
 *
 * 四条判据都是**几何**判据，不依赖文案：
 *  1. 整页不许横向滚动（`scrollWidth > clientWidth`）；
 *  2. 任何带自有文本的元素不许被 ellipsis/overflow 裁掉（`code/pre/textarea/select/svg` 除外 ——
 *     代码块本来就该横向滚动，那是功能不是事故）；
 *  3. 类别芯片一行里的宽度必须一致（网格给的；`flex: 1 1 210px` 时最后一颗会拉成整行宽）；
 *  4. 顶栏（HEAD）里 `head-meta` 必须与 `.brand` 同一行、且贴在这一行的右端 —— 判据与
 *     采样点的理由写在 HEADER_PROBE。fcd709b 那半截修复留下的 **431–634** 这一段
 *     从来没被采样过（旧 WIDTHS 只有 320/390/768/1440），所以"顶栏换成四行、meta 掉到最左"
 *     （实测 480px：meta left=24 / right=87、topbar 高 112）一路绿着进了 HEAD。
 *     采样点因此要盖住**换行带**（480 / 600），不是只盖两端；1100 也钉上，它是
 *     「桌面顶栏必须是一行 52px」那条账（`.q-side` 的 sticky 读 --header-h）唯一的断言点。
 */

const WIDTHS = [320, 390, 480, 600, 768, 1100, 1440] as const;

const ROUTES: readonly (readonly [string, string])[] = [
  ['今日挑战', '/#/'],
  ['题库', '/#/bank'],
  ['进度', '/#/progress'],
  ['网页 IDE', '/#/ide'],
  ['代码题', '/#/q/sql-mysql-0001'],
  ['主观题', '/#/q/sys-rubric-0004'],
];

interface LayoutReport {
  overflow: string | null;
  clipped: string[];
  chipWidths: number[];
}

/**
 * 顶栏几何（量矩形，不量文案）。
 *
 * 为什么要单独一条：`.topbar` 是无条件 `flex-wrap: wrap` 的，而 wrap 之后每个孩子的
 * **行归属由 flex 收集行的算法决定**（每行收的是源顺序里的连续一段）—— 这件事肉眼在
 * 320 与 1440 上都看不出来，只在中间那段露馅。所以直接把两条不变量写成断言：
 *  ① `head-meta` 与 `.brand` 在**同一行**（竖直重叠，见下面 sameRow 的理由）；
 *  ② `head-meta` 的 `right` 贴着自己那一行的右端 —— 那一行如果只有它排在最后，右端就是
 *     `.topbar` 内容盒的右边；如果 nav 与它同排（桌面：brand …… meta + nav），右端就是
 *     `nav.left − column-gap`。旧那版在 480px 两条都红（meta 落在最左、且与 brand 不同行）。
 * ③ 外加 `--header-h` 那笔账：≥1100px 顶栏必须是**一行 52px**，因为 `.q-side` 的
 *     `position: sticky; top: calc(var(--header-h) + …)` 读的是变量而不是实测高度
 *     —— 顶栏变成两行时那个面板会被压在头底下（base.css「顶栏换行」那段）。
 */
interface HeaderBox {
  top: number;
  left: number;
  right: number;
  height: number;
}

interface HeaderReport {
  missing: string[];
  topbar: HeaderBox;
  brand: HeaderBox;
  nav: HeaderBox;
  meta: HeaderBox;
  /** .topbar 的 column-gap（px）：同排时 meta 与 nav 之间应当正好差一个 gap。 */
  colGap: number;
  /** 内容盒右边界 = rect.right − padding-right。 */
  contentRight: number;
}

/**
 * 页面里跑的函数**不许引用外层变量**：page.evaluate 只序列化函数体，
 * 闭包外的常量在浏览器里是 undefined（踩过一次，红成 ReferenceError 而不是红成断言）。
 * 所以 ZERO 在这里就地构造。
 */
const HEADER_PROBE = (): HeaderReport => {
  const ZERO: HeaderBox = { top: 0, left: 0, right: 0, height: 0 };
  const sel = (name: string) => document.querySelector(name) as HTMLElement | null;
  const topbar = sel('.topbar');
  const brand = sel('.topbar .brand');
  const nav = sel('.topbar .nav');
  const meta = sel('.topbar .head-meta');
  const pairs: [string, HTMLElement | null][] = [
    ['.topbar', topbar],
    ['.topbar .brand', brand],
    ['.topbar .nav', nav],
    ['.topbar .head-meta', meta],
  ];
  const missing = pairs.filter(([, el]) => !el).map(([name]) => name);
  const r = (el: Element): HeaderBox => {
    const b = el.getBoundingClientRect();
    return { top: b.top, left: b.left, right: b.right, height: b.height };
  };
  if (!topbar || !brand || !nav || !meta) {
    return { missing, topbar: ZERO, brand: ZERO, nav: ZERO, meta: ZERO, colGap: 0, contentRight: 0 };
  }
  const cs = getComputedStyle(topbar);
  return {
    missing,
    topbar: r(topbar),
    brand: r(brand),
    nav: r(nav),
    meta: r(meta),
    colGap: parseFloat(cs.columnGap) || 0,
    contentRight: topbar.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0),
  };
};

/**
 * 「同一行」的判据：**竖直方向有重叠**，不是 top 相等。
 * 用 top 相等是错的（实测 1440px：nav 的盒子高 30、meta 高 17，两者在同一行里被居中，
 * nav.top=6.7 而 meta.top=15.4 —— 差 8.7px）；旧那版 480px 把 meta 甩到第四行时，
 * 它与 brand 的 top 差的是 40+px 且完全不重叠 ⇒ 重叠判据既能放行同排，也照样抓得住分行。
 */
const sameRow = (a: HeaderBox, b: HeaderBox) => a.top <= b.top + b.height && b.top <= a.top + a.height;

/** 在页面里跑一遍几何体检。返回可直接读的红线清单，别让失败信息只剩"expected []"。 */
const PROBE = (): LayoutReport => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const name = (el: Element) => {
    const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const out: LayoutReport = { overflow: null, clipped: [], chipWidths: [] };
  if (de.scrollWidth > vw + 1) out.overflow = `documentElement.scrollWidth ${de.scrollWidth} > clientWidth ${vw}`;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (el.closest('svg') || el.closest('code') || ['CODE', 'PRE', 'TEXTAREA', 'SELECT'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
    if (!hasOwnText) continue;
    if (el.scrollWidth > el.clientWidth + 2 && ['hidden', 'clip'].includes(cs.overflowX)) {
      out.clipped.push(`${name(el)} ${el.scrollWidth}>${el.clientWidth} :: ${(el.textContent ?? '').trim().slice(0, 24)}`);
    }
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 2 || r.left < -2)) {
      out.clipped.push(`OFFSCREEN ${name(el)} [${Math.round(r.left)},${Math.round(r.right)}] :: ${(el.textContent ?? '').trim().slice(0, 24)}`);
    }
  }
  const strip = document.querySelector('.cat-strip');
  if (strip) {
    out.chipWidths = [...new Set(Array.from(strip.children).map((k) => Math.round(k.getBoundingClientRect().width)))];
  }
  return out;
};

for (const width of WIDTHS) {
  test.describe(`视口 ${width}px`, () => {
    for (const [label, route] of ROUTES) {
      test(`${label} 不溢出、不裁字、芯片等宽`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        // 懒加载页要等内容真的出现再量：量在骨架屏上等于没量
        if (route === '/#/bank') await page.locator('.bank-row').first().waitFor();
        if (route === '/#/') await page.getByTestId('category-card').first().waitFor();
        if (route.startsWith('/#/q/')) await page.getByTestId('question-header').waitFor();
        await page.waitForTimeout(250);

        const report = await page.evaluate(PROBE);
        expect(report.overflow, `${label} 在 ${width}px 出现整页横向滚动`).toBeNull();
        expect(report.clipped, `${label} 在 ${width}px 有被裁掉的文本`).toEqual([]);

        // 顶栏几何：换成四行 / meta 掉到最左，这两条都会红（fcd709b 漏掉的 431–634 就靠它兜住）
        const h = await page.evaluate(HEADER_PROBE);
        const px = (v: number) => v.toFixed(1);
        const rect = (b: HeaderBox) => `[top=${px(b.top)} bottom=${px(b.top + b.height)} left=${px(b.left)} right=${px(b.right)}]`;
        expect(h.missing, `${label} 在 ${width}px 顶栏缺元素，几何判据没法量（App.tsx 的 header 结构被改了？）`).toEqual([]);
        expect(sameRow(h.brand, h.meta), `${label} 在 ${width}px：head-meta ${rect(h.meta)} 与 brand ${rect(h.brand)} 不在同一行`).toBe(true);
        const navSharesRow = sameRow(h.nav, h.meta) && h.nav.left >= h.meta.right - 2;
        // 那一行的右端：nav 与 meta 同排时桌面读法是「brand …… meta + nav」，右端就是 nav 前面那个 gap；
        // nav 掉到第二行时 meta 就是这一行最右的东西，右端 = .topbar 内容盒右边。
        const expectedRight = navSharesRow ? h.nav.left - h.colGap : h.contentRight;
        const flushDelta = Math.abs(h.meta.right - expectedRight);
        expect(
          flushDelta,
          `${label} 在 ${width}px：head-meta 没贴在自己那一行的右端 —— meta ${rect(h.meta)}，` +
            `期望右端 ${px(expectedRight)}（contentRight=${px(h.contentRight)}，nav 同排=${navSharesRow}，` +
            `nav ${rect(h.nav)}，colGap=${h.colGap}）。掉到最左就是 fcd709b 在 480px 的故障形状`,
        ).toBeLessThanOrEqual(4);
        if (width >= 1100) {
          // .q-side 的 sticky 读 --header-h（52px）而不是实测高度 ⇒ 桌面顶栏必须是**一行 52px**
          expect(h.topbar.height, `${label} 在 ${width}px：顶栏高 ${px(h.topbar.height)}px ≠ --header-h(52px) ⇒ 它换行了，右侧 sticky 面板会藏到头底下`).toBeLessThanOrEqual(52.5);
        }
        if (report.chipWidths.length > 0) {
          expect(report.chipWidths.length, `类别芯片宽度不一致（同一行里有被拉宽的）：${report.chipWidths.join(' / ')}`).toBe(1);
        }
      });
    }
  });
}
