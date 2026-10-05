/**
 * 懒加载页面的预取（WI-28）。
 * 拆包让首屏不必等 CodeMirror，但"点进去才开始下载 700KB"会变成新的卡顿；
 * 首屏画完之后趁空闲把它们取回来，就把这笔开销挪到了用户还没要用的时候。
 */
const LOADERS: Record<string, () => Promise<unknown>> = {
  question: () => import('../pages/Question'),
  bank: () => import('../pages/Bank'),
  progress: () => import('../pages/Progress'),
  notebook: () => import('../pages/Notebook'),
};

/**
 * 顺序有意义：判题页最大也最可能被点开。
 * `ide` 不在这张表里 —— 它带着 CodeMirror 那一片（几百 KB），首屏画完之后趁空闲拉它
 * 会把带宽从"用户正在点的题"上抢走；notebook 那页只有一张状态卡，便宜到值得预取。
 */
const ORDER = ['question', 'bank', 'progress', 'notebook'] as const;

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
