# Jupyter Notebook 运行时（子项目 A）设计

> 交付分两段：**A1** = 镜像里的 Jupyter + PySpark kernel + 第五页入口；**A2** = 交互式 Scala kernel。
> 教程内容（3 篇 senior PySpark notebook）是另一个子系统，见
> `2026-10-05-pyspark-enterprise-notebooks-design.md`（子项目 B）。
> 用户 2026-10-05 拍板：**B 排在 A2 之前**，理由见 §4-C6。

## 1. 现状（实测，不是推测）

| 事实 | 出处 |
| --- | --- |
| 镜像里**没有独立 Spark 发行版**：装的是 `pip3 install pyspark==3.5.5`，`/opt/spark` 与 `/opt/spark-jars` 只是指向 pyspark 包自带 jars 的软链 | `docker/Dockerfile:66`、`:69-74` |
| Scala 侧只有三件套 jar（`scala-compiler/library/reflect`，2.13.16），从 maven.aliyun 拉 | `docker/Dockerfile:18`、`:80-84` |
| 判题矩阵在 3.5.5 上验绿：158 道代码题、pyspark 24 + spark-scala 2，`跳过（栈不可用）0` | 最近一次 `./start.sh --verify`（2026-09-27，`判题矩阵 451 passed / 452 total`） |
| 容器里常驻进程由 entrypoint 拉起（mysqld、redis-server），服务端 `node server/dist/index.js` 是唯一给浏览器的入口，监听 7788 | `docker/entrypoint.sh:65-66`、`compose.yml` |
| 端口闸门判据是"**每一条** published 映射都必须以 `127.0.0.1:` 开头" ⇒ 新增服务默认被管，不需要写新闸门 | `server/test/regression/compose-ports.test.ts:12-17` |
| IDE 的用户依赖环境在命名卷 `/opt/arena-ide-env`（python 是 venv，带 `--system-site-packages`），reset 会删整个目录 | `server/src/ide/env.ts:31`、`server/src/ide/reset.ts`、WI-87 |
| 判题子进程环境是 `{ ...process.env, ...opts.env }`；`ARENA_IDE_ENV_DIR` 已在 `config.ts` 读一次就摘掉（红线一） | `server/src/judge/process.ts:31`、`server/src/config.ts`（WI-87 的 `consumeIdeEnvDir`） |
| 已用端口：7788 主服务、7798 E2E 隔离实例、7799 宿主 CLI 桥（撞上去两边 `llm-rubric` 一起变 false）、5173 vite | `compose.yml`、`dev_verify_workflow.md` |
| 导航现有 4 页：今日挑战 / 题库 / 进度 / 网页 IDE | `web/src/App.tsx:25-28` |

## 2. 已拍板的决定

1. **Spark 只有一份：3.5.5**，不为 notebook 引第二份版本，也不降级（用户选 A）。
2. **Scala 要真交互式 kernel**，不接受"只展示代码"（用户选 B 并明确拒绝退路）；实现路径按 §4-C6 三条依次试，每条一个时间盒。
3. **服务形态**：entrypoint 常驻 + 宿主机 `127.0.0.1:7789:8888`。手机/iPad 访问 notebook 不在考虑范围（用户 2026-10-05 明确）。
4. **token 从 `.env` 读**，首次启动自动生成写入，纪律同 `ARENA_LLM_BRIDGE_TOKEN`。
5. **notebook 的 Python kernel 复用 IDE 的 venv**，不新起第三套环境（用户选 A）—— 于是"IDE 里装的包 notebook 能 import"是设计的一部分，而红线一（判题看不到 venv）不变。
6. **第五页 `/notebook` 只做入口**，不 iframe（用户选 A）。
7. **notebook 与判题各有自己的 warehouse / Derby**（用户认了"隔离是对的"）。

## 3. 架构

```
容器 daily-arena
 ├─ mysqld / redis-server                       （现有）
 ├─ node server/dist/index.js        :7788       （现有）
 └─ jupyter notebook                 0.0.0.0:8888   ← 新增（原稿此处为 127.0.0.1，被 Task 10 实测证伪，见下面那段更正）
      --allow-root
      --ServerApp.ip=0.0.0.0 --ServerApp.allow_remote_access=False --ServerApp.port=8888
      --ServerApp.token=$ARENA_JUPYTER_TOKEN
      --ServerApp.root_dir=/app/data/notebooks
      PATH=/opt/arena-ide-env/python/bin:$PATH          ← 不是装饰，见 §7
宿主机：127.0.0.1:7789:8888

目录
  content/notebooks/*.ipynb    进 git 的预置示例（可 diff，B 子项目的交付物落这里）
  data/notebooks/              实际工作区；启动时"缺失才复制"，绝不覆盖用户改过的
  data/notebook-warehouse/     notebook 专属 Spark warehouse + Derby home
  data/jupyter-token           自动生成的 token（data/ 已在 .gitignore）
```

> **更正（实施时 · Task 10 实测）**：这一节原稿写的是"只听容器内 `127.0.0.1:8888`"，而它与 §2-3 那句
> "宿主机 `127.0.0.1:7789:8888`"**不可能同时成立** —— 发布的端口是 DNAT 到**容器的 eth0 地址**，不是转到容器的
> 回环，于是绑在容器 loopback 上的监听永远打不通 `7789`。实测（容器内，故意不带 token）：`127.0.0.1:8888` → 302、
> `$(hostname -i):8888` → 000、宿主 `127.0.0.1:7789` → 000，**而容器档整轮全绿** —— 因为它每一次探活走的都是
> loopback，那条路当然是通的。⇒ 现在容器内绑 `0.0.0.0:8888`，真正的边界是宿主侧那条 `127.0.0.1:` 绑定（§7-2，
> 闸门 `server/test/regression/compose-ports.test.ts`）加上必填的 token：容器内那句 ip 从来不是边界，它只是手段，
> 而被证明是错的那一种手段。还有一条**必须与它一起钉**的副作用：`jupyter_server` 2.21 把
> `allow_remote_access` 的默认值算成 `not addr.is_loopback` ⇒ 非回环绑定时它自己变成 True，而 `check_host()`
> 第一行就因此整块放过那道防 DNS rebinding 的 Host 守卫（实测 `Host: rebinding.example:7789` 得 302）——
> 所以 `--ServerApp.allow_remote_access=False` 要显式写，判据是 `server/test/notebooks/kernel.test.ts`
> 「Host 守卫在位：rebinding 形状的 Host 被拒（403），而浏览器形状的 Host 照旧放行」（两半各一条断言，
> 破坏性验过：`--ServerApp.local_hostnames=[]` 之下"浏览器形状"那半红、rebinding→403 那半仍绿）。

选 `notebook`（7.x）而不是 JupyterLab：少一套前端产物，练习场景要的是"打开一个 .ipynb 改改重跑"。

## 4. 组件

### C1 镜像层（`docker/Dockerfile`）

- 新增 `pip3 install --no-cache-dir "notebook>=7,<8" "ipykernel>=6,<7" "nbformat>=5.9,<6" "nbclient>=0.8"`。
- **kernelspec 注册到镜像级目录** `/usr/local/share/jupyter/kernels/arena-pyspark/kernel.json`，argv 指向
  `/opt/arena-ide-env/python/bin/python -m ipykernel_launcher`。注册时**不要**用 `--user`、也不要装进 venv。
  为什么不 `ipykernel install` 进 venv：WI-87 的「重置环境」会删掉整个 venv 目录，
  那样一点 reset 就把 notebook 的 kernel 一起删了，而界面不会解释为什么打不开。
- `kernel.json` 的 `env` 里放 `PYSPARK_SUBMIT_ARGS`（Spark 的配置只能走这里或代码里，
  **不是**普通环境变量 —— 写 `spark.sql.warehouse.dir=...` 到 env 里不会有任何效果）：

  ```
  PYSPARK_SUBMIT_ARGS = --conf spark.sql.warehouse.dir=/app/data/notebook-warehouse/wh
                        --conf spark.driver.extraJavaOptions=-Dderby.system.home=/app/data/notebook-warehouse/derby
                        --master local[2] --driver-memory 512m
                        pyspark-shell
  ```

  `pyspark-shell` 这个尾缀是 PySpark 拼 classpath 的约定，缺了它 `--conf` 会被当成应用参数；
  `--master` 必须在这里（不写的话 notebook 第一句 `getOrCreate()` 直接报 "master missing"，
  除非每篇都自己写 `.master(...)` —— 那是把配置散进内容里，两份真相）。
  另外带 `SPARK_LOCAL_IP=127.0.0.1`（不绑回环会撞本机网络策略，判题侧的 spark worker 已经这么设过）。
- 预估 +120~200MB（构建后实测并写回 `docker/BUILDINFO.md`，不许停留在预估）。

### C2 `docker/entrypoint.sh`

起 Jupyter 的方式与 mysqld 一致（后台 + 不阻塞服务端启动），并把 venv 的 bin 前置进它的 `PATH`。
失败要**说出来**：起不来不阻塞服务（做题不受影响），但 `/api/notebook/status` 必须如实报 `running:false` + `reason`。

### C3 `compose.yml`

arena 服务加 `127.0.0.1:7789:8888` 与 `ARENA_JUPYTER_TOKEN`（透传 `${VAR:-}`，与 bridge token 同一形状）；
**e2e 服务不映射这条端口**（教程/探活的测试不依赖真 Jupyter）。

### C4 服务端（新目录 `server/src/notebooks/`）

| 单元 | 职责 | 依赖 |
| --- | --- | --- |
| `seed.ts` | `content/notebooks/*.ipynb` → `data/notebooks/`，只在目标缺失时复制；返回复制了哪几份 | fs |
| `status.ts` | 探 `http://127.0.0.1:8888/api/status`（超时 1.5s）；读 `/api/kernelspecs` 判断 kernel 是否在册；拼给宿主机的 URL | fetch |
| `routes`（挂在 `api/app.ts`） | `GET /api/notebook/status`；`POST /api/notebook/prepare-env`（转调已有的 `ensureIdeEnv`） | 上面两个 |

契约（`shared/src/notebook.ts`，类型只在 shared 写一次，沿用 WI-87 的纪律）：

```jsonc
{ "running": true,
  "url": "http://127.0.0.1:7789/tree",
  // 更正（实施时 · 评审 M-1）：契约里**没有独立的 token 字段** —— token 拼在上面那条 url 的 ?token= 里；"日志里必须剥掉"那条纪律不变（§7-4）
  //   释放判据也**不是**"本机同源"（同源要由 Origin/Host 推，而 Host 是客户端自报的）：判的是内核给的 socket 对端地址
  //   （request.raw.socket.remoteAddress）= 回环，或等于本进程的默认网关（compose 里宿主浏览器经网桥 NAT 进来，对端就是网关而非回环）
  "reason"?: "…",                   // running:false 时必填，说清是"没起"还是"端口不通"
  "kernels": [ { "id": "arena-pyspark", "label": "PySpark 3.5.5", "ready": true },
               { "id": "arena-scala", "label": "Scala (Spark)", "ready": false,
                 "reason": "kernel 未注册" } ],
  "notebooks": [ { "file": "pyspark-csv-ingest.ipynb", "seeded": true } ] }
```

### C5 前端（第五页）

`web/src/pages/Notebook.tsx` + `App.tsx` 导航加第 5 项 + `router.ts` 加 `notebook`。
页面只做三件事：服务状态、两个 sample 的链接、环境未就绪时的「准备环境」按钮。
文案必须包含那句边界：**"notebook 里能读到题库的参考答案文件，这不是安全边界"**（见 §7）。

### C6 A2：Scala kernel（三条路，按顺序，每条一个时间盒）

统一成功判据（达不到就不算过，**不许降级成 markdown 展示**）：
① cell 里能建出 `SparkSession` 并 `show()` 出表格；② **下一个 cell 能引用上一个 cell 定义的变量**；
③ `spark.read` 读 `data/` 下真实文件不炸（classpath 里的 Hadoop client 与 pyspark jars 对得上）。

| 路径 | 做法 | 主要风险 | 时间盒 |
| --- | --- | --- | --- |
| 1 Almond | 构建期 coursier 拉 almond（走 maven.aliyun），kernel classpath 接 `/opt/spark-jars/*` | jar 数近两百，classpath 字符串可能撞 `ARG_MAX`；coursier 取不到包 | 一轮 |
| 2 Toree `0.5.0-preview2` | 下 launcher jar + 给 pyspark 那套软链补一层"发行版布局"假目录 | preview 版无 Spark 3.5/Scala 2.13 官方对齐；升级时没人接 | 一轮 |
| 3 自包薄 kernel | JVM 小程序：实现 Jupyter 的 ZMQ shell 协议，内部转 `scala.tools.nsc.interpreter.IMain`（Spark jars 自带，判题侧早已用这几个 jar 真编译） | 要自己讲协议与重启语义，代码量最大；但不依赖没人维护的发行件 | 一轮 |

三条全失败 ⇒ **停在 A2 并带证据回来重谈形状**，A1/B 的成果不回退、不假装 Scala 已跑通。

## 5. 数据流（一次正常打开）

`点第五页 → GET /api/notebook/status（探 8888 + 读 kernelspecs）→ 页面渲染 → 点 sample →
浏览器跳 http://127.0.0.1:7789/notebooks/xxx.ipynb?token=… → Jupyter 起 kernel：
argv=venv python → import pyspark 命中系统 site-packages（venv 的 --system-site-packages）→
`SparkSession.builder` 用 data/notebook-warehouse → 出结果`

## 6. 错误处理（每态界面与 API 各说什么）

| 态 | status | 页面 |
| --- | --- | --- |
| Jupyter 没起 | `running:false, reason:"服务未运行"` | 灰徽章 + 一句"做题不受影响，notebook 暂时不可用"，不白屏、不 500 |
| 起了但探不到端口 | `running:false, reason:"端口不通"` + 日志留一行 | 同上，但 reason 不同 —— 两种原因修的是不同东西 |
| venv 未建（首次/刚 reset） | `kernels[arena-pyspark].ready:false` | 「准备环境」按钮（走 `POST /api/notebook/prepare-env`，**不在 GET 里建**：GET 会被轮询，重活不能挂在读上） |
| token 缺失 | 服务端生成写入 `data/jupyter-token` 后继续 | 不提示（用户不需要看见它） |
| Scala kernel 未注册 | `kernels[arena-scala].ready:false` + reason | 页面明说"这条还在 A2 阶段"，不显示成可用 |

## 7. 红线与边界

1. **红线一的延伸（这条最容易静默坏）**：notebook 里 `!pip3 install foo` 跑的是 shell，
   shell 的 `PATH` 上默认 `pip3` 是**系统** pip ⇒ 包写进系统 site-packages ⇒ 判题用的正是那个解释器。
   这与 WI-87"把 `pip3 install` 改写成 venv 的 `python -m pip`"是同一件事的另一个入口。
   ⇒ entrypoint 给 Jupyter 进程前置 `PATH=/opt/arena-ide-env/python/bin:$PATH`，并由 §8 的 T2 同时做结构与行为断言。
2. **端口暴露面**：7789 必须 `127.0.0.1:` 开头，`compose-ports` 自动管（不许为平板改判据，WI-78 的决议同样适用于 notebook）。
3. **答案可读不是安全边界**：Jupyter 里 `open('/app/content/questions/...')` 读得到参考答案与 rubric 要点。
   工作目录设在 `data/notebooks` 只是让默认视图干净，**绝对路径读得到**这件事要写在页面与 README 上，
   而不是假装目录隔离解决了它。它不违反 C7（C7 管的是 API 不给答案，容器内部本来就是 root 可读）。
4. **token 不进日志**：与 bridge token 同纪律，`/api/notebook/status` 的响应有测试断言日志行不含 token。
5. **与 WI-87 reset 的交互**：reset 删 venv 后 kernelspec 仍在（镜像级注册），但 argv 指向的解释器暂时不存在
   ⇒ `ready:false` + 按钮恢复，而不是 kernel 启动失败让人猜。

## 8. 测试策略（每条都要写"怎么会红"，并做破坏性验证）

- **T1 契约与接线**：`/api/notebook/status` 的形状、路由注册行必须以 `app.` 开头（WI-87 学到的：
  路由被同行注释吞掉时，切片找字符串的断言照样通过）。
- **T2 红线一延伸**：结构断言 entrypoint 里那行 PATH 前置存在；行为断言在容器里真起 kernel 跑
  `!which pip3` 与 `import sys; print(sys.prefix)`，断言落在 venv。**破坏性**：删掉那行 PATH ⇒ 两条都要红。
- **T3 kernelspec 在册且能扛 reset**：断言 `kernel.json` 在镜像级目录、argv 指 venv；
  reset venv 之后 kernelspec 文件仍在（容器档，跑真的 `resetIdeEnv`）。
- **T4 seed 不覆盖用户改动**：故意改 `data/notebooks/x.ipynb` 的一个 cell，再跑 `seed()`，断言它没被还原。
- **T5 compose**：7789 回环 + e2e 服务不映射该端口 + token 是 `${VAR:-}` 透传形状（只看形状不看值，WI-86 的教训）。
- **T6 前端**：`web/test/notebook.test.tsx` 覆盖 running:false / venv 未就绪 / 正常三态；
  E2E 一条（打隔离实例，只验页面渲染与契约形状，不依赖真 Jupyter）；
  真浏览器一条按 `dev_verify_workflow`：console error 与 warning 均 0、**换一次状态**（手动停掉 Jupyter 再刷页面）、故意停一次。
- **T7 A2 的成功判据**：§4-C6 那三条在容器里真跑（Almond 起 kernel、跨 cell 取变量），失败即停在 A2 并出证据。
- 三档验证：`npm run verify:fast` → `./start.sh --verify`（现在会先 build + up）→ 宿主 `npm run e2e`。
  `verify-coverage` 会把新测试文件要求接线。

## 9. 已知代价

- 镜像 +120~200MB（A1）；A2 若走 Almond 再 +80~150MB 且构建期要能取到 maven 镜像。
- 常驻内存 +200~400MB，即使不用 notebook。
- notebook 与判题各有 warehouse/Derby ⇒ notebook 里建的表 IDE 看不见（刻意的隔离，用户已认）。
- 手机/iPad 打不开 notebook（回环端口的直接后果）。
- A2 的三条路有不确定性：最坏情况是"Scala kernel 做不出来"，那时停在 A2 而不是退化成假交付。

## 10. 明确不做

- 不装 JupyterHub / Enterprise Gateway / 多用户与配额（单机自用，账号体系在需求池里就被否过）。
- 不引第二份 Spark、不降级到 3.4（版本差异作为 B 的**内容**讲，不作为运行时）。
- 不做 notebook 的在线协同、评论、版本历史（git 已经在 `content/notebooks/`）。
- 不把 Jupyter 反代进 7788（WebSocket 反代是另一件事，收益只是"少一次跳转"）。**A1 收尾时这条被重新提起**：
  同源反代 `/jupyter/*` + `--ServerApp.base_url=/jupyter/` + 服务端注入 token 的设计已批准、**未实施**，
  登记为 `HANDOVER.md` WI-94。它的硬前提是 7788 那侧补上 Host 白名单 + `Sec-Fetch-Site` 判据（fail-closed，
  只在这个子树上加）—— 一旦由 7788 注入 token，"谁能打开 7788"就等价于"谁能在容器里执行代码"。
  顺带记一条**等用户点头的开放事实**（它不是 WI-94 的前置，它今天就已经成立）：7788 一条 Host 白名单都没有，
  所以对那张未鉴权的题库做 DNS rebinding 现在就行得通 —— 这一条与 notebook 无关，是 7788 自己的边界。
- 不在 notebook 里做判题/答题闭环（那是 IDE 与做题系统的边界，`ide/boundary.test.ts` 的白名单会拦住）。

## 11. 待实测清单（文档阶段不许假装知道）

这份 spec 里下面几个数是**预估**，实现时必须量出来并把实测值写回本文档与 `docker/BUILDINFO.md`；
量不出来或与设计冲突时，改设计而不是改数字：

> 回填于 A1 收尾（分支 `jupyter-a1`，HEAD `c208524`）。**两行仍是"未测"，那就照写"未测"** ——
> 收尾那几轮不动镜像栈（`--rebuild` 是 10–20 分钟的冷构建，而容器档验的是已经跑着的那个新镜像），
> 没有前后对照就没有数字，编一个进记忆文件比留空更坏。下面每一格的出处都是 `memo.md` 里程碑 BB 的验证表。

| 项 | 现在的说法 | 怎么量 |
| --- | --- | --- |
| 镜像增量 | **未测**（+120~200MB 仍是预估，A2 那一档更没开工）。理由见上面那段：本轮没有做构建前后对照，不拿预估冒充实测量 | 构建前后 `docker images daily-arena` 对比 |
| 常驻内存 | **未测**（+200~400MB 仍是预估）。旁证只有形状性的：容器 `running / healthy`、`FailingStreak:0`，页面开着约 7 分钟不动之后 `GET /api/notebook/status` 仍 200 —— 那说的是"没崩"，不是"占多少 RSS" | 起与不起 Jupyter 两种状态下 `docker stats --no-stream` |
| kernel 启动耗时 | **有数，两条口径**：① 容器档那条 `nbconvert --execute` 跑完整本 smoke（含 `SparkSession` 真起来 + 三行输出落地）**8975ms**（`fcd709b` 那一轮；`c208524` 那一轮整个文件 30 条合计 **8754ms**）。② 真浏览器里点「Restart the kernel and run all cells」到三行输出落进来约 **25s** —— 那是"人等到看见结果"，含模态框确认，**不是**内核冷启动的口径，别把两个数混着用 | 真起一次 `arena-pyspark` kernel，测 `SparkSession` 就绪时间 |
| `/api/notebook/status` 探活超时 1.5s | **实现取 1500ms**（`server/src/notebooks/status.ts:202`，`timeoutMs` 可注入，容器档那条用的是 5s 的 `PROBE_TIMEOUT_MS`）。"轮询会不会把 CPU 吃掉"这一问**在落地形状下没有对象**：第五页不做定时轮询，状态是手动「刷新状态」+「准备环境」完成后重读一次（`web/src/pages/Notebook.tsx:25-27`），所以那个"GET 顺手铺示例"的磁盘 I/O 只随点击发生 —— 计划自查里挂给 Task 10 用数据判的那条，结论是**保持现状**（不改 seed 的落点） | 与 mysqld/redis 那套 probe 同一形状，实测后定；探活不能在页面轮询时把 CPU 吃掉 |
| Almond 的 classpath 会不会撞 `ARG_MAX` | **未测** —— A2（WI-91）没开工，spike 一次都没跑。这一行留在表里就是为了不让下一个人以为已经排过雷 | spike 里 `getconf ARG_MAX` + 实际 kernel.json argv 长度 |
