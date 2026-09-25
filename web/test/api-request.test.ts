import { describe, expect, it } from 'vitest';
import { api } from '../src/api';

/**
 * 请求选项是否真的落到了 fetch 上。
 *
 * 单看 `RequestOptions.keepalive` 这个字段是没用的：它只要没被拼进 fetch 的 init，
 * 类型检查、lint、组件测试全都照样绿 —— 而它的唯一作用是让浏览器在卸载页面时
 * 别把"关掉 REPL 会话"这个请求丢掉。漏了的后果不是报错，是那个解释器白占一个名额
 * （上限 2 个）直到 5 分钟空闲回收，期间面板一直开不出新会话。
 */

function recorder(payload: unknown = { ok: true }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload } as unknown as Response;
  };
  return { calls, fetchImpl };
}

describe('keepalive 透传（REPL 会话名额）', () => {
  it('带 keepalive 的关闭请求，fetch init 里真的有 keepalive: true', async () => {
    const { calls, fetchImpl } = recorder();
    await api.ideReplStop({ sessionId: 's1' }, { keepalive: true, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/ide/repl/stop');
    expect(calls[0]!.init?.keepalive).toBe(true);
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ sessionId: 's1' }));
  });

  it('不传就是普通请求：keepalive 不许偷偷变成默认值（它有 64KB 请求体上限）', async () => {
    const { calls, fetchImpl } = recorder();
    await api.ideReplStop({ sessionId: 's1' }, { fetchImpl });
    expect(calls[0]!.init?.keepalive).toBeUndefined();
  });

  it('GET 也走同一套（会话列表读取将来也可能要卸载时发）', async () => {
    const { calls, fetchImpl } = recorder({ sessions: [], maxSessions: 2, idleMs: 1 });
    await api.ideReplSessions({ fetchImpl });
    expect(calls[0]!.url).toBe('/api/ide/repl');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.body).toBeUndefined();
  });
});
