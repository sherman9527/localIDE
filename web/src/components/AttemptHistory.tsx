import { useEffect, useState } from 'react';
import type { AttemptDetail, AttemptHistoryEntry } from '@arena/shared';
import { api } from '../api';
import { useAsync } from '../lib/hooks';
import { ERROR_KIND_LABEL, formatValue, secs } from '../lib/format';

interface Props {
  questionId: string;
  /** 每提交一次 +1：历史是提交后才变的东西，靠它触发重取 */
  bump?: number;
}

/** 一次提交挂在哪，用一句话说清（复盘时的扫读层）。 */
function headline(entry: AttemptHistoryEntry): string {
  if (entry.kind === 'grade') {
    return entry.score === null ? '这次没拿到评分' : `评分 ${entry.score}/${entry.maxScore ?? '?'}`;
  }
  return `通过 ${entry.passed} / 失败 ${entry.failed}`;
}

function StatusBadge({ entry }: { entry: AttemptHistoryEntry }) {
  if (entry.status === 'pass') return <span className="badge badge-success">通过</span>;
  if (entry.status === 'error') return <span className="badge badge-warning">运行失败</span>;
  if (entry.status === 'needs_human') return <span className="badge badge-warning">待人工</span>;
  return <span className="badge badge-danger">未通过</span>;
}

/** 留档内容：代码题给逐用例，主观题给评分点；两者都带当时的正文。 */
function DetailBody({ detail }: { detail: AttemptDetail }) {
  return (
    <div className="attempt-detail">
      {detail.kind === 'judge' ? (
        <>
          {detail.errorKind ? <p className="small muted">失败类型：{ERROR_KIND_LABEL[detail.errorKind]}</p> : null}
          {detail.failedCases?.length ? (
            <ul className="failed-list">
              {detail.failedCases.map((c, i) => (
                <li key={`${c.name}:${i}`}>
                  <strong>{c.name}</strong>
                  {c.expected !== undefined || c.actual !== undefined ? (
                    <span className="muted">
                      {' '}
                      期望 {formatValue(c.expected)} ｜ 实际 {formatValue(c.actual)}
                    </span>
                  ) : null}
                  {c.message ? <span className="tiny faint"> {c.message}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            // 编译/沙箱类失败本来就没有用例可挂，再补一句"没有失败用例"像是自相矛盾
            detail.errorKind ? null : <p className="small muted">这次没有失败用例</p>
          )}
          {detail.passedCaseNames?.length ? (
            <p className="tiny faint">已通过：{detail.passedCaseNames.join('、')}</p>
          ) : null}
          {detail.logs ? <pre className="logs">{detail.logs}</pre> : null}
        </>
      ) : (
        <>
          {detail.rubric?.length ? (
            <ul className="rubric-list">
              {detail.rubric.map((point, i) => (
                <li key={`${point.label}:${i}`}>
                  <span className={point.hit ? 'hit' : 'miss'} aria-hidden="true">
                    {point.hit ? '✓' : '✗'}
                  </span>{' '}
                  <strong>{point.label}</strong>
                  <span className="muted"> +{point.earned}</span>
                  {point.nextStep ? <span className="tiny faint"> 下一步：{point.nextStep}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {detail.gaps?.length ? <p className="small">不足：{detail.gaps.join('；')}</p> : null}
          {detail.bonus?.length ? <p className="tiny faint">加分：{detail.bonus.join('；')}</p> : null}
        </>
      )}
      {detail.submission ? (
        <div className="attempt-submission">
          <h4 className="small muted">
            当时的提交
            {detail.submissionChars ? <span className="faint tiny">（正文已截断，原长 {detail.submissionChars} 字）</span> : null}
          </h4>
          <pre className="logs">{detail.submission}</pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 判题历史（N-05）：把"我上次挂在哪个用例、当时写了什么"留在页面上，
 * 而不是只留一个通过/未通过。默认一屏结论，展开才看期望与实际。
 */
export default function AttemptHistory({ questionId, bump = 0 }: Props) {
  const { data, loading, error } = useAsync((signal) => api.attempts(questionId, { signal }), [questionId, bump], '提交历史');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const entries: AttemptHistoryEntry[] = data?.attempts ?? [];

  // 换题或重新拉取后收起展开项，下标才不会错位
  useEffect(() => {
    setOpen({});
  }, [questionId, bump]);

  if (error) {
    return (
      <section className="card" data-testid="attempt-history-error">
        <p className="muted small">提交历史没读到：{error}</p>
      </section>
    );
  }
  if (!data && loading) return null;
  if (!entries.length) {
    return (
      <section className="card" data-testid="attempt-history-empty">
        <div className="card-head">
          <h3 className="card-title">提交历史</h3>
        </div>
        <p className="muted small">还没有提交记录。提交一次之后，这里会留下每次挂在哪个用例、当时写了什么。</p>
      </section>
    );
  }

  return (
    <section className="card" data-testid="attempt-history" aria-label="提交历史">
      <div className="card-head">
        <h3 className="card-title">提交历史</h3>
        <span className="spacer" />
        <span className="faint small">近 {entries.length} 次</span>
      </div>
      {entries.map((entry, i) => (
        <div className="attempt-row" key={entry.id} data-testid="attempt-row" data-attempt-id={entry.id}>
          <button
            type="button"
            className="case-head"
            data-testid="expand-attempt"
            aria-expanded={Boolean(open[i])}
            onClick={() => setOpen((prev) => ({ ...prev, [i]: !prev[i] }))}
          >
            <span className={`chev ${open[i] ? 'chev-open' : ''}`} aria-hidden="true">
              ›
            </span>
            <span className="case-title">{entry.day}</span>
            <span className="muted small">{headline(entry)}</span>
            {/* 用例名摘要只在收起时给；展开后下面就是逐用例明细，别再复述一遍 */}
            {!open[i] && entry.detail?.failedCases?.length ? (
              <span className="tiny faint" data-testid="failed-summary">
                挂在「{entry.detail.failedCases.map((c) => c.name).join('、')}」
              </span>
            ) : null}
            <span className="spacer" />
            <StatusBadge entry={entry} />
          </button>
          {open[i] ? (
            <div data-testid="attempt-detail">
              {entry.detail ? (
                <DetailBody detail={entry.detail} />
              ) : (
                <p className="muted small">这条没有留档：那时还没开始存逐用例结果，只能看到通过情况。</p>
              )}
              <p className="tiny faint">耗时 {secs(entry.durationMs)}</p>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
