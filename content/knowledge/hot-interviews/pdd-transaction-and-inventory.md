# 【拼多多】交易 · 库存 · 营销：平台不持货、商家改库存、成团才算成交

来源公司：**拼多多（PDD / Temu）**｜岗位方向：服务端研发（交易/库存/营销/履约）、Senior/Staff Backend、电商中台架构
对应考点：`pdd-inventory-sync`、`pdd-groupbuy-state-machine`、`pdd-checkout-idempotency`、`pdd-order-increment-recon`、`pdd-amount-caliber`、`pdd-price-consistency`、`pdd-coupon-quota`、`pdd-oversell-handling`、`pdd-presale-deposit`、`pdd-fund-settlement`、`pdd-fulfillment-waybill`、`pdd-merchant-qualification-risk`、`pdd-ad-billing-consistency`、`pdd-subsidy-accounting`

> **证据分级（本文全文使用）**
> - **【源】**＝本次真正抓取到的公开来源里就是这么写的（文末"来源清单"逐条对应 URL）。
> - **【推】**＝来源未直接说、但可由来源事实外推的架构结论／业界通用做法。**不要把【推】当引用背**。
> - 题面里的 QPS、延迟、超时时长等**具体数字全部是出题假设**——拼多多官方从未公布过任何秒杀/交易链路的量级数字（见文末"未核实而放弃的方向"）。
>
> **一句话抓住这家公司的交易模型**：拼多多的平台侧**不持有库存**——2025 年报原文（收入确认段）："We provide transaction services, including fulfillment services to merchants, and earn related fees for sales of the products completed on our online platforms. **We do not control the products provided by merchants at any point in time during the transactions.**"【源 S1】
> 所以它不是"库存不够我怎么扣"的问题，而是"**库存是商家系统的镜像，我扣的是镜像，真库存变了要靠同步与对账兜底**"的问题。
> 商家侧通过开放平台接口自己改：`pdd.goods.quantity.update`（商品库存更新接口）、`pdd.stock.ware.warehouse.query`（货品仓库库存信息查询）、`pdd.stock.ware.move`（库存信息调整，`move_direction` 有 **1 入库 / 2 出库 / 3 库存同步**，`business_type` 有 **1 采购 / 2 调拨 / 3 退货 / 4 盘点 / 5 发货 / 6 库存同步**）【源 S4】。
> 这条"同步方向=库存同步、业务类型=库存同步"的官方枚举，就是"平台库存只是投影"的铁证【源 S4】。

---

## 1. 核心机制（面试里必须能画出来的链路）

```
商家/ERP ──(pdd.goods.quantity.update / pdd.stock.ware.move[move_direction=3])──▶ 平台库存投影
                                                                                       │
买家浏览(推荐流为主) → 发起/参与拼团 → 下单锁单 → 支付(第三方支付+托管) → 成团判定 → 发货(电子面单) → 签收/售后
                              │            │                │                │
                        group_status   confirm_status   pay_amount 公式    risk_control_status
                        0拼团中/1已成团/2团失败  0未成交/1已成交/2已取消        (0正常/1审核中)  ← 风控打标会改变数据可见性
```

关键机制点（每条都标了证据等级）：

1. **成团是交易的门槛，不是营销的花瓶**【源】：订单对象里 `group_status`＝`0 拼团中 / 1 已成团 / 2 团失败`，另有 `confirm_status`＝`0 未成交 / 1 已成交 / 2 已取消`【源 S4】。
   含义：**"下单成功"和"这笔交易存在"是两件事**。库存的占用/释放必须挂在成团状态机上，团失败要回补；`mkt_biz_type`（0 普通订单 / 1 拼内购订单）、`is_lucky_flag`（1 非抽奖订单 / 2 抽奖订单）说明**同一张订单表里混着多种业务态**，任何"下单量/成交量"统计都要先分桶【源 S4】。
   【推】因此真实实现里最常见的一致性事故是：团失败回补与买家重新参团并发 → 同一 SKU 被"回补后立刻又被占用"，如果回补走异步而占用走同步，就会出现**投影库存 > 商家真库存**的假有货。
2. **金额有官方口径公式，别自己发明**【源】：`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；`goods_amount = 商品销售价格 × 商品数量 − 订单改价折扣金额`；`discount_amount = 平台优惠 + 商家优惠 + 团长免单优惠金额`【源 S4】。
   还有专门的坑：`promotion_type = 30 以旧换新优惠（优惠金额已包含平台优惠金额里）`——**官方字段注释里明确警告"已包含"，即重复相加会双计**【源 S4】；`trade_in_national_subsidy_amount_type`＝`1 支付优惠 / 2 商家优惠`（国补归属方不同，账务科目不同）；`duo_duo_pay_reduction`（多多支付立减，钱是支付渠道出的）；`step_trade_status`/`step_paid_fee`/`step_discount_amount`（定金-尾款两段式，含"膨胀金"）【源 S4】。
   最后一层是账务归属：年报原文把面向消费者的券/信用额度/其他补贴按"**是否存在替商家履行的明示或默示义务**"分别记作 **reductions of revenues** 或 **marketing expenses**，并允许"to redeem for cash from us"（可提现）【源 S1】。
   【推】所以"这张券的钱算谁的"不能等财务事后调账——交易系统必须在**券批次维度**上携带出资方与义务性质；可提现券与下单抵扣券必须分属两套资产账户，否则直接产生套现通道。展开见考点 14。
3. **增量拉单被官方限制成 30 分钟窗口，且必须倒序分页**【源】：`pdd.order.number.list.increment.get` 的参数注释原文——
   "必填，最后更新时间结束时间的时间戳……**开始时间结束时间间距不超过 30 分钟**"；"**注：必须采用倒序的分页方式（从最后一页往回取）才能避免漏单问题**"；`order_status`＝`1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部`【源 S4】。
   这三句话合起来是一个完整考点：**按"最后更新时间"切片 + 窗口不能宽 + 分页从尾页往回取**，因为更新会不断把行推进/推出窗口，正序翻页必然漏单。
   【推】所以商家/ISV 侧的标准解法是"**增量拉单（分钟级）+ 按成交时间的全量校对（小时/天级）+ 订单号集合差集补拉**"三通道；平台侧则必须有"该单是否被拉走过"的留痕，否则扯皮时无解。
4. **敏感字段的可见性由"状态 + 风控"共同决定**【源】：`receiver_address/name/phone` 的官方注释——"订单状态为待发货状态，**且订单未被风控打标的情况下返回密文数据；其余情况返回空字符串**"；`risk_control_status`＝"订单审核状态（0-正常订单，1-审核中订单）"【源 S4】。
   这是极硬的设计事实：**同一个字段有三种语义（密文 / 空串 / 不存在）**，把它统一成"空值"就丢信息。【推】真实系统里"空串"通常是权限/风控结果，不是数据缺失；下游若用空串参与 join 或去重，会把审核中的单误判为"无地址"。
5. **缺货是显式状态，不靠事后救火**【源】：`stock_out_handle_status`＝`-1 无缺货处理 / 0 缺货待处理 / 1 缺货已处理`【源 S4】。
   配合 48 小时发货承诺（官网原文列表：**全场包邮、7 天退换、假一赔十、48 小时发货**【源 S3】）与"发货超时赔付"，说明**超卖/缺货在这套体系里是一条有状态机的正式流程**，而不是"客服个案"。
6. **钱不在平台手里裸奔，但平台要负责算清**【源】：2025 年报："We currently rely on commercial banks and third-party payment service providers for **payment processing and escrow services**"，并承认"our business depends on the billing, payment and escrow systems of these service providers to **maintain accurate records of payments of sales proceeds**"、风险项里直接写 "**failure to manage funds accurately or loss of funds**, whether due to employee fraud, security breaches, technical errors or otherwise"【源 S1】。
   量级也给得出（官方报表）：截至 2026-03-31，**Payable to merchants（应付商家款）≈ RMB 1091.5 亿**、**Merchant deposits（商家保证金）≈ RMB 179.1 亿**、**Customer advances and deferred revenues ≈ RMB 35.2 亿**【源 S2】。
   再加一个接口事实：官方给 ISV 的是"**商家货款日账单下载链接**" `pdd.finance.balance.daily.bill.url.get`【源 S4】——即**对账以"日账单文件"为一次真相**，不是实时 API。
7. **营销侧的库存与额度是独立额度**【源】：优惠券是"**批次**"模型——`pdd.promotion.goods.coupon.create`（创建无门槛商品券批次）、`pdd.promotion.coupon.quantity.add`（**增加优惠券发行数量**）、`pdd.promotion.coupon.close`（**关闭批次**）、`pdd.promotion.merchant.coupon.list.get`；限时限量购也是活动对象——`pdd.promotion.limited.activity.create` / `.cancel` / `pdd.promotion.limited.discount.list.get`【源 S4】。
   【推】"发行数量可加、批次可关"这两个动作的存在，说明券的**发放额度与商品库存是两套额度**，事故通常发生在两套额度的乘积区（券够、货不够 / 货够、券被加超）。
8. **广告是另一条交易链路，口径必须能自证增量**【源】：`pdd.ad.api.*` 里有 `pdd.ad.api.advertiser.open.account`（广告主开户）、`query.account.balance`（账户余额）、`plan.update.max_cost`（**日消耗上限**）、`plan.update.plan.discount`（**分时折扣**）、`unit.tr.update.optimization.bid`（全站推广**成交出价**）、`unit.tr.update.target.roi`（**目标投产比**）、`unit.creative.distribute.flow.rate`（智能创意流量比例分配）与 `unit.creative.query.flow.rate`（查询智能创意流量分配比例，**单位：万分比**）、`report.hourly.report.query` / `report.daily.report.query` / `report.entity.report.query`（分级报表）【源 S4】。
   【推】目标 ROI + 成交出价 + 小时/分天双报表，意味着"**广告归因成交**"和"**交易真实成交**"是两套数，senior 必须能说清差异来源（退款回冲、跨天、优惠券归属、抽奖/拼内购单）。
9. **资质核验失守是这家公司当前最贵的风险**【源】：2026 年 4 月市场监管总局公布 7 家电商平台"幽灵外卖"系列案处罚：单个平台最高罚款 15 亿元、7 家合计罚没 35.97 亿元，查实 **67604 家"幽灵店铺"**，按"**一店一处罚**"处理；一家"甜颜情书"名下 378 家连锁店的食品经营许可证"**全部为伪造**"；平台被认定的两类问题是"**未依法履行审查义务**"（一店一处罚即针对此）与"对蛋糕店铺把消费者订单**转让给其他经营者且未告知消费者**（转单）的行为未采取措施"【源 S1/S5】；监管要求平台建立"**资质审核、风险监测、问题排查、快速处置**"的食品安全风险防控机制【源 S5】。
   同案里还有两条**极适合出题的工程细节**【源 S5】：执法方要靠"一个蛋糕店铺一个店铺核验信息、查资质"，且"**对于每一个手机号，平台会限定登录查看次数**"；以及平台第一次提供的数据是"整体数据 1/3、1/4 甚至更少"、"碎片化、格式混乱"，执法方最终"反复研究平台**数据架构、交易流程及算法逻辑**"才提取出"**订单流转、资质备案、转单交易**"关键电子数据。
   拼多多自己在年报里也写了这笔账："in April 2026, the SAMR fined seven platform operators a total of approximately RMB3.6 billion, including **approximately RMB1.5 billion against the operator of the Pinduoduo platform**, for violations of the E-Commerce Law and PRC food safety laws that included **failing to properly verify food business licenses** and failing to take measures against cake vendors ... **transferring consumers' orders to other vendors without notifying the consumers**"，并披露处罚包含"**九个月暂停新增蛋糕店铺入驻**"【源 S1】。
10. **推荐/浏览式消费 + 社交分享，导致流量归因官方承认算不清**【源】：2025 年报原文："A portion of our buyer traffic comes from these **recommendations or product introductions that buyers share through social networks**. Due to the nature of our business model ... **it is impracticable for us to accurately bifurcate and quantify the buyer traffic generated directly through our platforms and through social networks**"【源 S1】。
    对交易侧的含义【推】：**下单链路要允许"无搜索意图"的高并发瞬时集中**（一条被转发的商品链接带来脉冲流量），所以限流/防刷的默认维度是"商品+活动+账号/设备"，而不是"搜索词"。

---

## 2. 会被追问什么（拼多多风格：不谈概念，只问"字段与状态怎么变"）

1. "`stock_out_handle_status` 从 0 变 1 有几种合法路径？谁有权写 1？"（期待：缺货登记→商家补货/协商改期→赔付完成/退款→关闭；写权必须收敛在一个服务，且要能审计到人）
2. "`group_status=2 团失败`，库存和优惠各回滚什么？回滚失败怎么办？"（券的"已领"与"已用"要分开回滚；`capital_free_discount` 团长免单额度是另一个池子）
3. "官方说增量拉单窗口 ≤30 分钟且要倒序分页——为什么正序会漏单？"（按 updated_at 排序时，窗口内不断有新行推进来，尾页内容会左移，正序跳过未读页会跨过刚被推进来的行）
4. "`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`，`platform_discount` 和 `seller_discount` 谁承担？开票按哪个金额？"（要能讲：买家实付 ≠ 商家应收 ≠ 平台收入；国补/支付立减另有出资方）
5. "`receiver_phone` 返回空串，你怎么判断是"没有"还是"不许看"？"（必须结合 `risk_control_status` + 状态；空串当 null 用是事故源）
6. "商家自己把库存改小了，你扣减已成功的订单要不要砍？"（要给出"最后一步确认再校验 + 赔付走缺货流程"的判据，并说明与"假一赔十/48 小时发货"承诺的成本权衡）
7. "同一笔下单请求重试两次，你靠什么保证不多扣？"（`gw-api.pinduoduo.com/api/router` 的公共参数是 `client_id/access_token/timestamp（秒）/type/sign`【源 S4】——要能讲清幂等键该放在哪一层、时间戳窗口与重放的关系）
8. "你怎么发现和商家 ERP 的库存不一致？"（三通道：调整单（`move_order_sn` 唯一）驱动、周期性对账、下单失败率作 SLI；【源】批量上限"一次传入 list size 不超过 30 个"→ 反压与分片要算）
9. "转单怎么在数据上识别？"（履约主体与签约主体不一致：面单发货地/仓库编码集合突变 + 证照地址 vs 实际揽收地址 + 消费者投诉文本；这题有官方处罚背景【源 S1/S5】）
10. "广告报表小时数据和分天数据对不上，你的立场是什么？"（先说"谁是一次真相"，再说晚到回补窗口与不回溯的口径变更协议）
11. "如果让你把'未依法履行审查义务'这类风险变成可验证的工程卡口，你加哪三条？"（期待：证照必须比对官方数据源、人工审核双人 + 留痕、任何"跳过审核"的操作本身成为高危审计对象）

---

## 3. 常见错误答案（背题型信号）

| 错误 | 暴露点 |
|---|---|
| "Redis 预扣 + MySQL 兜底就完事了" | 不知道平台侧扣的是**商家库存投影**，商家随时可改；缺"同步/对账/最后一步再校验"三段 |
| 把"成团"当营销玩法，交易链路里只有一个状态 | 官方就有 `group_status`/`confirm_status` 两套状态，说不清谁先变、团失败回补什么 |
| 自己写一套 GMV 公式 | `pay_amount` 有官方加法构成（含邮费与服务费），漏服务费/重复加国补直接算错 |
| "空值就是没有数据" | 敏感字段空串是"风控/权限结果"，官方注释写得很清楚 |
| 增量同步按 `created_at` 或正序翻页 | 官方明确要求 `updated_at` + ≤30 分钟窗口 + 倒序分页；不知道为什么会漏单 |
| 认为对账靠实时接口 | 官方给 ISV 的是**日账单文件下载**；说不清差异容差与账期 |
| 优惠券只讲"发多少张" | 券批次是"额度对象"，可加量可关闭，与商品库存是两套池子 |
| 风控=上线后加规则 | 资质审核失守已经是**罚 15 亿级、并直接暂停品类入驻 9 个月**的现实成本【源】 |
| 只有"我们用了分布式事务" | 讲不出团失败/退款/缺货三条回滚路径各自的失败后果与补偿 |

---

## 4. 考点清单（14 条，可直接映射成题）

> **judgeKind 约定**：本清单中标 `code` 的条目已显式写出 `judgeKind`（`java-junit` / `mysql` / `redis`）；**只标 `rubric` 的条目，其 `judgeKind` 一律为 `llm-rubric`**（与 `content/knowledge/hot-interviews/README.md` 的约定一致）。`react-vitest` 与 `spark-scala` 在本文中刻意不使用——拼多多的前端与 Scala 计算栈没有任何可核查出处，写出来就是编。

> 每条给出：考点名（tag）｜senior 深度要点（含机制与取舍）｜可出题形式｜建议 judgeKind｜证据锚点

1. **商家库存投影与同步一致性**（`pdd-inventory-sync`）
   要点：平台库存不是真库存（商家供货、商家改库存）；同步走"调整单"语义（`move_direction=3` 库存同步、`business_type=6` 库存同步、`move_order_sn` 天然幂等键、单批 ≤30 条）；投影落后于真库存时宁可"假缺货"不能"假有货"；`pdd.stock.depot.priority.update`（仓库优先级）说明多仓路由由商家配置，平台算可用要看仓优先级与可达范围；不一致检测靠"下单失败率 + 周期对账"，不靠猜。
   出题：code（`judgeKind=redis`：多仓优先级 + 同步乱序下的可用性判定与幂等调整单）；rubric（投影架构与对账方案）。
   锚点：【源 S4】【源 S1（无库存模式）】＋【推（预扣/兜底机制）】。
2. **拼团状态机与"成交"定义**（`pdd-groupbuy-state-machine`）
   要点：`group_status`（拼团中/已成团/团失败）与 `confirm_status`（未成交/已成交/已取消）是两条正交状态线；占用与释放挂哪条线决定团失败时要不要回补库存、券要不要退回、免单额度怎么处理；成团时限数字**官方未公布**，出题时必须自设并标注假设；与 `mkt_biz_type=1 拼内购`、`is_lucky_flag=2 抽奖订单` 的分桶统计要显式排除。
   出题：code（`judgeKind=java-junit`：状态机非法迁移拦截 + 并发参团）；rubric（成团失败回滚链路）。
   锚点：【源 S4】＋【推（成团时限/并发方案）】。
3. **网关幂等、时间戳与防重放**（`pdd-checkout-idempotency`）
   要点：官方网关 `gw-api.pinduoduo.com/api/router`，公共参数 `type/client_id/access_token/timestamp(秒级)/sign/data_type`【源】；秒级时间戳 ⇒ 重放窗口只能靠窗口长度 + nonce 集合；`error_response` 是唯一错误包装，幂等重放要能区分"系统错误"与"业务重复"；真实下单幂等键应由**买家侧生成**并持久化（弱网重试、连点、多端）。
   出题：code（`judgeKind=java-junit`：幂等键 + 状态机 + 重放窗口）；rubric（多端重复提交的收敛）。
   锚点：【源 S4】＋【推】。
4. **订单增量同步与三通道对账**（`pdd-order-increment-recon`）
   要点：30 分钟窗口 + `updated_at` 切片 + 倒序分页（官方防漏单要求）；"更新把行推近窗口尾"导致正序漏单；解法＝增量（分钟级）＋全量校对（按成交时间，天级）＋差集补拉，且要能证明"没漏"（拉取留痕、水位线、集合基数）；对账以"日账单文件"为一次真相，实时接口只做定位。
   出题：code（`judgeKind=mysql`：给定多次快照算漏单/重单、水位线推进）；rubric（三通道设计与验证）。
   锚点：【源 S4】。
5. **金额与优惠分摊口径**（`pdd-amount-caliber`）
   要点：能背出官方公式（`pay_amount = goods_amount − discount_amount + 邮费 + service_fee`；`discount_amount = platform_discount + seller_discount + capital_free_discount`）；两个必考陷阱——`promotion_type=30 以旧换新优惠（已包含平台优惠里）`（重复加会双计）、`trade_in_national_subsidy_amount_type`（1 支付优惠 / 2 商家优惠，出资方不同）；买家实付 ≠ 商家应收 ≠ 平台佣金收入；退款回冲要按分摊比例而不是按面额。
   出题：code（`judgeKind=mysql`：从订单+优惠明细还原三方金额，含"已包含"项与退款分摊）；rubric（口径文档与语义层落地）。
   锚点：【源 S4】。
6. **价格一致性与"杀熟"合规红线**（`pdd-price-consistency`）
   要点：`pdd.goods.price.check`（商品价格核实）、`pdd.goods.advice.price.get`（商品建议价格）、`pdd.order_change_amount`（订单改价折扣）说明价格是多来源可变的；硬合规边界（官方文件原文引用）：《平台经济领域的反垄断指南》禁止 "deploying big data analytics to set **discriminatory terms** for merchandise prices or other transaction terms"，PIPL 亦 "prohibits any person that processes personal data from engaging in **price discrimination** ... based on automated analysis of collected personal information"【源 S1】；【推】所以个性化只能作用于"排序/展示/券的发放"，不能作用于"同一商品对同一交易条件的定价"，这条要能在系统设计里落成可验证的卡口（价格决策日志可复算、差异比对告警）。
   出题：rubric（价格链路 + 合规卡口 + 复算机制）；code（`judgeKind=mysql`：同一 SKU 多次展示价方差/差异定价体检）。
   锚点：【源 S1】【源 S4】＋【推（卡口设计）】。
7. **优惠券批次额度与限时限量购**（`pdd-coupon-quota`）
   要点：批次模型（create/quantity.add/close）意味着"发行量"是可增可停的独立额度，与商品库存是两套池子；加量与关闭要和已发未用券的兑现承诺对齐（不可回收已发券 → 超发风险由商家保证金兜底）；`pdd.promotion.limited.activity.*` 的"限时限量购"活动对象说明**活动额度需要独立预占**；防双计：券的核销与 `discount_amount` 的归属要一致（同一笔优惠不能既进券表又进平台优惠）。
   出题：code（`judgeKind=redis`：批次额度预占/回滚 + 关闭批次的并发语义 + 防超发）；rubric（额度治理与止损）。
   锚点：【源 S4】。
8. **超卖/缺货处置与风控打标联动**（`pdd-oversell-handling`）
   要点：`stock_out_handle_status` 三态是正式流程；处置必须与"48 小时发货/假一赔十/全场包邮"承诺（官网原文）挂钩，赔付成本模型要能算；`risk_control_status=1 审核中` 会同时改变**数据可见性**（收件人字段变空串）——审核中的单不能进发货队列，也不能被"自动缺货处理"误伤；砍单要有二次确认与可申诉证据链（订单流转、资质、物流轨迹留痕）。
   出题：code（`judgeKind=java-junit`：审核中/缺货/退款三条状态线互斥与非法迁移）；rubric（砍单决策与赔付权衡）。
   锚点：【源 S4】【源 S3】。
9. **预售定金-尾款与膨胀金**（`pdd-presale-deposit`）
   要点：`step_trade_status`（0 定金未付尾款未付 / 1 定金已付尾款未付 / 2 定金已付尾款已付）+ `step_paid_fee` + `step_discount_amount`（膨胀金额）；【推】难点是"跨期一致性"：定金与尾款是两个支付事件、可能跨活动期与价格变更，库存要按尾款口径锁定还是按定金口径锁定，决定超卖风险分布；退款时膨胀部分不可提现，要按"权益账户"而非"现金账户"记账。
   出题：code（`judgeKind=mysql`：定金/尾款两阶段金额还原与膨胀部分归属）；rubric（锁定时机取舍）。
   锚点：【源 S4】＋【推】。
10. **资金托管、保证金与日账单对账**（`pdd-fund-settlement`）
    要点：钱在商业银行/第三方支付机构的**托管（escrow）**体系里【源 S1】；平台侧的真实负债是"应付商家款（≈1091.5 亿元，2026-03-31）+ 商家保证金（≈179.1 亿元）+ 客户预付/递延收入（≈35.2 亿元）"【源 S2】——能报出这三个科目才算做过；对账通道是**日账单文件**（`pdd.finance.balance.daily.bill.url.get`）【源 S4】，要能说清差异容差、账期、退款/赔付/服务费的入账时点差；"failure to manage funds accurately or loss of funds"是官方自列风险【源 S1】。
    出题：rubric（结算与对账体系，含差异处置与止付）；code（`judgeKind=mysql`：账单文件 vs 订单表差异定位）。
    锚点：【源 S1】【源 S2】【源 S4】。
11. **履约：电子面单、承诺与集运中转**（`pdd-fulfillment-waybill`）
    要点：面单是"取号 → 回传 → 取消回传"三段（`pdd.fds.waybill.get` / `.return` / `.return.slave` / `.cancel`）【源 S4】——取消回传是典型的补偿点；`pdd.order.promise.info.get`（订单承诺信息）说明**承诺是数据对象**，发货时效 SLA 判定有据；`pdd.order.consolidate.order.user.address.get`（中转订单用户实际收货地址查询）+ `pdd.conso.warehouse.pack.scan.enter`（偏远集运中转仓包裹扫码入库）+ `pdd.conso.dws.data.get`（集运 DWS 设备采集数据）＝**中转仓链路**，运单与订单不是一一映射，收货地址有两套（中转/真实），隐私与对账复杂度同时上升；官网承诺"48 小时发货/全场包邮"是赔付触发条件【源 S3】。
    出题：rubric（多段运单/中转下的状态一致性与时效判定）；code（`judgeKind=mysql`：按承诺与实际揽收时间算超时并处理取消回传）。
    锚点：【源 S4】【源 S3】。
12. **商家资质核验与转单风控**（`pdd-merchant-qualification-risk`）
    要点：这是有真实处罚金额的考点——"failing to properly verify food business licenses"＋"transferring consumers' orders to other vendors without notifying the consumers"，后果是约 **15 亿元**罚款与**九个月暂停新增蛋糕店铺入驻**【源 S1】；行业侧事实：一家店名下 **378 张伪造食品经营许可证**、全国查实 **67604 家幽灵店铺**、按"**一店一处罚**"计【源 S5】。
    工程答案要具体：证照不采信商家上传件，**必须比对发证机关数据源并留存比对结果**；连锁品牌的"总店-门店"授权链要能逐级证明（否则"378 家店同一套假证"必然过审）；**转单识别靠数据交叉**——实际揽收地/仓库编码/面单发货地与店铺资质地址的偏离；审核动作本身要双人复核 + 不可抵赖留痕（监管现场取证是"一店一处罚"的举证基础）；账号维度访问频控（"每个手机号限定登录查看次数"【源 S5】）之外还要有"批量导出/批量核验"的高危行为审计。
    出题：rubric（资质核验 + 转单识别 + 审计留痕的机制设计）；code（`judgeKind=mysql`：地址/揽收地偏离检测）。
    锚点：【源 S1】【源 S5】。
13. **广告计费与预算一致性**（`pdd-ad-billing-consistency`）
    要点：预算是硬对象（`plan.update.max_cost` 日消耗上限、`plan.update.plan.discount` 分时折扣），"超投"是资损；账户是预充值余额（`advertiser.query.account.balance`、开户 `pdd.ad.api.advertiser.open.account`）⇒ 计费与余额扣减要事务化；出价机制事实：全站推广有"成交出价 + 目标投产比"，智能创意的流量分配比例用**万分比**表达（`unit.creative.distribute.flow.rate` 设置、`unit.creative.query.flow.rate` 查询）——精度单位到万分比，说明分流桶数量级至少 10⁴，【推】实验/分流的桶设计与报表分组必须同构；报表三层（hourly / daily / entity 分级）⇒ 谁是一次真相、晚到如何回补必须显式声明；计费口径事实：广告收入 = "matching product listings appearing in search or browsing results ... charging merchants based on **impressions or clicks**, and display marketing ... at **fixed prices**"【源 S1】——三种计费同时存在。
    出题：rubric（计费/预算/一致性对账）；code（`judgeKind=mysql`：点击日志 → 计费 → 报表三层对账与去重）。
    锚点：【源 S4】【源 S1】。
14. **平台补贴的出资认定与会计归属**（`pdd-subsidy-accounting`）
    要点：官方收入确认段原文——"we at our own discretion provide various forms of incentives. These incentives, including **coupons, credits and other subsidies that may or may not be specific to any merchant**, can be used by the consumers to purchase merchandise ... at reduced prices **or to redeem for cash from us**. We record the incentives as **reductions of revenues** if they are considered as variable consideration or when there are explicit contractual obligations to incentivize the consumers **on behalf of the merchants** ... If we determined that incentives ... are not considered as payments to the merchant-customers, we record these incentives as **marketing expenses**."【源 S1】
    这就是"券的钱到底算谁出的"的终极判据：**同一张券在账务上有三种落点**（冲减收入 / 代商家承担的负债 / 市场费用），判定依据是"是否存在明示或默示的替商家给消费者的义务"。
    【推】交易系统必须把"出资方 + 义务性质"作为券批次的**一等属性**（而不是事后靠财务手工调账），否则：① 商家账单里的"平台优惠 vs 商家优惠"分不干净（对应字段 `platform_discount` / `seller_discount`【源 S4】）；② 用户侧"可提现红包"（redeem for cash）与"下单抵扣券"必须走两套资产账户，混用直接产生资损与套现通道；③ 收入侧要处理**可变对价**（官方："Variable consideration is estimated and included in the transaction price to the extent that it is probable that a significant revenue reversal will not occur"【源 S1】），意味着预估与后续冲正都是常态，系统要留预估依据。
    出题：code（`judgeKind=mysql`：给定券批次属性 + 订单优惠明细，判定每条优惠的账务落点并输出"收入抵减 / 商家承担 / 市场费用"三列）；rubric（券批次建模与出资方一等属性化、套现通道防控）。
    锚点：【源 S1】【源 S4】＋【推（建模与防控）】。

---

## 5. 出题角度

### 题面草稿 A（`code`，`judgeKind=mysql`）—— 金额口径题（强区分度）
> 给定 `orders(order_sn, goods_amount, discount_amount, post_amount, service_fee, pay_amount, platform_discount, seller_discount, capital_free_discount, trade_in_national_subsidy_amount, trade_in_national_subsidy_amount_type, duo_duo_pay_reduction, order_change_amount, group_status, confirm_status, is_lucky_flag, mkt_biz_type, risk_control_status, stock_out_handle_status)` 与 `order_promotions(order_sn, promotion_type, promotion_amount)`（字段语义以拼多多开放平台官方文档为准，`promotion_type=30` 为"以旧换新优惠，其金额**已包含在平台优惠金额里**"）。
> 要求：
> 1) 校验官方恒等式 `pay_amount = goods_amount − discount_amount + post_amount + service_fee` 与 `discount_amount = platform_discount + seller_discount + capital_free_discount`，输出**不满足的行 + 差异金额**（浮点容差自定并写在注释）；
> 2) 统计"平台真实让利" `platform_subsidy`：必须正确处理 `promotion_type=30` 的**已包含**语义（不可重复相加），并把 `trade_in_national_subsidy_amount_type=1（支付优惠）` 排除在平台让利之外；
> 3) 输出"有效成交"三列口径并各自写明分母：`下单口径`（全部行）、`成交口径`（`confirm_status=1`）、`成团成交口径`（`confirm_status=1 AND group_status=1`），并要求 `is_lucky_flag=2`（抽奖订单）与 `mkt_biz_type=1`（拼内购）单列不计入主口径；
> 4) 找出"`stock_out_handle_status=0`（缺货待处理）但 `confirm_status=1`"的行，按其 `goods_amount × 平台类目费率` 估算赔付敞口（费率题面给），并标记 `risk_control_status=1` 的行（审核中单不应进入赔付计算）。
> 用例：含 `promotion_type=30` 的双计陷阱行、国补支付优惠行、团失败但已支付、抽奖订单、审核中缺货单、浮点分位差 0.01。
> 区分度：第 2 问的"已包含"处理与第 3 问的分母声明；写不出分母的按"没做过交易口径"降档。

### 题面草稿 B（`rubric`，10 分制，主推）
> **你正在面试拼多多 服务端研发（交易/库存方向）的 Senior，45 分钟**
> 业务前提（均来自可核查事实）：平台不持有库存，商品由第三方商家供货，商家通过开放平台接口自行修改库存与价格；订单有"拼团中/已成团/团失败"与"未成交/已成交/已取消"两条状态；订单增量拉取被限制为"时间窗 ≤30 分钟、按最后更新时间、必须倒序分页"；收件人姓名/电话/地址仅在"待发货且未被风控打标"时以密文返回，其余情况返回空串；缺货有显式处理状态；商家货款以"日账单"给到外部；平台侧应付商家款约 1091 亿元、商家保证金约 179 亿元量级。
> 现状与事故：某爆款活动商品（1 SKU，商家自有 ERP 管库存）在活动开始后 12 分钟，平台侧投影库存比商家实际可售多 1.8 万件；已产生 6200 笔"已支付未成团"与 310 笔"已成团待发货"；商家在第 15 分钟把库存改成了 0；同分钟起该 SKU 的"审核中"订单占比升到 11%。
> 请给出：① 投影库存的写入/失效模型（含幂等键与乱序处理，明确"库存同步"类调整单与"出库"类调整单的优先级规则）；② 这 6200+310 笔单的处置决策树（哪一类可以直接赔、哪一类必须回补、哪一类因"审核中"不能动），以及每一步对"48 小时发货/假一赔十"承诺的成本影响；③ 为什么"商家把库存改成 0"这件事**不能**当止损终点，你的正确止损动作是什么；④ 增量通道漏单的检测与补偿（如何在不放宽 30 分钟窗口约束的前提下证明没漏）；⑤ 缺货赔付与货款结算（日账单）之间的差异如何闭环，谁承担、怎么审计；⑥ 三条你会写进团队规范的硬卡口（必须可被 CI 或网关拦截）。
> **加分点**：把"投影 vs 真库存"的误差量化成 SLI（投影准确率、发货前重算拦截率）；识别"收件人字段变空串"会导致下游把审核中单误判为无地址（并给出区分方案）；用"一店一处罚/举证留痕"论证为什么人工改库存必须可回溯到调整单；主动承认"成团时限、窗口长度、QPS 数字是假设"并说明如何压测验证。
> **不足点**：只会说"Redis 预扣 + MQ 削峰"；把砍单当默认止血；处置决策没有区分"已支付未成团"与"已成团"；对账只说"跑个 job 看看"；对"商家随时能改库存"这个事实无感。

### 题面草稿 C（`rubric`，短题，10 分钟）
> "官方接口要求订单增量拉取'窗口 ≤30 分钟、按最后更新时间、倒序分页'。请用 3 分钟说明：正序分页为什么漏单？给出你的水位线设计，并说明你如何在生产上**证明**没有漏单（不许回答'和商家对一下'）。"
> 期望：窗口尾部持续被更新推进 → 正序翻页会跳过刚推进来；水位线要按"上次成功处理的 max(updated_at) − 安全滞后"并允许重叠；用"按成交时间的全量集合差集"做周期性反证；漏单指标本身就是 SLI（漏单率、补拉命中率、补拉到账时延）。

---

## 6. 来源清单（全部于 **2026-09-23** 实际抓取并确认页面内容）

> 记法：**S#** 为编号；每条格式 `URL ｜ 标题 ｜ 访问日期 ｜ 支撑的考点`。

| # | URL | 标题 | 访问日期 | 支撑了上面哪几条考点 |
|---|---|---|---|---|
| S1 | https://www.sec.gov/Archives/edgar/data/1737806/000110465926050727/pdd-20251231x20f.htm | PDD Holdings Inc. Form 20-F（FY2025，2026-04-29 提交） | 2026-09-23 | 核心机制 1/3/6/9/10；考点 1（"We do not control the products provided by merchants at any point in time during the transactions"＝平台不控货）、6（杀熟禁令原文：平台经济反垄断指南 + PIPL）、10（escrow 与"failure to manage funds accurately or loss of funds"）、12（SAMR 约 15 亿元罚款 + 九个月暂停新增蛋糕店铺入驻）、13（impressions/clicks/fixed price 三种计费）、14（消费者 incentives 的三种账务落点、可变对价预估）；题面草稿 B（"商家供货/平台不控货"前提）、常见错误表 |
| S2 | https://www.sec.gov/Archives/edgar/data/1737806/000110465926067186/tm2615739d1_ex99-1.htm | PDD Holdings 2026 年第一季度未经审计财务业绩（6-K 附件 Ex 99.1，2026-05-28） | 2026-09-23 | 核心机制 6；考点 10（应付商家款 109,151 百万元、商家保证金 17,905 百万元、客户预付 3,521 百万元；成本项含 fulfilment fees/bandwidth/server/payment processing） |
| S3 | https://www.pinduoduo.com/home/seckill/ （及 https://www.pinduoduo.com/ ） | 拼多多官网「限时秒杀」专题页与首页页脚（主体：上海寻梦信息技术有限公司） | 2026-09-23 | 核心机制 5/10；考点 8（48 小时发货、全场包邮、7 天退换、假一赔十 官方承诺）、11（发货时效承诺）；首页 meta 描述"专注拼团…发起和朋友家人邻居的拼团"支撑拼团定位（未提供时限数字） |
| S4 | https://github.com/niltor/open-pdd-net-sdk （`dev` 分支，最后提交 2026-03-30；重点文件 `src/PddOpenSdk/Services/PddApi/{GoodsApi,StockApi,OrderApi,RefundApi,PromotionApi,FinanceApi,AdApi,DdkApi,PmcApi,FdsApi,LogisticsApi,MallApi}.cs`、`Models/Request/Order/GetOrderNumberListIncrement.cs`、`Models/Request/Stock/MoveStockWare.cs`、`Models/Response/Order/GetOrderListResponse.cs`、`Services/PddCommonApi.cs`） | 拼多多开放平台 DotNet SDK（社区维护，接口名与中文注释逐条对应官方文档） | 2026-09-23 | 核心机制 1/2/3/4/5/7/8；考点 1、2、3、4、5、7、8、9、10、11、13（所有 `pdd.*` 方法名、参数字段与中文枚举语义的唯一来源）；题面草稿 A 的全部字段 |
| S5 | https://scjg.ln.gov.cn/scjdglj/xw/mtbd/2026042016201794829/index.shtml | 《中国质量报》：市场监管总局依法查处 7 家电商平台"幽灵外卖"系列案纪实（辽宁省市场监督管理局转载，2026-04-20） | 2026-09-23 | 核心机制 9；考点 12（67604 家幽灵店铺、378 张伪造许可证、一店一处罚、合计罚没 35.97 亿元、资质审核/风险监测/问题排查/快速处置要求、"每个手机号限定登录查看次数"、平台提供数据"碎片化、格式混乱"） |
| S6 | https://www.career.zju.edu.cn/jyxt/sczp/zpztgl/ckZpgwXq.zf?zpxxbh=3EB974916D1FDD49E0653A68DD0E9B18 | 浙江大学就业服务平台转载：服务端研发工程师（拼多多集团 26 届秋招），主体"上海寻梦信息技术有限公司"，原文指向官方投递链接 https://careers.pddglobalhr.com/campus/grad/detail?t=PPQ8Z6zMuc | 2026-09-23 | 对标 JD 能力项（下方表）；说明岗位官方表述为"高并发、高流量、分布式环境下的性能和稳定性""熟悉常用的存储系统和中间件" |
| S7 | https://api.github.com/orgs/pinduoduo/repos | 拼多多官方 GitHub 组织仓库列表（仅 1 个 `recruitment` 仓库） | 2026-09-23 | "未核实而放弃的方向"第 1 条的证据：官方开源几乎为零，故本文不引用任何"拼多多自研开源组件" |

### 对标 JD 能力项（只放我真正抓到的文字）

| 公司/主体 | 岗位 | 抓到的原文（S6） |
|---|---|---|
| 上海寻梦信息技术有限公司（拼多多集团） | 服务端研发工程师（26 届秋招） | "持续优化系统架构,提高系统在高并发、高流量和分布式环境下的性能和稳定性，保持系统的高可用性、高可靠性和高扩展性"；"扎实的数据结构和算法能力，熟悉常用的存储系统和中间件"；"承担新技术预研和方案选型" |

> 官方社招站 `https://careers.pddglobalhr.com/jobs` 与校招站 JD 详情正文需验证码/JS 渲染，**抓不到逐条 JD 文本**，因此本表只用校方就业网转载的那一份，其余 JD 不写。

---

## 7. 未核实而放弃的方向（不要把它们写进题里）

1. **拼多多自研开源中间件**（所谓"官方 RPC / 库存中心 / 大缓存"之类）：官方 GitHub 组织 `pinduoduo` 下只有一个 `recruitment` 仓库【源 S7】，抓不到任何工程组件，因此全文没有任何"拼多多用了 X 框架"的断言。
2. **具体量级数字**：秒杀峰值 QPS、下单 TPS、交易库分库分表数、Redis 分片数、成团超时时长（"24 小时"之类）——在 20-F、季报、官网、开放平台文档中均未出现；网上流传的版本全部是面试经验贴/培训机构文，未采信。题面里的数字必须显式写成假设。
3. **"百亿补贴"这个营销 IP 本身**：2025 年报里检索 `Ten Billion` / `Billion Subsidy` 命中 **0** 次，没有出现"百亿补贴"的活动规则、库存机制或资金池结构（年报里唯一以"10 Billion"命名的是 2021 年 8 月启动的 **"10 Billion Agriculture Initiative"（百亿农研专项）**，原文注明"not driven by profit or commercial goals"【源 S1】）。
   **能核实到的只有会计层**：年报确实描述了平台自费给消费者的 incentives（"coupons, credits and other subsidies that may or may not be specific to any merchant"、可"redeem for cash from us"）及其入账方式（收入抵减 or 市场费用）【源 S1】，本文据此设了考点 14，并在正文用官方字段 `platform_discount`（平台优惠金额）表达"平台出资优惠"。
   **因此**：题面里不要把"百亿补贴"当已核实的机制来描述（准入条件、坑位分配、补贴率、库存优先扣减顺序都没有来源）；要考"平台补贴"，请走考点 5 / 7 / 14 的字段与会计口径路线。
4. **拼多多开放平台官方文档页正文**：`open.pinduoduo.com/application/document/*` 是需登录的 SPA，抓不到正文（其 JS 里存在 `apiDocLoginRequired` 配置项）。本文所有接口事实来自 S4（社区 SDK 的接口名与中文注释），**已在正文明确标注这一点**；如需入库为官方口径，应改用能登录抓取的环境复核。
5. **Temu 的"全托管 / 半托管 / JIT 备货"机制**：20-F 只有 "In partnership with a global network of logistics vendors and fulfillment partners" 与 "Pinduoduo and Temu have the same value propositions and operational model" 这类表述，未出现 "fully-managed / semi-managed / JIT" 字样；`open.temu.com` 与 `seller.temu.com` 在本环境不可达/需登录，故 Temu 侧库存与备货机制**不写入考点**。
6. **欧盟对 Temu 的官方决定原文**：`digital-strategy.ec.europa.eu` 与 `ec.europa.eu/presscorner` 在本环境抓取失败（Drupal 不可达页 + TLS 校验失败）。本文关于 DSA 的表述全部改引 PDD 20-F 自己的描述【S1】，不直接引用欧盟原文。
7. **拼多多算法备案（网信办"个性化推送类"清单）**：只抓到 2022 年 8 月批次公告，清单中**不含**"上海寻梦/拼多多"，更晚批次未能定位到可抓取页面，故未使用。
8. **工信部 APP 侵害用户权益通报中的拼多多条目**：未能定位到可抓取的官方通报原文，未使用。
9. **内部数据栈选型（ClickHouse/Doris/Flink/Pulsar 等）**：无任何官方来源支撑，一律不在本文出现——需要考数据栈时用 `pdd-data-and-recommendation.md` 中"字段与口径"层面的事实出题。
