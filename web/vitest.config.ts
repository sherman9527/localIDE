import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 从仓库根跑 `npx vitest run web/test` 用的是根 vitest.config.ts；
 * 这份配置给 `npm test -w @arena/web` 用，两者行为一致：jsdom + 直接跑 shared 的 TS 源。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@arena/shared': r('../shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts?(x)'],
    setupFiles: [r('./test/setup.ts')],
    testTimeout: 30_000,
  },
});
