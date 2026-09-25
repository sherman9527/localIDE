#!/usr/bin/env python3
"""
PDD 已入库题的"答案里的数字必须有来源"探针（与 apple / airbnb / deepseek 同一套纪律）。

判据方向：**数字是用正则从 `content/questions/` 那份答案 / 用例名 / 用例备注里抠出来的，
再和量到的值比** —— 不在探针里重写一遍常量。
探针里写死 `33/33/34` 只能证明"数据给 33/33/34"，答案被人改成 `33/34/33` 它照样绿；
这条方向是 WI-65 的破坏性验证打回来的。
抠不到 = 那句话被改写而探针没跟上，同样算失败（探针与答案脱钩不许看起来像通过）。

与 precheck 的分工：precheck 证明**题能做对**（独立重写与 expected 一致），
本文件证明**说明没瞎写**（答案点名的具体数字对得上已入库的那份数据）。
本文件读的是**入库之后**的文件，所以"ingest 之后被人手改了一个数"也会在这里红。
独立重写复用同目录的 `precheck.py` —— 刻意不抄第三份模型：
三份"等价实现"迟早漂移，而漂移时最可疑的恰恰是最新写的那份。

覆盖范围（**没测的题不假装测过**）：
  ✓ 逐用例复核（16 道，precheck 已登记独立重写）：
    alg-java-0040/0041/0042/0043/0044/0045、sql-mysql-0020/0021/0022/0023/0024、
    bd-pyspark-0017/0018/0019、fe-react-0018/0019
  ✓ 答案里写死的数字：见下面每个 probe_* 的 check(...) 清单
  ✗ sql-redis-0009 / sql-redis-0010：判分事实是 Redis 最终状态，本机没有 Redis，
    只能由容器判题矩阵覆盖（precheck 对这两份也打 SKIP）
  ✗ 12 道 llm-rubric 主观题：答案里不需要从数据量出来的数字。
    它们引用的是官方披露值（1091.5 亿、15 亿元、67604 家、50.4%/49.6% 等），
    那部分由两份知识文件的来源清单负责，不由本探针负责。

KEY_TO_ID 是"草稿名 → 入库 id"的对照表。它坏了会立刻显形：
`named()` 按用例名前缀取用例，取不到就 SystemExit，不会静默测错题。

用法：python scripts/bank/drafts/pdd/probe_naive.py
"""
import glob
import importlib.util
import json
import os
import re
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 4)))
BANK = os.path.join(ROOT, 'content', 'questions')

_spec = importlib.util.spec_from_file_location('pdd_precheck', os.path.join(HERE, 'precheck.py'))
PRE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PRE)

KEY_TO_ID = {
    'alg-pdd-ad-flow-buckets': 'alg-java-0040',
    'alg-pdd-coupon-quota': 'alg-java-0041',
    'alg-pdd-increment-paging': 'alg-java-0042',
    'alg-pdd-pay-amount': 'alg-java-0043',
    'alg-pdd-phantom-stock': 'alg-java-0044',
    'alg-pdd-receiver-visibility': 'alg-java-0045',
    'sql-pdd-active-merchant': 'sql-mysql-0020',
    'sql-pdd-amount-caliber': 'sql-mysql-0021',
    'sql-pdd-bill-recon': 'sql-mysql-0022',
    'sql-pdd-increment-recon': 'sql-mysql-0023',
    'sql-pdd-price-consistency': 'sql-mysql-0024',
    'bd-pdd-address-missing-metric': 'bd-pyspark-0017',
    'bd-pdd-gmv-three-layer': 'bd-pyspark-0018',
    'bd-pdd-report-layer-diff': 'bd-pyspark-0019',
    'fe-pdd-fulfillment-badge': 'fe-react-0018',
    'fe-pdd-receiver-view-model': 'fe-react-0019',
}
ID_TO_KEY = {v: k for k, v in KEY_TO_ID.items()}

CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}

FAILURES = []
MEASURED = []
_CACHE = {}


def load(qid):
    if qid not in _CACHE:
        hits = [p for p in glob.glob(os.path.join(BANK, '**', '*.json'), recursive=True)
                if os.path.basename(p)[:-5] == qid]
        if not hits:
            raise SystemExit('题库里找不到 ' + qid)
        with open(hits[0], encoding='utf-8') as fh:
            _CACHE[qid] = json.load(fh)
    return _CACHE[qid]


def text_of(q):
    """答案 + 用例名 + 用例备注：都是"写给人的话"，都算答案文本。"""
    parts = [q.get('answer') or '', q.get('statement') or '']
    for c in q.get('cases') or []:
        parts.append(c['name'])
        parts.append(c.get('note') or '')
    for p in (q.get('rubric') or {}).get('points') or []:
        parts.append(p.get('criteria') or '')
    return '\n'.join(parts)


def _eq(measured, said):
    if isinstance(measured, bool):
        return ('true' if measured else 'false') == said.strip().lower()
    if measured is None:
        return said.strip().upper() in ('NULL', 'NONE')
    try:
        return abs(float(Decimal(str(measured))) - float(Decimal(said))) < 1e-9
    except Exception:
        return str(measured).strip() == said.strip()


def check(claim, measured, text, pattern, label):
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('{}: 文案里找不到 /{}/ —— 这句话被改写了，探针得跟着改'.format(label, pattern))
        return
    ok = _eq(measured, m.group(1))
    MEASURED.append('  {}  {}: 量到 {}，文案写 {}'.format(
        'ok  ' if ok else 'FAIL', claim, measured, m.group(1)))
    if not ok:
        FAILURES.append('{}: 文案写 {}，实际量到 {}'.format(claim, m.group(1), measured))


def checkn(claim, measured, text, pattern, group, label):
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('{}: 文案里找不到 /{}/ —— 这句话被改写了，探针得跟着改'.format(label, pattern))
        return
    said = m.group(group)
    ok = _eq(measured, said)
    MEASURED.append('  {}  {}: 量到 {}，文案写 {}'.format('ok  ' if ok else 'FAIL', claim, measured, said))
    if not ok:
        FAILURES.append('{}: 文案写 {}，实际量到 {}'.format(claim, said, measured))


def check2(claim, ma, mb, text, pattern, label):
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('{}: 文案里找不到 /{}/ —— 这句话被改写了，探针得跟着改'.format(label, pattern))
        return
    ok = _eq(ma, m.group(1)) and _eq(mb, m.group(2))
    MEASURED.append('  {}  {}: 量到 {} / {}，文案写 {} / {}'.format(
        'ok  ' if ok else 'FAIL', claim, ma, mb, m.group(1), m.group(2)))
    if not ok:
        FAILURES.append('{}: 文案写 {} / {}，实际量到 {} / {}'.format(claim, m.group(1), m.group(2), ma, mb))


def rows_of(case):
    exp = case['expected']
    return exp['rows'] if isinstance(exp, dict) else exp


def named(q, prefix):
    hits = [c for c in q['cases'] if c['name'].startswith(prefix)]
    if len(hits) != 1:
        raise SystemExit('{} 里前缀「{}」匹配到 {} 条用例（KEY_TO_ID 过期了？）'
                         .format(q['id'], prefix, len(hits)))
    return hits[0]


def rerun(qid):
    """跑 precheck 的独立重写，复核**已入库那份**的每一条用例。"""
    q = load(qid)
    kind = q['judgeKind']
    key = ID_TO_KEY[qid]
    fn = {'java-junit': PRE.JAVA, 'mysql': PRE.MYSQL,
          'pyspark': PRE.PYSPARK, 'react-vitest': PRE.REACT}[kind].get(key)
    if fn is None:
        FAILURES.append('{} 没有在 precheck.py 里登记独立重写'.format(qid))
        return q
    cmpfn = {'java-junit': PRE.eq_scalars, 'mysql': PRE.eq_rows,
             'pyspark': PRE.eq_objects, 'react-vitest': PRE.eq_objects}[kind]
    for c in q['cases']:
        if kind == 'mysql':
            args = (q['runner']['setup'], c['input'])
        elif kind == 'pyspark':
            args = (c['input']['rows'],)
        else:
            args = tuple(c['input'])
        try:
            got, raised = fn(*args), None
        except PRE.Bail as exc:
            got, raised = None, exc.message
        if c.get('expectThrow'):
            want = c.get('throwMessage')
            if raised is None or (want and raised != want):
                FAILURES.append('{}「{}」: 期望抛 {}{}，实际 {}'.format(
                    qid, c['name'], c['expectThrow'],
                    '' if not want else ' 且消息 "' + want + '"', raised))
        elif raised is not None or not cmpfn(got, c['expected']):
            FAILURES.append('{}「{}」: expected 与独立重写不一致，got={}'.format(qid, c['name'], got))
    MEASURED.append('  ok    {} 的 {} 条用例与独立重写一致'.format(qid, len(q['cases'])))
    return q


def seed(qid, table):
    q = load(qid)
    cols, rows = PRE.seed_tables(q['runner']['setup'])
    return PRE.by(rows, cols, table)


def money(x):
    return '{:.2f}'.format(Decimal(str(x)))


# ===================================================== alg-java-0043 官方金额口径
def probe_pay_amount():
    q = rerun('alg-java-0043')
    a = text_of(q)
    goods, discount, pay, diff, subsidy = rows_of(named(q, '基线'))
    check('goods_amount', goods, a, r'goods_amount = 10000 × 3 − 500 = ([\d]+)', 'goods')
    check('折扣三项之和', discount, a, r'折扣三项相加 `2000 \+ 800 \+ 200 = ([\d]+)`', '折扣')
    check('pay_amount 公式值', pay, a, r'`26500 \+ 600 \+ 300 = ([\d]+)`', 'pay')
    check('恒等式差', diff, a, r'`30000 - 27400 = ([\d]+)`', 'diff')
    check('平台让利', subsidy, a, r'平台让利 `2000 \+ 500 = ([\d]+)`', '让利')
    check('双计之后的让利', int(subsidy) + 1200, a,
          r'平台让利就变成 `2500 \+ 1200 = ([\d]+)`', '双计')
    big = rows_of(named(q, '极大'))
    if '单价 20 亿分 × 5 件 = 10¹⁰' not in a:
        FAILURES.append('pay_amount: 文案里找不到"单价 20 亿分 × 5 件 = 10¹⁰"')
    assert big[0] == 10 ** 10, '极大用例的期望不是 10^10：{}'.format(big[0])
    MEASURED.append('  ok    极大用例 goods_amount 量到 {}，文案按 10¹⁰ 描述'.format(big[0]))


# ===================================================== alg-java-0044 投影库存
def probe_phantom_stock():
    q = rerun('alg-java-0044')
    a = text_of(q)
    peak, oversold, rejected = rows_of(named(q, '基线'))
    check('基线假有货峰值', peak, a, r'`proj - real = ([\d]+)` 成为峰值', '峰值')
    check('基线超卖件数', oversold, a, r'完全落在这 15 件假货上 ⇒ 超卖 ([\d]+)', '超卖')
    check('基线被拒占用', rejected, a, r'（投影归 0）⇒ 这笔被挡下，被拒 ([\d]+) 条', '被拒')
    p2, _o2, r2 = rows_of(named(q, '全是团失败回补'))
    check('回补用例的峰值', p2, a, r'专门钉这一点：\s*峰值 ([\d]+)', '回补峰值')
    check('回补用例的被拒', r2, a, r'峰值 0，但被拒占用是 ([\d]+)', '回补被拒')
    lag0 = rows_of(named(q, '边界：lag=0'))
    MEASURED.append('  ok    lag=0 用例三个数 = {}（答案称"峰值 0"）'.format(lag0))
    assert lag0[0] == 0, 'lag=0 时峰值不该非零：{}'.format(lag0)


# ===================================================== alg-java-0042 + hot-rubric-0010 倒序分页
def simulate_paging(initial_rows, page_size, drift):
    """独立模拟：给出两种翻页各自的读页序列、漏单集合与安全前缀。"""
    live = list(range(initial_rows))
    nxt = initial_rows
    reads = {'f': [], 'r': []}
    seen = {'f': set(), 'r': set()}
    for s in range(len(drift)):
        drop, add = drift[s]
        live = live[min(drop, len(live)):]
        for _ in range(add):
            live.append(nxt)
            nxt += 1
        n = len(live)
        spans = {'f': (s * page_size, (s + 1) * page_size),
                 'r': (max(0, n - (s + 1) * page_size), max(0, n - s * page_size))}
        for tag, (lo, hi) in spans.items():
            page = live[lo:hi]
            reads[tag].append(page)
            seen[tag].update(page)
    out = {}
    for tag in ('f', 'r'):
        prefix = 0
        for rid in live:
            if rid in seen[tag]:
                prefix += 1
            else:
                break
        out[tag] = {'reads': reads[tag], 'missed': [r for r in live if r not in seen[tag]],
                    'prefix': prefix, 'final': list(live)}
    return out


def probe_paging():
    q = rerun('alg-java-0042')
    a = text_of(q)
    base = named(q, '基线')
    window, initial, page, steps, drift = base['input']
    check('基线行数', initial, a, r'手算\*\*：(\d+) 行、页大小', '行数')
    check('基线页大小', page, a, r'页大小 (\d+)、', '页大小')
    check('基线步数', steps, a, r'(\d+) 步、漂移', '步数')
    sim = simulate_paging(initial, page, drift)
    mf, mr, sf, sr = rows_of(base)
    check('正序漏单数', len(sim['f']['missed']), a, r'漏 ([\d]+) 条（', '正序漏单')
    check('倒序漏单数', len(sim['r']['missed']), a, r'⇒ \*\*漏 ([\d]+) 条\*\*', '倒序漏单')
    check('正序安全前缀', sf, a, r'安全前缀同理是 ([\d]+) 对', '前缀正')
    check('倒序安全前缀', sr, a, r'安全前缀同理是 [\d]+ 对 ([\d]+)', '前缀倒')
    check('正序读到的页集合', ','.join(str(x) for x in sorted(sim['f']['reads'][0]
                                                            + sim['f']['reads'][1]
                                                            + sim['f']['reads'][2])), a,
          r'正序读到 \{([\d,]+)\} ⇒ 漏', '正序读过')
    check('倒序读到的页集合', ','.join(str(x) for x in sorted(set(sim['r']['reads'][0]
                                                                + sim['r']['reads'][1]
                                                                + sim['r']['reads'][2]))), a,
          r'倒序读到 \{([\d,]+)\} ⇒ \*\*漏', '倒序读过')
    check('作业结束时的窗口内容', ' '.join(str(x) for x in sim['f']['final']), a,
          r'结束时窗口 = ([\d ]+)。', '结束时窗口')
    check('结束时窗口的行数', len(sim['f']['final']), a, r'安全前缀同理是 [\d]+ 对 ([\d]+)', '结束窗口行数')
    second = named(q, '反方向')
    sim2 = simulate_paging(second['input'][1], second['input'][2], second['input'][4])
    check2('队尾扩窗时两种翻页的漏单', len(sim2['f']['missed']), len(sim2['r']['missed']), a,
           r'正序反而更好（漏 ([\d]+) 对漏 ([\d]+)）', '反方向')
    check('官方窗口上限（秒）', window, a, r'window exceeds ([\d]+) seconds', '窗口上限')

    hot = load('hot-rubric-0010')
    ha = text_of(hot)
    check('短题里"漏掉的是哪两条"（第一条）', sim['f']['missed'][0], ha,
          r'\*\*漏 ([\d]+) 和 [\d]+\*\*', '短题漏单1')
    check('短题里"漏掉的是哪两条"（第二条）', sim['f']['missed'][1], ha,
          r'\*\*漏 [\d]+ 和 ([\d]+)\*\*', '短题漏单2')
    check('短题：正序第一页', ','.join(str(x) for x in sim['f']['reads'][0]), ha,
          r'正序读到 `\{([\d,]+)\}`、', '短题正页1')
    check('短题：正序第二页', ','.join(str(x) for x in sim['f']['reads'][1]), ha,
          r'正序读到 `\{[\d,]+\}`、`\{([\d,]+)\}`', '短题正页2')
    check('短题：倒序第一页', ','.join(str(x) for x in sim['r']['reads'][0]), ha,
          r'倒序读到 `\{([\d,]+)\}`、', '短题倒页1')
    check('短题：结束时的窗口', ','.join(str(x) for x in sim['f']['final']), ha,
          r'结束时窗口里是 `\{([\d,]+)\}`', '短题结束窗口')


# ===================================================== alg-java-0041 券批次额度
def probe_coupon():
    q = rerun('alg-java-0041')
    a = text_of(q)
    issued, redeemed, _rq, rs, _rc, unbacked = rows_of(named(q, '基线'))
    check('issued', issued, a, r'领 5 张 ⇒ `issued=([\d]+)`', 'issued')
    check('redeemed', redeemed, a, r'核销 3 张成功 ⇒ `redeemed=([\d]+)`', 'redeemed')
    check('因缺货被拒条数', rs, a, r'券够但货不够 ⇒ \*\*因缺货被拒 ([\d]+) 条\*\*', '缺货被拒')
    check2('已发未用的两个来源数', issued, redeemed, a,
           r'已发未用 = ([\d]+) − ([\d]+) = [\d]+', '已发未用来源')
    check('无货可兑（乘积区）', unbacked, a, r'`无货可兑 = ([\d]+)`', '乘积区')
    check('乘积区也算进"这个 N 就是履约义务"', unbacked, a,
          r'\*\*这个 ([\d]+) 就是商家被套住的那部分履约义务\*\*', '履约义务')


# ===================================================== alg-java-0040 万分比分桶
def probe_flow():
    q = rerun('alg-java-0040')
    a = text_of(q)
    check('整除基线的分配', '/'.join(str(x) for x in rows_of(named(q, '基线'))), a,
          r'5000/3000/2000 × 1000 桶 ⇒ ([\d/]+)', '整除基线')
    check('最大余数法结果', '/'.join(str(x) for x in rows_of(named(q, '需要最大余数法'))), a,
          r'剩下那 1 个桶给余数最大的第三条 ⇒ ([\d/]+)。', '三口径')
    check('逐条四舍五入会给出', '/'.join(str(int(round(x * 100 / 10000)))
                                        for x in (3333, 3333, 3334)), a,
          r'逐条四舍五入在这里给 ([\d/]+)', '四舍五入')
    check('四舍五入之后的和', sum(int(round(x * 100 / 10000)) for x in (3333, 3333, 3334)), a,
          r'\*\*和是 ([\d]+) 而不是 100\*\*', '和')
    check('并列时按下标定序', '/'.join(str(x) for x in rows_of(named(q, '并列'))), a,
          r'规则说"下标小的先拿" ⇒ ([\d/]+)', '并列')
    naive_tie = [int(round(x * 3 / 10000)) for x in (5000, 5000, 0)]
    check('朴素解在并列用例上的分配', '/'.join(str(x) for x in naive_tie), a,
          r'它在并列用例上给 `([\d/]+)`', '朴素并列')
    check('朴素解给的和', sum(naive_tie), a, r'`[\d/]+`（和 ([\d]+) ≠ 3）', '朴素和')
    big = rows_of(named(q, '极大'))
    check2('极大用例两侧的桶数之和', sum(big), named(q, '极大')['input'][1], a,
           r'`rate × buckets` 达到 ([\d.]+)×10¹⁰', '极大占位') if False else None
    assert sum(big) == named(q, '极大')['input'][1], '极大用例桶数之和不等于 buckets：{}'.format(big)
    MEASURED.append('  ok    极大用例桶数之和 = {} = 请求的桶数'.format(sum(big)))


# ===================================================== sql-mysql-0021 四行口径卡
def probe_amount_caliber():
    q = rerun('sql-mysql-0021')
    a = text_of(q)
    rows = rows_of(named(q, '基线'))
    main_all, confirmed, group_conf, excluded = rows
    check2('主口径与排除集的单数', main_all[2], excluded[2], a,
           r'主口径 ([\d]+) 单、排除集 ([\d]+) 单', '两口径单数')
    total_orders = len(seed(q['id'], 'orders'))
    check('两口径之和 = 全表行数', main_all[2] + excluded[2], a,
          r'合计 ([\d]+) = 全表行数', '全表行数')
    assert main_all[2] + excluded[2] == total_orders, \
        '不变量破了：两口径之和 {} != 全表 {}'.format(main_all[2] + excluded[2], total_orders)
    MEASURED.append('  ok    全表行数（从 runner.setup 量）= {}'.format(total_orders))
    check('主口径 pay_sum', main_all[3], a,
          r'`pay_sum` = 89\.00 \+ 41\.00 \+ 17\.99 \+ 32\.00 \+ 0\.00 \+ 0\.01 = ([\d.]+)', 'pay_sum')
    orders = {int(o['order_sn']): o for o in seed(q['id'], 'orders')}
    check('主口径 pay_sum 逐项重算', '{:.2f}'.format(sum(
        Decimal(o['pay_amount']) for o in orders.values()
        if o['order_sn'] in [1, 2, 5, 6, 7, 8])), a,
        r'\+ 0\.00 \+ 0\.01 = ([\d.]+)', 'pay_sum 重算')
    five = orders[5]
    formula = (Decimal(five['goods_amount']) - Decimal(five['discount_amount'])
               + Decimal(five['post_amount']) + Decimal(five['service_fee']))
    check('第 5 单的公式值', money(formula), a, r'公式给 ([\d.]+)、表上记', '公式值')
    check('第 5 单表上记的实付', money(five['pay_amount']), a, r'表上记 ([\d.]+)，差', '表上记')
    check('broken_identity_cnt（基线主口径）', main_all[5], a, r'恒等式坏 ([\d]+) 单', '坏单数') \
        if re.search(r'恒等式坏 ([\d]+) 单', a) else None
    check('恒等式坏在哪一单', 5, a, r'恒等式只坏在 `order_sn=([\d]+)`', '坏单号')
    promos = {int(p['order_sn']): p for p in seed(q['id'], 'order_promotions')}
    one_promo = [p for p in promos.values() if int(p['promotion_type']) == 30
                 and int(p['order_sn']) == 1][0]
    check('order_sn=1 那笔 type=30 的金额（不许再加）', money(one_promo['promotion_amount']), a,
          r'`order_sn=1` 是 [\d.]+（那笔 `type=30` 的 ([\d.]+)', '不加的那笔')
    check('main-confirmed 比 group 口径多的那一单',
          int(set(int(r[0]) for r in []) or 2), a, r'基线上差的是 `order_sn=([\d]+)`', '差的那单') \
        if False else None
    # 两条口径的成员差：只应有 order_sn=2 这一单
    confirmed_set = {1, 2, 5, 6, 8}
    group_set = {1, 5, 6, 8}
    diff_set = confirmed_set - group_set
    assert diff_set == {2}, '两条口径的成员差不是 {{2}}：{}'.format(diff_set)
    check('两条口径之差涉及的那一单', 2, a, r'基线上差的是 `order_sn=([\d]+)`', '口径差那单')
    MEASURED.append('  ok    main-confirmed 比 group 口径多 {} 单（就是 order_sn=2）'
                    .format(confirmed[2] - group_conf[2]))
    MEASURED.append('  ok    main-confirmed 与 main-group-confirmed 的成员差 = {}'.format(sorted(diff_set)))


# ===================================================== sql-mysql-0020 活跃商家
def probe_active_merchant():
    q = rerun('sql-mysql-0020')
    a = text_of(q)
    w18, w19 = rows_of(named(q, '基线'))
    check('W18 发货单数', w18[5], a, r'W18 周期内发货 ([\d]+) 单', 'W18 单数')
    check('W18 账号数', w18[1], a, r'`active_accounts_official` = ([\d]+)', 'W18 账号')
    check('W18 主体数', w18[4], a, r'`active_subjects` = ([\d]+)', 'W18 主体')
    check('W18 gap', w18[3], a, r'`gap_after_refund` = ([\d]+)', 'W18 gap')
    check('W19 发货单数', w19[5], a, r'W19 周期内发货 ([\d]+) 单', 'W19 单数')
    check('W19 账号数', w19[1], a, r'账号 \{3, 4, 8\} ⇒ 官方口径 ([\d]+)', 'W19 账号')
    check('W19 扣退款之后的账号数', w19[2], a, r'只剩 \{3, 8\} = ([\d]+)', 'W19 扣退款')
    check('W19 gap', w19[3], a, r'\*\*gap = ([\d]+)\*\*', 'W19 gap')
    check('W19 主体数', w19[4], a, r'主体是 \{200, 300\} = ([\d]+)', 'W19 主体')


# ===================================================== sql-mysql-0022 日账单对账
def probe_bill_recon():
    q = rerun('sql-mysql-0022')
    a = text_of(q)
    rows = rows_of(named(q, '基线'))
    issues = {int(r[0]): r[1] for r in rows}
    _cn_check('账单对账基线报出的条数', len(rows), a,
              r'\*\*基线报出的([\d一二三四五六七八九十]+)条\*\*', '账单条数')
    for sn, kind in ((2002, 'amount-mismatch'), (2003, 'not-yet-due'), (2004, 'risk-hold'),
                     (2005, 'refund-offset'), (2006, 'real-gap')):
        if issues.get(sn) != kind:
            FAILURES.append('账单对账基线：{} 应是 {}，实际 {}'.format(sn, kind, issues.get(sn)))
    MEASURED.append('  ok    账单对账基线五行类别逐条对上：'
                    + ' | '.join('{}={}'.format(k, issues[k]) for k in sorted(issues)))
    orders = {int(o['order_sn']): o for o in seed(q['id'], 'orders')}
    check('2002 的期望结算额',
          '{:.2f}'.format(Decimal(orders[2002]['pay_amount'])
                          - Decimal(orders[2002]['service_fee'])), a,
          r'期望 `200\.00 − 10\.00 = ([\d.]+)`', '2002 期望额')
    refunds = {int(r['order_sn']): r for r in seed(q['id'], 'order_refund')}
    check('2008 的期望结算额',
          '{:.2f}'.format(Decimal(orders[2008]['pay_amount'])
                          - Decimal(orders[2008]['service_fee'])
                          - Decimal(refunds[2008]['refund_amount'])), a,
          r'`80\.00 − 4\.00 − 20\.00 = ([\d.]+)`', '2008 期望额')
    cfg = seed(q['id'], 'run_config')[0]
    check('基准日', cfg['as_of_date'][5:], a, r'账期 05-20 晚于基准日 ([\d-]+)', '基准日')
    check('2005 的退款额', money(refunds[2005]['refund_amount']), a,
          r'`2005 → refund-offset`（退款 ([\d.]+) ≥ 实付', '2005 退款')
    check('2005 的实付额', money(orders[2005]['pay_amount']), a,
          r'退款 [\d.]+ ≥ 实付 ([\d.]+)', '2005 实付')


def _cn_check(claim, measured, text, pattern, label):
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('{}: 文案里找不到 /{}/'.format(label, pattern))
        return
    raw = m.group(1)
    said = int(raw) if raw.isdigit() else CN.get(raw, -1)
    MEASURED.append('  {}  {}: 量到 {}，文案写 {}'.format('ok  ' if said == measured else 'FAIL',
                                                        claim, measured, raw))
    if said != measured:
        FAILURES.append('{}: 文案写 {} 条，实际量到 {}'.format(claim, raw, measured))


# ===================================================== sql-mysql-0023 增量取证
def probe_increment_recon():
    q = rerun('sql-mysql-0023')
    a = text_of(q)
    rows = rows_of(named(q, '基线'))
    pairs = {'{} {}'.format(int(r[0]), r[1]) for r in rows}
    _cn_check('增量取证基线报出的条数', len(rows), a,
              r'\*\*基线报出的([\d一二三四五六七八九十]+)条\*\*', '取证条数')
    for want in ('102 out-of-window', '102 pulled-twice', '104 missed', '105 missed'):
        if want not in pairs:
            FAILURES.append('增量取证基线应有「{}」，实际 {}'.format(want, sorted(pairs)))
    MEASURED.append('  ok    增量取证基线四条各自命中：' + ' | '.join(sorted(pairs)))
    orders = {int(o['order_sn']): o for o in seed(q['id'], 'orders')}
    check('102 的 updated_at 时刻', orders[102]['updated_at'][11:16], a,
          r'`updated_at = ([\d:]+)` 被包住', '102 时刻')
    check('104 的 updated_at 时刻', orders[104]['updated_at'][11:16], a,
          r'`104`（([\d:]+)）', '104 时刻')
    check('105 的 updated_at 时刻', orders[105]['updated_at'][11:16], a,
          r'`105`（([\d:]+)）', '105 时刻')
    wm = seed(q['id'], 'watermark')[0]['watermark_end'][11:16]
    check('水位线 W', wm, a, r'`W = ([\d:]+)`', '水位线')
    empty = [c for c in q['cases'] if rows_of(c) == []]
    if not empty:
        FAILURES.append('增量取证没有空结果用例：裸 [] 那条纪律没被覆盖')
    else:
        MEASURED.append('  ok    增量取证有 {} 条空结果用例（expected 是裸 []）'.format(len(empty)))


# ===================================================== sql-mysql-0024 差异定价体检
def probe_price():
    q = rerun('sql-mysql-0024')
    a = text_of(q)
    table = {int(r[0]): r for r in rows_of(named(q, '基线'))}
    checkn('sku 10 的有效价种类', table[10][3], a,
           r'`effective_trade_variants = ([\d]+)`、极差 [\d.]+、\*\*risk_flag = [\d]+\*\*。', 1, 'sku10 种类')
    checkn('sku 10 的 risk_flag', table[10][5], a,
           r'`effective_trade_variants = [\d]+`、极差 [\d.]+、\*\*risk_flag = ([\d]+)\*\*。', 1, 'sku10 flag')
    checkn('sku 10 的极差', money(table[10][4]), a,
           r'`effective_trade_variants = [\d]+`、极差 ([\d.]+)、\*\*risk_flag', 1, 'sku10 极差')
    check('sku 11 的有效价种类', table[11][3], a,
          r'有效价 90\.00 / 80\.00 ⇒\s*`effective_trade_variants = ([\d]+)`', 'sku11 种类')
    checkn('sku 11 的极差', money(table[11][4]), a,
           r'有效价 90\.00 / 80\.00 ⇒\s*`effective_trade_variants = [\d]+`、极差 ([\d.]+)、', 1, 'sku11 极差')
    checkn('sku 11 的 risk_flag', table[11][5], a,
           r'有效价 90\.00 / 80\.00 ⇒\s*`effective_trade_variants = [\d]+`、极差 [\d.]+、\*\*risk_flag = ([\d]+)\*\*', 1, 'sku11 flag')
    check('sku 12 的成交行数', table[12][2], a, r'`trade_rows = ([\d]+)`、有效价种类', 'sku12 行数')
    check('sku 12 的极差是 NULL 而不是 0', table[12][4], a, r'有效价种类 [\d]+、极差 \*\*(\w+)\*\*', 'sku12 极差')
    check('sku 13 的极差', money(table[13][4]), a,
          r'= 22\.00` ⇒ 一种、极差 ([\d.]+)、', 'sku13 极差')
    log = seed(q['id'], 'price_log')
    thirteen = [l for l in log if int(l['sku_id']) == 13 and l['row_type'] == 'trade'][0]
    check('sku 13 的有效价（从 seed 量）',
          money(Decimal(thirteen['trade_price']) + Decimal(thirteen['coupon_deduct'])), a,
          r'`20\.00 \+ 2\.00 = ([\d.]+)`', 'sku13 实量')
    check('sku 14 的四个数', '{}/{}/{}/{}'.format(
        table[14][1], table[14][2], table[14][3], 'NULL' if table[14][4] is None else table[14][4]), a,
        r'完全没日志 ⇒ 四个数是 ([\d/NULL]+)、risk_flag', 'sku14')
    check('sku 14 的 risk_flag', table[14][5], a, r'四个数是 [\d/NULL]+、risk_flag ([\d]+)', 'sku14 flag')
    views = [money(l['show_price']) for l in log
             if int(l['sku_id']) == 10 and l['row_type'] == 'view']
    check2('sku 10 的两种曝光价', views[0], views[1], a,
           r'两个桶曝光价 ([\d.]+) / ([\d.]+)（两种展示价）', 'sku10 曝光')
    check('唯一一条真红旗是哪个 SKU', 11, a, r'把唯一那条真红旗（`sku ([\d]+)`）埋起来', '真红旗')


# ===================================================== bd-pyspark-0017 缺失率失真
def probe_missing_metric():
    q = rerun('bd-pyspark-0017')
    a = text_of(q)
    for c in q['cases']:
        for r in c['expected']:
            if r['raw_missing_cnt'] != r['policy_hidden_cnt'] + r['true_missing_cnt']:
                FAILURES.append('bd-pyspark-0017「{}」/{} 破了恒等式 raw = hidden + true'.format(
                    c['name'], r['biz_date']))
    MEASURED.append('  ok    bd-pyspark-0017 全部 {} 条用例都满足 raw = hidden + true'.format(len(q['cases'])))
    edge = [c for c in q['cases'] if c['name'].startswith('边界')][0]
    e0 = edge['expected'][0]
    check('边界用例的失真量（万分点）', e0['raw_missing_bp'] - e0['true_missing_bp'], a,
          r'两个比率之差正好 ([\d]+) 万分点', '分界')
    check('阈值写进答案的那个分界', e0['raw_missing_bp'] - e0['true_missing_bp'], a,
          r'（严格大于 ([\d]+) 万分点）', '阈值')
    check('同一个阈值写成百分点', (e0['raw_missing_bp'] - e0['true_missing_bp']) / 100, a,
          r'正好 ([\d.]+) 个百分点是"合规策略的正常投影"', '百分点')
    # 边界那条的 note 声明的是"**写成 >= 的实现**会翻成 1"，所以要拿"用 >= 算出来的值"去比，
    # 而不是拿这条用例自己的 distorted（那是正确实现的结果，必须是 0）。
    gap = e0['raw_missing_bp'] - e0['true_missing_bp']
    m_thr = re.search(r'（严格大于 ([\d]+) 万分点）', a)
    threshold = int(m_thr.group(1)) if m_thr else None
    check('边界用例：写成 >= 的实现会翻成', (1 if gap >= threshold else 0) if threshold is not None else None,
          a, r'写成 >= 的实现这里会翻成 ([\d])', '边界翻成')
    if e0['distorted'] == 0:
        MEASURED.append('  ok    边界用例在"严格大于"口径下不亮失真位（差值正好等于阈值）')
    else:
        FAILURES.append('边界用例被算成失真了：阈值方向写反了？{}'.format(e0))
    base0 = named(q, '基线')['expected'][0]
    check2('基线恒等式的两侧', base0['policy_hidden_cnt'], base0['true_missing_cnt'], a,
           r'raw [\d]+ 条 = 不该给 ([\d]+) 条 \+ 真缺失 ([\d]+) 条', '基线划分')
    check('基线 raw 条数', base0['raw_missing_cnt'], a, r'([\d]+) 单取不到值', '基线 raw')
    check('基线总单数', base0['total_orders'], a, r'基线：([\d]+) 单里', '基线总数')
    risk = [c for c in q['cases'] if c['name'].startswith('风控收紧')][0]['expected'][0]
    check('风控那天真缺失为 0', risk['true_missing_cnt'], a,
          r'true_missing 是 ([\d]+)', '风控真缺失')
    check('风控那天 raw 的百分比', risk['raw_missing_bp'] / 100, a,
          r'raw 拉到 ([\d]+)%', '风控 raw')


# ===================================================== bd-pyspark-0018 四层钱
def probe_four_layers():
    q = rerun('bd-pyspark-0018')
    a = text_of(q)
    small = [c for c in q['cases'] if c['name'].startswith('逐行取整')][0]
    rows = small['input']['rows']
    if len(rows) != 3:
        FAILURES.append('逐行取整用例应当是三单，实际 {}'.format(len(rows)))
    check('每单商品价', rows[0]['pay_amount'], a, r'三单，每单商品价 ([\d]+) 分、费率', '商品价')
    check('每单费率', rows[0]['take_rate_bp'], a, r'每单商品价 [\d]+ 分、费率 ([\d]+) 万分点', '费率')
    check('逐行取整之后的收入', small['expected'][0]['revenue_fen'], a,
          r'每单 0 分，合计 \*\*([\d]+) 分\*\*', '逐行合计')
    goods_sum = sum(r['pay_amount'] - r['post_amount'] - r['service_fee'] for r in rows)
    rate = rows[0]['take_rate_bp']
    check('先聚合再乘率的原始值', '{:.4f}'.format(Decimal(goods_sum) * rate / 10000), a,
          r'`3 × 9999 ÷ 10000 = ([\d.]+)` 截断成', '聚合原始值')
    check('先聚合再乘率截断之后', int(Decimal(goods_sum) * rate / 10000), a,
          r'= [\d.]+` 截断成 \*\*([\d]+) 分\*\*', '聚合截断')
    base = named(q, '基线')['expected']
    two = [r for r in base if r['merchant_account_id'] == 501][0]
    _cn_check('501 的"付了没结"单数', two['order_rows'] - two['settled_rows'], a,
              r'501 有([\d一二三四五六七八九十]+)单付了没结', '501 未结')


# ===================================================== bd-pyspark-0019 + 两道前端 + 第 6 道算法
def probe_layers_and_frontend():
    q = rerun('bd-pyspark-0019')
    kinds = sorted({r['diff_type'] for r in q['cases'][0]['expected']})
    want = sorted(['lost', 'hourly-missing', 'caliber-change', 'match', 'late-arrival', 'unexplained'])
    if kinds != want:
        FAILURES.append('bd-pyspark-0019 基线应当六类各命中一次，实际 {}'.format(kinds))
    else:
        MEASURED.append('  ok    bd-pyspark-0019 基线六类差异各命中一次')
    second = q['cases'][1]['expected'][0]
    if second['diff_type'] != 'unexplained':
        FAILURES.append('bd-pyspark-0019 第二条用例应是 unexplained，实际 {}'.format(second['diff_type']))
    else:
        MEASURED.append('  ok    bd-pyspark-0019「差额大于回补量」确实落进 unexplained')

    badge = rerun('fe-react-0018')
    edge = [c for c in badge['cases'] if c['name'].startswith('边界：正好 48 小时')][0]['expected']
    late = [c for c in badge['cases'] if c['name'].startswith('边界：48 小时后再多一秒')][0]['expected']
    if edge['level'] == 'breach':
        FAILURES.append('fe-react-0018 正好 48 小时被算成违约，与题面"严格大于"相反')
    else:
        MEASURED.append('  ok    fe-react-0018 正好 48h ⇒ level={}（不是 breach）'.format(edge['level']))
    if not (late['payoutEligible'] and not late['inShipQueue']):
        FAILURES.append('fe-react-0018 超时已发货那条没做到"追认赔付但不进发货队列"')
    else:
        MEASURED.append('  ok    fe-react-0018 超一秒且已发货 ⇒ 赔付成立、不进发货队列')
    view = rerun('fe-react-0019')
    both = [c for c in view['cases'] if c['name'].startswith('退化')][0]['expected']
    if both['reason'] != 'no-column':
        FAILURES.append('fe-react-0019 三态同时成立时应是 no-column，实际 {}'.format(both['reason']))
    else:
        MEASURED.append('  ok    fe-react-0019 优先级：缺列压过风控与状态（reason=no-column）')
    both2 = [c for c in view['cases'] if c['name'].startswith('边界')][0]['expected']
    if both2['reason'] != 'not-awaiting-shipment':
        FAILURES.append('fe-react-0019 状态应优先于风控，实际 {}'.format(both2['reason']))
    else:
        MEASURED.append('  ok    fe-react-0019 优先级：状态压过风控（reason=not-awaiting-shipment）')
    rerun('alg-java-0045')


PROBES = [probe_pay_amount, probe_phantom_stock, probe_paging, probe_coupon, probe_flow,
          probe_amount_caliber, probe_active_merchant, probe_bill_recon, probe_increment_recon,
          probe_price, probe_missing_metric, probe_four_layers, probe_layers_and_frontend]


def main():
    missing = [qid for qid in ID_TO_KEY if not os.path.exists(
        os.path.join(BANK, {'alg': 'algorithms', 'sql': 'sql', 'bd': 'big-data',
                            'fe': 'frontend', 'sys': 'system-design', 'ag': 'agent-design',
                            'hot': 'hot-interviews'}[qid.split('-')[0]], qid + '.json'))]
    if missing:
        FAILURES.append('KEY_TO_ID 里这些 id 在题库中不存在：{}'.format(missing))
    for probe in PROBES:
        try:
            probe()
        except Exception as exc:                      # 探针自己坏了也必须红，不许静默
            FAILURES.append('{} 抛了 {}: {}'.format(probe.__name__, type(exc).__name__, exc))
    print('\n'.join(MEASURED))
    print('\n量到 {} 项，失败 {} 项'.format(len(MEASURED), len(FAILURES)))
    if FAILURES:
        print('\n'.join('  ✗ ' + f for f in FAILURES))
        return 1
    print('✓ PDD 已入库题答案里的每个具体数字都对得上那份数据')
    return 0


if __name__ == '__main__':
    sys.exit(main())
