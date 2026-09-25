#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
题库出处审计：**每家已入库的题，必须还能由它自己那批生成器复现出来。**

为什么需要它：`bank:add` 是追加式的（红线 C5），入库之后就再无出口。
本仓库真的发生过"入库的题与生成器各说各话"：
  * 阿里这批前 12 题里，5 题（mysql 2 + redis 2 + pyspark 1）根本没进 `gen.py`，
    于是"改了库里的题、生成器不知道"这件事连迹象都没有；
  * `apple/airbnb` 若干题的文案后来被人工修过（过时用例引用、算错的推导），
    生成器里那份却还是老样子 —— 下次重生成草稿就会把修好的东西改回坏的。
`gen.py --check` 只能查阿里自己那批（每家各写一份太散），这条脚本按同一段判据查全部六家。

三条口径（与 `alibaba/gen.py --check` 完全一致，别在这里发明新的）：
  * **按题面（statement）对齐，不按编号**：`bank:add` 按类别顺序分配 id，
    批次内顺序与草稿登记顺序对不上号是常态（阿里就错过一次）。
  * 剥掉入库时补的字段（`id` / `schemaVersion` / `source.ingestedAt` / `case.visible`）。
  * zod 会往库文件里写默认值（`runner.orderSensitive` 等）而草稿里可能没写 ——
    两边都补齐，否则"库里多了个 false"会被报成漂移。
    （补齐不等于放水：把库里的 `orderSensitive` 改成 true，照样报漂移。）

用法：
    python scripts/bank/drafts/check_provenance.py               # 六家全查
    python scripts/bank/drafts/check_provenance.py --no-run      # 用现成的 data/drafts-*/out
    python scripts/bank/drafts/check_provenance.py Alibaba PDD   # 只查指定公司
    python scripts/bank/drafts/check_provenance.py --bless       # 登记/刷新"无草稿题"的指纹基线
退出码：有"入库了但生成器复现不出来"或有字段漂移 → 1。
未入库的草稿（下一批的候选）只报数，不算失败。
"""
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 3)))
BANK = os.path.join(ROOT, 'content', 'questions')
# 无生成器草稿那批题的**指纹基线**（见 `fingerprint` 的说明：它不是出处，是"别偷偷改"的凭据）。
BASELINE = os.path.join(HERE, 'no_draft_baseline.json')

# 公司名（写在 source.company 里）→ [(生成器脚本目录/文件, 草稿输出目录)]
# 一家可以有多份生成器：阿里把代码题与主观题拆成两个文件（代码题那份要跑模型算 expected，
# 主观题那份只是把长文本装配成草稿），但"已入库的题必须能复现"这条判据对两者一样成立。
COMPANIES = {
    'Airbnb': [('airbnb/gen.py', 'drafts-airbnb')],
    'Apple': [('apple/gen.py', 'drafts-apple')],
    'DeepSeek': [('deepseek/gen.py', 'drafts-ds')],
    'PDD': [('pdd/gen.py', 'drafts-pdd')],
    'ByteDance': [('bytedance/gen.py', 'drafts-bd')],
    'Alibaba': [('alibaba/gen.py', 'drafts-ab'), ('alibaba/subjective_gen.py', 'drafts-ab-subj'),
                ('alibaba/fe_gen.py', 'drafts-ab-fe')],
}

DRAFT_FREE_FIELDS = ('id', 'schemaVersion')
DRAFT_FREE_SOURCE = ('ingestedAt',)
DRAFT_FREE_CASE = ('visible',)
# 与 shared/src/question.ts 的 .default(...) 同源；这里写死是因为**审计不许依赖被测物**：
# 若改成去读 zod，schema 一放宽这条闸门就跟着变松，正是它该抓的那类事。
RUNNER_DEFAULTS = {'entry': 'function', 'orderSensitive': False, 'timeoutMs': 20000}


def strip_ingested_fields(q):
    out = {k: v for k, v in q.items() if k not in DRAFT_FREE_FIELDS}
    out['source'] = {k: v for k, v in (out.get('source') or {}).items()
                     if k not in DRAFT_FREE_SOURCE}
    # 「没这个键」与「有个空数组」是两件事：主观题本来就没有 cases，
    # 无条件补一个空数组会让每道主观题都报"漂移在 cases 上"，把真漂移埋掉。
    if 'cases' in out:
        out['cases'] = [{k: v for k, v in c.items() if k not in DRAFT_FREE_CASE}
                        for c in (out.get('cases') or [])]
    runner = out.get('runner')
    if isinstance(runner, dict):
        runner = dict(runner)
        for key, value in RUNNER_DEFAULTS.items():
            runner.setdefault(key, value)
        out['runner'] = runner
    return out


def fill_defaults(q):
    runner = q.get('runner')
    if isinstance(runner, dict):
        for key, value in RUNNER_DEFAULTS.items():
            runner.setdefault(key, value)
    return q


def canon(value):
    """整数面值的浮点（`85.0`）与整数（`85`）是同一个数。

    Python 的 json 写 `85.0`，而 ingest 走 JS（`JSON.stringify(85.0)` → `85`），
    于是**每个整数值**都会报成漂移。这不是内容差异，别去"修"题库。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canon(v) for v in value]
    if isinstance(value, dict):
        return {k: canon(v) for k, v in value.items()}
    return value


def dump(value):
    return json.dumps(canon(value), sort_keys=True, ensure_ascii=False)


def fingerprint(q):
    """无生成器草稿那批题的内容指纹。口径与漂移检查完全一致（同一套 strip + canon + 排序键）。

    说清楚它**不是**什么：出处仍然是"早期手写入库，没留手稿"。它只回答一个问题 ——
    这道题从登记起有没有被人在没有手稿的情况下改掉。没有它，这 29 道题是"改了也没人知道"；
    有了它，改动作会判红，而放行需要一次显式的 `--bless`（留下可审的 diff）。
    """
    return hashlib.sha1(dump(strip_ingested_fields(q)).encode('utf-8')).hexdigest()[:12]


def load_baseline():
    if not os.path.exists(BASELINE):
        return {}
    with open(BASELINE, encoding='utf-8') as fh:
        return json.load(fh)


def bank_questions(company):
    out = []
    for dirpath, _dirs, files in os.walk(BANK):
        for name in sorted(files):
            if not name.endswith('.json'):
                continue
            full = os.path.join(dirpath, name)
            with open(full, encoding='utf-8') as fh:
                q = json.load(fh)
            if (q.get('source') or {}).get('company') != company:
                continue
            out.append((os.path.relpath(full, ROOT).replace(os.sep, '/'), q))
    return out


def drafts(out_dir):
    out = {}
    if not os.path.isdir(out_dir):
        return out
    for name in sorted(os.listdir(out_dir)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(out_dir, name), encoding='utf-8') as fh:
            payload = json.load(fh)
        out.setdefault(payload.get('statement'), []).append((name[:-5], payload))
    return out


def run_generator(gen_py):
    proc = subprocess.run([sys.executable, gen_py], capture_output=True, text=True,
                          encoding='utf-8', errors='replace')
    tail = (proc.stdout or '').strip().splitlines()
    if proc.returncode != 0:
        return False, '生成器退出码 %d：%s' % (proc.returncode,
                                              (proc.stderr or '').strip()[:200] or '(无 stderr)')
    return True, tail[-1] if tail else '生成器无输出'


def audit(company, run_it=True, baseline=None):
    baseline = baseline if baseline is not None else load_baseline()
    notes = []
    dsets = {}
    for gen_rel, out_name in COMPANIES[company]:
        gen_py = os.path.join(HERE, *gen_rel.split('/'))
        out_dir = os.path.join(ROOT, 'data', out_name, 'out')
        if not os.path.exists(gen_py):
            return None, '缺少生成器 %s（题目从哪来的？）' % gen_rel
        if run_it:
            ok, note = run_generator(gen_py)
            if not ok:
                return None, '%s：%s' % (gen_rel, note)
            notes.append(note)
        for stmt, entries in drafts(out_dir).items():
            dsets.setdefault(stmt, []).extend(entries)
        if not run_it:
            notes.append('未跑 %s' % gen_rel)
    note = ' ＋ '.join(notes) if notes else '未跑生成器'
    missing, drift, soft_missing, matched, unmatched_drafts = [], [], [], 0, []
    no_draft_fp, unregistered = {}, []
    bank_total = 0
    seen_statements = set()
    for rel_path, bank_q in bank_questions(company):
        bank_total += 1
        stmt = bank_q.get('statement')
        seen_statements.add(stmt)
        hits = dsets.get(stmt)
        if not hits:
            # 主观题没有 expected 要复现，早期批次（DeepSeek 之前）也确实是手写入库的：
            # 报数但不算失败。**代码题没有草稿 = 出处真的丢了**，那是失败。
            # 但"没有手稿"不等于"可以静默改"：这批题按指纹基线核查（见 fingerprint 的说明）。
            entry = '%s（%s）' % (bank_q.get('id'), rel_path.split('/')[-1])
            if bank_q.get('judgeKind') == 'llm-rubric':
                soft_missing.append(entry)
                qid = bank_q.get('id')
                fp = fingerprint(bank_q)
                no_draft_fp[qid] = fp
                known = baseline.get(qid)
                if known is None:
                    unregistered.append(qid)
                elif known != fp:
                    drift.append('%s 无生成器草稿，内容与指纹基线不符（登记 %s → 现在 %s）'
                                 % (qid, known, fp))
            else:
                missing.append(entry)
            continue
        key, payload = hits[0]
        expect = strip_ingested_fields(bank_q)
        got = fill_defaults(payload)
        if dump(expect) != dump(got):
            diff = sorted(k for k in set(expect) | set(got)
                          if dump(expect.get(k, '@')) != dump(got.get(k, '@')))
            drift.append('%s ↔ %s: 不一致字段 %s' % (bank_q.get('id'), key, diff))
        else:
            matched += 1
    for stmt, entries in dsets.items():
        if stmt not in seen_statements:
            unmatched_drafts.extend(k for k, _ in entries)
    lines = []
    if missing:
        lines.append('PROVENANCE 入库了但生成器复现不出来 %d 道：%s' % (len(missing), ', '.join(missing)))
    for line in drift:
        lines.append('DRIFT %s' % line)
    verdict = 'ok' if not missing and not drift else 'bad'
    return {
        'verdict': verdict, 'matched': matched, 'missing': missing, 'drift': drift,
        'soft_missing': soft_missing, 'bank_total': bank_total,
        'no_draft_fp': no_draft_fp, 'unregistered': unregistered,
        'candidates': sorted(unmatched_drafts), 'note': note,
    }, None


def main(argv):
    run_it = '--no-run' not in argv
    bless = '--bless' in argv
    wanted = [a for a in argv if not a.startswith('--')]
    companies = wanted or sorted(COMPANIES)
    baseline = load_baseline()
    seen_fps = {}
    bad = 0
    for company in companies:
        result, err = audit(company, run_it, baseline)
        if err:
            print('[%s] 跑不起来：%s' % (company, err))
            bad += 1
            continue
        mark = '✅' if result['verdict'] == 'ok' else '❌'
        seen_fps.update(result['no_draft_fp'])
        print('[%s] %s 库内 %d 道，生成器逐字段复现 %d 道｜未入库候选 %d 份｜%s' % (
            company, mark, result['bank_total'],
            result['matched'], len(result['candidates']), result['note']))
        for line in ['PROVENANCE 缺出处（代码题！）：%s' % ', '.join(result['missing'])] if result['missing'] else []:
            print('   ' + line)
        for line in result['drift']:
            print('   DRIFT ' + line)
        if result['soft_missing']:
            checked = len(result['soft_missing']) - len(result['unregistered'])
            print('   主观题无草稿 %d 道（早期手写入库，复现这一层只报数；其中 %d 道按指纹基线核过）：%s' % (
                len(result['soft_missing']), checked, ', '.join(result['soft_missing'])))
        if result['unregistered']:
            print('   没登记指纹的无草稿题 %d 道（新入库的正常会落在这里；登记一次：'
                  'python %s --bless）：%s' % (
                      len(result['unregistered']), os.path.relpath(__file__, ROOT),
                      ', '.join(result['unregistered'])))
        if result['candidates']:
            print('   候选（下一批，不算失败）：' + ', '.join(result['candidates']))
        bad += 0 if result['verdict'] == 'ok' else 1
    if bless:
        merged = dict(baseline)
        merged.update(seen_fps)
        with open(BASELINE, 'w', encoding='utf-8') as fh:
            json.dump(dict(sorted(merged.items())), fh, ensure_ascii=False, indent=1)
            fh.write('\n')
        print('\n[bless] 无草稿题指纹基线已写入 %d 条（本次覆盖/新增 %d 条）→ %s' % (
            len(merged), len(seen_fps), os.path.relpath(BASELINE, ROOT)))
    print('\n[出处审计] %d 家通过 / %d 家有问题' % (len(companies) - bad, bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
