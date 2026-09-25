#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
字节跳动已入库题的"答案里的数字必须有来源"探针（与 apple / airbnb / deepseek / pdd / alibaba
同一套纪律；六家里字节是最后一个补上这层的）。

判据方向：**数字是用正则从 `content/questions/<那道题>.json` 的答案 / 题面 / 用例名 / 用例备注
里抠出来的，再和从同一份文件的**数据**（`runner.setup` 种子、`case.input` 变更/入参、
`case.expected`）量到的值比** ——
探针里不写死"基线五行"这类常量，也不重新实现判分模型。
写死常量只能证明"数据是五行"，答案被人改成六行它照样绿；
抠不到那句文案同样算 FAIL —— 文案被改写而探针没跟上，脱钩不许看起来像通过。
这条方向是 WI-65 / WI-70 的破坏性验证打回来的。

与另外两道闸门的分工：
  * `gen.py --check`   ＝ 生成器模型与题库逐字段一致（防"改了题没改模型"）
  * `precheck.py`      ＝ 题能做对（另一份**不同算法**的实现与 expected 一致，跑的是草稿目录）
  * 本文件             ＝ 说明没瞎写（文案点名的具体数字对得上已入库的那份数据）
容器判题矩阵证明的是"参考解真能过、朴素解真会挂"，它**不看文案** —— 文案一直是它的盲区。
阿里那批靠这个方向抓到 3+4 处（用例名承诺 no-pk-scan 但数据给了主键、"基线八行"而 expected
只有五行、`week/app` 写成 52927 而基线是 48477……），在全绿矩阵下全是看不见的。

覆盖范围（**没测的不假装测过**）：
  ✓ 类别 1 ＝ 能纯 Python 复算的 11 道（6 java-junit + 3 pyspark + 2 react-vitest）：
      `probe_precheck_backed()` 把 `precheck.py` 已登记的独立重写打在**已入库那份**上
      （precheck 自己只跑 `data/drafts-bd/out`），另外逐题把答案/用例名里点名的
      入参向量、返回向量、`{...}` 计数、"第 N 条"、公式与阈值回判到 case 数据上。
  ✓ 类别 2 ＝ 5 道 mysql（sql-mysql-0025 ~ 0029）：从 `runner.setup` 的 CREATE/INSERT
      ＋ `case.input` 的 UPDATE/INSERT/DELETE 变更独立复算答案点名的那些数
      （去重人数、GMV、万分比、闭包节点数与热度），并回判 `case.expected`。
      复算的是"量具"，不是第二份判分模型：公式取自查到的题面契约。
  ✓ 类别 2 ＝ 3 道 pyspark：`case.input.rows` 就是数据，逐行复算答案那张表。
  △ 类别 3 ＝ 2 道 redis（sql-redis-0011 / 0012）：迷你 Redis **按参考解的顺序**执行
      （ZREMRANGEBYSCORE 挪到并账之后会量出第三个数 —— 阿里那份踩过这个坑），
      量的是"答案里那段命令序列跑完之后各观测命令的值 vs case.expected"，
      以及初值是否真的跨在回收边界两侧。
      **服务端最终状态本身仍由容器判题矩阵覆盖**（本机没有 Redis，矩阵之外这一层
      只能证明"文案与 expected 同源"，不能证明"真 Redis 也这么算"）—— 那部分打 SKIP。
  ✗ 类别 4 ＝ 12 道 llm-rubric 主观题（sys-rubric-0014~0018 / ag-rubric-0010~0013 /
      hot-rubric-0013~0015）：引用的是官方披露值，由
      `content/knowledge/hot-interviews/bytedance-*.md` 的来源清单负责，本探针**不写假断言**。
  ✗ Java 的 long 溢出 / 无符号右移、MySQL 三值逻辑、Spark 会话时区的**语义**：
      只能由容器矩阵证明，这里只是"Python 侧对齐"。

用法：
    python scripts/bank/drafts/bytedance/probe_naive.py [题库根目录]
默认题库根是 `content/questions`。第二个用途是破坏性验证：把某份题 JSON 复制到
临时目录、只改那一份，然后把临时目录当参数传进来（真题库一个字节都不动）。
"""
import glob
import importlib.util
import json
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 4)))
# 可选参数＝题库根（破坏性验证用：把要改的那份题 JSON 复制到临时目录再传进来，
# 真题库一个字节都不动）。默认仍是 content/questions。
BANK = (os.path.abspath(sys.argv[1]) if len(sys.argv) > 1
        else os.path.join(ROOT, 'content', 'questions'))

_spec = importlib.util.spec_from_file_location('bd_precheck', os.path.join(HERE, 'precheck.py'))
PRE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PRE)

# 草稿 key -> 入库 id。它坏了会立刻显形：precheck 里没这个 key 就 SystemExit。
KEY_TO_ID = {
    'alg-bd-ab-orthogonal-buckets': 'alg-java-0046',
    'alg-bd-circuitbreaker': 'alg-java-0047',
    'alg-bd-config-rollout': 'alg-java-0048',
    'alg-bd-retry-decision': 'alg-java-0049',
    'alg-bd-server-limiter': 'alg-java-0050',
    'alg-bd-weighted-round-robin': 'alg-java-0051',
    'bd-bd-consumer-lag-readiness': 'bd-pyspark-0020',
    'bd-bd-point-in-time-features': 'bd-pyspark-0021',
    'bd-bd-tracking-lineage-retire': 'bd-pyspark-0022',
    'fe-bd-ab-report-verdict': 'fe-react-0020',
    'fe-bd-event-metadata-view': 'fe-react-0021',
}

FAILURES = []
MEASURED = []
SKIPS = []
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


CN = {'一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
NUMC = r'[一二两三四五六七八九十\\d]'   # 文案里的数量词：中文数字与阿拉伯数字都要认


def SP(lit):
    r"""把模式里的空格换成 `\s+`。

    这批答案里混着全角空格（U+3000）与 NBSP，逐条手写 `\s` 一定会漏 ——
    第一版就是被"，偏差 10350"里那个全角空格打成"抠不到"的。用 `\s*` 而不是 `\s+`：
    文案里的空格只是排版，"四条请求"和"四 条请求"都该认。
    判据强度没有变松 —— 数字与词仍然必须原样命中。
    """
    return re.sub(r' +', r'\\s*', lit)


def _num(token):
    """文案里的数可能是阿拉伯数字，也可能是"五行/四个"；负号可能是 ASCII 的也可能是 −。"""
    token = str(token).strip().replace('−', '-').replace('–', '-')
    if token in CN:
        return CN[token]
    return token


def eqatom(got, said):
    said = _num(said)
    if isinstance(got, bool):
        return ('true' if got else 'false') == str(said).strip().lower()
    if got is None:
        return str(said).strip().upper() in ('NULL', 'NONE', 'NIL', 'NIL')
    try:
        return abs(float(Decimal(str(got))) - float(Decimal(said))) < 1e-9
    except Exception:
        return str(got).strip() == str(said).strip()


def eqseq(got, said):
    """逐项比。长度不等直接 False —— "文案点了六个数、数据只有五个"正是要抓的形态。"""
    if len(got) != len(said):
        return False
    return all(eqatom(g, s) for g, s in zip(got, said))


def record(claim, got, said, ok):
    MEASURED.append('  %s  %s: 量到 %s，文案写 %s' % ('ok  ' if ok else 'FAIL', claim, got, said))
    if not ok:
        FAILURES.append('%s: 文案写 %s，实际量到 %s' % (claim, said, got))


def check(claim, measured, text, pattern, label, group=1):
    """量到的值 vs 文案里写的那个数；正则抠不到也算 FAIL（脱钩不许看起来像通过）。"""
    m = re.search(SP(pattern), text, re.S)
    if not m:
        FAILURES.append('%s: 文案里找不到 /%s/ —— 这句话被改写了，探针得跟着改' % (label, pattern))
        return
    said = m.group(group)
    record(claim, measured, said, eqatom(measured, said))


def check_seq(claim, measured, text, pattern, label, group=1, sep=None):
    m = re.search(SP(pattern), text, re.S)
    if not m:
        FAILURES.append('%s: 文案里找不到 /%s/ —— 这句话被改写了，探针得跟着改' % (label, pattern))
        return None
    raw = m.group(group)
    said = [x for x in (raw.split(sep) if sep else re.findall(r'-?\d+', raw))]
    said = [x.strip().strip('`*') for x in said if x.strip()]
    record(claim, measured, said, eqseq(measured, said))
    return said


def need(text, pattern, label, why='这句话被改写了，探针得跟着改'):
    m = re.search(SP(pattern), text, re.S)
    if not m:
        FAILURES.append('%s: 文案里找不到 /%s/ —— %s' % (label, pattern, why))
    return m


def named(q, prefix, label):
    for c in q['cases']:
        if prefix in c['name'] or c['name'] in prefix:
            return c
    raise SystemExit('%s: 找不到用例「%s」—— 用例名改了，探针得跟着改' % (label, prefix))


def case_rows(case):
    """mysql 的 expected → [dict]（列名来自 expected.columns）；空集/非表格 → []。"""
    exp = case['expected']
    if not isinstance(exp, dict) or 'rows' not in exp:
        return []
    cols = exp['columns']
    return [dict(zip(cols, r)) for r in exp['rows']]


def rows_at(q, i):
    return case_rows(q['cases'][i])


# ==================================================== 通用：从题面数据里量数
VALUE_TUPLE_RE = re.compile(r"\(([^()]*)\)")


def split_values(inner):
    """拆一条 `INSERT ... VALUES` 的元组：本批用得到的 数字 / 单引号串 / NULL。"""
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
    """按逗号切，但括号内的逗号不算分隔（`VARCHAR(16)` 会被切成两半的那种）。"""
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
        s = ' '.join(str(stmt).split())
        cm = re.match(r'CREATE TABLE (\w+) \((.*)\)(?: ENGINE.*)?$', s)
        if cm:
            cols = []
            for part in _split_top(cm.group(2)):
                fm = re.match(r'(\w+)\s+(?:INT|BIGINT|SMALLINT|TINYINT|DECIMAL|VARCHAR|CHAR|TEXT'
                              r'|DATE|DATETIME|TIMESTAMP|JSON|DOUBLE|FLOAT)\b', part, re.I)
                if fm:
                    cols.append(fm.group(1))
            tables[cm.group(1)] = {'cols': cols, 'rows': []}
            continue
        im = re.match(r'INSERT INTO (\w+)(?: \([^)]*\))? VALUES (.*)$', s)
        if im and im.group(1) in tables:
            cols = tables[im.group(1)]['cols']
            for tup in VALUE_TUPLE_RE.finditer(im.group(2)):
                pieces = split_values(tup.group(1))
                if len(pieces) == len(cols):
                    tables[im.group(1)]['rows'].append(dict(zip(cols, pieces)))
    return tables


def apply_changes(tables, changes):
    """把 `case.input` 里的 UPDATE / INSERT / DELETE 打在种子副本上（表名与列名都从种子里来）。"""
    import copy
    t = copy.deepcopy(tables)
    for stmt in changes or []:
        s = ' '.join(str(stmt).split())
        m = re.match(r'INSERT INTO (\w+) VALUES (.*)$', s)
        if m:
            cols = t[m.group(1)]['cols']
            for tup in VALUE_TUPLE_RE.finditer(m.group(2)):
                pieces = split_values(tup.group(1))
                if len(pieces) == len(cols):
                    t[m.group(1)]['rows'].append(dict(zip(cols, pieces)))
            continue
        m = re.match(r'DELETE FROM (\w+)(?: WHERE (.*))?$', s)
        if m:
            t[m.group(1)]['rows'] = [r for r in t[m.group(1)]['rows']
                                     if not _where_hit(r, m.group(2))]
            continue
        m = re.match(r'UPDATE (\w+) SET (.*) WHERE (.*)$', s)
        if m:
            sets = {}
            for part in _split_top(m.group(2)):
                k, _, v = part.partition('=')
                sets[k.strip()] = _lit(v.strip())
            for r in t[m.group(1)]['rows']:
                if _where_hit(r, m.group(3)):
                    r.update(sets)
            continue
        raise SystemExit('不认得这条用例变更：%s（写法变了，探针得跟着改）' % s)
    return t


def _where_hit(row, cond):
    if not cond:
        return True
    out = True
    for part in re.split(r'\s+AND\s+', cond):
        m = re.match(r"(\w+)\s*(=|<>|>=|<=|>|<)\s*(.+)$", part.strip())
        if not m:
            raise SystemExit('不认得这个 WHERE 条件：%s' % part)
        col, op, lit = m.group(1), m.group(2), _lit(m.group(3).strip())
        val = row.get(col)
        hit = {'=': val == lit, '<>': val != lit, '>': val > lit, '<': val < lit,
               '>=': val >= lit, '<=': val <= lit}[op]
        out = out and hit
    return out


# ================================================== 类别 1：独立重写打在已入库那份上
def probe_precheck_backed():
    for key, qid in sorted(KEY_TO_ID.items()):
        model = PRE.MODELS.get(key)
        if model is None:
            FAILURES.append('precheck.py 里没有 %s 的独立重写（KEY_TO_ID 与它脱钩了）' % key)
            continue
        bank = load(qid)
        kind = bank['judgeKind']
        bad, detail = 0, ''
        for i, c in enumerate(bank['cases']):
            raw = c['input']
            args = (raw['rows'],) if kind == 'pyspark' else tuple(raw)
            try:
                got, raised = model(*args), None
            except PRE.Bail as exc:
                got, raised = None, exc.message
            except Exception as exc:                              # noqa: BLE001
                got, raised = None, 'EXC %s: %s' % (type(exc).__name__, exc)
            if c.get('expectThrow'):
                want = c.get('throwMessage')
                if raised is None or (want and raised != want):
                    bad += 1
                    detail = '用例 %d「%s」声明抛 "%s"，实际 "%s"' % (i + 1, c['name'], want, raised)
                continue
            if raised is not None:
                bad += 1
                detail = '用例 %d「%s」没声明抛错，实际 "%s"' % (i + 1, c['name'], raised)
                continue
            if not PRE.same(got, c['expected']):
                bad += 1
                detail = '用例 %d「%s」expected=%s 重写给出=%s' % (i + 1, c['name'],
                                                                json.dumps(c['expected'], ensure_ascii=False)[:80],
                                                                json.dumps(got, ensure_ascii=False)[:80])
        record('%s ← 独立重写 %s' % (qid, key),
               '%d/%d 个用例一致' % (len(bank['cases']) - bad, len(bank['cases'])),
               '%d 个用例全一致' % len(bank['cases']), bad == 0)
        if bad:
            FAILURES.append('%s: 独立重写与已入库 expected 不一致：%s' % (qid, detail))


# ================================================== 类别 1 的通用文案回判：入参/返回向量
def vec_claim(q, text, label, min_hits):
    """答案里 "**`[入参]` … 给出/⇒ `[部分结果]`**" 这类声明。

    先拿 `[入参]` 去 case.input 里定位是哪一条用例（定位不到就 FAIL ——
    这说明文案引用的那条用例已经不在了），再把后面那个向量回判到 expected 的前缀上。
    """
    hits = 0
    for m in re.finditer(r'`\[([0-9, -]+)\]`[^。；\n]{0,80}?(?:给出|⇒|->|返回)\s*`?\[([0-9, -]+)\]`?',
                         text):
        want_in = [int(x) for x in m.group(1).split(',') if x.strip() != '']
        want_out = [int(x) for x in m.group(2).split(',') if x.strip() != '']
        case = None
        for c in q['cases']:
            if isinstance(c['input'], list) and _flat(c['input']) == want_in:
                case = c
                break
        if case is None:
            FAILURES.append('%s: 文案引用入参 %s，但没有任何用例的 input 是它 —— 数据变了' % (label, want_in))
            continue
        exp = case['expected']
        if not isinstance(exp, list):
            continue
        hits += 1
        head = exp[:len(want_out)]
        ok = head == want_out
        record('%s 入参 %s 的结果向量' % (label, want_in), head, want_out, ok)
    if hits < min_hits:
        FAILURES.append('%s: 只回判到 %d 条"入参向量 ⇒ 结果向量"（应 ≥%d）—— 文案写法变了' % (
            label, hits, min_hits))


def _flat(x):
    out = []
    for v in x:
        out.extend(_flat(v) if isinstance(v, list) else [v])
    return out


def braced_claim(q, text, pattern, claim, label, idx=None):
    """`返回 `{6, 2, 1, 2}`` 这类花括号向量 → 回判到某条用例的 expected。"""
    m = re.search(pattern, text, re.S)
    if not m:
        FAILURES.append('%s: 文案里找不到 /%s/' % (label, pattern))
        return None
    want = [int(x) for x in m.group(1).split(',') if x.strip() != '']
    case = q['cases'][idx] if idx is not None else None
    if case is None:
        for c in q['cases']:
            if isinstance(c['expected'], list) and c['expected'] == want:
                case = c
                break
        if case is None:
            case = q['cases'][0]
    got = case['expected']
    record(claim, got, want, got == want)
    return want


# ================================================== 逐题
def probe_ab_buckets():
    q = load('alg-java-0046')
    ans, label = q['answer'], 'alg-java-0046'
    vec_claim(q, ans, label, 2)
    base = q['cases'][0]
    check('基线四格合计', sum(base['expected'][:4]), ans, r'实测四格合计 (\d+)', label)
    check('基线期望每格', base['input'][3] // (base['input'][2] ** 2), ans, r'期望每格 (\d+) 人', label)
    mb = re.search(r'最大偏差在\*\*千分位量级\*\*（万分比(几)百）', ans)
    if not mb:
        FAILURES.append('%s: 抠不到"最大偏差在千分位量级（万分比几百）"那句' % label)
    else:
        d = base['expected'][-1]
        record('基线偏差落在"万分比几百"这一档', d, '100 ≤ 偏差 < 1000', 100 <= d < 1000)
    # 同 salt 那条：偏差那条除法
    same = named(q, 'salt 相同时两层流量完全重叠', label)
    cells = same['expected'][:4]
    m = need(ans, r'\|(\d+) \* (\d+) - (\d+)\| \* (\d+) / (\d+) = (\d+)', label,
             '"对角两格吃掉全部 N 人"那条算式没抠到）')
    if m:
        said = [int(m.group(i)) for i in range(1, 7)]
        got = [max(cells), same['input'][2] ** 2, same['input'][3], 10000, same['input'][3],
               abs(max(cells) * same['input'][2] ** 2 - same['input'][3]) * 10000 // same['input'][3]]
        record('同 salt 的偏差算式', got, said, got == said)
    check('同 salt 的偏差', same['expected'][-1], ans, r'，偏差 (\d+)。\*{0,2} 期望每格', label)
    record('同 salt 非对角两格恒为 0', len([c for c in cells if c == 0]), '2',
           len([c for c in cells if c == 0]) == 2)
    # 用例名的承诺：4 桶 ⇒ 16 格
    fine = named(q, '加细粒度', label)
    check('4 桶两层的格子数', fine['input'][2] ** 2, fine['name'], r'(\d+) 格 \+ 偏差', label)
    record('细粒度那条出 16 格 + 1 个偏差', len(fine['expected']), '17', len(fine['expected']) == 17)
    one = named(q, '桶数取 1', label)
    record('单桶那条只有一个格子', len(one['expected']), '2', len(one['expected']) == 2)
    zero = named(q, '零个用户', label)
    record('零用户那条全零', zero['expected'], '全 0', all(v == 0 for v in zero['expected']))


def probe_breaker():
    q = load('alg-java-0047')
    ans, label = q['answer'], 'alg-java-0047'
    base = q['cases'][0]
    m = need(ans, r'基线用例 `minSample=(\d+) / 阈值 (\d+) / 冷却 (\d+) / 探测 (\d+) / '
                 r'事件 \[([01, ]+)\]`', label)
    if m:
        said = [int(m.group(i)) for i in range(1, 5)] + [int(x) for x in m.group(5).split(',')]
        got = base['input'][:4] + base['input'][4]
        record('基线入参五个部分', got, said, got == said)
        n_min = int(m.group(1))
        head = base['input'][4][:n_min]
        record('基线前 %d 条全错' % n_min, sum(head), n_min, sum(head) == n_min)
        record('满样本那 %d 条的万分比' % n_min, sum(head) * 10000 // n_min, 10000,
               sum(head) * 10000 // n_min == 10000)
        mr = re.search(r'第 (\d+)、(\d+) 条被拒', ans)
        if not mr:
            FAILURES.append('%s: 抠不到"第 N、M 条被拒"那句' % label)
        else:
            a, b = int(mr.group(1)), int(mr.group(2))
            got = [b - a + 1, a > n_min, base['expected'][1]]
            record('被拒的是第 %d、%d 条（共 %d 条，且都在门槛之后）' % (a, b, b - a + 1),
                   got, [base['expected'][1], True, base['expected'][1]],
                   got == [base['expected'][1], True, base['expected'][1]])
    braced_claim(q, ans, r'所以返回 `\{([0-9, ]+)\}`', '基线返回四个计数', label, idx=0)
    mm = re.search(r'放行 (\d+)、拒绝 (\d+)、打开 (\d+) 次', ans)
    if not mm:
        FAILURES.append('%s: 抠不到"放行 / 拒绝 / 打开"那句' % label)
    else:
        got = base['expected'][:3]
        record('基线三个计数', got, [int(mm.group(i)) for i in range(1, 4)],
               got == [int(mm.group(i)) for i in range(1, 4)])
        record('终态是半开', base['expected'][3], '2', base['expected'][3] == 2)
    low = named(q, '样本数不足 minSample', label)
    m = need(ans, r'边界用例（`minSample=(\d+)`、(\d+) 条全错）返回 `\{([0-9, ]+)\}`', label)
    if m:
        got = [low['input'][0], len(low['input'][4]), low['expected']]
        said = [int(m.group(1)), int(m.group(2)), [int(x) for x in m.group(3).split(',')]]
        record('低峰那条', got, said, got == said)
    eq = named(q, '阈值恰好相等即打开', label)
    m = need(ans, r'`minSample=(\d+) / 冷却 (\d+) / \[([01, ]*?)\.{3}\]` 在第 (\d+) 条结束时'
                 r'是 (\d+) 个样本里 (\d+) 个失败，\n?万分比恰好 (\d+)', label)
    if m:
        n_th = int(m.group(4))
        head = eq['input'][4][:n_th]
        got = [eq['input'][0], eq['input'][2], head, sum(head), len(head),
               sum(head) * 10000 // len(head)]
        said = [int(m.group(1)), int(m.group(2)),
                [int(x) for x in m.group(3).split(',') if x.strip()],
                int(m.group(6)), int(m.group(5)), int(m.group(7))]
        record('阈值相等那条', got, said, got == said)
    twice = named(q, '半开窗口内再次越界', label)
    check('openEvents 记 2', twice['expected'][2], twice['name'], r'openEvents 记 (\d+)', label)
    cool0 = named(q, '冷却为 0', label)
    check('冷却为 0 那条的 cooldown', 0, cool0['name'], r'退化：冷却为 (\d+)', label)
    record('冷却为 0 ⇒ 不产生拒绝', cool0['expected'][1], '0', cool0['expected'][1] == 0)
    empty = named(q, '空事件流', label)
    record('空事件流 ⇒ 四个计数全 0', empty['expected'], '[0,0,0,0]', empty['expected'] == [0, 0, 0, 0])
    all0 = named(q, '整段全对', label)
    record('整段全对那条放行数 = 事件数', all0['expected'][0], len(all0['input'][4]),
           all0['expected'][0] == len(all0['input'][4]))


def probe_config_rollout():
    q = load('alg-java-0048')
    ans, label = q['answer'], 'alg-java-0048'
    base = q['cases'][0]
    m = need(ans, r'基线 `\[(\d+), (\d+), 四条推送\]`', label)
    if m:
        got = [base['input'][0], base['input'][1], len(base['input'][2])]
        said = [int(m.group(1)), int(m.group(2)), 4]
        record('基线入参', got, said, got == said)
    braced_claim(q, ans, r'⇒ 返回 `\{([0-9, ]+)\}`', '基线返回八个计数', label, idx=0)
    m = need(ans, r'`(\d+)/(\d+) = (\d+)bps >= (\d+)bps`', label, '"8/10 = 8000bps" 那条除法')
    if m:
        push = base['input'][2][2]
        got = [push[4], push[5], push[4] * 10000 // push[5], base['input'][0]]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('回退窗口的失败率式子', got, said, got == said)
    for frag, pat in (('版本号递增但内容哈希没变', r'内容哈希没变」\s*⇒ `\{([0-9, ]+)\}`'),
                      ('样本不足时不许回退', r'样本不足时不许回退」\s*⇒ `\{([0-9, ]+)\}`'),
                      ('非法配置要在比对之前挡掉', r'非法配置要在比对之前挡掉」\s*⇒ `\{([0-9, ]+)\}`')):
        c = named(q, frag, label)
        m = need(ans, pat, label)
        if m:
            want = [int(x) for x in m.group(1).split(',')]
            record('用例「%s」的返回' % frag, c['expected'], want, c['expected'] == want)
    c = named(q, '版本号递增但内容哈希没变', label)
    m = need(ans, r'版本 (\d+)→(\d+) 递增、内容完全相同', label)
    if m:
        p = c['input'][2]
        got = [p[0][0], p[1][0], p[0][1] == p[1][1]]
        record('版本递增而哈希相同', got, [int(m.group(1)), int(m.group(2)), True],
               got == [int(m.group(1)), int(m.group(2)), True])
        record('skippedNoDiff 那一格', c['expected'][4], '1', c['expected'][4] == 1)
    c = named(q, '样本不足时不许回退', label)
    m = need(ans, r'`minSample=(\d+)` 而窗口只有 (\d+) 次 ⇒ (\d+) 个失败（(\d+)% 错误率）也不回退', label)
    if m:
        p = c['input'][2][-1]
        got = [c['input'][1], p[5], p[4], p[4] * 100 // p[5]]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('样本不足那条', got, said, got == said)
    c = named(q, '一次推送都没有', label)
    check('空推送 ⇒ 八个计数全零', len([v for v in c['expected'] if v == 0]), c['name'],
          r'([一二三四五六七八\d]+)个计数全零', label)
    m = re.search(r'基线用例给出 `\{([0-9, ]+)\}`', ans)
    if not m:
        FAILURES.append('%s: 抠不到"朴素解在基线给出 …"那句' % label)
    else:
        naive = [int(x) for x in m.group(1).split(',')]
        zeroed = [i for i, v in enumerate(naive) if v == 0]
        live = [i for i in zeroed if base['expected'][i] != 0]
        record('朴素解写零的格子里真答案非零', len(live), '>0', len(live) > 0)


def probe_retry():
    q = load('alg-java-0049')
    ans, label = q['answer'], 'alg-java-0049'
    # 参数位置（与 precheck 的 m_retry 签名一致，题面契约）：
    # 0 rpc, 1 max_retries, 2 max_duration, 3 cbps, 4 bps, 5 chain_stop, 6 upstream_retry,
    # 7 same_node, 8 streaming, 9 idempotent, 10 elapsed, 11 attempts, 12 err, 13 last, 14 cand
    clamp = named(q, 'maxDuration 超过 rpcTimeout', label)
    m = need(ans, r'`rpc=(\d+), retries=(\d+)` ⇒ `ceiling = (\d+) \* (\d+) = (\d+)`；配的 '
                 r'`maxDuration=(\d+)` 越界', label)
    if m:
        got = [clamp['input'][0], clamp['input'][1], clamp['input'][0],
               clamp['input'][1] + 1, clamp['input'][0] * (clamp['input'][1] + 1), clamp['input'][2]]
        said = [int(m.group(i)) for i in range(1, 7)]
        record('钳制上界那条', got, said, got == said)
    m = need(ans, r'有效预算压到 (\d+)，`elapsed=(\d+) < (\d+)` ⇒\s*仍走满整条链，最后返回\s*`CLAMPED\|RETRY`', label)
    if m:
        got = [clamp['input'][0] * (clamp['input'][1] + 1), clamp['input'][10],
               clamp['input'][0] * (clamp['input'][1] + 1)]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('压到上界之后', got, said, got == said and clamp['expected'] == 'CLAMPED|RETRY')
    eq = named(q, '耗时恰好等于有效预算', label)
    m = need(ans, r'用例「耗时恰好等于有效预算即停止」里 `elapsed=(\d+), 有效预算=(\d+)`', label)
    if m:
        dur = eq['input'][2]
        budget = min(eq['input'][0] * (eq['input'][1] + 1), max(eq['input'][0] + 1, dur))
        got = [eq['input'][10], budget]
        said = [int(m.group(1)), int(m.group(2))]
        record('预算相等那条', got, said, got == said and eq['expected'] == 'STOP_BUDGET')
    chain = named(q, '上游已经是重试请求', label)
    record('ChainStop 那条判到 STOP_CHAIN', chain['expected'], '"不重试"里的 STOP_CHAIN',
           chain['expected'] == 'STOP_CHAIN')
    record('但它次数还没用完（所以换顺序才会误判 STOP_TRIES）',
           [chain['input'][11], chain['input'][1]], 'attempts < maxRetryTimes',
           chain['input'][11] < chain['input'][1])
    tries = named(q, '重试次数用完', label)
    record('attemptsDone 恰好等于 maxRetryTimes', [tries['input'][11], tries['input'][1]],
           '相等 ⇒ STOP_TRIES', tries['input'][11] == tries['input'][1] and tries['expected'] == 'STOP_TRIES')
    off = named(q, 'maxRetryTimes=0', label)
    check('关掉重试那条的 maxRetryTimes', off['input'][1], off['name'], r'maxRetryTimes=(\d+) 就是关掉重试', label)
    bad = named(q, '重试次数超出官方合法域', label)
    m = need(text_of(q), r'合法域 0-(\d+)', label)
    if m:
        record('越界的那条确实在合法域之外', bad['input'][1], '>%s' % m.group(1),
               bad['input'][1] > int(m.group(1)))
    cb = named(q, 'cbPolicy 超过官方上限', label)
    m = need(q['statement'] + ans, r'\(0,\s*(\d+)%\]', label)
    if m:
        record('cbPolicy 越界那条超过的就是这个上限', cb['input'][3], '>%s%%' % m.group(1),
               cb['input'][3] > int(m.group(1)) * 100)
    same_node = named(q, 'RetrySameNode=false', label)
    record('同实例不许重试两次：候选就是上一个', [same_node['input'][13], same_node['input'][14]],
           'last == cand ⇒ STOP_SAME_NODE',
           same_node['input'][13] == same_node['input'][14] and same_node['expected'] == 'STOP_SAME_NODE')


def probe_limiter():
    q = load('alg-java-0050')
    ans, label = q['answer'], 'alg-java-0050'
    base = q['cases'][0]
    m = need(ans, r'基线用例 `\{(\d+), (\d+), (\d+), \[([0-9, ]+)\], \[([0-9, ]+)\]', label)
    if m:
        got = [base['input'][0], base['input'][1], base['input'][2],
               base['input'][3], base['input'][4]]
        said = [int(m.group(1)), int(m.group(2)), int(m.group(3)),
                [int(x) for x in m.group(4).split(',') if x.strip()],
                [int(x) for x in m.group(5).split(',') if x.strip()]]
        record('基线入参', got, said, got == said)
    braced_claim(q, ans, r'⇒ `\{([0-9, ]+)\}`。两个拒因各出现一次', '基线返回四个数', label, idx=0)
    record('两个拒因各出现一次', base['expected'][1:3], '各 1 次', base['expected'][1] == 1 and base['expected'][2] == 1)
    record('第 3 条到达时刻', base['input'][3][2], '40', base['input'][3][2] == 40)
    order = named(q, '连接数先于 QPS 拒绝', label)
    m = need(ans, r'`qps=(\d+) / burst=(\d+) / maxConn=(\d+)`，([一二两三四五六七八九十\d]+)条请求都落在 (\d+)ms 内 ⇒\s*'
                 r'只放行 (\d+) 条、([一二两三四五六七八九十\d]+) 条全被连接数拒，剩余令牌是 .(\d+).', label)
    if m:
        got = [order['input'][0], order['input'][1], order['input'][2],
               len(order['input'][3]), max(order['input'][3]) - min(order['input'][3]),
               order['expected'][0], order['expected'][2], order['expected'][3]]
        said = [int(m.group(1)), int(m.group(2)), int(m.group(3)), int(_num(m.group(4))),
                int(m.group(5)), int(m.group(6)), int(_num(m.group(7))), int(m.group(8))]
        record('检查顺序那条', got, said, got == said)
    grpc = named(q, '协议盲区', label)
    braced_claim(q, ans, r'只差最后一位标志 ⇒ `\{([0-9, ]+)\}`', 'gRPC 那条返回', label,
                 idx=q['cases'].index(grpc))
    diff = [i for i in range(len(base['input'][5])) if base['input'][5][i] != grpc['input'][5][i]]
    record('与基线只差最后一位标志', diff, '[4]', diff == [4])
    cap1 = named(q, '桶容量 1', label)
    m = need(ans, r'在「边界：桶容量 (\d+)」上它会把 (\d+) 条全放行（`qps=(\d+)`', label)
    if m:
        got = [cap1['input'][1], len(cap1['input'][3]), cap1['input'][0]]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('桶容量 1 那条', got, said, got == said)
    idle = named(q, '桶有上限', label)
    m = need(ans, r'`qps=(\d+) / burst=(\d+)`，两条请求之间隔了 (\d+) 秒', label)
    if m:
        gap_ms = idle['input'][3][1] - idle['input'][3][0]
        got = [idle['input'][0], idle['input'][1], gap_ms // 1000]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('桶有上限那条', got, said, got == said)
    m = re.search(r'放行第二条之后剩\s*(\d+) ⇒ `\{([0-9, ]+)\}`', ans)
    if not m:
        FAILURES.append('%s: 抠不到"放行第二条之后剩 N"那句' % label)
    else:
        want = [int(x) for x in m.group(2).split(',')]
        record('桶有上限那条的返回', idle['expected'], want, idle['expected'] == want)
        record('剩余令牌', idle['expected'][3], m.group(1), idle['expected'][3] == int(m.group(1)))
    empty = named(q, '空到达序列', label)
    record('空序列 ⇒ 令牌原封不动是 burst', [empty['input'][3], empty['input'][1], empty['expected'][3]],
           '[] / burst / burst', empty['input'][3] == [] and empty['expected'][3] == empty['input'][1])


def probe_wrr():
    q = load('alg-java-0051')
    ans, label = q['answer'], 'alg-java-0051'
    # 文案形式：`[权重...]` 选 N 次 ⇒ "序列|计数"
    hits = 0
    for m in re.finditer(r'`\[([0-9, ]+)\]`\s*选\s*(\d+)\s*次\s*⇒\s*`"([^"|]+)\|([^"]+)"`', ans):
        w = [int(x) for x in m.group(1).split(',') if x.strip()]
        picks = int(m.group(2))
        seq = [int(x) for x in m.group(3).split(',') if x.strip()]
        cnt = [int(x) for x in m.group(4).split(',') if x.strip()]
        case = next((c for c in q['cases'] if c['input'][0] == w and c['input'][1] == picks), None)
        if case is None:
            FAILURES.append('%s: 文案引用权重 %s 选 %d 次，但没有这样一条用例' % (label, w, picks))
            continue
        hits += 1
        got_seq = [int(x) for x in case['expected'].split('|')[0].split(',')]
        got_cnt = [int(x) for x in case['expected'].split('|')[1].split(',')]
        record('权重 %s 选 %d 次的序列' % (w, picks), got_seq, seq, got_seq == seq)
        record('权重 %s 选 %d 次的计数' % (w, picks), got_cnt, cnt, got_cnt == cnt)
    if hits < 4:
        FAILURES.append('%s: 只回判到 %d 条"权重选 N 次 ⇒ 序列|计数"（答案写了 5 条以上）' % (label, hits))
    base = q['cases'][0]
    record('基线"去掉平局规则计数仍是 2,2,2"', base['expected'].split('|')[1], '2,2,2',
           base['expected'].split('|')[1] == '2,2,2')
    un = named(q, '公约数 2:4', label)
    m = need(ans, r'权重和 (\d+)、gcd (\d+) ⇒ 最小正周期长度只有 (\d+)（`(\d+) / (\d+)`）', label)
    if m:
        import math
        w = un['input'][0]
        got = [sum(w), math.gcd(*w), sum(w) // math.gcd(*w), sum(w), math.gcd(*w)]
        said = [int(m.group(i)) for i in range(1, 6)]
        record('2:4 的周期那条', got, said, got == said)
        seq = [int(x) for x in un['expected'].split('|')[0].split(',')]
        period = seq[:sum(w) // math.gcd(*w)]
        record('序列是 %s 重复两遍' % period, seq, '周期 %s × 2' % period,
               seq == period * (len(seq) // len(period)) and len(seq) % len(period) == 0)
    ext = named(q, '权重差 100 倍', label)
    m = need(ans, r'极端 `\[(\d+),(\d+)\]`', label)
    if m:
        got = ext['input'][0]
        said = [int(m.group(1)), int(m.group(2))]
        record('权重差那条', got, said, got == said)
    m = need(ext['name'] + ans, r'连续 (\d+) 次全打同一个实例', label)
    if m:
        seq = [int(x) for x in ext['expected'].split('|')[0].split(',')]
        run = 1
        for a, b in zip(seq, seq[1:]):
            run = run + 1 if a == b else 1
        record('最长连打', run, m.group(1), run == int(m.group(1)))
    odd = named(q, '等权重奇数次', label)
    c0, c1 = [int(x) for x in odd['expected'].split('|')[1].split(',')]
    record('先选的那个多一次', [c0, c1], '多 1', c0 == c1 + 1)
    zero = named(q, '权重含 0', label)
    m = re.search(r'`\[(\d+), (\d+)\]` 必须抛错', ans)
    if not m:
        FAILURES.append('%s: 抠不到"[a, 0] 必须抛错"那句' % label)
    else:
        got = zero['input'][0]
        said = [int(m.group(1)), int(m.group(2))]
        record('权重含 0 的那条入参', got, said, got == said)
        record('题面上限（选取次数）', q['cases'][10]['input'][1], '>1000', q['cases'][10]['input'][1] > 1000)


def probe_report_verdict():
    q = load('fe-react-0020')
    ans, label = q['answer'], 'fe-react-0020'
    off = named(q, '官方口径：进组 48.7% vs 预设 50%', label)
    inp = off['input'][0]
    m = need(ans, r'算出来是 (\d+) 万分比（([\d.]+)%）', label)
    if m:
        dev = int(abs(inp['actualSplitBps'] - inp['expectedSplitBps']) * 10000 / inp['expectedSplitBps'])
        got = [dev, off['expected']['splitDeviationBps']]
        said = [int(m.group(1)), dev]
        record('官方例子的相对偏离', got, said, got == said)
    record('绝对差 130 万分比', abs(inp['actualSplitBps'] - inp['expectedSplitBps']), '130',
           abs(inp['actualSplitBps'] - inp['expectedSplitBps']) == 130)
    m = need(ans, r'的期望是\s*`verdict=.([a-z-]+).`', label)
    if m:
        record('官方例子的 verdict', off['expected']['verdict'], m.group(1),
               off['expected']['verdict'] == m.group(1))
    srm = named(q, 'SRM 优先于一切解释', label)
    m = need(ans, r'用例「SRM 优先于一切解释」的 `liftBps=(\d+)`（\+([\d.]+)%）', label)
    if m:
        got = [srm['input'][0]['liftBps'], srm['expected']['liftBps'],
               srm['input'][0]['liftBps'] / 100.0]
        said = [int(m.group(1)), int(m.group(1)), float(m.group(2))]
        record('SRM 那条透传的 liftBps', got, said, got == said)
    m = need(ans, r'headline. 是"进组比例偏离预设\s*([\d.]+)%，结论不成立"', label)
    if m:
        dev_bps = srm['expected']['splitDeviationBps']
        record('SRM 那条的 headline 百分比', dev_bps / 100.0, float(m.group(1)),
               abs(dev_bps / 100.0 - float(m.group(1))) < 1e-9
               and re.sub(r'\s+', '', '进组比例偏离预设%s%%，结论不成立' % m.group(1))
               in re.sub(r'\s+', '', srm['expected']['headline']))
    m = need(off['name'], r'未越 (\d+) 线', label)
    if m:
        line = int(m.group(1))
        record('SRM 判废线两侧的两条用例', [off['expected']['splitDeviationBps'] < line,
                                        srm['expected']['splitDeviationBps'] >= line,
                                        off['expected']['blockers'], srm['expected']['blockers']],
               '[True, True, [], [SRM]]',
               [off['expected']['splitDeviationBps'] < line, srm['expected']['splitDeviationBps'] >= line,
                off['expected']['blockers'], srm['expected']['blockers']]
               == [True, True, [], ['SRM']])
    day1 = named(q, '实验第 1 天尚未 T-1', label)
    record('第 1 天不算 STALE', [day1['input'][0]['daysRunning'], 'STALE' in day1['expected']['blockers']],
           '1 / 不在', day1['input'][0]['daysRunning'] == 1 and 'STALE' not in day1['expected']['blockers'])
    stale = named(q, '实验已开到第 4 天', label)
    record('第 4 天未更新才判 STALE', [stale['input'][0]['daysRunning'], stale['expected']['blockers']],
           '[4, [STALE]]', stale['input'][0]['daysRunning'] == 4 and stale['expected']['blockers'] == ['STALE'])
    ns = named(q, '未达显著时不报 blockers 之外的坏消息', label)
    m = need(ans, r'`significant=(\w+), samplePerGroup=(\d+)` ⇒ `verdict=.([a-z-]+).`\s*\n?'
                 r"但 `blockers=\['([A-Z-]+)'\]`", label)
    if m:
        inp = ns['input'][0]
        got = [inp['significant'], inp['samplePerGroup'], ns['expected']['verdict'],
               ns['expected']['blockers'][0]]
        said = [m.group(1) == 'true', int(m.group(2)), m.group(3), m.group(4)]
        record('未达显著那条', got, said, got == said)
    sm = named(q, '样本数恰好等于 1000', label)
    m = need(sm['name'], r'样本数恰好等于 (\d+)', label)
    if m:
        got = sm['input'][0]['samplePerGroup']
        record('样本门槛那条的入参', got, m.group(1), got == int(m.group(1)))
        record('恰好到线就不算 LOW-SAMPLE', sm['expected']['blockers'], '[]',
               sm['expected']['blockers'] == [])
    watch = named(q, '显著但样本不足', label)
    record('差一个样本就进 watch', [watch['input'][0]['samplePerGroup'], watch['expected']['verdict']],
           '999 / watch', watch['input'][0]['samplePerGroup'] == 999 and watch['expected']['verdict'] == 'watch')
    n1 = named(q, '整份入参是 null', label)
    record('非法入参的抛错消息非空', bool(n1.get('throwMessage')), '有', bool(n1.get('throwMessage')))


def probe_event_view():
    q = load('fe-react-0021')
    ans, label = q['answer'], 'fe-react-0021'
    gap = named(q, '已验收但分析类型是热力图', label)
    m = need(ans, r'分析类型是热力图、全埋点未开」的期望是\s*\n?`state=.([a-z-]+).`、`bucket=.([a-z-]+).`、'
                 r'`action=(\w+)`、`countsInAcceptedList=(\w+)`', label)
    if m:
        exp = gap['expected']
        got = [exp['state'], exp['governanceBucket'], exp['action'], exp['countsInAcceptedList']]
        said = [m.group(1), m.group(2), None if m.group(3) == 'null' else m.group(3),
                m.group(4) == 'true']
        record('能力缺口那条的四个字段', got, said, got == said)
    dis = named(q, '被禁用的预置事件', label)
    m = need(ans, r'用例「边界：被禁用的预置事件」⇒ `state=.([a-z-]+).`、\s*\n?`action=.([a-z-]+).`', label)
    if m:
        got = [dis['expected']['state'], dis['expected']['action']]
        said = [m.group(1), m.group(2)]
        record('禁用的预置事件那条', got, said, got == said)
        record('disabled 确实优先于 preset', [dis['input'][0]['status'], dis['input'][0]['source']],
               'disabled + preset',
               dis['input'][0]['status'] == 'disabled' and dis['input'][0]['source'] == 'preset')
    lock = named(q, '待验收 + 无权限', label)
    m = need(ans, r"用例「待验收 \+ 无权限」期望 .tone='([a-z]+)'. 而\*\*不是\*\* .'([a-z]+)'.", label)
    if m:
        got = [lock['expected']['tone'], m.group(2) != lock['expected']['tone']]
        said = [m.group(1), True]
        record('无权限那条的 tone', got, said, got == said)
    acc = named(q, '待验收 + 有', label)
    record('有权限的那条 tone 才是 warn', [acc['expected']['tone'], lock['expected']['tone']],
           'warn / muted', acc['expected']['tone'] == 'warn' and lock['expected']['tone'] == 'muted')
    bad = [c['name'] for c in q['cases']
           if isinstance(c['expected'], dict) and c['expected']['label'] not in c['expected']['tooltip']]
    record('tooltip 跟随 label（%d 条用例）' % len([c for c in q['cases'] if isinstance(c['expected'], dict)]),
           bad, '没有一条脱钩', not bad)
    states = {c['expected']['state'] for c in q['cases'] if isinstance(c['expected'], dict)}
    record('capability-gap 这个 state 真有一条用例走到（量到的 state 全集）',
           sorted(states), '里面要有 capability-gap', 'capability-gap' in states)
    rej = named(q, '验收未通过', label)
    m = need(rej['name'], r'danger 但不进"([^"]+)"桶', label)
    if m:
        record('验收未通过那条的 tone', rej['expected']['tone'], 'danger', rej['expected']['tone'] == 'danger')
        record('它没被归进「%s」桶' % m.group(1), rej['expected']['governanceBucket'],
               '不是 %s' % m.group(1), m.group(1) not in rej['expected']['governanceBucket'])


def probe_pyspark_lag():
    q = load('bd-pyspark-0020')
    ans, label = q['answer'], 'bd-pyspark-0020'
    base = q['cases'][0]
    by_grp = {r['consumer_group']: r for r in base['expected']}
    in_by = {r['consumer_group']: r for r in base['input']['rows']}
    check('基线行数', len(base['expected']), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行的 ETA 逐个算\*\*', label)
    enum = need(base['name'], r'([一二两三四五六七八九十\d]+)类状态各一次（([^）]+)）', label)
    if enum:
        items = [x.strip() for x in enum.group(2).split('/')]
        record('用例名点名的状态种类数', len(items), '%s 类' % _num(enum.group(1)),
               len(items) == int(_num(enum.group(1))) == len(base['expected']))
        record('六种场景实际落成几种 status（健康与"边界相等"同为 healthy）',
               sorted({r['status'] for r in base['expected']}), '5 种',
               len({r['status'] for r in base['expected']}) == 5)
    tbl = re.findall(r'^\| (g-[a-z]+) \|(.*)$', ans, re.M)
    if len(tbl) != 6:
        FAILURES.append('%s: 基线那张表只抠到 %d 行（应当 6 行）—— 表格写法变了' % (label, len(tbl)))
    for grp, rest in tbl:
        cells = [c.strip() for c in rest.split('|') if c.strip()]
        r, i = by_grp[grp], in_by[grp]
        import math
        em = re.search(r'ceil\((\d+)\*(\d+)/(\d+)\)`? = (\d+)', cells[3])
        if em:
            # 与 gen.py/precheck 同一个"向上取整"的第三种写法：整式取负再整除
            got_eta = -((-int(em.group(1)) * int(em.group(2))) // int(em.group(3)))
            said_eta = int(em.group(4))
            formula = (int(em.group(1)), int(em.group(2)), int(em.group(3)))
        else:
            got_eta = said_eta = None if cells[3] == 'null' else int(cells[3])
            formula = None
        status_cell = cells[4]
        cond = status_cell.split('（')[1].rstrip('）') if '（' in status_cell else None
        got = [r['total_span'], r['consumed'], r['backlog'], r['eta_minutes'], r['status']]
        said = [int(cells[0]), int(cells[1]), int(_num(cells[2])), said_eta,
                status_cell.split('（')[0]]
        record('组 %s 那一行' % grp, got, said, got == said)
        # 式子里的三个乘数/除数必须就是这一行数据量出来的三个数
        if formula:
            real = (r['backlog'], i['window_minutes'], r['consumed'])
            record('组 %s 的 ETA 式三个数' % grp, real, formula, real == formula)
            record('组 %s 的 ETA 复算' % grp, got_eta, said_eta, got_eta == said_eta)
        if cond and re.search(r'-?\d+', cond):
            nums = re.findall(r'-?\d+', cond)
            op = '≤' if '≤' in cond else ('>' if '>' in cond else None)
            ok = bool(nums) and op and eqatom(r['eta_minutes'], nums[0]) and (
                (op == '≤' and r['eta_minutes'] <= int(nums[1]) and int(nums[1]) == i['sla_minutes'])
                or (op == '>' and r['eta_minutes'] > int(nums[1])))
            record('组 %s 的判据 %s' % (grp, cond), [r['eta_minutes'], i['sla_minutes']], cond, bool(ok))
    bad = by_grp['g-bad']
    record('g-bad 是唯一一行负 backlog', [g for g, r in by_grp.items() if r['backlog'] < 0],
           '只有 g-bad', [g for g, r in by_grp.items() if r['backlog'] < 0] == ['g-bad'])
    zero = q['cases'][1]
    m = need(ans, r'边界用例（三个 offset 全 (\d+)）', label)
    if m:
        r = zero['input']['rows'][0]
        got = [r['min_offset'], r['max_offset'], r['consumer_offset']]
        record('分区全空那条的三个位点', got, [int(m.group(1))] * 3,
               got == [int(m.group(1))] * 3 and zero['expected'][0]['status'] == 'complete')
    deg = q['cases'][2]
    m = need(ans, r'退化用例里第 (\d+) 行 `window_minutes=(\d+)`', label)
    if m:
        rows2 = deg['input']['rows']
        k = int(m.group(1)) - 1
        got = [rows2[k]['window_minutes'], rows2[k]['status'] if 'status' in rows2[k] else deg['expected'][k]['status']]
        said = [int(m.group(2)), 'invalid-position']
        record('窗口为 0 的那一行', got, said, got == said)


def probe_pyspark_pit():
    q = load('bd-pyspark-0021')
    ans, label = q['answer'], 'bd-pyspark-0021'
    base = q['cases'][0]
    m = need(ans, r'`sample_id` 的 `leak` 依次是\s*\n?`([^`]+)`', label)
    if m:
        said = [x.strip() for x in m.group(1).split('/')]
        got = [r['leak'] for r in base['expected']]
        record('基线六条样本的 leak 序列', got, said, got == said)
    kinds = sorted({r['leak'] for r in base['expected']})
    counts = {}
    for r in base['expected']:
        counts[r['leak']] = counts.get(r['leak'], 0) + 1
    m = need(base['name'], r'([一二两三四五六七八九十\d]+)条样本落在([一二两三四五六七八九十\d]+)类结局上'
                         r'（(\w+) 与 (\w+) 各([一二两三四五六七八九十\d]+)次）', label)
    if m:
        got = [len(base['expected']), len(kinds), counts.get(m.group(3), 0), counts.get(m.group(4), 0)]
        said = [int(_num(m.group(1))), int(_num(m.group(2))),
                int(_num(m.group(5))), int(_num(m.group(5)))]
        record('基线：样本数 / 结局种类数 / 点名那两类的条数', got, said, got == said)
        repeated = sorted(k for k, v in counts.items() if v > 1)
        record('重复出现的正是点名的那两类，其余各一次',
               [repeated, sorted(counts.values())],
               [sorted([m.group(3), m.group(4)]), [1] * (len(kinds) - 2) + [2] * 2],
               repeated == sorted([m.group(3), m.group(4)])
               and sorted(counts.values()) == sorted([1] * (len(kinds) - 2) + [2] * 2))
        record('逐条计数与样本数自洽', sum(counts.values()), len(base['expected']),
               sum(counts.values()) == len(base['expected']))
    leaks_in_contract = set(re.findall(r'`(none|overlap|future-value|stale-value|no-coverage)`',
                                       q['statement']))
    record('题面契约里声明的 leak 种类数', len(leaks_in_contract), '5', len(leaks_in_contract) == 5)
    record('基线里没出现 future-value（它只在边界用例出现）',
           'future-value' in kinds, '不出现', 'future-value' not in kinds)
    # 逐条样本：值与版本号都要能从 input 量到
    claims = re.findall(r's(\d) `[^`]*`[^。]*?值 (\d+)、版本 (\d+)', ans)
    if len(claims) < 4:
        FAILURES.append('%s: 只抠到 %d 条"值 N、版本 M"声明（答案逐条点名了 5 条）' % (label, len(claims)))
    bysid = {r['sample_id']: r for r in base['expected']}
    for sid, val, vno in claims:
        sid = int(sid)
        if sid not in bysid:
            FAILURES.append('%s: 文案点了 s%d 但基线没有这条样本' % (label, sid))
            continue
        got = [bysid[sid]['feature_value'], bysid[sid]['version_no']]
        record('样本 s%d 的值与版本' % sid, got, [int(val), int(vno)], got == [int(val), int(vno)])
    fut = q['cases'][1]
    m = need(ans, r'唯一覆盖者 `valid_from=(\d+)/valid_to=(\d+)/ingest_ts=(\d+)`，而 t=(\d+)', label)
    if m:
        s = fut['input']['rows'][0]
        v = fut['input']['rows'][1]
        got = [v['valid_from'] - 1700000000, v['valid_to'] - 1700000000,
               v['ingest_ts'] - 1700000000, s['event_ts'] - 1700000000]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('future-value 那条的四个时刻', got, said, got == said)
        e = fut['expected'][0]
        record('它必须是 null + future-value', [e['feature_value'], e['leak']],
               '[null, future-value]', e['feature_value'] is None and e['leak'] == 'future-value')
        record('朴素解在这条上会取到的那个值确实存在于数据里', v['feature_value'], '200',
               v['feature_value'] == 200)
    ov = q['cases'][4]
    record('三条并列同 valid_from', len({r['valid_from'] for r in ov['input']['rows'][1:]}), '1',
           len({r['valid_from'] for r in ov['input']['rows'][1:]}) == 1)
    record('它取 version_no 最大者', ov['expected'][0]['version_no'],
           max(r['version_no'] for r in ov['input']['rows'][1:]),
           ov['expected'][0]['version_no'] == max(r['version_no'] for r in ov['input']['rows'][1:]))


def probe_pyspark_lineage():
    q = load('bd-pyspark-0022')
    ans, label = q['answer'], 'bd-pyspark-0022'
    base = q['cases'][0]
    by = {r['action']: r for r in base['expected']}
    check('基线聚合出的 action 数', len(base['expected']), ans,
          r'\*\*基线([一二两三四五六七八九十\d]+)行聚合成 ([一二两三四五六七八九十\d]+) 个 action', label, group=2)
    check('每个 action 各 1 条事件', min(r['event_cnt'] for r in base['expected']), ans,
          r'个 action、各 (\d+) 条事件', label)
    rows = re.findall(r'`(already-disabled|block-unverified|keep|keep-preset|retire|retire-indirect-only)`'
                      r'\((\d+), (\d+), (\d+)\)', ans)
    if len(rows) != len(base['expected']):
        FAILURES.append('%s: 只抠到 %d 个 action 三元组，expected 有 %d 行 —— 那段文案变了' % (
            label, len(rows), len(base['expected'])))
    for act, cnt, gb, qs in rows:
        if act not in by:
            FAILURES.append('%s: 文案点了 %s，expected 里没有这一档' % (label, act))
            continue
        got = [by[act]['event_cnt'], by[act]['total_storage_gb'], by[act]['total_queries']]
        said = [int(cnt), int(gb), int(qs)]
        record('action %s 的三列' % act, got, said, got == said)
    m = need(ans, r'`?下线可省 (\d+) GB`?', label)
    if m:
        gb = by['already-disabled']['total_storage_gb']
        record('"下线可省 N GB"那一笔', gb, m.group(1), gb == int(m.group(1)))
    record('retire 档的 total_queries 恒为 0', by['retire']['total_queries'], '0',
           by['retire']['total_queries'] == 0)
    record('retire-indirect-only 档可以非零', by['retire-indirect-only']['total_queries'], '>0 的 30',
           by['retire-indirect-only']['total_queries'] == 30)
    edge = q['cases'][1]
    m = need(ans, r'边界用例（direct=(\d+), indirect=(\d+), queries_30d=(\d+)）⇒ `(\w+)`，只出一行', label)
    if m:
        r = edge['input']['rows'][0]
        got = [r['direct_refs'], r['indirect_refs'], r['queries_30d'], edge['expected'][0]['action'],
               len(edge['expected'])]
        said = [int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4), 1]
        record('边界那条', got, said, got == said)
        record('"存储只有 7 GB"那句', edge['expected'][0]['total_storage_gb'], '7',
               edge['expected'][0]['total_storage_gb'] == 7)
    deg = q['cases'][2]
    m = need(ans, r'退化用例（([一二两三四五六七八九十\d]+) 条可下线 \+ ([一二两三四五六七八九十\d]+) 条已禁用）⇒ 输出 ([一二两三四五六七八九十\d]+) 行', label)
    if m:
        got = [len([r for r in deg['input']['rows'] if r['disabled'] == 0]),
               len([r for r in deg['input']['rows'] if r['disabled'] == 1]), len(deg['expected'])]
        said = [int(_num(m.group(i))) for i in range(1, 4)]
        record('退化那条的行数', got, said, got == said)
    acts = {r['action']: r for r in deg['expected']}
    record('retire 档聚了两条事件', acts['retire']['event_cnt'], '2', acts['retire']['event_cnt'] == 2)
    record('多出来的 event_cnt=0 行不许有',
           [r['action'] for r in deg['expected'] if r['event_cnt'] == 0], '没有',
           not [r['action'] for r in deg['expected'] if r['event_cnt'] == 0])


# ==================================================== 类别 2：mysql 从种子 + 变更独立复算
def cells_nums(cells):
    """表格单元 → 数值（小数就留小数，中文数字与 − 号先归一）。"""
    out = []
    for x in cells:
        v = str(_num(x)).replace(',', '').strip().strip('`*')
        if re.fullmatch(r'-?\d+\.\d+', v):
            out.append(float(v))
        elif re.fullmatch(r'-?\d+', v):
            out.append(int(v))
        else:
            out.append(v)
    return out


def md_rows(text, first_col_re):
    """把答案里的 markdown 表格行抠成 cells（第一列要匹配得上才收，避免吃到表头/分隔行）。"""
    out = []
    for line in text.split('\n'):
        if not line.strip().startswith('|'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        head = cells[0].strip('`* ')
        if re.fullmatch(first_col_re, head):
            out.append([head] + cells[1:])
    return out


def fl(x):
    return None if x is None else float(Decimal(str(x)))


# --------------------------------------------------------- sql-mysql-0025 三种进组口径
def recompute_0025(tables):
    """按题面契约复算八个列（这是"量具"，不是第二份判分模型）。"""
    asg, cvt = tables['assignment']['rows'], tables['conversion']['rows']
    gmv_of = {}
    for r in cvt:
        gmv_of[r['user_id']] = gmv_of.get(r['user_id'], 0) + r['gmv_fen']
    groups = {}
    for r in asg:
        g = groups.setdefault((r['exp_id'], r['group_name']), {'u': set(), 'ud': set(), 'd': set()})
        g['u'].add(r['user_id'])
        g['ud'].add((r['user_id'], r['assigned_date']))
        g['d'].add(r['assigned_date'])
    out = []
    for key in sorted(groups):
        g = groups[key]
        users = len(g['u'])
        daily = len(g['ud'])
        days = len(g['d'])
        gmv = sum(gmv_of.get(u, 0) for u in g['u'])
        out.append({'exp_id': key[0], 'group_name': key[1], 'users_cum': users,
                    'users_daily_sum': daily, 'days': days,
                    'avg_daily_users': float(Decimal(daily).__truediv__(Decimal(days)).quantize(
                        Decimal('0.01'), rounding=ROUND_HALF_UP)), 'gmv_fen': gmv,
                    'arpu_cum_fen': gmv // users,
                    '_rows': len([r for r in asg if (r['exp_id'], r['group_name']) == key]),
                    '_users': g['u']})
    return out


def probe_dedup_caliber():
    q = load('sql-mysql-0025')
    ans, label = q['answer'], 'sql-mysql-0025'
    tables = seed_tables(q)
    for tbl in ('assignment', 'conversion'):
        if not tables.get(tbl) or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了' % (label, tbl))
    base_rows = rows_at(q, 0)
    calc = {(r['exp_id'], r['group_name']): r for r in recompute_0025(tables)}
    check('基线行数', len(base_rows), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行：\*\*', label)
    tbl = md_rows(ans, r'E\d')
    if len(tbl) != len(base_rows):
        FAILURES.append('%s: 答案那张基线表只抠到 %d 行，expected 有 %d 行 —— 表格写法变了' % (
            label, len(tbl), len(base_rows)))
    for cells in tbl:
        key = (cells[0], cells[1])
        if key not in calc:
            FAILURES.append('%s: 文案点了 %s 但种子里没有这个分组' % (label, key))
            continue
        said = cells_nums(cells[2:])
        got = [calc[key]['users_cum'], calc[key]['users_daily_sum'], calc[key]['days'],
               calc[key]['avg_daily_users'], calc[key]['gmv_fen'], calc[key]['arpu_cum_fen']]
        record('分组 %s 的六列' % '/'.join(key), got, said, eqseq(got, said))
        exp = next((r for r in base_rows if (r['exp_id'], r['group_name']) == key), None)
        if exp is None:
            FAILURES.append('%s: 种子里有 %s 但 expected 没有这行' % (label, key))
            continue
        record('expected 与种子复算一致 %s' % '/'.join(key),
               [exp['users_cum'], exp['users_daily_sum'], exp['days'], float(exp['avg_daily_users']),
                exp['gmv_fen'], exp['arpu_cum_fen']], got,
               [exp['users_cum'], exp['users_daily_sum'], exp['days'], float(exp['avg_daily_users']),
                exp['gmv_fen'], exp['arpu_cum_fen']] == got)
    # E1/treat 的流水条数、去重人数、用户-天数
    m = need(ans, r'E1/treat 的 \*\*(\d+) 条流水\*\* ⇒ (\d+) 个去重用户、\*\*(\d+) 个用户-天\*\*'
                 r'（u1 在 ([\d-]+) 有(NUMC) 条流水）'.replace('NUMC', NUMC), label)
    if m:
        asg = tables['assignment']['rows']
        u1_0902 = len([r for r in asg if r['user_id'] == 'u1' and r['assigned_date'].endswith(m.group(4))
                       and r['exp_id'] == 'E1' and r['group_name'] == 'treat'])
        got = [calc[('E1', 'treat')]['_rows'], calc[('E1', 'treat')]['users_cum'],
               calc[('E1', 'treat')]['users_daily_sum'], u1_0902]
        said = [int(m.group(1)), int(m.group(2)), int(m.group(3)), int(_num(m.group(5)))]
        record('E1/treat 的形状', got, said, got == said)
    m = need(ans, r'GMV = u1\((\d+)\+(\d+)\) \+ u2\((\d+)\) \+ u3\((\d+)\) = (\d+) 分 '
                 r'⇒ `FLOOR\((\d+)/(\d+)\) = (\d+)`', label)
    if m:
        by_user = {}
        for r in tables['conversion']['rows']:
            by_user.setdefault(r['user_id'], []).append(r['gmv_fen'])
        g = calc[('E1', 'treat')]
        total = sum(sum(v) for u, v in by_user.items() if u in g['_users'])
        got = [max(by_user['u1']), min(by_user['u1']), sum(by_user['u2']), sum(by_user['u3']),
               total, total, len(g['_users']), total // len(g['_users'])]
        said = [int(m.group(i)) for i in range(1, 9)]
        record('E1/treat 的 GMV 与 ARPU', got, said, got == said)
    # 三个错法各自只动一列
    m = need(ans, r'不去重 `users_cum` ⇒ 会得到 (\d+)、`arpu` 变成 (\d+)', label)
    if m:
        g = calc[('E1', 'treat')]
        got = [g['_rows'], g['gmv_fen'] // g['_rows']]
        said = [int(m.group(1)), int(m.group(2))]
        record('不去重 users_cum 的错法', got, said, got == said)
    m = need(ans, r'不去重 `\(user, day\)` ⇒ `users_daily_sum` 变成 (\d+)、`avg` 变成 ([\d.]+)', label)
    if m:
        asg = tables['assignment']['rows']
        rows = len([r for r in asg if (r['exp_id'], r['group_name']) == ('E1', 'treat')])
        got = [rows, round(rows / g['days'] + 1e-12, 2)]
        said = [int(m.group(1)), float(m.group(2))]
        record('不去重用户-天的错法', got, said, got == said)
    m = need(ans, r'（E1/treat 的 u1 有 (\d+) 条流水 ⇒ (\d+) 分被算成 (\d+) 分）', label)
    if m:
        asg = tables['assignment']['rows']
        cv = tables['conversion']['rows']
        n_rows = len([r for r in asg if r['user_id'] == 'u1'
                      and (r['exp_id'], r['group_name']) == ('E1', 'treat')])
        u1_gmv = sum(c['gmv_fen'] for c in cv if c['user_id'] == 'u1')
        got = [n_rows, u1_gmv, n_rows * u1_gmv]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('u1 被流水放大后的 GMV', got, said, got == said)
    record('三条口径纪律同时输出的列数', len(q['cases'][0]['expected']['columns']) - 2, '六',
           len(q['cases'][0]['expected']['columns']) - 2 == 6)
    # 用例「把某用户那天的重复流水与原始流水一起删掉」
    c3 = named(q, '把某用户那天的重复流水与原始流水一起删掉', label)
    t3 = apply_changes(tables, c3['input'])
    k3 = {(r['exp_id'], r['group_name']): r for r in recompute_0025(t3)}
    m = need(ans, r'只删 id (\d+) 时 (\d+) 不变（id (\d+) 还在），两条一起删才掉到 (\d+) ⇒ '
                 r'`avg = ROUND\((\d+)/(\d+),2\) = ([\d.]+)`', label)
    if m:
        only_one = apply_changes(tables, ['DELETE FROM assignment WHERE id = %s' % m.group(1)])
        k1 = {(r['exp_id'], r['group_name']): r for r in recompute_0025(only_one)}
        got = [k1[('E1', 'treat')]['users_daily_sum'], k3[('E1', 'treat')]['users_daily_sum'],
               k3[('E1', 'treat')]['users_daily_sum'], k3[('E1', 'treat')]['days'],
               k3[('E1', 'treat')]['avg_daily_users']]
        said = [int(m.group(2)), int(m.group(4)), int(m.group(4)), int(m.group(6)), float(m.group(7))]
        record('重复流水那条用例', got, said, got == said)
        exp3 = {(r['exp_id'], r['group_name']): r for r in case_rows(c3)}
        record('它与 expected 一致', [exp3[('E1', 'treat')]['users_daily_sum'],
                                  float(exp3[('E1', 'treat')]['avg_daily_users'])],
               [k3[('E1', 'treat')]['users_daily_sum'], k3[('E1', 'treat')]['avg_daily_users']],
               [exp3[('E1', 'treat')]['users_daily_sum'], float(exp3[('E1', 'treat')]['avg_daily_users'])]
               == [k3[('E1', 'treat')]['users_daily_sum'], k3[('E1', 'treat')]['avg_daily_users']])
    # 新增从未成交的用户 ⇒ 分母变大
    c4 = named(q, '新增一个从未成交的用户', label)
    t4 = apply_changes(tables, c4['input'])
    k4 = {(r['exp_id'], r['group_name']): r for r in recompute_0025(t4)}
    m = need(ans, r'`users_cum` 从 (\d+) 变 (\d+)、GMV 仍是 (\d+) ⇒\s*\n?`arpu` 从 (\d+) 掉到 (\d+)', label)
    if m:
        got = [calc[('E1', 'treat')]['users_cum'], k4[('E1', 'treat')]['users_cum'],
               k4[('E1', 'treat')]['gmv_fen'], calc[('E1', 'treat')]['arpu_cum_fen'],
               k4[('E1', 'treat')]['arpu_cum_fen']]
        said = [int(m.group(i)) for i in range(1, 6)]
        record('分母敏感那条', got, said, got == said)
    # 双实验重叠：四组之和
    m = need(ans, r'四个分组的 `gmv_fen` 相加是\s*\n?`(\d+) \+ (\d+) \+ (\d+) \+ (\d+) = (\d+)` 分，\s*\n?'
                 r'而全部成交流水只有 (\d+) 分', label)
    if m:
        cv_sum = sum(r['gmv_fen'] for r in tables['conversion']['rows'])
        sum_gmv = sum(r['gmv_fen'] for r in recompute_0025(tables))
        got = [r['gmv_fen'] for r in recompute_0025(tables)] + [sum_gmv, cv_sum]
        said = [int(m.group(i)) for i in range(1, 7)]
        record('基线四组的 GMV 相加与总流水', got, said, got == said)
    stranded = [u for u in {r['user_id'] for r in tables['conversion']['rows']}
                if u not in {r['user_id'] for r in tables['assignment']['rows']}]
    m = need(ans, r'(\d+) 分属于从没进过任何实验的 (u\d+)', label)
    if m:
        amt = sum(r['gmv_fen'] for r in tables['conversion']['rows'] if r['user_id'] == m.group(2))
        got = [amt, sorted(stranded)]
        record('只成交不进组的用户', got, [int(m.group(1)), [m.group(2)]],
               amt == int(m.group(1)) and sorted(stranded) == [m.group(2)])
    shared = [u for u in {r['user_id'] for r in tables['assignment']['rows']}
              if len({r['exp_id'] for r in tables['assignment']['rows'] if r['user_id'] == u}) > 1]
    m = need(ans, r'(\d+) 分属于 (u\d+) —— 他的两笔成交在 E1 与 E2 里各被记了一遍', label)
    if m:
        amt = sum(r['gmv_fen'] for r in tables['conversion']['rows'] if r['user_id'] == m.group(2))
        record('两个实验各算一遍的用户', [amt, m.group(2) in shared], [int(m.group(1)), True],
               amt == int(m.group(1)) and m.group(2) in shared)
    # 用例「同一用户被两个实验各吃进去一次」⇒ 四组之和
    c2 = named(q, '同一用户被两个实验各吃进去一次', label)
    t2 = apply_changes(tables, c2['input'])
    sum2 = sum(r['gmv_fen'] for r in recompute_0025(t2))
    m = need(ans, r'再把 u2 塞进 E2/treat，\s*\n?此时四组之和变成 `(\d+) \+ (\d+) = (\d+)` 分', label)
    if m:
        base_sum = sum(r['gmv_fen'] for r in recompute_0025(tables))
        u2_gmv = sum(r['gmv_fen'] for r in tables['conversion']['rows'] if r['user_id'] == 'u2')
        got = [base_sum, u2_gmv, sum2]
        said = [int(m.group(i)) for i in (1, 2, 3)]
        record('双实验重叠：基线四组之和 + u2 的成交额 = 重叠后的四组之和', got, said, got == said)
    exp2 = {(r['exp_id'], r['group_name']): r for r in case_rows(c2)}
    record('它与 expected 之和一致', sum(r['gmv_fen'] for r in exp2.values()), sum2,
           sum(r['gmv_fen'] for r in exp2.values()) == sum2)
    # 清空成交表：四行带 0
    c6 = named(q, '清空成交表', label)
    rows6 = case_rows(c6)
    m = need(c6['name'], r'ARPU 与 GMV 归零，但进组人数与([一二两三四五六七八九十\d]+)个分组行都不许消失', label)
    if m:
        record('清空成交后的分组行数', len(rows6), int(_num(m.group(1))),
               len(rows6) == int(_num(m.group(1))))
        record('清空成交后 GMV 与 ARPU 全 0', {r['gmv_fen'] for r in rows6} | {r['arpu_cum_fen'] for r in rows6},
               '{0}', {r['gmv_fen'] for r in rows6} | {r['arpu_cum_fen'] for r in rows6} == {0})
    c5 = named(q, '有成交但从未进过任何组', label)
    record('清空进组流水 ⇒ 空集', c5['expected'], '[]', c5['expected'] == [])


# --------------------------------------------------------- sql-mysql-0026 分流均衡性
def recompute_0026(tables):
    asg, dic = tables['assignment']['rows'], {r['exp_id']: r['expected_treat_bps']
                                              for r in tables['exp_dict']['rows']}
    out = {}
    for exp in sorted({r['exp_id'] for r in asg}):
        rs = [r for r in asg if r['exp_id'] == exp]
        users = {r['user_id'] for r in rs}
        treat = {r['user_id'] for r in rs if r['group_name'] == 'treat'}
        per_user = {}
        for r in rs:
            per_user.setdefault(r['user_id'], set()).add(r['group_name'])
        multi = len([u for u, gs in per_user.items() if len(gs) > 1])
        actual = len(treat) * 10000 // len(users)
        exp_bps = dic.get(exp, 0)
        dev = abs(actual - exp_bps)
        if len(users) < 200:
            flag = 'LOW-SAMPLE'
        elif multi > 0:
            flag = 'MUTEX-VIOLATION'
        elif exp_bps <= 0:
            flag = 'NO-EXPECTED-RATIO'
        elif dev * 10000 >= 1000 * exp_bps:
            flag = 'SRM_RISK'
        else:
            flag = 'OK'
        out[exp] = {'exp_users': len(users), 'treat_users': len(treat), 'actual': actual,
                    'expected': exp_bps, 'dev': dev, 'multi': multi, 'flag': flag,
                    '_rows': len(rs)}
    return out


def probe_srm():
    q = load('sql-mysql-0026')
    ans, label = q['answer'], 'sql-mysql-0026'
    tables = seed_tables(q)
    for tbl in ('assignment', 'exp_dict'):
        if not tables.get(tbl) or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了' % (label, tbl))
    calc = recompute_0026(tables)
    base_rows = {(r['exp_id']): r for r in rows_at(q, 0)}
    check('基线行数', len(base_rows), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行：\*\*', label)
    tbl = md_rows(ans, r'EXP_[A-Z]')
    if len(tbl) != len(base_rows):
        FAILURES.append('%s: 基线表只抠到 %d 行，expected 有 %d 行' % (label, len(tbl), len(base_rows)))
    for cells in tbl:
        exp = cells[0]
        if exp not in calc:
            FAILURES.append('%s: 文案点了 %s 但种子里没有这个实验' % (label, exp))
            continue
        got = [calc[exp]['exp_users'], calc[exp]['treat_users'], calc[exp]['actual'],
               calc[exp]['expected'], calc[exp]['dev'], calc[exp]['multi'], calc[exp]['flag']]
        said = cells_nums(cells[1:7]) + [cells[7]]
        record('%s 的七列' % exp, got, said, eqseq(got, said))
        if exp in base_rows:
            e = base_rows[exp]
            record('expected 与复算一致 %s' % exp,
                   [e['exp_users'], e['treat_users'], e['actual_treat_bps'], e['expected_treat_bps'],
                    e['deviation_bps'], e['multi_group_users'], e['flag']], got,
                   [e['exp_users'], e['treat_users'], e['actual_treat_bps'], e['expected_treat_bps'],
                    e['deviation_bps'], e['multi_group_users'], e['flag']] == got)
    kinds = {r['flag'] for r in base_rows.values()}
    check('基线出现的 flag 种类', len(kinds), q['cases'][0]['name'], r'([一二两三四五六七八九十\d]+)种 flag 各命中一次', label)
    m = need(ans, r'EXP_A 的偏离正好是 (\d+) 万分比 ⇒ 判据 `deviation \* (\d+) >= (\d+) \* expected`\s*\n?'
                 r'即 `(\d+)\*(\d+) >= (\d+)\*(\d+)`', label)
    if m:
        got = [base_rows['EXP_A']['deviation_bps'], 10000, 1000,
               base_rows['EXP_A']['deviation_bps'], 10000, 1000, base_rows['EXP_A']['expected_treat_bps']]
        said = [int(m.group(i)) for i in range(1, 8)]
        record('EXP_A 的相对判据', got, said, got == said)
    m = need(ans, r'EXP_E 与 EXP_F 是这题的核心对照：两者的 `actual_treat_bps` 都是 (\d+)、\s*\n?'
                 r'`deviation_bps` 都是 (\d+)，唯一差别是 (\d+) 人 vs (\d+) 人', label)
    if m:
        got = [base_rows['EXP_E']['actual_treat_bps'], base_rows['EXP_E']['deviation_bps'],
               base_rows['EXP_E']['exp_users'], base_rows['EXP_F']['exp_users']]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('EXP_E / EXP_F 对照', got, said, got == said)
        record('一个 LOW-SAMPLE 一个 SRM_RISK', [base_rows['EXP_E']['flag'], base_rows['EXP_F']['flag']],
               '[LOW-SAMPLE, SRM_RISK]',
               [base_rows['EXP_E']['flag'], base_rows['EXP_F']['flag']] == ['LOW-SAMPLE', 'SRM_RISK'])
    m = need(ans, r'EXP_D 的 `expected_treat_bps` 是 (\d+)、`deviation_bps` 是 (\d+)', label)
    if m:
        got = [base_rows['EXP_D']['expected_treat_bps'], base_rows['EXP_D']['deviation_bps']]
        said = [int(m.group(i)) for i in range(1, 3)]
        record('EXP_D 缺字典那一行', got, said, got == said)
    # 用例「样本数恰好 200」
    c1 = named(q, '样本数恰好 200', label)
    t1 = apply_changes(tables, c1['input'])
    k1 = recompute_0026(t1)
    m = need(ans, r'去重人数从 (\d+) 掉到 (\d+)、`treat_users` 仍是 (\d+) ⇒ `actual` 反而\*\*升到 (\d+)\*\*', label)
    if m:
        got = [calc['EXP_F']['exp_users'], k1['EXP_F']['exp_users'], k1['EXP_F']['treat_users'],
               k1['EXP_F']['actual']]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('删一条流水之后', got, said, got == said)
    e1 = {r['exp_id']: r for r in case_rows(c1)}
    record('它与 expected 一致', [e1['EXP_F']['exp_users'], e1['EXP_F']['actual_treat_bps'],
                              e1['EXP_F']['flag']],
           [k1['EXP_F']['exp_users'], k1['EXP_F']['actual'], k1['EXP_F']['flag']],
           [e1['EXP_F']['exp_users'], e1['EXP_F']['actual_treat_bps'], e1['EXP_F']['flag']]
           == [k1['EXP_F']['exp_users'], k1['EXP_F']['actual'], k1['EXP_F']['flag']])
    # 用例「字典改成 6000」
    c2 = named(q, '字典改成 6000', label)
    k2 = recompute_0026(apply_changes(tables, c2['input']))
    m = need(c2['name'], r'字典改成 (\d+) 之后 EXP_A 立刻从 SRM 变成 (\w+)', label)
    if m:
        record('核对预设比例之后', [k2['EXP_A']['expected'], k2['EXP_A']['flag']],
               [int(m.group(1)), m.group(2)],
               [k2['EXP_A']['expected'], k2['EXP_A']['flag']] == [int(m.group(1)), m.group(2)])
    # 用例「消除互斥违例」
    c3 = named(q, '消除互斥违例', label)
    k3 = recompute_0026(apply_changes(tables, c3['input']))
    m = need(c3['name'] + q['cases'][0]['note'], r'把([三条五一二四\d]+)条重复进组记录删掉', label)
    if m:
        record('删掉的正是违例那几条', [calc['EXP_C']['multi'], k3['EXP_C']['multi']],
               [int(_num(m.group(1))), 0],
               [calc['EXP_C']['multi'], k3['EXP_C']['multi']] == [int(_num(m.group(1))), 0])
    m = need(q['cases'][0]['note'], r'EXP_E 只有 (\d+) 人', label)
    if m:
        record('EXP_E 的人数', calc['EXP_E']['exp_users'], m.group(1), calc['EXP_E']['exp_users'] == int(m.group(1)))
    m = need(q['cases'][0]['note'], r'EXP_A (\d+) vs (\d+)', label)
    if m:
        got = [calc['EXP_A']['actual'], calc['EXP_A']['expected']]
        record('用例备注里 EXP_A 的两个数', got, [int(m.group(1)), int(m.group(2))],
               got == [int(m.group(1)), int(m.group(2))])
    c4 = named(q, '但一条进组流水都没有', label)
    k4 = recompute_0026(apply_changes(tables, c4['input']))
    m = need(c4['name'] + (c4.get('note') or ''), r'结果仍是([一二两三四五六七八九十\d]+)行', label)
    if m:
        record('字典多一行也不许多出结果', len(k4), int(_num(m.group(1))), len(k4) == int(_num(m.group(1))))
        record('EXP_Z 不在结果里', 'EXP_Z' in k4, 'False', 'EXP_Z' not in k4)
    # 相对判据那条用例：预设比例
    c5 = named(q, '预设比例是', label)
    k5 = recompute_0026(apply_changes(tables, c5['input']))
    e5 = {r['exp_id']: r for r in case_rows(c5)}
    record('那条用例六行的 dev 与 flag（复算 vs expected）',
           [(e, k5[e]['dev'], k5[e]['flag']) for e in sorted(k5)],
           [(e, e5[e]['deviation_bps'], e5[e]['flag']) for e in sorted(k5)],
           sorted(k5) == sorted(e5)
           and [(e, k5[e]['dev'], k5[e]['flag']) for e in sorted(k5)]
           == [(e, e5[e]['deviation_bps'], e5[e]['flag']) for e in sorted(k5)])
    m = need(c5.get('note') or '', r'EXP_A 实际 (\d+)、预设 (\d+) ⇒ 偏离 (\d+) 万分比', label)
    if m:
        got = [k5['EXP_A']['actual'], k5['EXP_A']['expected'], k5['EXP_A']['dev']]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('相对偏离那条用例', got, said, got == said)
        record('判据式 dev*10000 >= 1000*expected 在这一行成立 ⇒ 判 SRM_RISK',
               [k5['EXP_A']['dev'] * 10000 >= 1000 * k5['EXP_A']['expected'], k5['EXP_A']['flag']],
               [True, 'SRM_RISK'],
               k5['EXP_A']['dev'] * 10000 >= 1000 * k5['EXP_A']['expected']
               and k5['EXP_A']['flag'] == 'SRM_RISK')
    m = need(c5.get('note') or '', r'同一份数据里 EXP_D 偏 (\d+)、EXP_E 偏 (\d+) 也都越过 naive 的绝对阈值 > (\d+)', label)
    if m:
        th = int(m.group(3))
        nv = (q['runner'] or {}).get('naiveSolution') or ''
        mn = re.search(r">\s*(\d+)\s+THEN 'SRM_RISK'", nv)
        record('naive SQL 里那条绝对阈值 = 文案写的数',
               [int(mn.group(1))] if mn else ['naive 里解不出绝对阈值'], [th],
               bool(mn) and int(mn.group(1)) == th)
        over = [(e, k5[e]['dev'], k5[e]['flag']) for e in ('EXP_D', 'EXP_E')]
        record('越过绝对阈值、真因却是另两档的行', over,
               [('EXP_D', int(m.group(1)), 'NO-EXPECTED-RATIO'),
                ('EXP_E', int(m.group(2)), 'LOW-SAMPLE')],
               over == [('EXP_D', int(m.group(1)), 'NO-EXPECTED-RATIO'),
                        ('EXP_E', int(m.group(2)), 'LOW-SAMPLE')])
    m = need(c5['name'], r'预设比例是 (\d+)% 时，偏离达到预设的 ([\d.]+) 倍 ⇒ 仍然要判 (\w+)', label)
    if m:
        got = [k5['EXP_A']['expected'] / 100.0,
               k5['EXP_A']['dev'] / float(k5['EXP_A']['expected']), k5['EXP_A']['flag']]
        said = [float(m.group(1)), float(m.group(2)), m.group(3)]
        # 用例名里写的是简称 SRM，expected 那一列的值是 SRM_RISK：只认"文案是它的前缀"
        flag_ok = got[2] == said[2] or got[2].startswith(said[2] + '_')
        record('用例名：预设比例百分数 / 偏离是预设的几倍 / 结论', got, said,
               abs(got[0] - said[0]) < 1e-9 and abs(got[1] - said[1]) < 1e-9 and flag_ok)
    m = need(q['statement'], r'同样是 (\d+) 万分比的绝对偏离， 在预设 (\d+) 的实验上是 ([\d.]+)% 的相对偏离'
                            r'（判据越线）， 在预设 (\d+) 的实验上只有 ([\d.]+)%（不越线）', label)
    if m:
        dev = int(m.group(1))
        got = [round(dev * 100.0 / int(m.group(2)), 1), dev * 10000 >= 1000 * int(m.group(2)),
               round(dev * 100.0 / int(m.group(4)), 1), dev * 10000 >= 1000 * int(m.group(4))]
        said = [float(m.group(3)), True, float(m.group(5)), False]
        record('题面那句"同一个绝对偏离、两种相对值"', got, said, got == said)
    c6 = named(q, '一条进组记录都没有', label)
    record('清空流水 ⇒ 空集', c6['expected'], '[]', c6['expected'] == [])


# --------------------------------------------------------- sql-mysql-0027 埋点四类违规
def recompute_0027(tables):
    meta = {r['event_name']: r for r in tables['event_meta']['rows']}
    out = []
    for u in sorted(tables['upload_stat']['rows'], key=lambda r: r['event_name']):
        m = meta.get(u['event_name'])
        bps = (u['prop_null'] * 10000 // u['prop_total']) if u['prop_total'] > 0 else 0
        if m is None:
            v = 'not-registered'
        elif m['registered'] == 0 and m['is_preset'] == 0:
            v = 'not-registered'
        elif m['verified'] == 0:
            v = 'unverified'
        elif m['disabled'] == 1 and u['uploads'] > 0:
            v = 'disabled-still-uploading'
        elif m['is_preset'] == 1:
            v = 'ok'
        elif u['uploads'] >= 100 and u['prop_total'] > 0 and bps >= 500:
            v = 'prop-missing-rate'
        else:
            v = 'ok'
        out.append({'event_name': u['event_name'], 'uploads': u['uploads'],
                    'violation': v, 'missing_bps': bps})
    return out


def probe_tracking_violations():
    q = load('sql-mysql-0027')
    ans, label = q['answer'], 'sql-mysql-0027'
    tables = seed_tables(q)
    for tbl in ('event_meta', 'upload_stat'):
        if not tables.get(tbl) or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了' % (label, tbl))
    calc = {r['event_name']: r for r in recompute_0027(tables)}
    base = {r['event_name']: r for r in rows_at(q, 0)}
    check('基线行数', len(base), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行输出\*\*', label)
    kinds = {r['violation'] for r in base.values()}
    m = need(ans, r'一条 `LEFT JOIN` \+ 一个([一二两三四五六七八九十\d]+)档 `CASE`', label)
    if m:
        # "六档 CASE" 说的是那条 CASE 有几个分支 —— 从**参考解**里数 WHEN，不是数违规种类
        # 只数 violation 那一条 CASE 的分支（missing_bps 那条 CASE 也有 WHEN，整篇数会多一档）
        ref = q['runner']['referenceSolution']
        whens = len(re.findall(r'\bWHEN\b', ref[:ref.index('AS violation')]))
        record('CASE 的分档数（参考解里的 WHEN 分支）', whens, _num(m.group(1)),
               whens == int(_num(m.group(1))))
    m = need(q['title'], r'埋点([一二三四五六]?)类违规体检', label)
    if m:
        record('标题承诺的违规种类数', len(kinds - {'ok'}), _num(m.group(1) or '四'),
               len(kinds - {'ok'}) == int(_num(m.group(1) or '四')))
    for ev in sorted(calc):
        m = re.search(r'`(%s)` → `([a-z-]+)`（缺填率 ([\d.]+)' % re.escape(ev), ans)
        if not m:
            continue
        got = [calc[ev]['violation'], calc[ev]['missing_bps']]
        said = [m.group(2), int(m.group(3))]
        record('%s 的判定与缺填率' % ev, got, said, got == said)
        if ev in base:
            record('expected 与复算一致 %s' % ev, [base[ev]['violation'], base[ev]['missing_bps']], got,
                   [base[ev]['violation'], base[ev]['missing_bps']] == got)
    m = need(ans, r'(\d+)/(\d+) ⇒ (\d+) 万分比 ≥ (\d+)', label)
    if m:
        u = next(r for r in tables['upload_stat']['rows'] if r['event_name'] == 'noisy_event')
        got = [u['prop_null'], u['prop_total'], calc['noisy_event']['missing_bps'], 500]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('noisy_event 的缺填率式子', got, said, got == said)
    m = need(ans, r'唯一差别是 uploads=(\d+) < (\d+)', label)
    if m:
        u = next(r for r in tables['upload_stat']['rows'] if r['event_name'] == 'tiny_event')
        got = [u['uploads'], 100]
        said = [int(m.group(1)), int(m.group(2))]
        record('tiny_event 的样本门槛', got, said, got == said and calc['tiny_event']['violation'] == 'ok')
    m = need(ans, r'缺填率排序与违规排序是相反的', label)
    if m:
        over = [e for e in calc if calc[e]['missing_bps'] >= 500]
        flagged = [e for e in calc if calc[e]['violation'] == 'prop-missing-rate']
        record('越线的比报出来的多（排序相反）', len(over) > len(flagged), True, len(over) > len(flagged))
    # 逐用例复算并与 expected 比
    for i, c in enumerate(q['cases'][1:], start=1):
        t = apply_changes(tables, c['input'])
        k = {r['event_name']: r for r in recompute_0027(t)}
        exp = {r['event_name']: r for r in case_rows(c)}
        if not exp:
            record('%s（用例 %d）' % (c['name'][:20], i), c['expected'], '空集', c['expected'] == [])
            continue
        diff = [e for e in set(k) | set(exp)
                if k.get(e, {}).get('violation') != exp.get(e, {}).get('violation')
                or k.get(e, {}).get('missing_bps') != exp.get(e, {}).get('missing_bps')
                or k.get(e, {}).get('uploads') != exp.get(e, {}).get('uploads')]
        record('用例 %d「%s」逐事件复算 %d 行' % (i, c['name'][:16], len(exp)),
               diff, '没有一行不一致', not diff)
    m = need(ans, r'把 `\$page_start` 的缺填改成\s*\n?(\d+)/(\d+) ⇒ (\d+) 万分比，输出仍然必须是 `(\w+)`', label)
    if m:
        c1 = named(q, '预置事件即使缺填率爆表', label)
        t = apply_changes(tables, c1['input'])
        k = {r['event_name']: r for r in recompute_0027(t)}
        got = [k['$page_start']['missing_bps'], k['$page_start']['violation']]
        said = [int(m.group(3)), m.group(4)]
        record('预置事件爆表那条', got, said, got == said)
        u = next(r for r in t['upload_stat']['rows'] if r['event_name'] == '$page_start')
        record('UPDATE 之后种子里确实是这个数', [u['prop_null'], u['prop_total']],
               [int(m.group(1)), int(m.group(2))],
               [u['prop_null'], u['prop_total']] == [int(m.group(1)), int(m.group(2))])
    c5 = named(q, '上报里出现了元数据里根本不存在的事件', label)
    m = need(c5.get('note') or '', r'这 (\d+) 次上报', label)
    if m:
        t = apply_changes(tables, c5['input'])
        known = {x['event_name'] for x in tables['event_meta']['rows']}
        stray = [r for r in t['upload_stat']['rows'] if r['event_name'] not in known]
        got = sum(r['uploads'] for r in stray)
        record('孤儿上报的次数', got, m.group(1), got == int(m.group(1)))
        v = next((r['violation'] for r in recompute_0027(t) if r['event_name'] == 'stray_event'), None)
        record('它被判成 not-registered（而不是悄悄隐身）', v, 'not-registered', v == 'not-registered')
    c6 = named(q, '已禁用且确实不再上报', label)
    t = apply_changes(tables, c6['input'])
    k = {r['event_name']: r for r in recompute_0027(t)}
    record('禁用但零上报 ⇒ ok', k['legacy_click']['violation'], 'ok', k['legacy_click']['violation'] == 'ok')


# --------------------------------------------------------- sql-mysql-0028 两条成功率曲线
def recompute_0028(tables):
    out = {}
    for svc in sorted({r['to_service'] for r in tables['rpc_log']['rows']}):
        rs = [r for r in tables['rpc_log']['rows'] if r['to_service'] == svc]
        total = len(rs)
        rpc = len([r for r in rs if r['rpc_result'] == 'OK'])
        biz = len([r for r in rs if r['biz_success'] == 1])
        deg = len([r for r in rs if r['fallback_used'] == 1 and r['rpc_result'] != 'OK'])
        fb_all = len([r for r in rs if r['fallback_used'] == 1])
        rb, bb, db = rpc * 10000 // total, biz * 10000 // total, deg * 10000 // total
        gap = bb - rb
        if total < 100:
            v = 'LOW-SAMPLE'
        elif gap >= 500:
            v = 'POLLUTED-METRIC'
        elif db >= 3000:
            v = 'DEGRADE-HEAVY'
        elif rb < 9000:
            v = 'UNHEALTHY'
        else:
            v = 'CLEAN'
        out[svc] = {'total': total, 'rpc_bps': rb, 'biz_bps': bb, 'degrade_bps': db,
                    'gap_bps': gap, 'verdict': v, '_rpc_ok': rpc, '_biz_ok': biz, '_deg': deg,
                    '_fb_all': fb_all, '_rows': rs}
    return out


def probe_degrade_curves():
    q = load('sql-mysql-0028')
    ans, label = q['answer'], 'sql-mysql-0028'
    tables = seed_tables(q)
    if not tables.get('rpc_log') or not tables['rpc_log']['rows']:
        raise SystemExit('%s: 没能从 setup 里解析出 rpc_log —— 种子写法变了' % label)
    calc = recompute_0028(tables)
    base = {r['to_service']: r for r in rows_at(q, 0)}
    check('基线行数', len(base), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行：\*\*', label)
    tbl = md_rows(ans, r'cart|coupon|order|search')
    if len(tbl) != len(base):
        FAILURES.append('%s: 基线表只抠到 %d 行，expected 有 %d 行' % (label, len(tbl), len(base)))
    for cells in tbl:
        svc = cells[0]
        got = [calc[svc]['total'], calc[svc]['rpc_bps'], calc[svc]['biz_bps'],
               calc[svc]['degrade_bps'], calc[svc]['gap_bps'], calc[svc]['verdict']]
        said = cells_nums(cells[1:6]) + [cells[6]]
        record('服务 %s 的六列' % svc, got, said, eqseq(got, said))
        e = base[svc]
        record('expected 与复算一致 %s' % svc,
               [e['total'], e['rpc_success_bps'], e['biz_success_bps'], e['degrade_bps'],
                e['gap_bps'], e['verdict']], got,
               [e['total'], e['rpc_success_bps'], e['biz_success_bps'], e['degrade_bps'],
                e['gap_bps'], e['verdict']] == got)
    note = q['cases'][0]['note']
    m = need(note, r'cart (\d+) 行里 RPC 成功 (\d+)、业务成功 (\d+) ⇒ gap (\d+) 万分比 ⇒ (\w+)', label)
    if m:
        c = calc['cart']
        got = [c['total'], c['_rpc_ok'], c['_biz_ok'], c['gap_bps'], c['verdict'].split('-')[0]]
        said = [int(m.group(i)) for i in range(1, 5)] + [m.group(5)]
        record('用例备注里的 cart 四个数', got, said,
               got[:4] == said[:4] and c['verdict'] == 'POLLUTED-METRIC')
    m = need(note, r'search (\d+) / (\d+) ⇒ gap (\d+) 未越线', label)
    if m:
        c = calc['search']
        got = [c['rpc_bps'], c['biz_bps'], c['gap_bps']]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('用例备注里的 search', got, said, got == said)
    m = need(note, r'order CLEAN；coupon 只有 (\d+) 行', label)
    if m:
        record('coupon 的行数', calc['coupon']['total'], m.group(1), calc['coupon']['total'] == int(m.group(1)))
    m = need(ans, r'它的 gap 是 (\d+)，\*\*不到 (\d+) 线\*\*', label)
    if m:
        got = [calc['search']['gap_bps'], 500]
        said = [int(m.group(1)), int(m.group(2))]
        record('search 的 gap 与阈值', got, said, got == said and calc['search']['verdict'] != 'POLLUTED-METRIC')
    m = need(ans, r'RPC 成功率 (\d+) 低于 (\d+)', label)
    if m:
        got = [calc['search']['rpc_bps'], 9000]
        said = [int(m.group(1)), int(m.group(2))]
        record('search 的 RPC 成功率', got, said, got == said and calc['search']['verdict'] == 'UNHEALTHY')
    m = need(ans, r'它的 (\d+) 条失败里 (\d+) 条是熔断、(\d+) 条限流，降级只兜回 (\d+) 条', label)
    if m:
        rs = calc['search']['_rows']
        kinds = {}
        for r in rs:
            if r['rpc_result'] != 'OK':
                kinds[r['rpc_result']] = kinds.get(r['rpc_result'], 0) + 1
        biz_fail = calc['search']['total'] - calc['search']['_biz_ok']
        got = [biz_fail, calc['search']['_deg'], kinds]
        said = [int(m.group(1)), int(m.group(4)), kinds]
        record('search 的失败构成（业务失败 %d 条 / 降级兜回 %d 条）' % (biz_fail, calc['search']['_deg']),
               [biz_fail, calc['search']['_deg']], [int(m.group(1)), int(m.group(4))],
               [biz_fail, calc['search']['_deg']] == [int(m.group(1)), int(m.group(4))])
        # "60 条是熔断、20 条限流" —— 在**业务失败**那一侧按 rpc_result 分类量
        bf = [r for r in rs if r['biz_success'] == 0]
        byk = {}
        for r in bf:
            byk[r['rpc_result']] = byk.get(r['rpc_result'], 0) + 1
        def pick(*keys):
            return sum(v for k, v in byk.items() if any(x in k for x in keys))
        record('业务失败里的熔断/限流构成 %s' % sorted(byk.items()),
               [pick('BREAK', 'CIRCUIT'), pick('LIMIT')],
               [int(m.group(2)), int(m.group(3))],
               [pick('BREAK', 'CIRCUIT'), pick('LIMIT')] == [int(m.group(2)), int(m.group(3))])
    c1 = named(q, '降级没兜住一条', label)
    t = apply_changes(tables, c1['input'])
    k = recompute_0028(t)
    m = need(c1.get('note') or '', r'业务成功数 (\d+) 变 (\d+) ⇒ biz 曲线从 (\d+) 掉到 (\d+)，'
                                 r'gap 从 (\d+) 掉到 (\d+)', label)
    if m:
        got = [calc['cart']['_biz_ok'], k['cart']['_biz_ok'], calc['cart']['biz_bps'],
               k['cart']['biz_bps'], calc['cart']['gap_bps'], k['cart']['gap_bps']]
        said = [int(m.group(i)) for i in range(1, 7)]
        record('少兜住一条', got, said, got == said)
        e = {r['to_service']: r for r in case_rows(c1)}
        record('它与 expected 一致', [e['cart']['biz_success_bps'], e['cart']['gap_bps'], e['cart']['verdict']],
               [k['cart']['biz_bps'], k['cart']['gap_bps'], k['cart']['verdict']],
               [e['cart']['biz_success_bps'], e['cart']['gap_bps'], e['cart']['verdict']]
               == [k['cart']['biz_bps'], k['cart']['gap_bps'], k['cart']['verdict']])
    c2 = named(q, '把降级标记全部抹掉', label)
    k2 = recompute_0028(apply_changes(tables, c2['input']))
    m = need(ans, r'cart 的 `degrade_bps` 从 (\d+) 变 (\d+)', label)
    if m:
        got = [calc['cart']['degrade_bps'], k2['cart']['degrade_bps']]
        said = [int(m.group(1)), int(m.group(2))]
        record('抹掉降级标记前后', got, said, got == said)
        record('两条成功率曲线一个都没变',
               [[calc['cart']['rpc_bps'], calc['cart']['biz_bps']],
                [k2['cart']['rpc_bps'], k2['cart']['biz_bps']]], '前后相同',
               [calc['cart']['rpc_bps'], calc['cart']['biz_bps']] == [k2['cart']['rpc_bps'],
                                                                     k2['cart']['biz_bps']])
        record('gap 仍是 1000 ⇒ 仍判污染', k2['cart']['gap_bps'], m.group(1),
               k2['cart']['gap_bps'] == calc['cart']['gap_bps'] == 1000)
    # ---- 朴素解那份 CASE：阈值与档位都从 naiveSolution 里解出来，不写死在探针里
    nv = (q['runner'] or {}).get('naiveSolution') or ''
    flat = re.sub(r'\s+', ' ', nv)
    mb = re.search(r"CASE WHEN COUNT\(\*\) < (\d+) THEN '([\w-]+)' WHEN "
                   r"FLOOR\(SUM\(biz_success\)\s*\*\s*10000 / COUNT\(\*\)\) >= (\d+) "
                   r"THEN '([\w-]+)' ELSE '([\w-]+)'", flat)
    if not mb:
        FAILURES.append('%s: 从 naiveSolution 里解不出那三档分支 —— 朴素解写法变了，探针得跟着改' % label)

    def naive_branch(total, biz_bps):
        if not mb:
            return '〈解不出〉'
        return mb.group(2) if total < int(mb.group(1)) else (
            mb.group(4) if biz_bps >= int(mb.group(3)) else mb.group(5))

    m = need(ans, r'cart 的 RPC 成功率被抬到 (\d+)（真实是 (\d+)）', label)
    if m and mb:
        record('朴素解给 cart 的 rpc 曲线（它拿 biz_success 顶替）/ 真实值',
               [calc['cart']['biz_bps'], calc['cart']['rpc_bps']],
               [int(m.group(1)), int(m.group(2))],
               [calc['cart']['biz_bps'], calc['cart']['rpc_bps']] == [int(m.group(1)), int(m.group(2))])
    m = need(ans, r'`gap_bps` 又写死成 (\d+) ⇒ cart 在它手里是 `([\w-]+)`，而真实答案是 `([\w-]+)`', label)
    if m:
        gap_lit = re.search(r'(\d+)\s+AS gap_bps', nv)
        record('朴素解的 gap 常量 / cart 在它手里 / cart 的真实结论',
               [int(gap_lit.group(1)) if gap_lit else 'SQL 里解不出 gap 常量',
                naive_branch(calc['cart']['total'], calc['cart']['biz_bps']), calc['cart']['verdict']],
               [int(m.group(1)), m.group(2), m.group(3)],
               str(gap_lit.group(1) if gap_lit else '') == str(m.group(1))
               and naive_branch(calc['cart']['total'], calc['cart']['biz_bps']) == m.group(2)
               and calc['cart']['verdict'] == m.group(3))
    m = need(ans, r'业务侧 (\d+) 成 ⇒ 万分比 (\d+) 越过 (\d+) 线，\s*\n?它那份 CASE 只会输出 `([\w-]+)`，'
                  r'真实答案却是 `([\w-]+)`', label)
    if m and mb:
        s = calc['search']
        got = [s['_biz_ok'], s['biz_bps'], int(mb.group(3)),
               naive_branch(s['total'], s['biz_bps']), s['verdict']]
        said = [int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4), m.group(5)]
        record('search 在朴素解手里（成数 / 万分比 / 线 / 它给的结论 / 真实结论）', got, said, got == said)
        record('文案抄来的那条线就是朴素解 SQL 里的线', int(m.group(3)), int(mb.group(3)),
               int(m.group(3)) == int(mb.group(3)))
    m = need(ans, r'种子里没有一行 `fallback_used = 1` 且 `rpc_result = .OK.`，\s*\n?于是两种口径对 search 都得到 '
                  r'(\d+) 万分比（(\d+)/(\d+)），离 (\d+) 线还差 (\d+)', label)
    if m:
        rows = tables['rpc_log']['rows']
        mislabeled = len([r for r in rows if r['fallback_used'] == 1 and r['rpc_result'] == 'OK'])
        s = calc['search']
        naive_deg = s['_fb_all'] * 10000 // s['total']
        # 那条线不抄文案：从**参考解**的 CASE 里解出来，再与文案写的那个数对
        ref_flat = re.sub(r'\s+', ' ', (q['runner'] or {}).get('referenceSolution') or '')
        mline = re.search(r">=\s*(\d+)\s+THEN 'DEGRADE-HEAVY'", ref_flat)
        line = int(mline.group(1)) if mline else int(m.group(4))
        record('参考解里 DEGRADE-HEAVY 的线 = 文案写的那条线', line, m.group(4),
               bool(mline) and line == int(m.group(4)))
        got = [mislabeled, naive_deg, s['degrade_bps'], s['_fb_all'], s['total'], line,
               line - naive_deg]
        said = [0, int(m.group(1)), int(m.group(1)), int(m.group(2)), int(m.group(3)),
                int(m.group(4)), int(m.group(5))]
        record('埋点错误行数 / 两种口径的 search 降级率 / 离那条线还差多少', got, said, got == said)
    m = need(ans, r'`naiveSolution` 那份 CASE 里也压根没有 `([\w-]+)` 这一档', label)
    if m:
        tiers = sorted(set(re.findall(r"(?:THEN|ELSE)\s+'([\w-]+)'", nv)))
        record('朴素解那份 CASE 的档位集合（%s 不在里面）' % m.group(1),
               [m.group(1) in tiers, tiers], [False, ['CLEAN', 'LOW-SAMPLE', 'UNHEALTHY']],
               m.group(1) not in tiers and tiers == ['CLEAN', 'LOW-SAMPLE', 'UNHEALTHY'])
    # 题面举 LOW-SAMPLE 时点名的那三个数：它们必须是 coupon 这一行真实量出来的
    m = need(q['statement'], r'coupon 那 (\d+) 行里 (\d+) 行降级 ⇒ 万分比 (\d+) 的"降级率"， '
                            r'(\d+) 行 RPC 不 OK 就把 `rpc_success_bps` 打到 (\d+)', label)
    if m:
        c = calc['coupon']
        got = [c['total'], c['_fb_all'], c['degrade_bps'], c['total'] - c['_rpc_ok'], c['rpc_bps']]
        said = [int(m.group(i)) for i in range(1, 6)]
        record('题面那句 LOW-SAMPLE 举例的五个数（行数 / 降级行数 / 降级万分比 / RPC 失败行数 / rpc 万分比）',
               got, said, got == said)
    c3 = named(q, '日志清空', label)
    record('清空日志 ⇒ 空集', c3['expected'], '[]', c3['expected'] == [])


# --------------------------------------------------------- sql-mysql-0029 血缘闭包
def recompute_0029(tables):
    nodes = {r['name']: r for r in tables['lineage_node']['rows']}
    edges = [(r['from_node'], r['to_node']) for r in tables['lineage_edge']['rows']]
    out = {}
    for name, n in sorted(nodes.items()):
        if n['kind'] != 'event':
            continue
        direct = {b for a, b in edges if a == name}
        clo, frontier, depth = set(direct), set(direct), 0
        while frontier and depth < 6:
            nxt = {b for a, b in edges if a in frontier} - clo
            clo |= nxt
            frontier, depth = nxt, depth + 1
        qs = [nodes[x]['queries_30d'] for x in clo]
        total, mx = sum(qs), max(qs) if qs else 0
        if not clo:
            prio = 'orphan'
        elif total == 0:
            prio = 'low-usage'
        elif len(clo) > len(direct):
            prio = 'deep-dependency'
        else:
            prio = 'hot-direct'
        out[name] = {'direct_consumers': len(direct), 'indirect_consumers': len(clo) - len(direct),
                     'closure_nodes': len(clo), 'max_queries_30d': mx,
                     'total_queries_30d': total, 'retire_priority': prio, '_clo': clo}
    return out


def probe_lineage_closure():
    q = load('sql-mysql-0029')
    ans, label = q['answer'], 'sql-mysql-0029'
    tables = seed_tables(q)
    for tbl in ('lineage_node', 'lineage_edge'):
        if not tables.get(tbl) or not tables[tbl]['rows']:
            raise SystemExit('%s: 没能从 setup 里解析出 %s —— 种子写法变了' % (label, tbl))
    calc = recompute_0029(tables)
    base = {r['event_name']: r for r in rows_at(q, 0)}
    check('基线行数', len(base), ans, r'\*\*基线([一二两三四五六七八九十\d]+)行：\*\*', label)
    tbl = md_rows(ans, r'ev_\w+')
    if len(tbl) != len(base):
        FAILURES.append('%s: 基线表只抠到 %d 行，expected 有 %d 行' % (label, len(tbl), len(base)))
    cols = ['direct_consumers', 'indirect_consumers', 'closure_nodes', 'max_queries_30d',
            'total_queries_30d', 'retire_priority']
    for cells in tbl:
        ev = cells[0]
        got = [calc[ev][c] for c in cols]
        said = cells_nums(cells[1:6]) + [cells[6]]
        record('事件 %s 的六列' % ev, got, said, eqseq(got, said))
        e = base[ev]
        record('expected 与复算一致 %s' % ev, [e[c] for c in cols], got, [e[c] for c in cols] == got)
    m = need(ans, r'查询数分别是 (\d+) / (\d+) / (\d+) / (\d+) ⇒ 求和 (\d+)、最大 (\d+)', label)
    if m:
        hot = sorted((tables['lineage_node']['rows'][j]['queries_30d']
                      for j in range(len(tables['lineage_node']['rows']))
                      if tables['lineage_node']['rows'][j]['name'] in calc['ev_pay']['_clo']),
                     reverse=True)
        said = sorted([int(m.group(i)) for i in range(1, 5)], reverse=True)
        got = [hot, calc['ev_pay']['total_queries_30d'], calc['ev_pay']['max_queries_30d']]
        record('ev_pay 闭包上的四个热度', got,
               [said, int(m.group(5)), int(m.group(6))],
               got == [said, int(m.group(5)), int(m.group(6))])
    m = need(ans, r'`ev_pay` 的闭包是 `(\w+) → \{(\w+), (\w+)\} → (\w+)` 共 (\d+) 个节点', label)
    if m:
        named_nodes = {m.group(1), m.group(2), m.group(3), m.group(4)}
        got = [sorted(calc['ev_pay']['_clo']), calc['ev_pay']['closure_nodes']]
        said = [sorted(named_nodes), int(m.group(5))]
        record('闭包的四个节点', got, said, got == said)
        record('其中只有 dwd_order 是直接下游',
               [calc['ev_pay']['direct_consumers'], calc['ev_pay']['indirect_consumers']],
               '1 / 3', [calc['ev_pay']['direct_consumers'], calc['ev_pay']['indirect_consumers']] == [1, 3])
    m = need(ans, r'`ads_funnel` 既是 `ev_click` 的\*\*直接\*\*下游，\s*\n?'
                 r'又是 `ev_pay` 的\*\*间接\*\*下游（经 `(\w+) → (\w+)`）', label)
    if m:
        edges = {(r['from_node'], r['to_node']) for r in tables['lineage_edge']['rows']}
        got = [('ev_click', 'ads_funnel') in edges,
               'ads_funnel' in calc['ev_pay']['_clo'],
               (m.group(1), m.group(2)) in edges,
               m.group(2) in calc['ev_pay']['_clo']]
        record('ads_funnel 的双重身份（经 %s→%s）' % (m.group(1), m.group(2)), got,
               '[True, True, True, True]', all(got))
    # 逐用例复算
    for i, c in enumerate(q['cases'][1:], start=1):
        t = apply_changes(tables, c['input'])
        k = recompute_0029(t)
        exp = {r['event_name']: r for r in case_rows(c)}
        diff = [e for e in set(k) | set(exp)
                if any(k.get(e, {}).get(cc) != exp.get(e, {}).get(cc) for cc in cols)]
        record('用例 %d「%s」复算 %d 行' % (i, c['name'][:16], len(exp)), diff, '没有一行不一致', not diff)
    c1 = named(q, '断开中间那一跳', label)
    k1 = recompute_0029(apply_changes(tables, c1['input']))
    m = need(c1.get('note') or '', r'闭包从 (\d+) 个节点变 (\d+) 个、total_queries 从 (\d+) 变 (\d+)', label)
    if m:
        got = [calc['ev_pay']['closure_nodes'], k1['ev_pay']['closure_nodes'],
               calc['ev_pay']['total_queries_30d'], k1['ev_pay']['total_queries_30d']]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('断开中间那一跳', got, said, got == said)
    c2 = named(q, '只清掉中间层的查询数', label)
    k2 = recompute_0029(apply_changes(tables, c2['input']))
    m = need(c2.get('note') or '', r'ev_pay 的 total_queries 从 (\d+) 掉到 (\d+)', label)
    if m:
        got = [calc['ev_pay']['total_queries_30d'], k2['ev_pay']['total_queries_30d']]
        said = [int(m.group(1)), int(m.group(2))]
        record('清掉中间层热度', got, said, got == said)
        record('最深处那张报表还剩几次', k2['ev_pay']['max_queries_30d'], m.group(2),
               k2['ev_pay']['max_queries_30d'] == int(m.group(2)))
        record('仍然不是 low-usage', k2['ev_pay']['retire_priority'], 'deep-dependency',
               k2['ev_pay']['retire_priority'] == 'deep-dependency')
    c3 = named(q, '整条闭包一次查询都没有', label)
    k3 = recompute_0029(apply_changes(tables, c3['input']))
    record('全归零才落 low-usage', [k3['ev_pay']['retire_priority'], k3['ev_click']['retire_priority']],
           '[low-usage, low-usage]',
           [k3['ev_pay']['retire_priority'], k3['ev_click']['retire_priority']]
           == ['low-usage', 'low-usage'])
    record('此时闭包节点数与间接数没变', [k3['ev_pay']['closure_nodes'], k3['ev_pay']['indirect_consumers']],
           '[4, 3]', [k3['ev_pay']['closure_nodes'], k3['ev_pay']['indirect_consumers']] == [4, 3])
    c4 = named(q, '一条边都没有', label)
    k4 = recompute_0029(apply_changes(tables, c4['input']))
    record('无边 ⇒ 两个孤儿，热度是 0 不是 NULL',
           [k4['ev_pay']['retire_priority'], k4['ev_pay']['max_queries_30d'],
            k4['ev_click']['retire_priority'], k4['ev_click']['total_queries_30d']],
           '[orphan, 0, orphan, 0]',
           [k4['ev_pay']['retire_priority'], k4['ev_pay']['max_queries_30d'],
            k4['ev_click']['retire_priority'], k4['ev_click']['total_queries_30d']]
           == ['orphan', 0, 'orphan', 0])
    c5 = named(q, '中间节点自己就是最热的那个', label)
    k5 = recompute_0029(apply_changes(tables, c5['input']))
    m = need(c5.get('note') or '', r'max_queries_30d 从 (\d+) 变 (\d+)', label)
    if m:
        got = [calc['ev_pay']['max_queries_30d'], k5['ev_pay']['max_queries_30d']]
        said = [int(m.group(1)), int(m.group(2))]
        record('中间层变最热', got, said, got == said)
    m = need(ans, r'`max_queries` 从 (\d+) 变 (\d+)、`total` 从 (\d+) 变 (\d+)', label)
    if m:
        got = [calc['ev_pay']['max_queries_30d'], k5['ev_pay']['max_queries_30d'],
               calc['ev_pay']['total_queries_30d'], k5['ev_pay']['total_queries_30d']]
        said = [int(m.group(i)) for i in range(1, 5)]
        record('答案里那条前后对照', got, said, got == said)
    m = need(ans, r'热度只算直接下游（`ev_pay` 的 sum 会从 (\d+) 变成 (\d+)）', label)
    if m:
        nodes = {r['name']: r['queries_30d'] for r in tables['lineage_node']['rows']}
        direct_only = sum(nodes[b] for a, b in
                          [(r['from_node'], r['to_node']) for r in tables['lineage_edge']['rows']]
                          if a == 'ev_pay')
        record('naive 只算直接下游', direct_only, m.group(2), direct_only == int(m.group(2)))
        record('而正确答案的 sum 是', calc['ev_pay']['total_queries_30d'], m.group(1),
               calc['ev_pay']['total_queries_30d'] == int(m.group(1)))
    c6 = named(q, '把叶子报表查热、中间表查冷', label)
    k6 = recompute_0029(apply_changes(tables, c6['input']))
    record('闭包形状没变（节点数一致）',
           [[k6[e]['closure_nodes'], k6[e]['indirect_consumers']] for e in ('ev_click', 'ev_pay')],
           [[2, 0], [4, 3]],
           [[k6[e]['closure_nodes'], k6[e]['indirect_consumers']] for e in ('ev_click', 'ev_pay')]
           == [[2, 0], [4, 3]])
    record('但 max/sum 换了人', [k6['ev_pay']['max_queries_30d'], k6['ev_pay']['total_queries_30d']],
           [3000, 3102], [k6['ev_pay']['max_queries_30d'], k6['ev_pay']['total_queries_30d']] == [3000, 3102])


# ==================================================== 类别 3：迷你 Redis
class MiniRedis:
    """只支持这两道题用得到的那几条命令；**按给出的顺序执行**。

    为什么必须按顺序：`ZREMRANGEBYSCORE` 在最前面，它只作用在当时的全局窗口上；
    把它挪到并账之后一起算会量出第三个数（阿里那份探针踩过，这里保持同一条纪律）。
    """

    def __init__(self, setup):
        self.z, self.s, self.h = {}, {}, {}
        for line in setup:
            self.run(line)

    @staticmethod
    def toks(line):
        t = ' '.join(str(line).split())
        t = re.sub(r'\s+#.*$', '', t)
        return t.split()

    def run(self, line):
        t = self.toks(line)
        if not t:
            return
        cmd = t[0].upper()
        if cmd == 'DEL':
            for k in t[1:]:
                self.z.pop(k, None)
                self.s.pop(k, None)
                self.h.pop(k, None)
            return
        if cmd == 'ZADD':
            key = t[1]
            flag = None
            i = 2
            if t[2] in ('NX', 'XX'):
                flag, i = t[2], 3
            z = self.z.setdefault(key, {})
            for j in range(i, len(t), 2):
                score, mem = int(t[j]), t[j + 1]
                if flag == 'NX' and mem in z:
                    continue
                if flag == 'XX' and mem not in z:
                    continue
                z[mem] = score
            return
        if cmd == 'ZREMRANGEBYSCORE':
            key, lo, hi = t[1], t[2], t[3]
            z = self.z.setdefault(key, {})
            low = -10 ** 18 if lo == '-inf' else int(lo)
            high = 10 ** 18 if hi == '+inf' else int(hi)
            self.z[key] = {m: s for m, s in z.items() if not (low <= s <= high)}
            return
        if cmd == 'ZUNIONSTORE':
            dest, n = t[1], int(t[2])
            merged = {}
            for src in t[3:3 + n]:
                for mem, sc in self.z.get(src, {}).items():
                    merged[mem] = merged.get(mem, 0) + sc
            self.z[dest] = merged
            return
        if cmd == 'HSET':
            hh = self.h.setdefault(t[1], {})
            for j in range(2, len(t), 2):
                hh[t[j]] = t[j + 1]
            return
        if cmd == 'HINCRBY':
            hh = self.h.setdefault(t[1], {})
            hh[t[2]] = str(int(hh.get(t[2], '0')) + int(t[3]))
            return
        if cmd == 'HDEL':
            self.h.get(t[1], {}).pop(t[2], None)
            return
        if cmd == 'SET':
            self.s[t[1]] = t[2]
            return
        if cmd == 'INCR':
            self.s[t[1]] = str(int(self.s.get(t[1], '0')) + 1)
            return
        raise SystemExit('迷你 Redis 不认得这条命令：%s（参考解写法变了，探针得跟着改）' % ' '.join(t))

    def observe(self, line):
        t = self.toks(line)
        cmd = t[0].upper()
        if cmd == 'ZSCORE':
            v = self.z.get(t[1], {}).get(t[2])
            return None if v is None else str(v)
        if cmd == 'ZCARD':
            return len(self.z.get(t[1], {}))
        if cmd == 'ZCOUNT':
            z = self.z.get(t[1], {})
            low = -10 ** 18 if t[2] == '-inf' else int(t[2])
            high = 10 ** 18 if t[3] == '+inf' else int(t[3])
            return len([m for m, s in z.items() if low <= s <= high])
        if cmd == 'EXISTS':
            n = 0
            for bag in (self.z, self.s, self.h):
                if t[1] in bag:
                    n = 1
            return n
        if cmd == 'GET':
            return self.s.get(t[1])
        if cmd == 'HGET':
            return self.h.get(t[1], {}).get(t[2])
        raise SystemExit('迷你 Redis 不认得这条观测命令：%s' % ' '.join(t))

    def snapshot(self):
        return {'z': {k: dict(v) for k, v in self.z.items()},
                's': dict(self.s), 'h': {k: dict(v) for k, v in self.h.items()}}


def zadd_members(q, key_prefix):
    """从 setup 抠 `ZADD key score member` → {key: {member: score}}。"""
    out = {}
    for stmt in (q.get('runner') or {}).get('setup') or []:
        m = re.match(r'ZADD (\S+) (-?\d+) (\S+)$', ' '.join(str(stmt).split()))
        if m and m.group(1).startswith(key_prefix):
            out.setdefault(m.group(1), {})[m.group(3)] = int(m.group(2))
    return out


def answer_commands(q, label):
    """答案里那个围栏块＝写给人的参考解，它必须与 runner.referenceSolution 同源。"""
    ans = q['answer']
    block = re.search(r'```\n(.*?)\n```', ans, re.S)
    if not block:
        raise SystemExit('%s: 答案里没有围栏块，抠不出命令序列' % label)
    out = []
    for ln in (x.strip() for x in block.group(1).split('\n')):
        if not ln or ln.startswith('#'):
            continue
        out.append(re.sub(r'\s+#.*$', '', ln))
    if not out:
        raise SystemExit('%s: 围栏块里一条命令都没有' % label)
    return out


def ref_commands(q, label):
    out = []
    for ln in (x.strip() for x in (q['runner'].get('referenceSolution') or '').split('\n')):
        if not ln or ln.startswith('#'):
            continue
        out.append(re.sub(r'\s+#.*$', '', ln))
    if not out:
        raise SystemExit('%s: runner.referenceSolution 里没有命令' % label)
    return out


def redis_observe(q, setup, acmds, rcmds, label):
    """把"答案里那段命令"和"判题用的参考解"各跑一遍，逐条观测命令回判 expected。

    两份都要量：参考解那一路是迷你 Redis 的**自证**（它对不上就说明量具坏了），
    答案那一路才是本探针的正题（文案与判分数据是否同源）。
    只量参考解的话，答案写错数就永远看不见 —— 而"答案写错数"正是这批题最容易犯的错。
    """
    a, r = MiniRedis(setup), MiniRedis(setup)
    for c in acmds:
        a.run(c)
    for c in rcmds:
        r.run(c)
    for c in q['cases']:
        obs, exp = c['input'][0], c['expected']
        for tag, st in (('答案那段命令', a), ('判题参考解', r)):
            got = st.observe(obs)
            ok = (got is None) == (exp is None) and str(got) == str(exp)
            record('%s：观测 %s（%s）' % (label, obs, tag), got, exp, ok)
    return a, r


def probe_lease_quota():
    q = load('sql-redis-0011')
    ans, label = q['answer'], 'sql-redis-0011'
    setup = (q.get('runner') or {}).get('setup') or []
    lease = 'live:d1:lease'
    seed = zadd_members(q, lease).get(lease, {})
    # now / 保留窗口 / 回收边界：只从**答案**那句话里抠（参考解的注释不算文案）
    m = need(ans, r'`now - 保留窗口 = (\d+) - (\d+) = (\d+)`', label)
    now, win, bound = [int(m.group(i)) for i in range(1, 4)] if m else (0, 0, 0)
    if m:
        check('回收边界（答案另一处写法）', bound, ans, r'E1 的回收边界是 (\d+)，不是 (\d+)', label, group=1)
        record('那个"不是"的边界确实不是答案用的那个', bound != int(m.group(2)), True,
               bound != int(m.group(2)))
    # 三条初值必须同时跨在**两条线**两侧（回收边界 6400 与 now=10000）
    m = need(ans, r'三条初值要同时跨在两条线两侧\*\*（(\d+) 在回收边界之下、(\d+) 落在 (\d+) 与 (\d+) 之间、'
                   r'(\d+) 在 `now` 之上）', label)
    if m:
        below = sorted(s for s in seed.values() if s <= bound)
        middle = sorted(s for s in seed.values() if bound < s <= now)
        above = sorted(s for s in seed.values() if s > now)
        got = [below, [middle, above], [bound, now], int(m.group(2)) > bound and int(m.group(2)) <= now]
        said = [[int(m.group(1))], [[int(m.group(2))], [int(m.group(5))]],
                [int(m.group(3)), int(m.group(4))], True]
        record('种子初值跨两条线（下/中/上各一条）', got, said, got == said)
        # 中间那条的存在就是"错法可判"的全部依据：把它挪到 now 之上，两种写法就同解了
        record('跨过边界的那条初值正是 c-001（错法删掉的就是它）',
               [k for k, s in seed.items() if bound < s <= now], ['c-001'],
               [k for k, s in seed.items() if bound < s <= now] == ['c-001'])
    m = need(ans, r'`c-002` 的 (\d+) 被回收，而 `c-001` 的 (\d+) 与 `c-003` 的 (\d+) \*\*必须留下\*\*', label)
    if m:
        got = [seed.get('c-002'), seed.get('c-001'), seed.get('c-003')]
        said = [int(m.group(i)) for i in range(1, 4)]
        record('三条租约的初值', got, said, got == said)
        record('只有 c-002 落在回收边界之下',
               sorted(k for k, s in seed.items() if s <= bound), ['c-002'],
               sorted(k for k, s in seed.items() if s <= bound) == ['c-002'])
    # 答案里那段命令序列 vs runner.referenceSolution —— 两者必须给同一个终态
    acmds, rcmds = answer_commands(q, label), ref_commands(q, label)
    a_state, r_state = redis_observe(q, setup, acmds, rcmds, label)
    same = a_state.snapshot() == r_state.snapshot()
    record('答案的 command block 与判题参考解给出同一个终态',
           '与参考解相同' if same else '不同：答案 %s ｜ 参考解 %s' % (
               json.dumps(a_state.snapshot(), sort_keys=True, ensure_ascii=False),
               json.dumps(r_state.snapshot(), sort_keys=True, ensure_ascii=False)),
           '与参考解相同', same)
    # "把回收写成 -inf 10000" 那个错法：文案承诺它会连带删掉活着的那条、掉两个校验
    m = need(ans, r'把回收写成 `ZREMRANGEBYSCORE \S+ -inf (\d+)` 的实现会连带删掉 (\d+) 那条'
                  r'\*\*仍然活着\*\*的租约', label)
    m2 = need(ans, r'于是 `ZCARD` 从 (\d+) 变成 (\d+)、`ZSCORE \S+ (\S+)` 变 nil', label)
    if m and m2:
        wrong = int(m.group(1))
        named_wrongly = int(m.group(2))
        actually_deleted = sorted(s for s in seed.values() if bound < s <= wrong)
        record('边界写成 %d 时会被误删的初值（文案点名那一条）' % wrong,
               actually_deleted, [named_wrongly], actually_deleted == [named_wrongly])
        z2 = MiniRedis(setup)
        for c in rcmds:
            z2.run(re.sub(r'(ZREMRANGEBYSCORE \S+ -inf) \d+', r'\g<1> %d' % wrong, c))
        ok_z = MiniRedis(setup + rcmds).z.get(lease, {})
        bad_z = z2.z.get(lease, {})
        base_card, wrong_card = len(ok_z), len(bad_z)
        nil_member = sorted(k for k in ok_z if k not in bad_z)
        record('错法的 ZCARD（文案：%s 变成 %s）' % (m2.group(1), m2.group(2)),
               [base_card, wrong_card], [int(m2.group(1)), int(m2.group(2))],
               [base_card, wrong_card] == [int(m2.group(1)), int(m2.group(2))])
        record('错法确实与正解不同（否则这条错法不可判）',
               [base_card, wrong_card], '两个数不相等', base_card != wrong_card)
        record('错法下变 nil 的正是文案点名的 %s（正解下它活着）' % m2.group(3),
               [nil_member, bad_z.get(m2.group(3)) is None, ok_z.get(m2.group(3)) is not None],
               [[m2.group(3)], True, True],
               nil_member == [m2.group(3)] and bad_z.get(m2.group(3)) is None
               and ok_z.get(m2.group(3)) is not None)
    # 配额与用例名里点名的数
    quota = MiniRedis(setup).h.get('live:d1:quota', {})
    c3 = named(q, '并发路数恰好等于配额上限', label)
    m = need(c3['name'], r'配额上限 (\d+)', label)
    if m:
        got = [int(quota['total']), c3['expected'], len(MiniRedis(setup + rcmds).z.get(lease, {}))]
        said = [int(m.group(1))] * 3
        record('路数上限 = 配额 = 终态成员数', got, said, got == said)
    c4 = named(q, '不许多出任何一路', label)
    m = need(c4['name'], r'到期时间晚于 (\d+) 的成员数是 (\d+)', label)
    if m:
        mr = MiniRedis(setup + rcmds)
        thr = int(m.group(1))
        late = len([s for s in mr.z.get(lease, {}).values() if s > thr])
        record('晚于 %d 的成员数' % thr, late, m.group(2), late == int(m.group(2)))
        mb = re.match(r'ZCOUNT \S+ (\d+) \+inf', c4['input'][0])
        record('观测命令用的下界就是"晚于 %d"（%s）' % (thr, c4['input'][0]),
               int(mb.group(1)), thr + 1, int(mb.group(1)) == thr + 1)
        record('它与 expected 一致', mr.observe(c4['input'][0]), c4['expected'],
               str(mr.observe(c4['input'][0])) == str(c4['expected']))
    # 朴素解：它挂掉的校验数必须 > 0（矩阵能抓到它的依据）
    naive = (q['runner'] or {}).get('naiveSolution') or ''
    nlines = [re.sub(r'\s+#.*$', '', x.strip()) for x in naive.split('\n') if x.strip() and not x.strip().startswith('#')]
    st = MiniRedis(setup)
    for c in nlines:
        st.run(c)
    fails = [c['input'][0] for c in q['cases']
             if str(st.observe(c['input'][0])) != str(c['expected'])
             and not (c['expected'] is None and st.observe(c['input'][0]) is None)]
    record('朴素解挂掉的校验数', len(fails), '>0', len(fails) > 0)


def probe_idem_window():
    q = load('sql-redis-0012')
    ans, label = q['answer'], 'sql-redis-0012'
    setup = (q.get('runner') or {}).get('setup') or []
    idem, slow = 'mq:g1:idem', 'mq:g1:slow'
    m = need(ans, r'只保留 `\(?now - (\d+), now\] = \((\d+), (\d+)\]` 内到达的消息', label)
    win, bound, now = [int(m.group(i)) for i in range(1, 4)] if m else (0, 0, 0)
    if m:
        record('窗口区间（左开右闭的两个端点）', [now - win, bound, now], [bound, bound, now],
               now - win == bound)
        check('回收边界（答案另一处写法）', bound, ans, r'E1 的回收边界是 (\d+) 而不是 (\d+)', label, group=1)
    seed_idem = zadd_members(q, idem).get(idem, {})
    seed_slow = zadd_members(q, slow).get(slow, {})
    m = need(ans, r'本题初值里故意留了一条已过保留期的 `m-001`\((\d+)\)', label)
    if m:
        got = [seed_idem.get('m-001')]
        said = [int(m.group(1))]
        record('那条故意留下的过期初值', got, said, got == said)
        record('它确实在左边界之外', seed_idem['m-001'] <= bound, 'True', seed_idem['m-001'] <= bound)
    m = need(ans, r'`m-100` 的 (\d+) 与 `m-150` 的 (\d+) 都在窗口内', label)
    if m:
        mr = MiniRedis(setup + ref_commands(q, label))
        got = [mr.z.get(idem, {}).get('m-100'), mr.z.get(idem, {}).get('m-150')]
        said = [int(m.group(1)), int(m.group(2))]
        record('窗口里两条消息的分数', got, said, got == said and all(
            bound < s <= now for s in got))
    acmds, rcmds = answer_commands(q, label), ref_commands(q, label)
    a_state, r_state = redis_observe(q, setup, acmds, rcmds, label)
    same = a_state.snapshot() == r_state.snapshot()
    record('答案的 command block 与判题参考解给出同一个终态',
           '与参考解相同' if same else '不同：答案 %s ｜ 参考解 %s' % (
               json.dumps(a_state.snapshot(), sort_keys=True, ensure_ascii=False),
               json.dumps(r_state.snapshot(), sort_keys=True, ensure_ascii=False)),
           '与参考解相同', same)
    c2 = named(q, '窗口里恰好两条', label)
    m = need(c2['name'], r'恰好([一二两三四五六七八九十\d]+)条', label)
    if m:
        record('窗口里的成员数', c2['expected'], int(_num(m.group(1))),
               c2['expected'] == int(_num(m.group(1))))
    m = need(ans, r'漏写 E1 会当场被.*?抓到（ZCARD 会是 (\d+)）', label)
    if m:
        st = MiniRedis(setup)
        for c in rcmds:
            if not c.startswith('ZREMRANGEBYSCORE'):
                st.run(c)
        record('漏写回收那一步的 ZCARD', len(st.z.get(idem, {})), m.group(1),
               len(st.z.get(idem, {})) == int(m.group(1)))
    retry = {k: int(v) for k, v in MiniRedis(setup).h.get('mq:g1:retry', {}).items()}
    c4 = named(q, '达到重试上限的那条要留痕', label)
    m = need(c4['name'], r'计数是 (\d+)', label)
    if m:
        got = [retry.get('m-200'), retry.get('m-200') + 1, int(c4['expected'])]
        said = [int(m.group(1)) - 1, int(m.group(1)), int(m.group(1))]
        record('重试计数（种子值 + 一次 HINCRBY = 用例名说的数）', got, said, got == said)
    c5 = named(q, '死信计数加一', label)
    dlq0 = MiniRedis(setup).s.get('mq:g1:dlq')
    record('死信计数器：种子是 %s、判分要 %s（加一）' % (dlq0, c5['expected']),
           int(dlq0) + 1, int(c5['expected']), int(dlq0) + 1 == int(c5['expected']))
    c3 = named(q, '窗口左边界之外不许留任何成员', label)
    m = need(c3['name'], r'score 小于等于 (\d+) 的数量是 (\d+)', label)
    if m:
        st = MiniRedis(setup + rcmds)
        got = [int(m.group(1)) == bound, st.observe(c3['input'][0]), int(m.group(2))]
        record('左边界之外不许留成员（边界 %d 与窗口一致）' % bound, got,
               [True, int(m.group(2)), int(m.group(2))], got == [True, int(m.group(2)), int(m.group(2))])
    cb = named(q, '慢消费者不许被从水位表里删掉', label)
    mark = named(q, '慢消费者要被标记', label)
    m = need(mark['name'] + cb['name'], r'水位表仍是([一二三四五六两\d]+)个成员|慢消费者要被标记', label) \
        if False else None
    got = [seed_slow.get('clientB'), bound, cb['expected'], mark['expected']]
    record('慢消费者：种子水位 %s 在左边界 %s 之外 ⇒ 留痕 %s / 标记 %s'
           % (seed_slow.get('clientB'), bound, cb['expected'], mark['expected']),
           [seed_slow['clientB'] < bound, str(cb['expected']) == str(seed_slow['clientB']),
            str(mark['expected'])], ['水位低于左边界', '原样保留', '1'],
           seed_slow['clientB'] < bound and str(cb['expected']) == str(seed_slow['clientB'])
           and str(mark['expected']) == '1')
    naive = (q['runner'] or {}).get('naiveSolution') or ''
    nlines = [re.sub(r'\s+#.*$', '', x.strip()) for x in naive.split('\n')
              if x.strip() and not x.strip().startswith('#')]
    st = MiniRedis(setup)
    for c in nlines:
        st.run(c)
    fails = [c['input'][0] for c in q['cases']
             if str(st.observe(c['input'][0])) != str(c['expected'])
             and not (c['expected'] is None and st.observe(c['input'][0]) is None)]
    m = need(ans, r'还暂停错了人\s*\n?（`clientA` 被暂停、`clientB` 没有 ⇒ 最后两条校验同时反向）', label)
    if m:
        got = [st.observe('EXISTS mq:g1:paused:clientA'), st.observe('GET mq:g1:paused:clientB')]
        said = ['1', None]
        record('朴素解把正常人暂停、把该停的放过', [str(x) for x in got], [str(x) for x in said],
               [str(x) for x in got] == [str(x) for x in said])
    record('朴素解挂掉的校验数', len(fails), '>0', len(fails) > 0)


def skip_notes():
    SKIPS.append('  SKIP  sql-redis-0011 / 0012 的**服务端最终状态语义**（ZADD NX/XX、ZREMRANGEBYSCORE '
                 '的闭区间、HINCRBY 的字符串返回）：本机没有 Redis，迷你实现只是"文案与 expected 同源"的'
                 '交叉核对，不是判分依据 —— 那部分由容器判题矩阵覆盖（precheck.py 对这两份同样打 SKIP）')
    for qid in ['sys-rubric-0014', 'sys-rubric-0015', 'sys-rubric-0016', 'sys-rubric-0017',
                'sys-rubric-0018', 'ag-rubric-0010', 'ag-rubric-0011', 'ag-rubric-0012',
                'ag-rubric-0013', 'hot-rubric-0013', 'hot-rubric-0014', 'hot-rubric-0015']:
        q = load(qid)
        SKIPS.append('  SKIP  %s（llm-rubric 主观题 / 无 expected 可比对；引用的是官方披露值，'
                     '由 content/knowledge/hot-interviews/bytedance-*.md 的来源清单负责）' % qid)
        src = (q.get('source') or {}).get('company')
        if src != 'ByteDance':
            FAILURES.append('%s: 探针清单里的题不是 ByteDance 的（source.company=%s）' % (qid, src))
        if q['judgeKind'] != 'llm-rubric':
            FAILURES.append('%s: 探针清单说它是主观题，实际 judgeKind=%s' % (qid, q['judgeKind']))


def main():
    probe_precheck_backed()
    probe_ab_buckets()
    probe_breaker()
    probe_config_rollout()
    probe_retry()
    probe_limiter()
    probe_wrr()
    probe_report_verdict()
    probe_event_view()
    probe_pyspark_lag()
    probe_pyspark_pit()
    probe_pyspark_lineage()
    probe_dedup_caliber()
    probe_srm()
    probe_tracking_violations()
    probe_degrade_curves()
    probe_lineage_closure()
    probe_lease_quota()
    probe_idem_window()
    skip_notes()
    print('\n'.join(MEASURED))
    if SKIPS:
        print('\n'.join(SKIPS))
    print('\n量到 %d 项断言，失败 %d 项' % (len(MEASURED), len(FAILURES)))
    for line in FAILURES:
        print('FAIL %s' % line)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
