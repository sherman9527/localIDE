# container-runtime Specification

## Purpose
定义运行时的交付形态：一个镜像装下全部技术栈依赖、整套系统跑在本机并把端口映射到本地、所有依赖与数据都留在项目目录内、依赖安装遵循"国内镜像源 → 官方源 → 源码编译"的优先级，并由一条启动脚本拉起游戏。它约束 `docker/`、`compose.yml` 与 `start.sh` / `start.ps1`。

## Requirements

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
仓库 SHALL 提供 `start.sh`（含 `--rebuild` / `--dev` / `--logs` / `--bridge-logs` / `--verify` / `--e2e` / `--status` / `--down`）与 Windows 对等的 `start.ps1`，两者 SHALL 保持**同一套判据**（同一件事在两个脚本里的结论必须一致）。脚本 SHALL 等待 `/api/health` 就绪后打印本机访问地址**与判题栈可用性**。

构建失败时 MUST NOT 继续启动：`docker compose build` 非零就退出。否则"起成功了"跑的却是上一个镜像，
症状是"代码改了没生效"，排查成本远高于一次构建报错。`start.ps1` 尤其要显式查 `$LASTEXITCODE` ——
Windows PowerShell 5.1 里原生命令非零退出**不会**被 `$ErrorActionPreference='Stop'` 拦住。

健康检查通过 MUST NOT 被当作"一切正常"：`llm-rubric:false` 时主观题会静默降级成人工自检表，脚本要把这句警告说出来。
提示"提交前自动校验没生效"时 MUST 同时认两条路（`core.hooksPath=.githooks` 或 `.git/hooks/pre-commit` 存在），
只认前者会对已经接上闸门的仓库天天说假话。

#### Scenario: 就绪等待、地址打印与栈报告
- **WHEN** 首次执行 `./start.sh --rebuild`
- **THEN** 脚本在健康检查通过后打印 `http://localhost:7788` 与 `判题栈：java-junit:true,…`，超时未就绪则以非零码退出并提示 `./start.sh --logs`

#### Scenario: 评分链不可用时必须警告而不是静默
- **WHEN** `/api/health` 返回 `stacks["llm-rubric"] === false`
- **THEN** 脚本用告警色说出"主观题评分链此刻不可用 → 会降级成人工自检表"并指向 `data/llm-bridge.log`

#### Scenario: 构建失败不起旧镜像
- **WHEN** `docker compose build` 以非零码退出
- **THEN** 脚本立即以同一非零码退出，不执行 `up -d`，也不打印"已就绪"
