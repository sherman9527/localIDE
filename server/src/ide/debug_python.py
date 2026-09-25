"""网页 IDE 的 Python 行断点驱动（WI-81）。

被 `server/src/ide/debug.ts` 起成一个常驻子进程，双向都是**一行一个 JSON**：

    node →  {"cmd":"run","code":"...","breakpoints":[2,5]}
    node →  {"cmd":"step","action":"next"|"continue"|"stepIn"|"stepOut"}
    驱动 →  {"event":"stopped","line":2,"func":"<module>","reason":"breakpoint","locals":[...]}
    驱动 →  {"event":"output","text":"用户代码打出来的字"}
    驱动 →  {"event":"exited","code":0}
    驱动 →  {"event":"error","text":"traceback…"}

四条不是顺手写的，是被协议本身逼出来的：

1. **协议独占 stdout**。用户代码里 `print` 是常态，所以 `sys.stdout` 换成一个代理，
   它把写进来的字转成 `output` 事件；协议帧只往 `sys.__stdout__` 写。
   反过来的话，一行 `print` 就能把协议打断，node 那边收到的是半截 JSON。
2. **协议独占 stdin**。`sys.stdin` 换成空的 `StringIO` —— 否则用户代码里一个 `input()`
   就会把"继续"那条命令当输入吃掉，调试会话变成随机行为。
   代价写在提示里：调试时 `input()` 立刻 EOF，要试带 stdin 的程序请用"运行"。
3. **只跟用户自己那份代码**。文件名不是 `main.py` 的帧一律不跟踪，
   所以 `stepIn` 进标准库不会停 —— 断点槽只出现在编辑器里，而编辑器里只有用户代码。
4. **停下来 = 阻塞读命令**。行事件里直接 `readline()` 等下一条命令，
   不需要线程，也就没有"命令与执行抢同一份状态"的竞态。

行号从 **1** 起，与编辑器显示的一致；`breakpoints` 里的越界行号就是永远命中不了，
不报错也不假装停得住（跑完就是跑完）。
"""

import io
import json
import sys
import threading
import traceback

FILENAME = "main.py"
PROTO_OUT = sys.__stdout__
PROTO_IN = sys.stdin

VAR_REPR_CHARS = 240
MAX_LOCALS = 60


def emit(payload):
    """协议帧：整行 JSON，写完立刻 flush —— 对面在等这一行决定按钮要不要转圈。"""
    PROTO_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    PROTO_OUT.flush()


class CapturedWrite(object):
    """把用户代码的 print 转成 output 事件，绝不直接碰协议那条流。"""

    def __init__(self, stream_name):
        self.stream_name = stream_name

    def write(self, text):
        if text == "":
            return 0
        emit({"event": "output", "stream": self.stream_name, "text": str(text)})
        return len(text)

    def flush(self):
        return None

    def isatty(self):
        return False

    @property
    def closed(self):
        return False


class _EmptyStdin(io.StringIO):
    """空 stdin。**close() 必须是空操作**：解释器关闭时会析构挂在 sys.stdin 上的对象并调它，
    而 StringIO.close() 会把缓冲区扔掉 —— 之后任何一次 readline()/input() 都变成抛错，
    一个只读 stdin 的程序会在退出阶段被误判成"抛异常"（实测：SystemError: I/O operation on closed file）。
    """

    def close(self):
        return None


def read_command():
    line = PROTO_IN.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return {}
    try:
        return json.loads(line)
    except ValueError:
        return {}


def describe(frame):
    """当前帧的局部变量。读不到值的不能编一个上去 —— 标 `unknown` 并保留原因。"""
    items = []
    dropped = 0
    for name, value in frame.f_locals.items():
        if name.startswith("__"):
            continue  # 驱动与模块自带的东西（__builtins__ 之类），不是用户关心的变量
        if len(items) >= MAX_LOCALS:
            dropped += 1
            continue
        try:
            type_name = type(value).__name__
        except Exception:
            type_name = "unknown"
        try:
            text = repr(value)
        except Exception as err:  # 自定义 __repr__ 抛错是合法的，得说清而不是整个失败
            type_name = "unknown"
            text = "<repr 失败：%s>" % err
        truncated = len(text) > VAR_REPR_CHARS
        if truncated:
            text = text[:VAR_REPR_CHARS]
        items.append({"name": name, "type": type_name, "repr": text, "truncated": truncated})
    return items, dropped


class Stepper(object):
    def __init__(self, breakpoints):
        self.breakpoints = set(int(n) for n in breakpoints)
        self.mode = "continue"
        self.start_depth = 0
        self.start_line = None
        self.start_frame = None
        # 只有发起这次调试的那个线程能停下来等命令。
        # "单线程所以没有竞态"这个说法对**用户代码开线程**不成立：两个线程都阻塞在
        # readline 上时，一条命令只唤醒一个，另一个卡在 stopped 状态里 ——
        # 下一条单步就必然超时（而且超时之后整个会话作废）。
        self.owner = threading.get_ident()

    # --- 跟踪入口 -----------------------------------------------------------
    def global_trace(self, frame, event, arg):
        # 只有用户那份代码要跟踪：标准库的帧返回 None，等于对它完全关掉 trace
        if frame.f_code.co_filename != FILENAME:
            return None
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if event == "line":
            if self._should_stop(frame):
                self._stop(frame, "breakpoint" if frame.f_lineno in self.breakpoints else "step")
        return self.local_trace

    # --- 停不停 -------------------------------------------------------------
    def user_depth(self, frame):
        """这份代码里已经套了几层。

        为什么不用计数器 +1/-1：**'call' 事件到不了本帧的 local trace**（新帧由 global trace
        接管），所以"进函数"这件事在 local trace 里根本看不见，计数永远是 0 ——
        第一版就是这么把 `next` 写成"会停进函数体里"的（测试逮住的）。
        顺着 f_back 数只数用户文件里的帧，不依赖任何事件顺序。
        """
        depth = 0
        while frame is not None:
            if frame.f_code.co_filename == FILENAME:
                depth += 1
            frame = frame.f_back
        return depth

    def _should_stop(self, frame):
        if threading.get_ident() != self.owner:
            return False  # 工作线程照常跑，调试只跟着按下去的那条线
        if frame.f_lineno in self.breakpoints:
            return True
        if self.mode == "stepIn":
            return True
        if self.mode == "next":
            # 同帧换行，或从调用里回到本帧（或更外层）：都算"迈出了一步"。函数体里的行不算。
            if self.user_depth(frame) > self.start_depth:
                return False
            return frame is not self.start_frame or frame.f_lineno != self.start_line
        if self.mode == "stepOut":
            return self.user_depth(frame) < self.start_depth
        return False

    def _stop(self, frame, reason):
        vars_, dropped = describe(frame)
        payload = {
            "event": "stopped",
            "line": frame.f_lineno,
            "func": frame.f_code.co_name,
            "reason": reason,
            "locals": vars_,
        }
        if dropped:
            payload["message"] = "局部变量只给前 %d 个，还有 %d 个没列出" % (MAX_LOCALS, dropped)
        emit(payload)
        self._await_command(frame)

    def _await_command(self, frame):
        """阻塞等下一条命令。**没有线程**：调试时程序本来就停在栈上这一行。"""
        while True:
            cmd = read_command()
            if cmd is None:
                raise SystemExit  # 对面把管道关了（会话被回收/服务退出）
            action = cmd.get("action") if cmd.get("cmd") == "step" else None
            if action in ("continue", "next", "stepIn", "stepOut"):
                self.mode = action
                self.start_depth = self.user_depth(frame)
                self.start_line = frame.f_lineno
                self.start_frame = frame
                return
            # 认不出的命令：什么都不做，继续等（协议错乱不该把被调试的程序带崩）


def run(code, breakpoints):
    stepper = Stepper(breakpoints)
    sys.stdout = CapturedWrite("stdout")
    sys.stderr = CapturedWrite("stderr")
    sys.stdin = _EmptyStdin()  # 用户代码的 input() 立刻 EOF，不吃协议命令
    namespace = {"__name__": "__main__", "__file__": FILENAME}
    try:
        compiled = compile(code, FILENAME, "exec")
    except SyntaxError:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        emit({"event": "error", "text": traceback.format_exc()})
        return False
    sys.settrace(stepper.global_trace)
    exit_code = 0
    try:
        exec(compiled, namespace)
    except SystemExit as err:  # 用户自己 exit()：那是正常结束，不是错误
        code_arg = err.code
        exit_code = 0 if code_arg is None else (code_arg if isinstance(code_arg, int) else 1)
    except BaseException:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        emit({"event": "error", "text": traceback.format_exc()})
        return False
    sys.settrace(None)
    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__
    emit({"event": "exited", "code": exit_code})
    return True


def main():
    """一个进程只调一段代码：跑完 / 出错就退出，与 node 侧"会话到此作废"的判据一致。
    留着进程等下一条命令，等于让一个已经没意义的子进程占着名额。"""
    cmd = read_command()
    if not cmd or cmd.get("cmd") != "run":
        return
    try:
        ok = run(cmd.get("code") or "", cmd.get("breakpoints") or [])
    except BaseException:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        emit({"event": "error", "text": traceback.format_exc()})
        ok = False
    # 出错就以非零码结束：node 侧同时收到 error 与"进程正常退出"是自相矛盾的信号，
    # 而那个信号决定界面上写"跑完了"还是"出错了"
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
