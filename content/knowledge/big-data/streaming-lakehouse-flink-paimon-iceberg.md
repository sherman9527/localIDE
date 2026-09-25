# 实时链路与湖仓：Flink 2.x + Iceberg v3 / Paimon + 流批一致

对应考点：`flink-state-runtime`、`flink-time-windows`、`flink-cdc`、`iceberg-internals`、`paimon-lsm`、`lakehouse-selection`、`stream-ingest-contracts`、`backfill-reprocessing`
适配难度：senior / principal｜出题形式：**Flink 一律 `rubric + llm-rubric`（不做真跑判分）**；湖仓维护/回溯类可 `code + pyspark`
版本基线：Flink 2.0（2025-03，分离式存算 ForSt、Java 17 基线、内部 API 收敛）→ 2.1（2025-06）→ 2.2.0（2025-12-04，`VECTOR_SEARCH`、AI 推理/异步 Python、均衡调度、物化表不再强制 `FRESHNESS`）→ **2.3.0（2026-06-25，`FROM_CHANGELOG`、原生 S3 FS、自适应分区等，细项需核实）**；Apache Flink Agents 0.2.0（2026-02-06）。Iceberg 1.10.0（v3：row lineage、deletion vectors GA、default values）、1.11.0（2026-05）。Paimon 文档当前 1.4（global index / 多模态 BLOB+VECTOR 方向，GA 状态需核实）。

---

## 1. 核心机制

### 1.1 状态与一致性（Flink 侧必须讲到的四层）
1. **状态后端**：HashMap（堆内，低延迟小状态）/ RocksDB（堆外，大状态 + 增量 checkpoint）/ ForSt（2.0 起的分离式：状态在远端对象存储 + 本地缓存，checkpoint 变成"刷盘 + 提交清单"，扩缩容与恢复代价结构改变）。追问点：本地盘 IO、读写放大、恢复时长、代价是 p99 延迟抖动。
2. **checkpoint 机制**：barrier 对齐（aligned）与 unaligned（缓冲也快照，抗反压但状态更大）；`minPauseBetweenCheckpoints`/`tolerable-failed-checkpoints`；文件合并与增量的空间放大；**checkpoint 时长 = 反压与业务延迟的放大镜**。
3. **恢复语义**：源可重放（Kafka offset 进 checkpoint）+ sink 两阶段提交（`TwoPhaseCommitSinkFunction`/文件/湖仓 sink 的 committer，随 checkpoint 提交）→ 端到端 exactly-once；若 sink 无事务，则退化为 at-least-once + 下游幂等（主键 upsert）。
4. **扩缩容**：`maxParallelism` 决定 key group 数，之后不可改（改需重新映射状态/savepoint 迁移）；rescaling 的状态分布与倾斜（`state.backend.local-recovery`、热点 key 的 state 大小）；2.x 的 AdaptiveScheduler / 水位对齐（需核实到小版本行为）。

### 1.2 事件时间与乱序
- watermark = "我确认不再有早于该时间戳的事件"，来自源或 `withIdleness`；**迟到程度分布必须由数据测出来**（事件时间与摄入时间差值 p50/p99/max 直方图），不是"给 5 分钟"。
- 允许迟到三件套：watermark 延迟、`allowedLateness`（保留窗口状态再触发）、侧输出（超迟数据落地待回填）；early fire（`.trigger(...Every(...)`）+ 累计触发决定"报表数字会不会往回涨"，业务能否接受是产品问题。
- 多跳传播：join/union 之后的 watermark 由最小输入决定，一条停滞的流会让整体 watermark 卡住（idle 检测必配）。
- 2.3 的 `FROM_CHANGELOG`（把 changelog 流当表读）与湖仓 changelog 消费天然衔接：细节需核实。

### 1.3 CDC：从库到湖
- 无锁增量快照（chunk 切分 + 高水位对齐 + 快照与增量合并）取代"停写全量 + 追增量"；边界问题：切分键不唯一/无主键表、大事务造成延迟尖刺、DDL 期间的 schema 冲突。
- Schema 演进策略：加列可自动传播；**改类型/改名/删列**必须显式（重命名在下游是"新列 + 老列变 null"的静默错误）；类型放宽（int→bigint）安全，收窄危险。
- 落地形态：Flink → Paimon/Iceberg 主键表（upsert + deletion vectors）；或 Flink → Kafka（changelog envelope，`op` 字段）→ Spark/StarRocks/Doris 消费。要点：**湖表主键与分桶决定写放大与点查能力**。
- 全量回填与增量并行的正确性：以"回填前快照时间点"为界，重叠区间用 version/`sequence.field` 裁决，禁止靠 `max(updated_at)`（源库时间可回拨、批量改数会带旧时间）。

### 1.4 湖仓侧的实时化能力
- **Iceberg v3**（1.10.0 起）：deletion vectors GA（MOR 读不再靠逐条位置删除文件、读放大显著下降）、row lineage（每行可追到创建/更新它的提交，跨区复制校验与"这行什么时候变的"变成可查询能力）、default values、新类型（variant/geo，需核实到发行说明）。
- 维护作业是产品的一部分：`rewrite_data_files`（bin-pack/sort/z-order）、`remove_orphan_files`、`expire_snapshots`（保留策略与时间旅行窗口冲突）、manifest 压缩；Paimon 侧是 `compact` / `full compaction` / `sort compact` + `snapshot.time-retained` + `num-sorted-run.stop-trigger`（写阻塞的真实来源）。
- changelog 生产者（Paimon）：`input`（上游已含 changelog）vs `lookup`/`full-compaction`（自己生成），决定下游能否流读且不做全量 diff；这是"Flink 写 Paimon → 下游流读"最常见的坑。
- 多引擎读写矩阵（选型必问）：Spark/Flink/Trino/StarRocks/Doris/ClickHouse 对 v3 特性、时间旅行、MERGE、行级权限的支持进度不一——**答"都支持"是危险信号**，需给出核实路径（版本、发行说明、灰度验证）。
- Catalog：HMS → REST catalog（Iceberg REST / Polaris / Lakekeeper 类）迁移与锁语义（并发提交冲突、跨引擎原子性依赖 catalog 的条件写能力）。

### 1.5 流批一体与"口径一致"
- 同一份定义（SQL / 语义层 / 特征定义）同时驱动流与批：Airbnb Chronon 的"batch + streaming 窗口聚合定义 + 在线物化"是这套思路的代表；Spark 侧靠 Structured Streaming（同一 DataFrame API）+ 4.2 `CHANGES`/Auto CDC；Flink 侧靠物化表/统一 SQL。
- 双跑对账：同一时间窗口的流结果 vs 批结果（"批为真值"），差异率阈值与差异样本落库分析；不一致常见原因：迟到（批能等、流不等）、去重窗口 vs state TTL、时区/日切、维表快照 vs 时点 join（temporal join 用事件时间，普通 lookup join 用当前值——差异会在"维表当天被改"时暴露）。
- 回溯（backfill）：流作业加字段后必须"新流 + 回填同一 sink 幂等 upsert"；state schema 演进是难点（新字段有默认值；不能依赖 Flink 自动迁移不兼容状态，必要时用 `ProcessFunction` + 兼容序列化器或"双跑 + 切换"）。

---

## 2. senior / principal 会被追问什么

1. "你的 watermark 与 state TTL 分别是多少？怎么定出来的？数据重放（补一天）时会发生什么？"
2. "checkpoint 从 30s 涨到 8min，你的定位顺序？"（对齐时间 vs 快照大小 vs 上传带宽 vs 反压；看 barrier 对齐时长、state size 增长、RocksDB compaction/IO 争抢、下游 sink 慢导致的反压）
3. "作业改并行度从 16→64 会发生什么？`maxParallelism` 设成 128 有什么后患？"（key group 重分布、恢复时间、状态倾斜）
4. "端到端 exactly-once 你怎么验证？"（故障注入 + 双写对账；知道 EOS 不防"业务重复"（同一业务事件被上游发两次））
5. "Iceberg v3 的 deletion vectors 与 Paimon 的 LSM 主键表，你怎么选？"（写放大/读放大/点查/下游生态/compaction 归属/引擎兼容矩阵）
6. "上游 MySQL 改了列类型，你的湖表和 BI 会怎样？防线在哪层？"
7. "全量回填期间增量还在写，怎么保证不错序/不丢删？"（快照点 + version 字段 + tombstone + 对账）
8. "Paimon 作业出现 '写触发 stop-trigger 被阻塞'，你怎么处理？"（compaction 并行度/资源、full compaction 时段、sorted-run 上限与反压的因果）
9. "流作业的 cost 怎么算？state 大小与恢复时间对成本的影响？"（K8s 上常驻资源、对象存储请求费、compaction 与查询读放大）
10. "你会不会用 Flink 做这个？为什么不用 Spark RTM / Kafka Streams / 裸消费者？"（期待：状态规模与延迟要求、团队运维能力、生态（SQL/CDC/连接器）、Exactly-once 需求强弱）

---

## 3. 常见错误答案

- "开 unaligned checkpoint 解决反压" → 反压是下游容量问题，unaligned 只是让 checkpoint 不再被卡住，且增大状态、延长恢复。
- "watermark 设 5 分钟，因为我们业务差不多"（无分布测量；不知道多流 union/join 的 watermark 卡住问题）。
- "有 checkpoint 就有 exactly-once"（sink 无事务时不成立；不知道 EOS 挡不住上游重复业务事件）。
- "`savepoint` 什么都能恢复"（不兼容状态迁移、并行度/`maxParallelism` 限制、UDR/POJO  serializer 漂移、跨小版本兼容性需核实）。
- "Iceberg 就是 Parquet + 元数据，所以随便多引擎写没问题"（并发冲突与 catalog 锁语义、隐藏分区/演进后的 partition spec 混用导致读放大、不同引擎对 v3/删除文件支持不一）。
- "Paimon 就是流式版 Iceberg"（主键 LSM、changelog producer、lookup/排序写放大是另一套权衡；下游流读语义取决于 changelog 生产者）。
- 把维表 join 写成普通 join（当前值），在"维表当天变更"时和批结果不一致 → 应 temporal join / 版本化维表。
- 用 `max(updated_at)` 做增量：丢删除、丢回拨、批量修数取不到；应 CDC + version/序列字段。
- 时间旅行/快照过期与合规保留冲突没处理；或 `expire_snapshots` 与长查询/流读冲突导致"读取的快照被清理"。

---

## 4. 出题角度

### 题面草稿 A（`rubric`，10 分制；Flink 主观题）
> **Airbnb · Senior/Staff Data Engineer, Real-time（40 分钟）**
> 你要把"每晚 T+1 的房晚（night-stay）指标"改为"5 分钟新鲜度"的实时链路。源：MySQL 分库分表（64 个逻辑分片）+ Kafka 事件流（预订、取消、改期、价格变更）；下游：BI 看板（含 40+ 维度、去重类指标）、实验平台（分钟级 SRM 检查）、财务对账（不可出错）。当前批链路 6 年积累、口径复杂（取消要回溯原预订、跨时区日切、税费与优惠券分摊）。
> 请给出：链路拓扑与选择（Flink SQL vs DataStream vs Spark 流 / 湖仓主键表）、事件时间与 watermark/状态 TTL 的**确定方法**、CDC 与 Kafka 双源的合并与去重、维表/口径一致性策略（temporal 版本化）、回溯与新旧双跑对账方案、故障恢复与运维（checkpoint/savepoint/扩缩容）、以及"哪些指标你明确不做实时"的判据。

**加分点**
1. 先做**口径拆解**（定义/计算/时间口径/边界），并指出"财务对账口径"与"BI 实时口径"必须分列，不追求同源同定义。
2. watermark/延迟由数据测：给出"事件时间-摄入时间差分布 + 分片乱序程度 + 上游批任务延迟"的测量方案，据此定 allowedLateness + 侧输出 + 回填窗口。
3. 双源合并：MySQL CDC（结构化事实）+ Kafka 事件（行为）用统一主键 + version/序列字段裁决，删除/改期用 tombstone；明确拒绝 `max(updated_at)`。
4. 落地形态有取舍依据：湖仓主键表（Iceberg v3 deletion vectors 或 Paimon LSM）供 BI/财务批式重算，OLAP（Doris/StarRocks/ClickHouse）供分钟级看板；说明各自 compaction/写放大与查询模式代价。
5. 维表版本化 + temporal join，避免"维表变更污染历史"；说明历史修数如何触发下游重算（滚动 N 天窗口 + 分区覆盖幂等）。
6. 双跑对账有硬判据：主键集合一致、指标差异率 < 阈值且差异样本可解释（迟到/日切/去重窗口），连续 K 天放行才切流；回滚点与影子看板。
7. 状态与恢复工程：state 大小估算（按 key 数 × 平均状态）、checkpoint 时长/失败预算、`maxParallelism` 预设与扩缩容路径、savepoint 跨版本兼容的验证计划（注明需核实小版本）。
8. EOS 边界讲清：湖表主键 upsert 提供"效果一次"，事务提交与快照可见性（reader 看到的部分提交）如何避免；故障注入测试用例。
9. 成本与运维：常驻资源 vs 夜间批的错峰、compaction 预算、值班手册、SLA 指标（新鲜度分位数而非均值）。
10. 明确不做实时的清单与理由（高基数去重指标、需长回溯的财务口径、月结类），并给出"改伪实时（5 分钟微批）"的替代方案。

**不足点**
- 上来就写 Flink SQL 开窗，不谈口径与迟到分布。
- "端到端 exactly-once"当作免费午餐，忽略 sink/湖表可见性。
- 用当前维表值 join，历史会漂移。
- 无双跑对账与放行判据（直接切）。
- 未处理删除/改期/取消回溯。
- 忽略 compaction/写放大与成本；或对 state 大小完全无感。
- 声称所有引擎都完美支持 Iceberg v3/Paimon 新特性（无核实路径）。

### 题面草稿 B（`code`，`judgeKind=pyspark`，湖仓维护/回溯可判分）
> 给定"带删除与更新的订单变更集"（内存表，列 `id, status, amount, version, op('I'|'U'|'D'), event_ts`），实现 `materialize(base, changes) -> DataFrame`：
> ① 按 `id` upsert，`version` 单调裁决（**小于等于已落库 version 的变更必须忽略**，模拟迟到旧版本）；
> ② `op='D'` 后该行不再出现在结果，但保留 tombstone（题面给定 `__deleted` 列需置 true 且不删除，供下游重放）；
> ③ 输出按 `id` 排序；④ 幂等：对同一 `changes` 重复执行两次结果一致。
> 用例：乱序版本、同版本重复、删除后复活（更高 version）、null version（视为 0 并计数进 `skipped_count`）。
> （注：单机用 parquet 或内存表模拟主键表语义，判题看结果与幂等，不要求真实 Iceberg catalog。）

### 题面草稿 C（`rubric`，短题，8 分钟内答完）
> 一句话题："同一个 Kafka topic 有 3 个下游：一个 Flink SQL 聚合、一个 Spark Structured Streaming 写湖、一个裸消费者推送到外部 webhook。上游开始偶发发送重复记录（同 `event_id` 不同 offset）并新增了枚举值 `CANCELLED_LATE`。请分别说明三者会怎样坏，以及你最少要做的三件事。"
> 期望：offset 级去重 vs 业务级去重的区别；Flink state 幂等键/窗口重复计数；Spark `dropDuplicates` 与 state TTL 过期后的重复；webhook 的外部副作用必须自有幂等键；新增枚举值导致下游 `CASE` 落入 else 分支的静默错分——需要 `UNKNOWN` 兜底 + 质量规则告警 + 契约通知。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Airbnb | Senior/Staff Data Engineer, Real-time / ML Data | "Design low-latency, high-reliability streaming pipelines"; "Ensure consistency between offline and online data" |
| Airbnb | Senior Data Engineer | "Own data quality, lineage, and SLAs for production datasets" |
| Apple | Data Engineer, Device Telemetry / Big Data Platform | "Experience with streaming systems (Kafka/Flink/Spark) at massive scale"; "Cost and performance optimization of data infrastructure" |
| Apple | Principal Data Engineer, Lakehouse Platform | "Drive lakehouse architecture (open table formats, catalogs, compaction governance) across organizations" |
