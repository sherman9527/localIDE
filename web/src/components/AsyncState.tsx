import type { ReactNode } from 'react';

export function Loading({ label = '加载中', cards = 3 }: { label?: string; cards?: number }) {
  return (
    <div data-testid="state-loading" role="status" aria-live="polite" aria-busy="true">
      <p className="muted small">{label}</p>
      <div className="col">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state" data-testid="state-empty">
      <strong>{title}</strong>
      {hint ? <span className="small">{hint}</span> : null}
      {action ?? null}
    </div>
  );
}

export function ErrorState({ title, reason, onRetry }: { title: string; reason?: string; onRetry?: () => void }) {
  return (
    <div className="state" data-testid="state-error" role="alert">
      <strong>{title}</strong>
      {reason ? <span className="small">{reason}</span> : null}
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  tone = 'plain',
  testId,
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'primary' | 'success' | 'danger' | 'warning';
  testId?: string;
  title?: string;
}) {
  const cls = tone === 'plain' ? 'badge' : `badge badge-${tone}`;
  return (
    <span className={cls} data-testid={testId} title={title}>
      {children}
    </span>
  );
}
