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
# 读写逻辑只这一份：桥与 notebook 各留一对 wrapper。分叉出第二份的下场是"其中一份说假话"
# （历史上 sh 侧修了 hook 检测、ps1 还在报旧状态就是同一类漂移）。
# 入参用 ${1:?} / ${2:-} 兜住：这脚本是 `set -u`，旧写法里少传参数得到的是 bash 那句
# "1: unbound variable"（然后整个脚本直接结束，因为这是非交互 shell）—— 现场看到的是一行
# 与 .env 毫无关系的报错。${1:?说明} 把它换成"哪个函数缺了哪个参数"；val 用 ${2:-} 是因为
# "把某个键写成空值"本身是合法用法（清空），而键名永远不可能是可选的。
read_env_key() {
  local key="${1:?read_env_key 需要键名}"
  [ -f "$ENV_FILE" ] && sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1
}

write_env_key() {
  local key="${1:?write_env_key 需要键名}" val="${2:-}"
  # 键名先过形状闸门（只允许 [A-Za-z_][A-Za-z0-9_]*）。这不是洁癖：键名是要拿去做**前缀匹配**的，
  # 而旧写法把它当正则喂给 grep —— `ARENA_[oops=` 里未闭合的字符类让 grep **exit 2**（真报错）。
  # 那本来不要紧，要紧的是下一行原来的样子：`grep -v ... >"$tmp" 2>/dev/null || : >"$tmp"`
  # 把 exit 1（"谁都没匹配上"，正常情况）与 exit ≥2（真报错）**分成同一条路**，于是报错的那次
  # 会走 `||` 分支把 tmp 截成空、只追加新键，然后 mv 覆盖 .env ⇒
  # **整份 .env 只剩一行，其余键全没了，而 rc=0、一行错误都没有**（评审实测复现过）。
  # 闸门放在入口 + 下面换成无正则的滤法，两条一起把这类"静默截断"堵死：没有任何失败路径能留下
  # 一份缺键的 .env，失败时原文件一个字节都不动。
  case "$key" in
    '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
      # 话要说准：首启时还没有原文件，"原文件一个字节都没动"在那一刻根本没有对象（评审点名的一条）。
      if [ -f "$ENV_FILE" ]; then
        fail "拒绝改写 ${ENV_FILE}：键名 '${key}' 不是合法环境变量名（只允许字母/数字/下划线，且不能以数字开头）—— 原文件一个字节都没动，新值也没写"
      else
        fail "拒绝改写 ${ENV_FILE}：键名 '${key}' 不是合法环境变量名（只允许字母/数字/下划线，且不能以数字开头）—— 这里还没有 ${ENV_FILE}，本次也没有创建它"
      fi
      return 1
      ;;
  esac
  # 「是不是首启（原来没有 .env）」必须**在 touch 之前**判。这一条曾经是错的：touch 无条件先把文件建出来，
  # 于是它下面那句 `[ -f "$ENV_FILE" ]` 永远为真 ⇒ "没有原文件可抄 ⇒ 按 0600 建" 那一支是**dead code**，
  # 全新的 .env 实际落在 umask 默认（Linux 上 0644），而注释和报告都写着 0600。
  # touch 留在这里只负责一件事：让下面那条 awk 读原始文件时不会遇到"文件不存在"。
  local firstCreate=0
  [ -f "$ENV_FILE" ] || firstCreate=1
  touch "$ENV_FILE"
  # **不用 sed 做替换**：值里带 `|`、`&`、`\` 时 sed 会把它们当作替换表达式的一部分
  # （`&` 是"整段匹配"、`\` 是转义、分隔符本身直接截断），于是 .env 被悄悄写坏 ——
  # 桥与容器各拿一份 token 的那类错配就是这么来的。改成"滤掉旧行 + 追加新行"整份重写，
  # 与 ps1 那份对等实现同一个形状（那边一直是 filter+append，漂移的方向从来是 sh 侧偷懒）。
  # 顺带堵掉另一个洞：旧写法 grep 命中但 sed 失败时会落到 append 分支 ⇒ .env 里两行同名键。
  local tmp="${ENV_FILE}.tmp.$$"
  # 滤旧行改走 awk 的**字面量**前缀比较（键名已经在上面保证不含元字符）。这样"按退出码区分
  # 到底是哪种情况"这件事根本不用做：awk 只会整体成功或整体失败，失败一律走下面那条响亮分支，
  # 没有任何一条路径能留下"一份缺了别的键的 .env"。
  # 顺带说清**不是**理由的理由，免得下一个人以为还漏了哪层保护：原文件最后一行没有换行符时，
  # 换行是会被补上的（实测 GNU grep 3.0 与 gawk 5.0 都补），所以"新键粘到上一行"不是这次改的洞。
  # 真正的洞只有一个：grep 的 exit 1（正常）与 exit ≥2（真报错）被 `||` 分不开。
  # 原文件全程只读 ⇒ 不存在截断窗口；写坏只会发生在 tmp 上，而 tmp 失败就地返回。
  if ! K="${key}=" awk 'BEGIN { p = ENVIRON["K"] } substr($0, 1, length(p)) != p' "$ENV_FILE" >"$tmp"; then
    fail "没能滤掉 ${ENV_FILE} 里旧的 '${key}=' 行（awk 或写临时文件失败）—— 原文件一个字节都没动，新值没写进去"
    rm -f "$tmp"
    return 1
  fi
  if ! printf '%s=%s\n' "$key" "$val" >>"$tmp"; then
    fail "没能把 ${key} 的新值写进 ${tmp}（磁盘满 / 只读？）—— ${ENV_FILE} 保持原样，本次没有改写"
    rm -f "$tmp"
    return 1
  fi
  # mv 失败时把话说响亮：静默 return 0 会让"改写成功"看起来成立，而 .env 里还是旧值
  # （旧写法的 sed -i 失败就是同样地落在 append 分支上，等于把错误吞成了一份重复键）。
  # 返回值现在**有人接**了：两个调用点都 `|| return 1`，见 start_bridge。
  # 写不进去就停下，别带着"进程环境里是新 token、.env 里是旧 token"继续往下 —— 那正是本仓库
  # 在桥 token 上撞过的错配类（容器一路 401、主观题静默降级成人工自检表）。
  # 权限要跟过去：`mv` 落下去的是 **tmp 的 mode**（shell 重定向按 umask 建，通常 0644），
  # 于是这次改写会把人手加固过的 0600 .env 静默降回 0644 —— 而 .env 里是桥 token 与 notebook 的
  # Jupyter token，那个 Jupyter 还是 entrypoint 里 `--allow-root` 起的。有原文件就照抄它的 mode，
  # 首启（上面 firstCreate=1）就按最严的 0600 建。判据用的是那个**在 touch 之前算出来的 flag**，
  # 不是这里的 `[ -f ]` —— touch 已经建过文件，`[ -f ]` 在这一行必然为真，抄它就是把 0600 那支写成死的。
  # 失败不致命（不是所有文件系统都支持 chmod），但要说一句，别让人以为已经加固了。
  # 诚实的边界：Windows/Git Bash 上 chmod 根本不改变 stat 报的 mode（实测 chmod 600 之后仍报 644），
  # 所以这条在宿主上是 best-effort，真效果要到 Linux（容器档）才看得见。
  # 闸门：server/test/regression/env-write-atomicity.test.ts —— 三支都有人管：
  # ① 两句 chmod 在不在（纯文本判据，从 bash 的 describe 里提出来，没有 bash 也会跑）；
  # ② **哪一支真的被调用了**（把 chmod 桩成同名函数打点，NTFS 上也判得动 ⇒ 上一轮缺的就是这条）；
  # ③ 落盘后的实际 mode（只在认 chmod 的文件系统上跑，跳过了会在报告里写出来，并附一条独立对照判据）。
  if [ "$firstCreate" = 1 ]; then
    chmod 600 "$tmp" 2>/dev/null || fail "没能把 ${tmp} 设成 0600（将以默认权限新建 .env）"
  else
    chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || fail "没能把 ${tmp} 的权限对齐 ${ENV_FILE}（将以默认权限改写 .env）"
  fi
  mv "$tmp" "$ENV_FILE" || { fail "没能改写 ${ENV_FILE}（新内容在 ${tmp}，手工合并后删掉它）"; return 1; }
  # 后置条件：写完**读回来对一遍**。mv 返回 0 只证明"这次替换发生了"，不证明 .env 里真是那个值 ——
  # 磁盘满写半截、被别的进程同时改写、值里带换行只落下一行，都是"短了但 rc=0"。
  # 这一道是"静默"那一类的最后一层：本项目在桥 token 上撞过的正是"两份不一致而两边都绿"（WI-86）。
  local got
  got="$(read_env_key "$key")"
  if [ "$got" != "$val" ]; then
    fail "${ENV_FILE} 里读回的 '${key}' 与刚写进去的不一致（读回 ${#got} 字节 / 期望 ${#val} 字节）—— 别再往下跑：检查 ${ENV_FILE} 有没有被别的进程改写、值里是不是带了换行"
    return 1
  fi
}

read_env_token() { read_env_key ARENA_LLM_BRIDGE_TOKEN; }
# 这一句返回的就是 write_env_key 的状态（函数体只有这一条命令）—— 调用方必须接住它。
write_env_token() { write_env_key ARENA_LLM_BRIDGE_TOKEN "$1"; }

# notebook 的 token 与桥同一纪律：唯一来源是 .env（已 gitignore），只在本机之间传递，不进日志。
read_env_jupyter_token() { read_env_key ARENA_JUPYTER_TOKEN; }
write_env_jupyter_token() { write_env_key ARENA_JUPYTER_TOKEN "$1"; }

# apt 镜像站**没有本机的自动默认值**（2026-10-08 撤掉了 `ensure_build_mirror`，评审 I-4）：
# 上一轮把"给这台机器记一份 .env"做成了"每份 clone 第一次构建都自动写 ustc"，那是越界 ——
# 落点决定 apt 的小版本（JDK 17.0.x / MySQL 8.0.x 只按主版本断言钉），于是"别人 clone 出来的镜像
# 里装的是什么"取决于他落在哪个镜像站，与 docker/BUILDINFO.md 的复现性承诺相反；
# 而 `dockerfile-pins.test.ts` 那条漂移闸门只钉 mirrors.sh / Dockerfile / compose 三处默认值，
# 看不见 start.sh 里这第四处。要换源：自己往 gitignored 的 `.env` 里写一行 `MIRROR_APT=…`，
# 或者用 shell 前缀（`MIRROR_APT=… ./start.sh`，优先级更高）。两条都不动被跟踪的文件。
# ⚠ 改这个值的代价：它是 stack 阶段那份 ENV 的一部分（Dockerfile 顶部），其后每一层的缓存键都含它
#   ⇒ 下一次构建是**冷构建**。详见 docker/BUILDINFO.md。
# ⚠ .env 里另有两条 token：这一份文件不许 cat、不许进日志，取值只走 read_env_key/write_env_key。

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
  # 写不进 .env 就停下（`|| return 1`）：继续往下等于"进程环境是新 token、.env 是旧 token"，
  # 而下一次启动读的是 .env ⇒ 桥与容器各拿一份 —— 本仓库在桥 token 上撞过一次（WI-86），
  # 症状是容器一路 401 而主观题静默降级成人工自检表。start_app / up / --rebuild 都把它变成 exit 1，
  # 所以这里失败时 Docker 那几步根本不会被调用。
  write_env_token "$token" || return 1

  # notebook 的 token：**缺了才生成**。每次启动都换一个新 token，而容器还是那个在跑的旧容器
  # （compose up -d 对没变化的服务不会重建），entrypoint 里的 jupyter 与 .env 就会各拿一份 →
  # 打印出来的 URL 打不开，症状和 WI-86 的"桥 token 漂移"是同一类。
  if [ -z "$(read_env_jupyter_token)" ]; then
    write_env_jupyter_token "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)" || return 1
    say "已生成 notebook 的 Jupyter token（.env → ARENA_JUPYTER_TOKEN）"
  fi
  # 以 .env 为准导出：compose 的 ${VAR:-} 插值里进程环境优先于 .env 文件，
  # 留一个陈旧的同名 shell 变量在里面，容器拿到的就不是唯一来源那份了。
  export ARENA_JUPYTER_TOKEN="$(read_env_jupyter_token)"

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

# notebook 的入口要说给人看，但**要说的是事实**：
# ① 不打印 token。旧注释写"token 只打印到终端、不写进任何日志文件"，可整个 run 被重定向
#   （`./start.sh > run.log`、agent 里跑、CI 里跑）时那句话就不成立了 —— 所以链接一律不带 token，
#   要 token 的人自己去 .env 拿（唯一来源那句话本来就写在下面这行里）。
# ② 先探端口再报。"7789 是真的能开"在当前镜像（没重新构建过的机器上是旧版）里每次运行都是假的，
#   而本仓库对这件事早有判据："端口上真正应答的那个进程才是事实"（bridge_probe 的注释）。
#   探测故意不带 token：只要有任何 HTTP 应答就说明 7789 上确实有个进程在听。
#   注意它证明的是"有人在听"，不是"那是 jupyter 且 token 对得上"—— 后者归 Task 7 的 /api/notebook/status。
# ③ 它是**横幅，不是闸门**：探到 000 也只打印一行就 return 0 ⇒ "验证通过"与"用户的链接是死的"
#   可以同时成立（Task 10 实测正是这样，而当时列的那两个原因——缺 token / 旧镜像——都指错了方向，
#   真原因是绑定地址：发布端口 DNAT 到容器 eth0，只听回环等于没发布）。会红的那条在容器档：
#   server/test/notebooks/kernel.test.ts「发布端口的 DNAT 目标上也必须有人在听」。
#   这里按裁决 R4 保持只打印（闸门归测试，横幅不掺和退出码），但第三个原因必须写出来。
# ④ 它给的操作必须是**真能修好这个症状**的那一个（2026-10-08 实测两次，为了确定不是巧合）：
#   镜像变了的时候 ./start.sh 会重建容器、jupyter 跟着回来；镜像**没**变的时候
#   先在容器里把 jupyter 杀掉、再跑 ./start.sh ⇒ `docker compose` 报 **0 行 Recreate**，
#   而宿主 `curl http://127.0.0.1:7789/jupyter/tree` 一直是 000 —— 也就是说**掉进去的 jupyter 靠 ./start.sh 起不回来**，
#     （上面那句里的路径是**现在**该打的那一条；**2026-10-08 那次实测 typed 的是根路径 `/tree`** ——
#     取证：`git show 5f07b24:start.sh` 的 ④ 那一行写的是 `curl http://127.0.0.1:7789/tree`，
#     base_url=/jupyter/ 是 2026-10-09（WI-94 Task 1）才落的，所以别把这两个写法当成同一次测量。
#     000 与路径无关，它说的是"7789 上没人监听"：2026-10-09 实测服务在跑时 `/tree` → 404、
#     `/jupyter/tree` → 302，而打一个没人听的端口（7791）两种写法都是 000 ⇒ 照抄的人看到 404
#     要想的是"前缀打错了"，看到 000 才是这一条说的"进程掉了"。）
#   旧文案那句"必要时 ./start.sh --rebuild"对这个症状是 10-20 分钟的空等（--rebuild 是 --no-cache 冷构建，
#   修的是"镜像里没带 Jupyter"，不是"镜像里有、进程没了"）。真正的补救是换一个**新容器**：
#   `docker compose up -d --force-recreate arena`。
#   ⚠ 那条命令本身还有一个前提（评审 I-4 顺带点出的"死胡同建议"）：它按**现有镜像**换容器，
#   所以镜像若早于「容器内监听从 127.0.0.1 改到 0.0.0.0」那一次修复，force-recreate 完还是 000 ——
#   那一种的顺序是 `./start.sh`（先构建再 up -d，镜像一变 compose 自然按新镜像重建容器），
#   然后才轮到 --force-recreate。文案里这一句必须写出来，否则照建议走完仍然是打不开的链接。
#   这里只报命令、不代你执行：重建容器会带走正在跑的 IDE 调试会话与判题任务，
#   这种副作用该由用户决定什么时候承担（同样理由见本文件不自动 restart 的每一处）。
#   另一件事明确**不在这里做**：给 jupyter 加看门狗/守护循环 —— 那改的是进程生命周期，
#   要单独一条工作项单独评审，不由横幅顺带带出来。
# --dev 不走这里（它不经过 start_app）：dev 服务故意不发布 notebook 端口，
# 打印出来就是个打不开的地址（说假话）。--verify / --ide 走 start_app，会打印 —— 那两个
# 路径起的就是 arena 本身。
report_notebook() {
  local token code
  token="$(read_env_jupyter_token)"
  if [ -z "$token" ]; then
    say "Notebook 未就绪：.env 里没有 ARENA_JUPYTER_TOKEN（./start.sh 首启会生成）"
    return 0
  fi
  # 路径带 `/jupyter/` 前缀（WI-94 Task 1）：jupyter 自己挂在 base_url=/jupyter/ 下，
  # 根路径上的 /login 从此给的是 **404**（实测，2026-10-09：`curl …8888/login` → 404、`…/jupyter/login` → 200；
  # 000 只在"没人监听"时才出现）。所以旧写法不会说"未就绪"，而是走下面那条成功分支、
  # 打印"7789 已应答 HTTP 404"再附一个本就打不开的链接 —— 探活就此形同虚设（假阳性，比假阴性更难发现）。
  # 前缀的真相在 shared/src/notebook.ts，shell 带不回常量 ⇒ 这里写字面量，
  # 由闸门 server/test/regression/notebook-contract.test.ts 按派生值查这两个脚本的文本。
  # start.ps1 是同一套判据的另一个实现，改一边必须改另一边。
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:7789/jupyter/login" 2>/dev/null || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    say "Notebook 未就绪：7789 上没有 HTTP 应答 ⇒ 容器里的 jupyter 没起来（缺 token / 镜像还是没带 Jupyter 的旧版 / 进程跑过但后来掉了），或 jupyter 监听在容器 loopback 上（发布端口打不到：DNAT 的目标是容器的 eth0 地址，不是它的 127.0.0.1）。修法是起一个新容器：docker compose up -d --force-recreate arena（按 ./start.sh 修不了这一种：镜像没变时 compose 报 0 行 Recreate，那个掉掉的 jupyter 不会被起回来 —— 2026-10-08 实测）；--force-recreate 会带走正在跑的 IDE 调试会话与判题任务，所以这条由你决定何时执行，start.sh 不代你做。但这一条只对**镜像里已经带上监听地址修复**的情况有效：镜像若早于 --ServerApp.ip=0.0.0.0 那一次改动，--force-recreate 是按现有镜像换容器，修完还是 000 —— 那种先跑 ./start.sh（它先构建再 up -d，镜像一变 compose 自然按新镜像重建容器），再谈那条 --force-recreate。只有怀疑镜像本身没带 Jupyter 时才值得 ./start.sh --rebuild（10-20 分钟的冷构建）。先跑 ./start.sh --logs 看 entrypoint 那几行分辨是哪一种；容器档那条闸门在 server/test/notebooks/kernel.test.ts（「发布端口的 DNAT 目标上也必须有人在听」）"
    return 0
  fi
  say "Notebook：http://127.0.0.1:7789/jupyter/tree（7789 已应答 HTTP ${code}；token 在 .env 的 ARENA_JUPYTER_TOKEN，页面第五项 Notebook 也能拿到）—— 只打印一次，且不含 token"
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
  report_notebook
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
    report_notebook
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
    # **先起新代码，再验**。`docker compose exec` 进的是**当前跑着的那个容器**，
    # 而容器用的是它被创建时的镜像 —— 所以光 `docker compose build` 都不算，必须 `up -d` 重建容器。
    # 实测踩过：改完代码直接 `./start.sh --verify`，验的是上一个镜像里的源码，
    # 新加的那条闸门"通过"得毫无意义（它压根没看见新文件），而日志看起来跟真的一样。
    start_app || exit 1
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
