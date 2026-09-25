## 1. 基线与规格（WI-01 / WI-02）

- [x] 1.1 git init、`.npmrc`(npmmirror)、`.gitignore`、`.editorconfig`、`rule.md`、`memo.md`、`HANDOVER.md` 落地 —— 验证：`git log --oneline` 有 baseline commit
- [x] 1.2 `openspec init --tools qoder` + `config.yaml` 项目上下文 + change `build-daily-interview-arena` proposal/design/specs —— 验证：`openspec validate build-daily-interview-arena --strict`
- [x] 1.3 创建本地 `handover` skill（`.qoder/skills/handover/SKILL.md`）—— 验证：skill 出现在可用列表且规则与工作板一致

## 2. 契约层（WI-03）

- [x] 2.1 `shared/`：`QuestionSchema`、`JudgeResult`、`CATEGORY_IDS`、`JUDGE_KINDS` —— 验证：`npx vitest run shared` 先红后绿
- [x] 2.2 `pickForDay` 日期确定性选题 + 纯函数测试 —— 验证：同日两次 deep-equal、跨日不等

## 3. 单镜像运行时（WI-04）

- [x] 3.1 `docker/mirrors.sh` + `docker/Dockerfile`（ubuntu:22.04 + mysql-server + redis-server + openjdk-17 + maven + python3/pyspark + node24 + junit jar）
- [x] 3.2 `docker/entrypoint.sh` 拉起 mysqld/redis 并等待就绪；`compose.yml` 映射 7788 与 `./data`
- [x] 3.3 `start.sh` / `start.ps1` 等待健康检查并打印地址 —— 验证：`docker run` 内 `java -version`、`pyspark --version`、`mysqladmin ping`、`redis-cli ping` 全通过；`memo.md` 记录镜像体积

## 4. 题库子系统（WI-05）

- [x] 4.1 `content/knowledge/<cat>/README.md` 考点矩阵（7 类）+ `scripts/kb/compile-knowledge.mjs` 生成 INDEX
- [x] 4.2 `server/src/bank/loader.ts`（逐文件 zod 校验、坏文件不阻断）+ 测试
- [x] 4.3 `server/src/bank/ingest.ts`（append-only、去重 hash、ingestedAt）+ 测试
- [x] 4.4 `server/src/bank/hide.ts` 软删除 + 测试（hide 后不入池）
- [x] 4.5 只增不减不变式测试 —— 验证：`npx vitest run server/test/bank`

## 5. 判题引擎（WI-06 ~ WI-09）

- [x] 5.1 `judge/workspace.ts` + `registry.ts`（统一 `runJudge`、超时、清理）
- [x] 5.2 `runners/java-junit.ts` + `tests/fixtures/java/*` + 双向往返测试
- [x] 5.3 `runners/react-vitest.ts`（复用镜像 node_modules，免 install）+ 双向往返测试
- [x] 5.4 `runners/mysql.ts`（`arena_<n>` 独立库、TSV 结果结构化比较、语句白名单）+ 测试
- [x] 5.5 `runners/redis.ts`（ioredis、独立 db index、命令白名单）+ 并发隔离测试
- [x] 5.6 `runners/pyspark.ts` + `spark_worker.py`（常驻会话池、90s 超时重启）+ 测试
- [x] 5.7 资源泄漏测试（20 次判题后 `data/judge` 为空、无 `arena_%` 库残留）

## 6. 评分与游戏后端（WI-10 / WI-11）

- [x] 6.1 `llm/rubric.ts` + providers（qodercli 已实测 / copilot / manual）+ 解析与 clamp 测试 + 三次漂移 ≤1 测试
- [x] 6.2 `db/index.ts`（`node:sqlite`、migrations、`attempts`/`days`/`settings`）
- [x] 6.3 `game/daily.ts` + `xp.ts` + `streak.ts` + `achievements.ts` + 单元测试（注入时钟）
- [x] 6.4 `api/app.ts` 路由：health / categories / challenge/today / judge / grade / progress / hide —— 验证：Supertest 集成测试含"答案不泄漏"负向用例

## 7. 前端（WI-12）

- [x] 7.1 `web/` Vite+React 骨架、`tokens.css` 浅色变量与亮度断言测试
- [x] 7.2 今日挑战页（7 类别卡 + 完成态）、答题页（CodeMirror + 用例面板 + 移除按钮）
- [x] 7.3 进度页（XP/streak/成就/30 天日历/类别正确率）与题库浏览页（筛选、显示已移除）
- [x] 7.4 流畅性：>50 条列表虚拟化、SWR 数据 hook、仅 transform/opacity 动画

## 8. 内容与验证（WI-13 ~ WI-15）

- [x] 8.1 `scripts/verify.sh` + `verify:fast` + `.githooks/pre-commit` + fixture 覆盖检查
- [x] 8.2 runner 回归矩阵测试（所有参考解 pass / 所有错误 fixture fail）
- [x] 8.3 Playwright E2E：今日挑战→提交正确解→XP 增长；错误解→失败用例可见；移除→刷新后消失
- [x] 8.4 `scripts/jd/*`（Apple/Airbnb × 上海/美国 × 大数据/后端，含离线降级）+ `scripts/bank/generate-with-cli.mjs`
- [x] 8.5 第一版题库：7 类别各 ≥13 题（senior/principal + 2026 新实践 + 参考解/rubric + JD 来源）
- [x] 8.6 30 天排课 `content/curriculum/2026-10.json`
- [x] 8.7 容器内 `npm run verify` 全绿 + 7 类题真人手各做 1 题并截图记分到 `memo.md`
- [x] 8.8 `README.md` / `docs/ARCHITECTURE.md` / `docs/JUDGING.md` / `docs/ADD_QUESTIONS.md` + `openspec archive` + `git tag v0.1.0`
