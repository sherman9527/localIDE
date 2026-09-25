# 单镜像承载全部技术栈（需求 场景 6/18：只有一个镜像，各技术栈依赖都装在这里）。
# Docker Hub 直连不通 → 所有 FROM 走 daocloud 前缀（见 docker/mirrors.sh 与 memo.md 实测记录）。
#
# 构建分层可单独复用：
#   docker build -f docker/Dockerfile --target stack -t arena-stack:dev .   # 只装技术栈，便于快速验证
#   docker build -f docker/Dockerfile -t daily-arena:latest .              # 完整镜像
# syntax=docker/dockerfile:1.7

# 仓库要能"clone 下来就把这个系统重建出来"（GitHub 归档的前提），所以 base **按 digest 钉住**：
# tag `22.04` 是会动的（今天 b8b6ee6a…，下个月可能是另一个 point release），digest 不会。
# digest 同时验证过：docker.m.daocloud.io 与 Docker Hub 给的是同一个值（前缀是纯透传镜像）。
# 换 base 的步骤写在 docker/BUILDINFO.md（含"为什么 apt 那层没有逐包钉版本"）。
FROM docker.m.daocloud.io/library/ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02 AS stack

ARG NODE_VERSION=24.10.0
ARG SPARK_VERSION=3.5.5
ARG JUNIT_VERSION=1.11.4
ARG SCALA_VERSION=2.13.16
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    SPARK_HOME=/opt/spark \
    ARENA_HOME=/app

COPY docker/mirrors.sh /usr/local/bin/arena-mirrors
RUN chmod +x /usr/local/bin/arena-mirrors && arena-mirrors apt jammy

# MySQL 8 走 ubuntu 官方包（Debian 无 mysql-server-8.0，MariaDB 语义会误导面试准备 —— design.md D1）。
# **主版本在构建时断言**：apt 那层没逐包钉版本（见 BUILDINFO 的"钉不住什么"），
# 而 MySQL 3.x→8.x、JDK 11→17 这类主版本变化会改判题语义 —— 那必须炸在构建里，
# 不能像 Redis 那次一样静默降级到"四道题的参考解没过"（2026-09-25 实测过那条路有多难读）。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget xz-utils unzip git gnupg procps tzdata locales \
      build-essential \
      openjdk-17-jdk-headless maven \
      python3 python3-pip python3-venv \
      mysql-server redis-server \
      && locale-gen en_US.UTF-8; \
    java -version 2>&1 | head -1 | grep -q 'version "17' \
      || { echo "[arena] JDK 必须是 17（JAVA_HOME 与题目语义都按 17 写）：$(java -version 2>&1 | head -1)"; exit 1; }; \
    /usr/sbin/mysqld --version | grep -q ' Ver 8\.' \
      || { echo "[arena] MySQL 必须是 8.x：$(/usr/sbin/mysqld --version)"; exit 1; }; \
    dpkg -l openjdk-17-jdk-headless mysql-server maven python3 build-essential \
      | awk '/^ii/{print $2" "$3}' > /opt/arena-apt-resolved.txt; \
    cat /opt/arena-apt-resolved.txt

# Node：npmmirror 二进制优先，官方站兜底（需求 通用 7/8）
RUN set -eux; \
    url_cn="https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    url_official="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSL --retry 3 -o /tmp/node.tar.xz "$url_cn" \
      || curl -fsSL --retry 3 -o /tmp/node.tar.xz "$url_official"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    node -v && npm -v

RUN arena-mirrors pip && arena-mirrors maven && arena-mirrors env

# PySpark 自带 Spark jars（含 spark-sql / spark-submit），因此不再单独下载 Spark 发行版。
# pandas 供 DataFrame 断言用；scala-compiler 让 Scala Spark 题也能真跑（配合 PySpark 自带 jars）。
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --no-cache-dir --upgrade pip setuptools wheel \
    && pip3 install --no-cache-dir "pyspark==${SPARK_VERSION}" "pandas>=2.2,<3" \
    && python3 -c "import pyspark, os; print('pyspark', pyspark.__version__)"

ARG SPARK_JARS_DIR=/opt/spark-jars
RUN set -eux; \
    pyspark_dir="$(python3 -c "import os,pyspark;print(os.path.dirname(pyspark.__file__))")"; \
    ln -snf "${pyspark_dir}/jars" "${SPARK_JARS_DIR}"; \
    ln -snf "${pyspark_dir}" /opt/spark; \
    test -x /opt/spark/bin/spark-submit; \
    mkdir -p /opt/junit /opt/scala; \
    curl -fsSL --retry 3 -o /opt/junit/junit-platform-console-standalone.jar \
      "https://maven.aliyun.com/repository/public/org/junit/platform/junit-platform-console-standalone/${JUNIT_VERSION}/junit-platform-console-standalone-${JUNIT_VERSION}.jar" \
      || curl -fsSL --retry 3 -o /opt/junit/junit-platform-console-standalone.jar \
      "https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/${JUNIT_VERSION}/junit-platform-console-standalone-${JUNIT_VERSION}.jar"; \
    for a in scala-compiler scala-library scala-reflect; do \
      curl -fsSL --retry 3 -o "/opt/scala/${a}.jar" \
        "https://maven.aliyun.com/repository/public/org/scala-lang/${a}/${SCALA_VERSION}/${a}-${SCALA_VERSION}.jar"; \
    done; \
    java -version 2>&1 | head -1; \
    ls /opt/junit /opt/scala | head

ENV PATH="${SPARK_HOME}/bin:${SPARK_HOME}/sbin:/opt/junit:${PATH}" \
    SPARK_JARS_DIR=${SPARK_JARS_DIR} \
    SCALA_HOME_DIR=/opt/scala

# Redis 7：**必须**是 7.x。题库里有题用 `XAUTOCLAIM`、`EXPIRE ... GT/LT` 这些 7 才有的命令，
# apt 的 6.0.16 会在判题时报"unknown command"——所以这里**没有"退回 apt"这条兜底**了。
# （2026-09-25 实测：官方源与 tuna 那条路径同时挂掉，旧版静默退回 6.0.16，
# 四道题的参考解当场判不了，而栈健康检查还报 `redis:true`，因为它只 PING。）
# 现在：三个源逐个试，装完再断言版本号；不对就**构建失败**，让"构建出来的东西不一样"这件事当场可见。
ARG REDIS_VERSION=7.2.7
RUN set -eux; \
    got=0; \
    for url in \
      "https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz" \
      "https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz" \
      "https://mirrors.tuna.tsinghua.edu.cn/github-release/redis/redis/v${REDIS_VERSION}/redis-${REDIS_VERSION}.tar.gz"; do \
      if curl -fsSL --retry 3 --connect-timeout 10 -o /tmp/redis.tgz "$url"; then \
        echo "[arena] Redis 源码来自 $url"; got=1; break; \
      fi; \
    done; \
    test "$got" = "1" || { echo "[arena] 取不到 Redis ${REDIS_VERSION} 的任何一份源码，构建终止（不许静默退回 apt 的 6.x）"; exit 1; }; \
    cd /tmp && tar xzf redis.tgz && cd "redis-${REDIS_VERSION}" \
      && make -j"$(nproc)" BUILD_TLS=no MALLOC=libc V=0 >/tmp/redis-build.log 2>&1 \
      && make install PREFIX=/usr/local >>/tmp/redis-build.log 2>&1; \
    cd /; rm -rf /tmp/redis /tmp/redis.tgz; \
    redis-server --version | head -1; \
    redis-server --version | grep -q "v=${REDIS_VERSION%.*}" \
      || { echo "[arena] Redis 版本不对：$(redis-server --version)"; tail -20 /tmp/redis-build.log; exit 1; }

# ---------------- 依赖层：只 COPY manifest，保证改代码不重刷 npm ----------------
FROM stack AS deps
WORKDIR ${ARENA_HOME}
COPY package.json package-lock.json* .npmrc tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY tests/package.json ./tests/
RUN --mount=type=cache,target=/root/.npm npm install

# ---------------- 应用层 ----------------
FROM deps AS app
COPY . .
# 不装 playwright 浏览器：E2E 跑在宿主（见 dev_verify_workflow.md 的三档验证表），
# 镜像里那份 chromium 从来没人用 —— 装了只会让完整构建多花几分钟。
RUN npm run build \
    && mkdir -p data/judge \
    && node -e "require('node:sqlite'); console.log('node:sqlite ok')"

EXPOSE 7788
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:7788/api/health || exit 1
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
