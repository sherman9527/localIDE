# 镜像的可复现构建（GitHub 归档的前提）

> 这份文件回答一个问题：**别人（或半年后的我）clone 这个仓库，能不能把跑着它的容器重建出来。**
> 结论先说：能，但**不是"字节级相同"**，而且这里刻意不追求字节级 —— 原因写在下面"钉不住什么"。

## 重建

```bash
./start.sh --rebuild          # 等价 docker build --no-cache -f docker/Dockerfile -t daily-arena:0.1 .
```

实测耗时（2026-09-25，本机）：**约 9–10 分钟**。大头是 apt 全量拉包 + `pyspark` 的
317MB 源码轮子现编。`--rebuild` 是 `--no-cache`，所以每次都是完整重建（慢，但这正是要的效果：
不带缓存地证明这份 Dockerfile 现在也能构建）。

网络前提：Docker Hub 与 `download.redis.io` 直连不通，所以 base 走 `docker.m.daocloud.io` 前缀、
apt/pip/maven 走 `docker/mirrors.sh` 配的国内源。换网络环境时这些前缀可能要改，
但**改前缀不影响 digest**（镜像是透传的，验证过 daocloud 与 Docker Hub 给同一个 digest）。

## 钉住了什么

| 依赖 | 钉法 | 当前值 |
| --- | --- | --- |
| base 镜像 | **按 digest**（`FROM …@sha256:`） | `ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02` |
| Node | `ARG NODE_VERSION`（精确版本，二进制下载） | 24.10.0 |
| PySpark / 自带 Spark jars | `ARG SPARK_VERSION`（`pip install ==`） | 3.5.5 |
| JUnit 控制台 standalone jar | `ARG JUNIT_VERSION`（URL 里带版本） | 1.11.4 |
| Scala 编译器三件套 | `ARG SCALA_VERSION`（URL 里带版本） | 2.13.16 |
| Redis | `ARG REDIS_VERSION` + **构建后断言版本号** | 7.2.7（不是 7.x 就构建失败） |
| JDK / MySQL | **主版本断言**（apt 点版本不钉，见下） | 17.0.20 / 8.0.46 |
| npm 依赖 | `package-lock.json`（仓库跟踪） | — |
| apt 镜像站 | `ARG MIRROR_APT`（唯一"不改被跟踪文件就换不了"的那层；shell env > `.env` > 这里的默认值，闸门 `dockerfile-pins.test.ts` 钉三处默认值一致） | 默认 `http://mirrors.aliyun.com` |

**换这个镜像站时的两条事实**（都是实测，不是规矩）：

1. 值要写 `http://`，不是 `https://`。钉住的 `ubuntu:22.04` 基座里**没有 CA 证书包**
   （`ca-certificates` 正是这一层 apt 才装上的），走 https 时 `apt-get update` 会**退出 0 而一个列表都没拿到**，
   紧跟着整层报 `E: Unable to locate package tzdata/locales/...` —— `docker/mirrors.sh:6-9` 记的就是第一次这样炸的现场。
2. 改这个值 = **冷构建**。它在 stack 阶段顶部被写成 `ENV`（`docker/Dockerfile:20-21`），
   其后每一层的缓存键都含它，所以换一次源就要重跑 apt、pip、maven、Redis 源码编译与 notebook 安装（本机 9–10 分钟）。

本机（aliyun 对 jammy 整片 pocket 回 403，是网络侧条件不是仓库坏了）把可用的那一个记在**gitignored 的 `.env`** 里
（`MIRROR_APT=http://mirrors.ustc.edu.cn`），所以裸 `./start.sh` 与带前缀的那条走的是同一个值 ——
旋钮记在人脑里等于没记，这是上一轮 `./start.sh` 单独不可用的原因。那一行由 `start.sh` 的
`ensure_build_mirror` 在第一次构建前写进去（已存在就不抢），要临时换源仍然可以用 shell 前缀，它优先级更高。

## 钉不住什么，以及为什么不硬钉

**apt 的包只钉主版本，不钉点版本。** 把 `mysql-server=8.0.46-0ubuntu0.22.04.4` 写死看起来更"可复现"，
实际效果是**几周后构建自己失败** —— Ubuntu 的 `-updates` 池只保留较新的点版本，旧的那个会被撤下，
届时要么切 `old-releases`、要么改版本号，而这两种都不会有人记得做。
所以这里选的是：**能变的让它变，但变了会改变判题语义的那些（JDK 17 / MySQL 8 / Redis 7）在构建时断言**。

这条取舍不是纸上推演，是 2026-09-25 撞出来的：那次重建 `download.redis.io` 与镜像站的 Redis 7
源码路径同时挂掉，而旧 Dockerfile 写着"下载或编译失败就退回 apt 版本，不阻塞构建"——
于是镜像静默拿到 apt 的 **Redis 6.0.16**，`/api/health` 照样报 `redis:true`（它只 PING），
四道用 `XAUTOCLAIM` / `EXPIRE … GT` 的题一路判到"参考解没过"才炸。
⇒ 现在：Redis 拿不到源码就**构建失败**；三个源逐个试；判题栈探测也改成"版本不对就是不可用"
（`server/src/exec/redis.ts` 的 `redisMajorIsUsable`，`server/test/regression/dockerfile-pins.test.ts` 钉住这些断言不许被删）。

构建时解析出的 apt 版本会写进镜像里的 **`/opt/arena-apt-resolved.txt`**（`docker run --rm daily-arena:0.1 cat /opt/arena-apt-resolved.txt`），
所以"这次构建到底装了什么"是可查的，不用猜。

## 换 base 或升主版本时要做的事

1. 取新 digest：`docker pull docker.m.daocloud.io/library/ubuntu:22.04 && docker images --digests | grep ubuntu`；
2. 改 `docker/Dockerfile` 第一行的 `@sha256:…`（**tag 也留着**，读的人要知道这是哪个 release）；
3. `./start.sh --rebuild` → `./start.sh --verify`（判题矩阵必须 `0 skipped`）；
4. 更新本文件的表格与 `docker/BUILDINFO` 里那行 digest（有测试比对两者是否一致）。

## 想要"字节级可恢复"的话

仓库里不放镜像字节（2.27GB，且 GitHub 单文件 100MB 上限）。真要留一份现场，
用发布资产而不是 registry：`docker save daily-arena:0.1 | gzip > arena-<git-sha>.tar.gz`（约 0.9GB）
挂到一个 GitHub Release 上。那是**备份**，不是**复现** —— 复现靠上面这套，备份靠它。
