/**
 * 网页 IDE 的执行内核（WI-64）。
 *
 * 刻意只做"跑一段代码、把 stdout/stderr/退出码拿回来"这一件事：
 * 不复用判题 runner（那会把题库语义带进来，见 boundary.test.ts），
 * 但复用两个已经踩过硬坑的通用底座 ——
 * `runProcess`（超时连进程组一起杀、输出限量累积）与
 * `createWorkspace`（每次一个独立目录、路径越界检查、只写 data/judge）。
 *
 * 威胁模型说清楚：这是**本机单用户**工具，隔离的目的是"跑飞了别把服务挂住"
 * （超时、输出量、并发），不是多租户沙箱。真要给不可信用户用，
 * 得补的是容器级资源限制（pid/内存/网络），不是这里多加几个 if。
 */

import { runProcess, type ExecResult } from '../judge/process.js';
import { probeAvailability, runIdePyspark, runIdeRedis, runIdeSparkScala, runIdeSql } from './executors.js';
import { createWorkspace } from '../judge/workspace.js';
import { IDE_LANGUAGES, IDE_LIMITS, findLanguage, type IdeLanguage } from './languages.js';

// 契约只有一份：状态/阶段的联合类型在 shared 里定义，前端按它渲染。
// 在 server 侧另抄一遍 = 迟早漂移（加一个 status 只改一边，TS 不会拦你）。
export type { IdeRunStage, IdeRunStatus } from '@arena/shared';
import type { IdeRunRequest as IdeRunRequestContract, IdeRunResponse, IdeRunStage, IdeRunStatus } from '@arena/shared';

export interface IdeRunRequest extends IdeRunRequestContract {
  /** 只用于测试压超时路径；对外请求不许自己放大到 IDE_LIMITS.maxTimeoutMs 以上 */
  timeoutMsOverride?: number;
}

export type IdeRunResult = IdeRunResponse;

const NO_CODE: IdeRunResult = {
  status: 'rejected',
  stage: 'submit',
  exitCode: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
  durationMs: 0,
  stdoutCapChars: IDE_LIMITS.stdoutCapChars,
};

function rejected(message: string): IdeRunResult {
  return { ...NO_CODE, message };
}

function finishFrom(
  exec: ExecResult,
  stage: IdeRunStage,
  partial: Partial<IdeRunResult> = {},
): IdeRunResult {
  const cap = IDE_LIMITS.stdoutCapChars;
  // runProcess 允许攒到 cap 就停止追加，所以"是否被截断"要用一个比 cap 大的采集上限来判定
  const truncated = exec.stdout.length >= cap || exec.stderr.length >= cap;
  const status: IdeRunStatus = exec.timedOut
    ? 'timeout'
    : stage === 'compile'
      ? 'compile_error'
      : exec.code === 0
        ? 'ok'
        : 'runtime_error';
  return {
    status,
    stage,
    exitCode: exec.code,
    stdout: exec.stdout.slice(0, cap),
    stderr: exec.stderr.slice(0, cap),
    timedOut: exec.timedOut,
    truncated,
    durationMs: exec.durationMs,
    stdoutCapChars: cap,
    ...partial,
  };
}

/**
 * 并发闸：超过上限就排队而不是回 429。
 * 判题器已有的经验是"被拒"在单机工具里只会让人以为是自己的代码挂了。
 *
 * `peakRunning` 不是装饰：排队是否生效只能看"同时有几个在跑"。
 * 用墙钟判会被 CPU/磁盘争抢蒙过去 —— 第一版测试就是这么假绿的（把上限抬到 99 它照样过）。
 */
let running = 0;
let peakRunning = 0;
const waiting: Array<() => void> = [];

/** 取出并清零"实测到的最大并发进程数"，给闸门验证并发上限真的生效。 */
export function takeIdePeakConcurrency(): number {
  const peak = peakRunning;
  peakRunning = running > peak ? running : peak;
  return peak;
}

async function acquireSlot(): Promise<() => void> {
  if (running >= IDE_LIMITS.maxConcurrentRuns) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  if (running > peakRunning) peakRunning = running;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running -= 1;
    waiting.shift()?.();
  };
}

export async function runIdeCode(request: IdeRunRequest): Promise<IdeRunResult> {
  const language = findLanguage(String(request.language ?? ''));
  if (!language) {
    return rejected(`不支持的语言：${String(request.language)}`);
  }
  const code = typeof request.code === 'string' ? request.code : '';
  if (!code.trim()) {
    return rejected('没有代码');
  }
  if (code.length > IDE_LIMITS.maxCodeChars) {
    return rejected(`代码过长（${code.length} > ${IDE_LIMITS.maxCodeChars} 字符）`);
  }
  const stdin = typeof request.stdin === 'string' ? request.stdin : '';
  if (stdin.length > IDE_LIMITS.maxStdinChars) {
    return rejected(`输入过长（${stdin.length} > ${IDE_LIMITS.maxStdinChars} 字符）`);
  }
  const setup = typeof request.setup === 'string' ? request.setup : '';
  if (setup.length > IDE_LIMITS.maxSetupChars) {
    return rejected(`预置语句过长（${setup.length} > ${IDE_LIMITS.maxSetupChars} 字符）`);
  }

  // 预算按语言给：PySpark 预热后 0.3~6.7s、Spark Scala 一遍实测 15.4s（含真编译），
  // 用命令型语言的 10s 会把"其实能跑"的代码全判成超时。
  const timeoutMs = Math.min(
    request.timeoutMsOverride && request.timeoutMsOverride > 0
      ? request.timeoutMsOverride
      : language.timeoutMs ?? IDE_LIMITS.timeoutMs,
    IDE_LIMITS.maxTimeoutMs,
  );

  // 非进程形态（SQL / Redis）不建工作区：它们跑在一次性库 / 专用 db index 上，
  // 落盘反而会让"每次从空库开始"这件事多一个失败面。
  if (language.execution === 'sql') return runIdeSql(code, setup, timeoutMs);
  if (language.execution === 'redis') return runIdeRedis(code, setup, timeoutMs);
  // IDE 是一次一答（没有 SSE 通道），所以这里不接 onLine：
  // 传一个丢弃回调只会让人以为"日志在流"，实际什么都没发生。
  if (language.execution === 'spark-python') return runIdePyspark(code, setup, timeoutMs);
  if (language.execution === 'spark-scala') return runIdeSparkScala(code, timeoutMs);
  if (language.execution !== 'command' || !language.run) {
    return rejected(`这门语言的执行形态（${language.execution}）后端还没实现`);
  }

  const release = await acquireSlot();
  const workspace = await createWorkspace('ide');
  try {
    for (const [name, content] of Object.entries(language.scaffold ?? {})) {
      await workspace.write(name, content);
    }
    await workspace.write(language.fileName, code);
    const execOpts = {
      cwd: workspace.root,
      timeoutMs,
      input: stdin,
      // 多采一点好判断"是否被截断"，切回 cap 在 finishFrom 里做
      maxOutputChars: IDE_LIMITS.stdoutCapChars + 4096,
    };

    if (language.compile) {
      const built = await runProcess(language.compile.command, language.compile.args, execOpts);
      if (built.timedOut || built.code !== 0) {
        return finishFrom(built, 'compile', {
          message: built.timedOut ? '编译超时' : undefined,
        });
      }
    }

    const run = language.run;
    const ran = await runProcess(run.command, run.args, execOpts);
    return finishFrom(ran, 'run');
  } catch (error) {
    const spawnFailed = error instanceof Error ? error.message : String(error);
    return {
      ...NO_CODE,
      status: 'rejected',
      message: `启动失败：${spawnFailed}（这台机器上可能没有 ${language.label} 的工具链）`,
    };
  } finally {
    await workspace.cleanup();
    release();
  }
}

/** 每种语言现在到底能不能跑 —— 现探，不写死"镜像里装了 JDK"。 */
export async function ideAvailability(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    IDE_LANGUAGES.map(async (lang: IdeLanguage) => {
      if (lang.probeKind) return [lang.id, await probeAvailability(lang.probeKind)] as const;
      if (!lang.probe) return [lang.id, false] as const;
      const workspace = await createWorkspace('ide-probe');
      try {
        const probeOpts = {
          cwd: workspace.root,
          timeoutMs: 15_000,
          maxOutputChars: 2048,
        };
        // 只探"命令在不在、能不能吐版本号"。不去试跑一个空程序：
        // 编译型语言没有源码时 ./a.out 必然失败，那会把可用的语言误判成不可用。
        const built = await runProcess(lang.probe.command, lang.probe.args, probeOpts);
        return [lang.id, built.code === 0 && !built.timedOut] as const;
      } catch {
        return [lang.id, false] as const;
      } finally {
        await workspace.cleanup();
      }
    }),
  );
  return Object.fromEntries(entries);
}

export { IDE_LANGUAGES, IDE_LIMITS };
