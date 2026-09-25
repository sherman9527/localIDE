import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * 配置层的一条契约（WI-40）：`ARENA_DATA_DIR` 必须是"所有可写产物"的总开关。
 * 之前它只管日志与 spark 暂存，db 与判题沙箱各自写死在 data/ 下 ——
 * 于是"E2E 用一个独立数据目录"要设三个变量，漏一个就污染真人那份（正是这条要消灭的耦合）。
 */

const DATA_DIR = resolve('tmp-e2e-data');

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const key of ['ARENA_DATA_DIR', 'ARENA_DB_FILE', 'NODE_ENV']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    const config = (await import('../src/config.js')).config;
    const { LOG_DIR } = await import('../src/log.js');
    return { config, LOG_DIR };
  } finally {
    Object.assign(process.env, saved);
  }
}

describe('ARENA_DATA_DIR 是所有可写产物的总开关', () => {
  it('只设它一个，db / 判题沙箱 / 日志都跟着走', async () => {
    const { config, LOG_DIR } = await loadConfig({ ARENA_DATA_DIR: DATA_DIR, NODE_ENV: 'production' });
    expect(config.dataDir).toBe(DATA_DIR);
    expect(config.dbFile).toBe(resolve(DATA_DIR, 'arena.db'));
    expect(config.judgeWorkDir).toBe(resolve(DATA_DIR, 'judge'));
    expect(LOG_DIR).toBe(resolve(DATA_DIR, 'logs'));
  });

  it('单条路径的显式覆盖仍然优先（compose 里就靠这个分别钉住）', async () => {
    const custom = resolve('tmp-e2e-data', 'other.db');
    const { config } = await loadConfig({ ARENA_DATA_DIR: DATA_DIR, ARENA_DB_FILE: custom });
    expect(config.dbFile).toBe(custom);
  });

  it('不设任何变量时保持原位（真人那份 data/arena.db 不受这次改动影响）', async () => {
    const { config } = await loadConfig({ ARENA_DATA_DIR: undefined, ARENA_DB_FILE: undefined });
    expect(config.dataDir.endsWith('data')).toBe(true);
    expect(config.dbFile).toBe(resolve(config.dataDir, 'arena.db'));
  });
});
