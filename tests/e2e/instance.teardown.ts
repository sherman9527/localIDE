import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { E2E_DATA_DIR, MANAGED, REPO_ROOT } from './env.js';

/**
 * 只收 E2E 那一套：`stop/rm` 都点名 e2e 服务，绝不 `compose down`
 * —— down 会连真人在用的 arena 容器一起停掉。
 */
function compose(...args: string[]) {
  return spawnSync('docker', ['compose', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

export default async function globalTeardown(): Promise<void> {
  if (!MANAGED) return;
  if (process.env.ARENA_E2E_KEEP === '1') {
    console.log('[e2e] ARENA_E2E_KEEP=1：留着 daily-arena-e2e 容器与 data/e2e 供排查');
    return;
  }
  compose('--profile', 'e2e', 'stop', 'e2e');
  compose('--profile', 'e2e', 'rm', '-f', 'e2e');
  // 下一轮必须从"没做过任何题"开始；日志与判题沙箱也一起清（都在这一个目录下）。
  // 注意不动 data/playwright-artifacts —— 失败现场的 trace 在那里，teardown 删掉就没法查了。
  await rm(E2E_DATA_DIR, { recursive: true, force: true });
}
