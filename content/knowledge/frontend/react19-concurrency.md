# React 19 / 19.2 并发与 Actions（含 Compiler、Activity、useEffectEvent）

适用版本：`react@19.2`、`babel-plugin-react-compiler@1.0`、Node 24、vitest 3。判分方式：`react-vitest`（真实渲染 + 断言）为主，架构边界题为 `llm-rubric`。

---

## 1. 核心机制

### 1.1 更新优先级：三档 + 可中断
React 的并发不是"多线程"，而是**可中断的 render + 优先级 lane**。工程上只有三个旋钮：

| 旋钮 | 语义 | 典型误用 |
| --- | --- | --- |
| `startTransition(fn)`（含 `async` 回调） | fn 内的更新标记为 **transition（低优先级、可丢弃）**；`isPending` 由 `useTransition()` 给出 | 把用户输入（`setValue(e.target.value)`）也塞进去 → 输入框丢字 |
| `useDeferredValue(v)` | 不改更新优先级，而是"本轮先用旧值渲染，之后再用新值补一帧" | 用在正确性关键路径（表单校验、权限判断）→ 出现一帧越权/错值 |
| `useSyncExternalStore` | **强制同步**读取外部 store，禁止被并发拆裂（防 tearing） | 用它绕开 transition 做"实时数据" → 每次 store 更新都同步渲染，长任务不可中断 |

判定原则：**"这个更新被丢弃会不会导致用户看到错误结果？"** 会 → 普通更新；不会（只是"稍后变准"）→ transition/deferred。

```jsx
// 正确分工：input 保跟手，重计算降级
const [text, setText] = useState('');            // urgent
const deferred = useDeferredValue(text);
const rows = useMemo(() => heavyFilter(deferred), [deferred]); // 可被下一次 transition 打断
```

### 1.2 `use()`：把 promise 当资源
- `const value = use(resource)`，`resource` 可为 Promise 或 Context。
- **可在条件/循环内调用**（不占 hook 槽位），这与 `useContext` 的关键区别。
- reject 时 React **throw** 到最近的 Error Boundary：组件内 `try/catch` 包不住。
- **不能**在事件回调/`setTimeout` 里调用，只能在 render（组件或自定义 hook）中。
- render 里 `use(fetch(url))` 每次生成新 promise → 反复挂起 + 重复请求；必须传"同 URL 同实例"的缓存 promise（或框架的 `cache()`）。
- 刷新数据：`startTransition(() => setPromise(makeNewCachedPromise()))`，靠"换实例"触发挂起，而不是靠 `key` 重挂整个子树（会丢状态）。
- Server Component 中 `use(context)` 不受支持。

### 1.3 Actions：`useActionState` / `useFormStatus` / `useOptimistic`
```js
const [state, dispatchAction, isPending] = useActionState(action, initialState, permalink?)
async function action(previousState, payload) { ... ; return nextState }  // 可 async
```
- `dispatchAction` 必须在 Action 上下文里调用（`<form action>`、`<button formAction>`、或 `startTransition`）；直接裸调会得到 *"async function … outside of a transition"* 类错误且 `isPending` 不动。
- 多次 dispatch **串行排队**，前一个完成才跑下一个——这是 `previousState` 有意义的前提，也是"点两下按钮不会并发提交"的实现依据。
- action 里 `throw` → 队列中后续 action 被跳过 + 冒泡到 Error Boundary。**可预期的校验失败应 return 到 state**，不要用异常表达业务分支。
- `useFormStatus()` 返回 `{pending, data, method, action}`，只有在 `<form>` 的**后代组件**里才拿得到该表单的状态（这是原生"提交中禁用 submit 按钮"的唯一干净做法）。
- `permalink` 第三参数：JS 尚未 hydrate 时表单提交会导航到该 URL 走服务端渲染，即**渐进增强**；目标页必须存在同一个 form 定义，否则状态传不过去。
- `useOptimistic(base, reducer?)`：`setOptimistic(x)` 只能在 Action/Transition 内调用；action 失败时**不需要手写 undo**——base 未更新，乐观态自然回弹。pending 期间若 base 变了，React 会用新 base **重放 reducer**，所以 reducer 必须是纯函数（不能闭包捕获外部可变状态）。

### 1.4 `Activity`（19.2）
`<Activity mode='visible' | 'hidden'>`：hidden 时
- DOM **保留**（`display:none`），`useState`/`useRef`/DOM 内部状态（`<textarea>` 内容、视频 currentTime）全保留；
- **所有 Effect 被 cleanup**（`useEffect`/`useLayoutEffect` 的订阅、observer、websocket 都会摘掉），回到 visible 再重建；
- 收到新 props **仍会重渲染**，只是走低优先级；
- 初次渲染即 hidden：会预渲染（能触发 `use()`/Suspense 取数），但**不跑 Effect**，所以放在 `useEffect` 里的取数不会被预热；
- 纯文本返回、无 DOM 节点的子组件在 hidden 下不会留下任何可挂载点（做测量逻辑时会踩）；
- `<video>/<audio>` 不会自动暂停，需要在 `useLayoutEffect` 的 cleanup 里显式 `pause()`（`useLayoutEffect` 保证与 DOM 更新同步，避免 View Transition 期间还在放声）。
- 额外收益：Activity 是 **Selective Hydration** 的单元，即使不用 Suspense，也能让 tab 按钮先可交互。

### 1.5 `useEffectEvent`（19.2）
```js
const onTick = useEffectEvent(() => { setCount(c => c + step) }); // step 读最新值
useEffect(() => { const id = setInterval(onTick, 1000); return () => clearInterval(id); }, []);
```
- 返回函数**永远读最新已提交**的 props/state/context；
- **identity 每次 render 都变**，因此不得写进依赖数组（lint 直接拦）、不得传给子组件、不得存进 ref/外部对象；
- 只能在 `useEffect`/`useLayoutEffect`/`useInsertionEffect` 或另一个 effect event 内调用，render 阶段调用会抛错；
- 正当用途：Effect 内部的"事件"（定时器 tick、socket 回调里读最新 UI 状态）；**不正当用途**：该进 deps 的东西被它藏起来（例如 `pageUrl` 变了但 effect 不重跑 → 漏埋点）。

### 1.6 React Compiler 1.0
- `babel-plugin-react-compiler`（`target: '17'|'18'|'19'`；<19 需 `react-compiler-runtime`），`compilationMode: 'annotation' | 'infer' | 'all'`，`panicThreshold: 'none'`（跳过报错组件而不是 fail build），`gating: { source, importSpecifierName }` 做运行时开关。
- 指令 `"use memo"` / `"use no memo"`：必须是**函数体第一句**或**文件第一句（在所有 import 之前）**，函数级覆盖模块级。
- 关键认知：编译器把 **Rules of React 违规升级为编译错误**（不再只是"偶发 bug"）；mutate props 在 render 中、隐式依赖外部可变值、条件调用 hook 都会编译失败。手写 `useMemo/useCallback/React.memo` 大部分可删，但**引用稳定性契约**（传给外部 store/第三方 hook 的回调、`useSyncExternalStore` 快照、依赖 identity 做 `key`）仍需人工保证。

### 1.7 Server Components 边界（只有 `llm-rubric` 能考）
边界由 **模块依赖树**决定：`'use client'` 模块 import 的一切（含其传递依赖）都会被打进浏览器 bundle → 密钥/内部算法泄漏。Server→Client props 可序列化清单：
- 允许：primitives（`string/number/bigint/boolean/undefined/null` + **仅 `Symbol.for` 注册的 symbol**）、`String/Array/Map/Set/TypedArray/ArrayBuffer`、`Date`、plain object、JSX 元素、**Promise**、Server Function；
- 禁止：普通 function（非 Server Function、非客户端模块导出）、class、class 实例（内置类之外）、`Object.create(null)` 对象、未注册 symbol。
`children` 传 Server 元素给 Client 组件是合法的"插槽"，因为 render 树不决定执行环境。

---

## 2. senior / principal 会被追问什么

**5 年能过 vs 10 年分辨点**
1. 你说"用了 transition 就不卡"——**被丢弃的那次渲染去了哪里**？lane 之间如何抢占？如果 input 更新和 transition 更新同时 pending，commit 顺序是什么？
2. `use(promise)` 传下去的是 promise 还是数据？父组件 re-render 时子组件会不会重复挂起？**如何用一次网络请求证明你的缓存是真的按 key 命中**（不是"看起来只有一次"）？
3. Actions 的串行队列与 `useOptimistic` 的重放语义：如果 action 里 `await` 了 3 个写、中途用户又点了一次，UI 上会出现什么？为什么乐观态最后会回弹而不是"脏"？
4. `Activity` 的 Effect cleanup 对**你现有的** WebSocket 单例 / MutationObserver / 埋点 session 计时意味着什么？切回 visible 时的重建风暴（N 个实例同时重连）怎么抑制？
5. 上了 React Compiler 之后，你的 **测试策略**怎么改：以前测"memo 有没有生效"（render 计数）还有效吗？如何做性能回归的护栏？
6. 一个 INP 从 180ms 恶化到 900ms 的线上问题，给你 `Profiler` 的 `actualDuration/baseDuration`、long-animation-frame 的脚本归因、hydration 时间点，你的归因链路是什么？
7. 跨 Server/Client 边界的 `Map`/`Set`/`class`/回调为什么不能直接传？给三种真实 bug（Date 变 ISO 字符串导致 `date.getTime is not a function`、`Error` 的 stack 被裁剪、Set 被当数组展开）的修复模式。

**principal 级再加**
- 迁移决策：存量 500 组件库上 Compiler 的分批策略、回滚开关（`gating`）、以及**编译期硬失败**带来的发布阻塞风险怎么控？
- `use()` 与 Suspense 引入的"渲染可挂起"对服务端渲染预算的影响（streaming 下 TTFB/LCP/CLS 指标重新定义，以及"骨架屏时间变长是否可接受"的产品权衡）。
- 并发正确性的**规范**：什么类型的更新必须禁止降级（鉴权、金额、幂等 token）？团队 lint/CI 如何强制？

---

## 3. 常见错误答案

| ❌ 错误说法 | 为什么错 | ✅ 正确说法 |
| --- | --- | --- |
| "`use()` 可以在事件处理里 `await`，所以是 async 语法糖" | `use` 只能在 render 中调用；在回调里调用直接抛错 | 回调里用 `await`/`startTransition`，render 里用 `use(缓存的 promise)` |
| "给 `use()` 传 `fetch(url)` 就行，React 会帮我缓存" | React 只按 promise **实例**识别；每次 render 新建实例 → 重复挂起与重复请求 | 自己按 key 缓存实例（模块级 Map / `cache()` / 框架去重） |
| "`use(promise)` reject 我可以 try/catch" | 通过 throw 接 Suspense/Error Boundary，本地 try/catch 无效 | 用 Error Boundary；或把 promise 包成 `Result` 再渲染 |
| "action 里抛错能被 `isPending` 捕捉" | 抛错会跳过队列后续 action 并冒泡到边界；`isPending` 只表示有 pending action | 业务失败 return state；异常只用于契约/未知错误 |
| "`useOptimistic` 需要在 catch 里手动回滚" | 乐观态只在 transition 期间存在，base 未更新就自动回弹 | 失败时只做"提示/重试"，不要写 undo（写了反而双回滚闪烁） |
| "`useFormStatus` 在同一个组件里读 submit 按钮状态" | 它读的是"所在表单"的状态，必须在 `<form>` 的后代组件里 | 拆 `<SubmitButton/>` 作为 form 子组件 |
| "`Activity mode='hidden'` 等价于 `display:none` / 或等价于卸载" | 既不是纯 CSS（Effect 会被 cleanup），也不是卸载（状态与 DOM 保留） | "后台活动"：状态保、Effect 摘、低优先级可重渲染 |
| "hidden 的 Activity 不会渲染" | hidden 且首次渲染时会**预渲染**（用于预热代码与 `use()` 数据） | 只有 `use()`/Suspense 数据会预热；`useEffect` 取数不会 |
| "`useEffectEvent` 返回的函数引用稳定，可以传下去当依赖" | identity 每次 render 变化，且禁止出现在 deps / 传外部 | 需要稳定引用就用 `useCallback`；effect event 只在 Effect 内用 |
| "有了 Compiler，`useCallback` 全删，第三方库参数引用也稳定了" | 编译器只优化它看得见的代码；对不透明 props、外部 store 快照不做保证 | 跨边界/API 契约处仍要显式稳定引用并加测试 |
| "`"use no memo"` 写在函数任意位置都行" | 必须是函数体/文件首句（文件级需在 import 之前），否则被忽略 | 放最前面 + 注释原因与 TODO 单号 |
| "Server Component 可以传函数给 Client 组件" | 只有 **Server Function**（`'use server'` 导出）可跨边界序列化 | 普通回调改为客户端自己定义，或用 Server Function |

---

## 4. 可判分出题角度

### 角度族 A：优先级与丢帧（`code`）
给 fake timer + `Profiler` 探针，断言"哪一帧提交了什么值"。可测的确定性信号：`onRender` 回调序列、`commit` 时的 DOM 文本、render 次数上限。

### 角度族 B：Actions/乐观态（`code`）
注入可控 deferred（`new Promise(r => resolveLater)`）而不是真网络；断言 pending 期间按钮 disabled、`previousState` 值、队列串行（第二次 dispatch 在第一次 resolve 之后才发起）、失败后回弹。

### 角度族 C：`use()` 缓存与竞态（`code`）
断言 `fetchMock` 调用次数（同 key 1 次）、快速切 key 时旧请求 resolve 后 DOM 不被污染（这是最能区分经验的一题）。

### 角度族 D：边界/迁移决策（`rubric`）
Compiler 上线计划、RSC 边界重划、INP 归因链路。

---

### 题面草稿 1（`code`，`judgeKind: react-vitest`，difficulty: senior）
> 实现 `src/ConcurrentUserCard.tsx`：组件接收 `userId: string` 与导出的 `fetchUser(id): Promise<User>`（测试侧提供 mock，可控制 resolve 时机）。要求：
> 1. 用 `use()` 读取 promise 渲染姓名；同一 `userId` 在一次挂载周期内**只允许调用一次** `fetchUser`；
> 2. 父组件通过 `<Suspense fallback="loading">` 包住，切换 `userId` 时不得出现"新 id + 旧数据"的中间帧（不允许脏渲染）；
> 3. 提供一个 `RefreshButton`，点击后**不重新挂载子树**（内部状态必须保留）即可完成数据刷新，刷新期间旧数据继续可见；
> 4. 请求失败时由外层 Error Boundary 捕获，Boundary 提供 `reset()` 后可再次发起请求。
> 约束：不得使用 `useEffect` 里的 `setState` 做数据加载；不得 try/catch 包住 `use()`。

**用例设计（≥3，含边界）**
| 用例名 | 操作 | 断言 |
| --- | --- | --- |
| `dedupes_promise_per_id` | 挂载 `id='u1'`，20 次父级 rerender | `fetchUser` 调用次数 `=== 1`；DOM 文本稳定 |
| `no_stale_frame_on_switch` | `id='u1'` resolve 前把 `id` 改为 `'u2'`，之后先 resolve u2、再 resolve u1 | DOM 最终显示 u2 的姓名；u1 resolve 后**不重渲染回 u1**；`fallback` 出现次数 ≤1 |
| `refresh_keeps_state` | 在子组件里放 `useState(7)` 计数器（已 +1 到 8），点击 refresh 并 resolve 新数据 | 计数仍为 8（未重挂）；姓名更新；`fetchUser` 共 2 次 |
| `reject_goes_to_boundary_and_recovers` | 让首次 promise reject，随后 `reset()` | Boundary fallback 文案出现；reset 后再次调用 `fetchUser`（总次数 +1）并正常渲染 |
| 边界：`id=''`/`undefined` | 传空 id | 不发请求，渲染 `not-found` 分支（验证调用方做了输入校验，而不是把空串当 key 缓存） |

---

### 题面草稿 2（`code`，`judgeKind: react-vitest`，difficulty: principal）
> 实现 `src/TabShell.tsx` + `src/Panel.tsx`：3 个 tab，切走的 tab 用 `Activity` 保活。`Panel` 内部：`<textarea>` 受控输入、一个 `WebSocket` 单例订阅（测试注入 `createSocket()`，提供 `connect/close/onMessage`）、一个 `useEffectEvent` 的 `onMessage` 处理器（读取当前 `filter` prop 并累计计数）、以及 `startTransition` 驱动的 10k 行过滤列表。
> 要求：
> 1. 切走时**必须**关闭该 panel 的 socket，切回时必须重连且**不重复请求**已被缓存的初始数据；
> 2. `filter` 变化不得导致 socket 重连；
> 3. 输入 typing 期间，列表首帧允许是旧结果，但必须在下一帧收敛；
> 4. 组件树不得出现任何 `useMemo/useCallback`（考察"是否还需要手动 memo"）。

**用例设计（≥3，含边界）**
| 用例名 | 断言 |
| --- | --- |
| `cleanup_on_hide_reconnect_on_show` | 隐藏：`close` 调用 1 次；显示：`connect` 调用次数 = 2（首挂 + 切回）；`initialData` 请求次数始终为 1 |
| `filter_change_does_not_resubscribe` | 改 `filter` 5 次 → `connect` 仍为 1；`onMessage` 读到最新 filter（消息到达后计数按新 filter 判定） |
| `typing_priority` | 输入 3 个字符：每次输入的第一次 commit 里列表文本仍是旧过滤结果，紧随其后的一次 commit 收敛；`onRender` 记录中"高优先级 commit"耗时上界受控（只断言序列，不断言墙钟） |
| 边界：初次渲染即 hidden 的 tab | `connect` 与数据请求均为 **0**（预渲染不跑 Effect），`textarea` 不存在内容 |
| 边界：快速 A→B→A 连点（<1ms） | 无"close 之后又 close"的重复；最终状态为 A 可见且 socket 只有 1 个活动连接 |

---

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 场景：内部中台，React 18 → 19.2 + React Compiler 全量上线。给出 5 个必须回答的取舍：(a) 编译器为什么把 Rules of React 违规变成硬错误，对发布流程意味着什么；(b) `panicThreshold`/`gating`/`compilationMode:'annotation'` 在灰度中各自扮演什么；(c) 哪些手写 memo 必须保留并如何用测试固化；(d) 引入 `Activity`/`use()` 后 SSR 首屏指标如何重新解读；(e) 团队规范层面如何防止用 `useEffectEvent` 隐藏真实依赖。

**rubric.points（权重合计 10）**：编译器语义 2｜灰度/回滚机制 2｜保留 memo 的具体判据 + 测试手段 2 | 指标重解读（TTFB/LCP/长任务与 streaming）2｜规范与 lint 落地 2。
**bonus**：提到 `target`/`react-compiler-runtime` 与 React 19 的差异；提到 `"use no memo"` 必须为首句；提到 Activity 预渲染不跑 Effect 导致预热策略要改；给出"编译失败即 PR 阻塞 + 例外需 owner 签字"的流程。
**gaps**：认为编译器能替代数据层缓存；认为 `useCallback` 全删无风险；把 `Activity` 当 `display:none`；只谈"性能变好"不给度量口径。

---

## 5. 对标 JD 能力项
| 本文件内容 | JD 能力码 | 说明 |
| --- | --- | --- |
| 优先级/INP 归因、`use()` 竞态 | `APL-WEB-2`、`APL-WEB-3` | 大型 Web 应用的交互延迟与异步正确性 |
| Actions/乐观态/表单渐进增强 | `APL-WEB-3`、`ABNB-WEB-1` | 高一致性的交互设计，跨团队组件契约 |
| Compiler 迁移与规范落地 | `APL-WEB-1`、`APL-WEB-5` | 存量代码库可维护性、CI 可判分性 |
| RSC 边界与序列化 | `APL-BE-1` | 全栈边界与协议设计（Apple/Airbnb 全栈 JD 的 "server-driven UI / API contracts"） |
