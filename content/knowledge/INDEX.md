# 知识库索引（自动生成，请勿手改）

> 由 `npm run kb:index`（`node scripts/kb/compile-knowledge.mjs`）生成。
> 生成时间：2026-09-25T06:30:52.925Z
> 输入：`content/knowledge/<类别>/README.md` 考点矩阵（7 类）+ 题库 254 题（其中软删除 0 题不计入"已出题"）。
> 覆盖判定：题目 `tags[]`（去掉 `modern:` 前缀）命中矩阵第 1 列反引号里的 tag 即算已覆盖；未写反引号 tag 的行列在「无显式 tag」里单独统计。

## 类别总览

| 类别 | 考点数 | 含 code 形式 | 含 rubric 形式 | 无显式 tag（无法判定） | 语料篇数 | 已出题（可见） | 代码题 | 主观题 | 已覆盖考点 | 未覆盖考点 | 覆盖率 | 判分方式分布 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [`frontend`](./frontend/README.md) 前端工程 | 20 | 17 | 3 | 20 | [4](./frontend/README.md#语料文件) | 23 | 23 | 0 | 0 | 0 | — | react-vitest=23 |
| [`algorithms`](./algorithms/README.md) 算法 | 20 | 19 | 1 | 20 | [4](./algorithms/README.md#语料文件) | 59 | 59 | 0 | 0 | 0 | — | java-junit=59 |
| [`sql`](./sql/README.md) SQL 与存储 | 21 | 19 | 2 | 20 | [5](./sql/README.md#语料文件) | 50 | 50 | 0 | 0 | 1 | 0% | mysql=36 redis=14 |
| [`system-design`](./system-design/README.md) 系统设计 | 21 | 8 | 13 | 0 | [5](./system-design/README.md#语料文件) | 36 | 0 | 36 | 19 | 2 | 90% | llm-rubric=36 |
| [`big-data`](./big-data/README.md) 大数据处理 | 26 | 9 | 17 | 0 | [6](./big-data/README.md#语料文件) | 34 | 26 | 8 | 13 | 13 | 50% | pyspark=24 llm-rubric=8 spark-scala=2 |
| [`agent-design`](./agent-design/README.md) Agent 设计 | 17 | 3 | 14 | 0 | [5](./agent-design/README.md#语料文件) | 27 | 0 | 27 | 13 | 4 | 76% | llm-rubric=27 |
| [`hot-interviews`](./hot-interviews/README.md) 高频面试题 | 18 | 4 | 14 | 0 | [12](./hot-interviews/README.md#语料文件) | 25 | 0 | 25 | 10 | 8 | 56% | llm-rubric=25 |

**合计**：143 个考点，其中 83 个可机器判定覆盖，已覆盖 55 个（66%）；题库 254 题。

## 未覆盖考点（"该出什么题"的直接答案）

### `frontend`｜未覆盖 0 / 可判定 0 个考点

**无法自动判定覆盖（第 1 列没写反引号 tag）：20 行** —— 修法：把考点名改成 `中文名（`tag-id`）` 格式，然后重跑本脚本。

- 严格编译基线与 6.0 迁移
- 判别联合 + 穷尽建模
- 泛型与条件类型实战
- 类型边界与外部契约
- React 19 Actions 三件套
- 与回滚语义
- 数据获取与竞态
- 转译优先级
- …另有 12 行

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：92 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `race-condition`（3 题：fe-react-0001, fe-react-0002, fe-react-0003）
- `cancellation`（3 题：fe-react-0001, fe-react-0002, fe-react-0009）
- `render-performance`（3 题：fe-react-0006, fe-react-0007, fe-react-0008）
- `null-vs-zero`（3 题：fe-react-0013, fe-react-0014, fe-react-0017）
- `modern:marketplace-rules`（3 题：fe-react-0015, fe-react-0017, fe-react-0018）
- `data-fetching`（2 题：fe-react-0001, fe-react-0002）
- `error-boundary`（2 题：fe-react-0003, fe-react-0009）
- `modern:react19-actions`（2 题：fe-react-0004, fe-react-0005）

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

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：245 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `overflow-contract`（9 题：alg-java-0001, alg-java-0002, alg-java-0003…）
- `modern:inference-gateway`（6 题：alg-java-0021, alg-java-0022, alg-java-0023…）
- `llm-inference`（5 题：alg-java-0022, alg-java-0023, alg-java-0024…）
- `modern:resilience-semantics`（5 题：alg-java-0047, alg-java-0049, alg-java-0050…）
- `sorting`（3 题：alg-java-0002, alg-java-0004, alg-java-0014）
- `prefix-sum`（3 题：alg-java-0003, alg-java-0013, alg-java-0026）
- `sliding-window`（3 题：alg-java-0007, alg-java-0016, alg-java-0028）
- `rate-limiting`（3 题：alg-java-0021, alg-java-0028, alg-java-0050）

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

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：216 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `modern:marketplace-integrity`（5 题：sql-mysql-0014, sql-mysql-0015, sql-mysql-0016…）
- `window-functions`（4 题：sql-mysql-0001, sql-mysql-0002, sql-mysql-0003…）
- `recursive-cte`（4 题：sql-mysql-0004, sql-mysql-0013, sql-mysql-0017…）
- `null-semantics`（4 题：sql-mysql-0006, sql-mysql-0010, sql-mysql-0011…）
- `metric-definition`（4 题：sql-mysql-0015, sql-mysql-0018, sql-mysql-0020…）
- `no-lua-constraint`（4 题：sql-redis-0009, sql-redis-0011, sql-redis-0012…）
- `analytics`（3 题：sql-mysql-0001, sql-mysql-0007, sql-mysql-0008）
- `modern:mysql8-window-functions`（3 题：sql-mysql-0001, sql-mysql-0002, sql-mysql-0003）

### `system-design`｜未覆盖 2 / 可判定 21 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `distributed-lock` 分布式锁与租约｜形式 code｜judgeKind redis｜JD 能力项：并发正确性、平台可靠性
- `rdbms-transactions` 关系型存储与事务边界｜形式 code｜judgeKind mysql｜JD 能力项：数据建模、性能调优

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：144 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `data-quality`（4 题：sys-design-rubric-0005, sys-design-rubric-0006, sys-design-rubric-0007…）
- `privacy-by-design`（3 题：sys-design-rubric-0002, sys-design-rubric-0004, sys-design-rubric-0008）
- `capacity-planning`（3 题：sys-rubric-0001, sys-rubric-0002, sys-rubric-0005）
- `modern:privacy-engineering`（3 题：sys-rubric-0003, sys-rubric-0004, sys-rubric-0008）
- `gpu-scheduling`（2 题：sys-rubric-0001, sys-rubric-0006）
- `modern:hash-field-ttl`（1 题：sys-design-rubric-0001）
- `modern:stale-while-revalidate`（1 题：sys-design-rubric-0001）
- `modern:crdt-convergence`（1 题：sys-design-rubric-0002）

### `big-data`｜未覆盖 13 / 可判定 26 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `spark-aqe` AQE 能力边界｜形式 code｜judgeKind pyspark｜JD 能力项：查询调优、成本效率
- `pyspark-python-perf` PySpark UDF 与 Python 侧性能｜形式 code｜judgeKind pyspark｜JD 能力项：工具链深度、吞吐优化
- `spark-connect` Spark Connect 与平台化｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：平台工程、多租户治理
- `structured-streaming` Structured Streaming 语义与运维｜形式 code｜judgeKind pyspark｜JD 能力项：实时管道
- `flink-state-runtime` Flink 状态、checkpoint 与反压｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：流式平台、可靠性
- `flink-time-windows` Flink 时间、窗口与迟到数据｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：实时口径正确性
- `flink-cdc` Flink CDC 与 schema 演进｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：数据集成、管道现代化
- `iceberg-internals` Iceberg 表格式内核与维护｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：湖仓架构
- `stream-ingest-contracts` 采集层与契约｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：数据契约、可靠性
- `analytics-sql-patterns` 分析型 SQL 模式｜形式 code｜judgeKind mysql｜JD 能力项：SQL 深度、指标落地
- `orchestration-scheduling` 调度、依赖与运维｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：平台运维
- `data-governance-privacy` 隐私与数据治理｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：隐私工程、合规
- `feature-store-pit` 特征平台与时点正确性｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：ML/数据平台协同

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：148 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `pyspark`（7 题：bd-pyspark-0002, bd-pyspark-0003, bd-pyspark-0004…）
- `gaps-and-islands`（3 题：bd-pyspark-0006, bd-pyspark-0009, bd-scala-0001）
- `spark-sql`（3 题：bd-pyspark-0009, bd-pyspark-0011, bd-pyspark-0012）
- `modern:spark-4-2-nearest-by`（2 题：bd-pyspark-0002, bd-pyspark-0010）
- `modern:paimon-1.4`（2 题：bd-pyspark-0003, bd-rubric-0002）
- `modern:spark-4-ansi-default`（2 题：bd-pyspark-0004, bd-pyspark-0007）
- `idempotent-dedup`（2 题：bd-pyspark-0005, bd-pyspark-0011）
- `modern:iceberg-v3`（2 题：bd-pyspark-0005, bd-rubric-0004）

### `agent-design`｜未覆盖 4 / 可判定 17 个考点

待出题（建议形式与 judgeKind 取自矩阵）：

- `agent-ux-streaming` 流式交互与前端渲染｜形式 code｜judgeKind react-vitest｜JD 能力项：端到端体验
- `agent-test-env` 评测数据与环境隔离｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：工程严谨性
- `agent-edge-cloud` 端云协同与隐私｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：隐私优先架构
- `agent-product-loop` 任务定义与评估闭环｜形式 rubric｜judgeKind llm-rubric｜JD 能力项：业务影响、跨职能协作

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：105 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `modern:agent-ops`（3 题：ag-rubric-0003, ag-rubric-0004, ag-rubric-0005）
- `decision-reproducibility`（3 题：ag-rubric-0008, ag-rubric-0010, ag-rubric-0012）
- `privacy-engineering`（2 题：ag-design-rubric-0003, ag-design-rubric-0007）
- `idempotency`（2 题：ag-rubric-0001, ag-rubric-0004）
- `agent-runtime`（2 题：ag-rubric-0003, ag-rubric-0004）
- `action-tiering`（2 题：ag-rubric-0012, ag-rubric-0014）
- `kv-cache`（1 题：ag-design-rubric-0001）
- `modern:mcp`（1 题：ag-design-rubric-0002）

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

**题目 tag 在矩阵里找不到对应考点（题面与知识库脱钩）：111 个** —— 修法：给矩阵补一行考点，或把题目 tag 换成矩阵里已有的。

- `company:airbnb`（3 题：hot-interviews-rubric-0001, hot-interviews-rubric-0002, hot-interviews-rubric-0003）
- `company:apple`（3 题：hot-interviews-rubric-0004, hot-interviews-rubric-0005, hot-interviews-rubric-0006）
- `modern:marketplace-integrity`（2 题：hot-interviews-rubric-0002, hot-rubric-0005）
- `data-quality`（2 题：hot-interviews-rubric-0003, hot-rubric-0006）
- `modern:privacy-engineering`（2 题：hot-interviews-rubric-0005, hot-rubric-0011）
- `observability`（2 题：hot-rubric-0001, hot-rubric-0004）
- `kv-cache`（2 题：hot-rubric-0002, hot-rubric-0007）
- `modern:data-contract`（2 题：hot-rubric-0006, hot-rubric-0009）

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

