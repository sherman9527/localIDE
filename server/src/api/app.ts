import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  API_PREFIX,
  CATEGORY_IDS,
  CATEGORY_META,
  JUDGE_KINDS,
  TAG_FACET_MIN_COUNT,
  detailFromGrade,
  detailFromJudge,
  isCategoryId,
  leagueFor,
  publicBankRow,
  publicQuestion,
  questionReference,
  todayIso,
  type AttemptsResponse,
  type BankQuery,
  type BankResponse,
  type CategoriesResponse,
  type CategoryId,
  type GradePostRequest,
  type GradePostResponse,
  type HideResponse,
  type JudgeEvent,
  type JudgeKind,
  type JudgeStatus,
  type JudgePostRequest,
  type JudgePostResponse,
  type JudgeRequest,
  type JudgeResult,
  type ProgressResponse,
  type Question,
  type QuestionDetailResponse,
  type RubricVerdict,
  type StackHealth,
  type TodayResponse,
} from '@arena/shared';
import type { BankPort, Clock, GradePort, JudgePort, ProgressStore } from '../ports.js';
import { IDE_LANGUAGES, IDE_LIMITS, ideAvailability, runIdeCode } from '../ide/runner.js';
import { REPL_IDLE_MS, REPL_MAX_SESSIONS, feedRepl, replSessions, startRepl, stopRepl } from '../ide/repl.js';
import { DEBUG_IDLE_MS, DEBUG_MAX_SESSIONS, debugSessions, startDebug, stepDebug, stopDebug } from '../ide/debug.js';
import type {
  DebugAction,
  DebugSessionsResponse,
  DebugStartRequest,
  DebugStartResponse,
  DebugStepRequest,
  DebugStepResponse,
  DebugStopRequest,
  DebugStopResponse,
  IdeLanguagesResponse,
  IdeRunRequest,
  IdeRunResponse,
  ReplFeedRequest,
  ReplFeedResponse,
  ReplSessionsResponse,
  ReplStartRequest,
  ReplStartResponse,
  ReplStopRequest,
  ReplStopResponse,
} from '@arena/shared';
import { config } from '../config.js';
import { errorFields, logError, logInfo, logWarn, newTraceId } from '../log.js';
import { evaluatePlanProgress, isJudgeable, planForDay, practicePool } from '../game/daily.js';
import { applyAttempt, bookStats, loadBook } from '../game/review.js';
import { summarizeWeek, weekWindow } from '../game/weekly.js';
import { loadAttemptSummary, gradeStatus, xpForCodeAttempt, xpForGradeAttempt, grantDailySetBonus } from '../game/xp.js';
import { snapshotStreak } from '../game/streak.js';
import { evaluateAchievements } from '../game/achievements.js';

/**
 * HTTP 边界。判题/评分只能通过 JudgePort / GradePort 注入（rule.md C4），
 * 所有面向答题者的响应都必须过 publicQuestion()（rule.md C7）。
 * 例外只有一个：题目详情额外带一份 `reference`（走 questionReference()），
 * 因为参考答案答前可看（2026-09-21 拍板）；rubric 判据仍在答完并评分后才展开。
 */
export interface AppDeps {
  judge: JudgePort;
  grade: GradePort;
  bank: BankPort;
  store: ProgressStore;
  clock?: Clock;
  /** 组合根可开日志；默认关闭，测试噪声小 */
  logger?: boolean;
  /** 前端产物目录（测试可注入临时目录验证 SPA 回退） */
  webDist?: string;
}

interface ApiError {
  error: string;
  message: string;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** 单步的四种走法；请求体里出现别的就拒，不猜"大概是想 continue"。 */
const DEBUG_ACTIONS = new Set<DebugAction>(['continue', 'next', 'stepIn', 'stepOut']);

/** `?includeHidden=1|true|yes`。三个端点共用一份解析，别各写一遍各漏一种写法。 */
const wantsIncludedHidden = (value: unknown): boolean =>
  ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());

/**
 * "搜这道题"到底搜什么。带 `q=` 与不带 `q=` 的 `/api/bank` 走的是同一个 `listBank`，
 * 所以这里只有一份判据 —— 分成两份写迟早会出现"列表页能搜到公司、搜索框搜不到"。
 * 正文（statement）留在这里用，列表响应里不再带它（N-15）。
 */
const haystackOf = (q: Question): string =>
  [q.id, q.title, q.statement, q.category, q.tags.join(' '), q.source.company ?? ''].join(' ').toLowerCase();
const pathParam = (request: FastifyRequest, name: string): string => String(((request.params ?? {}) as Record<string, unknown>)[name] ?? '');
const queryParam = (request: FastifyRequest, name: string): string | undefined =>
  asString(((request.query ?? {}) as Record<string, unknown>)[name]);

/** 复盘面板一屏够用就行：detail 每条最多 ~12KB，一次别捞太多。 */
const ATTEMPTS_LIMIT_DEFAULT = 10;
const ATTEMPTS_LIMIT_MAX = 30;

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function errorResult(message: string): JudgeResult {
  return {
    status: 'error',
    passed: 0,
    failed: 0,
    total: 0,
    failedCases: [],
    passedCases: [],
    errorKind: 'sandbox',
    logs: message,
    durationMs: 0,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { judge, grade, bank, store } = deps;
  const clock: Clock = deps.clock ?? { now: () => new Date() };
  const app = Fastify({ logger: deps.logger ?? false });
  const api = API_PREFIX;

  /**
   * 每个请求一个 traceId：请求头带 x-trace-id 就沿用（前端重试用），否则生成。
   * 响应头回传，判题结果里也带 —— 出问题时 `npm run logs -- --trace <id>` 一把捞出整条链路。
   */
  type TracedRequest = FastifyRequest & { traceId?: string };
  app.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers['x-trace-id'];
    const traceId = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : newTraceId('req');
    (request as TracedRequest).traceId = traceId;
    reply.header('x-trace-id', traceId);
    done();
  });
  app.addHook('onResponse', async (request, reply) => {
    const record = {
      traceId: (request as TracedRequest).traceId,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    };
    if (reply.statusCode >= 500) logError('http', 'response', record);
    else if (reply.statusCode >= 400) logWarn('http', 'response', record);
    else logInfo('http', 'response', record);
  });

  const notFound = (reply: FastifyReply, message: string): FastifyReply => reply.code(404).send({ error: 'not_found', message } satisfies ApiError);
  const badRequest = (reply: FastifyReply, message: string, code = 'bad_request'): FastifyReply =>
    reply.code(400).send({ error: code, message } satisfies ApiError);

  /** 题库里取题：只有"存在"且"未被软删除"的题才可作答。 */
  async function answerable(id: string): Promise<{ question: Question } | { error: string }> {
    if (!id) return { error: 'bad_request' };
    const question = await bank.byId(id).catch(() => undefined);
    if (!question) return { error: 'not_found' };
    const hidden = await bank.hiddenIds().catch(() => new Set<string>());
    if (hidden.has(question.id)) return { error: 'hidden' };
    return { question };
  }

  /** 判题 + 记账 + 套餐完成奖励；抛错交给调用方处理（不写脏 attempt）。 */
  async function runJudge(
    req: JudgePostRequest,
    onEvent?: (e: JudgeEvent) => void,
    traceId?: string,
  ): Promise<{ result: JudgeResult; best: JudgePostResponse['best']; mode: 'official' | 'test' }> {
    const picked = await answerable(req.questionId);
    if ('error' in picked) {
      const message =
        picked.error === 'not_found' ? '题目不存在' : picked.error === 'hidden' ? '题目已被移除，如需作答请先在题库页恢复' : 'questionId 非法';
      throw Object.assign(new Error(message), {
        statusCode: picked.error === 'not_found' || picked.error === 'hidden' ? 404 : 400,
        apiCode: picked.error,
      });
    }
    const question = picked.question;
    if (!isJudgeable(question)) {
      throw Object.assign(new Error('主观题请用 /api/grade 评分'), { statusCode: 400, apiCode: 'not_judgeable' });
    }
    const judgeRequest: JudgeRequest = {
      questionId: question.id,
      submission: req.submission ?? '',
      language: question.language,
      ...(traceId ? { traceId } : {}),
      ...(req.customCases?.length ? { caseSource: 'request' as const } : {}),
    };
    if (req.extraFiles?.length) judgeRequest.extraFiles = req.extraFiles;

    const previous = (await store.bestByQuestion()).get(question.id);
    const custom = req.customCases?.length ? req.customCases : undefined;
    const questionForRun = custom
      ? {
          ...question,
          cases: custom.map((c, index) => ({
            name: c.name?.trim() || `自测用例 ${index + 1}`,
            input: c.input,
            expected: c.expected,
            visible: true,
          })),
        }
      : question;

    const result = await judge.run(judgeRequest, questionForRun, onEvent);
    if (custom) {
      // 自测：只给反馈，不写 attempt、不给 XP、不影响套餐进度
      logInfo('judge', 'selftest', {
        traceId: result.traceId,
        questionId: question.id,
        kind: question.judgeKind,
        status: result.status,
        passed: result.passed,
        failed: result.failed,
        cases: custom.length,
      });
      return { result, best: previous ? { status: previous.status as JudgeStatus, at: previous.createdAt } : null, mode: 'test' as const };
    }

    const day = todayLocal();
    await store.record({
      questionId: question.id,
      category: question.category,
      kind: 'judge',
      status: result.status,
      score: null,
      maxScore: null,
      xp: xpForCodeAttempt(result.status),
      passed: result.passed,
      failed: result.failed,
      durationMs: result.durationMs,
      createdAt: clock.now().toISOString(),
      day,
      // 复盘用的逐用例结果 + 当时正文（N-05）；自测那条上面已经 return 掉了
      detail: detailFromJudge(result, req.submission ?? ''),
    });
    // 排期跟着结果走：错过的题才会出现在之后的复习位上（WI-41）
    await applyAttempt(store, { questionId: question.id, passed: result.status === 'pass', today: day });
    await settleDailySet(day);
    return { result, best: previous ? { status: previous.status as JudgeStatus, at: previous.createdAt } : null, mode: 'official' as const };
  }

  /** 本地日历口径（day 一律是本地 YYYY-MM-DD，与 shared.todayIso 一致）。 */
  const todayLocal = (): string => todayIso(clock.now());

  /** 完成当日套餐则幂等发放 +10（GET 不做写入，只在 POST 之后结算）。 */
  async function settleDailySet(day: string): Promise<void> {
    try {
      const { plan, questions } = await planForDay({ date: day, bank, store, clock });
      const attempts = await store.attemptsByDay(plan.date);
      if (evaluatePlanProgress(plan, questions, attempts).done) await grantDailySetBonus(store, plan.date);
    } catch (err) {
      app.log.warn(`套餐结算失败：${(err as Error).message}`);
    }
  }

  // MARK: /api/health
  app.get(`${api}/health`, async (): Promise<StackHealth> => {
    const probes = await Promise.all(
      JUDGE_KINDS.map(async (kind: JudgeKind): Promise<[string, boolean]> => {
        try {
          return [kind, await judge.probe(kind)];
        } catch {
          return [kind, false];
        }
      }),
    );
    const stacks: Record<string, boolean> = Object.fromEntries(probes);
    // 主观题没有 judge runner（评分走 GradePort），按 judge 注册表探测必然 false —— 这里如实探评分链
    stacks['llm-rubric'] = await grade.available().catch(() => false);
    // 前端/文档里更常用的短名（plan Task 11 的 stacks:{java,react,mysql,redis,llm}）
    stacks.java = stacks['java-junit'] ?? false;
    stacks.react = stacks['react-vitest'] ?? false;
    stacks.spark = (stacks['pyspark'] ?? false) || (stacks['spark-scala'] ?? false);
    stacks.llm = stacks['llm-rubric'] ?? false;
    return { ok: true, version: serverVersion(), stacks, llmProviders: [...config.llm.providers] };
  });

  // MARK: /api/categories
  app.get(`${api}/categories`, async (): Promise<CategoriesResponse> => {
    const [all, visible, day] = await Promise.all([bank.all(), bank.visible(), planForDay({ bank, store, clock })]);
    const totalOf = (category: CategoryId) => all.filter((q) => q.category === category).length;
    const visibleOf = (category: CategoryId) => visible.filter((q) => q.category === category).length;
    return {
      categories: CATEGORY_IDS.map((id) => ({
        id,
        label: CATEGORY_META[id].label,
        stack: CATEGORY_META[id].stack,
        total: totalOf(id),
        hidden: totalOf(id) - visibleOf(id),
        todayPlanned: day.questions.filter((q) => q.category === id).length,
      })),
    };
  });

  // MARK: /api/challenge/today
  app.get(`${api}/challenge/today`, async (request, reply): Promise<TodayResponse | FastifyReply> => {
    const categoryParam = queryParam(request, 'category');
    if (categoryParam !== undefined && !isCategoryId(categoryParam)) {
      return badRequest(reply, `未知类别 ${categoryParam}，可选：${CATEGORY_IDS.join(', ')}`);
    }
    const { plan, questions, reviewIds } = await planForDay({ bank, store, clock });
    const attempts = await store.attemptsByDay(plan.date);
    const progress = evaluatePlanProgress(plan, questions, attempts);
    const summary = await loadAttemptSummary(store);
    const streak = snapshotStreak(summary, { clock, today: plan.date });
    const body: TodayResponse = {
      date: plan.date,
      plan,
      questions,
      reviewIds,
      progress: {
        answered: progress.answered.length,
        passed: progress.passed.length,
        xpToday: streak.xpToday,
        streakSafe: streak.safe,
      },
    };
    if (categoryParam) body.practice = await practicePool({ date: plan.date, category: categoryParam, bank, store, clock });
    return body;
  });

  // MARK: /api/questions/:id
  app.get(`${api}/questions/:id`, async (request, reply): Promise<QuestionDetailResponse | FastifyReply> => {
    const id = pathParam(request, 'id');
    const picked = await answerable(id);
    if ('error' in picked) return notFound(reply, `题目 ${id} 不存在或已被移除`);
    // 参考答案在全系统里只有这一个出口（rule.md C7，2026-09-21 改为"答前可看"）。
    // 下面 /api/judge 与 /api/grade 那两处只 reveal rubric 判据，永远不带 answer。
    return { question: publicQuestion(picked.question), reference: questionReference(picked.question) };
  });

  // MARK: /api/ide/*（网页 IDE — 第三个子系统，独立于题库与游戏）
  // 边界由 server/test/ide/boundary.test.ts 把住：这一侧只调用通用执行底座，
  // 而 ide/ 里任何文件都不许反过来 import 判题 runner / 题库 / 游戏。
  app.get(`${api}/ide/languages`, async (): Promise<IdeLanguagesResponse> => {
    const availability = await ideAvailability();
    return {
      languages: IDE_LANGUAGES.map((lang) => ({
        id: lang.id,
        label: lang.label,
        fileName: lang.fileName,
        sample: lang.sample,
        hint: lang.hint,
        // 高亮与执行形态由后端说一句话就行：前端再按 id 猜一次就是第二份真相
        editorLanguage: lang.editorLanguage,
        execution: lang.execution,
        // 每一门的运行预算不同（Spark 冷启动 15s 上下），UI 要能提前说清"最多等多久"
        timeoutMs: lang.timeoutMs ?? IDE_LIMITS.timeoutMs,
        ...(lang.replKind ? { replKind: true } : {}),
        // 行断点：只有机制真落地的语言才给，界面据此决定行号槽点不点得动
        ...(lang.debugKind ? { debugKind: lang.debugKind } : {}),
        ...(lang.setupLabel ? { setupLabel: lang.setupLabel } : {}),
        available: availability[lang.id] === true,
      })),
      limits: {
        maxCodeChars: IDE_LIMITS.maxCodeChars,
        maxStdinChars: IDE_LIMITS.maxStdinChars,
        maxSetupChars: IDE_LIMITS.maxSetupChars,
        timeoutMs: IDE_LIMITS.timeoutMs,
        maxTimeoutMs: IDE_LIMITS.maxTimeoutMs,
        stdoutCapChars: IDE_LIMITS.stdoutCapChars,
        tableRowLimit: IDE_LIMITS.tableRowLimit,
      },
    };
  });

  // 校验失败不走 4xx：IDE 的"被拒"本身就是一次执行结果（超字数、空代码、语言不存在），
  // 用同一条 status:'rejected' 通道返回，UI 只需要一套渲染分支。
  app.post(`${api}/ide/run`, async (request): Promise<IdeRunResponse> => {
    const body = (request.body ?? {}) as Partial<IdeRunRequest>;
    return runIdeCode({
      language: typeof body.language === 'string' ? body.language : '',
      code: typeof body.code === 'string' ? body.code : '',
      stdin: typeof body.stdin === 'string' ? body.stdin : '',
      // 注意没有 timeoutMsOverride：那个口子只给测试用，不许从请求体传进来
      setup: typeof body.setup === 'string' ? body.setup : '',
    });
  });

  // MARK: /api/ide/repl/*（REPL 会话 — WI-77）
  // 一问一答，不用 SSE：每句都有天然的结束点（解释器打出的哨兵行），
  // 上流式只会多出一套重连与状态机而拿不到别的东西。
  app.get(`${api}/ide/repl`, async (): Promise<ReplSessionsResponse> => ({
    sessions: replSessions(),
    maxSessions: REPL_MAX_SESSIONS,
    idleMs: REPL_IDLE_MS,
  }));

  app.post(`${api}/ide/repl/start`, async (request): Promise<ReplStartResponse> => {
    const body = (request.body ?? {}) as Partial<ReplStartRequest>;
    const started = await startRepl(typeof body.language === 'string' ? body.language : '');
    return {
      session: started.session,
      ...(started.message ? { message: started.message } : {}),
      sessions: replSessions().length,
      maxSessions: REPL_MAX_SESSIONS,
    };
  });

  app.post(`${api}/ide/repl/feed`, async (request): Promise<ReplFeedResponse> => {
    const body = (request.body ?? {}) as Partial<ReplFeedRequest>;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    // 空行是有意义的输入（python 靠它结束 def 块），所以这里只截长度、不当"没内容"丢掉
    const line = typeof body.line === 'string' ? body.line.slice(0, IDE_LIMITS.maxCodeChars) : '';
    const fed = await feedRepl(sessionId, line);
    return { status: fed.status, output: fed.output };
  });

  app.post(`${api}/ide/repl/stop`, async (request): Promise<ReplStopResponse> => {
    const body = (request.body ?? {}) as Partial<ReplStopRequest>;
    const ok = await stopRepl(typeof body.sessionId === 'string' ? body.sessionId : '');
    return { ok, sessions: replSessions().length };
  });

  // MARK: /api/ide/debug/*（行断点 — WI-81）
  // 与 REPL 同样的传输取舍：每条命令都有天然的结束点（下一个停点事件），不需要流。
  app.get(`${api}/ide/debug`, async (): Promise<DebugSessionsResponse> => ({
    sessions: debugSessions(),
    maxSessions: DEBUG_MAX_SESSIONS,
    idleMs: DEBUG_IDLE_MS,
  }));

  app.post(`${api}/ide/debug/start`, async (request): Promise<DebugStartResponse> => {
    const body = (request.body ?? {}) as Partial<DebugStartRequest>;
    const code = typeof body.code === 'string' ? body.code.slice(0, IDE_LIMITS.maxCodeChars) : '';
    // 断点行号只收"正整数"：NaN / 负数 / 小数从这里进不去，
    // 越界的行号留给驱动去判（它就是命中不了，不报错也不假装停得住）
    const breakpoints = Array.isArray(body.breakpoints)
      ? [...new Set(body.breakpoints.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1))]
      : [];
    return startDebug(typeof body.language === 'string' ? body.language : '', code, breakpoints);
  });

  app.post(`${api}/ide/debug/step`, async (request): Promise<DebugStepResponse> => {
    const body = (request.body ?? {}) as Partial<DebugStepRequest>;
    const action = DEBUG_ACTIONS.has(body.action as DebugAction) ? (body.action as DebugAction) : null;
    if (!action) {
      return {
        status: 'rejected',
        action: 'continue',
        sessions: debugSessions().length,
        message: `单步只支持 ${[...DEBUG_ACTIONS].join(' / ')}，收到 ${String(body.action)}`,
      };
    }
    return stepDebug(typeof body.sessionId === 'string' ? body.sessionId : '', action);
  });

  app.post(`${api}/ide/debug/stop`, async (request): Promise<DebugStopResponse> => {
    const body = (request.body ?? {}) as Partial<DebugStopRequest>;
    const ok = await stopDebug(typeof body.sessionId === 'string' ? body.sessionId : '');
    return { ok, sessions: debugSessions().length };
  });

  // MARK: /api/judge（同步兜底）
  app.post(`${api}/judge`, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<JudgePostRequest>;
    const questionId = asString(body.questionId) ?? '';
    const submission = asString(body.submission);
    if (!questionId || submission === undefined) return badRequest(reply, 'questionId 与 submission 必填');
    try {
      const { result, best, mode } = await runJudge(
        {
          questionId,
          submission,
          extraFiles: body.extraFiles,
          customCases: body.customCases,
        },
        undefined,
        (request as TracedRequest).traceId,
      );
      const payload: JudgePostResponse = { result, mode };
      if (best) payload.best = best;
      return payload;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404) return notFound(reply, (err as Error).message);
      if (code === 400) return badRequest(reply, (err as Error).message, (err as { apiCode?: string }).apiCode ?? 'bad_request');
      return reply.code(500).send({ error: 'judge_failed', message: (err as Error).message } satisfies ApiError);
    }
  });

  // MARK: /api/judge/stream（SSE：把 3-20s 的等待变成可见进度）
  app.post(`${api}/judge/stream`, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<JudgePostRequest>;
    const questionId = asString(body.questionId) ?? '';
    const submission = asString(body.submission);
    // 参数/题目错误必须在 hijack 之前用 JSON 返回
    if (!questionId || submission === undefined) return badRequest(reply, 'questionId 与 submission 必填');
    const picked = await answerable(questionId);
    if ('error' in picked) return notFound(reply, `题目 ${questionId} 不存在或已被移除`);
    if (!isJudgeable(picked.question)) return badRequest(reply, '主观题请用 /api/grade 评分', 'not_judgeable');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const send = (event: JudgeEvent): void => {
      if (closed) return;
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const keepAlive = setInterval(() => {
      if (closed) return;
      raw.write(': keep-alive\n\n');
    }, 5_000);
    const onClose = (): void => {
      closed = true;
      clearInterval(keepAlive);
    };
    raw.on('close', onClose);

    try {
      send({ type: 'queued', questionId });
      let result: JudgeResult;
      try {
        const settled = await runJudge(
          { questionId, submission, extraFiles: body.extraFiles, customCases: body.customCases },
          send,
          (request as TracedRequest).traceId,
        );
        result = settled.result;
      } catch (err) {
        // 已经在流里了，HTTP 状态码救不回来：用一条 error 结果收尾，保证"最后一条必为 result"
        const message = (err as Error).message;
        send({ type: 'log', line: `判题失败：${message}` });
        result = errorResult(message);
      }
      send({ type: 'result', result });
    } finally {
      clearInterval(keepAlive);
      if (!closed) {
        closed = true;
        raw.end();
      }
    }
    return reply;
  });

  // MARK: /api/grade
  app.post(`${api}/grade`, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<GradePostRequest>;
    const questionId = asString(body.questionId) ?? '';
    const answer = asString(body.answer);
    if (!questionId || answer === undefined) return badRequest(reply, 'questionId 与 answer 必填');
    const picked = await answerable(questionId);
    if ('error' in picked) return notFound(reply, `题目 ${questionId} 不存在或已被移除`);
    const question = picked.question;
    if (isJudgeable(question)) return badRequest(reply, '代码题请用 /api/judge 判题', 'not_subjective');
    let verdict: RubricVerdict;
    const startedAt = Date.now();
    const traceId = (request as TracedRequest).traceId;
    try {
      verdict = await grade.grade(question, answer, traceId);
    } catch (err) {
      logError('grade', 'failed', { traceId, questionId: question.id, ms: Date.now() - startedAt, ...errorFields(err) });
      return reply.code(500).send({ error: 'grade_failed', message: (err as Error).message } satisfies ApiError);
    }
    logInfo('grade', 'accepted', {
      traceId,
      questionId: question.id,
      provider: verdict.provider,
      score: verdict.score,
      maxScore: verdict.maxScore,
      ms: verdict.durationMs ?? Date.now() - startedAt,
    });
    // 降级到人工自检 ≠ 考了 0 分：那是基础设施故障，不能污染成绩，也不能卡住当日套餐
    const graded = verdict.provider !== 'manual';
    const hits = graded ? verdict.rubricBreakdown?.filter((point) => point.hit).length ?? 0 : 0;
    const misses = graded ? verdict.rubricBreakdown?.filter((point) => !point.hit).length ?? 0 : 0;
    const status = graded ? gradeStatus(verdict.score, verdict.maxScore) : 'needs_human';
    const day = todayLocal();
    await store.record({
      questionId: question.id,
      category: question.category,
      kind: 'grade',
      status,
      score: graded ? verdict.score : null,
      maxScore: graded ? verdict.maxScore : null,
      xp: graded ? xpForGradeAttempt(verdict.score, verdict.maxScore) : 0,
      passed: hits,
      failed: misses,
      durationMs: verdict.durationMs,
      createdAt: clock.now().toISOString(),
      day,
      // 主观题留的是逐评分点命中 + 当时答案；provider 原始输出（raw）不进档，那是排障用的
      detail: detailFromGrade(verdict, answer),
    });
    // 只有真拿到评分结果才动排期：needs_human 是基础设施故障，不该记成"这题你不会"
    if (graded) await applyAttempt(store, { questionId: question.id, passed: status === 'pass', today: day });
    await settleDailySet(day);
    const payload: GradePostResponse = {
      verdict,
      // 评分完成后才展开权重与判据（红线 C7 的边界：作答前不可见）
      question: publicQuestion(question, { revealRubric: true }),
      ...(traceId ? { traceId } : {}),
    };
    return payload;
  });

  // MARK: /api/progress
  app.get(`${api}/progress`, async (): Promise<ProgressResponse> => {
    const summary = await loadAttemptSummary(store);
    const { plan, questions } = await planForDay({ bank, store, clock });
    const attempts = await store.attemptsByDay(plan.date);
    const progress = evaluatePlanProgress(plan, questions, attempts);
    const streak = snapshotStreak(summary, { clock, today: plan.date });
    const review = bookStats(await loadBook(store, plan.date), plan.date);
    return {
      xp: summary.totalXp,
      xpToday: summary.xpOn(plan.date),
      streakDays: streak.streak.streakDays,
      streakLongest: streak.streak.streakLongest,
      league: leagueFor(summary.totalXp),
      achievements: evaluateAchievements(summary, streak.streak),
      review,
      week: summarizeWeek(summary.attempts, weekWindow(plan.date), { bonusDays: summary.bonusDays }),
      today: {
        planned: questions.map((q) => q.id),
        answered: progress.answered,
        passed: progress.passed,
        done: progress.done,
      },
      calendar: summary.calendar(plan.date, 30),
      byCategory: Object.fromEntries(summary.byCategory),
    };
  });

  // MARK: /api/attempts（判题历史回看，N-05）
  app.get(`${api}/attempts`, async (request, reply): Promise<AttemptsResponse | FastifyReply> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const questionId = asString(query.questionId)?.trim() ?? '';
    if (!questionId || questionId.length > 200) return badRequest(reply, 'questionId 必填');
    const requested = Number(asString(query.limit));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), ATTEMPTS_LIMIT_MAX) : ATTEMPTS_LIMIT_DEFAULT;
    // 没答过是正常状态，不是 404：返回空数组
    const rows = await store.historyFor(questionId, limit);
    return {
      questionId,
      attempts: rows.map((row) => ({
        id: row.id,
        questionId: row.questionId,
        kind: row.kind,
        status: row.status,
        score: row.score,
        maxScore: row.maxScore,
        xp: row.xp,
        passed: row.passed,
        failed: row.failed,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
        day: row.day,
        detail: row.detail ?? null,
      })),
    };
  });

  // MARK: /api/bank
  app.get(`${api}/bank`, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const category = asString(query.category);
    if (category !== undefined && !isCategoryId(category)) return badRequest(reply, `未知类别 ${category}`);
    const difficulty = asString(query.difficulty);
    if (difficulty !== undefined && difficulty !== 'senior' && difficulty !== 'principal') {
      return badRequest(reply, `难度只支持 senior / principal，收到 ${difficulty}`);
    }
    const includeHidden = wantsIncludedHidden(query.includeHidden);
    const parsed: BankQuery = {
      ...(category ? { category } : {}),
      ...(difficulty ? { difficulty: difficulty as BankQuery['difficulty'] } : {}),
      tag: asString(query.tag),
      q: asString(query.q),
      includeHidden,
    };
    return listBank(parsed);
  });

  async function listBank(query: BankQuery): Promise<BankResponse> {
    const [pool, hidden] = await Promise.all([query.includeHidden ? bank.all() : bank.visible(), bank.hiddenIds()]);
    // 筛选项按**全库**算：一搜索就把下拉里的选项筛掉，看起来像"题库少了一批标签"
    const tagCounts = new Map<string, number>();
    const counts = new Map<string, number>();
    let unlabeled = 0;
    for (const q of pool) {
      for (const t of q.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      if (q.source.company) counts.set(q.source.company, (counts.get(q.source.company) ?? 0) + 1);
      else unlabeled += 1;
    }
    const needle = query.q?.trim().toLowerCase();
    const filtered = pool.filter((q) => {
      if (query.category && q.category !== query.category) return false;
      if (query.difficulty && q.difficulty !== query.difficulty) return false;
      if (query.tag && !q.tags.some((tag) => tag.toLowerCase() === query.tag!.toLowerCase())) return false;
      if (needle && !haystackOf(q).includes(needle)) return false;
      return true;
    });
    return {
      rows: filtered.map(publicBankRow),
      hiddenIds: [...hidden].sort(),
      total: filtered.length,
      tags: [...tagCounts.entries()]
        .filter(([, count]) => count >= TAG_FACET_MIN_COUNT)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')),
      tagCount: tagCounts.size,
      companies: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')),
      unlabeled,
    };
  }

  // MARK: hide / unhide
  app.post(`${api}/questions/:id/hide`, async (request, reply) => {
    const id = pathParam(request, 'id');
    if (!(await bank.byId(id))) return notFound(reply, `题目 ${id} 不存在`);
    const reason = asString((request.body as { reason?: unknown } | undefined)?.reason);
    await bank.hide(id, reason);
    const payload: HideResponse = { id, hidden: true };
    return payload;
  });

  app.delete(`${api}/questions/:id/hide`, async (request, reply) => {
    const id = pathParam(request, 'id');
    if (!(await bank.byId(id))) return notFound(reply, `题目 ${id} 不存在`);
    await bank.unhide(id);
    const payload: HideResponse = { id, hidden: false };
    return payload;
  });

  // MARK: 静态资源与 SPA 回退
  const webDist = deps.webDist ?? config.webDist;
  const indexHtml = join(webDist, 'index.html');
  const hasWebDist = existsSync(indexHtml);
  if (process.env.NODE_ENV === 'development') {
    await app.register(cors, { origin: true });
  }
  if (hasWebDist) {
    // 单页应用：hash 路由由前端负责，非 /api 的 GET 一律回 index.html。
    // wildcard 必须留着：vite 每次构建都换 chunk 哈希，wildcard:false 是启动时扫一遍目录当索引，
    // 之后新落盘的资源会全被 SPA 回退吃掉（浏览器拿到 text/html 的"JS"，整页白屏）。
    await app.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'] });
  }
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const path = (request.url ?? '').split('?')[0] ?? request.url ?? '';
    if (request.method === 'GET' && hasWebDist && !path.startsWith(api)) {
      return reply.type('text/html').send(readFileSync(indexHtml, 'utf8'));
    }
    return reply.code(404).send({ error: 'not_found', message: `没有 ${request.method} ${path}` } satisfies ApiError);
  });

  return app;
}

