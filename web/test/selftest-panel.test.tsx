// @vitest-environment jsdom
import './dom-shim';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelfTestPanel from '../src/components/SelfTestPanel';
import { api } from '../src/api';

vi.mock('../src/api', () => ({
  api: { judge: vi.fn() },
}));

const judgeMock = vi.mocked(api.judge);

const resultOf = (over: Record<string, unknown>) => ({
  status: 'fail',
  passed: 1,
  failed: 1,
  total: 2,
  failedCases: [{ name: '负数', passed: false, expected: 2, actual: -2 }],
  passedCases: ['正常'],
  durationMs: 1400,
  traceId: 'judge-abc123',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  judgeMock.mockReset();
});

afterEach(() => cleanup());

describe('自测面板', () => {
  it('把解析出的用例发给 /api/judge 的 customCases，并展示通过/失败与期望实际', async () => {
    judgeMock.mockResolvedValue({ result: resultOf({}) } as never);
    render(<SelfTestPanel questionId="alg-java-0001" getCode={() => 'code'} />);

    await act(async () => {
      fireEventInput('[1,2] => 3\n负数: -1 => 2');
      screen.getByTestId('selftest-run').click();
    });

    await waitFor(() => expect(judgeMock).toHaveBeenCalled());
    const body = judgeMock.mock.calls[0]![0] as unknown as { customCases: unknown[]; questionId: string };
    expect(body.questionId).toBe('alg-java-0001');
    expect(body.customCases).toEqual([
      { input: [[1, 2]], expected: 3 },
      { input: [-1], expected: 2, name: '负数' },
    ]);

    const panel = await screen.findByTestId('selftest-result');
    expect(panel.textContent).toContain('通过 1 / 失败 1');
    expect(panel.textContent).toContain('负数');
    expect(panel.textContent).toContain('期望 2');
    expect(panel.textContent).toContain('judge-abc123');
  });

  it('用例写错时不发请求，直接指出第几行', async () => {
    render(<SelfTestPanel questionId="alg-java-0002" getCode={() => 'code'} />);
    await act(async () => {
      fireEventInput('1 2 3');
      screen.getByTestId('selftest-run').click();
    });
    expect(judgeMock).not.toHaveBeenCalled();
    const errors = await screen.findByRole('alert');
    expect(errors.textContent).toContain('第 1 行');
    expect(errors.textContent).toContain('=>');
  });

  it('只编辑不落盘：必须点过运行自测才记住用例', async () => {
    const view = render(<SelfTestPanel questionId="alg-java-0003" getCode={() => 'x'} />);
    await act(async () => fireEventInput('[0] => 0'));
    expect(localStorage.getItem('arena.selftest.alg-java-0003')).toBeNull();
    view.unmount();
  });
});

/** 受控 textarea 赋值：走原生 setter + input 事件，绕开 React 的合成事件包装。 */
function fireEventInput(value: string): void {
  const el = screen.getByTestId('selftest-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
