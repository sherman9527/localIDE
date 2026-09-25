# 大规模消息/事件系统设计（Feed、通知、事件总线）

对应考点：`messaging-at-scale`、`feed-fanout`、`backpressure-isolation`、`eos-semantics`
适配难度：senior / principal｜出题形式：`rubric`（主干）+ `code`（局部机制，redis / java-junit）

---

## 1. 核心机制

### 1.1 顺序域与分区键
- Kafka 只保证 **partition 内有序**。顺序域应该选成"业务上真的需要顺序的最小单位"：
  - 账务流水 → `account_id`；订单状态机 → `order_id`；用户设备事件 → `device_id`；
  - 选 `user_id` 会限死单人并发（一个分区吞吐 ~MB/s 级），选 `topic` 级随机则丢序。
- 分区数一旦确定就是长期承诺：扩分区会打破"同 key 同分区"，需要**双写迁移 + 版本化路由**，不是 `--topics --alter` 一把梭。
- 2025–2026 现状：Kafka 4.0 起 KRaft-only（无 ZooKeeper，控制器元数据在 `_metadata` topic，元数据传播有界）；4.2.0（2026-02-17）把 **Queues for Kafka（KIP-932）**转为正式可用：`share.` 前缀消费组 + `ShareConsumer`，引入**记录级 ack（`ACK/CLEAR_REJECT/SHARE_ACK`）**与投递计数，多个消费者可在同一分区上并发消费，语义从"分区独占"变成"队列 + at-least-once"。4.3.0（2026-05-22）继续做运维面：broker cordoning（KIP-1066）、per-partition 指标（KIP-1257）、share group 调优参数（KIP-1240 / KIP-1263）、分层存储修复（KIP-1235）；经典（非 consumer 协议）rebalance 进入废弃第一阶段，Kafka Streams 的 Scala API 被标记废弃（目标 5.0 移除）。

### 1.2 投递语义的真实代价
- `acks=all` + `min.insync.replicas>=2` + `unclean.leader.election.enable=false` 是"不丢"的下限；`retries>0` + `enable.idempotence=true` 只保证 **producer 到 partition 不重复/不乱序**（幂等 producer 用 PID + sequence number，窗口受 `max.in.flight.requests.per.connection<=5` 约束）。
- 消费端只有 at-least-once 是工程常识：**"效果一次"要靠下游幂等**（去重表 / 条件写 / upsert / 唯一约束），而不是把希望寄托在事务上。
- 事务消费者（`read_committed`）会引入 LSO（Last Stable Offset）延迟，事务超时由 `transaction.timeout.ms`（受 `transaction.max.timeout.ms` broker 上限约束）决定；批量提交间隔与端到端 p99 延迟直接冲突——这是 principal 一定会被问的取舍。
- 语义分层要讲清：Kafka 幂等 producer = partition 级去重；Kafka 事务 = 跨分区"读-处理-写 + commit offset"原子；跨系统（DB、OpenSearch、外部渠道）的原子性只能靠 outbox + 幂等 sink 或可回放的补偿链路。

### 1.3 扇出（fan-out）与背压
- 推模型（write fan-out）：读快、写放大 = Σ(粉丝数)，被大 V 打爆；拉模型：写省、读放大 = 关注数 × 排序成本，读时合并成本落在 p99；混合模型：按粉丝数阈值分层 + 冷用户降级为拉。
- 扇出任务队列化：把"生成收件箱"变成可重试的 work item（Redis Stream 或 Kafka + KIP-932 share group 的队列语义，天然支持并发 worker + 记录级 ack + 死信），并给扇出任务单独的限流预算与优先级，避免拖垮主写路径。
- 背压必须闭环：消费者 lag → 生产者侧限速（429/503 + `Retry-After`）或降级（丢弃低优先级、合并、采样）。"只有告警没有反压"的架构在面试里等同于没做过大促。

### 1.4 运维面
- Lag 的正确口径：`lag = HW - consumedOffset` 会骗人；要看 **时间口径**（records-lag-max + 最老记录时间戳、端到端处理时长）与"单分区热点 lag"。
- 重平衡风暴：session/heartbeat/max.poll.interval 与"处理时长 > max.poll.interval.ms"造成的死循环；`CooperativeRebalance`/增量分配、以及 4.x 的新 consumer 协议（KIP-848）把 rebalance 移出客户端；share group 让"一个慢 worker"从"整组停摆"变成"记录级 invisible timeout 后重投"（`share.invisibleMs` 类参数，需核实具体名称）。
- 保留策略：per-topic retention + 分层存储（KIP-405）；`remote.log.storage` 让"长保留 + 低本地盘"成立；但远端读延迟会污染回放/补数作业，回放要单独带宽预算。

---

## 2. senior / principal 会被追问什么

1. "为什么不用 SQS/云队列而用 Kafka？现在 KIP-932 之后这个理由还成立吗？"——期待答：顺序域、回放、多订阅、吞吐；成立的部分（工作队列/竞争消费）与仍不成立的部分（可见性超时、per-message 延迟、指数退避、DLQ 生态）。
2. "你的分区键选 `user_id`，那单用户高频写入怎么办？热点分区观测怎么做？"——per-partition 字节速率、`kafka-server-start` 前的压测、把 key 加盐成 `user_id#shard` 并在消费端二次合并。
3. "consumer 挂了怎么保证不重复发通知？重复发对用户的影响是什么？"——去重键 = (user, notification_type, dedup_window)，Redis `SET key NX EX` 或 DB 唯一索引；并要能说出"用户体验上一次可容忍的重复 vs 一次漏发"的业务判断。
4. "重平衡期间会发生什么？如何量化影响？"——stop-the-world vs 增量分配；停顿 = 分区重新分配 + offset 提交窗口；用 `rebalance_total`、`records_lag` 峰值、p99 端到端延迟量化。
5. "生产者与消费者的 schema 怎么演进？收到一条未知版本的消息怎么办？"——Schema Registry 兼容性模式、字段"只加可选、永不复用 tag 号"、未知版本进 quarantine topic（不丢不阻塞）。
6. "怎么证明你的链路没有丢数据？"——计数对账：源头事件数 = 落库 + 失败 + 迟到；用"带 checksum 的 daily reconciliation 作业"证明，而不是"我们用了 Kafka 所以不丢"。
7. "大 V 发布导致扇出尖峰，架构上如何不伤害普通用户？"——分层扇出预算 + 优先级队列 + 冷用户转拉 + 通知合并摘要。
8. "你要不要在 Kafka 上做 exactly-once？什么情况下明确不做？"——涉及外部副作用（发短信、扣款）时放弃 EOS，改幂等 + 补偿；纯 ETL 内闭环可用 EOS。

---

## 3. 常见错误答案（背题特征）

| 错误说法 | 为什么错 | 真做过的人会怎么说 |
|---|---|---|
| "Kafka 保证 exactly-once" | 只对"同 topic 内、事务范围内"成立；外部副作用、跨系统、重放消费都不成立 | "投递 at-least-once，效果一次靠下游幂等键" |
| "分区数越多吞吐越高、越安全" | 分区过多 → 端到端延迟上升、controller/ISR 管理成本、副本同步放大、小文件爆炸（下游落湖） | "按目标吞吐 / 单分区实测吞吐定，再乘以增长系数，并预留 compaction/lag 缓冲" |
| "`acks=all` 就不丢数据" | 还要 `min.insync.replicas`、unclean election 关闭、生产端重试不吞异常、落库侧幂等 | "不丢是链路属性：复制因子 + ISR + 客户端错误处理 + 对账闭环" |
| "用 Redis 分布式锁保证不重复消费" | Redis 锁是效率锁；正确性要靠存储侧条件写 / fencing token / 唯一约束 | "锁只是省算力，去重表才是正确性来源" |
| "lag 报警就是消费慢" | 生产突增、单分区热点、 rebalance 抖动、GC 停顿都会造成同样现象 | "先看生产速率与 key 分布，再看线程/CPU/GC，再看外部依赖 RT" |
| "Kafka Streams / Flink 有 state store，所以状态不会丢" | 状态一致性依赖 checkpoint 与 changelog；恢复要处理"重复消费"与 state schema 演进 | "state 演进要做兼容性规划：新增状态字段可以，删字段要迁移 + 双跑" |
| 只会讲推/拉概念，不给阈值 | 缺 fan-out 分层的数据依据 | "给粉丝数分布（p50/p99/max）→ 阈值 → 预期写放大倍数 → 峰值 QPS" |

---

## 4. 出题角度

### 题面草稿 A（`rubric`，10 分制）
> **Airbnb 消息平台（Senior/Principal，45 分钟）**
> Airbnb 的 guest↔host 私信 + 预订状态通知系统需要支撑：日均 2.4B 条消息写入，单会话最多 200 条/分钟，峰值出现在大促与"房东回复提醒"批量任务；通知渠道包含 push（APNs）、SMS、email、in-app。要求：用户观感上"不能漏、尽量少重复"；消息附件含 PII，需满足 GDPR 删除请求；运营要能按国家/渠道灰度新供应商。
> 请给出：主题与分区设计、扇出模型、去重与重试、背压与优先级、schema 演进与 GDPR 删除落地、观测指标与告警阈值、以及你会如何在**不重做架构**的前提下从当前"每渠道一个消费者组"演进到目标架构。

**rubric 加分点（每条命中 +1～+2，上限 10）**
1. 顺序域按 `conversation_id` 分区，并解释为什么不用 `user_id`（写并发上限）；给出热点会话的加盐方案。
2. 明确"投递 at-least-once + 效果一次靠幂等"，并写出幂等键构成与存储（Redis `SET NX EX` 或唯一索引），说明 TTL 选取依据（渠道重试窗口）。
3. 渠道差异：APNs 的 payload 上限 / 优先级 / collapse-id 合并；SMS 供应商配额与限速；email 退信与抑制列表——说明"每渠道独立预算 + 独立死信"。
4. 背压闭环：用 lag/端到端延迟触发上游降级（合并摘要、延迟非紧急通知），而不是只加消费者。
5. Schema/契约演进：未知版本进 quarantine，不阻塞主链路；说明注册表兼容性级别（backward/transitive）与"字段号永不复用"。
6. GDPR：物理删除靠"加密索引 + 密文删除（crypto-shredding）"，并说明备份/Lake 里的删除延迟承诺（P99 within N 天）与可证明性。
7. 对账可证明：每日 source-count vs sink-count 的三方对账作业 + 差异处置流程。
8. 迁移路径分阶段且可回滚（影子 topic / 双写 / 对比 / 切读 / 停旧），给出每阶段的退出判据指标。
9. 提及 2025–2026 平台能力并给出取舍：KIP-932 share group 队列语义（谁受益、为什么现有消费者组模型不满足）、KIP-848 新 consumer 协议、分层存储对回放的影响。
10. 成本口径：估算存储放大（RF × 保留 × 索引/压缩）与 egress；提出至少一项降本措施并给出量化影响。

**不足点（触发即扣分，最多扣到 0）**
- 只背"Kafka 高吞吐、发布订阅"，不给分区/键/容量数字。
- 把 Redis 锁当成正确性保证；没有去重表/唯一约束。
- 通知重复/漏发不做业务分级（如"支付成功通知必须不漏，营销可丢"）。
- 无对账/可证明性设计；无迁移阶段与退出判据。
- 声称"用事务就 exactly-once"，忽略外部副作用与重放。

### 题面草稿 B（`code`，`judgeKind=redis`）
> 实现"通知去重 + 渠道限流"两个原子操作（用 Redis 命令/ Lua 脚本描述，判题用真 Redis 跑用例）：
> 1) `claim(user_id, dedup_key, ttl_sec)` → 首次返回 `1`，重复返回 `0`，且并发下不得两个 `1`；
> 2) `allow_channel(channel, max_qps)` → 基于滑动窗口的渠道配额，要求在窗口边界不出现 2× 突发（测试用例用固定时钟注入）。
> 用例覆盖：并发 500 次同 key、TTL 到期后允许再次通过、渠道配额在窗口切换点不超限。

考察点：`SET key val NX EX` 与 `INCR/EXPIRE` 原子性、Lua 或 pipeline 的边界、时钟注入下算法正确性。属于"真做过才有肌肉记忆"的题。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | JD 常见原文能力项（示意，入库时替换为抓取到的真实片段） |
|---|---|---|
| Airbnb | Senior Software Engineer, Messaging / Marketplace Platform | "Design and build highly scalable event-driven services"; "Own services with SLAs and operational excellence"; "Collaborate on API contracts" |
| Airbnb | Senior Data Engineer, Growth/Personalization | "Build real-time data pipelines with Kafka/Spark"; "Ensure data quality and lineage" |
| Apple | Senior Software Engineer, Ads / Services Platform | "Experience designing high-throughput distributed systems"; "Deep understanding of availability/consistency trade-offs"; "Respect for user privacy in data handling" |
| Apple | Data Engineer, Device Telemetry | "Petabyte-scale ingestion and processing"; "Optimize for cost and latency" |
