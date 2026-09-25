import { describe, expect, it } from 'vitest';
import type { JudgeEvent, JudgeResult } from '@arena/shared';
import { createSseParser, parseJsonFrame } from '../src/lib/sse';

describe('SSE 帧解析', () => {
  it('完整帧：一条 data + 空行 = 一个事件', () => {
    const p = createSseParser();
    expect(p.push('data: {"type":"queued"}\n\n')).toEqual([{ event: 'message', data: '{"type":"queued"}' }]);
  });

  it('半帧不产出事件，补齐后才产出', () => {
    const p = createSseParser();
    expect(p.push('data: {"type":"pro')).toEqual([]);
    expect(p.push('gress","phase":"run"}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'message', data: '{"type":"progress","phase":"run"}' }]);
  });

  it('两帧粘连一次产出两个事件', () => {
    const p = createSseParser();
    const out = p.push('data: a\n\ndata: b\n\ndata: c\n');
    expect(out).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
    expect(p.push('\n')).toEqual([{ event: 'message', data: 'c' }]);
  });

  it('心跳注释行与只有 event/id 的帧都不产生事件', () => {
    const p = createSseParser();
    expect(p.push(': ping\n\n')).toEqual([]);
    expect(p.push('\n\n\n')).toEqual([]);
    expect(p.push('event: ping\nid: 42\n\n')).toEqual([]);
    expect(p.push(': ping\ndata: real\n\n')).toEqual([{ event: 'message', data: 'real' }]);
  });

  it('多行 data 用换行拼接；CRLF 也可', () => {
    const p = createSseParser();
    expect(p.push('data: line1\r\ndata: line2\r\n\r\n')).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('自定义 event 名保留', () => {
    const p = createSseParser();
    expect(p.push('event: result\ndata: {}\n\n')).toEqual([{ event: 'result', data: '{}' }]);
  });

  it('流结束时冲刷没有尾随空行的残帧', () => {
    const p = createSseParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'message', data: 'tail' }]);
    expect(p.end()).toEqual([]);
  });

  it('逐字节喂入与整块喂入结果一致（150 个事件的长流）', () => {
    const frames = Array.from({ length: 150 }, (_, i) => `data: {"i":${i}}\n\n`).join('');
    const whole = createSseParser();
    const batched = whole.push(frames);
    const byteByByte = createSseParser();
    const collected: string[] = [];
    for (const ch of frames) collected.push(...byteByByte.push(ch).map((f) => f.data));
    expect(collected).toEqual(batched.map((f) => f.data));
    expect(collected).toHaveLength(150);
  });

  it('parseJsonFrame 对不可解析内容返回 null 而不是抛错', () => {
    expect(parseJsonFrame<JudgeEvent>('not json')).toBeNull();
    expect(parseJsonFrame<JudgeEvent>('{"type":')).toBeNull();
    expect(parseJsonFrame<JudgeEvent>('[]')).toBeNull();
    expect(parseJsonFrame<JudgeEvent>('{"type":"queued","questionId":"x"}')).toEqual({ type: 'queued', questionId: 'x' });
  });

  it('判题事件的 data 可以还原成 JudgeResult', () => {
    const result: JudgeResult = {
      status: 'fail',
      passed: 1,
      failed: 2,
      total: 3,
      failedCases: [{ name: '空输入返回 0', passed: false }],
      passedCases: ['有唯一解'],
      durationMs: 4210,
    };
    const p = createSseParser();
    const [frame] = p.push(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
    expect(parseJsonFrame<{ type: string; result: JudgeResult }>(frame!.data)?.result).toEqual(result);
  });
});
