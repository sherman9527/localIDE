# MySQL 8.4 LTS、复制与可观测性（8.0 → 8.4 的破坏性变化）

适用口径：**8.0.x = 判题容器实际基线**（apt 安装的发行版版本），**8.4 LTS = 生产叙事基线**（2024-04-30 发布；LTS/Innovation 双轨下的第一个 LTS），**8.0 已于 2026-04 前后退出 Oracle 支持**。
因为判题容器不是 8.4，**本文件的"8.4 专有语法/行为"类题目一律出 `llm-rubric`**，或让候选人"给出在 8.0 上可执行的等价写法"（那部分是 `mysql` 可判分的）。出题前必须先在容器里跑：
```sql
SELECT VERSION(), @@character_set_server, @@collation_server, @@sql_mode, @@default_authentication_plugin;
```

---

## 1. 核心机制

### 1.1 8.0 时代就定型、但经常被答成"老版本"的事实
- 认证：`caching_sha2_password` 是 8.0 默认插件 → 老客户端/老驱动连不上时，正确处置是升级客户端或显式 `CREATE USER ... IDENTIFIED WITH mysql_native_password BY ...`（**8.4 已把 `mysql_native_password` 默认关闭**，需要 `--mysql-native-password=ON` 才存在；再往后被移除）→ "顺手关掉安全插件"的建议在 8.4 上是定时炸弹。
- 复制语句改名（8.0.22+ 提供新名）：`CHANGE MASTER TO` → `CHANGE REPLICATION SOURCE TO`、`START/STOP SLAVE` → `START/STOP REPLICA`、`SHOW SLAVE STATUS` → `SHOW REPLICA STATUS`、`MASTER_LOG_POS` → `SOURCE_LOG_POS`、`slave_parallel_workers` → `replica_parallelism`。
- 并行回放：`binlog_transaction_dependency_tracking=WRITESET`（8.0.26 起默认）让"无冲突事务"可并行 apply，是从库延迟的最大单项改善；配合 `replica_parallel_workers`、`replica_preserve_commit_order`。
- `clone` plugin（8.0.17+）替代 `mysqldump`/物理拷贝做 DN 初始化（`CLONE INSTANCE FROM ...`）。
- 半同步：`AFTER_SYNC`（lossless）为默认，`rpl_semi_sync_source_enabled`/`rpl_semi_sync_replica_enabled` 两边都要开，否则静默退化异步。
- binlog：`binlog_row_metadata=MINIMAL|FULL` 决定行事件里是否携带列元数据（下游 CDC 解析器的可维护性关键）；`binlog_rows_query_log_events` 让 binlog 里带上原始 SQL（排查 CDC 事故有用，代价是体积）。
- 资源与会话：`max_execution_time`（只作用于 `SELECT`）、`OPTIONAL` for `SET_VAR`/`JOIN_ORDER`/`NO_ICP`/`SKIP_SCAN` 等优化器提示（`/*+ ... */`）。
- `utf8mb4` + `utf8mb4_0900_ai_ci` 是 8.0 默认（`character_set_server=utf8mb4`），`NO_ZERO_DATE`/`STRICT_TRANS_TABLES` 在默认 `sql_mode` 里。
- 临时表：`internal_tmp_mem_storage_engine`（`TempTable`）、`temptable_max_ram`；`CREATE TEMPORARY TABLE` 与 GTID 的坑（GTID 模式下 `CREATE TABLE ... SELECT`、`CREATE TEMPORARY TABLE` 在 `mysql` 库下会被拒）。

### 1.2 8.4 的破坏性变化（务必按类别记）
| 类别 | 变化 | 失败表现 |
| --- | --- | --- |
| 复制语法 | **移除** `CHANGE MASTER TO`、`START/STOP SLAVE`、`SHOW SLAVE STATUS`、`SHOW MASTER STATUS`、`SHOW SLAVE HOSTS`、`RESET SLAVE`、`PURGE MASTER LOGS`、`SHOW MASTER LOGS`、`RESET MASTER`；`MASTER_*` 选项全部改 `SOURCE_*` | 运维脚本 `ERROR 1064` 语法错误；`mysqldump --output-as-version` 用来导出兼容旧版本的语句 |
| GTID 工具 | `WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS()` **移除** → `WAIT_FOR_EXECUTED_GTID_SET()` | 迁移校验脚本、"等从库追上"的自动化直接报错 |
| 日志保留 | `expire_logs_days` **移除** → `binlog_expire_logs_seconds` | 配置文件里的旧项导致启动失败或被忽略（取决于 `--validate-config`） |
| GTID 新能力 | **tagged GTID**：`UUID:TAG:NUMBER`，`SET gtid_next='AUTOMATIC:batch_42'` + 新权限 `TRANSACTION_GTID_TAG` | "按批次跳过/重放一组事务"成为官方语义；对账/灰度回滚方案可以不再靠 position |
| 认证 | `mysql_native_password` 默认关闭；WebAuthn（FIDO2）插件 `authentication_webauthn`（`authentication_fido` 移除）；`tls-certificates-enforced-validation` | 旧驱动连不上；证书配置错误从"能启动但 TLS 不可用"变成"启动即失败" |
| 权限细化 | 新增 `FLUSH_PRIVILEGES`、`OPTIMIZE_LOCAL_TABLE`；`SET_USER_ID` 被 `SET_ANY_DEFINER` + `ALLOW_NONEXISTENT_DEFINER` 取代 | 只给 `RELOAD` 的运维账号在 8.4 上做不了某些动作（最小权限治理的正向变化） |
| 工具 | `mysqlpump`、`lz4_decompress`、`zlib_decompress`、`mysql_ssl_rsa_setup`、`mysql_upgrade` **移除** | CI 镜像里的 `mysqlpump` 命令直接找不到；升级不再需要 `mysql_upgrade`（`mysql_upgrade_history` JSON 文件接管版本跟踪） |
| I_S / 观测 | `information_schema.TABLESPACES` 移除（改 `INNODB_TABLESPACES`）；`information_schema.PROCESSLIST` **弃用**（新增状态计数 `Deprecated_use_i_s_processlist_count`）→ 用 `performance_schema.processlist`/`threads` | 盘点脚本与采集器（mysqld_exporter 老版本）拿不到数据或拿到旧数据 |
| 优化器 | `hash_set_operations` 开关（`EXCEPT`/`INTERSECT` 走哈希集合）；标量相关子查询去关联化限制放宽；`explain_json_format_version`（1 线性 / 2 访问路径）、`EXPLAIN FORMAT=JSON INTO @var`、`FOR SCHEMA` | 同一条 SQL 在 8.0 与 8.4 上**计划不同、JSON 结构不同** → 计划断言类判分脚本必须钉版本 |
| 统计 | **直方图自动更新**（随 `ANALYZE TABLE` / 持久统计重算） | "直方图建完再不管"的旧经验失效；数据倾斜治理可自动化 |
| InnoDB 默认值 | `innodb_io_capacity` 200→**10000**、`innodb_log_buffer_size` 16M→**64M**、`innodb_adaptive_hash_index` ON→**OFF**、`innodb_change_buffering` all→**none**、`innodb_purge_threads` 动态（≤16 CPU 为 1，否则 4）、`innodb_parallel_read_threads` = 逻辑 CPU/8（最小 4）、doublewrite 固定 2 files/128 pages | 同一份压测脚本在两个版本上的吞吐/抖动不可直接对比；"AHI 提速""二级索引写有 change buffer 兜底"的结论要按版本重写 |
| Group Replication | `group_replication_consistency` 默认 `BEFORE_ON_PRIMARY_FAILOVER`、`group_replication_exit_state_action` 默认 `OFFLINE_MODE`、支持 8.4 系列内跨小版本组网与原地降级；`group_replication_view_change_uuid` 不再需要 | 从"节点自动关机"变成"离线但进程存活"（可观测行为变化，影响你的运维手册） |
| 约束 | 引用非唯一/前缀键的外键被**弃用**（需要 `restrict_fk_on_non_standard_key=OFF`）；库级授权里的 `%`/`_` 通配被弃用（将来按字面量处理） | 老 schema 升级时报弃用告警；靠 `db LIKE 'app_%'` 授权的账号在未来失权 |

> 另：Innovation 线（9.x）持续演进（官方参考手册已到 9.x），但**生产基线只跟 LTS**；本题库的"版本口径题"标准答案永远是"跟 8.4 LTS，不跟 Innovation"。

### 1.3 复制正确性与延迟的可判分证据
- 追平判定（8.0 可执行、可作为 `code` 判分）：
```sql
-- 主库：写入后拿 GTID
SELECT @@gtid_executed;
-- 从库：等待应用完成（8.4 里 WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS 已不存在）
SELECT WAIT_FOR_EXECUTED_GTID_SET('aaaaaaaa-1-100', 10);      -- 返回 0=追上，1=超时
SHOW REPLICA STATUS\G       -- Seconds_Behind_Source / Replica_SQL_Running / Retrieved/Executed_Gtid_Set
```
- 延迟来源分层：单线程 apply（`replica_parallelism=0`）/ 依赖追踪没开 WRITESET / 大事务（一个 5GB 事务必然造成尖峰）/ DDL（MDL 阻塞 + 拷贝）/ 从库磁盘与 `sync_binlog`+`innodb_flush_log_at_trx_commit` 双 1 组合 / 从库承担读流量。
- 数据一致性核对：`pt-table-checksum`（依赖 statement binlog 或有 GTID 的场景限制）vs 采样 `CHECKSUM TABLE`（受 `innodb_buffer_pool` 与快照影响）vs 列级 `BIT_XOR(CAST(CRC32(CONCAT_WS(...)) AS UNSIGNED))` 分块对账（可判分、确定性，是本题库推荐写法）。
- `SUPER` 拆分（8.0 起 `THROTTLE_ADMIN_LIMIT`/`CONNECTION_ADMIN`/`SYSTEM_VARIABLES_ADMIN`/`REPLICATION_*` 等细粒度权限）与 8.4 的 `FLUSH_PRIVILEGES`/`SET_ANY_DEFINER`：最小权限账号设计是 principal 的常规考点。

### 1.4 可观测性：把"性能问题"变成可查的数据
| 需求 | 正确来源 | 注意 |
| --- | --- | --- |
| 全库最耗时的语句模板 | `performance_schema.events_statements_summary_by_digest`（按 `SUM_TIMER_WAIT`/`QUANTILE_95_TIMER_WAIT` 排；`DIGEST_TEXT` 已参数化） | 需要 `setup_consumers` 里 `events_statements_summary_by_digest` 开启；重启/`TRUNCATE` 会清空；`max_digest_length`/`performance_schema_max_digest_length` 截断长 SQL |
| 全表扫的语句 | `sys.statements_with_full_table_scans` | 依赖 digest 表 |
| 未使用/冗余索引 | `sys.schema_unused_indexes`、`sys.schema_redundant_indexes` | "未使用"不等于"可删"（月度任务、灾备查询），要 `INVISIBLE` 灰度 |
| 锁等待链 | `performance_schema.data_lock_waits` + `data_locks`；`sys.innodb_lock_waits` | 8.0 移除了 `I_S.INNODB_LOCKS`；需开 `transaction` 类 instrument |
| 谁在跑什么 | `performance_schema.processlist`/`threads`（8.4 弃用 `I_S.PROCESSLIST`） | `INFORMATION_SCHEMA.PROCESSLIST` 老实现会"打开每张表" |
| 表/索引体积 | `information_schema.INNODB_TABLESTATS`、`INNODB_TABLESPACES`、`mysql.innodb_index_stats`（8.4 无 `I_S.TABLESPACES`） | `I_S.TABLES.DATA_LENGTH` 是估算且开销高 |
| 缓冲池效率 | `SHOW GLOBAL STATUS` 的 `Innodb_buffer_pool_read_requests` vs `Innodb_buffer_pool_reads`；`INNODB_BUFFER_POOL_STATS` | 命中率要配绝对量看（低 QPS 时命中率会骗人） |
| 等待事件 | `performance_schema.events_waits_summary_global_by_event_name` | 采样开销大时只开需要的 instrument |
| 慢日志 | `long_query_time`、`log_queries_not_using_indexes`（配 `min_examined_row_limit` 防噪音）、`log_slow_extra`（8.0.30+） | 8.4 里 `mysqladmin`/`mysqld` 参数校验更严，配置项名字要对 |
| DDL 进度 | `performance_schema.events_stages_current`（`stage/innodb/alter table ...`）+ `innodb_ddl_threads` | 能回答"还要多久"，是 8.0.27+ 的实操加分项 |

---

## 2. senior / principal 会被追问什么
1. "把 8.0 升到 8.4，你的**检查清单**是什么？"要求逐项：`mysqlpump` 依赖、`mysql_native_password` 账号、`expire_logs_days`、`I_S.TABLESPACES`/`PROCESSLIST` 查询、采集器/Exporter 版本、`EXPLAIN` JSON 结构解析、AHI 与 change buffering 的性能基线重测、GR 的 `exit_state_action` 行为变化、非标准外键与通配授权告警。
2. 升级顺序与回滚：LTS→LTS 直升级？`mysqldump` 逻辑迁移 vs `clone` vs 复制双写切流（蓝绿）；回滚窗口内 binlog 兼容性（8.4 写的行事件 8.0 能否回放）与 GTID 集合分叉处理。
3. 主从延迟尖峰到 600s，你怎么在 15 分钟内定层（binlog 体积、大事务、DDL、`sync_*`、从库 IO）？给出具体 SQL 与状态量。
4. 一致性读：读写分离里"刚写完立刻读到旧数据"的 4 种治理（会话粘性/等 GTID/强制主库/版本号自校验）各自对延迟与主库压力的影响；`WAIT_FOR_EXECUTED_GTID_SET` 的超时降级策略。
5. 备份与 PITR：`xtrabackup`/`clone` 与 8.4 row version 累积的相互作用（备份老版本表空间后再 INSTANT 加列的兼容），`binlog_expire_logs_seconds` 与恢复窗口的关系。
6. 观测开销预算：`performance_schema` 的 `setup_instruments`/`setup_consumers` 该开哪些、`max` 系表大小的估算式、如何证明"采集没把库拖慢"（AB 测试 + `events_waits` 自耗时）。
7. principal：多租户 SaaS 的数据隔离路线（schema-per-tenant vs 行级 `tenant_id` + 前缀索引 vs 分库分表中间件）在 8.4 上的代价（连接数、`table_open_cache`、DD 元数据规模、备份粒度、DDL 数量级），并给出可判分的验证方案（不是 PPT）。

---

## 3. 常见错误答案

| ❌ 说法/做法 | 真相 |
| --- | --- |
| "从库延迟就看 `Seconds_Behind_Source`" | 它是"IO/SQL 线程推算值"，DDL、时钟漂移、空转时会失真；必须结合 `Executed_Gtid_Set` 与 `heartbeat`（`pt-heartbeat`）或 `WAIT_FOR_EXECUTED_GTID_SET` |
| "`RESET MASTER` 用来清 binlog" | 8.4 **已移除**该语句（正解 `RESET BINARY LOGS AND GTIDS`，且会清 GTID 执行集，危险）；把"清理空间"与"重置复制拓扑"混为一谈是事故源 |
| "老驱动连不上就把认证插件永久改成 `mysql_native_password`" | 8.4 默认不提供该插件（需显式开启），未来被移除；正解是升驱动，或用 `caching_sha2_password` + `GET_SOURCE_PUBLIC_KEY`/TLS |
| "`innodb_parallel_read_threads=16` → 分析型 SELECT 会并行加速" | 社区版没有并行 SELECT 执行器；该变量服务于 InnoDB 并行读框架（在线 DDL/`CHECK TABLE` 等）。真并行分析要上 HeatWave/外部引擎 |
| "8.0 默认 `utf8mb4`，所以 `utf8` 列也是安全的" | `utf8` 是 `utf8mb3` 的别名且已弃用；`VARCHAR(255)` 索引长度、`emoji`、以及 collation 混用（`general_ci` vs `0900_ai_ci`）是三件事 |
| "直方图建了就一直有用" | 8.4 起有自动更新路径；不更新时数据倾斜变化会让优化器继续猜错；且直方图**不替代**索引统计，它补的是"非索引列/相关性"的估计 |
| "`I_S.TABLES` 查全库表大小随便跑" | 对大实例是高开销元数据操作（可能打开表）；8.4 弃用 `I_S.PROCESSLIST` 正是同一治理方向；正解用 `INNODB_TABLESTATS`/`mysql.innodb_*_stats` + 缓存 |
| "半同步开了 `rpl_semi_sync_source_enabled` 就安全" | 副本端也要开、`rpl_semi_sync_source_timeout` 会静默退化异步并计数 `Rpl_semi_sync_source_status`；监控必须看这个状态量 |
| "GTID 模式下随便用临时表和 `CREATE TABLE ... SELECT`" | 在 `mysql` 库下、或 `CREATE TEMPORARY TABLE` 在某些复制过滤配置下会被拒/告警；`gtid_next` 与事务边界的约束要背 |
| "升级就是换二进制" | 8.4 移除了 `mysql_upgrade` 这一步（启动时自动升级 DD）但**兼容性检查仍在**：`mysqlsh util check-for-server-upgrade` 才是正解工具 |
| "配置 `expire_logs_days=3` 没报错就行" | 8.4 该变量已移除；配置项被忽略/报错要看启动方式，且 `--validate-config` 才是发现手段 |
| "`mysqlpump` 还能用" | 8.4 移除，CI 里直接 command not found（应转 `mysqldump --output-as-version` 或 MySQL Shell dump 实例） |
| "8.4 里 GR 节点挂了还是会自动关进程" | `group_replication_exit_state_action` 默认改为 `OFFLINE_MODE`（离线但保活），依赖"进程退出触发运维"的老流程会静默失效 |

---

## 4. 可判分出题角度

- **可在 8.0 容器判分**（`mysql`）：复制状态解析（对本地 `performance_schema`/`SHOW REPLICA STATUS` 不可用时，改用"预置 fixture 表 + 对账 SQL"）、`CONCAT_WS + BIT_XOR + CRC32` 分块对账、`WAIT_FOR_EXECUTED_GTID_SET` 语义（单实例上返回 0/1 可测）、digest 表查询与聚合、GTID 集合运算函数 `GTID_SUBSET`/`GTID_SUBTRACT`/`GTID_UNION`（这些在 8.0 单实例上完全可判分，是**被严重低估的出题面**）。
- **只能 `llm-rubric`**：8.4 迁移清单、GR 行为、`RESET BINARY LOGS AND GTIDS`、tagged GTID 运维方案、`performance_schema` 开销预算。

### 题面草稿 1（`code`，`judgeKind: mysql`，difficulty: senior）
> 基线：MySQL 8.0，单实例。给定两张"主/从影子"表（fixture 用同一个 `binlog_file/binlog_pos` 列模拟）：
> ```sql
> CREATE TABLE src_rows(id BIGINT UNSIGNED PRIMARY KEY, tenant INT NOT NULL, a VARCHAR(64), b DECIMAL(12,2), upd_at DATETIME(3) NOT NULL);
> CREATE TABLE dst_rows(同上);
> ```
> 要求提交 `reconcile.sql`，产出三个结果集：
> 1. **分块校验和**：按 `FLOOR(id/1000)` 分块，输出 `(chunk, src_crc, dst_crc, differs)`，校验值用 `BIT_XOR(CAST(CRC32(CONCAT_WS('#', id, COALESCE(a,'<N>'), CAST(b AS CHAR), DATE_FORMAT(upd_at,'%Y%m%d%H%i%s.%f'))) AS UNSIGNED))`，`NULL` 必须显式编码（不得让 `CONCAT_WS` 的 `NULL` 语义造成漏报）；
> 2. **差异定位**：只输出真正不同的行的 `(id, reason)`，`reason ∈ {'missing_in_dst','missing_in_src','value_mismatch'}`；`DECIMAL(12,2)` 的 `1.0` 与 `1.00` 必须视为相同（考察字符串化口径），`DATETIME(3)` 的毫秒必须参与比较；
> 3. **修复语句**：针对差异输出可直接执行的 `REPLACE INTO dst_rows ... SELECT ... FROM src_rows WHERE id IN (...)` 文本（不得输出 `DELETE`，并解释为什么 `REPLACE` 在这里是安全的——`dst_rows` 无二级索引依赖、无外键，且触发器不存在）。
> 判分：三个结果集精确比对 + 第 3 段文本静态检查（不得出现 `DELETE FROM`、不得出现 `TRUNCATE`）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `identical_chunks` | 全一致时 `differs=0` 且第二结果集为空 |
| `null_vs_string` | 一侧 `a=NULL`、另一侧 `a=''` → 必须报 `value_mismatch`（`CONCAT_WS` 跳过 `NULL` 的实现会漏报 → 判负） |
| `decimal_scale` | `b` 为 `1.0`/`1.00` → 不报差异（`CAST(b AS CHAR)` 规范化 + `DECIMAL` 存储口径） |
| `subsecond_diff` | 仅毫秒不同（`10:00:00.123` vs `10:00:00.124`）→ 必须报差异（`DATE_FORMAT` 漏 `%f` 的实现判负） |
| `collation_case` | `a` 仅大小写不同（`'Abc'` vs `'abc'`）→ 在 `utf8mb4_0900_ai_ci` 下 CRC 基于字节，仍应报差异（考"校验和是字节级、比较是 collation 级"这一区分） |
| `fix_statements_only` | 第 3 段文本不含 `DELETE`/`TRUNCATE`，且 `id` 列表与第 2 段完全一致 |

### 题面草稿 2（`code`，`judgeKind: mysql`，difficulty: principal）
> 用 GTID 集合函数做"复制健康判定"的纯 SQL 实现。给定会话变量注入的三段 GTID 集合字符串（`@src_exec`、`@dst_executed`、`@dst_retrieved`），格式如 `'aaaaaaaa-1-50:bbbbbbbb-1-30'`。要求提交 `gtid_health.sql`：
> 1. 用 `GTID_SUBSET(subset, set)` 判断"从库已应用是否为主库已提交子集"；用 `GTID_SUBTRACT(set, add)` 算出**缺失区间集合**；用 `GTID_UNION(set1, set2, delimiter)`（注意第三个参数是必需的分隔符）给出"补齐后集合"（不要求真执行 `PURGE`，只输出字符串）。不变式：正常状态必须满足 `executed ⊆ retrieved`，反之说明从库被外部写入污染（这是 `applied_is_subset_of_executed` 那一行要抓的东西）；
> 2. 输出 `(check_name, pass, evidence)` 三列固定 5 行：`applied_is_subset_of_executed`（正常态必须满足 `executed ⊆ retrieved`；反向意味着从库被外部写入污染）、`lag_gtids_count`（缺失的**事务总数**，需把区间展开计数——必须用 `WITH RECURSIVE` 展开 `a-b` 区间，不得用程序外部处理）、`retrieved_ahead_of_executed`（`executed ⊄ retrieved` 即为真，说明"取回但未应用"的堆积量）、`uuid_mismatch`（两侧 UUID 集合不同）、`holes_in_executed`（同一 UUID 区间不连续，例如 `1-5:7-9`）；
> 3. 输入包含畸形格式（多余冒号、`1-` 结尾、大小写 UUID、空字符串）时**不得抛错**，要把畸形项作为独立 `check_name='malformed_input'` 行输出。
> 判分：结果集精确比对（5+ 行固定顺序）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `normal_lag` | `lag_gtids_count` = 缺失事务数（区间展开正确；只用 `STRING_LENGTH` 数冒号的实现判负） |
| `uuid_split` | 从库有主库没有的 UUID（典型"双写后拆箱"场景）→ `uuid_mismatch` 与 `holes` 同时出现 |
| `holes_detect` | `'aaaaaaaa-1-5:7-9'` → `holes_in_executed=pass=1` 且 evidence 里给出缺的 `6` |
| `malformed_no_exception` | 喂 `'aaaaaaaa-1-'`、`'x:1-2'`、`''`、`'AAAAAAAA-1-2'` → 不抛错，输出 `malformed_input` 行（大小写 UUID 是否规范化要按题面约定） |
| `idempotent_union` | `GTID_SUBSET(GTID_UNION(a,b), b)=1` 的自反性质验证行（防候选人手写字符串拼接导致重复段） |
| 规模边界 | `1-1000000` 单区间：`WITH RECURSIVE` 需要 `SET SESSION cte_max_recursion_depth`（未设 → `ERROR 3636` 判负） |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：把 40 个 8.0 实例（含 6 个跑 Group Replication、12 个被 3 套自研脚本运维、5 个用 `mysqlpump` 备份）升级到 8.4 LTS。要求给出可执行迁移方案：盘点动作（精确到 SQL/命令）、分批与回滚、性能基线重测方法（必须包含 8.4 默认值变化的影响项）、以及"哪些自动化会静默失效"清单。

**points**：盘点动作可执行且覆盖移除项（`RESET MASTER`/`expire_logs_days`/`mysqlpump`/`I_S.TABLESPACES`/`I_S.PROCESSLIST`/`WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS`/`SET_USER_ID`/非标准外键/通配授权）3｜分批与回滚（含 GR 跨小版本组网能力与 `exit_state_action` 行为）3｜性能基线（AHI off、change buffering none、io_capacity 10000、log buffer 64M、parallel_read_threads 计算式；重测方法与判据）2｜静默失效清单（采集器、Exporter、`EXPLAIN` JSON 解析、监控里对 `Seconds_Behind_Source` 的假设）1｜风险与灰度（备份/`clone`、`util check-for-server-upgrade`）1。
**bonus**：提到 `mysql_upgrade` 移除后 DD 升级自动化与 `mysql_upgrade_history`；提出用 `mysqldump --output-as-version` 做跨版本兼容导出；建议先在从库/只读实例上验证 `EXPLAIN` 结构漂移；把 `--validate-config` 纳入 CI。
**gaps**：只写"按官方文档逐步升级"；没有性能重测；忽略 GR 与脚本兼容性；把"关 `mysql_native_password`"说成风险可选项。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 复制正确性、延迟定层与对账 | `APL-BE-1`、`ABNB-BE-2` |
| 版本迁移与破坏性变化盘点 | `ABNB-BE-2`、`APL-BE-1` |
| `performance_schema`/`sys` 观测与开销预算 | `ABNB-BE-2`、`APL-BD-1` |
| 多租户存储与容量治理 | `APL-BE-2`、`APL-BD-2` |
