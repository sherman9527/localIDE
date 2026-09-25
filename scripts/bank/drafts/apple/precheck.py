#!/usr/bin/env python3
"""
Apple 草稿的本地预检（与 deepseek/precheck.py 同一套纪律）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮要几十秒到几分钟；
而用例的 expected 是人算的，人算就会错。这个脚本用 Python 把参考解**逐行等价重写**一遍，
先筛掉"用例自相矛盾 / expected 算错"。

它不能替代容器判题：Python 的 int 不会溢出，所以"必须用 long"那条只能由容器证明。

用法：
    python scripts/bank/drafts/apple/precheck.py data/drafts-apple/out
"""
import json
import os
import sys

REGISTRY = {}


def solves(key):
    def deco(fn):
        REGISTRY[key] = fn
        return fn
    return deco


@solves('alg-apple-federated-peak')
def global_peak(events):
    """globalPeak：按 ts 升序、同刻负增量先落地，走前缀和取最大；负前缀显式失败。"""
    for ev in events:
        if ev is None or len(ev) != 2:
            raise ValueError('event must be [ts, delta]')
        if ev[0] < 0:
            raise ValueError('negative timestamp')
    ordered = sorted(events, key=lambda e: (e[0], e[1]))
    active = 0
    peak = 0
    for ts, delta in ordered:
        active += delta
        if active < 0:
            raise ValueError('negative concurrency prefix')
        peak = max(peak, active)
    return peak


@solves('alg-apple-airflow-interval')
def airflow_intervals(start, granularity, now, catchup):
    """scheduledIntervals：只有 end <= now 的区间才可触发 ⇒ 个数 = (now-start)//g，没有 +1。"""
    if granularity <= 0:
        raise ValueError('granularity must be positive')
    elapsed = now - start
    if elapsed < granularity:
        return []
    closed = elapsed // granularity
    first = 0 if catchup else closed - 1
    count = closed if catchup else 1
    return [[start + (first + i) * granularity, start + (first + i + 1) * granularity]
            for i in range(count)]


def main(argv):
    paths = []
    for p in argv:
        if os.path.isdir(p):
            paths += [os.path.join(p, n) for n in sorted(os.listdir(p)) if n.endswith('.json')]
        elif p.endswith('.json'):
            paths.append(p)
    if not paths:
        print('没有 .json 草稿可检查', file=sys.stderr)
        return 2
    failed = 0
    for path in paths:
        q = json.load(open(path, encoding='utf-8'))
        qid = os.path.splitext(os.path.basename(path))[0]
        fn = REGISTRY.get(qid)
        cases = q.get('cases') or []
        if fn is None:
            print(f'SKIP {qid}  未登记参考解重写（{path}）')
            continue
        bad = []
        for c in cases:
            try:
                got = fn(*c['input'])
                raised = None
            except ValueError as e:
                got, raised = f'raise:{e}', 'IllegalArgumentException'
            throw = c.get('expectThrow')
            if throw:
                if raised is None:
                    bad.append(f'{c["name"]}: 期望抛 {throw}，实际正常返回 {got}')
                elif raised != throw:
                    bad.append(f'{c["name"]}: 期望抛 {throw}，实际抛 {raised}')
                continue
            if got != c['expected']:
                bad.append(f'{c["name"]}: expected={c["expected"]} got={got}')
        if bad:
            failed += 1
            print(f'FAIL {qid}')
            for b in bad:
                print(f'       {b}')
        else:
            print(f'ok   {qid}  ({len(cases)} 用例)')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
