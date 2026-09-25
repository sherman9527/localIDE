#!/usr/bin/env python3
"""
字节跳动草稿的本地预检（与 pdd / airbnb / apple / deepseek 的 precheck.py 同一套纪律）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮要几十秒到几分钟；
而用例的 expected 是 gen.py 里那份模型算的，模型就会错。
本文件把每道参考解**独立重写一遍**再跑同一批用例 ——
刻意**不 import gen.py**：两处独立实现给出同一个数，才算交叉验证。

它不能替代容器判题：
- Java 的 long 溢出/无符号右移语义、MySQL 的三值逻辑、Spark 的会话时区，
  Python 只能"尽量对齐"而不是证明 —— 那些只能由矩阵证明；
  （A5 的分桶哈希是逐位定义的，这里能完全对齐，但**Java 侧是否真的一样**仍只有矩阵知道。）
- 未登记的草稿打印 **SKIP** 而不是被当成通过。redis 题在这里就是 SKIP
  （参考解是一段 Redis 命令脚本，判分靠服务端最终状态，本机没有 Redis）。

用法：
    python scripts/bank/drafts/bytedance/precheck.py data/drafts-bd/out
"""
import json
import os
import sys
from decimal import Decimal, ROUND_HALF_UP

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


# ============================================================ A1 熔断器（用迁移表重写）
@reg('alg-bd-circuitbreaker')
def m_breaker(min_sample, threshold_bps, cooldown_steps, probe_sample, outcomes):
    if min_sample <= 0:
        raise Bail('minSample must be positive')
    if not 0 < threshold_bps <= 10000:
        raise Bail('thresholdBps out of range')
    if cooldown_steps < 0:
        raise Bail('cooldownSteps must be non-negative')
    if probe_sample < min_sample:
        raise Bail('probeSample must be >= minSample')
    if outcomes is None:
        raise Bail('outcomes must not be null')
    if any(o not in (0, 1) for o in outcomes):
        raise Bail('outcome must be 0 or 1')

    # 与 gen.py 的 if/else 链不同：这里显式写成"状态 -> (事件) -> 动作"的表驱动形式。
    st = {'name': 'CLOSED', 'samples': 0, 'errors': 0, 'probe': 0, 'cool': 0}
    tally = {'allowed': 0, 'rejected': 0, 'opened': 0}

    def tripped(samples, errors):
        if samples < min_sample:
            return False
        return Decimal(errors) * 10000 >= Decimal(threshold_bps) * Decimal(samples)

    for o in outcomes:
        if st['name'] == 'CLOSED':
            st['samples'] += 1
            st['errors'] += o
            tally['allowed'] += 1
            if tripped(st['samples'], st['errors']):
                tally['opened'] += 1
                st['samples'] = st['errors'] = 0
                st['name'] = 'HALF' if cooldown_steps <= 0 else 'OPEN'
                st['probe'] = probe_sample if cooldown_steps <= 0 else 0
                st['cool'] = 0 if cooldown_steps <= 0 else cooldown_steps
        elif st['name'] == 'HALF':
            st['samples'] += 1
            st['errors'] += o
            tally['allowed'] += 1
            if tripped(st['samples'], st['errors']):
                tally['opened'] += 1
                st['samples'] = st['errors'] = 0
                st['name'] = 'HALF' if cooldown_steps <= 0 else 'OPEN'
                st['probe'] = probe_sample if cooldown_steps <= 0 else 0
                st['cool'] = 0 if cooldown_steps <= 0 else cooldown_steps
            else:
                st['probe'] -= 1
                if st['probe'] <= 0:
                    st['name'] = 'CLOSED'
                    st['samples'] = st['errors'] = 0
        else:  # OPEN
            tally['rejected'] += 1
            st['cool'] -= 1
            if st['cool'] <= 0:
                st['name'] = 'HALF'
                st['samples'] = st['errors'] = 0
                st['probe'] = probe_sample
    final = {'CLOSED': 0, 'OPEN': 1, 'HALF': 2}[st['name']]
    return [tally['allowed'], tally['rejected'], tally['opened'], final]


# ============================================================ A2 重试决策（规则表重写）
@reg('alg-bd-retry-decision')
def m_retry(rpc, max_retries, max_dur, cbps, bps, chain_stop, upstream_retry,
            same_node, streaming, idempotent, elapsed, attempts, err, last_node, cand_node):
    checks = [
        (rpc <= 0, 'rpcTimeout must be positive'),
        (not 0 <= max_retries <= 5, 'maxRetryTimes must be in [0,5]'),
        (not 0 < cbps <= 3000, 'cbPolicyBps must be in (0,3000]'),
        (not 0 < bps <= 10000, 'breakerThresholdBps out of range'),
        (cbps >= bps, 'cbPolicyBps must be below breaker threshold'),
        (err is None, 'errorType must not be null'),
        (elapsed < 0, 'elapsed must be non-negative'),
        (attempts < 0, 'attemptsDone must be non-negative'),
    ]
    for bad, msg in checks:
        if bad:
            raise Bail(msg)

    hi = rpc * (max_retries + 1)
    lo = rpc + 1
    if max_dur <= 0:
        budget, clamped = hi, False
    else:
        budget = min(hi, max(lo, max_dur))
        clamped = budget != max_dur

    rules = [
        (streaming, 'STOP_STREAMING'),
        (err not in ('TIMEOUT', 'CONNECT_FAIL'), 'STOP_NOT_RETRYABLE'),
        (err == 'TIMEOUT' and not idempotent, 'STOP_NOT_IDEMPOTENT'),
        (chain_stop and upstream_retry, 'STOP_CHAIN'),
        (attempts >= max_retries, 'STOP_TRIES'),
        (elapsed >= budget, 'STOP_BUDGET'),
        ((not same_node) and cand_node == last_node, 'STOP_SAME_NODE'),
    ]
    verdict = 'RETRY'
    for hit, name in rules:
        if hit:
            verdict = name
            break
    return 'CLAMPED|' + verdict if clamped else verdict


# ============================================================ A3 限流（按"事件流"重写）
@reg('alg-bd-server-limiter')
def m_limiter(qps, burst, max_conn, arrivals, holds, grpc):
    if qps <= 0:
        raise Bail('qps must be positive')
    if burst < 1:
        raise Bail('burst must be at least 1')
    if max_conn < 1:
        raise Bail('maxConnections must be positive')
    if arrivals is None or holds is None or grpc is None:
        raise Bail('input arrays must not be null')
    if not (len(arrivals) == len(holds) == len(grpc)):
        raise Bail('input arrays must have the same length')
    for i in range(len(arrivals)):
        if i > 0 and arrivals[i] < arrivals[i - 1]:
            raise Bail('arrivals must be non-decreasing')
        if holds[i] < 0:
            raise Bail('hold must be non-negative')
        if grpc[i] not in (0, 1):
            raise Bail('grpc must be 0 or 1')

    U = 1000000
    # 独立写法：把"在途连接"维护成一个按释放时间排序的列表，每次先弹出已释放的。
    ends = sorted([])
    credit = burst * U
    clock = arrivals[0] if arrivals else 0
    allowed = rq = rc = 0
    for now, hold, flag in zip(arrivals, holds, grpc):
        delta = now - clock
        if delta > 0:
            credit = min(burst * U, credit + delta * 1000 * qps)
            clock = now
        while ends and ends[0] <= now:
            ends.pop(0)
        if len(ends) >= max_conn:
            rc += 1
            continue
        if flag == 0:
            if credit < U:
                rq += 1
                continue
            credit -= U
        allowed += 1
        ends.append(now + hold)
        ends.sort()
    return [allowed, rq, rc, credit // U]


# ============================================================ A4 平滑加权轮询（用分数重写）
@reg('alg-bd-weighted-round-robin')
def m_wrr(weights, picks):
    if weights is None or len(weights) == 0:
        raise Bail('weights must not be empty')
    if any(w <= 0 for w in weights):
        raise Bail('weight must be positive')
    if picks <= 0:
        raise Bail('picks must be positive')
    if picks > 1000:
        raise Bail('picks too large')
    total = sum(weights)
    if total > 100000:
        raise Bail('weights sum too large')
    # 独立写法：currentWeight 用 Decimal 存，选择用"最大值 + 最小下标"的显式排序，
    # 与 gen.py 的手写循环比较式分开实现，避免同一个 off-by-one 两边各犯一次。
    cw = [Decimal(0)] * len(weights)
    w = [Decimal(x) for x in weights]
    picked = []
    counts = [0] * len(weights)
    for _ in range(picks):
        cw = [a + b for a, b in zip(cw, w)]
        order = sorted(range(len(cw)), key=lambda i: (-cw[i], i))
        best = order[0]
        cw[best] -= Decimal(total)
        picked.append(best)
        counts[best] += 1
    return ','.join(map(str, picked)) + '|' + ','.join(map(str, counts))


# ============================================================ A5 两次哈希分桶（逐位定义必须一致）
MASK = (1 << 64) - 1


def _mix64(z):
    # 与 Java 的 long 溢出等价：每一步都截断到 64 位无符号
    z = (z ^ (z >> 30)) & MASK
    z = (z * 0xBF58476D1CE4E5B9) & MASK
    z = (z ^ (z >> 27)) & MASK
    z = (z * 0x94D049BB133111EB) & MASK
    return (z ^ (z >> 31)) & MASK


@reg('alg-bd-ab-orthogonal-buckets')
def m_ab(salt_a, salt_b, buckets, users):
    if salt_a < 0 or salt_b < 0:
        raise Bail('salt must be non-negative')
    if buckets <= 0:
        raise Bail('buckets must be positive')
    if buckets > 8:
        raise Bail('buckets too large')
    if users < 0:
        raise Bail('users must be non-negative')
    if users > 200000:
        raise Bail('users too large')
    cells = {}
    for u in range(users):
        a = (_mix64(((u * 0x9E3779B97F4A7C15) & MASK) + salt_a) >> 1) % buckets
        b = (_mix64(((u * 0x9E3779B97F4A7C15) & MASK) + salt_b) >> 1) % buckets
        cells[(a, b)] = cells.get((a, b), 0) + 1
    flat = [cells.get((i, j), 0) for i in range(buckets) for j in range(buckets)]
    bsq = buckets * buckets
    if users == 0:
        return flat + [0]
    # 独立写法：偏差按"相对期望的上/下界"取更大者，公式与 gen.py 的整除式必须等价
    worst = 0
    for obs in flat:
        over = (obs * bsq - users) * 10000 // users
        under = (users - obs * bsq) * 10000 // users
        worst = max(worst, over, under)
    return flat + [worst]


# ============================================================ A6 配置下发（对象式状态重写）
@reg('alg-bd-config-rollout')
def m_config(threshold_bps, min_sample, pushes):
    if not 0 < threshold_bps <= 10000:
        raise Bail('thresholdBps out of range')
    if min_sample <= 0:
        raise Bail('minSample must be positive')
    if pushes is None:
        raise Bail('pushes must not be null')
    for p in pushes:
        if p is None or len(p) != 6:
            raise Bail('each push must be [version, hash, valid, applyPercent, fail, total]')
        v, h, valid, pct, fail, total = p
        if v < 0:
            raise Bail('version must be non-negative')
        if h < 0:
            raise Bail('hash must be non-negative')
        if valid not in (0, 1):
            raise Bail('valid must be 0 or 1')
        if not 1 <= pct <= 100:
            raise Bail('applyPercent must be in [1,100]')
        if fail < 0 or total < 0:
            raise Bail('fail and total must be non-negative')
        if fail > total:
            raise Bail('fail must not exceed total')

    cur = {'v': 0, 'h': 0}
    stable = {'v': 0, 'h': 0}
    t = dict(applied=0, partial=0, stale=0, invalid=0, no_diff=0, rolled=0)
    for v, h, valid, pct, fail, total in pushes:
        unhealthy = (total >= min_sample
                     and Decimal(fail) * 10000 >= Decimal(threshold_bps) * Decimal(total))
        if cur['v'] and unhealthy and stable['v'] != cur['v']:
            t['rolled'] += 1
            cur = dict(stable)
        if not valid:
            t['invalid'] += 1
            continue
        if v <= cur['v']:
            t['stale'] += 1
            continue
        if h == cur['h']:
            t['no_diff'] += 1
            continue
        cur = {'v': v, 'h': h}
        t['applied'] += 1
        if pct < 100:
            t['partial'] += 1
        else:
            stable = dict(cur)
    return [t['applied'], t['partial'], t['stale'], t['invalid'],
            t['no_diff'], t['rolled'], cur['v'], stable['v']]



# ============================================================ B1 时点正确性（换一种枚举顺序重写）
@reg('bd-bd-point-in-time-features')
def m_pit(rows):
    out = []
    versions_by_user = {}
    for r in rows:
        if r['row_kind'] == 'version':
            versions_by_user.setdefault(r['user_id'], []).append(r)
    for s in sorted((r for r in rows if r['row_kind'] == 'sample'),
                    key=lambda r: r['sample_id']):
        t = s['event_ts']
        covering_visible, last_known, covering_hidden = [], [], []
        for v in versions_by_user.get(s['user_id'], []):
            visible = v['ingest_ts'] <= t
            inside = v['valid_from'] <= t and t < v['valid_to']
            if inside and visible:
                covering_visible.append(v)
            elif visible and v['valid_from'] <= t:
                last_known.append(v)
            elif inside:                      # 覆盖但当时还没落库
                covering_hidden.append(v)
        chosen = None
        if covering_visible:
            chosen = max(covering_visible, key=lambda v: (v['valid_from'], v['version_no']))
            leak = 'overlap' if len(covering_visible) > 1 else 'none'
        elif last_known:
            chosen = max(last_known, key=lambda v: (v['valid_from'], v['version_no']))
            leak = 'future-value' if covering_hidden else 'stale-value'
        else:
            leak = 'future-value' if covering_hidden else 'no-coverage'
        out.append({'sample_id': s['sample_id'], 'user_id': s['user_id'],
                    'feature_value': chosen['feature_value'] if chosen else None,
                    'version_no': chosen['version_no'] if chosen else None,
                    'leak': leak})
    return out


# ============================================================ B2 位点完整度（先分类再算 ETA）
@reg('bd-bd-consumer-lag-readiness')
def m_lag(rows):
    out = []
    for r in sorted(rows, key=lambda x: (x['ds'], x['topic'], x['consumer_group'])):
        span = r['max_offset'] - r['min_offset']
        got = r['consumer_offset'] - r['min_offset']
        left = r['max_offset'] - r['consumer_offset']
        bad = (r['window_minutes'] <= 0 or got < 0 or got > span
               or r['min_offset'] < 0 or span < 0)
        eta = None
        if bad:
            status = 'invalid-position'
        elif left == 0:
            status, eta = 'complete', 0
        elif got == 0:
            status = 'stalled'
        else:
            # 与 gen.py 的 `-((-a)//b)` 不同的写法：divmod + 有余数才进一位
            n, rem = divmod(left * r['window_minutes'], got)
            value = n + 1 if rem else n
            status = 'healthy' if value <= r['sla_minutes'] else 'sla-risk'
            eta = value
        out.append({'ds': r['ds'], 'topic': r['topic'], 'consumer_group': r['consumer_group'],
                    'backlog': left, 'consumed': got, 'total_span': span,
                    'eta_minutes': eta, 'status': status})
    return out


# ============================================================ B3 血缘下线（按桶累加重写）
@reg('bd-bd-tracking-lineage-retire')
def m_lineage(rows):
    sums = {}
    for r in rows:
        if r['is_preset'] == 1:
            a = 'keep-preset'
        elif not r['verified']:
            a = 'block-unverified'
        elif r['disabled']:
            a = 'already-disabled'
        elif not (r['direct_refs'] or r['indirect_refs'] or r['queries_30d']):
            a = 'retire'
        elif r['direct_refs'] == 0 and r['indirect_refs'] > 0:
            # 必须两个条件都判：只写 "not direct_refs" 会把
            # "direct=0/indirect=0/queries=1" 那行错判成 retire-indirect-only
            a = 'retire-indirect-only'
        else:
            a = 'keep'
        b = sums.setdefault(a, {'event_cnt': 0, 'total_storage_gb': 0, 'total_queries': 0})
        b['event_cnt'] += 1
        b['total_storage_gb'] += r['storage_gb']
        b['total_queries'] += r['queries_30d']
    return [dict(action=a, **sums[a]) for a in sorted(sums)]


# ============================================================ F1 埋点状态视图（候选表重写）
@reg('fe-bd-event-metadata-view')
def m_event_view(row):
    if not isinstance(row, dict):
        raise Bail('row must be an object')
    st, src, kind = row.get('status'), row.get('source'), row.get('analysisKind')
    if st not in ('draft', 'pending', 'accepted', 'rejected', 'disabled'):
        raise Bail('unknown event status')
    if src not in ('preset', 'custom'):
        raise Bail('unknown event source')
    if kind not in ('none', 'click', 'custom', 'heatmap', 'selector'):
        raise Bail('unknown analysis kind')
    manage = row.get('canManage')
    # 反向组织：列出"每个 state 需要什么条件"，第一个成立的即答案
    candidates = [
        ('disabled', lambda: st == 'disabled'),
        ('preset', lambda: src == 'preset'),
        ('draft', lambda: st == 'draft'),
        ('needs-accept', lambda: st == 'pending' and bool(manage)),
        ('pending-locked', lambda: st == 'pending'),
        ('rejected', lambda: st == 'rejected'),
        ('capability-gap', lambda: kind in ('heatmap', 'selector') and not row.get('autoTracking')),
        ('live', lambda: True),
    ]
    state = next(n for n, pred in candidates if pred())
    meta = {
        'disabled': ('已禁用 · 停止上报', 'danger', 're-enable', 'stopped', False),
        'preset': ('预置事件', 'info', None, 'preset-owned', True),
        'draft': ('草稿 · 未提交', 'muted', 'submit', 'draft', False),
        'needs-accept': ('待验收 · 可验收', 'warn', 'accept', 'pending-acceptance', False),
        'pending-locked': ('待验收 · 只读', 'muted', None, 'pending-acceptance', False),
        'rejected': ('验收未通过', 'danger', 'revise', 'rejected', False),
        'capability-gap': ('需开启全埋点', 'warn', None, 'capability-gap', True),
        'live': ('可分析', 'ok', 'view', 'live', True),
    }[state]
    gated = state in ('disabled', 'draft', 'rejected', 'needs-accept')
    return {'state': state, 'label': meta[0], 'tone': meta[1],
            'action': (meta[2] if manage else None) if gated else meta[2],
            'tooltip': '事件 %s：%s' % (row.get('eventName', '?'), meta[0]),
            'governanceBucket': meta[3], 'countsInAcceptedList': meta[4]}


# ============================================================ F2 实验结论区（元组表重写）
@reg('fe-bd-ab-report-verdict')
def m_report(inp):
    if not isinstance(inp, dict):
        raise Bail('input must be an object')
    if inp.get('denominator') not in ('cumulative-dedup', 'daily-active'):
        raise Bail('unknown denominator')
    exp, act = inp['expectedSplitBps'], inp['actualSplitBps']
    if not 0 < exp <= 10000:
        raise Bail('expectedSplitBps out of range')
    if not 0 <= act <= 10000:
        raise Bail('actualSplitBps out of range')
    if inp['daysRunning'] < 1:
        raise Bail('daysRunning must be positive')
    if inp['samplePerGroup'] < 0:
        raise Bail('samplePerGroup must be non-negative')
    if not isinstance(inp['updatedT1'], bool) or not isinstance(inp['significant'], bool):
        raise Bail('flags must be booleans')
    dev = int(abs(act - exp) * 10000 / exp)
    blockers = [code for code, hit in (
        ('SRM', dev > 1000),
        ('DENOMINATOR', inp['denominator'] != 'cumulative-dedup'),
        ('STALE', (not inp['updatedT1']) and inp['daysRunning'] > 1),
        ('LOW-SAMPLE', inp['samplePerGroup'] < 1000),
    ) if hit]
    for code, v, tone, text in (
        ('SRM', 'invalid', 'danger', '进组比例偏离预设 %.2f%%，结论不成立' % (dev / 100.0)),
        ('DENOMINATOR', 'hold', 'warn', '分母口径不是累计去重进组用户，先换回官方口径再判'),
        ('STALE', 'hold', 'warn', '数据未按 T-1 更新，今天的数字还不是结论'),
    ):
        if code in blockers:
            return {'splitDeviationBps': dev, 'blockers': blockers, 'verdict': v,
                    'tone': tone, 'headline': text, 'canPublish': False,
                    'liftBps': inp['liftBps']}
    if not inp['significant']:
        v, tone, text = 'not-significant', 'muted', '未达显著，按预注册时长继续或加样本'
    elif 'LOW-SAMPLE' in blockers:
        v, tone, text = 'watch', 'warn', '显著但样本偏少，只做观察不做放行'
    else:
        v, tone, text = 'ship-candidate', 'ok', '可提交放行评审'
    return {'splitDeviationBps': dev, 'blockers': blockers, 'verdict': v, 'tone': tone,
            'headline': text, 'canPublish': v == 'ship-candidate', 'liftBps': inp['liftBps']}


# ============================================================ 通用比较
def norm(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int,)) and not isinstance(v, bool):
        return v
    if isinstance(v, float):
        return Decimal(str(v)).quantize(Decimal('0.000001'), rounding=ROUND_HALF_UP)
    if isinstance(v, str):
        return v
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    return v


def same(a, b):
    return norm(a) == norm(b)


def main(argv):
    target = argv[0] if argv else os.path.join(
        os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4))),
        'data', 'drafts-bd', 'out')
    if os.path.isdir(target):
        paths = sorted(os.path.join(target, n) for n in os.listdir(target) if n.endswith('.json'))
    else:
        paths = [target]

    passed = skipped = failed = 0
    for path in paths:
        with open(path, encoding='utf-8') as f:
            q = json.load(f)
        key = os.path.splitext(os.path.basename(path))[0]
        if key not in MODELS:
            skipped += 1
            why = {
                'redis': '参考解是一段 Redis 命令脚本、判分靠服务端最终状态，本机没有 Redis',
                'mysql': ('本机没有 MySQL；且 expected 已由 mut_case 与变异语句'
                          '同源生成（同一份内存行集同时产出 SQL 与期望值）'),
                'llm-rubric': '主观题没有可比对的 expected',
            }.get(q['judgeKind'], '未登记独立重写')
            print('SKIP %s（%s / %s）' % (key, q['judgeKind'], why))
            continue
        fn = MODELS[key]
        kind = q['judgeKind']
        bad = []
        for c in q['cases']:
            raw = c['input']
            if kind == 'pyspark':
                args = (raw['rows'],)
            else:
                args = tuple(raw)
            try:
                got = fn(*args)
                raised = None
            except Bail as exc:
                got, raised = None, exc.message
            throw = c.get('expectThrow')
            if throw:
                want = c.get('throwMessage')
                if raised is None:
                    bad.append('%s: 期望抛 %s，实际正常返回 %s' % (c['name'], throw, got))
                elif want and raised != want:
                    bad.append('%s: 期望消息 "%s"，实际 "%s"' % (c['name'], want, raised))
                continue
            if raised is not None:
                bad.append('%s: 没期望抛错，实际抛了 "%s"' % (c['name'], raised))
                continue
            if not same(got, c['expected']):
                bad.append('%s: expected=%s got=%s' % (c['name'], c['expected'], got))
        if bad:
            failed += 1
            print('FAIL %s' % key)
            for b in bad:
                print('       ' + b)
        else:
            passed += 1
            print('ok   %s  (%d 用例)' % (key, len(q['cases'])))
    print('\n通过 %d，跳过 %d，失败 %d（共 %d 份草稿）' % (passed, skipped, failed, len(paths)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
