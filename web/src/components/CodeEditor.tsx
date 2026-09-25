import { useEffect, useMemo, useRef } from 'react';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import type { Language } from '@arena/shared';
import { breakpointGutter, syncBreakpoints } from '../lib/breakpoints';

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  autocompletion: false,
  highlightActiveLine: true,
  searchKeymap: false,
  highlightSelectionMatches: false,
};

function languageExtension(language: Language): Extension[] {
  switch (language) {
    case 'java':
      return [java()];
    case 'sql':
      return [sql()];
    case 'python':
      return [python()];
    case 'typescript':
      return [javascript({ jsx: true, typescript: true })];
    case 'scala':
      // 离线镜像里没有 Scala 语法包（不引新依赖）：不挂语法扩展，编辑器仍是纯文本可用
      return [];
    case 'markdown':
      return [];
  }
}

interface Props {
  value: string;
  language: Language;
  onChange: (next: string) => void;
  onSubmit: () => void;
  ariaLabel: string;
  /**
   * 传了才渲染断点槽（题目页不传 ⇒ 一列都不多）。
   * `enabled` 单独存在是因为 IDE 里换语言时编辑器不重建：mysql 不该能下断点，
   * 但也不该让编辑器宽度跟着语言跳一下。
   */
  debug?: EditorDebugBinding;
}

export interface EditorDebugBinding {
  enabled: boolean;
  breakpoints: number[];
  stoppedLine: number | null;
  onToggle: (line: number) => void;
}

/**
 * 编辑器只在挂载时建一次：语言扩展与 basicSetup 都是稳定引用，
 * 打字只替换 doc，不重建 EditorView，也不触发整页重排。
 */
export default function CodeEditor({ value, language, onChange, onSubmit, ariaLabel, debug }: Props) {
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  // 断点回调读 ref：扩展数组要稳定，否则每次点断点都把 EditorView 重配一遍
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const viewRef = useRef<EditorView | null>(null);

  const extensions = useMemo(
    () => [
      ...languageExtension(language),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => {
            submitRef.current();
            return true;
          },
        },
      ]),
      ...(debug
        ? breakpointGutter({
            enabled: () => debugRef.current?.enabled === true,
            onToggle: (line) => debugRef.current?.onToggle(line),
          })
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ariaLabel, Boolean(debug), language],
  );

  useEffect(() => {
    syncBreakpoints(viewRef.current, {
      lines: debug?.breakpoints ?? [],
      stopped: debug?.stoppedLine ?? null,
    });
  }, [debug?.breakpoints, debug?.stoppedLine]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      basicSetup={BASIC_SETUP}
      onCreateEditor={(view) => {
        viewRef.current = view;
        syncBreakpoints(view, { lines: debugRef.current?.breakpoints ?? [], stopped: debugRef.current?.stoppedLine ?? null });
      }}
    />
  );
}
