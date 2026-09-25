# Java 数组、字符串与数值边界（双指针 / 前缀和 / 二分 / 排序契约）

语言级别：Java 21（17 兼容写法一并给出）。判分：`java-junit`。
这一族题的区分度**不在算法思路**（5 年都写得对），而在"实现细节会不会在生产炸"：溢出、比较器契约、字符编码假设、拷贝语义、`null` 与不可变集合。

---

## 1. 核心机制

### 1.1 数组的真实语义（三个被反复答错的点）
- `int[] a = b;` 是引用拷贝；`b.clone()` 是浅拷贝（对 `int[][]` 只复制第一层！`Arrays.copyOf` 同）。二维矩阵在 Java 里是"数组的数组"，**行长可以不整齐**（`new int[n][]` 再逐行分配，可省一半内存并改善局部性）。
- `List.subList(from,to)` 与 `Arrays.asList(arr)` 都是**视图**：前者修改会回写原 list、且原 list 结构性修改后访问子视图抛 `ConcurrentModificationException`；后者是定长包装（`add` 抛 `UnsupportedOperationException`），且 `Arrays.asList(int[])` 会把整个数组当**一个元素**（得到 `List<int[]>`，size=1）——这是"传基本类型数组给泛型方法"的经典事故。
- `Arrays.sort(int[])` 走**双轴快排**，平均 O(n log n)、**最坏 O(n²)**（可构造退化输入，如"锯齿/平台型"分布）；`Arrays.sort(Object[])` 走 TimSort，**稳定**且最坏 O(n log n)。要"绝对不被打爆"就把原始数组换成 `Integer[]`（代价是装箱与指针跳跃）或先做随机洗牌。`Arrays.parallelSort` 只在大数组（默认阈值 8192）上启用并行，小数组反而多一层开销。
- 比较工具：`Arrays.compare(int[],int[])`（Java 9，字典序）、`Arrays.mismatch(a,b)`（Java 9，返回第一个不同下标，无则 -1）、`Arrays.equals` 的区间重载。它们都是被 intrinsic 优化的实现，判分题可以用"两次调用替代手写循环"作为加分点。

### 1.2 溢出与数值安全（`long` 不是护身符）
```java
int mid = (lo + hi) >>> 1;     // 对非负 lo/hi 安全；lo+hi 溢出后 >>> 得到正确无符号中点
int mid = lo + (hi - lo) / 2;  // 更直观，两者都对
long sum = a + b;              // 错：a、b 是 int，先在 int 域溢出再拓宽
long sum = Math.addExact(a, b) // 对：溢出抛 ArithmeticException（要求显式失败时用）
Comparator<Order> c = (x, y) -> x.priority - y.priority;  // 错：priority 取 MIN_VALUE 时溢出→序错乱 + TimSort 可能抛异常
```
- 累加/乘法的口径：**值域上限写进不变式**。`n<=2e5`、`val<=1e9` → 区间和到 `2e14`，必须 `long`；`a*b % MOD`（`MOD=1e9+7`）在 `long` 域安全（`<1e18 < 9.22e18`），但 `MOD≈2^63` 时不再安全（此时讨论 `Math.multiplyHigh`/`BigInteger.modPow` 的取舍）。
- `Integer.MIN_VALUE` 的专属陷阱：`-Math.abs(MIN_VALUE) == MIN_VALUE`（`abs` 溢出）、`Math.negateExact`/`Math.multiplyExact` 会抛；`Math.floorDiv/floorMod` 与 `/ %` 在负数上的差异（Java 的 `%` 结果符号跟随被除数）。
- `INF` 用 `Integer.MAX_VALUE/2` 或 `Long.MAX_VALUE/4`，永远不要在可能 `INF + w` 的位置用满 `MAX_VALUE`。
- `int` 移位陷阱：`1 << 32 == 1`（移位量按 `& 31`），`n>=31` 的位掩码必须换 `long` + `1L << n`。
- `NaN`/`-0.0`：`Math.min(NaN, x)` 返回 `NaN`（会污染整轮 DP 表）；`Double.compare(-0.0, 0.0) != 0` 而 `-0.0 == 0.0` 为 true（比较器与 `equals` 不一致）。

### 1.3 二分的唯一正确姿势：两个 bound 原语
```java
static int lowerBound(int[] a, int key) {        // 第一个 >= key 的下标（可能 = a.length）
    int lo = 0, hi = a.length;                   // 半开区间 [lo, hi)
    while (lo < hi) { int m = lo + ((hi - lo) >>> 1); if (a[m] < key) lo = m + 1; else hi = m; }
    return lo;
}
static int upperBound(int[] a, int key) { ... }  // 第一个 > key
// 派生：count(==key) = upperBound - lowerBound；count(< key) = lowerBound；插入位置 = lowerBound
```
- `Arrays.binarySearch` 在**有重复元素**时不保证返回哪个下标（文档只保证"若存在则返回其 index"），要首/尾必须用 bound；返回负值 `-(insertionPoint)-1` 的解码容易写错。
- **答案二分**（谓词单调）才是生产里最常见的形态：`f(x) = feasible(x)`，把"最小区间/最大容量/最少船数"写成一次谓词 + 一次 bound，判分点通常在"谓词内的溢出与提前退出"。
- 旋转数组 + 重复元素：退化为 `s[left]==s[mid]==s[right]` 时 `right--`，最坏 O(n)——能说出这个下界是 senior 与中级分水岭。

### 1.4 字符串与字符：`char` 不是"一个字符"
- `String.length()` 是 **UTF-16 code unit** 数；`'👍'` 占 2 个 code unit（1 个 code point）。反转/截断字符串必须按码点走，否则产出**孤立代理对**（渲染成 ``，并且 `new String(bytes, UTF_8)` 会替换成 `U+FFFD`）。
  ```java
  int n = s.codePointCount(0, s.length());
  for (int i = 0, off = 0; i < n; i++) { int cp = s.codePointAt(off); off += Character.charCount(cp); }
  ```
- 频次表的空间假设必须写进不变式：ASCII 128 / Latin-1 256 / BMP 65536（`int[65536]` = 256KB，套在 `n=1e5` 的循环里就是 25GB 的分配洪水）/ 码点空间要用 `HashMap<Integer,Integer>` 或 `CodePoint` 归一化 + 排序比较。
- `chars()` vs `codePoints()`（前者按 code unit，会拆代理对）。
- `trim()` 只去 `<= ' '`；`strip()` 按 Unicode `Character.isWhitespace`（能去 U+00A0、全角空格）。
- `String.split(regex)` 走正则且**默认 limit=0 → 丢尾部空串**：`"a,b,,".split(",")` 长度 2；要 4 必须 `split(",", -1)`。含正则元字符的分隔符（`"."`、`"|"`、`"$"`）要么转义（`Pattern.quote`）要么换 `StringTokenizer`/手工 indexOf。`split` 每次都会 `Pattern.compile`（热循环里是真实开销，Java 7u2 起对单字符非元字符有 fast path，但 `"."` 不在 fast path）。
- 拼接：`+` 在**单表达式**里被 `StringConcatFactory`(Java 9) 折叠成 `StringConcatFactory.makeConcatWithConstants`，性能可接受；但在循环里 `s += x` 每轮新建 builder + 新数组，O(n²) 复制。`StringBuilder` 预分配 `new StringBuilder(2*n)`；`String.join(delim, parts)` / `StringJoiner(prefix,suffix,delim)` 才是"分隔符只在中间"的正确工具（自己写 `if (i>0) sb.append(',')` 是新人味）。
- `String.intern()` 把字符串放进**堆上的**字符串表（Java 7 起），大量 intern 会撑爆 Metaspace/StringTable 并引入 GC 压力；比较逻辑一律 `.equals()`/`compareTo`，别依赖 `==`。
- `equals/hashCode` 与 `==`：`Integer` 缓存只覆盖 `-128..127`（可用 `-XX:AutoBoxCacheMax` 改），所以 `a == b` 对 `Integer` 是随机正确。这是"能过 3 个用例、隐藏用例炸"的头号原因。

### 1.5 拷贝与不可变（判分经常直接卡在这里）
| API | 语义 | 事故 |
| --- | --- | --- |
| `List.of(...)` | 真正不可变，**拒绝 null**（`NullPointerException` 而非静默） | 返回 `List.of()` 后 caller `add` → `UnsupportedOperationException` |
| `Arrays.asList(a)` | 定长**视图**，写穿透到数组 | 内部 `set` 改了调用方数据 |
| `subList` | 视图 | 排序子视图 = 排序原数组的一段 |
| `List.copyOf(c)`（Java 10） | 快照 + 不可变 + 去 null | 是唯一"防御性拷贝 + 不可变"的正确答案 |
| `Collections.unmodifiableList(l)` | 只读**包装视图**，源变则它变 | "返回不可变"被测试用 `src.add(...)` 打穿 |

---

## 2. senior / principal 会被追问什么
1. "你这段 `a-b` 比较器在 `priority` 取值域是什么时安全？"——要求给出**取值域证明**而不是"一般没问题"。
2. "输入里全是同一个元素/已排序/逆序/锯齿时，你的实现复杂度分别是什么？"（快排退化、TimSort 的 run 检测、`computeIfAbsent` 的递归）
3. "为什么不能用 `char[256]` 频次表？" → 要求指出 `é` 的组合形式（NFC vs NFD）与 BMP 外字符；给出"归一化 + 码点表"的方案。
4. "你的 `long` 上界证明：最坏情况下累加到多少？" 要求写出 `n * maxVal` 的代入。
5. 内存局部性：为什么 `int[] dp` 一维化比 `int[][]` 快（数组对象头 16B + 指针跳跃），`n=2e5` 时 `int[n][n]` 会不会 OOM（会，且 `OutOfMemoryError` 的报错点常常在别处）。
6. 输出契约：返回 `List<Integer>` 还是 `int[]`？为什么"返回 `List.of()` 表示空"和"返回 `null`"在判分用例里差异巨大（`List.of()` 让 caller 的 `add` 崩，测试里必须断"空集合可被 caller 安全消费"）。
7. principal：给一份"看起来对"的实现，要求写出**能证明它错的最小输入**（这是本类别最重要的 `rubric` 题型）。

---

## 3. 常见错误答案

| ❌ 写法/说法 | 后果 | ✅ 正确 |
| --- | --- | --- |
| `(lo+hi)/2` | `int` 溢出为负 → `ArrayIndexOutOfBounds` 或死循环 | `lo + ((hi-lo) >>> 1)` |
| `Comparator = (x,y) -> x.v - y.v` | `Integer.MIN_VALUE` 参与时溢出，序错乱；TimSort 可能抛 *"Comparison method violates its general contract!"* | `Integer.compare(x.v, y.v)` / `comparingInt(T::v)` |
| 比较器里 `if (a==b) return 0;` 用 `==` 比对象 | 只有缓存区间内成立 → 偶发排序错乱 | `Integer.compare` / `Objects.equals` 走 `equals` |
| 自写比较器"先比 A 再 `return -1` 兜底" | 违反反对称性（`cmp(x,y)` 与 `cmp(y,x)` 不反号） | 逐字段 `thenComparing` |
| `s.split(".")` 想按点切分 | `.` 是正则通配 → 返回空数组 | `split(Pattern.quote("."))` / `split("\\.")` |
| `"a,b,,".split(",")` 期望长度 4 | 得 2 | `split(",", -1)` |
| 用 `chars()` 统计 emoji 个数 | 拆代理对，计数翻倍 | `codePoints().count()` / `codePointCount` |
| 循环里 `s += x` | O(n²) 复制 | `StringBuilder` 预分配 |
| 返回 `subList` 给调用方 | 视图：原 list 一改就 `CME`，且持有整个原 list 内存 | `new ArrayList<>(list.subList(...))` 或 `List.copyOf` |
| `Arrays.sort(int[])` 声称"最坏 O(n log n)" | 双轴快排最坏 O(n²) | 说明退化构造 + 缓解（洗牌/换 `Integer[]`） |
| 累加先 `int` 再赋给 `long` | 溢出已发生 | `(long) a + b` 或 `Math.addExact` |
| `Math.abs(Integer.MIN_VALUE)` | 仍是负数 → DP 表被污染 | `Math.negateExact`/换 `long` |
| 用 `HashMap` 迭代顺序拼输出 | 跨 JDK 版本不稳定，判分不可复现 | 需确定序就用 `TreeMap`/排序后输出 |
| `dp` 初值 `-1` 表示"不可达"同时 `-1` 也是合法答案 | 语义冲突，返回错值 | 用哨兵 `Integer.MIN_VALUE+1` 或独立 `boolean[] seen` |
| `int mask = 1 << 32` | 实为 `1`（移位取模 32） | `1L << n`，`n <= 62` |

---

## 4. 可判分出题角度

角度族：① 溢出契约（明确要求"溢出必须抛 `ArithmeticException`"，用 `MIN_VALUE` 边界判负）；② 比较器契约（隐藏用例给 `Integer.MIN_VALUE` + 等值群，检测 TimSort 异常）；③ 码点/归一化；④ 拷贝语义（返回可变性断言）；⑤ 复杂度对抗（给"退化输入"规模 2e5，暴力 O(n²) 超 `@Timeout`）。

### 题面草稿 1（`code`，`judgeKind: java-junit`，difficulty: senior）
> 实现 `public static List<List<String>> groupAnagrams(String[] strs)`：把互为字母异位的字符串归为一组，**组内顺序 = 输入顺序，组间顺序 = 该组首次出现的输入顺序**，并遵守以下硬约束：
> 1. 只能使用码点级统计（不得假设输入是 ASCII；`strs[i]` 可包含 emoji 与组合附音符）；
> 2. 归一化：比较前做 NFC 归一化（`java.text.Normalizer.normalize(s, Normalizer.Form.NFC)`），`"café"` 的合成式与分解式必须同组；
> 3. 每组返回的 list 必须是**可变的**（测试会对返回值 `add`）；整体外层 list 必须是**不可变**的（测试断言 `add` 抛 `UnsupportedOperationException`）；
> 4. `null` 元素视为独立一组（不得抛 NPE，不得与 `""` 同组）；
> 5. 复杂度：`O(totalLen * log alphabet)` 或更优，`n = 2e4`、总长 `2e6` 必须在时限内。

**用例设计（≥4，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `basic_order` | 分组内容与组内/组间顺序严格匹配（考"首现顺序"，HashMap 序必错） |
| `nfc_equivalence` | `"café"`（U+00E9）与 `"cafe\u0301"` 同组 |
| `non_bmp` | `"👍a"` 与 `"a👍"` 同组、且 `"👍"` 与两个 `'\uD83D'` 单独 code unit 的串不同组（考 `codePoints` 而非 `chars`） |
| `null_and_empty` | `[null, "", null, ""]` → 两组，各自 size 2，无 NPE |
| `mutability_contract` | 内层 `add("x")` 成功；外层 `add(...)` 抛 `UnsupportedOperationException`（用 `assertThrows`） |
| 规模用例 | `n=2e4` 随机码点串 + `@Timeout(3)`（判"用 `sorted(s)` 生成 key"的 O(L log L) 是否可接受） |

### 题面草稿 2（`code`，`judgeKind: java-junit`，difficulty: principal）
> 实现 `public static int minShips(int[] weights, int capacity)`：把货物按原顺序装船（每船载重上限 `capacity`，顺序不可拆），求最少船数；并实现 `public static int minCapacityFor(int[] weights, int maxShips)`（二分答案）。硬约束：
> 1. `weights[i]` 与 `capacity` 均为 `int`，**任何中间累加不得静默溢出**：会溢出时必须抛 `ArithmeticException`（用 `Math.addExact`），不得返回错误结果；
> 2. 若存在 `weights[i] > capacity`，返回 `-1`（不得抛异常，这是业务失败不是契约失败）；
> 3. 二分的谓词必须写成"给定船数求最小容量"或"给定容量求最少船数"其中之一，并要求 `minCapacityFor` 在最坏情况下调用谓词次数 ≤ `⌈log2(Σw)⌉ + 2`（通过注入计数代理 `PredicateSpy` 断言）；
> 4. 空数组：`minShips → 0`，`minCapacityFor(…, 0) → -1`。

**用例设计（≥4，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `hand_verified` | `weights=[1,2,3,4], cap=5 → 2`；`cap=4 → 3` |
| `overflow_throws` | `weights=[2_100_000_000, 2_100_000_000]`、`capacity=Integer.MAX_VALUE`（单件均不超限）→ 同船累加 `4.2e9` 必然溢出：`assertThrows(ArithmeticException.class)`（专打"先用 `int` 累加再赋给 `long`"的错法） |
| `single_item_exceeds` | 返回 `-1` 且谓词未被调用（`spy.calls()==0`） |
| `binary_search_call_budget` | `maxShips=1`、`Σw≈1e9`：断言谓词调用次数 ≤ 上界（证明候选人真做了答案二分而不是线性试） |
| `monotonic_predicate` | 给一个"非单调"的坏 `maxShips`（如 `0`）→ `-1`，且不得死循环（`@Timeout(2)`） |
| 边界 | `capacity == max(weights)`、`maxShips == n` 两个端点分别落在二分边界上 |

---

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 给定代码：用 `Arrays.sort` + 自写比较器（`a[1]-b[1]`）做区间合并，且对 `subList` 结果直接返回。要求：(a) 指出 4 个会导致生产事故的点；(b) 为每个点给出**最小反例输入**；(c) 给出改写；(d) 说明如何把这些反例固化成 JUnit 用例。

**points**：比较器溢出 2｜TimSort 契约违例（传递性）2｜`subList` 视图逃逸 2｜`Arrays.sort` 退化输入与稳定性的取舍 2｜最小反例输入构造 1｜测试固化方式（`@ParameterizedTest` + `assertThrows`）1。
**bonus**：能说出 *"Comparison method violates its general contract!"* 是 TimSort 在 merge 阶段检测到矛盾时抛的、且**不是每次调用都抛**（因此线上表现为偶发）；提出 `Comparator.comparingInt` 链与 `List.copyOf` 返回；给出"用 `@RepeatedTest` + 固定 seed 的 `SplittableRandom`"复现偶发。
**gaps**：只说"应该用 `Integer.compare`"而不给反例；认为 `subList` 是拷贝；把稳定性说成"Java 排序都是稳定的"。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 | 说明 |
| --- | --- | --- |
| 溢出/比较器契约/编码假设的显式不变式 | `ABNB-BE-2` | "生产级正确性、边界与失败模式" |
| 排序算法实现细节与对抗输入 | `APL-BE-2`、`APL-BE-3` | 数据结构与 Java 集合/JVM 深度 |
| 内存与拷贝语义（视图 vs 快照） | `APL-BE-3`、`APL-BD-2` | 大规模数据的内存预算 |
