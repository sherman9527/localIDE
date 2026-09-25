import { useEffect, useState } from 'react';
import type { Language } from '@arena/shared';
import CodeEditor from './CodeEditor';
import { CODE_LANGUAGES, formatSource, loadMode, modeOf, saveMode } from '../lib/format-source';
import type { AnswerMode } from '../lib/format-source';

interface Props {
  questionId: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** 不传就不在编辑区重复渲染提交按钮（主观题的"评分"已在右侧结果栏里） */
  submitLabel?: string;
  running?: boolean;
  /** 代码题只接受代码，不允许切成纯文本（判题器只吃源码） */
  lockMode?: boolean;
  question: { judgeKind: string; language?: string };
  hint?: string;
}

/**
 * 答题输入区：文本/Markdown 与代码两种形态可切换，
 * 代码形态带语言高亮，并提供"美化代码"按钮（SQL/TS 真格式化，其余只整理空白并如实说明）。
 */
export default function AnswerInput(props: Props) {
  const fallback = modeOf(props.question);
  const [pref, setPref] = useState(() => loadMode(props.questionId, fallback));
  const [formatting, setFormatting] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const { judgeKind, language: questionLanguage } = props.question;
  useEffect(() => {
    setPref(loadMode(props.questionId, modeOf({ judgeKind, language: questionLanguage })));
    setNote(undefined);
  }, [props.questionId, judgeKind, questionLanguage]);

  const patch = (next: Partial<{ mode: AnswerMode; language: Language }>) => {
    const merged = { ...pref, ...next };
    setPref(merged);
    saveMode(props.questionId, merged);
  };

  const beautify = async () => {
    setFormatting(true);
    setNote(undefined);
    try {
      const outcome = await formatSource(pref.language, props.value);
      if (outcome.text !== props.value) props.onChange(outcome.text);
      setNote(outcome.note ?? (outcome.how === 'whitespace' ? '已整理缩进与空行' : '已格式化'));
    } catch (err) {
      setNote(`格式化失败：${(err as Error).message}`);
    } finally {
      setFormatting(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head answer-bar">
        <h3 className="card-title">你的作答</h3>
        <div className="seg" role="group" aria-label="作答形态">
          <button
            type="button"
            className={pref.mode === 'text' ? 'seg-on' : 'seg-off'}
            disabled={props.lockMode}
            onClick={() => patch({ mode: 'text', language: 'markdown' })}
            aria-pressed={pref.mode === 'text'}
          >
            文本 / Markdown
          </button>
          <button
            type="button"
            className={pref.mode === 'code' ? 'seg-on' : 'seg-off'}
            onClick={() => patch({ mode: 'code', language: pref.language === 'markdown' ? 'typescript' : pref.language })}
            aria-pressed={pref.mode === 'code'}
          >
            代码
          </button>
        </div>
        {pref.mode === 'code' ? (
          <label className="inline-field">
            <span className="faint tiny">语言</span>
            <select
              value={pref.language}
              onChange={(e) => patch({ language: e.target.value as Language })}
              aria-label="代码语言"
            >
              {CODE_LANGUAGES.filter((l) => l.value !== 'markdown').map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void beautify()} disabled={formatting || !props.value}>
          {formatting ? '美化中…' : '美化代码'}
        </button>
        <span className="faint tiny kbd-hint">
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
        </span>
        {props.submitLabel ? (
          <button type="button" className="btn btn-primary" onClick={props.onSubmit} disabled={props.running}>
            {props.running ? '进行中…' : props.submitLabel}
          </button>
        ) : null}
      </div>

      <div className="editor-shell">
        {pref.mode === 'code' ? (
          <CodeEditor
            value={props.value}
            language={pref.language}
            onChange={props.onChange}
            onSubmit={props.onSubmit}
            ariaLabel={`答题代码编辑器（${pref.language}）`}
          />
        ) : (
          <textarea
            className="answer"
            data-testid="answer-textarea"
            value={props.value}
            spellCheck={false}
            onChange={(e) => props.onChange(e.target.value)}
            aria-label="作答内容"
            placeholder={props.hint ?? '按考点逐条写：结论 → 取舍 → 数字 → 兜底'}
          />
        )}
      </div>
      {note ? <p className="faint tiny">{note}</p> : null}
    </section>
  );
}
