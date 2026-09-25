import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GradePostResponse, JudgeEvent, JudgeResult, ProgressResponse, QuestionDetailResponse } from '@arena/shared';
import { CATEGORY_META } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';
import { useAsync, useDebouncedEffect } from '../lib/hooks';
import { Badge, Empty, ErrorState, Loading } from '../components/AsyncState';
import CaseTable from '../components/CaseTable';
import AnswerInput from '../components/AnswerInput';
import SelfTestPanel from '../components/SelfTestPanel';
import JudgeResultPanel from '../components/JudgeResultPanel';
import Markdown from '../components/Markdown';
import RubricPanel from '../components/RubricPanel';
import RunningPanel, { idleRunning, type RunningState } from '../components/RunningPanel';
import AttemptHistory from '../components/AttemptHistory';
import ReferenceAnswer from '../components/ReferenceAnswer';
import { DIFFICULTY_LABEL, JUDGE_KIND_LABEL, editorLanguageOf, isSubjective } from '../lib/format';
import { loadBestPass, loadDraft, saveBestPass, saveDraft } from '../lib/storage';
import { navigate, toHref } from '../router';

const MAX_LOG_LINES = 40;

function reduceRun(prev: RunningState, event: JudgeEvent): RunningState {
  switch (event.type) {
    case 'progress':
      return { ...prev, phase: event.phase, elapsedMs: event.elapsedMs, timeoutMs: event.timeoutMs };
    case 'log':
      return { ...prev, logs: [...prev.logs, event.line].slice(-MAX_LOG_LINES) };
    default:
      return prev;
  }
}

interface Props {
  id: string;
}

export default function Question({ id }: Props) {
  const { data, loading, error, reload } = useAsync(async (signal) => {
    const [detail, progress]: [QuestionDetailResponse, ProgressResponse] = await Promise.all([
      api.question(id, { signal }),
      api.progress({ signal }),
    ]);
    return { question: detail.question, reference: detail.reference, progress };
  }, [id]);

  const question = data?.question ?? null;
  const reference = data?.reference ?? {};
  const subjective = question ? isSubjective(question) : false;

  const [code, setCode] = useState(() => loadDraft(id, 'code'));
  const [answer, setAnswer] = useState(() => loadDraft(id, 'answer'));
  const [best, setBest] = useState<'pass' | null>(() => (loadBestPass(id) ? 'pass' : null));
  const [running, setRunning] = useState(false);
  const [runState, setRunState] = useState<RunningState>(idleRunning);
  const [result, setResult] = useState<JudgeResult | null>(null);
  /** 提交一次 +1：让"提交历史"卡片重新去服务端取，而不是停留在进页时那份 */
  const [historyBump, setHistoryBump] = useState(0);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [gradeResult, setGradeResult] = useState<GradePostResponse | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const gradingRef = useRef(false);
  const [hiding, setHiding] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  useEffect(() => {
    setCode(loadDraft(id, 'code'));
    setAnswer(loadDraft(id, 'answer'));
    setBest(loadBestPass(id) ? 'pass' : null);
    setResult(null);
    setRunState(idleRunning);
    setGradeResult(null);
  }, [id]);

  const passedOnServer = data?.progress.today.passed.includes(id) ?? false;
  useEffect(() => {
    if (passedOnServer && best !== 'pass') setBest('pass');
  }, [passedOnServer, best]);

  useDebouncedEffect(
    () => {
      if (code) saveDraft(id, 'code', code);
    },
    [code, id],
    400,
  );
  useDebouncedEffect(
    () => {
      if (answer) saveDraft(id, 'answer', answer);
    },
    [answer, id],
    400,
  );

  const markPass = useCallback(
    (next: JudgeResult) => {
      if (next.status !== 'pass') return;
      setBest('pass');
      saveBestPass(id);
    },
    [id],
  );

  const onEvent = useCallback((event: JudgeEvent) => {
    if (event.type === 'result') {
      setResult(event.result);
      markPass(event.result);
      return;
    }
    setRunState((prev) => reduceRun(prev, event));
  }, [markPass]);

  const judge = useCallback(async () => {
    if (!question || busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRunState(idleRunning);
    setResult(null);
    setJudgeError(null);
    saveDraft(question.id, 'code', code);
    try {
      const final = await api.judgeStream(
        { questionId: question.id, submission: code, language: editorLanguageOf(question) },
        onEvent,
        { signal: controller.signal },
      );
      if (final) {
        setResult(final);
        markPass(final);
        setHistoryBump((n) => n + 1);
      } else {
        setJudgeError('判题没有返回结果，判题栈可能中途退出了');
      }
    } catch (e) {
      const msg = errorMessage(e);
      if (msg) setJudgeError(msg);
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      setRunning(false);
    }
  }, [question, code, onEvent, markPass]);

  const grade = useCallback(async () => {
    if (!question || gradingRef.current) return;
    gradingRef.current = true;
    setGrading(true);
    setGradeError(null);
    saveDraft(question.id, 'answer', answer);
    try {
      const verdict = await api.grade({ questionId: question.id, answer });
      setGradeResult(verdict);
      setHistoryBump((n) => n + 1);
    } catch (e) {
      setGradeError(errorMessage(e) || '评分失败');
    } finally {
      gradingRef.current = false;
      setGrading(false);
    }
  }, [question, answer]);

  const appendCode = useCallback((text: string) => {
    setCode((prev) => (prev.trim() === '' ? text : `${prev.replace(/\s+$/, '')}\n\n${text}`));
  }, []);

  const hide = useCallback(async () => {
    if (!question || hiding) return;
    setHiding(true);
    setHideError(null);
    try {
      await api.hide(question.id);
      navigate('/');
    } catch (e) {
      setHideError(errorMessage(e) || '移除失败');
      setHiding(false);
    }
  }, [question, hiding]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (subjective) void grade();
      else void judge();
    },
    [subjective, grade, judge],
  );

  const meta = useMemo(() => (question ? CATEGORY_META[question.category] : null), [question]);

  if (loading && !data) return <Loading label="正在取题目…" cards={2} />;
  if (error) return <ErrorState title="题目加载失败" reason={error} onRetry={reload} />;
  if (!question || !meta) return <Empty title="找不到这道题" hint="它可能已经被移除了。" />;

  const cases = question.cases ?? [];

  return (
    <div onKeyDown={onKeyDown}>
      <header className="card q-head">
        <div className="q-titles">
          <h1 data-testid="question-header">{question.title}</h1>
          <div className="tags">
            <span className="badge badge-primary">
              <span className="swatch" style={{ background: meta.accent } as CSSProperties} aria-hidden="true" />
              {meta.label}
            </span>
            <Badge>{DIFFICULTY_LABEL[question.difficulty]}</Badge>
            <Badge>{JUDGE_KIND_LABEL[question.judgeKind]}</Badge>
            <Badge>{question.estimatedMinutes} 分钟</Badge>
            {question.source.company ? <Badge tone="warning">{question.source.company} 真题</Badge> : null}
            {question.source.era ? <Badge>{question.source.era} 年考法</Badge> : null}
            {question.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
            {best === 'pass' ? (
              <span className="badge badge-success" data-testid="best-badge">
                历史最佳：通过
              </span>
            ) : null}
          </div>
        </div>
        <div className="q-actions">
          <a className="btn btn-sm btn-ghost" href={toHref('/')}>
            ← 今日挑战
          </a>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void hide()} disabled={hiding}>
            {hiding ? '移除中…' : '移除这题'}
          </button>
        </div>
      </header>
      {hideError ? <ErrorState title="移除失败" reason={hideError} onRetry={() => void hide()} /> : null}

      <div className="q-grid">
        <div className="q-main">
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">题面</h3>
            </div>
            <Markdown source={question.statement} onCopyCode={subjective ? undefined : appendCode} />
          </section>

          {subjective ? null : <CaseTable cases={cases} />}

          {subjective ? (
            <>
              <AnswerInput
                questionId={question.id}
                question={question}
                value={answer}
                onChange={setAnswer}
                onSubmit={() => void grade()}
                running={grading}
              />
              <div className="rubric-hint">
                <span className="small muted">评分会看这些考点（权重答完才公开）：</span>
                <ul className="label-list">
                  {(question.rubric?.pointLabels ?? []).map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <>
              <AnswerInput
                questionId={question.id}
                question={question}
                value={code}
                onChange={setCode}
                onSubmit={() => void judge()}
                submitLabel={running ? '判题中…' : '运行用例'}
                running={running}
                lockMode
              />
              <SelfTestPanel questionId={question.id} getCode={() => code} busy={running} />
            </>
          )}
        </div>

        <aside className="q-side" aria-label="判题结果">
          {subjective ? (
            <>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => void grade()} disabled={grading}>
                  {grading ? '评分中…' : '评分'}
                </button>
                <span className="faint tiny">用本机 CLI 按 rubric 打分</span>
              </div>
              {grading ? (
                <div className="run-panel" data-testid="grade-running" role="status" aria-live="polite">
                  <div className="run-head">
                    <span className="spinner" aria-hidden="true" />
                    <strong>评分中</strong>
                    <span className="muted">正在按考点逐项比对，通常 10-30 秒</span>
                  </div>
                </div>
              ) : null}
              {gradeError ? <ErrorState title="评分失败" reason={gradeError} onRetry={() => void grade()} /> : null}
              {gradeResult ? (
                <RubricPanel
                  verdict={gradeResult.verdict}
                  rubric={gradeResult.question.rubric}
                  answer={answer}
                  traceId={gradeResult.traceId}
                />
              ) : null}
            </>
          ) : (
            <>
              {running ? <RunningPanel {...runState} /> : null}
              {result ? <JudgeResultPanel result={result} /> : null}
              {judgeError ? <ErrorState title="判题没跑完" reason={judgeError} onRetry={() => void judge()} /> : null}
              {!running && !result && !judgeError ? (
                <p className="faint small">运行后这里会显示通过数、失败数与失败用例。</p>
              ) : null}
            </>
          )}
          <ReferenceAnswer question={question} reference={reference} onCopyCode={subjective ? undefined : appendCode} />
          <AttemptHistory questionId={question.id} bump={historyBump} />
        </aside>
      </div>
    </div>
  );
}
