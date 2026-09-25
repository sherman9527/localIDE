# OLAP 引擎选型：ClickHouse / Doris / StarRocks / Druid / 托管仓库（BigQuery 类）

对应考点：`olap-selection`、`olap-modeling`、`lakehouse-selection`、`data-cost`、`analytics-sql-patterns`
适配难度：senior / principal｜出题形式：`rubric + llm-rubric`（选型/建模）；SQL 模式类用 `code + mysql` 做等价性判分
版本基线（2026-09 核实）：ClickHouse 采用**日期式版本号**，26.8 为 LTS（2026-09 发布博客），26.x 系列带来 Iceberg/S3 Tables/Puffin 打通、QBit、文本索引（含中日分词）、pipelined SQL、后台查询等；Apache Doris 4.0.x（5.0 预览方向为"统一多模态湖仓"，细节需核实）；StarRocks 4.0（2026-08）；Apache Druid 37.0.0（当前最新）；BigQuery/Snowflake 的具体特性命名与 GA 状态**需核实**（不凭印象写）。

---

## 1. 核心机制

### 1.1 选型的六个正交轴（背"谁快谁慢"没用，要按轴打分）
| 轴 | 关键问题 | 差异点 |
|---|---|---|
| 查询形态 | 大宽表扫描聚合 vs 多表 star/snowflake join vs 点查 vs 全文/向量检索 | ClickHouse 偏单表宽表 + 极致扫描；Doris/StarRocks 偏 join + 主键更新 + 标准 SQL 生态；Druid 偏时序 + 亚秒 top-N + 精确去重（含 distinct 阈值）；托管仓库偏弹性并发 + 生态（BI/权限） |
| 数据新鲜度 | 秒级可见？分钟？提交/compaction 语义决定 | Druid 实时 segment + incremental expand；Doris/StarRocks 主键模型 stream load；ClickHouse 靠 `MergeTree` 异步 merge（`uniq_state`/物化视图近似） |
| 更新/删除 | upsert、部分列更新、撤回事件 | ClickHouse `ReplacingMergeTree`/`Lightweight delete`（语义与可见性有坑）；Doris/StarRocks 有主键模型 + 部分列更新（写放大与 compaction 代价要问）；湖仓直读则依赖 deletion vectors（Iceberg v3）/ Paimon LSM |
| 基数与内存 | 高基数 GROUP BY、精确 distinct、字典化 | 列式字典 + 聚合下推是否自动、内存超限行为（溢写 vs 报错 vs 降级近似）差异巨大 |
| 并发与隔离 | QPS 1000 的 API 型查询 vs 100 分析师 ad-hoc | 资源组/工作负载组、查询排队、结果缓存、物化视图自动改写、serverless 槽位弹性 |
| 运维与成本 | 谁做 compaction/扩缩容/备份/升级、跨区与 egress、存算分离程度 | 自研平台团队的真实成本项，面试里最能区分 principal |

### 1.2 建模层决定成败（不是引擎决定）
- **排序键/分区键/分桶键**职责不同：分区键裁掉整个数据块（时间/租户）、排序键决定"前缀能跳过多少"（ClickHouse `ORDER BY`、Doris/StarRocks 前缀索引 + 分桶）、分桶决定并发与 join colocate。
- 可加性是硬约束：`sum/count/min/max` 可加 → 预聚合/物化视图有效；**比率、distinct、中位数/分位数不可加** → 必须存 `uniq_state`/HLL/`quantiles` 中间态，或改查明细（成本爆炸）。
- 物化视图的三个坑：① 刷新与基表的一致性（异步 MV 的"查得到旧数"）；② 改写条件（SQL 形态稍有变化就不命中，团队于是"看起来有 MV 其实全走明细"）；③ MV 链的放大与 backfill（改一次口径重刷多久的数据）。
- join 策略：字典化/位图（低基数维度打包）、colocate bucket join、broadcast 小表、runtime filter/bloom（Doris/StarRocks 强项），或干脆在 ETL 侧打宽（用存储换稳定延迟）。
- 半结构化与向量：2026 的现实是"OLAP 顺手做 AI 检索"——ClickHouse 文本索引/`match`、Doris/StarRocks 向量索引与混合检索、Paimon/Iceberg 的 VECTOR/BLOB（需核实 GA）。选型问题变成"要不要为了一个向量检索再拉一个专门引擎"。

### 1.3 湖仓直读 vs 导入本地表
- 直读（Iceberg/Paimon external catalog）：省一份存储与同步链路、口径唯一；代价是扫描延迟、元数据/listing、并发与缓存能力有限、无法用引擎本地索引。
- 导入本地表：查询性能与并发可控；代价是新鲜度、双份存储、同步链路故障面、**"两份数据不一致"引发的口径争议**。
- 混合模式（多数大规模团队的终态）：明细留在湖（Iceberg/Paimon），OLAP 只物化"高频 + 低基数 + 有 SLA"的聚合层与服务层表；用 MV/物化作业 + 成本看板治理。

### 1.4 运维画像与故障模式（真做过的答案一定有这一段）
- ClickHouse：merge 风暴/`too many parts`、`max_bytes_before_external_group_by` 溢写、副本与 `Keeper` 运维、异步 insert 与 `wait_for` 语义、ZK 路径膨胀；26.x 的"后台查询/长任务"能力改变了部分异步作业写法（具体 API 需核实）。
- Doris/StarRocks：BE 内存与 `load` 失败（memtable flush 不及时）、compaction 落后导致读放大、FE 元数据与副本健康、主键模型索引内存占用、colocate 组变更代价。
- Druid：segment 版本与 publish 失败、realtime task 卡住导致数据延迟、compaction/over-shadow 策略与保留、查询超时与并发限制（"top-N + 精确 distinct"的阈值策略）。
- 托管仓库：并发/槽位配额、按需 vs 包年、egress、行级权限与成本归因；vendor lock 与"查询被静默降级"的可观测性。
- 统一要能答：**你怎么测出这个引擎在我们数据上的表现**（基准 = 真实查询日志回放 + 数据分布复刻，而不是 clickbench 跑分）。

---

## 2. senior / principal 会被追问什么

1. "为什么现在这个看板要 6 秒？"（期待：先看扫描量/文件数/分区裁剪是否失效，再看高基数聚合与内存溢写，再看 join 策略与并发排队；给出度量证据而非猜测）
2. "distinct UV 在预聚合表上算不出来，你怎么办？"（`uniq_state`/HLL 中间态 + 上卷合并；或按维度组合预计算；讲清精度损失与阈值）
3. "口径改了（分子分母都变），MV 链怎么安全重刷？"（影子表双跑对比 + 分区版本 + 切换与回滚点 + 下游通知）
4. "同一份数据湖 + OLAP 两处存，谁是真值？"（定义"湖为真值、OLAP 为服务层"，并给出一致性监控（行数/校验和/关键指标）与告警）
5. "要不要用 ClickHouse 替换 ES 做日志分析？什么场景会失败？"（全文/高亮/聚合式模糊查询、通配符、成本结构、需要 `text index`/`tokenbf` 才能追平的场景；反之聚合与扫描成本可降一个量级）
6. "实时 upsert 场景你为什么放弃 Kafka + 明细重刷，改用主键表？"（写放大、撤回消息处理、部分列更新、与 CDC 对齐）
7. "你做过 POC 吗？怎么在两周内让团队信服地选 A 不选 B？"（真实查询回放、故障注入、成本模型、迁移路径与回滚，含运维人力估算）
8. "向量检索要不要放进 OLAP？"（召回/延迟/内存成本、与标量过滤混合、embedding 版本与索引重建、和专门的向量库比谁的运维更贵）

---

## 3. 常见错误答案

- "ClickHouse 最快，选它" / "Doris 支持 join，选它"：没有按查询形态、数据分布、并发画像给证据。
- 不知道**比率与 distinct 不可加**，直接把 UV 预聚合到日表后再跨天求和（数字错误但看起来很正常——典型静默事故）。
- 把 OLAP 当 KV/在线服务用（无行锁、无低延迟点查保证、并发模型不同），或把交易库直接接 BI（把主库拖死）。
- 排序键选择随意（把低基数列放前缀首位，或把时间放最后导致裁剪失效）；只加分区不建排序键。
- 明细全量导入 OLAP 并保留长期全量（成本失控），或反向"直读湖"却要求 p95 < 500ms 的 API 服务。
- 忽略 compaction/merge 资源，压测只测查询（上线后写入风暴 + compaction 落后 = 双杀）。
- 用 `ReplacingMergeTree` 当作"立刻去重的 upsert 表"（合并异步、查询需 `FINAL`/`argMax`，代价与可见性都要讲）。
- 声称"引擎自带 MV 自动改写所以不用管建模"（改写命中条件严格，团队 SQL 千变万化）。
- 只比性能不比运维：自研三节点集群 vs 托管的 SRE 人力成本、升级路径、故障恢复时长完全不提。

---

## 4. 出题角度

### 题面草稿 A（`rubric`，10 分制）
> **Apple · Principal Data Engineer, Analytics Platform（45 分钟）**
> 现状：设备遥测与分析事件（日均 9000 亿事件、压缩后 1.2 PB/天、保留 90 天热 + 2 年冷）跑在"Spark 批 → Parquet 湖 → 某托管仓库 + ES 集群"上。痛点：① 托管仓库月成本超预算 3 倍且并发限流；② 工程师排障查询（按 `device_id` + 时间窗的明细检索）平均 12 秒；③ 分析师的 UV/留存跨天数字被质疑；④ 新增需求：产品内嵌的实时看板（200 QPS、p95 < 400ms）与"语义/向量检索日志"（LLM 排障助手要能按自然语言查日志并返回证据）。
> 请给出目标架构（引擎职责边界、湖/服务层数据分布、冷热与压缩策略）、四个痛点各自的根因与解法、迁移计划（含双跑与回滚）、以及你**拒绝**做的两件事与理由。要求给出成本与性能的量化估算方式（不是结论数字，而是"怎么测"）。

**加分点**
1. 痛点归因分层：托管仓库成本 = 全量明细入仓 + 并发模型不匹配；12 秒 = 排序/分区键未按 `device_id + ts` 设计（明细检索本质是"点查 + 小范围扫描"）；UV 错 = 不可加指标被跨天求和；实时看板 = 需要服务层聚合而非明细扫描。
2. 职责边界清晰：湖（Iceberg/Paimon，真值 + 明细 + 重算）→ 服务层（ClickHouse/Doris 类，排序键/物化视图/主键模型）→ 托管仓库（财务/对外/生态报表）；并说明"谁是真值"与一致性监控。
3. 建模具体：分区键（日 + 产品/地区桶）、排序键（`device_id, timestamp`）、低基数列字典化/`LowCardinality`（ClickHouse）或前缀索引（Doris）、`uniq_state`/HLL + `quantiles` 中间态、按查询日志导出 MV 集合并做命中率治理。
4. 可加性治理制度化：语义层里指标带"是否可加、上卷函数"，BI 层禁止对 distinct 类指标跨维求和（校验规则 + 测试用例）。
5. 实时链路：秒级/分钟级写入的 merge/compaction 预算与 `too many parts` 防护、批流两条路径写同表时的主键/版本裁决（部分列更新、撤回）；新鲜度用分位数指标监控。
6. 向量/自然语言查日志：给出两种方案（引擎内向量索引 + 标量过滤混合 vs 独立向量库 + 湖做证据回链）并比较召回、内存、重建与运维成本；强调"检索必须返回可验证证据（事件 id + 原始字段）"，为 agent 侧提供防幻觉锚点。
7. 成本与性能"怎么测"：真实查询日志回放 + 数据分布合成（含倾斜/高基数）+ 压测矩阵（并发 × 数据量 × 查询模板），单位成本口径（$/TB 扫描、$/QPS、$/查询 p95），冷存储与生命周期（分层/压缩算法对比）。
8. 迁移路径分阶段：影子集群双写 + 查询流量 1% 回放 + 指标对账（行数/校验和/Top-K 一致性）→ 逐域切读 → 停旧；每阶段判据与回滚点、以及"报表冻结发布窗口"。
9. 明确拒绝项且理由充分（例如：拒绝"把全部明细搬到新引擎保留 2 年"、拒绝"为每个看板建一张宽表"、拒绝"用 ES 同时做日志检索与聚合分析"）。
10. 隐私与合规：设备明细的访问控制（行/列级）、脱敏视图、查询审计与用途限制、PII 删除请求在两套存储中的落地与延迟承诺（对 Apple 场景是必需项）。

**不足点**
- 只换引擎不换建模（预测"迁移后同样慢"）。
- 不知道 distinct/比率不可加，或只说"用近似函数"不讲精度治理。
- 无量化验证方法（拿公开 benchmark 数字代替自身数据测量）。
- 无迁移与回滚方案；无一致性监控。
- 忽略运维（compaction/merge、parts 上限、副本与备份、升级）。
- 成本只报"应该能省"，不给单位口径与测量方式。

### 题面草稿 B（`code`，`judgeKind=mysql`，可迁移到任意 SQL 引擎的等价判分）
> 不可加指标的"上卷陷阱"练习。给定 `daily_uv(d date, country varchar, platform varchar, uv int)`（每天每 (country,platform) 的**精确去重 UV**）与 `daily_uv_user(d date, country, platform, user_id)` 明细：
> 1) 写出"7 日国家维度 UV"的正确 SQL（基于明细去重，不允许 `sum(uv)`）；
> 2) 证明 (1) 与"sum(uv) over 7 天"的结果差异（题面用固定数据，两个答案值不同，判题分别断言）；
> 3) 若只有 `daily_uv` + 每天 200 万行抽样明细，如何估算跨天 UV 且给出误差来源（写成 SQL + 一条 `SELECT` 注释即可，注释不参与判分，rubric 版会看）；
> 4) 建一个"可上卷"的中间表设计（列与主键），使 7 日/30 日 UV 可用 O(1) 上卷近似完成（答 `d` 粒度 + HLL 中间态，判题只断言你给出的建表语句在 MySQL 语法下可执行、且后续查询结果与 (1) 完全一致）。
> 用例：跨天用户重叠、同用户跨平台、单平台单国家边界、空明细日。

### 题面草稿 C（`rubric`，短题）
> "一个 3 张表的看板：事实表 8000 万行/天、两张维表。查询在 ClickHouse 上 p95 = 4s，在 Doris 上 p95 = 1.1s；把事实表打宽成单表后 ClickHouse p95 = 240ms，但每天多花 11 小时 ETL 且存储翻倍。你的决策流程与判据是什么？"
> 期望：按查询模板分类（多少比例走单表、多少必须 join）；把"打宽成本 + 新鲜度 + 存储 + 人力"与"join 方案在真实并发下的稳定性"做成可测对比（回放 + 并发压测）；提出第三条路（分层：核心聚合表预打宽 + 长尾走 join + colocate/bucket 优化 + runtime filter）；以及"什么信号会让你换引擎"（换引擎的迁移成本与收益门槛）。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Apple | Senior/Principal Data Engineer, Analytics Infrastructure | "Evaluate and operate OLAP/analytics engines; drive cost-performance tradeoffs with data" |
| Apple | Data Platform Engineer, Logging & Telemetry | "Build low-latency search/analytics over device telemetry at scale, with privacy controls" |
| Airbnb | Senior Data Engineer, Reporting / Metrics | "Design performant data models and serving layers; partner with BI and experimentation" |
| Airbnb | Staff Data Engineer, Data Platform | "Own technology selection and migration with measurable cost, latency, and reliability outcomes" |
