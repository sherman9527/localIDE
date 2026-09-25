# question-bank Specification

## Purpose
定义题库子系统的结构与生命周期：题目携带来源（JD 或本地 CLI 生成）、入库时间与可追溯字段，内容只增不减、移除只是软删除，新增题目前先建 JD 技术栈知识库，并用反八股/反重复与"仅 senior/principal"闸门挡住低质量题目。它约束 `content/questions/**`、`content/knowledge/**` 与 `scripts/{jd,kb,bank,curriculum}` 的入库流程。

## Requirements

### Requirement: 题目结构与来源可追溯（场景 9/12/19）
题库中每道题 SHALL 为独立 JSON 文件，落在 `content/questions/<category>/<id>.json`，并 MUST 通过 `shared/` 的 `QuestionSchema` 校验，其中 `source.ingestedAt`（入库时间，ISO8601）与 `source.origin`（`manual|jd|cli|history`）为必填；当 `origin` 为 `jd` 时 MUST 至少含一条 `source.jds[]`（`url` + `title` + `crawledAt`），当 `origin` 为 `history` 时 MUST 含 `source.company`（企业高频问答 historically 来源）。`category` MUST 属于 7 类之一：`frontend`、`algorithms`、`sql`、`system-design`、`big-data`、`agent-design`、`hot-interviews`。

#### Scenario: 缺少入库时间的题目被拒绝入库
- **WHEN** 调用 `ingest()` 提交一条没有 `source.ingestedAt` 的题目草稿
- **THEN** 该题被拒绝，`report.rejected[0].errors` 含 schema 报错，且 `content/questions/` 未新增文件

#### Scenario: JD 来源题保留可点击出处
- **WHEN** 刷新脚本从某条 Airbnb 大数据 JD 生成并入库一道题
- **THEN** 题目 JSON 中 `source.company === 'Airbnb'` 且 `source.jds[0].url` 指向该 JD，前端题目页显示"来源：Airbnb · 大数据工程师"

### Requirement: 两条题库来源通路（场景 9）
题库刷新 SHALL 同时支持：(a) **开放 JD**（Apple / Airbnb × 上海 / 美国 × 大数据 / 后端）与 (b) **历史企业高频问答**（`content/jd-cache/history/*.md` 一类可导入语料）。两者都经同一 `ingest()` 入口写入，且在不可联网时 MUST 能用仓库内离线样本跑通全流程。

#### Scenario: 离线样本可出题
- **WHEN** 在无外网环境执行 `npm run bank:refresh -- --offline`
- **THEN** 脚本从 `content/jd-cache/` 读取样本并产出候选题，不因网络失败中断

### Requirement: 题库刷新只增不减（场景 9）
`bank:refresh`、`bank:generate` 与 `bank:add` 脚本 SHALL 以 append-only 方式写入题库：已存在的题目文件 MUST NOT 被覆盖或删除；重复（同 `id` 或同题面 hash）候选 MUST 被跳过而非改写。
`bank:add`（手写题入口）SHALL 复用服务端唯一的 `ingest()` 做校验与落盘，MUST NOT 自己实现一套题目规则（两边规则必然漂移）；
`--dry-run` SHALL 与真实入库走同一段代码（写进临时副本后丢弃），而不是另写一份"预测逻辑"；
单个输入文件解析失败只作废该文件，其余草稿照常处理；有草稿被拒时脚本 MUST 以非零码退出并把 zod 的具体路径报出来。
入库成功后默认自动接跑 `bank:check`（`--no-check` 可跳过）；含代码题时 SHALL 提醒"参考解必须在容器里判过才算数"。

#### Scenario: 手写题重复入库不覆盖
- **WHEN** 把 `content/questions` 里已有的一道题再喂给 `npm run bank:add`
- **THEN** 报告为"跳过：库里已有同 id（不覆盖）"，原文件字节不变，脚本退出码 0

#### Scenario: 坏题不混进库
- **WHEN** 一次提交里既有合规题又有 rubric 权重合计不等于 10 的题
- **THEN** 合规题正常入库、坏题被拒并给出具体路径原因，脚本以非零码退出

#### Scenario: 重复运行刷新脚本不产生重复题也不减少题目
- **WHEN** 连续两次执行 `npm run bank:refresh -- --category big-data`
- **THEN** 第二次 `report` 显示 `added: 0, skippedDuplicate: N`，且 `content/questions/**/*.json` 文件数不小于第一次执行后的数量

#### Scenario: 只增不减不变式被自动化测试锁死
- **WHEN** 执行 `node scripts/check-bank.mjs`
- **THEN** 若当前题目总数少于 `.bank-count` 记录的上一次总数，脚本以非零码退出并列出疑似消失的 id

### Requirement: 题目移除为软删除（场景 10）
系统 SHALL 提供按题目 id 的移除能力：`POST /api/questions/:id/hide` 把 id 追加进 `content/hidden.json`，题目 MUST 从今日挑战与题库列表消失，但物理 JSON 文件 MUST 保留；`DELETE /api/questions/:id/hide` SHALL 恢复显示。

#### Scenario: 移除后不再出现
- **WHEN** 用户在某题详情页点击"移除这题"
- **THEN** 该题 id 出现在 `content/hidden.json`，`GET /api/challenge/today` 与 `GET /api/bank` 的响应都不再包含该题

#### Scenario: 软删除不影响题库文件与统计
- **WHEN** 一道题被隐藏后执行 `git status`
- **THEN** 题目 JSON 文件无改动记录（仅 `content/hidden.json` 变更），且题库总数统计仍计入该题（标记 hidden）

### Requirement: 反八股与反重复闸门（场景 12/11）
`scripts/check-bank.mjs` SHALL 对题库做**内容层面**（非仅结构）校验：每个类别 MUST 有 ≥40% 的题目带 `source.era >= 2025` 或 `modern:*` 标签；`algorithms` 类别中标记 `classic:true` 的重复型老题 MUST ≤15%；同一 `signature`（题面归一化 hash）MUST 唯一。校验不通过即非零退出。

#### Scenario: 类别全是老题时校验失败
- **WHEN** 某类别 10 道题全部无 `modern:*` 标签且 `source.era` 缺失
- **THEN** `npm run bank:check` 以非零码退出并列出该类别与覆盖率

### Requirement: 知识库先于题库（场景 19）
每个类别 SHALL 在 `content/knowledge/<category>/` 下维护考点矩阵（考点、senior 深度要点、当年新实践、可出题形式、对应 JD 能力项），出题脚本 SHALL 以该矩阵为输入并记录每题覆盖的考点。

#### Scenario: 出题前存在考点清单
- **WHEN** 执行 `npm run kb:index`
- **THEN** 生成 `content/knowledge/INDEX.md`，列出各类别考点及"已出题数量"，可据此识别未覆盖考点

#### Scenario: 题目声明覆盖的考点
- **WHEN** 检查任一题目的 JSON
- **THEN** `tags` 非空且至少一个值出现在对应类别的知识库考点清单中
