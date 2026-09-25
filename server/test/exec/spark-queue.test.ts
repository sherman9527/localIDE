import { describe, expect, it, vi } from 'vitest';
import { PriorityQueue } from '../../src/exec/spark-queue.js';

/**
 * Spark 只有一个常驻 worker（JVM 冷启动实测 3~10s），所以判题与网页 IDE 必须排队共用它。
 * 排队规则单独成一个单元，是因为"谁先跑"这件事只有在这里能确定性验证 ——
 * 放进真 worker 里测就得靠时间戳猜，而本仓库对"靠 sleep 猜并发"已经有过前科。
 */

describe('PriorityQueue — Spark 的串行调度', () => {
  it('同一时刻只有一个任务在飞（并发峰值必须是 1）', async () => {
    const queue = new PriorityQueue<string>();
    let running = 0;
    let peak = 0;
    const work = (name: string, ms: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return name;
    };
    const done = await Promise.all([
      queue.submit(work('a', 12), 'judge'),
      queue.submit(work('b', 6), 'judge'),
      queue.submit(work('c', 2), 'judge'),
    ]);
    expect(done).toEqual(['a', 'b', 'c']);
    expect(peak, `并发峰值 ${peak}：串行队列被打破了`).toBe(1);
  });

  it('判题插到已排队的 IDE 任务前面，但绝不打断正在跑的那个', async () => {
    const queue = new PriorityQueue<string>();
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 4));
      return name;
    };
    const running = queue.submit(work('running'), 'ide');
    await new Promise((r) => setTimeout(r, 1)); // 让 running 真的开始
    const firstIde = queue.submit(work('ide-1'), 'ide');
    const secondIde = queue.submit(work('ide-2'), 'ide');
    const judge = queue.submit(work('judge-1'), 'judge');
    const judge2 = queue.submit(work('judge-2'), 'judge');
    await Promise.all([running, firstIde, secondIde, judge, judge2]);

    expect(order[0], '已经开始的任务不许被抢占').toBe('running');
    expect(order.slice(1)).toEqual(['judge-1', 'judge-2', 'ide-1', 'ide-2']);
  });

  it('同优先级按提交顺序（FIFO），否则长任务会把后来的判题饿死', async () => {
    const queue = new PriorityQueue<number>();
    const order: number[] = [];
    const submitAll = Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.submit(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 1));
          return n;
        }, 'judge'),
      ),
    );
    await submitAll;
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('一个任务抛错不许卡住队列（后面的任务照样跑）', async () => {
    const queue = new PriorityQueue<string>();
    const boom = queue.submit(async () => {
      throw new Error('worker 挂了');
    }, 'judge');
    const after = queue.submit(async () => 'ok', 'judge');
    await expect(boom).rejects.toThrow('worker 挂了');
    await expect(after).resolves.toBe('ok');
  });

  it('队列空了之后还能继续接活（不是"跑完一轮就废"）', async () => {
    const queue = new PriorityQueue<string>();
    await queue.submit(async () => 'first', 'judge');
    await queue.submit(async () => 'second', 'ide');
    expect(queue.waiting).toBe(0);
    await expect(queue.submit(async () => 'third', 'judge')).resolves.toBe('third');
  });

  it('size/waiting 报的是真实排队数（UI 的"排队中"要靠它）', async () => {
    const queue = new PriorityQueue<string>();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    const running = queue.submit(async () => {
      await gate;
      return 'running';
    }, 'judge');
    const queued = [queue.submit(async () => 'a', 'ide'), queue.submit(async () => 'b', 'judge')];
    await vi.waitFor(() => expect(queue.waiting).toBe(2));
    release();
    await running;
    await Promise.all(queued);
    expect(queue.waiting).toBe(0);
    expect(queue.running).toBe(false);
  });
});
