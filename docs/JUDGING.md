# 判题器约定（JUDGING）

> 实测状态：7 类判题器（`java-junit`、`react-vitest`、`mysql`、`redis`、`pyspark`、`spark-scala`、`llm-rubric`）
> 都在容器里真跑真判 —— 每个 runner 都有"参考解必须 pass + 朴素解必须 fail 到用例粒度"的双向往返测试，
> 外加 `server/test/regression/reference-solutions.test.ts` 把题库里**每道题**的参考解真跑一遍。
> 这条不是文档口头承诺：`./start.sh --verify` 带 `ARENA_REQUIRE_STACKS=1`，整片 skip 直接判失败。
> 里程碑 A 当时确实只有三栈跑过绿，那句话已经翻篇（留在这里是为了说明：文档会滞后，闸门不会）。

所有判题器实现 `shared` 的 `Runner` 接口：`probe()`（该栈是否可用）+ `run(request, question, onEvent)`。
返回统一为 `JudgeResult`：

```jsonc
{
  "status": "pass | fail | error | needs_human",
  "passed": 2, "failed": 1, "total": 3,
  "failedCases": [{ "name": "中间重复需要滑动窗口截断", "expected": "3", "actual": "0", "message": "..." }],
  "passedCases": ["空事件流返回 0"],
  "errorKind": "compile | timeout | runtime | forbidden | sandbox | unavailable",  // status=error 时才有
  "logs": "截断后的原始输出（≤20 行 / 4000 字）",
  "durationMs": 1412
}
```

**语义纪律**（这是判题可信度的核心，写题时也要按它想）：

- `fail` = 你的代码跑起来了但结果不对；`error` = 根本没跑到断言（编译失败、抛异常、超时、被白名单拒绝）。
  两者永远不混：把编译失败算成"用例不通过"会让人误以为思路错了。
- 失败必须落到**用例粒度**，带 `expected` / `actual`。
- 每个 runner 都有"已知正确解必须 pass + 已知错误解必须 fail"的双向测试（`server/test/judge/*`）。
- 每次判题独立沙箱，跑完必删；判题后有测试断言 `data/judge` 为空、无 `arena_%` 临时库残留。

## java-junit（算法题，只允许 Java）

```jsonc
"runner": {
  "className": "Solution",
  "signature": "int longestUniqueRange(int[] events)",   // 必须与实现完全一致
  "referenceSolution": "public class Solution { public static int longestUniqueRange(int[] events) { ... } }",
  "naiveSolution": "public class Solution { ... }",       // 能编译、必然不过，用来抓判题器 bug
  "timeoutMs": 15000
}
```

- 考生提交一整个 `Solution` 类，方法写成 `public static`。
- `cases[].input` 是**参数数组**：`int[]` 参数写成 `"input": [[1,2,1,3]]`。
- **契约型用例**：`cases[].expectThrow: "ArithmeticException"`（此时 `expected` 填 `null`）—— 只有抛出该简单类名的异常才算通过。用来考"溢出/非法输入必须报错，不许吞"这类 senior 契约。
- **大整数**：`long` 参数与期望值请写成**字符串**（`"9007199254740993"`）。JSON 的 number 超过 2^53 在写题脚本里就已经丢精度了；`long` 转换与比较都接受字符串形式。
- 支持类型：基本类型及其包装、`int[]/long[]/double[]/String[]` **及任意嵌套（`int[][]`、`String[][]`…，按组件类型递归构造）**、
  `List<Integer|String|Long>`（泛型实参会真的参与转换）、`Set/Map`（结果按排序归一）、同名简单类（自定义节点类）。
- JDK 固定 **17**：同一个 JDK 还要跑 Spark（3.5.5 官方支持到 17），所以答案里用不了 Java 21 的虚拟线程与 sequenced collections；
  record / sealed / switch 表达式在 17 可用。取舍细节见 `HANDOVER.md` 的 WI-38。
- 结果比较前做归一化：数组 → `[1,2]`；浮点按 6 位小数；`Long/Integer` 走精确整数字面量（不再经 double）；`Set/Map` 排序后比较。
- 实测：单次判题约 1.5s。

## react-vitest（前端题）

```jsonc
"runner": { "files": [{ "path": "solution.test.tsx", "content": "..." }], "timeoutMs": 60000 }
```
考生提交 TS/TSX；沙箱复用镜像内 `/app/node_modules`（**不重新 npm install**），
用 Vitest + jsdom 跑题目自带的断言文件，JSON reporter 还原到用例粒度。
- 提交默认落盘 `Solution.tsx`；要按真实工程结构 import（`./src/Counter`）时用 `"submissionPath": "src/Counter.tsx"`
  显式指定（只接受仓库内相对路径）。`className` 表示类名，**不再**兼作落盘路径。

## mysql（SQL 题）

```jsonc
"runner": {
  "setup": ["DROP TABLE IF EXISTS orders", "CREATE TABLE orders (...)", "INSERT INTO orders VALUES (...)"],
  "referenceSolution": "SELECT ...", "naiveSolution": "SELECT ...", "orderSensitive": false
}
```
- 每题建独立临时库 `arena_*`，判完 `DROP`；`SET SESSION max_execution_time` 限制查询时长。
- `cases[].input` 是该用例**额外要执行的语句**（用来造新数据或清空表做边界）；
  `cases[].expected` 支持 `[[...]]` 或 `{columns, rows, orderSensitive}`。
- **用例之间是隔离的**：runner 在每个用例前都把 `setup` 重跑一遍（`mysql.ts` 里
  `seed = [...setup, ...input]`），所以 `setup` 必须幂等（`DROP TABLE IF EXISTS` 开头），
  而 `input` 只需表达"这条用例相对基线的差异"。
- **空结果集的用例必须写成裸数组 `[]`**：`mysql --batch` 在 0 行时连表头都不输出，runner
  拿不到列名，带 `columns` 的期望值会报"列名不一致：期望 [...]，实际 []"——
  这是构造上判不了的，不是答案写错了（实测：`sql-mysql-0011` 的空表用例第一次就是这么红的）。
- 数值 `"250.50"` 与 `250.5` 等价；字符串比较不区分大小写；默认行序不敏感。
- SQL 的 `NULL` 在期望值里直接写 JSON `null` 即可（runner 把输出的 `NULL` 与期望的 `null` 归一到同一个值）。
- **限制**：每条语句都用新的 mysql 连接执行，所以会话变量、`Handler_*` 差值、跨语句锁状态都无法断言；考生只能提交一条查询。因此 gap lock / 并发交错 / `EXPLAIN` 代价类考点请出成 `llm-rubric` 主观题。
- **白名单**（判据在 `server/src/judge/guards.ts`，改它要同步这里）：
  一次只允许**一条**返回结果集的查询，可前置一条 `SET SESSION`；放行的开头关键字是
  `SELECT / WITH / EXPLAIN / DESCRIBE / SHOW`（后两个是调优题要看执行计划用的）。
  黑名单：`INTO OUTFILE|DUMPFILE`、`LOAD_FILE(`、`LOAD DATA`、`GRANT|REVOKE`、`SHUTDOWN`、
  `SET GLOBAL`、`sql_log_bin`、访问 `mysql./sys./performance_schema.` 与 `USE` 到这三个系统库，
  以及 **`/*! ... */` 版本注释**（mysqld 会真执行其中的内容，而切句器把它当注释丢掉 —— 所以整条提交里出现就拒）。
  `information_schema` 允许读（调优类题目要用）。
- 实测：单次判题约 0.55s。

## redis

```jsonc
"runner": { "setup": ["DEL board", "ZADD scores 10 a"], "timeoutMs": 10000 }
```
- 考生提交**多行命令序列**（`#` 开头是注释）；用独立 db index（1-15），判题前后各自 `FLUSHDB`。
- `cases[].input` 是一条命令（返回其结果）或多条命令（返回结果数组）；期望值比较前把
  Buffer / 大整数 / 数字字符串归一化（`"3"` 与 `3` 等价）。
- **禁用命令**（集合在 `guards.ts` 的 `REDIS_FORBIDDEN`，改它要同步这里）：
  `FLUSHALL FLUSHDB CONFIG DEBUG SHUTDOWN SAVE BGSAVE BGREWRITEAOF KEYS MONITOR SLAVEOF REPLICAOF
  MODULE MIGRATE SORT OBJECT SELECT SWAPDB ACL SCRIPT EVAL EVALSHA FCALL LATENCY`。
  因此出题时不要考 Lua/EVAL（`EVAL`/`EVALSHA`/`FCALL`/`SCRIPT` 全禁）；
  限流类题考"用 ZSET 打分=时间戳"这类可验证的数据结构设计。

## pyspark / spark-scala（大数据题）

- `runner.entry: "function"`：考生写 `def solve(spark)` 或 `def solve(spark_df)`，返回 DataFrame。
- `runner.entry: "sql"`：考生写 Spark SQL，`setup` 里建表灌数。
- 常驻 `spark_worker.py` 维持一个 `local[2]` SparkSession，按行 JSON 协议收发，单请求 90s 超时后重启 worker。
  池子、协议与排队都在 `server/src/exec/spark-pool.ts`（**判题与网页 IDE 共用**）：同一时刻只允许一个请求在飞，
  判题优先于 IDE 且不抢占正在跑的那个。IDE 用 `mode: "ide"` 走同一个 worker —— 协议是加法，
  判题请求不带这个字段，行为一字不变；区别只在 IDE 要用户的 `print()`，所以那侧在**进程内**
  把 stdout 收进响应字段（判题侧仍然改道到 stderr 保住行分隔 JSON），并回一个 DataFrame 的表格预览。
  可用性判据 `pysparkAvailable()` / `scalaSparkAvailable()` 也只有一份：探"库能不能 import、
  jars 全不全"，不探客户端二进制。
- Scala Spark 题（`spark-scala`）**每次真编译真跑**：把考生代码与 `harness/ArenaScalaHarness.scala` 一起用
  Spark 自带的 `scala-compiler`（2.12，与 Spark 同版本 —— 混用 `/opt/scala` 的 2.13 会编译过但运行期
  `NoSuchMethodError`）编译，再在 `local[*]` 的 SparkSession 上逐用例跑。
  契约是 `object <runner.className> { def solve(df: DataFrame): DataFrame }`，harness 直接引用它，
  所以签名写错是**编译期错误**（`errorKind: "compile"`），不做反射猜测。
  用例 JSON 与 `pyspark` 完全一致（`input={rows,schema,view?}`、`expected=行对象数组`），值归一化两边逐条对齐。
  默认超时取 `config.judge.sparkTimeoutMs`（90s，含编译），`runner.timeoutMs` 上限已放到 180s。
- Flink 相关题目**不做真跑**，走 `llm-rubric`（原因：mini-cluster 体积与启动代价不划算）。

## llm-rubric（主观题）

不是判题器而是评分链路，见 `docs/ARCHITECTURE.md`。题目侧要写：

```jsonc
"rubric": {
  "maxScore": 10,
  "points": [{ "label": "容量估算", "weight": 3, "criteria": "给出 QPS/存储量级并换算到分片数才算命中" }],
  "notes": "评分口径"
}
```
权重合计必须等于 10（schema 强制），`answer` 字段放参考要点（只喂给评分模型，不给答题者看）。
