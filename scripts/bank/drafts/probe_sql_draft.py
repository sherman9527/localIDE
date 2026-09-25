#!/usr/bin/env python3
"""SQL 草稿的入库前预检：在**还没进题库**时就把参考解对真 MySQL 跑一遍。

为什么要有它：判题矩阵读的是已入库的 `content/questions`，而入库是 append-only 的（C5）——
参考解写错就只能靠"隐藏"收尾，比先跑一遍难看得多。这次出题真的撞上了：
`strftime` 里写了 MySQL 的 `%i:%s`，Python 把它原样留下，`as_of` 变成 `'12:%i:1789444800'`，
七条用例全在 setup 阶段炸 —— 而这一步在容器里 30 秒就能查出来，不用等一轮矩阵。

用法（在**跑着 MySQL 的 arena 容器里**执行，草稿在 `data/` 下、两边共享）：
    docker compose exec -T arena bash -lc \\
      "cd /app && python3 scripts/bank/drafts/probe_sql_draft.py data/drafts-airbnb/out/<key>.json"

它做三件事：每个用例建一个一次性库（setup + 该用例的变异语句）→ 跑参考解，
**按 runner 的同一套判据**比列名与行集 → 再跑一遍朴素解，报告它是不是真的会挂（全都不挂 = 这题没有判别力）。

**判据必须与判题器等强，否则这条预检就是假绿。** 第一次用它就是这么漏的：
探针只比行集、还加了 `-N`（不打表头），于是"空结果集声明了列名"这种矩阵必红的形状被放行了
（`docs/JUDGING.md` 第 79 行写着空表要写成裸数组 `[]`）。现在列名也照比，
并且照 runner 的规矩：期望里没声明 `columns`（空表）就跳过列名这一项。
"""
import json
import subprocess
import sys

DRAFT = sys.argv[1]
q = json.load(open(DRAFT, encoding='utf-8'))
runner = q['runner']
# 与 server/src/exec/mysql.ts 的 mysqlArgs 对齐：--batch 且**不打 -N**（第一行是表头）
MYSQL = ['mysql', '--socket=/var/run/mysqld/mysqld.sock', '--user=root', '--batch', '--raw', '--wait']


def sql(text, db=None):
    args = MYSQL + (['-e', text] if db is None else ['--database=' + db, '-e', text])
    return subprocess.run(args, capture_output=True, text=True)


def parse_tsv(stdout):
    """`parseTsv` 的 Python 等价：0 行时连表头都没有 ⇒ columns 是 []。"""
    lines = [line for line in stdout.split('\n') if line]
    if not lines:
        return [], []
    return lines[0].split('\t'), [line.split('\t') for line in lines[1:]]


def verdict(query, solution):
    """返回 None 表示通过，否则返回一条具体差异（判据抄 `runners/mysql.ts`）。"""
    proc = sql(solution, query['_db'])
    if proc.returncode != 0:
        return 'QUERY-FAIL ' + proc.stderr.strip()[:200]
    columns, rows = parse_tsv(proc.stdout)
    expected = query['expected']
    if isinstance(expected, dict):
        want_columns = expected.get('columns')
        want_rows = [[str(c) for c in row] for row in expected['rows']]
    else:                                   # 裸数组 = 空结果集，不声明列名
        want_columns = None
        want_rows = [[str(c) for c in row] for row in (expected or [])]
    if want_columns and want_columns != columns:
        return f'列名不一致：期望 {want_columns}，实际 {list(columns)}'
    if len(rows) != len(want_rows):
        return f'行数不一致：期望 {len(want_rows)}，实际 {len(rows)}\n   got  {rows}\n   want {want_rows}'
    for i, (got, want) in enumerate(zip(rows, want_rows)):
        if got != want:
            return f'第 {i + 1} 行不一致：期望 {want}，实际 {got}'
    return None


def make_db(label, query):
    db = 'arena_probe_' + str(abs(hash(label + query['name'])) % 10**8)
    sql(f'CREATE DATABASE {db}')
    query['_db'] = db
    for stmt in runner['setup'] + list(query['input']):
        r = sql(stmt, db)
        if r.returncode != 0:
            query['_setup_error'] = 'SETUP-FAIL ' + r.stderr.strip()[:160]


def drop_db(query):
    sql(f'DROP DATABASE IF EXISTS {query.pop("_db", "")}')
    query.pop('_setup_error', None)


bad = 0
for case in q['cases']:
    make_db('ref', case)
    setup_error = case.pop('_setup_error', None)
    if setup_error:
        print(f'SETUP-FAIL | {case["name"]}\n   {setup_error}')
        bad += 1
    else:
        diff = verdict(case, runner['referenceSolution'])
        if diff:
            print(f'参考解不通过 | {case["name"]}\n   {diff}')
            bad += 1
        else:
            make_db('naive', case)
            naive_diff = verdict(case, runner['naiveSolution'])
            drop_db(case)
            tag = '朴素解也不挂(没有判别力!)' if naive_diff is None else '朴素解会挂'
            print(f'PASS {tag:<24} | {case["name"]}')
            continue
    drop_db(case)

print(f'\n{len(q["cases"])} 用例，参考解/建库失败 {bad} 条')
sys.exit(1 if bad else 0)
