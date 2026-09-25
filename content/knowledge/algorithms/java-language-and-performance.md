# Java 语言新特性与实现性能（record / sealed / 模式匹配 / Stream / 虚拟线程）

语言级别：Java 21（LTS）与 22 为主，Java 25（2025 LTS）作为"能不能跟上版本"的加分口径。判分：`java-junit`（改写类题最容易做出确定性判分）+ `llm-rubric`（并行与选型）。
**判分环境提醒**：`record patterns`、`SequencedCollection`、virtual threads 需要 21+；unnamed variables 需要 22+。当前计划里的镜像是 `openjdk-17`，因此这类题必须声明 `runner: { release: 21 | 22 }`，或同时接受 17 等价写法（判分只看用例）。

---

## 1. 核心机制

### 1.1 `record`：不是" Lombok 替身"，是**值语义 + 不变式承载体**
```java
public record State(int idx, int mask, long cost) implements Comparable<State> {
    public State {                       // compact constructor：规范化/校验的唯一入口
        if (mask < 0) throw new IllegalArgumentException("mask");
    }
    @Override public int compareTo(State o) { return Long.compare(cost, o.cost); }  // 进堆时可省掉外部 Comparator 对象
}
```
- 生成内容：`final` 字段 + 访问器（**名字就是字段名，不是 `getX`**）+ `equals/hashCode/toString`（基于 `ObjectMethods` bootstrap，元数据在 class file 里，不是反射逐字段）；浅拷贝语义（数组字段仍共享 → 算法里"record 装 `int[]` 当 key"是 bug 温床：`equals/hashCode` 用 `==` 比较数组引用，导致 HashMap 命中率归零）。
- 可用于 DP/图状态：不可变 + 正确 `equals/hashCode`，比"手写 class + 忘 override"安全。
- 不适合：需要可变累加的并查集/计数器（写 `record` 后每步新建对象 → GC 洪水）；需要 lazy 字段；需要继承层次（record 隐式 `final` 且不能扩展类）。
- `record` 可以 `implements` 接口、可以有静态工厂、可以在体内实现 `Comparable`，但**不能声明实例字段**（只能有组件）。

### 1.2 `sealed` + 模式匹配：把"穷尽性"变成编译期保证（Java 21 转正）
```java
sealed interface Expr permits Num, Add, Neg {}
record Num(long v) implements Expr {}
record Add(Expr a, Expr b) implements Expr {}
record Neg(Expr a) implements Expr {}

static long eval(Expr e) {
    return switch (e) {                       // 21：pattern matching for switch 已 final
        case Num n        -> n.v();
        case Add(Expr x, Expr y) -> eval(x) + eval(y);   // record pattern：解构 + 嵌套
        case Neg(Expr x)  -> -eval(x);
    };                                        // 不需要 default：sealed + 穷尽 = 编译器保证
}
```
- 关键工程价值：新增 `record Mul(...) implements Expr` 时，**所有 `switch` 立刻编译失败**（漏分支被机器发现）。这与 `instanceof` 链（编译通过、运行到 default 抛错）是本质差别——判分题面可以就围绕这个差别设计（"新增一种节点，哪些实现会编译失败"）。
- `case` 守卫：`case Num n when n.v() < 0 ->`（`when` 子句，21 语法）。子模式可用 `case Add(Num a, Num b)` 做常量折叠。
- 泛型 record pattern 有类型推断限制（不能 `case Box<String> b` 这种带类型参数的解构断言，会报"cannot specialize"），面试常吹。
- **JDK 25 里原始类型模式仍是 Preview**（JEP 507）：`case int i ->`、`case long l ->` 不能当"生产可用"回答（24 的 JEP 484 已把 class pattern 对原始类型放宽，但包装类型仍走 `instanceof` 路径，别混）。

### 1.3 其它影响算法实现写法的版本项
| 特性 | 版本 | 对算法代码的实际影响 |
| --- | --- | --- |
| `var` | 10 | 只影响局部；`var x = new ArrayList<>()` 会推成 `ArrayList<Object>`（菱形+var 双降级）→ 判分里"类型噪音减少但推断变松"的可读性话题 |
| switch 表达式 + `yield` | 14 | 块臂里 `yield` 才是"带值 break"，`return` 会从方法返回（高频笔误） |
| 文本块 | 15 | 构造测试用 CSV/JSON 输入很干净（题面夹具常用） |
| `Collection.mapMulti` | 16 | `flatMap` 的低分配替代（不需要每元素新建 Stream） |
| `Stream.toList()` | 16 | 不可变、允许 null；与 `Collectors.toUnmodifiableList()`（禁 null）和 `Collectors.toList()`（可变）三者语义不同 |
| `SequencedCollection/Map` | 21 | `getFirst/getLast/addFirst/addLast/removeFirst/removeLast/reversed()`；`LinkedHashMap` 拿到 `firstEntry/lastEntry/sequencedKeySet` |
| unnamed variables `_` | 22 | `for (int _ : list)`、`catch (Exception _)`、`var _ = map.remove(k)`；消除"未使用变量"噪音，同时**不能读取** `_` 的值；也用于 record 解构里忽略某分量 `case Point(int x, int _)` |
| `String Templates` | 21 preview / 22 二次 preview → **已撤回** | 写 `STR."..."` 属于**编造 API**，判分为错 |
| `Scoped Values` | 25 Final（JEP 506） | 替代 `ThreadLocal` 传不可变上下文（traceId），在百万虚拟线程下省内存 |
| `Structured Concurrency` | 25 仍是 Fifth Preview（JEP 505） | 只能作为"方案讨论"，不能出现在需要编译通过的判分代码里（需 `--enable-preview`，且随版本破坏兼容） |
| Stream Gatherers（`gather()`：`ofFold/ofScan/ofWindowSliding`） | 23 起 Preview，JDK 25 清单里没有 | 同上：判分代码不得使用；`rubric` 里可讨论"用它替掉手写扫描" |

### 1.4 Stream：什么时候该用、什么时候一定输
可判分的性能事实（都可用"计数代理 + 分配断言"验证，不要靠墙钟）：
- `IntStream.range(0,n).map(...).sum()` 与 `for` 循环的差距来自**lambda 对象/`Spliterator`/管道对象分配**；在 `n=1e7` 的热路径上是可测的（几倍），在 `n=1e3` 的业务代码里可以忽略。所以判分点应该是"是否放在了热点里 + 是否装箱"，不是"stream 天生慢"。
- `.boxed()` / `Stream<Integer>` 把每个元素变成对象；`mapToInt(...).asLongStream()` 这类原始特化流才是不装箱的正解。
- `distinct()` / `sorted()` 是**全量屏障**（内部 `HashSet`/缓冲全部元素）→ 流式/大数据下会 OOM；`limit()` 在并行流里会导致**非确定顺序的输出**（不是错误但会让结果不稳定）。
- `Collectors.groupingBy` 会为每个键新建 `ArrayList`；`toMap` 的 NPE/`IllegalStateException` 陷阱见另一文件；`partitioningBy` 只有两个桶时更快。
- `parallelStream()` 默认用 `ForkJoinPool.commonPool()`（大小 = `availableProcessors()-1`）。**在并行流里做阻塞 IO 会饿死整个 JVM 的 common pool**（其它 parallel stream、`CompletableFuture.*Async`、`Iterator` 的并行特性都用它）。正确做法：把阻塞部分换成虚拟线程，或用 `ForkJoinPool` 实例内 `submit()` 包裹（配合 `ManagedBlocker` 语义）。
- `Stream.iterate(seed, hasNext, next)`（Java 9 重载）与 `takeWhile/dropWhile`（9）组合能表达惰性状态机；但 `generate()` 的 `Supplier` 有状态写法在并行下**不安全**（会被多线程并发调用）。

### 1.5 并行分治与虚拟线程（`APL-BE-1` 场景）
- CPU 密集的递归分治：`RecursiveAction/RecursiveTask` + `ForkJoinPool`（work-stealing，`join` 会帮助别人干活，因此不死锁）；虚拟线程**不提供**额外 CPU 并行度（可运行并行度仍受 carrier pool = 核数限制），它的收益是"阻塞不占线程"。
- 回溯/穷举的 fan-out（百万任务）：虚拟线程可行（每个分支一个任务），但要处理**取消与背压**：`StructuredTaskScope` 仍是预览（25 的 Fifth Preview）→ 生产写法是 `ExecutorService svc = Executors.newVirtualThreadPerTaskExecutor()` + `Future` + 显式 `cancel` + 一个 `AtomicBoolean stop`。
- `ThreadLocal` 陷阱：百万虚拟线程 × 每个 ThreadLocal entry = 内存放大；25 起正解是 Scoped Values（Final）。
- `synchronized` 块内阻塞会 pin carrier thread（21/22/23 的行为）；**JDK 24 的 JEP 491 之后不再 pin**。用 21 判分环境时，"把 `synchronized` 换成 `ReentrantLock`"仍是有效建议；用 25 时要更新口径（还有 `Object.wait()` 等少数路径需注意）。
- 输出确定性：并行结果聚合禁止"多个任务对同一个非线程安全 `ArrayList` `add`"；`Collectors.toConcurrentMap` / `Collectors.groupingByConcurrent` 的 `combiner` 语义、以及"并行流的 `forEach` 顺序不定，要有序输出得 `forEachOrdered`（有屏障）"。

---

## 2. senior / principal 会被追问什么
1. 你为什么用 `record` 而不是普通 class？它在 HashMap 里当 key 的成本（浅 `equals` + 数组字段陷阱）？
2. sealed + switch 让你"编译期发现漏分支"，那么在**跨模块**新增实现时会发生什么（`permits` 与模块边界的可见性约束、`sealed` 的子类必须在同一 module/同一编译单元包内）？
3. 一条 8 段的 stream 链，你如何在不看墙钟的情况下论证它比 for 慢？给出可测的中间量（分配字节数、lambda 实例化次数、 Spliterator 拆分次数）。
4. 并行流 + HTTP 调用的线上事故复盘：common pool 被占满后 JVM 里还有哪些东西一起崩（其它并行流、`CompletableFuture` 默认异步、`Iterator.forEachRemaining` 并行特性）？
5. 100 万虚拟线程跑 DFS：内存、取消、结果合并、进度上报分别怎么做？（引出 Scoped Values、背压、`Semaphore`）
6. 你怎么给"必须串行等价"的并行实现写测试？（固定 seed 的 `SplittableRandom` 生成输入 + 与串行结果 `assertArrayEquals` + `@RepeatedTest`，禁止用 sleep 等并发）
7. principal：团队语言基线（是否强制 21 LTS/25 LTS）、preview 特性的使用政策、`--enable-preview` 对 class file 版本与回滚的影响、以及"record 泛滥导致 JVM 分配压力"的度量与规范。

---

## 3. 常见错误答案

| ❌ 说法/写法 | 真相 |
| --- | --- |
| "`record` 就是不可变的 DTO，随便当 map key" | 组件是浅比较：`record K(int[] a)` 的 `equals` 用 `==` 比数组 → 命中率归零 |
| "`record` 的 getter 叫 `getName()`" | 访问器名 = 组件名 `name()`（`instanceGetField` 风格），与 JavaBean 规范不同（部分框架需要适配） |
| "switch 模式匹配后还要写 `default` 兜底" | sealed 类型 + 穷尽时**不该写** `default`，否则新增分支的编译期保护被吃掉 |
| "`case Num n ->` 之后可以用 `n.v`" | record 访问器要调用 `n.v()`（没有字段暴露，除非组件同名字段被反射——不可以直接访问） |
| "JDK 21 可以用 `STR."x=\{x}"`" | String Templates 已撤回（22 是第二次 preview，之后被移除），生产不可用 |
| "`_` 可以声明后再读" | 22 的 unnamed variable **读取即编译错误**；它只是"这里不需要名字" |
| "`case int i ->` 在 25 可用" | JEP 507 仍是 Third Preview，需要 `--enable-preview`；不得作为判分实现 |
| "并行流一定更快" | 拆分/合并有成本；`distinct/sorted` 全量屏障；源不可分裂（`LinkedList`、`Stream.generate`）时基本等于串行 + 额外开销 |
| "在并行流里调阻塞 IO 没事，反正线程多" | 用的是 common pool（核数级），会拖垮整个 JVM 的并行能力 |
| "`parallelStream().forEach` 输出顺序 = 输入顺序" | 无序；需有序用 `forEachOrdered`（代价是失去部分并行收益） |
| "虚拟线程让 CPU 计算变快" | 不提升 CPU 并行度；对 CPU 密集任务只是省了线程栈与调度成本 |
| "`ThreadLocal` 在虚拟线程里没问题" | 每线程一份 entry → 百万级时内存放大与"线程局部缓存失效"；25 用 Scoped Values |
| "record 太多会慢所以别用" | 需要论证的是**分配速率/逃逸分析**；JVM 对不可变小对象有标量替换/逃逸消除，"record 天生慢"是错的 |
| "用 `CompletableFuture.supplyAsync` 默认池很好" | 默认 `ForkJoinPool.commonPool()`：阻塞任务必须传自定义 executor（虚拟线程 executor），这是生产事故常见来源 |

---

## 4. 可判分出题角度

改写类题的判分技巧：给**行为等价**的断言（结果数组逐元素相等 + 异常类型 + 抛出时机），再加"结构性检查"（编译期：新增分支必须失败 → 用 `javac` 对第二段代码判 error 数；或 `assertThrows(UnsupportedOperationException)` 检查 `List.of` 语义）。

### 题面草稿 1（`code`，`judgeKind: java-junit`，difficulty: senior）
> 给出一段 120 行的 `Expr` 求值实现（用 `class` + `Object type` 字段 + `instanceof` 链 + 可变 `List<Expr> children` + 循环内 `s += ...` 拼接错误信息）。要求改写为：
> 1. `sealed interface Expr permits ...` + `record` 组件（不得出现 `instanceof`、不得出现 `default:` 分支）；
> 2. 求值返回 `EvalResult`（`record`，成功携带 `long value`，失败携带 `ErrorKind`：`DIV_BY_ZERO`、`OVERFLOW`、`UNKNOWN_VAR`）——**`Long.MIN_VALUE / -1` 必须归为 `OVERFLOW`**。可用工具：`Math.addExact/subtractExact/multiplyExact/negateExact`（8+），以及 `Math.floorDivExact/ceilDivExact/divideExact`（**较新 JDK 才有；JDK 8/11/17 无 `divideExact`**，17 环境必须回退成 `Math.floorDiv` + 显式判定 `MIN_VALUE / -1`，本题面在 `runner.release` 里注明所用级别）；
> 3. 变量表通过 `Map<String,Long>` 传入，未知变量返回 `UNKNOWN_VAR` 而不是抛异常；
> 4. 支持常量折叠（`Add(Num,Num)` 用嵌套 record pattern）；
> 5. 输出表达式字符串必须与原实现的"括号策略"逐字符一致（判分点：括号是数据的一部分，不是风格）。
> 约束：允许 17 兼容实现（用 `switch` + 手工 cast）但必须保留"新增类型会编译失败"的机制说明（写在类注释里，`rubric` 附带 1 分）。

**用例设计（≥5，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `eval_basic` | `(1+2)*3` → `9`；字符串输出括号策略一致 |
| `div_by_zero_and_overflow` | `1/0` → `DIV_BY_ZERO`；`Long.MIN_VALUE / -1` → `OVERFLOW`（不是 `Long.MIN_VALUE`，也不是异常逃逸） |
| `unknown_var` | `x*2`（表里无 x）→ `UNKNOWN_VAR`，且不抛 |
| `const_folding` | `1+2+3` 折叠后 `toString` 为 `"6"`（用嵌套 record pattern 的实现才会自然满足） |
| `no_instanceof_no_default`（结构） | 判题脚本对候选人源码跑一次"新增 `record Sub(...)`"编译：必须**失败并报告缺失分支**（`javac` 退出码 + 错误关键字 `"the switch expression does not cover valid case labels"`）；若候选人偷偷加了 `default` → 该用例判负 |
| 边界：深层嵌套 5000 层 `((((...))))` | 不 `StackOverflowError`（要求改写为显式栈或迭代；作为 principal 附加用例） |

### 题面草稿 2（`code`，`judgeKind: java-junit`，difficulty: principal）
> 实现 `public static long countBadPairs(int[] a)`：统计 `i < j && j - i < a[j] - a[i]` 的对数。要求：
> 1. `n <= 2e5`、`a[i]` 为 `int` 全域 → 必须给出**不溢出**的变形（`a[i] + i < a[j] + j` 类变换），计数结果用 `long`（`n(n-1)/2` 可达 `2e10`，返回 `int` 必错）；
> 2. 分别提供两个实现：`countSequential`（`for` 循环 + 排序 + 二分 bound）与 `countStream`（等价的 stream 写法，允许 `IntStream`，不得 `boxed()`）；两者必须在同一组随机输入上结果一致（判分：`assertThat(par, is(seq))`）；
> 3. `countStream` 必须是**可并行安全**的：不得在 `Supplier`/`forEach` 里改共享可变状态；提供 `countParallelSafe(Executor)`，内部禁止使用 `ForkJoinPool.commonPool()`（判分：注入一个"大小为 1 且带计数"的 executor，断言实际并发度与不阻塞）；
> 4. 固定 seed（`new SplittableRandom(20260919L)`）生成 2000 组对拍输入。

**用例设计（≥4，含边界）**
| 用例 | 断言与考察点 |
| --- | --- |
| `long_overflow_guard` | `n=200000`、`a` 全 0 → 期望 `0`；`a=[2e9, -2e9, 2e9, -2e9 ...]` 触发 `a[i]+i` 溢出风险 → 结果与 `BigInteger` 参照实现一致（打"没转 `long` 就相加"） |
| `seq_vs_stream_equivalence` | 2000 组对拍（含空数组、单元素、全等、严格递增/递减）结果相同 |
| `no_common_pool` | 断言 `countParallelSafe` 期间 common pool 未被使用（`ForkJoinPool.commonPool().getActiveThreadCount()==0` 且注入 executor 的任务数 > 0） |
| `count_type` | 返回值断言用 `assertThat(count, greaterThan(2_147_483_647L))` 构造一个 `n=100000` 全满足的输入（返回 `int` 的实现直接溢出为负） |
| 边界 | `n=0/1` → 0；`a` 含 `Integer.MIN_VALUE` 与 `MAX_VALUE` 相邻 |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：一个 3 百万行的 Java 服务从 JDK 17 升到 21，再评估 25（LTS）。要求回答：(a) 哪些新语言特性值得立刻引入、哪些必须禁止（preview 的政策）；(b) 虚拟线程上线的 5 个真实风险与验证方法；(c) `record`/sealed 大规模引入对 JVM 的影响（分配、逃逸、GC 行为）与度量手段；(d) 如何用 CI 把"禁止 preview""禁止 common pool 阻塞""record key 必须无数组组件"变成规则。

**points**：preview/`--enable-preview` 的 class file 与回滚风险 2｜虚拟线程风险清单（pinning 与 JEP 491 的版本口径、`ThreadLocal` 放大、common pool/`synchronized`/连接池上限、诊断工具 `jcmd Thread.dump_to_stderr -virtual` 类）3｜JVM 度量（`-Xlog:gc*`、JFR `jdk.ObjectAllocationInNewTLAB`、async-profiler 分配模式）2｜CI 规则化（ArchUnit/ErrorProne/SpotBugs 自定义规则）2｜版本口径准确（不声称 Stream Gatherers/StructuredTaskScope 已转正）1。
**bonus**：指出 25 的 Scoped Values 转正与 `ThreadLocal` 迁移路径；提到 `Executors.newVirtualThreadPerTaskExecutor()` 是 `AutoCloseable` 且 `close()` 会等待任务；给出"连接池/许可信号量仍是真实并行度上限"的论证。
**gaps**：把 virtual threads 说成"免费提速"；建议全局 `--enable-preview`；认为 `synchronized` 在 25 仍会 pin carrier thread。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| sealed/record 建模与编译期穷尽性 | `APL-BE-3`、`ABNB-BE-2` |
| Stream 与分配/屏障的实证分析 | `APL-BE-3`、`APL-BE-1` |
| 虚拟线程、common pool、并发正确性与确定性测试 | `APL-BE-1` |
| 语言基线与 preview 政策、CI 规则化 | `APL-BE-1`、`APL-WEB-1`（工程治理通用） |
