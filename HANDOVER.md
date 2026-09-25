# HANDOVER 工作板

> 配套 skill：`.qoder/skills/handover/SKILL.md`。规则（需求文档第 5 条）：
> 完成 ⇒ 从 TODO/IN PROGRESS 删除并入 COMPLETED（带验证命令与结果）；新需求 ⇒ 新增 WI；砍功能 ⇒ 删 WI 并在 `memo.md` 记原因。
> 状态需与 `openspec/specs/`（已归档的规格真相）及 plan 的 checkbox 一致；
> 变更历史在 `openspec/changes/archive/2026-09-19-build-daily-interview-arena/`。

## COMPLETED

- [x] WI-00 需求通读 + 环境勘察 + 实施计划（`docs/superpowers/plans/2026-09-19-daily-interview-arena.md`）
- [x] WI-01 治理基线：git、`.npmrc`(npmmirror)、`rule.md`、`memo.md`、本工作板｜验证：`git log --oneline` 有 baseline commit
- [x] WI-02 openspec 规格化 + 本地 handover skill｜验证：`openspec validate build-daily-interview-arena --strict` → valid；`openspec status` → 4/4 artifacts
- [x] WI-03 `shared/` 契约层｜验证：`npx vitest run shared` → 26 passed；`npx tsc -b shared` 0 error
- [x] WI-05 题库子系统（append-only ingest / 软删除 / 坏文件不阻断）｜验证：`npx vitest run server/test/bank` → 12 passed
- [x] WI-06 Java(JUnit5) 判题器｜验证：容器内 5 passed，单次 ≈1.5s，沙箱零残留
- [x] WI-07 React/TS(vitest) 判题器｜验证：容器内 8 passed，单次 0.8-2.4s（复用镜像 node_modules，不重新 install）
- [x] WI-08 MySQL + Redis 判题器｜验证：容器内 11 passed；MySQL ≈0.55s；判题后无 `arena_%` 库；`FLUSHALL`/多语句被 forbidden 拒绝
- [x] WI-09 PySpark 判题器 + 常驻 SparkSession 池｜验证：容器内 10 passed；冷启动 8.9s → 复用 1.2s；超时自动重启 worker；Spark SQL 可判
- [x] WI-10 主观题评分链（qodercli → copilot → manual + 逐项 rubric）｜验证：`npx vitest run server/test/llm` → 41 passed（含真调 qodercli 的 real 测试）
- [x] WI-11 游戏后端：`node:sqlite` DB、每日套餐、XP/streak/成就、Fastify API + SSE｜验证：容器实跑 + `POST /api/judge` 参考解 5/5、XP 2→15、streak 仍 0（未达 20 门槛）
- [x] WI-12 React 前端（浅色主题 / CodeMirror / 用例面板 / 移除按钮 / 进度页）｜验证：浏览器实测四页 + `npx vitest run web/test` → 52 passed
- [x] WI-19 参考解自证矩阵 + 题库结构闸门（reference 必须 pass、naive 必须 fail）
- [x] WI-20 知识库先行：7 类考点矩阵 + 专题（143 考点，版本经联网核实）｜`npm run kb:index` → `content/knowledge/INDEX.md`
- [x] WI-22 宿主 CLI 桥 `scripts/llm-bridge.mjs`（容器是 linux、qodercli.exe 在宿主）｜验证：`POST /api/grade` → provider=bridge、10 分制 + 加分点 + 不足点 + 逐项 nextStep，42.6s
- [x] WI-23 答题形态可选（文本/Markdown ↔ 代码 + 语言高亮）与"美化代码"按钮（用户新提）｜验证：`npx vitest run web/test/answer-input` → 5 passed
- [x] WI-24 全流程日志模块（用户新提）：`data/logs/arena-<日期>.log` JSONL、traceId 贯穿 HTTP→判题→评分、28 天保留自动清理｜验证：`npx vitest run server/test/log` → 3 passed；`npm run logs -- --trace <id>`
- [x] WI-14 第一版题库 100 题：big-data 20 / algorithms 18 / frontend 12 / sql 16 / system-design 14 / agent-design 10 / hot-interviews 6｜验证：各类别容器内矩阵全绿（algorithms 38、sql 34×3、frontend 26×3、big-data 26）
- [x] WI-18 题库刷新脚本：`scripts/jd/*`（Airbnb Greenhouse 真抓 36 条 / Apple 解析 17 条 / 离线样本降级）+ `scripts/bank/generate-with-cli.mjs` + `scripts/kb/compile-knowledge.mjs`
- [x] WI-21 30 天排课 `scripts/curriculum.mjs`｜验证：产出 30 天套餐（题库齐了需再跑一次刷新）
- [x] WI-04 单镜像多技术栈运行时：一个镜像装下 Node/JDK/MySQL/Redis/PySpark/Scala 编译器，三层 Dockerfile（stack→deps→app），端口映射 7788，全部数据与缓存在仓库内｜验证：带最终代码 `./start.sh --rebuild` 三次均健康；容器内 `/api/health` 报 java-junit/react-vitest/mysql/redis/pyspark/llm-rubric 全 true；`bash -n start.sh` 与 PowerShell 解析器均 0 错误（`start.ps1` 补上了起 CLI 桥 + UTF-8 BOM）
- [x] WI-13 防 regression 收口：`scripts/verify.sh` 六道闸门（lint→类型→单元→题库闸门→后端+前端→判题矩阵→E2E）+ pre-commit + 参考解自证矩阵｜验证：容器内 `npm run verify` 全绿（160 / 9 / 199 / 150）；宿主 Chrome E2E 6 条通过；容器内 Chromium 下载仍被网络挡住，已在 README「已知边界」记为走宿主 Chrome 通道
- [x] WI-25 最终验收 + 归档 + 打标签｜验证：容器内 `npm run verify`（lint/类型/单元 160/闸门 9/后端+前端 199/判题 150）✅、宿主 Chrome E2E 6 条 ✅、7 类逐类真做 ✅、`openspec archive` → `openspec validate --all --strict` 8 passed ✅、`git tag v0.1.0`
- [x] WI-29 自测用例通道（一行一组 `输入 => 期望` + Test 按钮，不写 attempt 不记分）｜验证：`npx vitest run web/test/custom-cases web/test/selftest-panel` 全绿；E2E「自测不影响进度」通过
- [x] WI-30 评分链可追溯性与三处静默降级修复｜验证：`/api/health` 现报 `llm-rubric:true`（探 `GradePort.available()`）；一次真评分 `trace req-2db39ca3` 用 `npm run logs -- --trace` 一条链捞完；`grade/fallback` 会写明每一档的降级原因；内层引号导致评分 JSON 作废的问题已修（`escapeStrayQuotes` + prompt 禁止），E2E 主观题断言收紧为"CLI 可用时不许出现人工自检清单"

- [x] WI-16 多 agent 协同固化：4 个只读 review agent 分区评审（判题安全 / 题库契约 / API+前端 / 评分链与脚本），逐条核实后修掉 19 条真缺陷（含 3 条 blocker：extraFiles 顶替判题测试、`/*!` 版本注释绕过 SQL 守卫、自测用例绕过 Redis/MySQL 白名单）｜验证：容器内 `npm run verify` 全绿且判题矩阵 **159 passed / 0 skipped**（新增 `scripts/assert-ran.mjs` 才第一次证明矩阵真跑过）；宿主 Chrome E2E 6/6；浏览器实测 Today 页 0 console error；详见 `memo.md` 里程碑 E

- [x] WI-34 作答工具栏窄宽度换行难看（用户提）：`.answer-bar` 允许整块换行 + 所有控件 `white-space: nowrap`（不再把"美化代码""文本 / Markdown"劈成两行），≤720px 时收起 spacer 让提示与按钮自成一组｜验证：浏览器实测 1800/900/760px 三档，760px 下整齐折成两行、无劈词；`npx vitest run web/test/answer-input` 5 passed
- [x] WI-36 今日页从"等边盒子一路往下"改成 flex 布局（用户提）：套餐头部去掉卡片外壳改成 flex 带（日期用 display 级 + 等宽数字，指标做竖线分隔的内联条，进度收成细线），今日套餐按**主菜 / 副菜**分两个 flex 组（`flex:1 1 320px` vs `1 1 260px`，左侧类别色竖条实线 vs 虚线表达主次），"按类别刷"从等大方阵改成 `flex-wrap` 胶囊条；状态条改横排不再悬空小块｜验证：浏览器实测 1280 / 480px 两档截图（窄屏徽标不再溢出卡片、标题省略号正常）；`npx vitest run web/test` 63 passed；容器内 E2E 6 passed；宿主 `npm run verify:fast` 全绿
- [x] WI-35 启动后用系统默认浏览器打开页面（用户提，默认是 Edge）：`start.sh` 走 `cmd.exe start` / `open` / `xdg-open`，`start.ps1` 走 `Start-Process <url>`，都交给 OS 默认 handler，不钦定 Chrome；`ARENA_NO_BROWSER=1` 可跳过；`--dev` 打开 5173｜验证：`./start.sh` 跑通且未打印"自动打开失败"；两脚本语法检查 0 错误

- [x] WI-27 `spark-scala` 判题器：真 `scalac` 编译 + 真 Spark `local[*]` 逐用例跑；契约 `object <className> { def solve(df: DataFrame): DataFrame }`，harness 直接引用它 → 签名错在**编译期**报 `errorKind:"compile"`，不做反射猜测；用例 JSON 与 pyspark 共用（值归一化逐条对齐）｜验证：容器内 `server/test/judge/spark-scala.test.ts` 5 passed（参考解 pass / 错误解 fail 到用例粒度 / 编译失败归类 / 缺 solve 的契约错误 / 沙箱零残留）；`/api/health` 现报 `spark-scala:true`；新题 `bd-scala-0001`（Scala Dataset API 求最长连续活跃天数）参考解 5/5 pass、朴素解 `count(distinct)` 被正确判 fail；容器内 verify 判题矩阵 **168 passed / 0 skipped**；浏览器实测 UI 提交该题 → 通过 5/失败 0、耗时 18.1s
  - 契约随之放宽两处：`Language` 加 `'scala'`（编辑器无离线语法包 → 纯文本，`美化代码` 如实说明只整理空白）；`runner.timeoutMs` 上限 120s → **180s**（Scala 每次都要编译）
  - 关键坑：`/opt/scala` 是独立下载的 Scala 2.13 三件套，而 Spark 3.5 是 2.12 构建 —— 混用会**编译通过但运行期 `NoSuchMethodError: scala.collection.GenTraversable`**；runner 改为优先用 `/opt/spark-jars` 自带的 scala-compiler/library/reflect

- [x] WI-32 评分链超时口径统一：新增 `sanitizeTimeoutMs`（坏值 `5m`/空/负数以前算出 NaN → `AbortSignal.timeout(NaN)` 同步抛错被吞成"这一档不可用"）；bridge provider 改走 `llmSettings()`（原来直读 config 绕过兜底）；`/complete` 把自己超时传给桥，桥按 `min(桥上限, 容器超时) - 5s` 给 CLI —— "桥 < 容器" 变成构造保证，不再靠两边记魔法数字｜验证：`server/test/llm/bridge-timeout.test.ts` 新增 3 条；宿主 `verify:fast` 全绿（后端+前端 212）；重建镜像 + 重启桥后真评分 32.5s `provider=bridge`、trace `wi32-live` 可查

- [x] WI-26 判题器剩余边界：① **`int[][]` 等嵌套原始数组已支持** —— `Harness.convert()` 之前只认一维，二维会被原样透传成 `List` 再被反射拒收（`IllegalArgumentException`，题目物理不可判）；现在按组件类型递归 `Array.newInstance`，`componentClass("int[]")` 补了"再降一层"的分支（`Class.forName("int[]")` 是不存在的名字）。② **JDK 17→21 评估结论：暂不升**（理由与代价见 WI-38）｜验证：容器内 `server/test/judge/java-junit.test.ts` 9 passed（新增 `int[][]` 用例：参考解 3/3 pass、"只加第一行"的错误解被点名到具体用例）；判题 + 自证矩阵 169 passed / 0 skipped
- [x] WI-37 E2E 状态隔离：**无法复现，判定为环境问题**。两次定向复现（先单独跑 `daily-flow` 通过，紧接着跑整套 → 6 passed / 46.6s）都没重现当初那次失败；该 spec 本身已是状态感知的（断言"XP 不倒退 + 该类别 passed≥1 + planned=3"，不假设"今天没做过题"）。当初那次失败发生在"容器刚重建、bundle hash 变了、同一浏览器会话还停在旧页面"的窗口里。彻底消除这类耦合的做法后来由 WI-40 落地
  **补充（WI-28 追出机制）**：那次"bundle hash 变了"确实会致命 —— `@fastify/static` 配 `wildcard:false` 时用的是**启动时扫目录得到的索引**，
  重建后新哈希的 chunk 不在索引里 → 走 SPA 回退返回 `index.html` → 浏览器拿到 `text/html` 的"JS"直接白屏（WI-28 期间在真浏览器上复现过同样症状）。
  现在 wildcard 打开、并有 `api.test.ts` 里"构建后才落盘的资源也必须能取到"钉住，这类"重建后偶发失败"应当消失
  （E2E 与真人进度/账本的状态耦合本身也已消除，见 WI-40）

- [x] WI-31 把测试文件纳入类型检查：新增 `shared/tsconfig.test.json` + `server/tsconfig.test.json`（noEmit，include src+test）与 `tests/tsconfig.json`（E2E spec 以前**连 tsconfig 都没有**），根 `typecheck` 串起 `typecheck:tests`，`verify.sh` 第 2 阶段即覆盖 → pre-commit 也管。清出 49 处类型错误（原估 46），42 处同一根因：`ProgressStore.getSetting/setSetting` 在端口里写成**必需**、但它实为"可选能力"（生产全走 `asSettingsStore()` 降级）→ **端口本身写错了**，改可选后一致；另有 `LlmProvider` 误从 `@arena/shared` import、ioredis 默认导入不可构造、zod `safeParse` 失败分支用 cast 绕过判别联合、`expect(x).toBeTruthy()` 不做类型收窄。顺带修掉两个同类假绿：workspace `typecheck` 是 `tsc -b --dry`（只打印计划、零检查）；`FakeStore.bestByQuestion` 同分取**更晚**（与真 store "取更早"相反，防刷分口径在假实现里是反的）。新守卫 `server/test/regression/typecheck-coverage.test.ts` 钉死覆盖面（目录认领 / noEmit / `-p` 点名 / 无 `--dry` / 无孤儿测试文件）｜验证：破坏性试验——临时给 `GradePort` 加必需方法，`api.test.ts(60,7) FakeGrade incorrectly implements` 立刻报警（正是当初"无人报警"那条）；宿主 `verify:fast` 全绿（单元 85、后端+前端 213）；容器 `SKIP_E2E=1 npm run verify` 全绿且**判题矩阵 180 passed / 0 skipped**；宿主 Chrome E2E 6 passed / 42.4s（含真桥评分 22.8s）；详见 `memo.md` 里程碑 I

- [x] WI-28 前端 bundle 拆分：首屏 JS **gzip 92.6KB → 75.2KB（−19%）**，且首屏只剩 1 JS + 1 CSS。三个动作 —— ① `shared` 标 `"sideEffects": false`，把 web 端根本不用却因 barrel 顶层 `z.object()` 而被留下的 **zod 整个摇出首屏**；② `Bank`/`Progress` 改 `lazy()` 各切一片；③ 新增 `web/src/lib/prefetch.ts`，首屏画完后趁 `requestIdleCallback` 预取三片，避免"拆包换来点击时才下载 708KB"。新增 `scripts/check-bundle.mjs` 产物预算闸门（首屏 1 JS、无 modulepreload、gzip ≤84KB、入口不许出现 `ZodError`/`cm-editor`、且必须有一片**懒加载** chunk 真带 CodeMirror）接进 `verify.sh`。**顺带挖出并修掉一个真 bug**：`@fastify/static` 的 `wildcard:false` 用"启动时扫目录得到的索引"，重建后新哈希 chunk 全落进 SPA 回退 → 浏览器拿到 `text/html` 的 JS 直接白屏 —— 这就是 WI-37 那次偶发失败的机制｜验证：破坏性 A（把 `@codemirror/view` 静态引进入口）→ 三条断言全红、首屏涨到 154.4KB；破坏性 B（把 `wildcard:false` 改回）→ 新测试红在 `expected 'text/html' to contain 'javascript'`；真浏览器四页 0 console error、网络面板确认首屏 3 个请求 + 空闲预取；宿主 `verify:fast` 全绿（单元 85 / 题库 10 / 后端+前端 215）；容器 `SKIP_E2E=1 npm run verify` 全绿、判题矩阵 180 passed / 0 skipped；宿主 Chrome E2E 6 passed / 51.9s；详见 `memo.md` 里程碑 J

- [x] WI-33 `.faint` 语义边界成文：把"三档文字色各自管什么"写进 `tokens.css`（`--text` 14.3:1 正文与结论 / `--text-muted` 5.2:1 次级但需要读 / `--text-faint` 4.5:1 扫一眼就懂的短元信息），判据是**"漏读会不会让人做错事"而不是字数多少**；比 faint 更浅只允许用在纯图形（箭头、锁定徽章、行号槽）且同一含义必须有第二个非颜色通道。`base.css` 的 `.faint` 定义处指回这份说明；`openspec/specs/web-client/spec.md` 新增同名 Requirement（含"实义小字不许用 faint"场景），`openspec validate --all --strict` 8/8 通过。机械兜底加在 `web/test/tokens.test.ts`：文字色 token 的**集合必须恰好是三档**且每档 ≥4.5:1 —— 想加第四档更浅的色会直接被测出｜验证：`npx vitest run web/test/tokens.test.ts` 9 passed；破坏性（临时加 `--text-ghost: #94a3b8`）→ 红在"加一档更浅的文字色 = 给'实义小字变看不清'开门"，撤掉即绿
  顺带修正 `regression-guard` spec 里一条**从未实现**的断言（它声称 `verify.sh` 会检查 `tests/fixtures/submissions/<kind>`，实际那个目录是空的、也没有任何脚本读它）：改成描述真实存在的检测路径（自证矩阵 + `assert-ran`），缺口另记 N-10

- [x] WI-40（原 N-09）E2E 打独立实例，真人状态零污染：`compose.yml` 新增 `e2e` 服务（同镜像、宿主 `127.0.0.1:7798`、题库**只读**挂载），
  `ARENA_DATA_DIR` + `ARENA_DB_FILE` + `ARENA_HIDDEN_FILE` 全指到 `data/e2e/`；`tests/e2e/instance.{setup,teardown}.ts` 负责"起干净后端 → 等健康（新容器要初始化 MySQL，给 240s）→ 跑 → 收干净"
  （teardown 只 `stop/rm` 点名 e2e，**绝不 `compose down`** —— 那会连真人在用的 arena 一起停）；`ARENA_E2E_BASE` 可打到自己起的实例、`ARENA_E2E_KEEP=1` 留现场。
  `config.ts` 把 `ARENA_DATA_DIR` 升级成"所有可写产物"的总开关（db 与判题沙箱从它派生）。顺带修掉三个"绿着骗人"的问题：
  ① 最初给 e2e 选的 7799 撞了宿主 CLI 桥端口 → 两边 `llm-rubric` 一起 false，而 spec 的 `if (可用) 才断言` 让整套 E2E 2 秒过完还全绿（换 7798 + setup 打降级警告 + 降级分支也断言）；
  ② 镜像里的**旧 dist** 不派生 `dbFile`，"独立实例"静默写回真人 `data/arena.db`（compose 三条路径全显式给；另纠正探针：WAL 模式下 `sha1sum arena.db` 是假阴性，要探 `-wal`）；
  ③ `verify.sh` 按目录枚举测试，`server/test/log.test.ts` 从来没被任何阶段跑过（补枚举 + 新守卫 `verify-coverage.test.ts` 断言每个 `*.test.ts` 都被某阶段认领）｜验证：宿主 Chrome E2E 6 passed / 55.1s（真桥评分 30.1s），跑前/跑后 `data/arena.db-wal` 与 `content/hidden.json` sha1 **完全不变**、`data/e2e` 已清；
  反向对照：故意 `ARENA_E2E_BASE=http://127.0.0.1:7788` 时真人 WAL 确实变化、独立实例 DB 里查得到测试自己那条 `pass/15XP`；守卫破坏性（从 `verify.sh` 删掉 `server/test/*.test.ts`）→ 立刻点名两个孤儿；
  宿主 `verify:fast` 全绿（单元 94、后端+前端 216、产物预算通过）；`--rebuild` 后容器 `SKIP_E2E=1 npm run verify` 全绿、判题矩阵 **182 passed / 0 skipped**；详见 `memo.md` 里程碑 M

- [x] WI-41（原 N-02）错题本 + 间隔重复：新增 `server/src/game/review.ts` —— **SM-2 的二值退化**（完整 SM-2 要"回忆质量 0-5"的人为评分，本系统只有 pass/fail 与用时，硬套就是假装实现）：
  `REVIEW_LADDER = 1/3/7/14/30/60` 天，pass 升一档、fail 跌回第一档，且要连续两次 pass 才升档（一次做对可能只是运气）。
  排期存在 `settings` 的 `review:book` 单键（**不加表、`SCHEMA_VERSION` 不动**），第一次读时从历史 `attempts` 回填一次（`seededAt` 标记，之后不重算），`needs_human`（评分链故障）不算错题。
  `planForDay` 有到期题时**顶掉一个槽位而不是加菜** —— 每天仍是 2 主 + 1 副、`plan.main.count` 不变，套餐完成判定与 XP 上限一行都不用改；
  优先级：主栈类别代码题 → 副栈类别主观题 → 任意代码题 → 任意主观题。契约只加 `TodayResponse.reviewIds` 与 `ProgressResponse.review{tracked,dueToday,oldestDays}`，
  且都设成**必填**（类型检查立刻点出 3 处漏改的假实现/fixture；写成 `?` 就会变成运行时 undefined）；界面加今日页"复习"徽章 + 进度页错题本卡片；`shared/day.ts` 补 `addDays`。
  顺带把 `FakeStore` 拆成 `BareFakeStore`（真的没有 settings 方法）+ `FakeStore`（带），不再用"方法是 undefined"表达"能力缺失"｜验证：
  `review.test.ts` 21 passed（升降档 / 到期排序 / 坏 JSON 退回空本 / 回填幂等 / store 往返）；`server/test/game` + `server/test/api` 135 passed；`web/test` 新增徽章 3 条 + 新建 `progress.test.tsx` 2 条；
  宿主 `verify:fast` 全绿（单元 96 / 题库 10 / 后端+前端 258，产物预算仍过）；`--rebuild` 后容器 `SKIP_E2E=1 npm run verify` 全绿、判题矩阵 182 passed / 0 skipped；
  宿主 E2E 6 passed / 1.1m（真桥评分 36.2s）且跑前跑后真人 `arena.db-wal` 哈希不变；浏览器实测 0 console error；
  端到端活证据：一次性实例里把某题排成"今天到期" → `/api/challenge/today` 返回 `reviewIds:["alg-java-0001"]` 并顶掉 `bd-pyspark-0003`，`main.count` 仍是 2；详见 `memo.md` 里程碑 N
  已知边界：当天已缓存过套餐的人**今天**看不到复习（明日生效，属"当日套餐不中途变卦"的既有设计）；复习可跨类别顶主栈槽位，"主菜同一个栈"那天要打折，界面上靠徽章 + 每题自己的类别标签说清

- [x] WI-42 运维与门禁一轮（含 N-10 / N-06 / N-08，并对 N-07 下决议）：
  ① **pre-commit 真的装上了** —— 把 `.githooks/pre-commit` 复制进 `.git/hooks/`（不碰 `core.hooksPath`，git 配置留给用户），
  并修掉它用 `dirname $0/..` 推仓库根的问题（从 `.githooks` 跑时算对、从 `.git/hooks` 跑时算成 `.git` → 第一次真跑就 `scripts/verify.sh: No such file`，
  改成 `git rev-parse --show-toplevel`；拦截本身是对的）；此后每次提交都自动跑 `verify:fast`（本轮已连续两次实证）
  ② **容器重启后 MySQL 起不来**（N-10 之外最要命的一条）：`docker restart` 后 mysqld 常因"上次留下的 socket/pid 还在"直接退出，
  而 entrypoint 只等 60s 就 `exit 1`；改为"无人应答才清 stale socket/pid"+"等待 60s → 180s（崩溃恢复需要时间）"+"超时打印日志末尾 20 行"，
  实测连做两次 `docker restart` 都在 ~15s 回到 healthy ③ **runner-coverage 门禁**（N-10）：每个 judgeKind 必须有 `server/test/judge/<kind>.test.ts`、
  正解与错解两个方向都在、题库用到的 kind 必须在内；破坏性验证两种都能红 ④ **N-06**：`RunnerConfig.submissionPath` 取代"借 className 当文件名"
  （TDD 两条先红：zod strict 拒 submissionPath / `expected 'pass' not to be 'pass'` 证明 className 仍在路由；题库无人用故零迁移）
  ⑤ **N-08**：补 `.qoder/rules/dev_verify_workflow.md`（三档验证何时跑哪档、前端必须真浏览器、E2E 隔离与"验隔离要看 `-wal` + 反向对照"、
  `docker cp` 只活在当前实例、ps1 必须带 BOM）⑥ **N-07 决议：不采纳** —— 那条"tests/e2e 编号子目录 + `.summary.ts`"规范引用的
  `tests/utils/testTools`、vitest globalSetup 在本仓库根本不存在（属外来项目约定），现扁平布局已被 README/memo/门禁自洽引用，改结构零收益｜验证：
  宿主 `verify:fast` 全绿（单元 105、后端+前端 258）；`react-vitest.test.ts` 10 passed；`bash -n docker/entrypoint.sh` 通过；两次 `docker restart` 恢复 healthy

- [x] WI-43（原 N-03）技术栈正确率雷达图：`web/src/components/StackRadar.tsx` 手写 SVG（不引图表库 —— 7 根轴的多边形换 30KB+ 依赖不值当），
  轴顺序复用 `CATEGORY_IDS`（与题库/今日页同一顺序，避免同一张图两种口径），数据源就是已有的 `ProgressResponse.byCategory`；
  下面的表格仍是无障碍口径，图只负责"一眼看出哪个角凹进去"，`aria-label` 直接点名最弱的已练栈（实测：最弱的是 系统设计 0%，已练 1 题）｜验证：
  `web/test/stack-radar.test.tsx` 5 passed（顶点数=轴数、100% 落在外圈且 50% 落在一半、没练过的栈画在圆心而不是充数、全空时明说没数据、viewBox 必须比图形宽）；
  宿主 `verify:fast` 全绿（单元 105 / 后端+前端 263）；浏览器实测发现第一版左右两个中文标签被 viewBox 裁掉（"试题"/"设计"），
  加 `SIDE_PAD=58` 横向留白后 7 个标签完整；热替换 `web/dist` 不重启容器即可见效（WI-28 的 wildcard 修复在起作用）

- [x] WI-44 N-01 收尾：把"自适应题量"带来的**文档失真**与**界面口径**一起对齐（代码在 ebf021a）
  ① README 的"主栈 2 道"补上 1..3 微调；② `daily-challenge` spec 原来把 2 道写死在 Requirement 里（不改就是又一条"spec 比现实更让人放心"的假话），
  改成"默认 2、MUST 落在 1..3、不许变出没有的题、当天不改口、`plan.main.reason` 说明口径"，并补一条"连续做不好当天减负"的 Scenario；
  ③ `progress-gamification` 里"至少做成 2 道题"的续签解释补上"或 1 代码 + 1 道 ≥5 分主观"；
  ④ 活证据暴露的界面漏洞：主栈唯一槽位被复习题占掉时，hero 仍写"主栈 大数据处理 1 道代码题"而那道其实是 algorithms 的复习题 ——
  读起来像 bug。现在注明"（其中 N 道是复习）"｜验证：`npx openspec validate --all --strict` 8/8；`web/test/today.test.tsx` 16 passed（含新增 2 条）；
  宿主 `verify:fast` 全绿（单元 105 / 后端+前端 281）；`--rebuild` 后容器 `SKIP_E2E=1 npm run verify` 全绿、判题矩阵 **193 passed / 0 skipped**；
  一次性实例活证据：造 6 道 2026-09-18 全错 → `plan.main = {count:1, reason:'adaptive-low'}`、`reviewIds:["alg-java-0001"]`，
  浏览器实测 hero 渲染"主栈 大数据处理 1 道代码题（其中 1 道是复习）… 最近正确率偏低，今天主栈降到 1 题"，1 个复习徽章

- [x] WI-45 N-05 判题历史可回看：每次正式提交的逐用例结果与正文留档，题目页能复盘"我挂在哪个用例"
  存储：`attempts` 加 `detail` 列，`SCHEMA_VERSION` 1→2。迁移只看**列在不在**不看版本号（新库的 DDL 已带这列，按版本号 ALTER 会撞一次），
  老库 `ALTER TABLE ADD COLUMN` 后数据一条不丢；`detail` 读成 `null` 时 UI 明说"这条没有留档"，不拿空用例列表装成"全都过了"。
  契约：`shared/src/attempt.ts` 的 `AttemptDetail` + `detailFromJudge/detailFromGrade` + `serialize/parse`，
  单条 12KB 预算，超限按可牺牲程度逐级瘦身（日志 → 通过用例名 → 期望/实际 → 评分点 → 正文 → 最后才用例名）；
  裁剪按**字节**且按码点走（中文一个字 3 字节，切一半就是一屏问号）。主观题只存逐评分点与加减分，`raw`（provider 原始输出）不进档。
  读路径：`GET /api/attempts?questionId=&limit=`（默认 10、上限 30；detail 只由这条查询带出，汇总类查询不捞它）；
  UI：`web/src/components/AttemptHistory.tsx` 挂在题目页右栏，一行结论、展开看明细，提交后 `bump` 触发重取。
  ｜验证：`shared/test/attempt-detail.test.ts` 8 passed（瘦身顺序、中文不切半、坏 JSON/未知版本读成 null）；
  `server/test/api/db.test.ts` 17 passed（v1 手搭库升级、幂等连开三次、新库直接 v2、坏 detail、detail 往返、historyFor 新的在前）；
  `server/test/api/api.test.ts` 48 passed（+8：judge/grade 留档、自测不进历史、limit、老数据 detail:null、C7 不泄漏）；
  `web/test/attempt-history.test.tsx` 10 passed + `web/test/question.test.tsx` 16 passed；
  破坏性验证：把迁移的 ALTER 关掉 → db.test 立刻红（"table attempts has no column named detail"），确认不是空跑；
  宿主 `verify:fast` 全绿（单元 113 / 题库 10 / 后端+前端 306，首屏 gzip 75.4KB）；重建镜像后容器 `SKIP_E2E=1 npm run verify` 全绿、
  判题矩阵 **193 passed / 0 skipped**；宿主 Edge E2E **8 passed**（新增 2 条：两次提交刷新后历史仍在、自测不进历史）；
  真人库活证据：`data/arena.db` 升级后 `user_version=2`，老 attempt 读出 `detail:null`，缺 `questionId` 返 400；
  浏览器截图复核：收起行只给"哪天/通过 N 失败 M/挂在哪些用例"，展开后不再复述用例名（第一版把摘要和明细同时摊出来，一屏重复两遍）

- [x] WI-39 把"提交前自动跑 `verify:fast`"从死代码变成事实：`.githooks/pre-commit` 本身写得没问题，但仓库从没设置过 `core.hooksPath`
  （WI-31 收尾实测为空，`.git/hooks/` 里只有 CLI 自带的 post-checkout/post-commit），所以"每次提交都验一遍"这件事从未发生过。
  **做法**：不越权改 git 配置 —— 直接把同一个 hook 装进 `.git/hooks/pre-commit`（`npm run hooks:install` 保留给想用 `core.hooksPath` 的人）；
  顺带修掉 hook 里用 `dirname $0/..` 推仓库根的错误（它曾以 `scripts/verify.sh: No such file or directory` 挡住一次真实提交）；
  README 改成事实描述；两个启动脚本就绪后检查并提示（`start.sh` 的 `warn_missing_hooks`、`start.ps1` 的 `Warn-MissingHooks`）
  ｜验证：`ARENA_NO_BROWSER=1 ./start.sh` 实跑打印"提交前自动校验没生效…要接上：npm run hooks:install"；`bash -n start.sh` 通过；
  `start.ps1` 只做静态验证（`PSParser::Tokenize` 0 错误、UTF-8 BOM 仍在）**未实跑**；
  **活证据**：WI-44 / WI-45 两次真实提交都由它跑完整 `verify:fast` 才放行（15:17:37→15:19:29 约 1m52s，其中 ~70s 是 react-vitest 判题矩阵），
  耗时可接受，这条原本"需要用户点头"的观察项就此关掉

- [x] WI-46 N-04 Java 判题支持链表/树入参（`ListNode` / `TreeNode`）
  内置类放默认包（考生代码里直接写 `ListNode` 才自然），而 `Harness` 在 `arena` 包里 —— Java 不允许 import 默认包，
  所以**建对象与读字段全走反射**（`getConstructor(int.class)` + public 字段）。序列化沿用 LeetCode 口径：链表 `[1,2,3]`、
  树用层序数组 `[3,9,20,null,null,15,7]`，`null` 是空位；**尾部空位是写法差异不是结构差异**，两侧都先建成对象再归一化才比得平。
  注入按签名决定（`signature` 里出现才写 `ListNode.java`/`TreeNode.java`）—— 一律注入会把考生自己定义同名类的普通题撞成 `duplicate class`；
  真撞名时给一句可操作提示而不是 javac 原文。环与失控构造有身份集 + 20 万节点上限兜底（否则 canon 死循环，判题进程挂死）。
  顺带修掉一个会把判题器 bug 说成考生问题的坑：`ArenaTest.check` 原来只记 pass/fail/runtime，
  转换/归一化阶段抛异常时那条用例会**凭空消失**，上层只能报"进程可能被系统杀掉" —— 现在包一层，记成该用例失败并带原因。
  配套加题：`alg-java-0019`（请求链按阈值稳定三段划分，杀头插的反序解）、`alg-java-0020`（配置版本树最长同值路径，杀"单边当答案"的解），
  都带 `referenceSolution` + `naiveSolution`，所以判题矩阵会自动双向验它们。
  ｜验证：`server/test/judge/java-junit.test.ts` 容器内 **15 passed**（新增 6 条：链表往返、段内顺序错了要挂并点名用例、层序建树、
  树返回值的尾部 null 等价、没用到指针类型时不许注入、考生重复定义时报人话）；
  容器 `SKIP_E2E=1 npm run verify` 全绿，判题矩阵 **203 passed / 0 skipped**（含两道新题的参考解 pass / 朴素解 fail）；
  宿主 `verify:fast` 全绿（单元 113 / 题库 10 / 后端+前端 307）；宿主 Edge E2E 8 passed；`openspec validate --all --strict` 8/8；
  题库 97 → 99 题（只增不减闸门通过）

- [x] WI-47 修掉一条**量机器不量应用**的假红：`web/test/question.test.tsx` 用 `Date.now()` 断言"提交后 100ms 内进入运行态"，
  宿主并行跑 react 判题矩阵时漂到 115ms 直接红（应用行为没变）。改成结构性断言：判题流被 gate 卡住、一个 SSE 事件都没回来时
  `judge-running` 就已经在页面上 —— 这才是"不等判题回来"的证据，且组件真改成等结果才渲染时它会红。

- [x] WI-48 N-03 收尾：本周小结（周报层的出口定为"进度页加一节"，不做导出）
  理由：单机本机自用，导出 markdown/JSON 没有第二个消费方，反而多一套要维护的格式；雷达图看全历史、这张卡看这一周，
  间隔重复真正需要的是"最近哪里还在漏"。口径：周一为一周之始；题目按去重算（本周最好那次定通过），
  每日格子按**提交次数**算（同一题重做各算一次，与近 30 天日历同一口径）；`needs_human` 不进任何计数（评分链故障不是"你不会"）；
  类别只列本周真练过的，按正确率从低到高排（该先看的排最前），本周什么都没做时 `weakest=null` 并显示"这周还没开始"。
  实现：`server/src/game/weekly.ts`（纯函数 `weekWindow` + `summarizeWeek`）→ `/api/progress` 加 `week: WeekSummary`（shared 契约）
  → `web/src/components/WeekSummaryCard.tsx` 挂在进度页错题本之上。
  ｜验证：`server/test/game/weekly.test.ts` 11 passed（跨年那周不串周、周一/周日各自是边界、窗口外不算、重做去重、
  needs_human 排除、七天不缺项、并列取做得更多的、空周 null）；`web/test/week-card.test.tsx` 5 passed；`server/test/api/api.test.ts` 50 passed（+2）；
  宿主 `verify:fast` 全绿（单元 113 / 题库 10 / 后端+前端 325，首屏 gzip 75.4KB）；重建镜像后容器 `SKIP_E2E=1 npm run verify` 全绿、
  判题矩阵 203 passed / 0 skipped；Edge E2E 8 passed（daily-flow 加了 week 的接口与界面断言）；
  真人实例截图复核：11 题 / 通过 6 / 368 XP、7 格、7 类按弱到强、0 console error；第一版格子只有数字容易被误读，
  补一句"格子里是当天的提交次数"

- [x] WI-49 启动脚本完善（start.sh + start.ps1 同一套判据）
  ① `warn_missing_hooks` 之前只认 `core.hooksPath`，而 hook 实际是装在 `.git/hooks/pre-commit`（WI-39 的落地方式）——
  对已经接上闸门的仓库天天说假话，现在两条路都认；② `up` 之前把 `docker compose build` 的输出整个吞掉、失败还继续 `up -d`，
  等于"起成功但跑的是上一个镜像"（本轮真实踩过两次），现在构建非零就退出；ps1 侧更要显式查 `$LASTEXITCODE`
  （PowerShell 5.1 里原生命令失败不会被 `$ErrorActionPreference='Stop'` 拦住）；③ 就绪后打印**判题栈可用性**，
  `llm-rubric:false` 直接告警指向 `data/llm-bridge.log` —— 健康检查过了不等于主观题能评分，静默降级 manual 是本项目的老毛病；
  ④ `--verify` 补 `-T`（非 TTY 下 `docker compose exec` 会直接失败）；⑤ `--e2e` 原来在容器里 `playwright install chromium`
  （下载不到，且验的不是用户看的 Edge），现在默认给出宿主命令，`--e2e --in-container` 才走容器；⑥ 新增 `--bridge-logs`、`--status`（ps1 对齐），
  `--down` 顺带收掉 E2E 隔离实例。｜验证：`bash -n start.sh` 通过；`PSParser::Tokenize` 0 错误且 UTF-8 BOM 仍在（`head -c 3` = ef bb bf）；
  实跑 `./start.sh --bogus` 打印用法（行号范围随注释头改过，钉住不再多打一行代码）、`./start.sh --e2e` 给宿主命令、
  `report_health` 活跑打印全 true 的栈、并用假 body 反向验证降级分支真的会告警；`start.ps1 -E2E` / `-Status` 实跑（不再只是静态验证）

- [x] WI-50 增题脚本完善：手写题有了正式入口 `npm run bank:add`，且 scripts/ 第一次进闸门
  ① `scripts/bank/add-questions.mjs`：校验与落盘**只走服务端那个 append-only 的 `ingest()`**（脚本里不另写一套题目规则，
  否则两边必然漂移）；`--dry-run` 与真实入库走同一段代码（写进临时副本再丢弃），不是"预测逻辑"；
  单个文件解析坏只作废它自己；有拒绝就非零退出并打印 zod 的具体路径；默认入库后自动接 `bank:check`；
  含代码题时提醒"参考解必须在容器里判过才算数"。动机很实在：WI-46 手加两道链表/树题时唯一反馈回路是隔了一小时想起去容器里跑矩阵。
  ② 顺手修掉两个活跑才暴露的问题：共享的 `parseArgs` 会把裸 `--` 当成空名选项、顺手吃掉下一个位置参数
  （报"至少要给一个题目文件或目录"，明明给了）；把库里已有的题再喂一次会报看不懂的 `Unrecognized keys: ingestedAt`
  —— 那是写入口自己盖的字段，读入时抹掉后才会说出真话"库里已有同 id，跳过"。
  ③ `server/test/regression/scripts-syntax.test.ts`：`node --check` 扫全部 `scripts/**/*.mjs`、`bash -n` 扫全部 `.sh`、
  `start.ps1` 钉 BOM 字节 —— rule.md 里这三条写了很久但**没有任何东西执行**。
  ｜验证：`server/test/bank/add-script.test.ts` 12 passed（先红在"Cannot find module add-questions.mjs"；含
  重复 id 不覆盖原文件字节、题面撞车跳过、坏题不混进库、dry-run 一个字节不动、目录输入、自动分配 id、`--` 位置参数）；
  `scripts-syntax.test.ts` 5 passed，并做破坏性验证：塞进坏的 `.mjs` 与坏的 `.sh` 后两条断言都红且点名文件；
  活跑 `npm run bank:add -- content/questions/algorithms/alg-java-0019.json --dry-run` → "跳过：库里已有同 id"+ 原文件 sha1 未变；
  宿主 `verify:fast` 全绿（单元 130 / 题库 10 / 后端+前端 325）；`openspec validate --all --strict` 8/8

- [x] WI-51 L3 级自查一轮：查 bug + 清 dead code / dead file / dead docker
  **死代码**：先用真实 import 图证明"没有孤儿源文件"（每个看似孤儿的都是入口：index.ts / main.tsx / CLI 脚本），
  再用"全仓只出现在自己 export 行上"筛出 **23 个死符号**并删除（`getRunner`、`commandExists`、`hiddenFilePath`、
  `stripComments`、`OPTIONAL_RUNNER_FILES`、`copilotProvider`/`qodercliProvider` 单例（provider.ts 用的是工厂函数）、
  `emptyJudgeResult`、`isJudgeKind`、`AchievementId`、`BankFileList`、`visibleCases`、`useNavigate`、
  `JudgeStreamOptions`、两个测试 fixture helper、scripts 里 6 个）。删完 typecheck/lint/全测试绿，
  顺带暴露 4 处随之失效的 import 并清掉。
  **真 bug（本轮唯一的行为修复）**：判题沙箱与 Spark 暂存目录**只增不减**。runner 靠 finally 删目录，
  但进程被杀（容器重启 / OOM / Ctrl+C）时 finally 不跑，残留永远留着 —— 实测 `data/.spark-worker` 攒到 **25MB / 160 个
  blockmgr 目录，其中 147 个 2 小时没动过**。修法是把清扫做成通用的 `sweepStaleDirs(base, {maxAgeMs})`：
  ① 服务启动时清 `data/judge` 里一小时没动过的目录；② pyspark 在**拉起常驻 JVM 之前**清 `spark-local`
  （走到那一步说明没有活着的 JVM，所以不可能误删正在用的）。只碰直接子目录、只碰目录、必须超时限。
  **死文件**：仓库根 6 个 `xxx;C` 空壳目录（Windows 路径引号事故的产物）、`tests/fixtures/`（空壳，
  它对应的那条"从未实现"的 spec 断言早已改成描述真实检测路径）、**被 git 跟踪的 `server/src/judge/__pycache__/*.pyc`**
  （untrack + 删 + `.gitignore` 补 `__pycache__/`、`*.pyc`）、`data/` 下一次性产物（acceptance-run.mjs、judge-body.json、
  server.log、quarantine-probes、playwright-report、test-logs、test-tmp）→ `data/` 从 32MB 降到 4.2MB。
  **docker**：29 个悬空 `<none>` 镜像清掉（31 → 3）；**保留** build cache 与两个 tagged dev 镜像，理由见 memo。
  **文档失真**：`docs/ADD_QUESTIONS.md` 还在教人"把 JSON 直接放进 content/questions 再手动跑两道校验" ——
  那是 `bank:add` 出现之前的流程，已改成走 `--dry-run` → `bank:add` → 容器判参考解。
  ｜验证：`npx vitest run server/test/judge-workspace.test.ts` 3 passed（先红在 `sweepStaleWorkspaces is not a function`；
  **破坏性验证**：把时限判断改成恒不跳过 → "正在判的不碰"立刻红，恢复后绿）；
  宿主 `verify:fast` 全绿（单元 133 / 题库 10 / 后端+前端 325，首屏 gzip 75.4KB）；
  重建镜像后容器 `SKIP_E2E=1 npm run verify` 全绿、判题矩阵 **211 passed / 0 skipped**（pyspark/spark-scala 都真跑过）；
  Edge E2E 8 passed；活证据：容器重启跑完后 `data/.spark-worker` 25MB/160 → 1.1MB/6

- [x] WI-52 修掉"本周 XP 比累计 XP 还大"的口径打架（WI-48 自己造的）
  进度页顶部是"累计 XP"（每题只计历史最佳），本周卡用的是"每次提交累加" —— 实拍上同时出现"累计 94 / 本周 368"，
  两个数互相打脸。改成 `week.xp` 与累计同一条规则（每题本周最佳之和 + 本周那几天的成套奖励），
  于是"本周 > 累计"在数学上不可能再发生；每日格子的 xp 保留"当天提交次数"热度口径（与近 30 天日历一致），
  并在卡面上把两件事说清楚（"计入 XP"＋一句解释）。spec/README 同步。
  ｜验证：`server/test/game/weekly.test.ts` 13 passed（新增 2 条：重做三次只算 15 不是 32；成套奖励只算窗口内的天）；
  `web/test/week-card.test.tsx` 5 passed（断言卡面出现"计入"与"每题只算最好那次"）；宿主 `verify:fast` 全绿；
  容器 `SKIP_E2E=1 npm run verify` 全绿（矩阵 213/0）；Edge E2E 8 passed；真人实例实拍复核 94 / 94 一致

- [x] WI-53 P1：软删除账本"空"被当成"损坏"，导致**移除/恢复按钮整体坏掉**（启动冒烟时抓到的）
  `saveHidden` 写的是带缩进的多行 JSON，而 `loadHidden` 的守卫拿紧凑字面量 `{"version":1,"items":[]}` 做字符串比对 ——
  只要用户把最后一道移除的题恢复回来，账本变成"合法但空"，此后**每次读**都生成一个 `hidden.json.corrupt-<ts>` 备份，
  并且 `assertWritable` 让后续所有 hide/unhide 直接抛错。真人实例上实测 `POST /api/questions/<id>/hide → HTTP 500`，
  `content/` 下攒出 12 个垃圾备份文件。
  改成按**形状**判断：`items` 是数组且每条都认得出 → 合法（空账本也合法）；`items` 里有条目认不出 id → 才留证并拒绝改写；
  完全认不出形状（根是数组、缺 items）→ 维持原来的"留证 + 拒绝写"。空文件按"还没有账本"处理。
  顺带清掉 12 个 `.corrupt-*`，并恢复了 `alg-java-0001`（9-19 早期 E2E 跑在真人实例上留下的移除记录，不是用户点的）。
  ｜验证：`server/test/bank/bank.test.ts` 16 passed（新增 2 条先红后绿："恢复完最后一题后仍能继续移除"、"空账本反复读不生成备份"；
  破坏性验证靠红→绿本身，同时保留原"根是数组→留证并拒绝再写"用例仍绿，证明没把守卫放宽成橡皮图章）；
  真人实例活证据：修复前 hide/unhide 双 500，修复后连续 4 次 hide/unhide 全 200、`content/` 下 0 个 corrupt 文件；
  宿主 `verify:fast` 全绿（单元 135 / 后端+前端 327）；容器 `SKIP_E2E=1 npm run verify` 全绿（矩阵 213/0）；Edge E2E 8 passed

- [x] WI-54 架构总览重写 + 6 张 draw.io 图（纯文档，但把"数字从哪来"这条教训又坐实了一次）
  原 `docs/ARCHITECTURE.md`（68 行）只讲解耦边界，回答不了"前端是什么 / 判题怎么跑 / docker 怎么服务 / 脚本怎么用"
  —— 而这四条恰恰是新 session 成本最低的入口。重写成 14 节，事实全部回代码核对而非凭记忆，纠正三处：
  runner 是 **6 个**（`llm-rubric` 不是 runner，是评分链，这解释了 `/api/health` 为何要单独探它）；
  `web/src/api.ts` **没有重试逻辑**（只有错误归一，别把意图写成事实）；首屏体积必须用闸门实测值。
  图源是可编辑的 `.drawio`（`docs/architecture/diagrams/`）、PNG 是导出产物（`images/`），§14 写了导出命令 ——
  架构会变，画死的图比没有图更坏。导出用本机 draw.io 桌面版 CLI（`--export --format png --scale 2`），未引任何新依赖。
  ｜验证：宿主 `verify:fast` 两次全绿（单元 135 / 后端+前端 327 / 题库 99 题未少于基线），pre-commit 闸门实跑；
  6 张图**逐张导出后目视核对**，修掉 4 处渲染缺陷（文字被裁、箭头穿过无关模块、一处把 `answerable()` 画给 runner
  而非题库、一处浮动注释压在主线上）；
  ｜教训：第一版把首屏写成"242KB ≈ 77KB gzip"（拿 vite 打印的 minify 后大小估的），
  而 `check-bundle.mjs` 量的 gzip 真值是 **75.4KB**（预算 84KB）。差 1.6KB 事小，
  "文档里的数字不是任何一道闸门量出来的"事大 —— 这种估出来的数字下次构建就变成假话，故单独一个 commit 纠正（01a3259）。
  ｜未跑：容器 `verify` 与 Edge E2E —— 本改动零代码、零判题路径，容器矩阵与 E2E 不可能观察到差异。

- [x] WI-55 DeepSeek 第二批 6 题（105 → 111）+ 出题流水线**入库** + 两条判题器事实
  **先补账**：第一批（commit `2b71a0d`，DeepSeek 6 题）当时既没进本板也没进 `memo.md` ——
  正是 `dev_verify_workflow.md` 第四条要防的事。公司进度现在的口径（`source.company`）：
  Airbnb 18 / DeepSeek 12 / Apple 11 / 无公司标签 70。

  **本批 6 题**（三个判分点全部取材于"面经只讲了概念、没做成可判分要求"的地方）：
  `alg-java-0024` 前缀缓存可复用长度（块对齐 + **链式 key** + 尾块永不复用，11 用例）、
  `alg-java-0025` MoE top-k 容量溢出（**全部或全无**，被丢的 token 不占任何名额，12 用例）、
  `sql-mysql-0011` MySQL 无 `PERCENTILE_CONT` 时把排队/推理**两个度量各自的**最近秩 P99 算对（6 用例）、
  `sys-rubric-0002` "利用率 72% 压到 95% 等于白捡 600 张卡"这场争论、
  `ag-rubric-0002` Agent 反复调同一工具但参数一直在变（maxLoop 与 hash 去重都拦不住）、
  `hot-rubric-0002` GPU 节点在 decode 中途失联、200 个请求已经推出去一半 token。
  与第一批的结构差别：**代码题不再全压在 algorithms**（改 2 java-junit + 1 mysql），
  避免 algorithms 与 sql/system-design 的题量差继续拉大。

  **流水线入库**：`gen.py / precheck.py / probe_naive.py` 原来躺在 `data/drafts-ds/`，
  而 `data/` 整个被 gitignore —— 所谓"可复制的出题流水线"其实只活在这台机器上，换个 clone 就没了。
  现在搬到 `scripts/bank/drafts/deepseek/`（生成物仍写 `data/drafts-ds/out/`，`content/questions` 是唯一真相），
  搬迁后用新路径重跑，`out/*.json` **sha1 逐字节一致**才删掉旧副本（不留两份会漂移的真相）。
  新增 `probe_naive.py` 的理由是 WI-54 那条教训的延伸：答案里写"计数版这里给 4"这类**具体数字**，
  容器矩阵只证明朴素解**整体**不过，不证明那个 4 —— 现在它由脚本逐用例量出来（实测 1vs2、1vs4、3vs6、2vs3）。

  **撞出来的两条判题器事实**（已写进 `docs/JUDGING.md`）：
  ① **空结果集的用例必须写成裸数组 `[]`**：`mysql --batch` 在 0 行时**连表头都不输出**，
     runner 拿不到列名，带 `columns` 的期望值必判"列名不一致：期望 […]，实际 []" ——
     这是构造上判不了的。`sql-mysql-0011` 的参考解第一次就是这样被矩阵判红的（不是我算错 expected，是断言形态不合法）。
  ② **`setup` 在每个用例前都会重跑**（`mysql.ts` 里 `seed = [...setup, ...input]`）：
     所以 setup 必须幂等（`DROP TABLE IF EXISTS` 开头），而 `cases[].input` 只需表达"相对基线的差异"。

  **顺带修掉一条我自己制造的假红**：`bank:add` 提示的下一步是 `kb:index` + `curriculum.mjs`，
  而重跑排课会**整月重排**（题库一变配比就变），于是 `daily.test.ts` 里那条
  "2026-10-01 写的是 main:sql" 的硬编码断言在**正确操作**上报了红（宿主与容器同时红）。
  改成"从文件里读期望 + 断言天数 ≥25"，既保住"排课静默失效"这个原始目的，又不再钉死内容。

  ｜验证：
- `precheck.py` 全绿（4 份草稿 11/12/8/7 用例）；**破坏性**：故意把一条 expected 改 +1 →
  exit 1 并点名用例（"热专家溢出后…: expected=4 got=3"），证明它不是空跑；
  它还在写的时候就抓到我把 `int[][]` 的用例 input 多套了一层括号（`[[[], 4]]` → 参数错位）
- 容器定向矩阵：`ARENA_CATEGORY=algorithms,sql` → 修 `sql-mysql-0011` 前 **1 failed / 85 passed**
  （失败原因即上面 ①），修完 `ARENA_CATEGORY=sql` → **36 passed**；`alg-java-0024/0025`
  参考解与朴素解**双向**都按预期（朴素解被判不通过）
- `npm run bank:check -- --full` → 111 题通过（含覆盖度闸门：类别配比 / 每类 ≥40% 当年技术 / 经典算法题 ≤15%）
- 宿主 `npm run verify:fast` → 全绿（lint + 类型 + 单元/组件 327 passed / 2 skipped + 题库闸门 + 产物预算）
- `daily.test.ts` 改动的**破坏性验证**：把 `2026-10.json` 第 1 天 main 改成 `no-such-category` →
  红在 `expected 'sql' to be 'no-such-category'`（证明断言真的把 plan 绑在文件上，不是自己跟自己比），恢复即绿
- 容器全量 `SKIP_E2E=1 npm run verify` → ✅ **判题矩阵 225 passed / 0 skipped**、后端+前端 325 passed、
  题库闸门 10 passed、产物预算 gzip 75.4KB；宿主 Edge E2E → ✅ **8 passed / 1.4m**
  （其中主观题那条 41.3s 是**真桥评分**，前提是 WI-57 修好之后）
- 浏览器实测三道新题（`#/q/sql-mysql-0011`、`#/q/alg-java-0024`、`#/q/sys-rubric-0002`）→ ✅ 0 console error，
  DOM 断到题面关键词，且 `answer` 与 rubric `criteria` **没有出现在页面文本里**（rubric 标签可见属设计内暴露）

- [x] WI-57 启动脚本不再把"桥答了 200"当成"评分链可用"（WI-30 那类静默降级的第二个成因）
  **症状**：容器 `/api/health` 报 `llm-rubric:false`（主观题会掉成人工自检表），而 `./start.sh` 明明打印
  "CLI 桥已在运行"。两层根因，第二层才是真的那次：
  ① "已在运行"的判据是 **pid 文件存在 + `kill -0` 通过 + token 文件与本次一致**，
     从头到尾**没探过端口上的真应答者** —— Windows 的 Git Bash 里 `kill -0` 对一个错位的 pid 也能返回真，
     pid 文件就此变成一张空头支票（而脚本下面 20 行恰好已有正确的探法：`curl -H x-arena-token /health`）。
  ② 更隐蔽：那个桥进程**启动时继承的 PATH 残缺** → `resolveBin()` 里的 `where qodercli` 失败 →
     `/health` 照样 200、`runnable` 却是空数组 → 容器判定评分链不可用。
     **而宿主 shell 里 `where qodercli` / `where copilot` 两个都能找到** —— 所以"命令装没装"不是问题，
     问题在"那个活着的进程自己的环境"。旧逻辑把"认 token"当成了"能评分"。
  **修法**：`bridge_probe()` 把端口应答分成 `none / ours / blind / stale / foreign` 五态，
  只有 `ours`（认 token **且** `runnable` 非空）才直接返回；`stale`/`blind` 都换桥（症状相同、处置相同），
  换桥时先 `stop_bridge`（pid 文件）再 `stop_bridge_on_port`（按端口找真正占着 :7799 的那个）；
  `foreign` **绝不代杀**，只报错让用户自己腾端口；起桥后的就绪循环同样只认 `ours`。
  `start.ps1` 同步实现（`Get-BridgeState` / `Stop-BridgeOnPort`），两边判据一致 —— 这条仓库历史上不一致过一次。
  ｜验证（全部实跑）：
- 复现：`PATH=/c/nothing-here node scripts/llm-bridge.mjs` 起一个桥 → `/health` = `{"ok":true,"runnable":[]}`
  （与线上那次逐字一致，证明病因是进程环境而不是安装）
- `./start.sh` → 打印 `CLI 桥在 :7799，但一个可跑的 CLI 都找不到（多半是它的 PATH 残缺） → 重启桥`，
  随后 `runnable:["qodercli","copilot"]`、容器 `llm-rubric:true`
- `start.ps1` 走**同一条分支**、同一句文案（GBK 控制台解码后核对）→ 幂等复跑打印
  "已在运行（:7799 认本次 token，且找得到可跑的 CLI）"，不杀健康桥
- `bash -n start.sh` 通过；`start.ps1` `PSParser::Tokenize` **0 errors** 且 **UTF-8 BOM 仍在**；
  桥本体 `scripts/llm-bridge.mjs` 一行未改（无 token 请求仍然 401，没有为了探活放宽鉴权）

- [x] WI-58 题目详情页提供参考答案（答前可看）+ C7 改口径
  **来龙去脉**：这个需求此前**只存在于 `2b71a0d` 的 commit message 里一句话**（"这是为后续'查看标准答案'功能定的质量基线"），
  没进板、没进规格 —— 而 `rule.md` 的 C7 当时写的恰恰是反向的禁令，还有测试钉着。所以这不是"加个按钮"，
  是一次**红线改口径**：用户 2026-09-21 拍板"所有题都可以答前提前查看答案"。
  **保留的那半条**：rubric 的 `points`/`criteria` 仍然答完并评分后才展开（提前给出等于告诉评分模型该怎么被糊弄），
  已如实写进新的 C7 文本与规格。
  **实现的关键取舍**：**不放宽 `publicQuestion()`**（它有 7 个调用方，一放宽就是所有响应都可能带答案），
  而是新增 `questionReference(q)` 与 `QuestionDetailResponse = {question, reference}`，只在
  `GET /api/questions/:id` 一处使用 —— "答案只从一个口子出"从此是**类型与构造决定的**，不是靠人记得。
  前端 `ReferenceAnswer.tsx` 默认收起（答案中位 1484 字，摊开会挤掉判题结果与提交历史），
  复用现成的 `Markdown`（已 sanitize + 给 `<pre>` 注入"复制到编辑器"），参考解因此天然能一键抄进答题区；
  什么都没留档时整块不渲染，不摆一个点开是空的按钮。
  ｜验证：
- `shared/test/question-reference.test.ts` 新增 4 条（先红在 `questionReference is not a function`，
  中途还红过一次"因为我把测试 fixture 的 statement 写短了"——那不是功能红，已改成真·功能红）；
  shared 41 passed
- `server/test/api`：详情端点两条改成断 `reference.answer` / `reference.solution`，并新增一条
  **只许检 `question` 本体**（防有人把答案塞进 `publicQuestion`）；同时给假题库的代码题补上 `answer` ——
  否则 `expectNoAnswerLeak` 对代码题答案是**空跑**（marker 根本不在样本里）。67 passed
- 宿主 `npm run verify:fast` → ✅ 全绿（333 passed / 2 skipped）；`npx openspec validate --all --strict` → ✅ 8/8
- 真浏览器实测（`#/q/alg-java-0024`、`#/q/sys-rubric-0002`）→ ✅ 默认收起且正文不在 DOM 里；
  展开后要点 + 参考解代码块都在；点"复制到编辑器"把 1526 字参考解真送进了 CodeMirror；
  主观题的 `reference` 只有 `["answer"]`，`criteria`/`points` 在响应里查不到；0 console error
  （**顺带清掉了测试留下的草稿**：复制动作会写 `localStorage` 的 `arena:draft:alg-java-0024`，
  已删除并 reload 复验为 0，不让参考解躺在用户的答题框里）
- 容器全量 `SKIP_E2E=1 npm run verify` → ✅ 全绿，判题矩阵 **225 passed / 0 skipped**、产物预算首屏仍 **75.4KB gzip**
  （新组件落在已懒加载的 `Question-*.js` 里，首屏一个字节都没涨 —— 这是"答案面板"该有的落点）；
  宿主 Edge E2E → ✅ **9 passed / 1.2m**（新增 `tests/e2e/reference-answer.spec.ts` 2.3s）
- 那条 E2E 的**否证**：同一时刻 `"answer"` 在 `GET /api/questions/:id` 文本里出现 1 次、
  在 `/api/bank` 与 `/api/challenge/today` 里 0 次 —— 证明"不含答案"的断言是敏感的，不是一个永远匹配不上的错字

- [x] WI-59 Apple 第一批**代码题**（114 题）：这家公司原先 11 道全是主观题
  **为什么先补 Apple**：`source.company=Apple` 的 11 道题**全部是 `llm-rubric`，一道可机器判分的都没有** ——
  对一个以"结果导向判题"为红线（C6）的产品来说，一家公司只有主观题等于这家公司没法练手。
  同时 `sql`（17）与 `frontend`（12）是全库最薄的两类，所以这批刻意选 1 java-junit + 1 mysql。
  **题目**：`alg-java-0026` 原始明细不出境时用聚合 delta 流算精确全球并发峰值
  （跨区可加性 + `[start,end)` 同刻语义 + 负前缀必须抛错 + 必须用 long）；
  `sql-mysql-0012` 聚合数据出境门禁 —— k-匿名之外还要挡**互补攻击**
  （总计已公开 且 恰好只有 1 格被抑制 ⇒ **整组**撤下；总计未公开的 region 反而可以发）。
  取材自 `data/kb-txt/Apple面试准备手册.txt §16`（手册只说"要抑制小于 k 的分组"，没做成判分点）。
  新目录 `scripts/bank/drafts/apple/`（gen + precheck，与 deepseek 同一套纪律，直接入库）。
  **第三道补的是最薄的类别**：`fe-react-0013` 遥测看板降级渲染 ——
  `value || '未到'` 会把合法读数 0 变成"未到"，而用 `value == null` 推 `data-partial`
  会把"只到了 12% 但有值"的分区标成**完整**（后者才是那次 P1 的根因）；
  新鲜度判定必须用注入的 `now`，读 `Date.now()` 的实现会被"同一份 props 只换 now"这条用例打挂。
  ｜验证：
- 结构性闸门第一次把这道题拦在外面：它要求用例名里出现边界关键词，
  而我的"0 是合法读数"用的是 ASCII `0`、正则里是"零" ⇒ **`✗ fe-react-0013 没有边界用例`**。
  改法是给用例**改名字**（`零值边界：…`）而不是放宽正则 —— 那条用例本来就是边界用例，
  只是名字没让它可被发现；改名要同时动 `cases[].name` 与 vitest 的 `it()` 标题（两者必须逐字相等），
  已用脚本复验两处一致且与草稿一致
- precheck 10 用例全绿；**否证**：把答案里"偏低给 4 / 偏高给 9"两个断言用模型算出来（真解 7、
  各区取 max 确实 4、正增量求和确实 9），朴素解在 5 条用例上与真解不同 ⇒ 矩阵必挂 ✓
- `sql-mysql-0012` 的 expected **全部由 Python 从数据集算出**（不手抄）：6 条用例逐条核对，
  含"给 R2 补一个小格 ⇒ 10 反而能发"与"把 R6 总计公开 ⇒ 9 立刻不能发"两条方向相反的判据
- 容器矩阵 `ARENA_CATEGORY=algorithms,sql` → ✅ **90 passed**；`ARENA_CATEGORY=frontend` → ✅ **28 passed**；
  三道新题**双向**都过（参考解全过 + 朴素解被判不通过）
- `bank:check -- --full` → ✅ 114 题过覆盖度闸门；宿主 `verify:fast` → ✅ 全绿（333 passed / 2 skipped）
- 未跑：容器全量 `verify` 与 Edge E2E —— 本批改动只有题目 JSON（挂载进容器）与两个新脚本目录，
  不碰 server/web 代码；判题路径已由定向矩阵覆盖（algorithms + sql 两类正是新题所在）

- [x] WI-60 Apple 第二批 2 题（116 题）：carry-in 峰值与版本偏斜规范层
  `sql-mysql-0013` 每小时并发峰值 —— 数据集刻意造了**一个没有任何会话"开始"的桶**（00:30→02:15 的长会话
  在 02 点仍活跃），所以按 `GROUP BY DATE_FORMAT(started_at,…)` 数"每小时开始几个"会把它算成 0；
  另外 04 点桶是真空的但仍必须出行（少一格比错一格更难发现）。整点边界用 `[start,end)`：
  `ended_at` 恰等于桶起点不算进该桶，用例 3 专门造了一条 02:00 开始的会话与它撞车 ——
  闭区间实现会多算 1。参考解用递归 CTE 造桶 + `{桶起点} ∪ {本桶内 started_at}` 采样
  （峰值只可能在开始事件或桶起点取得）。
  `bd-pyspark-0013` 版本偏斜规范层 —— 单位按 `schema_version` 路由（v1 是 MB 要 `/1024`、v2 已是 GB），
  未知版本用白名单 `isin(1,2)` 显式丢弃而不是落 `else`；**先归一再去重**
  （双上报的两条原始名不同：v1 `screen_view` / v2 `screen_viewed`，按原始名去重等于没去重）。
  最有用的一条用例是"单位等价改写"：把 v1 的 512 MB 换成 v2 的 0.5 GB，**正确答案一字不变** ——
  它同时钉住"全局除 1024"和"全局不除"两种实现。
  ｜验证：容器 `ARENA_CATEGORY=sql` 40 passed、`big-data` 30 passed，两道新题双向都过；
  `bank:check --full` 116 题过覆盖度闸门；宿主 `verify:fast` 333 passed。
  过程中自己抓到一处**用例名与实际值不符**：写的是"峰值变 4"，实际算出来是 6（那个桶基线已有 3 条）——
  由派生脚本暴露，已改名。这正是 expected 必须"算出来"而不是"抄下来"的理由。

- [x] WI-61 pyspark runner 接受整数面值的 double 列（Node 序列化把 `512.0` 磨成 `512`）
  **症状**：`bd-pyspark-0013` 的参考解被判 `runtime`：
  `PySparkTypeError: [CANNOT_ACCEPT_OBJECT_IN_TYPE] DoubleType() can not accept object 512 in type int`。
  看着像题目写错，其实是两处机制叠出来的：题库经 `JSON.stringify` 落盘，**JS 不保留整数面值的 `.0`**；
  而 PySpark 的 `DoubleType` 不接受 Python `int`。草稿里明明是 `512.0`，入库后就成了 `512`。
  这是 runner 的潜伏缺陷，任何"整数面值的 double 列"的题都会撞上，与本题无关。
  **修法**：`spark_worker.py` 建框前按 schema 声明的类型校正行值（`_field_casters` + `_coerce_rows`）。
  只校正数值列；`decimal`/`array<…>`/`struct<…>` 原样交给 Spark（切分时按**顶层**逗号，
  括号与尖括号内的逗号不算）；转不动就原样送回，让 Spark 报它自己的错，不在这里吞掉。
  ｜验证（TDD）：
- 先加失败测试 `pyspark.test.ts > 整数面值的 double 列必须能建框` →
  容器内红在 `被判成 runtime：…CANNOT_ACCEPT_OBJECT_IN_TYPE…`（**红在正确的原因上**：缺功能，不是测试写错）
- 修完复跑 `server/test/judge/pyspark.test.ts` → ✅ **10 passed**
- 复跑 `ARENA_CATEGORY=big-data` 矩阵 → ✅ **30 passed**，`bd-pyspark-0013` 参考解与朴素解双向都过
- `python -m py_compile server/src/judge/spark_worker.py` 通过
- **未覆盖的同类风险** → **2026-09-23 已验掉，不是缺陷**：`spark-scala` 靠
  `spark.read.schema(StructType.fromDDL(ddl)).json(...)` 建框 —— 是"声明 schema 后让 Spark 自己解析 JSON"，
  不存在"把 Python int 塞进 DoubleType"这一步，所以 `512` 会正常升成 `512.0`。
  证据：`server/test/judge/spark-scala.test.ts` 新增用例「整数面值的 double 列」
  （`gmv: 512` / `gmv: 8` 配 `gmv double`），容器内 **5 passed**，参考解四条用例全过。
  顺手修掉一条隐性耦合：那条测试把 `result.passed` 写死成 3，加第四条用例时会红在计数上、
  看起来像判题器坏了 —— 现在改成从题目自己的 `cases.length` 取分母。

- [x] WI-62 判题矩阵里一次**未复现**的 react-vitest 失败：记下来，并把"失败时看不到原因"修掉
  容器全量 `SKIP_E2E=1 npm run verify` 的矩阵阶段挂过一次：
  `react-vitest.test.ts:171 expected 'runtime' to be undefined`（1 failed / 235 passed）。
  随后两次独立复跑都过：单跑该文件 **10 passed**、整套 `server/test/judge + regression` **236 passed**。
  **没有把它当噪声划掉，也没有假装它是我引入的**：我这批只改了 `spark_worker.py`（pyspark 专用）
  与题目 JSON，与 react 判题路径无交集；但"不复现"不等于"没问题"，它等于"我不知道"。
  真正能修的是**这次事故暴露的 diagnosability 缺口**：那条断言是裸的
  `expect(result.errorKind).toBeUndefined()`，判题器的 `status` 与 `logs` 全被丢掉 ——
  于是想查原因只能再跑一遍整套矩阵去赌它复现（我赌了两次，没复现）。
  现在断言把 `status` 与 `logs` 都带进失败消息里，下次再挂至少能直接看出是超时、jsdom 起不来还是资源竞争。
  ｜验证：改后 `react-vitest.test.ts` 单跑 10 passed；镜像重建后复跑通过。
  ｜仍待观察：如果它再挂一次（哪怕隔很多天），按"矩阵在高负载下偶发 runtime"立案，
  方向是 react runner 的超时/并发预算，而不是再归给运气。

- [x] WI-63 出题管线的两道新闸门：`throws` 改成**声明**、契约型用例断言到**消息**
  这批出了 14 道题，其中两类缺陷是"闸门是绿的但题是坏的"，都靠人眼抓到太贵：
  1. **静默降级**：草稿里的 `case()` 助手原先是"模型抛错就写 `expectThrow`，
     返回就写 `expected`"。于是 `airbnb` 的"非法：RELEASE 带了 arg"这条实际发的是 `LOCK`
     并且**正常返回** —— 用例名说 A、内容做 B，而矩阵只看"参考解与朴素解结果不同"，全绿。
     现在 `case()` 多一个必填语义：`throws=True` 是**声明**，模型行为与声明不一致就在生成期
     `AssertionError` 直接炸。加完的当天它就在 `apple` 的 schema 门禁上炸了 7 次
     （我漏标了 7 条 `非法：*` 用例）—— 这正是它该有的表现。
  2. **收敛成同一条**：`react-vitest` 的题只跑 `runner.files` 里的测试文件，
     `cases[].expected/expectThrow` 对它是**说明性**的。原先两条"该抛错"的用例只写 `.toThrow()`，
     而 `expectThrow: 'Error'` 不校验消息 —— 结果 `input` 多包一层数组时，
     "整个入参为 null"与"某个元素为 null"两条测的是同一条代码路径，其中一条永远判不出来。
     现在测试文件生成 `.toThrow(msg)`，并给契约型用例加 `throwMessage` 字段
     （`shared/src/question.ts`，注释写清消费方是 precheck 与测试生成，判题器仍读 `expectThrow`）。
  ｜验证：
  - 破坏性验证 ①：把 `fe-deepseek-sse-frames` 的 `input` 改回多包一层 → `precheck.py` **FAIL**
    （`期望消息 "chunks must be an array"，实际 "chunk must be a string"`）；
    改回正确后 **ok (14 用例)**。**先确认闸门会红，再相信它绿。**
  - 破坏性验证 ②：把 `airbnb/precheck.py` 里"一把锁必须完整覆盖"弱化成"有重叠即可" →
    与 `gen.py` 的实现立刻在「相邻两把锁不能合并提交」上分叉（`expected=[1,1,0] got=[1,1,1]`）。
  - `scripts/bank/drafts/airbnb/precheck.py`（新增）用**逐日集合**独立重写区间状态机，
    与 `gen.py` 的区间算术互为对照；16 条用例两边一致。
  ｜教训一条：`docs/JUDGING.md` 里"空结果必须写裸 `[]`"这条已经写了，
  还是在新题上复现了一次（`sql-mysql-0014`）。**写在文档里的"记得做"不是闸门** ——
  真正的修法是把 `case()` 助手的空结果分支直接写成裸 `[]`（本批已改），
  让"照抄助手"天然正确，而不是靠出题的人记得。

- [x] WI-64 网页 IDE：把"执行代码 + 看输出"解耦成第三个子系统（2026-09-22 提出，2026-09-23 完成）
  用户要点四条全部落地：选语言 + 默认 sample code、执行并看 stdout/stderr/退出码/耗时/阶段、
  页面**独立于做题系统**、**复用同一个 docker container**（不引新容器、不引新依赖）。
  ｜当初列的"要先定再写的四件事"，逐条的决议：
  1. **语言集合 ≠ judgeKind**。IDE 只收"读 stdin 写 stdout"的六门纯执行语言
     （python / java / javascript / typescript / c / cpp）；`mysql`/`redis`/`pyspark`/`react-vitest`
     的语义是"一段脚本 + 状态校验"，属于判题而不是属于编辑器，硬塞进来只会让 `/api/ide/run`
     的返回形状裂开。可用性一律现探（`ideAvailability()` 跑 `<cmd> --version`），不写死"镜像里装了 JDK"。
  2. **stdin 早就有了**：探地基发现 `runProcess` 本来就接 `input`（还带超时连进程组一起杀），
     `createWorkspace` 已有独立目录 + 路径越界检查 + 前缀校验删除。所以真实工作量在边界与限额，不在执行。
     UI 给一个独立的标准输入框，请求形状 `{ language, code, stdin }`。
  3. **威胁模型写在文件头**：这是本机单用户工具，限额的目的是"跑飞了别把服务挂住"，
     不是多租户沙箱 —— 超时 10s（请求最多自提到 30s）、代码与 stdin 各 20K 字符、
     stdout 64K 截断并显式报 `truncated`、并发 3 且**超过就排队而不是回 429**
     （单机工具被拒，人只会以为是自己的代码挂了）。真要给不可信用户用，该补的是容器级资源限制。
  4. **解耦到接口 + 目录 + 闸门三层**：新前缀 `/api/ide/{languages,run}`、新路由 `/#/ide`、
     新目录 `server/src/ide/`；只复用 `judge/process.ts` 与 `judge/workspace.ts` 两个通用底座。
     `server/test/ide/boundary.test.ts` 是红线 C4 往第三个子系统的延伸：`ide/**` 不许 import
     判题 runner/题库/游戏，不许出现 `referenceSolution`/`rubric`/`visibleQuestions` 等符号，
     前端 `Ide.tsx` 不许出现题目接口，且 `judge/{process,workspace}.ts` 不许反向依赖 IDE。
  ｜两条"闸门全绿但界面是坏的"缺陷（都在 javascript / typescript 上，都是**注册表里那份 sample** 炸）：
  - **JS**：沙箱目录在仓库内，仓库根 `package.json` 写着 `"type": "module"` ⇒ `main.js` 被 Node 当成
    ES Module，示例里的 `require("fs")` 直接 ReferenceError。修法不是改文件名，是给语言加
    `scaffold`（就近落一个 `{"type":"commonjs"}` 的 package.json）—— tsc 的 commonjs 产物同样需要它。
  - **TS**：`tsc` 从沙箱逐级向上找到仓库的 `node_modules/@types/*`，把 `@types/react-dom` 也拖进编译，
    而我们只给 `--lib es2020` ⇒ 满屏 `TS2304 Cannot find name 'CSSStyleDeclaration'`（用户代码没错，
    编译却失败）。改成 `--types node --skipLibCheck`：只装 node 的类型，别人的 .d.ts 报错不算在用户头上
    （顺带编译从 2010ms 掉到 31ms）。
  ｜新加的两条闸门（都是"以前的闸门为什么没抓住"的直接答案）：
  - `注册表里的 sample 必须原样跑得通`：逐语言跑 `lang.sample`。旧测试跑的是另写的一段代码
    （不带 `require`），所以 sample 坏了三天没人看见 —— **测试没测产品实际给出去的那份内容**。
  - `shell 脚本行尾（不许有 CR）`：`scripts/verify.sh` 在工作树里是 CRLF，宿主 `bash -n` 容忍它、
    git 因 `.gitattributes eol=lf` 显示"无改动"，但 `docker compose build` 拷的是字节 ⇒
    容器里 `npm run verify` 第一行就挂，整轮容器验证一行都没跑。顺手把工作树里 20 个 CRLF 文件统一成 LF。
  ｜另外修掉一处自毁式入口：`./start.sh --verify`（与 `-Verify`）原先不带 `SKIP_E2E`，
  而 E2E 的 global setup 要在容器里再叫一次 `docker compose` —— 容器里没有 docker，
  于是矩阵明明已经跑完，`--verify` 仍必然在最后失败。现在两条实现都 `SKIP_E2E=1` 并说明 E2E 去宿主跑。
  ｜界面按规则在真浏览器（Edge）里看过：语言下拉、提示、编辑器高亮、stdin 框、
  `运行成功 / 退出码 / 耗时 / 阶段`、stdout 块都在；控制台 0 报错。
  stdin 框原先继承 `textarea.answer` 的 `min-height:420px`（那是给主观题长文答案用的），
  截图里占掉大半屏，已就地压到 72px。
  ｜验证（明细与破坏性验证见 `memo.md` 里程碑 AF）：
  容器 `npm run verify` → 判题矩阵 **293 passed / 0 skipped**、IDE 阶段 **38 passed / 0 skipped**；
  宿主 `npm run verify:fast` → 全部通过；宿主 `npm run e2e` → **12 passed**（含新增 `tests/e2e/ide.spec.ts` 三条）；
  六门语言 `POST /api/ide/run` 全 `status=ok`；Edge 里截图看过，控制台 0 报错。

- [x] WI-65 答案里的数字改成"从答案里抠出来再比"，并把探针接进题库闸门
  补 WI-56 遗留的那半条：`probe_naive.py` 只有 deepseek 一家有，
  `sql-apple-dqc-rules`（入库名 `sql-mysql-0019`）与"迟到窗口"（`bd-pyspark-0016`）
  答案里写死的数字一直没人复算过。
  ｜新增 `scripts/bank/drafts/apple/probe_naive.py`（30 项断言），并且**判据方向是对的吗**这件事
  被破坏性验证打回来一次：第一版把 `1 / 1 / 2` 写死在探针里，于是"故意把答案改成 1/2/2"它照样绿 ——
  那只证明"数据给 1/1/2"，不证明"答案写的与数据一致"。现在数字一律用正则从 `answer` / 用例名里抠，
  抠不到就报"这句话被改写了，探针得跟着改"（探针与答案脱钩同样算失败）。
  ｜量到并钉住的数字：基线有效行 6、duplicate 三口径 `1 / 1 / 2`、比率 16.67%、
  分子翻倍 ⇒"10% 阈值实际变成 5%"、把 NULL 设备算成孤儿会让 violations 1→2 / 比率 16.67%→33.33%、
  迟到窗口那条手算的四个时刻（10:20:00 / 上游标 10:00 / 水位线 10:35 / 重算 end 10:30）
  与"按上游错窗口 10:35 > 10:25 ⇒ 丢"的相反结论。
  ｜**抓到一处真缺陷**：DQC 答案点名了不存在的用例「让一条空值 device 变成孤儿」。
  已改成指向基线里那条真实数据（order 5 的 `device_id` 是 NULL）并把它会造成的偏移写清楚。
  ｜接进闸门：`server/test/bank/content.test.ts` 现在遍历 `scripts/bank/drafts/*/probe_naive.py`
  并要求退出 0（`PYTHONIOENCODING=utf-8` —— 不设时 Windows 按 cp936 输出，探针里的 `⇒`/`✗`
  会把 print 直接炸成"空输出"）。这条在 `verify:fast` 里，所以"改了答案没人复算"当天就红。
  ｜验证：破坏性改坏两处答案数字 → 探针退出 1 并点名这两处；还原后 30 项全过；
  `npx vitest run server/test/bank/content` 9 passed / 3 skipped；`npm run verify:fast` 全通过。

- [x] WI-66 把"人肉数的进度"换成闸门：公司维度报告（N-12）+ spark-scala 整数面值 double 验平（WI-61 尾账）
  ｜**公司维度**（`server/test/bank/content.test.ts` 新增一段）：报出每家 `总数 / 可机器判数 / 最弱类别`
  与"无 company 标签"的量，红只留给两条 —— 少于地板（进度倒退）与地板高于实际（把闸门调成常亮）。
  刻意不做成 `>=50` 那种目标门禁：题没写完时天天红，红久了就没人看，等于没有。
  地板里 `code` 单独一条，因为 WI-56 的教训是"靠主观题凑满 30 等于没达标"，只看总数会把退步报成绿灯。
  ｜**第一次跑就抓到两处**：
  1. 我自己的报告用了 `q.runner.judgeKind` —— 那个字段不在 runner 里，于是三家都报"可机器判 0"。
     改成权威判据 `judgeKind !== 'llm-rubric'`（与 `game/daily.ts:isJudgeable` 同一条）。
  2. **WI-56 里记的"代码 10 / 15 / 16"是错的，实际 9 / 14 / 16**。三种独立数法一致
     （非 rubric / 有 `referenceSolution` / 有 `cases`），已把交接文案改成实测值并写明原因。
     这正是 N-12 存在的理由：靠人数出来的进度会错，而且错了没人知道。
  ｜**spark-scala 尾账**：WI-61 记账说"Scala 侧可能同样拒绝整数面值的 double"。
  验完是**不会**：Scala harness 走 `spark.read.schema(StructType.fromDDL(ddl)).json(...)`，
  是"声明 schema 后让 Spark 自己解析 JSON"，不存在 pyspark 那步"把 Python int 塞进 DoubleType"。
  给 `server/test/judge/spark-scala.test.ts` 加了一条用例「整数面值的 double 列」把结论钉住
  （容器内 5 passed）。顺手修掉一条隐性耦合：那条测试把 `result.passed` 写死成 3，
  加用例时会红在计数上、看起来像判题器坏了 —— 现在从 `question.cases.length` 取分母。
  ｜验证：`ARENA_FULL_GATE=1 npx vitest run server/test/bank/content` → 15 passed；
  破坏性验证：把 Airbnb 地板抬到 总31/代码12 → 两条断言分别红在
  `总数只剩 30（地板 31）; 可机器判只剩 9（地板 12）` 与 `地板 > 实际`，还原后 15 passed；
  容器内 `npx vitest run server/test/judge/spark-scala.test.ts` → **5 passed**（含新用例）。
  ｜同批追加：`server/test/bank/answer-arithmetic.test.ts` —— 把**全库答案/题面/用例备注里写出来的等式**
  逐条重算（`100.00 + 120.50 + 99.99 + 250.00 = 570.49` 这种手算步骤）。
  三条"宁可少查、不许冤枉"的取舍：整条链一起算（只取末两项会把 `1+2+3=6` 误判成 `2+3=6`）、
  加减混乘除的链跳过（没有优先级信息）、除法只认写成小数的结果
  （`11/12=2` 是"这两条 span ⇒ 深度 2"的散文记号），比率允许"小数 or ×100"两种写法。
  现状：全库扫到 36 条，判不了放过 5 条，其余 31 条全对。
  破坏性验证：把四晚之和改成 `= 570.48` → 红并点名整条等式。

- [x] WI-67 Airbnb 探针补上，并把"答案点名的用例是否存在"上收成全库闸门
  ｜新增 `scripts/bank/drafts/airbnb/probe_naive.py`（13 项），只测 `sql-mysql-0014` 报价拆解：
  六条用例的 expected 全量独立复算（逐晚和、缺价不报价、退房日不算进来、费率归 0），
  以及答案写死的四个数 —— 逐晚和 570.49、`BETWEEN` 误法 1570.48、退房日那晚 999.99、
  `MIN(price) × 晚数` 399.96 与差 170.53。数字一律从答案里正则抠出来再比。
  覆盖范围写在文件头里，**没测的题不假装测过**。
  ｜**上收一条更好的**：`content.test.ts` 新增"答案里点名的『用例「X」』必须真存在"，
  全库 58 处引用一次查完。写它之前先扫了一遍：**6 处对不上号**，全是"用例后来改名了、文案没跟上"：
  `alg-java-0030` 两处、`alg-java-0031` 两处、`sql-mysql-0016` 两处。已逐条改指真实用例名。
  判据用"两个方向的包含"，允许答案把长用例名缩写。
  ｜顺带把 apple 探针里那份「」存在性检查删掉 —— 同一件事两处判据迟早漂移，闸门已经覆盖全库。
  ｜踩到两条自己的坑（都记进探针注释）：expected 与重算**按字符串比**会把"4 vs 4.00"报成不一致
  （改成两边都转 Decimal 比数值）；答案里 `本题差 \`570.49 − …\`` 带反引号，正则要容得下。
  ｜验证：airbnb 探针 13 项全过；破坏性验证把答案里的 1570.48 改成 1571.48 →
  红并点名 `文案写 1571.48，实际量到 1570.48`，还原后全过；
  apple 探针 29 项全过；`ARENA_FULL_GATE=1 npx vitest run server/test/bank/content` → 16 passed。

- [x] WI-68 IDE 并发队列补测：断言不许引用被检的那个常量
  WI-64 的并发闸只测过单发运行 —— 排队路径从没被走过，等于没测。补两条：
  6 条同时提交必须全部成功（不许被拒）、实测同时在跑的个数必须等于设计上限、
  跑完不残留 `ide-*` 沙箱；另一条是"跑飞被超时杀掉之后队列还能继续服务"。
  runner 加了 `takeIdePeakConcurrency()`（取出并清零实测最大并发）—— 这个数只能由被测方报。
  ｜**同一件事的判据连错三版，全靠破坏性验证抓**（细节与教训在 `memo.md` 里程碑 AJ）：
  ① 判总墙钟 ≥1200ms → 抬上限到 99 不红（CPU 争抢自己就慢）；
  ② 判"提交到进程启动的差值" → 还是不红（`mkdtemp` + 写文件的 IO 争抢混在里面）；
  ③ `expect(peak).toBeLessThanOrEqual(IDE_LIMITS.maxConcurrentRuns)` → 又不红，
  因为**判据引用了被检的常量**，改配置与改期望同步发生。
  最终拆成两条互相独立的：`maxConcurrentRuns === 3`（设计值，要改就连测试一起改）
  与 `peak === 3`（demand 6 > 名额 3，这个数只能由队列产生）。
  ｜验证：破坏①抬上限 → 红在 `expected 99 to be 3`；破坏②把 `acquireSlot` 短路 →
  红在 `实测同时跑了 6 个`；还原后宿主 `server/test/ide` 19 passed / 14 skipped、
  容器（HEAD 镜像）**33 passed / 0 skipped**；`npm run verify:fast` 全部通过。

- [x] WI-70 `./start.sh --ide`：网页 IDE 的快捷入口（同一个容器，只换落地页）
  用户问"IDE 有独立启动脚本吗"。答案是**没有独立进程**——它按需求就是复用同一个容器、同一个服务，
  所以"独立启动"能给的只有入口：`--ide` 走与默认启动完全相同的一条路
  （起宿主桥 → `compose build` → `up -d` → 健康检查 → 报栈可用性），只是最后打开 `#/ide`。
  刻意不另起 compose 服务/端口：那会把"同一个 docker container"这条需求变成两个进程，
  而且 IDE 的解耦边界本来是靠 `boundary.test.ts` 守的，不是靠端口。
  ｜顺手修掉一处会腐烂的写法：用法打印原先是 `sed -n '2,13p'` 写死行号 ——
  加一行用法说明就会把最后一行吃掉，而没人会想起来改这里。改成按"注释块到哪结束"取。
  ｜**新闸门**：`start.sh` 与 `start.ps1` 是同一套判据的两个实现，这条规则一直只是文档里的
  "记得想一下"（历史上真漂移过一次）。现在比对两侧的**入口集合**（`--bridge-logs` ↔ `$BridgeLogs`
  归一到同一个键），少哪一侧都红。破坏性验证：把 ps1 的 `-Ide` 拿掉 →
  红在 `onlySh: ['ide']`；还原 → 8 passed。
  正则第一版漏了数字（`--e2e` 被截成 `e`，报成 `onlySh:['e'] / onlyPs:['e2e']`）—— 这也是先跑一遍才知道的。
  ｜验证：`bash -n start.sh` 通过；`start.ps1` BOM 保住、CR=0、`PSParser::Tokenize` 0 错误；
  `sh ./start.sh --nonsense` 打印的用法含全部 12 个入口；`scripts-syntax` 8 passed。
  ｜真跑过了：`ARENA_NO_BROWSER=1 ./start.sh --ide` → EXIT=0，build → 重建容器 → 健康检查 →
  11 个栈全 true → 打印 `网页 IDE：http://localhost:7788/#/ide`。
  顺带修掉一处会说假话的文案：`wait_healthy` 原本打印"已就绪 → **打开** ${APP_URL}"，
  但它什么都不打开（开浏览器的是后面的 `open_browser`，而 `--ide` 开的是另一个地址）—— 去掉"打开"两字。
- [x] WI-69 再扩三家公司：PDD / 字节跳动 / 阿里巴巴（2026-09-23 用户点名，"同样的难度/领域/数量"）
  **同时记两条用户拍板**：① 错题本**维持不毕业**（pass 两次升档、60 天顶档后永远在册、`tracked` 只增不减）
  —— 这是决议不是缺陷，别再"顺手修"；② schema 1→2 迁移前的备份 2026-09-24 用户点头清理，已移到 `data/archive/arena.db.pre-v2.bak`（**没直接删**：36KB 的迁移回滚点留着不挡路，而删错了不可恢复；要真删随时 `rm -rf data/archive/`）。同时清掉了上个 session 遗留在 `data/` 的四份补丁脚本（`_batch5/_clean4/_fix5/_fixr1.py`）—— 正是 alibaba `gen.py` 文件头记的那类"先截断再写盘"的工具，留在工作区里只会等着被误跑。
  ｜**前置已完成**：每家 2 篇可引用的公司向素材（共 6 篇、84 条考点），落在
  `content/knowledge/hot-interviews/{pdd,bytedance,alibaba}-*.md`。
  每条考点带 `【源】`（真抓到过来源原文）或 `【推】`（由来源外推）分级，文末"来源清单"给
  URL＋标题＋访问日期＋它支撑了哪几条考点。素材里的"放弃清单"同样重要：
  PDD 放弃了全部量级数字与推荐/数据栈选型（零来源）、Temu 全托管机制；
  字节放弃了 Feed 写扩散实现与 IM 协议（文档停维护）；
  阿里放弃了双 11 真实量级与内部系统名（TP/TDDL/库存中心）。
  ｜**为什么先做素材**：这是 WI-56 记了很久的卡点 —— 没有出处就出题，等于把"凭猜"写进题库，
  和库里那 70 道无公司标签的早期题没区别。
  ｜**串行执行**：`bank:add` 按类别分配顺序 id（`sql-mysql-00NN` 等），三家并行会撞号。
  ｜目标配比（对齐已达标的三家）：每家 30 题、覆盖 7 类、**可机器判 ≥15**（现状 Airbnb 9 / Apple 14 / DeepSeek 16）、
  principal 4–6 题；代码题 ≥3 用例含边界、有 `referenceSolution` 并尽量带 `naiveSolution`。
  ｜三家都完成后要做的收尾：把 `content.test.ts` 的 `COMPANY_FLOORS` 抬到实测值
  （闸门会报"地板还停在…该抬"，照它报的数改，别凭记忆）。
  ｜**进度 ①PDD 已完成**：**30 题入库，可机器判 18**（java 6 / mysql 5 / redis 2 / pyspark 3 / react 2），
  7 类全覆盖，principal 5 题。`COMPANY_FLOORS` 已加 `PDD: {total:30, code:18}`。
  草稿与三道闸门在 `scripts/bank/drafts/pdd/`（`gen.py` / `precheck.py` 16 通过 14 明确 SKIP 0 失败 /
  `probe_naive.py` 135 项全对）。题库 160 → **190**。
  ｜**委托 agent 出题必须自己复验**：它是被 150 回合上限打断的，遗留两处只有人眼能抓的缺陷——
  1. `sql-redis-0009` 的参考解写的是 `ZADD key 6 c-004 NX`，而 Redis 的语法是
     `ZADD key NX 6 c-004`（NX 必须在 score 之前）→ 真容器里 `ERR syntax error`，矩阵红 1 条。
     在容器 redis 上实测过：错误写法 `-ERR syntax error`，正确写法 `:1` 且重放返回 `:0`（正是本题要的 no-op）。
     **题与 `gen.py` 两处一起改**，只改入库文件的话下次重生成草稿就把缺陷又带回来。
  2. 它的 `probe_naive.py` 里有两条**自己写错的断言**：一条拿"边界用例自己的 distorted(=0)"
     去比"写成 >= 会翻成 1"（该比的是用 >= 算出来的值），一条正则与用例名对不上号。
     修法是把"探针写错"与"题写错"分清：前者改探针，后者改题。
  ｜PDD 探针也做了破坏性验证：把答案里的阈值 1000 改成 1200 → 两条断言同时红（含我重写的那条），
  还原后 135 项全绿。
  ｜**进度 ②ByteDance 已完成**：**30 题入库（题库 190 → 220），可机器判 18**
  （java 6 / mysql 5 / redis 2 / pyspark 3 / react 2），7 类全覆盖，principal 2 题。
  容器全量矩阵 **274 passed / 0 failed**（137 道代码题 × 双向，574s）；
  主观题的 rubric 抽查过 3 道：判据是机制级的（不是"体现出对 XX 的理解"），
  `knowledgeRef` 里显式标了哪部分是【推】——没有把推断伪装成官方说法。
  ｜**委托批次的大小要按回合预算切**：PDD 与字节各撞了一次 150 回合上限。
  字节的 30 题是拆成"代码题 18（上一批）+ 主观题 12（这一批）"两单做完的，
  第二单明确禁止碰代码题、禁止跑容器矩阵（避免与复核互相踩）。阿里按这个尺寸直接拆两单。
  ｜**顺带修一处题库在说假话的地方**：`source.location` 枚举原本只有 `shanghai|us|remote|other`，
  北京/杭州无处可写，agent 只能退回 `other`（它很诚实地把这件事报了出来）。
  现在枚举加了 `beijing|hangzhou`，字节的 30 题回填成 `beijing`，`gen.py` 一起改。
  ｜顺序坑：**先改 `shared/` 并 `docker compose build`，再改题目文件** ——
  `shared/` 是烤进镜像的，反了的话容器里 `loadBank` 会因为枚举不认识 `beijing` 而整片解析失败。
  ｜**进度 ③Alibaba：12 道代码题已入库并复验收口（题库 220 → 232），主观题与第二批代码题进行中**。
  复验抓出的东西记在 `memo.md` 里程碑 AL，三条最要紧：
  ① **矩阵跑错容器＝静默跳掉半壁**（`tools` 没有 mysqld/redis-server，文档里那条命令已改）；
  ② 三处"用例名/文案与 `expected` 互相矛盾"（`no-pk-scan` 不可达、"基线八行"其实五行、
  "只剩两类"其实三类九行）—— 判题矩阵看不见文案，这类缺陷全绿；
  ③ 生成器补了 `--check`（草稿↔库逐字段比对）与 `--sync`（纠正已入库题的正规出口），
  并新增 `alibaba/probe_naive.py`（52 项断言，含一台按参考解顺序执行的迷你 Redis）。
  目标还差：代码题 6 道（12 → 18）+ 主观题 12 道（→ 30 题）。
  地板 `COMPANY_FLOORS.Alibaba` 现在停在 `{total:12, code:12}`（闸门实测值），收口时统一抬。
  ｜**③Alibaba 已完成（AM：30 题 / 可机器判 18；AN 补 frontend 2 道 → 32 题 / 20 道）**（java-junit 7 / mysql 6 / redis 2 / pyspark 2 / spark-scala 1 / 主观 12），题库 232 → **250**。三家全部按"每家 30 题、可机器判 ≥15"收口。
  ｜**一度有意的偏差，后来按规矩补上了**：30 题收口时阿里 **frontend 0 道** —— 两份公司向素材都明写阿里前端栈
  无可核查机制文档，为凑 7 类开 react-vitest 等于把"凭猜"写进题库。**解法不是降低标准，是先补出处**：
  新写 `content/knowledge/hot-interviews/alibaba-frontend-and-open-source.md`（29 条来源逐条给 URL＋tag＋访问日期，
  错误文案那几条由出题人自己用 GitHub MCP 抓 v2.10.16 原文并记到行号 L122/L123），
  再在其上落 2 道 `react-vitest`（`fe-react-0022/0023`，25 与 15 用例）⇒ 阿里 32 题 / 可机器判 20 /
  **七类全覆盖**。全过程记在里程碑 AN。
  ｜验证（收口时实跑，全绿）：容器全量判题矩阵 `ARENA_REQUIRE_STACKS=1` → **154 道代码题 / 跳过 0 / 310 passed**；`alibaba/gen.py --check` → 18 份逐字段一致、漂移 0；`alibaba/probe_naive.py` → **149 项断言 0 失败**；`precheck.py` → 10 PASS / 8 SKIP / 0 FAIL；`subjective_gen.py` 断言 12 份全过（破坏性：改一个权重 → 立刻红）；`check_provenance.py` → **6 家通过 / 0 家有问题**（阿里 30/30 可复现）；`ARENA_FULL_GATE=1 npx vitest run server/test/bank` → 54 passed；真判分抽样三次 `/api/grade`：实质但残缺的答案 **6/10**，两份"关键词堆砌但每条方向反掉"的答案 **0/10** —— 这就是主观题版的"朴素解必须挂"。
  ｜三单并行的组织方式（下次照抄）：代码题单一单、主观题两单串行接同一份生成器；每单提示里写死「不许碰哪些文件」+「红在别家题上就重试一次别去修」+「地板由收口人统一抬」。


- [x] WI-71 给 ByteDance 补 `probe_naive.py`（文案↔数据探针，六家最后一份）
  判据方向与其他家相同：**数字用正则从已入库那份的答案/题面/用例名/备注里抠，再与同一份文件里的
  种子（`runner.setup`）、用例变更（`case.input`）、判分真值（`case.expected`）量到的值比**；抠不到也算失败。
  覆盖：11 道（java/pyspark/react）复用 `precheck.py` 的独立重写打在**已入库那份**上、
  5 道 mysql 独立复算、2 道 redis 用按参考解**顺序**执行的迷你 Redis，12 道主观题明确 SKIP（不写假断言）。
  ｜**第一次扫就翻出 10 处"已上线的题在说假话"**（8 处裁定为题错、2 处探针错，另自查 2 处：
  `sql-mysql-0028` 题面把 1/13 的万分比写成 7692 应为 769；`sql-mysql-0026` 题面那句
  "一个绝对阈值同时漏掉前者、误报后者"逻辑上不成立）。最深的一条是 `sql-redis-0011`：
  三条租约初值全落在 `now` 之上 ⇒ "把回收边界写成 `now`"这个错法**结果与正解完全相同**，
  而答案正文正断言着"错法会多删两条、ZCARD 从 4 变 2"。
  ｜落盘纪律：只改 `gen.py` 再经 `scripts/bank/drafts/sync_one.py` 写回，
  **expected/种子/参考解/朴素解一个字节都没动**（收口人独立 diff 过 4 份文件确认）。
  一处取舍如实写进答案：`sql-mysql-0028` 选择"把文案改成数据支持的事实"而不是造数据迁就原文案，
  代价是那条错法在当前种子上不可判。
  ｜验证：探针 375 项断言 EXIT=0；四处破坏性验证各自打红且真题库零写入（`sha256sum -c` 全 OK）；
  `check_provenance.py ByteDance` ✅ 30/30；容器矩阵 sql+big-data 75 题**跳过 0 道**/152 passed；
  `ARENA_FULL_GATE=1 npx vitest run server/test/bank` → 54 passed；`npm run verify:fast` EXIT=0。

- [x] WI-73 全面 code review 一轮（2026-09-24 用户口径："remove dead code/dead file / fix bug / 优化 UX（响应/布局）/ 继续 TODO"）
  ｜**四条"自称在工作、其实没有"**：① `provenance.test.ts` 从来没执行过（阶段 35 认领整个 bank 目录但不设
  `ARENA_FULL_GATE`，设变量的那条只点名 `content`）→ 阶段 37 改成整个目录在 FULL_GATE 下跑，并给
  `verify-coverage` 加一条"env 门控的文件必须由真设了那个变量的阶段认领"的守卫（`verify-gate: manual` 是申报口）；
  ② `start.ps1` 开头是**两个** BOM（HEAD 就有），PowerShell 只吞第一个 ⇒ 第 1 行注释被当命令执行，
  Windows 侧启动脚本其实早就跑不起来，而旧断言只看前 3 个字节所以看不见第二个；
  ③ `kit.mjs` 把 `timeoutMs>120000` 的草稿**静默删掉**（＝退回 20s，Spark 题必超时）；
  `runner.entry` 允许 `'class'` 而**没有任何 runner 实现它**；
  ④ `mirrors.sh` 的 apt 换源在非 deb822 分支只 sed Debian 地址 ⇒ 在 ubuntu:22.04 上**一个字符都不改**，
  红线 C3 只存在于文档里（证据：镜像内 `sources.list` 全是 archive.ubuntu.com）。
  ｜改 ④ 时踩到一个新事实：**`ubuntu:22.04` 里没有 ca-certificates**，所以 apt 走 `https://` 会
  "update 退出 0 但一个列表都没拿到"，install 才炸 —— 必须 `http://`。已在一次性容器里先验（189 包 0 个无法定位）再重建。
  ｜**死代码只做零引用那一档**（一次性扫 364 个 export，真死的只有 `casesOf`）：`deleteSetting`、`debugQuery`
  （能跑任意 SQL 的口子）、`journalMode`、`config.knowledgeDir`/`jdCacheDir`、`copilotArgs()`、
  `hooks.ts` 与 `errors.ts` 重复的 `isAbort`、`grantDailySetBonus` 那个没人看的 `_opts`、
  redis runner 里"setup 可以写 FLUSHALL"的死分支（注释也是假的）、Dockerfile 的 `ARG INSTALL_E2E`。
  过度 export（80 个"只在本文件用"）**没动** —— 只产生 diff 不产生价值。
  ｜**死文件**：6 个 `.playwright-mcp/*.yml` + `.qoder/settings.local.json` + npm 的
  `_update-notifier-last-checked` 收出索引（磁盘留着）；`.gitignore` 的注释符 `;` → `#`（git 只认 `#`）。
  ｜**知识库 17 篇语料没有任何入口**（`sql`/`frontend`/`algorithms` 整类别 + 三家新素材），而
  `scripts/kb/kit.mjs` 早就算出 `topicFiles` 却没人消费 ⇒ 7 个 README 补「语料文件」节、INDEX 加一列、
  `content.test.ts` 加一条"每篇都要被同类别 README 收录"的闸门。
  ｜**窄屏（390×844）两处实测缺陷**：类别芯片里唯一可压缩项撞上徽章被压到 47px（要 139px）、圆点挤成 3px；
  题目页 `.q-titles` 被 `.q-actions(0 0 auto)` 挤到 107px（要 227px）⇒ `flex:none` + 描述独占第二行 + 头部上下分段。
  ｜**WI-72 的取证钩子已落地**（原第③步）：react-vitest 在 spawn 前 stat 脚手架（缺→ error + `react-scaffold-missing`），
  报 `Could not resolve` 时再 stat 一次（`react-resolve-failed`）——"没写成"与"跑一半被删"从此可区分；
  根因仍未定，三次并发复现不红，**别当 flaky 关掉**。
  ｜**WI-56 债③换了做法**：不给那 29 道反推"生成器"（等于伪造手稿），改成 `no_draft_baseline.json` 内容指纹核查。
  ｜验证：`npm run verify:fast` ✅ EXIT=0（5 次，每批改动一次）；**四条破坏性对照**各自打红
  （阶段回退 / 抹 `verify-gate: manual` / 塞第二个 BOM / 删 stat 接线，还原后全绿）；
  `./start.sh --rebuild` ✅ EXIT=0 且构建日志出现 `Get:… http://mirrors.aliyun.com/…`，镜像内 `sources.list` 20 行指向 aliyun（改前 0 行）；
  `./start.sh --verify` ✅ 容器内十一阶段全绿（E2E 让给宿主）、**判题矩阵 411 passed / 0 skipped**
  （代码题 156 道全可判）、EXIT=0（约 18 分钟）；
  宿主 `npm run e2e` ✅ **12 passed**（2.0m）；390px 五页 **0 裁切 / 0 横向溢出 / console 0 error**，1280px 无回归；
  `check_provenance.py` ✅ 6 家通过（含 29 条指纹基线，改掉一道措辞立刻 DRIFT）。全过程记在里程碑 AO。

- [x] WI-74 视口边界闸门（2026-09-24 用户贴 1920 截图指出"边界问题没处理好"）
  ｜**AO 那轮的修法自己是半错的**：给芯片里的非文本项加 `flex:none`，把"文字被裁"换成了
  "内容顶破芯片" —— 768/1440 出现**整页横向滚动**（实测 `771>753`、`1450>1425`），
  而 1920/1440 下描述仍被压到 41-58px（"Java"、"LLM Agent / MCP / RAG" 直接 0px），
  最后一颗芯片被 `flex: 1 1 210px` 拉成 1392px 整行。根因是结构：一行塞五项 + 列宽随容器漂。
  ｜改法：`.cat-strip` → `grid: repeat(auto-fill, minmax(216px,1fr))`（最后一行不拉伸），
  芯片内部分行（名字+计数 / 描述 / 徽章），**删掉全部 ellipsis**；`.plan-title` 一行 ellipsis → 两行 clamp。
  ｜新增 `tests/e2e/responsive.spec.ts`：4 宽度 × 6 页面 = 24 条**几何**断言
  （整页不横向滚动 / 带自有文本的元素不被裁 / 一行里的芯片等宽；`code/pre/textarea/select` 排除，
  代码块横向滚动是功能）。`tests/tsconfig.json` 加 `lib: DOM`（此前没有一条 E2E 摸过 DOM）。
  ｜验证：`npm run e2e` ✅ **36 passed**（12 旧 + 24 新，2.5m）；`npm run verify:fast` ✅ EXIT=0；
  320/360/390/768/1024/1280/1440/1920 × 6 页 **0 溢出 / 0 裁切 / 芯片等宽**。
  ｜**踩到一条新纪律**（记进里程碑 AP）：第一次破坏性验证把 CSS 改回旧布局，24 条**全绿**——
  因为 E2E 跑的是 `instance.setup.ts` 起的**镜像**实例，`docker cp` 进 `daily-arena` 的产物它不看。
  换 `ARENA_E2E_BASE=http://127.0.0.1:7788` 才看到真的红。⇒ **验 E2E 闸门的牙，要么先重建镜像，要么显式指自己那台。**

- [x] WI-75 网页 IDE 加 **PySpark / Spark Scala**（2026-09-24 用户："两个都做，复用常驻池"）
  ｜十种语言按 `execution` 分四类跑法，**没有一种自己重新实现后端**：PySpark 走判题那个常驻 worker 的
  `mode:'ide'`（进程内收 `print`、最后一个 DataFrame 变表格），Spark Scala 每次真 `scalac` 编译 + 一次 JVM 运行，
  classpath 与判题共用 `exec/spark-scala.ts`（编译器与运行期的 Scala 标准库版本不一致会"编译过但运行期
  `NoSuchMethodError`"，这条只能有一处实现）。
  ｜可用性判据收进 `exec/`（`pysparkAvailable()` / `scalaSparkAvailable()`），判题 runner 与 IDE 各调同一个函数；
  注册表里 spark 型语言改用 `probeKind` 而不是 `probe` —— 原先写的 `npx --no-install scala-compiler -version`
  是句假话：Scala 编译器是 spark jars 里的 `scala.tools.nsc.Main`，不是 npm 包，探一个不存在的二进制
  只会把**能用**的语言永远标成"本机不可用"。`boundary.test.ts` 新增一条钉住"判据只有一份"。
  ｜**预置框只给真能先执行前置语句的语言**：spark-scala 每次都是新 JVM、由用户自己的 `main` 建会话，
  前置 SQL 没有落点 ⇒ 那门语言不给这个框（给了再悄悄丢掉等于骗人）。注册表自洽测试把这条钉死。
  ｜每次 IDE 运行开一个 `spark.newSession()` 做临时视图隔离（详见里程碑 AQ 第一条：
  "跑完按名单清掉"在 PySpark 3.5.5 上是静默空转）。
  ｜验证：`./start.sh --verify`（重建镜像后）✅ 全通过，其中 IDE 阶段 **80 passed / 0 skipped**（真起 Spark）；判题矩阵 **411 passed / 0 skipped**；
  宿主 `npm run e2e` 里那条 PySpark 用例 ✅（预置 SQL 建的视图变表格 + 第二次运行看不见它）；
  实测数字写进文档并有出处：PySpark 预热 0.3~6.7s、Spark Scala 一遍 15.4s、编译失败 1.4s、`newSession()` 1.3ms。

- [x] WI-76 网页 IDE 界面重塑（2026-09-24 用户两条反馈："好看点"、"运行按钮只显示运行，不要后面那些符号和英文"）
  ｜运行按钮从 `运行 (Ctrl/⌘ + Enter)` 改成 **`运行`**（快捷键本身照旧，提示移到按钮 tooltip）；
  "已经等了多久"从按钮里挪进文件栏，按钮文字不再随状态变化。
  ｜版面重心移到**输出**：结果区那条按状态着色的左竖线是这一页唯一的装饰；其余一律用现成 token。
  编辑器与输入收进一个"工作台"外壳（文件栏 `main.py` + 运行预算 + 提示语），预置/stdin 宽屏并排；
  删掉 12 个 inline style 对象改成一 `.ide-*` 类（inline 写不出媒体查询，窄屏那条"三个控件挤一行"必须靠它）。
  ｜用户第二次反馈把 `Ctrl / ⌘ + Enter` 那条 chip 也删了（"这里还是不用显示这么多"）。
  ｜验证：`npm run e2e` ✅ 40 passed（`responsive.spec.ts` 覆盖 `/#/ide` 四档宽度 0 溢出 0 裁切）；
  Playwright 真浏览器截图 1440/390 两档 + 0 console error。
  ｜**自己引入又当场逮到的一条**：REPL 输入行的 textarea 按 placeholder 算 min-content 宽度，
  把右边"执行"按钮压成 40px 竖排两行 —— 是看了截图才发现的（`f0790d2`）。补 `min-width:0` + 按钮 `nowrap`，
  复核 1440/390 两档按钮 60px 一行；`responsive` + `ide` 两条 spec 共 31 passed。

- [x] WI-77 网页 IDE 的 **REPL 会话面板**（原需求"断点 + 查看变量"由它取代，理由见下）
  ｜**为什么不做断点**：真断点要 DAP + 每语言一个调试器 + 在沙箱里挂起进程，而 IDE 的模型是
  "一次性起进程拿 stdout"（`ide/runner.ts` 的威胁模型只保证"跑飞了别把服务挂住"）。
  而"求值、看类型、看值、逐步试"这件事交互式会话本来就能做到九成 ⇒ 做 REPL，不做调试器。
  ｜语言：**Python（`python3 -u -i -q`）+ Node（`repl.start({banner:false,ignoreUndefined:true})`）+
  jshell（`-q --execution local -J-Duser.language=en`）**。TypeScript 明确**没有** —— 镜像里没有 ts-node，
  标上就是一个"选了却起不来"的语言（注册表测试钉住这一点）。
  ｜**传输用一问一答而不是原计划的 SSE**：每句都有天然的结束点（解释器打出的 `ARENA_REPL:<seq>` 哨兵行），
  上流式只会多出一套重连与状态机而拿不到别的东西。这条改动记在这里，因为它和当初拍板的写法不同。
  ｜会话上限 2、空闲 5 分钟回收、**正在等回显的那条不许被回收**、单句超时即作废（超时的解释器可能正在
  死循环里吃 CPU，留着一个"看起来还能用"的会话比杀掉它更糟）；组件卸载必须关会话（换语言/离开页面不许漏进程）。
  ｜验证：`server/test/ide/repl.test.ts` 容器内真起 python / node / jshell 全绿（跨句状态 / 报错不杀会话 / 多行块 /
  上限 / 回收 / 超时作废），连同 IDE 前端两批共 **87 passed / 0 skipped**；宿主 E2E 一条
  "上一句定义的变量下一句读得回来" ✅；破坏性三处（清草稿改回无条件、卸载不关会话、
  `boundary` 只查入口文件）都各自打红 —— 详见里程碑 AQ。

- [x] WI-78 发布端口绑回环（N-16 的落地，2026-09-24 用户拍板"不考虑手机 / iPad 访问"）
  ｜`compose.yml` 的 `arena` 与 `dev` 两个服务的 `7788` / `5173` 全部改成 `127.0.0.1:` 前缀
  （`e2e` 服务本来就是 `127.0.0.1:7798`，是这次的判据来源）。
  ｜为什么值得改：这个服务**没有任何鉴权**，而 `/api/bank` 会把整个题库（含被"移除"的题）与进度发出去；
  "隐藏"的语义是从今日套餐/游戏里摘出去，不含"不可见" ⇒ 收小暴露面比给它加一套登录划算得多。
  ｜新增闸门 `server/test/regression/compose-ports.test.ts`：**每一条**端口映射都必须以 `127.0.0.1:` 开头
  （不是点名某一条，这样新加服务默认被管），外加"确实解析到 ≥3 条"防空转、"7799 不许出现在 compose 里"、
  "启动脚本不许用 `--publish` 绕过"。
  ｜验证：`npx vitest run server/test/regression` ✅ 83 passed；破坏性（把 arena 的映射改回 `7788:7788`）
  → 立刻红在"这些端口对局域网开放：7788:7788, 7788:7788"；`./start.sh` 重建后
  `docker port daily-arena` 只监听 127.0.0.1，宿主 `http://localhost:7788` 与 E2E 照常。

- [x] WI-79 题库列表响应瘦身（N-15 的落地，2026-09-24 用户"继续吧"）
  ｜**没有新增端点**，而是把 `GET /api/bank` 的响应本身换成列表行：`{rows, hiddenIds, total, tags, companies, unlabeled}`。
  理由是加 `/bank/list` + `/bank/search` 会让 `/api/bank` 变成**没有调用方的死面**（上一轮 review 刚清过这类东西）。
  ｜`rows` 里只有 `id/title/category/difficulty/judgeKind/tags/company/caseCount` —— 不带 `statement` 与 `cases` 内容。
  这两个字段在列表页各只有一个用途（徽章上的用例数、客户端关键词搜索），前者换成 `caseCount`，
  后者**换成服务端 `q=`**（本来就该服务端做：客户端留一份正文只为搜索，是拿 93% 的字节换一次 `includes`）。
  ｜`tags` / `companies` / `unlabeled` 是**按全库算的筛选项**，不是筛选结果 —— 否则一搜索下拉就自己缩水，
  看起来像"题库少了一批标签"。这条单独有测试（`narrowed.tags` 必须等于 `plain.tags`）。
  ｜C7 顺带收紧：列表少带一类字段，就少一次"下次忘了剥"的机会（写进 `rule.md` C7 的检查方式）。
  ｜**两个自己差点糊过去的假绿**（都记进里程碑 AR）：
  ① 体积断言第一版打在假题库上，比值 28% —— 假题库的题面是一行句子，量出来会骗人，
  于是把"真实量级"这条挪到 `server/test/bank/content.test.ts` 用真题库量（252 题：980KB → 72KB，7.3%）；
  ② 那条比值测试在两个 404 之间**通过了**（错误体比 200 的响应小），补了"两边都必须 200"才是活的。
  ｜验证：`npx vitest run server/test/api server/test/bank/content.test.ts web/test` ✅ **225 passed**；
  `npx tsc -b shared server web` ✅；线上端点实测 `curl /api/bank?includeHidden=1`：1,492,323 → **104,823 字节（−93%）**，252 行 / 963 标签 / 6 家公司 / 70 未标。
  宿主 `verify:fast`、容器全量与 E2E 的结果见里程碑 AR 的验证表。

- [x] WI-80 REPL 面板挪到编辑器**右侧并排**，顺带补上"关标签页漏会话"这条（2026-09-24 用户"放在下面感觉不容易使用"）
  ｜布局：`.ide-split` 在 ≥1100px 是 `minmax(0,1fr) 380px` 两栏，窄屏回到上下堆叠（再挤就把代码压成一条缝）。
  位置断言写在 E2E 的**几何**上（右栏 x ≥ 编辑器右边界、两者顶边同一行），不是"元素存在" ——
  用户要的是"在手边"，DOM 里有没有这个面板说明不了这件事。
  ｜**量的时候自己撞上真实故障**：2 个会话名额全被前几轮 headless 页面留下的孤儿占满
  （`GET /api/ide/repl` 报 `idleMs≈155s`），之后每次开会话都被拒，而界面上没有任何可关的东西。
  根因：React 的卸载 cleanup 在"直接关标签页"这条路上不跑 ⇒ 组件另挂 `pagehide`，用 `fetch(keepalive:true)` 发关闭请求。
  ｜名额要**看得见且有出口**：显示"会话 N / 2"，占满时给横幅 + "回收现有会话"；
  会话被判 `gone`/`timeout` 之后重取一次名额，否则"乐观记上"的那条永远多算一个。
  ｜**这条最要紧的教训**：`RequestOptions.keepalive` 加了、调用处传了、组件测试断言"参数传出去了" ——
  三层全绿，而 `requestJson` 从没把它拼进 `fetch` 的 init，也就是说那个修复**当时是无效的**。
  补了 `web/test/api-request.test.ts`（断言 fetch 收到的 init），删掉那一行立刻红。
  ｜验证：宿主 `npm run verify:fast` ✅ **375 + 45 passed**；容器全量 ✅ EXIT=0（IDE 档 **80 passed / 0 skipped**，
  真起 python / node / jshell）；宿主 `npm run e2e` ✅ **41 passed**，含本轮新加的两条
  （并排几何断言 + `page.close()` 之后名额必须回 0）；
  宿主浏览器实测六项（并排几何 / 跨句状态 43 / 关页面 2.5s 内名额归 0 / 回收后立刻能再开一句 /
  四档视口 `overflow=0` 且按钮不折行 / 控制台 0 error）；破坏性四处（删 keepalive 拼进 init、删 `pagehide`、
  横幅条件写死 false、删 gone 后的 `refreshLive`）各自打红。

- [x] WI-81 网页 IDE 的 **Python 行断点 + 查看变量**（2026-09-24 用户拍板"必做"；Java / JS 拆到 WI-82）
  ｜需求原话："断点有没有机会打在代码行号上？" ⇒ 有。机制：常驻子进程跑 `server/src/ide/debug_python.py`，
  双向都是**一行一个 JSON**（`run` / `step` 进，`stopped` / `output` / `exited` / `error` 出）。
  传输仍是一问一答而不是 SSE：每条命令都有天然的结束点 = 下一个停点事件。
  ｜四条不是顺手写的规矩（都写在驱动脚本的 docstring 里）：
  ① **协议独占 stdout** —— 用户代码里一个 `print` 就能把协议打断，所以 `sys.stdout/stderr` 换成代理转成 `output` 事件；
  ② **协议独占 stdin** —— 一个 `input()` 就会把"继续"当输入吃掉，所以 `sys.stdin` 换成空 `StringIO`
  （代价明说：调试时 `input()` 立刻 EOF，要试带 stdin 的程序请用"运行"）；
  ③ **只跟踪用户那份代码**（文件名 == `main.py`），标准库里面不停；
  ④ **停下来 = 在行事件里阻塞读命令**，不起线程，也就没有"命令与执行抢同一份状态"。
  ｜**"停在第 N 行"= 第 N 行还没执行** —— 测试按这个断（`x` 读得到、`y` 读不到），否则实现者会漂到"下一行"去。
  ｜`next` / `stepIn` / `stepOut` 的"深度"顺着 `f_back` 数用户帧算：第一版用 +1/-1 计数器，
  而 `'call'` 事件到不了本帧的 local trace（新帧归 global trace 管），计数永远是 0 ⇒ `next` 会停进函数体里。
  测试当场逮住，修完补了一条 `stepOut` 的用例（四种走法各有断言才算钉住）。
  ｜会话是**一次性的**：跑完 / 抛异常 / 单步超时之后进程就退、会话就没。
  `status` 区分 `rejected`（压根没起：这门语言没有断点、名额已满）与 `gone`（起过后没了）—— 界面要说的话不一样。
  ｜名额 1、空闲 5 分钟回收、**正在等单步结果的那条不许杀**：这三条的数值挪进 shared 的 `IDE_SESSION_LIMITS`，
  REPL 与调试共用一份（同一类资源：跨请求活着的子进程）。
  "忙"用 `outstanding` 计数而不是 `pending` 是否非空 —— 命令是排进队列的，`pending` 要到下一微任务才装上，
  而"这条不许杀"必须在调用那一刻成立（REPL 那边同一条判据是靠"先杀掉另一个会话时顺带 await 了一次"侥幸过的）。
  ｜界面：断点打在编辑器的行号槽上（点一下有 / 再点没，`Ctrl+F9` 同义 —— 只给鼠标等于少一条路），
  停住的那一行在同一个槽上标 ▶；右栏调试面板排在 REPL 之上（单步时眼睛要在"停在哪 + 变量"上）。
  ｜**只有真浏览器才看得见的一个 bug**：两个面板一度共用 `key={active.id}` ⇒ React 在同一份 children 数组里
  看到重复 key，python 的调试面板赖在 DOM 上不走（切到 mysql 还在，按下去发的是 python 的代码与语言）。
  单测看不见（它只渲染一个面板），E2E 补了"换语言面板必须跟着没"这一条。
  ｜验证：容器内 `server/test/ide` + `api` 共 **142 passed / 7 skipped**（debug 20 条真起 python）；
  E2E `ide.spec` + `responsive.spec` **33 passed**；宿主浏览器实测：点第 7 行行号 → 停在第 7 行、
  变量表给出 `sys / name / i=1` → 下一步到第 6 行 → 继续再命中 → 关页面后名额回 0；
  题目页编辑器没有多出一列断点槽；1440 / 1000 两档 `overflow=0`；console error 与 warning 都是 0。
  ｜破坏性三处各自打红：摘掉 `next` 的深度判据、摘掉回收的忙保护、把 `output` 事件丢掉。
  ｜交付档位（跑在最终 HEAD 上）：容器 `./start.sh --verify` ✅ EXIT=0，**判题矩阵 415 passed / 0 skipped**，
  容器内 IDE 档 **100 passed / 0 skipped**；宿主 `npm run e2e` ✅ **42 passed**。
- [x] WI-82 行断点扩到 **Java 与 JS**（三门齐了：python / java / javascript）
  ｜**已完成（Java，2026-09-25）**：`ide/debug-java.ts` 驱动 jdb，契约 / 端点 / 界面一行没改就接上了
  （会话管理器拆成"纪律在 `debug.ts`、怎么说话在各家后端"，接缝是 `ide/debug-backend.ts`）。
  实测到的四件事决定实现形状，别再猜：
  ① `javac` 不带 `-g` 时 jdb 明说 "Local variable information not available" ⇒ 调试那份自己带 `-g` 编；
  ② jdb 的 `locals` **不给类型**（只有 `名字 = 值`）⇒ `DebugVar.type` 留空，不按值猜 int/long；
  ③ JDK 17 的 jdb **有** `step over`（不用拿重复 step 去凑"步过"），步出是 `step up`；
  ④ jdb 的消息跟着 JVM locale 走 ⇒ 必须 `-J-Duser.language=en`：中文 Windows 上它打的是"断点已命中"，
     整套解析会静默失效（与 `ide/repl.ts` 给 jshell 加同一个参数是同一件事）。
  ｜**两个只在 Windows 上现形的 bug**（细节见里程碑 AU）：贪婪的类型前缀把变量名吃掉（`args` → `s`，
  单测里全是单字符名所以免疫）；jdb 把"停点行 + 源码回显 + 提示符"塞进同一个 chunk 时状态机互等超时。
  为此专门补了一条**在宿主上跑**的 Java E2E —— 容器里的单测看不到这类形状问题。
  ｜另两处顺手收的：`killTree` 三份拷贝合成 `judge/process.ts` 的 `killProcessTree`；
  硬杀 jdb 在 Windows 会留孤儿 JVM 并锁住沙箱 ⇒ `DebugHandle.requestExit()` 先请它自己退（jdb 用 `quit`）。
  ｜验证：容器 `server/test/ide/debug.test.ts` **25 passed**（java 5 条真起 jdb）；宿主同一文件连跑 4 次全过；
  容器全量 ✅ EXIT=0（判题矩阵 415 passed / 0 skipped）；宿主 `npm run e2e` ✅ **43 passed**；
  宿主浏览器实测 Java 走完整条路（变量名 `args/total/i` 完整、单步与命中正确、console error+warning 为 0、
  关页面后名额回 0 且沙箱目录清空）；破坏性四处各自打红。
  ｜**已完成（JS，2026-09-25）**：`ide/debug-js.ts` 走 CDP，客户端用 Node 内置的 `WebSocket`（没引依赖）。
  三条实测（都不是设计出来的）：① `--inspect-brk` 只是"停"，VM 会一直**等调试器放行** ——
  不发 `Runtime.runIfWaitingForDebugger` 就永远收不到 `Debugger.paused`（连接与 enable 都成功，事件一个不来），
  所以启动 gate 是两步：装完断点 → 放行 → 才拿到那个 `Break on start`（它是窗口，不报给界面）；
  ② 命中断点时 V8 报的 reason 是 `other`、断点 id 在 `hitBreakpoints` 里 —— 按 `reason === 'breakpoint'` 分
  会把每个断点都标成"单步"；③ **只要调试器还连着，node 跑完也不退出**（打印完 stdout 就一直挂着），
  所以收到 `Runtime.executionContextDestroyed` 要主动断开 ws，子进程才会以退出码 0 结束。
  ｜JS 还有一条与另两家不同的**语义**（不是 bug）：`const` 的名字先于赋值就在作用域里（TDZ），
  所以停在第 7 行时 `answer` 显示"声明了，还没赋值"而不是"看不见"。测试按这个断，README 也写了。
  ｜界面与端点确实一行没改 —— 这就是当初拆 `debug-backend.ts` 接缝要换的东西。
  ｜**建议先不做**（等用户点头再砍）：条件断点、多帧调用栈浏览、监视表达式 —— 前两个 UI 成本远高于价值，
  监视表达式跟 REPL 重叠。
  ｜验证：容器 `server/test/ide/debug.test.ts` **30 passed**（python 20 / java 5 / javascript 5，三家都真起子进程）；
  宿主同一文件 13 passed + 17 skipped（宿主没有真 python3，按设计 skip）；跑完 `data/judge` 下不留 `debug-*` 目录。
- [x] WI-83 三门行断点的**对抗式评审回收**（2026-09-25；同一批代码交给人对着看，而不是再自己写一遍测试）
  ｜为什么单独一条：三门各是"自己实现、自己测绿、自己提交"，而三家的绿是**三套不同的解析**
  （JSON 行协议 / jdb 的文本提示符 / CDP 的 ws 事件），写它们的是同一双手、同一批假设。
  ｜两份报告合起来 19 条，站得住的约 15 条，每条都按本仓库标准办（先有能红的测试，再改实现）。
  成立的那几条里最值得留的：
  ① **名额是 check-then-act** —— `sessions.set` 隔着一句 `await launch` 才登记，两个并发 start 都算"还有名额"，
     上限 1 真起 2 个常驻 JVM（**单线程不等于原子**，await 就是放手）；
  ② **死会话会把整条队列钉住** —— 排队轮到的一条去等永不来的停点，超时结算又被 dead 守卫挡掉
     ⇒ 那条 promise 永不落地，后面每条一起卡死（界面表现为"永远转圈"）；
  ③ **错误文案归错了地方** —— 管理器把所有 error 写成"程序抛异常"，而 SyntaxError 根本没跑起来；
     现在 `message` 由后端给（同一类谎言在 python 侧还有一条：出错不 `SystemExit(1)`，
     node 于是同时收到"error 事件"与"退出码 0"这两个矛盾信号）；
  ④ **"是不是你的代码"写成了白名单** —— `func.startsWith('Main.')` 把同一份 `Main.java` 里的辅助类当库帧丢了行号；
     改成排除法，且真停在库里时 `line` 留空 + 一句 message（那是别的文件的行号，画到用户代码上比不画糟糕）；
  ⑤ **JS 第一行的断点被吞** —— V8 把它与启动暂停合成 `reason:'ambiguous'`，无条件丢掉那个"窗口"就永远不停；
  ⑥ **JS 的事件泵一次等不到就永久失聪** —— 泵里的等待一 reject 就 `return`，此后停点全堆在队列里没人消费；
     另外 waiter 超时后不把自己摘掉 ⇒ "少一个事件"变成永久错位；
  ⑦ **`requestExit()` 里顺手 SIGKILL** ⇒ 同一句注释里写的"断开调试器让它自己跑完"永远不会成立；
  ⑧ **界面**：调试在飞时换语言 = 名额永久被占（卸载 cleanup 那一刻 `sessionRef` 还是空的 ——
     WI-80 修过同一故障，只是换了入口）、双击会发两次创建、删短代码后越界断点仍算进"断点 N 个"
     （界面在报一个自己兑现不了的数字）；
  ⑨ **注释与文档写得比事实漂亮** —— `clipRepr` 上写"只有这一处"而 python 驱动确实带了两份字面量副本，
     `ARCHITECTURE` 里"Java / JS 还没写适配器"活了两个 commit；
  ⑩（补回归时自己撞出来的）**第二根管道没人接** —— `child.stdin.write()` 不给 callback 也不挂 'error' 监听，
     写进一个刚关掉的调试进程时错误以 uncaughtException 冒出来，**崩的是整个服务**（测试表现为挂满 60s
     且整个文件多一条 Errors）。接缝上多一个 `writeLine(stdin, line, onFail)`，python 与 java 都走它；
  ⑪（**只有浏览器复验撞见**，评审与单测都没有）停在 JS 断点上不动 30 秒 ⇒ 整个服务被一条没人接的拒绝带走：
     事件泵是 `void (async () => {...})()`，里面那条 30s 等待 reject 后逃出 for 循环、没有接盘者
     ⇒ Node 按 unhandled rejection 结束进程，日志里只剩一句"等不到下一个停点"。
     ⇒ 修的是结构不是那个数：泵只被 resolve 型的三条叫醒（下一条停点 / 子进程退出 / socket 断开）。
     单测每条几秒走完、E2E 按完就往下走 —— **按时间才爆的故障两边都看不见**，所以补了一条 31s 的回归，
     并把"复验时要故意停顿一次"写进了 `.qoder/rules/dev_verify_workflow.md`。
  ｜**评审里不成立的那一条也值得记**：报告说"后端可能在 `finish()` 之后还 emit，把死会话复活"——
  `handleEvent` 开头早有 `if (session.dead) return`。没照报告改，而是去读那段代码并补了一次破坏性验证。
  ⇒ 评审报告是**线索**不是**指令**，照单全收通常赔上一处回归加一段没用的代码。
  ｜顺手补的空缺：三门里只有 python 与 java 有 UI 级 E2E，而 JS 恰是事件形状最反直觉的那家
  ⇒ 补 `行断点（JS）：断点打在程序第一行也要停…`（同一条 bug 的界面回归，也是 gutter 差一最容易露馅的那一行）。
  ｜浏览器复验时又看见一条**自己上一轮引入的**噪音：右栏赫然一行 `Debugger attached.`
  —— 那是"把 stderr 接进输出（为了让 `console.error` 看得见）"的副作用 ⇒ 扩那条既有的噪音判据，
  并把"用户自己打到 stderr 的字要看得见"配成第二条测试（少了它，"全滤掉 stderr"也能骗绿第一条）。
  ｜验证：容器 `server/test/ide/debug.test.ts` **38 passed / 0 skipped**（python 19 / javascript 8 / java 6 /
  不挑调试器的注册表与纪律 5）；
  宿主同一文件 19 passed + 19 skipped（python 按设计 skip）；`npm run verify:fast` 与 `eslint --max-warnings=0` 干净；
  破坏性八处各自打红：把登记挪回 await 之后、摘掉死会话的当场答案、把 240 改成 200、给它加一行尾注释、
  `inUserClass` 改回 `Main.` 前缀、不扩 stderr 噪音判据、去掉 `writeLine` 的失败接住、往泵里塞回一条会 reject 的等待；
  宿主浏览器（**重建后的镜像**）：JS 第 1 行断点 → `停在第 1 行（命中断点）` + 两格 TDZ → 单步到第 2 行，
  **并且停在断点上 35 秒不按任何键**（⑪ 的复现路径）→ 服务还在、单步 1s 内返回、界面上没有 `Debugger attached.`；
  python 循环里"下一步"回到第 2 行、语法错误与运行时异常各说各的话；
  java 第 7 行 `步入` → `停在第 3 行（Main.twice）` 且给出 `n = 20`、`步出` 回到第 7 行；
  每次停止后 `GET /api/ide/debug` 都是 `sessions:[]`；console error 与 warning 均为 0
  （唯一一条 error 是我探测打错了的 `/api/ide/debug/sessions`，与页面无关）。
  ｜交付档（跑在最终 HEAD 的镜像上，独自跑、期间不碰容器）：`./start.sh --verify` ✅ EXIT=0 ——
  **判题矩阵 415 passed / 0 skipped**，IDE 档 118 passed（`debug.test.ts` 38 条 / **0 skipped**，含新加的 31s 那条）；
  宿主 `npm run e2e` ✅ **44 passed（3.1m）**，三门断点各一条（python / Java / JS）全过。
- [x] WI-84 门禁那一次偶发红查到底（2026-09-25；按 WI-72 立的规矩"别当 flaky 关掉"）
  ｜现象：提交 WI-83 时 `pre-commit` 红了一次 —— `停在断点上 31 秒…` 那条**在 start 就拿到 error**，
  并且 `afterEach` 跟着报"调试沙箱没收干净"。之后连跑 3 次 IDE 档 + 2 次完整 `verify:fast` 都不红。
  ｜**两条断言不是两件巧合，是同一条因果链的两半** —— 这是这条工作项唯一值得记的方法：
  ① 后端各自编了启动超时（`waitForWsUrl` 15s、第一个暂停 20s），比管理器的 30s 小 ⇒
     机器忙（同一轮里 jsdom 13 条 + runner 49 条在抢 CPU）时**后端先放弃**，start 结算成 error；
  ② 那句错误文案本身是假的："node 没起调试端口就退出了" —— 进程活得好好的，只是慢；
  ③ 那第二个红来自第三处：Windows 上"进程刚死、目录还锁着"是真的（`rm` 抛 EBUSY / EPERM），
     而 `dispose()` 一律 `.catch(() => undefined)` ⇒ **每轮安静攒一个孤儿目录且谁都不报错**。
  ｜改法：启动预算**由管理器算好传进 `launch`**（`startupBudgetMs`，类型必填 ⇒ 忘传编译不过），
  启动这一路（等 URL → 连上 → 放行 → 等第一个暂停）共用同一份余额；"还活着只是慢"与"真退了"
  分两句说，并且慢那条要**顺手杀掉**挂着 `--inspect-brk` 又没人接管的 node；
  新增 `removeWithRetry(root)`：试 4 次、退避到 ~0.4s，仍失败**照实抛出**。
  ｜顺带修的一条测试缺陷：那次红**没带原因**（断言只写 `toBe('stopped')`）—— 现在补成
  `started.output ?? started.message`。不会自报原因的门禁测试，红了等于没红。
  ｜验证：容器 `debug.test.ts` + `judge-workspace.test.ts` **47 passed / 0 skipped**；
  宿主 IDE 档 51 passed + 54 skipped（python 按设计）；typecheck 与 `eslint --max-warnings=0` 干净；
  破坏性：把重试次数改成 1 ⇒ 注入的那条立刻红（"前两次失败、第三次成功"结算不成成功）。
  ｜测试为什么注入 `remove` 而不是真造一把锁：Linux 上 `rm` 对开着的句柄照样成功，
  拿真锁写断言只会得到一条"只在某台机器上才有意义"的测试（第三条真句柄的那条留着，两边都不假红）。
- [x] WI-85 断点槽不再同一行摆两个点（2026-09-25 用户贴截图："两个点，一个白点，一个红点同时出现"）
  ｜两个成因叠着才难看：① hover 判据挂在**整条槽**上（`.cm-gutter-breakpoints:hover .cm-gutterElement::after`）
  ⇒ 鼠标一进去**每一行**都冒空心圈；② 停住的那一行同时渲染红点与 ▶ ⇒ 一行两个标记。
  ｜改成"一行只有一个标记，各列各说各的事"：空心圈只画被 hover 的那一格、且那一格已有标记就不画（`:not(:has(...))`）；
  断点 = 红点；停在自己的断点上 = 红点套一圈主色（不再叠 ▶）；停在**没有**断点的行 = ▶（▶ 唯一出场的场合）；
  "停在哪一行"改由**整行底色**说（`EditorView.decorations.compute` + `Decoration.line`）。
  ｜顺带一条 API 事实（踩过）：`gutter({ lineMarker })` 是"给这个槽的每一行加一个 marker"，
  **不是**"往行号那一列加 class" —— 按后者用会得到一个类型错误 + 一个挤在同一个格子里的第二个标记。
  ｜E2E 跟着改强了：python 那条现在两种场合都断到（停在断点上 ⇒ `.cm-bp-dot.cm-bp-active` 且无 `.cm-bp-here`；
  下一步到没断点的行 ⇒ `.cm-bp-here` 且 active 退掉），外加"整行高亮只有一行"。
  ｜验证：`npm run verify:fast` ✅ EXIT=0；真浏览器两张截图看过（idle 的 hover 只画被指那一格 / stopped 的红点 + 主色圈 + 行底色）；
  重建后的镜像上宿主 `npm run e2e` ✅ 全过（含改过的这三条断言）。
- [x] WI-86 发布前深度审计：绝对路径 / 大文件 / 敏感信息（2026-09-25 用户"要上 github 归档"）
  ｜口径是**推上去收不回来的三样**：工作树、全部历史 blob、镜像构建上下文 —— 只扫工作树会漏后两样。
  ｜结论：大文件**没有**（工作树与历史最大都是那张 1.24MB 架构 PNG，`.git` 27MB）；
  绝对路径 **2 条真的**（`ARCHITECTURE.md` 的 draw.io 安装路径、plan 里的仓库绝对路径）已改，
  改完复扫剩 2 条命中全是 `pinduoduo.com/home/seckill/` 这种 URL 假阳性；
  密钥**工作树与历史都干净** —— 2905 个历史唯一 blob 按 10 种凭据格式扫，1 命中且是变量引用假阳性；
  `.env` 从未进过版本库；上一轮那个"`compose.yml:8` 被 sed 打码所以不知道是不是字面量"的疑点
  用**只看形状**结案（长度 27 / 含 `${` / 结尾 `N:-}` ⇒ 透传）。
  ｜真正会漏的那条不在 git 里：`Dockerfile` 有 `COPY . .` ⇒ 必须查 `.dockerignore`（它排掉了 `.env`/`data`/`.git`，
  token 不会被烤进镜像）。只查 `.gitignore` 看不见这件事。
  ｜顺手：`.bank-count` 进 `.gitignore`（本机辅助计数，一直挂在 status 里只会诱人 `git add .`）；
  架构图导出脚本从写死路径改成"三个常见位置找 + 找不到报错退出"，并避开 `set -e` 下的 `&&` 链。
  ｜两条自己撞出来的度量错误（详见 memo 里程碑 AX）：① 尾随的 `echo "EXIT=$?"` 会让后台任务通知报 0
  而真实是 1（`dev_verify_workflow.md` 写的是 `| tail` 吞退出码，这是它的姊妹形态）；
  ② AW 刚加的"筛选条顶边差 ≤1px"是**验不成的判据** —— 居中布局下高 2.1px 的输入框天然上移 1.05px，
  真浏览器量出来五个控件**中心点 190.0000 全等** ⇒ 改成比中心点（阈值 0.5px）。
  破坏性：给一列注入 `margin-top:24px` ⇒ 中心差 0 → 12，撤掉回 0。
  ｜验证：`npm run verify:fast` ✅ EXIT=0；`./start.sh --verify` ✅ 判题矩阵 **433 passed / 0 skipped** + IDE 档 118 / 0 skipped；
  宿主 `npm run e2e` ✅ **45 passed**（首轮 44/1 红，红因即上面②）；`#/bank` 真浏览器换一次状态再量 + console error/warning 均 0；
  `node scripts/check-bank.mjs` ✅ exit 0。
  ｜**用户已拍板的四条**（2026-09-25 当晚）：① 题库**整库都传** —— "只给几个 sample"那条撤回了，
  因为我量过它的代价：那会把守题库的闸门全关掉（公司地板断言、`check_provenance.py` 依赖 drafts、
  E2E 按 judgeKind 挑题），实测是四个选项里破坏性最大的一个；② `content/jd-cache/` 跟着传，出处链保持完整；
  ③ `memo.md` / `HANDOVER.md` 两份日志都传；④ **不加 LICENSE**（默认保留所有权利）。
  ｜脱敏结论：真命中只有 **1 处**（知识文件转录了某篇公开文章的作者姓名与头衔，已改成"署名见该 URL 原文"）。
  其余手机号 / 身份证 / 银行卡 / `@handle` 全是假阳性，逐条核过而非看着像。
  另外做了一次**重合检测**（23 份本地素材规范化后切 48 字滑窗，对全部 tracked 文件求交集）：
  20 组命中、每组只 1 窗，打出来全是通用 import 与 SQL 语法 ⇒ **公开树里没有一句从 `data/kb-txt/` 转录的话**。
  ｜**已推送**（2026-09-25 收尾）：地址 `https://github.com/sherman9527/localIDE.git`。
  按用户要求把历史压成**一个初始提交**，身份 `sherman9527 <…@users.noreply.github.com>`（按命令传环境变量，没碰 git config）。
  旧 142 个 commit **没删**：改名成 `local-history-138` 分支 + `backup/prepublic-20260925` tag +
  `data/history-backup-20260925.bundle`（`bundle verify` 确认是完整历史）。全程无 `reset --hard`、无 `branch -D`。
  ｜推送前的最后一道检查是**扫"将要被 push 的那棵树"**而不是扫工作树 —— 就差这一字之差抓出了 `memo.md`
  里被复盘抄回来的账户名（于是补了 `publish-identity.test.ts` 这道闸门，判据从本机取身份、不硬编码）。
  621 文件 / 615 文本 blob 命中 0；6 张 PNG 另查了元数据也无。`push --dry-run` 确认只发一条 ref、
  `followTags` 未开 ⇒ 备份 tag 不会跟着公开。远端实测：1 个 commit、身份干净、无 tag。
  ｜**备份已按用户要求删除**：`local-history-138` 分支、`backup/prepublic-20260925` tag、
  `data/history-backup-20260925.bundle`（9.8MB）三者都没了。**但故意没跑 `git gc --prune=now`** ——
  旧对象目前仍可走查（`git rev-list --count 3f3f672` = 142），所以两三周内反悔还来得及；
  那一步是唯一把"可反悔"变成"真没了"的操作。
  ｜**一条还活着的坑，别踩**：仓库里还有个更早的 **`v0.1.0` 标签**（用户自己打的，指向旧线上的
  `9970f85`），它一个就把那 142 个带个人邮箱的旧 commit 全部锚住。远端没有它，所以现在不泄漏；
  但**哪天 `git push --tags` 或从它拉 GitHub Release，旧历史就一起公开了**。
  要么把它挪到新初始提交上、要么删掉、要么永远只 `git push origin main`。
  ｜**Docker 回收的真相，记下来免得下次误判**：`image prune -f`（75 个悬空镜像）+ `builder prune -f`
  报"回收 40.04GB"，但**宿主 `df` 一点没变** —— Docker Desktop 在 Windows 上把数据放在
  `~/main/dockerStorage/DockerDesktopWSL/disk/docker_data.vhdx`，那文件只涨不缩（实测仍 51GB）。
  要真还给 C: 得 `wsl --shutdown` + `diskpart` compact，或 Docker Desktop 的 Clean/Purge data（更狠）。
  用户判断是不折腾（重启也行）⇒ 记一句：**VHDX 不会因为重启就缩**，但保持已分配状态意味着
  下次构建直接复用那 40GB、不再涨盘，所以空间没丢、只是从"已用"变成"VM 内余量"。
  ｜**冷启动实测（清完 build cache 之后，这是必须重跑的一次）**：`ARENA_NO_BROWSER=1 ./start.sh`
  ✅ START_EXIT=0 —— 因为 build cache 被清，这次是**真·全量重建**（含 Redis 7.2.7 源码编译，
  正好把"三个源都取不到就 exit 1、不许静默退回 apt 6.x"那条新断言在真构建里走了一遍）。
  起后 `report_health` 报九栈全 true（java-junit / react-vitest / mysql / redis / pyspark / spark-scala /
  llm-rubric / java / react 全 true）；**进度数据没动**（XP 106、最长连击 1、青铜段位，db 是 bind mount）；
  容器内题库 254 道；真浏览器 `#/ide` 点"运行" ⇒ 退出码 0 + stdout 正确，console **error 与 warning 均 0**。

## IN PROGRESS

- [ ] WI-56 公司扩充（长期项）：目标 **每家 25-30 题**（2026-09-22 用户拍板，取代 commit `2b71a0d`
  消息里那句"6 家各 ≥50"；2026-09-23 追到 30）。
  **当前实测（2026-09-25 批：Airbnb +1、DeepSeek +1，题库共 254）：六家全部达 30 ——
  Airbnb 31（可机器判 10）/ Apple 30（14）/ DeepSeek 31（17）/ PDD 30（18）/ 字节 30（18）/ **阿里 32（20，七类全覆盖）**；
  容器判题矩阵在上一批跑到 415 passed / 跳过 0（题量涨了，这条数每次由矩阵自己报）。**
  本批新增两道的出处与判分点：`sql-mysql-0036`（预订占用对账：半开区间、过期锁不参与、三类冲突分开处置，
  锚 `airbnb-marketplace-booking.md` §1.2/§2.2/§2.7）、
  `alg-java-0059`（epoll LT/ET 的唤醒计数 + int 溢出，锚 `DeepSeek后端Agent面试102题.txt#11`）。
  两家的地板各抬一格（31/10 与 31/17）—— 抬的理由是"有出处、容器判过、朴素解会挂"，不是"题数到了"。
  这串数现在由 `content.test.ts` 的"公司维度"闸门报，不再靠人数 ——
  第一次跑就把这里原先写的"代码 10 / 15 / 16"纠成 9 / 14 / 16
  （三种独立数法一致：`judgeKind !== 'llm-rubric'`、有 `referenceSolution`、有 `cases`）。
  另有 70 题无公司标签（早期按类别出的，不回填 —— 回填等于伪造出处）。
  代码题占比是最需要盯的一层：**"靠主观题凑满 30"等于没达标**
  （起点 Airbnb 2 / Apple 8 / DeepSeek 7，现状 9 / 14 / 16 / 18 / 18 / 20）。
  ｜**仍开着的债**：① 下一家（腾讯/美团…）要先补公司向素材；② N-13 已决议走"报数不搬原文"（见下方需求池）；
  ③ Airbnb 18 + Apple 11 = **29 道主观题没有生成器草稿** —— "逐字段复现"这一层对它们做不到（早期就是手写入库的，
  补一份从题库反推的"生成器"只是把 JSON 抄成 Python，等于伪造手稿，不做）。
  2026-09-24 已把这条债**降级成可核查**：`check_provenance.py` 对无草稿题按
  `scripts/bank/drafts/no_draft_baseline.json` 的**内容指纹**核查，改了内容而基线没跟上即判红，
  放行需要一次显式 `--bless`（留下可审的 JSON diff）。破坏性验证：改掉 `sys-design-rubric-0002` 一处措辞
  → `DRIFT ... 内容与指纹基线不符（登记 435cf0783b42 → 现在 1ca2d7e50509）`，还原后 6 家全过。
  - 三家弹药清单与"已否掉别再挖"的清单见下方三块，均带手册/知识文件锚点。
  - **卡点**：再扩公司要先补 `content/knowledge/hot-interviews/` 的公司向素材，
    否则新题没有出处（N-11 脱钩面积会继续扩大）。
- **Apple 弹药**（原 8 个候选 + §13/§16/§3.5 开荒，**已全部用尽**）：
  已入库：#1 每小时峰值并发 carry-in（`sql-mysql-0013`）、#2 Airflow data interval
  （`alg-java-0027`）、#5 采样权重还原（`bd-pyspark-0014`）、#6 版本偏斜归一化
  （`bd-pyspark-0013`）、#7 看板降级（`fe-react-0013`）。
  已入库（本批新增）：#3 schema 契约兼容性门禁（`alg-java-0031`）、
  #4 H3 k-ring 邻近 join（`alg-java-0032`）、#8 联系人发现防枚举（`alg-java-0035`）、
  跨设备搜索隐私架构评审（`sys-rubric-0004`）、事件治理与 CI 卡口（`hot-rubric-0006`）。
  **Apple 的 8 个候选已全部用尽** —— 再要题就得回手册挖新段（`data/kb-txt/Apple面试准备手册.txt`
  195K 字符里 §4/§5/§13/§16/§19 都还有可判分的空白），或让用户点名新方向。
  已否掉的（别再重复挖）：DP 加噪（随机、不可判等）、`device_ts` 日归属（撞 `bd-pyspark-0004`）、
  单位成本 z-score（手册已给伪码，沦为照抄）、累积快照里程碑回填（离 `bd-pyspark-0003` 太近）、
  MinHash 去污染（可判但 Apple 锚定最弱）。
- **Airbnb 弹药**：代码题起点 2 道，现在 **30 道里代码题 10 道**。
  已入库：可订日期选择器（`fe-react-0015`）、price grid 总价重算（`sql-mysql-0014`）、
  搜索转化率两种口径（`sql-mysql-0015`）、预订闸门区间锁（`alg-java-0030`）、
  SRM 审计（`sql-mysql-0016`）、无结果松弛阶梯（`alg-java-0034`）、滥用处置评审（`hot-rubric-0005`）。
  还剩（都锚在 `content/knowledge/hot-interviews/airbnb-*.md` 的 §4 草稿上）：
  ｜**2026-09-25 逐条核对：下面三条全部已经入库，别再照着出（会出重复题）**——
  - ~~`redis` 日期区间锁~~ ⇒ 语义已被 `alg-java-0030`（LOCK/RELEASE/COMMIT 重放状态机）实现过一遍，
    而 `ZADD … GT` 这把手也已经被 `sql-redis-0003`（无 Lua 的任务领取 + fencing token）用过；
  - ~~`react-vitest` 曝光报表组件（C2）~~ ⇒ 已入库 `fe-react-0017`（新供给曝光份额，
    锚点正是 §2.3/§4 那个"6% 供给只拿 1.2% 曝光"）；
  - ~~`llm-rubric` 查询理解 agent 落点（C8，§2.9）~~ ⇒ 已入库 `ag-rubric-0005`（出处逐字写着 §2.9）。
  本批新做的是从 §1.2 + §2.2 + §2.7 里出来的 **`sql-mysql-0036` 预订占用对账**
  （半开区间重叠才是事故、过期锁不参与、三类冲突分开处置）。
  还**可能**没被吃掉的锚点：§2.5（价格规则版本化 + 影子计算对拍）与 §2.6（缓存串价的不变量断言）——
  只做过关键词级核对，**出题前必须逐题确认**（这次三条"待挖"里有三条其实早就入库，教训就在这）。
- **DeepSeek 弹药**（素材是 `data/kb-txt/DeepSeek后端Agent面试102题.txt`，102 条里已用约 45 条）：
  现在 **25 道里代码题 14 道**，是三家里最均衡的。本批新增：
  滑动窗口限流（`alg-java-0028`）、集群派发（`alg-java-0029`）、SSE 增量解析（`fe-react-0016`）、
  缓存击穿 single-flight（`sql-redis-0008`）、网关可观测评审（`hot-rubric-0004`）、
  熔断器三态（`alg-java-0033`）、截止时间准入（`alg-java-0036`）、多模型路由（`alg-java-0037`）、
  千万 QPS 网关（`sys-rubric-0005`）、Agent 成本闭环（`ag-rubric-0003`）、200K 档位陷阱（`hot-rubric-0007`）。
  还剩可挖的空白区：
  ｜**2026-09-25 核对：四条里两条其实已经入库**（`#60` ⇒ `alg-java-0038` 推理日志落盘前脱敏；
  `#79` ⇒ `sql-mysql-0017` Agent trace 汇总，`dup_tool_calls` / `max_depth` 就是"重复率/环路深度"）。
  - `java-junit` epoll/LT vs ET 的事件循环模拟（#11）⇒ **已入库 `alg-java-0059`**
    （给定 bytes/chunk/模式/唤醒上限，返回 `{processed, wakeups, stuck}`；三条规则各被一条用例隔离：
    半开区间、过期锁不参与、`>=` 与 `>` 的边界，外加一条 int 溢出的极大用例）；
  - `java-junit` TP/PP 并行度选型（#43）⇒ **暂缓**。素材原文只有三句定性描述（L379–381），
    "显存/通信开销/吞吐上界"全得自己编 —— 那等于给自造的题贴 DeepSeek 标签。
    可做的窄版只考确定事实（TP 整除隐藏维与头数、PP 整除层数、权重显存下界），
    出处要照仓库惯例明写"素材未给可判分口径"；要不要做由用户定；
  - `redis` 持久化选型后的键空间行为（#4，素材偏弱，同上先核出处再动）。
- 已跑通且**已入库**的可复制路径：`scripts/bank/drafts/<公司>/gen.py`（Python 字面量写题，`json.dump` 管转义）
  → `precheck.py`（用 Python 等价重写参考解，先在本地筛掉 expected 手算错）
  → `probe_naive.py`（量出"朴素解会给 N"这类写进答案的具体数字）
  → **SQL 题再加一步 `scripts/bank/drafts/probe_sql_draft.py`**（入库前对真 MySQL 跑参考解与朴素解；
  入库是 append-only 的，写错只能靠"隐藏"收尾，而这一步 30 秒就能查出来）
  → `npm run bank:add`（自动接 `bank:check`）→ 容器矩阵（参考解必过 + 朴素解必挂，`0 skipped`）。
  **顺序别倒**：这次先 `bank:add` 才跑探针，结果想补一条判别用例时 `sync_one.py` 按"用例数不许变"拒绝，
  只能开新题。
  **卡点**：剩余 3 家要用户点名 —— `content/knowledge/hot-interviews/` 目前只有 Airbnb / Apple 两家
  的公司向条目，新公司得先补知识库再出题（否则 N-11 的脱钩面积继续扩大）。

## TODO



- [ ] 【已决议：暂不做 · 2026-09-20 用户拍板】WI-38 JDK 21 与 Spark 并存的取舍（WI-26② 的评估结论）：镜像里 Spark 是 3.5.5，官方支持矩阵到 Java 17（21 要 Spark 4.0），而**同一个 JDK 既跑 javac/java 判算法题又跑 Spark**，整体升到 21 会把 pyspark / spark-scala 推到未支持路径。可行做法是并装 `openjdk-21-jdk-headless`（约 +400MB、stack 层要全量重建），只让 `java-junit` 用 21、Spark 继续用 17，并给 `RunnerConfig` 加 `jdk` 选项。
  当前损失面评估：record / sealed / switch 表达式在 17 就能编译，真正判不了的是**虚拟线程（21 正式）与 sequenced collections（21）**；而虚拟线程这类题本来就不适合"纯函数 + 用例"判分，所以先不付这个体积与重建成本。（"Spark 3.5 不支持 21"引自官方发布说明，本机未验证 —— 镜像里没有第二个 JDK）

- [ ] WI-72 判题沙箱偶发" harness 半路消失"：隐患已堵，根因未定（2026-09-24 交付档位那轮唯一的一条红）
  ｜**2026-09-25 主动证伪了两条候选（不再等复发）**，结论都是量出来的：
  ① **fd 压力 ⇒ 排除**。容器 `ulimit -n` 是 1,048,576；把它压到 160，`react-vitest.test.ts` 仍然
     10/10 全过，压到 64 / 48 时报的是 `Error: spawn /usr/local/bin/node EMFILE`（**spawn 阶段硬错**），
     不是 `Could not resolve …/vitest.config.mjs` —— 症状形状不同，不是同一条路。
  ② **启动清扫误删活沙箱 ⇒ 机制真实，但对那次红不成立**。机制确认：清扫只看目录 mtime，
     **"有进程开着句柄"根本挡不住删除**（Windows 与 Linux 都量过：Node 打开文件默认带
     `FILE_SHARE_DELETE`，POSIX 本来就不挡）⇒ 唯一防线是那道 1h 时限。
     不成立的原因很朴素：那次红发生在一轮不到 1h 的 verify 里，而新建的 harness 目录 mtime 就是当下。
     ⇒ 所以它是**潜在隐患**而非凶手：把"时限必须大于任何沙箱的最长寿命"钉成测试
     （`RUNNER_TIMEOUT_CAP_MS` / `IDE_LIMITS.maxTimeoutMs` / `idleMs + stopGraceMs` 三者取大，还要留两倍余量），
     并把机制本身写成断言。破坏性：把 `idleMs` 抬到 65 分钟 ⇒ 那条不变量当场红，
     消息直接给出两个数（`3600000 必须大于最长寿命 3902000`）。
  ⇒ 两条候选都关掉之后，**剩下的唯一已知机制**就是 AO 那轮堵掉的"同目录并发测试互相删"（`maxAgeMs: 0`）。
     根因仍未定，但下次复发不用再猜：看 `data/logs` 里 `react-scaffold-missing`（从来没写成）
     与 `react-resolve-failed`（跑一半被删）哪个出现。
  症状：`server/test/judge/react-vitest.test.ts` 的"参考解全部用例通过…"报
  `Could not resolve /app/data/judge/fe-react-harness-0001-XXXX/vitest.config.mjs`（445ms 就挂，
  单跑 10/10 全过）。当天同一份 verify 里其余 406 条全过、题库矩阵（含 23 道 react-vitest 题）也全过。
  ｜已做：把 `server/test/judge-workspace.test.ts` 里那条 `sweepStaleWorkspaces({ maxAgeMs: 0 })`
  挪进临时目录 —— `maxAgeMs: 0` 的语义是"一个都不放过"，打在**共享的** `data/judge` 上
  等于允许一个测试删掉并发 worker 正在用的沙箱，这是仓库里唯一能对"兄弟 harness 消失"给出
  机械解释的路径。改完断言变强（`toBe(1)` + 目录被删、普通文件留着），3 tests 全过。
  ｜**没做到的**：三次"前端矩阵 + runner 自检"并发复现都不红，所以**没证明它就是这次的凶手**，
  也没排除另外两条：`sweepStaleWorkspaces({ maxAgeMs: HOUR })` 在启动时删掉一个"一小时没写过
  但还活着"的长任务沙箱；esbuild 在 fd 压力下把读不到报成 "Could not resolve"。
  ｜**2026-09-24（里程碑 AO）落了取证钩子**（原先列的"下次再红前该做的第③件事"）：
  react-vitest 在 spawn **之前** stat 一遍脚手架 —— 缺就返回一条写清"这不是你提交内容的问题"的 error
  并打 `react-scaffold-missing`；vitest 报 `Could not resolve` 时再 stat 一次打 `react-resolve-failed`。
  这两条日志之差就是"从来没写成"vs"跑一半被删"，而那正是根因至今没定的原因。
  配套测试两条（探测器本身 + **接线**：stat 必须在最后一次 `ws.write(` 之后、`runProcess(` 之前，两处 `logWarn` 都在），
  删掉 stat 那段 → 接线断言立刻红（已验证）。**根因仍未定，别当 flaky 关掉**；
  下次复发先看 `data/logs` 里那两个事件名，再按上面 ①② 取证。
  ｜顺带抓到一个跨环境的坑（修这条测试时自己撞上的）：`maxAgeMs: 0` 在容器里绿、在宿主上红 ——
  Windows 上刚建目录的 mtime 可以比 `Date.now()` 晚几十毫秒，于是"一个都不放过"变成"一条都没删"。
  改成注入 `SweepOptions.now` 断言才不赌时钟（宿主 3 passed、容器 3 passed）。
  ｜下次再红时的取证顺序：① 立刻 `docker exec daily-arena ls -la /app/data/judge`（看还剩谁）；
  ② 抓 boot 的 `judge-workspace-sweep` 日志行与容器启动时间对比；③ 把 `react-vitest.test.ts`
  改成"spawn 前先 stat 一次 config、失败重试一次并打日志"，这样至少能区分"文件从来没写过"
  与"写过后被删"。**别把它当 flaky 关掉**——本仓库有过三个"断言下全绿的静默降级"。

## 新增需求池（尚未成为 WI）

- **N-17 题库的"标签"下拉有 963 个选项**（2026-09-24 做 WI-79 时顺手量到）：
  252 道题一共挂出 963 个不同标签，平均每题 3.8 个 —— 也就是说标签基本是自由文本，不是一个词表。
  `<select>` 里 963 项没法用（这不是这次改出来的：以前客户端从全量题目自己拼同一个列表，数量一样）。
  ｜**筛选层已落地（2026-09-25，WI-85 那批）**：facet 改成 `{name,count}[]` 且只列 ≥3 次的
  （963 → **78 项**，阈值 `TAG_FACET_MIN_COUNT` 放 shared 让两边不许各写一个数），新增 `tagCount`
  让界面能说清"被挡住的是下拉的位置，不是题目"。**题目数据一字未动**。
  ｜**剩下的一半仍开着**：词表本身的同义归并。这属于出题规范（C8 / N-11 那一族）而不是页面问题；
  改词表会动到已入库题目的 tags，那在 C5"只增不减"的边界内，但需要一次显式的清洗批次 + 出处复核。

- **N-16 端口暴露面**｜**已决议并落地 → WI-78**（2026-09-24 用户拍板"不考虑手机 / iPad 访问"）：
  `compose.yml` 现在把 7788 绑 `127.0.0.1`，并由 `server/test/regression/compose-ports.test.ts`
  钉住"每个发布端口都必须绑回环"。
  ｜留两条**免得下次重新查**的审计结论：① 仓库里没有 webhook / 钉钉 / 飞书代码，唯一外发是 LLM CLI 桥
  （token 只做请求头、不进 URL、不进日志）；② 子进程调用全是 argv 数组 —— 实测 15 处 `runProcess` 调用点 +
  7 处直接 `spawn`，`judge/process.ts` 与 `llm/cli.ts` 显式 `shell:false`；只有两处脚本
  （`scripts/check-bank.mjs:64`、`scripts/bank/add-questions.mjs:166`）为 Windows 写了
  `shell: process.platform === 'win32'`，而命令是**写死的字面量**，没有任何用户输入进得去；
  `docker exec` 在仓库里根本没有调用点。
  ｜另记一条语义（不是待办）："隐藏"不含"不可见" —— hide 的语义是从今日套餐/游戏里摘出去
  （账本在 `bank/hide.ts`），`includeHidden` 不是后门；答案与评分判据只从 `/questions/:id` 的
  `reference` 出（`publicQuestion()` 剥得干净，C7 有测试）。

- **N-13 出处指向 gitignore 掉的抓取产物**｜**已决议并落地 → 走"闸门报数，不搬原文"**：
  `source.knowledgeRef` 大部分指向 `content/**`（在库里、可核查），少数指向 `data/kb-txt/*.txt`
  （早期批次抓下来的面试手册原文）。`data/` 是 gitignore 的 ⇒ clone 下来这些出处无处可查。
  ｜2026-09-24 决议走"报数"，理由是**许可**不是体积：那是别人整理的面试题库原文，抄进仓库等于把许可问题
  固化进 git 历史。落地是 `content.test.ts > 报一下有多少出处指向 gitignore 掉的抓取产物` ——
  每次跑闸门都报，不假装看不见。**别升级成判红**：红了只会逼人把 ref 改指向一个不存在的内容，那是伪造出处。
  ｜2026-09-25 复测：**42 道**（这个数会随加题涨），只涉及**两份**手册
  （`DeepSeek后端Agent面试102题.txt`、`Apple面试准备手册.txt`）。README「已知边界」已把这条边界写明
  （含"clone 里查不到是设计如此，不是坏链"），并附一条实测：`source` 的字段里没有任何 quote/excerpt，
  且 48 字滑窗重合检测证明**题库没有一句从这两份手册转录的话**。
- **N-15 `/api/bank` 一次给 1.49MB**｜**已落地 → WI-79**（2026-09-24）：没有新增端点，
  `/api/bank` 本身改成只回列表行 + 全库筛选项，关键词搜索交给服务端 `q=`。
  ｜留一条实测作背景：改前 `curl /api/bank | wc -c` = 1,492,323 字节，按字段拆 `statement` 810KB、
  `cases` 482KB、`rubric` 22KB —— 而 `cases` 在列表页只有"几个用例"一个用途、`statement` 只为客户端搜索。
  ｜当时否掉的方向也记一下：给响应加 gzip（`@fastify/compress`）—— 仓库规矩是"能不加依赖就不加"，
  且 Node 自带 zlib 手写会碰缓存头。单机 loopback 下这是几十毫秒级的解析，不是坏功能。
- **N-11 出题 tags 与知识矩阵脱钩的面积在扩大**（本批实测，不是推测）：`content/knowledge/INDEX.md`
  把"题目 tag 在矩阵里找不到对应考点"列为独立一档，本批新增的 `llm-inference`、`modern:inference-gateway`
  都落进这一档；`frontend` 类别 20 行考点**根本没写反引号 tag**，导致该类别覆盖率算不出来（表里是"—"）。
  后果：`kb:index` 的"未覆盖考点"这份"该出什么题"的答案对这几类是失灵的，加题越多加得越没有方向。
  ｜**2026-09-23 复核后决定暂不做，理由记在这里免得下次重新发现**：
  实际工作量不是"给矩阵补 tag"。`frontend`/`algorithms`/`sql` 三类共 60 行考点没 tag，
  要让覆盖率可判定必须**两边同时对齐**：矩阵行加 `中文名（\`tag-id\`）` + 已入库的 16+37+? 道题
  的 `tags[]` 里得出现同样的 tag。后者是改动**已入库题**（撞红线 C5 的"永不覆盖"），
  而且 tag 命名是一次性定 60 个术语的取舍 —— 定错了比"算不出覆盖率"更糟（报表看着有数，其实是编的）。
  另外"脱钩 62/148/102…"那个数被设计性地虚高：`modern:*`、`classic:*`、公司名这类元标签
  本来就不该有考点行，`compile-knowledge.mjs` 只剥 `modern:` 前缀。
  ｜**公司维度已经不用 `grep` 了**：`content.test.ts` 的"公司维度"闸门每次报每家题数、
  可机器判数与最弱类别（WI-66），所以这里剩下的只有"考点 tag"那一半。
  ｜真要做，顺序应当是：① 先让索引把"元标签"与"考点标签"分开统计（不改题库，纯报告口径）；
  ② 再挑**一个**类别（建议 `frontend`，16 题最少）把 20 行 tag 定下来并只给新题用；
  ③ 老题的 tags 要不要回填，等 ② 的命名被用过一个季度再定。

已消化：N-01 难度自适应（WI-41/44）、N-02 错题本与间隔重复（WI-41）、N-03 雷达图与本周小结（WI-43/48）、
N-04 链表/树入参（WI-46）、N-05 判题历史回看（WI-45）、N-06 提交落盘路径、N-07 E2E 目录规范（决议不采纳）、
N-08 验证工作流规则、N-09 E2E 独立实例、N-10 judgeKind 双向测试闸门、N-12 公司维度进度（WI-66）、
N-14 出处审计接进闸门（WI-73，并补上"接了但从来没执行"的守卫）、
N-15 `/api/bank` 瘦身（WI-79）、N-16 端口绑回环（WI-78）、N-13 出处指向 gitignore（决议"报数不搬原文"，
闸门报数 + README 写明边界）、N-17 标签下拉（筛选层已落地 WI-85：963→78 项；**词表同义归并仍开着**）。
都已落地或已决议。
下一步若没有新需求，就是**日常使用 + 按使用中发现的问题回头修**，而不是继续堆功能（需求堆里没有一条还没被证伪为"用户不需要"）。
