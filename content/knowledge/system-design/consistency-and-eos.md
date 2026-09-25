# 一致性、幂等与正确性设计（把"背概念"和"真修过事故"区分开）

对应考点：`consistency-models`、`idempotency-retry`、`distributed-lock`、`rdbms-transactions`、`eos-semantics`
适配难度：senior / principal｜出题形式：`code`（redis / mysql / java-junit）+ `rubric`

---

## 1. 核心机制

### 1.1 一致性是"每操作"的属性，不是全局开关
- 强到弱排：linearizable（跨 key 原子可见，代价 = 共识往返）→ sequential → causal → read-your-writes → monotonic-read → bounded-staleness → eventual。
- 工程上真正可用的表达方式是**按请求/按会话声明**：
  - 会话内保证（读己之写、单调读、写前读）成本低，覆盖 90% 用户可感异常；
  - 全局线性一致只在"钱、库存、配额、锁"这类不变量上买；
  - 其余用"版本号/时间戳 + 客户端合并"或"声明式陈旧度上限（staleness bound）"。
- 判据不是"我觉得要一致"，而是**能不能写出异常反例**：写偏斜（write skew）、丢失更新（lost update）、读陈旧导致重复下单、跨区双写导致余额双倍。

### 1.2 幂等的三种实现层级
| 层级 | 做法 | 适用 | 失败模式 |
|---|---|---|---|
| 请求级 | 客户端生成 `Idempotency-Key`，服务端存 `(key → response)`，条件写抢占 | 支付/下单/发通知 | key 作用域搞错（跨 endpoint 复用）；结果重放丢失 header；存储 TTL 短于上游重试窗口 |
| 业务级 | 状态机 + 前置状态校验（`UPDATE ... WHERE status='PENDING'`），受影响行数判成功 | 订单、账务、工单 | 用 `read-then-write` 判断状态（竞态）；不区分"重复"与"非法状态转移" |
| 数据级 | 唯一约束 / upsert（`INSERT ... ON DUPLICATE KEY UPDATE`、`MERGE`）、湖仓主键表 | ETL、事件回放 | 部分列更新互相覆盖（需要 last-write-wins 版本列）；重跑覆盖人工修正值 |
- 幂等存储的**正确性来自条件写（CAS）**，不是来自 Redis：`SET NX` 只能保证"第一次"，不保证"执行中崩溃后不重做副作用"。真正严谨的做法是 `IN_PROGRESS → result` 两阶段记录，并处理"占坑后进程崩溃"的租约回收（超时后允许接管，但必须配合 fencing token）。

### 1.3 锁与 fencing token
- 效率锁（省重复计算）：Redis `SET NX PX` + 唯一值 + Lua 释放（比对 value 再删），配合 `PX` 与看门狗续期。
- 正确性锁：必须带 **fencing token**——存储层拒绝比自身已见 token 更小的写（Martin Kleppmann 那条经典论证）。ZooKeeper `zxid`/Etcd `revision` 提供单调 token，Redis 不提供。
- 时钟陷阱：GC 暂停、NTP 步进、VM 迁移都能让"锁还没过期但进程被冻结两分钟"发生；不要说"我们用了 Redis 所以没问题"。

### 1.4 关系型数据库里的真实异常
- MySQL InnoDB（RR）：范围查询加 gap/next-key lock；`SELECT ... FOR UPDATE` 在二级索引上可能锁更大范围 → 死锁。修法：走主键、缩小事务、固定加锁顺序、`innodb_deadlock_detect` 与重试。
- Postgres（RC）：无传统 gap lock，靠 SSI（`SERIALIZABLE`）检测 rw 依赖并 abort；18 起（2025-09-25）异步 I/O（`io_method=worker|io_uring`）、UUIDv7、虚拟生成列、`NOT NULL` 目录化标记，深分页与批量写表现改善（细节需核实到你们所用发行版）。
- 丢失更新三种修法：`SELECT FOR UPDATE`；`UPDATE t SET v=v+? WHERE id=? AND version=?`（乐观）；把读-改-写合并为单条原子语句。三者性能/冲突率取舍要能讲。
- 任务队列：`SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` 在 5k TPS 内是简单可靠的方案；更大规模再上专门的 durable execution。

### 1.5 跨系统正确性：outbox + 收敛
1. 业务写与 outbox 行同事务提交；
2. CDC/debezium 或 outbox dispatcher 投递（at-least-once）；
3. 消费端幂等 upsert（业务级/数据级）；
4. 独立对账作业发现"漏投/错序"，触发重放（可重放源 + 幂等 sink = 端到端正确）；
5. 湖仓侧用表格式 ACID 快照（Iceberg/Paimon）或 Spark 4.2 的 `CHANGES` / Auto CDC 做增量收敛，而不是靠 `updated_at` max 值去重。

---

## 2. senior / principal 会被追问什么

1. "这个场景你买什么一致性、不买什么？给出一个能被同事反驳的具体决定。"
2. "你的幂等键存在哪、TTL 多长、为什么？上游 5 分钟后重试还有效吗？上游是小时级批处理呢？"
3. "占坑后进程崩溃，这条请求会卡多久？谁来接管？接管时如何避免两边都执行了副作用？"（→ 租约 + fencing token + 副作用自身幂等）
4. "举一个你亲历过的 write skew / lost update，你是怎么定位的（哪些指标/日志证明是竞态而不是慢查询）？"
5. "双区同时接受写同一个 key，你怎么收敛？LWW 会丢什么？业务上谁可以丢、谁绝对不行？"
6. "你怎么证明现在系统没有重复扣款？"（对账 + 不变量断言 + 生产级 canary，而不是"我们加了锁"）
7. "如果下游只有 at-least-once 且没有幂等能力，你怎么办？"（在出口建去重表 / 加唯一索引 / 用"意图表 + 状态机"）
8. "重试预算怎么设？为什么固定 3 次 + 1s 是错的？"（jitter、预算比例、熔断、区分可重试/不可重试错误、避免重试风暴放大故障）

---

## 3. 常见错误答案

| 错误 | 破绽 |
|---|---|
| "用 Redlock 保证分布式互斥，所以绝对不重复执行" | 忽略 GC 暂停/时钟漂移；没提 fencing token；把效率锁当正确性锁 |
| "把隔离级别调到 SERIALIZABLE 就没并发问题了" | 代价（abort 率、锁范围、吞吐塌陷）与观测方式全无；Postgres SSI abort 需要客户端重试策略 |
| "幂等就是加个唯一索引" | 对"结果需重放"的 API（返回同一个 response / 同一个 charge id）说不清 |
| "我们用了 outbox 所以不丢" | 说不出 dispatcher 崩溃后的恢复、顺序被并发投递破坏、消费端仍需幂等 |
| "读己之写靠主从延迟监控解决" | 延迟监控只给相关性；正确解法是路由粘性 / 会话版本 / 短 TTL 双读校验 |
| 只讲 CAP 定理名词 | 说不出"分区时选 AP 还是 CP"的具体组件行为（谁拒绝、拒绝返回什么码、用户体验如何降级） |

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=mysql`）
> 表 `account(id, balance, version)`、`ledger(account_id, request_id UNIQUE, delta, created_at)`。给定并发场景（判题按顺序重放两个会话的语句序列）：
> 1) 实现"不丢失更新"的扣款（三条语句：读、判、写），要求**不使用** `SELECT FOR UPDATE`；
> 2) 用 `request_id` 实现幂等：重复执行同一扣款请求，最终余额只变一次；
> 3) 写一条检测 SQL：找出"余额 ≠ 期初 + Σdelta"的账户（不变量校验）。
> 用例覆盖：并发重复请求、余额不足、`version` 冲突后重试一次成功、以及"故意漏写 ledger 行"能被检测 SQL 抓到。

区分度：只有真正做过资金链路的人会写"先插 ledger（唯一键冲突即视为重复）再更新余额"的顺序，并知道不变量必须可自动检测。

### 题面草稿 B（`code`，`judgeKind=java-junit`）
> 实现 `IdempotentExecutor.handle(String key, Callable<Receipt> action)`：
> 语义要求 ①首次调用执行并返回结果；②同 key 并发调用只执行一次，其余等待并返回同一结果（不得重复执行副作用）；③执行中崩溃（测试注入 `crashAfterSideEffect()`）后再次调用可以重新执行但必须把重复副作用可识别（返回 `duplicateSuspected=true`）；④结果缓存有 TTL，TTL 后同 key 视为新请求；⑤非法状态转移返回 `ILLEGAL_TRANSITION`，与"重复请求"区分。
> 用例：1000 线程同 key、副作用计数器断言为 1；崩溃恢复用例断言计数器为 2 且第二次标记可疑；TTL 过期用例；错误分类用例。

### 题面草稿 C（`rubric`，10 分制）
> **Apple · Senior/Principal Backend（30 分钟）**
> 一个"设备端离线写入 + 云端提交"的功能：用户在 iOS 上对某集合做批量编辑，弱网下客户端会重试；服务端落在双区域部署的数据库上，读写分别命中就近副本。产品要求：用户刷新后必须看到自己的最新结果；同一编辑动作不得在云端产生两份记录；区域故障时允许降级为只读。
> 请给出：一致性声明（按操作粒度）、幂等与去重设计、冲突解决、双区故障时的行为矩阵（谁写、谁读、返回什么状态码）、以及"上线后如何证明没有重复记录"的观测/对账方案。

**加分点**
1. 会话级读己之写：用客户端携带的 `version`/`LSN` 做"读不低于写"的门禁（或 sticky session + 副本延迟阈值），并说明代价（跨区读、延迟）。
2. 幂等键由**客户端在编辑动作创建时**生成（非重试时生成），并给出跨重启的持久化位置（Keychain/DB）。
3. 记录级去重：`(user_id, action_uuid)` 唯一索引；冲突返回原结果（200 + replay 标记），不是 409。
4. 双写冲突有明确策略：同用户单归属区（unit 化）→ 避免跨区写冲突；做不到时给 LWW + 冲突表 + 人工/自动合并。
5. 降级行为矩阵：区域不可写时返回 `503 + Retry-After`（或 202 排队）并让客户端本地保留意图，而不是静默丢。
6. 证明手段：每日不变量断言（重复键计数=0）、影子对账、灰度期 1% 流量双跑对比、故障演练。
7. 明确"不做什么"：不追求全局线性一致，不用分布式事务，理由充分。
8. 一致性成本可见：给出延迟增加（+一次共识往返 / +跨区 RTT）与吞吐影响。
9. 观测三件套：写成功率、replay 率、读陈旧度（副本延迟）都有指标与告警阈值。
10. 事故经验：能讲一次真实"重试风暴/双写导致重复"的定位路径（指标序列 + 修复 + 防复发）。

**不足点**
- "加个唯一索引 + 分布式锁就 OK"；对锁失效窗口无解释。
- 说不清重复请求与非法状态转移的响应差异（HTTP 语义混乱）。
- 无对账/证明方案，只谈"设计很可靠"。
- 一致性目标含糊（"尽量一致"、"最终一致就行"）。
- 忽略客户端重试带来的风暴、退避与预算。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Airbnb | Backend, Payments / Booking Integrity | "Design for data integrity and correctness"; "Handle concurrency at marketplace scale"; "Own reliability for money-critical services" |
| Airbnb | Senior/Staff Data Engineer | "Guarantee pipeline correctness and idempotent backfills" |
| Apple | Senior Software Engineer, iCloud / Services | "Strong understanding of distributed systems, consistency and fault tolerance"; "Privacy-preserving data handling" |
| Apple | Principal Engineer, Platform | "Architect multi-region, highly available services"; "Set and enforce SLOs" |
