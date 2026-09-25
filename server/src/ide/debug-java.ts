import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { IDE_LIMITS } from './languages.js';
import { createWorkspace, type Workspace } from '../judge/workspace.js';
import { runProcess } from '../judge/process.js';
import { clipRepr, writeLine, type DebugBackend, type LaunchResult } from './debug-backend.js';
import type { DebugVar } from '@arena/shared';

/**
 * Java 后端（WI-82）：`javac -g` 编进一个沙箱，然后用管道驱动 `jdb`。
 *
 * 与 python 后端的差别只有一个：**jdb 说的是人话，不是 JSON**。
 * 所以这里必须有一个小状态机，而它完全建立在实测到的输出格式上（里程碑 AU 记了出处）：
 *
 *   Breakpoint hit: "thread=main", Main.main(), line=9 bci=3
 *   9            int y = x + 2;
 *   main[1]                        ← 提示符，**不带换行**
 *   Method arguments:
 *   args = instance of java.lang.String[0] (id=414)
 *   Local variables:
 *   x = 40
 *   main[1] ␠
 *   The application exited
 *
 * 三条因此而定：
 * 1. 停点行**不携带变量**，必须再问一次 `locals`，而"问完了"只能靠**下一个提示符**判定。
 *    但提示符不能当唯一的分段器：程序正常结束时 jdb 打完 `The application exited` 就自己退了，
 *    后面**没有提示符**（第一版因此把"跑完"报成"进程没了"）。所以是三段式：
 *    idle 按**完整行**处理 → 看到停点就等提示符 → 提示符来了才问 `locals` → 再等一个提示符收变量。
 * 2. 停点行后面紧跟一行**源码回显**（`9            int y = x + 2;`），它落在"等提示符"那一段里，
 *    整段丢掉即可 —— 不需要按形状猜哪行是回显。
 * 3. `javac` 不带 `-g` 时 jdb 直接说 "Local variable information not available"，
 *    所以调试这份**自己编**，不复用"运行"那条命令的产物（那条不带 -g，也不该带）。
 *    代价是调试前多花一次编译（实测零点几秒），换来的是变量真的读得到。
 *
 * jdb 的 `locals` **不给类型**（只给 `名字 = 值`），所以 DebugVar.type 留空而不是按值猜 int/long。
 *
 * 启动参数里的 `-J-Duser.language=en` 不是可选的：jdb 的消息跟着 JVM 的 locale 走，
 * 中文 Windows 上它打的是"断点已命中…"这类话（实测），而下面那套解析认的是英文原文。
 * 与 `ide/repl.ts` 给 jshell 加同一个参数是同一件事。
 */

const PROMPT_RE = /main\[\d+\]/;
const HIT_RE = /^(?:Breakpoint hit|Step completed): "thread=[^"]+", (.+?)\(\), line=(\d+)/;
const EXITED_RE = /^The application exited/;
const UNCAUGHT_RE = /^(?:Uncaught exception|Exception occurred)/;
/** jdb 自己的过程话术，不是用户程序的输出。 */
const JDB_CHATTER_RE = /^(?:Initializing jdb|VM Started|Set |Deferring |It will be set|Removed:|run \w+$|Local variable information|Method arguments:|Local variables:)/;

const COMPILE_TIMEOUT_MS = 30_000;
/** 问了 `locals` 之后最多等多久。没上界就等于把状态机交给 jdb 的心情。 */
const LOCALS_WAIT_MS = 3_000;

/** 去掉 jdb 加在提示符与程序输出前面的标记，只留用户真正看到的字。 */
function stripMarkers(line: string): string {
  return line.replace(/^[\s>]*(?:main\[\d+\][\s]*)?[\s>]*/, '').trim();
}

/**
 * jdb 的一行变量：可能是 `x = 40`（只有名字），也可能是 `int total = 0`（带声明类型）。
 * 类型前缀**必须要求后面跟一个真空格**才认：写成 `[\w$.<>[\]]*\s*` 的话，贪婪的那一段
 * 会把名字本身吃掉 —— `args = ...` 被解析成名字 `s`（真在浏览器里翻车过一次，
 * 而单测没发现，因为里面全是 `x` / `y` 这种单字符名）。
 */
const LOCAL_LINE_RE = /^(?:(?:final\s+)?[\w$.<>[\]]+\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;

function parseLocals(segment: string): DebugVar[] {
  const vars: DebugVar[] = [];
  for (const line of segment.split('\n')) {
    const text = line.trim();
    const m = LOCAL_LINE_RE.exec(text);
    if (!m) continue;
    const value = m[2] ?? '';
    const { repr, truncated } = clipRepr(value);
    // `instance of X (id=N)` 里带着类名，别的都没有类型信息 —— 有就用，没有就空着
    const type = /instance of (\S+)/.exec(value)?.[1] ?? '';
    vars.push({ name: m[1]!, type, repr, ...(truncated ? { truncated: true } : {}) });
  }
  return vars;
}

export const javaBackend: DebugBackend = {
  kind: 'java',
  async launch({ code, breakpoints, emit }): Promise<LaunchResult> {
    // tag 用 debug 而不是 ide-debug：runner.test.ts 数的是 `ide-` 前缀的沙箱，
    // 撞上前缀就等于两条测试互相弄红（它们本来就是并行的）
    const workspace: Workspace = await createWorkspace('debug');
    await workspace.write('Main.java', code);
    const built = await runProcess('javac', ['-g', '-J-Duser.language=en', '-encoding', 'UTF-8', 'Main.java'], {
      cwd: workspace.root,
      timeoutMs: COMPILE_TIMEOUT_MS,
      maxOutputChars: IDE_LIMITS.stdoutCapChars,
    });
    if (built.timedOut || built.code !== 0) {
      await workspace.cleanup();
      const text = [built.stdout, built.stderr].filter(Boolean).join('\n').trim();
      return {
        ok: false,
        event: { type: 'error', text: `编译失败：\n${text || 'javac 没有留下任何输出'}` },
      };
    }

    const child = spawn('jdb', ['-J-Duser.language=en', '-sourcepath', '.', 'Main'], {
      cwd: workspace.root,
      // 独立进程组：jdb 会另起一台被调试的 JVM，杀的时候要连它一起收
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    let buffer = '';
    // 'swallow' = 已经放弃这一问了，把迟到的答复整段丢掉（连它后面那个提示符一起），
    // 否则那些 `x = 40` 会被 idle 当成"程序打出来的字"吐给用户
    let phase: 'idle' | 'awaitPrompt' | 'awaitLocals' | 'swallow' = 'idle';
    let pendingHit: { line: number; func: string; reason: 'breakpoint' | 'step' } | null = null;

    /**
     * 写一条 jdb 命令。失败**必须**接住：写进一个刚关掉的 stdin 是异步错误
     * （`ERR_STREAM_WRITE_AFTER_END` / EPIPE），没人听 'error' 就等于让它在事件循环里
     * 抛成 uncaughtException —— 崩的是整个服务。收尾时（`quit`）进程本来就没了，那种失败直接咽下。
     */
    let failedOnce = false;
    const write = (command: string, teardown = false): void => {
      writeLine(child.stdin, command, (reason) => {
        if (teardown || failedOnce) return;
        failedOnce = true;
        emit({ type: 'error', text: `写不进 jdb：${reason}`, message: '调试进程已经不在了' });
      });
    };

    /**
     * 是不是标准库的帧。jdb 的 `step` 会一路走进 `java.lang.String.length()`，
     * 而那个 `line=1234` 是**库文件**的行号 —— 报上去，编辑器就把 ▶ 画到用户代码的第 1234 行。
     *
     * 判据是"有没有包名前缀"而不是"是不是 Main"：一份 Main.java 里写第二个类
     * （`class Point`）是刷题常态，那些帧**就在编辑器里**，说"没有源码可高亮"是谎话。
     * IDE 不挂用户 jar，所以 java.* / javax.* / jdk.* / sun.* 之外都可以当成用户代码。
     */
    const LIBRARY_FRAME_RE = /^(?:java|javax|jdk|sun|com\.sun)\./;
    const inUserClass = (func: string | undefined): boolean => !!func && !LIBRARY_FRAME_RE.test(func);

    const reportHit = (
      hit: { line: number; func: string; reason: 'breakpoint' | 'step' } | null,
      vars: DebugVar[],
      segment: string,
    ): void => {
      if (hit && !inUserClass(hit.func)) {
        emit({
          type: 'stopped',
          func: hit.func,
          reason: hit.reason,
          locals: [],
          message: `停在 Main.java 之外（${hit.func}）—— 那里没有源码可高亮，按步出回到你的代码`,
        });
        return;
      }
      emit({
        type: 'stopped',
        line: hit?.line,
        func: hit?.func,
        reason: hit?.reason ?? 'breakpoint',
        locals: vars,
        ...(vars.length === 0 && /Local variable information not available/.test(segment)
          ? { message: 'jdb 说这份 class 没有变量信息（编译时没带 -g？）' }
          : {}),
      });
    };

    let localsTimer: NodeJS.Timeout | null = null;
    const giveUpLocals = (): void => {
      localsTimer = null;
      if (phase !== 'awaitLocals') return;
      phase = 'swallow'; // 这一问的答案要是还来，丢掉
      const hit = pendingHit;
      pendingHit = null;
      phase = 'idle';
      emit({
        type: 'stopped',
        line: hit && inUserClass(hit.func) ? hit.line : undefined,
        func: hit?.func,
        reason: hit?.reason ?? 'breakpoint',
        locals: [],
        message: `jdb 在 ${LOCALS_WAIT_MS}ms 内没回变量表 —— 变量这一格是空的，不是"没有变量"`,
      });
    };

    /** idle 态逐行看：停点、结束、异常、程序输出。 */
    const onIdleLine = (rawLine: string): void => {
      const text = stripMarkers(rawLine);
      if (!text) return;
      const m = HIT_RE.exec(text);
      if (m) {
        pendingHit = {
          line: Number(m[2]),
          func: m[1] ?? '',
          reason: text.startsWith('Breakpoint hit') ? 'breakpoint' : 'step',
        };
        phase = 'awaitPrompt';
        return;
      }
      if (EXITED_RE.test(text)) {
        emit({ type: 'exited' });
        return;
      }
      if (UNCAUGHT_RE.test(text)) {
        emit({ type: 'error', text, message: '程序抛了未捕获的异常' });
        return;
      }
      if (JDB_CHATTER_RE.test(text)) return;
      emit({ type: 'output', text: `${text}\n` });
    };

    const pump = (): void => {
      for (;;) {
        if (phase === 'idle') {
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (let i = 0; i < lines.length; i++) {
            onIdleLine(lines[i] ?? '');
            if (phase !== 'idle') {
              // 命中停点：剩下那些行（源码回显 + 提示符）要还给下一态处理，不能吞掉
              buffer = [...lines.slice(i + 1), buffer].join('\n');
              // **break 而不是 return**：提示符可能已经在这段字节里了（jdb 会把
              // "停点行 + 源码回显 + 提示符"一次性吐出来）。直接 return 就没人再去找它，
              // 而 jdb 正在等我们的 `locals` —— 两边互等，10s 后超时。
              // 容器里 chunk 边界刚好错开所以看不出来，Windows 上必现。
              break;
            }
          }
          if (phase === 'idle') return; // 整批都是普通行，等下一个 chunk
        }
        const m = PROMPT_RE.exec(buffer);
        if (!m) return;
        const segment = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (phase === 'swallow') {
          void segment;
          phase = 'idle';
          continue;
        }
        if (phase === 'awaitPrompt') {
          void segment; // 停点与提示符之间只有源码回显，编辑器里已经有了
          phase = 'awaitLocals';
          write('locals');
          // 有上界地等：jdb 也可能永远不回这一问（进程被别的窗口共享、命令被吞）。
          // 没有这个定时器，状态机就停在这里等一次"新数据"，而新数据可能再也不来。
          localsTimer = setTimeout(() => giveUpLocals(), LOCALS_WAIT_MS);
          localsTimer.unref?.();
          continue;
        }
        if (localsTimer) {
          clearTimeout(localsTimer);
          localsTimer = null;
        }
        const vars = parseLocals(segment);
        const hit = pendingHit;
        pendingHit = null;
        phase = 'idle';
        reportHit(hit, vars, segment);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      pump();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => emit({ type: 'output', text: chunk }));

    for (const line of breakpoints) write(`stop at Main:${line}`);
    write('run');

    return {
      ok: true,
      handle: {
        child,
        send: (action) => {
          // 共享契约里的四个动作对应 jdb 的四条命令（实测 `step over` 在 JDK 17 的 jdb 里就有，
          // 不需要用"重复 step"去凑一个步过）
          if (action === 'continue') write('cont');
          else if (action === 'next') write('step over');
          else if (action === 'stepIn') write('step');
          else write('step up');
        },
        requestExit: () => {
          if (!child.stdin.writable) return;
          // `quit` 会连它自己起的被调试 JVM 一起收 —— 硬杀只杀得到 jdb，Windows 上会留孤儿。
          // 走 `write(..., teardown)`：这时管道本来就要断，失败要咽下而不是报成"程序出错了"。
          write('quit', true);
          child.stdin.end();
        },
        dispose: async () => {
          await workspace.cleanup();
        },
      },
    };
  },
};
