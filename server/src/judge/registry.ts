import { type JudgeEvent, type JudgeKind, type JudgeRequest, type JudgeResult, type Question, type Runner } from '@arena/shared';

import { errorFields, logError, logInfo, logWarn, newTraceId } from '../log.js';

const runners = new Map<JudgeKind, Runner>();

export function registerRunner(runner: Runner): void {
  runners.set(runner.kind, runner);
}

export function registeredKinds(): JudgeKind[] {
  return [...runners.keys()];
}

function result(partial: Partial<JudgeResult> & Pick<JudgeResult, 'status'>): JudgeResult {
  return {
    passed: 0,
    failed: 0,
    total: 0,
    failedCases: [],
    passedCases: [],
    durationMs: 0,
    ...partial,
  } as JudgeResult;
}

export async function runJudge(
  request: JudgeRequest,
  question: Question,
  onEvent?: (event: JudgeEvent) => void,
): Promise<JudgeResult> {
  const traceId = request.traceId ?? newTraceId('judge');
  const started = Date.now();
  const runner = runners.get(question.judgeKind);
  if (!runner) {
    logWarn('judge', 'runner.missing', { traceId, questionId: question.id, kind: question.judgeKind });
    return result({
      status: 'error',
      errorKind: 'unavailable',
      traceId,
      logs: `没有注册 ${question.judgeKind} 判题器；已注册：${registeredKinds().join(', ') || '(无)'}`,
    });
  }
  logInfo('judge', 'start', {
    traceId,
    questionId: question.id,
    kind: question.judgeKind,
    submissionChars: request.submission.length,
  });
  onEvent?.({ type: 'queued', questionId: question.id });
  try {
    const ran = await runner.run({ ...request, traceId }, question, onEvent);
    const record: JudgeResult = { ...ran, traceId: ran.traceId ?? traceId };
    const emit = record.status === 'error' ? logError : record.status === 'pass' ? logInfo : logWarn;
    emit('judge', 'done', {
      traceId,
      questionId: question.id,
      kind: question.judgeKind,
      status: record.status,
      errorKind: record.errorKind,
      passed: record.passed,
      failed: record.failed,
      total: record.total,
      ms: Date.now() - started,
    });
    return record;
  } catch (err) {
    logError('judge', 'crashed', {
      traceId,
      questionId: question.id,
      kind: question.judgeKind,
      ms: Date.now() - started,
      ...errorFields(err),
    });
    return result({
      status: 'error',
      errorKind: 'sandbox',
      traceId,
      logs: `判题器内部异常：${(err as Error).stack ?? String(err)}`,
    });
  }
}

export async function probeStacks(): Promise<Record<string, boolean>> {
  const kinds = registeredKinds();
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      const runner = runners.get(kind) as Runner;
      let ok = false;
      try {
        ok = await runner.probe();
      } catch {
        ok = false;
      }
      return [kind, ok] as const;
    }),
  );
  return Object.fromEntries(entries);
}
