#!/usr/bin/env python3
"""
草稿预检（出题循环里的本地闸门）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮矩阵要 20-60s。
用例的 expected 是手算的，手算就会错（本次出题真的错过两次）。
这个脚本用 Python 把参考解**重新实现一遍**并跑所有用例，
在提交给容器之前先把"用例自相矛盾 / expected 算错"筛掉。

它不能替代容器判题：Python 与 Java 的 long 溢出语义不同，
所以溢出类用例这里会显式模拟 64 位回绕。

用法：
    python scripts/bank/drafts/deepseek/precheck.py <草稿.json 或 草稿目录> [...]
    python scripts/bank/drafts/deepseek/precheck.py data/drafts-ds/out   # 整批
"""
import json
import os
import sys

INT64 = 1 << 64
INT64_MAX = (1 << 63) - 1
INT64_MIN = -(1 << 63)


def wrap64(x: int) -> int:
    """模拟 Java long 溢出回绕。"""
    x &= INT64 - 1
    return x - INT64 if x > INT64_MAX else x


def load(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.endswith('.json'):
                    out.append(os.path.join(p, name))
        elif p.endswith('.json'):
            out.append(p)
    return out


# ---------------------------------------------------------------- 参考解注册表
# 每个函数是 content/questions 里对应 Java/Python 参考解的**逐行等价重写**。
# 新增题目时在这里补一条；没有登记草稿会被标成 SKIP 而不是假装通过。
REGISTRY = {}


def solves(key):
    def deco(fn):
        REGISTRY[key] = fn
        return fn
    return deco


@solves('alg-java-0021')
def token_bucket(tokens, elapsed, rate, cap, cost):
    if tokens < 0:
        raise ValueError('dirty bucket state')
    if cost < 0:
        raise ValueError('negative cost')
    if cost > cap:
        raise ValueError('cost exceeds capacity')
    if elapsed > 0 and rate > 0 and cap > 0 and tokens < cap:
        need = cap - tokens
        saturate_at = need * 1_000_000 // rate + 1
        if elapsed >= saturate_at:
            tokens = cap
        elif elapsed > INT64_MAX // rate:
            tokens = cap
        else:
            add = wrap64(elapsed * rate) // 1_000_000
            tokens = min(cap, wrap64(tokens + add))
    tokens = min(tokens, cap)
    return tokens if tokens < cost else tokens - cost


@solves('alg-java-0022')
def max_sessions(free, blocks_per_session):
    if blocks_per_session <= 0:
        raise ValueError('bad session footprint')
    if free is None:
        raise ValueError('null bitmap')
    run = 0
    total = 0
    for bit in free:
        if bit != 0 and bit != 1:
            raise ValueError('dirty bitmap')
        if bit == 0:
            run += 1
        else:
            run = 0
        if run == blocks_per_session:
            total += 1
            run = 0
    return total


@solves('alg-java-0023')
def admit_waiting(running, waiting, budget):
    if budget < 0:
        raise ValueError('negative budget')
    used = 0
    for r in running:
        if r < 0:
            raise ValueError('negative remaining')
        used += r                      # Python 无溢出，等价于 Java 的 long 累加
    if used >= budget:
        return 0
    left = budget - used
    n = 0
    for w in sorted(waiting):
        if w < 0:
            raise ValueError('negative prompt length')
        if w <= left:
            left -= w
            n += 1
        else:
            break
    return n


@solves('alg-deepseek-prefix-cache')
def prefix_cache(prompts, block_size):
    """prefillCost：块对齐 + 链式 key + 尾块不落盘。"""
    if block_size <= 0:
        raise ValueError('bad block size')
    cached = set()
    total = 0
    for prompt in prompts:
        for token in prompt:
            if token < 0:
                raise ValueError('dirty token id')
        full = len(prompt) // block_size
        chain = []
        reuse_blocks = 0
        for b in range(full):
            chain.append(tuple(prompt[b * block_size:(b + 1) * block_size]))
            if tuple(chain) in cached:
                reuse_blocks = b + 1
            else:
                break
        total += len(prompt) - reuse_blocks * block_size
        sub = []
        for b in range(full):
            sub.append(tuple(prompt[b * block_size:(b + 1) * block_size]))
            cached.add(tuple(sub))
    return total


@solves('alg-deepseek-moe-capacity')
def moe_dropped(routing, num_experts, capacity):
    """droppedTokens：全部或全无，被丢的 token 不占任何专家名额。"""
    if num_experts <= 0:
        raise ValueError('bad expert count')
    if capacity <= 0:
        raise ValueError('bad capacity')
    load = [0] * num_experts
    dropped = 0
    for chosen in routing:
        if not chosen:
            raise ValueError('token routed to no expert')
        for e in chosen:
            if e < 0 or e >= num_experts:
                raise ValueError('expert id out of range')
        if len(set(chosen)) != len(chosen):
            raise ValueError('duplicated expert for one token')
        if all(load[e] < capacity for e in chosen):
            for e in chosen:
                load[e] += 1
        else:
            dropped += 1
    return dropped


# ------------------------------------------------- DeepSeek batch 3（滑动窗口 / 集群派发）
@solves('alg-deepseek-admission-window')
def admitted(arrivals, limit, window):
    """滑动窗口日志的独立重写：用双端队列而不是列表 pop(0)，刻意与 gen.py 走不同实现路径。"""
    from collections import deque

    if limit <= 0:
        raise ValueError('limit must be positive')
    if window <= 0:
        raise ValueError('window must be positive')
    q = deque()
    out = []
    last = None
    for t in arrivals:
        if t < 0:
            raise ValueError('negative arrival')
        if last is not None and t < last:
            raise ValueError('arrivals must be non-decreasing')
        last = t
        while q and q[0] <= t - window:
            q.popleft()
        if len(q) < limit:
            q.append(t)
            out.append(True)
        else:
            out.append(False)
    return out


@solves('alg-deepseek-least-loaded-dispatch')
def dispatch(starts, costs, durations, num_instances):
    """独立重写：用「剩余时间片」表 + 每次全量求和，不复用 gen.py 的 loads 增量维护。"""
    if num_instances <= 0:
        raise ValueError('numInstances must be positive')
    if not (len(starts) == len(costs) == len(durations)):
        raise ValueError('length mismatch')
    jobs = [[] for _ in range(num_instances)]      # 每实例 [(finish, cost)]
    out = []
    for idx, (s, c, d) in enumerate(zip(starts, costs, durations)):
        if idx and s < starts[idx - 1]:
            raise ValueError('starts must be non-decreasing')
        if s < 0:
            raise ValueError('negative start')
        if c <= 0:
            raise ValueError('cost must be positive')
        if d < 0:
            raise ValueError('duration must not be negative')
        jobs = [[(f, k) for (f, k) in j if f > s] for j in jobs]
        loads = [sum(k for _, k in j) for j in jobs]
        top = min(loads)
        pick = loads.index(top)                     # index() 天然取第一个最小 ⇒ 并列取下标最小
        out.append(pick)
        jobs[pick].append((s + d, c))
    return out


@solves('fe-deepseek-sse-frames')
def sse_frames(chunks):
    """独立重写：用"占位符归一化 + split"切行，与 gen.py 的逐字符状态机走完全不同的路径。"""
    if chunks is None:
        raise ValueError('chunks must be an array')
    text = ''
    for c in chunks:
        if c is None:
            raise ValueError('chunk must be a string')
        text += c
    text = text.replace('\r\n', '\n').replace('\r', '\n')   # 三种行结束符归一
    out = []
    data = []
    saw = False
    for line in text.split('\n'):
        if line == '':
            if saw:
                out.append('\n'.join(data))
            data, saw = [], False
            continue
        if line.startswith(':'):
            continue
        field, _, value = line.partition(':')
        if value.startswith(' '):
            value = value[1:]
        if field == 'data':
            data.append(value)
            saw = True
    return out


@solves('alg-deepseek-epoll-trigger-mode')
def epoll_trigger_mode(bytes_, chunk, edge, drains, max_wakes):
    """
    逐次**模拟**唤醒（参考解是闭式算的）。两条路算出同一组数，
    才说明"极大字节数那条"的 expected 不是手算蒙的。
    """
    if bytes_ < 0:
        raise ValueError('negative bytes')
    if chunk <= 0:
        raise ValueError('chunk must be positive')
    if max_wakes < 0:
        raise ValueError('negative maxWakeups')
    if bytes_ == 0:
        return [0, 0, 0]
    if max_wakes == 0:
        return [0, 0, bytes_]
    left, processed, wakes = bytes_, 0, 0
    limit = 1 if edge else max_wakes          # ET 只有一次机会；drains 在那一次里读干净
    while wakes < limit and left > 0:
        wakes += 1
        while True:
            took = min(chunk, left)
            left -= took
            processed += took
            if not drains or took == 0:
                break
    return [processed, wakes, left]


# ------------------------------------------------------------------------ 主流程
def main(argv):
    files = load(argv)
    if not files:
        print('没有 .json 草稿可检查', file=sys.stderr)
        return 2
    failed = 0
    for path in files:
        q = json.load(open(path, encoding='utf-8'))
        # 草稿阶段还没有 id（入库时才分配），所以文件名优先；入库后的正式题目用自带 id。
        qid = os.path.splitext(os.path.basename(path))[0] or q.get('id')
        cases = q.get('cases') or []
        fn = REGISTRY.get(qid)
        if fn is None:
            print(f'SKIP {qid}  未登记参考解重写（{path}）')
            continue
        bad = []
        for c in cases:
            try:
                got = fn(*c['input'])
                raised = None
                raised_msg = None
            except Exception as e:  # noqa: BLE001
                got = f'raise:{e}'
                raised = e.__class__.__name__
                raised_msg = str(e)
            throw = c.get('expectThrow')
            if throw:
                # ArenaTest.java 的契约型用例语义：只看抛出的异常简单类名，
                # expected 字段被完全忽略（schema 要求这个 key 存在，惯例填 null）。
                if raised is None:
                    bad.append(f'{c["name"]}: 期望抛 {throw}，实际正常返回 {got}')
                elif c.get('throwMessage') and raised_msg != c['throwMessage']:
                    # 只判"抛了没抛"会让两条语义不同的用例收敛成同一条（本仓库真的发生过：
                    # input 多包了一层数组，于是"整个入参为 null"与"元素为 null"测的是同一件事）
                    bad.append(f'{c["name"]}: 期望消息 "{c["throwMessage"]}"，实际 "{raised_msg}"')
                elif throw == 'Error':
                    # react-vitest 题的契约只到"抛了个 Error"，Python 侧任何异常都算对上
                    pass
                elif raised != throw and not (throw == 'IllegalArgumentException' and raised == 'ValueError'):
                    bad.append(f'{c["name"]}: 期望抛 {throw}，实际抛 {raised}')
                continue
            exp = c['expected']
            if got != exp:
                bad.append(f'{c["name"]}: expected={exp} got={got}')
        if bad:
            failed += 1
            print(f'FAIL {qid}')
            for b in bad:
                print(f'       {b}')
        else:
            print(f'ok   {qid}  ({len(cases)} 用例)')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
