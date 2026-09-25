# PySpark 正确性与性能：语义陷阱、4.x 新武器、可判分写法

对应考点：`pyspark-python-perf`、`join-strategy`、`structured-streaming`、`spark4-new-capabilities`、`backfill-reprocessing`
适配难度：senior / principal｜出题形式：`code + pyspark`（主力）+ `rubric + llm-rubric`

---

## 1. 核心机制

### 1.1 语义陷阱（这些是"真做过"与"背过 API"的分水岭）
| 陷阱 | 出错方式 | 正确姿势 |
|---|---|---|
| `insertInto` 按**位置**匹配列 | 上游加列/改顺序后数据串列，且不报错 | 显式 `INSERT INTO t (c1,c2) SELECT ...`；或写前先 `SELECT` 对齐 + `spark.sql.storeAssignmentPolicy` 严格 |
| 4.0 ANSI 默认开启 | 除零、溢出、非法 cast 由"变 null"变成**抛异常**；`try_cast`/`try_divide` 成为必需品 | 迁移时显式列出口径差异点；对脏数据用 `try_*` + 质量规则隔离，而不是全局关回 ANSI |
| 外连接过滤位置 | `LEFT JOIN ... WHERE b.dt='2026-09-01'` 把未匹配行吃掉，退化成 inner | 谓词进 `ON`（或 join 前子查询过滤）；对 `null` 语义用 `<=>` 做 null-safe 比较 |
| `first()` / `last()` 非确定 | 每次跑结果不同（分区顺序决定），下游"数据偶发不一致"排查半天 | 用 `row_number()` + 显式排序，或 `max(struct(ts, payload)).col` 取"最新一条" |
| 浮点等值 join/去重 | `amount = 0.1+0.2` 不等；金额类丢精度 | `DECIMAL`/整数最小单位；比较用容差或字符串规范化 |
| `join` 同名列 | `df1.join(df2, "id")` 后 `id` 只保留一列但 `select("*")` 顺序意外；用 `df["id"]` 触发 AMBIGUOUS | join 前重命名/加别名，用 `join(cond)` 而非字符串列表 |
| 窗口 + `dropDuplicates()` 流式 | 无 watermark 时不删；有 watermark 时**状态过期后旧 key 再来又被视为新记录** | 明确"去重窗口 = 业务允许的最大迟到 + 重复到达跨度"，并在 sink 侧加主键 upsert 兜底 |
| `withColumn` 链 + UDF | 表达式树膨胀、优化器无法下推；UDF 被当非确定函数阻断谓词/列裁剪 | 合并表达式、内置函数优先；确需 UDF 时显式 `deterministic=True` |
| 时间戳与时区 | `timestamp` 无时区语义，`from_utc_timestamp` 双重转换导致"报表差 8 小时" | 统一存 UTC（`timestamp_ntz` 只用于业务日历时间）；在展示层转换并写清口径 |
| 分区覆盖写 | `mode("overwrite")` 默认清全表；动态分区覆盖要 `spark.sql.sources.partitionOverwriteMode=dynamic` | 湖仓用 `MERGE INTO`/主键表 upsert；批回填按分区覆盖 + 幂等键 |
| 缓存滥用 | `cache()` 后同一 DataFrame 被多次 action 且被驱逐 → 静默重算（结果还可能因上游变化不一致） | 明确血缘与内存预算；需要"冻结数据"就落盘（parquet/表快照）而不是 cache |

### 1.2 Spark 4.x 的"新正确性表达"（2025–2026）
- **VARIANT**（4.0 引入、4.1 GA 且默认启用）：半结构化落地为列式 + shredded 结构；支持 `col:field` 冒号算子、`parse_json` / `try_parse_json`、Parquet VARIANT 读写。用途：日志/事件 schema 异构、又想要列裁剪与统计；与"每字段一列的宽表"或"JSON 字符串列"的取舍是好的 senior 考点。
- **CDC 一等公民**（4.2）：`SELECT ... FROM t CHANGES ...` 在批与流里读行级变更；配合声明式管道（Spark Declarative Pipelines，4.1 引入）的 **Auto CDC / SCD1 upsert**，把"回填 + 增量"从手写 merge 变成声明。
- **`NEAREST BY` join（4.2）**：top-K 最近邻原语（向量/距离表达式）；`QUALIFY`（4.2）替代"子查询 + 窗口过滤"的样板；`CREATE VIEW ... WITH METRICS`（4.2）把语义/指标定义推进引擎层；`INSERT INTO ... WITH SCHEMA EVOLUTION`（4.2）让上游加列不再手写 DDL。
- **地理空间（4.2 默认启用）**：`GEOMETRY`/`GEOGRAPHY` 类型与 `ST_*` 函数（PROJ SRID 注册表）；对 Airbnb/Apple 的地图/网格类作业是真实新工具（listing 网格、POI 匹配、GeoHash 替代）。
- **Python 侧性能**：4.1 Arrow-native `@udf`/`@udtf`（免 pandas、迭代器语义）、Python 数据源谓词下推、UDF 走 Unix Domain Socket；4.2 默认启用 Arrow 优化 UDF/IPC、支持 PyCapsule（Arrow C 接口，与 Polarus/Polars/DuckDB 零拷贝互操作）。
- **Spark Connect（4.0 起一等公民，4.1 MLlib on Connect GA + JDBC driver，4.2 补 RDD/reader 兼容与 History Server tab）**：平台侧隔离笔记本用户与作业；代价是 UDF 需服务端可加载、RDD 生态兼容边界、以及"客户端不在 executor 侧"带来的调试差异。
- **流式**：4.1 Real-Time Mode（无状态算子毫秒级，先 Scala）、无状态流支持 AQE、state store 锁与快照修复重构；4.2 RTM trigger 进 PySpark、stream-stream 非 outer join 支持 update mode、source/sink `.name()` 稳定标识（防 checkpoint break）、state 快照校验和自愈。

### 1.3 可判分代码题的设计原则（给出题脚本用）
1. 单机 `local[*]` 可跑：不依赖 metastore/Kafka/HDFS；数据用 `spark.createDataFrame` 或临时目录 parquet。
2. 断言**语义**而非实现：行集完全一致（含 null/浮点规范化）、必要断言附加"资源约束"（如输出文件数、是否调用 `collect`——可通过反射/监听器统计，谨慎实现）。
3. 每个用例都要有"背 API 的人会通过、乱用的人会挂"的边界：同 key 多版本、跨天重复、null key、时区、ANSI 异常行。
4. 允许两种以上解法（窗口 `row_number` / `max(struct)`）但结果必须唯一确定 → 题面必须钉死 tie-break 规则。

---

## 2. senior / principal 会被追问什么

1. "你团队 code review 里 PySpark 的三条红线是什么？"（期待：禁 `insertInto` 位置匹配、禁非确定函数取"最新一条"、禁 `collect`/笛卡尔、分区覆盖写必须显式）
2. "这段 SQL 迁到 Spark 结果差 0.3%，你怎么查？"（ANSI 行为、除零/null 聚合、隐式 cast、时区、`order by` 并列不确定）
3. "半结构化日志该存宽表、JSON 字符串还是 VARIANT？给出查询成本与 schema 演进的具体对比。"
4. "上游今天加了 5 个字段，你的作业会坏吗？坏在哪一层（读取、schema 对齐、写出、下游口径）？"（考 schema evolution 与契约测试）
5. "PySpark 比 Scala 慢多少、你实际怎么把 40 分钟降到 8 分钟？"（期待：Arrow UDF/批式向量化、去掉 Python 往返、改内置表达式、广播替代 shuffle join、修倾斜）
6. "Connect 模式下你怎么调试一个只在你集群复现的 bug？"（event log、plan metrics、profile、`spark.sql.execution.*`、sidecar 与 UDF 打包）
7. "回填一年的数据同时线上流在跑，怎么保证互不踩踏？"（分区/主键 upsert、版本与幂等键、双跑对账、水位与资源配额隔离）
8. "你如何测试一个数据管道的正确性？"（期望：契约测试 + golden dataset + 不变量断言 + 影子跑 diff + 回滚点）

---

## 3. 常见错误答案

- "`repartition` 和 `coalesce` 都是调并行度" → 不知道 coalesce 不重分布、会把倾斜原样带下去。
- 用 `df.dropDuplicates()` 处理"取最新一条"（丢的是整行重复，不是 key 重复）。
- 用 `first()` 取最新（无序非确定）。
- 认为 `mode("overwrite")` 只覆盖当天分区。
- 在 UDF 里读广播变量以外的外部服务（每行一次 RPC），或反过来把 broadcast 一张 5GB 表。
- 关 ANSI 来"修报错"，而不是隔离脏数据。
- 用 `cache()` 当"持久化"，或用 `persist(MEMORY_ONLY)` 后不管驱逐重算风险。
- "Spark 4 的 VARIANT 就是 JSON 列" → 讲不出 shredded 布局与列裁剪/统计收益，也讲不出何时反而变慢（大量小字段、超宽 schema 的元数据成本）。
- 把 CDC 一律实现成 `max(updated_at)` 增量 → 说不清删除丢失、同毫秒并列、回滚与回填。

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=pyspark`）
> **版本化去重 + 迟到修正（点改合并）**
> 输入 `changes`：列 `id, name, amount(DECIMAL(18,2)), version(BIGINT), is_deleted, event_ts`，同一 `id` 多行、顺序任意、含 `version` 相同但 `event_ts` 不同的行。
> 实现 `merge_current(base, changes) -> DataFrame`，语义：
> ① 按 `id` 合并，存活行取 `version` 最大；`version` 相同取 `event_ts` 最大；再相同取 `is_deleted=false` 优先（tie-break 全部在题面写明）；
> ② `is_deleted=true` 的行从结果中消失（软删转硬删）；
> ③ `amount` 为 null 表示"该字段本次不更新"，需沿用 base 的值（部分更新语义）；
> ④ 结果按 `id` 升序，输出列 `id, name, amount, version`。
> 约束：不得 `collect`/`toPandas`；不得使用非确定函数（`first`）；ANSI 默认下若出现 `DECIMAL` 溢出必须显式处理（题面给出"溢出即置 null 并记入 `error_count`"要求）。
> 用例：并列 version、删除后重新出现（新增更高 version 复活）、部分更新、null name、超宽 amount 溢出、base 中不存在的 id（按新增处理）。

区分度来源：②③需要真正的 merge/upsert 思维（`max(struct(...))` 或窗口 + `coalesce` 组合），并且 tie-break 必须靠排序键确定。

### 题面草稿 B（`code`，`judgeKind=pyspark`，性能改写）
> 给出一段"故意写得慢"的作业（10 万行内存表）：`withColumn` 链 + 行级 Python UDF（做 `json.loads` 取字段）+ `union` 后 `dropDuplicates` + 未过滤即 join。
> 要求：在**结果与给定 golden 输出完全一致**的前提下重写，并满足：① 不使用 Python 行级 UDF（用内置 `get_json_object`/`from_json`/`try_parse_json` 或 4.1+ 的 Arrow UDF 之一）；② join 前完成过滤与列裁剪；③ 输出文件数 ≤ 4；④ 执行时间低于基线的 50%（判题按机器实测，留足宽容度）。
> 用例：正确性 + 文件数 + 计时上限。若运行环境不支持计时判据，判题退化为"结构断言"（无 Python UDF、join 前存在 Filter 节点）。

### 题面草稿 C（`rubric`，10 分制）
> **Airbnb · Senior Data Engineer（35 分钟）**
> 事件类数据 `guest_reservation_events` 以 Kafka → 湖（Iceberg/Paimon）落地，schema 由 12 个团队共同贡献，日均 40 亿事件、字段 1200+、半结构化 `attributes` 占比 35%。现状：宽表 + JSON 字符串混用；下游有 BI、ML 特征、风控三类消费者；上周一次"上游把 `status` 从 string 改为 int + 新增 3 字段"导致 BI 报表 4 小时数字静默错误（没报错，数字错了）。
> 请给出：存储/类型方案（宽表 vs VARIANT vs 属性表）的选择与量化依据、schema 契约与演进治理（谁审批、CI 里跑什么、破坏性变更定义）、"数字静默错误"的防线（质量规则 + 语义层 + 影子对账）、回填与迟到数据修订方案（含删除事件）、以及三类消费者的一致口径机制。

**加分点**
1. 明确"静默错误"根因是**类型/语义变更 + 隐式 cast**，并给出可自动检测的不变量（枚举值域、null 率、按维度的分布漂移、与上游计数对账），而非只说"加 DQC"。
2. 类型方案有量化对比：列裁剪收益、压缩率、扫描字节、schema 爆炸的元数据成本、VARIANT shredded 读写代价，并说明三类消费者分别用什么（BI 用物化视图/语义层，ML 用特征快照，风控用明细 + 属性表）。
3. 契约治理：兼容性分级（backward/full）、CI 中 schema diff + 消费者驱动契约测试、"新字段先发布容错版本再启用"的两步走、变更冻结窗口。
4. CDC 方案具体：用 `CHANGES`/Auto CDC（Spark 4.2）或表格式 `MERGE`，删除事件靠 tombstone；回填按分区覆盖且幂等，双跑对账（行数/主键集合/校验和/关键指标）后放行。
5. 迟到修订：区分"迟到新键"与"迟到旧版本"，前者直进、后者按 version/事件时间裁决 + 快照重算窗口（滚动 N 天重算），并说明与 watermark/state TTL 的耦合。
6. 一致口径：语义层单点定义指标（比率/去重类不可加的聚合规则）、BI 走语义层不允许裸 SQL、变更需版本 + 生效时间 + 影响分析（下游报表清单）。
7. 成本意识：属性表/半结构化对小文件的放大、compaction 预算、按消费者的查询成本归因。
8. 运维闭环：事故复盘产出的三条卡口（可执行）、值班手册、数据契约变更审批 SLA。
9. 迁移路径：不停写迁移（双写 + 对比 + 切读），并保留回滚点（表快照/时间旅行）。
10. 能引用 4.x 能力但不迷信：指出 `try_parse_json`/VARIANT/`QUALIFY`/`WITH SCHEMA EVOLUTION` 各自适用边界与仍然解决不了的问题。

**不足点**
- "统一改成宽表 + 每字段一列"（忽略 1200 字段与 12 团队现实）。
- 只说"加 Airflow 依赖 / 加 DQC 规则"，无静默错误的针对性防线。
- 删除事件与部分更新处理不了（把 `max(updated_at)` 当 CDC）。
- 无回填对账与放行判据。
- 忽略 schema 演进的治理流程（只谈技术）。
- 建议"关掉 ANSI / 用字符串存一切"以规避报错。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Airbnb | Senior Data Engineer, Marketplace / Growth | "Build reliable, well-modeled datasets; partner with analytics and ML on definitions" |
| Airbnb | Staff Data Engineer | "Lead pipeline modernization (lake formats, CDC, streaming-batch unification) with measurable quality and cost impact" |
| Apple | Data Engineer, Spark/Scala-Scala Platform | "Expert PySpark/Spark SQL; drive performance and correctness standards across teams" |
| Apple | Senior Data Engineer, Privacy-aware Analytics | "Implement scalable pipelines with strong data-quality and privacy controls" |
