# WI-91b：把 Toree 接成第五页可用的 Scala kernel —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 把探索档量出来的 `arena-scala-toree` 接成**页面上选得到、跑得动、闸门判得住**的 Scala kernel（今天只有 `arena-pyspark`）。

**Architecture:** 三条限时路径的探索（WI-91）已结束，结论是 **B（Apache Toree 0.5.0-incubating）过排序规则①②③、A（Almond）死在①、C 不试**（理由见 `docs/superpowers/plans/2026-10-10-scala-jupyter-kernel-spike-wi91.md` 的 Task 5 与本计划 §0）。
本计划做四件事：**① 先把量具改对**（Toree 污染 stdout，不改就判不了）；**② 把 kernel id 登记进唯一真相并按-kernel 拆 `ready` 判据**（WI-96）；**③ 一条 Scala smoke 进容器档闸门**；**④ 页面边界说实话**（第二个 JVM、`Unknown Error`、版本常量说谎）。
B 的全部镜像产物**已归档**在 `.superpowers/sdd/2026-10-10-scala-jupyter-kernel-spike-wi91/path-B-toree/`（patch + `fetch-toree.sh` + kernelspec + 制品清单），Task 1 是从那里落回工作树，不是重新发明。

**Tech Stack:** Spark 3.5.5（Scala **2.12.18** 构建）、Toree 0.5.0-incubating（其公开制品是 Spark 3.1/3.2 时代构建 ⇒ 兼容性由探针实测，不由 release note）、jupyter_server 2.21.1 / nbclient / nbformat v4、`docker/Dockerfile` + `docker-cache/`。

**Spec:** `docs/superpowers/specs/2026-10-05-jupyter-notebook-runtime-design.md`（A2 那一节）；探索档的结论与全部实测读数：
`docs/superpowers/plans/2026-10-10-scala-jupyter-kernel-spike-wi91.md` + 同里程碑 workspace 里的 `task-2-report.md`（A）与 `task-3-report.md`（B，含控制端复量的读数与两条新症状）。

## Global Constraints

- **红线①不许碰**：kernel 不得进入判题环境的执行路径（`server/src/exec/**` 一行都不改）；
  探索档已核过 B 侧"只读 `/opt/spark/jars`、jar 全在 `/opt/toree/lib`、launcher 用绝对路径 java"⇒ 接入时**重验一遍**，别继承结论。
- **kernel id 的唯一真相是 `NOTEBOOK_KERNELS`**（`shared/src/notebook.ts`）。加一条就是在这一处加，
  `status.ts` 的 allow-list、前端默认选择、测试断言全部由它派生 —— **第四处字面量**是本仓库反复付学费的形状（WI-96）。
- **不许为了变绿去改判据**；`embed.test.ts` / `kernel.test.ts` / `tutorials.test.ts` / `proxyGuard.test.ts` / `proxy.test.ts` 条数只增不减。
- **改量具 ≠ 放宽判据**，两者必须分清楚（本计划 Task 1 的全部理由就是这条区分）。
- 镜像构建必须离线可复现：jar 走 `docker-cache/` + 清单记 **URL 与 sha256**，逐件校验、失败要说清"哪个文件、期望什么、拿到什么"；
  **不许 `curl -f || true`** 那种静默跳过。
- 不引 npm/pip 依赖；`.env` 不读不打印；不占 7799；提交身份逐条 env 传 noreply，禁止 `--no-verify`/amend/push；
  并行作业期间提交**必须带显式 pathspec**；**不 `git clean -fdx`、不删数据卷**。
- 三档验证入口不变：`npm run verify:fast`（宿主）/ `./start.sh --verify`（容器，判题矩阵必须 `跳过 0`）/ 宿主 `npm run e2e`；
  前端改动必须真浏览器看过（console **error 与 warning 按来源判**、换一次状态、故意停 ~60 秒）。

---

## 0. 决策表（排序规则先写死再填；数字全部来自探索档的实测，不是估计）

排序规则：**①** 三条判据成立（含**负例夹具必须能被执行**）→ **②** 运行时不需要网络 → **③** 不新增镜像外的可写状态 → **④** 体积与自研代码量最小。

| | A · Almond 0.15.0 | **B · Toree 0.5.0-incubating** | C · 自包 `IMain` |
| --- | --- | --- | --- |
| 正例三条判据 | 全绿（`alive=42`/`rows=6`） | **全绿**（同） | 未试 |
| **负例夹具（摘掉定义格）** | **跑不了**：iopub `error` 缺 `traceback` ⇒ `nbformat/v4/nbbase.py:112` `KeyError`；**真界面也报** `Kernel message validation error` ⇒ 用户写坏代码看不到报错 | **跑得通**：`ename`/`evalue`/`traceback` 三件齐，`NEGF_EXIT=0` | 未试 |
| 运行时联网 | 不需要 | **不需要**（断网复测 `EXIT=0`） | 未试 |
| 镜像外可写状态 | 无（`HOME` 指了但没创建） | 无（探索档实测跑完 `pgrep -c java` 归 0） | 未试 |
| 体积增量 | +70MB（93 个 jar） | **+30MB**（`/opt/toree/lib` 25M） | 未试（只加一个 jeromq，最小） |
| 整本探针用时 | 10.5s | 11.3s / 11.7s | 未试 |
| 自研代码量 | 0 | 0 | **一个 ZMQ kernel**（协议 + HMAC 签名 + 三件套 socket）⇒ 长期维护在我们这边 |
| 已知缺陷 | 错误通道不合协议（**致命**） | ① stdout 污染（两行解释器注册表混在 nbconvert `--stdout` 的 JSON 前面）⇒ **我们的量具读不出**；② `ename` 恒为 `Unknown Error`、`traceback` 是空数组；③ `language_info.version` 报 2.12.15 而实载 2.12.18；④ `spark.stop()` 收尾炸一条 `Shutdown hooks cannot be modified during shutdown` | 未试 |

**结论：接 B。** A 的缺陷在别人的代码里、我们改不动；B 的四条缺陷里只有 ① 有牙齿（它让闸门失明），而 ① 是**我们工具侧**能修的（Task 1）。
**C 不试**，并把它登记成一条"如果 B 的 ②③④ 里任何一条在真界面上变成产品问题，再回来做 C"的账（见 §9）。
这不是省事 —— 探索档的排序规则里 C 唯一能赢 B 的地方是 ④ 的"体积最小"，而它要付的代价是"我们自研并长期维护一个 kernel"，
那正是探索档自己警告过的"从探索变成维护"。

---

## Task 1：先把量具改对 —— `nbconvert` 的读法从"整个 stdout 当 JSON"改成"落盘读文件"

**为什么它是第一个而不是第二个**：不修这一步，后面每一条 Scala 断言都会红成"这一档跑不起来"，
而那句红话与"kernel 真的坏了"**长得一模一样**（本仓库最恨的静默降级形状）。

**Files:**
- Modify: `server/test/notebooks/notebook-evidence.ts`（`executedNotebookEvidence` 的输入来源；新增/改一个"取执行结果"的入口）
- Modify: `server/test/notebooks/scalaKernelProbe.ts`（探针走新入口）
- Test: `server/test/notebooks/embed.test.ts` 或新建 `server/test/notebooks/notebook-evidence.test.ts`（若新建，**必须**被 `verify.sh` 某阶段认领 —— 见 Task 5 的门禁接线）

- [ ] **Step 1: 写失败的测试** —— 判"读法"而不是判"kernel"：

```ts
// 一份"前面混了两行垃圾、后面才是合法 notebook JSON"的 stdout，必须被读出来
const polluted = '(Scala,org.apache.toree.kernel.interpreter.scala.ScalaInterpreter@1015a4b9)\n'
  + '(SQL,org.apache.toree.kernel.interpreter.sql.SqlInterpreter@1acb74ad)\n'
  + JSON.stringify({ cells: [], metadata: { kernelspec: { name: 'x' } } });
expect(readExecutedNotebook(polluted).cells).toEqual([]);
```

再加一条**形状判据**：`readExecutedNotebook` 在"整段都不是合法 JSON"时**必须抛**（不许静默返回空 cells ——
那会把"kernel 坏了"读成"这个 notebook 没有 cell"）。

- [ ] **Step 2: 跑它，确认红在"今天 `JSON.parse(整个 stdout)` 会抛"**（红话要能指出是前缀问题，不是内容问题）。
- [ ] **Step 3: 实现** —— 两条路选一条并写清理由：
  (a) **改调用方式**：`--stdout` 换成 `--output <临时文件>` 再读文件（**首选**：垃圾留在 stderr，JSON 是干净的）；
  (b) 兜底：从第一个 `{` 起切。**只选 (a) 或 (b) 之一作为主路径**，另一条若也实现，必须有各自的测试。
  ⚠ 走 (a) 时临时文件必须落在**实例自己的数据目录**并收尾删除（WI-40 那条纪律；`tutorials.test.ts` 里已有一条
  "scratch 不许留在工作区"的同形状判据可以照抄）。
- [ ] **Step 4: 破坏性验证**：① 把 (a) 的临时文件读取改回 `JSON.parse(stdout)` ⇒ Step 1 那条测试必须红；
  ② 让"整段不是 JSON" ⇒ 必须抛且红话不谎报"跑不起来"；③ 还原 ⇒ 绿。
- [ ] **Step 5: 宿主档 + Commit**（`test(notebooks): WI-91b Task 1 —— 量具先改对：Toree 的 stdout 污染不许被读成"kernel 坏了"`）

## Task 2：把镜像产物落回工作树，并让它可复现

**Files:**
- Apply: `.superpowers/sdd/2026-10-10-scala-jupyter-kernel-spike-wi91/path-B-toree/tracked-changes.patch`（`docker/Dockerfile`、`.gitignore`、`.dockerignore`）
- Restore: `scripts/fetch-toree.sh`、`docker/jupyter/kernels/arena-scala-toree/`、制品清单（`docker-cache/toree/…/toree-artifacts.tsv`）
- Modify: `docker/BUILDINFO.md`（记版本、来源 URL、sha256 清单在哪个文件）

- [ ] **Step 1: 落回 + 一次 `docker compose up -d --build arena`**，核 `jupyter kernelspec list` 有 `arena-scala-toree`、`docker images` ≈ 2.58GB。
- [ ] **Step 2: 离线可复现性**：清掉本地 toree 缓存后 `--build` 必须还能成（走清单下载并逐件校验）；
  **破坏性验证**：把清单里一个 sha256 改错一位 ⇒ 构建必须失败且说清"哪个文件、期望什么、拿到什么"。
- [ ] **Step 3: 红线①重验（不许继承探索档的结论）**：`kernel.json` 的 argv 是否绝对路径 java、
  子进程 `PATH`/`PYTHONPATH` 实测（`cat /proc/<pid>/environ | tr '\0' '\n' | grep -E '^(PATH|PYTHONPATH|HOME)='`）、
  有没有往 `/opt/spark/jars` 或判题侧 site-packages 写东西。
- [ ] **Step 4: Commit**（`build(notebooks): WI-91b Task 2 —— Toree 0.5.0 落回工作树，清单+sha256 可离线复现`）

## Task 3：登记 kernel id，并把 `ready` 判据做成"每个 kernel 自带"（**WI-96 就是这一条**）

**Files:**
- Modify: `shared/src/notebook.ts`（`NOTEBOOK_KERNELS` 加 `scala`）
- Modify: `server/src/notebooks/status.ts`（**删掉 `id === NOTEBOOK_KERNELS.pyspark` 那句按-id 硬判**，改成每个 kernel 条目自带 `needsVenv` 之类的就绪判据）
- Modify: `web/src/pages/Notebook.tsx`（`missingSpec` 现在只 key 在 pyspark 上 ⇒ 改成"表里缺哪条就点哪条"）
- Test: `server/test/notebooks/status.test.ts`、`web/test/notebook.test.tsx`、`server/test/regression/notebook-contract.test.ts`

- [ ] **Step 1: 先写红的契约测试**：`NOTEBOOK_KERNELS` 有两条 ⇒ allow-list 两条都在；
  `arena-scala-toree` **不依赖 IDE venv**（venv 不存在时它仍 `ready:true`，而 `arena-pyspark` 仍 `ready:false`）；
  `missingSpec` 在"只有 pyspark 注册"时点名 pyspark、在"只有 scala 注册"时点名 scala。
  ⚠ 这一步会暴露 `status.ts` 里那句 `needsVenv = id === NOTEBOOK_KERNELS.pyspark` 与 `||` 分支的诱惑 ——
  **做成数据（每个 kernel 一条记录），不许加 `||`**。
- [ ] **Step 2: 实现 + 跑绿**；`verify:fast` 必须 0。
- [ ] **Step 3: 破坏性验证**：① 把 scala 那条的 `needsVenv` 误写成 `true` ⇒ venv 缺席时它必须 `ready:false`（测试红）；
  ② 从 `NOTEBOOK_KERNELS` 删掉 scala ⇒ allow-list 那条必须红（证明派生没退化成第二份清单）。
- [ ] **Step 4: Commit**（`feat(notebooks): WI-91b Task 3 —— kernel id 进唯一真相，ready 判据改成按-kernel（还 WI-96 的账）`）

## Task 4：一条 Scala smoke 进容器档闸门

**Files:**
- Create: `content/notebooks/04-scala-smoke.ipynb`（**或**把探索夹具转正为 smoke —— 见下面的裁决点）
- Modify: `server/test/notebooks/tutorial-claims.ts`（若走题闸门）或新建 `server/test/notebooks/scala-kernel.test.ts`（若走独立阶段）
- Modify: `scripts/verify.sh`（新阶段或把新文件接进现有 notebook 阶段）

- [ ] **Step 1: 先定形状**（这一条要写进提交信息，别默默选）：Scala smoke **不进** `tutorials.test.ts`
  —— 那道题闸门有三条按 Python 形状写的判据（`kernelspec.name === arena-pyspark`、末 cell 必须 `spark.stop()`、
  marker 单元必须有 `assert`），而 B 的 ④ 说 `spark.stop()` 在 Scala 侧会炸收尾。
  ⇒ 走**独立容器档阶段** `scala-kernel.test.ts`，复用 Task 1 改好的量具与 `notebook-evidence.ts`。
- [ ] **Step 2: 写测试**（三条判据 + 负例各一条）：`alive=42` 在 stdout、`rows=6`、负例夹具能跑出 `error` 且 `alive=42` 不出现。
- [ ] **Step 3: 门禁接线**（"门禁自己也要被门禁"）：新 `*.test.ts` 必须被 `verify-coverage` 认领；
  env 门控的闸门必须被"真设了那个变量"的阶段认领；**并且接 `assert-ran.mjs --require-no-skips`**
  （WI-90 交付档刚给教程闸门接的那一条，Scala 这条同样会"整片 skip 仍 exit 0"）。
- [ ] **Step 4: 破坏性验证**：① 把门控变量名改错 ⇒ 容器档必须红在"整片 skip"；② 摘掉 `--require-no-skips` ⇒
  `verify-coverage` 那条 env 判据必须红；③ 把负例那条删掉 ⇒ 必须红。
- [ ] **Step 5: Commit**（`test(notebooks): WI-91b Task 4 —— Scala kernel 进容器档闸门（独立阶段，不复用 Python 形状的三条判据）`）

## Task 5：页面与文档说实话

**Files:**
- Modify: `web/src/pages/Notebook.tsx`（边界块）、`README.md`、`docs/ARCHITECTURE.md`、`HANDOVER.md`、`memo.md`

- [ ] **Step 1: 边界那几句必须写全四件事**（一条都不许美化）：
  ① Scala kernel 起的是**判题池之外的第二个 Spark JVM**（`-Xmx` 那个量级照实写，WI-95）；
  ② 编译错误在界面上 `ename` 恒为 `Unknown Error`、**没有 traceback 帧**，有用的文本在 `evalue` 里；
  ③ `language_info.version` 报 2.12.15 而实载 2.12.18 ⇒ **页面上不许显示这个 version**；
  ④ 补全 / 悬浮文档 / 中断（`sigint`）在 Scala 侧**不支持**，不许被界面说成有。
- [ ] **Step 2: 三档验证**：`npm run verify:fast` → 0；`./start.sh --verify` → `CV_EXIT=0` + 矩阵 `跳过 0` +
  notebook 那几条阶段各出现恰好 1 次且区间内 `skip` 为 0；宿主 `npm run e2e` → 0。
- [ ] **Step 3: 真浏览器**：`#/notebook` 里 kernel 徽标两条、iframe 里能选到 Scala kernel、
  跑一个 `val` + 第二格引用它（状态活）、**故意写坏一行看它报不报错**（这一条是 B 的产品承诺）、
  console error/warning **按来源**判（我们自己的 bundle 必须 0）、停 ~60 秒服务还在、`pgrep -c java` 收尾归 0。
- [ ] **Step 4: 记忆与工作板**：`memo.md` 里程碑（含 A 被否的完整证据链 —— 那是最有价值的部分）；
  `HANDOVER.md` WI-91 → COMPLETED，并开一条新 WI 记 C（见 §9）。

---

## 9. 留给后面的两条账（不在本计划内做）

- **C（自包 `IMain`）**：只有当 B 的 ②③④ 里任何一条在真界面上变成**产品问题**时才回来做。
  它的唯一结构性优势是"`error` 消息发什么字段我们说了算"（A 就是死在别人说了算的那一件上）。
- **Scala 教程 notebook**：B 接入后，`tutorials.test.ts` 那条"每篇期望哪条 kernel"必须做成**注册表自带字段**
  （探索档已记：不许就地放宽成"pyspark 或 scala"）。

## 完成判据

1. 页面上选得到 Scala kernel 且**跑得过**（真浏览器，不是单测）；
2. Scala 侧有一条容器档闸门，**整片 skip 会红**，且三条判据 + 负例都实测过破坏性验证；
3. `NOTEBOOK_KERNELS` 是 kernel id 的唯一真相，`ready` 判据按-kernel 带数据（WI-96 还掉）；
4. 三档验证全绿且退出码是被**看到**的，不是推断的；
5. §5 那四句边界话在页面上都在，且没有一句是"应该没问题"。
