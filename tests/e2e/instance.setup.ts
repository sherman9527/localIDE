import { spawnSync } from 'node:child_process';
import { BASE_URL, MANAGED, REPO_ROOT } from './env.js';

/**
 * 起一个**干净的** E2E 后端（compose 的 e2e 服务：数据目录 data/e2e、题库只读）。
 * 判分要真 JDK/MySQL/Redis/Spark，所以只能起在容器里；新容器首次要初始化 MySQL，
 * 因此健康等待给到 240s。
 */
const IMAGE = 'daily-arena:0.1';

function compose(...args: string[]) {
  return spawnSync('docker', ['compose', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const logs = compose('--profile', 'e2e', 'logs', '--tail', '40', 'e2e');
  throw new Error(
    `E2E 实例 ${BASE_URL} 在 ${timeoutMs / 1000}s 内没就绪。\n` +
      `--- docker compose logs ---\n${logs.stdout}${logs.stderr}`,
  );
}

/** 评分链不可用不是 E2E 的失败条件（桥是宿主进程），但必须说出来——否则一次"2 秒过完"的绿会被误读成验过了。 */
async function warnIfDegraded(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const health = (await res.json()) as { stacks?: Record<string, boolean> };
    if (health.stacks?.['llm-rubric'] === false) {
      console.log('[e2e] 警告：这个实例的评分链不可用（宿主桥没起，或它的端口被占了）——主观题只会验到人工自检表分支');
    }
  } catch {
    console.log('[e2e] 警告：读 /api/health 失败，无法判断评分链状态');
  }
}

export default async function globalSetup(): Promise<void> {
  if (!MANAGED) {
    // 用户自己指的实例：只确认它活着，失败信息要指出该怎么起
    if (!(await healthy())) {
      throw new Error(`ARENA_E2E_BASE=${BASE_URL} 指向的实例没有 /api/health —— 先起它，或去掉这个变量让脚本自己起`);
    }
    await warnIfDegraded();
    return;
  }
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { cwd: REPO_ROOT }).status !== 0) {
    throw new Error(`镜像 ${IMAGE} 不存在 —— 先跑 ./start.sh（或 docker compose build arena）再跑 E2E`);
  }
  const up = compose('--profile', 'e2e', 'up', '-d', 'e2e');
  if (up.status !== 0) {
    throw new Error(`起 E2E 实例失败：\n${up.stdout}\n${up.stderr}`);
  }
  await waitHealthy(240_000);
  await warnIfDegraded();
}
