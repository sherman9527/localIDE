import type {
  AttemptsResponse,
  DebugSessionsResponse,
  DebugStartRequest,
  DebugStartResponse,
  DebugStepRequest,
  DebugStepResponse,
  DebugStopRequest,
  DebugStopResponse,
  IdeLanguagesResponse,
  IdeRunRequest,
  IdeRunResponse,
  ReplFeedRequest,
  ReplFeedResponse,
  ReplStartRequest,
  ReplStartResponse,
  ReplStopRequest,
  ReplSessionsResponse,
  ReplStopResponse,
  BankQuery,
  BankResponse,
  CategoriesResponse,
  GradePostRequest,
  GradePostResponse,
  HideResponse,
  JudgeEvent,
  JudgePostResponse,
  JudgePostRequest,
  JudgeResult,
  ProgressResponse,
  QuestionDetailResponse,
  StackHealth,
  TodayResponse,
} from '@arena/shared';
import { API_PREFIX } from '@arena/shared';
import { createSseParser, parseJsonFrame, type SseFrame } from './lib/sse';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /**
   * 页面正在卸载时发的请求要 keepalive，否则浏览器直接丢掉它 ——
   * 后果不是"报错"，而是那个 REPL 会话（一个活进程）白占一个名额到空闲回收为止。
   */
  keepalive?: boolean;
}

import { isAbort, offlineError, toApiError } from './lib/errors';

export { ApiError, errorMessage } from './lib/errors';

async function requestJson<T>(method: string, path: string, body: unknown, label: string, opts: RequestOptions): Promise<T> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(API_PREFIX + path, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw offlineError(label);
  }
  if (!res.ok) throw await toApiError(res, label);
  return (await res.json()) as T;
}

export function get<T>(path: string, opts: RequestOptions & { label?: string } = {}): Promise<T> {
  return requestJson<T>('GET', path, undefined, opts.label ?? '读取数据', opts);
}

export function post<T>(path: string, body?: unknown, opts: RequestOptions & { label?: string } = {}): Promise<T> {
  return requestJson<T>('POST', path, body, opts.label ?? '提交', opts);
}

export function del<T>(path: string, opts: RequestOptions & { label?: string } = {}): Promise<T> {
  return requestJson<T>('DELETE', path, undefined, opts.label ?? '恢复', opts);
}

const q = (params: Record<string, string | undefined | boolean>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === false) continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

/**
 * 判题是长耗时操作（Java 3-8s、Spark 首次 10-20s），因此用 POST + SSE 读进度。
 * 返回流里最后那个 result；没有 result 时返回 null，由上层兜底。
 */
export async function judgeStream(
  body: JudgePostRequest,
  onEvent?: (e: JudgeEvent) => void,
  opts: RequestOptions = {},
): Promise<JudgeResult | null> {
  const label = '判题请求';
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`${API_PREFIX}/judge/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw offlineError(label);
  }
  if (!res.ok) throw await toApiError(res, label);

  const emit = (frame: SseFrame): JudgeResult | null => {
    const event = parseJsonFrame<JudgeEvent>(frame.data);
    if (!event || typeof event.type !== 'string') return null;
    onEvent?.(event);
    return event.type === 'result' ? event.result : null;
  };

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const payload = (await res.json()) as JudgePostResponse;
    onEvent?.({ type: 'result', result: payload.result });
    return payload.result;
  }

  const parser = createSseParser();
  let final: JudgeResult | null = null;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const r = emit(frame);
        if (r) final = r;
      }
    }
    for (const frame of parser.push(decoder.decode())) {
      const r = emit(frame);
      if (r) final = r;
    }
  } else {
    for (const frame of parser.push(await res.text())) {
      const r = emit(frame);
      if (r) final = r;
    }
  }
  for (const frame of parser.end()) {
    const r = emit(frame);
    if (r) final = r;
  }
  return final;
}

export const api = {
  health: (opts?: RequestOptions) => get<StackHealth>('/health', { ...opts, label: '读取环境状态' }),
  // 网页 IDE（WI-64）：只走 /api/ide/*，与题目接口零共用 —— 由 boundary.test.ts 把住
  ideLanguages: (opts?: RequestOptions) =>
    get<IdeLanguagesResponse>('/ide/languages', { ...opts, label: '读取 IDE 语言' }),
  ideRun: (body: IdeRunRequest, opts?: RequestOptions) =>
    post<IdeRunResponse>('/ide/run', body, { ...opts, label: '运行代码' }),
  ideReplStart: (body: ReplStartRequest, opts?: RequestOptions) =>
    post<ReplStartResponse>('/ide/repl/start', body, { ...opts, label: '开 REPL 会话' }),
  ideReplFeed: (body: ReplFeedRequest, opts?: RequestOptions) =>
    post<ReplFeedResponse>('/ide/repl/feed', body, { ...opts, label: '送一句进 REPL' }),
  ideReplStop: (body: ReplStopRequest, opts?: RequestOptions) =>
    post<ReplStopResponse>('/ide/repl/stop', body, { ...opts, label: '关 REPL 会话' }),
  ideReplSessions: (opts?: RequestOptions) =>
    get<ReplSessionsResponse>('/ide/repl', { ...opts, label: '读取 REPL 会话' }),
  // 行断点（WI-81）：与 REPL 同样的"一问一答"，因为每条命令都有天然的结束点 = 下一个停点
  ideDebugStart: (body: DebugStartRequest, opts?: RequestOptions) =>
    post<DebugStartResponse>('/ide/debug/start', body, { ...opts, label: '开始调试' }),
  ideDebugStep: (body: DebugStepRequest, opts?: RequestOptions) =>
    post<DebugStepResponse>('/ide/debug/step', body, { ...opts, label: '单步' }),
  ideDebugStop: (body: DebugStopRequest, opts?: RequestOptions) =>
    post<DebugStopResponse>('/ide/debug/stop', body, { ...opts, label: '停止调试' }),
  ideDebugSessions: (opts?: RequestOptions) =>
    get<DebugSessionsResponse>('/ide/debug', { ...opts, label: '读取调试会话' }),
  categories: (opts?: RequestOptions) => get<CategoriesResponse>('/categories', { ...opts, label: '读取类别' }),
  today: (category?: string, opts?: RequestOptions) =>
    get<TodayResponse>(`/challenge/today${q({ category })}`, { ...opts, label: '读取今日挑战' }),
  question: (id: string, opts?: RequestOptions) =>
    get<QuestionDetailResponse>(`/questions/${encodeURIComponent(id)}`, { ...opts, label: '读取题目' }),
  bank: (query: BankQuery = {}, opts?: RequestOptions) =>
    get<BankResponse>(
      `/bank${q({ category: query.category, difficulty: query.difficulty, tag: query.tag, q: query.q, includeHidden: query.includeHidden })}`,
      { ...opts, label: '读取题库' },
    ),
  progress: (opts?: RequestOptions) => get<ProgressResponse>('/progress', { ...opts, label: '读取进度' }),
  attempts: (questionId: string, opts: RequestOptions & { limit?: number } = {}) =>
    get<AttemptsResponse>(`/attempts${q({ questionId, limit: opts.limit === undefined ? undefined : String(opts.limit) })}`, {
      ...opts,
      label: '读取提交历史',
    }),
  hide: (id: string, opts?: RequestOptions) =>
    post<HideResponse>(`/questions/${encodeURIComponent(id)}/hide`, undefined, { ...opts, label: '移除题目' }),
  unhide: (id: string, opts?: RequestOptions) =>
    del<HideResponse>(`/questions/${encodeURIComponent(id)}/hide`, { ...opts, label: '恢复题目' }),
  judge: (body: JudgePostRequest, opts?: RequestOptions) => post<JudgePostResponse>('/judge', body, { ...opts, label: '判题' }),
  judgeStream: (body: JudgePostRequest, onEvent?: (e: JudgeEvent) => void, opts?: RequestOptions) =>
    judgeStream(body, onEvent, opts),
  grade: (body: GradePostRequest, opts?: RequestOptions) =>
    post<GradePostResponse>('/grade', body, { ...opts, label: '评分' }),
};
