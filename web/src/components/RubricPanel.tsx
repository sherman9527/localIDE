import { useMemo } from 'react';
import type { PublicRubric, RubricVerdict } from '@arena/shared';
import { PROVIDER_LABEL, secs } from '../lib/format';

interface Props {
  verdict: RubricVerdict;
  /** 评分后才拿到带权重的 rubric；没有就只显示得分。 */
  rubric?: PublicRubric;
  answer: string;
  /** 评分链路的追踪号：出问题时用它去 `npm run logs -- --trace <id>` 捞全链 */
  traceId?: string;
}

/**
 * 主观题反馈：总分 + 加分点 + 不足点 + 逐考点命中表（含"下一句该补什么"）。
 * 反馈密度就是这类题目的价值，所以逐项表默认展开。
 */
export default function RubricPanel({ verdict, rubric, answer, traceId }: Props) {
  const weightOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of rubric?.points ?? []) map.set(p.label, p.weight);
    return map;
  }, [rubric]);

  const isManual = verdict.provider === 'manual';

  return (
    <section className="card result-card" data-testid="rubric-panel" aria-label="评分结果">
      <div className="card-head">
        <h3 className="card-title">评分结果</h3>
        <span className="spacer" />
        <span className="faint small">耗时 {secs(verdict.durationMs)}</span>
        {traceId ? <span className="faint tiny" data-testid="grade-trace"> · trace {traceId}</span> : null}
      </div>

      <div className="row-wrap row">
        <span className="score-chip">
          {verdict.score}/{verdict.maxScore}
          <small>满分 {verdict.maxScore}</small>
        </span>
        <span className="badge badge-primary">
          {PROVIDER_LABEL[verdict.provider] ?? verdict.provider}
          {verdict.model ? ` · ${verdict.model}` : ''}
        </span>
      </div>

      {isManual ? (
        <div className="banner banner-warning" role="alert">
          <strong>本机评分 CLI 没给出可用结果，已降级为人工自检</strong>
          <span>按下面的考点逐条自查，勾上你确实写到的点。</span>
        </div>
      ) : null}

      {verdict.bonus.length > 0 ? (
        <div className="feedback">
          <h4 className="small muted">加分点</h4>
          <ul className="check-list">
            {verdict.bonus.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {verdict.gaps.length > 0 ? (
        <div className="feedback">
          <h4 className="small muted">不足点</h4>
          <ul className="gap-list">
            {verdict.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="table-scroll">
        <table data-testid="rubric-table">
          <thead>
            <tr>
              <th scope="col">考点</th>
              <th scope="col">判定</th>
              <th scope="col">得分</th>
              <th scope="col">下一句该补什么</th>
            </tr>
          </thead>
          <tbody>
            {verdict.rubricBreakdown.map((point) => (
              <tr key={point.label}>
                <th scope="row">{point.label}</th>
                <td className={point.hit ? 'hit' : 'miss'}>{point.hit ? '命中' : '未命中'}</td>
                <td className="mono">
                  {point.earned}/
                  {weightOf.get(point.label) ?? '?'}
                </td>
                <td>{point.nextStep ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="answer-echo">
        <summary className="small muted">回看我的作答（{answer.trim().length} 字）</summary>
        <pre className="logs">{answer}</pre>
      </details>
    </section>
  );
}
