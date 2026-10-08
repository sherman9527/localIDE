#!/usr/bin/env bash
# 容器内自管 mysqld + redis-server，就绪后再拉起应用（需求 场景 6：只有一个镜像）。
set -uo pipefail

MYSQL_DATADIR="${MYSQL_DATADIR:-/var/lib/mysql}"
ARENA_PORT="${ARENA_PORT:-7788}"

log() { printf '[arena] %s\n' "$*"; }

init_mysql() {
  if [ ! -d "${MYSQL_DATADIR}/mysql" ]; then
    log "MySQL datadir 为空，执行初始化"
    mkdir -p "${MYSQL_DATADIR}"
    chown -R mysql:mysql "${MYSQL_DATADIR}"
    mysqld --initialize-insecure --user=mysql --datadir="${MYSQL_DATADIR}"
  fi
  chown -R mysql:mysql "${MYSQL_DATADIR}" 2>/dev/null || true
}

start_mysql() {
  mkdir -p /var/run/mysqld /var/log/mysql
  chown -R mysql:mysql /var/run/mysqld /var/log/mysql 2>/dev/null || true
  # 重启最常见的失败模式：上一次留下的 socket / pid 还在但进程已经没了 —— mysqld 会因为
  # "socket 已存在"直接退出，外面只看到"MySQL 启动超时"。没人应答时才清，别踢掉活着的实例。
  if ! mysqladmin ping --silent --connect-timeout=2 2>/dev/null; then
    rm -f /var/run/mysqld/mysqld.sock /var/run/mysqld/mysqld.sock.lock "${MYSQL_DATADIR}"/*.pid 2>/dev/null || true
  fi
  (mysqld --user=mysql --datadir="${MYSQL_DATADIR}" --skip-name-resolve \
     --max_connections=200 --performance_schema=OFF >/var/log/mysql/arena.log 2>&1 &)
  # 180s 而不是 60s：容器被 kill 过一次之后 InnoDB 要做崩溃恢复，60s 会把"起得来但慢"误判成"起不来"
  for _ in $(seq 1 180); do
    if mysqladmin ping --silent --connect-timeout=2 2>/dev/null; then
      log "MySQL 就绪"
      mysql -uroot --socket=/var/run/mysqld/mysqld.sock -e \
        "CREATE DATABASE IF NOT EXISTS arena CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  log "MySQL 启动超时（180s），/var/log/mysql/arena.log 末尾："
  tail -n 20 /var/log/mysql/arena.log 2>&1 || true
  return 1
}

start_redis() {
  mkdir -p /var/lib/redis /var/log/redis
  (redis-server --daemonize yes --save '' --appendonly no \
     --dir /var/lib/redis --logfile /var/log/redis/arena.log --port 6379 \
     --maxmemory 512mb --maxmemory-policy allkeys-lru)
  for _ in $(seq 1 30); do
    if redis-cli ping 2>/dev/null | grep -q PONG; then
      log "Redis 就绪"
      return 0
    fi
    sleep 1
  done
  log "Redis 启动超时"
  return 1
}

init_mysql || exit 1
start_mysql || exit 1
start_redis || exit 1

# Jupyter 是"可以不起"的服务：起不来不许拖垮做题与判题（它跟 mysqld/redis 的关键性不同），
# 所以失败只 log 一行，由 /api/notebook/status 如实报 running:false + reason。
start_jupyter() {
  # 没有 token 就**不起**，而不是起一个无鉴权的：.env 是唯一来源（start.sh 首启生成）。
  # 静默降级成空 token 会让"回环 + 无鉴权"这个本来已经说清楚的例外，再多一个没人知道的口子。
  # 顺序有讲究：这道守卫在 mkdir **之前** —— 拿不到 token 的实例（e2e / dev 已不再透传，见
  # compose.yml）连目录都不该在真人的 ./data 里留下，否则"不参与 notebook"的服务还在改人家文件系统。
  if [ -z "${ARENA_JUPYTER_TOKEN:-}" ]; then
    log "Jupyter 未启动：缺 ARENA_JUPYTER_TOKEN（用 ./start.sh 启动会自动生成到 .env）"
    return 0
  fi

  # notebook 的工作区、warehouse、日志都从 ARENA_DATA_DIR 派生，**不写死 /app/data**：
  # WI-40 的隔离纪律是"可写状态全在本实例自己的数据目录里"，notebook 也是可写状态。
  # 写死的话，任何一个真的起了 jupyter 的实例（e2e 挂的是同一个 ./data）就有了一条通往
  # 真人笔记的读写路径 —— 而现有那条隔离判据只 hash data/arena.db-wal，看不见 notebooks。
  local nb_root="${ARENA_DATA_DIR:-/app/data}"
  mkdir -p "${nb_root}/notebooks" "${nb_root}/notebook-warehouse/wh" "${nb_root}/notebook-warehouse/derby"

  # IDE venv 是**懒创建**的：命名卷第一次进来时那个目录是空的。bash 不会为"PATH 上有个不存在
  # 的目录"报错，于是前置静默失效 —— 服务器照样起来、日志照样"已拉起"，而 notebook 里的
  # `!pip3 install` 命中的是系统 pip（=判题用的那个解释器）。这条检查不改变行为，
  # 它只是把这个"看不见的降级"在 Task 10 的行为证据抓到之前，先在人眼前摆一次。
  [ -x "${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin/pip3" ] || log "IDE venv 尚未创建：notebook 里的 pip 会落到系统解释器（与判题同一个）"

  # venv 前置到 PATH：notebook 里 `!pip3 install X` 走 shell，命中哪个 pip 由 PATH 决定。
  # 不加这一句包会写进系统 site-packages —— 而判题用的正是那个解释器（红线一延伸，判据见
  # server/test/regression/notebook-env-isolation.test.ts）。必须写在命令之前。
  # base_url 为什么挂在 jupyter 自己身上，而不是让 7788 那侧的反代去剥前缀（WI-94 Task 1）：
  # jupyter 回话里的资源与跳转是**绝对路径**（`/static/…`、`/api/…`、`/login?next=…`）。代理剥前缀的话，
  # 它发回来的这些链接仍然没有前缀 ⇒ 浏览器把它们打到 7788 自己的树上，与 SPA 的 `/` 和 `/api/*` 直接撞名。
  # 让它自己带前缀，才是"页面里每一个链接生来就在 `/jupyter/` 下面"的写法。
  # ⚠ 这一改是连带的：`start.sh` / `start.ps1` 的探测与横幅、`kernel.test.ts` 的 `/tree` 探针、
  # `status.ts` 的探活与拼链接都跟着它走。前缀的真相只有一份，住在 `shared/src/notebook.ts`
  # （`NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL`）；钉住这一点的闸门是
  # `server/test/regression/notebook-contract.test.ts` 的那三条（值必须等于那个常量，不是"出现过"）。
  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \
  jupyter notebook --allow-root --no-browser \
    --ServerApp.ip=0.0.0.0 --ServerApp.allow_remote_access=False --ServerApp.port=8888 --ServerApp.port_retries=0 \
    --ServerApp.token="${ARENA_JUPYTER_TOKEN}" \
    --ServerApp.root_dir="${nb_root}/notebooks" \
    --ServerApp.base_url=/jupyter/ \
    >"${nb_root}/notebook-server.log" 2>&1 &

  # 为什么 ip 是 0.0.0.0 而不是 127.0.0.1（Task 10 实测到的缺陷，不是推理）：
  # 发布的端口是 **DNAT 到容器的 eth0 地址**（compose 那条 127.0.0.1:7789:8888 把宿主的请求转给
  # 172.18.0.x:8888），**不是**转到容器的回环 —— 于是监听在容器 loopback 上的 jupyter
  # 永远打不通发布端口：容器里 curl 127.0.0.1:8888 得 302（**当时的实测** —— DNAT 那一轮 base_url 还没落地，
  # 根路径就是 jupyter 的树；**现在**它挂在 base_url=/jupyter/ 下，根路径给 404，要复现这条得打
  # `curl 127.0.0.1:8888/jupyter/tree` —— 2026-10-09 容器与宿主两侧实测：/login → 404、/jupyter/login → 200、
  # /tree → 404、/jupyter/tree → 302，另外 /api/status → 404 而 /jupyter/api/status → 403（不带 token 时
  # 前缀活着、鉴权层还在说话）），curl $(hostname -i):8888 得 000，
  # 宿主上 7789 也是 000，而容器档全绿（它的判据全走回环）。
  # ⚠ 加这段年代标记的理由（评审 M-1）：不是把实测记录改没 —— 那三个值是那次 DNAT 实验的证据，
  # 改没了它就变成猜测；只是给它们标"属于哪一天"，免得下一个照抄的人把 404 读成"DNAT 又坏了"
  # （那条误读通向 --force-recreate / --rebuild 这种 10-20 分钟的空等）。
  # 闸门：server/test/notebooks/kernel.test.ts 那条「发布端口的 DNAT 目标上也必须有人在听」
  # —— 它是这次唯一会红的东西；start.sh 的横幅只打印不判红，不算闸门。
  # 真正的边界从来不在这个 ip 上，下面两道一条都没放松：
  # ① 宿主侧只绑回环 127.0.0.1:7789（闸门 server/test/regression/compose-ports.test.ts
  #    与 notebook-compose.test.ts ①）⇒ 局域网里别的机器照样打不到；
  # ② token 必填（上面那道守卫：拿不到 token 干脆不起）。
  # 残余风险照实写：bind 到 0.0.0.0 之后，**compose 网桥上的同伴服务**（dev / tools / e2e，
  # 以及任何挂进这张网络的容器）能路由到 8888 —— 但它们必须拿到 token 才能做任何事，
  # 而同伴跑的是同一个镜像、同一个 .env、同一个信任级；这道口子换来的是"用户真能点开链接"。
  # 附带一条 jupyter 自己的行为（实测 jupyter_server 2.21.1 的源码，不是推理）：
  # serverapp.py 的 `@default("allow_remote_access")` 写的是 `return not addr.is_loopback` ——
  # **ip 一绑到非回环，它自己就把这个默认值算成 True**，而 base/handlers.py 的 check_host()
  # 第一行就是 `if settings["allow_remote_access"]: return True` ⇒ 那道防 DNS rebinding 的
  # Host 头守卫整块关闭（实测改之前：`Host: rebinding.example:7789` 得到 302，也就是照收）。
  # 于是 --ServerApp.ip=0.0.0.0 与"守卫关掉"是同一次改动的两面，只钉 ip 那一面不够，
  # 这里必须**显式写 False** 才把守卫留得住。
  # "宿主侧只绑 127.0.0.1:7789"（compose-ports.test.ts 钉着）替不了它：那条限的是**谁能路由到这里**，
  # 而 rebinding 攻击里"到这里"的是受害者自己的浏览器 —— 恶意页面先把域名解析到自己服务器、
  # 读完之后再改成 127.0.0.1，同源检查拦不住改解析；token 登录之后 jupyter 靠 cookie 认后续请求，
  # cookie 会跟着这些请求发到 127.0.0.1，所以"不用 token 也能干活"这条路是通的，
  # 唯一还认得出"这个 Host 不是本机"的就是这一道。
  # 代价（照实说，也照实测）：容器**自己的 eth0 地址**上的请求现在拿 403（那个 IP 不是回环）。
  # 那不影响功能：宿主浏览器的请求进来之后 Host 是 127.0.0.1:7789 或 localhost:7789，
  # check_host() 先摘端口再按 ipaddress 判 is_loopback ⇒ 用户那条路照旧 302/200；
  # 而可达性那条闸门（kernel.test.ts「DNAT 目标上也必须有人在听」）判的是"有没有真实 HTTP 应答"，
  # 403 恰恰证明包转到了、有 jupyter 在按 Host 做决定 —— 不许为了让那条闸门显示 302 把它松回去。
  # 闸门：kernel.test.ts「Host 守卫在位」（行为终判）+ notebook-contract.test.ts（静态前身，宿主档就红）。

  # port_retries=0：8888 被占时 jupyter 默认会**换个端口**继续起（8889），而宿主映射钉的是
  # 7789:8888 —— 静默换端口等于那条映射变成死的，日志却照样"已拉起"。宁可让它起不来并报错。
  # 日志落在数据目录里（不是 /var/log）：./start.sh --logs 只看 compose 的 stdout，
  # 而 jupyter 自己的输出要能在宿主 data/ 下直接翻到。
  log "Jupyter 已拉起（监听 0.0.0.0:8888 ⇒ 宿主 127.0.0.1:7789 那条 DNAT 的目标是**本容器的 eth0**，不是它的回环；日志 ${nb_root}/notebook-server.log）"
  return 0
}

start_jupyter

# PySpark 判题用的常驻 worker 由 spark-pool 按需拉起，这里只保证目录存在。
mkdir -p /app/data/judge /app/data/spark-warehouse
export ARENA_PORT

log "启动应用：$*"
exec "$@"
