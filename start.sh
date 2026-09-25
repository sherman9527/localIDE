#!/usr/bin/env bash
# 游戏启动脚本（需求 场景 20）。宿主机只需要 Docker（外加 curl / git，这两个 Git Bash 自带）。
#   ./start.sh                        构建（命中缓存则很快）+ 后台启动 + 健康检查 + 报判题栈可用性
#   ./start.sh --rebuild              强制无缓存重建（改了 Dockerfile / 依赖层时用）
#   ./start.sh --dev                  开发模式（vite 5173 + 后端 watch）
#   ./start.sh --ide                起服务并直接打开网页 IDE（同一个容器，只是换个落地页）
#   ./start.sh --logs                 跟踪容器日志
#   ./start.sh --bridge-logs          跟踪宿主 CLI 桥日志（主观题掉成人工自检表时先看这里）
#   ./start.sh --down                 停止（顺带收掉 E2E 隔离实例）
#   ./start.sh --verify               容器内跑 npm run verify（含判题矩阵，宿主机没有 java/pyspark；E2E 去宿主跑）
#   ./start.sh --e2e                  给出宿主跑 E2E 的命令（用默认浏览器 Edge 验你真正看的界面）
#   ./start.sh --e2e --in-container   确实要在容器里跑 E2E（bundled Chromium，不是 Edge）
#   ./start.sh --status               compose 视角的运行状态
# 启动成功后会用**系统默认浏览器**打开页面；不想自动打开：ARENA_NO_BROWSER=1 ./start.sh
set -uo pipefail
cd "$(dirname "$0")"

APP_URL="http://localhost:7788"
HEALTH="${APP_URL}/api/health"

say() { printf '\033[36m[arena]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[arena] %s\033[0m\n' "$*" >&2; }

wait_healthy() {
  local limit="${1:-240}"
  say "等待 ${HEALTH} 就绪（最长 ${limit}s）…"
  for ((i = 0; i < limit; i++)); do
    if docker compose exec -T arena curl -fsS "${HEALTH}" >/dev/null 2>&1 \
       || curl -fsS "${HEALTH}" >/dev/null 2>&1; then
      # 这里只报"就绪"，别说"打开"—— 真正开浏览器的是后面的 open_browser，
      # 而 --ide 开的是 #/ide，写死首页地址就是在说假话。
      say "已就绪 → ${APP_URL}"
      return 0
    fi
    sleep 1
  done
  fail "健康检查超时；用 ./start.sh --logs 查原因"
  return 1
}

ENV_FILE=".env"
BRIDGE_PID="data/llm-bridge.pid"

# token 必须"宿主桥"和"容器"用的是同一个，所以把它落到 .env（已被 gitignore）当唯一来源。
read_env_token() {
  [ -f "$ENV_FILE" ] && sed -n 's/^ARENA_LLM_BRIDGE_TOKEN=//p' "$ENV_FILE" | tail -1
}

write_env_token() {
  local token="$1"
  touch "$ENV_FILE"
  grep -q '^ARENA_LLM_BRIDGE_TOKEN=' "$ENV_FILE" 2>/dev/null \
    && sed -i.bak "s/^ARENA_LLM_BRIDGE_TOKEN=.*/ARENA_LLM_BRIDGE_TOKEN=$token/" "$ENV_FILE" && rm -f "$ENV_FILE.bak" \
    || printf 'ARENA_LLM_BRIDGE_TOKEN=%s\n' "$token" >>"$ENV_FILE"
}

# 端口上真正应答的那个进程才是事实。pid 文件会骗人：Windows 的 Git Bash 里
# `kill -0 <错位的 pid>` 哪怕对应的是别的进程也返回真 —— 于是"孤儿桥 + 新 token"这种状态下
# 旧逻辑照样打印"CLI 桥已在运行"直接返回，容器一路 401、评分静默降级成人工自检表。
bridge_probe() {
  # 入参 token；输出 none（没人监听）| ours（认 token 且能评分）| blind（认 token 但一个 CLI 都找不到）
  #              | stale（我们的桥但 token 不对）| foreign（别人的服务）
  local token="$1" resp code body
  resp="$(curl -s -m 2 -w $'\n%{http_code}' -H "x-arena-token: $token" http://127.0.0.1:7799/health 2>/dev/null)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
    000 | '') echo none ;;
    # "认 token"不等于"能评分"：桥的进程环境里没有 where/PATH 时 runnable 是空的，
    # 而 /health 照样 200 —— 容器侧就是 llm-rubric:false + 一路静默降级 manual（实测踩过，见 memo 里程碑 Y）。
    # 形状也要认：只回了个 200 但不是 `{"ok":true,"runnable":[…]}` 的就不是我们的桥，别替它担保。
    200)
      case "$body" in
        *'"ok":true'*'"runnable":['*)
          case "$body" in
            *'"runnable":[]'*) echo blind ;;
            *) echo ours ;;
          esac ;;
        *) echo foreign ;;
      esac ;;
    401) case "$body" in *token*) echo stale ;; *) echo foreign ;; esac ;;
    *) echo foreign ;;
  esac
}

# 结束占着 :7799 的进程。只在调用方已经确认它是我们自己的孤儿桥之后才用 —— 别人占这端口时
# 要报警而不是动手杀。lsof 优先（macOS/Linux），Windows 下退回 netstat 解析。
stop_bridge_on_port() {
  local pid=""
  # 写成显式 if 而不是 `a || b && c`：那种串法会把 lsof 查到的 pid 再被 netstat 分支覆写掉
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti tcp:7799 -s tcp:listen 2>/dev/null | head -1)"
  fi
  if [ -z "$pid" ] && command -v netstat >/dev/null 2>&1; then
    pid="$(netstat -ano 2>/dev/null | awk 'tolower($1)=="tcp" && $2 ~ /:7799$/ && toupper($4)=="LISTENING" {print $5; exit}')"
  fi
  [ -n "$pid" ] || return 1
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) taskkill //PID "$pid" //F >/dev/null 2>&1 ;;
    *) kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null ;;
  esac
}

start_bridge() {
  # 容器是 linux，宿主的 qodercli.exe / copilot.exe 进不去 → 由宿主 CLI 桥代跑主观题评分
  local token="${ARENA_LLM_BRIDGE_TOKEN:-$(read_env_token)}"
  [ -n "$token" ] || token="$(openssl rand -hex 16 2>/dev/null || echo "local-$RANDOM$RANDOM")"
  export ARENA_LLM_BRIDGE_TOKEN="$token"
  write_env_token "$token"

  mkdir -p data
  local state
  state="$(bridge_probe "$token")"
  case "$state" in
    ours)
      say "CLI 桥已在运行（:7799 认本次 token，且找得到可跑的 CLI）"
      return 0
      ;;
    stale | blind)
      # stale：token 不一致 → /complete 全 401。blind：token 对但这个桥进程找不到 CLI
      # （启动时继承了残缺的 PATH）→ 照样一路降级 manual。两者症状相同、处置相同：换掉它。
      local why="token 与本次不一致"
      [ "$state" = blind ] && why="一个可跑的 CLI 都找不到（多半是它的 PATH 残缺）"
      say "CLI 桥在 :7799，但$why → 重启桥"
      stop_bridge
      stop_bridge_on_port || {
        fail "没能结束 :7799 上的旧桥，请手动结束它再跑（留着它评分会一路降级成人工自检表）"
        return 1
      }
      ;;
    foreign)
      fail ":7799 被不是 CLI 桥的服务占着 → 不去动它，请自行腾出端口（否则主观题评分会一路降级 manual）"
      return 1
      ;;
    *) : ;;  # none：没人监听，往下正常起
  esac
  echo "$token" >data/llm-bridge.token
  nohup node scripts/llm-bridge.mjs >data/llm-bridge.log 2>&1 &
  echo $! >"$BRIDGE_PID"
  # 起没起成功不能靠 sleep 猜：端口被"token 不一致的孤儿桥"占着时新进程会 EADDRINUSE 秒退，
  # 但脚本照样打印"已启动"，最后表现为评分静默降级 manual。
  for _ in 1 2 3 4 5 6 7 8; do
    if curl -fsS -H "x-arena-token: $token" http://127.0.0.1:7799/health >/dev/null 2>&1; then
      say "CLI 桥已就绪（:7799，日志 data/llm-bridge.log）"
      return 0
    fi
    sleep 1
  done
  fail "CLI 桥没能就绪（:7799）。多半是端口被旧进程占着且 token 不一致 —— 看 data/llm-bridge.log，或手动结束该进程后重试"
  return 1
}

stop_bridge() {
  if [ -f "$BRIDGE_PID" ]; then
    kill "$(cat "$BRIDGE_PID")" 2>/dev/null && say "CLI 桥已停止"
    rm -f "$BRIDGE_PID" data/llm-bridge.token
  fi
}

# 用系统默认浏览器打开（用户默认是 Edge 就走 Edge，不钦定 Chrome）。ARENA_NO_BROWSER=1 可跳过。
open_browser() {
  local url="${1:-$APP_URL}"
  [ "${ARENA_NO_BROWSER:-0}" = "1" ] && return 0
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*) cmd.exe //c start "" "${url}" ;;
    Darwin) open "${url}" ;;
    *) command -v xdg-open >/dev/null 2>&1 && xdg-open "${url}" ;;
  esac >/dev/null 2>&1 || say "自动打开失败，请手动访问 ${url}"
}

# 闸门没接上时说出来。两条路都算数：仓库带 .githooks/pre-commit（要 core.hooksPath 指过去），
# 或者直接装在 .git/hooks/pre-commit —— WI-39 的实际落地方式是后者，只认前者的话这里会说假话。
warn_missing_hooks() {
  command -v git >/dev/null 2>&1 || return 0
  local path installed
  path="$(git config --get core.hooksPath 2>/dev/null || true)"
  installed="$(git rev-parse --git-path hooks/pre-commit 2>/dev/null || echo .git/hooks/pre-commit)"
  if [ "$path" = ".githooks" ] || [ -f "$installed" ]; then
    return 0
  fi
  say "提示：提交前自动校验没生效（core.hooksPath=${path:-未设置}，且 ${installed} 不存在）。要接上：npm run hooks:install"
}

# 健康检查过了 ≠ 什么都能干。评分链不可用会让主观题静默降级成人工自检表，
# 这是本项目反复出现的故障模式，所以起服务后必须把栈的可用性摊开说一次。
report_health() {
  local body
  body="$(curl -fsS "$HEALTH" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    fail "读不到 ${HEALTH}，用 ./start.sh --logs 查原因"
    return 0
  fi
  say "判题栈：$(printf '%s' "$body" | sed -n 's/.*"stacks":{\([^}]*\)}.*/\1/p' | tr -d '"')"
  if printf '%s' "$body" | grep -q '"llm-rubric":false'; then
    fail "主观题评分链此刻不可用 → 会降级成人工自检表。看 data/llm-bridge.log，并确认宿主桥在 :7799（./start.sh 会自己拉）"
  fi
}

# 起服务。落地页由各分支自己决定（up 开首页，--ide 直接开 IDE）。
# 构建这一步不能省也不能吞：省了就会"起成功但跑的是上一个镜像"，
# 吞掉构建失败则连"跑的是旧代码"都看不出来 —— 这两个坑本项目都踩过。
start_app() {
  start_bridge || return 1
  say "构建镜像（命中缓存则很快）…"
  docker compose build --pull=false || { fail "构建失败：没有起新代码，先修构建再跑"; return 1; }
  docker compose up -d arena || return 1
  wait_healthy 180 || return 1
  report_health
  warn_missing_hooks
}

case "${1:-up}" in
  --rebuild)
    start_bridge || exit 1
    say "重新构建镜像（首次约 10-20 分钟，含 Spark/MySQL/JDK）"
    docker compose build --pull=false --no-cache || exit 1
    docker compose up -d arena || exit 1
    # 与 start_app / start.ps1 同一个 180s：--rebuild 之后是"冷镜像第一次启动"
    # （mysql 首次建库 + spark 冷加载），偏偏是这条最需要宽限的路径。
    wait_healthy 180 || exit 1
    report_health
    warn_missing_hooks
    open_browser
    ;;
  --dev)
    start_bridge || exit 1
    docker compose build --pull=false || exit 1
    docker compose --profile dev up -d dev || exit 1
    say "开发模式：前端 http://localhost:5173 ，后端 ${APP_URL}"
    warn_missing_hooks
    open_browser http://localhost:5173
    ;;
  --logs)
    docker compose logs -f arena
    ;;
  --bridge-logs)
    tail -n 60 -f data/llm-bridge.log
    ;;
  --down)
    # 顺带收掉 E2E 隔离实例（npm run e2e 崩在中途时它会留在图上占 7798）
    docker compose --profile e2e stop e2e >/dev/null 2>&1 || true
    docker compose down
    stop_bridge
    ;;
  --verify)
    # -T：非 TTY 下（CI、agent、被别的脚本调用）不加 -T 会直接 "the input device is not a TTY" 失败
    # SKIP_E2E=1：E2E 的 global setup 要用 `docker compose` 起隔离实例，容器里没有 docker 可用，
    # 不加这一句 --verify 会在最后一个阶段必挂（判题矩阵其实已经跑完了），看起来像"验证不通过"。
    say "容器内验证跳过 E2E（容器里起不了隔离实例）；E2E 请在宿主跑：npm run e2e（用 Edge 验你真正看的界面）"
    # ARENA_REQUIRE_STACKS=1：arena 容器里 mysqld / redis-server 是 entrypoint 自己起的，
    # 栈不齐就是"这次验证其实没判那些题"。矩阵以前只打印一行"跳过 N 道"，被读成"跑了，只是慢"
    # （用 tools 容器跑就是这样静默跳掉全部 mysql/redis 题）。带上它，跳过即判红。
    docker compose exec -T -e SKIP_E2E=1 -e ARENA_REQUIRE_STACKS=1 arena npm run verify --silent
    ;;
  --e2e)
    if [ "${2:-}" = "--in-container" ]; then
      say "容器内跑 E2E：装的是 bundled Chromium，**验的不是你日常看的 Edge**（默认请去宿主 npm run e2e）"
      docker compose exec -T -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 -e ARENA_E2E_BASE=http://127.0.0.1:7788 arena bash -lc \
        'npx playwright install chromium && npm run e2e'
    else
      say "E2E 请直接在宿主机跑：npm run e2e"
      say "  它会自己起一个隔离实例（127.0.0.1:7798、data/e2e、题库只读），并用默认浏览器 Edge 验你真正看到的界面。"
      say "  确实要在容器里跑（Chromium、不碰宿主）：./start.sh --e2e --in-container"
    fi
    ;;
  --status)
    docker compose ps
    ;;
  up)
    start_app || exit 1
    open_browser
    ;;
  --ide)
    # 网页 IDE 与做题系统共用同一个容器、同一个服务，所以"独立启动"只是换个落地页：
    # 走完全一样的构建与健康检查，然后直接开 #/ide。
    start_app || exit 1
    say "网页 IDE：${APP_URL}/#/ide（这里不记分、不留提交历史）"
    open_browser "${APP_URL}/#/ide"
    ;;
  *)
    # 用法就是文件头那段注释。按"注释块到哪结束"取，不写死行号 ——
    # 写死过一次：加一行用法说明就把最后一行吃掉了，而没人会想起来改这里。
    sed -n '2,/^set /p' "$0" | grep '^#'
    exit 2
    ;;
esac
