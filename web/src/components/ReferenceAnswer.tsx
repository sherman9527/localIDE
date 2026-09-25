import { useState } from 'react';
import type { JudgeKind, Language, QuestionReference } from '@arena/shared';
import Markdown from './Markdown';
import { modeOf } from '../lib/format-source';

interface Props {
  /** 只用这两个字段定语言口径，`Question` 与 `PublicQuestion` 都能传进来 */
  question: { judgeKind: JudgeKind; language?: Language };
  reference: QuestionReference;
  /** 参考解的"复制到编辑器"落到答题区（与题面代码块同一个动作） */
  onCopyCode?: (text: string) => void;
}

/**
 * 参考答案面板（rule.md C7 于 2026-09-21 改为"答前可看"之后的唯一 UI 出口）。
 *
 * 默认收起：答案中位数 1484 字，摊开会把右栏的判题结果与提交历史挤到看不见的地方。
 * 参考解复用 Markdown 的代码块与"复制到编辑器"，而不是自己做一套 —— 两处的复制语义必须一样。
 */
export default function ReferenceAnswer({ question, reference, onCopyCode }: Props) {
  const [open, setOpen] = useState(false);
  const answer = reference.answer?.trim() ?? '';
  const solution = reference.solution?.trim() ?? '';
  // 什么都没留档就不摆一个点开是空的按钮
  if (!answer && !solution) return null;

  const language = modeOf(question).language;
  const source = [answer, solution ? `### 参考解\n\n\`\`\`${language}\n${solution}\n\`\`\`` : '']
    .filter(Boolean)
    .join('\n\n');

  return (
    <section className="card" data-testid="reference-answer" aria-label="参考答案">
      <div className="card-head">
        <h3 className="card-title">参考答案</h3>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          data-testid="toggle-reference"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open ? (
        <div data-testid="reference-body">
          <Markdown source={source} onCopyCode={onCopyCode} />
        </div>
      ) : (
        <p className="faint small">
          {answer ? '要点' : ''}
          {answer && solution ? ' + ' : ''}
          {solution ? '参考解' : ''}
          ，先自己写一遍再对照，收益最大。
        </p>
      )}
    </section>
  );
}
