#!/usr/bin/env bash
# 防 regression 总入口（需求 通用 3/4/5）。任一步失败立即退出并打印阶段名。
#   npm run verify:fast     只跑宿主机能跑的快子集（提交前用）
#   npm run verify          容器内跑全量（含判题矩阵与 E2E）
# 单独开关：SKIP_E2E=1 / SKIP_JUDGE=1（--fast 就是同时打开这两个）
set -uo pipefail
cd "$(dirname "$0")/.."

# 环境变量不能写在 npm script 里：Windows 的 cmd 不认 `FOO=1 cmd` 这种前缀赋值，
# 所以"快子集"必须是脚本自己的参数。
if [ "${1:-}" = "--fast" ]; then
  export SKIP_E2E=1 SKIP_JUDGE=1
fi

# 容器里跑 verify 时进程环境是 NODE_ENV=production（给服务端用的），
# 但 React 的 production 构建不含 act()，@testing-library/react 会整片失败 —— 测试必须用 test 环境。
export NODE_ENV=test

STAGE=""
run() {
  STAGE="$1"; shift
  printf '\n\033[36m=== [%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$STAGE"
  if ! "$@"; then
    printf '\n\033[31m✗ 阶段失败：%s\033[0m\n' "$STAGE" >&2
    exit 1
  fi
}

run "lint" npx eslint . --max-warnings=0
run "typecheck" npm run typecheck
# 先构建再量产物：拆包成果（首屏不许拖进 zod / CodeMirror）只有从 dist 才看得出真相。
# NODE_ENV 要显式 production：上面为 RTL 导出的 test 会让 vite 打进 dev 版 react-dom（多 ~60KB gzip），预算就量歪了。
run "前端构建" env NODE_ENV=production npm run build -w web
run "前端产物预算" node scripts/check-bundle.mjs

# ── notebook 服务身份：一个判据管两件事（评审 I-1 + I-2），必须同真同假 ──────────
# 读 ARENA_NOTEBOOK_SERVICE 而不是 ARENA_IN_CONTAINER：后者 arena / dev / tools 三台都有（compose 里
# 写了为什么照给），而"真跑 notebook"只有在**那个跑着 notebook 服务的实例**里才成立 —— 只有 arena 有这一行。
# ① 专门阶段要不要跑（跑 = 由它认领 kernel.test.ts）；
# ②「单元测试」那条要不要把这个文件从扫描里摘出去（摘 = 交给①）。
# 两边必须用同一个判据：只在①真时摘，dev / tools 里两条阶段都不跑它 ⇒ 那批常驻断言（宿主档也跑的那些）
# 静默消失，正是本仓库记过的"闸门一直是装饰"那一类；反过来①假时也摘，同一批断言在容器档里就没人跑了。
if [ "${ARENA_NOTEBOOK_SERVICE:-0}" = "1" ]; then NB_SERVICE=1; else NB_SERVICE=0; fi

# 评审 I-1（去重）：容器里这条"单元测试"阶段扫的是整个 `server/test/notebooks/`，而下面那条专门阶段
# 又点名 `kernel.test.ts` ⇒ 同一个真 Spark 会话被起**两次**（一次 40–90s）。更糟的是它坏的时候先红在
# 「单元测试」这个标签下、整轮就地终止，人本该读的那句「Notebook 运行时（kernel 真跑）」根本不会出现。
# 修法只在**这一侧**（另一侧都错：删掉专门阶段会撞 verify-coverage 那条认领判据；
# 把目录从「单元测试（shared + exec + regression + notebooks + server 根级）」那条阶段的清单里去掉
# 会静默搬走 18 条宿主档常驻断言（阶段名是真相，行号会漂 —— 这句原先写的是 `:35`，那条早就挪窝了）。
# 宿主走 else，行为与今天逐字节一致。
if [ "$NB_SERVICE" = "1" ]; then
  # `--exclude` 的值**不要**写成 `"${ARR[@]}"`：verify-coverage.test.ts 收集认领路径时丢掉以 `-` 开头的
  # token（所以那个 flag 本身不会被当成路径），但以引号开头的 `"${ARR[@]}"` 会被记成一条**假路径**。
  # ⚠ 已知弱点（**登记给 A2，本轮不修**）：`--exclude` 的**值**本身会被 verify-coverage.test.ts 的
  # 认领路径收集当成一条"这条阶段跑了 kernel.test.ts"的模式（它只丢以 `-` 开头的 token，不丢 `--exclude`
  # 后面那个路径）⇒ 被排除的文件看起来仍被这一阶段认领。今天它不构成误判（kernel.test.ts 那条
  # `env 门控`判据现在要求"设了全部变量的阶段"，专门阶段满足、这一条不满足），但"A 阶段说排除、
  # 守卫却按认领算"这个方向是错的：将来若有人靠 `--exclude` 把某个门控文件挪出目录扫描，
  # verify-coverage 会以为它还在跑。修法是解析时把 `--exclude` 的值记成**排除**而不是认领。
  # WI-94 Task 3：`embed.test.ts`（反代打在真 Jupyter 上）走的是**同一条被登记的路**——它同样用
  # `describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)` 门控，所以这里排除它、由下面那条专门阶段认领。
  # 排除的理由与 kernel.test.ts 不同但更硬：那一档真跑 Spark（贵），这一档每条都打真 7788 + 真 jupyter，
  # 在"单元测试"阶段扫目录时会**与专门阶段各跑一遍**，其中第 5 条会往 data/notebooks 建一份再删一份笔记。
  # WI-90 Task 1：`tutorials.test.ts`（教程可运行闸门）**走的就是上面这同一条路** —— 门控也是那个合取，
  # 所以这里同样排除它、由下面那条「教程 notebook 可运行」阶段认领。不排除的后果与 embed 一样是"跑两遍"，
  # 而且这一档每一篇教程都要真起一次 Spark（`kernel.test.ts` 那条注释写的 40–90s 是同一件事）。
  # 它常驻那一组（清单完整性 / 注册表形状 / 参数形状 / 门控本身）不会因此没人跑：
  # 专门那条阶段点名的是**整个文件**，宿主档则走 else 分支照常扫这个目录。
  run "单元测试（shared + exec + regression + notebooks + server 根级）" npx vitest run --exclude server/test/notebooks/kernel.test.ts --exclude server/test/notebooks/embed.test.ts --exclude server/test/notebooks/tutorials.test.ts shared server/test/exec server/test/regression server/test/notebooks server/test/*.test.ts
else
  run "单元测试（shared + exec + regression + notebooks + server 根级）" npx vitest run shared server/test/exec server/test/regression server/test/notebooks server/test/*.test.ts
fi
run "题库只增不减（基线取 git 跟踪数）" node scripts/check-bank.mjs --count-only
# 整个 bank 目录都要在 FULL_GATE 下跑：只点名 content 的话，
# bank/provenance.test.ts（skipIf ARENA_FULL_GATE）就永远只是"被跑过"而从未真跑。
run "题库闸门（含覆盖度与出处审计）" env ARENA_FULL_GATE=1 npx vitest run server/test/bank
run "游戏后端与前端测试" npx vitest run server/test/game server/test/api server/test/llm web/test
run "网页 IDE（执行内核与解耦边界）" npx vitest run server/test/ide web/test/ide.test.tsx

# notebook kernel 真跑：只在**那个跑着 notebook 服务的容器**里点名（判据是上面那个 NB_SERVICE，
# compose 只给 arena `ARENA_NOTEBOOK_SERVICE: "1"`；dev / tools 有容器标记但没有服务身份，理由见那里）。
# 不给它单开 SKIP_ 开关。"漏跑"的兜底不是 assert-ran.mjs（那条只读判题矩阵的 json），而是
# 这个测试文件里那两条常驻解释断言（标了服务身份却没有 kernel 文件 ⇒ 当场红），加上
# `notebook-compose.test.ts` ⑦（compose 那一侧每天在宿主跑，标记漂移在那里红，不用等一次 --verify）。
# 门控写在**文件里**（describe.skipIf 的合取）而不是只写在这个 if 上：上面那条"单元测试"阶段本来就扫
# server/test/notebooks/，宿主与 dev / tools 一样会跑到这个文件 —— 只靠阶段名点是挡不住的（评审 T10-1）。
# 两个变量在阶段命令里都显式设一遍不是冗余：verify-coverage.test.ts 那条"env 门控的闸门必须被
# '设了那个变量'的阶段认领"读的是**阶段命令行**，容器环境里已有的那份它看不见（照它的报错接线）。
if [ "$NB_SERVICE" = "1" ]; then
  # WI-94 Task 3：`embed.test.ts`（反代 + 真 Jupyter）由这一条认领 —— 两个变量都得设上，
  # 否则 verify-coverage 那条"env 门控的闸门必须被'设了那个变量'的阶段认领"会红（实测过它先红后绿）。
  run "Notebook 运行时（kernel 真跑）" env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run server/test/notebooks/kernel.test.ts server/test/notebooks/embed.test.ts
  # WI-90 Task 1：教程 notebook 的**可运行性**闸门（两层：执行层 = 无 cell 异常 + kernel 是 arena-pyspark；
  # 结论层 = `server/test/notebooks/tutorial-claims.ts` 那份注册表里每条方向性结论都要打出 marker，
  # 且打出的标记集合与注册表**双向相等** —— 只看"没报错"抓不到"有人把 assert 删了"，
  # 只核注册表抓不到"有人把注册表里那条 slug 删掉让已经红的结论变绿"）。
  # 它排在上面那条**之后**不是随意：那条的 beforeAll 会把 IDE venv 建出来（全新卷上 venv 还不存在时，
  # 这一档会红在"前置条件不成立"那句上，而毛病是环境没准备 —— 顺序让正常路径少一次冤红）。
  # 两个变量都得在命令行上：`verify-coverage.test.ts` 那条"env 门控的闸门必须被'设了那个变量'的阶段认领"
  # 读的是**阶段命令文本**（容器环境里已有的那份它看不见），这与 kernel / embed 那两处是同一课。
  run "教程 notebook 可运行（结论层）" env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run server/test/notebooks/tutorials.test.ts
else
  printf '\n\033[33m跳过 notebook kernel 真跑（这一档不在"那个跑着 notebook 服务的容器"里：宿主既无 arena-pyspark kernel 也无 Jupyter；dev / tools 是容器但按设计没有 ARENA_NOTEBOOK_SERVICE；镜像若早于 kernels COPY，连有标记的 arena 也不会有那个文件）—— 容器档必须补跑：./start.sh --verify\n（WI-90 Task 1 同一条路上一起跳过的还有「教程 notebook 可运行（结论层）」：宿主档只跑它那一组常驻判据（清单完整性 / 注册表形状 / nbconvert 参数形状 / 门控本身），真执行那两层要等容器档）\033[0m\n'
fi

if [ "${SKIP_JUDGE:-0}" != "1" ]; then
  # 判题套件在宿主机（无 JDK/MySQL/Redis/Spark）会整片 it.skip 且仍然 exit 0 ——
  # 所以除了 vitest 自己，还要断言"真的执行过用例"，否则"全绿"毫无意义。
  run "判题回归矩阵" npx vitest run server/test/judge server/test/regression --reporter=json --outputFile=data/verify-judge.json
  run "判题矩阵确实跑到了" node scripts/assert-ran.mjs data/verify-judge.json "判题矩阵"
else
  printf '\n\033[33m跳过判题矩阵（SKIP_JUDGE=1）——发布前必须在容器内补跑\033[0m\n'
fi

if [ "${SKIP_E2E:-0}" != "1" ]; then
  run "E2E（Playwright）" npx playwright test -c tests/playwright.config.ts
else
  printf '\n\033[33m跳过 E2E（SKIP_E2E=1）\033[0m\n'
fi

printf '\n\033[32m✓ verify 全部通过\033[0m\n'
