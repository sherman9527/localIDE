# API / 契约设计与演进（移动规模 + 跨团队规模化协作）

对应考点：`api-contract`、`mobile-version-skew`、`authz-design`、`durable-orchestration`（部分）
适配难度：senior / principal｜出题形式：`code`（java-junit / redis）+ `rubric`

---

## 1. 核心机制

### 1.1 契约的四个层次，缺一层就会在真实故障里暴露
1. **线格式（wire）**：字段编号/类型稳定性（Protobuf 不复用 tag、未知字段保留；Thrift 小心 required）；JSON 则要求"未知字段必须忽略、字段顺序不假设、数值一律字符串承载大整数"。
2. **语义（semantics）**：同一字段在版本间含义漂移是最危险的兼容（形式兼容、语义不兼容）。做法：语义变更 = 新字段 + 双写 + 观测切换 + 老字段弃用窗口。
3. **失败模型（failure）**：错误码目录、是否可重试（`Retry-After`、`Idempotency-Replayed`）、部分失败表达（批量端点每子项状态）、限流表达（429 + 配额剩余 header）。统一用 `application/problem+json`（RFC 9457，取代旧 RFC 7807 写法）承载 `type/title/status/detail/instance` + 扩展位。
4. **时间与幂等**：服务端时钟不作为业务时间源；重试语义（`Idempotency-Key`）、超时预算（deadline 传播，客户端剩余时间随调用链传递）。

### 1.2 分页与游标
- offset 分页在写并发下会重复/漏项、且深翻性能塌（`LIMIT 20 OFFSET 100000` 需扫过全部前置行）。
- keyset（游标）分页要求：排序键唯一且稳定（`(sort_key, id)` 复合游标）、游标不透明（服务端签名/编码，防客户端构造）、排序变更必须让游标失效（版本化游标）、"新数据到达时是否可跨页"要明确声明。
- 大结果集：流式（gRPC streaming / SSE / Arrow Flight SQL，OLAP 场景）而不是"一次 JSON 全量"。

### 1.3 移动规模下的版本偏斜（Apple 场景核心）
- 客户端不可强制升级：服务端要同时服务跨度 2–3 年的版本；契约里显式声明 `min_supported_version` 与"低于则引导升级"的软门槛（不能硬 426 掉活跃用户）。
- 响应要**按调用方能力裁剪**：客户端上报 `client_version` / capability flags，服务端做字段级"能力协商"；避免"为老版本写一堆 if-else"演化成不可维护的胶水。
- 灰度维度：OS 版本 × App 版本 × 地区 × 设备等级；崩溃率/ANR/关键漏斗指标做发布闸，且要能**服务端单方面回滚**（新逻辑放 flag 后面，客户端只带开关读取路径）。
- 数据前向兼容：客户端解析失败必须降级（显示缓存、隐藏模块），不能白屏；服务端 schema 演进要过"对最老在服客户端的影响"检查。

### 1.4 契约治理工程化
- 单一事实源：OpenAPI / Protobuf（Buf：`buf lint`、`buf breaking`、Managed Schemas / 远程插件生成文档）；CI 上跑兼容性检查，破坏性变更必须显式例外 + 双人审批。
- SDK 由契约生成并纳入 semver；服务端与客户端 SDK 分开版本线；提供 deprecation 期与迁移指南（Airbnb/Apple 内部都要求"API 变更走 RFC + 弃用窗口 + 使用量遥测确认归零后删除"）。
- 内部服务：优先强类型（gRPC）+ deadline/重试策略外置（服务网格或库层）；对外 REST 面向第三方更友好；GraphQL 用于聚合多团队的读侧，但要治理 N+1 与深度查询（查询复杂度上限、persisted queries）。

### 1.5 授权与身份（Agent 时代新增维度）
- 服务间：工作负载身份（mTLS、SPIFFE 类）+ token 的 audience/scope 严格化，避免 "confused deputy"（把用户 token 直接透传给下游内部服务）。
- 端用户：Passkey/WebAuthn（Apple 强推，跨设备凭证同步）、DeviceCheck/App Attest 做设备真实性与防滥用（防脚本刷券/刷推荐位）。
- 授权即代码：策略集中评估、资源标签化、变更走评审（Airbnb Airlock 风格）；越权用例进测试矩阵（水平越权：同资源不同 owner；垂直越权：角色）。
- 新场景：给 Agent/MCP server 授予"代表用户"的凭证时，scope 要按工具粒度拆分、可审计、可短时回收（MCP 2026-07-28 起对 AS 强制 RFC 9207 `iss` 校验，并以 Client ID Metadata Documents 替代动态注册）。

---

## 2. senior / principal 会被追问什么

1. "删掉一个字段和加一个字段，哪个更危险？分别怎么推进？"（删：跨团队使用量不可知 → 遥测归零 + 弃用窗口；加：注意 `NOT NULL` 默认值语义与枚举兜底）
2. "枚举新增成员会打挂哪些老客户端？你的兜底策略是什么？"（`UNKNOWN_DEFAULT` 兜底 + 灰度先发"能容错"的版本再放新枚举）
3. "游标里放明文主键有什么风险？排序键改了怎么办？"（信息泄漏、可被构造；游标带版本 + 过期即回退第一页并提示）
4. "分页 + 实时写入的快照一致性怎么给？"（游标带 snapshot timestamp/version；湖仓用 Iceberg snapshot id / Spark 4.2 `VERSION AS OF`）
5. "外部渠道（支付/短信）没有幂等能力，你怎么在 API 层暴露？"（意图化 API：`POST /jobs` 返回 202 + job id；同步端点只对已具幂等的下游开放）
6. "两个团队对同一资源给出不同契约版本，谁说了算？如何避免'隐式契约'（靠字段顺序/错误字符串解析）？"
7. "移动端发版周期长，你的服务端发布怎么做到'不依赖客户端升级'？"（能力协商、flag、双契约并行、旧路径保留期 + 监控）
8. "怎么防止 API 被误用成慢查询？"（复杂度上限、字段数/深度限制、强制分页、批量端点独立配额、按 caller 配额）

---

## 3. 常见错误答案

| 错误 | 破绽 |
|---|---|
| "/v2 全量新 versioning，一版一版并存" | URL 版本化对读侧可接受，但长期双活会分裂逻辑；缺"何时下线 v1"的判据（使用量、迁移工具、弃用头） |
| "兼容性检查靠人 review" | 无法防"隐式依赖"；缺 CI 化（buf breaking / oasdiff 类） |
| "错误码用 `message` 给人看，客户端按文案分支" | 文案一改客户端就崩；必须 code + type URI |
| HTTP 200 + `{success:false}` | 状态码语义丢失，网关/监控/重试策略全失效 |
| 幂等键放 query 参数 | 缓存/日志/URL 语义混乱；应放 header |
| "GraphQL 就不用管契约了" | schema 仍会破坏；查询成本与 N+1 变成新问题 |
| 授权只写"接了 OAuth" | 说不清 scope 粒度、audience、越权测试矩阵 |
| 无灰度/回滚路径的 API 变更（直接改返回结构） | 老客户端白屏；移动端不可回滚带来的长尾 |

---

## 4. 出题角度

### 题面草稿 A（`code`，`judgeKind=java-junit`）
> 实现游标分页引擎 `Page<T> fetch(Sort sort, String cursor, int limit)`，要求：
> ①游标不透明（Base64 + HMAC 签名，篡改/未签名游标返回 `INVALID_CURSOR`）；
> ②排序键非唯一时用 `(key, id)` 复合游标，同 key 多行不得漏/重（测试注入 5000 行、10% 相同 key）；
> ③翻页过程中发生插入/删除（测试注入 mutation）时，声明并保证你所选策略：`SNAPSHOT_STABLE`（游标带版本，返回可重现）或 `LIVE_APPEND_OK`（新数据可见、不重复已见项）；
> ④游标版本与当前 `Sort` 不匹配 → `CURSOR_STALE`（HTTP 语义映射到 4xx + `Retry-After` 无、指引回首页）；
> ⑤返回 `nextCursor` 与 `hasMore`（用 limit+1 探测，避免额外 count 查询）。
> 用例覆盖：重复 key 翻页不漏项、篡改游标、排序字段变更后旧游标、末页 `hasMore=false` 且 `nextCursor=null`。

判分点很硬：是否真的处理过"同 key + 中途写入"的翻页，一看便知。

### 题面草稿 B（`rubric`，10 分制）
> **Apple · Senior Backend, Services API（35 分钟）**
> 你负责一个"面向 iOS/macOS 客户端 + 第三方 SDK + 内部 12 个服务"的配置下发与内容 API。约束：最老在服客户端版本 = 3 年前；无法要求升级；契约由多团队共同演进；出现两次事故——一次因新增枚举值打挂老客户端，一次因错误响应文案被第三方解析而爆炸。
> 请设计：契约治理流程（评审/CI 检查/弃用窗口/下线判据）、能力协商与字段裁剪方案、错误模型、分页与快照语义、以及"服务端发布对客户端零依赖"的落地机制（flag、双契约、观测）。同时给出你会建立的三类防回归指标。

**加分点**
1. 显式区分"新增可选字段 / 新增枚举成员 / 收紧校验 / 改语义"四类变更的风险与推进路径（枚举需先放容错版本，"未知值→UNKNOWN_DEFAULT"）。
2. 契约 CI：`buf breaking` / OpenAPI diff（oasdiff 类）+ 对"最老在服版本"的兼容性目标矩阵；破坏性变更需例外审批与迁移指南。
3. 能力协商：客户端上报 `app_version/os_version/capabilities`，服务端按 capability 出字段；且 capability 集合本身可回滚（不新增枚举依赖）。
4. 错误模型：RFC 9457 `problem+json`，稳定 `type` URI + `code` 目录 + `retryable` 标记；文档明确"第三方不得解析文案"。
5. 分页：不透明签名游标 + 快照版本（`config_version`/`snapshot_id`），排序变更导致游标失效的策略。
6. 零客户端依赖发布：新逻辑藏在 flag/双契约后；给出崩溃率、关键漏斗、schema 解析失败率三类闸指标与自动停发条件。
7. 弃用治理：使用量遥测 → 归零判据 → 删除窗口；对第三方 SDK 有版本支持矩阵与 EOL 政策。
8. 授权与安全：token audience/scope、防 confused deputy、越权测试矩阵、批量端点独立配额与防爬。
9. 迁移体验：提供 codegen 迁移脚本/兼容层、灰度名单（内测第三方）、文档与示例。
10. 反例意识：指出"不要为每个字段变化开新版本 URL"、"不要在移动端做业务规则兜底"等明确不做什么。

**不足点**
- 只会说"加 /v2"；无下线判据。
- 错误处理仍是 `200 + success:false` 或按文案分支。
- 无 CI 兼容性检查，靠"谨慎 review"。
- 未考虑老客户端不可回滚这一事实（把回滚责任推给客户端升级）。
- 枚举/校验变更的向前兼容不处理。
- 只谈 API 不谈配额、可观测与弃用治理。

---

## 5. 对标 JD 能力项

| 公司 | 岗位方向 | 能力项 |
|---|---|---|
| Apple | Senior Software Engineering Manager / SWE, Services | "Define and evolve APIs used by many teams and third parties"; "Design for backwards compatibility across a long-lived device fleet"; "Champion quality: telemetry-driven releases" |
| Airbnb | Senior/Staff SWE, Search & Marketplace API | "Design clean, well-documented service contracts"; "Collaborate cross-functionally on API standards" |
| Airbnb | Backend, Payments / Trust | "Build secure, authorized-by-design services"; "Drive API adoption and deprecation" |
| Apple | Data Engineer, Platform API/Tooling | "Build tooling and interfaces for internal platform consumers at scale" |
