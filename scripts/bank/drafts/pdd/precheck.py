#!/usr/bin/env python3
"""
PDD 草稿的本地预检（与 airbnb / apple / deepseek 的 precheck.py 同一套纪律）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮要几十秒到几分钟；
而用例的 expected 是人（或 gen.py 里那份模型）算的，算就会错。
本文件用 Python 把每道参考解**独立重写一遍**再跑所有用例 ——
刻意**不 import gen.py**：两处独立实现给出同一个数，才算交叉验证。

它不能替代容器判题：
- java 侧的 int 溢出、MySQL 的三值逻辑与 ONLY_FULL_GROUP_BY、Spark 的会话时区，
  Python 都复现不了 —— 那些只能由矩阵证明；
- 未登记的草稿会打印 **SKIP** 而不是被当成通过（redis 两道题在这里就是 SKIP，
  因为它们的"参考解"是一段 Redis 命令脚本、判分靠服务端状态校验，Python 无 Redis 可跑）。

用法：
    python scripts/bank/drafts/pdd/precheck.py data/drafts-pdd/out
"""
import json
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

JAVA = {}
MYSQL = {}
PYSPARK = {}
REACT = {}


def reg(kind, key):
    def deco(fn):
        {'java': JAVA, 'mysql': MYSQL, 'pyspark': PYSPARK, 'react': REACT}[kind][key] = fn
        return fn
    return deco


class Bail(Exception):
    """模型层的"必须抛错"，message 与 Java 侧的异常消息一一对应。"""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


# ============================================================ 行集解析（MySQL 题共用）
def split_top(text):
    """按顶层逗号切分（忽略引号与括号内部的逗号）。"""
    parts, depth, quote, buf = [], 0, None, ''
    for ch in text:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
            buf += ch
        elif ch in '([':
            depth += 1
            buf += ch
        elif ch in ')]':
            depth -= 1
            buf += ch
        elif ch == ',' and depth == 0:
            parts.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        parts.append(buf.strip())
    return parts


def atom(token):
    token = token.strip()
    if token.upper() == 'NULL':
        return None
    if token.startswith("'"):
        return token[1:-1].replace("''", "'")
    return Decimal(token) if '.' in token else int(token)


def seed_tables(setup):
    """从 runner.setup 还原每张表的列名与行集（与判题器实际灌进去的是同一批语句）。"""
    cols = {}
    rows = {}
    for stmt in setup:
        m = re.match(r'CREATE TABLE (\w+) \((.*)\) ENGINE', stmt, re.S)
        if m:
            names = []
            for part in split_top(m.group(2)):
                names.append(part.strip().split()[0])
            cols[m.group(1)] = names
            rows.setdefault(m.group(1), [])
            continue
        m = re.match(r'INSERT INTO (\w+) VALUES (.*)$', stmt, re.S)
        if m:
            body = m.group(2).rstrip(';')
            for chunk in re.findall(r'\(((?:[^()\']|\'[^\']*\')*)\)', body):
                rows[m.group(1)].append([atom(x) for x in split_top(chunk)])
    return cols, rows


def apply_statements(cols, rows, statements):
    rows = {t: [list(r) for r in rows[t]] for t in rows}
    for stmt in statements:
        s = stmt.strip()
        m = re.fullmatch(r'DELETE FROM (\w+) WHERE (\w+) = (.+)', s)
        if m:
            tbl, col, lit = m.group(1), m.group(2), atom(m.group(3))
            idx = cols[tbl].index(col)
            rows[tbl] = [r for r in rows[tbl] if r[idx] != lit]
            continue
        m = re.fullmatch(r'UPDATE (\w+) SET (.+?) WHERE (\w+) = (.+)', s)
        if m:
            tbl = m.group(1)
            key_col, key_lit = m.group(3), atom(m.group(4))
            idx = cols[tbl].index(key_col)
            for part in split_top(m.group(2)):
                col, lit = part.split('=', 1)
                target = cols[tbl].index(col.strip())
                value = atom(lit)
                for r in rows[tbl]:
                    if r[idx] == key_lit:
                        r[target] = value
            continue
        m = re.fullmatch(r'INSERT INTO (\w+) VALUES \((.*)\)', s)
        if m:
            rows[m.group(1)].append([atom(x) for x in split_top(m.group(2))])
            continue
        raise SystemExit('precheck 不认这条语句：' + s)
    return rows


def as_dicts(names, rows):
    return [dict(zip(names, r)) for r in rows]


def by(tables, cols, name):
    return as_dicts(cols[name], tables[name])


def qdec(x):
    return Decimal(str(x))


def half_up_bp(numerator, denominator):
    """万分比 HALF_UP —— 与 Spark 的 round() 同规则（Python 的 round 是银行家舍入）。"""
    if denominator == 0:
        return 0
    exact = (qdec(numerator) * 10000 / qdec(denominator)).quantize(Decimal('0.000001'))
    return int(exact.to_integral_value(rounding=ROUND_HALF_UP))


# =================================================================== java: 投影库存
@reg('java', 'alg-pdd-phantom-stock')
def java_phantom_stock(stock, lag, ops):
    # 独立写法：把待落地更新按"到期时刻"分桶，而不是线性扫 pending 列表。
    if stock < 0:
        raise Bail('negative initial stock')
    if lag < 0:
        raise Bail('negative lag')
    due = {}
    real, proj = stock, stock
    peak = oversold = rejected = 0
    for i in range(len(ops) + 1):
        for kind, qty in due.pop(i, []):        # 先落地到期的（含 lag==0 的当步）
            if kind == 2:
                proj += qty
            elif kind == 3:
                proj -= qty
            else:
                proj = qty
        if i == len(ops):
            break
        op = ops[i]
        if len(op) != 2:
            raise Bail('op must be [kind, qty]')
        kind, qty = op
        if kind not in (1, 2, 3, 4):
            raise Bail('unknown op kind')
        if qty < 0:
            raise Bail('negative qty')
        if kind == 1:
            if proj < qty:
                rejected += 1
            else:
                backed = max(min(qty, real), 0)
                oversold += qty - backed
                proj -= qty
                real -= qty
        else:
            real = real + qty if kind == 2 else (real - qty if kind == 3 else qty)
            due.setdefault(i + lag, []).append((kind, qty))
            for k, q in due.pop(i, []):         # lag == 0：同一事件内还要再落一次
                proj = proj + q if k == 2 else (proj - q if k == 3 else q)
        peak = max(peak, proj - real)
    return [peak, oversold, rejected]


# =================================================================== java: 官方金额口径
@reg('java', 'alg-pdd-pay-amount')
def java_settle_amount(base_amt, promotions):
    if len(base_amt) != 11:
        raise Bail('base must have 11 fields')
    qty = base_amt[1]
    if qty < 0:
        raise Bail('negative qty')
    subsidy_type = base_amt[10]
    if subsidy_type not in (0, 1, 2):
        raise Bail('unknown subsidy type')
    extra = Decimal(0)
    for promo in promotions:
        if len(promo) != 2:
            raise Bail('promotion must be [type, amount]')
        if promo[1] < 0:
            raise Bail('negative promotion amount')
        if int(promo[0]) != 30:
            extra += qdec(promo[1])
    goods = qdec(base_amt[0]) * qdec(qty) - qdec(base_amt[2])
    discount = qdec(base_amt[5]) + qdec(base_amt[6]) + qdec(base_amt[7])
    pay = goods - discount + qdec(base_amt[3]) + qdec(base_amt[4])
    subsidy = qdec(base_amt[5]) + extra
    if subsidy_type == 1:
        subsidy -= qdec(base_amt[9])
    if subsidy < 0:
        raise Bail('negative platform subsidy')
    return [int(goods), int(discount), int(pay), int(qdec(base_amt[8]) - pay), int(subsidy)]


# =================================================================== java: 倒序分页模拟
@reg('java', 'alg-pdd-increment-paging')
def java_window_miss(window_seconds, initial_rows, page_size, total_steps, drift):
    if window_seconds <= 0:
        raise Bail('window must be positive')
    if window_seconds > 1800:
        raise Bail('window exceeds 1800 seconds')
    if initial_rows < 0:
        raise Bail('negative initial rows')
    if page_size <= 0:
        raise Bail('page size must be positive')
    if total_steps < 0:
        raise Bail('negative steps')
    if len(drift) != total_steps:
        raise Bail('drift length must equal steps')
    for d in drift:
        if len(d) != 2:
            raise Bail('drift must be [dropFront, addTail]')
        if d[0] < 0 or d[1] < 0:
            raise Bail('negative drift')
    # 独立写法：用 deque 的两端操作表达"队头掉、队尾加"，坐标各自换算
    from collections import deque
    live = deque(range(initial_rows))
    nxt = initial_rows
    seen = {0: set(), 1: set()}
    for s in range(total_steps):
        drop, add = drift[s]
        for _ in range(min(drop, len(live))):
            live.popleft()
        for _ in range(add):
            live.append(nxt)
            nxt += 1
        n = len(live)
        spans = {0: (s * page_size, (s + 1) * page_size),
                 1: (max(0, n - (s + 1) * page_size), max(0, n - s * page_size))}
        for tag, (lo, hi) in spans.items():
            for j in range(max(0, lo), min(hi, n)):
                seen[tag].add(live[j])
    out = []
    final = list(live)
    for tag in (0, 1):
        out.append(sum(1 for rid in final if rid not in seen[tag]))
    for tag in (0, 1):
        run = 0
        for rid in final:
            if rid in seen[tag]:
                run += 1
            else:
                break
        out.append(run)
    return out


# =================================================================== java: 可见性判定
@reg('java', 'alg-pdd-receiver-visibility')
def java_receiver(statuses, risks, stored_forms):
    if not (len(statuses) == len(risks) == len(stored_forms)):
        raise Bail('length mismatch')
    out = []
    for i in range(len(statuses)):
        st, rk, sv = statuses[i], risks[i], stored_forms[i]
        if st not in (1, 2, 3, 5):
            raise Bail('unknown order status')
        if st == 5:
            raise Bail('filter value 5 is not a real status')
        if rk not in (0, 1):
            raise Bail('unknown risk control status')
        if sv not in ('cipher', 'plain', 'absent'):
            raise Bail('unknown stored form')
        # 独立写法：用决策表而不是 if 链
        table = {
            ('absent',): 'empty:no-column',
        }
        if sv == 'absent':
            out.append(table[('absent',)])
            continue
        if st != 1:
            out.append('empty:not-awaiting-shipment')
        elif rk == 1:
            out.append('empty:risk-hold')
        elif sv == 'plain':
            out.append('empty:not-ciphered')
        else:
            out.append('cipher:ok')
    return out


# =================================================================== java: 券批次额度
@reg('java', 'alg-pdd-coupon-quota')
def java_coupon_quota(issue_total, stock, ops):
    if issue_total < 0:
        raise Bail('negative initial issue total')
    if stock < 0:
        raise Bail('negative initial stock')
    # 独立写法：把两套额度封进一个状态字典，动作表驱动
    st = {'cap': issue_total, 'issued': 0, 'used': 0, 'stock': stock,
          'rq': 0, 'rs': 0, 'rc': 0, 'closed': False}

    def act(kind, qty):
        if kind == 1:
            if st['closed']:
                st['rc'] += 1
            elif qty > st['cap']:
                st['rq'] += 1
            else:
                st['cap'] -= qty
                st['issued'] += qty
        elif kind == 2:
            if qty > st['issued'] - st['used']:
                st['rq'] += 1
            elif qty > st['stock']:
                st['rs'] += 1
            else:
                st['used'] += qty
                st['stock'] -= qty
        elif kind == 3:
            if st['closed']:
                raise Bail('closed batch cannot be extended')
            st['cap'] += qty
        else:
            if st['closed']:
                raise Bail('batch already closed')
            st['closed'] = True

    for op in ops:
        if len(op) != 2:
            raise Bail('op must be [kind, qty]')
        if op[0] not in (1, 2, 3, 4):
            raise Bail('unknown op kind')
        if op[1] < 0:
            raise Bail('negative qty')
        if op[0] == 4 and op[1] != 0:
            raise Bail('close must carry qty 0')
        act(op[0], op[1])
    return [st['issued'], st['used'], st['rq'], st['rs'], st['rc'],
            max(0, (st['issued'] - st['used']) - st['stock'])]


# =================================================================== java: 万分比分桶
@reg('java', 'alg-pdd-ad-flow-buckets')
def java_allocate_flow(rates, buckets):
    if buckets < 0:
        raise Bail('negative buckets')
    for r in rates:
        if r < 0 or r > 10000:
            raise Bail('rate out of range')
    if sum(rates) != 10000:
        raise Bail('flow rates must sum to 10000')
    # 独立写法：先算余数排序表，再逐份发放
    base = [r * buckets // 10000 for r in rates]
    rem = [(r * buckets) % 10000 for r in rates]
    order = sorted(range(len(rates)), key=lambda i: (-rem[i], i))
    out = list(base)
    left = buckets - sum(base)
    for rank in range(left):
        out[order[rank]] += 1
    return out


# =================================================================== react: 收件人视图模型
@reg('react', 'fe-pdd-receiver-view-model')
def react_receiver_view(row):
    if row is None:
        raise Bail('row must be an object')
    status, risk, stored = row.get('status'), row.get('risk'), row.get('stored')
    if status not in (1, 2, 3, 5):
        raise Bail('unknown order status')
    if status == 5:
        raise Bail('filter value 5 is not a real status')
    if risk not in (0, 1):
        raise Bail('unknown risk control status')
    if stored not in ('cipher', 'plain', 'absent'):
        raise Bail('unknown stored form')
    # 独立写法：把五个输出全部挂在 reason 的一张表上，顺序用元组筛
    reason = next((r for r in ('no-column', 'not-awaiting-shipment', 'risk-hold',
                               'not-ciphered', 'ok')
                   if {'no-column': stored == 'absent',
                       'not-awaiting-shipment': stored != 'absent' and status != 1,
                       'risk-hold': stored != 'absent' and status == 1 and risk == 1,
                       'not-ciphered': stored != 'absent' and status == 1 and risk == 0
                       and stored == 'plain',
                       'ok': stored == 'cipher' and status == 1 and risk == 0}[r]), 'ok')
    label, tone = {'ok': ('可查看', 'ok'),
                   'risk-hold': ('审核中 · 暂不可查看', 'warn'),
                   'not-awaiting-shipment': ('已发货 · 不再提供', 'muted'),
                   'not-ciphered': ('未加密 · 禁止展示', 'warn'),
                   'no-column': ('数据缺失', 'warn')}[reason]
    bucket = {'ok': 'visible', 'risk-hold': 'policy-hidden',
              'not-awaiting-shipment': 'policy-hidden',
              'not-ciphered': 'integrity-broken',
              'no-column': 'pipeline-missing'}[reason]
    return {'reason': reason, 'text': label, 'tone': tone,
            'canDecrypt': reason == 'ok', 'metricBucket': bucket,
            'ariaLabel': '收件人信息：' + label,
            'countsAsMissingForQuality': reason == 'no-column'}


# =================================================================== react: 履约徽标
@reg('react', 'fe-pdd-fulfillment-badge')
def react_badge(row):
    if row is None:
        raise Bail('row must be an object')
    stock = row.get('stockOutHandleStatus')
    risk = row.get('riskControlStatus')
    confirm = row.get('confirmStatus')
    group = row.get('groupStatus')
    paid = row.get('paidAtSec')
    shipped = row.get('shippedAtSec')
    now = row.get('nowSec')
    if stock not in (-1, 0, 1):
        raise Bail('unknown stockOutHandleStatus')
    if risk not in (0, 1):
        raise Bail('unknown riskControlStatus')
    if confirm not in (0, 1, 2):
        raise Bail('unknown confirmStatus')
    if group not in (0, 1, 2):
        raise Bail('unknown groupStatus')
    for v in (paid, now):
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise Bail('timestamps must be non-negative integers')
    if shipped is not None and (not isinstance(shipped, int) or isinstance(shipped, bool)
                                or shipped < 0):
        raise Bail('shippedAtSec must be null or a non-negative integer')

    def pick(cond, value):
        return value if cond else None

    decided = pick(confirm == 2, ('muted', '已取消', False, False)) \
        or pick(risk == 1, ('blocked', '审核中 · 不进发货队列', False, False)) \
        or pick(stock == 0, ('breach', '缺货待处理 · 触发赔付', True, False)) \
        or pick(stock == 1, ('watch', '缺货已处理', True, False)) \
        or pick(group == 2, ('watch', '团失败 · 待回补', False, False))
    if decided:
        level, label, payout, queue = decided
        return {'level': level, 'label': label, 'payoutEligible': payout, 'inShipQueue': queue}
    elapsed = (now if shipped is None else shipped) - paid
    if elapsed > 172800:
        return {'level': 'breach',
                'label': '未发货已超 48 小时' if shipped is None else '已发货但超 48 小时',
                'payoutEligible': True, 'inShipQueue': shipped is None}
    if shipped is None:
        if elapsed > 151200:
            return {'level': 'watch', 'label': '临近 48 小时', 'payoutEligible': False,
                    'inShipQueue': True}
        return {'level': 'ok', 'label': '待发货', 'payoutEligible': False, 'inShipQueue': True}
    return {'level': 'ok', 'label': '已发货', 'payoutEligible': False, 'inShipQueue': False}


# =================================================================== pyspark: 报表分层
@reg('pyspark', 'bd-pdd-report-layer-diff')
def spark_report_layers(rows):
    # 独立写法：分别建两张字典，再对 keys 的并集做分类
    h_sum, h_late, h_cal, d_val, d_cal = {}, {}, {}, {}, {}
    for r in rows:
        k = (r['bill_date'], r['ad_plan_id'])
        if r['layer'] == 'daily':
            d_val[k] = r['charge_fen']
            d_cal[k] = r['caliber_version']
        else:
            h_sum[k] = h_sum.get(k, 0) + r['charge_fen']
            h_cal[k] = max(h_cal.get(k, ''), r['caliber_version'])
            if r['ingest_batch'] > 1:
                h_late[k] = h_late.get(k, 0) + r['charge_fen']
    out = []
    for k in sorted(set(h_sum) | set(d_val)):
        rec = h_sum.get(k)
        daily = d_val.get(k)
        diff = None if rec is None or daily is None else rec - daily
        if daily is None:
            t = 'lost'
        elif rec is None:
            t = 'hourly-missing'
        elif d_cal[k] != h_cal[k]:
            t = 'caliber-change'
        elif diff == 0:
            t = 'match'
        elif diff == h_late.get(k, 0):
            t = 'late-arrival'
        else:
            t = 'unexplained'
        out.append({'bill_date': k[0], 'ad_plan_id': k[1], 'daily_charge_fen': daily,
                    'recomputed_charge_fen': rec, 'diff_charge_fen': diff, 'diff_type': t})
    return out


# =================================================================== pyspark: 缺失率失真
@reg('pyspark', 'bd-pdd-address-missing-metric')
def spark_missing_metric(rows):
    days = sorted({r['biz_date'] for r in rows})
    out = []
    for day in days:
        mine = [r for r in rows if r['biz_date'] == day]
        empty = [r for r in mine if r['receiver_address'] in (None, '')]
        hidden = [r for r in empty if not (r['order_status'] == 1 and r['risk_control_status'] == 0)]
        true_missing = [r for r in empty if r not in hidden]
        raw_bp = half_up_bp(len(empty), len(mine))
        true_bp = half_up_bp(len(true_missing), len(mine))
        out.append({'biz_date': day, 'total_orders': len(mine),
                    'raw_missing_cnt': len(empty), 'policy_hidden_cnt': len(hidden),
                    'true_missing_cnt': len(true_missing),
                    'raw_missing_bp': raw_bp, 'true_missing_bp': true_bp,
                    'distorted': 1 if raw_bp - true_bp > 1000 else 0})
    return out


# =================================================================== pyspark: 四层钱
@reg('pyspark', 'bd-pdd-gmv-three-layer')
def spark_four_layers(rows):
    accts = sorted({r['merchant_account_id'] for r in rows})
    out = []
    for acct in accts:
        mine = [r for r in rows if r['merchant_account_id'] == acct]
        settled = [r for r in mine if r['confirm_status'] == 1 and r['group_status'] == 1]
        deal = sum(r['pay_amount'] for r in mine)
        goods = sum(r['pay_amount'] - r['post_amount'] - r['service_fee'] for r in mine)
        settle = sum(r['pay_amount'] - r['service_fee'] - r['refund_amount'] for r in settled)
        revenue = 0
        for r in settled:
            base = r['pay_amount'] - r['post_amount'] - r['service_fee']
            # Spark 的 (a/b).cast('long') 是**朝零截断**；本题的 base 全为非负，
            # 所以它与 floor 同解。这里显式写成 int(...) 保持与参考解一致的方向。
            revenue += int(qdec(base) * qdec(r['take_rate_bp']) / 10000)
        out.append({'merchant_account_id': acct, 'order_rows': len(mine),
                    'settled_rows': len(settled), 'deal_fen': deal, 'goods_fen': goods,
                    'settle_fen': settle, 'revenue_fen': revenue,
                    'unsettled_gap_bp': half_up_bp(deal - settle, deal)})
    return out


# =================================================================== mysql: 金额口径与三口径
@reg('mysql', 'sql-pdd-amount-caliber')
def mysql_amount_caliber(setup, mutations):
    cols, rows = seed_tables(setup)
    rows = apply_statements(cols, rows, mutations)
    orders = by(rows, cols, 'orders')
    promos = by(rows, cols, 'order_promotions')
    extra = {}
    for p in promos:
        if p['promotion_type'] == 30:
            continue                     # "已包含在平台优惠里" ⇒ 不加
        extra[p['order_sn']] = extra.get(p['order_sn'], Decimal(0)) + qdec(p['promotion_amount'])

    def sub(pred):
        sel = [o for o in orders if pred(o)]
        pay = sum((qdec(o['pay_amount']) for o in sel), Decimal(0))
        subsidy = sum((qdec(o['platform_discount']) + extra.get(o['order_sn'], Decimal(0))
                       for o in sel), Decimal(0))
        broken = 0
        for o in sel:
            formula = (qdec(o['goods_amount']) - qdec(o['discount_amount'])
                       + qdec(o['post_amount']) + qdec(o['service_fee']))
            if abs(qdec(o['pay_amount']) - formula) >= Decimal('0.01'):
                broken += 1
        risk = len([o for o in sel if o['risk_control_status'] == 1])
        return [len(sel), float(pay), float(subsidy), broken, risk]

    main_sn = {o['order_sn'] for o in orders
               if o['is_lucky_flag'] != 2 and o['mkt_biz_type'] != 1}
    specs = [(1, 'main-all', lambda o: o['order_sn'] in main_sn),
             (2, 'main-confirmed', lambda o: o['order_sn'] in main_sn and o['confirm_status'] == 1),
             (3, 'main-group-confirmed',
              lambda o: o['order_sn'] in main_sn and o['confirm_status'] == 1
              and o['group_status'] == 1),
             (4, 'excluded-lucky-or-inner', lambda o: o['order_sn'] not in main_sn)]
    return [[seq, name] + sub(pred) for seq, name, pred in specs]


# =================================================================== mysql: 增量拉单取证
@reg('mysql', 'sql-pdd-increment-recon')
def mysql_increment_recon(setup, mutations):
    cols, rows = seed_tables(setup)
    rows = apply_statements(cols, rows, mutations)
    orders = {o['order_sn']: o for o in by(rows, cols, 'orders')}
    log = by(rows, cols, 'pull_log')
    watermark = by(rows, cols, 'watermark')[0]['watermark_end']
    times = {}
    outside = set()
    for entry in log:
        sn = entry['order_sn']
        times[sn] = times.get(sn, 0) + 1
        order = orders.get(sn)
        if order is None or not (entry['window_start'] <= order['updated_at']
                                 <= entry['window_end']):
            outside.add(sn)
    issues = []
    for sn in sorted(orders):
        if orders[sn]['updated_at'] > watermark:
            continue
        if sn not in times:
            issues.append([sn, 'missed'])
        if sn in outside:
            issues.append([sn, 'out-of-window'])
        if times.get(sn, 0) > 1:
            issues.append([sn, 'pulled-twice'])
    for sn in sorted(outside):
        if sn not in orders:
            issues.append([sn, 'out-of-window'])
    return issues


# =================================================================== mysql: 活跃商家
@reg('mysql', 'sql-pdd-active-merchant')
def mysql_active_merchant(setup, mutations):
    cols, rows = seed_tables(setup)
    rows = apply_statements(cols, rows, mutations)
    orders = by(rows, cols, 'orders')
    refunds = {r['order_sn']: r for r in by(rows, cols, 'order_refund')}
    subject = {m['merchant_account_id']: m['subject_id'] for m in by(rows, cols, 'merchant_shop')}
    out = []
    for period in sorted(by(rows, cols, 'period_calendar'), key=lambda p: p['period_tag']):
        lo, hi = period['start_ts'], period['end_ts']
        shipped = [o for o in orders
                   if o['shipped_time'] is not None and lo <= o['shipped_time'] <= hi]
        accounts = sorted({o['merchant_account_id'] for o in shipped})
        survivors = set()
        for o in shipped:
            refund = refunds.get(o['order_sn'])
            if refund is None or refund['is_full'] != 1:
                survivors.add(o['merchant_account_id'])
        kept = [a for a in accounts if a in survivors]
        subjects = {subject[a] for a in accounts if a in subject}
        out.append([period['period_tag'], len(accounts), len(kept),
                    len(accounts) - len(kept), len(subjects), len(shipped)])
    return out


# =================================================================== mysql: 日账单对账
@reg('mysql', 'sql-pdd-bill-recon')
def mysql_bill_recon(setup, mutations):
    cols, rows = seed_tables(setup)
    rows = apply_statements(cols, rows, mutations)
    cfg = by(rows, cols, 'run_config')[0]
    as_of, tol = cfg['as_of_date'], qdec(cfg['tolerance'])
    bill = {b['order_sn']: qdec(b['settle_amount']) for b in by(rows, cols, 'bill_daily')}
    refund = {r['order_sn']: qdec(r['refund_amount']) for r in by(rows, cols, 'order_refund')}
    out = []
    for o in by(rows, cols, 'orders'):
        if o['confirm_status'] != 1 or o['group_status'] != 1:
            continue
        sn = o['order_sn']
        pay, fee = qdec(o['pay_amount']), qdec(o['service_fee'])
        want = pay - fee - refund.get(sn, Decimal(0))
        if sn in bill:
            if abs(bill[sn] - want) >= tol:
                out.append([sn, 'amount-mismatch'])
        elif o['settle_due_date'] > as_of:
            out.append([sn, 'not-yet-due'])
        elif o['risk_control_status'] == 1:
            out.append([sn, 'risk-hold'])
        elif refund.get(sn, Decimal(0)) >= pay:
            out.append([sn, 'refund-offset'])
        else:
            out.append([sn, 'real-gap'])
    return sorted(out, key=lambda x: int(x[0]))


# =================================================================== mysql: 差异定价体检
@reg('mysql', 'sql-pdd-price-consistency')
def mysql_price_consistency(setup, mutations):
    cols, rows = seed_tables(setup)
    rows = apply_statements(cols, rows, mutations)
    log = by(rows, cols, 'price_log')
    out = []
    for sku in sorted(s['sku_id'] for s in by(rows, cols, 'sku_base')):
        views = {qdec(l['show_price']) for l in log
                 if l['sku_id'] == sku and l['row_type'] == 'view'}
        trades = [l for l in log if l['sku_id'] == sku and l['row_type'] == 'trade']
        eff = [qdec(l['trade_price']) + (Decimal(0) if l['coupon_deduct'] is None
                                         else qdec(l['coupon_deduct'])) for l in trades]
        kinds = sorted(set(eff))
        spread = None if not eff else float(max(kinds) - min(kinds))
        out.append([sku, len(views), len(trades), len(kinds), spread,
                    1 if len(kinds) > 1 else 0])
    return out


# =================================================================== 比对与调度
def num(x):
    if isinstance(x, bool):
        return float(x)
    if isinstance(x, (int, float, Decimal)):
        return round(float(x), 6)
    text = str(x).strip()
    try:
        return round(float(text), 6)
    except (ValueError, TypeError):
        return None


def eq_cell(a, b):
    na, nb = num(a), num(b)
    if na is not None and nb is not None:
        return na == nb
    if a is None or b is None or isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return a == b
    sa, sb = str(a).strip().lower(), str(b).strip().lower()
    sa = 'null' if sa in ('null', '\\n') else sa
    sb = 'null' if sb in ('null', '\\n') else sb
    return sa == sb


def eq_rows(got, expected):
    """MySQL 的期望值可能是裸 []、[[...]] 或 {columns, rows, orderSensitive}。"""
    if isinstance(expected, dict):
        expected = expected['rows']
    if len(got) != len(expected):
        return False
    for g, e in zip(got, expected):
        if len(g) != len(e) or not all(eq_cell(x, y) for x, y in zip(g, e)):
            return False
    return True


def eq_objects(got, expected):
    """pyspark 的期望是**行对象数组**；react 的期望可能是**单个对象**。"""
    if isinstance(expected, dict):
        return isinstance(got, dict) and set(got) == set(expected) \
            and all(eq_cell(got[k], expected[k]) for k in expected)
    if len(got) != len(expected):
        return False
    for g, e in zip(got, expected):
        if set(g) != set(e):
            return False
        if not all(eq_cell(g[k], e[k]) for k in e):
            return False
    return True


def eq_scalars(got, expected):
    if isinstance(expected, list) and isinstance(got, list):
        return len(got) == len(expected) and all(eq_cell(x, y) for x, y in zip(got, expected))
    return eq_cell(got, expected)


DISPATCH = {'java-junit': JAVA, 'mysql': MYSQL, 'pyspark': PYSPARK, 'react-vitest': REACT}
COMPARE = {'java-junit': eq_scalars, 'mysql': eq_rows,
           'pyspark': eq_objects, 'react-vitest': eq_objects}


def main(argv):
    paths = []
    for p in (argv or ['data/drafts-pdd/out']):
        if os.path.isdir(p):
            paths += [os.path.join(p, n) for n in sorted(os.listdir(p)) if n.endswith('.json')]
        elif p.endswith('.json'):
            paths.append(p)
    if not paths:
        print('没有 .json 草稿可检查', file=sys.stderr)
        return 2
    failed = skipped = passed = 0
    for path in paths:
        q = json.load(open(path, encoding='utf-8'))
        key = os.path.splitext(os.path.basename(path))[0]
        kind = q['judgeKind']
        if kind == 'llm-rubric':
            print('SKIP %s  主观题（llm-rubric），没有可执行用例' % key)
            skipped += 1
            continue
        if kind == 'redis':
            print('SKIP %s  redis 脚本题：判分靠服务端最终状态，本机没有 Redis 可跑（交给容器矩阵）' % key)
            skipped += 1
            continue
        fn = DISPATCH[kind].get(key)
        if fn is None:
            print('SKIP %s  未登记独立重写（%s）' % (key, path))
            skipped += 1
            continue
        cases = q['cases']
        bad = []
        for c in cases:
            raw = c['input']
            if kind == 'mysql':
                args = (q['runner']['setup'], raw)
            elif kind == 'pyspark':
                args = (raw['rows'],)
            else:
                args = tuple(raw)
            throw = c.get('expectThrow')
            try:
                got = fn(*args)
                raised = None
            except Bail as exc:
                got, raised = None, exc.message
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
            if not COMPARE[kind](got, c['expected']):
                bad.append('%s: expected=%s got=%s' % (c['name'], c['expected'], got))
        if bad:
            failed += 1
            print('FAIL %s' % key)
            for b in bad:
                print('       ' + b)
        else:
            passed += 1
            print('ok   %s  (%d 用例)' % (key, len(cases)))
    print('\n通过 %d，跳过 %d，失败 %d（共 %d 份草稿）' % (passed, skipped, failed, len(paths)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
