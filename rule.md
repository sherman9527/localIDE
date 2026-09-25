# 红线规则（rule.md）

> 本文件是**硬约束**。开发者（人或 agent）新增红线时往 `## 红线` 追加一条；
> **做所有 change 之前必须先检查本次改动是否违反红线**（需求文档第 6 条）。
> 默认没有红线 —— 下面的列表由用户在使用过程中逐条添加。

## 红线

<!-- 暂无红线。追加格式： -->
<!-- - R1｜<一句话约束>｜违反后果｜检查方式（可执行命令优先） -->

## 变更自检清单（每次改动前逐条过一遍，非红线但属需求硬约束）

- [ ] **C1 目录自包含**：所有产物（含 Docker 构建上下文、镜像缓存、SQLite 数据、判题工作区）都落在本仓库目录内。
- [ ] **C2 单镜像**：任何新技术栈依赖都写进 `docker/Dockerfile`，不新增第二个业务镜像。
- [ ] **C3 依赖源顺序**：国内镜像 → 官方源 → 源码编译（npm=registry.npmmirror.com，pip=pypi.tuna.tsinghua.edu.cn，apt=mirrors.aliyun.com，maven=maven.aliyun.com）。
- [ ] **C4 题库/游戏解耦**：`server/src/bank/**` 不得 import `server/src/game/**`；跨层只经 `shared/` 契约。
- [ ] **C5 题库只增不减**：刷新/生成脚本不得删除或覆盖已有题目文件；移除=软删除写 `content/hidden.json`。
- [ ] **C6 结果导向判题**：代码题只看用例结果，失败必须回传 `通过数/失败数/失败用例名`。
- [ ] **C7 答案只从题目详情一个口子出**：参考答案（`answer`）与参考解（`runner.referenceSolution`）**只在 `GET /api/questions/:id` 的 `reference` 字段**面向答题者给出 —— 答前可看是 2026-09-21 用户拍板的产品口径（本条原为"任何响应都不得包含参考解"）。除详情外的响应（今日套餐、题库列表、判题、评分、提交历史）MUST NOT 带 `answer` / 参考解；rubric 的 `points` / `criteria` 权重明细仍 MUST 只在答完并评分后才展开（提前给出等于教评分模型怎么被糊弄）。检查方式：`npx vitest run server/test/api`（`expectNoAnswerLeak` 覆盖各处，详情端点那条只许检 `question` 本体，防止有人把 `reference` 直接塞进 `publicQuestion`）。题库列表在 N-15 之后连 `statement` / `cases` 内容都不带（只有 `caseCount`），"少带一类字段就少一次失手"；体积与字段面由 `server/test/bank/content.test.ts`（真题库上量比例）与 `server/test/api/api.test.ts`（字段白名单）两头钉住。
- [ ] **C8 难度红线**：题目只对标 senior / principal，且必须含当年新实践，不灌八股。
- [ ] **C9 TDD**：先写失败测试再写实现；新增 runner 必须带"已知正确解 + 已知错误解"双向往返测试。
- [ ] **C10 收尾必验证**：声称完成前跑 `./start.sh --verify`（容器内判题矩阵）+ 宿主 `npm run e2e`，并把输出摘要写进 `memo.md`。

## 违反红线时的处置

1. 立即停止该 change；
2. 在 `memo.md` 记录：违反了哪条、为什么、如何回滚（`git revert`/`git restore`）；
3. 优先改成不违反红线的方案，而不是申请豁免。
