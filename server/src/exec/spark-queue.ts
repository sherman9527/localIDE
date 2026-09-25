export type SparkPriority = 'judge' | 'ide';

/** 数值越小越先跑。判题优先：IDE 是"想立刻看一眼"，判题是"今天这一天的账"。 */
const RANK: Record<SparkPriority, number> = { judge: 0, ide: 1 };

interface Item<T> {
  rank: number;
  seq: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * 串行 + 优先级的任务队列（Spark worker 只有一个，见 `exec/spark-pool.ts`）。
 *
 * 三条不变式，都有测试钉住：
 *  1. 同一时刻最多一个任务在跑（并发峰值 1）—— 两个请求共用一个 JVM 的 stdout 必然互相读走；
 *  2. **不抢占**：已经开始的任务一定跑完，优先级只影响"还没开始的谁先走"；
 *  3. 同优先级 FIFO —— 否则后来的判题会被一串 IDE 任务饿死。
 *
 * 任务抛错只让那一个 promise reject，队列继续泵：worker 被超时杀掉之后，
 * 下一个请求必须还能拿到一个新会话，而不是整条队列卡死。
 */
export class PriorityQueue<T> {
  private items: Item<T>[] = [];
  private active: Promise<void> | null = null;
  private seq = 0;

  /** 还在排队的任务数（不含正在跑的那个）。UI 的"排队中"读它。 */
  get waiting(): number {
    return this.items.length;
  }

  get running(): boolean {
    return this.active !== null;
  }

  submit(run: () => Promise<T>, priority: SparkPriority = 'judge'): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const rank = RANK[priority] ?? RANK.judge;
    this.items.push({ rank, seq: ++this.seq, run, resolve, reject });
    this.items.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.active) return;
    const next = this.items.shift();
    if (!next) return;
    this.active = (async () => {
      try {
        next.resolve(await next.run());
      } catch (err) {
        next.reject(err);
      } finally {
        this.active = null;
        this.pump();
      }
    })();
  }
}
