# Redis 7.x/8.x：数据结构应用、原子性、一致性与集群约束

适用基线：Redis **7.0+**（Functions、`SINTERCARD`、`COPY`、`LMPOP/ZMPOP`、`EXPIRE/GT/LT`、listpack、ACL v2、multi-part AOF）；按版本增补 7.4（hash field TTL）、8.0（统一发行版 + `HGETEX/HSETEX/HGETDEL` + Vector Set [beta]）、8.2（`XDELEX/XACKDEL`、`BITOP DIFF/DIFF1/ANDOR/ONE`、`CLUSTER SLOT-STATS`、`OVERWRITTEN/TYPE_CHANGED` 键空间通知）。
**判分容器提醒**：仓库计划镜像用 apt `redis-server`（ubuntu 22.04 是 **6.0.x**）→ 必须在 `docker/mirrors.sh` 里改用 Redis 官方 APT 源固定 7.2/7.4 或 8.x，否则本文件一半题目编译不出命令。出题前跑 `redis-cli -v` 与 `redis-cli INFO server | grep redis_version`，并把"最低版本"写进题目 `tags`。
**别写不存在的名字**：`redislite` 是第三方 Python 包（yahoo/redislite，把 redis-server 嵌进 Python 进程），**不是 Redis 官方特性或版本**；`CL.THROTTLE` 来自 `redis_rate` 模块 / Redis Enterprise 代理，**不是 Redis Open Source 内核命令**；`KEYS` 的替代品是 `SCAN`，不是 `KEYS ASYNC`。`RedisLite`/`RedisAir`/`VSIM 稳定版` 之类都按"编造 API"判负。

---

## 1. 核心机制

### 1.1 单线程命令执行的后果（这是所有 Redis 题的物理定律）
- 命令按到达顺序**逐条原子执行**（6.0+ 的多 I/O 线程只并行"读请求/写响应"，命令执行仍单线程）。=> 任何"两条命令之间会不会被插队"的问题，答案取决于**是否用 `MULTI`/Lua/Function 包成一次提交**；也意味着一条 `KEYS *`、一个 100 万元素的 `SMEMBERS`、`DEL` 一个 500MB 大 key、`SORT` 不带 `STORE` 都能让全实例尾延迟飙升 → 用 `UNLINK`、`SCAN` 游标、`HSCAN/SSCAN` 分批、`ZREMRANGEBYRANK` 分段删。
- 阻塞命令（`BLPOP`/`BRPOP`/`BZPOPMAX`/`XREAD BLOCK`/`WAIT`）不阻塞其他客户端（把客户端挂到 deferred 队列，由 `postProcessing` 恢复），但会占用 client 数与 `timeout` 事件循环成本。
- Lua/Function 里**没有超时只有 `lua-time-limit`（默认 5s）**：超时只是开始返回 `BUSY`，脚本仍在跑；只有 `SCRIPT KILL`（未写数据时）或 `SHUTDOWN NOSAVE` 能结束 → "函数里写了循环到死"在生产是不可恢复故障。判分题面里出现长循环脚本 = 直接把 runner 卡死，因此**必须限定脚本步数**。

### 1.2 过期、驱逐与内存账
- 过期是**被动（访问时检查）+ 主动（每秒 10 次采样，命中 25% 则继续）**混合：`active-expire-effort`（1-10，默认 1）、`hz`/`dynamic-hz` 决定巡检频率。推论：过期键的内存**不会**在 TTL 到点立刻释放，`DBSIZE`/`MEMORY USAGE` 仍包含它们；判分不能断言"过 TTL 后 `EXISTS` 立即 0"（除非用 `DEBUG SLEEP` + `TTL` 主动触发，或 `INFO stats` 的 `expired_keys`）。
- 精确性：Redis 4.0.0 起**后台定时删除**保证过期语义最终一致；`DEBUG SET-ACTIVE-EXPIRE 0` 可关掉主动巡检做确定性测试（需要 `enable-debug-command`，7.0 起默认关闭）。
- 驱逐：`maxmemory` + `maxmemory-policy`（`noeviction`（默认）/`allkeys-lru`/`allkeys-lfu`/`volatile-lru`/`volatile-lfu`/`allkeys-random`/`volatile-random`/`volatile-ttl`）。要点：**LRU/LFU 是近似算法**（采样 `maxmemory-samples` 个键，默认 5；LFU 用 `lfu-log-factor`/`lfu-decay-time` 做计数器对数与衰减），所以"命中率损失 <1%"换来的是 O(1) 元数据开销；`volatile-*` 在"没有带 TTL 的键"时行为等于 `noeviction`（写命令报 `OOM command not allowed...`）——这是"缓存实例被配成存储实例"的经典事故。
- 内存账要会算：`INFO memory` 的 `used_memory_dataset` vs `used_memory_lua` vs `mem_fragmentation_ratio`（>1.5 考虑 `activedefrag`，注意它只在 `maxmemory-policy` 与 allocator=jemalloc 下有意义）；`MEMORY USAGE key`（估算，含采样误差）、`MEMORY DOCTOR`、`OBJECT ENCODING`（`int/embstr/raw/quicklist|listpack/hashtable|listpack/skiplist`）、`OBJECT IDLETIME`（LRU 时钟，10 秒精度）与 `OBJECT FREQ`（需 LFU）。
- 编码切换阈值决定"小 Hash 是省内存大 Hash 是内存爆炸"：`hash-max-listpack-entries`（128）、`hash-max-listpack-value`（64）、`list-max-listpack-size`、`set-max-intset-entries`（512）。**一个字段被设成 100KB 就会让整个 Hash 转 hashtable**（`hash-max-listpack-value` 超限）→ 会话缓存里塞大 value 是隐形成本跳变点。

### 1.3 原子性的三档工具与选择
| 工具 | 语义 | 何时用 | 何时不要用 |
| --- | --- | --- | --- |
| 单命令 | 天然原子（`SET ... NX`、`ZADD GT`、`GETDEL`、`SPOP count`、`LMPOP/ZMPOP` 7.0 的多键弹出） | 首选；O(1) 且无脚本开销 | 需要"读后条件写"时 |
| `MULTI/EXEC` + `WATCH` | 入队后一次性执行（**不支持读→判断→写**）；`WATCH` 给乐观并发（被改则 `EXEC` 返回 nil） | 无数据依赖的批量、CAS 风格更新 | 需要脚本内逻辑分支；集群下跨 slot 键 |
| Lua（`EVAL`/`EVALSHA`）或 Function（`FCALL`/`FCALL_RO`，7.0+） | 整个脚本原子且阻塞服务器 | 条件写、限流、令牌桶、多键搬运、"检查+扣减+记录" | 长循环、随机数直接落库（非确定性写入）、把大结果集在脚本里聚合 |
- Function 相对 `EVAL` 的真实优势（官方口径）：库是**数据库端一等对象**（`FUNCTION LOAD`/`DELETE`/`DUMP`/`RESTORE`/`FLUSH`/`LIST`/`STATS`/`KILL`），随 AOF/RDB 持久化并复制到副本；`EVAL` 的脚本只在缓存里（`SCRIPT FLUSH`/重启/failover 后 `NOSCRIPT`），且 `MULTI` 里 `EVALSHA` 缺脚本会让事务整体失败；库内函数可互相调用（脚本做不到）；有名字便于 `MONITOR` 排查。
- Function 的硬约束（判分常考点）：**所有被访问的键必须通过 `KEYS`（`FCALL fn numkeys ...` 的 `numkeys`）显式声明**，否则集群下路由与 ACL 都失效；`redis.call('TIME')` 等命令是允许的（Redis 5 起默认**effects replication**：复制的是脚本产生的写命令而非脚本本身，因此随机性不再破坏一致性——这是很多人答错的版本细节）；需要显式把随机结果写进副本时可用 `redis.REPLICATE`；只读函数要注册 `flags={'no-writes'}` 才能用 `FCALL_RO` 在只读副本/`FCALL` 在只读状态下执行；`allow-stale`/`no-cluster`/`allow-cross-slot-keys` 是其余可用 flag（`allow-cross-slot-keys` 属高级用法，默认不要开）。
- **集群下 Functions 不会自动同步到所有节点**（官方文档明确：需要管理员逐节点加载，如 `redis-cli --cluster-only-masters --cluster call host:port FUNCTION LOAD ...`）；`redis-cli --cluster add-node` 会把已有函数带到新节点；临时实例可用 `redis-cli --functions-rdb` 预置。这是"7.0 新特性到底能不能直接上生产"的标准追问。

### 1.4 一致性：缓存与 DB 的四种失效策略
1. **Cache-Aside + 先更 DB 再删缓存**（默认正确解）。"先删缓存再更 DB"在并发读写窗口里会把旧值重新写回缓存；"更新缓存而不是删除"在并发写下无法保证顺序（谁最后落库未知）→ 除非用**版本号**（见 3）。
2. **延迟双删**：只在"读多写少 + 缓存 TTL 很短 + 可容忍窗口"下有意义；它的正确性依赖"延迟 > 主从复制与读路径耗时"，所以**必须给出实测的延迟上界**才成立（说出这点是 senior 门槛）。
3. **版本号/世代（epoch）**：缓存值里带 `v=updated_at/row_version`，回填缓存前用 `SET key val NX`/Lua 比较版本，旧版本直接丢弃；读接口比较 `If-None-Match`。这是唯一能抵御"慢请求后到"的方案。
4. **binlog 订阅（CDC，Canal/Debezium 类）驱动失效**：解耦、可重放、天然带顺序；代价是链路复杂 + 需要幂等消费（用 `gtid`/`binlog file:pos` 做去重键）。
- 击穿（单热点过期）：互斥重建 `SET lock:key 1 NX EX 5` + 等待者短轮询/直接返回降级值；或 `CLIENT TRACKING` + 逻辑过期（value 里存 `expire_at`，过期后由后台异步刷新，前台永远有值）。
- 雪崩（同时过期/实例重启）：TTL 加抖动（`ttl + rand(0, ttl/5)`）、分层（本地 `Caffeine` + Redis）、多实例、预热脚本、`maxmemory-policy allkeys-lfu` 提升命中率稳定性。
- 穿透（查不存在的数据）：空值短 TTL（`SET key "" EX 60`）、布隆过滤器（`BF.ADD`/`BF.EXISTS`；RedisBloom 已并入 Redis 8 发行版；`BF.RESERVE key error_ratio capacity`，误判率与 `m/n` 的公式要能推导；**不支持删除** → 需要"可删"时换 `CF`（Cuckoo Filter，`CF.DEL` 存在但当同 key 计数>1 时删除有假阴性风险）或换"每日重建 + 双 buffer 切换"）。
- 度量口径：一致性不是"应该没问题"，而是 `staleness = 读到旧值的比例` + `p99 陈旧时长`，可通过"影子读比对（同 key 读缓存与 DB 打点）"得到；这是 principal 的必备答案。

### 1.5 高频生产模式（含命令级细节）
- **限流**：
  - 固定窗口：`INCR key` + 首次 `EXPIRE key ttl NX`（7.0 用 `EXPIRE ... NX`；老写法 `SET key 1 EX ttl` 再 `INCR` 会在窗口边界被翻倍）→ 缺点：边界突刺 2 倍。
  - 滑动窗口日志：`ZADD key now member` + `ZREMRANGEBYSCORE key 0 now-window` + `ZCARD key`，四条命令必须包进一个 Function（否则 `ZCARD` 前有人清理/有人插入，计数不准且并发超发）。成员唯一性要带 `nonce`（同一毫秒内多次请求不能互相覆盖）。
  - 令牌桶：Function 里读 `tokens`、`last_refill`（用 `redis.call('TIME')` 或客户端传 now，**测试要传 now 才可判分**），按 `rate` 补充、按 `capacity` 封顶，返回 `[allowed, remaining, retry_after_ms]`。
  - 并发扣减（库存）：`ZADD GT`/`DECRBY` + 负值回滚是错的；正解是 Function 内 `if tonumber(cur) >= n then DECRBY ... end` 或 `Lua` 返回剩余额度。
- **延迟队列**：`ZADD delay <executeAt> payload` + 轮询 `ZRANGEBYSCORE delay -inf now LIMIT 0 100`，投递前 `ZREM key member` **返回 1 才算抢到**（这是免费的互斥锁）；重复执行仍要幂等。Streams 方案：`XADD` + consumer group + `XAUTOCLAIM min-idle-time`（6.2+）处理死掉的消费者，`XPENDING` 看积压；8.2 的 `XDELEX`/`XACKDEL` 把"删除条目并同步处理 PEL"合并成一条，避免"删了条目但 PEL 残留导致 `XAUTOCLAIM` 复活幽灵消息"（这正是老代码的典型 bug，且 8.2 的 `XTRIM ... DELREF/ACKED` 策略给了明确语义）。
- **幂等消费**：`SET idem:<msgId> 1 NX EX 86400` 判重；失败时要 `DEL` 释放（否则重试被吞）→ 与"处理耗时 > TTL"的竞态要显式讨论（延长租约或改成两态 `PENDING/DONE`）。
- **会话/免登录**：Hash 存会话 + 7.4 起 `HEXPIRE session:{id} 1800 FIELDS 1 token`（**字段级 TTL**，同一 Hash 里 token 短、profile 长）；8.0 的 `HGETEX key FIELDS 1 token EX 1800` 把"读时续期"合成一条；`HPERSIST`/`HTTL` 做状态查询。Redis 8.0 起这类"读+设过期"能力与 `GETEX` 对齐，写出的会话缓存不需要 Lua。
- **排行榜**：`ZADD board GT score member`（7.0 的 `GT` 只在"分数更大"时更新，天然实现"最高分保留"）；`ZREVRANGE board 0 9 WITHSCORES`、`ZREVRANK`、并列名次用 `ZCOUNT` 计数而非行号；百万成员下 top-K 缓存与 `ZPOPMAX` 批量消费要区分（后者会破坏榜单）。
- **去重/签到**：`SETBIT sign:{uid}:{yyyymmdd} dayOffset 1` + `BITCOUNT`（按天位图，一年 365 bit = 46 字节）；跨用户统计"某日签到数"用 `BITCOUNT` 逐 key 太慢 → 用反向位图 `signers:{date}` + `BITCOUNT`，或用 `PFADD` 做近似 UV（HLL 标准误差约 0.81%，**不可减**，`PFADD key 0` 与 `PFMERGE dest src...` 的语义与内存上界要能说出来）。
- **多键操作与集群**：`MGET`/`DEL a b`/`SINTERSTORE` 要求同 slot → 键设计成 `{tenant:user:42}:profile`（hash tag）；错误码：`CROSSSLOT Keys in request don't hash to the same slot`、`MOVED`/`ASK`（重定向语义差别：`MOVED` 更新本地 slot 表，`ASK` 只是本次转投，需先发 `ASKING`）；7.0 的 `LMPOP`/`ZMPOP` 提供多键原子弹出，仍受 slot 约束；`CLUSTER SHARDS`（推荐，取代自 7.0 弃用的 `CLUSTER SLOTS`）；8.2 的 `CLUSTER SLOT-STATS` 给每 slot 的键数/CPU/网络，把"热点 slot"从猜测变成指标。

---

## 2. senior / principal 会被追问什么
1. 你的 `SCAN` 盘点脚本如何保证**不重复不遗漏**？（答案：`SCAN` 只保证"整个迭代期间始终存在的键一定被返回**至少**一次"，可能重复，需要在途删除语义；客户端要去重。）`COUNT` 是"每轮扫描 bucket 数量的提示"，不是返回条数。
2. 缓存与 DB 的一致性如何**度量**并设 SLO？给出租户级 staleness 指标的采集方法（影子读、双读 diff 采样率）。
3. 限流器部署在哪一层（客户端/网关/Redis）？集群模式下 `INCR` 热点会不会退化为单 slot 瓶颈？（正解：分片计数 `rl:{shard}` + 汇总，或本地令牌桶 + Redis 粗粒度。）
4. `KEYS` 之外如何找大 key：`redis-cli --bigkeys`（按类型采样，会低估）、`--memkeys`、`MEMORY USAGE` 抽样、离线 RDB 分析（`rdb`/`redis-rdb-tools` 类）；热 key 怎么发现：`MONITOR` 绝不能在生产的代理上做（性能塌方）、正解是 `redis-cli --hotkeys`（要求 LFU）或 `INFO commandstats` + `LATENCY` + 代理层统计 + 8.2 `CLUSTER SLOT-STATS`。
5. 主从切换会丢什么（异步复制的窗口内写）、`WAIT 1 timeout` 能保证什么（返回被 N 个副本 ack 的写数量，超时返回不足数——不是零数据丢失证明）、`min-replicas-to-write`/`min-replicas-max-lag` 的降级语义、以及"锁服务在 failover 下两个持有者"如何靠 **fencing token**（单调递增的租约号，由存储层拒绝旧号）解决——这是 RedLock 争议后的工程共识。
6. Lua/Function 的容量与延迟风险：脚本占用主线程、`lua-time-limit` 后无法中断（写完数据后连 `SCRIPT KILL` 都不允许）、单实例 QPS 上限如何被一条重脚本拖到 1/50；如何用"读写分片 + 只读副本 `FCALL_RO`"缓解，以及 `no-writes`/`allow-stale` 的前置条件。
7. 7.0 Functions 上线运维：库的版本管理与回滚（`FUNCTION LIST`+`DUMP/RESTORE`+`--functions-rdb`）、灰度（同一实例两套库名带版本 `rate_v12`/`rate_v13`，客户端按开关切）、集群逐节点加载的自动化与故障注入（新节点没有库会怎样：`NOSCRIPT` 等价的 `Unknown function` 错误风暴）。
8. principal：缓存层成本治理（命中率与内存的折线、`INFO stats` 的 `keyspace_hits/misses` 与业务价值对齐）、以及"什么数据不该放 Redis"（需要事务/需要审计/需要跨键约束的，全部退回 DB）。

---

## 3. 常见错误答案

| ❌ 做法/说法 | 真相 |
| --- | --- |
| `EXISTS k` + `SET k v` 当分布式锁/幂等 | 两条命令之间有窗口；必须 `SET k v NX EX t` 单命令 |
| `INCR k` + `EXPIRE k 60`（每次都设） | 每次请求都把窗口延长 → 限流形同虚设；只在计数从 0→1 时设（`EXPIRE ... NX`） |
| 删除锁用 `DEL key` | 可能删掉别人的锁；必须"值唯一 token + `redis.call('GET')==token then DEL`"（Lua/Function 原子） |
| "锁有 TTL 就安全" | 业务超过 TTL 后锁被别人拿走且两个持有者同时写；正解是 watchdog 续期 + **fencing token** |
| "RedLock 提供强一致互斥" | 依赖时钟与 GC 停顿；Martin Kleppmann 的反驳结论是"它不能替代带 fencing 的共识存储"；生产口径是"Redis 锁只降低冲突概率" |
| `MULTI` 里"读一个值再决定写什么" | 事务内 `EXEC` 前读不到结果（返回 `QUEUED`）；需要数据依赖必须 Lua/Function 或 `WATCH` 重试 |
| 用 `EVAL` 传键名字符串拼接 | 集群下 keyspec 丢失 → 路由/ACL/重定位全错；键必须走 `KEYS`，值走 `ARGV` |
| "`SCRIPT LOAD` 后就一定能 `EVALSHA`" | 脚本缓存会被 `SCRIPT FLUSH`/重启/failover 清空 → `NOSCRIPT`；要么带原文回退，要么改用 7.0 Functions（库被持久化与复制） |
| "Redis 事务失败会回滚" | `EXEC` 内的命令逐条执行，**没有回滚**（只有一处入队错误导致整个事务被丢弃） |
| `KEYS pattern` 只在测试里用也行 | 阻塞主线程；即便测试也会掩盖 `SCAN` 的正确写法，题目应直接判负 |
| `DEL bigkey` | 大 key 删除是 O(N) 阻塞；正解 `UNLINK`（后台回收）或分段 `ZREMRANGEBYRANK`/`HSCAN`+`HDEL` 批删 |
| "过期的键会被立刻清掉，`DBSIZE` 可信" | 主动巡检是采样式；`INFO keyspace`/`expired_keys` 才是口径；测试里要么访问触发，要么用 `DEBUG` |
| "Redis 8 的 Vector Set 是稳定 API" | 官方标注为 **beta**，"API 与行为可能变化"，写成生产特性即失分 |
| "`CLUSTER SLOTS` 还是主流" | 自 7.0 起弃用，正解 `CLUSTER SHARDS`；热点定位用 8.2 的 `CLUSTER SLOT-STATS` |
| "开了 `allkeys-lru` 就是精确 LRU" | 采样近似 LRU（`maxmemory-samples`）；且 `volatile-*` 无带 TTL 键时等同 `noeviction` 报 OOM |
| "`SETBIT k 1000000000 1` 只花 1 bit" | 位图按 `offset/8` 分配连续字符串内存（~125MB），必须控制 key 空间基数 |
| "`PFADD` 后可以移除元素" | HLL 只能加与合并，无删除；要"可减"就得换结构或重建 |
| "键空间通知可以驱动可靠性流程" | 它是 fire-and-forget：无客户端时消息丢弃、不保证有序与到达（过期事件还需 `notify-keyspace-events` 打开 `x`/`e`）；不能当 MQ，用 Streams |
| "Redis 8 把模块命令并入后 ACL 不用改" | 官方列为**破坏性变化**：`+@read`/`+@write` 现在覆盖 `JSON`/`probabilistic`/`VECTOR` 等命令，`+@all -@write` 的账号在 8.0 上会突然被 `JSON.SET` 拒绝 |
| "`DEBUG SLEEP`/`DEBUG SET-ACTIVE-EXPIRE` 随手用" | 7.0 起 `DEBUG` 需 `enable-debug-command`（默认关）；判分容器要么显式开（仅测试环境）要么不依赖它 |

---

## 4. 可判分出题角度

`redis` runner 的确定判分要素（写题面前必须确认 runner 支持）：
1. 每题一个独立逻辑库（`SELECT <n>`）或判分前后 `FLUSHDB`；题目侧提供 fixture 命令序列（`10_fixture.redis`）；候选人提交 `answer.redis`（命令序列，可含 `EVAL`/`FCALL` 的**单行字符串**）；
2. 断言三类：回复值（类型敏感，`1` vs `"OK"` vs nil）、键状态（`TYPE`、`HGETALL`、`ZRANGE ... WITHSCORES`）、TTL 区间（`0 < PTTL <= 60000`，不要断言精确值）；
3. 交错场景用"命令序列 + 题目侧注入中间态"表达（Redis 命令串行执行，因此交错是可完全确定的，这是 Redis 题比 MySQL 题更好判的原因）；
4. 版本门槛写进 `tags`，runner 先 `INFO server` 检查（不满足则该题标记"暂不可判分"，不能判负）；
5. 时钟：所有需要"当前时间"的题必须**由题面把 now 作为参数传进命令/函数**，禁止依赖 `TIME`（不可复现）。

### 题面草稿 1（`code`，`judgeKind: redis`，difficulty: senior）
> 版本要求：Redis 7.0+。实现一个**滑动窗口限流器**：允许 60 秒内最多 100 次调用，且键为 `rl:{uid}`（uid 由参数给定）。提交文件需包含：
> 1. 一个 `FUNCTION LOAD`（shebang `#!lua name=limiter`，注册函数 `check`），调用形如 `FCALL check 1 rl:{uid} now_ms cost`（`now_ms` 由客户端传入，**禁止**在函数内调用 `TIME`）。注意：7.0 里函数名需全局唯一（库名前缀的调用形式请先在判题容器实测再决定是否写进题面），且 `numkeys` 必须为 1，把键名走 `KEYS` 而不是 `ARGV`；
> 2. `check` 会写 ZSET，因此**不得**注册 `no-writes` flag；请另外提供一个只读函数 `peek`（注册 `flags={'no-writes'}`），并说明为什么 `check` 不能用 `FCALL_RO` 执行、以及在只读副本上执行会返回什么错误；
> 3. 返回 `[allowed(0|1), remaining, retry_after_ms]`；`cost` 为负或 0 时返回错误（`redis.error_reply`）而**不是**默认扣 1；
> 4. 窗口必须真正"滑动"：在 `t=0..59` 打满 100 次后，`t=60` 时**恰好**又能通过 1 次（旧条目按时间精确过期，不允许固定窗口行为）；
> 5. 必须处理"同一毫秒多次请求"的成员唯一性（提示：`ZADD` 的 member 重复会覆盖计数）。
> 判分：交错命令序列 + `ZRANGE`/`ZCARD` 状态 + 返回值三元组。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `allow_up_to_limit` | 前 100 次 `allowed=1` 且 `remaining` 严格递减；第 101 次 `allowed=0`、`remaining=0`、`retry_after_ms ∈ [1,60000]` |
| `same_millisecond_no_merge` | 同一 `now_ms` 连打 5 次：`ZCARD` 增加 5（member 只用 `now_ms` 的实现会覆盖 → 判负，这是核心用例） |
| `true_sliding_boundary` | `t=0` 打满 → `t=59_999` 仍拒绝 → `t=60_000` 允许 1 次（固定窗口实现会在 `t=60_000` 直接放行 100 次 → `ZCARD` 断言暴露） |
| `bad_cost_errors` | `cost=0`、`cost=-1`、非数字：返回错误回复（`ERR` 前缀）且 `ZCARD` 不变（防止"默默扣 1"） |
| `no_writes_flag_rejected` | 对 `check` 使用 `FCALL_RO` 必须失败（证明候选人理解 flag 与只读副本语义）；`peek` 用 `FCALL_RO` 必须成功且不改变 `ZCARD` |
| `expiry_no_growth` | 打满 100 后把 `now_ms` 推到 `t=200s` 再打 1 次：`ZCARD <= 101`（清理逻辑真的执行，不会无限增长） |

### 题面草稿 2（`code`，`judgeKind: redis`，difficulty: principal）
> 版本要求：Redis 7.4+（hash field TTL）。实现"多字段会话缓存 + 一致性回填"，键 `sess:{sid}`（Hash）：
> - `token` 字段 TTL = 1800s（滑动续期），`profile` 字段 TTL = 86400s（固定），`meta` 永不过期；
> - 提供四个操作：`create`（`HSETEX` 一次写入多字段并分别设 TTL）、`touch`（读 token 且续期）、`readProfile`（读 profile，若命中缺失则按**版本号**回填：客户端传 `version`，仅当大于已存 `profile:v` 字段时才写入）、`purgeExpired`（返回被清掉的字段数，不得触碰 `meta`）；
> - **禁止**用两个键分别存 token 与 profile（考察是否理解字段级 TTL 取代多键的动机）；**禁止**遍历 `HGETALL` 再算过期（用 `HTTL`/`HPTTL`/`HEXPIRETIME`）；
> - `readProfile` 的回填必须是原子的"比较版本再写"（用 `HSETNX` 不够，必须 Lua/Function 或 `HSETEX` + `HPERSIST` 组合，并解释残余竞态）；
> - 所有时间参数由客户端注入（`now_ms`），不得调用 `TIME`。
> 判分：命令序列后断言 `HGETALL`、`HTTL sess:{sid} FIELDS 3 token profile meta`、`HEXISTS`。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `independent_field_ttl` | `HTTL` 返回 `token∈(0,1800]`、`profile∈(0,86400]`、`meta=-1`（三值同时成立才通过；整键 `EXPIRE` 的实现 meta 会变 TTL → 判负） |
| `touch_slides_only_token` | 两次 `touch` 之间推进虚拟时间：`token` TTL 回到接近 1800，`profile` TTL 单调减少（证明续期没波及整个键） |
| `version_guard_on_backfill` | 先写 `v=10`，再用 `v=9` 回填 → 值与 `profile:v` 保持 10；并发交错（题目侧顺序注入两个回填）必须只保留高版本 |
| `purge_expired_fields_only` | 预置 3 个过期 token + 2 个未过期 + `meta`：`purgeExpired` 返回值 = 3，且 `meta` 仍在（打"整键删除"的实现） |
| `no_two_keys_design` | 静态检查候选人提交里不得出现除 `sess:{sid}` 之外的会话键前缀（`KEYS sess*` 结果集断言） |
| `missing_field_vs_nil` | 读不存在的 `profile` 与读值为空串必须能区分（`HGET` nil vs `""`），断言 `HGETEX`/`HSETEX` 用法正确 |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：把一套 6.2 + `EVAL` 脚本 + 自建锁 + 双删失效的缓存体系升级到 Redis 8.x（统一发行版）。要求给出：(a) 能力替换表（`EVAL`→Function、两键会话→字段级 TTL、手写滑动窗口→`ZADD GT`/`HGETEX` 等）；(b) 迁移顺序与灰度；(c) 三个"升级后行为会变"的坑（含 ACL 类别变化、`CLUSTER SLOTS` 弃用、`DEBUG` 受限）；(d) 一致性度量的改造。

**points**：能力替换准确（不编 API）3｜集群下 Functions 逐节点加载与 `--functions-rdb`/`FUNCTION DUMP/RESTORE` 的回滚方案 2｜破坏性变化清单（`+@read/+@write` 覆盖模块命令、`FT.SEARCH` 默认打分从 TF-IDF 变 BM25、`CLUSTER SLOTS` 弃用、`DEBUG` 需 `enable-debug-command`）3｜锁/幂等/fencing 的残余风险与观测 1｜staleness 度量方案 1。
**bonus**：指出 `EVAL`→`FCALL` 后 `NOSCRIPT` 类故障模式消失但引入"新节点缺库"模式；提到 8.2 的 `CLUSTER SLOT-STATS` 与 `XDELEX/XACKDEL`；提到 `Vector Set` 是 beta 不可依赖；给出双写灰度期间的版本比较与回滚开关。
**gaps**：只讲"性能提升"不讲行为差异；把 RedLock 当强一致；认为"升级即插即用，无需 ACL 复核"；没有回滚路径。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 缓存一致性与失效策略、staleness 度量 | `APL-BE-1`、`ABNB-BE-2` |
| 原子性工具选型（单命令/MULTI/Lua/Function）与集群 keyspec | `APL-BE-3`、`APL-BE-1` |
| 内存/延迟/驱逐与热点治理 | `APL-BD-2`、`ABNB-BE-2` |
| 限流、延迟队列、幂等、锁与租约 | `APL-BE-1`、`ABNB-BE-2` |
| Redis 7.4/8.x 新语义与升级风险 | `APL-BE-3` |
