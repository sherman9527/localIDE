#!/usr/bin/env python3
"""
题目草稿生成器：用 Python 字面量写题，交给 json.dump 负责转义。

为什么要有它：手写 JSON 时题面里的中文引号会写成裸 ASCII `"`，
JSON 解析当场炸（本次出题真的炸过一次）；而 statement 里大量是
Java 代码与中文表述，转义错误肉眼查不过来。Python 里写三引号字符串，
序列化交给标准库，这类错误从"可能发生"变成"不可能发生"。

用法：
    python scripts/bank/drafts/deepseek/gen.py            # 生成全部草稿到 data/drafts-ds/out/
    python scripts/bank/drafts/deepseek/gen.py --list     # 只列已登记的题目标识
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
# 生成物落在 data/（整体被 gitignore）：仓库里只跟踪这些生成脚本，不跟踪草稿副本，
# 否则同一道题在 git 里就有两份真相（content/questions 才是唯一真相）。
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-ds', 'out')

DRAFTS = {}


def draft(key):
    def deco(fn):
        DRAFTS[key] = fn
        return fn
    return deco


def base(category, difficulty, title, statement, judge_kind, tags, source, **extra):
    q = {
        'category': category,
        'difficulty': difficulty,
        'title': title,
        'statement': statement,
        'judgeKind': judge_kind,
        'tags': tags,
        'source': source,
    }
    q.update(extra)
    return q


def src(company, role, ref, location='shanghai'):
    return {
        'company': company,
        'role': role,
        'location': location,
        'origin': 'history',
        'jds': [],
        'era': '2026',
        'knowledgeRef': ref,
        'addedBy': 'arena-company-expansion',
    }


# ------------------------------------------------------------ alg-java-0021：读题库本体回灌
# 这道题的模型草稿在一次"先截断再写盘"的补丁事故里丢了（同一类事故见 alibaba/gen.py 文件头）。
# 这里**不假装能重算 expected** —— 重算需要那份丢掉的模型，凭记忆重写等于再造一份猜测。
# 于是直接读已入库的题本体、剥掉 `ingest()` 补的那几个字段：
#   * 重跑本文件仍然产出这一份，`bank:add` 对它报"跳过"（一题不新增、一题不改写）；
#   * 出处审计不再把它当成"入库了但没人能复现"；
#   * 要改这道题就改 `content/questions/` 里那一份（改完审计自然还是平的），
#     别在这里另写第二份真相 —— 那是 `frozen/*.json` 漂移过的老路。
BANK_DIR = os.path.join(ROOT, 'content', 'questions')


def read_back(qid):
    def load():
        hit = None
        for dirpath, _dirs, files in os.walk(BANK_DIR):
            if f'{qid}.json' in files:
                hit = os.path.join(dirpath, f'{qid}.json')
                break
        if hit is None:
            raise AssertionError(f'{qid}: 题库里找不到这道题（回灌的前提是它已入库）')
        with open(hit, encoding='utf-8') as fh:
            raw = fh.read()
        if '\r' in raw:
            raise AssertionError(f'{qid}: 题库文件里有 CR（必须是 LF）')
        q = json.loads(raw)
        if q.get('id') != qid:
            raise AssertionError(f'{qid}: 文件内部 id 是 {q.get("id")}，与文件名不符')
        out = {k: v for k, v in q.items() if k not in ('id', 'schemaVersion')}
        out['source'] = {k: v for k, v in (out.get('source') or {}).items() if k != 'ingestedAt'}
        if 'cases' in out:
            out['cases'] = [{k: v for k, v in c.items() if k != 'visible'} for c in out['cases']]
        return out
    return load


DRAFTS['alg-java-0021'] = read_back('alg-java-0021')


# ------------------------------------------------------------------ alg-java-0022
@draft('alg-java-0022')
def q_kv_blocks():
    statement = """## 背景

你在实现推理引擎的 KV Cache 分配器（PagedAttention 那一层）。显存被切成等大的 block，
用一个位图描述占用：`blockFree[i] == 0` 表示第 i 块空闲，`== 1` 表示已用。

每个会话需要**恰好 `blocksPerSession` 个物理上连续的 block**（连续是为了让 attention kernel
用一段 stride 访问 K/V；跨段访问会让 kernel 退化成 gather）。

分配按「从左到右扫描、凑满就下单」的贪心进行；下单后这些块视为已占用，不再服务后续会话。

## 这题真正考的东西

新手会写成 `freeCount / blocksPerSession`。**这个公式在外部碎片下是错的**：

```
free = [0,0,1,0,0,1,0,0]  blocksPerSession = 3
三段连续空闲各 2 块，空闲块共 6 个 → 6/3 = 2，
但没有任何一段凑得出 3 块连续，正确答案是 0。
```

显存监控显示「还有 40% 空闲」而新会话进不来，就是这个形状 —— 是碎片，不是不够。

## 你要实现的入口

```java
public static int maxServableSessions(int[] blockFree, int blocksPerSession)
```

- 返回值：按上述贪心，最多能同时下单多少个会话；
- `blockFree` 为空数组时返回 `0`；
- 出现既不是 0 也不是 1 的值，说明位图被写坏，抛 `IllegalArgumentException`
  （不要按「非 0 即已用」宽容处理，那会把脏数据读成「刚好够用」）。

## 约定

1. `blocksPerSession <= 0` 抛 `IllegalArgumentException`。
2. 单个空闲段内可以连续下多个单（长度 6 的段、每会话 2 块 → 3 个单）。
3. 段尾凑不满一个单的零头必须浪费掉，不许跨段拼接（这正是碎片的定义）。

## 复杂度要求

`O(n)` 时间、`O(1)` 额外空间，单遍扫描（不许先物化所有段再统计）。"""

    reference = """public class Solution {
  public static int maxServableSessions(int[] blockFree, int blocksPerSession) {
    if (blocksPerSession <= 0) throw new IllegalArgumentException("bad session footprint");
    if (blockFree == null) throw new IllegalArgumentException("null bitmap");
    int run = 0;
    int sessions = 0;
    for (int bit : blockFree) {
      if (bit != 0 && bit != 1) throw new IllegalArgumentException("dirty bitmap value: " + bit);
      if (bit == 0) {
        run++;
      } else {
        run = 0;                       // 段被切断：零头作废，不许跨段拼接
      }
      if (run == blocksPerSession) {   // 凑满立刻下单并归零，实现"单段内多单"
        sessions++;
        run = 0;
      }
    }
    return sessions;
  }
}"""

    naive = """public class Solution {
  // 生产事故版：拿空闲块总数除以每会话块数，看不见碎片
  public static int maxServableSessions(int[] blockFree, int blocksPerSession) {
    if (blocksPerSession <= 0) throw new IllegalArgumentException("bad session footprint");
    if (blockFree == null) throw new IllegalArgumentException("null bitmap");
    int free = 0;
    for (int bit : blockFree) {
      if (bit != 0 && bit != 1) throw new IllegalArgumentException("dirty bitmap value: " + bit);
      if (bit == 0) free++;
    }
    return free / blocksPerSession;
  }
}"""

    answer = """**思路**：单遍扫描维护当前连续空闲段长度 `run`；`run` 达到 `blocksPerSession` 就下单并把 `run` 归零（这样同一段里可以连续下多单）；遇到已用块把 `run` 清零（零头作废）。`O(n)` 时间、`O(1)` 空间。

**为什么 `freeCount / bps` 是错的**：它把「容量」当成「可分配性」。连续约束下真正可服务的是**按段取整后求和** `Σ floor(runᵢ / bps)`，而不是 `floor(Σ runᵢ / bps)`。两者之差就是外部碎片。用例 1 就是这个反例：`[0,0,1,0,0,1,0,0]`、`bps=3`，三段各 2 块 → 朴素解答 2，真答案是 0。

**为什么脏值要抛错而不是当已用**：若 `bit=2` 被当成「非 0 即已用」，位图写坏会表现为「容量突然变小」，运维去查内存泄漏；若被当成「非 1 即可用」，会表现为「超卖」。两者都比一次显式失败贵得多。

**工程延伸（面试追问点）**：
1. 怎么量化碎片率？（`1 − Σ floor(runᵢ/bps)·bps / freeCount`；做成 gauge，比「空闲率」更能预测拒绝）。
2. 真引擎怎么缓解？（块链表 + 逻辑块到物理块映射，放弃连续性换 kernel 的 gather；或按 bps 分档维护 free list 做 buddy 分配；或周期性 compaction 迁移活跃会话的 KV）。
3. 为什么允许段内多单却不允许跨段拼接？（下单即绑定物理地址；跨段拼接意味着已经跑起来的 kernel 地址要变）。
4. 会话释放时怎么避免立刻又碎掉？（LIFO 归还 + 合并相邻空闲段；或给会话打代际标签，同代际尽量同段）。
5. 多模型/多精度混部时 `bps` 不是常数怎么办？（按 (模型, 量化位宽) 分池，每池独立 free list —— 否则碎片率会被跨池复用伪装成「够用」）。"""

    return base(
        'algorithms', 'senior',
        '分页 KV Cache 的连续块分配：空闲块数不等于可服务会话数',
        statement, 'java-junit',
        ['memory-fragmentation', 'llm-inference', 'kv-cache', 'greedy-scan', 'modern:inference-gateway'],
        src('DeepSeek', '推理引擎 / 显存调度 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#32,#46（原文讲 PagedAttention 与 KV 淘汰，但未把「连续性 × 碎片」做成可判分点）'),
        language='java',
        cases=[
            {'name': '外部碎片：6 个空闲块但无一段够 3 连续，答案是 0',
             'input': [[0, 0, 1, 0, 0, 1, 0, 0], 3], 'expected': 0,
             'note': 'freeCount/bps = 6/3 = 2 的朴素算法在这里翻车'},
            {'name': '单段内可连续下多个单', 'input': [[0, 0, 0, 0, 0, 0, 1], 2], 'expected': 3,
             'note': '长度 6 的空闲段、每会话 2 块 → 3 个单'},
            {'name': '混合：一段够用一段凑不满', 'input': [[0, 0, 1, 0, 0, 0, 1, 0], 3], 'expected': 1,
             'note': '段长 2（浪费）+ 段长 3（下单）+ 段长 1（浪费）'},
            {'name': '全部空闲', 'input': [[0, 0, 0, 0, 0], 2], 'expected': 2, 'note': '末尾 1 块浪费'},
            {'name': '退化：一个空闲块都没有', 'input': [[1, 1, 1], 1], 'expected': 0},
            {'name': '退化：空位图', 'input': [[], 4], 'expected': 0, 'note': '空输入不得抛异常'},
            {'name': 'blocksPerSession 为 1 时每块各成一单', 'input': [[0, 1, 0, 0], 1], 'expected': 3},
            {'name': '脏位图值必须显式失败', 'input': [[0, 2, 0], 1], 'expected': None,
             'expectThrow': 'IllegalArgumentException', 'note': '宽容处理会把脏数据读成可用容量'},
        ],
        runner={'className': 'Solution',
                'signature': 'int maxServableSessions(int[] blockFree, int blocksPerSession)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=18,
        answer=answer,
    )


# ------------------------------------------------------------------ alg-java-0023
@draft('alg-java-0023')
def q_continuous_batching():
    statement = """## 背景

你在写连续批处理（continuous batching）的准入控制。显存里有一批**正在跑的请求**，
每个还需要 `runningRemaining[i]` 个 KV 槽位才能跑完；等待队列里有 `waitingPrompts[j]` 个
新请求各自的 prompt 长度（新请求进来至少要先占下自己 prompt 那么大的 KV）。

**正在跑的请求不能被抢占**——它们的 `runningRemaining` 之和是硬占用，必须先从预算里扣掉。
剩下的空间里，你要让**新进来的请求数最多**。

## 关键约束

新请求的 KV 一旦分配就整段占到自己结束，所以「让进来的数量最多」= 对 waiting 按 prompt
长度**升序**排序后尽量塞满剩余预算。

按到达顺序（FIFO）塞是错的，而且错得很典型：

```
running=[0]  waiting=[4,3,3]  budget=6
FIFO：先试 4，剩 2 塞不下 3 就停 → 进 1 个
升序：3+3=6 → 进 2 个
```

线上表现是「显存明明还有余量，吞吐却上不去」，因为一个大 prompt 堵住了后面所有小请求。

## 你要实现的入口

```java
public static int admitWaiting(int[] runningRemaining, int[] waitingPrompts, int kvBudget)
```

- 返回值：最多能准入多少个新请求；
- `runningRemaining` 之和已经 `>= kvBudget` 时返回 `0`（没有新请求能进，但**不许抛异常**——
  这是稳态，不是错误，推理集群大部分时间都处于这个状态）；
- 数组为空一律合法，返回 `0`。

## 约定

1. 任何元素 `< 0`（含 `kvBudget`）都是脏数据，抛 `IllegalArgumentException`。
2. **求和必须在 `long` 域做**：`runningRemaining` 里两个接近 `Integer.MAX_VALUE` 的值在 `int`
   域相加会溢出成负数，于是"剩余预算"变成天文正数，准入控制形同虚设、直接 OOM。
3. 允许对 `waitingPrompts` 排序（可以复制后排序，不许改动调用方传入的数组内容）。

## 复杂度要求

`O(W log W)` 时间（W = waitingPrompts 长度）；`O(W)` 额外空间上限（排序副本）。"""

    reference = """import java.util.Arrays;

public class Solution {
  public static int admitWaiting(int[] runningRemaining, int[] waitingPrompts, int kvBudget) {
    if (kvBudget < 0) throw new IllegalArgumentException("negative budget");
    long used = 0L;
    for (int r : runningRemaining) {
      if (r < 0) throw new IllegalArgumentException("negative remaining");
      used += r;                       // long 域累加：两个 Integer.MAX_VALUE 相加也不会回绕
    }
    if (used >= kvBudget) return 0;    // 稳态而非错误：不许抛
    long left = kvBudget - used;

    int[] sorted = waitingPrompts.clone();
    for (int w : sorted) {
      if (w < 0) throw new IllegalArgumentException("negative prompt length");
    }
    Arrays.sort(sorted);               // 升序：让进来的数量最多

    int admitted = 0;
    for (int w : sorted) {
      if (w <= left) {                 // 贴边允许：恰好等于剩余预算就该进
        left -= w;
        admitted++;
      } else {
        break;                         // 已升序，后面只会更大
      }
    }
    return admitted;
  }
}"""

    naive = """public class Solution {
  // 生产里最常见的版本：按到达顺序塞、塞不下就停，且用 int 累加
  public static int admitWaiting(int[] runningRemaining, int[] waitingPrompts, int kvBudget) {
    int used = 0;
    for (int r : runningRemaining) used += r;
    if (used >= kvBudget) return 0;
    int left = kvBudget - used;
    int admitted = 0;
    for (int w : waitingPrompts) {
      if (w <= left) {
        left -= w;
        admitted++;
      } else {
        break;                         // 没排序就 break：会被一个大 prompt 截断
      }
    }
    return admitted;
  }
}"""

    answer = """**思路**：先扣硬占用 `Σ runningRemaining`，剩余预算 `left`；对 waiting **升序排序**后依次塞，
遇到第一个塞不下的就 `break`（升序意味着后面只会更大）。`O(W log W)`。

**为什么排序而不是 FIFO**：目标是"准入数量最多"，这是分数背包在"每件物品价值=1"时的特例，
贪心取最小者即最优；FIFO 会被一个大 prompt 堵住全部小请求。用例 `[9,1,1,1] / budget=4`：
FIFO 进 0 个，升序进 3 个。

**为什么求和必须用 `long`**：`runningRemaining` 里两个接近 `Integer.MAX_VALUE` 的值在 `int` 域
相加回绕成负，`left = budget − (负数)` 变成天文正数 → 全部准入 → 显存 OOM，
而且 OOM 发生在几百毫秒之后，跟准入决策在日志上已经断链。用例 G 就是杀这个的。

**`used >= budget` 为什么返回 0 而不是抛错**：推理集群绝大多数时刻都是满的，把它当错误会让
监控全是噪声、调用方也没法处理。区分"没有空间"（正常）与"数据是脏的"（异常）是契约设计的关键。

**工程延伸（面试追问点）**：
1. 真实引擎里新请求还要预留**生成阶段**的增长空间，`w` 不该只是 prompt 长度。怎么改？（按 `prompt + expectedOutput × 平均增量` 估，或用历史分位数；估小了会中途 OOM，估大了会欠载）。
2. 只按"数量最多"准入合理吗？（不合理：会把长 SLO 请求永远饿死。要加优先级 aging，或按"单位 KV 的边际吞吐"排序）。
3. 排序开销在热路径上能接受吗？（W 通常几十到几百，可接受；更大时用计数排序/部分排序 `quickselect` 只要前 k 小）。
4. 多租户下这个准入函数怎么扩展？（每租户一条 quota 线，准入需同时满足全局 left 与租户 quota；否则一个租户的大批量会吃掉全部空间）。
5. 准入后请求跑不完（实际生成比预估长）怎么办？（预留水位 + 抢占最晚到达者；抢占要把它的 KV 落盘或丢弃重算，DeepSeek/月之暗面这类长上下文场景里成本很高）。"""

    return base(
        'algorithms', 'senior',
        '连续批处理准入：先扣硬占用，再按最短 prompt 优先塞满剩余 KV',
        statement, 'java-junit',
        ['llm-inference', 'greedy-scheduling', 'overflow-contract', 'backpressure', 'modern:inference-gateway'],
        src('DeepSeek', '推理引擎 / 调度 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#36（原文讲静态 vs 连续批处理的概念，未给出可判分的准入语义）'),
        language='java',
        cases=[
            {'name': '正常：扣掉硬占用后按升序塞进 2 个', 'input': [[100, 200], [50, 60, 5000], 1000],
             'expected': 2, 'note': 'left=700，50+60=110 可进，5000 进不去'},
            {'name': 'running 吃满预算：返回 0 且不抛异常', 'input': [[600, 600], [1, 2, 3], 1000],
             'expected': 0, 'note': '这是稳态不是错误'},
            {'name': '大 prompt 塞不下时小 prompt 仍须继续尝试', 'input': [[0], [9, 1, 1, 1], 4],
             'expected': 3, 'note': '升序后 9 排在最后，1+1+1=3 ≤ 4 全进；"遇到塞不下就停"的实现得 0'},
            {'name': '到达顺序与升序的差：waiting=[4,3,3] 预算 6', 'input': [[0], [4, 3, 3], 6],
             'expected': 2, 'note': '升序 3+3=6 进 2 个；FIFO 先试 4、剩 2 塞不下 3 就停 → 只进 1 个'},
            {'name': 'int 累加溢出：三个 1e9 在 int 域回绕成负',
             'input': [[1000000000, 1000000000, 1000000000], [1], 1500000000], 'expected': 0,
             'note': '真值 used=3e9 > 1.5e9 应返回 0；int 回绕成 -1.29e9 → 误判预算充足 → 准入并 OOM'},
            {'name': '贴边：剩余预算恰好等于一个 prompt', 'input': [[900], [100], 1000], 'expected': 1},
            {'name': '零长度退化：waiting 为空', 'input': [[10], [], 100], 'expected': 0},
        ],
        runner={'className': 'Solution',
                'signature': 'int admitWaiting(int[] runningRemaining, int[] waitingPrompts, int kvBudget)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# ------------------------------------------------------------ sys / agent / hot（主观题）
@draft('sys-deepseek-pd-disagg')
def q_pd_disaggregation():
    statement = """## 场景

你在负责一个日均 20 亿次调用的大模型推理集群，模型是 600B 级 MoE、上下文常见 32K、
线上同时跑**对话**（TTFT 敏感，P99 要求 < 1.5s）与**批量离线生成**（吞吐敏感，延迟不敏感）。

当前是 colocated 部署：prefill 与 decode 在同一批 GPU 上，用 chunked prefill 混跑。
监控显示两个症状同时恶化：

- 对话请求的 TTFT P99 从 1.2s 涨到 4.8s；
- 集群整体吞吐（token/s per GPU）只涨了 6%，远达不到业务方预期的"加机器就线性扩"。

业务方给了两个选项让你拍板：**A. 全面改 PD 分离**（prefill 与 decode 各占独立 GPU 池，
中间用高速网络传 KV）；**B. 继续 colocated，只加机器 + 调 chunk 大小**。

## 请回答

1. 你选哪个？给出**判断依据**而不是立场 —— 什么信号出现时 A 对、什么信号出现时 B 对。
2. 如果选 A：KV 传输会成为新瓶颈。请**定量**估算一次 32K 上下文的 KV 有多大、
   走什么网络能不被传输拖死，说清你的算法。
3. 如果选 A：池间容量配比怎么定？随流量结构变化怎么调？
4. 两种方案各自的**故障模式**是什么（选 A 之后新出现的、B 下就有的），以及怎么提前发现。"""

    answer = """## 参考答案要点

**1. 选型判据（考的是"用信号决策"而不是背概念）**

PD 分离的收益本质来自一件事：**prefill 是算力密集（compute-bound）、decode 是带宽密集（memory-bound），
两者混跑时互相拖累** —— 一个长 prefill 会把同批 decode step 拖慢（TTFT 抖动的直接来源），
而 decode 的低算术强度又让 SM 利用率在上一个 prefill 到来前空转。

- 该选 **A** 的信号：TTFT 与 TPOT 的**相关性高**（说明互相阻塞）；prefill token 数方差大（长文档混短对话）；
  有明确的 SLO 分层（对话/批量混跑）；单池 GPU 利用率已经高但吞吐不再涨。
- 该选 **B** 的信号：请求长度分布很窄（没有大 prefill 拖尾）；集群规模小（分离后两池各自主张
  并行度，小池子会因为无法整除 TP 度数而浪费）；**网络不具备 RDMA/高带宽条件** —— 这一条常常是否决项；
  或者瓶颈其实在调度/显存碎片而非 prefill-decode 互相阻塞（此时分离不解决问题，只是把瓶颈搬了个家）。

关键：**先证明"互相阻塞"确实是当前瓶颈**，再谈分离。判据是看 decode step 时间的分布是否被
prefill 批次大小显著解释（把 chunked prefill 的 token 预算调到 0 再测一次 TTFT/TPOT，
若立刻改善，则阻塞假设成立）。跳过这一步直接上分离，是这类项目最常见的失败方式。

**2. KV 传输量的定量估算（考"能不能现场算数量级"）**

算法：`KV 字节 ≈ 2(K 与 V) × 层数 × KV head 数 × head 维度 × 序列长度 × 字节数`。
以 600B 级 MoE 常见的 GQA 配置为例（61 层、KV head 8、head dim 128、FP16）：

- 每 token 每层 K+V = 2 × 8 × 128 × 2B = 4096 B = 4KB
- 每 token 全层 = 4KB × 61 ≈ **244KB**
- 32K 上下文 ≈ 244KB × 32768 ≈ **8GB**

8GB 走什么网络：25GbE（≈3GB/s）要 2.7s —— 比省下的排队时间还多，**方案直接不成立**；
100GbE 单向 ≈12GB/s → 0.67s，勉强；**400Gb/s 级 RoCE/IB** ≈ 50GB/s → 0.16s，可接受。
所以"PD 分离能不能上"的第一道硬门槛是**网络代际**，不是调度器写得多好。

加分点：① MLA 这类低秩 KV 压缩能把上面的 244KB/token 显著压低（DeepSeek-V2/V3 的路线），
传输可行性直接受益 —— 说明"模型结构选择"与"系统架构选择"不是独立决策；
② 分层传输（先传 prompt 前缀的块、边算边传）与复用已有 prefix cache 可以只传增量；
③ 若两阶段在同一台机器的不同 GPU 上，走 NVLink 比走网络低一个数量级，这是"同机分离"
比"跨机分离"容易落地的根本原因。

**3. 池间配比**

配比由 `prefill 算力需求 : decode 带宽需求` 决定，而这个比例**随流量结构漂移**
（产品上线一个长文档功能，prefill 侧需求可能一夜翻倍）。所以：
- 冷启动用离线回放压测标定"每万 QPS 对话流量需要多少 prefill 卡 / 多少 decode 卡"；
- 在线用两池队列长度做反馈（prefill 队列堆积 → 从 decode 池借卡），**但借用单位必须是
  可整除的最小并行度**（TP 度数），否则借来的卡跑不了这个模型；
- 设冷却窗口与最小保有量，避免震荡；批量离线任务是最好的"缓冲垫"——它可以被随时挤压来吸收波动。

**4. 故障模式对比**

| | colocated（B） | PD 分离（A）新增 |
| --- | --- | --- |
| 典型故障 | 一个大 prefill 拖垮全批 TTFT；chunk 大小两难 | KV 传输失败/超时 → 请求半路死；两池配比失衡 → 一侧空转一侧排队 |
| 隐蔽性 | 症状直接（TTFT 抖） | **跨池故障难归因**：prefill 成功、decode 收到坏 KV 块，表现为输出乱码而非报错 |
| 提前发现 | 按 prompt 长度分桶看 TTFT/TPOT；decode step 时间分布 | 给 KV 传输加**校验和与序号**；单独埋点"传输耗时/传输失败率/池间队列"；混沌测试注入传输超时 |

A 引入的最难查的一类问题：**部分失败**。prefill 池算完、传输中断、decode 池已占资源等待，
请求既不成功也不失败地挂着。必须有端到端的租约/超时收敛机制，而不是靠两侧各自超时。

**评分时最看重**：是否先验证瓶颈假设（而不是直接给立场）、KV 大小能否算对量级、
是否点出"网络代际是否决项"、是否说清 A 的新故障模式。"""

    return base(
        'system-design', 'principal',
        '对话与批量混跑的推理集群：PD 分离还是加机器',
        statement, 'llm-rubric',
        ['llm-inference', 'gpu-scheduling', 'capacity-planning', 'quantitative-reasoning', 'modern:pd-disaggregation'],
        src('DeepSeek', '推理平台 技术专家 / Principal',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#36,#37,#83（原文只讲静态 vs 连续批处理与网关分层，未覆盖 PD 分离这一 2025-2026 主线）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '瓶颈假设验证', 'weight': 3,
             'criteria': '是否先给出"如何证明 prefill/decode 互相阻塞是当前瓶颈"的可执行判据（如把 chunked prefill 预算调 0 复测），而不是直接选边'},
            {'label': '选型判据完整', 'weight': 2,
             'criteria': '是否分别给出该选 A 与该选 B 的信号，且包含"网络不具备条件则方案不成立"这类否决项'},
            {'label': 'KV 量级估算', 'weight': 3,
             'criteria': '是否写出 KV 字节数公式并算到 32K 上下文 GB 量级，再换算到具体网络带宽下的耗时；数量级正确即可，配置假设合理即可'},
            {'label': '配比与弹性', 'weight': 1,
             'criteria': '是否说明池间比例随流量结构漂移、借用粒度受并行度整除约束'},
            {'label': '新故障模式与可观测', 'weight': 1,
             'criteria': '是否点出跨池部分失败这一 A 特有的难查问题及其观测手段'}
        ], 'notes': '量化部分只看数量级与算法，不要求精确到小数；若只背概念、无任何数字，第 3 项按 0 分。'},
        estimatedMinutes=30,
        answer=answer,
    )


@draft('ag-deepseek-tool-idem')
def q_tool_idempotency():
    statement = """## 场景

你负责一个 Agent 平台的工具执行层。Agent 会调用外部工具：查订单、退款、发消息、执行 SQL。
平台承诺"至少一次"投递，也就是**工具可能被重复调用**。

上线两周后出了一次事故：模型在第 7 轮反思时重新规划，把已经执行成功的"退款"工具
**又调了一遍**，参数完全相同。用户收到两笔退款。更糟的是复盘时发现：
平台无法回答"这个工具调用到底执行过几次"。

## 请回答

1. 重复调用的根因分层看有哪些层？（不要只答"模型幻觉"）
2. 你会怎么设计幂等？请区分**读工具**与**写工具**，并说明幂等键从哪来 ——
   为什么"用参数哈希当幂等键"在生产上会出事？
3. 幂等做对了之后，"至少一次"还剩下什么问题？（提示：结果未知窗口）
4. 怎么让平台能回答"这次调用执行过几次"？给出需要落的数据与查询路径。
5. 有哪些工具**本质上无法幂等**，平台应该怎么处理它们？"""

    answer = """## 参考答案要点

**1. 根因分层（考"会不会只归咎模型"）**

- **模型层**：反思/重规划时不记得已执行过（上下文被截断，工具结果没进历史）；温度导致同一步重新生成。
- **框架层**：Agent 循环的最大轮数保护只防死循环、不防"重复副作用"；状态机没有把"已执行"作为一等状态。
- **传输层**：HTTP 超时后客户端重试，但服务端其实已经执行成功 —— 超时 ≠ 失败，这是"至少一次"最常见的来源。
- **执行层**：工具集群重启/任务重放；消息队列的 at-least-once 语义。
- **人工层**：运维看到失败告警手动重跑。

只答"模型幻觉"是本题最典型的失分点：事故里真正造成重复扣款的是**传输层的超时重试**，
模型只是触发了第二次调用。

**2. 幂等设计与幂等键**

- **读工具**：天然幂等，但要注意"重复执行浪费配额"，可用短 TTL 结果缓存。
- **写工具**：必须显式幂等 —— 服务端存 `idempotencyKey → (结果, 状态)`，
  命中且已完成则**直接返回首次结果**（不是返回"重复请求"错误）。

**幂等键不能只取参数哈希**，三个真实原因：
1. **合法重试与误重放无法区分**：用户确实想再退一笔 100 元，参数完全一样，参数哈希会把它吞掉。
   幂等键必须包含**意图来源**（哪次会话、哪一轮、哪个用户动作），而不是只有内容。
2. **非确定性参数**：模型每轮重新生成时 `now()`、随机 trace id、字典序不同的 JSON 都会改变哈希，
   导致"该幂等的没幂等"。所以键要在**规范化之后**生成，且不含时间戳类字段。
3. **键冲突的破坏性**：参数哈希相同但业务语义不同的两笔操作会被误合并 ——
   在金融场景这是比重复执行更严重的问题（丢单）。

正确做法：**上层生成、透传、服务端只认它**。键由 Agent 框架在"决定调用"那一刻生成
（session + step + tool + 规范化参数的摘要），重试时复用同一个键，重规划时生成新键。

**3. "至少一次"剩下的问题：结果未知窗口**

请求发出、超时、没拿到响应 —— 此时**不知道有没有执行成功**。幂等键能保证"重试不会重复扣款"，
但回答不了"该不该告诉用户成功"。需要：
- **对账/查询接口**：工具侧提供"按幂等键查最终状态"的能力（这是平台对工具接入方的硬性要求）；
- **状态机显式建模 `unknown`**：不能把 unknown 当 failed 重试，也不能当 success 返回；
- **收敛策略**：指数退避查询 + 超时后转人工/转异步通知，并把 unknown 率作为 SLO 指标。

**4. 可回答"执行过几次"**

必须落的最小数据集：`(idempotencyKey, tool, attemptNo, traceId, startedAt, finishedAt, status, responseDigest, callerSession, callerStep)`。
- 每次真实执行写一条 attempt 记录（**不是只更新一行状态**，否则"几次"就查不出来了）；
- 查询路径：按 `idempotencyKey` 聚合 → 得到"收到 N 次调用、真实执行 M 次、幂等命中 N−M 次"；
- 关键指标：**幂等命中率**（异常升高说明上游在疯狂重试）、**unknown 率**、**重复执行率必须恒为 0**
  （不为 0 就是事故，不是指标）。

**5. 本质上无法幂等的工具**

发微信消息、调用第三方支付、发邮件、操作物理设备、调用一个没有幂等键支持的旧接口。
处理办法（按优先级）：
1. **改造成两段式**：先"预占/申请"（幂等）再"确认提交"（可能不幂等但可人工核对）；
2. **前置去重**：在平台侧记录"该键已发起"，宁可拒绝也不冒险重复；
3. **补偿事务**：接受可能重复，提供可执行的撤销路径（发消息可以补一条更正）；
4. **人工闸门**：不可幂等 + 高价值操作 → 强制人审，Agent 无权自动执行。

**评分最看重**：根因是否分层（不甩锅模型）、幂等键为什么不能用参数哈希（三个理由至少两个）、
是否识别出 unknown 窗口这个真正的难点、对不可幂等工具是否给出分级策略而非一句"禁止"。"""

    return base(
        'agent-design', 'senior',
        'Agent 工具调用的重复执行：幂等键、结果未知窗口与不可幂等工具',
        statement, 'llm-rubric',
        ['agent-tool-calling', 'idempotency', 'distributed-systems', 'failure-modeling', 'modern:agent-platform'],
        src('DeepSeek', 'Agent 平台 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#67,#68,#69（原文讲工具调用流程与死循环，未触及副作用幂等这一平台级难点）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '根因分层', 'weight': 2,
             'criteria': '至少区分模型层/框架层/传输层/执行层，并指出超时重试是"至少一次"的主要来源；只归因模型幻觉则本项低分'},
            {'label': '幂等键设计', 'weight': 3,
             'criteria': '说清参数哈希做键为什么不够（合法重复 vs 误重放不可分、非确定性参数、冲突丢单），并给出"上层生成并透传"的方案'},
            {'label': '结果未知窗口', 'weight': 2,
             'criteria': '识别 unknown 状态既非成功也非失败，需要按幂等键查最终状态的对账能力与收敛策略'},
            {'label': '可观测与可审计', 'weight': 1,
             'criteria': '给出每次尝试一条记录的数据模型，以及幂等命中率/unknown 率/重复执行率等指标'},
            {'label': '不可幂等工具的分级处置', 'weight': 2,
             'criteria': '给出两段式、前置去重、补偿、人工闸门等分层手段，而非简单禁止'}
        ], 'notes': '若通篇只谈"加重试/加锁"而未触及幂等键来源，第 2 项按 0-1 分。'},
        estimatedMinutes=25,
        answer=answer,
    )


@draft('hot-deepseek-ttft')
def q_ttft_regression():
    statement = """## 场景

线上推理服务今早 09:40 起，**TTFT P99 从 1.1s 涨到 6.3s**，TPOT 与错误率基本正常，
GPU 利用率反而**下降**了 8 个点。09:35 刚发布过一次版本（改动：把 prefix cache 的
淘汰策略从 LRU 换成 LRU-T，并把 block 大小从 16 改成 64）。

值班同学已经做的三件事：重启了两个实例（无效）、把流量从 A 机房切到 B 机房（无效）、
扩容了 20% 的 GPU（**TTFT 略降到 5.9s，几乎没用**）。

## 请回答

1. 给出你的排查顺序，并说明**每一步会看到什么证据才继续往下走**。
2. "GPU 利用率下降 + TTFT 变差 + TPOT 正常"这个组合，最可能指向哪一类根因？
   请解释这个组合为什么排除了另外几类常见原因。
3. 扩容几乎无效，说明了什么？
4. 你会不会先回滚？给出决策依据。
5. 定位到根因后，怎么防止同类问题再次发生（不是"加监控"这种笼统话）。"""

    answer = """## 参考答案要点

**1. 排查顺序（考"有序且每步可证伪"，不是列工具清单）**

第 0 步：**先确认指标本身可信**。TTFT 是在哪打的点？发布有没有改动埋点口径
（比如把"排队时间"从 TTFT 里挪出去了）？—— 一半的"性能回归"死在这一步，
因为新版本改了统计口径。**证据**：同一批请求的原始 trace 时间戳手算一遍 TTFT。

第 1 步：**按维度切片，找不平均的那一维**。按 模型版本 / prompt 长度分桶 / 是否命中 prefix cache /
实例 / 机房 / 租户 逐个切。**关键信号**：如果只有"命中 prefix cache 的请求"变慢，
就直接指向那次淘汰策略 + block 大小的改动。

第 2 步：**区分"排队慢"还是"算得慢"**。看队列等待时间与首 token 计算时间的分离埋点。
TPOT 正常 → 每个 decode step 不快不慢 → 若排队时间暴涨而计算时间不变，
说明是**准入/调度**问题而非 kernel 问题。

第 3 步：**看 prefix cache 命中率曲线**（09:35 前后）。命中率断崖 = 强证据。
block 16→64 会让短前缀匹配率显著下降（对齐粒度变粗，公共前缀不足一个 block 就完全用不上）。

第 4 步：**看显存碎片与分配失败率**。block 变大 4 倍 → 同样会话数需要的连续块更长 →
碎片率上升 → 准入被拒 → 请求在队列里等 → TTFT 涨。这与"利用率下降"完全自洽。

第 5 步：若以上都不成立，才去看网络/存储/硬件（重启与切机房无效已经基本排除了单机与单机房问题）。

**2. 这个组合最可能指向什么**

**准入/调度被卡住**（请求在排队，不在算），而不是算力不足。机制：
prefix cache 命中率下降 + 大块分配失败 → 每请求实际占用 KV 变多 → 可并发会话数下降 →
队列变长（TTFT↑）；同时 GPU 因为批太小而空转（利用率↓）；一旦开始解码，
每 step 的计算量没变（TPOT 正常）。

这个组合能排除的几类：
- **算力/带宽瓶颈**：那会同时拖慢 TPOT，且利用率通常是升不是降。
- **模型变重（层数/精度变化）**：TPOT 一定变。
- **网络到下游**：错误率会动，且切机房通常有效。
- **单实例故障**：重启/摘流量会立刻见效，而它无效 → 是**全局配置/版本**问题。
- **流量激增**：QPS 没涨（题目给定），且激增会让利用率上升。

**3. 扩容几乎无效说明什么**

新增实例跑的是**同一个新版本**，所以新实例同样命中 prefix cache 失效 + 大块分配问题 ——
扩容只是把同样的病复制到更多卡上。这是关键判据：**如果扩容无效，问题在软件版本或全局依赖，
不在容量**。反过来说，如果扩容有效，才说明真是容量问题。

（另一个可能：瓶颈在一个共享组件——比如集中式的 KV 存储或调度器，加 GPU 不会缓解。
所以严格说，"扩容无效"排除了"单池算力不足"，但没排除"共享层瓶颈"。）

**4. 回滚决策**

会先回滚。依据：
- 有明确的变更时间线（09:35 发布、09:40 恶化），且**变更内容与症状机制自洽**；
- 影响面是 P99 劣化（不是错误），有 5 分钟缓冲，但已经用了 3 个无效手段，
  继续排查的边际价值低于"先止血再定位"；
- 回滚是**可逆**操作，风险低于在生产上试新方案；
- 唯一要先做的准备：确认回滚不会造成**数据不兼容**（block 大小变更如果影响持久化的
  prefix cache 索引，回滚要先清缓存，否则回滚后会读到错数据 —— 这是本题的隐藏考点）。

不回滚的合理情形：变更里含不可逆的 schema/权重迁移，或症状只影响极小流量且已在定位中。

**5. 防复发（要具体）**

- **发布必须带"性能门禁"**：新版本在影子流量上跑，TTFT P99 / prefix cache 命中率 /
  大块分配失败率 三项与基线对比超阈值就阻断发布 —— 而不是靠人看曲线。
- **cache 相关参数变更要单独灰度**：block 大小这类"影响全局共享状态"的参数，
  一旦错了会让所有实例同时变慢，灰度粒度必须是"按流量百分比"而不是"按实例"。
- **把 TTFT 拆成排队时间与计算时间两个指标分别告警**：合在一起就看不出这次是排队问题。
- **建立"命中率"作为一级 SLO**：它领先于 TTFT，能在劣化早期报警。
- **回滚预案要预演**：特别是"回滚前需要清哪些缓存/重建哪些索引"，写进变更单而不是临场想。

**评分最看重**：第 0 步是否怀疑指标口径、能否用"TPOT 正常 + 利用率下降"反推出
排队/准入瓶颈、能否解释扩容为什么无效、回滚前是否考虑数据兼容性、防复发是否具体到门禁指标。"""

    return base(
        'hot-interviews', 'senior',
        'TTFT P99 暴涨但 TPOT 正常：一次线上推理性能回归的排查',
        statement, 'llm-rubric',
        ['incident-response', 'llm-inference', 'observability', 'root-cause-analysis', 'modern:inference-gateway'],
        src('DeepSeek', '推理服务 SRE / 后端 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#93（原文只给"看流量→看利用率→看显存"的清单，无判据、无组合推理，本题把它做成可评分的排障题）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '怀疑指标口径', 'weight': 1,
             'criteria': '是否先验证 TTFT 埋点口径未被发布改动，再展开排查'},
            {'label': '切片定位方法', 'weight': 2,
             'criteria': '是否给出按维度切片找"不平均那一维"的具体维度（cache 命中/长度分桶/版本）'},
            {'label': '组合推理', 'weight': 3,
             'criteria': '能否由"TPOT 正常 + 利用率下降 + TTFT 涨"推出排队/准入瓶颈，并说明它排除了哪几类原因'},
            {'label': '扩容无效的解读', 'weight': 2,
             'criteria': '是否解释"同版本扩容只是复制问题"，并指出它排除了容量瓶颈但未排除共享层瓶颈'},
            {'label': '回滚决策与风险', 'weight': 1,
             'criteria': '是否给出可逆性/时间线自洽的决策依据，并点出 block 大小变更回滚需先清缓存'},
            {'label': '防复发具体度', 'weight': 1,
             'criteria': '是否给出可阻断发布的具体门禁指标，而非"加监控"'}
        ], 'notes': '只罗列工具/命令而无判据链的，第 3 项按 0 分。'},
        estimatedMinutes=25,
        answer=answer,
    )


# =============================================================== 第二批（DeepSeek batch 2）
# 第一批把流水线跑通了；这一批刻意不再全压在 algorithms 上（2 道 java-junit + 1 道 mysql），
# 并把三个判分点都放在"面经只讲了概念、没做成可判分要求"的地方。


@draft('alg-deepseek-prefix-cache')
def q_prefix_cache():
    statement = """## 背景

多轮对话与 Agent 流量里，成千上万条请求共享同一段 system prompt / 工具描述。推理引擎用
**prefix caching（前缀缓存）** 省掉重复 prefill：KV 按固定大小的 block 存放，**一个 block 写满才
进缓存池**，key 是「从第 0 个 token 起、到这一块为止的整条前缀链」，而不是这一块的内容。

现在给你一批按到达顺序**串行**执行的请求，算这一批总共要真的跑多少 token 的 prefill。

## 规则（照这些算，不要照你脑子里的"近似版"）

- `prompts[i]` 是第 i 个请求的 token 序列，`blockSize` 是每个 block 的 token 数；缓存初始为空。
- 每个请求处理完，把它自己的**所有完整块**写入缓存（尾块不满一块，不写）。
- 一个请求可复用的长度 = 从第 0 块起**连续命中**的整块数 × `blockSize`（中途断一次就不再往后认）。
- 该请求的成本 = `prompt 长度 − 可复用长度`；尾块的零头永远要重算。
- 返回所有请求的成本之和。

## 这题真正考的东西

三步就能错：

1. **拿最长公共前缀当可复用长度**，不做块对齐：`blockSize=4` 时长度 3 的 prompt 一个整块都凑不出，
   可复用是 0、成本是 3 —— 不是 0。
2. **用"块内容集合"判命中**：块 `[5,6,7,8]` 在第 2 个位置出现过（前面是 `[1,2,3,4]`），
   不代表它作为第 1 个位置时也算命中 —— 链式 key 存在的意义就是禁止这种跨位置串味。
3. **把不完整的尾块也当已缓存**：下个请求的前缀正好落在这半块里，看着省了 token，
   实际显存里根本没有这份 KV，真跑起来就是 cache miss。

## 你要实现的入口

```java
public static int prefillCost(int[][] prompts, int blockSize)
```

- 返回值：这一批需要真正计算（无法复用）的 token 总数；
- `prompts` 为空数组时返回 `0`，**不抛异常**（空批次是网关的常态）；
- `blockSize <= 0`、`prompts[i]` 为 `null`、token 为负数 —— 抛 `IllegalArgumentException`。
  负 token id 说明上游 tokenizer 或哈希被写坏了，宽容处理会把它算成一次正常命中，
  把"缓存里凭空多出一块"这种问题留到线上去。

## 复杂度要求

`O(总 token 数)` 时间：`n` 条请求时**不许**两两比较前缀（`O(n² · len)` 在千级并发下会先把网关打死）。"""

    reference = """import java.util.HashSet;
import java.util.Set;

public class Solution {
  public static int prefillCost(int[][] prompts, int blockSize) {
    if (blockSize <= 0) throw new IllegalArgumentException("bad block size");
    Set<String> cached = new HashSet<>();   // key = 整条前缀链，不是单块内容
    int total = 0;
    for (int[] prompt : prompts) {
      if (prompt == null) throw new IllegalArgumentException("null prompt");
      for (int token : prompt) {
        if (token < 0) throw new IllegalArgumentException("dirty token id: " + token);
      }
      int fullBlocks = prompt.length / blockSize;   // 尾块直接丢掉：不满一块不进缓存
      StringBuilder chain = new StringBuilder();
      int reuseBlocks = 0;
      for (int b = 0; b < fullBlocks; b++) {
        appendBlock(chain, prompt, b, blockSize);
        if (cached.contains(chain.toString())) {
          reuseBlocks = b + 1;          // 只有从头连续命中才算复用
        } else {
          break;                        // 断了不能跳过再接着认：KV 是逐层依赖前缀的
        }
      }
      total += prompt.length - reuseBlocks * blockSize;
      StringBuilder write = new StringBuilder();
      for (int b = 0; b < fullBlocks; b++) {
        appendBlock(write, prompt, b, blockSize);
        cached.add(write.toString());   // 无论命没命中，算过的块都落进缓存
      }
    }
    return total;
  }

  private static void appendBlock(StringBuilder chain, int[] prompt, int blockIndex, int blockSize) {
    for (int i = blockIndex * blockSize; i < (blockIndex + 1) * blockSize; i++) {
      chain.append(prompt[i]).append(',');   // 每个 token 后都加分隔符，"1,2," 不会和 "12," 撞
    }
  }
}"""

    naive = """public class Solution {
  // 常见错法：把"和之前某条请求的最长公共前缀"当成可复用长度
  // —— 既不做块对齐，也不看这块是否真的写满过、落在第几个位置
  public static int prefillCost(int[][] prompts, int blockSize) {
    if (blockSize <= 0) throw new IllegalArgumentException("bad block size");
    for (int[] prompt : prompts) {
      if (prompt == null) throw new IllegalArgumentException("null prompt");
      for (int token : prompt) {
        if (token < 0) throw new IllegalArgumentException("dirty token id: " + token);
      }
    }
    int total = 0;
    for (int i = 0; i < prompts.length; i++) {
      int best = 0;
      for (int j = 0; j < i; j++) {
        best = Math.max(best, commonPrefix(prompts[j], prompts[i]));
      }
      total += prompts[i].length - best;
    }
    return total;
  }

  private static int commonPrefix(int[] a, int[] b) {
    int n = Math.min(a.length, b.length);
    int i = 0;
    while (i < n && a[i] == b[i]) i++;
    return i;
  }
}"""

    answer = """**思路**：把缓存建成「前缀链 → 是否存在」的集合。逐块走链式 key（第 b 块的 key = 前 b+1 块的
全部 token），从头连续查，遇到第一次 miss 就停；请求处理完把自己**所有完整块**的链 key 写回集合。
`O(总 token)` 时间、`O(缓存块数)` 空间。

**三个判分点各自对应什么真实事故**：
1. 块对齐：长度 3、`blockSize=4` 时复用 0。按 LCP 算会把"省 3 个 token"写进监控，
   而引擎实际一次都没命中 —— 命中率指标从此不可信。用例「零头不落盘」与「长尾不齐」各打一处。
2. 链式 key：块内容 `[5,6,7,8]` 在位置 2 出现过，不等于在位置 1 可复用。
   用例「块内容相同但位置不同不算命中」专打"块内容集合"式实现（LCP 式朴素解在这条上反而对，
   所以两种错法都得留用例）。这也是 vLLM/SGLang 用 `hash(prefix_blocks + block_content)`
   而不是 `hash(block_content)` 的原因 —— 同一个内容在不同上下文里对应完全不同的 KV。
3. 尾块不落盘：只写满块，所以任何 prompt 的最后一个不完整块都要重算。
   「长尾不齐」里两条长度 7 的请求，第二条只能省 4、不能省 7。

**朴素解错在哪**（`Σ` 视角换成 LCP 视角）：LCP 与"块对齐的可复用长度"最多差 `blockSize-1`，
单条看不出来，但**命中率统计会系统性偏高**，容量规划就按错的余量走。

**工程延伸（面试追问点）**：
1. 链式 key 用什么算？（对前缀链做增量哈希：`h_b = mix(h_{b-1}, block_b)`，O(1) 递推；
   真实现里还要带 model / LoRA / 量化位宽 —— 同一段 token 换个模型权重完全不同，
   不加进 key 就是跨模型串缓存。）
2. 缓存淘汰怎么做？（前缀树 + LRU-T 按叶子向上回收：先逐出没有任何子孙引用的叶子块，父块只有在
   子块全没了才可能成为叶子 —— 逐出中间块会让整条子树作废，实际省不了多少。）
3. 命中了就一定更快吗？（不。命中省的是 prefill 算力，代价是一次显存查表 + 引用计数原子操作；
   短 prompt 上开销可能盖过收益。所以生产实现会给"最少命中多少 token 才值得复用"留阈值。）
4. 多机部署下前缀缓存怎么共享？（要么按前缀哈希做一致性路由（同一前缀落同一实例），要么把 KV
   下沉到远端池化存储 —— 前者省网络但会造成热点，后者省热点但把 TTFT 押在网络代际上。）
5. 为什么本题按串行算？（并发请求可能同时 miss 同一段前缀、各算一遍再都写缓存 —— 这叫
   cache thundering herd，需要"同前缀 single-flight"，是另一道题。）"""

    return base(
        'algorithms', 'senior',
        '前缀缓存的复用长度：块对齐、链式 key，尾块永远省不下来',
        statement, 'java-junit',
        ['prefix-cache', 'llm-inference', 'kv-cache', 'hash-chain', 'modern:inference-gateway'],
        src('DeepSeek', '推理引擎 / 显存调度 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#33,#32（原文只说"公共前缀的 KV 可以复用"，未把块对齐与链式 key 做成判分点）'),
        language='java',
        cases=[
            {'name': '同 system prompt 三连发：省下来的是整块，不是全部前缀',
             'input': [[[10, 11, 12, 13, 100, 101], [10, 11, 12, 13, 200, 201, 202, 203], [10, 11, 12, 13, 300]], 4],
             'expected': 11,
             'note': 'R1 全算 6；R2 命中首块省 4 → 4；R3 命中首块省 4 → 1。合计 11'},
            {'name': '零头不落盘：长度 3 的请求凑不出一个整块，复用为 0',
             'input': [[[7, 8, 9, 10, 11, 12, 13, 14], [7, 8, 9]], 4],
             'expected': 11,
             'note': '朴素 LCP 会说第二条省 3（成本 8）—— 显存里根本没有那份 KV'},
            {'name': '分叉在第二块：公共前缀之后各走各的',
             'input': [[[1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 9, 9, 9, 9], [1, 2, 3, 4, 9, 9, 9, 9]], 4],
             'expected': 12,
             'note': 'R2 只省首块（4），R3 与前一条完全同链（0）→ 8 + 4 + 0'},
            {'name': '完全重复的请求成本为 0',
             'input': [[[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]], 4],
             'expected': 4},
            {'name': '块内容相同但位置不同不算命中（链式 key）',
             'input': [[[1, 2, 3, 4, 5, 6, 7, 8], [5, 6, 7, 8]], 4],
             'expected': 12,
             'note': '"块集合"实现会把 R2 判成全命中（成本 8）；真实前缀链不同，必须整条重算'},
            {'name': 'blockSize 为 1：每一块都可复用，包括最后一个 token',
             'input': [[[5, 6, 7], [5, 6, 7, 8]], 1],
             'expected': 4,
             'note': 'R2 省 3、算 1 —— 块大小为 1 时不存在尾块浪费'},
            {'name': '退化：空批次返回 0', 'input': [[], 4], 'expected': 0},
            {'name': '退化：空 prompt 既不产生成本也不产生缓存',
             'input': [[[], [1, 2, 3, 4, 5], [], [1, 2, 3, 4]], 4],
             'expected': 5,
             'note': '长度 5 全算（5），随后长度 4 命中首块（0）'},
            {'name': '长尾不齐：两条长度 7 的请求，第二条只省 4',
             'input': [[[1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]], 4],
             'expected': 10,
             'note': '7 − 4 = 3：最后 3 个 token 落在没写盘的尾块里'},
            {'name': '脏 token 必须显式失败', 'input': [[[1, 2, -3, 4]], 4], 'expected': None,
             'expectThrow': 'IllegalArgumentException', 'note': '宽容处理会把脏数据算成一次正常命中'},
            {'name': 'blockSize 非法必须显式失败', 'input': [[[1, 2]], 0], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
        ],
        runner={'className': 'Solution',
                'signature': 'int prefillCost(int[][] prompts, int blockSize)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


@draft('alg-deepseek-moe-capacity')
def q_moe_capacity():
    statement = """## 背景

MoE 每层只激活 top-k 个专家。专家并行（EP）部署时，**每个专家的 micro-batch 缓冲区是静态预分配**的：
容量 `capacity`，写满就装不下。router 决定 token 去哪个专家，但派发要按到达顺序填这些固定槽位。

`routing[i]` 是第 i 个 token 选中的专家编号（k 个，顺序无关）。按 token 下标顺序派发，规则是
**全部或全无**：

- 该 token 选中的**每一个**专家都还有空位 → 收下，被选中的专家各 +1；
- 只要有任意一个选中的专家已满 → 整个 token 溢出，**一个专家都不占**。

返回溢出的 token 数。

## 为什么是"全部或全无"

top-k 的 k 份输出要加权求和回 residual stream。只送进 1 份的 token 不会报错，它会**静默产出一个
错误的 hidden state**，然后被当成正常结果继续往下走 —— 比丢一个 token 危险得多。
所以"换个没满的专家"（re-routing）和"部分接收"都不是本题语义，那是另一套系统。

## 这题真正考的东西

朴素写法：`统计每个专家收到多少 token，再求 Σ max(0, cnt_e − capacity)`。它错在三处，
本题的用例一条打一处：

1. 一个 token 因为专家 A 满而被丢时，它对专家 B 的占用**根本不该发生**（计数版把它算进去了）
   —— 用例「热专家溢出后，后续冷 token 仍可进」；
2. 同一个 token 在两个专家上同时溢出时，会被**数成 2**（丢 1 个 token ≠ 溢出 2 份）
   —— 用例「两个专家同时满：丢 1 个 token，不是溢出 2 份」；
3. 与到达顺序无关（计数版默认"后到的吃亏"，真实系统里槽位就是被先到的人占掉的）
   —— 用例「顺序决定命运：容量不能挪腾」。

## 你要实现的入口

```java
public static int droppedTokens(int[][] routing, int numExperts, int capacity)
```

- `routing` 为空数组时返回 `0`；
- 以下都是**非法输入**，抛 `IllegalArgumentException`：
  `numExperts <= 0`、`capacity <= 0`、专家编号越界（`< 0` 或 `>= numExperts`）、
  同一个 token 内重复选同一个专家、某个 token 一个专家都没选。
  最后一条不是凑数：router 给出空 top-k 意味着门控全零或索引被写坏，
  把它当成"这个 token 不占任何容量"会让它悄悄跑完整个前向。

## 复杂度要求

`O(Σ k)` 时间、`O(numExperts)` 额外空间。"""

    reference = """public class Solution {
  public static int droppedTokens(int[][] routing, int numExperts, int capacity) {
    if (numExperts <= 0) throw new IllegalArgumentException("bad expert count");
    if (capacity <= 0) throw new IllegalArgumentException("bad capacity");
    int[] load = new int[numExperts];
    int dropped = 0;
    for (int[] chosen : routing) {
      if (chosen == null || chosen.length == 0) {
        throw new IllegalArgumentException("token routed to no expert");
      }
      for (int i = 0; i < chosen.length; i++) {
        int e = chosen[i];
        if (e < 0 || e >= numExperts) throw new IllegalArgumentException("expert id out of range: " + e);
        for (int j = i + 1; j < chosen.length; j++) {
          if (chosen[j] == e) throw new IllegalArgumentException("duplicated expert for one token: " + e);
        }
      }
      boolean fits = true;
      for (int e : chosen) {
        if (load[e] >= capacity) {
          fits = false;
          break;            // 全部或全无：一个满就整颗丢，剩下的专家不扣额度
        }
      }
      if (fits) {
        for (int e : chosen) load[e]++;
      } else {
        dropped++;
      }
    }
    return dropped;
  }
}"""

    naive = """public class Solution {
  // 生产事故版：先按专家计数，再对每个专家超出部分求和
  public static int droppedTokens(int[][] routing, int numExperts, int capacity) {
    if (numExperts <= 0) throw new IllegalArgumentException("bad expert count");
    if (capacity <= 0) throw new IllegalArgumentException("bad capacity");
    int[] load = new int[numExperts];
    for (int[] chosen : routing) {
      if (chosen == null || chosen.length == 0) {
        throw new IllegalArgumentException("token routed to no expert");
      }
      for (int e : chosen) {
        if (e < 0 || e >= numExperts) throw new IllegalArgumentException("expert id out of range: " + e);
        load[e]++;
      }
    }
    int dropped = 0;
    for (int[] chosen : routing) {
      for (int e : chosen) {
        if (load[e] > capacity) {
          dropped++;
          break;
        }
      }
    }
    return dropped;
  }
}"""

    answer = """**思路**：按 token 顺序模拟，维护每个专家已用槽位 `load[e]`。对每个 token 先整体判"所有选中专家
是否都有空位"，全有空位才一次性 +1；否则 `dropped++` 且不扣任何额度。校验放在派发之前。

**为什么"整颗丢"不扣额度**（用例「热专家溢出后，后续冷 token 仍可进」的要点）：token 6 `[3,2]` 能不能进，取决于前面被丢掉的那三个
token 有没有把专家 3、2 的槽位"顺手占掉"。真实系统里丢弃发生在派发前，槽位没动过；
如果实现成"先占再回滚"，一旦漏回滚就会永久占位，`capacity` 越跑越小，表现成"没人溢出但吞吐掉了"。

**为什么计数版三重错**：`Σ max(0, cnt_e − C)` 把 token 当成可拆的份额（错 1），
把同一个 token 的多份溢出重复计数（错 2），并且完全不看顺序（错 3）。
用例「一个专家先满：整颗丢，另一路专家不欠名额」上真答案 1、计数版给 4 —— 差 3 倍，而这 3 个"多出来的丢弃"会被监控解释成
"专家负载不均"，进而去调 router 的负载均衡系数，方向就错了。

**复杂度**：`O(Σk)` 时间、`O(E)` 空间。校验重复编号是 `O(k²)`，k 是常数（top-8 级）。

**工程延伸（面试追问点）**：
1. 溢出率该盯多少？（它不是越低越好：容量系数 C 每加一点，显存就按 `C × E × 每专家槽位` 涨。
   工程上是"用可接受的溢出率换显存"，所以要按 (模型, 序列长度桶) 分别标定，而不是全集群一个数。）
2. 静态容量真正的痛处？（容量按最坏分布预分配，均匀时大量空转。缓解：token 级别 drop 换成
   expert 级别 overflow，或用 All-to-All 动态 batch + 缓冲队列（DeepSeek 的 EP 通信路径），
   代价是延迟与显存峰值不可控。）
3. 怎么不靠辅助损失也能均衡？（给 router logits 加一个**可学习的 per-expert 偏置**，用"哪个专家空"
   反向修正路由，而不是往 loss 里塞均衡项 —— 后者会让均衡目标和语言建模目标互相拽，
   在超大规模 MoE 上是训练不稳定的一条主因。）
4. 丢弃之后 token 去哪？（三选一：整层跳过（残差直通）、重路由到次优专家、把整个 token 从这一层
   的 batch 里摘掉延后处理。三者对精度的影响完全不同，这是"溢出率 0.1%"能不能接受的关键。）
5. 为什么 top-k 内不许重复？（同一专家算两次等价于把它的权重翻倍，梯度与推理结果都会偏；
   真实现里要么在 router 里做 top-k 去重，要么用带采样的路由 —— 静默收下等于把 bug 交给下游。）"""

    return base(
        'algorithms', 'senior',
        'MoE 专家容量溢出：全部或全无，被丢的 token 不许占任何名额',
        statement, 'java-junit',
        ['moe-routing', 'llm-inference', 'capacity-planning', 'simulation-order', 'modern:moe-expert-parallel'],
        src('DeepSeek', '推理引擎 / MoE 并行 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#39（原文只答"难点是负载均衡与通信"，未给可判分的容量语义）'),
        language='java',
        cases=[
            {'name': '两个专家同时满：丢 1 个 token，不是溢出 2 份',
             'input': [[[0, 1], [0, 1]], 2, 1], 'expected': 1,
             'note': '计数版这里给 2（每个专家各记一份）'},
            {'name': '一个专家先满：整颗丢，另一路专家不欠名额',
             'input': [[[0, 1], [0, 2], [1, 2], [0, 1]], 3, 2], 'expected': 1,
             'note': 't4 撞专家 0 满 → 丢；计数版这里给 4'},
            {'name': '热专家溢出后，后续冷 token 仍可进（证明丢的不占额度）',
             'input': [[[0, 1], [0, 2], [0, 3], [0, 1], [0, 2], [3, 2]], 4, 2],
             'expected': 3,
             'note': 't3/t4/t5 因专家 0 满被丢且不占 1/2/3；t6 还能进。先占不回滚的实现会给 4'},
            {'name': '顺序决定命运：容量不能挪腾',
             'input': [[[0, 1], [0, 2], [1, 2]], 3, 1], 'expected': 2,
             'note': 't1 占掉 0 和 1，t2/t3 各撞一个满 → 丢 2（重路由或"择优派发"只会丢 1）'},
            {'name': 'top-1 全挤同一个专家',
             'input': [[[1], [1], [1], [1]], 3, 2], 'expected': 2},
            {'name': '容量充足：一颗都不丢',
             'input': [[[0, 1], [1, 2], [2, 3], [3, 0]], 4, 3], 'expected': 0},
            {'name': '退化：没有 token', 'input': [[], 3, 2], 'expected': 0},
            {'name': '边界：k 恰好等于专家数，第二颗必丢',
             'input': [[[0, 1, 2], [0, 1, 2]], 3, 1], 'expected': 1},
            {'name': '非法：专家编号越界', 'input': [[[0, 3]], 3, 2], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
            {'name': '非法：同一 token 重复选同一专家', 'input': [[[1, 1]], 3, 2], 'expected': None,
             'expectThrow': 'IllegalArgumentException',
             'note': '收下等于把这个专家的权重悄悄翻倍，残差求和就偏了'},
            {'name': '非法：某 token 没选中任何专家', 'input': [[[0], []], 3, 2], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
            {'name': '非法：capacity 为 0', 'input': [[[0]], 3, 0], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
        ],
        runner={'className': 'Solution',
                'signature': 'int droppedTokens(int[][] routing, int numExperts, int capacity)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


@draft('sql-deepseek-ttft-p99')
def q_ttft_percentile():
    """MySQL 8.0 没有 PERCENTILE_CONT：最近秩分位数必须自己用窗口函数搭。

    用例的 expected 全部由下面这份数据集**算出来**，不手抄 —— 上一批就是手抄 expected
    错了两次，precheck 才存在。
    """
    from datetime import datetime, timedelta

    t0 = datetime(2026, 5, 1, 0, 0, 0)

    def ts(micro_offset):
        return (t0 + timedelta(microseconds=micro_offset)).strftime('%Y-%m-%d %H:%M:%S.%f')

    def cell(micro_offset):
        return 'NULL' if micro_offset is None else f"'{ts(micro_offset)}'"

    # 行形态：(req_id, model_ver, enqueued_us, started_us, finished_us)
    # v1：教科书式均匀分布 —— queue 10k..1000k µs，decode 20k..2000k µs
    v1 = [(100 + n, 'v1', 0, n * 10_000, n * 10_000 + n * 20_000) for n in range(1, 101)]
    # v2：99 条正常 + 1 条 50s 排队长尾。均值被这一条拉到 500,990，而最近秩 P99 仍是 1,000
    v2 = [(200 + n, 'v2', 0, 1_000, 1_000 + 200_000) for n in range(1, 100)]
    v2.append((300, 'v2', 0, 50_000_000, 50_000_000 + 200_000))
    # v3：一条已完成 + 两条排队中（started_at / finished_at 都还没有）
    v3 = [(301, 'v3', 0, 7_000, 7_000 + 9_000),
          (302, 'v3', 0, None, None),
          (303, 'v3', 0, None, None)]
    BASE = v1 + v2 + v3

    def insert_stmt(rows):
        values = ',\n  '.join(
            f"({rid}, '{ver}', {cell(enq)}, {cell(st)}, {cell(fin)})"
            for rid, ver, enq, st, fin in rows
        )
        return ('INSERT INTO infer_request (req_id, model_ver, enqueued_at, started_at, finished_at)\n'
                f'VALUES\n  {values}')

    def nearest_rank_p99(values):
        """CEIL(0.99 * n) 秩（MySQL 里 0.99 是精确 DECIMAL，这里用整数式避开浮点误差）。"""
        ordered = sorted(values)
        rank = (99 * len(ordered) + 99) // 100
        return ordered[rank - 1]

    def expected_of(rows):
        completed = [r for r in rows if r[3] is not None and r[4] is not None]
        out = []
        for ver in sorted({r[1] for r in completed}):
            group = [r for r in completed if r[1] == ver]
            out.append([ver,
                        len(group),
                        nearest_rank_p99([r[3] - r[2] for r in group]),
                        nearest_rank_p99([r[4] - r[3] for r in group])])
        return out

    COLUMNS = ['model_ver', 'req_cnt', 'queue_p99_us', 'decode_p99_us']

    def expect(rows, input_stmts, name, note=None):
        rows_out = expected_of(rows)
        # 空结果集在 mysql --batch 下连表头都没有，拿不到列名 → 只能写成裸数组（见 docs/JUDGING.md）
        expected = [] if not rows_out else {'columns': COLUMNS, 'rows': rows_out, 'orderSensitive': True}
        payload = {
            'name': name,
            'input': input_stmts,
            'expected': expected,
        }
        if note:
            payload['note'] = note
        return payload

    statement = """## 基线

MySQL 8.0（判题容器 8.0.x，默认 `ONLY_FULL_GROUP_BY`）。**MySQL 没有 `PERCENTILE_CONT`**，
所以本题考的就是你能不能自己把分位数搭对。

表 `infer_request`（推理网关的请求埋点）：

```
req_id       INT PRIMARY KEY
model_ver    VARCHAR(8)  NOT NULL     -- 模型版本：'v1' / 'v2' / 'v3'
enqueued_at  DATETIME(6) NOT NULL     -- 到达网关、进队列的时刻
started_at   DATETIME(6) NULL         -- 真正开始跑 prefill 的时刻（NULL = 还没开始）
finished_at  DATETIME(6) NULL         -- 出完最后一个 token 的时刻（NULL = 还没结束）
```

`queue_us`（排队耗时）= `enqueued_at → started_at`；`decode_us` = `started_at → finished_at`。

## 要输出什么

按 `model_ver` 各出一行，列名与顺序**必须**是 `model_ver, req_cnt, queue_p99_us, decode_p99_us`，
并按 `model_ver` 升序排列（判题按行序敏感比对）。

- `req_cnt`：**参与统计的行数**；
- 两个 `*_p99_us`：单位微秒的整数，按**最近秩**（nearest-rank）定义 ——
  设某版本参与统计的行数为 N，把该度量升序排列后取**第 `CEIL(0.99 × N)` 行的值**。

## 口径（这些是判分点，不是建议）

1. 只有 `started_at` 与 `finished_at` **都非空**的行才参与统计。没跑完的请求既没有完整排队时间，
   也不该占用它的秩 —— **更重要的是它会改变 N，从而把所有人的秩挪一位**。
2. `queue_us` 与 `decode_us` 的排名**各排各的**：同一行不会同时是两个度量的第 99 名。
3. 只提交一条 `SELECT` / `WITH` 查询（可前置一条 `SET SESSION`）。不许建函数、不许用会话变量累加。

## 为什么不能拿均值交差

`v2` 里 99 条请求排队 1ms，1 条排了 50s。均值是 **500,990 µs**，而最近秩 P99 是 **1,000 µs**。
两个数在说完全不同的事：一个说"平均体验被一条长尾拖累了"，另一个说"99% 的用户几乎没排队"。
用 `AVG` 或 `MAX` 交差，就是把这两种说法混成一种 —— 排障时先查谁就查反了。

反过来，`v1` 的 P99 落在第 99 名（990,000 µs），`v3` 只有 1 条完成请求，N=1 时
`CEIL(0.99 × 1) = 1` —— **取第 1 名，不是第 0 名**。写成 `FLOOR` 或用 `0.99 * N` 直接当行号
的实现在这里会拿到 NULL，然后被解释成"这个版本没有数据"。"""

    reference = """WITH completed AS (
  SELECT model_ver,
         TIMESTAMPDIFF(MICROSECOND, enqueued_at, started_at) AS queue_us,
         TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) AS decode_us
  FROM infer_request
  WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
), ranked AS (
  SELECT model_ver, queue_us, decode_us,
         COUNT(*)     OVER (PARTITION BY model_ver)                  AS cnt,
         ROW_NUMBER() OVER (PARTITION BY model_ver ORDER BY queue_us) AS rq,
         ROW_NUMBER() OVER (PARTITION BY model_ver ORDER BY decode_us) AS rd
  FROM completed
)
SELECT model_ver,
       MAX(cnt)                                                AS req_cnt,
       MIN(CASE WHEN rq = CEIL(0.99 * cnt) THEN queue_us END)  AS queue_p99_us,
       MIN(CASE WHEN rd = CEIL(0.99 * cnt) THEN decode_us END) AS decode_p99_us
FROM ranked
GROUP BY model_ver
ORDER BY model_ver"""

    naive = """SELECT model_ver,
       COUNT(*) AS req_cnt,
       ROUND(AVG(TIMESTAMPDIFF(MICROSECOND, enqueued_at, started_at))) AS queue_p99_us,
       ROUND(AVG(TIMESTAMPDIFF(MICROSECOND, started_at, finished_at))) AS decode_p99_us
FROM infer_request
GROUP BY model_ver
ORDER BY model_ver"""

    answer = """## 参考答案

```sql
WITH completed AS (
  SELECT model_ver,
         TIMESTAMPDIFF(MICROSECOND, enqueued_at, started_at) AS queue_us,
         TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) AS decode_us
  FROM infer_request
  WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
), ranked AS (
  SELECT model_ver, queue_us, decode_us,
         COUNT(*)     OVER (PARTITION BY model_ver)                   AS cnt,
         ROW_NUMBER() OVER (PARTITION BY model_ver ORDER BY queue_us)  AS rq,
         ROW_NUMBER() OVER (PARTITION BY model_ver ORDER BY decode_us) AS rd
  FROM completed
)
SELECT model_ver,
       MAX(cnt)                                                AS req_cnt,
       MIN(CASE WHEN rq = CEIL(0.99 * cnt) THEN queue_us END)  AS queue_p99_us,
       MIN(CASE WHEN rd = CEIL(0.99 * cnt) THEN decode_us END) AS decode_p99_us
FROM ranked
GROUP BY model_ver
ORDER BY model_ver;
```

**四个容易写歪的地方**

1. **秩要用 `CEIL`，且要小心算术类型**。MySQL 里字面量 `0.99` 是精确 DECIMAL，
   `0.99 * 100 = 99.00` 精确无误差，`CEIL` 得 99；如果先把它转成浮点
   （如 `CEIL(N * POW(10,-2) * 99)` 之类）就会出现 `99.00000000000001` → `CEIL` 变 100，
   样本刚好整百时错一位。N=1 时 `CEIL(0.99) = 1`，而 `FLOOR` 给 0 → 拿不到行 → NULL。
2. **两个度量必须各自开窗**。`ROW_NUMBER()` 的排序键不同，写在一个窗口里就只能给一个度量定序，
   另一个度量的"第 99 名"其实是按别人的顺序数的。
3. **N 必须是参与排名的行数**，不是表行数。这就是"未完成行要在 WHERE 里滤掉"而不是
   "在 CASE 里判 NULL"的原因：留在集合里 `COUNT(*) OVER ()` 就把分母灌水了。
   用 `COUNT(*) FILTER`（PG 语法）在 MySQL 里根本不存在，`CASE WHEN ... THEN 1 END` 塞进
   窗口 COUNT 又会把 NULL 当 0 之外的值处理，很容易自欺。
4. **`TIMESTAMPDIFF` 遇到 NULL 返回 NULL**，而 MySQL 升序把 NULL 排最前。
   只要有一条 `started_at IS NULL` 但 `finished_at` 有值的脏行漏进统计，它就会占掉第 1 名，
   所有秩整体后移一位 —— 症状是"分位数悄悄变大"，很难归因。
   本题用例 4 就是这条：漏过滤时 `req_cnt` 会变 101。

`MIN(CASE WHEN rank = k THEN value END)` 是"取第 k 名的值"的标准聚合写法：
只有那一行落在 CASE 里，其余是 NULL，`MIN` 跳过 NULL。等值排名有并列时（用例里 v2 的 99 个 1000）
`ROW_NUMBER` 仍给出唯一秩，而秩上的**值**相同，所以结果确定。

**工程延伸（面试追问点）**

1. 数据在多个分片/多天，怎么合并 P99？→ **分位数不可合并**：拿每个分片的 P99 求平均是错的。
   要么留原始分布做全局归并排序，要么用可合并的近似结构（t-digest / HDR histogram / DDSketch），
   要么把精度目标（±1%）写进 SLA 再选 sketch。
2. 为什么不用 `NTILE(100)`？→ 它按行数等分桶，N=1 时 `NTILE(100)` 只给一个非空桶，
   小样本上"第 99 桶"根本不存在；而最近秩的定义在小样本上退化成"取那一条"，语义才对得上 SLO。
3. 这套查询慢在哪？→ 两个窗口意味着两次按 `model_ver + 度量` 的排序。日千万行的埋点不会这么查：
   要么落库前就把直方图算好（每秒/每分钟的 bucket 计数），要么用 `approx_percentile` 的引擎
   （ClickHouse/Doris/Trino）做即席，MySQL 只当业务库。
4. `queue_p99` 与 `decode_p99` 相加能当端到端 P99 吗？→ 不能。分位数对加法不封闭；
   要端到端就必须按 `total_us` 单独排名（用例数据里 v1 的 total 第 99 名恰好是同一行，
   但这是构造出来的巧合，不是规律）。
5. 长尾只有一条，为什么还要盯 P99 而不是 P100？→ P100 = max，对单点噪声（一次 GPU 抢占）
   过度敏感，会天天告警；P99 在"最近秩"定义下要求至少 ⌈1%·N⌉ 条都慢才算退化，
   这也是"样本量太小时别报分位数"的原因（N < 100 时第 99 名与第 100 名之间没有区别）。"""

    rows_with_dirty = BASE + [(411, 'v1', 0, None, 500_000)]
    rows_with_pending = BASE + [(401, 'v3', 0, None, None),
                                (402, 'v3', 0, None, None),
                                (403, 'v3', 0, 3_000, None)]

    return base(
        'sql', 'senior',
        '没有 PERCENTILE_CONT 的 MySQL：把排队与推理耗时的 P99 各自算对',
        statement, 'mysql',
        ['percentile', 'window-function', 'llm-observability', 'null-semantics', 'modern:mysql8-window'],
        src('DeepSeek', '推理平台 / 可观测性 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#56,#49（原文只说"要区分排队与推理耗时"，未落到可判分的分位数口径）'),
        language='sql',
        cases=[
            expect(BASE, [], '基线：三个版本各自的最近秩 P99',
                   note='v1 秩 99 → 990,000 / 1,980,000；v2 → 1,000（长尾在秩 100）；v3 N=1 → 秩 1'),
            expect([r for r in BASE if r[0] != 300],
                   ["DELETE FROM infer_request WHERE req_id = 300"],
                   '删掉那条 50s 长尾：P99 不动，行数才动',
                   note='这条钉死"分位数对单点噪声不敏感"是特性而不是运气'),
            expect(rows_with_pending,
                   [insert_stmt(rows_with_pending[len(BASE):])],
                   '排队中的行必须整行排除（否则 v3 的 N 被灌成 4，秩 4 不存在 → NULL）',
                   note='正确实现下 v3 这一行与基线一字不变'),
            expect(rows_with_dirty,
                   [insert_stmt(rows_with_dirty[len(BASE):])],
                   '埋点漏写（started_at 为 NULL 但 finished_at 有值）也必须排除',
                   note='只过滤 finished_at 的实现会把 v1 的 req_cnt 报成 101，且 NULL 排最前导致秩全体后移'),
            expect([r for r in BASE if r[0] == 301],
                   ["DELETE FROM infer_request WHERE req_id <> 301"],
                   '只剩一个样本的版本：结果只有一行',
                   note='用 LEFT JOIN 版本脚手架的实现会多出一行 NULL，被"行数不一致"抓掉'),
            expect([], ["DELETE FROM infer_request"], '退化：空表返回 0 行（不是 1 行 NULL）'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS infer_request',
                'CREATE TABLE infer_request (req_id INT PRIMARY KEY, model_ver VARCHAR(8) NOT NULL, '
                'enqueued_at DATETIME(6) NOT NULL, started_at DATETIME(6) NULL, finished_at DATETIME(6) NULL, '
                'KEY idx_ver_started (model_ver, started_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 '
                'COLLATE=utf8mb4_0900_ai_ci',
                insert_stmt(v1),
                insert_stmt(v2),
                insert_stmt(v3),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=24,
        answer=answer,
    )


@draft('sys-deepseek-gpu-util')
def q_gpu_utilization_argument():
    statement = """## 场景

你负责一个 2000 张 GPU 的大模型推理集群。季度成本复盘后，业务负责人给你定了一个目标：

> "现在 GPU 利用率才 72%，太浪费了。这个季度把它压到 95%，相当于不花钱多买 600 张卡。"

现状与约束：

- 流量分两类：**对话**（TTFT P99 < 1.5s、TPOT P99 < 50ms，占调用数 85%）与
  **批量离线生成**（吞吐敏感、延迟不敏感，占调用数 15% 但占 token 量 40%）；
- 监控面板上的"GPU 利用率"来自 `nvidia-smi` 的 `utilization.gpu`，按卡取分钟均值；
- 集群还有一层 K8s 弹性伸缩，当前策略是"利用率 > 85% 持续 5 分钟就扩容"；
- 上个月刚出过一次事故：一次长文档功能上线，平均 prompt 从 800 涨到 6000 token，
  当天没扩卡，对话 TTFT P99 从 1.2s 涨到 9s，持续 4 小时。

## 请回答

1. **"72% 利用率"这个数字本身有什么问题？** 请说明它度量的是什么、为什么会骗人，
   并给出你应该换成哪一组指标来讨论这件事（不接受"看更细的监控"这类笼统说法）。
2. 把利用率往 95% 压，**代价以什么形式出现**？请给出你的定量直觉
   （不需要精确数字，但要说清哪个量随哪个量怎么变、拐点大概在哪）。
3. 你的**执行方案**是什么？要求：既要真降单位 token 成本，又不能让对话 SLO 违约。
   请分层说明（调度参数、流量结构、容量动作、计费口径），并明确**先做哪个、后做哪个**。
4. 怎么**证明**你做完之后没伤到用户？给出可回滚的判据。
5. 什么条件下你会明确回答"**这个目标不能接**"？给出至少两条具体信号。"""

    answer = """## 参考答案要点

**1. 指标口径：`utilization.gpu` 度量的是"有没有 kernel 在跑"，不是"跑得多满"**

`nvidia-smi` 的 GPU utilization 定义是**采样周期内至少有一个 kernel 处于执行状态的时间占比**。
所以：

- 一个只用 5% SM、单 warp 的 kernel 连续跑满一分钟 → 利用率 100%，而算力/带宽几乎空着；
- decode 阶段是**显存带宽瓶颈**，真正的约束是 HBM 带宽，而 util 完全不反映它；
- 取分钟均值再平均，等于把"批大小从 1 跳到 60"这类结构差异抹平 —— 恰恰是吞吐差异的来源。

该换成的指标体系（按用途分）：

| 目的 | 指标 |
| --- | --- |
| 有效产出 | `tokens/s per GPU`（分 prefill/decode）、每百万 token 成本（含闲置卡时） |
| 真正饱和 | HBM 带宽利用率、SM occupancy / tensor core 活跃度（profilng 采样而非 nvidia-smi） |
| 批结构 | running batch size 分布、KV 显存占用率、prefix cache 命中率 |
| 用户体验 | TTFT / TPOT 的 P50/P99/P999，**按 prompt 长度分桶** |
| 缓冲能力 | 队列等待时间、超出 SLO 的比例（错误预算余量） |

关键一句：**"利用率"是观察量，不是目标量。** 一旦把它定成 KPI，工程手段就会变成
"让 GPU 一直有 kernel 在跑"（比如把批量拆碎凑忙碌），而不是"每 token 更便宜"。

**2. 代价的形式：排队发散 + 尾延迟放大，且不可逆地吃掉突发余量**

- 排队论：服务台利用率 ρ→1 时，等待时间按 `ρ/(1−ρ)` 量级发散。72%→95% 意味着
  排队项放大 **约 7 倍**（0.72/0.28 ≈ 2.6 → 0.95/0.05 = 19）。这就是为什么"只涨 23 个点"
  会直接击穿 P99 < 1.5s：P50 几乎不变，P99 是乘法恶化。
- 批大小与延迟是反向的：加大 batch 提吞吐，但 decode step 时间随之变长（TPOT 上升），
  新请求还要等当前 step 结束（TTFT 上升）。**吞吐的最后一公里是用延迟买的。**
- 抢占与抖动：高利用率下没有空槽，长 prefill 会挤掉同批 decode（chunked prefill 预算调大也一样），
  表现为 TTFT 的 P999 爆炸 —— 上个月那次事故正是这个机制，只不过当时是流量结构变了。
- **突发余量被永久占用**：留 28% 不是浪费，那是吸收"上线一个长文档功能"的缓冲。
  压到 95% 等于把系统的抗扰动能力换成纸面成本。

正确的目标是 **每 token 成本下降**，而不是 GPU 利用率上升。两者经常同向，但在高利用率区间会分道扬镳。

**3. 执行方案（按"先做不牺牲 SLO 的、后做需要权衡的"排序）**

第一步（无风险，先吃掉）：
- **改计费与核算口径**：把"卡时利用率"换成"每百万 token 成本（含闲置）"。多数争论在这一步
  就消失了 —— 因为业务方真正要的省钱，和"利用率"不是一回事。
- **离线批量任务当缓冲垫**：把 15% 的批量生成调度到"集群有富余时才跑"，让它填充波谷。
  这一步能显著提升真实产出，且完全不碰对话 SLO。
- **prefix / prompt cache 落地**：共享 system prompt 的流量省掉重复 prefill，等价于扩容。
  命中率是最该先看的免费收益。

第二步（要度量、有调参）：
- **chunked prefill 预算与 max batched tokens 调优**：目标是"decode step 时间的 P99 不恶化"
  前提下尽量塞满；用离线回放扫参数，不是线上试。
- **优先级与分级降级**：过载时按顺序牺牲——先拒绝超长上下文（引导走离线通道）、再挤压批量任务、
  最后才动对话排队。**降级顺序要写成配置并有演练**，不能靠值班判断。
- **长短任务队列隔离**：让长 prefill 不阻塞短对话（这是尾部延迟的主要来源之一）。

第三步（容量动作，最后做）：
- **缩容要带冷却窗口与平滑驱逐**：正在 decode 的卡不能直接撤，要么等会话收敛，要么走 KV 迁移。
  弹性策略的触发指标必须换成队列长度 / SLO 违约率，而不是那个 85% 利用率（否则"高利用率扩、
  低利用率缩"会和人工干预互相打脸，形成震荡）。
- **MIG / 分时复用**只适合小模型或 embedding 这类低带宽需求的服务，别拿它去切主力推理负载：
  decode 是带宽瓶颈，切分后带宽竞争更糟。

第四步：按 (模型, prompt 长度桶, 租户) 重新标定容量红线，把"这条线以下不允许缩容"写进平台默认值。

**4. 证明没伤到用户**

- **A/B 或按租户灰度**：同一集群里对照组保持原参数，实验组提利用率；看对话侧 TTFT/TPOT 分位数、
  错误率、重试率、单轮放弃率（用户等太久就关页面，这是最真的信号）。
- **影子流量回放**：用峰值日真实流量回放调参后的配置，专看 P999 而非均值。
- **回滚判据要具体到数字与时间窗**：例如"TTFT P99 > 1.2s 连续 3 个窗口"或
  "SLO 违约率环比 +0.5pp"即自动回滚参数（不是回滚机器），并保留一个"一键回到 72% 配置"的开关。
- **错误预算**：给对话 SLO 设月度预算（如 0.1% 违约），每提一档利用率就消耗预算，
  烧完就必须停止优化 —— 这是把"省钱 vs 体验"变成可审计的账，而不是每季度吵一次。

**5. 明确不接这条 KPI 的信号**

- 对话 SLO 已经**没有余量**（P99 距阈值 < 20%），或错误预算本季度已烧掉大半；
- 流量结构正在**快速变化**（新功能上线、平均 prompt 长度上行）——此时任何缓冲都要留给不确定性；
- 无法按 prompt 长度分桶观测（看不到机制就只能看到事故），或降级顺序没有演练过；
- 处于**灰度/故障复盘期**，弹性伸缩的冷却还没调对（此时提利用率会直接放大震荡）；
- 成本诉求其实来自"卡买多了"而不是"跑得不够省"——那该谈的是资源重新分配，不是压榨在跑的服务。

**评分时最看重**：能否指出 `utilization.gpu` 的定义性缺陷并给出替代指标集；
是否用"排队发散 + 突发余量"解释代价而不是只说"会变慢"；
方案是否**分层有序**（缓冲垫/缓存先行、容量动作最后）；
回滚与拒绝条件是否具体到可执行。只答"提高利用率是好事，逐步压"视为未命中第 1、2 项。"""

    return base(
        'system-design', 'principal',
        '"GPU 利用率才 72%，压到 95% 等于白捡 600 张卡"：这场争论你怎么打',
        statement, 'llm-rubric',
        ['gpu-utilization', 'capacity-planning', 'slo-tail-latency', 'cost-attribution', 'modern:llm-serving-economics'],
        src('DeepSeek', '推理平台 技术专家 / Principal',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#50,#86,#30,#53（原文只说"不是越高越好，维持 70-85%"，未给出指标替代与可回滚判据）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '指标口径辨析', 'weight': 3,
             'criteria': '是否说清 utilization.gpu 度量的是"有 kernel 在跑的时间占比"因而会骗人，并给出替代指标集（有效产出 / 真饱和 / 尾延迟分桶 / 缓冲余量），点名"利用率是观察量不是目标量"'},
            {'label': '代价的定量直觉', 'weight': 2,
             'criteria': '是否用排队发散（ρ/(1−ρ) 量级，72%→95% 约 7 倍）+ 批大小与 TPOT/TTFT 的反向关系 + 突发余量被永久占用三条解释代价，而不是笼统说"会变慢"'},
            {'label': '分层且有序的方案', 'weight': 2,
             'criteria': '是否区分"先吃不伤 SLO 的收益"（批量任务填谷、prefix cache、计费口径）与"需要权衡的动作"（chunk 预算、降级顺序、缩容与冷却），并给出降级顺序'},
            {'label': '证据与回滚判据', 'weight': 2,
             'criteria': '是否给出可执行的对照方式（灰度/A/B、影子回放、按长度分桶看 P999）与具体回滚阈值，含错误预算类机制'},
            {'label': '不接目标的信号', 'weight': 1,
             'criteria': '是否给出至少两条具体否决信号（SLO 无余量、流量结构剧变、无法分桶观测、灰度/复盘期）'}
        ], 'notes': '只罗列监控工具或口号式回答（"精细化运营"）不给判据的，第 1、4 项按 0 分；'
                    '把目标改写成"每 token 成本"本身就应记在第 1 项的分上。'},
        estimatedMinutes=32,
        answer=answer,
    )


@draft('ag-deepseek-loop-detection')
def q_agent_loop_detection():
    statement = """## 场景

你负责一个 Agent 平台的执行框架。线上跑着几百种 Agent，平均单任务 6 轮工具调用。

第 69 条防线的实现是这样的：

```
1) 最大循环次数 maxLoop = 20，到点强制结束；
2) 完全相同的工具调用（工具名 + 参数 hash 一致）连续出现 3 次 → 判定死循环并终止。
```

这两道防线上线半年后，出现一批**烧钱但不报错**的任务：Agent 反复调用同一个检索工具，
但每次参数都微调 —— `"向量库 超时"` → `"向量库 超时 原因"` → `"向量库 超时 排查"` →
`"vector db timeout"`。三轮之后检索回来的文档集合**完全一样**，结论也没变，
可它既不满足"参数 hash 一致"，也没跑满 20 轮就把预算烧光了。

复盘还发现第二个问题：检测器**不敢开严**——真正复杂的任务（比如跨 8 个系统的故障定位）
确实需要反复检索，误杀一次就是业务事故，值班同学最后把阈值调到了等于没有。

## 请回答

1. 把"**有没有进展**"变成一个可观测的定义。你认为在只有"工具调用记录 + 工具返回内容 +
   模型输出"这三样信号的前提下，进度应该怎么度量？给出你认为最可靠的 2-3 个信号，并说明各自会怎么失效。
2. 设计一个**检测器**：给出你的判定逻辑（可以用伪代码或规则清单）。要求能覆盖上面这个
   "参数在变、结果不变"的案例，同时不依赖"参数完全相同"这种脆弱条件。
3. 检测到之后**怎么处置**？请分级，并说明处置动作本身可能引入什么新问题
   （提示：Agent 已经执行过有副作用的工具）。
4. 怎么把检测器的阈值**定出来并且守住**？请给出评测口径 —— 要能让"敢开严"这件事成立，
   光调参数不够。
5. 这个案例里，"最大循环次数"这道防线真正的缺陷是什么？如果只能保留一个机制，你留哪个？"""

    answer = """## 参考答案要点

**1. "进展"的可观测定义（考的是能否把主观词换成信号）**

只有三种原料：调用记录、返回内容、模型输出。可用的进度信号，按可靠性排序：

- **信息增益（新增事实）**：把每次工具返回归约成一个"知识集合"（文档 id / 检索命中集合 /
  结构化字段值），进度 = 本轮引入的**净新增**元素数。参数改写在即，检索结果集合不变 →
  净新增 0 → 这就是案例里该被抓到的东西。失效场景：返回内容天然重复度高（同一篇文档
  换排序），或净新增来自无关噪声（需要按相关性截断）。
- **假设/计划是否变化**：解析模型每轮的 plan 或"下一步要验证什么"，比较语义等价类
  （不是字符串 diff）。失效场景：模型会用不同措辞复述同一个假设 —— 所以它只能当辅助信号。
- **目标距离可判定化**：如果任务有可验证终态（测试通过、字段填满、报告章节齐了），
  进度 = 完成度增量。这是最干净的，但要求任务本身可验证 —— 平台无法为所有 Agent 造出这个，
  所以它的正确定位是**能配就必须配**（评测/代码类任务必配）。
- 反面例子：**token 消耗、轮次数、耗时**都不是进度，只是成本。把它们当进度就等于
  "花钱即成功"，检测器会在最贵的任务上最先闭嘴。

**2. 检测器（窗口化 + 分级，不依赖 hash 相等）**

核心思想：**在滑动窗口上测"成本 vs 新增信息"的比值衰减**，而不是找"重复"。

```
对每个会话维护窗口 W（最近 m=5 轮）：
  calls        = 窗口内的工具调用数
  tool_share   = 出现次数最多的工具占窗口的比例
  new_facts    = 窗口内工具返回的净新增信息元素数（对检索类用文档 id 集合，
                 对执行类用结果 hash / 关键字段值）
  conclude_sim = 相邻轮"本轮结论"的语义相似度（有 cheap 版：抽取每轮的判断句做近重）

触发条件（任一）：
  A. 信息增益塌缩：new_facts / calls < θ_low 且 tool_share > θ_share   （案例走这条）
  B. 参数抖动同结果：同一工具连续 k 次调用，返回内容集合的 Jaccard ≈ 1
     —— 这条明确不看参数，参数是模型自由发挥的，结果才是世界的反馈
  C. 假设原地打转：conclude_sim 连续 m 轮 > θ_conc
  D.（若任务有可验证终态）完成度增量连续 m 轮 = 0
```

关键设计点：
- **判"结果重复"而不是"调用重复"**。参数是模型的自由变量，结果才是世界给的回执；
  现有防线 2 之所以被绕过，是因为它在模型可控的那一侧找规律。
- 阈值**按工具类别分别配**（检索类看文档集合，执行类看结果 hash，代码类看测试通过数），
  全局一个数必然两头不讨好。
- 窗口而非计数：把"跨 8 个系统的复杂任务"和"原地打转"区分开的不是总轮数，
  而是**局部**是否持续无增益。

**3. 分级处置（并且处置本身不能制造新事故）**

| 级别 | 动作 | 注意 |
| --- | --- | --- |
| L1 提示 | 把"你最近 5 轮检索到的内容没有变化，请改变策略或直接给出结论"注入下一轮 | 不要直接终止；多数 Agent 被提醒一次就收敛 |
| L2 换策略 | 强制注入候选动作（换工具/换检索源/拆分问题），或把温度/规划模式切一档 | 需要平台知道有哪些备选工具，否则 L2 是空话 |
| L3 收敛 | 只允许"综合已有信息给出答案 + 标注未验证项"，禁止再调工具 | 产出必须是可用产物，而不是"我卡住了" |
| L4 转人工 | 挂起会话，带上 trace 与已收集事实 | 要有 SLA，否则等价于丢弃 |

**处置的红线**：检测到循环 ≠ 可以重放。已经执行过有副作用的工具（退款、发消息）**不能因为
"这一轮被判为无效循环"就回滚或重试** —— 平台要有"工具级幂等 + 已提交事实不可撤销"的契约
（与本题相邻的另一条 WI 考的就是这个）。同理，自动终止必须留下"为什么终止"的证据，
否则值班同学只能看到"任务莫名结束"，最后就是今天这样把阈值调到没有。

**4. 让"敢开严"成立：离线回放 + 双向错误率**

- **留档 trace 做数据集**：真实历史会话（含正常长任务）→ 打标签"这段是不是白烧"，
  人工标几百条即可（关键是要有"确实需要 20 轮检索才成功"的正例）。
- **报两个数，不看一个数**：漏杀率（白烧任务里被抓到的比例）与**误杀率**（正常任务里被中断的
  比例）。阈值的可行域是这两条曲线围出来的；只报准确率就会掩盖误杀。
- **按任务类别定阈值 + 灰度**：新检测器先 shadow 模式跑两周（只记录不处置），
  对着 shadow 数据再开 L1，再开 L2/L3。
- **每次改阈值都要重跑回放**：这一步进 CI（回归集 + 门禁），否则阈值会随人员流动漂回"等于没开"。
- 上线后持续盯"被 L1 提醒后收敛率"：这个指标同时是检测器的自证 —— 提醒后立刻收敛说明
  判断对了；提醒后行为无变化说明检的是无关信号。

**5. maxLoop 的缺陷与取舍**

maxLoop 的问题不是"数值不对"，而是**它把成本当进度**，并且对所有任务用同一个预算：
简单任务 20 轮太宽（白烧到爆），复杂任务 20 轮太窄（误杀）。它是"轮数"这一个维度上的
常量策略，而循环的本质是"某一时刻之后不再产生信息"。

只能留一个：留**增益塌缩检测**（窗口化），因为 maxLoop 能防的"无限跑"它也能防
（无信息 → 塌缩 → L3 收敛），而 maxLoop 防不了本案例。但工程上正确的答案是
**保留 maxLoop 作为兜底保险丝**（防检测器自身有 bug 时成本失控），只是不能让它当主防线 ——
这类"最后一道防线要笨、但不能没有"的取舍，本身就该在答案里说出来。"""

    return base(
        'agent-design', 'senior',
        'Agent 反复调同一个工具但参数一直在变：maxLoop 与去重为什么都拦不住',
        statement, 'llm-rubric',
        ['agent-loop', 'progress-detection', 'observability', 'guardrails', 'modern:agent-runtime'],
        src('DeepSeek', 'Agent 平台 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#69,#72,#79（原文答"最大循环次数限制 + 状态检测 + 历史校验"，未定义"进展"，也没处理误杀）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '进度定义可观测', 'weight': 3,
             'criteria': '是否把"进展"落成可测信号（检索命中集合的净新增 / 结果指纹 / 完成度增量 / 假设是否改变）并说明各自失效方式；把 token 消耗或轮次数当进度视为未命中'},
            {'label': '检测逻辑不依赖参数相等', 'weight': 3,
             'criteria': '是否基于"结果无新增"或窗口化增益衰减做判定（覆盖参数微变的情形），并按工具类别分别设阈值，而不是给一个全局数字'},
            {'label': '分级处置与副作用安全', 'weight': 2,
             'criteria': '处置是否分级（提醒→换策略→强制收敛→人工），且明确指出已执行有副作用的工具不可因判循环而重放/回滚'},
            {'label': '阈值评测口径', 'weight': 2,
             'criteria': '是否给出可让"敢开严"成立的机制：历史 trace 回放数据集 + 误杀率与漏杀率双向指标 + shadow 上线，最好含改阈值进 CI'}
        ], 'notes': '只答"调小 maxLoop / 加超时 / 让人 review"属于未命中第 1、2 项；'
                    '第 4 项是区分做过平台与只做过单条 Agent 的地方，答"经验值"按 0 分。'},
        estimatedMinutes=28,
        answer=answer,
    )


@draft('hot-deepseek-node-failure')
def q_gpu_node_failure():
    statement = """## 场景

凌晨 2:14，推理集群里 40 张卡中的一个节点 `gpu-17` 失联。监控同时出现三条现象：

- 网关到 `gpu-17` 的 TCP 连接全部断开，正在跑的 **312 个流式请求**中断；
- 其中 200 多个请求**已经向用户推出去 100-800 个 token**（SSE 不可回滚）；
- 2:14-2:19 期间，另外 3 个节点也短暂出现连接抖动，但 5 分钟内自愈。

`gpu-17` 的会话 KV 全在**本地显存**里。产品方的诉求是：

> "这 312 个请求自动重跑一下就行吧？用户应该无感知。"

## 请回答

1. 产品方说的"**无感知**"在这里其实是两件不同的事。请把它们分开，并各自说明
   重放会造成什么后果（提示：一边在用户屏幕上，一边在下游系统里）。
2. 对这 312 个请求，你**当场**的处理决策是什么？请按可观测到的状态分桶给出策略，
   并说明每桶的代价。
3. "重算 prefill" 与 "把 KV 放到远端以便续推" 是两条常见路线。请做一次**量级估算**：
   说明各自的代价由什么决定，在什么条件下你选哪一条。（本题不要求精确，要求算式正确。）
4. 2:14 那 3 个"抖一下就自愈"的节点，如果你的故障判定器把它们也判成宕机会怎样？
   请给出你的**故障判定方案**，说明怎么在"响应快"和"别误杀"之间取舍。
5. 要让这类事故下一次不再需要现场拍脑袋，你会在**架构上**改哪一处？（只能提一处，说清理由）"""

    answer = """## 参考答案要点

**1. 两个"无感知"：用户可见重复 vs 计费/副作用重复**

- **屏幕上的重复**：SSE 已经推出去的 token 无法回收。整颗重放 → 用户看到
  前半句被重新输出一次（拼接后是一段胡话）。这是**输出正确性**问题，
  不是体验小瑕疵：模型输出被自己污染过一次，客服工单会算在平台头上。
- **下游的重复**：如果这个请求触发了工具/写操作（Agent 场景下 312 个里通常有几个），
  重放就是**二次副作用**（再退一笔款、再发一条消息）。这是资损问题。
  推理侧幂等与工具侧幂等是两套账，必须分别保证 —— 只在网关去重挡不住工具层的重复执行。

顺带一个常被漏掉的第三种：**重复计费**。用户没收到答案却被扣了两次 token 费用，
这类问题往往在账单里几周后才被发现。

**2. 分桶处置（判据 = "已经推出去多少 + 有没有副作用 + 是不是高价值会话"）**

| 桶 | 判据 | 处置 | 代价 |
| --- | --- | --- | --- |
| A. 未开始输出 | 已推 token = 0 且未触发工具 | 直接重路由重放（用户侧只看到延迟） | 只有排队成本，可接受 |
| B. 少量已推 | 1-50 token 且无副作用 | 丢掉半截输出、从当前请求边界重发，并在 SSE 事件里带 `reset` 语义让客户端截断渲染 | 需要客户端配合；不配合就退化成 C |
| C. 大量已推 / 有副作用 | >50 token，或本轮调用过工具 | **不重放**。给客户端一个明确的流终止码 + 已推内容保留，允许用户点"继续"（用已推内容作为前缀续写，走 prefix cache） | 放弃一次自动恢复，换"绝不重复输出"。这是正确取舍 |
| D. 高价值长会话 | 上下文 >16K 且租户有 SLA | 走恢复队列：等待冷 KV 重建或调度到同模型空卡，可容忍分钟级 | 占用备用算力，需要配额上限 |

核心判断：**能重放的只有 A。**把 B/C/D 也自动重放，才是"用户有感知"的真正来源。
产品方"重跑就行"的说法在 A 桶成立，在其他三桶不成立。

**3. 两条路线的量级（算式对就行）**

**重算 prefill**：代价 = 重新跑 prompt 的算力。prefill 是 compute-bound，
粗略 `FLOPs ≈ 2·P·L`（P 参数量、L prompt token 数），除以集群有效算力 MFU。
6000 token 的 prompt 在几十 B 级 MoE 上通常是**几十到几百毫秒**量级 ——
也就是说：**短 prompt 场景下重算比搬 KV 便宜得多**。

**远端 KV 续推**：代价 = 搬运量。`KV 字节 ≈ 2 × 层数 × KV head × head_dim × 序列长度 × 字节数`。
以 61 层 / KV head 8 / head dim 128 / FP16 为例：每 token ≈ 4KB × 61 ≈ 244KB；
8K 上下文 ≈ 2GB，32K ≈ 8GB。
搬运时间 = 字节数 ÷ 有效带宽：2GB 走 25GbE（≈3GB/s）要 0.7s，走 400Gb/s 级 RoCE（≈50GB/s）要 0.04s。

**选哪条**的分水岭：
- 序列越长、prefill 算力越贵（大模型 + 长上下文）、网络越快 → 越偏向搬 KV；
- 序列短、网络只有 25GbE、或 KV 本来就在本地显存没外置 → 直接重算，甚至不如排队；
- **MLA 这类低秩 KV 会显著压低搬运量**，使续推的可行域变大（模型结构与系统架构不是独立决策）；
- 还有一条常被忽略：**冷 KV 落盘 + 重算混合**（存 block 校验和，只对缺失的块重算）
  —— 命中率高时两头的成本都省。

**4. 故障判定：宁可慢一点，不可错杀**

错杀的后果要先算清楚：把抖一下自愈的节点判成宕机 → 312 个请求级别的重放被触发一次
→ 大量"其实还活着"的会话被强制中断，**而且原节点还在原地继续跑完**，
形成双份推理与双份计费（如果工具没幂等，就是双份副作用）。这比延后 30s 恢复严重得多。

做法：

- **不把 TCP 断开当结论**，它只是观察。要有独立心跳通道（带外：控制面 gRPC 心跳 /
  节点 agent 上报），并与数据面探测分开。
- **两级判据**：软判（N 秒内多次探测失败 → 标记 degraded，**停止派发新请求**，
  但不终止在途）；硬判（软判 + 超时窗口 + 第二探测方视角 → 标记 dead，才允许重放）。
  "停派发"是低成本高收益动作，"终止在途"是最后一步。
- **多视角确认（quorum）**：至少网关 + 调度器两个独立组件都判失败；
  单一观察者分不清"节点死了"还是"我到它的路断了"（后者该修路不该杀节点）。
- **必须 fencing**：判 dead 之后要给旧节点一个不可变任期号（epoch/fencing token），
  保证它即使复活也不能继续往同一会话写 KV / 继续计费 —— 否则就是两个执行者同时输出。
- 观测上把两类计数分开：`node_suspected` / `node_confirmed_dead` / `recovered_without_action`，
  最后一个持续增长说明判定器在错杀，要收紧。

**5. 架构上只改一处**

推荐答案（任一处但要有论证，最能得分的是这条）：
**把"可续推"变成流式协议的一等公民** —— SSE 事件带 `(session_epoch, seq, request_id)`，
客户端按 seq 去重与截断，服务端遇到中断可以下发 `reset`/`resume` 而不是重连后糊在一起。
理由：它不解决 GPU 侧的算力问题，但它**一次性解掉 B/C 桶无解的困境**：
今天只能"要么重复输出要么放弃恢复"，是因为链路里没有幂等的输出坐标。
所有分桶策略里最难看的部分都源于此。

其它同样可辩护的选择：把 KV 外置到分级存储（把重算成本变成搬运成本，但要看网络代际）；
工具层强制 `Idempotency-Key`（解决副作用重复，但不解决可见重复）；
多副本 decode + 结果一致性投票（最贵，只对最高价值会话成立）。
答"加监控/加告警/双写"不给具体机制的，第 4、5 项不计分。"""

    return base(
        'hot-interviews', 'principal',
        'GPU 节点在 decode 中途失联：200 个请求已经推出去一半 token',
        statement, 'llm-rubric',
        ['fault-tolerance', 'streaming-sse', 'kv-cache', 'failure-detection', 'modern:inference-resilience'],
        src('DeepSeek', '推理平台 / 稳定性方向 技术专家',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#45,#48,#84（原文只答"重新调度到健康节点；本地 KV 丢失只能重启推理"，未处理已推送 token 与误判代价）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '拆开两个"无感知"', 'weight': 3,
             'criteria': '是否明确区分"用户可见的重复输出（SSE 不可回滚）"与"下游副作用/计费的重复"，并各自给出重放后果；把两者混为一谈即未命中'},
            {'label': '分桶处置与代价', 'weight': 2,
             'criteria': '是否按可观测状态（已推 token 数、有无副作用、会话价值）分桶给策略，并承认存在"不重放、让用户手动继续"这一档'},
            {'label': '重算 vs 续推的定量取舍', 'weight': 3,
             'criteria': '是否给出两条路线的代价算式（prefill FLOPs 量级 vs KV 字节数 ÷ 有效带宽），并说明长短序列、网络代际、MLA 压缩如何改变选择'},
            {'label': '误杀成本与故障判定', 'weight': 2,
             'criteria': '是否算清"把抖动节点判成宕机"的代价（双份推理/双份副作用），并给出软判停派发 + 硬判才重放、多视角确认、fencing 类机制'}
        ], 'notes': '架构改造项（第 5 问）计入第 2、4 项评分：只提"加监控"或"多副本"而无具体机制不得分。'
                    '量化只看算式与数量级，配置假设合理即可。'},
        estimatedMinutes=30,
        answer=answer,
    )


def main(argv):
    if '--list' in argv:
        for k in sorted(DRAFTS):
            print(k)
        return 0
    os.makedirs(OUT_DIR, exist_ok=True)
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, f'{key}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(fn(), f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'wrote {os.path.relpath(path, os.getcwd())}')
    # 生成后立刻自证：能被 json.load 读回，才算一份合法草稿
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print(f'全部 {len(DRAFTS)} 份草稿 JSON 可解析')
    return 0


# =================================================================== 多租户在途配额（redis）
@draft('sql-deepseek-tenant-quota')
def q_tenant_quota():
    statement = """## 背景

推理网关要做**多租户在途请求配额**：每个租户最多 `N` 个请求同时在 GPU 上跑，
超出的排队或拒绝。网关是多进程、多实例的，所以配额状态必须放在 Redis 里共享。

上线两周后出了一次事故：某租户的网关进程被 OOM killer 杀掉，**它持有的配额位没有释放**，
于是该租户永久占满配额、所有新请求全被拒 —— 重启也不自愈，只能人工清 key。

## 环境

Redis 7.2.7。**禁止** `EVAL`/`SCRIPT`/`KEYS`/`FLUSHDB`/`CONFIG`/`DEBUG`/`SORT`/`OBJECT` 等命令
（判题器会直接拒），所以"用 Lua 做原子判断"不在本题解空间内。

## 你要交付的东西

提交一段**命令序列**（每行一条，`#` 开头是注释），按顺序完成下面全部动作。
判题会在你的脚本跑完之后，逐条执行校验命令并比对结果 —— 也就是说它看的是**最终状态**，
不是你的解释。

固定的 key 规范与参数（必须照用，否则校验命令找不到你的数据）：

- 每个租户一个有序集合 `inflight:{tenant}`；
- **score = 该请求登记时刻的毫秒时间戳**，**member = 请求 id**（不是计数器，必须能追溯到是哪个请求）；
- 租户：`a`、`b`；配额上限本题不考（放行判断在应用层，脚本只负责记账）。

按顺序完成：

1. 清空 `inflight:a` 与 `inflight:b`（脚本要能重复执行而结果不变）；
2. 租户 a 登记 3 个在途请求：`r1`@1000、`r2`@2000、`r3`@3000；
3. 租户 b 登记 2 个：`q1`@1500、`q2`@2500；
4. **回收僵尸**：以"当前时刻 `now = 3500`、租约 `ttl = 1000`"为准，
   把两个租户里 `score <= 2500` 的条目当作已泄漏，全部清掉（边界含 2500 本身）；
5. 租户 a 再登记 `r4`@4000；
6. 给两个 key 各设 60 秒的兜底过期（防止租户彻底消失后 key 永久驻留）。

## 这题真正考的东西

- **`INCR`/`DECR` 计数器做不了这件事**。它只记"占了几个"，不记"是谁占的"，
  于是进程崩溃漏减之后**没有任何办法回收**（你不知道该减哪个、也不知道该减几个）。
  把"时刻"写进 score，僵尸就变成一段 `ZREMRANGEBYSCORE` 就能扫掉的范围 —— 自愈能力来自数据形状，不来自运维。
- **回收必须发生在登记之前**（真实网关里每次登记前都要先扫一遍），
  否则刚登记完就被自己的清理逻辑误删；本题按"先登记、再统一回收、再登记 r4"的顺序考，
  所以 `r4`（score 4000）必须活下来，而 `r3`（3000 > 2500）也要活下来。
- **边界含 2500**：`q2` 的 score 正好是 2500，按口径它算僵尸。
  用 `-inf (2500`  exclusive 写法会把 `q2` 留下，校验就会看到 `b` 还剩 1 个。
- **租户隔离靠 key 形状**，不靠"记得加前缀"：`a` 的 member 绝不能出现在 `b` 的集合里。"""

    reference = """# 幂等起手：脚本可重复执行
DEL inflight:a
DEL inflight:b
# 租户 a 登记 3 个在途请求（score = 登记时刻，member = 请求 id）
ZADD inflight:a 1000 r1
ZADD inflight:a 2000 r2
ZADD inflight:a 3000 r3
# 租户 b 登记 2 个
ZADD inflight:b 1500 q1
ZADD inflight:b 2500 q2
# 回收僵尸：now=3500、ttl=1000 ⇒ 阈值 2500，score <= 2500 视为已泄漏
ZREMRANGEBYSCORE inflight:a -inf 2500
ZREMRANGEBYSCORE inflight:b -inf 2500
# 新请求登记（必须在回收之后，否则会被自己的回收误删）
ZADD inflight:a 4000 r4
# 兜底过期：租户彻底消失后 key 不会永久驻留
EXPIRE inflight:a 60
EXPIRE inflight:b 60"""

    naive = """# 生产事故版：只记账，不回收 —— 进程一崩配额就永久泄漏
DEL inflight:a
DEL inflight:b
ZADD inflight:a 1000 r1
ZADD inflight:a 2000 r2
ZADD inflight:a 3000 r3
ZADD inflight:b 1500 q1
ZADD inflight:b 2500 q2
ZADD inflight:a 4000 r4
EXPIRE inflight:a 60
EXPIRE inflight:b 60"""

    answer = """## 参考答案

```
DEL inflight:a
DEL inflight:b
ZADD inflight:a 1000 r1
ZADD inflight:a 2000 r2
ZADD inflight:a 3000 r3
ZADD inflight:b 1500 q1
ZADD inflight:b 2500 q2
ZREMRANGEBYSCORE inflight:a -inf 2500
ZREMRANGEBYSCORE inflight:b -inf 2500
ZADD inflight:a 4000 r4
EXPIRE inflight:a 60
EXPIRE inflight:b 60
```

最终状态：`inflight:a = {r3@3000, r4@4000}`（2 个）、`inflight:b = {}`（0 个）。

**为什么这个数据形状能自愈**：`score` 是登记时刻，"泄漏"就等价于"score 落在过期区间里"，
于是回收是一条 O(log N + M) 的范围删除，不需要任何外部知识。
换成 `INCR quota:a` / `DECR quota:a` 的计数器方案，状态里**没有"谁占的、什么时候占的"**，
崩溃后既无法判断该减几，也无法区分"真在跑"与"早就死了" —— 只能人工介入。
本题的判分点其实就是这一条：**可回收性来自数据建模，不来自运维流程**。

**顺序为什么是"回收 → 再登记"**：真实网关每次放行前都要先扫一遍僵尸，
否则新登记的请求会被同一轮的清理逻辑删掉（尤其当 `ttl` 小于等于时钟抖动时）。
本题的 `r4`（score 4000）就是用来验证这一点的：先登记后回收的实现它会活着，
但如果实现把回收放在最后且阈值写错，它就可能被误删。

**边界**：`2500` 含在内 ⇒ `q2` 必须被清掉。
写成 `ZREMRANGEBYSCORE inflight:b -inf (2500` 会留下 1 个，校验立刻暴露。

**工程延伸（面试追问点）**

1. 没有 Lua 怎么做"检查 + 占位"的原子操作？（Redis 侧能做的是把两步压成一步：
   `ZADD ... GT`/`ZADD ... NX` 加条件、或用 `ZCARD` 后由应用层决定；
   真正的原子性要靠**幂等 + 冲突可检测**（member 用请求 id，重复登记不改变状态），
   而不是靠"读-改-写"看起来很快。）
2. 网关多实例并发登记会不会互相覆盖？（不会 —— `ZADD` 是按 member  upsert，
   这正是用 ZSET 而不是用单个 string 存"当前并发数"的原因。）
3. `ttl` 定多少？（它必须 **大于** 最长请求时间，否则会把还在跑的请求当僵尸删掉，
   配额被低估 → 过载；小于最长时间则回收不了。正确做法是"请求侧续租"（心跳 `ZADD` 更新 score），
   这样 `ttl` 只需大于心跳间隔，两者解耦。）
4. 配额要不要按模型/优先级分池？（要。`inflight:{tenant}:{model}:{priority}` 是常见形状；
   但一旦分池，"跨池借用"就需要第二层记账 —— 借用记录本身也要能自愈，别只给主池做回收。）
5. 怎么观测这套配额是不是在漏？（直接指标：`ZCARD` 与网关侧真实在途数的差值；
   以及"被回收的僵尸数" —— 它持续增长说明有进程在异常退出，那才是根因。）"""

    return base(
        'sql', 'senior',
        '多租户在途配额：用 ZSET 记"谁在跑"，让崩溃泄漏能自愈',
        statement, 'redis',
        ['rate-limiting', 'multi-tenancy', 'zset', 'lease-reclaim', 'modern:inference-gateway'],
        src('DeepSeek', '推理网关 / 平台工程 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#57,#30（原文只答"队列隔离、算力配额"，'
            '未给可判分的记账结构与回收语义）'),
        language='sql',
        cases=[
            {'name': '租户 a 最终在途 2 个（r3 与 r4 活下来）',
             'input': ['ZCARD inflight:a'], 'expected': 2,
             'note': 'r1@1000、r2@2000 是僵尸；r3@3000 > 2500 保留，r4@4000 在回收之后登记'},
            {'name': '租户 b 被清空：score 恰等于阈值的 q2 也算僵尸',
             'input': ['ZCARD inflight:b'], 'expected': 0,
             'note': '用 exclusive 上界 (2500 的写法会留下 1 个'},
            {'name': '回收必须真的发生：a 里不许残留 score <= 2500 的条目',
             'input': ['ZCOUNT inflight:a -inf 2500'], 'expected': 0},
            {'name': 'member 可追溯到请求 id（不是计数器）',
             'input': ['ZRANGE inflight:a 0 -1'], 'expected': ['r3', 'r4']},
            {'name': '租户隔离：b 的集合里不许出现任何东西（含 a 的请求）',
             'input': ['ZCOUNT inflight:b 0 +inf'], 'expected': 0},
            {'name': 'score 必须是登记时刻而不是占位值',
             'input': ['ZSCORE inflight:a r3'], 'expected': 3000},
        ],
        runner={'setup': ['DEL inflight:a', 'DEL inflight:b'],
                'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=18,
        answer=answer,
    )


# =================================================================== 多租户推理隔离（主观题）
@draft('hot-deepseek-tenant-isolation')
def q_tenant_isolation():
    statement = """## 场景

你负责一个多租户大模型推理平台。资源池是共享的（同一批 GPU 上跑所有租户），
平台对外承诺两类 SLO：

- **交互式租户**（对话，TTFT P99 < 2s）；
- **批量租户**（离线生成，只看吞吐，不看延迟）。

上周三 14:20，一个新签的大客户开始灌批量任务（每条 prompt 平均 24K token）。
14:26 起，三个交互式租户的 TTFT P99 从 1.1s 涨到 40s 以上，其中一个租约到期直接掉线。
事后复盘发现三件事：

1. 平台确实有"每租户 QPS 配额"，但那个大客户 QPS 一直很低（每分钟 40 次），**从没触发过配额**；
2. 显存在 14:24 就满了，之后所有新请求都在排队，包括交互式租户的；
3. 值班同学为了救交互式租户，手工把大客户从调度队列里摘了 —— 结果批量任务里
   **已经跑了一半的请求全部丢失**，客户索赔。

## 请回答

1. 这次的**配额模型错在哪**？请给出你认为正确的配额维度（不止一个），
   并说明每个维度分别挡住哪一类滥用。
2. 共享 GPU 池上，你要怎么做**资源隔离**？请按"排队 / 显存 / 算力 / 网络"分别说明，
   并明确指出哪些隔离是硬件能给的、哪些只能靠调度器软保证。
3. 过载时的**降级顺序**是什么？请给出一个可执行的策略（含"谁先被拒、谁被挤压、谁绝对不能动"），
   并说明"摘掉一个租户"和"让一个租户变慢"在实现上的差别。
4. 批量任务里"已经跑了一半"的请求，正确的处理是什么？
   请说明这对你的调度器设计提出什么要求。
5. 怎么让这类事故**下次不需要值班手工干预**？给出你的自动化闭环（检测 → 决策 → 动作 → 验证），
   并说明哪些环节你故意不做自动化、为什么。

"""

    answer = """## 参考答案要点

**1. 配额模型：QPS 是错的维度，因为它不表达"资源占用"**

推理服务的成本不在"请求数"，而在 **token × 时间**。这次事故的第一层根因就是
用 QPS 做配额：40 QPS × 24K token 的批量负载，等效于几千 QPS 的短对话负载。

正确的维度（至少四个，各自挡一类滥用）：

| 维度 | 挡住的滥用 |
| --- | --- |
| **在途 token 数**（prompt + 预计输出，即 KV 显存占用） | 少量超长请求打满显存（本次事故） |
| **每分钟消耗 token**（输入 + 输出分别计） | 中等频率长请求、以及"QPS 低但每请求巨大" |
| **并发在途请求数**（带租约回收，见 redis 版本题） | 客户端崩溃导致的配额永久泄漏 |
| **上下文长度上限 / 分档配额** | 单个请求把调度器最坏情况撑爆 |
| （派生）**排队等待时间预算** | 配额没用满但队列已堆积（下游变慢时最危险） |

加分点：**配额要按 (租户, 模型, 优先级) 三元组分池**，否则一个租户在便宜模型上的余量
会被它在贵模型上的滥用"借走"而没人发现。另一条：配额的**记账必须在准入时预扣**
（按 prompt 长度 + 预估输出），完成后按实际量结算，否则长请求期间额度是虚的。

**2. 隔离层次：哪些是硬件给的、哪些只能软保证**

- **排队**：每租户/每优先级独立队列 + 加权公平调度（WFQ/DRF 思路）。
  关键是**共享一个 GPU 池时，队列必须分开，否则"隔离"退化成"先到先得"**。
- **显存**：这是最硬的一层。可做的是**准入控制**（按 KV 块数预留，不足就不准入）+
  **池化配额**（每租户最多占 X% 的 KV block）。
  硬件级隔离只有 MIG（切分显存与 SM）能做到，但 decode 是带宽瓶颈，MIG 切分后带宽竞争反而更糟，
  所以**主力负载一般不用 MIG 做租户隔离**，只用来放小模型/embedding。
- **算力**：同一 step 内 prefill 与 decode 混跑时，用 **chunked prefill 的 token 预算**
  限制单步里 prefill 占比 ⇒ 交互式租户的 decode step 时间不被长 prefill 拖长。
  这是**软保证**，靠调度器纪律，不是硬件。
- **网络/RDMA**：跨池 KV 传输的带宽也要配额（PD 分离架构下，一个大客户的传输能把
  共享 RDMA 打满）。这一层最常被忽略。
- 诚实的结论：**GPU 上没有真正的"多租户硬件隔离"**（不像 CPU 的 cgroup + 内存 QoS）。
  所以隔离能力上限取决于调度器，而不是硬件；这也是推理平台要自研调度器的原因。

**3. 降级顺序：写死成配置，且必须可演练**

顺序（先牺牲"最可牺牲的"）：

1. **挤压批量租户的准入速率**（它只看吞吐，不看延迟 → 唯一可以无损变慢的一类）；
2. **拒绝超长上下文的新请求**（引导走离线通道 / 明确返回 413 + 建议），
   而不是让它进来把显存吃掉；
3. **降低交互式低优先级租户的并发**（让它们排队，但不掉线）；
4. **绝对不动**：已建立会话的租约、已产生输出的流式请求、付费合同中带"不可降级"条款的租户。

"摘掉一个租户"与"让一个租户变慢"的实现差别极大：

- 摘掉 = **撤销已准入请求的执行权** ⇒ 必须定义在途请求怎么收尾（见第 4 问）。
  值班手工摘除之所以造成索赔，是因为平台**没有"优雅驱逐"这个原语**，只有"kill"。
- 变慢 = 只影响**未来准入**，已准入的继续跑完 ⇒ 这才是可自动化的动作。
  正确设计：**降级动作只能作用于准入，不能作用于在途**（除非有明确的驱逐协议）。

**4. "已经跑了一半"的批量请求：要么可续，要么可弃，不能可丢**

三条出路，按成本排序：

- **让它跑完**（最省）：批量请求已经消耗了算力，中途丢弃是纯损失。
  所以调度器要有"**在途优先完成、只收紧新准入**"的不变量 —— 这正是第 3 问的结论。
- **可续推**：把已生成的 token 作为前缀保留（prefix cache / 落盘 KV），
  重新准入后从断点继续。要求请求有**幂等 id + 输出序号**，且 KV 可跨实例迁移或重算代价可接受。
- **可弃但要结算**：明确告诉调用方"这个请求被放弃了"，并保证**不重复计费**、
  不产生重复副作用。最忌讳的是"既不返回结果也不返回错误"（本次事故里客户看到的就是这个）。

对调度器的要求：**每个在途请求是一个有状态、可查询、可结算的对象**，
而不是"一个已经交给 GPU 的 future"。做不到这一点，任何降级动作都只能是破坏性的。

**5. 自动化闭环，以及故意不做自动化的地方**

```
检测：按 (租户, 优先级) 分维度的 TTFT/TPOT 分位数 + 队列等待 + KV 占用 + 准入拒绝率
      → 关键是"交互式租户的 SLO 违约"要能归因到"谁在消耗资源"（否则只能靠人猜）
决策：基于配额的自动降权（对超额租户收紧准入）+ 全局降级档位（0/1/2/3 档，每档有明确动作）
动作：只作用于准入与路由；驱逐类动作必须走"优雅排空"（drain）而不是 kill
验证：降级后 N 个窗口内 SLO 是否恢复；未恢复则升一档，并保留"回滚"路径
```

**故意不自动化的两处**（说清理由才给分）：

- **跨租户的资源再分配**（比如把大客户从共享池挪到独立池）：涉及合同与商务承诺，
  自动做等于工程替商务决策，必须人批。
- **对高价值租户的准入拒绝**：一次误判的代价可能是几十万的合同，
  宁可让它走"人工确认 + 半自动执行"。自动化的边界应该按**动作的可逆性与影响面**划，
  不按"哪个环节技术上能做"划。

另外必须有的：**降级档位要定期演练**（混沌注入长上下文洪峰），
否则真出事时没人知道第 2 档到底会发生什么 —— 这次事故里值班选择手工摘除，
本质上是因为**平台没有提供可用的降级动作**。"""

    return base(
        'hot-interviews', 'principal',
        '一个大客户灌 24K token 批量任务，把三个交互式租户的 TTFT 打到 40s',
        statement, 'llm-rubric',
        ['multi-tenancy', 'quota-design', 'degradation-order', 'fair-scheduling', 'modern:inference-platform'],
        src('DeepSeek', '推理平台 / 稳定性方向 技术专家',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#57,#51,#30,#87（原文各条只给一句话结论，'
            '未构成一个有事故、有取舍、有可执行降级顺序的完整设计题）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '配额维度纠正', 'weight': 3,
             'criteria': '是否指出 QPS 不表达资源占用，并给出至少两个正确维度（在途 token 数 / 每分钟 token 消耗 / 并发在途 / 上下文长度上限），说明各自挡哪类滥用；答"把 QPS 阈值调小"不得分'},
            {'label': '隔离层次与硬件边界', 'weight': 2,
             'criteria': '是否分排队/显存/算力/网络四层说明，并诚实指出 GPU 侧没有真正的多租户硬件隔离（MIG 因带宽瓶颈不适合主力负载），隔离上限取决于调度器'},
            {'label': '降级顺序与动作可逆性', 'weight': 3,
             'criteria': '是否给出可执行的牺牲顺序（批量先受压、超长上下文先拒、已建立会话不动），并区分"只收紧准入"与"撤销在途"两种动作的本质差别'},
            {'label': '在途请求的可续/可结算', 'weight': 1,
             'criteria': '是否说明中途丢弃是纯损失，给出"跑完 / 断点续推 / 放弃但结算"三条出路及其对调度器状态模型的要求'},
            {'label': '自动化闭环与不自动化的边界', 'weight': 1,
             'criteria': '是否给出检测→决策→动作→验证闭环，并按"可逆性与影响面"划出故意留人工的环节（跨租户资源再分配、高价值租户拒绝）'}
        ], 'notes': '只罗列"要做隔离、要做限流"而无具体维度与顺序的，第 1、3 项按 0 分；'
                    '把"值班手工摘除租户"当成正确处置的，第 3 项不得分。'},
        estimatedMinutes=35,
        answer=answer,
    )


# =================================================================== DeepSeek batch 3
_WINDOW_MODEL = '''
滑动窗口准入模型（gen.py 与 precheck.py 各写一遍，用来互相纠错）：
  窗口 (t - windowMs, t] 内**已放行**的请求数 < limit 才放行。
'''


@draft('alg-deepseek-admission-window')
def q_sliding_window_admission():
    """expected 全部由下面的 admitted() 算出 —— 这类边界题手算必错。"""

    def admitted(arrivals, limit, window):
        if limit <= 0:
            raise ValueError('limit must be positive')
        if window <= 0:
            raise ValueError('window must be positive')
        taken = []
        out = []
        prev = None
        for t in arrivals:
            if t < 0:
                raise ValueError('negative arrival')
            if prev is not None and t < prev:
                raise ValueError('arrivals must be non-decreasing')
            prev = t
            # 半开区间 (t-window, t]：恰好老了 windowMs 的那一条已经出窗
            while taken and taken[0] <= t - window:
                taken.pop(0)
            if len(taken) < limit:
                taken.append(t)
                out.append(True)
            else:
                out.append(False)     # 被拒的请求不占额度
        return out

    def case(name, arrivals, limit, window, throws=False, note=None):
        # throws 是声明不是推断：见 airbnb 的 case() 注释，同一类静默降级
        try:
            got = admitted(arrivals, limit, window)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [arrivals, limit, window],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [arrivals, limit, window], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

推理网关按租户限流。题库里的老实现是**固定窗口计数**（`count[now / window]`），
上线后监控显示"瞬时 QPS 偶尔是配置值的两倍"—— 因为窗口边界两侧各能填满一整窗。
现在换成精确的**滑动窗口**语义，你来实现判定函数。

## 你要实现的入口

```java
public static boolean[] admitted(long[] arrivalsMs, int limit, long windowMs)
```

按数组顺序处理每个到达时刻（毫秒），返回**逐条**的放行标记（`true` = 放行）。

## 语义（这些是判分点，不是建议）

1. 一条请求在时刻 `t` 可放行，当且仅当**已放行**且落在 `(t - windowMs, t]` 内的条数 `< limit`。
   注意是**半开区间**：比 `t` 恰好老 `windowMs` 的那一条已经出窗，不再占额度。
2. **被拒绝的请求不占额度**。只数放行的那几条。
3. `arrivalsMs` 允许同一毫秒内多条（并发突刺），但必须**非降序**出现。
4. `arrivalsMs` 为空 ⇒ 返回长度为 0 的数组。
5. 以下抛 `IllegalArgumentException`：`limit <= 0`、`windowMs <= 0`、
   到达时刻为负、`arrivalsMs` 逆序。
   最后一条不是凑数：网关的时钟是单调的，逆序意味着上游把两个实例的日志混在了一起 ——
   把它当成"合法输入"继续算，会静默放行一批本不该过的请求。

## 这题真正考的东西

- **窗口起点的开闭**：`a >= t - window` 与 `a > t - window` 只差一个等号，
  表现是"整点突刺时多拒一批"，而且**只在到达时刻恰好相差整窗时**暴露。
- **"数放行"与"数到达"的差别是自我惩罚**：把被拒的请求也算进窗口，一次突刺之后
  配额会被一批根本不存在于下游的"幽灵请求"占住，症状是"限流恢复得特别慢"，
  排查时人人都在看下游负载，没人怀疑计数器。
- **固定窗口为什么挡不住边界**：它的错误只在跨桶的那一批上出现，
  所以单看"稳态"用例是绿的 —— 用例必须专门造跨桶。

不许引入第三方依赖，不许用 `java.time`（判题只给毫秒整数）。"""

    reference = """import java.util.ArrayDeque;
import java.util.Deque;

public class Solution {
  public static boolean[] admitted(long[] arrivalsMs, int limit, long windowMs) {
    if (limit <= 0) throw new IllegalArgumentException("limit must be positive");
    if (windowMs <= 0) throw new IllegalArgumentException("window must be positive");
    boolean[] out = new boolean[arrivalsMs.length];
    Deque<Long> admittedStamps = new ArrayDeque<>();
    long prev = Long.MIN_VALUE;
    for (int i = 0; i < arrivalsMs.length; i++) {
      long t = arrivalsMs[i];
      if (t < 0) throw new IllegalArgumentException("negative arrival: " + t);
      if (i > 0 && t < prev) throw new IllegalArgumentException("arrivals must be non-decreasing");
      // 半开区间 (t - window, t]：恰好老一窗的那条已经出窗
      while (!admittedStamps.isEmpty() && admittedStamps.peekFirst() <= t - windowMs) {
        admittedStamps.pollFirst();
      }
      if (admittedStamps.size() < limit) {
        admittedStamps.addLast(t);      // 只登记放行的；被拒的不进窗口
        out[i] = true;
      }
      prev = t;
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // 线上跑了两年的那版：固定窗口计数
  public static boolean[] admitted(long[] arrivalsMs, int limit, long windowMs) {
    if (limit <= 0) throw new IllegalArgumentException("limit must be positive");
    if (windowMs <= 0) throw new IllegalArgumentException("window must be positive");
    boolean[] out = new boolean[arrivalsMs.length];
    long bucket = Long.MIN_VALUE;
    int count = 0;
    for (int i = 0; i < arrivalsMs.length; i++) {
      long t = arrivalsMs[i];
      long b = t / windowMs;
      if (b != bucket) {
        bucket = b;
        count = 0;                      // 换窗就清零 —— 跨边界的突刺就是这么漏的
      }
      if (count < limit) {
        out[i] = true;
        count++;
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

单调队列：按到达顺序推进，队首维护"已放行"的时间戳；对每个 `t` 先弹出所有
`<= t - windowMs` 的（半开区间，等号出窗），再判 `size < limit`；放行才入队。
`O(n)` 时间、`O(limit)` 空间。

```java
while (!q.isEmpty() && q.peekFirst() <= t - windowMs) q.pollFirst();
if (q.size() < limit) { q.addLast(t); out[i] = true; }
```

**逐条对拍固定窗口的漏算**（用例「跨桶边界：滑动窗口拒掉第 4 条」）：
到达 `[100,900,1100,1300]`、`limit=2`、`window=1000`。
- 滑动：100 放行；900 放行；1100 时 100 恰好出窗（`100 <= 1100-1000`）⇒ 窗口里只剩 900 ⇒ 放行；
  1300 时窗口 `(300,1300]` 里有 900、1100 ⇒ 已满 ⇒ 拒。共放行 **3** 条。
- 固定：`100/900` 落桶 0、`1100/1300` 落桶 1，各自从 0 开始数 ⇒ 放行 **4** 条。
  多放行的那一条就是监控上"瞬时 QPS 翻倍"的来源，而且它**只在跨桶时出现** ——
  所以拿稳态流量做压测是测不出来的。

**为什么被拒的不占额度**（用例「被拒的请求不占额度：限流要能立刻恢复」）：
`[0,90,105]`、`limit=1`、`window=100`。105 时刻窗口是 `(5,105]`，
只有 0 那一瞬进过窗口、且它已出窗 ⇒ 放行，结果 `true,false,true`。
如果把 90 那条被拒的也算进去（它落在 `(5,105]` 里），就会连 105 都拒掉 ——
限流器开始替下游"记住"自己挡掉的流量，恢复时间被拉长到 `limit × window`。

**等号的另一面**（用例「恰好相差一窗：老的已经出窗」）：`[0,1000]`、`limit=1`、`window=1000`
两条都放行。写成 `a >= t - window` 的实现会拒掉第二条。这一条在随机流量测试里几乎跑不到，
只有**故意造整倍差**才暴露 —— 所以这种用例必须手写，不能靠 fuzz。

**工程延伸（面试追问点）**

1. 为什么要精确滑动而不是令牌桶？（滑动窗口日志的额外空间是 `O(limit)`，`limit` 上千就不划算；
   令牌桶用 `O(1)` 空间换"允许 burst = capacity 的平滑限流"，但它的放行时刻与窗口口径不同。
   工程上常见的是 GCRA：同样 `O(1)`，而且能直接给出 `retry-after`。）
2. 多实例怎么共享这个窗口？（本地滑动窗口 + 全局 Redis 计数会双重限流；
   要么承认"每实例 limit = 总配额 / 实例数 + 抖动补偿"，要么把判定搬到一个协调层 —— 后者
   要面对协调层自己成为单点与延迟源。这道题的函数签名是"单实例视角"，面试时要主动说清边界。）
3. `retry-after` 怎么给？（就是队首那条的出窗时刻：`admittedStamps.peekFirst() + windowMs - now`。
   单调队列顺手就把这个指标免费给了 —— 又一个"别用计数数组"的理由。）
4. 逆序输入为什么宁可抛错？（静默按最大值推进窗口，等价于把一部分请求的额度凭空放大；
   抛错能被网关的降级路径接住，变成"拒绝这批"而不是"多放行一批"。）"""

    return base(
        'algorithms', 'senior',
        '滑动窗口限流：出窗用半开区间，被拒的请求不占额度',
        statement, 'java-junit',
        ['rate-limiting', 'sliding-window', 'off-by-one', 'inference-gateway', 'modern:llm-gateway'],
        src('DeepSeek', '推理网关 / 平台工程 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#19（原文只罗列"固定/滑动/令牌桶"三种名字，'
            '未给可判分的窗口口径与额度归属）'),
        language='java',
        cases=[
            case('跨桶边界：滑动窗口拒掉第 4 条', [100, 900, 1100, 1300], 2, 1000,
                 note='固定窗口这里放行 4 条 —— 就是"瞬时 QPS 翻倍"的事故现场'),
            case('恰好相差一窗：老的已经出窗', [0, 1000], 1, 1000,
                 note='a >= t-window 的实现会拒掉第二条'),
            case('被拒的请求不占额度：限流要能立刻恢复', [0, 90, 105], 1, 100,
                 note='数"到达"而不是数"放行"的实现这里给 false,false,false'),
            case('同一毫秒的并发突刺', [500, 500, 500], 2, 1000),
            case('窗口比整段流量还大：只放行前 limit 条', [0, 1, 2, 3, 4], 2, 10_000),
            case('limit 为 1：严格串行化', [0, 10, 19, 20, 30], 1, 10),
            case('稳态匀速：全部放行', [0, 500, 1000, 1500], 2, 500),
            case('退化：没有任何请求', [], 3, 1000),
            case('非法：limit 为 0', [0], 0, 1000, throws=True,
                 note='配额写 0 和"关掉这个租户"是两件事，必须炸'),
            case('非法：windowMs 为 0', [0], 2, 0, throws=True),
            case('非法：到达时刻逆序', [100, 50], 2, 1000, throws=True),
            case('非法：到达时刻为负', [-1, 10], 2, 1000, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'boolean[] admitted(long[] arrivalsMs, int limit, long windowMs)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


@draft('alg-deepseek-least-loaded-dispatch')
def q_least_outstanding_dispatch():
    """调度模拟器：expected 全部由 dispatch() 跑出来，不手推。"""

    def dispatch(starts, costs, durations, num_instances):
        if num_instances <= 0:
            raise ValueError('numInstances must be positive')
        if not (len(starts) == len(costs) == len(durations)):
            raise ValueError('length mismatch')
        loads = [0] * num_instances
        inflight = [[] for _ in range(num_instances)]   # 每实例 [(finishMs, cost)]
        out = []
        prev = None
        for s, c, d in zip(starts, costs, durations):
            if prev is not None and s < prev:
                raise ValueError('starts must be non-decreasing')
            prev = s
            if c <= 0:
                raise ValueError('cost must be positive')
            if d < 0:
                raise ValueError('duration must not be negative')
            if s < 0:
                raise ValueError('negative start')
            for i in range(num_instances):
                # finish <= start 就释放：同一毫秒做完 = 这一毫秒就能接新请求
                inflight[i] = [(f, k) for (f, k) in inflight[i] if f > s]
                loads[i] = sum(k for _, k in inflight[i])
            best = min(range(num_instances), key=lambda i: (loads[i], i))
            out.append(best)
            inflight[best].append((s + d, c))
            loads[best] += c
        return out

    def case(name, starts, costs, durations, n, throws=False, note=None):
        # throws 是声明不是推断：见 airbnb 的 case() 注释
        try:
            got = dispatch(starts, costs, durations, n)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [starts, costs, durations, n],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [starts, costs, durations, n], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

推理集群的路由不能按 QPS 分，因为**每个请求占 GPU 的时间与开销差一个数量级**：
一个 32K prompt 的 prefill 抵得上几百个短问答。所以调度口径是"在途开销最小"，
开销单位是抽象的 `costUnits`（prompt token 数 × 是否命中前缀缓存之类算出来的权重，本题只给数）。

## 你要实现的入口

```java
public static int[] dispatch(long[] startMs, int[] costUnits, long[] durationMs, int numInstances)
```

三个数组**按下标对齐**，表示第 i 个请求在 `startMs[i]` 到达、占 `costUnits[i]` 份开销、
跑 `durationMs[i]` 毫秒后结束。返回每个请求被派到的实例下标（0 起）。

## 调度规则（逐条按到达顺序执行）

1. 处理第 i 个请求前，**先释放**所有实例上 `finishMs <= startMs[i]` 的在途请求。
   注意是 `<=`：这一毫秒做完，这一毫秒就能接新请求。
2. 在剩下的实例里选**当前在途开销之和最小**的那个；**并列时选下标最小的**
   （判题要求确定性，别用 `HashMap` 顺序）。
3. 派过去：该实例的在途开销 `+costUnits[i]`，并记下它的结束时刻 `startMs[i] + durationMs[i]`。
   一个实例**同时在途可以有很多个**请求（continuous batching），不是"一个实例一次一个"。
4. 每个请求必须被派出，没有拒绝路径。

## 非法输入（抛 `IllegalArgumentException`）

`numInstances <= 0`；三个数组长度不一致；`startMs` 逆序；
`costUnits[i] <= 0`；`durationMs[i] < 0`；`startMs[i] < 0`。

## 这题真正考的东西

- **释放要扫全部在途，不是"最近那个做完的"**：同一实例上的结束时刻**不保证有序**
  （长请求先来、短请求后来是常态），只按入队顺序回滚会留下幽灵占用。
- **"在途数最少"与"在途开销最小"是两回事**：本题用例专门造了"一个实例扛 1 个大请求、
  另一个扛 2 个小请求"的分叉。
- **`<=` 与 `<`**：`finish == start` 时容量还不回来，是紧接排期的请求被误判"集群满了"的来源。

不许引入第三方依赖。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  public static int[] dispatch(long[] startMs, int[] costUnits, long[] durationMs, int numInstances) {
    if (numInstances <= 0) throw new IllegalArgumentException("numInstances must be positive");
    if (startMs.length != costUnits.length || startMs.length != durationMs.length) {
      throw new IllegalArgumentException("length mismatch");
    }
    List<long[]>[] inflight = new List[numInstances];   // 每个元素 {finishMs, cost}
    long[] load = new long[numInstances];
    for (int i = 0; i < numInstances; i++) inflight[i] = new ArrayList<>();
    int[] out = new int[startMs.length];

    for (int r = 0; r < startMs.length; r++) {
      long start = startMs[r];
      int cost = costUnits[r];
      long dur = durationMs[r];
      if (start < 0) throw new IllegalArgumentException("negative start");
      if (r > 0 && start < startMs[r - 1]) throw new IllegalArgumentException("starts must be non-decreasing");
      if (cost <= 0) throw new IllegalArgumentException("cost must be positive");
      if (dur < 0) throw new IllegalArgumentException("duration must not be negative");

      long bestLoad = -1;
      int best = -1;
      for (int i = 0; i < numInstances; i++) {
        long live = 0;
        List<long[]> keep = new ArrayList<>();
        for (long[] job : inflight[i]) {
          if (job[0] > start) {          // finish <= start 已完成 —— 半开区间释放
            keep.add(job);
            live += job[1];
          }
        }
        inflight[i] = keep;
        load[i] = live;
        if (best < 0 || live < bestLoad) {   // 严格小于 ⇒ 并列时保留更早的下标
          best = i;
          bestLoad = live;
        }
      }
      out[r] = best;
      inflight[best].add(new long[] {start + dur, cost});
      load[best] += cost;
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // "我们用 round-robin 很多年了"版
  public static int[] dispatch(long[] startMs, int[] costUnits, long[] durationMs, int numInstances) {
    if (numInstances <= 0) throw new IllegalArgumentException("numInstances must be positive");
    if (startMs.length != costUnits.length || startMs.length != durationMs.length) {
      throw new IllegalArgumentException("length mismatch");
    }
    int[] out = new int[startMs.length];
    int cursor = 0;
    for (int r = 0; r < startMs.length; r++) {
      if (costUnits[r] <= 0) throw new IllegalArgumentException("cost must be positive");
      if (durationMs[r] < 0) throw new IllegalArgumentException("duration must not be negative");
      if (r > 0 && startMs[r] < startMs[r - 1]) throw new IllegalArgumentException("starts must be non-decreasing");
      if (startMs[r] < 0) throw new IllegalArgumentException("negative start");
      out[r] = cursor;
      cursor = (cursor + 1) % numInstances;
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

给每个实例维护一张"在途清单"`[(finishMs, cost)]`。每次派发前先**整体重建**这张清单：
丢掉 `finish <= start` 的，剩下的求和就是实时负载；取最小负载（并列取下标最小）。
`O(n × numInstances × avgInflight)`。

关键的两处形状：
- 释放条件写成 `job[0] > start` 才**保留**，等价于 `finish <= start` 就回收 —— 与"半开区间"口径对齐；
- 选实例用 `live < bestLoad` 严格比较，天然给出"并列取最小下标"，不需要额外 tie-break 分支。

**为什么必须扫全部在途**（用例「同一实例的结束时刻不保证有序」）：
实例上先派了一个 20ms 的长请求、后派了一个 5ms 的短请求，结束时刻就是
`[+20, +5]` —— 队列顺序与完成顺序不一致。若实现成"从队头弹到第一个还没完成的就停"，
`+5` 那条完成之后 `+20` 挡住它、`+5` 永远弹不掉，幽灵占用单调增长，
症状是"跑久了所有实例看起来都满载"，而且**重启就好**，最难归因的一类问题。

**开销加权与"请求数最少"的分叉**（用例「大 prompt 要压过两个小请求」）：
实例 0 在途 1 条 cost=100，实例 1 在途 2 条 cost 各 1。按条数会选实例 1，
按开销会选实例 0 —— 本题口径是后者。真实集群里这两种选法的 P99 差距可以超过 2 倍，
因为大请求把实例锁住的时间长，小请求排队会互相叠加。

**`<=` 的落点**（用例「finish 恰等于 start：同一毫秒就接新请求」）：
`n=2`，第 0 条在实例 0 上跑 100ms 结束于 100，第 1 条 `start=100` ⇒ 实例 0 已经空出来，
并列时又取下标最小 ⇒ 还是 0。写成 `<` 的实现会算出实例 1。
这条用例是"紧接排期"的场景，在真实流量里不是稀有事件而是**大多数**。

**工程延伸（面试追问点）**

1. 这个模拟器离真调度器还差什么？（差三样：请求时长**未知**（要靠 prompt 长度 + 模型
   的生成步数分布估）、决策有**冷启动与迁移成本**（KV Cache 亲和性会把"最小负载"实例
   的代价抬高，于是变成负载与缓存亲和的加权）、以及实例数会**动态变化**。
   面试时主动把这三条说出来，比把模拟写对更值钱。）
2. 前缀缓存亲和与负载均衡冲突怎么办？（常见做法：把"同一前缀家族"的请求哈希到
   一个**候选小池**（k 个实例），在池内取最小负载 —— 一致性哈希 + 小池，
   而不是全局 least-loaded。本题的签名退化成池大小为全部实例。）
3. 为什么要确定性 tie-break？（可复现性：调度不确定会让"线上复现不了"成为常态，
   也让离线回放对不上。并列取最小下标是最便宜的答案，但要注意它会**系统性偏向前面的实例**，
   空集群启动时流量全砸实例 0 —— 真系统会加一个随机或轮转的第二关键字。）
4. `costUnits` 怎么估？（prefill 近似正比于 prompt token 数（命中前缀缓存的部分另算），
   decode 近似正比于**预计生成长度**，两者对 GPU 的占用曲线完全不同 —— 这也是
   PD 分离那一题的入口：把 prefill 和 decode 放同一套 cost 里加权，本身就是一种口径妥协。）"""

    return base(
        'algorithms', 'senior',
        '推理集群派发：按在途开销选实例，结束时刻要扫全部在途而不是只看队头',
        statement, 'java-junit',
        ['load-balancing', 'llm-inference', 'simulation', 'half-open-interval', 'modern:inference-scheduling'],
        src('DeepSeek', '推理平台 / 调度 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#29,#44（原文只答"最小连接数/加权轮询"，'
            '未给"开销异构 + 多在途并发"下的可判分口径）'),
        language='java',
        cases=[
            case('大 prompt 要压过两个小请求', [0, 1, 2, 3], [100, 1, 1, 1], [1000, 1000, 1000, 1000], 2,
                 note='按"在途条数最少"选会给出 0,1,0,0 —— 开销口径才是本题口径'),
            case('finish 恰等于 start：同一毫秒就接新请求', [0, 100], [5, 5], [100, 10], 2,
                 note='用 finish < start 判释放的实现会把第 2 条派到实例 1'),
            case('同一实例的结束时刻不保证有序：必须扫全部在途', [0, 1, 2, 50], [1, 1, 1, 5], [20, 5, 100, 1], 2,
                 note='队头回滚版在 t=50 时看不到实例 0 已经空出来'),
            case('并列取下标最小（空集群启动）', [0, 100, 200], [1, 1, 1], [10, 10, 10], 3,
                 note='三条各自都落在空闲的实例 0 上 —— 这是最小负载口径的已知副作用'),
            case('一个实例可以同时在途多个请求', [0, 0, 0], [1, 1, 1], [100, 100, 100], 2,
                 note='三条同时到：0,1,0 —— "一个实例一次一个"的实现会给 0,1,?'),
            case('duration 为 0：下一毫秒立刻可复用', [5, 6], [1, 1], [0, 0], 2),
            case('退化：单实例单请求', [123], [7], [45], 1),
            case('退化：没有请求', [], [], [], 3),
            case('非法：numInstances 为 0', [0], [1], [1], 0, throws=True),
            case('非法：三个数组长度不一致', [0, 1], [1], [1, 1], 2, throws=True,
                 note='对齐错位比抛错危险得多 —— 它会派出一个不存在的请求'),
            case('非法：cost 为 0', [0], [0], [10], 2, throws=True),
            case('非法：duration 为负', [10], [1], [-1], 2, throws=True),
            case('非法：到达时刻逆序', [10, 5], [1, 1], [1, 1], 2, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] dispatch(long[] startMs, int[] costUnits, long[] durationMs, int numInstances)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== DeepSeek batch 3 续（redis / SSE）
@draft('sql-deepseek-stampede-lock')
def q_stampede_lock():
    statement = """## 背景

热点 key 过期的一瞬间，成百上千个请求同时发现"缓存没有"，一起打向数据库 —— 这就是缓存击穿。
标准解法是 **single-flight**：只让一个请求去回源，其余的直接等。
听起来一句话，真正出事的是三处细节：**抢锁用的命令、回填用的命令、释放锁的条件**。

## 环境

Redis 7.2.7。**禁止** `EVAL`/`SCRIPT`/`FCALL`/`KEYS`/`FLUSHDB`/`CONFIG`/`DEBUG`/`SORT`/`OBJECT`/`SELECT`
（判题器直接拒），所以"用 Lua 做 owner 校验"不在本题解空间内。

## 判题方式（先读这段）

判题**不模拟并发，也不让时间流逝**。它做三件事：
1. 按下面的"初始状态"把 Redis 摆好；
2. 按顺序执行你提交的**这一份命令脚本**（每行一条，`#` 开头是注释）；
3. 逐条执行校验命令并比对最终状态。

所以：你写的是"针对这个已知场景的一段安全脚本"，而**每一条会改状态的命令都必须自己带上条件**
（`NX` / `XX`），因为脚本里没有"先读再判断"的分支可用。
TTL 判题器读不到（它没法等），但下面的规则仍然要求你写 —— 那是真实事故的原因。

## 初始状态

```
cache:user:1 = v1            （命中，且 lock:user:1 = owner-b 正被别人持有）
cache:user:2 = __EMPTY__     （空值哨兵：DB 里确认没有这个用户）
cache:user:3 = v3            （存在，lock 空闲）
cache:user:4 不存在           （首次回源，lock 空闲）
cache:user:5 不存在           （房源刚下架被淘汰，本次是后台预热）
```

## 同一毫秒到达的 5 个事件（必须全部处理）

| 事件 | 情况 | 必须发生 | 绝对不许发生 |
| --- | --- | --- | --- |
| R1 | `user:1` **缓存命中**，但顺手想抢 `lock:user:1` 去刷新 | 尝试抢锁且**抢不到** | 覆盖 `lock:user:1` 的值；删掉 `lock:user:1`；回填 `cache:user:1` |
| R2 | `user:2` 读到空值哨兵 | 什么都不做（直接返回"不存在"） | 删掉哨兵；把它当成"未缓存"去回源并覆盖 |
| R3 | `user:3` 需要回源刷新 | 抢到 `lock:user:3` → 回填新值 → **释放自己那把锁** | 回填后忘记释放（其余请求 5 秒内全被挡） |
| R4 | `user:4` 缓存里没有，首次回源 | 抢到 `lock:user:4` → 回填 → 释放 | 回填时用 `XX`（key 本来就不存在，会被静默丢掉） |
| R5 | 后台预热 `user:5`，它可能已经被下架淘汰 | **只做原地刷新**：key 还在才写 | 用普通 `SET` 把已下架的 key 复活 |

回填的值与 TTL 由你定，但校验命令会读这几个确定值，**必须照用**：
`cache:user:3` 回填 `v3-refreshed`，`cache:user:4` 回填 `v4-fetched`；
两个锁都用 token `arena-t1` / `arena-t3` / `arena-t4`（对应 R1/R3/R4），锁 TTL 5 秒，缓存 TTL 300 秒。

## 这题真正考的东西

1. **抢锁必须是条件写**：`SET lock:k v EX 5` 与 `SET lock:k v EX 5 NX` 的差别，
   就是"人人都以为自己是那个回源的人"。
2. **不许删不属于自己的锁**：R1 抢锁失败，如果它结尾照例 `DEL lock:user:1`，
   就把 `owner-b` 正在用的锁删了 —— 于是第三个请求又能抢进来，击穿照旧发生，
   而且**监控上看锁的命中率还是正常的**。这是三个经典事故里最难查的一个。
3. **空值哨兵是防穿透的，不是脏数据**：把它删掉等于把"DB 里根本没有"这个事实丢掉，
   下一次同样不存在的 id 又来打 DB。
4. **`NX` 与 `XX` 用反方向**：R4 用 `XX` 会静默不写（症状是"缓存永远填不上"），
   R5 用普通 `SET` 会复活已下架数据（症状是"下架的房源还能下单"）。

只交一段命令脚本，不需要写代码。"""

    reference = """# R1：缓存命中 + 锁被别人占着 —— 条件抢锁会失败，这正是我们要的结果
SET lock:user:1 arena-t1 EX 5 NX
# （不许 DEL lock:user:1：那把锁不是我们的；也不许回填 cache:user:1）

# R2：空值哨兵 —— 一个命令都不发，直接按"不存在"返回

# R3：抢到锁 → 回填 → 只释放自己确知持有的那把
SET lock:user:3 arena-t3 EX 5 NX
SET cache:user:3 v3-refreshed EX 300
DEL lock:user:3

# R4：首次回源，key 本来不存在 ⇒ 必须普通 SET（XX 会静默丢掉）
SET lock:user:4 arena-t4 EX 5 NX
SET cache:user:4 v4-fetched EX 300
DEL lock:user:4

# R5：预热不许复活已下架的 key ⇒ XX = 只刷新还在的
SET cache:user:5 v5-warm EX 300 XX"""

    naive = """# "照抄博客"版：三步都写，但每步都不带条件
SET lock:user:1 arena-t1 EX 5
SET cache:user:1 v1-refreshed EX 300
DEL lock:user:1
DEL cache:user:2
SET lock:user:3 arena-t3 EX 5
SET cache:user:3 v3-refreshed EX 300
SET lock:user:4 arena-t4 EX 5
SET cache:user:4 v4-fetched EX 300
SET cache:user:5 v5-warm EX 300"""

    answer = """## 参考答案

```
SET lock:user:1 arena-t1 EX 5 NX     # 抢不到 ⇒ 什么都不做
# R2：一个命令都不发
SET lock:user:3 arena-t3 EX 5 NX
SET cache:user:3 v3-refreshed EX 300
DEL lock:user:3
SET lock:user:4 arena-t4 EX 5 NX
SET cache:user:4 v4-fetched EX 300
DEL lock:user:4
SET cache:user:5 v5-warm EX 300 XX   # 已下架 ⇒ 不复活
```

**R1 之后 `GET lock:user:1` 必须还是 `owner-b`、`EXISTS lock:user:1` 必须是 1。**
这两条断言打在同一个事故上：抢锁失败的人走了"抢不到也照样往下走"的路径 ——
裸 `SET` 把别人的 token 换成自己的（覆盖），或者 `finally { DEL }` 把别人的锁删了（误删）。
两者都会让 single-flight **看起来在工作**：锁一直存在、一直有人抢，
但同一时刻其实有多个请求在回源。这就是"缓存击穿修了三次还在"的原因。

**为什么脚本里没有 owner 校验也敢说安全**：这段脚本是**为这一个场景写死的** ——
`DEL lock:user:3` 之所以正确，是因为同一个脚本里前面那条 `SET ... NX` 在这个初始状态下必然成功。
线上不是这样：条件写之后要分支，Redis 侧没有分支，所以真实系统只有三条路 ——
① `EVAL` 里做 `if redis.call('GET',KEYS[1])==ARGV[1] then DEL`（本题禁掉了，考的就是你知道该禁）；
② 锁本身换成**可比较的数据结构**：`ZADD lock 1 <reqId>` 抢、`ZREM lock <reqId>` 放，
   天然只删自己的成员，还顺手支持"最多 N 个回源名额"；
③ 干脆不释放，靠 TTL 到期 —— 代价是回源成功后仍有 TTL 秒的等待窗口。
第 ② 条是这套题里最值得答出来的：它把"owner 校验"从流程问题变成了**数据建模**问题。

**空值哨兵为什么不能删**：`cache:user:2 = __EMPTY__` 记录的不是数据，是"DB 里确认没有"这个事实。
删掉它，下一次同一个不存在的 id（爬虫扫号段时会成千上万次）又会走完
"缓存 miss → 抢锁 → 回源 → DB 说没有 → 不写缓存"，等于对同一个问题反复打 DB —— 这是**穿透**，
和击穿是两件事：击穿是"有一个热 key 过期"，穿透是"查的 key 根本不存在，缓存救不了"。

**`NX` / `XX` 用反的两种症状**（R4 / R5）：
R4 用 `XX` 时 key 不存在 ⇒ 写不进去 ⇒ 缓存永远是空的，每个请求都回源，
而锁也被正常释放，**日志上一切正常**，只有 DB QPS 涨了。
R5 用普通 `SET` 时把下架的 key 写回去 ⇒ 脏数据复活，下游按"这是可订的"处理。
两个方向都要求"回填命令本身带条件"，而不是靠调用方记住自己是谁。

**判分点之外必须做到的两件事**（判题读不到，但面试要主动说）：
1. 回填写 `EX` 而不是裸 `SET`：没有 TTL 的缓存条目永远不会再更新，
   "回源成功但忘带过期"是永久脏数据，比击穿更难查。
2. TTL 加抖动（`300 + rand(0, 60)`）：同一个批处理灌进去的 key 若共享同一个 TTL，
   会在同一时刻集体过期 —— 那是**雪崩**，它和击穿的区别是"一次性影响一批 key"。
   真实系统还会再加一层"逻辑过期"：值里存 `expireAt`，过期后仍返回旧值、异步刷新，
   用一点点数据新鲜度换掉整个等待窗口。

**工程延伸（面试追问点）**

1. 为什么不用互斥锁而用"等待-重试"？（回源方之外的请求可以短暂 sleep 后重读缓存；
   但重试次数与退避必须封顶，否则 DB 慢的时候这些重试会自己变成一场放大攻击。）
2. 抢锁失败但持有者挂了怎么办？（TTL 就是给它准备的 —— 所以 TTL 必须 **大于** P99 回源耗时，
   小于"用户能接受的等待"。这两个约束冲突时，说明回源路径本身要拆：
   把最慢的那一段挪到异步，别让它坐在锁里。）
3. 怎么知道这套机制在起作用？（盯三个数：single-flight 的**合并比**（回源次数 / miss 次数）、
   锁等待超时率、以及空值哨兵的命中率。合并比接近 1 说明锁没起作用。）
4. 多级缓存下这题怎么变？（本地 LRU + Redis + DB：击穿要**在每一级都做**，
   否则本地层会绕过 Redis 的锁。常见做法是把回源权收在一层，其它层只做只读复制。）"""

    return base(
        'sql', 'senior',
        '缓存击穿的 single-flight：抢不到锁的人不许删锁，回填必须带条件',
        statement, 'redis',
        ['cache-stampede', 'distributed-lock', 'negative-cache', 'conditional-write',
         'modern:cache-integrity'],
        src('DeepSeek', '推理平台 / 缓存与存储 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#6,#7（原文把击穿/穿透/雪崩背成三段定义，'
            '"Redis 分布式锁的缺陷"只答了"锁误删"一句；未做成可判分条件）'),
        language='sql',
        cases=[
            {'name': '抢锁失败的人不许覆盖别人的锁',
             'input': ['GET lock:user:1'], 'expected': 'owner-b',
             'note': '裸 SET 会把它改成 arena-t1 —— 覆盖后 owner-b 再也释放不了自己的锁'},
            {'name': '抢锁失败的人更不许删掉别人的锁',
             'input': ['EXISTS lock:user:1'], 'expected': 1,
             'note': 'finally 里无条件 DEL 的实现这里给 0；这是击穿修了三次还在的根因'},
            {'name': '没抢到锁就不该回源：命中的缓存值保持原样',
             'input': ['GET cache:user:1'], 'expected': 'v1'},
            {'name': '空值哨兵必须留着（它是防穿透的，不是脏数据）',
             'input': ['EXISTS cache:user:2'], 'expected': 1,
             'note': '把哨兵 DEL 掉 = 下一次同一个不存在的 id 再打一遍 DB'},
            {'name': 'R3 释放了自己的锁（否则 5 秒内该 key 无人能回源）',
             'input': ['EXISTS lock:user:3'], 'expected': 0},
            {'name': 'R3 的回填真的落盘了', 'input': ['GET cache:user:3'],
             'expected': 'v3-refreshed'},
            {'name': '首次回源不能被 XX 静默丢掉：R4 的值必须在',
             'input': ['GET cache:user:4'], 'expected': 'v4-fetched',
             'note': 'R4 用 SET ... XX 时这里返回 nil —— 症状是"缓存永远填不上"而日志一切正常'},
            {'name': '预热不许复活已下架的 key',
             'input': ['EXISTS cache:user:5'], 'expected': 0,
             'note': '普通 SET 会把它写成 1 —— 下架的房源又能下单'},
        ],
        runner={'setup': [
            'DEL cache:user:1 cache:user:2 cache:user:3 cache:user:4 cache:user:5',
            'DEL lock:user:1 lock:user:3 lock:user:4',
            'SET cache:user:1 v1',
            'SET cache:user:2 __EMPTY__',
            'SET cache:user:3 v3',
            'SET lock:user:1 owner-b',
        ], 'entry': 'function', 'timeoutMs': 10000,
            'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


@draft('fe-deepseek-sse-frames')
def q_sse_stream_frames():
    """期望值与测试文件同源生成：模型算一遍，测试断言直接抄模型的结果。"""
    import re

    def frames(chunks):
        if chunks is None:
            raise ValueError('chunks must be an array')
        buf = ''
        for c in chunks:
            if c is None:
                raise ValueError('chunk must be a string')
            buf += c
        # 行分隔符三种都合法；必须先拼接再切，否则 CRLF 会被 chunk 边界劈开
        lines = re.split(r'\r\n|\r|\n', buf)
        out = []
        data = []
        saw_data = False
        for line in lines:
            if line == '':
                if saw_data:                 # 空行才派发
                    out.append('\n'.join(data))
                data = []
                saw_data = False
                continue
            if line.startswith(':'):         # 心跳注释
                continue
            field, sep, value = line.partition(':')
            if sep and value.startswith(' '):
                value = value[1:]            # 只剥一个空格
            if field == 'data':
                data.append(value)
                saw_data = True
        return out                           # 结尾未闭合的事件丢弃（buf 已消费完，不残留）

    def ts(value):
        # JSON 的字符串字面量恰好是合法的 TS 字面量，转义规则也一致
        return json.dumps(value, ensure_ascii=False)

    specs = [
        ('基线：两个完整事件', ['data:hello\n\ndata:world\n\n'], None),
        ('CRLF 被劈在两个 chunk 之间：不许留下尾的 \\r',
         ['data:tok\r', '\n\r\n'], None),
        ('注释心跳不产生事件', [': keep-alive\n', 'data:tok\n\n'], None),
        ('只剥掉冒号后的一个空格', ['data:  two-space-start\n\n'],
         None),
        ('同一事件里的多条 data 用换行拼接', ['data:line1\ndata:line2\n\n'], None),
        ('结尾没有空行收束的半截事件必须丢弃', ['data:full\n\ndata:part'], None),
        ('只有 event 字段不构成事件', ['event:done\nid:7\n\n'], None),
        ('裸 data 行（没有冒号）派发空字符串', ['data\n\ndata\n\n'], None),
        ('单独的 \\r 也是行分隔符', ['data:part1\rdata:part2\r\r'], None),
        ('退化：没有任何 chunk', [], None),
        ('只有分隔符：零个事件', ['\n\n\n'], None),
        ('一个 token 被劈成两半：必须跨 chunk 拼接', ['data:ab', 'cd\n\n'], None),
        ('非法：chunks 为 null', None, 'chunks must be an array'),
        ('非法：某个 chunk 为 null', ['data:a\n\n', None], 'chunk must be a string'),
    ]

    cases = []
    for name, chunks, err in specs:
        # 注意：specs 里的 chunks 就是"函数的第一个实参"本身（可为 None），
        # 这里统一再包一层数组喂给判题器的 input 约定。上一版把 None 写成 [None]，
        # 于是"整个入参为 null"与"某个元素为 null"两条用例测的是同一件事。
        if err:
            cases.append({'name': name, 'input': [chunks], 'expected': None,
                          'expectThrow': 'Error', 'throwMessage': err})
        else:
            cases.append({'name': name, 'input': [chunks], 'expected': frames(chunks)})

    test_lines = [
        "import { describe, expect, it } from 'vitest';",
        "import { sseFrames } from './Solution';",
        '',
        '/**',
        ' * 期望值由 gen.py 里的同一套 SSE 模型算出后**直接写进断言**，',
        ' * 不再手抄一遍 —— 上一批题出现过"用例名与实际值对不上"的漂移，单向修等于没修。',
        ' */',
        "describe('sseFrames：跨 chunk 的 SSE 增量解析', () => {",
    ]
    for c in cases:
        arg = ts(c['input'][0])
        test_lines.append(f"  it({ts(c['name'])}, () => {{")
        if c.get('expectThrow'):
            # 断言到**消息**上：只写 toThrow() 的话，"抛错了东西"也算过 ——
            # 上一版就是这样让两条语义不同的用例测了同一件事。
            test_lines.append(
                f"    expect(() => sseFrames({arg} as unknown as string[]))"
                f".toThrow({ts(c['throwMessage'])});")
        else:
            test_lines.append(f"    expect(sseFrames({arg})).toEqual({ts(c['expected'])});")
        test_lines.append('  });')
    test_lines.append('});')
    test_file = '\n'.join(test_lines)

    statement = """## 背景

模型是流式吐字的：网关用 SSE 把 token 一段一段推给浏览器。网络 chunk 的边界
**不保证落在行边界上** —— 一个 `\\r\\n` 可以被劈成两个 chunk，一个 token 也可以。
按"每个 chunk 各自 `split('\\n')`"实现的解析器，在生产里会在偶发位置留下脏字符。

## 你要实现的入口

```ts
export function sseFrames(chunks: string[]): string[]
```

输入是**按到达顺序**拼接的原始 SSE 文本片段，返回值是**已派发事件**的 data 载荷（按事件顺序）。

## 解析规则（按 WHATWG SSE 的简化子集，逐条都是判分点）

1. 先把所有 chunk **拼成一整段**再切行。行分隔符三种都合法：`\\r\\n`、`\\n`、单独的 `\\r`。
2. **空行派发一个事件**：把该事件缓冲的若干条 `data` 值用 `\\n` 连接，作为一个结果返回。
3. 以 `:` 开头的行是注释（网关用它发心跳），整行忽略，且**不算**事件内容。
4. `field:value`：冒号后**恰好一个**前导空格属于分隔符的一部分，要被剥掉；
   第二个空格属于值本身（`data:  x` 的值是 `" x"`）。
5. 只有 `data` 字段进入返回值。`event:` / `id:` / `retry:` 等字段本题忽略，
   而且**只含这些字段的事件不派发**（`data` 缓冲为空 ⇒ 没有内容可给 UI）。
6. 没有冒号的行（裸 `data`）等价于 `data:`，值是空字符串 —— 它会让事件带一个空 payload 派发。
7. 输入结束时如果还有**没有被空行收束**的事件，必须**丢弃**：流被截断时不能把半截 token
   当成一条完整消息渲染（渲染半截 JSON 是这类组件最常见的线上事故）。
8. `chunks` 为 `null`，或其中某个元素为 `null` ⇒ `throw new Error(...)`。
   静默把 `null` 当空串处理，会让"网关挂了"看起来像"模型说了个空回复"。

## 这题真正考的东西

- **chunk 边界**：`'data:tok\\r'` + `'\\n\\r\\n'` 是**一个完整事件**，
  而按 chunk 各自切行的实现会得到值 `"tok\\r"`。
- **`\\r` 的三种角色**：作为 `\\r\\n` 的一半、作为独立行分隔符、以及被错误地留在值里。
- **截断语义**：结尾少一个空行 ⇒ 少一个事件。这条在"用户中途关页面 / 连接被掐"时才会遇到，
  所以几乎不会被 happy-path 手测覆盖。

不许引入第三方依赖（`eventsource-parser` 之类不在沙箱里）。"""

    reference = """function splitLines(text: string): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\r') {
      lines.push(cur);
      cur = '';
      if (text[i + 1] === '\\n') i++;      // CRLF 是一行结束，不是两行
      continue;
    }
    if (ch === '\\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  lines.push(cur);
  return lines;
}

export function sseFrames(chunks: string[]): string[] {
  if (chunks == null) throw new Error('chunks must be an array');
  let text = '';
  for (const chunk of chunks) {
    if (chunk == null) throw new Error('chunk must be a string');
    text += chunk;
  }

  const out: string[] = [];
  let data: string[] = [];
  let sawData = false;

  for (const line of splitLines(text)) {
    if (line === '') {                      // 空行 = 派发
      if (sawData) out.push(data.join('\\n'));
      data = [];
      sawData = false;
      continue;
    }
    if (line.startsWith(':')) continue;     // 心跳注释

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;                         // 裸字段名 ⇒ 值为空串
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line[colon + 1] === ' ' ? line.slice(colon + 2) : line.slice(colon + 1);
    }
    if (field === 'data') {
      data.push(value);
      sawData = true;
    }
  }
  // 循环结束后剩下的 data 缓冲是**没有被空行收束的半截事件**，按规则丢弃
  return out;
}"""

    naive = """export function sseFrames(chunks: string[]): string[] {
  if (chunks == null) throw new Error('chunks must be an array');
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk == null) throw new Error('chunk must be a string');
    // 每个 chunk 各自切行：CRLF 被劈开时留下尾 \\r，跨 chunk 的 token 被当成两个事件
    for (const line of chunk.split('\\n')) {
      if (line.startsWith('data:')) {
        out.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  return out;
}"""

    answer = """## 参考答案要点

**先拼接、再按状态机切行**：`\\r\\n` / `\\n` / `\\r` 三种行结束符，`\\r` 后面紧跟 `\\n`
时要一起吃掉（`if (text[i + 1] === '\\n') i++;`）。事件缓冲只在遇到空行时派发，
输入结束时的残留缓冲直接丢。`O(总字符数)` 时间、`O(最长事件)` 额外空间。

**为什么"每个 chunk 各自 split"是错的**（用例「CRLF 被劈在两个 chunk 之间」）：
`'data:tok\\r'` + `'\\n\\r\\n'` 拼起来是 `data:tok\\r\\n\\r\\n` —— 一个完整事件，值 `"tok"`。
按 chunk 切：第一段 `split('\\n')` 得到 `['data:tok\\r']`，值里带一个 `\\r`；
第二段得到 `['\\r','\\r','']`，`startsWith('data:')` 不成立 ⇒ 什么都没有。
于是 UI 上那行文本的尾部多了一个回车 —— 它不会报错，只会在**复制粘贴**或
`JSON.parse` 增量结果时炸开，也就是"偶发的、只在部分浏览器/部分网络下"的线上问题。

**为什么 chunk 边界不该影响语义**（用例「一个 token 被劈成两半」）：
`'data:ab'` + `'cd\\n\\n'` 必须给 `['abcd']`。逐 chunk 处理的实现这里给 `['ab']` ——
它把半截事件派发出去了。这正是"跨 chunk 状态"必须存在的理由：
**chunk 是网络的切法，事件是协议的切法，两者没关系。**

**剥空格的细节**（用例「只剥掉冒号后的一个空格」）：
规范说冒号后的**一个**空格属于分隔符。`data:  x` ⇒ `" x"`。
用 `trim()` 或 `trimStart()` 会把值本身的前导空格吃掉 —— 对代码 token 流来说，
行首缩进就是内容，这条会静默毁掉模型输出的代码块。

**丢弃半截事件**（用例「结尾没有空行收束的半截事件必须丢弃」）：
`data:full\\n\\ndata:part` 只给 `['full']`。流被掐断时把 `part` 渲染出去，
如果客户端在拼 JSON，就得到一个不完整的对象 —— 而它看起来像模型说完了。
（真实做法：连接中断时显式给 UI 一个"回复被截断"状态，而不是悄悄少一段。）

**`null` 要抛错**：`null` chunk 多半意味着上游返回了非 SSE 的响应体（网关 502 页面对方
是 HTML 或被代理改写成 null）。当成空串处理 = 把"链路坏了"渲染成"模型回了一句空话"。

**工程延伸（面试追问点）**

1. 这个函数在真流式里怎么改？（变成增量解析器：`feed(chunk): string[]` 内部保留
   "最后一个可能不完整的行"作为 leftover，`\\r` 结尾时还要保留"下一个字符可能是 `\\n`"这一个比特的状态。
   先拼接再切的写法每次 feed 都是 `O(n²)`。这是本题最容易忽略的一点：
   它把**内存复制**当成了免费的东西，而 token 流的长度是用户输入长度的数倍。）
2. 为什么不直接用 `EventSource`？（它不能带 `Authorization` 头、不能自定义重连与
   中断控制、也不能走 fetch 的 `ReadableStream`。生产上的 LLM 客户端一律是自己解析。）
3. 多字节字符被劈开怎么办？（本题输入已是解码后的字符串，所以不会。真实流式里
   `TextDecoder` 必须开 `{stream: true}`，否则 UTF-8 的中文字符跨 chunk 会变成 `U+FFFD` ——
   症状是"中文偶发乱码"，和解析器无关，但同一份代码里要一起防。）
4. `id:` / `retry:` 与 `event:` 的缓冲语义？（规范里它们也参与"事件是否派发"的判断，
   且 `event:` 决定 `MessageEvent.type`。本题为了可判分，简化成"没有 data 就不派发" ——
   面试时说清这个简化，比假装规范就是这样写的更好。）"""

    return base(
        'frontend', 'senior',
        'SSE 增量解析：chunk 边界不是事件边界，半截事件不许派发',
        statement, 'react-vitest',
        ['sse', 'streaming', 'chunk-boundary', 'parser', 'modern:llm-streaming'],
        src('DeepSeek', '推理服务 / 客户端与网关 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#41（原文只答"SSE 是什么、比 WebSocket 轻"，'
            '未给跨 chunk 解析与截断语义的判分点）'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'sse.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== DeepSeek batch 4
@draft('alg-deepseek-circuit-breaker')
def q_circuit_breaker():
    """三态迁移的期望值由 decide() 逐条重放算出。状态机最容易写错的是"谁进窗口"。"""

    CLOSED, OPEN, HALF = 0, 1, 2

    def decide(now, outcome, window, min_calls, fail_threshold, open_ms, probe_limit):
        n = len(now)
        if any(len(x) != n for x in (now, outcome)):
            raise ValueError('length mismatch')
        if window <= 0 or open_ms <= 0 or min_calls <= 0 or probe_limit <= 0:
            raise ValueError('non-positive threshold')
        if fail_threshold <= 0 or fail_threshold > min_calls:
            raise ValueError('failureThreshold must be in [1, minCalls]')
        for i, o in enumerate(outcome):
            if o not in (0, 1):
                raise ValueError('outcome must be 0 or 1')
        for i in range(1, n):
            if now[i] < now[i - 1]:
                raise ValueError('time must be non-decreasing')

        state = CLOSED
        opened_at = 0
        probes_done = 0
        recorded = []            # (t, outcome) —— 只记**放行**的调用
        out = []

        for i in range(n):
            t = now[i]
            if state == OPEN:
                if t < opened_at + open_ms:
                    out.append(0)                   # 被拒的调用不许进任何统计
                    continue
                state = HALF
                probes_done = 0
                recorded = []
            if state == HALF:
                if probes_done >= probe_limit:
                    out.append(0)
                    continue
                out.append(1)
                probes_done += 1
                if outcome[i] == 1:                 # 一次失败就打回 OPEN，冷却从此刻重算
                    state = OPEN
                    opened_at = t
                    probes_done = 0
                elif probes_done == probe_limit:    # 探测全成才闭合
                    state = CLOSED
                    recorded = []
                continue
            # CLOSED
            out.append(1)
            recorded.append((t, outcome[i]))
            recorded = [(rt, ro) for (rt, ro) in recorded if rt > t - window]
            total = len(recorded)
            failures = sum(1 for _, ro in recorded if ro == 1)
            if total >= min_calls and failures >= fail_threshold:
                state = OPEN
                opened_at = t
                probes_done = 0
                recorded = []
        return out

    def case(name, now, outcome, window, min_calls, fail_threshold, open_ms, probes,
             throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 的同名注释）。"""
        try:
            got = decide(now, outcome, window, min_calls, fail_threshold, open_ms, probes)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name,
                       'input': [now, outcome, window, min_calls, fail_threshold, open_ms, probes],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name,
                       'input': [now, outcome, window, min_calls, fail_threshold, open_ms, probes],
                       'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

推理服务对下游依赖（tokenizer 服务、路由表、向量库）做熔断。手册里 #20 的标准答案是
"错误率超阈值就打开、冷却后半开探测、成功就闭合" —— 三句话，但**每句话都有一个能让线上
反复雪崩的实现细节**。本题要你把这三句话写成一个可重放的状态机。

## 你要实现的入口

```java
public static int[] decide(long[] nowMs, int[] outcome, long windowMs, int minCalls,
                           int failureThreshold, long openMs, int probeLimit)
```

按数组顺序重放每一次调用，返回逐条的 **`1` = 放行 / `0` = 拒绝**。
`outcome[i]` 是这次调用**如果发生**的结局（`0` 成功 / `1` 失败）——
它是给判题器看的模拟输入：被拒绝的调用照样有这一项，而你的实现**不许**把它计入任何统计。

## 状态机（逐条都是判分点）

初始 `CLOSED`。

- **CLOSED**：一律放行。放行之后把 `(时刻, 结局)` 记进窗口，
  窗口是半开区间 `(t - windowMs, t]`（恰好老了 `windowMs` 的那条已经出去）。
  记完之后判定：若**窗口内记录数 ≥ `minCalls`** 且**失败数 ≥ `failureThreshold`**
  ⇒ 转 `OPEN`，`openedAt = t`，并**清空窗口记录**。
  样本不足时**不许跳闸** —— 哪怕窗口里全是失败。
- **OPEN**：一律拒绝，直到 `t >= openedAt + openMs`；
  到达该时刻的**这一次调用本身**就是第一个探测（先转态、再判定）。
- **HALF_OPEN**：最多放行 `probeLimit` 个探测，探测的结局立即生效（本题的调用是瞬时的）。
  - 任一探测失败 ⇒ 立刻回 `OPEN`，且 **`openedAt` 用这次失败的时刻**（冷却从此刻重算），
    探测计数清零 —— **不必**等名额用完；
  - 累计 `probeLimit` 个探测**全部成功** ⇒ 回 `CLOSED`，清空窗口记录，探测计数清零。

## 非法输入（抛 `IllegalArgumentException`）

两根数组长度不一致；`nowMs` 逆序；`outcome` 不是 0/1；
`windowMs <= 0`、`openMs <= 0`、`minCalls <= 0`、`probeLimit <= 0`、`failureThreshold <= 0`；
`failureThreshold > minCalls`（这条不是凑数：它使得跳闸条件永远无法成立，
等于配了一个"看起来有保护其实永远不保护"的熔断器 —— 必须在构造期就拒掉）。

不许引入第三方依赖。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  private static final int CLOSED = 0, OPEN = 1, HALF = 2;

  public static int[] decide(long[] nowMs, int[] outcome, long windowMs, int minCalls,
                             int failureThreshold, long openMs, int probeLimit) {
    if (nowMs.length != outcome.length) throw new IllegalArgumentException("length mismatch");
    if (windowMs <= 0 || openMs <= 0 || minCalls <= 0 || probeLimit <= 0 || failureThreshold <= 0) {
      throw new IllegalArgumentException("non-positive threshold");
    }
    if (failureThreshold > minCalls) {
      throw new IllegalArgumentException("failureThreshold must be within minCalls");
    }
    for (int i = 0; i < nowMs.length; i++) {
      if (outcome[i] != 0 && outcome[i] != 1) throw new IllegalArgumentException("bad outcome");
      if (i > 0 && nowMs[i] < nowMs[i - 1]) throw new IllegalArgumentException("time goes backwards");
    }

    int state = CLOSED;
    long openedAt = 0;
    int probesDone = 0;
    List<long[]> window = new ArrayList<>();             // {时刻, 结局}，只放**放行**的调用
    int[] out = new int[nowMs.length];

    for (int i = 0; i < nowMs.length; i++) {
      long t = nowMs[i];
      if (state == OPEN) {
        if (t < openedAt + openMs) {
          out[i] = 0;
          continue;                                       // 被拒的调用一个字节都不进统计
        }
        state = HALF;                                     // 这一次就是第一个探测
        probesDone = 0;
        window.clear();
      }
      if (state == HALF) {
        if (probesDone >= probeLimit) {
          out[i] = 0;
          continue;
        }
        out[i] = 1;
        probesDone++;
        if (outcome[i] == 1) {
          state = OPEN;
          openedAt = t;                                   // 冷却从这次失败重算
          probesDone = 0;
        } else if (probesDone == probeLimit) {
          state = CLOSED;
          window.clear();
        }
        continue;
      }

      out[i] = 1;
      window.add(new long[] {t, outcome[i]});
      window.removeIf(e -> e[0] <= t - windowMs);
      int total = window.size();
      int failures = 0;
      for (long[] e : window) {
        failures += (int) e[1];
      }
      if (total >= minCalls && failures >= failureThreshold) {
        state = OPEN;
        openedAt = t;
        probesDone = 0;
        window.clear();
      }
    }
    return out;
  }

}"""

    naive = """public class Solution {
  // "错误数超阈值就打开"版：没有半开名额、不看样本量、被拒的调用也计入统计
  public static int[] decide(long[] nowMs, int[] outcome, long windowMs, int minCalls,
                             int failureThreshold, long openMs, int probeLimit) {
    if (nowMs.length != outcome.length) throw new IllegalArgumentException("length mismatch");
    if (windowMs <= 0 || openMs <= 0 || minCalls <= 0 || probeLimit <= 0 || failureThreshold <= 0) {
      throw new IllegalArgumentException("non-positive threshold");
    }
    if (failureThreshold > minCalls) {
      throw new IllegalArgumentException("failureThreshold must be within minCalls");
    }
    java.util.Deque<Integer> window = new java.util.ArrayDeque<>();
    java.util.Deque<Long> stamps = new java.util.ArrayDeque<>();
    boolean open = false;
    long openedAt = 0;
    int[] out = new int[nowMs.length];

    for (int i = 0; i < nowMs.length; i++) {
      long t = nowMs[i];
      while (!stamps.isEmpty() && stamps.peekFirst() <= t - windowMs) {
        stamps.pollFirst();
        window.pollFirst();
      }
      if (open) {
        if (t >= openedAt + openMs) {
          open = false;                     // 直接闭合 —— 没有任何探测
        } else {
          out[i] = 0;
          window.addLast(outcome[i]);       // 错：把被拒的调用也算进窗口
          stamps.addLast(t);
          continue;
        }
      }
      out[i] = 1;
      window.addLast(outcome[i]);
      stamps.addLast(t);
      int failures = 0;
      for (int o : window) {
        failures += o;
      }
      if (failures >= failureThreshold) {   // 错：不看 minCalls，一次抖动就能打跳
        open = true;
        openedAt = t;
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

三个状态 + 两份计数器：`window`（只装**放行**的调用，半开区间过期）与 `probesDone`。
CLOSED 放行后先入窗再判定；OPEN 到点先转 HALF 再判定，于是"到点的那一次"就是第一个探测；
HALF 里一次失败立刻回 OPEN 并把 `openedAt` 推到**这次失败的时刻**。

**"被拒的调用不许进统计"是这台机器能不能自愈的关键**
（用例「打开期间的失败不污染窗口」）：
把拒绝也算成失败，则打开期间窗口被自己灌满失败，冷却一到就再次跳闸 ——
熔断器变成**振荡器**，症状是"下游明明已经好了，流量却一直在断"。
这也正是为什么 `outcome[i]` 对被拒的调用必须被读都不读。

**没有半开探测 = 把恢复变成一个赌局**（用例「冷却边界：差 1ms 仍拒，到点那一次就是第一个探测」）：
`open=false` 直接闭合的版本，恢复瞬间全部流量一起打上刚活过来的下游 ——
这叫**雷群**，而下游通常是"被这次熔断救活的"，它撑不住第二下。
`probeLimit` 存在的意义就是把恢复的斜率限制住。

**闭合时必须清空窗口**（用例「闭合时清空窗口：老的失败不许参与下一次判定」）：
窗口记录的是"这次熔断周期里的证据"。恢复之后还留着上一周期的失败，
下一个请求一失败就立刻满足跳闸条件 —— 表现为"恢复后越来越容易跳闸"，
而监控上熔断次数确实在涨，容易被误诊成"下游在恶化"。

**样本不足不许跳闸**（用例「样本不足：全失败也不跳闸」）：
低峰期窗口里只有 1 个请求，它失败了就跳闸 ⇒ 熔断器在流量最稀少的时候最敏感，
而那个时段恰恰是"一次网络抖动"最不值当为此停机的时候。
`minCalls` 是**统计显著性**的门槛，不是可调优的装饰参数 ——
所以 `failureThreshold > minCalls` 必须在构造期拒掉：那个配置让跳闸条件永假，
上线时会给人"配了熔断"的错觉。

**冷却边界是 `>=`，半开失败要重算 `openedAt`**（用例「半开探测失败：立刻重开，且冷却从失败那一刻重算」）：
`t == openedAt + openMs` 就该放行探测（用 `>` 会多拒一批，而下游恢复的时刻是不可控的，
于是"多拒一批"在图上表现为毛刺，谁也说不清是不是熔断器的锅）。
半开失败后如果 `openedAt` 还用老值，那么下一次调用立刻又满足"冷却已过" ⇒ 探测无限放行，
等于 `probeLimit` 失效。

**工程延伸（面试追问点）**

1. 为什么不用错误率而用"失败数 + 样本量"两个阈值？（比率在样本少时方差极大。
   要比率就写成 `failures * 100 >= rate * total && total >= minCalls`，
   别用整数除法。推理场景还要分开看：**连接失败**该熔断，**超时**常常只是排队，
   把它算成失败会把"容量不足"误判成"依赖坏了"。）
2. 探测请求该带什么？（带真实流量还是带合成探针各有利弊：真实流量能验证端到端但会伤到用户，
   合成探针安全但验不到下游的真实负载。常见折中是"探测用最高优先级的小请求 + 结果只用于状态机，
   不计入 SLO"。）
3. 自适应并发（Vegas/梯度）能替掉它吗？（能替一半：梯度算法在"延迟上升"时降并发，
   比"错误数"更早，但它没有"完全拒绝"这个档位，且对**硬故障**（进程挂了）反应慢。
   生产上通常两层都要：快速自适应控流 + 慢速熔断保命。）
4. 熔断状态要不要跨实例共享？（共享会把一台机器的误判扩散成全集群；
   不共享则每个实例独立探测，恢复期总请求量 = probeLimit × 实例数，可能反而把下游打回去。
   判据是"探测预算要按集群总量算"，所以要么共享状态、要么把 `probeLimit` 除以实例数。）"""

    return base(
        'algorithms', 'senior',
        '熔断器三态迁移：被拒的调用不进统计、半开只放探测、失败重算冷却',
        statement, 'java-junit',
        ['circuit-breaker', 'state-machine', 'backpressure', 'resilience',
         'modern:inference-gateway'],
        src('DeepSeek', '推理网关 / 稳定性 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#20（原文只答"熔断/降级的定义与作用"，'
            '未给可判分的状态迁移与统计口径）'),
        language='java',
        cases=[
            case('基线：跳闸 → 冷却中拒一次 → 到点探测成功 → 闭合',
                 [0, 1, 2, 99, 100, 101], [1, 1, 1, 1, 0, 0], 1000, 3, 2, 98, 1,
                 note='t=2 凑满 3 个样本且失败数达 2 ⇒ openedAt=2、冷却到 100；'
                      '99 拒、100 就是第一个探测（成功即闭合）、101 已恢复正常放行'),
            case('样本不足：全失败也不跳闸',
                 [0, 500, 900], [1, 1, 1], 1000, 4, 3, 100, 1,
                 note='窗口里始终不足 4 个样本 ⇒ 一条都不拒（低峰期一次抖动不该停机）'),
            case('打开期间的失败不污染窗口',
                 [0, 1, 2, 50, 60, 200, 201], [1, 1, 1, 1, 1, 0, 0], 1000, 3, 2, 100, 1,
                 note='50/60 被拒（OPEN 中）；把被拒项算进窗口的实现会在 200 处再次跳闸'),
            case('冷却边界：差 1ms 仍拒，到点那一次就是第一个探测',
                 [0, 1, 100, 101], [1, 0, 0, 0], 1000, 2, 1, 100, 1,
                 note='openedAt=1 ⇒ 冷却到 101；100 拒、101 放行并探测成功 ⇒ 用 > 的实现两处都错'),
            case('冷却未到：一律拒（outcome 是"本来会发生什么"，不许读）',
                 [0, 1, 100], [1, 0, 1], 1000, 2, 1, 200, 1,
                 note='openedAt+openMs=201 ⇒ 100 时刻仍在 OPEN；那一项 outcome=1 必须被忽略'),
            case('半开探测失败：立刻重开，且冷却从失败那一刻重算',
                 [0, 1, 101, 150, 250], [1, 1, 1, 1, 0], 1000, 2, 1, 100, 1,
                 note='101 探测失败 ⇒ openedAt=101（不是 1）⇒ 150 仍在冷却被拒，250 才再探测'),
            case('半开两个名额：第二次失败同样立刻重开，不必凑满名额',
                 [0, 1, 101, 102, 150, 202], [1, 1, 0, 1, 0, 0], 1000, 2, 1, 100, 2,
                 note='101 成功占 1 个名额，102 失败即重开 ⇒ openedAt=102 ⇒ 150 拒、202 再探测'),
            case('闭合时清空窗口：老的失败不许参与下一次判定',
                 [0, 1, 101, 202, 203, 250], [1, 1, 1, 0, 1, 0], 1000, 2, 1, 100, 1,
                 note='202 闭合。不清空窗口的实现在 203 就看到 (1,1)+(203,1) 两个失败 ⇒ 又跳闸，'
                      '250 被拒；清空之后窗口里只有 203 一条 ⇒ 全程放行'),
            case('窗口是半开区间：恰好老了 windowMs 的那条不占样本',
                 [0, 1, 1000], [1, 1, 1], 1000, 3, 3, 100, 1,
                 note='t=1000 时 t=0 那条已出窗 ⇒ 只剩 2 个样本 < minCalls=3 ⇒ 不跳闸。'
                      '把过期写成 >= 的实现这里会凑满 3 个失败并跳闸'),
            case('全成功：一条都不拒',
                 [0, 1, 2, 3], [0, 0, 0, 0], 1000, 2, 1, 100, 1),
            case('退化：没有任何调用', [], [], 1000, 2, 1, 100, 1),
            case('非法：failureThreshold 大于 minCalls',
                 [0], [1], 1000, 2, 3, 100, 1, throws=True,
                 note='这个配置让跳闸条件永远为假 —— 必须在构造期拒，不能让它在上线后"看起来有保护"'),
            case('非法：两根数组长度不一致', [0, 1], [1], 1000, 2, 1, 100, 1, throws=True),
            case('非法：outcome 不是 0/1', [0], [2], 1000, 2, 1, 100, 1, throws=True),
            case('非法：时间倒流', [10, 5], [1, 1], 1000, 2, 1, 100, 1, throws=True),
            case('非法：probeLimit 为 0', [0], [1], 1000, 2, 1, 100, 0, throws=True,
                 note='0 个探测名额 = 打开之后永远回不来'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] decide(long[] nowMs, int[] outcome, long windowMs, int minCalls, '
                             'int failureThreshold, long openMs, int probeLimit)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== LLM 网关的可观测契约（主观题）
@draft('hot-deepseek-gateway-observability')
def q_gateway_observability():
    statement = """## 场景

你接手了一个日均 40 亿次补全调用的 LLM 网关（对外 API，多租户，流式为主）。
现状是三件让人睡不着的事：

1. **出了事故说不清是谁的锅**。上上周一次"整体变慢"，值班查了 40 分钟才定位到
   是某个租户的长上下文批量任务把公共 prefill 池占满 —— 期间没有任何一条告警指向它。
2. **成本账对不平**。财务按 token 出账，工程按请求算容量，两边每月差异 3%~5%，
   没人能解释差异来自哪。
3. **模型升级的效果说不清**。换了一个 tokenizer 之后"平均输入长度下降 12%"，
   看起来是好事，但没人能回答"是真的输入变短了，还是同样的文本被切得更碎了"。

## 你要回答的问题

请给出这个网关的**可观测性设计**，要求具体到能落地：

1. 一次补全请求的生命周期该切成哪些阶段？每个阶段要记哪些指标与属性？
   （提示：从"请求进入网关"到"最后一个 token 发出"，中间不止一次排队。）
2. 上面三件事各自靠哪些指标发现、靠哪些字段定位？请分别给出**能在 5 分钟内回答**的形式。
3. 指标基数（cardinality）是这个设计里最先爆炸的东西。列出你**必须**带的维度、
   **可以**合并的维度、以及**绝对不许**进标签的字段，并说明爆炸时的降级顺序。
4. 流式请求的"成功率"怎么定义？给出一个不会被实现细节钻空子的定义，
   并说明它至少拆成哪几个子失败模式。
5. 采样：40 亿/天的量不可能全量存明细。给出你的采样策略，
   并说明它如何让第 2 问里的三个事故**仍然可查**（这是采样的唯一验收标准）。
6. 你会**故意不做**哪一项看起来该做的观测？为什么？"""

    return base(
        'hot-interviews', 'senior',
        'LLM 网关的可观测契约：阶段划分、基数预算、流式成功率与采样验收标准',
        statement, 'llm-rubric',
        ['observability', 'llm-gateway', 'cardinality', 'streaming-slo', 'sampling'],
        src('DeepSeek', '推理平台 / 可观测性 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#49,#55,#60（原文只罗列"要监控 TTFT/吞吐/'
            'GPU 利用率"与网关功能清单，未给可判分的阶段划分、基数预算与采样验收标准）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '阶段划分覆盖"排队"而不是只有计算', 'weight': 1,                  'criteria': '是否把一次请求至少切成：网关准入/鉴权、路由与负载均衡、'
                             '调度队列等待（**prefill 队列与 decode 队列要分开**）、'
                             'prefill 计算、逐 token 生成、流式回传（含客户端侧网络），'
                             '并说明每段的关键字段（等待时长、队列深度、命中前缀缓存的 token 数、'
                             '生成 token 数、结束原因 finish_reason）。'
                             '只答"记录 TTFT 和总耗时"的，本项最多 1 分 —— '
                             '因为第 1 件事故恰恰要求把"排队"从"计算"里拆出来。'},
                {'label': '三件事各自给出可 5 分钟回答的查询形式', 'weight': 3,                  'criteria': '①公共池被占：必须有"按租户 × 模型 × 队列"的**在途 token 占用**（不是 QPS）'
                             '与 Top-K 贡献者排名，才能直接指出是哪个租户；'
                             '②成本对不平：必须让"计费口径"与"容量口径"来自**同一份明细事件**'
                             '（每请求一条含 prompt/completion token、缓存命中、模型版本、租户），'
                             '并给出两边对账的差异定位路径；'
                             '③tokenizer 变更：必须能区分"文本真的变短"与"切分粒度变了"'
                             '（同时记字符数与 token 数，看**字符/token 比**而不是单看 token 长度）。'
                             '第 ③ 条最能区分做过与听过 —— 只答"看平均长度"的此项不得过半。'},
                {'label': '基数预算有明确三档与降级顺序', 'weight': 2,                  'criteria': '必须带的：模型/版本、租户（数量有限）、阶段、结束原因；'
                             '可以合并的：请求长度分桶（而不是精确长度）、地理按大区分桶；'
                             '绝对不许进标签的：request_id、user_id、prompt 内容或其哈希、'
                             '任何高基数自由文本。并且要给出**基数爆炸时的降级顺序**'
                             '（先砍最细的分桶维度→再降采样率→再只保留异常样本），'
                             '而不是一句"控制基数"。'},
                {'label': '流式成功率的定义能挡住三类钻空子', 'weight': 1,                  'criteria': '定义必须包含：客户端中途断开（**不能算成功也不能算失败，要单列**）、'
                             '生成到一半被截断（finish_reason=length vs stop vs 内部错误要分开）、'
                             '首 token 已到但后续卡死（**超时/心跳丢失**必须判为失败，'
                             '否则"连接活着"会掩盖"生成死了"），'
                             '以及 HTTP 200 + 错误体的伪成功。'
                             '至少拆成 3 个子失败模式并各给一个指标名。'},
                {'label': '采样策略以"事故仍可查"为验收标准', 'weight': 2,                  'criteria': '必须给出**分层/加权**而非均匀随机：慢请求（P99 尾部）与失败请求全采，'
                             '错误与超时的样本永不丢弃；按租户配额保底采样（否则小租户永远看不见）；'
                             '保留 trace 的**整链一致抽样**（不能同一请求采了 prefill 丢了 decode）；'
                             '明细走可回溯的采样 id + 冷存储，指标侧仍用全量聚合。'
                             '并且明确"采样的唯一验收标准是第 2 问的三个事故仍然能在 5 分钟内回答"，'
                             '否则就是按存储预算随便砍。'},
                {'label': '主动砍掉一项并给出依据', 'weight': 1,                  'criteria': '是否给出一项被砍的常见观测（例如"每个 token 都打点"、'
                             '"全量 prompt 明文落库"、"给每个请求建一条指标时间线"、'
                             '"按分钟粒度看所有维度"）并说明代价与替代方案。'
                             '只说"暂时不做"而无代价判断的不得分。'},
            ],
            'notes': '本题的失败信号（任一条命中则总分不超过 5）：'
                     '把"可观测性"答成"接一个 APM/加日志"；'
                     '所有指标都建立在 QPS 上而全文没有"在途 token / 队列等待"这一维度；'
                     '把客户端断开算成成功；'
                     '用"平均输入长度"论证 tokenizer 变更是收益而没有提字符数口径；'
                     '采样答成"按比例抽样"且不区分失败与慢请求。',
        },
        estimatedMinutes=40,
        answer="""## 参考答案要点

**阶段划分（问题 1）**：网关准入 → 鉴权/限流 → 路由选实例 → **prefill 队列等待** →
prefill 计算 → **decode 队列等待** → 逐 token 生成 → 流式回传。
两条队列必须分开：事故 ① 的根因是"公共 prefill 池被长上下文任务占满"，
如果指标里只有一个"排队时间"，就永远无法把它归因到"哪一段队列、被谁占"。
关键字段：每段耗时、队列深度、`prompt_tokens` / `cached_prompt_tokens` / `completion_tokens`、
`finish_reason`、模型版本、tokenizer 版本。

**事故 ① 的 5 分钟路径**：指标必须是"**在途 token 占用**"（租户 × 模型 × 阶段）而不是 QPS。
推理服务的资源消耗与 QPS 弱相关、与 token 强相关 —— 一个 32K 上下文的任务约等于
几百个短请求。有了这个指标，Top-K 排名直接指出租户。

**事故 ② 的对账路径**：计费口径与容量口径必须来自**同一份 per-request 明细事件**。
两边差异的唯一来源只能是"事件丢失或重复"（而不是口径差异），
并且把"缓存命中的 token 是否计费""流式被截断的部分是否计费"写成显式规则。
每月 3%~5% 的差异，典型来源就是"缓存命中 token 在容量侧不占算力、在计费侧照算"。

**事故 ③ 的判据**：同时记录**字符数**与 **token 数**，看"字符/token 比"的变化。
平均输入长度下降 12% 有两种完全不同的成因：文本真的变短（收益）、
同样的文本被切得更碎（成本上升、效果可能变差）。只看 token 长度无法区分这两者 ——
而后者会让下游所有"按 token 长度分桶"的指标一起漂移，看起来像"用户行为变了"。

**基数（问题 3）**：三档 ——
必须带：模型/版本、租户、阶段、`finish_reason`；
可合并：长度分桶（`<=1k / 1k-4k / 4k-32k / >32k`）、区域（大区级）；
绝对禁止：`request_id`、`user_id`、prompt 内容或其哈希、任何自由文本。
降级顺序：先去掉最细分桶维度 → 再降采样率 → 再"只保留异常样本"，
而不是等 Prometheus 挂了再人工决定。

**流式成功率（问题 4）**：定义成"**已向客户端交付了协议完整的一轮**"才算成功。
至少拆：① 首 token 超时；② 已开始但中途卡死/心跳丢失（**必须判失败**，
否则"TCP 连着"会掩盖"生成停了"，这是流式系统最常见的静默故障）；
③ `finish_reason=length` 的正常截断 vs 内部错误中断；④ 客户端主动断开（单列，不进分母或另算交付率）；
⑤ HTTP 200 + 错误体（伪成功，要靠内容判定而非状态码）。

**采样（问题 5）**：分层 + 加权 ——
失败与超时**全采**；慢请求（尾部）全采或高权重；正常流量按租户配额保底采
（否则小租户的问题永远采不到，等于对小租户没有可观测性）；
**整链一致抽样**（同一请求的所有阶段同生同灭，否则 trace 是残缺的）；
明细进冷存储、指标仍用全量聚合（聚合的成本与请求数无关）。
验收标准就一句话：第 2 问的三个事故在采样之后仍然能 5 分钟回答；不能，就调采样而不是调问题。

**故意不做（问题 6）**：例如"每 token 打点"（量级 ×20，且 TTFT/TPOT 两个聚合值已足够定位，
逐 token 只在复现个别客户端渲染抖动时需要 —— 用按需开启的调试开关替代常开）；
或"prompt 明文落库"（隐私与成本，换成"长度 + 哈希 + 采样白名单租户"）。
关键是给出**代价数字**和**替代方案**，而不是"以后再说"。"""
    )


# =================================================================== DeepSeek batch 5
@draft('alg-deepseek-deadline-admission')
def q_deadline_admission():
    """
    准入判定 = "已接受的前缀在 EDF 下是否全部不误期"。
    可行性由 simulate() 真跑一遍调度得出，不靠公式猜。
    """
    Job = namedtuple = __import__('collections').namedtuple('Job', 'idx arrival work deadline')

    def feasible(jobs):
        """EDF、非抢占、有释放时刻。返回 {idx: 完成时刻}；有 job 误期则返回 None。"""
        remaining = sorted(jobs, key=lambda j: j.idx)
        done = {}
        t = 0
        while remaining:
            avail = [j for j in remaining if j.arrival <= t]
            if not avail:
                t = min(j.arrival for j in remaining)
                continue
            pick = min(avail, key=lambda j: (j.deadline, j.arrival, j.idx))
            remaining.remove(pick)
            t += pick.work
            if t > pick.deadline:
                return None
            done[pick.idx] = t
        return done

    def admit(arrival, work, deadline):
        n = len(arrival)
        if any(len(x) != n for x in (work, deadline)):
            raise ValueError('arrays disagree')
        for i in range(n):
            if arrival[i] < 0 or work[i] < 0:
                raise ValueError('negative arrival or work')
            if i and arrival[i] < arrival[i - 1]:
                raise ValueError('arrivals must be non-decreasing')
        accepted = []
        out = []
        for i in range(n):
            candidate = accepted + [Job(i, arrival[i], work[i], deadline[i])]
            if feasible(candidate) is None:
                out.append(0)                # 拒绝是纯动作：已接受的承诺不受影响
            else:
                accepted = candidate
                out.append(1)
        return out

    def case(name, arrival, work, deadline, throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 的同名注释）。"""
        try:
            got = admit(arrival, work, deadline)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [arrival, work, deadline],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [arrival, work, deadline], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

推理服务有硬 SLO：一个请求如果在它的截止时间之前**不可能**算完，
继续排队只是白占显存 —— 正确做法是**当场拒绝**，让调用方去改日期、换模型或降级。
这就是背压（backpressure）里"背"的那一半：不是把队列加长，而是让准入变得诚实。

## 你要实现的入口

```java
public static int[] admit(long[] arrivalMs, long[] workMs, long[] deadlineMs)
```

三根数组按下标对齐，按到达顺序给出每个请求：到达时刻、所需服务时长、截止时刻。
返回逐条的 **`1` = 接受 / `0` = 拒绝**。

## 调度与服务模型

- **单服务槽**（一台实例同一时刻只跑一个请求），**非抢占**。
- 已接受的请求按 **EDF（最早截止优先）** 执行：每当服务槽空闲，
  从"已到达且未完成"的请求里选 `deadline` 最小的；
  并列时选 `arrival` 更早的；再并列选下标更小的。
- 服务槽空闲且没有已到达的请求时，直接前进到下一个到达时刻（不空转计费）。

## 准入规则（判分点）

1. 处理第 `i` 个请求时，**把候选加进"此前已被接受的前缀"，然后判断整个集合在 EDF 下
   是否所有请求都能不误期**。全部不误期 ⇒ 接受；否则 ⇒ 拒绝。
   关键是**整集合**：只检查候选自己会不会超期的实现，会把已经承诺给别人的请求挤到超期，
   而"已接受的承诺必须兑现"正是准入控制存在的全部理由。
2. 拒绝是纯动作：不改变任何已有状态。
3. 请求自己 `deadline < arrival`（到达时就已过期）⇒ 一定拒（它在规则 1 下必然让集合不可行）。
4. `workMs[i] == 0` 是合法的（结果已缓存/命中前缀），它不占服务时间。
5. 输入非法抛 `IllegalArgumentException`：三根数组长度不一致、`arrivalMs` 逆序、
   到达时刻为负、`workMs` 为负。
   注意 `deadline < arrival` **不是**非法输入而是"必然被拒"的正常业务情况 ——
   抛错等于让调用方的一个坏请求打死整批判定。

数据规模很小（`arrivalMs.length <= 12`），**直接模拟调度是预期做法** ——
不需要也没有"可行性充要条件"的闭式公式。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  private static final class Job {
    final int idx;
    final long arrival, work, deadline;

    Job(int idx, long arrival, long work, long deadline) {
      this.idx = idx;
      this.arrival = arrival;
      this.work = work;
      this.deadline = deadline;
    }
  }

  public static int[] admit(long[] arrivalMs, long[] workMs, long[] deadlineMs) {
    int n = arrivalMs.length;
    if (workMs.length != n || deadlineMs.length != n) {
      throw new IllegalArgumentException("arrays disagree");
    }
    for (int i = 0; i < n; i++) {
      if (arrivalMs[i] < 0) throw new IllegalArgumentException("negative arrival");
      if (workMs[i] < 0) throw new IllegalArgumentException("negative work");
      if (i > 0 && arrivalMs[i] < arrivalMs[i - 1]) {
        throw new IllegalArgumentException("arrivals must be non-decreasing");
      }
    }

    List<Job> accepted = new ArrayList<>();
    int[] out = new int[n];
    for (int i = 0; i < n; i++) {
      List<Job> candidate = new ArrayList<>(accepted);
      candidate.add(new Job(i, arrivalMs[i], workMs[i], deadlineMs[i]));
      if (schedule(candidate) == null) {
        out[i] = 0;                         // 拒绝：accepted 一字不动
      } else {
        accepted = candidate;
        out[i] = 1;
      }
    }
    return out;
  }

  /** 按 EDF 真跑一遍。所有请求都不误期 ⇒ 返回完成时刻表；否则返回 null。 */
  private static long[] schedule(List<Job> jobs) {
    List<Job> remaining = new ArrayList<>(jobs);
    long[] finish = new long[jobs.size() + 1];
    long t = 0;
    int done = 0;
    while (!remaining.isEmpty()) {
      Job pick = null;
      for (Job j : remaining) {
        if (j.arrival > t) {
          continue;
        }
        if (pick == null
            || j.deadline < pick.deadline
            || (j.deadline == pick.deadline
                && (j.arrival < pick.arrival
                    || (j.arrival == pick.arrival && j.idx < pick.idx)))) {
          pick = j;
        }
      }
      if (pick == null) {                   // 没有已到达的：前进到下一个到达时刻
        long next = Long.MAX_VALUE;
        for (Job j : remaining) {
          next = Math.min(next, j.arrival);
        }
        t = next;
        continue;
      }
      remaining.remove(pick);
      t += pick.work;
      if (t > pick.deadline) {
        return null;
      }
      done++;
    }
    return finish;
  }
}"""

    naive = """public class Solution {
  // "队列没满就收"版：只看候选自己赶不赶得上，也不重排已接受的承诺
  public static int[] admit(long[] arrivalMs, long[] workMs, long[] deadlineMs) {
    int n = arrivalMs.length;
    if (workMs.length != n || deadlineMs.length != n) {
      throw new IllegalArgumentException("arrays disagree");
    }
    for (int i = 0; i < n; i++) {
      if (arrivalMs[i] < 0) throw new IllegalArgumentException("negative arrival");
      if (workMs[i] < 0) throw new IllegalArgumentException("negative work");
      if (i > 0 && arrivalMs[i] < arrivalMs[i - 1]) {
        throw new IllegalArgumentException("arrivals must be non-decreasing");
      }
    }
    long serverFree = 0;
    int[] out = new int[n];
    for (int i = 0; i < n; i++) {
      long start = Math.max(serverFree, arrivalMs[i]);
      if (deadlineMs[i] < arrivalMs[i]) {
        out[i] = 0;                         // 自己已过期 ⇒ 拒（这条是对的）
        continue;
      }
      if (start + workMs[i] <= deadlineMs[i]) {
        out[i] = 1;                         // 错：只看这一个请求，不看会把谁挤超期
        serverFree = start + workMs[i];
      } else {
        out[i] = 0;
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

每来一个请求就把它加进"此前已接受的集合"，然后用 EDF **真模拟一遍**：
`schedule` 每次从"已到达未完成"里挑 `deadline` 最小者执行，任一请求完成时刻超过它的
deadline 就判定不可行。n ≤ 12 ⇒ 最坏 `2^12` 级别里的 12 次模拟，每次模拟是 `O(n²)`，
完全够。

**为什么必须重跑整个前缀**（用例「候选自己赶得上，但会把已承诺的挤超期」）：
这是准入控制与"排队策略"的根本区别。
朴素版维护一个 `serverFree` 游标，只看新请求接上队尾赶不赶得上 ——
它隐含假设"新请求排在最后"，而 EDF 下新来的紧 deadline 请求会**插到前面**，
把已接受的松 deadline 请求推到超期。
后果不是新请求失败，而是**我们已经答应的请求失败**，而这在监控上表现为
"接受了却误期"，比"直接拒绝"糟得多：调用方以为排上了，用户白等。
判据一句话：**准入的承诺对象是全部已接受请求，不是当前这一个。**

**EDF 而非 FCFS**（用例「FCFS 会误拒：EDF 能重排出来」）：
`arrival=[0,0] work=[5,5] deadline=[10,6]` ⇒ FCFS 按到达序执行，
第二个在 10 完成 > 6 ⇒ 判不可行而拒掉；EDF 先跑 deadline=6 的那个 ⇒ 5、10 都不误期 ⇒ 接受。
（顺序并列时"更早到达优先、再按下标"是纯为确定性，不影响可行性判定。）

**拒绝必须是纯动作**：如果实现是"先接受、发现不行再撤销"，
撤销时把 `accepted` 改坏了，后面的判定就全歪 —— 这是状态机题里最常见的一类 bug。
本参考实现的写法是先构造 `candidate` 副本，只有可行才 `accepted = candidate`。

**`deadline < arrival` 不是非法输入**（用例「到达时已过期的请求」）：
它是一次普通的拒绝。把它抛出去等于让调用方一个坏请求打死整批判定 ——
而"到达即过期"在高负载推理服务里是**常态**（排队时间已经超过 SLO），
不是编码错误。

**工程延伸（面试追问点）**

1. 单服务槽之外还有什么？（真实推理服务是 continuous batching：一个批内可以塞多个请求，
   "服务时长"取决于批的形状，且**批本身会随新请求动态加入**。
   于是可行性判定不再是离散模拟，而要按 token 预算算：这题的 `workMs` 就是它的抽象。
   面试时要把这个差距主动说出来。）
2. 怎么避免每来一个都重跑全量模拟？（增量：接受一个请求只会让"完成时刻表"整体右移，
   可以对前缀维护一个已算好的时间表，只检查被推后的那部分。
   但更实际的答案是**在入口处限制窗口**：准入判定本身要 O(1) 才能上关键路径，
   所以工程上普遍换成充分条件（队列长度/预估等待时间上界），
   代价是会误拒一部分本可行的请求 —— 这个取舍要显式记录，不能悄悄做。）
3. 被拒的请求怎么处理？（必须给调用方可行动的信息：建议的重试时刻、可降级的模型档位、
   或"改成排队回调"。只返回 429 是把背压变成客户端轮询风暴。）
4. 多个实例时这套判定放哪？（放在实例本地 ⇒ 全局会超卖（每台都以为自己可行）；
   放在中心 ⇒ 中心成为延迟与故障源。常见解法是"本地精确 + 全局预算"：
   中心发 token 配额（近似总容量），本地做这题的可行性判定。）"""

    return base(
        'algorithms', 'senior',
        '截止时间准入：承诺对象是全部已接受请求，不是当前这一个',
        statement, 'java-junit',
        ['backpressure', 'admission-control', 'edf-scheduling', 'simulation',
         'modern:inference-scheduling'],
        src('DeepSeek', '推理引擎 / 调度与容量 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#30（原文把"背压"答成"队列 + 限流"，'
            '未给"已接受承诺必须兑现"这个可判分口径）'),
        language='java',
        cases=[
            case('基线：两条都赶得上', [0, 0], [3, 3], [10, 10]),
            case('候选自己赶得上，但会把已承诺的挤超期',
                 [0, 0, 0], [6, 6, 1], [6, 12, 7],
                 note='j0、j1 先接受（EDF 下 6 与 12 都赶上）。j2 只要 1ms、deadline=7，'
                      '自己当然赶得上 —— 但 EDF 会把它插到 j1 前面，把已承诺的 j1 推到 13 > 12 ⇒ 拒 j2'),
            case('FCFS 会误拒：EDF 能重排出来',
                 [0, 0], [5, 5], [10, 6],
                 note='按到达序第二条 10 > 6；EDF 先跑 deadline=6 ⇒ 5 与 10 都赶上 ⇒ 两条都收'),
            case('到达时已过期的请求：正常拒绝而不是抛错',
                 [0, 100], [5, 5], [10, 99]),
            case('零工作量合法：命中缓存不占服务时间',
                 [0, 0, 0], [9, 0, 9], [10, 10, 19]),
            case('非抢占：晚到的紧截止请求插不进去，只能拒',
                 [0, 5], [10, 3], [20, 8],
                 note='第一条从 0 跑到 10（非抢占 ⇒ 不能中途让位），第三条届时要 13 > 8 ⇒ 整个集合不可行。'
                      'EDF 的插队能力受限于"服务槽什么时候真空出来"'),
            case('突发里第 3 条赶不上，但第 4 条仍然可行',
                 [0, 0, 0, 0], [5, 5, 5, 5], [5, 10, 12, 20],
                 note='deadline=12 那条需要 15 才能跑完 ⇒ 拒；'
                      '拒绝是纯动作，所以第 4 条（deadline=20）照样被接受 ⇒ [1,1,0,1]'),
            case('间隔很大：每个都独立可行',
                 [0, 100, 200], [10, 10, 10], [20, 120, 220]),
            case('退化：没有任何请求', [], [], []),
            case('非法：三根数组长度不一致', [0, 1], [5], [10, 10], throws=True),
            case('非法：到达时刻逆序', [10, 5], [1, 1], [20, 20], throws=True),
            case('非法：服务时长为负', [0], [-1], [10], throws=True),
            case('非法：到达时刻为负', [-5], [1], [10], throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] admit(long[] arrivalMs, long[] workMs, long[] deadlineMs)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


@draft('alg-deepseek-tier-router')
def q_tier_router():
    """多模型路由：判档 + 会话内"只升不降"。expected 由 route() 算出。"""

    def route(session, confidence, prompt_tokens, turn_no, conf_floor, long_ctx, deep_turns):
        n = len(session)
        if any(len(x) != n for x in (confidence, prompt_tokens, turn_no)):
            raise ValueError('arrays disagree')
        if conf_floor < 0 or conf_floor > 100:
            raise ValueError('confFloor must be within 0..100')
        if long_ctx <= 0 or deep_turns <= 0:
            raise ValueError('thresholds must be positive')
        for i in range(n):
            if session[i] <= 0:
                raise ValueError('sessionId must be positive')
            if confidence[i] < 0 or confidence[i] > 100:
                raise ValueError('confidence out of 0..100')
            if prompt_tokens[i] < 0:
                raise ValueError('negative promptTokens')
            if turn_no[i] <= 0:
                raise ValueError('turnNo must be positive')
        sticky = set()                          # 已经升过档的会话
        out = []
        for i in range(n):
            escalate = (confidence[i] < conf_floor
                        or prompt_tokens[i] > long_ctx
                        or turn_no[i] > deep_turns)
            if escalate:
                sticky.add(session[i])
            out.append(1 if (escalate or session[i] in sticky) else 0)
        return out

    def case(name, session, confidence, prompt_tokens, turn_no, conf_floor, long_ctx, deep_turns,
             throws=False, note=None):
        try:
            got = route(session, confidence, prompt_tokens, turn_no, conf_floor, long_ctx, deep_turns)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name,
                       'input': [session, confidence, prompt_tokens, turn_no,
                                 conf_floor, long_ctx, deep_turns],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name,
                       'input': [session, confidence, prompt_tokens, turn_no,
                                 conf_floor, long_ctx, deep_turns],
                       'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

网关上挂着两档模型：**小模型**（便宜、快、能力有限）与**大模型**（贵 10 倍）。
路由的目标是"该升档的时候升，不该升的时候一次都别升"。

一个容易被忽略的事实：**档位必须粘住**。同一轮对话里第 1 轮走大模型、
第 2 轮因为置信度回升就切回小模型，用户看到的是语气、能力、拒答行为同时跳变 ——
产品上比"一直用小的"更糟，排查时也没人会把现象归到路由器上。

## 你要实现的入口

```java
public static int[] route(int[] sessionId, int[] confidencePct, int[] promptTokens,
                          int[] turnNo, int confFloor, int longCtxTokens, int deepTurns)
```

按下标对齐给出逐请求的判定：返回 `1` = 走大模型，`0` = 走小模型。

## 升档触发条件（任一成立即升档）

```
confidencePct[i] < confFloor          // 小模型自己都没把握
|| promptTokens[i] > longCtxTokens    // 超出小模型的上下文预算
|| turnNo[i] > deepTurns              // 深会话，指代消解扛不住
```

边界是**严格不等号**：`confidencePct == confFloor` 不升档、
`promptTokens == longCtxTokens` 不升档、`turnNo == deepTurns` 不升档。

## 粘性规则

一旦某个 `sessionId` 触发过升档，该会话**后续所有请求**都走大模型，
即使后面的请求单独看完全不需要升档。不同会话互不影响。
（降档只有"会话结束"这一种途径，本题不表达会话结束。）

## 非法输入（抛 `IllegalArgumentException`）

四根数组长度不一致；`sessionId <= 0`；`confidencePct` 不在 `[0,100]`；
`promptTokens < 0`；`turnNo <= 0`；`confFloor` 不在 `[0,100]`；
`longCtxTokens <= 0`；`deepTurns <= 0`。

数据规模小，一次遍历即可。"""

    reference = """import java.util.HashSet;
import java.util.Set;

public class Solution {
  public static int[] route(int[] sessionId, int[] confidencePct, int[] promptTokens,
                            int[] turnNo, int confFloor, int longCtxTokens, int deepTurns) {
    int n = sessionId.length;
    if (confidencePct.length != n || promptTokens.length != n || turnNo.length != n) {
      throw new IllegalArgumentException("arrays disagree");
    }
    if (confFloor < 0 || confFloor > 100 || longCtxTokens <= 0 || deepTurns <= 0) {
      throw new IllegalArgumentException("bad thresholds");
    }
    for (int i = 0; i < n; i++) {
      if (sessionId[i] <= 0) throw new IllegalArgumentException("sessionId must be positive");
      if (confidencePct[i] < 0 || confidencePct[i] > 100) {
        throw new IllegalArgumentException("confidence out of range");
      }
      if (promptTokens[i] < 0) throw new IllegalArgumentException("negative promptTokens");
      if (turnNo[i] <= 0) throw new IllegalArgumentException("turnNo must be positive");
    }

    Set<Integer> escalated = new HashSet<>();
    int[] out = new int[n];
    for (int i = 0; i < n; i++) {
      boolean trigger = confidencePct[i] < confFloor
          || promptTokens[i] > longCtxTokens
          || turnNo[i] > deepTurns;
      if (trigger) {
        escalated.add(sessionId[i]);           // 粘性是**单向棘轮**：只记升过档的会话
      }
      out[i] = (trigger || escalated.contains(sessionId[i])) ? 1 : 0;
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // 逐请求独立判档：没有粘性
  public static int[] route(int[] sessionId, int[] confidencePct, int[] promptTokens,
                            int[] turnNo, int confFloor, int longCtxTokens, int deepTurns) {
    int n = sessionId.length;
    if (confidencePct.length != n || promptTokens.length != n || turnNo.length != n) {
      throw new IllegalArgumentException("arrays disagree");
    }
    if (confFloor < 0 || confFloor > 100 || longCtxTokens <= 0 || deepTurns <= 0) {
      throw new IllegalArgumentException("bad thresholds");
    }
    for (int i = 0; i < n; i++) {
      if (sessionId[i] <= 0) throw new IllegalArgumentException("sessionId must be positive");
      if (confidencePct[i] < 0 || confidencePct[i] > 100) {
        throw new IllegalArgumentException("confidence out of range");
      }
      if (promptTokens[i] < 0) throw new IllegalArgumentException("negative promptTokens");
      if (turnNo[i] <= 0) throw new IllegalArgumentException("turnNo must be positive");
    }
    int[] out = new int[n];
    for (int i = 0; i < n; i++) {
      boolean trigger = confidencePct[i] < confFloor
          || promptTokens[i] > longCtxTokens
          || turnNo[i] > deepTurns;
      if (trigger) {
        out[i] = 1;
      } else {
        long total = 0;
        int seen = 0;
        for (int j = 0; j <= i; j++) {        // 错法：按"该会话至今的平均置信度"再判一次
          if (sessionId[j] == sessionId[i]) {
            total += confidencePct[j];
            seen++;
          }
        }
        out[i] = total / seen < confFloor ? 1 : 0;
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

一个 `Set<Integer>` 记录"已经升过档的会话"，逐请求算触发条件，
触发就把会话 id 放进集合，然后 `trigger || contains(session)` 决定这一条走哪档。
`O(n)` 时间、`O(会话数)` 空间。

**粘性是单向棘轮，不是"平均一下"**（用例「升过档的会话后面全跟上去」）：
朴素版想用"该会话到目前为止的平均置信度"来平滑 —— 这个形状看起来更聪明，
实际是把一次性的升档决定变成了一个**会自己漂回小模型**的连续量。
产品后果是可感知的：用户会看到"同一个会话里助手突然变笨了",
而且它跟任何单条请求的判定都对得上，所以没人会怀疑路由器。
判据是：**升档是一个会被记住的事件，不是一个持续评估的指标。**

**三个触发条件的边界都是严格不等号**（用例「三条边界都不升档」）：
`confidence == confFloor` 不升、`promptTokens == longCtxTokens` 不升、
`turnNo == deepTurns` 不升。三个条件里两个是 `<`、两个是 `>`，
混着写最容易把某一个变成 `<=` —— 而 `turnNo` 是整数计数，
`>= deepTurns` 会让"刚好到第 N 轮"的会话全体提前升档，成本直接跳。

**不同会话互不影响**（用例「交错会话：A 升档不影响 B」）：
粘性必须按 `sessionId` 隔离。用一个全局"最近是否升档"标志的写法，
会让一个长上下文请求把之后所有租户的小模型流量都拖到大模型上 ——
这种 bug 在指标上表现为"某次发版后大模型调用量涨了一倍但没有对应的大 prompt 流量"。

**工程延伸（面试追问点）**

1. `confidencePct` 哪来的？（小模型自己的输出概率/校准分。未校准的置信度是噪声，
   所以真实系统要先做温度缩放/等距回归校准，再谈阈值 ——
   这题把它当给定输入，面试时要主动说明这个假设有多强。）
2. 为什么不做"大模型 → 小模型"的降级？（同一会话内不做，跨会话可以做（新会话重新判档）。
   另外成本侧真正省钱的开关是"升档后能否用一个便宜的探针判断能否回落",
   但那会引入第二次风格跳变，产品上通常否决。）
3. 会话粘住的成本上限怎么控？（给"已升档会话"再设一个预算：
   累计 token 超过阈值后强制走排队/降精度，否则一个长会话可以无限吃大模型额度。
   诚实的答案是"粘性 + 预算"两条规则并存，本题只考前者。）
4. 升档判定该在网关还是推理侧？（网关：它看得到会话历史与配额，且能一次决定；
   推理侧：它才知道真实 KV 占用。工程上通常是网关做粗判 + 推理侧做"实在装不下"的兜底拒绝，
   两层各有各的指标。）"""

    return base(
        'algorithms', 'senior',
        '多模型路由：三个升档触发条件 + 会话内只升不降的棘轮',
        statement, 'java-junit',
        ['model-routing', 'cost-control', 'sticky-state', 'boundary-conditions',
         'modern:llm-gateway'],
        src('DeepSeek', '推理网关 / 多模型路由 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#54（原文只答"简单走小模型、复杂走大模型"，'
            '未给可判分的触发口径与会话粘性）'),
        language='java',
        cases=[
            case('基线：低置信升档，其余走小模型',
                 [1, 1], [90, 30], [100, 100], [1, 2], 40, 8000, 20),
            case('三条边界都不升档',
                 [1, 2, 3], [40, 99, 99], [10, 8000, 10], [1, 1, 20], 40, 8000, 20,
                 note='会话 1 卡在 confidence==confFloor、会话 2 卡在 promptTokens==longCtxTokens、'
                      '会话 3 卡在 turnNo==deepTurns ⇒ 三条都必须走小模型'),
            case('升过档的会话后面全跟上去（粘性）',
                 [1, 1, 1], [90, 10, 95], [10, 9999, 10], [1, 2, 3], 40, 8000, 20,
                 note='第 2 条因长 prompt 升档 ⇒ 第 3 条单独看完全不该升，仍走大模型'),
            case('交错会话：A 升档不影响 B',
                 [1, 2, 1, 2], [50, 50, 5, 99], [10, 10, 10, 10], [1, 1, 2, 2], 40, 8000, 20,
                 note='只有会话 1 的第 2 次请求触发 ⇒ 之后会话 1 粘住，会话 2 一直是小模型'),
            case('深会话触发：第 21 轮起整段跟上',
                 [7, 7, 7, 7], [99, 99, 99, 99], [10, 10, 10, 10], [20, 21, 22, 1], 40, 8000, 20),
            case('长 prompt 触发',
                 [3, 3], [99, 99], [8001, 10], [1, 1], 40, 8000, 20),
            case('退化：没有任何请求', [], [], [], [], 40, 8000, 20),
            case('confFloor=0：永远不会因置信度升档',
                 [1], [0], [10], [1], 0, 8000, 20),
            case('非法：四根数组长度不一致', [1, 2], [50], [10, 10], [1, 1], 40, 8000, 20,
                 throws=True),
            case('非法：置信度越界', [1], [101], [10], [1], 40, 8000, 20, throws=True),
            case('非法：turnNo 为 0', [1], [50], [10], [0], 40, 8000, 20, throws=True),
            case('非法：confFloor 大于 100', [1], [50], [10], [1], 101, 8000, 20, throws=True,
                 note='confFloor=101 会让每条请求都升档 —— 等于把路由器关掉但没人知道'),
            case('非法：longCtxTokens 为 0', [1], [50], [10], [1], 40, 0, 20, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] route(int[] sessionId, int[] confidencePct, int[] promptTokens, '
                             'int[] turnNo, int confFloor, int longCtxTokens, int deepTurns)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# =================================================================== DeepSeek batch 6（三道主观题）
@draft('sys-deepseek-gateway-at-scale')
def q_gateway_at_scale():
    statement = """## 场景

**你正在面试 DeepSeek 的资深后端工程师（推理网关），45 分钟**

设计一个支撑**千万级 QPS 峰值**的 LLM API 网关（对外，多租户，流式为主）。
先把"千万 QPS"翻译成可运营的口径：平均每秒 1000 万次**请求进入**，
但每个请求平均占用后端 8 秒（流式），所以**同时在途**约 8000 万个连接。

已知约束：
- 单实例长连接上限约 100 万（受文件描述符与内核缓冲区限制）；
- 后端 GPU 池的有效并发远低于 8000 万 —— 绝大多数请求是在**等**；
- 请求 99% 是 SSE 流式，客户端断开随时发生；
- 计费按 token，且必须"用户实际收到的量"；
- 出口带宽与跨地域回源成本是主要账单项。

## 你要给出的设计

1. 把"8000 万在途连接"这个数拆开：哪些层必须真的持有连接、
   哪些层可以不持有（并说明**不持有之后恢复语义怎么保证**）。
2. 网关的无状态性能做到什么程度？哪些状态**必须**存在某处，
   分别放在哪里（本地/共享存储/下游），以及各自的失效后果。
3. 后端 GPU 池只有几百个实例的容量，而入口有千万 QPS。
   给出从入口到 GPU 的**逐级收敛**方案（每级砍掉什么、按什么依据砍、砍错了怎么办）。
4. 一次 GPU 侧的局部抖动（某机房 30% 实例重启）在你这套架构里的表现是什么？
   给出"用户看到什么"与"你在 60 秒内做什么"。
5. 计费与限流的口径必须一致，但两者读取的数据来源不同。说明你怎么让它们对得上、
   以及不一致时以谁为准。
6. 你**不**打算解决的三个问题是什么（在千万 QPS 下仍然选择不做，说明代价）。"""

    return base(
        'system-design', 'senior',
        '千万 QPS 的 LLM 网关：连接持有、逐级收敛、抖动表现与不做什么',
        statement, 'llm-rubric',
        ['gateway', 'capacity-planning', 'backpressure', 'billability', 'failure-domain',
         'modern:llm-gateway'],
        src('DeepSeek', '推理网关 / 平台架构 资深工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#83,#55,#29（原文给出题面与功能清单，'
            '未给"连接持有 vs 状态归属"与"逐级收敛"的可判分要点）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '把在途连接数拆开并区分"持有"与"不持有"', 'weight': 2,
                 'criteria': '是否算清边缘层必须持有（约 8000 万 fd ⇒ 需 80~100 个边缘实例级别，'
                             '并指出真正的瓶颈是 fd/内存/conntrack 而不是 CPU），'
                             '以及**内部层可以不持有**：网关与后端之间用多路复用/服务端流式转发'
                             '或消息队列解耦。'
                             '必须回答"不持有之后恢复语义怎么保证"：'
                             '客户端断开不等于任务终止（要区分"断开即止"与"可续推"两类，'
                             '后者要有可重连的流 id + 断点续推），'
                             '否则用户刷新一次页面就丢一次生成。只答"用 LB 分摊"此项最多 1 分。'},
                {'label': '状态归属与失效后果', 'weight': 2,
                 'criteria': '必须点名必须存在的状态并各自给放置与后果：'
                             '连接会话（本地，丢了就断连，可接受）、'
                             '计量计数（必须持久/可重放，丢了就是资损）、'
                             '准入与配额（丢了要么超卖要么全拒 —— 必须说明降级到哪一侧）、'
                             '前缀缓存的路由亲和（丢了只损失命中率，不影响正确性）。'
                             '关键判据：是否按"丢了会不会造成不可逆损失"来分层，'
                             '而不是按"读写频率"。把四类都塞进一个 Redis 集群的，此项不得过半。'},
                {'label': '从千万 QPS 到几百实例的逐级收敛', 'weight': 2,
                 'criteria': '是否给出至少三级且每级有"砍什么 + 依据 + 砍错的代价"：'
                             '边缘（协议合法性、鉴权失败、明显重复请求）→ '
                             '限流/准入（按租户与优先级、按**在途 token**而非 QPS）→ '
                             '排队/降级（延后排队、小模型替代、缓存命中直接返回）→ '
                             '调度层（batch 组装、PD 分离）。'
                             '必须指出"QPS 不是正确的准入单位"（推理成本由 token 决定），'
                             '以及砍错方向（把高价值租户排在低价值之后）如何被度量。'},
                {'label': '抖动的表现与 60 秒动作', 'weight': 2,
                 'criteria': '是否说清这套架构里"局部重启"会变成什么现象：'
                             '在途连接被切断（客户端表现为流突然中断而非报错）、'
                             '路由表短暂指向死实例（超时放大）、'
                             '重试风暴（所有客户端同时重连 ⇒ 二次雪崩）。'
                             '动作要有顺序与判据：先摘除（健康检查 + 主动下线开关）、'
                             '再限流入口（**保护剩余容量**，不是保护自己）、'
                             '再排队/降级、最后才是扩容。'
                             '答"自动重试"而不谈重试风暴的，此项最多 1 分。'},
                {'label': '计费与限流口径的一致性安排', 'weight': 1,
                 'criteria': '是否指出两者读的是不同事实（计费读"实际吐给客户端的 token"，'
                             '限流读"进门的预估"），'
                             '并给出对账机制：以计量事件为准（可重放、含请求 id 与版本），'
                             '限流侧用同一份口径做事后校正；'
                             '明确"不一致时以计费口径为准，限流是近似控制"。'
                             '含糊说"统一从一份数据取"不得分。'},
                {'label': '明确不做的三件事及代价', 'weight': 1,
                 'criteria': '是否给出具体三项并说明代价与替代，例如：'
                             '不做全局精确配额（用近似 + 事后对账换 10 倍吞吐）、'
                             '不做跨地域会话保持（放弃"任意节点可续推"换带宽）、'
                             '不做请求级强顺序（流式天然无序）、'
                             '不做 100% 采样明细（改为分层采样）。'
                             '只写"暂时不考虑"不得分。'},
            ],
            'notes': '总分封顶 5 的情形：把"千万 QPS"当成一个形容词而从不回到 8000 万在途这个数；'
                     '所有状态都放 Redis 并认为加从库就够；'
                     '用"多机房容灾"代替对具体失效表现的分析；'
                     '限流按 QPS 且没有意识到 token 才是成本单位；'
                     '全文没有出现"客户端断开之后怎么办"。',
        },
        estimatedMinutes=45,
        answer="""## 参考答案要点

**先回到那个数**：1000 万 QPS × 平均 8 秒 = 8000 万在途连接。
这是本题所有决策的来源 —— 千万 QPS 本身不可怕（拆到几十台机器就行），
**八千万条活着的 TCP 连接**才可怕：fd、conntrack、每连接的内核缓冲、
以及"任何一次全量重连都是二次雪崩"。所以第一步是明确
**只有边缘必须持有连接**，内部必须把它转换成消息/流而不是继续持有。

**不持有连接之后，恢复语义要重新挣回来**：客户端断开分两类 ——
"看了就撤"（断开即终止生成，省算力）与"断了还要续"（要可重连的 stream id + 生成游标 +
一段结果缓冲）。真实产品两者都有，按接口/租户区分。
没设计这一层的系统，用户刷新一次页面就丢一次生成，而且**计费还在继续**。

**状态按"丢了是否可逆"分层**，不按读写频率：
计量计数不可丢（资损，且必须可重放）；准入配额可近似（丢了宁可少放不可超卖，
所以降级方向要明确）；路由亲和可丢（只损失命中率）；
连接会话可丢（断连是可恢复的用户体验）。
把这四类塞进同一个存储，等于选择"最贵的那一档保护等级给所有状态"，
并且给它们同一个故障域。

**逐级收敛的正确单位**：入口用协议合法性与鉴权砍（零成本）；
准入用**在途 token** 而不是 QPS 砍（推理成本由 token 决定，
一个 32K 上下文约等于几百个短请求）；
调度层用 batch 组装与 PD 分离把 GPU 填满。
每级都要说清"砍错了怎么办"：被误砍的高价值租户表现为拒答率上升，
所以要按租户维度出"准入拒绝原因分布"，否则你会把自己的限流误诊成"下游变慢"。

**抖动的真实表现**是"流断了但不报错"—— 这比 500 更难发现。
60 秒动作的顺序是：主动摘除（开关优先于健康检查，健康检查总是慢一步）→
**收紧入口**保护剩余容量（此时最忌"自动重试不加预算"）→
降级/排队 → 扩容。重试风暴是二次故障的主因，值得单独点名。

**计费与限流天然读不同事实**：一个读"实际吐出去的量"（客户端可能中途走），
一个读"进门时的预估"（决定要不要接）。对账只能以计量事件为准
（不可变、带请求 id 与模型/费率版本），限流侧定期按同一口径回校。
不一致时以计费为准 —— 这是资损方向上的保守选择。"""
    )


@draft('ag-deepseek-agent-cost-loop')
def q_agent_cost_loop():
    statement = """## 场景

**你正在面试 DeepSeek 的 Agent 平台工程师，40 分钟**

一个线上 Agent 业务（工具调用型，平均每个任务 6~40 步）。月度账单结构：
LLM 调用占 71%，其中**同一个任务的重复上下文占了 44%**（每步都把完整历史重送一遍）；
工具调用里 12% 是同一分钟内对同一目标的**完全相同**调用；
失败任务里 23% 属于"反复调用同一个失败工具直到步数上限"。
现状：只有一个"任务级步数上限"和一张月底才发现的账单。

产品经理的要求是"成本降一半，但成功率不能掉"。

## 你要给出的方案

1. 把"成本"这件事拆成可归因的量：你认为至少需要哪些**一级的**成本维度
   （注意：月底能看到的"总 token 数"不是一级维度）。
2. 针对那三个具体百分比（44% 重复上下文、12% 重复工具调用、23% 失败空转），
   分别给出机制、预期削减量、以及**它可能伤害成功率的具体的方式**。
3. 成本削减必须可验证。给出你的实验/回滚设计：
   在没有"标准答案"的开放任务上，怎么知道成功率没掉？
   请给一个不依赖人工标注也不依赖 LLM 自评的判据，或明确论证它做不到。
4. 什么时候你**允许**成本上升？给两条反直觉但正确的场景。
5. 预算是"任务级"还是"会话级"还是"租户级"？说明为什么单一层级会出事，
   以及跨层借用怎么记账才不会失控。
6. 你会拒绝实现的一项"看起来能省钱"的优化是什么？为什么？"""

    return base(
        'agent-design', 'senior',
        'Agent 成本闭环：一级成本维度、三处削减的副作用、以及不依赖标注的成功率判据',
        statement, 'llm-rubric',
        ['cost-control', 'agent-runtime', 'attribution', 'eval-without-labels',
         'modern:agent-ops'],
        src('DeepSeek', 'Agent 平台 / 成本与效果 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#82,#69,#67（原文只列"要控制成本"'
            '与几种缓存/压缩手段，未给可判分的归因维度与副作用分析）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '一级成本维度不是"总 token"', 'weight': 2,
                 'criteria': '是否给出可归因、可行动的维度：'
                             '按**步类型**（规划/执行/复核/重试）拆分，'
                             '按**新增 token vs 重复 token** 拆分（这两者的边际成本天差地别，'
                             '因为前者可能吃不到前缀缓存），'
                             '按**任务最终结局**（成功/失败/被上限截断）分摊，'
                             '按**租户×意图**分池。'
                             '关键判据：每个维度都要能指向一个可动的旋钮；'
                             '"总 token 数"和"平均单价"不是维度而是结果。'},
                {'label': '44% 重复上下文：机制 + 会怎么伤成功率', 'weight': 2,
                 'criteria': '机制必须具体到一种以上：前缀缓存复用（显式 cache key，'
                             '把稳定前缀放到最前）、滚动摘要/分层记忆、'
                             '把工具结果**结构化压缩**后再入史。'
                             '必须说清伤害方式：摘要是有损的，'
                             '被摘要掉的细节往往是第 20 步成功所依赖的那个约束条件；'
                             '前缀缓存要求**字节级一致**，'
                             '所以任何动态内容（时间戳、随机 id、日志级别）插进前缀就会全线失效 —— '
                             '这是实现里最常见的"上了缓存没命中"原因。'},
                {'label': '12% 重复工具调用：幂等键与副作用', 'weight': 2,
                 'criteria': '是否给出"对同一 (工具, 规范化参数, 目标资源版本) 的短窗口结果复用"'
                             '并处理三件事：'
                             '① 参数规范化（顺序、空白、默认值展开）否则命中率极低；'
                             '② **有副作用的调用绝不能复用**（写操作/扣款/发消息），'
                             '必须有按工具声明的幂等属性做白名单；'
                             '③ 结果时效性（缓存了一个"库存还剩 3 件"可能造成错误决策），'
                             '要按工具给 TTL。'
                             '直接对所有工具做结果缓存的写法此项最多 1 分 —— 那是造事故。'},
                {'label': '23% 空转：检测信号与终止策略', 'weight': 1,
                 'criteria': '是否给出不靠"步数上限"的信号：'
                             '同一失败的重复计数、动作序列的环路检测（周期性模式而非完全相同）、'
                             '状态无进展检测（连续 N 步没有新增可验证事实）。'
                             '并且要说明终止之后做什么（带原因向上层/用户求助），'
                             '而不是静默放弃 —— 静默放弃会让"省了钱"看起来像"成功率没变"。'},
                {'label': '无标注下验证成功率没掉', 'weight': 1,
                 'criteria': '必须给出可自动化的判据并说明其局限，例如：'
                             '终态可验证率（任务产物能被程序校验：编译通过、单号存在、'
                             '文件哈希一致）、用户后续行为代理'
                             '（同一意图重开率、追问率、放弃率）、'
                             '影子跑（同一输入两版策略各跑一次，比对终态一致率）。'
                             '加分：明确指出对**不可验证**的开放任务，'
                             '"没有掉"是无法证明的，只能把它转化为可验证形式或保留人工抽检 —— '
                             '承认边界比编一个指标更有价值。'},
                {'label': '允许成本上升的场景 + 拒绝的一项优化', 'weight': 2,
                 'criteria': '两条反直觉场景要具体，例如：'
                             '高价值首次用户/首次任务用更强模型或多复核一轮（LTV 换单次成本）；'
                             '幂等与可重放基础设施（本身花钱，但让失败重试的成本下降一个量级）；'
                             '低置信时**主动澄清**而不是猜（多一轮对话换掉一次错误交付）。'
                             '拒绝项要有理由，例如"把所有历史都塞进一个长上下文窗口"'
                             '（成本高且会退化）、"用更小的模型做工具参数生成"'
                             '（参数错一个字节整条链路白跑，返工成本远高于差价）。'},
            ],
            'notes': '总分封顶 5 的情形：把降本等价为"换便宜的模型"；'
                     '对 12% 重复调用的解法是"提示词里叫模型别重复"；'
                     '成功率判据只有"人工看一批 case"或"让模型自己打分"却不自评其可靠性；'
                     '没有任何一处提到"这个优化会伤害什么"。',
        },
        estimatedMinutes=40,
        answer="""## 参考答案要点

**一级维度必须是"可动的旋钮"**：按步类型（规划/执行/复核/重试）、
按新增 token 与重复 token、按任务终态、按租户×意图。
"总 token"和"平均单价"是结果不是维度 —— 它们不能告诉你关哪个开关。
尤其"新增 vs 重复"这一刀最值钱：那 44% 里绝大部分重复本可以不吃钱（前缀缓存），
所以它同时是最大的成本项和最容易的一块。

**44% 重复上下文**：三条机制按代价从低到高是
① 稳定前缀前置（system/工具说明固定在最前，**任何动态内容都不许进入前缀**：
时间戳、request id、日志行号都会让缓存字节级失配，
这是"上了缓存命中率却不到 20%"的头号原因）；
② 工具结果结构化压缩后再入史（保留可寻址的原文，摘要只是索引）；
③ 滚动摘要（真压缩，但有损）。
伤害方式是明确的：**被摘要掉的约束常在深步**，
所以要用"深步任务的成功率"单独看，而不是看平均成功率。

**12% 重复工具调用**：机制是"规范化参数 + 目标资源版本 + 工具声明的幂等属性"三者做键的短窗口复用。
关键约束是**只有声明为只读的工具才能复用结果**，
写操作复用返回值等于把一次扣款变成两次或零次。
参数规范化（顺序、默认值展开、空白）决定命中率；结果 TTL 决定安全性 ——
一个缓存的"库存剩 3 件"直接导致超卖。

**23% 空转**：不要指望步数上限，它是最后兜底不是检测器。
可自动化的信号有三个层次：同一 (工具, 错误类别) 的重复计数、
**动作序列的周期检测**（不是完全相同的调用，而是 A→B→A→B 的环），
以及"状态无进展"（连续 N 步没有产生新的可验证事实）。
终止之后必须带原因上抛，否则你会把"省了钱"读成"成功率没变"。

**没有标注怎么证明成功率没掉**：能自动化的三类判据是
终态可验证率（产物能被程序校验：能否编译、单号是否存在、哈希是否一致）、
用户后续行为代理（同意图重开率、追问率、放弃率）、
以及影子跑（同一输入两版策略各跑一次，比终态一致率）。
但诚实的答案包含一个否定：**对不可验证的开放任务，"没掉"无法被证明**，
只能把它改造成可验证形式，或保留人工抽检作为唯一的地面真值。
"用 LLM 评 LLM"可以做回归监控，但它和被优化的是同一个分布，
成本一降它的打分就跟着变松 —— 那正是自我强化的测量环路。

**允许成本上升**的两个场景：首次用户/首次高价值任务多复核一轮（用单次成本换 LTV，
因为第一次失败的留存损失不可逆）；以及**建幂等与可重放基础设施**
（本身花钱，但它让"失败重试"从整任务重跑变成断点续推，总成本反而降一个量级）。

**拒绝做的**：把整段历史塞进超长上下文（线性成本 + 长上下文中的信息利用率下降，
实际是把问题藏起来）；用小模型生成工具参数（错一个字节整条链路白跑，
返工成本远高于差价 —— 省的地方和亏的地方不在同一个环节，无法对账）。"""
    )


@draft('hot-deepseek-long-context-traps')
def q_long_context_traps():
    statement = """## 场景

**你正在面试 DeepSeek 的推理服务工程师，35 分钟（短设计题）**

产品要上"200K 上下文"的档位。工程侧现状：
KV Cache 每 token 每层约 2KB（GQA 后），显存单卡 80GB、单请求至少留出 60GB 可用；
prefill 是算力瓶颈而 decode 是带宽瓶颈；
现有服务用 static batching，最大序列 32K。

上线后一周出现三件事：
① 少量 150K+ 的长请求让同实例上所有短请求的 TPOT 从 28ms 涨到 210ms；
② 有租户把长上下文当"无限备忘录"用，每轮都重发整份 180K 材料，账单是预期的 9 倍；
③ 一次偶发的"输出重复到 max tokens"，人工回看发现中间某处出现了"忘记前面的约束"。

## 你要回答的问题

1. 逐条给出这三件事的**机制层**根因（不要停在"负载高"这种描述）。
   第③条请给出至少两种可能成因，并说明怎么区分它们。
2. 长上下文与短上下文该不该同池？给出你的部署方案与理由，
   并说明"分池之后短请求的容量成本"由谁承担、怎么度量。
3. 给出三条**必须做**的工程防线，专门针对第②件事（滥用不一定是恶意的）。
4. 200K 档位要真跑起来，你会改哪一处服务架构（而不是改模型）？
5. 你会怎么对外承诺这一档的 SLO？给出你认为唯一诚实的表述形式，
   并说明为什么不能承诺端到端 P99。"""

    return base(
        'hot-interviews', 'senior',
        '200K 上下文档位：TPOT 被长请求拖死、备忘录式滥用、以及忘记约束的两种成因',
        statement, 'llm-rubric',
        ['long-context', 'kv-cache', 'slo-design', 'tenant-abuse',
         'modern:llm-inference'],
        src('DeepSeek', '推理服务 / 长上下文 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#47,#46,#37,#40（原文逐条列了'
            '"长上下文有哪些工程难题"的清单，未做成可判分的根因与承诺形式）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '①的机制：decode 带宽被长 KV 占用', 'weight': 2,
                 'criteria': '是否说到：decode 每步都要把该序列的**全部 KV 读一遍**（带宽受限），'
                             '长序列的 KV 体量让同批内每个短请求的那一步都被拖长；'
                             '以及 static batching 让**不同长度的序列同批**，'
                             '于是短请求必须陪长跑完一步。'
                             '加分：指出正确方向是 continuous batching + '
                             '按长度分桶（把长度相近的放同批）+ 必要时对长请求单独成批。'
                             '只说"资源被抢占，加机器"此项最多 1 分。'},
                {'label': '②的机制：每轮重发的真实成本构成', 'weight': 1,
                 'criteria': '是否算清：180K 每轮重发意味着每轮都付一次 prefill（算力瓶颈）'
                             '且**无法**吃前缀缓存收益（若客户端把动态内容放在前面）'
                             '或能吃但被计费口径忽略；'
                             '并且指出"重复发送"和"上下文真的需要这么长"在请求侧无法区分，'
                             '所以防线必须建立在**可观测的复用信号**上（前缀重复率、'
                             '同一会话内 prompt 指纹的重合度）。'},
                {'label': '③的两种成因与区分方法', 'weight': 3,
                 'criteria': '至少给出两类且机制不同：'
                             '(a) **检索侧**：长上下文里的有效注意力衰减/位置外推'
                             '（训练长度外的插值偏差），'
                             '表现为"中段信息最先丢"（lost in the middle）；'
                             '(b) **系统侧**：前缀缓存/分页 KV 的错误复用'
                             '（缓存 key 冲突、块回收后残留、'
                             '或压缩/驱逐把约束那段 KV 丢了），'
                             '表现为"与命中路径强相关，同输入不复现或换实例就复现"。'
                             '必须给区分方法：把约束**移到首尾各做一次**（(a) 会显著改善、'
                             '(b) 不变）；或在同一实例上禁用前缀缓存重放（(b) 消失、(a) 复现）；'
                             '或比较"关掉分页回收的调试模式"。'
                             '只答"模型能力不够"不得分。'},
                {'label': '同池与否：给出部署方案', 'weight': 2,
                 'criteria': '是否给出明确方案（按长度分桶 + 长上下文独立池，'
                             '或 PD 分离后 prefill 侧共享、decode 侧隔离）'
                             '并说明代价：长上下文池利用率低（请求稀少但占整卡），'
                             '这笔"隔离税"必须被**度量**（例如按长度分档统计每卡的'
                             'token-秒利用率），并说明是摊到单价还是显式收档位费。'
                             '只说"分开部署更安全"此项最多 1 分。'},
                {'label': '三条针对"非恶意滥用"的防线', 'weight': 2,
                 'criteria': '必须可落地且不惩罚真需求，例如：'
                             '按 (会话, 前缀指纹) 识别"重复上下文"并对超出部分给不同计价/走缓存；'
                             '提示客户端把稳定内容放前部（服务端同时**度量前缀命中率**并在 API 响应里回传'
                             '"本轮可复用 token 数"，让调用方有动力改）；'
                             '长上下文单独配额（按卡·秒而不是按请求数）；'
                             '把"每轮 prompt 长度分布"做成租户级看板（问题暴露给负责人而不是靠月底账单）。'
                             '答"限制最大长度"或"加钱"不算防线（前者伤真需求，后者没有归因）。'},
            ],
            'notes': '第 5 问必答且判据：诚实的表述是"在给定长度分布与命中条件下的分位数承诺 + '
                     '超出该分布的请求走排队/降级并显式返回"。'
                     '承诺端到端 P99 不可信的原因是端到端时间由**输出长度**决定，'
                     '而输出长度由模型与用户问题决定，服务侧不可控 —— '
                     '只能承诺可分项控制的量（TTFT、TPOT、排队时长）。'
                     '答"承诺 P99 但给一个很宽的余量"的，总分不超过 6。',
        },
        estimatedMinutes=35,
        answer="""## 参考答案要点

**①是带宽问题不是"负载高"**：decode 每生成一个 token，
都要把该序列已积累的整段 KV 从 HBM 读一遍。150K 序列的 KV 与短序列差两个数量级，
所以它的**一步**比短请求的**一步**慢很多；而 static batching 下同一批要一起走完一步，
于是短请求的 TPOT 被同批最长的序列决定。
解法三件套：continuous batching（请求可以随时进出批）、按长度分桶、
必要时让长请求单独成批。"加机器"完全不解决 —— 只要长请求和短请求还同批，
换多少机器都是同样的 TPOT。

**②的账要算到 prefill 上**：每轮重发 180K ⇒ 每轮一次 180K 的 prefill（算力瓶颈），
这才是 9 倍的来源。
而且服务端**无法区分**"上下文真的需要这么长"和"客户端图省事每轮全量重发"，
唯一可依赖的是可观测的复用信号：同一会话内 prompt 前缀指纹的重合度、前缀缓存命中率。
所以正确防线不是限长，而是**把可复用量回传给调用方**并让它计价不同 ——
让客户端有经济动机把稳定内容放前面、只增量发送。

**③有两类根因，且修法相反**：
- *检索侧*（模型）：训练长度外的位置插值偏差与"中段信息最先丢"（lost in the middle）。
  特征是与**内容在上下文中的位置**强相关：把约束移到开头或结尾就明显改善。
- *系统侧*（服务）：分页 KV 的错误复用 —— 缓存 key 冲突、块被回收后残留、
  或驱逐/压缩策略正好把带约束的那几块丢了。
  特征是与**是否命中缓存/换实例**强相关，同一输入可能不复现。
区分实验：同一请求做四次变体 —— 约束在头、约束在尾、约束在中、以及
"禁用前缀缓存重放"。位置变体有差异 ⇒ 检索侧；禁缓存后消失 ⇒ 系统侧。
这两个方向的修复成本差一个量级，先分诊再排查是省时间的唯一方法。

**部署方案与隔离税**：按长度分桶 + 长上下文独立池。
代价是长上下文池利用率天然低（请求稀少但每个占整卡），
这笔税要么摊进档位单价，要么显式收档位费 —— 关键是**先度量**（每卡的 token·秒利用率分档），
否则它会变成"没人负责的容量黑洞"。

**SLO 只能承诺可控分项**：端到端时间 = 排队 + prefill + `输出 token 数 × TPOT`，
其中输出长度由模型和用户问题决定，服务侧不可控。
所以诚实形式是"**在给定长度分布与命中条件下的 TTFT/TPOT 分位数承诺 +
超出该分布的请求显式走排队或降级（并返回可识别的状态）**"。
把很宽的端到端 P99 写进合同，等于把不可控项转嫁给自己 —— 第一次大流量日就会违约。"""
    )


# =================================================================== Agent trace 的重复调用与环路检测
@draft('sql-deepseek-agent-trace')
def q_agent_trace_rollup():
    """
    span 行集只声明一次：建表数据、变异 SQL、expected 全部由同一份行集派生。
    深度/环路的定义与 MySQL 侧的递归展开**共用同一条 64 步上限规则**，两边不能各说各话。
    """
    SPANS = [
        # trace_id, span_id, parent_span_id, kind, tool_key, started_ms, finished_ms, status
        (1, 10, None, 'llm', None, 0, 120, 'ok'),
        (1, 11, 10, 'tool', 'search', 120, 400, 'ok'),
        (1, 12, 10, 'tool', 'search', 120, 380, 'ok'),      # 与 11 同一 tool_key：并发且重复
        (1, 13, 12, 'llm', None, 400, 520, 'ok'),
        (1, 14, 13, 'guard', None, 520, 540, 'ok'),
        (2, 20, None, 'llm', None, 0, 100, 'ok'),
        (2, 21, 20, 'tool', 'calc', 100, 160, 'ok'),
        (2, 22, 20, 'tool', 'fetch', 100, 900, 'error'),    # 同一个 llm 下并发的两个不同工具
        (2, 23, 22, 'llm', None, 900, None, 'error'),        # 未完成
        (3, 30, 31, 'llm', None, 0, 50, 'ok'),               # 环：30 ← 31 ← 30
        (3, 31, 30, 'tool', 'search', 50, 90, 'ok'),
        (4, 40, 99, 'llm', None, 0, 70, 'ok'),               # 孤儿：parent 不存在 ⇒ 按根算
        (4, 41, 40, 'tool', 'a', 70, 90, 'ok'),
        (4, 42, 41, 'tool', 'a', 90, 110, 'ok'),
        (4, 43, 42, 'tool', 'b', 110, 130, 'ok'),
        (5, 50, None, 'tool', 'only', 0, None, 'error'),     # 整条 trace 都没有完成的 span
    ]
    COLUMNS = ['trace_id', 'llm_steps', 'tool_calls', 'dup_tool_calls',
               'max_depth', 'wall_ms', 'cycle_flag']
    HOP_LIMIT = 64

    def rollup(rows):
        by_trace = {}
        for r in rows:
            by_trace.setdefault(r[0], []).append(r)
        out = []
        for trace_id in sorted(by_trace):
            spans = by_trace[trace_id]
            parent = {s[1]: s[2] for s in spans}
            ids = set(parent)
            llm_steps = sum(1 for s in spans if s[3] == 'llm')
            tools = [s for s in spans if s[3] == 'tool']
            dup = len(tools) - len({s[4] for s in tools})

            def depth(span_id):
                """沿 parent 链往上数；64 步内到不了根 ⇒ 视为环（返回 None）。"""
                seen = {span_id}
                cur, d = span_id, 1
                while parent.get(cur) is not None:
                    p = parent[cur]
                    if p not in ids:               # 孤儿：parent 不存在 ⇒ 自己就是根
                        break
                    if p in seen or d >= HOP_LIMIT:
                        return None
                    seen.add(p)
                    cur = p
                    d += 1
                return d

            depths = [depth(s[1]) for s in spans]
            cycle = 1 if any(d is None for d in depths) else 0
            max_depth = 0 if cycle else max(depths)
            done = [s for s in spans if s[6] is not None]
            wall = (max(s[6] for s in done) - min(s[5] for s in done)) if done else 0
            out.append([trace_id, llm_steps, len(tools), dup, max_depth, wall, cycle])
        return out

    def case(name, mutations=(), note=None):
        rows = list(SPANS)
        sql = []
        for mut in mutations:
            kind = mut[0]
            if kind == 'del':
                rows = [r for r in rows if r[1] != mut[1]]
                sql.append(f'DELETE FROM trace_span WHERE span_id = {mut[1]}')
            elif kind == 'ins':
                r = mut[1]
                rows.append(r)
                sql.append('INSERT INTO trace_span VALUES (' + ', '.join(
                    'NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                    for v in r) + ')')
            elif kind == 'upd':                       # (upd, span_id, column, value)
                _, span_id, col, value = mut
                rows = [r[:cols_index[col]] + (value,) + r[cols_index[col] + 1:]
                        if r[1] == span_id else r for r in rows]
                lit = 'NULL' if value is None else (f"'{value}'" if isinstance(value, str) else str(value))
                sql.append(f'UPDATE trace_span SET {col} = {lit} WHERE span_id = {span_id}')
            else:
                raise AssertionError(f'未知变异类型 {kind}')
        payload = {'name': name, 'input': sql,
                   'expected': {'columns': COLUMNS, 'rows': rollup(rows), 'orderSensitive': True}}
        if note:
            payload['note'] = note
        return payload

    cols = ['trace_id', 'span_id', 'parent_span_id', 'kind', 'tool_key',
            'started_ms', 'finished_ms', 'status']
    cols_index = {c: i for i, c in enumerate(cols)}

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。一个 Agent 运行时把每次任务展开成 span 树：

```
trace_span(trace_id INT, span_id INT PRIMARY KEY, parent_span_id INT NULL,
           kind VARCHAR(8),            -- llm | tool | guard
           tool_key VARCHAR(24) NULL,  -- 仅 kind='tool' 有值：被调的工具标识
           started_ms BIGINT, finished_ms BIGINT NULL,   -- 相对 trace 起点的毫秒；NULL = 未完成
           status VARCHAR(8))          -- ok | error
```

## 任务

按 `trace_id` 升序，每个 trace 输出一行：

```
trace_id, llm_steps, tool_calls, dup_tool_calls, max_depth, wall_ms, cycle_flag
```

## 口径（逐条都是判分点）

1. `llm_steps` = 该 trace 内 `kind='llm'` 的 span 数；
   `tool_calls` = `kind='tool'` 的 span 数。
2. `dup_tool_calls` = `tool_calls − 不同 tool_key 的个数`。
   也就是说同一工具被调 3 次记 2。**只统计 `kind='tool'` 的行**
   （非 tool 的 `tool_key` 一律是 `NULL`，把它算进"不同个数"会让差值失真）。
3. **深度**：根 span 深度 1，孩子 = 父 + 1。
   **孤儿**（`parent_span_id` 指向本表里不存在的 span）**按根处理**（深度 1）。
   `max_depth` = 该 trace 内所有 span 的最大深度。
4. **环**：从任一 span 出发沿 `parent_span_id` 往上走，
   **最多走 64 跳**；若仍然回不到根（遇到重复访问的 span，或跳数用尽），
   该 trace 记 `cycle_flag = 1` 且 **`max_depth = 0`**。
   为什么要有跳数上限而不是"直接递归到死"：递归 CTE 碰上环就是一条永不收敛的查询，
   而线上 trace 表里出现环是**运行时 bug 的正常产物**（父指针写错、重试复用了 span id），
   聚合查询不能因为一条坏数据把整张报表拖挂。
5. `wall_ms` = 在**已完成**（`finished_ms IS NOT NULL`）的 span 上取
   `MAX(finished_ms) − MIN(started_ms)`；一条 trace 里没有任何完成 span ⇒ `0`（不是 `NULL`）。
   注意是墙钟跨度：并发子 span 的时间是重叠的，**不许把各 span 时长相加**。
6. `status` 本题不参与判定（不要按成功/失败过滤行 —— 失败的 span 照样要计数，
   空转的循环恰恰是最需要被看到的）。

只交一条 `SELECT` / `WITH` 查询。允许使用递归 CTE。

## 这题真正考的东西

- **`SUM(每个 span 的时长)` 不等于端到端耗时**：并发的兄弟 span 会被重复计入，
  而 Agent 运行时**大量使用并发工具调用**。用错了这个指标，
  "优化并行度"会让报表显示耗时上升。
- **深度要沿父链算**，不能靠 `kind` 猜层级（`llm → tool → guard` 不是固定的三层，
  复核环里会出现 `tool → llm → tool`）。
- **坏数据必须被聚合而不是被丢弃**：孤儿、环、未完成，全都是"这条 trace 有病"的信号，
  把它们过滤掉的查询看起来更干净，但正好把故障样本删了。"""

    reference = """WITH RECURSIVE walk AS (
  -- 从每个 span 出发沿 parent 往上爬；hops = 已经爬了几跳
  SELECT s.trace_id, s.span_id AS start_id, s.span_id AS cur, 0 AS hops, 0 AS cyc
  FROM trace_span s
  UNION ALL
  SELECT w.trace_id, w.start_id, p.parent_span_id, w.hops + 1,
         CASE WHEN p.parent_span_id = w.start_id THEN 1     -- 爬回自己 ⇒ 环
              WHEN w.hops + 1 >= 64 THEN 1                 -- 跳数用尽也按环处理
              ELSE 0 END
  FROM walk w
  JOIN trace_span p ON p.span_id = w.cur
  WHERE w.cyc = 0 AND w.hops < 64
    AND p.parent_span_id IS NOT NULL
    -- 父指针指向表里不存在的 span ⇒ 就地停下：cur 才是根（多爬一跳会把深度算大 1）
    AND EXISTS (SELECT 1 FROM trace_span g WHERE g.span_id = p.parent_span_id)
), span_depth AS (
  SELECT trace_id,
         start_id,
         MAX(cyc) AS cyc,
         CASE WHEN MAX(cyc) = 1 THEN NULL ELSE MAX(hops) + 1 END AS depth
  FROM walk
  GROUP BY trace_id, start_id
), roll AS (
  SELECT t.trace_id,
         SUM(t.kind = 'llm')  AS llm_steps,
         SUM(t.kind = 'tool') AS tool_calls,
         SUM(t.kind = 'tool')
           - COUNT(DISTINCT CASE WHEN t.kind = 'tool' THEN t.tool_key END) AS dup_tool_calls
  FROM trace_span t
  GROUP BY t.trace_id
), wall AS (
  SELECT trace_id, COALESCE(MAX(finished_ms) - MIN(started_ms), 0) AS wall_ms
  FROM trace_span
  WHERE finished_ms IS NOT NULL
  GROUP BY trace_id
)
SELECT r.trace_id,
       r.llm_steps,
       r.tool_calls,
       r.dup_tool_calls,
       CASE WHEN MAX(sd.cyc) = 1 THEN 0 ELSE COALESCE(MAX(sd.depth), 0) END AS max_depth,
       COALESCE(w.wall_ms, 0) AS wall_ms,
       MAX(sd.cyc) AS cycle_flag
FROM roll r
LEFT JOIN span_depth sd ON sd.trace_id = r.trace_id
LEFT JOIN wall w ON w.trace_id = r.trace_id
GROUP BY r.trace_id, r.llm_steps, r.tool_calls, r.dup_tool_calls, w.wall_ms
ORDER BY r.trace_id"""

    naive = """-- "报表能出数就行"版：端到端耗时用 SUM 累加、深度按 kind 猜、坏数据直接过滤
SELECT t.trace_id,
       SUM(CASE WHEN t.kind = 'llm' THEN 1 ELSE 0 END)                  AS llm_steps,
       SUM(CASE WHEN t.kind = 'tool' THEN 1 ELSE 0 END)                 AS tool_calls,
       SUM(CASE WHEN t.kind = 'tool' THEN 1 ELSE 0 END)
         - COUNT(DISTINCT t.tool_key)                                    AS dup_tool_calls,
       COUNT(DISTINCT t.kind)                                            AS max_depth,
       SUM(CASE WHEN t.finished_ms IS NOT NULL
                THEN t.finished_ms - t.started_ms ELSE 0 END)           AS wall_ms,
       0                                                                 AS cycle_flag
FROM trace_span t
WHERE t.parent_span_id IS NULL
   OR EXISTS (SELECT 1 FROM trace_span p WHERE p.span_id = t.parent_span_id)  -- 丢孤儿
GROUP BY t.trace_id
ORDER BY t.trace_id"""

    answer = """## 基线手算一遍（用来核对 expected 是不是真的对）

- **trace 1**：`llm` 有 10、13 ⇒ 2；`tool` 有 11、12 ⇒ 2，`tool_key` 都是 `search` ⇒ dup = 2−1 = **1**；
  深度 10=1、11/12=2、13=3、14=4 ⇒ `max_depth=4`；
  墙钟 = `max(finished)=540 − min(started)=0` = **540**。
  注意 11 与 12 是**并发**的（都从 120 起）：`SUM(时长)` 会得到
  `(400−120)+(380−120)+(120−0)+(520−400)+(540−520) = 500` —— 比真实跨度还大，
  而如果把 13/14 串在 12 后面，重复计得更多。
- **trace 2**：llm 2（20、23）、tool 2（calc/fetch ⇒ dup=0）、深度 21/22=2、23=3 ⇒ 3；
  23 未完成 ⇒ 墙钟只看到 20/21/22 ⇒ `900−0 = 900`。
  失败的 22 照样计数 —— 它是"工具挂了但 Agent 继续往下推"的样本。
- **trace 3**：30 的父是 31、31 的父是 30 ⇒ 环 ⇒ `cycle_flag=1`、`max_depth=0`。
- **trace 4**：40 的父 99 不存在 ⇒ 孤儿按根算 ⇒ 40=1、41=2、42=3、43=4；
  tool 3 个、`tool_key` 有 a/b 两种 ⇒ dup = **1**；墙钟 = `130−0 = 130`。
- **trace 5**：唯一的 span 未完成 ⇒ `wall_ms=0`（不是 NULL），`tool_calls=1`、`dup=0`、深度 1。

**为什么 `WHERE parent 存在` 是这道题最贵的一个错**：孤儿 span 是"父指针写坏了"的**唯一证据**。
过滤掉它，报表立刻变干净，而运行时那个 bug 再也没有可观测的痕迹。
正确做法是把孤儿按根处理（它确实没有可见的上游），并在深度上继续算。

**环必须有跳数上限**：MySQL 的递归 CTE 没有内置的环检测，
`WITH RECURSIVE` 碰上环要么跑到 `cte_max_recursion_depth`（默认 18446744073709551615 ⇒ 实际是
要么卡死要么爆内存）。工程做法两种：
① 递归里带 `depth < 64` 的上限，超出即视为环（本答案这种）；
② 路径物化成字符串再判断是否重复访问（可读性差、成本随链长增长）。
两者都比"赌线上没有环"好 —— **Agent 运行时写坏父指针是常态而不是异常**，
尤其是重试路径复用 `span_id` 的实现。

**`wall_ms` 的口径要显式选**：本题定义为
"已完成 span 的最晚 `finished_ms` 减去全部 span 的最早 `started_ms`"。
它既不是关键路径长度（那需要拓扑排序 + 资源模型），也不是 `SUM(时长)`（会把并发算成串行）。
报表上"端到端耗时"这四个字如果不写成公式，两个团队能给出差 3 倍的数 ——
而这道题真正的判分点就在这句上。

**工程延伸（面试追问点）**

1. 环路深度是检测出来了，怎么定位到是谁写坏的？（要的是"成环的那对 span 的 kind 与创建顺序"：
   `finished_ms` 更早的一方不该是较晚一方的后代 —— 时序矛盾比拓扑环更容易归因。）
2. `dup_tool_calls` 为什么要减"不同 key 数"而不是找"重复次数 ≥2 的 key 数"？
   （前者量的是**浪费掉的调用数**（3 次同调用记 2），后者量的是"有几个工具被重复"。
   做成本归因要用前者，做异常检测用后者。本题要的是成本。）
3. 真上线时这张表怎么撑住？（`trace_id` 分桶 + 只保留 `cycle_flag=1`/`dup>0` 的明细，
   其余走预聚合。报表用预聚合、下钻用采样后的明细 —— 40 亿级的 trace 明细全量可查是不成立的。）
4. 为什么本题不按 `status='ok'` 过滤？（一旦过滤，"失败的循环"与"没跑完的任务"
   就从指标里消失了，而这两类正是 Agent 平台最该被看见的样本。
   状态应该是一个**分组维度**，不是聚合的前置条件。）"""

    return base(
        'sql', 'senior',
        'Agent trace 汇总：环要有跳数上限，端到端耗时不能拿 span 时长累加',
        statement, 'mysql',
        ['trace-aggregation', 'recursive-cte', 'cycle-detection', 'wall-clock-vs-sum',
         'modern:agent-ops'],
        src('DeepSeek', 'Agent 平台 / 可观测性 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#79,#69,#67（原文只列"要采集链路数据"'
            '与"重复调用是常见问题"，未给可判分的深度/环/墙钟口径）'),
        language='sql',
        cases=[
            case('基线：五条 trace 各测一条口径（含环、孤儿、未完成）',
                 note='trace1 dup=1 depth=4 wall=540；trace3 环；trace4 孤儿按根；trace5 无完成 ⇒ 0'),
            case('删掉环上的一条：这条 trace 立刻变成正常的深度链',
                 [('del', 31)],
                 note='期望里 trace3 消失（只剩 30 一条 ⇒ 深度 1、cycle 0）—— 证明环是真的在判'),
            case('并发的两个工具改成串行：墙钟不变、但 dup 仍在',
                 [('upd', 12, 'started_ms', 400)],
                 note='墙钟是跨度不是累加：把并发改串行，SUM(时长) 会变而 wall_ms 不该变'),
            case('把孤儿接回一个真实存在的父：深度整体下移一层',
                 [('upd', 40, 'parent_span_id', 43)],
                 note='43→40→41→42→43 成环 ⇒ trace4 的 cycle_flag 变 1、max_depth 变 0'),
            case('重复调用同一个 key：dup 加一、深度与墙钟不动',
                 [('ins', (4, 44, 41, 'tool', 'a', 95, 115, 'ok'))],
                 note='trace4 tool_calls 3→4、dup 1→2'),
            case('让唯一完成的 span 变成未完成：wall_ms 归 0 而不是 NULL',
                 [('del', 50), ('ins', (5, 51, None, 'tool', 'only', 0, None, 'error'))],
                 note='没有任何 finished_ms ⇒ 0；把 NULL 吐出来的实现在这里露出来'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS trace_span',
                'CREATE TABLE trace_span (trace_id INT NOT NULL, span_id INT PRIMARY KEY, '
                'parent_span_id INT NULL, kind VARCHAR(8) NOT NULL, tool_key VARCHAR(24) NULL, '
                'started_ms BIGINT NOT NULL, finished_ms BIGINT NULL, status VARCHAR(8) NOT NULL) '
                'ENGINE=InnoDB',
                'INSERT INTO trace_span VALUES ' + ', '.join(
                    '(' + ', '.join('NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                                    for v in r) + ')'
                    for r in SPANS),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=32,
        answer=answer,
    )


# =================================================================== 推理日志落盘前的脱敏
@draft('alg-deepseek-log-redaction')
def q_log_redaction():
    """
    expected 由 redact() 算出。模型故意用 Python 的 str（**按码点**计数）重写一遍 ——
    Java 的 String.length() 是 UTF-16 长度，两边不一致的地方正是本题的判分点。
    """
    MARKER = '[PROMPT]'
    ELLIPSIS = '\u2026(truncated)'

    def redact(keys, values, sensitive, max_text_chars):
        n = len(keys)
        if len(values) != n:
            raise ValueError('keys and values disagree')
        if max_text_chars < 0:
            raise ValueError('maxTextChars must be >= 0')
        for k in keys:
            if k is None or k == '':
                raise ValueError('empty key')
        for k in sensitive:
            if k is None or k == '':
                raise ValueError('empty sensitive key')
        if len(set(keys)) != n:
            raise ValueError('duplicated key')

        out = []
        for i in range(n):
            k, v = keys[i], values[i]
            if v is None:
                out.append(f'{k}=')
                continue
            if k in sensitive:
                out.append(f'{k}=<redacted:len={len(v)}>')      # 码点数，不是 UTF-16 长度
                continue
            head, sep, _tail = v.partition(MARKER)
            if sep:
                out.append(f'{k}={head}<redacted:tail>')        # 藏在普通字段里的 prompt 正文
                continue
            if len(v) > max_text_chars:
                out.append(f'{k}={v[:max_text_chars]}{ELLIPSIS}')
                continue
            out.append(f'{k}={v}')
        return out

    def case(name, keys, values, sensitive, max_text_chars, throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 的同名注释）。"""
        try:
            got = redact(keys, values, sensitive, max_text_chars)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [keys, values, sensitive, max_text_chars],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [keys, values, sensitive, max_text_chars], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    SENS = ['prompt', 'completion', 'user_query']

    statement = """## 背景

推理服务的日志里，**用户原文是唯一不能原样落盘的东西**（题库 #60 就一句话："脱敏、采样、合规过滤"）。
真实系统里出事不是"忘了配脱敏"，而是脱敏写在了错的一层：
`prompt` 字段干净了，但一次上游异常的 `error_message` 里带着整段用户输入 ——
于是合规审查扫到明文，而代码看起来"我们确实做了脱敏"。

本题实现落盘前的那一道函数：**键值对进，可安全落盘的 `k=v` 出**。

## 你要实现的入口

```java
public static String[] redact(String[] keys, String[] values, String[] sensitiveKeys, int maxTextChars)
```

`keys[i]` 与 `values[i]` 是第 i 个字段。返回值是**等长**的 `k=v` 字符串数组，
按**输入顺序**输出（不排序 —— 日志行的字段顺序由打点方决定）。

## 四条处理规则（按优先级从高到低，命中即停）

1. `values[i]` 为 `null` ⇒ 输出 `k=`（空值，不是 `k=null` ——
   "没这个字段"与"字段值是字符串 null"必须能区分）。
2. **`keys[i]` 在 `sensitiveKeys` 里** ⇒ 输出 `k=<redacted:len=N>`，
   其中 `N` 是原值的**码点数**（Unicode code point 个数）。
   长度要留：容量分析与"prompt 变长没有"的趋势判断都靠它。
3. 否则，若值里出现子串 **`[PROMPT]`** ⇒ 输出 `k=<该标记之前的原文><redacted:tail>`。
   即从标记开始到结尾**整段丢弃**。这是给"prompt 正文被塞进普通字段"准备的兜底。
   标记本身**不出现在输出里**。
4. 否则，若值的码点数 `> maxTextChars` ⇒ 输出 `k=<前 maxTextChars 个码点>…(truncated)`
   （省略号是单个字符 U+2026 后接字面量 `(truncated)`）。
   **截断必须落在码点边界上**，不许把一个 emoji 劈成一半。

`maxTextChars == 0` 是合法配置（"这个 logger 只留字段名"）。

## 非法输入（抛 `IllegalArgumentException`）

`keys` 与 `values` 长度不一致；某个键是 `null` 或空串；
`sensitiveKeys` 里有 `null` 或空串；`keys` 内有重复键；`maxTextChars < 0`。

不许引入第三方依赖 —— 这题考的就是你敢不敢直接写 `String.length()`。"""

    reference = """import java.util.HashSet;
import java.util.Set;

public class Solution {
  private static final String MARKER = "[PROMPT]";
  private static final String ELLIPSIS = "\\u2026(truncated)";

  public static String[] redact(String[] keys, String[] values, String[] sensitiveKeys, int maxTextChars) {
    if (keys.length != values.length) throw new IllegalArgumentException("keys and values disagree");
    if (maxTextChars < 0) throw new IllegalArgumentException("maxTextChars must be >= 0");
    for (String k : keys) {
      if (k == null || k.isEmpty()) throw new IllegalArgumentException("empty key");
    }
    for (String k : sensitiveKeys) {
      if (k == null || k.isEmpty()) throw new IllegalArgumentException("empty sensitive key");
    }
    Set<String> dedupe = new HashSet<>();
    for (String k : keys) {
      if (!dedupe.add(k)) throw new IllegalArgumentException("duplicated key: " + k);
    }
    Set<String> sensitive = new HashSet<>();
    for (String k : sensitiveKeys) {
      sensitive.add(k);
    }

    String[] out = new String[keys.length];
    for (int i = 0; i < keys.length; i++) {
      String k = keys[i];
      String v = values[i];
      if (v == null) {
        out[i] = k + "=";
        continue;
      }
      if (sensitive.contains(k)) {
        // codePointCount 而不是 length()：一个 emoji 在 UTF-16 里占两个 code unit，
        // 用 length() 会让"prompt 平均长度"这类趋势指标系统性偏高
        out[i] = k + "=<redacted:len=" + v.codePointCount(0, v.length()) + ">";
        continue;
      }
      int at = v.indexOf(MARKER);
      if (at >= 0) {
        out[i] = k + "=" + v.substring(0, at) + "<redacted:tail>";
        continue;
      }
      int chars = v.codePointCount(0, v.length());
      if (chars > maxTextChars) {
        // 按码点跳，避免截在代理对中间留下孤立 high surrogate（后续编码会直接抛错或产出 U+FFFD）
        int end = v.offsetByCodePoints(0, maxTextChars);
        out[i] = k + "=" + v.substring(0, end) + ELLIPSIS;
        continue;
      }
      out[i] = k + "=" + v;
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // 只看顶层键、按 UTF-16 计数与截断的版本
  public static String[] redact(String[] keys, String[] values, String[] sensitiveKeys, int maxTextChars) {
    if (keys.length != values.length) throw new IllegalArgumentException("keys and values disagree");
    if (maxTextChars < 0) throw new IllegalArgumentException("maxTextChars must be >= 0");
    java.util.List<String> sensitive = java.util.Arrays.asList(sensitiveKeys);
    String[] out = new String[keys.length];
    for (int i = 0; i < keys.length; i++) {
      String k = keys[i], v = values[i];
      if (v == null) {
        out[i] = k + "=null";                     // 错 1：区分不出"没有值"与"值是字符串 null"
      } else if (sensitive.contains(k)) {
        out[i] = k + "=<redacted:len=" + v.length() + ">";   // 错 2：UTF-16 长度
      } else if (v.length() > maxTextChars) {
        out[i] = k + "=" + v.substring(0, maxTextChars) + "\u2026(truncated)";  // 错 3：可能劈开代理对
      } else {
        out[i] = k + "=" + v;                     // 错 4：普通字段里嵌的 [PROMPT] 原样落盘
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

四条规则的优先级不能换：`null` → 敏感键 → 内嵌标记 → 截断。
两处必须用码点而不是 `length()`：`codePointCount(0, v.length())` 算长度、
`offsetByCodePoints(0, maxTextChars)` 定位截断点。
后者尤其容易漏 —— `substring(0, n)` 按 code unit 切，切进代理对中间会留下
**孤立的 high surrogate**，这条日志一旦经 UTF-8 编码就可能抛错或变成 `U+FFFD`，
表现为"某几条日志写进去就读不出来"。

**最贵的一条是规则 3**（用例「普通字段里嵌着 prompt 正文」）：
`error_message` 不是敏感字段，但异常对象把 `e.getMessage()` 拼上了整段 prompt。
顶层键白名单式的脱敏对这种情况**完全无效**，而且它通常只在出错路径上触发 ——
也就是最容易被日志采样率降到低频、又最不该泄密的那条路径。
所以兜底必须是**按内容**（标记/正则）而不是只按字段名。
（真实的合规实现会再加一层结构化抽取：`[PROMPT]` 是"打点方显式标注"，
无法覆盖打点方自己不知道的泄漏，那一层要靠内容识别，而内容有假阴性 ——
这是为什么"日志最小化"永远优于"日志脱敏"：不打进去的字段不需要脱敏。）

**码点数与 UTF-16 长度的差不是学术问题**（用例「emoji 让 length() 与码点数分开」）：
一条中英混排带表情的 prompt，`length()` 可能比码点数大 10% 以上。
用它做"prompt 平均长度"的趋势看板，会得到一条**受内容语言分布影响**的曲线 ——
运营问"这周输入为什么变长了"，真实答案可能只是"中文用户占比涨了"。

**`k=` 与 `k=null` 的区分**（规则 1）看着像洁癖，实际决定一件事：
"SLS 里这条记录没有 completion 字段"与"模型真的回了字符串 null"。
后者是一次线上事故的形状（解析器把 None 打成了 'None'/'null'），
把它和前一个混在一起，就再也查不出那次事故影响了多少请求。

**工程延伸（面试追问点）**

1. 白名单还是黑名单？（字段名脱敏是黑名单，永远漏；正确形状是
   **打点接口只接受白名单字段**，未声明的字段编译期就写不进去。
   本题的函数是"最后一公里"，真正的防线在打点 API。）
2. 采样怎么和脱敏配合？（先脱敏再采样。反过来会出现"采样器按原文长度/哈希选了样本"，
   等于把内容信息泄漏进了抽样决策本身。）
3. 为什么标记选 `[PROMPT]` 这种显式串？（可判定、可测、零假阳性。
   代价是依赖打点方遵守约定 —— 所以规范里要写成"凡是把用户输入拼进字符串的地方必须打标记"，
   并用一条 lint 规则去查 `message = ... + prompt` 这类拼接。）
4. 保留 `len` 有什么风险？（长度本身可以是敏感信息（侧信道）：
   对特定租户，"prompt 长度 = 1234"可能就能定位到某条具体输入。
   工程折中是**分桶**（`<redacted:len=~1k>`），代价是趋势指标变粗 ——
   这题按精确长度判分是为了可判，答的时候要说清真实系统里这一步会被合规要求改掉。）"""

    return base(
        'algorithms', 'senior',
        '推理日志落盘前脱敏：码点计数、按内容兜底、别把 emoji 劈成一半',
        statement, 'java-junit',
        ['log-redaction', 'privacy', 'unicode', 'utf16-vs-codepoint',
         'modern:privacy-engineering'],
        src('DeepSeek', '推理服务 / 平台工程 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#60（原文只答"脱敏、日志采样、合规过滤"'
            '三个词，未给可判分的优先级、码点口径与内嵌泄漏兜底）'),
        language='java',
        cases=[
            case('基线：普通字段原样保留，敏感字段整值替换',
                 ['model', 'prompt', 'ttft_ms'],
                 ['deepseek-chat', '讲一个关于海边的故事', '142'], SENS, 40),
            case('emoji 让 length() 与码点数分开',
                 ['completion'], ['\U0001F42F\U0001F42F\U0001F42F 三只猴子'], SENS, 5,
                 note='3 个 emoji + 1 个空格 + 4 个汉字 = 8 个码点，而 UTF-16 长度是 11'),
            case('普通字段里嵌着 prompt 正文：按内容兜底',
                 ['error_message'], ['upstream 502 while reading [PROMPT]讲一个关于海边的故事'],
                 ['prompt'], 200,
                 note='error_message 不在敏感键里 —— 只有规则 3 能拦住它'),
            case('敏感键优先于标记：整值替换，不谈 tail',
                 ['prompt'], ['[PROMPT]whatever'], SENS, 5),
            case('截断正好落在码点边界：不劈开代理对',
                 ['note'], ['a\U0001F42Fb'], ['prompt'], 2,
                 note='maxTextChars=2 ⇒ 保留 "a" + 猴子两个 code unit，正好是一个完整码点'),
            case('maxTextChars 为 0：只留字段名',
                 ['note', 'other'], ['anything', ''], [], 0),
            case('null 与空串必须区分',
                 ['a', 'b'], [None, ''], ['prompt'], 10),
            case('值没超上限就原样保留',
                 ['note'], ['short'], [], 10),
            case('退化：没有任何字段', [], [], [], 10),
            case('非法：keys 与 values 长度不一致', ['a'], ['1', '2'], [], 10, throws=True),
            case('非法：键为空串', [''], ['v'], [], 10, throws=True),
            case('非法：敏感键里有空串', ['a'], ['v'], [''], 10, throws=True),
            case('非法：键重复', ['a', 'a'], ['1', '2'], [], 10, throws=True,
                 note='重复键会让一行日志里出现两个同名字段，下游解析取哪个是不确定的'),
            case('非法：maxTextChars 为负', ['a'], ['v'], [], -1, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'String[] redact(String[] keys, String[] values, '
                             'String[] sensitiveKeys, int maxTextChars)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== 两道主观题：尾部延迟与 GPU 资源池
@draft('hot-deepseek-tail-latency')
def q_tail_latency():
    statement = """## 场景

**你正在面试 DeepSeek 的推理服务工程师，30 分钟（短设计题）**

一个对外 API 的 TTFT P99 是 1.8s，P50 是 180ms —— **10 倍**。
产品要求"P99 降到 800ms 以内"。你手上已有的事实：

- 集群 GPU 平均利用率 78%（工程上认为健康区间是 70~85%）；
- 压测显示 P99 的构成大致是"排队等待 + prefill 计算 + 一次偶发重试"；
- 约 3% 的请求 prompt 长度超过 32K；
- 有租户报告"同一句请求第二次就很快"；
- 团队的第一反应是"加机器 / 把 max_tokens 调小 / 换更小的模型"。

## 你要回答的问题

1. 为什么"平均利用率 78% 很健康"这个判断在推理服务里几乎不能用来支撑任何结论？
   你真正要看的是哪几个量？
2. 把 P99 拆成可归因的组成部分。对每一项，给出**能把它单独量出来的观测**
   （不是"看监控大盘"）。
3. 那 3% 的超长请求该怎么处理？给出至少两种策略并说明各自的受害方。
4. "同一句第二次很快"说明了什么？这条线索对降 P99 的价值在哪里？
   什么情况下它会**误导**你？
5. 团队那三个第一反应，逐个判断：哪些根本不该做、哪些要换个做法、哪些可以做但收益上限在哪。
6. 如果只能做一件事把 P99 打到 800ms，你选哪件？说明你为什么愿意承担另一个指标变差。"""

    return base(
        'hot-interviews', 'senior',
        'TTFT P99 是 P50 的十倍：利用率为什么不算证据、P99 怎么拆、超长请求怎么办',
        statement, 'llm-rubric',
        ['tail-latency', 'ttft', 'queueing', 'prefix-cache', 'capacity-planning',
         'modern:llm-inference'],
        src('DeepSeek', '推理服务 / 性能工程 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#53,#42,#49,#50（原文只列"尾部延迟要优化"'
            '与"指标清单"，未给可判分的拆解路径与三个常见反应的判词）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '说清平均利用率为什么不是证据', 'weight': 2,
                 'criteria': '必须指出利用率是**时间均值**，而长尾来自**瞬时排队与批次形状**：'
                             '78% 的均值可以与"每 30 秒一次满员 + 每 30 秒空转"同时成立；'
                             '并且推理的"利用率"通常指 SM 占用，与"是否还能接请求"无关。'
                             '要看的量至少包括：排队时长分布（分位数）、在途 token 数/显存分页占用、'
                             'batch 内序列长度方差、以及被准入拒绝的比率。'
                             '只答"利用率不是越高越好"（题面已给）不得分。'},
                {'label': 'P99 每一项都能被单独量出来', 'weight': 3,
                 'criteria': '拆解必须落到**可观测的具体量**：'
                             '排队 = 进网关到入 batch 的时间差；'
                             'prefill = 入 batch 到第一个 token（并按长度分桶，否则 3% 的长请求把整桶拉走）；'
                             '重试 = 是否有重试标记与重试次数（无标记就永远量不出来）；'
                             '还要看**批次凑齐等待**（为凑 batch 而故意等的时间），'
                             '这是推理服务特有且最常被忽略的一项。'
                             '关键判据：每项都有一个"只包含它"的指标名，'
                             '而不是"看 TTFT 大盘"。'},
                {'label': '3% 超长请求的两种以上策略与受害方', 'weight': 2,
                 'criteria': '候选策略需点名并说明代价：'
                             '单独成批/单独池（代价：该池利用率低，成本上升）；'
                             '拆成 prefill 分块 + 抢占（代价：实现复杂、短请求也可能被拖）；'
                             '降级到小模型或返回"请缩小上下文"（代价：用户体验与准确率）；'
                             '排队+异步回调（代价：产品形态变化）；'
                             '前缀缓存优先调度（把长且可复用前缀的放低优先级批次）。'
                             '必须说清"受害方是谁"，只说"优化长请求"不得分。'},
                {'label': '"第二次很快"的线索与它的误导面', 'weight': 1,
                 'criteria': '正确解读：前缀缓存在起作用 ⇒ P99 的那批很可能是**冷前缀**请求，'
                             '于是优化方向是提高命中率（路由亲和、缓存淘汰策略）而不是加算力。'
                             '误导面必须指出：如果同一句很快是因为结果被缓存了，'
                             '那"重复请求"这个流量结构本身在替你掩盖容量不足 ——'
                             '真实用户分布一变（比如新活动带来大量首次问题），P99 会突然恶化；'
                             '并且压测用重复语料会系统性低估延迟。'},
                {'label': '对三个第一反应给出判词', 'weight': 1,
                 'criteria': '加机器：能降排队但**不解决批次凑齐与长请求同批**，'
                             '收益上限取决于排队在 P99 中的占比（要先测再买）；'
                             '调小 max_tokens：改的是总时长而不是 TTFT，'
                             '对本案例的指标目标基本无效，且伤输出质量；'
                             '换小模型：TTFT 会降，代价是质量与重试率上升'
                             '（更多请求需要二次生成 ⇒ 总延迟反而上升）。'
                             '必须逐个判，笼统说"要看数据"不得分。'},
                {'label': '只允许做一件事时给出取舍', 'weight': 1,
                 'criteria': '给出单一动作、理由、以及明确"哪个指标会变差"。'
                             '合理答案示例：把长请求与短请求分批/分池'
                             '（P99 直接受益，代价是 GPU 成本或吞吐上升）；'
                             '或做前缀亲和路由（命中率升 ⇒ 冷 prefill 排队减少，'
                             '代价是负载更不均）。'
                             '关键在"愿意承担什么变差"是否说得出，选哪个是次要的。'},
            ],
            'notes': '总分封顶 5 的情形：把 P99 归因为"个别请求比较大"而不给拆解路径；'
                     '全程用 QPS/利用率说话，没有出现"在途 token / 排队时长 / 批次等待"任一量；'
                     '主张"提高并发凑更大 batch"却不谈凑批等待对 P99 的伤害；'
                     '对"换小模型"没有任何质量代价的判断。',
        },
        estimatedMinutes=30,
        answer="""## 参考答案要点

**均值利用率不能支撑结论**：P99 是关于"最坏那一刻"的陈述，
而 78% 是把 24 小时抹平之后的数。要换成四个可分别恶化的量：
排队时长分布、在途 token / 显存分页占用、batch 内序列长度方差、准入拒绝率。
其中"batch 内长度方差"最常被忽略 —— 它决定短请求是否要陪长请求走完一步。

**P99 拆解**要落到"每项一个指标"：进网关→入 batch（排队）、
入 batch→首 token（prefill，**必须按长度分桶**，否则 3% 的长请求会把整桶分位数拉走，
你会误以为"prefill 变慢了"）、是否重试与重试次数（**没有重试标记就永远量不出来**，
这本身就是一条该先做的工程改造）、以及为凑 batch 的故意等待。

**"第二次很快"是本案最值钱的一条线索**：它说明前缀缓存在起作用，
因此 P99 的那批大概率是**冷前缀**请求 ⇒ 优化方向是命中率
（路由亲和 + 淘汰策略），而不是算力。
但它有两个误导面：一是重复流量在替你掩盖容量不足（首次问题占比一升就雪崩），
二是**压测语料如果重复，测出来的 P99 是假的**。

**三个反应里只有一个半是对的**：加机器能解决排队但解决不了"长短同批"，
所以先测排队占比再决定买不买；`max_tokens` 改的是总时长不是 TTFT，对本案目标无效；
换小模型会把质量成本转移到重试上，可能让总延迟反而上升。

**只做一件事**：把长请求与短请求分池（或至少分批）。
它直接针对"短请求被迫陪跑"这个最可能的 P99 来源，
代价明确是长请求池利用率低、单位成本上升 —— 这是一笔**用成本买分位数**的交易，
说得出代价比选哪个更重要。"""
    )


@draft('sys-deepseek-gpu-resource-pool')
def q_gpu_resource_pool():
    statement = """## 场景

**你正在面试 DeepSeek 的推理平台负责人，50 分钟**

你接管一个共享 GPU 池：同一批卡上要跑三类负载 ——
交互式对话（TTFT 敏感）、离线批量生成（只看吞吐、可抢占）、
以及一个内部微调任务（长占卡，一周跑一次）。
现状：三者都靠"提交任务时选一个队列"，队列权重是人写的配置，没人能解释为什么是 3:5:2。

一次事故：批量任务在月末集中跑，交互式 TTFT P99 从 1.2s 涨到 26s，
值班手动暂停批量任务后恢复；复盘时发现**微调任务其实当时只用了 12% 的显存**，
但它的卡是独占的。

## 你要给出的设计

1. 这三类负载的**资源需求形状**有什么不同（不要说"轻重缓急"，要说形状：
   显存曲线、算力曲线、可中断性、延迟敏感度）。
   说明形状差异决定了哪些能同池、哪些不能。
2. 给出你的调度单元与隔离手段：卡级？MIG 实例级？批内 slot 级？
   每一层的收益与代价分别是什么，你为什么这样选。
3. 权重 3:5:2 这种配置为什么必然腐化？给出一个**能自我校正**的机制
   （输入信号是什么、校正动作是什么、多久一次）。
4. 抢占的边界：谁可以抢谁？给出抢占的**代价函数**（被抢的一方损失了什么），
   并说明哪些任务永远不该被抢、为什么。
5. "微调只用了 12% 显存却独占卡"——给出两件事：短期怎么把这块算力收回来用，
   长期怎么让这类任务不再需要独占。
6. 你怎么向三类用户**分别承诺**？给出每类的承诺形式，
   并指出承诺与承诺之间会互相冲突的那个点。"""

    return base(
        'system-design', 'senior',
        '共享 GPU 池：负载形状、隔离层级、能自我校正的权重与抢占代价函数',
        statement, 'llm-rubric',
        ['gpu-scheduling', 'multi-tenancy', 'isolation', 'preemption', 'slo-promises',
         'modern:inference-scheduling'],
        src('DeepSeek', '推理平台 / 资源调度 负责人',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#44,#58,#59,#51,#29'
            '（原文逐条列了"调度要解决哪些问题""MIG 是什么""为什么不能靠 K8s 原生调度"，'
            '未给可判分的形状分析、抢占代价与承诺形式）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '用形状而不是缓急描述三类负载', 'weight': 2,
                 'criteria': '必须给出可比较的维度并填出差异：'
                             '显存占用曲线（交互：随会话长度增长且**不可预测**；'
                             '批量：平稳可预估；微调：固定且通常远小于分配量）、'
                             '算力时间形状（交互：短促尖峰；批量：长而连续；微调：整段独占）、'
                             '可中断性（批量/微调可断点续跑，交互的"中断"等于用户体验归零）、'
                             '延迟敏感度（TTFT vs 完成时刻）。'
                             '关键结论必须是"形状决定是否同池"，'
                             '例如交互与批量**可**同池但必须做批内 slot 隔离；'
                             '微调与交互同池会因不可中断而致命。'},
                {'label': '隔离层级与每层代价', 'weight': 2,
                 'criteria': '要说清三层各自的收益与代价：'
                             '卡级隔离（简单、浪费大 —— 正是事故里的微调独占）；'
                             'MIG/时分复用（显存与 SM 硬切，抗干扰强，代价是**粒度固定**、'
                             '且切了之后不能超卖，弹性下降）；'
                             '批内 slot / 调度配额（最细、利用率高，代价是软隔离 ——'
                             '一次显存暴涨就能击穿，且抢占语义复杂）。'
                             '加分：指出"硬隔离用于防互相伤害、软隔离用于提高利用率"，'
                             '两者要叠用而不是二选一。'},
                {'label': '权重为什么腐化 + 自校正机制', 'weight': 2,
                 'criteria': '必须指出 3:5:2 是**一次谈判的产物**而不是模型：'
                             '流量结构变了它不会跟着变，且没人有权改（改一次要拉三方对齐）。'
                             '自校正机制要有：输入信号（各类的 SLO 裕度 + 队列积压 + '
                             '被抢占损失，而不是"GPU 利用率"）、'
                             '校正动作（调整准入配额/批次上限，**不要求助人工**）、'
                             '频率与稳定化（带滞回，防止在两个解之间震荡）、'
                             '以及护栏（安全类负载不参与自校正）。'},
                {'label': '抢占的方向与代价函数', 'weight': 2,
                 'criteria': '必须给出**代价的构成**：被抢方损失的是'
                             '"已投入且不可恢复"的那部分工作（KV Cache 已生成、'
                             '重算成本 = 剩余步数 × 单价）、抢占本身的停顿成本、'
                             '以及业务侧的违约风险。'
                             '据此决定"谁能抢谁"：批量可被抢且可续跑 ⇒ 优先牺牲；'
                             '微调可断点但重入代价高 ⇒ 只在长窗口下抢；'
                             '交互请求**不该被抢**（用户已在等，抢了也不省时间，'
                             '而且损失的是体验这种不可恢复量）。'
                             '必须点名"哪些永远不该被抢"及理由。'},
                {'label': '微调独占的短期回收与长期消解', 'weight': 1,
                 'criteria': '短期：把微调任务改造成**可让出**形态（checkpoint 到主机内存/磁盘 + '
                             '在空闲间隙跑），或把它切到 MIG 小片上并显存配额化；'
                             '并给出"12% 显存"这个观测本身要怎么持续化（显存申请量 vs 实际占用差值的告警）。'
                             '长期：让这类任务走"配额 + 抢占窗口"而不是独占卡 —— '
                             '即从"包机"改成"有 SLA 的弹性请求"。'},
                {'label': '三类承诺及其冲突点', 'weight': 1,
                 'criteria': '承诺形式必须区分：交互给**延迟分位数 SLO**（P99 TTFT/TPOT）；'
                             '批量给**吞吐或完成窗口**（"每天 N 亿 token / 6 小时内跑完"），'
                             '不给延迟；微调给**配额与最大启动延迟**，不给完成时间。'
                             '冲突点要点明：给批量承诺"越闲越快"与给交互承诺"P99 稳定"是同一块卡的'
                             '同一份空闲，前者会在流量低谷吃光缓冲 ⇒ 突发时交互违约。'
                             '必须给出解法（预留突发缓冲、或让批量承诺随剩余容量动态调整）。'},
            ],
            'notes': '总分封顶 5 的情形：把问题答成"用 K8s + 优先级类即可"；'
                     '所有论证建立在"GPU 利用率"这一个量上；'
                     '抢占只谈"优先级高抢优先级低"而无代价；'
                     '对"月末批量集中跑"这一触发条件没有任何结构性处置（只会说提前沟通）；'
                     '对承诺只说"分别制定 SLA"而给不出形式。',
        },
        estimatedMinutes=50,
        answer="""## 参考答案要点

**形状决定同池**：三类负载在四个轴上的差异是结构性的 ——
显存曲线（会话增长不可预测 / 批量平稳 / 微调固定且远低于申请量）、
算力时间形状（尖峰 / 连续 / 整段独占）、可中断性（不可 / 可续跑 / 可断点）、
延迟敏感度（TTFT / 完成时刻 / 启动时刻）。
"缓急"是政治语言，形状才是工程语言。
结论：交互与批量可以同池但必须做批内 slot 级隔离；微调与交互不该同池，
因为不可中断的一方会把可中断一方产生的抖动放大成违约。

**隔离层级要叠用**：硬隔离（MIG/卡级）防"互相伤害"，
软隔离（批内配额）拿利用率。只用硬隔离就是事故里的 12% 显存独占；
只用软隔离则一次显存暴涨击穿全池。
选点判据是"**被击穿时的损失面**"：延迟 SLO 类必须有硬底座，吞吐类可以完全软。

**权重必然腐化的原因**：`3:5:2` 是一次谈判的结果，不是模型。
自校正的输入不能是"GPU 利用率"（它是结果不是需求），
应该是各类的 **SLO 裕度 + 队列积压 + 被抢占损失**；
动作是调准入配额与批次上限（机器可执行），频率要带滞回否则在两个解之间震荡；
安全/合规类负载不参与自校正，固定预留。

**抢占要有代价函数**，否则等于"谁嗓门大谁赢"。
被抢方的损失 = 已投入且不可恢复的工作（KV 已生成、重算 = 剩余步数 × 单价）
+ 抢占停顿 + 业务违约风险。由此自然得到方向：
批量优先被牺牲（可续跑、损失可量化）、微调只在长窗口下抢、
**交互不该被抢** —— 用户已经在等，抢走它并不省时间，损失还是不可恢复的体验。

**微调独占**：短期把它改成"可让出"（checkpoint + 空闲间隙推进），
并把"申请显存 vs 实际占用"的差值做成常态告警 —— 因为这类浪费的根因是
**没人能证明它被用满了**；长期把这类任务从"包机"变成"有配额与最大启动延迟的弹性请求"。

**三类承诺不可同时静态成立**：交互要 P99 稳定 ⇒ 要留突发缓冲；
批量要"越闲越快" ⇒ 会吃光那份缓冲。它们是同一块卡上的同一份空闲。
解法只有两种：显式预留突发余量（交互优先），
或把批量的完成窗口做成**随剩余容量动态给出的承诺**（而不是固定 6 小时）——
后者更诚实，但它要求平台愿意公开自己的余量，这通常是组织上真正的阻力。"""
    )


# =================================================================== Agent 平台的 FSM（主观题）
@draft('ag-deepseek-agent-fsm')
def q_agent_fsm():
    statement = """## 场景

**你正在面试 DeepSeek 的 Agent 平台工程师，35 分钟**

你们的 Agent 运行时现在是一条 `while` 循环：
把历史丢给模型 → 模型要调工具就调 → 把结果 append 回历史 → 直到模型不再要工具或步数用完。

线上出现四类问题：

1. 一个"退款"类任务在**已经调用过写操作之后**又被重试执行了一遍（用户被退款两次）；
2. 排障时没人说得清"这个任务当时为什么走这一步" —— 只能读完整段对话日志猜；
3. 加了新工具后，老任务的某些分支会走进"模型一直要求调用一个不适用于当前状态的工具"；
4. 长任务跑一半服务重启，任务要么整个重跑，要么直接丢。

有同事提议"给模型加个 system prompt，告诉它各阶段该做什么"。

## 你要回答的问题

1. 上面四条里，哪几条**本质上不是 prompt 问题**、加提示词必然无效？逐条说明为什么。
2. 给这个运行时设计一台状态机：状态集合、允许的事件、以及**转移表由谁拥有**。
   要求能直接回答问题 1 与 4。
3. 状态机与"模型自由决策"的边界在哪？哪些决定必须由模型做、哪些必须由 FSM 做？
   给一条可操作的划分判据。
4. 写操作所在的转移怎么做到可重放而不重复执行？给出标识与对账设计。
5. FSM 会不会把 Agent 变成"工作流引擎"？给出你会**故意不建模**的一类行为，
   并说明为什么它不该进状态机。
6. 怎么证明这台状态机没有变成"永远加不完的补丁"？给一个可量化的健康度指标。"""

    return base(
        'agent-design', 'senior',
        'Agent 运行时 FSM：哪些不是 prompt 问题、转移表归谁、写操作可重放与不建模的边界',
        statement, 'llm-rubric',
        ['agent-runtime', 'fsm', 'idempotency', 'replay', 'workflow-vs-agent',
         'modern:agent-ops'],
        src('DeepSeek', 'Agent 平台 / 运行时 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#72,#67,#68,#69（原文答"FSM 用于约束流程"'
            '一句话，未给可判分的边界划分、写操作重放与不建模范围）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '判出哪些不是 prompt 问题', 'weight': 2,
                 'criteria': '必须点名 1（重复退款）与 4（重启即丢）本质上**加提示词必然无效**：'
                             '前者缺的是幂等/副作用提交点的持久化，'
                             '后者缺的是可恢复状态，两者都不在模型能观测的输入里；'
                             '3 有一半是 prompt 问题但也有一半是"工具可用性该由运行时裁决"'
                             '（模型无法知道当前状态允许哪些工具，除非每次把允许集喂给它 —— '
                             '那已经是 FSM 在做决定）。'
                             '2 是纯可观测性问题。把四条统称"提示词工程"的此项不得过半。'},
                {'label': '状态集合与转移表的归属', 'weight': 3,
                 'criteria': '是否给出**业务语义的状态**（如 collected / quoting / refund_authorized / '
                             'refunded / failed_terminal）而不是"step1..stepN"，'
                             '并且转移表包含：允许事件、每个状态下可调的工具集、终态集合。'
                             '关键判据是**转移表由代码/配置拥有并可版本化**（跟着发布走、可回滚），'
                             '而不是散在 prompt 里 —— 散在 prompt 里就无法回答"当时为什么走这步"。'
                             '还要能说明一次转移记录什么（前一状态、事件、决定者=模型或规则、'
                             '后一状态、外部副作用凭证），这直接回答问题 2。'},
                {'label': '模型与 FSM 的划分判据可操作', 'weight': 2,
                 'criteria': '必须给出一条能直接照着判的准则，例如：'
                             '"**产生新语义的交给模型，产生新状态/副作用的交给 FSM**"，'
                             '或"能被规则唯一确定的决定，不许模型来猜"。'
                             '并要求 FSM 在模型提出非法转移时**明确拒绝并回填原因**'
                             '（而不是静默重问，那会退化成第 3 类问题的循环）。'},
                {'label': '写操作的可重放与对账', 'weight': 1,
                 'criteria': '必须有：副作用提交点**之前**先把"意图"落库（含 idempotency key = '
                             '任务实例 + 状态 + 转移序号），重试时按 key 命中已提交的凭证而非重发；'
                             '外部调用返回后落"凭证 + 状态"两步之间的**悬挂窗口**如何对账'
                             '（超时不等于失败，必须查询对账，不能直接重放）；'
                             '终态不可再转出。只说"用幂等键"而不处理悬挂窗口的此项最多 1 分。'},
                {'label': '故意不建模的一类行为', 'weight': 1,
                 'criteria': '是否给出具体一类并说明为何不该进 FSM：'
                             '如"检索措辞的改写"（无状态语义、组合爆炸）、'
                             '"模型内部的多轮推理"（不该被外部观测粒度切碎）、'
                             '或"闲聊分支"（无副作用、无终止要求）。'
                             '判据是"建模的收益是否大于状态数增长带来的维护与爆炸成本"。'
                             '答"所有行为都该建模"不得分。'},
                {'label': 'FSM 健康度可量化', 'weight': 1,
                 'criteria': '指标必须指向"是否腐化"而不是"是否在跑"，例如：'
                             '非法转移被拒比率（高 ⇒ 模型与规则长期不一致）、'
                             '未落入任何已知终态的任务比率（黑洞状态）、'
                             '每个状态的入/出边数分布（找枢纽状态）、'
                             '以及"新增一个业务分支需要改多少处"（补丁度量的代理）。'
                             '答"看任务成功率"不得分。'},
            ],
            'notes': '总分封顶 5 的情形：把 FSM 说成"用 LangGraph/某框架画个图"而不谈所有权与持久化；'
                     '重复退款的解法是"在 prompt 里强调只能退一次"；'
                     '恢复方案是"重启后从头跑"；'
                     '状态集合是 step1/step2/…；'
                     '全文没有出现"副作用提交点"或"悬挂窗口"这类概念。',
        },
        estimatedMinutes=35,
        answer="""## 参考答案要点

**四条问题的性质各不相同**：
1（重复退款）与 4（重启即丢）**不可能靠提示词解决** ——
它们缺的是"副作用是否已提交"与"可恢复状态"这两份**持久化事实**，
模型根本看不到它们，所以怎么叮嘱都没用。
3 一半是提示词、一半是"当前状态允许哪些工具"该由运行时裁决 ——
如果解决办法是"每次把允许集写进 prompt"，那你已经在用 prompt 实现一台状态机了，
只是它不可测试、不可回滚、也不能回答"当时为什么这么走"。
2 是纯可观测性。

**状态必须是业务语义**（`refund_authorized`、`refunded`、`failed_terminal`），
不是 `step1..stepN`。转移表要由**代码/配置拥有**、随发布版本化、可回滚 ——
这一条同时解决 2（每次转移可记录"前状态 + 事件 + 决定者 + 后状态 + 副作用凭证"）
和 3（非法工具调用在转移处被拒并回填原因）。

**划分判据**要可操作：*产生新语义的交给模型，产生新状态或外部副作用的交给 FSM。*
并且 FSM 拒绝非法转移时必须**回填原因**，不能静默重问 ——
静默重问正是"模型一直要求一个不适用工具"那个循环的成因。

**写操作的可重放**分三步：副作用提交点**之前**先落意图
（幂等键 = 任务实例 + 状态 + 转移序号）；调用返回后落凭证；
两者之间的**悬挂窗口**是真正危险的地方 ——
超时不等于失败，直接重放就是二次退款，必须先查询对账再决定。
终态不可再转出。

**故意不建模**的一类：例如检索 query 的改写。
它无状态语义、组合空间大、建模只会让状态图爆炸 ——
判据始终是"建模收益 vs 状态数增长的维护成本"。

**健康度要指向腐化**：非法转移被拒比率（模型与规则长期不一致的信号）、
未落入任何已知终态的比率（黑洞状态）、每状态入出边分布（找枢纽）、
以及"加一条新业务分支要改多少处"（补丁度量的代理）。
任务成功率是业务指标，它不会告诉你状态机正在烂。"""
    )


@draft('alg-deepseek-epoll-trigger-mode')
def q_epoll_trigger_mode():
    """
    LT / ET 的差别不是性能，是"谁负责把缓冲区读干净"。
    把唤醒次数、取走的字节数、悬挂的字节数三件事做成一个纯函数，
    ET 的悬挂与 LT 的"没读完还会再报"就都是可判分的数字。
    """

    def serve(bytes_, chunk, edge, drains, max_wakes):
        """与 Java 参考解逐行等价的模型：返回 (processed, wakeups, stuck)。"""
        if bytes_ < 0:
            raise ValueError('negative bytes')
        if chunk <= 0:
            raise ValueError('chunk must be positive')
        if max_wakes < 0:
            raise ValueError('negative maxWakeups')
        if bytes_ == 0:
            return [0, 0, 0]
        if max_wakes == 0:
            return [0, 0, bytes_]
        if drains:
            return [bytes_, 1, 0]
        if edge:
            processed = min(bytes_, chunk)
            return [processed, 1, bytes_ - processed]
        need = -(-bytes_ // chunk)                     # ceil(bytes/chunk)，Python 的整除向上取整
        wakes = min(need, max_wakes)
        processed = min(bytes_, wakes * chunk)         # 中间量在 Java 里必须走 long
        return [processed, wakes, bytes_ - processed]

    def case(name, bytes_, chunk, edge, drains, max_wakes, throws=False, note=None):
        """`throws` 是声明不是推断：模型没抛而用例声明抛，同样判错。"""
        args = [bytes_, chunk, edge, drains, max_wakes]
        try:
            got = serve(bytes_, chunk, edge, drains, max_wakes)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': args, 'expected': None,
                       'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': args, 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

网关的一个连接上到了一个大请求体。`epoll` 报可读，handler 读了一部分就返回 ——
之后**没有任何新数据到达**（客户端以为发完了，或者它正在等我们的响应）。
这时"请求像被吞了，但连接没断"的线上现象就有了唯一解释：**没人再通知你缓冲区里还有货**。

LT 与 ET 的差别不在性能，在**谁负责把缓冲区读干净**：
LT 下内核替你负责（没读干净就继续通知），ET 下这件事转嫁给你（一次通知只给一次机会）。

## 你要实现的入口

```java
public static int[] serve(int bytes, int chunk, boolean edgeTriggered, boolean drains, int maxWakeups)
```

返回长度为 3 的数组：`{processed, wakeups, stuck}` —— 被读走并处理的字节数、
被唤醒的次数、**结束时还留在缓冲区里的字节数**。三个数必须自洽：`processed + stuck == bytes`。

## 就绪与读取模型（题目的全部约定，不要引入真实 epoll 的其他行为）

- 接收缓冲区里一开始有 `bytes` 个字节可读；**之后不再有新的数据到达**。
- 每次 `read` 至多取走 `chunk` 个字节（实际取走 `min(剩余, chunk)`）。
- `drains == true` ⇒ handler 在一次唤醒里循环读到"读空"为止；`false` ⇒ 每次唤醒只 `read` 一次。
- `maxWakeups` 是唤醒次数上限（模拟事件循环还要服务别的 fd）：用完就不再叫醒。

## 触发语义（判分点）

- **LT（水平触发）**：只要还有可读字节，下一次 `epoll_wait` 还会报 ⇒
  读干净需要 `ceil(bytes / chunk)` 次唤醒；上限不够就剩着。
- **ET（边缘触发）**：只在状态变化那一刻报**一次** ⇒ 一次唤醒、取走 `chunk` 个字节就结束，
  剩下的全部 `stuck`。
- `drains == true` 时两种模式没有区别：一次唤醒就读干净。
- `bytes == 0` ⇒ 从来没有就绪事件：`{0, 0, 0}`，**不报错**（keep-alive 上的空 body 就是这个形状）。
- `maxWakeups == 0` ⇒ 一次都没叫醒：`{0, 0, bytes}`，`drains` 用不上（压根没进 handler）。

## 非法输入

抛 `IllegalArgumentException`：`bytes < 0`、`chunk <= 0`、`maxWakeups < 0`。
`chunk == 0` 是"每次 read 取 0 个字节"，LT 下就是无限循环 —— 它是编程错误，不是边界情况。

## 规模

`bytes`、`chunk` 都在 `int` 范围内，`bytes` 可达 21 亿。
**中间量可能超出 `int`**：结果本身一定在 `int` 里（`processed <= bytes`），
但"唤醒次数 × 每次字节数"这一步不是 —— 怎么算到那里是你的事。"""

    reference = """public class Solution {
  public static int[] serve(int bytes, int chunk, boolean edgeTriggered, boolean drains, int maxWakeups) {
    if (bytes < 0) throw new IllegalArgumentException("negative bytes");
    if (chunk <= 0) throw new IllegalArgumentException("chunk must be positive");
    if (maxWakeups < 0) throw new IllegalArgumentException("negative maxWakeups");
    if (bytes == 0) return new int[] {0, 0, 0};
    if (maxWakeups == 0) return new int[] {0, 0, bytes};
    if (drains) return new int[] {bytes, 1, 0};

    // 中间量走 long：wakeups * chunk 可以超过 int，而它只在 min() 之后才落回 int 域
    long total = bytes;
    long step = chunk;
    long processed;
    long wakes;
    if (edgeTriggered) {
      wakes = 1;
      processed = Math.min(total, step);
    } else {
      long need = (total + step - 1) / step;
      wakes = Math.min(need, (long) maxWakeups);
      processed = Math.min(total, wakes * step);
    }
    return new int[] {(int) processed, (int) wakes, (int) (total - processed)};
  }
}"""

    naive = """public class Solution {
  // 朴素解：把两种触发模式当成同一件事 —— "能读就读，读完为止"。
  // 它假设内核总会再通知一次，于是 ET 的悬挂在这份实现里永远是 0。
  public static int[] serve(int bytes, int chunk, boolean edgeTriggered, boolean drains, int maxWakeups) {
    if (bytes < 0) throw new IllegalArgumentException("negative bytes");
    if (chunk <= 0) throw new IllegalArgumentException("chunk must be positive");
    if (maxWakeups < 0) throw new IllegalArgumentException("negative maxWakeups");
    if (bytes == 0) return new int[] {0, 0, 0};
    int processed = 0;
    int wakes = 0;
    while (processed < bytes && wakes < maxWakeups) {
      processed += Math.min(chunk, bytes - processed);   // int 相加；也从不区分 ET/LT
      wakes += 1;
      if (drains) {
        while (processed < bytes) processed += Math.min(chunk, bytes - processed);
      }
    }
    return new int[] {processed, wakes, bytes - processed};
  }
}"""

    answer = """**这道题考的是"通知归谁负责"，不是 API 记忆。**

三个数各自的角色：`wakeups` 是**内核给了几次机会**，`processed` 是你**用掉了几次**，
`stuck` 是**下一次不会再来通知的欠账**。ET 下 `stuck > 0` 就是事故本身 ——
数据在缓冲区里，连接健康，没有人会被叫醒去读它。

**判分点逐条**：

- ET 且 `drains=false`：一次唤醒只取 `chunk`，其余悬挂（10000 字节 / 4096 一次 ⇒ 剩 5904）。
- LT：`ceil(bytes/chunk)` 次机会，`maxWakeups` 不够时同样剩（10000 / 4096 / 上限 2 ⇒ 处理 8192，剩 1808）。
- `drains=true`：一次读干净，两种模式无差别 —— 这正是 ET 的正确写法（循环读到 `EAGAIN` 才返回）。
- `bytes==0` 与 `maxWakeups==0` 是两个不同的零：前者"没有事件"，后者"有事件但没被处理"。
- 溢出：`chunk` 与 `bytes` 都接近 21 亿时，`wakeups * chunk` 在 `int` 里会翻成负数，
  于是 `processed` 变负、`stuck` 变超界。**先把乘积放进 `long`，再落回 `int`**。

**为什么"ET 性能更好"这句话在这题里一文不值**：ET 省的是**系统调用次数**，
代价是把"读干净"的责任从内核转给使用者。省下来的那次 `epoll_wait` 回来之后，
如果 handler 没有循环到 `EAGAIN`，你省的那点开销会以"悬挂请求 + 超时重试"的形式全部还回去，
还附上一个查起来极其难受的现象：连接没断、日志没报错、就是没结果。

**工程上怎么落**：用 ET 就必须把"读干净"写死在框架层（循环 `read` 直到 `EAGAIN`，
并用 `bytes` 上限或 `SO_RCVLOWAT` 之类控制单次预算）；做不到就用 LT，多几次唤醒换正确性。
真实系统里更常见的是第三种：**ET + 长度前缀协议**，读不满一帧就留着下次通知继续读 ——
那已经不是"LT/ET 哪个快"的问题，而是协议层愿不愿意为语义付一次额外状态。"""

    return base(
        'algorithms', 'senior',
        'epoll 触发模式：ET 一次通知读不完就悬挂，LT 没读完会继续叫醒你',
        statement, 'java-junit',
        ['epoll', 'edge-trigger', 'level-trigger', 'nonblocking-read', 'int-overflow',
         'modern:inference-gateway'],
        src('DeepSeek', '推理服务 / 网关 高级工程师',
            'data/kb-txt/DeepSeek后端Agent面试102题.txt#11（原文给出 LT/ET 的通知语义与'
            '"ET 必须一次性读完"的结论，未做成可判分的唤醒计数模型）'),
        language='java',
        cases=[
            case('零字节：从来没有就绪事件，一次都不该被叫醒', 0, 4096, False, False, 8,
                 note='keep-alive 上的空 body 就是这个形状，不是错误'),
            case('ET 不读完就悬挂：一次通知只给一次机会', 10000, 4096, True, False, 8),
            case('LT 分三次读完：没读完就会继续通知', 10000, 4096, False, False, 8),
            case('退化：LT 的唤醒上限不够，一样会剩', 10000, 4096, False, False, 2),
            case('ET 读干净：drain 到 EAGAIN 时两种模式没区别', 10000, 4096, True, True, 8),
            case('边界：chunk 正好等于 bytes', 4096, 4096, True, False, 8),
            case('边界：chunk 大于 bytes，一次就空', 100, 4096, False, False, 3),
            case('极大：中间量 wakeups × chunk 会溢出 int', 2100000000, 2000000000, False, False, 5,
                 note='结果本身在 int 里（processed <= bytes），但乘积不在'),
            case('重复叫醒也没用：maxWakeups 为 0 一律不处理', 500, 100, False, True, 0),
            case('非法：chunk 为 0 就是无限循环', 100, 0, False, False, 5, throws=True),
            case('非法：负字节数', -1, 100, False, False, 5, throws=True),
            case('非法：负的唤醒上限', 100, 100, False, False, -1, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] serve(int bytes, int chunk, boolean edgeTriggered, '
                             'boolean drains, int maxWakeups)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
