import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { IDE_SESSION_LIMITS, type DebugAction, type DebugVar, type IdeDebugKind } from '@arena/shared';

/**
 * 调试后端的接缝（WI-82）。
 *
 * 为什么要有这一层：会话管理（名额、空闲回收、单步超时、串行队列）与
 * "某个调试器怎么说话"是两件事。把它们混在一份代码里，加第二门语言时就会开始复制粘贴，
 * 而那三条纪律一旦有两份，改一边忘一边是迟早的事。
 *
 * 每个后端只做三件事：起进程、把自家的输出翻译成 `BackendEvent`、收摊。
 */
export type BackendEvent =
  | {
      type: 'stopped';
      /**
       * 用户文件里的行号。**停在标准库里就没有这一格**（jdb 的 step 会进 `java.lang.String`，
       * CDP 会进 node 内部文件）—— 那时 line 留空并给一句 message，
       * 而不是把库里的行号当成用户文件的行号报上去（那会让编辑器高亮到错误的那一行）。
       */
      line?: number;
      func?: string;
      reason: 'breakpoint' | 'step';
      locals: DebugVar[];
      /** 变量读不出来时说实话（jdb 缺 -g 就是这种） */
      message?: string;
    }
  | { type: 'output'; text: string }
  | { type: 'exited'; code?: number }
  | {
      type: 'error';
      text: string;
      /** 一句话说清是哪种失败（语法错误 / 未捕获异常 / 连不上调试器）—— 由后端决定，管理器不猜 */
      message?: string;
    };

export interface DebugHandle {
  /** 只要基类型：js 后端的 stdin 是 'ignore'（没有可写的管道），别逼它假装有 */
  child: ChildProcess;
  /** 送一条单步命令。后端自己决定它在家门口长什么样（JSON 行 / jdb 命令 / CDP 报文）。 */
  send(action: DebugAction): void;
  /**
   * 先**客气地**让调试器自己退（jdb 的 `quit` 会连它起的被调试 JVM 一起收；
   * python 驱动则是 stdin 一关就自己结束）。管理器在硬杀之前给这一条留宽限期。
   *
   * 为什么必须有这一步：Windows 没有进程组，`SIGKILL` 只杀得到 jdb 本身，
   * 那台被调试的 JVM 会变成孤儿继续跑，还顺手锁住沙箱目录删不掉（实测）。
   */
  requestExit(): void;
  /** 进程之外的收尾（java 要删沙箱）。进程由会话管理器负责杀。 */
  dispose(): Promise<void>;
}

export type LaunchResult = { ok: true; handle: DebugHandle } | { ok: false; event: BackendEvent };

export interface DebugBackend {
  kind: IdeDebugKind;
  /**
   * `startupBudgetMs` = 管理器给"**第一个**停点"的全部预算。后端内部任何"等 N 秒"都不许比它短：
   * 自己造一个更小的数，就会在机器忙的时候先于管理器放弃，然后把"慢"报成"错"
   * （实测过：15s 等不到 ws URL 就报"node 没起调试端口就退出了"，而进程活得好好的 —— 那句话是假的）。
   */
  launch(input: {
    code: string;
    breakpoints: number[];
    startupBudgetMs: number;
    emit: (event: BackendEvent) => void;
  }): Promise<LaunchResult>;
}

/**
 * TS 这一侧的变量值截断**只有这一个出口**：后端各自再切一遍就会把 `truncated` 标记丢掉
 * （历史上 240 与 200 同时存在过，文档写的又是第三个数）。
 * ｜python 驱动是另起的进程，import 不到 shared，只能带一份字面量副本 ——
 * 那份由 `debug.test.ts` 里"驱动里的数必须就是 shared 那一个"钉住，不是靠人记得。
 */
export function clipRepr(text: string): { repr: string; truncated: boolean } {
  const limit = IDE_SESSION_LIMITS.varReprChars;
  return text.length > limit ? { repr: text.slice(0, limit), truncated: true } : { repr: text, truncated: false };
}

/**
 * 往子进程写一行，**并且把失败变成一个可结算的回调**（而不是让调用方等满单步超时）。
 *
 * 现场：判定"会话还活着"与真正 `write` 之间，子进程可以刚退出、或者刚被 `requestExit()` 收尾
 * （那正是 `ERR_STREAM_WRITE_AFTER_END` 的形状）。这个竞态窗口关不掉，只能把失败接住。
 * ｜实测到的两种收场（同一个故障，两种写法）：
 * ｜  · 原先那种"只 `write()`、既不给 callback 也不挂监听"—— 错误以 **uncaughtException** 冒出来，
 * ｜    挂掉的是整个服务（去掉管理器那条守卫时，测试文件就是这么红的，而且是挂满 60s 那种红）；
 * ｜  · 只给 `write` 的 callback —— 安静地报给 callback。
 * 所以这里两道都上：callback 管这一次写，'error' 监听管"流自己坏掉、不对应任何一次写"那种。
 */
export function writeLine(stdin: Writable, line: string, onFail: (reason: string) => void): void {
  let reported = false;
  const fail = (reason: string): void => {
    if (reported) return; // callback 与 'error' 事件是同一个故障的两种说法，只报一次
    reported = true;
    onFail(reason);
  };
  stdin.once('error', (err: Error) => fail(err.message));
  stdin.write(`${line}\n`, (err?: Error | null) => {
    if (err) fail(err.message);
  });
}
