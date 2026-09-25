import { expect, test } from '@playwright/test';

/**
 * 视口边界闸门。
 *
 * 为什么单独立一条：2026-09-24 那轮"修窄屏"本身就是靠人眼看的 —— 我先修了 390px，
 * 结果在 768/1440 **新造出**横向滚动（给芯片里的非文本项加 `flex:none`，内容顶破芯片），
 * 而单测与原有 E2E 全绿。"必须在真浏览器里看过"这条规矩只覆盖了"看的人当时看了哪一页、
 * 哪个宽度"，没看过的宽度就等于没验。这里把"看过"变成断言。
 *
 * 三条判据都是**几何**判据，不依赖文案：
 *  1. 整页不许横向滚动（`scrollWidth > clientWidth`）；
 *  2. 任何带自有文本的元素不许被 ellipsis/overflow 裁掉（`code/pre/textarea/select/svg` 除外 ——
 *     代码块本来就该横向滚动，那是功能不是事故）；
 *  3. 类别芯片一行里的宽度必须一致（网格给的；`flex: 1 1 210px` 时最后一颗会拉成整行宽）。
 */

const WIDTHS = [320, 390, 768, 1440] as const;

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
        if (report.chipWidths.length > 0) {
          expect(report.chipWidths.length, `类别芯片宽度不一致（同一行里有被拉宽的）：${report.chipWidths.join(' / ')}`).toBe(1);
        }
      });
    }
  });
}
