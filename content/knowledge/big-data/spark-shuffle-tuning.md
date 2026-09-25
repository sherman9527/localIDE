# Spark Shuffle 深水区：机理、ESS、AQE 与倾斜（PySpark 可判分）

对应考点：`spark-shuffle-internals`、`spark-aqe`、`data-skew`、`small-files-write`、`data-cost`
适配难度：senior / principal｜出题形式：`code + pyspark`（真跑）+ `rubric + llm-rubric`（架构题）

---

## 1. 核心机制

### 1.1 一次 shuffle 到底付了什么钱
Sort-based shuffle 的成本拆成五段，任何调优都要先定位在哪一段：
1. **Map 侧序列化 + 分区排序**：`spark.sql.shuffle.partitions`（默认 200）决定 map 任务要为每个 reduce 分区维护一块缓冲区；分区数 × map 任务数 = 索引/元数据开销，也是"200 不够 / 2000 太多"争论的真正来源。
2. **Map 侧写盘**：单文件 + 长度索引（`spark.shuffle.sort.bypassMergeThreshold` 以下会走多文件快路径）；4.x 中 shuffle spill 压缩默认转向 ZSTD（4.1 起为 checkpoint/shuffle spill 的默认策略），CPU 与磁盘 IO 的平衡点因此移动。
3. **Reducer 拉取**：`spark.reducer.maxSizeInFlight`（默认 48m 量级）、`spark.shuffle.file.buffer`、netty 线程与 `spark.network.timeout`/`spark.shuffle.io.maxRetries`；拉取失败会触发 stage 重试（WholeStageCodegen 不影响这条，但 speculative execution 会放大）。
4. **Reduce 侧聚合**：hash/sort 聚合的内存画像（`spark.sql.execution.arrow.*` 无关，但 `spark.sql.shuffle.partitions` 与 `spark.sql.adaptive.advisoryPartitionSizeInBytes` 直接决定单任务数据量）。
5. **元数据与失败恢复**：driver 侧 TaskSet/MapStatus 大小与 map 任务数成正比（百万级 map 任务会打爆 driver heap，这是"分区数不能瞎调"的硬约束之一）；4.1 引入**基于校验和的 shuffle 重试**，避免 stage 失败后读到脏数据（这是"结果偶尔多几行/少几行"这类经典玄学问题的现代解）。

### 1.2 ESS / Magnet / 外置与远端 shuffle
- ESS（External Shuffle Service）价值：shuffle 文件生命周期与 executor 解耦，避免"executor 被抢占/缩容 → 整个 stage 重算"。在 K8s / 动态资源分配（`spark.dynamicAllocation.enabled`）下几乎是必需项。
- 4.0 起 ESS 本地状态后端默认从 LevelDB 切到 RocksDB（`spark.shuffle.service.db.backend`，SPARK-45351 类改动，具体配置名以所用小版本文档为准，**需核实**），配合 4.x 的 `removeShuffle`/本地 shuffle reader 相关默认值变化——升级时要把" shuffle 是否被本地读优化"重新验证一遍。
- Magnet（Spark 3.2+ 的 pluggable shuffle metadata）：把 shuffle 元数据托管到外部存储，支持"map 任务输出可被任意 driver 尝试复用"，代价是外部存储往返；对超大规模 stage 的 driver 内存与重试非常关键。
- 远端/服务化 shuffle（Celeborn 类；Apple 曾开源 **Squab**——用 Swift 写的高吞吐外部 shuffle service，思路是"按 reduce 分区连续布局 + 顺序读"，具体指标与可用性**需核实**）。principal 面试关心的是取舍：额外一跳网络与运维复杂度 vs 消除 executor 丢失重算 + 支持"计算与 shuffle 存储分离的弹性伸缩"。

### 1.3 AQE 三能力与它看不见的东西
- **分区合并**：`spark.sql.adaptive.enabled=true` + `advisoryPartitionSizeInBytes`（默认 64MB 量级）；合并是"按相邻分区累计"，对**倾斜无效**（倾斜是单个分区太大）。
- **倾斜 join 拆分**：`skewThreshold`（默认约 256MB）+ `skewedPartitionFactor`（默认 5），只对 sort-merge join 与部分 shuffle join 生效；会把大分区与其对侧匹配分区拆开处理。注意：**一对多膨胀**（一个 key 上千万行）时拆分只降单任务体量，总数据量与内存压力仍在，必须靠改写（先去重/两阶段/限制膨胀）。
- **join 策略动态改**：运行时统计 < 阈值则转 broadcast（对 `spark.sql.autoBroadcastJoinThreshold` 的"计划期误判"很有用），以及 `spark.sql.adaptive.optimizeSkewsInRepartition`、`coalescePartitions` 等；4.1 起无状态 Structured Streaming 也能用 AQE。
- AQE 的盲区：UDF/表达式导致的行数误估、外表/湖仓统计缺失（需要 `ANALYZE TABLE ... COMPUTE STATISTICS / COLUMNS`，且注意 `size` 与 `approxDistCount` 的采样代价）、以及"计划期就无法避免的宽依赖倾斜（groupby 单 key）"。

### 1.4 倾斜的四类根因与对应解法（面试标准答案必须分层）
| 根因 | 症状 | 解法 |
|---|---|---|
| key 天然集中（null / 默认值 / 头部卖家） | 单 task 数据量是其他 100 倍 | 空 key 提前拆出去（`where` 分离 + `union`）、null 打随机前缀再 join |
| 一对多膨胀（join 后行数放大） | task 内存溢出、spill 巨大 | join 前把右侧去重/预聚合；限制版本数；改用 `first()` 语义 |
| 精确去重/全局排序 | `count(distinct)`、`orderBy` 单点 | 换 `approx_count_distinct`/HLL sketch；全局排序改分桶 + 归并（或 `repartitionByRange` + 抽样分区） |
| 写侧不均（分区过碎 / 动态分区爆炸） | 小文件、listing 慢、元数据大 | 写前 `repartition(指定列)` + 合并写出；分区策略重设（按天 + 桶）；表格式 compaction |

**根治 vs 缓解**要讲明白：改口径（如"按用户维度去重"改成"按设备维度去重"、"当天首末事件"改成"事件级预聚合"）才是根治，加盐只是续命。

### 1.5 度量与判据（"真做过"的标志是能给数字）
- 必看指标：`shuffle write records/bytes`、`shuffle read bytes`、`spill (disk/memory)`、task duration p50/p95/max、GCTime、stage 重试次数、driver heap。
- 判据示例：单 task 输入 > 2GB 或 max/p50 > 20 倍即视为倾斜；spill > 0 且持续存在说明聚合内存不足或分区数过少；同一 stage 多次 fetch failed 说明网络/长尾 executor 或 ESS 问题，而不是"再加分区数"。
- Spark 4.x 的**算子级 CPU profiling**（`spark.profile.render`/ProfilingTool 能力在 4.0 起增强）与 SQL plan metrics 是把"感觉"变成"证据"的工具。

---

## 2. senior / principal 会被追问什么

1. "分区数从 200 调到 2000，哪些代价上升？"（driver MapStatus/元数据、小文件、task 调度开销、每 task 固定开销、ESS 索引膨胀；不是"越大越好"）
2. "你怎么确认瓶颈是 shuffle 而不是 IO/UDF？"（stage 时间占比 + task 内 metric：fetchWaitTime、spill、GC、serializer 时间；对比 profile 火焰图）
3. "AQE 之后还需要手工 `repartition` 吗？什么时候必须手工？"（写侧文件合并、broadcast 强制提示 `/*+ BROADCAST */`、跨区读亲和）
4. "dynamic allocation 下为什么必须 ESS？开了之后 executor 数与 shuffle partition 数怎么一起定？"
5. "join 一侧 300GB 一侧 2GB，为什么没走 broadcast？如何强制？阈值调大有什么风险？"（计划期统计缺失/UDF 阻断/`spark.sql.autoBroadcastJoinThreshold` 与 driver/executor 内存；广播构建会拖长 stage 且失败代价高）
6. "倾斜拆分的阈值怎么定？给出你实际作业里的数字和依据。"
7. "这个作业每天成本 $1.2k，你的降本顺序是什么？"（先去掉重复物化/无用列 → 再改倾斜与分区数 → 再考虑 cache/persist（讲清 cache 的内存与失效风险） → 最后才换引擎）
8. "升级 3.5 → 4.2 你在 shuffle/流式上会重新验证什么？"（默认压缩/ANSI/ESS 后端/RocksDB state store/RTM/AQE 对流的支持/checkpoint 兼容）

---

## 3. 常见错误答案

- "调 `spark.sql.shuffle.partitions` + 加 executor 内存" 作为万能答案。
- 把 `repartition` 与 `coalesce` 混用：`coalesce` 只做减少且不重分布 → 上游倾斜会原样带下去；`repartition` 会引入一次额外 shuffle（有时恰好是"省掉一次"的那次，取决于后续算子）。
- 用 `spark.sql.adaptive.skewJoin.enabled` 却从不检查是否真的触发（要看 plan 里 `SkewJoin` 相关信息/事件日志）。
- 声称"AQE 自动了，所以不需要 `ANALYZE TABLE`"：湖仓/外表统计缺失时 AQE 依旧误判 join 策略。
- 说"broadcast join 没有 shuffle 所以一定更快"：广播构建 + 驱动端收集 + 每 executor 内存副本 + 失败重算，规模/带宽不匹配时会明显更慢甚至 OOM。
- 用 UDF 做 join key 计算 → 破坏分区裁剪与统计，且 JVM/Python 往返成本高（4.x 应优先内置表达式或 Arrow UDF）。
- 把"结果偶发不一致"归因于"Spark 不稳定"，而不是 shuffle 数据失效/fetch 重试（4.1 的校验和重试正是为此）。
- 忽略小文件与元数据成本，只盯计算时间；或反过来用 `coalesce(1)`"治小文件"造成单 task 写出巨型文件 + 尾部倾斜。

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=pyspark`，真跑判分）
> **倾斜检测与两阶段聚合去重**
> 给定 `df`（列：`user_id: str`, `item_id: str`, `ts: timestamp`, `payload: map<string,string>`），其中 `user_id='missing'` 的占 92%（构造数据已内置）。
> 要求实现 `dedup_and_agg(df) -> DataFrame`，输出 `(bucket_date, item_id, unique_users)`，语义：按 `ts` 归属 UTC 日期；`unique_users` 为该 item 下去重 `user_id` 计数，但 **`user_id='missing'` 不参与去重计数，而是作为一列单独返回 `missing_users`**（题面会写明输出三列）。
> 硬约束：① 不允许 `collect()`/`toPandas()`；② 必须把 `'missing'` 与非 missing 拆成两个分支处理后再合并（考核"分离热点"手法）；③ 结果必须与参考实现逐行一致（含 `missing_users`）。
> 用例：小样本正确性 ×3、热点样本（92% 倾斜）正确性、以及"同一 item 内 user 重复出现跨天"的边界（考核 ts/日期归属与去重域）。

判分点：能不能想到"热点 key 单拎出来"，以及 `groupBy` 的语义域（天+item）与去重域是否写对。
备选（同一题目可派生 AQE 版本）：`spark.sql.adaptive.enabled` 开/关两组配置，结果必须一致。

### 题面草稿 B（`code`，`judgeKind=pyspark`，写侧优化）
> 给定 `df`（10 万行，`event_date` 分区列，`tenant_id`, `body`），要求实现 `write_partitioned(df, path)`：
> ① 写出为 `parquet`，按 `event_date` 分区，且**同一分区内文件数 ≤ 2**（用 `spark.read` 回读后统计文件数判定）；
> ② 不得用 `coalesce(1)`（判题通过执行计划/记录数验证：单分区数据必须来自多个写任务合并，提示做法为 `repartition("event_date")` 或 `agg`/`merge` 方案，题面给出可选提示）；
> ③ `tenant_id` 为空的行必须落入 `unknown` 子目录（用 `spark.sql.partitionOverwriteMode` 无关，改用 `coalesce` 列生成新分区值）；
> ④ 写出结果必须与输入行数一致且无跨分区泄漏（用回读断言）。
> 用例：文件数断言、空分区值落位、行数一致性、二次运行覆盖不产生重复（幂等写：`mode("overwrite")` + 分区动态覆盖）。

### 题面草稿 C（`rubric`，10 分制）
> **Apple · Senior/Principal Data Engineer（40 分钟）**
> 你在运营一个 3 万+ 作业、日均 6 PB shuffle 读写的 Spark 平台（K8s + 动态资源分配，Spot 抢占率 8%/天；版本分布：3.5.x 占 60%、4.1.x 占 30%、4.2.x 试点）。现状痛点：① 每天约 400 次 stage 因 fetch failed 重算，最长任务被拖到 SLA 外；② 头部 20 个作业贡献 45% 成本；③ 团队习惯"把 `shuffle.partitions` 调到 4096 + 内存加一倍"。
> 给出：shuffle 层架构目标态（ESS/Magnet/远端 shuffle 服务的取舍与量化依据）、倾斜与失败的**分类治理方案**（自动化检测、卡口、回归）、3.5→4.x 升级中 shuffle/流式相关的风险与验证清单、成本治理机制（配额/归因/优化优先级）、以及平台侧 API（怎么让业务方"无法写出不倾斜的作业"）。

**加分点**
1. 用数字定位瓶颈（fetch failed 的分布：哪类 stage、哪类节点、ESS 还是网络），并给出与"重算成本"挂钩的 ROI 排序。
2. 明确"Spot 抢占 → shuffle 文件丢失 → stage 重算"的因果链，并比较 ESS+RocksDB 后端 / Magnet 元数据外置 / 远端 shuffle service（含 Squab/Celeborn 类）三方案的运维与性能代价。
3. 承认 4.x 的默认变化会改变画像（shuffle spill/checkpoint 压缩转 ZSTD、校验和重试、ESS 后端、ANSI 默认、流式 state store），并给出**升级验证矩阵**（正确性对拍 + 性能基线 + 回滚点）。
4. 倾斜治理自动化：per-partition 字节/记录直方图、max/p50 比值卡口、上线前"倾斜体检"、skew join 触发可观测（而非只调阈值）。
5. 成本治理：把 shuffle bytes / spill bytes / GPU-core-seconds 做成作业级指标并按团队归因；建立"优化前必须先去除重复物化与无用列"的顺序；给出至少两个真实降本方向与量化区间。
6. 平台侧防错：模板化 ETL 框架（自动分区合并、强制 `approx_*` 函数、内置 sink 幂等/upsert）、SQL lint（禁用 `collect`、要求显式分区裁剪）、查询级资源配额。
7. 提到 AQE 的真实边界（合并 ≠ 倾斜、膨胀型倾斜、UDF/统计缺失导致的计划期误判、需要 `ANALYZE`）。
8. 对"4096 分区 + 双倍内存"给出反证（driver MapStatus 与 task 固定开销、小文件、SLA 反而变差）并给出正确定容方法（目标单 task 输入 ~ `advisoryPartitionSizeInBytes` 量级）。
9. 失败恢复与值班：stage 重试预算、幂等写（分区级 overwrite / 主键表 upsert）、补数与双跑对账手册。
10. 演进路线：把 3.5.x 长尾作业迁到 4.x 的分批策略（按依赖拓扑 + 成本权重 + 高风险资金/合规作业单独通道）。

**不足点**
- 只有"加参数清单"，无机理与判据。
- 把 Magnet/ESS/远端 shuffle 混为一谈，或不知道 K8s 动态分配下为什么需要 ESS。
- 声称"AQE 打开就自动解决倾斜"。
- 无升级验证/回滚计划；无成本归因机制。
- 不谈小文件与元数据（listing/请求计费）成本。
- 建议 `coalesce(1)` 治小文件。

### 题面草稿 D（`code`，`judgeKind=pyspark`，概念辨析式短题）
> 给定含重复 key 的右表，实现 `fix_exploding_join(left, right)`：输出与左表**行数完全一致**（判题断言 `count` 与左表相等），字段取右表按 `updated_at` 最新一条（同时间戳时按 `id` 最大）。要求不得用 `collect_list` + 展开（内存爆炸），并给出你选择的方案（`row_number` 窗口 vs 预聚合 `max(struct)`）及其 shuffle 代价说明（说明写在代码注释里，判题不看注释，但 rubric 版会看）。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Apple | Senior/Principal Data Engineer, Big Data Platform | "Deep expertise with Apache Spark internals and performance tuning at petabyte scale"; "Optimize cost and reliability of large-scale processing" |
| Apple | Data Engineer, Analytics Infrastructure | "Build and operate ETL frameworks; drive best practices and guardrails" |
| Airbnb | Senior Data Engineer, Growth/ML Data | "Design scalable, cost-efficient pipelines with Spark and Kafka"; "Mentor on performance and data quality" |
| Airbnb | Staff Data Engineer, Platform | "Own platform upgrades and migrations (Spark/Hive/lake formats) with measurable cost and reliability outcomes" |
