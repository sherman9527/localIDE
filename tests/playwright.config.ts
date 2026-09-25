import { defineConfig } from '@playwright/test';
import { BASE_URL } from './e2e/env.js';

/**
 * E2E 跑在容器里（那里才有真 JDK/MySQL/Redis/Spark）。
 * 默认由 instance.setup.ts 起一个**独立实例**（端口 7798、数据目录 data/e2e、题库只读），
 * 所以测试不再依赖、也不会污染真人的进度与 hidden 账本（WI-40）；
 * 设 ARENA_E2E_BASE 可打到自己起的实例（此时 setup 只做健康检查）。
 * 单用户本机系统，串行跑即可：判题会真的起进程，并发只会互相拖慢。
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: '../data/playwright-artifacts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './e2e/instance.setup.ts',
  globalTeardown: './e2e/instance.teardown.ts',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../data/playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    // 默认用宿主机的 Edge —— 用户日常就是它，用别的浏览器验等于没验他看到的界面。
    // 容器里下不到 Chromium（网络限制），所以这里不能留默认的 bundled chromium；
    // 想换 Chrome：ARENA_E2E_CHANNEL=chrome
    channel: process.env.ARENA_E2E_CHANNEL || 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
