import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 测试直接跑 TS 源（alias 到 shared/src），不需要先 build shared/dist。
 * 生产构建仍走 tsc -b（npm run build）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@arena/shared': r('./shared/src/index.ts'),
    },
  },
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'web/test/**/*.test.ts?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'web/test/**/*.browser.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
