## Context

系统要在**一个目录、一个 Docker 镜像、一台本机**里同时做到：真跑 Java/React/MySQL/Redis/PySpark 代码并只按结果判分、用本地 CLI 给主观题打分、题库能从 JD 持续刷新且只增不减、体验接近 leetcode + 多邻国。约束来自 `requirement.txt`（通用 1-9、场景 1-20）与实测环境（Docker Hub 直连不通、npm/pypi 国内源可用、`qodercli -p` 可用）。

## Goals / Non-Goals

**Goals**
- 判题可信：参考解 100% pass、错误解 100% fail，且被回归矩阵长期锁死。
- 启动成本 = 一条命令（`./start.sh`），无需手工准备环境。
- 题库与游戏互不 import，加题目/改题目不动游戏代码。

**Non-Goals**：见 `proposal.md` 的 Non-goals。

## Decisions

### D1 MySQL / Redis 用镜像内真服务，而不是 testcontainers 或嵌入式替身
- **理由**：题目要考 `window function`、`CTE`、事务隔离、Redis ZSET 真实语义，SQLite/内存 mock 会给出错误判分。ubuntu:22.04 的 `mysql-server-8.0` + `redis-server` 可直接 apt 安装，`entrypoint.sh` 启动后判题用 `arena_<n>` 独立库 / 独立 db index，用完即删。
- **替代方案**：MariaDB（Debian 默认）→ 语义差异（JSON 函数、`utf8mb4_0900_ai_ci` 排序）会误导面试准备，弃；testcontainers → 需要 DinD 与第二个镜像，违反单镜像约束（C2），弃。

### D2 持久层用 `node:sqlite`，不引 `better-sqlite3`
- **理由**：原生模块要 prebuild 下载（GitHub 不通即装不上），内置模块零依赖，满足 C1/C3。
- **代价**：API 较新、需 Node ≥ 22.5 → 容器固定 Node 24。DB 访问集中在 `server/src/db/index.ts` 一层，未来换库成本可控。

### D3 主观题评分 = provider 链 + 可配置命令模板
- **理由**：需求要求优先 `qodercli`、其次 `copilot`（场景 8）。`qodercli -p --tools '' --output-format text` 已实测可用；`copilot` 参数未实测。所以 provider 抽象为 `name / available() / invoke(prompt)`，命令模板放 `config.llm.providers[]`，任一 provider 解析失败即降级，最终 `manual`（展示 rubric 自检表让人自评）。
- **一致性**：rubric 权重固定 10 分制，prompt 要求"只输出 JSON"，并有回归测试断言三次评分极差 ≤1。

### D4 判题进程模型：每类 runner 自带 workspace + 资源回收
- **理由**：Java 编译产物、vitest 临时项目、Spark 会话都必须隔离且不留残留。统一 `Workspace`（`data/judge/<questionId>-<ts>`）+ `finally` 清理 + 泄漏测试（20 次判题后断言目录为空）。PySpark 用长驻 worker（行分隔 JSON 协议）+ 超时 kill 重启。

### D5 题库存储：一题一 JSON 文件，git 跟踪；游戏状态用 SQLite
- **理由**：题库要人可读、可 diff、可 append-only（`content/questions/<cat>/<id>.json`）；进度/答题记录是高频写 → SQLite。软删除集中一个 `content/hidden.json`，避免逐题改写文件（减少 diff 噪声）。

### D6 每日选题：日期 + 类别作随机种子（mulberry32 + FNV-1a）
- **理由**：不依赖数据库也能保证"同一天同一栈题目稳定"，重进页面不换题、刷新不漂移；且支持 30 天排课文件覆盖（缺省回退算法选题）。

### D7 前端性能：CodeMirror 6 + 自实现窗口化 + SWR 语义数据层
- **理由**：需求要"极致、不卡顿"（场景 17）。避免 Monaco（重）、避免引入 react-query/zustand 等额外依赖；列表 >50 条走虚拟化，动画只用 `transform/opacity`。

## Risks / Trade-offs

- [单镜像体积 ~3-4GB（Spark + MySQL + JDK）] → 接受：换来"任何机器一条命令起来"；`memo.md` 记录构建耗时，Dockerfile 分层顺序按变动频率优化缓存命中。
- [真实 MySQL 在容器内以 root socket 免密连接] → 判题沙箱有 SQL 白名单 + 独立库 + `max_execution_time`，但仍是"自己机器上的自己账号"，威胁模型有限。
- [PySpark 判题依赖 JVM 内存] → `local[2]` + `spark.driver.memory=2g`，超 90s 判 timeout 并重启 worker。
- [题目由 LLM/人工生成可能有事实性错误] → 代码题靠 runner 强制自证；主观题靠 `knowledge/` 出处 + 抽查；`check-bank.mjs` 卡结构门槛。
- [`node:sqlite` 仍是实验特性，可能有警告输出] → 集中封装 + 启动时一次性打印，不进判题热路径。

## Migration Plan

绿色field，无数据迁移。回滚 = `docker compose down && git reset --hard <tag>`；`./data/` 与 `content/hidden.json` 是仅有的本机状态，删除即回到初始态。

## Open Questions

- Q1 是否需要"错题自动进入下一日挑战"（间隔重复）→ 记入 `HANDOVER.md` N-02，等 v0.1 用一周后定。
- Q2 `hot-interviews` 类别的公司标签粒度（Apple/Airbnb 之外是否加 Google/Meta）→ 第一版只放需求指定的两家。
