import { describe, expect, it } from 'vitest';
import type { JudgeEvent } from '@arena/shared';
import { judgeStream } from '../src/api';
import { JUDGE_FAIL } from './fixtures';

const ENC = new TextEncoder();

const FRAMES: JudgeEvent[] = [
  { type: 'queued', questionId: 'alg-java-0001' },
  { type: 'progress', phase: 'compile', elapsedMs: 210, timeoutMs: 20000 },
  { type: 'log', line: '[junit] running PairsTest' },
  { type: 'progress', phase: 'run', elapsedMs: 1200, timeoutMs: 20000 },
  { type: 'progress', phase: 'collect', elapsedMs: 4100, timeoutMs: 20000 },
  { type: 'result', result: JUDGE_FAIL },
];

const WIRE = `: connected\n\n${FRAMES.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}`;

function responseOf(chunks: (string | Uint8Array)[], init: { ok?: boolean; status?: number; text?: string } = {}) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? ENC.encode(c) : c);
      controller.close();
    },
  });
  const body = init.text === undefined ? stream : null;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': body ? 'text/event-stream' : 'text/plain' }),
    body,
    text: async () => init.text ?? '',
  } as unknown as Response;
}

/** 把文本按字节切成两半，且切口落在多字节字符内部。 */
function splitInsideMultibyte(text: string): [Uint8Array, Uint8Array] {
  const bytes = ENC.encode(text);
  let cut = 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! >= 0x80) {
      cut = i + 1;
      break;
    }
  }
  return [bytes.slice(0, cut), bytes.slice(cut)];
}

describe('judgeStream（SSE over fetch）', () => {
  it('按序解析 queued → progress → log → result，并返回最终 JudgeResult', async () => {
    const events: JudgeEvent[] = [];
    const result = await judgeStream(
      { questionId: 'alg-java-0001', submission: 'class A{}' },
      (e) => events.push(e),
      { fetchImpl: async () => responseOf([WIRE]) },
    );
    expect(events.map((e) => e.type)).toEqual(['queued', 'progress', 'log', 'progress', 'progress', 'result']);
    expect(events[0]).toEqual({ type: 'queued', questionId: 'alg-java-0001' });
    expect(events[1]).toEqual({ type: 'progress', phase: 'compile', elapsedMs: 210, timeoutMs: 20000 });
    expect(result).toEqual(JUDGE_FAIL);
  });

  it('帧被切成两半也能解析', async () => {
    const events: JudgeEvent[] = [];
    const one = `data: ${JSON.stringify(FRAMES[0])}\n\n`;
    await judgeStream({ questionId: 'alg-java-0001', submission: '' }, (e) => events.push(e), {
      fetchImpl: async () => responseOf([one.slice(0, 12), one.slice(12)]),
    });
    expect(events).toEqual([FRAMES[0]]);
  });

  it('两帧粘连在一次读里也按序产出两个事件', async () => {
    const events: JudgeEvent[] = [];
    const glued = FRAMES.slice(0, 3).map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await judgeStream({ questionId: 'alg-java-0001', submission: '' }, (e) => events.push(e), {
      fetchImpl: async () => responseOf([glued]),
    });
    expect(events).toEqual(FRAMES.slice(0, 3));
  });

  it('心跳注释行不产生事件；多字节字符被截断也不乱码', async () => {
    const events: JudgeEvent[] = [];
    const target = `data: ${JSON.stringify({ type: 'log', line: '中文日志：编译成功 — 用例 空输入返回 0' })}\n\n`;
    const [a, b] = splitInsideMultibyte(`: ping\n\n${target}`);
    await judgeStream({ questionId: 'x', submission: '' }, (e) => events.push(e), {
      fetchImpl: async () => responseOf([a, b]),
    });
    expect(events).toEqual([{ type: 'log', line: '中文日志：编译成功 — 用例 空输入返回 0' }]);
  });

  it('逐字节喂入 150 帧仍按序产出', async () => {
    const events: JudgeEvent[] = [];
    const bytes = ENC.encode(
      Array.from({ length: 150 }, (_, i) => `data: ${JSON.stringify({ type: 'log', line: `l${i}` })}\n\n`).join(''),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1));
        c.close();
      },
    });
    await judgeStream({ questionId: 'x', submission: '' }, (e) => events.push(e), {
      fetchImpl: async () =>
        ({ ok: true, status: 200, headers: new Headers(), body: stream, text: async () => '' }) as unknown as Response,
    });
    expect(events).toHaveLength(150);
    expect(events[149]).toEqual({ type: 'log', line: 'l149' });
  });

  it('HTTP 非 2xx 时给出可展示的中文错误，不复述后端堆栈', async () => {
    await expect(
      judgeStream({ questionId: 'x', submission: '' }, () => {}, {
        fetchImpl: async () =>
          responseOf([], { ok: false, status: 500, text: 'AssertionError: boom\n    at Runner.run (judge.ts:88:11)' }),
      }),
    ).rejects.toThrow(/判题请求失败/);
  });

  it('没有 result 事件时返回 null，让上层走兜底', async () => {
    const events: JudgeEvent[] = [];
    const result = await judgeStream({ questionId: 'x', submission: '' }, (e) => events.push(e), {
      fetchImpl: async () => responseOf([`data: ${JSON.stringify(FRAMES[0])}\n\n`]),
    });
    expect(result).toBeNull();
    expect(events).toEqual([FRAMES[0]]);
  });
});
