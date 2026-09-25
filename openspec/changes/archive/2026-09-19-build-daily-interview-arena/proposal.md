## Why

市面上刷题工具要么只有算法题、要么只有八股文，且都不在本机跑真代码。本人准备 Apple / Airbnb 上海与美国 office 的 senior/principal 级面试（大数据 + 后端），需要一个**每天打开就能练、7 个技术栈真跑判分、主观题用本地 CLI 评分、题库随 JD 持续刷新**的自托管游戏化系统（requirement.txt 通用 1-9 / 场景 1-20）。

## What Changes

- 新增 `content/` 题库子系统：知识库先行（场景 19）、JSON 题目 append-only 入库、`ingestedAt` + JD 来源、软删除（场景 7/10/21/22）。
- 新增 `shared/` 契约层：`Question` zod schema + 判题协议，作为题库与游戏的唯一解耦边界（场景 7）。
- 新增 `server/src/judge/` 判题引擎：Java(JUnit5) / React+TS(vitest) / MySQL / Redis / PySpark 五类真跑 runner，失败回传通过数、失败数、失败用例名（场景 3/16）。
- 新增 `server/src/llm/` 主观题评分：`qodercli → copilot → manual` 降级链，输出 10 分制 + 加分点 + 不足点（场景 8）。
- 新增 `server/src/game/` 游戏编排：今日挑战按日期确定性选题、XP/streak/成就、错题反馈（场景 2/4）。
- 新增 `web/` React 19 + Vite 浅色高流畅度客户端（含移除按钮、用例级结果展开）（场景 5/10/17）。
- 新增 `docker/Dockerfile` **单镜像**多技术栈运行时 + `start.sh` / `start.ps1` + compose 端口映射到本地（通用 7/8/9、场景 6/18）。
- 新增 `scripts/` 防 regression 流水线（`verify.sh` + runner 双向往返回归矩阵 + 泄漏测试）与题库刷新脚本（JD 抓取 + 本地 CLI 出题）（通用 3/4、场景 9/23）。
- 新增治理产物：`rule.md`（红线）、`memo.md`（跨 session 记忆）、`HANDOVER.md`（work item 工作板）、`.qoder/skills/handover`（通用 3/5/6）。
- 新增第一版内容：7 类别 × ≥13 题（目标 ~95 题）+ 30 天排课（场景 11/12/24/25）。

## Capabilities

### New Capabilities

- `question-bank`: 题目结构、知识库先行、append-only 入库、JD 来源与入库时间、软删除。
- `daily-challenge`: 今日挑战入口、按技术栈选题、日期确定性、排课与已移除题剔除。
- `code-judging`: 结果导向真跑判题（Java/React/MySQL/Redis/PySpark）与沙箱隔离、失败用例反馈。
- `rubric-grading`: 主观题 LLM 评分（10 分制 + 加分点 + 不足点）与 provider 降级链。
- `progress-gamification`: XP、streak、league、成就、日历与正确率统计。
- `web-client`: React 浅色界面、代码编辑器、流畅度约束、移除按钮。
- `container-runtime`: 单镜像多技术栈、启动脚本、本地端口映射、依赖源优先级。
- `regression-guard`: verify 流水线、runner 回归矩阵、题库只增不减不变式、跨 session 记忆。

### Modified Capabilities

_(无 —— 首个 change，`openspec/specs/` 目前为空。)_

## Non-goals

- 不做多用户 / 账号体系 / 排行榜跨人对战（单机单人使用，场景 1）。
- 不做移动端 App；不做在线判题云服务（所有执行都在本机容器内）。
- 不做 Flink / Scala-Spark 的**真跑**判分（镜像体积与启动成本不划算）→ 这两个方向走 `llm-rubric` 评分；Flink 只出概念题与设计题。
- 不做题目编辑器后台 UI；题目通过 JSON 文件 + 脚本维护（git 即审计日志）。
- 不引入 Kubernetes / CI 平台；验证入口只有一个 `npm run verify`。

## Impact

- 代码：新增 `shared/`、`server/`、`web/`、`scripts/`、`docker/`、`content/`、`tests/` 七个 workspace/目录。
- 依赖：npm workspaces（React、Vite、Fastify、CodeMirror、vitest、playwright、ioredis、zod）；Python `pyspark==3.5.5`；apt `mysql-server`、`redis-server`、`openjdk-17`；均走国内镜像源。
- 运行：`docker compose` 起 1 个容器（7788 端口），容器内自管 mysqld/redis-server；本机数据落在 `./data/`（git 忽略）。
- 外部：判题与评分需要本机 `qodercli`（已实测可用）；JD 刷新需外网，不可达时降级为仓库内 `content/jd-cache/` 样本。
- 风险：见下表。

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| Docker Hub 不通 | 无法构建 | `FROM docker.m.daocloud.io/...`，`docker/mirrors.sh` 集中切换 |
| Spark JVM 冷启动 10-20s | 判题体验卡 | 常驻 `spark_worker.py` 会话池 + 前端进度态 |
| 原生 npm 模块下载失败 | 装不上依赖 | 持久层用内置 `node:sqlite`；Redis 用纯 JS `ioredis` |
| `copilot` CLI 非交互参数未实测 | 评分降级 | provider 命令模板可配置 + `manual` 兜底 |
| 题量 ~95 且需 senior 深度 | 内容质量 | 知识库先行 + `check-bank.mjs` 卡门槛 + 参考解必过 runner |
| JD 抓取被墙 | 刷新失效 | 离线样本 + 重试退避，脚本可切在线 |
