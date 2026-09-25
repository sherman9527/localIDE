/**
 * 手写 SSE 帧解析：判题走 POST + text/event-stream，EventSource 不支持 POST，
 * 所以只能自己按 `data: {...}\n\n` 切帧（要能容忍半帧、粘帧、心跳注释行、CRLF）。
 */

export interface SseFrame {
  event: string;
  data: string;
}

export interface SseParser {
  /** 喂入任意长度的一段文本，返回已经完整的帧（不完整的留在内部）。 */
  push(chunk: string): SseFrame[];
  /** 流结束：把残留内容尽量冲刷成帧。 */
  end(): SseFrame[];
}

const LINE_BREAK = /\r\n|[\n\r]/;

export function createSseParser(): SseParser {
  let rest = '';
  let data: string[] = [];
  let event = '';

  const applyField = (line: string): void => {
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  const flush = (): SseFrame | null => {
    if (data.length === 0) {
      event = '';
      return null;
    }
    const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
    data = [];
    event = '';
    return frame;
  };

  const drainLine = (line: string, out: SseFrame[]): void => {
    if (line === '') {
      const frame = flush();
      if (frame) out.push(frame);
      return;
    }
    applyField(line);
  };

  return {
    push(chunk: string): SseFrame[] {
      rest += chunk;
      const out: SseFrame[] = [];
      for (;;) {
        const m = LINE_BREAK.exec(rest);
        if (!m) break;
        const line = rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        drainLine(line, out);
      }
      return out;
    },
    end(): SseFrame[] {
      const out: SseFrame[] = [];
      if (rest !== '') {
        const pending = rest;
        rest = '';
        drainLine(pending, out);
      }
      const last = flush();
      if (last) out.push(last);
      return out;
    },
  };
}

/** 判题流里偶尔会混进心跳或被截断的片段；解析失败就当没有这一帧，不能打断整条流。 */
export function parseJsonFrame<T>(data: string): T | null {
  try {
    const value: unknown = JSON.parse(data);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as T;
  } catch {
    return null;
  }
}
