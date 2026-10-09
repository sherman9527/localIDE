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
