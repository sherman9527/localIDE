#!/usr/bin/env python3
"""
阿里巴巴草稿的本地预检（与 pdd / bytedance / airbnb / apple / deepseek 的 precheck.py 同一套纪律）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮要几十秒到几分钟；
而用例的 expected 是 gen.py 里那份模型算的，**模型就会错**
（本批 A6 的第一版就把"按组取子序列"写成了按下标比较，逆序对恒为 0 —— 矩阵抓不到这种错，
 因为它只比"参考解 vs 朴素解结果是否不同"，而这里两份实现都是对的）。
所以这里刻意**不 import gen.py**：每道题换一种算法重写一遍，
两处独立实现给出同一个数，才算交叉验证。

它不能替代容器判题：
- Java 的整数除法/取模语义、数组越界、异常类型只能由真 JDK 证明；
- MySQL 的三值逻辑与窗口函数帧语义、Redis 的命令语法与最终状态、Spark 的会话时区，
  本机都没有这些引擎 —— 未登记的草稿打印 **SKIP**，不假装通过。
  （redis 题在这里就是 SKIP：参考解是一段命令脚本，判分靠服务端最终状态。）

用法：
    python scripts/bank/drafts/alibaba/precheck.py [data/drafts-ab/out]
"""
import json
import os
import sys
from decimal import Decimal

MODELS = {}


def reg(key):
    def deco(fn):
        MODELS[key] = fn
        return fn
    return deco


class Bail(Exception):
    """模型层的"必须抛错"，message 与 Java 侧的异常消息一一对应。"""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def need(cond, message):
    if not cond:
        raise Bail(message)


# ================================================== A1 AT 可见性（用"逐时刻物化时间线"重写）
@reg('alg-ab-seata-at-isolation')
def m_at(initial, max_wait, read_tick, read_kind, tx_commit, tx_finish, tx_value, tx_outcome):
    need(initial >= 0, 'value must be non-negative')
    need(max_wait >= 0, 'max wait must be non-negative')
    need(len(read_tick) == len(read_kind), 'array length mismatch')
    need(len(tx_commit) == len(tx_finish) == len(tx_value) == len(tx_outcome), 'array length mismatch')
    for i, t in enumerate(read_tick):
        need(t >= 0, 'negative tick')
        need(read_kind[i] in (0, 1), 'read kind must be 0 or 1')
        need(i == 0 or t > read_tick[i - 1], 'read ticks must increase')
    for i in range(len(tx_commit)):
        need(tx_commit[i] >= 0 and tx_finish[i] >= 0, 'negative tick')
        need(tx_value[i] >= 0, 'value must be non-negative')
        need(tx_outcome[i] in (0, 1), 'outcome must be 0 or 1')
        need(tx_finish[i] > tx_commit[i], 'finish must be after commit')
    for i in range(1, len(tx_commit)):
        a, b = (tx_commit[i - 1], tx_finish[i - 1]), (tx_commit[i], tx_finish[i])
        need(a[1] <= b[0] or b[1] <= a[0], 'overlapping global locks')

    # 独立做法：不递归、不查 producer，而是把行值在"每个关心的时刻"上物化出来。
    # 关心的时刻 = 所有读时刻 + 所有 commit/finish + finish-1（回滚生效就发生在 finish）。
    marks = sorted(set(list(read_tick) + list(tx_commit) + list(tx_finish) + [0]))

    def value_line(t):
        """从 0 走到 t，逐段套用"提交即生效 / 终审回滚即退回"。"""
        cur = initial
        history = [cur]                      # 已生效值栈：本地提交的先后顺序
        for i in sorted(range(len(tx_commit)), key=lambda k: tx_commit[k]):
            if tx_commit[i] > t:
                break
            history.append(tx_value[i])
            if tx_outcome[i] == 1 and tx_finish[i] <= t:
                history.pop()                # 反向补偿：把这一层的写入撤掉
        return history[-1]

    def holder_at(t):
        for i in range(len(tx_commit)):
            if tx_commit[i] <= t < tx_finish[i]:
                return i
        return -1

    out = []
    for r in range(len(read_tick)):
        t = read_tick[r]
        if read_kind[r] == 1:
            waited, budget_used = False, 0
            cur = t
            while True:
                h = holder_at(cur)
                if h < 0:
                    break
                budget_used = cur - t        # 已经等到的时长（下一次判定前刷新）
                cur = tx_finish[h]
                waited = True
                if cur - t > max_wait:
                    break
            if cur - t > max_wait:
                out += [-1, 4]
                continue
            out += [value_line(cur), 2 if waited else 0]
        else:
            h = holder_at(t)
            if h >= 0:
                code = 3 if tx_outcome[h] == 1 else 1
            else:
                code = 0
            out += [value_line(t), code]
    return out


# ================================================== A2 消费重试（用"重放整条投递历史"重写）
@reg('alg-ab-consume-retry')
def m_retry(mode, failed, max_retry, orderly, invisible, cost):
    need(mode in (0, 1, 2), 'unknown consumer mode')
    need(failed >= 0, 'negative failed attempt')
    need(max_retry >= 0, 'maxRetry must be non-negative')
    need(orderly >= 0, 'orderly interval must be non-negative')
    need(mode != 2 or invisible > 0, 'invisible duration must be positive')
    need(cost >= 0, 'negative cost')

    # 独立做法：不查表下标，而是把"第 1..n 次重试"逐次累加，最后一次就是答案。
    ladder = [10, 30, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 1200, 1800, 3600, 7200]
    delays = []
    for n in range(1, failed + 2):           # 含"下一次"
        if mode == 0:
            delays.append(ladder[n - 1] * 1000 if n <= len(ladder) else ladder[-1] * 1000)
        elif mode == 1:
            delays.append(orderly)
        else:
            delays.append(invisible - cost if invisible > cost else 0)
    delivered = 1 + (failed if failed < max_retry else max_retry)
    if failed >= max_retry:
        return [0, 0, 1, delivered]
    return [delays[-1], failed + 1, 0, delivered]


# ================================================== A3 定时续投（用"逐跳推进"重写，不做除法）
@reg('alg-ab-timer-horizon')
def m_timer(deliver_at, now, horizon, lead):
    need(horizon > 0, 'horizon must be positive')
    need(lead >= 0, 'refire lead must be non-negative')
    need(horizon > lead, 'hop reach must be positive')
    need(now >= 0, 'now must be non-negative')
    if deliver_at <= now:
        return [0, now, 1, 0]
    if deliver_at - now <= horizon:
        return [1, deliver_at, 0, deliver_at - now]

    reach = horizon - lead
    cursor = now
    hops = 0
    first = None
    while deliver_at - cursor > reach:       # 一跳装不下 -> 先投一个中间检查点
        cursor += reach
        hops += 1
        if first is None:
            first = cursor
    hops += 1                                # 最后一跳：从 cursor 一步投到 deliverAt
    if first is None:
        first = deliver_at
    return [hops, first, 0, deliver_at - cursor]


# ================================================== A4 系统自适应保护（用规则表 + 谓词重写）
@reg('alg-ab-system-adaptive-admission')
def m_sys(cores, max_qps, min_rt, rt_hard, thread_limit, load, rt, inflight, qps, entry):
    need(cores > 0, 'cores must be positive')
    need(max_qps > 0, 'maxQps must be positive')
    need(min_rt > 0, 'min rt must be positive')
    need(rt_hard >= min_rt, 'rt hard limit below min rt')
    need(thread_limit >= 0, 'thread limit must be non-negative')
    n = len(load)
    need(len(rt) == n and len(inflight) == n and len(qps) == n and len(entry) == n,
         'array length mismatch')
    for i in range(n):
        need(load[i] >= 0, 'negative load')
        need(rt[i] >= 0, 'negative rt')
        need(inflight[i] >= 0, 'negative inflight')
        need(qps[i] >= 0, 'negative qps')
        need(entry[i] in (0, 1), 'isEntry must be 0 or 1')

    load_limit = cores * 25
    admitted = denied = gate = 0
    last_full = -1
    for i in range(n):
        # 独立做法：把五档写成 (名字, 谓词) 列表，逐个匹配 —— 顺序错误会体现在命中的名字上
        actions = [
            ('entry-only', entry[i] == 0, lambda: qps[i]),
            ('rt-hard', rt[i] > rt_hard, lambda: 0),
            ('threads', inflight[i] > thread_limit, lambda: 0),
            ('load-gate', load[i] > load_limit,
             lambda: min(qps[i], max_qps * min_rt // (rt[i] if rt[i] else min_rt))),
            ('pass', True, lambda: qps[i]),
        ]
        name, _, fn = next(a for a in actions if a[1])
        if name == 'load-gate':
            gate += 1
        ok = fn()
        admitted += ok
        denied += qps[i] - ok
        if ok == 0 and qps[i] > 0:
            last_full = i
    return [admitted, denied, gate, last_full]


# ================================================== A5 TCC（用迁移表 dict 重写）
@reg('alg-ab-tcc-lifecycle')
def m_tcc(xid, bid, action):
    n = len(xid)
    need(len(bid) == n and len(action) == n, 'array length mismatch')
    S_NONE, S_TRIED, S_CONF, S_CANC, S_EMPTY = 'NONE', 'TRIED', 'CONFIRMED', 'CANCELLED', 'EMPTY'
    # 表：状态 × 动作 -> (新状态, 计数字段..., 是否调用业务方法)
    table = {
        (S_NONE, 0): (S_TRIED, ('try_ok',), 1),
        (S_TRIED, 0): (S_TRIED, ('replay',), 0),
        (S_CONF, 0): (S_CONF, ('replay',), 0),
        (S_CANC, 0): (S_CANC, ('suspended',), 0),
        (S_EMPTY, 0): (S_EMPTY, ('suspended',), 0),
        (S_NONE, 1): (S_NONE, ('orphan_confirm',), 0),
        (S_TRIED, 1): (S_CONF, ('confirm_ok',), 1),
        (S_CONF, 1): (S_CONF, ('replay',), 0),
        (S_CANC, 1): (S_CANC, ('confirm_after_cancel',), 0),
        (S_EMPTY, 1): (S_EMPTY, ('confirm_after_cancel',), 0),
        (S_NONE, 2): (S_EMPTY, ('cancel_ok', 'empty_rollback'), 0),
        (S_TRIED, 2): (S_CANC, ('cancel_ok',), 1),
        (S_CONF, 2): (S_CONF, ('cancel_after_confirm',), 0),
        (S_CANC, 2): (S_CANC, ('replay',), 0),
        (S_EMPTY, 2): (S_EMPTY, ('replay',), 0),
    }
    tally = dict(try_ok=0, confirm_ok=0, cancel_ok=0, empty_rollback=0, suspended=0,
                 orphan_confirm=0, cancel_after_confirm=0, confirm_after_cancel=0,
                 replay=0, business=0)
    state = {}
    for i in range(n):
        need(xid[i] >= 0 and bid[i] >= 0, 'negative transaction id')
        need(action[i] in (0, 1, 2), 'unknown branch action')
        key = (xid[i], bid[i])
        cur = state.get(key, S_NONE)
        new, fields, business = table[(cur, action[i])]
        state[key] = new
        for f in fields:
            tally[f] += 1
        tally['business'] += business
    return [tally['try_ok'], tally['confirm_ok'], tally['cancel_ok'], tally['empty_rollback'],
            tally['suspended'], tally['orphan_confirm'], tally['cancel_after_confirm'],
            tally['confirm_after_cancel'], tally['replay'], tally['business']]


# ================================================== A6 顺序消息（用"按消费者拼接队列"重写）
@reg('alg-ab-fifo-queue-placement')
def m_fifo(queue_count, send_mode, group, cons):
    need(queue_count > 0, 'queue count must be positive')
    need(send_mode in (0, 1), 'unknown send mode')
    need(len(cons) == queue_count, 'consumer array length mismatch')
    for q in range(queue_count):
        need(cons[q] >= -1, 'negative consumer index')
    m = len(group)
    queue_of = []
    for i in range(m):
        need(group[i] >= 0, 'negative group key')
        queue_of.append(group[i] % queue_count if send_mode == 0 else i % queue_count)

    per_queue = {q: [] for q in range(queue_count)}
    for i in range(m):
        per_queue[queue_of[i]].append(i)         # 队列内天然就是到达序

    undeliverable = len([i for i in range(m) if cons[queue_of[i]] < 0])
    # 独立做法：不排序元组，而是"每个消费者按队列编号升序把自己的队列拼起来"
    consumers = sorted({cons[queue_of[i]] for i in range(m) if cons[queue_of[i]] >= 0})
    observed = []
    for c in consumers:
        for q in range(queue_count):
            if cons[q] == c:
                observed.extend(per_queue[q])

    spanned_max = cross = inversions = 0
    for g in sorted(set(group)):
        members = [i for i in range(m) if group[i] == g]
        spanned_max = max(spanned_max, len({queue_of[i] for i in members}))
        if len({cons[queue_of[i]] for i in members}) > 1:
            cross += 1
        seq = [i for i in observed if group[i] == g]
        inversions += sum(1 for a in range(len(seq)) for b in range(a + 1, len(seq))
                          if seq[a] > seq[b])
    used = len(set(queue_of))
    return [spanned_max, cross, inversions, undeliverable, len(set(group)), used]


# ================================================== A7 熔断状态机（"先定角色、再重扫桶"重写）
@reg('alg-ab-circuitbreaker-state')
def m_breaker(strategy, rt_limit, threshold, min_requests, interval, trip_ms, kind, rt, ts):
    need(strategy in (0, 1, 2), 'unknown strategy')
    need(interval > 0, 'stat interval must be positive')
    need(trip_ms > 0, 'trip duration must be positive')
    need(min_requests >= 0, 'min requests must be non-negative')
    need(rt_limit >= 0, 'rt limit must be non-negative')
    need(not (threshold < 0 or (strategy in (0, 1) and threshold > 100)), 'threshold out of range')
    n = same_len(kind, rt, ts)

    # 独立做法：**不维护 (total, bad) 累加器**，而是
    #   ① 先给每条请求定角色（sample / blocked / rejected / probe），
    #   ② 每次要判越线时，把"当前桶里、且晚于最近一次作废点"的 sample **重新扫一遍**数出来。
    # 于是 gen.py 里"桶切换/熔断清空"那两个 if 在这里根本没有对应物 ——
    # 两处实现给出同一个八元组才算交叉验证。
    roles, trips, probes = [], 0, 0
    open_until, void_after = None, -1
    max_total = max_bad = sampled = blocked = rejected = 0

    def is_bad(j):
        return (kind[j] == 0 and rt[j] > rt_limit) if strategy == 0 else (kind[j] == 1)

    for i in range(n):
        need(ts[i] >= 0, 'negative timestamp')
        need(i == 0 or ts[i] > ts[i - 1], 'timestamps must increase')
        need(kind[i] in (0, 1, 2), 'unknown call kind')
        need(rt[i] >= 0, 'negative rt')
        if open_until is not None:
            if ts[i] < open_until:
                roles.append('rejected')
                rejected += 1
            else:
                roles.append('probe')
                probes += 1
                revived = (kind[i] == 0 and rt[i] < rt_limit) if strategy == 0 else (kind[i] != 1)
                void_after = i
                if revived:
                    open_until = None
                else:
                    trips += 1
                    open_until = ts[i] + trip_ms
            continue
        if kind[i] == 2:
            roles.append('blocked')
            blocked += 1
            continue
        roles.append('sample')
        sampled += 1
        bucket = ts[i] // interval
        members = [j for j in range(void_after + 1, i + 1)
                   if roles[j] == 'sample' and ts[j] // interval == bucket]
        total, bad = len(members), len([j for j in members if is_bad(j)])
        max_total, max_bad = max(max_total, total), max(max_bad, bad)
        if total > min_requests:
            crossed = (bad * 100 > threshold * total) if strategy in (0, 1) else (bad > threshold)
            if crossed:
                trips += 1
                open_until = ts[i] + trip_ms
                void_after = i
    return [trips, 1 if open_until is not None else 0, rejected, sampled, blocked,
            max_total, max_bad, probes]


def same_len(*arrays):
    """与 gen.py 的 same_len 同一条判据（长度不一致 ⇒ 与 Java 侧同一条消息）。"""
    base = None
    for a in arrays:
        if a is None:
            raise Bail('array length mismatch')
        if base is None:
            base = len(a)
        elif len(a) != base:
            raise Bail('array length mismatch')
    return base or 0


# ================================================== B3 主键表逐字段归并（按到达序增量重写）
@reg('bd-ab-paimon-partial-update')
def m_partial_update(spec):
    """与 gen.py 那份**不同算法**：它按 key 分组后把记录按业务顺序排一遍再扫，
    这里按**到达顺序**增量扫一遍、每个字段各自记"(seq, arrived) 更大才改写"。
    两条路径给出同一张最终表，才算交叉验证（真 Spark 的语义仍由容器矩阵证明）。"""
    rows = spec['rows'] if isinstance(spec, dict) else spec
    best = {}        # (key, field) -> (seq, arrived, value)
    main_top = {}    # key -> (seq, arrived, is_delete)
    count = {}
    for r in sorted(rows, key=lambda x: x['arrived']):
        k = r['key']
        count[k] = count.get(k, 0) + 1
        if r['stream'] == 1:
            cur = main_top.get(k)
            if cur is None or (r['seq'], r['arrived']) > (cur[0], cur[1]):
                main_top[k] = (r['seq'], r['arrived'], r['is_delete'])
        for f in ('status', 'amount', 'price'):
            v = r[f]
            if v is None:
                continue                      # 非 null 才覆盖，null 保持原值
            cur = best.get((k, f))
            if cur is None or (r['seq'], r['arrived']) > (cur[0], cur[1]):
                best[(k, f)] = (r['seq'], r['arrived'], v)
    out = []
    for k in sorted(count):
        top = main_top.get(k)
        if top is not None and top[2] == 1:
            continue                          # 主流最新版本是删除 ⇒ 整行消失
        st = best.get((k, 'status'))
        if st is None or st[2] != 'open':
            continue                          # 谓词在合并之后
        am = best.get((k, 'amount'))
        pr = best.get((k, 'price'))
        out.append({'key': k, 'status': st[2], 'status_seq': st[0],
                    'amount': am[2] if am else None, 'amount_seq': am[0] if am else -1,
                    'price': pr[2] if pr else None, 'price_seq': pr[0] if pr else -1,
                    'versions': count[k]})
    return out


# ===================== B4 MaxCompute 账单（"按 (team, cloud) 二级汇总"重写，不是逐行累加金额）
@reg('bd-ab-maxcompute-bill')
def m_bill(spec):
    """gen.py 那份是"逐行算钱再按 team 累加"；这里刻意**先在 (team, 云) 上汇总 GB、
    最后才乘单价** —— 两条路径只有在"逐行按各自云种的单价"这条判据下才等价，
    于是"先求和再乘一个单价"的错误写法会被这里抓出来。"""
    rows = spec['rows'] if isinstance(spec, dict) else spec
    PRICE = {'public': 30, 'finance': 57}

    def ok_runs(r):
        return 0 if r['failed_runs'] > r['runs'] else r['runs'] - r['failed_runs']

    def unusable(r):
        return (r['scan_comp_gb'] is None or r['failed_runs'] > r['runs']
                or r['cloud'] not in PRICE)

    cells = {}          # (team, cloud) -> [calc_gb, dup_gb]   —— 金额最后一步才算
    roll = {}           # team -> [jobs, unknown, raw, calc, cost, pyodps, dup]
    for r in rows:
        t = roll.setdefault(r['team'], [0, 0, 0, 0, 0, 0, 0])
        t[0] += 1
        ok = ok_runs(r)
        t[2] += r['scan_raw_gb'] * r['complexity'] * ok      # raw 列含不可计费行
        if unusable(r):
            t[1] += 1
            continue
        gb = r['scan_comp_gb'] * r['complexity'] * ok
        c = cells.setdefault((r['team'], r['cloud']), [0, 0])
        c[0] += gb
        if r['engine'] == 'PYODPS':
            t[5] += gb
        if ok > 1:
            c[1] += r['scan_comp_gb'] * r['complexity'] * (ok - 1)
    for (team, cloud), (gb, dup_gb) in cells.items():
        t = roll[team]
        t[3] += gb
        t[4] += gb * PRICE[cloud]
        t[6] += dup_gb * PRICE[cloud]
    return [{'team': k, 'jobs': v[0], 'unknown_rows': v[1], 'calc_gb': v[3],
             'cost_fen': v[4], 'raw_calc_gb': v[2], 'pyodps_calc_gb': v[5],
             'dup_cost_fen': v[6]} for k, v in sorted(roll.items())]


# ============ B5 Hologres TTL 两把时钟（"集合差"重写：位掩码 + 降序找存活最新版本）
@reg('bd-ab-hologres-ttl-two-clocks')
def m_ttl(spec):
    """gen.py 那份用 `filter` + `max(..., key=version)`；这里改成
    **两个下标集合做差**算 ghost/rev，并按 version 降序取第一个存活行 ——
    "等于就过期"的边界方向在两处都得写对才算一致。"""
    rows = spec['rows'] if isinstance(spec, dict) else spec
    if not rows:
        return []
    now = max(r['written_ms'] for r in rows)
    now_ds = max(r['ds'] for r in rows)
    out = []
    for pk in sorted({r['pk'] for r in rows}):
        g = [r for r in rows if r['pk'] == pk]
        ttl_s = min(r['ttl_seconds'] for r in g)
        ttl_ms = ttl_s * 1000
        w_alive = {i for i, r in enumerate(g) if now - r['written_ms'] < ttl_ms}
        u_alive = {i for i, r in enumerate(g) if now - r['updated_ms'] < ttl_ms}
        kept = 0
        for i in sorted(w_alive, key=lambda j: -g[j]['version']):
            kept = g[i]['version']
            ds_kept = g[i]['ds']
            break
        if not w_alive:
            part = 1
        else:
            part = 1 if now_ds - ds_kept >= ttl_s // 86400 else 0
        out.append({'pk': pk, 'rows_total': len(g), 'dup_rows': len(g) - 1,
                    'kept_version': kept, 'alive_write': len(w_alive),
                    'alive_update': len(u_alive),
                    'ghost_rows': len(u_alive - w_alive), 'rev_rows': len(w_alive - u_alive),
                    'partition_expired': part})
    return out


# ================================================== 主流程
def check_case(key, model, case):
    name = case['name']
    args = case['input']
    # java-junit 题的 input 是"位置参数数组"，pyspark 题的 input 是 {view, schema, rows} 一个对象；
    # 后者若直接 *解包 会变成三个字符串键名（模型收到的是键，不是行）。
    if isinstance(args, dict):
        args = [args]
    if case.get('expectThrow'):
        want = case.get('throwMessage')
        try:
            got = model(*args)
        except Bail as exc:
            if exc.message != want:
                return False, f'抛错消息不符：期望 "{want}"，实际 "{exc.message}"'
            return True, 'throw ' + exc.message
        except Exception as exc:  # noqa: BLE001
            return False, f'抛了非契约异常 {type(exc).__name__}: {exc}'
        return False, f'声明要抛 "{want}"，但模型返回 {got}'
    try:
        got = model(*args)
    except Bail as exc:
        return False, f'没声明抛错，但模型抛了 {exc.message}'
    except Exception as exc:  # noqa: BLE001
        return False, f'模型异常 {type(exc).__name__}: {exc}'
    exp = case.get('expected')
    if got != exp:
        # int 与 bool/float 的差别在这里也值得暴露出来
        return False, f'期望 {exp}，重写实现给出 {got}'
    return True, json.dumps(got, ensure_ascii=False)[:60]


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4), 'data', 'drafts-ab', 'out')
    out_dir = os.path.abspath(out_dir)
    if not os.path.isdir(out_dir):
        print(f'草稿目录不存在：{out_dir}')
        return 2
    files = sorted(f for f in os.listdir(out_dir) if f.endswith('.json'))
    ok = skipped = failed = 0
    for f in files:
        path = os.path.join(out_dir, f)
        q = json.load(open(path, encoding='utf-8'))
        key = f[:-len('.json')]
        title = q.get('title', '')[:34]
        if key not in MODELS:
            kind = q.get('judgeKind')
            why = ('redis/mysql/pyspark 需要真引擎，本机重写不了判分状态'
                   if kind in ('redis', 'mysql', 'pyspark', 'spark-scala')
                   else '本文件未登记该草稿的实现')
            print(f'SKIP  {key:<38} {title}｜{why}')
            skipped += 1
            continue
        model = MODELS[key]
        cases = q.get('cases') or []
        if len(cases) < 3:
            print(f'FAIL  {key}: 用例数 {len(cases)} < 3')
            failed += 1
            continue
        boundary = any(x in ' '.join(c['name'] for c in cases)
                       for x in ['空', '边界', '退化', '并列', '重复', '非法'])
        problems = []
        if not boundary:
            problems.append('没有边界/退化用例')
        if not q.get('runner', {}).get('referenceSolution'):
            problems.append('缺 referenceSolution')
        if not q.get('runner', {}).get('naiveSolution'):
            problems.append('缺 naiveSolution')
        for c in cases:
            good, detail = check_case(key, model, c)
            if not good:
                problems.append(f'用例「{c["name"]}」{detail}')
        if problems:
            print(f'FAIL  {key:<38} {title}')
            for p in problems:
                print(f'        - {p}')
            failed += 1
        else:
            print(f'PASS  {key:<38} {title}｜{len(cases)} 个用例全部与独立重写一致')
            ok += 1
    print(f'\n合计：{ok} PASS / {skipped} SKIP / {failed} FAIL（共 {len(files)} 份草稿）')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
