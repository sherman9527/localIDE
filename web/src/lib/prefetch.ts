/**
 * 懒加载页面的预取（WI-28）。
 * 拆包让首屏不必等 CodeMirror，但"点进去才开始下载 700KB"会变成新的卡顿；
 * 首屏画完之后趁空闲把它们取回来，就把这笔开销挪到了用户还没要用的时候。
 */
const LOADERS: Record<string, () => Promise<unknown>> = {
  question: () => import('../pages/Question'),
  bank: () => import('../pages/Bank'),
  progress: () => import('../pages/Progress'),
};

/** 顺序有意义：判题页最大也最可能被点开。 */
const ORDER = ['question', 'bank', 'progress'] as const;

const settled = new Set<string>();

function start(name: string): void {
  if (settled.has(name)) return;
  settled.add(name);
  void LOADERS[name]?.().catch(() => settled.delete(name));
}

/** 浏览器没有 requestIdleCallback（jsdom / 老 Safari）时退到宏任务。 */
function whenIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: IdleRequestCallback) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(() => run());
  else setTimeout(run, 1);
}

export function prefetchLazyPages(): void {
  whenIdle(() => {
    for (const name of ORDER) start(name);
  });
}
