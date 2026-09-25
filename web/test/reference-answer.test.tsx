// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@arena/shared';
import ReferenceAnswer from '../src/components/ReferenceAnswer';

const question = (over: Partial<Question> = {}): Question =>
  ({
    id: 'alg-java-0001',
    judgeKind: 'java-junit',
    language: 'java',
    ...over,
  }) as Question;

const SOLUTION = 'class Solution { public static int solve(int[] a) { return a.length; } }';

describe('参考答案面板（答前可看，rule.md C7 的唯一 UI 出口）', () => {
  afterEach(cleanup);

  it('默认收起：标题在，正文不在 DOM 里', () => {
    render(<ReferenceAnswer question={question()} reference={{ answer: '单遍扫描要点', solution: SOLUTION }} />);
    expect(screen.getByText('参考答案')).toBeTruthy();
    expect(screen.queryByText(/单遍扫描要点/)).toBeNull();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('展开后既给要点也给参考解代码块', () => {
    render(<ReferenceAnswer question={question()} reference={{ answer: '单遍扫描要点', solution: SOLUTION }} />);
    fireEvent.click(screen.getByTestId('toggle-reference'));
    expect(within(screen.getByTestId('reference-body')).getByText(/单遍扫描要点/)).toBeTruthy();
    expect(screen.getByTestId('reference-body').textContent).toContain('class Solution');
  });

  it('参考解能一键复制进答题区（复盘的正确用法是抄进编辑器自己改，不是抄屏幕）', () => {
    const onCopyCode = vi.fn();
    render(<ReferenceAnswer question={question()} reference={{ solution: SOLUTION }} onCopyCode={onCopyCode} />);
    fireEvent.click(screen.getByTestId('toggle-reference'));
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '复制到编辑器');
    expect(btn, '参考解要复用 Markdown 的复制按钮').toBeTruthy();
    fireEvent.click(btn as HTMLButtonElement);
    expect(onCopyCode).toHaveBeenCalledWith(SOLUTION);
  });

  it('主观题没有参考解就不提"参考解"这三个字', () => {
    render(
      <ReferenceAnswer
        question={question({ judgeKind: 'llm-rubric', language: 'markdown' })}
        reference={{ answer: '先证明瓶颈假设' }}
      />,
    );
    fireEvent.click(screen.getByTestId('toggle-reference'));
    expect(screen.getByTestId('reference-body').textContent).toContain('先证明瓶颈假设');
    expect(screen.getByTestId('reference-body').textContent).not.toContain('参考解');
  });

  it('这题什么都没留档时整块不出现（不摆一个点开是空的按钮）', () => {
    const { container } = render(<ReferenceAnswer question={question()} reference={{}} />);
    expect(container.textContent).toBe('');
  });

  it('只有要点、没有参考解（老库里代码题也可能没写 solution）', () => {
    render(<ReferenceAnswer question={question()} reference={{ answer: '只有要点' }} />);
    fireEvent.click(screen.getByTestId('toggle-reference'));
    expect(screen.getByTestId('reference-body').textContent).toContain('只有要点');
    expect(document.querySelector('pre')).toBeNull();
  });
});
