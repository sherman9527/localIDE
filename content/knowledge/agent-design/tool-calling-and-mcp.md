# 工具调用与 MCP：把 Agent 接到真实系统（2026 版）

对应考点：`tool-schema-design`、`mcp-integration`、`agent-guardrails`（部分）、`agent-data-interface`、`agent-observability`
适配难度：senior / principal｜出题形式：`code`（react-vitest / redis / java-junit）+ `rubric`
事实基线：MCP 最新修订 **2026-07-28**（无状态优先、`server/discover`、MRTR、tasks 扩展、`sampling`/`roots` 废弃、RFC 9207 `iss` 校验、Client ID Metadata Documents 取代动态注册）。工具调用参数格式因模型/SDK 而异，题面一律用中性 JSON 描述，不绑定具体厂商字段名。

---

## 1. 核心机制

### 1.1 工具是"给模型看的 API"，设计标准比给人看的更严
- **少而清晰**：`search_bookings` + `get_booking` + `update_booking_status` 优于 `do_everything(action)`；但也禁止"22 个近义工具"（选择准确率随工具数下降，且成本上升）。
- **参数可验证**：类型 + 枚举 + 范围 + 必填；日期用 `YYYY-MM-DD`/ISO8601 + 显式时区语义；ID 用不透明字符串（模型会猜格式）；分页/limit 必填（防"给我全部"）。
- **副作用声明**：`read_only` / `mutating` / `destructive` / `external_side_effect`（发邮件、下单、扣款）；高风险动作在 schema 里要求 `dry_run` + `confirm_token` 两步式。
- **失败语义面向模型**：返回 `{error_code, retryable, message, hints}`；`hint` 写"下一步该做什么"（如 `use date_from instead of date`），而不是堆栈；同一错误不要每次给不同 code。
- **返回体积控制**：结果默认裁剪（字段白名单 + 截断 + `next_cursor`），提供 `expand`/`fetch_more` 二段式，避免一次塞 30k token 原始 JSON 进上下文。

### 1.2 调用循环的工程细节
1. 规划：是否需要在调用前显式产出计划（结构化，便于评测与中断恢复）；
2. 参数生成 → **校验层**（JSON schema 校验 + 归一化 + 修复：类型转换、多余字段剥离、枚举近似匹配）→ 失败则把结构化错误回给模型重试（限次，带预算）；
3. 执行：超时/取消传播（用户点停 = 真取消，别让后台继续跑写操作）；幂等键由编排层生成（同一逻辑调用重试复用）；
4. 观察：结果摘要 + 证据引用（id/url/行号），写回上下文时**保留原样数值**；
5. 循环控制：最大步数、重复调用检测（同工具同参数 N 次即熔断）、无进展检测（输出 hash 未变）、token/成本闸。

### 1.3 MCP 要点（2026-07-28 之后）
- 原语：`tools`（可执行）、`resources`（可读上下文）、`prompts`（模板）；传输：stdio（本地）与 streamable HTTP（远端，支持流式与取消）。
- **无状态优先**：不再依赖 `initialize` 握手与协议级会话 → server 可水平扩展、可放网关/LB 后面；能力与元信息发现走 `server/discover`。工程含义：会话状态、流式订阅、进度回调都要在编排层或应用层显式管理（不能指望协议帮你存）。
- **MRTR（Multi Round-Trip Requests）**：elicitation（需要补充输入）不再有专用通知，而是客户端带上下文重发原请求 → 服务端需幂等、可恢复；这是"agent 向用户追问"的协议底座。
- **tasks 扩展 `io.modelcontextprotocol/tasks`**：长任务用 `tasks/get` 轮询 + `tasks/update`，替代阻塞式结果（把"分钟级工具"从连接占用里解放出来）。
- **`sampling`/`roots` 废弃**：模型调用与文件系统根的能力回到客户端/编排层，server 不再越权调模型——安全边界更清楚，但也意味着你要自己做模型路由与预算。
- **鉴权**：授权服务器必须校验 `iss`（RFC 9207，防混淆代理）；动态客户端注册被 **Client ID Metadata Documents** 取代；企业侧还需要：per-user scope、工具级授权（不是 server 级）、审计与可撤销、以及"MCP 网关"做白名单/限流/内容脱敏。
- 生态风险：工具名/描述可被投毒（描述里藏指令）、影子 server（员工私接第三方）、同名工具冲突与"路由到错误的写操作"。治理动作：工具目录 + 版本 + 审批 + 签名/来源约束 + 每次调用落审计。

### 1.4 数据类工具（text-to-SQL / 检索）的特殊纪律
- 只暴露语义层/视图，不给裸表；SQL 走只读账号 + 行级权限 + `EXPLAIN` 预检扫描量 + 超时与并发配额（`redis` 可做租户级令牌桶）。
- 数字必须来自查询结果原样呈现（含口径、时间范围、数据新鲜度戳），空结果要区分"确实没有" vs "权限不足/超时降级"。
- 检索类工具要返回 `evidence_id`，供引用与"证据面板"回溯；对不可信来源打标记（编排层据此决定丢弃顺序）。

---

## 2. senior / principal 会被追问什么

1. "模型老把参数写错，你是改提示还是加校验层？"（期待：确定性校验 + 结构化错误反馈 + 修复归一化，必要时窄化参数空间；不靠"再教它一次"）
2. "一次调用失败，什么时候该重试，什么时候该停？"（区分 4xx 语义/参数错（改参数再试）、429/5xx（退避 + 预算）、超时（幂等键重放）、业务性失败（换策略，别重试））
3. "工具写了外部系统（发消息），超时了但可能已成功，怎么办？"（幂等键 + 状态查询 API + 悬挂态对账；无查询能力时改两步式"意图 + 确认"）
4. "怎么防止注入内容通过工具参数把数据外带？"（参数白名单/域名校验、禁止模型自由拼 URL、出站域名 allowlist、敏感字段脱敏、外发动作需人确认）
5. "MCP server 怎么水平扩展？无状态化后你原本依赖会话的逻辑怎么改？"（状态外置到编排层/存储；进度与流式改由应用层通道承载；长任务转 tasks）
6. "工具数量从 8 涨到 60，你怎么治理？"（分组暴露 + 意图路由、目录与命名规范、契约测试、评测集上"选择准确率/误用率"作为门槛指标）
7. "你怎么给工具做测试？"（契约测试 + 参数边界 + 幂等/并发 + 录制回放；评测层用 mock，集成层用沙箱真写，生产侧对账）
8. "Agent 调用链路怎么观测？成本归因到谁？"（trace 树 + 每步 token/延迟/成本 + 用户/租户归因 + 失败分类）

---

## 3. 常见错误答案

- "工具越多越强"：选择准确率下降、上下文成本上升、冲突与影子工具风险。
- 参数错误靠"提示里再强调一遍"，没有确定性校验/修复层。
- 把 HTTP 栈或异常文本原样丢给模型（token 浪费 + 误导重试）。
- 无幂等键就重试写操作；或"超时即失败"直接对用户报错（可能已执行）。
- 让模型自己拼 SQL/URL 且不加白名单（注入即越权/外带）。
- 把 server 级授权当成工具级授权（一个 server 里"读工具 + 删数据工具"同权限）。
- 声称"我们用了 MCP 所以安全"：MCP 只解决互操作，不解决授权、内容可信与副作用治理。
- 不知道 MCP 2026-07-28 的变化（仍在设计里依赖 `initialize` 会话、阻塞式长调用、动态注册），上线后水平扩展与合规审查出问题。

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=java-junit`）
> 实现工具调用编排器 `ToolRuntime.invoke(ToolCall raw, Invoker backend)`：
> ① schema 校验（`required`、`enum`、类型、日期格式）失败 → 返回 `VALIDATION_ERROR` 且**不发起后端调用**，并给出机器可读 hint；
> ② 归一化修复：`"2026/9/3"` → `"2026-09-03"`、`"Active"` → `"active"`、多余未知字段剥离（剥离数量记入响应）；不可安全修复的（枚举无近似、数值越界）不得猜测；
> ③ 幂等：为 `mutating/destructive` 工具生成 `idempotency_key = hash(sessionId, logicalCallId, tool, normalizedArgs)`；相同逻辑调用重试时 key 不变、`logicalCallId` 由调用方传入；
> ④ 重试预算：`retryable` 错误最多 3 次、退避且总耗时超 `deadlineMs` 立即停止；`non-retryable` 不重试；
> ⑤ 重复调用熔断：同 `(tool, normalizedArgs)` 连续 3 次返回相同结果 hash → 返回 `LOOP_DETECTED`；
> ⑥ 超时但后端可能已成功 → 返回 `UNKNOWN_OUTCOME` 且携带 key（供对账），不得自动重试。
> 用例：上述 6 项各覆盖至少一条 + "修复后再次校验通过"的两段式流程 + `UNKNOWN_OUTCOME` 不触发重试（用计数器断言后端只被调用一次）。

### 题面草稿 B（`code`，`judgeKind=redis`）
> 用 Redis 实现"Agent 工具级配额"：`check_and_consume(user_id, tool, limit_window)` → 允许/拒绝，要求：① 每个 tool 独立的滑动窗口配额；② 用户级并发上限（同时最多 N 个执行中调用，崩溃后要能自动回收，用租约 TTL）；③ `destructive` 类工具需一次性 confirm token（`CONSUME` 原子，二次使用拒绝）。用例含并发 200、进程崩溃后的租约回收、confirm token 重放。

### 题面草稿 C（`rubric`，10 分制）
> **Apple · Principal Engineer, Agent Infrastructure（45 分钟）**
> 你要为公司内部（研发 + 客服 + 运营）建"Agent 工具平台"：各团队自助发布 MCP server / 工具，Agent 侧统一调用；涉及系统包括源码托管、CI、告警、CRM、支付后台（只读为主但有高危写操作）、数据仓库。安全团队要求"不允许 agent 直接拥有生产写权限"；法务要求"用户数据不得经第三方模型提供商处理"；平台要求单工具 p95 < 800ms、支持 300 并发会话、可审计。
> 请给出：工具生命周期治理（注册、审批、版本、签名/来源、下线）、授权模型（人 → agent → 工具三级，含 scope 粒度与撤销）、MCP 网关设计（发现、路由、限流、脱敏、审计）、高危动作的确认与双人机制（含协议层如何表达）、无状态化后的会话与长任务方案（tasks/MRTR）、注入与数据外带的防御清单、可观测与合规留痕，以及"自助发布"与"安全审批"矛盾的机制化解法。

**加分点**
1. 工具分级（read-only / mutating / destructive / external-effect）决定审批与授权强度，且分级进 schema 而非口头约定。
2. 三级授权模型：人的权限（IdP/角色）→ agent 代表用户的窄化 scope（不得提权）→ 工具级 allowlist；短时凭证 + 可撤销 + 每次调用留 `who/for-whom/why`。
3. MCP 网关承担：`server/discover` 结果缓存与白名单、工具命名冲突消解、参数/返回脱敏（PII 正则 + 字段策略）、配额与熔断、审计与采样留存；并说明无状态协议如何让它天然水平扩展。
4. 长任务用 tasks 扩展（轮询/更新）+ 悬挂态对账；交互澄清用 MRTR，服务端要求幂等且可恢复。
5. 显式响应 MCP 2026-07-28 的鉴权变化（`iss` 校验、Client ID Metadata Documents），并解释它防的是什么攻击（混淆代理/token 误投放）。
6. 高危动作两步式：`dry_run` 预览（列出将影响的对象与数量）+ 人确认 token（绑定 dry_run 结果 hash，防"预览 A 执行 B"）；必要时四眼/工单化。
7. 注入与外带防御清单：不可信内容标记、参数与出站域名白名单、URL/脚本类参数禁止模型自由生成、跨工具数据流限制（A 的敏感输出不得成为 B 的入参，除非策略允许）、红队用例常态化。
8. "自助 vs 审批"机制化：分级审批（read-only 自助 + 自动扫描，写操作人工 + 双人）、沙箱租户、契约/评测门禁（误用率、失败率、延迟）自动放行，违规自动降级。
9. 可观测：以"逻辑调用"为单位的 trace（含 token/成本/重试/幂等命中/熔断触发）、错误分类占比、per-team 成本归因、以及回放能力（把线上失败轨迹在评测环境重跑）。
10. 合规：数据不出境/不经第三方的落地（本地模型或受信任端点 + 路由策略）、工具返回的 PII 最小化、审计留存与访问控制、以及"agent 决策可解释"的留痕粒度。

**不足点**
- 把授权做到 server 粒度或"给 agent 一个管理员 token"。
- 无工具分级、无 dry-run/确认机制。
- 认为 MCP 自带安全（忽略内容可信与副作用治理）。
- 依赖 `initialize` 会话做状态存储（与 2026-07-28 无状态方向冲突）却没给出状态外置方案。
- 无幂等/对账，超时后直接重试写操作。
- 无观测/审计/成本归因；自助发布只剩"谁都能上线"。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Apple | Principal/Senior Engineer, Agent/Tooling Infrastructure | "Build secure, auditable integration layers for AI systems"; "Define platform contracts adopted by many teams" |
| Airbnb | Staff Engineer, AI Platform / Developer Productivity | "Design tool frameworks and governance for multi-tenant agent platforms"; "Partner with Security on least-privilege access" |
| Airbnb | Senior Data Engineer, Data Products | "Expose governed data as services (semantic layer APIs, read-only query interfaces)" |
