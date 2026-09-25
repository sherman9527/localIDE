import { memo } from 'react';
import type { PublicQuestion } from '@arena/shared';
import { formatValue } from '../lib/format';

type Case = NonNullable<PublicQuestion['cases']>[number];

/**
 * 结果导向的题目必须在提交前就把用例摆全（需求场景 4）：
 * 名字 / 输入 / 期望 三列，答错时只提示哪个没通过。
 */
const CaseTable = memo(function CaseTable({ cases }: { cases: Case[] }) {
  if (cases.length === 0) return null;
  return (
    <section className="card" data-testid="case-table" aria-label="测试用例">
      <div className="card-head">
        <h3 className="card-title">用例</h3>
        <span className="badge">{cases.length} 个</span>
        <span className="spacer" />
        <span className="faint small">提交前全部可见，判题只看结果</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">用例</th>
              <th scope="col">输入</th>
              <th scope="col">期望</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.name} data-testid={`case-row-${c.name}`}>
                <th scope="row" className="case-name">
                  {c.visible === false ? <span className="muted">{c.name}（隐藏）</span> : c.name}
                </th>
                <td className="mono">{c.visible === false ? '—' : formatValue(c.input)}</td>
                <td className="mono">{c.visible === false ? '—' : formatValue(c.expected)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
});

export default CaseTable;
