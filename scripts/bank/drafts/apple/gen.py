#!/usr/bin/env python3
"""
Apple 方向题目草稿生成器（第一批：代码题）。

为什么这批全是代码题：Apple 现有 11 道**全部是 llm-rubric 主观题**，一道可机器判分的都没有 ——
对一个"结果导向判题"的产品来说，一家公司只有主观题等于这家公司没法练手。
类别上刻意补 sql（全库 17 道，倒数第二）与 algorithms。

取材纪律与 DeepSeek 两批一致：**只挑手册把概念讲完了、但没做成可判分要求的地方**。
素材来自 data/kb-txt/Apple面试准备手册.txt 与 content/knowledge/hot-interviews/apple-*.md。

用法：
    python scripts/bank/drafts/apple/gen.py            # 生成全部草稿到 data/drafts-apple/out/
    python scripts/bank/drafts/apple/gen.py --list     # 只列已登记的题目标识
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-apple', 'out')

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


def src(role, ref):
    return {
        'company': 'Apple',
        'role': role,
        'location': 'other',
        'origin': 'history',
        'jds': [],
        'era': '2026',
        'knowledgeRef': ref,
        'addedBy': 'arena-company-expansion',
    }


# =================================================================== 联邦峰值并发
@draft('alg-apple-federated-peak')
def q_federated_peak():
    statement = """## 背景

一个全球服务要算**并发峰值**（同一时刻最多有多少活跃会话）。但原始明细**不允许出境**，
各区只能上报一份聚合的"变化流"：`[时刻, 增量]`，进入一个会话记 `+1`（或 `+n`），离开记 `-1`。

你现在拿到的是**所有区域混在一起**的这些事件（没有区域 id —— 出境的只有 delta），
要算出全球并发峰值。

## 规则（照这些算）

- `regionDeltas[i]` 是 `[ts, delta]` 两列的整数对；`ts` 是非负整数（逻辑时钟刻度）。
- 按 `ts` **升序**处理（输入不保证有序，你必须自己排）。
- **同一 `ts` 上先应用所有负增量，再应用正增量**：区间语义是 `[start, end)`，
  在 t 结束的会话在 t 这一刻已经不活跃了，不能和 t 开始的会话同时计入。
- 峰值 = 处理过程中**累计和的最大值**（含初始的 0，即空流返回 0）。
- 返回值用 `long`：单区增量可能上亿，多区叠加会超出 `int`。

## 这题真正考的东西

新手两种算法都能过样例，但都错：

1. **各区分别算峰值再取 max** —— 偏低。峰值时刻不需要各区同时到达：
   A 区在 t=1 起 3 个、t=5 结束；B 区在 t=2 起 4 个、t=6 结束。
   两区各自峰值是 3 和 4，**全球峰值是 7**（t=2..5 期间 A 还没结束）。
2. **把所有正增量求和** —— 偏高。它假设所有会话生命周期完全重叠，
   上面再加一个 t=7 才开始的 C 区（+2），全球峰值仍是 7，而不是 9。

正确做法只有一条：**把跨区事件按时间归并，走一遍前缀和取最大值**。
这正是"聚合 delta 流可以跨区相加"的含义 —— 手册里那句"不搬原始数据也能算出精确全球峰值"说的就是它。

## 你要实现的入口

```java
public static long globalPeak(int[][] regionDeltas)
```

- 空数组返回 `0`，不抛异常（某区当天一个会话都没有是常态）；
- 以下情况抛 `IllegalArgumentException`：
  - **累计和出现负数**：说明流里有一笔 `-1` 没有对应的 `+1`（漏报或时钟回拨）。
    不要"夹到 0 继续算" —— 那会把一次数据缺失读成"峰值正常"，而真实峰值可能被低估；
  - 某行不是恰好 2 列；
  - `ts < 0`。

## 复杂度要求

`O(n log n)` 时间（排序主导）、`O(1)` 额外空间（不计排序本身）。不许按"区域"分组 —— 输入里根本没有区域信息。"""

    reference = """import java.util.Arrays;

public class Solution {
  public static long globalPeak(int[][] regionDeltas) {
    for (int[] ev : regionDeltas) {
      if (ev == null || ev.length != 2) throw new IllegalArgumentException("event must be [ts, delta]");
      if (ev[0] < 0) throw new IllegalArgumentException("negative timestamp: " + ev[0]);
    }
    // 先按 ts 升序；同一 ts 上负增量排在前（[start,end) 语义：结束不算活跃）
    int[][] events = regionDeltas.clone();
    Arrays.sort(events, (a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : Integer.compare(a[1], b[1]));

    long active = 0;
    long peak = 0;
    for (int[] ev : events) {
      active += ev[1];                     // 必须用 long：多区叠加会超出 int
      if (active < 0) {
        throw new IllegalArgumentException("negative concurrency prefix at ts=" + ev[0]);
      }
      if (active > peak) peak = active;
    }
    return peak;
  }
}"""

    naive = """public class Solution {
  // 生产事故版：把全球峰值当成"所有正增量之和"（假设生命周期完全重叠），
  // 并且根本不检查负前缀 —— 漏报会被读成"峰值正常"。
  public static long globalPeak(int[][] regionDeltas) {
    long positives = 0;
    for (int[] ev : regionDeltas) {
      if (ev[1] > 0) positives += ev[1];
    }
    return positives;   // 容量规划里管这叫"保守"，实际是虚高，而且永远发现不了
  }
}"""

    answer = """**思路**：跨区事件全部混排后按 `ts` 升序走一遍前缀和，取最大值。同 `ts` 内让负增量先落地，
这与 `[start, end)` 的区间语义一致 —— 在 t 结束的会话在 t 已不活跃，不能与 t 开始的会话同时计数。
`O(n log n)` 时间、`O(1)` 额外空间（不计排序）。

**为什么"取各区峰值 max"偏低**：峰值时刻不要求各区同时到达。用例 1 里 A 区 3 个会话（t=1..5）、
B 区 4 个（t=2..6），两区各自峰值 3 与 4，全球在 t=2..5 是 7。
**为什么"正增量求和"偏高**：它假设所有生命周期完全重叠；用例 1 里再加一个 t=7 才开始的 C 区（+2），
真峰值仍是 7，求和给 9。朴素解把这两个错误用 `Math.max` 合在一起，结果在多个用例上同时错。

**为什么负前缀和必须抛错**：delta 流里出现 `-1` 却没有对应的 `+1`，意味着某区漏报或时钟回拨。
夹到 0 继续算会给出一个"看起来合理"的峰值，而真实峰值可能被低估 ——
这类数据在容量规划里最贵，因为它让人以为还有余量。

**为什么必须用 long**：用例 4 是两笔各 20 亿的增量，`int` 累加会绕成负数，
于是既躲不过"负前缀和"检查（检查也在 int 域里做的话），又给出荒谬的峰值。

**工程延伸（面试追问点）**：
1. 各区时钟不同步怎么办？（delta 流对**时钟偏移**比原始事件流更敏感：偏移会把结束提前落到开始之前，
   直接造出负前缀。做法是给每区一个可校准的 offset 并按"最大偏移"给同刻排序留保守边界。）
2. 上报丢包怎么办？（丢 `+1` → 负前缀；丢 `-1` → 峰值虚高且不回落。所以每条流要带**区间内净值校验和**，
   HQ 侧发现累计和长期不归零就要求该区重传快照，而不是继续累加。）
3. 为什么"同刻先减后加"而不是相反？（取决于区间语义。若业务口径是"结束时刻仍算活跃"（闭区间），
   就得先加后减，峰值会更大 —— 关键是**全公司口径一致**并写进契约，两种都有人用。）
4. 能不能不排序？（ts 有界时可计数排序到 O(n+U)；但真正的生产做法是各区上报
   "本区时间片内的净值 + 区内峰值"，HQ 按时间片合并 —— 那是**近似**，误差来自跨片重叠，
   要能说清误差上界。）
5. 峰值之外还要什么？（同一套前缀和还能出 P99 并发、活跃时长积分（≈ 用量），
   后者才是成本口径；手册反复强调"并发峰值不可加、用量可加"，这题是它的机器判定版。）"""

    return base(
        'algorithms', 'senior',
        '原始明细不出境时，用聚合 delta 流算精确的全球并发峰值',
        statement, 'java-junit',
        ['prefix-sum', 'concurrency-peak', 'data-residency', 'interval-semantics', 'modern:cross-region-aggregation'],
        src('后端 / 隐私与数据出境方向 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §16.2（联邦峰值：各区共享 (ts,±net) delta 流 → HQ 归并前缀和取 max）；'
            '手册只给了结论，未把「跨区可加性」与「同刻区间语义」做成判分点'),
        language='java',
        cases=[
            {'name': '跨区可加性：各区峰值 3 与 4，全球峰值是 7',
             'input': [[[1, 3], [5, -3], [2, 4], [6, -4], [7, 2], [9, -2]]], 'expected': 7,
             'note': '取各区峰值 max 给 4（偏低），正增量求和给 9（偏高）—— 两个错法同时被这条打掉'},
            {'name': '同刻结束先于开始：[start,end) 语义下峰值是 5 不是 7',
             'input': [[[1, 5], [3, -5], [3, 2]]], 'expected': 5,
             'note': 't=3 先减后加；若口径是闭区间就得先加后减，关键是全公司一致'},
            {'name': '输入乱序必须自己排序',
             'input': [[[5, 1], [1, 2], [6, -3]]], 'expected': 3},
            {'name': '大增量必须用 long 累加（int 会绕成负数）',
             'input': [[[1, 2000000000], [2, 2000000000]]], 'expected': 4000000000,
             'note': '两笔各 20 亿；int 累加溢出后连"负前缀"检查都会被一起骗过'},
            {'name': '退化：空流返回 0', 'input': [[]], 'expected': 0},
            {'name': '退化：单调上升不回落，峰值是最后一个前缀和',
             'input': [[[1, 1], [2, 1], [3, 1]]], 'expected': 3},
            {'name': 'delta 为 0 的事件必须被容忍且不影响峰值',
             'input': [[[1, 4], [2, 0], [3, -4]]], 'expected': 4},
            {'name': '负前缀和必须显式失败（漏报 +1 不许夹到 0 继续算）',
             'input': [[[1, -2]]], 'expected': None, 'expectThrow': 'IllegalArgumentException'},
            {'name': '非法：事件不是 [ts, delta] 两列',
             'input': [[[1, 2, 3]]], 'expected': None, 'expectThrow': 'IllegalArgumentException'},
            {'name': '非法：负时间戳', 'input': [[[1, 1], [-2, 1]]], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
        ],
        runner={'className': 'Solution',
                'signature': 'long globalPeak(int[][] regionDeltas)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


# =================================================================== k-匿名出境门禁
@draft('sql-apple-kanon-gate')
def q_k_anonymity_gate():
    """expected 全部由下面这份数据算出来（互补攻击的规则人算极易错）。"""

    # (region, os_version, device_count)
    CELLS = [
        ('R1', 'v26.1', 10), ('R1', 'v26.0', 8),          # 全 >=k，无抑制
        ('R2', 'v26.1', 10), ('R2', 'v26.0', 3),          # 恰好 1 格被抑制 + 总计公开 → 整组不可发布
        ('R3', 'v26.1', 12), ('R3', 'v26.0', 2), ('R3', 'v25.4', 4),   # 2 格被抑制 → 12 仍可发布
        ('R4', 'v26.1', 2), ('R4', 'v26.0', 3),           # 两格都被抑制 → 无行可发
        ('R5', 'v26.1', 5), ('R5', 'v26.0', 5),           # 恰好等于 k 的边界
        ('R6', 'v26.1', 9), ('R6', 'v26.0', 1),           # 1 格被抑制，但总计**未**公开 → 9 可发布
    ]
    # 只有列在这里的 region，其总设备数算"已公开"（来自另一份已发布报表）
    TOTALS = ['R1', 'R2', 'R3', 'R4', 'R5']
    K = 5

    def publishable(cells, totals):
        """规则：① cell >= k；② 该 region 不是"总计公开 且 恰好只有 1 格被①抑制"。
        ② 触发时整组都不发布（互补攻击：总计 − 其余已发行 = 那一个被抑制的单元）。"""
        out = []
        regions = sorted({c[0] for c in cells})
        for region in regions:
            group = [c for c in cells if c[0] == region]
            suppressed = [c for c in group if c[2] < K]
            if region in totals and len(suppressed) == 1:
                continue                       # 整组抑制
            out.extend([c for c in group if c[2] >= K])
        return [[r, o, n] for r, o, n in sorted(out, key=lambda c: (c[0], c[1]))]

    COLUMNS = ['region', 'os_version', 'device_count']

    def expect(name, cells, totals, note=None, extra_sql=()):
        rows = publishable(cells, totals)
        payload = {
            'name': name,
            'input': list(extra_sql),
            'expected': [] if not rows else {'columns': COLUMNS, 'rows': rows, 'orderSensitive': True},
        }
        if note:
            payload['note'] = note
        return payload

    def insert_stmt(rows):
        values = ',\n  '.join(f"('{r}', '{o}', {n})" for r, o, n in rows)
        return f'INSERT INTO cell_stats (region, os_version, device_count)\nVALUES\n  {values}'

    def totals_stmt(regions):
        if not regions:
            return None
        return ('INSERT INTO region_total (region, total_devices)\nVALUES\n  '
                + ',\n  '.join(f"('{r}', 100000)" for r in regions))

    statement = f"""## 基线

MySQL 8.0（判题容器 8.0.x，默认 `ONLY_FULL_GROUP_BY`）。

细粒度统计要**出境**（发到另一个司法管的分析集群）。原始明细不许出境，能出去的只有聚合单元，
而聚合单元本身也会伤人 —— 所以有一道发布门禁。两张表：

```
cell_stats   (region VARCHAR, os_version VARCHAR, device_count INT)   -- 待发布的聚合单元
region_total (region VARCHAR, total_devices   INT)                    -- 该 region 的总数"已经另行公开"
```

## 发布规则（两条都要满足，这是判分点不是建议）

设阈值 **k = {K}**。

- **① 单元自身够大**：`device_count >= k` 的单元才有资格发布。
- **② 不许留下可反推的路径（互补攻击）**：如果某 region 的**总数已经公开**
  （`region_total` 里有这一行），而该 region 里**恰好只有 1 个**单元被①挡下，
  那么那一个单元的值 = `总计 − 其余已发行之和`，抑制它等于没抑制。
  此时**该 region 的所有单元都不许发布** —— 注意是整组消失，不是只藏那一个小的。

输出可发布单元，列名与顺序必须是 `region, os_version, device_count`，
按 `region` 升序、再按 `os_version` 升序排列（判题按行序敏感比对）。
没有可发布单元时返回 **0 行**。只提交一条 `SELECT` / `WITH` 查询。

## 这题真正考的东西

只写 `WHERE device_count >= {K}` 是最常见的实现，它在三种情形下都是错的：

1. **只藏小的，不处理可推导性**：R2 有 `10` 和 `3` 两格，总计公开。把 `3` 藏掉之后，
   任何人拿"公开总计 − 10"就还原出 3 —— 而被抑制的往往正是**最敏感的那一小撮人**（内部测试版、
   罕见配置）。这一格的存在本身就是泄露。
2. **不知道"整组抑制"**：②触发时 R2 的 `10` 也必须一起撤下，否则泄露路径还在。
3. **把②当成无条件规则**：R6 也恰好只有 1 格被①挡下，但它的总计**没有**公开，
   推导不出来 —— 那 `9` 就该发布。少判这个条件就会多抑制一个 region 的可用数据。

反过来，R3 有两格（2 与 4）被挡，攻击者只知道"这两格合计 8"，拆不开具体谁是谁 ——
所以 R3 的 `12` **可以**发布。**"被抑制的格数 ≥ 2"就是安全边界本身**，不是巧合。"""

    reference = """WITH flagged AS (
  SELECT c.region,
         c.os_version,
         c.device_count,
         CASE WHEN c.device_count < 5 THEN 1 ELSE 0 END AS suppressed,
         CASE WHEN t.region IS NULL THEN 0 ELSE 1 END   AS total_known
  FROM cell_stats c
  LEFT JOIN region_total t ON t.region = c.region
), per_region AS (
  SELECT region,
         SUM(suppressed) AS n_suppressed,
         MAX(total_known) AS total_known
  FROM flagged
  GROUP BY region
)
SELECT f.region, f.os_version, f.device_count
FROM flagged f
JOIN per_region p ON p.region = f.region
WHERE f.suppressed = 0
  AND NOT (p.total_known = 1 AND p.n_suppressed = 1)
ORDER BY f.region, f.os_version"""

    naive = """SELECT region, os_version, device_count
FROM cell_stats
WHERE device_count >= 5
ORDER BY region, os_version"""

    answer = f"""## 参考答案

```sql
WITH flagged AS (
  SELECT c.region, c.os_version, c.device_count,
         CASE WHEN c.device_count < 5 THEN 1 ELSE 0 END AS suppressed,
         CASE WHEN t.region IS NULL THEN 0 ELSE 1 END   AS total_known
  FROM cell_stats c
  LEFT JOIN region_total t ON t.region = c.region
), per_region AS (
  SELECT region, SUM(suppressed) AS n_suppressed, MAX(total_known) AS total_known
  FROM flagged GROUP BY region
)
SELECT f.region, f.os_version, f.device_count
FROM flagged f JOIN per_region p ON p.region = f.region
WHERE f.suppressed = 0
  AND NOT (p.total_known = 1 AND p.n_suppressed = 1)
ORDER BY f.region, f.os_version;
```

**要点**

1. **`LEFT JOIN` 而不是 `JOIN`**：总计未公开的 region 也要出现在统计里（R6 就是靠这条才发布 9）。
   用 `JOIN` 会把没公开的 region 整体丢掉 —— 那是"多抑制"，症状是"数据莫名变少"，比少抑制更难被发现。
2. **②的判定必须在 region 粒度上做**（`SUM(suppressed)` 分组），再回头决定整组是否发布。
   常见的错法是把两个条件写在同一层 `WHERE` 里 —— 那样只能表达"这一格小不小"，
   表达不了"这一格的存在会不会让别的格变得可推导"，因为后者是**组**的性质。
3. **`NOT (total_known = 1 AND n_suppressed = 1)`** 就是互补攻击的判据本身。
   `n_suppressed >= 2` 时攻击者只拿到一个和，拆不开单个单元（严格说拿到的是组合空间，
   信息量按 `log(组合数)` 计，这也是为什么真实系统会要求"被抑制单元数 ≥ 2 且总计不可拆"）。
4. 阈值 {K} 是**最小 k-匿名**。真实发布系统还要：层次化 rollup 的一致性
   （细格被抑制时，包含它的粗格如果只由它构成，等于没抑制 —— 要向上递归抑制）、
   互补集大小下限（complementarity）、以及跨发布周期的累计攻击防护
   （同一份数据每周发布一次、每次抑制不同的格，累积起来仍能还原）。

**工程延伸（面试追问点）**

1. 为什么"总计公开"这件事要单独建表而不是写死？（总计是否公开是**外部事实**，
   随发布流程变；把它做成数据而不是代码常量，门禁才能随发布状态自动收紧 —— 用例 3 就是改这张表。）
2. 只发布 `>= k` 的格，攻击者知道"有个格被抑制"算泄露吗？（算元数据泄露。
   严格实现要连"被抑制格的数量"都加噪或统一补齐到固定档，否则"这次少了一格"本身就是信号。）
3. 多层 rollup 怎么办？（把 region 换成层级树，自底向上做：某层被抑制则其唯一父格也抑制；
   这正是 differential privacy 之前工业界的主流方案，也是它被替代的原因 —— 组合多次发布没有累计保证。）
4. 和 SKAN/差分隐私的关系？（SKAN 用"众数匿名阈值"处理同一类问题但换了个战场：
   它限制的是**可区分值的基数**而不是单格计数；DP 则是给计数加噪，把"是否 ≥ k"变成概率命题。
   三者都答得上来是 principal 的深度，能写对②是 senior 的底线。）
5. 这条查询在亿级单元上怎么跑？（分组统计可以先物化成 `region` 粒度的小表；
   真正的成本在"总计是否公开"的元数据一致性 —— 门禁判据必须和发布流水线同一份真相，
   否则会出现"门禁以为没公开、报表已经公开"的窗口，那才是真正泄露发生的地方。）"""

    return base(
        'sql', 'senior',
        '聚合数据出境门禁：k-匿名之外还要挡互补攻击',
        statement, 'mysql',
        ['privacy', 'k-anonymity', 'aggregation-gate', 'window-function', 'modern:data-residency'],
        src('数据平台 / 隐私工程 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §16.1③（抑制小于 k 的分组）+ §19.8.1（众数匿名阈值）；'
            '手册讲了"要抑制"，未把互补攻击做成可判分要求'),
        language='sql',
        cases=[
            expect('基线：R1/R3/R5/R6 可发布，R2 与 R4 整组撤下', CELLS, TOTALS,
                   note='R2 只有 1 格被挡且总计公开 → 连 10 一起撤；R6 同样 1 格被挡但总计未公开 → 9 可发布'),
            expect('给 R2 再补一个被挡的小格：互补路径断了，10 就能发',
                   CELLS + [('R2', 'v25.4', 1)], TOTALS,
                   note='被抑制格数从 1 变 2 → 攻击者只拿到和，拆不开单格',
                   extra_sql=[insert_stmt([('R2', 'v25.4', 1)])]),
            expect('把 R6 的总计公开：同一份数据立刻变成不可发布',
                   CELLS, TOTALS + ['R6'],
                   note='与上一条相反 —— 判据必须来自 region_total，不能写死 region 名单',
                   extra_sql=[totals_stmt(['R6'])]),
            expect('把 R1 的一格降到阈值以下：整个 R1 消失（不是只藏那一格）',
                   [('R1', 'v26.1', 10), ('R1', 'v26.0', 4)] + [c for c in CELLS if c[0] != 'R1'], TOTALS,
                   note='互补攻击的正例：只藏 4 的话，10 一发布，总计−10 就还原出 4',
                   extra_sql=["DELETE FROM cell_stats WHERE region = 'R1'",
                              insert_stmt([('R1', 'v26.1', 10), ('R1', 'v26.0', 4)])]),
            expect('边界：恰好等于 k 的两格都算够大',
                   [c for c in CELLS if c[0] == 'R5'], TOTALS,
                   note='只剩 R5 时它的两格都是 5 → 都发布；用 `< k` 写成 `<= k` 会在这里翻车',
                   extra_sql=["DELETE FROM cell_stats WHERE region <> 'R5'"]),
            expect('退化：一张格子都没有 → 0 行', [], TOTALS,
                   extra_sql=["DELETE FROM cell_stats"]),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS cell_stats',
                'DROP TABLE IF EXISTS region_total',
                'CREATE TABLE cell_stats (region VARCHAR(8) NOT NULL, os_version VARCHAR(8) NOT NULL, '
                'device_count INT NOT NULL, PRIMARY KEY (region, os_version)) '
                'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
                'CREATE TABLE region_total (region VARCHAR(8) PRIMARY KEY, total_devices INT NOT NULL) '
                'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
                insert_stmt(CELLS),
                totals_stmt(TOTALS),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== 看板降级渲染
@draft('fe-apple-partial-dashboard')
def q_partial_dashboard():
    statement = """## 背景

一个亿级设备遥测看板。数据是**端上尽力而为上传**的 —— 所以"这一格的数还没到"是常态，不是异常。
凌晨三点看板上出现过一次事故级误读：某个 03:00 的分区只到了 12%，
组件把缺失渲染成 `0`，值班同学据此判断"日活暴跌"并拉了一次 P1。

你要实现这个指标卡组件 `MetricCard`。它的职责不是好看，而是**绝不把"不知道"画成"是 0"**。

## 契约（必须完全一致，判题按这个调用你）

```tsx
export interface MetricCardProps {
  label: string;
  value: number | null;   // null = 这一格的数还没到
  complete: boolean;      // 该时间桶的数据是否已完整（服务端 readiness 判定结果）
  readiness: number;      // 0..1 分区到达率
  updatedAt: number;      // ms epoch，数据最后更新时间
  now: number;            // ms epoch，**由调用方注入**的当前时间
  staleAfterMs: number;   // 超过这个时长没更新就算过期
}

export function MetricCard(props: MetricCardProps): JSX.Element;
```

## 渲染规则（逐条都是判分点）

1. 根元素：`<div data-testid="metric-card" data-partial="..." data-stale="...">`，
   两个 data 属性的值必须是字符串 `"true"` / `"false"`（不是缺省、不是 `undefined`）。
2. `data-partial` **只由 `complete` 决定**：`complete === false` ⇒ `"true"`。
   它和"这一格有没有值"是两件事 —— 有值的分区也可能只到了 12%。
3. 数值位置：`<span data-testid="metric-value">`，
   `value === null` 时渲染文本 `未到`；否则渲染 `String(value)`。
4. `complete === false` 时额外渲染 `<span data-testid="metric-readiness">`，
   内容是 `${Math.round(readiness * 100)}%`；`complete === true` 时**不得**渲染它。
5. `data-stale`：`now - updatedAt > staleAfterMs` ⇒ `"true"`，否则 `"false"`。
6. **组件不许读系统时钟**（不许 `Date.now()`、不许 `new Date()`）—— 时间只从 props 来。
   判题会用同一份 props 换 `now` 重渲染，读系统时钟的实现会答错。
7. 不许引入任何第三方依赖，只能用 React 与 JSX。

## 这题真正考的东西

- `value || '未到'` 是最顺手的写法，它把**合法读数 0** 变成了"未到"。
  日活、错误数、延迟分位这些指标 0 是有意义的值，不是缺失。要用 `value === null` 判。
- 用 `value == null` 推 `data-partial` 是第二个错：一个已经完整（`complete=true`）但恰好
  值为 null 的格子会被标成 partial；反过来一个只到了 12% 的分区（有值）会被标成完整 ——
  **后者才是那次 P1 的根因**：看板显示"完整"，人就按真值决策了。
- 新鲜度判定读 `Date.now()` 的实现，在测试里可能碰巧对，但线上会在
  时钟回拨、SSR 水合、以及"补数据风暴时 `updatedAt` 比 `now` 还新"的场景下闪断误报。

## 交付

写一个 `Solution.tsx` 导出 `MetricCard`。判题会用上面 6 条规则逐条断言。"""

    test_file = """import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricCard } from './Solution';

const base = {
  label: '日活设备',
  value: 42 as number | null,
  complete: true,
  readiness: 1,
  updatedAt: 1_000_000,
  now: 1_000_000,
  staleAfterMs: 60_000,
};

const card = () => screen.getByTestId('metric-card');
const valueText = () => screen.getByTestId('metric-value').textContent;

describe('MetricCard：把"不知道"和"是 0"分开', () => {
  it('缺失格渲染"未到"而不是 0', () => {
    render(<MetricCard {...base} value={null} />);
    expect(valueText()).toBe('未到');
  });

  it('零值边界：0 是合法读数，不许当成缺失', () => {
    render(<MetricCard {...base} value={0} />);
    expect(valueText()).toBe('0');
  });

  it('未完整时标 partial 并给出到达率', () => {
    render(<MetricCard {...base} value={7} complete={false} readiness={0.12} />);
    expect(card().getAttribute('data-partial')).toBe('true');
    expect(screen.getByTestId('metric-readiness').textContent).toBe('12%');
  });

  it('完整时不标 partial 也不显示百分比', () => {
    render(<MetricCard {...base} value={7} complete readiness={1} />);
    expect(card().getAttribute('data-partial')).toBe('false');
    expect(screen.queryByTestId('metric-readiness')).toBeNull();
  });

  it('过期判定用注入的 now，不读系统时钟', () => {
    const { rerender } = render(<MetricCard {...base} now={base.updatedAt + 60_001} />);
    expect(card().getAttribute('data-stale')).toBe('true');
    rerender(<MetricCard {...base} now={base.updatedAt + 1_000} />);
    expect(card().getAttribute('data-stale')).toBe('false');
  });

  it('迟到数据补齐后同一组件从 partial 收敛为完整', () => {
    const { rerender } = render(<MetricCard {...base} value={null} complete={false} readiness={0.12} />);
    expect(card().getAttribute('data-partial')).toBe('true');
    expect(valueText()).toBe('未到');
    rerender(<MetricCard {...base} value={42} complete readiness={1} />);
    expect(card().getAttribute('data-partial')).toBe('false');
    expect(valueText()).toBe('42');
    expect(screen.queryByTestId('metric-readiness')).toBeNull();
  });
});"""

    reference = """interface MetricCardProps {
  label: string;
  value: number | null;
  complete: boolean;
  readiness: number;
  updatedAt: number;
  now: number;
  staleAfterMs: number;
}

export function MetricCard(props: MetricCardProps) {
  const { label, value, complete, readiness, updatedAt, now, staleAfterMs } = props;
  // partial 只看"这一桶完整吗"，不看"这一格有没有值" —— 两者混用就是那次 P1 的根因
  const partial = !complete;
  // 时间一律来自 props：读 Date.now() 的实现会在时钟回拨/水合/补数风暴里闪断误报
  const stale = now - updatedAt > staleAfterMs;

  return (
    <div data-testid="metric-card" data-partial={partial ? 'true' : 'false'} data-stale={stale ? 'true' : 'false'}>
      <span className="metric-label">{label}</span>
      <span data-testid="metric-value">{value === null ? '未到' : String(value)}</span>
      {partial ? <span data-testid="metric-readiness">{`${Math.round(readiness * 100)}%`}</span> : null}
      {stale ? <span className="metric-stale-note">最后更新于 {updatedAt}，可能已过期</span> : null}
    </div>
  );
}"""

    naive = """function MetricCard(props: any) {
  // 生产事故版：把"没值"当"没到齐"，把 0 当缺失
  const missing = props.value == null;
  return (
    <div data-testid="metric-card" data-partial={missing ? 'true' : 'false'}>
      <span className="metric-label">{props.label}</span>
      <span data-testid="metric-value">{props.value || '未到'}</span>
      {missing ? <span data-testid="metric-readiness">{`${Math.round((props.readiness ?? 0) * 100)}%`}</span> : null}
    </div>
  );
}

export { MetricCard };"""

    answer = """## 参考实现

见 `Solution.tsx`：`partial = !complete`、`stale = now - updatedAt > staleAfterMs`、
数值用 `value === null` 三分支，`data-*` 一律输出 `'true' / 'false'` 字符串。

**三个判分点对应三种真实故障**

1. `value || '未到'`（用例 2 打它）：JS 的 falsy 把 `0`、`''`、`NaN` 全吞掉。
   指标卡上 0 是合法读数 —— 错误数为 0、延迟分位为 0（缓存全命中）都会发生。
   正确判据是 `value === null`，即"上游明确说了这一格没有值"。
2. 用 `value == null` 推 `data-partial`（用例 3 打它）：把"完整性"和"有没有值"混成一个信号。
   真实事故里那个 03:00 分区**是有值的**（到了 12% 的设备），所以按这个错法它会显示"完整"，
   于是人拿它当真值做决策 —— 这比显示"未到"更危险，因为看板上再也没有任何地方说"这是残缺数据"。
3. 读 `Date.now()`（用例 5 打它）：判题用同一份 props 只换 `now` 重渲染，
   读系统时钟的实现两次都会得到同一个答案。
   线上更贵：SSR 水合时服务端与客户端时间不同 → 首屏闪烁；
   补数据风暴时 `updatedAt > now` → 差值为负，`> staleAfterMs` 永远 false，过期数据被当真值。

**为什么 `data-*` 要输出字符串而不是布尔**

React 会把 `data-foo={false}` 渲染成 `data-foo="false"`，看起来没事；
但 `data-foo={undefined}` 会**整个属性都不出现**，于是"没判定"和"判定为 false"在 DOM 上不可区分 ——
自动化断言和 CSS 选择器都会踩。判题要求的是可区分，所以实现里显式写三元。

**工程延伸（面试追问点）**

1. 缺失到底该显示什么？（`未到` 只说"没有"，不说"什么时候会有"。生产看板通常还要给
   承诺时间（SLA）与"当前到齐比例"，并把这三件事一起进一个 `data-quality` 语义，
   这样下游截图/导出也不会丢掉质量信息。）
2. 为什么 `now` 要注入而不是组件内部取？（可测性只是一半；另一半是**同一个页面上所有卡片
   必须用同一个"现在"**，否则不同组件渲染时刻不同，会造成"过期时间"互相矛盾，
   而且刷新时整页会先后跳变。）
3. 迟到数据怎么收敛？（服务端把 readiness 作为数据的一部分下发，组件纯渲染；
   绝不在前端用"上次见过多少"去推断完整性 —— 那会把一次抖动固化成状态。）
4. 聚合层级怎么办？（小时不完整但天完整是常态。要在**每个粒度各自**标 partial，
   而不是让天级覆盖小时级；否则用户下钻时看到两套矛盾的数。）
5. 这类"缺失渲染成 0"的 bug 为什么反复出现？（因为 `0` 和 `null` 在多数图表库里
   走同一条数值轴。真正的修法是在数据层就把"值"与"是否有值"分开建模（如 `T | Missing`），
   而不是在每个组件里记得判 —— 本题是这条原则的最小落地。）"""

    return base(
        'frontend', 'senior',
        '遥测看板的降级渲染：把"不知道"和"是 0"分开，把"没值"和"没到齐"分开',
        statement, 'react-vitest',
        ['data-quality', 'null-vs-zero', 'rendering-contract', 'injected-clock', 'modern:observability-ui'],
        src('数据平台 / 前端可观测性 高级工程师',
            'content/knowledge/hot-interviews/apple-telemetry-pipelines.md 草稿 C'
            '（03:00 分区只到 12% 被当真值）；手册 §4 只讲管道侧，未做成前端可判分契约'),
        language='typescript',
        cases=[
            {'name': '缺失格渲染"未到"而不是 0', 'input': {'value': None, 'complete': True},
             'expected': "metric-value 文本为 '未到'"},
            {'name': '零值边界：0 是合法读数，不许当成缺失', 'input': {'value': 0, 'complete': True},
             'expected': "metric-value 文本为 '0'（不是 '未到'）",
             'note': '这条专打 `value || 未到`'},
            {'name': '未完整时标 partial 并给出到达率', 'input': {'value': 7, 'complete': False, 'readiness': 0.12},
             'expected': "data-partial='true' 且 metric-readiness 文本为 '12%'",
             'note': '有值但没到齐 —— 正是那次 P1 的形状'},
            {'name': '完整时不标 partial 也不显示百分比', 'input': {'value': 7, 'complete': True},
             'expected': "data-partial='false' 且 metric-readiness 不存在"},
            {'name': '过期判定用注入的 now，不读系统时钟',
             'input': {'now': 'updatedAt+60001 → updatedAt+1000', 'staleAfterMs': 60000},
             'expected': "data-stale 先 'true' 后 'false'（同一份 props 只换 now）",
             'note': '读 Date.now() 的实现两次结果相同，必挂'},
            {'name': '迟到数据补齐后同一组件从 partial 收敛为完整',
             'input': {'第一次': 'value=null, complete=false', '第二次': 'value=42, complete=true'},
             'expected': "partial true→false、值 '未到'→'42'、百分比徽标消失"},
        ],
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'metric-card.test.tsx', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# =================================================================== 每小时峰值并发（carry-in）
@draft('sql-apple-hourly-peak')
def q_hourly_peak_carry_in():
    """expected 全部由下面的数据集算出来 —— 跨桶与整点边界人算必错。"""
    from datetime import datetime, timedelta

    DAY_START = datetime(2026, 5, 1, 0, 0, 0)
    BUCKETS = 5                                   # 00:00 .. 04:00 共 5 个桶，每个都要出一行

    def at(hour, minute=0, second=0):
        return DAY_START + timedelta(hours=hour, minutes=minute, seconds=second)

    def fmt(t):
        return t.strftime('%Y-%m-%d %H:%M:%S')

    # (conn_id, started_at, ended_at)：区间语义 [start, end)
    BASE = [
        (1, at(0, 30), at(2, 15)),    # 跨 3 个桶：00 / 01 / 02 —— 02 点桶里没有任何会话"开始"
        (2, at(1, 45), at(1, 50)),
        (3, at(3, 10), at(3, 20)),
        (4, at(0, 0), at(1, 0)),      # 恰好在整点结束 → 不算进 01 点桶
        (5, at(1, 0), at(2, 0)),      # 恰好在整点开始 → 算进 01 点桶
    ]
    EXTRA = {
        'c6': (6, at(2, 0), at(2, 30)),           # 与 c5 的整点结束撞在一起，用来区分开/闭区间
        'overnight': (7, at(0, 0), at(4, 30)),    # 横跨全部 5 个桶
        'pile': [(8, at(1, 20), at(1, 25)), (9, at(1, 20), at(1, 25)),
                 (10, at(1, 20), at(1, 25)), (11, at(1, 20), at(1, 25))],
    }

    def peak_per_bucket(rows):
        """
        活跃数只在"开始事件"处上升，所以每个桶只需在 {桶起点} ∪ {落在本桶内的 started_at}
        这些点上取样，取最大值即为该桶峰值。空桶也要出一行（值为 0）。
        """
        out = []
        for i in range(BUCKETS):
            left = DAY_START + timedelta(hours=i)
            samples = [left] + [s for _, s, _ in rows if left <= s < left + timedelta(hours=1)]
            best = 0
            for t in samples:
                active = sum(1 for _, s, e in rows if s <= t and e > t)
                best = max(best, active)
            out.append([fmt(left), best])
        return out

    COLUMNS = ['hour_bucket', 'max_conn']

    def insert_stmt(rows):
        if not rows:
            return None
        return ('INSERT INTO connections (conn_id, started_at, ended_at)\nVALUES\n  '
                + ',\n  '.join(f"({i}, '{fmt(s)}', '{fmt(e)}')" for i, s, e in rows))

    def expect(name, rows, extra_sql, note=None):
        payload = {
            'name': name,
            'input': [s for s in extra_sql if s],
            'expected': {'columns': COLUMNS, 'rows': peak_per_bucket(rows), 'orderSensitive': True},
        }
        if note:
            payload['note'] = note
        return payload

    statement = f"""## 基线

MySQL 8.0（判题容器 8.0.x，默认 `ONLY_FULL_GROUP_BY`）。

连接表：

```
connections (conn_id INT PRIMARY KEY, started_at DATETIME NOT NULL, ended_at DATETIME NOT NULL)
```

**区间语义是 `[started_at, ended_at)`**：在 t 结束的会话在 t 这一刻已经不活跃，
不能和 t 开始的会话同时计入。

## 要输出什么

统计窗口固定为 `2026-05-01 00:00:00` 起的 **{BUCKETS} 个整点小时桶**（00:00、01:00、02:00、03:00、04:00）。
每个桶输出一行，列名与顺序必须是 `hour_bucket, max_conn`，按 `hour_bucket` 升序（判题按行序敏感比对）。

- `hour_bucket` 是桶起点，类型 `DATETIME`（形如 `2026-05-01 02:00:00`）；
- `max_conn` 是该桶**内**的最大并发活跃连接数。

**{BUCKETS} 个桶必须各有一行，即使那个小时一个会话都没开始**（此时 `max_conn` 是 0）。

## 这题真正考的东西

按 `GROUP BY DATE_FORMAT(started_at, '%Y-%m-%d %H:00:00')` 数"每小时开始几个连接"是最顺手的写法，
它错在两个方向：

1. **它数的是"开始"，不是"活跃"**。一个 00:30 开始、02:15 结束的会话，在 02 点这个桶里仍然活跃，
   但它在 02 点**没有任何开始事件** —— 于是那个桶被算成 0，而真实峰值是 1。
   跨桶的长会话越多，这个数错得越离谱（这正是"平均时长变长"时容量评估崩掉的原因）。
2. **它会漏掉整个桶**。没有开始事件的小时不会出现在 `GROUP BY` 的结果里 ——
   看板于是"少了一格"，而不是"错了一格"。少一格比错一格更难被发现。

正确做法要有 **carry-in**：把每个桶起点本身也当成一个采样点，在该点上数一遍活跃连接。
另一个必要洞察是**峰值只可能在"开始事件"或"桶起点"处取得** ——
活跃数在两个事件之间是常数，且只有开始事件会把它推高，所以不必按分钟枚举。

整点边界单独考一次：`ended_at` 恰好等于桶起点的会话**不算**进这个桶（`[start, end)`），
写成 `ended_at >= t` 会把它算进来，峰值凭空多 1。"""

    reference = """WITH RECURSIVE hours AS (
  SELECT TIMESTAMP('2026-05-01 00:00:00') AS h
  UNION ALL
  SELECT h + INTERVAL 1 HOUR FROM hours WHERE h < TIMESTAMP('2026-05-01 04:00:00')
), samples AS (
  SELECT h AS bucket, h AS t FROM hours
  UNION
  SELECT h.h, c.started_at
  FROM hours h JOIN connections c ON c.started_at >= h.h AND c.started_at < h.h + INTERVAL 1 HOUR
), counted AS (
  SELECT s.bucket, s.t,
         (SELECT COUNT(*) FROM connections c
           WHERE c.started_at <= s.t AND c.ended_at > s.t) AS active
  FROM samples s
)
SELECT bucket AS hour_bucket, MAX(active) AS max_conn
FROM counted
GROUP BY bucket
ORDER BY bucket"""

    naive = """SELECT DATE_FORMAT(started_at, '%Y-%m-%d %H:00:00') AS hour_bucket,
       COUNT(*) AS max_conn
FROM connections
GROUP BY hour_bucket
ORDER BY hour_bucket"""

    answer = """## 参考答案

```sql
WITH RECURSIVE hours AS (
  SELECT TIMESTAMP('2026-05-01 00:00:00') AS h
  UNION ALL
  SELECT h + INTERVAL 1 HOUR FROM hours WHERE h < TIMESTAMP('2026-05-01 04:00:00')
), samples AS (
  SELECT h AS bucket, h AS t FROM hours          -- carry-in：桶起点本身必须是一个采样点
  UNION
  SELECT h.h, c.started_at
  FROM hours h JOIN connections c ON c.started_at >= h.h AND c.started_at < h.h + INTERVAL 1 HOUR
), counted AS (
  SELECT s.bucket, s.t,
         (SELECT COUNT(*) FROM connections c
           WHERE c.started_at <= s.t AND c.ended_at > s.t) AS active   -- [start,end)
  FROM samples s
)
SELECT bucket AS hour_bucket, MAX(active) AS max_conn
FROM counted GROUP BY bucket ORDER BY bucket;
```

**四个判分点**

1. **carry-in**：`samples` 的第一支把桶起点自己放进去。少了它，02 点那个"只有延续、没有开始"的桶
   会拿到 0（用例 2 直接打这个：删掉跨桶会话后该桶从 1 变 0）。
2. **采样点为什么够**：活跃数是分段常数函数，只在事件时刻变化，且**只有开始事件会推高它**。
   所以每桶只需在 `{桶起点} ∪ {本桶内的 started_at}` 上取样。
   按分钟/秒枚举既慢又会在跨粒度时出错。
3. **`UNION` 而不是 `UNION ALL`**：桶起点本身也可能是一个 `started_at`，两支会产出同一个采样点，
   重复采样不影响 `MAX`，但会让 `counted` 白长一堆行；真实数据量下这一步决定要不要物化。
4. **`ended_at > t` 而不是 `>=`**：整点结束的那条会话（c5：01:00→02:00）在 02:00 已不活跃。
   用例 3 专门造了一个"02:00 开始"的会话与它撞在同一个整点 —— 闭区间实现会在这里多算 1。

**递归 CTE 的终止条件**：`WHERE h < '2026-05-01 04:00:00'` 生成 00..04 共 5 行。
写成 `<=` 会多一个 05:00 的桶（行数不符立刻暴露）；MySQL 默认 `cte_max_recursion_depth=1000`，
窗口拉到 1000 小时以上要显式调，这是这类"按时间脚手架"查询的真实上限。

**工程延伸（面试追问点）**

1. 数据量到千万行还这么跑吗？（不。相关子查询是每采样点一次计数。
   生产做法是把区间拆成 `+1/-1` 事件流，一次排序 + 窗口 `SUM() OVER (ORDER BY t)` 求前缀和，
   再按桶取 `MAX` —— 那是 `O(n log n)` 一遍扫，也是本题参考解的思想版本。）
2. 为什么"峰值不可加"？（各小时峰值相加会重复计入跨小时会话，得到比真实值大的数；
   手册里 `maxConnectionCount` 属于非可加指标就是这个意思。可加的是"活跃时长积分"≈ 用量。）
3. 空桶要不要出一行？（要，而且这是产品问题不是技术问题：报表少一格会被读成"系统那小时挂了"，
   而 0 才是要表达的事实。脚手架必须由查询自己生成，不能指望前端补 —— 前端补不了导出/告警路径。）
4. 时区怎么办？（`DATETIME` 不带时区，按"桶"聚合时先确认存的是 UTC 还是本地；
   跨 DST 的那天会出现 23 或 25 个桶，硬编码 24 会漏。这是同一条管道上反复出过的错。）
5. 如果还要 P99 并发而不是峰值？（同一套采样点上取分位数即可，但**分位数不可跨桶合并** ——
   要合并就得留原始采样或直方图，这与"排队 vs 推理耗时的 P99 不能相加"是同一条约束。）"""

    rows_after_delete_c1 = [r for r in BASE if r[0] != 1]

    return base(
        'sql', 'principal',
        '每小时并发峰值：carry-in 探针、[start,end) 整点边界，和一个没有任何开始的桶',
        statement, 'mysql',
        ['interval-semantics', 'non-additive-metric', 'recursive-cte', 'time-bucketing', 'modern:capacity-metrics'],
        src('数据平台 / 容量与指标口径 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §4.7（跨桶活跃连接需在每个桶边界放 carry-in 探针）'
            '+ §3.2/§12.2（maxConnectionCount 是非可加指标）；手册给了结论，未做成可判分查询'),
        language='sql',
        cases=[
            expect('基线：跨桶会话、整点边界与一个空桶各自落在哪', BASE, [],
                   note='02 点桶没有任何 started_at，只有 carry-in 能算出它是 1；04 点桶是 0 但仍要出行'),
            expect('删掉那个跨 3 桶的会话：02 点桶从 1 变成 0', rows_after_delete_c1,
                   ["DELETE FROM connections WHERE conn_id = 1"],
                   note='carry-in 的直接反证：没有开始事件不等于没有活跃连接'),
            expect('整点撞车：02:00 结束的会话不算进 02 点桶', BASE + [EXTRA['c6']],
                   [insert_stmt([EXTRA['c6']])],
                   note='该桶峰值是 2（c1 + c6）；把区间写成闭集会算成 3（多带上 01:00→02:00 的 c5）'),
            expect('空表：5 个桶仍要各出一行，值全是 0', [],
                   ["DELETE FROM connections"],
                   note='脚手架必须由查询自己生成 —— 少一行和错一行的代价不同'),
            expect('一个会话横跨整夜：每个桶都至少 1', BASE + [EXTRA['overnight']],
                   [insert_stmt([EXTRA['overnight']])]),
            expect('同一分钟挤进 4 条：那个桶从 3 涨到 6，其余桶一点不动', BASE + EXTRA['pile'],
                   [insert_stmt(EXTRA['pile'])],
                   note='峰值是局部量不是累计量 —— 01 点桶原有的 3 条仍在，加 4 条变 6'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS connections',
                'CREATE TABLE connections (conn_id INT PRIMARY KEY, started_at DATETIME NOT NULL, '
                'ended_at DATETIME NOT NULL, KEY idx_started (started_at), KEY idx_ended (ended_at)) '
                'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
                insert_stmt(BASE),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=28,
        answer=answer,
    )


# =================================================================== 版本偏斜事件归一化
@draft('bd-apple-schema-skew')
def q_schema_skew():
    """expected 由 Python 按同一套规则算，不手抄 —— 数量级与去重顺序人算必错。"""

    ALIAS = {'screen_viewed': 'screen_view', 'application_open': 'app_open'}
    KNOWN_VERSIONS = (1, 2)

    # (device_id, schema_version, event_name, payload, ts)
    BASE = [
        ('d1', 1, 'screen_view', 512.0, '2026-05-01 10:00:00'),      # v1 单位是 MB → 0.5 GB
        ('d1', 1, 'app_open', 1024.0, '2026-05-01 11:00:00'),        # → 1.0 GB
        ('d1', 2, 'screen_viewed', 2.0, '2026-05-01 12:00:00'),      # v2 单位已是 GB
        ('d1', 2, 'tap', 0.25, '2026-05-01 12:00:00'),
        ('d1', 1, 'screen_view', 512.0, '2026-05-01 13:00:00'),      # 双上报对（v1 侧）
        ('d1', 2, 'screen_viewed', 0.5, '2026-05-01 13:00:00'),      # 双上报对（v2 侧），归一后同名同刻
        ('d2', 3, 'tap', 9.0, '2026-05-01 09:00:00'),                # 未知版本 → 整行丢弃
        ('d2', 2, 'app_open', None, '2026-05-01 15:00:00'),          # null payload 仍算事件，贡献 0
        ('d2', 1, 'application_open', 2048.0, '2026-05-01 15:30:00'),
    ]

    def normalize(rows):
        """先按版本路由语义（名字 + 单位），**再**去重 —— 顺序反过来就是双计数。"""
        canonical = []
        for device, version, name, payload, ts in rows:
            if version not in KNOWN_VERSIONS:
                continue                                    # 未知版本不许"默认按新版本处理"
            gb = 0.0 if payload is None else (payload / 1024.0 if version == 1 else float(payload))
            canonical.append((device, ALIAS.get(name, name), ts, gb, ts[:10]))

        deduped = {}
        for row in canonical:
            deduped.setdefault((row[0], row[1], row[2]), row)   # 归一之后才去重

        agg = {}
        for device, _name, _ts, gb, day in deduped.values():
            count, total = agg.get((device, day), (0, 0.0))
            agg[(device, day)] = (count + 1, total + gb)

        return [{'device_id': d, 'day': day, 'events': n, 'payload_gb': round(total, 6)}
                for (d, day), (n, total) in sorted(agg.items())]

    SCHEMA = ('device_id string, schema_version int, event_name string, '
              'payload double, ts string')

    def input_of(rows):
        """pyspark 题的用例自带数据集（view/schema/rows），不像 mysql 题靠 runner.setup。"""
        return {
            'view': 'raw_events',
            'schema': SCHEMA,
            'rows': [{'device_id': d, 'schema_version': v, 'event_name': n, 'payload': p, 'ts': ts}
                     for d, v, n, p, ts in rows],
        }

    def expect(name, rows, note=None):
        payload = {
            'name': name,
            'input': input_of(rows),
            'expected': normalize(rows),
        }
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

一条摄取管道同时接收**多个客户端 schema 版本**的事件 —— iOS 不能强制升级，
线上同时跑着 v1 与 v2 的 SDK，过渡期还有设备两边都发。规范层（canonical layer）要在聚合之前
把语义对齐，否则下游每一个指标都会带着一个没人解释得清的数量级误差。

输入视图 `raw_events`：

```
device_id       string   -- 设备
schema_version  int      -- 1 或 2；其它值一律视为脏数据
event_name      string   -- 原始事件名
payload         double   -- 可为 null
ts              string   -- 'yyyy-MM-dd HH:mm:ss'，全部是 UTC
```

## 语义映射（这是口径，写死）

| 版本 | 单位 | 说明 |
| --- | --- | --- |
| `schema_version = 1` | `payload` 是 **MB** | 归一到 GB 要 `/ 1024` |
| `schema_version = 2` | `payload` 已经是 **GB** | 不许再除 |

事件名别名（归一到 canonical 名）：`screen_viewed` → `screen_view`；`application_open` → `app_open`。
映射表里没有的名字**保留原样**（不丢弃 —— 新事件先于映射表上线是常态）。

## 规则（逐条都是判分点）

1. **未知 `schema_version`（既不是 1 也不是 2）的行整行丢弃**。
   不许写成 `else` 分支当成 v2 处理 —— 那等于给一个语义未知的数据强行赋一个数量级。
2. `payload` 为 `null` 的行**仍然算一个事件**，只是对总量贡献 0。
   （这是口径选择：事件数与数据量是两件事，不能因为量缺失就把事件也丢掉。）
3. **先归一，再去重**：同一 `(device_id, canonical_name, ts)` 只计一次。
   过渡期双上报的两条记录用的是**不同的原始事件名**（v1 发 `screen_view`、v2 发 `screen_viewed`），
   所以按原始名去重等于没去重 —— 顺序错了就会双计数。
4. 按 `(device_id, day)` 聚合，`day = ts` 的前 10 个字符。

## 输出

每行：`device_id, day, events, payload_gb`（`payload_gb` 保留到 6 位小数），
按 `device_id`、`day` 升序。空输入返回 0 行。

## 这题真正考的东西

- **单位必须按版本路由**。全局 `/1024` 是最省事的写法，它把 v2 的 GB 也除了 1000 多倍 ——
  症状是"指标变小了没人报错"，因为量级错误不会触发任何断言。
  反过来全局不除，v1 的 MB 会被当成 GB（用例 4 用一条等价改写把这两种错法同时钉住）。
- **去重的键必须是归一后的键**。这是"先映射再聚合"里最容易写反的一步。
  双上报那一对的 canonical payload 恰好相同（512 MB = 0.5 GB 与 0.5 GB），
  所以保留哪一条都不影响结果 —— 这不是巧合，而是"必须先归一再比"的成立前提。
- **未知版本要显式排除，不要走 `else`**。`else` 分支会把未来的 v3 静默按 v2 解释。"""

    reference = """import pyspark.sql.functions as F

ALIASES = {'screen_viewed': 'screen_view', 'application_open': 'app_open'}


def solve(spark):
    raw = spark.table('raw_events')

    alias_expr = F.col('event_name')
    for src, dst in ALIASES.items():
        alias_expr = F.when(F.col('event_name') == F.lit(src), F.lit(dst)).otherwise(alias_expr)

    named = raw.withColumn('canonical_name', alias_expr)

    # 单位按版本路由；未知版本整行丢弃（不许落到 else 当成 v2）
    sized = named.withColumn(
        'gb',
        F.when(F.col('payload').isNull(), F.lit(0.0))
        .when(F.col('schema_version') == F.lit(1), F.col('payload') / F.lit(1024.0))
        .when(F.col('schema_version') == F.lit(2), F.col('payload').cast('double'))
        .otherwise(F.lit(None).cast('double')),
    ).filter(F.col('schema_version').isin(1, 2))

    # 关键顺序：先归一（canonical_name + 单位）再去重，否则双上报的两条不同名记录会都留下
    deduped = sized.dropDuplicates(['device_id', 'canonical_name', 'ts'])

    return (
        deduped
        .withColumn('day', F.substring('ts', 1, 10))
        .groupBy('device_id', 'day')
        .agg(F.count(F.lit(1)).alias('events'), F.round(F.sum('gb'), 6).alias('payload_gb'))
        .orderBy('device_id', 'day')
    )"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    return (
        spark.table('raw_events')
        .withColumn(
            'canonical_name',
            F.when(F.col('event_name') == 'screen_viewed', F.lit('screen_view'))
            .when(F.col('event_name') == 'application_open', F.lit('app_open'))
            .otherwise(F.col('event_name')),
        )
        # 错法一：单位全局处理，不看 schema_version
        .withColumn('gb', F.coalesce(F.col('payload'), F.lit(0.0)) / F.lit(1024.0))
        # 错法二：按原始事件名去重 —— 双上报的两条名字不同，去不掉
        .dropDuplicates(['device_id', 'event_name', 'ts'])
        .withColumn('day', F.substring('ts', 1, 10))
        .groupBy('device_id', 'day')
        .agg(F.count(F.lit(1)).alias('events'), F.round(F.sum('gb'), 6).alias('payload_gb'))
        .orderBy('device_id', 'day')
    )"""

    answer = """## 参考答案要点

三段式：**命名 → 定量 → 去重 → 聚合**，顺序不能换。

```python
named   = raw.withColumn('canonical_name', 别名映射)
sized   = named.withColumn('gb', v1 除 1024 / v2 原值 / null 记 0) \\
               .filter(col('schema_version').isin(1, 2))          # 未知版本丢弃
deduped = sized.dropDuplicates(['device_id', 'canonical_name', 'ts'])   # 归一之后才去重
result  = deduped.groupBy('device_id', day).agg(count, round(sum(gb), 6))
```

**三处判分点**

1. **单位按版本路由**（用例 4 钉它）：把一条 v1 的 `512 MB` 改写成 v2 的 `0.5 GB`，
   正确答案**一字不变**。全局 `/1024` 或全局不除的实现都会在这里露出来 ——
   而且露出的方式是"数字变小/变大"，没有任何异常抛出，这正是量级错误能在生产里活很久的原因。
2. **先归一再比**（基线用例钉它）：13:00 那一对双上报，v1 侧叫 `screen_view`、v2 侧叫 `screen_viewed`。
   按原始名去重会留下两条 → `events` 从 5 变 6、`payload_gb` 从 4.25 变 4.75。
   这对记录的 canonical payload 相同（512 MB == 0.5 GB），所以"保留哪条"不影响结果 ——
   真实系统里如果不等，就必须再定一条优先级规则（一般取新版本），并把"两边不等"本身做成监控指标。
3. **未知版本显式排除**（用例 2 钉它）：写成 `.otherwise(v2 语义)` 的实现会把 v3 的 9.0 当成 9 GB 收进来，
   `d2` 的 `events` 从 2 变 3、`payload_gb` 从 2.0 变 11.0。
   用 `isin(1, 2)` 白名单而不是 `!= 1` 黑名单，是为了让"新增版本"必须显式登记语义。

**工程延伸（面试追问点）**

1. 为什么映射表写在代码里而不是数据表里？（两种都要有理由：写代码里=变更走发布、可回溯、无运行时依赖；
   写表里=运营可改但引入"映射表版本"这个新的 schema skew。真实做法通常是代码 + 版本化配置，
   并把用到的映射版本记进产出数据的元信息，否则历史数据无法复现。）
2. v3 上线时最希望发生什么？（**管道报错或数据消失**，而不是静默按 v2 解释。
   所以"未知版本丢弃"要配一个"被丢弃行数"的告警，否则丢弃会变成另一种更隐蔽的静默错误 ——
   这一条是本题真正的产品含义：门禁要显式，且门禁本身要可观测。）
3. `payload is null` 算不算事件？（口径题。这里算事件、贡献 0。
   另一种合理口径是"null 视为该事件不可信、整行丢弃" —— 关键是**写进契约**并让下游知道，
   因为两种口径在"错误率"类指标上会差出一个数量级。）
4. 双上报会不会两边 payload 真的不等？（会，比如 v1 只上报了部分字段。这时去重规则要能解释
   "为什么保留这条"，并且理想做法是保留两条 + 一个 `source_versions` 数组，
   在指标层再按口径取舍 —— 把决策推到离问题最近的地方。）
5. 端上时间不可信怎么办？（本题刻意把时区/时钟问题留在别的题里。真实规范层还要处理
   `device_ts` 与 `server_recv_ts` 的选择、DST、以及"未来时间戳"的水位线过滤 ——
   那是一组独立的口径题。）"""

    rows_v3_as_v2 = [(d, 2 if v == 3 else v, n, p, ts) for d, v, n, p, ts in BASE]
    rows_single_report = [r for r in BASE if not (r[0] == 'd1' and r[3] == 512.0 and r[4].endswith('13:00:00'))]
    rows_unit_equivalent = [
        ('d1', 2, 'screen_view', 0.5, '2026-05-01 10:00:00') if (r[0] == 'd1' and r[4].endswith('10:00:00')) else r
        for r in BASE
    ]

    return base(
        'big-data', 'principal',
        '版本偏斜的规范层：单位按 schema_version 路由，且必须先归一再比',
        statement, 'pyspark',
        ['schema-evolution', 'unit-normalization', 'dedup-order', 'data-quality-gate', 'modern:canonical-layer'],
        src('数据平台 / 摄取与规范层 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §1.2（改名、米→英尺、本地→UTC 都是静默错误）'
            '+ §16 版本偏斜；手册讲了现象，未做成可判分的摄取契约'),
        language='python',
        cases=[
            expect('基线：双上报、MB/GB 混单位、未知版本与 null payload 各自落在哪', BASE,
                   note='d1 是 5 个事件 / 4.25 GB（13:00 那对只算一次）；d2 的 v3 行被丢弃、null 仍算事件'),
            expect('把未知版本改成 v2：它就必须被收进来（白名单而不是 else）', rows_v3_as_v2,
                   note='与基线唯一的差别是那行版本从 3 变 2 → d2 从 2 个事件/2.0 GB 变 3 个/11.0 GB'),
            expect('删掉双上报的 v1 侧：结果一字不变（证明它真的被去重了）', rows_single_report,
                   note='留 v2 侧 0.5 GB 与基线保留 v1 侧 512 MB 等价 —— 归一后的键相同'),
            expect('单位等价改写：v1 的 512 MB 换成 v2 的 0.5 GB，输出必须完全相同', rows_unit_equivalent,
                   note='这条专打"全局除 1024"和"全局不除"两种实现 —— 它们在这里都会给出不同的数'),
            expect('跨天：新增一天的事件要单独成行',
                   BASE + [('d1', 2, 'tap', 1.5, '2026-05-02 08:00:00')]),
            expect('退化：空输入返回 0 行', []),
        ],
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== Airflow data interval 调度语义
@draft('alg-apple-airflow-interval')
def q_airflow_intervals():
    statement = """## 背景

一条批管道每天从 `scheduleStart` 起按固定粒度跑，用 Airflow 的语义描述就是：
数据区间是 `[scheduleStart + k·g, scheduleStart + (k+1)·g)`，`k = 0, 1, 2, …`。

关键约定（也是这题最容易做错的一点）：**一个区间的 run 在区间结束那一刻才可触发**。
`logical_date` 是区间**起点**，但触发时刻是区间**终点** —— 因为数据要等窗口关闭才完整。

给你当前时刻 `now`，要求列出到此为止**所有已经可以触发**的区间。

## 规则

- 可触发判据：`now >= scheduleStart + (k+1)·g`（区间已经关闭）。
- `catchup = true`：返回全部可触发的区间，按时间升序。
- `catchup = false`：只返回**最后一个**可触发的区间（没有则返回空）。
- 返回 `long[k][2]`，每行是 `[dataIntervalStart, dataIntervalEnd]`。
- `now < scheduleStart`（时钟回拨、或 `start_date` 设在未来）返回**空数组，不抛异常**。
- `granularitySec <= 0` 抛 `IllegalArgumentException`。

## 这题真正考的东西

最顺手的写法是 `n = (now - start) / g + 1` —— 那个 `+1` 排的是**当前还没关闭的区间**。
它会在 `now` 落在区间中间时多跑一个 run，而这个 run 的 `data_interval_end` 在未来：

- 它按"现在"去读分区，读到的是一份**还在写入的数据**，于是当天指标偏低且每天偏低一点点；
- 更糟的是回填（backfill）时它会**覆盖一个尚未关闭的分区**，把已经发布的数据改成残缺版本。

这类 bug 不会报错，只会让数字"差一点"，所以它能在生产里活很多个季度。
另一个常见错法是 `catchup=false` 时返回**最早**那个区间（把"只跑最新一次"理解成"从头补一个"），
结果管道永远停在第一天，看起来"在跑"，实际再没前进过。

## 复杂度要求

`O(k)` 输出规模；不许用循环里的浮点除法算边界（全部整数运算）。"""

    reference = """public class Solution {
  public static long[][] scheduledIntervals(long scheduleStart, long granularitySec, long now, boolean catchup) {
    if (granularitySec <= 0) throw new IllegalArgumentException("granularity must be positive");
    long elapsed = now - scheduleStart;
    if (elapsed < granularitySec) {
      // 包含 now < scheduleStart（时钟回拨 / start_date 在未来）：没有任何区间关闭过
      return new long[0][];
    }
    // 只有 end <= now 的区间才可触发 ⇒ 可触发个数 = elapsed / granularity（整数除法天然向下取整）
    long closed = elapsed / granularitySec;
    long first = catchup ? 0 : closed - 1;          // catchup=false 只要最新那一个
    int size = (int) (catchup ? closed : 1);
    long[][] out = new long[size][];
    for (int i = 0; i < size; i++) {
      long start = scheduleStart + (first + i) * granularitySec;
      out[i] = new long[] { start, start + granularitySec };
    }
    return out;
  }
}"""

    naive = """public class Solution {
  public static long[][] scheduledIntervals(long scheduleStart, long granularitySec, long now, boolean catchup) {
    if (granularitySec <= 0) throw new IllegalArgumentException("granularity must be positive");
    if (now < scheduleStart) return new long[0][];
    // 错处一：+1 把还没关闭的当前区间也排进去了
    long n = (now - scheduleStart) / granularitySec + 1;
    // 错处二：catchup=false 时取了最早的区间，于是管道永远停在第一天
    int size = (int) (catchup ? n : 1);
    long[][] out = new long[size][];
    for (int i = 0; i < size; i++) {
      long start = scheduleStart + (long) i * granularitySec;
      out[i] = new long[] { start, start + granularitySec };
    }
    return out;
  }
}"""

    answer = """**思路**：可触发的充要条件是区间已关闭，即 `start + (k+1)·g <= now`，
所以 `k+1 <= (now-start)/g` ⇒ **可触发个数 = `(now - start) / g`（整数除法）**，
不需要 `+1`。`catchup=false` 取最后一个，即下标 `closed-1`。

**两个 `+1` 的诱惑**：`(now-start)/g + 1` 看起来"更完整"，因为它把当前正在积累的区间也算上了。
但那个区间的 `data_interval_end` 在 `now` 之后 —— 拿它去读数据会读到半份，
回填时更会把已发布分区覆盖成残缺版本。判分点用例 1/2/4/5 全在打这一下：
`now` 恰好等于边界（3·g）时正确答案是 3 个而不是 4 个，`now` 在区间中间时同样是 3 个。

**为什么 `now < start` 不抛异常**：时钟回拨与"`start_date` 设在未来"都是可恢复的常态，
抛异常会让调度器把一次时间同步抖动变成管道故障。返回空数组 = "这一轮无事可做"，语义正确。

**`catchup=false` 的第二个错法**：返回最早那个区间。症状极其隐蔽 —— 面板上显示"有 run 成功"，
但数据永远停在第一天。判分点用例 3 专门打它（`now=10g+5` 时必须返回第 10 个区间）。

**工程延伸（面试追问点）**：
1. 为什么要区分 `logical_date` 与触发时刻？（因为"数据属于哪一天"和"什么时候数据齐了"是两件事。
   把两者混成一个字段，是所有"回填污染已发布分区"类事故的共同根因。）
2. `catchup=false` 适合什么场景？（只关心最新状态的实时性管道。但要注意它会**静默跳过**积压的区间，
   所以必须配一个"被跳过区间数"的指标，否则停机一周后你不会知道那一周的数据永远没了。）
3. 粒度不固定（cron 表达式）怎么办？（`data_interval` 由 cron 的相邻两次触发时刻决定，
   月末/闰年/DST 会让区间长度不等 —— 这时"用除法算个数"根本不成立，必须逐个生成并判断关闭时刻。
   这也是本题限定固定粒度的原因：固定粒度下才有闭式解。）
4. 回填的正确姿势？（只允许回填 `end <= 水位线` 的区间，且写入走"新分区替换"而不是原地覆盖；
   水位线本身要持久化，否则回填过程中重启会重放已完成的区间。）
5. 怎么防住那个 `+1`？（给管道加一条断言：任何 run 的 `data_interval_end <= 当前时间`。
   把它做成调度层的不变量，而不是靠 review 时肉眼盯 —— 这类 off-by-one 在 code review 里几乎必漏。）"""

    def iv(start, g, k):
        return [[start + i * g, start + (i + 1) * g] for i in k]

    G = 3600
    return base(
        'algorithms', 'senior',
        'Airflow 的 data interval：run 在区间结束才触发，那个 +1 会覆盖未关闭的分区',
        statement, 'java-junit',
        ['scheduler-semantics', 'backfill', 'off-by-one', 'batch-pipeline', 'modern:orchestration-contract'],
        src('数据平台 / 编排与回填 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §13.2（logical_date 是区间起点、运行发生在窗口结束之后）'
            '；手册给了结论但未做成可判分要求；bd-pyspark-0008 只考回填的结果侧不考调度语义'),
        language='java',
        cases=[
            {'name': '三个区间恰好关闭：now 落在边界上就是 3 个，不是 4 个',
             'input': [0, G, 3 * G, True], 'expected': iv(0, G, [0, 1, 2]),
             'note': '那个 +1 的写法在这里会给出 4 个区间，最后一个的 end 在未来'},
            {'name': 'now 落在第 4 个区间中间：仍然只有 3 个可触发',
             'input': [0, G, 3 * G + 1800, True], 'expected': iv(0, G, [0, 1, 2])},
            {'name': 'catchup=false 要最新那个区间，不是最早那个',
             'input': [0, G, 10 * G + 5, False], 'expected': iv(0, G, [9]),
             'note': '返回最早区间会让管道永远停在第一天，而面板上看着"每天都有成功 run"'},
            {'name': '退化：一个区间都没关闭（now = g-1）返回空',
             'input': [0, G, G - 1, True], 'expected': []},
            {'name': '退化：now 恰好等于 start 返回空', 'input': [0, G, 0, True], 'expected': []},
            {'name': '时钟回拨：now 早于 start 返回空而不是抛异常',
             'input': [1000, G, 500, True], 'expected': [],
             'note': '抛异常会把一次 NTP 抖动放大成管道故障'},
            {'name': '真实时间戳：按天粒度跑三天',
             'input': [1700000000, 86400, 1700000000 + 3 * 86400, True],
             'expected': iv(1700000000, 86400, [0, 1, 2])},
            {'name': 'catchup=false 且只有一个区间关闭：返回那一个',
             'input': [0, G, G, False], 'expected': iv(0, G, [0])},
            {'name': '非法：粒度为 0', 'input': [0, 0, 100, True], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
            {'name': '非法：粒度为负', 'input': [0, -60, 100, True], 'expected': None,
             'expectThrow': 'IllegalArgumentException'},
        ],
        runner={'className': 'Solution',
                'signature': 'long[][] scheduledIntervals(long scheduleStart, long granularitySec, long now, boolean catchup)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# =================================================================== 采样权重还原
@draft('bd-apple-sampling-weight')
def q_sampling_weights():
    """三个指标全部由 Python 按同一口径算出来（加权分位数人算极易错位）。"""

    # (day, cohort, sample_rate, device_id, latency_ms)
    DAY1 = [
        ('2026-05-01', 'A', 0.5, 'd1', 100),
        ('2026-05-01', 'A', 0.5, 'd1', 300),
        ('2026-05-01', 'A', 0.5, 'd2', 900),
        ('2026-05-01', 'B', 0.01, 'd3', 50),
        ('2026-05-02', 'C', 1.0, 'd9', 20),
    ]

    def metrics(rows):
        days = sorted({r[0] for r in rows})
        out = []
        for day in days:
            group = [r for r in rows if r[0] == day]
            est_events = sum(1.0 / r[2] for r in group)
            per_device = {}
            for _d, _c, rate, device, _lat in group:
                per_device[device] = max(per_device.get(device, 0.0), 1.0 / rate)
            est_devices = sum(per_device.values())
            weighted = [(lat, 1.0 / rate) for _d, _c, rate, _dev, lat in group if lat is not None]
            p95 = None
            if weighted:
                total = sum(w for _lat, w in weighted)
                threshold = 0.95 * total
                cumulative = 0.0
                for lat, w in sorted(weighted, key=lambda x: x[0]):
                    cumulative += w
                    if cumulative >= threshold - 1e-9:
                        p95 = lat
                        break
            out.append({'day': day,
                        'est_events': round(est_events, 6),
                        'est_devices': round(est_devices, 6),
                        'p95_latency_ms': p95})
        return out

    def rows_literal(rows):
        return [{'day': d, 'cohort': c, 'sample_rate': r, 'device_id': dev, 'latency_ms': lat}
                for d, c, r, dev, lat in rows]

    def expect(name, rows, note=None):
        payload = {'name': name,
                   'input': {'view': 'events', 'schema': SCHEMA, 'rows': rows_literal(rows)},
                   'expected': metrics(rows)}
        if note:
            payload['note'] = note
        return payload

    SCHEMA = 'day string, cohort string, sample_rate double, device_id string, latency_ms double'

    cross_stratum = DAY1 + [('2026-05-01', 'A', 0.5, 'd3', 400)]
    null_latency = DAY1 + [('2026-05-01', 'B', 0.01, 'd4', None)]
    all_full_sample = [('2026-05-03', 'D', 1.0, 'v1', 10), ('2026-05-03', 'D', 1.0, 'v2', 20),
                       ('2026-05-03', 'D', 1.0, 'v3', 30), ('2026-05-03', 'D', 1.0, 'v4', 40)]
    single = [('2026-05-04', 'E', 0.25, 'z1', 777)]

    statement = """## 背景

端上遥测**不可能全量上传**（带宽与隐私都不同意），所以每个 cohort 有自己的采样率。
看板要的是"总体估计值"，不是"样本值" —— 这一步叫**采样权重还原**（Horvitz-Thompson 估计）。

输入视图 `events`：

```
day           string   -- 'yyyy-MM-dd'
cohort        string   -- 采样层
sample_rate   double   -- 该层的采样概率，0 < r <= 1
device_id     string
latency_ms    double   -- 可为 null（该事件没带延迟）
```

每行的**权重**定义为 `weight = 1 / sample_rate`。

## 要输出什么

按 `day` 分组，每行四列：`day, est_events, est_devices, p95_latency_ms`，按 `day` 升序。

- `est_events` = 该天所有行的 `weight` 之和（**每行都算**，包括 `latency_ms` 为 null 的行）。
- `est_devices` = 先按 `device_id` 归并、**每台设备取其所有行里最大的那个 weight**，再求和。
  （一台设备可能被采到多次，直接 `Σ weight` 会把同一台设备放大好几遍。）
- `p95_latency_ms` = **加权** 95 分位数：把该天 `latency_ms` 非 null 的行按延迟升序排，
  累加 weight，取累计 weight **首次 ≥ 0.95 × 这些行的 weight 总和** 的那个 `latency_ms`。
  `latency_ms` 为 null 的行完全不参与分位数（既不进分母也不进分子）。
- 空输入返回 0 行。

## 这题真正考的东西

1. **不能拿一个"整体采样率"去线性外推**。各层采样率差两个数量级时（本例 A 层 0.5、B 层 0.01），
   用平均采样率会把小众层（恰恰是最贵的那批设备）估错，症状是总体量看着对、
   但**分位数完全不对** —— 因为分位数取决于权重排序，不是总量。
2. **设备数不是事件数**。`est_devices` 要按设备归并取 max weight；
   用 `COUNT(DISTINCT device_id) × 平均权重` 在跨层设备上会错（用例 2 专门造了一台
   同时出现在 0.5 层与 0.01 层的设备：事件数涨、设备数**一点不变**）。
3. **分位数必须加权**。Spark 的 `percentile_approx` 没有权重参数，
   所以它给的是"样本分位数"，与总体分位数不是一回事 —— 要自己走累计权重。"""

    reference = """import pyspark.sql.functions as F
from pyspark.sql import Window

def solve(spark):
    e = spark.table('events').withColumn('weight', F.lit(1.0) / F.col('sample_rate'))

    est_events = e.groupBy('day').agg(F.sum('weight').alias('est_events'))

    per_device = (e.groupBy('day', 'device_id')
                   .agg(F.max('weight').alias('dev_weight'))
                   .groupBy('day')
                   .agg(F.sum('dev_weight').alias('est_devices')))

    lat = e.filter(F.col('latency_ms').isNotNull())
    totals = lat.groupBy('day').agg(F.sum('weight').alias('w_total'))
    walking = (lat.join(totals, 'day')
                  .withColumn('cum', F.sum('weight').over(
                      Window.partitionBy('day').orderBy('latency_ms')
                      .rowsBetween(Window.unboundedPreceding, Window.currentRow)))
                  .withColumn('hit', F.col('cum') >= F.lit(0.95) * F.col('w_total')))
    p95 = (walking.filter(F.col('hit'))
                   .groupBy('day')
                   .agg(F.min('latency_ms').alias('p95_latency_ms')))

    return (est_events.join(per_device, 'day', 'inner')
                      .join(p95, 'day', 'inner')
                      .select('day',
                              F.round('est_events', 6).alias('est_events'),
                              F.round('est_devices', 6).alias('est_devices'),
                              F.round('p95_latency_ms', 6).alias('p95_latency_ms'))
                      .orderBy('day'))"""

    naive = """import pyspark.sql.functions as F

def solve(spark):
    e = spark.table('events')
    # 错法：一个"整体采样率"线性外推 + 设备数直接 distinct × 平均权重 + 分位数不加权
    return (e.groupBy('day')
             .agg(F.count(F.lit(1)).alias('n_rows'),
                  F.countDistinct('device_id').alias('n_dev'),
                  F.avg('sample_rate').alias('avg_rate'),
                  F.percentile_approx('latency_ms', 0.95).alias('p95'))
             .withColumn('est_events', F.col('n_rows') / F.col('avg_rate'))
             .withColumn('est_devices', F.col('n_dev') / F.col('avg_rate'))
             .select('day',
                     F.round('est_events', 6).alias('est_events'),
                     F.round('est_devices', 6).alias('est_devices'),
                     F.round('p95', 6).alias('p95_latency_ms'))
             .orderBy('day'))"""

    answer = """## 参考答案要点

三段独立聚合再 join：`Σ weight`（事件）、`Σ max(weight) per device`（设备）、
按延迟排序走累计权重取加权分位数。

```python
e = events.withColumn('weight', 1.0 / col('sample_rate'))
est_events  = e.groupBy('day').agg(sum('weight'))
est_devices = e.groupBy('day','device_id').agg(max('weight')).groupBy('day').agg(sum('dev_weight'))
# 加权分位数：percentile_approx 没有权重参数，只能自己走
walking = lat.join(totals,'day').withColumn('cum', sum('weight').over(w_rows))  # w_rows: 按 latency 排序的无界前缀
p95 = walking.filter(col('cum') >= 0.95 * col('w_total')).groupBy('day').agg(min('latency_ms'))
```

**基线算一遍（2026-05-01）**：权重分别是 2、2、2、100 ⇒ `est_events = 106`；
设备 `d1→2, d2→2, d3→100` ⇒ `est_devices = 104`；
分位数：总权重 106，阈值 `0.95×106 = 100.7`，按延迟升序 50(累计 100) → 100(累计 102 ≥ 100.7) ⇒ **100**。
注意"样本分位数"会给出 900（4 个样本里第 4 个）—— **差 9 倍，而且总量是对的**，
所以这类错误不会被"总量对不对"的发现机制抓到。

**为什么设备数要取 max 而不是求和**：一台设备被采到 N 次时，它代表总体的"份数"仍只有一个
（采样是设备级的），重复累加会把活跃设备的占比放大 —— 而活跃设备恰恰延迟更高，
于是分位数被进一步推向高端。取 max 是"按最保守的那一层还原"。

**`cum >= 0.95 * w_total` 用 `min(latency)` 收口**：满足条件的行可能有多条（并列延迟），
取 `min` 保证结果确定，与"首次 ≥ 阈值"的定义一致。

**工程延伸（面试追问点）**

1. 为什么不用 `expr` 里的 `percentile_approx(..., weight)`？（Spark 的签名没有权重位。
   硬要用得先把每行按权重复制成多行 —— 那是把内存炸掉当算法用，高采样精度要求下不可接受。）
2. 权重是估计值，误差多大？（Horvitz-Thompson 有闭式方差：`Σ (1-r)/r² · x²`。
   小众层 r=0.01 时方差极大 —— 所以生产看板要**同时**给点估计与置信区间，
   否则"渗透率涨了 3%"这种结论永远无法被否证。这是"给我三个数字然后问到你说不出为止"的标准答案。）
3. 采样率本身在一天内变了怎么办？（那 `sample_rate` 就不是层属性而是行属性，
   本题已按行处理；真实难点是"变化那一刻"的指标会跳变，必须把采样率变更也当成一次发布来标注。）
4. 为什么 `latency_ms` 为 null 的行还要计入事件数？（口径题：事件确实发生了，只是没带延迟。
   把它整行丢掉会让 `est_events` 与"上报量"对不上，而这类不一致正是排查时最耗时间的地方。
   关键是**写进契约**，让分子分母口径永远一致。）
5. 跨天聚合（周视图）能直接相加吗？（事件数、设备数可以近似相加（设备数跨天要去重），
   但**分位数绝对不行** —— 分位数不可合并，要合并必须留直方图或 sketch。
   这与"排队 P99 + 推理 P99 ≠ 端到端 P99"是同一条约束。）"""

    return base(
        'big-data', 'principal',
        '采样权重还原：设备数按 max 权重归并，分位数必须加权',
        statement, 'pyspark',
        ['sampling-weight', 'weighted-percentile', 'metric-consistency', 'observability', 'modern:telemetry-estimation'],
        src('数据平台 / 指标与实验 高级工程师',
            'content/knowledge/hot-interviews/apple-telemetry-pipelines.md §采样权重'
            '（"任何按事件数聚合必须 ×1/sample_rate"）；手册只给了一句话，未做成可判分口径'),
        language='python',
        cases=[
            expect('基线：两天各自的三个指标', DAY1,
                   note='05-01：事件 106、设备 104、加权 p95 = 100（样本分位数会给 900）'),
            expect('同一设备跨两个采样层：事件数涨，设备数一点不变', cross_stratum,
                   note='d3 同时出现在 0.01 与 0.5 层 → 取 max weight，仍是 104；'
                        '但多出的 2 点权重把加权 p95 从 100 推到 300'),
            expect('latency 为 null 的行仍计入事件与设备，但不进分位数', null_latency,
                   note='est_events 106→206、est_devices 104→204，而 p95 仍是 100'),
            expect('采样率全为 1 时退化成普通计数与普通最近秩分位数', all_full_sample),
            expect('只有一行的天：分位数就是它本身，事件数按该层采样率还原', single,
                   note='r=0.25 的一行 ⇒ est_events=4 而不是 1'),
            expect('退化：空输入返回 0 行', []),
        ],
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== 同比对照徽章
@draft('fe-apple-delta-badge')
def q_delta_badge():
    statement = """## 背景

指标卡旁边那个"同比 +12.5%"的小徽章，是看板事故率最高的组件之一 —— 因为它的分母经常是 0。

你要实现 `DeltaBadge`：给定本期值与上期值，渲染变化幅度。

## 契约

```tsx
export interface DeltaBadgeProps {
  current: number | null;    // null = 这一期没有数据
  previous: number | null;   // null = 上期没有数据
}

export function DeltaBadge(props: DeltaBadgeProps): JSX.Element;
```

根元素必须是 `<span data-testid="delta-badge" data-kind="…">`，`data-kind` 只能取
`missing` / `flat` / `new` / `dropped` / `change` 五个值之一；文本规则如下：

| 条件（按顺序匹配） | `data-kind` | 文本 |
| --- | --- | --- |
| 任一为 `null` | `missing` | `无对比` |
| `current === previous`（含两者都是 0） | `flat` | `持平` |
| `previous === 0`（本期非 0） | `new` | `新增` |
| `current === 0`（上期非 0） | `dropped` | `-100%` |
| 其余 | `change` | 带符号、保留 1 位小数的百分比，如 `+12.5%` / `-8.3%` |

## 这题真正考的东西

1. **除零不能露到界面上**。`(current - previous) / previous` 在 `previous === 0` 时给出
   `Infinity` 或 `NaN`，`toFixed` 会老老实实渲染成 `Infinity%` / `NaN%`。
   但"上期是 0"在遥测里是常态（新指标、新地区、刚上线的功能），
   它表达的是**新增**，不是"无穷倍增长" —— 后者会让人对数据失去信任。
2. **本期归零是有效信号，不是缺失**。`current === 0` 必须走 `dropped` 分支显示 `-100%`；
   写成 `if (!current)` 的实现会把它当成"没数据"渲染成"无对比" ——
   于是"服务全天不可用"这种最该被看见的事实在看板上长得像"还没出数"。
3. **`null` 与 `0` 是两件事**（与本题的 `dropped` 分支互为对照）：
   `null` 走 `missing`，`0` 走 `dropped`/`flat`。
4. **舍入位数是口径**：要求 1 位小数，`-8.3%` 不许被 `toFixed(0)` 抹成 `-8%`。
   同比数字被截到整数后，"跌幅 0.4%"这类慢变化在看板上永远看不见。

不许引入第三方依赖。"""

    reference = """interface DeltaBadgeProps {
  current: number | null;
  previous: number | null;
}

export function DeltaBadge(props: DeltaBadgeProps) {
  const { current, previous } = props;

  // 顺序很重要：先判缺失，再判相等（含 0/0），最后才碰除零的两个特例
  if (current === null || previous === null) {
    return <span data-testid="delta-badge" data-kind="missing">无对比</span>;
  }
  if (current === previous) {
    return <span data-testid="delta-badge" data-kind="flat">持平</span>;
  }
  if (previous === 0) {
    return <span data-testid="delta-badge" data-kind="new">新增</span>;
  }
  if (current === 0) {
    return <span data-testid="delta-badge" data-kind="dropped">-100%</span>;
  }
  const pct = ((current - previous) / previous) * 100;
  return (
    <span data-testid="delta-badge" data-kind="change">
      {`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
    </span>
  );
}"""

    naive = """function DeltaBadge({ current, previous }: any) {
  const pct = ((current - previous) / previous) * 100;
  return <span data-testid="delta-badge">{`${pct.toFixed(0)}%`}</span>;
}

export { DeltaBadge };"""

    test_file = """import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeltaBadge } from './Solution';

const badge = () => screen.getByTestId('delta-badge');
const kind = () => badge().getAttribute('data-kind');
const text = () => badge().textContent;

describe('DeltaBadge：除零、归零与缺失必须是三种不同的样子', () => {
  it('正常增长渲染带符号的一位小数', () => {
    render(<DeltaBadge current={112.5} previous={100} />);
    expect(kind()).toBe('change');
    expect(text()).toBe('+12.5%');
  });

  it('正常下降保留一位小数', () => {
    render(<DeltaBadge current={91.7} previous={100} />);
    expect(kind()).toBe('change');
    expect(text()).toBe('-8.3%');
  });

  it('持平：两期相等，含两期都是 0', () => {
    const { unmount } = render(<DeltaBadge current={100} previous={100} />);
    expect(kind()).toBe('flat');
    expect(text()).toBe('持平');
    unmount();
    render(<DeltaBadge current={0} previous={0} />);
    expect(kind()).toBe('flat');
    expect(text()).toBe('持平');
  });

  it('上期为 0 是"新增"，不许渲染成 Infinity%', () => {
    render(<DeltaBadge current={7} previous={0} />);
    expect(kind()).toBe('new');
    expect(text()).toBe('新增');
  });

  it('本期归零是 -100%，不许当成缺失', () => {
    render(<DeltaBadge current={0} previous={50} />);
    expect(kind()).toBe('dropped');
    expect(text()).toBe('-100%');
  });

  it('任一缺失渲染无对比，不参与算术', () => {
    const { unmount } = render(<DeltaBadge current={null} previous={50} />);
    expect(kind()).toBe('missing');
    expect(text()).toBe('无对比');
    unmount();
    render(<DeltaBadge current={50} previous={null} />);
    expect(kind()).toBe('missing');
    expect(text()).toBe('无对比');
  });
});"""

    answer = """## 参考答案要点

五分支顺序匹配：`null` → 相等 → 上期为 0 → 本期为 0 → 正常百分比。
关键点不在代码量，而在**每一条分支都对应一种"数字不该出现"的情形**。

**为什么分支顺序不能换**：`current === previous` 必须排在 `previous === 0` 之前，
否则 `(0, 0)` 会被判成"新增"—— 而它的意思是"两期都没有"。这类边界顺序在评审里几乎看不出，
只有把规则写成表、再逐条测才能钉住。

**`Infinity` 与 `NaN` 为什么会活下来**：`toFixed` 对它们不报错，直接输出字符串。
所以"渲染没崩"不等于"数字对" —— 这也是本题用 `data-kind` 而不是只测文本的原因：
断言文本会漏掉"看起来像那么回事但语义错了"的实现。

**为什么 `current === 0` 不能走 `missing`**：`if (!current)` 是最顺手的写法，
它把"全天零可用"和"还没出数"合并成同一个显示。真实事故里这两种情况的操作完全不同
（前者拉告警，后者等管道），合并等于把最严重的信号降级成"再等等看"。

**工程延伸（面试追问点）**

1. 上期是 0 但本期也是 0，指标其实"从未上线" —— 界面上该区分吗？（该，但那不是这个组件的职责：
   "有没有历史"是元数据，应该由数据层带下来。把元数据塞进算术分支会让两者都无法单测。）
2. 大分母下 1 位小数够吗？（`previous = 1` 时 `+300.0%` 有意义；`previous = 1e9` 时
   `+0.0%` 会掩盖真实存在的 12 万增量。生产做法是**按相对量级切换精度**，
   或者同时给出绝对差值 —— 只给百分比的看板一定会误导人。）
3. 同比 vs 环比 vs 基线？（三个不同的参照系，混用是"数字对不上"的头号来源。
   组件应该只接两个数，参照系由上层算好传进来 —— 本题的契约正是为此而窄。）
4. 怎么防止这类组件被各团队重写一遍？（把它做成设计系统里的唯一出口，
   并把上面那张分支表变成共享测试夹具 —— 重复实现的代价不是工作量，是口径漂移。）"""

    return base(
        'frontend', 'senior',
        '同比徽章：分母为 0、本期归零与缺失，三件事不许渲染成同一个样子',
        statement, 'react-vitest',
        ['divide-by-zero', 'null-vs-zero', 'metric-presentation', 'rendering-contract', 'modern:observability-ui'],
        src('前端平台 / 数据可视化 高级工程师',
            'content/knowledge/hot-interviews/apple-telemetry-pipelines.md §1.2 与 §9.2.2'
            '（非可加指标与"给我三个数字"）；手册未把"除零与归零的呈现口径"做成可判分契约'),
        language='typescript',
        cases=[
            {'name': '正常增长渲染带符号的一位小数', 'input': {'current': 112.5, 'previous': 100},
             'expected': "data-kind='change'，文本 '+12.5%'"},
            {'name': '正常下降保留一位小数', 'input': {'current': 91.7, 'previous': 100},
             'expected': "data-kind='change'，文本 '-8.3%'（不是 -8%）",
             'note': 'toFixed(0) 的实现会把它抹成 -8%，慢变化就此隐形'},
            {'name': '持平：两期相等，含两期都是 0', 'input': [{'current': 100, 'previous': 100},
                                                              {'current': 0, 'previous': 0}],
             'expected': "两种都 data-kind='flat'、文本 '持平'",
             'note': '分支顺序错了会把 (0,0) 判成"新增"'},
            {'name': '上期为 0 是"新增"，不许渲染成 Infinity%', 'input': {'current': 7, 'previous': 0},
             'expected': "data-kind='new'，文本 '新增'"},
            {'name': '本期归零是 -100%，不许当成缺失', 'input': {'current': 0, 'previous': 50},
             'expected': "data-kind='dropped'，文本 '-100%'",
             'note': 'if (!current) 的写法会把"全天不可用"显示成"还没出数"'},
            {'name': '任一缺失渲染无对比，不参与算术', 'input': [{'current': None, 'previous': 50},
                                                                {'current': 50, 'previous': None}],
             'expected': "两种都 data-kind='missing'、文本 '无对比'"},
        ],
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'delta-badge.test.tsx', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=16,
        answer=answer,
    )


# =================================================================== 可证明删除
@draft('sys-apple-deletion-proof')
def q_deletion_proof():
    statement = """## 场景

你负责一个横跨这些存储的用户数据平台：

- **MySQL**（业务主库，200+ 张表，外键关系复杂，其中 30 张表有 `user_id`）
- **Kafka**（14 个 topic，保留 7 天，下游有 23 个消费者组）
- **Iceberg 数据湖**（按天分区的不可变表，历史 4 年，日增 3TB）
- **Redis 缓存 + 一个自建搜索索引 + 一个向量索引**
- **每日全量备份**（加密后存对象存储，保留 90 天）
- **两个第三方处理方**（风控与邮件送达），各自有副本

用户行使删除权（GDPR 第 17 条 / CCPA）。法务给的口径是：**30 天内完成，并交出可核查的证明**。

上一版的实现是"一个后台任务遍历 30 张表 `DELETE`，然后写一行日志"。
审计问了一个问题就把这套东西问穿了：

> "你怎么证明搜索索引里那条向量、以及第 3 天那个 Iceberg 分区里属于这个用户的行，
> 现在确实不存在了？"

## 请回答

1. 给出你的**删除架构**。请按存储分层说明每一层的删除手段，并明确哪些层是"立即物理删除"、
   哪些层做不到、做不到时你用什么替代。
2. **不可变数据湖**（Iceberg 4 年历史）怎么办？请具体到操作层面，并说明代价与时间上界。
3. **密码学粉碎（crypto-shredding）** 能不能替代逐条擦除？在哪些层成立、哪些层不成立？
   说清判据，不要只说"这是一种方案"。
4. 你要交出什么样的**可核查证明**？请给出证明的内容结构、由谁生成、如何防止"自证清白"。
5. 备份（90 天）与第三方副本这两块，你怎么处理，以及如何在证明里**如实表达**它们的状态？

"""

    answer = """## 参考答案要点

**1. 分层删除手段（先说清"哪些层做不到立即物理删除"）**

| 层 | 手段 | 是否立即物理删除 |
| --- | --- | --- |
| MySQL 主表 | 按 `user_id` 逐表删 + **删除前抓取行指纹**（表名/主键/行数/内容 hash） | 是 |
| MySQL 从库/binlog | binlog 里的行变更仍在（row 格式含前后镜像）→ 需要 `expire_logs_days` 收敛或做 binlog 改写 | **否**，靠自然过期 |
| Kafka | 不能"删一条消息"。做法：发一条 **tombstone**（key=用户，value=null）+ compacted topic；未 compact 的原始 topic 靠保留期（7 天）滚掉 | 否（7 天内仍在） |
| Iceberg | 见第 2 问：写一个 delete file（MoR）或做 row 级 rewrite（CoW） | 是，但有代价与时间上界 |
| Redis / 搜索索引 / 向量索引 | **重建比删除可靠**：以"删除事件"驱动，按用户 id 精确删；索引无法保证时走全量重建 + 版本号切换 | 是（前提是索引能按 user 反查） |
| 备份 | 无法定点删除 → 只能靠保留期到期销毁 + 访问冻结 | **否** |
| 第三方 | 合同 + 删除回执 + 抽查审计 | 否（依赖对方） |

核心结构：**一个删除编排器（durable workflow）+ 每层一个删除适配器 + 一份"删除账本"**。
删除必须可重放（幂等）、可观察（每层状态）、可追责（谁在什么时候删了什么）。
上一版失败的根因不是"没删干净"，而是**没有留下任何可核查的中间产物**。

**2. 不可变数据湖**

三条路，代价完全不同：

- **Merge-on-Read delete file**：写一个指向 `(partition, file, position)` 的删除标记。
  读时自动过滤 ⇒ **查询语义上已删除**，但物理字节仍在。优点：秒级生效、可审计（删除文件本身就是证据）。
  缺点：物理数据还在，严格口径下"未删除"，需要配套后台 compaction 才真正消失。
- **Copy-on-Write 行级重写**：重写受影响的数据文件，物理消失。代价 = 受影响分区的全量重写。
  4 年历史 × 日增 3TB 时，"扫全部历史找这个用户"才是真成本 ——
  所以必须先有**用户→分区的倒排索引**（写入时就维护 `user_id → 命中的 partition/file`），
  否则删除任务要扫 PB 级数据，30 天窗口根本不够。
- **分区级销毁**：只有当某分区里全部属于该用户（罕见）才成立。

**时间上界怎么定**：`受影响分区数 × 单分区重写时间 / 并发度`，并且要预留失败重试。
工程上正确的做法是**平时就把"删除成本"做成可观测指标**（每新增一个用户产生多少可删单元），
而不是等 DSAR 来了再估。

**3. 密码学粉碎的适用判据**

成立的条件是：**该层的数据只能经由这把密钥被读到**。

- ✅ 适用：字段级加密的列（删掉 per-user DEK ⇒ 密文不可读）、备份（销毁用户密钥子树 ⇒ 备份里的数据变成不可解密）、对象存储里的文档 blob。
- ❌ 不适用：**明文索引与可搜索字段**（要能按前缀/相似度检索就不能只留密文）、
  聚合统计（计数与分位数不依赖密钥）、Kafka 未加密的原始 topic、
  任何"数据被复制到没有密钥管理的地方"（日志、临时表、导出文件）。
- ⚠️ 关键陷阱：**密钥粒度**。全局主密钥粉碎等于删库；per-user 密钥要求"每个用户的每条数据都只被这一把钥匙加密" ——
  一旦存在共享的批量加密（为了性能把 1000 个用户放一个 DEK 下），粉碎就会误伤他人。
- 判据一句话：**crypto-shredding 是"可用性删除"，不是"存在性删除"**。
  审计口径下必须如实说明：字节还在，但对该主体的读取能力已永久销毁，且销毁动作本身有密钥服务审计日志。

**4. 可核查证明（这是本题的得分重心）**

证明的内容结构（每个用户一份，机器可读）：

```
{
  "subject": "u-123",
  "requestId": "dsar-2026-05-01-77",
  "policyVersion": "retention-map-v14",     // 关键：删除范围由声明式策略生成，不是人写死的表清单
  "scope": {"tables": 30, "topics": 14, "indexes": 3, "lakePartitions": 412},
  "evidence": [
    {"layer":"mysql","target":"orders","deletedRows":17,"fingerprint":"sha256:…","at":"…"},
    {"layer":"kafka","target":"user-events","tombstoneOffset":88123,"compactBy":"…"},
    {"layer":"iceberg","table":"events","deleteFiles":["…"],"rewrittenFiles":["…"]},
    {"layer":"vector-index","rebuildVersion":"v-2026-05-03-2","absentProbe":"u-123 → 0 hits"}
  ],
  "notDeleted": [
    {"layer":"backup","reason":"immutable media","expiry":"2026-07-30","accessFrozen":true},
    {"layer":"thirdparty","vendor":"risk-co","receipt":"…","dueBy":"2026-06-15","status":"awaiting"}
  ]
}
```

**如何防止"自证清白"（审计真正会问的）**：

1. **删除前指纹由独立组件在删除前采集**，删除后由另一个组件做**缺席探针**（negative proof）：
   拿同一批 id 去每个存储再查一遍，断言 0 命中。两者时间戳与签名都要留。
2. **抽样复核**：第三方（或内部独立风控）随机抽取 DSAR 重跑探针，而不是只看系统自己的日志。
3. **策略即代码**：`scope` 必须来自一份版本化的"数据地图"（哪个字段在哪些存储有副本），
   评审过、有 owner、有变更历史。否则"30 张表"是某个工程师的记忆，不是公司的承诺 ——
   **上一版真正缺的就是这个**：删了它知道的表，无法证明没有别的表。
4. **证明本身不可变**（append-only 存储 + hash 链），且删除请求与证明一一绑定。

**5. 备份与第三方：如实表达**

- 备份：技术上做不到定点删。合规上的通行做法是"**密钥销毁 + 访问冻结 + 到期即毁**"三段：
  销毁该用户的 DEK 子树（使备份中的数据不可解密）、给备份系统下发"含该 subject 的恢复任务必须拒绝"的
  恢复门禁（防止误 restore 让数据复活）、保留期到点后销毁介质并留销毁记录。
  证明里必须写在 `notDeleted` 而不是省略 —— **省略比声明"做不到"风险更高**。
- 第三方：合同里预先约定 SLA（如 10 个工作日删除 + 回执格式）、要求回执带**可验证内容**
  （删除条数/时间窗/签名），并对高风险处理方做**探针抽查**（用一个测试 subject 走一遍，验证它真的删了）。
  做不到就必须在证明里标 `awaiting` + `dueBy`，并在超时时触发升级流程。

**评分时最看重**：是否明确说出"哪些层做不到立即物理删除"并给出替代与时间上界；
是否给出**可核查**（独立采集 + 缺席探针 + 抽样复核）而不只是"记日志"；
crypto-shredding 是否讲清适用判据与密钥粒度陷阱；备份与第三方是否**如实写进证明**。"""

    return base(
        'system-design', 'principal',
        '「30 天内删除并交出可核查证明」：200 张表、不可变数据湖、90 天备份与两个第三方',
        statement, 'llm-rubric',
        ['data-deletion', 'crypto-shredding', 'auditability', 'immutable-storage', 'modern:privacy-engineering'],
        src('数据平台 / 隐私工程方向 技术专家',
            'data/kb-txt/Apple面试准备手册.txt §19.x 隐私与端云分工 + '
            'content/knowledge/hot-interviews/apple-privacy-and-edge-cloud.md（可证明删除只作为口号出现，未做成设计题）'),
        rubric={'maxScore': 10, 'points': [
            {'label': '分层手段与"做不到"的诚实', 'weight': 3,
             'criteria': '是否逐层给出删除手段，并明确指出 binlog / Kafka 原始 topic / 备份这三类做不到立即物理删除，给出替代（tombstone+compaction、保留期、密钥销毁+访问冻结）与时间上界'},
            {'label': '不可变数据湖的可执行方案', 'weight': 2,
             'criteria': '是否区分 MoR 删除标记（语义删除）与 CoW 重写（物理删除），并指出真正瓶颈是"用户→分区"倒排索引缺失导致的扫描成本'},
            {'label': '密码学粉碎的适用判据', 'weight': 2,
             'criteria': '是否给出成立条件（数据只能经该密钥被读到）与不成立场景（可搜索明文索引、聚合统计、无密钥管理的副本），并点出密钥粒度会误伤'},
            {'label': '可核查证明的结构与独立性', 'weight': 3,
             'criteria': '是否给出机器可读的证明内容（scope/证据/未完成项），且包含防止自证清白的机制：删除前指纹独立采集、删除后缺席探针、抽样复核、策略即代码（数据地图版本化）'}
        ], 'notes': '只答"写个任务删一遍并记日志"的，第 4 项按 0 分；'
                    '把备份写成"已删除"而不是如实标注保留期的，第 1 项扣分（这是合规上更严重的错误）。'},
        estimatedMinutes=35,
        answer=answer,
    )


# =================================================================== Schema 契约兼容性门禁
@draft('alg-apple-schema-gate')
def q_schema_compat_gate():
    """
    破坏性变更清单由下面的 model() 算出。规则表全部写进题面，
    所以模型只负责"照规则表执行"，不负责发明规则。
    """

    WIDEN = {'int': 0, 'long': 1, 'double': 2}   # 数值族内部的加宽顺序
    NUMERIC = set(WIDEN)

    def parse(spec):
        if spec is None:
            raise ValueError('null field spec')
        parts = spec.split(':')
        if len(parts) not in (3, 4):
            raise ValueError('field spec must be name:type:nullable[:default]')
        name, ftype, nullable = parts[0], parts[1], parts[2]
        if not name:
            raise ValueError('empty field name')
        if nullable not in ('true', 'false'):
            raise ValueError('nullable must be true or false')
        if len(parts) == 4 and parts[3] != 'default':
            raise ValueError('fourth segment must be the literal "default"')
        has_default = len(parts) == 4
        if ftype.startswith('enum(') and ftype.endswith(')'):
            values = ftype[5:-1].split(',')
            if any(not v for v in values):
                raise ValueError('empty enum value')
            ftype = ('enum', frozenset(values))
        elif ftype in NUMERIC or ftype in ('bool', 'string', 'bytes', 'ts'):
            ftype = ('atom', ftype)
        else:
            raise ValueError('unknown field type: ' + parts[1])
        return {'name': name, 'type': ftype, 'nullable': nullable == 'true',
                'has_default': has_default}

    def type_compatible(old, new):
        """只有"数值族内加宽"与"完全同型"算兼容；枚举集合有任何变化都不兼容。"""
        if old[0] == 'enum' or new[0] == 'enum':
            return old == new
        if old[1] in NUMERIC and new[1] in NUMERIC:
            return WIDEN[old[1]] <= WIDEN[new[1]]
        return old == new

    def model(old_specs, new_specs):
        old = [parse(s) for s in old_specs]
        new = [parse(s) for s in new_specs]
        for side, label in ((old, 'old'), (new, 'new')):
            names = [f['name'] for f in side]
            if len(set(names)) != len(names):
                raise ValueError('duplicated field name in ' + label)
        if not old:
            return []                     # 首个 schema：没有既有的读方，也就没有兼容问题
        old_by = {f['name']: f for f in old}
        new_by = {f['name']: f for f in new}
        codes = []
        for name in old_by:
            if name not in new_by:
                codes.append('REMOVED:' + name)
                continue
            a, b = old_by[name], new_by[name]
            if not type_compatible(a['type'], b['type']):
                codes.append('TYPE_INCOMPATIBLE:' + name)
            if a['nullable'] and not b['nullable']:
                codes.append('RETIGHTENED:' + name)
        for name, f in new_by.items():
            if name not in old_by and not f['nullable'] and not f['has_default']:
                codes.append('ADDED_REQUIRED:' + name)
        return sorted(codes)

    def case(name, old, new, throws=False, note=None):
        """`throws` 是声明不是推断：不一致就直接炸在生成期（见 airbnb gen.py 的同名注释）。"""
        try:
            got = model(old, new)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [old, new],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [old, new], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

事件表的一条硬规范（手册里写了、也真出过事故）：**"加字段永远安全"是错的**。
老 SDK 还在按旧 schema 写数据，而新 schema 里一个 `NOT NULL` 且没有默认值的新字段，
会让所有历史行在读侧直接失败 —— 表现是"上线后昨天的数据突然查不出来"。

你要实现发布流水线里的那道门禁：给定新旧两版字段列表，**列出全部破坏性变更**。

## 你要实现的入口

```java
public static String[] breakingChanges(String[] oldFields, String[] newFields)
```

每个字段是一个 spec 串，段数 3 或 4，用 `:` 分隔：

```
name:type:nullable            →  无默认值
name:type:nullable:default    →  有默认值（第四段只能是字面量 default）
```

- `type` ∈ `int` `long` `double` `bool` `string` `bytes` `ts` `enum(v1,v2,...)`
- `nullable` ∈ `true` `false`
- 字段名非空、不含 `:`、同一侧不重复

## 输出：破坏性变更代码，**按字典序升序**

一个字段可以同时命中多条规则，**每条都要输出**。没有破坏性变更 ⇒ 返回长度为 0 的数组。

| 代码 | 触发条件 |
| --- | --- |
| `REMOVED:<name>` | 老 schema 有、新 schema 没有 |
| `ADDED_REQUIRED:<name>` | 新增字段，且 `nullable=false`，且**没有**默认值 |
| `RETIGHTENED:<name>` | 该字段 `nullable` 由 `true` 变 `false` |
| `TYPE_INCOMPATIBLE:<name>` | 类型变更**不**兼容（见下） |

## 类型兼容规则（判分点）

1. 数值族 `int < long < double`：**加宽兼容**（`int→long`、`int→double`、`long→double` 安全），
   **窄化不兼容**（`long→int` 不兼容，即使当前样本全都装得下）。
   同族同型当然兼容。
2. `bool` / `string` / `bytes` / `ts` 只有**完全相同**才兼容 —— 特别地 `bool→int`、
   `string→ts`、`ts→long` 都**不**兼容（`ts` 的表示形式不是本题的授权范围）。
3. `enum(...)`：**值集合有任何变化都不兼容**，包括"只是多加了一个值"。
   加值是破坏性的，因为老读方对未知枚举值的行为未定义（多半是抛错或静默丢行）；
   去值也是，因为历史数据里那个值在新 schema 下无法表示。
   但**同一集合的重排/重复去重**兼容（枚举是无序集合）。

## 另外两条不成文但会咬人的规则

- **字段必须按名字匹配，不按位置**。调整顺序是安全变更。
  （把两侧按下标 zip 的实现，会把一次纯重排判成一堆 `REMOVED` + `ADDED_REQUIRED`。）
- `oldFields` 为空数组 ⇒ 这是**第一版** schema：没有既有的读方，返回空数组。
  不要因为"有 `NOT NULL` 无默认的新字段"就报破坏 —— 那个规则针对的是"老数据读不出来"，
  第一版没有老数据。

## 非法输入（抛 `IllegalArgumentException`）

字段 spec 段数不是 3 或 4；第四段不是 `default`；字段名为空；`nullable` 段不是
`true`/`false`；未知类型名；`enum()` 括号为空或含空值；同一侧字段名重复；spec 为 `null`。

不许引入第三方依赖。"""

    reference = """import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class Solution {
  private static final List<String> ATOMS = Arrays.asList("bool", "string", "bytes", "ts");
  private static final Map<String, Integer> WIDEN = new HashMap<>();

  static {
    WIDEN.put("int", 0);
    WIDEN.put("long", 1);
    WIDEN.put("double", 2);
  }

  private static final class Field {
    final String name;
    final boolean isEnum;
    final String atom;
    final Set<String> enumValues;
    final boolean nullable;
    final boolean hasDefault;

    Field(String name, boolean isEnum, String atom, Set<String> enumValues,
          boolean nullable, boolean hasDefault) {
      this.name = name;
      this.isEnum = isEnum;
      this.atom = atom;
      this.enumValues = enumValues;
      this.nullable = nullable;
      this.hasDefault = hasDefault;
    }
  }

  public static String[] breakingChanges(String[] oldFields, String[] newFields) {
    List<Field> old = parseAll(oldFields, "old");
    List<Field> neu = parseAll(newFields, "new");
    if (old.isEmpty()) {
      return new String[0];              // 第一版：没有既有读方，谈不上破坏兼容
    }
    Map<String, Field> oldByName = index(old);
    Map<String, Field> newByName = index(neu);
    List<String> codes = new ArrayList<>();

    for (Field a : old) {
      Field b = newByName.get(a.name);
      if (b == null) {
        codes.add("REMOVED:" + a.name);
        continue;
      }
      if (!compatible(a, b)) {
        codes.add("TYPE_INCOMPATIBLE:" + b.name);
      }
      if (a.nullable && !b.nullable) {
        codes.add("RETIGHTENED:" + b.name);
      }
    }
    for (Field b : neu) {
      if (!oldByName.containsKey(b.name) && !b.nullable && !b.hasDefault) {
        codes.add("ADDED_REQUIRED:" + b.name);
      }
    }
    codes.sort(String::compareTo);
    return codes.toArray(new String[0]);
  }

  private static List<Field> parseAll(String[] specs, String side) {
    List<Field> out = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    for (String spec : specs) {
      if (spec == null) throw new IllegalArgumentException("null field spec");
      String[] p = spec.split(":", -1);
      if (p.length != 3 && p.length != 4) {
        throw new IllegalArgumentException("bad spec arity in " + side + ": " + spec);
      }
      if (p[0].isEmpty()) throw new IllegalArgumentException("empty field name in " + side);
      if (p.length == 4 && !"default".equals(p[3])) {
        throw new IllegalArgumentException("fourth segment must be 'default': " + spec);
      }
      boolean hasDefault = p.length == 4;
      boolean nullable = parseNullable(p[2], spec);
      Set<String> enumValues = null;
      boolean isEnum;
      if (p[1].startsWith("enum(") && p[1].endsWith(")")) {
        isEnum = true;
        enumValues = new HashSet<>(Arrays.asList(p[1].substring(5, p[1].length() - 1).split(",", -1)));
        if (enumValues.contains("")) {
          throw new IllegalArgumentException("empty enum value: " + spec);
        }
      } else {
        isEnum = false;
        if (!WIDEN.containsKey(p[1]) && !ATOMS.contains(p[1])) {
          throw new IllegalArgumentException("unknown field type: " + p[1]);
        }
      }
      if (!seen.add(p[0])) {
        throw new IllegalArgumentException("duplicated field name in " + side + ": " + p[0]);
      }
      out.add(new Field(p[0], isEnum, p[1], enumValues, nullable, hasDefault));
    }
    return out;
  }

  private static boolean parseNullable(String raw, String spec) {
    if ("true".equals(raw)) return true;
    if ("false".equals(raw)) return false;
    throw new IllegalArgumentException("nullable must be true/false: " + spec);
  }

  private static Map<String, Field> index(List<Field> fields) {
    Map<String, Field> byName = new HashMap<>();
    for (Field f : fields) byName.put(f.name, f);
    return byName;
  }

  private static boolean compatible(Field a, Field b) {
    if (a.isEnum || b.isEnum) {
      return a.isEnum && b.isEnum && a.enumValues.equals(b.enumValues);   // 无序集合比较
    }
    Integer from = WIDEN.get(a.atom);
    Integer to = WIDEN.get(b.atom);
    if (from != null && to != null) {
      return from <= to;                 // 只允许同族加宽
    }
    return a.atom.equals(b.atom);        // 跨族一律不兼容
  }
}"""

    naive = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  // "看起来在干活"版：按下标配对，只比类型字符串
  public static String[] breakingChanges(String[] oldFields, String[] newFields) {
    List<String> codes = new ArrayList<>();
    int shared = Math.min(oldFields.length, newFields.length);
    for (int i = 0; i < shared; i++) {
      String[] a = oldFields[i].split(":", -1);
      String[] b = newFields[i].split(":", -1);
      if (!a[1].equals(b[1])) {
        codes.add("TYPE_INCOMPATIBLE:" + b[0]);
      }
      if ("true".equals(a[2]) && "false".equals(b[2])) {
        codes.add("RETIGHTENED:" + b[0]);
      }
    }
    for (int i = shared; i < newFields.length; i++) {
      String[] b = newFields[i].split(":", -1);
      if ("false".equals(b[2])) {
        codes.add("ADDED_REQUIRED:" + b[0]);
      }
    }
    for (int i = shared; i < oldFields.length; i++) {
      codes.add("REMOVED:" + oldFields[i].split(":", -1)[0]);
    }
    java.util.Collections.sort(codes);
    return codes.toArray(new String[0]);
  }
}"""

    answer = """## 参考答案要点

先把两侧解析成 `{name → field}` 的**按名字索引**，然后三条规则各自独立地往结果里加代码：
遍历老字段得出 `REMOVED` / `TYPE_INCOMPATIBLE` / `RETIGHTENED`，
遍历新字段得出 `ADDED_REQUIRED`，最后排序。核心难点不是控制流，是那张规则表里
**哪些变更"看着安全其实不安全"**。

**按下标配对是这题最危险的实现**（用例「基线安全演进：加宽 + 新增可空 + 纯重排」）：
一次把 `country` 挪到第一位的调整，zip 版会报 `REMOVED:country` +
`ADDED_REQUIRED:page_view` 之类一串 —— 而门禁一响，发布就被拦下，
于是团队学会第一件事就是"给门禁加白名单"。**误报的代价不是多算一次，是把闸门废掉。**

**加枚举值也是破坏性的**（用例「枚举加值是破坏，重排与去重不是」）：
多数团队的直觉是"加枚举值向后兼容"，这话只对**写方**成立。读方通常这样实现：
`switch (kind) { ... default: throw new IllegalStateException(); }` —— 新值一来就崩，
或者更糟：静默走到 default 分支把整行丢掉。
所以本题把枚举定义为"集合相等才兼容"，并用 `HashSet.equals` 实现，
顺带让 `{a,b}` 与 `{b,a}` 判为兼容（枚举是无序集合，写成 `List.equals` 就错了）。

**`long→int` 即使"当前数据都装得下"也不兼容**（用例「数值窄化不兼容、加宽兼容」）：
兼容性的判断对象是**全部历史数据 + 未来写入方**，不是今天采到的样本。
按样本量判断的门禁，会在某个 outlier 落入分区的那天失效，而那天通常是月底或对账日。

**`RETIGHTENED` 与 `ADDED_REQUIRED` 是同一件事的两个时间方向**：
前者针对"老数据里有 null，新 schema 不许 null"；
后者针对"老写入方还在产不带这个字段的记录"。
两者都只在**读侧**暴露，写侧测试全绿 —— 这也是为什么这道门禁必须卡在发布流水线上，
而不是指望人 review。

**第一版返回空**（用例「首个 schema：没有既有读方就没有兼容问题」）：
`oldFields` 为空时套用"新增字段规则"会报出 `ADDED_REQUIRED:*` 一片，
把每个新事件类型的首次注册都拦下来。规则的目的决定规则的适用范围 ——
这是门禁类代码最容易写错的地方，因为**少一个 if 看起来完全正常**。

**工程延伸（面试追问点）**

1. `ts` 到 `long`（epoch）为什么不算兼容？（"同族加宽"只对**同一物理表示**成立；
   `ts` 的时区口径、精度（秒/毫秒）与时区偏移都不是类型能表达的。
   真要改，正确做法是新增一个字段双写、按 `schema_version` 路由，而不是改类型。）
2. 这道门禁能拦住"字段改名"吗？（拦不住 —— 它会报成 `REMOVED:old` + `ADDED_REQUIRED:new`，
   所以**必须**报，只是报告形态不直观。做法是在门禁里加一层相似度提示
   （名字接近 + 类型相同 ⇒ 标注"疑似改名，请显式登记 rename"），但**不要**自动当成兼容：
   自动识别改名等于给"偷偷换语义"开门。）
3. 为什么不直接上 protobuf/avro 的兼容性检查器？（它们的规则是"wire 兼容"，
   而事件治理要的是**数据可用**：avro 允许 `int→long`、允许加带默认值的字段，
   但它不知道"这个字段被三个下游看板当过滤条件用"。所以门禁 = schema 层规则 +
   语义层规则 + 下游依赖图，前两者可以纯代码判，第三者需要注册表。）
4. 有默认值的 `NOT NULL` 新增字段真的安全吗？（对读侧安全，对**回填语义**不一定：
   历史行会读出默认值，于是"这个字段上线前的真实值"和"上线后恰好等于默认值"混在一起。
   正确做法是新字段先可空、跑完回填、再收紧 —— 而"先可空后收紧"这步恰好是本门禁会拦的
   `RETIGHTENED`，所以收紧要走一次性豁免 + 回填完成证明，不能靠改规则放行。）"""

    return base(
        'algorithms', 'senior',
        'Schema 契约门禁：破坏性变更清单（按名字匹配，枚举加值也算破坏）',
        statement, 'java-junit',
        ['schema-evolution', 'contract-testing', 'compatibility', 'false-positive-cost',
         'modern:data-contract'],
        src('数据平台 / 事件管道 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §19.1（schema 契约兼容性）+ §9.2.3'
            '（"新增 NOT NULL 字段让历史行读不出来"的静默丢列事故）；手册只给了概念清单，未做成可判分规则表'),
        language='java',
        cases=[
            case('基线安全演进：加宽 + 新增可空 + 纯重排',
                 ['page_view:bool:false', 'duration:int:true'],
                 ['duration:long:true', 'page_view:bool:false', 'city:string:true'],
                 note='三条规则都不该触发；这是"看起来最危险其实最安全"的一类'),
            case('删字段 + 新增必填无默认，而 b 是放宽不许报',
                 ['a:int:true', 'b:string:false', 'c:long:false'],
                 ['b:string:true', 'c:long:false', 'd:ts:false'],
                 note='只有两条：REMOVED:a 与 ADDED_REQUIRED:d。b 走的是 false→true 的**放宽**，'
                      '把它报出去就是误拦发布'),
            case('数值窄化不兼容、加宽兼容',
                 ['big:long:true', 'widen:int:false'],
                 ['big:int:true', 'widen:double:false']),
            case('枚举加值是破坏，重排与去重不是',
                 ['kind:enum(click,view):false', 'state:enum(on,off):true'],
                 ['kind:enum(click,view,purchase):false', 'state:enum(off,on):true'],
                 note='state 只是顺序变了 —— 用 List.equals 比就会误报'),
            case('跨族：bool→int、string→ts、ts→long 全都不兼容',
                 ['flag:bool:false', 'path:string:true', 'when:ts:false'],
                 ['flag:int:false', 'path:ts:true', 'when:long:false']),
            case('新增 NOT NULL 但有默认值：安全',
                 ['id:long:false'],
                 ['id:long:false', 'source:string:false:default']),
            case('放宽 null：false→true 是安全变更',
                 ['email:string:false'],
                 ['email:string:true']),
            case('首个 schema：没有既有读方就没有兼容问题',
                 [],
                 ['id:long:false', 'kind:enum(a,b):false'],
                 note='套用"新增字段规则"会把每次事件类型首次注册都拦下来'),
            case('同一字段既窄化又收紧：两条都要出',
                 ['score:double:true'],
                 ['score:int:false']),
            case('退化：两侧都为空', [], []),
            case('非法：spec 段数不对', ['a:int'], ['a:int:true'], throws=True),
            case('非法：nullable 段不是 true/false', ['a:int:yes'], ['a:int:true'], throws=True),
            case('非法：未知类型名', ['a:float:true'], ['a:float:true'], throws=True,
                 note='float 不在授权类型里 —— 数值族只认 int/long/double，'
                      '放过来会让"加宽"规则静默失效'),
            case('非法：第四段不是 default', ['a:int:true:DEFAULT'], ['a:int:true'], throws=True),
            case('非法：同一侧字段名重复', ['a:int:true', 'a:long:false'], ['a:int:true'],
                 throws=True),
            case('非法：枚举值为空', ['a:enum(,b):true'], ['a:enum(b):true'], throws=True),
            case('非法：字段名为空', [':int:true'], ['b:int:true'], throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'String[] breakingChanges(String[] oldFields, String[] newFields)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer=answer,
    )


# =================================================================== H3 邻近 join 的去重
@draft('alg-apple-h3-kring-join')
def q_h3_kring_join():
    """期望值由 distinct_per_poi() 算出：六边形距离用轴向坐标公式，不手推。"""

    def hex_distance(dq, dr):
        # 轴向坐标 (q,r) 的六边形距离 = max(|dq|, |dr|, |dq+dr|)
        return max(abs(dq), abs(dr), abs(dq + dr))

    def distinct_per_poi(traj_id, qs, rs, poi_qs, poi_rs, k):
        if len(traj_id) != len(qs) or len(traj_id) != len(rs):
            raise ValueError('trajectory arrays disagree')
        if len(poi_qs) != len(poi_rs):
            raise ValueError('poi arrays disagree')
        if k < 0:
            raise ValueError('k must be >= 0')
        for t in traj_id:
            if t <= 0:
                raise ValueError('trajId must be positive')
        out = []
        for j in range(len(poi_qs)):
            hit = set()
            for i in range(len(traj_id)):
                if hex_distance(qs[i] - poi_qs[j], rs[i] - poi_rs[j]) <= k:
                    hit.add(traj_id[i])          # 去重才是这条用例的重点
            out.append(len(hit))
        return out

    def case(name, traj_id, qs, rs, poi_qs, poi_rs, k, throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 同名注释）。"""
        try:
            got = distinct_per_poi(traj_id, qs, rs, poi_qs, poi_rs, k)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [traj_id, qs, rs, poi_qs, poi_rs, k],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [traj_id, qs, rs, poi_qs, poi_rs, k], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    # 以原点为中心、六边形距离 <=2 的一圈（含中心共 19 格）
    RING2 = [(q, r) for q in range(-3, 4) for r in range(-3, 4) if max(abs(q), abs(r), abs(q + r)) <= 2]

    statement = """## 背景

海量轨迹与兴趣点做邻近匹配时，"逐对算球面距离"是笛卡尔积，跑不动也分布式不了。
通行做法是把经纬度离散成网格 cell（H3 的六边形格、S2 的球面格），
于是"邻近"退化成 **cell 等值 join + 一圈 ring 扩展**。

扩展之后有个必踩的坑：**同一条轨迹会命中同一个兴趣点的多个 cell**
（轨迹本来就跨格，POI 补 ring 之后又是多个 cell），
不去重就把"多少条轨迹 nearby"算成"有多少个命中对"。

## 你要实现的入口

```java
public static int[] distinctTrajsPerPoi(int[] trajId, int[] cellQ, int[] cellR,
                                        int[] poiQ, int[] poiR, int k)
```

- 轨迹侧：第 `i` 个轨迹点是 `(trajId[i], cellQ[i], cellR[i])`。一条轨迹有**多个点**是常态。
- POI 侧：第 `j` 个兴趣点在 `(poiQ[j], poiR[j])`。
- 返回长度等于 POI 个数：第 `j` 项 = **有多少条不同的轨迹**，其任一点与该 POI 的
  六边形距离 `<= k`。输出按 POI 下标顺序，不排序。

## 六边形距离（轴向坐标）

网格用**轴向坐标** `(q, r)`（第三个立方坐标 `s = -q - r`，所以只存两个）。
两点距离：

```
dist = max(|Δq|, |Δr|, |Δq + Δr|)
```

**这不是曼哈顿、也不是切比雪夫**：本题的用例专门各造了一条能区分它们的点。
邻居数：距离 `<= 1` 含中心共 7 格，`<= 2` 共 19 格。

## 规则细节

1. "命中"是**轨迹级**的：一条轨迹只要有 ≥1 个点落在 ring 内就贡献 **1**，多命中不重复计。
2. `k = 0` 退化成精确同格。
3. 坐标可正可负（轴向坐标没有非负约束），原点没有特殊性。
4. 轨迹点数组为空 ⇒ 每个 POI 都是 `0`；POI 数组为空 ⇒ 返回长度为 0 的数组。
5. 非法输入抛 `IllegalArgumentException`：`k < 0`、三根轨迹数组长度互不相等、
   两根 POI 数组长度不等、`trajId <= 0`。

不许引入第三方依赖（H3 库不在沙箱里 —— 本题只考"补 ring 之后"的那一步）。"""

    reference = """import java.util.HashSet;
import java.util.Set;

public class Solution {
  public static int[] distinctTrajsPerPoi(int[] trajId, int[] cellQ, int[] cellR,
                                          int[] poiQ, int[] poiR, int k) {
    if (trajId.length != cellQ.length || trajId.length != cellR.length) {
      throw new IllegalArgumentException("trajectory arrays disagree");
    }
    if (poiQ.length != poiR.length) {
      throw new IllegalArgumentException("poi arrays disagree");
    }
    if (k < 0) {
      throw new IllegalArgumentException("k must be >= 0");
    }
    for (int t : trajId) {
      if (t <= 0) throw new IllegalArgumentException("trajId must be positive");
    }
    int[] out = new int[poiQ.length];
    for (int j = 0; j < poiQ.length; j++) {
      Set<Integer> distinct = new HashSet<>();      // 轨迹级去重，不是命中计数
      for (int i = 0; i < trajId.length; i++) {
        long dq = (long) cellQ[i] - poiQ[j];        // 先升宽再相减：坐标接近 int 边界时不溢出
        long dr = (long) cellR[i] - poiR[j];
        long dist = Math.max(Math.abs(dq), Math.max(Math.abs(dr), Math.abs(dq + dr)));
        if (dist <= k) {
          distinct.add(trajId[i]);
        }
      }
      out[j] = distinct.size();
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // 补 ring 之后直接 COUNT(*) 的写法：每个"轨迹点 × POI"的命中对都数一遍
  public static int[] distinctTrajsPerPoi(int[] trajId, int[] cellQ, int[] cellR,
                                          int[] poiQ, int[] poiR, int k) {
    if (trajId.length != cellQ.length || trajId.length != cellR.length) {
      throw new IllegalArgumentException("trajectory arrays disagree");
    }
    if (poiQ.length != poiR.length) {
      throw new IllegalArgumentException("poi arrays disagree");
    }
    if (k < 0) throw new IllegalArgumentException("k must be >= 0");
    for (int t : trajId) {
      if (t <= 0) throw new IllegalArgumentException("trajId must be positive");
    }
    int[] out = new int[poiQ.length];
    for (int j = 0; j < poiQ.length; j++) {
      for (int i = 0; i < trajId.length; i++) {
        int dq = cellQ[i] - poiQ[j];
        int dr = cellR[i] - poiR[j];
        if (Math.abs(dq) + Math.abs(dr) <= k) {     // 错法：把六边形距离当成曼哈顿距离
          out[j]++;
        }
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

对每个 POI 扫一遍轨迹点，命中就把 `trajId` 丢进 `HashSet`，最后取 `size()`。
`O(点数 × POI 数)` 时间（真实系统里这一步是"cell 等值 join 之后的小范围收敛"，
所以两边的量都不大）。距离公式用 `max(|dq|, |dr|, |dq+dr|)`。

**为什么必须去重**（用例「同一条轨迹的三个点都命中同一个 POI：仍然算 1 条」）：
轨迹本来就是连续的 —— 一条经过 POI 附近的轨迹通常**跨好几个 cell**。
"多少条轨迹经过这个商圈"与"有多少个轨迹点落在范围内"是两个数，
后者还随采样率线性变化：把轨迹抽稀一倍，指标就掉一半，
而业务方完全看不出统计口径变了。**这类"随数据量而非现象变化"的指标是数据平台最典型的负债。**

**两个反例点各自钉死一种错度量**：
- `(dq=1, dr=1)`：六边形距离 2、切比雪夫（`max(|dq|,|dr|)`）1 ⇒ 用切比雪夫会**多算**；
- `(dq=2, dr=-1)`：六边形距离 2、曼哈顿 3 ⇒ 用曼哈顿会**漏算**。
所以本题至少需要这两条用例 —— 只造一条的话，另一种错误度量能混过去。
（这正是"网格距离"最容易写错的地方：三维立方坐标只存了两维，
第三维 `s = -q-r` 的贡献必须通过 `dq+dr` 项回到公式里。）

**升宽再减**（用例「坐标接近 int 边界：先升 long 再相减」）：
`cellQ = 2_000_000_000`、`poiQ = -2_000_000_000` 相减在 `int` 上溢出，
结果变成负的小数字，`abs()` 之后可能落进 `k` 以内 ——
症状是"个别格子意外命中"，而且只在特定区域出现，最难复现。
真实 H3 的 cell 是 64 位整数（不是这里的抽象坐标），
所以"空间索引 id 用 int 存"本身就是该被 review 拦掉的写法。

**工程延伸（面试追问点）**

1. 为什么这个写法在真集群里还是不对？（它是 POI 侧广播 × 轨迹侧全扫。
   可分布式的形状是**两侧都按 cell 分桶再 join**：把 POI 预先展开成
   `(poi_id, covered_cell)`（k-ring 的物化表，k 固定时可以离线算好），
   轨迹点按 cell 分桶 ⇒ 变成等值 join + 一次 `COUNT(DISTINCT traj_id)`。
   去重的那一步要能在分区内局部完成，否则就退化成 shuffle 全量 id。）
2. 分辨率怎么选？（细格精确但 ring 扇出与存储暴涨、且轨迹采样点可能稀疏到每格一个；
   粗格 join 扇出小但误命中多。真实做法是**两级**：粗格做候选、细格或精确距离做复核 ——
   这题的 `k` 就是粗格那一级的半径参数。另外隐私侧要求"对外的聚合用粗格"，
   同一套 cell 服务两种精度，靠分辨率而不是两套索引。）
3. `COUNT(DISTINCT)` 在 SQL 里怎么不炸？（大基数的 `COUNT(DISTINCT)` 是单点聚合，
   要做两阶段（先 `GROUP BY traj_id` 局部去重再计数），或按精度要求换 HLL/theta sketch。
   换成 sketch 之后"环比涨跌"要先确认误差带，否则会把量化噪声读成趋势。）
4. 为什么不用 geohash？（geohash 是正方形分层，邻近查询要贴 8 个邻居且**边界处距离不等**
   （四角比正边远），六边形的 1-ring 距离处处相等，这是选 H3 的唯一硬理由；
   其余都是生态与实现成本。）"""

    return base(
        'algorithms', 'senior',
        'H3 k-ring 邻近 join：轨迹级去重，六边形距离不是曼哈顿',
        statement, 'java-junit',
        ['spatial-index', 'hex-grid', 'distinct-count', 'integer-overflow',
         'modern:geospatial-join'],
        src('地图数据 / 空间索引 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §19.6（H3/S2 把空间 join 降成等值 join、'
            'ring 扩展与分辨率权衡；手册只给概念，未给可判分的距离与去重口径）'),
        language='java',
        cases=[
            case('同一条轨迹的三个点都命中同一个 POI：仍然算 1 条',
                 [7, 7, 7, 8], [0, 1, 2, 10], [0, 0, 0, 0], [0], [0], 2,
                 note='朴素版给 4 —— 命中对数与轨迹数是两个不同的数'),
            case('切比雪夫会多算：(1,1) 的六边形距离是 2',
                 [1, 2], [1, 0], [1, 0], [0], [0], 1,
                 note='traj 1 在 (1,1)：max(1,1,2)=2 > 1 ⇒ 不命中；traj 2 在原点 ⇒ 命中'),
            case('曼哈顿会漏算：(2,-1) 的六边形距离是 2',
                 [1], [2], [-1], [0], [0], 2,
                 note='曼哈顿 3 会把它挡在 k=2 之外'),
            case('多 POI 输出按 POI 下标，不排序',
                 [1, 2, 3], [0, 5, 0], [0, 5, 1], [0, 0, 5], [0, 1, 5], 1,
                 note='POI0 命中 traj1(0,0) 与 traj3(0,1)=2；POI1 同样 2；POI2 命中 traj2=1'),
            case('k=0 退化成精确同格',
                 [1, 2, 3], [0, 0, 1], [0, 1, 0], [0], [0], 0),
            case('2-ring 全貌：19 个格各一点、同一条轨迹',
                 [4] * len(RING2), [q for q, _ in RING2], [r for _, r in RING2], [0], [0], 2,
                 note='距离 <=2 含中心正好 19 格，且它们同属一条轨迹 ⇒ 答案仍是 1'),
            case('负坐标没有特殊性',
                 [1, 2], [-3, 3], [-4, 4], [-3], [-4], 0),
            case('退化：没有任何轨迹点', [], [], [], [0, 5], [0, 5], 3),
            case('退化：没有任何 POI', [1], [0], [0], [], [], 5),
            case('坐标接近 int 边界：先升 long 再相减',
                 [1, 2], [2_000_000_000, 0], [0, 0], [-2_000_000_000, 0], [0, 0], 3,
                 note='int 相减溢出会让 (2e9,0) 意外"命中"原点附近'),
            case('非法：k 为负', [1], [0], [0], [0], [0], -1, throws=True),
            case('非法：轨迹三根数组长度不一致', [1, 2], [0], [0, 0], [0], [0], 1, throws=True),
            case('非法：POI 两根数组长度不一致', [1], [0], [0], [0, 1], [0], 1, throws=True),
            case('非法：trajId 为 0', [0], [0], [0], [0], [0], 1,
                 throws=True, note='0 不是"第 0 条轨迹"，是没赋值 —— 收下它会造出一条不存在的轨迹'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] distinctTrajsPerPoi(int[] trajId, int[] cellQ, int[] cellR, '
                             'int[] poiQ, int[] poiR, int k)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== 联系人发现的防枚举响应
@draft('alg-apple-contact-discovery')
def q_contact_discovery():
    """expected 全部由 probe() 算出：拒绝路径与未命中路径必须产出**同一个**数组。"""

    def probe(candidates, known, batch_limit, quota_left, attestation_ok, repeat_score, step_up):
        if candidates is None or known is None:
            raise ValueError('null set')
        for v in candidates:
            if v < 0:
                raise ValueError('negative candidate hash')
        for v in known:
            if v < 0:
                raise ValueError('negative known hash')
        if batch_limit <= 0:
            raise ValueError('batchLimit must be positive')
        if quota_left < 0 or repeat_score < 0 or step_up < 0:
            raise ValueError('negative counter')
        authorized = (attestation_ok and len(candidates) <= batch_limit
                      and quota_left > 0 and repeat_score <= step_up)
        if not authorized:
            return [0] * len(candidates)        # 与"谁都没匹配上"**完全一样**
        seen = set(known)
        return [1 if c in seen else 0 for c in candidates]

    def case(name, candidates, known, batch_limit, quota_left, attestation, score, step_up,
             throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 的同名注释）。"""
        try:
            got = probe(candidates, known, batch_limit, quota_left, attestation, score, step_up)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name,
                       'input': [candidates, known, batch_limit, quota_left, attestation, score, step_up],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name,
                       'input': [candidates, known, batch_limit, quota_left, attestation, score, step_up],
                       'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

"我是否在你的通讯录里"是联系人发现的原语（PSI / OPRPIR 类）。
它的危险不在密码学部分，而在**服务层响应**：只要"被拒绝"与"没匹配上"这两种情况
在响应里可区分，攻击者就得到一个**二值预言机** —— 逐条提交、观察差异，
就能把服务端集合枚举出来。2025 年公开披露的那类联系人发现缺陷正是这个形状。

本题只考这一层：**让所有拒绝路径与"零命中"不可区分**，同时仍然把非法输入炸出来。

## 你要实现的入口

```java
public static int[] probe(int[] candidates, int[] known, int batchLimit, int quotaLeft,
                          boolean attestationOk, int repeatScore, int stepUpThreshold)
```

- `candidates`：本次批量提交的哈希（顺序有意义，位置要一一对应）；
- `known`：服务端持有的哈希集合；
- 其余四个是策略参数：单批上限、本次调用后剩余的请求配额、设备证明是否通过、
  该调用方的"重复探测分数"与它的 step-up 阈值。

## 授权判定

请求**被授权**当且仅当四条同时成立：

```
attestationOk
&& candidates.length <= batchLimit
&& quotaLeft > 0
&& repeatScore <= stepUpThreshold
```

## 输出规则（判分点全部在这里）

1. 被授权 ⇒ 返回长度等于 `candidates.length` 的数组，第 `i` 项 = `candidates[i]` 是否在 `known` 里
   （`1` / `0`）。`candidates` 里出现重复值时，各位置**独立**判定。
2. **未被授权 ⇒ 返回长度仍然等于 `candidates.length` 的全 `0` 数组。**
   不抛异常、不返回 `null`、不返回更短或更长的数组、不用 `-1`/`2` 这类状态码区分拒绝原因。
   也就是说：超批量、无 attestation、配额耗尽、探测分数超阈、以及"确实谁都没匹配上"
   这五种情况，在调用方看到的响应里必须是**同一个东西**。
3. 数组要**保持输入顺序**（不许排序、不许去重后返回、不许只返回命中的下标）。
   返回"命中下标列表"是最糟的一种泄漏 —— 长度本身就是命中数。
4. `candidates` 为空数组 ⇒ 返回长度为 0 的数组（这是正常情况，不是非法输入）。

## 非法输入（抛 `IllegalArgumentException`）

这些是**协议错误**而不是策略拒绝，所以允许炸（调用方写错了代码，不该伪装成"没匹配上"）：
`candidates` 或 `known` 为 `null`；任一元素为负数；`batchLimit <= 0`；
`quotaLeft < 0`、`repeatScore < 0`、`stepUpThreshold < 0`。

不许引入第三方依赖。"""

    reference = """import java.util.HashSet;
import java.util.Set;

public class Solution {
  public static int[] probe(int[] candidates, int[] known, int batchLimit, int quotaLeft,
                            boolean attestationOk, int repeatScore, int stepUpThreshold) {
    if (candidates == null || known == null) throw new IllegalArgumentException("null set");
    for (int v : candidates) {
      if (v < 0) throw new IllegalArgumentException("negative candidate hash");
    }
    for (int v : known) {
      if (v < 0) throw new IllegalArgumentException("negative known hash");
    }
    if (batchLimit <= 0) throw new IllegalArgumentException("batchLimit must be positive");
    if (quotaLeft < 0 || repeatScore < 0 || stepUpThreshold < 0) {
      throw new IllegalArgumentException("negative counter");
    }

    // 先算授权、再碰数据：拒绝路径上一个 known 元素都不读，
    // 否则"读多少东西"本身又成了一条时延侧信道。
    boolean authorized = attestationOk
        && candidates.length <= batchLimit
        && quotaLeft > 0
        && repeatScore <= stepUpThreshold;

    int[] out = new int[candidates.length];      // 长度只由调用方自己的输入决定 ⇒ 不泄漏服务端状态
    if (!authorized) {
      return out;                                 // 全 0 —— 与"零命中"逐字节相同
    }
    Set<Integer> seen = new HashSet<>();
    for (int v : known) {
      seen.add(v);
    }
    for (int i = 0; i < candidates.length; i++) {
      out[i] = seen.contains(candidates[i]) ? 1 : 0;
    }
    return out;
  }
}"""

    naive = """import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.HashSet;

public class Solution {
  // "每种拒绝都给一个码"版：功能齐全，但把预言机交回给了调用方
  public static int[] probe(int[] candidates, int[] known, int batchLimit, int quotaLeft,
                            boolean attestationOk, int repeatScore, int stepUpThreshold) {
    if (candidates == null || known == null) throw new IllegalArgumentException("null set");
    for (int v : candidates) {
      if (v < 0) throw new IllegalArgumentException("negative candidate hash");
    }
    for (int v : known) {
      if (v < 0) throw new IllegalArgumentException("negative known hash");
    }
    if (batchLimit <= 0) throw new IllegalArgumentException("batchLimit must be positive");
    if (quotaLeft < 0 || repeatScore < 0 || stepUpThreshold < 0) {
      throw new IllegalArgumentException("negative counter");
    }
    if (!attestationOk) {
      return new int[] {-1};                      // 泄漏点 1：不同的拒绝给不同的形状
    }
    if (candidates.length > batchLimit) {
      return new int[] {-2};                      // 泄漏点 2：还能反推 batchLimit
    }
    if (quotaLeft <= 0) {
      return new int[] {-3};
    }
    if (repeatScore > stepUpThreshold) {
      return new int[] {-4};
    }
    Set<Integer> seen = new HashSet<>();
    for (int v : known) {
      seen.add(v);
    }
    List<Integer> hits = new ArrayList<>();
    for (int v : candidates) {
      if (seen.contains(v)) {
        hits.add(v);                              // 泄漏点 3：长度就是命中数
      }
    }
    int[] out = new int[hits.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = hits.get(i);
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

**先算授权、再碰数据**：`authorized` 只依赖调用方自己提供的量
（`candidates.length`、四个策略参数）与 `attestationOk`，判定为假就直接返回
`new int[candidates.length]`（Java 天然全 0），**连 `known` 都不遍历**。
合法路径才建 `HashSet` 逐位比对。

**为什么长度可以保留而内容必须归零**：返回长度由 `candidates.length` 决定，
而那是调用方自己选的 —— 长度里不含任何服务端状态。
反过来，任何"拒绝时返回更短/更长/不同形状"的做法，都会把服务端的一个布尔量
（是否超配额、分数是否超阈）映射成一次可观测的差异，
攻击者用一次提交就能读一个比特。枚举一个 N 元素的集合只需要 `log`与常数次这类读取，
所以**一次可区分的拒绝就等于开了一个口子**。

**三种典型泄漏形态，对应三种常见写法**：
1. 用错误码区分拒绝原因（`-1`/`-2`/`-3`）—— 最直接，等于自带枚举协议；
2. 返回**命中项列表**而不是等长掩码 —— 数组长度就是命中数，
   一次请求就能二分定位"这一条命中没有"；
3. 拒绝时干脆抛异常 —— 异常在网关侧通常变成 5xx 与不同的响应体与耗时，
   与 200 空结果一眼可分。

**为什么非法输入反而允许抛错**（题面 §非法输入）：
`null`、负哈希、`batchLimit <= 0` 这些是**调用方写错代码**，
不是"策略拒绝了个好请求"。把它们也伪装成"没匹配上"会让人 debug 到死，
而且它们与"某条 candidate 是否命中"没有任何关系 —— 不携带集合信息，所以不构成预言机。
判据是：**这个差异是否由用户提交的内容决定**。由内容决定的差异必须统一，
由代码错误决定的差异应该响。

**统一化之后还剩什么洞**（这是这题真正的延伸，面试必答）：
1. **时延**：命中路径要遍历 `known` 建集合、拒绝路径直接返回 —— 两者耗时差一个量级。
   缓解：授权与否都走同样的工作量（对 `known` 做定长扫描或用预建的 Bloom/字典，
   或对拒绝路径补一段固定 sleep —— 后者脆，容易被 GPU/负载差异打穿）。
2. **计数侧信道**：即使内容不可区分，"这个账号一天发了多少请求"在
   服务端的指标/日志里是存在的，只要**攻击者看不到**就安全 ——
   所以真正要保证的是"风控侧的可见性"与"调用方的可见性"是两套通道，
   绝不能为了给用户"申诉依据"而把前者透出（申诉只说"需要进一步验证"）。
3. **配额信号本身**：把 `quotaLeft` 变成不可见之后，合法的厚用户会困惑
   "为什么我搜了半天没人在线"。产品出路是**账号级**的配额提示
   （"今日查询次数已用完"，与具体查询内容无关），而不是每次查询响应里的一个比特。

**工程延伸（面试追问点）**

1. 慢速分布式枚举怎么防？（单账号限流挡不住"一万个账号每人查 20 次"。
   要有**批次指纹**维度的重复分数（同一 `batchHash` 反复出现就是探测），
   以及跨账号的聚合检测 —— 这就是 `repeatScore` 的由来。）
2. PSI 那一层还要不要？（要。服务层统一化只是关掉侧信道，
   密码学求交解决的是"服务端不该看到我没提交过什么"。两者是正交的两层，
   缺了前者实现再有密码学也是漏的。）
3. step-up 该长什么样？（它必须是一个**与内容无关**的、对所有人一致的升级流程
   （二次确认、延迟放行），而不是"你这条被怀疑了"。否则 step-up 自己就成了预言机。）
4. 审计怎么记才有用又不泄漏？（记 `callerId + batchDigest + 决策 + 剩余配额档位`，
   **不记**明文哈希 —— 否则审计日志本身变成一份"谁查了谁"的集合，
   而这正是隐私需求要防的东西。）"""

    return base(
        'algorithms', 'senior',
        '联系人发现的防枚举：所有拒绝路径与"零命中"返回同一个数组',
        statement, 'java-junit',
        ['anti-enumeration', 'psi', 'side-channel', 'response-uniformity',
         'modern:privacy-engineering'],
        src('隐私敏感服务 / iCloud 服务端 高级工程师',
            'content/knowledge/hot-interviews/apple-privacy-and-edge-cloud.md §1.3 与 §4 题面草稿 A'
            '（素材给了"求交本身即攻击面"与六条断言，未砍成可判分的纯函数契约）'),
        language='java',
        cases=[
            case('正常命中：逐位掩码、顺序保持',
                 [11, 22, 33], [33, 11, 99], 500, 10, True, 0, 5,
                 note='[1,0,1] —— 22 不在服务端集合里'),
            case('谁都没匹配上：与四种拒绝完全同形',
                 [7, 8], [1, 2, 3], 500, 10, True, 0, 5,
                 note='[0,0] —— 和下面四条拒绝的期望值一模一样，这正是本题要的东西'),
            case('超批量：全 0 而不是抛错或短数组',
                 [1, 2, 3, 4, 5], [1, 2], 4, 10, True, 0, 5,
                 note='泄漏点：返回 -2 或更短数组的实现等于把 batchLimit 交给调用方反推'),
            case('没有 attestation：全 0',
                 [1, 2, 3], [1, 2, 3], 500, 10, False, 0, 5,
                 note='即使三条全在服务端集合里，也只能返回 [0,0,0]'),
            case('配额耗尽：全 0',
                 [1, 2, 3], [1, 2, 3], 500, 0, True, 0, 5),
            case('探测分数超阈：需要 step-up，但响应不区分',
                 [1, 2, 3], [1, 2, 3], 500, 10, True, 6, 5,
                 note='repeatScore 6 > 阈值 5 ⇒ 与零命中同形；step-up 走带外流程'),
            case('恰好等于阈值与恰好等于批量上限都算通过',
                 [1, 2, 3], [2], 3, 1, True, 5, 5,
                 note='边界都是闭的：<= batchLimit、quotaLeft > 0、repeatScore <= stepUpThreshold'),
            case('重复提交同一个哈希：各位置独立判定',
                 [42, 42, 7], [42], 500, 3, True, 0, 5,
                 note='[1,1,0] —— 去重后返回就丢了调用方的位置信息，那是另一个 bug'),
            case('退化：提交了空批次',
                 [], [1, 2], 500, 3, True, 0, 5,
                 note='长度为 0 的数组，不是 null 也不是异常'),
            case('退化：服务端集合为空',
                 [1, 2], [], 500, 3, True, 0, 5),
            case('非法：candidates 为 null', None, [1], 500, 3, True, 0, 5, throws=True),
            case('非法：known 里有负数', [1, 2], [-1], 500, 3, True, 0, 5, throws=True),
            case('非法：batchLimit 为 0', [1], [1], 0, 3, True, 0, 5, throws=True),
            case('非法：配额为负', [1], [1], 500, -1, True, 0, 5, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] probe(int[] candidates, int[] known, int batchLimit, '
                             'int quotaLeft, boolean attestationOk, int repeatScore, '
                             'int stepUpThreshold)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


# =================================================================== 端云协同的隐私架构评审（主观题）
@draft('sys-apple-cross-device-search')
def q_cross_device_search():
    statement = """## 场景

**你正在面试 Apple 的 Senior Software Engineer（iCloud / Privacy-sensitive Services），45 分钟**

新功能"跨设备智能搜索"：用户对自己的照片、备忘录、文件做自然语言查询
（"去年在海边那张有狗的照片"）。硬约束：

1. 用户内容不得以可读形式离开设备，除非用户显式同意且进入**受证明的隔离云环境**；
2. 服务端不得持有可解密用户内容的长期密钥；
3. 索引构建要能在低电量/离线场景下进行，且不能把设备拖到发烫；
4. 端上索引命中时查询 p95 < 800ms，否则回退云端；
5. 必须支持"账户恢复"与"设备撤销"后旧设备不可再访问。

## 你要给出的设计

1. **端云分工**：索引放哪、模型放哪、查询在哪执行。给出"默认在哪"以及为什么。
2. **密钥与信任边界**：谁持有什么、什么情况下内容会明文出现在哪个位置。
   比较"云端只做不可逆/密文检索"与"隔离环境内明文处理"两条路线的攻防差异，并说明选哪条。
3. **回退策略及其隐私代价**：什么条件触发云端、用户被如何告知、
   哪些查询**宁可不回答**（给判定规则，不给口号）。
4. **性能与电量预算**：索引构建的分片/增量策略、失败恢复、
   以及"设备永远不空闲"时怎么办。
5. **账户恢复与设备撤销的安全模型**：恢复流程不能变成后门，
   撤销之后"云端残留"怎么处理、怎么向用户证明。
6. **可观测性**：作为平台方，你要监控搜索质量与故障，但不得泄露用户内容。
   给出允许采集的字段清单与禁止清单，并说明"零知识"与"可运营"怎么同时成立。
7. 你会**故意不实现**的一项能力（哪怕产品要求），说明理由。"""

    return base(
        'system-design', 'senior',
        '跨设备智能搜索：默认端上执行、回退的隐私代价、以及宁可不回答的查询',
        statement, 'llm-rubric',
        ['on-device-ai', 'key-management', 'private-cloud', 'fallback-policy',
         'revocation', 'modern:privacy-engineering'],
        src('iCloud / Privacy-sensitive Services 高级工程师',
            'content/knowledge/hot-interviews/apple-privacy-and-edge-cloud.md §4 题面草稿 B'
            '（素材给出现成的五约束题面与加分点清单，未做成可判分的评分标准）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '默认端上执行且回退条件明确', 'weight': 2,
                 'criteria': '是否把"端上 embedding/索引 + 端上检索 + 端上重排"设为默认路径，'
                             '并给出可判定的回退触发（端上索引未建完、跨设备内容需云端索引、'
                             'p95 预估超预算、机型/内存不足），'
                             '而不是"端上做不动了就上云"。'
                             '加分：指出回退本身是隐私状态变化，必须显式提示并记录用户同意。'},
                {'label': '密钥模型与两条路线的攻防比较', 'weight': 2,
                 'criteria': '是否说清内容密钥由设备持有、云端只存密文或不可逆派生物，'
                             '并**比较**两条路线：'
                             '"密文/不可逆索引检索"攻击面小但召回与表达力受限'
                             '（无法做语义重排、易被已知明文攻击映射词汇），'
                             '"受证明隔离环境内明文处理"表达力强但把信任转移到'
                             '硬件证明与软件透明度审计上，'
                             '要谈镜像可验证、供应链、以及"证明失败时降级到哪"。'
                             '只复述"端到端加密"而不比较的，此项最多 1 分。'},
                {'label': '"宁可不回答"给出可执行判定规则', 'weight': 2,
                 'criteria': '是否给出具体类别与判定依据（涉未成年人、他人生物特征/身份、'
                             '健康与性相关、涉及设备外的第三方可识别信息、'
                             '可被用于跨用户关联的查询模式），'
                             '并说明在**哪一层**拦（端上查询理解阶段就拒，'
                             '而不是把查询送到云端再过滤）、拒绝时返回什么'
                             '（不能返回"因为命中第 X 条规则"——那是可逼近的边界）。'
                             '空喊"遵守隐私原则"不得分。'},
                {'label': '索引构建的电量与增量策略', 'weight': 1,
                 'criteria': '是否给出分片与增量（只处理新内容/变化内容）、'
                             '低电量与充电且闲置时才做大批量、'
                             '可中断可续建（checkpoint + 幂等）、'
                             '多设备间谁是索引权威、以及"设备永远不空闲"时的兜底'
                             '（接受索引长期不完整并在结果里标注覆盖范围，'
                             '而不是偷偷上云）。'},
                {'label': '恢复与撤销不变成后门', 'weight': 1,
                 'criteria': '恢复：可信联系人/延迟等待/强度分级三选二以上的组合，'
                             '并说明为什么单纯短信验证码不够（SIM 交换）。'
                             '撤销：旧设备密钥不可达如何保证（信封轮换/密钥剥离）、'
                             '云端残留密文的处置与**可证明性**（透明日志、删除回执），'
                             '以及恢复后新设备如何重建访问而不需要平台曾持有明文密钥。'},
                {'label': '可观测性与"故意不做"', 'weight': 2,
                 'criteria': '允许采集：查询**长度/是否返回结果/耗时/是否回退/命中设备数**等'
                             '与内容无关的运营量，或经差分隐私加噪后的聚合词频；'
                             '禁止：查询原文、结果标题、文件路径、可逆哈希与用户 id 的绑定表。'
                             '必须回答"零知识与可运营怎么同时成立"：'
                             '质量指标改由设备侧计算并以上报聚合值/DP 直方图方式回传。'
                             '"故意不做"要给出具体一项及代价'
                             '（例如不做"跨用户热门搜索联想"，因为它必然把个人查询汇入全局集合）。'},
            ],
            'notes': '总分封顶 5 的情形：把"云端索引"当默认架构再补一句加密；'
                     '声称"服务端完全看不到内容"却又让云端做语义重排；'
                     '用"加个开关让用户选"回避默认值判断；'
                     '恢复流程只有"邮箱验证码"；'
                     '可观测性答"只看指标不看内容"而没有处理"质量指标本身需要内容"这个矛盾。',
        },
        estimatedMinutes=45,
        answer="""## 参考答案要点

**默认端上**：查询理解、检索、重排都在设备内完成 —— 因为服务端一旦拿到查询文本，
"不知道用户在找什么"这个承诺就没了，而这正是这类产品最值钱的部分。
云端只承担"跨设备内容的密文/派生索引检索"这种端上做不了的部分，且每次触发都是**隐私状态变化**，
要显式提示、可关、并记入用户的隐私面板。

**两条路线的比较（这题的分水岭）**：
- *密文/不可逆派生检索*：云端拿到的是向量或 token 的派生值。优点是服务端不持明文能力，
  攻破它需要拿到设备密钥；缺点是表达力受限 —— 向量检索可被"嵌入反演"部分还原语义、
  词表类派生值在已知明文攻击下可映射，且没法做需要原文的重排。
- *受证明隔离环境内明文处理*：能给出接近端上的效果，代价是把信任从密码学转移到
  "运行的是被审计的那份代码"这个可验证声明上（镜像度量、透明日志、外部审计、可复现构建），
  并且必须定义**证明失败时的降级路径**（回到端上/回到低召回），否则整套系统在
  证明服务抖动那天就悄悄把明文泄给了不可信环境。
  选哪条不重要，说不清"我们把信任放在了哪里"才是问题。

**宁可不回答的判定规则**：拦在**端上的查询理解阶段**（此时查询还没离开设备，
拒绝不会形成任何网络侧信道），规则按"是否涉及他人可识别信息 / 是否涉及敏感属性推断 /
是否可被用于跨用户关联"三类给；拒绝时的响应必须与"没找到"同形 ——
这与联系人发现那道题是同一个原理（不给可逼近的边界）。

**索引构建**：增量以"新增/变更资产"为单位、大批量只在充电 + 闲置 + 非蜂窝时做、
checkpoint 幂等可续；必须正面回答"设备永远不空闲"：接受索引长期不完整并在结果里标注
覆盖范围（这比偷偷上云诚实），或提供显式的"用云端加速索引"选项。

**恢复与撤销**：恢复要按强度分级（可信联系人 / 延迟等待 / 更强本地证明）组合，
因为单一验证码在 SIM 交换面前等于没有；撤销要能证明"旧设备拿不到新信封"——
密钥轮换 + 服务端只存密文与派生物，删除能力来自"平台从来没拿到明文密钥"而不是"删了记录"。

**零知识与可运营的和解**：质量指标里凡是需要"看内容"才知道的（相关性、误召回），
改由**设备上计算**后只上报聚合/加噪结果（DP 直方图、采样后的打分对），
于是平台侧看到的全是与个体无关的量。这不是"少采一点"，而是**把计算搬到可信一侧**。

**故意不做**：跨用户"热门搜索联想"——它必然把个体查询汇入全局集合，
是这类产品最容易被动泄漏的通道，而它的产品收益可以用"同设备历史查询补全"替代。"""
    )


# =================================================================== 事件治理规范与 CI 卡口（主观题）
@draft('hot-apple-event-governance')
def q_event_governance():
    statement = """## 场景

**你正在面试 Apple 的数据平台工程师（Telemetry / Event Governance），40 分钟**

一条设备侧事件流水，日均 900 亿行，写入方是几十个团队、上百个 App 版本、
以及"永远有用户不升级"的长尾老 SDK。已经发生的三类事故：

- **A**：某字段单位从 MB 改成 GB，没有改字段名，下游看板静默 ×1024 持续 11 天才被发现。
- **B**：新增一个 `NOT NULL` 字段，历史分区读取失败，昨天的数据"突然查不出来"。
- **C**：同一个用户行为被两个团队各自埋了一条事件，指标对不上，两边都认为对方错。

现状：规范写在 wiki 里、评审靠人、没有任何机器卡口。

## 你要给出的答案

1. 逐条给出事故的**根因层次**（协议层 / 语义层 / 组织层），并说明为什么
   "加评审"这一类做法对这三条里的某一条必然无效。
2. 设计一份**事件注册表**：存什么、谁是权威、版本与生效区间怎么表达、
   单位/时区/枚举语义放在哪一层。
3. 给出**三条可以写成机器卡口**的硬规范（必须具体到"在哪个环节、拦什么、
   违反时的动作"），并说明每条各自挡住 A/B/C 中的哪一条。
4. 摄取层怎么同时服务"新旧版本 SDK 共存十年"这个现实？
   路由、归一化、以及"归一化失败的数据去哪"（不许丢、也不许污染正表）。
5. 重复埋点（事故 C）怎么在**制度与技术**两侧同时收口？
   给出你会引入的唯一标识与语义去重的判定规则，并承认它的代价。
6. 你怎么度量"治理本身有效"？给 2~3 个指标，且必须有一个是**会导致团队反感**的那种。"""

    return base(
        'hot-interviews', 'senior',
        '事件治理：注册表、三条机器卡口、版本共存十年的摄取层',
        statement, 'llm-rubric',
        ['event-governance', 'schema-registry', 'ci-gate', 'data-quality',
         'modern:data-contract'],
        src('数据平台 / 遥测管道 高级工程师',
            'content/knowledge/hot-interviews/apple-telemetry-pipelines.md §1.2、§2.4、§3 的加分点 10'
            '（素材给出"三条硬规范可执行且能 CI 拦截"的要求本身，未给具体条目与判分口径）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '根因分层并承认评审的边界', 'weight': 2,
                 'criteria': 'A 是**语义层**（单位没进类型系统，人评审不出 ×1024）、'
                             'B 是**协议层**（兼容性规则没被机器执行）、'
                             'C 是**组织层**（两个团队各有权威且无人对齐语义）。'
                             '必须明确指出：靠加评审对 A、C 必然无效 —— '
                             'A 的错在"看起来完全合理的改动"，C 的错在两个评审各自通过。'
                             '把三条都归因"流程不严"的此项最多 1 分。'},
                {'label': '注册表的字段与权威', 'weight': 2,
                 'criteria': '是否包含：事件/字段的语义（单位、时区、精度、枚举集合及含义）、'
                             '生效区间（版本 + 时间，不是 only-latest）、'
                             '负责人与下游消费方、兼容性检查结论、'
                             '以及**谁是权威**（注册表 vs 代码里的 schema，二者必须单向生成）。'
                             '加分：指出"单位与枚举语义必须参与类型比较"，'
                             '否则注册表退化成文档。'},
                {'label': '三条能落地成卡口的硬规范', 'weight': 3,
                 'criteria': '每条必须具体到 **环节 + 拦截内容 + 违反时动作**，例如：'
                             '① SDK 发布前：事件必须带 `event_id + schema_version + unit`，'
                             '与注册表不符 ⇒ **构建失败**（挡 A/B）；'
                             '② 网关摄取：未注册或语义校验不过的 payload ⇒ 拒收进隔离区并告警，'
                             '不写正表（挡 B 的"历史读不出来"与脏数据扩散）；'
                             '③ CI：新增字段必须通过兼容性检查（NOT NULL 必须有默认值、'
                             '禁止类型/单位收窄）⇒ 不通过不许合并（挡 B）；'
                             '④ 语义重复检测：新事件注册时必须与既有事件做语义比对'
                             '（同名/近名 + 字段集合重合度 + 负责人不同 ⇒ 需显式仲裁）（挡 C）。'
                             '答"制定规范并加强培训"整项不得分。'},
                {'label': '版本共存十年的摄取层', 'weight': 1,
                 'criteria': '是否按 `schema_version` 路由 + 归一化到当前语义'
                             '（改名/换单位/双上报各有规则），'
                             '并明确"归一化失败"的出路：**旁路隔离表 + 保留原始 payload + 可重放**'
                             '（重放能力意味着格式演进可以事后修，这是长尾版本的唯一解）。'
                             '同时要说清"按旧语义解释新数据"和"按新语义解释旧数据"都会错，'
                             '错的方向不同。'},
                {'label': '重复埋点的唯一标识与代价', 'weight': 1,
                 'criteria': '是否给出语义主键（如 `event_kind + 触发时机 + 度量对象`）'
                             '与去重判定规则，并**承认代价**：'
                             '要么有一个仲裁角色（ slows 团队）、要么允许并存但强制标注"等价事件映射表"'
                             '让下游只查一处。只说"统一口径"而无仲裁机制的不得分。'},
                {'label': '治理有效的指标里有一个让人反感', 'weight': 1,
                 'criteria': '指标必须可量化且**指向自己有没有用**，例如：'
                             '未注册事件的拒收率趋势、语义漂移检测命中数、'
                             '跨团队指标对账差异率、**每个团队的"规范违规被拦次数"**（这是招人反感的那个：'
                             '它把治理成本摊到写方头上，也暴露平台在制造摩擦）。'
                             '只报"数据质量分数 99.9%"这种自证指标的此项减半。'},
            ],
            'notes': '总分封顶 5 的情形：把治理答成"上一套数据目录/元数据平台"；'
                     '三条规范里没有任何一条有"违反时动作"；'
                     '对事故 C 的解法是"拉个会统一口径"；'
                     '声称归一化失败可以丢（900 亿行的长尾恰恰最需要可重放）。',
        },
        estimatedMinutes=40,
        answer="""## 参考答案要点

**三条事故在不同层**：A 是语义层（单位不是类型，人眼评审不出 ×1024，
而且改动本身"看起来完全合理"）；B 是协议层（兼容性检查是纯机械的，
人来做反而漏 —— 恰恰因为它是三条里最"该被记住"的一条）；
C 是组织层（两个团队各自的评审都会通过自己那一版，问题不在单个评审的质量，
而在于**没有任何一个环节同时看到两边**）。
所以"加评审"对 A、C 无效：A 需要机器比类型，C 需要一个共同的仲裁点。

**注册表的要害是"它是权威还是文档"**：如果代码里还有一份 schema、注册表靠人同步，
它就退化成文档，事故会以同样的形状回来。正确形状是**单向生成**
（注册表 → SDK 的代码生成 / 或 SDK 注解 → 注册表，二选一且有 CI 校验一致性）。
单位、时区、枚举语义必须参与**类型比较**，否则"字段名相同"就等于"语义相同"。

**三条卡口的共同点：必须有"违反时动作"**。
"规范存在"不产生任何约束力；`构建失败` / `拒收进隔离区` / `PR 不许合并` 才是卡口。
其中最容易被忽略的是第④条（语义重复检测）—— 它不是技术问题而是制度问题，
但只有把它做成注册流程里的**必填比对**，C 才有解，
因为"新事件注册"是整条链路上唯一天然同时看到新旧两个定义的时点。

**版本共存十年的唯一解是可重放**：`schema_version` 路由 + 归一化能覆盖绝大多数情况，
但归一化规则本身会演进。所以摄取层要保留原始 payload 的旁路（冷存即可），
使得"三年前判错的归一化"今天能重跑。
丢掉它意味着：任何后来的理解修正都不可能，只能在新数据上继续凑合。
另外要说清两个方向的错："按旧语义解释新数据"是静默 ×1024，
"按新语义解释旧数据"是把历史趋势改平 —— 前者危险，后者隐蔽。

**让人反感的指标才有效**：`每个团队的规范违规被拦次数` 把治理成本摊回写方，
它是唯一能驱动行为改变的量；
其他像"数据质量分 99.9%"是平台的自证指标，团队不会因此改任何东西。
承认这一点很关键：治理的目标不是让大家觉得规范好，而是让违规变贵。

**故意留一处不做**：不做"自动语义等价判定后自动合并事件"——
自动判等会把仲裁责任从人身上拿走，而 C 的根因正是无人对齐语义。
技术做**比对并阻断**，决定留给仲裁角色。"""
    )


# =================================================================== 回填要连带重跑的下游闭包
@draft('alg-apple-backfill-closure')
def q_backfill_closure():
    """重跑集合由 rerun_plan() 算出（Kahn + 队列按 id 取最小 ⇒ 拓扑序唯一确定）。"""

    def rerun_plan(task_count, dep_from, dep_to, changed):
        if task_count < 0:
            raise ValueError('taskCount must be >= 0')
        if len(dep_from) != len(dep_to):
            raise ValueError('edge arrays disagree')
        if len(changed) != task_count:
            raise ValueError('changed length must equal taskCount')
        if task_count == 0:
            if dep_from:
                raise ValueError('edges without tasks')
            return []
        seen_edges = set()
        children = [[] for _ in range(task_count)]
        indeg = [0] * task_count
        for f, t in zip(dep_from, dep_to):
            if not (0 <= f < task_count) or not (0 <= t < task_count):
                raise ValueError('edge endpoint out of range')
            if (f, t) in seen_edges:
                raise ValueError('duplicated edge')     # 重复边会把入度算重 ⇒ 看起来像环
            seen_edges.add((f, t))
            children[f].append(t)
            indeg[t] += 1
        for c in changed:
            if c not in (0, 1):
                raise ValueError('changed must be 0 or 1')

        ready = sorted(i for i in range(task_count) if indeg[i] == 0)
        order = []
        while ready:
            u = ready.pop(0)                            # 同一层取 id 最小 ⇒ 输出可复现
            order.append(u)
            for v in sorted(children[u]):
                indeg[v] -= 1
                if indeg[v] == 0:
                    ready.append(v)
            ready.sort()
        if len(order) != task_count:
            raise ValueError('cycle in dependencies')   # 环不能挂住调度器，必须响

        need = [bool(c) for c in changed]
        for u in order:                                 # 沿拓扑序传播 ⇒ 传递闭包
            if need[u]:
                for v in children[u]:
                    need[v] = True
        return [i for i in order if need[i]]

    def case(name, task_count, dep_from, dep_to, changed, throws=False, note=None):
        """`throws` 是声明不是推断（见 airbnb gen.py 的同名注释）。"""
        try:
            got = rerun_plan(task_count, dep_from, dep_to, changed)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [task_count, dep_from, dep_to, changed],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [task_count, dep_from, dep_to, changed], 'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

回填（backfill）事故的经典形状不是"跑失败了"，而是**跑成功了但下游没跟着跑**：
补了 ODS 层三天的分区，DWD/DWS 还在用旧输入，于是报表"看起来有数、其实是错的"。
调度器必须把"哪些任务要跟着重跑、按什么顺序"这件事算准 ——
它是 §13.3"幂等 · Catchup · Backfill"那一节真正的工程内容。

## 你要实现的入口

```java
public static int[] rerunPlan(int taskCount, int[] depFrom, int[] depTo, int[] changed)
```

- 任务 id 是 `0 .. taskCount-1`。
- `depFrom[i] -> depTo[i]` 表示 **`depTo[i]` 依赖 `depFrom[i]`**
  （即 `depFrom[i]` 必须先跑完）。
- `changed[j] == 1` 表示任务 j 的输入或自身逻辑变了，需要重跑。
- 返回**需要重跑的任务 id 列表，按拓扑序**；不需要重跑的任务不许出现。

## 规则（判分点）

1. 需要重跑集合是**传递闭包**：任务 j 需要重跑，当且仅当
   `changed[j] == 1`，**或 j 的任一个传递上游需要重跑**。
   只算直接下游会漏掉孙子层 —— 那是本题要打掉的头号错误。
2. 输出顺序必须是拓扑序（依赖者一定排在被依赖者之后）。
   拓扑序不唯一，所以本题**规定确定性规则**：
   **在"当前所有入度为 0 的可选任务"里，始终取 id 最小的那个。**
   不遵守这条的实现在同一份输入上可能给出不同顺序 ⇒ 无法做回归对比。
3. 依赖图必须无环。检出环 ⇒ 抛 `IllegalArgumentException`
   （**不能**返回一个"少几个任务"的结果：调度器拿到有环的图如果继续跑，
   结果是某些任务永远不会被调度，比直接报错危险得多）。
4. 非法输入同样抛 `IllegalArgumentException`：
   `taskCount < 0`；`depFrom` 与 `depTo` 长度不一致；`changed` 长度不等于 `taskCount`；
   边端点越界（不在 `0..taskCount-1`）；**重复的同一条边**；自环（`depFrom[i] == depTo[i]`）；
   `changed[i]` 不是 0 或 1；`taskCount == 0` 但给出了边。

不许引入第三方依赖。"""

    reference = """import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class Solution {
  public static int[] rerunPlan(int taskCount, int[] depFrom, int[] depTo, int[] changed) {
    if (taskCount < 0) throw new IllegalArgumentException("taskCount must be >= 0");
    if (depFrom.length != depTo.length) throw new IllegalArgumentException("edge arrays disagree");
    if (changed.length != taskCount) throw new IllegalArgumentException("changed length mismatch");
    if (taskCount == 0) {
      if (depFrom.length > 0) throw new IllegalArgumentException("edges without tasks");
      return new int[0];
    }

    List<List<Integer>> children = new ArrayList<>();
    for (int i = 0; i < taskCount; i++) {
      children.add(new ArrayList<>());
    }
    int[] indeg = new int[taskCount];
    Set<Long> seen = new HashSet<>();
    for (int i = 0; i < depFrom.length; i++) {
      int f = depFrom[i], t = depTo[i];
      if (f < 0 || f >= taskCount || t < 0 || t >= taskCount) {
        throw new IllegalArgumentException("edge endpoint out of range");
      }
      if (f == t) throw new IllegalArgumentException("self loop");
      if (!seen.add(((long) f << 32) | t)) {
        // 重复边会把入度算重，Kahn 会误判成环 —— 这是输入错误，不是环
        throw new IllegalArgumentException("duplicated edge");
      }
      children.get(f).add(t);
      indeg[t]++;
    }
    for (int c : changed) {
      if (c != 0 && c != 1) throw new IllegalArgumentException("changed must be 0 or 1");
    }

    List<Integer> order = new ArrayList<>();
    List<Integer> ready = new ArrayList<>();
    for (int i = 0; i < taskCount; i++) {
      if (indeg[i] == 0) ready.add(i);
    }
    Collections.sort(ready);                            // 同一层取 id 最小 ⇒ 确定性
    while (!ready.isEmpty()) {
      int u = ready.remove(0);
      order.add(u);
      Collections.sort(children.get(u));
      for (int v : children.get(u)) {
        if (--indeg[v] == 0) {
          ready.add(v);
        }
      }
      Collections.sort(ready);                          // 新解锁的任务也要按 id 归位
    }
    if (order.size() != taskCount) {
      throw new IllegalArgumentException("cycle in dependencies");
    }

    boolean[] need = new boolean[taskCount];
    for (int i = 0; i < taskCount; i++) {
      need[i] = changed[i] == 1;
    }
    for (int u : order) {                               // 沿拓扑序传播 ⇒ 传递闭包
      if (need[u]) {
        for (int v : children.get(u)) {
          need[v] = true;
        }
      }
    }
    int count = 0;
    for (int u : order) {
      if (need[u]) count++;
    }
    int[] out = new int[count];
    int at = 0;
    for (int u : order) {
      if (need[u]) out[at++] = u;
    }
    return out;
  }
}"""

    naive = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  // "回填只重跑改了的那层和它的直接下游"版
  public static int[] rerunPlan(int taskCount, int[] depFrom, int[] depTo, int[] changed) {
    if (taskCount < 0) throw new IllegalArgumentException("taskCount must be >= 0");
    if (depFrom.length != depTo.length) throw new IllegalArgumentException("edge arrays disagree");
    if (changed.length != taskCount) throw new IllegalArgumentException("changed length mismatch");
    boolean[] need = new boolean[taskCount];
    for (int i = 0; i < taskCount; i++) {
      need[i] = changed[i] == 1;
    }
    for (int i = 0; i < depFrom.length; i++) {
      if (need[depFrom[i]]) {
        need[depTo[i]] = true;                          // 错：只传一层
      }
    }
    List<Integer> out = new ArrayList<>();
    for (int i = 0; i < taskCount; i++) {
      if (need[i]) out.add(i);                          // 错：按 id 排而不是按拓扑序
    }
    return out.stream().mapToInt(Integer::intValue).toArray();
  }
}"""

    answer = """## 参考答案要点

三步：① 建 children 邻接表 + 入度表，顺手查端点越界、重复边、自环；
② Kahn 拓扑排序，**每次从"当前入度为 0"的集合里取 id 最小**（`ready` 始终保持有序）；
③ 沿拓扑序做一次前向传播 `need[v] |= need[u]`，最后按拓扑序过滤输出。

**"只算直接下游"是这题要打的错**（用例「深链：改最上游要一路带到叶子」）：
`0→1→2→3→4`，改 0。正确是 `[0,1,2,3,4]`；
只传一层的实现给 `[0,1]`，于是 2/3/4 用的是**旧输入的新数据**，
报表数字会稳定地错，而且**没有任何报错**。
这类事故在复盘里通常被写成"下游没有跟着回填" —— 但真正的根因是
调度器把"连带重跑"实现成了"一层"而不是"闭包"。

**输出必须是拓扑序，而拓扑序必须唯一**
（用例「菱形依赖：同一层按 id 最小取」）：
`0→1, 0→2, 1→3, 2→3`。合法拓扑序有 `[0,1,2,3]` 与 `[0,2,1,3]` 两种。
不锁死规则的实现，两次跑可能给不同顺序 ⇒ 回归测试无法比对、
且"重跑顺序"在真实调度里会影响能否尽早发现失败（同一层先跑哪个决定反馈速度）。
**确定性不是洁癖，是"这个输出可被断言"的前提。**

**重复边会被误判成环**：`0→1` 出现两次 ⇒ 入度变 2，Kahn 减一次就永远剩 1，
看起来"有环"。所以要么显式去重、要么显式报错 ——
本题选择报错，因为重复边说明调用方的边表生成有 bug，
静默去重会把那个 bug 藏起来。

**检出环必须响**（用例「环：必须抛错而不是返回一个短一点的计划」）：
返回"少了几个任务"的计划是**能跑起来的错计划**：那几个任务永远不会被调度，
回填静默完成，数据永远缺一段。
调度器宁可失败一次让人来看，也不要"成功地什么都没做"。

**工程延伸（面试追问点）**

1. 真实调度器怎么避免全图重算？（增量传播：从 changed 集合做 BFS，
   而不是先全图拓扑再传播；并且依赖图会缓存版本。
   但闭包语义必须一致 —— 差一层就是差一个静默事故。）
2. 传递闭包很大时（改一张公共底表）怎么办？（这正是要**分级审批**的场景：
   影响面超过阈值（下游任务数/涉及分区量/是否触及对外报表）就阻断并要求确认，
   而不是让一个误操作把 500 个任务重跑一遍。
   影响面分析本身就是血缘系统的第一个产品能力。）
3. 回填窗口（只补三天）怎么和闭包结合？（闭包算"重跑哪些任务"，
   窗口算"每个任务重跑哪些分区"。两者要分别算：**下游若按分区别名重跑，
   就必须保证被重跑的上游分区覆盖了下游的输入窗口**，
   否则下游的三天会引用上游的旧三天 —— 于是"闭包对了、数据还是错的"。
   这条是 §13.2 里"用 data interval 定分区而不是用 now()"的另一个后果。）
4. 幂等在这一层里扮演什么角色？（闭包决定"跑哪些"，幂等决定"重复跑会不会坏"。
   两者缺一：只有闭包没有幂等 ⇒ 不敢重试；只有幂等没有闭包 ⇒ 漏跑下游，
   而漏跑是**不会自愈**的，重试也不会补上没被调度的任务。）"""

    return base(
        'algorithms', 'senior',
        '回填重跑闭包：只算一层下游会静默留下旧数据，拓扑序还必须唯一',
        statement, 'java-junit',
        ['backfill', 'dependency-graph', 'transitive-closure', 'topological-order',
         'modern:data-ops'],
        src('数据平台 / 调度与编排 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §13.3"幂等 · Catchup · Backfill"与 §13.2 data interval'
            '（手册点出"回填要按依赖子图重跑 + 幂等"，未给可判分的闭包语义与确定性顺序）'),
        language='java',
        cases=[
            case('深链：改最上游要一路带到叶子',
                 5, [0, 1, 2, 3], [1, 2, 3, 4], [1, 0, 0, 0, 0],
                 note='只传一层的实现给 [0,1] —— 2/3/4 会拿着旧输入继续跑'),
            case('菱形依赖：同一层按 id 最小取',
                 4, [0, 0, 1, 2], [1, 2, 3, 3], [1, 0, 0, 0],
                 note='合法拓扑序有两种，本题规定 [0,1,2,3]'),
            case('只改叶子：没有下游就只有它自己',
                 4, [0, 1, 2], [1, 2, 3], [0, 0, 0, 1]),
            case('两条独立管道：改一条的中游不波及另一条',
                 6, [0, 1, 3, 4], [1, 2, 4, 5], [0, 1, 0, 0, 0, 0]),
            case('没有依赖边：改了两个任务，按 id 升序',
                 4, [], [], [0, 1, 0, 1]),
            case('宽扇出：一张公共底表被五个任务依赖',
                 6, [0, 0, 0, 0, 0], [1, 2, 3, 4, 5], [1, 0, 0, 0, 0, 0]),
            case('环：必须抛错而不是返回一个短一点的计划',
                 3, [0, 1, 2], [1, 2, 0], [1, 0, 0], throws=True,
                 note='返回"少了几个任务"的计划是能跑起来的错计划 —— 那几个任务永远不会被调度'),
            case('自环', 2, [0], [0], [1, 0], throws=True),
            case('重复边会被误判成环：必须先拒掉',
                 2, [0, 0], [1, 1], [1, 0], throws=True),
            case('退化：没有任何任务', 0, [], [], [],
                 note='没有任务也没有边 ⇒ 空计划'),
            case('退化：没有任何改动', 3, [0, 1], [1, 2], [0, 0, 0]),
            case('非法：边端点越界', 2, [0], [2], [1, 0], throws=True),
            case('非法：depFrom 与 depTo 长度不一致', 3, [0, 1], [1], [1, 0, 0], throws=True),
            case('非法：changed 长度不等于 taskCount', 3, [0], [1], [1, 0], throws=True),
            case('非法：changed 里有 2', 2, [0], [1], [2, 0], throws=True),
            case('非法：taskCount 为 0 却给了边', 0, [0], [1], [], throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] rerunPlan(int taskCount, int[] depFrom, int[] depTo, int[] changed)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== 两道主观题：账户恢复与 SDK 灰度
@draft('sys-apple-account-recovery')
def q_account_recovery():
    statement = """## 场景

**你正在面试 Apple 的 Senior Software Engineer（iCloud 身份与账户），45 分钟**

端到端加密的账户体系里，"用户忘记密码"是唯一能绕过所有密码学保证的路径：
恢复流程本质上就是"设计一个后门，但让它比攻击面更难被突破"。

已知事实与事故：
- 现有恢复手段只有：注册邮箱验证码 + 安全问题；
- 上季度 4 起"SIM 交换后账户被接管"，其中 3 起在接管后**旧设备没有被撤销**，
  攻击者能继续读历史端到端加密数据；
- 撤销过的设备仍能在云端残留密文里被解密读取（因为密钥信封没换）；
- 客服工单是最大的一条攻击入口：攻击者用社交工程让客服"手动重置"；
- 高价值用户（记者、高管）占被接管账户的 80%。

## 你要回答的问题

1. 为什么"邮箱验证码 + 安全问题"在结构上就是错的？请指出它把信任放在了哪个不可信信道上。
2. 给出你的恢复机制组合：至少三种手段，说明各自适用场景与**强度分级**规则
   （什么时候允许快、什么时候必须慢）。
3. "延迟等待"是恢复流程里最有效的控制之一，但它伤体验。
   给出你的延迟策略设计：延迟期内用户能做什么、不能做什么，以及如何避免它变成纯摩擦。
4. 恢复成功之后必须发生什么？请给出**最小动作集**，
   并解释为什么少了其中任何一步都会重演上面那三起事故。
5. 客服这条路径怎么处理？给出"人可以在什么条件下破例"的设计
   （权限、双人、审计、额度、可撤销性），并说明为什么不能简单地"关掉人工通道"。
6. 你怎么度量这套机制的安全性而没有把验证变成一次攻击？
   给出至少两个指标，并指出其中一个必然与转化率冲突、你怎么取舍。"""

    return base(
        'system-design', 'senior',
        '账户恢复即后门设计：信道不信任、强度分级、恢复后的最小动作集与客服破例',
        statement, 'llm-rubric',
        ['account-recovery', 'e2ee', 'device-revocation', 'social-engineering',
         'modern:privacy-engineering'],
        src('iCloud 身份与账户 高级工程师',
            'content/knowledge/hot-interviews/apple-privacy-and-edge-cloud.md §2.5 与 §3'
            '（素材给出"恢复流程不能变成后门：可信联系人/延迟等待/强度分级"这一行清单，'
            '未给可判分的分级规则、恢复后动作集与客服破例设计）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '指出邮箱/安全问题的信任信道错了', 'weight': 2,
                 'criteria': '必须说到两层错：① 邮箱与手机号属于**同一条攻击链**（SIM 交换/邮箱接管'
                             '即可同时拿下"身份"与"验证信道"），把它们当两个独立因子是伪多因素；'
                             '② 安全问题的答案**熵极低且公开可推**（母校、宠物名在社交图上可得），'
                             '它更像"提示"而不是秘密。'
                             '加分：指出端到端加密体系里恢复材料的语义 ——'
                             '它不是"重置密码"，而是"向新设备授予解密历史数据的权利"，'
                             '所以它的权限等级远高于登录。'},
                {'label': '至少三种恢复手段且有强度分级规则', 'weight': 2,
                 'criteria': '手段需覆盖（任三种即可）：可信联系人/信任圈背书、'
                             '设备证明（在另一台已登录且受证明的设备上确认）、'
                             '硬件安全密钥/passkey、'
                             '线下或账户内长期信号（地址、支付凭证这类"攻击者难短期内伪造"的量）。'
                             '**分级规则必须给出条件**：'
                             '从"受信设备上发起 + 联系人背书"这类可较快，'
                             '到"全新设备 + 无受信渠道"必须走最长延迟 + 多因子，'
                             '并说明分级依据是**攻击者可得资源的量级**而不是用户等级投诉声量。'
                             '只罗列手段不给分级条件，此项最多 1 分。'},
                {'label': '延迟等待的期内外权限切分', 'weight': 2,
                 'criteria': '必须给出"等待期内允许做什么"：读取元数据、看到"恢复进行中"、'
                             '账户持有者可**主动取消/加严**（这是关键：延迟是给用户反悔用的，'
                             '不是只给攻击者设的墙）；'
                             '不允许做什么：解密历史端到端数据、修改恢复设置、移除设备、消费支付。'
                             '并且要处理"延迟对攻击者几乎无成本、对合法用户是损失"这个不对称 ——'
                             '解法是让延迟期内**旧凭据仍然可用**（有任一旧设备的人不需要恢复流程），'
                             '于是真正被延迟的只有"确实丢了所有设备"的人，摩擦落在正确的群体上。'
                             '只说"等 72 小时"不得过半。'},
                {'label': '恢复成功后的最小动作集', 'weight': 2,
                 'criteria': '必须至少包含且说清因果：'
                             '① **信封轮换**（key rotation：重新生成内容密钥、用新恢复材料重加密）——'
                             '缺它就直接重演"撤销过的设备仍能解密"，'
                             '因为撤销只是移除成员，旧信封还在；'
                             '② 全设备强制重新登录/重新注册并**吊销所有旧会话与旧设备**；'
                             '③ 恢复事件对用户显式通知（多通道，且包含"这不是你做的怎么办"入口）；'
                             '④ 保留不可篡改的审计记录（谁、凭什么、何时）。'
                             '只答"重置密码并登出其他设备"缺 ① ⇒ 此项最多 1 分。'},
                {'label': '客服破例的权限设计与为何不能关掉', 'weight': 1,
                 'criteria': '必须给约束而非口号：单人不可完成（双人复核 + 不同团队）、'
                             '额度上限（每人每日可破例次数）与金额/敏感度上限、'
                             '强制留痕且审计可回放、**破例结果可撤销**（如仅授予临时访问，'
                             '账户持有者确认后才固化）、以及破例本身要有被监控的指标。'
                             '并要回答"为什么不能直接关人工通道"：'
                             '关掉它会把"确实失去一切"的用户推向黑市/第三方恢复服务'
                             '（那里没有审计与延迟），并且合法不可达本身就是安全失败。'},
                {'label': '度量安全而不制造攻击面', 'weight': 1,
                 'criteria': '指标需可量化且**不泄露判据**，例如：'
                             '恢复请求的拒绝率与拒绝原因分布（内部）、'
                             '恢复后 30 天内被举报接管的比率（真阳性的黄金信号）、'
                             '延迟期内被用户主动取消的比率（等于"攻击被自己人打断"的次数）、'
                             '破例通道的使用率。'
                             '必须指出与转化率冲突的那个（延长延迟/加因子会降低成功恢复率'
                             '并推高客服量），并给出取舍依据：'
                             '按"接管损失 vs 恢复失败损失"量化，而不是按客服压力。'
                             '绝不能把"恢复成功率"当成对用户公开的可调阈值信号。'},
            ],
            'notes': '总分封顶 5 的情形：把恢复答成"MFA + 更严格的验证码"而不处理密钥信封；'
                     '延迟设计里没提"账户持有者可以中断/撤销恢复"；'
                     '对客服通道只说"要审批"；'
                     '认为撤销设备就等于历史数据不可读（缺信封轮换这一层）；'
                     '提出"用 AI 风控判断是否可信"却没有可判定的信号。',
        },
        estimatedMinutes=45,
        answer="""## 参考答案要点

**邮箱 + 安全问题错在信道与熵**：
邮箱和手机号在真实攻击里是**同一条链**（SIM 交换同时拿下通信与验证），
两个因子共享一个失败模式等于一个因子；
安全问题的答案是公开可推的低熵串。
更深的一层是语义：端到端加密体系里"账户恢复"不是重置密码，
而是**授予新设备解密全部历史数据的权利** —— 它的权限等级高于登录，
却要由一个 6 位验证码完成，这就是结构错配。

**分级依据是攻击者可得资源，不是用户身份**。
"受信设备在场 + 信任圈背书" ⇒ 快通道（这类组合要求攻击者同时持有已认证设备与足够关系人）；
"全新设备 + 无受信渠道" ⇒ 最长延迟 + 多因子。
高价值人群占被接管账户的 80% ⇒ 分级还要按**风险信号自适应**（异地、异常恢复频率、
近期设备撤销），并且这种加严要对用户可解释为"需要多一步"而不是随机刁难。

**延迟的价值在它能被中断**：
等待期内账户持有者必须能看到"恢复进行中"并能**取消/加严**。
没有这一条，延迟只是攻击者的时间窗口而不是保护。
同时"旧凭据在延迟期内仍然可用"很关键 ——
它把摩擦精确地落在"确实丢了所有设备"的人身上，
而不是让每个手滑点错恢复的用户都付 72 小时。

**恢复成功后的最小动作集里，信封轮换是那条不能省的**：
只移除设备成员而不重加密 ⇒ 攻击者拿走的那份密钥信封仍然能解历史数据，
这正是那 3 起"撤销后仍可解密"的成因。
配套：全设备强制重新注册、吊销所有旧会话、多通道显式通知
（含"这不是我做的"入口）、不可篡改审计。

**客服不能关掉**。关掉它的后果是"完全失去访问"的人去找黑市恢复服务，
那里既无审计也无延迟，风险更高；而且合法不可达本身就是安全失败。
能做的是把破例变成**有边界的能力**：双人不同团队、每日额度与敏感度上限、
强制留痕可回放、结果可撤销（先给临时访问，本人确认后才固化）。

**度量要挑"不会被游戏化的真信号"**：
恢复后 30 天内被举报接管的比率、延迟期内被用户自己取消的比率（等于攻击被熟人打断的次数）、
破例通道使用率。与转化率冲突的是"加严 ⇒ 恢复成功率下降、客服量上升"，
取舍必须落在"接管损失 vs 恢复失败损失"的钱数上；
而**绝不能把公开的成功率阈值当调优目标** —— 那等于告诉攻击者要伪造到什么程度。"""
    )


@draft('hot-apple-sdk-rollout')
def q_sdk_rollout_fill_rate():
    statement = """## 场景

**你正在面试 Apple 的数据平台工程师（遥测 SDK 与发布质量），40 分钟（短设计题）**

设备端 SDK 有上百个版本共存（"永远有用户不升级"），每次 SDK 发布都会改变数据的
**填充率**（某字段有多少比例的记录真的带上来了）。三件已经发生的事：

- 一次改动把某个可选字段从"客户端条件性上报"改成"总上报但可能为空串"，
  下游把它当成"值为空"统计，某指标掉了 40% 而没人报错；
- 新版本发布 3 天后，服务端按 `app_version` 分组看到的样本量在两个版本间来回跳，
  没人能说清是灰度回滚了还是分组口径错了；
- 一个"新增字段"上线半年后发现**只有 8% 的记录有值**，
  因为客户端把它放在了一个极少进入的分支里 —— 而发布时没有任何门禁发现这点。

现状：SDK 发布走常规版本发布流程，数据侧没有独立门禁；
填充率只在季度复盘时看一次。

## 你要回答的问题

1. 这三件事的根因分别在哪一层（协议 / 实现 / 门禁）？给出为什么"再加测试"对其中某些必然无效。
2. 设计一个**填充率门禁**：在哪里算、拿什么做分母、
   什么条件阻断发布、什么条件只告警。给出可落地的阈值确定方法（不要拍一个 95%）。
3. 客户端"没上报"与"上报了但值为空/为 0"必须能区分。给出至少两种做法及其代价。
4. 上百个 SDK 版本共存时，任何"按版本分组的指标"都会遇到同一个坑。
   说出这个坑，并给出你的口径规范。
5. 怎么让新字段的语义在**上线之前**就被下游看见（而不是半年后发现没人用）？
   给出流程上的改动，并指出它会招致什么反对、你怎么回应。
6. 你会故意**不做**的一项数据侧门禁是什么？代价说明。"""

    return base(
        'hot-interviews', 'senior',
        'SDK 灰度与填充率闸：空值三态、按版本分组的坑、阈值怎么定而不是拍',
        statement, 'llm-rubric',
        ['sdk-rollout', 'fill-rate', 'null-vs-missing', 'version-skew', 'data-contract',
         'modern:data-contract'],
        src('数据平台 / 遥测与发布质量 高级工程师',
            'content/knowledge/hot-interviews/apple-telemetry-pipelines.md §2.6 与 §3 加分点 4'
            '（素材点名"SDK 发布前回放契约测试 + 把新增字段填充率作为发布闸"这一要求，'
            '未给可判分的分母口径、三态区分与阈值确定方法）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '三件事分层且说清"加测试"为什么无效', 'weight': 2,
                 'criteria': '空串冒充"未上报"是**协议层**（类型系统允许两种语义共用一个值），'
                             '测试只能证明"实现符合协议"，改不了协议错；'
                             '版本分组来回跳是**口径层**（分组维度用的是原始 `app_version`'
                             ' 还是灰度批次/发布通道，被灰度推进与回滚共同影响）；'
                             '8% 填充率是**门禁缺失**（发布流程里没有数据侧阻断点）。'
                             '必须明确：这三件事里至少两件**加单元测试完全无效**，'
                             '因为问题不在实现错误而在口径与缺门禁。'},
                {'label': '填充率门禁：位置、分母、阻断阈值怎么定', 'weight': 2,
                 'criteria': '计算位置要具体（摄取层按 `event + schema_version + 发布通道` 统计，'
                             '而不是等 BI 报表）；'
                             '**分母必须是"应当携带该字段的记录数"**'
                             '（用事件类型 + 版本生效区间 + 进入条件推导），'
                             '用"全部记录"当分母会把条件性字段天然判成低填充。'
                             '阈值确定方法要给可操作来源：'
                             '从**基线分布**取（上一版本/同族字段的经验分布 + 置信带），'
                             '或从"该字段支撑的下游指标所需最小样本量"反解，'
                             '新字段用灰度小流量的实测值外推；'
                             '并区分**阻断**（低于可达性下界 ⇒ 字段永远不可用）与'
                             '仅告警（在预期带内但显著下降 ⇒ 可能是口径变化）。'
                             '拍 95% 者此项最多 1 分。'},
                {'label': '区分"未上报 / 值为空 / 值为 0"的两种做法与代价', 'weight': 2,
                 'criteria': '做法需给两种以上并带代价，例如：'
                             '字段可选化 + 摄取层"键存在性"检测（代价：需要严格 schema，'
                             '老 SDK 仍可能写空串）；'
                             '显式状态字段（`field_x_presence ∈ {present, empty, not_applicable}`）'
                             '（代价：体积、以及客户端要为每个字段多写一个键）；'
                             '或"缺省即缺席 + 类型化 null（JSON null ≠ 缺失）"（代价：跨语言 SDK 对'
                             ' null 的序列化行为不一致，这正是最初事故的同源问题）；'
                             '以及摄取层按版本把空串规范化为缺席（代价：修复了历史但掩盖了 SDK bug，'
                             '必须同时打标记位）。'},
                {'label': '按版本分组的坑与口径规范', 'weight': 2,
                 'criteria': '必须点名至少两个坑并给规范：'
                             '① 原始 `app_version` 把**同一份代码的多次灰度**当成不同总体，'
                             '回滚/重放会让分组样本量来回跳 ⇒ 分组要用'
                             '"发布批次/通道 + 版本"复合键，或统一到**语义版本 + 生效区间**；'
                             '② 版本切换会让"字段填充率"这类**比率指标的分母总体同时变化** ⇒ '
                             '跨版本比较必须固定总体或用同期对照（同版本内部新旧字段对比）；'
                             '加分：指出"按版本分组"和"按设备分组"的幸存者偏差'
                             '（不升级的设备是不同的用户群体，不能当作随机分组）。'},
                {'label': '语义在上线前被下游看见', 'weight': 1,
                 'criteria': '流程改动要具体，例如：注册表里新字段必须挂**消费方**（谁用、'
                             '怎么用）才能进发布；'
                             '灰度期强制产出"字段可用性报告"（填充率 + 值分布 + 与需求方的对账签字）'
                             '并广播给下游；'
                             '下游订阅制（没有订阅者的新字段默认不采集，避免 SDK 无限膨胀）。'
                             '必须给出会招致的反对（"客户端团队要走两个发布节奏"、'
                             '"订阅制会让新字段永远没人订"）与回应，而不是只描述流程。'},
                {'label': '故意不做的一项门禁及代价', 'weight': 1,
                 'criteria': '需给出具体一项并说明代价，例如：'
                             '不做"每个字段的值域合理性实时校验"（组合爆炸、误报会把门禁变成噪声，'
                             '大家开始忽略门禁 —— 与第一条事故同级别的代价）；'
                             '或不做"填充率随版本单调不降"（条件性字段合法地会变）；'
                             '或不做全字段级血缘自动阻断（改人工仲裁）。'
                             '只说"以后再做"不得分。'},
            ],
            'notes': '总分封顶 5 的情形：把三件事都归因"测试不严"；'
                     '填充率门禁的分母用总记录数；'
                     '解决"空串 vs 缺席"的方案是"在 prompt/文档里写清楚"；'
                     '跨版本比较只说"分开看"而不处理总体变化；'
                     '对客服/人工通道或阻断阈值没有任何量化依据。',
        },
        estimatedMinutes=40,
        answer="""## 参考答案要点

**三件事不在同一层**：空串冒充缺席是**协议**问题（类型允许两种语义共享一个值），
测试再多加也只是验证"实现忠于协议"，协议本身错了就测不出来；
分组样本来回跳是**口径**问题（原始 `app_version` 把灰度批次当总体）；
8% 填充率是**门禁缺失**（发布流程里没有数据侧阻断点）。
所以"再加测试"对这三件里的两件必然无效 —— 这是本题最想说清的一件事。

**填充率门禁的关键是分母**：分母必须是"**应当**携带该字段的记录数"
（由事件类型 + 版本生效区间 + 进入条件推导），不是全部记录。
否则条件性字段（只在某个少进分支里上报）天然被判成"填充率低"，
第一周就把门禁玩成噪声，第二周大家开始忽略它 —— **误拦的代价是把闸门废掉**，
这和漏放同样严重。

阈值不拍脑袋：从基线分布取（上一版本、同族字段的经验分布 + 置信带），
或从下游指标的**最小可用样本量**反解，新字段用灰度小流量的实测值外推。
并分两档：低于可达性下界 ⇒ 阻断（字段永远不可用）；
带内但显著下降 ⇒ 只告警（可能是合法的口径变化）。

**三态要能区分**：可选化 + 键存在性检测、显式 presence 状态位、
或摄取层按版本把空串规范化为缺席（必须同时打标记位，否则等于把 SDK bug 抹平）。
每种都有代价，最后那种最危险也最常被选：它修好了历史数据，
代价是让"客户端确实写错"这件事再也没有可观测痕迹。

**按版本分组的通用坑**：版本切换时，比率指标的分子分母**总体同时变化**，
所以"新版本填充率更低"完全可能只是"新版本用户构成不同"（不升级的设备不是随机样本）。
规范：分组键用"发布批次/通道 + 语义版本"，跨版本比较必须固定总体或用同期对照。

**上线前让语义被看见**：注册表要求新字段挂上消费方（谁用、怎么用）才能发布，
灰度期强制产出字段可用性报告并与需求方对账。
反对意见是"客户端要多走一个发布节奏"和"订阅制下新字段永远没人订"；
回应是前者可以合并到同一个发布闸、后者给"新字段有默认订阅者（分析团队）+ 半年无人用则下线"。

**故意不做**：全字段值域实时合理性校验。
组合空间太大、误报率高，一旦门禁变成噪声，真正的阻断（字段完全没上报）也会被忽略 ——
那比不做更糟。"""
    )


# =================================================================== 迟到数据与窗口重算
@draft('bd-apple-late-window-recompute')
def q_late_window_recompute():
    """
    expected 由 recompute() 从记录行集算出。窗口一律按 event_time **重算**，
    上游标好的 window_start 只是一个需要被核对的字段 —— 这是本题的判分点之一。
    """
    from datetime import datetime, timedelta

    FMT = '%Y-%m-%d %H:%M:%S'
    WINDOW = timedelta(minutes=15)
    ALLOW = timedelta(minutes=10)

    def floor_window(ts):
        t = datetime.strptime(ts, FMT)
        start = t.replace(minute=(t.minute // 15) * 15, second=0, microsecond=0)
        return start, start + WINDOW

    def recompute(rows):
        groups = {}
        for rec in rows:                       # (record_id, biz_key, event_time, value, watermark, supplied_ws)
            rid, key, et, _value, wm, supplied = rec
            start, end = floor_window(et)
            g = groups.setdefault((key, start.strftime(FMT)),
                                  {'window_end': end, 'accepted': 0, 'dropped': 0,
                                   'late_accepted': 0, 'misbucketed': 0})
            w = datetime.strptime(wm, FMT)
            if w > end + ALLOW:
                g['dropped'] += 1
            else:
                g['accepted'] += 1
                if w > end:
                    g['late_accepted'] += 1
            if supplied != start.strftime(FMT):
                g['misbucketed'] += 1
        return [{'biz_key': k, 'window_start': ws, 'window_end': g['window_end'].strftime(FMT),
                 'accepted': g['accepted'], 'dropped': g['dropped'],
                 'late_accepted': g['late_accepted'], 'misbucketed': g['misbucketed']}
                for (k, ws), g in sorted(groups.items())]

    SCHEMA = ('record_id int, biz_key string, event_time string, value double, '
              'watermark_at_arrival string, window_start string')

    def case(name, rows, note=None):
        return {'name': name,
                'input': {'view': 'late_records', 'schema': SCHEMA,
                          'rows': [{'record_id': r[0], 'biz_key': r[1], 'event_time': r[2],
                                    'value': r[3], 'watermark_at_arrival': r[4],
                                    'window_start': r[5]} for r in rows]},
                'expected': recompute(rows),
                **({'note': note} if note else {})}

    statement = """## 输入

PySpark 3.5（判题容器内）。工作区已注册一张表：

```
late_records(
  record_id INT, biz_key STRING,
  event_time STRING,            -- 'yyyy-MM-dd HH:mm:ss'
  value DOUBLE,
  watermark_at_arrival STRING,  -- 该记录到达时系统的水位线时刻，同格式
  window_start STRING)          -- **上游已经标好的** 15 分钟窗口起点，同格式
```

## 口径

1. **窗口按 `event_time` 重算**：15 分钟滚动窗口，起点是分钟向下取整到 `:00 / :15 / :30 / :45`，
   秒归零；`window_end = window_start + 15 分钟`。
   **上游标的 `window_start` 不可信**（它正是"标错窗口"的来源），只用来核对差异。
2. 迟到与丢弃判定（`wm` = `watermark_at_arrival`，`we` = 重算出的 `window_end`）：
   - `wm <= we` ⇒ **准点**，计入 `accepted`；
   - `we < wm <= we + 10 分钟` ⇒ **迟到但在允许窗口内**，计入 `accepted`，并计入 `late_accepted`；
   - `wm > we + 10 分钟` ⇒ **超出允许迟到**，丢弃进 dead-letter，只计入 `dropped`。
   注意 `late_accepted` 是 `accepted` 的**子集**（不是并列计数）——
   它的作用是告诉下游"这个窗口的结果已经发过一次、现在必须重发"。
3. `misbucketed` = 该组里 `window_start`（上游标的）与重算结果**不相等**的记录条数。

## 输出

按 `(biz_key, window_start)` 分组，列固定为：

```
biz_key, window_start, window_end, accepted, dropped, late_accepted, misbucketed
```

`window_start / window_end` 输出 `'yyyy-MM-dd HH:mm:ss'` 字符串；四个计数列是整型。
按 `biz_key` 升序、再按 `window_start` 升序。空输入返回 0 行。

## 约束

不许 `collect()` 到驱动侧再算；不许用 Python UDF 逐行遍历；只允许 DataFrame / Spark SQL 算子。

## 这题真正考的东西

- **判定迟到用的是"窗口重算后的 end"，不是上游标的那个**。
  上游标错一条，那条就会拿着**别人的** `window_end` 去比水位线 ⇒ 该丢的没丢、该留的被丢。
- **丢弃要有去处，指标要能看出丢了**。把超迟记录直接 `filter` 掉是最省事的写法，
  代价是"少了几条"这件事永远无人知晓 —— 手册里那句"迟到超阈值 → 侧输出 → T+1 批补偿"
  强调的正是**丢掉的数据要可追**。`dropped` 这一列就是补偿的输入。
- **`late_accepted` 是重发信号**：窗口已经输出过一次，又有迟到记录被收进来，
  结果必须重新发布，否则下游读到的永远是旧值。"""

    reference = """import pyspark.sql.functions as F

WINDOW_SEC = 900      # 15 分钟
ALLOW_SEC = 600       # 允许迟到 10 分钟
FMT = 'yyyy-MM-dd HH:mm:ss'


def solve(spark):
    # 全程用 epoch 秒做整数算术：窗口边界 = floor(ev/900)*900，
    # 允许迟到的截止 = 窗口起点 + 15 + 10 分钟 = ws_sec + 1500。
    # 不碰 timestamp 加减与日期函数，就没有会话时区与格式解析的坑。
    w = (spark.table('late_records')
         .withColumn('ev', F.unix_timestamp('event_time'))
         .withColumn('wm', F.unix_timestamp('watermark_at_arrival'))
         .withColumn('ws_sec', (F.floor(F.col('ev') / WINDOW_SEC) * WINDOW_SEC).cast('long'))
         .withColumn('accepted_flag', (F.col('wm') <= F.col('ws_sec') + WINDOW_SEC + ALLOW_SEC).cast('int'))
         .withColumn('dropped_flag', (F.col('wm') > F.col('ws_sec') + WINDOW_SEC + ALLOW_SEC).cast('int'))
         .withColumn('late_flag', ((F.col('wm') > F.col('ws_sec') + WINDOW_SEC)
                                   & (F.col('wm') <= F.col('ws_sec') + WINDOW_SEC + ALLOW_SEC)).cast('int'))
         .withColumn('ws_str', F.from_unixtime(F.col('ws_sec'), FMT)))

    g = w.groupBy('biz_key', 'ws_str').agg(
        (F.max('ws_sec') + WINDOW_SEC).alias('we_sec'),
        F.sum('accepted_flag').cast('int').alias('accepted'),
        F.sum('dropped_flag').cast('int').alias('dropped'),
        F.sum('late_flag').cast('int').alias('late_accepted'),
        F.sum((F.col('window_start') != F.col('ws_str')).cast('int')).cast('int').alias('misbucketed'),
    )

    return (g.select(F.col('biz_key'),
                     F.col('ws_str').alias('window_start'),
                     F.from_unixtime(F.col('we_sec'), FMT).alias('window_end'),
                     'accepted', 'dropped', 'late_accepted', 'misbucketed')
            .orderBy('biz_key', 'window_start'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('late_records')

    # 相信上游标的窗口，并且"超水位线就丢" —— 两个方向都错
    w = r.withColumn('wm', F.col('watermark_at_arrival').cast('timestamp')) \
         .withColumn('we', F.col('window_start').cast('timestamp') + F.expr("interval 15 minutes"))

    grouped = w.groupBy('biz_key', 'window_start').agg(
        F.max('we').alias('we'),
        F.sum(F.when(F.col('wm') <= F.col('we'), 1).otherwise(0)).cast('int').alias('accepted'),
        F.sum(F.when(F.col('wm') > F.col('we'), 1).otherwise(0)).cast('int').alias('dropped'),
        F.lit(0).cast('int').alias('late_accepted'),      # 不区分"迟到但可收"与"超迟"
        F.lit(0).cast('int').alias('misbucketed'),        # 根本没核对上游标的窗口
    )

    return (grouped
            .select('biz_key', 'window_start',
                    F.date_format('we', 'yyyy-MM-dd HH:mm:ss').alias('window_end'),
                    'accepted', 'dropped', 'late_accepted', 'misbucketed')
            .orderBy('biz_key', 'window_start'))"""

    answer = """## 参考答案要点

三步：① 用 `floor(unix_timestamp(event_time) / 900) * 900` 重算窗口起点
（epoch 是 900 的整数倍，所以这一步天然对齐 `:00/:15/:30/:45`）；
② `groupBy(biz_key, ws)` 上做四个条件求和，注意 `accepted` 与 `dropped` 的分界是
**`we + 10min`**（允许迟到的截止），不是 `we`；
③ `misbucketed` 用"上游标的 `window_start` ≠ 重算值"计数。全程只有 shuffle 聚合，没有 collect。

**基线那组数据的手算**（用来核对 expected 是不是真的对）：
一条 `event_time = 10:20:00` ⇒ 重算窗口 `[10:15, 10:30)`；
上游把它标成 `10:00`（标错 ⇒ `misbucketed=1`）。
若 `watermark = 10:35`：按重算的 `we=10:30`，`10:30 < 10:35 <= 10:40` ⇒ **迟到但在允许内**
⇒ `accepted=1, late_accepted=1`；
按上游那个错窗口（`we=10:15`）算，`10:35 > 10:25` ⇒ 会被**丢掉**。
同一条数据，两种实现给出"收"与"丢"的相反结论 —— 这就是"必须重算窗口"的全部理由。

**丢弃可见**：把超迟记录直接 `filter` 掉，报表上只是"少了几条"，
没有任何一列会因此变化。`dropped` 这一列是 T+1 批补偿的唯一输入 ——
"迟到超阈值 → 侧输出 → 批补偿"这条链，缺了侧输出就变成静默少数。
（少数是最难查的一类事故：所有断言都仍然成立，只是数字小了。）

**`late_accepted` 为什么要单独出**：它等于"这个窗口的结果已经发出去了，现在又变了"。
下游只读 `accepted` 是看不出需要重发的；不重发，下游就永远拿着旧值 ——
症状是"看板偶尔和补数后的结果差一点，刷新一下又对了"。

**为什么全程用 epoch 秒**：`floor(ev/900)*900` 就是"对齐到 :00/:15/:30/:45"，
"迟到截止"是 `ws + 1500` 一次整数比较 —— 不涉及 timestamp 加减、日期格式化与会话时区切换。
（`floor(epoch/900)*900` 与"分钟向下取整"等价的前提仍是时区偏移是 15 分钟的整数倍
（现实常用偏移都满足，含 UTC+5:30 与 UTC+5:45。）
换成 7 分钟这种不能整除 900 的窗口就必须显式在会话时区里算 —— 那是个"看起来免费"的简化，
值得写在代码注释里而不是留给下一个人踩。

**工程延伸（面试追问点）**

1. 为什么水位线要随记录带进来而不是全局一个？（真实管道里水位线按分区/按 key 推进；
   把"到达时的水位线"作为字段快照下来，才能**事后重放**同一个判定 ——
   否则补数时会用今天的水位线判昨天的数据，全判成"未迟到"。）
2. 允许迟到设多久？（它是**延迟与完整性的交换**：太小 ⇒ 少数，太大 ⇒ 结果长期不收敛。
   判据来自业务：下游能接受多久之内的修正。可订价/结算类通常是小时级容忍，
   实时告警类是分钟级。）
3. `misbucketed` 高意味着什么？（上游的窗口实现与口径不一致 —— 这是**最该报警的一类**，
   因为它说明有另一套代码在用不同规则算同一个东西；正确处置是把它接进 DQC 阻断，
   而不是长期靠这里"重算纠偏"。）
4. 超迟的数据最终去哪？（侧输出到隔离区 + 一个待补偿清单；T+1 批重算按
   `(biz_key, window)` 幂等覆盖。关键是补偿要有**终点**（如只补 7 天），
   否则一个三年前的迟到记录会重开一个早已归档的窗口。）"""

    return base(
        'big-data', 'senior',
        '迟到数据与窗口重算：窗口按事件时间重算，丢弃必须可见',
        statement, 'pyspark',
        ['late-data', 'watermark', 'window-recompute', 'dead-letter', 'modern:data-ops'],
        src('数据平台 / 实时管道 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §3.5 与 §一致性/迟到'
            '（"乱序/迟到：event-time + watermark；迟到超阈值 → 侧输出(dead-letter) → T+1 批补偿"；'
            '手册只给策略一句话，未给可判分的窗口重算与丢弃口径）'),
        language='python',
        cases=[
            case('基线：上游标错窗口 + 窗口关闭后到达但仍在允许迟到内',
                 [(1, 'storeA', '2026-05-01 10:05:00', 1.0, '2026-05-01 10:06:00', '2026-05-01 10:00:00'),
                  (2, 'storeA', '2026-05-01 10:20:00', 2.0, '2026-05-01 10:35:00', '2026-05-01 10:00:00')],
                 note='rec2 重算进 [10:15,10:30)：wm 10:35 属迟到但在 10:40 之前 ⇒ 收；'
                      '按上游标的 10:00 算会被判成超迟丢掉'),
            case('超出允许迟到：只进 dropped，别静默消失',
                 [(1, 'storeB', '2026-05-01 11:02:00', 5.0, '2026-05-01 11:26:00',
                   '2026-05-01 11:00:00')],
                 note='we=11:15、截止 11:25，wm=11:26 刚好超 1 分钟 ⇒ dropped=1、accepted=0'),
            case('边界：wm 正好等于 we 算准点，正好等于 we+10min 算迟到可收',
                 [(1, 'storeC', '2026-05-01 12:00:00', 1.0, '2026-05-01 12:15:00',
                   '2026-05-01 12:00:00'),
                  (2, 'storeC', '2026-05-01 12:50:00', 1.0, '2026-05-01 13:10:00',
                   '2026-05-01 12:45:00')],
                 note='rec1 窗口 [12:00,12:15)、wm==we ⇒ 准点（late_accepted 0）；'
                      'rec2 窗口 [12:45,13:00)、wm==13:00+10min 正好卡在截止上 ⇒ 迟到可收'),
            case('同一个重算窗口的多条 + 一条被上游错标到别的窗口',
                 [(1, 'storeD', '2026-05-01 14:16:00', 1.0, '2026-05-01 14:17:00',
                   '2026-05-01 14:15:00'),
                  (2, 'storeD', '2026-05-01 14:17:00', 1.0, '2026-05-01 14:18:00',
                   '2026-05-01 14:15:00'),
                  (3, 'storeD', '2026-05-01 14:29:00', 1.0, '2026-05-01 14:30:00',
                   '2026-05-01 14:00:00')],
                 note='三条都落进 [14:15,14:30)；rec3 被标成 14:00 ⇒ misbucketed=1'),
            case('退化：没有任何记录', []),
        ],
        runner={'entry': 'function', 'orderSensitive': False, 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=34,
        answer=answer,
    )


# =================================================================== 数据质量规则的命中与判失败
@draft('sql-apple-dqc-rules')
def q_dqc_rules():
    """
    事实表、维表、规则表都只声明一次；expected 由 evaluate() 按题面那张口径表算出。
    四种规则共用同一条失败判据（比率 > threshold），所以"计数口径"绝不能各算各的。
    """
    ORDERS = [
        # order_id, customer_id, device_id, amount, status
        (1, 100, 10, 20.00, 'ok'),
        (2, 100, 10, None, 'ok'),        # 与 1 同 customer ⇒ 重复多出来的 1 行
        (3, 101, 11, -5.00, 'ok'),       # 负值
        (4, 102, 99, 30.00, 'ok'),       # device 99 不在维表 ⇒ 孤儿
        (5, 103, None, 40.00, 'ok'),     # device 为 NULL ⇒ 不算孤儿，算空值
        (6, 104, 12, 50.00, 'test'),     # 测试单 ⇒ 全部规则都不许看它
        (7, 105, 12, 60.00, 'ok'),
    ]
    DEVICES = [10, 11, 12]
    RULES = [
        (1, 'null_rate', 'amount', 0.2000),
        (2, 'negative_value', 'amount', 0.0000),
        (3, 'orphan', 'device_id', 0.0000),
        (4, 'duplicate', 'customer_id', 0.1000),
    ]
    COLUMNS = ['rule_id', 'rule_type', 'checked_rows', 'violations',
               'violation_rate_pct', 'fail_flag']

    def evaluate(orders, devices, rules):
        from decimal import Decimal, ROUND_HALF_UP
        active = [o for o in orders if o[4] != 'test']
        checked = len(active)
        nulls = sum(1 for o in active if o[3] is None)
        negatives = sum(1 for o in active if o[3] is not None and Decimal(str(o[3])) < 0)
        orphans = sum(1 for o in active if o[2] is not None and o[2] not in set(devices))
        counts = {}
        for o in active:
            counts[o[1]] = counts.get(o[1], 0) + 1
        dup_extra = sum(c - 1 for c in counts.values())     # 多出来的行数，不是重复的组数
        hits = {'null_rate': nulls, 'negative_value': negatives,
                'orphan': orphans, 'duplicate': dup_extra}

        out = []
        for rule_id, rule_type, _col, threshold in rules:
            v = hits[rule_type]
            if checked == 0:
                out.append([rule_id, rule_type, 0, v, None, 0])
                continue
            rate = float((Decimal(v) * 100 / Decimal(checked)).quantize(
                Decimal('0.01'), rounding=ROUND_HALF_UP))
            fail = 1 if Decimal(str(rate)) / 100 > Decimal(str(threshold)) else 0
            out.append([rule_id, rule_type, checked, v, rate, fail])
        return out

    def case(name, mutations=(), note=None):
        """变异只有一种表示法：先改内存行集，再由同一份行集生成 SQL 与期望值。"""
        orders = [list(o) for o in ORDERS]
        devices = list(DEVICES)
        sql = []
        for mut in mutations:
            kind = mut[0]
            if kind == 'del_order':
                orders = [o for o in orders if o[0] != mut[1]]
                sql.append(f'DELETE FROM orders_fact WHERE order_id = {mut[1]}')
            elif kind == 'del_device':
                devices = [d for d in devices if d != mut[1]]
                sql.append(f'DELETE FROM dim_device WHERE device_id = {mut[1]}')
            elif kind == 'ins_order':
                orders.append(list(mut[1]))
                o = mut[1]
                sql.append('INSERT INTO orders_fact VALUES (' + ', '.join(
                    'NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                    for v in o) + ')')
            elif kind == 'upd_rule':
                _, rule_id, value = mut
                sql.append(f'UPDATE dqc_rule SET threshold = {value} WHERE rule_id = {rule_id}')
            else:
                raise AssertionError(f'未知变异 {kind}')
        # 规则阈值同步进内存（与上面那条 UPDATE 同一份事实）
        rules = []
        for rule_id, rule_type, col, threshold in RULES:
            applied = threshold
            for m in mutations:
                if m[0] == 'upd_rule' and m[1] == rule_id:
                    applied = m[2]
            rules.append((rule_id, rule_type, col, applied))
        payload = {'name': name, 'input': sql,
                   'expected': {'columns': COLUMNS, 'rows': evaluate(orders, devices, rules),
                                'orderSensitive': True}}
        return {**payload, **({'note': note} if note else {})}

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

```
orders_fact(order_id INT PRIMARY KEY, customer_id INT, device_id INT NULL,
            amount DECIMAL(10,2) NULL, status VARCHAR(8))     -- 'ok' | 'test'
dim_device (device_id INT PRIMARY KEY)
dqc_rule   (rule_id INT PRIMARY KEY, rule_type VARCHAR(16),
            target_col VARCHAR(16), threshold DECIMAL(6,4))   -- rule_type 见下表
```

`target_col` 是给人看的元数据；本批规则用到的列是**固定**的
（`null_rate`/`negative_value` 看 `amount`，`orphan` 看 `device_id`，`duplicate` 看 `customer_id`）。

## 任务

对**每一条规则**输出一行判词，按 `rule_id` 升序，列名与顺序必须是：

```
rule_id, rule_type, checked_rows, violations, violation_rate_pct, fail_flag
```

## 口径（这张表就是判分点）

1. **所有规则共用同一个"有效行"集合**：`status <> 'test'`。
   测试单不许参与任何一条规则（既不进分子也不进分母）。
   `checked_rows` 恒等于有效行数（四种规则都一样）。
2. 各规则的 `violations`：
   - `null_rate` ⇒ `amount IS NULL` 的有效行数；
   - `negative_value` ⇒ `amount < 0` 的有效行数（`amount IS NULL` **不算**负值，它归 `null_rate`）；
   - `orphan` ⇒ `device_id IS NOT NULL` 且该 id **不在** `dim_device` 的有效行数。
     **`device_id IS NULL` 不算孤儿** —— 它是空值问题，两列都要能各自说话；
   - `duplicate` ⇒ **多出来的行数**：`Σ (组内行数 − 1)`。
     不是"有几个 key 重复了"，也不是"涉及重复的总行数"。
3. `violation_rate_pct` = `ROUND(violations * 100 / checked_rows, 2)`；
   `checked_rows = 0` ⇒ 输出 `NULL`（**没有样本不等于 0% 违规**）。
4. `fail_flag` = 1 当且仅当 `violation_rate_pct / 100 > threshold`（**严格大于**）。
   `checked_rows = 0` ⇒ `fail_flag = 0`（判不了就不判失败，交给人看那个 `NULL`）。

只提交**一条** `SELECT` / `WITH` 查询，不许动态拼 SQL、不许存储过程。

## 这题真正考的东西

- **四种规则的分子完全不同，分母必须相同**。
  一旦某条规则偷偷换了分母（比如 `duplicate` 用"不同 key 数"当分母），
  它的 `fail_flag` 就和其它三条不可比，而仪表盘上它们并排显示。
- **`duplicate` 三种口径的分岔**：多出来的行数 / 重复的组数 / 涉及重复的总行数 ——
  基线数据下三者分别是 1 / 1 / 2。阈值是按其中**一种**定的，用错一种就是算错。
- **NULL 不能同时被两条规则认领**：`device_id IS NULL` 既进 `orphan` 又进 `null_rate`
  会让同一行数据被计两次违规，全表违规率虚高，而且两条规则的告警会互相"确认"。"""

    reference = """WITH active AS (
  SELECT o.* FROM orders_fact o WHERE o.status <> 'test'
), stats AS (
  SELECT COUNT(*) AS checked_rows,
         -- 空集时 SUM 返回 NULL 而不是 0；分子兜住才与 checked_rows = 0 的判词一致
         COALESCE(SUM(a.amount IS NULL), 0) AS nulls,
         COALESCE(SUM(a.amount < 0), 0) AS negatives,
         COALESCE(SUM(a.device_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM dim_device d WHERE d.device_id = a.device_id)), 0)
           AS orphans,
         COUNT(*) - COUNT(DISTINCT a.customer_id) AS dup_extra
  FROM active a
), hits AS (
  SELECT r.rule_id, r.rule_type, r.threshold, s.checked_rows,
         CASE r.rule_type
           WHEN 'null_rate'     THEN s.nulls
           WHEN 'negative_value' THEN s.negatives
           WHEN 'orphan'        THEN s.orphans
           WHEN 'duplicate'     THEN s.dup_extra
         END AS violations
  FROM dqc_rule r CROSS JOIN stats s
)
SELECT rule_id,
       rule_type,
       checked_rows,
       violations,
       CASE WHEN checked_rows = 0 THEN NULL
            ELSE ROUND(violations * 100 / checked_rows, 2) END AS violation_rate_pct,
       CASE WHEN checked_rows > 0
                 AND ROUND(violations * 100 / checked_rows, 2) / 100 > threshold
            THEN 1 ELSE 0 END AS fail_flag
FROM hits
ORDER BY rule_id"""

    naive = """-- "每条规则自己算自己的分母"版：判词之间不可比
SELECT r.rule_id,
       r.rule_type,
       COUNT(o.order_id) AS checked_rows,
       CASE r.rule_type
         WHEN 'null_rate'     THEN SUM(o.amount IS NULL)
         WHEN 'negative_value' THEN SUM(o.amount <= 0)          -- 错：把 NULL 当成"不是正数"
         WHEN 'orphan'        THEN SUM(o.device_id IS NULL)     -- 错：空值算成孤儿
         WHEN 'duplicate'     THEN COUNT(*) - COUNT(DISTINCT o.customer_id)
       END AS violations,
       ROUND(SUM(o.amount IS NULL) * 100 / COUNT(*), 2) AS violation_rate_pct,   -- 错：只有 null_rate 的分母
       CASE WHEN COUNT(*) > 0
            THEN (ROUND(SUM(o.amount IS NULL) * 100 / COUNT(*), 2) / 100 > r.threshold) + 0
            ELSE 0 END AS fail_flag                                              -- 错：永远按 null 率判
FROM dqc_rule r
LEFT JOIN orders_fact o ON o.status <> 'test'
GROUP BY r.rule_id, r.rule_type, r.threshold
ORDER BY r.rule_id"""

    answer = """## 参考答案要点

一个 `stats` CTE 把四种违规**在同一次扫描里**算完（分母只有一个 `COUNT(*)`），
再用 `CASE r.rule_type` 给每条规则挑自己的分子。
这样四条判词的分母天然一致 —— 这正是这题要的结构性正确。

**基线手算一遍（用来核对 expected 是不是真的对）**：
有效行 6 条（order 6 是 `test`，剔除）。
- `null_rate`：`amount IS NULL` ⇒ order 2 ⇒ 1 条 ⇒ 16.67% > 20%? 否 ⇒ **不失败**。
- `negative_value`：order 3 ⇒ 1 条 ⇒ 16.67% > 0 ⇒ **失败**。
- `orphan`：order 4（device 99 不在维表）⇒ 1 条；order 5 的 `device_id` 是 NULL **不算** ⇒ 16.67% > 0 ⇒ **失败**。
- `duplicate`：只有 customer 100 出现两次 ⇒ 多出来 1 行 ⇒ 16.67% > 10% ⇒ **失败**。
`checked_rows` 四行都是 6 —— 如果哪条规则算出别的分母，一眼就能看出来。

**`duplicate` 的三种口径在基线上是 1 / 1 / 2**：
"多出来的行数" = `Σ(组内行数−1)` = 1；"重复的组数" = 1；"涉及重复的总行数" = 2。
本题只有第一种与阈值(0.10)自洽。
用第三种的实现会把违规率翻倍，于是"10% 阈值"实际变成"5%" —— 规则上线后开始滥报，
大家的第一反应是调高阈值，之后这条规则就再也没抓住过东西。

**NULL 只能被一条规则认领**（基线用例里的 order 5：`device_id` 是 NULL。把它也算成孤儿，`orphan` 的 violations 就从 1 变 2、比率从 16.67% 变 33.33%，而这条判词只该说"维表缺行"）：
`device_id IS NULL` 是**空值问题**（该字段没上报），
`device_id` 有值但查不到维表是**引用完整性问题**（维表缺行或写入顺序错）。
两者的修法、责任人、紧急程度都不一样。把 NULL 也判成孤儿，两条规则会同时告警并互相"确认"，
而真正的维表缺行被混在噪声里。

**分母为 0 输出 `NULL` 而不是 0**（用例「把有效行删光」）：
`0.00%` 在仪表板上是一个绿色通过标记；`NULL` 是"没判"。
删完数据还全绿，是这类系统最危险的形态 —— 它不是"没报错"，是"报了一次假的安全"。

**工程延伸（面试追问点）**

1. 为什么这里用 `CASE` 而不是给每种规则写一段 SQL 再 UNION？
   （UNION 版本每加一种规则就加一段，且各段分母容易漂移；
   单扫描 + `CASE` 保证"所有规则看的是同一批行"。
   代价是分子逻辑挤在一个表达式里 —— 真实系统会把这个表达式生成出来而不是手写，
   也就是 dbt/Great Expectations 那类工具做的事。）
2. 真实 DQC 引擎怎么处理 `target_col` 是动态的？（不能靠一条 SQL 泛化 ——
   要么发布时按规则**生成**测试 SQL 再执行，要么每种规则类型注册一段模板。
   本题把列固定是**有意的可判分简化**，面试时要主动说明真实系统必须生成。）
3. 阈值该怎么定？（不能拍。`null_rate` 从历史分布取（上一周期的 p99 空值率 + 余量），
   `duplicate`/`orphan` 这类"结构上不该发生"的取 0；
   取 0 的规则一旦某天出现零星命中，通常是上游发布引起的，要阻断而不是调阈值。）
4. 及时性（freshness）规则为什么没放进来？（它的分母不是行数而是"最新分区是否到位"，
   与其它四条不同型；放进同一张表会让人误以为 `violation_rate_pct` 是通用量纲 ——
   这正是"统一 schema"最该被拒绝的地方。真实系统会给它单独一类判词：
   `max_day`、`lag_hours`、是否超过 SLA。）
5. 坏数据怎么办？（**隔离区，不改写源表**。规则命中后把该行复制进隔离表并带
   `rule_id + 判定时刻`，下游读"干净视图"，修复后重放。
   直接 `DELETE` 源表等于销毁证据，之后无法回答"到底影响了哪些订单"。）"""

    return base(
        'sql', 'senior',
        'DQC 规则命中：四种分子同一个分母，分母为 0 判不了而不是通过',
        statement, 'mysql',
        ['data-quality', 'dqc', 'metric-denominator', 'null-handling', 'modern:data-contract'],
        src('数据平台 / 数据质量与治理 高级工程师',
            'data/kb-txt/Apple面试准备手册.txt §3.5「设计数据质量 / 监控 / 血缘」'
            '（手册列出规则类型清单与"坏数据进隔离区"，未给可判分的分母一致性与 NULL 归属口径）'),
        language='sql',
        cases=[
            case('基线：三条失败一条通过，分母统一是 6',
                 note='null 16.67% 未过 20% 阈值；negative/orphan 阈值 0 各命中 1；duplicate 多出 1 行 > 10%'),
            case('测试单本来就不参与：删掉它，四条判词一字不变',
                 [('del_order', 6)],
                 note='有效行仍是 6 ⇒ 与基线完全相同 —— 测试单本来就不该参与'),
            case('维表少一行 + 阈值下调：orphan 命中变 2，null_rate 转为失败',
                 [('upd_rule', 1, 0.1000), ('del_device', 12)],
                 note='device 12 被删 ⇒ order 7 也成孤儿（1→2）；'
                      'null_rate 命中数没变（仍是 1 行、16.67%），但因阈值从 0.20 降到 0.10 而转为失败 —— '
                      '判词变的是阈值而不是数据，这种情况必须能在报表上被区分出来'),
            case('删掉一条负值订单：null_rate 正好卡在 20% 阈值上（严格大于才失败）',
                 [('del_order', 3)],
                 note='剩 5 行、null 1 行 ⇒ 20.00%，阈值 0.20 ⇒ 0.20 > 0.20 为假 ⇒ 仍不失败。'
                      '把 > 写成 >= 的实现在这里会翻成失败'),
            case('customer 100 变四行：violations 是 3，不是 1 也不是 4',
                 [('ins_order', (8, 100, 10, 5.00, 'ok')),
                  ('ins_order', (9, 100, 10, 6.00, 'ok'))],
                 note='customer 100 共 4 行 ⇒ Σ(组内−1) = 3；'
                      '"重复的组数"会给 1、"涉及重复的总行数"会给 4 —— 三种口径都 != 3'),
            case('把有效行删光：分母为 0 ⇒ 比率 NULL、fail 为 0，而不是全绿',
                 [('del_order', i) for i in [1, 2, 3, 4, 5, 7]],
                 note='order 6 是 test，本来就不进集合 ⇒ checked_rows 0'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS orders_fact',
                'DROP TABLE IF EXISTS dim_device',
                'DROP TABLE IF EXISTS dqc_rule',
                'CREATE TABLE orders_fact (order_id INT PRIMARY KEY, customer_id INT NOT NULL, '
                'device_id INT NULL, amount DECIMAL(10,2) NULL, status VARCHAR(8) NOT NULL) '
                'ENGINE=InnoDB',
                'CREATE TABLE dim_device (device_id INT PRIMARY KEY) ENGINE=InnoDB',
                'CREATE TABLE dqc_rule (rule_id INT PRIMARY KEY, rule_type VARCHAR(16) NOT NULL, '
                'target_col VARCHAR(16) NOT NULL, threshold DECIMAL(6,4) NOT NULL) ENGINE=InnoDB',
                'INSERT INTO orders_fact VALUES ' + ', '.join(
                    '(' + ', '.join('NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                                    for v in o) + ')' for o in ORDERS),
                'INSERT INTO dim_device VALUES ' + ', '.join(f'({d})' for d in DEVICES),
                'INSERT INTO dqc_rule VALUES ' + ', '.join(
                    f"({i}, '{t}', '{c}', {th})" for i, t, c, th in RULES),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=28,
        answer=answer,
    )


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    if '--list' in sys.argv:
        for k in sorted(DRAFTS):
            print(k)
        raise SystemExit(0)
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, f'{key}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(fn(), f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'wrote {os.path.relpath(path, ROOT)}')
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print(f'全部 {len(DRAFTS)} 份草稿 JSON 可解析')
