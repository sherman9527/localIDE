// @vitest-environment jsdom
import './dom-shim';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdeEnvInventory, IdeEnvResponse } from '@arena/shared';

/**
 * IDE 的依赖环境面板。
 *
 * 这里最要紧的不是"能不能列出包"，而是**界面不许说假话**：
 * ① "判题器看不到这些包"必须常驻 —— 这道缝不该等用户交题撞了才发现；
 * ② 不支持的语言要给理由，不能给一个装了没用的输入框；
 * ③ 装坏了（声明与实装不一致）要把不一致显示出来，不许吞；
 * ④ 流被截断、没收到结束标记时，要明说"完成与否未知"，而不是安静地当成功。
 */

const envGet = vi.fn();
const envCommand = vi.fn();
const envReset = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    ideEnv: () => envGet(),
    ideEnvCommand: (body: unknown, onEvent?: (e: unknown) => void) => envCommand(body, onEvent),
    ideEnvReset: (body: unknown) => envReset(body),
  },
}));

import IdeEnvPanel from '../src/components/IdeEnvPanel';

const inv = (over: Partial<IdeEnvInventory>): IdeEnvInventory => ({
  language: 'python',
  supported: true,
  packages: [],
  totalBytes: 0,
  drift: [],
  note: '这些包只影响 IDE 的运行 / REPL / 调试；判题器看不到它们。',
  ...over,
});

const response = (inventories: IdeEnvInventory[]): IdeEnvResponse => ({ inventories });
const LABELS = { python: 'Python 3', javascript: 'JavaScript', c: 'C' };

const byTestId = (id: string): HTMLElement | null => screen.queryByTestId(id);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IdeEnvPanel', () => {
  it('列出用户自装的包，并常驻"判题器看不到"这句话', async () => {
    envGet.mockResolvedValue(
      response([inv({ packages: [{ name: 'requests', version: '2.31.0', sizeBytes: 2048 }], totalBytes: 2048 })]),
    );
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-list')).toBeTruthy());
    const text = byTestId('ide-env-list')?.textContent ?? '';
    expect(text).toContain('requests');
    expect(text).toContain('2.31.0');
    expect(screen.getByText(/判题器看不到/)).toBeTruthy();
  });

  it('不支持的语言显示原因，且不出现命令输入框与重置（给了就是让人白装）', async () => {
    envGet.mockResolvedValue(
      response([inv({ language: 'c', supported: false, reason: 'C 的依赖只能靠镜像预装（apt），运行期装不了' })]),
    );
    render(<IdeEnvPanel activeLanguage="c" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-unsupported')).toBeTruthy());
    expect(byTestId('ide-env-unsupported')?.textContent).toContain('apt');
    expect(byTestId('ide-env-command')).toBeNull();
    expect(byTestId('ide-env-reset')).toBeNull();
  });

  it('声明与实装不一致时把 drift 显示出来，不许静默', async () => {
    envGet.mockResolvedValue(response([inv({ packages: [], drift: ['left-pad'] })]));
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-drift')).toBeTruthy());
    expect(byTestId('ide-env-drift')?.textContent).toContain('left-pad');
  });

  it('执行按钮把输入按空白拆成 argv 交给后端（前端不猜包名，也不拼 shell）', async () => {
    envGet.mockResolvedValue(response([inv({})]));
    envCommand.mockImplementation(async (_body: unknown, onEvent?: (e: { type: string; text: string }) => void) => {
      onEvent?.({ type: 'output', text: 'Successfully installed requests-2.31.0\n' });
      return { status: 'ok', code: 0 };
    });
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-command')).toBeTruthy());

    fireEvent.change(byTestId('ide-env-command')!, { target: { value: 'pip3 install requests==2.31' } });
    fireEvent.click(byTestId('ide-env-run')!);

    await waitFor(() => expect(envCommand).toHaveBeenCalledTimes(1));
    expect(envCommand.mock.calls[0]?.[0]).toEqual({ language: 'python', argv: ['pip3', 'install', 'requests==2.31'] });
    await waitFor(() => expect(byTestId('ide-env-log')?.textContent).toContain('Successfully installed'));
  });

  it('没收到结束标记时明说"完成与否未知"，不安静当成功', async () => {
    envGet.mockResolvedValue(response([inv({})]));
    envCommand.mockResolvedValue(null); // 流被截断
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-command')).toBeTruthy());
    fireEvent.change(byTestId('ide-env-command')!, { target: { value: 'pip3 install rich' } });
    fireEvent.click(byTestId('ide-env-run')!);
    await waitFor(() => expect(byTestId('ide-env-log')?.textContent).toContain('未知'));
  });

  it('执行期间输入框与按钮禁用（两个 pip 并发写同一目录会装坏）', async () => {
    envGet.mockResolvedValue(response([inv({})]));
    let release!: () => void;
    envCommand.mockReturnValue(
      new Promise((r) => {
        release = () => r({ status: 'ok', code: 0 });
      }),
    );
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-command')).toBeTruthy());
    fireEvent.change(byTestId('ide-env-command')!, { target: { value: 'pip3 install rich' } });
    fireEvent.click(byTestId('ide-env-run')!);
    await waitFor(() => expect((byTestId('ide-env-command') as HTMLInputElement).disabled).toBe(true));
    expect((byTestId('ide-env-run') as HTMLButtonElement).disabled).toBe(true);
    release();
  });

  it('重置要二次确认，并报告释放了多少、关了几个会话', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    envGet.mockResolvedValue(response([inv({ totalBytes: 5_000_000 })]));
    envReset.mockResolvedValue({ ok: true, removedBytes: 5_000_000, stoppedSessions: 2, inventories: [] });
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-reset')).toBeTruthy());
    fireEvent.click(byTestId('ide-env-reset')!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(byTestId('ide-env-log')?.textContent).toContain('作废 2 个'));
    confirmSpy.mockRestore();
  });

  it('用户取消二次确认时不发请求（重置会删掉他装的所有包）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    envGet.mockResolvedValue(response([inv({})]));
    render(<IdeEnvPanel activeLanguage="python" languageLabels={LABELS} />);
    await waitFor(() => expect(byTestId('ide-env-reset')).toBeTruthy());
    fireEvent.click(byTestId('ide-env-reset')!);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(envReset).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
