#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把**生成器算出来的那份**写回已入库的题文件（跨公司通用的正规出口）。

为什么要有它：`bank:add` 是追加式的（红线 C5，撞同 id 只会"跳过"），所以"纠正一道已入库的题"
以前只有两条坏路 —— 手改 JSON（改完与生成器不一致，下次重生成草稿就把修正冲掉），
或者在各家 `gen.py` 里各写一份 `--sync`（阿里那份就是这么长出来的，但复制五遍迟早漂移）。
这条脚本把判据集中在一个地方，靠 `check_provenance.py` 的同一段逻辑复验。

三条约束（与 `alibaba/gen.py --sync` 一致）：
  1. **只覆盖题面（statement）已在库里的那道**：绝不新建文件、绝不换 id；
  2. 入库时补的字段（`id` / `schemaVersion` / `source.ingestedAt` / `case.visible`）原样保留，
     用例数不一致直接拒绝（行错位比改错一个字段更坏）；
  3. 写完立刻用出处审计复验该公司，报告里出现 PROVENANCE/DRIFT 就当场失败。

用法：
    python scripts/bank/drafts/sync_one.py sql-bd-live-pull-lease-redis
    python scripts/bank/drafts/sync_one.py --company ByteDance --dry-run k1 k2
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 3)))

_spec = importlib.util.spec_from_file_location('prov', os.path.join(HERE, 'check_provenance.py'))
PROV = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PROV)


def load_drafts(out_dir):
    out = []
    if not os.path.isdir(out_dir):
        return out
    for name in sorted(os.listdir(out_dir)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(out_dir, name), encoding='utf-8') as fh:
            out.append((name[:-5], json.load(fh)))
    return out


def find_draft(key, company=None):
    """在六家的草稿目录里找这个 key；找不到就要求先跑对应生成器。"""
    companies = [company] if company else sorted(PROV.COMPANIES)
    for name in companies:
        for _gen_rel, out_name in PROV.COMPANIES[name]:
            for k, payload in load_drafts(os.path.join(ROOT, 'data', out_name, 'out')):
                if k == key:
                    return name, payload
    raise SystemExit(
        f'找不到草稿 {key}（草稿目录在 data/drafts-*/out/，先跑该公司生成器：'
        f'python scripts/bank/drafts/<公司>/gen.py）')


def sync(key, company, dry_run=False, bank_id=None):
    company, payload = find_draft(key, company)
    stmt = payload.get('statement')
    if bank_id:
        # 改了题面本身（措辞/单位/示例数字）时按 statement 就找不到了 —— 这时必须显式点名目标 id，
        # 并且**标题要一致**才算同一道题。缺了这道护栏，"按文件名猜出处然后整块覆盖"就能毁掉一道好题。
        hits = [(rel, q) for rel, q in PROV.bank_questions(company) if q.get('id') == bank_id]
        if len(hits) != 1:
            raise SystemExit(f'{key}: 指定 id {bank_id} 找到 {len(hits)} 道，拒绝覆盖')
        if hits[0][1].get('title') != payload.get('title'):
            raise SystemExit(f'{key}: 指定 id {bank_id} 的标题与草稿不一致，拒绝覆盖\n'
                             f'    库里: {hits[0][1].get("title")}\n    草稿: {payload.get("title")}')
    else:
        hits = [(rel, q) for rel, q in PROV.bank_questions(company) if q.get('statement') == stmt]
        if len(hits) != 1:
            raise SystemExit(
                f'{key}: 在 {company} 的 {len(hits)} 道题里找到题面匹配。'
                '要么这道题还没入库（该走 bank:add），要么题面重复；'
                '如果你改的就是题面本身，加 --id <库里那道题的 id>（会额外核对标题一致）')
    rel_path, bank_q = hits[0]

    out = json.loads(json.dumps(payload))          # 深拷贝，别改到内存里那份
    # 库里可能有"草稿不声明"的字段（早期手写入库的题就有），整份覆盖会把它们抹掉 ——
    # 所以以库为底、用草稿的字段盖上去，再补回 ingest 那几个。
    merged = json.loads(json.dumps(bank_q))
    for k in [x for x in merged if x not in out and x not in ('id', 'schemaVersion')]:
        out[k] = merged[k]
    out['schemaVersion'] = bank_q.get('schemaVersion', 1)
    out['id'] = bank_q['id']
    out['source'] = dict(payload.get('source') or {})
    if 'ingestedAt' in (bank_q.get('source') or {}):
        out['source']['ingestedAt'] = bank_q['source']['ingestedAt']
    bank_cases = bank_q.get('cases') or []
    if 'cases' in out and len(out['cases']) != len(bank_cases):
        raise SystemExit(f'{key}: 用例数 {len(out["cases"])} ≠ 库里 {len(bank_cases)}，拒绝覆盖')
    if 'cases' in out:
        out['cases'] = [{**c, 'visible': bc.get('visible', True)}
                        for c, bc in zip(out['cases'], bank_cases)]
    # 库里那些 `orderSensitive: false` 之类的键是 ingest 时 zod 补的默认值，草稿里通常不写。
    # 不补齐的话写回就等于把它们抹掉 —— 语义没变（默认值就是它），但每次 sync 都带上
    # 三个文件的无意义 diff，会把"这次到底改了什么"淹掉。
    if isinstance(out.get('runner'), dict):
        for k, v in PROV.RUNNER_DEFAULTS.items():
            out['runner'].setdefault(k, v)

    changed = sorted(k for k in set(out) | set(bank_q)
                     if PROV.dump(out.get(k, '@')) != PROV.dump(bank_q.get(k, '@')))
    if not changed:
        print(f'NOOP {key}（{bank_q["id"]}）：与库里一致，一个字节都不写')
        return 0
    if dry_run:
        print(f'DRY  {key} → {rel_path}：将改 {changed}')
        return 0
    path = os.path.join(ROOT, *rel_path.split('/'))
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    print(f'SYNC {key} → {rel_path}（改了 {",".join(changed)}）')
    return 0


def main(argv):
    ap = argparse.ArgumentParser(prog='sync_one.py')
    ap.add_argument('keys', nargs='+')
    ap.add_argument('--company')
    ap.add_argument('--id', dest='bank_id',
                    help='按库里那道题的 id 定位（只有改到题面本身时才需要，会额外核对标题一致）')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)
    rc = 0
    for key in args.keys:
        rc |= sync(key, args.company, args.dry_run, args.bank_id)
    if rc or args.dry_run:
        return rc
    print('\n=== 用出处审计复验（必须 0 漂移）===')
    done = set()
    for key in args.keys:
        company, _ = find_draft(key, args.company)
        if company in done:
            continue
        done.add(company)
        proc = subprocess.run([sys.executable, os.path.join(HERE, 'check_provenance.py'), '--no-run', company],
                              capture_output=True, text=True, encoding='utf-8', errors='replace')
        sys.stdout.write(proc.stdout)
        rc |= proc.returncode
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
