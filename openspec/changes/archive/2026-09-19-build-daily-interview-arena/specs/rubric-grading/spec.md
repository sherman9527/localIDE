## ADDED Requirements

### Requirement: 主观题本地 CLI 评分（场景 8）
系统设计题、架构题、agent 设计题、高频面试题 SHALL 使用 `llm-rubric` 判分：以题目 `rubric`（`maxScore` 固定 10、`points[{label,weight}]`）与候选人答案构造 prompt，调用**本机已登录 CLI**完成评分，MUST NOT 调用需要额外云端密钥的服务作为默认路径。评分结果 SHALL 为 `{score, maxScore, bonus[], gaps[], provider}`，其中 `bonus` 为加分点、`gaps` 为不足之处。

#### Scenario: 正常评分返回 10 分制与加分/不足点
- **WHEN** 用户提交一段系统设计答案并点击"评分"
- **THEN** 返回 `{score:8, maxScore:10, bonus:[...], gaps:[...], rubricBreakdown:[{label,hit,earned,nextStep}], provider:'qodercli'}`

#### Scenario: 逐项 rubric 反馈（反馈密度是主观题的价值的来源）
- **WHEN** 评分完成并展示结果
- **THEN** 页面按 rubric 每个考点显示"命中/未命中 + 得分 + 一句为什么 + 下一句该补什么"，并显示 provider 与耗时（避免长时间等待像卡死）

#### Scenario: provider 降级链
- **WHEN** `qodercli` 调用失败（非零退出或输出无法解析为 JSON）
- **THEN** 自动改用 `copilot`；若 `copilot` 也不可用，则返回 `{provider:'manual'}` 并展示 rubric 自检清单让用户逐项确认

#### Scenario: 分数越界被 clamp
- **WHEN** provider 返回 `score:14`（`maxScore:10`）
- **THEN** 落库分数为 10，且 `raw` 字段保留原始响应以便排查

### Requirement: 评分可追溯与稳定性（软约束）
评分 SHALL 记录 `provider`、`model`（若可得）、`raw` 与耗时到 `attempts` 表。稳定性只做**可解析性**硬校验（输出必须是合法 JSON 且分数在 0..maxScore 内，否则视为该 provider 失败并降级）；分数漂移属随机系统的正常波动，SHALL NOT 作为流水线红灯，仅在 `memo.md` 抽样记录波动幅度。

#### Scenario: 输出不可解析即降级而不失败
- **WHEN** provider 返回一段不含 JSON 的自然语言
- **THEN** 该 provider 判为失败并降级到下一档；全部失败时返回 `provider:'manual'` 的自检表，接口不报 5xx

### Requirement: 提示词与题目内容边界
评分 prompt SHALL 只包含题面、rubric 与候选人答案，MUST NOT 包含其他题目内容或本机文件路径。主观题的 `rubric.points`（权重与判据）在**作答前** MUST NOT 出现在对外响应中，评分完成后 SHALL 展开（反馈需要具体判据）。

#### Scenario: 作答前不泄漏权重、评分后展开
- **WHEN** 解答题目前请求主观题详情
- **THEN** 响应只含 `rubric.maxScore` 与 `pointLabels`，不含 `points[].weight`
- **AND** 评分完成后的结果视图包含完整 `points`（标签 + 权重 + 命中情况）
