# Daily Interview Arena（本地每日刷题系统）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `localLearning/` 单目录内交付一个 Docker 启动的、leetcode + 多邻国体验的 senior/principal 级每日刷题系统（7 个技术栈类别、真跑测题 + LLM 主观题评分、可只增不减刷新的题库）。

**Architecture:** 三层解耦——`content/`（题库系统：JSON 文件 + 知识库，append-only）→ `shared/`（唯一契约层：题库 schema + 判题协议）→ `server/`（游戏系统：Fastify + node:sqlite，负责每日挑战编排、判题调度、进度/XP/streak）。`web/`（React 19 + Vite）只走 HTTP API。判题用 runner 注册表：每种 `judgeKind` 一个 runner，全部在同一个 Docker 镜像内执行（MySQL/Redis/Spark 由镜像内的服务承担），主观题走本地 CLI（qodercli → copilot → manual 降级）。

**Tech Stack:** Docker (ubuntu:22.04 base, 单镜像多技术栈) / Node 24 + TypeScript + Fastify + node:sqlite / React 19 + Vite 7 + CodeMirror 6 / Vitest + Supertest + Playwright / OpenJDK 17 + JUnit 5 standalone / Python 3.10 + PySpark / MySQL 8 + Redis / openspec CLI。

**Spec:** `requirement.txt`（原始需求 20+20 条）、`openspec/changes/build-daily-interview-arena/`（能力规格）、`docs/superpowers/plans/2026-09-19-daily-interview-arena.md`（本文件）。

## Global Constraints

- 全部产物落在**仓库根目录内**（含 Docker 构建上下文与镜像缓存路径）；不在其他目录留依赖（req 14/17）。
- **单镜像**承载所有技术栈依赖（req 18/19）：Node、JDK、Python+PySpark、MySQL、Redis、Scala/Spark jars。
- 依赖源优先级：**国内镜像 → 官方源 → 源码编译**。`.npmrc`=registry.npmmirror.com；pip=index.tuna.tsinghua.edu.cn；apt=mirrors.aliyun.com；maven=maven.aliyun.com；Playwright binary=cdn.npmmirror.com/mirrors/playwright（req 7/8）。
- Docker Hub 直连不可用（实测 000）。基础镜像必须走 `docker.m.daocloud.io/library/...`（daemon 已配 3 个 mirror）。
- 题库与游戏系统**解耦**：题库侧不得 import 游戏侧代码，只能通过 `shared/` 契约（req 17）。
- 题目 append-only：刷新只增不减（req 21）；"移除"是软删除写进 `content/hidden.json`，物理 JSON 不删（req 22）。
- 难度对标 senior/principal，覆盖当年新技术，禁止纯八股（req 23/24）。
- 前端 React，浅色主题（配色亮度 ≥ L* 70 的底色），交互不卡顿（req 29）。
- TDD：先写失败测试再实现；每个 runner 必须有"已知正确解 + 已知错误解"双向往返测试（req 4/5）。
- 每次改动前检查 `rule.md` 红线；每次里程碑写 `memo.md`；work item 状态由 `HANDOVER.md` 承载（req 3/6）。
- 未做 E2E 通过不得声称完成（req 25）。

---

## 文件结构（先定分解，再定任务）

```
localLearning/
├── requirement.txt              # 原始需求（只读）
├── rule.md                      # 红线（默认空）
├── memo.md                      # 记忆机制：开发/测试结果持续追加
├── HANDOVER.md                  # handover 工作板：done / doing / todo
├── README.md                    # 30 秒启动说明
├── package.json                 # npm workspaces: shared, server, web, tests
├── .npmrc  .gitignore  .editorconfig  start.sh  start.ps1
├── docker/
│   ├── Dockerfile               # 单镜像：mysql8 + redis + jdk17 + python/pyspark + node24
│   ├── entrypoint.sh            # 拉起 mysqld/redis-server + 可选 dev/prod
│   └── playwright-mirror.env
├── compose.yml                  # 端口映射到本地 + 挂载当前目录
├── openspec/                    # openspec init --tools qoder 生成
│   ├── project.md
│   ├── specs/<capability>/spec.md
│   └── changes/build-daily-interview-arena/{proposal.md,tasks.md,design.md,specs/}
├── .qoder/skills/handover/SKILL.md   # 本地 handover skill（市场无此包 → 自建）
├── shared/                      # 契约层（题库 schema + 判题协议），无业务逻辑
│   ├── src/{question.ts,judge.ts,taxonomy.ts,day.ts,index.ts}
│   └── test/*.test.ts
├── content/
│   ├── knowledge/<category>/*.md      # 先知识库（req 31）
│   ├── questions/<category>/*.json    # 题库（append-only）
│   └── hidden.json                      # 软删除集合
├── server/
│   ├── src/
│   │   ├── bank/{loader.ts,ingest.ts,hide.ts,monotonic.ts}   # 题库侧
│   │   ├── judge/{registry.ts,workspace.ts,runner.util.ts,runners/*}
│   │   ├── llm/{provider.ts,rubric.ts,providers/*}           # qodercli/copilot/manual
│   │   ├── game/{daily.ts,progress.ts,xp.ts,streak.ts}
│   │   ├── db/{index.ts,migrations.ts}
│   │   ├── api/{app.ts,routes/*}
│   │   └── config.ts
│   └── test/{bank,judge,game,api}/*.test.ts
├── web/
│   ├── index.html  vite.config.ts  tsconfig.json
│   └── src/{main.tsx,App.tsx,pages/*,components/*,api.ts,styles/*}
├── scripts/
│   ├── verify.sh                # 防 regression 总入口
│   ├── bootstrap-registry.sh    # 镜像源写入 + 探测
│   ├── jd/refresh-bank.mjs      # JD 抓取 → 候选题（append-only）
│   ├── jd/fetch-apple.mjs  jd/fetch-airbnb.mjs  jd/sources.json
│   ├── kb/compile-knowledge.mjs # 知识库 md → 索引/考点清单
│   └── bank/generate-with-cli.mjs  # 用本地 CLI 扩题（req 21）
├── tests/
│   ├── e2e/*.spec.ts            # Playwright
│   └── fixtures/{answers,submissions}/*      # 已知对/错参考解
└── .githooks/pre-commit         # 快子集校验
```

---

## Task 1: 仓库基线与治理文件（git / 镜像源 / rule.md / memo.md）

**Files:**
- Create: `package.json`, `.npmrc`, `.gitignore`, `.editorconfig`, `README.md`, `rule.md`, `memo.md`, `HANDOVER.md`
- Create: `.githooks/pre-commit`

**Interfaces:**
- Produces: npm workspaces 根（`shared`/`server`/`web`/`tests` 四个 workspace 名）；`npm run verify` 脚本入口（Task 13 落地实现）。

- [ ] **Step 1: `git init` + 首次配置**

```bash
git init -b main
git config user.name "Daily Arena Bot"; git config core.hooksPath .githooks
```

- [ ] **Step 2: 写 `.npmrc`（国内源优先，官方兜底）**

```ini
registry=https://registry.npmmirror.com
fetch-retries=5
fund=false
audit=false
```

- [ ] **Step 3: 写根 `package.json`（workspaces + scripts 骨架）**

`"workspaces": ["shared","server","web","tests"]`；scripts: `dev`,`build`,`test`,`verify`,`bank:refresh`,`e2e`。子包 script 先指向 `echo TODO`（Task 13 替换为真实命令）。

- [ ] **Step 4: 写 `rule.md`（默认无红线，留模板与自检约定）**

内容：`## 红线`（空列表）+ `## 变更自检`（列 Global Constraints 的 8 条硬约束）+ 追加格式说明。任何 agent 改代码前必须 Read。

- [ ] **Step 5: 写 `memo.md`（记忆机制格式）**

约定：`## [日期] [里程碑]` 段，字段 `做了什么 / 测试结果(命令+输出摘要) / 已知问题 / 下一步`。首条记录本次环境勘察结论（docker mirror、qodercli -p 可用、npm mirror 200）。

- [ ] **Step 6: 写 `HANDOVER.md` 工作板**

三段：`COMPLETED`、`IN PROGRESS`、`TODO`，每行 `- [ ] WI-01 <描述> (owner, 状态)`。**约定**：完成即从 TODO 移除并追加到 COMPLETED；新需求新增 WI；砍功能则删除 WI 并在 `memo.md` 记原因。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "chore: repo baseline, mirrors config, governance docs"
```

Expected: `git log --oneline` 有 1 条。

---

## Task 2: OpenSpec 规格化 + handover skill 落地

**Files:**
- Create: `openspec/`（CLI 生成）、`openspec/project.md`（覆写）
- Create: `openspec/changes/build-daily-interview-arena/{proposal.md,design.md,tasks.md,specs/*/spec.md}`
- Create: `.qoder/skills/handover/SKILL.md`

**Interfaces:**
- Produces: 8 个 capability 名（`question-bank`, `daily-challenge`, `code-judging`, `rubric-grading`, `progress-gamification`, `web-client`, `container-runtime`, `regression-guard`），后续 spec/task 引用用这套命名。

- [ ] **Step 1: 初始化（qoder 工具链，非交互）**

```bash
openspec init --tools qoder --force .
```

Expected: 生成 `openspec/`、`AGENTS.md`(或 `.qoder/` 指令文件)，含 project 约定。

- [ ] **Step 2: 覆写 `openspec/project.md`**

写 Tech Stack、Conventions（TS strict、`node:` 前缀内置模块、runner 注册表模式）、以及 Global Constraints 全量（含"单镜像""append-only 题库""国内源优先"）。

- [ ] **Step 3: 写 change proposal**

`proposal.md`：Why / What Changes / Impact（列出 8 个 capability 的 ADDED Requirements）；`design.md`：架构图 + 三个关键决策（MySQL/Redis 走镜像内真实服务而非 testcontainers；`node:sqlite` 免原生编译；主观题三档降级 provider）。

- [ ] **Step 4: 写 8 份 delta spec（每条 Requirement 至少 1 个 `#### Scenario`）**

`question-bank`：入库含 `ingestedAt`+`source.jds[]`；刷新只增不减；软删除后不再出现。
`daily-challenge`：同日同 stack 选取确定性一致；已移除题不入池。
`code-judging`：结果导向题只判结果；失败返回 `passed/failed/失败用例名`。
`rubric-grading`：满分 10、得分、加分点、不足点，provider 降级链。
`progress-gamification`：streak/XP/成就 计算规则。
`web-client`：浅色主题、不卡顿（交互 <100ms 反馈）、移除按钮。
`container-runtime`：单镜像多栈、start 脚本、端口映射本地。
`regression-guard`：`npm run verify` 必过；runner 双向往返测试。

- [ ] **Step 5: 校验并归档任务清单**

```bash
openspec validate build-daily-interview-arena --strict && openspec status
```

Expected: `Change 'build-daily-interview-arena' is valid`。

- [ ] **Step 6: 建 handover skill（市场无 openspec/handover 包 → 本地创建）**

`.qoder/skills/handover/SKILL.md` frontmatter：`name: handover`，description 触发词含"交接/handover/整理 work item/记录完成项"。正文规则：读 `HANDOVER.md`+`memo.md`+`openspec status` → 三类动作（DONE 移出 TODO 并入 COMPLETED / 新需求加 TODO 并编号 WI-xx / 砍功能删 WI 并在 memo 记原因）→ 强制同步 `memo.md`。

- [ ] **Step 7: 提交 + `openspec list`**

---

## Task 3: `shared/` 契约层（题库 schema + 判题协议）

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`
- Create: `shared/src/taxonomy.ts`, `question.ts`, `judge.ts`, `day.ts`, `index.ts`
- Test: `shared/test/question.schema.test.ts`, `shared/test/day.test.ts`

**Interfaces:**
- Produces:
  - `CATEGORY_IDS: readonly ['frontend','algorithms','sql','system-design','big-data','agent-design','hot-interviews']`
  - `JUDGE_KINDS: readonly ['java-junit','react-vitest','mysql','redis','pyspark','llm-rubric']`
  - `Question`（zod）：`id,category,title,statement,difficulty:'senior'|'principal',judgeKind,tags[],source:{company?,jds?:{url,title,ingestedAt}[],origin:'manual'|'jd'|'cli',ingestedAt,tech[]},answer?,rubric?:{maxScore,points:{label,weight}[]},cases?:{name,input,expected}[],runner:{...},hidden?:boolean`
  - `JudgeRequest{questionId,submission,language}` / `JudgeResult{status:'pass'|'fail'|'error',scoreOf,maxScore,passed,failed,failedCases:{name,expected,actual}[],detail,logs}`
  - `daySeed(dateStr): number`、`pickForDay(questions, dateStr, category, count): Question[]`

- [ ] **Step 1: 写失败测试** — `question.ts` 未导出时 `import { QuestionSchema }` 报错；断言 5 个非法样本（缺 `ingestedAt`、`difficulty:'junior'`、`cases` 与 `rubric` 同时为空、未知 `judgeKind`、`source.origin:'scraped'`）全部 reject。
- [ ] **Step 2: 跑测试确认失败** — `npx vitest run shared/test` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 schema** — `z.strictObject`；`superRefine` 加两条业务规则：`judgeKind==='llm-rubric'` ⇒ 需 `rubric`；其它 judgeKind ⇒ 需非空 `cases`。
- [ ] **Step 4: 实现 `day.ts`** — mulberry32 + FNV-1a(`YYYY-MM-DD`+category) 洗牌；导出 `pickForDay` 纯函数（同输入同输出）。
- [ ] **Step 5: 跑测试通过 + 追加 day 确定性测试**（`pickForDay(Q,'2026-09-19','sql',3)` 连调 2 次 deep-equal）。
- [ ] **Step 6: 提交** `feat(shared): question bank + judge contract`

---

## Task 4: 单镜像 Docker 化 + 启动脚本

**Files:**
- Create: `docker/Dockerfile`, `docker/entrypoint.sh`, `compose.yml`, `start.sh`, `start.ps1`
- Create: `docker/mirrors.sh`（apt/pip/maven/npm mirror 写入）

**Interfaces:**
- Produces: 容器内可用命令：`node`, `npx`, `python3`, `pyspark`, `java`, `javac`, `mvn`, `mysql`, `mysqld_safe`, `redis-server`, `redis-cli`, `junit-platform-console-standalone.jar`（路径 `/opt/junit/`）, `spark-3.5.x`（`/opt/spark`）。`PORT=7788` 唯一对外端口。

- [ ] **Step 1: 写 `docker/mirrors.sh`**（apt→mirrors.aliyun.com/ubuntu、pip→tuna、maven→`~/.m2/settings.xml` aliyun、npm→npmmirror、`PLAYWRIGHT_DOWNLOAD_HOST`/`PUPPETEER_SKIP_DOWNLOAD`）
- [ ] **Step 2: 写 `docker/Dockerfile`**

```dockerfile
FROM docker.m.daocloud.io/library/ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai
COPY docker/mirrors.sh /usr/local/bin/mirrors.sh
RUN mirrors.sh apt && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git build-essential \
    openjdk-17-jdk-headless maven python3 python3-pip python3-venv \
    mysql-server redis-server sqlite3
# node 24 走 npmmirror 二进制（官方源兜底）
ARG NODE_VERSION=24.10.0
RUN curl -fsSL "https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz || curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
RUN pip3 install --index-url https://pypi.tuna.tsinghua.edu.cn/simple pyspark==3.5.5 'pandas<3' pytest
RUN mkdir -p /opt/junit && curl -fsSL -o /opt/junit/junit-platform-console-standalone.jar \
      "https://maven.aliyun.com/repository/public/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar"
WORKDIR /app
COPY . .
RUN npm install && npm run build
EXPOSE 7788
ENTRYPOINT ["/app/docker/entrypoint.sh"]
```

- [ ] **Step 3: `entrypoint.sh`**：`mysqld_safe --skip-grant-tables=0 &`、`redis-server --daemonize yes`、等待 socket 就绪（轮询 `mysqladmin ping` / `redis-cli ping`，≤60s），再 `exec "$@"` → `node server/dist/index.js`。
- [ ] **Step 4: `compose.yml`**：`build.context: .`、`dockerfile: docker/Dockerfile`、`ports: ["7788:7788"]`、`volumes: ["./data:/app/data","./docker-cache:/root/.cache"]`、`container_name: daily-arena`、`init: true`。
- [ ] **Step 5: `start.sh` / `start.ps1`**：`docker compose up --build -d` → 轮询 `http://localhost:7788/api/health` → 打印 URL；`--logs`/`--down`/`--rebuild` 子命令。
- [ ] **Step 6: 构建并冒烟**

Run: `./start.sh --rebuild` then `curl -s localhost:7788/api/health`
Expected: `{"ok":true,"stacks":{"java":true,"pyspark":true,"mysql":true,"redis":true}}`（`/api/health` 在 Task 11 实现；本步先手工 `docker compose run` 逐个 `java -version`/`pyspark --version`/`mysqladmin ping` 验证，通过后提交）。

- [ ] **Step 7: 提交 + 在 `memo.md` 记录镜像大小与构建耗时**

---

## Task 5: 题库子系统（append-only 入库 + 软删除 + 知识库先行）

**Files:**
- Create: `content/knowledge/{frontend,algorithms,sql,system-design,big-data,agent-design,hot-interviews}/README.md` + 各考点 `*.md`
- Create: `server/src/bank/{loader.ts,ingest.ts,hide.ts}`, `server/src/bank/monotonic.ts`
- Test: `server/test/bank/loader.test.ts`, `ingest.test.ts`, `hide.test.ts`, `monotonic.test.ts`

**Interfaces:**
- Consumes: `Question`, `CATEGORY_IDS`（`shared`）
- Produces: `loadBank(dir?): {questions: Question[], errors: BankError[]}`；`ingest(candidates: QuestionDraft[]): {added,skippedDuplicate,report}`；`hide(questionId)/unhide(id)/isHidden(id)`；`visibleBank()`。

- [ ] **Step 1: 先做知识库（req 31）** — 每个类别一份 `content/knowledge/<cat>/README.md`：考点矩阵（考点 / senior 深度要点 / 最新实践 2025-2026 / 可出题形式 / 参考 JD 能力项）。Task 14 的出题以它为输入。
- [ ] **Step 2: 失败测试 `loader.test.ts`**：fixture 目录含 1 个非法 JSON → 断言 `errors.length===1 && errors[0].file` 且合法题仍加载。
- [ ] **Step 3: 实现 `loader.ts`**：递归读 `content/questions/**/*.json`，逐条 `QuestionSchema.parse`，重复 `id` 视为 error；结果按 `ingestedAt` 排序。
- [ ] **Step 4: 失败测试 `ingest.test.ts`**：重复 id/相同题面 hash 跳过；断言 `bankSize(after) >= bankSize(before)`（只增不减不变式）。
- [ ] **Step 5: 实现 `ingest.ts`**：写文件前用 zod 校验；`ingestedAt=new Date().toISOString()`；`source.origin` 必填；落盘 `content/questions/<cat>/<id>.json`（一题一文件，减少 merge 冲突）。
- [ ] **Step 6: 实现 `hide.ts` + 测试**：`content/hidden.json` = `{ids:[],reason?,at}`；幂等；`visibleBank()` 过滤；测试"hide 后 daily 池不含该题"。
- [ ] **Step 7: `monotonic.test.ts`**：随机 3 次 ingest 序列后断言文件数不减、历史 id 集合仍是子集（防 regression）。
- [ ] **Step 8: 提交** `feat(bank): append-only ingest + soft hide`

---

## Task 6: 判题核心 + Java runner（算法题 only Java）

**Files:**
- Create: `server/src/judge/{workspace.ts,runner.util.ts,registry.ts}`, `server/src/judge/runners/java-junit.ts`
- Create: `tests/fixtures/java/{SolutionCorrect.java,SolutionWrong.java}`
- Test: `server/test/judge/java-junit.test.ts`

**Interfaces:**
- Consumes: `JudgeRequest`, `JudgeResult`, `Question.runner.java.{entryClass,methodSig}`
- Produces: `runJudge(req): Promise<JudgeResult>`；`Workspace{root,write(),pathOf(),cleanup()}`；每个 runner 注册 `kind` 与 `run()`。

- [ ] **Step 1: 写双向往返失败测试**：同一题（Two Sum，`cases` 3 条）分别喂 `SolutionCorrect`（期望 `status:'pass'`, `passed=3`）与 `SolutionWrong`（`fail`, `failed=2`, `failedCases[0].name` 命中）。
- [ ] **Step 2: 跑测试 → FAIL**（`Cannot find module '../src/judge/registry.js'`）。
- [ ] **Step 3: `workspace.ts`**：`mkdtemp(data/judge/<id>-<ts>)`，写用户代码 + 生成的 `CasesTest.java`（JUnit5 `@ParameterizedTest`，CSV 驱动 cases），断言失败时打印 `EXPECT/ACTUAL`；`cleanup()` 用 `rm -rf`（仅限 data/judge 前缀，带路径断言防误删）。
- [ ] **Step 4: `java-junit.ts`**：`javac -d out`（编译错误 → `status:'error'` + 前 20 行报错）；`java -jar /opt/junit/junit-platform-console-standalone.jar --class-path out --select-class CasesTest --details=summary --reports-dir=rep`；解析 `rep/TEST-junit-jupiter.xml` → pass/fail/failedCases。超时 20s（`AbortController` + `kill`）判 `fail(timeout)`。
- [ ] **Step 5: 跑测试 → PASS**；`npx vitest run server/test/judge` 全绿。
- [ ] **Step 6: 性能与泄漏回归测试**：连跑 5 次，断言 `data/judge` 目录残留为 0（cleanup 生效）。
- [ ] **Step 7: 提交** `feat(judge): java junit runner with bidirectional fixture test`

---

## Task 7: TS/React runner（前端题）

**Files:**
- Create: `server/src/judge/runners/react-vitest.ts`
- Create: `tests/fixtures/react/{correct.tsx,wrong.tsx,useNowCorrect.ts}`
- Test: `server/test/judge/react-vitest.test.ts`

**Interfaces:**
- Consumes: `Question.runner.vitest.{files:[{path,content}],assertionsFile}`
- Produces: 同 `JudgeResult`；vitest JSON reporter → 用例级 pass/fail。

- [ ] **Step 1: 失败测试**：题=`useNow` hook 或 `<Table/>` 组件渲染，cases=断言文件；正确解 → `pass`；错误解 → `failed>=1` 且 `failedCases[].name` 形如 `renders empty state`。
- [ ] **Step 2: 实现**：workspace 内写 `package.json`（`{}` 仅声明 type）+ 用 `node --experimental-strip-types`? **决策**：workspace 复用镜像内 `/app/node_modules`（`NODE_PATH` + `--dir`），不每次 npm install（性能：单次判题 <8s）。命令 `npx vitest run --reporter=json --outputFile=report.json --root <ws>`，`environment:'jsdom'`。
- [ ] **Step 3: 编译期错误分类**：TS 诊断（`tsc --noEmit`）失败 → `status:'error'` 并把 diagnostics 前 20 行进 `logs`。
- [ ] **Step 4: 双向往返测试通过** + `npx vitest run server/test/judge` 全绿。
- [ ] **Step 5: 提交** `feat(judge): react vitest runner`

---

## Task 8: MySQL + Redis runner（真服务、会话隔离）

**Files:**
- Create: `server/src/judge/runners/{mysql.ts,redis.ts}`, `server/src/judge/sandbox.sql.ts`
- Test: `server/test/judge/mysql.test.ts`, `redis.test.ts`

**Interfaces:**
- Consumes: `Question.runner.sql.{setup:[sql],cases:[{name,query,expectedRows,orderSensitive}]}`, `Question.runner.redis.{setup:[cmds],cases:[{name,command|pipeline,expected}]}`
- Produces: `withScratchMysql(fn)`（`CREATE DATABASE arena_<n>` → 用后 DROP）；`withScratchRedis(fn)`（选独立 db index 1..15，`FLUSHDB`）。

- [ ] **Step 1: 失败测试 mysql**：fixture 表 `orders`；正确 SQL（窗口函数取每组 Top-1）→ `pass`；错误（用 `MAX()` 而非窗口，行数不符）→ `fail` 且 `failedCases[0].expected/actual` 有值。
- [ ] **Step 2: 实现 mysql**：`mysql --user=root --protocol=socket --database=arena_x`，`-e "<query>" --batch --raw`，解析 TSV → 与 `expectedRows` 结构化比较（数字归一化、可选排序比较）；`SET SESSION max_execution_time=8000`；禁 `INTO OUTFILE`/多语句（正则白名单只允许 `SELECT/WITH/CREATE/INSERT/UPDATE/DELETE/ALTER/...`，拒 `DROP DATABASE`/`GRANT`）。
- [ ] **Step 3: 失败测试 redis**：题=滑动窗口限流 / ZSET 排行榜；正确 pipeline → `pass`；错误（忘了 `ZADD` 的 score 方向）→ `fail`。
- [ ] **Step 4: 实现 redis**：`ioredis`（纯 JS，无原生编译），每 case 用 `MULTI` 收集结果，数值/数组深比较；禁 `FLUSHALL/CONFIG/DEBUG/SHUTDOWN`（白名单命令）。
- [ ] **Step 5: 隔离性测试**：两次并发判题互不污染（A 写 key，B 查不到）。
- [ ] **Step 6: 提交** `feat(judge): mysql + redis runners with per-attempt sandbox`

---

## Task 9: PySpark runner（含会话池，控制判题延迟）

**Files:**
- Create: `server/src/judge/runners/pyspark.ts`, `server/src/judge/spark_worker.py`
- Test: `server/test/judge/pyspark.test.ts`

**Interfaces:**
- Produces: `runSpark(code, cases): Promise<JudgeResult>`——通过常驻 `python3 spark_worker.py`（长驻 JVM/SparkSession，行分隔 JSON 协议）执行。

- [ ] **Step 1: 失败测试**：题=window 去重取最新事件；正确 → `pass`；错误（未 `dropDuplicates` 顺序不定）→ `fail` + 失败 case 名。
- [ ] **Step 2: `spark_worker.py`**：读 stdin 每行一个 JSON `{id,code,cases}`；`SparkSession.builder.master('local[2]').config('spark.sql.session.timeZone','UTC')`；执行用户函数 `def solve(spark): ...` 返回 DataFrame；结果 `toJSON()` 与 `cases[].expected` 比较（可选 `orderBy` 归一化）；输出 `{id,status,passed,failed,failedCases}`；用户异常 → `status:'error'` + traceback 截断 30 行。
- [ ] **Step 3: 进程池管理**：`pool.ts` 维持 1 个 worker（崩溃自动重启 + 单请求 90s 超时；超时则 kill 重启，避免污染后续请求）。
- [ ] **Step 4: 测试通过 + 冷启动 vs 复用耗时打点写进 `memo.md`**（目标：复用 <5s）。
- [ ] **Step 5: 提交** `feat(judge): pyspark runner with pooled spark session`

---

## Task 10: 主观题 LLM 评分（qodercli → copilot → manual）

**Files:**
- Create: `server/src/llm/{provider.ts,rubric.ts}`, `server/src/llm/providers/{qodercli.ts,copilot.ts,manual.ts}`
- Create: `server/test/llm/__fixtures__/grade_ok.txt`
- Test: `server/test/llm/{rubric.test.ts,provider.test.ts}`

**Interfaces:**
- Consumes: `Question.rubric{maxScore,points[{label,weight}]}`
- Produces: `grade(question, answer): Promise<RubricVerdict{score,maxScore,bonus:string[],gaps:string[],citations:string[],provider,raw}>`；`PROVIDERS = [qodercli, copilot, manual]` 顺序降级。

- [ ] **Step 1: 失败测试（rubric 解析）**：provider stub 返回含 markdown fence 的 JSON → 断言解析出 `score=8, maxScore=10, bonus.length>=1, gaps.length>=1`；越界分数（`score=14`）→ clamp 到 0..maxScore 并记 `raw`；非法 JSON → 视为该 provider 失败并降级。
- [ ] **Step 2: 失败测试（降级链）**：qodercli 不可用（exit≠0）→ 用 copilot；两者皆不可用 → `manual`（返回 `status:'needs_human'` + 展示 rubric 自检表）。
- [ ] **Step 3: `qodercli.ts`**（实测可用）：

```ts
const args = ['-p','--tools','','--output-format','text', prompt];
spawn('qodercli', args, {cwd: repoRoot, env: {...process.env}}); // timeout 120s
```
prompt 模板：题目 + rubric 权重表 + 候选人答案 + `只输出 JSON：{score,maxScore,bonus[],gaps[],citations[]}`；命令模板可被 `config.llm.qoderArgs` 覆盖（便于换 CLI 版本）。
- [ ] **Step 4: `copilot.ts`**：同结构，命令模板可配（`copilot -p --output-format json`，实测后写死；未登录/不可用 → 抛错触发降级）。
- [ ] **Step 5: 判分一致性测试（防 regression）**：同一答案跑 3 次，断言 `|score_3次均值 - score_i| <= 1`（温度不敏感约束；超限则 rubric 提示词需收紧）。
- [ ] **Step 6: 提交** `feat(llm): rubric grading with qodercli/copilot/manual fallback`

---

## Task 11: 游戏子系统（每日挑战 + XP/streak/成就）+ API

**Files:**
- Create: `server/src/db/{index.ts,migrations.ts}`, `server/src/game/{daily.ts,xp.ts,streak.ts,achievements.ts}`
- Create: `server/src/api/{app.ts,routes/{health,bank,challenge,judge,progress,hide}.ts}`, `server/src/config.ts`, `server/src/index.ts`
- Test: `server/test/game/*.test.ts`, `server/test/api/*.test.ts`

**Interfaces:**
- Consumes: `visibleBank()`, `pickForDay()`, `runJudge()`, `grade()`
- Produces (HTTP, `/api` 前缀，全部 JSON)：
  - `GET /api/health` → `{ok,stacks:{java,pyspark,mysql,redis,react,llm}}`
  - `GET /api/categories` → `{categories:[{id,count,todayAvailable}]}`
  - `GET /api/challenge/today?category=` → `{date,questions:[{id,category,title,statement,difficulty,tags,casesPreview,source}]}`（**不含**参考答案/`rubric.points` 细节）
  - `POST /api/judge` `{questionId,submission}` → `JudgeResult`
  - `POST /api/grade` `{questionId,answer}` → `RubricVerdict`
  - `GET /api/progress` → `{streakDays,xp,league,achievements[],todayDone,calendar[30]}`
  - `POST /api/questions/:id/hide` / `DELETE`（=unhide）
- [ ] **Step 1: `db/index.ts`**：`node:sqlite` `DatabaseSync('./data/arena.db')`；表：`attempts(id,qid,category,verdict,score,durationMs,caseSummaryJson,createdAt)`, `days(date,xp,streak_at)`, `settings(key,value)`。migration 幂等（`CREATE TABLE IF NOT EXISTS`）+ `PRAGMA user_version`。
- [ ] **Step 2: 失败测试 `daily.test.ts`**：同日两次 `todayChallenge('sql')` 结果相同；hide 一题后该题不再出现；跨天（注入 `2026-09-20`）结果变化。
- [ ] **Step 3: 失败测试 `xp.test.ts`/`streak.test.ts`**：pass=15XP、fail=2XP（安慰奖）、主观题 `round(score/max*20)`；streak 规则：连续自然日 +1，断签清零，同日多题不重复计数（用 `attempts` 日期集合判定，注入时钟测 3 段）。
- [ ] **Step 4: 实现 + `app.ts`**（Fastify；`register` routes；`@fastify/static` 服务 `web/dist`；CORS dev only）。
- [ ] **Step 5: 集成测试 `api/*.test.ts`（Supertest，stub judge/grade 注入）**：5 个端点 happy path + 题目答案不泄漏（断言响应体不含 `"expected"` 与 `rubric.points`）。
- [ ] **Step 6: `GET /api/health` 真栈探测测试**：容器内跑，断言 5 个 stack 全 true。
- [ ] **Step 7: 提交** `feat(server): daily challenge, gamified progress, http api`

---

## Task 12: React 前端（浅色、极致流畅）

**Files:**
- Create: `web/{package.json,vite.config.ts,tsconfig.json,index.html}`, `web/src/{main.tsx,App.tsx,api.ts,styles/tokens.css}`
- Create: `web/src/pages/{Today.tsx,QuestionPage.tsx,Progress.tsx,Bank.tsx}`, `web/src/components/*`
- Test: `web/test/{today.page.test.tsx,answer.panel.test.tsx}`, `vitest.config.ts`

**Interfaces:**
- Consumes: Task 11 的 HTTP 契约（`web/src/api.ts` 手写 typed client）
- Produces: 路由 `/`(今日挑战入口) → `/q/:id` → `/progress`、`/bank`

- [ ] **Step 1: 设计 token（浅色）**：`tokens.css` — `--bg:#f7f9fc`, `--surface:#ffffff`, `--text:#1f2733`, `--primary:#3b82f6`, `--success:#16a34a`, `--danger:#e11d48`（背景 L* > 90，正文对比度 > 7:1）。
- [ ] **Step 2: 失败测试 `today.page.test.tsx`**（MSW/`vi.mock` api）：渲染 7 个类别卡 + 今日状态；断言点击"算法(Java)"跳 `/q/<id>`；断言 `todayDone` 时显示完成态。
- [ ] **Step 3: 失败测试 `answer.panel.test.tsx`**：判题返回 `failed=2,passed=1` 时展示"通过 1 / 失败 2"并可展开失败用例名（req 13）；`hide` 按钮调用 `POST /api/questions/:id/hide` 后该题从列表消失（req 22）。
- [ ] **Step 4: 实现 `CodeEditor.tsx`**：CodeMirror 6（`@codemirror/lang-java`, `@uiw/react-codemirror`, `language:data` for sql/python），`Ctrl/⌘+Enter` 提交；编辑不影响滚动（`EditorView.lineWrapping`）。
- [ ] **Step 5: 实现流畅性**：列表虚拟化（题目 >50 条时 `windowing`，自实现 30 行 hook，不引额外依赖）；请求 `useQuery`-like 自写 hook（SWR 语义：stale-while-revalidate，50ms debounce）；`/q/:id` 键盘快捷键（1-5 选项？不：主观题用 `Ctrl+Enter`）；结果动画仅 `transform/opacity`（GPU）。
- [ ] **Step 6: 跑 `npm run test -w web` 全绿**；`npx tsc -p web --noEmit` 无错。
- [ ] **Step 7: 提交** `feat(web): react client, light theme, daily challenge flow`

---

## Task 13: 防 regression 机制 + verify 流水线 + E2E

**Files:**
- Create: `scripts/verify.sh`, `scripts/verify-fast.sh`, `.githooks/pre-commit`
- Create: `tests/e2e/{daily.spec.ts,judge.spec.ts,hide.spec.ts,progress.spec.ts}`, `tests/playwright.config.ts`, `tests/package.json`
- Create: `server/test/regression/{runner-matrix.test.ts,leak.test.ts}`

**Interfaces:**
- Produces: `npm run verify` = `verify-fast` + E2E；`npm run verify:fast` = lint + typecheck + unit + integration。

- [ ] **Step 1: `verify.sh` 编排**（fail-fast、打印阶段横幅、退出码）：

```bash
set -euo pipefail
npm run lint -s; npm run typecheck -s
npx vitest run shared server tests/unit -s
npx vitest run --config server/vitest.integration.config.ts
node scripts/check-bank.mjs          # schema + append-only 不变式
[ "${SKIP_E2E:-0}" = "1" ] || npx playwright test -c tests/playwright.config.ts
```
- [ ] **Step 2: runner 矩阵回归测试**（核心防 regression）：遍历 `tests/fixtures/submissions/*` 每个题目 → `{correct,wrong}` 各跑一次，断言 correct ⇒ `pass`、wrong ⇒ `fail` 且 `failedCases.length>=1`。任一 runner 破功即 CI 红。
- [ ] **Step 3: 资源泄漏测试**：连续 20 次判题后断言 `data/judge` 空、`SHOW DATABASES LIKE 'arena_%'` 为空、redis 目标 db 已 `FLUSHDB`。
- [ ] **Step 4: `check-bank.mjs`**：全量 zod 校验 + 每类别 `>=3` 题 + 每题 `ingestedAt` 存在 + 代码题 `cases.length>=3` + 主观题 `rubric.maxScore==10`；题库总数少于上次记录（`.bank-count` 文件）⇒ 退出码 1（只增不减）。
- [ ] **Step 5: E2E（Playwright，chromium 走 npmmirror）**：`daily.spec` 进入今日挑战 → 选类别 → 提交 Java 正确解 → 断言"通过 N 用例"绿态 → XP/streak 更新；`judge.spec` 提交错误解 → 断言失败用例名可见；`hide.spec` 移除题目 → 刷新后不再出现。
- [ ] **Step 6: `.githooks/pre-commit`** 跑 `verify:fast`（`SKIP_E2E=1`），可用 `ARENA_SKIP_HOOK=1` 显式绕过并在 `memo.md` 记录原因。
- [ ] **Step 7: 提交** `test: regression guard matrix, verify pipeline, e2e`

---

## Task 14: 知识库 → 第一版题库（1 个月量，每类别 ≥3，实际目标 ~95 题）

**Files:**
- Create: `content/knowledge/**`（补全考点矩阵，Task 5 Step 1 的延续）
- Create: `scripts/kb/compile-knowledge.mjs`, `scripts/jd/{fetch-apple.mjs,fetch-airbnb.mjs,sources.json,refresh-bank.mjs,toQuestions.mjs}`, `scripts/bank/generate-with-cli.mjs`
- Create: `content/questions/**`（题目 JSON）, `content/curriculum/2026-10.json`（30 天排课）
- Test: `server/test/bank/content.test.ts`, `scripts/jd/refresh.test.mjs`

**Interfaces:**
- Consumes: `ingest()`（Task 5）
- Produces: `refresh-bank` CLI：抓 JD → 提取 tech tags → 生成候选题（CLI 出题）→ `ingest()`；`--dry-run` 打印 diff 不写盘。

- [ ] **Step 1: 知识库汇总** `scripts/kb/compile-knowledge.mjs` 生成 `content/knowledge/INDEX.md`（考点 × 类别 × 覆盖状态矩阵），作为出题清单（req 31）。
- [ ] **Step 2: JD 抓取（先探测再实现）**：`sources.json` 声明目标（Apple / Airbnb × 上海 / 美国 × 大数据 / 后端）+ 各自 endpoint 配置；脚本按"国内可直连优先、失败重试退避、缓存到 `content/jd-cache/*.json`"实现；输出 `title, url, crawledAt, requiredSkills[]`。**若网络不可达**：降级为 `content/jd-cache/` 内置离线样本（README 说明如何开启在线刷新），并在 `memo.md` 记录。
- [ ] **Step 3: `refresh.test.mjs`**：给定 fixture JD 文本 → 抽出 `['flink','pyspark','mysql','react']`；两次运行同 id ⇒ 不重复入库；`--dry-run` 不写文件。
- [ ] **Step 4: 出题（第一版由我手写 + 结构化）**：每类别 13-14 题，全部 senior/principal、含 2025-2026 新点（例：React 19 `use()`/Server Actions 边界、Flink 2.0、MySQL 8.4 LTS、Spark 4.0、Agent 上下文工程/MCP、Lance/向量检索）。代码题必须带参考解 + ≥3 cases（含边界）；主观题带 10 分制 rubric + 加分点/不足点模板。
- [ ] **Step 5: `scripts/bank/generate-with-cli.mjs`**（req 21 后续扩题）：构造 prompt（类别 + 知识缺口 + 去重清单）→ 调 `qodercli -p`（失败降级 `copilot`）→ 解析 JSON → `ingest()`；`--n 10 --category big-data`。
- [ ] **Step 6: 内容校验测试** `content.test.ts`：7 类别各 ≥3 题；`node scripts/check-bank.mjs` 退出码 0；重复题面 hash 检测；技术栈标签 ∈ taxonomy。
- [ ] **Step 7: 排课 `content/curriculum/2026-10.json`**：30 天 × 每日 2-3 题（跨类别混合，符合"今日挑战选栈"体验）；`daily.ts` 读它（缺省回退到 `pickForDay`）。
- [ ] **Step 8: 提交** `feat(content): knowledge base + v1 bank (~95 questions, 30-day curriculum)`

---

## Task 15: 收尾验证 / 文档 / 交接

**Files:**
- Modify: `README.md`, `memo.md`, `HANDOVER.md`, `openspec/changes/.../tasks.md`
- Create: `docs/ARCHITECTURE.md`, `docs/JUDGING.md`, `docs/ADD_QUESTIONS.md`

- [ ] **Step 1: 容器全量验证**：`./start.sh --rebuild` → `npm run verify`（含 E2E）→ 全部通过；把每条命令与输出摘要写进 `memo.md`。
- [ ] **Step 2: 7 类题各真人手做 1 题**（浏览器，Playwright headed 或 MCP 浏览器截图）：Java/React/MySQL/Redis/PySpark 走判分，系统设计/Agent/高频面试走 qodercli 评分，截图与得分记入 `memo.md`。
- [ ] **Step 3: 红线自检**：逐条对照 `rule.md` + Global Constraints（单镜像、目录内自包含、国内源、解耦、append-only）。
- [ ] **Step 4: `openspec archive build-daily-interview-arena`**（把 delta 并入 `openspec/specs/`），`HANDOVER.md` 全部 WI 移入 COMPLETED，剩余 TODO 记新需求。
- [ ] **Step 5: 打 tag + 提交** `git tag v0.1.0 && git commit -am "docs: handover"`.

---

## 已知风险与决策

| 风险 | 决策 |
|---|---|
| Docker Hub 直连不通 | 全部基础镜像走 `docker.m.daocloud.io`（daemon 亦配 3 mirror）；构建失败时 `docker/mirrors.sh` 可换 `docker.1ms.run` |
| Spark JVM 冷启动 ~10-20s | 常驻 `spark_worker.py` 会话池（Task 9）；前端做"编译中"进度态 |
| `better-sqlite3` 原生编译依赖 GitHub 下载 | 用 Node 内置 `node:sqlite`，零原生依赖 |
| MySQL 8 apt 包在 Debian 缺失 | 基础镜像用 ubuntu:22.04 → 真 `mysql-server-8.0` |
| 外网 JD 抓取可能被拦 | `content/jd-cache/` 离线样本 + 优雅降级，脚本保持可切换在线 |
| copilot CLI 非交互参数未知 | provider 命令模板可配置（`config.llm.copilotArgs`），实测后固化；不可用则降级 manual |
| 题量（~95）与答案质量 | 先知识库→再出题；`check-bank.mjs` 卡最低门槛；E2E 前 runner 双向往返测试保证"参考解一定 pass" |

## 多 agent 分工（req 28）

- **PM agent**（`Agent` 后台）：把住产品方向 → 对 spec/curriculum/难度给结论式评审，不改代码。
- **worker**（主会话 + 并行 worker agent）：按本计划逐 Task 实现，TDD。
- **review agent**：每个里程碑跑 `superpowers:requesting-code-review` 式评审 + 修 bug。
- 独立可并行的内容型任务（Task 14 各分类出题、Task 5 知识库、E2E 编写）用 `superpowers:dispatching-parallel-agents` 拆并发。
