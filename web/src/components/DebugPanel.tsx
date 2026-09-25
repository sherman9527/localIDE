import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebugAction, DebugEvent, DebugVar } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';

/**
 * IDE 的调试面板（WI-81）。
 *
 * 三条不是顺手写的：
 * 1. **会话是活进程，名额只有 1 个** —— 卸载、关标签页都必须真的关掉，
 *    漏一次就是"以后每次调试都说名额已满"，而界面上没有任何可关的东西（REPL 那边踩过）。
 * 2. **代码一改，会话立刻作废**。停在第 5 行的会话，用户删掉两行再按"继续"，
 *    拿到的行号指的是另一句话 —— 那比报错更糟，是骗人。
 * 3. 停在哪一行由父组件转给编辑器高亮：面板与行号槽说的必须是同一个行号。
 */

interface Props {
  language: string;
  label: string;
  code: string;
  breakpoints: number[];
  onStoppedLine: (line: number | null) => void;
}

const STEPS: readonly { action: DebugAction; label: string; testId: string }[] = [
  { action: 'continue', label: '继续', testId: 'ide-debug-continue' },
  { action: 'next', label: '下一步', testId: 'ide-debug-next' },
  { action: 'stepIn', label: '步入', testId: 'ide-debug-stepIn' },
  { action: 'stepOut', label: '步出', testId: 'ide-debug-stepOut' },
];

function describeStop(event: DebugEvent): string {
  if (event.status === 'stopped') {
    const reason = event.reason === 'breakpoint' ? '命中断点' : '单步';
    const where = event.func ? ` · ${event.func}` : '';
    // 没有行号 = 停在你这份文件之外（步进了标准库）。编一个"第 ? 行"比直说更糟。
    if (event.line === undefined) return `停在你的代码之外（${reason}${where}）`;
    return `停在第 ${event.line} 行（${reason}${where}）`;
  }
  if (event.status === 'exited') return '跑完了（没再命中断点）';
  // 具体是语法错误还是运行时异常由后端说（message 那行），这里只说"没跑完"这件事
  if (event.status === 'error') return '程序没跑完（出错）';
  if (event.status === 'timeout') return '这一步超时，会话已作废';
  if (event.status === 'gone') return '调试会话不在了';
  return '没开起来';
}

export default function DebugPanel({ language, label, code, breakpoints, onStoppedLine }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [event, setEvent] = useState<DebugEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 卸载/关页面时要关的是**当时那个**会话；直接读 state 会拿到闭包里的旧值
  const sessionRef = useRef<string | null>(null);
  const startedCodeRef = useRef<string | null>(null);
  /**
   * 组件还在不在。**"调试"是一条会创建进程的命令**：响应回来时如果页面已经切走，
   * 卸载 cleanup 那一刻 `sessionRef` 还是空的（它只会在 await 之后才被填上），
   * 于是那个刚建好的会话没人记账 —— 它会占死那唯一的名额，下一个页面永远开不起来。
   * 这正是 WI-80 修过的故障，只是换了个入口。
   */
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const publishRef = useRef(onStoppedLine);
  publishRef.current = onStoppedLine;

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    startedCodeRef.current = null;
    setSessionId(null);
  }, []);

  const stopNow = useCallback(
    (id: string) => {
      void api.ideDebugStop({ sessionId: id }).catch(() => undefined);
      clearSession();
      // 停掉之后不许还挂着"停在第 N 行"：那是上一次的事实，留着就是在骗人
      setEvent(null);
      setNote('调试会话已停止。');
    },
    [clearSession],
  );

  const start = useCallback(async () => {
    if (busy) return; // 双击会创建两个会话，而后端只认一个名额
    setBusy(true);
    setNote(null);
    try {
      const res = await api.ideDebugStart({ language, code, breakpoints });
      if (!aliveRef.current) {
        // 响应回来时页面已经切走了：卸载 cleanup 那一刻 sessionRef 还是空的，
        // 这个刚建好的会话没人记账 —— 它会占死那唯一的名额，下一个页面永远开不起来。
        // （WI-80 修过同一个故障，只是换了个入口：那条路是"关标签页"，这条路是"在飞时换语言"）
        if (res.session) void api.ideDebugStop({ sessionId: res.session.id }).catch(() => undefined);
        return;
      }
      setEvent(res);
      if (res.session) {
        sessionRef.current = res.session.id;
        startedCodeRef.current = code;
        setSessionId(res.session.id);
      } else {
        clearSession();
        // 只有"没起起来"才需要一句解释。跑完（没打断点时 session 也是 null）再说
        // "这门语言开不了调试会话"就是凭空报错 —— 那种情况下 `where` 那块已经写了"跑完了"。
        if (res.message) setNote(res.message);
      }
    } catch (err) {
      setNote(`调试请求失败：${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }, [breakpoints, busy, clearSession, code, language]);

  const step = useCallback(
    async (action: DebugAction) => {
      const id = sessionRef.current;
      if (!id || busy) return;
      setBusy(true);
      setNote(null);
      try {
        const res = await api.ideDebugStep({ sessionId: id, action });
        setEvent(res);
        if (res.status !== 'stopped') {
          clearSession();
          if (res.message) setNote(res.message);
        }
      } catch (err) {
        setNote(`单步请求失败：${errorMessage(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, clearSession],
  );

  // 换语言 / 离开页面都会卸载本组件（Ide.tsx 用 key 强制重建）：调试进程必须跟着没
  useEffect(() => {
    return () => {
      const id = sessionRef.current;
      if (id) void api.ideDebugStop({ sessionId: id }).catch(() => undefined);
    };
  }, []);

  /** 直接关标签页不跑 React 的 cleanup ⇒ 另挂 pagehide + keepalive（同 REPL 面板）。 */
  useEffect(() => {
    const onPageHide = () => {
      const id = sessionRef.current;
      if (id) void api.ideDebugStop({ sessionId: id }, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // 代码一改，行号就对不上了：立刻作废，不许拿旧的停点继续
  useEffect(() => {
    const id = sessionRef.current;
    if (!id || startedCodeRef.current === null || code === startedCodeRef.current) return;
    void api.ideDebugStop({ sessionId: id }).catch(() => undefined);
    clearSession();
    setEvent(null);
    setNote('代码改了，行号已经对不上 —— 调试会话已关闭。重新按调试即可。');
  }, [clearSession, code]);

  useEffect(() => {
    publishRef.current(sessionId && event?.status === 'stopped' ? (event.line ?? null) : null);
  }, [event, sessionId]);
  useEffect(() => () => publishRef.current(null), []);

  const locals: DebugVar[] = event?.status === 'stopped' ? (event.locals ?? []) : [];

  return (
    <div className="ide-debug" aria-label="行断点调试">
      <div className="ide-filebar">
        <code className="ide-filename">调试</code>
        <span className="ide-filebar-meta">
          <span>{sessionId ? `${label} 会话进行中` : `断点 ${breakpoints.length} 个`}</span>
          {sessionId ? (
            <button type="button" className="btn btn-sm" onClick={() => stopNow(sessionId)}>
              停止
            </button>
          ) : null}
        </span>
      </div>

      <div className="ide-debug-actions">
        {sessionId ? (
          STEPS.map((s) => (
            <button
              key={s.action}
              type="button"
              className={s.action === 'continue' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
              onClick={() => void step(s.action)}
              disabled={busy}
              data-testid={s.testId}
            >
              {s.label}
            </button>
          ))
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()} disabled={busy} data-testid="ide-debug-start">
            {busy ? '调试中…' : '调试'}
          </button>
        )}
        <span className="tiny muted" data-testid="ide-debug-hint">
          {sessionId
            ? '断点与代码要改的话，停掉再重新调试才生效'
            : breakpoints.length === 0
              ? '没打断点：按下去就是一路跑完'
              : '点行号可加/去断点'}
        </span>
      </div>

      <div className="ide-debug-where" data-testid="ide-debug-where" data-status={event?.status ?? 'idle'}>
        {event ? <span>{describeStop(event)}</span> : <span className="muted">还没开始：点行号下断点，再按调试。</span>}
        {event?.message && event.status !== 'stopped' ? <p className="tiny muted">{event.message}</p> : null}
        {event?.output ? <pre>{event.output}</pre> : null}
      </div>

      {sessionId && event?.status === 'stopped' ? (
        <table className="ide-debug-locals" data-testid="ide-debug-locals">
          <thead>
            <tr>
              <th>名字</th>
              <th>类型</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            {locals.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  这一行还没有局部变量
                </td>
              </tr>
            ) : null}
            {locals.map((v) => (
              <tr key={v.name}>
                <th scope="row">{v.name}</th>
                <td className="muted">{v.type}</td>
                <td>
                  <code>{v.repr}</code>
                  {v.truncated ? <span className="tiny muted">（已截断）</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {note ? (
        <p className="tiny muted" style={{ margin: 0 }} role="status" data-testid="ide-debug-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
