import { useState } from 'react';
import type { JudgeResult } from '@arena/shared';
import { api } from '../api';
import { parseCustomCases } from '../lib/custom-cases';
import { errorMessage } from '../lib/errors';

interface Props {
  questionId: string;
  /** 取当前编辑器里的代码 */
  getCode: () => string;
  /** 正式判题进行中时禁止自测，避免两条流互相覆盖 */
  busy?: boolean;
}

const KEY = (id: string) => `arena.selftest.${id}`;

function loadText(id: string): string {
  try {
    return localStorage.getItem(KEY(id)) ?? '';
  } catch {
    return '';
  }
}

/**
 * 自测：用户自己写用例（一行一组）立刻跑，只给反馈，不写 attempt、不计 XP、不影响套餐进度。
 * 存在的意义是"写完能自己验证"，而不是盲提交等系统判对错。
 */
export default function SelfTestPanel({ questionId, getCode, busy }: Props) {
  const [text, setText] = useState(() => loadText(questionId));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const run = async (): Promise<void> => {
    const parsed = parseCustomCases(text);
    setErrors([
      ...parsed.errors.map((e) => `第 ${e.line} 行：${e.msg}`),
      ...(parsed.cases.length === 0 ? ['至少要有一行形如「1, 2 => 3」的用例'] : []),
    ]);
    setResult(null);
    if (parsed.cases.length === 0) return;

    try {
      localStorage.setItem(KEY(questionId), text);
    } catch {
      /* 隐私模式下存不下也不影响自测 */
    }

    setRunning(true);
    try {
      const response = await api.judge({ questionId, submission: getCode(), customCases: parsed.cases });
      setResult(response.result);
    } catch (err) {
      setErrors([errorMessage(err) || '自测请求失败']);
    } finally {
      setRunning(false);
    }
  };

  const running$ = running || Boolean(busy);

  return (
    <details className="card selftest" data-testid="selftest-panel">
      <summary className="card-title">自测用例（一行一组，不记分）</summary>
      <p className="faint tiny">
        格式：<code>1, 2 =&gt; 3</code>（多个入参用逗号）或 <code>[1,2,1,3] =&gt; 3</code>（一个数组入参）；
        值用 JSON；行首可写 <code>用例名: 输入 =&gt; 期望</code>；<code>#</code> 开头是注释。
      </p>
      <textarea
        className="answer selftest-input"
        data-testid="selftest-input"
        value={text}
        spellCheck={false}
        placeholder={'空事件流返回 0: [] => 0\n[1,2,1,3] => 3'}
        onChange={(e) => setText(e.target.value)}
        aria-label="自测用例"
      />
      <div className="row">
        <button type="button" className="btn" data-testid="selftest-run" onClick={() => void run()} disabled={running$}>
          {running ? '自测运行中…' : '运行自测'}
        </button>
        <span className="faint tiny">自测不写答题记录，也不给 XP</span>
      </div>

      {errors.length > 0 ? (
        <ul className="selftest-errors" role="alert">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      ) : null}

      {result ? (
        <div className="selftest-result" data-testid="selftest-result">
          <p>
            自测结果：<strong>通过 {result.passed} / 失败 {result.failed}</strong>
            <span className="faint tiny"> 耗时 {(result.durationMs / 1000).toFixed(1)}s</span>
            {result.traceId ? <span className="faint tiny"> · trace {result.traceId}</span> : null}
          </p>
          <ul>
            {result.failedCases.map((c) => (
              <li key={c.name} className="selftest-fail">
                <span>{c.name}</span>
                {c.expected !== undefined || c.actual !== undefined ? (
                  <code>
                    期望 {JSON.stringify(c.expected)} ／ 实际 {JSON.stringify(c.actual)}
                  </code>
                ) : (
                  <code>{c.message ?? '未通过'}</code>
                )}
              </li>
            ))}
            {result.passedCases.map((name) => (
              <li key={name} className="selftest-pass">
                ✓ {name}
              </li>
            ))}
          </ul>
          {result.status === 'error' ? <pre className="selftest-log">{result.logs}</pre> : null}
        </div>
      ) : null}
    </details>
  );
}
