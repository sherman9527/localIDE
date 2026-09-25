#!/usr/bin/env python3
"""
Apple 已入库题的"数字必须有来源"探针（与 deepseek/probe_naive.py 同一套纪律）。

为什么要有它：容器判题矩阵只证明"朴素解**整体**不通过"，不证明答案里写的那句
"三种口径在基线上是 1 / 1 / 2"或"按上游那个错窗口算会被丢掉"对得上数据。
写进答案的数字必须是量出来的，不能是推出来的。

判据方向很重要：**数字是从答案里抠出来再和数据比的**，不是在探针里重写一遍。
（探针里写死 1/1/2 只能证明"数据给 1/1/2"，答案被人改成 1/2/2 它照样绿 ——
 破坏性验证就是这么把第一版打回来的。）

与 precheck 的分工：precheck 证明**题能做对**（expected 与参考解一致），
本文件证明**说明没瞎写**（答案点名的数字与用例里真发的数据一致）。
所以读的是 `content/questions/` 里**已入库的那份**，不是草稿的 out 产物。

用法：python scripts/bank/drafts/apple/probe_naive.py
"""
import datetime
import glob
import json
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 4)))
BANK = os.path.join(ROOT, 'content', 'questions')

FAILURES = []
MEASURED = []


def check(claim, measured, stated_value):
    """把"量到的"与"答案写的"并排打印；不一致就记账。"""
    if stated_value is None:
        return                      # 抠不到数字时 stated() 已经记过一次失败，别重复报
    ok = str(measured) == str(stated_value)
    MEASURED.append(f'{"  ok  " if ok else "  FAIL"}  {claim}: 量到 {measured}，答案写 {stated_value}')
    if not ok:
        FAILURES.append(f'{claim}: 答案写 {stated_value}，实际量到 {measured}')


def stated(answer, pattern, label):
    """从答案里抠出它自己声明的数字。抠不到 = 探针与答案脱钩，也算失败。
    多个捕获组按出现顺序用空格拼起来，与"量到"侧的拼法对齐。"""
    m = re.search(pattern, answer)
    if not m:
        FAILURES.append(f'{label}: 答案里找不到 /{pattern}/ —— 这句话被改写了，探针得跟着改')
        return None
    return ' '.join(m.groups()) if len(m.groups()) > 1 else m.group(1)


def load(qid):
    for path in glob.glob(os.path.join(BANK, '**', '*.json'), recursive=True):
        if os.path.basename(path)[:-5] == qid:
            with open(path, encoding='utf-8') as fh:
                return json.load(fh)
    raise SystemExit(f'题库里找不到 {qid}')


def split_top(text):
    """按顶层逗号切 VALUES 列表（本题 seed 里没有嵌套括号）。"""
    parts, depth, quote, buf = [], 0, None, ''
    for ch in text:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch == "'":
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
    if token == 'NULL':
        return None
    if token.startswith("'"):
        return token[1:-1]
    return float(token) if '.' in token else int(token)


def row_of(inner):
    return tuple(atom(part) for part in split_top(inner))


# ============================================================ sql-mysql-0019 DQC
def dqc_seed(setup):
    orders, devices, rules = [], [], []
    for stmt in setup:
        if stmt.startswith('INSERT INTO orders_fact'):
            for part in split_top(stmt.split('VALUES', 1)[1]):
                orders.append(list(row_of(part.strip()[1:-1])))
        elif stmt.startswith('INSERT INTO dim_device'):
            for part in split_top(stmt.split('VALUES', 1)[1]):
                devices.append(int(atom(part.strip()[1:-1])))
        elif stmt.startswith('INSERT INTO dqc_rule'):
            for part in split_top(stmt.split('VALUES', 1)[1]):
                rules.append(list(row_of(part.strip()[1:-1])))
    return orders, devices, rules


def dqc_apply(orders, devices, rules, mutations):
    """把用例的变异 SQL 逐条落到内存行集上（与 seed 同一份事实）。"""
    orders = [list(o) for o in orders]
    devices = list(devices)
    rules = [list(r) for r in rules]
    for sql in mutations:
        s = sql.strip()
        m = re.fullmatch(r'DELETE FROM orders_fact WHERE order_id = (\d+)', s)
        if m:
            orders = [o for o in orders if o[0] != int(m.group(1))]
            continue
        m = re.fullmatch(r'DELETE FROM dim_device WHERE device_id = (\d+)', s)
        if m:
            devices = [d for d in devices if d != int(m.group(1))]
            continue
        m = re.fullmatch(r'UPDATE dqc_rule SET threshold = ([\d.]+) WHERE rule_id = (\d+)', s)
        if m:
            for r in rules:
                if r[0] == int(m.group(2)):
                    r[3] = float(m.group(1))
            continue
        m = re.fullmatch(r"INSERT INTO orders_fact VALUES \((.+)\)", s)
        if m:
            orders.append(list(row_of(m.group(1))))
            continue
        raise SystemExit(f'探针不认这条变异 SQL：{s}')
    return orders, devices, rules


def rate(violations, checked):
    if checked == 0:
        return None
    return float((Decimal(violations) * 100 / Decimal(checked)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def dqc_correct(orders, devices, rules):
    """题面那张口径表的独立重写（分母只有一个）。"""
    active = [o for o in orders if o[4] != 'test']
    checked = len(active)
    present = set(devices)
    groups = {}
    for o in active:
        groups[o[1]] = groups.get(o[1], 0) + 1
    hits = {
        'null_rate': sum(1 for o in active if o[3] is None),
        'negative_value': sum(1 for o in active if o[3] is not None and Decimal(str(o[3])) < 0),
        'orphan': sum(1 for o in active if o[2] is not None and o[2] not in present),
        'duplicate': sum(c - 1 for c in groups.values()),
    }
    out = []
    for rule_id, rule_type, _col, threshold in rules:
        v = hits[rule_type]
        pct = rate(v, checked)
        fail = 0 if pct is None else (1 if Decimal(str(pct)) / 100 > Decimal(str(threshold)) else 0)
        out.append([rule_id, rule_type, checked, v, pct, fail])
    return out


def dqc_duplicate_variants(orders):
    """答案点名的三种 duplicate 口径：多出来的行数 / 重复的组数 / 涉及重复的总行数。"""
    active = [o for o in orders if o[4] != 'test']
    groups = {}
    for o in active:
        groups[o[1]] = groups.get(o[1], 0) + 1
    extra = sum(c - 1 for c in groups.values())
    dup_groups = sum(1 for c in groups.values() if c > 1)
    involved = sum(c for c in groups.values() if c > 1)
    return extra, dup_groups, involved


# 注意：这里**不**重写 runner.naiveSolution。矩阵已经证明"朴素解整体不通过"；
# 把它的 MySQL 三值逻辑（`NULL <= 0` 不成立、LEFT JOIN 无匹配时留一行 NULL）再抄一遍 Python，
# 只会让探针自己变成新的错源。探针只负责"答案里写死的数字"。
def probe_dqc():
    q = load('sql-mysql-0019')
    answer = q['answer']
    base_orders, base_devices, base_rules = dqc_seed(q['runner']['setup'])
    active = [o for o in base_orders if o[4] != 'test']

    check('DQC 基线有效行数', len(active), stated(answer, r'有效行 (\d+) 条', '有效行数'))
    checked = len(active)

    extra, dup_groups, involved = dqc_duplicate_variants(base_orders)
    check('duplicate 三种口径（多出来 / 组数 / 涉及行）',
          ' / '.join(str(n) for n in (extra, dup_groups, involved)),
          stated(answer, r'三种口径在基线上是 ([\d /]+)', '三口径'))
    check('duplicate 的比率（与 10% 阈值比的那个数）',
          rate(extra, checked), stated(answer, r'(\d+\.\d+)% > 10%', 'duplicate 比率'))

    # "10% 阈值实际变成 5%"：翻倍的是分子，所以等效阈值 = 原阈值 / 翻倍系数
    m = re.search(r'"(\d+)% 阈值"实际变成"(\d+)%"', answer)
    if not m:
        FAILURES.append('等效阈值: 答案里找不到 /"(\\d+)% 阈值"实际变成"(\\d+)%"/')
    else:
        original, effective = int(m.group(1)), int(m.group(2))
        factor = involved // extra if extra else 0
        check('第三种口径把分子翻了几倍（答案说的"翻倍"）', factor, 2)
        check(f'分子翻 {factor} 倍 ⇒ {original}% 阈值的等效线', f'{original // factor}', effective)

    # "把 NULL 设备也算成孤儿 ⇒ violations 从 1 变 2、比率从 16.67% 变 33.33%"
    present = set(base_devices)
    right = sum(1 for o in active if o[2] is not None and o[2] not in present)
    wrong = sum(1 for o in active if o[2] is None or o[2] not in present)
    check('orphan 的 violations 与比率：正确口径 vs 把 NULL 也算上',
          f'{right} {wrong} {rate(right, checked)} {rate(wrong, checked)}',
          stated(answer, r'violations 就从 (\d+) 变 (\d+)、比率从 (\d+\.\d+)% 变 (\d+\.\d+)%', 'NULL 当孤儿的代价'))

    for case in q['cases']:
        name = case['name']
        orders, devices, rules = dqc_apply(base_orders, base_devices, base_rules, case['input'])
        mine = dqc_correct(orders, devices, rules)
        want = case['expected']['rows']
        if mine != want:
            FAILURES.append(f"DQC 用例「{name}」expected 与独立重写不一致\n"
                            f"    expected={want}\n    重算  ={mine}")
        else:
            MEASURED.append(f'  ok    DQC 用例「{name}」expected 与独立重写一致')

    # 用例名里写死的数字也算答案的一部分（用户先看得到它）：
    # "violations 是 3，不是 1 也不是 4" 依次对应 多出来的行数 / 重复的组数 / 涉及重复的总行数
    four = [c for c in q['cases'] if '变四行' in c['name']][0]
    orders, _devices, _rules = dqc_apply(base_orders, base_devices, base_rules, four['input'])
    check('用例名「customer 100 变四行」里的三口径',
          ' '.join(str(n) for n in dqc_duplicate_variants(orders)),
          stated(four['name'], r'violations 是 (\d+)，不是 (\d+) 也不是 (\d+)', '用例名里的三口径'))

    # "答案点名的用例是否存在"已经上收到题库闸门 content.test.ts（覆盖全库），
    # 这里不再重复一遍 —— 两处判据迟早漂移。


# ==================================================== bd-pyspark-0016 迟到窗口
WINDOW_SEC = 900
ALLOWED_LATE_SEC = 600
FMT = '%Y-%m-%d %H:%M:%S'


def to_epoch(text):
    return int(datetime.datetime.strptime(text, FMT).timestamp())


def from_epoch(sec):
    return datetime.datetime.fromtimestamp(sec).strftime(FMT)


def hhmmss(text):
    return text[11:]


def hhmm(text):
    return text[11:16]


def window_rows(rows, trust_upstream):
    """trust_upstream=False 按 event_time 重算窗口；True 是"信上游标的 window_start"的朴素解。"""
    groups = {}
    for row in rows:
        ev = to_epoch(row['event_time'])
        wm = to_epoch(row['watermark_at_arrival'])
        ws = to_epoch(row['window_start']) if trust_upstream else (ev // WINDOW_SEC) * WINDOW_SEC
        we = ws + WINDOW_SEC
        key = (row['biz_key'], from_epoch(ws))
        g = groups.setdefault(key, {'accepted': 0, 'dropped': 0, 'late_accepted': 0, 'misbucketed': 0})
        if wm <= we + ALLOWED_LATE_SEC:
            g['accepted'] += 1
            if wm > we:
                g['late_accepted'] += 1
        else:
            g['dropped'] += 1
        if not trust_upstream and row['window_start'] != from_epoch(ws):
            g['misbucketed'] += 1
    out = []
    for (biz_key, ws), g in sorted(groups.items()):
        out.append({'biz_key': biz_key, 'window_start': ws,
                    'window_end': from_epoch(to_epoch(ws) + WINDOW_SEC), **g})
    return out


def probe_late_window():
    q = load('bd-pyspark-0016')
    answer = q['answer']
    baseline = q['cases'][0]
    rows = baseline['input']['rows']

    mine = window_rows(rows, trust_upstream=False)
    if mine != baseline['expected']:
        FAILURES.append(f"迟到窗口基线用例 expected 与独立重写不一致\n"
                        f"    expected={baseline['expected']}\n    重算  ={mine}")
    else:
        MEASURED.append('  ok    迟到窗口基线用例 expected 与独立重写一致')

    late = [r for r in rows
            if r['window_start'] != from_epoch((to_epoch(r['event_time']) // WINDOW_SEC) * WINDOW_SEC)]
    check('基线里被上游标错窗口的记录条数', len(late), 1)
    if len(late) != 1:
        return
    row = late[0]
    ev, wm, up = row['event_time'], row['watermark_at_arrival'], row['window_start']
    rewe = (to_epoch(ev) // WINDOW_SEC) * WINDOW_SEC + WINDOW_SEC          # 重算后的 window_end
    updeadline = to_epoch(up) + WINDOW_SEC + ALLOWED_LATE_SEC               # 拿上游窗口算的迟到截止

    check('答案说的 event_time', hhmmss(ev), stated(answer, r'event_time = (\d\d:\d\d:\d\d)', 'event_time'))
    check('答案说上游把它标成', hhmm(up), stated(answer, r'上游把它标成 `(\d\d:\d\d)`', '上游窗口起点'))
    check('答案说水位线是', hhmm(wm), stated(answer, r'若 `watermark = (\d\d:\d\d)`', '水位线'))
    check('答案说重算后的 window_end', hhmm(from_epoch(rewe)), stated(answer, r'重算的 `we=(\d\d:\d\d)`', '重算 end'))
    check('答案说上游那个错窗口的 end', hhmm(from_epoch(to_epoch(up) + WINDOW_SEC)),
          stated(answer, r'错窗口（`we=(\d\d:\d\d)`）', '上游 end'))
    check('答案说"按错窗口 10:35 > 10:25"这一对时刻',
          f'{hhmm(wm)} {hhmm(from_epoch(updeadline))}',
          stated(answer, r'`(\d\d:\d\d) > (\d\d:\d\d)`', '错窗口的比较'))
    check('按重算窗口：收还是丢（1=收）', 1 if to_epoch(wm) <= rewe + ALLOWED_LATE_SEC else 0, 1)
    check('按上游错窗口：收还是丢（1=丢）', 1 if to_epoch(wm) <= updeadline else 0, 0)
    check('朴素解（信上游窗口）在这组上丢了几条', sum(g['dropped'] for g in window_rows(rows, True)), 1)
    check('参考解在这组上丢了几条', sum(g['dropped'] for g in mine), 0)

    for case in q['cases'][1:]:
        got = window_rows(case['input']['rows'], trust_upstream=False)
        if got != case['expected']:
            FAILURES.append(f"迟到窗口用例「{case['name']}」expected 与独立重写不一致\n"
                            f"    expected={case['expected']}\n    重算  ={got}")
        else:
            MEASURED.append(f"  ok    迟到窗口用例「{case['name']}」expected 与独立重写一致")


def main():
    probe_dqc()
    probe_late_window()
    print('\n'.join(MEASURED))
    print(f'\n量到 {len(MEASURED)} 项，失败 {len(FAILURES)} 项')
    if FAILURES:
        print('\n'.join('  ✗ ' + f for f in FAILURES))
        return 1
    print('✓ 答案里的每个具体数字都对得上已入库的那份数据')
    return 0


if __name__ == '__main__':
    sys.exit(main())
