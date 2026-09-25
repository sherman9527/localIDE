# regression-guard Specification

## Purpose
定义"不许倒退"的工程约束：一条 `verify` 流水线串起 lint、类型、单测、判题参考解自证、题库不变式与 E2E；开发遵循 TDD；跨 session 用 `memo.md` 与 `HANDOVER.md` 保存可验证的记忆。它是需求里"反 regression + 持续开发记忆 + 红线自检"三项治理要求的规范来源。

## Requirements

### Requirement: 统一验证入口与防 regression 流水线（通用 3/4/5）
仓库 SHALL 提供 `npm run verify`，按序执行 lint → typecheck（含测试文件）→ 前端构建与产物预算 → 单元/集成测试（含 shared、bank、regression、server 根级）→ 题库只增不减 → 题库结构校验 → 游戏后端与前端测试 → runner 回归矩阵 → E2E（可用 `SKIP_E2E=1` 跳过），任一步失败即以非零码退出并打印失败阶段。`npm run verify:fast` SHALL 作为 pre-commit 快子集（本仓库的 hook 装在 `.git/hooks/pre-commit`，`npm run hooks:install` 是等价的另一条路）。

流水线 SHALL 覆盖**仓库自带的脚本本身**：`scripts/**/*.mjs` 过 `node --check`、`*.sh` 过 `bash -n`、`start.ps1` 钉住 UTF-8 BOM
（`server/test/regression/scripts-syntax.test.ts`）。理由：增题、判题桥、启动脚本都是"下次手动跑才发现坏了"的东西，
而文档里写"改完要 `node --check`"没有任何强制力 —— 没有闸门的要求等于没有要求。

#### Scenario: 脚本写坏要当场红，而不是下次手动跑才发现
- **WHEN** 有人把 `scripts/` 下某个 `.mjs` 改成语法不合法
- **THEN** `npm run verify:fast` 的单元测试阶段失败并点名该文件

#### Scenario: 破坏 runner 契约即失败
- **WHEN** 修改某 runner 使其把失败用例误报为通过
- **THEN** `npm run verify` 在 runner 回归矩阵阶段失败，退出码非零

#### Scenario: 首屏被拖进重依赖即失败
- **WHEN** 有人把 CodeMirror 或 zod 静态引到入口路径上
- **THEN** `scripts/check-bundle.mjs` 判红并指出超预算的首屏 chunk，`npm run verify:fast` 随之失败

### Requirement: TDD 流程约束（通用 4）
新增行为 SHALL 先有失败测试再有实现；每个判题 runner MUST 有"已知正确解必须 pass + 已知错误解必须 fail 到用例粒度"的双向往返测试（就地写在 `server/test/judge/*.test.ts`）；每个 API MUST 至少一个 happy path 集成测试与一个"答案不泄漏"负向测试。

#### Scenario: 判题器放水会被自证矩阵抓到
- **WHEN** 某 runner 宽松到把带 `naiveSolution` 题目的朴素解也判成 pass
- **THEN** `server/test/regression/reference-solutions.test.ts` 在 `npm run verify` 的矩阵阶段失败；
  `scripts/assert-ran.mjs` 保证这一阶段"整片 skip"也算失败（防止"绿是因为没跑"）

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
