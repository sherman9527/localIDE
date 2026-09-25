## ADDED Requirements

### Requirement: XP 与连续天数（场景 2）
系统 SHALL 按固定规则累计 XP：可执行题 `pass` 得 15、`fail` 得 2（安慰奖）、`error` 得 0；主观题得 `round(score / maxScore * 20)`；完成当日套餐额外 +10。连续天数（streak）SHALL 以"当日 XP ≥ 20"为续签门槛（即至少做成 2 道题），**答 1 题不足以续签**，避免打卡注水；中断则重置为 1；同一题的 XP 只计历史最佳一次。

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
