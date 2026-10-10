# 子项目 A2（WI-91）：镜像里一个**真能交互执行**的 Scala kernel —— 可行性探索计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 给第五页的 notebook 加一个**真交互**的 Scala kernel（今天只有 `arena-pyspark`：Scala 代码只能靠 `handleOutput` 那种"编译一段跑一段"的替代形状，没有活的 REPL 会话、没有多 cell 之间共享的状态）。

**Architecture:** 这不是"实现一个功能"，是**三条候选路径的限时探索**：Almond（现成的 Scala Jupyter kernel）→ Apache Toree（为 Spark-in-Jupyter 而生）→ 自包 `IMain`（编译器已在镜像里，缺的只有 ZMQ）。每条路径一个任务、一个**探针判据**、一个**停止条件**；三条全不行就**如实报告并停下**，不许造一个"看起来能跑"的假 kernel。探索出结论之后，胜出那条路径的**接入**（kernelspec、`NOTEBOOK_KERNELS`、`needsVenv` 重构、闸门）另出一版计划 —— 本版不写它，因为"接入哪条"就是本版要回答的问题。

**Tech Stack:** JVM（镜像里已有 JRE/JDK）、Scala `2.12.18`（`/opt/scala` 与 `/opt/spark/jars` 实测）、Spark 3.5.5（Scala 2.12 构建）、`jupyter_server` 2.21.1、`jupyter nbconvert/execute`、`docker/Dockerfile` + `docker-cache/`（npm/pip/**maven** 三份缓存）。

**Spec:** `docs/superpowers/specs/2026-10-05-jupyter-notebook-runtime-design.md`（A2 那一节：A1 之后 Scala 侧要真交互）；前置已交付：`docs/superpowers/plans/2026-10-05-jupyter-notebook-runtime-a1.md`、`docs/superpowers/plans/2026-10-09-jupyter-notebook-embed-wi94.md`。

## Global Constraints

- **红线①不许碰**：kernel 不得进入判题环境的执行路径（`server/src/exec/**` 一行都不改）；Scala kernel 起的 JVM/`SparkContext` 是判题池**之外**的又一个 JVM，这条要按 WI-95 的口径**如实写进页面边界**，不许假装它免费。
- **镜像构建必须离线可复现**：任何新 jar 都要走 `docker-cache/` + 记录**来源 URL 与 sha256**；本仓库有过"脚本里写死一台机器的镜像源"的事故（`MIRROR_APT` 那条），所以**下载源必须显式、可覆盖、失败要说清**。
- **Scala 版本锁死 2.12**：`/opt/spark/jars` 里是 `scala-library-2.12.18.jar`；任何 2.13/3.x 的 kernel 制品与 Spark 类路径混起来的症状是 `NoClassDefFoundError`/链接失败，而不是一个能读的报错。
- **探针判据只有一个**（三条路径共用，别各造一套）：一个 `.scala` notebook，kernel 指定为待评的那条，`nbconvert --execute` 之后必须看到 ①`val` 定义**跨 cell 存活**（第二个 cell 用第一个 cell 绑的变量）②`println` 走 **stream** 通道回来 ③能拿到一个活的 `SparkSession`。三件缺一件就是"假交互"，不许用"编译一段跑一段"糊过去。
  **外加一份夹具变体（2026-10-10 由 Task 1 实测补进计划）**：探针必须**再跑一次"摘掉 cell 1"的那本** —— 只留
  `println(s"alive=$doubled")`。理由：nbconvert 线性执行一整本，一个"把整本一次性编译、再把输出按 cell 切开"的**假 kernel**
  骗得过上面三条（它确实能让第二个 cell 拿到 42，也确实打 stream），但摘掉定义那一格之后它必然报错
  —— 真交互在"引用一个从没绑定过的名字"这件事上没有退路。**两条都要跑，只跑第一条不算判据成立。**
- **停止条件**（每条路径各自成立即停）：一次容器构建 + 一次探针之内要能给出"成 / 不成 / 成了但有 N 条不可接受的代价"。不许"再试一次就好了"滚第三次 —— 这是本条计划存在的原因（限时），也是它唯一的纪律。
- **不许为了变绿去改判据**：WI-94 的 `embed.test.ts` / `kernel.test.ts` / `tutorials.test.ts`（若那时已落地）条数只能增不能减。
- 不引 npm/pip 依赖去"绕过" jar 问题；`.env` 不读不打印；不占 7799；提交逐条 env 传 noreply 身份，不许 `--no-verify`/amend/push。
- 每档都要跑验证并看到通过输出才许说"完成"；容器侧真实数字（`CV_EXIT`、矩阵 `跳过 0`、阶段出现次数）逐档写进报告。

## 前置事实（2026-10-09 从跑着的镜像里量的，不是搜索结论）

- `/opt/scala/` = `scala-compiler.jar` + `scala-library.jar` + `scala-reflect.jar`（判题侧 Scala 题在用）。
- `/opt/spark/jars` 里是 `scala-compiler-2.12.18` / `scala-library-2.12.18` / `scala-reflect-2.12.18` ⇒ Spark 3.5.5 由 Scala 2.12 构建。
  ⚠ **`/opt/spark` 本身是一个符号链接**，指向 `dist-packages/pyspark`（pip 装的 pyspark 3.5.5；`du -sh /opt/spark` 不带斜杠给 `0`，
  带斜杠才是 342M —— Task 1 实测）。⇒ **三条路径往 Scala classpath 挂 `/opt/spark/jars/*`，挂的是判题侧也在用的那份 Spark 安装**：
  每一档都要显式回答一句"这条有没有把新的可写面 / 新的 jar 引进判题环境"（红线①），不许默认它无关。
- `/opt/spark-jars/` 与 `/opt/spark/jars` 里 `zeromq|jeromq|zmq` **0 命中** ⇒ 三条路径的共同前提是"往镜像里加一个 jar"（Almond/Toree 连 ZMQ 一起带，自包路径只缺 ZMQ 一个）。
- kernelspec 住在镜像级 `/usr/local/share/jupyter/kernels/arena-pyspark/`（`docker/jupyter/kernels/…`），`entrypoint.sh` 起 jupyter，`NOTEBOOK_KERNELS` 是 kernel id 的唯一真相，`status.ts` 的 allow-list 由它派生。
- 内嵌与两条隧道已交付并验过（WI-94）：新增一个 kernelspec **不需要动前端** —— 用户在 iframe 里选 kernel，`/api/kernelspecs` 那份表会自动多一行（`missingSpec` 与 `needsVenv` 的按-id 陷阱见任务 5 那条裁定）。

---

## Task 1：探针夹具与基线（把"什么叫做到了"先钉死）

**Files:**
- Create: `server/test/notebooks/fixtures/99-probe-scala.ipynb`
  ⚠ **不放 `content/notebooks/`，这是 WI-90 落地之后才有的约束**：那道题闸门（`tutorials.test.ts`）的清单完整性
  判的是"`content/notebooks/` 里除 `00-smoke-pyspark.ipynb` 之外每一篇都必须在注册表里"，而注册表里每一条都要求
  `metadata.kernelspec.name === arena-pyspark`。探针放进去 = 常驻档直接红（一篇 Scala 夹具被判成 Python 教程），
  而**不许**为了它给闸门再加一个 `99-` 排除前缀 —— 排除前缀本身就是 Task 1 点名的绕过口，别再挖一个。
  探索期它就不是交付物，放 fixtures 目录；胜出后要转正为常驻 smoke 是 Task 5 的决定（见那里第 ② 条）。
- Create: `server/test/notebooks/scalaKernelProbe.ts`（**不是** `*.test.ts`，所以不会被 `verify-coverage` 当闸门要求认领；它只是三条路径共用的探针执行器）
- Modify: 无

**Interfaces:**
- Produces:
  ```ts
  export interface ProbeResult { ok: boolean; kernelName: string; cells: number; stdout: string[]; errors: string[]; stateSurvived: boolean; sparkSession: boolean; elapsedMs: number }
  export async function probeScalaKernel(kernelName: string, notebookPath?: string, timeoutMs?: number): Promise<ProbeResult>;
  ```

- [ ] **Step 1: 写探针 notebook 的三个 cell（这就是判据本体）**

```scala
// cell 1（code cell，metadata.kernelspec.name = 待评的那条 kernel）
val doubled = 6 * 7
println(s"doubled=$doubled")

// cell 2 —— 跨 cell 状态必须活（"编译一段跑一段"在这一步就会红）
println(s"alive=$doubled")

// cell 3 —— 活的 SparkSession（A1 那条 pyspark 形状在 Scala 侧的对应物）
val spark = org.apache.spark.sql.SparkSession.builder().appName("a2-probe").getOrCreate()
println(s"rows=${spark.range(6).count()}")   // 6，不是 15：这一条只数行数
spark.stop()
```

markdown cell 0 里写清三件事各判什么，以及**为什么"跨 cell 存活"是这一档的意义**（没有它，Scala 侧的 notebook 只是分段编译器，用户拿不到"改一行重跑一次"的那个循环）。

- [ ] **Step 2: 写探针执行器（复用已有工具，不要新写解析）**

`probeScalaKernel` 用 `server/test/notebooks/notebook-evidence.ts` 里那两件已打磨过的工具（`executedNotebookEvidence` / `nbconvertCrashEvidence`，WI-90 Task 1 抽出来的模块；若那时尚未落地，就地用 `kernel.test.ts` 里那份**同名同实现**的，不要复制第三份）。
`stateSurvived` 的判据**不是**"第二个 cell 没报错"，而是 stdout 里出现 `alive=42` —— 这一点要写进注释：报错与否取决于 kernel 怎么实现，而 `alive=42` 只取决于状态到底活没活。

- [ ] **Step 3: 基线测量（三件事，都要实测数字）**

```bash
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -i arena
docker compose exec -T arena bash -lc 'du -sh /opt/spark /opt/scala 2>/dev/null; java -version 2>&1 | head -2'
docker compose exec -T arena python3 -c 'import jupyter_server;print(jupyter_server.__version__)'
```
写进报告：今天的镜像体积、Spark/Scala 目录体积、JVM 版本、jupyter_server 版本。
**这三行数字是后面所有"代价"判断的分母**（"这条路径多 180MB"在不知道基数时是一句空话）。

- [ ] **Step 4: 用探针打一次已知的**反面**基线**

拿现有的 `python3` kernel 跑一遍 `probeScalaKernel('python3')` ⇒ 三条判据**必须全红**（它连 Scala 语法都不认）。
这一条是探针自己的自检：如果 `python3` 也能"通过"，那判据什么都不判（本仓库为这类形状专门立过 `assert-ran.mjs`）。
Run: `npx vitest run server/test/notebooks`（探针不是 test 文件，所以要一个一次性脚本调它，或写成 `it.skip` 之外的显式入口 —— **不要**把它做成常驻闸门，探索期一结束就删）
把 `python3` 那次探针的三项读数（`stateSurvived=false`、`sparkSession=?`、`errors` 第一条）贴进报告。

- [ ] **Step 5: Commit**（`test(notebooks): WI-91 Task 1 —— Scala kernel 探针与基线（跨 cell 存活是唯一判据）`）

---

## Task 2：路径 A —— Almond（现成 kernel，先试最省的那个）

**限时：一次构建 + 一次探针。** 失败就写"不成 + 为什么"，不许续第二次。

- [ ] **Step 1: 离线取件（来源与校验必须写死）**

从 Almond 的 GitHub releases 取 **`almond_2.12`** 那份发行包（版本在本任务里确定并写进 `docker/BUILDINFO.md`）。
⚠ **2026-10-10 控制端量到的前置**：v0.15.0 的 release 只有**三个 228KB 的启动器资产**
（`almond-scala-2.12` / `2.13` / `3.9`，URL 形状 `.../releases/download/v0.15.0/almond-scala-2.12`）——
228KB 装不下一个 kernel，那是 coursier 生成的 app launcher，**运行时**才去解析依赖。
⇒ 这一档要答的问题不是"能不能让它跑"，是"**能不能不靠运行时网络让它跑**"：构建期把 jar 取全，或预置一份 coursier 缓存进镜像。
**两条都要第三次尝试才可能成 ⇒ 按停止条件停下记账**（"运行时需不需要网络"要**实测**：断网复跑一次，别读文档下结论）。
取件脚本放 `scripts/fetch-almond.sh`（与既有 `docker-cache/` 那套同一形状）：URL、落盘路径、**sha256 校验**、
校验失败的报错要说清"哪个文件、期望什么、拿到什么"（不许 `curl -f || true` 那种静默跳过）。

- [ ] **Step 2: kernelspec 落地**

`docker/jupyter/kernels/arena-scala-almond/kernel.json`，`argv` 用 `java -cp <almond jars> almond.Almond … --classloader <…>` 那份，
**探索期每条路径用自己的 id**（`arena-scala-almond` / `arena-scala-toree` / `arena-scala-imain`），
`arena-scala` 这个中性名留给 Task 5 接入那一步（`NOTEBOOK_KERNELS` 只能有一个真相，而"哪条胜出"正是本版要答的问题）。
⚠ 探索期的这些 id **在页面上看不到**是预期行为：`status.ts` 的 allow-list 由 `NOTEBOOK_KERNELS` 派生，
没登记进去的 kernel 会被过滤掉；探针走 `--ExecutePreprocessor.kernel_name=<id>`，不经页面。
并把 Spark 的类路径加进去（`/opt/spark/jars/*` + `/opt/spark-jars/*`）—— 这一步是路径 A 真正的风险点：
**Almond 默认用 coursier 在运行时解析依赖**，离线镜像里解析不到就等于"kernel 能起、`import spark` 起不来"。
两种接法都要试**并各记一次实测**：①`--predef` 里把 Spark 的 jar 加进类路径；②`%dep` 之类运行时解析（离线预期失败，失败就写下失败原文）。

- [ ] **Step 3: 探针 + 代价记录**

```bash
docker compose up -d --build arena
docker compose exec -T arena jupyter kernelspec list
docker compose exec -T arena python3 -m nbconvert --to notebook --execute --stdout \
  --ExecutePreprocessor.kernel_name=arena-scala-almond --ExecutePreprocessor.timeout=180 \
  server/test/notebooks/fixtures/99-probe-scala.ipynb
```
记：三条判据是否成立、镜像体积增量（`docker images` 再量一次）、构建时长、启动 kernel 的墙钟时间、
以及**新增了几个可写目录/进程**（coursier 的 `~/.cache` 这类——它会把状态写到镜像外，是"可写状态全在本实例数据目录"那条纪律的破口，见 WI-40）。

- [ ] **Step 4: 停止条件判定与提交**

三条判据全绿且代价可接受 ⇒ 记"路径 A 胜出，Task 5 做接入"；否则记"不成/太贵"，写清**是哪一条判据或哪一项代价**把它否掉的（一句话结论 + 原始输出）。
Commit：`spike(notebooks): WI-91 Task 2 —— Almond 实测（结论：成/不成，依据是 X）`

---

## Task 3：路径 B —— Apache Toree（为 Spark-in-Jupyter 而生）

同样**一次构建 + 一次探针**。

### 先读路径 A 的结论（`task-2-report.md`，控制端本人量的）—— 它把这一档的"该先测什么"改了

**A 的失败模式不是"起不来"，是"起来了但 error 通道不合 nbformat"。** 主夹具三条判据全绿
（`doubled=42` / `alive=42` / `rows=6`，10.5s，+70MB，运行时不联网），但编译期错误那条 iopub `error` **缺 `traceback`** ⇒
① `nbformat/v4/nbbase.py:112` 的 `output_from_msg` 无兜底下标 ⇒ **负例夹具根本跑不了**（`allow_errors=True` 绕不过它）；
② **真界面上 Jupyter 前端自己报** `Kernel message validation error: Missing property 'traceback'`
⇒ 用户写坏一段 Scala 代码之后**看不到任何报错**。练习产品里这比"跑不起来"更坏。

⇒ **这一档的测量顺序因此倒过来**（省一轮 15-20 分钟的镜像构建不是目的，目的是别让"看起来全绿"骗一次）：

- [ ] **Step 0: 先把镜像还原成 HEAD 的样子**（现在跑着的 `daily-arena:0.1` 是 **2.62GB、里面烤着 A 那批 almond 改动**，
  而工作树已经不含它们 —— A 的产物存在 `.superpowers/sdd/<本档>/path-A-almond/`）。
  `docker compose up -d --build arena` 一次，核 `docker images` 回到 ≈2.55GB 再往下走。
  **不还原就量，B 的体积增量会把 A 的 70MB 算到自己头上。**
- [ ] **Step 1: 取件与版本匹配核对**：Toree 的公开制品是 Spark 3.1/3.2 时代的 Scala 2.12 构建 ——
  **先核对它与镜像里的 Spark 3.5.5 能不能同一条类路径跑**，核对方式就是一次 `--execute` 探针，
  不要靠读 release note 下结论（本仓库的规矩：结论要来自当场跑）。
  ⚠ 沿用 A 量出来的两条 classpath 纪律：与 `/opt/spark/jars` 同名的 artifact **让 Spark 那份赢**
  （Scala 三件套 / slf4j 绑定 / scala-xml 混版的后果是 `NoClassDefFoundError`，不是一个能读的报错），
  并且给取件脚本加一条**漂移闸门**（那几个名字出现在 dest 里就直接失败）；
  直接 `java` 起 JVM 必须自带那 13 条 `--add-opens`（JDK 17 上少它就撞 `IllegalAccessError: ... sun.nio.ch`，
  内容与判题侧 `server/src/exec/spark-scala.ts` 的 `SPARK_JVM_FLAGS` 同源）。
- [ ] **Step 2: kernelspec 与启动器**：Toree 走自己的 `toree-launcher`，`kernel.json` 的 `argv` 会指向一个 shell/java 启动脚本；
  ⚠ 特别注意 `entrypoint.sh` 那条 **PATH 前置 IDE venv** 的既有形状（红线①延伸）：Toree 起的子进程继承谁的 PATH，要实测并写下来
  （A 那条是绝对路径 `/usr/bin/java`、不经 shell ⇒ 不受影响；B 的 launcher 若是 shell 脚本就**必须实测**，
  判法：`docker compose exec -T arena bash -lc 'cat /proc/<pid>/environ | tr "\0" "\n" | grep -E "^(PATH|PYTHONPATH|HOME)="'`）。
- [ ] **Step 3: 探针 —— 先跑负例，再跑正例**
  1. **负例先跑**（`99-probe-scala-no-def.ipynb`，一个编译错，秒级）：
     `jupyter nbconvert --to notebook --execute --stdout --ExecutePreprocessor.kernel_name=<B 的 id> --ExecutePreprocessor.timeout=180 --ExecutePreprocessor.allow_errors=True server/test/notebooks/fixtures/99-probe-scala-no-def.ipynb`
     - **对照必须一起做**：同一份夹具喂 `python3` 今天给 `EXIT=0` 且两个 cell 各自落成 `error`（A 档量过）⇒
       只有 B 那条 `KeyError: 'traceback'` 才是 B 的错，两边都炸就是量具/夹具的错。
     - 负例跑不通 ⇒ **这一档就可以定"卡在排序规则①"**，正例那一次 Spark 冷启动可以省掉（但省了要在报告里写明"没跑"而不是"会绿"）。
  2. **正例**（`99-probe-scala.ipynb`）：三条判据的读法与 A 档一致（`alive=42` 在 stdout、stream 通道、`rows=6`）。
  3. **界面上那条也要看**（A 的教训：量具绿不代表用户看得见报错）：浏览器 console 里出现
     `Kernel message validation error` 就是同一种坏，**这一条控制端本人复核**。
- [ ] **Step 4: 代价六项 + 结论与提交**（与 A 同一组字段，缺一项 Task 5 那张表就填不出来）：
  三条判据（负例/正例分开写）/ 镜像体积增量（**Step 0 还原之后再量**）/ 构建时长 / kernel 启动墙钟 /
  新增可写目录与残留进程（`find /app/data -maxdepth 1 -newermt '-1 hour'` + `pgrep -c java`，跑前跑后各一次）/
  **运行时是否需要网络**（把 `/etc/resolv.conf` 打成 `nameserver 127.0.0.1` 再跑一次，跑完还原；不许用"jar 都在本地"代替实测）。
  结论一句话 + 原始输出。Commit：`spike(notebooks): WI-91 Task 3 —— Toree 实测（结论：…，依据是 X）`
  ⚠ **收尾必做**：这一档的镜像改动如果最终不接入，要**存 patch 归档 + 还原工作树**，
  并且**下一次构建之前不要声称"跑着的 = HEAD"**（A 档就是这么把 2.62GB 的镜像留在机器上的）。

---

## Task 4：路径 C —— 自包 `IMain`（编译器已在镜像里，只缺 ZMQ）

- [ ] **Step 0: 先把镜像还原成 HEAD 的形状**（与 Task 3 同一条：上一档若留了烤进镜像的东西没还原，
  这一档的体积增量就会算到别人头上）。核 `docker images` 与 `jupyter kernelspec list` 再往下走。
- [ ] **Step 1: 只加一个 jeromq jar**（纯 Java ZMQ 绑定，无本地库、无 Python）—— 来源、版本、sha256 同 Task 2 的纪律。
  先跑一次最小连通性验证：`java -cp jeromq.jar` 起一个 REP socket，`python3 -c "import zmq; …"` 连上去发一帧
  （**这一步只回答"这个 jar 在这台 JVM 上能不能用"**，与 kernel 协议无关；不行就直接否掉路径 C，省掉后面全部工作）。
- [ ] **Step 2: Jupyter 协议的最小实现**（`kernel-info_request` / `execute_request` / `status` / `stream` / `execute_reply` / `shutdown_request`，
  ZMTP 的 identity + ROUTER/REP/PUB 三件套；`hmac` 签名那一层照 `jupyter_server` 的 `SignatureTransformer` 实现）。
  **范围钉死**：不做 `complete_request`（Tab 补全）、不做 `inspect_request`、不做中断（`sigint`）—— 那三件是"能用"之外的东西，
  写进来会让这一档从"探索"变成"维护一个自研 kernel"。探索期就把它们标为未支持，页面/文档不许把它们说成有。

  ⚠ **路径 A 的教训在这一档变成一条硬要求：`error` 消息必须带 `traceback`。**
  A 死就死在它发的那条 iopub `error` 缺这个键 ⇒ `nbformat/v4/nbbase.py:112` 的 `output_from_msg` 无兜底下标就 `KeyError`
  （`allow_errors=True` **绕不过**），而真界面上 Jupyter 前端自己报 `Kernel message validation error: Missing property 'traceback'`
  ⇒ 用户写坏代码看不到报错。⇒ 这一档的 `error` 消息必须至少含 **`ename` / `evalue` / `traceback`（字符串数组）** 三件，
  `stream` 消息必须含 **`name`（"stdout"|"stderr"）与 `text`**；少任一件就是"我们重犯 A 的错，而且这次是我们自己的代码"。
  **这条是我们唯一的结构性优势**：A/B 的 error 通道是别人的代码，改不动；C 的发什么字段我们说了算。
  写进决策表时别只算"多写多少行"，要算"只有这一条路能把编译错误报给用户"。
- [ ] **Step 2b: 负例先跑**（Task 2/3 定下的顺序，理由：**负例秒级、正例要起 Spark，而 A 恰恰是"正例全绿、负例跑不了"**）。
  先跑 `99-probe-scala-no-def.ipynb`（摘掉定义格 ⇒ 必然编译错）：它必须**能被 nbconvert 执行完**且落成 `output_type=error`，
  而 `alive=42` **不许**出现。跑不通就地定案，别去跑正例。
- [ ] **Step 3: 探针 + 代价**：与 A/B 同一组数字（三条判据 / 体积 / 构建时长 / 启动墙钟 / 新增可写状态 / 运行时是否联网），
  另加两行：**代码量**（`wc -l`）与"我们自己要维护什么"的一句话清单（协议版本漂、Scala 版本升级、Jupyter 消息规范变更都在我们这边）。
- [ ] **Step 4: 结论与提交**。收尾同 Task 3：**不接入就存 patch 归档 + 还原工作树**，并写清"跑着的镜像 = HEAD 与否"。

---

## Task 5：决策与交接（三条都不行也是一种合格交付）

> **落地记录（2026-10-10，控制端本人执行）**：决策表与结论已写进
> **`docs/superpowers/plans/2026-10-10-scala-kernel-integration-wi91b.md` §0**（胜出 = **B · Toree 0.5.0-incubating**，
> A 卡在排序规则①，C **不试**并登记成条件账）。
> 三条路径的镜像产物**全部归档**、工作树已还原：A 在 `.superpowers/sdd/<本档>/path-A-almond/`、
> B 在 `…/path-B-toree/`（patch + 取件脚本 + kernelspec + 制品清单）。
> 探针脚手架（`scalaKernelProbe.ts` + 两份夹具）**保留**，由 WI-91b 的 Task 1/4 转成容器档闸门 —— 它不是死代码，是下一版的起点。
> ⚠ 这一版**没有**做 Step 2②/③（`needsVenv` 按-kernel 重构、页面边界那几句）与 Step 3/4（三档、真浏览器）：
> 它们属于"接入"，按本文件 Architecture 那一段的约定另出一版计划做，见 WI-91b 的 Task 3/5。
> 本文件到此结束。

- [ ] **Step 1: 决策表**（把三档报告里的原始数字并成一张表：三条判据 / 体积增量 / 构建时长 / 启动时长 / 新增可写状态 / 新增我们自有的代码行数 / **运行时是否需要网络**）。
  排序规则先写死再填表：**①** 三条判据成立；**②** 运行时不需要网络（这条是硬门槛 —— 它是"离线构建可复现"那条评论的延伸）；**③** 不新增镜像外的可写状态；**④** 体积与自研代码量最小。
- [ ] **Step 2: 无论结论如何都要做的三件**：
  ① 删掉探针脚手架里不该长留的部分（`scalaKernelProbe.ts` 若胜出就转成容器档闸门 `scala-kernel.test.ts`，由 `verify.sh` 那条 notebook 阶段认领；若三条全不行就整块删掉，不留"以后可能用"）；
  ② `server/src/notebooks/status.ts` 那句 `id === NOTEBOOK_KERNELS.pyspark` 与 `web` 侧 `missingSpec` 的按-id 陷阱（**WI-96**）——
     只有在胜出路径要新增 id 时才顺手做，且必须做成"`NOTEBOOK_KERNELS` 里每个 kernel 带自己的 `needsVenv`/`ready` 判据"，
     而不是再加一个 `||` 分支（这是本仓库反复付学费的"第四处字面量"形状）；
     ⚠ 同一形状的**第三处**字面量在 WI-90 那道题闸门里：`tutorials.test.ts` 的执行层把每篇教程的
     `metadata.kernelspec.name` 硬判成 `NOTEBOOK_KERNELS.pyspark`。今天它对 Scala 是**对的**（教程就该跑在那条能跑的 kernel 上），
     但"Scala 教程转正"那一刻它必须跟着变成**注册表里每条自带它期望的 kernel**（与 `needsVenv` 同一次重构、同一个判据形状），
     不许就地改成"pyspark 或 scala"—— 那是把"这篇教程跑在内核上"这件事从判据变成备注。
  ③ 页面边界那一句话：Scala kernel 会再起一个 JVM（`local[*]`），按 WI-95 的口径**如实**写进 `Notebook.tsx` 的边界块，不许写成"与判题互不影响"。
- [ ] **Step 3: 三档验证**（有代码进镜像/服务时）：`./start.sh --verify` ⇒ `CV_EXIT=0` + 矩阵 `跳过 0` + notebook 阶段出现 1 次；
  `npm run verify:fast` ⇒ 0；`npm run e2e` ⇒ 0（e2e 实例没 token ⇒ 没 Jupyter，那里只能诚实判"没在跑"那一态，别为它伪造）。
  三条全不行的探索结论档：只需 `verify:fast` 绿（探针脚手架不进产品代码）。
- [ ] **Step 4: 真浏览器**（只有胜出并接入时才做）：iframe 里选到 Scala kernel、两个 cell 之间状态存活、console error/warning 均 0、停 60 秒服务还在。
- [ ] **Step 5: 记忆与工作板**：`memo.md` 里程碑（含三条路径各自的**实测否决理由**，这是最有价值的部分）；
  `HANDOVER.md` WI-91 移项 —— 结论是"接入 X、Y/Z 为什么不行"或"三条都不行， Scala 侧继续用 A1 的替代形状，原因如下"。

---

## 完成判据（两种都算合格）

1. **有 kernel 接入**：三条判据（跨 cell 存活 / stream 输出 / 活的 SparkSession）在容器档闸门里成立且做过破坏性验证；运行时不需要网络；新增状态落在实例自己的数据目录里；三档验证绿；真浏览器里选得到、跑得起。
2. **三条都不行**：一份带原始输出的决策表 + 探针脚手架已删除（不留死代码）+ `memo`/`HANDOVER` 写明每条被什么否决、以及 Scala 侧继续用什么形状。**这不算失败** —— 它算把"做不到"变成有据可查的边界。

**不合格的样子（预先写破）**：把 `handleOutput` 那种分段编译包装成"真交互"；只在有网的时候跑得通；探针判据从"`alive=42`"被悄悄改成"没报错"；`NOTEBOOK_KERNELS` 加了 id 但 `ready`/`missingSpec` 还只 key 在 pyspark 上（那是把一个真 kernel 显示成假状态）。
