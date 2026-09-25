## ADDED Requirements

### Requirement: 每日套餐与选栈（场景 3）
"今日挑战"SHALL 由一个**主栈套餐**（2 道可判分代码题）+ 一个**副栈拓展**（1 道主观题）组成，目标时长 45-60 分钟；用户 SHALL 能在进入后改选当天要练的技术栈（改选只影响练习池，不改变当日套餐的完成判定）。`GET /api/challenge/today` MUST 只返回作答所需信息（题面、难度、标签、用例、来源公司），MUST NOT 包含参考解或 rubric 权重明细。

#### Scenario: 主栈套餐给出 2 道代码题
- **WHEN** 用户请求今日挑战且主栈为 `sql`
- **THEN** 返回 2 道 `category=sql` 且 `judgeKind ∈ {mysql, redis}` 的题目，每题含题面、难度、标签与来源

#### Scenario: 单独练某个栈不改变套餐完成判定
- **WHEN** 用户额外进入 `/bank` 自由练习 5 道 big-data 题
- **THEN** 今日套餐完成状态只由套餐内 3 题决定，自由练习只累加 XP

#### Scenario: 测试用例提前可见但参考解不可见（场景 3/4）
- **WHEN** 用户请求一道算法题的今日挑战数据
- **THEN** 响应包含全部 `cases`（`name`/`input`/`expected`）以便只按结果作答，但不含 `runner.referenceSolution`

#### Scenario: 答案不泄漏（红线 C7）
- **WHEN** 检查 `GET /api/challenge/today` 与题目详情响应
- **THEN** 响应中不存在 `runner.referenceSolution`、`answer` 字段与 `rubric.points` 权重明细

### Requirement: 按日期确定性选题（场景 4）
同一天同一类别的选题结果 SHALL 是确定性的：以 `YYYY-MM-DD` + `categoryId` 为种子（FNV-1a + mulberry32）从可见题库中洗牌取题；跨天 SHALL 产生不同组合；若存在 30 天排课文件 `content/curriculum/*.json`，SHALL 优先按排课取题。

#### Scenario: 同日重复请求题目一致
- **WHEN** 同一天两次请求 `GET /api/challenge/today?category=sql`
- **THEN** 两次返回的题目 id 列表完全相同

#### Scenario: 跨天题目变化
- **WHEN** 把日期从 `2026-09-19` 注入为 `2026-09-20` 后请求同一类别
- **THEN** 题目 id 列表与前一天不同

#### Scenario: 已移除题目不入池
- **WHEN** 某题被软删除后再次请求今日挑战
- **THEN** 返回结果不含该题，并从候补池补足到约定题量

### Requirement: 当日完成态
系统 SHALL 记录当天作答情况：`GET /api/progress` MUST 返回 `todayDone`、当日 XP、连续天数与近 30 天日历，用于今日挑战页的完成态展示。

#### Scenario: 全部通过后显示完成态
- **WHEN** 用户当天把所选类别的 3 题都判为 pass
- **THEN** 今日挑战卡片显示"今日已完成"并展示 XP 与 streak 增量
