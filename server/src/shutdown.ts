import { errorFields, flushLogs, logError } from './log.js';

/**
 * 优雅退出的那一段序列（组合根 `index.ts` 之外唯一该懂"退出顺序"的地方）。
 *
 * 为什么要有这一层：顺序本身就是判据（关服务 → 关库 → 排空日志 → `process.exit`），
 * 而写在组合根里它**不可测** —— 组合根 import 就会 listen，测试拿不到"退出那一刻"的状态。
 * 本仓库对优雅退出的全部实测经验都只到"只能判 `State.ExitCode`"那一步（那条路径不打印新行），
 * 所以这里把 `exit` 做成注入点：判据能站在"进程正在死的那一刻"看磁盘上到底有什么。
 */

export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface GracefulExitDeps {
  /** fastify 的 `app.close()`：notebook 反代那条 `preClose`（先收连接再等）也在它里面走完 */
  closeApp: () => Promise<unknown>;
  /** 进度库的 `store.close()` */
  closeStore: () => Promise<unknown>;
  /** "正在关闭"这一句往哪儿说（线上传 pino；测试里换成收集器） */
  log: (message: string) => void;
  /** 默认 `process.exit`。测试换成桩，才能在退出**当时**读盘，而不是等事件循环把排队的写入补跑完 */
  exit?: (code: number) => void;
}

export interface InstallDeps extends GracefulExitDeps {
  /** 默认 `process.on(signal, handler)`。测试换成记录器，免得真往测试进程挂信号处理器 */
  subscribe?: (signal: string, handler: () => void) => void;
  /** 默认 `EXIT_SIGNALS` */
  signals?: readonly string[];
}

/**
 * 收摊的四步，**任何一步的失败都不许挡住后面三步**。
 *
 * 为什么两步都 `catch` 住并记进日志，而不是让它冒出去：
 * 让它冒出去 ⇒ 后面的排空与 `exit(0)` 轮不到执行 ⇒ 尾部日志丢掉 + 进程按 unhandled rejection 死
 * （退出码 1，而 `docker stop` 那边只看得见码），这正是本仓库最恨的那类"把真故障盖成自身崩溃"。
 * 记进日志则是**同一条队列**里的下一行，紧接着就被排空带走 —— 故障留在磁盘上，而不是留在人脑子里。
 * 返回值因此永远不 reject，`installGracefulExit` 里那句 `void` 才是安全的（仓库规矩：
 * `void` 一个 async 就要保证它永不 reject，否则就地接住）。
 */
export async function gracefulExit(signal: string, deps: GracefulExitDeps): Promise<void> {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  deps.log(`${signal}，正在关闭`);
  try {
    await deps.closeApp();
  } catch (err) {
    logError('shutdown', 'app.close.failed', { signal, ...errorFields(err) });
  }
  try {
    await deps.closeStore();
  } catch (err) {
    logError('shutdown', 'store.close.failed', { signal, ...errorFields(err) });
  }
  /**
   * **排空必须排在 `exit` 之前**（WI-99）：`log.ts` 的写入是挂在一条 promise 链上的异步追加，
   * 而 `process.exit()` 是同步终结 —— 不排空就等于每次正常退出都可能有最后几行没落盘
   * （判题失败的 stack、`app.close()` 抛出的那句，恰恰是最该留下的那几行）。
   * 它自己不会 reject：`write()` 里那道 `.catch` 保证链子永远落地，所以这里不需要再包一层。
   */
  await flushLogs();
  exit(0);
}

/** 把 `gracefulExit` 接到进程信号上（组合根只做这一件事，退出顺序不在它手里）。 */
export function installGracefulExit(deps: InstallDeps): void {
  const subscribe = deps.subscribe ?? ((signal: string, handler: () => void) => process.on(signal, handler));
  for (const signal of deps.signals ?? EXIT_SIGNALS) {
    subscribe(signal, () => void gracefulExit(signal, deps));
  }
}
