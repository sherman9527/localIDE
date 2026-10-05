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
  mkdir -p /app/data/notebooks /app/data/notebook-warehouse/wh /app/data/notebook-warehouse/derby

  # 没有 token 就**不起**，而不是起一个无鉴权的：.env 是唯一来源（start.sh 首启生成）。
  # 静默降级成空 token 会让"回环 + 无鉴权"这个本来已经说清楚的例外，再多一个没人知道的口子。
  if [ -z "${ARENA_JUPYTER_TOKEN:-}" ]; then
    log "Jupyter 未启动：缺 ARENA_JUPYTER_TOKEN（用 ./start.sh 启动会自动生成到 .env）"
    return 0
  fi

  # venv 前置到 PATH：notebook 里 `!pip3 install X` 走 shell，命中哪个 pip 由 PATH 决定。
  # 不加这一句包会写进系统 site-packages —— 而判题用的正是那个解释器（红线一延伸，判据见
  # server/test/regression/notebook-env-isolation.test.ts）。必须写在命令之前。
  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \
  jupyter notebook --allow-root --no-browser \
    --ServerApp.ip=127.0.0.1 --ServerApp.port=8888 \
    --ServerApp.token="${ARENA_JUPYTER_TOKEN}" \
    --ServerApp.root_dir=/app/data/notebooks \
    >/var/log/jupyter.log 2>&1 &

  log "Jupyter 已拉起（容器内 127.0.0.1:8888）"
  return 0
}

start_jupyter

# PySpark 判题用的常驻 worker 由 spark-pool 按需拉起，这里只保证目录存在。
mkdir -p /app/data/judge /app/data/spark-warehouse
export ARENA_PORT

log "启动应用：$*"
exec "$@"
