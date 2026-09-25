# TypeScript 类型系统与严格建模（5.7 → 6.0 → 7.0 时代）

适用版本：`typescript@5.7/5.8/5.9`（现役语言特性）、`6.0`（2026-03-23，默认值/移除项的分水岭）、`7.0`（2026-07-08，Go 原生重写）。判分方式：`react-vitest`（编译期零 error + `vitest typecheck` + 运行时用例）。

---

## 1. 核心机制

### 1.1 严格性是分层的，不是一个开关
`strict: true` 只是**一组 flag 的合集**（`noImplicitAny`、`strictNullChecks`、`strictFunctionTypes`、`strictBindCallApply`、`strictPropertyInitialization`、`useUnknownInCatchVariables`、`alwaysStrict`）。senior 的标志是知道 **strict 挡不住什么**：

| flag | 它真正拦住的一类 bug | 为什么不在 `strict` 里 |
| --- | --- | --- |
| `noUncheckedIndexedAccess` | `arr[i]` / `map[k]` 当"一定存在"用（越界返回 `undefined`） | 会强迫大量非空断言，历史包袱重 |
| `exactOptionalPropertyTypes` | `{a?: string}` 被显式写成 `{a: undefined}` 造成的"缺失 vs 显式 undefined"二义 | 与"可选属性可赋 undefined"的直觉冲突 |
| `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` | 索引签名的点访问 `obj.foo` 实际是 `obj['foo']`，可能不存在 | 与 JS 写法习惯冲突 |
| `noPropertyAccessFromIndexSignature`、`useUnknownInCatchVariables`（后者在 strict 内） | `catch (e) { e.message }` 在 `unknown` 下必须先收窄 | — |
| `noImplicitOverride`、`noFallthroughCasesInSwitch`、`noUnusedLocals` | 类覆盖漏写 `override`、`case` 忘 `break` | 与 strict 无关 |
| `isolatedModules`（transpile 一致性）+ `verbatimModuleSyntax` | 跨文件 re-export 类型被擦除后运行期报错；`import type` 与运行期导入混用 | 属于"单文件编译"约束 |
| `erasableSyntaxOnly`（5.8） | `enum`/`namespace`/参数属性在 type-stripping 运行下会炸 | 为 Node 直跑 TS / 7.0 时代铺路 |
| `noUncheckedSideEffectImports`（5.7 引入，6.0 起默认 `true`） | `import './x.css'` 指向不存在的文件被静默忽略 | 需要 `moduleResolution: bundler/node16+` 才能定位 |

TS 6.0 的**新默认**（写题面必须钉死版本，否则判分口径不一致）：`strict: true`、`module: esnext`、`target: 当年 ES（es2025 起）`、`types: []`（不再自动吃全部 `@types`）、`rootDir: '.'`、`libReplacement: false`、`noUncheckedSideEffectImports: true`；**移除** `target: es5`、`downlevelIteration`、`moduleResolution: classic` 与 `node`(=node10)、`module: amd/umd/systemjs/none`、`baseUrl`、`esModuleInterop: false`、`allowSyntheticDefaultImports: false`、`alwaysStrict: false`、`outFile`、`import assert`（改 `with`）、legacy `module` 命名空间语法、`/// <reference no-default-lib="true"/>`；新增 `es2025` target/lib、`dom` 含 `dom.iterable`/`dom.asynciterable`、`Temporal`/`RegExp.escape`/`Map.getOrInsert` 类型、`--stableTypeOrdering`（对齐 7.0 的确定性排序）、支持 `#/` 子路径导入。
7.0 是同一套语义的 Go 实现（官方 8–12x），但**编译器 API 尚未提供**，所以 `vitest typecheck`、ts-node/tsserver 类工具仍必须留在 6.x —— 这也是本项目判题镜像不追 7.0 的唯一硬理由。

### 1.2 建模：判别联合优先于旗标
```ts
type Fetch<T> =
  | { status: 'idle' }
  | { status: 'loading'; startedAt: number }
  | { status: 'error'; error: unknown }          // unknown 强制收窄后才能用
  | { status: 'success'; data: T; etag?: string };
```
- 穷尽性检查靠 `never`：`default: const x: never = s satisfies never; throw new Error(String(x))`。加了新分支后编译失败 = 需求变更的**唯一自动化护栏**。
- 用 `satisfies` 保留字面量推断：`const ROUTES = { home: '/', user: '/u/:id' } satisfies Record<string, `/${string}`>` —— 既约束形状，又让 `typeof ROUTES.home` 保持 `'/'` 而不是被标成 `string`（`as const` 只给字面量但不校验形状，二者不等价）。
- 4 个 boolean 有 16 个组合，建模只允许 3 个 → 用判别式把不可能状态变成**不可表示**（"make illegal states unrepresentable" 的真实收益是少写 defensive 代码，不是玄学）。

### 1.3 条件类型的三条反直觉规则（考 senior 的最短路径）
1. **分布律**：`T extends U ? X : Y` 中 `T` 是**裸类型参数**时，对 union 逐项分布。`Exclude<T,U>`/`Extract<T,U>`/`NonNullable<T>` 全靠这个才好用；不想分布就包一层 `[T] extends [U]`。
2. **`any` 的分支爆炸**：`any extends string ? 'a' : 'b'` 结果为 `'a' | 'b'`（`any` 被当作"既满足又不满足"），因此 `IsAny<T> = 0 extends 1 & T ? true : false` 是标准判法。
3. **空 union（`never`）会短路**：`never extends X ? A : B` 分布后得 `never`，导致"传 `never` 时整个工具类型变 `never`"的诡异表现，故需要 `[T] extends [never]` 分支。
另两条常考：`Omit<T,K>` = `Pick<T, Exclude<keyof T, K>>`，其中 `T` 不是裸参数 → **不分布**，`Omit<A|B,'x'>` 会把 union 折叠成公共键（要 `type DistributedOmit<T,K> = T extends unknown ? Omit<T,K> : never`）；`Partial<T[]>` 作用在数组上是把数组自带成员（`length`、`map`…）变可选，只有 **tuple** 才逐元素加 `?`。

### 1.4 推断的可控性
- `NoInfer<T>`（5.4）：`function f<T>(a: T, b: NoInfer<T>)` 让 `b` 不参与推断，只被校验 —— 解决"第二参数把 T 拉宽成 union"的经典失真。
- 5.9 收紧了类型实参推断（不再把推断失败的槽位悄悄回填成 `unknown`），并把 DOM 声明换成带 summary 的形式（hover 更短，但依赖旧 `lib.dom.d.ts` 形状的代码需重看）。
- 递归类型（`DeepPartial`、`Json`、`Path<T>`）有**深度上限与 union 展开上限**：报 "Type instantiation is excessively deep" 的根因几乎都是"每一步同时展开多个分支"（`A | B` 的 `DeepPartial` 未分布 → 指数）或"缺终止位"（对象里含自身 `T[keyof T]` 无限下去）。改法：先分布、给 `Depth extends number` 计数刹车、或改成 lazy（`type X = { [K in keyof T]: X<T[K]> }` 本身是惰性的，一旦加 `Partial<…>` 立即强制展开）。

### 1.5 边界与类型安全
- 类型断言 `as` 只是让编译器闭嘴，**不产生任何运行时代码**；`unknown` → 收窄函数（`if (isUser(x))`）或 schema 解析才是真安全。
- 运行时校验放在**边界**（HTTP 响应、`postMessage`、`localStorage`、env、第三方 SDK 回调），内部保持类型可信；不要每个函数入口都 assert（成本 + 假安全）。
- 声明合并 / `declare module` 是给"第三方类型不足"的正规出口，但要限定在自己应用的 `.d.ts` 里、并配 `isolatedDeclarations`-风格的注释说明为何要扩。

---

## 2. senior / principal 会被追问什么
1. 你团队升到 6.0：`types: []` 与 `outFile` 移除会先炸什么？`rootDir` 默认变成配置目录会让哪些产物路径漂移？给出升级顺序（先对齐 `module/target`，再吃默认值）。
2. `strict` 打开后代码里出现了 200 个 `!`：这是"类型系统没用"还是"建模错了"？如何用 discriminated union / 收窄 / `Array.prototype.filter` 的类型谓词把 `!` 降到 0，并让 ESLint 禁掉 `!` 与 `as`（保留 `as const`）？
3. 给一个泛型 API：为什么 `useState<Record<string, unknown>>` 与 `useState<Record<string, unknown>>(() => ({}))` 在有 loader 的框架里会推断成不同的东西？（"contextually typed 的返回值" 与初始化器推断）
4. 类型层"性能"：为什么 `type Path<T> = T extends object ? { [K in keyof T]: `${K & string}.${Path<T[K]>}` }[keyof T] : never` 在一个 3 层 JSON 上就打满 100 万 instantiation？如何量（`--diagnostics`、`--extendedDiagnostics`、`tsc --generateTrace`）？
5. 你如何为"类型本身"写回归测试？`// @ts-expect-error` 的双向陷阱（错误消失时它自己会报错，这是特性不是 bug）、`expectTypeOf` 与 `vitest typecheck` 的 CI 接线方式。
6. 7.0 换 Go 实现后，**语义风险**在哪：诊断顺序、`--stableTypeOrdering`、增量编译边界、API 缺失导致工具链滞后 → 你的库要不要同时发 6.x/7.x 兼容层。
7. principal：把"类型契约"变成流程——库作者如何用 `--isolatedDeclarations` 强制显式导出类型、如何让 PR 里出现 `as any` 就自动要求 review。

---

## 3. 常见错误答案

| ❌ 说法 | 真相 |
| --- | --- |
| "`unknown` 和 `any` 一样，只是要多写一句" | 方向相反：`any` 双向豁免（可赋给任何类型、任何成员访问都过），`unknown` 只能被赋值进来、用之前必须收窄 |
| "`as T` 会在运行时做检查/转换" | 纯编译期；`x as User` 后访问 `x.phone` 该 `undefined` 还是 `undefined` |
| "`satisfies` 就是 `: Type` 的另一种写法" | `:` 会**擦除**字面量推断（`typeof x.home` 变 `string`），`satisfies` 只校验不覆写；两者可叠加 |
| "`Omit<A\|B,'k'>` 会分别处理两个成员" | `Omit` 不分布，union 被折叠成公共键 |
| "`interface` 性能一定比 `type` 好" | 名字/别名差异不是复杂度来源；真实差异是声明合并、`extends` 的早检查、以及匿名类型显示；交叉类型展开才是耗时源 |
| "开了 `strict` 就不用 `noUncheckedIndexedAccess`" | 前者完全不管索引访问，`arr[0]` 仍是 `T` 不是 `T\| undefined` |
| "`Partial<T[]>` 让每个元素可为 undefined" | 数组的 `?` 语义不适用，`Partial` 作用在成员上；逐元素可选只对 tuple 成立 |
| "`as const` 等于 `satisfies`" | `as const` 加 readonly + 字面量但不做形状校验 |
| "递归类型报 excessively deep 是 TS 的 bug，加 `as any` 解决" | 是展开策略问题；正确解：分布、加深度参数、避免过早强制展开 |
| "`// @ts-expect-error` 会静默忽略下一行" | 若下一行不再报错，`@ts-expect-error` 自身成为错误（可当断言用） |
| "`noUncheckedSideEffectImports` 只是 lint" | 它是编译器特性，需要能解析模块路径的 `moduleResolution`；6.0 起默认开 |
| "TS 7.0 出来了就把 CI 全切过去" | 7.0 无编译器 API，vitest typecheck / 各类工具仍依赖 6.x；且诊断顺序差异会打乱快照比对（`--stableTypeOrdering`） |

---

## 4. 可判分出题角度

类型题的判分本质：**编译器返回值 + 运行时用例**，两层都要。工程口径：
1. 判题工作区跑 `tsc --noEmit -p .`（严格配置由题目固定），非 0 → `status:'error'` 并回传前 20 行；
2. 再跑 vitest：既有运行时用例，也有 `expectTypeOf`/`// @ts-expect-error` 断言；
3. **反向用例**（重要）：隐藏用例里放"必须编译失败"的样本 —— 例如候选人若用 `as any` 绕过，`@ts-expect-error` 断言会因"预期错误未出现/出现位置不对"而失败。这样才能区分"真的建模对了"和"把类型关掉了"。

### 题面草稿 1（`code`，`judgeKind: react-vitest`，difficulty: senior）
> 在 `src/result.ts` 中实现 `Result<T, E>` 与配套工具，禁止使用 `any`、`as`（`as const` 除外）、非空断言 `!`，`tsc` 必须在 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noPropertyAccessFromIndexSignature` 下零 error。要求：
> 1. `type Result<T,E> = Ok<T> | Err<E>`，判别字段为 `ok: true/false`（判别式，不允许两个可选字段并存）；
> 2. `unwrapOr(res, fallback): T`、`map(res, fn)`、`andThen(res, fn)`、`fromPromise(p: Promise<T>): Promise<Result<T, unknown>>`（catch 值必须是 `unknown`，不得假设 `Error`）；
> 3. `combineAll(list: Result<T,E>[]): Result<T[], E>`：短路返回第一个 Err；
> 4. 提供 `match(res, { ok, err })`，其返回值类型由两个回调的返回类型联合而成，且**缺任一分支时编译失败**。
> 
> 边界约定：`fromPromise` 里 `Promise` reject 值为 `undefined` 时，`err` 字段必须是 `{ message: 'unknown' }` 形式的归一化结果（考察"不把 undefined 当 Error"）。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `combine_all_short_circuits` | `[ok(1), err('a'), err('b')]` → `err('a')`，且第三个 err 的构造副作用（用 `vi.fn` 包）未被调用 |
| `reject_with_undefined` | `Promise.reject(undefined)` → `ok:false`，`err` 归一化且不包含 `undefined`，运行时不抛 `cannot read message of undefined` |
| `match_requires_both_arms`（类型） | `// @ts-expect-error` 标注在只给 `ok` 分支的调用上；若候选人把 `match` 的 params 定义成全可选，则该断言失败 |
| `no_unchecked_access_escape`（类型） | 测试文件里 `res.data.items[0].x` 形式必须在候选人类型下报错（用 `@ts-expect-error` 固化） |
| 边界：空数组 | `combineAll([])` → `ok([])`，类型上 `T` 无法从元素推断，要求候选人显式给类型参数（判分点：不允许偷偷返回 `any[]`） |

---

### 题面草稿 2（`code`，`judgeKind: react-vitest`，difficulty: principal）
> 在 `src/paths.ts` 实现 `Path<T>`（所有合法点路径字符串联合，数组用 `${number}`，深度上限 6）与 `get(obj, path): PathValue<T, P>`（返回类型精确到叶子），以及 `pick<T, P extends Path<T>>(obj, p: P): PathValue<T,P>`。约束：
> 1. `Path<{a:{b:string}}>` 必须恰好等于 `'a' | 'a.b'`（用 `expectTypeOf<...>().toEqualTypeOf<...>()` 固化，测试提供）；
> 2. 对 union 字段必须分布：`Path<{x: A|B}>` 要把 A、B 的分支都枚举出来；
> 3. 含索引签名 `{[k:string]: number}` 时 `Path` 不得爆炸为无限 union（要求给出你的策略并在注释中说明取舍）；
> 4. `tsc --extendedDiagnostics` 的 `Instantiation count` 必须 ≤ 题目给出的阈值（把"类型层性能"变成可判分指标）。

**用例设计（≥3，含边界）**
| 用例 | 断言 |
| --- | --- |
| `exact_union_shape` | `toEqualTypeOf` 精确比较（不是 `extends`），多一个 `'a.'` 之类也算失败 |
| `distributes_over_union` | `{x: {a:string}\|{b:number}}` 得到 `'x' \| 'x.a' \| 'x.b'` |
| `array_depth` | `{list: {v:number}[]}` 支持 `'list.0.v'` 与 `get(obj,'list.0.v')` 返回 `number` |
| 边界：循环引用 | `type Node = {child?: Node}` 必须能编译通过（终止于深度 6）且 instantiation count 不超阈值 |
| 边界：`never` 字段 | `{x: never}` 不使整体 `Path` 变 `never`（考 `[T] extends [never]` 分支） |

---

### 题面草稿 3（`rubric`，`judgeKind: llm-rubric`，maxScore 10）
> 给你一个 60 万行的存量 monorepo（TS 5.9，`strict: false`，大量 `as any`，CI 有快照测试依赖 tsc 诊断顺序）。要求给出升级到 6.0 默认值 + 为 7.0 做准备的方案，含：分阶段 flag 打开顺序、每阶段的"回滚开关"、如何避免 `types: []` 造成的运行时全局类型丢失、快照失效处理、以及"如何让 `as any` 不再新增"的工程护栏。

**points**：阶段划分与可度量出口 3｜6.0 移除/默认项的具体影响面（`types:[]`、`outFile`、`baseUrl`、`moduleResolution`）3｜诊断顺序/快照稳定性手段（`--stableTypeOrdering`、按文件分组断言）2｜护栏（lint 规则、`isolatedDeclarations`、owner 审批）2。
**bonus**：指出 7.0 无 API 导致 typecheck 工具滞后的排期风险；提出用 `--generateTrace` 定位热点类型；区分"类型正确性"与"运行时安全"必须有边界校验。
**gaps**：一步全量开 strict；用 `skipLibCheck` 掩盖问题；认为 `strict: true` 覆盖索引访问；把 `@ts-ignore` 当过渡方案（应为 `@ts-expect-error` + 到期注释）。

---

## 5. 对标 JD 能力项
| 内容 | JD 码 |
| --- | --- |
| 判别式建模、穷尽性、边界运行时校验 | `APL-WEB-1` |
| 严格 flag 迁移与 6.0/7.0 影响面判断 | `APL-WEB-1`、`APL-WEB-5` |
| 泛型/条件类型与类型层性能度量 | `APL-WEB-1`、`APL-BE-1` |
| `tsc` + `vitest typecheck` 的可判分测试设计 | `APL-WEB-5` |
