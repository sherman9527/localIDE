# 图 / DP / 回溯的实现工程与对抗性判分设计

语言级别：Java 17 基线 + 21/22 可选写法。判分：`java-junit`（含"必须失败"的反向用例）+ `llm-rubric`（复杂度论证与用例设计）。
这一族是"算法题"最容易被写坏的：思路人人会，**规模、栈、内存、数值、确定性**才是 senior/principal 的真实工作面。

---

## 1. 核心机制

### 1.1 图的表示：一个决定成败的选择题
| 表示 | 代码 | `n=2e5, m=5e5` 的实际成本 | 适用 |
| --- | --- | --- | --- |
| `List<List<Integer>>` | `g.get(u).add(v)` | 2e5 个 ArrayList（每个 header ~24B + 内部数组）+ 5e5 个 `Integer` 装箱 ≈ 30-40MB，遍历含虚调用与指针跳跃 | 只在 `n<=1e4` 时用 |
| `int[][]`（先数度再分配） | 两遍：`deg[u]++` → `new int[deg[u]]` → 填 | ~2MB + 2e5 个小数组，遍历是纯数组访问 | 静态图、无删除 |
| 前向星 CSR | `int[] head, to, next`（或 `to, weight`） | 单块连续内存，~6-10MB；`for (int e=head[u]; e!=-1; e=next[e])` | 带权、需要增量/边属性、竞赛级实现 |
| `Map<Integer,List<Integer>>` | 稀疏图 | 装箱 + 哈希 | 只在节点编号极大且稀疏时 |
| 隐式图 | 状态空间 BFS（不建表） | 决定于状态数 | 网格/谜题/位掩码 |

- 建 `head` 必须 `Arrays.fill(head, -1)`（默认 0 会把"无边"误当成"0 号边"，是 CSR 最经典的 bug）。
- 无向图记得 `m*2`；重边、自环要显式定义行为（题面里必须写死，判分用例覆盖）。
- `Arrays.sort` 排序边数组做 Kruskal：`int[][]` 排序是 TimSort（对象数组），`m=5e5` 时装箱/比较开销显著。省对象的正解是**把排序键打包进 `long[]`**：`keys[e] = ((long) w << 32) | (e & 0xffffffffL)`，然后 `Arrays.sort(keys)`、用 `(int) keys[i]` 反查原始边。为什么正确：`long` 的有符号比较等价于"先比高 32 位（有符号，即 `w`）、再比低 32 位（无符号，即边号）"，所以**不需要给 `w` 加偏移**（加 `w - Integer.MIN_VALUE` 反而会让 `w >= 0` 的部分把符号位顶起来、序错）。前提是 `w` 能进 `int`、边数 `< 2^32`；**把 `u/v` 也塞进同一个 `long` 只在位宽够时成立**（例如 `n<=2^18`、`w<=2^28`），别在 `w` 到 `1e9` 时还写 `(w<<40)|...`（只剩 24 位，直接错）。**这是能区分"写过一个真的图引擎"的题眼。**

### 1.2 遍历：栈、队列与"不能用递归"的判据
- 递归 DFS 的深度上界由**线程栈**决定：默认 512KB/1MB 下，一个带局部变量的帧 ~48-96B，`1e5~1e6` 层就 `StackOverflowError`；`StackOverflowError` 是 `VirtualMachineError`，**捕获它不可靠**（栈可能已不足以走 catch 块），只能靠"不递归"来防。
- 判据：**输入规模无上限或有对抗性长链** → 必须迭代 + 显式栈。显式栈要携带"迭代器游标"才能表达后序（否则只能做前序）：
```java
record Frame(int u, int nextChildIdx) {}           // 21；17 用两个 int[] 手写栈
int[] stackU = new int[n], stackI = new int[n];
```
- BFS 分层用"本轮队列大小"而不是把 depth 塞进节点（少一个字段、少一次数组写）。`ArrayDeque` 不能存 `null`，且 `peekFirst/peekLast` 语义区分要清楚。
- 拓扑排序：Kahn（`int[] indeg` + `ArrayDeque`）天然能判环（`count < n` 即有环）；DFS 后序 + 反转也能，但需要三色标记（白/灰/黑）才能区分"回边"与"已完成的交叉边"，把 `visited` 当 `inStack` 是**假阳性环检测**的常见 bug。
- 字典序最小拓扑：把队列换成 `PriorityQueue`（O(m log n)）；能说出"Kahn + 优先队列"与"DFS + 反向邻接表 + 优先队列"两种解的差别是 senior 信号。

### 1.3 DP：内存、初值与数值
- 一维化：`int[][] dp` → `int[] dp` 并把转移顺序写成"倒序（0/1 背包）/正序（完全背包）"，能解释为什么方向决定"同一物品被重复选"。
- `n` 维滚动时保存 `prev/prevPrev` 引用交换（`int[] tmp = prev; prev = cur; cur = tmp;`）比索引取模快且少一个 `Arrays.fill`。
- 不可达标记：`-1` 与合法值 `-1` 冲突；`Integer.MIN_VALUE` 参与 `+1` 溢出。正解：用 `MIN_VALUE + 1` 当哨兵，或分离 `boolean[] reachable`，或用 `long` 域把哨兵放在不可能值（如 `Long.MIN_VALUE/4`）。
- 计数 DP 的溢出：`MOD = 1_000_000_007`；`a + b` 在 `int` 域可能溢出（两个 `< MOD` 的和 `<= 2e9+14 > 2^31-1`！）→ 必须 `long` 中转或用 `int s = a - MOD + b; s += s < 0 ? MOD : 0;` 的防溢写法。**"两个 `1e9+6` 相加会溢出 `int`"是最便宜的高区分度用例。**
- 状态压缩：`1<<n` 的 `n<=20`（`int`）/`n<=30`（`long` 也不够，`1<<31` 是负数）；TSP 的 `dp[1<<n][n]` 在 `n=20` 时是 `1,048,576*20*4B = 80MB` → 会 OOM，需要 `n<=18` 或换 `short`/分层。
- 单调队列优化 DP（`O(nk)`→`O(n)`）与 `Arrays.parallelPrefix`（前缀扫掠）是"会不会优化"的分层点。

### 1.4 回溯与剪枝
- 路径容器：复用一个 `int[] path` + `depth` 指针（O(1) 撤销），不要每层 `new ArrayList<>(cur)`（O(k) 复制 → 总量 O(k·节点数)）。收集结果时才 `Arrays.copyOf(path, depth)`。
- 去重前提：先排序，再 `if (i > start && a[i] == a[i-1]) continue;`；能解释为什么"用 `Set` 去重"在含大量重复时更慢且掩盖了排序前提。
- 剪枝三类：可行性（剩余不够）、最优性（当前代价已 ≥ best）、对称性（固定第一个元素）。**剪枝必须给出正确性论证**（principal 的 `rubric` 点）。
- 位运算 N-Queens：`cols | d1 | d2` 的"可用位"写法 `int avail = ~(cols|d1|d2) & mask; while (avail != 0) { int p = avail & -avail; avail -= p; recurse(cols|p, (d1|p)<<1, (d2|p)>>>1); }` —— `>>>` 与 `<<` 的方向、`mask` 边界（`n=32` 时 `(1<<32)-1 == 0`）是判分点。
- 递归深度与规模关系：回溯题的递归深度 = 决策长度（一般安全），但**单词搜索/网格路径**类递归深度可到 `n*m` → 必须迭代或声明栈前提。

### 1.5 I/O 与判分环境（写题面时必须约定）
- 本题库判分**不走 stdin**（用例直接注入 `int[]`/`String[]`），因此"快读"不是判分点；但若某题要求处理 `String` 大输入，加分点是"不用 `Scanner`（正则解析，慢 10-100 倍）而用 `BufferedInputStream` 手写 `nextInt`"，以及"输出用单个 `StringBuilder`，不要 `System.out.println` 逐行"。
- 内存/时间上限由 runner 提供：`java -Xss`（默认）+ JUnit `@Timeout`。**判分不要用墙钟证明复杂度**（容器抖动）；用规模上界 + 暴力必然超时的构造。
- 确定性：`Locale.setDefault(Locale.ROOT)`、不依赖 `HashMap` 迭代序、不依赖 `System.identityHashCode` 排序、`Random` 换成固定 seed 的 `SplittableRandom`、`Double` 输出保留误差容限（`isClose(expected, within(1e-6))`）。

### 1.6 对抗性用例设计（本文件的核心）
好的用例是"能让特定错法必炸"的用例。给一张映射表，出题时按列查：
| 目标错法 | 构造输入 | 断言形式 |
| --- | --- | --- |
| 快排退化（`Arrays.sort(int[])`） | 已排序/逆序/大量重复 + 平台段，规模 `1e6` | `@Timeout` 兜底 + 结果正确性 |
| 比较器减法溢出 | 含 `Integer.MIN_VALUE`/`MAX_VALUE` 的键 | 结果序 + `assertDoesNotThrow`（TimSort 契约违例是偶发的，需 `@RepeatedTest(20)` 或固定 seed 打乱后重排） |
| `int` 累加溢出 | 元素值域顶到 `1e9`，`n=2e5` | 期望值用 `long`/`BigInteger` 独立算出，`assertThat(actual, is(expected))` |
| 负数取模 | 含负坐标 | `Math.floorMod` 语义 vs `%` 语义差异 |
| 递归爆栈 | 长度 `2e5` 的链式图/退化树 | `assertDoesNotThrow`（迭实现通过、递归实现抛 `VirtualMachineError`） |
| `visited` 当 `inStack`（假环） | DAG 但含交叉边（钻石形） | 期望"无环"，实现抛错/返回空 |
| 拓扑不判环 | 含自环、双节点环 | 返回空数组/`Optional.empty()` 的约定 |
| Dijkstra 用于负权 | 含负边（无负环）与含负环两组 | 分别期望"正确答案"与"检测到位移为负环的哨兵" |
| `dist` 溢出 | 边权 `1e9`、路径 `1e5` 条边 | 结果 `1e14` 级，`int` 实现返回负值 |
| DP 哨兵污染 | 存在"合法值为 -1"的输入 | 期望区分不可达 |
| HashMap 序依赖 | 两个不同插入顺序、同一集合 | 输出必须一致 |
| 边界空输入 | `null`（题面规定抛 `NullPointerException` 还是按空处理）、`[]`、单元素、全相同、极值 | `assertThrows`/结果 |

**property-based 的落地**（不需要外部依赖）：固定 seed 生成 2000 组输入 → 与"朴素但显然正确的参照实现"对拍 → 只断言相等（不打印大输入，避免超出判分回传长度；失败时回传 seed 与最小化前的规模）。反例最小化可以放 `rubric`（要求候选人手工给出最小反例）。

---

## 2. senior / principal 会被追问什么
1. "这个题 `n=2e5`，你的实现的**最坏**与**平均**分别是？"—— 必须分别给，并说明分布假设。
2. "为什么不用递归？" → 要求给出栈帧成本估算和 `StackOverflowError` 的不可捕获性。
3. "内存预算：`n=1e6` 时你的 `int[][]` 具体多少字节？数组头算了吗？" → `16B header + 4B*len` 对齐到 8B；外层 `int[n][]` 本身也是 `16 + 4n`。
4. "你的剪枝会不会剪掉最优解？证明给我看。"
5. "主从/多分片场景下这类计算怎么做增量？"（DP/图题的生产化追问：全量重算 vs 拓扑序增量传播，以及环导致的震荡）
6. "如果输入是流式的、内存只够 100MB，你怎么办？"（外部排序、Misra-Gries 近似、Count-Min、分块 + 二遍扫）
7. principal：给判分系统提要求——如何写"用例集"才能让一个错的实现**必定**被发现（等价类划分 + 边界 + 退化 + 反排序/反顺序敏感），以及如何避免"用例本身写错导致正确答案被判负"（自校验：参考实现必须过全部用例 + 至少一个"故意写坏"的实现必须被杀，即变异测试思路）。

---

## 3. 常见错误答案

| ❌ 做法 | 真相 |
| --- | --- |
| 用 `boolean[] visited` 做 DFS 环检测 | 需要三色（或 `inStack`）；否则钻石 DAG 被判有环 |
| Kahn 里"队列空就结束"不检查 `count` | 有环时静默丢节点，返回残缺拓扑序 |
| `dist[u] == INF` 就当不可达，但用 `Integer.MAX_VALUE` 当 INF | `INF + w` 溢出变负 → 反而被认为最短 |
| Dijkstra 里"更新时 `pq.add(new long[]{nd, v})` 后不判断过期条目" | 不致错但复杂度退化；关键是**没有 decreaseKey**，靠 `if (d != dist[u]) continue` |
| 负权图用 Dijkstra | 需要 Bellman-Ford/SPFA 并显式检测负环（第 n 轮仍有松弛） |
| `dp` 表开成 `int[n][n]` 且 `n=2e5` | 必然 OOM；先算字节数再选结构（滚动/稀疏） |
| 计数 DP 用 `int` 相加再取模 | 是否溢出取决于 `MOD`：`MOD=1_000_000_007` 时两个余数相加 `2_000_000_012 < Integer.MAX_VALUE` 侥幸安全，但 `a*b`（两个 `<MOD` 的数）到 `1e18` 级**必须 `long`**；把 `MOD` 换成 `2_000_000_011` 时连加法都溢出。别凭直觉，代进去算 |
| `1 << n` 求 `mask` 时 `n=31/32` | `1<<32 == 1`、`1<<31` 为负；必须 `1L<<n` 或限制 `n<=30` |
| 在 `computeIfAbsent` 里递归建邻接表 | 同 bin 重入抛 `IllegalStateException: Recursive update` |
| 用 `PriorityQueue<int[]>` + `a[0]-b[0]` | 溢出 + 数组装箱；用 `record`/打包 `long` + `Comparator.comparingLong` |
| `System.arraycopy` 后以为深拷贝了二维行 | 只复制一层引用 |
| 用 `Arrays.sort(int[][])` 按第二列排 | `int[][]` 是对象数组（元素是 `int[]`），比较器不满足传递性时 TimSort 抛异常 |
| 判分/自测里 `Thread.sleep(100)` 等并发完成 | 不确定性；改为 `CountDownLatch`/`assertThrows`/对拍 |
| 输出顺序不声明 | 判分不可复现；必须固定"升序 / 输入序"并在题面写死 |

> 注：上表"MOD 溢出"一行故意写成**带推理的**形式——出题时不要凭"1e9 相加一定溢出"的直觉写用例，要真的代入：`int` 上限 `2_147_483_647`，`MOD=1_000_000_007` 时 `MOD-1 + MOD-1 = 2_000_000_012` 安全，但 `a*b % MOD`（`a,b < MOD`）到 `1e18` 级，必须 `long`；若要构造 `int` 相加溢出，取 `MOD = 2_000_000_011`（`<= Integer.MAX_VALUE`）或用 `1e9` 级别的非模计数。写错这一条的题目会把正确答案判负。

---

## 4. 可判分出题角度

### 题面草稿 1（`code`，`judgeKind: java-junit`，difficulty: senior）
> 实现 `public static int[] shortestPaths(int n, int[][] edges, int src, boolean allowNegative)`：`n <= 1e5`，`edges[i] = {u, v, w}`，`w ∈ [-1e9, 1e9]`。返回长度 `n` 的 `long[]` 不可变快照（**注意：返回类型是 `long[]`，测试会 `assertArrayEquals`**），不可达位置填 `Long.MAX_VALUE`（不得用其它哨兵），`allowNegative == true` 时若存在**从 `src` 可达的负环**，返回 `null` 并在消息约定内不抛异常。
> 约束：
> 1. `allowNegative == false` 走 Dijkstra：距离必须 `long`，堆条目不得用 `int[]` + 减法比较（提供 `record Node(int v, long d) implements Comparable<Node>`，21；或 `Long.compare`）；
> 2. 必须跳过过期堆条目；
> 3. 图的内部表示自选，但**必须处理重边与自环**（自环 `u==v` 且 `w<0` 即负环）；
> 4. `n=1e5, m=2e5` 的用例要求在 `@Timeout(5)` 内完成（暴力 Bellman-Ford 版本必然超时 → 这是复杂度的可判分证明）。

**用例设计（≥6，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `basic_dijkstra` | 手算 5 点图；`assertArrayEquals(long[])`，不可达位 `== Long.MAX_VALUE` |
| `int_overflow_dist` | 链式 `1e5` 条边、每条 `w=1e9` → 期望 `1e14`；`int` 实现返回负值必判负 |
| `negative_edge_no_flag` | `allowNegative=false` 且含负边：题面规定"行为未定义"→ 该用例改为 `allowNegative=true` 的正常 Bellman-Ford 期望值（考察候选人是否把语义读准） |
| `negative_cycle_detect` | 环 `0→1→2→0` 权重和 `-1` 且从 src 可达 → 返回 `null` |
| `negative_cycle_unreachable` | 负环在不可达分量 → 正常返回其余距离（打"全局扫一遍就报负环"的过度检测） |
| `self_loop_negative` | 一条 `u==u, w=-5` → `null` |
| `parallel_edges` | 两点间 5 条重边 → 取最小；断言不影响正确性（CSR/前向星天然正确，`Map<u,Map<v,w>>` 忘记合并会错） |
| `immutable_snapshot`（语义） | 修改返回数组后再次调用结果不变（防止缓存同一数组） |

### 题面草稿 2（`code`，`judgeKind: java-junit`，difficulty: principal）
> 实现 `public static long countWays(int[] coins, int target, int MOD)`（完全背包计数）与 `public static int[] bestCombination(...)` 只在 `target <= 30` 时要求。硬约束：
> 1. `MOD` 由调用方传入，约定 `1 <= MOD <= Integer.MAX_VALUE`。**所有相加必须在 `long` 域完成后再取模收窄**，实现不得因 `MOD` 大而抛异常、不得返回负数；`MOD <= 0` 时抛 `IllegalArgumentException`。判分用 `MOD = 2_000_000_011`：`int` 域累加（`(a + b) % MOD`，两个余数相加即达 `4e9` 级）必然溢出为负 → 判负。这把"必须用 `long` 域"从口头要求变成可判分约束；
> 2. `coins` 可含 `0`、负数、重复值：`0` → `ArithmeticException("zero coin")`（否则无限方案数）；负数 → `IllegalArgumentException`；重复值必须去重后计数（同面额视为同种，考察"重复计数"的误解）；
> 3. 一维滚动数组，转移方向必须是"正序"（完全背包），并要求候选人**注释说明倒序会算成什么**（0/1 背包），判分点：给一个"只有 1 枚可用"的变体参数 `unbounded == false` 时倒序；
> 4. `target=0` → `1`（空组合）；`target<0` → `0`；`coins` 为空 → `target==0 ? 1 : 0`；
> 5. 性能：`coins.length=100`、`target=1e5` 的用例 `@Timeout(3)`（`O(|coins| * target)` 可过；写成"枚举子集"必炸）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `classic_unbounded` | `coins=[1,2,5], target=11 → 56`（手算/参照实现） |
| `bounded_variant_direction` | `unbounded=false` 时 `[1,1], target=2 → 1`（正序实现会得 2，直接判负：证明方向理解） |
| `mod_overflow_contract` | `MOD=2_000_000_011`、`coins=[1,2]`、`target=60`：结果必须 `>= 0` 且与题目侧预先算好的 `BigInteger` 参照值逐位相等（`int` 域累加的实现会返回负数 → 判负）；同用例附带 `MOD=1_000_000_007` 对照，证明"只在少数 MOD 下侥幸正确"的实现会被杀 |
| `zero_coin_rejected` | `coins` 含 `0` → `ArithmeticException`，且发生在任何 DP 之前（用调用计数断言未做半程修改） |
| `duplicates_deduped` | `coins=[2,2,3]` 与 `[2,3]` 结果相同 |
| `empty_and_zero_target` | `coins=[]`：`target=0 → 1`，`target=5 → 0` |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 给你下面这段"看起来正确"的 `int[] topologicalOrder(List<List<Integer>> g)`（递归 DFS + 单 `boolean[] seen` + `Collections.reverse(result)`）。要求：(a) 列出所有会导致生产故障的缺陷；(b) 为每个缺陷构造**最小反例输入**；(c) 给出你自己在 `n=2e5` 生产环境里的实现（数据结构、栈、环检测、可观测性）；(d) 说明如何写用例集让每个缺陷至少被一个用例杀掉。

**points**：环检测需要三色/inStack 2｜递归深度与 `StackOverflowError` 2｜`List<List<Integer>>` 的内存/装箱成本与替代（CSR/前向星）2｜最小反例（钻石图误报环、6e5 长链、含自环、含重边）2｜用例集与"变异测试"思路（参考实现必须全绿 + 每个已知缺陷有杀手用例）2。
**bonus**：提到字典序最小拓扑需换优先队列；提到"生产里拓扑排序常配增量重算与环告警"；提到 `@Timeout` 而非墙钟；给出 `-Xss` 与栈帧大小的量级估算。
**gaps**：只说"递归改迭代"而不给规模论证；认为 `seen` 足够；把环检测写成"发现回边就 return"却没有真正 `return`（静默吞掉）；用例只给"正常图 + 空图"。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 大规模图/DP 的内存与数据结构选型 | `APL-BD-2`、`APL-BE-2` |
| 数值安全（`long`、模、溢出契约） | `APL-BE-2`、`ABNB-BE-2` |
| 栈/迭代化/`@Timeout` 判分设计 | `ABNB-BE-2` |
| 对抗用例与变异测试思维 | `APL-BE-3`、`ABNB-BE-2` |
| 生产化追问（增量重算、环告警、流式内存约束） | `APL-BE-1` |
