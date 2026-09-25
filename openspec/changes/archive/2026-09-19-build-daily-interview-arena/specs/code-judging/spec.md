## ADDED Requirements

### Requirement: 结果导向真跑判题（场景 3/16）
系统 SHALL 支持可执行判题类型：`java-junit`、`react-vitest`、`mysql`、`redis`、`pyspark`，并 SHALL 覆盖需求点名的 "spark 代码"：Spark SQL 走 `pyspark` runner 的 `runner.entry='sql'`，Scala Spark 走 `spark-scala`（镜像内 `scala-compiler` + PySpark 自带 jars 编译运行）。判题 MUST 在容器内真实执行提交内容（编译 / 运行测试 / 执行 SQL / 执行命令 / 运行作业），MUST NOT 依赖字符串相似度或 LLM 猜测代码正确性。Flink 与 agent 设计类不做真跑（镜像与启动成本），归入 `llm-rubric`。

#### Scenario: Java 算法题全用例通过
- **WHEN** 用户提交两数之和的 Java 解法且 3 个用例全部返回预期
- **THEN** 判题结果为 `{status:'pass', passed:3, failed:0}`

#### Scenario: Spark SQL 与 Scala Spark 都能判分
- **WHEN** 分别提交一段 Spark SQL 与一段 Scala Spark 作业
- **THEN** 两者都按结果用例判 pass/fail，不要求用户配置任何外部集群（`local[*]`）

### Requirement: 判题延迟必须可见（体验硬约束）
判题属长耗时操作（Java 3-8s、Spark 首次 10-20s），系统 SHALL 以 **SSE 事件流**推送判题过程（`queued` → `progress{phase,elapsedMs,timeoutMs}` → `log` → `result`），MUST NOT 让前端在无任何反馈的情况下等待。同题的历史通过结果 SHALL 保留展示，不被本次失败覆盖。

#### Scenario: 等待期间有进度反馈
- **WHEN** 一次判题耗时超过 2s
- **THEN** 客户端在 2s 内至少收到一次 `progress` 事件并显示"已用 Xs / 上限 Ys"

#### Scenario: 失败不清除上一次通过记录
- **WHEN** 用户先通过某题、随后提交一个失败解
- **THEN** 结果面板仍显示"历史最佳：通过"，并区分本次结果

#### Scenario: 结果导向——不评判代码风格
- **WHEN** 用户提交的解法时间复杂度为 O(n²) 但所有用例通过且未超出超时上限
- **THEN** 判题结果为 `pass`（复杂度类问题归入主观题或提示，不改判结果）

### Requirement: 失败反馈到用例粒度（场景 3/4）
判题失败时 SHALL 返回 `passed`、`failed` 计数与 `failedCases[]`（每项含 `name`、`expected`、`actual`），前端 MUST 能展开查看；编译/运行异常 SHALL 单独归类为 `status:'error'` 并附截断后的原始日志（≤20 行），不得与"用例不通过"混淆。

#### Scenario: 部分用例失败时给出通过数与失败用例名
- **WHEN** 提交的解法通过 1 个用例、失败 2 个用例
- **THEN** 返回 `{status:'fail', passed:1, failed:2, failedCases:[{name:'空数组返回空',expected:[],actual:...}]}`

#### Scenario: 编译错误归类为 error 而非 fail
- **WHEN** 提交的 Java 代码缺少分号导致 `javac` 失败
- **THEN** 返回 `{status:'error'}` 且 `logs` 含 `javac` 诊断信息，`passed/failed` 为 0

### Requirement: 判题沙箱隔离与资源回收（场景 6/14/18）
每次判题 SHALL 使用独立工作区（`data/judge/<questionId>-<timestamp>`）与独立数据沙箱（MySQL：`arena_<n>` 库；Redis：独立 db index），执行结束 MUST 清理工作区、DROP 临时库 / `FLUSHDB` 临时 db，并 MUST 受超时限制（Java/React/SQL 20s，PySpark 90s）。提交的 SQL 与 Redis 命令 MUST 经语句/命令白名单过滤，拒绝 `DROP DATABASE`、`FLUSHALL`、`CONFIG`、`SHUTDOWN`、`INTO OUTFILE`、多语句等越权操作。

#### Scenario: 两次并发判题数据互不污染
- **WHEN** 两个 Redis 判题请求并发执行，A 写入 key `limit:uid`
- **THEN** B 的 `GET limit:uid` 返回 nil，两者结果互不影响

#### Scenario: 判题后无残留
- **WHEN** 连续执行 20 次判题
- **THEN** `data/judge` 目录为空且 `SHOW DATABASES LIKE 'arena_%'` 返回空集

#### Scenario: 越权语句被拒绝
- **WHEN** 用户提交的 SQL 中包含 `DROP DATABASE mysql`
- **THEN** 返回 `{status:'error', logs}` 说明语句被白名单拒绝，目标库未受影响

### Requirement: 参考解自证（防 regression）
每道可执行题 MUST 随题携带 `runner.referenceSolution`，且 CI SHALL 对每个 runner 跑"已知正确解 ⇒ pass、已知错误解 ⇒ fail 且 `failedCases.length>=1`"的双向往返测试。

#### Scenario: runner 回归矩阵
- **WHEN** 执行 `npx vitest run server/test/regression/runner-matrix.test.ts`
- **THEN** 所有题目参考解判为 `pass`，所有 fixture 错误解判为 `fail`；任一不满足即测试失败
