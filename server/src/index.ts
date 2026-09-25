import type { BankPort, GradePort, JudgePort, ProgressStore } from './ports.js';
import type { JudgeEvent, JudgeRequest, JudgeResult, Question, QuestionDraft } from '@arena/shared';
import { buildApp } from './api/app.js';
import { hide, hiddenIds, unhide } from './bank/hide.js';
import { ingest as ingestDrafts } from './bank/ingest.js';
import { loadBank, visibleQuestions } from './bank/loader.js';
import { config } from './config.js';
import { flushLogs, logError, logInfo, startLogMaintenance } from './log.js';
import { openProgressStore } from './db/index.js';
import { probeStacks, runJudge as runRegisteredJudge } from './judge/registry.js';
import { registerOptionalRunners } from './judge/runners/index.js';
import { sweepStaleWorkspaces } from './judge/workspace.js';
import { resolveProviders } from './llm/provider.js';
import { createGrader } from './llm/rubric.js';

/**
 * 组合根：题库 / 判题 / 评分 / 游戏各子系统在这里相遇（rule.md C4）。
 * 其余模块只认 ports.ts 里的接口，不互相 import。
 */

const judgePort: JudgePort = {
  run: (req: JudgeRequest, question: Question, onEvent?: (e: JudgeEvent) => void): Promise<JudgeResult> =>
    runRegisteredJudge(req, question, onEvent),
  probe: async (kind) => (await probeStacks())[kind] === true,
};

const gradePort: GradePort = createGrader(resolveProviders(config.llm.providers));

const bankPort: BankPort = {
  all: () => loadBank().then((bank) => bank.questions),
  visible: () => visibleQuestions(),
  async byId(id) {
    const { questions } = await loadBank();
    return questions.find((q) => q.id === id);
  },
  hide: (id, reason) => hide(id, { reason }).then(() => undefined),
  unhide: (id) => unhide(id).then(() => undefined),
  hiddenIds,
  ingest: (drafts: readonly QuestionDraft[]) => ingestDrafts(drafts),
};

async function main(): Promise<void> {
  startLogMaintenance();
  logInfo('boot', 'start', { port: config.port, bankDir: config.bankDir, dataDir: config.dataDir, node: process.version });
  // 上次被杀掉的判题沙箱不会自己消失（finally 没跑），启动时收一次
  const swept = await sweepStaleWorkspaces();
  if (swept > 0) logInfo('boot', 'judge-workspace-sweep', { removed: swept, dir: config.judgeWorkDir });
  const loadedOptional = await registerOptionalRunners();
  const stacks = await probeStacks();
  const store: ProgressStore = openProgressStore({ file: config.dbFile });

  const app = await buildApp({
    judge: judgePort,
    grade: gradePort,
    bank: bankPort,
    store,
    logger: true,
    webDist: config.webDist,
  });

  await app.listen({ port: config.port, host: config.host });

  const unavailable = Object.entries(stacks)
    .filter(([, ok]) => !ok)
    .map(([kind]) => kind);
  app.log.info({ stacks, loadedOptional, unavailable }, 'daily-interview-arena ready');
  if (unavailable.length > 0) {
    app.log.warn(`以下判题栈当前不可用：${unavailable.join(', ')}（不在容器里跑时属正常现象）`);
  }
  app.log.info(`题库目录 ${config.bankDir}；数据目录 ${config.dataDir}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal}，正在关闭`);
    try {
      await app.close();
    } finally {
      await store.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logError('boot', 'failed', { msg: (err as Error).message, stack: (err as Error).stack });
  console.error('[arena] 启动失败：', err);
  await flushLogs();
  process.exit(1);
});
