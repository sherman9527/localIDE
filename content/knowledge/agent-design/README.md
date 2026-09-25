# agent-design 考点矩阵（AI Agent 系统：上下文、工具/MCP、检索、评测、护栏、成本）

> 出题前置输入。表格约定同 `system-design/README.md`：第 1 列 `中文考点名（`tag-id`）`，反引号内为题目 `tags` 用的 tag id。
> `可出题形式` ∈ `code` / `rubric`；`建议 judgeKind` ∈ `java-junit` / `react-vitest` / `mysql` / `redis` / `pyspark` / `llm-rubric`。
> 本类别以 `rubric + llm-rubric` 为主；能确定性判分的部分（解析/修复工具参数、算检索指标、渲染流式状态、预算与配额逻辑）优先做成 `code`（`react-vitest` / `java-junit` / `redis`）。
>
> 事实基线（2026-09 核实）：**MCP 规范最新修订为 2026-07-28**——协议转为**无状态优先**（移除 `initialize` 握手与协议级会话，新增 `server/discover`）、`tasks` 改为扩展 `io.modelcontextprotocol/tasks`（`tasks/get` 轮询 + `tasks/update`，替代阻塞式 `tasks/result`）、elicitation 走 **MRTR（Multi Round-Trip Requests）**、`sampling` 与 `roots` 被标记废弃、授权侧强制校验 RFC 9207 `iss` 并以 **Client ID Metadata Documents** 取代动态客户端注册；OWASP 发布 **Top 10 for Agentic Applications 2026**（2025-12-09，条目编号需核实）；OpenTelemetry Profiles 于 2026-03 进入公开 alpha（LLM/agent 可观测性的第四信号开始落地）。各模型 API 的具体参数名与价格随版本变化，题面中一律用占位符或标注"需核实"。

## 考点矩阵

| 考点 | senior 深度要点 | 2025-2026 新实践 | 可出题形式 | 建议 judgeKind | JD 能力项 |
|---|---|---|---|---|---|
| 上下文工程与预算分配（`context-engineering`） | 上下文是稀缺资源：分层（系统/工具/记忆/检索/RAG/历史）与 token 预算；"context rot"（长上下文中部召回衰减）与位置偏置；何时压缩（compaction）、何时外置笔记、何时拆子 agent；工具描述与示例也占预算 | 从 prompt engineering → context engineering：just-in-time 检索（按需读取而非预载）、结构化笔记/外部记忆文件、子 agent 并行探索后汇总、显式"上下文预算表"进设计文档；KV-cache 命中率成为工程指标（前缀稳定、避免每轮改动系统段） | rubric | llm-rubric | LLM 应用架构 |
| 记忆体系（`agent-memory`） | 工作/情景/语义记忆三分；写入策略（谁决定值得记、去重与冲突合并、置信度与衰减）、检索与注入位置、**遗忘与纠错**（PII 删除、错误记忆放大）、跨会话一致性与并发写 | 记忆作为可插拔后端（向量 + 关键词 + 结构化表混合）；记忆审计日志与"记忆溯源"（哪条回答用了哪条记忆）；记忆污染成为攻击面（indirect injection 写入长期记忆），需分级/白名单/人工确认 | rubric | llm-rubric | 状态管理、安全 |
| 工具 schema 设计与错误恢复（`tool-schema-design`） | 工具粒度（少而清晰 vs 多而细）、参数可验证性（枚举/范围/required）、幂等与副作用声明（read-only/destructive）、失败语义（结构化错误码 + 可重试标志 + partial result）；"模型误用工具"的根因常在描述含糊 | 工具自描述 + 错误消息面向模型可修正（提示下一步而非堆栈）；工具层做参数修复/重试/结果裁剪（超长输出转摘要 + 可展开引用）；工具契约测试（golden 调用序列）；MCP 下工具发现与按会话裁剪（tool filtering） | code | react-vitest | API/接口设计 |
| MCP 与工具生态（`mcp-integration`） | 资源/提示/工具三原语的真实用法；stdio vs streamable HTTP；进度/取消/日志；多 server 冲突（同名工具、鉴权域）；注册表与治理（企业内工具目录、版本与审批） | MCP 2026-07-28 无状态化（`server/discover`、MRTR、tasks 扩展）让水平扩展与网关化成为可能；`sampling`/`roots` 弃用（把模型调用收回客户端/编排层）；企业侧关注鉴权（RFC 8707 resource indicators、`iss` 校验）、审计与工具白名单；工具投毒/影子工具成为红队常规项 | rubric | llm-rubric | 集成与平台化 |
| RAG 与检索架构（`rag-architecture`） | 混合检索（BM25/关键词 + 向量 + 元数据过滤）、chunk 策略（结构感知 vs 定长；表格/代码/日志特殊处理）、rerank 与级联（召回 1k→粗排 100→精排 10→上下文 5）；先过滤 vs 后过滤导致召回塌陷；嵌入模型版本与索引重建；"检索质量 vs 生成质量"分离评估 | 分级检索（摘要层→详情层）、GraphRAG/关系扩展（成本敏感场景慎用）、表格与指标语义层接入（text-to-SQL 前先做指标校验）、向量索引进 OLAP/湖（ClickHouse/Doris/StarRocks 向量能力，需核实到版本）、agentic RAG（多轮检索 + 自查证据充分性） | rubric | llm-rubric | 检索/数据智能 |
| 检索与生成指标实现（`retrieval-metrics`） | recall@k、precision@k、MRR、nDCG、答案忠实度（faithfulness）与引用率的计算细节与坑（并列分数、缺失标注、分母定义）；标注集构建（分层抽样 + 难例）与统计显著性 | 用 LLM 打标 + 人工抽验（一致率、Cohen's kappa）；"证据必须可点回原文"的强制引用；检索 A/B 与线上反馈（点采率、答案改稿率）闭环 | code | react-vitest | 评估与度量 |
| Agent 评测与回归（`agent-evals`） | 三层评测：单步（工具选择/参数）、轨迹（序列/步数/成本）、终态（任务完成 + 可验证断言）；pass^k（一次成功 ≠ 稳定）；LLM-as-judge 的偏置（冗长偏好、位置偏置、自偏好）与缓解（成对比较、固定 rubric、多裁判、人工锚点）；从"演示驱动"转"评测驱动"开发 | 评测集即代码（版本化、与线上 trace 回流打通）、CI 上跑"小核心集 + 夜间大集"；沙箱环境与可重放（工具 mock + 固定种子/温度 0）；回归以"失败用例库"沉淀；agent 观测平台（LangSmith/Braintrust/OTel GenAI 语义约定等，具体能力需核实） | rubric | llm-rubric | 质量与可靠性 |
| 多 agent 编排（`multi-agent-orchestration`） | 何时拆：上下文隔离/权限隔离/并行收益 vs 成本翻倍与误差级联；supervisor vs 对等 handoff vs 流水线；共享状态与"谁写权威记忆"；终止条件、步数/预算闸、循环检测（同一工具同参数重复调用） | durable execution 承载长任务（挂起/恢复/人工审批）；A2A 类 agent 互操作协议与 MCP 工具层并用（需核实采用度）；"编排即代码"（工作流定义可版本化、可回放）；子 agent 输出要求结构化并带证据引用 | rubric | llm-rubric | 复杂系统设计 |
| 成本与延迟工程（`agent-cost-latency`） | 成本 = token（输入/输出/缓存价不同）+ 工具调用 + 模型路由；延迟预算分配（首 token vs 完成时间）；并行化（投机、扇出、多路采样投票的代价）；缓存（prompt 前缀缓存命中条件、语义缓存的风险）；提前退出与降级路径 | 混合模型路由（小模型 + 大模型回退）与蒸馏；批处理/离线 agent（削峰）；成本与延迟成为 SLI（每任务 $ 与 p95）纳入看板与发布闸；推理侧新计费维度（缓存读写、工具调用轮次）需按当期定价核实 | rubric | llm-rubric | 性能与成本 ownership |
| 安全护栏与注入防御（`agent-guardrails`） | 直接/间接 prompt injection（检索文档、工具返回值、邮件/网页里藏指令）；最小权限工具 + 出站白名单 + 需确认的高危动作（双人/单次授权）；输出侧（PII/密钥/越权数据）与侧信道（工具参数把数据带到第三方）；红队用例集与攻击面清单 | 分层防御：输入清洗/来源标记（不可信内容显式包裹）、工具级 allowlist + 参数 schema 校验、动作分级审批、执行沙箱（无网络/只读挂载/资源上限）、行为监控（异常调用序列告警）；对齐 OWASP Agentic Top 10（2026 版）做威胁建模；MCP 侧鉴权收紧（`iss` 校验、Client ID Metadata Documents） | rubric | llm-rubric | 安全与隐私工程 |
| Agent 可观测性与运维（`agent-observability`） | 一次 LLM 调用 = 一个 span：输入/输出摘要、模型与参数、token/成本、工具调用树、重试与缓存命中；trace 与业务结果（转化/工单解决）关联；错误分类（模型错/工具错/数据错/用户错）；上线后的静默劣化监测 | OpenTelemetry GenAI 语义约定 + profiles（2026-03 alpha）把 CPU/GPU 火焰图与 token 成本同屏；尾部采样保留失败轨迹；"回放 trace → 本地复现"成为调试主路径；SLO 从可用性扩展到"质量分/成本/拒绝率" | rubric | llm-rubric | 生产运维 |
| 流式交互与前端渲染（`agent-ux-streaming`） | 事件流协议（SSE/分块 JSON）与顺序/断线重连/取消；增量 markdown/代码高亮的稳定渲染（不可回退）；工具步骤可视化（进度、可展开证据）、错误与"部分失败"呈现；引用角标与证据面板一致性 | 结构化中间输出（草稿计划 → 步骤状态 → 终稿）；human-in-the-loop（审批、编辑参数、纠正后重放）；客户端预算显示（已用 token/费用）；可中断与幂等重放（服务端持久化会话状态，MCP 无状态化后更容易水平扩展） | code | react-vitest | 端到端体验 |
| 数据面集成与 text-to-SQL（`agent-data-interface`） | 语义层作为工具（不暴露裸表）、指标口径校验、SQL 只读 + 行级权限 + 扫描量上限 + 超时；结果数值必须来自查询而非模型生成（防"编数字"）；空结果/权限不足的降级表达 | 查询计划预检（EXPLAIN 估扫描字节 → 超阈值转异步）；结果带血缘与口径说明；用湖仓快照/时间旅行固定读点保证可复现；用 `CHANGES`/MV 降低延迟；夜间自动回归（同一批问题跑一致性） | rubric | llm-rubric | 数据平台 + AI |
| 模型/提示版本管理与发布（`prompt-release`） | 提示与配置作为代码（版本、diff、A/B、灰度）；供应商升级的回归窗口；温度/种子带来的可复现性边界；离线评测通过 ≠ 线上通过（分布漂移）；回滚要能在分钟级完成 | canary + 影子流量（双模型并跑对比）；提示注入模板化测试；模型能力矩阵（长上下文/工具并行/结构化输出）驱动选型；"评测通过门禁 + 预算熔断"写进发布流程 | rubric | llm-rubric | 交付与质量 |
| 评测数据与环境隔离（`agent-test-env`） | 工具 mock vs 沙箱真实副作用的取舍（可重放、幂等、数据准备）；评测数据集污染（把测试样例放进记忆/检索库）；线上回流样本的隐私处理与去重；判分器自身要测（judge 漂移导致分数跳变） | 录制-回放（record/replay）基础设施；分层的评测环境（单元/轨迹/端到端/生产影子）；评测数据版本化 + 与生产 PII 治理一致；judge 版本固定 + 人工锚点集定期校验 | rubric | llm-rubric | 工程严谨性 |
| 端云协同与隐私（`agent-edge-cloud`） | 设备侧模型 + 云端大模型的分工（延迟/成本/隐私/离线可用性）；上云前的最小化与脱敏；端侧缓存与服务端记忆的一致性；敏感数据不落第三方（工具代理、可审计的模型端点） | "只在受信任执行环境/隔离云环境处理"的架构叙述（Apple 场景：设备优先 + 私密云计算的证明/透明度思路）；端侧意图识别 + 云端检索的混合流水线；差分隐私/联邦式改进（需按当期方案核实）；用户可见的数据用途说明与开关 | rubric | llm-rubric | 隐私优先架构 |
| 任务定义与评估闭环（`agent-product-loop`） | 从"能演示"到"能量化收益"：任务成功率、人工接管率、单位任务成本、省时（时间测量方法）；与业务 owner 共同定义可验证成功标准；失败模式分诊与修复优先级 | 上线前的价值假设与埋点设计；每周失败轨迹评审（分类 → 修工具/修提示/修检索）；把"人工修正"变成训练/评测数据（需合规）；agent 与自动化工作流边界（能用确定性流程解决的不上模型） | rubric | llm-rubric | 业务影响、跨职能协作 |

## 排课与出题建议

- 每周 1 个 `code`（`react-vitest`：工具参数解析/流式状态机/检索指标；`redis`：工具配额与预算；`java-junit`：编排状态机/重试预算）+ 1–2 个 `rubric` 架构题。
- `rubric` 题必须给出"可验证证据"要求（引用、trace、指标名），否则容易退化成"文笔评分"。
- 涉及具体模型/供应商能力的条目一律写成"以当期文档为准（需核实）"，避免版本幻觉。
- 专题文件：`context-engineering.md`、`tool-calling-and-mcp.md`、`agent-evals-and-regression.md`、`rag-and-retrieval-architecture.md`、`guardrails-cost-and-orchestration.md`。

## 语料文件

| 文件 | 讲什么 |
| --- | --- |
| [`agent-evals-and-regression.md`](./agent-evals-and-regression.md) | Agent 评测与回归：从"演示能跑"到"改十次不退化" |
| [`context-engineering.md`](./context-engineering.md) | 上下文工程（Context Engineering）：Agent 的"内存管理" |
| [`guardrails-cost-and-orchestration.md`](./guardrails-cost-and-orchestration.md) | 编排、成本与护栏：把 Agent 放到生产环境里跑 |
| [`rag-and-retrieval-architecture.md`](./rag-and-retrieval-architecture.md) | RAG 架构（2026 版）：检索质量、权限、结构化数据与证据链 |
| [`tool-calling-and-mcp.md`](./tool-calling-and-mcp.md) | 工具调用与 MCP：把 Agent 接到真实系统（2026 版） |
