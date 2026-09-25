import { PHASE_LABEL, secs, secsShort } from '../lib/format';

type Phase = 'compile' | 'run' | 'collect';

export interface RunningState {
  phase: Phase | null;
  elapsedMs: number;
  timeoutMs: number;
  logs: string[];
}

export const idleRunning: RunningState = { phase: null, elapsedMs: 0, timeoutMs: 20000, logs: [] };

/**
 * 判题期间的反馈面板：阶段 + 已用/上限 + 滚动日志。
 * 更新只发生在这一小块，高度固定，不会把编辑器顶下去。
 */
export default function RunningPanel({ phase, elapsedMs, timeoutMs, logs }: RunningState) {
  return (
    <section className="run-panel" data-testid="judge-running" role="status" aria-live="polite">
      <div className="run-head">
        <span className="spinner" aria-hidden="true" />
        <strong>{phase ? PHASE_LABEL[phase] : '判题中'}</strong>
        <span className="muted">
          已用 {secs(elapsedMs)} / 上限 {secsShort(timeoutMs)}
        </span>
      </div>
      <ul className="run-log" aria-label="判题日志">
        {logs.length === 0 ? <li>等待判题器输出…</li> : logs.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </section>
  );
}
