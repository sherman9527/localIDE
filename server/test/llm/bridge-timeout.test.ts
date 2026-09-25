import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { LLM_DEFAULT_TIMEOUT_MS, sanitizeTimeoutMs } from '../../src/llm/settings.js';
import { bridgeProvider } from '../../src/llm/providers/bridge.js';

/**
 * 评分链的超时口径（review agent 报的 WI-32）：
 * 1) 坏值不许算出 NaN —— `AbortSignal.timeout(NaN)` 同步抛错会被吞成"这一档不可用"；
 * 2) 桥侧 CLI 超时必须短于容器侧 HTTP 超时，否则慢答案被客户端先掐掉、桥还在白烧一次 CLI。
 */
describe('sanitizeTimeoutMs', () => {
  it('坏值一律退回默认，正数才生效', () => {
    expect(sanitizeTimeoutMs(undefined)).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs('')).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs('5m')).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs(NaN)).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs(0)).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs(-3)).toBe(LLM_DEFAULT_TIMEOUT_MS);
    expect(sanitizeTimeoutMs('45000')).toBe(45_000);
    expect(sanitizeTimeoutMs(30_500.7)).toBe(30_500);
  });
});

describe('bridgeProvider 的超时传递', () => {
  const original = { url: config.llm.bridgeUrl, timeout: config.llm.timeoutMs };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: '{}', provider: 'qodercli' }), { status: 200 }));

  afterEach(() => {
    Object.assign(config.llm, { bridgeUrl: original.url, timeoutMs: original.timeout });
    vi.unstubAllGlobals();
  });

  it('/complete 带上自己的超时，让桥据此收敛（桥 < 容器 由构造保证）', async () => {
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(config.llm, { bridgeUrl: 'http://bridge.test', timeoutMs: 180_000 });
    await bridgeProvider.complete('题目与答案');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body?: string; signal?: unknown }];
    expect(url).toBe('http://bridge.test/complete');
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: '题目与答案', timeoutMs: 180_000 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('坏配置不会让 available() 因 RangeError 被判"不可用"', async () => {
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(config.llm, { bridgeUrl: 'http://bridge.test', timeoutMs: Number('28d') });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, runnable: ['qodercli'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(bridgeProvider.available()).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, { signal: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
