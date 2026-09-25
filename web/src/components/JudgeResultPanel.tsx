import { useState } from 'react';
import type { JudgeResult } from '@arena/shared';
import { ERROR_KIND_LABEL, formatValue, secs } from '../lib/format';

interface Props {
  result: JudgeResult;
}

/**
 * 用例级结果面板：先给结论（通过 N / 失败 M），再给失败用例名，
 * 展开才看期望 vs 实际；error 与 fail 明确分开。
 */
/** 展开状态按**用例身份**记，不按数组下标：换了一批用例时旧键自然对不上，也就不会套到新的行上。 */
const caseKey = (name: string | undefined, index: number): string => name || `#${index}`;

export default function JudgeResultPanel({ result }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isError = result.status === 'error';
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <section className="card result-card" data-testid="judge-result" aria-label="判题结果">
      <div className="card-head">
        <h3 className="card-title">判题结果</h3>
        <span className="spacer" />
        <span className="faint small">耗时 {secs(result.durationMs)}</span>
      </div>

      {isError ? (
        <div className="banner banner-danger" data-testid="run-error-banner" role="alert">
          <strong>运行失败（不是答案错误）</strong>
          <span>
            {result.errorKind ? ERROR_KIND_LABEL[result.errorKind] : '判题器没能完成这次运行'}
            {result.timedOut ? '（已超时）' : ''}，用例没有真正跑完，所以不算答案对错。
          </span>
          <span className="muted tiny">
            共 {result.total} 个用例：已通过 {result.passed} 个，未判定 {Math.max(result.total - result.passed, 0)} 个
          </span>
        </div>
      ) : (
        <p className={`verdict ${result.status === 'pass' ? 'verdict-pass' : 'verdict-fail'}`}>
          <span>
            通过 {result.passed} / 失败 {result.failed}
          </span>
          {result.status === 'pass' ? <span className="badge badge-success">全部用例通过</span> : null}
          {result.status === 'needs_human' ? <span className="badge badge-warning">需要人工确认</span> : null}
        </p>
      )}

      {result.logs ? <pre className="logs">{result.logs}</pre> : null}

      {result.failedCases.length > 0 ? (
        <div className="failed-cases">
          <h4 className="small muted">失败用例（{result.failedCases.length}）</h4>
          {result.failedCases.map((c, i) => (
            <div className="case-row" key={`${c.name}:${i}`}>
              <button
                type="button"
                className="case-head"
                data-testid={`expand-case-${i}`}
                aria-expanded={Boolean(open[caseKey(c.name, i)])}
                onClick={() => toggle(caseKey(c.name, i))}
              >
                <span className={`chev ${open[caseKey(c.name, i)] ? 'chev-open' : ''}`} aria-hidden="true">
                  ›
                </span>
                <span className="case-title">{c.name}</span>
                <span className="spacer" />
                <span className="badge badge-danger">未通过</span>
              </button>
              {open[caseKey(c.name, i)] ? (
                <dl className="case-detail" data-testid={`case-detail-${i}`}>
                  <dt>期望</dt>
                  <dd className="value-want">{formatValue(c.expected)}</dd>
                  <dt>实际</dt>
                  <dd className="value-got">{formatValue(c.actual)}</dd>
                  {c.message ? (
                    <>
                      <dt>说明</dt>
                      <dd>{c.message}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {result.passedCases.length > 0 ? (
        <div className="passed-cases">
          <h4 className="small muted">已通过（{result.passedCases.length}）</h4>
          <ul className="pass-list">
            {result.passedCases.map((name) => (
              <li key={name}>
                <span className="hit" aria-hidden="true">
                  ✓
                </span>{' '}
                {name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
