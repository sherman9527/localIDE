# system-design 考点矩阵（senior / principal）

> 本文件是出题的**前置输入**（requirement.txt 第 19 条：先知识库，再题库）。
> 出题脚本按本表逐行生成题目，`tags` 取第 1 列反引号内的 tag id。
>
> 表格约定：
> - 第 1 列格式固定为 `中文考点名（`tag-id`）`，反引号内为机器可读 tag。
> - `可出题形式` ∈ `code` / `rubric`。
> - `建议 judgeKind` ∈ `java-junit` / `react-vitest` / `mysql` / `redis` / `pyspark` / `llm-rubric`。
> - 系统设计主观题只能 `rubric + llm-rubric`；能被真跑验证的微观机制（幂等键、限流、扇出去重、分页游标语义）优先做成 `code`，用可执行结果区分"背过答案"和"真写过"。
>
> 目标 JD 画像：Apple / Airbnb（上海 + 美国）Senior–Principal Software Engineer、Data Engineer、Platform Engineer。
> JD 高频能力项关键词：`large-scale distributed systems`、`API design & service contracts`、`high availability / multi-region`、`observability & SLO`、`cost/performance ownership`、`privacy-by-design`、`cross-team technical leadership`。

## 考点矩阵

| 考点 | senior 深度要点 | 2025-2026 新实践 | 可出题形式 | 建议 judgeKind | JD 能力项 |
|---|---|---|---|---|---|
| 容量估算与瓶颈定位（`capacity-estimation`） | 不从 QPS 拍脑袋：按"日事件量→字节量→峰值倍率→存储放大系数（副本/压缩/索引/compaction 临时空间）"链条推；能指出瓶颈在磁盘顺序写/网络/元数据/协程调度中的哪一层，并给出反压点 | 用查询成本（扫描字节、token 数、对象存储 GET/PUT 计费）替代裸机器数估算；GPU/推理容量按 KV-cache 与 batch 形状估；估算必须写清 p99 倍率与"周末/发布日"峰值假设 | rubric | llm-rubric | 端到端容量规划、成本归属 |
| 一致性模型与读路径（`consistency-models`） | 能说清 read-your-writes / monotonic / causal / linearizable 的**代价差**；会话粘滞 vs 版本向量 vs 租约；知道"多数派写 + 读时校验版本号"能拿到什么保证、拿不到什么 | 把一致性从"全局开关"降级为"按操作/按用户会话声明"（per-request consistency header）；跨区复制用 LWW + 冲突日志；边界场景以 CRDT 收敛计数/集合 | rubric | llm-rubric | 分布式存储设计、数据一致性 |
| 幂等与重试风暴（`idempotency-retry`） | 幂等键作用域（client+endpoint+body hash）、TTL、结果重放语义、部分成功与 409/425 的取舍；指数退避 + jitter + 预算（retry budget）防重试放大 | 网关层统一 Idempotency-Key 存储（Redis/DynamoDB 条件写）；对异步链路用 outbox + 消费端去重表；用 `Idempotency-Replay` 响应头可观测回放率 | code | redis | 可靠 API、故障恢复 |
| 分布式锁与租约（`distributed-lock`） | 锁的正确性来自 fencing token 单调递增 + 存储侧拒绝旧 token，而非"Redis 原子性"；GC 暂停/时钟回拨/NTP 校时导致失效的窗口；Redlock 的争议要点出 | 尽量把锁降级为"单分区事务 + 唯一约束"或 CAS 状态机；必须跨区时用 lease + 双写仲裁；用 `SET key val NX PX` + Lua 只作为**效率锁**，不作为**正确性锁** | code | redis | 并发正确性、平台可靠性 |
| 缓存架构与失效风暴（`cache-architecture`） | 击穿/穿透/雪崩/预热四件事的**工程差别**：single-flight（请求合并）、stale-while-revalidate、负缓存、TTL jitter、per-key 锁；缓存与 DB 双写的顺序与删除策略 | 边缘/客户端缓存 + `CDN stale-if-error`；用 `ETag`/`If-None-Match` 做条件请求降带宽；Redis 8.x/Valkey 9.x 的 hash field TTL（7.4+）做字段级过期；推理链路 prompt/语义缓存（按 embedding 相似度命中） | code | redis | 高并发读、延迟优化 |
| 消息系统 at scale（`messaging-at-scale`） | 分区键选择决定并发上限与顺序域；`min.insync.replicas`/`acks` 与可用性取舍；重平衡风暴、消费者 lag 告警、per-partition 指标；DLQ + 重放工具链 | Kafka 4.0 起 KRaft-only；4.2 把 Queues for Kafka（KIP-932 share groups / `share.` 前缀消费组）转为正式可用，"队列语义 + 提交模式"首次进 Kafka，替代大量 SQS 出口；4.3 偏运维：broker cordoning（KIP-1066）、per-partition 指标（KIP-1257）、share group 参数调优（KIP-1240/1263）、分层存储修复；经典 rebalance 协议进入废弃第一阶段 | rubric | llm-rubric | 事件驱动架构、流式平台 |
| 端到端 exactly-once（`eos-semantics`） | 区分"处理一次、投递一次、效果一次"；两阶段提交的真实痛点（长事务、cancel/hang、协调者重启）；端到端论证要靠幂等 sink + 可重放源，而非单点"exactly-once"标签 | DB transactional outbox → CDC → 流 → 带主键 upsert 的 sink；Flink 2.x 与 Kafka 事务边界对齐；用 in-memory assertion / 双写对账作业验证语义；湖仓用表格式 ACID 快照替代 2PC | rubric | llm-rubric | 数据正确性、流处理 |
| API 契约设计与演进（`api-contract`） | 向后兼容的可扩展性设计：新增可选字段、枚举未知值兜底、游标分页（不透明游标 + 稳定排序键）、错误模型统一（`application/problem+json`，RFC 9457）、批量端点的部分失败语义 | REST/gRPC/GraphQL 混用下用 OpenAPI + Buf（`buf lint`/`breaking`）做契约 CI；SDK 由契约生成并纳入 semver；移动端强制"服务端不认识字段忽略、客户端不假设字段顺序"；错误码目录 + 弃用窗口与遥测 | code | java-junit | API design、跨端协作 |
| 数据分片与路由（`partitioning-routing`） | 分片键三选一（hash/range/list）与热分区治理；再平衡代价量化（双写 + 影子读 + 迁移令牌桶）；全局二级索引 vs scatter-gather 的尾延迟取舍；跨分片事务边界 | 一致性哈希带虚拟节点 + 有界负载（bounded-load）；cell-based 架构 + 分片内自包含；把"热点"作为运行时一等指标（per-shape QPS/字节）；用逻辑分片 + 元数据层做在线迁移（避免固定 mod N） | rubric | llm-rubric | 可扩展性、存储设计 |
| 多区域容灾与 PITR（`multi-region-dr`） | 明确 RPO/RTO 由谁定义；区分"只读灾备/双活/分区可用"三档；DNS/客户端缓存/连接池导致的**真实切流时间**远大于宣传值；备份可用性要定期"真恢复演练" | 对象存储跨区复制 + Iceberg/Paimon 快照 + PITR；单元化（unit-based）路由按用户 ID 固定归属地，减少跨区 RTT；混沌演练自动化（周级 kill region）；恢复演练计入 SLO | rubric | llm-rubric | 高可用、运维就绪 |
| 可观测性与 SLO（`observability-slo`） | SLI 必须来自用户侧或边缘；黄金信号 vs RED；直方图分位数聚合陷阱（不能对 p99 求平均）；error budget 驱动的发布策略；日志基数治理 | OpenTelemetry 统一三信号，Profiles 信号 2026-03 进入公开 alpha，连续 profiling 开始进生产；exemplars 把 p99 断链直接跳到 trace；eBPF 零侵入采集；高基数标签进列式后端（ClickHouse/Doris）替代 ES；采样用尾部采样保错误全采 | rubric | llm-rubric | 生产运维、事故响应 |
| 支付与账务一致性（`payments-ledger`） | 复式记账不可变流水 + 余额从流水推导；状态机（授权/捕获/退款/拒付）与幂等；对账三向（内部账/渠道/清算文件）与差异闭环；延迟结算、押金/预授权、汇率与分账 | 用事件溯源 + outbox 取代跨库事务；渠道异步回调走"接收即落库、异步收敛"；资金安全红线（不平即锁）；对账做成可重跑的批（含迟到 30 天）；PCI/PII 令牌化与最小权限 | rubric | llm-rubric | 业务关键系统、资金正确性 |
| Feed 扇出与时间线（`feed-fanout`） | 推拉混合的判据（粉丝数分布、写放大倍数、读放大倍数、尾部延迟）；大 V 写扩散成本爆炸；游标 + 版本失效；已读/去重/排序的多阶段（候选生成→过滤→排序→打散） | 扇出预算化（按用户活跃度分层，冷用户改拉）；用 Redis Stream / Kafka share group 做扇出任务队列以削峰；Feed 特征在线化（embedding 召回 + 服务端重排）；离线-在线一致性靠特征快照 | code | java-junit | 高并发写、个性化系统 |
| 限流、背压与优先级（`backpressure-isolation`） | 限流器算法的失败模式（令牌桶突发、滑动窗口边界、固定窗口毛刺）；并发上限比 QPS 更贴近下游容量；舱壁隔离 + 优先级队列 + 降级路径；过载时先丢"可重试流量" | 自适应并发（AIMD / 梯度算法 / 基于 CPU+队列深度的 SRE 式过载保护）；客户端与网关双层限流；用 gRPC keepalive/http2 流控做真实背压；批量端点单独配额；租户公平性（LEQ/虚拟调度） | code | redis | 平台稳定性、多租户 |
| 检索与排序架构（`retrieval-ranking`） | 倒排 vs 向量 vs 混合；ANN 索引参数与召回率/延迟/内存曲线；过滤与近邻的先后顺序（先过滤导致召回塌陷）；粗排/精排级联与缓存；相关性离线指标与线上指标不一致怎么办 | 向量索引进 OLAP（Doris 4.x / StarRocks 4.0 的 vector search、ClickHouse 向量索引与 `vectorsim`；Spark 4.2 的 `NEAREST BY` top-K join 原语）；embedding 版本化 + 双索引灰度；LLM 重排只在 top-N；用生成式检索/语义 ID 的新实验路线（2026 尚早期，需核实） | rubric | llm-rubric | 搜索/推荐系统 |
| 关系型存储与事务边界（`rdbms-transactions`） | 隔离级别与异常（脏读/不可重复读/幻读/写偏斜）能构造出反例；行锁/间隙锁/索引锁升级；lost update 的三种修法（悲观锁/乐观版本号/原子更新语句）；覆盖索引与深分页 | Postgres 18（2025-09-25）异步 I/O（`io_method`）、UUIDv7 生成、虚拟生成列、NOT NULL 目录化；应用层用 `SELECT ... FOR UPDATE SKIP LOCKED` 做任务队列，或转 durable execution；MySQL 8.x `information_schema` 在线 DDL、`innodb_buffer_pool_dump` 预热 | code | mysql | 数据建模、性能调优 |
| 长任务编排与 durable execution（`durable-orchestration`） | 把"重试/补偿/人工审批/定时"从业务代码里抽出来；工作流版本兼容与在跑实例迁移；幂等 activity + 可重放历史；卡住的执行如何超时升级 | Temporal/Step Functions/Dagster 类持久化执行成为默认选择（取代自研 cron + 状态表）；用确定性约束的 SDK；agent 工作流复用同一套 durable 语义（长时任务挂起/恢复） | rubric | llm-rubric | 平台工程、可靠性 |
| 移动规模下的版本偏斜（`mobile-version-skew`） | 客户端不可强制升级：服务端要同时服务跨 2–3 年的版本；契约里显式声明最低支持版本；灰度维度（设备/地区/OS/租户）；崩溃率驱动回滚 | Feature flag 服务端化 + 曝光实验联动；契约 diff 检查"对旧版本是否安全"；老客户端只回退功能不回退数据结构；端上计算（on-device）+ 云端协同的降级路径（Apple 场景核心） | rubric | llm-rubric | 客户端/服务端协同 |
| 认证授权与最小权限（`authz-design`） | 授权即代码（Airbnb Airlock 风格：策略与资源标签集中评估）；token Audience/Scope 与"confused deputy"；服务间 mTLS + 工作负载身份；越权测试用例化 | Passkey/WebAuthn 规模化（Apple 主推，跨设备同步）；OAuth 2.1 + DPoP；RFC 9207 `iss` 校验（MCP 2026-07-28 起对授权服务器强制）；动态客户端注册被 Client ID Metadata Documents 取代；Agent 场景需"以用户身份 + 细粒度 scope + 可审计" | code | java-junit | 安全设计 |
| 成本控制与效率工程（`cost-ownership`） | 单位成本口径（每请求/每 DAU/每 GB 查询）；识别"为省存储浪费计算"这类伪优化；容量冗余与 SLO 的交换；把成本纳入架构评审 | 冷热分层 + 对象存储生命周期；列式表 compaction 与小文件治理的成本模型；OLAP 与湖仓职责重划（同一份 Iceberg/Paimon 数据被多引擎查询）；LLM 推理成本（prompt caching、路由、蒸馏）与 token 预算纳入 SLA | rubric | llm-rubric | 成本归属、运营效率 |
| 灰度发布与变更安全（`safe-rollout`） | 变更是故障主要来源：可回滚性设计（DDL、数据迁移、双写阶段）、部署与发布解耦、错误预算熔断自动停发；迁移的 5 阶段（影子→双写→对比→切读→停旧） | 渐进式交付（Argo Rollouts/Flagger + SLO 指标自动分析）；契约/模式变更走 CI 兼容检查；数据库迁移工具强制 expand-contract；AI 辅助 RCA 与自动回滚建议（2026 起部分团队采用，需核实） | rubric | llm-rubric | 交付效率、生产责任 |

## 建议排课与覆盖度

- 30 天排课：每周 1–2 个 `code` 题（redis / mysql / java-junit）+ 1 个 `rubric` 大题；`rubric` 题必须配 10 分制加分点/不足点条目。
- 深度题优先做：`messaging-at-scale`、`eos-semantics`、`multi-region-dr`、`payments-ledger`、`api-contract`、`observability-slo`（详见 `design-messaging-at-scale.md`、`consistency-and-eos.md`、`multi-region-and-dr.md`、`api-contract-and-evolution.md`、`design-payments-ledger.md`）。
- 每题在 `source.jds` 里至少挂 1 条 JD 原文片段（Apple 或 Airbnb，含抓取时间），并声明本题覆盖的 tag。

## 语料文件

| 文件 | 讲什么 |
| --- | --- |
| [`api-contract-and-evolution.md`](./api-contract-and-evolution.md) | API / 契约设计与演进（移动规模 + 跨团队规模化协作） |
| [`consistency-and-eos.md`](./consistency-and-eos.md) | 一致性、幂等与正确性设计（把"背概念"和"真修过事故"区分开） |
| [`design-messaging-at-scale.md`](./design-messaging-at-scale.md) | 大规模消息/事件系统设计（Feed、通知、事件总线） |
| [`design-payments-ledger.md`](./design-payments-ledger.md) | 双边市场的资金系统：账务、结算与对账（Airbnb 式预订 + Apple 式订阅/分账） |
| [`multi-region-and-dr.md`](./multi-region-and-dr.md) | 多区域、容灾与容量：把"高可用"落到可验证的数字上 |
