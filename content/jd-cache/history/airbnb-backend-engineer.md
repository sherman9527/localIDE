---
company: Airbnb
role: Backend / Software Engineer（Marketplace · Search · Pricing · Data Platform）（上海/中国 · 美国）
location: shanghai / us
url: https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true
source: https://careers.airbnb.com/
curated: manual
crawledAt: 2026-09-19T00:00:00.000Z
---

# Airbnb — Backend Engineer / Senior·Principal Software Engineer（含 Data Platform 方向）

> **性质声明：本文件是"人工整理的公开信息样本"，不是逐字抓取。**
> 内容按 Airbnb 招聘站（careers.airbnb.com / Greenhouse board `airbnb`）与 Airbnb 工程博客长期公开的职责、任职要求与开源技术栈整理，
> 用于**断网时的离线出题输入**。逐字 JD 请以 `node scripts/jd/fetch.mjs --company Airbnb` 抓到的 `content/jd-cache/airbnb-<date>.json` 为准。
> 出处：<https://careers.airbnb.com/>｜API：<https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true>｜工程博客：<https://airbnb.tech/>
> 岗位名示例（抓取当日真实存在的标题）：`Senior Machine Learning Engineer, AI Platform`、`Machine Learning Engineer, Relevance and Personalization`、`Senior Data Scientist - Payments (Inference)`、`Lead Platform Manager, Tech Foundations`（地点含 United States / China / Remote - USA）。

## 职责（Responsibilities）

- 负责 marketplace 核心域（搜索/预订/价格/支付/信任）的**服务设计、实现与运维**，支撑亿级用户与季节性峰值流量。
- 与产品、设计、数据科学、基础设施团队**共同定义成功指标**，把"上线"当成起点而不是终点（A/B 实验 + 因果口径）。
- 设计**低延迟、高可用的读路径**（搜索卡片/详情页批量取数、缓存分层、降级与失效策略），并对 P99 负责。
- 建设**数据与特征基础设施**：事件采集契约、流式管道、指标语义层（Minerva 风格的"指标即代码"）、特征平台（Chronon 风格）与时点正确性。
- 负责**跨团队协作与工程规范**：API 契约演进、向后兼容、迁移计划、事故复盘、oncall 手册与错误预算。
- 推动**性能与成本治理**：单位请求成本、存储与查询成本归因、慢查询与热点键的常态化收敛。
- 保障**信任与安全/合规**：支付侧 PCI 与对账、用户数据的最小化与访问审计、国际化与多币种/多时区正确性。
- 承担**技术评审与 mentorship**：设计文档评审、代码评审、带初级工程师与实习生。

## 任职要求（Minimum Qualifications）

- BS/MS CS 或等量实践；senior 5 年+、principal 10 年+ 大规模后端系统经验。
- 精通至少一门服务端语言：**Java**、**Kotlin**、**Python**、**Go**、**Node.js/TypeScript**、Scala 或 Ruby（Airbnb 历史上以 Ruby 起家，新平台多用 Java/Python/TypeScript）。
- 有**分布式系统**硬功夫：一致性模型与取舍、幂等与重试、 Exactly-once 的真实含义、锁与并发、部分失败与背压、扇出与热点。
- 熟悉**服务间通信**：REST 与 **gRPC**/Thrift、**GraphQL**（Airbnb 是早期大规模使用者）、消息总线 **Kafka**（含 schema 注册与兼容性策略）。
- 熟悉**存储层**：**MySQL**（分库分表、索引与事务、复制延迟）、**Redis**/Memcached（缓存一致性、大 key、内存预算、hash field TTL）、Cassandra/Dynamo 类 NoSQL、Elasticsearch/Druid 类检索。
- 熟悉**数据工程栈**：**Spark/PySpark**、**Flink**（或等价流处理）、**Airflow/Dagster** 编排、**dbt** 分层建模、湖仓表格式（**Iceberg**/Delta/Hudi/**Paimon**）、OLAP 引擎（**ClickHouse**/Doris/StarRocks/Druid）、查询引擎（**Trino**/Presto）。
- 有**云原生基础设施**经验：**Kubernetes**、容器化、服务网格与 Envoy、IaC（Terraform）、CI/CD 与金丝雀发布。
- 具备**可观测性**实操：OpenTelemetry 埋点、指标/日志/追踪三位一体、SLO 与告警分级，而不是"看 dashboard"。
- 全栈协作能力：能与 **TypeScript + React** 前端一起把契约、缓存策略与性能预算（Core Web Vitals）设计到位；理解 SSR 与移动端差异。
- 强**产品直觉与数据驱动**：能自己提出指标、设计实验、解释显著性与因果，拒绝"我觉得"。
- 沟通与影响力：跨组织推动（数据平台常需拉 3+ 团队），书面表达清晰（设计文档是 Airbnb 的核心交付物）。
- 上海/中国岗位：能与美国时区团队协作，英文技术沟通流利；美国岗位需具备相应工作授权。

## 历史高频追问（企业面/内部经验帖常见方向，供 hot-interviews 出题）

- "设计 Airbnb 的**报价/可订性**读路径：5 万 TPS 读、命中率 70% 时怎么扩？失效与一致性怎么定？"（缓存 + 容量估算必问）
- "搜索卡片一次要 40 个 listing 的价格，你怎么把 P99 压到 60ms 以内？批量与去重放哪一层？"
- "**预订幂等**：用户连点两次、网络重试、支付回调重放，你怎么保证不重复扣款也不重复占库存？"
- "口径问题：'订单量' 是按创建、支付成功还是入住日算？谁定？改动如何治理并回刷？"
- "讲一个你**否掉的需求**或**推翻的自己的设计**，代价与收益各是什么？"（principal 预期答案）
- "你如何验证'你的实时数和离线数一致'？对账不上了怎么排查？"
