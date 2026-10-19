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
# apt 源是唯一"不改被跟踪文件就换不了"的外部依赖：mirrors.aliyun.com 对 jammy 整片 pocket 回 403（这台机器/IP 侧的条件，不是仓库坏了）时，--build-arg 指到可用的站就能构建，默认值与 docker/mirrors.sh:10 同值 ⇒ 不传它构建结果一字不差。写成 ENV 而不是只留 ARG：本层两处 arena-mirrors（apt / pip+maven+env）都从环境读它，而 ARG 出了本 stage 就没了、ENV 才会随 deps/app 继承下去。
ARG MIRROR_APT=http://mirrors.aliyun.com
ENV MIRROR_APT=${MIRROR_APT}
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
         "notebook>=7,<8" "ipykernel>=6,<7" "nbformat>=5.9,<6" "nbclient>=0.8" \
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

# ---------------- WI-91b 交付（路径 B：Apache Toree Scala kernel；探索档是 WI-91）----------------
# 位置与路径 A 那块同理（也排在 Redis 源码构建之后）：动这一块只作废它自己和下游的 manifest/app 层。
# （路径 A **未落地**：仓库里没有 scripts/fetch-almond.sh、没有 arena-scala-almond kernelspec，别找；
#  "A 那块/同形"指探索档 .superpowers/sdd/2026-10-10-scala-jupyter-kernel-spike-wi91/path-A-almond/，
#  该目录不被 git 跟踪、别的 clone 上未必有。本块是当前唯一的 Scala kernel 取件块。）
# ARG 写在紧邻位置而不是文件顶部：dockerfile-pins 那条闸门扫的是"每个 ARG 都有默认值"，与位置无关，
# 而顶部那几行 ARG/ENV 一动就把 apt/pip/maven/Redis 那几层缓存全作废（见 BUILDINFO.md 第 4 条事实）。
# 取件与校验的**真相在 scripts/fetch-toree.sh + docker-cache/toree/<版本>/toree-artifacts.tsv**：
# Toree 不走 GitHub Releases（api.github.com 那条 latest 返回 tag_name=null），走 Apache dist 的目录形状；
# 制品本身就一个 26MB 的 sbt-assembly fat jar（依赖烤在里面，Spark 是 provided 不含），所以这里不像路径 A
# 那样解 93 个 jar 的闭包，而是"下一份 tar + 只取清单里那一个成员"。
# jar 载荷不进构建上下文（.dockerignore 排掉了 docker-cache/toree/*/{payload,download-cache}），
# 与 apt / pip / maven / Redis 源码 / junit jar 同一前提（构建要有网），摘要钉死（dist 行 sha512+sha256、
# extract 行 sha256）让结果与源是谁、与缓存是否存在无关。构建侧的缓存是 BuildKit mount（机器本地、可被
# prune），不是工作树里的 payload/ 与 download-cache/ —— 详见 docker/BUILDINFO.md「Toree 的可复现取件」。
ARG TOREE_VERSION=0.5.0-incubating
COPY scripts/fetch-toree.sh /usr/local/bin/arena-fetch-toree
# 这一行的源路径带 ${TOREE_VERSION}：换版本要**同时**有 docker-cache/toree/<新版本>/toree-artifacts.tsv，
# 否则 COPY 在这里就失败（"清单不存在"比"悄悄用旧清单装出半个 kernel"好读得多）。
COPY docker-cache/toree/${TOREE_VERSION}/toree-artifacts.tsv /usr/local/share/arena-toree/toree-artifacts.tsv
RUN --mount=type=cache,target=/root/.cache/toree \
    set -eux; \
    chmod +x /usr/local/bin/arena-fetch-toree; \
    /usr/local/bin/arena-fetch-toree \
      --version "${TOREE_VERSION}" \
      --manifest /usr/local/share/arena-toree/toree-artifacts.tsv \
      --dest /opt/toree \
      --cache "/root/.cache/toree/${TOREE_VERSION}"; \
    test -s "/opt/toree/lib/toree-assembly-${TOREE_VERSION}.jar" \
      || { echo "[arena] /opt/toree/lib 里没有 toree-assembly-${TOREE_VERSION}.jar ⇒ 清单齐了但主制品没落盘，kernel 一定起不来"; exit 1; }; \
    java -cp "/opt/spark/jars/*:/opt/toree/lib/toree-assembly-${TOREE_VERSION}.jar" org.apache.toree.Main --help >/dev/null \
      || { echo "[arena] java -cp /opt/spark/jars/* + toree-assembly 起不了 org.apache.toree.Main ⇒ 这条类路径与镜像里的 Spark 3.5.5 撞了（--help 不需要连接文件，退 0 就证明装配得起来）"; exit 1; }

# 上面那条 java … --help 不是"看着像就行"的形状检查：它**真的**用镜像里的 java 与镜像里那两条类路径起一次
# Toree 的 Main（--help 不建 SparkContext、不绑 socket，退 0 就说明 fat jar 与 /opt/spark/jars 拼得起来）。
# 为什么值得单独一条断言：2026-10-10 实测这条 kernel 的两种坏法（缺 --add-opens 的 InaccessibleObjectException、
# 类路径混版的 NoClassDefFoundError）都发生在用户点开 notebook 之后，而构建期这两秒就能抓到第一类的一半。

# kernel 的解释器是 venv（IDE 那份），但 kernelspec 本体必须在镜像级目录：
# venv 会被 IDE 的「重置环境」整个删掉（server/src/ide/reset.ts），装在里面等于让用户一键删掉 kernel。
# 这两行刻意放在 stack 段**末尾**（Redis 源码构建之后）：改 kernel.json 只重建它自己和下游
# manifest 层，不必重跑上面几分钟的 Redis make —— deps 段 npm install 有 cache mount，重建也便宜。
# 自检按本文件惯例带具体原因（对齐 :42-45/:114/:120-121 的 `|| { echo; exit 1; }` 形状），
# 三种故障要能读出三种差别：文件没 COPY 到 / jupyter 跑不动（stderr 直接进消息）/ jupyter 看不见这个 kernel。
COPY docker/jupyter/kernels/arena-pyspark/kernel.json /usr/local/share/jupyter/kernels/arena-pyspark/kernel.json
# arena-scala-toree（探索胜出路径 B，WI-91b 接入）。它**已登记**进 shared/src/notebook.ts 的
# NOTEBOOK_KERNELS（Task 3，needsVenv:false —— 解释器是镜像里的 java，IDE 那份 venv 在不在与它无关），
# status.ts 的 allow-list 按注册表放行它：页面 kernel 表与 Jupyter 选择器里都看得见、选得到，
# 容器档每次交付验证真跑它（server/test/notebooks/scala-kernel.test.ts 独立阶段）。
# 红线①与登记无关且照旧成立：exec/** 一行都不引用 toree，下面那条 kernelspec list 自检只判
# "jupyter 看不看得见它"，不判判题侧（判题 JVM 与 kernel JVM 是两个互不经过的进程）。
COPY docker/jupyter/kernels/arena-scala-toree/kernel.json /usr/local/share/jupyter/kernels/arena-scala-toree/kernel.json
RUN test -s /usr/local/share/jupyter/kernels/arena-pyspark/kernel.json \
      || { echo "[arena] kernel.json 没出现在镜像级 kernels 目录（COPY 行被删或路径写错？）"; exit 1; }; \
    test -s /usr/local/share/jupyter/kernels/arena-scala-toree/kernel.json \
      || { echo "[arena] arena-scala-toree 的 kernel.json 没进镜像级 kernels 目录"; exit 1; }; \
    python3 -c "import json,sys; [json.load(open(p)) for p in sys.argv[1:]]" \
      /usr/local/share/jupyter/kernels/arena-pyspark/kernel.json \
      /usr/local/share/jupyter/kernels/arena-scala-toree/kernel.json \
      || { echo "[arena] kernel.json 不是合法 JSON ⇒ jupyter kernelspec list 会整条命令报错，不是只少一个 kernel"; exit 1; }; \
    cp_val="$(tr -d "\n\r" < /usr/local/share/jupyter/kernels/arena-scala-toree/kernel.json | grep -o "\"-cp\", *\"[^\"]*\"" | head -1)"; \
    test -n "$cp_val" \
      || { echo "[arena] 读不到 arena-scala-toree 的 -cp 那一项（空读数）⇒ argv 的写法变了或者文件不对。闸门不许把\"没读到\"当成\"通过\"：本档第一版就是这么把一条一行都没读到的 grep 打印成\"过\"的（2026-10-10 破坏性验证抓出来的）"; exit 1; }; \
    cp_val="$(printf "%s" "$cp_val" | sed -e "s/^.*, *\"//" -e "s/\"$//")"; \
    case "$cp_val" in "/opt/spark/jars/*:"*) ;; *) echo "[arena] arena-scala-toree 的 -cp 读到的是「${cp_val}」，不是以 /opt/spark/jars/*: 开头 ⇒ toree-assembly 里那份 Scala 2.12.15 会盖掉 Spark 3.5.5 的 2.12.18。fat jar 里的 scala/** 类删不掉，所以『同名 artifact 让 Spark 那份赢』这条纪律在这里只剩类路径顺序这一个表达方式，而混版的症状是 NoClassDefFoundError 而不是一个能读的报错。与 scripts/fetch-toree.sh 的 GATE 3 判的是同一件事（脚本那一份在宿主读得到、构建期读不到 kernel.json，这一份反过来）"; exit 1 ;; esac; \
    ks_list="$(jupyter kernelspec list 2>&1)" \
      || { echo "[arena] jupyter kernelspec list 跑不动（jupyter 未安装或不在 PATH？），stderr+stdout：${ks_list}"; exit 1; }; \
    echo "${ks_list}" | grep -q arena-pyspark \
      || { echo "[arena] jupyter kernelspec list 里没有 arena-pyspark，输出：${ks_list}"; exit 1; }; \
    echo "${ks_list}" | grep -q arena-scala-toree \
      || { echo "[arena] jupyter 看不见 arena-scala-toree kernel（已登记的 Scala kernel），kernelspec list 输出：${ks_list}"; exit 1; }

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

# 题库"只增不减"（硬约束 C5）的**容器可用基线**（N-18）。上一版 scripts/check-bank.mjs 只认 git 跟踪数，
# 而 `.dockerignore` 排掉了 `.git` ⇒ 交付档里 trackedQuestions() 返回 null、退到 gitignored 的 .bank-count、
# 那个也不在镜像里 ⇒ baseline=0 ⇒ 这条闸门在容器里一行都不判，而 verify.sh 的阶段名还写着"基线取 git 跟踪数"。
# 现在把**构建期这棵 content 树的题数**烤进镜像（与 /opt/arena-apt-resolved.txt 同一族做法：把构建期事实留在镜像里）。
# 运行期 content 是 bind-mount ⇒ "比构建时少"照样判得住。排除的三个文件名必须与 check-bank.mjs 的
# NON_QUESTION_FILES 一致 —— 这条一致性由 server/test/regression/bank-baseline.test.ts 判住，不许两边各改各的。
RUN find /app/content/questions -type f -name '*.json' \
        ! -name hidden.json ! -name schema.json ! -name package.json | wc -l > /opt/arena-bank-baseline.txt \
    && cat /opt/arena-bank-baseline.txt

EXPOSE 7788
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:7788/api/health || exit 1
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
