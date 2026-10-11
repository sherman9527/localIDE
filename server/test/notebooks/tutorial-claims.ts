/**
 * 每篇教程必须打出的**结论 slug**（WI-90 Task 1；闸门按这份表核对 marker，Ruling(B1)）。
 *
 * 它故意住在 notebook **外面**：期望值若由被测文件自己声明，"删一条结论"就同时删掉了判据 ——
 * 那种判据不是松，是**根本没有**（`server/test/notebooks/tutorials.test.ts` 的注释里写的是同一件事）。
 *
 * key = notebook 的**文件名**（不含目录，含 `.ipynb`），必须与 `content/notebooks/` 里的每一篇
 * 非 `00-` 教程一一对应：多一条、少一条都会红在 `tutorials.test.ts` 常驻那一组的
 * 「清单完整性」上（那条在宿主就红，不用等一次容器验证）。
 * `00-smoke-pyspark.ipynb` **不许**出现在这张表里 —— 它由 `kernel.test.ts` 真跑，
 * 这里再登记一遍等于在容器档里多起一次 Spark（40-90s），而两次执行不构成两条判据。
 *
 * slug 的形状 `[a-z0-9-]`：它要出现在 marker 里、也要出现在失败消息里，别放空格与中文。
 * 形状判据在同一条常驻断言里（`tutorials.test.ts`）。
 *
 * ⚠ 空表是 Task 1 的**正确状态**（教程是 Task 2/3/4 的交付物）。
 * 那时这张表一旦有了条目而 `content/notebooks/` 里还没有对应的文件，红的是"注册表与目录不一致"，
 * 反过来（有文件没条目）红的是同一句 —— 两个方向都是它，所以"加了教程忘了接闸门"不会静默。
 *
 * ⚠ 2026-10-10（WI-90 Task 2 落地）：表已经非空，上面那段"空表是正确状态"是**历史**。
 * 而且这里登记什么，教程里就必须**恰好**打出什么：`tutorials.test.ts` 的结论层是双向相等的
 * （少一条 = 结论被删/改跑/marker 漂格式；多一条 = 有结论没登记，它对闸门是隐形的）。
 * 所以给教程加一条方向性结论 = 同时改这个文件，改一边就红。
 */
export const TUTORIAL_CLAIMS: Record<string, string[]> = {
  // 篇 1（WI-90 Task 2）。四条 slug 各自对应的断言写在 notebook 的单元里：
  // hot-key-dominates = 最大 shuffle 桶占 47.5% 的行（确定量，不是耗时）；
  // salting-halves-max-partition = 加盐两阶段把它压到一半以下；
  // salting-preserves-result = 加盐前后两个结果集三个集合差全为 0（这条比"变快"硬）；
  // broadcast-changes-plan = 广播阈值改变 join 的算子名（计划文本，不是时间）。
  '01-skew-and-hot-keys.ipynb': ['hot-key-dominates', 'salting-halves-max-partition', 'salting-preserves-result', 'broadcast-changes-plan'],
  // 篇 2（WI-90 Task 3；复审轮补了第六条 slug 并把每条"判的是哪一句"写清 —— m1 粒度规矩）。
  // 每条 slug 对应的断言都在 notebook 的单元里，且**只押确定量**（耗时一律只打印）。
  // file-count-is-what-you-write = 一句"落盘文件数 = 非空 writer 数"，四条 assert 是它的四一面：
  //   `adaptive.enabled == false`（前提：AQE 显式关着，红话说清"配置被删了"而不是"现象消失了"）、
  //   `N_WRITE_PARTITIONS == 2000`（你写的分区数）、`len(files) == N_WRITE_PARTITIONS`（正面：等号，
  //   押等号的理由是"这 2000 个分区都不空"，空分区不产文件由 ①b 的 199≠200 单独量）、
  //   `sizes[-1] < 4096`（"碎"是量出来的不是形容词；983 那个中位数只打印，没进判据）。
  //   ⚠ **⑤a 复用这条的判定对象**（复审裁决）：⑤a 那条定律"文件数 = writer 数 × 每 writer 触及的分区值数"
  //   判的还是"文件数怎么来的"这一件事，只是推到分区表上 ⇒ 不给 ⑤a 单独加 slug（两条 marker 判一件事
  //   是本仓库明确拒收的形状），它的 assert 由闸门的执行层判。
  // small-files-get-merged-on-read = 一句"读侧确实在打包，而且打包没丢文件"，四条 assert 各是：
  //   `n_merged < len(files)//2`（正面：在合并）、`max(files_per_partition) > 1`（真往一个分区里塞多个）、
  //   `sum(files_per_partition) == len(files)`（一个都没漏 —— 这条才是"合并"与"丢文件"的分界）、
  //   `n_merged_aqe_on == n_merged`（对照：AQE 开关不动 FileScan 的输入分区）。
  //   ⚠ 复审轮删掉了这一格第五条 `assert n_merged == predicted`：正文（② 那节）明说"那条公式是解释不是判据"，
  //   钉成判据就 self-contradict，且 Spark 小版本改一次贪心次序会造出与判题无关的冤红 ⇒ 公式只打印。
  // open-cost-is-additive = ⚠ 这条**改了名**（原名 `open-cost-drives-partitions` 是简报里的推测名，方向被实测顶回）：
  //   一句"`openCostInBytes` 是加在每个文件上的字节成本，方向与流传口径相反"。五条 assert 全是这一句的侧面：
  //   `n_zero < ladder[0][1]`（调小 ⇒ 更合并，实测 3 < 16）、ladder 单调且互不相等（旋钮真的在动，不是四档同一个数）、
  //   `n_big > ladder[-1][1]`（调大 ⇒ 更多，实测 1000；复审把原先的 `== len(files)//2` 放宽成方向 —— 那个确切
  //   桶数是确定量里最脆的一类，1000 留在打印里）、`n_tight == len(files)`（"每文件一个分区"靠压 maxPartitionBytes，
  //   不是动 openCost）、`n_below_file > len(files)`（边界：预算压到单文件以下会按字节切片）。
  //   ⚠ 那一格的 **3 没有机制解释**（复审 Major 2 的裁决：如实写"量到了、机制没接住"）：按
  //   `total/(defaultParallelism×2)` 算该给 4、按"一箱装到底"该给 1 ⇒ 本篇不给它编。
  // coalesce-not-shuffle = 一句"coalesce 不走 shuffle、repartition 走，而 coalesce 只能降不能升"。
  //   八条 assert：`scan.rdd.getNumPartitions() == n_merged`（前提：读侧预算没漂，否则下面量的不是同一份东西）、
  //   `"Exchange" not in plan_coalesce` + `"Coalesce 8" in plan_coalesce`（正面：算子名）、
  //   `"Exchange RoundRobinPartitioning(8)" in plan_repartition` + `"hashpartitioning(id" in plan_by_key`
  //   （对照：什么才叫 shuffle，以及只有带 key 才是治理碎文件那一步 —— 后者是 ⑤a 那条动作的计划证据，
  //   它**不是**第二条结论，因为"按 key 聚有没有用"这件事由 ⑤a 的落盘文件数判）、
  //   `scan.coalesce(8)…== 8` / `scan.repartition(8)…== 8` / `df.coalesce(8)…== 2`（可行方向：升不上去）。
  // coalesce-cuts-files-not-rows = 一句"合并写砍的是文件、不是行"。五条 assert：恰好 8 个文件、
  //   原样写 == 输入分区数（① 那句话的又一格）、两种读法行数都 200000、总字节不增、平均单文件涨 100 倍以上。
  //   （它原先宣称的"读回不慢于对照"按 Ruling(B1) 删了：那条押耗时的 assert 本身就是会撞红的东西。）
  // static-overwrite-drops-other-partitions = ⑤b（**复审 Major 3 补的 slug**）：一句"出厂的 static 配
  //   mode("overwrite") 写分区表 = 一次清库，增量重算必须 dynamic"。五条 assert 各面：
  //   `conf_of(...).lower() == "static"`（前提：出厂值确实恢复了）、`probe["static"][1] == 5`（正面：30 个目录只剩 5）、
  //   `probe["dynamic"][1] == probe["dynamic"][0] == 30`（对照：dynamic 一个都不掉）、
  //   `probe["static"][2] < probe["dynamic"][2] == 200_000`（数据面：清掉的是行数不只是目录）、
  //   `probe["static"][2] == 5 * 6667`（算式核对：33,335 可纯算 ⇒ 顺带独立印证"每种模式重灌基线"真的生效）。
  //   ⚠ 它原先**有 assert、没 marker、没登记 ⇒ 在牙的射程之外**：把 `probe["static"][1] == 5` 整条删掉，
  //   闸门照旧全绿，而正文继续教"增量重算要用 dynamic" —— 这是本篇操作性最重的一条结论，所以给它自己的 slug。
  '02-small-files-and-partitioning.ipynb': ['file-count-is-what-you-write', 'small-files-get-merged-on-read', 'open-cost-is-additive', 'coalesce-not-shuffle', 'coalesce-cuts-files-not-rows', 'static-overwrite-drops-other-partitions'],
  // 篇 3（WI-90 Task 4）。每条 slug 只挂一句结论（评审 m1 的粒度规矩），同一 cell 里多条 assert 的"侧面"在此写明：
  // broadcast-threshold-changes-join = 阈值改的是 join 的算子名**与** `Exchange hashpartitioning` 的条数（实测 2/2/0），
  //   三档（-1 / 512 / 4096）把编译期估计夹住 ⇒ 那一个 cell 的 assert 分别是：三档各自的算子名（正面）、
  //   关掉与低于估计时不许出现 Broadcast、放开时不许残留 SortMergeJoin（反向，篇 1 立的形状）、
  //   Exchange 计数（本篇新加的那一条）、`512 < est(dim)=600 < 4096 < est(big)=3,200,000`（"比的是这个数"的依据）——
  //   五处全是"阈值改的是这一格 join 的计划形状，而它比的是编译期规模估计"这一句话的不同侧面；
  // shuffle-partitions-is-a-plan-number = 计划里那个 shuffle 分区数是配置写的、不是数据要的：
  //   同一格的 assert 是 AQE 关这个前提、`getNumPartitions()` 200/8 两头、计划文本里 `hashpartitioning(键, N)` 的 N 跟着动、
  //   "两头都跑过"那条、以及空桶对照（@200 桶只落 44 个非空文件）—— 前四条是正面+对照，最后一条是那句话的下半句；
  // aqe-coalesces-shuffle-read = AQE 把聚合那次 shuffle 的**读侧**分区合并了（实测 200 → 1），且依据是它自己产出的运行时统计：
  //   assert 是"执行前/只 count() 之后 formatted 文本里没有 AQEShuffleRead"（顺序判据，实测）+
  //   "finalize 之后有 == Final Plan == 与 AQEShuffleRead" + "读侧分区数 < 计划里的数" + Statistics 那行可解析出字节数；
  // aqe-coalescing-is-one-switch = 决定合并的是 coalescePartitions 那一个**子**开关，不是 adaptive.enabled 大开关：
  //   三格对照 (关,开)→200 / (开,开)→1 / (开,关)→200 逐位相等，另加两条痕迹对照
  //   （关掉子开关时 ShuffleQueryStage 与 Statistics 仍在 ⇒ 统计照收、只是不合并；关掉大开关时它们整层消失）。
  // ⚠ 这一篇没有 aqe-not-always-faster 那条 slug：它押的是 `coalesced < planned and t > 0`，前半与上一条重复、
  //   后半恒真（Ruling(B1) 已否）。"更少分区 ≠ 更快"只活在 notebook 的 markdown 里，本机实测方向反倒是 AQE 更快。
  '03-reading-the-plan-and-aqe.ipynb': ['broadcast-threshold-changes-join', 'shuffle-partitions-is-a-plan-number', 'aqe-coalesces-shuffle-read', 'aqe-coalescing-is-one-switch'],
  // 篇 4（WI-108）。五本"内存账"各一条 slug；与篇 1-3 刻意不重叠（倾斜 / 小文件 / AQE / 计划文本那边都讲过了，这篇只讲内存与配置的账）。
  // 每条判据都是"同一镜像每次跑都给同一个东西"的那一类；墙上时间一条都不 assert（只打印 —— Ruling(B1) 的规矩，篇 1-3 先例）。
  // heap-ceiling-is-boot-time = 一句"driver 堆上限是**启动期**锁死的实体，不是运行时可改的配置"。三条 assert 三面：
  //   `maxMemory() == 512*1024*1024`（上限就是 kernel.json 里那句 `--driver-memory 512m`；逐字节相等顺带量了"512m 解析成 512 MiB"）、
  //   `spark.conf.set("spark.driver.memory","2g")` 抛 `AnalysisException` 且消息含 `CANNOT_MODIFY_CONFIG`
  //     ⚠ 用 except + 两条 assert，不许裸 except 吞掉：吞掉之后"没抛"与"抛了但没判"长得一模一样（简报 §3 第一行同判）；
  //   set 之后 `maxMemory()` 逐字节不变（"改了也没用"要有读数，不能只靠正文那一句）。
  // conf-default-is-type-checked = 一句"SQLConf 的双参 `get(key, default)` 会**给默认值做类型校验**，且你传的那个
  //   default **顶替的是注册项自己的缺省值** ⇒ '读不到就回缺省'这条路在 int 键上是炸的、在其它键上是骗人的"。
  //   四条 assert 是四格对照（⚠ WI-108 落地轮按第三/四轮**新量**的读数把简报那一格对照扩成了整套，见报告"新量到的读数"）：
  //   `get("spark.sql.shuffle.partitions") == "200"`（单参读得到注册项缺省）、
  //   `get(同一个 int 键, "(unset)")` 抛 `IllegalArgumentException` 且消息含 `should be int`（正面：默认值要过该键的类型转换）、
  //   `get("spark.driver.memory", "(unset)")` **不抛且回 "512m"**（对照：raw 层有值 ⇒ 你传的 default 被忽略；简报只给了这一格）、
  //   `get("spark.sql.extensions", "(unset)")` 回 "(unset)" 而单参回 Python None（对照：字符串型注册键不过校验，
  //     而"回默认"在这里恰恰是**骗人**：那个键的行为是"没设过"，不是"(unset)"）。
  // local-mode-has-no-executor-account = 一句"local 模式下'executor 内存'这本账**压根不存在**，而 `defaultParallelism`
  //   有活值却没有配置项"。五条 assert：`sc.defaultParallelism == 2`（活值）、
  //   `sc.getConf().get("spark.default.parallelism","(unset)") == "(unset)"`（同一个东西换处读法就没了 ⇒ 这两条押的是
  //   **同一个键的两种读法不一致**，正是"读不到所以没配"那种误判的解毒剂）、
  //   `spark.conf.get("spark.executor.memory")` 抛（SQLConf 里没有这个键）、
  //   `sc.getConf().get("spark.executor.memory","(unset)") == "(unset)"`（SparkConf 里也没有 ⇒ 不是读法不对，是这本账不存在）、
  //   `sc.getConf().get("spark.driver.memory") == "512m"`（对照：driver 那本账存在且有名字）。
  // topandas-peaks-above-its-result = 一句"`toPandas()` 花的是**转换过程中的副本**，不是结果的大小"。N = 2_000_000，
  //   ⚠ slug 里那个 P 是**被迫小写**的（WI-108 落地轮实测）：本文件那条常驻形状判据 `/^[a-z0-9][a-z0-9-]{2,60}$/`
  //   与 `tutorials.test.ts` 的 `printedSlugs()` 那张反向正则都只收小写 ⇒ 写作 `toPandas-…` 时**宿主档就地红**，
  //   而且反向核对会看不见那条 marker（它抓的是 `[a-z0-9…]`）。形状判据住在不许我改的那个文件里，
  //   所以改的是 slug：只动大小写，不动词。
  //   七条 assert：`memory_usage(deep=True)` 的列 = N*itemsize、总和 = 列 + index（净大小可纯算 ——
  //     ⚠ 简报 §3 写的是 `sum() == N * 8`，实测 16,000,128 ≠ 16,000,000：RangeIndex 那 128 字节也在 deep
  //     用量里，等号按读数改成"可纯算的那两条"，见报告"简报里哪一句是错的"）、
  //   `VmHWM 增量 >= 4 × 净大小`（保守下界；六次实测 35~36×，押下界而不是那个倍数）、
  //   `abs(ru_maxrss - VmHWM) <= 2048`（两把尺量的是同一个高水位；容差是因为两次读数之间后台线程会碰页，
  //     六次实测差值都是 0，但逐字相等属于"押 MB 级噪声"那一类）、`hwm_did_not_drop is True`（定义保证）、
  //   同一瞬间 `VmHWM - VmRSS >= 100_000` kB（"两把尺差一个数量级"才是可押的那一条；六次实测 457k~461k kB）。
  //   ⚠ 落地时**撤掉过一条**（实测推翻，不是偷懒）：`assert rss_rel < rss_after` —— del+gc 之后 VmRSS 的
  //   降幅六次实测是 +3,020 / +1,696 / +1,712 / +732 / +700 / **-324** kB，最后一次不降反升 ⇒ 容器档真的
  //   红过一次（`cell 9: AssertionError`）。MB 级的释放会被后台线程盖掉，押它得到的是一条每次跑可能翻转的
  //   冤红 ⇒ 换成上面那条"同一瞬间的差"，降幅只打印。同类的还有"账落在 Python 侧"那半句（collect 与
  //   toPandas 各自的 heap 增量 vs RSS 增量）：**只打印不 assert**，由 ④b 那一格当场量给读者看
  //   （CITE 规矩：正文敢说"实测"的必须有一格打出来；④b 因此是**无 marker 的打印格**）。
  // container-limit-is-absent-here = 一句"本机这个容器**没有** memory limit ⇒ `OOMKilled` 那一族失效模式在这台机器上
  //   不存在，能观测到的只有 JVM 堆异常；这是通向 K8s 那本账的分界，不是缺陷"。三条 assert：
  //   `/sys/fs/cgroup/memory.max` 连读三次且 `set(三次) == {"max"}`（⚠ 简报给的判据是
  //   `len(set(...)) == 1`，那一条**三次都读到异常字符串也会点头** ⇒ 落地时收紧成"既稳定、又确实是 max"；
  //   红在这里要说清是"compose 加了上限 / cgroup 布局变了"，即**正文过期**，不是判据太严）、
  //   `memory.events` 里 `oom_kill == 0` 且 `oom == 0`（事件计数器：本机连"逼近过上限"都没发生过）。
  //   ⚠ CPU 那本账（`availableProcessors() == 16` 而 `defaultParallelism == 2`）**只打印**：核数是宿主机的、
  //   并行度是 kernel.json 写的，两者不等是设计如此 —— 押它等于把结论写成"这台机器配错了"。
  // ⚠ 这一篇**没有** pyarrow 那条 slug：`pandas_udf` 在本镜像是 ImportError（PyArrow >= 4.0.0 must be installed），
  //   那是"为什么本篇不用 pandas_udf 量 Python worker"的前置说明、不是一条方向性结论 ⇒ 只活在 ⑤ 那节 markdown 与
  //   一格**只打印** `try_import(...)` 的读数里（没有结论就没有 marker：给"这个包没装"发 marker 等于让注册表
  //   为一个与判题无关的事实承担双向相等）。
  '04-memory-accounts-and-the-boot-time-ceiling.ipynb': ['heap-ceiling-is-boot-time', 'conf-default-is-type-checked', 'local-mode-has-no-executor-account', 'topandas-peaks-above-its-result', 'container-limit-is-absent-here'],
};

/**
 * 单篇教程的执行预算（**毫秒**）。规格给的目标是"单篇 ≤ 90s"，这里留 120s 是余量不是预算。
 * 注意单位：nbclient 的 `--ExecutePreprocessor.timeout` 按**秒**算，所以传出去之前要除 1000
 * （那一步与"除完的量级还在 30~600 之间"由 `tutorials.test.ts` 常驻那组判住）。
 */
export const TUTORIAL_TIMEOUT_MS = 120_000;

/**
 * marker 的字面形状（规格 §6 / 计划 Ruling(B1)：`WI90[<篇>][<结论 slug>] OK`）。
 * 教程那边是手敲的 `print("WI90[01-skew-and-hot-keys][salting-wins] OK")`，闸门这边按它核对 ——
 * 两边唯一的粘线就是这个函数，所以它的格式由 `tutorials.test.ts` 里那份**独立字面量基准**判住：
 * 有人把它改成别的写法（"更清晰"），红在 45s 的宿主档并说出该改哪一边，
 * 而不是让容器里每条 marker 断言红着指责一篇没坏的教程。
 */
export function markerOf(file: string, slug: string): string {
  return `WI90[${file.replace(/\.ipynb$/, '')}][${slug}] OK`;
}
