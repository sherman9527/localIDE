# 渲染性能、度量与内存（jsdom 可判分的口径 + 真浏览器口径）

适用：React 19.2 + Vite 7 + vitest 3（jsdom），必要时 Playwright 做真浏览器度量。判分方式：`react-vitest`（渲染次数/提交序列/订阅计数）与 `llm-rubric`（归因链路、容量预算）。

---

## 1. 核心机制

### 1.1 一次"卡"的完整拆解（INP 口径）
`interaction-to-next-paint`（INP，2024-03 起成为 Core Web Vital，good ≤ 200ms，p75）= **input delay**（主线程被长任务占着，事件排队）+ **processing**（事件回调 + React render + commit）+ **presentation delay**（浏览器样式/布局/绘制，含下一帧才生效的 `requestAnimationFrame`）。
React 侧只能压缩第二段；第一段的常见真凶是 hydration 期间的长任务（用 Activity / Selective Hydration 拆分）、第三方脚本（LoAF 的 `scriptAttributionKeys`/`sourceURL` 归因）；第三段是 layout thrash、大 DOM、字体/图片未预声明尺寸。

采集口径：
- `PerformanceObserver({type:'event'})` → 事件级 `processingStart/End`、`duration`；
- `PerformanceObserver({type:'long-animation-frame'})`（Chromium 已发布）→ 一帧内累计脚本、`styleAndLayoutStart`；`longtask` 是更老的兜底；
- `Profiler onRender(id, phase, actualDuration, baseDuration, startTime, commitTime)`：`actualDuration` = 本次该子树实际渲染耗时；`baseDuration` = "如果不可中断、整棵子树同步渲染需要多久"的估计。**两者差距大 → 说明这次渲染确实被并发打断/复用**；`phase` 在 19.x 可能是 `mount | update | nested-update`（Suspense 内的延迟重渲染走 `nested-update`）。
- React 19.2 的 DevTools 侧改进了调度时间线（scheduling profiler），线上仍只能靠自采 `Profiler` 上报（`__REACT_DEVTOOLS_GLOBAL_HOOK__` 不可用于生产）。

### 1.2 谁在真正触发重渲染（只有三种）
1. 自身 state/ref-ish 更新（`useState`/`useReducer`/`useSyncExternalStore`/Suspense 资源 resolve）；
2. 父级 render 时**默认**重渲染子组件（没有 memo 就没有 bailout）；
3. Context value 引用变化 → 所有 consumer 无条件重渲染（Context 是依赖图，不是 store；没有 selector 机制，因此"高频小字段"必须拆 Provider 或用外部 store）。
编译器（React Compiler 1.0）能自动做 props/children 的 memo 化，但**不能替你消除 Context fan-out 与 store 订阅过宽**——这两类仍是 senior 题的稳定区分点。

bailout 失效的隐形杀手（都可通过 render 计数探针判分）：
- 每次 render 新建的对象/数组/函数字面量作为 props（`style={{...}}`、`items={data.filter(...)}`）；
- `key` 不稳定（`key={index}` 在头部插入 → 全部子树 remount、`useEffect` 重跑、表单 DOM 状态错位）；
- 在 render 里读取 `useRef().current` 参与计算又依赖 effect 更新（渲染结果依赖非响应值）；
- `children` 传新元素（即便内容不变，元素对象是新引用，`memo` 也救不了 slot 型组件）→ 正确解是"把 children 变成 props slot 并保持引用"或改用 `useActivity`/`useDeferredValue` 重排；
- 在 effect 里对刚 set 的值再 set（无限级联，表现为 render 次数线性增长）。

### 1.3 大数据量渲染（ABNB-DATA-1 场景）
- 虚拟化的真正难点不是切片，而是：**动态高度**（先估算再 `ResizeObserver` 校正 → 滚动条抖动/锚定丢失）、**快速拖动时的白屏**（overscan 与渲染预算）、**可访问性**（屏幕阅读器只能读到窗口内节点，需要 `aria-setsize/aria-posinset` 与键盘 Home/End 语义）、**受控搜索高亮导致的整窗重渲染**。
- 不虚拟化的替代方案：`content-visibility: auto` + `contain-intrinsic-size`（跳过屏外渲染但仍参与布局与滚动条）；`contain: layout paint style` 阻断失效扩散；把每行的 `useContext` 换成行级 store 订阅。
- 计算与渲染分离：排序/聚合放 Worker（`postMessage` + transferable `ArrayBuffer`），主线程只做切片与提交；worker 结果用 `use()`/promise 接入 Suspense，避免"loading state 手写三处"。

### 1.4 内存与泄漏（senior 高频失分点）
| 症状 | 根因 | 判分可测信号 |
| --- | --- | --- |
| 卸载后仍报 setState / 请求堆积 | effect 未返回 cleanup 或未 `abort()` | `AbortController.signal.aborted === true`、`addEventListener` 与 `removeEventListener` 次数相等（用 spy 替换 DOM 原型） |
| 越滚越慢 | `useRef` 持有全量原始数组 / 事件监听绑在 window 且随组件实例增加 | `performance.measureUserAgentSpecificMemory()`（真浏览器）或断言 ref 只保存 index/key |
| `ResizeObserver loop completed with undelivered notifications` | observer 回调里改了被观察元素尺寸 | 断言回调内只 `setState` 到一个"已去抖"的派生值 |
| 定时器叠加 | 依赖数组含每次新引用的 callback | `setInterval` mock 的调用次数 === 预期（jsdom 下用 `vi.spyOn(window,'setInterval')`） |

### 1.5 判分环境的关键限制（必须写进 runner 设计）
jsdom 没有布局/绘制，所以**禁止用墙钟时间做断言**（容器抖动 → flaky）。可用的确定性信号：
1. 渲染次数：`<Profiler>` 计数、组件内 `renderCountRef.current++` 暴露到 `data-render-count` 属性；
2. 提交序列：断言每次 commit 后 DOM 文本快照（"旧值帧"必须恰好 1 帧）；
3. 副作用次数：`vi.fn` 作为 `createSocket`/`fetchMock`/`addEventListener` 替身；
4. 计时语义：`vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync()` 才能正确冲刷 microtask 与 transition；
5. 需要真指标时，单独走 Playwright 的 `expect.soft` + CDP 采 LoAF（作为"加分项"而不是判分门槛）。

---

## 2. senior / principal 会被追问什么
1. 你的性能预算怎么写：不是"要快"，而是"p75 INP ≤ 200ms、单次交互 React 处理 ≤ 50ms、列表 10k 行时 commit 内 DOM 节点新增 ≤ 60、JS 堆增长 ≤ X"。
2. "首屏 OOM/卡顿" 现场：给你 heap snapshot + `Profiler` 上报，如何区分"节点数爆炸"、"detached DOM"、"闭包持有原始数据"三类？
3. `content-visibility` 与虚拟化的取舍：谁负责滚动条高度稳定性？哪个能配合 `find in page`（`content-visibility` 支持文本搜索，虚拟化不支持）。
4. 上 React Compiler 之后，如何防性能回归：`Profiler` 快照 + 断言 `baseDuration` 与 `actualDuration` 的比值、禁止新增 `<Context>` 高频 value。
5. `useDeferredValue` 造成的一帧旧值：如果这是"库存数量"或"权限按钮"，你怎么论证可以/不可以降级？（引出"可丢弃 vs 正确性关键"分类）
6. hydration 与交互性：为什么 LCP 变好但 INP 变差？streaming + `Activity` 下首屏指标怎么重算、埋点怎么打点（`activationStart`）。
7. principal：跨 20 个团队的组件库如何统一"可测的性能契约"（每个组件声明最大 commit 成本、CI 跑 render-count 基线、超预算阻断发布）。

---

## 3. 常见错误答案

| ❌ 说法 | 真相 |
| --- | --- |
| "加了 `React.memo` 就不会重渲染" | memo 只比较 props 引用；父级传新对象/数组/函数/children 时必然失效 |
| "`useMemo` 是免费的性能优化" | 它本身有比较与内存成本，且把"该删的重复计算"变成"依赖数组 bug 温床"；正确说法是先靠编译器，再对确实昂贵的派生值保留 |
| "虚拟 DOM 很慢，所以要用 `dangerouslySetInnerHTML`/直操 DOM 提性能" | 瓶颈几乎总在"渲染函数被调用的次数与派生计算"，绕过 React 换来状态不一致与 Effect 泄漏 |
| "用 `setTimeout(0)` 拆任务不算长任务，所以 INP 会好" | 多个小任务仍会排在同一交互之后；且低优先级更新要靠 transition，不是靠宏任务 hack |
| "`key={index}` 只是 diff 效率问题" | 更严重的是 DOM 状态错位（输入框内容、焦点、动画、`<video>` 时间轴）与 Effect 重跑 |
| "`Profiler` 的 `baseDuration` 就是本次耗时" | 它是"整棵子树同步不可中断"的估计，用来判断并发是否生效，不是耗时读数 |
| "Context 加 selector 能减少订阅者渲染" | React Context 无 selector；要 `useSyncExternalStore`/原子化 store，或拆 Provider |
| "`getSnapshot` 每次返回 `{...store}` 无所谓" | 引用不稳 → 每次都判定为变化，可能直接死循环（`The result of getSnapshot should be cached`） |
| "内存泄漏看 `performance.memory` 就够了" | 该指标精度低且已受限；要 heap snapshot、`MEMORY_USAGE`-式的对象计数、或 `measureUserAgentSpecificMemory`（需跨源隔离） |
| "测试里断言 `render 时间 < 16ms` 即可" | jsdom 无真实渲染且 CI 抖动大，必然 flaky；改断 render 次数/提交序列 |
| "首屏指标 LCP 变好说明体验变好" | streaming/Skeleton 会推迟真正可交互时间；必须同时看 INP 与 hydration 完成点 |

---

## 4. 可判分出题角度

角度族：① render 次数预算题；② 提交序列题（deferred 值的旧帧必须恰好 1 帧）；③ 订阅生命周期题（addEventListener/observer/socket 的 create/cleanup 严格配对）；④ 大数据量派生计算题（给定 10k 行 + 排序/聚合，要求 commit 内新增 DOM 节点数与 render 次数受控）；⑤ `rubric` 的归因/预算题。

### 题面草稿 1（`code`，`judgeKind: react-vitest`，difficulty: senior）
> 实现 `src/SearchTable.tsx`：props `{ rows: Row[]; onFilterChange(q: string): void }`，内部受控搜索框 + 排序表头。硬性要求：
> 1. 输入框必须**每帧跟手**（typing 时 input 的 `value` 立即反映按键）；
> 2. 过滤/排序结果允许滞后，但**最多滞后一帧**，且不允许出现"新 query + 新结果"与"旧 query + 旧结果"之外的第三种组合帧（禁止"高亮文本用新 query、数据用旧结果"的混合帧）；
> 3. 单行组件 `Row` 在无关行数据变化时不得重渲染（用 `data-render-count` 属性暴露渲染次数）；
> 4. 点击表头排序不得触发任何 `fetch`/`onFilterChange` 调用；
> 5. 组件卸载时必须清理所有注册的 `ResizeObserver`/事件监听（测试注入替身）。
> 禁止：`useMemo`/`useCallback`/`React.memo`（考察是否理解优先级与引用无关的正确性手段；允许 `useDeferredValue`、`useSyncExternalStore`、`Activity`）。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `one_stale_frame_max` | 连续输入 `'a'→'ab'→'abc'`：每次 commit 序列中"旧结果帧"数量 ≤1，最终帧为 `abc` 结果；`input.value` 每次 commit 都与已按键前缀一致 |
| `no_mixed_frame` | 每帧断言"高亮关键字包含于当前 query"（不允许 query='ab' 而高亮 'a' 且数据仍是全量） |
| `row_render_budget` | 300 行；只改第 200 行的 `status` → 其余行的 `data-render-count` 不变（允许整体重渲染但必须 memoize 行内元素？→ 明确用 `key` 稳定 + 外部 store 订阅才能通过，这是核心区分点） |
| `sort_no_refetch` | 点表头 5 次：`onFilterChange` 与 fetch 替身调用次数为 0 |
| 边界：空结果/超长 query（5k 字符） | 渲染 0 行不抛错；query 被截断/按字素计数（引入 Unicode 用例）且不产生 >50 次 commit |

---

### 题面草稿 2（`code`，`judgeKind: react-vitest`，difficulty: principal）
> 实现 `src/useChartSeries.ts` + `src/Chart.tsx`：外部 store（测试提供，`subscribe/getSnapshot`）每 16ms 推送一个新点，最多 100k 点。要求：
> 1. 用 `useSyncExternalStore` 读取，`getSnapshot` 必须返回稳定引用（同版本多次读取返回同一对象）；
> 2. 组件每秒最多提交 10 次（把高频 store 降采样），且**最后一次数据必须被提交**（不允许"最后 N 个点永远不显示"）；
> 3. 卸载后立即停止降采样定时器（断言 `setInterval` 被 clear 且 clear 次数 === 创建次数）；
> 4. 提供 `renderCount` 探针。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `snapshot_identity_stable` | 同一 store 版本连续调用 `getSnapshot()` 两次 → `toBe` 同一引用 |
| `throttle_keeps_tail` | fake timers 推 1s（≈62 个新点）→ commit ≤10，但最终渲染的 last point 与 store 最新点一致（尾帧保证） |
| `cleanup_stops_timer` | `unmount()` 后 `advanceTimersByTime(5s)` → 无新 commit，`clearInterval` 调用次数与 `setInterval` 相等 |
| 边界：store 抛错/快照为 `NaN` | 不进入无限重渲染（commit 次数上限），错误被上报到边界（分类为 store 故障而非取消） |
| 边界：降采样期间 store 订阅被替换（如切租户） | 旧订阅关闭、新订阅生效、无 tearing（同一帧两个组件读到不同版本时判失败） |

---

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 线上报表页（Next 风格 streaming + 现有 React 19 SPA 各一）p75 INP 从 190ms 恶化到 850ms，LCP 反而改善 200ms。给出归因方案与三类候选根因（hydration 长任务、Context fan-out、图表重算在主线程）的验证数据形状，并给出去抖后的**性能预算与回归护栏**。

**points**：指标定义与相位拆分 2｜可执行归因链路（LoAF/event-timing/Profiler 上报字段如何用）3｜三根因各给出判别证据 3｜预算与 CI 护栏（render 计数基线、禁止墙钟断言）2。
**bonus**：指出 LCP 与 INP 反向变化在 streaming 下的成因（骨架早出、水合延后）；提出 `Activity`/选择性水合与 `scheduler.yield()`（Chromium 可用，跨浏览器需降级）；给出"埋点里带 `activationStart` 才可比"的口径。
**gaps**：只说"加 memo/useMemo"；用 `longtask` 单独结论；不看事件处理时间占比；把预算写成"越快越好"。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| INP/LoAF/Profiler 度量与预算 | `APL-WEB-2` |
| 高频 store 降采样、tearing、订阅生命周期 | `APL-WEB-2`、`APL-WEB-3` |
| 10k+ 行表格与图表渲染策略 | `ABNB-DATA-1` |
| 可判分的 render-count 测试设计（禁墙钟） | `APL-WEB-5` |
| 跨团队性能契约与 CI 护栏 | `APL-WEB-1`、`ABNB-WEB-1` |
