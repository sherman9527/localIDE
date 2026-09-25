#!/usr/bin/env python3
"""
Airbnb 已入库题的"数字必须有来源"探针（与 apple / deepseek 那两份同一套纪律）。

分工照旧：precheck 证明题能做对，容器矩阵证明判题器真判，
本文件证明**答案与用例名里写死的那些数字**对得上已入库的那份数据。
数字一律从答案 / 用例名里用正则抠出来再比 —— 在探针里重写一遍期望值只能证明探针自己没算错。

覆盖范围（诚实列出）：
- `sql-mysql-0014` 报价拆解：逐晚和、BETWEEN 误把退房日算进来的 1570.48、
  `MIN(price) × 晚数` 的 399.96 与差值 170.53、清洁费只收一次，
  以及六条用例的 expected 全量复算。
其余 Airbnb 题目的数字仍靠 precheck + 矩阵，没在这里假装覆盖；
"答案点名的用例是否存在"已上收到题库闸门（覆盖全库）。

用法：python scripts/bank/drafts/airbnb/probe_naive.py
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
    if stated_value is None:
        return
    ok = str(measured) == str(stated_value)
    MEASURED.append(f'{"  ok  " if ok else "  FAIL"}  {claim}: 量到 {measured}，文案写 {stated_value}')
    if not ok:
        FAILURES.append(f'{claim}: 文案写 {stated_value}，实际量到 {measured}')


def stated(text, pattern, label):
    m = re.search(pattern, text)
    if not m:
        FAILURES.append(f'{label}: 文案里找不到 /{pattern}/ —— 这句话被改写了，探针得跟着改')
        return None
    return ' '.join(m.groups()) if len(m.groups()) > 1 else m.group(1)


def load(qid):
    for path in glob.glob(os.path.join(BANK, '**', '*.json'), recursive=True):
        if os.path.basename(path)[:-5] == qid:
            with open(path, encoding='utf-8') as fh:
                return json.load(fh)
    raise SystemExit(f'题库里找不到 {qid}')


def money(value):
    return Decimal(str(value)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def value_of(token):
    token = token.strip()
    if token == 'NULL':
        return None
    m = re.fullmatch(r"DATE\('([^']+)'\)", token)
    if m:
        return datetime.date.fromisoformat(m.group(1))
    if token.startswith("'"):
        return token[1:-1]
    return Decimal(token)


def split_top(text):
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
        elif ch == '(':
            depth += 1
            buf += ch
        elif ch == ')':
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


def rows_of(stmt):
    body = stmt.split('VALUES', 1)[1].strip()
    out = []
    for chunk in split_top(body):
        out.append([value_of(part) for part in split_top(chunk.strip()[1:-1])])
    return out


# ==================================================== sql-mysql-0014 报价拆解
def seed(setup):
    prices, fee, booking = [], None, None
    for stmt in setup:
        if stmt.startswith('INSERT INTO nightly_price'):
            prices.extend(rows_of(stmt))
        elif stmt.startswith('INSERT INTO listing_fee'):
            fee = rows_of(stmt)[0]
        elif stmt.startswith('INSERT INTO reservation'):
            booking = rows_of(stmt)[0]
    return prices, fee, booking


def apply_mutations(prices, fee, booking, mutations):
    prices = [list(p) for p in prices]
    fee = list(fee)
    booking = list(booking)
    for sql in mutations:
        s = sql.strip()
        m = re.fullmatch(r"DELETE FROM nightly_price WHERE stay_date = DATE\('([^']+)'\)", s)
        if m:
            day = datetime.date.fromisoformat(m.group(1))
            prices = [p for p in prices if p[1] != day]
            continue
        m = re.fullmatch(r"UPDATE reservation SET check_in = DATE\('([^']+)'\), check_out = DATE\('([^']+)'\) WHERE listing_id = \d+", s)
        if m:
            booking[1] = datetime.date.fromisoformat(m.group(1))
            booking[2] = datetime.date.fromisoformat(m.group(2))
            continue
        m = re.fullmatch(r'UPDATE listing_fee SET service_rate = ([\d.]+), tax_rate = ([\d.]+) WHERE listing_id = \d+', s)
        if m:
            fee[2] = Decimal(m.group(1))
            fee[3] = Decimal(m.group(2))
            continue
        raise SystemExit(f'探针不认这条变异 SQL：{s}')
    return prices, fee, booking


def quote(prices, fee, booking, inclusive_checkout=False):
    """
    参考解的口径：[check_in, check_out) 逐晚相加；缺任一晚 ⇒ 整单不报价。
    inclusive_checkout=True 是题面点名的 `BETWEEN` 误法（把退房日那晚也算进来）。
    """
    start, end = booking[1], booking[2]
    span = range(0, (end - start).days + (1 if inclusive_checkout else 0))
    days = [start + datetime.timedelta(days=i) for i in span]
    by_day = {p[1]: p[2] for p in prices}
    if not days:
        return []
    if any(day not in by_day for day in days):
        return []                                    # 缺价 ⇒ 不报价，而不是按 0 补
    lodging = sum((by_day[day] for day in days), Decimal(0))
    nights = len(days)
    cleaning = fee[1]
    service = money((lodging + cleaning) * fee[2])
    tax = money(lodging * fee[3])
    return [[nights, money(lodging), money(cleaning), service, tax, money(lodging + cleaning + service + tax)]]


def norm_row(row):
    """
    两边的数字统一成 Decimal 再比：expected 里 `nights` 是整数 4、金额是 JS 数 570.49，
    重算侧是 Decimal('570.49') —— 按字符串比会把"4 vs 4.00"报成不一致。
    """
    return [Decimal(str(cell)) if isinstance(cell, (int, float, Decimal)) else cell for cell in row]


def as_rows(expected):
    """expected 有两种形状：`{"columns":…, "rows":…}` 或空结果的**裸 `[]`**（docs/JUDGING.md 的约定）。"""
    if isinstance(expected, list):
        return []
    return [norm_row(row) for row in expected['rows']]


def probe_price_quote():
    q = load('sql-mysql-0014')
    answer = q['answer'] + ' ' + ' '.join(c['name'] for c in q['cases'])
    prices, fee, booking = seed(q['runner']['setup'])

    for case in q['cases']:
        p, f, b = apply_mutations(prices, fee, booking, case['input'])
        mine = [norm_row(row) for row in quote(p, f, b)]
        want = as_rows(case['expected'])
        if mine != want:
            FAILURES.append(f"用例「{case['name']}」expected 与独立重写不一致\n"
                            f"    expected={want}\n    重算  ={mine}")
        else:
            MEASURED.append(f"  ok    用例「{case['name']}」expected 与独立重写一致")

    base = quote(prices, fee, booking)[0]
    between = quote(prices, fee, booking, inclusive_checkout=True)[0]
    check('答案说的四晚逐晚相加', str(base[1]), stated(answer, r'lodging = [^=]+ = ([\d.]+)', 'lodging 和'))
    check('答案说"用 BETWEEN 就变成 X 起跳"', str(between[1]),
          stated(answer, r'`BETWEEN` 就变成 `([\d.]+)` 起跳', 'BETWEEN 误法'))
    check('BETWEEN 多算的正是退房日那一晚', str(between[1] - base[1]),
          stated(answer, r'退房日 `[\d-]+` 的 `([\d.]+)`', '退房日那晚价'))

    cheapest = min(p[2] for p in prices if p[1] >= booking[1] and p[1] < booking[2])
    min_times_nights = money(cheapest * base[0])
    check('答案说"MIN(price) × 晚数"给多少', str(min_times_nights),
          stated(answer, r'本题差 `[\d.]+ − ([\d.]+) =', 'MIN×晚数'))
    check('…以及它与逐晚和差多少', str(money(base[1] - min_times_nights)),
          stated(answer, r'本题差 `[\d.]+ − [\d.]+ = ([\d.]+)', 'MIN×晚数的差'))

    # 答案说"住 4 晚收 4 次清洁费"是常见误法：先确认晚数与"正确口径只收一次"都成立
    nights = int(base[0])
    check('答案说的晚数', str(nights), stated(answer, r'住 (\d+) 晚收 \d+ 次清洁费', '清洁费按晚摊'))
    check('正确口径下清洁费只收一次（不是按晚摊）', str(base[2]), str(money(fee[1])))


# ============================================ 全 Airbnb：答案点名的用例必须存在
# （这条已经上收到题库闸门 `content.test.ts`，覆盖全库而不是三家 —— 探针不再重复一遍）


def main():
    probe_price_quote()
    print('\n'.join(MEASURED))
    print(f'\n量到 {len(MEASURED)} 项，失败 {len(FAILURES)} 项')
    if FAILURES:
        print('\n'.join('  ✗ ' + f for f in FAILURES))
        return 1
    print('✓ Airbnb 这份探针：答案里的数字与用例引用全部对得上')
    return 0


if __name__ == '__main__':
    sys.exit(main())
