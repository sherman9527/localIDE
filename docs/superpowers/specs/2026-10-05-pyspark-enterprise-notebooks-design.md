# 企业级 PySpark 教程 notebook 系列（子项目 B）设计

> 依赖子项目 A 的 **A1**（Jupyter + PySpark kernel + 第五页），**不依赖 A2**（Scala kernel）——
> 排序上 B 在 A2 之前正是这个原因。设计见 `2026-10-05-jupyter-notebook-runtime-design.md`。
> 用户 2026-10-05 拍板：第一轮 **3 篇打样**；教程的"可运行"**要变成闸门**（每篇在容器里真跑过才算绿）。

## 1. 目标与读者

读者是这个仓库的主人本人：**senior / principal 口径的面试准备 + 工作中边查边写**。
所以每篇同时服务两个动作，二者对结构的要求不同，必须都满足：

- **学习**：一个真实坏结果 → 取证 → 几种解法 → 量出差异。不是概念罗列。
- **查阅**：每篇末尾一张**参数速查表**（配置项、默认值、什么时候该动它、动错的表征），
  以及一段**排错对照**（异常/现象 → 根因 → 下一步取证动作）。
  查的价值在于"我记得有这回事但记不住参数名"，所以速查表要能独立于正文被读。

## 2. 教程纪律（这四条是可运行文档的底线，也是闸门断言的对象）

1. **每个"更快/更省"的结论都必须当场量出来**，同一 cell 里给对照组，输出行数与差异方向都进断言。
   写"salting 能治倾斜"而实测更慢 —— 那是本项目最恨的那类假话（对照 `dev_verify_workflow`：断言下全绿的静默降级）。
2. **跑不出来的一律显式标注**。跨版本行为（Spark 3.4 / 3.5 / 4.0 的默认值与语义差异）在本镜像里只有 3.5.5，
   其余版本写成 `未在本镜像验证（依据：官方 release notes / JIRA 链接）`，**不许伪装成可运行**。
   这条是被我自己救回来的：写这份 spec 时我先说过"ANSI 从 3.4 起默认开"，落笔前核对才发现不该写死。
3. **可复现**：随机数据固定 seed；单篇 notebook 体积 ≤ 2MB、内嵌数据 ≤ 5MB（进 git，能 diff）。
4. **每篇一个"面试官追问"块**，并把口径指回题库：写**具体题面 id**（例如 `bd-pyspark-0001`）+ 热问法 +
   追问往哪一层走。指不到具体题的那一篇，说明它的坏结果跟面试无关，要么改内容要么删掉这段。
   这是本仓库教程区别于网上教程的地方 —— 素材、题面、教程是同一套口径。

## 3. 主题清单（12 类）与批次

| # | 类 | 代表问题（能在 notebook 里跑出差异的） | 批次 |
| --- | --- | --- | --- |
| 1 | 倾斜专项 | 热点 key 让一个 task 跑 90% 时间；salting / 两阶段聚合 / `skewHint` 各治哪一半；AQE 为什么 sometimes 不救你 | **v1** |
| 2 | 小文件与物理设计 | 读侧 `maxPartitionBytes` vs `openCostInBytes` 的取舍；写侧 `repartition` 与 `coalesce` 的 shuffle 语义差；分区数与 task 启动开销实测 | **v1** |
| 3 | Shuffle 与计划解读 | `explain('formatted')` 里 `Exchange` 从哪来；`shuffle.partitions` 改动的真实代价；AQE 三段（coalesce / 动态 join 策略 / skew）各自的触发条件 | **v1** |
| 4 | 读与写 | 嵌套/`explode`、CSV 引号转义（呼应题库 `alg-java-0015`）、schema 推断的两次扫描、JDBC `partitionColumn` | v2 |
| 5 | UDF 与表达式 | 普通 UDF vs pandas/Arrow UDF 的吞吐；Python worker `memoryOverhead`；UDF 里调外部服务的超时/重试/幂等 | v2 |
| 6 | 类型与口径 | `DecimalType` 溢出、时区与 `TIMESTAMP_NTZ`、`sum` 溢出、NaN/null 语义、字符串大小写 | v3 |
| 7 | Schema 演进与数据质量 | `PERMISSIVE` 把坏行静默塞进 `_corrupt_record`；DQC 断言（空值/重复/波动/枚举）与 fail-fast vs 隔离坏分区 | v3 |
| 8 | 增量与 CDC | upsert/merge 的现实选择（Delta / Iceberg / Hudi 的口径差）、幂等写、冲突重试 | v4 |
| 9 | 结构化流 | watermark 与 state store 膨胀、`maxStateRowsPerTrigger`、乱序迟到、checkpoint 兼容性 | v4 |
| 10 | 排错取证 | Spark UI 读法（GC time、spill、task 时长分布）、异常根因表（`exit 137` vs `OOMKilled`、`FetchedFailed`、`metadata fetch failed`）、driver `collect` 炸 | v5 |
| 11 | 工程化 | pytest + session fixture 复用（提速是重点）、依赖冲突（jackson / scala binary）、配置分层、成本口径 | v5 |
| 12 | 版本迁移 | 3.4 → 3.5 → 4.0 的默认值与语义变化；"同一段代码两版结果不同"的排查路径（**全部标未在本镜像验证**） | v6 |

批次规则：v1 三篇先看形状，之后每轮 2 类；**每轮结束时用真浏览器在 Jupyter 里手跑一遍**（不能只信 CI 的 `nbconvert`）。

## 4. v1 三篇的单元设计

每篇固定五段结构（写作者与闸门都按它对齐）：

```
① 现象        一段真实坏结果：跑出来，让读者先看见"慢/炸/不对"
② 取证        怎么看证据：explain、task 时长分布、event log、行数分布
③ 解法 A/B/C  各一段可运行代码，讲清各治哪一半（不写"推荐用 X"这种无上下文的结论）
④ 量差异      同一数据对照组 + 计时/行数/shuffle spill 的输出
⑤ 速查 + 追问 参数表（默认值/什么时候动/动错的表征）+ 本题的面试追问链 + 题库指针
                          （指针**必须写成具体题目 id**，从 content/questions/big-data/ 里挑，
                           留"哪道题"这种描述就是留占位符）
```

### 篇 1 `01-skew-and-hot-keys`（倾斜）

- ①：200 万行事件表按 `user_id` 聚合，其中 1% 的 key 占 40% 的行；`spark.sql.shuffle.partitions=8`，
  跑一个 `groupBy().agg()`，用 `spark.sparkContext.getRDDInfo`/task 时长把"一个 task 占大头"量出来。
- ②：`explain('formatted')` 的 `Exchange hashpartitioning`；每分区行数分布（`mapPartitions` 计数）。
  ⚠️ explain 里的算子名随版本变（3.5 是 `Scan parquet`，4.x 改成 `FileScanCompute` 一类），
  所以篇里**以本篇实际跑出的文本为准**贴截图/输出，不写"你也会看到这行"。
- ③：加盐两阶段聚合 / `hint('skew')` + `spark.sql.adaptive.skewJoin.enabled` / 广播小表绕过 join。
  各自"治哪一半"：skew hint 只救 join 不救聚合；加盐救聚合但引入二次 shuffle。
- ④：三种解法各计时并输出 task 分布；**断言"处理后的最长 task 占比显著下降"**（方向性断言，见 §6）。
- ⑤：参数表（`shuffle.partitions`、`adaptive.*`、`advisoryPartitionSizeThreshold`、`skewJoin.*`）+ 追问：
  "count distinct 为什么更容易倾斜，怎么改"、"空 key 怎么处理"。
  题库指针（写具体 id）：**`bd-pyspark-0001`**「匿名流量占九成的 UV：热点 key 拆分 + 两阶段精确去重」
  就是本篇的面试题本体；**`bd-pyspark-0002`**「join 右表多版本导致行数膨胀：先收敛维度再广播」是广播绕开倾斜那一解。

### 篇 2 `02-small-files-and-partitioning`（小文件与物理设计）

- ①：写 2000 个 4KB parquet 文件（默认分区数 × 频繁 `write.mode(append)` 的产物），再读回来 ——
  读侧耗时被 task 启动开销主导；把"文件数 / task 数 / 每 task 处理字节"打出来。
- ②：`spark.sql.files.maxPartitionBytes` 与 `openCostInBytes` 怎么共同决定合并；
  `Scanning` 与 `FileScanCompute` 节点里的 metadata 成本。
- ③：写侧 `coalesce` vs `repartition`（前者不 shuffle、后者全 shuffle，用 `explain` 里有没有 `Exchange` 证明）；
  AQE 的 `coalescePartitions` 在读侧自动合并；`spark.sql.shuffle.partitions` 与实际输出文件数的关系。
- ④：同一份数据三种写法的文件数 + 读回来耗时；**断言"合并后文件数下降且读取耗时不升"**。
- ⑤：参数表 + 追问："分区键选高基数列会发生什么"、"增量覆盖写怎么避免小文件"。
  题库指针：**`bd-pyspark-0005`**「分区键治理 + at-least-once 重复投递：目录爆炸与 `__HIVE_DEFAULT_PART`」
  —— 那道的"目录爆炸"正是本篇 ① 量出来的东西，讲完现象可以直接把人送到题面上。

### 篇 3 `03-reading-the-plan-and-aqe`（计划解读与 AQE）

- ①：一段 join + 过滤，默认配置跑出 200 个 shuffle 分区、绝大多数是空跑；
  再用**写 parquet 落盘后读回**制造一个干净的 stage 边界，对比 AQE 生效前后的计划与分区数。
  （不用 `localCheckpoint` 制造边界：它不保证落成一次 shuffle 物化，"AQE 因此生效"这句话在这里站不住 ——
  教程里宁可土一点，也不要写一条我自己没验的机制。）
- ②：`explain('formatted')` 逐节读法：`Exchange` / `HashJoin` vs `BroadcastHashJoin` / `WholeStageCodegen`
  被什么打断（UDF、`BatchedScan`）；`spark.sql.adaptive.*` 三段各管什么。
- ③：调 `autoBroadcastJoinThreshold` 让 join 换策略（两种计划都跑出来对比）；
  `coalescePartitions.minPartitionSize`/`targetSizeInBytes` 的效果；为什么 `spark.sql.adaptive.enabled=false`
  有时反而更快（小数据 + 额外 stage 边界）。
- ④：三组配置的计划文本与耗时；**断言"计划里 join 算子名确实按预期改变"**（这是最便宜也最硬的证据）。
- ⑤：参数表 + 追问："怎么证明 broadcast 把 executor 撑爆了"、"AQE 为什么看不到 CBO"。
  题库指针：**`bd-pyspark-0002`**（右表多版本要先收敛维度再广播 —— 广播阈值与"能不能放下"的判断就是本篇 ③）
  与 **`bd-pyspark-0010`**「Last-touch 归因：非等值时间窗 join」（非等值 join 换不了 BroadcastHashJoin，
  计划为什么退化在这类题上最典型）。

## 5. 素材与数据规范

- 合成数据一律用 `spark.range(...)` + 确定性表达式生成，**固定 seed**；不引入外部数据集（离线构建与可复现两条都要求）。
- 数据不落 git：notebook 现场生成（`range` 造倾斜 key 用 `pmod`/字典表 + seed）。
  **预算是目标不是实测**：单篇执行 ≤ 90s、峰值内存 ≤ 1GB —— 写完第一篇就用真实数字校准，
  超了先缩数据量（倾斜与文件数的现象在 50 万行上一样能看出来，"跑不完"才是真问题）。
- 位置：`content/notebooks/<篇名>.ipynb`（进 git）；A1 的 `seed.ts` 负责"缺失才复制"到 `data/notebooks/`。
- 每篇的 kernel 固定 `arena-pyspark`（写进 `metadata.kernelspec.name`）—— 闸门要按它选 kernel，也避免用户误选系统 python 后"教程跑不通"。

## 6. 闸门：每篇在容器里真跑过

- 新阶段（挂在 `scripts/verify.sh` 的容器档，与判题矩阵同级）：
  `jupyter nbconvert --to notebook --execute --stdout`（或 `nbclient`）逐篇执行，超时 120s/篇。
- 断言分两层：
  ① **执行层**：无 cell 异常、kernel 是 `arena-pyspark`；
  ② **结论层**：每篇声明的"方向性断言"必须在执行结果里成立 —— 做法是 notebook 里把断言写成
  **真 `assert`**（例如 `assert max_task_share_after < max_task_share_before`），
  而不是只让脚本比字符串。教程里的结论一旦反了，闸门直接红。
- `assert-ran.mjs` 同款纪律：**整片 skip 也算失败**（Jupyter 不在时不许静默绿）。
- 破坏性验证：故意把篇 1 的对照配置改反（让 salting 更慢），确认闸门红；改回确认绿。
- 接线：新测试文件要被 `verify-coverage` 认领；`content/` 若有闸门断言目录集合，需把 `notebooks/` 显式加进去
  （实现时先跑一遍 `npm run bank:check` 看它是否管这个目录，别猜）。

## 7. 验收标准（senior 口径，可判真假）

一篇算"过"，要同时满足：

1. 容器档真跑绿，且方向性断言成立（不是"没报错"就算过）。
2. 一个不了解这段代码的人，能在 10 分钟内**只靠速查表**回答："我线上 shuffle 后有个 task 跑了 40 分钟，
   先查哪三个数，最可能的两种根因分别怎么验证"。
3. 每篇的"面试追问"块至少一条能把答案推到**机制层**（比如"为什么 skew hint 救不了聚合"），
   而不只是"调这个参数"。
4. 文档里出现的每个数字：要么是本篇当场量出来的（可点开看输出），要么带来源标注。

## 8. 明确不做

- 不做"Spark 入门 20 讲"式的全谱教程（RDD 演化史、宽窄依赖背诵、DataFrame vs RDD 八股）——
  这些在面试里已经不值 senior 的分，且没有可量化的坏结果。
- 不做视频/图文站、不做练习题自动判分（notebook 不是判题器，也不接题库写侧）。
- 不在教程里教"怎么在生产集群调 YARN/K8s 资源"——本机只有 `local[*]`，写出来就是没验证过的话（纪律 2）。
- 不做 Delta/Iceberg 的实装演示（镜像里没有，v4 那批改写成"口径与取舍"，并标未验证）。

## 9. 已知代价与不确定性

- 每篇都要"能当场量出差异"，比写解释性教程贵得多；v1 三篇的工作量集中在**造数据和构造对照**上，不在文字。
- `local[*]` 下倾斜/资源类现象与真实集群不完全一致（没有节点级 shuffle 与 fetch 失败）；
  凡涉及"分布式才有的失效模式"，写清"本机只能演示到这一层"，剩下的标未验证。
- 教程内容进 git 后就是**可增不可静默改**的东西：结论被后续实测推翻时，改文并留一行"何时被推翻、依据是什么"
  （沿用 `memo.md` 那套自我修正的写法）。
