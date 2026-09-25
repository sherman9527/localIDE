# hot-interviews 考点矩阵（Apple / Airbnb 高频真题方向）

> 出题前置输入。第 1 列格式 `中文考点名（`tag-id`）`，反引号内为题目 `tags` 用的 tag id；**每行必须标注来源公司与岗位方向**（requirement.txt 第 2 条：高频面试题需显示来源公司）。
> `可出题形式` ∈ `code` / `rubric`；`建议 judgeKind` ∈ `java-junit` / `react-vitest` / `mysql` / `redis` / `pyspark` / `llm-rubric`（Flink / Scala Spark 类一律 `llm-rubric`）。

## 面试风格（据公开经验帖与工程博客归纳，用于设定题面语气与追问链；具体到个人轮次会有差异）

- **Airbnb（数据/后端）**：四轮左右——coding（偏实用：字符串/哈希/区间/数据结构的真实处理，常带"数据清洗"味道）、SQL/建模（漏斗、留存、滚动窗口、口径追问）、技术/系统设计（marketplace、搜索、价格、实时管道，追问"你会怎么落地并证明它对"）、行为面（对简历项目做**长时间线性深挖**：为什么这么设计 → 失败与返工 → 数字与影响 → 你个人的贡献）。特色：追问链长、不接受"我们用了 X 所以没问题"；对"口径正确性"和"跨团队协作"异常敏感。
- **Apple（数据/后端）**：更看重**你亲手做过的系统的深度与规模数字**（每天多少事件、多大存储、多少成本、SLA 多少、故障怎么处理的），系统设计题常围绕"端 + 云"、遥测/日志管道、批处理与成本、隐私约束下的架构；coding 环节对数据工程岗偏向 SQL/Python 数据处理（清洗、去重、时间处理），对后端岗考并发/缓存/正确性更多；行为面强调 ownership、跨组织推动、对细节与用户体验的执着。
- 两家公司共有：都会用"追问到你说不出为止"的方式区分 senior 与 principal；principal 预期出现"你会拒绝做什么"与"组织级机制"的回答。
- 注：以上为常见公开分享的模式化概括，具体轮次、题目与流程因团队与时间不同（**以你面试时的官方说明为准**）。

## 考点矩阵

| 考点 | senior 深度要点 | 2025-2026 新实践 | 可出题形式 | 建议 judgeKind | JD 能力项 |
|---|---|---|---|---|---|
| 【Airbnb·数据/后端】搜索召回与排序系统（`airbnb-search-ranking`） | 多阶段（召回→粗排→精排→重排/打散）与延迟预算；时点正确特征（不能用未来信息）、离线 AUC 与线上 GMV/订书率不一致的排查；embedding 召回与稀疏特征共存 | 双塔/序列建模基座 + 实时特征（Airbnb 公开的 KDD'18 搜索 embedding、2025 年 embedding-based retrieval、以及 guest journey 序列建模方向如 JourneyFormer，具体论文/上线细节需核实）；LLM 用于意图理解与查询改写；向量索引服务化与新鲜度 SLA | rubric | llm-rubric | 与算法团队协作、特征与数据平台 |
| 【Airbnb·数据】价格一致性与 price grid（`airbnb-price-consistency`） | 展示价（每晚/总价含费）与下单价的一致性来源：缓存层级（搜索网格、日历可用性、费率）、失效与重算、时区/日切、税费与清洁费政策；"价格漂移"投诉的定位链路 | 总含税价展示政策与法规驱动改造（多地要求"无隐藏费用"）；把定价/税费计算做成可版本化的规则服务 + 影子计算对比；用一致性监控（同一 listing 多次查询结果方差）作为 SLO | rubric | llm-rubric | 业务关键系统、跨职能（法务/产品） |
| 【Airbnb·数据】滚动窗口/留存/漏斗 SQL（`airbnb-analytics-sql`） | 分母定义（新用户/回访）、帧边界与 tie-break、跨天去重不可加、事件重复与时序、除零与稀疏维度 | 用 `QUALIFY`/窗口帧语义（Spark 4.2 支持 `QUALIFY`）；近似去重（HLL）与预聚合中间态；语义层生成 SQL 保证口径 | code | mysql | 指标建模、与 BI/分析协作 |
| 【Airbnb·数据/ML】特征平台与时点正确性（`airbnb-feature-store`） | 训练-服务偏斜、point-in-time correctness、标签泄漏、在线缓存新鲜度与降级、回填成本与幂等 | 以特征定义为代码 + 批流双路生成同一份定义（Chronon 类，开源项目本身可引用）；embedding 类特征走"向量湖/索引 + 版本灰度"；特征级质量监控与漂移告警 | rubric | llm-rubric | ML 数据平台、实验支撑 |
| 【Airbnb·后端】库存与预订并发（`airbnb-booking-concurrency`） | 日期区间锁（而非行锁）与冲突检测、乐观并发 + 版本、部分占用/取消释放、防超卖的最后一步（确认时重校验）；幂等下单与重复提交；跨时区"一天"的定义 | 幂等键 + 意图化下单 API（202 + 状态查询）；用状态机 + 唯一约束取代分布式锁；热点 listing 的排队与公平调度 | code | redis | 交易一致性、用户体验 |
| 【Airbnb·数据】实时管道与新鲜度 SLA（`airbnb-realtime-pipeline`） | 端到端延迟分解（采集→总线→计算→服务→看板）；去重窗口与迟到；批流双跑对账作为放行判据；新鲜度用分位数而非均值 | Flink 2.x + 湖仓主键表（Iceberg v3 deletion vectors / Paimon）承载"可重算的实时层"；OLAP 服务层直读湖 vs 本地表权衡；质量规则与契约进 CI | rubric | llm-rubric | 实时数据平台、SLA ownership |
| 【Airbnb·数据/后端】实验平台与指标可信（`airbnb-experimentation`） | 分流单元与干扰（双边市场溢出/SUTVA）、SRM 检测与处置、CUPED/分层降方差、多重比较、指标口径与实验版本对齐 | 指标语义层与实验平台打通（口径变更自动标记不可比）；实时实验读数 + 自动停线；长短期指标权衡（代理指标有效性验证）；LLM 辅助读实验报告的风险（不得替代显著性判断） | rubric | llm-rubric | 实验基础设施、因果思维 |
| 【Airbnb·数据】双边市场供需与调度指标（`airbnb-marketplace-equilibrium`） | 库存错配（热门日期/地区）、价格作为出清手段的反馈延迟、平台佣金与卖家行为博弈；用哪些指标衡量"市场健康"（供给填充率、搜索无结果率、履约失败率） | 实时供需仪表盘 + 预测式补供给；仿真/沙盒评估策略变更（避免直接线上试错伤害另一侧）；用因果推断做政策评估（长周期 A/B 不可行时） | rubric | llm-rubric | 业务/数据科学协作 |
| 【Apple·数据】亿级设备遥测管道（`apple-telemetry-pipeline`） | 采样策略（可重算 vs 不可重算、head-based 陷阱）、schema 演进与向后兼容、端侧 buffering 与丢包、按 `device_id + ts` 的排序键设计、成本（写入/压缩/分层/保留期）与查询模式的耦合 | 湖仓 + OLAP 分层（明细留湖、服务层聚合）；列式与低基数编码、`LowCardinality`/字典化；用 Iceberg v3 row lineage 做回溯与校验；Spark 4.x CDC/`CHANGES` 与声明式管道降低回填成本 | code | pyspark | 大规模管道、成本与性能 |
| 【Apple·后端】推送与扇出（`apple-push-fanout`） | APNs 场景约束（payload 上限、优先级、`apns-collapse-id` 合并、配额与 throttling）、投递失败与令牌失效回收、幂等与重复推送的用户观感；离线补投与"最后一条为准" | 服务端折叠（同 conversation/topic 合并）、按用户活跃度分层扇出；事件总线队列语义（Kafka 4.2 share groups）承载扇出任务的重试与并发；到达率/时延分布作为 SLI | rubric | llm-rubric | 高并发服务、移动端协同 |
| 【Apple·数据/后端】隐私工程与端云协同（`apple-privacy-engineering`） | 数据最小化与分级、差分隐私的适用边界（计数/直方图 vs 明细查询）、联邦/端侧学习的工程代价、隐私预算与效用权衡；"能不能不上传"是首要架构问题 | 端侧优先 + 受证明的隔离云端环境处理敏感推理（Apple 的 Private Cloud Compute 思路：设备判定 + 专用云 + 透明性/可验证，细节以官方文档为准）；PSI/联系人发现类隐私集合求交及其攻击面（2025-11 曝出的 iMessage 联系人发现问题，说明"求交本身即攻击面"，细节需核实）；属性基授权 + 用途留痕 | rubric | llm-rubric | 隐私与安全设计 |
| 【Apple·后端】设备/账户认证与反滥用（`apple-device-integrity`） | Passkey/WebAuthn 规模化与恢复流程、DeviceCheck/App Attest 的能力边界（能证明设备真实性但不能替代授权）、重放与令牌受众校验、风控与服务端二次校验的关系 | Attestation + 短时窄 scope 凭证 + 行为风控三层；对 agent/自动化客户端的凭证治理（可撤销、审计）；无状态协议下的凭证与状态外置（呼应 MCP 2026-07-28 的 `iss` 校验要求） | code | java-junit | 安全、服务契约 |
| 【Apple·数据】批处理稳定性与 shuffle 架构（`apple-batch-scale`） | 为什么大规模 Spark 需要外置/远端 shuffle（抢占、弹性、失败放大）；倾斜与失败的分类治理；成本归因与卡口 | ESS/RocksDB 后端与 Magnet 元数据外置；远端 shuffle service（Apple 曾开源 Squab，Swift 实现，指标需核实；社区 Celeborn 类）；Spark 4.x 校验和 shuffle 重试与流式 RTM；作业级指标（shuffle bytes/spill）自动体检 | rubric | llm-rubric | 平台规模化、成本 ownership |
| 【Apple·数据】版本偏斜下的数据契约（`apple-client-schema-skew`） | 客户端 2–3 年不升级导致的事件 schema 长尾；字段语义漂移（改名/改单位/改时区）如何被发现；回填与重算策略；端上解析失败的降级 | 事件 schema 注册表 + 版本路由（同 topic 多版本共存并标注生效版本）；SDK 契约测试与灰度；用分布漂移检测代替"上线后有人反馈" | rubric | llm-rubric | 端云协同、数据治理 |
| 【两家·通用】简历项目深挖式行为面（`behavioral-deepdive`） | 用一条链路把你带过的系统问穿：目标 → 约束 → 备选方案 → 你的决定 → 数字结果 → 失败与返工 → 你个人的独特贡献 → 如果重做；principal 追加"你改变了团队的什么" | 用真实数字与可验证事实支撑（SLO、成本、延迟、故障时间线）；承认权衡与做错的地方（"没失败过"= 没做过难东西）；跨团队推动的具体机制（RFC、卡口、工具） | rubric | llm-rubric | 沟通、影响力、ownership |
| 【两家·通用】"你没做过但要怎么负责"题（`unknown-domain-reasoning`） | 面对陌生组件（如某新表格式/新调度器）的拆解路径：读什么、测什么、如何小流量验证、如何设回滚；明确说出未知与不确定（比编造版本号得分高） | 现场给出两周内可执行的验证方案（基线 + 压测 + 对照 + 判据）；引用 2026 现状但会标注不确定处（Spark 4.2、Flink 2.3、Iceberg v3、MCP 2026-07-28） | rubric | llm-rubric | 学习能力、技术判断 |
| 【两家·通用】事故复盘与可靠性叙事（`incident-story`） | 讲一个真实 P0/P1：时间线、定位方法（指标/日志/变更关联）、止血与根治、防复发卡口；能否量化 MTTR 改善 | 用 SLO/error budget 叙事；自动检测（不变量断言、对账）替代"用户上报"；演练与红队；把复盘产出写成可执行规则 | rubric | llm-rubric | 生产责任、复盘文化 |
| 【两家·通用】估算与"给数字"的肌肉记忆（`numbers-on-demand`） | 被问"多大、多贵、多快"时能现场推：QPS、日事件数、存储、成本量级，且给区间与假设；知道自己系统的三个关键数字 | 成本口径落到 `$/请求`、`$/TB`、`$/千 token`；用监控截图式的语言描述（"我们 p95 是 X，峰值系数 4.3"） | rubric | llm-rubric | 规模经验 |

## 排课与出题建议

- 30 天排课：每周 1 个 Airbnb 主题设计题 + 1 个 Apple 主题设计题 + 1 个 `code`（mysql / redis / pyspark / java-junit 轮换）+ 1 个行为面深挖题。
- 每题 `source.company` 必须填 `Apple` 或 `Airbnb`，`source.jds` 挂对应岗位 JD 片段与抓取时间；题面正文里显式写"你正在面试 <公司> <岗位> 的 <级别>"，追问链按上面"面试风格"设定。
- 专题文件：`airbnb-search-ranking.md`、`airbnb-marketplace-booking.md`、`apple-telemetry-pipelines.md`、`apple-privacy-and-edge-cloud.md`、`behavioral-technical-deepdive.md`。

## 语料文件

| 文件 | 讲什么 |
| --- | --- |
| [`airbnb-marketplace-booking.md`](./airbnb-marketplace-booking.md) | 【Airbnb】预订、库存与价格一致性（市场不出错的那一半） |
| [`airbnb-search-ranking.md`](./airbnb-search-ranking.md) | 【Airbnb】搜索与排序系统：从"召回一批 listing"到"改变成交分布" |
| [`alibaba-data-and-storage.md`](./alibaba-data-and-storage.md) | 【阿里巴巴】数据与存储：实时计算与湖仓、OLAP 选型、云原生数据库、指标口径与数据质量 |
| [`alibaba-frontend-and-open-source.md`](./alibaba-frontend-and-open-source.md) | 【阿里巴巴 / 蚂蚁】前端与开源栈：微前端沙箱与样式作用域、请求竞态与轮询、表单字段生命周期 |
| [`alibaba-transactions-and-middleware.md`](./alibaba-transactions-and-middleware.md) | 【阿里巴巴】交易链路与中间件：分布式事务、幂等、削峰填谷、限流熔断与分库分表 |
| [`apple-privacy-and-edge-cloud.md`](./apple-privacy-and-edge-cloud.md) | 【Apple】隐私工程与端云协同：把"少拿数据"变成架构能力 |
| [`apple-telemetry-pipelines.md`](./apple-telemetry-pipelines.md) | 【Apple】大规模遥测与数据管道：端上优先、成本敏感、隐私硬约束 |
| [`behavioral-technical-deepdive.md`](./behavioral-technical-deepdive.md) | 【Apple / Airbnb】行为面 = 技术深挖：追问链、信号与判分设计 |
| [`bytedance-backend-and-infrastructure.md`](./bytedance-backend-and-infrastructure.md) | 【字节跳动】服务端与基础架构：Go 微服务治理、扇出与降级、混部调度 |
| [`bytedance-data-and-recommendation.md`](./bytedance-data-and-recommendation.md) | 【字节跳动】数据与推荐链路：实时特征、埋点治理、OLAP 口径与实验分流 |
| [`pdd-data-and-recommendation.md`](./pdd-data-and-recommendation.md) | 【拼多多】数据 · 推荐 · 实时：官方承认"流量归因算不清"的平台，怎么把口径做可信 |
| [`pdd-transaction-and-inventory.md`](./pdd-transaction-and-inventory.md) | 【拼多多】交易 · 库存 · 营销：平台不持货、商家改库存、成团才算成交 |
