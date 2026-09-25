// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AnswerInput from '../src/components/AnswerInput';
import { normalizeWhitespace } from '../src/lib/format-source';

const subjective = { judgeKind: 'llm-rubric', language: 'markdown' };
const codeQuestion = { judgeKind: 'mysql', language: 'sql' };
const noop = () => undefined;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('答题形态切换（文本/代码）', () => {
  it('主观题默认文本形态，切到代码后出现语言选择', () => {
    render(
      <AnswerInput
        questionId="sys-x-0001"
        question={subjective}
        value=""
        onChange={noop}
        onSubmit={noop}
        submitLabel="评分"
      />,
    );
    expect(screen.getByTestId('answer-textarea')).toBeTruthy();
    expect(screen.getByRole('button', { name: '文本 / Markdown' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    expect(screen.queryByTestId('answer-textarea')).toBeNull();
    expect((screen.getByLabelText('代码语言') as HTMLSelectElement).value).toBe('typescript');
  });

  it('形态与语言按题目 id 记住，重进还是上次那种', () => {
    const first = render(
      <AnswerInput
        questionId="sys-x-0002"
        question={subjective}
        value=""
        onChange={noop}
        onSubmit={noop}
        submitLabel="评分"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    fireEvent.change(screen.getByLabelText('代码语言'), { target: { value: 'sql' } });
    first.unmount();
    cleanup();

    render(
      <AnswerInput
        questionId="sys-x-0002"
        question={subjective}
        value=""
        onChange={noop}
        onSubmit={noop}
        submitLabel="评分"
      />,
    );
    expect(screen.queryByTestId('answer-textarea')).toBeNull();
    expect((screen.getByLabelText('代码语言') as HTMLSelectElement).value).toBe('sql');
  });

  it('代码题不允许切成纯文本（判题器只吃源码）', () => {
    render(
      <AnswerInput
        questionId="sql-x-0001"
        question={codeQuestion}
        value="select 1"
        onChange={noop}
        onSubmit={noop}
        submitLabel="运行用例"
        lockMode
      />,
    );
    expect((screen.getByRole('button', { name: '文本 / Markdown' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '代码' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('SQL 形态点"美化代码"会大写关键字并重排', async () => {
    let value = 'select a,b from t where a=1';
    const onChange = (next: string) => {
      value = next;
    };
    render(
      <AnswerInput
        questionId="sql-x-0002"
        question={codeQuestion}
        value={value}
        onChange={onChange}
        onSubmit={noop}
        submitLabel="运行用例"
        lockMode
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '美化代码' }));
    await waitFor(() => expect(value).toMatch(/SELECT/));
    expect(value).toMatch(/FROM/);
    expect(value.split('\n').length).toBeGreaterThan(1);
  });

  it('空白整理只动空白，不改语法结构', () => {
    const fixed = normalizeWhitespace('class A {   \n\n\n  int x;\t\n}');
    expect(fixed).not.toContain('\t');
    expect(fixed).not.toMatch(/[ \t]+\n/);
    expect(fixed).not.toMatch(/\n{3,}/);
    expect(fixed).toContain('int x;');
  });
});
