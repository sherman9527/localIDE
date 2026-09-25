import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 浅色主题的可断言版本（web-client spec：页面底色亮度 L* ≥ 85、正文对比度 ≥ 7:1、
 * 动画只允许 transform/opacity）。色度学计算就地实现，不额外引依赖。
 */

/** 从仓库根跑（npx vitest run web/test）和从 web/ 跑（npm test -w @arena/web）都能定位到样式目录。 */
function stylesDir(): string {
  for (const cand of [resolve('src/styles'), resolve('web/src/styles'), resolve('../web/src/styles')]) {
    if (existsSync(join(cand, 'tokens.css'))) return cand;
  }
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    dir = join(dir, '..');
    const cand = join(dir, 'web', 'src', 'styles');
    if (existsSync(join(cand, 'tokens.css'))) return cand;
  }
  throw new Error('找不到 web/src/styles/tokens.css');
}

const STYLE_DIR = stylesDir();
const TOKENS = readFileSync(join(STYLE_DIR, 'tokens.css'), 'utf8');
const BASE = readFileSync(join(STYLE_DIR, 'base.css'), 'utf8');

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** sRGB → CIE76 的 L*（D65）。 */
export function lightnessLstar(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  const fy = y > 0.008856451679035631 ? Math.cbrt(y) : 7.787037037037037 * y + 0.13793103448275892;
  return 116 * fy - 16;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function tokenValue(css: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m?.[1]) throw new Error(`tokens.css 缺少 --${name}`);
  return m[1].trim();
}

function allCss(): string {
  return `${TOKENS}\n${BASE}`;
}

describe('tokens.css 浅色设计系统', () => {
  it('页面底色亮度 L* ≥ 85（颜色不要太深）', () => {
    const bg = tokenValue(TOKENS, 'bg');
    expect(bg).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    expect(lightnessLstar(bg)).toBeGreaterThanOrEqual(85);
  });

  it('卡片面与提升面同样是浅色', () => {
    for (const name of ['surface', 'surface-2', 'raised']) {
      expect(lightnessLstar(tokenValue(TOKENS, name)), `${name} 太深`).toBeGreaterThanOrEqual(80);
    }
  });

  it('正文对比度 ≥ 7:1', () => {
    const bg = tokenValue(TOKENS, 'bg');
    expect(contrastRatio(tokenValue(TOKENS, 'text'), bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(tokenValue(TOKENS, 'text-muted'), bg)).toBeGreaterThanOrEqual(4.5);
    // .faint 也承载实义小字（免责说明、耗时、trace 号），不能只当装饰色
    expect(contrastRatio(tokenValue(TOKENS, 'text-faint'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('文字色只有三档，且没有一档掉到 4.5:1 以下（WI-33 的边界靠这条兜住）', () => {
    const bg = tokenValue(TOKENS, 'bg');
    const names = [...TOKENS.matchAll(/--(text[\w-]*):\s*(#[0-9a-f]{3,6});/g)].map((m) => m[1]!).sort();
    expect(names, '加一档更浅的文字色 = 给"实义小字变看不清"开门').toEqual(['text', 'text-faint', 'text-muted']);
    for (const name of names) {
      expect(contrastRatio(tokenValue(TOKENS, name), bg), `${name} 太浅`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('主色/成功/危险都是语义色且对浅底足够深', () => {
    const bg = tokenValue(TOKENS, 'bg');
    const onSurface = tokenValue(TOKENS, 'surface');
    expect(contrastRatio(tokenValue(TOKENS, 'primary'), onSurface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokenValue(TOKENS, 'primary-strong'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenValue(TOKENS, 'success'), onSurface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokenValue(TOKENS, 'danger'), onSurface)).toBeGreaterThanOrEqual(3);
    expect(tokenValue(TOKENS, 'primary')).toMatch(/^#3b82f6$/i);
    expect(tokenValue(TOKENS, 'success')).toMatch(/^#16a34a$/i);
    expect(tokenValue(TOKENS, 'danger')).toMatch(/^#e11d48$/i);
  });

  it('提供间距 / 圆角 / 字号阶梯', () => {
    for (const name of ['space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6']) {
      expect(tokenValue(TOKENS, name), name).toMatch(/^\d+(\.\d+)?px$/);
    }
    for (const name of ['radius-sm', 'radius-md', 'radius-lg', 'radius-pill']) {
      expect(tokenValue(TOKENS, name), name).toMatch(/\d/);
    }
    const sizes = ['font-xs', 'font-sm', 'font-md', 'font-lg', 'font-xl', 'font-2xl'].map((n) =>
      Number.parseFloat(tokenValue(TOKENS, n)),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  });

  it('prefers-reduced-motion 下降级动画', () => {
    expect(allCss()).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(allCss());
    expect(block?.[1]).toMatch(/animation:\s*none/);
    expect(block?.[1]).toMatch(/transition:\s*none/);
  });

  it('动画与过渡只使用 transform / opacity', () => {
    const css = allCss();
    const COMPOSITE_ONLY = ['transform', 'opacity'];
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(keyframes.length).toBeGreaterThan(0);
    for (const [, name, body] of keyframes) {
      const props = [...(body ?? '').matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
      expect(props.length).toBeGreaterThan(0);
      expect(props.filter((p) => !COMPOSITE_ONLY.includes(p)), `@keyframes ${name} 使用了会触发重排的动画属性`).toEqual([]);
    }
    const EASE = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'infinite', 'none', 'forwards', 'backwards', 'both', 'alternate']);
    for (const [, value] of [...css.matchAll(/transition\s*:\s*([^;{}]+);/g)]) {
      const props = value!
        .split(',')
        .flatMap((part) => part.trim().split(/\s+/))
        .filter((tok) => /^[a-z-]+$/.test(tok) && !EASE.has(tok));
      expect(props.filter((p) => !COMPOSITE_ONLY.includes(p)), `transition 里有非合成属性：${props.join(' ')}`).toEqual([]);
    }
  });

  it('不存在把底色改深的暗色模式覆盖', () => {
    const css = allCss();
    const darkBlocks = [...css.matchAll(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{([\s\S]*?)\n\s*\}/g)];
    for (const block of darkBlocks) {
      expect(block[1]).not.toMatch(/--bg:\s*#[0-9a-f]{3,6}/i);
    }
  });
});
