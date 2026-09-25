#!/usr/bin/env python3
"""
Airbnb 草稿预检（出题循环里的本地闸门）。

为什么要有它：容器判题矩阵是最终事实来源，但一轮矩阵要 20-60s；
而 expected 是 gen.py 里的模型算出来的 —— **模型自己写错就没有任何东西能发现**。
这里对同一份契约做一个**独立实现**（把区间摊成"占用了哪几天"的集合，
重叠与覆盖全靠集合运算），两边不一致就是其中一边错。

用法：
    python scripts/bank/drafts/airbnb/precheck.py data/drafts-airbnb/out
"""
import json
import os
import sys

LOCK, RELEASE, COMMIT = 0, 1, 2

REGISTRY = {}


def solves(key):
    def deco(fn):
        REGISTRY[key] = fn
        return fn
    return deco


@solves('alg-airbnb-booking-gate')
def booking_gate(now, ops, froms, tos, reqs, args):
    """
    逐日集合版重写。注意锁必须**按把**存，不能按 owner 合并成一张日集：
    合并之后"两把相邻的锁"看起来就覆盖了整段，规则 4（必须一把完整覆盖）会被抹平。
    """
    n = len(now)
    if any(len(x) != n for x in (ops, froms, tos, reqs, args)):
        raise ValueError('length mismatch')

    held = {}            # reqId -> [[days:set, expiry], ...] 同一 owner 的各把锁天然互不重叠
    booked_days = set()  # 已成交的日期（本题只有一个 listing）
    max_token = 0
    out = []

    for i in range(n):
        t = now[i]
        op, f, to, r, a = ops[i], froms[i], tos[i], reqs[i], args[i]
        if i and t < now[i - 1]:
            raise ValueError('time goes backwards')
        if r <= 0:
            raise ValueError('reqId must be positive')
        if f >= to:
            raise ValueError('empty date range')
        if op not in (LOCK, RELEASE, COMMIT):
            raise ValueError('unknown op')
        days = set(range(f, to))

        for owner in list(held):
            kept = [l for l in held[owner] if l[1] > t]   # expiry == t ⇒ 已失效
            if kept:
                held[owner] = kept
            else:
                del held[owner]

        if op == LOCK:
            if a <= 0:
                raise ValueError('ttl must be positive')
            mine = [l for l in held.get(r, []) if l[0] & days]
            if mine:
                for l in mine:
                    l[1] = t + a                          # 重入：只续期，不新建
                out.append(1)
                continue
            if any(l[0] & days for owner in held for l in held[owner]):
                out.append(0)
                continue
            if days & booked_days:
                out.append(0)
                continue
            held.setdefault(r, []).append([set(days), t + a])
            out.append(1)
        elif op == RELEASE:
            if a != 0:
                raise ValueError('RELEASE takes no arg')
            before = len(held.get(r, []))
            kept = [l for l in held.get(r, []) if not (l[0] & days)]
            if kept:
                held[r] = kept
            elif r in held:
                del held[r]
            out.append(1 if len(kept) < before else 0)
        else:
            if a < 0:
                raise ValueError('token must be >= 0')
            covered = any(l[0] >= days for l in held.get(r, []))   # 一把锁就要盖住整段
            if not covered or a <= max_token:
                out.append(0)                                      # 纯失败：什么都不改
                continue
            booked_days |= days
            kept = [l for l in held.get(r, []) if not (l[0] & days)]
            if kept:
                held[r] = kept
            elif r in held:
                del held[r]
            max_token = a
            out.append(1)
    return out


def main(argv):
    files = []
    for p in argv:
        if os.path.isdir(p):
            files += [os.path.join(p, n) for n in sorted(os.listdir(p)) if n.endswith('.json')]
        elif p.endswith('.json'):
            files.append(p)
    if not files:
        print('没有 .json 草稿可检查', file=sys.stderr)
        return 2
    failed = 0
    for path in files:
        q = json.load(open(path, encoding='utf-8'))
        key = os.path.splitext(os.path.basename(path))[0]
        cases = q.get('cases') or []
        fn = REGISTRY.get(key)
        if fn is None:
            print(f'SKIP {key}  未登记参考解重写（{path}）')
            continue
        bad = []
        for c in cases:
            raised = None
            msg = None
            try:
                got = fn(*c['input'])
            except Exception as exc:  # noqa: BLE001
                got = f'raise:{exc}'
                raised = exc.__class__.__name__
                msg = str(exc)
            throw = c.get('expectThrow')
            if throw:
                if raised is None:
                    bad.append(f'{c["name"]}: 期望抛 {throw}，实际正常返回 {got}')
                elif raised != 'ValueError':
                    bad.append(f'{c["name"]}: 契约由 ValueError 表达，实际 {raised}: {msg}')
                continue
            if raised:
                bad.append(f'{c["name"]}: 不该抛错，实际 {raised}: {msg}')
                continue
            if got != c['expected']:
                bad.append(f'{c["name"]}: expected={c["expected"]} got={got}')
        if bad:
            failed += 1
            print(f'FAIL {key}')
            for b in bad:
                print(f'       {b}')
        else:
            print(f'ok   {key}  ({len(cases)} 用例)')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
