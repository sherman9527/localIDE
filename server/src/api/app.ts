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
import { isLoopbackHostHeader } from '../net/localOrigin.js';
import { IDE_LANGUAGES, IDE_LIMITS, ideAvailability, runIdeCode } from '../ide/runner.js';
import { REPL_IDLE_MS, REPL_MAX_SESSIONS, feedRepl, replSessions, startRepl, stopRepl } from '../ide/repl.js';
import { DEBUG_IDLE_MS, DEBUG_MAX_SESSIONS, debugSessions, startDebug, stepDebug, stopDebug } from '../ide/debug.js';
import { runEnvCommand } from '../ide/env-command.js';
import { readInventory } from '../ide/env-inventory.js';
import { resetIdeEnv } from '../ide/reset.js';
import { ensureIdeEnv } from '../ide/env.js';
import { findLanguage } from '../ide/languages.js';
import { notebookStatus } from '../notebooks/status.js';
import { seedNotebooks } from '../notebooks/seed.js';
import type {
  DebugAction,
  DebugSessionsResponse,
  DebugStartRequest,
  DebugStartResponse,
  DebugStepRequest,
  DebugStepResponse,
  DebugStopRequest,
  DebugStopResponse,
  IdeEnvCommandEvent,
  IdeEnvCommandRequest,
  IdeEnvResetRequest,
  IdeEnvResetResponse,
  IdeEnvResponse,
  IdeLanguagesResponse,
  IdeRunRequest,
  IdeRunResponse,
  NotebookFile,
  NotebookPrepareResponse,
  NotebookStatusResponse,
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
  /**
   * 「哪些对端地址算这张网桥的网关」—— 只给**测试**用（评审 I-3a）。
   * 不传 = 生产路径 = `notebooks/status.ts` 自己读 `/proc/net/route`（内核说了算，不是猜的）。
   * 为什么只能从这里注入：那一半判据的输入是**容器自己的网络命名空间**，宿主上的单测永远读不到它，
   * 于是"网关那条分支真被走过吗"在 api 层本来是无判据的。这个口子只在 buildApp 时开，
   * 不是请求参数 ⇒ 客户端碰不到它，也换不到 token（判据依旧是**对端 + Host 的合取**，见 C-1 那段）。
   */
  notebookGatewayAddresses?: string[];
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
   * **C-1（终审）第二半：整个 7788 origin 的 Host 白名单。**
   *
   * 判据与 token 那一半**同源**（`server/src/net/localOrigin.ts`），而且它不是"给 token 那一处补的"：
   * 这个 API **没有任何鉴权**（README/ARCHITECTURE 都写了：题库含被隐藏的题、进度、提交内容全靠
   * "只绑宿主回环"这一条撑着）。只把 Host 判据用在 token 上，等于承认 rebinding 能读走 `/api/bank`
   * 与 `/api/attempts`，只是读不走那个凭据 —— 而那一半的暴露面是**先于本分支存在**的。
   * 这一层把它一起收掉：Host 不是本机字面量的请求，**任何路由**都拿不到（含静态资源与 404 兜底）。
   *
   * 为什么放在第一个 hook（而不是和 traceId 那条并列在后面）：`@fastify/cors` 是在函数末尾
   * `app.register(cors, …)` 才挂的，Fastify 对同一封装层的 onRequest 按**注册顺序**执行 —— 先挂的这一层
   * 一定先跑，于是跨源预检（`OPTIONS` + `Origin: http://evil.example`）也是先被 Host 判掉，
   * 而不是先由 cors 回一个 204 再放行后面的真实请求。
   *
   * 为什么回 403 而不是 400/421：**与 jupyter 那一侧同码**。`docker/entrypoint.sh` 里
   * `--ServerApp.allow_remote_access=False` 让 jupyter 的 `check_host()` 对外来 Host 回 403，
   * 而 `server/test/notebooks/kernel.test.ts` 把 403 写成了"守卫在位"的唯一判据
   * （`HOST_REFUSED_STATUS`，理由：401/404 说明请求没走到守卫那一层，判不了这条）。
   * 两边同码，将来才可能用同一条探针判两边。
   *
   * ⚠ 这一层**不替代** token 路径上的合取，两层各判一件事：这层拦的是"外来 Host 读到任何东西"，
   * 那层拦的是"对端是本机但 Host 不是本机时不许发凭据"。两侧的**实测**配对（2026-10-08 收尾轮做的
   * 破坏性验证，原先这里写的是"删掉哪一侧都会红哪两条"，那句是**没测过的推测**、测出来是错的）：
   * - 摘掉**这一层**（钩子无条件 return）⇒ 红在 `server/test/api/notebook-api.test.ts` 的四条用例：
   *   「C-1 真回环对端 + 外来 Host…整个 origin 拒绝」「C-1 的 Host 白名单覆盖整个 origin…读不到 /api/bank」
   *   「C-1 的 Host 白名单也管非 API 那半棵树…」「对端是网关 + 外来 Host ⇒ 不给 token」，
   *   报的都是 `expected 200 to be 403`（实测 2026-10-08，4 failed | 43 passed）。
   *   **不是** token 泄漏：内层那半还在，走到路由的请求依然拿不到凭据（那几条里的 token 判据都还是绿的）。
   * - 摘掉**内层那一半**（`status.ts` 的 `hostHeader` 判据）⇒ 只红在
   *   `server/test/notebooks/status.test.ts` 那条「token 释放是合取：对端本机 **且** Host 是本机字面量」
   *   （合取表直接调函数、不打 HTTP，所以它不受这一层遮挡）。`notebook-api.test.ts` 的路由档**造不出**
   *   "对端本机 + Host 外来"那一态 —— 外层先 403，请求根本走不到路由去读内层。那不是漏接线，是这一层的效果。
   */
  app.addHook('onRequest', async (request, reply) => {
    if (isLoopbackHostHeader(request.headers.host)) return;
    await reply.code(403).send({
      error: 'bad_host',
      message:
        `Host 头不是本机字面量（收到的那个值不打印在这里 —— 它是外部输入，会进日志）。` +
        '这个服务没有鉴权，靠的历来是"只绑宿主回环"（闸门 compose-ports.test.ts）；' +
        'DNS rebinding 会让那条边界只对 socket 对端成立、对页面同源不成立，所以 Host 也要是本机的形状。' +
        '要用别的地址访问（手机 / 局域网里的另一台），得先给这个服务加一套真正的鉴权，不是把这个检查关掉。',
    } satisfies ApiError);
  });

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

  // MARK: /api/ide/env（清单：用户自己装了什么、占多少盘、哪些语言不支持）
  app.get(`${api}/ide/env`, async (): Promise<IdeEnvResponse> => {
    // 一次把所有语言算完给前端：面板是"每门语言一栏"，逐个请求会变成十次往返
    const inventories = await Promise.all(IDE_LANGUAGES.map((lang) => readInventory(lang)));
    return { inventories };
  });

  // MARK: /api/ide/env/reset（回到镜像默认；会作废该家族的活会话）
  app.post(`${api}/ide/env/reset`, async (request): Promise<IdeEnvResetResponse> => {
    const body = (request.body ?? {}) as Partial<IdeEnvResetRequest>;
    const languageId = typeof body.language === 'string' ? body.language : '';
    const lang = findLanguage(languageId);
    if (!lang) {
      return { ok: false, removedBytes: 0, stoppedSessions: 0, reason: `没有 ${languageId || '(空)'} 这门语言`, inventories: [] };
    }
    const res = await resetIdeEnv(lang);
    const inventories = await Promise.all(IDE_LANGUAGES.map((l) => readInventory(l)));
    return { ...res, inventories };
  });

  // MARK: /api/ide/env/command（SSE：装包是几十秒到几分钟的事，不能悬一个普通请求）
  // 参数错误必须在 hijack 之前用 JSON 返回 —— 进了流就改不了状态码。
  app.post(`${api}/ide/env/command`, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<IdeEnvCommandRequest>;
    const languageId = typeof body.language === 'string' ? body.language : '';
    const lang = findLanguage(languageId);
    if (!lang) return notFound(reply, `没有 ${languageId || '(空)'} 这门语言`);
    if (!Array.isArray(body.argv) || body.argv.length === 0) return badRequest(reply, 'argv 必填且非空');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const send = (event: IdeEnvCommandEvent): void => {
      if (closed) return;
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // 装包时 pip 可以安静几十秒，没有心跳就会被浏览器当成连接死了
    const keepAlive = setInterval(() => {
      if (!closed) raw.write(': keep-alive\n\n');
    }, 5_000);
    raw.on('close', () => {
      closed = true;
      clearInterval(keepAlive);
    });

    try {
      const res = await runEnvCommand(lang, body.argv.map(String), (text) => send({ type: 'output', text }));
      send({ type: 'done', status: res.status, code: res.code });
    } catch (err) {
      // 已经在流里了，状态码救不回来：用一条 done 收尾，保证"最后一条必为 done"
      send({ type: 'output', text: `环境命令执行失败：${(err as Error).message}` });
      send({ type: 'done', status: 'failed', code: null });
    } finally {
      clearInterval(keepAlive);
      if (!closed) raw.end();
    }
  });

  // MARK: /api/notebook/status（第五页的唯一事实来源：服务在不在、kernel 就绪没有）
  // token 的释放判据是**合取**（终审 C-1）：`request.raw.socket.remoteAddress`（内核给的，客户端改不动）
  // **且** `request.headers.host` 是本机字面量。两个输入各拦一种坏法：
  // 只看对端 ⇒ DNS rebinding（受害者浏览器把攻击域名改成 127.0.0.1，对端**就是**回环，而响应与攻击页
  // 同源，页面上的 JS 读得到 url 里那个 token）；只看头 ⇒ 局域网里任何人写 `Host: 127.0.0.1:7788` 就能换到
  // 凭据（评审 M-1 的原始形状）。合取严格强于任何一半，两个方向的用例都钉在
  // `server/test/notebooks/status.test.ts` 与 `server/test/api/notebook-api.test.ts`。
  // 这里不读 `request.ip`：那是 Fastify 在 `trustProxy` 打开后会改口的封装，而本服务没设过 trustProxy，
  // 用 raw socket 是"只有一个输入"的写法 —— 将来真上反向代理，也得在这儿显式决定信谁的转发头。
  app.get(`${api}/notebook/status`, async (request): Promise<NotebookStatusResponse> => {
    const base = await notebookStatus({
      peerAddress: request.raw.socket.remoteAddress ?? '',
      // 头缺席（HTTP/1.0 或被人摘掉）传 undefined ⇒ `isLoopbackHostHeader` fail-closed ⇒ 不给 token
      hostHeader: asString(request.headers.host),
      // 不传 = 走 `localGatewayAddresses()`（生产路径）。见 AppDeps.notebookGatewayAddresses 的注释。
      gatewayAddresses: deps.notebookGatewayAddresses,
    });
    // 顺带铺示例：打开页面这件事本身就该保证示例在位，而不是另加一个 POST。
    // 读路径做 I/O 这件事是计划里故意的（几个文件的 stat + 偶发 copyFile），
    // Task 10 的"页面开着停 60 秒"用数据判它是否被轮询放大；现在不加缓存那一套（YAGNI）。
    //
    // 但这一半**必须接住异常**（评审 I-1）：`seedNotebooks()` 是故意让 mkdir/copyFile 冒出来的，
    // 而它是磁盘 I/O —— 只读挂载 / ENOSPC / 权限坏掉都会 reject。让它逃出路由 = 这个 GET 变 500
    // = 页面掉到"状态读不到"，运行时卡片整块消失，**而 Jupyter 其实好好的**。那等于把 Task 7
    // 在 status.ts 里挡掉的静默降级搬到上一层重演一遍，而且更响（连 reason 都没处写）。
    // 也不许就地 `catch { notebooks: [] }`：空列表说的是"没有示例"，读者看不到"铺不进去"这件事。
    let notebooks: NotebookFile[] = [];
    let seedError: string | undefined;
    try {
      notebooks = await seedNotebooks();
    } catch (err) {
      seedError = `示例没能铺进工作目录（这一条与 Jupyter 在不在跑无关）：${(err as Error).message}`;
      // 响应字段只给"恰好打开了页面的人"看；这条 warn 才是给运维的（log.ts 的头一条纪律：出故障要能 trace，
      // 只读挂载 / ENOSPC 应当躺在 data/logs/ 里）。调用形状照 /api/grade 的失败日志（traceId + errorFields）。
      logWarn('notebook', 'seed.failed', { traceId: (request as TracedRequest).traceId, ...errorFields(err) });
    }
    const payload: NotebookStatusResponse = { ...base, notebooks };
    if (seedError) payload.seedError = seedError;
    return payload;
  });

  // MARK: /api/notebook/prepare-env（显式建 IDE 的 venv —— kernel 的 argv 指着它）
  // 不挂在 GET 上：分钟级的 venv 创建塞进读路径是错的 —— 计划里 status 就是要被前端轮询的那个接口
  // （Task 9 目前只给了「刷新状态」按钮，但它一旦变成定时器，这条就更要紧）。
  app.post(`${api}/notebook/prepare-env`, async (): Promise<NotebookPrepareResponse> => {
    try {
      const lang = findLanguage('python');
      if (!lang) return { ok: false, reason: '语言表里没有 python' };
      await ensureIdeEnv(lang);
      return { ok: true };
    } catch (err) {
      // 200 + ok:false + 原因，而不是 500：500 里读者看不到"为什么没建成"，
      // 而"点了没反应"是本项目反复付过代价的那类静默（与 IdeEnvResetResponse 同一条纪律）。
      return { ok: false, reason: (err as Error).message };
    }
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

