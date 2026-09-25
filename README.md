# Daily Interview Arena（本地每日刷题系统）

对标 senior / principal 工程师的**本机每日面试训练**系统：leetcode 的判题严谨度 + 多邻国的每日坚持机制。
全部东西都在这一个目录里，一条命令在 Docker 里起来。

## 30 秒启动

```bash
./start.sh            # 构建 + 后台启动 + 等健康检查（首次约 10-20 分钟，镜像里有 Spark/MySQL/JDK）
# Windows PowerShell
.\start.ps1

# 健康检查通过后会自动用**系统默认浏览器**打开 http://localhost:7788
# 不想自动打开：ARENA_NO_BROWSER=1 ./start.sh   （PowerShell：$env:ARENA_NO_BROWSER=1; .\start.ps1）
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `./start.sh --rebuild` | 强制无缓存重建镜像后启动（**只有改了 Dockerfile / 依赖层才需要**：会把 JDK/Spark 那几百 MB 一起重装。只改源码用默认启动即可） |
| `./start.sh --dev` | 开发模式（vite 5173 + 后端 watch） |
| `./start.sh --ide` | 起服务并**直接打开网页 IDE**（同一个容器、同一个服务，只是换个落地页；不记分也不留提交历史） |
| `./start.sh --logs` | 跟踪容器日志 |
| `./start.sh --bridge-logs` | 跟踪宿主 CLI 桥日志（主观题掉成人工自检表时先看这里） |
| `./start.sh --verify` | 容器内跑全量校验（含真判题） |
| `./start.sh --e2e` | 告诉你宿主跑 E2E 的命令（默认浏览器 **Edge**；`--e2e --in-container` 才在容器里跑） |
| `./start.sh --status` | compose 视角的运行状态 |
| `./start.sh --down` | 停止（顺带停掉宿主 CLI 桥与 E2E 隔离实例） |

启动成功后会打印**判题栈可用性**：健康检查过了不等于什么都能判 —— `llm-rubric:false` 会让主观题
静默降级成人工自检表，所以这一步必须说出来，而不是等你答完题才发现没评分。

## 每天怎么用

进入 **今日挑战** → 系统已经给你排好当天的套餐：**主栈 2 道代码题 + 副栈 1 道主观题**（约 45-60 分钟）。
主栈题量会按近 7 天的正确率微调：连续做不好降到 1 道、稳定全对且该栈题够就加到 3 道，界面上会说清为什么不是 2 道。
也可以从 7 个技术栈里另选一个单独加练：

答错或判失败的题会自动进 **错题本**，按 1 / 3 / 7 / 14 / 30 / 60 天的间隔回到后续套餐里：每次只顶掉一个槽位
（所以每天仍是 3 题，不是加菜），那道题会挂"复习"徽章，进度页的错题本卡片显示在册 / 今日到期 / 最久没碰。
排期是 SM-2 的**二值退化** —— 本系统只有 pass/fail 与用时，没有"回忆质量 0-5"的人为评分，所以 pass 升一档、
fail 跌回第一档，且要连续两次 pass 才升档（一次做对可能只是运气）。评分链故障导致的 `needs_human` 不算错题。

每次**正式**提交都会在题目页的 **提交历史** 卡片留下档：挂在哪个用例、期望 vs 实际、当时写的代码或答案，
刷新和隔天都还在（存在 `attempts.detail`，单条有 12KB 上限，超了先丢日志再丢别的，用例名最后才丢）。
自测面板跑自定义用例不留档、也不进历史 —— 不记分的事不该出现在复盘里。

进度页另有 **本周**（周一为一周之始）：这七天动了几次、本周做了几个类别各对多少、以及"这周最弱的一类"。
雷达图看的是全历史，这张卡看的是这一周 —— 间隔重复要的是"最近哪里还在漏"。
"计入 XP"与顶部累计同一条规则（每题只算最好那次），所以本周永远不会大于累计；格子里的数字是当天提交次数，两者不是一回事。

| 类别 | 技术栈 | 怎么判 |
| --- | --- | --- |
| 前端工程 | TypeScript / React | 沙箱内跑 Vitest + jsdom 断言 |
| 算法 | Java（仅此一种语言） | `javac` + JUnit5 DynamicTest，按用例判；链表/树题按 LeetCode 口径传 `[1,2,3]` 与层序数组 |
| SQL 与存储 | MySQL 8 / Redis | 独立临时库 / 独立 db index，比结果集与键状态 |
| 大数据处理 | PySpark / Spark SQL / Scala Spark | 常驻 SparkSession 池真跑作业 |
| 系统设计 / Agent 设计 / 高频面试 | 主观题 | 本机 CLI 按 10 分制 rubric 逐项评分 |

判题是**结果导向**：测试用例（输入 + 期望）在作答前就完整给你，中间过程不看；
失败时会告诉你 `通过 N / 失败 M` 以及**具体是哪几个用例**、期望值与实际值分别是什么。
等待期间界面会持续推进度（Java 约 1-2s、SQL 约 0.5s、Spark 首次十几秒）。

主观题评分按 rubric **逐项**给：命中/未命中、这一项拿了几分、下一句该补什么，
外加加分点与不足点，并显示用的是哪个 provider 与耗时。

## 题库

- 题目在 `content/questions/<类别>/<id>.json`，**一题一文件**，git 可 diff。
- 每题都有 `source.ingestedAt`（入库时间）与 `source.origin`（`manual|jd|cli|history`）；JD 来源题带 `source.jds[]` 可点出处。
- **只增不减**：`npm run bank:refresh` 只会追加，重复题（同 id 或题面归一化后同 hash）自动跳过。
- **手写题走 `npm run bank:add -- <文件或目录>`**：校验与落盘只走服务端那个 append-only 的 `ingest()`
  （脚本里不另写一套规则，否则两边一定漂移），入库后自动接 `bank:check`；`--dry-run` 与真实跑走同一段代码
  （写进临时副本），坏题只作废它自己并把 zod 路径报出来。代码题会额外提醒"参考解必须在容器里判过才算数"。
- 页面上点 **移除这题** = 软删除，写进 `content/hidden.json`；题目文件不删，但不再出现在今日挑战与题库里（"显示已移除"可恢复）。
- 出题前先有知识库：`content/knowledge/<类别>/README.md` 是考点矩阵，`npm run kb:index` 汇总成 `INDEX.md`。
- 扩题：`npm run bank:generate -- --category big-data --n 5`（用本机 `qodercli`，失败降级 `copilot`）。

## 网页 IDE

`./start.sh --ide` 直接打开，或点顶栏的"网页 IDE"。**十种语言**：Java / Python / JavaScript / TypeScript /
C / C++ / MySQL 8 / Redis 7 / PySpark / Spark Scala。它与做题系统同容器同服务，但**不读题目、不写提交历史、
不计 XP**（这条边界由 `server/test/ide/boundary.test.ts` 的 import 白名单强制）。

- 选语言带出可跑的示例；`格式化`（或 `Alt + Shift + F`）把 SQL / TS / Python 等排整齐。
- MySQL 跑在**一次性库**里、Redis 跑在**专用 db index** 上、PySpark 跑在判题同款**常驻 SparkSession** 上，
  每次运行结束都会清掉这次建的表 / 键 / 临时视图 —— 宁可让你把建表语句一起贴进"预置"框，
  也不攒一库没人知道来源的脏数据。白名单与判题共用同一份：`INTO OUTFILE`、`/*! 版本注释`、`FLUSHALL`
  在这里同样被拒。
- **REPL 会话**（Python / Node / jshell）：逐句求值，变量与 import 在会话里留着 —— 想确认"这一句到底返回什么"
  不用每次贴一整段重跑。面板在编辑器**右侧并排**（窄屏才落到下面）。最多 2 个会话、空闲 5 分钟自动回收，
  换语言、离开页面、直接关标签页都会把进程关掉；名额显示成"会话 N / 2"，
  被上次没关的页面占住时给一个"回收现有会话"的按钮，而不是只说一句"先关掉一个"。
- **行断点 + 查看变量**（Python / Java / JS）：点一下行号就下断点（`Ctrl / ⌘ + F9` 同义），按 `调试` 跑到那里停下，
  右栏列出当前帧的局部变量，`继续 / 下一步 / 步入 / 步出` 单步走。停住的那一行**还没执行**，
  所以看到的是"这一行即将用到的值"。
  Python 只跟踪你这份代码（标准库里面不停），且 `input()` 在调试时立刻 EOF —— 要试带 stdin 的程序请用 `运行`；
  Java 那份自己带 `-g` 编译（不然 jdb 读不到变量），变量表的类型列可能空着 —— jdb 不给类型，我们不按值猜；
  JS 停在某行时，那一行正要赋值的变量会显示"声明了，还没赋值"—— JS 的名字先于赋值就在作用域里（TDZ），
  这是两种语言的真相不同，不是读不出来。
  调试会话同时只许一个，代码一改就自动作废（行号已经对不上了）。
  按 `步入` 走进标准库时那一格**没有行号**，只写"停在你的代码之外"—— 那是别的文件的行号，画到你这份代码上就是骗人。
  它跟 REPL 问的不是同一个问题：一个问"这一句返回什么"，一个问"走到这一行时变量长什么样"。
- 运行预算按语言给（命令型 10s，Spark 两门 120s —— 实测一次 PySpark 0.3~6.7s、Spark Scala 一遍 15.4s 含真编译），
  数字显示在编辑器上方，运行中还会跳"已等几秒"，免得十几秒的等待看起来像卡死。
- IDE 与判题共用那个常驻 Spark worker：**判题优先，IDE 排队，不抢占**正在跑的判题。

## 主观题评分与"CLI 桥"

需求要求评分优先用本机已登录的 `qodercli`，其次 `copilot`。容器是 Linux 的，宿主上的
`qodercli.exe` 进不去容器，所以 `./start.sh` / `.\start.ps1` 都会顺手在宿主起一个极小的 HTTP 桥
（`scripts/llm-bridge.mjs`，端口 7799，带 token），容器把 prompt 发给它代跑。

- token 只有一个来源：`.env` 里的 `ARENA_LLM_BRIDGE_TOKEN`（首次启动自动生成并写入）。
  桥和容器必须同 token，否则 `/complete` 全部 401，评分会静默降级成人工自检表。
- 桥日志：`data/llm-bridge.log`；手动跑：`ARENA_LLM_BRIDGE_TOKEN=xxx node scripts/llm-bridge.mjs`
- 降级不静默：每一档为什么没用都会写 `grade/fallback` 日志。`/api/health` 的
  `stacks.llm-rubric` 就是"此刻能不能真拿到模型输出"，为 false 时先看桥。
- 两个 CLI 都不可用时，自动降级为**人工自检表**（按 rubric 逐项打勾），接口不会 500。
- 想跳过桥直接在宿主跑后端：`npm run start`（宿主机有 java 时也能判 Java 题）。

## 校验与防回归

```bash
npm run verify:fast     # 宿主机可跑：lint + 类型 + 前端构建与产物预算 + 单元/集成测试
npm run typecheck       # tsc -b 三个生产项目 + 三份测试项目（shared/server/tests 的测试文件都在内）
./start.sh --verify     # 容器内全量：再加判题矩阵（矩阵必须报 0 skipped）。E2E 在宿主跑，见下一行
npm run e2e             # 宿主 Playwright：自己起一个隔离实例（127.0.0.1:7798，只读题库）
npm run hooks:install   # 一次性：把 .githooks/pre-commit 接到 git
```

`.githooks/pre-commit` 跑的就是 `verify:fast`。接上有两条路：`npm run hooks:install`（设 `core.hooksPath`），
或直接把同一个文件装进 `.git/hooks/pre-commit`（本仓库当前用的是后者，所以 `git config --get core.hooksPath` 是空的并不代表闸门没生效 ——
`./start.sh` 的提示两条路都认）。

防回归闸门（这里只列"少了会出事、出了事看不出来"的那几条；完整阶段表见 `docs/ARCHITECTURE.md` §11）：
1. **runner 双向往返测试**：每个判题器都有"已知正确解必须 pass + 已知错误解必须 fail 到用例粒度"的测试。
2. **参考解自证矩阵**（`server/test/regression/reference-solutions.test.ts`）：题库里每道题的参考解必须真过判题器，
   且带 `naiveSolution` 的题朴素解必须不过 —— 后者用来抓"判题器变成橡皮图章"这类 bug。
   带 `ARENA_REQUIRE_STACKS=1` 时"有题因栈不可用被跳过"也判红（`./start.sh --verify` 默认带；
   不带的话，在没起 mysqld/redis-server 的容器里跑，全部 mysql/redis 题会静默跳过而结果仍全绿）。
3. **矩阵"整片 skip 也算失败"**（`scripts/assert-ran.mjs`）：判题套件在没有真栈时是 `it.skip` 且 exit 0，
   所以除了 vitest 自己，还要断言"确实执行过 N 条用例"。
4. **题库闸门**（`npm run bank:check`，`--full` 打开覆盖度）：结构合法、题数只增不减、每类题量与"当年新技术占比 ≥40%"、
   算法题里经典重复题 ≤15%、答案点名的『用例「X」』必须真存在、答案里写出来的等式逐条重算
   （`answer-arithmetic.test.ts`）、每家的 `probe_naive.py` 退出 0。
5. **出处可复现**（`server/test/bank/provenance.test.ts` → `check_provenance.py`）：六家生成器要能逐字段复现已入库的题；
   没有手稿的那批主观题按**指纹基线**核查 —— 改了内容而没显式 `--bless`，一样判红。
6. **类型检查覆盖到测试文件**（`server/test/regression/typecheck-coverage.test.ts`）：假实现漏改端口方法要能报警，
   所以测试目录必须在某个 tsconfig 的 include 里、且根 `typecheck` 真的 `-p` 点名了它（`--dry` 这种空跑直接判红）。
7. **门禁自己也要被门禁**（`server/test/regression/verify-coverage.test.ts`）：每个 `*.test.ts` 必须被 `verify.sh`
   某个阶段认领；**env 门控的闸门还必须被"真设了那个变量"的阶段认领**（曾经有一条闸门躺在被认领的目录里
   却从来没执行过），故意手动的用 `verify-gate: manual` 申报。
8. **前端产物预算**（`scripts/check-bundle.mjs`）：首屏只能有 1 个 JS + 1 个 CSS（两边都断言）且 gzip 不超预算，
   入口里出现 zod / CodeMirror 就判红 —— 拆包的成果最容易被一次"顺手 import"悄悄还回去。
9. **仓库自带脚本的语法与行尾**（`server/test/regression/scripts-syntax.test.ts`）：根目录与 `scripts/**/*.mjs`
   过 `node --check`、`*.sh` 过 `bash -n` **且不许有 CR**、`start.ps1` 钉住"恰好一个 UTF-8 BOM"（多一个就炸），
   外加 `start.sh` 与 `start.ps1` 的开关集合必须一致。

### E2E 打在哪

`npm run e2e` 默认自己起一个**独立实例**（compose 的 `e2e` 服务，映射到宿主 `127.0.0.1:7798`）：
数据目录 `data/e2e/`（db、日志、判题沙箱都在下面）、软删账本 `data/e2e/hidden.json`、题库**只读**挂进去。
所以跑 E2E 不会改动你的 XP/连击，也不可能把某道题从 `content/hidden.json` 里抹掉；跑完自动收容器与 `data/e2e`。

- 打到自己起的实例：`ARENA_E2E_BASE=http://127.0.0.1:7788 npm run e2e`（此时 setup 只做健康检查，不碰 compose）
- 失败后留现场：`ARENA_E2E_KEEP=1 npm run e2e`（保留容器与 `data/e2e` 供排查）
- 7799 是宿主 CLI 桥的端口，别占它（撞上去两边的 `llm-rubric` 会一起变 false，实测踩过）

## 目录结构

```
content/     题库系统（题目 JSON、知识库、JD 缓存、排课、hidden.json）—— 与游戏解耦
shared/      唯一契约层：题目 schema、判题协议、HTTP 契约、XP 规则
server/      游戏系统：题库读取、判题调度、评分、进度、Fastify API
web/         React 19 + Vite 前端（浅色主题、CodeMirror、SSE 判题进度）
docker/      单镜像 Dockerfile（MySQL + Redis + JDK + PySpark + Node）与 entrypoint
scripts/     题库刷新、知识库汇总、排课、CLI 桥、校验流水线
tests/       Playwright E2E
```

## 已知边界（诚实版）

- **原始素材不入库**：有 **42 道题**的 `source.knowledgeRef` 写成 `data/kb-txt/<手册名>.txt`
  （目前只点名两份：`DeepSeek后端Agent面试102题.txt`、`Apple面试准备手册.txt`）。这些是**本机素材**，
  `data/` 整个目录在 `.gitignore` 里 —— 不入库既因为版权不在我们手上，也因为里面常有具名个人。
  所以 clone 下来这 42 处指向的文件不存在，是**设计如此**不是坏链（`content.test.ts` 会把这个数报出来，
  它躺在被跟踪的 `data/` 里查不到原文这件事记在 HANDOVER 的 N-13）。
  题目本身不转录这些文档的原文：`source` 的字段只有
  `origin/jds/ingestedAt/era/company/role/location/knowledgeRef/addedBy`，没有任何 quote/excerpt 字段，
  公开的是我们自己写的题面与判分点。
- **单镜像**：所有技术栈都在一个镜像里（约 3-4GB）。镜像层实体存在 Docker Desktop 的 VM 存储里，
  仓库内的 `./docker-cache` 只承载 npm/pip 等构建缓存 —— 不改全局 daemon 配置就无法把镜像本体也搬进来。
- **MySQL 版本**：ubuntu:22.04 提供的是 8.0.x（不是 8.4 LTS）；Redis 是源码编译的 7.2.7（不是 8.x）。
  超出该版本可用的命令，判题器会明确报"不可用"而不是给错判。
- **Flink**：不做真跑判分（mini-cluster 的镜像与启动成本不划算），相关题走主观题 rubric。
- **Scala Spark 可以真跑**：`spark-scala` runner 用 Spark 自带的 scala-compiler 真编译 + `local[*]` 真跑，
  契约与 PySpark 共用同一套用例 JSON（见 `docs/JUDGING.md`）。代价是每次都要编译，单题 15-30s。
- **宿主机不装 Java/Python 也能用**：所有真跑判分都在容器里；宿主机只需要 Docker + Node（跑脚本）。
- **容器里装不下 Playwright 浏览器**（Chrome for Testing 在镜像源与官方 CDN 都取不到）：
  E2E 用宿主浏览器跑（默认 **Edge**，与日常使用一致）：`npm run e2e`；想换 Chrome 加 `ARENA_E2E_CHANNEL=chrome`。
  `./start.sh --e2e` 因此默认只把这条宿主命令告诉你，`--e2e --in-container` 是留给"网络能取到浏览器"的情形。
- **`start.ps1` 必须带 UTF-8 BOM**：Windows PowerShell 5.1 读无 BOM 的中文脚本会解析失败（不是编码偏好，是它的默认代码页）。
- 单人单机自用：没有账号体系、没有并发防护、没有跨人排行榜。
- **端口只绑回环**（`127.0.0.1:7788`）：没有鉴权的服务发布到所有网卡，等于把整个题库（含被"移除"的题）
  和进度暴露给同局域网的人。**代价：手机 / iPad 访问不了**（已确认不需要）。
  要临时开出去调试得显式改 `compose.yml`，而 `server/test/regression/compose-ports.test.ts` 会先把你说清楚。

## 更多文档

- `docs/ARCHITECTURE.md` 架构总览：前端/后端/判题/评分/docker/启动脚本，含 6 张图
  （图源在 `docs/architecture/diagrams/*.drawio`，PNG 是导出产物）
- `docs/JUDGING.md` 每种判题器的输入约定与失败语义
- `docs/ADD_QUESTIONS.md` 怎么加题/移题/刷新题库
- `rule.md` 红线与变更自检清单 ｜ `memo.md` 开发日志（跨 session 记忆）｜ `HANDOVER.md` 工作板
