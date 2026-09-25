# 【阿里巴巴】数据与存储：实时计算与湖仓、OLAP 选型、云原生数据库、指标口径与数据质量

来源公司：**阿里巴巴 / 阿里云（含阿里主导进入 Apache 的项目：Flink、Paimon、RocketMQ；与 OceanBase）**｜岗位方向：Senior/Staff Data Engineer（实时数仓 / 湖仓 / OLAP 平台 / 数据治理）、大数据平台研发、数据架构师
对应考点：`alibaba-realtime-warehouse`、`alibaba-lakehouse-paimon`、`alibaba-olap-selection`、`alibaba-cloud-native-db`、`alibaba-metric-definition`、`alibaba-data-quality`
公开可引用的技术脉络（本文件全部考点都落到 §6 **实际抓取过**的来源，编号 D1…D29）：Apache Flink 官方文档（stateful stream processing / working with state）、阿里云实时计算 Flink 版《高性能 Flink SQL 优化技巧》与《企业级状态后端存储配置（Gemini）》、Apache Paimon 主键表文档（Table Mode / Changelog Producer / Merge Engine / Partial Update）、Apache Flink CDC MySQL Connector 文档、阿里开源 Canal、阿里云 Hologres / MaxCompute / SLS / DataWorks / Dataphin 官方文档、OceanBase 系统架构文档、PolarDB / PolarDB-X 官方文档、Apache RocketMQ 5.0《功能特性》文档族。

**读法提示（重要）**：可核查的是**开源项目的机制与云产品的能力/限制**，不是"阿里内部数仓怎么分层"。凡是"双 11 大屏的实时任务数""内部 OneData 白皮书的具体规范""某引擎的真实性能倍数"，公开渠道没有可核查出处，本文件一律不写（见 §7）。所有题面数字必须显式标注为假设并给测量方法。另注：Flink / Paimon 的 Scala/Java 与流式机制在本仓库判题栈里只能走 `llm-rubric`（无 Flink 判题器），而 `pyspark` / `spark-scala` 只用于"**把同一机制等价重写成可判题的 Spark 题**"——阿里官方并没有给出 Spark 侧的可核查实现，凡此类别都按【推】标注。

---

## 1. 核心机制（面试里必须能画出来的链路）

### 1.1 端到端链路（"实时"是四段延迟之和，不是一个开关）
```
业务库/日志 → CDC 采集（Flink CDC 增量快照 / Canal 伪装 slave）
  → 消息总线（RocketMQ：顺序、堆积、存储时长=可回溯窗口）
  → 流计算（Flink：checkpoint / 状态 / SQL 算子选择）
  → 湖仓主键表层（Paimon：table mode + changelog producer + merge engine）
  → 服务层（Hologres：列存做 OLAP、行存做点查 Serving；或 MaxCompute 做离线对账层）
  → 指标与看板（Dataphin 规范定义 → 派生指标 → 语义层）
横切：DQC 强/弱规则与阻塞、血缘与资产定级、成本口径（扫描量 / Shard / 存储时长）
```
- **"端到端 exactly-once" 是三段拼出来的**：Flink 侧靠 checkpoint 恢复状态 + 重放（"Flink 停止分布式数据流、重启到最近 checkpoint、按记录重放"），而 checkpoint 间隔本身是"容错开销与恢复时间（需重放多少条记录）之间的折中"【源 D1】；出湖/出仓那一段必须靠**两阶段提交的 sink** 或幂等写【推】；消息总线那一层根本不是 exactly-once（见 §1.3）。所以面试里"我们做到了端到端精确一次"必须被拆成"每段的语义 + 谁负责去重"【推】。
- barrier 语义要能背：barrier 被注入数据流、随记录一起流动、**永不超越记录**；对齐检查点（aligned）与非对齐检查点（1.11 起）并存——这意味着"反压严重时对齐检查点会拖慢快照"是机制推论【源 D1】。
- 新鲜度必须用分位数而非均值表达，并且每一层有独立 SLA：接入（Shard/位点）→ 计算（checkpoint 完成时间与 last-send 延迟）→ 表（commit 频率 + compaction 延迟）→ 查询（看板与点查分开）【推】。

### 1.2 状态与 TTL：最容易"看起来对"的两处
- Flink 官方对 State TTL 的三条硬约束：① "**目前只支持以处理时间（processing time）为参照的 TTL**"；② "**TTL 配置不属于 checkpoint 或 savepoint，它只是 Flink 在当前运行的作业里处理状态的方式**"；③ 开启 TTL 后 StateDescriptor 的 `defaultValue` 不再生效（需业务自己管理"为空或已过期"的默认值）；此外 list/map 元素支持**逐条目** TTL，默认更新语义是 `OnCreateAndWrite`，而"读取是否刷新时间"是可选项（并在需要"超过 TTL 后严格不可读"时要显式配置），代价之一是"compaction 时调用 TTL 过滤器会拖慢 compaction"【源 D2】。
- 与 Flink 语义**不一致**的地方要能点名（这是真做过的信号）：阿里云 Gemini 状态后端文档写明"**如果修改 TTL 后从快照恢复，新的 TTL 配置只会对新写入的数据生效，旧数据仍然沿用旧的 TTL 配置**"【源 D4】——即"改 TTL 不会立刻清洗历史状态"，而 `State TTL`（作业级）与 `state.backend.gemini.*` 的调优又是两码事。
- Gemini 侧的可核查点：整体基于**自适应调参**（多数场景不需要手动配）；三条定向调优入口分别是"协调内存与性能 → 内存配置""**本地盘空间不足 → 存算分离配置**""**Join 算子性能瓶颈 → KV 分离配置**"；`gemini.memory.managed=true` 时按 Managed Memory 与 task slot 数自动算每 Backend 内存，设 false 才由 `total.writebuffer.size + offheap.size` 决定【源 D4】。→ 追问"状态膨胀先撞哪个墙"：内存→换 writebuffer/offheap；本地盘→存算分离；Join 慢→KV 分离。三条对应三种瓶颈，说错就是没调过【源 D4】。
- 扩缩容与 checkpoint 的耦合在 Paimon 侧也有官方提醒："在 Flink 里 `execution.checkpointing.max-concurrent-checkpoints` 会影响吞吐，当 checkpoint 完成需要等待 compaction 时"，且"对 lookup / full-compaction 生产者，过短的 checkpoint 间隔叠加大量分桶会产生大量小文件与 compaction 压力"【源 D6】。→ 结论：**表格式的选择会把延迟成本转移给 checkpoint/compaction**，这是湖仓题的核心【推】。

### 1.3 实时 SQL 的算子级优化：倾斜、去重、TopN（阿里云文档给的是一整套可判题的规则）
- MiniBatch：定义为"缓存一定的数据后再触发处理，以**减少对 State 的访问**，从而提升吞吐并减少数据输出量"，基于事件消息按指定间隔在源头插入；**默认关闭**，开启要写 `table.exec.mini-batch.enabled=true` + `allow-latency`（文档示例 5s）；官方取舍是"微批通过增加延迟换高吞吐，有超低延迟要求就不建议开"【源 D3】。
- LocalGlobal：把聚合拆成 local（上游节点攒一批聚合、输出本微批增量 Accumulator）+ global（合并 Accumulator）两阶段，"本质靠 LocalAgg 筛除部分倾斜数据，降低 GlobalAgg 的热点"；**默认开启但有两个前提**——"在 minibatch 开启的前提下才能生效""需要使用 AggregateFunction 实现 Merge"；生效判据是拓扑图节点名出现 `LocalGroupAggregate`/`GlobalGroupAggregate`【源 D3】。
- PartialFinal（`table.optimizer.distinct-agg.split.enabled`）：专门解决 **COUNT DISTINCT** 热点——"LocalGlobal 对普通聚合效果好，对 COUNT DISTINCT 收效不明显，因为 local 阶段对 distinct key 去重率不高，Global 节点仍然热点"；官方明确"不能用于含 UDAF 的作业；数据量少的情况不建议用（会自动多打散一层聚合、引入额外网络 Shuffle 浪费资源）"；默认不开；判据是"拓扑图由一层聚合变成两层"【源 D3】。
- 多维 UV 的写法优化：用标准 `AGG WITH FILTER` 代替 `CASE WHEN`，"优化器能分析出 Filter 参数，同一字段上不同条件的 COUNT DISTINCT 可以**共享 State**，减少 State 读写；性能测试中使用 FILTER 语法能使**性能提升 1 倍**"【源 D3】。
- TopN 算法名会出现在拓扑图节点上，且是可诊断的：输入非更新流（例如 SLS 数据源）只有 `AppendRank`；输入更新流（经过 AGG 或 JOIN）有两种，性能从高到低 `UpdateFastRank` > `RetractRank`，`RetractRank` 是"保底算法"，要满足 3 个条件才能升级成 `UpdateFastRank`【源 D3】。→ 面试点：**看算子名就能定位为什么慢**，比"加并行度"高一档【源 D3】。
- Delta Aggregation 的 MiniBatch 与缓存：MiniBatch 会"合并同一批次内相同分组键的变更，使每个分组键一批次内**最多发起一次 Lookup**"；开启 Delta Agg Cache 后"缓存命中时无需再次 Lookup"，但**源表必须定义主键**（Flink 用主键标识与更新缓存中的明细）且 `table.exec.delta-agg.cache-size` 必须 > 0【源 D3】。
- 还有两条"随手可用"的：`KEYVALUE` 在分隔符为单字符（如 `:`、`,`）时走二进制直查、不整体切分，"性能约提升 30%"；`SQL Hints` 可在 planner 拿到的计划元数据不准时（例如"一些 shuffle keys 的倾斜信息"）手工补统计信息【源 D3】。

### 1.4 CDC 与总线：把库表变更安全地搬到下游
- 全量 + 增量的切换（Flink CDC 增量快照框架）：快照按用户指定的 **chunk key** 切分成 chunk（默认是主键第一列）；官方给了两条硬警告——"**使用非主键列作为 chunk key 可能导致数据不一致**"、以及 chunk 粒度可 checkpoint（"snapshot reading 期间 source 可以按 chunk 粒度做 checkpoint"）；还有一条实用开关 `scan.incremental.snapshot.unbounded-chunk-first.enabled`：先分配无界 chunk，"可以降低在对最大无界 chunk 做快照时 TaskManager OOM 的风险"【源 D9】。→ 三条分别对应：**正确性、可恢复性、稳定性**，是"读没读过文档"的最快验证【推】。
- 老路线（Canal，阿里开源）原理是可背的：MySQL master 把变更写入 binary log → slave 拷到 relay log → 重放；**canal"模拟 MySQL slave 的交互协议，伪装自己为 MySQL slave，向 master 发送 dump 协议"**，master 收到 dump 请求后推送 binlog，canal 解析 byte 流；支持 5.1.x–8.0.x；1.1.x 版本"整体性能测试 & 优化，提升了 150%"、原生支持 Prometheus 监控、原生支持 Kafka 投递、**原生支持 Aliyun RDS 的 binlog 订阅（解决自动主备切换 / OSS binlog 离线解析）**【源 D10】。→ 最后这条就是"云上主备切换导致位点断裂"的官方解法描述【源 D10】。
- 总线侧的顺序与可回溯：官方把"**数据实时增量同步**"（上游源库执行增删改、把二进制操作日志作为消息传给下游搜索系统、下游按序还原状态）写成顺序消息的第一类场景，并明确"用普通消息可能导致状态混乱、与预期操作结果不符"；同时给出顺序的判定单位是 **MessageGroup**、生产顺序性要求**单一生产者 + 串行发送**、"不同消息组的消息可以混在同一队列且不保证连续"【源 D26】。
- 可回溯窗口由存储决定：消息"在存储时长范围内都会被保留，**无论消息是否被消费**；超过时长限制的消息会被清理"，且按**存储节点粒度**管理；位点侧则"消费位点由服务端存储、支持跨消费者恢复；若历史位点已过期被删除，服务端会把消费位点强制纠正到最小位点"；重置位点用于"业务回溯、纠正处理"，但历史消息多属冷数据会引发**冷读**压力，且**不能重置定时中、重试等待中的消息**【源 D28】【源 D29】。→ 数据工程口径：**回溯能力 = min(消息存储时长, 表侧快照/tag 保留期, 湖上历史分区)**，三个都要写进 SLA【推】。

### 1.5 湖仓主键表：三件事互相独立（table mode / merge engine / changelog producer）
Paimon 文档把三者划得很干净，面试要能复述这个正交性：changelog producer"控制流读能看到什么变化"，merge engine"定义表的逻辑行"，table mode"决定这些行如何存储与读取"【源 D6】【源 D7】【源 D5】。
- Table Mode（读放大 vs 写放大的选择）：

  | 模式 | 配置 | 读路径 | 主要代价 |
  |---|---|---|---|
  | Merge On Read | 默认 | 合并重叠的有序 run 后返回 | **读 CPU/内存随重叠版本数增长** |
  | Copy On Write | `full-compaction.delta-commits = 1` | 直接读全量压实结果 | 频繁全量 compaction → 写放大 |
  | Merge On Write | `deletion-vectors.enabled = true` | 读文件并跳过无效行位置 | 写入侧需查旧行并维护删除向量 |

  官方建议"典型 deduplicate 表 + 频繁分析读 → 考虑 MOW；偏写吞吐 → MOR；能承担每次提交都全量压实 → COW"，并要求"评估更新率、读延迟、compaction 资源后再选"【源 D5】。
- **正确性陷阱（本文件最值钱的一条）**：分桶"把数据约束在同一并行度上，使 bucket 大小成为关键设置"；并且"**对可变非键列的过滤通常不能在合并前下推**——旧行 `status='open'`、新行 `status='closed'`，过早按 `status='open'` 过滤文件会丢掉替代行、错误地返回旧行；reader 必须先解析重叠版本"【源 D5】。→ 这就是"实时看板昨天还对、今天多了 3% 的单"的机制级解释之一【推】。
- COW 的连带限制要一并记住："`full-compaction.delta-commits=1` 请求每次提交后对受影响分桶做同步全量压实（Flink 流写时按 checkpoint 计数），并不是每输入一行就压实"；且"**lookup changelog producer 与 `full-compaction.delta-commits` 不兼容**"【源 D5】【源 D6】。
- Changelog Producer 四选一（选择表可直接背）：

  | 生产者 | 旧值来自哪里 | 变更何时可见 | 什么时候用 |
  |---|---|---|---|
  | `none`（默认） | 需要时由消费者自己的状态补 | 增量快照读 | 下游能接受 upsert 或自行归一 |
  | `input` | 上游已提供完整 changelog | 输入的 changelog 文件提交后 | 上游（CDC）本来就带 before/after |
  | `lookup` | compaction 期间回查已有行 | lookup compaction 提交后 | 输入没有前镜像、消费者需要完整变更 |
  | `full-compaction` | 两次全量压实结果之差 | 全量压实提交后 | 消费者可接受周期性的较长延迟 |

  补充四条细节：完整 changelog 必须包含"用于撤回更新的那一旧行"（4→5 需要下游先减 4 再加 5）；**deletion-vector 表支持 none/input/lookup，不支持 full-compaction**；`none` 模式下"增量读暴露的变更不含完整前镜像，不是每条输入的审计日志"，Flink 可以在需要旧值时加**有状态的 normalize 算子**，但其状态与 checkpoint 成本取决于键数量与工作负载，**不要为了省掉它而删掉完整 changelog**；`lookup` 的产出是"表状态变化的 changelog，不是源事件的副本"，`full-compaction` 则会**折叠**中间更新；三个 filter 开关（`changelog-producer.row-deduplicate` / `ignore-update-before` / `ignore-delete`）会**改变消费者契约**，"只有下游能处理裁剪后的流时才开"【源 D6】。
- Merge Engine 四种：`deduplicate`（默认，保留最新行，最新一条 retract 会移除该行）、`partial-update`（非 null 值覆盖对应字段，null 保持不变；sequence group 可让独立流给自己的字段排序并可显式置 null）、`aggregation`（每个值字段按配置函数聚合）、`first-row`（保留首行、忽略后续，用于事件/日志去重）；"latest 依 Paimon 的记录顺序，若到达顺序不代表业务顺序就要配 sequence field"【源 D7】。→ 宽表打宽（多流各写一部分列）是 **partial-update 替代多流 join** 的标准解法，且官方例子就是"商品的价格、数量、描述分别到达"【源 D8】；但注意"下游 retract 聚合需要前镜像/删除记录才能算对"，与上面 changelog 裁剪冲突【源 D6】。

### 1.6 服务层选型：Hologres 的"一张表四种索引 + 两种存储"
- 定位（可直接引的官方定义）："Hologres 是**阿里巴巴自主研发的一站式实时数仓引擎**，支持海量数据实时写入、实时更新、实时加工、实时分析，兼容 PostgreSQL 协议和语法，支持 **PB 级多维分析（OLAP）与即席分析**，支持**高并发低延迟的在线数据服务（Serving）**，支持多种负载的细粒度隔离，与 MaxCompute、Flink、DataWorks 深度融合，提供离在线一体化全栈数仓方案"【源 D14】。→ 一句话选型判据：**同一份数据既要被聚合分析又要被高 QPS 点查时**才需要这类引擎，否则别引入【推】。
- 存储格式：`orientation='column'`（"海量聚合分析首选，高压缩比与高效列扫描"）/ `'row'`（"**专门为基于主键的点查 Point Lookup 优化，响应速度可达毫秒级**"）/ 行列共存（混合负载场景）【源 D11】。
- 主键索引的实现值得背：**系统自动在底层保存一个主键索引文件，采用行存结构**，Key = 表主键，Value = **RID（每次 UPSERT 自动生成、单调递增）+ 聚簇索引**；"主键索引文件能实现高效的主键冲突判定并辅助数据文件定位"；因此设了主键就能做"整行写入更新、**部分列写入更新**"的高性能 UPSERT（按主键更新、不全表扫描），也能支持高 QPS 主键查询；行存表上主键默认同时是 Clustering Key 与 Distribution Key，故"通过主键定位数据文件、实现超高 QPS 主键点查、延迟毫秒级，适用于实时风控、实时推荐"【源 D13】。反面建议也是官方的：**不建议把 Serial 类型设为主键**（写入时是表锁、性能损失，且随数据增长长度易溢出）【源 D13】。
- 四类表属性按查询模式配（官方建表示例就是一张交易订单明细表）：`distribution_key='order_id'`（分片存储，默认取主键、建议只选一列且是主键子集）、`clustering_key='order_time:asc'`（文件内排序，默认为空、建议最多一列且只支持升序）、`event_time_column='order_time'`（**分段键**，默认为第一个非空时间戳字段）、`bitmap_columns='shop_id,payment_type,is_delivered'`（低基数列等值过滤）、`dictionary_encoding_columns='user_id:auto'`（把字符串比较转成数字比较，加速 Group By/Filter；列存表 TEXT 字段默认参与，V0.9 起按数据特征自动选择）【源 D11】。
- Segment Key（现名 Event Time Column）的适用面被写死：适用于"**含范围过滤条件（包括等值条件）**的查询"与"**基于主键的 UPDATE**"，机制是"数据文件基于该列范围排序后合并、减少文件之间的重叠，使查询能过滤掉尽可能多的文件"【源 D12】。→ 与聚簇索引的区别必须能说清：聚簇索引是文件内排序，分段键是**文件级裁剪**；两者都当范围谓词用会互相顶掉收益【推】。
- 生命周期与冷热：`time_to_live_in_seconds` 从**写入时间**开始算而不是更新时间；不设置默认 100 年；V1.3.24 起最小值为 1 天；V4.2 起有主键表的 TTL 还受 GUC `hg_time_to_live_in_days_min_value`（默认 36500 天，仅 Superuser 可改）约束，无主键表不受限；**"TTL 并非精确时间，生产业务中不建议使用 TTL 来管理数据生命周期，建议采用分区表"**，因为"到期后数据会在某一段时间（不是固定时间）删除（只删数据、表还在），**因此可能出现 PK 重复或者查询结果不一致**"；冷热分层从 V1.3 起通过 `storage_mode` 指定存储介质【源 D11】。→ 这一条同时是"成本题"和"数据质量题"的共同根因【推】。

### 1.7 云原生数据库与分布式存储（把"存算分离"说到机制层）
- PolarDB（PostgreSQL 版）《全局一致性》给了完整的"一写多读 + 共享存储"痛点：物理复制与共享存储"**可以有效降低 RO 节点的复制延迟，但不能保证**发往 RO 的只读请求读到 RW 上最新写入"；RO 默认只有**会话一致性**；文档画出的正是数据链路里最常见的事故：**服务 A 写完 → 通过消息队列通知服务 B → B 读 RO 读到旧值**，于是业务只能把读转回 RW，"RO 节点资源也因此被闲置"；解法是 RW 每个读写事务提交时赋 **CSN（Commit Sequence Number）** 构建高效事务快照（替代原生 PG 的活跃事务列表）、CSN 记入 WAL、RO **回放 WAL 构建完整事务状态**【源 D24】。
- PolarDB-X 侧对下游更关键的是 CDC 与 PITR：DN 的变更日志"在变更日志设计上也会保存分布式事务信息"，通过日志组件"收集、重组、排序、落盘"多 DN 日志流，"**提供满足分布式事务一致性语义的二进制日志**，并全面兼容 MySQL binlog 协议和生态"；对事务日志一致性的下游诉求被明确列成三条（事务不能乱序、事务原子性、DDL 支持同步）；PITR 侧"任意时间点的数据恢复都可以快速将时间戳转化为分布式的全局时钟，按数据的版本可见性处理"【源 D25】。→ 数仓侧的对应推论：**入湖的 binlog 是否带全局顺序，决定下游增量表的正确性**；这也是"为什么要一个专门的 CDC 组件而不是各库分头同步"的答案【源 D25】＋【推】。
- OceanBase（分布式共享存储 / 存算分离的另一路线）：分区（Hash/Range/List，支持二级分区）→ 每个物理分区一个存储层对象 **Tablet**；改动记 Redo 到 **日志流**（"每个日志流用于服务其所在节点上的多个 Tablet"）；日志流及其 Tablet 有多副本且一般分散在不同可用区，只有 Leader 接受修改，副本间"通过基于 **Multi-Paxos** 的分布式共识协议"一致，Leader 故障时从副本升主；租户 / 资源单元 Unit / 资源池做资源隔离；应用侧由 **ODP（OBProxy，无状态 + SLB）**屏蔽分区与副本分布；**共享存储（SS）模式**：每个租户在共享对象存储上存一份数据与日志、在节点本地存热点缓存，主副本上传全量日志与全量基线、副本间共享基线、"所有副本自动识别数据热度仅在本地缓存热点数据"，**每个副本独立转储且转储数据不在副本间共享**【源 D23】。→ 面试问"共享存储省了什么、没省什么"：省容量与副本间基线复制，**没省转储与写放大**【源 D23】＋【推】。
- 与批侧的接口（成本口径，可直接引）：MaxCompute SQL 作业当日总费用 = **计算输入数据量 × SQL 复杂度 × 单价**（公共云按量标准版 0.3 元/GB、金融云 0.57 元/GB），且"**SQL 作业的输入量是以压缩后的量计费**""**执行失败的 SQL 作业不计费**"，第二天 06:00 前按项目维度汇总扣费，并提供"SQL 费用预估方法，提前预估费用防止计费过高"【源 D20】。→ 因此"分区裁剪/列裁剪"不是性能建议而是**账单**；而"跑失败不收费"决定了失败重试的成本模型（但会重复计费**成功执行的部分作业**）【源 D20】＋【推】。
- 日志与时序接入侧的容量模型（SLS）：Shard 用于"控制 LogStore、EventStore、MetricStore 的读写数据能力，数据必定保存在某一个 Shard 中"，通过"分裂、合并操作控制活跃的 Shard 数量来调整最大读写能力"，且**分裂可以自动触发、合并必须手动执行**；每个 Shard 是 MD5 的**左闭右开**区间 `[BeginKey, EndKey)`，创建时指定 Shard 个数即把整个 MD5 范围平均划分【源 D21】。→ 由"左闭右开 + 平均划分"可直接推出热点问题：写入 key 落在同一区间就集中到一个 Shard，而**合并要人工做**，所以"写入倾斜自愈、读取恢复靠人工"【源 D21】＋【推】。查询侧口径："支持秒级查询十亿到千亿级别的日志，并支持通过 SQL 对查询结果做统计分析"，前提是先开启索引【源 D22】。

### 1.8 口径与质量：把"一个数字三种答案"制度性堵死
- 规范定义（Dataphin 官方表述）："以**维度建模**作为理论基础，划分并定义**主题域、业务过程、维度、原子指标、统计周期和派生指标**"【源 D19】；"派生指标用于**圈定原子指标统计业务的范围**"，且其前提是要先完成**业务实体**与**业务限定**的创建【源 D18】。→ 可背的最小口径元组：**原子指标（度量 + 业务过程）+ 业务限定（过滤条件）+ 统计周期 = 派生指标**；缺任一项，两个团队就会算出不同的"支付金额"【源 D18/D19】。
- 数据质量（DataWorks DQC）的实体模型：规则模板（定义怎么查，内置"表行数、字段唯一值个数"等，也可自定义）→ 监控规则（模板在具体表/字段上的应用 + 阈值）→ **质量监控**（执行计划，把一个或多个规则与一个调度任务关联，该调度节点运行成功后自动触发校验）→ 强/弱规则与阻塞【源 D15】。
- 最硬的一条是**阻塞语义**：规则属性含"阈值（例如波动率不超过 30%）与严重等级（强规则/弱规则），**强规则校验失败时具备阻塞调度任务的能力**"；配置里"阻塞"的实现方式是"识别触发该表质量检测的生产调度节点，**将该节点置为失败，下游节点不执行**，以此阻塞生产链路，避免问题数据污染扩散"；默认策略"**阻塞：强规则·红色异常**"，其余（强/弱的橙色异常与校验失败）默认只告警；且"策略配置为阻塞时，命中后**会同时触发告警**"【源 D16】。
- 两条常被踩的边界：触发方式必须是"**调度任务触发**"才算自动化保障（文档称其为"实现自动化数据质量保障的最佳实践"），手动触发只适合一次性数据探查；**虚节点和空跑节点不实际生成数据，不支持触发质量规则校验**【源 D16】。
- 覆盖面与分级：DQC 支持对 MaxCompute、E-MapReduce、Hologres、AnalyticDB 等存储做校验，从**完整性、准确性、一致性**多维配规则并与调度关联【源 D15】；风险监控针对"准确性、一致性、完整性"，监控分类为"**数据量、主键、离散值、汇总值、业务规则和逻辑规则**"，粒度为**字段级、表级**，并要与**数据资产定级**（示例中定为 A2）对应——即"监控强度按资产等级配，不是一律红色阻塞"【源 D17】。→ 这就是"你凭什么堵链路"的官方答案：**按资产等级 + 强/弱规则分级**【源 D17/D16】。

---

## 2. 会被追问什么（阿里数据面风格：一路问到"你怎么保证以后不再错"）

1. "你的实时链路端到端延迟是多少？拆一下。"（接入 → 计算（checkpoint 间隔与完成时间）→ 表 commit/compaction → 查询；每段有分位数）＋【推】
2. "MiniBatch 默认是开的还是关的？LocalGlobal 呢？"（MiniBatch 默认关；LocalGlobal 默认开但**必须 MiniBatch 生效且函数实现 Merge**）【D3】
3. "COUNT DISTINCT 倾斜为什么 LocalGlobal 不管用？"（local 阶段去重率不高，热点仍在 Global；要用 PartialFinal 自动打散，且它会多引入一层 Shuffle）【D3】
4. "你的 UV 看板为什么慢？"（`CASE WHEN` 多个 COUNT DISTINCT 不共享 State；改 `AGG WITH FILTER` 官方称性能提升 1 倍）【D3】
5. "这个 TopN 作业为什么用了 RetractRank？"（上游是更新流、不满足 UpdateFastRank 的三个条件；看拓扑节点名即可判定）【D3】
6. "TTL 改了为什么老状态还在？"（Flink：TTL 不进 checkpoint/savepoint，且只支持处理时间；Gemini：从快照恢复后新 TTL 只对新写入数据生效）【D2/D4】
7. "状态先撑不住的是内存还是盘？"（Gemini 三条入口：内存→memory managed / writebuffer+offheap；本地盘不足→存算分离；Join 瓶颈→KV 分离）【D4】
8. "实时表和离线表数字对不上，你查哪三层？"（changelog 是否完整（前镜像缺失）、MOR 读是否正确合并版本（非键列过滤下推）、TTL 非精确删除导致 PK 重复）【D6/D5/D11】
9. "为什么不把每个流都做成完整 changelog？"（官方："产出额外 changelog 文件会增加工作和存储，选满足消费者契约的**最便宜**的生产者"）【D6】
10. "你的宽表用 join 还是 partial-update？代价各是什么？"（partial-update 省掉多流 join 的状态，但默认 null 不覆盖 → 无法置空需 sequence group；且下游 retract 聚合需要 -U 记录）【D7/D8/D6】
11. "全量 + 增量 CDC 怎么不锁库、怎么断点续传？"（chunk 切分与 chunk 粒度 checkpoint、chunk key 默认主键第一列、**非主键列做 chunk key 可能数据不一致**、无界 chunk 优先以降 OOM）【D9】
12. "云上 RDS 主备切换把位点断了怎么办？"（Canal 原生支持 Aliyun RDS binlog 订阅，解决自动主备切换与 OSS binlog 离线解析）【D10】
13. "看板要求'昨天的数不能变'，你靠什么承诺？"（消息存储时长 + 位点回溯 + 湖侧快照/tag；三者取交集作为可重算窗口）【D28/D29】＋【推】
14. "这张 Hologres 表为什么点查慢？"（列存 + 分布键选错/未设主键索引；行存才是点查的形态；分段键与聚簇索引各解决哪一段）【D13/D11/D12】
15. "为什么你不建议用 TTL？"（非精确时间删除 → 可能出现 PK 重复或查询不一致；官方建议用分区表管理生命周期）【D11】
16. "这条口径变更怎么通知下游？"（派生指标 = 原子指标 + 业务限定 + 统计周期；任一变化即为**新指标**，需版本与对账）【D18/D19】＋【推】
17. "上线前 DQC 怎么配才算数？"（关联调度节点 + 强规则红色异常阻塞 + 弱规则只告警；虚节点/空跑节点不触发；资产定级决定强度）【D16/D17】
18. "这个月的计算费用为什么涨了 3 倍？"（扫描量 = 输入量(压缩后) × 复杂度；无分区裁剪的 ad-hoc、失败重跑、小文件、无列裁剪）【D20】＋【推】
19. "写入热点导致 Shard 不够用，你怎么治理？"（Shard MD5 区间与自动分裂/手动合并；按 hash key 打散、写入侧负载均衡）【D21】＋【推】
20. "共享存储数据库真的省成本吗？"（OceanBase SS：基线共享、本地只缓存热点，但**每个副本独立转储、转储数据不共享**）【D23】

---

## 3. 常见错误答案（背题型信号）

| 错误 | 暴露点 |
|---|---|
| "开了 checkpoint 就是端到端 exactly-once" | sink 侧两阶段/幂等那一段没有着落；不知 barrier 不越记录、对齐与非对齐的差别【D1】 |
| "MiniBatch/LocalGlobal 都是默认开的" | MiniBatch 默认关、LocalGlobal 依赖 MiniBatch 与 Merge 实现；判据是看拓扑节点名【D3】 |
| "倾斜就加盐，不知道 PartialFinal 的限制" | COUNT DISTINCT 去重率低导致 LocalGlobal 无效；PartialFinal 不能配 UDAF、小数据量反而浪费【D3】 |
| "状态大就加内存" | 三条瓶颈（内存/本地盘/Join）对应三类不同配置；TTL 不会自动清洗历史状态【D4/D2】 |
| "湖上主键表读得快就完事" | MOR/COW/MOW 三模式分别把代价放在读、写或写入侧查旧行；bucket 约束并行度【D5】 |
| "WHERE status='open' 下推总能加速" | 官方明说可变非键列过滤在合并前下推会**返回旧行**【D5】 |
| "所有流都补成完整 changelog 最安全" | 额外 changelog 增加工作与存储；none/input/lookup/full-compaction 的可见时机各不相同【D6】 |
| "partial-update 就是 UPSERT" | 默认 null 不覆盖（无法置空），需要 sequence group；且下游 retract 聚合缺 -U 会算错【D8/D6】 |
| "CDC 用非主键列分 chunk 更均匀" | 官方警告可能导致**数据不一致**【D9】 |
| "binlog 同步不就是订阅吗" | 云上主备切换/OSS 离线解析要专门处理（Canal 的 RDS 能力）；多分片库还需要事务级有序日志【D10/D25】 |
| "回溯随时能做" | 可回溯窗口受存储时长与位点纠正限制；重置位点引发冷读、且不能重置定时/重试中消息【D28/D29】 |
| "Hologres 加个 TTL 就自动清理了" | 官方：TTL 非精确、建议用分区表，否则出现 PK 重复与查询不一致【D11】 |
| "列存就是最快" | 行存才是主键点查（毫秒级 Serving）形态；主键索引是行存文件、Value 为 RID + 聚簇键【D11/D13】 |
| "指标口径写在 SQL 注释里就行" | Dataphin 的规范定义要求原子指标 + 业务限定 + 统计周期三者齐备【D18/D19】 |
| "DQC 就是告警" | 强规则红色异常默认**阻塞**下游节点；虚节点/空跑节点不触发校验；监控强度按资产等级配【D16/D17】 |
| 报"双 11 数仓真实规模/某引擎 N 倍性能" | 公开渠道无官方可核查数字（§7 第 1、5 条） |

---

## 4. 考点清单（14 条）

> **judgeKind 约定**：Flink / Paimon / CDC 这类"必须真跑流式引擎才有区分度"的机制，在本仓库按约定归 `llm-rubric`；**能等价重写成 Spark 或 SQL 语义的**才开 `pyspark` / `spark-scala` / `mysql` / `redis`（例如 changelog 归一、upsert 合并、口径对账、Shard 区间分配），这类题在正文里显式标【推】说明"题面机制是通用的，参数语义取自阿里系文档"。本文不开 `react-vitest`（§7 第 6 条）。
> 每条：考点名（`tag`）｜senior 深度要点｜可出题形式｜建议 judgeKind｜锚点

1. **端到端一致性与新鲜度预算**（`alibaba-e2e-freshness`）
   要点：checkpoint 的恢复语义（停止数据流 → 重启到最近 checkpoint → 按记录重放）与"间隔=容错开销 vs 重放条数的折中"；barrier 注入、随记录流动、**不超越记录**；对齐/非对齐（1.11 起）与反压的关系；再往下的 sink 必须两阶段提交或幂等；最后把新鲜度写成"每层分位数 + 完整度标记"，数据未到齐时看板显示"尚未完整"而不是报错。
   出题：rubric（给端到端延迟 SLO，拆四层预算并指出哪层最贵、降级形态与监控项）；code（`pyspark`：把带重复与迟到的事件流按事件时间去重归一，并输出"完整度"列）。
   judgeKind：`llm-rubric` ＋ `pyspark`。
   锚点：【源 D1】＋【推（分层预算、sink 责任划分）】。
2. **状态膨胀、TTL 语义与状态后端选型**（`alibaba-state-ttl-gemini`）
   要点：Flink State TTL 的三条约束（仅处理时间、**TTL 不属于 checkpoint/savepoint**、`defaultValue` 失效）、逐条目 TTL 与 `OnCreateAndWrite` 默认、compaction 中跑 TTL 过滤器会拖慢 compaction、2.2.0 起支持"有 TTL ↔ 无 TTL"的无缝迁移；Gemini 的自适应调参与三条定向入口（内存 / **本地盘不足→存算分离** / **Join 瓶颈→KV 分离**）、`gemini.memory.managed` 与 writebuffer+offheap 的关系、**"改 TTL 后从快照恢复，新 TTL 只对新写入数据生效"**；checkpoint 完成等待 compaction 时对 `max-concurrent-checkpoints` 的影响。
   出题：rubric（一个 join 算子状态 300GB 的作业：判瓶颈、给三类配置与各自回退方案、以及"改 TTL 后历史状态何时消失"）；code（`java`/`pyspark` 等价重写：实现带逐条目 TTL 的 LRU 状态并断言过期与写入刷新语义）。
   judgeKind：`llm-rubric` ＋ `pyspark`。
   锚点：【源 D2】【源 D4】【源 D6（checkpoint 与 compaction 耦合）】＋【推（迁移与清洗时机判断）】。
3. **实时 SQL 聚合倾斜的四种解法与各自的限制**（`alibaba-flink-sql-skew`）
   要点：MiniBatch（减 State 访问、默认关、以延迟换吞吐、事件消息按间隔注入）；LocalGlobal（默认开但依赖 MiniBatch + Merge 实现，判据看拓扑）；PartialFinal（专治 COUNT DISTINCT、默认不开、**不能用 UDAF、小数据量反而浪费**，判据是拓扑变成两层）；`AGG WITH FILTER` 替代 `CASE WHEN`（同字段多条件共享 State，官方称性能提升 1 倍）；Delta Aggregation 的 MiniBatch 合批（每分组键一批最多一次 Lookup）与 cache（**源表必须有主键**、`cache-size > 0`）；KEYVALUE 单字符分隔符约 30% 提升；SQL Hints 补计划元数据（含 shuffle key 倾斜信息）。
   出题：code（`pyspark`：给一张倾斜的 UV 明细，写"两阶段聚合 + 按 distinct key 取模打散"并断言结果与朴素聚合一致）；rubric（同一作业分别用四种手段的收益与副作用，含"低流量时段不该开 PartialFinal"的判据）。
   judgeKind：`pyspark` ＋ `llm-rubric`。
   锚点：【源 D3】＋【推（Spark 侧等价重写）】。
4. **TopN / 去重 / 维表 Join 的算子可诊断性**（`alibaba-stream-operator-choice`）
   要点：TopN 三种算法（非更新流只有 `AppendRank`；更新流有 `UpdateFastRank` 与保底的 `RetractRank`，性能从高到低；**算法名会出现在拓扑图节点名上**，且 RetractRank 升级为 UpdateFastRank 需满足 3 个条件）；官方还单列"高效去重方案"一节（去重与 TopN 同源）；维表侧 Delta Aggregation 与 Lookup join 的差别（合批、缓存、需要主键）；`spark-scala` 场景下的等价考点是"rank + tie-break 语义"【推】。
   出题：code（`spark-scala`：实现"每组 Top-K 且并列按次级键稳定排序 + 更新流撤回语义"的批等价版本，断言并列与删除）；rubric（看板看到节点名 `RetractRank` 时的三步定位与改法）。
   judgeKind：`spark-scala` ＋ `llm-rubric`。
   锚点：【源 D3】＋【推（批等价与撤回语义）】。
5. **湖仓主键表的读放大/写放大：table mode 与 bucket**（`alibaba-lakehouse-table-mode`）
   要点：MOR（默认，读时合并重叠有序 run，读 CPU/内存随重叠版本增长）/ COW（`full-compaction.delta-commits=1`，读全压实结果，代价是写放大；Flink 流写里按 checkpoint 计数，不是每行）/ MOW（`deletion-vectors.enabled=true`，读文件并跳过无效行位置，写入需查旧行并维护删除向量）；选择依据是"更新率、读延迟、compaction 资源"；分桶约束并行度、bucket 大小是关键设置；**可变非键列的过滤通常不能在合并前下推（否则返回旧行）**；lookup changelog 与 `full-compaction.delta-commits` 不兼容。
   出题：code（`pyspark`：实现"合并同一主键的多个版本 → 再应用谓词"的正确顺序，并用一个 open→closed 的用例断言朴素文件级过滤会返回旧行）；rubric（给读多写少 vs 写多读少两个负载各选一种 mode 并算 compaction 预算）。
   judgeKind：`pyspark` ＋ `llm-rubric`。
   锚点：【源 D5】【源 D6】＋【推（预算与并行度换算）】。
6. **Changelog 生产者与下游契约**（`alibaba-changelog-contract`）
   要点：四种生产者的"旧值来源 / 何时可见 / 何时用"对照；完整 changelog 必须带被撤回更新的旧行；`none` 时依赖下游 upsert 或**有状态 normalize 算子**（状态与 checkpoint 成本随键数量增长，不要贸然删）；`lookup` 在 compaction 时回查、默认 writer 要等 lookup compaction 提交，并可用 `lookup.cache-file-retention`（1h）/`cache-max-disk-size`/`cache-max-memory-size`（256MB）控缓存；`full-compaction` 产生的是"表状态变化的 changelog，中间更新会被折叠"，间隔默认 1 个 checkpoint；**DV 表不支持 full-compaction**；三个裁剪开关（row-deduplicate / ignore-update-before / ignore-delete）改变消费者契约、retract 聚合需要保留这些记录。
   出题：code（`pyspark`：输入只含 +U（无前镜像）的变更流，输出正确的 -U/+U 对并断言下游"先减旧再加新"的聚合结果）；rubric（给延迟预算与下游类型选 producer，并说明额外 changelog 文件的存储与工作成本）。
   judgeKind：`pyspark` ＋ `llm-rubric`。
   锚点：【源 D6】＋【推（成本推导）】。
7. **宽表打宽：merge engine 与乱序**（`alibaba-merge-engine-wide-table`）
   要点：四种 merge engine 的语义与适用行（deduplicate/partial-update/aggregation/first-row）；"latest 依记录顺序，到达顺序≠业务顺序时要配 sequence field"；partial-update 默认"非 null 覆盖、null 保持不变"，因此**置空需要 sequence group**；官方例子是"商品的价格、数量、描述分别到达"；多流写同一主键与"用 join 拼宽表"的取舍（省状态但改变可查询时机）；first-row 用于事件/日志去重，但此时流里没有更新语义。
   出题：code（`pyspark`：多流按主键合并、实现"非 null 覆盖 + 显式置空 + 组内乱序按业务时间纠正"）；rubric（打宽方案对比：join 状态成本 vs partial-update 的语义坑与回刷策略）。
   judgeKind：`pyspark` ＋ `llm-rubric`。
   锚点：【源 D7】【源 D8】＋【推（回刷与幂等）】。
8. **CDC 采集：全量增量无锁切换与位点正确性**（`alibaba-cdc-snapshot-incremental`）
   要点：增量快照框架的 chunk 切分（chunk key 默认主键第一列、可用非主键但**官方警告可能数据不一致**）、chunk 粒度 checkpoint、`scan.incremental.snapshot.chunk.size`、无界 chunk 优先以降低最大 chunk 快照时的 OOM；Canal 路线（伪装 slave 发 dump 协议、支持 MySQL 5.1.x–8.0.x、原生 Aliyun RDS binlog 订阅解决主备切换与 OSS 离线解析、原生 Prometheus/Kafka 投递、1.1.x 性能提升 150%）；总线侧的顺序语义承载（MessageGroup、单一生产者 + 串行发送、不同组可混排）；数据库侧还需事务级有序日志（PolarDB-X CDC 收集/重组/排序/落盘，保证事务不乱序、原子性、DDL 同步）。
   出题：code（`mysql`：给一张大表 + 分片快照结果，写"分片边界不重不漏 + 增量切换点"的校验 SQL）；rubric（主备切换/位点失效后的恢复流程与对账判据）。
   judgeKind：`mysql` ＋ `llm-rubric`。
   锚点：【源 D9】【源 D10】【源 D26】【源 D25】＋【推（恢复与对账）】。
9. **OLAP 选型：同一份数据的聚合分析与高 QPS 点查**（`alibaba-olap-serving-selection`）
   要点：Hologres 的定位（PB 级 OLAP + 高并发低延迟 Serving + PG 协议 + 与 MaxCompute/Flink/DataWorks 深度融合）；列存/行存/行列共存的适用面与官方描述（列存高压缩比与列扫描、行存"基于主键的点查毫秒级"）；四类索引/属性按查询模式配（分布键=并行与本地性、聚簇键=文件内排序、分段键=文件级裁剪、bitmap=低基数等值、字典编码=字符串比较转数字）；主键索引实现（行存文件，Key=PK，Value=RID+聚簇键，RID 每次 UPSERT 生成且单调递增）→ 才支持"整行/部分列 UPSERT"和高 QPS 主键查询；行存表主键默认同时是 Clustering 与 Distribution Key；不建议 Serial 做主键（表锁、溢出）；何时不上 OLAP 而直读湖【推】。
   出题：code（`mysql`：给一张订单明细与 5 条真实查询，写"哪些走预聚合、哪些走主键点查、哪些必须扫分区"的分层方案与索引映射）；rubric（列存 vs 行存 vs 湖直读的三套成本与延迟测算，含"混合负载细粒度隔离"的落地）。
   judgeKind：`mysql` ＋ `llm-rubric`。
   锚点：【源 D11】【源 D13】【源 D12】【源 D14】＋【推（成本/延迟测算与隔离）】。
10. **生命周期、冷热分层与"TTL 不精确"引发的质量事故**（`alibaba-lifecycle-coldhot`）
    要点：Hologres TTL 的六个细节（按**写入时间**而非更新时间、不设默认 100 年、V1.3.24 起最小 1 天、V4.2 起有主键表受 `hg_time_to_live_in_days_min_value`（默认 36500 天、仅 Superuser）约束、无主键表不受限、**非精确删除会导致 PK 重复与查询不一致**）与官方替代方案（用分区表管生命周期）；`storage_mode` 冷热分层（V1.3 起）；消息侧的可回溯窗口（存储时长 + 位点 + 不能重置定时/重试中消息 + 冷读）；湖侧的 tag/快照保留【推】。
    出题：code（`pyspark`：按"写入时间 vs 更新时间"两种口径重算保留集合，断言差集与"过期数据仍被查出"的两种表现）；rubric（给一份"3 天热、30 天温、2 年冷"的保留要求，设计分区 + 冷热 + 回溯窗口并列出不可回滚点）。
    judgeKind：`pyspark` ＋ `llm-rubric`。
    锚点：【源 D11】【源 D29】【源 D28】＋【推（湖侧快照与不可回滚点）】。
11. **云原生数据库与分布式存储的取舍**（`alibaba-cloud-native-storage`）
    要点：一写多读 + 共享存储（PolarDB）与"复制延迟低 ≠ 读到最新"；会话一致性 vs 全局一致性（CSN 替代活跃事务列表、CSN 写 WAL、RO 回放构建事务状态）及其成本（官方给出的旧解法是把读转回 RW、RO 闲置）；OceanBase 的分区/Tablet/日志流/Multi-Paxos/Leader 切换/租户与 Unit/ODP，以及**共享存储模式**"基线共享、本地缓存热点、每个副本独立转储且转储不共享"；PolarDB-X 的 TSO + MVCC + 2PC 与 PITR/全局 CDC；把这些落到数据工程的结论（读一致性影响下游快照、CDC 有序性影响增量正确性、Leader 切换影响断点续传）。
    出题：rubric（给"金融级实时看板 + 读写分离 + 每日快照"三需求，选架构并说明一致性代价与故障时的降级）；code（`mysql`：写"验证 RO 是否读到最新写入"的可重放测试脚本并给出判定与超时策略）。
    judgeKind：`llm-rubric` ＋ `mysql`。
    锚点：【源 D24】【源 D23】【源 D25】＋【推（架构结论）】。
12. **指标口径治理（规范定义与语义层）**（`alibaba-metric-definition`）
    要点：规范定义的六要素（主题域/业务过程/维度/原子指标/统计周期/派生指标）与"以维度建模为理论基础"；派生指标"圈定原子指标统计业务的范围"、前提是业务实体与业务限定已建；由此推出的口径变更规则（改业务限定或统计周期＝新指标，需版本与对账；不可直接覆盖同名指标）；与数据质量联动（口径类规则属于 DQC 的"业务规则和逻辑规则"分类【源 D17】）；口径落库的可验证形态（语义层生成 SQL + 双路对拍 + 差异阈值）【推】。
    出题：code（`mysql`：同一"支付金额"在三种业务限定/统计周期下的正确 SQL，并要求输出派生指标元组 `(原子指标, 业务限定, 统计周期)`）；rubric（口径变更的通知、灰度、对账与不可比标记机制）。
    judgeKind：`mysql` ＋ `llm-rubric`。
    锚点：【源 D18】【源 D19】【源 D17】＋【推（对拍与不可比标记）】。
13. **数据质量规则与阻塞策略**（`alibaba-data-quality-gate`）
    要点：四层实体（规则模板 → 监控规则 → 质量监控 → 强/弱规则与阻塞）；阻塞的实现方式与默认（"把触发检测的生产调度节点置为失败、下游不执行"；默认只阻塞**强规则·红色异常**；命中阻塞同时告警）；触发方式（关联调度节点=最佳实践；手动=一次性探查；**虚节点与空跑节点不触发**）；阈值示例（波动率 ≤30%）与严重等级；支持的存储（MaxCompute/EMR/Hologres/ADB）；监控分类（数据量/主键/离散值/汇总值/业务规则/逻辑规则）与粒度（字段级/表级）；**监控强度要按数据资产定级配**（示例 A2）；告警渠道与值班表/授权对象。
    出题：code（`pyspark`：实现"7 日均值波动 + 主键重复 + 枚举越界"三类规则并输出红色/橙色/校验失败与是否阻塞）；rubric（大促 D-1 的质量闸设计：哪些规则强阻塞、哪些只告警、误堵与漏堵的判据与逃逸通道）。
    judgeKind：`pyspark` ＋ `llm-rubric`。
    锚点：【源 D15】【源 D16】【源 D17】＋【推（阈值与资产分级的配比）】。
14. **成本与容量口径（扫描量、Shard、存储时长）**（`alibaba-data-cost-model`）
    要点：MaxCompute SQL 账单公式（**输入数据量 × 复杂度 × 单价**；公共云 0.3 元/GB、金融云 0.57 元/GB；输入量按**压缩后**计；**失败作业不计费**；次日 06:00 前汇总；有费用预估方法；PyODPS 底层是 SQL 因此按 SQL 计费；SQL/MapReduce/Spark/Mars/查询加速/MaxFrame 各有计费方式）；SLS 侧 Shard 决定读写能力上限（MD5 左闭右开区间、创建时平均划分、**分裂自动 / 合并手动**）、查询要开索引且"秒级查询十亿到千亿级日志"；消息侧存储时长决定可回溯窗口且按存储节点粒度；再叠加"预留 + 突发弹性"（云消息队列自述最高可省一半机器资源）做成本-能力权衡。
    出题：code（`pyspark`：给作业元数据表（扫描字节、复杂度、重跑次数、失败次数），算日账单、按团队归因并找出 Top 3 降本项，要求区分"压缩前后"与"失败不计费"两条规则）；rubric（一次费用暴涨的归因流程与三条治理卡口的收益量化）。
    judgeKind：`pyspark` ＋ `llm-rubric`。
    锚点：【源 D20】【源 D21】【源 D22】【源 D29】【源 D27】＋【推（归因与卡口）】。

---

## 5. 出题角度

### 题面草稿 A（`code`，`judgeKind=pyspark`）——"changelog 归一 + 版本正确合并"综合题
> **实时宽表的正确性（阿里湖仓风格：把"读什么"当成契约来测）**
> 输入：`changes(key BIGINT, seq BIGINT, ts TIMESTAMP, status STRING, amount DECIMAL(18,2), op STRING)`，`op ∈ ('u','d')`，同一 `key` 可能多版本、可能乱序到达；另有 `dim_price(key, price)`（多流打宽的第二个流）。
> 实现 `current_state(changes, dim_price)` 与 `full_changelog(changes)`，要求（每条注明对应哪种真实故障）：
> 1) **版本归一**：按 `key` 取"业务顺序"的最新版本（业务顺序 = `seq`，**不是 `ts`、更不是到达顺序**）；`d` 表示该行被删除；断言"最新一条是 retract 时该行被移除"；
> 2) **谓词必须后于合并**：入参带 `only_open: Boolean`。当 `only_open=True` 时，**必须先合并版本再过滤 `status='open'`**；用例专门构造"旧行 open、新版本 closed"，朴素地在文件级/分区级先过滤会错误返回旧行；
> 3) **完整 changelog**：输出 `(key, before_status, before_amount, after_status, after_amount, change_kind)`，`change_kind ∈ ('+I','-U','+U','-D')`；对"值未发生实质变化"的更新（各字段全等）默认**不得**输出 -U/+U 对（对应 `changelog-producer.row-deduplicate` 的语义），但函数参数要能显式打开它；
> 4) **打宽用部分更新语义**：与 `dim_price` 合并时"非 null 覆盖、null 保持原值"，且必须能表达"显式置空"（用 `seq` 组）；断言"价格流晚到/不到"时结果不为 null 污染；
> 5) **可重放**：对同一输入重复执行结果一致；并在窗口边界（同一 `key` 两条相同 `seq`）给出确定性的 tie-break 及注释说明为什么这样定。
> 禁止 `collect()`；输出必须可分区。
> 区分度：**2) 与 3)**——把湖表当成"有主键的 KV"的人会在这两处失分；4) 考察是否理解"null 不覆盖"与"置空需要 sequence group"。

### 题面草稿 B（`rubric`，10 分制，主推）
> **你正在面试阿里云某数据平台团队的 Senior Data Engineer（实时湖仓 / OLAP 方向），50 分钟**
> 现状与约束（其中机制部分都可在公开文档核查，数字均为题面假设）：主链路为"业务库 → Flink CDC → RocketMQ → Flink SQL → Paimon 主键表（deduplicate）→ Hologres 服务层 → 看板与在线 API"；SLA：核心指标 T+1 早 8 点、实时大盘延迟 p95 ≤ 60s、在线点查 p99 ≤ 10ms；近期问题：① 实时 GMV 与离线数仓每日差 0.4%–1.2%（无固定方向）；② 一次 TTL 策略调整后出现"主键重复"报错；③ 某作业 `RetractRank` 导致 TopN 报表延迟 8 分钟；④ 三个团队各自报"活跃商家数"，数字互不相同；⑤ 单月 MaxCompute 计算费用上涨 3.1 倍。
> 请给出：① **分层链路图 + 每层语义**（谁负责去重、谁负责顺序、谁负责前镜像、可回溯窗口由什么决定）；② Paimon 侧的**表模式与 changelog 决策**（MOR/COW/MOW 与 none/input/lookup/full-compaction 各选一个，写出延迟/写放大/存储代价，并说明"能不能用 `ignore-update-before` 省成本"）；③ 差异 0.4%–1.2% 的**完整归因方案**（含"可变非键列过滤下推返回旧行""TTL 非精确删除""乱序与迟到""回撤聚合缺前镜像"四类分别如何证伪）；④ TopN 延迟的算子级改法（怎么从 RetractRank 变 UpdateFastRank、改不动时怎么换实现）；⑤ 指标口径治理方案（原子指标 + 业务限定 + 统计周期 + 派生指标、变更时如何标记不可比、语义层如何生成 SQL 并被 CI 卡住）；⑥ 质量闸设计（哪些规则设强规则阻塞、哪些弱规则只告警、按资产等级怎么配、虚节点/空跑节点的限制如何处理）；⑦ 成本三刀与各自风险（用账单公式做量化，不许说"加机器/删数据"）；⑧ 一条你**拒绝做**的优化。
> **加分点**：明确"实时/离线差异"的合法判据（同一口径 + 同一时点快照对比，且区分"未完整"与"错"）；指出 MiniBatch 默认关闭、LocalGlobal 依赖它，以及"低延迟要求就不建议开"；用 PartialFinal 的限制（不能用 UDAF、小数据量浪费、会多一层 Shuffle）来反对"逢倾斜就开"；用 `AGG WITH FILTER` 替代 `CASE WHEN` 并给出可测收益；说明 TTL 不精确的官方原话与"改用分区表"的替代，并把冷热分层 `storage_mode` 纳入保留策略；给在线点查配行存 + 主键索引（RID 单调递增、部分列更新），聚合走列存；CDC 侧能指出"非主键列做 chunk key 可能数据不一致"与主备切换的位点问题（Canal 的 RDS 能力）；成本用"输入量（压缩后）× 复杂度 × 单价、失败不计费"建模，并区分"失败重跑不重复计费但会重复计费成功作业"；SLS 侧用"Shard 决定读写上限、分裂自动、合并手动"解释写入倾斜与恢复动作；⑧ 的拒绝有依据（例如拒绝在含 retract 聚合的表上开 `ignore-delete`）。
> **不足点**：把差异归因为"实时不可靠"；只说"加并行度/换引擎"；用 TTL 管生命周期且不解释 PK 重复；口径靠注释与文档约定；质量规则一律弱规则只告警（或一律强规则全阻塞）；给不出任一量化判据（延迟分位数、差异率、扫描字节、Shard 数）；引用"阿里内部双 11 大屏口径"当依据（见 §7）。

### 题面草稿 C（`rubric`，短题，10 分钟）
> "一张 Paimon 主键表（默认 MOR、`changelog-producer=none`）被下游 Flink 做 `SUM(amount)` 增量聚合，凌晨出现持续 3% 偏高，白天自己好了。给你三条线索：上游写入用了普通消息（无 before/after）、昨天有人把看板查询加了 `WHERE status='open'` 的文件级过滤、checkpoint 间隔从 60s 改成了 5min。分别说明这三条各自会造成什么偏差，哪个能解释'凌晨高、白天自愈'。"
> 期望：① `none` + 无前镜像 → 下游需要旧值时只能靠**有状态 normalize**，若 normalize 被"优化掉"或状态被 TTL 清掉，回撤丢失会**永久性偏高**（不会自愈）【源 D6】；② 可变非键列过滤在合并前下推 → 会**丢掉替代版本、返回旧行**，表现为查询结果与真实当前态不符（方向取决于数据，白天数据更"新"时可能被掩盖）【源 D5】；③ checkpoint 间隔变长 → 恢复时要重放更多记录，配合上游**重复/乱序**投递会在窗口内出现短暂偏高、随后被后续结果覆盖 → **能解释"凌晨高、白天自愈"**【源 D1】；再加动作：先固定口径重跑对拍（同一时点快照），再看拓扑算子与 normalize 是否被删、最后查消息重复与位点。

---

## 6. 来源清单（全部于 **2026-09-23** 实际抓取并确认页面内容）

| # | URL | 标题 | 访问日期 | 支撑了上面哪几条考点 |
|---|---|---|---|---|
| D1 | https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/ | Apache Flink《Stateful Stream Processing》（stable） | 2026-09-23 | 1.1；考点 1（exactly-once 通过"从 checkpoint 恢复状态 + 重放记录"实现、checkpoint 间隔是容错开销与恢复时间的折中、状态存于分布式文件系统、故障时停止数据流并重启、barrier 注入数据流且**永不超越记录**、1.11 起可选对齐/非对齐检查点）；题面草稿 C |
| D2 | https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/state/ | Apache Flink《Working with State》（stable） | 2026-09-23 | 1.2；考点 2（keyed state 需先 keyBy 且 key 计算必须确定性、**TTL 可赋给任意 keyed state 且集合类型支持逐条目 TTL**、`StateTtlConfig`、默认 `OnCreateAndWrite` 与"读取是否刷新"可选、**仅支持处理时间**、**TTL 配置不属于 checkpoint/savepoint**、开启 TTL 后 `defaultValue` 失效、map state 对 null 值的序列化要求、compaction 中跑 TTL 过滤器会拖慢 compaction、**Flink 2.2.0 起支持有/无 TTL 间的无缝迁移**） |
| D3 | https://help.aliyun.com/zh/flink/realtime-flink/user-guide/optimize-flink-sql | 阿里云实时计算 Flink 版《高性能 Flink SQL 优化技巧》 | 2026-09-23 | 1.3；考点 3/4/5 交叉（MiniBatch 定义与"默认关闭""以延迟换吞吐、超低延迟不建议"、LocalGlobal 机制与"依赖 minibatch + 需实现 Merge"及拓扑判据、PartialFinal 的适用与"不能用 UDAF、数据量小不建议、会多一层 Shuffle"及 `table.optimizer.distinct-agg.split.enabled`、`AGG WITH FILTER` 共享 State 且"性能提升 1 倍"、TopN 算法 AppendRank/UpdateFastRank/RetractRank 与"算法名显示在拓扑节点"、Delta Aggregation 的 MiniBatch 合批与 cache（源表必须有主键、`cache-size>0`）、KEYVALUE 单字符分隔符约 30%、高效去重、SQL Hints 补统计/倾斜元数据） |
| D4 | https://help.aliyun.com/zh/flink/realtime-flink/user-guide/configurations-of-geministatebackend | 阿里云实时计算 Flink 版《企业级状态后端存储配置》 | 2026-09-23 | 1.2；考点 2（Gemini 基于**自适应调参**多数场景无需手动配、三条定向入口（内存配置/本地盘空间不足→**存算分离**/Join 瓶颈→**KV 分离**）、`gemini.memory.managed` 与 writebuffer/offheap 关系、**"修改 TTL 后从快照恢复，新 TTL 只对新写入数据生效，旧数据沿用旧 TTL"**、SQL 作业与 DataStream/Python 作业的 State TTL 参数区分） |
| D5 | https://paimon.apache.org/docs/master/primary-key-table/table-mode/ | Apache Paimon《Table Mode》 | 2026-09-23 | 1.5；考点 5/6（MOR/COW/MOW 三种模式的配置、读路径与主要代价对照表；"典型 deduplicate 表 + 频繁分析读考虑 MOW、偏写吞吐考虑 MOR、可承担每次全量压实考虑 COW；评估更新率/读延迟/compaction 资源"；分桶约束并行度、bucket 大小是关键；**"可变非键列的过滤通常不能在合并前下推，否则可能丢弃替代行并错误返回旧行"**；`full-compaction.delta-commits=1` 在 Flink 流写按 checkpoint 计数、并非每行压实，以及 lookup 生产者与其不兼容） |
| D6 | https://paimon.apache.org/docs/master/primary-key-table/changelog-producer | Apache Paimon《Changelog Producer》 | 2026-09-23 | 1.5；考点 6（四种生产者的"旧值来源/可见时机/使用场景"表；完整 changelog 必须含被撤回更新的旧行（4→5 示例）；**deletion-vector 表支持 none/input/lookup、不支持 full-compaction**；"产出额外 changelog 文件增加工作与存储，选满足契约的最便宜生产者"；none 下增量读不含完整前镜像、不是审计日志，Flink 可加有状态 normalize 但状态与 checkpoint 成本随键数增长、不要贸然删；lookup 默认 writer 需等待 lookup compaction 提交及三个 cache 参数（1h/无限/256MB）；full-compaction 折叠中间更新、`full-compaction.delta-commits` 默认 1 个 checkpoint；`row-deduplicate`/`ignore-update-before`/`ignore-delete` 改变消费者契约、retract 聚合需保留这些记录；checkpoint 间隔 + 分桶数造成小文件与 compaction 压力、`execution.checkpointing.max-concurrent-checkpoints`） |
| D7 | https://paimon.apache.org/docs/master/primary-key-table/merge-engine/ | Apache Paimon《Merge Engine》 | 2026-09-23 | 1.5；考点 7（四种 merge engine 的语义与适用：deduplicate 默认保留最新行、最新 retract 移除该行；partial-update 更新非 null 字段、sequence group 可显式置 null；aggregation 按字段配置聚合；first-row 保留首行忽略后续用于事件/日志去重；"**latest 依 Paimon 记录顺序，到达顺序不代表业务顺序时要配 sequence field**"） |
| D8 | https://paimon.apache.org/docs/master/primary-key-table/merge-engine/partial-update/ | Apache Paimon《Partial Update》 | 2026-09-23 | 1.5；考点 7（"设为 `partial-update` 以合并同一 key 对不同列的更新；默认非 null 输入替换对应字段、null 输入保持不变；sequence groups 让独立流为自己的字段排序并可显式置 null"；官方示例即商品价格/数量/描述分别到达） |
| D9 | https://nightlies.apache.org/flink/flink-cdc-docs-master/docs/connectors/flink-sources/mysql-cdc/ | Apache Flink CDC《MySQL Connector》（master） | 2026-09-23 | 1.4；考点 8（**增量快照读取**：按用户指定 chunk key 切分快照、chunk 默认取主键第一列、"**使用非主键列作为 chunk key 可能导致数据不一致**"、快照期间可按 **chunk 粒度 checkpoint**、`scan.incremental.snapshot.chunk.size`、`scan.incremental.snapshot.unbounded-chunk-first.enabled` 先分配无界 chunk 以降低最大 chunk 快照时的 TaskManager OOM 风险） |
| D10 | https://raw.githubusercontent.com/alibaba/canal/master/README.md | Alibaba Canal README（GitHub `alibaba/canal`） | 2026-09-23 | 1.4；考点 8（MySQL master→binlog→slave relay log→重放的主备原理；**canal 模拟 MySQL slave 交互协议、伪装为 slave 向 master 发送 dump 协议**、master 推送 binlog、canal 解析 byte 流；支持 MySQL 5.1.x/5.5.x/5.6.x/5.7.x/8.0.x；1.1.x 整体性能测试与优化提升 150%、原生支持 Prometheus 监控、原生支持 Kafka 消息投递、**原生支持 Aliyun RDS binlog 订阅（解决自动主备切换与 OSS binlog 离线解析）**） |
| D11 | https://help.aliyun.com/zh/hologres/developer-reference/create-tables | 实时数仓 Hologres《在 Hologres 中创建高性能内部表》 | 2026-09-23 | 1.6/1.7；考点 9/10（官方交易订单明细示例：`orientation='column'`、`distribution_key='order_id'`、`clustering_key='order_time:asc'`、`event_time_column='order_time'`、`bitmap_columns='shop_id,payment_type,is_delivered'`、`dictionary_encoding_columns='user_id:auto'`；三类表（列存/行存/行列共存）的属性默认值差异（分布键默认主键、建议只选一列且为主键子集；聚簇索引默认为空、建议最多一列且仅升序；分段键默认第一个非空时间戳字段）；行存"为基于主键的点查优化，响应可达毫秒级"、列存"海量聚合分析首选、高压缩比"；**TTL 按写入时间计、非精确删除会导致 PK 重复或查询不一致、官方不建议用 TTL 管生命周期而建议用分区表、V1.3.24 起最小 1 天、V4.2 起有主键表受 `hg_time_to_live_in_days_min_value`（默认 36500 天、仅 Superuser）约束**；`storage_mode` 冷热分层（V1.3 起）；字典编码把字符串比较转为数字比较以加速 Group By/Filter、V0.9 起按数据特征自动选择） |
| D12 | https://help.aliyun.com/zh/hologres/user-guide/segment-key | Hologres《Event Time Column（Segment Key）》 | 2026-09-23 | 1.6；考点 9（Segment Key 在 V0.9 起默认改名 Event Time Column 且向下兼容；适用场景被限定为"含范围过滤条件（包括等值）的查询"与"基于主键的 UPDATE"；机制是"数据文件基于该列范围排序后合并、减少文件之间的重叠，使查询能过滤掉尽可能多的文件"；V2.1 起支持 `WITH (event_time_column=...)` 语法） |
| D13 | https://help.aliyun.com/zh/hologres/user-guide/primary-key | Hologres《主键 Primary Key》 | 2026-09-23 | 1.6；考点 9（主键索引文件底层自动保存、**采用行存结构**、Key=PK、Value=RID + 聚簇索引、RID 每次 UPSERT 自动生成且单调递增、用于主键冲突判定与数据文件定位；据此支持整行与**部分列**写入更新（按主键更新、不需全表扫描）与高 QPS 主键查询；行存表主键默认为 Clustering Key 与 Distribution Key，点查毫秒级、适用于实时风控与实时推荐；**不建议把 Serial 设为主键（写入时表锁、性能损失、长度易溢出）**；联合主键最多 32 列、主键列唯一且非空） |
| D14 | https://help.aliyun.com/zh/hologres/product-overview/what-is-hologres | Hologres《什么是实时数仓 Hologres》 | 2026-09-23 | 1.6；考点 9（"**阿里巴巴自主研发的一站式实时数仓引擎**"；实时写入/更新/加工/分析与亚秒级交互式查询；兼容 PostgreSQL 协议与语法、支持大部分 PG 函数；PB 级 OLAP 与 ad-hoc；**高并发低延迟在线数据服务（Serving）**；多种负载细粒度隔离与企业级安全；与 MaxCompute、Flink、DataWorks 深度融合，离在线一体化全栈数仓；典型场景含实时数据中台、人群圈选、实时风控） |
| D15 | https://help.aliyun.com/zh/dataworks/user-guide/data-quality | DataWorks《数据质量概述》 | 2026-09-23 | 1.8；考点 12/13（四层核心实体：规则模板（内置表行数、字段唯一值个数等，可自定义）/监控规则/质量监控（与调度任务关联，节点成功后自动触发）/**强弱规则与阻塞**；"拦截脏数据、避免问题数据向下游扩散、降低排查与重跑成本"的定位；支持 MaxCompute、E-MapReduce、Hologres、AnalyticDB 等存储；从完整性/准确性/一致性多维配规则；虚节点与空跑节点不实际生成数据、**暂不支持触发质量规则校验**；数据质量大盘与 TOP 质量问题表/责任人、规则覆盖保障情况） |
| D16 | https://help.aliyun.com/zh/dataworks/user-guide/configure-monitoring-rules-by-table | DataWorks《配置规则：按表（单表）》 | 2026-09-23 | 1.8；考点 13（规则属性含阈值示例"波动率不超过 30%"与严重等级（强/弱规则），"**强规则校验失败时具备阻塞调度任务的能力**"；触发方式：调度任务触发（文档称自动化质量保障的最佳实践）vs 手动触发（一次性数据探查）；阻塞实现方式="识别触发该表检测的生产调度节点并置为失败、下游不执行、避免问题数据污染扩散"；**默认阻塞=强规则·红色异常**，默认告警=强弱各类异常；原文"策略配置为阻塞时，当命中数据质量规则后将同时触发告警"；告警渠道（邮件/短信/电话/钉钉、飞书、企业微信机器人、自定义 Webhook）与授权对象（负责人/值班表/调度责任人）；建议发布生产前先测试运行） |
| D17 | https://help.aliyun.com/zh/dataworks/use-data-quality-to-monitor-data-quality | DataWorks《如何进行数据质量风险监控》 | 2026-09-23 | 1.8；考点 12/13（针对**准确性、一致性、完整性**；用于"数仓各层次"的质量监控；**监控分类=数据量、主键、离散值、汇总值、业务规则和逻辑规则**；**监控粒度=字段级、表级**；监控配置与**数据资产定级**对应（示例定级 A2）→ 监控强度按资产等级配） |
| D18 | https://help.aliyun.com/zh/dataphin/fullmanaged/user-guide/create-derived-metrics | Dataphin《基于原子指标和业务限定创建派生指标》 | 2026-09-23 | 1.8；考点 12（"**派生指标用于圈定原子指标统计业务的范围**"；前提须先完成**业务实体**与**业务限定**创建；规范建模 > 指标 的创建路径与参数表） |
| D19 | https://www.alibabacloud.com/help/zh/dataphin/semimanaged-v4/use-cases/specification-defines-best-practices | Dataphin《基于下单业务的规范建模流程》 | 2026-09-23 | 1.8；考点 12（"**规范定义：以维度建模作为理论基础，划分并定义主题域、业务过程、维度、原子指标、统计周期和派生指标**"；下单业务全生命周期（定金→创建订单→支付）作为业务过程划分示例；需搭配 MaxCompute 使用） |
| D20 | https://help.aliyun.com/zh/maxcompute/billing-1 | MaxCompute《计算费用（按量付费）》 | 2026-09-23 | 1.7；考点 14（按量付费覆盖 SQL/MapReduce/Spark/Mars/查询加速 SQL/MaxFrame；PyODPS 底层执行 SQL 因此按 SQL 计量；**SQL 作业当日总费用 = 计算输入数据量 × SQL 复杂度 × 单价**，公共云 0.3 元/GB、金融云 0.57 元/GB，单日计算量大小=输入量×复杂度；**"SQL 作业的输入量是以压缩后的量计费"**；**"执行失败的 SQL 作业不计费"**；次日 06:00 前按项目维度汇总扣费；提供"SQL 费用预估方法，防止计费费用过高"） |
| D21 | https://help.aliyun.com/zh/sls/product-overview/shard | 日志服务 SLS《管理 Shard》 | 2026-09-23 | 1.7；考点 14（Shard 用于控制 LogStore/EventStore/MetricStore 的**读写数据能力**、"数据必定保存在某一个 Shard 中"；通过分裂/合并控制活跃 Shard 数以调整最大读写能力；**分裂可自动触发、合并必须手动执行**；每个 Shard 是 MD5 左闭右开区间 `[BeginKey, EndKey)`、互不覆盖、创建时按指定个数平均划分整个 MD5 范围） |
| D22 | https://help.aliyun.com/zh/sls/user-guide/query-and-analyze-logs | 日志服务 SLS《查询与分析快速指引》 | 2026-09-23 | 1.7；考点 14（"支持**秒级查询十亿到千亿级别**的日志，并支持通过 SQL 对查询结果统计分析"；前提是先开启索引） |
| D23 | https://www.oceanbase.com/docs/common-oceanbase-database-cn-1000000003378353 | OceanBase 数据库《系统架构》（V4.4.0） | 2026-09-23 | 1.7；考点 11（Hash/Range/List 分区与二级分区、"每行数据属于且只属于一个分区"；物理分区对应 **Tablet**；Redo 写入**日志流**且"每日志流服务其所在节点上多个 Tablet"；多副本分散多可用区、仅 Leader 接受修改、**Multi-Paxos** 保证一致、Leader 故障从副本升主；observer 节点对等并本地执行路由到本机的 SQL；租户/资源单元 Unit/资源池；**ODP(OBProxy) 无状态 + SLB** 屏蔽分区与副本分布；**共享存储 SS 模式**：对象存储存全量日志与基线、副本共享基线、各副本自动识别热度仅本地缓存热点、**每个副本独立转储且转储数据不共享**） |
| D24 | https://help.aliyun.com/zh/polardb/polardb-for-postgresql/global-consistency | PolarDB PostgreSQL 版《全局一致性》 | 2026-09-23 | 1.7；考点 11（一写多读架构下 RO 默认提供**会话一致性**；物理复制 + 共享存储可降低复制延迟但**不能保证读到 RW 最新写入**；金融与游戏行业敏感；官方事故模型：微服务 A 写入成功→消息队列通知服务 B→B 读 RO 读到旧值→只能把读转发到 RW、**RO 资源被闲置**；开启全局一致性后 RW 每个读写事务提交时赋 **CSN** 构建高效事务快照（替代原生 PG 活跃事务列表）、CSN 写入 WAL、RO 回放 WAL 构建完整事务状态，从而集群维度强一致读） |
| D25 | https://doc.polardbx.com/zh/features/topics/distributed-transaction.html | PolarDB-X 官方文档《分布式事务》 | 2026-09-23 | 1.4/1.7；考点 8/11（TSO 全局单调时间戳 + MVCC 快照读；GMS 基于 **Paxos** 三节点高可用提供全局时钟；跨分区写走 **2PC** 且宕机可恢复；对账型 `SELECT SUM(balance)` 先取全局时钟再逐行可见性判断；只读实例 **Learner** 同步事务多版本 + **阻塞读**保一致性；**全局变更日志 CDC**："收集、重组、排序、落盘"多 DN 日志流，"提供满足分布式事务一致性语义的二进制日志"，下游诉求为"事务不能乱序、事务原子性、DDL 支持同步"，兼容 MySQL binlog 协议与生态；**PITR** 将任意时间点转为全局时钟按版本可见性恢复） |
| D26 | https://rocketmq.apache.org/zh/docs/featureBehavior/03fifomessage/ | Apache RocketMQ 5.0《顺序消息》 | 2026-09-23 | 1.4；考点 8（**数据实时增量同步**被列为顺序消息的典型场景：源库增删改→二进制操作日志作为消息→下游搜索系统按序还原，普通消息"可能导致状态混乱、与预期操作结果不符"；顺序判定单位是 **MessageGroup**（同组 FIFO、不同组与无组不涉及顺序）；生产顺序性要求**单一生产者 + 串行发送**；服务端"同组按序存同一队列、不同组可混合在同一队列且不保证连续"；细粒度消息组拆分可在满足局部顺序前提下提升并行度与吞吐） |
| D27 | https://www.alibabacloud.com/help/zh/apsaramq-for-rocketmq/product-overview/what-is-apsaramq-for-rocketmq | 云消息队列 RocketMQ 版《什么是云消息队列 RocketMQ 版》 | 2026-09-23 | 1.4/1.7；考点 14（定位为"低延迟、高并发、高可用、高可靠的分布式消息、事件、流统一处理平台"，提供微服务异步解耦、**流式数据处理**、事件驱动能力；"全面采用存储和计算分离的消息架构，存储和计算可独立按需水平扩展"；单实例集群最高 100 万 TPS；同城冗余 + 三副本；可用性最高 99.99%、数据可靠性最高 99.99999999%；"预留 + 突发"弹性"最高可节省一半机器资源"、存储 Serverless 按量付费；一键集成 OpenTelemetry、全链路 Trace、Prometheus） |
| D28 | https://rocketmq.apache.org/zh/docs/featureBehavior/09consumerprogress/ | Apache RocketMQ 5.0《消费进度管理》 | 2026-09-23 | 1.4；考点 10（位点三类：Min/Max/ConsumerOffset，堆积=Max−Consumer；有效位点必须 ≥ Min，否则"服务端会将消费位点强制纠正到合法的消息位点"；位点由服务端存储、与消费者无关、支持跨消费者恢复；初始位点在 5.x 定义为"首次获取消息时刻队列最大位点"而 4.x/3.x 受队列状态影响（升级需自行判断首次启动）；重置位点的三场景（初始不符、清理可丢弃堆积、业务回溯纠正处理）；**只能重置对消费者可见的消息，不能重置定时中、重试等待中的消息**；重置后历史消息多属冷数据会引发"冷读现象"、需严格控制调用权限） |
| D29 | https://rocketmq.apache.org/zh/docs/featureBehavior/11messagestorepolicy/ | Apache RocketMQ 5.0《消息存储和过期清理机制》 | 2026-09-23 | 1.4；考点 6/10/14（以**存储时长**为存储依据、时长内无论是否消费都保留、超过即清理；**按存储节点粒度**而非 topic/queue 管理并说明原因（存储层共享介质、按 topic 控时长仍有容量风险且可能打破存储时长 SLA）；建议"不同存储时长的消息通过不同集群分离治理"；建议在成本可控前提下延长存储时长，为故障恢复、排查与回溯保留操作空间；消息可通过重置位点被多次消费） |

> 抓取说明：`https://help.aliyun.com/zh/maxcompute/partitioned-tables/`（MaxCompute 分区表概述）与 `https://www.alibabacloud.com/help/zh/dataworks/user-guide/data-metric`（DataWorks 数据指标体系）在本环境只取到导航/标题级内容，**未**作为本文任何结论的依据；OceanBase《日志流和副本概述》（V4.2.3）页面抓取成功但正文与 D23 重叠，未单独引用。

---

## 7. 想写但没找到来源的方向（这些**不能**写进题面）

1. **阿里内部数仓的真实规模与分层命名**（任务数、表数、每日扫描量、双 11 大屏链路延迟与容量）。阿里云文档给出的是产品能力口径（100 万 TPS、亿级堆积、SLA 99.99% 等）与参数化规则（MaxCompute 单价、Hologres 版本行为），**没有**任何一份官方文档给出内部数仓规模；题面里出现的规模数字必须显式标注为假设并说明测法。
2. **OneData / 数据中台方法论白皮书的原文细节**。指标要素（主题域、业务过程、维度、原子指标、统计周期、派生指标）我用的是 **Dataphin 官方文档正文**【D18/D19】；网上流传的"OneData 方法论"图示与规范条目没有可抓取的一手文档，因此不写方法论版本、不写"阿里内部规范编号"。
3. **DataWorks 数据地图 / 血缘的底层实现与自动化程度**：抓取到的是功能页与导航（大盘、规则列表、资产定级），**没有**血缘采集机制、字段级解析算法与准确性度量的正文，因此考点 13 只写规则与阻塞，考点 12 只写口径元组，不写"自动血缘能做到什么"。
4. **Hologres / AnalyticDB 的官方性能对比数字与基准测试报告**：产品页给的"亚秒级交互式查询""点查毫秒级"是定性描述【D11/D14】，本环境未抓到可引用的 benchmark 正文（AnalyticDB MySQL 相关页取到 404），因此**不**写"N 倍于某引擎"，也不把 ADB 当独立考点。
5. **阿里云实时计算 Flink 版的自研算子/引擎版本演进（VVR 系列）与 Gemini 内部实现**：能核查到的是 SQL 优化开关、Gemini 的**配置项与行为**【D3/D4】，未见引擎内部实现与版本对照表的可引用正文；涉及版本差异处一律写"以官方文档为准"。
6. **Spark / PySpark 侧的阿里官方实现**：本仓库的 `pyspark` / `spark-scala` 判题器很成熟，但阿里官方并没有给出"Spark 上如何合并 Paimon 版本 / 如何做两阶段聚合"的规范文档；因此凡用 Spark 出题的地方，**机制取自阿里文档、解法写成通用 Spark 语义**，并在考点条目里标【推】（不要写成"阿里内部就这么做"）。
7. **OceanBase TPC-C 成绩单与"7 亿 TPS"类表述**：本环境未能抓取 oceanbase.com 上的成绩单正文（只抓到文档正文【D23】），因此考点 11 只用架构文档，不引任何 TPS/规模数字。
8. **Flink CDC 之外的自研同步组件（DTS/ADAM 等）与数据校验实现**：`help.aliyun.com/zh/dts/user-guide/data-validation` 在本环境返回 404 页，未抓到正文，因此考点 8 只用 Flink CDC + Canal + PolarDB-X CDC 三条可核查材料，**不**写 DTS 校验算法或断点续传细节。
9. **湖仓侧的 tag/branch、血缘回刷与"时间旅行"具体语义**：Paimon 相关页面里这些条目存在于导航（Advanced Features 等），但本次只抓取并核对了 Table Mode / Changelog Producer / Merge Engine / Partial Update 四页正文；因此考点里凡涉及"回刷窗口、快照保留"的表述都写成【推】并给出可验证方式，不引具体参数名。
10. **Kyuubi、StarRocks、Doris 等常被并列提到的查询引擎**：它们**不是阿里系**（Kyuubi 由网易发起），不能用于支撑"阿里考点"；若面试涉及，应显式标注项目真实出处，本文件不引入。
