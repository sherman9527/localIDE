# daily-challenge Specification

## Purpose
定义"每日一套"的玩法：用户先选技术栈，系统按日期确定性选题（主菜 + 配菜 + 目标时长），同一天刷新不换题、换天必换题，并记录当日完成态用于连击续签。它约束 `shared/src/day.ts`、`shared/src/game.ts` 的套餐与选题语义与 server 的今日接口。

## Requirements

### Requirement: 每日套餐与选栈（场景 3）
"今日挑战"SHALL 由一个**主栈套餐**（默认 2 道可判分代码题）+ 一个**副栈拓展**（1 道主观题）组成，目标时长 45-60 分钟；
主栈题量 SHALL 按近 7 天正确率微调，但 MUST 落在 1..3 之间、MUST NOT 因为题库里没有的题而"加出来"，
且当日套餐一旦定下（缓存）当天不得改口；调整时 `plan.main.reason` MUST 说明口径（`default` / `adaptive-low` / `adaptive-high`）。
用户 SHALL 能在进入后改选当天要练的技术栈（改选只影响练习池，不改变当日套餐的完成判定）。`GET /api/challenge/today` MUST 只返回作答所需信息（题面、难度、标签、用例、来源公司），MUST NOT 包含参考解或 rubric 权重明细。

#### Scenario: 主栈套餐给出默认 2 道代码题
- **WHEN** 用户请求今日挑战且主栈为 `sql`、近 7 天样本不足
- **THEN** 返回 2 道 `category=sql` 且 `judgeKind ∈ {mysql, redis}` 的题目，每题含题面、难度、标签与来源

#### Scenario: 连续做不好时当天减负
- **WHEN** 近 7 天做过 ≥5 道题且正确率低于 40%
- **THEN** 主栈只排 1 道，`plan.main.reason = 'adaptive-low'`，今日页明确说明"最近正确率偏低，今天主栈降到 1 题"

#### Scenario: 单独练某个栈不改变套餐完成判定
- **WHEN** 用户额外进入 `/bank` 自由练习 5 道 big-data 题
- **THEN** 今日套餐完成状态只由套餐内 3 题决定，自由练习只累加 XP

#### Scenario: 测试用例提前可见但参考解不可见（场景 3/4）
- **WHEN** 用户请求一道算法题的今日挑战数据
- **THEN** 响应包含全部 `cases`（`name`/`input`/`expected`）以便只按结果作答，但不含 `runner.referenceSolution`

#### Scenario: 答案只从题目详情出，今日套餐不带（红线 C7）
- **WHEN** 检查 `GET /api/challenge/today`、`GET /api/bank`、`POST /api/judge` 与 `GET /api/attempts` 的响应
- **THEN** 响应中不存在 `runner.referenceSolution`、`answer` 字段与 `rubric.points` 权重明细
- **AND** 参考答案仅在 `GET /api/questions/:id` 的 `reference` 里给出（见 web-client 规格"题目详情页提供参考答案"）

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

### Requirement: 错题按间隔重复回到套餐（WI-41）
答错或判失败的题 SHALL 进入错题本，并按 `1 / 3 / 7 / 14 / 30 / 60` 天的间隔回到后续每日套餐：每次**顶掉一个槽位**而不是追加，
所以每日题量、套餐完成判定与 XP 上限都不变。排期 SHALL 采用 pass/fail 的二值退化 —— 完整 SM-2 需要 0-5 的"回忆质量"人为评分，
本系统没有这个输入，因此 pass 升一档、fail 跌回第一档，且要连续两次 pass 才升档。评分链故障导致的 `needs_human` MUST NOT 计为错题。
`GET /api/challenge/today` MUST 用 `reviewIds` 标出哪些题是复习；`GET /api/progress` MUST 返回错题本统计（在册 / 今日到期 / 最久没碰）。

#### Scenario: 到期复习题顶掉一个槽位
- **WHEN** 昨天答错的题今天到期，而今日套餐已排好 2 主 1 副
- **THEN** 响应仍是 3 题，其中该复习题替换掉主栈最后一道新题，且它的 id 出现在 `reviewIds` 里

#### Scenario: 复习不改变每日题量与奖励口径
- **WHEN** 用户完成了一个含复习题的当日套餐
- **THEN** 套餐完成判定与"完成今日套餐 +10"的口径和 3 道全新题时完全一致
