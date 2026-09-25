#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里巴巴（Alibaba / 阿里云）代码题草稿生成器。

现在这份文件里登记的草稿（`--list` 是唯一权威清单）分两类：
  * **已入库的**（读 `content/questions/` 本体回灌，见 `INGESTED`）：
    algorithms 6（java-junit）+ sql 1（mysql）
  * **还没入库的候选**（由本文件里的模型现算 expected）：
    sql 6（mysql 4 + redis 2）+ big-data 1（pyspark）
主观题（system-design / agent-design / hot-interviews）由另一批负责，本文件不碰。
入库一批之后，候选就变成了"已入库"，但**仍然是模型草稿**（不必挪进 INGESTED）——
`--check` 会拿它们与库里的题逐字段比对，防止"改了题没改模型"。

取材纪律：只出在
  content/knowledge/hot-interviews/alibaba-transactions-and-middleware.md
  content/knowledge/hot-interviews/alibaba-data-and-storage.md
里能落到**官方文档原文的机制 / 约束 / 状态机**上的考点。两份素材的 §7 都写明了
"想写但没找到来源、不许写进题面"的方向（双 11 真实量级、内部栈名 TP/TDDL/库存中心、
AHAS 线上阈值基线、OneData 白皮书细节…），所以：

  * 题面里的阈值 / 时长要么带官方出处编号，要么显式写成"本题设定"；
  * 素材标【推】的部分（AT 可见性分类、TCC 三防判据、预热线性爬坡、限流并账顺序）
    在题面里写成**契约**，绝不写成"阿里官方这么说"；
  * 两份素材都写了"本文不开 react-vitest"（前端 / 客户端无可核查的机制文档）。
    本批的 frontend 题**不碰组件与框架内部**，只把 DataWorks / MSE 文档里可核查的
    **产品状态语义**（强弱规则 × 红橙异常 × 阻塞、泳道标签路由与回落基线）做成视图模型
    —— 出处是控制台产品文档，不是"阿里前端栈"。

代码题的 expected **全部由本文件里的 Python 模型算出**，不手算；
`precheck.py` 用另一份独立重写跑同一批用例；容器矩阵证明判题器真判
（三道闸门分工见 docs/ADD_QUESTIONS.md）。

**本文件的一段历史（别第二次踩）**
最初版本写完、前 7 题入库之后，一次"打补丁再落盘"的脚本把本文件清成了 0 字节：
它调 `io.open(P, 'w', encoding='utf-8', newline='\\\\n')` —— 双反斜杠让 `newline`
变成字面量 `\\n`，而 **`open(..., 'w')` 会先截断文件、之后才校验参数并抛 ValueError**。
教训两条：① 改源文件的补丁脚本必须**先把新内容算完整、再一次性落盘**
（写失败就什么文件都被碰过）；② `newline` 只允许 `'\\n'` / `''` / `None`。

恢复方式：已经入库的题不再由模型现算 —— 生成器**直接读 content/questions/ 里的题本体**
（见下面 `INGESTED`），只剥掉入库时补的字段，于是"生成器 vs 题库"只有一份真相。
曾经在这里放过一个 `frozen/*.json` 副本目录，它漂移过一次（库里改了用例名、副本没跟上），
症状是"生成器自己抛断言"，看起来像生成器坏了 —— 第二真相就是这个下场，已删。
那 6 道 java 题的**独立交叉验证**在 `precheck.py`：那里各有一份**不同算法**的实现
（迁移表 / 时间线物化 / 逐跳推进 / 规则表 / 队列拼接），它读的是生成出来的草稿，
所以"只改库里的题、不改那份重写"会当场红。没入库的题仍由本文件里的模型现算 expected。

用法：
    python scripts/bank/drafts/alibaba/gen.py            # 生成到 data/drafts-ab/out/
    python scripts/bank/drafts/alibaba/gen.py --list     # 只列已登记的题目标识
    python scripts/bank/drafts/alibaba/gen.py --check    # 生成的草稿与已入库的题逐字段比对
    python scripts/bank/drafts/alibaba/gen.py --sync     # 纠正已入库的题：草稿写回库文件并复验
    python scripts/bank/drafts/alibaba/gen.py --sync sql-ab-inventory-reconcile   # 只纠正这一道
"""
import json
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-ab', 'out')
BANK_DIR = os.path.join(ROOT, 'content', 'questions')

TXN = 'content/knowledge/hot-interviews/alibaba-transactions-and-middleware.md'
DATA = 'content/knowledge/hot-interviews/alibaba-data-and-storage.md'

DRAFTS = {}


def draft(key):
    def deco(fn):
        if key in INGESTED:
            # 两边都登记 = 谁覆盖谁看字典顺序，正是"生成器与题库不一致"的形态
            raise AssertionError(f'{key}: 既有模型草稿又被 INGESTED 回灌，只能留一个')
        DRAFTS[key] = fn
        return fn
    return deco


def base(category, difficulty, title, statement, judge_kind, tags, source, **extra):
    return {
        'category': category,
        'difficulty': difficulty,
        'title': title,
        'statement': statement,
        'judgeKind': judge_kind,
        'tags': tags,
        'source': source,
        **extra,
    }


def src(role, ref):
    return {
        'company': 'Alibaba',
        'role': role,
        'location': 'hangzhou',
        'origin': 'manual',
        'jds': [],
        'knowledgeRef': ref,
        'era': '2026',
        'addedBy': 'arena-company-expansion',
    }


class ModelError(Exception):
    """模型层的"必须抛错"。message 就是契约型用例要断言的那句话。"""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def require(cond, message):
    if not cond:
        raise ModelError(message)


def same_len(pairs):
    """pairs = [(name, arr), ...]；null 或长度不一致都抛与 Java 侧同一条消息。"""
    n = None
    for _name, arr in pairs:
        if arr is None:
            raise ModelError('array length mismatch')
        if n is None:
            n = len(arr)
        elif len(arr) != n:
            raise ModelError('array length mismatch')
    return n or 0


def jcase(name, args, model, throws=None, throws_message=None, note=None):
    """java-junit 用例助手。

    **`throws` 是声明，不是推断**：跑一遍模型，抛了却没声明 ⇒ 当场炸；
    声明了却没抛 ⇒ 同样炸；消息不等 ⇒ 也炸。
    """
    if throws is None:
        try:
            got = model(*args)
        except ModelError as exc:
            raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc.message}') from exc
        out = {'name': name, 'input': list(args), 'expected': got}
    else:
        try:
            got = model(*args)
        except ModelError as exc:
            if exc.message != throws_message:
                raise AssertionError(
                    f'用例「{name}」期望消息 "{throws_message}"，实际 "{exc.message}"')
            out = {'name': name, 'input': list(args), 'expected': None,
                   'expectThrow': throws, 'throwMessage': throws_message}
        else:
            raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
    if note:
        out['note'] = note
    return out


# ===================================================================== MySQL 公共底座
#
# 一条用例只描述一次"与基线的差异"：先改**内存行集**，再由同一份行集同时产出
# `runner.setup` / `cases[].input` 的变异 SQL 与 `cases[].expected`。
# 分两处写必然漂移（本仓库 price-grid 那题就是这么算错带 DELETE 的用例的）。
# 因此这里**禁止 `raw` 变异**（只发 SQL、不改内存行集）：只有 ins / del / set / setcol / clr，
# 每一种都必须留下内存行集的改动痕迹。
def sql_lit(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return repr(value) if isinstance(value, float) else str(value)


def sql_seed(schema, seed):
    stmts = ['DROP TABLE IF EXISTS `%s`' % t for t in schema]
    for tbl, spec in schema.items():
        stmts.append('CREATE TABLE %s (%s) ENGINE=InnoDB' % (tbl, ', '.join(spec['ddl'])))
    for tbl, spec in schema.items():
        rows = seed[tbl]
        if rows:
            stmts.append('INSERT INTO %s VALUES %s' % (tbl, ', '.join(
                '(' + ', '.join(sql_lit(v) for v in row) + ')' for row in rows)))
    return stmts


def mut_case(name, schema, seed, mutations, columns, evaluate, note=None):
    """变异驱动的 MySQL 用例。写错主键、写未知变异、名字与内容不符都会当场炸。"""
    rows = {t: [list(r) for r in seed[t]] for t in schema}
    sqls = []
    for mut in mutations:
        kind = mut[0]
        if kind == 'ins':
            _, tbl, row = mut
            spec = schema[tbl]
            if len(row) != len(spec['cols']):
                raise AssertionError(f'用例「{name}」插进 {tbl} 的行有 {len(row)} 列，'
                                     f'表定义是 {len(spec["cols"])} 列')
            for cur in rows[tbl]:
                if cur[spec['pk_idx']] == row[spec['pk_idx']]:
                    raise AssertionError(f'用例「{name}」插入的主键重复：{tbl}.{row[spec["pk_idx"]]}')
            rows[tbl].append(list(row))
            require_unique_pk(name, tbl, spec, rows[tbl])
            sqls.append('INSERT INTO %s VALUES (%s)'
                        % (tbl, ', '.join(sql_lit(v) for v in row)))
        elif kind == 'del':
            _, tbl, pk = mut
            spec = schema[tbl]
            before = len(rows[tbl])
            rows[tbl] = [r for r in rows[tbl] if r[spec['pk_idx']] != pk]
            if len(rows[tbl]) == before:
                raise AssertionError(f'用例「{name}」删了不存在的主键 {tbl}.{pk}')
            sqls.append('DELETE FROM %s WHERE %s = %s' % (tbl, spec['pk'], sql_lit(pk)))
        elif kind == 'set':
            _, tbl, pk, changes = mut
            spec = schema[tbl]
            hit = 0
            for row in rows[tbl]:
                if row[spec['pk_idx']] == pk:
                    for col, val in changes.items():
                        row[spec['cols'].index(col)] = val
                    hit += 1
            if not hit:
                raise AssertionError(f'用例「{name}」改了不存在的主键 {tbl}.{pk}')
            require_unique_pk(name, tbl, spec, rows[tbl])
            sets = ', '.join('%s = %s' % (c, sql_lit(v)) for c, v in changes.items())
            sqls.append('UPDATE %s SET %s WHERE %s = %s'
                        % (tbl, sets, spec['pk'], sql_lit(pk)))
        elif kind == 'setpk':
            # 按**声明主键的每一列**定位一行。`set` 只认 table_spec 里那一个 pk 代理列，
            # 在复合主键 + 故意重复的表上会一次改到多行（`shard_row` 的 row_id 就是这种）。
            _, tbl, match, changes = mut
            spec = schema[tbl]
            hit = 0
            for row in rows[tbl]:
                if all(row[spec['cols'].index(c)] == v for c, v in match.items()):
                    for col, val in changes.items():
                        row[spec['cols'].index(col)] = val
                    hit += 1
            if hit == 0:
                raise AssertionError(f'用例「{name}」的 setpk 没命中任何行：{tbl}.{match}')
            if hit > 1:
                raise AssertionError(
                    f'用例「{name}」的 setpk 命中 {hit} 行，匹配条件不够定位一行：{tbl}.{match}')
            require_unique_pk(name, tbl, spec, rows[tbl])
            sets = ', '.join('%s = %s' % (c, sql_lit(v)) for c, v in changes.items())
            where = ' AND '.join('%s = %s' % (c, sql_lit(v)) for c, v in match.items())
            sqls.append('UPDATE %s SET %s WHERE %s' % (tbl, sets, where))
        elif kind == 'setcol':
            _, tbl, wcol, wval, col, val = mut
            spec = schema[tbl]
            hit = 0
            for row in rows[tbl]:
                if row[spec['cols'].index(wcol)] == wval:
                    row[spec['cols'].index(col)] = val
                    hit += 1
            if hit == 0:
                raise AssertionError(f'用例「{name}」的 setcol 没命中任何行：{tbl}.{wcol}={wval}')
            require_unique_pk(name, tbl, spec, rows[tbl])
            sqls.append('UPDATE %s SET %s = %s WHERE %s = %s'
                        % (tbl, col, sql_lit(val), wcol, sql_lit(wval)))
        elif kind == 'delcol':
            _, tbl, wcol, wval = mut
            spec = schema[tbl]
            idx = spec['cols'].index(wcol)
            before = len(rows[tbl])
            rows[tbl] = [r for r in rows[tbl] if r[idx] != wval]
            if len(rows[tbl]) == before:
                raise AssertionError(f'用例「{name}」的 delcol 没命中任何行：{tbl}.{wcol}={wval}')
            sqls.append('DELETE FROM %s WHERE %s = %s' % (tbl, wcol, sql_lit(wval)))
        elif kind == 'clr':
            _, tbl = mut
            if not rows[tbl]:
                raise AssertionError(f'用例「{name}」清空了一张本来就空的表 {tbl}')
            rows[tbl] = []
            sqls.append('DELETE FROM %s' % tbl)
        else:
            raise AssertionError(f'用例「{name}」用了未知变异 {kind}')
    computed = evaluate(rows)
    case = {'name': name, 'input': sqls}
    if computed:
        case['expected'] = {'columns': columns, 'rows': computed, 'orderSensitive': True}
    else:
        # 空结果集**必须**写裸 []：mysql --batch 在 0 行时连表头都不输出，
        # 带 columns 的期望值会报"列名不一致"——那是构造上判不了的（docs/JUDGING.md mysql 一节）。
        case['expected'] = []
    if note:
        case['note'] = note
    if computed and '空集' in name:
        raise AssertionError(f'用例「{name}」名字叫空集，模型却给出了 {len(computed)} 行')
    return case


def table_spec(pk, cols, ddl):
    return {'pk': pk, 'pk_idx': cols.index(pk), 'cols': cols, 'ddl': ddl}


def pk_columns(spec):
    """从 DDL 里读**声明的主键列**（复合主键只有 DDL 知道，table_spec 的 pk 只是单列代理）。"""
    m = re.search(r'PRIMARY KEY \(([^)]+)\)', ' '.join(spec['ddl']))
    if not m:
        return []
    return [c.strip() for c in m.group(1).split(',')]


def require_unique_pk(name, tbl, spec, rowset):
    """Python 侧改列**不会**撞主键，真 MySQL 会（1062）。

    这类分歧只有读一遍声明主键才拦得住：本文件的模型是"行清单"，
    而 `UPDATE ... SET 某列 = 某值` 在复合主键表上完全可能把两行压成同一把键。
    历史上这条是容器矩阵抓出来的（`shard_row` 把分片 2 的行搬到分片 0 ⇒
    `(0, 5007)` 出现两次，静态看语法完全正常）。
    """
    cols = pk_columns(spec)
    if len(cols) < 2:
        return
    idx = [spec['cols'].index(c) for c in cols]
    seen = set()
    for r in rowset:
        key = tuple(r[i] for i in idx)
        if key in seen:
            raise AssertionError(
                f'用例「{name}」让 {tbl} 的复合主键 {key} 重复（模型不会撞、MySQL 会 1062）')
        seen.add(key)


# ===================================================================== B / F 公共底座
def pycase(name, schema, view, rows, model, note=None):
    """pyspark 用例助手：expected 由模型算，input 就是那张表的行。"""
    out = {'name': name, 'input': {'view': view, 'schema': schema, 'rows': rows},
           'expected': model(rows)}
    if note:
        out['note'] = note
    return out


def ts_case(name, args, model, throws_message=None, note=None):
    """react-vitest 用例助手：与 jcase 同一套"throws 是声明"的纪律。"""
    if throws_message is None:
        try:
            got = model(*args)
        except ModelError as exc:
            raise AssertionError(f'用例「{name}」没声明抛错，但模型抛了 {exc.message}') from exc
        case = {'name': name, 'input': list(args), 'expected': got}
    else:
        try:
            got = model(*args)
        except ModelError as exc:
            if exc.message != throws_message:
                raise AssertionError(
                    f'用例「{name}」期望消息 "{throws_message}"，实际 "{exc.message}"')
            case = {'name': name, 'input': list(args), 'expected': None,
                    'expectThrow': 'Error', 'throwMessage': throws_message}
        else:
            raise AssertionError(f'用例「{name}」声明了抛错，但模型正常返回 {got}')
    if note:
        case['note'] = note
    return case


def ts_test_file(fn_name, describe_title, cases):
    """从**同一批模型输出**生成 vitest 断言文件（消息断言必须写进这里才参与判分）。"""
    lines = [
        "import { describe, expect, it } from 'vitest';",
        "import { %s } from './Solution';" % fn_name,
        '',
        '/**',
        ' * 断言由 gen.py 里同一个 Python 模型生成，不手抄 ——',
        ' * react-vitest 题的判分事实来源就是这份文件，抄错一次就永久错一次。',
        ' * 契约型用例断言到**消息**：只写 .toThrow() 会让几条"都该抛错"的用例收敛成同一条。',
        ' */',
        "describe('%s', () => {" % describe_title,
    ]
    for c in cases:
        call = '%s(%s)' % (fn_name, ', '.join(
            json.dumps(a, ensure_ascii=False) for a in c['input']))
        if c.get('expectThrow'):
            body = "expect(() => %s).toThrow(%s)" % (
                call, json.dumps(c['throwMessage'], ensure_ascii=False))
        else:
            body = "expect(%s).toEqual(%s)" % (call, json.dumps(c['expected'], ensure_ascii=False))
        lines.append("  it(%s, () => {" % json.dumps(c['name'], ensure_ascii=False))
        lines.append('    %s;' % body)
        lines.append('  });')
    lines.append('});')
    return '\n'.join(lines)


# ======================================================== 已入库的题：读题库本体回灌
# 这里**不在本目录另存副本**（历史见文件头）。读 content/questions/ 里的题本体，
# 只剥掉 `ingest()` 补的那几个字段，得到与"当初喂给入库的那份草稿"等价的输入。
# 于是 `python gen.py` → `npm run bank:add -- <这些文件>` 必须逐份报
# "跳过（同 id / 同题面已存在）"：一题不新增、一题不改写 —— 这就是①的验收。
#
# key -> (库里的文件, 标题里必须出现的词)
# 那第二个值不是装饰：本批入库编号与草稿 key 的顺序**对不上号**
# （alg-java-0052 是消费重试、alg-java-0054 才是 AT 可见性），
# 只按编号猜就会把 A 题的草稿写成 B 题，而且 bank:add 照样"跳过"、看不出来。
INGESTED = {
    'alg-ab-consume-retry': ('content/questions/algorithms/alg-java-0052.json', '消费重试'),
    'alg-ab-fifo-queue-placement': ('content/questions/algorithms/alg-java-0053.json', '顺序消息的放置'),
    'alg-ab-seata-at-isolation': ('content/questions/algorithms/alg-java-0054.json', 'Seata AT'),
    'alg-ab-system-adaptive-admission': ('content/questions/algorithms/alg-java-0055.json', '系统自适应'),
    'alg-ab-tcc-lifecycle': ('content/questions/algorithms/alg-java-0056.json', 'TCC 分支生命周期'),
    'alg-ab-timer-horizon': ('content/questions/algorithms/alg-java-0057.json', '定时消息'),
    'sql-ab-halfmsg-reconcile': ('content/questions/sql/sql-mysql-0030.json', '事务消息对账'),
    # 候选入库之后不必挪进这里（文件头说明了原因）：--check 拿模型草稿与库里的题逐字段比。
    # 但**入库了的必须能对上**，对不上就是"改了库里的题没改模型"。
}

# 入库时由 ingest()/zod 补上、草稿不许带的字段（SourceDraft 是 strict 的）
DRAFT_FREE_FIELDS = ('id', 'schemaVersion')
DRAFT_FREE_SOURCE = ('ingestedAt',)
DRAFT_FREE_CASE = ('visible',)

# 与上面相反：这几个是 zod **补默认值**的字段，库里一定有、草稿里可能没写。
# 删掉它们会让"库里 orderSensitive: true / 草稿忘了写"也看不出来，
# 所以两边都补齐（判据取自 shared/src/question.ts 的 .default(...)）。
RUNNER_DEFAULTS = {'entry': 'function', 'orderSensitive': False, 'timeoutMs': 20000}


def fill_runner_defaults(q):
    runner = q.get('runner')
    if isinstance(runner, dict):
        for key, value in RUNNER_DEFAULTS.items():
            runner.setdefault(key, value)
    return q


def strip_ingested_fields(q):
    """题库里的题 → 入库前那份草稿。剥错字段 = bank:add 报看不懂的 schema 错。"""
    out = {k: v for k, v in q.items() if k not in DRAFT_FREE_FIELDS}
    out['source'] = {k: v for k, v in (out.get('source') or {}).items()
                     if k not in DRAFT_FREE_SOURCE}
    out['cases'] = [{k: v for k, v in c.items() if k not in DRAFT_FREE_CASE}
                    for c in (out.get('cases') or [])]
    if isinstance(out.get('runner'), dict):      # 不原地改：bank_index 里那份还要给别的草稿比
        out['runner'] = dict(out['runner'])
    return out


def check_draft_shape(key, q):
    """草稿的最低形态要求（判据与 server/test/bank/content.test.ts 的 A 段同源）。

    放在生成器里而不是只放在闸门里，是因为"生成器算出来的东西不合规"这件事
    应该在落盘那一刻就炸，而不是等下一次容器验证。
    """
    cases = q.get('cases') or []
    if len(cases) < 3:
        raise AssertionError(f'{key}: 用例数 {len(cases)} < 3')
    runner = q.get('runner') or {}
    if not runner.get('referenceSolution'):
        raise AssertionError(f'{key}: 缺 referenceSolution')
    if not runner.get('naiveSolution'):
        raise AssertionError(f'{key}: 缺 naiveSolution')
    tags = q.get('tags') or []
    if len(tags) > 6:
        raise AssertionError(f'{key}: 标签 {len(tags)} 个 > 6')
    names = ' '.join(c['name'] for c in cases)
    if not any(x in names for x in ('空', '边界', '退化', '并列', '重复', '非法')):
        raise AssertionError(f'{key}: 没有边界用例')
    titles = [c['name'] for c in cases]
    text = (q.get('answer') or '') + '\n' + (q.get('statement') or '')
    for m in re.finditer('用例「([^」]+)」', text):
        ref = m.group(1)
        if not any(ref == t or ref in t or t in ref for t in titles):
            raise AssertionError(f'{key}: 文案点名用例「{ref}」但用例表里没有')


def read_bank_question(rel_path, key, title_hint):
    path = os.path.join(ROOT, *rel_path.split('/'))
    if not os.path.exists(path):
        raise AssertionError(f'{key}: 题库文件不存在 {rel_path}')
    with open(path, encoding='utf-8') as fh:
        raw = fh.read()
    if '\r' in raw:
        raise AssertionError(f'{key}: {rel_path} 里有 CR（题库文件必须 LF）')
    q = json.loads(raw)
    stem = os.path.basename(path)[: -len('.json')]
    if q.get('id') != stem:
        raise AssertionError(f"{key}: {rel_path} 的内部 id {q.get('id')!r} 与文件名不符")
    if title_hint not in (q.get('title') or ''):
        raise AssertionError(f"{key}: {rel_path} 的标题里没有 {title_hint!r}（编号与内容对不上号）")
    return q


def ingested_draft(key):
    rel_path, title_hint = INGESTED[key]

    def load():
        q = strip_ingested_fields(read_bank_question(rel_path, key, title_hint))
        check_draft_shape(key, q)
        return q
    return load


def bank_index():
    """整库的 statement → [(相对路径, 题目)]，`--check` 用它对齐草稿（不认编号）。"""
    idx = {}
    for dirpath, _dirs, files in os.walk(BANK_DIR):
        for name in sorted(files):
            if not name.endswith('.json'):
                continue
            full = os.path.join(dirpath, name)
            rel_path = os.path.relpath(full, ROOT).replace(os.sep, '/')
            with open(full, encoding='utf-8') as fh:
                q = json.load(fh)
            idx.setdefault(q.get('statement'), []).append((rel_path, q))
    return idx


def check_against_bank():
    """`--check`：每份草稿若在库里已有同题面，就逐字段比一遍。

    它抓的是"改了库里的题、忘了改模型"（未入库的模型草稿没有可比对象，只报数量）。
    已入库的那几道回灌草稿当然恒等 —— 它们的验收在 `bank:add` 的"跳过"。
    """
    idx = bank_index()
    same, untracked, drift = [], [], []
    for key, fn in sorted(DRAFTS.items()):
        payload = fill_runner_defaults(fn())
        hits = idx.get(payload.get('statement'))
        if not hits:
            untracked.append(key)
            continue
        rel_path, bank_q = hits[0]
        expect = fill_runner_defaults(strip_ingested_fields(bank_q))
        if json.dumps(expect, ensure_ascii=False, sort_keys=True) != \
                json.dumps(payload, ensure_ascii=False, sort_keys=True):
            diff = sorted(k for k in set(expect) | set(payload)
                          if expect.get(k, '@') != payload.get(k, '@'))
            drift.append(f'{key} vs {rel_path}: 不一致字段 {diff}')
        else:
            same.append(key)
    for line in drift:
        print('DRIFT %s' % line)
    print('[check] 与题库逐字段一致 %d 份｜未入库（无比对对象）%d 份｜漂移 %d 份'
          % (len(same), len(untracked), len(drift)))
    if untracked:
        print('  未入库：' + ', '.join(untracked))
    return 1 if drift else 0


for _key in sorted(INGESTED):
    if _key in DRAFTS:
        raise AssertionError(f'{_key}: 同一个 key 既是模型草稿又是回灌草稿')
    DRAFTS[_key] = ingested_draft(_key)

# ===================================================================== M2 Hologres 访问路径判定
@draft('sql-ab-hologres-access-path')
def q_hologres_access_path():
    TABLES = [
        # tbl, orientation(row|column|both), pk_cols, dist_key, cluster_key, seg_key,
        # bitmap_cols, ttl_days, pk_is_serial
        ['ord', 'column', 'order_id', 'order_id', 'pay_time', 'gmt_create', 'shop_id,pay_type', 0, 0],
        ['risk_point', 'row', 'user_id', 'user_id', 'event_time', 'event_time', '', 7, 0],
        ['dim_shop', 'both', '', 'shop_id', '', '', 'city,brand', 0, 0],
        ['evt', 'both', 'evt_id', 'user_id', 'evt_time', 'evt_time', 'biz_type', 0, 0],
        ['serial_t', 'column', 'id', 'id', 'created_at', 'created_at', '', 0, 1],
    ]
    QUERIES = [
        [1, 'ord', 'point', 'order_id', ''],
        [2, 'risk_point', 'point', 'user_id', ''],
        [3, 'risk_point', 'point', 'event_time', ''],
        [4, 'ord', 'agg', '', 'gmt_create'],
        [5, 'dim_shop', 'agg', '', ''],
        [6, 'ord', 'range', '', 'gmt_create'],
        [7, 'ord', 'range', '', 'pay_time'],
        [8, 'dim_shop', 'eq', 'city', ''],
        [9, 'dim_shop', 'eq', 'shop_id', ''],
        [10, 'evt', 'eq', 'biz_type', ''],
        [11, 'evt', 'agg', '', 'evt_time'],
        [12, 'serial_t', 'point', 'id', ''],
    ]
    COLS = ['qid', 'tbl', 'pattern', 'access_path', 'shard_pruned', 'config_risk']

    def evaluate(rows):
        tab = {t[0]: t for t in rows['holo_table']}
        out = []
        for qid, tbl, pattern, filters, range_col in sorted(rows['query_log'], key=lambda r: r[0]):
            t = tab.get(tbl)
            if t is None:
                continue
            orient, pk, dist, cluster, seg, bitmap = t[1], t[2], t[3], t[4], t[5], t[6]
            ttl, serial = t[7], t[8]
            row_point = any(q[1] == tbl and q[2] == 'point' for q in rows['query_log'])
            pruned = 1 if (dist != '' and filters == dist) else 0
            if pattern == 'point':
                if pk == '':
                    path = 'no-pk-scan'
                elif filters == pk and orient in ('row', 'both'):
                    path = 'pk-point-lookup'
                elif filters == pk:
                    path = 'pk-index-on-column'
                elif orient in ('row', 'both'):
                    path = 'pk-partial-scan'
                else:
                    path = 'pk-partial-on-column'
            elif pattern == 'agg':
                if orient == 'row':
                    path = 'row-scan-for-agg'
                elif seg != '' and range_col == seg:
                    path = 'agg-segment-pruned'
                else:
                    path = 'agg-column-scan'
            elif pattern == 'range':
                if seg != '' and range_col == seg:
                    path = 'segment-pruned'
                elif cluster != '' and range_col == cluster:
                    path = 'cluster-sorted-scan'
                else:
                    path = 'full-scan'
            else:
                if filters != '' and filters in bitmap.split(','):
                    path = 'bitmap-index-scan'
                elif pruned == 1:
                    path = 'shard-local-scan'
                else:
                    path = 'seq-scan'
            if serial == 1:
                risk = 'serial-pk'
            elif ttl > 0 and pk != '':
                risk = 'ttl-on-pk-table'
            elif dist != '' and pk != '' and dist != pk:
                risk = 'dist-key-not-in-pk'
            elif orient == 'column' and row_point:
                risk = 'column-for-point'
            elif cluster != '' and cluster == seg:
                risk = 'cluster-equals-segment'
            else:
                risk = 'none'
            out.append([qid, tbl, pattern, path, pruned, risk])
        return out

    SCHEMA = {
        'holo_table': table_spec(
            'tbl',
            ['tbl', 'orientation', 'pk_cols', 'dist_key', 'cluster_key', 'seg_key',
             'bitmap_cols', 'ttl_days', 'pk_is_serial'],
            ['tbl VARCHAR(32) NOT NULL PRIMARY KEY', 'orientation VARCHAR(8) NOT NULL',
             'pk_cols VARCHAR(32) NOT NULL', 'dist_key VARCHAR(32) NOT NULL',
             'cluster_key VARCHAR(32) NOT NULL', 'seg_key VARCHAR(32) NOT NULL',
             'bitmap_cols VARCHAR(128) NOT NULL', 'ttl_days INT NOT NULL',
             'pk_is_serial INT NOT NULL']),
        'query_log': table_spec(
            'qid',
            ['qid', 'tbl', 'pattern', 'filters', 'range_col'],
            ['qid INT NOT NULL PRIMARY KEY', 'tbl VARCHAR(32) NOT NULL',
             'pattern VARCHAR(8) NOT NULL', 'filters VARCHAR(32) NOT NULL',
             'range_col VARCHAR(32) NOT NULL']),
    }
    SEED = {'holo_table': [list(r) for r in TABLES],
            'query_log': [list(r) for r in QUERIES]}

    cases = [
        mut_case('基线：十二类查询各落一种访问路径，配置风险按优先级只报一条',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='qid1 列存按主键点查 ⇒ pk-index-on-column；qid2 行存按主键 ⇒ pk-point-lookup；'
                      'qid6 命中分段键 ⇒ segment-pruned；qid7 只命中聚簇键 ⇒ cluster-sorted-scan；'
                      'qid11 是 both 表且范围谓词正好落在分段键上 ⇒ agg-segment-pruned'),
        mut_case('边界：把 ord 的分段键改成与聚簇键同列 ⇒ 三条路径重算，风险列按优先级仍停在"列存做点查"',
                 SCHEMA, SEED,
                 [('set', 'holo_table', 'ord', {'seg_key': 'pay_time'})], COLS, evaluate,
                 note='ord 是列存表且 pk/dist 合规 ⇒ 第 4 条（column-for-point）排在第 5 条前面，'
                      '风险列不动；但 qid4/qid6/qid7 三条路径全跟着 seg_key 变'),
        mut_case('边界：清掉 TTL ⇒ risk_point 的配置风险换成"聚簇键与分段键同列"',
                 SCHEMA, SEED,
                 [('set', 'holo_table', 'risk_point', {'ttl_days': 0})], COLS, evaluate),
        mut_case('边界：把 evt 的分布键改成与主键同列 ⇒ dist-key-not-in-pk 消失，两键互顶浮出',
                 SCHEMA, SEED,
                 [('set', 'holo_table', 'evt', {'dist_key': 'evt_id'})], COLS, evaluate,
                 note='qid9 的 shard_pruned 同时从 1 变 0：分布键改对了（等于主键），'
                      '却把"按 shop 维度的查询"弄成跨片 —— 一列动、两列变'),
        mut_case('退化：查询日志为空 ⇒ 结果必须是空集（表配置再差也不许凭空出行）',
                 SCHEMA, SEED, [('clr', 'query_log')], COLS, evaluate),
        mut_case('非法形态：查询打着一张不存在的表 ⇒ 整行不出现，不许猜路径',
                 SCHEMA, SEED,
                 [('ins', 'query_log', [13, 'typo_tbl', 'point', 'id', ''])], COLS, evaluate,
                 note='LEFT JOIN 到不存在的表上 pk_cols 是 NULL，三值逻辑下与空串比较都不成立 ⇒ '
                      '报表里会多出一条"某张不存在的表在做顺序扫描"，污染按表去重的风险计数'),
        mut_case('边界：无主键的列存表做点查 ⇒ no-pk-scan 而 shard_pruned 仍可为 1',
                 SCHEMA, SEED,
                 [('set', 'holo_table', 'dim_shop', {'orientation': 'column'}),
                  ('ins', 'query_log', [14, 'dim_shop', 'point', 'shop_id', ''])], COLS, evaluate,
                 note='qid14：dim_shop 无主键 ⇒ 第 1 条就命中 no-pk-scan（轮不到第 3 条的主键索引），'
                      '但分布键命中 ⇒ shard_pruned=1。两列各自成立，'
                      '说明"分片裁剪"与"点查形态"是两件不同的事'),
    ]

    reference = """SELECT q.qid                                            AS qid,
       q.tbl                                              AS tbl,
       q.pattern                                          AS pattern,
       CASE
         WHEN q.pattern = 'point' AND t.pk_cols = '' THEN 'no-pk-scan'
         WHEN q.pattern = 'point' AND q.filters = t.pk_cols AND t.orientation <> 'column'
           THEN 'pk-point-lookup'
         WHEN q.pattern = 'point' AND q.filters = t.pk_cols THEN 'pk-index-on-column'
         WHEN q.pattern = 'point' AND t.orientation <> 'column' THEN 'pk-partial-scan'
         WHEN q.pattern = 'point' THEN 'pk-partial-on-column'
         WHEN q.pattern = 'agg' AND t.orientation = 'row' THEN 'row-scan-for-agg'
         WHEN q.pattern = 'agg' AND t.seg_key <> '' AND q.range_col = t.seg_key
           THEN 'agg-segment-pruned'
         WHEN q.pattern = 'agg' THEN 'agg-column-scan'
         WHEN q.pattern = 'range' AND t.seg_key <> '' AND q.range_col = t.seg_key
           THEN 'segment-pruned'
         WHEN q.pattern = 'range' AND t.cluster_key <> '' AND q.range_col = t.cluster_key
           THEN 'cluster-sorted-scan'
         WHEN q.pattern = 'range' THEN 'full-scan'
         WHEN q.filters <> '' AND FIND_IN_SET(q.filters, t.bitmap_cols) > 0
           THEN 'bitmap-index-scan'
         WHEN t.dist_key <> '' AND q.filters = t.dist_key THEN 'shard-local-scan'
         ELSE 'seq-scan'
       END                                                AS access_path,
       CASE WHEN t.dist_key <> '' AND q.filters = t.dist_key THEN 1 ELSE 0 END AS shard_pruned,
       CASE
         WHEN t.pk_is_serial = 1 THEN 'serial-pk'
         WHEN t.ttl_days > 0 AND t.pk_cols <> '' THEN 'ttl-on-pk-table'
         WHEN t.dist_key <> '' AND t.pk_cols <> '' AND t.dist_key <> t.pk_cols
           THEN 'dist-key-not-in-pk'
         WHEN t.orientation = 'column'
              AND EXISTS (SELECT 1 FROM query_log p2
                          WHERE p2.tbl = t.tbl AND p2.pattern = 'point')
           THEN 'column-for-point'
         WHEN t.cluster_key <> '' AND t.cluster_key = t.seg_key THEN 'cluster-equals-segment'
         ELSE 'none'
       END                                                AS config_risk
FROM query_log q
JOIN holo_table t ON t.tbl = q.tbl
ORDER BY q.qid"""

    naive = """SELECT q.qid    AS qid,
       q.tbl      AS tbl,
       q.pattern  AS pattern,
       CASE WHEN q.pattern = 'point' THEN 'pk-point-lookup'
            WHEN q.range_col <> '' THEN 'segment-pruned'
            WHEN q.pattern = 'agg' THEN 'olap-scan'
            ELSE 'seq-scan' END AS access_path,
       1 AS shard_pruned,
       'none' AS config_risk
FROM query_log q
JOIN holo_table t ON t.tbl = q.tbl
ORDER BY q.qid"""

    statement = """## 背景

Hologres 官方把自己定位成"支持 PB 级多维分析（OLAP）与即席分析，
**支持高并发低延迟的在线数据服务（Serving）**"【源 D14】，
并把"同一份数据既要被聚合分析、又要被高 QPS 点查"拆成**几个互相独立的表属性**
【源 D11/D12/D13】：

| 属性 | 官方原话（摘要） | 解决什么 |
| --- | --- | --- |
| `orientation` | 列存"海量聚合分析首选"；行存"**专门为基于主键的点查 Point Lookup 优化，响应速度可达毫秒级**" | 数据**怎么存** |
| 主键索引 | "系统自动在底层保存一个主键索引文件，**采用行存结构**，Key = 表主键，Value = RID + 聚簇索引" | 主键冲突判定、按主键定位 |
| `distribution_key` | 分片存储；默认取主键、建议只选一列且是主键子集 | **要不要跨 shard** |
| `clustering_key` | **文件内排序**，默认为空、建议最多一列且只支持升序 | 文件内少读 |
| `event_time_column`（Segment Key） | 适用"**含范围过滤条件（包括等值条件）**的查询"与"**基于主键的 UPDATE**"；机制是"数据文件基于该列范围排序后合并、**减少文件之间的重叠**" | **文件级裁剪** |
| `bitmap_columns` | 低基数列等值过滤 | 等值过滤 |

另有两条官方"反面建议"，本题做成配置风险列：
**不建议把 Serial 设为主键**（写入时是表锁、长度易溢出）【源 D13】；
**TTL 非精确删除**（"到期后数据会在某一段时间删除……**因此可能出现 PK 重复或者查询结果不一致**"，
官方建议改用分区表）【源 D11】。

## 表

```
holo_table(tbl VARCHAR(32) PK, orientation VARCHAR(8),      -- 'row' | 'column' | 'both'
           pk_cols VARCHAR(32),      -- 主键列名，'' = 无主键（本题主键都是单列）
           dist_key VARCHAR(32), cluster_key VARCHAR(32), seg_key VARCHAR(32),
           bitmap_cols VARCHAR(128),                        -- 逗号分隔，'' = 没配
           ttl_days INT, pk_is_serial INT)
query_log(qid INT PK, tbl VARCHAR(32), pattern VARCHAR(8),  -- 'point'|'agg'|'range'|'eq'
          filters VARCHAR(32),      -- 等值过滤列（point 传主键列），'' = 没有
          range_col VARCHAR(32))    -- 范围谓词列，'' = 没有
```

## 任务

只交**一条 SELECT**（`query_log JOIN holo_table`），按 `qid` 升序输出：

```
qid, tbl, pattern, access_path, shard_pruned, config_risk
```

`access_path` 判据（**从上到下命中即止**；下文"行存形态"指 `orientation <> 'column'`）：

| # | 条件 | `access_path` |
| --- | --- | --- |
| 1 | `pattern='point'` 且 `pk_cols=''` | `no-pk-scan` |
| 2 | `point` 且 `filters = pk_cols` 且 行存形态 | `pk-point-lookup` |
| 3 | `point` 且 `filters = pk_cols`（列存表） | `pk-index-on-column` |
| 4 | `point` 且 行存形态（过滤列不是主键） | `pk-partial-scan` |
| 5 | `point` 其余 | `pk-partial-on-column` |
| 6 | `agg` 且 `orientation='row'` | `row-scan-for-agg` |
| 7 | `agg` 且 `range_col = seg_key`（`seg_key` 非空） | `agg-segment-pruned` |
| 8 | `agg` 其余 | `agg-column-scan` |
| 9 | `range` 且 `range_col = seg_key` | `segment-pruned` |
| 10 | `range` 且 `range_col = cluster_key` | `cluster-sorted-scan` |
| 11 | `range` 其余 | `full-scan` |
| 12 | `eq` 且 `filters` 出现在 `bitmap_cols` 里 | `bitmap-index-scan` |
| 13 | `eq` 且 `filters = dist_key`（`dist_key` 非空） | `shard-local-scan` |
| 14 | 其余 | `seq-scan` |

`shard_pruned` = （`dist_key` 非空且 `filters = dist_key`）? `1` : `0`。

`config_risk` 判据（**同样从上到下，只报第一条**）：

| # | 条件 | `config_risk` |
| --- | --- | --- |
| 1 | `pk_is_serial = 1` | `serial-pk` |
| 2 | `ttl_days > 0` 且 `pk_cols <> ''` | `ttl-on-pk-table` |
| 3 | `dist_key <> ''` 且 `pk_cols <> ''` 且 `dist_key <> pk_cols` | `dist-key-not-in-pk` |
| 4 | `orientation = 'column'` 且**该表存在任意一条 `point` 查询** | `column-for-point` |
| 5 | `cluster_key <> ''` 且 `cluster_key = seg_key` | `cluster-equals-segment` |
| 6 | 其余 | `none` |

## 三条口径纪律

- **第 4 条要 `EXISTS` 而不是判当前行**："列存表上有点查"是**表级**配置问题，
  它要在该表的每一条查询记录上都显示出来。写成"当前行 pattern='point' 才算"
  会让同一张表报出两种风险（点查那行有、聚合那行没有），
  而看板按表去重统计"有风险的表数"时就会漏。
- **第 3 条要求 `pk_cols <> ''`**：无主键的表谈不上"分布键不是主键子集"
  （官方那条建议的前提是"默认取主键、建议是主键子集"）。
  漏掉这个前提会把故意无主键的表报成配置错误。
- **`shard_pruned` 与 `access_path` 必须分列**：分片裁剪解决"要扫多少个 shard"，
  点查形态解决"单个 shard 里怎么走索引"。一张表可以两个都好、也可以一好一坏
  （用例「无主键的列存表做点查」就是后者）。

只允许一条 `SELECT`。"""

    return base(
        'sql', 'principal',
        'Hologres 表属性 × 查询模式：点查形态、分段键与聚簇键、分片裁剪与配置风险各是各的',
        statement, 'mysql',
        ['hologres', 'access-path', 'segment-key', 'distribution-key',
         'ttl-pk-duplication', 'modern:olap-serving'],
        src('数据研发（实时数仓 / OLAP 服务层方向） 技术专家',
            DATA + '#4 考点 9（OLAP 选型【源 D11/D12/D13/D14】：列存/行存适用面、'
            '主键索引是行存文件（Value=RID+聚簇键）、四类表属性各自解决什么、'
            '不建议 Serial 做主键、TTL 非精确删除会出现 PK 重复、聚簇索引=文件内排序 vs '
            '分段键=文件级裁剪；素材该考点的出题建议正是"给一张订单明细与 5 条真实查询，'
            '写哪些走预聚合、哪些走主键点查、哪些必须扫分区的分层方案与索引映射"。'
            '优先级表与 config_risk 的五条排序是【推】，题面已写成契约）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案

一条 `JOIN` + 两个多档 `CASE`。判分点全在**顺序**与"哪些条件要判空串"。

**基线 12 行的 `access_path`**：qid1 `pk-index-on-column`（列存表按主键点查 ——
主键索引文件是行存结构，但表体不是点查形态）、qid2 `pk-point-lookup`、
qid3 `pk-partial-scan`（行存表按非主键列查）、qid4 `agg-segment-pruned`、
qid5 `agg-column-scan`、qid6 `segment-pruned`、qid7 `cluster-sorted-scan`、
qid8 `bitmap-index-scan`、qid9 `shard-local-scan`、qid10 `bitmap-index-scan`
（`biz_type` 在 evt 的 bitmap 列里）、qid11 `agg-segment-pruned`（both 表的范围谓词
正好落在分段键上）、qid12 `pk-index-on-column`（serial_t 是列存，命中第 3 条）。

**`config_risk` 基线按表只有五种取值**：`ord` → `column-for-point`（该表有 qid1 这条 point）、
`risk_point` → `ttl-on-pk-table`、`dim_shop` → `none`、
`evt` → `dist-key-not-in-pk`（分布键 `user_id` 不等于主键 `evt_id`）、
`serial_t` → `serial-pk`。
**优先级在这里不是纸面要求**：`risk_point` 的 `cluster_key` 与 `seg_key` 同为 `event_time`
（第 5 条也成立），但它只报 `ttl-on-pk-table`；`evt` 与 `serial_t` 同样满足第 5 条，
却分别被第 3 条、第 1 条挡在前面。一张表报五条风险 = 一条都不会被修。

**用例「清掉 TTL」把 `risk_point` 的 `ttl_days` 置 0** ⇒ 它的风险列换成
`cluster-equals-segment`。这条专门用来证明优先级链**真的按顺序走**：
只实现第 2 条（TTL）的实现会给出 `none`；而把第 5 条放在最前的实现会顺手把 `evt`、
`serial_t` 也报成互顶（它们两键确实同列），盖掉真正该先报的第 3 条与第 1 条。
素材把"聚簇索引是文件内排序、分段键是文件级裁剪，**两者都当范围谓词用会互相顶掉收益**"
标为【推】，本题把它做成一条可判的枚举。

**用例「把 ord 的分段键改成与聚簇键同列」一次改了三条路径，但**不改**风险列**：
qid4 从 `agg-segment-pruned` 掉到 `agg-column-scan`、qid6 从 `segment-pruned` 掉到
`full-scan`（它的 `range_col=gmt_create` 不再是分段键）、qid7 从 `cluster-sorted-scan`
升到 `segment-pruned`（`pay_time` 现在是分段键）。**"改一个属性会不会影响路径"正是这题要证的**：
只把配置风险当文案提示的实现，路径列不会跟着变。
而 `ord` 的风险列**仍然是** `column-for-point` —— 第 4 条排在第 5 条前面，
"两键互顶"在这张表上永远轮不到，这就是"一张表只报第一条"的代价。

**`no-pk-scan` 只有最后一个用例能测到**：基线五张表要么有主键、要么不是纯列存。
该用例把 `dim_shop` 改成列存（它本来就没有主键）并补一条 `point` 查询 ⇒
qid14 落 `no-pk-scan`（第 1 条），而 `shard_pruned` 仍是 1（分布键 `shop_id` 命中）——
两列各自成立，正说明"分片裁剪"与"点查形态"是两件不同的事。

**用例「退化：查询日志为空」期望裸 `[]`**：`mysql --batch` 在 0 行时连表头都不输出，
带 `columns` 的期望值构造上判不了（docs/JUDGING.md 的 mysql 一节）。

**用例「查询打着一张不存在的表」不许多出行**：`JOIN holo_table` 直接挡掉。
若有人改成 `LEFT JOIN holo_table`，三值逻辑下 `t.pk_cols = ''` 对 NULL 是 UNKNOWN、
`t.orientation <> 'column'` 也是 UNKNOWN，于是 point 分支一路掉到 `seq-scan`/`none`，
**报表里多出一条"某张不存在的表在做顺序扫描"的行**，
而按表去重统计风险数时它是纯噪声。

**朴素解挂在哪**：point 一律 `pk-point-lookup`（不看 orientation、不看过滤列是否真是主键）、
`range_col` 非空就 `segment-pruned`（不比对分段键）、`shard_pruned` 恒 1、
`config_risk` 恒 `none`。它对应的正是素材 §3 那条错误答案
**"列存就是最快"**【源 D11/D13】。

**工程延伸（面试追问点）**

1. 点查为什么要行存？（机制在主键索引文件：它本身就是行存结构，
   Value = RID + 聚簇键，RID 每次 UPSERT 生成且单调递增【源 D13】。
   行存表的主键默认同时是 Clustering 与 Distribution Key ⇒ "按主键定位数据文件"是一跳。）
2. 既要 OLAP 又要 Serving 怎么办？（`orientation='row,column'` 行列共存【源 D11】，
   代价是写两份、存储翻倍。本题的 `both` 就是这个形态：
   它的 point 走第 2 条、agg 走第 8 条，两侧都拿得到好路径。）
3. TTL 到底能不能用？（官方原话是"生产业务中不建议使用 TTL 来管理数据生命周期，
   建议采用分区表"，因为删除时点不精确 ⇒ **可能出现 PK 重复或查询结果不一致**【源 D11】。
   这条同时是成本题与质量题的共同根因，也是本题把它排进第 2 位的原因。）""",
    )


# ===================================================================== M3 分库分表与 GSI
@draft('sql-ab-shard-uniqueness')
def q_shard_uniqueness():
    SHARD = [
        # shard_idx, row_id, buyer_id, order_time
        [0, 5001, 101, 100],
        [0, 5002, 101, 110],
        [0, 5003, 102, 120],
        [0, 5007, 103, 130],
        [1, 5003, 104, 140],     # 主键在另一个分片重复（分片内唯一 != 全局唯一）
        [1, 5004, 102, 150],
        [1, 5005, 102, 160],     # 买家 102 散在两个分片
        [2, 5006, 105, 170],
        [2, 5007, 105, 180],     # 5007 也跨分片重复
    ]
    GSI = [
        # row_id, buyer_id, shard_idx, covering
        [5001, 101, 0, 1],
        [5002, 101, 0, 1],
        [5003, 102, 0, 0],       # 覆盖列缺失 => 要回表
        [5004, 102, 1, 1],
        [5005, 102, 1, 0],
        [5006, 105, 2, 1],
        [5008, 106, 0, 1],       # 索引表有、主表没有（回填或回滚留下的孤儿）
    ]
    COLS = ['metric', 'value']

    def evaluate(rows):
        shard = rows['shard_row']
        gsi = rows['gsi_index']
        page_no, page_size = 3, 3
        total = len(shard)
        distinct_pk = len({r[1] for r in shard})
        copies = {}
        for r in shard:
            copies.setdefault(r[1], set()).add(r[0])
        dup_groups = len([k for k, v in copies.items() if len(v) > 1])
        by_buyer = {}
        for r in shard:
            by_buyer.setdefault(r[2], set()).add(r[0])
        scattered = len([k for k, v in by_buyer.items() if len(v) > 1])
        back = len([g for g in gsi if g[3] == 0])
        pk_shard = {r[1] for r in shard}
        pk_gsi = {g[0] for g in gsi}
        ordered = sorted(shard, key=lambda r: (-r[3], -r[1]))
        lo = (page_no - 1) * page_size
        correct = ordered[lo:lo + page_size]
        naive = []
        for sh in sorted({r[0] for r in shard}):
            sub = [r for r in ordered if r[0] == sh]
            naive += sub[lo:lo + page_size]
        return sorted([
            ['total-rows', total],
            ['distinct-pk', distinct_pk],
            ['duplicate-pk-rows', total - distinct_pk],
            ['duplicate-pk-groups', dup_groups],
            ['buyers-scattered', scattered],
            ['gsi-back-to-table-rows', back],
            ['gsi-missing-rows', len(pk_shard - pk_gsi)],
            ['gsi-orphan-rows', len(pk_gsi - pk_shard)],
            ['page-rows-correct', len(correct)],
            ['page-rows-naive-per-shard', len(naive)],
        ], key=lambda r: r[0])       # 题面契约是"按 metric 升序"，模型必须按同一把尺子排

    SCHEMA = {
        'shard_row': table_spec(
            'row_id',
            ['shard_idx', 'row_id', 'buyer_id', 'order_time'],
            ['shard_idx INT NOT NULL', 'row_id BIGINT NOT NULL', 'buyer_id INT NOT NULL',
             'order_time INT NOT NULL', 'PRIMARY KEY (shard_idx, row_id)']),
        'gsi_index': table_spec(
            'row_id',
            ['row_id', 'buyer_id', 'shard_idx', 'covering'],
            ['row_id BIGINT NOT NULL PRIMARY KEY', 'buyer_id INT NOT NULL',
             'shard_idx INT NOT NULL', 'covering INT NOT NULL']),
    }
    SEED = {'shard_row': [list(r) for r in SHARD], 'gsi_index': [list(r) for r in GSI]}

    cases = [
        mut_case('基线：主键跨分片重复 2 行、一个买家散在两个分片、两行要回表',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='total-rows=9 / distinct-pk=7 ⇒ 重复 2 行、重复组 2 个（5003 与 5007）；'
                      '买家 102 在分片 0 与 1 都有单 ⇒ buyers-scattered=1'
                      '（105 的两行都在分片 2，"一个分片里买家重复"不是散落）；'
                      'gsi 里 covering=0 的两行要回表；主表 7 个不同主键里有 1 个不在 gsi ⇒ missing=1'),
        mut_case('边界：把 GSI 全部补齐覆盖列 ⇒ 回表行数归零，但主键重复一行都没变',
                 SCHEMA, SEED, [('setcol', 'gsi_index', 'covering', 0, 'covering', 1)],
                 COLS, evaluate,
                 note='GSI 解决"按哪个维度查"，不解决"主键在分库分表里不保证唯一"——'
                      '两件事必须分开报'),
        mut_case('边界：删掉分片 2 的全部行 ⇒ 全局末页还剩 1 行，"每片各取第 3 页"一行都不剩',
                 SCHEMA, SEED, [('delcol', 'shard_row', 'shard_idx', 2),
                                ('del', 'gsi_index', 5006)],
                 COLS, evaluate,
                 note='删空一个分片之后总数从 9 掉到 7：全局第 3 页（offset 6、size 3）还剩 1 行，'
                      '而"每片各取第 3 页"在删片前后都是 0 —— 分片越多、每片的行数越少，'
                      '这种写法就会**静默返回空页**，前端看到的是"没有更多了"。'
                      '（搬移而不是删除的写法在这里会撞主键：5007 在分片 0 已经有了，'
                      'Python 模型不会撞、MySQL 会 —— 所以变异 kinds 里专门有 delcol。）'),
        mut_case('退化：主表被清空 ⇒ 只剩孤儿索引行，两个分页指标都是 0',
                 SCHEMA, SEED, [('clr', 'shard_row')], COLS, evaluate),
        mut_case('退化：索引表被清空 ⇒ 回表 0 行，但"索引缺失"是 7 行不是 0',
                 SCHEMA, SEED, [('clr', 'gsi_index')], COLS, evaluate,
                 note='gsi-missing-rows=7、gsi-orphan-rows=0、gsi-back-to-table-rows=0；'
                      '把"没有回表"读成"索引很健康"是反向陷阱'),
        mut_case('边界：把散落的那个买家并回一个分片 ⇒ buyers-scattered 归零，重复主键一行没变',
                 SCHEMA, SEED,
                 [('setpk', 'shard_row', {'shard_idx': 0, 'row_id': 5003}, {'buyer_id': 101})],
                 COLS, evaluate,
                 note='只改 `(0, 5003)` 这一行：102 就只剩分片 1 的单 ⇒ scattered=0，'
                      '而 5003 依旧是跨分片重复的主键 ⇒ duplicate 两列不动。'
                      '**这条必须用 setpk 写**：`set` 只认单列 pk 代理，'
                      '按 `row_id = 5003` 会连着改掉分片 1 的那一行，'
                      '于是"并回一个分片"变成"两个副本都改了买家"—— 散落没归零、还多出一个假散射'),
    ]

    reference = """WITH ranked AS (
  SELECT s.shard_idx, s.row_id, s.buyer_id, s.order_time,
         ROW_NUMBER() OVER (ORDER BY s.order_time DESC, s.row_id DESC)  AS global_rn,
         ROW_NUMBER() OVER (PARTITION BY s.shard_idx
                            ORDER BY s.order_time DESC, s.row_id DESC)  AS shard_rn
  FROM shard_row s
),
per_row AS (
  SELECT row_id, COUNT(*) AS copies FROM shard_row GROUP BY row_id
),
missing AS (
  SELECT DISTINCT s.row_id AS pk FROM shard_row s
  LEFT JOIN gsi_index g ON g.row_id = s.row_id
  WHERE g.row_id IS NULL
),
orphan AS (
  SELECT DISTINCT g.row_id AS pk FROM gsi_index g
  LEFT JOIN shard_row s ON s.row_id = g.row_id
  WHERE s.row_id IS NULL
),
scattered AS (
  SELECT buyer_id FROM shard_row GROUP BY buyer_id HAVING COUNT(DISTINCT shard_idx) > 1
)
SELECT 'total-rows' AS metric, COUNT(*) AS value FROM shard_row
UNION ALL
SELECT 'distinct-pk', COUNT(DISTINCT row_id) FROM shard_row
UNION ALL
SELECT 'duplicate-pk-rows', COUNT(*) - COUNT(DISTINCT row_id) FROM shard_row
UNION ALL
SELECT 'duplicate-pk-groups', COUNT(*) FROM per_row WHERE copies > 1
UNION ALL
SELECT 'buyers-scattered', COUNT(*) FROM scattered
UNION ALL
SELECT 'gsi-back-to-table-rows', COUNT(*) FROM gsi_index WHERE covering = 0
UNION ALL
SELECT 'gsi-missing-rows', COUNT(*) FROM missing
UNION ALL
SELECT 'gsi-orphan-rows', COUNT(*) FROM orphan
UNION ALL
SELECT 'page-rows-correct', COUNT(*) FROM ranked WHERE global_rn BETWEEN 7 AND 9
UNION ALL
SELECT 'page-rows-naive-per-shard', COUNT(*) FROM ranked WHERE shard_rn BETWEEN 7 AND 9
ORDER BY metric"""

    naive = """SELECT 'total-rows' AS metric, COUNT(*) AS value FROM shard_row
UNION ALL
SELECT 'distinct-pk', COUNT(DISTINCT row_id) FROM shard_row
UNION ALL
SELECT 'duplicate-pk-rows', 0 FROM shard_row LIMIT 1
UNION ALL
SELECT 'duplicate-pk-groups', 0 FROM shard_row LIMIT 1
UNION ALL
SELECT 'buyers-scattered', COUNT(*) FROM (
         SELECT buyer_id FROM shard_row GROUP BY buyer_id HAVING COUNT(*) > 1) b
UNION ALL
SELECT 'gsi-back-to-table-rows', COUNT(*) FROM gsi_index WHERE covering = 0
UNION ALL
SELECT 'gsi-missing-rows', (SELECT COUNT(*) FROM shard_row s
                            LEFT JOIN gsi_index g ON g.row_id = s.row_id
                            WHERE g.row_id IS NULL)
FROM shard_row LIMIT 1
UNION ALL
SELECT 'gsi-orphan-rows', 0 FROM shard_row LIMIT 1
UNION ALL
SELECT 'page-rows-correct', COUNT(*) FROM (
         SELECT ROW_NUMBER() OVER (ORDER BY order_time DESC, row_id DESC) rn
         FROM shard_row) r WHERE r.rn BETWEEN 7 AND 9
UNION ALL
SELECT 'page-rows-naive-per-shard', COUNT(*) FROM (
         SELECT ROW_NUMBER() OVER (ORDER BY order_time DESC, row_id DESC) rn
         FROM shard_row) r WHERE r.rn BETWEEN 7 AND 9"""

    statement = """## 背景

PolarDB-X 官方文档里有一条被反复误读的话【源 S29】：

> "**分库分表中，分表内保证主键的唯一性，但是主键在分库分表中不保证唯一性**，
> 如有需要可使用全局唯一索引。"

同一批文档还给了三条相关事实：

- **全局唯一 ID 与全局唯一约束是两件事**：前者靠序列（雪花 / 号段 / DB sequence），
  后者才需要 GSI【源 S29】＋【推】；
- "**每个 GSI 对应一张索引表，使用 XA 多写保证主表和索引表之间数据强一致**"，
  `COVERING` 覆盖列"默认包含主键和主表的分库分表键"【源 S28】；
- 拆分键的首要原则是"尽可能找到**数据所归属的业务逻辑实体**，
  并确定大部分（或核心的）SQL 都围绕这个实体进行"【源 S27】。

素材 §4 考点 14 的出题建议是"拆分后的订单主表 + 买家维度 GSI 表，
实现跨库分页不重不漏 + 校验主键是否出现重复 + 统计需回表的行数并断言"，
本题把这三件事拆成**十个必须互相独立的数字**。

## 表

```
shard_row(shard_idx INT, row_id BIGINT, buyer_id INT, order_time INT,
          PRIMARY KEY (shard_idx, row_id))
   -- 逻辑表被拆到 shard_idx = 0/1/2 三个分片；主键只在"分片内"唯一
gsi_index(row_id BIGINT PK, buyer_id INT, shard_idx INT, covering INT)
   -- 按 buyer_id 维度建的全局二级索引表；covering=1 表示所需列都在索引里（不用回表）
```

## 任务

只交**一条 SELECT**（可以用 `WITH`），输出十行指标，列固定 `metric, value`，按 `metric` 升序：

| `metric` | 定义 |
| --- | --- |
| `total-rows` | `shard_row` 的总行数 |
| `distinct-pk` | `COUNT(DISTINCT row_id)` |
| `duplicate-pk-rows` | `total-rows − distinct-pk`（**多出来的行数**，不是重复主键的个数） |
| `duplicate-pk-groups` | 出现在 **≥ 2 个不同分片**的 `row_id` 个数 |
| `buyers-scattered` | 订单散在多于一个分片上的 `buyer_id` **个数**（这些买家的查询要扫全库） |
| `gsi-back-to-table-rows` | `covering = 0` 的索引行数（每条都要回主表） |
| `gsi-missing-rows` | 主表里存在、GSI 里**没有**的**不同** `row_id` 个数 |
| `gsi-orphan-rows` | GSI 里存在、主表里**没有**的**不同** `row_id` 个数 |
| `page-rows-correct` | 全局排序 `(order_time DESC, row_id DESC)` 后**第 3 页**（每页 3 行）的行数 |
| `page-rows-naive-per-shard` | "每个分片各自取第 3 页"再合起来的行数（即 `shard_rn BETWEEN 7 AND 9`） |

## 三条口径纪律

- **`duplicate-pk-rows` 与 `duplicate-pk-groups` 必须分列**：
  一个主键有 3 个副本 ⇒ 差额 2 行、1 个组。混成一列就分不清
  "脏数据规模"与"要人工核对几个订单"。
- **`buyers-scattered` 要按 `COUNT(DISTINCT shard_idx) > 1`，不是 `COUNT(*) > 1`**：
  一个买家 4 条订单全在同一分片是**好事**（拆分键选对了）；
  用行数判会把大客户全报成问题。
- **两个对账指标都要先取"不同 `row_id`"再算差集**：
  主表本身有重复主键，直接 `COUNT(*)` 做差会把重复行数算进"索引缺失"，
  于是索引回填进度被虚报。`missing` 与 `orphan` **也不是互补的两个数**：
  前者是 XA 多写少了一半，后者是删除路径没对称 —— 各自对应不同的修复动作。

**关于分页**：`page-rows-correct` 与 `page-rows-naive-per-shard` 用同一个
`BETWEEN 7 AND 9`，差别只在 `ROW_NUMBER` 有没有 `PARTITION BY shard_idx`。
**正确页的行数与分片数无关，朴素分页的行数随分片数线性变化** ——
这就是素材里"跨库分页不重不漏"的可判形态（真实的正确取法是
每片取前 `page_no × page_size` 行再全局归并）。

只允许一条 `SELECT`。"""

    return base(
        'sql', 'principal',
        '分库分表体检：主键跨片重复、买家散落分片数、GSI 回表与索引缺失，分页行数两种口径',
        statement, 'mysql',
        ['sharding', 'primary-key-uniqueness', 'global-secondary-index',
         'cross-shard-pagination', 'xa-multi-write', 'modern:distributed-database'],
        src('数据研发 / 服务端研发（分布式数据库与拆分治理方向） 技术专家',
            TXN + '#4 考点 14（分库分表与全局一致性："分表内主键唯一、分库分表中不保证唯一"'
            '【源 S29】、"每个 GSI 对应一张索引表 + XA 多写强一致"与 COVERING 覆盖列【源 S28】、'
            '拆分键要选"数据所归属的业务逻辑实体"【源 S27】；素材该考点的出题建议正是'
            '"跨库分页不重不漏 + 校验主键是否出现重复 + 统计需回表的行数并断言"。'
            '十个指标的拆分口径与分页对照写法是【推】，题面已写成契约）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=35,
        answer="""## 参考答案

一个 `WITH` 出 `ranked`（同时给 `global_rn` 与 `shard_rn`）、`per_row`、`missing`、`orphan`、
`scattered` 五个 CTE，再 `UNION ALL` 十段。结构上没有难点，难点全在**十个定义互不重叠**。

**基线十行**：`total-rows=9`、`distinct-pk=7`、`duplicate-pk-rows=2`、
`duplicate-pk-groups=2`（5003 与 5007）、`buyers-scattered=1`（只有 102 散在分片 0 与 1；
105 的两行都在分片 2 —— "同一个分片里买家重复"不是散落）、
`gsi-back-to-table-rows=2`、`gsi-missing-rows=1`（5007 —— 它在主表出现两次，
但按**不同主键**只算一个）、`gsi-orphan-rows=1`（5008）、
`page-rows-correct=3`、`page-rows-naive-per-shard=0`。

**`gsi-missing-rows=1` 是这道题最容易算错的一格**：主表 9 行 / 7 个不同主键，
GSI 7 行 —— 少掉的那个主键是 5007，而它在主表**有两个副本**。
如果写成 `COUNT(*)` 的差会得到 2（两个副本各算一次），
而"要回填几个主键"是 1。**重复主键会顺着所有"两表对账"的口径往下传染**，
这正是不加 `DISTINCT` 的代价。

**两个分页列的差就是本题结论**：第 3 页每页 3 行 ⇒ 全局排序的第 7~9 名有 3 行；
"每片各取第 3 页"给 **0 行**（三个分片各只有 4 / 3 / 2 行，谁都凑不到第 7 名）。
**行数不同只是症状**：真正的问题是"每片的第 7~9 名"根本不对应"全局第 7~9 名"，
而它的表现不是"数字错了"，是**翻到第三页永远空白** —— 用户以为到底了。
正确做法是每片取前 `page_no × page_size = 9` 行再全局归并。
用例「删掉分片 2 的全部行」把这条摊开：正确口径 3 → 1（末页只剩一行，这次是**真的**到底），
朴素口径 0 → 0（它"到底之前"也是 0）—— 一个从来给不出"还剩几行"的分页实现，
连自己错了都报不出来。

**用例「GSI 全部补齐覆盖列」**：`gsi-back-to-table-rows` 归 0，
而 `duplicate-pk-rows` 与 `duplicate-pk-groups` 一行没变。
这条是防"加个索引就万事大吉"的直觉 —— 素材明确把
"全局唯一 ID（序列）"与"全局唯一约束（GSI）"分成两件事【源 S29】＋【推】。

**用例「索引表被清空」是全题最反直觉的一条**：
`gsi-back-to-table-rows = 0` 看着像"索引很健康"，
同一份结果里 `gsi-missing-rows = 7` 说明索引压根没建起来。
**任何"某项指标为 0 所以放心"的判断，都要先问它的补集是哪一列。**

**用例「把散落的那个买家并回一个分片」**：`buyers-scattered` 归 0、重复主键两列不变。
这两列各对应一条治理动作：前者改**拆分键选择**，后者改**主键生成方式**。
并成一列"分库分表问题数"就会出现"上了全局序列，散列买家依然天天扫全库"的现场。
（这条的变异写法本身就是判分点之一：`set` 只认 `table_spec` 里那一个 pk 代理列，
而这张表的声明主键是 `(shard_idx, row_id)` —— 用 `row_id = 5003` 去 UPDATE
会连着改掉分片 1 的那个副本，"并回一个分片"当场变成"两边都改了买家"。
所以变异 kinds 里另给了 `setpk`：**按声明主键的每一列定位、命中多行就拒绝生成**。）

**朴素解挂五类、共六列**：重复主键两列直接写 0（默认"主键当然全局唯一"）；
`buyers-scattered` 用 `HAVING COUNT(*) > 1`（把"一个买家有多条单"当成散落，
基线给出 3 而正确答案是 1 —— 105 的两行都在分片 2，压根不是散落）；
`gsi-missing-rows` 不加 `DISTINCT`（给出 2 而不是 1）；
`gsi-orphan-rows` 写 0（看不见"索引表有、主表没有"）；
两个分页列用同一个全局 `ROW_NUMBER`（两列永远相等，本题的核心断言被抹平）。

**工程延伸（面试追问点）**

1. 加了 GSI 写为什么会变慢？（官方依据："每个 GSI 对应一张索引表，使用 **XA 多写**
   保证主表和索引表之间数据强一致"【源 S28】—— 一次业务写被放大成多分片写。）
2. GSI 与热点行优化互斥怎么处理？（素材考点 4 引 PolarDB-X【源 S11】：
   热点更新"**不支持带有全局索引的表**"。所以爆款 SKU 那张表要么放弃内核热点优化，
   要么把买家维度的查询改走异步宽表。`gsi-back-to-table-rows` 就是决策输入：
   回表行数低说明覆盖得好，换成异步宽表的代价就小。）
3. 主键重复怎么修？（不能"随便留一行"：两个副本可能是**两条不同的真实订单**
   （号段发号器重叠），也可能是同一订单写了两遍。
   判据是 `buyer_id`/`order_time` 是否一致，不一致就要走业务裁决 ——
   这正是 `duplicate-pk-groups` 单独成一列的原因：它是"要人看的清单"的长度。）""",
    )

# ===================================================================== M4 库存扣减对账
@draft('sql-ab-inventory-reconcile')
def q_inventory_reconcile():
    STOCK = [
        # sku_id, kucun0（窗口开始）, kucun（窗口结束账面）
        [2001, 100, 90],
        [2002, 10, 7],
        [2003, 5, -3],
        [2004, 50, 40],
        [2005, 7, 7],
    ]
    ORDERS = [
        # order_id, sku_id, qty, status
        [1001, 2001, 10, 'PAID'],
        [1002, 2002, 3, 'PAID'],
        [1003, 2003, 8, 'PAID'],
        [1004, 2004, 10, 'CANCELLED'],
        [1005, 2005, 2, 'INIT'],
        [1006, 2001, 5, 'PAID'],
    ]
    DEDUCT = [
        # deduct_id, biz_key, order_id, sku_id, qty
        [1, 'pay-1001', 1001, 2001, 10],
        [2, 'pay-1002', 1002, 2002, 3],
        [3, 'pay-1003', 1003, 2003, 8],
        [4, 'pay-1004', 1004, 2004, 10],
        [5, 'retry-1004', 1004, 2004, 10],   # 幂等键换了名字 ⇒ 同一订单被扣两次
        [6, 'pay-1006', 1006, 2001, 5],
        [7, 'pay-9009', 9009, 2002, 4],      # 孤儿：订单表里没有 9009
    ]
    RELEASE = [
        # release_id, biz_key, order_id, sku_id, qty
        [1, 'cancel-1004', 1004, 2004, 10],
        [2, 'cancel-1006', 1006, 2001, 5],   # PAID 订单被释放 ⇒ 非法
    ]
    SCHEMA = {
        'stock': table_spec('sku_id', ['sku_id', 'kucun0', 'kucun'],
                            ['sku_id INT NOT NULL PRIMARY KEY', 'kucun0 INT NOT NULL',
                             'kucun INT NOT NULL']),
        'order_txn': table_spec('order_id', ['order_id', 'sku_id', 'qty', 'status'],
                                ['order_id BIGINT NOT NULL PRIMARY KEY', 'sku_id INT NOT NULL',
                                 'qty INT NOT NULL', 'status VARCHAR(12) NOT NULL']),
        'deduct_log': table_spec('deduct_id', ['deduct_id', 'biz_key', 'order_id', 'sku_id', 'qty'],
                                 ['deduct_id INT NOT NULL PRIMARY KEY',
                                  'biz_key VARCHAR(64) NOT NULL', 'order_id BIGINT NOT NULL',
                                  'sku_id INT NOT NULL', 'qty INT NOT NULL']),
        'release_log': table_spec('release_id',
                                  ['release_id', 'biz_key', 'order_id', 'sku_id', 'qty'],
                                  ['release_id INT NOT NULL PRIMARY KEY',
                                   'biz_key VARCHAR(64) NOT NULL', 'order_id BIGINT NOT NULL',
                                   'sku_id INT NOT NULL', 'qty INT NOT NULL']),
    }
    SEED = {'stock': [list(r) for r in STOCK], 'order_txn': [list(r) for r in ORDERS],
            'deduct_log': [list(r) for r in DEDUCT], 'release_log': [list(r) for r in RELEASE]}
    COLS = ['anomaly', 'sku_id', 'order_id', 'cnt']

    def evaluate(rows):
        out = []
        for sku, k0, k1 in sorted(rows['stock']):
            d = sum(x[4] for x in rows['deduct_log'] if x[3] == sku)
            r = sum(x[4] for x in rows['release_log'] if x[3] == sku)
            net = d - r
            if net > k0:
                out.append(['over-sold', sku, 0, net - k0])
            if k1 != k0 - net:
                out.append(['ledger-mismatch', sku, 0, k0 - net - k1])
        dcnt, rcnt = {}, {}
        for x in rows['deduct_log']:
            dcnt.setdefault(x[2], []).append(x)
        for x in rows['release_log']:
            rcnt.setdefault(x[2], []).append(x)
        for oid in sorted(dcnt):
            if len(dcnt[oid]) > 1:
                out.append(['duplicate-deduct', dcnt[oid][0][3], oid, len(dcnt[oid])])
        for oid in sorted(rcnt):
            if len(rcnt[oid]) > 1:
                out.append(['double-release', rcnt[oid][0][3], oid, len(rcnt[oid])])
        orders = {o[0]: o for o in rows['order_txn']}
        for oid in sorted(orders):
            o = orders[oid]
            if o[3] == 'PAID' and oid not in dcnt:
                out.append(['paid-without-deduct', o[1], oid, 0])
            if o[3] == 'CANCELLED' and oid not in rcnt:
                out.append(['cancelled-without-release', o[1], oid, 0])
            if oid in rcnt and o[3] != 'CANCELLED':
                out.append(['released-but-not-cancelled', o[1], oid, len(rcnt[oid])])
            if o[3] in ('PAID', 'CANCELLED') and oid not in dcnt:
                pass
        for oid in sorted(dcnt):
            if oid not in orders:
                out.append(['orphan-deduct', dcnt[oid][0][3], oid, len(dcnt[oid])])
        for x in sorted(rows['deduct_log'], key=lambda r: r[2]):
            o = orders.get(x[2])
            if o is not None and o[1] != x[3]:
                out.append(['wrong-sku-deduct', x[3], x[2], x[4]])
        out.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
        return out

    cases = [
        mut_case('基线：超卖、台账不平、重扣、非法释放、孤儿扣减各命中一次',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='2003 net=8 > kucun0=5 ⇒ over-sold 3；2004 被扣两次(20)但只释放 10 ⇒ '
                      '台账不平 0？不是：kucun=40、kucun0-net=50-(20-10)=40 ⇒ 平了，'
                      '报的是 duplicate-deduct；1006 是 PAID 却被释放；9009 是孤儿扣减'),
        mut_case('边界：净扣减恰好等于初始库存 ⇒ 不算超卖（判据用 >，归零是合法终态）',
                 SCHEMA, SEED,
                 [('set', 'stock', 2003, {'kucun0': 8, 'kucun': 0})], COLS, evaluate),
        mut_case('边界：把二次扣减的幂等键改成同一个 ⇒ 重复扣减仍按"次数 != 1"报',
                 SCHEMA, SEED,
                 [('set', 'deduct_log', 5, {'biz_key': 'pay-1004'})], COLS, evaluate,
                 note='素材草稿 A 第 4 条：重复扣减必须按"次数 != 1"判定，不是"有没有"。'
                      '两行同 biz_key 在真实系统里意味着去重表被绕过（同事务没做）'),
        mut_case('退化：扣减与释放全部清空 ⇒ 多出四行"已付款没扣减"、一行"已取消没释放"、四个 SKU 全部台账不平',
                 SCHEMA, SEED, [('clr', 'deduct_log'), ('clr', 'release_log')],
                 COLS, evaluate,
                 note='2001 清空流水后净扣减按 0 算：100 - 0 - 90 = 10 ⇒ ledger-mismatch 仍报，'
                      '因为清空流水不会让库存账自动变对'),
        mut_case('退化：库存表清空 ⇒ SKU 维度两列都不出行（不许凭空造一个"零库存 SKU"）',
                 SCHEMA, SEED, [('clr', 'stock')], COLS, evaluate),
        mut_case('非法形态：把一笔扣减记到另一个 SKU 上 ⇒ 订单与扣减的 sku_id 不一致',
                 SCHEMA, SEED, [('set', 'deduct_log', 6, {'sku_id': 2002})], COLS, evaluate,
                 note='wrong-sku-deduct 命中 1006；同时 2001/2002 的台账各错一笔 —— '
                      '扣错货这种事故在单表自检里是看不见的，只有跨表比 sku 才露出来'),
    ]

    reference = """SELECT anomaly, sku_id, order_id, cnt FROM (
  SELECT 'over-sold' AS anomaly, s.sku_id, 0 AS order_id,
         (SELECT COALESCE(SUM(d.qty), 0) FROM deduct_log d WHERE d.sku_id = s.sku_id)
       - (SELECT COALESCE(SUM(r.qty), 0) FROM release_log r WHERE r.sku_id = s.sku_id)
       - s.kucun0 AS cnt
  FROM stock s
  WHERE (SELECT COALESCE(SUM(d.qty), 0) FROM deduct_log d WHERE d.sku_id = s.sku_id)
      - (SELECT COALESCE(SUM(r.qty), 0) FROM release_log r WHERE r.sku_id = s.sku_id) > s.kucun0

  UNION ALL
  SELECT 'ledger-mismatch', s.sku_id, 0,
         s.kucun0
       - ((SELECT COALESCE(SUM(d.qty), 0) FROM deduct_log d WHERE d.sku_id = s.sku_id)
        - (SELECT COALESCE(SUM(r.qty), 0) FROM release_log r WHERE r.sku_id = s.sku_id))
       - s.kucun
  FROM stock s
  WHERE s.kucun <> s.kucun0
        - ((SELECT COALESCE(SUM(d.qty), 0) FROM deduct_log d WHERE d.sku_id = s.sku_id)
         - (SELECT COALESCE(SUM(r.qty), 0) FROM release_log r WHERE r.sku_id = s.sku_id))

  UNION ALL
  SELECT 'duplicate-deduct', d.sku_id, d.order_id, COUNT(*)
  FROM deduct_log d GROUP BY d.sku_id, d.order_id HAVING COUNT(*) > 1

  UNION ALL
  SELECT 'double-release', r.sku_id, r.order_id, COUNT(*)
  FROM release_log r GROUP BY r.sku_id, r.order_id HAVING COUNT(*) > 1

  UNION ALL
  SELECT 'paid-without-deduct', o.sku_id, o.order_id, 0
  FROM order_txn o LEFT JOIN deduct_log d ON d.order_id = o.order_id
  WHERE o.status = 'PAID' AND d.deduct_id IS NULL

  UNION ALL
  SELECT 'cancelled-without-release', o.sku_id, o.order_id, 0
  FROM order_txn o LEFT JOIN release_log r ON r.order_id = o.order_id
  WHERE o.status = 'CANCELLED' AND r.release_id IS NULL

  UNION ALL
  SELECT 'released-but-not-cancelled', o.sku_id, o.order_id,
         (SELECT COUNT(*) FROM release_log r2 WHERE r2.order_id = o.order_id)
  FROM order_txn o JOIN release_log r ON r.order_id = o.order_id
  WHERE o.status <> 'CANCELLED'
  GROUP BY o.sku_id, o.order_id

  UNION ALL
  SELECT 'orphan-deduct', d.sku_id, d.order_id, COUNT(*)
  FROM deduct_log d LEFT JOIN order_txn o ON o.order_id = d.order_id
  WHERE o.order_id IS NULL GROUP BY d.sku_id, d.order_id

  UNION ALL
  SELECT 'wrong-sku-deduct', d.sku_id, d.order_id, d.qty
  FROM deduct_log d JOIN order_txn o ON o.order_id = d.order_id
  WHERE d.sku_id <> o.sku_id
) x
ORDER BY anomaly, sku_id, order_id, cnt"""

    naive = """SELECT 'over-sold' AS anomaly, s.sku_id, 0 AS order_id, s.kucun AS cnt
FROM stock s WHERE s.kucun < 0
UNION ALL
SELECT 'duplicate-deduct', d.sku_id, d.order_id, COUNT(*)
FROM deduct_log d GROUP BY d.sku_id, d.order_id, d.biz_key HAVING COUNT(*) > 1
UNION ALL
SELECT 'paid-without-deduct', o.sku_id, o.order_id, 0
FROM order_txn o JOIN deduct_log d ON d.order_id = o.order_id
WHERE o.status = 'PAID'
GROUP BY o.sku_id, o.order_id"""

    statement = """## 背景

素材 §5 题面草稿 A 把库存扣减写成"扣减 + 幂等 + 对账"三段式（考点 4，
锚在 PolarDB 热点行与 Inventory Hint【源 S8/S9】）。本仓库的 `mysql` 判题器
**只能提交一条查询**（`docs/JUDGING.md`：跨语句的 `ROW_COUNT()`、锁状态、
事务回滚都断言不了），所以"原子扣减三态"那半归到主观题，
**这题专做草稿 A 的第 2、4、5 段：事后审计**。

草稿 A 里两条必须原样落实的纪律：

- **"重复扣减必须按'次数 ≠ 1'判定，不是'有没有'"**（第 4 段）；
- **"去重记录必须与扣减在同一事务内"**（第 2 段）⇒
  同一 `biz_key` 出现两行不是"幂等生效"，而是**幂等被绕过**；
- **回滚对称**（第 5 段）：释放必须与扣减一一对应，且**只有取消单才有释放**。

## 表

```
stock(sku_id INT PK, kucun0 INT, kucun INT)                -- 窗口开始 / 当前账面库存
order_txn(order_id BIGINT PK, sku_id INT, qty INT, status VARCHAR(12))   -- INIT|PAID|CANCELLED
deduct_log(deduct_id INT PK, biz_key VARCHAR(64), order_id BIGINT, sku_id INT, qty INT)
release_log(release_id INT PK, biz_key VARCHAR(64), order_id BIGINT, sku_id INT, qty INT)
```

## 任务

只交**一条 SELECT**，输出异常清单，列固定 `anomaly, sku_id, order_id, cnt`，
按这四列升序。**SKU 维度的异常用 `order_id = 0` 占位**（不要输出 NULL）。

| `anomaly` | 判据 | `cnt` |
| --- | --- | --- |
| `over-sold` | 某 SKU 的 `净扣减 = Σdeduct − Σrelease > kucun0` | 超出的件数 |
| `ledger-mismatch` | `kucun <> kucun0 − 净扣减` | 账面差额（`kucun0 − 净扣减 − kucun`，可正可负） |
| `duplicate-deduct` | 同一 `order_id` 在 `deduct_log` 里 **次数 > 1** | 次数 |
| `double-release` | 同一 `order_id` 在 `release_log` 里次数 > 1 | 次数 |
| `paid-without-deduct` | `status = 'PAID'` 且没有任何扣减记录 | `0` |
| `cancelled-without-release` | `status = 'CANCELLED'` 且没有任何释放记录 | `0` |
| `released-but-not-cancelled` | 有释放记录但订单**不是** `CANCELLED` | 释放次数 |
| `orphan-deduct` | 扣减记录指向的 `order_id` 在订单表里不存在 | 该订单的扣减次数 |
| `wrong-sku-deduct` | 扣减记录的 `sku_id` 与订单的 `sku_id` 不一致 | 该笔扣减件数 |

## 三条口径纪律

- **`over-sold` 与 `ledger-mismatch` 是两个独立检查，可能同时命中同一个 SKU**：
  前者说"卖多了"，后者说"账对不上"。它们的**处置路径不同** ——
  超卖要赔付/砍单，台账不平要查扣减代码。合成一列就会只修一个。
- **`duplicate-deduct` 按 `order_id` 聚合，不按 `biz_key`**：
  重试时重新生成一个 `biz_key` 恰恰是最严重的形态（幂等键失效），
  按 `biz_key` 分组会认为"每次都是新请求"，**一行都不报**。
- **`released-but-not-cancelled` 要求从订单侧出发**：
  PAID 订单被释放 = 货被凭空退回库存。以 `release_log` 为主体也能报，
  但 `cnt` 必须是**该订单的释放次数**（不是释放件数），
  否则会与 `double-release` 的口径打架。

只允许一条 `SELECT`（可用子查询）。"""

    return base(
        'sql', 'senior',
        '库存扣减审计：超卖与台账不平分开报、重复扣减按次数判、PAID 单被释放必须点名',
        statement, 'mysql',
        ['inventory-deduction', 'over-selling', 'idempotency-key', 'reconciliation',
         'release-symmetry', 'modern:transaction-integrity'],
        src('服务端研发（交易与库存链路方向） 高级工程师',
            TXN + '#4 考点 4（库存扣减与热点行【源 S8/S9/S10/S11】）＋ §5 题面草稿 A '
            '"扣减 + 幂等 + 对账"三段式：幂等防重扣必须与扣减同事务、'
            '"重复扣减必须按次数 != 1 判定，不是有没有"、释放与扣减幂等对称、'
            '"已扣库存但订单未进终态 / 订单 PAID 但无扣减记录"两类差异。'
            '九类异常的枚举与 cnt 口径是【推】，题面已写成契约；'
            '原子扣减三态（成功/库存不足/无此行）因 mysql 判题器只能提交一条查询而归给主观题'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 25000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案

九段 `UNION ALL`，每段一件事。**难点不是写法，是九件事互相不重叠**。

**基线五行**（按 `anomaly` 升序，下面写成 `anomaly/sku_id/order_id/cnt`）：
`duplicate-deduct/2004/1004/2`、`ledger-mismatch/2002/0/-4`、
`orphan-deduct/2002/9009/1`、`over-sold/2003/0/3`、
`released-but-not-cancelled/2001/1006/1`。
两行是 SKU 维度（`order_id` 用 0 占位），三行是订单/流水维度。
`double-release` 基线里是空的 —— 没有任何订单被释放两次，它是题面表格里留着的判据，
不为它硬造用例。SKU 那两行要对着下面这张表读：

| SKU | Σdeduct | Σrelease | 净扣减 | kucun0 | kucun | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 2001 | 15 | 5 | 10 | 100 | 90 | 平 ⇒ 无 SKU 级异常 |
| 2002 | 7 | 0 | 7 | 10 | 7 | `10 − 7 = 3 ≠ 7` ⇒ ledger-mismatch **−4** |
| 2003 | 8 | 0 | 8 | 5 | −3 | `8 > 5` ⇒ over-sold **3**；且 `5 − 8 = −3 = kucun` ⇒ 台账平 |
| 2004 | 20 | 10 | 10 | 50 | 40 | `50 − 10 = 40 = kucun` ⇒ 台账平（重扣 10 件被释放抵掉了） |
| 2005 | 0 | 0 | 0 | 7 | 7 | 平 |

`cancelled-without-release` 基线里也是空的：1004 是唯一 CANCELLED 单，而它有释放记录
⇒ 它要等用例「扣减与释放全部清空」才浮出来（那一行同时把四个 SKU 的台账全部打不平）。

**2002 的 `ledger-mismatch` 是基线里最容易被读错的一行**：
它的净扣减是 `3 + 4 = 7`，其中那笔 4 件来自**订单表里根本不存在的 9009**。
所以这一行与 `orphan-deduct/2002/9009/1` 是**同一个根因的两个症状**：
账面对不上（少了 4 件），而流水里有一笔找不到主人。
**两列都要报**：只报孤儿会让人以为库存是对的，只报台账不平会让人去改账面数字。

**`over-sold` 用 `>` 而不是 `>=`**：用例「净扣减恰好等于初始库存」把 2003 改成
`kucun0=8, kucun=0` ⇒ 净扣减 8 恰好等于初始库存 ⇒ **不报超卖**（卖光是合法终态），
而台账 `8 − 8 = 0 = kucun` 也平 ⇒ 这个 SKU 一行都不出。
判 `>=` 的实现会在**每一件售罄的商品**上都报一次超卖 ——
那是超卖告警最常见的沉默原因（响太多，所以没人看）。

**用例「把二次扣减的幂等键改成同一个」是本题的核心断言**：
`deduct_id=5` 的 `biz_key` 从 `retry-1004` 改成 `pay-1004` 之后，
`duplicate-deduct` **仍然必须报 1004 两次**。
按 `biz_key` 分组的实现（朴素解就是这么写的）在这里给出**零行**：
两行的 `biz_key` 相同 ⇒ 每组一行 ⇒ `HAVING COUNT(*) > 1` 永不成立。
而真实语义是"**去重记录没和扣减写在同一事务里**"——
素材草稿 A 第 2 条要求断言"扣减回滚后去重表不得残留记录"，
本题从审计侧盯同一件事：**同键两行 = 幂等表被绕过**。

**朴素解挂三处，每处都是一个方向的错**：
1. `over-sold` 写成 `kucun < 0` ⇒ 只看见 2003，看不见 2002 那种
   "账面还是正数但已经卖超了"（`kucun0=10`、净扣 7 却记成 7 ⇒ 若真实净扣是 12
   而账面留 0，朴素解也不报）；而它把 2003 的 `cnt` 写成 `kucun`（−3），
   **件数口径直接错**（应该是超出的 3 件）；
2. `duplicate-deduct` 按 `biz_key` 分组 ⇒ 漏掉基线里那条重扣；
3. `paid-without-deduct` 用 `JOIN` ⇒ 它实际报的是"**有**扣减记录的 PAID 单"，
   方向完全反了（报出 1001/1002/1003/1006 四条正常记录）。

**工程延伸（面试追问点）**

1. 三态（成功 / 库存不足 / 该行不存在）为什么不在这里考？（一条查询判不了：
   需要跨语句的 `ROW_COUNT()` 与事务回滚断言。素材草稿 A 第 1 条里
   `TARGET_AFFECT_ROW 1` 的语义（PolarDB Inventory Hint【源 S9】）归主观题。）
2. 开了热点行优化之后对账要注意什么？（官方：开启后"**仅依赖 `ON UPDATE
   CURRENT_TIMESTAMP` 属性自动更新的列会失效****"【源 S8】——
   而那正是审计表 `updated_at` 的来源。所以流水要显式写时间列，
   否则"最后一次修改时间"这一列在热点行上是假的，`ledger-mismatch` 无从归因。）
3. 为什么释放要独立一张表？（释放与扣减的幂等键、重试节奏都不同；
   放进同一张表用正负数量表示，会让"次数 ≠ 1"这条判据失去意义 ——
   扣两次 + 释放一次 = 净 1 件，看着像对的。）""",
    )

# ===================================================================== M5 指标口径治理
@draft('sql-ab-metric-definition-gate')
def q_metric_definition():
    FACT = [
        # pay_id, order_id, buyer_id, amount_pennies, biz_date, channel, refunded
        [1, 9001, 101, 19900, 20260901, 'APP', 0],
        [2, 9002, 101, 5000, 20260901, 'H5', 1],
        [3, 9003, 102, 8800, 20260901, 'APP', 0],
        [4, 9004, 102, 12000, 20260830, 'APP', 0],
        [5, 9005, 103, 3300, 20260826, 'PC', 1],
        [6, 9006, 103, 4450, 20260825, 'APP', 0],      # 周窗口外（8/25 < 8/26）
        [7, 9007, 104, 7777, 20260828, 'APP', None],   # refunded 未回填
        [8, 9008, 104, 2100, 20260901, 'H5', 0],
    ]
    DEF = [
        # def_id, metric_name, atomic_metric, filter_code, period_code, version
        [1, 'pay_amount', 'sum_amount', 'all', 'day', 1],
        [2, 'pay_amount', 'sum_amount', 'no-refund', 'day', 1],
        [3, 'pay_amount', 'sum_amount', 'app', 'day', 1],
        [4, 'pay_amount', 'sum_amount', 'all', 'week', 1],
        [5, 'pay_amount', 'sum_amount', 'no-refund', 'week', 1],
        [6, 'pay_amount', 'sum_amount', 'app', 'week', 1],
        [7, 'active_buyer', 'count_buyer', 'all', 'day', 1],
        [8, 'active_buyer', 'count_buyer', 'no-refund', 'day', 1],
        [9, 'refund_amount', 'sum_amount', 'refund', 'day', 2],
        [10, 'refund_amount', 'sum_amount', 'refund', 'day', 2],   # 同一定义登记了两次
    ]
    COLS = ['kind', 'metric_name', 'filter_code', 'period_code', 'value']

    def evaluate(rows):
        f = rows['pay_fact']
        day = [r for r in f if r[4] == 20260901]
        week = [r for r in f if 20260826 <= r[4] <= 20260901]
        out = []
        names = sorted({d[1] for d in rows['metric_def']})
        for name in names:
            defs = [d for d in rows['metric_def'] if d[1] == name]
            atomics = sorted({d[2] for d in defs})
            for atomic in atomics:
                for flt in sorted({d[3] for d in defs if d[2] == atomic}):
                    for per in sorted({d[4] for d in defs if d[2] == atomic and d[3] == flt}):
                        base = day if per == 'day' else week
                        if flt == 'no-refund':
                            sel = [r for r in base if r[6] == 0]
                        elif flt == 'app':
                            sel = [r for r in base if r[5] == 'APP']
                        elif flt == 'refund':
                            sel = [r for r in base if r[6] == 1]
                        else:
                            sel = base
                        if atomic == 'sum_amount':
                            val = sum(r[3] for r in sel)
                        else:
                            val = len({r[2] for r in sel})
                        out.append(['derived-metric', name, flt, per, val])
        combos = {}
        for d in rows['metric_def']:
            combos.setdefault(d[1], set()).add((d[2], d[3], d[4]))
        versions = {}
        for d in rows['metric_def']:
            versions.setdefault(d[1], set()).add(d[5])
        for name in sorted(combos):
            if len(combos[name]) > 1:
                out.append(['definition-count', name, str(len(combos[name])),
                            str(len(versions[name])), len(combos[name])])
        dup = {}
        for d in rows['metric_def']:
            key = (d[1], d[2], d[3], d[4])
            dup[key] = dup.get(key, 0) + 1
        for key in sorted(dup):
            if dup[key] > 1:
                out.append(['duplicate-registration', key[0], key[2], key[3], dup[key]])
        unknown = len([r for r in f if r[6] is None and 20260826 <= r[4] <= 20260901])
        out.append(['scope-gap', 'pay_amount', 'no-refund', 'week', unknown])
        out.sort()
        return out

    SCHEMA = {
        'pay_fact': table_spec(
            'pay_id',
            ['pay_id', 'order_id', 'buyer_id', 'amount_pennies', 'biz_date', 'channel',
             'refunded'],
            ['pay_id INT NOT NULL PRIMARY KEY', 'order_id BIGINT NOT NULL',
             'buyer_id INT NOT NULL', 'amount_pennies BIGINT NOT NULL',
             'biz_date INT NOT NULL', 'channel VARCHAR(8) NOT NULL', 'refunded INT NULL']),
        'metric_def': table_spec(
            'def_id',
            ['def_id', 'metric_name', 'atomic_metric', 'filter_code', 'period_code', 'version'],
            ['def_id INT NOT NULL PRIMARY KEY', 'metric_name VARCHAR(32) NOT NULL',
             'atomic_metric VARCHAR(32) NOT NULL', 'filter_code VARCHAR(16) NOT NULL',
             'period_code VARCHAR(8) NOT NULL', 'version INT NOT NULL']),
    }
    SEED = {'pay_fact': [list(r) for r in FACT], 'metric_def': [list(r) for r in DEF]}

    cases = [
        mut_case('基线：pay_amount 在三种业务限定 × 两种统计周期下给出六个数（全表 13 行）',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='业务限定 no-refund 只含 refunded=0 —— 第 7 行 refunded 是 NULL，'
                      '它既不算"未退"也不算"已退"；scope-gap 那一行就是它的可见计数'),
        mut_case('边界：把未回填的 refunded 补成 0 ⇒ no-refund 的周值变大、scope-gap 归零',
                 SCHEMA, SEED, [('set', 'pay_fact', 7, {'refunded': 0})], COLS, evaluate,
                 note='这条证明 refunded IS NULL 与 refunded = 0 是两件事：'
                      '补数据会改变指标值，而不是改变指标口径'),
        mut_case('边界：把 8/25 那行搬进周窗口 ⇒ 三个周口径各多 4450，天窗口完全不变',
                 SCHEMA, SEED, [('set', 'pay_fact', 6, {'biz_date': 20260826})], COLS, evaluate),
        mut_case('退化：事实表清空 ⇒ 九个派生指标都是 0 且必须仍然出行（不许掉行）',
                 SCHEMA, SEED, [('clr', 'pay_fact')], COLS, evaluate,
                 note='SUM 在空集上是 NULL，必须 COALESCE 成 0；'
                      '掉行会让"这个指标今天没数"和"这个指标没人维护"长得一模一样'),
        mut_case('非法形态：同名指标被登记成两种业务限定 ⇒ definition-count 报 2，值不合并',
                 SCHEMA, SEED,
                 [('ins', 'metric_def', [11, 'gmv', 'count_buyer', 'app', 'day', 1]),
                  ('ins', 'metric_def', [12, 'gmv', 'count_buyer', 'all', 'day', 1])],
                 COLS, evaluate,
                 note='gmv 出现两个定义（app / all），素材考点 12 的口径纪律是'
                      '"改业务限定或统计周期 = 新指标"，所以两个数都要单独出行，'
                      '并额外报一行 definition-count'),
        mut_case('边界：同一定义再登记一次 ⇒ duplicate-registration 报 3，派生指标不重复出行',
                 SCHEMA, SEED,
                 [('ins', 'metric_def', [13, 'refund_amount', 'sum_amount', 'refund', 'day', 2])],
                 COLS, evaluate,
                 note='refund_amount 原本已有一行同定义 ⇒ 现在 3 行。'
                      'definition-count 不看它（组合数仍是 1），只有重复登记那一列会涨'),
    ]

    reference = """WITH scope AS (
  SELECT 'day' AS period_code, p.* FROM pay_fact p WHERE p.biz_date = 20260901
  UNION ALL
  SELECT 'week', p.* FROM pay_fact p
  WHERE p.biz_date BETWEEN 20260826 AND 20260901
),
combos AS (
  SELECT DISTINCT metric_name, atomic_metric, filter_code, period_code FROM metric_def
),
derived AS (
  SELECT 'derived-metric' AS kind, c.metric_name, c.filter_code, c.period_code,
         CASE WHEN c.atomic_metric = 'sum_amount'
              THEN COALESCE((SELECT SUM(s.amount_pennies) FROM scope s
                             WHERE s.period_code = c.period_code
                               AND (c.filter_code = 'all'
                                    OR (c.filter_code = 'no-refund' AND s.refunded = 0)
                                    OR (c.filter_code = 'app' AND s.channel = 'APP')
                                    OR (c.filter_code = 'refund' AND s.refunded = 1))), 0)
              ELSE COALESCE((SELECT COUNT(DISTINCT s.buyer_id) FROM scope s
                             WHERE s.period_code = c.period_code
                               AND (c.filter_code = 'all'
                                    OR (c.filter_code = 'no-refund' AND s.refunded = 0)
                                    OR (c.filter_code = 'app' AND s.channel = 'APP')
                                    OR (c.filter_code = 'refund' AND s.refunded = 1))), 0)
         END AS value
  FROM combos c
)
SELECT kind, metric_name, filter_code, period_code, value FROM derived
UNION ALL
SELECT 'definition-count', d.metric_name, CAST(COUNT(DISTINCT CONCAT(d.atomic_metric, '|',
       d.filter_code, '|', d.period_code)) AS CHAR),
       CAST(COUNT(DISTINCT d.version) AS CHAR),
       COUNT(DISTINCT CONCAT(d.atomic_metric, '|', d.filter_code, '|', d.period_code))
FROM metric_def d
GROUP BY d.metric_name
HAVING COUNT(DISTINCT CONCAT(d.atomic_metric, '|', d.filter_code, '|', d.period_code)) > 1
UNION ALL
SELECT 'duplicate-registration', d.metric_name, d.filter_code, d.period_code, COUNT(*)
FROM metric_def d
GROUP BY d.metric_name, d.atomic_metric, d.filter_code, d.period_code
HAVING COUNT(*) > 1
UNION ALL
SELECT 'scope-gap', 'pay_amount', 'no-refund', 'week',
       (SELECT COUNT(*) FROM pay_fact p
        WHERE p.refunded IS NULL
          AND p.biz_date BETWEEN 20260826 AND 20260901)
ORDER BY kind, metric_name, filter_code, period_code"""

    naive = """SELECT 'derived-metric' AS kind, 'pay_amount' AS metric_name,
       'all' AS filter_code, 'day' AS period_code,
       SUM(p.amount_pennies) AS value
FROM pay_fact p WHERE p.biz_date = 20260901
UNION ALL
SELECT 'derived-metric', 'pay_amount', 'no-refund', 'day', SUM(p.amount_pennies)
FROM pay_fact p WHERE p.biz_date = 20260901 AND p.refunded <> 1
UNION ALL
SELECT 'derived-metric', 'pay_amount', 'app', 'day', SUM(p.amount_pennies)
FROM pay_fact p WHERE p.biz_date = 20260901 AND p.channel = 'APP'
UNION ALL
SELECT 'definition-count', d.metric_name, '', '', COUNT(*)
FROM metric_def d GROUP BY d.metric_name"""

    statement = """## 背景

Dataphin 官方把规范定义写成一句话【源 D19】：

> "以**维度建模**作为理论基础，划分并定义**主题域、业务过程、维度、原子指标、
> 统计周期和派生指标**。"

而派生指标的创建页给的是另一句更硬的话【源 D18】：

> "**派生指标用于圈定原子指标统计业务的范围**"，前提是要先完成**业务实体**与
> **业务限定**的创建。

两句合起来就是本题的最小口径元组：**原子指标（度量 + 业务过程）+ 业务限定 + 统计周期 = 派生指标**。
缺任一项，两个团队就会算出不同的"支付金额"。
素材据此推出的一条治理规则（按【推】处理，题面把它写成可判的契约）：
**改业务限定或统计周期 = 新指标，必须能被发现，不许覆盖同名指标。**

## 表

```
pay_fact(pay_id INT PK, order_id BIGINT, buyer_id INT, amount_pennies BIGINT,
         biz_date INT, channel VARCHAR(8), refunded INT)     -- refunded 可为 NULL（未回填）
metric_def(def_id INT PK, metric_name VARCHAR(32), atomic_metric VARCHAR(32),
           filter_code VARCHAR(16), period_code VARCHAR(8), version INT)
```

- `biz_date` 是 `yyyyMMdd` 整数，**不许引入日期函数或时区**；
- 统计周期的展开是本题设定的常量：`day` = `biz_date = 20260901`，
  `week` = `biz_date BETWEEN 20260826 AND 20260901`；
- 业务限定的展开：`all` 无过滤；`no-refund` = `refunded = 0`；`app` = `channel = 'APP'`；
  `refund` = `refunded = 1`；
- 原子指标的展开：`sum_amount` = `SUM(amount_pennies)`；`count_buyer` = `COUNT(DISTINCT buyer_id)`。

## 任务

只交**一条 SELECT**，输出四类行，列固定
`kind, metric_name, filter_code, period_code, value`，按这四列升序：

| `kind` | 判据 | `value` |
| --- | --- | --- |
| `derived-metric` | `metric_def` 里**去重后**的每个 `(atomic_metric, filter_code, period_code)` 组合，按 `metric_name` 各出一行 | 该组合的指标值（**单位是分**；空集必须输出 `0`，不许 NULL、不许掉行） |
| `definition-count` | 某个 `metric_name` 下不同 `(atomic, filter, period)` 三元组数 > 1 | 三元组数；同时把 `filter_code` 放三元组数、`period_code` 放**不同 version 的个数** |
| `duplicate-registration` | 同一个 `(metric_name, atomic, filter, period)` 被登记多行 | 登记行数 |
| `scope-gap` | 固定一行：`pay_amount / no-refund / week` | 周窗口内 `refunded IS NULL` 的行数 |

**注意 `derived-metric` 要用去重后的三元组**：
同一组合被登记两次时，指标值只出一份（否则"重复登记"与"重复出数"会混在一起）。

## 三条口径纪律

- **`no-refund` 是 `refunded = 0`，不是 `refunded <> 1`**：
  三值逻辑下后者会把 `NULL` 行**也排除掉**，于是"未回填"被静默当成"未退款"，
  口径会随回填进度漂移 —— 而这正是"昨天的数今天变了"的制度性成因。
  `scope-gap` 那一行就是为了让这批发被看见，而不是被悄悄吃掉。
- **`definition-count` 与 `duplicate-registration` 是两回事**：
  前者是"同一个名字有两种算法"（**不可比**，要拆名字或升版本），
  后者是"同一种算法登记了两遍"（**只是脏元数据**，值不会错）。
  合并成一列会让治理同学对第二种也去追问口径。
- **`derived-metric` 的组合必须从 `metric_def` 出发，而不是硬编码六个**：
  新增一个业务限定时报表要自动多一行；写死组合的实现会在扩容那天悄悄少报一格。

只允许一条 `SELECT`（可用 `WITH`）。"""

    return base(
        'sql', 'senior',
        '派生指标口径门禁：原子指标 × 业务限定 × 统计周期，同名两种定义必须被点名',
        statement, 'mysql',
        ['metric-definition', 'derived-metric', 'null-semantics', 'metadata-governance',
         'three-value-logic', 'modern:semantic-layer'],
        src('数据研发（指标体系与语义层方向） 高级工程师',
            DATA + '#4 考点 12（指标口径治理：规范定义六要素"主题域、业务过程、维度、原子指标、'
            '统计周期和派生指标"【源 D19】、"派生指标用于圈定原子指标统计业务的范围"+ 前提是'
            '业务实体与业务限定已建【源 D18】；素材该考点的出题建议正是"同一支付金额在三种'
            '业务限定/统计周期下的正确 SQL，并要求输出派生指标元组"。'
            '"改限定即新指标"与 definition-count/duplicate-registration 的拆分是【推】，'
            '题面已写成契约）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 25000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=32,
        answer="""## 参考答案

`WITH scope`（把 day/week 两个窗口展开成一份带 `period_code` 的行集）+
`combos`（`SELECT DISTINCT` 三元组）+ 三段 `UNION ALL`。
核心是**组合从元数据出发**，以及 `no-refund` 只认 `= 0`。

**基线六个 `derived-metric`（pay_amount，单位分）**：
`day/all = 19900+5000+8800+2100 = 35800`；
`day/no-refund = 19900+8800+2100 = 30800`（第 2 行 refunded=1 被排、
第 7 行 refunded 是 NULL 也**不在窗口里**，因为它 biz_date=20260828）；
`day/app = 19900+8800 = 28700`；
`week/all = 35800 + 12000 + 3300 + 7777 = 58877`；
`week/no-refund = 30800 + 12000 = 42800`；
`week/app = 28700 + 12000 + 7777 = 48477`（第 6 行 `pay_id=6` 是 8/25，**在周窗口外**）。
再加 `active_buyer` 的两行（`day/all` = 3 个买家：101 / 102 / 104，第 1、2 行是同一个人；
`day/no-refund` = 3 —— 少掉的那条正是 refunded=1 的 pay_id=2）与
`refund_amount` 的一行（`day/refund` = 5000），
以及 `definition-count/pay_amount/6/1/6`（六种算法、一个版本）、
`definition-count/active_buyer/2/1/2`、`duplicate-registration/refund_amount/refund/day/2`、
`scope-gap/pay_amount/no-refund/week/1`。

**`scope-gap = 1` 与 `week/no-refund` 是同一件事的两面**：
第 7 行（`refunded IS NULL`、20260828）落在周窗口里，
`refunded = 0` 不选它 ⇒ `no-refund` 周值 42800 里**没有** 7777。
用例「把未回填的 refunded 补成 0」让 `week/no-refund` 变成 50577、`scope-gap` 变 0 ——
**指标值变了、口径没变**。这正是"补数据"与"改口径"必须分开登记的原因：
前者是数据问题（可以让回填任务解决），后者是**新指标**（要通知下游、要双跑对账）。

**朴素解最像、也最错的一格**：它把 `no-refund` 写成 `refunded <> 1`。
基线上这**恰好给出同一个数**（因为那条 NULL 行不在日窗口里），
所以基线看不出问题；真正把它打回原形的是**周窗口那三行**：
朴素实现只有三行 `day/*`，压根没有周口径，
而 `definition-count` 被它写成 `COUNT(*)`（`pay_amount` 给出 6 —— 蒙对了，
但 `duplicate-registration` 一格都没有，`scope-gap` 也没有）。
**"蒙对一格"正是这类口径 bug 能活很久的原因**，所以本题把 NULL 行放在周窗口内。

**用例「把 8/25 那行搬进周窗口」**才是那个"只有周口径会动"的判据：
`pay_id=6`（4450、APP、refunded=0、原本 biz_date=20260825）挪到 20260826 之后，
`week/all` 58877 → 63327、`week/app` 48477 → 52927、`week/no-refund` 42800 → 47250，
**三行各多 4450**，而四个 `day/*` 口径与 `scope-gap` 一行都不动。

**用例「同名指标被登记成两种业务限定」**（新登记 `gmv` 两条：`count_buyer/app/day` 与
`count_buyer/all/day`）会多出三行：两个 `derived-metric`（`app` 与 `all` 各一个数）
+ 一行 `definition-count/gmv/2/1/2`。
**注意值不能合并**：素材的结论是"改业务限定即新指标"，
合并之后两个团队看同一张报表会得出相反的判断。

**用例「同一定义再登记一次」**：`refund_amount` 从 2 行变 3 行，
但 `definition-count` **不报**（三元组仍是 1 种），只有
`duplicate-registration/refund_amount/refund/day/3` 涨。
这条把"脏元数据"与"口径分叉"分开 —— 前者清理即可，后者必须走变更流程。

**工程延伸（面试追问点）**

1. 语义层怎么落地？（本题的 `combos` 就是语义层的形状：**指标定义是数据，不是 SQL 文本**。
   素材 §2 追问 16 的判据是"任一要素变化即为新指标，需版本与对账"。）
2. 只有 `version` 列够不够？（不够。基线里 `pay_amount` 有 6 种算法但 version 全是 1
   —— 这正是"覆盖式改名"的现场。所以 `definition-count` 要看三元组数，
   并把不同 version 的个数放在旁边一列做对照。）
3. 口径类规则怎么进 DQC？（素材考点 13 的监控分类里有"业务规则和逻辑规则"【源 D17】——
   这两列就是可以直接挂成规则的产物：`definition-count > 1` 阻断发布、
   `scope-gap > 阈值` 告警。）""",
    )

# ===================================================================== R1 集群限流退化
@draft('sql-ab-cluster-flow-degrade')
def q_cluster_flow_degrade():
    setup = [
        'DEL rl:order:global',
        'DEL rl:order:i1',
        'DEL rl:order:i2',
        'DEL rl:order:i3',
        'DEL rl:order:mode',
        'HSET rl:order:cfg cluster_qps 100 per_instance_qps 2',
        'HSET rl:order:stat reject 0 degrade 0',
        'SET rl:order:mode cluster',
        'ZADD rl:order:global 8900 g-001',
        'ZADD rl:order:global 9500 g-002',
        'ZADD rl:order:global 9800 g-003',
        'ZADD rl:order:i3 9500 a-001',
        'ZADD rl:order:i3 9600 a-002',
    ]
    reference = """# 观测时刻 now = 10000，窗口 1000ms ⇒ 过期线是 9000（score <= 9000 视为窗口外）
# E1 先清全局窗口的过期条目（只清 g-001=8900，9500/9800 必须留着）
ZREMRANGEBYSCORE rl:order:global -inf (9000
# E2 Token Server 失联 ⇒ 落下降级标记；**绝不许 DEL 全局窗口**
SET rl:order:mode local
HINCRBY rl:order:stat degrade 1
# E3/E4 退化期间 i1 按单机阈值放行 2 条
ZADD rl:order:i1 10100 r-101
ZADD rl:order:i1 10200 r-102
# E5 i2 放行 1 条
ZADD rl:order:i2 10300 r-201
# E6 i3 窗口里已有 2 条 = 单机阈值已满 ⇒ r-303 被拒：一条写入都不发，只记 reject
HINCRBY rl:order:stat reject 1
# E7 Token Server 恢复 ⇒ 先把本地三窗并回总账（不并就会超放）
ZUNIONSTORE rl:order:global 4 rl:order:global rl:order:i1 rl:order:i2 rl:order:i3
# E8 并完再清本地窗口（先清等于撕账）
DEL rl:order:i1
DEL rl:order:i2
DEL rl:order:i3
# E9 模式标记复位
SET rl:order:mode cluster"""

    naive = """# "降级 = 清账 + 放行"版：DEL 掉全局窗口、被拒的请求也记进窗口、恢复后不并账
HINCRBY rl:order:stat reject 1
ZADD rl:order:i1 10100 r-101
ZADD rl:order:i1 10200 r-102
ZADD rl:order:i2 10300 r-201
ZADD rl:order:i3 10400 r-303
DEL rl:order:global
HSET rl:order:stat degrade 1"""

    statement = """## 背景

Sentinel《集群流量控制》给了一条最关键的失效语义【源 S19】：

> "若用户未引入集群限流 client 相关依赖，或者 client **未开启 / 连接失败 / 通信失败**，
> 则对于开启了集群模式的规则：普通集群限流会**退化到 local 模式的限流，
> 即在本地按照单机阈值执行限流检查**。"

也就是说：限流中心挂了，**官方答案是"按单机阈值拒"，不是"放行"**。
但这条退化里有两个坑，素材把它们列成追问点：

1. **容量陷阱**：`单机阈值 × 实例数 > 期望总阈值` 时，退化瞬间会超放；
   所以"退化期间的放行量"必须**记在本地窗口里**，恢复之后能并回总账；
2. 退化不是"清账"：`DEL` 掉全局窗口会让恢复后的第一秒**从零开始计数**。

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `FCALL` / `KEYS` / `FLUSHDB` /
`CONFIG` / `DEBUG` / `SORT` / `OBJECT` / `SELECT`。
所以"用 Lua 做 if-else"不在解空间内 —— 一切条件都要靠命令自己
（`NX` / `XX` / `ZUNIONSTORE`）或数据形状表达。

## 判题方式

判题**不模拟并发、也不让时间流逝**：
① 按"初始状态"摆好 Redis；② 顺序执行你提交的**这一份命令脚本**（每行一条，`#` 是注释）；
③ 逐条执行校验命令比对最终状态。
本场景**观测时刻 `now = 10000`、窗口 = 1000ms**（逻辑毫秒，题面内自洽即可）。

## 初始状态

```
HSET rl:order:cfg cluster_qps 100 per_instance_qps 2      -- 总阈值 100、单机阈值 2
HSET rl:order:stat reject 0 degrade 0
SET  rl:order:mode cluster
ZADD rl:order:global 8900 g-001 / 9500 g-002 / 9800 g-003 -- 全局窗口（score = 逻辑毫秒）
ZADD rl:order:i3 9500 a-001 / 9600 a-002                  -- i3 本地窗口：已经占满单机阈值
rl:order:i1 / rl:order:i2 不存在
```

## 一批到达的 9 个事件（必须全部处理）

| 事件 | 情况 | 必须 | 绝对不许 |
| --- | --- | --- | --- |
| E1 | `g-001` 已在窗口外 | 从全局窗口清掉 | 连窗口内的 `g-002/g-003` 一起删 |
| E2 | Token Server 连接失败 | 落下退化标记 | **DEL 全局窗口** |
| E3 | `i1` 放行 `r-101`（时刻 10100） | 记在 `rl:order:i1` | 写全局窗口（此时已不可写） |
| E4 | `i1` 放行 `r-102`（10200）⇒ 正好占满单机阈值 2 | 记在 `rl:order:i1` | 写第 3 条 |
| E5 | `i2` 放行 `r-201`（10300） | 记在 `rl:order:i2` | — |
| E6 | `i3` 的第 3 个请求 `r-303` **被单机阈值拒** | 只记一次 `reject` | **把被拒的请求写进任何窗口** |
| E7 | Token Server 恢复 | 把三个本地窗口并回全局 | 从头计数 |
| E8 | 并账完成后 | 清掉三个本地窗口 | 顺手清 `reject` / `degrade` |
| E9 | 恢复完成 | 模式标记复位 | — |

要求最终状态：`rl:order:global` 恰好 **7** 个成员
（`g-002`=9500、`g-003`=9800、`r-101`=10100、`r-102`=10200、`r-201`=10300、
`a-001`=9500、`a-002`=9600）；`rl:order:i1/i2/i3` 都不存在；
`r-303` **不存在于任何键**；`rl:order:mode = cluster`；
`reject = 1`、`degrade = 1`、`cluster_qps` 仍是 100。

## 这题真正考的东西

1. **`ZUNIONSTORE` 是"先并后删"的那一步**：恢复之后不并账，
   总窗口就"忘了"退化期间放掉的 5 条 ⇒ 下一秒的额度被算重（超放）。
   而**先 `DEL` 本地窗口再并**等于把账撕了 —— 顺序本身就是判分点。
2. **被拒的请求不落账**（E6）：与"被熔断器拒绝的请求不计入样本"是同一条纪律。
   落账之后单机阈值会被自己的拒绝撑满，
   症状是"限流中心恢复后这个实例永远限死"。
3. **`SET rl:order:mode local` 之后不许再动全局窗口**：
   退化期间全局窗口的写路径已经不归本实例负责（多实例并发写同一个 ZSET 会互相看不到），
   本地记账是**唯一能自证"这段时间放了多少"的证据链**。

只交一段命令脚本，不需要写代码。"""

    return base(
        'sql', 'senior',
        'Sentinel 集群限流退化到单机：降级不许清总账、被拒不许落账、恢复必须并账',
        statement, 'redis',
        ['sentinel-cluster-flow', 'token-server-degrade', 'sliding-window',
         'degrade-ledger', 'no-lua-constraint', 'modern:resilience-semantics'],
        src('服务端研发（稳定性与流量治理方向） 高级工程师',
            TXN + '#4 考点 9（限流：Token Client/Server 与"连接失败/通信失败时退化到 local '
            '模式按单机阈值执行限流检查"、可配置是否退化、`limitApp` 与阈值口径【源 S19】；'
            '素材该考点的 redis 出题建议正是"跨实例共享令牌桶，桶服务不可用时按'
            '单机阈值 × 实例数上限拒"，并把"单机阈值 × 实例数 > 期望总阈值"列为容量陷阱。'
            '"并回总账"的具体命令顺序是【推】，题面已写成契约）'),
        language='sql',
        cases=[
            {'name': '退化期间的放行必须并回总账：全局窗口恰好 7 个成员',
             'input': ['ZCARD rl:order:global'], 'expected': 7,
             'note': '2 条窗口内的旧全局 + 3 条 i1/i2 的本地放行 + 2 条 i3 的本地放行'},
            {'name': '过期条目被清、窗口内条目必须留着：g-002 还在（9500）',
             'input': ['ZSCORE rl:order:global g-002'], 'expected': '9500',
             'note': '清到 now=10000 的实现会把 9500/9800 一起删掉 ⇒ ZCARD 变 5'},
            {'name': '退化期间新放行的 r-101 在总账里，分数是它自己的时刻',
             'input': ['ZSCORE rl:order:global r-101'], 'expected': '10100'},
            {'name': '边界：i3 的旧账 a-001 也要被并进来（不许漏某个实例）',
             'input': ['ZSCORE rl:order:global a-001'], 'expected': '9500'},
            {'name': '边界：被单机阈值拒掉的 r-303 绝不允许落任何账本',
             'input': ['ZSCORE rl:order:global r-303'], 'expected': None,
             'note': '落账之后单机阈值会被自己的拒绝撑满 —— 恢复后这个实例永远限死'},
            {'name': '本地窗口并完必须清掉：i1 不存在',
             'input': ['EXISTS rl:order:i1'], 'expected': 0},
            {'name': '本地窗口并完必须清掉：i3 不存在（它就是那个"已经限满"的实例）',
             'input': ['EXISTS rl:order:i3'], 'expected': 0},
            {'name': '全局窗口不许被 DEL：它必须仍然存在（哪怕退化期间没人写它）',
             'input': ['EXISTS rl:order:global'], 'expected': 1,
             'note': '清掉它 = 恢复后从 0 计数 = 下一秒超放'},
            {'name': '退化标记要复位成 cluster', 'input': ['GET rl:order:mode'],
             'expected': 'cluster'},
            {'name': '降级事件要计数（HINCRBY 不是 HSET）',
             'input': ['HGET rl:order:stat degrade'], 'expected': '1'},
            {'name': '超限拒绝要计数', 'input': ['HGET rl:order:stat reject'],
             'expected': '1'},
            {'name': '配额上限不许被这个脚本改掉',
             'input': ['HGET rl:order:cfg cluster_qps'], 'expected': '100',
             'note': '改阈值是运营动作，不在本场景里 ⇒ 动了就是越权'},
            {'name': '空结果边界：全局窗口里没有任何"未来时刻"的条目',
             'input': ['ZCOUNT rl:order:global 10301 +inf'], 'expected': 0},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer="""## 参考答案

```
ZREMRANGEBYSCORE rl:order:global -inf 8999
SET rl:order:mode local
HINCRBY rl:order:stat degrade 1
ZADD rl:order:i1 10100 r-101
ZADD rl:order:i1 10200 r-102
ZADD rl:order:i2 10300 r-201
HINCRBY rl:order:stat reject 1
ZUNIONSTORE rl:order:global 4 rl:order:global rl:order:i1 rl:order:i2 rl:order:i3
DEL rl:order:i1
DEL rl:order:i2
DEL rl:order:i3
SET rl:order:mode cluster
```

**清理边界是 8999，不是 10000。** `score <= 9000` 才算窗口外，而只有 `g-001`(8900) 满足。
写成 `-inf 10000` 会把 `g-002`(9500) 与 `g-003`(9800) 一起删掉
⇒ `ZCARD` 从 7 变 5、`ZSCORE g-002` 变 nil，**两条校验同时红**。
这是本题唯一一条"清得太干净"的错法，而它的线上症状是
"限流窗口里的历史被抹掉，通过率突然变高"。
（初值刻意做成 8900 / 9500 / 9800 三个跨在边界两侧的值 ——
全在边界之下会让这个错法**不可判**，那是用例设计的失败而不是判题器的。）

**`ZUNIONSTORE dest 4 dest src1 src2 src3` 是本题的题眼**：
目标键同时作为源键在 Redis 里是合法的（先读后写），
所以"并回总账"是一条命令，不需要 Lua。
顺序上必须是 `ZUNIONSTORE` 在前、三个 `DEL` 在后 ——
反过来就是先撕证据再合并，`ZCARD` 会停在 2。

**E6 只发 `HINCRBY`、不发任何 `ZADD`。** 朴素解把 `r-303` 也写进 `rl:order:i3`
（`ZADD rl:order:i3 10400 r-303`），于是并账之后总账里多出一个本该被拒的请求，
`ZCARD` 变 8。更糟的是它在**本地**的形态：i3 的窗口被自己的拒绝撑到 3 条，
下一轮任何请求都会被"已经限满"的判断拒掉 ——
**被拒的请求落账 = 拒绝会自我放大**，这与熔断器里"被拒的请求不计入统计"是同一件事。

**`HSET rl:order:stat degrade 1`（朴素解写法）为什么不算错在这里、但方向上错**：
本场景只发生一次降级，`HSET` 与 `HINCRBY` 给出同一个数，所以这一格看不出来。
但配额服务是多实例共享的：每个实例退化时都 `SET` 成自己看到的 1，
**最终只剩 1**，而真实降级次数是实例数。
`reject` 同理 —— 丢更新的方向是单向的（只少不多），
所以这类计数器一律 `HINCRBY`。（素材在直播配额那题里写过同一条纪律。）

**为什么"不许 `DEL rl:order:global`"值得单独一列校验**：
它的症状不在退化期间（那段时间总账本来就不更新），
而在**恢复后的第一秒**：Token Server 从零开始计数，
`cluster_qps = 100` 又被完整放行一遍，而本地已经放掉了 5 条。
**"限流中心恢复 ⇒ 突然超放"** 是这类系统最难在监控里认出来的一刻
（大盘看起来是"恢复后流量涨了"）。

**工程延伸（面试追问点）**

1. 单机阈值该配多少？（素材 §4 考点 9 把这条写成"阈值之间的大小关系与推导方法"，
   §7 第 3 条明确**没有可引用的官方推荐值**。可辩护的答案是
   `单机阈值 ≤ 期望总阈值 / 实例数`，并且压测标定单实例水位；
   配错的方向性后果就是本题的容量陷阱。）
2. 退化的判据是什么？（官方给的是"未引入依赖 / 未开启 / 连接失败 / 通信失败"四种【源 S19】，
   并提供"通信失败时是否退化到本地"的配置项。
   **要能说清"不退化"意味着什么**：请求会在拿令牌这一步超时，等价于全拒。）
3. `ZUNIONSTORE` 的分数会怎样？（默认 `AGGREGATE SUM`，同名成员分数相加！
   本场景成员 ID 全局唯一所以安全；若成员可能重名，必须带 `WEIGHTS 1 1 1 1` 之前
   先确认命名域。这是这题**没有考但一定会被追问**的一处。）""",
    )


# ===================================================================== R2 无损上下线
@draft('sql-ab-graceful-drain-warmup')
def q_graceful_drain():
    setup = [
        'DEL mse:route',
        'DEL mse:draining',
        'DEL mse:inflight:i-1',
        'DEL mse:inflight:i-2',
        'DEL mse:inflight:i-3',
        'DEL mse:forced',
        'ZADD mse:route 100 i-1',
        'ZADD mse:route 100 i-2',
        'ZADD mse:route 100 i-3',
        'ZADD mse:route 20 i-8',
        'SET mse:inflight:i-3 3',
        'SET mse:inflight:i-8 2',
        'HSET mse:warmup total_ms 120000 elapsed_i9_ms 60000 full_weight 100',
        'HSET mse:stat removed 0 forced 0',
    ]
    reference = """# 观测时刻 now = 19000；i-9 启动于 10000（已过 60000ms，预热总时长 120000ms）
# E1 i-3 要下线：先停新流量（权重置 0，**留在路由表里**），并落下下线标记
ZADD mse:route 0 i-3
ZADD mse:draining 10000 i-3
# E2 i-3 的在途请求陆续完成：三次递减（不是 DEL）
DECR mse:inflight:i-3
DECR mse:inflight:i-3
DECR mse:inflight:i-3
# E3 归零后才真正摘除，并计数一次"正常摘除"
ZREM mse:route i-3
HINCRBY mse:stat removed 1
# E4 i-8 到超时仍未归零（还剩 2 个在途）⇒ 强制摘除，但**不许把计数清零**，
#    并且要落两笔证据：一次 forced + 一个带"剩余在途数"的下线标记
HINCRBY mse:stat forced 1
ZADD mse:draining 19000 i-8
ZREM mse:route i-8
# E5 i-9 上线：预热按线性爬坡 = full_weight × elapsed / total = 100 * 60000 / 120000
ZADD mse:route 50 i-9
# E6 健康实例 i-1 / i-2 什么都不动；被禁用的 i-4 绝不允许进表（一条命令都不发）"""

    naive = """# "发布就是改注册表"版：下线先摘除再看在途、预热直接给满权重、超时的计数顺手清零
ZREM mse:route i-3
DEL mse:inflight:i-3
ZREM mse:route i-8
DEL mse:inflight:i-8
HSET mse:stat removed 2
ZADD mse:route 100 i-9"""

    statement = """## 背景

阿里云《基于 MSE 实现微服务应用无损上下线》给的是**两半**，不是一句"优雅停机"【源 S24】：

- **下线**：引入"**自适应等待**和**主动通知**机制，确保所有待处理请求完成后再执行下线"；
- **上线**：通过"**就绪检查**"并把微服务生命周期管理与发布各阶段对齐；
- **服务预热**：无损上线开关里的"**预热时长** 默认值 **120 秒**"，
  "开启预热功能的应用重启后的**流量会随时间缓慢增加**"，
  用于"需要预建连接池和缓存等资源的慢启动场景"。

配套的注册中心语义（Nacos）："提供对服务的实时的健康检查，
**阻止向不健康的主机或服务实例发送请求**"，并支持权重路由【源 S26】。

（"权重 0 = 停止新流量但仍在表里"、"线性爬坡的算法"、"强制摘除要留下剩余在途数"
这三条是按【推】补全的**本题设定**，官方文档给的是能力与默认值。）

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `FCALL` / `KEYS` / `FLUSHDB` /
`CONFIG` / `DEBUG` / `SORT` / `OBJECT` / `SELECT`。
判题**不模拟并发、也不让时间流逝**：摆初始状态 → 顺序执行你的脚本 → 逐条校验最终状态。
本场景**观测时刻 `now = 19000`**（逻辑毫秒）。

## 初始状态

```
ZADD mse:route 100 i-1 / 100 i-2 / 100 i-3 / 20 i-8     -- score = 权重（0~100）
SET  mse:inflight:i-3 3        -- i-3 有 3 个在途请求（会陆续完成）
SET  mse:inflight:i-8 2        -- i-8 有 2 个在途请求（卡住，不会完成）
HSET mse:warmup total_ms 120000 elapsed_i9_ms 60000 full_weight 100
HSET mse:stat removed 0 forced 0
i-9 还没进注册表；mse:draining 不存在
```

## 六个事件（必须全部处理）

| 事件 | 情况 | 必须 | 绝对不许 |
| --- | --- | --- | --- |
| E1 | `i-3` 发起下线 | **先把权重置 0**（停止新流量）并落 `mse:draining` 标记 | 先从路由表删掉 |
| E2 | `i-3` 的 3 个在途请求陆续完成 | 计数递减到 0 | 直接 `DEL` 计数器 |
| E3 | `i-3` 在途归零 | 从 `mse:route` 摘除，`HINCRBY mse:stat removed 1` | 留一个权重 0 的成员在表里 |
| E4 | `i-8` 到 `now=19000` 仍有 2 个在途（超时兜底） | 强制摘除 + `HINCRBY mse:stat forced 1` + 落 draining 标记 | **把 `mse:inflight:i-8` 删掉或清零** |
| E5 | `i-9` 上线（已运行 60000ms，预热总时长 120000ms） | 按线性爬坡写入权重 = `100 × 60000 / 120000` | 给满权重 100，或给 0 |
| E6 | `i-1` / `i-2` 健康；`i-4` 被禁用（从未在表里） | 什么都不发 | 给 `i-4` 建权重 |

要求最终状态：`mse:route` = `i-1`(100) / `i-2`(100) / `i-9`(**50**)，共 3 个成员；
`mse:inflight:i-3` = `0`；`mse:inflight:i-8` = **`2`**（证据必须留在原地）；
`mse:draining` 有 `i-3`(10000) 与 `i-8`(19000) 两个成员；
`mse:stat` 的 `removed = 1`、`forced = 1`；`mse:warmup` 三个字段不许被改动。

## 这题真正考的东西

1. **`ZADD mse:route 0 i-3` 与 `ZREM mse:route i-3` 是两件事，顺序不能反**：
   置 0 = "不再进新流量，但会话与计数还要看得见"；摘除 = "这个实例从路由里消失"。
   先 `ZREM` 的话，你既无法回答"它当时还剩几个在途"，
   也无法在异常时**把权重恢复回去**（回滚一个已经被摘掉的实例要重建成员）。
   这与官方把"禁播 / 复播 / 断开"分成三个动作是同一个道理。
2. **超时兜底必须留下"没归零"的证据**：`i-8` 的计数**必须还是 2**。
   `DEL mse:inflight:i-8` 是最容易写的一行，也是把 2 个请求的丢失**从审计里抹掉**的一行。
   素材 §2 的追问"你怎么证明它真的无损"，答案就是这一列数字。
3. **预热值要算出来**：`100 × 60000 / 120000 = 50`。
   给 100 等于**默认预热没生效**（新实例的 JIT 与连接池还没起来就被均摊流量），
   素材把"预热窗口短于到达稳态的时间等于没做"列为【推】追问点。

只交一段命令脚本，不需要写代码。"""

    return base(
        'sql', 'senior',
        'MSE 无损上下线：停流量与摘除是两个动作、强制摘除要留下没归零的证据、预热按 120 秒爬坡',
        statement, 'redis',
        ['graceful-shutdown', 'inflight-counter', 'service-warmup', 'registry-weight',
         'forced-removal-evidence', 'modern:service-governance'],
        src('服务端研发（微服务治理与发布方向） 高级工程师',
            TXN + '#4 考点 13（发布期的流量无损与全链路灰度：下线=自适应等待 + 主动通知'
            '"确保所有待处理请求完成后再执行下线"、上线=就绪检查、'
            '"预热时长默认 120 秒""流量会随时间缓慢增加"【源 S24】、'
            'Nacos 健康检查"阻止向不健康的实例发送请求"与权重路由【源 S26】；'
            '该考点的 redis 出题建议正是"实例下线时在途请求计数归零后再摘除的计数器与超时兜底"。'
            '权重 0 与 ZREM 的分工、线性爬坡与强制摘除留证是【推】，题面已写成契约）'),
        language='sql',
        cases=[
            {'name': '基线：路由表最终恰好 3 个成员（i-1 / i-2 / i-9）',
             'input': ['ZCARD mse:route'], 'expected': 3},
            {'name': '预热爬坡要算出来：i-9 的权重是 50，不是 100',
             'input': ['ZSCORE mse:route i-9'], 'expected': '50',
             'note': '100 × 60000 / 120000 = 50；给 100 等于默认预热没生效'},
            {'name': '边界：归零的 i-3 必须已被真正摘除',
             'input': ['ZSCORE mse:route i-3'], 'expected': None,
             'note': '"停在权重 0"只是第一步；到最终状态还留着就是没走完下线流程'},
            {'name': '边界：i-3 的在途计数归零但不许被删（0 也是证据）',
             'input': ['GET mse:inflight:i-3'], 'expected': '0'},
            {'name': '超时兜底不许抹证据：i-8 的在途仍是 2',
             'input': ['GET mse:inflight:i-8'], 'expected': '2',
             'note': 'DEL 掉它就等于宣布"这次丢的 2 个请求不算丢"，而下一次预案会照此制定'},
            {'name': '强制摘除要单独计数，不与正常摘除混成一格',
             'input': ['HGET mse:stat forced'], 'expected': '1'},
            {'name': '正常摘除计数=1（用 HINCRBY，不许 HSET 覆盖）',
             'input': ['HGET mse:stat removed'], 'expected': '1'},
            {'name': '下线标记表要留下两个成员',
             'input': ['ZCARD mse:draining'], 'expected': 2},
            {'name': 'i-3 的下线发起时刻要留档（10000）',
             'input': ['ZSCORE mse:draining i-3'], 'expected': '10000'},
            {'name': '空结果边界：被禁用的 i-4 绝不允许出现在路由表里',
             'input': ['ZSCORE mse:route i-4'], 'expected': None},
            {'name': '健康实例的权重不许被动',
             'input': ['ZSCORE mse:route i-1'], 'expected': '100'},
            {'name': '预热参数不许被脚本改动',
             'input': ['HGET mse:warmup total_ms'], 'expected': '120000'},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer="""## 参考答案

```
ZADD mse:route 0 i-3
ZADD mse:draining 10000 i-3
DECR mse:inflight:i-3
DECR mse:inflight:i-3
DECR mse:inflight:i-3
ZREM mse:route i-3
HINCRBY mse:stat removed 1
HINCRBY mse:stat forced 1
ZADD mse:draining 19000 i-8
ZREM mse:route i-8
ZADD mse:route 50 i-9
```

**`i-3` 与 `i-8` 的收尾动作一样（`ZREM`），但记录的东西完全不同，
而这个差别就是"无损"与"有损"的界线**：
`i-3` 走满"置 0 → 落标记 → 计数归零 → 摘除 → `removed++`"，
`i-8` 走" `forced++` → 落标记 → 摘除"，**并且它的 `mse:inflight:i-8` 必须仍是 2**。

朴素解 `DEL mse:inflight:i-8` 之后，
2 个请求被强杀这件事**在数据上不留任何痕迹**，
于是下一次容量规划会照着"超时兜底从来没被用过"来定 ——
这正是素材反复强调的那类静默降级。
素材 §2 追问"你怎么证明它真的无损"，答案就是这一列数字与 `forced` 计数。

**`ZSCORE mse:route i-9` = `50`** 是唯一带算术的一格：
`100 × 60000 / 120000`。朴素解给 100（等于把 120 秒预热开关白配），
而给 0 的另一种错法更常见 ——
"先注册、等健康检查过了再改权重"在**没有任何东西会来改它**的系统里
就是一台永远不接流量的机器，症状是"发布完容量少一台"。

**`removed` 用 `HINCRBY` 而不是 `HSET removed 2`**：
朴素解一次 `HSET` 写 2，把"正常摘除"与"强制摘除"**合并成一个数**，
于是这条曲线失去了唯一的意义 ——
`forced > 0` 才是"这次发布有损"的证据。素材在字节那批题里留过同一条纪律
（"降级要留两套曲线"），这里是它的发布版。

**`ZCARD mse:draining = 2` 与 `ZSCORE mse:draining i-3 = 10000`** 两格
测的是"下线历史不许被顺手清掉"。`DEL mse:draining`（朴素解没写，
但很常见）会让回滚无从下手：
你不知道该把哪些实例的权重恢复成多少 —— 因为路由表里已经没有它们了。

**为什么 `EXISTS`/`ZSCORE` 类校验要成对写**：
`ZSCORE mse:route i-3 = nil`（已摘除）与 `GET mse:inflight:i-3 = 0`
（计数在原地归零）必须同时成立 ——
只有前者是"摘了但不知道当时有没有在途"，
只有后者是"等到归零了但没摘"。**两个都成立才是完整的一次无损下线。**

**工程延伸（面试追问点）**

1. 120 秒够不够？（素材把这条列为【推】追问：预热窗口必须 **≥** 实测的
   "JIT 到稳态 + 连接池建立 + 本地缓存回填"时间，测法是压测看 RT 曲线回落。
   更完整的做法是把权重爬坡与就绪检查**分开**：就绪检查决定"能不能接"，
   预热决定"接多少"。）
2. 在途计数谁来减？（应用侧 filter/interceptor 计数，注册中心只读。
   用"连接数"或 QPS 反推会把长连接与慢请求算错 —— 而慢请求正是发布期最该保护的。）
3. `mse:inflight:*` 用普通 key 而不是 HASH 的代价？（要枚举实例就得 `KEYS`/`SCAN`，
   而判题器禁 `KEYS`；真实系统里 `SCAN` 可用但要付遍历成本。
   用 `HGETALL mse:inflight` 一次拿全会更实用 —— 这题把它做成入参，
   考的就是"你知不知道两种形状各自的读路径代价"。）""",
    )

# ===================================================== B3 Paimon 主键表：版本归一 + 部分更新打宽
@draft('bd-ab-paimon-partial-update')
def q_paimon_partial_update():
    """把 Paimon 的 partial-update + sequence group 等价重写成一次 Spark 批处理。

    为什么可以走 pyspark：素材 §7 第 6 条写得很清楚 —— 机制取自阿里文档、
    解法写成通用 Spark 语义，并且**必须显式标【推】**（不许写成"阿里内部就这么算"）。
    两个判分点来自素材 §1.5 自己点名的"最值钱的一条"：
      * 可变非键列的过滤**不能**下推到合并之前（旧行 open、新行 closed ⇒ 先过滤会返回旧行）
      * "latest" 依业务顺序（seq），不是 ts、也不是到达顺序
    """
    VIEW = 'changes'
    SCHEMA = ('key INT, stream INT, seq BIGINT, arrived INT, ts BIGINT, '
              'status STRING, amount BIGINT, price BIGINT, is_delete INT')

    def row(key, stream, seq, arrived, ts, status=None, amount=None, price=None, is_delete=0):
        return {'key': key, 'stream': stream, 'seq': seq, 'arrived': arrived, 'ts': ts,
                'status': status, 'amount': amount, 'price': price, 'is_delete': is_delete}

    def merge(rows):
        """独立实现（与下面的 Spark 参考解走完全不同的路子：逐 key 手工归并）。"""
        by_key = {}
        for r in rows:
            by_key.setdefault(r['key'], []).append(r)
        out = []
        for key in sorted(by_key):
            recs = sorted(by_key[key], key=lambda x: (x['seq'], x['arrived']))
            fields = {'status': (None, -1), 'amount': (None, -1), 'price': (None, -1)}
            for x in recs:                     # 非 null 才覆盖 ⇒ null 保持原值
                for f in ('status', 'amount', 'price'):
                    if x[f] is not None:
                        fields[f] = (x[f], x['seq'])
            main = [x for x in recs if x['stream'] == 1]
            if main and main[-1]['is_delete'] == 1:
                continue                       # 主流最后一条是删除 ⇒ 整个 key 消失
            status, status_seq = fields['status']
            if status != 'open':
                continue                       # 过滤必须发生在合并之后
            amount, amount_seq = fields['amount']
            price, price_seq = fields['price']
            out.append({'key': key, 'status': status, 'status_seq': status_seq,
                        'amount': amount, 'amount_seq': amount_seq,
                        'price': price, 'price_seq': price_seq, 'versions': len(recs)})
        return out

    cases = [
        pycase('基线：三个 key 两条流乱序到达，逐字段版本归一 + 打宽',
               SCHEMA, VIEW,
               [row(101, 1, 5, 1, 900, status='open', amount=300),      # ts 小但 seq 大 ⇒ 它是新版本
                row(101, 1, 3, 4, 5000, status='hold', amount=200),
                row(101, 2, 2, 2, 700, price=9900),
                row(102, 1, 1, 3, 100, status='open', amount=100),
                row(103, 1, 1, 5, 100, status='open', amount=50),
                row(103, 1, 2, 6, 200, amount=70),                      # status 传 null ⇒ 保持 open
                row(103, 2, 1, 7, 150, price=10)],
               merge,
               note='101：seq 5 赢（ts 反而更小 ⇒ 拿 ts 当业务顺序的实现会挑错版本）；'
                    '103：status 来自 seq 1、amount 来自 seq 2 ⇒ 两个 *_seq 不同，'
                    '这正是"逐字段版本"与"整行覆盖"的分界'),
        pycase('边界：旧行 open、新行 closed ⇒ 合并后不满足谓词，这个 key 不许出行',
               SCHEMA, VIEW,
               [row(201, 1, 1, 1, 100, status='open', amount=10),
                row(201, 1, 2, 2, 200, status='closed', amount=20),
                row(201, 2, 1, 3, 150, price=8800),
                row(202, 1, 1, 4, 100, status='closed', amount=30),
                row(202, 1, 2, 5, 200, status='open', amount=40)],
               merge,
               note='201 合并后是 closed ⇒ 整行不许出现（它"曾经 open"不是理由）；'
                    '202 方向相反：合并后才是 open（amount 40、status_seq 2、price 仍是 null 且 '
                    'price_seq -1、versions 2）。两条一起看才分得清"先过滤"错在哪一步'),
        pycase('边界：后到的记录该字段是 null ⇒ 保持原值，*_seq 也停在旧那条',
               SCHEMA, VIEW,
               [row(301, 1, 1, 1, 100, status='open', amount=8),
                row(301, 2, 1, 2, 110, price=5000),
                row(301, 2, 4, 3, 400, price=None),        # 价格流的一条"空更新"
                row(302, 1, 1, 4, 120, status='open', amount=None),
                row(302, 1, 9, 5, 900, status=None, amount=99)],
               merge,
               note='301：price 仍是 5000、price_seq 仍是 1（不是 -1、也不是 4）；'
                    '302：status 由 seq 1 决定、amount 由 seq 9 决定'),
        pycase('边界：删除看主流最大 seq；删完又被写回来就算复活',
               SCHEMA, VIEW,
               [row(401, 1, 1, 1, 100, status='open', amount=10),
                row(401, 1, 2, 2, 200, is_delete=1),
                row(402, 1, 1, 3, 100, status='open', amount=10),
                row(402, 1, 2, 4, 200, is_delete=1),
                row(402, 1, 3, 5, 300, status='open', amount=99),
                row(402, 2, 1, 6, 120, price=700),
                row(403, 1, 2, 7, 500, is_delete=1),        # 到达更早，但 seq 更大
                row(403, 1, 1, 8, 900, status='open', amount=5)],
               merge,
               note='401 消失；402 复活（versions 4、status_seq 3、price 仍带着 700）；'
                    '403 按到达顺序看是"先删后写"，按业务顺序看是"写了又删"⇒ 必须消失，'
                    '这条测的就是"用 arrived/入表顺序当版本"的写法'),
        pycase('边界：同一 key 同一 seq 两条 ⇒ tie-break 取 arrived 大者',
               SCHEMA, VIEW,
               [row(501, 1, 7, 3, 100, status='open', amount=1),
                row(501, 1, 7, 6, 200, status='open', amount=2),
                row(501, 2, 7, 5, 300, price=11),
                row(501, 2, 7, 8, 400, price=22)],
               merge,
               note='两条同 seq 的记录必须可判定：arrived 大者后写 ⇒ amount=2、price=22；'
                    '两个 *_seq 都是 7（seq 不能区分它们，所以输出里没有 arrived）'),
        pycase('退化：只有价格流到过的 key、以及只有删除记录的 key 都不许出行',
               SCHEMA, VIEW,
               [row(601, 2, 1, 1, 100, price=500),
                row(602, 1, 1, 2, 110, is_delete=1),
                row(603, 1, 1, 3, 120, status='open', amount=1)],
               merge,
               note='601 连 status 都没有 ⇒ 谓词不成立（写成 `status = \'open\' OR status IS NULL` 的会多一行）；'
                    '602 只剩一条删除；603 是这题唯一的对照组，缺了它两条退化都判不出来'),
        pycase('退化：一条记录都没有 ⇒ 空结果（不许凭空造一行"零状态"）',
               SCHEMA, VIEW, [], merge),
    ]

    reference = """import pyspark.sql.functions as F
from pyspark.sql import Window


def solve(spark):
    r = spark.table('changes')
    # 业务顺序 = (seq, arrived)：ts 是墙上时钟，本题不许用它定版本
    part = Window.partitionBy('key').orderBy('seq', 'arrived')
    ord_col = F.col('seq') * F.lit(1000000) + F.col('arrived')
    last_main = F.last(F.when(F.col('stream') == 1, ord_col), True).over(part)
    last_del = F.last(F.when((F.col('stream') == 1) & (F.col('is_delete') == 1), ord_col), True).over(part)
    staged = (r
              .withColumn('status_v', F.last('status', True).over(part))
              .withColumn('status_s', F.last(F.when(F.col('status').isNotNull(), F.col('seq')), True).over(part))
              .withColumn('amount_v', F.last('amount', True).over(part))
              .withColumn('amount_s', F.last(F.when(F.col('amount').isNotNull(), F.col('seq')), True).over(part))
              .withColumn('price_v', F.last('price', True).over(part))
              .withColumn('price_s', F.last(F.when(F.col('price').isNotNull(), F.col('seq')), True).over(part))
              .withColumn('ord_main', last_main)
              .withColumn('ord_del', last_del)
              .withColumn('versions', F.count(F.lit(1)).over(Window.partitionBy('key')))
              .withColumn('rn', F.row_number().over(
                  Window.partitionBy('key').orderBy(F.col('seq').desc(), F.col('arrived').desc()))))
    merged = (staged
              .filter(F.col('rn') == 1)
              .filter(F.col('ord_del').isNull() | (F.col('ord_del') != F.col('ord_main'))))
    # 谓词在合并之后：这里才允许出现 status 上的等值过滤
    return (merged
            .filter(F.col('status_v') == 'open')
            .select(F.col('key'),
                    F.col('status_v').alias('status'),
                    F.coalesce(F.col('status_s'), F.lit(-1)).alias('status_seq'),
                    F.col('amount_v').alias('amount'),
                    F.coalesce(F.col('amount_s'), F.lit(-1)).alias('amount_seq'),
                    F.col('price_v').alias('price'),
                    F.coalesce(F.col('price_s'), F.lit(-1)).alias('price_seq'),
                    F.col('versions'))
            .orderBy('key'))
"""

    naive = """import pyspark.sql.functions as F
from pyspark.sql import Window


def solve(spark):
    r = spark.table('changes')
    # 1) 删除记录"没值"，先丢掉省一半数据 —— 于是 key 永远不会消失
    live = r.filter(F.col('is_delete') == 0)
    # 2) 谓词下推到合并之前（看板只看 open）
    live = live.filter((F.col('status') == 'open') | F.col('status').isNull())
    # 3) 版本顺序用 ts：它才是"真实时间"，seq 只是业务编号
    w = Window.partitionBy('key').orderBy('ts', 'arrived')
    last = (live
            .withColumn('status_v', F.last('status').over(w))
            .withColumn('amount_v', F.last('amount').over(w))
            .withColumn('price_v', F.last('price').over(w))
            .withColumn('seq_v', F.last('seq').over(w))
            .withColumn('cnt', F.count(F.lit(1)).over(Window.partitionBy('key')))
            .withColumn('rn', F.row_number().over(
                Window.partitionBy('key').orderBy(F.col('ts').desc(), F.col('arrived').desc()))))
    # 4) 整行覆盖：三个字段都记在同一条记录的 seq 上
    return (last
            .filter(F.col('rn') == 1)
            .filter(F.col('status_v') == 'open')
            .select(F.col('key'),
                    F.col('status_v').alias('status'),
                    F.col('seq_v').alias('status_seq'),
                    F.col('amount_v').alias('amount'),
                    F.col('seq_v').alias('amount_seq'),
                    F.col('price_v').alias('price'),
                    F.col('seq_v').alias('price_seq'),
                    F.col('cnt').alias('versions'))
            .orderBy('key'))
"""

    statement = """主键宽表 `trade_wide` 由**两条流**写同一批 key，本题把这张表的合并过程等价重写成一次
Spark 批处理：读视图 `changes`（下表全部记录），算出**合并之后**的最终表。

| 列 | 含义 |
| --- | --- |
| `key` | 主键 |
| `stream` | 1 = 主流（写 `status`/`amount`），2 = 价格流（写 `price`） |
| `seq` | **本流内的业务顺序**，越大越新 |
| `arrived` | 到达序号，只用于同一 `seq` 内的 tie-break |
| `ts` | 墙上时钟，**不能**用来定版本（乱序、时钟回拨、补数都会让它与 `seq` 反向） |
| `status` / `amount` / `price` | 值列，可以为 null（表示"这条记录没写这个字段"） |
| `is_delete` | 1 = 删除记录；只有主流会带，且删除记录的值列一律为 null |

合并契约（逐条都是判分点）：

1. 每个字段**独立**取"该字段最后一个非 null 输入"（先比 `seq`，同 `seq` 比 `arrived` 大者）；
   **null 输入保持原值，不覆盖**。
2. 每个值字段配一个来源列：`status_seq` / `amount_seq` / `price_seq` = 决定该字段的那条记录的 `seq`，
   该字段从未被写过时输出 `-1`（此时值列为 null）。
3. 删除只看主流：主流里业务顺序最大（`seq` 最大、同 `seq` 取 `arrived` 最大）的那条如果是删除
   ⇒ 这个 key **整行消失**；之后再出现非删除的主流记录 ⇒ 复活（值仍按规则 1 逐字段归并）。
4. **谓词必须发生在合并之后**：只输出合并后 `status = 'open'` 的 key。
   先按 `status` 过滤输入是错的。
5. `versions` = 该 key 的输入记录条数（含被折叠掉的版本、含删除记录）。

## 输入

视图 `changes`，列与类型：`key INT, stream INT, seq BIGINT, arrived INT, ts BIGINT, status STRING,
amount BIGINT, price BIGINT, is_delete INT`。

## 输出

一行一个 key，列**固定**为
`key, status, status_seq, amount, amount_seq, price, price_seq, versions`，按 `key` 升序。
`status` 恒为 `'open'`，但它是合并的结果，不许当常量塞回去。
禁止 `collect()`（判题器要的是可分区的结果，不是驱动内存里的一份副本）。

## 说明

机制对照：规则 1–3 是 Paimon 主键表 `merge-engine = partial-update` + sequence group 的语义
（"非 null 输入替换对应字段、null 保持不变"、"latest 依记录顺序，到达顺序不代表业务顺序时要配
sequence field"）；规则 4 是"可变非键列的过滤不能在合并前下推"。**把这套机制重写成一次 Spark
批处理是本题设定**，题面里的列名、`-1` 约定、tie-break 都是本题契约，不是任何产品的接口。
"""

    return base(
        'big-data', 'senior',
        '主键宽表的逐字段版本归一：null 不覆盖、删除看主流、谓词必须后于合并',
        statement, 'pyspark',
        ['paimon-partial-update', 'sequence-group', 'late-predication',
         'changelog-merge', 'modern:lakehouse'],
        src('数据研发（实时湖仓 / 主键表方向） 高级工程师',
            DATA + '#5 题面草稿 A（changelog 归一 + 版本正确合并：按 key 取业务顺序最新版本、'
            '"谓词必须后于合并"、null 不覆盖的打宽语义、同 seq 的确定性 tie-break；'
            '§1.5 与 §6 D5/D7/D8。用 Spark 等价重写这条机制属素材 §7 第 6 条标注的【推】，'
            '题面已写成"本题契约"）'),
        language='python',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=25,
        answer="""## 参考答案要点

一次 `Window.partitionBy('key').orderBy('seq','arrived')` + 六个
`F.last(..., ignorenulls=True)`，取 `rn = 1` 那一行，**最后**才过滤 `status = 'open'`。

**为什么是"最后一个非 null"而不是"最后一条记录的字段值"**：`ignorenulls=False` 就是
"整行覆盖"，也就是 `deduplicate` 引擎 —— 而两条流打宽要的是 `partial-update`。
用例「后到的记录该字段是 null」测的正是这一格：301 的 `price` 必须还是 5000、
`price_seq` 必须还是 1。把它写成 4（"最后一条的 seq"）说明你**记得**忽略 null 但
把 provenance 记在了整行上 —— 这在只有一列的报表里看不出来，在三列×两条流打宽的表里
就是"这条数据到底是哪个流写的"再也查不到。

**为什么谓词要在合并之后**（用例「旧行 open、新行 closed」）：`status` 是可变非键列，
合并前过滤会连同"替代行"一起扔掉 —— 素材 §1.5 的原文结论是
"过早按 `status='open'` 过滤会丢掉替代行、错误地返回旧行"，生产症状是
"看板昨天还对、今天多了 3% 的单"，而数据一行都没坏。
这题刻意不让你只测"值对不对"：202（closed → open）先过滤**刚好**也给出一样的值列，
但它把 `versions` 从 2 报成 1（被扔掉的那条记录不再计数），
并且三个 `*_seq` 全被记成同一条记录的 seq。
provenance 与计数摊进列里，方向才藏不住。

**删除只能看主流的最大业务顺序**（用例「删除看主流最大 seq」）：
401 消失；402 复活（`versions` 4、`status_seq` 3、`price` 还是 700 且 `price_seq` 1）；
403 的删除记录**到达更早但 seq 更大** ⇒ 仍然是消失。
朴素解 `filter(is_delete == 0)` 之后 key 永远不会消失，
于是 401 会带着删除前的 `(open, 10)` 回来 —— 这正是"上游删了单、下游还在算 GMV"的形状。

**同 seq 的 tie-break**（用例「同一 key 同一 seq 两条」）：按 `arrived` 大者后写。
本题把它写进契约，是因为 Spark 在 `orderBy` 有并列时**不保证行序**：
不定义 tie-break 的题目会做出一个"参考解自己都不稳定"的判分，
所以输出列里刻意不放 `arrived`。

**退化两条**：601 只有价格流 ⇒ 合并后 `status` 为 null ⇒ 不出现
（写成 `status = 'open' OR status IS NULL` 的会多一行"没有状态的订单"）；
602 只有一条删除 ⇒ 不出现；603 是唯一的对照组，没有它这两条退化都判成"空表"而看不出区别。
空输入必须返回**空结果**（`[]`）：三个值列都 `-1`/null 的"零状态行"是凭空造的。

**工程延伸（面试追问点）**

1. 这套合并为什么要 `sequence group` 而不是一个全局 seq？
   （两条流的 seq 各自单调，拼在一起不单调；用同一个 seq 排序会让"后到的价格"倒灌主流字段。）
2. 先过滤为什么"看起来"是优化？（谓词下推对**不可变列**（分区键、主键）才是纯收益，
   对可变非键列要付"替代行被丢掉"的正确性代价 —— 素材 §1.5 的原文结论。）
3. 结果要写回 Paimon 时，`is_delete` 与 `versions` 该不该落库？
   （不该：删除是合并的**结果**、versions 是过程的**副产品**，落库就等于把中间态当事实。）""",
    )


# ============================================ A7 Sentinel 熔断降级状态机（慢调用比例/异常比例/异常数）
@draft('alg-ab-circuitbreaker-state')
def q_circuitbreaker_state():
    """考点 10：三种熔断策略 + 最小请求数门槛 + HALF-OPEN 单请求探测 + BlockException 不进样本。

    与下面的 Python 模型**同一条判据**（java-junit 的 input 是位置参数数组），
    所以 `precheck.py` 必须换一种算法重写才叫交叉验证 —— 那里改成
    "先把整条流水按桶物化、再逐桶判定"，不维护增量累加器。
    """
    STRAT = {'slow': 0, 'err-ratio': 1, 'err-count': 2}

    def breaker(strategy, rt_limit, threshold, min_requests, interval, trip_ms, kind, rt, ts):
        if strategy not in (0, 1, 2):
            raise ModelError('unknown strategy')
        if interval <= 0:
            raise ModelError('stat interval must be positive')
        if trip_ms <= 0:
            raise ModelError('trip duration must be positive')
        if min_requests < 0:
            raise ModelError('min requests must be non-negative')
        if rt_limit < 0:
            raise ModelError('rt limit must be non-negative')
        if threshold < 0 or (strategy in (0, 1) and threshold > 100):
            raise ModelError('threshold out of range')
        same_len([('kind', kind), ('rt', rt), ('ts', ts)])
        for i in range(len(kind)):
            if ts[i] < 0:
                raise ModelError('negative timestamp')
            if i > 0 and ts[i] <= ts[i - 1]:
                raise ModelError('timestamps must increase')
            if kind[i] not in (0, 1, 2):
                raise ModelError('unknown call kind')
            if rt[i] < 0:
                raise ModelError('negative rt')

        trips = rejected = sampled = blocked_seen = probes = 0
        max_total = max_bad = 0
        is_open, open_until = False, 0
        bucket, total, bad = -1, 0, 0
        for i in range(len(kind)):
            if is_open:
                if ts[i] >= open_until:                 # HALF-OPEN：这一条就是探测请求
                    probes += 1
                    is_open = False
                    # 慢调用比例策略的恢复判据是官方的"RT 小于允许的最大 RT"（严格小于）；
                    # 异常类策略的恢复判据是本题契约：探测请求不抛业务异常即恢复。
                    ok = (kind[i] == 0 and rt[i] < rt_limit) if strategy == 0 else (kind[i] != 1)
                    if not ok:
                        trips += 1
                        is_open, open_until = True, ts[i] + trip_ms
                    else:
                        bucket, total, bad = -1, 0, 0
                else:
                    rejected += 1                        # OPEN 期间短路：不进样本、不进桶
                continue
            b = ts[i] // interval
            if b != bucket:
                bucket, total, bad = b, 0, 0
            if kind[i] == 2:                             # BlockException 不进样本
                blocked_seen += 1
                continue
            sampled += 1
            total += 1
            if (kind[i] == 0 and rt[i] > rt_limit) if strategy == 0 else (kind[i] == 1):
                bad += 1
            max_total = max(max_total, total)
            max_bad = max(max_bad, bad)
            if total > min_requests:                     # **严格大于**：官方写的是"请求数 > 最小请求数"
                if strategy in (0, 1):
                    trip = bad * 100 > threshold * total
                else:
                    trip = bad > threshold
                if trip:
                    trips += 1
                    is_open, open_until = True, ts[i] + trip_ms
                    bucket, total, bad = -1, 0, 0        # 熔断即清空当前桶
        return [trips, 1 if is_open else 0, rejected, sampled, blocked_seen,
                max_total, max_bad, probes]

    K_OK, K_ERR, K_BLOCK = 0, 1, 2

    cases = [
        jcase('基线：慢调用比例策略，第 5 条才越线、熔断一次',
              [STRAT['slow'], 100, 50, 4, 1000, 500,
               [K_OK, K_OK, K_OK, K_OK, K_OK], [50, 200, 300, 60, 400], [10, 20, 30, 40, 50]],
              breaker,
              note='五条里三条慢（200 / 300 / 400 都 > 允许的最大 RT 100）⇒ 比例 60% > 50%，'
                   '但前四条的 total 还没**超过**门槛 4，所以第 5 条结束时才同时满足两个严格大于；'
                   'openUntil = 50 + 500 = 550，而流水到 ts=50 就结束 ⇒ 结尾状态仍是 OPEN'),
        jcase('边界：请求数恰好等于最小请求数、比例恰好等于阈值 ⇒ 一次都不熔断',
              [STRAT['slow'], 100, 50, 4, 1000, 500,
               [K_OK, K_OK, K_OK, K_OK], [200, 60, 300, 40], [10, 20, 30, 40]],
              breaker,
              note='total 最大到 4，而门槛是"严格大于 4"；就算看比例，2/4 = 50% 也只是**等于**阈值 50%。'
                   '两处都是边界，任何一处写成 >= 就会多熔断一次'),
        jcase('边界：BlockException 只记 blockedSeen，不许把比例摊薄',
              [STRAT['err-ratio'], 100, 50, 1, 1000, 500,
               [K_BLOCK, K_BLOCK, K_BLOCK, K_ERR, K_ERR], [10, 10, 10, 10, 10],
               [10, 20, 30, 40, 50]],
              breaker,
              note='官方明写"异常降级仅针对业务异常，对 BlockException 不生效"。'
                   '五条流水 = 3 条 block + 2 条业务异常：正确实现的样本只有那 2 条 ⇒ 比例 100% ⇒ 熔断；'
                   '把 block 塞进分母就是 2/5 = 40% < 50% ⇒ **永远不熔断** —— '
                   '这正是素材 §2 追问 12"熔断了但大盘不红"的形状'),
        jcase('边界：熔断时长内的三条请求全被短路，一条探测都没放出去',
              [STRAT['err-ratio'], 100, 50, 1, 1000, 400,
               [K_ERR, K_ERR, K_ERR, K_OK, K_OK], [10, 10, 10, 10, 10], [100, 200, 300, 450, 500]],
              breaker,
              note='第 2 条就越线（total 2 > 1 且异常比例 100% > 50%）⇒ openUntil = 200 + 400 = 600；'
                   'ts 300 / 450 / 500 三条都在 600 之前 ⇒ 全部只记 rejected。'
                   'probes=0 说明"恢复时刻还没到"，sampled=2 只统计熔断前那两条'),
        jcase('边界：过了熔断时长的第一条就是探测请求，探测成功不进样本',
              [STRAT['err-ratio'], 100, 50, 1, 1000, 400,
               [K_ERR, K_ERR, K_OK], [10, 10, 10], [100, 200, 700]],
              breaker,
              note='openUntil=600 ⇒ ts=700 的第一条被当成探测请求；它不抛业务异常 ⇒ 恢复。'
                   'probes=1、sampled 仍是 2（**探测请求不进样本**）、结尾 CLOSED'),
        jcase('边界：探测请求再次失败 ⇒ 再次熔断，trips 累加而不是重置',
              [STRAT['err-ratio'], 100, 50, 1, 1000, 400,
               [K_ERR, K_ERR, K_ERR, K_ERR], [10, 10, 10, 10], [100, 200, 300, 700]],
              breaker,
              note='第一次在 total=2 越线（openUntil=600），ts 300 被短路，'
                   'ts 700 已过 openUntil ⇒ 它**是**探测请求；探测又抛业务异常 ⇒ 再次熔断，'
                   'trips=2、结尾 OPEN'),
        jcase('边界：慢调用策略的探测要求 RT 严格小于允许值',
              [STRAT['slow'], 100, 50, 1, 1000, 400,
               [K_OK, K_OK, K_OK, K_OK], [200, 300, 100, 90], [10, 20, 420, 700]],
              breaker,
              note='前两条都慢 ⇒ total=2 > 1 且 2/2 = 100% > 50% ⇒ openUntil = 20 + 400 = 420；'
                   '第 3 条 ts=420 正好到点、**是**探测请求，但 RT 恰好等于 100 ⇒ 不算恢复'
                   '（官方判据是"小于"）⇒ 再熔断一次，openUntil = 420 + 400 = 820；'
                   '于是第 4 条（RT 90，本来能让它恢复）落在熔断期内被短路。'
                   '探测判据若写成 <=，这条就会当场恢复：trips 从 2 变 1、rejected 从 1 变 0'),
        jcase('边界：异常数策略看条数不看比例',
              [STRAT['err-count'], 100, 2, 1, 1000, 500,
               [K_ERR, K_ERR, K_ERR, K_ERR, K_ERR, K_ERR], [10] * 6,
               [10, 20, 30, 5000, 5010, 5020]],
              breaker,
              note='第 2 条时 bad=2 **等于**阈值 2 不算越线（又是严格大于），第 3 条 bad=3 才熔断'
                   '（openUntil = 30 + 500 = 530）；ts=5000 落进新桶（5000 / 1000 = 5）并且它就是探测请求，'
                   '它又抛异常 ⇒ 再熔断，剩下两条被短路 ⇒ max-window-total 停在 3'),
        jcase('边界：探测恢复之后重新起算，旧桶的累计不许带过来',
              [STRAT['err-ratio'], 100, 50, 2, 1000, 400,
               [K_OK, K_ERR, K_ERR, K_OK, K_OK, K_OK], [10] * 6, [10, 20, 30, 450, 500, 600]],
              breaker,
              note='第 3 条越线（total 3 > 2、比例 2/3 ≈ 66% > 50%）⇒ openUntil=430；'
                   'ts=450 探测成功 ⇒ CLOSED 且桶作废。之后两条 OK 仍落在同一个统计区间（都在 1000 之内），'
                   '如果旧桶的 total=3、bad=2 被带过来，max-window-total 会涨到 5 而不是 3 —— '
                   '这一列就是"清了没清"的证据'),
        jcase('退化：一条请求都没有 ⇒ 八个数全 0、状态 CLOSED',
              [STRAT['slow'], 100, 50, 4, 1000, 500, [], [], []], breaker,
              note='空样本不许被当成"熔断器坏了"，也不许报"100% 慢调用"'),
        jcase('非法：异常比例阈值写成 120（官方阈值域是 [0.0, 1.0]）',
              [STRAT['err-ratio'], 100, 120, 1, 1000, 500, [K_ERR], [10], [10]],
              breaker, throws='IllegalArgumentException', throws_message='threshold out of range',
              note='比例类阈值越界必须在**入口**就拒；写成"120% 永远不会触发"就是把规则配没了'),
        jcase('非法：到达时刻不递增（乱序样本没法分桶）',
              [STRAT['slow'], 100, 50, 1, 1000, 500, [K_OK, K_OK], [10, 10], [100, 90]],
              breaker, throws='IllegalArgumentException', throws_message='timestamps must increase'),
    ]

    reference = """public class Solution {
  // kind: 0 = 正常返回, 1 = 业务异常, 2 = BlockException（限流/降级自身的异常）
  // 返回：[trips, stateAtEnd, rejected, sampled, blockedSeen, maxWindowTotal, maxWindowBad, probes]
  public static int[] breakerWindow(int strategy, int rtLimitMs, int threshold, int minRequests,
                                    int statIntervalMs, int tripDurationMs,
                                    int[] kind, int[] rt, int[] ts) {
    if (strategy < 0 || strategy > 2) throw new IllegalArgumentException("unknown strategy");
    if (statIntervalMs <= 0) throw new IllegalArgumentException("stat interval must be positive");
    if (tripDurationMs <= 0) throw new IllegalArgumentException("trip duration must be positive");
    if (minRequests < 0) throw new IllegalArgumentException("min requests must be non-negative");
    if (rtLimitMs < 0) throw new IllegalArgumentException("rt limit must be non-negative");
    if (threshold < 0 || ((strategy == 0 || strategy == 1) && threshold > 100))
      throw new IllegalArgumentException("threshold out of range");
    if (kind.length != rt.length || rt.length != ts.length)
      throw new IllegalArgumentException("array length mismatch");
    for (int i = 0; i < kind.length; i++) {
      if (ts[i] < 0) throw new IllegalArgumentException("negative timestamp");
      if (i > 0 && ts[i] <= ts[i - 1]) throw new IllegalArgumentException("timestamps must increase");
      if (kind[i] < 0 || kind[i] > 2) throw new IllegalArgumentException("unknown call kind");
      if (rt[i] < 0) throw new IllegalArgumentException("negative rt");
    }
    int trips = 0, rejected = 0, sampled = 0, blockedSeen = 0, probes = 0;
    int maxTotal = 0, maxBad = 0;
    boolean open = false;
    int openUntil = 0, bucket = -1, total = 0, bad = 0;
    for (int i = 0; i < kind.length; i++) {
      if (open) {
        if (ts[i] >= openUntil) {              // HALF-OPEN：这条就是探测请求
          probes++;
          open = false;
          boolean ok = (strategy == 0) ? (kind[i] == 0 && rt[i] < rtLimitMs) : (kind[i] != 1);
          if (ok) {
            bucket = -1; total = 0; bad = 0;
          } else {
            trips++; open = true; openUntil = ts[i] + tripDurationMs;
          }
        } else {
          rejected++;                          // 短路：不进样本、不进桶
        }
        continue;
      }
      int b = ts[i] / statIntervalMs;
      if (b != bucket) { bucket = b; total = 0; bad = 0; }
      if (kind[i] == 2) { blockedSeen++; continue; }
      sampled++;
      total++;
      boolean isBad = (strategy == 0) ? (kind[i] == 0 && rt[i] > rtLimitMs) : (kind[i] == 1);
      if (isBad) bad++;
      if (total > maxTotal) maxTotal = total;
      if (bad > maxBad) maxBad = bad;
      if (total > minRequests) {               // 严格大于
        boolean trip = (strategy == 0 || strategy == 1)
            ? (long) bad * 100 > (long) threshold * total
            : bad > threshold;
        if (trip) {
          trips++;
          open = true; openUntil = ts[i] + tripDurationMs;
          bucket = -1; total = 0; bad = 0;     // 熔断即清空当前桶
        }
      }
    }
    return new int[] {trips, open ? 1 : 0, rejected, sampled, blockedSeen,
        maxTotal, maxBad, probes};
  }
}
"""

    naive = """public class Solution {
  // 四个"看起来一样"的写法：门槛写成 >=、BlockException 也算样本、
  // OPEN 期间照样放行、恢复用"下一个窗口的平均"而不是单条探测请求。
  public static int[] breakerWindow(int strategy, int rtLimitMs, int threshold, int minRequests,
                                    int statIntervalMs, int tripDurationMs,
                                    int[] kind, int[] rt, int[] ts) {
    if (strategy < 0 || strategy > 2) throw new IllegalArgumentException("unknown strategy");
    if (statIntervalMs <= 0) throw new IllegalArgumentException("stat interval must be positive");
    if (tripDurationMs <= 0) throw new IllegalArgumentException("trip duration must be positive");
    if (minRequests < 0) throw new IllegalArgumentException("min requests must be non-negative");
    if (rtLimitMs < 0) throw new IllegalArgumentException("rt limit must be non-negative");
    if (threshold < 0 || ((strategy == 0 || strategy == 1) && threshold > 100))
      throw new IllegalArgumentException("threshold out of range");
    if (kind.length != rt.length || rt.length != ts.length)
      throw new IllegalArgumentException("array length mismatch");
    for (int i = 0; i < kind.length; i++) {
      if (ts[i] < 0) throw new IllegalArgumentException("negative timestamp");
      if (i > 0 && ts[i] <= ts[i - 1]) throw new IllegalArgumentException("timestamps must increase");
      if (kind[i] < 0 || kind[i] > 2) throw new IllegalArgumentException("unknown call kind");
      if (rt[i] < 0) throw new IllegalArgumentException("negative rt");
    }
    int trips = 0, sampled = 0, blockedSeen = 0;
    int maxTotal = 0, maxBad = 0;
    int bucket = -1, total = 0, bad = 0;
    for (int i = 0; i < kind.length; i++) {
      int b = ts[i] / statIntervalMs;
      if (b != bucket) { bucket = b; total = 0; bad = 0; }
      sampled++;
      total++;                                  // BlockException 也进分母
      if (kind[i] == 2) blockedSeen++;
      boolean isBad = (strategy == 0) ? rt[i] >= rtLimitMs : kind[i] == 1;   // >= 而不是 >
      if (isBad) bad++;
      if (total > maxTotal) maxTotal = total;
      if (bad > maxBad) maxBad = bad;
      if (total >= minRequests) {               // >= 而不是 >
        boolean trip = (strategy == 0 || strategy == 1)
            ? (long) bad * 100 >= (long) threshold * total   // 等于阈值也算越线
            : bad >= threshold;
        if (trip) trips++;                      // 不清空桶、也不落 OPEN 状态
      }
    }
    return new int[] {trips, 0, 0, sampled, blockedSeen, maxTotal, maxBad, 0};
  }
}
"""

    statement = """## 背景

Sentinel《熔断降级》给的三种策略都自带**恢复判据**【源 S17】：

> 慢调用比例："**熔断时长后进入 HALF-OPEN 探测恢复**，接下来一个请求 RT 小于慢调用 RT
> 则结束熔断，否则再次熔断"；异常比例的阈值域是 **[0.0, 1.0]**；另有"异常数"策略。

同一条文档里还有两句更值钱的限制：

> 触发条件是"**在 statIntervalMs 内请求数大于最小请求数，并且慢调用比例大于阈值**"；
> "**异常降级仅针对业务异常，对 Sentinel 限流降级本身的异常（BlockException）不生效**"。

素材 §2 追问 12 把后者写成一个现场问题："熔断了但大盘不红，为什么？"
—— 你自己抛的限流异常**不计入业务异常**，所以缺一条独立的"降级触发率"曲线【源 S17】。

## 任务

实现 `breakerWindow(...)`，把一段调用结果流水喂给熔断器，回放之后输出八个统计量。

```java
int[] breakerWindow(int strategy, int rtLimitMs, int threshold, int minRequests,
                    int statIntervalMs, int tripDurationMs, int[] kind, int[] rt, int[] ts)
```

- `strategy`：0 = 慢调用比例，1 = 异常比例，2 = 异常数；
- `kind[i]`：0 = 正常返回，1 = **业务异常**，2 = **BlockException**（限流/降级自身的异常）；
- `rt[i]` / `ts[i]`：该次调用的 RT（ms）与到达时刻（逻辑毫秒，**严格递增**）。

### 判分契约（前四条来自官方描述，其余是本题设定）

| # | 判据 |
| --- | --- |
| 1 | 统计桶 = `ts / statIntervalMs`（整除）；**每个请求处理完就检查当前桶**，不是只在桶结束时检查 |
| 2 | 越线条件：`total > minRequests` **严格大于**，且（策略 0/1）`bad × 100 > threshold × total`（比例**等于**阈值不算越线）；策略 2 用 `bad > threshold` |
| 3 | 坏数定义：策略 0 = `kind==0 且 rt > rtLimitMs`（RT **等于**允许值不算慢）；策略 1/2 = `kind == 1` |
| 4 | `kind == 2` 的请求只记 `blocked-seen`：**不进样本、不进分母、不进分子** |
| 5 | 熔断 ⇒ `trips++`、进入 OPEN、`openUntil = 该请求的 ts + tripDurationMs`，并**清空当前桶** |
| 6 | OPEN 期间（`ts < openUntil`）的请求一律被短路：只记 `rejected`，不进样本也不进桶 |
| 7 | `ts >= openUntil` 的第一条请求就是**探测请求**：只记 `probes`，不进样本；策略 0 要求 `kind==0 且 rt < rtLimitMs`（**严格小于**，官方原话是"小于"）才算恢复成功，策略 1/2 要求 `kind != 1`。恢复失败 ⇒ 再熔断一次（`trips` 累加）并重新计时 |
| 8 | 结尾状态 `state-at-end`：最后一个请求处理完仍在 OPEN 时长内 ⇒ 1，否则 0 |

### 输出八个值（顺序固定）

`[trips, state-at-end, rejected, sampled, blocked-seen, max-window-total, max-window-bad, probes]`

- `sampled` = 计入统计的请求条数（不含 kind==2，不含被短路的，不含探测请求）；
- `max-window-total` / `max-window-bad` = 任意时刻某个桶内曾达到的**最大**样本数 / 最大坏数。

### 入口校验（必须抛 `IllegalArgumentException`，消息逐字一致）

`unknown strategy`｜`stat interval must be positive`｜`trip duration must be positive`｜
`min requests must be non-negative`｜`rt limit must be non-negative`｜`threshold out of range`
（`threshold < 0`，或比例类策略 `threshold > 100`）｜`array length mismatch`｜
`negative timestamp`｜`timestamps must increase`｜`unknown call kind`｜`negative rt`。

## 说明

素材 §7 第 3 条明写"AHAS / MSE 治理中心的**线上阈值基线**没有可核查出处"，
所以本题**不出现任何推荐阈值**：阈值、时长、最小请求数全部是入参，
考点是"越线与恢复的**判据方向**"，不是"该配多少"。
HALF-OPEN 的探测请求"只用于决定恢复、不进统计桶"是本题设定 ——
官方给的是"接下来一个请求 RT 小于慢调用 RT 则结束熔断"，没说它进不进样本。
"""

    return base(
        'algorithms', 'senior',
        'Sentinel 熔断降级状态机：最小请求数与比例都是严格大于、Block 不进样本、HALF-OPEN 一条请求定生死',
        statement, 'java-junit',
        ['circuit-breaker', 'slow-call-ratio', 'block-exception-sample', 'half-open-probe',
         'threshold-direction', 'modern:resilience-semantics'],
        src('服务端研发（稳定性与中间件方向） 高级工程师',
            TXN + '#4 考点 10（熔断降级与"大盘不红"的监控口径：慢调用比例/异常比例/异常数三种策略'
            '各自带恢复判据，"熔断时长后进入 HALF-OPEN 探测恢复，接下来一个请求 RT 小于慢调用 RT '
            '则结束熔断，否则再次熔断"、异常比例阈值域 [0.0,1.0]、触发条件"statIntervalMs 内请求数'
            '大于最小请求数并且慢调用比例大于阈值"、**"异常降级仅针对业务异常，对 BlockException '
            '不生效"**【源 S17】；§2 追问 12 与 §3 的"熔断了但大盘不红"。'
            '三类策略共用最小请求数门槛、探测请求不进样本、熔断即清空当前桶是【推】，'
            '题面已写成契约；素材 §7 第 3 条禁止的"线上推荐阈值"题面一个都没用）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'int[] breakerWindow(int strategy, int rtLimitMs, int threshold, '
                             'int minRequests, int statIntervalMs, int tripDurationMs, '
                             'int[] kind, int[] rt, int[] ts)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer="""## 参考答案

单遍扫流水，维护 `(bucket, total, bad)` 三个累加器 + `(open, openUntil)` 两个状态位。
**没有一处需要浮点数**：比例判据写成 `bad × 100 > threshold × total` 的整数式，
否则"恰好等于阈值"这一格会因为四舍五入而飘。

**两处"严格大于"是本判题的全部区分度**（用例「请求数恰好等于最小请求数、比例恰好等于阈值」）：
官方原话是"请求数**大于**最小请求数，并且慢调用比例**大于**阈值"。
该用例里 `total` 最大 4、门槛 4，比例 2/4 = 50% 又正好等于阈值 50% ⇒
**八个数是 `[0, 0, 0, 4, 0, 4, 2, 0]`：一次都不熔断**。
把门槛或比例任一写成 `>=`，`trips` 立刻变成非 0。

**基线那条给出 `[1, 1, 0, 5, 0, 5, 3, 0]`**：五条里三条慢（`rt` 200 / 300 / 400 都 > 100），
比例 60% 早就越过 50%，但**前四条的 total 没超过门槛 4**，
所以直到第 5 条才成立 `3 × 100 > 50 × 5` ⇒ 熔断一次；
`openUntil = 50 + 500 = 550` 而流水到 ts=50 就结束 ⇒ 第八格 `probes=0`、第二格 `state-at-end=1`。
**"最后一条才越线"是刻意设计的**：前四条恰好卡在门槛上。

**`kind == 2` 只进 `blocked-seen`**（用例「BlockException 只记 blockedSeen」）：
`[1, 1, 0, 2, 3, 2, 2, 0]` —— 五条流水 = 3 条 block + 2 条业务异常，
`sampled = 2`、`blocked-seen = 3`，两条异常凑成 100% ⇒ **熔断一次**。
把 block 算进分母就变成 2/5 = 40% < 50% ⇒ **一次都不熔断**，
这就是素材 §3 那条"熔断了错误率肯定下降"的反面：
限流异常混进业务异常样本，会把真实故障**摊薄成噪音**。

**OPEN 与 HALF-OPEN 是两个不同的数，别写成"熔断中=1"**：
用例「熔断时长内的三条请求全被短路」给出 `[1, 1, 3, 2, 0, 2, 2, 0]` ——
`probes = 0` 说明"恢复时刻还没到"，`rejected = 3` 说明"到了也没放"。
用例「过了熔断时长的第一条就是探测请求」给出 `[1, 0, 0, 2, 0, 2, 2, 1]`：
`ts=700 >= openUntil=600` ⇒ 那一条是探测，它不抛异常 ⇒ 恢复（`state-at-end=0`），
而 `sampled` 仍是 2 —— **探测请求不进样本**，否则它自己会污染刚重建的窗口。
用例「探测请求再次失败」给出 `[2, 1, 1, 2, 0, 2, 2, 1]`：**trips 累加到 2 而不是重置**，
这条曲线才是"这次故障到底抖了几次"的答案。

**慢调用策略的探测判据是严格小于**（用例「探测要求 RT 严格小于允许值」）：
`RT = 100` 等于允许值 ⇒ **不算恢复**（`[2, 1, 1, 2, 0, 2, 2, 1]`），
于是 `openUntil` 被推成 `420 + 400 = 820`，本来 RT 90 能让它恢复的第 4 条
反而落进熔断期被短路（`rejected = 1`）。判据写成 `<=` 就会多恢复一次、少一次熔断。

**异常数策略与"重新起算"**：用例「异常数策略看条数不看比例」给出
`[2, 1, 2, 3, 0, 3, 3, 1]` —— 第 2 条时 `bad=2` **等于**阈值 2 不算越线，
第 3 条 `bad=3` 才熔断；`ts=5000` 落进新桶（`5000 / 1000 = 5`）且它是探测请求，
探测又抛异常 ⇒ 再熔断，`max-window-total` 因此停在 3。
用例「探测恢复之后重新起算」给出 `[1, 0, 0, 5, 0, 3, 2, 1]`：
熔断时把当前桶作废，恢复后的两条 OK 从 0 重新计，
所以 `max-window-total = 3` 而不是 5 —— **这一列就是"清了没清"的证据**。
不清空的症状不是"少熔断"，而是"恢复后立刻又被旧累计再次熔断"，
即素材 §2 追问 14 那句"按果调因"的熔断版。

**空流水与非法入参**：空数组 ⇒ 八个 0（不许报"100% 慢调用"，分母为 0 时**没有比例**）；
阈值 120 ⇒ 入口就抛 `threshold out of range`（比例类的域来自官方 [0.0, 1.0] 的百分数写法），
写成"120% 永远不会触发"等于把规则静默配没；`ts` 不递增 ⇒ `timestamps must increase`
（乱序样本没法分桶，比"算错"更糟的是"算得出来但没意义"）。

**朴素解挂六处**：门槛写成 `>=`（基线的 `trips` 变 2）、比例写成 `>=`
（"恰好等于阈值"那条用例凭空多一次熔断）、`rt >= rtLimit` 判慢、
把 `kind == 2` 塞进分母（于是 block 那条用例真的不熔断了）、
OPEN 期间照样放行（`rejected` 恒 0）、恢复用"下一桶平均"而不是单条探测
（`probes` 恒 0，且 `state-at-end` 永远是 0）—— 十二个用例里每一个都至少错一个数。

**工程延伸（面试追问点）**

1. 为什么"降级触发率"必须是独立一条曲线？（BlockException 不进业务异常样本 ⇒
   业务成功率可以一路 100% 而被拒的请求堆成山。素材 §2 追问 12 的答案就是这条。）
2. 探测请求为什么要"独占"？（放多条就变成"半开流量比例"，那是另一种设计；
   官方给的是"接下来一个请求"，本题按一个实现 —— 多放一条就会把 `sampled` 撑高。）
3. `tripDurationMs` 怎么定？（素材 §7 第 3 条：没有可核查的推荐阈值。
   可测的做法是拿"下游 RT 回落到基线的时间 + 一次完整压测周期"作为下界，
   并且要能回答"探测失败后 openUntil 重新计时会不会造成抖动放大"。）""",
    )


# ================================ M6 堆积与追赶：位点语义（强制纠正 / 重置 / 存储时长）
@draft('sql-ab-backlog-catchup')
def q_backlog_catchup():
    """考点 6 的 mysql 侧：给两张 offset 快照，算堆积、净消耗、追赶所需窗口与 SLA 违约。

    机制全部落在【源 S6】的三条原话上：堆积 = MaxOffset − ConsumerOffset、
    "若历史位点已过期被删除，服务端会将消费位点强制纠正到合法的消息位点"、
    位点由服务端存储；外加【源 S7】"按存储时长、按存储节点粒度清理，不区分是否被消费"。
    SLA 用"几个窗口"表达是**本题设定**（素材 §7 第 1 条禁止编造线上阈值）。
    """
    SNAP = [
        # snapshot_seq, node, topic, queue_id, min_off, max_off, cons_off, ts_sec
        [1, 1, 'order', 1, 1000, 5000, 4800, 0],
        [1, 1, 'order', 2, 2000, 2500, 2100, 0],
        [1, 1, 'order', 3, 300, 900, 300, 0],
        [1, 1, 'cart', 1, 0, 500, 500, 0],
        [1, 1, 'cart', 2, 10, 410, 40, 0],
        [1, 2, 'order', 1, 1000, 4000, 3800, 0],
        [1, 2, 'order', 2, 0, 200, 200, 0],
        [2, 1, 'order', 1, 1000, 6000, 5600, 30],
        [2, 1, 'order', 2, 2600, 3000, 2400, 30],      # 位点已低于 min ⇒ 被强制纠正过
        [2, 1, 'order', 3, 300, 900, 900, 30],
        [2, 1, 'cart', 1, 0, 900, 900, 30],
        [2, 1, 'cart', 2, 10, 500, 500, 30],
        [2, 2, 'order', 1, 1000, 4500, 1500, 30],      # 位点回退：重置过
        [2, 2, 'order', 2, 0, 300, 300, 30],
    ]
    COLS = ['node', 'topic', 'queues', 'dropped_queues', 'backlog', 'corrected_queues',
            'reset_queues', 'lost_gap', 'consumed_win', 'produced_win',
            'windows_to_clear', 'sla_breach']
    SLA_WINDOWS = 2          # 本题设定：两个采集周期内必须追平

    def evaluate(rows):
        snap = rows['offset_snap']
        t0 = {(r[1], r[2], r[3]): r for r in snap if r[0] == 1}
        t1 = [r for r in snap if r[0] == 2]
        groups = {}
        for r in t1:
            groups.setdefault((r[1], r[2]), []).append(r)
        out = []
        for (node, topic) in sorted(groups):
            queues = groups[(node, topic)]
            dropped = corrected = reset_cnt = 0
            backlog = lost = consumed = produced = 0
            for r in queues:
                _seq, _node, _topic, qid, min1, max1, cons1, _ts = r
                prev = t0.get((node, topic, qid))
                if prev is None or cons1 > max1 or min1 > max1:
                    dropped += 1                       # 只在 t1 出现，或这行本身不可信
                    continue
                min0, max0, cons0 = prev[4], prev[5], prev[6]
                eff0, eff1 = max(cons0, min0), max(cons1, min1)
                gap = max(min1 - cons1, 0)             # 已被清理、再也消费不到的那段
                backlog += max(max1 - eff1, 0)         # 用**有效位点**算，不许出负
                corrected += 1 if cons1 < min1 else 0
                is_reset = cons1 < cons0
                reset_cnt += 1 if is_reset else 0
                lost += gap
                consumed += 0 if is_reset else max(eff1 - eff0 - gap, 0)
                produced += max(max1 - max0, 0)
            trusted = len(queues) - dropped
            net = consumed - produced
            if trusted == 0:
                windows = -1                           # 一组全不可信：不可估，不许给 0
            elif backlog <= 0:
                windows = 0
            elif reset_cnt > 0 or net <= 0:
                windows = -1
            else:
                windows = -(-backlog // net)           # ceil
            breach = 1 if windows == -1 or windows > SLA_WINDOWS else 0
            out.append([node, topic, len(queues), dropped, backlog, corrected, reset_cnt,
                        lost, consumed, produced, windows, breach])
        return out

    SCHEMA = {
        'offset_snap': table_spec(
            'queue_id',
            ['snapshot_seq', 'node', 'topic', 'queue_id', 'min_off', 'max_off', 'cons_off',
             'ts_sec'],
            ['snapshot_seq INT NOT NULL', 'node INT NOT NULL', 'topic VARCHAR(16) NOT NULL',
             'queue_id INT NOT NULL', 'min_off BIGINT NOT NULL', 'max_off BIGINT NOT NULL',
             'cons_off BIGINT NOT NULL', 'ts_sec INT NOT NULL',
             'PRIMARY KEY (snapshot_seq, node, topic, queue_id)']),
    }
    SEED = {'offset_snap': [list(r) for r in SNAP]}

    cases = [
        mut_case('基线：三组队列，一组已追平、一组纠正过位点、一组重置过位点',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='(1,cart) 两个队列都追平 ⇒ backlog=0、windows=0、breach=0；'
                      '(1,order) 队列 2 的 t1 位点 2400 低于 min 2600 ⇒ '
                      'corrected=1、lost_gap=200、堆积按有效位点算是 400（不是 600）；'
                      '(2,order) 队列 1 位点从 3800 退到 1500 ⇒ reset=1、该组 windows=-1'),
        mut_case('边界：把那条 min_off 降回 2000（其实没过期）⇒ 纠正归零，堆积反而多 200',
                 SCHEMA, SEED,
                 [('setpk', 'offset_snap',
                   {'snapshot_seq': 2, 'node': 1, 'topic': 'order', 'queue_id': 2},
                   {'min_off': 2000})], COLS, evaluate,
                 note='位点没被纠正 ⇒ lost_gap=0、corrected=0，有效位点变成客户端上报的 2400，'
                      '所以 (1,order) 的堆积从 800 涨到 1000、净消耗仍是 200 ⇒ '
                      'windows 从 4 变 5。**"少算丢失"会让堆积与追赶时间一起被低估**'),
        mut_case('边界：把重置那条改成正常推进到 3900 ⇒ reset 归零，但净消耗仍是负的、仍不可估',
                 SCHEMA, SEED,
                 [('setpk', 'offset_snap',
                   {'snapshot_seq': 2, 'node': 2, 'topic': 'order', 'queue_id': 1},
                   {'cons_off': 3900})], COLS, evaluate,
                 note='(2,order)：reset=0、堆积 600、净消耗 200 − 600 = −400 ⇒ windows 仍是 −1；'
                      '这条说明"重置过"与"追不上"是**两个独立的否决理由**，'
                      '把它们合成一个布尔就会漏掉后者'),
        mut_case('非法形态：把一条位点写到最大位点之后 ⇒ 整条剔除，(1,order) 从 4 个窗口变成不可估',
                 SCHEMA, SEED,
                 [('setpk', 'offset_snap',
                   {'snapshot_seq': 2, 'node': 1, 'topic': 'order', 'queue_id': 3},
                   {'cons_off': 999})], COLS, evaluate,
                 note='队列 3 的 t1 位点 999 > max_off 900 ⇒ 这行快照不可信：'
                      'dropped_queues=1，它不许被算成"堆积 0 的正常队列"。'
                      '剔掉它之后 (1,order) 的净消耗从 1700 掉到 1100 < 生产 1500 ⇒ windows=-1'),
        mut_case('退化：一组里两条快照全都不可信 ⇒ 该组仍出行，但窗口是 -1 而不是 0',
                 SCHEMA, SEED,
                 [('setpk', 'offset_snap',
                   {'snapshot_seq': 2, 'node': 1, 'topic': 'cart', 'queue_id': 1},
                   {'cons_off': 999}),
                  ('setpk', 'offset_snap',
                   {'snapshot_seq': 2, 'node': 1, 'topic': 'cart', 'queue_id': 2},
                   {'cons_off': 999})], COLS, evaluate,
                 note='queues=2、dropped=2、其余全 0，windows=-1、breach=1 —— '
                      '"一个可信队列都没有"与"全都追平了"在数字上都可能是 0，'
                      '只有窗口这一列能分开它们'),
        mut_case('空结果：删掉第二个快照 ⇒ 没有可比较的时点，一行都不许出',
                 SCHEMA, SEED,
                 [('delcol', 'offset_snap', 'snapshot_seq', 2)], COLS, evaluate,
                 note='只剩 t0 时"堆积"根本没有定义；把 t0 的位点直接当成"当前堆积"'
                      '会给出一个看起来能看的数字，而它其实是三十秒前的'),
    ]

    reference = """WITH t0 AS (
  SELECT node, topic, queue_id, min_off, max_off, cons_off FROM offset_snap WHERE snapshot_seq = 1
),
t1 AS (
  SELECT node, topic, queue_id, min_off, max_off, cons_off FROM offset_snap WHERE snapshot_seq = 2
),
j AS (
  SELECT b.node, b.topic, b.queue_id,
         b.min_off AS min1, b.max_off AS max1, b.cons_off AS cons1,
         a.min_off AS min0, a.max_off AS max0, a.cons_off AS cons0,
         CASE WHEN a.queue_id IS NULL OR b.cons_off > b.max_off OR b.min_off > b.max_off
              THEN 1 ELSE 0 END AS dropped
  FROM t1 b LEFT JOIN t0 a
    ON a.node = b.node AND a.topic = b.topic AND a.queue_id = b.queue_id
),
per AS (
  SELECT node, topic, dropped,
         IF(dropped = 1, 0, GREATEST(max1 - GREATEST(cons1, min1), 0))                        AS backlog,
         IF(dropped = 1, 0, IF(cons1 < min1, 1, 0))                                           AS corrected,
         IF(dropped = 1, 0, IF(cons1 < cons0, 1, 0))                                          AS reset,
         IF(dropped = 1, 0, GREATEST(min1 - cons1, 0))                                        AS lost_gap,
         IF(dropped = 1, 0, IF(cons1 < cons0, 0,
             GREATEST(GREATEST(cons1, min1) - GREATEST(cons0, min0)
                      - GREATEST(min1 - cons1, 0), 0)))                                       AS consumed,
         IF(dropped = 1, 0, GREATEST(max1 - max0, 0))                                         AS produced
  FROM j
)
SELECT node, topic,
       COUNT(*)                                    AS queues,
       SUM(dropped)                                AS dropped_queues,
       SUM(backlog)                                AS backlog,
       SUM(corrected)                              AS corrected_queues,
       SUM(reset)                                  AS reset_queues,
       SUM(lost_gap)                               AS lost_gap,
       SUM(consumed)                               AS consumed_win,
       SUM(produced)                               AS produced_win,
       CASE WHEN SUM(1 - dropped) = 0 THEN -1
            WHEN SUM(backlog) <= 0 THEN 0
            WHEN SUM(reset) > 0 OR SUM(consumed) - SUM(produced) <= 0 THEN -1
            ELSE CEIL(SUM(backlog) / (SUM(consumed) - SUM(produced))) END AS windows_to_clear,
       CASE WHEN SUM(1 - dropped) = 0 THEN 1
            WHEN SUM(backlog) <= 0 THEN 0
            WHEN SUM(reset) > 0 OR SUM(consumed) - SUM(produced) <= 0 THEN 1
            WHEN CEIL(SUM(backlog) / (SUM(consumed) - SUM(produced))) > 2 THEN 1
            ELSE 0 END AS sla_breach
FROM per
GROUP BY node, topic
ORDER BY node, topic"""

    naive = """SELECT b.node, b.topic,
       COUNT(*)                                              AS queues,
       0                                                     AS dropped_queues,
       SUM(b.max_off - b.cons_off)                           AS backlog,
       0                                                     AS corrected_queues,
       0                                                     AS reset_queues,
       0                                                     AS lost_gap,
       SUM(b.cons_off - a.cons_off)                          AS consumed_win,
       SUM(b.max_off - a.max_off)                            AS produced_win,
       CASE WHEN SUM(b.cons_off - a.cons_off) - SUM(b.max_off - a.max_off) <= 0 THEN 0
            ELSE FLOOR(SUM(b.max_off - b.cons_off)
                       / (SUM(b.cons_off - a.cons_off) - SUM(b.max_off - a.max_off))) END
                                                            AS windows_to_clear,
       0                                                     AS sla_breach
FROM offset_snap b JOIN offset_snap a
  ON a.snapshot_seq = 1 AND b.snapshot_seq = 2
 AND a.node = b.node AND a.topic = b.topic AND a.queue_id = b.queue_id
GROUP BY b.node, b.topic
ORDER BY b.node, b.topic"""

    statement = """## 背景

Apache RocketMQ 5.0《消费进度管理》给了三条最容易被写错的事实【源 S6】：

> 队列的堆积量 = **`MaxOffset − ConsumerOffset`**；
> 有效消费位点必须满足 `ConsumerOffset >= MinOffset`，
> "**若历史位点已过期被删除，服务端会将消费位点强制纠正到合法的消息位点**"；
> "消费位点由服务端存储……和任何消费者无关，因此支持跨消费者恢复消费进度"。

《消息存储和过期清理机制》补了另一半【源 S7】：清理**以存储时长为依据**、
"**无论消息是否被消费**"、并且"**按存储节点粒度**而非 topic/queue 管理"。
《发送重试和流控》再补一条【源 S2】：堆积超阈值会触发服务端**反向流控**
（`reply-code 530 TOO_MANY_REQUESTS` + 客户端指数退避）。

把这三条合起来，"堆积"就不是一个数，而是**三种不同的数**：
还能追回来的、已经被清掉的、以及位点被重置所以根本说不清的。
素材 §4 考点 6 的出题建议正是"给 offset 快照表算每组堆积、追赶速率、预计清空时间与
SLA 违约标记"，本题把它做成一张两个时点的快照表。

## 表

```
offset_snap(snapshot_seq INT, node INT, topic VARCHAR(16), queue_id INT,
            min_off BIGINT, max_off BIGINT, cons_off BIGINT, ts_sec INT,
            PRIMARY KEY (snapshot_seq, node, topic, queue_id))
   -- snapshot_seq = 1 是上一个采集周期（t0），= 2 是当前周期（t1）
   -- node 就是"存储节点粒度"：清理时长按它算，所以分组必须带上它
```

## 任务

只交**一条 SELECT**（可用 `WITH`），按 `(node, topic)` 分组输出**一行一组**，
列固定为 12 列：

`node, topic, queues, dropped_queues, backlog, corrected_queues, reset_queues, lost_gap,
consumed_win, produced_win, windows_to_clear, sla_breach`

按 `node` 升序、再按 `topic` 升序。

## 判分契约（前三条逐字来自官方描述，其余是本题设定）

| 列 | 定义 |
| --- | --- |
| `queues` | 该组在 **t1** 出现的队列数（**含**下面被剔除的） |
| `dropped_queues` | 不可信队列数：只在 t1 出现（t0 没有这条队列）**或** `cons_off > max_off` **或** `min_off > max_off` |
| `backlog` | 可信队列的 `Σ GREATEST(max_off − GREATEST(cons_off, min_off), 0)`（t1）—— **用有效位点**，不许出负 |
| `corrected_queues` | t1 里 `cons_off < min_off` 的可信队列数（位点已被服务端强制纠正过的现场） |
| `reset_queues` | t1 里 `cons_off < cons0` 的可信队列数（位点回退 = 重置过，官方三场景里的"业务回溯纠正处理"） |
| `lost_gap` | `Σ GREATEST(min1 − cons1, 0)`：这段消息**已经没了**，重置位点也救不回来 |
| `consumed_win` | `Σ GREATEST(effective1 − effective0 − lost_gap, 0)`，位点回退的队列按 **0** 计 |
| `produced_win` | `Σ GREATEST(max1 − max0, 0)` |
| `windows_to_clear` | 见下面三条 |
| `sla_breach` | `windows_to_clear = −1` 或 `> 2` ⇒ 1，否则 0（**2 是本题设定的 SLA 窗口数**） |

`windows_to_clear` 的三条（顺序就是判据顺序）：

1. 该组**没有任何可信队列** ⇒ `-1`（不可估。给 0 等于宣布"已经追平"）；
2. `backlog = 0` ⇒ `0`；
3. 否则若 `reset_queues > 0` **或** `consumed_win − produced_win <= 0` ⇒ `-1`；
   再否则 `CEIL(backlog / (consumed_win − produced_win))` —— **向上取整**，
   因为"3.2 个窗口清空"在业务上就是"第 4 个窗口才干净"。

**不许输出负数**：任何一列都不行。堆积算出负数说明你在用被纠正过、或被重置过的位点。

只允许一条 `SELECT`。

## 说明

素材 §7 第 1 条明确"没有任何官方文档给出交易线上的实测数字"，
所以题面里**不出现** TPS、消息条数上限、真实 SLA 时长；
`2` 这个窗口数与"两个快照相隔 30 秒"都只是本题设定。
"""

    return base(
        'sql', 'principal',
        '堆积不是"最大位点减消费位点"：强制纠正、位点重置与已被清理的三段要分开报，追赶窗口向上取整',
        statement, 'mysql',
        ['peak-shaving-backlog', 'consumer-offset-semantics', 'silent-message-loss',
         'offset-reset', 'catch-up-estimate', 'modern:messaging'],
        src('服务端研发（消息与削峰治理方向） 技术专家',
            TXN + '#4 考点 6（削峰填谷与堆积治理：堆积 = MaxOffset − ConsumerOffset、'
            '"若历史位点已过期被删除，服务端会将消费位点强制纠正到合法的消息位点"、'
            '位点由服务端存储支持跨消费者恢复、重置位点三场景与"只能重置对消费者可见的消息"'
            '【源 S6】；清理以存储时长为依据、无论是否消费都按存储节点粒度管理【源 S7】；'
            '堆积超阈值触发服务端反向流控 530 + 指数退避【源 S2】。'
            '素材该考点的出题建议正是"给 offset 快照表算每组堆积、追赶速率、预计清空时间与'
            'SLA 违约标记"。三段口径的拆分与"向上取整 + 不可估用 −1"是【推】，题面已写成契约；'
            '素材 §7 第 1 条禁止的实测量级数字题面一个都没用）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=34,
        answer="""## 参考答案

`t0` / `t1` 两个 CTE + `LEFT JOIN` 定出"可信队列"，`per` 逐队列算六个数，
最后一层 `GROUP BY node, topic` 汇总并按三条顺序判 `windows_to_clear`。

**基线十二列**（三行）：

| node | topic | queues | dropped | backlog | corrected | reset | lost | consumed | produced | windows | breach |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | cart | 2 | 0 | 0 | 0 | 0 | 0 | 860 | 490 | 0 | 0 |
| 1 | order | 3 | 0 | 800 | 1 | 0 | 200 | 1700 | 1500 | 4 | 1 |
| 2 | order | 2 | 0 | 3000 | 0 | 1 | 0 | 100 | 600 | −1 | 1 |

**(1,order) 的 800 才是这道题的核心一格**：队列 2 的 t1 位点是 2400、`min_off` 已经涨到 2600，
按官方那句"服务端会将消费位点强制纠正到合法的消息位点"，
**有效位点是 2600**，所以堆积 = 3000 − 2600 = 400；加上队列 1 的 400 ⇒ 800。
朴素解用 `max − cons` 会给出 600 + 400 = **1000**，
即把已经被按存储时长清掉的 200 条算成"还能消费的堆积"。
症状不是数字偏一点，而是**追赶计划永远做不完**：那 200 条永远不会再投递，
但报表每天都在等它。`lost_gap = 200` 这一列就是那 200 条的墓碑。

**用例「把那条 min_off 降回 2000」**是同一机制的反向对照：位点没被纠正 ⇒ `corrected` 与
`lost_gap` 归零，有效位点退回客户端上报的 2400 ⇒ 堆积 800 → **1000**、
`windows` 4 → **5**。同一条 SQL 两种数据都判得对，才算真的理解"有效位点"而不是"背了个公式"。

**重置与追不上是两个独立的否决理由**（用例「把重置那条改成正常推进到 3900」）：
(2,order) 的 `reset` 从 1 变 0，但队列 1 只前进 100 而生产了 500 ⇒
净消耗 200 − 600 = −400 ⇒ `windows` 仍是 −1。
合成一个布尔就会把"净消耗是负的"这类**最常见的洪峰现场**报成"可估"。
基线里它被 `reset` 先挡住，所以两条必须各测一次。

**用例「把一条位点写到最大位点之后」**考 `dropped_queues`：
队列 3 的 t1 位点 999 > `max_off` 900，这行快照本身不可信 ⇒ 整条剔除。
剔除之后 (1,order) 的 `consumed` 从 1700 掉到 1100，小于 `produced` 1500 ⇒
`windows` 从 4 变成 −1（`dropped_queues=1`）。
**不能把它算成"堆积 0 的正常队列"** —— 那是把一个数据事故读成一条好消息。

**用例「一组里两条快照全都不可信」**是全题最容易写错的一格：
(1,cart) 变成 `queues=2、dropped=2`，其余六列全 0，而 `windows` 必须是 **−1**、`breach=1`。
"一个可信队列都没有"和"全都追平了"在堆积上都是 0，
**只有窗口这一列能把它们分开** —— 判据顺序（先查可信队列数为 0，再查 backlog=0）不能反。

**朴素解挂六列**：`backlog` 用 `max − cons`（1000 而不是 800）、
`corrected/reset/lost_gap` 三列直接写 0、`consumed` 用 `cons1 − cons0`
（重置那条给出 −2300 这样的负数）、`windows` 用 `FLOOR`（3.2 → 3，提前一个窗口宣布追平）且
净消耗 ≤ 0 时给 0 而不是 −1、`sla_breach` 写死 0。

**工程延伸（面试追问点）**

1. 为什么按 `node` 分组？（官方把清理时长定义在**存储节点粒度**而非 topic/queue【源 S7】：
   同一 topic 的两个队列可能挂在不同节点上，过期节奏不同。跨节点平均出来的"堆积"没有意义。）
2. 位点被纠正怎么变成可监控的指标？（把 `lost_gap > 0` 当成一条**质量规则**而不是运维事件 ——
   素材 §3 把它列在"回溯随时能做"的反面：不是没消费，是没了。）
3. 为什么净消耗 ≤ 0 时要给 −1 而不是"永远追不上"？（快照只有两个时点，
   负净消耗也可能是这一周期正好赶上洪峰。`−1` 的语义是"不可估"，逼着人去看第三个周期。）""",
    )


# ============================ B4 MaxCompute 账单口径：压缩后计费 + 失败不计费 + 重跑重复计费
@draft('bd-ab-maxcompute-bill')
def q_maxcompute_bill():
    """素材 §4 考点 14（成本与容量口径）的 pyspark 等价重写。

    官方给的是三条**能算成整数**的规则【源 D20】：
      * `SQL 作业当日总费用 = 计算输入数据量 × SQL 复杂度 × 单价`（公共云 0.3 元/GB、金融云 0.57 元/GB）
      * `SQL 作业的输入量是以压缩后的量计费`
      * `执行失败的 SQL 作业不计费`
    加上"PyODPS 底层执行 SQL 因此按 SQL 计量"。
    【推】的是"同一作业当天成功执行 N 次就计 N 次"这一条（官方只说失败不计费，
    而重复计费发生在**成功**的那几次上）—— 题面写成契约并标【推】。
    """
    VIEW = 'billable_jobs'
    SCHEMA = ('job_id INT, team STRING, cloud STRING, engine STRING, scan_raw_gb BIGINT, '
              'scan_comp_gb BIGINT, complexity INT, runs INT, failed_runs INT')
    PRICE = {'public': 30, 'finance': 57}     # 分 / GB（0.3 元与 0.57 元）

    def row(job_id, team, cloud, engine, raw, comp, complexity, runs, failed):
        return {'job_id': job_id, 'team': team, 'cloud': cloud, 'engine': engine,
                'scan_raw_gb': raw, 'scan_comp_gb': comp, 'complexity': complexity,
                'runs': runs, 'failed_runs': failed}

    BASE = [
        row(1, 'ads', 'public', 'SQL', 900, 300, 2, 3, 1),        # 3 次里失败 1 次 ⇒ 计 2 次
        row(2, 'ads', 'finance', 'PYODPS', 200, 100, 1, 1, 0),    # PyODPS 按 SQL 计量
        row(3, 'ads', 'public', 'SQL', 400, None, 1, 2, 0),       # 压缩量没回填
        row(4, 'dw', 'public', 'SQL', 1000, 250, 4, 1, 1),        # 唯一一次执行就失败 ⇒ 不计费
        row(5, 'dw', 'finance', 'SQL', 600, 200, 3, 4, 1),        # 成功 3 次 ⇒ 重复计费 2 次
    ]

    def bill(rows):
        per_team = {}
        for r in rows:
            t = per_team.setdefault(r['team'], dict(jobs=0, unknown=0, calc=0, cost=0,
                                                    raw=0, pyodps=0, dup=0))
            t['jobs'] += 1
            ok = 0 if r['failed_runs'] > r['runs'] else r['runs'] - r['failed_runs']
            unknown = (r['scan_comp_gb'] is None or r['failed_runs'] > r['runs']
                       or r['cloud'] not in PRICE)
            raw_calc = r['scan_raw_gb'] * r['complexity'] * ok
            comp_calc = 0 if r['scan_comp_gb'] is None else r['scan_comp_gb'] * r['complexity'] * ok
            t['raw'] += raw_calc
            if unknown:
                t['unknown'] += 1
                continue
            price = PRICE[r['cloud']]
            t['calc'] += comp_calc
            t['cost'] += comp_calc * price
            if r['engine'] == 'PYODPS':
                t['pyodps'] += comp_calc
            if ok > 1:
                t['dup'] += r['scan_comp_gb'] * r['complexity'] * (ok - 1) * price
        return [{'team': k, 'jobs': v['jobs'], 'unknown_rows': v['unknown'],
                 'calc_gb': v['calc'], 'cost_fen': v['cost'], 'raw_calc_gb': v['raw'],
                 'pyodps_calc_gb': v['pyodps'], 'dup_cost_fen': v['dup']}
                for k, v in sorted(per_team.items())]

    def patched(pairs):
        rows = [dict(r) for r in BASE]
        for job_id, changes in pairs.items():
            for r in rows:
                if r['job_id'] == job_id:
                    r.update(changes)
        return rows

    cases = [
        pycase('基线：两个团队八列，ads 一分钱里同时有公共云与金融云两种单价',
               SCHEMA, VIEW, BASE, bill,
               note='ads 的 `cost_fen` = 1200 × 30 + 100 × 57 = 41700（**逐行按各自云的单价**）；'
                    'job 3 的压缩量没回填 ⇒ 只进 `unknown_rows`，一行钱都不许算，'
                    '但它的 `raw_calc_gb` 800 仍然要出（"按未压缩量会报成多少"是它的对照）；'
                    'job 4 唯一一次执行失败 ⇒ 整行不计费'),
        pycase('边界：把没回填的压缩量补成 80 ⇒ unknown 归零、calc 多 160、raw_calc 一动不动',
               SCHEMA, VIEW, patched({3: {'scan_comp_gb': 80}}), bill,
               note='补数改变的是"这一行算不算得出钱"：ads 的 unknown_rows 1 → 0、'
                    'calc_gb 1300 → 1460（多 80 × 1 × 2 = 160）、cost_fen 41700 → 46500'
                    '（多 160 × 30 = 4800）、dup_cost_fen 18000 → 20400'
                    '（这一行成功跑过 2 次 ⇒ 第二次也算进重复计费），'
                    '而 raw_calc_gb 仍是 4600 —— 它压根没用压缩量'),
        pycase('边界：把失败那次重跑改成成功 ⇒ dw 的 calc 从 1800 跳到 2800，dup 一列没涨',
               SCHEMA, VIEW, patched({4: {'failed_runs': 0}}), bill,
               note='job 4 变成 ok=1 ⇒ 新计 250 × 4 = 1000 GB ⇒ dw 的 calc_gb 1000 + 1800 = 2800、'
                    'cost_fen 30000 + 102600 = 132600。`dup_cost_fen` 仍是 68400：'
                    '它只统计**同一作业成功执行超过一次**的部分，job 4 只成功一次'),
        pycase('非法形态：把台账写成 failed_runs 大于 runs ⇒ 该行计不进钱，但必须留在 unknown_rows',
               SCHEMA, VIEW, patched({5: {'failed_runs': 9}}), bill,
               note='ok 次数的定义是 `runs − failed_runs`，负数**不许**当"跑了负数次"：'
                    '该行整条不进 calc/cost，只进 `unknown_rows=1`。'
                    '此时 dw 两列全 0 —— 看起来像"这个团队没花钱"，'
                    '而 `unknown_rows` 是唯一能把它和"真的没花钱"分开的列'),
        pycase('退化：所有作业的全部执行都失败 ⇒ 三列金额为 0，但 jobs 与两行团队还在',
               SCHEMA, VIEW, patched({1: {'failed_runs': 3}, 2: {'failed_runs': 1},
                                      3: {'failed_runs': 2}, 5: {'failed_runs': 4}}), bill,
               note='"失败不计费"是官方的三条硬规则里唯一一条会让账单变小的，'
                    '但它**不影响**"跑了多少作业"：`jobs` 仍是 3 与 2。'
                    '把作业数也一并清零的实现，等于把一次集体故障读成"没人用过这个 project"'),
        pycase('退化：一个作业都没有 ⇒ 空结果，不许造一行全 0 的团队',
               SCHEMA, VIEW, [], bill),
    ]

    reference = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('billable_jobs')
    # 官方三条：压缩后计费、失败不计费、单价按云种；PyODPS 按 SQL 计量 => 同一条公式
    bad_ledger = F.col('failed_runs') > F.col('runs')
    ok_runs = F.when(bad_ledger, F.lit(0)).otherwise(F.col('runs') - F.col('failed_runs'))
    price = (F.when(F.col('cloud') == 'public', F.lit(30))
             .when(F.col('cloud') == 'finance', F.lit(57))
             .otherwise(F.lit(0)))
    known = (~F.col('cloud').isin('public', 'finance')) | bad_ledger | F.col('scan_comp_gb').isNull()
    unknown = known.cast('int')
    comp_calc = (F.coalesce(F.col('scan_comp_gb'), F.lit(0))
                 * F.col('complexity') * ok_runs)
    billed = F.when(unknown == 1, F.lit(0)).otherwise(comp_calc)
    raw_calc = F.col('scan_raw_gb') * F.col('complexity') * ok_runs
    dup = F.when((unknown == 0) & (ok_runs > 1),
                 F.col('scan_comp_gb') * F.col('complexity') * (ok_runs - 1) * price) \\
             .otherwise(F.lit(0))
    return (r.groupBy('team')
            .agg(F.count(F.lit(1)).alias('jobs'),
                 F.sum(unknown).alias('unknown_rows'),
                 F.sum(billed).alias('calc_gb'),
                 F.sum(billed * price).alias('cost_fen'),
                 F.sum(raw_calc).alias('raw_calc_gb'),
                 F.sum(F.when(F.col('engine') == 'PYODPS', billed).otherwise(F.lit(0)))
                 .alias('pyodps_calc_gb'),
                 F.sum(dup).alias('dup_cost_fen'))
            .orderBy('team'))
"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('billable_jobs')
    # 1) 扫描了多少就算多少（用未压缩量）  2) 跑了多少次就算多少次（不管成功失败）
    # 3) 单价一律按公共云 0.3 元/GB       4) 压缩量没回填就退回未压缩量
    # 5) 只认 engine = 'SQL'，把"重跑成功的那几次"当成 0 重复计费
    gb = (F.coalesce(F.col('scan_comp_gb'), F.col('scan_raw_gb'))
          * F.col('complexity') * F.col('runs'))
    billed = F.when(F.col('engine') == 'SQL', gb).otherwise(F.lit(0))
    return (r.groupBy('team')
            .agg(F.count(F.lit(1)).alias('jobs'),
                 F.lit(0).alias('unknown_rows'),
                 F.sum(billed).alias('calc_gb'),
                 F.sum(billed * 30).alias('cost_fen'),
                 F.sum(billed).alias('raw_calc_gb'),
                 F.lit(0).alias('pyodps_calc_gb'),
                 F.lit(0).alias('dup_cost_fen'))
            .orderBy('team'))
"""

    statement = """## 背景

MaxCompute《计算费用（按量付费）》给的三条是能直接算成数字的硬规则【源 D20】：

> "SQL 作业当日总费用 = **计算输入数据量 × SQL 复杂度 × 单价**"
> （按量标准版 **0.3 元/GB**、金融云 **0.57 元/GB"），
> "**SQL 作业的输入量是以压缩后的量计费**"，
> "**执行失败的 SQL 作业不计费**"，
> 并且"PyODPS 底层执行的是 SQL，因此按 SQL 计费"。

素材 §2 追问 18 把这三条写成一道现场题："这个月的计算费用为什么涨了 3 倍？"
标准答案要能点名四个来源：**无分区裁剪的 ad-hoc、失败重跑、小文件、无列裁剪**，
并且要能区分"失败重跑不重复计费，但会重复计费成功执行的那几次"【源 D20】＋【推】。

## 输入

视图 `billable_jobs`（一个采集周期内的作业台账），列与类型：

```
job_id INT, team STRING, cloud STRING, engine STRING,
scan_raw_gb BIGINT, scan_comp_gb BIGINT, complexity INT, runs INT, failed_runs INT
```

- `cloud` ∈ `'public'`（30 分/GB）/ `'finance'`（57 分/GB）；
- `engine` ∈ `'SQL'` / `'PYODPS'` —— 两者**用同一条公式**（官方：PyODPS 按 SQL 计量）；
- `scan_raw_gb` / `scan_comp_gb`：未压缩 / 压缩后的扫描量（GB，本题直接用整数 GB 避免单位歧义）；
  `scan_comp_gb` 可能为 `null`（采集任务没回填）；
- `complexity`：SQL 复杂度系数（整数，**由入参给定**，素材没给官方阶梯所以本题不自定义它）；
- `runs` / `failed_runs`：该作业本周期内的执行次数与其中失败的次数。

## 输出与判分契约

一行一个 `team`，列固定为
`team, jobs, unknown_rows, calc_gb, cost_fen, raw_calc_gb, pyodps_calc_gb, dup_cost_fen`，
按 `team` 升序。禁止 `collect()`。

| 列 | 定义 |
| --- | --- |
| `jobs` | 该团队的作业**行数**（不计金额，也不管是否计费） |
| `unknown_rows` | **算不出钱**的行数：`scan_comp_gb IS NULL`，或 `failed_runs > runs`（台账不成立），或 `cloud` 不在两种单价之内 |
| `calc_gb` | 可计费行的 `Σ scan_comp_gb × complexity × ok_runs` —— **压缩后**的量 |
| `cost_fen` | 可计费行的 `Σ scan_comp_gb × complexity × ok_runs × 单价`，**逐行按该行自己的云的单价** |
| `raw_calc_gb` | 所有行的 `Σ scan_raw_gb × complexity × ok_runs`（"若按未压缩量计费会报成多少"，含不可计费行） |
| `pyodps_calc_gb` | `calc_gb` 中来自 `engine = 'PYODPS'` 的那部分 |
| `dup_cost_fen` | 可计费且 `ok_runs > 1` 的行：`Σ scan_comp_gb × complexity × (ok_runs − 1) × 单价` |

`ok_runs` 的定义：`failed_runs > runs` 时为 `0`，否则 `runs − failed_runs`
（**执行失败的作业不计费** ⇒ 失败的次数一次都不进乘数；
台账不成立的整行按 `unknown_rows` 处理，不许把负的 `ok_runs` 乘进去）。

**"重跑"的账要分两头看**：失败的那几次不产生费用，
而**成功的每一次都单独计费** —— 所以 `dup_cost_fen` 只统计 `ok_runs − 1` 那部分。

## 说明

机制取自阿里云 MaxCompute 计费文档【源 D20】，
**用一次 Spark 批处理等价重写是【推】**（素材 §7 第 6 条：阿里官方没有给出 Spark 侧的规范实现），
所以列名、`unknown_rows` 的三种成因、"逐行取单价"都是**本题契约**，不是产品接口。
本题刻意不出现任何真实金额、真实用量或真实涨价倍数。
"""

    return base(
        'big-data', 'senior',
        'MaxCompute 账单口径：压缩后计费、失败不计费、PyODPS 同一条公式，重跑的账要分两头',
        statement, 'pyspark',
        ['billing-formula', 'compressed-input', 'failure-not-billed', 'pyodps-as-sql',
         'duplicate-run-attribution', 'modern:cost-governance'],
        src('数据研发（成本与容量治理方向） 高级工程师',
            DATA + '#4 考点 14（成本与容量口径：SQL 作业当日总费用 = 计算输入数据量 × SQL 复杂度 × 单价、'
            '公共云 0.3 元/GB 与金融云 0.57 元/GB、"SQL 作业的输入量是以压缩后的量计费"、'
            '"执行失败的 SQL 作业不计费"、"PyODPS 底层执行 SQL 因此按 SQL 计费"【源 D20】；'
            '§2 追问 18 的四个涨价来源（无分区裁剪、失败重跑、小文件、无列裁剪）。'
            '素材该考点的出题建议正是"给作业元数据表算日账单并按团队归因，'
            '要求区分压缩前后与失败不计费两条规则"。"成功执行的每一次单独计费"与 '
            'unknown_rows 的三种成因是【推】，题面已写成契约；用 Spark 等价重写属 §7 第 6 条标注的【推】）'),
        language='python',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer="""## 参考答案要点

一遍 `groupBy('team')` + 七个 `agg`，关键是**先把"这行能不能算钱"判出来，再乘任何东西**。

**基线八个值**（`ads`）：`jobs=3`、`unknown_rows=1`、`calc_gb=1300`、`cost_fen=41700`、
`raw_calc_gb=4600`、`pyodps_calc_gb=100`、`dup_cost_fen=18000`；
（`dw`）：`jobs=2`、`unknown_rows=0`、`calc_gb=1800`、`cost_fen=102600`、
`raw_calc_gb=5400`、`pyodps_calc_gb=0`、`dup_cost_fen=68400`。

`ads` 那行是本题最密的一格，五条规则同时生效：
- job 1：压缩后 300 GB × 复杂度 2 × 成功 2 次 = **1200** GB ⇒ 1200 × 30 = 36000 分；
  它跑过 3 次、失败 1 次 —— **失败那次不计费**，所以乘数是 2 而不是 3；
- job 2：`PYODPS` 必须与 SQL 同一条公式 ⇒ 100 × 1 × 1 = 100 GB，
  但它挂在金融云 ⇒ 单价 57 ⇒ 5700 分。**不能先求和再乘单价**：
  (1200 + 100) × 30 = 39000 是错的，正确答案 36000 + 5700 = **41700**；
- job 3：压缩量没回填 ⇒ 只进 `unknown_rows`，钱按 0，但它的
  `raw_calc_gb` 贡献 400 × 1 × 2 = 800 仍然要出。

**`raw_calc_gb − calc_gb` 就是"按未压缩量会多报多少"**：
基线上 `ads` 是 4600 − 1300 = 3300 GB、`dw` 是 5400 − 1800 = 3600 GB。
这正是素材 §3 那条"扫描量口径写错，账单就永远解释不清"的可判形态。

**用例「把没回填的压缩量补成 80」**动的是四列，而且**不动 `raw_calc_gb`**：
`ads` 的 `unknown_rows` 1 → 0、`calc_gb` 1300 → 1460（多出 80 × 1 × 2 = 160）、
`cost_fen` 41700 → 46500（多出 160 × 30 = 4800）、
`dup_cost_fen` 18000 → 20400（这一行成功跑过 2 次 ⇒ 第二次也落进重复计费），
而 `raw_calc_gb` 仍是 4600 —— 它从来没用过压缩量。
**"补数据"改变的是算不算得出钱，不是扫描了多少**。

**用例「把失败那次重跑改成成功」**是另一头：
`dw` 的 `calc_gb` 1000 + 1800 = 2800、`cost_fen` 30000 + 102600 = 132600，
但 `dup_cost_fen` 仍是 68400 —— 因为 job 4 只**成功一次**，
而重复计费的定义是"同一作业成功执行的第二次及以后"。
这一列的用途是把"降本三刀"里的**重跑**单独称出来：`dup_cost_fen` 占账单的比例
就是"我们有多少钱花在同一件事干了两遍上"。

**用例「把台账写成 failed_runs 大于 runs」**考的是负数：
`ok_runs` 若直接写成 `runs − failed_runs`，job 5 会给出 4 − 9 = **−5** 并乘进金额，
`dw` 的 `calc_gb` 变成 1800 − 3000 = −1200 这种荒谬值。
契约要求：台账不成立的行**整行不进金额**，只进 `unknown_rows` ⇒
`dw` 变成 `calc_gb=0`、`cost_fen=0`、`dup_cost_fen=0`、`unknown_rows=1`。
**"金额为 0"与"没算出来"必须能分开**，否则一次采集故障会被读成一次成功的降本。

**退化两条**：全部执行都失败 ⇒ 三列金额为 0 而 `jobs` 仍是 3 与 2
（"失败不计费"不该顺手抹掉"这批作业存在过"）；
空输入 ⇒ **空结果**，不许造一行全 0 的"团队"。

**朴素解挂六处**：用未压缩量、把失败的次数也乘进乘数、单价统一 0.3、
压缩量缺失时退回未压缩量、只认 `engine='SQL'`（于是 `pyodps_calc_gb` 恒 0）、
`dup_cost_fen` 与 `unknown_rows` 两列直接写 0。

**工程延伸（面试追问点）**

1. 为什么把账单写成"分"而不是"元"？（0.3 元/GB 与 0.57 元/GB 都是两位小数，
   账单一旦涉及汇总与阈值比较，浮点误差会在"这个月涨了 3 倍"这种结论上放大。
   真实系统里应当用定点数或整数分。）
2. `unknown_rows` 该不该进 DQC？（应当进 —— 素材考点 13 的监控分类里"数据量与逻辑规则"，
   计费元数据缺失正是"逻辑规则"：一行算不出钱比一行算错钱更危险，因为它静默。）
3. 这三条计费规则能不能合并成一条 SQL 视图给 BI 用？（能，但必须把 `dup_cost_fen`
   与 `unknown_rows` 作为**独立度量**保留 —— 合并成一个"总费用"列，
   治理动作就没有落点了：降价的三刀分别对应"减少扫描、减少成功重跑、补齐采集"。）""",
    )


# ===================== B5 Hologres TTL 的两把时钟：写入时间 vs 更新时间，与 PK 重复
@draft('bd-ab-hologres-ttl-two-clocks')
def q_hologres_ttl_two_clocks():
    """素材 §4 考点 10（生命周期与"TTL 不精确"引发的质量事故）的 spark-scala 等价重写。

    官方三条【源 D11】：
      * `time_to_live_in_seconds` "**从写入时间开始算**而不是更新时间"；
      * "TTL 并非精确时间……到期后数据会在某一段时间删除（只删数据、表还在），
        **因此可能出现 PK 重复或者查询结果不一致**"；
      * 生产上不建议用 TTL 管生命周期，"建议采用分区表"。
    【推】的是"把两套口径同时算出来并断言差集"这件事（素材该考点的出题建议），
    以及观测时刻 = 全表最大写入时刻、`ttl_days = floor(ttl_seconds / 86400)` 这些本题契约。
    """
    SCHEMA = ('pk INT, version INT, written_ms BIGINT, updated_ms BIGINT, ds INT, '
              'ttl_seconds INT')
    DAY = 86400000

    def row(pk, version, ds, updated_ds, ttl_seconds):
        """written 严格等于它所在分区的第 0 刻：这样 ds 与写入时刻互为对照。"""
        return {'pk': pk, 'version': version, 'written_ms': ds * DAY,
                'updated_ms': int(updated_ds * DAY), 'ds': ds, 'ttl_seconds': ttl_seconds}

    D3 = 3 * 86400
    D1 = 86400
    BASE = [
        row(1, 1, 100, 104, D3),      # 按写入早过期、按更新还活着 ⇒ ghost
        row(1, 2, 103, 103, D3),
        row(2, 7, 105, 105, D3),      # 唯一"新且只有一行"的对照组
        row(3, 4, 100, 100, D1),      # 三行全部按写入过期，但 ttl 只有 1 天
        row(3, 5, 101, 102, D1),
        row(3, 6, 102, 105, D1),
    ]
    NOW_DS = 105                      # 全表最大写入时刻 = 105 号分区

    def ttl(rows):
        now = max(r['written_ms'] for r in rows) if rows else 0
        now_ds = max(r['ds'] for r in rows) if rows else 0
        by_pk = {}
        for r in rows:
            by_pk.setdefault(r['pk'], []).append(r)
        out = []
        for pk in sorted(by_pk):
            rs = by_pk[pk]
            ttl_s = min(r['ttl_seconds'] for r in rs)
            ttl_ms = ttl_s * 1000
            alive_w = [r for r in rs if now - r['written_ms'] < ttl_ms]
            alive_u = [r for r in rs if now - r['updated_ms'] < ttl_ms]
            ghost = [r for r in rs if now - r['written_ms'] >= ttl_ms
                     and now - r['updated_ms'] < ttl_ms]
            rev = [r for r in rs if now - r['written_ms'] < ttl_ms
                   and now - r['updated_ms'] >= ttl_ms]
            kept = max(alive_w, key=lambda r: r['version']) if alive_w else None
            ttl_days = ttl_s // 86400
            part = 1 if kept is None or now_ds - kept['ds'] >= ttl_days else 0
            out.append({'pk': pk, 'rows_total': len(rs), 'dup_rows': len(rs) - 1,
                        'kept_version': kept['version'] if kept else 0,
                        'alive_write': len(alive_w), 'alive_update': len(alive_u),
                        'ghost_rows': len(ghost), 'rev_rows': len(rev),
                        'partition_expired': part})
        return out

    def scase(name, rows, note=None):
        case = {'name': name, 'input': {'rows': rows, 'schema': SCHEMA}, 'expected': ttl(rows)}
        if note:
            case['note'] = note
        return case

    cases = [
        scase('基线：三把尺子各自给出不同的存活数，pk 3 三行同主键且按写入全过期',
              BASE,
              note='now = 105 号分区。pk 1：两行、dup_rows=1（TTL 非精确删除留下的重复版本），'
                   '按写入只剩 1 行活、按更新 2 行都活 ⇒ ghost_rows=1，kept 是 version 2；'
                   'pk 2：单行且刚写入 ⇒ kept_version=7、dup_rows=0、partition_expired=0；'
                   'pk 3：ttl 只有 1 天 ⇒ 三行按写入全过期 ⇒ kept_version=0、'
                   '但按更新还有一行活着（version 6 的 updated 就是 105）⇒ alive_update=1、'
                   'ghost_rows=1、partition_expired=1'),
        scase('边界：age 恰好等于 ttl ⇒ 判过期（>= 而不是 >），旁边放一行 ttl 多一天的对照',
              [row(10, 1, 105, 105, D3),        # 对照组：它把 now 钉在 105 号分区
               row(11, 1, 102, 99, D3), row(12, 2, 102, 103, 4 * 86400)],
              note='now 只能来自数据，所以必须先有一行 105 号分区的对照。'
                   'pk 11：写入年龄 3 天 **等于** ttl ⇒ 过期，更新年龄 6 天也过期 ⇒ '
                   'alive 两列都 0、kept 0、partition_expired=1；'
                   'pk 12：ttl 多一天 ⇒ 写入年龄 3 < 4 存活 ⇒ kept_version=2、'
                   '分区差 105 − 102 = 3 天 < ttl_days 4 ⇒ partition_expired=0。'
                   '两条一起才钉住"等于"的方向'),
        scase('非法形态：updated 早于 written（时钟回拨/补数）⇒ 不许取较大值兜底',
              [row(21, 4, 105, 95, D3)],
              note='这一行按写入年龄 0（刚写）⇒ 存活、按更新年龄 10 天 ⇒ 已过期 ⇒ '
                   'rev_rows=1、alive_write=1、alive_update=0、kept_version=4。'
                   '谁写了 `GREATEST(written, updated)` 当 TTL 起算点，谁就会把这条**刚写进来的活数据**'
                   '判成过期 —— 症状是"数据写进去就消失"，而且只在补数那天出现'),
        scase('边界：同一主键两行 ttl 不一致 ⇒ 取最小，kept_version 会因此变小',
              [row(31, 9, 102, 103, 5 * 86400), row(31, 3, 104, 104, 2 * 86400)],
              note='本用例的 now 是全表最大写入时刻 = 104 号分区。min ttl = 2 天 ⇒ '
                   'version 9 那行写入年龄恰好 2 天 ⇒ 过期 ⇒ kept_version=3；'
                   '若按 max（5 天）两行都活 ⇒ kept_version=9。'
                   '取最小是本题契约：配置回滚留下的短 ttl 必须生效，'
                   '否则"改了 ttl 但老数据一直不掉"'),
        scase('退化：两个主键全部按写入过期 ⇒ 仍各出一行，kept_version 都是 0',
              [row(40, 1, 105, 105, D3),        # 对照组
               row(41, 1, 90, 90, D3), row(42, 2, 91, 92, D3)],
              note='"全部过期"与"表里没有这个主键"是两件事：pk 41 与 pk 42 仍各出一行，'
                   'kept_version=0、alive 两列 0、dup_rows=0、partition_expired=1，'
                   '而对照组 pk 40 全活 ⇒ 三行都出。'
                   '把前者读成"没有这个 key"，下游就再也不会去补这批数据'),
        scase('退化：一条记录都没有 ⇒ 空结果，不许造一行全 0',
              []),
    ]

    reference = """import org.apache.spark.sql.{DataFrame, Encoders}
import org.apache.spark.sql.functions.max

object Solution {
  // 字段名必须与列名逐字一致：`as[Rec]` 是按**名字**解析的，
  // 写 camelCase 会报 [UNRESOLVED_COLUMN] writtenMs cannot be resolved。
  final case class Rec(pk: Int, version: Int, written_ms: Long, updated_ms: Long,
                       ds: Int, ttl_seconds: Int)
  final case class Out(pk: Int, rows_total: Int, dup_rows: Int, kept_version: Int,
                       alive_write: Int, alive_update: Int, ghost_rows: Int,
                       rev_rows: Int, partition_expired: Int)

  def solve(df: DataFrame): DataFrame = {
    // 观测时刻 = 全表最大**写入**时刻；分区基准 = 全表最大 ds（本题契约：不读时钟）
    val head = df.agg(max("written_ms"), max("ds")).head()
    val now = if (head.isNullAt(0)) 0L else head.getLong(0)
    val nowDs = if (head.isNullAt(1)) 0 else head.getInt(1)
    val daySec = 86400
    df.select("pk", "version", "written_ms", "updated_ms", "ds", "ttl_seconds")
      .as[Rec](Encoders.product[Rec])
      .groupByKey(_.pk)(Encoders.scalaInt)
      .mapGroups { (pk, iter) =>
        val rs = iter.toList
        // 同一主键上多行 ttl 不一致时取**最小**：短的那个才是"已经生效的那条配置"
        val ttlSec = rs.map(_.ttl_seconds).min
        val ttlMs = ttlSec.toLong * 1000L
        val aliveW = rs.filter(r => now - r.written_ms < ttlMs)
        val aliveU = rs.filter(r => now - r.updated_ms < ttlMs)
        val ghost = rs.count(r => now - r.written_ms >= ttlMs && now - r.updated_ms < ttlMs)
        val rev = rs.count(r => now - r.written_ms < ttlMs && now - r.updated_ms >= ttlMs)
        val sorted = aliveW.sortBy(r => -r.version)
        val keptVersion = if (sorted.isEmpty) 0 else sorted.head.version
        val ttlDays = ttlSec / daySec
        val part = if (sorted.isEmpty) 1
                   else if (nowDs - sorted.head.ds >= ttlDays) 1 else 0
        Out(pk, rs.size, rs.size - 1, keptVersion, aliveW.size, aliveU.size, ghost, rev, part)
      }(Encoders.product[Out])
      .toDF("pk", "rows_total", "dup_rows", "kept_version", "alive_write",
            "alive_update", "ghost_rows", "rev_rows", "partition_expired")
      .orderBy("pk")
  }
}
"""

    naive = """import org.apache.spark.sql.{DataFrame, Encoders}
import org.apache.spark.sql.functions.max

object Solution {
  final case class Rec(pk: Int, version: Int, written_ms: Long, updated_ms: Long,
                       ds: Int, ttl_seconds: Int)
  final case class Out(pk: Int, rows_total: Int, dup_rows: Int, kept_version: Int,
                       alive_write: Int, alive_update: Int, ghost_rows: Int,
                       rev_rows: Int, partition_expired: Int)

  def solve(df: DataFrame): DataFrame = {
    // "更新时间才是数据的真实新鲜度"：两把尺子合成一把；
    // ttl 取最大（放宽一点总不会误删）；kept 不看存活；重复行数不报。
    val head = df.agg(max("written_ms"), max("ds")).head()
    val now = if (head.isNullAt(0)) 0L else head.getLong(0)
    df.select("pk", "version", "written_ms", "updated_ms", "ds", "ttl_seconds")
      .as[Rec](Encoders.product[Rec])
      .groupByKey(_.pk)(Encoders.scalaInt)
      .mapGroups { (pk, iter) =>
        val rs = iter.toList
        val ttlMs = rs.map(_.ttl_seconds).max.toLong * 1000L
        val alive = rs.filter(r => now - r.updated_ms < ttlMs)
        Out(pk, rs.size, 0, rs.map(_.version).max,
            alive.size, alive.size, 0, 0, 0)
      }(Encoders.product[Out])
      .toDF("pk", "rows_total", "dup_rows", "kept_version", "alive_write",
            "alive_update", "ghost_rows", "rev_rows", "partition_expired")
      .orderBy("pk")
  }
}
"""

    statement = """## 背景

Hologres《在 Hologres 中创建高性能内部表》给了三条会在生产上互相咬的话【源 D11】：

> `time_to_live_in_seconds` "**从写入时间开始算而不是更新时间**"；
> "TTL 并非精确时间，生产业务中不建议使用 TTL 来管理数据生命周期，建议采用分区表"；
> "到期后数据会在某一段时间（不是固定时间）删除（只删数据，表还在），
> **因此可能出现 PK 重复或者查询结果不一致**"。

素材 §2 追问 15 就是这条："为什么你不建议用 TTL？"；追问 8 里
"实时表和离线表数字对不上"的第三层归因也是它（TTL 非精确删除导致 PK 重复）。

## 任务

把一张主键表的"清理决策"等价重写成一次 Spark 批处理：读入若干行（同一 `pk` 可以有多行，
那正是"TTL 非精确删除"留下的重复版本），**按主键**输出这套判据。

输入 schema：`pk INT, version INT, written_ms BIGINT, updated_ms BIGINT, ds INT, ttl_seconds INT`
（`ds` 是分区序号——第几天，整数；本题不用日期函数也不用时钟）。

输出按 `pk` 升序，列固定为
`pk, rows_total, dup_rows, kept_version, alive_write, alive_update, ghost_rows, rev_rows, partition_expired`。

## 判分契约（第一条来自官方，其余是本题设定）

- **观测时刻 `now` = 全表最大的 `written_ms`**；分区基准 `now_ds` = 全表最大的 `ds`。
- **`ttl_seconds` 从写入时间起算**：一行"按写入过期" ⇔ `now − written_ms >= ttl_ms`
  （**等于就是过期**）。"按更新过期"用同一式子换成 `updated_ms`。
- 同一 `pk` 的多行 `ttl_seconds` 不一致时 ⇒ **取最小值**（本题设定：配置回滚留下的短 ttl
  必须生效，否则"改了 TTL 但老数据一直不掉"）。
- `rows_total` = 该主键的行数；`dup_rows = rows_total − 1`（PK 重复的多余行数，0 才正常）。
- `alive_write` / `alive_update` = 按两把尺子各自**存活**的行数。
- `ghost_rows` = 按写入已过期、按更新仍活着的行数（"过期数据仍被查出"那一面）。
- `rev_rows` = 按写入仍活着、按更新已过期的行数（补数/时钟回拨那一面）。
- `kept_version` = **按写入存活**的行里 `version` 最大者的 version；一行都不存活 ⇒ `0`。
- `partition_expired` = 分区表口径（官方推荐的替代方案）下这一组该不该消失：
  `ttl_days = ttl_seconds / 86400`（向下取整），
  存活行的 `ds` 满足 `now_ds − ds >= ttl_days` ⇒ 1；没有存活行 ⇒ 1。

## 说明

机制取自 Hologres 官方文档【源 D11】；**用一次 Spark 批处理等价重写是【推】**
（素材 §7 第 6 条：阿里官方没有 Spark 侧的实现），所以 `now` 的取法、`ttl_days` 的取整方向、
"两行 ttl 不一致取最小"都是**本题契约**，不是产品接口。
题面不出现任何真实表名、行数或清理耗时。
"""

    return base(
        'big-data', 'principal',
        'Hologres TTL 的两把时钟：按写入算过期、按更新算会漏，非精确删除留下的 PK 重复要单独计数',
        statement, 'spark-scala',
        ['ttl-semantics', 'write-vs-update-clock', 'pk-duplication', 'partition-pruning',
         'ghost-rows', 'modern:lakehouse'],
        src('数据研发（湖仓与服务层治理方向） 技术专家',
            DATA + '#4 考点 10（生命周期、冷热分层与"TTL 不精确"引发的质量事故：'
            '"time_to_live_in_seconds 从写入时间开始算而不是更新时间"、'
            '"TTL 并非精确时间，生产业务中不建议使用 TTL 来管理数据生命周期，建议采用分区表"、'
            '"到期后数据会在某一段时间删除（只删数据、表还在），因此可能出现 PK 重复或者查询结果不一致"'
            '【源 D11】；§2 追问 15 与追问 8 的第三层归因。素材该考点的出题建议正是'
            '"按写入时间 vs 更新时间两种口径重算保留集合，断言差集与过期数据仍被查出的两种表现"。'
            '用 Spark 批处理等价重写、now 取全表最大写入时刻、ttl 不一致取最小与 ttl_days 向下取整'
            '都是【推】，题面已写成契约）'),
        language='scala',
        cases=cases,
        runner={'entry': 'function', 'className': 'Solution', 'method': 'solve',
                'signature': 'solve(df: DataFrame): DataFrame', 'timeoutMs': 120000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案要点

一次 `groupByKey(_.pk).mapGroups`，组内**同一把尺子量两遍**：
`now − written_ms >= ttl_ms` 与 `now − updated_ms >= ttl_ms`。
`now` 只能从数据里来（全表最大写入时刻）—— 判题不许读时钟，否则参考解自己就不稳定。

**基线三行九列**（`now` 落在 105 号分区）：

| pk | rows_total | dup_rows | kept_version | alive_write | alive_update | ghost | rev | partition_expired |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 1 | 2 | 1 | 2 | 1 | 0 | 0 |
| 2 | 1 | 0 | 7 | 1 | 1 | 0 | 0 | 0 |
| 3 | 3 | 2 | 0 | 0 | 1 | 1 | 0 | 1 |

**pk 3 是"TTL 只删数据不删表"的现场**：`ttl = 1 天`，三行的写入年龄是 5 / 4 / 3 天 ⇒
按写入全部过期 ⇒ `kept_version = 0`；而 version 6 那行的 `updated_ms` 恰好是 105 号分区
⇒ 按更新它还活着 ⇒ `alive_update = 1` 而 `alive_write = 0`。
**两个数不相等本身就是结论**：`ghost_rows = 1` 说明"这张表里还有一行，
用更新时间口径看它是新数据、用 TTL 口径看它早该没了" ——
素材 §1.6 那句"只删数据、表还在，因此可能出现 PK 重复或者查询结果不一致"就是这个形状。
`dup_rows = 2` 则是三行同主键的代价：**主键重复的行数是"清理没跑完"的长度计量**。

**分区那一列不能省**（官方给的替代方案是分区表）：
pk 1 的存活行落在 103 号分区，`now_ds − ds = 2`，`ttl_days = 259200 / 86400 = 3` ⇒
`2 >= 3` 不成立 ⇒ `partition_expired = 0`；
pk 3 没有存活行 ⇒ 按契约直接 1。
**同一组数据在 TTL 口径下"已过期"、在分区口径下"还在保留期"是可能的**，
这正是"改清理方式要两套并行跑一段"的量化理由。

**用例「age 恰好等于 ttl」**钉判据方向：
pk 11 写入年龄 3 天 **等于** ttl ⇒ `alive_write = 0`、`kept_version = 0`；
旁边 pk 12 的 ttl 多一天 ⇒ 3 < 4 ⇒ 存活、`kept_version = 2`、分区差 3 天 < `ttl_days` 4 ⇒ 0。
写成 `>` 就是把每条数据的保留期无声地延长一个周期。

**用例「updated 早于 written」**是唯一一条 `rev_rows = 1` 的：
那一行按写入年龄 0（刚补进来的数据）、按更新年龄 10 天 ⇒
`alive_write = 1` 而 `alive_update = 0`，`kept_version = 4` 仍然存活。
**谁写了 `GREATEST(written_ms, updated_ms)` 去"兜底"，这条就会被判成过期** ——
症状是"补进来的数据第二天就没了"，而它只在补数那天出现，最难复现。

**用例「同一主键两行 ttl 不一致」**取最小（2 天）⇒ version 9 那行过期 ⇒ `kept_version = 3`；
取最大（5 天）⇒ 两行都活 ⇒ `kept_version = 9`。
**两行 ttl 不一致是配置变更没跑完的痕迹，不是需要被"宽容处理"的噪音**：
`dup_rows = 1` 与 `kept_version` 一起看，才知道这次变更影响到了哪一行。

**退化两条**：两个主键全部过期时**仍要各出一行**（`kept_version = 0`），
空输入 ⇒ **空结果**；把前者读成"这个 key 不存在"，下游就再也不会去补这批数据。

**朴素解挂六列**：两把尺子合成一把（拿更新时间当唯一依据）⇒ `alive_write` 与 `alive_update`
永远相等、`ghost_rows`/`rev_rows` 恒 0；ttl 取 max ⇒ `kept_version` 偏大；
`dup_rows` 写 0（看不见 PK 重复）；`kept_version` 不看存活直接取最大 version；
`partition_expired` 写 0（等于宣布"分区表方案没有额外信息"）。

**工程延伸（面试追问点）**

1. 为什么官方不建议用 TTL 管生命周期？（删除时机不精确 ⇒ 同一秒的两次查询可以给出不同结果，
   还会留下 PK 重复；分区表是**确定性**的：`partition_expired` 那一列就是它的判据形状。）
2. 这两列（ghost / rev）在生产上怎么用？（它们是两条独立的质量规则：ghost > 0 说明
   保留期口径在漂移，rev > 0 说明有回补/回拨。素材考点 13 的监控分类里"一致性"就是这一类。）
3. 为什么 `now` 要从数据里取？（判题器里没有可信时钟；真实系统同理 —— 清理任务的"当前时刻"
   一旦来自 worker 本地时钟，跨可用区的保留期就会不一致。）""",
    )


def sync_to_bank(only=None):
    """`--sync [key...]`：把生成器算出来的那份**写回已入库的题文件**。

    为什么需要它：题库只增不减（C5），`bank:add` 撞到同 id 只会"跳过"，
    于是"纠正一道已入库题的文案/用例名/expected"没有正规出口 —— 只能手改 JSON，
    而手改必漏（本批就漏过一次：改了库里的 expected，没改用例名）。
    纪律三条：① 只覆盖**题面已存在**的题（绝不新建文件，绝不换 id）；
    ② 入库时补的字段（id / schemaVersion / source.ingestedAt / case.visible）原样保留；
    ③ 写完立刻用 `--check` 的同一段判据复验，写完不一致就当场报错。
    """
    idx = bank_index()
    keys = only or sorted(DRAFTS)
    touched, skipped, problems = [], [], []
    for key in keys:
        payload = fill_runner_defaults(DRAFTS[key]())
        check_draft_shape(key, payload)
        hits = idx.get(payload.get('statement'))
        if not hits:
            skipped.append(key)                       # 还没入库：该走 bank:add，不是这里
            continue
        rel_path, bank_q = hits[0]
        out = dict(payload)
        out['schemaVersion'] = bank_q.get('schemaVersion', 1)
        out['id'] = bank_q['id']
        out['source'] = {**payload['source']}
        if 'ingestedAt' in (bank_q.get('source') or {}):
            out['source']['ingestedAt'] = bank_q['source']['ingestedAt']
        bank_cases = bank_q.get('cases') or []
        if len(bank_cases) != len(payload.get('cases') or []):
            problems.append('%s: 用例数 %d ≠ 库里 %d，拒绝覆盖（用例行错位比改错更坏）'
                            % (key, len(payload['cases']), len(bank_cases)))
            continue
        out['cases'] = [{**c, 'visible': bc.get('visible', True)}
                        for c, bc in zip(payload['cases'], bank_cases)]
        changed = sorted(k for k in set(out) | set(bank_q)
                         if json.dumps(out.get(k, '@'), sort_keys=True, ensure_ascii=False)
                         != json.dumps(bank_q.get(k, '@'), sort_keys=True, ensure_ascii=False))
        if not changed:
            continue
        path = os.path.join(ROOT, *rel_path.split('/'))
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        touched.append('%s → %s（改了 %s）' % (key, rel_path, ','.join(changed)))
    for line in touched:
        print('SYNC %s' % line)
    for line in problems:
        print('REFUSE %s' % line)
    if skipped:
        print('[sync] 未入库、不动题库的草稿：' + ', '.join(skipped))
    print('[sync] 覆盖 %d 份；拒绝 %d 份' % (len(touched), len(problems)))
    if problems:
        return 1
    return check_against_bank()


if __name__ == '__main__':
    import sys

    os.makedirs(OUT_DIR, exist_ok=True)
    if '--list' in sys.argv:
        for k in sorted(DRAFTS):
            print(k)
        raise SystemExit(0)
    if '--check' in sys.argv:
        raise SystemExit(check_against_bank())
    if '--sync' in sys.argv:
        raise SystemExit(sync_to_bank([a for a in sys.argv[1:] if not a.startswith('--')]))
    # 先清空上一轮的残留：out/ 是可以整目录喂给 bank:add 的，
    # 留一份"生成器已经不认的旧草稿"就等于往知识库里塞回一道被放弃的题。
    for _stale in sorted(os.listdir(OUT_DIR)):
        if _stale.endswith('.json'):
            os.remove(os.path.join(OUT_DIR, _stale))
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, key + '.json')
        payload = fn()
        check_draft_shape(key, payload)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print('wrote %s' % os.path.relpath(path, ROOT))
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print('全部 %d 份草稿 JSON 可解析' % len(DRAFTS))
