# 【拼多多】数据 · 推荐 · 实时：官方承认"流量归因算不清"的平台，怎么把口径做可信

来源公司：**拼多多（PDD / Temu）**｜岗位方向：数据研发（数仓/实时/指标平台）、数据平台（埋点与治理）、算法工程（推荐/广告/风控数据）
对应考点：`pdd-traffic-attribution`、`pdd-active-merchant-caliber`、`pdd-gmv-take-rate`、`pdd-order-fact-fields`、`pdd-sensitive-field-lineage`、`pdd-event-pipeline-lag`、`pdd-incremental-window`、`pdd-report-caliber-layers`、`pdd-anti-fraud-ranking`、`pdd-product-admission-model`、`pdd-regulatory-traceability`、`pdd-cross-border-data-partition`、`pdd-affiliate-attribution`、`pdd-revenue-recognition-timing`

> **证据分级（与姊妹篇 `pdd-transaction-and-inventory.md` 一致）**
> - **【源】**＝本次真正抓到的公开来源里就是这么写的（文末来源清单逐条对应 URL，编号 S1–S7）。
> - **【推】**＝由来源事实外推的架构结论／业界通用做法，**不得当引用**。
> - **本文不写**任何"拼多多推荐模型结构 / 特征平台 / 向量检索 / 实时时延"的说法——这些**没有任何可核查来源**（见 §7）。拼多多的"推荐"在可核查层面只剩三件事：*流量分发口径、排序被刷单污染、推荐系统被监管要求透明*。这三件事本身就够出题，而且区分度更高。
>
> **一个必须先接受的事实**：拼多多 2025 年报原文——
> "A portion of our buyer traffic comes from these **recommendations or product introductions that buyers share through social networks**. Due to the nature of our business model ... **it is impracticable for us to accurately bifurcate and quantify the buyer traffic generated directly through our platforms and through social networks.**"【源 S1】
> 也就是说，**"平台自有流量 vs 社交裂变流量"的二分，公司在上市文件里正式宣布做不到**。任何在这上面搭"渠道归因 GMV"的人，都是在给一个官方承认不可分的量硬加口径——这就是这家公司数据岗面试的真实底色。

---

## 1. 核心机制（面试里必须能画出来的链路）

```
端上/服务端事件 ──▶ 事件总线 ──▶ ODS（原始，不可变）──▶ DWD（明细，规范层）──▶ DWS/ADS（聚合、报表）
                      ▲                                        │
                      │                                        ├─▶ 对外：日账单 / 广告三层报表 / 多多进宝增量订单
  商家与外部系统的"事件"其实是 API：                            │
   · 订单增量：updated_at 切片、窗口 ≤30 分钟、必须倒序分页【源】◀┘ ← 这条约束同时是数据同步约束
   · 消息服务：pdd.pmc.user.permit / .cancel / .get / pdd.pmc.accrue.query（消息队列积压数量查询）【源】
   · 物流轨迹：pdd.logistics.isv.trace.notify.sub（ISV 物流轨迹推送消息订阅）、pdd.tail.express.trace.sync（末端三段轨迹回传）【源】
   · 货品主数据：ware_type（0 单独 / 1 组合 + 子货品关系）、长宽高(mm, 精确到 1)、体积(立方毫米, 只精确到 100)【源】
```

要点：

1. **"实时"的边界是官方写死的**【源】：外部事件进入平台/流出给 ISV 的通道带明确约束——时间窗口上限 30 分钟、单批上限 30 条（库存调整 `stock_move_record_action_dto_list`"一次传入 list size 不超过 30 个"）、`timestamp` 用**秒级** Unix 时间戳（注释还特意为北京时间补了 08:00 基准）【源 S4】。
   【推】这些约束决定了"分钟级微批 + 幂等重放"是常态，**真正的秒级实时只存在于平台内部**，对外一律是"带滞后的可靠投递"。senior 必答的问题变成：滞后的钱由谁付（赔付、发货时效判定、报表晚到）。
2. **积压是被官方承认的可观测指标**【源】：`pdd.pmc.accrue.query`＝"消息队列积压数量查询"，配套 `pdd.pmc.user.permit`（为已授权用户开通消息服务）/`.cancel`/`.get`【源 S4】。
   【推】既然 ISV 侧唯一能自助看的健康度就是 lag，平台侧就必须把"**订阅开通状态 + 积压 + 重试/死信 + 补推**"当成一等 SLI；真实事故通常是"订阅被取消后数据静默断流"，而不是队列炸了。
3. **订单事实表天然混着业务态，枚举是脏口径的第一来源**【源】：官方字段与枚举包括 `is_lucky_flag`（1 非抽奖订单 / 2 抽奖订单）、`mkt_biz_type`（0 普通订单 / 1 拼内购订单）、`group_status`（0 拼团中 / 1 已成团 / 2 团失败）、`confirm_status`（0 未成交 / 1 已成交 / 2 已取消）、`order_status`（增量接口里 1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部）、`risk_control_status`（0 正常 / 1 审核中）、`stock_out_handle_status`（-1 无 / 0 待处理 / 1 已处理）【源 S4】。
   注意 `order_status=5 全部`——**"筛选值"和"枚举值"混在同一列语义里**，这是"新增枚举把报表打穿"的教科书场景【推】。
4. **金额口径有官方公式，GMV 争议 80% 是口径争议**【源】：`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；`goods_amount = 商品销售价格 × 数量 − 订单改价折扣金额`；`discount_amount = 平台优惠 + 商家优惠 + 团长免单优惠金额`；`promotion_type=30`（以旧换新优惠）注释明确"**优惠金额已包含在平台优惠金额里**"；国补出资分型 `trade_in_national_subsidy_amount_type`（1 支付优惠 / 2 商家优惠）；另有 `duo_duo_pay_reduction`（多多支付立减）、`step_paid_fee/step_discount_amount`（定金/膨胀金）【源 S4】。
   收入侧口径也给了【源】："For transaction services, we earn fees from merchants for **sales of their products completed on our platforms**"；广告侧"matching product listings appearing in **search or browsing results**, charging merchants based on **impressions or clicks**, and providing display marketing ... at **fixed prices**"【源 S1】。
5. **指标定义要抄官方，不要自己发明**【源】：拼多多对"活跃商家"的定义原文——"merchant accounts that had **one or more orders shipped to a buyer** on our platforms in that period, **regardless of whether the buyer returns the merchandise or the merchant refunds the purchase price**"【源 S1】。
   这句话里有三个考点：① 触发事件是**已发货（shipped）**而不是支付或成交；② **不扣退款退货**；③ 主体是**账号（account）**而不是店铺/主体（同一个人开 3 个账号算 3 个）。
   再看公司自曝的反作弊风险："Fictitious transactions **may result in the inflation of our key metrics**"【源 S1】——**指标虚高是官方列出的风险项**，不是面试编的。
6. **收入确认时点与"补贴算谁的"有官方答案，是 GMV 争议的上游**【源】：2025 年报收入确认段写得很具体——
   广告收入"primarily recognized at a point in time when consumers **view or click on** the merchants' product listings **or over the period** during which the advertising services are provided, depending on the type of online marketing services selected"（**按展示/点击即时确认 vs 按服务期分摊，两种并存**）；
   交易服务收入"included fulfillment services to merchants, and earn related fees for **sales of the products completed** on our online platforms. **We do not control the products provided by merchants at any point in time during the transactions.**"（**官方明确"任何时点都不控制商品"**——这就是净收入/代理人处理的根据），且"recognized ... at a point in time when our service obligation ... is determined to have been completed"、"Variable consideration is estimated and included in the transaction price to the extent that it is probable that a significant revenue reversal will not occur"（**可变对价要预估并事后冲正**）；
   给消费者的补贴："we at our own discretion provide various forms of incentives ... including coupons, credits and **other subsidies that may or may not be specific to any merchant** ... at reduced prices **or to redeem for cash from us**. We record the incentives as **reductions of revenues** if they are considered as variable consideration or when there are **explicit contractual obligations to incentivize the consumers on behalf of the merchants** ... If ... not considered as payments to the merchant-customers, we record these incentives as **marketing expenses**."
   含义对数据岗极其具体【推】：**同一张券在报表上有三种落点（冲收入 / 代商家负债 / 市场费用）**，判据是"是否存在替商家履行的明示或默示义务"；所以"补贴口径"不是一个数，而是三个数（GMV 补贴、平台让利、财务收入抵减），把它们混成一个"补贴率"是最常见的口径事故。可提现（redeem for cash）与下单抵扣必须分属两套资产账户，否则出现套现通道。
7. **规模与成本的可核查锚点**【源】：FY2025 总收入 RMB 4318.46 亿元，其中"在线营销服务及其他" 2177.83 亿元（50.4%）、"交易服务" 2140.63 亿元（49.6%）【源 S1】；2026 Q1 分别为 499.36 / 562.93 亿元，同比 +20%（交易服务），公司把成本上升主因归为"**fulfilment fees、bandwidth and server costs、payment processing fees**"【源 S2】。
   【推】"带宽与服务器成本"被点名为主要成本项之一 ⇒ 这家公司的数据/推荐链路是真金白银的算力密集项，面试里"你会砍哪一刀成本"是有依据的必答题。
8. **敏感字段的"值"取决于状态与风控，不是取决于有无数据**【源】：`receiver_name/phone/address` 官方注释——"订单状态为待发货状态，**且订单未被风控打标的情况下返回密文数据；其余情况返回空字符串**"【源 S4】。
   【推】数仓侧最阴的坑：同一个字段有 **密文 / 空串 / 缺列** 三种表现，把空串做 join key 或 count(distinct) 会把"审核中单"统计成"地址缺失率上升"；正确做法是在 DWD 就把它拆成 `value` + `visibility_reason` 两列。
9. **模型能力只在"准入与类目/价格建议"这一层是可核查的**【源】：2025 年报："After merchants post product information on our platforms, we leverage **artificial intelligence-based screening system** to identify potential issues and subject questionable merchandise to **further review and verification**"；治理手段包括"**block noncompliant products prior to their launch**"（上架前拦截）【源 S1】；接口层也对得上——`pdd.goods.outer.cat.mapping.get`（**类目预测**）、`pdd.goods.advice.price.get`（**商品建议价格**）、`pdd.goods.latest.commit.status.get`（批量查**审核状态**）【源 S4】。
   即：**官方确认存在"事前模型 + 人工复核"的准入链路，但没有给任何模型结构、延迟或特征清单**——所以考点只能落在链路、指标与取舍上。
10. **监管已经把"数据可提取性"变成了硬要求**【源】：市场监管总局查处 7 家电商平台"幽灵外卖"系列案的执法纪实里，写明了三件事——
   ① 取证难点原话："**数据量大、取证难、固定难、核验难**……电商平台的业务数据不仅数量庞大，而且**存储分散，一般都是在云端**"，需要平台技术人员"从云端现场调取数据"【源 S5】；
   ② 平台第一次交出的数据是"整体数据 **1/3、1/4 甚至更少**"、"**碎片化、格式混乱**"，执法方反过来建自己的库（"数据共性、数据比对、**交叉核验、溯源倒查**"）逼平台补齐到 100%【源 S5】；
   ③ 办案方"反复研究平台**数据架构、交易流程及算法逻辑**"才完成对"**订单流转、资质备案、转单交易**"三类关键电子数据的提取、分类梳理与固化【源 S5】。
   加上"查实 **67604 家**幽灵店铺""**不能批量化认定，6 万多个具体案件每一家店情况都不一样**""一店一处罚"【源 S5】——这三条合起来就是"**留痕、可导出、可逐单举证**"的合规级需求，而不是工程偏好。
11. **数据出境与多地域是架构前提，不是扩展项**【源】：2025 年报披露"Our servers are hosted in internet data centers in different geographic regions and countries around the world, including Europe, the U.S. ..."，同时列出：PIPL/CII 要求"在境内运营中收集 and 产生的重要数据须存境内"、"持有超过 100 万用户个人信息的网络平台运营者赴国外上市须申报网络安全审查"；欧盟侧 DSA 对 Temu 的要求覆盖"**traceability of merchants/business users**"和"enhanced transparency measures including in relation to **any recommendation systems**"【源 S1】。
    2024-10 欧盟委员会对 Temu 启动正式调查（涉及非法商品、界面设计、**推荐系统**、**researcher data access**），2025-07 初步认定其违反 DSA **第 34 条风险评估义务**，罚款上限为全球年营业额 6%【源 S1】。
    【推】因此"推荐特征/日志"天然分成两堆：**能被要求交出去的（决策依据、曝光-点击-成交链路、风险评估证据）**和**不能出境的（境内主体数据）**。数据平台的分区、脱敏、可重放能力在这里变成合规件。

---

## 2. 会被追问什么（拼多多风格：先问定义，再问你怎么证明）

1. "你们'活跃商家'怎么算？"（期待直接引官方定义的三个细节，并说清为什么"不扣退款"是刻意选择——它服务的是供给侧健康度而不是成交质量；你若答"按支付商家数"会被追问"那和财报口径差多少"）
2. "GMV 涨 20%，交易服务收入只涨 12%，给我三种解释路径。"（take rate 结构变化 / 品类与优惠出资结构（平台券、国补、支付立减不由商家出）/ 退款与取消在"已发货"口径下的滞后回冲）
3. "刷单把销量与搜索排序污染了，你的指标怎么自证可信？"（官方原话是刷单会 "artificially inflate their sales records and **search results rankings**"，且承认 "may result in the inflation of our key metrics" ⇒ 必须给出"去噪口径"与"原始口径"双轨、以及去噪规则的召回率评估方法）
4. "`receiver_phone` 空串比例一周涨 40%，你怎么定位？"（先分辨是 `risk_control_status=1` 变多、还是状态分布变化、还是上游真的没传；要求把"可见性"建成独立字段，否则永远查不清）
5. "ISV 说没收到消息，你先看什么？"（`pdd.pmc.accrue.query` 的积压值 + 订阅是否被 `.cancel` + 消费者侧死信/补推；顺带说清"平台推送成功"和"ISV 处理成功"是两个 SLA）
6. "30 分钟窗口的增量任务，某天上游把 updated_at 写成未来时间，你怎么办？"（水位线不能简单推进；要"未来时间隔离区 + 不参与推进 + 告警"，并说明为什么不能直接丢弃）
7. "广告小时报表和分天报表对不上，你站哪一边？"（先答"谁是一次真相 + 晚到回补窗口"，再答"不回溯的口径变更必须显式公告并冻结可比区间"）
8. "上架前 AI 拦截，召回率提到 99% 会怎样？"（误杀量 = 商家申诉量 = 人工复核队列；要能给出"拦截准确率 × 人工产能"的容量方程，以及灰度期给新商家的豁免策略）
9. "监管来取证，你需要多久能把一个店铺的'订单流转 + 资质备案 + 转单'三张链条交出去？"（这题实际在问血缘与留痕。答案要具体：导出契约、字段版本、不可抵赖的操作审计、按主体/时间范围的最小闭包查询）
10. "Temu 与主站的数据要不要分仓？"（先承认抓不到内部实现【推】，再从合规义务推：境内 CII/PIPL 本地化 + DSA 透明度/研究者可访问 ⇒ 分区 + 统一指标层 + 不出境的派生特征）
11. "如果只能保留一张中间表支撑 80% 分析需求，你留哪张？"（期待"订单事实 + 优惠分摊明细 + 状态时间戳"这种能重算的粒度，而不是聚合报表）

---

## 3. 常见错误答案（背题型信号）

| 错误 | 暴露点 |
|---|---|
| "推荐我们用了双塔 + ANN + 序列模型" | 拼多多的推荐实现无任何可核查来源；在面试里编细节会被追问到死，且这家公司风格是"你先把口径说清" |
| 把 GMV 定义成"支付金额"就完事 | 官方成交判定是"已发货"，且 `pay_amount` 含邮费与服务费；漏这两点等于不懂口径 |
| 认为"活跃商家不扣退款"是 bug | 那是刻意定义；不懂供给侧指标与成交指标的分工 |
| "刷单我们风控管，与数据无关" | 官方明确说虚高的是"key metrics"——指标可信本身就是数据职责 |
| 敏感字段用 `IS NULL` 判断 | 官方语义有"密文/空串/无"三态，空串不是缺失 |
| 空想一个"实时链路延迟 200ms" | 官方与文档里没有任何链路延迟数字；数字必须标为假设并给测量方法 |
| "报表对不上就看谁跑错了" | 说不清一次真相层、晚到回补策略、口径变更冻结期 |
| 数据出境只说"我们合规了" | DSA 要求的是**风险评估 + 推荐透明 + 研究者数据访问**，这是可交付物，不是状态 |
| 留痕=日志留 30 天 | "一店一处罚"的举证要求是逐单可复原；30 天滚动日志在监管取证时等于没有 |

---

## 4. 考点清单（14 条）

> **judgeKind 约定**：标 `code` 的条目已显式写出 `judgeKind`（`mysql` / `pyspark` / `redis` / `java-junit`）；**只标 `rubric` 的条目一律 `judgeKind=llm-rubric`**（含所有 Flink / Scala Spark 类追问，按仓库约定不单独开 scala 判题）。`react-vitest` 在本文中刻意不使用——拼多多的前端与内部计算栈没有任何可核查出处，写出来就是编（见 §7）。

> 每条：考点名（tag）｜senior 深度要点（机制与取舍）｜可出题形式｜建议 judgeKind｜证据锚点

1. **流量归因的不可分性与增量性实验**（`pdd-traffic-attribution`）
   要点：官方承认"平台直投 vs 社交分享"流量不可二分【源】，因此渠道 GMV/渠道 ROI 只能建在**代理指标**上——【推】可核查立场是"要么用准实验（分人群/分时段投放开关 + 增量成交），要么承认它是份额近似而不是因果"；要能说清"分享链接带来的成交"与"没有分享也会成交"的差；社交裂变还会自我放大（被分享者变成新分享者），所以实验单元不能是"用户"，至少是"社交簇/地域网格"。
   出题：rubric（归因体系 + 增量性实验设计）；code（`judgeKind=mysql`：分享链路还原"首次触达 vs 最后触达"两套口径并比较差异）。
   锚点：【源 S1（impracticable 原文）】＋【推（实验设计）】。
2. **官方指标定义与口径卡**（`pdd-active-merchant-caliber`）
   要点：能引用"active merchants = 有 ≥1 单**已发货**的商家账号，**不扣退款/退货**"【源】；三个易错细节（事件=shipped / 不扣退 / 主体=账号）；指标卡必须写"触发事件、去重主体、时间归属、是否回溯、排除集"；供给侧指标与成交侧指标不能互相换算（一个不扣退款，一个扣）。
   出题：code（`judgeKind=mysql`：按定义算活跃商家，用例含"发货后全额退款""同主体多账号""窗口边界跨天"）；rubric（语义层强制：所有对外指标必须来自口径卡）。
   锚点：【源 S1】。
3. **GMV / take rate / 收入三层对齐**（`pdd-gmv-take-rate`）
   要点：三层各自的组成——成交层（`pay_amount` 含邮费与服务费、优惠三种出资方）、收入层（交易服务佣金按"平台上完成的成交"计 + 广告按曝光/点击/固定价三类计费【源】）、报表层（广告小时/分天/分级三套）；FY2025 与 Q1'26 的真实数字（50.4% vs 49.6%）可作题面锚点【源 S1/S2】；"GMV 涨、收入不涨"的定位路径：take rate 结构、平台出资比例、退款回冲滞后。
   出题：code（`judgeKind=mysql`：从订单还原成交/结算/收入三列，含 `promotion_type=30` 已包含项与国补出资分型）；rubric（指标体系分层）。
   锚点：【源 S1】【源 S2】【源 S4】。
4. **订单事实表的枚举治理**（`pdd-order-fact-fields`）
   要点：混态枚举清单（抽奖单、拼内购、团状态、成交状态、风控审核、缺货处理、发货状态，且"5=全部"这种筛选值语义）【源】；新增枚举是静默事故（默认 `ELSE` 分支吞掉新类型 ⇒ 报表悄悄偏）；防线＝枚举字典版本化 + "未知值必须显式落到 `unmapped` 桶并告警" + 填充率/占比突变监控；维度一致性：订单粒度 vs SKU 行粒度 vs 包裹粒度不能混用一张事实表。
   出题：code（`judgeKind=mysql`：占比突变检测 + 未知枚举隔离）；rubric（枚举契约与上线卡口）。
   锚点：【源 S4】＋【推（治理机制）】。
5. **敏感字段可见性的血缘建模**（`pdd-sensitive-field-lineage`）
   要点：`receiver_*` 三态语义（密文/空串/无）由"订单状态 + 风控打标"共同决定【源】；正解是把"值"和"为什么看不见"拆成两列，并在 DWD 定型；下游派生（地址缺失率、区域分析、履约画像）必须引用可见性列而不是猜；【推】密文字段的"能否解密"要作为字段级权限与用途留痕，解密动作本身是审计对象；再往外一层，接口返回字段随状态变化意味着**ETL 的 schema 稳定性 ≠ 语义稳定性**。
   出题：rubric（字段级权限 + 可见性建模 + 审计）；code（`judgeKind=java-junit`：可见性判定函数的状态组合覆盖）。
   锚点：【源 S4】＋【推】。
6. **事件链路的滞后与积压 SLI**（`pdd-event-pipeline-lag`）
   要点：官方把"消息队列积压数量查询"作为自助能力给 ISV（`pdd.pmc.accrue.query`）【源】，并存在订阅生命周期 API（permit/cancel/get）⇒ 静默断流是首要故障模式；物流侧另有"轨迹推送订阅 + 末端三段轨迹回传"，事件与运单/订单是多对多且会**状态回退**（取消、拦截、改派）【源】；SLI 应是"端到端延迟分位数 + 完整度（应到 vs 实到）+ 乱序率"，而不是均值延迟；补推/重放必须幂等（事件键 = 主体 + 事件类型 + 业务时间 + 版本）。
   出题：code（`judgeKind=redis`：有界窗口去重 + 幂等重放 + 积压水位触发降级）；rubric（新鲜度与完整度作为放行判据）。
   锚点：【源 S4】＋【推（SLI 设计）】。
7. **微批窗口与水位线（把官方约束当题面）**（`pdd-incremental-window`）
   要点：窗口 ≤30 分钟 + 按 `updated_at` + 必须倒序分页【源】；水位线设计要含安全滞后与重叠窗口；晚到/更新回写导致行进出窗口；用"按成交时间全量集合差集"做周期性反证（漏单率作为一等 SLI）；【推】真实调度还要处理"窗口分片倾斜"（大商家单窗口几十万行 → 按商家维度二次分桶）。
   出题：code（`judgeKind=mysql`：给连续 3 次快照，输出漏单/重单/错窗分类）；pyspark 版可改成"窗口合并与幂等覆盖"。
   锚点：【源 S4】。
8. **报表分层与晚到回补（广告口径）**（`pdd-report-caliber-layers`）
   要点：官方存在 hourly / daily / entity（分级）/ tr（全站推广，小时与分天）多套报表接口【源】；必须先声明"谁是一次真相"，其余是投影；晚到回补窗口要显式（例如"回补 N 天，超过不回溯"）；不回溯的口径变更必须公告 + 冻结可比区间（否则同比环比全废）；广告计费三态（曝光/点击/固定价）与交易成交不是一套事件，归因跨层时最容易双计。
   出题：code（`judgeKind=pyspark`：小时表 → 分天表重算 + 差异分类（晚到/回补/口径变更/丢数））；rubric（口径变更协议）。
   锚点：【源 S4】【源 S1】＋【推（回补协议）】。
9. **刷单 → 排序污染 → 指标虚高**（`pdd-anti-fraud-ranking`）
   要点：官方把两件事写在同一页：商家"engage in **fictitious transactions** ... to artificially inflate their **sales records and search results rankings**"，以及"Fictitious transactions may result in the **inflation of our key metrics**"【源】⇒ 反作弊不是风控一个团队的事，指标本身要能"去噪重算"。
   深度要点：原始口径与去噪口径必须双轨且可解释（否则没人信去噪数）；去噪规则的评估是"命中率 + 误伤率"，误伤会直接惩罚真实增长（新商家爆单最像刷单）；排序反馈回路——刷单收益来自排序位，所以"排序位对异常信号的敏感度"本身就是被攻击面；【推】交易/物流/资金三角是最硬的反作弊交叉验证（有单无货、有货无款、款项来源集中）。
   出题：rubric（双轨指标 + 去噪评估 + 反馈回路治理）；code（`judgeKind=mysql`：账号/收货/支付多信号聚集检测，给出精确率召回率分母）。
   锚点：【源 S1】＋【推（双轨与评估方法）】。
10. **准入模型的数据链路与人工复核容量**（`pdd-product-admission-model`）
    要点：官方事实＝"AI-based screening system" + "further review and verification" + "block ... prior to their launch"【源】，且平台确有类目预测/建议价/审核状态接口【源】；数据职责是把"商品提交 → 预测/规则 → 模型分 → 复核队列 → 通过/驳回/下架"全链路留痕（每条决策可复算到当时特征版本）；召回率与人工产能是同一个方程（提召回 ⇒ 误杀量上升 ⇒ 商家申诉）；冷启动新品类会让类目预测错分，需要有"错放率"独立指标；【推】模型升级必须影子跑并输出"决策差异清单"，因为拦截动作对商家是真金白银。
    出题：rubric（准入链路指标体系与容量方程）；code（`judgeKind=pyspark`：审核结果表 + 模型版本 → 复算漂移与差异清单）。
    锚点：【源 S1】【源 S4】＋【推】。
11. **监管级可追溯性（留痕、导出契约、逐单举证）**（`pdd-regulatory-traceability`）
    要点：三条硬事实——执法方要求"订单流转、资质备案、转单交易"三类电子数据的精准提取与固化【源 S5】；平台第一次只能交出"1/3、1/4"且"碎片化、格式混乱"的数据，于是被反向交叉核验【源 S5】；处理是"**一店一处罚**"、"6 万多个具体案件不能批量化认定"【源 S5】，以及"平台若无法向消费者提供商户真实姓名、地址、有效联系方式可能需先行赔付"（20-F 对中国消保责任的描述）【源 S1】。
    结论【推】：数据平台的交付物要包含"按主体 + 时间范围的最小闭包导出包"（含血缘、字段版本、抽取时间、哈希清单）与"操作审计不可抵赖（含内部审核人员，案文里明确出现'平台内部审核人员相互勾连'）"；指标层面要有"可举证覆盖率"。
    出题：rubric（留痕与导出契约 + 审计设计）；code（`judgeKind=mysql`：把订单-资质-面单三表串成一店一条链并输出缺口）。
    锚点：【源 S1】【源 S5】。
12. **多地域与跨境分区（合规驱动的数仓架构）**（`pdd-cross-border-data-partition`）
    要点：官方事实——服务器分布于包括欧洲、美国在内的多地域 IDC【源】；PIPL/CII 要求境内收集产生的重要数据存境内、持 >100 万用户个人信息赴外上市须网络安全审查【源】；欧盟对 Temu 的 DSA 义务含商户可追溯、推荐系统透明与研究者数据访问，初步认定违反 Art.34 风险评估，罚款上限全球营业额 6%【源 S1】；另有 EU AI Act 分级合规【源】。
    【推】架构结论：分区不是"两套数仓"，而是"**指标定义一份、物理数据各留本地、派生聚合层跨区、决策证据可导出**"；风险评估是**可交付物**（风险登记、缓解措施、独立审计），所以日志/曝光链路的保留期要按合规而不是按成本定。
    出题：rubric（分区架构 + 合规交付物清单）；短题（"监管要求你解释'为什么这件商品被推给这个人'，你 48 小时内交什么"）。
    锚点：【源 S1】＋【推（架构结论）】。
13. **联盟（多多进宝）归因与佣金对账**（`pdd-affiliate-attribution`）
    要点：官方接口把 CPS 链路完整地暴露成数据对象——推广位生成与媒体绑定（`pdd.ddk.goods.pid.generate`、`pdd.ddk.pid.mediaid.bind`）、推广链接与资源位生成（`pdd.ddk.goods.promotion.url.generate`、`pdd.ddk.resource.url.gen`、`pdd.ddk.cms.prom.url.generate`）、**短链反解**（`pdd.ddk.url.short.parse`）、商品推荐与搜索（`pdd.ddk.goods.recommend.get`、`pdd.ddk.goods.search`）、**增量订单 / 区间订单 / 订单详情**（`pdd.ddk.order.list.increment.get`、`pdd.ddk.order.list.range.get`、`pdd.ddk.order.detail.get`）、统计与账单（`pdd.ddk.statistics.data.query`；账单侧 SDK 里存在 `GetDdkAppNewBillList` 请求/响应模型类，**我只核到类名、未核到方法名**，出题时不要写死方法串）、**礼金**（`pdd.ddk.cashgift.create / .status.update / .data.query`）、活动清单（`pdd.ddk.tmc.activity.list`）【源 S4】。
    深度要点：归因窗口与"增量/区间两套拉取"并存 ⇒ 双计与漏计同时存在，必须定"最后点击 vs 首次触达"的选择依据；佣金口径要挂在**退款/取消之后**的状态（而活跃商家定义挂在已发货之前【源 S1】——两个指标时间锚点天然不同，直接对比就是错的）；防作弊重点：自购返利、链接劫持、PID 冒用；礼金是资金池，需要"发放-核销-过期"三账平衡。
    出题：code（`judgeKind=mysql`：点击日志 + 增量订单 + 区间订单三表，还原归因冲突行并去双计）；rubric（佣金与退款回冲、防作弊分层）。
    锚点：【源 S4】【源 S1】。
14. **收入确认时点与可变对价（数据岗要能读懂审计口径）**（`pdd-revenue-recognition-timing`）
    要点：广告收入是**两种确认模式并存**——"at a point in time when consumers view or click on the merchants' product listings **or over the period** during which the advertising services are provided, depending on the type"【源 S1】，即"曝光/点击即时确认"与"服务期分摊"混在同一个收入线里，任何"广告 ARPU/千次收入"指标都必须先声明属于哪一类；交易服务收入在"service obligation 完成时点"确认，并且官方明确"**We do not control the products provided by merchants at any point in time during the transactions.**"【源 S1】——这是净额/代理人处理的根据，也是"平台报表收入 ≪ GMV"的制度原因；可变对价"estimated and included in the transaction price to the extent that it is probable that a significant revenue reversal will not occur"，并披露"prior reporting periods 的调整不重大"【源 S1】⇒【推】报表数带**预估成分**，数据平台若只存终值、不存"预估时点快照"，历史就永远无法复算（审计追溯断裂）。
    再叠一层：消费者 incentives 有**三种账务落点**（reductions of revenues / 替商家履行的义务 / marketing expenses），判据是"是否存在明示或默示的替商家义务"，且部分可"redeem for cash from us"【源 S1】⇒ 指标语义层必须把"券"建成带出资方与义务性质的对象，而不是一句 `coupon_amount`。
    出题：rubric（指标语义层 → 财务科目映射 + 预估快照与冲正的可复算设计）；code（`judgeKind=mysql`：同一批点击与订单分别算"曝光/点击类收入、分摊类收入、GMV、净成交"四列并解释两两差异来源）。
    锚点：【源 S1】＋【推（预估快照/语义层落地）】。

---

## 5. 出题角度

### 题面草稿 A（`code`，`judgeKind=mysql`）—— "一个数字三种答案"
> 表：`orders(order_sn, merchant_account_id, pay_time, shipped_time, confirm_status, group_status, is_lucky_flag, mkt_biz_type, risk_control_status, pay_amount, post_amount, service_fee, platform_discount, seller_discount, capital_free_discount, trade_in_national_subsidy_amount, trade_in_national_subsidy_amount_type)`；`order_refund(order_sn, refund_amount, refund_time)`；`click_log(order_sn, pid, media_id, click_time, is_self_purchase)`；`bill_daily(bill_date, order_sn, settle_amount, fee_amount)`。
> 字段语义按拼多多开放平台官方文档（`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；`promotion_type=30` 的以旧换新优惠**已包含在平台优惠金额里**；`is_lucky_flag=2` 为抽奖订单；`mkt_biz_type=1` 为拼内购订单；`confirm_status` 0/1/2；`group_status` 0/1/2）。
> 要求：
> 1) 按**官方"活跃商家"定义**（周期内 ≥1 单 `shipped_time` 非空，**不扣退款**，主体为 `merchant_account_id`）计算周活跃商家数；另给"扣除全额退款后"的版本，并输出两者差值；
> 2) 输出四列成交金额口径并各自写明分母：`支付口径`、`商品口径`（剔除 `post_amount` 与 `service_fee`）、`平台让利`（正确处理"已包含"项与 `trade_in_national_subsidy_amount_type=1` 的支付渠道出资）、`可结算口径`（只算 `confirm_status=1 AND group_status=1`）；
> 3) 与 `bill_daily` 对账：找出"订单侧有、账单侧无"的订单并分类为「未过结算账期 / 已退款冲销 / 风控审核中(`risk_control_status=1`) / 真差异」四类，每类给出可重跑的判定条件；
> 4) 联盟归因双计检测：同一 `order_sn` 被多个 `pid` 触达时，输出"首次触达"与"最后触达"两种归因结果，并统计两者佣金差异 Top 10 媒体；同时排除 `is_self_purchase=1`。
> 用例：抽奖单、拼内购单、团失败已支付、同主体多账号、退款时间跨周、账单延迟 3 天、审核中单、同一订单两跳点击。
> 区分度：第 1 问是否真按"已发货 + 不扣退款 + 账号主体"三条落地；第 2 问有没有把邮费/服务费剥出来；第 4 问是否主动声明两套归因的选择依据。

### 题面草稿 B（`rubric`，10 分制，主推）
> **你正在面试拼多多 数据研发（指标与数据平台方向）的 Senior，50 分钟**
> 已知事实（不要质疑出处，全部可核查）：① 公司在年报中承认"平台内流量与社交分享流量无法准确二分"；② "活跃商家"定义为"周期内有 ≥1 单已发货的商家账号，不论是否退货退款"；③ 公司自列风险包含"虚假交易可能导致我们的**关键指标被虚高**"，且虚假交易的目的是抬高"销量与**搜索结果排名**"；④ 对外数据通道有硬约束：订单增量按最后更新时间、单次窗口 ≤30 分钟、必须倒序分页；消息服务提供"队列积压数量查询"；⑤ 成本侧官方点名"履约费、带宽与服务器成本、支付手续费"为主要上升项；⑥ 监管侧：4 月平台因"未依法履行资质审查义务、对转单行为未采取措施"被处约 15 亿元罚款并被暂停某品类新增入驻九个月，执法取证依赖对"订单流转、资质备案、转单交易"电子数据的提取与交叉核验。
> 请给出：① 一套"成交—供给—营销"三层指标体系（含每层一次真表、时间锚点、是否回溯、排除集），并明确哪个指标必须与财报口径对齐；② 在"流量归因不可分"的前提下，你**保留**哪个归因口径、**放弃**哪个，以及用什么准实验给出增量证据；③ 反作弊与指标可信的关系：如何提供"原始/去噪"双轨指标并让业务接受去噪数；④ 事件与报表的新鲜度-完整度体系：SLI 定义、放行判据、晚到回补协议、口径变更冻结期；⑤ 成本三刀（明确砍什么、代价是什么、怎么度量）；⑥ 若监管/内审要在 48 小时内取"某一店铺某一时段全部交易与审核链条"，你的交付物长什么样（含不可抵赖要求）；⑦ 一条你会主动拒绝做的报表，并说明理由。
> **加分点**：把"已发货不扣退款"解释成供给侧健康度的刻意选择，并指出与结算/佣金指标时间锚点必然不同；用"倒序分页防漏单 + 全量差集反证"给出可证明的漏单率 SLI；成本一刀能落到"高频维度组合的物化裁剪 + 按真实查询模式设计排序键"，并给出验证方法（查询命中分布、重算成本对比）；主动指出敏感字段三态会让"缺失率"指标失真并给修法；用"一店一处罚 ⇒ 逐单可举证"论证保留期与导出契约；第 7 条真的拒绝了一件无增量证据的口径包装。
> **不足点**：堆模型/组件名词（Flink/ClickHouse 等）却答不出口径；把"去噪指标"做成黑盒；把漏单说成"不可能发生"；把跨境与推荐透明当法务的事；成本只说"下线老任务"；48 小时交付物答成"导个 Excel"。

### 题面草稿 C（`rubric`，短题，10 分钟）
> "某天开始，'地址缺失率'从 2% 涨到 40%，同时'待发货超时率'略微下降。业务方怀疑采集坏了。请给出你的定位顺序与三种可能结论。"
> 期望：先想到**可见性语义**（官方：收件人字段仅在"待发货且未被风控打标"时返回密文，其余返回空串【源 S4】）⇒ 缺失率其实是"审核中/状态分布变化"的投影；核对 `risk_control_status=1` 占比、订单状态分布、字段返回比例；再区分"ETL 丢字段 / 上游真的不传 / 可见性策略变化"，并给出修法：把值与可见性原因拆列，禁止用空串算缺失。

---

## 6. 来源清单（全部于 **2026-09-23** 实际抓取并确认页面内容）

| # | URL | 标题 | 访问日期 | 支撑了上面哪几条考点 |
|---|---|---|---|---|
| S1 | https://www.sec.gov/Archives/edgar/data/1737806/000110465926050727/pdd-20251231x20f.htm | PDD Holdings Inc. Form 20-F（FY2025，2026-04-29 提交） | 2026-09-23 | 核心机制 4/5/6/7/9/10/11；考点 1（流量不可二分原文）、2（active merchants 定义原文）、3（收入两类与三种计费口径 + FY2025 收入结构数字）、9（虚假交易抬高销量与搜索排序、关键指标虚高）、10（AI 准入筛查与上架前拦截）、11（商户身份信息提供义务）、12（多地域 IDC、PIPL/CII 本地化、网安审查、DSA Art.34 与 6% 上限、EU AI Act）、14（收入确认段：view/click 即时 vs 按服务期分摊、"We do not control the products ... at any point in time"、可变对价预估与冲正、消费者 incentives 记作收入抵减或市场费用、"10 Billion Agriculture Initiative"）；题面草稿 B 的六条"已知事实" |
| S2 | https://www.sec.gov/Archives/edgar/data/1737806/000110465926067186/tm2615739d1_ex99-1.htm | PDD Holdings 2026 年第一季度未经审计财务业绩（6-K 附件 Ex 99.1，2026-05-28） | 2026-09-23 | 核心机制 6；考点 3（Q1'26 分收入线数字）、5/成本三刀依据（fulfilment fees、bandwidth and server costs、payment processing fees 被点名为成本上升主因）；两任联席 CEO 关于供应链投入与"first-party brand business"的表述（用于组织导向，不作为技术事实） |
| S4 | https://github.com/niltor/open-pdd-net-sdk （`dev` 分支，最后提交 2026-03-30；重点：`Services/PddApi/{DdkApi,AdApi,PmcApi,FdsApi,LogisticsApi,GoodsApi,OrderApi,FinanceApi}.cs`、`Models/Request/Order/GetOrderNumberListIncrement.cs`、`Models/Request/Stock/MoveStockWare.cs`、`Models/Response/Order/GetOrderListResponse.cs`、`Services/PddCommonApi.cs`） | 拼多多开放平台 DotNet SDK（社区维护，接口名与中文注释逐条对应官方文档） | 2026-09-23 | 核心机制 1/2/3/4/7；考点 3、4、5、6、7、8、13（全部 `pdd.*` 接口名、参数字段、中文枚举语义、30 分钟窗口与倒序分页、批量 ≤30、秒级时间戳、消息积压查询、联盟订单/推广位/账单/礼金接口族）；题面草稿 A/C 的字段依据 |
| S5 | https://scjg.ln.gov.cn/scjdglj/xw/mtbd/2026042016201794829/index.shtml | 《中国质量报》：市场监管总局依法查处 7 家电商平台"幽灵外卖"系列案纪实（辽宁省市场监督管理局转载，2026-04-20） | 2026-09-23 | 核心机制 9；考点 11（云端分散存储的取证难度、"1/3、1/4"折扣数据与"碎片化、格式混乱"、"订单流转/资质备案/转单交易"提取、交叉核验与溯源倒查、一店一处罚不能批量认定、内部审核人员勾连）、6（"每个手机号限定登录查看次数"说明账号级频控存在）；题面草稿 B 事实 ⑥ |
| S3 | https://www.pinduoduo.com/home/seckill/ | 拼多多官网专题页（含消费者承诺列表：全场包邮、7 天退换、假一赔十、48 小时发货） | 2026-09-23 | 考点 2/3 的"发货"时间锚点与履约时效指标的业务依据（48 小时发货承诺） |
| S6 | https://www.career.zju.edu.cn/jyxt/sczp/zpztgl/ckZpgwXq.zf?zpxxbh=3EB974916D1FDD49E0653A68DD0E9B18 | 浙大就业网转载：拼多多集团（上海寻梦信息技术有限公司）服务端研发工程师 26 届秋招 JD | 2026-09-23 | 仅作组织/岗位导向参考：JD 强调"高并发、高流量和分布式环境下的性能和稳定性""熟悉常用的存储系统和中间件"。**未**抓到数据岗 JD 正文，故本文件不引用"数据岗 JD 关键词" |
| S7 | https://api.github.com/orgs/pinduoduo/repos | 拼多多官方 GitHub 组织仓库列表（仅 1 个 `recruitment` 仓库） | 2026-09-23 | §7 第 1 条的证据：官方开源为零，因此本文不出现任何"拼多多自研开源数据组件"的断言 |

---

## 7. 未核实而放弃的方向（这些**不能**写进题面）

1. **推荐/搜索系统的内部实现**：召回结构、双塔/序列模型、向量索引、特征平台、实时特征时延——拼多多没有公开过任何一篇工程博客、会议论文或开源实现（官方 GitHub 组织只有 `recruitment` 仓库【源 S7】）。本文对"推荐"的全部可核查表述只有三句：流量不可二分【S1】、虚假交易抬高搜索结果排名【S1】、欧盟要求推荐系统透明与风险评估【S1】。
2. **数据栈选型**（Flink/Spark/Kafka/ClickHouse/Doris/Paimon 等是否在用、版本、规模）：无任何官方来源，一律不写；需要问栈就用"字段与口径 + 约束（30 分钟窗口、批量 30、秒级时间戳、积压查询）"来出。
3. **量级数字**：日事件数、日订单量、数仓存储量、任务数、QPS、p99 延迟、成本金额——财报与官网都没给；引用网传数字（含各类"拼多多日订单 X 亿"贴）不成立。题面数字必须显式标注为假设并说明如何验证。
4. **"百亿补贴"这个营销 IP 的规则**：2025 年报里没有"Ten Billion Subsidy / 百亿补贴"这一名称（检索 `Ten Billion` 与 `Billion Subsidy` 均 0 命中；唯一以"10 Billion"命名的是 2021 年 8 月的 **"10 Billion Agriculture Initiative"（百亿农研专项）**，原文注明 "not driven by profit or commercial goals"）。年报只给了**会计层**的口径：平台自费给消费者的 "coupons, credits and other subsidies that may or may not be specific to any merchant"、可 "redeem for cash from us"，并分别记作 **reductions of revenues** 或 **marketing expenses**【源 S1】——本文据此设了机制 6 与考点 14。
   所以：可以考"平台补贴的口径与账务落点"，**不可以**把"百亿补贴的坑位分配、补贴率、库存优先扣减顺序"当已核实事实写进题面。
5. **开放平台官方文档正文**：`open.pinduoduo.com/application/document/*` 是需登录的 SPA（其前端配置里有 `apiDocLoginRequired`），本环境抓不到正文；本文所有接口事实来自 S4 这类社区 SDK 的接口名与中文注释，**已在正文与本表明确标注该替代关系**。入库为"官方原文"前应在可登录环境复核。
6. **Temu 的备货/托管模式细节**（全托管、半托管、JIT、VMI、核价流程）：20-F 未使用这些术语，`open.temu.com` 在本环境不可达、`seller.temu.com` 需登录，因此不写 Temu 侧库存与核价机制。
7. **欧盟委员会对 Temu 决定的原文页面与罚款数额**：`digital-strategy.ec.europa.eu` 返回 Drupal 不可达页、`ec.europa.eu/presscorner` TLS 校验失败，抓不到原文；文中所有 DSA 相关表述一律改引 PDD 20-F【S1】，二手媒体（ecommerce-europe 等）提到的具体罚款数字**未采用**。
8. **算法备案清单中的拼多多条目**：只抓到 2022 年 8 月批次公告且清单内**不含**上海寻梦/拼多多，更晚批次未定位到可抓取页面。
9. **拼多多官方技术公众号 / 内部团队文章**：本环境内多次检索未找到可访问、可归属到公司的技术文章（搜索引擎命中的基本是面试经验贴与培训机构文，不具备出处资格）。**这一条是本题库的红线所在**：如果有人后来补上"拼多多官方公众号第 X 篇"，必须重新核 URL 与发布日期，不能沿用本文结论。
