# 数仓建模、口径治理与回溯：让"数字一致"成为可验证的工程属性

对应考点：`dimensional-modeling`、`semantic-layer`、`analytics-sql-patterns`、`data-quality`、`backfill-reprocessing`、`orchestration-scheduling`、`data-governance-privacy`、`feature-store-pit`
适配难度：senior / principal｜出题形式：`code + mysql`（口径/建模）、`code + pyspark`（回填幂等）、`rubric + llm-rubric`（治理）

---

## 1. 核心机制

### 1.1 建模：先声明粒度，再谈分层
- **事实粒度（grain）是唯一不可妥协的决定**：一张事实表一行代表什么，必须能用一句人话写出来（"一行 = 一个房晚（listing×日期）"、"一行 = 一次点击"）。粒度含糊 → 后面所有 join 膨胀与重复计数都无解。
- 三类事实：事务事实（事件，append）、周期快照（每日余额/在架库存，semi-additive：不能跨时间求和）、累积快照（漏斗/生命周期，多日期列，随进度更新——更新语义要求主键表或 merge）。
- 维度：一致性维度（conformed dimension）+ 总线矩阵（哪些事实共享哪些维度）是"跨团队数字能对上"的唯一基础设施；退化维度（订单号）、杂项维度（低基数标志打包）、多值维度与桥接表（分摊因子，避免 fan trap/chasm trap）。
- SCD：
  - SCD1 覆盖（只适合"没有历史语义"的属性，如拼写修正）；
  - SCD2 拉链（开闭区间 `valid_from/valid_to/is_current`；同键多版本；**迟到记录**要插入到历史区间中间并保证区间不重叠不空洞）；
  - SCD3（有限回看，几乎不用）；
  - 真实坑：属性变更时"历史事实归到哪个版本"——必须按**事件时间做时点 join**（`fact.ts between dim.valid_from and dim.valid_to`），而不是 join 当前版本，否则国家/层级变更会重写历史指标。
- 分层（ODS/DWD/DWS/ADS 或 bronze/silver/gold）不是教条，判据是"复用度与 SLA"：能被 ≥3 个消费方复用的加工才允许下沉为公共层；否则是"复制税"。
- 2026 的落点：湖仓主键表（Paimon/Iceberg v3 deletion vectors）让"更新型事实（累积快照、SCD2）"从全量重刷变成可控 upsert；row lineage（Iceberg v3）让"这一行是哪次提交产生的"可查，直接影响回溯与审计能力。

### 1.2 口径与语义层（metric layer）
- 指标四要素：`实体（measure）+ 聚合 + 过滤器 + 时间粒度/归属规则`；派生指标必须可组合表达（ratio、period-over-period、同环比的"分子分母各自聚合再相除" ≠ "逐行相除再平均"）。
- 不可加性是治理重点：distinct/分位数/比率跨维上卷必须走中间态（HLL/`quantiles`/分子分母两列），语义层要能拒绝错误上卷（Airbnb Minerva 类思路：指标定义即代码、可版本、CI 校验依赖）。
- 引擎层新工具：Spark 4.2 `CREATE VIEW ... WITH METRICS`（把指标语义写进视图定义，需核实语义细节与生态支持）；MetricFlow/dbt 类、Cube 类 headless BI；OLAP 侧物化视图自动改写以语义层为输入（避免"MV 建了但没人命中"）。
- 口径变更治理：新定义带版本号与生效时间；历史是"重算（改变历史数字）"还是"截断（新数字从今天起）"必须显式决定并公告；报表与财务口径之间要有映射表与对账。

### 1.3 数据质量（阈值来自分布，不来自玄学）
- 规则六类：存在性（分区/延迟）、模式（字段/类型/枚举值域）、唯一性（主键重复）、完整性（空值率、关键非空）、一致性（跨层/跨表对账、借贷/父子总量）、业务合理性（波动、比率区间、分布漂移）。
- 阈值决策方法：拿过去 90 天同规则分布定 p99/p01 边界；工作日/周末/大促分层；**"绝对量 + 相对量"双条件**避免凌晨低峰误报（例：`abs(diff) > 50k AND ratio > 20%`）；错误预算化（连续 N 天违规才升级 P1）。
- 处置分级：阻塞（发布/下游刷新失败并告警）vs 隔离（quarantine 表 + 继续跑）vs 观察（打点不告警）。核心报表/资金类必须阻塞；探索分析类不应被过度阻塞（否则团队会偷偷关掉规则——比没规则更糟）。
- 契约与血缘：上游变更走契约（schema、语义、到达 SLA、回填协议），消费方注册；列级血缘 + 影响分析自动化（改字段 → 谁受影响 → 通知文案自动生成）。
- 事故复盘标准产出：一条新规则 + 一个卡口 + 一次演练（缺任一条就是没复盘）。

### 1.4 回溯（backfill）：被最少人讲对的部分
- 回填四类动机：新增字段/历史修数/口径重算/上游补数据。共同要求：**幂等**（按分区或主键覆盖）、**边界正确**（时间窗口与快照版本）、**可重跑**（失败从断点续，不产生中间脏态）。
- 关键决策：读"历史快照"还是读"当前状态"？（同一份回填逻辑重跑结果必须确定 → 输入要版本化/快照化，否则"重跑昨天的作业"结果随上游变化漂移，事故排查永远复现不了）。
- 与在线链路共存：回填资源与流/批作业隔离（队列、并发上限、时间窗错峰）；回填写 sink 用 upsert + 更低的 `version`，防止把线上更新的值倒回去。
- 双跑对账（放行判据）：行数 / 主键集合差 / 关键指标差异率 / Top-K 一致 + 差异样本可解释；连续 K 天满足阈值才切读，保留回滚点（快照或分区版本）。
- 调度表达：数据就绪驱动（分区/快照存在 + 质量规则通过）而非纯时间驱动；回填 DAG 与日常 DAG 共享同一份逻辑（一份 SQL/算子定义，两种参数化），杜绝"回填逻辑和在线逻辑不同"导致的永久偏差。

---

## 2. senior / principal 会被追问什么

1. "这张事实表的粒度是什么？如果业务要求同时看'每次搜索'和'每个会话'，你建一张还是两张？"（两张 + 一致性维度 + 会话表带搜索计数，避免双计）
2. "用户搬家了/房东改了国家，历史指标要不要变？你怎么实现和怎么解释给业务？"（时点正确 vs 当前归属两种口径同时提供，并显式命名）
3. "你的核心表有多少条质量规则？误报率多少？上次事故是因为缺了哪条？"（真做过的人会报数量和误报趋势）
4. "上游把一个字段从 'UTC' 改成'本地时间'，没通知。你的防线？"（分布/时区一致性检查：与另一时间源比对偏移量、跨时区计数突变）
5. "口径改了，历史上 400 张下游表怎么办？"（影响分析 + 分层重算计划 + 公告 + 冻结窗口 + 对账放行）
6. "回填和在线同时跑，怎么防止回填把新数据覆盖成旧的？"（version/序列字段、分区隔离、幂等 upsert 条件）
7. "怎么让'数字对不上'不再靠人对 SQL？"（语义层单点定义 + 自动化交叉校验：同一指标经两条独立路径算出来的 nightly diff）
8. "GDPR 删除请求在数仓里怎么落地？"（湖表 deletion vector/merge、OLAP 本地表、备份与快照保留期、下游导出的治理、以及"删除可证明性"）

---

## 3. 常见错误答案

- "按维度建模四步法"背流程，但不给真实粒度决策与代价（问"为什么不用宽表"就哑）。
- SCD2 只写 `is_current`，不处理**迟到记录插入历史区间**、不处理同批次多版本。
- 时点 join 写成 join 当前维表，导致历史指标随维度变更漂移（最经典的静默错误）。
- 比率类指标"逐行相除再求平均"当作日均转化率。
- 跨天 `sum(uv)`、跨层 `sum(比例)`（不可加性）。
- 质量规则一刀切"阻塞"，团队把规则关掉；或一律"只告警"，没人看。
- 阈值写"波动 > 10% 告警"（无分布依据、无绝对量条件、周末必炸）。
- 回填逻辑与日常逻辑两份代码（永久偏差）；回填不可重跑（跑一半失败留下脏分区）。
- 认为"有血缘图 = 有治理"，无影响分析闭环与通知机制。
- 用 `max(updated_at)` 增量代替 CDC（丢删除、丢回拨）。

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=mysql`）
> **SCD2 拉链 + 时点正确指标**
> 给定 `dim_listing_current(listing_id, country, room_type, src_ts)` 每日快照（首行即第 1 天）与 `fact_booking(booking_id, listing_id, booked_at, nights, gmv)`。
> 要求：
> 1) 用 SQL 从每日快照生成 SCD2 拉链（`valid_from`, `valid_to`, `is_current`），处理"属性回改"（A→B→A 必须产生 3 段）；
> 2) 用拉链计算"按预订时点的国家归属"的 GMV（时点 join），并与"按当前归属"的 GMV 做差（输出两列，判题分别断言）；
> 3) 处理"快照缺失某天"（该天空洞必须把前一段 `valid_to` 延长而不是造出 null 段）；
> 4) 输出按 `(country)` 排序，tie-break 规则写在题面。
> 用例：属性回改、缺失快照日、同一天多条变更、booking 落在拉链边界（`valid_from` 当天必须归属新段，边界规则写明并断言）。

### 题面草稿 B（`code`，`judgeKind=mysql`）
> **漏斗 + 留存 + 会话切分（口径钉死）**
> 给定 `user_events(user_id, event_type, ts)`（含乱序、重复事件、跨零点心跳）。
> 1) 会话切分：30 分钟无活动新会话（同毫秒事件不得产生 0 长会话；心跳事件 `type='heartbeat'` 不延长会话）；
> 2) 3 步漏斗（search → detail → request），时限：search→detail ≤ 10 分钟、detail→request ≤ 60 分钟，允许"多次 search 后取最近一次 search 作为起点"（题面给定 tie-break），输出每步转化人数与整体转化率（**比率必须在人数层聚合后再除**）；
> 3) D7 留存：分母为"首次活跃日在窗口内的新用户"，分子为"第 1～7 天内任一活跃"（与"恰好第 7 天"两种口径各出一列，命名区分）；
> 4) 重复事件（同 `user_id,event_type,ts`）只能算一次。
> 用例：跨零点心跳、乱序到达、多次 search、只完成两步、孤立 detail（无 search 不得计入分子）、新用户定义窗口边界。

### 题面草稿 C（`code`，`judgeKind=pyspark`）
> **幂等回填 + 版本不倒退**
> 输入：`fact`（列 `id, amount, version, day`）与两批数据 `batch_current`、`batch_backfill`（`batch_backfill` 含**更旧 version** 的修正行与新增 id）。
> 实现 `apply_batches(fact, batches: list[DataFrame], key="id", ver="version") -> DataFrame`：
> ① 同一 id 只保留最大 version（version 相同则后到批次不覆盖，保证可重跑幂等）；
> ② 回填批次不得把值倒回旧版本；③ 结果按 id 升序、输出 `id, amount, version`；
> ④ 提供 `rerun_idempotent` 语义：同一批再执行一次结果不变（判题对同一输入执行两次并断言一致）；
> ⑤ 被丢弃行数写入 `(dropped_backfilled, dropped_stale)` 两列聚合结果（题面给出期望值）。
> 用例：旧 version 到达、同 version 重复、新 id、删除标记（题面给定 `__deleted` 需排除但计数）。

### 题面草稿 D（`rubric`，10 分制）
> **Airbnb · Senior/Staff Data Engineer, Metrics & Experimentation（40 分钟）**
> 你有 2600 张表、380 个看板、4 个团队各自"算 GMV/预订量/活跃房东"，历史上每月出现 2–3 次"数字对不上"的升级事件；实验平台依赖同一批表但要求"指标口径变更必须与实验版本对齐"。老板要求 6 个月内做到：① 核心指标单一定义、② 口径变更不再靠邮件、③ 数字对不上的排查从"人肉对 SQL"降到自动定位。
> 给出：目标分层与语义层设计（含模型/元数据/权限）、口径变更流程与 CI 卡口、自动一致性校验（同一指标多路径 nightly diff + 差异归因）、回填与重算策略（含历史是重算还是截断的决策规则）、质量规则与阈值方法、成本与性能约束（语义层不能把看板拖慢）、采纳策略（怎么让 4 个团队真的迁过来）。

**加分点**
1. 先定义"核心指标集合"（不超过 20 个）与 owner，明确"其余指标允许自由探索但不进对外报表"——治理从范围收敛开始。
2. 语义层模型有结构：实体/维度/度量/过滤器/时间归属/可加性标志/版本；能拒绝不可加错误上卷，且能生成 SQL 到多引擎（湖 + OLAP）并解释差异。
3. 变更流程工程化：指标即代码 + PR 评审 + CI（定义 diff、影响分析、查询成本回归、看板快照对拍）+ 版本与生效日期 + "重算 vs 截断"决策规则（财务口径不可重算、分析口径可重算并标注）。
4. 自动一致性：双路径（明细重算 vs 聚合层上卷）nightly diff，差异按"维度组合 × 日期"归因并给到表 owner；差异率纳入作业 SLA 而非人工抽查。
5. 质量规则与阈值有推导方法（90 天分布、双条件、节假日分层、错误预算），且区分阻塞/隔离/观察三档。
6. 血缘落地：列级血缘来自编译期解析（不是人工登记），变更通知自动生成并带影响清单与回滚建议。
7. 性能与成本：语义层查询要能被 MV/聚合层命中（命中率与延迟指标），并为高并发看板留"物化旁路"；拒绝为长尾查询无限扩层。
8. 采纳与组织：迁移工具（自动生成同口径 SQL 做双跑对比）、按团队配额与激励、旧看板 sunset 时间表、培训与文档；明确"不会强制消灭所有裸 SQL"。
9. 与实验平台联动：指标版本与实验曝光对齐（曝光时点的指标定义），SRM/口径变更导致的历史实验不可比要能被标注。
10. 度量治理成效的指标本身（数字争议事件数、迁移覆盖率、语义层命中率、口径变更 lead time、成本/查询）。

**不足点**
- 只谈"建语义层工具"，不谈范围收敛、owner 与流程。
- 无自动对账/归因（仍靠人排查）。
- 忽略不可加性与上卷正确性。
- 质量阈值全是"经验值"，无分布依据、无分级处置。
- 不处理"历史重算 vs 截断"的财务/合规约束。
- 无成本与延迟约束（语义层变成查询瓶颈）。
- 采纳策略缺失（工具上线但 4 个团队不迁）。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Airbnb | Senior/Staff Data Engineer, Metrics / Reporting | "Be the owner of trusted business metrics; build semantic/metrics layer"; "Drive data quality, lineage and SLAs"; "Work with experimentation platform" |
| Airbnb | Data Engineer, Marketplace Supply | "Dimensional modeling for complex marketplace entities"; "Backfill and reprocess with correctness guarantees" |
| Apple | Senior Data Engineer, Business Analytics Platform | "Build governed, privacy-compliant analytics layers used across orgs"; "Establish data quality standards" |
| Apple | Data Engineer, Telemetry Warehouse | "Model high-cardinality event data; ensure reproducible processing" |
