import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IdeLanguageInfo, IdeRunResponse } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';
import { useAsync } from '../lib/hooks';
import { Empty, ErrorState, Loading } from '../components/AsyncState';
import CodeEditor from '../components/CodeEditor';
import DebugPanel from '../components/DebugPanel';
import ReplPanel from '../components/ReplPanel';
import { formatSource } from '../lib/format-source';

/**
 * 网页 IDE（WI-64）：选语言 + 默认样例代码 + 运行 + 看输出。
 *
 * 它是第三个子系统 —— 不读题目、不写进度、不计 XP，只走 /api/ide/*。
 * 这条边界由 server/test/ide/boundary.test.ts 强制，不靠"大家都记得"。
 */

const STATUS_TEXT: Record<IdeRunResponse['status'], string> = {
  ok: '运行成功',
  compile_error: '编译失败',
  runtime_error: '运行报错',
  timeout: '超时被终止',
  rejected: '未执行',
};

const STATUS_BADGE: Record<IdeRunResponse['status'], string> = {
  ok: 'badge badge-success',
  compile_error: 'badge badge-warning',
  runtime_error: 'badge badge-warning',
  timeout: 'badge badge-danger',
  rejected: 'badge',
};

/* 高亮语言由后端注册表给（`IdeLanguageInfo.editorLanguage`）。
   以前这里按 id 猜一遍（java/python 之外全塞 typescript），于是加 MySQL 时会得到
   一份"看起来能编辑、其实高亮是错的"的编辑器 —— 第二份真相必然漂移。 */

export default function Ide() {
  const { data, loading, error, reload } = useAsync((signal) => api.ideLanguages({ signal }), []);
  const [languageId, setLanguageId] = useState('');
  const [code, setCode] = useState('');
  const [stdin, setStdin] = useState('');
  const [setup, setSetup] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<IdeRunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  /** 断点行号（1 起）。真值在这里，编辑器里的只是镜像 —— 面板发请求要拿它。 */
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const [stoppedLine, setStoppedLine] = useState<number | null>(null);
  /**
   * 运行中的秒数。Spark 一次要 15s 上下，而一个不动的"运行中…"看起来就是卡死 ——
   * 用户会以为点没生效（或去刷页面），所以把已经等了多久如实显示出来。
   */
  const [elapsedMs, setElapsedMs] = useState(0);
  /**
   * 换语言时带上样例，但不许覆盖用户写过的代码 ——
   * 判据是"当前内容仍是上一个样例"，而不是"用户大概没改过吧"。
   */
  const sampleRef = useRef('');

  // 稳定引用：`data?.languages ?? []` 每次渲染都会给一个新数组，
  // 那会让下面的 useEffect/useCallback 依赖形同虚设。
  const languages = useMemo(() => data?.languages ?? [], [data]);
  const limits = data?.limits;

  useEffect(() => {
    if (languageId || !languages.length) return;
    const first = (languages.find((l) => l.available) ?? languages[0]) as IdeLanguageInfo | undefined;
    if (!first) return;
    setLanguageId(first.id);
    setCode(first.sample);
    sampleRef.current = first.sample;
  }, [languages, languageId]);

  const pick = useCallback(
    (nextId: string) => {
      const next = languages.find((l) => l.id === nextId);
      if (!next) return;
      setLanguageId(next.id);
      if (!code.trim() || code === sampleRef.current) {
        setCode(next.sample);
        sampleRef.current = next.sample;
      }
      setResult(null);
      setRunError(null);
      // 断点是**行号**：换语言之后那些行号指的是另一份代码，留着就是骗人
      setBreakpoints([]);
      setStoppedLine(null);
    },
    [languages, code],
  );

  /** 点一下有、再点没；顺序始终按行号，否则"断点列表"看起来是随机的。 */
  const toggleBreakpoint = useCallback((line: number) => {
    setBreakpoints((prev) =>
      prev.includes(line) ? prev.filter((n) => n !== line) : [...prev, line].sort((a, b) => a - b),
    );
  }, []);

  /**
   * 代码删短之后，超出行数的断点必须一起扔掉：它画不出来（gutter 里没有那一行）、
   * 也点不掉（点不到不存在的行号），却仍然算进"断点 N 个"并被发给后端 ——
   * 那是界面在报一个自己已经兑现不了的数字。
   */
  useEffect(() => {
    const lineCount = code.split('\n').length;
    setBreakpoints((prev) => (prev.some((n) => n > lineCount) ? prev.filter((n) => n <= lineCount) : prev));
  }, [code]);

  // 提到回调之前：beautify / 运行按钮都要读它（原来它在早退 return 之后才声明）
  const active = languages.find((l) => l.id === languageId);

  /**
   * 格式化复用答题页那套（`lib/format-source`：prettier / sql-formatter 懒加载）。
   * 不在这里再造一份规则 —— 两处格式化迟早一处升了另一处没升。
   */
  const beautify = useCallback(async () => {
    if (!active || formatting) return;
    setFormatting(true);
    setFormatNote(null);
    try {
      const outcome = await formatSource(active.editorLanguage, code);
      if (outcome.text !== code) setCode(outcome.text);
      setFormatNote(outcome.note ?? (outcome.how === 'whitespace' ? '已整理缩进与空行（该语言没有浏览器端格式化器）' : '已格式化'));
    } catch (err) {
      setFormatNote(`格式化失败：${(err as Error).message}`);
    } finally {
      setFormatting(false);
    }
  }, [active, code, formatting]);

  // Alt+Shift+F：与 VS Code / CodeMirror 的惯用键一致。挂在 window 上而不是塞进
  // CodeEditor —— 为一个键去改共用编辑器组件，会把答题页一起拖进回归面。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        void beautify();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [beautify]);

  const run = useCallback(async () => {
    if (!languageId || running) return;
    setRunning(true);
    setRunError(null);
    try {
      setResult(await api.ideRun({ language: languageId, code, stdin, setup }));
    } catch (err) {
      setRunError(errorMessage(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [languageId, running, code, stdin, setup]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 200);
    return () => clearInterval(timer);
  }, [running]);

  if (loading) return <Loading label="正在读取可用语言…" cards={1} />;
  if (error) return <ErrorState title="读不到可用语言" reason={error} onRetry={reload} />;
  if (!languages.length) {
    return <Empty title="这台机器没有可用的语言" hint="后端一个工具链都没探到。" />;
  }

  const tooLong = Boolean(limits && code.length > limits.maxCodeChars);
  const stdinTooLong = Boolean(limits && stdin.length > limits.maxStdinChars);

  return (
    <div className="ide-page">
      <div className="ide-head">
        <div className="ide-head-main">
          <h1 className="ide-title">网页 IDE</h1>
          <p className="ide-sub">
            写完直接跑，看输出、退出码和耗时。这里不记分，也不留提交历史。
          </p>
        </div>
        <div className="ide-controls" aria-label="运行设置">
          <label className="ide-lang">
            <span>语言</span>
            <select value={languageId} onChange={(e) => pick(e.target.value)}>
              {languages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                  {l.available ? '' : '（本机不可用）'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => void beautify()}
            disabled={formatting || running || !active}
            title="快捷键 Alt + Shift + F"
          >
            {formatting ? '格式化中…' : '格式化'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={running || !active?.available || tooLong || stdinTooLong}
            title="快捷键 Ctrl / ⌘ + Enter"
          >
            运行
          </button>
        </div>
      </div>

      {active && !active.available ? (
        <div className="banner banner-warning" role="status">
          这台机器上没有 {active.label} 的工具链（探测没通过），所以运行按钮是灰的。
        </div>
      ) : null}
      {tooLong ? (
        <div className="banner banner-warning" role="status">
          代码 {code.length} 字符，超过上限 {limits?.maxCodeChars}。
        </div>
      ) : null}
      {stdinTooLong ? (
        <div className="banner banner-warning" role="status">
          输入 {stdin.length} 字符，超过上限 {limits?.maxStdinChars}。
        </div>
      ) : null}
      {formatNote ? (
        <p className="tiny muted" style={{ margin: 0 }} role="status" data-testid="ide-format-note">
          {formatNote}
        </p>
      ) : null}
      {runError ? (
        <div className="banner banner-danger" role="alert">
          请求失败：{runError}
        </div>
      ) : null}

      <div className="ide-workbench">
        <div className="ide-split">
          <div className="ide-pane">
            <div className="ide-filebar">
              <code className="ide-filename">{active?.fileName ?? '—'}</code>
              <span className="ide-filebar-meta">
                {running ? <span className="ide-elapsed" data-testid="ide-elapsed">已等 {(elapsedMs / 1000).toFixed(1)}s</span> : null}
                {/* 预算按语言给（Spark 那两门 120s、命令型 10s）：不写出来的话，一次十几秒的运行看起来就是卡死 */}
                {active ? <span data-testid="ide-budget">最长 {Math.round(active.timeoutMs / 1000)}s</span> : null}
              </span>
            </div>
            <div className="ide-editor">
              <CodeEditor
                value={code}
                language={active?.editorLanguage ?? 'typescript'}
                onChange={setCode}
                onSubmit={() => void run()}
                ariaLabel="IDE 代码编辑器"
                debug={
                  active?.debugKind
                    ? {
                        enabled: active.available === true,
                        breakpoints,
                        stoppedLine,
                        onToggle: toggleBreakpoint,
                      }
                    : undefined
                }
              />
            </div>
            {active ? <p className="ide-hint">{active.hint}</p> : null}
          </div>

          {/* key=语言：换语言时整块重建，卸载会关掉上一个会话（会话是活进程，不关就是漏进程）。
              宽屏时它与编辑器并排 —— 放在下面要来回滚着看，等于不好用（2026-09-24 用户指出）。
              调试面板排在 REPL 之上：单步时眼睛要在"停在哪一行 + 变量"上，问一句才轮到 REPL。 */}
          <div className="ide-side">
            {active?.debugKind ? (
              <DebugPanel
                key={`debug-${active.id}`}
                language={active.id}
                label={active.label}
                code={code}
                breakpoints={breakpoints}
                onStoppedLine={setStoppedLine}
              />
            ) : null}
            {active?.replKind ? (
              <ReplPanel key={`repl-${active.id}`} language={active.id} label={active.label} />
            ) : null}
          </div>
        </div>
      </div>

      <div className="ide-inputs">
        {active?.setupLabel ? (
          <label className="ide-field">
            <span className="ide-field-label">{active.setupLabel}</span>
            <textarea
              className="answer"
              rows={5}
              spellCheck={false}
              style={{ minHeight: '120px' }}
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              data-testid="ide-setup"
            />
            <span className="ide-field-note">每次运行都从空库开始，上一次建的表与临时视图不会留下来</span>
          </label>
        ) : null}
        <label className="ide-field">
          <span className="ide-field-label">
            标准输入<span className="ide-field-note">（{active?.fileName ?? ''} 里用 input() / scanf / stdin 读它）</span>
          </span>
          <textarea
            className="answer"
            rows={4}
            spellCheck={false}
            style={{ minHeight: '92px' }}
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
          />
        </label>
      </div>

      {result ? (
        <div className="ide-result" aria-label="运行结果" data-status={result.status}>
          <div className="ide-status">
            <span className={STATUS_BADGE[result.status]}>
              <span className="ide-status-word">{STATUS_TEXT[result.status]}</span>
            </span>
            <span className="ide-status-num mono">退出码 {result.exitCode === null ? '—' : String(result.exitCode)}</span>
            <span className="ide-status-num mono">{(result.durationMs / 1000).toFixed(1)}s</span>
            <span className="ide-status-num mono">阶段 {result.stage}</span>
            {result.truncated ? (
              <span className="badge badge-warning">输出被截断（上限 {result.stdoutCapChars} 字符）</span>
            ) : null}
            {result.timedOut ? <span className="badge badge-danger">已强制终止</span> : null}
          </div>
          {result.message ? <p className="small" style={{ margin: 0 }}>{result.message}</p> : null}
          {result.table ? <ResultTable table={result.table} /> : null}
          {result.replies ? <ReplyList replies={result.replies} /> : null}
          {result.stdout ? <OutputBlock label="stdout" text={result.stdout} /> : null}
          {result.stderr ? <OutputBlock label="stderr" text={result.stderr} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="ide-block">
      <h2 className="ide-block-title mono">{label}</h2>
      <pre className="ide-pre">{text}</pre>
    </div>
  );
}

function ResultTable({ table }: { table: NonNullable<IdeRunResponse['table']> }) {
  return (
    <div className="ide-block">
      <h2 className="ide-block-title mono">结果（{table.rows.length} 行，上限 {table.rowLimit}）</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td className="mono" key={j}>
                    {cell === 'NULL' ? <span className="faint">NULL</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated ? (
        <p className="tiny muted" style={{ margin: 0 }}>
          只展示前 {table.rowLimit} 行（加 LIMIT / 聚合再跑，别把几十万行拉进浏览器）。
        </p>
      ) : null}
    </div>
  );
}

function ReplyList({ replies }: { replies: NonNullable<IdeRunResponse['replies']> }) {
  return (
    <div className="ide-block">
      <h2 className="ide-block-title mono">逐条回复</h2>
      <ol className="ide-replies">
        {replies.map((r, i) => (
          <li key={i}>
            <code>{r.command}</code> <span className="muted">→</span> <code>{r.reply}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}
