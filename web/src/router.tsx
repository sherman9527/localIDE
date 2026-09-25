import { useMemo, useSyncExternalStore } from 'react';

export type RouteName = 'today' | 'question' | 'bank' | 'progress' | 'ide' | 'unknown';

export interface Route {
  name: RouteName;
  path: string;
  query: URLSearchParams;
  questionId: string | null;
}

const DEFAULT_HASH = '#/';

function readHash(): string {
  return window.location.hash || DEFAULT_HASH;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function toHref(path: string): string {
  return path.startsWith('#') ? path : `#${path}`;
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const href = toHref(path);
  if (readHash() === href) return;
  if (opts.replace) window.location.replace(href);
  else window.location.hash = href.slice(1);
}

export function parseRoute(hash: string): Route {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const cut = raw.indexOf('?');
  const rawPath = cut === -1 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1));
  const path = rawPath.startsWith('/') ? rawPath : '/';

  const question = /^\/q\/(.+)$/.exec(path);
  if (question?.[1]) {
    return { name: 'question', path, query, questionId: decodeURIComponent(question[1]) };
  }
  if (path === '/bank') return { name: 'bank', path, query, questionId: null };
  if (path === '/progress') return { name: 'progress', path, query, questionId: null };
  if (path === '/ide') return { name: 'ide', path, query, questionId: null };
  if (path === '/' || path === '') return { name: 'today', path: '/', query, questionId: null };
  return { name: 'unknown', path, query, questionId: null };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, readHash, () => DEFAULT_HASH);
  return useMemo(() => parseRoute(hash), [hash]);
}

