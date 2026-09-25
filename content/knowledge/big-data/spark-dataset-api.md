# Scala Dataset API：什么时候该用 typed Dataset

考点定位：大数据处理（Spark）· senior / principal · 2026 年后端面试里"会不会写 Spark"的分水岭。

## 三条主线

1. **DataFrame vs typed Dataset**
   - DataFrame 是 `Dataset[Row]`：编译期不检查列名/类型，错到运行时才炸。
   - `Dataset[T]` 把类型检查提前到 `scalac`：`as[T](Encoders.product[T])` 之后，字段拼错、类型不匹配都是编译错误。
   - 代价：case class 必须是顶层/稳定作用域，且 `Encoders.product[T]` 依赖运行时反射拿 schema（Scala 3 下要显式给 `deriving Encoder`）。

2. **`groupByKey + mapGroups` 的真实代价**
   - 语义：按 key shuffle 后，在**executor 内**对每组迭代处理 —— 这是它比 window 函数灵活的地方（可以写任意状态机）。
   - 代价：全量数据要按 key 落到单个分区/单组，**热 key 直接倾斜**；`mapGroups` 内部不能并行拆一组。
   - 与 `window` 的取舍：能用 `row_number/lag` 表达的连续性问题优先用 window（Catalyst 能下推、AQE 能拆倾斜）；只有"组内需要跨行状态"才上 `mapGroups`。
   - 与 UDF 的取舍：UDF 对 Catalyst 是黑盒（不能下推、不能列裁剪）；`mapGroups` 至少保留 typed schema。

3. **日期与边界**
   - `LocalDate` 没有隐式 `Ordering`：按 `toEpochDay` 排成 `Long` 再比较相邻差 1，跨年/闰日自然正确。
   - 空分区/空组：`mapGroups` 对空 key 不产出行 —— 断言"零行"而不是"零值"。
   - 同日重复：先 `distinct` 再算连续，否则"重复事件"会被当成连续活跃。

## 面试追问点

- shuffle 发生在哪一步？（`groupByKey` 之后；`Encoders.STRING` 决定 key 的序列化）
- 为什么不能 `collect()` 到 driver 再算？（单用户全量事件进 driver 内存，OOM 且丢掉并行）
- 热 key 怎么办？（两阶段聚合 / 加盐前缀 / AQE `skewJoin`；说清哪种能用在 `mapGroups` 上、哪种不能）
- 为什么 `spark.sql.shuffle.partitions` 对这段代码影响特别大？（组数 = key 基数，分区过少会让大组挤在少数 task）

## 出题与判分约定（本仓库）

`judgeKind: spark-scala` 要求 `object <runner.className>` 暴露 `def solve(df: DataFrame): DataFrame`；
harness 直接引用它，所以**签名写错会在编译期报错**，不用反射猜。用例契约与 `pyspark` 完全一致
（`input = {rows, schema, view?}`，`expected = 行对象数组`），值归一化两边逐条对齐，
同一道题换栈不会因为 `"4"` / `"4.0"` 判出不同结果。
