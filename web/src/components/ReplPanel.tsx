import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReplFeedResponse, ReplSessionInfo } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';

/**
 * IDE 的 REPL 会话面板（WI-77）。
 *
 * 它是独立组件而不是 Ide.tsx 里又一段 state：会话是一个**活的进程**，
 * 卸载时必须关掉，否则换一次语言就漏一个解释器。这条生命周期写在组件自己这里，
 * 才有人（和测试）能一眼看到。
 *
 * 两件不能省的事：
 * 1. **直接关标签页不会跑 React 的 cleanup** ⇒ 另挂 `pagehide`，用 keepalive 发关闭请求。
 *    否则那个进程会白占一个名额直到空闲回收（实测：连着几次浏览器测试后 2 个名额全被占满，
 *    页面再也开不出会话）。
 * 2. **名额被占时必须有出口**：显示"会话 N / 2"，被拒时给一个"回收现有会话"的按钮。
 *    只说"先关掉一个"而界面上没有任何可关的东西，是个死胡同。
 */

interface Entry {
  id: number;
  kind: 'in' | 'out';
  text: string;
  status?: ReplFeedResponse['status'];
}

export default function ReplPanel({ language, label }: { language: string; label: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 服务端此刻活着几个会话（含别人/上一次留下的）—— 名额被占时要能看见、能清 */
  const [live, setLive] = useState<ReplSessionInfo[]>([]);
  const [maxSessions, setMaxSessions] = useState(2);
  const seqRef = useRef(0);
  // 卸载时要关的是**当时那个**会话；直接读 state 会拿到闭包里的旧值
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;
  const listRef = useRef<HTMLOListElement | null>(null);

  const refreshLive = useCallback(async () => {
    const res = await api.ideReplSessions().catch(() => null);
    if (res) {
      setLive(res.sessions);
      setMaxSessions(res.maxSessions);
    }
  }, []);

  const close = useCallback(async () => {
    const id = sessionRef.current;
    setSessionId(null);
    if (!id) return;
    const res = await api.ideReplStop({ sessionId: id }).catch(() => null);
    setNote(res ? `会话已关闭，还剩 ${res.sessions} 个` : '关闭会话的请求没成功（服务端可能已经把它回收了）');
    void refreshLive();
  }, [refreshLive]);

  // 换语言 / 离开页面都会卸载本组件（Ide.tsx 用 key={language} 强制重建）：会话必须跟着没
  useEffect(() => {
    return () => {
      const id = sessionRef.current;
      if (id) void api.ideReplStop({ sessionId: id }).catch(() => undefined);
    };
  }, []);

  /**
   * 直接关标签页不会跑上面那个 cleanup。`pagehide` 里用 keepalive 发关闭请求 ——
   * 不带 keepalive 的话浏览器正在卸载页面，请求会被直接丢掉，那个解释器就白占一个名额
   * 直到 5 分钟空闲回收（名额只有 2 个，实测足以让下一次开会话一直失败）。
   */
  useEffect(() => {
    const onPageHide = () => {
      const id = sessionRef.current;
      if (id) void api.ideReplStop({ sessionId: id }, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  useEffect(() => {
    void refreshLive();
  }, [refreshLive]);

  /** 回收所有活着的会话（包括本面板之外的）：名额被上一次残留占住时的出口。 */
  const reclaimAll = useCallback(async () => {
    const ids = live.map((s) => s.id);
    await Promise.all(ids.map((id) => api.ideReplStop({ sessionId: id }).catch(() => null)));
    setSessionId(null);
    sessionRef.current = null;
    setNote(ids.length ? `已回收 ${ids.length} 个会话，可以再开了` : '没有可回收的会话');
    void refreshLive();
  }, [live, refreshLive]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;   // 不用 scrollTo：jsdom 没实现，属性写法两边都行
  }, [entries]);

  const send = useCallback(async () => {
    const line = draft;
    if (busy || (!line.trim() && entries.length === 0)) return;
    setBusy(true);
    setNote(null);
    try {
      let id = sessionId;
      if (!id) {
        const started = await api.ideReplStart({ language });
        if (!started.session) {
          setNote(started.message ?? '这门语言开不了会话');
          void refreshLive();   // 被拒时要知道是谁占着名额，否则只能刷新页面赌一赌
          return;
        }
        id = started.session.id;
        const opened = id;
        setSessionId(opened);
        // 乐观地把这个会话记进名额条（下一次 refreshLive 会用服务端的真相覆盖）
        setLive((prev) => [...prev, { id: opened, language, busy: false, idleMs: 0 }]);
      }
      setEntries((prev) => [...prev, { id: ++seqRef.current, kind: 'in', text: line }]);
      const fed = await api.ideReplFeed({ sessionId: id, line });
      setEntries((prev) => [...prev, { id: ++seqRef.current, kind: 'out', text: fed.output, status: fed.status }]);
      // gone / timeout 之后会话已经不在了：下一条要重新开会话，别让用户对着死进程打字
      if (fed.status === 'gone' || fed.status === 'timeout') {
        setSessionId(null);
        sessionRef.current = null;
        void refreshLive(); // 名额条里那条"乐观记上"的会话已经不存在了，不回来一次就永远多算一个
      }
      setDraft((prev) => (prev === line ? '' : prev));
      // ↑ 只清"发出去的那一句"。无条件 setDraft('') 会把等回显期间敲进来的下一句一起抹掉：
      // 输入框看起来没内容，执行按钮永远灰着（E2E 就是这么抓到的，单测因为先 await 再打字而漏掉）
    } catch (err) {
      setNote(`会话请求失败：${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, entries.length, language, refreshLive, sessionId]);

  return (
    <div className="ide-repl" aria-label="REPL 会话">
      <div className="ide-filebar">
        <code className="ide-filename">REPL</code>
        <span className="ide-filebar-meta">
          <span>{sessionId ? `${label} 会话进行中` : '还没开会话（第一句会自动开）'}</span>
          <span data-testid="ide-repl-count">会话 {live.length} / {maxSessions}</span>
          {sessionId ? (
            <button type="button" className="btn btn-sm" onClick={() => void close()}>
              关会话
            </button>
          ) : null}
        </span>
      </div>
      {/* 名额被上一次残留占住时的出口：只说"先关掉一个"而界面上没有可关的东西，是死胡同 */}
      {!sessionId && live.length >= maxSessions ? (
        <div className="ide-repl-stuck" role="status">
          <span>
            {live.length} 个会话正占着名额（可能是上次没关的标签页）。回收后可以再开。
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void reclaimAll()} data-testid="ide-repl-reclaim">
            回收现有会话
          </button>
        </div>
      ) : null}
      <ol className="ide-repl-log" ref={listRef} data-testid="ide-repl-log">
        {entries.length === 0 ? (
          <li className="ide-repl-empty muted">
            逐句求值，变量与 import 在会话里留着 —— 想试"这一句到底返回什么"就在这里问，不用每次贴一整段。
            第一句会等一会儿（解释器要起进程，jshell 实测十几秒）。
          </li>
        ) : null}
        {entries.map((entry) => (
          <li
            key={entry.id}
            className={`ide-repl-line ide-repl-${entry.kind}`}
            data-status={entry.status ?? undefined}
          >
            <pre>{entry.text}</pre>
          </li>
        ))}
      </ol>
      <div className="ide-repl-compose">
        <textarea
          className="answer"
          rows={2}
          spellCheck={false}
          aria-label="送进 REPL 的一句话"
          placeholder="输一句，Enter 送进会话；Shift+Enter 换行（python 的 def 块可以一次贴整块）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="ide-repl-input"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
          data-testid="ide-repl-send"
        >
          {busy ? '执行中…' : '执行'}
        </button>
      </div>
      {note ? (
        <p className="tiny muted" style={{ margin: 0 }} role="status" data-testid="ide-repl-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
