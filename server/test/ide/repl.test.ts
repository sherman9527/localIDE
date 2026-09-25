import { describe, expect, it } from 'vitest';
import { IDE_LANGUAGES, findLanguage } from '../../src/ide/languages.js';
import { ideAvailability } from '../../src/ide/runner.js';
import {
  REPL_IDLE_MS,
  REPL_MAX_SESSIONS,
  feedRepl,
  replLanguages,
  replSessions,
  startRepl,
  stopRepl,
  sweepIdleReplSessions,
} from '../../src/ide/repl.js';

/**
 * IDE 的 REPL 面板（WI-77）。
 *
 * 这一批验的不是"能起进程"，而是**会话状态真的活着**：上一句定义的变量下一句读得回来 ——
 * 那是 REPL 相对"点一次运行"唯一的增量。每次起新进程的假实现会立刻在这里红。
 *
 * 与判题矩阵同一套纪律：宿主机没有 python3/jshell，缺运行时的那几条 skip，全绿要在容器里看。
 * 每条用例自己关会话：会话就是进程，漏关等于留孤儿。
 */

const available = await ideAvailability();
const guarded = (id: string) => (available[id] === true ? it : it.skip);

async function withRepl(language: string, body: (id: string) => Promise<void>): Promise<void> {
  const started = await startRepl(language);
  if (!started.session) throw new Error(`起不来：${started.message}`);
  try {
    await body(started.session.id);
  } finally {
    await stopRepl(started.session.id);
  }
}

describe('REPL 注册表', () => {
  it('只有"镜像里真有交互式运行时"的语言声明 replKind', () => {
    expect(IDE_LANGUAGES.filter((l) => l.replKind).map((l) => l.id).sort()).toEqual([
      'java', 'javascript', 'python',
    ]);
    // ts-node 不在镜像里 —— 给了就是一个"选了却起不来"的语言
    expect(findLanguage('typescript')?.replKind, 'TypeScript 没有离线 REPL').toBeUndefined();
    for (const id of ['python', 'javascript', 'java'] as const) {
      expect(replLanguages[id]?.command, id).toBeTruthy();
    }
  });

  it('并发上限与空闲回收是设计值（改它要连这条一起改）', () => {
    expect(REPL_MAX_SESSIONS).toBe(2);
    expect(REPL_IDLE_MS).toBe(5 * 60_000);
  });
});

describe('REPL 会话', () => {
  guarded('python')('python：上一句定义的变量，下一句读得回来', async () => {
    await withRepl('python', async (id) => {
      expect((await feedRepl(id, 'x = 41')).status).toBe('ok');
      const out = await feedRepl(id, 'print(x + 1)');
      expect(out.status, out.output).toBe('ok');
      expect(out.output).toContain('42');
    });
  });

  guarded('python')('python：整块一次喂进去（def + 缩进体），块后面那句不许被吞', async () => {
    await withRepl('python', async (id) => {
      const def = await feedRepl(id, 'def twice(n):\n    return n * 2');
      expect(def.status, def.output).toBe('ok');
      const call = await feedRepl(id, 'print(twice(21))');
      expect(call.status, call.output).toBe('ok');
      expect(call.output).toContain('42');
    });
  });

  guarded('python')('python：报错不杀会话，traceback 回给我，之后还能接着算', async () => {
    await withRepl('python', async (id) => {
      const boom = await feedRepl(id, 'raise ValueError("boom")');
      expect(boom.output).toContain('ValueError');
      const after = await feedRepl(id, 'print("alive")');
      expect(after.status, after.output).toBe('ok');
      expect(after.output).toContain('alive');
    });
  });

  guarded('javascript')('node：const 留在会话里，且表达式结果看得见', async () => {
    await withRepl('javascript', async (id) => {
      expect((await feedRepl(id, 'const nums = [3, 1, 2]')).status).toBe('ok');
      const out = await feedRepl(id, 'nums.sort((a, b) => a - b)');
      expect(out.status, out.output).toBe('ok');
      expect(out.output).toContain('1, 2, 3');
      // 引导脚本必须把 banner 与 undefined 噪声关掉，否则每句都带一行 undefined
      expect(out.output).not.toContain('Welcome to Node.js');
      expect(out.output.trim()).not.toBe('undefined');
    });
  });

  guarded('java')('jshell：变量跨句存活，且不起第二个执行 JVM', async () => {
    await withRepl('java', async (id) => {
      expect((await feedRepl(id, 'int base = 20;')).status).toBe('ok');
      const out = await feedRepl(id, 'base * 2 + 1');
      expect(out.status, out.output).toBe('ok');
      expect(out.output).toContain('41');
      const boom = await feedRepl(id, 'throw new IllegalStateException("bad");');
      expect(boom.status).toBe('error');
      expect(boom.output).toContain('IllegalStateException');
    });
  });

  it('不存在的会话与已关的会话：说清原因，不抛未捕获异常', async () => {
    const missing = await feedRepl('nope-1', 'print(1)');
    expect(missing.status).toBe('gone');
    expect(missing.output).toMatch(/没有这个会话/);

    const started = await startRepl('python');
    if (!started.session) return;   // 宿主没装 python3，这条留给容器
    const id = started.session.id;
    await stopRepl(id);
    expect((await feedRepl(id, 'print(1)')).status).toBe('gone');
    await stopRepl(id);             // 关两次不许炸
  });

  it('这门语言没有 REPL 时，start 明确说"没有"', async () => {
    const res = await startRepl('markdown');
    expect(res.session).toBeNull();
    expect(res.message).toMatch(/没有 REPL/);
  });

  guarded('python')(`并发上限 ${REPL_MAX_SESSIONS}：第 ${REPL_MAX_SESSIONS + 1} 个被拒且说清为什么`, async () => {
    const opened = await Promise.all(Array.from({ length: REPL_MAX_SESSIONS }, () => startRepl('python')));
    for (const one of opened) expect(one.session, one.message).not.toBeNull();
    try {
      const extra = await startRepl('python');
      expect(extra.session).toBeNull();
      expect(extra.message).toMatch(/已有 2 个会话/);
    } finally {
      for (const one of opened) await stopRepl(one.session?.id ?? '');
    }
  });

  guarded('python')('空闲回收：没到点一个都不杀；过点的杀掉；**正在跑一句的那条不许动**', async () => {
    const a = await startRepl('python');
    const b = await startRepl('python');
    if (!a.session || !b.session) return;
    const aId = a.session.id;
    const bId = b.session.id;
    try {
      await feedRepl(bId, 'x = 1');
      expect(replSessions().map((s) => s.id).sort()).toEqual([aId, bId].sort());

      // 三条**互相独立**的断言：只验"过点会杀"的话，把阈值改成 0 也照样全杀光
      expect(await sweepIdleReplSessions(Date.now(), REPL_IDLE_MS)).toEqual([]);
      const busy = feedRepl(bId, 'import time\ntime.sleep(2)\nprint("done")');
      const killed = await sweepIdleReplSessions(Date.now() + REPL_IDLE_MS + 60_000, REPL_IDLE_MS);
      expect(killed).toEqual([aId]);
      expect(replSessions().map((s) => s.id)).toEqual([bId]);
      expect((await feedRepl(aId, 'print(1)')).status).toBe('gone');
      // 被回收的那条不能顺手把正在跑的那条一起丢掉
      const stillRunning = await busy;
      expect(stillRunning.status, stillRunning.output).toBe('ok');
      expect(stillRunning.output).toContain('done');
    } finally {
      await stopRepl(aId);
      await stopRepl(bId);
    }
  });

  guarded('python')('跑飞了（死循环）：这一句超时被标出来，会话作废而不是挂住服务', async () => {
    await withRepl('python', async (id) => {
      const stuck = await feedRepl(id, 'while True:\n    pass', 2_000);
      expect(stuck.status).toBe('timeout');
      expect(stuck.output).toMatch(/超过|超时/);
      // 超时的会话状态不可知（可能还在吃 CPU），必须已经作废
      expect((await feedRepl(id, 'print(1)')).status).toBe('gone');
      expect(replSessions().find((s) => s.id === id)).toBeUndefined();
    });
  });
});
