# 【阿里巴巴 / 蚂蚁】前端与开源栈：微前端沙箱与样式作用域、请求竞态与轮询、表单字段生命周期

来源公司：**阿里巴巴 / 蚂蚁集团开源栈（qiankun、ahooks、Ant Design）**｜岗位方向：Senior/Staff Frontend（微前端基座 / 中台表单与数据层 / 组件库与工程化）、"前端架构 + 业务"复合型
对应考点：`alibaba-css-scope-rewrite`、`alibaba-sandbox-mode-degradation`、`alibaba-window-document-boundary`、`alibaba-microapp-lifecycle-contract`、`alibaba-active-rule-matching`、`alibaba-prefetch-strategy`、`alibaba-overlay-container-isolation`、`alibaba-userequest-race-cancel`、`alibaba-userequest-polling`、`alibaba-userequest-timing-controls`、`alibaba-userequest-cache-swr`、`alibaba-form-field-lifecycle`

> **证据分级（本文全文使用）**
> - **【源】**＝本次真正抓取到的公开来源里就是这么写的（§8 逐条给 URL＋标题＋访问日期＋它支撑了哪几条考点）。抓取方式：**curl 取原始 HTML / 仓库原文**（本 session 的 `WebFetch` 被服务端限流，全部改为直接抓取，见 §7 第 12 条）。
> - **【推】**＝来源未直接说、但可由来源事实外推的结论。**不要把【推】当引用背**。
> - **只写开源库，不写内部系统**：Fusion 内部版、内部埋点、内部低代码平台、淘宝/支付宝线上页面的真实配置一律不写（§7）。
> - **题面里不许出现具体量级数字**：包体积、QPS、首屏毫秒数、"比 iframe 快 N 倍"这类都没有可核查出处（§7 第 9 条）。
> - **版本锚点**：qiankun 取 **npm `latest` = 2.10.16**（与 `qiankun.umijs.org/zh/api` 文档描述一致；源码按 tag `v2.10.16` 抓取）【源 F28】；ahooks 取 npm `latest` = **3.10.0**，文档按 `alibaba/hooks@master` 的 markdown 原文抓取【源 F28】；Ant Design 文档站当前描述 6.x（npm `latest` = **6.6.5**）【源 F26/F28】。**出题时把这些版本写进题面**，否则"默认值变了"会变成判分事故。
>
> **一句话抓住这套栈**：阿里/蚂蚁的前端开源**不是组件库选型题，而是"多套代码共享同一个 `window` 与同一个 `document`"的题**——qiankun 用 Proxy/diff 把 `window` 虚拟出来、用选择器改写把 CSS 圈起来，ahooks 用调用计数器把"过期响应"丢掉，antd Form 用 name 把值的所有权从组件收走。四件事的共同点是：**副作用（全局变量、样式、事件监听、请求回调、字段值）必须可归还**。所以面试里最硬的回答永远是"**谁持有这个副作用、什么时候归还、归还失败了怎么发现**"。
>
> **和两份既有阿里素材的关系**：`alibaba-transactions-and-middleware.md` §7 第 7 条与 `alibaba-data-and-storage.md` §7 第 6 条说的"阿里前端无可核查材料、故不开 `react-vitest`"，指的是**那两条技术线**（交易治理、数据栈）里没有前端机制；本文补的就是这块空白——**所有考点都能落到"确定输入 → 确定输出"**，可直接支撑 `react-vitest` 出题（§6）。

---

## 1. 核心机制（面试里必须能画出来、并且能写成用例）

### 1.1 一次子应用切换的时序（qiankun 2.x，含沙箱与样式的介入点）
```
主应用 registerMicroApps([{name, entry, container, activeRule, loader, props}])
  → start({prefetch=true, singular=true, sandbox=true, ...opts})      ← 默认值就是源码里这一行【源 F6】
  → url 变化 → 逐个跑 activeRule（字符串＝对 pathname 做前缀匹配；函数/数组任一 true 即激活）【源 F1】
      → （singular 模式）等上一个应用 unmount 完才开始 load 这一个【源 F5/F6】
  → 建沙箱：window.Proxy 存在 ? (loose ? LegacySandbox : ProxySandbox) : SnapshotSandbox【源 F5】
  → 拉 entry：import-html-entry 用 fetch 取 HTML/JS/CSS（跨域必须，qiankun 自己不看超时）【源 F2】
  → 建 wrapper：<div id="__qiankun_microapp_wrapper_for_<snakeCase(name)>__" data-name data-version data-sandbox-cfg>【源 F8】
        strictStyleIsolation → attachShadow({mode:'open'}) 把内容塞进 shadowRoot【源 F7】
        experimentalStyleIsolation → 给 wrapper 打 data-qiankun="<appInstanceId>"，逐个 <style> 改写选择器【源 F4/F7】
  → 注入运行时 publicPath（在 bootstrap 之前）→ 子应用 __webpack_public_path__ = window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__【源 F2】
  → 校验导出：bootstrap / mount / unmount 三个都必须是 function，否则报
      "You need to export the functional lifecycles in xxx entry"【源 F2/F8】
  → bootstrap（一个实例只跑一次）→ mount(props) → render 沙箱 active + patchAtMounting
  → 切走：unmount → 收集"副作用重建器"rebuilders → sandbox.inactive()
  → 再切回来：sandbox.active() → 先 rebuild bootstrapping 期副作用，再 patchAtMounting，再 rebuild mounting 期
  → 预加载（另计时线）：prefetch 开启后按策略在 requestIdleCallback 里取静态资源【源 F9】
```
关键机制点（每条都有证据等级）：
1. **两类沙箱，不是一类**【源 F5】：源码注释原文——"app 环境沙箱是指应用初始化过之后，应用会在什么样的上下文环境运行。**每个应用的环境沙箱只会初始化一次，因为子应用只会触发一次 bootstrap**。子应用在切换时，实际上切换的是 app 环境沙箱"；"**render 沙箱**……每次子应用切换过后，render 沙箱都会重现初始化"；"这么设计的目的是为了保证每个子应用切换回来之后，**还能运行在应用 bootstrap 之后的环境下**"。→ 这一条同时回答两个高频追问："为什么二进制的模块级副作用不会重跑"（bootstrap 只一次【源 F5】）与"为什么 remount 后 window 上的东西还在"（环境沙箱不重建【源 F5】）。
2. **样式隔离的三档语义差别极大**【源】：`sandbox: true`（默认）"可以确保单实例场景子应用之间的样式隔离，但是无法确保主应用跟子应用、或者多实例场景的子应用样式隔离"【源 F1】；`strictStyleIsolation: true` 为容器"包裹上一个 shadow dom 节点"【源 F1】，但**浏览器不支持 shadow dom 时它只是 console.warn 后忽略**（"[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!"）【源 F7】，且开发期会警告"strictStyleIsolation configuration **will be removed in 3.0**, pls don't depend on it or use experimentalStyleIsolation instead"【源 F7】；`experimentalStyleIsolation: true` 走运行时 scoped css（§1.2）。而 `sandbox: false`（legacy render）下开任一档样式隔离都会**直接抛错**：`strictStyleIsolation can not be used with legacy render!` / `experimentalStyleIsolation can not be used with legacy render!`【源 F7】。→ **"静默降级"和"硬失败"混在同一套 API 里**，是这套栈最真实的坑【推】。
3. **子应用的 `window` 是代理对象，`document` 基本不是**【源】：Proxy 沙箱 `get` 的查找顺序是 `const actualTarget = propertiesWithGetter.has(p) ? globalContext : p in target ? target : globalContext;`【源 F10】，官方 FAQ 的说法是"在微应用中访问 `window.Vue` 时，**会先在自己的 window 里查找**有没有 Vue 属性，**如果没有就去父应用里查找**"【源 F2】；`window`/`self`/`globalThis` 都被改回代理对象本身以"avoid who using window.window or window.self to **escape the sandbox**"【源 F10】。反面：`SnapshotSandbox.patchDocument(): void {}` 是**空实现**【源 F11】，且它的 `proxy = window`（就是真 window）【源 F11】——所以"降级到快照沙箱"时全局写冲突是**物理存在**的。
4. **沙箱卸载后的写入是被静默丢弃，不是报错**【源】：Proxy 沙箱 `set` 在 `sandboxRunning === false` 时只打开发期 warn（"[qiankun] Set window.${p} while sandbox destroyed or inactive in ${name}!"）并 `return true`，注释原文："在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，**在沙箱卸载的情况下应该忽略错误**"【源 F10】。→ 面试追问"子应用 unmount 后还有个异步回调去写 `window.xxx`，你怎么发现"：答案是**发现不了**，只能靠"归还副作用"的机制（见考点 4）【推】。

### 1.2 运行时 scoped CSS 的改写规则（可当成纯函数来考）
`experimentalStyleIsolation` 的实现是 `src/sandbox/patchers/css.ts` 里的 `ScopedCSS`，作用范围与例外都是写死的【源 F4】：
```
只改写 STYLE(1) / MEDIA(4) / SUPPORTS(12) 三类规则；
其余（源码里注释"// type: value will be kept"）：IMPORT(3) / FONT_FACE(5) / PAGE(6) / KEYFRAMES(7) / KEYFRAME(8)
  → 走 default 分支，原样输出 rule.cssText
前缀 prefix = `${wrapperTagName.toLowerCase()}[data-qiankun="${appInstanceId}"]`（源码里的 QiankunCSSRewriteAttr = 'data-qiankun'）
只对 <style> 生效；stylesheetElement.tagName === 'LINK' → console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.')
同一个 style 节点只改写一次（ScopedCSS.ModifiedTag 命中即 return）→ 幂等
```
| 输入（子应用里的规则） | 输出（改写后） | 依据 |
|---|---|---|
| `.app-main { font-size: 14px }` | `div[data-qiankun="react16"] .app-main { font-size:14px }` | 【源 F4】分组/普通选择器分支 `return \`${p}${prefix} ${s.replace(/^ */, '')}\``；文档示例（写作 `div[data-qiankun-react16].app-main`，见下方警告）【源 F1】 |
| `html { }` / `body { }` / `:root { }` | 选择器**被替换成 prefix**（`cssText.replace(rootSelectorRE, prefix)`），即"根样式落到容器上" | 【源 F4】`if (selector === 'html' || selector === 'body' || selector === ':root')` |
| `html body { }` / `html > body { }` | 先**剥掉 `html...` 前缀**（`rootCombinationRE` 替换为 `''`），再按普通规则加前缀 | 【源 F4】"handle html body { ... } / handle html > body { ... }" |
| `html + body { }` / `html ~ body { }` | **不剥前缀**（注释："since html + body is a non-standard rule for html **transformer will ignore it**"） | 【源 F4】`siblingSelectorRE` |
| `div, body, span { }` | 组内每个选择器分别处理：非根选择器加前缀，根选择器换成 prefix；`whitePrevChars = [',', '(']` 保证 `body,html` 与 `*:not(:root)` 不吃掉前一个字符 | 【源 F4】 |
| `@media screen and (max-width: 300px) { .a{} }` | 条件原样保留、**内部规则递归改写**：`@media ${rule.conditionText} {…}` | 【源 F4】`ruleMedia` |
| `@supports (display: grid) { .a{} }` | 同上（`@supports ${conditionText \|\| cssText.split('{')[0]}`） | 【源 F4】`ruleSupport` |
| `@font-face { }` / `@keyframes { }` / `@import …` / `@page { }` | **原样输出**（不被限定作用域）→ 全局字体名、动画名、分页规则会互相污染 | 【源 F1/F4】 |

> **必须知道的出处冲突（出题时避开这个雷）**：API 文档页的示例写的是属性名形式 `div[data-qiankun-react16]`【源 F1】，而 v2.10.16 源码生成的是 `data-qiankun="react16"` 的**属性等值**形式【源 F4/F7】，且属性值取的是 **`appInstanceId`**（`genAppInstanceIdByName(appName)`：首次等于 appName，同名的后续实例依次变成 `react16_1`、`react16_2`）【源 F8】。**两者不一致**。判分用例不要断言"字符串等于某一种写法"，要么按源码规则自己实现改写器（输入 CSS 文本 → 输出 CSS 文本，规则见上表），要么只断言"是否被限定在容器内 / `@font-face` 是否未被改写"这类语义。

### 1.3 `useRequest` 的一次调用：计数裁决 + 插件改写（竞态在这里发生）
```
run/runAsync(params) → count += 1，记 currentCount = count
  → 插件 onBefore 可返回 { stopNow | returnNow | 部分 state }（缓存命中新鲜 → returnNow，直接 resolve 缓存数据）【源 F20/F22/F23】
  → 插件 onRequest 可替换 servicePromise（相同 cacheKey 共享同一个 Promise）【源 F23】
  → await service
  → if (currentCount !== this.count) throw new CancelledError()   ← 竞态裁决：后发先至时，先发的那条不写 data、不触发 onSuccess/onError【源 F20】
  → setState({data, error: undefined, loading: false}) → options.onSuccess → 插件 onSuccess → options.onFinally →（仅当 currentCount === count）插件 onFinally
```
可核查的语义（全部【源】）：
- 官方文档对竞态的表述："竞态取消，当上一次 promise 还没返回时，又发起了下一次 promise，则会**忽略上一次 promise 的响应**"；"被忽略的请求**不会更新 `data`/`error`，也不会触发 `onSuccess`/`onError`/`onFinally`**"；"对于 `run` 和 `refresh` 来说到此为止：它们**不会报告任何东西**"；"对于 `runAsync` 和 `refreshAsync`，其 promise 会**以 `CancelledError` reject**"；"注意：被忽略的请求，其结果会被丢弃。**即使它自身的 promise 是以 service 错误 reject 的，被覆盖的调用也只会以 `CancelledError` reject**"【源 F13】。
- 识别方式：`import { isCancelledError } from 'ahooks'`；源码里 `CancelledError` 的默认 message 是 `'useRequest: the request was cancelled or superseded.'`、`this.name = 'CancelledError'`，并用 `__AHOOKS_CANCELLED_ERROR__` 标记位兜住"模块被复制成两份时 `instanceof` 失效"【源 F21】。类注释原文："It is **swallowed by `run`/`refresh`, by `options.onError` and by the plugin `onError` handlers**, so it only surfaces to code that awaits `runAsync`/`refreshAsync` directly."【源 F21】
- `cancel()` 的边界："`useRequest` 提供了 `cancel` 函数，用于**忽略**当前 promise 返回的数据和错误……**注意：调用 `cancel` 函数并不会取消 promise 的执行**"；自动忽略的另一个时机是"组件卸载时，正在进行的 promise"【源 F13】。→ 所以"切页面就不请求了"这句面试常说的话，在这套栈里是**错的**：请求照发，只是结果不被采用【推】。
- 轮询不是 setInterval，而是"完成后再等"："轮询原理是在每次请求完成后，等待 `pollingInterval` 时间，发起下一次请求"【源 F14】；源码 `onFinally` 里 `setTimeout(..., pollingInterval)`，且**只有** `pollingErrorRetryCount === -1 || countRef.current <= pollingErrorRetryCount` 才续期，否则把计数清零收尾（停止轮询）；`pollingWhenHidden === false && !isDocumentVisible()` 时改为 `subscribeReVisible(() => fetchInstance.refresh())`【源 F14/F24】。
- 缓存的"新鲜/过期"两种返回值（源码注释原文）："If the data is **fresh**, stop request" → 返回 `{loading:false, data, error: undefined, returnNow: true}`；"If the data is **stale**, return data, and request continue" → 只返回 `{data, error: undefined}`（即**先渲染旧数据再后台刷新**，SWR）【源 F23】。

### 1.4 一个表单字段的"值生命周期"（antd Form：谁拥有这个值）
```
Form initialValues（最高优先级） > Form.Item initialValue（次之；多个同 name 的 Item 都设 initialValue 时不生效） > 组件内 defaultValue（设了 name 后不生效）
挂载 <Form.Item name>  → 子控件被注入 value/onChange（或 valuePropName/trigger 指定的属性名），"数据同步将被 Form 接管"
用户输入              → trigger（默认 onChange）收集 → normalize / getValueFromEvent 转换 → 写入 store → validateTrigger（默认 onChange）校验
字段卸载/被删除        → preserve（默认 true）保留值；要拿回来只能 getFieldsValue(true)
字段隐藏              → hidden: true "依然会收集和校验字段"
```
- 官方优先级原文【源 F26】："**Form 的 `initialValues` 拥有最高优先级**""**Field 的 `initialValue` 次之** *. 多个同 `name` Item 都设置 `initialValue` 时，则 Item 的 `initialValue` 不生效"；`Form.Item.initialValue` 那行写"设置子元素默认值，**如果与 Form 的 `initialValues` 冲突则以 Form 为准**"。
- 受控化的连带后果【源 F26】："当你为 `Form.Item` 设置 `name` 属性后，子组件会**转为受控模式**。因而 `defaultValue` **不会生效**"；"你**不能**用控件的 `value` 或 `defaultValue` 等属性来设置表单域的值……注意 `initialValues` **不能被 setState 动态更新**，你需要用 `setFieldsValue` 来更新"。
- 删除与残留【源 F26】：`Form`/`Form.Item` 的 `preserve` 默认 **`true`**，说明文字是"当字段被删除时保留字段值"，并且"你可以通过 **`getFieldsValue(true)`** 来获取保留字段值"；与之相对，`clearOnDestroy` 默认 **`false`**（"当表单被卸载时清空表单值"）。
- 与"值的所有权"同构的另一半是 ahooks `useControllableValue`：`defaultValue` 说明"默认值，**会被 `props.defaultValue` 和 `props.value` 覆盖**"，`valuePropName` 默认 `value`、`trigger` 默认 `onChange`、`defaultValuePropName` 默认 `defaultValue`【源 F25】。
- 布局属性方向相反，是刻意设计的对照：`labelCol`/`wrapperCol`"当和 Form 同时设置时，**以 Item 为准**"【源 F26】——同一个 Form 里"值以 Form 为准、样式以 Item 为准"，说不清原因就是没读过文档【推】。

---

## 2. 分考点清单（12 条）

> **judgeKind 约定**：本仓库 react-vitest 题的现有形态是 `runner.entry = "function"` + 一个 `.test.ts`（见 `content/questions/frontend/fe-react-0018.json`、`fe-react-0020.json` 的 runner 结构），所以本文优先把考点写成**纯函数/决策函数**，需要 DOM 的（样式改写、弹层落点）在 §6 里单独标"组件级"。判题容器是否装了 `@testing-library/react` + `jsdom` **本文未核验**（只在 `web/package.json` 看到这两个依赖），出题前先确认。
> 每条：考点名（`tag`）｜senior 深度要点｜可出题形式｜建议 judgeKind｜锚点

1. **运行时样式作用域改写器**（`alibaba-css-scope-rewrite`）
   要点：`ScopedCSS.rewrite()` 只处理 STYLE/MEDIA/SUPPORTS，其余按 `rule.cssText` 原样保留；根选择器（`html`/`body`/`:root`）是**替换**而不是加前缀；`html body`/`html > body` 先剥 `html` 前缀，`html + body`/`html ~ body` 明确"transformer will ignore"；组选择器逐个加前缀且 `whitePrevChars = [',','(']` 保护 `body,html`、`*:not(:root)`；`@media/@supports` 条件用 `conditionText` 保留并递归内部规则；`@font-face/@keyframes/@import/@page` **不被限定作用域**（字体名与动画名仍会全局冲突）；只处理 `<style>`，`LINK` 只 warn；`ModifiedTag` 保证同一节点**幂等**。
   出题：code（组件级/纯函数级：输入 CSS 文本 + prefix，输出改写后文本，断言上述 5 类规则）；rubric（"为什么 scoped css 挡不住 `@font-face` 与 `@keyframes` 冲突，你怎么办"）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F4】【源 F1】＋【推（污染面与治理建议）】。
2. **隔离模式的选择矩阵与静默降级**（`alibaba-sandbox-mode-degradation`）
   要点：`window.Proxy` 决定 ProxySandbox / SnapshotSandbox；`sandbox.loose` 决定 LegacySandbox（源码 `useLooseSandbox ? new LegacySandbox(...) : new ProxySandbox(...)`）；无 Proxy 时 qiankun 自己降级并 warn "Missing window.Proxy, proxySandbox will degenerate into **snapshotSandbox**"、把 sandbox 改写成 `{loose:true}`，若此时 `singular === false` 再 warn 一次；FAQ 侧对应"IE 环境下（不支持 Proxy 的浏览器）只能使用单实例模式，qiankun 会自动将 `singular` 配置为 `true`"（**这句是 FAQ 原文，但 v2.10.16 源码只警告不改写 `singular`，两处不一致，见 §6 表末尾的说明——别把它当判分事实**）；不支持 const 解构赋值时把 `speedy` 关掉；`strictStyleIsolation` 在无 shadow dom 时**忽略**、在 legacy render 下**抛错**；`singular` 在 `start` 默认 `true`、在 `loadMicroApp` 默认 `false`。
   出题：code（纯函数 `resolveSandbox({hasProxy, hasConstDestructure, sandboxCfg, singular, supportShadowDOM, legacyRender})` → `{sandboxType, singular, scopedCss, warnings[], thrown[]}`，断言"降级/忽略/抛错"三种不同出口）；rubric（为什么"样式隔离"不是开关而是三档语义）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F5】【源 F6】【源 F7】【源 F1】【源 F2】。
3. **`window` 代理与 `document` 的隔离边界**（`alibaba-window-document-boundary`）
   要点：get 查找顺序"先自己的 window，查不到再到父应用"（源码 `p in target ? target : globalContext`）；`window/self/globalThis` 指回 proxy（防 `window.window` 逃逸）；`top/parent` 在主应用本身处于 iframe 时**放行到真实窗口**；`document` 返回沙箱自己的 `this.document`（可被 `patchDocument` 替换）；`globalVariableWhiteList` 里的键会**同步写回真实 globalContext**（并保存原描述符）；set 在沙箱 inactive 后静默丢弃；SnapshotSandbox `proxy = window` 且 `patchDocument(){}` 空实现 + `inactive()` 用 diff 还原并把变更存进 `modifyPropsMap`（注释："基于 diff 方式实现的沙箱，用于不支持 Proxy 的低版本浏览器"）。
   出题：rubric（"哪些副作用沙箱管不了、你用什么机制归还"）；code（`getFromFakeWindow(target, globalContext, key)` 纯函数断言查找顺序与白名单写回）。
   judgeKind：`llm-rubric` ＋ `react-vitest`。
   锚点：【源 F10】【源 F11】【源 F2】＋【推（归还机制）】。
4. **生命周期契约、实例标识与副作用归还**（`alibaba-microapp-lifecycle-contract`）
   要点：`validateExportLifecycle` 要求 `bootstrap`/`mount`/`unmount` **三者都是 function**（`isFunction(bootstrap) && isFunction(mount) && isFunction(unmount)`），否则报 "You need to export the functional lifecycles in xxx entry"；`appInstanceId = genAppInstanceIdByName(appName)`：同名第一次等于 `appName`，之后依次 `appName_1`、`appName_2`（计数器自增后再拼接）；wrapper id 为 `__qiankun_microapp_wrapper_for_${snakeCase(name)}__`；环境沙箱只初始化一次（bootstrap 只一次）、render 沙箱每次 mount 重建；`mount()` 内注释"因为有上下文依赖（window），以下代码执行顺序不能变"，顺序＝`sandbox.active()` → 重建 bootstrapping 期副作用 → `patchAtMounting` → 重建 mounting 期副作用 → 清空 rebuilders；`unmount()`＝`[...bootstrappingFreers, ...mountingFreers].map(f => f())` 收集 rebuilders 后 `sandbox.inactive()`；`mountingFreers` 注释"are one-off and should be re-init at every mounting time"；loader 里还留着 FIXME："should use a strict sandbox logic while remount, see issues/518"。
   出题：code（`genAppInstanceId(['a','a','b','a']) → ['a','a_1','b','a_2']` 纯函数；或 `runSequence(mount/unmount×N)` 断言 bootstrap 只一次、rebuild 次序）；rubric（"unmount 你归还了什么？漏归还的表征与检测"）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F8】【源 F5】【源 F7】【源 F2】＋【推（检测手段）】。
5. **`activeRule` 的判定语义与主应用路由的耦合**（`alibaba-active-rule-matching`）
   要点：字符串＝"直接跟 url 中的**路径部分做前缀匹配**"；函数收 `location`，返回 true 即激活；数组＝"任意一个返回 true 时表明该微应用需要被激活"；官方规则示例可整表搬进题面（`/app1`、`/users/:userId/profile`、`/pathname/#/hash`、`['/pathname/#/hash','/app1']` 四组 ✅/🚫，其中 `https://app.com/pathname#/hash/route/nested`（少一个斜杠）与 `https://app.com/users//profile/...` 都是 🚫）；主应用路由页面里挂子应用时"微应用的 `activeRule` 需要包含主应用的这个路由 path"，vue 主应用还要给 path 加 `*`；`singular:false` + 两个相同 activeRule 会同时 mount，而"页面上不能同时显示多个依赖于路由的微应用，因为浏览器只有一个 url……**必定会导致其中一个 404**"；路由 base 要等于 activeRule（"微应用建议使用 history 模式的路由，需要设置路由 base，**值和它的 activeRule 是一样的**"）。
   出题：code（纯函数 `isActive(rule, url)`，用官方 ✅/🚫 表当用例——判分事实最干净的一条）；rubric（基座路由与子应用路由的双写、刷新 404、微应用间跳转为什么不能用子应用 Link）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F1】【源 F2】【源 F3】。
6. **预加载策略与网络闸门**（`alibaba-prefetch-strategy`）
   要点：`start` 的默认值一行写死 `{ prefetch: true, singular: true, sandbox: true, ...opts }`；`true` → 监听 `single-spa:first-mount` 后对**状态仍为 `NOT_LOADED`** 的应用预取（监听是一次性的，回调里 `removeEventListener`）；`'all'` → `start` 后立即预取；`string[]` → 首个 mount 后只预取数组内的；函数 → `{criticalAppNames, minorAppsName}`，critical 立即、minor 等 first-mount；`false` 走 default 分支什么都不做；预取本身 `if (!navigator.onLine || isSlowNetwork) return`（`isSlowNetwork = saveData || (type !== 'wifi' && type !== 'ethernet' && /([23]g/.test(effectiveType))`）；实际执行排在 `requestIdleCallback` 里，无 RIC 时用 `MessageChannel` 兜（注释："it does not have the 4ms delay of setTimeout"），再兜 `setTimeout(idleCall, 0)`，伪造的 `timeRemaining()` 是 `Math.max(0, 50 - (Date.now() - start))`；预取内容是 `getExternalStyleSheets` + `getExternalScripts`。**没有加载超时参数**（§7 第 5 条）。
   出题：code（`planPrefetch({prefetch, apps, appStatus, online, saveData, connectionType, effectiveType, now, startedAt})` → `{targets[], phase:'immediate'|'afterFirstMount'|'none', skipped: reason}`）；rubric（首屏带宽预算与"预取了但用不上"的判据）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F9】【源 F6】【源 F1】。
7. **浮层落点与主题继承（样式隔离的第二现场）**（`alibaba-overlay-container-isolation`）
   要点：`Modal.getContainer` 默认 **`document.body`**（"指定 Modal 挂载的节点，但依旧为全屏展示，`false` 为挂载在当前位置"）；`ConfigProvider.getPopupContainer` 默认 **`() => document.body`**（"弹出框（Select, Tooltip, Menu 等等）渲染父节点，默认渲染到 body 上"），类型允许返回 `ShadowRoot`；`message.info`/`notification.open`/`Modal.confirm` 的官方 FAQ 原文："**静态方法是使用 ReactDOM.render 重新渲染一个 React 根节点上，和主应用的 React 节点是脱离的**。我们建议使用 `useMessage`、`useNotification` 和 `useModal` 来使用相关方法。原先的静态方法在 5.0 中**已被废弃**"；`prefixCls` 优先级"（前者被后者覆盖）"三级：`ConfigProvider.config({prefixCls:'prefix-1'})` < `ConfigProvider.config({holderRender: children => <ConfigProvider prefixCls="prefix-2">…})` < `message.config({prefixCls:'prefix-3'})`；qiankun 侧对应建议是给主应用样式加前缀（less `modifyVars: {'@ant-prefix': 'yourPrefix'}` + `ConfigProvider prefixCls`），并在 FAQ 里点名"基于 ShadowDOM 的严格样式隔离并不是一个可以无脑使用的方案，大部分情况下都需要接入应用做一些适配"。
   出题：code（组件级：渲染一个把弹层容器指到子应用容器内的组件，断言 `document.body` 下不出现该弹层节点；或纯函数 `resolveOverlayTarget({getContainer, getPopupContainer, shadowRootAvailable})`）；rubric（三种隔离档位下浮层/字体/动画分别漏在哪、怎么补）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F27】【源 F28】【源 F1】【源 F2】＋【推（组合治理方案）】。
8. **请求竞态与"被忽略的响应"**（`alibaba-userequest-race-cancel`）
   要点：`count/currentCount` 的裁决式（`if (currentCount !== this.count) throw new CancelledError()` 位于 `setState` **之前**，所以旧请求连 `loading:false` 都不会写）；被忽略请求不触发 `onSuccess/onError/onFinally`（插件的 `onFinally` 还要再过一次 `currentCount === this.count` 门）；`run`/`refresh` 吞掉 `CancelledError`、`runAsync`/`refreshAsync` 抛给调用方；即使被覆盖的那次调用**自身是失败**的，也只会以 `CancelledError` reject；`cancel()` 只忽略结果不中止 promise；组件卸载时自动忽略；`stopNow`/`returnNow` 两个提前返回口子（`return Promise.resolve(state.data)`）。
   出题：code（用假 timer 起两条请求，断言最终 `data`、各回调调用次数、`runAsync` 的 reject 类型；含"慢的先失败、快的后成功"这条反向用例）；rubric（什么场景**不该**丢弃过期响应，比如分页与增量列表要合并而不是覆盖）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F13】【源 F20】【源 F21】。
9. **轮询的四个可判分点**（`alibaba-userequest-polling`）
   要点：`pollingInterval` 默认 `0`、"> 0 则处于轮询模式"、原理是"每次请求**完成后**再等 interval"（不是 setInterval，慢请求会自动串行化）；`pollingWhenHidden` 默认 `true`，为 false 时"页面隐藏时会暂时停止轮询，页面重新显示时**继续上次轮询**"（实现是 `subscribeReVisible(() => fetchInstance.refresh())`）；`pollingErrorRetryCount` 默认 **`-1`（无限次）**，计数规则 `onError` +1、`onSuccess` 归零、`countRef.current <= pollingErrorRetryCount` 才续期；三条备注——`pollingInterval`/`pollingWhenHidden` 支持动态变化、`manual:true` 时初始化不启动轮询、`pollingInterval` 由 0 变正**不会**自动启动，必须 `run/runAsync`。
   出题：code（`pollNext({pollingErrorRetryCount, consecutiveErrors, hidden, pollingWhenHidden, interval}) → 'schedule'|'pause-until-visible'|'stop'` 纯函数 + 一个假 timer 的组件用例）；rubric（任务状态轮询的退避与"页面隐藏仍打服务端"的成本）。
   judgeKind：`react-vitest` ＋ `llm-rubric`。
   锚点：【源 F14】【源 F24】。
10. **时间类开关：loadingDelay / 防抖 / 节流 / 聚焦重取 / 错误重试**（`alibaba-userequest-timing-controls`）
    要点：`loadingDelay` 默认 `0`，语义是"延迟 `loading` 变成 `true` 的时间，有效防止闪烁"（"假如 `getUsername` 在 300ms 内返回，则 loading 不会变成 true"），源码 `onBefore` 先 `return {loading:false}` 再挂 timer 置 true，且**只在 `ready !== false` 时挂 timer**；`debounceWait/debounceLeading/debounceTrailing/debounceMaxWait` 默认 `- / false / true / -`（"所有参数用法和效果同 lodash.debounce"，"频繁触发 run，只会在最后一次触发结束后等待 300ms 执行"）；`throttleWait/throttleLeading/throttleTrailing` 默认 `- / true / true`（"只会每隔 300ms 执行一次"）；两者共同备注："`runAsync` 在真正执行时，会返回 `Promise`。在**未被执行时，不会有任何返回**"、"`cancel` 可以中止正在等待执行的函数"；`refreshOnWindowFocus` 默认 `false` + `focusTimespan` 默认 `5000`（"如果和上一次请求间隔大于 5000ms，则会重新请求一次"，监听 `visibilitychange` 与 `focus`）；`retryCount`（`-1` 无限）与 `retryInterval`——不设则"取 `1000 * 2 ** retryCount`，也就是第一次重试等待 2s，第二次重试等待 4s，以此类推，**如果大于 30s，则取 30s**"。
    出题：code（给定一条 260ms 完成的请求与 `loadingDelay:300`，断言 `Loading...` 从未出现；再给定 900ms 完成的，断言 300ms 时出现、900ms 时消失；以及 `nextRetryDelay(retryCount)` 与 30s 封顶）；rubric（防抖 vs 节流 vs 竞态丢弃在"搜索联想"里各自解决什么）。
    judgeKind：`react-vitest` ＋ `llm-rubric`。
    锚点：【源 F15】【源 F16】【源 F17】【源 F18】【源 F19】＋【推（组合语义）】。
11. **`cacheKey` / SWR / 参数缓存 / 自定义缓存**（`alibaba-userequest-cache-swr`）
    要点：`cacheTime` 默认 `300000`（5 分钟），`-1` 永不过期（源码 `if (cacheTime > -1) setTimeout(() => cache.delete(key), cacheTime)`）；`staleTime` 默认 `0`，`-1` 永远新鲜；新鲜 → `returnNow` 直接返回缓存并 `loading:false`；过期 → 先给缓存数据、请求继续（SWR）；缓存内容包含 `data` **和 `params`**（"通过 `params` 缓存机制，我们可以记忆上一次请求的条件"）；`interface CachedData<TData, TParams> { data; params; time }`；数据共享：相同 `cacheKey` 同时只有一个 `Promise` 在飞（`getCachePromise`/`setCachePromise`，且 `servicePromise !== currentPromiseRef.current` 才复用）+ `subscribe/trigger` 同步数据；两条硬备注："**只有成功的请求数据才会缓存**"、"如果没有发起新请求，不会触发数据共享。`cacheTime`、`staleTime` 参数会使数据共享失效（#2313）"；`setCache`/`getCache` 需配套，"在自定义缓存模式下，`cacheTime` 和 `clearCache` **不会生效**"；`clearCache(cacheKey?)` 支持单个/数组、为空清空全部。
    出题：code（`resolveCacheAction({cacheData, staleTime, now}) → 'returnNow'|'show-then-refetch'|'no-cache'` + 一个"A 组件请求 → B 组件挂载只发一次请求"的组件用例）；rubric（列表页详情返回后的"陈旧但可见"取舍与失效策略）。
    judgeKind：`react-vitest` ＋ `llm-rubric`。
    锚点：【源 F22】【源 F23】【源 F12】。
12. **表单字段生命周期与取值优先级**（`alibaba-form-field-lifecycle`）
    要点：默认值三级优先（`Form.initialValues` > `Item.initialValue`；**多个同 name 的 Item 都设 initialValue 时 Item 不生效**；组件 `defaultValue` 在有 name 时不生效）；受控化注入的是 `value`/`onChange`，可分别被 `valuePropName`（默认 `value`，"Switch、Checkbox 的 valuePropName 应该是 `checked`，否则无法获取这个两个组件的值。该属性为 `getValueProps` 的封装，自定义 getValueProps 后会失效"）与 `trigger`（默认 `onChange`）改名；校验时机 `validateTrigger` 默认 `onChange`（Form 上可统一设置），单条规则上的 `Rule.validateTrigger`"**必须是 Form.Item 的 validateTrigger 的子集**"，另有 `validateDebounce`（5.9.0）、`validateFirst`（默认 false，`parallel: 4.5.0`）、`warningOnly`（"仅警告，不阻塞表单提交"）、`whitespace`（"只在 `type: 'string'` 时生效"）、`transform`（"将字段值转换成目标值后进行校验"）、`required`（"如不设置，则会根据校验规则自动生成"）；卸载语义 `preserve` 默认 true（配 `getFieldsValue(true)`）与 `clearOnDestroy` 默认 false；`hidden: true`"**依然会收集和校验字段**"；`noStyle`"当自身没有 validateStatus 而父元素存在有 validateStatus 的 Form.Item 会**继承父元素的 validateStatus**"；路径规则"当 `name` 为数组时，会按照顺序填充路径。**当存在数字且 form store 中没有该字段时会自动转变成数组**，因而如果需要数组为 key 时请使用 string 如 `['1','name']`"；`Form.List` 的 `operation`＝`add(defaultValue?, insertIndex?) / remove(index|index[]) / move(from,to)`，且"List 本身也是字段，因而 `getFieldsValue()` **默认会返回 List 下所有值**"、"Form.List 下的字段**不应该配置 initialValue**"；联动两条路——`dependencies`（"所依赖的字段更新时，该字段将自动触发更新与校验"，且"**不应和 `shouldUpdate` 一起使用**，因为这可能带来更新逻辑的混乱"）与 `shouldUpdate`（true＝任意变化都重渲染，函数版收 `(prevValues, curValues)`，且"Form.Item 里包裹的子组件必须由函数返回，否则 shouldUpdate 不会起作用"）；取值的时机约束"Form 仅会对变更的 Field 进行刷新……**你无法在 render 阶段通过 `form.getFieldsValue` 来实时获取字段值**"，要用 `Form.useWatch`（默认只监听已注册字段，`WatchOptions.preserve` 默认 false）；`resetFields` 会重置整个 Field 从而**重新 mount** 子组件；`Modal` 里 `useForm` 报 "is not connect to any Form element" 要给 Modal 设 `forceRender`；对照组：`useControllableValue` 的 `defaultValue`"会被 `props.defaultValue` 和 `props.value` 覆盖"。
    出题：code（组件级：给定 initialValues + Item initialValue 冲突、隐藏字段、删除一行列表三个场景，断言 `onValuesChange` 的 `changedValues/allValues` 与 `getFieldsValue()` / `getFieldsValue(true)` 的差集）；code（纯函数：`pickInitialValue(formInitial, itemInitial, componentDefault, duplicatedName)`）；rubric（"字段消失但值还在 store 里"的提交风险与校验绕过口子）。
    judgeKind：`react-vitest` ＋ `llm-rubric`。
    锚点：【源 F26】【源 F25】＋【推（提交前裁剪与风控）】。

---

## 3. 会被追问什么（前端基座向：一路问到"你怎么知道它泄漏了"）

1. "`experimentalStyleIsolation` 开着，为什么我子应用的图标字体还是把主应用改了？"（`@font-face` 不被改写，字体名是全局的【F1/F4】→ 要么改字体名前缀，要么走 CDN 绝对路径【F2】）
2. "`@keyframes` 同理？"（是，动画名全局冲突【F1/F4】）
3. "scoped css 对 `<link rel=stylesheet>` 进来的样式生效吗？"（不生效，只 warn"not support for link element yet"【F4】）
4. "同一个 style 节点被 append 两次会怎样？"（幂等：`ModifiedTag` 命中直接 return【F4】）
5. "`strictStyleIsolation` 在不支持 shadow dom 的环境是报错还是降级？"（warn + **忽略**【F7】；但和 `sandbox:false` 的 legacy render 同时用是**抛 QiankunError**【F7】）
6. "IE 上你的多实例方案还成立吗？"（无 Proxy → 降级 snapshotSandbox → 官方明说只能单实例、自动 `singular:true`【F2/F5/F6】）
7. "unmount 之后子应用往 `window` 上写东西会报错吗？"（不报错，静默丢弃，只有开发期 warn【F10】）
8. "那定时器/事件监听谁负责清？"（"尽量不要在应用初始化阶段有 事件监听/定时器 等副作用"＋ bootstrapping/mounting 两段 freers 在 unmount 时被收成 rebuilders、下次 mount 按序重建【F5】；FAQ 侧对应"子应用访问的 window 对象是被代理的，直接加事件处理函数无效，要用 `addEventListener`"【F2】）
9. "子应用为什么必须导出三个生命周期，只导 mount 行不行？"（不行，`validateExportLifecycle` 要求三者都是 function【F8/F2】；`loadMicroApp` 手动加载与 `registerMicroApps` 的差异、以及 `update` 钩子要额外导出【F1】）
10. "`loadMicroApp` 和 `registerMicroApps` 的 `singular` 默认值为什么不一样？"（`start` 默认 `true`、`loadMicroApp` 默认 `false`【F1】——手动加载本来就是组件内嵌多实例场景【推】）
11. "`prefetch: true` 和 `'all'` 什么时候差很多？"（前者等 first-mount 才发、后者 start 即发，且 `true` 只预取当时仍 `NOT_LOADED` 的应用【F9/F1】）
12. "弱网下还会预取吗？"（不会，`!navigator.onLine || saveData || (非 wifi/ethernet 且 2g/3g)` 直接 return【F9】）
13. "子应用刷新后 404 谁的锅？"（browser history 需要服务端 rewrite【F2】；base 要等于 activeRule【F3】）
14. "微应用之间跳转为什么不能直接用 `Link`？"（跳转基于路由 base，官方给的是 `history.pushState`/原生 a/location.href【F2】）
15. "两次 `run()` 谁的结果可见？慢的那条失败了会发生什么？"（后发胜出；先发那条只 reject `CancelledError`，业务错误被吞【F13/F20/F21】）
16. "轮询时页面切到后台还在打服务端吗？"（默认 `pollingWhenHidden: true` → 还在打；改 false 则隐藏时暂停、重新显示时 refresh【F14】）
17. "`pollingErrorRetryCount: 3` 是总共 3 次还是连续 3 次？"（源码是**连续错误计数**，`onSuccess` 归零【F24】）
18. "`cacheKey` 设了但页面还是闪了一下旧数据？"（那是 staleTime=0 的 SWR 设计行为：先返回缓存、后台重取【F22/F12】）
19. "为什么灰度期间两个组件用同一 `cacheKey` 却发了两次请求？"（数据共享只在真的发起请求时生效，`cacheTime`/`staleTime` 会让共享失效（#2313）【F12】）
20. "字段从表单里删了，提交时值还在不在？"（在，`preserve` 默认 true，且 `getFieldsValue()` 拿不到，要 `getFieldsValue(true)`【F26】——这就是"前端删了、后端收到"的经典事故【推】）
21. "隐藏字段会不会被校验？"（`hidden:true` 依然收集和校验【F26】）
22. "`Form.Item initialValue` 和 `Form initialValues` 打架听谁的？"（Form 最高优先级；多个同 name 的 Item 都设 initialValue 则都不生效【F26】）
23. "Modal 里的表单为什么控制台报 `useForm is not connect to any Form element`？"（Modal 未初始化，给 Modal 设 `forceRender`【F26】）
24. "子应用里 `message.error()` 样式没了/主题不对？"（静态方法另起 ReactDOM.render 根、脱离主应用 React 节点，5.0 起废弃，改用 `useMessage/useNotification/useModal`【F28】）

---

## 4. 常见错误答案（背题型信号）

| 错误 | 暴露点 |
|---|---|
| "qiankun 开了沙箱就完全隔离了" | 不知 snapshot/proxy/legacy 三档、不知 `document` 与动态样式/事件监听是另一套 patcher【F5/F10/F11】 |
| "`strictStyleIsolation` 更安全，全开就好" | 不知它无 shadow dom 时静默忽略、legacy render 下抛错、且源码明写 3.0 移除【F7】 |
| "scoped css 能隔离所有样式" | 答不出 `@font-face/@keyframes/@import/@page` 不被改写、LINK 样式表不处理【F1/F4】 |
| "子应用卸载后全局就干净了" | 不知 unmount 是"收成 rebuilders 等下次重建"，也不知 inactive 后写入被静默丢弃【F10/F5】 |
| "生命周期随便导一个也行" | `validateExportLifecycle` 要求三个都是 function，否则 entry 识别失败【F8/F2】 |
| "`loadMicroApp` 和路由加载没区别" | 两者 `singular` 默认值相反（true vs false）、`update` 要额外导出、config entry 直接渲染到 `props.container` 会覆盖样式表【F1/F2】 |
| "prefetch 就是提前发请求" | 不知 `true`/`'all'`/数组/函数四档的**时机差别**与弱网闸门、RIC 兜底链【F9】 |
| "cancel() 会中断请求" | 官方原话："调用 cancel 函数并不会取消 promise 的执行"【F13】 |
| "竞态靠后端时间戳处理" | 不知 `count/currentCount` 在前端就裁决、且旧请求连 `loading:false` 都不写【F20】 |
| "轮询用 setInterval 就行" | 官方备注是"请求完成后等 interval"（自动串行化）；`pollingInterval` 0→正不会自动启动【F14】 |
| "设了 cacheKey 就不重复请求了" | 数据共享与 `cacheTime/staleTime` 互斥（#2313）、只有成功请求才缓存【F12】 |
| "`loadingDelay` 是防抖" | 它只延迟 `loading` 变 true 的时机，不发请求也不合并请求【F15】 |
| "防抖模式下 `runAsync` 一定有 Promise 返回" | 官方备注："在未被执行时，不会有任何返回"【F16/F17】 |
| "删了 Form.Item 值就没了" | `preserve` 默认 true；`getFieldsValue(true)` 才看得到残留【F26】 |
| "`Form.Item initialValue` 覆盖 `Form initialValues`" | 方向正好相反（Form 最高优先级）【F26】 |
| "`dependencies` 和 `shouldUpdate` 一起用更稳" | 官方明写"不应一起使用，可能带来更新逻辑的混乱"【F26】 |
| "`hidden` 字段等于不存在" | hidden 依然收集与校验【F26】 |
| "用 `message.xxx`/`Modal.confirm` 静态方法就够了" | 静态方法脱离 ConfigProvider 上下文、5.0 起废弃【F28】 |
| 报"我们的微前端首屏提升了 XX%、包体积减少 YY KB" | 无可核查出处（§7 第 9 条） |

---

## 5. 出题角度

### 题面草稿 A（`code`，`judgeKind=react-vitest`）—— 微前端隔离决策器 + 样式作用域改写器
> **子应用接入基座的"隔离档位"回归用例（qiankun 2.10.x 语义）**
> 实现两个导出：
> 1) `resolveIsolation({ hasProxy, hasConstDestructAssignment, supportsShadowDOM, legacyRender, sandbox, singular, appName, instanceSeq })`，返回 `{ sandboxType: 'Proxy'|'LegacyProxy'|'Snapshot', singular: boolean, scopedCss: boolean, shadowWrapped: boolean, warnings: string[], thrown: string[] }`。约束（每条都要能指回语义）：
>    - `sandbox` 可以是 `true|false|{strictStyleIsolation?, experimentalStyleIsolation?, loose?, speedy?}`；缺省按 `start` 的默认 `{prefetch:true, singular:true, sandbox:true}` 处理；
>    - 无 `Proxy` → 沙箱退化为快照、并把 `loose` 置真；此时若 `singular === false` 追加告警"Setting singular as false may cause unexpected behavior while your browser not support window.Proxy"；
>    - 有 `Proxy` 且 `loose` → `LegacyProxy`，否则 `Proxy`；`hasConstDestructAssignment === false` 且 speedy 未被显式关闭 → 追加"Speedy mode will turn off…"告警并把 speedy 记为关；
>    - `legacyRender === true`（未配置 container 的旧渲染）时开启任一档样式隔离 → 返回 `thrown` 里带对应错误文案（`strictStyleIsolation can not be used with legacy render!` / `experimentalStyleIsolation can not be used with legacy render!`）；
>    - `strictStyleIsolation` 且 `supportsShadowDOM === false` → 只 warn 并**忽略**（`shadowWrapped:false`），不得进 `thrown`；
>    - `scopedCss` 为真时容器标识用 `instanceSeq` 推导出的实例 id（同名第 2 次加载得到 `appName_1`）。
> 2) `scopeCss(cssText, prefix)`，按运行时 scoped css 规则改写：**只改写普通样式规则与 `@media/@supports` 内部规则**；`@keyframes/@font-face/@import/@page` 原样输出；`html{}`/`body{}`/`:root{}` 的选择器**替换**为 prefix；`html body{}`、`html > body{}` 先剥掉 `html` 前缀再处理；`html + body{}`、`html ~ body{}` **保持原样**；组选择器 `div, body, span{}` 中每个非根选择器加 `${prefix} ` 前缀、根选择器替换成 prefix；同一输入重复调用结果不变（幂等）。
> 用例（至少各一条，方向都要断言）：`hasProxy:false + singular:false`；`legacyRender:true + strictStyleIsolation:true`；`supportsShadowDOM:false + strictStyleIsolation:true`；`@font-face` 与 `@keyframes` 混在规则表里；`html body` vs `html + body`；`*:not(:root)`；重复调用 `scopeCss`。
> 区分度：**"抛错 / 忽略 / 降级"三种出口必须分开**（写成"一律 warn"直接判负）；`@font-face` 不被改写与"`html + body` 不处理"这两条最挑人。

### 题面草稿 B（`code`，`judgeKind=react-vitest`）—— 请求编排：竞态 + 轮询 + 时间窗
> **给一个任务状态查询组件写可判分内核**（不依赖网络库，用注入的 `service` 与假 timer）
> 实现 `createTicker({service, pollingInterval, pollingWhenHidden, pollingErrorRetryCount, loadingDelay, debounceWait, debounceLeading, debounceTrailing, cacheKey, staleTime, hidden, now})`，暴露 `{run, runAsync, cancel, state, log}`。要求逐条对上语义：
> 1) **竞态**：并发起两次调用，先发起者后返回 → 先发起者不得写入 `data`、不得触发 `onSuccess/onError/onFinally`；`runAsync` 以 `CancelledError` reject；若先发起者本身 reject 业务错误，仍只能是 `CancelledError`；`run` 对取消不报告；
> 2) **轮询**：下一次只能在**上一次完成**后 `pollingInterval` 到期时发起；连续失败计数在成功时归零；`pollingErrorRetryCount = n` 时最多容忍 n 次连续失败（含边界 `<=`）；`pollingWhenHidden=false` 且 `hidden=true` → 不排下一次，改为在重新可见时 refresh 一次；`pollingInterval` 从 0 变为正数不得自动启动；
> 3) **loading 观感**：`loadingDelay=300`，请求 260ms 完成 → 全程 `loading` 为 false；900ms 完成 → 300ms 起为 true，完成即 false；
> 4) **防抖**：200ms 内触发 5 次 run，只发 1 次，且发生在最后一次触发后 `debounceWait`；`debounceLeading=true` 时首发立即执行；`debounceTrailing=false` 时尾部不执行；
> 5) **缓存**：同一 `cacheKey` 并发两次 → 底层 service 只被调用 1 次（Promise 共享）；`staleTime` 命中时不得调用 service 且立即返回缓存；`staleTime` 过期时先返回缓存数据再后台重取。
> 用例含：竞态反向用例、恰好等于 `pollingErrorRetryCount`、隐藏期间到期、`loadingDelay` 恰好相等、`debounceWait` 恰好 200ms、缓存新鲜/恰好过期。
> 区分度：1) 与 2) 的"可见性 vs 执行"分离；把 `cancel` 写成"中止请求"的按"没读过文档"降档。

### 题面草稿 C（`code`，`judgeKind=react-vitest`，组件级）—— 字段消失、值还留着
> 渲染一个 `OrderFilterForm`：`Form` 上有 `initialValues={{channel:'app', keyword:''}}`，两个同名 `Form.Item name="channel"`（都带 `initialValue`），一个 `hidden` 的 `name="internalTag"`（带 `required` 规则），一个 `Form.List name="items"`（含两行，每行 `name={['items', i, 'sku']}`），以及一个"只看高危"开关：为真时才条件渲染 `Form.Item name="riskLevel"`。
> 断言（输入 → 期望）：
> 1) 提交时 `onFinish` 的 `values.channel` 取值：`initialValues` 与 Item 的 `initialValue` 冲突 → **以 Form 为准**；多个同 name 都设 initialValue → 该行为不生效；
> 2) 先勾"只看高危"再取消勾选（字段被卸载），`form.getFieldsValue()` 里 `riskLevel` **仍不存在**，但 `form.getFieldsValue(true)` 里**仍能看到残留值**（`preserve` 默认 true）；
> 3) `hidden` 的 `internalTag`：DOM 上取不到输入框，但 `validateFields()` **会因它 required 而 reject**，`errorInfo.errorFields` 含 `{name:['internalTag'], errors:[...]}`；
> 4) `remove(0)` 后再 `getFieldsValue()`，数组按新顺序收敛且**不残留被删行的值**；若把行内 `name` 写成数字路径且 store 里原本没有该层，会**自动变成数组**——用 `['1','sku']` 的字符串写法做对照；
> 5) `onValuesChange(changedValues, allValues)` 在"切换隐藏开关"这一步**不得**把已卸载字段算进 `changedValues`。
> 区分度：2)/3)/4) 三处方向互不相同（残留但拿不到、看不见但参与校验、删干净要看索引写法），任一处写反即判"只背过 Form 的 props 列表"。

### 题面草稿 D（`rubric`，10 分制，主推）
> **你正在面试某基座团队的 Senior Frontend（微前端 + 中台表单方向），45 分钟**
> 前提（机制部分可核查，数字一律是题面假设）：一个 qiankun 2.x 主应用挂 5 个子应用（React16/React18/Vue2 混栈），要求"同一时刻只显示一个"；部分子应用用 `<link rel="stylesheet">` 引外部主题、部分用 CSS-in-JS 注入 `<style>`；中台表单里有"筛选条件多、字段按权限动态显隐"的页面；数据层统一用 ahooks `useRequest`；团队现在把 `sandbox` 配成了 `true`，`experimentalStyleIsolation` 没开，弹层组件一律不传容器。
> 现状与事故：① 两个子应用各自定义了同名 `@font-face` 与 `@keyframes fadeIn`，互相覆盖图标与动画；② 切走再切回某子应用后，它的定时器与 `window.__TRACK__` 把数据写进了已卸载的上下文；③ 一次"筛选字段按权限隐藏后仍能提交出值"被安全同学提单；④ 任务状态轮询在用户切到后台标签页时仍持续打服务端，被 SRE 找上门；⑤ `Modal.confirm` 里的子应用内容拿不到子应用的 `prefixCls`。
> 请给出：① **隔离档位矩阵**（三档样式隔离 × 三种沙箱 × 单/多实例：分别隔离什么、漏什么、是静默降级还是硬失败），并明确你会选哪一档与代价；② 针对 ①（font-face/动画冲突）给出**不改构建链的止血**与**改构建链的根治**两版；③ 针对 ②：设计"副作用归还"规范（哪些副作用必须在 `unmount` 可撤销、谁记录、怎么在 CI 或运行时发现漏归还）；④ 针对 ③：把"字段不可见 ≠ 字段不存在"落成表单层的硬规则（哪些字段允许 `hidden` 提交、哪些必须真卸载并清值，`preserve`/`clearOnDestroy`/`getFieldsValue(true)` 各自职责）；⑤ 针对 ④：轮询参数怎么配、以及"隐藏时暂停"之后回到前台的补拉策略与幂等；⑥ 针对 ⑤：浮层落点与主题继承方案（`getContainer`/`getPopupContainer`/静态方法废弃后的正确姿势），以及它和 ① 的样式隔离如何同时成立；⑦ 一条你**主动拒绝**做的事并说明代价。
> **加分点**：说清 `@font-face/@keyframes/@import/@page` 不被改写与 `LINK` 样式表不被处理这两条例外，并据此论证"CSS-in-JS 与 link 引入在隔离上表现不同"【F1/F4】；引用"strictStyleIsolation will be removed in 3.0"来说服团队别在新站点开 shadow dom【F7】；区分"沙箱不隔离 `document`"与"动态插入样式由另一套 patcher 处理"，并给出"事件监听/定时器尽量不要放在初始化阶段"的依据【F5/F10/F11】；指出 `pollingErrorRetryCount` 是**连续失败**计数（成功即归零）而不是总次数【F24】；把 `useRequest` 的取消语义讲成"结果不可见 ≠ 请求中止"，并说明为什么"切页面省流量"这个理由不成立【F13/F20】；用 `Form` 值优先级与 `labelCol/wrapperCol` 的**反向优先级**说明"值以 Form 为准、布局以 Item 为准"是有意设计【F26】；主动声明"首屏提升百分比、QPS、包体积数字都是假设，我的测法是…"；⑦ 真的拒绝了一件（例如"我不上 shadow dom 全量隔离，因为弹层与第三方脚本会先漏"）并给出代价。
> **不足点**：把沙箱当安全边界（它只是全局变量代理，跨域脚本仍在你页面里执行）；认为"开了隔离就一劳永逸"，对 font-face/动画/LINK 三例外无感；用 `hidden` 做权限控制却不改提交裁剪；把 `cancel()` 说成中断请求；轮询用 setInterval 并承认没考虑后台标签页；说"我们不用 antd 的静态方法是因为不优雅"却给不出替代 API；引用"阿里内部基座就是这么配的"（§7 第 8 条）。

### 题面草稿 E（`rubric`，短题，10 分钟）
> "一个子应用 unmount 之后，用户 30 秒后重新进入：qiankun 各自重建了什么、没重建什么？请用 3 分钟说明：`bootstrap`/`mount`/`unmount` 各跑几次，环境沙箱与 render 沙箱谁被重建，样式节点会发生什么，以及'哪些副作用必须自己在 unmount 归还、哪些可以交给框架重建'。"
> 期望：`bootstrap` 一个实例只跑一次（环境沙箱也只初始化一次，"子应用切换时实际切换的是 app 环境沙箱"）【F5】；`mount` 每次都跑，render 沙箱每次重新初始化，`mount()` 内部三段顺序"不能变"（active → 重建 bootstrapping 期副作用 → patchAtMounting → 重建 mounting 期副作用）【F5】；`unmount()` 是把 bootstrapping/mounting 两段 freers 执行后收成 rebuilders 再 `sandbox.inactive()`，所以"归还"是延迟到下次进入时兑现的【F5】；样式侧：scoped css 对同一 style 节点幂等（`ModifiedTag`），`@font-face/@keyframes` 不参与改写因而跨切换仍会互相影响【F4】；框架管不到的（子应用自己 `setInterval` 且闭包持有 DOM、直接 `window.xxx = fn` 的写法）必须由业务在 `unmount` 清，且 `sandboxRunning:false` 后的写入是静默丢弃的，指望"沙箱帮你擦干净"是错的【F10】。

---

## 6. 可判分事实表

> 用法：**这一表就是出题人的取材单**。每行都是"给定 A，官方说结果是 B"，`判分形态` 里 `纯函数` 最稳（与现有 `runner.entry="function"` 题一致），`组件级` 需要判题容器有 `@testing-library/react` + `jsdom`（本仓库 `web/package.json` 有，判题镜像是否装了**未核验**）。★ ＝ 本文最推荐直接落题的四类。
> **禁止**把 §7 的东西写进题面；凡数字（300ms、5000ms、3 次）只有在本表里出现且能回指【源】的才是事实，其余必须写成"题面假设"。

| # | 机制事实（输入 → 期望输出） | 判分形态 | 出处 | 建议难度 |
|---|---|---|---|---|
| 1 ★ | 给定 CSS 文本 `.app-main{font-size:14px}` 与 prefix `div[data-qiankun="react16"]` → 输出选择器被限定在容器内；给定 `@font-face{...}`/`@keyframes{...}` → **输出与输入一致**（未被改写） | 纯函数（`scopeCss(css,prefix)`） | 【源 F4】+【源 F1】 | 中 |
| 2 ★ | 给定 `html body{}`、`html > body{}`、`html + body{}`、`div, body, span{}`、`*:not(:root){}` 五条 → 前两条剥 `html` 前缀、第三条原样、第四条逐选择器加前缀且根选择器被替换、第五条不吃括号 | 纯函数（同上，边界用例） | 【源 F4】 | 难 |
| 3 | 同一 style 文本连喂两次 → 第二次**不变**（幂等标记）；样式来自 `<link>` → 只产生一条"不支持 link"的告警、内容不变 | 组件级或纯函数 | 【源 F4】 | 中 |
| 4 ★ | 给定 `{hasProxy:false, sandbox:true, singular:false}` → 沙箱类型 = Snapshot、`loose` 被强制、告警含 "degenerate into snapshotSandbox" 与 singular 警告；给定 `{hasProxy:true, loose:true}` → LegacyProxy；`{hasProxy:true, loose:false}` → Proxy | 纯函数（`resolveIsolation`） | 【源 F5】【源 F6】 | 中 |
| 5 ★ | `sandbox:false`（legacy render）+ `strictStyleIsolation:true` 或 `experimentalStyleIsolation:true` → **抛错**，错误文案逐字为 `strictStyleIsolation can not be used with legacy render!` / `experimentalStyleIsolation can not be used with legacy render!`；无 shadow dom 支持时开 `strictStyleIsolation` → **不抛错**，只 warn 并忽略 | 纯函数（决策表，两类出口） | 【源 F7】 | 中 |
| 6 | 同名子应用依次加载三次（`react16`、`react16`、`react16`）→ 实例 id 序列 `react16`、`react16_1`、`react16_2`；wrapper DOM id 为 `__qiankun_microapp_wrapper_for_react16__`（下划线化的 name） | 纯函数 | 【源 F8】 | 易-中 |
| 7 | 子应用入口只导出 `mount` 与 `unmount`（缺 `bootstrap`）→ 生命周期校验返回 false，报 `Application died in status LOADING_SOURCE_CODE: You need to export the functional lifecycles in xxx entry` | 纯函数 + 文案断言 | 【源 F8】【源 F2】 | 易 |
| 8 | `activeRule:'/app1'` + URL `https://app.com/app1/anything/everything` → 激活；URL `https://app.com/app2` → 不激活；`activeRule:'/pathname/#/hash'` + `https://app.com/pathname#/hash/route/nested`（少一个斜杠）→ 不激活；`['/pathname/#/hash','/app1']` → 任一命中即激活（官方 ✅/🚫 表可整搬） | 纯函数（`isActive(rule,url)`） | 【源 F1】 | 中 |
| 9 | `start({prefetch:true})` 与 `start({prefetch:'all'})` 在"第一个子应用 mount 之前"这一时刻的预取集合不同（前者为空，后者为全部）；`prefetch: false` → 永不预取；`prefetch: ['a']` → first-mount 后只取 a；函数策略 → critical 立即、minor 等 first-mount | 纯函数（计划器） | 【源 F9】【源 F1】 | 中-难 |
| 10 | 预取闸门：`navigator.onLine=false` 或 `connection.saveData=true` 或 `type∉{wifi,ethernet}` 且 `effectiveType` 命中 `/([23]g/` → 预取集合为空；`requestIdleCallback` 缺失 → 用 `MessageChannel` 兜底，再缺 → `setTimeout(fn,0)` | 纯函数 | 【源 F9】 | 中 |
| 11 | `singular` 的默认值随入口而变：`start({})` → `true`（`frameworkConfiguration = {prefetch:true, singular:true, sandbox:true, ...opts}`）；`loadMicroApp(app)` 未传 configuration → `false`（`configuration ?? {...frameworkConfiguration, singular:false}`） | 纯函数（默认值表） | 【源 F1】【源 F6】 | 易 |

> **又一处文档与源码不一致，出题前先读这条**：FAQ 写"IE 环境下（不支持 Proxy 的浏览器）只能使用单实例模式，qiankun **会自动将 `singular` 配置为 `true`**"【源 F2】，但 v2.10.16 的 `autoDowngradeForLowVersionBrowser` 在无 Proxy 时只做了两件事——把沙箱改写成 `{loose:true}`（实际仍会因 `!window.Proxy` 落到 SnapshotSandbox）与**警告**"Setting singular as false may cause unexpected behavior while your browser not support window.Proxy"，**没有**改写 `singular` 的值【源 F6】。所以判分用例只能断言"出现该警告 + 沙箱类型为 Snapshot"，不许断言"`singular` 被改成 true"。
| 12 | 两次 `runAsync`：第一次 900ms 成功、第二次 100ms 成功 → 最终 `data` 等于第二次的结果；第一次不触发 `onSuccess`；第一次的 promise 以 `CancelledError`（`name==='CancelledError'`、`isCancelledError` 为真）reject；第一次若自身失败，也仍是 `CancelledError`；`run` 版本不报告任何东西 | 组件级（假 timer + service） | 【源 F13】【源 F20】【源 F21】 | 中 |
| 13 | `pollingInterval: 0` → 不轮询；`1000` → 上一次**完成**后 1000ms 才下一次（慢请求自动串行化）；`pollingInterval` 由 0 改为 1000 **不自动启动**，需 `run`；`pollingErrorRetryCount:2` + 连续 3 次失败 → 第 3 次失败后停止；期间成功一次则计数归零 | 组件级或纯函数（next-action 决策） | 【源 F14】【源 F24】 | 中 |
| 14 | `pollingWhenHidden:false` + 页面隐藏 → 暂停且不排下一次；重新可见 → 触发一次 refresh（默认 `pollingWhenHidden:true` 时继续轮询） | 组件级（需 mock `visibilitychange`） | 【源 F14】【源 F24】 | 中 |
| 15 | `loadingDelay:300`：请求 260ms 完成 → `loading` 全程 false；900ms 完成 → 300ms 起 true；`ready:false` 时不挂这个 timer | 组件级 | 【源 F15】 | 易-中 |
| 16 | `debounceWait:300` + 200ms 内 5 次 `run` → service 只执行 1 次（在最后一次后 300ms）；`debounceLeading:true` → 立即执行 1 次；`debounceTrailing:false` → 尾部不执行；未真正执行的 `runAsync` **不返回 Promise** | 组件级 / 纯函数 | 【源 F16】 | 中 |
| 17 | `throttleWait:300` + 频繁 `run` → 每隔 300ms 执行一次；`throttleLeading`/`throttleTrailing` 默认都是 `true` | 纯函数/组件级 | 【源 F17】 | 易-中 |
| 18 | `retryInterval` 不设 → 第 1 次重试等待 2s、第 2 次 4s、超过 30s 取 30s（`1000 * 2 ** retryCount`） | 纯函数 | 【源 F19】 | 易 |
| 19 | `refreshOnWindowFocus:true` + 距上次请求 4s → 不重取；6s → 重取一次（`focusTimespan` 默认 5000）；监听事件为 `visibilitychange` 与 `focus` | 组件级 | 【源 F18】 | 中 |
| 20 | `cacheKey` + `staleTime:5000` + 缓存写入于 1s 前 → 不发请求、立即返回缓存（`returnNow`）；缓存写入于 6s 前 → **先返回缓存**再后台重取；`cacheTime: -1` 不过期、`staleTime: -1` 永远新鲜；只有**成功**结果会写缓存 | 纯函数（时间入参）+ 组件级 | 【源 F22】【源 F23】【源 F12】 | 中-难 |
| 21 | 同 `cacheKey` 两个消费者并发 → 底层 service 只调用 1 次（Promise 共享），且两者 `data` 同步；但设了 `cacheTime`/`staleTime` 时该共享机制失效（官方 #2313 备注） | 组件级 | 【源 F12】【源 F23】 | 难 |
| 22 | 自定义 `setCache`/`getCache` 时 `cacheTime` 与 `clearCache` 不再生效 | 纯函数 | 【源 F12】 | 易-中 |
| 23 ★ | 表单默认值：`Form.initialValues` 与 `Form.Item.initialValue` 冲突 → **以 Form 为准**；两个同 `name` 的 Item 都设 `initialValue` → 都不生效；子组件写了 `defaultValue` 但 Item 有 `name` → 不生效 | 组件级（`onValuesChange`/`getFieldsValue` 断言） | 【源 F26】 | 中 |
| 24 ★ | 条件渲染的字段被卸载后：`getFieldsValue()` 不含该字段、`getFieldsValue(true)` **仍含其残留值**（`preserve` 默认 true）；`clearOnDestroy:true` 时卸载才清空 | 组件级 | 【源 F26】 | 中 |
| 25 | `Form.Item hidden:true` 的必填字段：DOM 里取不到输入框，但 `validateFields()` 仍 reject，`errorInfo.errorFields` 含该字段；`warningOnly:true` 的规则不阻塞提交（错误进 `errors` 但不 reject） | 组件级 | 【源 F26】 | 中-难 |
| 26 | `Form.List`：`remove(0)` 后 `getFieldsValue()` 的数组按新下标收敛；`add(defaultValue, insertIndex)` 在指定下标插入；行内字段 `name` 用数字且 store 无该层时**自动转数组**，要当 key 用就得写字符串 `['1','sku']`；List 下字段不应再写 `initialValue` | 组件级 | 【源 F26】 | 难 |
| 27 | 校验时机：`validateTrigger` 默认 `onChange`；`Rule.validateTrigger` 与 Item 的不同/非子集 → 不生效（"必须是 Form.Item 的 validateTrigger 的子集"）；`trigger` 默认 `onChange`，改它即可支持自定义控件（如 `onSearch`）；`valuePropName` 默认 `value`，Switch/Checkbox 必须改 `checked`，且自定义 `getValueProps` 后 `valuePropName` 失效 | 组件级 + 纯函数（默认值表） | 【源 F26】 | 中 |
| 28 | 受控优先级（自定义组件版）：`useControllableValue(props,{defaultValue:1})`，`props.value` 存在 → state 用 `props.value`；只有 `props.defaultValue` → 用它；都没有 → 用 options 的 `defaultValue`；`valuePropName`/`trigger` 默认 `value`/`onChange` | 组件级 | 【源 F25】 | 中 |
| 29 | 弹层落点：`Modal` 默认 `getContainer = document.body`（因此**不在子应用容器内**，scoped css 覆盖不到）；`getContainer={false}` → 挂在当前位置；`ConfigProvider.getPopupContainer` 默认 `() => document.body`，可返回 `ShadowRoot`；`message/notification/Modal.confirm` 静态方法另起 React 根、不继承 ConfigProvider 的 `prefixCls`/`theme`，5.0 起废弃，改用 `useMessage/useNotification/useModal`；`prefixCls` 覆盖顺序 `ConfigProvider.config({prefixCls})` < `holderRender` 包一层 ConfigProvider < `message.config({prefixCls})` | 组件级（DOM 断言）＋ rubric | 【源 F27】【源 F28】 | 中-难 |
| 30 | 运行时 publicPath："`qiankun` 将会在微应用 **bootstrap 之前**注入一个运行时的 publicPath 变量"，子应用需 `__webpack_public_path__ = window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__`；漏掉 → 动态载入的脚本/样式/图片地址不正确（表现为资源 404）；打包产物 CSS 里的相对字体/图片路径**无法**靠 publicPath 修正 | rubric（排障题）＋ 纯函数（资源 URL 拼接） | 【源 F2】【源 F3】 | 中 |
| 31 | 静态资源必须跨域（"由于 qiankun 是通过 fetch 去获取微应用的引入的静态资源的，所以必须要求这些静态资源支持跨域"）；动态 script（JSONP）会被转成 fetch；`excludeAssetFilter` 放行的资源"**会逃逸出沙箱**，由此带来的副作用需要你自行处理" | rubric | 【源 F2】 | 中 |
| 32 | 微应用间跳转不能用子应用路由实例（`Link`/`router-link`），官方三方案：`history.pushState()`、原生 `<a>` 完整地址、改 `location.href`；主应用 404 页不能写通配符 `*`，要用路由守卫判断"既不是主应用路由也不是微应用"再跳 | rubric | 【源 F2】 | 易-中 |

---

## 7. 想写但没找到来源、或抓到但不敢用的方向（这些**不能**写进题面）

1. **微前端"加载超时"**：qiankun 的 `start`/`loadMicroApp` 配置里没有超时项，`prefetch.ts` 与 API 文档页均未出现 timeout/abort 语义；本次抓取到的只有 `fetch`（自定义 fetch，可自控超时，但**框架层没有默认超时**）【F1/F9】。所以题面里不许写"qiankun 默认 30s 加载超时"之类；要考超时，只能显式写成"题面假设：基座自定义了 fetch 并加了 3s 超时"。
2. **`experimentalStyleIsolationSelector`**：任务提示里提到的这个选项，在本次抓到的 **v2.10.16 源码**（`src/interfaces.ts` 的 sandbox 类型只有 `strictStyleIsolation/experimentalStyleIsolation/loose/speedy/patchers`）与 **API 文档页**（类型只写 `strictStyleIsolation?/experimentalStyleIsolation?`）里**都不存在**，未采信、不作考点。它可能来自 3.x RC 或 umi 插件层，本次未核实。
3. **`sandbox.loose` 的内部行为、`speedy` 模式的实现细节、`patchers` 扩展点**：只抓到 `loose`/`speedy` 的**入口与默认值**（`useLooseSandbox ? new LegacySandbox(...) : new ProxySandbox(...)`、`speedy !== false` 默认开、`loose` 在 `interfaces.ts` 里被标 `@deprecated We use strict mode by default`），未读 `LegacySandbox`/`ProxySandbox` 里两者的行为差异全文，也**未读** `src/sandbox/patchers/dynamicAppend/*`。因此考点 2 只考"选哪档、降级还是抛错"，不考"loose 下写入去哪、speedy 省了什么开销"（无一手材料，§3 的追问也不涉及）。
4. **`status` 状态机完整图**：`getStatus()` 的 12 个取值是从**文档原文**复制的【F1】，但**状态迁移的先后次序**文档没有给；本文正文里的顺序是按"环境沙箱只 bootstrap 一次 + mount/unmount 可重复"【F5】与错误消息里出现的 `LOADING_SOURCE_CODE/NOT_MOUNTED` 阶段【F2】推出来的，全部标了【推】。另外 qiankun 的调度状态机来自依赖 `single-spa`（`prefetch.ts` 里 `import { getAppStatus, getMountedApps, NOT_LOADED } from 'single-spa'`，`interfaces.ts` 里 `activeRule: RegisterApplicationConfig['activeWhen']`）——**single-spa 不是阿里项目**，所以任何"阿里怎么实现 app 状态机"的说法都不成立，本文只用 qiankun 自己文档里写出的枚举与错误文案。
5. **生命周期调用次序的"幂等"保证**：文档明写"子应用只会触发一次 bootstrap"【F5】，但"同一实例被连续 `mount()` 两次会不会重复渲染"没有官方表述；源码 `loader.ts` 里还留着 FIXME"should use a strict sandbox logic while remount, see issues/518"【F7】。因此本文只写"bootstrap 一次、render 沙箱每次重建、mounting freers one-off 需重新初始化"这三条有据点，**不写**"mount 幂等"。
6. **`activeRule` 的精确实现（path-to-regexp 版本、hash 匹配细节）**：✅/🚫 表是文档原文【F1】，但匹配实现落在 `single-spa` 的 `activeWhen` 上，本文**未**读其源码，也未抓到 qiankun 侧对 `:userId` 语义的说明。出题时**只用官方表内的用例**，不要自己扩边界（例如"`/app1` 是否匹配 `/app10`"——文档表里**没有**这一行，官方没说，别当已知）。
7. **ahooks 文档站的正文**：`https://ahooks.js.org/zh-CN/hooks/use-request/*` 是 umi 3 客户端渲染，抓取只拿到 `<div id="root">` 空壳（约 2.1KB，无正文）。因此本文所有 ahooks 表述取自**官方仓库 `alibaba/hooks@master` 内作为文档源的同一份 markdown**（`packages/hooks/src/useRequest/doc/**/*.zh-CN.md`）＋**同仓库实现代码**，并在 §8 里逐条标出仓库路径与它对应的站点 URL。凡"文档站渲染后可能不同"的条目（例如某表格行顺序）不单独依赖。
8. **阿里/蚂蚁内部前端系统**：淘宝/支付宝的基座实现、内部埋点 SDK、内部低代码平台、Fusion 内部版、`window.__bl` 类 ARMS 前端监控参数——本次**没有抓到任何一份可引用公开文档**（`alibaba/fusion-design` 仓库元数据请求未返回内容）。本文的"前端开源栈"限定为 qiankun、ahooks、Ant Design 三个开源库。
9. **一切量级/性能对比**：微前端首屏收益、包体积、"比 iframe 快/省 N%"、qiankun/ice.js 的构建耗时、antd 6 相对 5 的性能数字、"双 11 前端真实流量"。本次抓到的文档里**没有**这类官方量化表述（§8 里没有一条支撑它们），一律不进题面。
10. **ice.js / rax / midway / egg / AntV / Formily / ProComponents**：本次未取正文。可核查到的只有仓库活跃度元数据（GitHub API：`alibaba/rax` 最后 push `2023-03-27`、`alibaba/ice` 最后 push `2026-04-02`、`alibaba/formily` 最后 push `2025-06-21`；仓库均未标 archived）【F28】。这些数字**只能**用来说明"为什么本文不引它们"，不能当作机制考点。若后续要扩"构建/表单引擎/图表"方向，请单独抓取后另开素材（Formily 尤其适合作为"动态 schema 表单"的第二份阿里前端素材）。
11. **`useRequest` 的 `formatResult`**：master 分支的 `doc/basic/basic.zh-CN.md` 里该节整段以 HTML 注释形式存在、`src/useRequest/src/types.ts` 里 `formatResult` 也是注释行【F13/F20】——即**当前文档不提供该 API**。因此本文不写 `formatResult`（网上大量旧版教程仍在讲它，出题若涉及就是教错东西）。
12. **抓取方式与由此产生的偏差**：本 session 的 `WebFetch` 工具被上游限流（返回 `FORBIDDEN code 115`），全部改用 `curl` 直接取原始 HTML/raw 文件，再用 HTML→文本转换提取；`raw.githubusercontent.com` 中途开始持续超时，改用 `cdn.jsdelivr.net/gh/<owner>@<tag>/<path>` 镜像取同一 tag 的原文（内容等价，但**没有走 GitHub 的 raw 域名**）。`https://hooks.umijs.org`（旧版文档域名）TLS 证书已过期，未使用。qiankun `src/index.ts`/`src/guide` 落地页只取到导航（正文在子页），已按 API/FAQ/tutorial 三页替代。

---

## 8. 来源清单（全部于 **2026-09-24** 实际抓取并确认页面/文件内容）

> 记法：**F#** 为编号。`支撑` 列指本文正文的考点编号或 §6 表行号。qiankun 源码一律按 **tag `v2.10.16`**（npm latest）抓取；ahooks 文档与源码按 **`alibaba/hooks@master`** 抓取。

| # | URL（抓取物） | 标题 / 版本 | 访问日期 | 支撑了上面哪几条考点 |
|---|---|---|---|---|
| F1 | https://qiankun.umijs.org/zh/api/ | 《API 说明》（服务端渲染正文，页面脚注最后更新 6/23/2025） | 2026-09-24 | 考点 2、4、5、6、7、11；§1.1 机制 2；§6 行 8、9、11；`activeRule` ✅/🚫 全表与"前缀匹配/任一 true 即激活"；`prefetch` 四档语义与"默认为 true"；`sandbox` 默认 true、shadow dom 说明、experimentalStyleIsolation 的改写示例（`div[data-qiankun-react16].app-main`）与"@keyframes/@font-face/@import/@page 将不被支持"；`singular` 在 start 默认 true / loadMicroApp 默认 false；`loadMicroApp` 返回的 `getStatus()` 12 值枚举与四个 promise；`update` 钩子需额外导出；`initGlobalState` 的三个方法（含"微应用中只能修改已存在的一级属性""微应用 umount 时会默认调用 offGlobalStateChange"） |
| F2 | https://qiankun.umijs.org/zh/faq | 《常见问题》 | 2026-09-24 | 考点 3、4、5、6、7、12（资源侧）；§1.1；§6 行 7、30、31、32；错误文案 `Application died in status LOADING_SOURCE_CODE: You need to export the functional lifecycles in xxx entry` 与三条 `Target container with #container not existed (after xxx mounted / while xxx mounting / while xxx loading)`；`start` 调用时机与 `window.qiankunStarted` 防重复；"qiankun 将会在微应用 **bootstrap 之前**注入一个运行时的 publicPath 变量"；"必须要求这些静态资源支持跨域"；"会将动态 script 加载（例如 JSONP）转化为 fetch 请求"；"`excludeAssetFilter` 放行的资源会逃逸出沙箱"；"IE 环境下（不支持 Proxy 的浏览器）只能使用单实例模式，qiankun 会自动将 `singular` 配置为 `true`"；"会先在自己的 window 里查找……如果没有就去父应用里查找"；"子应用访问的 window 对象是被 qiankun 代理后的对象，因此直接给 window 添加事件处理函数是无效"；多 activeRule 同时激活与"必定会导致其中一个 404"；主应用 404 页与微应用间跳转三方案；`props.container` 非空导致样式表丢失（config entry）；css 内字体/图片相对路径 404 的成因与 CDN/url-loader 方案；antd 主应用隔离建议（`@ant-prefix` modifyVars + `ConfigProvider prefixCls`）；umi 插件的 `credentials: true` |
| F3 | https://qiankun.umijs.org/zh/guide/tutorial | 《项目实践》（入门教程） | 2026-09-24 | 考点 4、5；§6 行 30；微应用接入四步（public-path.js、history 路由 base 且"值和它的 activeRule 是一样的"、入口最顶部引入 + 导出三个生命周期、webpack umd/跨域）；"运行时的 publicPath 和构建时的 publicPath 是不同的，两者不能等价替代"；"`if (!window.__POWERED_BY_QIANKUN__) render({})`"；"通过 ReactDOM.render 挂载子应用时，需要保证每次子应用加载都应使用一个新的路由实例"；`output.library/libraryTarget:'umd'/jsonpFunction`（webpack5 改 `chunkLoadingGlobal`）/`globalObject:'window'`；非 webpack 项目把 lifecycles 挂到 `window` 上 + `<script ... entry>` |
| F4 | https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/patchers/css.ts （经 jsDelivr 镜像取原文） | `ScopedCSS` 实现（v2.10.16） | 2026-09-24 | 考点 1；§1.2 全表；§6 行 1、2、3；`RuleType` 数值（STYLE 1 / MEDIA 4 / SUPPORTS 12 会被改写；IMPORT 3 / FONT_FACE 5 / PAGE 6 / KEYFRAMES 7 / KEYFRAME 8 注释为"value will be kept"）；`rootSelectorRE = /((?:[^\w\-.#]|^)(body\|html\|:root))/gm`、`rootCombinationRE = /(html[^\w{[]+)/gm`、`siblingSelectorRE`、`whitePrevChars = [',', '(']`；`html/body/:root` 三选一的替换分支；组选择器 `${p}${prefix} ${s}` 拼接；`ruleMedia`/`ruleSupport` 的 `conditionText` 回退式；`QiankunCSSRewriteAttr = 'data-qiankun'` 与 `prefix = ${tag}[data-qiankun="${appName}"]`；LINK 元素的 `console.warn('Feature: sandbox.experimentalStyleIsolation is not support for link element yet.')`；`ModifiedTag` 幂等 |
| F5 | https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/index.ts | `createSandboxContainer`（v2.10.16） | 2026-09-24 | 考点 2、4；§1.1 机制 1；§6 行 4；环境沙箱 vs render 沙箱的官方中文注释（"每个应用的环境沙箱只会初始化一次，因为子应用只会触发一次 bootstrap""每次子应用切换过后，render 沙箱都会重现初始化""还能运行在应用 bootstrap 之后的环境下"）；`window.Proxy ? (useLooseSandbox ? new LegacySandbox : new ProxySandbox) : new SnapshotSandbox`；`mount()` 内"因为有上下文依赖（window），以下代码执行顺序不能变"与三段次序；`unmount()` 收集 rebuilders 后 `sandbox.inactive()`；`mountingFreers` "are one-off and should be re-init at every mounting time"；"some side effect could be invoked while bootstrapping, such as dynamic stylesheet injection with style-loader"；"尽量不要在应用初始化阶段有 事件监听/定时器 等副作用" |
| F6 | https://github.com/umijs/qiankun/blob/v2.10.16/src/apis.ts 与 .../src/interfaces.ts | `start/registerMicroApps` 与类型定义（v2.10.16） | 2026-09-24 | 考点 2、6；§6 行 4、9；`frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts }`；`defaultUrlRerouteOnly = true`；`autoDowngradeForLowVersionBrowser`（`Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox` + 强制 `loose:true` + singular:false 时的警告；`isConstDestructAssignmentSupported()` 失败时 `Speedy mode will turn off…` 并置 `speedy:false`）；`PrefetchStrategy` 类型 union；sandbox 选项类型含 `loose?`（`@deprecated We use strict mode by default`）、`speedy?`（"enabled by default from 2.9.0"）、`patchers?`；`activeRule: RegisterApplicationConfig['activeWhen']`（→ 委托给 single-spa，见 §7 第 4 条） |
| F7 | https://github.com/umijs/qiankun/blob/v2.10.16/src/loader.ts | 加载与容器渲染（v2.10.16） | 2026-09-24 | 考点 2、4；§1.1 机制 2；§6 行 5；`supportShadowDOM` 判定与 `'[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!'`；开发期警告 `strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!`；`attachShadow({mode:'open'})` 与 `shadow.innerHTML`；scoped css 时给 wrapper `setAttribute('data-qiankun', appInstanceId)` 并只对 `querySelectorAll('style')` 逐个改写；`getAppWrapperGetter` 里两条 `throw new QiankunError('strictStyleIsolation can not be used with legacy render!')` / `('experimentalStyleIsolation can not be used with legacy render!')`；容器缺失错误文案模板（`Target container with ${container} not existed while/after ${appInstanceId} ${phase}!`）；`validateSingularMode`（singular 可为函数）；remount 的 FIXME（issues/518）。**复核补记（2026-09-24，出题批次 ab-fe）**：本行的四条文案改由 GitHub MCP `get_file_contents(owner=umijs, repo=qiankun, ref=v2.10.16, path=src/loader.ts)` 重新抓到原文并逐字核对通过，行号 L64（`supportShadowDOM`）、L80（shadow dom 被忽略的 warn）、**L122/L123（`throw new QiankunError('strictStyleIsolation can not be used with legacy render!')` / `('experimentalStyleIsolation can not be used with legacy render!')`）**、L283（3.0 移除的开发期 warn）；同一份原文里 L212/L227 写的是 `legacyRender = 'render' in app ? app.render : undefined`（即"提供了自定义 render 函数"），`fe-react-0022` 的题面按此把 `legacyRender` 与 `sandbox:false` 分开建模。逐字行与 URL 另存于 `scripts/bank/drafts/alibaba/fe_gen.py` 文件头 |
| F8 | https://github.com/umijs/qiankun/blob/v2.10.16/src/utils.ts | 工具与契约（v2.10.16） | 2026-09-24 | 考点 4；§6 行 6、7；`validateExportLifecycle` 源码（`isFunction(bootstrap) && isFunction(mount) && isFunction(unmount)`）；`genAppInstanceIdByName`（同名首次返回 `appName`，之后 `${appName}_${count}`）；`getWrapperId = __qiankun_microapp_wrapper_for_${snakeCase(name)}__`；`getDefaultTplWrapper` 生成的 wrapper 属性（`data-name`/`data-version`/`data-sandbox-cfg`）与"mock a head placeholder as native head element will be erased by browser in micro app" |
| F9 | https://github.com/umijs/qiankun/blob/v2.10.16/src/prefetch.ts | 预加载策略（v2.10.16） | 2026-09-24 | 考点 6；§6 行 9、10；`if (!navigator.onLine \|\| isSlowNetwork) return`；`isSlowNetwork` 的完整判据（`saveData` 或非 wifi/ethernet 且 `/([23]g/` 命中 `effectiveType`）；`requestIdleCallback` → `MessageChannel`（"it does not have the 4ms delay of setTimeout"）→ `setTimeout(idleCall, 0)` 的兜底链与 `timeRemaining()` 的 `Math.max(0, 50 - (Date.now() - start))`；`prefetchAfterFirstMounted` 监听 `single-spa:first-mount`、只挑 `getAppStatus(name) === NOT_LOADED`、回调内 `removeEventListener`；`doPrefetchStrategy` 的 `true / 'all' / string[] / function(criticalAppNames + minorAppsName) / default(不预取)` 分支；预取内容＝`getExternalStyleSheets` + `getExternalScripts` |
| F10 | https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/proxySandbox.ts | Proxy 沙箱（v2.10.16） | 2026-09-24 | 考点 3；§1.1 机制 3、4；`set` 陷阱：`sandboxRunning===false` 时 warn `[qiankun] Set window.${p} while sandbox destroyed or inactive in ${name}!` 且 `return true`（注释"在沙箱卸载的情况下应该忽略错误"）；`globalVariableWhiteList` 命中时同步写真实 globalContext 并存原描述符；`get` 陷阱：`Symbol.unscopables`、`window/self/globalThis` 指回 proxy（注释"avoid who using window.window or window.self to escape the sandbox"）、`top/parent` 在主应用处于 iframe 时放行、`document` 返回 `this.document`、查找式 `propertiesWithGetter.has(p) ? globalContext : p in target ? target : globalContext`；`updatedValueSet`/`latestSetProp`/`activeSandboxCount`/`patchDocument(doc)`；`SandBoxType = {Proxy='Proxy', Snapshot='Snapshot', LegacyProxy='LegacyProxy'}`（`interfaces.ts`） |
| F11 | https://github.com/umijs/qiankun/blob/v2.10.16/src/sandbox/snapshotSandbox.ts | 快照沙箱（v2.10.16） | 2026-09-24 | 考点 3；§1.1 机制 3；类注释"基于 diff 方式实现的沙箱，用于不支持 Proxy 的低版本浏览器"；`this.proxy = window`；`active()` 记录快照并重放 `modifyPropsMap`；`inactive()` 用 diff 记录变更并还原原值（`sandboxRunning=false`）；`patchDocument(): void {}` 空实现；`iter()` 对 `clearInterval` 的兼容特例 |
| F12 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/cache/cache.zh-CN.md （渲染页 https://ahooks.js.org/zh-CN/hooks/use-request/cache ，见 §7 第 7 条） | ahooks《缓存 & SWR》 | 2026-09-24 | 考点 11；§1.3；§6 行 20、21、22；`cacheTime` 默认 `300000`、`-1` 永不过期；`staleTime` 默认 `0`、`-1` 永远新鲜；`interface CachedData<TData,TParams> {data; params; time}`；"缓存的数据包括 data 和 params"；数据共享两条特性（Promise 共享 / 数据同步）与官方警告"如果没有发起新请求，不会触发数据共享。`cacheTime`、`staleTime` 参数会使数据共享失效（#2313）"；`setCache`/`getCache` 需配套、自定义模式下 `cacheTime` 与 `clearCache` 不生效；`clearCache(cacheKey?)` 单个/数组/空＝全清；"只有成功的请求数据才会缓存" |
| F13 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/basic/basic.zh-CN.md （渲染页 .../use-request/basic） | ahooks《基础用法》 | 2026-09-24 | 考点 8；§1.3；§6 行 12；竞态与取消的完整表述（"cancel 用于忽略当前 promise 返回的数据和错误""**调用 cancel 函数并不会取消 promise 的执行**""组件卸载时/竞态时自动忽略响应""被忽略的请求不会更新 data/error，也不会触发 onSuccess/onError/onFinally""run/refresh 不会报告任何东西""runAsync/refreshAsync 以 CancelledError reject""即使其自身 promise 以 service 错误 reject，被覆盖的调用也只会以 CancelledError reject"）；`isCancelledError` 用法；`manual` 默认 `false`；`run` vs `runAsync`；`refresh/refreshAsync`＝"使用上一次的 params"；`mutate` 两种写法；`params` 语义（`run(1,2,3)` → `[1,2,3]`）；`defaultParams`；`onBefore/onSuccess/onError/onFinally`；Result/Options 两张表 |
| F14 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/polling/polling.zh-CN.md | ahooks《轮询》 | 2026-09-24 | 考点 9；§6 行 13、14；`pollingInterval` 默认 `0`、"> 0 则处于轮询模式"；`pollingWhenHidden` 默认 `true`（false 时"页面隐藏时会暂时停止轮询，页面重新显示时继续上次轮询"）；`pollingErrorRetryCount` 默认 **`-1`**（无限次）；四条备注（动态变化、`manual:true` 初始化不启动、0→正不会自动启动、"轮询原理是在每次请求完成后，等待 pollingInterval 时间，发起下一次请求"）；`run/runAsync/cancel` 在轮询语境下的含义 |
| F15 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/loadingDelay/loadingDelay.zh-CN.md | ahooks《Loading Delay》 | 2026-09-24 | 考点 10；§6 行 15；`loadingDelay` 默认 `0`、"延迟 loading 变成 true 的时间，有效防止闪烁"、"假如 getUsername 在 300ms 内返回，则 loading 不会变成 true"；支持动态变化 |
| F16 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/debounce/debounce.zh-CN.md | ahooks《防抖》 | 2026-09-24 | 考点 10；§6 行 16；`debounceWait/debounceLeading/debounceTrailing/debounceMaxWait` 默认 `- / false / true / -`；"所有参数用法和效果同 lodash.debounce"；"只会在最后一次触发结束后等待 300ms 执行"；"`runAsync` 在真正执行时会返回 Promise，在未被执行时不会有任何返回"；"`cancel` 可以中止正在等待执行的函数" |
| F17 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/throttle/throttle.zh-CN.md | ahooks《节流》 | 2026-09-24 | 考点 10；§6 行 17；`throttleWait/throttleLeading/throttleTrailing` 默认 `- / true / true`；"只会每隔 300ms 执行一次"；与防抖同的两条备注 |
| F18 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/refreshOnWindowFocus/refreshOnWindowFocus.zh-CN.md | ahooks《屏幕聚焦重新请求》 | 2026-09-24 | 考点 10；§6 行 19；`refreshOnWindowFocus` 默认 `false`、`focusTimespan` 默认 `5000`；"如果和上一次请求间隔大于 5000ms，则会重新请求一次"；"监听的浏览器事件为 `visibilitychange` 和 `focus`" |
| F19 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/doc/retry/retry.zh-CN.md | ahooks《错误重试》 | 2026-09-24 | 考点 10；§6 行 18；`retryCount`（`-1` 无限）、`retryInterval` 不设时"取 `1000 * 2 ** retryCount`，也就是第一次重试等待 2s，第二次重试等待 4s，以此类推，如果大于 30s，则取 30s"；`cancel` 可取消进行中的重试 |
| F20 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/src/Fetch.ts | 请求内核（master） | 2026-09-24 | 考点 8；§1.3；§6 行 12、20；`runAsync` 里 `this.count += 1` + `currentCount`、`if (currentCount !== this.count) throw new CancelledError()`（位于 `setState` 之前）、catch 分支"被覆盖时只可能抛 CancelledError"、插件 `onFinally` 需 `currentCount === this.count`、`stopNow`/`returnNow` 直接 `return Promise.resolve(state.data)`、`run` 里"cancellation is not a failure: run never reports it" |
| F21 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/src/utils/cancelledError.ts | `CancelledError`/`isCancelledError`（master） | 2026-09-24 | 考点 8；§6 行 12；默认 message `'useRequest: the request was cancelled or superseded.'`、`name='CancelledError'`、标记位 `__AHOOKS_CANCELLED_ERROR__`（"Marker that survives duplicated copies of the module, unlike instanceof"）、类注释"swallowed by `run`/`refresh`, by `options.onError` and by the plugin `onError` handlers" |
| F22 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/src/plugins/useCachePlugin.ts 与 .../src/utils/cache.ts | 缓存插件与全局 cache Map（master） | 2026-09-24 | 考点 11；§6 行 20、21；`cacheTime = 5 * 60 * 1000`、`staleTime = 0` 的形参默认值；初始化时读缓存并 `if (staleTime === -1 || Date.now() - cacheData.time <= staleTime) state.loading = false`；`onBefore` 的 "If the data is fresh, stop request" → `returnNow: true` 与 "If the data is stale, return data, and request continue"；`onRequest` 的 `getCachePromise`/`setCachePromise` 与 `servicePromise !== currentPromiseRef.current` 才复用；`cache.ts` 里 `if (cacheTime > -1) setTimeout(() => cache.delete(key), cacheTime)`、`clearCache` 单/多/全清 |
| F23 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/src/plugins/usePollingPlugin.ts | 轮询插件（master） | 2026-09-24 | 考点 9；§6 行 13、14；形参默认值 `pollingWhenHidden = true`、`pollingErrorRetryCount = -1`；`if (!pollingInterval) return {}`；`onError` 计数 +1、`onSuccess` 归零、`onFinally` 里 `pollingErrorRetryCount === -1 \|\| countRef.current <= pollingErrorRetryCount` 才 `setTimeout(fetchInstance.refresh, pollingInterval)`，否则清零收尾；`!pollingWhenHidden && !isDocumentVisible()` → `subscribeReVisible(() => fetchInstance.refresh())`；`onCancel → stopPolling()` |
| F24 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useRequest/src/types.ts | `Options` 全量标识符（master） | 2026-09-24 | 出题用的**唯一标识符清单**（防手打）：`manual/onBefore/onSuccess/onError/onFinally/defaultParams/refreshDeps/refreshDepsAction/loadingDelay/pollingInterval/pollingWhenHidden/pollingErrorRetryCount/refreshOnWindowFocus/focusTimespan/debounceWait/debounceLeading/debounceTrailing/debounceMaxWait/throttleWait/throttleLeading/throttleTrailing/cacheKey/cacheTime/staleTime/setCache/getCache/retryCount/retryInterval/ready`；`Result` 的 `loading/data/error/params/run/runAsync/refresh/refreshAsync/mutate/cancel`；`PluginReturn` 的 `stopNow/returnNow/onMutate`；`formatResult` 仅以注释形式存在（§7 第 11 条） |
| F25 | https://github.com/alibaba/hooks/blob/master/packages/hooks/src/useControllableValue/index.zh-CN.md | ahooks《useControllableValue》 | 2026-09-24 | 考点 12；§1.4；§6 行 28；`defaultValue` 说明"默认值，会被 `props.defaultValue` 和 `props.value` 覆盖"；`defaultValuePropName` 默认 `defaultValue`、`valuePropName` 默认 `value`、`trigger` 默认 `onChange`；签名 `useControllableValue(props, options)` |
| F26 | https://ant.design/components/form-cn | Ant Design《Form》（文档站当前描述 6.x；npm latest 6.6.5） | 2026-09-24 | 考点 12；§1.4 全图；§6 行 23–27；默认值优先级三条（Form.initialValues 最高、Field.initialValue 次之、多同名 Item 不生效）；"设置 name 后子组件转为受控模式，defaultValue 不会生效"；"initialValues 不能被 setState 动态更新，需要用 setFieldsValue"；`Form` 表：`preserve` 默认 `true`（+"你可以通过 getFieldsValue(true) 来获取保留字段值"）、`validateTrigger` 默认 `onChange`、`clearOnDestroy` 默认 `false`、`layout` 默认 `horizontal`、`scrollToFirstError` 默认 `false`、`requiredMark` 默认 true、`disabled` 默认 false（"仅对 antd 组件有效"）、`onValuesChange(changedValues, allValues)`/`onFinish`/`onFinishFailed({values,errorFields,outOfDate})`；`Form.Item` 表：`trigger` 默认 `onChange`、`validateTrigger` 默认 `onChange`、`valuePropName` 默认 `value`（Switch/Checkbox 需 `checked`、自定义 `getValueProps` 后失效）、`preserve` 默认 `true`、`hidden` 默认 false（"依然会收集和校验字段"）、`noStyle`（继承父 `validateStatus`）、`validateFirst` 默认 false（`parallel: 4.5.0`）、`validateDebounce`（5.9.0）、`shouldUpdate` 默认 false、`normalize`（"不支持异步"）、`getValueFromEvent`、`labelCol/wrapperCol`"以 Item 为准"；`Rule` 表：`validateTrigger` 子集要求、`warningOnly`（不阻塞提交）、`whitespace`（仅 `type:'string'`）、`transform`、`type` 常见枚举、`defaultField/fields/enum/len/max/min/pattern/required`；`FormInstance`：`getFieldsValue()` 默认返回现存字段值、`getFieldsValue(true)` 返回 store 全部（含未注册）、`nameList` 需嵌套数组、`setFieldValue/setFields`（"直接传入 form store 并且重置错误信息"）、`validateFields(nameList, {validateOnly, recursive, dirty})` 与 `dirty = touched + validated`、`resetFields` 重置到 initialValues；`Form.List`：`name` 本身是字段（`getFieldsValue()` 默认返回 List 下所有值）、List 下字段不应配 `initialValue`、`operation.add(defaultValue, insertIndex)/remove(index|index[])/move(from,to)`；`dependencies` 与 `shouldUpdate` 不应一起用；"无法在 render 阶段通过 form.getFieldsValue 实时取值" + `Form.useWatch`（`WatchOptions.preserve` 默认 false）；FAQ：`name` 数组的数字会自动转数组（要用 string key 就写 `['1','name']`）、Modal 内 useForm 未连接的告警与 `forceRender`、`resetFields` 会重新 mount 子组件、Segmented 不受 Form `disabled` 影响；`validateMessages` 模板与 `${label}` 转义（5.20.2 起 `\\${}`） |
| F27 | https://ant.design/components/modal-cn | Ant Design《Modal》 | 2026-09-24 | 考点 7；§6 行 29；`getContainer` 说明"指定 Modal 挂载的节点，但依旧为全屏展示，`false` 为挂载在当前位置"，类型 `HTMLElement \| (() => HTMLElement) \| Selectors \| false`，**默认值 `document.body`**；命令式 `Modal[method].getContainer`"指定 Modal 挂载的 HTML 节点，false 为挂载在当前 dom"，默认 `document.body`；`keyboard` 默认 true |
| F28 | 版本与活跃度锚点：https://registry.npmjs.org/qiankun/latest （`version: 2.10.16`）、https://registry.npmjs.org/ahooks/latest （`3.10.0`）、https://registry.npmjs.org/antd/latest （`6.6.5`）；https://api.github.com/repos/umijs/qiankun （default_branch `next`、tags 含 `v3.0.0-rc.22` 与 `v2.10.16`）、`/repos/alibaba/hooks`、`/repos/alibaba/rax`、`/repos/alibaba/ice`、`/repos/alibaba/formily` | npm registry 与 GitHub API 元数据 | 2026-09-24 | 只用于**版本锚定与 §7 第 10 条的取舍说明**（rax 最后 push 2023-03-27、ice 2026-04-02、formily 2025-06-21、qiankun master 已让位于 `next` 分支），不支撑任何机制结论 |
| F29 | https://ant.design/components/config-provider-cn | Ant Design《ConfigProvider》 | 2026-09-24 | 考点 7；§6 行 29；`getPopupContainer` 说明"弹出框（Select, Tooltip, Menu 等等）渲染父节点，**默认渲染到 body 上**"，类型 `(trigger?: HTMLElement) => HTMLElement \| ShadowRoot`，默认 `() => document.body`；`getTargetContainer`（Affix/Anchor 滚动容器，允许 `Window \| ShadowRoot`）；FAQ 原文"静态方法是使用 ReactDOM.render 重新渲染一个 React 根节点上，和主应用的 React 节点是脱离的……原先的静态方法在 5.0 中已被废弃"与 `useMessage/useNotification/useModal` 建议；"prefixCls 优先级（前者被后者覆盖）"三级示例（`ConfigProvider.config({prefixCls})` < `holderRender` 内层 ConfigProvider < `message.config({prefixCls})`）；FAQ"配置 getPopupContainer 导致 Modal 报错"（Modal 无 triggerNode，需对 node 判空回落 document.body） |

> 抓取失败清单（**未**作为本文任何结论的依据）：`ahooks.js.org/zh-CN/hooks/use-request/*`（umi 3 客户端渲染，只拿到 2.1KB 空壳）；`hooks.umijs.org`（TLS 证书过期，curl 退出码 60）；`qiankun.umijs.org/zh/guide` 落地页（1.8KB，只有导航）；`raw.githubusercontent.com`（前两次成功，之后持续超时，故改走 jsDelivr 镜像）；`github.com/umijs/qiankun` 的 `master` 分支 `src/` 路径（默认分支已是 `next`，改用 tag `v2.10.16`）；`umijs/qiankun/src/app.ts` 与 `src/sandbox/css.ts`（猜错路径，404；实际在 `apis.ts/loader.ts` 与 `sandbox/patchers/css.ts`）；`alibaba/fusion-design` 仓库元数据（请求未返回内容）；`WebFetch` 工具全程被限流（`FORBIDDEN code 115`），正文一律由 `curl` 取得（§7 第 12 条）。
