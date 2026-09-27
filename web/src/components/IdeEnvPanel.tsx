import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdeEnvInventory, IdeEnvCommandEvent } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';
import { useAsync } from '../lib/hooks';

/**
 * IDE 的依赖环境面板：装包、看用户装了什么、一键回到镜像默认。
 *
 * 三件界面上必须说清的事，都来自后端已经付过的学费：
 * ① "这些只影响 IDE，判题器看不到" —— 常驻，不等用户交题撞了才发现这道缝；
 * ② 装包是几十秒到三分钟，所以输出要流式显示，不能"点了没反应"；
 * ③ 不支持的语言要说明**为什么**不支持，而不是给一个装了没用的输入框。
 */

interface Props {
  /** 面板默认选中当前正在写的语言；换语言时跟着换 */
  activeLanguage: string;
  languageLabels: Record<string, string>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function IdeEnvPanel({ activeLanguage, languageLabels }: Props) {
  const [selected, setSelected] = useState(activeLanguage);
  const [command, setCommand] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { data, loading, error, reload } = useAsync((signal) => api.ideEnv({ signal }), [running, resetting]);
  const logRef = useRef<HTMLPreElement | null>(null);

  // 换语言时面板跟着换：右栏两个面板曾因 key 复用而"切走了面板还赖着"（WI-81）
  useEffect(() => {
    setSelected(activeLanguage);
    setLog([]);
  }, [activeLanguage]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const inventories: IdeEnvInventory[] = data?.inventories ?? [];
  const current = inventories.find((i) => i.language === selected);

  const runInstall = useCallback(async () => {
    const argv = command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0 || running) return;
    setRunning(true);
    setLog((prev) => [...prev, `$ ${argv.join(' ')}`]);
    try {
      const onEvent = (e: IdeEnvCommandEvent): void => {
        if (e.type === 'output') setLog((prev) => [...prev, e.text]);
      };
      const done = await api.ideEnvCommand({ language: selected, argv }, onEvent);
      if (!done) {
        // 没有 done 就是流被截断。必须说实话 —— 静默收尾会让人以为装成功了。
        setLog((prev) => [...prev, '（连接中断，没有收到结束标记：这条命令是否完成**未知**，请看清单）']);
      } else if (done.status !== 'ok') {
        setLog((prev) => [...prev, `— 结束：${done.status}${done.code === null ? '' : `（退出码 ${done.code}）`}`]);
      }
    } catch (err) {
      setLog((prev) => [...prev, errorMessage(err)]);
    } finally {
      setRunning(false);
      setCommand('');
      reload();
    }
  }, [command, running, selected, reload]);

  const reset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      const res = await api.ideEnvReset({ language: selected });
      setLog([
        res.ok
          ? `已重置（释放 ${formatBytes(res.removedBytes)}，作废 ${res.stoppedSessions} 个活会话）`
          : `重置失败：${res.reason ?? '未知原因'}`,
      ]);
    } catch (err) {
      setLog([errorMessage(err)]);
    } finally {
      setResetting(false);
      reload();
    }
  }, [resetting, selected, reload]);

  return (
    <section className="card ide-env-panel" data-testid="ide-env" aria-label="依赖环境">
      <header className="ide-env-head">
        <h2 className="card-title">依赖环境</h2>
        <label className="ide-env-lang">
          <span className="visually-hidden">选择语言</span>
          <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="查看哪门语言的环境">
            {Object.entries(languageLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <p className="ide-env-note">这些包只影响 IDE 的运行 / REPL / 调试；<strong>判题器看不到它们</strong>。</p>

      {loading ? <p className="muted">读取中…</p> : null}
      {error ? <p className="banner banner-error">{error}</p> : null}

      {current && !current.supported ? (
        <p className="ide-env-unsupported" data-testid="ide-env-unsupported">
          {current.reason ?? '这门语言没有可安装的依赖环境。'}
        </p>
      ) : null}

      {current?.supported ? (
        <>
          <div className="ide-env-form-row">
            <input
              className="input"
              type="text"
              value={command}
              placeholder={current.family === 'node' ? 'npm install left-pad' : 'pip3 install requests'}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runInstall();
              }}
              disabled={running}
              aria-label="环境命令"
              data-testid="ide-env-command"
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runInstall()}
              disabled={running || command.trim() === ''}
              data-testid="ide-env-run"
            >
              {running ? '执行中…' : '执行'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                // 破坏性动作要确认：它会停掉活的 REPL 并删掉用户装的所有包
                if (window.confirm(`重置 ${languageLabels[selected] ?? selected} 的依赖环境？活着的 REPL / 调试会话会被关掉。`)) {
                  void reset();
                }
              }}
              disabled={resetting}
              data-testid="ide-env-reset"
            >
              {resetting ? '重置中…' : '重置环境'}
            </button>
          </div>
          <p className="ide-env-hint">
            命令按空白拆开交给 pip / npm，不经过 shell —— 分号、管道在这里只是字符。
          </p>

          {current.drift.length > 0 ? (
            <p className="banner banner-warn" data-testid="ide-env-drift">
              声明了却没装上：{current.drift.join('、')}。环境处于半装状态，建议重置后重装。
            </p>
          ) : null}

          <div className="ide-env-list" data-testid="ide-env-list">
            {current.packages.length === 0 ? (
              <p className="muted">还没有装过包。目前只有镜像预装的那些可用。</p>
            ) : (
              <ul className="ide-env-packages">
                {current.packages.map((p) => (
                  <li key={`${p.name}@${p.version}`} className="ide-env-package">
                    <span className="mono">{p.name}</span>
                    <span className="muted mono">{p.version || '—'}</span>
                    <span className="muted mono">{formatBytes(p.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="ide-env-total muted">
              环境合计占 {formatBytes(current.totalBytes)}
              {current.packages.length > 0 ? `（${current.packages.length} 个包）` : ''}
            </p>
          </div>
        </>
      ) : null}

      {log.length > 0 ? (
        <pre className="ide-env-log mono" ref={logRef} data-testid="ide-env-log" aria-live="polite">
          {log.join('')}
        </pre>
      ) : null}
    </section>
  );
}
