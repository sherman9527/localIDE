import { resolve } from 'node:path';
import { join } from 'node:path';

/**
 * E2E 打在哪、它的可写状态落在哪 —— 只在这里定一次。
 * 默认由 `instance.setup.ts` 起一个独立实例（compose 的 e2e 服务，数据目录 data/e2e），
 * 这样跑测试不会改动真人的 XP/连击，也不会把题目从 content/hidden.json 里抹掉（WI-40）。
 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** 显式给了 ARENA_E2E_BASE 就完全尊重它（容器内跑 E2E、或想打到自己起的实例），不再管容器生命周期。 */
export const MANAGED = !process.env.ARENA_E2E_BASE;

/** 7798 = compose 里 e2e 服务的宿主端口。别用 7799（那是宿主 CLI 桥的端口，撞上会把两边的评分链一起弄瞎）。 */
export const BASE_URL = process.env.ARENA_E2E_BASE ?? 'http://127.0.0.1:7798';

/** 独立实例的软删账本：/app/data 是仓库 data/ 的 bind mount，所以宿主侧路径能直接读。 */
export const HIDDEN_FILE = MANAGED
  ? join(REPO_ROOT, 'data', 'e2e', 'hidden.json')
  : join(REPO_ROOT, 'content', 'hidden.json');

export const E2E_DATA_DIR = join(REPO_ROOT, 'data', 'e2e');
