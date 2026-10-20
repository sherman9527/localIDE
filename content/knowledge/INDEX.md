# 知识库索引（自动生成，请勿手改）

> 由 `npm run kb:index`（`node scripts/kb/compile-knowledge.mjs`）生成。
> 生成时间：2026-10-20T13:51:28.650Z
> 输入：`content/knowledge/<类别>/README.md` 考点矩阵（7 类）+ 题库 258 题（其中软删除 0 题不计入"已出题"）。
> 覆盖判定：题目 `tags[]`（去掉时代前缀，前缀表 = `shared` 的 `TAG_ERA_PREFIXES`）命中矩阵第 1 列反引号里的 tag 即算已覆盖；
> 未写反引号 tag 的行列进「无显式 tag（无法判定）」单独统计，其中**靠标签派生 slug 撞上的**另列一档（改中文名就会变，脆）。
> 脱钩标签分两个口径：**元标签**（只有 `company:*` 前缀与纯公司名，规则 = `shared` 的 `classifyOrphanTag`）本来就不该有考点行；⚠ 带 `modern:` 的脱钩**算缺口不算元**：剥掉前缀之后矩阵里仍然没有那一行，那就是一个真考点穿着标记的外衣（评审 I1）；
> **考点缺口**才是"该给矩阵补一行"的可行动数 —— 只看合起来的 N 会被元标签撑到失真。

## 类别总览

| 类别 | 考点数 | 含 code 形式 | 含 rubric 形式 | 无显式 tag（无法判定） | 仅派生 slug 命中（脆） | 语料篇数 | 已出题（可见） | 代码题 | 主观题 | 已覆盖考点 | 未覆盖考点 | 覆盖率 | 脱钩标签（元/缺口） | 判分方式分布 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`frontend`](./frontend/README.md) 前端工程 | 20 | 17 | 3 | 0 | 0 | [4](./frontend/README.md#语料文件) | 23 | 23 | 0 | 13 | 7 | 65% | 79（元 0/缺口 79；写法 79） | react-vitest=23 |
| [`algorithms`](./algorithms/README.md) 算法 | 20 | 19 | 1 | 20 | 0 | [4](./algorithms/README.md#语料文件) | 59 | 59 | 0 | 0 | 0 | — | 241（元 0/缺口 241；写法 245） | java-junit=59 |
| [`sql`](./sql/README.md) SQL 与存储 | 21 | 19 | 2 | 20 | 0 | [5](./sql/README.md#语料文件) | 50 | 50 | 0 | 0 | 1 | 0% | 214（元 0/缺口 214；写法 216） | mysql=36 redis=14 |
| [`system-design`](./system-design/README.md) 系统设计 | 21 | 8 | 13 | 0 | 0 | [5](./system-design/README.md#语料文件) | 36 | 0 | 36 | 19 | 2 | 90% | 143（元 0/缺口 143；写法 144） | llm-rubric=36 |
| [`big-data`](./big-data/README.md) 大数据处理 | 30 | 9 | 21 | 0 | 0 | [7](./big-data/README.md#语料文件) | 38 | 26 | 12 | 19 | 11 | 63% | 149（元 0/缺口 149；写法 151） | pyspark=24 llm-rubric=12 spark-scala=2 |
| [`agent-design`](./agent-design/README.md) Agent 设计 | 17 | 3 | 14 | 0 | 0 | [5](./agent-design/README.md#语料文件) | 27 | 0 | 27 | 13 | 4 | 76% | 103（元 0/缺口 103；写法 105） | llm-rubric=27 |
| [`hot-interviews`](./hot-interviews/README.md) 高频面试题 | 18 | 4 | 14 | 0 | 0 | [12](./hot-interviews/README.md#语料文件) | 25 | 0 | 25 | 10 | 8 | 56% | 108（元 2/缺口 106；写法 111） | llm-rubric=25 |

**合计**：147 个考点，其中 107 个可机器判定覆盖，已覆盖 74 个（69%）；题库 258 题。
**脱钩考点合计**：1037 个概念（1051 种写法）= 元标签 2 个 + **考点缺口 1035 个**（后者才是"该补一行矩阵"的清单）。

## 未覆盖考点（"该出什么题"的直接答案）

### `frontend`｜未覆盖 7 / 可判定 20 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `ts-strict-compilation` 严格编译基线与 6.0 迁移｜形式 code｜judgeKind react-vitest｜JD 能力项：APL-WEB-1
- `conditional-types` 泛型与条件类型实战｜形式 code/rubric｜judgeKind llm-rubric｜JD 能力项：APL-WEB-1
- `react-compiler` React Compiler 1.0 与手动 memo 取舍｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：APL-WEB-1 APL-WEB-2
- `numeric-text-time-boundaries` 数值/文本/时区边界｜形式 code｜judgeKind react-vitest｜JD 能力项：APL-WEB-4 APL-WEB-1
- `flaky-test-governance` 测试可判分性与 flaky 治理｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：APL-WEB-5
- `esm-cjs-interop` 构建产物与模块互操作｜形式 code｜judgeKind react-vitest｜JD 能力项：APL-WEB-1 APL-WEB-5
- `server-components` Server Components 的边界与坑｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：APL-BE-1 APL-WEB-1

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：79 个概念 / 79 种写法（元标签 0 / 考点缺口 79）**
   要处理的是那 **79 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `race-condition`（3 题：fe-react-0001, fe-react-0002, fe-react-0003）
- `cancellation`（3 题：fe-react-0001, fe-react-0002, fe-react-0009）
- `null-vs-zero`（3 题：fe-react-0013, fe-react-0014, fe-react-0017）
- `marketplace-rules`（3 题：fe-react-0015, fe-react-0017, fe-react-0018）
- `forms`（2 题：fe-react-0004, fe-react-0005）
- `large-list`（2 题：fe-react-0006, fe-react-0009）
- `profiler`（2 题：fe-react-0006, fe-react-0007）
- `partial-failure`（2 题：fe-react-0009, fe-react-0011）
- …另有 71 个考点缺口（完整清单：`--orphan-audit-json`）

### `algorithms`｜未覆盖 0 / 可判定 0 个考点

**无法自动判定覆盖（第 1 列没写反引号 tag）：20 行** —— 修法：把考点名改成 `中文名（`tag-id`）` 格式，然后重跑本脚本。

- 数组双指针与滑动窗口
- 前缀和、差分与溢出判定
- 二分查找与单调谓词
- 排序语义与  契约
- 栈、单调栈与表达式建模
- 堆、Top-K 与懒删除
- 集合选型与 （21）
- 图遍历与拓扑排序
- …另有 12 行

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：241 个概念 / 245 种写法（元标签 0 / 考点缺口 241）**
   要处理的是那 **241 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `overflow-contract`（9 题：alg-java-0001, alg-java-0002, alg-java-0003…）
- `inference-gateway`（7 题：alg-java-0021, alg-java-0022, alg-java-0023…）
- `llm-inference`（5 题：alg-java-0022, alg-java-0023, alg-java-0024…）
- `resilience-semantics`（5 题：alg-java-0047, alg-java-0049, alg-java-0050…）
- `sorting`（3 题：alg-java-0002, alg-java-0004, alg-java-0014）
- `prefix-sum`（3 题：alg-java-0003, alg-java-0013, alg-java-0026）
- `sliding-window`（3 题：alg-java-0007, alg-java-0016, alg-java-0028）
- `rate-limiting`（3 题：alg-java-0021, alg-java-0028, alg-java-0050）
- …另有 233 个考点缺口（完整清单：`--orphan-audit-json`）

### `sql`｜未覆盖 1 / 可判定 1 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `information_schema` /  观测｜形式 code｜judgeKind mysql｜JD 能力项：ABNB-BE-2 APL-BE-2

**无法自动判定覆盖（第 1 列没写反引号 tag）：20 行** —— 修法：把考点名改成 `中文名（`tag-id`）` 格式，然后重跑本脚本。

- 聚簇索引与主键选型
- 索引有效性失效清单
- 统计信息与代价模型
- 执行计划解读与 join 算法
- 深分页与排序消除 filesort
- MVCC 与一致性读
- InnoDB 锁与死锁
- Online DDL 与变更安全
- …另有 12 行

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：214 个概念 / 216 种写法（元标签 0 / 考点缺口 214）**
   要处理的是那 **214 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `marketplace-integrity`（5 题：sql-mysql-0014, sql-mysql-0015, sql-mysql-0016…）
- `window-functions`（4 题：sql-mysql-0001, sql-mysql-0002, sql-mysql-0003…）
- `recursive-cte`（4 题：sql-mysql-0004, sql-mysql-0013, sql-mysql-0017…）
- `null-semantics`（4 题：sql-mysql-0006, sql-mysql-0010, sql-mysql-0011…）
- `metric-definition`（4 题：sql-mysql-0015, sql-mysql-0018, sql-mysql-0020…）
- `no-lua-constraint`（4 题：sql-redis-0009, sql-redis-0011, sql-redis-0012…）
- `analytics`（3 题：sql-mysql-0001, sql-mysql-0007, sql-mysql-0008）
- `mysql8-window-functions`（3 题：sql-mysql-0001, sql-mysql-0002, sql-mysql-0003）
- …另有 206 个考点缺口（完整清单：`--orphan-audit-json`）

### `system-design`｜未覆盖 2 / 可判定 21 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `distributed-lock` 分布式锁与租约｜形式 code｜judgeKind redis｜JD 能力项：并发正确性、平台可靠性
- `rdbms-transactions` 关系型存储与事务边界｜形式 code｜judgeKind mysql｜JD 能力项：数据建模、性能调优

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：143 个概念 / 144 种写法（元标签 0 / 考点缺口 143）**
   要处理的是那 **143 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `data-quality`（4 题：sys-design-rubric-0005, sys-design-rubric-0006, sys-design-rubric-0007…）
- `privacy-by-design`（3 题：sys-design-rubric-0002, sys-design-rubric-0004, sys-design-rubric-0008）
- `capacity-planning`（3 题：sys-rubric-0001, sys-rubric-0002, sys-rubric-0005）
- `privacy-engineering`（3 题：sys-rubric-0003, sys-rubric-0004, sys-rubric-0008）
- `gpu-scheduling`（2 题：sys-rubric-0001, sys-rubric-0006）
- `hash-field-ttl`（1 题：sys-design-rubric-0001）
- `stale-while-revalidate`（1 题：sys-design-rubric-0001）
- `crdt-convergence`（1 题：sys-design-rubric-0002）
- …另有 135 个考点缺口（完整清单：`--orphan-audit-json`）

### `big-data`｜未覆盖 11 / 可判定 30 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `spark-aqe` AQE 能力边界｜形式 code｜judgeKind pyspark｜JD 能力项：查询调优、成本效率
- `spark-connect` Spark Connect 与平台化｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：平台工程、多租户治理
- `structured-streaming` Structured Streaming 语义与运维｜形式 code｜judgeKind pyspark｜JD 能力项：实时管道
- `flink-state-runtime` Flink 状态、checkpoint 与反压｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：流式平台、可靠性
- `flink-time-windows` Flink 时间、窗口与迟到数据｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：实时口径正确性
- `flink-cdc` Flink CDC 与 schema 演进｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：数据集成、管道现代化
- `iceberg-internals` Iceberg 表格式内核与维护｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：湖仓架构
- `stream-ingest-contracts` 采集层与契约｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：数据契约、可靠性
- `analytics-sql-patterns` 分析型 SQL 模式｜形式 code｜judgeKind mysql｜JD 能力项：SQL 深度、指标落地
- `data-governance-privacy` 隐私与数据治理｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：隐私工程、合规
- `feature-store-pit` 特征平台与时点正确性｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：ML/数据平台协同

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：149 个概念 / 151 种写法（元标签 0 / 考点缺口 149）**
   要处理的是那 **149 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `pyspark`（7 题：bd-pyspark-0002, bd-pyspark-0003, bd-pyspark-0004…）
- `spark-on-k8s`（4 题：bd-rubric-0009, bd-rubric-0010, bd-rubric-0011…）
- `iceberg-v3`（3 题：bd-pyspark-0005, bd-rubric-0002, bd-rubric-0004）
- `gaps-and-islands`（3 题：bd-pyspark-0006, bd-pyspark-0009, bd-scala-0001）
- `spark-sql`（3 题：bd-pyspark-0009, bd-pyspark-0011, bd-pyspark-0012）
- `spark-4-2-nearest-by`（2 题：bd-pyspark-0002, bd-pyspark-0010）
- `paimon-1.4`（2 题：bd-pyspark-0003, bd-rubric-0002）
- `spark-4-ansi-default`（2 题：bd-pyspark-0004, bd-pyspark-0007）
- …另有 141 个考点缺口（完整清单：`--orphan-audit-json`）

### `agent-design`｜未覆盖 4 / 可判定 17 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `agent-ux-streaming` 流式交互与前端渲染｜形式 code｜judgeKind react-vitest｜JD 能力项：端到端体验
- `agent-test-env` 评测数据与环境隔离｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：工程严谨性
- `agent-edge-cloud` 端云协同与隐私｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：隐私优先架构
- `agent-product-loop` 任务定义与评估闭环｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：业务影响、跨职能协作

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：103 个概念 / 105 种写法（元标签 0 / 考点缺口 103）**
   要处理的是那 **103 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 本类别没有。

- `agent-runtime`（3 题：ag-rubric-0002, ag-rubric-0003, ag-rubric-0004）
- `agent-ops`（3 题：ag-rubric-0003, ag-rubric-0004, ag-rubric-0005）
- `decision-reproducibility`（3 题：ag-rubric-0008, ag-rubric-0010, ag-rubric-0012）
- `privacy-engineering`（2 题：ag-design-rubric-0003, ag-design-rubric-0007）
- `idempotency`（2 题：ag-rubric-0001, ag-rubric-0004）
- `action-tiering`（2 题：ag-rubric-0012, ag-rubric-0014）
- `kv-cache`（1 题：ag-design-rubric-0001）
- `mcp`（1 题：ag-design-rubric-0002）
- …另有 95 个考点缺口（完整清单：`--orphan-audit-json`）

### `hot-interviews`｜未覆盖 8 / 可判定 18 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `airbnb-analytics-sql` 【Airbnb·数据】滚动窗口/留存/漏斗 SQL｜形式 code｜judgeKind mysql｜JD 能力项：指标建模、与 BI/分析协作
- `airbnb-feature-store` 【Airbnb·数据/ML】特征平台与时点正确性｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：ML 数据平台、实验支撑
- `airbnb-booking-concurrency` 【Airbnb·后端】库存与预订并发｜形式 code｜judgeKind redis｜JD 能力项：交易一致性、用户体验
- `airbnb-experimentation` 【Airbnb·数据/后端】实验平台与指标可信｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：实验基础设施、因果思维
- `airbnb-marketplace-equilibrium` 【Airbnb·数据】双边市场供需与调度指标｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：业务/数据科学协作
- `apple-push-fanout` 【Apple·后端】推送与扇出｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：高并发服务、移动端协同
- `apple-device-integrity` 【Apple·后端】设备/账户认证与反滥用｜形式 code｜judgeKind java-junit｜JD 能力项：安全、服务契约
- `unknown-domain-reasoning` 【两家·通用】"你没做过但要怎么负责"题｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：学习能力、技术判断

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：108 个概念 / 111 种写法（元标签 2 / 考点缺口 106）**
   要处理的是那 **106 个考点缺口**：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。
   元标签不参与催补（**只有出处/公司维度才算**：`company:*` 前缀与纯公司名）： 2 个。

- `llm-inference`（3 题：hot-rubric-0001, hot-rubric-0007, hot-rubric-0008）
- `experimentation`（2 题：hot-interviews-rubric-0001, hot-rubric-0014）
- `marketplace-integrity`（2 题：hot-interviews-rubric-0002, hot-rubric-0005）
- `data-quality`（2 题：hot-interviews-rubric-0003, hot-rubric-0006）
- `privacy-engineering`（2 题：hot-interviews-rubric-0005, hot-rubric-0011）
- `observability`（2 题：hot-rubric-0001, hot-rubric-0004）
- `kv-cache`（2 题：hot-rubric-0002, hot-rubric-0007）
- `data-contract`（2 题：hot-rubric-0006, hot-rubric-0009）
- …另有 98 个考点缺口（完整清单：`--orphan-audit-json`）

## JD 热度 vs 知识库缺口

skills.json（生成于 2026-09-19T05:50:29.535Z）里有 16 个热点在对应类别矩阵里找不到考点，建议在 README 里补行：

- `airbnb-ecosystem`（Airbnb 生态）→ 应补进 `content/knowledge/hot-interviews/README.md`｜JD 提及 272 次，来自 Airbnb
- `ml-platform`（ML / 数据科学协作）→ 应补进 `content/knowledge/big-data/README.md`｜JD 提及 100 次，来自 Airbnb/Apple
- `llm-evals-guardrails`（评测与护栏）→ 应补进 `content/knowledge/agent-design/README.md`｜JD 提及 11 次，来自 Airbnb
- `python`（Python）→ 应补进 `content/knowledge/algorithms/README.md`｜JD 提及 11 次，来自 Airbnb/Apple
- `apple-ecosystem`（Apple 生态）→ 应补进 `content/knowledge/hot-interviews/README.md`｜JD 提及 10 次，来自 Apple
- `microservices`（微服务 / 分布式）→ 应补进 `content/knowledge/system-design/README.md`｜JD 提及 8 次，来自 Airbnb
- `kubernetes`（Kubernetes）→ 应补进 `content/knowledge/system-design/README.md`｜JD 提及 6 次，来自 Airbnb/Apple
- `security`（安全与授权）→ 应补进 `content/knowledge/system-design/README.md`｜JD 提及 6 次，来自 Airbnb
- `storage-engine`（存储引擎 / 事务与复制）→ 应补进 `content/knowledge/sql/README.md`｜JD 提及 6 次，来自 Airbnb
- `typescript`（TypeScript）→ 应补进 `content/knowledge/frontend/README.md`｜JD 提及 6 次，来自 Airbnb/Apple
- `airflow`（Airflow 编排）→ 应补进 `content/knowledge/big-data/README.md`｜JD 提及 5 次，来自 Airbnb/Apple
- `data-modeling`（数据建模 / 数仓 / 语义层）→ 应补进 `content/knowledge/big-data/README.md`｜JD 提及 4 次，来自 Airbnb
- `beam`（Apache Beam（批流统一模型））→ 应补进 `content/knowledge/big-data/README.md`｜JD 提及 2 次，来自 Apple
- `cicd`（CI/CD 与发布）→ 应补进 `content/knowledge/system-design/README.md`｜JD 提及 2 次，来自 Airbnb/Apple
- `dbt`（dbt 分层建模）→ 应补进 `content/knowledge/big-data/README.md`｜JD 提及 2 次，来自 Airbnb/Apple

## 下一步（脚本串起来的顺序）

```bash
node scripts/jd/fetch.mjs --company Airbnb     # 真抓 JD 进 content/jd-cache（只增不减）
node scripts/jd/extract-skills.mjs             # JD → 技术栈权重 skills.json
npm run bank:refresh -- --dry-run              # 按上面"未覆盖考点"逐类别试跑
npm run bank:refresh                           # 真入库（qodercli 优先，失败自动降级 copilot）
npm run kb:index                               # 重生成这份 INDEX.md
node scripts/curriculum.mjs                    # 重排 30 天课表
```

