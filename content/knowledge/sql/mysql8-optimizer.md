# MySQL 8.x 优化器、执行计划与查询改写

适用：MySQL 8.0.x（判题容器基线）+ 8.4 LTS 口径对比。判分：`mysql`（结果集 + `EXPLAIN` 字段 + 会话状态 delta）、`llm-rubric`。

---

## 1. 核心机制

### 1.1 优化器在做的事：枚举 → 估计 → 选择
1. **改写**：常量折叠、`IN` 列表化、外连接消除、视图/派生表合并（`derived_merge`）、子查询去关联化（semi-join / 派生表）、`ORDER BY`/`GROUP BY` 的索引可用性判定、覆盖索引检测。8.4 放宽了"标量相关子查询去关联化"的限制（内层允许引用确定性表达式内列）。
2. **估计**：`rows` 来自索引统计（`innodb_stats_persistent`，采样页由 `innodb_stats_persistent_sample_pages` 决定；`innodb_stats_transient_sample_pages` 用于 `stats_persistent=0` 的表）。二级索引统计存在 `mysql.innodb_index_stats` / `information_schema.INNODB_INDEX_STATS`? （盘点请查 `mysql.innodb_*_stats`，8.4 移除的是 `information_schema.TABLESPACES`）。**估算是采样结果**，所以：数据倾斜 → 估歪；刚导入大批数据 → 统计过期（`STATS_AUTO_RECALC=1` 会在约 10% 行变更后异步重算，但"异步"意味着你 `EXPLAIN` 时可能还是旧的）。
3. **选择**：`blocks/ranges/cost` 组合，受 `optimizer_switch`（`hash_join`、`derived_merge`、`index_merge`、`semijoin`、`materialization`、`loosescan`、`firstmatch`、`duplicateweedout`、`subquery_materialization_cost_based`，8.4 新增/默认开的 `hash_set_operations`）与 `optimizer_cost_constants`（`row_lookup_cost`、`block_read_cost`、`key_compare_cost`）影响。生产里**禁用优化器提示滥用**：`FORCE INDEX` 是止血，不是治疗（它会让统计更新后计划被永久锁死）。

### 1.2 `EXPLAIN` 字段的真实读法
| 字段 | senior 读法 |
| --- | --- |
| `type` | `const`/`system`（PK 唯一等值）→ `eq_ref`（join 命中唯一索引，每次外表行最多 1 行，**这是 join 的理想形态**）→ `ref` → `range` → `index`（全索引扫，比 `ALL` 只省排序/回表一点点）→ `ALL`。`index_merge` 常见于 `OR`，但 `intersect` 比 `sort-union` 好得多 |
| `key` / `key_len` | `key_len` 能算出"实际用了几列"（`int`=4、`bigint`=8、`varchar(n) utf8mb4`= `4n+2`、可空 `+1`），是"最左前缀用到底没有"的**唯一硬证据** |
| `rows` × `filtered` | 乘积才是传给上一层的行数；`filtered=10` 意味着优化器认为还有 90% 被 `WHERE` 里未走索引的条件丢掉 |
| `Extra` | `Using index`（覆盖索引，无回表）；`Using index condition`（ICP，在索引层过滤减少回表）；`Using MRR`；`Using temporary`+`Using filesort`（分组与排序不同序，必然物化）；`Using join buffer (hash join)`（8.0.18+，取代 `BNL`）；`Start/End`（range）；`Using where; Using index`（覆盖 + 回表前过滤，注意 `Using index` 里的 `Using where` 是在索引记录上过滤） |
| `EXPLAIN FORMAT=JSON` | 看 `cost_info`（`query_cost`、`read_cost`、`eval_cost`、`prefix_cost`）与 `attached_condition`、`materialized_from_subquery`；8.4 有 `explain_json_format_version`（1=线性、2=按访问路径），**同一 SQL 两版本 JSON 结构不同**，判分脚本必须钉版本 |
| `EXPLAIN ANALYZE`（8.0.18+） | `actual time=first..avg..max rows=N loops=M` —— **`loops` 是嵌套执行次数**：内层 `rows=1 loops=5000` 是 5000 行，不是 1 行；支持范围是 `SELECT`、**多表** `UPDATE`/`DELETE`、`TABLE` 语句（`TABLE` 自 8.0.19），**单表 `UPDATE` 不行**，也不能配 `FOR CONNECTION`；输出恒为 `TREE`（8.0.21+ 可显式 `FORMAT=TREE`，写 `FORMAT=JSON` 必报错）；它会**真实执行**语句（`KILL QUERY`/Ctrl-C 可中止）→ 生产上对写语句慎用 |
| `EXPLAIN` 语法本身 | `format_name: {TRADITIONAL \| JSON \| TREE}`（8.0 与 8.4 一致）；`EXPLAIN FOR CONNECTION <id>`、`EXPLAIN EXTENDED` 已无意义；8.4 增加 `explain_json_format_version`、`FORMAT=JSON INTO @var`、`FOR SCHEMA` |
| `optimizer_trace` | `SET optimizer_trace='enabled=on'; ... SELECT * FROM information_schema.OPTIMIZER_TRACE;` 才能看到"为什么否决了另一个计划"（`considered_execution_plans`、`clustered_index_for_range`、`rows_estimation`）；`last_query_cost`/`last_query_partial_plans` 是快速信号 |

### 1.3 join 算法与半连接策略
- 内连接：驱动表选择（小结果集 + 被驱动表有可用索引）；`hash join` 让"无索引的大表等值 join"从 `BNL` 的 O(N×M) 内存扫变成建 probes 桶的 O(N+M)（`join_buffer_size` 不够会**多次重扫**外表 → `EXPLAIN ANALYZE` 里表现为 `loops>1`）。
- 半连接（`IN (SELECT ...)`）五策略：`DuplicateWeedout`（默认兜底）、`FirstMatch`、`LooseScan`（要求松散索引扫，join 列是索引前缀）、`MaterializedLookup`、`MaterializedScan`。手写 `EXISTS` 与 `IN` 在 8.0 下**多半被转成同一策略**（"改 `IN` 为 `EXISTS` 就变快"是过时经验），真正有效的是让被驱动列有索引 + 消除 `DISTINCT` 需求。
- 反连接：`NOT IN` **在子查询可能返回 `NULL` 时结果为空**（三值逻辑），`NOT EXISTS` / `LEFT JOIN ... IS NULL` 才是安全写法；8.0.31+ 可用 `EXCEPT`（8.4 走 `hash_set_operations`）表达，可读且语义无 `NULL` 陷阱。
- `LATERAL`（8.0.14）：每行外表做一次"相关派生表"，配合 `LIMIT 1` 是 Top-1 per group 的高效写法（对比窗口函数版：`LATERAL` 在有合适索引时避免全量排序）。

### 1.4 索引失效与排序的硬规则
```sql
-- 全都用不上 idx_created 或根本无索引
WHERE DATE(created_at) = '2026-09-19'                -- 列被函数包裹 → 改 created_at >= '2026-09-19' AND < '2026-09-20'
WHERE code = 12345                                   -- code 是 utf8mb4 varchar：列侧被转 double，索引废（数字字符串常量比较规则）
WHERE name COLLATE utf8mb4_general_ci = 'x'          -- 与索引 collation 不一致 → 无法用索引（JOIN 两侧同理）
WHERE a = 1 OR b = 2                                  -- a、b 各有索引时走 index_merge，否则全表；改成 UNION ALL 常更快
WHERE tags LIKE '%red%'                               -- 前置通配；8.0 无原生 trigram：函数索引/全文索引/生成列/外部索引
ORDER BY created_at DESC, id ASC                      -- 需要降序索引（8.0 支持）才能消除 filesort，5.7 的"反向扫"技巧在这里失效
WHERE (a,b) IN ((1,2),(3,4))                          -- 行构造器 IN 的 range 优化在部分版本不如拆 OR；必须实测
```
- 前缀索引 `INDEX(col(12))` 的选择率要算：`SELECT COUNT(DISTINCT LEFT(col,12))/COUNT(DISTINCT col)`；前缀索引**不能覆盖索引、不能用于 ORDER BY 消除排序**。
- 函数索引（8.0.13）`INDEX ((UPPER(email)))` 与"虚拟生成列 + 索引"等价，但生成列可被统计信息感知、可写进 `SELECT` 列表、可读性更好 → 生产首选生成列。
- `INVISIBLE` 索引（8.0）是"安全下线索引"的唯一手段：`ALTER TABLE t ALTER INDEX i INVISIBLE;` 观察一周再删；**主键与支撑唯一约束的索引不能隐藏**。

### 1.5 深分页与写路径
```sql
-- 反例：扫描 500,000 行后丢弃
SELECT * FROM orders WHERE status='PAID' ORDER BY created_at DESC, id DESC LIMIT 500000, 20;
-- 解 1：游标（对外 API 唯一正解；不可跳页）
... WHERE (created_at, id) < ('2026-09-01 10:00:00', 887123) ORDER BY created_at DESC, id DESC LIMIT 20;   -- 行构造器比较，需 idx(status,created_at,id)
-- 解 2：延迟关联（要跳页时的妥协：先在覆盖索引上分页拿 PK，再回表）
SELECT o.* FROM orders o JOIN (SELECT id FROM orders WHERE status='PAID' ORDER BY created_at DESC, id DESC LIMIT 500000,20) x ON x.id=o.id;
```
- 游标分页要求排序键**唯一**（`created_at` 会并列 → 必须带 `id` 兜底），否则翻页会重复/丢行；这是最常见的可判分 bug。
- `SQL_CALC_FOUND_ROWS` 已弃用（8.0.17），总数用 `COUNT(*) OVER()` 或单独的计数查询 + 缓存。
- 写路径：`INSERT ... ON DUPLICATE KEY UPDATE` 的 `affected_rows`（0=无变化、1=插入、2=更新）与自增空洞；`REPLACE INTO` 是 `DELETE+INSERT`（触发器、外键、自增都受影响）；批量插入受 `innodb_buffer_pool` 与 redo 能力约束，8.4 的 `innodb_io_capacity` 默认从 200 提到 **10000** → "同一份压测脚本在 8.0 与 8.4 上表现不同"是真实的口径变化。

### 1.6 用会话状态证明"确实少扫了"（可判分且不依赖墙钟）
```sql
FLUSH STATUS;                         -- 重置当前会话的状态计数器（5.5 起只影响本会话，不需要全库 RELOAD 语义）
SELECT ...;                           -- 候选人 SQL
SHOW SESSION STATUS WHERE Variable_name IN
  ('Handler_read_key','Handler_read_next','Handler_read_rnd_next','Handler_read_last',
   'Sort_rows','Sort_scan','Sort_merge_passes','Select_full_join','Select_range_check');
```
| 计数器 | 含义 | 断言用法 |
| --- | --- | --- |
| `Handler_read_rnd_next` | 全表/临时表顺序读行数 | 改写前后应下降若干数量级（对"消除全表扫"极敏感） |
| `Handler_read_next` | 索引顺序读（含范围） | 走对索引时它代替 `rnd_next` |
| `Handler_read_key` | 按 key 定位次数（回表/等值） | 与 `rows` 相乘可判断是否被循环驱动 |
| `Sort_rows`/`Sort_merge_passes` | filesort 行数 / 归并趟数（>1 说明 `sort_buffer_size` 不够） | 消除排序的题用 `Sort_rows=0` 判分 |
| `Select_full_join` | 没有 join 条件的语句数 | 反例护栏 |

---

## 2. senior / principal 会被追问什么
1. 同一条 SQL 昨天走索引今天走全表，给出**三类根因**与各自的确认证据（统计漂移/参数嗅探式的值域偏斜/数据分布随时间变化 + `optimizer_trace` 对比）。
2. `LIMIT n` 为什么有时让优化器换一个更差的整体计划（因为它按"取到 n 行为止"估代价 → 选了"顺序扫直到命中 n 行"的路径，平均值好但 P99 崩）？如何治理（`optimizer_adjust_different_cost_estimates`? 无此项 → 正解是改成游标或分层缓存，以及 `max_execution_time`）。
3. 覆盖索引与回表的成本平衡：什么情况下"多加两列进索引"反而更慢（写放大、缓冲池污染、`key_len` 变长导致每页索引条目减少）。
4. `EXPLAIN ANALYZE` 为什么不支持**单表** `UPDATE`（只有多表 `UPDATE`/`DELETE` 可以）？要评估一条 `UPDATE` 的真实扫描代价怎么办（把等价条件写成 `SELECT ... FOR UPDATE` 跑 `EXPLAIN ANALYZE`，或在事务里执行后回滚并读 `Handler_*` delta —— 回滚不会把已扫描行数扣回去，那正是你要的证据）。
5. collation 不一致导致 join 不走索引时，四种解（改列、改会话 `SET collation_connection`、表达式两侧一致、SQL 层用 `COLLATE` 但会失索引）分别的代价与风险。
6. 如何给一个 30 亿行的表加索引而不打爆主从延迟（分批 `ALTER`/`gh-ost`/`innodb_ddl_threads`+`innodb_parallel_read_threads`（8.0.27+，用于**并行建索引**而非并行 SELECT）、`innodb_ddl_buffer_size`、以及 DDL 期间的 online row log 上限）。
7. principal：查询层的**回归防线**——把"关键 SQL 的计划指纹 + Handler 计数阈值"写进 CI（每周对生产快照库跑 `EXPLAIN`，漂移即告警）；给出 `optimizer_switch`/`FORCE INDEX` 的变更治理流程与回滚。

---

## 3. 常见错误答案

| ❌ 说法/做法 | 真相 |
| --- | --- |
| "`EXPLAIN` 的 `rows` 是精确值" | 采样估算；`rows × filtered` 才勉强算"输出行数" |
| "`EXPLAIN ANALYZE` 里 `rows=1 loops=5000` 表示扫了 1 行" | 总量是 5000；`loops` 常被完全忽略 |
| "`type=index` 比 `ALL` 好很多，可以接受" | 全索引扫仍需读完整棵 B+ 树叶子层并回表，只是免排序/免随机 IO；`Extra: Using index` 才是真便宜 |
| "把 `IN (SELECT)` 改成 `EXISTS` 一定更快" | 8.0 会做 semi-join 转换，多数情况下二者同策略；真正决定的是索引与策略选择 |
| "`NOT IN` 和 `NOT EXISTS` 等价" | 子查询含 `NULL` 时 `NOT IN` 结果为空（三值逻辑），这是数据"莫名变少"的头号来源 |
| "`LEFT JOIN` 的右表条件放 `WHERE` 里也一样" | 会过滤掉 `NULL` 补齐行 → 外连接被降级成内连接；条件必须放 `ON`（或 `WHERE t.id IS OR ...`） |
| "加索引一定能加速" | 低选择率列加索引可能让"索引 + 回表"比全表顺序扫更慢，优化器会直接不用它（`EXPLAIN` 里 `rows` 估计高） |
| "`FORCE INDEX` 是稳定的" | 统计变化/数据迁移后它把计划锁死，是事故放大器；只作为临时止血并加到期注释 |
| "索引越多越好，写入反正异步" | 每个二级索引都是一次 B+ 树维护 + 缓冲池占用；`innodb_change_buffering` 在 8.4 默认 `none`，"二级索引写被合并缓冲"的老经验不再成立 |
| "`ORDER BY LIMIT n` 一定用优先队列所以很快" | 仍需先取出全部候选行；只有排序前能按索引顺序取时才真正省 |
| "`utf8mb4_general_ci` 和 `utf8mb4_0900_ai_ci` 只是算法版本差别" | 排序/等价值集合不同（如 `ß`、带重音字母、CJK 扩展），跨 collation 比较失索引、唯一约束冲突判定也不同 → 迁移时必须实测冲突 |
| "分区表能加速一切大表查询" | 只在查询条件能裁剪分区时有效；带分区键之外的唯一约束需要包含分区列，索引局部性带来新坑 |
| "`SELECT COUNT(*) FROM t` 一定很慢" | InnoDB 无保存计数（MVCC 决定），但"空表/只查 `Innodb_rows_read`/`information_schema.TABLES.TABLE_ROWS`（估算）"各有精度取舍，说清口径才算答对 |

---

## 4. 可判分出题角度（`mysql` runner 设计）

固定骨架：`00_schema.sql`（建表 + 索引）→ `10_fixture.sql`（**确定性**数据，禁 `NOW()`，日期用字面量）→ `20_answer.sql`（候选人提交，最后 `SELECT` 出结果集）→ `30_check.sql`（题目侧断言查询）。
判分点可以有三层，全部确定性：
1. 结果集精确匹配（含全序 `ORDER BY`）；
2. 计划字段：`EXPLAIN FORMAT=JSON` 里 `access_type ∈ {eq_ref, ref, range}`、`key = 'idx_x'`、`using_index=true`、无 `using_temporary_table`；
3. 代价证据：`Handler_read_rnd_next <= K`、`Sort_rows = 0`。
`EXPLAIN ANALYZE` 的 `estimated_instruction_time`/`actual time` **不作为判分依据**（容器噪声），只作为 `rubric` 的讨论材料。

### 题面草稿 1（`code`，`judgeKind: mysql`，difficulty: senior）
> 基线：MySQL 8.0，`SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;`。
> 给定（fixture 已在题面提供，共 5 万行 + 1 张 5000 行小表）：
> ```sql
> CREATE TABLE orders(
>   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
>   user_id BIGINT UNSIGNED NOT NULL,
>   status ENUM('NEW','PAID','SHIPPED','CANCELED') NOT NULL,
>   created_at DATETIME NOT NULL,
>   amount_cents INT UNSIGNED NOT NULL,
>   KEY idx_created(created_at)
> ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
> CREATE TABLE users(id BIGINT UNSIGNED PRIMARY KEY, code VARCHAR(32) NOT NULL, tier TINYINT NOT NULL)
> ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;   -- 故意与 orders 不同 collation
> ```
> 原始慢查询：
> ```sql
> SELECT o.id, u.code, SUM(o.amount_cents) s
> FROM orders o JOIN users u ON u.id = o.user_id
> WHERE o.status='PAID' AND DATE(o.created_at) BETWEEN '2026-01-01' AND '2026-03-31'
> GROUP BY o.id, u.code ORDER BY s DESC LIMIT 20;
> ```
> 要求只提交一个文件：(a) 建**必要且最少**的索引（可修改/删除已有索引，但不得删主键）；(b) 改写后的查询（**输出与原查询逐行一致**，包括并列值时的顺序——原查询 `ORDER BY s DESC` 存在并列，你必须自己定义决定性次序并保证结果与原查询在"给定的 fixture 数据上"完全相同）；(c) 修掉 collation 混用问题，且**不得**在 join 条件上写 `COLLATE` 导致失索引。
> 判分：结果集一致 → 计划必须为 `o` 侧 `range` 命中你新建的索引、`u` 侧 `eq_ref` → `Handler_read_rnd_next = 0` 且 `Sort_rows <= 40`（排序行数上界）→ 不允许出现 `Using temporary`。

**用例设计（≥4，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `plan_meets_bar` | `EXPLAIN FORMAT=JSON`：orders 层 `access_type='range'` 且 `key` 为候选人新建索引、`using_index=true`；users 层 `access_type='eq_ref'`；`Extra` 不含 `Using temporary` |
| `no_full_scan` | `SHOW SESSION STATUS` delta：`Handler_read_rnd_next = 0` |
| `sort_budget` | `Sort_rows <= 40`（证明"只排前 20"的优先队列生效，而不是聚合完全部再排） |
| `result_identical` | 与题目侧参考查询逐行比对（含 `LIMIT 20` 的并列处理约定） |
| `collation_fixed` | 断言 `SHOW COLLATION`/`information_schema.COLUMNS` 里 `users.code` 的 collation 已被统一，且候选人没在 `ON` 条件里写 `COLLATE` |
| 边界：`amount_cents` 全为 0 的并列组 | 结果稳定且第二次执行完全一致（防止候选人依赖不稳定序蒙对） |

### 题面草稿 2（`code`，`judgeKind: mysql`，difficulty: principal）
> 表 `events(id BIGINT PK, tenant_id INT, name VARCHAR(64), ts DATETIME(3), props JSON, KEY idx_tenant_ts(tenant_id, ts))`，`n=30 万`，单租户占 92% 行。
> 要求实现"分页 API 的取数 SQL"：按 `tenant_id + name` 过滤，`ts DESC` 排序，游标分页（游标是不透明字符串 `base64(ts|id)`，由候选人自己编解码为 SQL 参数），并支持：
> 1. 首页（无游标）与任意后续页；页大小固定 50；
> 2. **不出现 `Handler_read_rnd_next`**、`rows` 估计 ≤ 200、单次执行的 `Handler_read_key ≤ 51`（证明是"一次定位 + 顺序读 50 行"而不是每行一次主键查）；
> 3. 若需要按 `name` 精确匹配且 `name` 的选择率很高，允许新增一个索引，但**必须给出 `key_len` 证据**（题面要求把 `key_len` 作为结果集的最后一列输出，公式写错的人会被判负）；
> 4. `props` 里的 `$.channel` 需要作为过滤条件（可选参数：为 `NULL` 时不过滤），要求给出**两种**实现（函数索引版与虚拟生成列版）且都通过用例。
> 边界：游标里的 `ts` 落在数据中间、游标 `id` 不存在、`name` 含单引号与全角字符、`tenant_id` 是那个 92% 的大租户（考察"数据倾斜下游标是否仍有效"）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `page_walk_no_overlap` | 连续翻 8 页：并集无重复、无遗漏、顺序全局单调（这是游标实现的对拍不变式） |
| `no_row_lookup_storm` | `Handler_read_key <= 51` 且 `Handler_read_next <= 55`（打"每行回表一次"的写法） |
| `key_len_evidence` | 输出列 `key_len` 与期望值相等：`tenant_id INT` = 4 字节、`ts DATETIME(3)` = 5 字节 + 小数秒 2 字节 = 7，两列均 `NOT NULL` → 完整命中时 `key_len = 11`（题目侧另用 `EXPLAIN` 实测生成期望值，考察候选人是否真懂 `key_len` 组成：`varchar(n)` 是 `4n+2`、可空再 `+1`） |
| `channel_optional_both_impls` | 传/不传 `channel` 两组用例在"函数索引版"和"生成列版"两个方案下都走索引（断言 `key` 命中对应索引，而非 `idx_tenant_ts`） |
| `skew_tenant` | 大租户首页 `rows` 估计 ≤ 200（低选择率的 `tenant_id` 前缀不能成为主驱动） |
| 边界：末页不足 50 行 / 空结果 | 返回 0 行且 `next_cursor` 为 `NULL`（约定不得抛错） |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：一条 `UPDATE ... WHERE status='NEW' LIMIT 1000` 在主库跑 40 分钟并让从库延迟 20 分钟。给出根因分析（至少 4 个独立原因）、可采集的证据（精确到查询/视图/计数器名）、修复方案（含变更流程与回滚）、以及"以后如何在 CI 里拦住这类语句"。

**points**：锁与索引（无索引 → 逐行 next-key 锁 + 全表扫描路径）3；`LIMIT` 更新与主从延迟（statement vs row、单事务大变更）2；证据采集精确性（`performance_schema.threads`/`events_statements_summary_by_digest`/`data_lock_waits`/`SHOW ENGINE INNODB STATUS`、8.4 弃用 `I_S.PROCESSLIST` 的口径）3；分批/游标推进与 `max_execution_time` 兜底 1；CI 拦截规则（`gh-ost`/`EXPLAIN` 门禁、禁止无 `WHERE` 索引覆盖的大 `UPDATE`）1。
**bonus**：提到 `innodb_ddl_threads`/`innodb_parallel_read_threads` 只服务 DDL/`CHECK TABLE` 而非并行 SELECT；给出"8.4 `innodb_io_capacity` 默认 10000 会让同样的批量写表现不同"的对比；提到大事务导致 `history list length` 上涨与 purge 滞后。
**gaps**：结论是"加个索引就好"；用 `KILL` 当作方案；建议 `CREATE INDEX` 前不检查 `ALGORITHM`；不知道从库延迟与 `binlog_format` 的关系。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 代价模型/统计/`EXPLAIN` 与 `optimizer_trace` | `APL-BE-2`、`APL-BE-3` |
| 查询改写的语义陷阱（`NOT IN`/外连接降级/collation） | `APL-BE-2`、`ABNB-BE-2` |
| 深分页与 API 契约 | `ABNB-DATA-1`、`APL-BE-2` |
| 用计数器做可复现的性能证据 + CI 门禁 | `ABNB-BE-2`、`APL-BD-1` |
