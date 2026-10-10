import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { flushLogs, logFileFor, logInfo, newTraceId } from '../src/log.js';
import { EXIT_SIGNALS, gracefulExit, installGracefulExit } from '../src/shutdown.js';

/**
 * WI-99：优雅退出这条路径**必须把日志队列排空**，再让进程死掉。
 *
 * 形状上的坑在于"`process.exit()` 之后没人替你补跑"：`log.ts` 的写入是排成一条链异步落盘的，
 * 而 `exit` 是同步终结 —— 队列里最后那几行就此消失。这一条与"崩在 `app.close()` 里"无关：
 * 崩溃之外的一次**正常**退出（`docker stop` 发的 SIGTERM）照样会丢尾巴。
 *
 * 判据不能等到事后再读盘：测试进程不会因为走到 `exit` 就死，那一次排队的 appendFile
 * 稍后照样会落盘 —— 那样"有没有排空"就永远测不出来（两边看起来都是绿的）。
 * 所以 `exit` 是一个桩，而**读盘发生在桩里**：站在"进程正在死的那一刻"看磁盘上有什么。
 * 破坏性验证：把 `shutdown.ts` 里那句 `await flushLogs()` 摘掉 ⇒ 这条必须红。
 */

function linesWith(traceId: string): string[] {
  const file = logFileFor();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes(traceId));
}

/** 等一条"发出去就不管"的异步序列走完（有界；超时就说清在等什么，不静默放过）。 */
async function untilSettled(label: string, done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${label}：${timeoutMs}ms 之后仍然没发生（这条退出路径没走完）`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  // 测试自己写的行也要收干净，否则下一条用例读到的"退出时刻的磁盘"里混着上一条的尾巴
  await flushLogs();
});

describe('优雅退出路径（WI-99）', () => {
  it('退出那一刻队列里的日志已经落盘，且 close 期间写的行也算', async () => {
    const beforeExit = newTraceId('exit');
    const duringClose = newTraceId('exit');
    const order: string[] = [];
    let exitCode: number | null = null;
    let onDiskAtExit: string[] = [];

    logInfo('shutdown-test', 'queued-before-exit', { traceId: beforeExit });
    await gracefulExit('SIGTERM', {
      log: (message) => void order.push(`log:${message}`),
      closeApp: async () => {
        order.push('closeApp');
      },
      closeStore: async () => {
        order.push('closeStore');
        // 关库自己也要写一行：排空必须发生在它**之后**，否则这一行就是尾部丢的那几行
        logInfo('shutdown-test', 'written-while-closing', { traceId: duringClose });
      },
      exit: (code) => {
        exitCode = code;
        onDiskAtExit = linesWith(beforeExit).concat(linesWith(duringClose));
      },
    });

    expect(order, '关闭的顺序也是判据：先收服务、再关库，最后才轮到退出').toEqual([
      'log:SIGTERM，正在关闭',
      'closeApp',
      'closeStore',
    ]);
    expect(exitCode, '退出码是 `docker stop` 那边唯一看得见的东西（那条路径不打印新行）').toBe(0);
    expect(onDiskAtExit.length, '退出时刻磁盘上应该有那两行；缺了就是"没排空队列就 exit"，' +
      '而 process.exit 之后 libuv 不会替你补跑那一次 appendFile').toBe(2);

    // 反向对照（缺了它，"两边都没写"也会长得像成功）：同一批行**事后**一定读得到，
    // 说明上面那个 0 是"退出太早"，不是"日志根本没产生"
    await flushLogs();
    expect(linesWith(beforeExit).length, '排空之后这一行必须在盘上 —— 否则前面的 0 就没有意义').toBe(1);
    expect(linesWith(duringClose).length).toBe(1);
  });

  it('关不上服务也要退出、也要排空，并且把"为什么关不上"留在磁盘上', async () => {
    const beforeExit = newTraceId('exit');
    let exitCode: number | null = null;
    let atExit: string[] = [];

    logInfo('shutdown-test', 'queued-before-failing-close', { traceId: beforeExit });
    await gracefulExit('SIGINT', {
      log: () => undefined,
      closeApp: async () => {
        throw new Error('端口没关干净');
      },
      closeStore: async () => undefined,
      exit: (code) => {
        exitCode = code;
        atExit = linesWith(beforeExit);
      },
    });

    expect(exitCode, '关不上也得给出优雅退出的那个码：留在原地等死会变成 docker 的 SIGKILL（137）').toBe(0);
    expect(atExit.length, 'close 抛出时同样不许把队列里的行带走').toBe(1);
    // "关不上"这件事必须留下话，而不是被 exit(0) 静掉 —— 记不进日志的失败等于没人知道
    await flushLogs();
    const failure = readFileSync(logFileFor(), 'utf8')
      .split('\n')
      .filter((line) => line.includes('app.close.failed'));
    expect(failure.length, 'app.close() 抛出要在日志里留一行，否则退出码 0 会把故障说成成功').toBeGreaterThan(0);
    expect(failure.at(-1)).toContain('端口没关干净');
  });

  it('SIGINT 与 SIGTERM 都接上同一条序列（少接一个是"看起来能优雅退出"）', async () => {
    const subscribed: { signal: string; handler: () => void }[] = [];
    const traceId = newTraceId('exit');
    let exitCode: number | null = null;
    let atExit: string[] = [];

    installGracefulExit({
      log: () => undefined,
      closeApp: async () => undefined,
      closeStore: async () => undefined,
      exit: (code) => {
        exitCode = code;
        atExit = linesWith(traceId);
      },
      subscribe: (signal, handler) => void subscribed.push({ signal, handler }),
    });

    expect(subscribed.map((s) => s.signal).sort()).toEqual([...EXIT_SIGNALS].sort());

    // 光"注册了"不算：真走一遍处理器，它得把序列跑到退出，并且退出时刻队列已经排空
    logInfo('shutdown-test', 'queued-before-signal', { traceId });
    subscribed.find((s) => s.signal === 'SIGTERM')!.handler();
    await untilSettled('SIGTERM 的退出序列', () => exitCode !== null);
    expect(exitCode).toBe(0);
    expect(atExit.length, '信号那条路也要排空：组合根接的正是这一条，不是上面两条直接调用').toBe(1);
  });

  /**
   * 接线判据（**没有它上面三条都只是 `shutdown.ts` 的自说自话**）：
   * 组合根改成自己写一份 `process.exit(0)` 时，那三条照样全绿 —— 而线上丢的仍是尾部日志。
   * 本仓库管这种门叫"闸门一直是装饰"，所以这里按源码把退出点数量与排空位置钉住。
   */
  it('组合根只接这一条序列：没有第二个"没排空的退出点"', async () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source, '优雅退出必须走 `installGracefulExit`（判据在它那一侧）').toContain('installGracefulExit({');
    expect(source, '组合根里再出现 `process.exit(0)` 就等于排空这件事绕回了没人验的地方').not.toContain('process.exit(0)');
    const exits = [...source.matchAll(/process\.exit\((\d+)\)/g)].map((m) => m[1]);
    expect(exits, '组合根里剩下的退出点要一个一个说清：多一个是"丢尾部日志"的新入口').toEqual(['1']);
    expect(source, '启动失败那条 `process.exit(1)` 前面必须有排空').toMatch(/await flushLogs\(\);[\s\S]{0,80}process\.exit\(1\)/);
  });
});
