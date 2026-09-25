#!/usr/bin/env python3
"""
朴素解探针：把题面/答案里"朴素解会给 N"这类断言逐用例算一遍。

为什么要有它：容器判题矩阵只证明"朴素解整体不通过"，不证明我们在答案里写的
"计数版这里给 4"。写进答案的数字必须是量出来的，不能是推出来的。

用法：python scripts/bank/drafts/deepseek/probe_naive.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, *(['..'] * 4)))
OUT = os.path.join(ROOT, 'data', 'drafts-ds', 'out')


# ------------------------------------------------------------------ prefix cache
def naive_prefill(prompts, block_size):
    """LCP 版朴素解：不做块对齐、不看链式 key、尾块也算已缓存。"""
    if block_size <= 0:
        raise ValueError('bad block size')
    for prompt in prompts:
        for token in prompt:
            if token < 0:
                raise ValueError('dirty token')
    total = 0
    for i in range(len(prompts)):
        best = 0
        for j in range(i):
            n = min(len(prompts[j]), len(prompts[i]))
            k = 0
            while k < n and prompts[j][k] == prompts[i][k]:
                k += 1
            best = max(best, k)
        total += len(prompts[i]) - best
    return total


# ------------------------------------------------------------------ moe capacity
def naive_moe(routing, num_experts, capacity):
    """计数版朴素解：Σ max(0, cnt_e − capacity)，不看顺序、允许部分占用。"""
    if num_experts <= 0:
        raise ValueError('bad expert count')
    if capacity <= 0:
        raise ValueError('bad capacity')
    load = [0] * num_experts
    for chosen in routing:
        if not chosen:
            raise ValueError('token routed to no expert')
        for e in chosen:
            if e < 0 or e >= num_experts:
                raise ValueError('expert id out of range')
            load[e] += 1
    dropped = 0
    for chosen in routing:
        for e in chosen:
            if load[e] > capacity:
                dropped += 1
                break
    return dropped


def moe_dropped_reference(routing, num_experts, capacity):
    """参考解（与 precheck 同一份语义），用来对照朴素解差在哪。"""
    if num_experts <= 0:
        raise ValueError('bad expert count')
    if capacity <= 0:
        raise ValueError('bad capacity')
    load = [0] * num_experts
    dropped = 0
    for chosen in routing:
        if not chosen:
            raise ValueError('token routed to no expert')
        for e in chosen:
            if e < 0 or e >= num_experts:
                raise ValueError('expert id out of range')
        if len(set(chosen)) != len(chosen):
            raise ValueError('duplicated expert')
        if all(load[e] < capacity for e in chosen):
            for e in chosen:
                load[e] += 1
        else:
            dropped += 1
    return dropped


def naive_epoll(bytes_, chunk, edge, drains, max_wakes):
    """
    朴素解：把两种触发模式当成同一件事 —— "能读就读，读到没得读为止"。
    答案里写的那句"ET 的悬挂在这份实现里永远是 0"就是从这里量的，不是推的。
    """
    if bytes_ < 0 or max_wakes < 0:
        raise ValueError('negative input')
    if chunk <= 0:
        raise ValueError('chunk must be positive')
    processed, wakes = 0, 0
    while processed < bytes_ and wakes < max_wakes:
        processed += min(chunk, bytes_ - processed)
        wakes += 1
        if drains:
            while processed < bytes_:
                processed += min(chunk, bytes_ - processed)
    return [processed, wakes, bytes_ - processed]


MODELS = {
    'alg-deepseek-prefix-cache': {'naive': naive_prefill, 'reference': None},
    'alg-deepseek-moe-capacity': {'naive': naive_moe, 'reference': moe_dropped_reference},
    'alg-deepseek-epoll-trigger-mode': {'naive': naive_epoll, 'reference': None},
}


def main():
    files = sorted(f for f in os.listdir(OUT) if f.endswith('.json'))
    for name in files:
        key = name[:-5]
        model = MODELS.get(key)
        if not model:
            continue
        q = json.load(open(os.path.join(OUT, name), encoding='utf-8'))
        print(f'== {key}')
        for c in q['cases']:
            def run(fn):
                if fn is None:
                    return '(未建模)'
                try:
                    return fn(*c['input'])
                except ValueError:
                    return 'raise'

            print(f'   expected={str(c["expected"]):>6}  naive={str(run(model["naive"])):>6}  '
                  f'ref={str(run(model["reference"])):>6}  | {c["name"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
