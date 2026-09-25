# MySQL 8.x 分析型 SQL：窗口函数、CTE、JSON 与确定性输出

适用：MySQL 8.0.x（判题基线，窗口/CTE/JSON_TABLE 全可用）与 8.4 差异标注。判分：`mysql`（结果集逐行比对，是**最适合自动判分**的一类 SQL 题）、`llm-rubric`（口径讨论）。

---

## 1. 核心机制

### 1.1 MySQL 8.0 窗口函数的能力边界（先把"没有的东西"背下来）
支持：`ROW_NUMBER() RANK() DENSE_RANK() PERCENT_RANK() CUME_DIST() NTILE(n) LAG() LEAD() FIRST_VALUE() LAST_VALUE() NTH_VALUE()`，以及任何聚合函数（`SUM/COUNT/AVG/MIN/MAX/BIT_XOR/GROUP_CONCAT`? 注：`GROUP_CONCAT` 不能当窗口函数用）加 `OVER ()`。
**不支持（写出来就是错）**：
- `NULLS FIRST/LAST` 语法（MariaDB/PG 特性）。MySQL 里 `NULL` 在 `ASC` 时排最前、`DESC` 时排最后；要 `NULLS LAST` 必须 `ORDER BY col IS NULL, col`（或 `CASE WHEN col IS NULL THEN 1 ELSE 0 END`）。
- `GROUPS` 帧、`FILTER (WHERE ...)` 聚合、`PERCENTILE_CONT/DISC`、`MEDIAN()`、`ANY_VALUE` 之外的 PG 风格集合。
- `MATERIALIZED`/`NOT MATERIALIZED` CTE 提示。
- `UPDATE ... RETURNING`、`INSERT ... RETURNING`（PostgreSQL 有，MySQL 没有）→ 判分题面里必须让候选人用"事务内二次 `SELECT`"或变量/临时表绕。
帧：只有 `ROWS` 与 `RANGE`（`RANGE` 要求**恰好一个**数值/日期型 `ORDER BY` 表达式，不允许 `RANGE 1 FOLLOWING` 与 `UNBOUNDED FOLLOWING` 组合的若干形态，且不能用 `NTILE`/`ROW_NUMBER` 之类要求无帧的函数）；`EXCLUDE CURRENT ROW | GROUP | TIES | NO OTHERS` 可用。

### 1.2 默认帧陷阱（本文件最高频的"看起来对"）
```sql
SUM(x) OVER (ORDER BY ts)                             -- 有 ORDER BY 无帧 → RANGE UNBOUNDED PRECEDING 到 CURRENT ROW
SUM(x) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING)    -- 到"当前物理行"
```
前者把**所有并列（peer）行**都算进当前行 → 同一 `ts` 的 5 行会拿到同一个累计值（很多人以为是"逐行累加"）。这是可判分的经典用例：fixture 里放 3 行同 `ts`，两种写法结果不同。
`LAST_VALUE()` 同理：默认帧到 `CURRENT ROW`（含 peer），所以"最后一行"其实是"当前分区的最后一行**直到此刻**" → 必须写 `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`。

### 1.3 四类必考查询模式
1. **Top-N per group**：`ROW_NUMBER() OVER (PARTITION BY k ORDER BY ...)` + 外层 `WHERE rn <= 3`；`RANK`/`DENSE_RANK` 用于"并列都要"；性能替代是 `LATERAL` + `ORDER BY ... LIMIT 3`（有索引时避免全量排序）。
2. **Gaps & islands（连续段）**：`ts - INTERVAL ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts) SECOND`（或 `DATE_SUB`）得到"伪常量分组键"，再 `GROUP BY` 该键 → 连续登录段、会话切分、库存连续时段。能解释"为什么减行号能得到分组键"是必答。
3. **变化检测 / 状态机**：`LAG(state,1,'INIT') OVER (PARTITION BY id ORDER BY ts, id)` 比较相邻行 → 状态跃迁次数、翻转检测；`SUM(changed) OVER (ORDER BY ts, id)` 造出"段号"。
4. **留存/漏斗矩阵**：`DATEDIFF(active_date, install_date)` 分桶 + `MAX(CASE WHEN d BETWEEN 0 AND 6 THEN 1 END)` 行转列；或用 `BIT_AND`/`SET` 拼接做严格漏斗（顺序约束）。

### 1.4 CTE、递归与派生表
```sql
WITH RECURSIVE dates(d) AS (
  SELECT DATE('2026-01-01')
  UNION ALL
  SELECT d + INTERVAL 1 DAY FROM dates WHERE d < '2026-12-31'
) SELECT COUNT(*) FROM dates;              -- 365
```
- `cte_max_recursion_depth`（默认 **1000**）到顶报 `ERROR 3636 (HY000): Recursive query aborted after 1001 iterations`。**递归终止条件写错 = 报错而不是死循环**，但生产脚本必须显式 `SET SESSION cte_max_recursion_depth`。
- 递归列必须**显式定宽**：`CAST(x AS CHAR(200))`，否则 `ERROR 3632`/截断，"路径拼接超过隐式列宽"是必考边界。
- 环防护：MySQL 没有 `CYCLE`/`NO CYCLE` 子句 → 用 `depth < n` 或 `path LIKE CONCAT('%,', id, ',%')` 判重，二者都有正确性/性能代价（`LIKE` 前缀通配无法用索引，但 CTE 内部是小结果集，成本另算）。
- 非递归 CTE 是**可读性/作用域**工具，不保证"只算一次"（可能合并进外层，见 `derived_merge`）；需要"物化屏障"时用 `LIMIT 18446744073709551615` 之类的写法属黑魔法，题面里应要求"用临时表或索引"这种可解释手段。
- `LATERAL`（8.0.14）让"相关派生表"可用：`FROM t CROSS JOIN LATERAL (SELECT ... WHERE ... ORDER BY ... LIMIT 1) x`，是 Top-1 per group 的索引友好解。

### 1.5 JSON：半结构化的正确姿势
```sql
SELECT j.id, jt.tag
FROM t j
JOIN JSON_TABLE(j.props, '$.tags[*]'
     COLUMNS (ord FOR ORDINALITY, tag VARCHAR(64) PATH '$')) AS jt ON TRUE;   -- 打平成行
```
- 函数索引（8.0.13）：`CREATE INDEX ix ON t ((CAST(props->>'$.uid' AS CHAR(64))))`；**生成列 + 索引**（虚拟列，8.0 默认参与索引）更可读、能被统计信息与 `EXPLAIN` 更直观地用上。
- **multi-valued index**（8.0.17）：`KEY ((CAST(props->'$.tags' AS CHAR(64) ARRAY)))`，只被 `JSON_CONTAINS(col, '"a", '$.tags')`、`'a' MEMBER OF(props->'$.tags')`、`JSON_OVERLAPS` 使用；不能用于范围/前缀 LIKE，也不能"覆盖索引"。判分点就是"候选人有没有让 `EXPLAIN` 真的 `key=ix_tags`"。
- `JSON_ARRAYAGG`/`JSON_OBJECTAGG` **不保证元素顺序**（文档明确说不保证）；`ORDER BY` 写在子查询派生表里也**不保证**被保留（无 `LIMIT` 的排序可被优化器去掉）→ 需要有序数组时用 `GROUP_CONCAT(... ORDER BY x SEPARATOR ',')`（有 `group_concat_max_len` 默认 1024 截断风险，判分前必须显式 `SET SESSION group_concat_max_len`）。
- 深路径与类型：`->`（返回 JSON）与 `->>`（等价 `JSON_UNQUOTE(JSON_EXTRACT())`，返回字符串）在数值比较时的差异：`props->>'$.n' + 0` vs `CAST(props->>'$.n' AS UNSIGNED)`（隐式转换规则不同，索引完全用不上）。
- `JSON_TYPE/JSON_LENGTH/JSON_EXTRACT` 对 `NULL` 与 SQL `NULL`、JSON `null` 三者区分（`CAST('null' AS JSON)` vs `NULL`）→ 可判分边界。
- `JSON_SCHEMA_VALID()` 配合生成列/`CHECK` 约束做写前校验（8.0.13+，`CHECK` 约束在 8.0.16 起真正强制）。

### 1.6 确定性输出（判分前置条件）
- **任何 `SELECT` 都要有全序 `ORDER BY`**；并列时补决定性列（`ORDER BY score DESC, id ASC`）。
- `ONLY_FULL_GROUP_BY` 在 8.0 默认开启 → `SELECT` 列表里出现非聚合、非分组列会 `ERROR 1055`（而不是"随便给个值"）。要"组内任一行"必须显式 `ANY_VALUE()` 或窗口 `ROW_NUMBER()=1`。
- `sql_mode` 默认含 `NO_ZERO_DATE`、`NO_ZERO_IN_DATE`、`STRICT_TRANS_TABLES`、`ERROR_FOR_DIVISION_BY_ZERO`（注意：该模式下 `1/0` 仍是 **`NULL` + warning**，不是 error）。
- `CONVERT_TZ()` 在 `mysql.time_zone_name` 未加载时静默返回 **`NULL`**（时区表未导入是判题容器最常见的隐性差异）→ 涉及时区的题面必须要求"用 `UTC_TIMESTAMP` 存 + 应用层/`+INTERVAL` 显式偏移"，或先验证 `SELECT CONVERT_TZ('2026-01-01','UTC','Asia/Shanghai')` 非 `NULL`。
- `SUM()` 空集返回 `NULL`（不是 0）、`COUNT(DISTINCT col)` 忽略 `NULL`、`AVG` 的分母是被忽略 `NULL` 后的行数 → 全部要 `COALESCE` 或写清口径。
- 浮点求和顺序不影响 `DOUBLE`？ 会影响（结合律不成立）→ 金额一律 `DECIMAL`/整数分；`CAST` 与 `ROUND` 的 `.5` 舍入规则（MySQL `ROUND()` 对 `DECIMAL` 是"四舍五入离零更远"，对近似值受二进制表示影响，`SELECT ROUND(0.15,1)` 可能是 `0.2` 也可能不是 → 判分题禁止用二进制浮点做期望值）。

---

## 2. senior / principal 会被追问什么
1. `SUM() OVER (ORDER BY ts)` 与 `... ROWS UNBOUNDED PRECEDING` 在你的 fixture 上结果为什么不同？给出**最小复现数据**。
2. `RANK`/`DENSE_RANK`/`ROW_NUMBER` 在"并列 + 要取前 3 名"三种需求下分别选哪个？为什么 `WHERE rn<=3` 在外层而不是内层（窗口函数不能出现在 `WHERE` 里，`ERROR 3593`）。
3. 窗口函数对性能的真实影响：多少个不同 `PARTITION/ORDER` 组合就有多少次排序（`EXPLAIN ANALYZE` 里多个 `Sort` 迭代器）；`WINDOW w AS (...)` 复用只省书写不省排序；`NTILE`/`PERCENT_RANK` 需要全分区。你怎么把它变成"一次排序 + 一次扫"（预先按 `k,ts` 建索引/临时表）。
4. 留存矩阵的行转列：口径（`d` 从 0 还是 1 开始、跨月分母是"安装当日 cohort 数"）如何在 SQL 里显式化而不是靠注释？
5. JSON 字段建模决策：什么信号说明该拆表（需要被 `JOIN`、需要唯一约束、需要统计信息、出现在 3 个以上查询的谓词里）？给 `JSON` 与生成列与关联表三档的成本对比。
6. 递归 CTE 生成日期序列 + 大表 `LEFT JOIN`：`cte_max_recursion_depth` 与"日期序列被当常量表"的计划选择；为什么 `WITH dates AS (...) SELECT ... FROM dates LEFT JOIN t ON ...` 有时被优化成"驱动表反过来"。
7. principal：给"分析型 SQL"定口径文档（每个指标的分子/分母/去重键/时区/迟到数据处理规则），并让 SQL 与文档在同一份 PR 里演进；如何为这类 SQL 建立"结果快照回归测试"（fixture 冻结 + 期望结果文件 + 计划指纹）。

---

## 3. 常见错误答案

| ❌ 写法/说法 | 真相 |
| --- | --- |
| `ORDER BY score DESC NULLS LAST` | MySQL 无此语法 → 直接语法错误；用 `ORDER BY score IS NULL, score DESC`（`IS NULL` 升序把非空放前面） |
| 窗口函数写在 `WHERE`/`HAVING` 里 | `ERROR 3593`：窗口函数只允许出现在 `SELECT` 列表与 `ORDER BY` 中；必须包一层子查询/CTE |
| `SUM(x) OVER (ORDER BY ts)` = 逐行累计 | 默认帧是 `RANGE UNBOUNDED PRECEDING TO CURRENT ROW`，含并列行 |
| `LAST_VALUE(x) OVER (PARTITION BY k ORDER BY ts)` 取分区末值 | 默认帧到当前行；必须 `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`（或用 `FIRST_VALUE` + `DESC`） |
| `LAG(x)` 第一行返回 `NULL` 要 `COALESCE` 之外再处理 | 三参形式 `LAG(x, 1, 0)` 直接给默认值，比外层 `COALESCE` 更准确（`x` 本身可为 `NULL` 时二者语义不同！） |
| `SELECT id, MAX(ts), col FROM t GROUP BY id` 里 `col` 是"那一行的值" | `ONLY_FULL_GROUP_BY` 直接报错；关掉它得到的是**任意**值（不是"最大 ts 对应行"）→ 正解是窗口 `ROW_NUMBER()` |
| `GROUP_CONCAT` 结果一定完整 | `group_concat_max_len` 默认 1024，静默截断（有 warning）；跨 session 变量要显式设 |
| `JSON_ARRAYAGG(x)` 内部排序可控 | 顺序不保证；派生表里加 `ORDER BY` 也不保证保留 |
| `WHERE props->'$.tags' LIKE '%a%'` 能走 multi-valued index | 只有 `JSON_CONTAINS`/`MEMBER OF`/`JSON_OVERLAPS` 会命中；`LIKE` 全表扫 |
| `NOT IN (子查询)` 安全 | 子查询含 `NULL` → 整体结果为空（三值逻辑）；用 `NOT EXISTS` |
| 递归 CTE 不需要宽度控制 | 递归列宽度取锚点行推断，`CONCAT` 超宽会静默截断或报错 → `CAST(... AS CHAR(255))` |
| `DATE_SUB(d, INTERVAL 1 MONTH)` 与 `- INTERVAL 30 DAY` 等价 | 月末语义不同（`2026-03-31 - 1 MONTH = 2026-02-28`）；月度口径必须显式 |
| `TIMESTAMP` 与 `DATETIME` 一样 | `TIMESTAMP` 存 UTC 并按 `time_zone` 会话变量转换（范围到 2038）、`DATETIME` 无时区；跨时区分析里混用 = 口径漂移 |
| `COUNT(DISTINCT a,b)` 与 `COUNT(DISTINCT CONCAT(a,b))` 一样 | 前者支持且更准；后者遇到分隔符歧义（`a='1,',b='2'` 与 `a='1',b=',2'`）会误判 |
| 排序分页 `LIMIT` 不用全序也行 | MySQL 不保证并列行顺序稳定 → 判分随机失败；必须决定性 `ORDER BY` |

---

## 4. 可判分出题角度

这类题最适合 `code`：**输入 fixture 冻结、输出结果集逐行比对**。判分三层：结果集 → 语句可执行性（语法/`ONLY_FULL_GROUP_BY` 合规）→ 计划/代价证据（可选）。
禁止：任何依赖 `NOW()`/`RAND()`/时区表/浮点求和顺序的期望值。

### 题面草稿 1（`code`，`judgeKind: mysql`，difficulty: senior）
> 基线：MySQL 8.0，`SET NAMES utf8mb4; SET SESSION cte_max_recursion_depth=2000;`。表：
> ```sql
> CREATE TABLE user_events(
>   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
>   uid BIGINT UNSIGNED NOT NULL,
>   kind VARCHAR(24) NOT NULL,          -- 'login' | 'purchase' | 'view'
>   ts DATETIME NOT NULL,               -- 全部为 UTC 字面量
>   props JSON NOT NULL,                -- {"channel":"email","tags":["a","b"]}
>   KEY idx_uid_ts(uid, ts)
> ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
> ```
> fixture 含：并列 `ts`（同一 uid 同一秒两行）、跨 3 个日历月的数据、某 uid 只有 1 条事件、`props` 里 `tags` 为空数组/`NULL`/JSON `null` 三种、迟到事件（`ts` 早于该行 `id` 更大的一行）。
> 只提交一个 `.sql` 文件，产出**三个结果集**（按顺序，每题都用全序 `ORDER BY`）：
> 1. **会话切分**：按 `uid` 输出 `(uid, session_no, start_ts, end_ts, event_count)`，相邻事件间隔 `> 30 MINUTE` 判定为新会话；同一秒内的并列事件必须落在同一会话且编号全局唯一确定；
> 2. **连续活跃段**：按 `uid` 输出最长"连续日历天登录段"的 `(uid, seg_start, seg_len_days)`（并列最长时全部输出，按 `seg_start` 升序）；日期序列必须用 `WITH RECURSIVE` 生成（不得依赖日历表），且要正确处理"没有登录的日子"；
> 3. **渠道渗透**：输出 `(channel, uv, purchase_uv, penetration_pct)`，其中 `channel` 来自 `props->>'$.channel'`，缺失记为 `'unknown'`；`penetration_pct = purchase_uv / uv * 100` 保留 2 位（`DECIMAL`，不得用 `DOUBLE`）；并保证 `uv` 用 `COUNT(DISTINCT uid)` 且不受同一 uid 多渠道重复计入的影响（口径自己定义并写在注释里）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `sessions_exact` | 结果集逐行比对；并列秒的用例证明候选人没有误用 `RANGE` 帧/没有把 `id` 排除在排序键外（`ORDER BY ts` 不带 `id` → 会话编号不稳定 → 判负） |
| `single_event_user` | 只有 1 条事件的 uid 必须出现在结果里（`seg_len_days=1`）且 `session_no=1` |
| `gaps_and_islands_dst_agnostic` | 跨月/跨年边界（`2026-12-30 → 2027-01-02`）与"中间缺一天"的两个用例：段长正确 |
| `json_null_variants` | `props` 为 `NULL`、`'null'`、`'{}'` 三种都归 `'unknown'`，且不得抛 `ERROR 3143`（非法 JSON path）|
| `decimal_rounding` | `1/3` 类比例（`uv=3, purchase_uv=1`）期望 `33.33`；用 `DOUBLE` 导致 `33.3333...` 或 `33.34` 的实现判负 |
| `full_order_enforced` | 题目侧对同一 SQL 执行 3 次（中间做一次 `ANALYZE TABLE`）→ 结果必须逐次相同（打"缺决定性 `ORDER BY`"） |
| `recursion_depth` | 跨 1800 天的日期序列用例：未设 `cte_max_recursion_depth` 的实现报 `ERROR 3636` → 判负（候选人已在文件里 `SET SESSION ...`） |

### 题面草稿 2（`code`，`judgeKind: mysql`，difficulty: principal）
> 在草稿 1 的表上新增 50 万行（`uid` 分布 Zipf，头部 uid 占 30%）。要求提交 `topk.sql` 与 `funnel.sql`：
> 1. `topk.sql`：输出每个 `uid` 的 **Top-3 `kind` 按事件数**（并列时 `kind` 字典序升序），**总行数 ≤ 3×uid 数**，且计划里**不得出现两次全量 filesort**（判分：`EXPLAIN FORMAT=JSON` 里 `sorting_operation` 迭代器出现次数 ≤ 1）；必须给出两种方案（窗口函数版 / `LATERAL` + 覆盖索引版）并用注释写明各自的适用条件；
> 2. `funnel.sql`：严格顺序漏斗 `view → login → purchase`（同一 uid，时间递增，允许跨任意时长，每个 uid 只计"最早完成"的一条路径），输出三步的 `uv` 与两个转化率；给出"迟到事件"的处理策略并在注释里说明它对结果的单调性影响（转化率必须 `≤ 1`，不得因迟到事件出现 `>1`）；
> 3. 两文件都必须带全序 `ORDER BY`、不得用 `GROUP_CONCAT`（受长度截断）、不得用用户变量（`@x := ...`，8.0 已声明其行为不可靠并在未来版本可能改变求值顺序）。
> 判分：结果集 + 计划迭代器计数 + `information_schema` 只读断言（`no_user_variables` 通过文本静态检查）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `topk_exact_with_ties` | 一个 uid 的 `kind` 计数为 `5,5,3,3` 时，Top-3 取哪三个由"并列 + 字典序"唯一确定（打 `ROW_NUMBER` 与 `DENSE_RANK` 误用） |
| `one_sort_only` | 窗口版方案的 `EXPLAIN FORMAT=JSON`：全量排序迭代器 ≤1 次（证明候选人用了 `idx_uid_kind` 之类的前缀避免二次排序；`LATERAL` 版需断言 `key` 命中） |
| `funnel_strict_order` | 构造 `purchase → view → login` 乱序 uid：该 uid 不进漏斗第 3 步 |
| `late_event_monotonic` | 追加迟到事件后重跑：各步 `uv` 单调不减、转化率仍 `<= 1` |
| `no_user_vars_no_groupconcat` | 提交文本静态检查（含 `@` 变量赋值或 `GROUP_CONCAT(` → 判负并给出原因） |
| `zipf_scale_timeboxed` | 50 万行用例只加 `max_execution_time`（如 20s）作为**可行性**兜底，不做耗时比较（避免机器噪声） |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 给出一份"周活跃用户 + 7 日留存"指标口径争议（数据团队、产品、财务三方各执一词：留存分母是否含新装当日、时区以谁为准、退款是否回退、内部测试账号是否剔除）。要求：写出唯一口径定义（分子/分母/去重键/时区/迟到数据窗口/回刷策略）、指出三种常见 SQL 写法各自会算错成什么、给出治理方案（口径即代码 + 快照回归测试 + 变更审批）。

**points**：口径要素完备 3；三种错法的具体后果（默认帧含 peer、`RANGE` 与 `ROWS` 差异、时区/`CONVERT_TZ` 返回 NULL、`DATE` 边界）3；迟到数据窗口与回刷（watermark 式思路、分区重算幂等）2；治理（口径文件与 SQL 同 PR、期望结果快照、计划指纹）2。
**bonus**：指出 `DATETIME` vs `TIMESTAMP` 在跨时区下的口径漂移；提出用"事件时间列 + UTC 存储 + 展示层转换"的单一事实源；给出"退款不回退活跃，只影响收入指标"的业务论证。
**gaps**：只谈"用窗口函数"；把时区问题归为"数据库配一下"；没有回刷策略（只说"重跑任务"）。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 窗口/CTE/JSON 的分析型 SQL 与口径 | `ABNB-DATA-1`、`APL-BD-1` |
| 确定性输出与可判分回归 | `ABNB-BE-2` |
| 大基数下的排序/计划优化 | `APL-BE-2`、`APL-BD-1` |
| 半结构化建模决策 | `APL-BE-2` |
