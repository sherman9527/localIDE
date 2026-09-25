import type { JudgeCaseResult, JudgeErrorKind, JudgeEvent, JudgeResult } from '@arena/shared';

export function summarize(
  cases: readonly JudgeCaseResult[],
  durationMs: number,
  extra: Partial<JudgeResult> = {},
): JudgeResult {
  const failedCases = cases.filter((c) => !c.passed);
  const passedCases = cases.filter((c) => c.passed).map((c) => c.name);
  const status: JudgeResult['status'] = failedCases.length === 0 && cases.length > 0 ? 'pass' : 'fail';
  return {
    status,
    passed: passedCases.length,
    failed: failedCases.length,
    total: cases.length,
    failedCases,
    passedCases,
    durationMs,
    ...extra,
  };
}

export function errorResult(
  errorKind: JudgeErrorKind,
  logs: string,
  durationMs: number,
  timedOut = false,
): JudgeResult {
  return {
    status: 'error',
    passed: 0,
    failed: 0,
    total: 0,
    failedCases: [],
    passedCases: [],
    errorKind,
    logs,
    durationMs,
    timedOut,
  };
}

/** 判题进度上报：elapsedMs 让前端能显示"已用 Xs / 上限 Ys"。 */
export function progressReporter(startedAt: number, timeoutMs: number, onEvent?: (e: JudgeEvent) => void) {
  return (phase: 'compile' | 'run' | 'collect') => {
    onEvent?.({ type: 'progress', phase, elapsedMs: Date.now() - startedAt, timeoutMs });
  };
}

export function lineReporter(onEvent?: (e: JudgeEvent) => void) {
  return (line: string) => onEvent?.({ type: 'log', line });
}
