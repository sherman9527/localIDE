## ADDED Requirements

### Requirement: 单镜像多技术栈运行时（场景 6/14/18）
系统 SHALL 由**一个** Dockerfile 构建出可同时执行 Node/TS、Java+JUnit5、Python+PySpark、MySQL 8、Redis 的镜像（基础镜像走 `docker.m.daocloud.io` 前缀，因 Docker Hub 直连不通）；容器启动时 SHALL 自行拉起 `mysqld` 与 `redis-server` 并等待就绪，再启动应用。所有技术栈依赖 MUST 装进该镜像，MUST NOT 引入第二个业务镜像或 DinD。

#### Scenario: 一条命令完成构建与启动
- **WHEN** 执行 `./start.sh`
- **THEN** 容器 `daily-arena` 起来，`curl -s localhost:7788/api/health` 返回 `{ok:true, stacks:{java:true,react:true,mysql:true,redis:true,pyspark:true}}`

#### Scenario: 缺失技术栈显式上报
- **WHEN** PySpark 因镜像构建失败不可用
- **THEN** `/api/health` 返回 `stacks.pyspark:false` 且今日挑战页把 big-data 类别标记为"暂不可判分"，而不是静默失败

### Requirement: 本机自包含与端口映射（通用 7/8/9、场景 14）
项目 SHALL 只把产物落在仓库目录内（构建上下文、`./data`、判题工作区、镜像缓存挂载），并 SHALL 通过 compose 把容器 7788 端口映射到本机；SHALL NOT 依赖宿主机已装 Node/Java/Python 版本即可运行（宿主机只需 Docker）。

#### Scenario: 数据落在仓库内
- **WHEN** 在容器内作答产生 SQLite 与判题临时目录
- **THEN** 文件出现在本机 `./data/`（被 git 忽略），仓库外无新增文件

### Requirement: 依赖源优先级（通用 7/8）
`docker/mirrors.sh` SHALL 集中写入 npm→`registry.npmmirror.com`、pip→`pypi.tuna.tsinghua.edu.cn`、apt→`mirrors.aliyun.com`、maven→`maven.aliyun.com`、Node 二进制→npmmirror、Playwright 浏览器→npmmirror 镜像；每个源 MUST 有官方源兜底分支，两者优先级失败时才允许源码编译路径，并在 `memo.md` 记录。

#### Scenario: 国内源失败时回落官方源
- **WHEN** npmmirror 下载 Node 二进制失败（curl 非零）
- **THEN** Dockerfile 的 `||` 分支改从 `nodejs.org` 下载，构建仍成功

### Requirement: 游戏启动脚本（场景 20）
仓库 SHALL 提供 `start.sh`（含 `--rebuild` / `--logs` / `--down`）与 Windows 对等的 `start.ps1`，脚本 SHALL 等待 `/api/health` 就绪后打印本机访问地址。

#### Scenario: 就绪等待与地址打印
- **WHEN** 首次执行 `./start.sh --rebuild`
- **THEN** 脚本在健康检查通过后打印 `http://localhost:7788`，超时 180s 未就绪则以非零码退出并提示 `./start.sh --logs`
