# progress-gamification Specification

## Purpose
定义游戏化系统与题库系统之间的边界：XP、连续天数、段位与成就是自己和自己的博弈（不做多人对抗），只消费判题/评分结果与尝试记录，绝不反向影响题目内容。它约束 `server/src/game/`、进度存储与 `/api/progress` 返回结构。

## Requirements

### Requirement: XP 与连续天数（场景 2）
系统 SHALL 按固定规则累计 XP：可执行题 `pass` 得 15、`fail` 得 2（安慰奖）、`error` 得 0；主观题得 `round(score / maxScore * 20)`；完成当日套餐额外 +10。连续天数（streak）SHALL 以"当日 XP ≥ 20"为续签门槛（即至少做成 2 道题，或 1 道代码题 + 一道 ≥5 分的主观题），**答 1 题不足以续签**，避免打卡注水；中断则重置为 1；同一题的 XP 只计历史最佳一次。

#### Scenario: 只答 1 题不续签
- **WHEN** 用户当日只有 1 道题 pass（XP 15）
- **THEN** `streakDays` 不增加，今日挑战页提示"再完成 1 题即可续签"

#### Scenario: 首次完成套餐建立 streak
- **WHEN** 用户当日累计 XP 达到 20 且昨日无记录
- **THEN** `streakDays === 1` 且显示套餐完成奖励已计入

#### Scenario: 断签后重置
- **WHEN** 数据库中存在 3 天前的作答、昨日无作答，用户今日达标
- **THEN** `streakDays === 1`（不延续为 4）

#### Scenario: 重复提交不刷分
- **WHEN** 用户把一道已通过的题反复提交
- **THEN** 该题 XP 只按历史最佳计一次

### Requirement: 段位阶梯与成就（单人自洽，不做对抗）
系统 SHALL 基于**个人累计 XP** 显示段位阶梯（青铜→白银→黄金→铂金→钻石，阈值固定），并在达成里程碑（连续 7 天、首次主观题满分、7 类各有通过、big-data 累计 10 题）时点亮成就。系统 MUST NOT 引入对手、排名或跨人排行榜（单机自用，做了也没数据）。段位与成就 SHALL 只读，不改变题目难度。

#### Scenario: 达成 7 天连续解锁成就
- **WHEN** 连续 7 个自然日各有至少 1 次 pass
- **THEN** `GET /api/progress` 的 `achievements` 含 `{id:'streak-7', unlocked:true}`

### Requirement: 进度可观测
系统 SHALL 提供近 30 天日历（每日 XP/完成题数）与按类别正确率统计，数据源为 `attempts` 表；页面 MUST 在 200ms 内完成首屏渲染（本地接口）。

#### Scenario: 类别正确率
- **WHEN** 用户 `sql` 类别答了 5 题、通过 4 题
- **THEN** 进度页 `byCategory.sql` 显示 `{answered:5, passed:4, accuracy:0.8}`

### Requirement: 本周小结（周口径，不是全历史）
系统 SHALL 在 `/api/progress` 里返回 `week`：以**周一为一周之始**，给出这七天的每日提交数/通过数、本周做过的题数（按题去重）、通过数、计入 XP、按类别的本周正确率，以及本周练过的类别里正确率最低的一类。
**`week.xp` MUST 与顶部"累计 XP"同一条规则**（每题只计本周最好那次 + 本周那几天的成套奖励），界面也要把这条说清楚 —— 若本周按"每次提交累加"，重做同一题会累，出现"本周 368 > 累计 94"这种同屏两个数互相打脸的结果（真实发生过）。每日格子的 `xp` 是"当天提交次数"口径的热度条，与近 30 天日历一致，MUST NOT 被当成周总量。
类别统计 MUST 只列本周真练过的（没练的不占位、不画成 0%），本周什么都没做时 `weakest` MUST 为 `null`（不能编一个"最弱类别"吓唬人）。`needs_human`（评分链故障）MUST NOT 计入本周任何计数——那是基础设施的问题，混进来会把正确率算低。

#### Scenario: 本周不可能大于累计
- **WHEN** 用户本周把同一道题重做三次（fail 2 XP、pass 15 XP、pass 15 XP）
- **THEN** `week.xp === 15`（不是 32），且 `week.answered === 1`

#### Scenario: 上周的失败不拉低本周
- **WHEN** 用户上周三做错一题、本周做的两题全对
- **THEN** `week.accuracy === 1`，`week.answered === 2`

#### Scenario: 什么都没做就说什么都没做
- **WHEN** 本周没有任何提交
- **THEN** `week.answered === 0` 且 `week.weakest === null`，界面显示"这周还没开始"而不是空表格

### Requirement: 判题历史留档与回看
系统 SHALL 为每一次**正式**提交留档逐用例结果（失败用例的期望/实际/报错、通过用例名、失败类型、判题日志）与当时的提交正文，并 SHALL 在题目页提供"提交历史"卡片，按新的在前回看。留档存于 `attempts.detail`（JSON，schema v2），单条序列化后 MUST 不超过 12000 字节；超限时按"日志 → 通过用例名 → 期望/实际 → 评分点与加减分 → 提交正文 → 用例列表"的顺序逐级瘦身，**失败用例名最后才允许丢**。自测（自定义用例）MUST NOT 进历史。迁移前的旧数据没有留档时 MUST 明确显示"这条没有留档"，不得用空用例列表冒充"全部通过"。

#### Scenario: 挂在哪个用例可以回看
- **WHEN** 用户某题提交两次，第一次 3 个用例挂 2 个、第二次全过
- **THEN** 历史卡片列出这两次（新的在前），展开第一次能看到失败用例名、期望与实际

#### Scenario: 超长判题日志不撑爆进度库
- **WHEN** 判题器返回几千行 traceback 与几万字提交
- **THEN** 落库的 `detail` 序列化后 ≤ 12000 字节，且失败用例名仍然读得到

#### Scenario: 旧数据不装成"没挂过"
- **WHEN** 查询一条 schema v1 时代写入的 attempt
- **THEN** 接口返回 `detail: null`，页面显示"这条没有留档"而不是"没有失败用例"
