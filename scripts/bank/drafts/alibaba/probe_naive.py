#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里巴巴已入库题的"答案里的数字必须有来源"探针（与 apple / airbnb / deepseek / pdd 同一套纪律）。

判据方向：**数字是用正则从 `content/questions/` 那份答案 / 用例名 / 用例备注里抠出来的，
再和从同一份文件的数据（`runner.setup` 种子、`case.input` 变更、`case.expected`）量到的值比** ——
不在探针里重写一遍常量，也不重新实现判分模型。
探针里写死"基线五行"只能证明"我以为它是五行"；答案被人改成"基线六行"它照样绿。
这条方向是 WI-65 的破坏性验证打回来的。

与另外两道闸门的分工：
  * `gen.py --check`   ＝ 生成器模型与题库逐字段一致（防"改了题没改模型"）
  * `precheck.py`      ＝ 题能做对（另一份**不同算法**的实现与 expected 一致）
  * 本文件             ＝ 说明没瞎写（文案点名的具体数字对得上已入库的那份数据）
容器判题矩阵证明的是"参考解真能过、朴素解真会挂"，它不看文案 —— 文案一直是它的盲区，
本批 mysql-0031/0032 的三处"用例名与 expected 互相矛盾"就是靠这个探针方向抓出来的。

覆盖范围（**没测的不假装测过**）：
  ✓ 7 道 java-junit + 3 道 pyspark/spark-scala：复用 `precheck.py` 的独立重写，逐用例复核**已入库那份**
  ✓ sql-mysql-0030 / 0031 / 0032：答案点名的行数、逐 qid/SKU 的取值、"某行不许出"
  ✓ sql-mysql-0032：SKU 账面表（Σdeduct/Σrelease/净扣减/kucun0/kucun）从种子 INSERT 量出来
  ✓ sql-redis-0013 / 0014：跨边界初值、并账后的成员数、预热权重的那条乘除式
  ✓ sql-mysql-0033（派生指标口径门禁）：答案逐格写出的 `day|week/口径 = … = N`、
    definition-count/duplicate-registration 的整串键值（**按段落定位到是哪一条用例**）、
    用例名承诺的"全表 13 行 / 九个派生指标都是 0 / 报 3 / 多出三行 / 三个周口径各多 4450"
  ✓ sql-mysql-0034（分库分表体检）：答案十列 `metric=值` 逐个回判 expected、种子的每片行数、
    跨片重复主键集合、missing/orphan 的主键号、朴素口径 3 与正确口径 1、删片前后两个分页列
  ✓ sql-mysql-0035（堆积与追赶）：答案那张 12 列 × 3 行的表逐格量、"3000 − 2600 = 400"
    与朴素口径"600 + 400 = 1000"从种子量、堆积/窗口/reset/consumed 的前后两个数
  ✓ bd-pyspark-0024（MaxCompute 账单）：答案写出的两团队 7 个列值、混合单价那条式子
    （三个乘数都从 input 行里量）、补数/坏台账/全部失败三种前后对照
  ✓ bd-scala-0002（Hologres TTL 两把时钟）：基线 9 列 × 3 行表、ttl_days 的除法、
    now_ds − ds 的差、ghost/rev/kept 的用例承诺
  ✓ alg-java-0058（Sentinel 熔断状态机）：答案"用例「X」…给出 [8 个数]"的 6 处整串回判 expected
    ＋基线那句"第 5 条才越线"要真的没提前跨过门槛
  ✓ fe-react-0022 / 0023（前端两题）：告警条数、"singular 不许被改"、两档互斥时只抛 strict
    且 scopedCss/containerAttr 为假、"抛错同时也有容器标识"这一格是否真存在、实例 id 的 off-by-one、
    @font-face 与兄弟选择器的改写方向；轮询"完成后再等"的两个观测时刻、
    `pollingErrorRetryCount` 的 `<=`（给 2 跑 3 次）与默认 -1、竞态里过期响应不许写 data/error/回调
  ✗ redis 的最终状态机本身（ZUNIONSTORE/expire 的语义）：本机没有 Redis，
    只能由容器判题矩阵覆盖（precheck 对这两份同样打 SKIP）
  ✗ 主观题（system-design / agent-design / hot-interviews）：入库时引用的是官方披露值，
    由知识文件的来源清单负责，不由本探针负责

用法：python scripts/bank/drafts/alibaba/probe_naive.py
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

_spec = importlib.util.spec_from_file_location('ab_precheck', os.path.join(HERE, 'precheck.py'))
PRE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PRE)

# 草稿 key -> 入库 id。它坏了会立刻显形：按用例名取用例取不到就 SystemExit。
KEY_TO_ID = {
    'alg-ab-consume-retry': 'alg-java-0052',
    'alg-ab-fifo-queue-placement': 'alg-java-0053',
    'alg-ab-seata-at-isolation': 'alg-java-0054',
    'alg-ab-system-adaptive-admission': 'alg-java-0055',
    'alg-ab-tcc-lifecycle': 'alg-java-0056',
    'alg-ab-timer-horizon': 'alg-java-0057',
    'alg-ab-circuitbreaker-state': 'alg-java-0058',
    'bd-ab-paimon-partial-update': 'bd-pyspark-0023',
    'bd-ab-maxcompute-bill': 'bd-pyspark-0024',
    'bd-ab-hologres-ttl-two-clocks': 'bd-scala-0002',
}

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
    """答案 + 题面 + 用例名 + 用例备注：都是"写给人的话"，都算答案文本。"""
    parts = [q.get('answer') or '', q.get('statement') or '']
    for c in q.get('cases') or []:
        parts.append(c['name'])
        parts.append(c.get('note') or '')
    return '\n'.join(parts)


def named(q, prefix, label):
    for c in q['cases']:
        if c['name'].startswith(prefix) or prefix in c['name']:
            return c
    raise SystemExit('%s: 找不到用例「%s」—— 用例名改了，探针得跟着改' % (label, prefix))


CN = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}


def _num(token):
    """文案里的数可能是阿拉伯数字，也可能是"五行/四个"；负号可能是 ASCII 的也可能是 −。"""
    token = token.strip().replace('−', '-').replace('–', '-')
    if token in CN:
        return CN[token]
    return token


def _eq(measured, said):
    if isinstance(measured, bool):
        return ('true' if measured else 'false') == said.strip().lower()
    if measured is None:
        return said.strip().upper() in ('NULL', 'NONE', 'NIL')
    try:
        return abs(float(Decimal(str(measured))) - float(Decimal(_num(said)))) < 1e-9
    except Exception:
        return str(measured).strip() == _num(said)


def check(claim, measured, text, pattern, label, group=1):
    """量到的值与文案里写的那个数对不上就算 FAIL；正则抠不到也算 FAIL（脱钩不许看起来像通过）。"""
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('%s: 文案里找不到 /%s/ —— 这句话被改写了，探针得跟着改' % (label, pattern))
        return
    said = m.group(group)
    ok = _eq(measured, said)
    MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', claim, measured, said))
    if not ok:
        FAILURES.append('%s: 文案写 %s，实际量到 %s' % (claim, said, measured))


# ============================================================ 通用：从题面数据里量数
def rows_of(q, case_idx=0):
    """mysql 题的 expected → [dict]（列名来自 expected.columns）。"""
    exp = q['cases'][case_idx]['expected']
    cols = exp['columns']
    return [dict(zip(cols, r)) for r in exp['rows']]


VALUE_TUPLE_RE = re.compile(r"\(([^()]*)\)")


def split_values(inner):
    """拆一条 `INSERT ... VALUES` 的元组：只处理本批用得到的 数字 / 单引号串 / NULL。"""
    out, buf, quote = [], '', False
    for ch in inner:
        if ch == "'":
            quote = not quote
            buf += ch
        elif ch == ',' and not quote:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return [_lit(x) for x in out]


def _lit(token):
    if token.upper() == 'NULL':
        return None
    if token.startswith("'") and token.endswith("'"):
        return token[1:-1]
    try:
        return int(token)
    except ValueError:
        pass
    try:
        return float(token)
    except ValueError:
        return token


def _split_top(text):
    """按逗号切，但括号内的逗号不算分隔（`DECIMAL(10,2)` 会被切成两半的那种）。"""
    out, buf, depth = [], '', 0
    for ch in text:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def seed_tables(q):
    """`runner.setup` 里的 CREATE + INSERT → {表名: {'cols': [...], 'rows': [dict]}}。"""
    tables = {}
    for stmt in (q.get('runner') or {}).get('setup') or []:
        s = ' '.join(str(stmt).split())          # 建表语句是单行的，但空格数不一定
        cm = re.match(r'CREATE TABLE (\w+) \((.*)\)(?: ENGINE.*)?$', s)
        if cm:
            cols = []
            for part in _split_top(cm.group(2)):
                fm = re.match(r'(\w+)\s+(?:INT|BIGINT|SMALLINT|TINYINT|DECIMAL|VARCHAR|CHAR|TEXT|DATE'
                              r'|DATETIME|TIMESTAMP|JSON|DOUBLE|FLOAT)\b', part, re.I)
                if fm:
                    cols.append(fm.group(1))
            tables[cm.group(1)] = {'cols': cols, 'rows': []}
            continue
        im = re.match(r'INSERT INTO (\w+) VALUES (.*)$', s)
        if im and im.group(1) in tables:
            cols = tables[im.group(1)]['cols']
            for tup in VALUE_TUPLE_RE.finditer(im.group(2)):
                pieces = split_values(tup.group(1))
                if len(pieces) == len(cols):
                    tables[im.group(1)]['rows'].append(dict(zip(cols, pieces)))
    return tables


# ==================================================== sql-mysql-0031 Hologres 访问路径
def probe_hologres():
    q = load('sql-mysql-0031')
    ans = q['answer']
    base = rows_of(q, 0)
    label = 'sql-mysql-0031'

    check('基线行数', len(base), ans, r'\*\*基线 (\d+) 行的 `access_path`\*\*', label)

    # 答案逐个 qid 点名了 access_path —— 全部对上 expected 才算这句话有来源
    for m in re.finditer(r'qid(\d+) `([a-z0-9-]+)`', ans):
        qid = int(m.group(1))
        hit = [r for r in base if r['qid'] == qid]
        if not hit:
            FAILURES.append('%s: 文案点名 qid%d 但基线里没有这一行' % (label, qid))
            continue
        MEASURED.append('  %s  qid%d 路径: 量到 %s，文案写 %s' % (
            'ok  ' if hit[0]['access_path'] == m.group(2) else 'FAIL',
            qid, hit[0]['access_path'], m.group(2)))
        if hit[0]['access_path'] != m.group(2):
            FAILURES.append('%s: qid%d 文案写 %s，expected 是 %s' % (
                label, qid, m.group(2), hit[0]['access_path']))
    cited = len(re.findall(r'qid(\d+) `([a-z0-9-]+)`', ans))
    if cited < 10:
        FAILURES.append('%s: 只抠到 %d 条 qid 路径声明（基线 12 行，抠太少等于没测）' % (label, cited))

    # 风险列：答案说"按表只有五种取值"，量一下 expected 里 config_risk 的去重数
    distinct = sorted({r['config_risk'] for r in base})
    check('config_risk 取值种数', len(distinct), ans, r'`config_risk` 基线按表只有([四五六十\d]+)种取值', label)
    if len(distinct) != 5:
        FAILURES.append('%s: config_risk 实际有 %d 种：%s' % (label, len(distinct), distinct))

    # 那张"一次改了三条路径"的用例：文案点名的 旧⇒新 必须逐条成立
    seg_case = named(q, '边界：把 ord 的分段键改成与聚簇键同列', label)
    after = {r['qid']: r for r in rows_of(q, q['cases'].index(seg_case))}
    before = {r['qid']: r for r in base}
    moves = 0
    for m in re.finditer(r'qid(\d+) 从 `([a-z0-9-]+)`\s*(?:掉到|升到|变成)\s*`([a-z0-9-]+)`', ans):
        qid = int(m.group(1))
        moves += 1
        MEASURED.append('  %s  qid%d 掉到 %s: 量到 %s' % (
            'ok  ' if after.get(qid, {}).get('access_path') == m.group(3) else 'FAIL',
            qid, m.group(3), after.get(qid, {}).get('access_path')))
        if after.get(qid, {}).get('access_path') != m.group(3):
            FAILURES.append('%s: qid%d 在该用例里是 %s，文案说掉到 %s' % (
                label, qid, after.get(qid, {}).get('access_path'), m.group(3)))
        if before.get(qid, {}).get('access_path') != m.group(2):
            FAILURES.append('%s: qid%d 基线是 %s，文案说"从 %s 掉"——起点就写错了' % (
                label, qid, before.get(qid, {}).get('access_path'), m.group(2)))
    if moves < 3:
        FAILURES.append('%s: 只抠到 %d 条"qid 从 X 变成 Y"声明（该用例改了四条路径中的三条）' % (label, moves))
    # 风险列"仍然不变"这句话：量一下它到底变没变
    flipped = sorted(qid for qid in after
                     if qid in before and after[qid]['config_risk'] != before[qid]['config_risk'])
    if flipped:
        FAILURES.append('%s: 该用例里 config_risk 变了（qid%s），但文案说"不改风险列"' % (label, flipped))
    else:
        MEASURED.append('  ok    该用例 %d 行的 config_risk 全部停在原值' % len(after))

    # no-pk-scan 只有那一个用例可达：基线里不许有，用例里必须有
    if any(r['access_path'] == 'no-pk-scan' for r in base):
        FAILURES.append('%s: 基线里出现了 no-pk-scan，文案"只有最后一个用例能测到"就不成立' % label)
    nopk_case = named(q, '边界：无主键的列存表做点查', label)
    nopk_rows = rows_of(q, q['cases'].index(nopk_case))
    if not any(r['access_path'] == 'no-pk-scan' for r in nopk_rows):
        FAILURES.append('%s: 用例「无主键的列存表做点查」的 expected 里没有 no-pk-scan'
                        ' —— 用例名与判分数据互相矛盾（这就是第 1 条规则不可达的形态）' % label)
    if any(r['access_path'] == 'no-pk-scan' and r['shard_pruned'] != 1 for r in nopk_rows):
        FAILURES.append('%s: no-pk-scan 那一行的 shard_pruned 不是 1，文案"仍可为 1"落空' % label)

    # 朴素解"恒 none"的说法：基线里 config_risk 不许全是 none
    if all(r['config_risk'] == 'none' for r in base):
        FAILURES.append('%s: 基线 config_risk 全是 none —— 判"恒 none"的朴素解根本挂不了' % label)


# ==================================================== sql-mysql-0032 库存扣减审计
def probe_inventory():
    q = load('sql-mysql-0032')
    ans = q['answer']
    label = 'sql-mysql-0032'
    tables = seed_tables(q)
    for tbl in ('stock', 'order_txn', 'deduct_log', 'release_log'):
        if tbl not in tables or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了，探针得跟着改' % (label, tbl))

    deduct, release = tables['deduct_log']['rows'], tables['release_log']['rows']
    net = {}
    for r in deduct:
        net[r['sku_id']] = net.get(r['sku_id'], 0) + r['qty']
    for r in release:
        net[r['sku_id']] = net.get(r['sku_id'], 0) - r['qty']

    # 答案里那张 SKU 表逐行量：| SKU | Σdeduct | Σrelease | 净扣减 | kucun0 | kucun | 结论 |
    stock = {r['sku_id']: r for r in tables['stock']['rows']}
    ROW = re.compile(r'\| (20\d\d) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| ([−-]?\d+) \| (.+?) \|')
    checked = 0
    for m in ROW.finditer(ans):
        sku = int(m.group(1))
        said = [int(_num(m.group(i))) for i in range(2, 7)]
        sum_d = sum(r['qty'] for r in deduct if r['sku_id'] == sku)
        sum_r = sum(r['qty'] for r in release if r['sku_id'] == sku)
        k0, k1 = stock[sku]['kucun0'], stock[sku]['kucun']
        net = sum_d - sum_r
        got = [sum_d, sum_r, net, k0, k1]
        checked += 1
        ok = got == said
        MEASURED.append('  %s  SKU %d 账面: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', sku, got, said))
        if not ok:
            FAILURES.append('%s: SKU %d 的账面表写 %s，种子里量到 %s' % (label, sku, said, got))
        concl = m.group(7)
        om = re.search(r'over-sold \*\*([−-]?\d+)\*\*', concl)
        if om:
            over = max(0, net - k0)
            MEASURED.append('  %s  SKU %d 超卖件数: 量到 %s，文案写 %s' % (
                'ok  ' if over == int(_num(om.group(1))) else 'FAIL', sku, over, om.group(1)))
            if over != int(_num(om.group(1))):
                FAILURES.append('%s: SKU %d 超卖文案写 %s，量到 %s' % (label, sku, om.group(1), over))
        lm = re.search(r'ledger-mismatch \*\*([−-]?\d+)\*\*', concl)
        if lm:
            diff = k0 - net - k1
            MEASURED.append('  %s  SKU %d 台账差额: 量到 %s，文案写 %s' % (
                'ok  ' if diff == int(_num(lm.group(1))) else 'FAIL', sku, diff, lm.group(1)))
            if diff != int(_num(lm.group(1))):
                FAILURES.append('%s: SKU %d 台账差额文案写 %s，量到 %s' % (label, sku, lm.group(1), diff))
    if checked != len(stock):
        FAILURES.append('%s: SKU 账面表抠到 %d 行，种子里有 %d 个 SKU —— 表格格式变了' % (
            label, checked, len(stock)))

    check('基线行数', len(rows_of(q, 0)), ans, r'\*\*基线([四五六十\d]+)行\*\*', label)
    base = rows_of(q, 0)
    if not all(r['anomaly'] != 'cancelled-without-release' for r in base):
        FAILURES.append('%s: 基线里出现了 cancelled-without-release，文案说它"基线里也是空的"' % label)
    if not all(r['anomaly'] != 'double-release' for r in base):
        FAILURES.append('%s: 基线里出现了 double-release，文案说它是空判据' % label)

    # "四个 SKU 全部台账不平" —— 清空扣减/释放之后量 ledger-mismatch 的行数
    clear_case = named(q, '退化：扣减与释放全部清空', label)
    cleared = rows_of(q, q['cases'].index(clear_case))
    n_ledger = len([r for r in cleared if r['anomaly'] == 'ledger-mismatch'])
    n_paid = len([r for r in cleared if r['anomaly'] == 'paid-without-deduct'])
    check('清空后台账不平的 SKU 数', n_ledger, clear_case['name'], r'([四三五一二六\d]+) ?个 SKU 全部台账不平', label)
    check('清空后"已付款没扣减"行数', n_paid, clear_case['name'], r'多出([四三五一二六\d]+)行"已付款没扣减"', label)
    n_cancel = len([r for r in cleared if r['anomaly'] == 'cancelled-without-release'])
    check('清空后"已取消没释放"行数', n_cancel, clear_case['name'], r'([一二三四\d]+) ?行"已取消没释放"', label)
    if 'cancelled-without-release' not in {r['anomaly'] for r in cleared}:
        FAILURES.append('%s: 清空后没有出现 cancelled-without-release，文案"要等这个用例才浮出来"不成立' % label)

    # 「净扣减恰好等于初始库存」：2003 一行都不出（判据用 >）
    zero_case = named(q, '边界：净扣减恰好等于初始库存', label)
    zero = rows_of(q, q['cases'].index(zero_case))
    if any(r['sku_id'] == 2003 for r in zero):
        FAILURES.append('%s: 「净扣减恰好等于初始库存」里 2003 还出了行，文案说"一行都不出"' % label)
    MEASURED.append('  ok    卖光不报超卖（2003 在该用例 %d 行为空）' % len([r for r in zero if r['sku_id'] == 2003]))


# ==================================================== sql-mysql-0030 事务消息对账
def probe_halfmsg():
    q = load('sql-mysql-0030')
    ans = q['answer']
    label = 'sql-mysql-0030'
    base = rows_of(q, 0)
    check('基线行数', len(base), ans, r'\*\*基线只有([四五六十\d]+)行\*\*', label)
    by_order = {int(r['order_id']): r for r in base}
    # 文案写成 `half_state / finding / action` 三段，逐段对 expected
    cited = 0
    for m in re.finditer(r'(10\d\d) → `([A-Z_]+)\s*/\s*([a-z-]+)\s*/\s*([a-z-]+)`', ans):
        oid = int(m.group(1))
        cited += 1
        said = (m.group(2), m.group(3), m.group(4))
        row = by_order.get(oid)
        if row is None:
            FAILURES.append('%s: 文案说 %d → %s，基线里根本没有这一单' % (label, oid, said))
            continue
        got = (row['half_state'], row['finding'], row['action'])
        ok = got == said
        MEASURED.append('  %s  订单 %d: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', oid, got, said))
        if not ok:
            FAILURES.append('%s: 订单 %d 文案写 %s，expected 是 %s' % (label, oid, said, got))
    if cited < len(base):
        FAILURES.append('%s: 只抠到 %d 条"订单 → 三段"声明，基线有 %d 行 —— '
                        '要么文案没逐行点名，要么写法变了（抠太少等于没测）' % (label, cited, len(base)))
    if 1004 in by_order:
        FAILURES.append('%s: 1004 出了行，文案说"一行都不出"' % label)
    MEASURED.append('  ok    1004 确实不在基线结果里（%d 行里没有它）' % len(base))
    # "回查计数原样带出"：用例名点了这条，就得有非零的 checked_times 可看
    times = {int(r['order_id']): r['checked_times'] for r in base}
    if not any(v > 0 for v in times.values()):
        FAILURES.append('%s: 基线里 checked_times 全是 0 —— "回查计数原样带出"这条没有判据' % label)
    MEASURED.append('  ok    有非零回查次数的订单：%s' % {k: v for k, v in times.items() if v})


# ==================================================== 两道 redis 题：量"跨边界初值"与权重算式
def zadd_members(q, key_prefix=None):
    """从 setup 抠 `ZADD key score member`，返回 {key: {member: score}}。"""
    out = {}
    for stmt in (q.get('runner') or {}).get('setup') or []:
        m = re.match(r'ZADD (\S+) (-?\d+) (\S+)$', str(stmt).strip())
        if not m:
            continue
        if key_prefix and not m.group(1).startswith(key_prefix):
            continue
        out.setdefault(m.group(1), {})[m.group(3)] = int(m.group(2))
    return out


def hget(q, key, field):
    for stmt in (q.get('runner') or {}).get('setup') or []:
        m = re.match(r'HSET (\S+) (.+)$', str(stmt).strip())
        if m and m.group(1) == key:
            parts = m.group(2).split()
            for i in range(0, len(parts) - 1, 2):
                if parts[i] == field:
                    return int(parts[i + 1])
    raise SystemExit('setup 里找不到 HSET %s %s' % (key, field))


def run_redis_script(setup, commands, cutoff=None, extra_before=None):
    """迷你 Redis：**按顺序**执行，只支持这两道题用得到的那几条命令。

    为什么必须按顺序：`ZREMRANGEBYSCORE` 在 `ZADD` 之前跑，所以"清理边界"只作用在
    当时的全局窗口上；把它并到并账之后一起算会量出第三个数（这是本探针第一版踩的坑）。
    ZUNIONSTORE 在 Redis 里默认按 SUM 聚合，这里成员互不重叠 ⇒ 取任一即可。
    """
    zsets, strs, hashes = {}, {}, {}
    lines = [' '.join(str(s).split()) for s in setup] + list(commands)
    for line in lines:
        t = ' '.join(str(line).split())
        if extra_before and t.startswith(extra_before[0]):
            for ex in extra_before[1]:
                zsets.setdefault(ex[0], {})[ex[2]] = ex[1]
        m = re.match(r'ZADD (\S+) (-?\d+) (\S+)$', t)
        if m:
            zsets.setdefault(m.group(1), {})[m.group(3)] = int(m.group(2))
            continue
        m = re.match(r'ZREMRANGEBYSCORE (\S+) -inf (-?\d+)$', t)
        if m:
            bound = int(m.group(2)) if cutoff is None else cutoff
            key = m.group(1)
            zsets[key] = {mem: sc for mem, sc in zsets.get(key, {}).items() if sc > bound}
            continue
        m = re.match(r'ZUNIONSTORE (\S+) (\d+) (.+)$', t)
        if m:
            dest, n = m.group(1), int(m.group(2))
            srcs = m.group(3).split()[:n]
            merged = {}
            for src in srcs:
                for mem, sc in zsets.get(src, {}).items():
                    merged[mem] = merged.get(mem, 0) + sc
            zsets[dest] = merged
            continue
        m = re.match(r'HINCRBY (\S+) (\S+) (-?\d+)$', t)
        if m:
            hh = hashes.setdefault(m.group(1), {})
            hh[m.group(2)] = str(int(hh.get(m.group(2), '0')) + int(m.group(3)))
            continue
        m = re.match(r'SET (\S+) (\S+)$', t)
        if m:
            strs[m.group(1)] = m.group(2)
            continue
        m = re.match(r'HSET (\S+) (.+)$', t)
        if m:
            parts = m.group(2).split()
            hh = hashes.setdefault(m.group(1), {})
            for i in range(0, len(parts) - 1, 2):
                hh[parts[i]] = parts[i + 1]
            continue
        m = re.match(r'DEL (\S+)$', t)
        if m:
            for bag in (zsets, strs, hashes):
                bag.pop(m.group(1), None)
            continue
        raise SystemExit('迷你 Redis 不认参考解里的这条命令：%s' % t)
    return zsets, strs, hashes


def answer_commands(ans, label):
    block = re.search(r'```\n(.*?)\n```', ans, re.S)
    if not block:
        raise SystemExit('%s: 答案里没有围栏块，抠不出命令序列' % label)
    return [ln for ln in (l.strip() for l in block.group(1).split('\n')) if ln]


def probe_redis_cluster():
    q = load('sql-redis-0013')
    ans = q['answer']
    label = 'sql-redis-0013'
    setup = (q.get('runner') or {}).get('setup') or []
    cmds = answer_commands(ans, label)
    scores = sorted(zadd_members(q, 'rl:order:global').get('rl:order:global', {}).values())
    cited = [int(x) for x in re.search(r'初值刻意做成 (\d+) / (\d+) / (\d+)', ans).groups()]
    MEASURED.append('  %s  全局窗口初值: 量到 %s，文案写 %s' % (
        'ok  ' if cited == scores else 'FAIL', scores, cited))
    if cited != scores:
        FAILURES.append('%s: 文案写初值 %s，setup 里是 %s' % (label, cited, scores))
    cutoff = int(re.search(r'清理边界是 (\d+)', ans).group(1))
    below = [s for s in scores if s <= cutoff]
    above = [s for s in scores if s > cutoff]
    if not (below and above):
        FAILURES.append('%s: 边界 %d 两侧不是"跨"的（下 %s / 上 %s）—— 这个错法不可判' % (
            label, cutoff, below, above))

    zsets, _, _ = run_redis_script(setup, cmds)
    zcard = len(zsets.get('rl:order:global', {}))
    check('并账后 ZCARD', zcard, ans, r'ZCARD`? 从 (\d+) 变', label)
    case_exp = int(named(q, '退化期间的放行必须并回总账', label)['expected'])
    if zcard != case_exp:
        FAILURES.append('%s: 迷你 Redis 量到 %d，判题用例的 expected 是 %d —— 探针与判题器各说各话' % (
            label, zcard, case_exp))
    else:
        MEASURED.append('  ok    迷你 Redis 与用例 expected 给出同一个数：%d' % zcard)

    # "写成 -inf 10000" 的错法：同一个序列换个边界，应当量出文案说的第二个数
    wrong = int(re.search(r'写成 `-inf (\d+)`', ans).group(1))
    z2, _, _ = run_redis_script(setup, cmds, cutoff=wrong)
    check('错法（边界 %d）的 ZCARD' % wrong, len(z2.get('rl:order:global', {})),
          ans, r'ZCARD`? 从 \d+ 变 (\d+)', label)

    # 朴素解把被拒的请求也落账 ⇒ 并进来多一条；那句 ZADD 写在"朴素解"那段里，从那一段抠
    # （整篇答案里正则抠 ZADD 会先命中围栏块里的正常放行命令，量成第三个数）
    seg = ans[ans.find('朴素解'):] if '朴素解' in ans else ''
    naive = re.search(r'ZADD (rl:order:\S+) (\d+) (\S+)', seg)
    if not naive:
        FAILURES.append('%s: 抠不到朴素解那条 ZADD' % label)
    else:
        extra = ((naive.group(1), int(naive.group(2)), naive.group(3)),)
        z3, _, _ = run_redis_script(setup, cmds, extra_before=('ZUNIONSTORE', extra))
        n3 = len(z3.get('rl:order:global', {}))
        check('朴素解（被拒也落账）的 ZCARD', n3, ans, r'`ZCARD` 变 (\d+)。', label)


def probe_redis_mse():
    q = load('sql-redis-0014')
    ans = q['answer']
    label = 'sql-redis-0014'
    full = hget(q, 'mse:warmup', 'full_weight')
    total = hget(q, 'mse:warmup', 'total_ms')
    elapsed = hget(q, 'mse:warmup', 'elapsed_i9_ms')
    weight = full * elapsed // total
    case = named(q, '预热爬坡要算出来', label)
    m = re.search(r'(\d+) × (\d+) / (\d+) = (\d+)', case['note'] + '\n' + ans)
    if not m:
        FAILURES.append('%s: 抠不到"100 × 60000 / 120000 = 50"那条乘除式' % label)
    else:
        got = [int(m.group(i)) for i in range(1, 4)]
        seed = [full, elapsed, total]
        ok = got == seed and int(m.group(4)) == weight
        MEASURED.append('  %s  预热权重算式: 量到 %s = %s，文案写 %s = %s' % (
            'ok  ' if ok else 'FAIL', got, weight, got, m.group(4)))
        if not ok:
            FAILURES.append('%s: 预热算式与 setup 给的参数对不上（%s vs %s，权重 %s vs %s）' % (
                label, got, seed, m.group(4), weight))
        if str(case['expected']) != m.group(4):
            FAILURES.append('%s: 用例 expected 是 %s，文案算的是 %s' % (label, case['expected'], m.group(4)))
    route = zadd_members(q, 'mse:route').get('mse:route', {})
    if 'i-4' in route:
        FAILURES.append('%s: i-4 在种子里就出现在路由表里，那"禁用不许出现"这条用例没有区分度' % label)
    MEASURED.append('  ok    种子路由表成员 %s（i-4 不在其中）' % sorted(route))


# =================================================================== 本批新增的 6 道：从文案抠数字再量
def grid(q, case_idx, key_cols):
    """mysql 的 expected → {键元组: {列: 值}}（键是"这一行的身份证"，列名来自 expected.columns）。"""
    exp = q['cases'][case_idx]['expected']
    cols = exp['columns']
    ki = [cols.index(c) for c in key_cols]
    return cols, {tuple(r[i] for i in ki): dict(zip(cols, r)) for r in exp['rows']}


def para_case(q, text, pos):
    """声明所在的那一段里点了哪个用例 ⇒ 拿那条用例的 expected 量；没点名就是基线（用例 0）。"""
    start = text.rfind('\n\n', 0, pos)
    end = text.find('\n\n', pos)
    para = text[start + 2: end if end > 0 else len(text)]
    m = re.search('用例「([^」]+)」', para)
    if not m:
        return 0
    frag = m.group(1)
    for i, c in enumerate(q['cases']):
        if frag in c['name'] or c['name'] in frag:
            return i
    FAILURES.append('段落里点名用例「%s」，但用例表里没有这条 —— 文案与用例表脱钩了' % frag)
    return 0


def claim_count(text, pattern, label, want_min=1):
    m = re.findall(pattern, text, re.S)
    if len(m) < want_min:
        FAILURES.append('%s: 只抠到 %d 条 /%s/ —— 文案被改写了，探针得跟着改' % (label, len(m), pattern))
    return m


def probe_metric_gate():
    q = load('sql-mysql-0033')
    ans, label = q['answer'], 'sql-mysql-0033'
    cols, base = grid(q, 0, ['kind', 'metric_name', 'filter_code', 'period_code'])
    n0 = len(q['cases'][0]['expected']['rows'])

    # 用例名承诺"全表 13 行"
    check('基线行数', n0, q['cases'][0]['name'], r'全表 (\d+) 行', label)
    # 答案："基线六个 derived-metric（pay_amount"
    pay = [k for k in base if k[0] == 'derived-metric' and k[1] == 'pay_amount']
    check('基线 pay_amount 的派生指标数', len(pay), ans, r'基线([一二三四五六七八九十\d]+)个 `derived-metric`', label)
    # 答案逐格写出的数：`day/all = 19900+5000+8800+2100 = 35800`
    cells = claim_count(ans, r'`(day|week)/(all|no-refund|app) = [^`=]* = (\d+)`', label, 6)
    for per, flt, said in cells:
        row = base.get(('derived-metric', 'pay_amount', flt, per))
        if row is None:
            FAILURES.append('%s: 文案点了 %s/%s 但 expected 里没有这一行' % (label, per, flt))
            continue
        ok = row['value'] == int(said)
        MEASURED.append('  %s  pay_amount %s/%s: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', per, flt, row['value'], said))
        if not ok:
            FAILURES.append('%s: pay_amount %s/%s 文案写 %s，expected 是 %s' % (
                label, per, flt, said, row['value']))
    # active_buyer 的买家数
    check('active_buyer day/all', base[('derived-metric', 'active_buyer', 'all', 'day')]['value'],
          ans, r'`day/all` = (\d+) 个买家', label)
    # definition-count/pay_amount/6/1/6 与 duplicate-registration/refund_amount/refund/day/2
    # **按段落定位用例**：段落里点了「用例 X」就拿那条的 expected 量，否则拿基线
    grids = {}
    mets = list(re.finditer(
        r'`(definition-count|duplicate-registration)/(\w+)/(\w+)/(\w+)/(\d+)`', ans))
    if len(mets) < 3:
        FAILURES.append('%s: 只抠到 %d 条 definition-count/duplicate-registration 声明（应 ≥3）' % (
            label, len(mets)))
    for mt in mets:
        kind, name, f, p2, val = mt.groups()
        idx = para_case(q, ans, mt.start())
        if idx not in grids:
            _, grids[idx] = grid(q, idx, ['kind', 'metric_name', 'filter_code', 'period_code'])
        row = grids[idx].get((kind, name, f, p2))
        tag = '%s/%s@用例%d' % (kind, name, idx + 1)
        if row is None:
            FAILURES.append('%s: 文案点了 %s/%s/%s/%s，但用例 %d 的 expected 没有这行' % (
                label, kind, name, f, p2, idx + 1))
            continue
        ok = row['value'] == int(val)
        MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', tag,
                                                         row['value'], val))
        if not ok:
            FAILURES.append('%s: %s 文案写 %s，expected 是 %s' % (label, tag, val, row['value']))
    # 用例「把未回填的 refunded 补成 0」：week/no-refund 与 scope-gap 的两个新数
    c2 = q['cases'][1]
    _, m2 = grid(q, 1, ['kind', 'metric_name', 'filter_code', 'period_code'])
    check('补 0 之后 week/no-refund', m2[('derived-metric', 'pay_amount', 'no-refund', 'week')]['value'],
          ans, r'`week/no-refund` 变成 (\d+)', label)
    check('补 0 之后 scope-gap', m2[('scope-gap', 'pay_amount', 'no-refund', 'week')]['value'],
          ans, r'`scope-gap` 变 (\d+)', label)
    # 用例名承诺"九个派生指标都是 0"（清空事实表）
    c4 = named(q, '退化：事实表清空', label)
    dr = [r for r in c4['expected']['rows'] if r[0] == 'derived-metric']
    check('清空后派生指标行数', len(dr), c4['name'], r'([一二三四五六七八九十\d]+)个派生指标都是 0', label)
    if any(r[4] != 0 for r in dr):
        FAILURES.append('%s: 清空事实表后仍有派生指标不为 0：%s' % (label, dr))
    # 用例名承诺"duplicate-registration 报 3"
    c6 = named(q, 'duplicate-registration 报', label)
    d6 = [r for r in c6['expected']['rows'] if r[0] == 'duplicate-registration']
    if len(d6) != 1 or d6[0][4] != 3:
        FAILURES.append('%s: 用例「同一定义再登记一次」的 duplicate-registration 不是单个 3：%s' % (label, d6))
    else:
        MEASURED.append('  ok    用例「同一定义再登记一次」的 duplicate-registration = 3')
    # 用例名承诺"多出三行"（gmv 非法形态）
    c5 = named(q, '非法形态：同名指标被登记成两种业务限定', label)
    diff = len(c5['expected']['rows']) - n0
    check('新增 gmv 带来的行数', diff, ans, r'）会多出([一二三四五六七八九十\d]+)行', label)
    # 用例「把 8/25 那行搬进周窗口」：三个周口径各多 4450、天窗口不动
    c3 = named(q, '把 8/25 那行搬进周窗口', label)
    _, m3 = grid(q, q['cases'].index(c3), ['kind', 'metric_name', 'filter_code', 'period_code'])
    bump = int(re.search(r'三个周口径各多 (\d+)', c3['name']).group(1))
    for flt in ('all', 'app', 'no-refund'):
        d = m3[('derived-metric', 'pay_amount', flt, 'week')]['value'] \
            - base[('derived-metric', 'pay_amount', flt, 'week')]['value']
        ok = d == bump
        MEASURED.append('  %s  周口径 %s 增量: 量到 %s，用例名写 %s' % (
            'ok  ' if ok else 'FAIL', flt, d, bump))
        if not ok:
            FAILURES.append('%s: 周口径 %s 实际多 %s，用例名写多 %s' % (label, flt, d, bump))
    same = [k for k in base if k[0] == 'derived-metric' and k[3] == 'day'
            and m3[k]['value'] != base[k]['value']]
    if same:
        FAILURES.append('%s: 用例名说"天窗口完全不变"，但这些天口径变了：%s' % (label, same))
    else:
        MEASURED.append('  ok    天窗口四个口径一行都没变（用例名的承诺成立）')


def probe_shard():
    q = load('sql-mysql-0034')
    ans, label = q['answer'], 'sql-mysql-0034'
    tables = seed_tables(q)
    for tbl in ('shard_row', 'gsi_index'):
        if not tables.get(tbl) or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了' % (label, tbl))
    cols, grid0 = grid(q, 0, ['metric'])
    base = {k[0]: v for k, v in grid0.items()}
    n0 = len(q['cases'][0]['expected']['rows'])
    check('基线指标行数', n0, ans, r'\*\*基线([一二三四五六七八九十\d]+)行\*\*', label)

    # 答案逐格写出的 `metric=值`（十列）
    pairs = claim_count(ans, r'`([a-z-]+)=(\d+)`', label, 10)
    for name, said in pairs:
        if name not in base:
            FAILURES.append('%s: 文案点了 %s 但 expected 的 metric 列里没有' % (label, name))
            continue
        got = base[name]['value']
        ok = got == int(said)
        MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', name, got, said))
        if not ok:
            FAILURES.append('%s: %s 文案写 %s，expected 是 %s' % (label, name, said, got))

    # "三个分片各只有 4 / 3 / 2 行"
    per_shard = {}
    for r in tables['shard_row']['rows']:
        per_shard[r['shard_idx']] = per_shard.get(r['shard_idx'], 0) + 1
    sizes = [per_shard.get(i, 0) for i in sorted(per_shard)]
    said_sizes = [int(x) for x in re.search(r'三个分片各只有 ([\d /]+) 行', ans).group(1).split('/')]
    ok = sizes == said_sizes
    MEASURED.append('  %s  每片行数: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', sizes, said_sizes))
    if not ok:
        FAILURES.append('%s: 种子分片行数 %s，文案写 %s' % (label, sizes, said_sizes))

    # 跨片重复的主键集合：文案点名 5003 与 5007
    copies = {}
    for r in tables['shard_row']['rows']:
        copies.setdefault(r['row_id'], set()).add(r['shard_idx'])
    dup = sorted(k for k, v in copies.items() if len(v) > 1)
    said_dup = sorted(int(x) for x in re.findall(r'\b(50\d\d)\b', ans[:ans.find('朴素解')] or ans))
    ok = dup == [5003, 5007]
    MEASURED.append('  %s  跨片重复主键: 量到 %s，文案写 [5003, 5007]（点名单里含 %s）' % (
        'ok  ' if ok else 'FAIL', dup, said_dup[:3]))
    if not ok:
        FAILURES.append('%s: 种子里跨片重复的主键是 %s，文案"（5003 与 5007）"落空' % (label, dup))
    pk_shard = {r['row_id'] for r in tables['shard_row']['rows']}
    pk_gsi = {g['row_id'] for g in tables['gsi_index']['rows']}
    if sorted(pk_shard - pk_gsi) != [5007] or sorted(pk_gsi - pk_shard) != [5008]:
        FAILURES.append('%s: missing/orphan 不是文案点名的 5007/5008（%s / %s）' % (
            label, sorted(pk_shard - pk_gsi), sorted(pk_gsi - pk_shard)))
    else:
        MEASURED.append('  ok    missing=5007、orphan=5008 与文案一致')
    # 朴素解"把多条单当散落"的 3：量种子（COUNT(*) > 1 的买家数）
    by_buyer = {}
    for r in tables['shard_row']['rows']:
        by_buyer[r['buyer_id']] = by_buyer.get(r['buyer_id'], 0) + 1
    multi = len([k for k, v in by_buyer.items() if v > 1])
    check('朴素口径的 buyers-scattered', multi, ans, r'基线给出 (\d+) 而正确答案是 \d+', label)
    if base['buyers-scattered']['value'] != 1:
        FAILURES.append('%s: 正确答案 buyers-scattered 不是 1' % label)
    # "正确口径 3 → 1 / 朴素口径 0 → 0"（删掉分片 2 的那个用例）
    c3 = named(q, '删掉分片 2 的全部行', label)
    _, g3 = grid(q, q['cases'].index(c3), ['metric'])
    m3 = {k[0]: v for k, v in g3.items()}
    a, b = [int(x) for x in re.search(r'正确口径 (\d+) → (\d+)', ans).groups()]
    c, d = [int(x) for x in re.search(r'朴素口径 (\d+) → (\d+)', ans).groups()]
    for metric, pair in (('page-rows-correct', (a, b)), ('page-rows-naive-per-shard', (c, d))):
        got = (base[metric]['value'], m3[metric]['value'])
        ok = got == pair
        MEASURED.append('  %s  %s 删片前后: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', metric, got, pair))
        if not ok:
            FAILURES.append('%s: %s 删片前后实际 %s，文案写 %s' % (label, metric, got, pair))
    # 「索引表被清空」那条用例名承诺的 missing=7
    c5 = named(q, '索引表被清空', label)
    _, g5 = grid(q, q['cases'].index(c5), ['metric'])
    m5 = {k[0]: v for k, v in g5.items()}
    check('索引表清空后 missing', m5['gsi-missing-rows']['value'], q['cases'][4].get('note', ''),
          r'gsi-missing-rows=(\d+)', label)
    if m5['gsi-back-to-table-rows']['value'] != 0:
        FAILURES.append('%s: 索引表清空后回表行数不是 0（用例名说"回表 0 行"）' % label)


def probe_backlog():
    q = load('sql-mysql-0035')
    ans, label = q['answer'], 'sql-mysql-0035'
    cols = q['cases'][0]['expected']['columns']
    base_rows = {tuple(r[:2]): r for r in q['cases'][0]['expected']['rows']}
    check('基线分组数', len(base_rows), ans, r'\*\*基线十二列\*\*（([三四五六\d]+)行）', label)
    # 答案那张表逐格量：12 列 × 每行
    table = re.findall(r'\| (\d+) \| (\w+) \|([^\n]+)\|', ans)
    if len(table) != 3:
        FAILURES.append('%s: 只抠到 %d 行基线表（三行才对）' % (label, len(table)))
    for node, topic, rest in table:
        vals = [x.strip().replace('−', '-') for x in rest.split('|') if x.strip()]
        key = (int(node), topic)
        if key not in base_rows:
            FAILURES.append('%s: 文案点了 %s 但 expected 没有这一组' % (label, key))
            continue
        got = list(base_rows[key][2:])
        said = [int(v) for v in vals]
        ok = got == said and len(said) == len(cols) - 2
        MEASURED.append('  %s  %s 十二列: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', key, got, said))
        if not ok:
            FAILURES.append('%s: %s 文案写 %s，expected 是 %s' % (label, key, said, got))
    # 种子层面量"有效位点"那三个数
    tables = seed_tables(q)
    snap = {(r['snapshot_seq'], r['node'], r['topic'], r['queue_id']): r
            for r in tables['offset_snap']['rows']}
    t1 = snap[(2, 1, 'order', 2)]
    ok = (t1['max_off'], t1['min_off'], t1['cons_off']) == (3000, 2600, 2400)
    MEASURED.append('  %s  被纠正队列的 t1 三元组: 量到 %s，文案写 (3000, 2600, 2400)' % (
        'ok  ' if ok else 'FAIL', (t1['max_off'], t1['min_off'], t1['cons_off'])))
    if not ok:
        FAILURES.append('%s: 种子变了，"3000 − 2600 = 400"那句要跟着改' % label)
    # 文案里"堆积 = 3000 − 2600 = 400"：三个数都要能从种子量出来
    m = re.search(r'堆积 = (\d+) − (\d+) = (\d+)', ans)
    if not m:
        FAILURES.append('%s: 抠不到"堆积 = A − B = C"那句' % label)
    else:
        got = (t1['max_off'], t1['min_off'], t1['max_off'] - t1['min_off'])
        said = tuple(int(m.group(i)) for i in range(1, 4))
        ok = got == said and base_rows[(1, 'order')][4] == 800
        MEASURED.append('  %s  有效位点堆积: 量到 %s，文案写 %s（组内合计 %s）' % (
            'ok  ' if ok else 'FAIL', got, said, base_rows[(1, 'order')][4]))
        if not ok:
            FAILURES.append('%s: 堆积文案写 %s / 合计 %s，种子与 expected 给出 %s / %s' % (
                label, said, base_rows[(1, 'order')][4], got, 800))
    # 文案里"朴素解会给出 600 + 400 = 1000"：两半都从种子量
    m = re.search(r'会给出 (\d+) \+ (\d+) = \*\*(\d+)\*\*', ans)
    if not m:
        FAILURES.append('%s: 抠不到朴素口径那条加法' % label)
    else:
        q1 = snap[(2, 1, 'order', 1)]
        a, b = t1['max_off'] - t1['cons_off'], q1['max_off'] - q1['cons_off']
        got = (a, b, a + b)
        said = tuple(int(m.group(i)) for i in range(1, 4))
        ok = got == said
        MEASURED.append('  %s  朴素口径堆积: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', got, said))
        if not ok:
            FAILURES.append('%s: 朴素堆积实际 %s，文案写 %s' % (label, got, said))
    # 用例名的承诺：min_off 降回去 ⇒ 堆积多 200、windows 4 → 5
    c2 = named(q, '把那条 min_off 降回', label)
    m2 = {tuple(r[:2]): dict(zip(cols, r)) for r in q['cases'][q['cases'].index(c2)]['expected']['rows']}
    a, b = [int(x) for x in re.search(r'堆积 (\d+) → \*\*(\d+)\*\*', ans).groups()] if re.search(
        r'堆积 (\d+) → \*\*(\d+)\*\*', ans) else (None, None)
    got = (base_rows[(1, 'order')][4], m2[(1, 'order')]['backlog'])
    ok = a is not None and got == (a, b)
    MEASURED.append('  %s  降 min 前后堆积: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', got, (a, b)))
    if not ok:
        FAILURES.append('%s: 降 min 用例的堆积实际 %s，文案写 %s' % (label, got, (a, b)))
    w = [int(x) for x in re.search(r'`windows` (\d+) → \*\*(\d+)\*\*', ans).groups()]
    got_w = (base_rows[(1, 'order')][10], m2[(1, 'order')]['windows_to_clear'])
    ok = got_w == tuple(w)
    MEASURED.append('  %s  降 min 前后 windows: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', got_w, w))
    if not ok:
        FAILURES.append('%s: windows 实际 %s，文案写 %s' % (label, got_w, w))
    # 重置那条：reset 从 1 变 0、净消耗仍是负数
    c3 = named(q, '把重置那条改成正常推进', label)
    m3 = {tuple(r[:2]): dict(zip(cols, r)) for r in c3['expected']['rows']}
    if base_rows[(2, 'order')][6] != 1 or m3[(2, 'order')]['reset_queues'] != 0:
        FAILURES.append('%s: 重置列不满足"从 1 变 0"（%s → %s）' % (
            label, base_rows[(2, 'order')][6], m3[(2, 'order')]['reset_queues']))
    else:
        MEASURED.append('  ok    reset 从 1 变 0，windows 仍是 %s' % m3[(2, 'order')]['windows_to_clear'])
    net = [int(x) for x in re.search(r'净消耗 (\d+) − (\d+) = −(\d+)', ans).groups()]
    got_net = [m3[(2, 'order')]['consumed_win'], m3[(2, 'order')]['produced_win'],
               m3[(2, 'order')]['produced_win'] - m3[(2, 'order')]['consumed_win']]
    ok = net == got_net
    MEASURED.append('  %s  净消耗式: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', got_net, net))
    if not ok:
        FAILURES.append('%s: 净消耗文案 %s 与 expected %s 不符' % (label, net, got_net))
    # 非法形态：consumed 从 1700 掉到 1100
    c4 = named(q, '把一条位点写到最大位点之后', label)
    m4 = {tuple(r[:2]): dict(zip(cols, r)) for r in c4['expected']['rows']}
    a, b = [int(x) for x in re.search(r'`consumed` 从 (\d+) 掉到 (\d+)', ans).groups()]
    got = (base_rows[(1, 'order')][8], m4[(1, 'order')]['consumed_win'])
    ok = got == (a, b) and m4[(1, 'order')]['dropped_queues'] == 1
    MEASURED.append('  %s  剔除后 consumed: 量到 %s（dropped=%s），文案写 %s' % (
        'ok  ' if ok else 'FAIL', got, m4[(1, 'order')]['dropped_queues'], (a, b)))
    if not ok:
        FAILURES.append('%s: consumed 文案 %s，实际 %s' % (label, (a, b), got))
    # 空结果那条：真的没有行
    c6 = named(q, '删掉第二个快照', label)
    if c6['expected'] not in ([], {'rows': []}):
        FAILURES.append('%s: 用例名说"一行都不许出"，expected 却有 %s 行' % (
            label, len(c6['expected'].get('rows', []))))
    else:
        MEASURED.append('  ok    只剩 t0 时确实出 0 行')


def probe_bill():
    q = load('bd-pyspark-0024')
    ans, label = q['answer'], 'bd-pyspark-0024'
    base = {r['team']: r for r in q['cases'][0]['expected']}
    for team in ('ads', 'dw'):
        pat = r'（`?%s`?）：((?:\s*`\w+=\d+`[、，]?)+)' % team
        m = re.search(pat, ans)
        if not m:
            FAILURES.append('%s: 抠不到 %s 团队的基线八个值 —— 那段文案被改写了' % (label, team))
            continue
        said = dict(re.findall(r'`(\w+)=(\d+)`', m.group(1)))
        for col, val in said.items():
            got = base[team][col]
            ok = got == int(val)
            MEASURED.append('  %s  %s.%s: 量到 %s，文案写 %s' % (
                'ok  ' if ok else 'FAIL', team, col, got, val))
            if not ok:
                FAILURES.append('%s: %s.%s 文案写 %s，expected 是 %s' % (label, team, col, val, got))
        if len(said) != 7:
            FAILURES.append('%s: %s 只抠到 %d 个列值（应当 7 个）' % (label, team, len(said)))
    # 逐行单价那条式子：1200 × 30 + 100 × 57 = 41700
    m = re.search(r'(\d+) × (\d+) \+ (\d+) × (\d+) = (\d+)', text_of(q))
    if not m:
        FAILURES.append('%s: 抠不到"先各自乘单价再相加"那条式子' % label)
    else:
        gb = {1: 300 * 2 * 2, 2: 100 * 1 * 1}     # 不是重写模型：这两个数从种子的列里量
        rows = q['cases'][0]['input']['rows']
        by_id = {r['job_id']: r for r in rows}
        calc1 = by_id[1]['scan_comp_gb'] * by_id[1]['complexity'] * (
            by_id[1]['runs'] - by_id[1]['failed_runs'])
        calc2 = by_id[2]['scan_comp_gb'] * by_id[2]['complexity'] * (
            by_id[2]['runs'] - by_id[2]['failed_runs'])
        got = [calc1, 30, calc2, 57, calc1 * 30 + calc2 * 57]
        said = [int(m.group(i)) for i in range(1, 6)]
        ok = got == said and base['ads']['cost_fen'] == said[4]
        MEASURED.append('  %s  混合单价式: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', got, said))
        if not ok:
            FAILURES.append('%s: 混合单价文案 %s，实测量到 %s' % (label, said, got))
    # 用例「把没回填的压缩量补成 80」的四列前后
    c2 = named(q, '把没回填的压缩量补成 80', label)
    now = {r['team']: r for r in c2['expected']}
    for col in ('calc_gb', 'cost_fen', 'dup_cost_fen'):
        m = re.search(r'`%s` (\d+) → (\d+)' % col, ans)
        if not m:
            FAILURES.append('%s: 抠不到 %s 的前后两个数' % (label, col))
            continue
        got = (base['ads'][col], now['ads'][col])
        ok = got == (int(m.group(1)), int(m.group(2)))
        MEASURED.append('  %s  ads.%s 补数前后: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', col, got, m.groups()))
        if not ok:
            FAILURES.append('%s: ads.%s 实际 %s，文案写 %s' % (label, col, got, m.groups()))
    if now['ads']['unknown_rows'] != 0 or base['ads']['unknown_rows'] != 1:
        FAILURES.append('%s: unknown_rows 没有"从 1 到 0"' % label)
    if now['ads']['raw_calc_gb'] != base['ads']['raw_calc_gb']:
        FAILURES.append('%s: 补压缩量却动了 raw_calc_gb（用例名说"一动不动"）' % label)
    # 非法形态那条：金额三列为 0 而 unknown_rows=1
    c4 = named(q, '把台账写成 failed_runs 大于 runs', label)
    t4 = {r['team']: r for r in c4['expected']}
    ok = (t4['dw']['calc_gb'], t4['dw']['cost_fen'], t4['dw']['dup_cost_fen'],
          t4['dw']['unknown_rows'], t4['dw']['jobs']) == (0, 0, 0, 1, 2)
    MEASURED.append('  %s  坏台账后的 dw: 量到 %s' % ('ok  ' if ok else 'FAIL',
                                                     dict(t4['dw'])))
    if not ok:
        FAILURES.append('%s: 坏台账那条的 dw 不满足"金额全 0 但 jobs 与 unknown_rows 还在"' % label)
    # 退化：全部失败 ⇒ 金额 0 但 jobs 仍是 3 与 2
    c5 = named(q, '所有作业的全部执行都失败', label)
    t5 = {r['team']: r for r in c5['expected']}
    ok = all(t5[k]['calc_gb'] == 0 and t5[k]['cost_fen'] == 0 for k in ('ads', 'dw')) \
        and (t5['ads']['jobs'], t5['dw']['jobs']) == (3, 2)
    MEASURED.append('  %s  全部失败后: jobs=%s/%s、金额全 0' % (
        'ok  ' if ok else 'FAIL', t5['ads']['jobs'], t5['dw']['jobs']))
    if not ok:
        FAILURES.append('%s: 退化那条不满足"三列金额为 0 但 jobs 还在"' % label)


def probe_ttl():
    q = load('bd-scala-0002')
    ans, label = q['answer'], 'bd-scala-0002'
    cols = q['cases'][0]['expected'][0].keys()
    base = {r['pk']: r for r in q['cases'][0]['expected']}
    rows_tbl = re.findall(r'\| (\d+) \|(\s*\d+\s*\|)+', ans)
    if len(rows_tbl) != 3:
        FAILURES.append('%s: 基线表只抠到 %d 行（应当 3 行）—— 那段文案改了' % (label, len(rows_tbl)))
    for m in re.finditer(r'^\| (1|2|3) \|((?: *[\d]+ *\|){8})', ans, re.M):
        pk = int(m.group(1))
        vals = [int(x) for x in re.findall(r'\d+', m.group(2))]
        keys = [c for c in cols if c != 'pk']
        got = [base[pk][k] for k in keys]
        ok = got == vals and len(vals) == 8
        MEASURED.append('  %s  pk%d 九列: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', pk, got, vals))
        if not ok:
            FAILURES.append('%s: pk%d 文案写 %s，expected 是 %s' % (label, pk, vals, got))
    # 种子层量"两把尺子"：now 与 pk 1 的年龄差
    rows = q['cases'][0]['input']['rows']
    now = max(r['written_ms'] for r in rows)
    DAY = 86400000
    r1 = [r for r in rows if r['pk'] == 1]
    anchor = re.search(r'`ttl_days = (\d+) / (\d+) = (\d+)`', ans)
    if not anchor:
        FAILURES.append('%s: 抠不到 ttl_days 那条除法' % label)
    else:
        ttl_s = min(r['ttl_seconds'] for r in r1)
        got = [ttl_s, 86400, ttl_s // 86400]
        said = [int(anchor.group(i)) for i in range(1, 4)]
        ok = got == said
        MEASURED.append('  %s  pk1 的 ttl_days 式: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', got, said))
        if not ok:
            FAILURES.append('%s: ttl_days 文案 %s，种子里是 %s' % (label, said, got))
    kept = max((r for r in r1 if now - r['written_ms'] < ttl_s * 1000), key=lambda r: r['version'])
    gap = (now // DAY) - kept['ds']
    claim = re.search(r'`now_ds − ds = (\d+)`', ans)
    if not claim:
        FAILURES.append('%s: 抠不到"now_ds − ds = N"那句' % label)
    else:
        ok = int(claim.group(1)) == gap
        MEASURED.append('  %s  pk1 分区差: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', gap, claim.group(1)))
        if not ok:
            FAILURES.append('%s: 分区差实际 %s，文案写 %s' % (label, gap, claim.group(1)))
    # 答案两处 `ghost_rows = N` 分别讲 pk1 与 pk3：每个 N 都必须在某个 pk 上真量到
    gs = claim_count(ans, r'`ghost_rows = (\d+)`', label, 1)
    have = sorted({r['ghost_rows'] for r in base.values()})
    for g in gs:
        ok = int(g) in have
        MEASURED.append('  %s  ghost_rows 声明 %s: 基线各 pk 的取值 %s' % ('ok  ' if ok else 'FAIL', g, have))
        if not ok:
            FAILURES.append('%s: 文案写 ghost_rows=%s，基线没有任何 pk 是这个数（现值 %s）' % (label, g, have))
    # 用例「updated 早于 written」的 rev_rows
    c3 = named(q, 'updated 早于 written', label)
    rev = [r for r in c3['expected'] if r['rev_rows'] == 1]
    if len(rev) != 1 or rev[0]['kept_version'] != 4 or rev[0]['alive_write'] != 1:
        FAILURES.append('%s: 时钟回拨那条不满足"rev_rows=1、kept_version=4、alive_write=1"：%s' % (
            label, c3['expected']))
    else:
        MEASURED.append('  ok    时钟回拨那条：rev_rows=1 且该行仍按写入存活（kept_version=4）')
    # 用例「ttl 不一致取最小」的 kept_version
    c4 = named(q, '同一主键两行 ttl 不一致', label)
    r4 = c4['expected'][0]
    if r4['kept_version'] != 3:
        FAILURES.append('%s: 取最小 ttl 之后 kept_version 应是 3，实际 %s' % (label, r4['kept_version']))
    else:
        MEASURED.append('  ok    取最小 ttl ⇒ kept_version=3（取最大会给 %s）'
                        % max(r['version'] for r in c4['input']['rows']))
    # 退化：全部过期的两个主键仍各出一行、kept_version=0
    c5 = named(q, '两个主键全部按写入过期', label)
    zero = [r for r in c5['expected'] if r['kept_version'] == 0]
    if len(zero) != 2 or len(c5['expected']) != 3:
        FAILURES.append('%s: 退化那条应"三行都出、其中两行 kept_version=0"，实际 %s' % (
            label, [r['kept_version'] for r in c5['expected']]))
    else:
        MEASURED.append('  ok    退化那条：3 行都出、2 行 kept_version=0（对照组全活）')


def probe_breaker():
    q = load('alg-java-0058')
    ans, label = q['answer'], 'alg-java-0058'
    by_name = {c['name']: c for c in q['cases']}
    # 答案里"用例「X」……给出 [a, b, ...]"形式的整串八元组，逐个回判到 expected
    hits = re.findall(r'用例「([^」]+)」[^。]{0,120}?`?\[([0-9, ]+)\]`?', ans, re.S)
    if len(hits) < 5:
        FAILURES.append('%s: 只抠到 %d 处"用例给出向量"的声明（本批写了 6 处）' % (label, len(hits)))
    for frag, vec in hits:
        want = [int(x) for x in vec.split(',')]
        hit = [n for n in by_name if frag in n or n in frag]
        if not hit:
            FAILURES.append('%s: 文案点名用例「%s」但用例表里没有' % (label, frag))
            continue
        got = by_name[hit[0]].get('expected')
        ok = got == want
        MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', frag, got, want))
        if not ok:
            FAILURES.append('%s: 用例「%s」expected 是 %s，文案写 %s' % (label, frag, got, want))
    # 基线那句单独写的向量 + 用例名里"第 5 条才越线"
    m = re.search(r'\*\*基线那条给出 `\[([0-9, ]+)\]`\*\*', ans)
    if not m:
        FAILURES.append('%s: 抠不到基线向量那句话' % label)
    else:
        base = [c for c in q['cases'] if c['name'].startswith('基线')][0]
        ok = base['expected'] == [int(x) for x in m.group(1).split(',')]
        MEASURED.append('  %s  基线八个数: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', base['expected'], m.group(1)))
        if not ok:
            FAILURES.append('%s: 基线文案写 %s，expected 是 %s' % (label, m.group(1), base['expected']))
        n = int(re.search(r'第 (\d+) 条才越线', base['name']).group(1))
        # 用例名说"第 5 条才越线" ⇒ 前 4 条结束时都不该满足 total > minRequests
        args = base['input']
        min_req = args[3]
        if any(i + 1 > min_req for i in range(n - 1)):
            FAILURES.append('%s: 用例名说第 %d 条才越线，但门槛 %d 更早就被超过' % (label, n, min_req))
        else:
            MEASURED.append('  ok    前 %d 条都没跨过门槛 minRequests=%d' % (n - 1, min_req))
    # "八个数是 [0, 0, 0, 4, 0, 4, 2, 0]：一次都不熔断" —— 数量承诺
    m = re.search(r'八个数是 `\[(0, 0, 0, 4, 0, 4, 2, 0)\]`', ans)
    if not m:
        FAILURES.append('%s: 抠不到"八个数"那句' % label)
    else:
        c = [x for x in q['cases'] if '一次都不熔断' in x['name']][0]
        ok = c['expected'] == [int(x) for x in m.group(1).split(',')]
        MEASURED.append('  %s  双边界那条: 量到 %s，文案写 %s' % (
            'ok  ' if ok else 'FAIL', c['expected'], m.group(1)))
        if not ok:
            FAILURES.append('%s: 双边界文案写 %s，expected 是 %s' % (label, m.group(1), c['expected']))


# ============================================== 阿里前端两题（fe-react-0022 / 0023）
def _obs_at(case, t):
    """react-vitest 题的 expected 是一串 `{"t":…, "obs":…}` 观测点；按时刻取那一条。"""
    for o in case['expected']:
        if o.get('t') == t:
            return o.get('obs') or {}
    raise SystemExit('%s: 用例「%s」里没有 t=%s 的观测点 —— 用例时间轴改了，探针得跟着改'
                     % (case.get('id', '?'), case['name'], t))


def probe_fe_isolation():
    q = load('fe-react-0022')
    ans, label = q['answer'], 'fe-react-0022'

    def case(prefix):
        return named(q, prefix, label)

    def claim(what, ok, measured, said):
        MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', what, measured, said))
        if not ok:
            FAILURES.append('%s: %s 文案写 %s，实际量到 %s' % (label, what, said, measured))

    # 「基线…一条告警都不该有」/「…+ 两条告警」—— 告警条数直接数 expected 里的数组
    base = case('基线：全支持')
    claim('基线告警条数（文案"一条告警都不该有"）', len(base['expected']['warnings']) == 0,
          len(base['expected']['warnings']), 0)
    downgrade = case('降级：无 Proxy 且显式 singular:false')
    claim('无 Proxy + singular:false 的告警条数（文案"两条告警"）',
          len(downgrade['expected']['warnings']) == 2, len(downgrade['expected']['warnings']), 2)
    # 「singular 不许被改」：源码那条与 FAQ 冲突，本题按源码判 ⇒ 库里必须留着 false
    claim('降级用例里 singular 仍是 false（文案"singular 不许被改"）',
          downgrade['expected']['singular'] is False, downgrade['expected']['singular'], False)
    # 「只抛 strict 那条，且 scopedCss 必须是 false、containerAttr 必须是 null」
    both = case('硬失败：legacy render + 两档隔离同开')
    e = both['expected']
    claim('两档同开时抛出的条数（文案"只有 strict 那条"）', len(e['thrown']) == 1, len(e['thrown']), 1)
    claim('抛的是 strict 那条', str(e['thrown'][0]).startswith('strictStyleIsolation'),
          e['thrown'][0], 'strictStyleIsolation…')
    claim('两档互斥 ⇒ scopedCss 为假', e['scopedCss'] is False, e['scopedCss'], False)
    claim('两档互斥 ⇒ containerAttr 为 null', e['containerAttr'] is None, e['containerAttr'], None)
    # 「无 Proxy 时先返回，speedy 那条不会被执行」
    mutex = case('分支互斥：无 Proxy 时先返回')
    claim('无 Proxy 时 speedy 不再报（文案"只有一条 W_PROXY，没有 W_SPEEDY"）',
          len(mutex['expected']['warnings']) == 1
          and not any('Speedy' in w for w in mutex['expected']['warnings']),
          mutex['expected']['warnings'], '1 条、不含 Speedy')
    # 「第 3 次是 react16_2 而不是 react16_3」
    inst = case('实例标识：同名第 3 次加载')
    claim('第 3 次加载的容器标识（文案 react16_2）',
          inst['expected']['containerAttr'] == 'react16_2', inst['expected']['containerAttr'], 'react16_2')
    # 「containerAttr 与 thrown 可以同时非空」—— 必须真有一格这样，否则这句话没有判据
    both_live = [c for c in q['cases']
                 if isinstance(c.get('expected'), dict) and c['expected'].get('thrown')
                 and c['expected'].get('containerAttr')]
    claim('"抛错同时也有容器标识"这一格存在', len(both_live) >= 1, len(both_live), '>=1')
    # 「@font-face / @keyframes 一个字都不动」与「html 是被替换而不是加前缀」
    keep = case('基线：普通规则加前缀')
    claim('@font-face 原样保留', '@font-face{font-family:icon;src:url(icon.woff)}' in keep['expected'],
          '命中' if '@font-face{font-family:icon;src:url(icon.woff)}' in keep['expected'] else '被改写', '原样')
    root = case('根选择器：html / body / :root')
    claim('根选择器被替换（输出里不再有裸 html 选择器）', 'html {' not in root['expected'],
          '没有 "html {"' if 'html {' not in root['expected'] else '仍有 html {', '被替换')
    # 「兄弟规则不是原样」—— 素材里那句"原样"是错的，用例必须站在源码一边
    sib = case('非标准兄弟规则')
    claim('html + body 也被改写（文案说素材的"原样"是错的）',
          'html +' not in sib['expected'], '没有裸 "html +"' if 'html +' not in sib['expected'] else '仍原样',
          '改写')


def probe_fe_use_request():
    q = load('fe-react-0023')
    ans, label = q['answer'], 'fe-react-0023'

    def claim(what, ok, measured, said):
        MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', what, measured, said))
        if not ok:
            FAILURES.append('%s: %s 文案写 %s，实际量到 %s' % (label, what, said, measured))

    # 「`interval=1000 / delay=100` 那条在第 1000ms 断'还没发第二次'」
    serial = named(q, '轮询：下一次在', label)
    obs = _obs_at(serial, 1000)
    n_calls = len((obs.get('calls') or '-').split('|')) if obs.get('calls') not in (None, '-') else 0
    claim('delay=100 时 t=1000 已发出的请求数（文案"还没发第二次"）', n_calls == 1, n_calls, 1)
    slow = named(q, '轮询：请求比 interval 还慢', label)
    obs2 = _obs_at(slow, 2000)
    n2 = len((obs2.get('calls') or '-').split('|')) if obs2.get('calls') not in (None, '-') else 0
    claim('delay=1500 时 t=2000 已发出的请求数（文案"还没发第二次"）', n2 == 1, n2, 1)
    # 「pollingErrorRetryCount: 2 给的是 3 次失败（判据是 <=）」
    retry = [c for c in q['cases'] if 'pollingErrorRetryCount' in c['name']
             and '2' in json.dumps(c['input'])]
    if not retry:
        FAILURES.append('%s: 找不到 pollingErrorRetryCount=2 那条用例' % label)
    else:
        last = retry[0]['expected'][-1]['obs']
        fails = len((last.get('calls') or '').split('|'))
        claim('retryCount=2 时一共跑了 3 次（文案"给的是 3 次失败"）', fails == 3, fails, 3)
    # 「默认 -1 ⇒ 连错 5 次也还在轮询」
    inf = named(q, 'pollingErrorRetryCount 默认 -1', label)
    calls = (inf['expected'][-1]['obs'].get('calls') or '').split('|')
    claim('默认 -1 时连错 5 次仍在跑', len(calls) >= 5, len(calls), '>=5')
    # 「race 那三条断到 data 不变 / loading 不变 / events 里一条回调记录都没有」
    race = [c for c in q['cases'] if c['name'].startswith('竞态')]
    claim('竞态相关用例有 3 条（文案"那三条用例"）', len(race) == 3, len(race), 3)
    stale = race[0]
    hit = [o for o in stale['expected'] if 'success:#1' in (o['obs'].get('events') or '')
           or 'error:' in (o['obs'].get('events') or '')]
    claim('后发先至时先发那条不写 data 也不报告（events 里不许出现 #1 的回调）',
          len(hit) == 0, len(hit), 0)
    rev = [c for c in race if '反向' in c['name']]
    if not rev:
        FAILURES.append('%s: 找不到"竞态反向"那条用例' % label)
    else:
        bad = [o for o in rev[0]['expected'] if (o['obs'].get('error') or '-') != '-']
        claim('先发起但后失败的那条也不许把 error 写出来（业务错误被吞）',
              len(bad) == 0, len(bad), 0)


# =================================================================== 复核 precheck 覆盖的那 7 道
def probe_precheck_backed():
    """把 precheck 的独立重写打在**已入库那份**上（precheck 自己只跑草稿目录）。"""
    for key, qid in sorted(KEY_TO_ID.items()):
        model = PRE.MODELS.get(key)
        if model is None:
            FAILURES.append('precheck.py 里没有 %s 的独立重写（KEY_TO_ID 与它脱钩了）' % key)
            continue
        bank = load(qid)
        cases = bank['cases']
        bad = 0
        for i, c in enumerate(cases):
            good, detail = PRE.check_case(key, model, c)
            if not good:
                bad += 1
                FAILURES.append('%s 用例 %d「%s」：%s' % (qid, i + 1, c['name'], detail))
        MEASURED.append('  %s  %s ← %s：%d 个用例与独立重写一致' % (
            'ok  ' if bad == 0 else 'FAIL', qid, key, len(cases) - bad))


def main():
    probe_precheck_backed()
    probe_halfmsg()
    probe_hologres()
    probe_inventory()
    probe_redis_cluster()
    probe_redis_mse()
    probe_fe_isolation()
    probe_fe_use_request()
    probe_metric_gate()
    probe_shard()
    probe_backlog()
    probe_bill()
    probe_ttl()
    probe_breaker()
    print('\n'.join(MEASURED))
    print('\n量到 %d 项断言，失败 %d 项' % (len(MEASURED), len(FAILURES)))
    for line in FAILURES:
        print('FAIL %s' % line)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
