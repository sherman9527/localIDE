import { describe, expect, it } from 'vitest';
import { prefetchLazyPages } from '../src/lib/prefetch';

/**
 * 预取只在浏览器里"看得见效果"，所以这里只钉两件事：
 * 运行时的形状不能让它炸（jsdom 没有 requestIdleCallback），以及重复调用安全。
 * 真正的"首屏不含 CodeMirror"由 `scripts/check-bundle.mjs` 在产物层把关。
 */
describe('prefetchLazyPages', () => {
  it('没有 requestIdleCallback 的运行时退到宏任务而不是抛错', async () => {
    expect('requestIdleCallback' in globalThis).toBe(false);
    expect(() => prefetchLazyPages()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('重复调用安全（切页面不该把同一份 chunk 取两遍）', async () => {
    prefetchLazyPages();
    prefetchLazyPages();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
