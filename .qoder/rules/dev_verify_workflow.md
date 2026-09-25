# 开发-验证工作流（本仓库的硬约束）

> 这份文档回答一个问题：**改完之后，凭什么说它没坏。**
> 项目记忆里的其它约定若与本文冲突，以本文 + `rule.md` 为准。

## 四条不可跳过

1. **任何改动都要跑验证**，且**没看到通过输出之前不许说"完成"**。
   验证入口只有两个：`npm run verify:fast`（宿主，约 45s）与 `./start.sh --verify`
   （容器内 `SKIP_E2E=1 ARENA_REQUIRE_STACKS=1 npm run verify`，含判题矩阵）。
   **E2E 归宿主**：镜像里不带浏览器（那个 `ARG INSTALL_E2E` 开关从来没人传过，已删），
   所以容器内裸跑 `npm run verify` 会在最后一个阶段必挂 —— 那不是回归，是走错门。
   确实要在容器里跑：`./start.sh --e2e --in-container`（当场装 bundled Chromium，
   但验的不是你日常看的 Edge）。
2. **TDD**：先让测试红，再写实现。红必须是"因为缺功能而红"，不是"因为写错测试而红"——
   两者搞不清时做一次破坏性验证：把被测物删掉/改坏，看门禁是否真的红。
3. **门禁自己也要被门禁**：`server/test/regression/` 下有 `typecheck-coverage`（测试文件是否纳入类型检查）、
   `verify-coverage`（每个 `*.test.ts` 是否被 `verify.sh` 某阶段认领；**以及 env 门控的闸门是否真被
   "设了那个变量"的阶段认领** —— `provenance.test.ts` 曾躺在被认领的目录里但那条阶段从没开 `ARENA_FULL_GATE`，
   于是"闸门"一直是装饰）、`runner-coverage`（每个 judgeKind 是否有双向往返测试）、
   `assert-ran.mjs`（判题矩阵整片 skip 也算失败）。加新目录/新栈时它们会要求你接线。
   故意手动跑的闸门要在文件里写一行 `verify-gate: manual —— 原因`，否则守卫会替你不依不饶。
4. **跨 session 记忆要更新**：`memo.md` 追加里程碑（做了什么 / 验证表 / 已知问题 / 教训），
   `HANDOVER.md` 移动工作项（完成 → COMPLETED 并带验证命令与结果）。

## 三档验证，什么时候跑哪一档

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 随手改（lint/类型/单测能覆盖） | `npm run verify:fast` | 宿主跑；`.git/hooks/pre-commit` 装好后每次提交自动跑 |
| 碰了判题器 / 题库 / 容器相关 | `./start.sh --verify` | 等价容器内 `SKIP_E2E=1 ARENA_REQUIRE_STACKS=1 npm run verify`；判题要真 JDK/MySQL/Redis/Spark，宿主机没有；矩阵必须报 `0 skipped` |
| 交付前 / 改了前端 | `./start.sh`（改到 Dockerfile 才 `--rebuild`）→ `./start.sh --verify` → 宿主 `npm run e2e` | E2E 用宿主 Edge（默认通道），且跑在**独立实例**上 |

## 前端改动的额外一条

**必须在真浏览器里看过**。单测 + E2E 都绿不等于界面没问题：本项目有过三个"静默降级"缺陷
（评分 401 掉到人工自检表、模型输出内层引号毁掉 JSON、桥 token 漂移），它们在断言下全是绿的。
最低要求：`browser_navigate` 打开页面 → `browser_console_messages` 里 **error 与 warning 都为 0** →
关键元素用 `browser_evaluate` 断到 DOM 上，必要时截图。
（warning 也要看是 WI-81 补进来的：右栏两个面板共用一个 `key={active.id}`，React 报的是
**重复 key 的 warning**，而实际故障是"切到 mysql 之后 python 的调试面板还赖在页面上"——
只看 error 是零，单测也结构看不见。）
还要**换一次状态再看 DOM**：只截一张"刚进来长什么样"抓不到"切走之后有没有清理干净"。

还要**故意停顿一次**（里程碑 AV 补进来的）：停在某个状态下几十秒不碰它，再看服务还在不在。
"按时间才爆"的故障有两道时限盲区 —— 单测每条用例几秒走完、E2E 按完就往下走，两边都不会
"停在断点上 30 秒"。本项目就是这么撞出第一例**整个进程被带走**的：调试事件泵是个 `void` 掉的
async IIFE，里面那条 30s 等待会 reject，拒绝逃出来没人接 ⇒ Node 按 unhandled rejection 结束服务，
而日志里只有一句"等不到下一个停点"。⇒ 顺带一条代码规矩：**`void` 一个 async 就要保证它永不 reject，
否则就地接住**（同类排查靠查不靠印象）。

## E2E 的状态隔离（WI-40）

`npm run e2e` 会自己起一个 compose 的 `e2e` 服务（宿主 `127.0.0.1:7798`），它的 `ARENA_DATA_DIR` /
`ARENA_DB_FILE` / `ARENA_HIDDEN_FILE` 全指向 `data/e2e/`，题库**只读**挂载 —— 所以测试既读不到也写不进
真人的 `data/arena.db` 与 `content/hidden.json`。跑完自动收容器与 `data/e2e`。

- 打到自己起的实例：`ARENA_E2E_BASE=http://127.0.0.1:7788 npm run e2e`（setup 只做健康检查）
- 留现场排查：`ARENA_E2E_KEEP=1 npm run e2e`
- **别占 7799**：那是宿主 CLI 桥的端口，撞上之后两边 `llm-rubric` 会一起变 false
- 验"是否真的隔离"要看 `data/arena.db-wal` 的哈希（WAL 模式下 `arena.db` 本体不变是假阴性），
  并且要做**反向对照**：故意打在真人实例上确认它确实会变，否则"两边都没写"也会看起来像成功

## 容器与镜像

- 一切依赖装在仓库内：`docker-cache/`（npm/pip/maven 缓存）、`data/`（db、日志、判题沙箱）。
- 镜像里改了源码不会自动生效：`docker cp` 进去的东西只活在**当前容器实例**，
  `compose up -d` / `--rebuild` 会按镜像重建。收尾必须 `./start.sh --rebuild` 让"跑着的"= HEAD。
- 判断线上进程是不是当前代码，要看**行为**不是看文件（例：启动后新建的静态资源能否被正确 MIME 服务）。
- `docker cp` 两条互补的坑：目录要用 `src/. → dst/`（否则嵌成 `dst/src`），文件不能加 `/.`。

## 脚本改动的语法自检

- `bash -n <脚本>`；`start.ps1` 必须保留 **UTF-8 BOM**（Windows PowerShell 5.1 读无 BOM 的中文脚本会解析失败），
  改完用 `PSParser::Tokenize` 确认 0 错误。
- `node --check scripts/*.mjs`。
- 这三条现在**有闸门**了：`server/test/regression/scripts-syntax.test.ts` 会在 `verify:fast` 里跑
  （`node --check` 全部 `.mjs`、`bash -n` 全部 `.sh`、ps1 的 BOM 字节）。以前它们只是写在本文档里的"记得做"，
  而"记得做"的自检等于没做 —— 脚本坏了要等下次手动跑才发现。
- **`.sh` 必须是 LF，而 `bash -n` 抓不到它**：Windows 的 Git Bash 容忍 CRLF，宿主上一切正常，
  但 `docker compose build` 拷的是**工作树字节** —— 一个 `\r` 就让容器里的 `verify.sh` 在
  `set -eu -o pipefail` 处报错，整轮容器验证一行都没跑。而 `.gitattributes` 写了 `eol=lf`，
  git 归一化后 `git diff` 还显示"无改动"，看起来就像"镜像是新的、验证也跑过了"。
  闸门：同一文件里的"shell 脚本行尾（不许有 CR）"，判据是字节不是语法。
- 自己敲的验证命令**别让管道吞了退出码**：`./start.sh --verify | tail -60` 的 `$?` 是 `tail` 的，
  上面那条 CRLF 故障就是这样被读成"exit 0"的。要么重定向到文件再判，要么 `set -o pipefail`。
- `start.sh` 与 `start.ps1` 是**同一套判据的两个实现**：改了其中一个就要想另一个是否还一致
  （历史上不一致过一次：sh 侧修了 hook 检测，ps1 还在说假话）。
