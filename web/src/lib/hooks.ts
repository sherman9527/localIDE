import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, isAbort } from './errors';

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 只做"一次请求 + 三态"，切换路由或重发时取消上一次请求，
 * 避免旧响应覆盖新数据。
 */
export function useAsync<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  label = '数据',
): AsyncData<T> {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setState((prev) => (prev.loading && prev.error === null ? prev : { data: prev.data, loading: true, error: null }));
    void factoryRef.current(controller.signal).then(
      (data) => {
        if (alive) setState({ data, loading: false, error: null });
      },
      (e: unknown) => {
        if (!alive || isAbort(e)) return;
        const message = errorMessage(e);
        setState((prev) => ({ data: prev.data, loading: false, error: message || `${label}失败` }));
      },
    );
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  return { data: state.data, loading: state.loading, error: state.error, reload };
}

export function useDebounced<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 写 localStorage 时做个节流，避免每次按键都同步落盘。 */
export function useDebouncedEffect(fn: () => void, deps: readonly unknown[], delayMs = 300): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const timer = window.setTimeout(() => ref.current(), delayMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delayMs]);
}
