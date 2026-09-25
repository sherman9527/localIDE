# Java 集合、堆与"可判分的容器语义"（LRU / 扫描线 / 双堆 / 单调队列）

语言级别：Java 21（`SequencedCollection`/`SequencedMap`）；每题附 17 兼容写法。判分：`java-junit`。

---

## 1. 核心机制

### 1.1 `HashMap` 的真实行为（考点在"你能不能用输入把它打爆"）
- 默认 `capacity=16`、`loadFactor=0.75`、`threshold=12`；扩容是**2 的幂**（`tableSizeFor`），扰动函数 `h ^ (h >>> 16)` 把高 16 位混进低位。
- 树化条件**两条同时成立**：单桶链长 `>= TREEIFY_THRESHOLD(8)` **且** 表容量 `>= MIN_TREEIFY_CAPACITY(64)`；容量不足时先**扩容**而不是树化。反向退化阈值 6。
- 树节点要能排序：key 未实现 `Comparable` 时用 `tieBreakOrder`（先比 `System.identityHashCode`，再比 class name/`compareTo` 的兜底），因此**恶意 key 可让同桶退化成 O(n) 比较链**——但生产里更常见的事故是"自定义 key 的 `hashCode` 依赖可变字段"，导致 `get` 命中率随机。
- `getOrDefault`/`merge`/`computeIfAbsent` 与 `putIfAbsent` 的语义差别：`merge(key, v, f)` 当 `f` 返回 `null` 时是**删除**该键（计数清零的经典写法），很多人以为会被忽略。
- `computeIfAbsent` 的**再入**：在 mapping function 里再次修改同一个 map（含递归 `computeIfAbsent` 同一 bin）→ `ConcurrentModificationException` / `IllegalStateException` / 死锁（`ConcurrentHashMap` 尤其：同 bin 的锁重入会被检测到并抛 `IllegalStateException: Recursive update`）。递归图算法用 `computeIfAbsent(k, kk -> build(k))` 是典型地雷。
- 迭代顺序：**不保证**，且跨 JDK 版本会变（哈希扰动与扩容顺序决定）。凡"输出要求确定序"的题，必须 `TreeMap`/排序，否则判分不可复现。
- `Collections.synchronizedMap(m)` 只保证单方法原子；**迭代必须手工 `synchronized (m)`**（它包装的 mutex 就是 `m` 自身）。
- `ConcurrentHashMap.size()` 会走 `sumCount()`（近似），推荐 `mappingCount()`；它同样禁止 `null` 键值。

### 1.2 LRU / LFU / 带 TTL 的缓存（本类别最稳的"生产味"题）
```java
// 标准 LRU：LinkedHashMap 的 accessOrder + removeEldestEntry
class Lru<K,V> extends LinkedHashMap<K,V> {
    private final int cap;
    Lru(int cap) { super(16, 0.75f, true); this.cap = cap; }
    @Override protected boolean removeEldestEntry(Map.Entry<K,V> eldest) { return size() > cap; }
}
```
- Java 21 起 `SequencedMap` 让 `firstEntry()/lastEntry()/pollFirstEntry()/reversed()` 语义显式化（不再需要"猜迭代顺序 = 插入顺序"）；`LinkedHashMap.reversed()` 返回逆序视图（**视图**，遍历中删除要谨慎）。
- 需要"额外元数据（TTL、命中次数）+ 精确驱逐顺序"时，`LinkedHashMap` 不够用：正确结构是 **`HashMap<K, Node>` + 双向链表（`ArrayDeque` 不行，需要 O(1) 中间摘除）**。判分点：命中时要把节点移到队首（`remove` + `addFirst`），过期驱逐要能只扫队尾。
- **LFU** 的 O(1) 解：`key→(value,freq)` + `freq→双向链表` + `minFreq`；忘记"删除时该 freq 桶空了且 `f == minFreq` 才更新 minFreq"是最高频 bug。
- **TTL 驱逐**用"按过期时间排序的堆 + 懒删除（entry 里带 version，poll 时校验）"，不要在 `LinkedHashMap` 里遍历删除（O(n)）。

### 1.3 `TreeMap` / `TreeSet`：区间与扫描线
- `floorKey/ceilingKey/lowerKey/higherKey` 都是 O(log n)，是"区间命中/日历冲突/前缀匹配"的正解；`subMap(a,true,b,false)` 返回**视图**，在其上的 `pollFirstEntry()`、`entrySet().iterator().remove()` 会真删原 map（用它做"滑动窗口过期区间"很干净，但也最容易写出 `IllegalArgumentException: key outside of range`——插入到视图范围的键会抛）。
- 扫描线（会议室 II / 最大重叠区间）：` TreeMap<Integer,Integer> delta` + `merge(t, +1, Integer::sum)` / `merge(end, -1, ...)`，再累加求峰值。要点：**同坐标必须先处理 -1 再 +1**（端点相接不算冲突），这是本题唯一区分点。
- `TreeSet` 去重靠 `compareTo == 0` 而非 `equals`：比较器"只看一个字段"会**静默丢元素**（经典 bug：`TreeSet` 存 `[1,1]` 只剩一个）。自定义比较器必须与业务等价值一致，且要**全序**（否则 `add` 结果依赖插入顺序）。
- `Arrays.binarySearch` 不能用于 `TreeMap` 的"排名查询"；需要 order-statistic 树时明确说明 JDK 无内置（这是 `principal` 加分讨论点：用 `TreeMap`+分块/跳表/Fenwick 替代）。

### 1.4 `PriorityQueue` 的四条硬知识
1. `iterator()` **只保证队顶正确**，其余是内部数组序（想有序必须 `poll` 或 `drainTo` + 排序）。
2. `remove(Object)` / `removeIf` 是 **O(n)**（要线性扫描数组 + `sift`），"用 PQ 做任意删除"的题（如任务取消）正确解法是**懒删除**（记 `cancelled` 集合或 `version`，`poll` 时跳过）或 `TreeMap` 按 `(priority, seq)` 排序（可 O(log n) 删）。
3. 构造 `new PriorityQueue<>(collection)` 是 **O(n) heapify**；`new PriorityQueue<>()` 再逐个 `offer` 是 O(n log n)。求"第 K 大"用 size=k 的小顶堆，`offer` 后 `size()>k` 才 `poll`（顺序写反会丢元素）。
4. 禁止 `null`；比较器与 `equals` 不一致时 `contains/remove` 行为与堆序无关（用 `equals`），这是"删不掉"的根因。

### 1.5 单调队列 / 双堆 / 迭代器契约
- 滑动窗口最大值：`ArrayDeque<Integer>` 存**下标**，队尾弹掉"更小且更早失效"的元素；每个元素进出各一次 → 摊还 O(n)。写成"每窗口重扫"是 O(nk)。
- 数据流中位数：大顶（小半）+ 小顶（大半）双堆，`size` 差 ≤1；**删除任意元素**必须懒删除（两堆各维护一个"待删计数"），否则 `remove(Object)` O(n) 拖垮复杂度。
- 手写 `Iterator` 的契约（判分常考）：`hasNext()` 必须**幂等**（不得在 `hasNext` 里推进状态）；无元素时 `next()` 必须抛 `NoSuchElementException`；`remove()` 只能在 `next()` 之后调一次，否则 `IllegalStateException`。k 路归并的正确写法是"比较两个 `hasNext` 前先缓存 peek"。

### 1.6 位容器与内存预算
- `BitSet`：`cardinality/or/and/nextSetBit`，比 `boolean[]` 省 8 倍内存、筛法/连通性/去重题里常数更低；`nextSetBit(i)` 返回 `-1` 表示结束（很多人写成 `size()`）。
- `n=2e5` 时的内存量级判断（principal 必答）：`Integer` 对象 16B + 引用 4/8B，`List<List<Integer>>` 在 `m=5e5` 边上是 20MB+（外加大量数组对象头与 GC 扫描成本），`int[][]` 或 CSR（`head[]/to[]/next[]` 三个 `int[]`）是 6MB 且遍历无装箱。能给出"为什么 `int[][]` 比 `List<int[]>` 好、CSR 比两者都好"是 10 年经验的标志。

---

## 2. senior / principal 会被追问什么
1. 你的 LRU 在 `get` 命中时改不改顺序？改了以后驱逐的是谁？为什么 `removeEldestEntry` 只在 `put` 后调用（`get` 不触发驱逐）？
2. 带 TTL 的缓存为什么不能用 `LinkedHashMap` 一把梭？给出"驱逐 1 个过期键"的最坏复杂度与你的摊销论证。
3. 缓存并发：`LinkedHashMap` 多线程下会怎样（`accessOrder` 下结构性修改 + 无同步 → 环/丢失更新/CME）？为什么 `synchronized` 包住 `get` 会让命中率与吞吐一起崩（要用 `ConcurrentHashMap` + 分段驱逐或 `Striped`/`Caffeine`）？
4. `TreeMap` 视图上删除与范围查询的异常边界（`IllegalArgumentException`）在什么输入下触发？
5. 扫描线端点相接（`[1,2] [2,3]` 是否冲突）的语义由谁决定？如何在题面里把它变成可判分不变式？
6. 你如何测"迭代器契约"？（`hasNext` 连调 3 次、`next` 越界、`remove` 双调）为什么这类断言比"结果正确"更能区分经验？
7. principal：给出 `PriorityQueue` 懒删除方案的**内存上界证明**（堆积的 cancelled 条目何时回收；`size()` 与实际有效元素数的差异会不会让驱逐策略失效）。

---

## 3. 常见错误答案

| ❌ 做法/说法 | 真相 |
| --- | --- |
| "LRU 用 `HashMap` + `ArrayList`，命中时 `remove` 再 `add`" | `ArrayList.remove(Object)` 是 O(n) → 整体 O(n) 操作；正确是双向链表节点 O(1) 摘除 |
| "`LinkedHashMap` 的迭代顺序永远是访问顺序" | 只有 `accessOrder=true` 才是访问序（默认插入序），且 `get` 会**结构修改**（并发下必须外部同步） |
| "`TreeMap` 可以存 `null` key" | 8.0 起 `TreeMap` 禁止 `null` key（比较需要）；`HashMap` 允许 1 个 null key |
| "`PriorityQueue` 遍历出来是有序的" | 只保证队顶；其余是数组序 |
| "任务取消用 `pq.remove(x)`" | O(n)；改懒删除或 `TreeMap<(prio,seq), T>` |
| 用 `PriorityQueue` 存 `int[]` 且比较写 `a[0]-b[0]` | 溢出；用 `Comparator.comparingInt(a -> a[0])` / `Long.compare` |
| "去重用 `TreeSet` + 只比 `start` 的比较器" | `compareTo==0` 即视为重复 → 静默丢区间 |
| `computeIfAbsent(k, x -> recursive(k))` 递归构图 | 同一 bin 重入 → `IllegalStateException: Recursive update`（CHM）/ CME（HM）；改成先建空集合再 `put`，或迭代式构建 |
| 以为"`merge` 的 value 传 null 等于删除" | 方向搞反了：`HashMap.merge(k, v, f)` 的**参数 `v` 为 null 直接抛 NPE**；是**函数 `f` 的返回值为 null** 才删除该键（计数清零的惯用法）。另外 `Collectors.toMap` 遇到 null value 抛 NPE、重复 key 且未给 merge 函数抛 `IllegalStateException`，三处语义各不同 |
| "`ConcurrentHashMap.size()` 很准" | 它是 `sumCount()` 的近似，并发下瞬时值不保证；要精确得加锁 |
| "`new ArrayList<>(c)` 和 `List.copyOf(c)` 一样" | 前者允许 null 且可变、后者去 null 且不可变（含 `Arrays.asList` 场景的 `NullPointerException` 差异） |
| "在 `subMap` 视图里 `put` 一个范围内的键没问题" | 视图 `put` 会写回原 map；但**在视图内插入超出视图范围的键**抛 `IllegalArgumentException`；遍历视图时改原 map 抛 CME |
| "`BitSet.nextSetBit(i)` 找不到返回 `i`" | 返回 `-1` |

---

## 4. 可判分出题角度

角度族：① 缓存契约（驱逐顺序/命中提升/TTL 过期）用"注入时钟 + 访问日志回放"判分；② 扫描线端点语义；③ 迭代器契约（`assertThrows`）；④ 堆的懒删除正确性（有效 size 与 `pq.size()` 分离断言）；⑤ 复杂度过抗（`n=2e5` + `@Timeout`）。

### 题面草稿 1（`code`，`judgeKind: java-junit`，difficulty: senior）
> 实现 `public final class TtlLru<K, V>`：
> ```java
> TtlLru(int capacity, java.util.function.LongSupplier clock)   // clock 返回"当前毫秒"
> V get(K key);            // 命中则提升为最近使用；过期视作未命中并删除该键，返回 null
> void put(K key, V value, long ttlMillis);   // ttlMillis <= 0 表示永不过期
> V remove(K key);  int size();  Set<K> liveKeys();
> ```
> 约束：`get/put/remove` 平均 O(1)；驱逐只从"最久未用且已过期"开始，全部未过期时才按 LRU 驱逐；`liveKeys()` 返回**不可变快照**且按**访问顺序从旧到新**排序；不得依赖 `System.currentTimeMillis()`（必须用注入的 clock，便于判分推进时间）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `capacity_eviction_order` | cap=2：`put a,b`；`get a`；`put c` → 驱逐 `b`（不是 a）；`size()==2` |
| `ttl_expiry_lazy` | clock 推进越过 a 的 TTL：`get(a)==null` 且 `size()` 减少；`liveKeys()` 不含 a；**不得**要求全表扫描（用调用计数断言 clock 调用次数上界） |
| `expired_before_lru_evict` | cap=2，两个键都过期 → 新 `put` 驱逐过期键而不是"最近使用"的那个 |
| `immutable_snapshot` | `liveKeys()` 结果 `add` 抛 `UnsupportedOperationException`；随后 `put` 新键后旧快照内容不变（快照而非视图） |
| `zero_ttl_means_forever` | `ttlMillis=0/-5` → 永不过期（`-5` 不得被当成"立即过期"，也不得抛异常；这是输入契约的显式约定） |
| `null_semantics` | `put(k, null)` 的行为由题面规定为"等价 remove"；断言 `get(k)==null && !liveKeys().contains(k)` |

### 题面草稿 2（`code`，`judgeKind: java-junit`，difficulty: principal）
> 实现 `public static int maxConcurrentRooms(List<int[]> meetings, boolean touchingIsConflict)`（`int[]{start,end}`，值域 `Integer.MIN_VALUE..MAX_VALUE`）与配套的 `public static Iterator<int[]> mergeOverlapping(Iterator<int[]> sorted)`（惰性、只读一次输入流）。
> 约束：
> 1. 必须用 `TreeMap<Integer,Integer>` 扫描线（`merge` 累加 delta），端点相接的处理由 `touchingIsConflict` 决定（这是可判分的语义开关）；
> 2. **任何坐标相加不得溢出**：`end == Integer.MAX_VALUE` 时不得 `end + 1`（考察"给 end 加一"的习惯写法）；
> 3. `mergeOverlapping` 必须惰性：用计数代理断言"消费 1 个结果最多推进输入 `k+1` 次 `hasNext`"，且 `hasNext()` 连续调用 100 次不得改变状态；
> 4. 输入含空列表、单元素、区间被完全包含、以及"未排序但声称已排序"的输入（未排序时必须抛 `IllegalArgumentException`，不得静默错）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `basic_and_inclusive` | `[[0,30],[5,10],[15,20]]` → 2 |
| `touching_semantics` | `[[1,2],[2,3]]`：`true → 2`，`false → 1`（同一实现两种语义，断参正确性） |
| `int_max_endpoint` | `[[MAX_VALUE-1, MAX_VALUE]]` 与 `[[MIN_VALUE, MIN_VALUE+1]]` → 不抛溢出异常且结果正确（打 `end+1`） |
| `lazy_contract` | 100 次 `hasNext()` 后 `next()` 结果与单次调用一致；输入迭代器计数上界成立 |
| `not_sorted_fails_loud` | 传入乱序 → `assertThrows(IllegalArgumentException.class)` |
| `empty_and_single` | 空 → `hasNext()==false`（且 `next()` 抛 `NoSuchElementException`）；单元素直接输出 |

---

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：JVM 服务里有一个"任务优先级队列"，支持 `submit(prio)`、`take()`、`cancel(taskId)`、`reprioritize(taskId, newPrio)`，QPS 5 万，任务量 200 万。候选人需比较四种实现：`PriorityQueue + 锁`、`PriorityQueue + 懒删除`、`TreeMap<(prio,seq), Task>`、`ConcurrentLinkedQueue 分片`，并给出选择与验证方式。

**points**：每种实现的复杂度矩阵（`take/cancel/reprioritize`）3｜懒删除的内存上界与回收时机 2｜`TreeMap` 方案需要"稳定 seq"以保证全序（否则 `reprioritize` 等价类丢失）2｜并发正确性（`PriorityQueue` 非线程安全；`BlockingQueue` 生态位）2｜可验证性（顺序一致性测试、注入调度器、`@Timeout` 抗规模用例）1。
**bonus**：指出 `cancel` 后 `size()` 与有效任务数分离会让"容量驱逐/背压"逻辑失效；提出用 `LinkedBlockingDeque` 或分片 + work-stealing；给 `PriorityQueue` 迭代器陷阱的实证。
**gaps**：说"`PriorityQueue` 支持 O(log n) 删除"；忽略 `reprioritize` 必须"删除+重插"的原子性；把 `ConcurrentLinkedQueue` 当优先队列。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 缓存/驱逐/并发容器的复杂度与正确性 | `APL-BE-2`、`ABNB-BE-2` |
| 内存预算与容器选型（装箱、CSR、BitSet） | `APL-BD-2`、`APL-BE-3` |
| 迭代器契约与可判分不变式设计 | `ABNB-BE-2`、`APL-BE-2` |
