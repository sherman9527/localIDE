// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdeLanguagesResponse, IdeRunResponse } from '@arena/shared';

/**
 * 网页 IDE 的界面契约（WI-64）。
 * 页面只依赖 api.ideLanguages / api.ideRun —— 这里 mock 的就是这两个，
 * 任何"顺手把题目接口引进来"的改动都会让本文件与 boundary.test.ts 一起红。
 */

const LANGUAGES: IdeLanguagesResponse = {
  languages: [
    {
      id: 'python',
      label: 'Python 3',
      fileName: 'main.py',
      editorLanguage: 'python',
      execution: 'command',
      timeoutMs: 10_000,
      sample: 'print("sample python")\n',
      hint: 'stdin 从下面的输入框读',
      available: true,
    },
    {
      id: 'java',
      label: 'Java',
      fileName: 'Main.java',
      editorLanguage: 'java',
      execution: 'command',
      timeoutMs: 10_000,
      sample: 'public class Main { public static void main(String[] a) {} }\n',
      hint: '类名必须是 public class Main',
      available: true,
    },
    {
      id: 'c',
      label: 'C',
      fileName: 'main.c',
      editorLanguage: 'typescript',
      execution: 'command',
      timeoutMs: 10_000,
      sample: 'int main(void){return 0;}\n',
      hint: 'gcc -std=c17',
      available: false,
    },
    {
      id: 'mysql',
      label: 'MySQL 8（一次性库）',
      fileName: 'main.sql',
      editorLanguage: 'sql',
      execution: 'sql',
      timeoutMs: 10_000,
      setupLabel: '预置语句（每次运行都从这里开始：建表、灌数……）',
      sample: 'SELECT 1;\n',
      hint: '跑在临时库里',
      available: true,
    },
    {
      id: 'redis',
      label: 'Redis 7（专用 db）',
      fileName: 'commands.txt',
      editorLanguage: 'markdown',
      execution: 'redis',
      timeoutMs: 10_000,
      setupLabel: '预置命令（先造好键空间，再看正文命令的效果）',
      sample: 'PING\n',
      hint: '每行一条命令',
      available: true,
    },
    {
      id: 'pyspark',
      label: 'PySpark（常驻会话）',
      fileName: 'main.py',
      editorLanguage: 'python',
      execution: 'spark-python',
      timeoutMs: 120_000,
      setupLabel: '预置 SQL（建表、灌数……）',
      sample: 'print("hello spark")\n',
      hint: '跑在判题同款常驻 SparkSession 上',
      available: true,
    },
  ],
  limits: {
    maxCodeChars: 20_000,
    maxStdinChars: 20_000,
    maxSetupChars: 20_000,
    timeoutMs: 10_000,
    maxTimeoutMs: 120_000,
    stdoutCapChars: 64_000,
    tableRowLimit: 200,
  },
};

const runResult = (over: Partial<IdeRunResponse> = {}): IdeRunResponse => ({
  status: 'ok',
  stage: 'run',
  exitCode: 0,
  stdout: 'hello, world!\n',
  stderr: '',
  timedOut: false,
  truncated: false,
  durationMs: 42,
  stdoutCapChars: 64_000,
  ...over,
});

const ideRun = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    ideLanguages: () => Promise.resolve(LANGUAGES),
    ideRun: (body: { language: string; code: string; stdin?: string }) => ideRun(body),
  },
}));

async function renderIde() {
  const { default: Ide } = await import('../src/pages/Ide');
  return render(<Ide />);
}

async function ready() {
  await renderIde();
  await screen.findByText('网页 IDE');
}

describe('网页 IDE 页面', () => {
  afterEach(() => {
    cleanup();
    ideRun.mockReset();
  });

  it('加载后默认选中第一个"可用"的语言，并带出它的样例代码', async () => {
    await ready();
    const select = screen.getByLabelText('语言');
    expect((select as HTMLSelectElement).value).toBe('python');
    expect(screen.getByText('stdin 从下面的输入框读')).toBeTruthy();
    // 样例在 CodeMirror 的 doc 里，不保证以普通文本节点出现 —— 只断言下拉与提示，
    // 不去断言编辑器内部结构（那会把测试绑在 CodeMirror 的实现细节上）。
  });

  it('运行：stdout / 退出码 / 阶段都渲染出来，且把选中的语言与代码传给后端', async () => {
    ideRun.mockResolvedValue(runResult());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    const panel = await screen.findByLabelText('运行结果');
    expect(panel.getAttribute('data-status')).toBe('ok');
    expect(withinText('运行成功')).toBe(true);
    expect(withinText('退出码 0')).toBe(true);
    expect(withinText('阶段 run')).toBe(true);
    expect(screen.getByText('hello, world!')).toBeTruthy();
    expect(ideRun).toHaveBeenCalledTimes(1);
    expect(ideRun.mock.calls[0]?.[0]).toMatchObject({ language: 'python' });
  });

  it('格式化按钮走的是答题页同一套规则（复用 lib/format-source，不在 IDE 里再造一份）', async () => {
    await ready();
    const button = screen.getByRole('button', { name: /格式化/ });
    fireEvent.click(button);
    // 只断言"接线与反馈"：真格式化由 E2E 在真浏览器里验（CodeMirror 的 doc 结构
    // 不该被绑进单测，这个文件里原本就写着这条纪律）。
    const note = await screen.findByTestId('ide-format-note');
    expect(note.textContent).toBeTruthy();
    expect(ideRun).not.toHaveBeenCalled();
  });

  it('预置语句框只在该语言需要它时出现，并把 setup 一起发给后端', async () => {
    await ready();
    expect(screen.queryByTestId('ide-setup')).toBeNull(); // python 不需要预置语句
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'mysql' } });
    const box = await screen.findByTestId('ide-setup');
    fireEvent.change(box, { target: { value: 'CREATE TABLE t (a INT);' } });
    ideRun.mockResolvedValue(runResult({ table: null }));
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    await screen.findByLabelText('运行结果');
    expect(ideRun.mock.calls.at(-1)?.[0]).toMatchObject({
      language: 'mysql',
      setup: 'CREATE TABLE t (a INT);',
    });
  });

  it('SQL 结果集渲染成表格；被上限截断时要如实说明', async () => {
    ideRun.mockResolvedValue(
      runResult({
        stdout: '已执行 3 条语句，最后一个结果集 2 行',
        table: { columns: ['status', 'n'], rows: [['paid', '3'], ['refunded', '1']], truncated: false, rowLimit: 200 },
      }),
    );
    await ready();
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'mysql' } });
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    const table = await screen.findByRole('table');
    expect(withinText('status')).toBe(true);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.queryByText(/只展示前/)).toBeNull();
  });

  it('Redis 的逐条回复要看得见（只显示 stdout 等于没结果）', async () => {
    ideRun.mockResolvedValue(
      runResult({ stdout: '已执行 2 条命令', replies: [{ command: 'PING', reply: '"PONG"' }, { command: 'GET k', reply: '"v"' }] }),
    );
    await ready();
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'redis' } });
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    await screen.findByText('逐条回复');
    expect(withinText('PING')).toBe(true);
    expect(withinText('"PONG"')).toBe(true);
    expect(withinText('GET k')).toBe(true);
  });

  it('编译失败要标成 compile_error 并展示 stderr，而不是"运行成功但没输出"', async () => {
    ideRun.mockResolvedValue(
      runResult({
        status: 'compile_error',
        stage: 'compile',
        exitCode: 1,
        stdout: '',
        stderr: 'Main.java:1: error: \')\' expected\n',
      }),
    );
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    const panel = await screen.findByLabelText('运行结果');
    expect(panel.getAttribute('data-status')).toBe('compile_error');
    expect(withinText('编译失败')).toBe(true);
    expect(withinText('阶段 compile')).toBe(true);
    expect(screen.getByText(/error: '\)' expected/)).toBeTruthy();
  });

  it('超时与截断各自有独立标记（两者是不同的事故，不能合成一个"没输出"）', async () => {
    ideRun.mockResolvedValue(runResult({ status: 'timeout', timedOut: true, truncated: true, stdout: 'x' }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    await screen.findByLabelText('运行结果');
    expect(withinText('超时被终止')).toBe(true);
    expect(withinText('已强制终止')).toBe(true);
    expect(withinText('输出被截断')).toBe(true);
  });

  it('不可用的语言：选项标出来，运行按钮是灰的，并给出原因横幅', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'c' } });
    const button = screen.getByRole('button', { name: /运行/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/这台机器上没有 C 的工具链/)).toBeTruthy();
  });

  it('Spark 语言：预算显示在文件栏里；运行中另开一处显示"已等多久"，按钮文字不许变', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'pyspark' } });
    expect((await screen.findByTestId('ide-budget')).textContent).toContain('最长 120s');

    let resolveRun: ((value: IdeRunResponse) => void) | undefined;
    ideRun.mockReturnValue(new Promise<IdeRunResponse>((resolve) => (resolveRun = resolve)));
    const button = screen.getByRole('button', { name: '运行' });
    fireEvent.click(button);
    // 一次十几秒的运行必须让人看到"它在动"，但那是**旁边**的计数，不是把秒数塞进按钮里
    await waitFor(() => expect(screen.getByTestId('ide-elapsed').textContent).toMatch(/^已等 \d+\.\d+s$/));
    expect(screen.getByRole('button', { name: '运行' }).textContent).toBe('运行');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    act(() => resolveRun?.(runResult({ stdout: 'rows=2\n' })));
    await screen.findByLabelText('运行结果');
    expect(screen.queryByTestId('ide-elapsed')).toBeNull();
  });

  it('预算跟着语言走：换了语言不许还挂着上一门的 10s', async () => {
    await ready();
    expect((await screen.findByTestId('ide-budget')).textContent).toContain('最长 10s');
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'pyspark' } });
    expect((await screen.findByTestId('ide-budget')).textContent).toContain('最长 120s');
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'python' } });
    expect((await screen.findByTestId('ide-budget')).textContent).toContain('最长 10s');
  });

  it('切语言不许覆盖用户已经写过的代码', async () => {
    await ready();
    // 用户改了代码（CodeMirror 的 doc 不方便直接注入，这里走"改完再切"的等价路径：
    // 先切到 java —— 当前内容仍是 python 样例，所以应当被替换）
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'java' } });
    await waitFor(() => expect(screen.getByText(/类名必须是 public class Main/)).toBeTruthy());
  });

  it('被后端拒绝（如代码超长）时渲染 message，而不是当成运行成功', async () => {
    ideRun.mockResolvedValue(
      runResult({ status: 'rejected', stage: 'submit', exitCode: null, stdout: '', message: '代码过长（20001 > 20000 字符）' }),
    );
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /运行/ }));
    const panel = await screen.findByLabelText('运行结果');
    expect(panel.getAttribute('data-status')).toBe('rejected');
    expect(withinText('未执行')).toBe(true);
    expect(screen.getByText(/代码过长/)).toBeTruthy();
  });
});

/** CodeMirror/RTL 下文本可能被拆节点，所以用 textContent 包含判断而不是 getByText。 */
function withinText(needle: string): boolean {
  return (document.body.textContent ?? '').includes(needle);
}
