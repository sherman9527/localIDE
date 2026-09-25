## ADDED Requirements

### Requirement: 统一验证入口与防 regression 流水线（通用 3/4/5）
仓库 SHALL 提供 `npm run verify`，按序执行 lint → typecheck → 单元/集成测试 → 题库结构校验 → runner 回归矩阵 → E2E（可用 `SKIP_E2E=1` 跳过），任一步失败即以非零码退出并打印失败阶段。`npm run verify:fast` SHALL 作为 pre-commit 快子集。

#### Scenario: 破坏 runner 契约即失败
- **WHEN** 修改某 runner 使其把失败用例误报为通过
- **THEN** `npm run verify` 在 runner 回归矩阵阶段失败，退出码非零

### Requirement: TDD 流程约束（通用 4）
新增行为 SHALL 先有失败测试再有实现；每个判题 runner MUST 有"已知正确解 + 已知错误解"双向往返测试；每个 API MUST 至少一个 happy path 集成测试与一个"答案不泄漏"负向测试。

#### Scenario: 缺测试的新 runner 不被接受
- **WHEN** 新增 `judgeKind` 但未提供 `tests/fixtures/submissions/<kind>/{correct,wrong}`
- **THEN** `scripts/verify.sh` 的 fixture 覆盖检查报错并列出缺失项

### Requirement: 题库不变式校验
`scripts/check-bank.mjs` SHALL 校验：全量题目通过 `QuestionSchema`；7 类别各 ≥3 题；代码题 `cases.length >= 3`；主观题 `rubric.maxScore === 10` 且 `points` 非空；每题 `source.ingestedAt` 存在；题库总数不少于 `.bank-count` 记录值（只增不减）。

#### Scenario: 题目数下降即失败
- **WHEN** 有人手工删除一个题目文件后执行 `npm run bank:check`
- **THEN** 脚本以非零码退出并指出减少的类别与 id

### Requirement: 跨 session 记忆与工作板（通用 3/5/6）
仓库 SHALL 维护 `memo.md`（按里程碑追加"做了什么/验证/已知问题/下一步"）、`HANDOVER.md`（COMPLETED / IN PROGRESS / TODO 三段 work item 板）与 `rule.md`（红线）。完成项 MUST 从 TODO 移除并入 COMPLETED；新需求 MUST 新增 WI；砍功能 MUST 删 WI 并在 `memo.md` 记原因；做 change 前 MUST 先读 `rule.md`。

#### Scenario: 新 session 可冷启动
- **WHEN** 新 agent 进入仓库且只读 `memo.md` + `HANDOVER.md` + `rule.md` + `openspec status`
- **THEN** 能确定当前进度、下一条待做 WI、以及不可触碰的约束，无需追问

#### Scenario: 红线变更可追溯
- **WHEN** 用户要求新增一条红线
- **THEN** `rule.md` 的 `## 红线` 追加一条带编号的约束，且 `memo.md` 记录变更时间与原因
