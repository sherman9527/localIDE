import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from 'react';
import type { RouteName } from './router';
import { toHref, useRoute } from './router';
import { Empty } from './components/AsyncState';
import Today from './pages/Today';
import { Loading } from './components/AsyncState';
import { prefetchLazyPages } from './lib/prefetch';

// 首屏只留"今日挑战"：判题页带 CodeMirror（最大的一块），题库/进度各自切一片（WI-28）
const Question = lazy(() => import('./pages/Question'));
const Bank = lazy(() => import('./pages/Bank'));
const Progress = lazy(() => import('./pages/Progress'));
const Ide = lazy(() => import('./pages/Ide'));

const PAGE_TITLE: Record<RouteName, string> = {
  today: '今日挑战',
  question: '答题',
  bank: '题库',
  progress: '进度',
  ide: '网页 IDE',
  unknown: '没这个页面',
};

const NAV: { href: string; label: string; name: RouteName }[] = [
  { href: '/', label: '今日挑战', name: 'today' },
  { href: '/bank', label: '题库', name: 'bank' },
  { href: '/progress', label: '进度', name: 'progress' },
  { href: '/ide', label: '网页 IDE', name: 'ide' },
];

export default function App() {
  const route = useRoute();
  const mainRef = useRef<HTMLElement | null>(null);
  const focusMain = useCallback(() => mainRef.current?.focus(), []);

  useEffect(() => {
    document.title = `${PAGE_TITLE[route.name]} · 每日刷题竞技场`;
  }, [route.name]);

  useEffect(() => {
    prefetchLazyPages();
  }, []);

  const categoryParam = route.name === 'bank' ? route.query.get('category') : null;
  const questionId = route.questionId;

  const content = useMemo(() => {
    switch (route.name) {
      case 'today':
        return <Today />;
      case 'question':
        return questionId ? (
          <Suspense fallback={<Loading label="正在加载答题界面…" cards={1} />}>
            <Question key={questionId} id={questionId} />
          </Suspense>
        ) : null;
      case 'bank':
        return (
          <Suspense fallback={<Loading label="正在加载题库…" cards={3} />}>
            <Bank key={categoryParam ?? 'all'} initialCategory={categoryParam} />
          </Suspense>
        );
      case 'progress':
        return (
          <Suspense fallback={<Loading label="正在加载进度…" cards={2} />}>
            <Progress />
          </Suspense>
        );
      case 'ide':
        return (
          <Suspense fallback={<Loading label="正在加载网页 IDE…" cards={1} />}>
            <Ide />
          </Suspense>
        );
      case 'unknown':
        return (
          <Empty
            title="没这个页面"
            hint="地址可能是手输错了。"
            action={
              <a className="btn btn-sm" href={toHref('/')}>
                回今日挑战
              </a>
            }
          />
        );
    }
  }, [route.name, questionId, categoryParam]);

  return (
    <div className="shell">
      <button type="button" className="skip-link" onClick={focusMain}>
        跳到主内容
      </button>
      <header className="topbar">
        <span className="brand">
          <span className="dot" aria-hidden="true" />
          每日刷题竞技场
        </span>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <a key={item.href} href={toHref(item.href)} aria-current={route.name === item.name ? 'page' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <span className="head-meta">本机 · 单人</span>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1}>
        {content}
      </main>
    </div>
  );
}
