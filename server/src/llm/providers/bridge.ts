import type { LlmProvider } from '../provider.js';
import { config } from '../../config.js';
import { llmSettings } from '../settings.js';

/**
 * 容器里跑时 qodercli / copilot 是宿主的 Windows 可执行文件，进不了 linux 容器。
 * 这个 provider 把 prompt 交给宿主上的 scripts/llm-bridge.mjs 代跑（需求 场景 8：
 * 判分仍由"本地已登录的 CLI"完成，只是多一层同机转发）。
 */
async function post(path: string, body?: unknown): Promise<Response> {
  // 走 llmSettings() 而不是原始 config：坏值（ARENA_LLM_TIMEOUT_MS=5m）会算出 NaN，
  // AbortSignal.timeout(NaN) 同步抛错 → 整档被判"不可用"。
  // /complete 额外把自己的超时传给桥，让桥的 CLI 超时严格短于本端（否则慢答案被先掐掉、桥白烧一次调用）。
  const timeoutMs = llmSettings().timeoutMs;
  return fetch(`${config.llm.bridgeUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-arena-token': config.llm.bridgeToken },
    body: body ? JSON.stringify({ ...(body as object), ...(path === '/complete' ? { timeoutMs } : {}) }) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export const bridgeProvider: LlmProvider = {
  kind: 'bridge',

  async available() {
    if (!config.llm.bridgeUrl) return false;
    try {
      const res = await post('/health');
      if (!res.ok) return false;
      const health = (await res.json()) as { ok?: boolean; runnable?: string[] };
      return health.ok === true && Array.isArray(health.runnable) && health.runnable.length > 0;
    } catch {
      return false;
    }
  },

  async complete(prompt: string) {
    const res = await post('/complete', { prompt });
    if (!res.ok) throw new Error(`LLM 桥返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
    const payload = (await res.json()) as { text?: string; provider?: string; error?: string };
    if (payload.error) throw new Error(`LLM 桥错误：${payload.error}`);
    if (typeof payload.text !== 'string') throw new Error('LLM 桥没有返回 text 字段');
    return payload.text;
  },

  get model() {
    return `bridge@${config.llm.bridgeUrl}`;
  },
};
