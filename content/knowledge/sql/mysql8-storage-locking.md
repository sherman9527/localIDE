# MySQL 8.x InnoDB：索引结构、事务/MVCC 与锁

适用：MySQL 8.0.x（判题容器基线）与 8.4 LTS 的默认值差异。判分：`mysql`（多连接 + 超时 + 结果/错误码断言）、`llm-rubric`。

---

## 1. 核心机制

### 1.1 B+ 树与"页"决定的一切
- 表空间 → 段（segment）→ 区（extent，16 页连续，默认页 16KB）→ 页。聚簇索引是叶子存**整行**的 B+ 树；二级索引叶子存 **`(索引列..., PK)`**，因此"PK 越小，所有二级索引越小"——`BIGINT` PK 与 `VARCHAR(64)` PK 的空间差会乘以二级索引个数。
- 行格式：`DYNAMIC`（8.0 默认）/`COMPACT`/`COMPRESSED`/`REDUNDANT`。`VARCHAR`/`BLOB` 超长时外部存储（overflow page），本地留 20 字节指针；**单行最大 65535 字节**（不含 BLOB 外部存储的 40 字节/列指针），所以 `utf8mb4 VARCHAR(21845)` 就已经到顶（`21845×4 > 65535`）——建表就报错，比"运行时才炸"好。
- 页分裂与填充：顺序主键写 → 页几乎填满；随机主键（UUID）→ 50% 填充率 + 更多分裂 + 缓冲池污染。缓解：UUID 前缀打散（时间有序化）、`innodb_fill_factor`（只影响**批量插入/建索引时**的目标填充度，不影响后续 DML）、`innodb_flush_neighbors`（SSD 下 8.0 默认 0）。
- 自适应哈希索引（AHI）：热点等值查的内存 hash，8.4 默认 **`OFF`**（分区锁竞争在高并发下被判定为净负收益）→ 老书里"开 AHI 提速等值查询"的建议要按版本改写。
- `change buffering`：非唯一二级索引写的合并缓冲，8.4 默认 **`none`**；这同时意味着"二级索引写放大"不再有隐藏缓解，加索引要更保守。
- 双写缓冲（doublewrite）在 8.4 固定为 `2 files / 128 pages`；`innodb_flush_log_at_trx_commit=2` + `sync_binlog=0` 的"丢三秒"取舍是经典追问。

### 1.2 MVCC：ReadView 与"快照读 vs 当前读"
```
undo 版本链:  row_v3 -> row_v2 -> row_v1     （每个事务修改前把旧值写 undo）
ReadView:     { m_ids(活跃事务集合), min_trx_id, max_trx_id, creator_trx_id }
可见性判定:   trx_id == creator → 自己改的可见；trx_id < min_trx_id → 早于我，可见；
             trx_id >= max_trx_id → 在我之后开启，不可见；否则看 trx_id 是否在 m_ids（在则不可见）
```
- **RR（可重复读）**：事务内**第一条快照读语句**建立 ReadView 并整个事务复用 → 反复读同一行结果一致。
- **RC（读已提交）**：**每条**快照读语句新建 ReadView → 能看到别人新提交，但也意味着"重复读"不保证；互联网大量系统用 RC + `binlog_format=ROW`（RR 下的 gap lock 与"同 SQL 主从不一致"问题在 RC 下更少）。
- **当前读**：`SELECT ... LOCK IN SHARE MODE/FOR SHARE`、`FOR UPDATE`、`UPDATE`、`DELETE`、`INSERT`（唯一性检查、外键检查）——它们读"最新版本并加锁"，因此：RR 事务里 `SELECT`（快照）看到 v1，紧接 `UPDATE` 该行的 `WHERE` 条件却按 v3 判定 → "我刚读到的值怎么不是它"。**这是本文件最重要的一条 senior 认知。**
- 长事务危害：undo 无法 purge → `history list length` 增长、版本链变长（每次读要沿链找可见版本）、`Information_schema.INNODB_TRX` 里 `trx_started` 很久、`autocommit=0` 的连接池复用 = 隐性长事务（8.0 的 `innodb_purge_threads` 在 8.4 变成按 CPU 动态 1/4）。
- 8.4 的 `information_schema.PROCESSLIST` 已弃用（新增 `Deprecated_use_i_s_processlist_count` 计数）→ 观测改 `performance_schema.processlist`/`threads`/`events_transactions`（需先开 instrument）。

### 1.3 锁：粒度、类型与真实行为
| 锁 | 触发与范围 | 常见误解 |
| --- | --- | --- |
| 记录锁 record lock | 索引记录上 | "锁的是行" → 实际锁的是**索引记录**；无可用索引时 InnoDB 锁"所有记录"（等价全表锁）+ gap |
| 间隙锁 gap lock | 索引记录**之间**的开区间，只阻止插入 | RR 特有；RC + `binlog_format=ROW` 下基本不产生 gap 锁（仅唯一键冲突检查等特例） |
| next-key lock | record + gap | `WHERE id BETWEEN 10 AND 20` 加的是若干 next-key |
| 插入意向锁 insert intention | 在 gap 里 INSERT 前申请，**与 gap 锁冲突、与其他插入意向锁不冲突** | "gap 锁之间互相阻塞"是错的；多个事务能同时持有同一 gap 的锁，然后都插入 → 死锁 |
| 隐式锁 / 意向锁 IS/IX | 表级意向锁，只与 `LOCK TABLES ... READ/WRITE` 冲突 | IX 之间不冲突；`SELECT ... FOR SHARE` 申请的是 IS+记录 S |
| 快照/MDL（元数据锁） | 任何 DML 持 `SHARED_WRITE` MDL；DDL 要 `EXCLUSIVE` | **MDL 是"DDL 卡住 → 之后所有查询排队 → 连接池打满"的真凶**；`performance_schema.metadata_locks` 需开 `wait/lock/metadata/sql/mdl` instrument |
| `FTL`（全文）/ Auto-inc 表锁 | 8.0 `innodb_autoinc_lock_mode=2`（interleaved）：并发插入不互斥，但**要求 row binlog**（否则主从不一致） | "自增一定连续"是错的（回滚/冲突/批量预分配都会留空洞） |

死锁：InnoDB 有等待图检测（`innodb_deadlock_detect=ON`，8.4 未变）+ `innodb_lock_wait_timeout`（默认 50s）回滚**代价小**的那个事务（不是"后来者"）。定位：
```sql
SHOW ENGINE INNODB STATUS\G                -- LATEST DETECTED DEADLOCK 段（只保留最近一次）
SELECT * FROM performance_schema.data_locks;          -- 需要 setup_instruments 里 transaction 相关项开启
SELECT * FROM performance_schema.data_lock_waits;
SELECT * FROM sys.innodb_lock_waits;                  -- 现成的"谁堵谁 + 杀掉哪个"
```
> 注意：`information_schema.INNODB_LOCKS`/`INNODB_LOCK_WAITS`（5.7 时代的表）在 8.0 已**移除**，替代品就是上面的 `performance_schema.data_locks`/`data_lock_waits`。写题时若候选人给出 5.7 的查询 → 判为"版本口径过期"（这是一个干净的区分点）。

死锁的高频成因与解法（全部可判分）：
1. **两个事务以相反顺序更新两行**（`A→B` vs `B→A`）→ 规定加锁顺序（按主键升序）。
2. **先 gap 后 insert**：`SELECT ... WHERE k=? FOR UPDATE`（无行 → 持 gap）+ 两个事务都插同一 gap → 死锁。解法：直接 `INSERT ... ON DUPLICATE KEY UPDATE` 或 `INSERT IGNORE`，或用唯一键冲突当并发控制。
3. **批量 `UPDATE ... ORDER BY id LIMIT n`**（`ORDER BY` 在无索引时 filesort 会锁更大范围）→ 先 `SELECT id ... LIMIT n` 再 `WHERE id IN (...)`。
4. 二级索引回表顺序与聚簇索引顺序不同导致的"同方向不同序"死锁 → 用 `FORCE INDEX`/改语句使扫描序一致。
5. 重试策略：只重试 `ER_LOCK_DEADLOCK`（1213）/`ER_LOCK_WAIT_TIMEOUT`（1205），**指数退避 + 上限**，且重试必须重跑整个事务（不是只重跑失败那条语句）。

### 1.4 隔离级别与生产口径
| 级别 | 现象 | 关键取舍 |
| --- | --- | --- |
| READ UNCOMMITTED | 脏读 | 几乎不用 |
| READ COMMITTED | 不可重复读、无 gap（多数场景） | 主从一致性依赖 `ROW` binlog；并发插入热点更好 |
| REPEATABLE READ（默认） | 快照一致 + **幻读靠 next-key 锁部分抑制**（当前读+范围锁才防得住，"快照读看不到幻影，但 `UPDATE` 会影响幻影行"） | 死锁概率高、锁范围大 |
| SERIALIZABLE | 快照读自动转 `FOR SHARE` | 只在"必须有顺序可串行化"的模块用 |

### 1.5 DDL 变更与 online 日志
- `ALTER TABLE ... ALGORITHM=INSTANT`（8.0.12 仅末列；8.0.29+ 任意位置加/删列，row version 上限 **64**，到顶显式 INSTANT 报 `ERROR 4080`、未指定则**静默退化为 `INPLACE` 重建**；`OPTIMIZE TABLE`/重建/`TRUNCATE` 会把 `information_schema.INNODB_TABLES.TOTAL_ROW_VERSIONS` 清零；FTS 索引/`ROW_FORMAT=COMPRESSED`/临时表不支持）。
- `INPLACE + LOCK=NONE`：DML 与 DDL 并行，期间的改动写进 **online alter log**（`innodb_online_alter_log_max_size`，默认 128MB）；溢出报 `ER_INNODB_ONLINE_LOG_TOO_BIG (1799)` → 高写入表要么窗口期停写、要么用 `gh-ost`（订阅 binlog）/`pt-osc`（触发器）。
- 并行建索引：8.0.27+ 的 `innodb_ddl_threads`（并行排序/构建）+ `innodb_ddl_buffer_size`（所有线程共享）+ `innodb_parallel_read_threads`（并行读框架）。**社区版没有通用并行 SELECT 执行**：`innodb_parallel_read_threads` 服务的是在线 DDL、`CHECK TABLE` 这类全表扫描路径（8.4 把默认值改成"逻辑 CPU/8，最小 4"）。把"MySQL 8 支持并行查询"当卖点回答 = 错。
- 加索引顺序：`ALTER TABLE t ADD COLUMN x INT, ADD INDEX ix(x)` 在同一条语句里会**因为需要重建而失去 INSTANT**；正解是"先 INSTANT 加列，再单独 `INPLACE` 建索引"。

---

## 2. senior / principal 会被追问什么
1. RR 事务里"我 `SELECT` 到 v1，`UPDATE ... WHERE v=1` 却影响 0 行"——给出机制解释与复现步骤（当前读 vs 快照读）。
2. 一条 `UPDATE` 没走索引会锁多少？为什么说"锁全表"其实不准确（逐行 next-key，且扫描过的行在 RC 下会**提前释放**（semi-consistent read），RR 下不释放）。
3. 死锁日志怎么读：`RECORD LOCK ... index PRIMARY` / `lock mode X insert intention` / `WAITING FOR THIS LOCK TO BE GRANTED`，并定位到具体语句与索引。
4. 长事务的发现与治理：`trx_started` 阈值告警 + 连接池默认 `autocommit` + "事务里调 RPC"的红线；purge 落后时读 `information_schema.INNODB_METRICS` 中 `name='trx_rse_history_length'` 的 `COUNT`（等价于 `SHOW ENGINE INNODB STATUS` 里的 `History list length`，但可被采集器轮询）——"能查的 counter"与"只能快照看的日志"这层差别本身就是判分点。
5. `SELECT ... FOR UPDATE SKIP LOCKED` 做任务队列：吞吐与饥饿问题、`LIMIT n` 的批量策略、崩溃后的可见性（未 ACK 的行在事务回滚后重新可取）。
6. 为什么"加索引前先 `ANALYZE TABLE`"不一定有效，但"大表加索引前先看 `INNODB_TABLESTATS`/磁盘/缓冲池命中率"是必须的；给出 DDL 前的检查清单（表大小、写入 TPS、`innodb_online_alter_log_max_size`、从库延迟、MDL 等待）。
7. principal：DB 变更流程治理（`ALGORITHM`/`LOCK` 显式声明为强制规范、MDL 超时下限、灰度先只读库、回滚方案：反向 DDL 不可行时靠备份还是靠影子表）；隔离级别选型的全公司口径与主从一致性证明。

---

## 3. 常见错误答案

| ❌ 说法 | 真相 |
| --- | --- |
| "InnoDB 的行锁是锁主键记录" | 锁的是**索引记录**；走不到索引就会锁很多行/gap；PK 与二级索引两条路径的加锁集合不同 |
| "gap lock 之间会互相阻塞" | gap 锁之间**兼容**（多个事务可锁同一 gap），冲突发生在"想在 gap 里插入" |
| "RR 完全不会幻读" | 快照读看不到幻影，但当前读/`UPDATE` 会碰到新插入的行；只有范围加 next-key 锁才能防住 |
| "`SELECT ... FOR UPDATE` 在 RC 下也会加 gap 锁" | RC（配合 `ROW` binlog）基本不加 gap；这是 RC 死锁更少的核心原因 |
| "回滚事务时锁会自动保持" | 锁在事务结束（提交/回滚）时一次性释放，不存在"逐步释放" |
| "`SELECT COUNT(*)` 会加锁" | 快照读不加锁；`FOR UPDATE`/`LOCK IN SHARE MODE`/SERIALIZABLE 才加 |
| "InnoDB 死锁会回滚等待者" | 回滚**修改量较小**的事务（`trx_weight`），可能正是你先发起的那个 |
| "1213 与 1205 一样处理" | 1205 是锁等待超时（可继续，事务未整体回滚，取决于 `innodb_rollback_on_timeout`）；1213 是死锁，事务被回滚 → 重试语义不同 |
| "`information_schema.INNODB_LOCK_WAITS` 查锁等待" | 8.0 已移除该表，正解 `performance_schema.data_lock_waits` / `sys.innodb_lock_waits` |
| "MySQL 8 有并行查询，`innodb_parallel_read_threads=8` 就能并行 SELECT" | 并行读框架服务 DDL/`CHECK TABLE` 等扫描路径，社区版 SELECT 执行器仍是单线程（HeatWave/云厂商特性不是社区能力） |
| "`OPTIMIZE TABLE` 一定锁表" | 8.0 下 `OPTIMIZE TABLE` 对 InnoDB 走 `ALTER TABLE ... FORCE`，默认 `INPLACE + LOCK=NONE`（online），但需要额外磁盘与 MDL 短暂独占窗口 |
| "`RENAME TABLE` 原子性可以随便用" | `RENAME TABLE a TO b, c TO a` 是原子的（影子表切换正解），但与 DDL/DML 之间存在 MDL 队列风险，切换前必须确认无长事务 |
| "UUID 主键只是空间大一点" | 随机分布 → 页分裂/缓冲池污染/二级索引放大，实测写吞吐可差数倍；正解是有序化 UUID（v7 / 时间前缀）或 `BIGINT AUTO_INCREMENT` + 唯一业务键 |
| "自增列连续无洞" | 回滚、`ON DUPLICATE KEY`、批量预分配都会留洞；`autoinc_lock_mode=2`（8.0 默认）更是有意牺牲连续性换并发 |

---

## 4. 可判分出题角度

`mysql` runner 判锁的关键能力（runner 必须实现）：**多连接并发** + **`SET SESSION innodb_lock_wait_timeout`** + **`@@ERROR/errno` 断言**。判分信号是**错误码与最终数据状态**，完全确定。
标准骨架：连接 A `BEGIN; UPDATE ...`（保持不提交）→ 连接 B 执行候选 SQL → 断言 B 的结果（成功/`1205`/`1213`/阻塞后 A 回滚再成功）。

### 题面草稿 1（`code`，`judgeKind: mysql`，difficulty: senior）
> 基线：MySQL 8.0，`REPEATABLE READ`，`autocommit=0`。给定表与 fixture：
> ```sql
> CREATE TABLE jobs(
>   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
>   kind VARCHAR(32) NOT NULL,
>   state ENUM('PENDING','RUNNING','DONE') NOT NULL,
>   payload VARCHAR(500) NOT NULL,
>   attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
>   KEY idx_state_kind(state, kind)          -- 注意：kind 上没有单独索引
> ) ENGINE=InnoDB;
> -- 3000 行 PENDING，其中 kind='mail' 40 行，'sms' 2960 行
> ```
> 要求只提交 `claim.sql`：安全地"认领至多 10 个 `kind='mail'` 的 PENDING 任务"，使得
> 1. 并发执行 `claim.sql` 的两个连接**互不阻塞、不取到同一行、不产生死锁**；
> 2. 认领后 `state='RUNNING'`、`attempts+1`，且**同一语句内**返回被认领的 `id` 列表（提示：MySQL 没有 `UPDATE ... RETURNING`，必须用"变量/临时表/事务内二次 SELECT"的组合，且要保证两次之间不被别的连接取走）；
> 3. 不得使用 `LOCK TABLES`、不得 `SLEEP()`、不得依赖 `LIMIT 10` 之外的行序假设；
> 4. 必须给出你实际用的索引（在提交文件里以 `SELECT 'index_used' tag, ... ` 形式返回 `EXPLAIN` 的 `key` 与 `type`）。
> 判分：结果集正确 + 两连接并发下 `SUM(state='RUNNING')=20`、无重叠 id、无 `1213/1205` 错误码 + `EXPLAIN` 断言（`key='idx_state_kind'`、`type='range'` 或 `'ref'`）。

**用例设计（≥4，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `single_claim` | 单连接：返回恰好 10 个 `id`、`RUNNING` 计数 10 |
| `two_concurrent_no_overlap` | 两个 runner 连接同时执行：两组 `id` 交集为空、总 `RUNNING=20`、错误码为 0（打 `FOR UPDATE` 不带 `SKIP LOCKED` 的阻塞/死锁写法） |
| `explain_index` | 提交文件里返回的 `key/type` 与题目侧独立跑的 `EXPLAIN` 一致（防"靠 `FORCE INDEX` 蒙过断言但实际扫 `sms` 全量"） |
| `attempts_increment_atomic` | 认领前后 `attempts` 恰 +1（防"先 SELECT 再 UPDATE"的两步实现导致重复 +2） |
| 边界：`PENDING` 只剩 3 行 | 返回 3 行，不报错、不认领别人的 `RUNNING` |
| 边界：`kind='mail'` 全无 PENDING | 返回空结果集且**不抛异常**，且不留下任何锁（题目侧随后 `INSERT` 同 kind 新行必须不被阻塞 → 打 gap 锁洪水） |

### 题面草稿 2（`code`，`judgeKind: mysql`，difficulty: principal）
> 给一张表 `accounts(id INT PK, balance BIGINT NOT NULL, KEY idx_balance(balance))`，fixture 5 行。提交 `transfer.sql` 实现"从 `from_id` 转 `amount` 到 `to_id`"，要求：
> 1. 全程**只用一条 `UPDATE` 语句 + 事务**（不允许先读后写），并且**任意两个反向转账并发时不死锁**（提示：加锁顺序必须与参数顺序无关，可用"按 `id` 升序取锁"实现）；
> 2. 余额不足时**必须**返回 `'INSUFFICIENT'` 且不产生部分修改（用 `SELECT 'INSUFFICIENT'` 的结果集表达，不允许抛信号后仍改了余额）；
> 3. `amount <= 0` 或 `from_id = to_id` → 返回 `'INVALID'`；
> 4. 提交里必须包含"证明不会留下脏数据"的语句：转账后 `SELECT SUM(balance)`（守恒断言）；
> 5. 用 `performance_schema.data_lock_waits`（或 `sys.innodb_lock_waits`）证明你的实现不出现锁等待链（题目侧提供该查询模板，候选人填空）。
> 判分：串并行两组用例的结果集 + 错误码 + 守恒断言。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `happy_path` | 两条 `SELECT` 结果集：`'OK'` 与守恒的 `SUM(balance)` |
| `reverse_concurrent_no_deadlock` | `A:1→2` 与 `B:2→1` 同时跑：两者都成功或一个成功一个 `INSUFFICIENT`，**禁止出现 errno 1213**（打"按参数顺序加锁"的实现） |
| `insufficient_atomicity` | 余额不足：`'INSUFFICIENT'` 且双方余额与执行前逐字节一致 |
| `invalid_args` | `amount=0/-5`、`from_id=to_id` → `'INVALID'`，且 `balance` 不变 |
| `no_lock_table` | 提交文本含 `LOCK TABLES` → 直接判负（静态检查语句 + 执行期 `metadata_locks` 断言） |
| 边界：`balance` 溢出 | `balance=9e18` 时加/减不得翻负（`BIGINT` 溢出会报 `WARN_DATAOutOfRange`/errno 1690，要求显式处理为 `'OVERFLOW'`） |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 现场：某 8.0 → 8.4 升级后，一条长期存在的 `ALTER TABLE ... ADD COLUMN` 从 0.2 秒变成 40 分钟并造成 MDL 队列雪崩；同时监控显示 `Handler_read_rnd_next` 在业务低峰异常升高。要求：给出根因链（至少 3 条独立原因，必须包含 8.4 默认值变化）、每条的验证证据（精确到视图/计数器/日志段）、修复与回滚、以及 DDL 变更规范的改动点。

**points**：row version 64 上限导致 INSTANT 静默退化为 INPLACE（含 `TOTAL_ROW_VERSIONS` 查询与 `ERROR 4080` 语义）3；8.4 默认值影响面（`innodb_change_buffering=none`、`innodb_adaptive_hash_index=OFF`、`innodb_io_capacity=10000`、`innodb_purge_threads` 动态、`innodb_parallel_read_threads` 计算式）3；MDL 雪崩机理与 `performance_schema.metadata_locks` instrument 开启 2；验证证据的可执行命令 1；规范改动（强制 `ALGORITHM`/`LOCK` 显式 + 变更前列 `TOTAL_ROW_VERSIONS`/表大小/写入 TPS）1。
**bonus**：提到"重建会清零 row version"，因此治理动作是 `OPTIMIZE TABLE`（评估磁盘与在线性）；提到 `information_schema.PROCESSLIST` 在 8.4 弃用后的观测替换；提到 online alter log 溢出（1799）与 `gh-ost` 的取舍。
**gaps**：把原因归为"8.4 变慢"；建议 `SET SESSION lock_wait_timeout=0`（无效）；不知道 INSTANT 有静默退化行为；用 5.7 的 `INNODB_LOCKS` 视图。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| MVCC/当前读/隔离级别的生产后果 | `APL-BE-3`、`ABNB-BE-2` |
| 锁与死锁的定位、并发交错证明 | `APL-BE-1`、`ABNB-BE-2` |
| 索引与页结构的空间/写放大预算 | `APL-BE-2`、`APL-BD-2` |
| DDL 变更安全与 8.4 默认值差异 | `ABNB-BE-2`、`APL-BE-1` |
