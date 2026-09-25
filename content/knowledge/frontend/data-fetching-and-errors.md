# 数据获取、缓存一致性与错误/取消分类

适用：React 19.2 客户端（无框架级 RSC），`fetch` + `AbortController`，缓存语义参照 TanStack Query 的成熟口径（`staleTime`/`gcTime`/invalidate），但题目**自己实现一个 mini 缓存层**以考真实理解。判分方式：`react-vitest` + `llm-rubric`。

---

## 1. 核心机制

### 1.1 请求生命周期的四个正确性关口
1. **发起**：key 必须覆盖全部影响结果的输入（租户、语言、权限范围、分页游标、排序）。少一个字段 = 线上必现的"数据串号"。
2. **取消**：参数变化或卸载时 `abort()` 上一个 in-flight。信号不是"请求失败"，而是**这次结果不再被需要**。
3. **竞态**：即使不 abort，也必须丢弃"非当前代"的响应。实现口径：给每次请求打 `epoch`（自增），commit 前比较 `epoch === latestEpochRef.current`。仅靠 abort 不够——`AbortSignal` 不保证浏览器停止回调，且并发/预取场景下同一 key 可能有多个 in-flight。
4. **提交**：只在"数据 + key + epoch"三者一致时写 state；失败与取消走不同分支。

```ts
type Err =
  | { kind: 'aborted' }                                   // 不算错误：不显示 error UI、不重试、不上报
  | { kind: 'network'; retryable: true }                  // DNS/连接重置/超时
  | { kind: 'http'; status: number; retryable: boolean; code?: string } // 429/5xx 可重试（受方法幂等约束）
  | { kind: 'contract'; detail: unknown }                 // 200 但 body 不符合 schema：绝不重试，直接告警
  | { kind: 'forbidden' | 'unauthorized' };
```
`catch (e)` 里 `e` 是 `unknown`：用 `e instanceof DOMException && e.name === 'AbortError'`（部分环境是 `'AbortError' in e` / `signal.aborted`）判定取消，**不要**用 `e.message.includes('abort')`。

### 1.2 重试、退避与幂等（senior 必答）
- 只对**幂等**操作重试：GET/HEAD/PUT/DELETE（服务端实现需真幂等）；POST 默认不重试，除非带 `Idempotency-Key` 且服务端支持。
- 指数退避 + **抖动（jitter，full/equal）**：`delay = min(cap, base * 2^n)`，再随机化，避免"同一客户端集群同步重试"造成雪崩。
- 上限三重：`maxAttempts`、`totalTimeout`（含已耗时，用 `AbortSignal.timeout()` 与外层 signal `AbortSignal.any([...])` 组合）、`retry-after` 优先（429/503 带 `Retry-After` 时必须尊重，否则被服务端限流惩罚）。
- 重试必须与取消共享同一个 signal 链：`abort()` 后不得再有下一次尝试。
- 去重与并发合并（singleflight）：同一 key 并发 10 次只发 1 次请求，其余等同一 promise；注意"失败也要共享"（避免每人各试一次）与"取消不能污染共享 promise"（**订阅者 abort 不应取消共享请求**，除非引用计数归零）。

### 1.3 缓存新鲜度与失效
- `staleTime`（多久后需要后台再验证）≠ `gcTime`（无引用后多久释放内存），混淆会导致"永远不再验证"或"内存泄漏"。
- SWR 语义：有旧数据先渲染旧数据（UI 不闪），后台再验证成功后**原子替换**，失败时保留旧数据 + 标记 stale（不是切错误态）。
- 分页：`keepPreviousData`（`placeholderData`）避免翻页白屏，但**行内高亮/统计必须来自当前页**（否则出现混合帧）；深分页必须让后端支持游标（`keyset`），前端不该发 `offset=100000`。
- 失效策略优先级：变更点显式 `invalidate(keys)` > 依赖 `etag`/`last-modified` 的 304 > 定时轮询 > 手动刷新按钮。写操作后的读一致性（写后读到旧值）要用"携带 `version` 的响应 + 本地版本号比较"来丢弃旧响应。
- 条件请求：`If-None-Match`/`ETag` 让 304 只省传输，**不省 RTT**；对"每次打开都变"的接口用 `Cache-Control: no-cache, must-revalidate` 而不是禁用缓存。
- 与服务端一致性：跨实体写要一次性提交（BFF 聚合或后端事务），前端"串行 3 个 PATCH + 乐观回滚"只能做到最终一致且窗口内 UI 可能自相矛盾。

### 1.4 与 React 19 的接线
- `use(cachedPromise)`：Suspense 友好的读；promise 必须来自上面 §1.2 的共享缓存（key → promise），否则重复请求。刷新 = `startTransition` 换 promise 实例，保留子树状态。
- Actions（`useActionState`）做写：`dispatchAction` 串行排队天然给了"写操作不会并发交错"的保证；action 内部要 `invalidate` + 依赖 `useOptimistic` 做即时反馈，失败靠 base 未更新自动回弹。
- 卸载与 `use()`：组件在 promise resolve 前被卸载，React 不会 setState，但**共享 promise 与其副作用（缓存写入）仍会完成**——把缓存写入放在 promise 链里而不是组件里，才能避免"半更新缓存"。
- Server 端渲染场景（`llm-rubric` 才考）：Server 取数 + Client `use()` 同一 promise，跨边界序列化的是 **promise 本身**，因此"客户端二次请求同一资源"要靠框架去重，否则 waterfall 变成双请求。

### 1.5 输入与本地化边界（同一题里就能顺带考的失分点）
- 金额：`'1 234,56'`（de-DE）与 `'1,234.56'`（en-US）不能靠 `parseFloat`；`Intl.NumberFormat(locale,{style:'currency',currency}).format` 输出含 U+00A0（`¥ 1,234`、`1 234,56 €`），与后端比对前必须归一化；JPY 无小数位，`0.1+0.2` 用整数分或 decimal 字符串。
- 时间：只传 `epoch + IANA tz`；`new Date('2026-02-30')` 在各引擎不一致；跨 DST 的"加 24 小时"≠"次日同一墙钟时间"；`toISOString()` 永远是 UTC，展示层再转。
- 文本：`'Ça'.length` vs `codePointLength` vs grapheme（`Intl.Segmenter`）；排序用 `Intl.Collator`（并缓存实例，别在比较函数里每次新建）。
- ID：后端 int64 在 JS 里精度丢失（>2^53）→ 必须 string 或 `BigInt`；`JSON.parse` 不会保留 `BigInt`，这是"类型层与运行层双重契约"的经典案例。

---

## 2. senior / principal 会被追问什么
1. 你怎么证明"没有竞态"？（要求给出可测的不变式：任一帧内 `displayedKey === requestedKey`，而不是"我用了 abort 所以没事"）
2. 同一 key 并发 50 个订阅者、其中 49 个卸载了，请求要不要取消？给出引用计数实现与其副作用（计数泄漏、abort 风暴）。
3. `429 + Retry-After: 120` 与 `maxAttempts: 3` 冲突时谁赢？`totalTimeout` 到了但还有退避时间，你返回什么？
4. 缓存要带版本号还是带 `updatedAt`？两者在"服务端时钟回拨 / 主从延迟读到旧值"下的差异（引出"写后读一致只能靠客户端 version 或强一致读"）。
5. 你如何设计"部分失败"的列表（50 行里 2 行取失败）：整树报错、行级降级、还是 retry-queue？
6. 可观测性：一次请求要带哪些字段才能定位问题（`requestId` 贯穿、`epoch`、cache key、`traceparent`），以及如何避免把 PII 打进上报。
7. principal：给 BFF/后端团队的接口契约评审清单（幂等性声明、错误码分类、分页形式、批量与部分失败语义、ETag 支持、超时预算）；以及"前端重试策略与服务端限流"的全局协同。

---

## 3. 常见错误答案

| ❌ 说法 | 真相 |
| --- | --- |
| "用了 `AbortController` 就不会有竞态" | abort 只是提示；且共享 promise、预取、非 fetch 客户端（ws/缓存）没有 abort。竞态必须靠"代际比较"兜底 |
| "catch 里 `if (e.name !== 'AbortError') setError(e)` 足够" | `e` 是 `unknown`；`AbortError` 在部分环境是 `DOMException`、在 Node `undici` 下 message 不同；正确做法是同时看 `signal.aborted` |
| "取消后把 error 态设为 'aborted' 让用户看到" | 取消不是错误，必须静默丢弃，否则切 tab 时闪现红色报错 |
| "所有 5xx 都重试 3 次" | POST 非幂等会造成重复下单；要方法 + 幂等键双重约束；且 `Retry-After` 必须优先 |
| "固定退避 1s、1s、1s" | 无抖动会同步重试风暴；也不尊重服务端 `Retry-After` |
| "`staleTime` 和 `gcTime` 是一回事" | 前者控制"是否需要再验证"，后者控制"内存回收" |
| "写成功后 `invalidateQueries()` 全部即可" | 全量失效 → N 个并发请求（stampede）；应按 key 前缀精确失效 + `refetchType` 控制 |
| "翻页时 `key={page}` 强制重挂最省事" | 丢滚动位置/表单状态、白屏，并让 keepPreviousData 失效 |
| "前端把 int64 id 转成 Number 没问题" | >2^53 精度丢失，`id 9007199254740993` 变 `...992` → 改错记录 |
| "错误边界能捕获事件回调里 throw 的错误" | 边界只捕获 render/生命周期/Effect 中的错误；异步回调要 `onError` 参数或自行上报 |
| "`fetch` 超时用 `Promise.race` 就行" | 超时后原请求仍在跑（幽灵请求、并发打满）；必须 `AbortSignal.timeout()`/`AbortSignal.any` 真正取消 |
| "响应 200 但字段变了 → 重试一下也许就好" | 契约错误重试无用，应熔断 + 告警，并走 `contract` 分支 |

---

## 4. 可判分出题角度

可判分的核心信号（全部可在 jsdom 里确定）：`fetchMock` 调用次数与参数、每次调用的 `signal` 是否来自同一链、commit 序列里的 `key/data` 配对、`vi.advanceTimersByTimeAsync` 下的重试间隔区间、`AbortSignal.aborted` 状态。
**反模式检测点**（隐藏用例专门打这些）：用 `setTimeout` 猜时序、错误态吞掉 aborted、无抖动的固定退避、共享 promise 被单个订阅者 abort。

### 题面草稿 1（`code`，`judgeKind: react-vitest`，difficulty: senior）
> 实现 `src/useResource.ts`：`useResource<T>(key: Key, opts?) => { read(): Promise<T> }`（供 `use()` 调用）+ 内部缓存。要求：
> 1. 同一 key 的并发调用**只发一次** `fetchImpl`；失败也共享同一个 rejection（但失败结果**不缓存**，下一次调用重新发起）；
> 2. key 变化时取消上一代请求（`signal.aborted === true`），且旧响应即使晚到也不得写入缓存、不得让任何订阅者看到；
> 3. 重试：`maxAttempts: 3`、退避 `base * 2^n` 且**必须带随机抖动**（通过注入 `random()` 使间隔可断言）、尊重 `Retry-After`（当响应 `status === 429` 且带该头时，第一次等待必须 `>= Retry-After`）、`totalTimeout` 到则返回 `aborted` 分类错误而不再重试；
> 4. 只有 `GET` 语义（由 `opts.method ?? 'GET'`）或显式 `opts.idempotencyKey` 才允许重试；
> 5. 错误以 §1.1 的判别联合返回，绝不 throw 原始 `unknown`。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `dedupe_concurrent` | 10 个并发同 key → `fetchImpl` 调用 1 次；全部拿到同一 resolved 值 |
| `cancel_on_key_change` | 同组件树内 key 从 `u/1` → `u/2`：`u/1` 的 signal.aborted 为 true；`u/1` 延迟 resolve 后缓存里仍是 `u/2` 的数据，DOM 不出现 `u/1` 姓名（**核心竞态用例**） |
| `retry_backoff_with_jitter` | 注入 `random = () => 0.5`、`base = 100`：429/503 序列后 `advanceTimersByTimeAsync` 断言等待恰为抖动后区间；再跑一次 `random = () => 0`，断言与 `0.5` 时不同（证明不是常量等待） |
| `respects_retry_after` | 首响应 429 带 `Retry-After: 5` → 第一次重试时刻 `>= 5000ms`，且**不消耗** attempt 上限之外的等待 |
| `failure_not_cached` | 首次 reject 后第二次调用 → `fetchImpl` 再次被调用（不返回缓存 rejection） |
| 边界：`method: 'POST'` 无 `idempotencyKey` | 首次 503 即返回错误，`fetchImpl` 调用次数 `=== 1` |
| 边界：`totalTimeout: 250` 且 base=200 | 第二次退避会超时 → 返回 `aborted` 分类，`maxAttempts` 用不到 |

### 题面草稿 2（`code`，`judgeKind: react-vitest`，difficulty: principal）
> 实现 `src/InvoiceForm.tsx` + 一个 `mutate` Action：金额输入（受 locale 影响的字符串）+ 保存。要求：
> 1. 输入解析用注入的 locale（`de-DE` 的 `1.234,56` 与 `en-US` 的 `1,234.56`），非法输入给行内校验错误而不是 `NaN`；
> 2. 提交走 Action（`useActionState`）+ `useOptimistic` 显示"保存中"，乐观态在失败时自动回弹；
> 3. 幂等：同一次编辑重复点击只产生一次后端写（携带 `Idempotency-Key = hash(字段快照)`），按钮 `pending` 由 `useFormStatus` 在子组件里给出；
> 4. 409 冲突（版本号过期）时必须重新拉取 + 冲突合并 UI，不覆盖服务端；
> 5. 所有请求带 `traceId`，取消分类不得上报错误。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `locale_parsing` | `'1.234,56'` in de-DE → `1234.56`；`'1,234.56'` in de-DE → 校验错误（不允许静默解析成 1.234） |
| `single_write_on_double_click` | 连点 3 次 → `mutate` 调用 1 次、`Idempotency-Key` 三次相同 |
| `rollback_on_failure` | mutate reject（422）→ 保存后 DOM 回到 base 值，显示 toast；无手动 undo 代码 |
| `conflict_refetch_merge` | 409 → 触发 1 次 GET、渲染冲突面板、原编辑内容保留在"你的版本"栏 |
| 边界：编辑中途字段变化 | 改变金额后再点，`Idempotency-Key` 必须变（旧快照不阻塞新写）；上一笔仍 pending 时新提交排队（`useActionState` 串行） |
| 边界：`BigInt` ID | `id='9007199254740993'` 全程为字符串，不发 `Number(id)`，断言 mutate payload 里该字段完全相等 |

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 设计一个"移动端弱网 + 后端多团队 API"下的数据层规范：缓存 key 规则、取消/超时预算、重试与幂等矩阵、部分失败语义、失效与写后读一致策略、可观测字段。要求给出**可被 CI 判分**的三条不变式。

**points**：key 与失效规则 2｜取消/超时/退避与幂等矩阵 3｜一致性与版本策略 2｜部分失败建模 1｜可观测字段 1｜可判分不变式 1。
**bonus**：给出 singleflight 引用计数与"订阅者取消不终止共享请求"的取舍；提到 `Retry-After` 与客户端预算冲突时的降级（返回 stale 而非 spinner）；把"契约错误不重试"变成告警指标。
**gaps**：笼统"加缓存/加重试"；无幂等矩阵；把取消计入错误率；不变式写成"要快"。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 竞态/取消/幂等/退避 | `APL-WEB-3` |
| 缓存 key、失效策略、写后读一致 | `APL-WEB-4`、`ABNB-BE-1` |
| 错误分类与上报字段 | `APL-WEB-3`、`APL-WEB-5` |
| locale / 精度 / 时区边界 | `APL-WEB-4`、`ABNB-WEB-1`（国际化产品） |
