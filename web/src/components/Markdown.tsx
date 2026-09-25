import { memo, useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const parser = new Marked({ gfm: true, breaks: false });

function toSafeHtml(source: string): string {
  const rendered: unknown = parser.parse(source, { async: false });
  const html = typeof rendered === 'string' ? rendered : '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}

interface Props {
  source: string;
  /** 代码块的"复制到编辑器"落到哪个函数上（追加到答题区）。 */
  onCopyCode?: (text: string) => void;
  className?: string;
}

/**
 * 题面渲染：Markdown → sanitize → 注入代码块的复制按钮。
 * 内容本身只在 source 变化时重算，答题时的按键不会牵动它。
 */
const Markdown = memo(function Markdown({ source, onCopyCode, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const copyRef = useRef(onCopyCode);
  copyRef.current = onCopyCode;
  const html = useMemo(() => toSafeHtml(source), [source]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const pre of Array.from(host.querySelectorAll('pre'))) {
      const wrap = document.createElement('div');
      wrap.className = 'md-pre';
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.append(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm md-copy';
      btn.textContent = '复制到编辑器';
      btn.addEventListener('click', () => {
        const text = pre.textContent ?? '';
        copyRef.current?.(text.replace(/\s+$/, ''));
      });
      if (!copyRef.current) btn.disabled = true;
      wrap.append(btn);
    }
    for (const a of Array.from(host.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer noopener');
      }
    }
  }, [html]);

  return (
    <div
      ref={hostRef}
      className={className ? `markdown ${className}` : 'markdown'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default Markdown;
