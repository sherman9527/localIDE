# Spark on Kubernetes：资源账、失效模型与排障定位（口径题，本机不可真跑）

对应考点：`spark-on-k8s-resources`、`spark-on-k8s-submit-and-identity`、`spark-on-k8s-shuffle-storage`、`spark-on-k8s-operator-multitenancy`
适配难度：senior / principal｜出题形式：`rubric`（+ 少量 `code`，仅限本机可量的那一半，见 §10）
素材来源：用户提供的两份专题（`spark-on-kubernetes.pdf` 67 页 / `kubernetes.pdf` 216 页，2026-10-11）。
**本文件是转述与再组织，不转录原文**（版权不在我们手上，同 `content/questions` 的既有纪律）；
两份专题自己都标注"代码已提供，Docker/kind 集成实测尚未完成"，所以本文件的失效路径同样按**未实测**对待。

---

## 1. 五本资源账：先问"哪一本在管"，再谈调参

一个跑在 K8s 上的 Spark executor 同时受**五套互不换算**的账约束，面试里能把它们一次说清的人不多：

1. **`requests`（调度请求）**：只决定这个 Pod 能不能被调度到某节点、以及别人能不能挤上来。
   它**不是**运行时上限，也不产生节流。
2. **`limits`（运行限制）**：cgroup 的硬边界。内存超了由 **cgroup 杀进程**（K8s 侧表现为
   `OOMKilled`，`restartPolicy` 决定它变不变 Pod Failed），CPU 超了是**节流**（周期配额用完就被压住，
   表现为 task duration 变长而不报错 —— 这一条最常被误读成"数据变多了"）。
3. **JVM heap（`spark.executor.memory`）**：Spark 自己的堆。**它必须小于容器 limit**，
   因为堆之外还有第 4、5 本账。堆满了是 `java.lang.OutOfMemoryError`，
   与 cgroup 的 `OOMKilled` 是两种诊断、两套证据、两种修法。
4. **`memoryOverhead` 与 off-heap**：堆外（netty buffer、Python worker、native、线程栈、部分临时结构）。
   规则随 Spark 版本变（`spark.memory.offHeap.enabled/size` 与 overhead 的默认比例都动过），
   **具体数值以所用小版本文档为准，需核实**；但"heap + overhead + off-heap 必须一起算进 container limit"
   这条不变。提高 heap 会**挤掉** overhead 的余量 —— 这是"我把内存调大了反而更容易被杀"的正解。
5. **Python worker（PySpark 特有）**：pandas/Arrow 的数据在 **Python 进程的 RSS** 里，不在 JVM 堆里。
   `toPandas()` / `pandas_udf` 的峰值是**转换过程中的多份副本**，不是结果的净大小
   （本仓库在 `local[2]` 上实测：2,000,000 行单列 `int64` 净占 16 MB，而进程高水位一次涨了约 550 MB，
   峰值 ≈ 净大小的 35 倍；读的是 `/proc/self/status` 的 `VmHWM`，注意它是**高水位**，`del` 之后不掉）。
   ⇒ 只按 JVM 的指标给 Spark-on-K8s 的 Python 作业估 limits，一定低估。

**一句可判分的口径**：`Pending` 查 requests/节点余量/taint/亲和/PVC；`OOMKilled` 查 cgroup limit 与
heap+overhead+Python 之和；`OutOfMemoryError` 查 heap 与算子；`task duration 变长没有报错` 查 CPU 节流。
四条不许共用一句"内存不够，调大 `spark.executor.memory`"。

## 2. Driver / Executor 的角色与一次提交的生命周期

- `deploy-mode cluster`：driver 在集群里作为一个 Pod 运行，提交端只负责把作业交上去然后退出；
  于是**提交端断开不影响作业**，但作业状态只能从 API/历史服务读，不再是"那个终端窗口"。
  `client` 模式反过来：driver 在提交进程里，日志直观，但提交端成了单点。
  选型维度是**谁承担 driver 的生命周期与网络可达**，不是"哪个方便"。
- 提交 → `SparkApplication`/`spark-submit` 创建 driver Pod → driver 向 API server **申请** executor Pod
  （K8s 后端下 driver 是"申请方"，不是" fork 进程"）→ executor 起来后**回连 driver** 注册
  （REST + RPC 两个端口，历史/度量另有端口）→ stage/task 开始推进。
  ⇒ "Pod 都是 Running 但没有任何 stage"是这一族最典型的形状：先查 executor 能不能连回 driver 的
  RPC 端口与 driver 的服务是否可达，而不是先加内存。
- driver 要能创建/删除 Pod ⇒ 需要**给 driver 一个 ServiceAccount 与最小 RBAC**
  （能对 `pods`、`pods/log`、`services`、`configmaps` 等的命名空间内权限），
  `cluster-admin` 是**把整个集群交给一个作业**，属越权；principal 面试会追问"多租户下你怎么限"。

## 3. 镜像、Python 环境与代码分发

- `--archives` / `--py-files` / `spark.yarn.dist.*` 的家谱在 K8s 下换成
  `--files` / `--archives` / `--py-files` + `local:///` 前缀指容器内已存在的资源。
  **`local:///` 与"从远端复制"语义不同**：前者要求镜像里已经有那个路径，后者是分发。
- **只给 driver 装依赖会失败**：executor Pod 用的是**同一个镜像**，但它不继承 driver 容器里临时的
  `pip install` 结果 —— 任何"运行时装包"的做法都要问一句"装在哪、executor 看得见吗"。
- 镜像 tag 要 pin。`latest` 在 K8s 上叠加 `imagePullPolicy` 与节点缓存，会造成"同样的 YAML，
  不同节点跑出不同解释器/依赖"，这类故障的定位成本极高（本仓库的对应纪律是"镜像按 Dockerfile 重建"，
  同一件事）。
- Python 侧版本与依赖必须**在镜像构建期**确定；`--py-files` 传的是**代码分发**，不是环境。
- 本仓库的一个真实教训可以当例证：notebook kernel 的解释器是 `/opt/arena-ide-env/python/bin/python`
  （IDE 那份 venv），而 `pyarrow` **不在**里面 ⇒ `pandas_udf` 一调用就
  `ImportError: PyArrow >= 4.0.0 must be installed`。**"这个环境里有没有某个包"是可执行事实，
  不能靠记忆** —— 面试答"pandas UDF 比 row UDF 快"之前要先能说清它依赖什么、这台机器上有没有。

## 4. Pod template、配置与安全上下文

- `--conf spark.kubernetes.driver.podTemplateFile=` / `executor.podTemplateFile=`：
  template 与 Spark 生成的容器**合并**，不是替换；`podTemplateContainerName` 决定"我这个
  container 的字段是来**覆盖哪一份**的"。判正确性的唯一办法是**读实际生成的 Pod**
  （`kubectl get pod -o yaml`），不是比对 YAML 文件 —— 两者常常不同。
- 只读根文件系统（`securityContext.readOnlyRootFilesystem: true`）要求把**确实需要写的目录**逐个挂成
  `emptyDir`：Spark 会写临时 shuffle/broadcast/local dirs、Python 可能写 bytecode。
  关掉 bytecode 写入（`PYTHONDONTWRITEBYTECODE=1` / `-B`）就是为了少一处隐式写盘。
- 别把 `spark.kubernetes.*` 的资源值同时写在 YAML 和 spark-submit 里；**冲突时的优先级要背下来是错的**，
  要看生效值。可复现做法是"一处来源 + 生成物落盘核对"。
- 业务 Pod 用非 root、`drop: [ALL]`、`RuntimeDefault` seccomp；本地 kind 节点的宽松权限
  **不能**当作业务负载的基线（专题里明确写了这条边界，本仓库也认）。

## 5. Shuffle、临时盘与 executor 丢失

- shuffle 数据落在 executor 的本地盘；**executor Pod 被删/被抢占 = 它写的 shuffle 分区没了 ⇒ 上游 stage 重算**。
  动态分配（`spark.dynamicAllocation.enabled`）与"缩容即丢 shuffle"是天生矛盾，三档解法：
  ① **ESS sidecar**（每个节点一个 external shuffle service，DS 模式或 sidecar 容器）；
  ② **PVC 承载 shuffle**（Pod 重建后还能读回，代价是卷的生命周期管理与 IO 性能）；
  ③ **远端/服务化 shuffle**（Celeborn 类，把 shuffle 存储与计算彻底分离，弹性最好，多一跳运维）。
  选型维度：作业时长与失败重算的代价、节点弹性、额外网络跳与运维复杂度。
- **`emptyDir` 落在节点盘**，而配 `tmpfs`/medium 的 emptyDir **是内存** —— "把 shuffle 放 tmpfs 换性能"
  花的正是 §1 里那本 container limit 的账，不是免费磁盘。这一条是最常见的自伤优化。
- 磁盘压力与 inode 耗尽会伪装成"随机失败"；定位要看节点 `ephemeral-storage` 与 Pod 的
  `ephemeral-storage requests/limits`，不是只看 Spark 日志。

## 6. 网络、身份与"起不来"的定位顺序

- executor 注册失败先查三件事：driver 的 RPC 端口是否可达（NetworkPolicy / CNI）、
  driver Service 是否建出来、executor 解析到的 driver 地址是不是它自己所在网络的地址
  （跨 namespace / hostNetwork / DNS search 域都会改这个结果）。
- 镜像拉不下来先查 `ImagePullBackOff` 的**事件原文**（secret、tag、仓库可达、节点网络），
  **不要**先动 Spark 内存参数 —— 这是"把三类不同失效读成一类"的典型。
- `kubectl apply` 成功只代表**对象写进 API server**，不代表调度成功、镜像拉到、进程起来、依赖就绪。
  同理 `SparkApplication` 状态 `RUNNING` 只代表 driver 在跑，不代表有 task 在推进。
  声明式系统的通用纪律：**看 status/conditions/events，不看"提交返回码"**。

## 7. 动态分配、Shuffle tracking 与扩缩容

- 动态分配的上下界（`minExecutors`/`maxExecutors`）、`spark.executor.idleTimeout`、
  scheduler backend 的 batch 大小，与 K8s 的扩缩容节奏耦合；配 ClusterAutoscaler 时
  **requests 决定伸缩**，limits 不参与伸缩 ⇒ "把 limits 调大"不会让它多要节点，只会让它更容易被杀。
- 有 shuffle 持久化（§5）才敢激进缩容；没有它，缩容就是把重算概率买回来。
- PDB（PodDisruptionBudget）保护的是**自愿中断**（节点 drain），不保护 OOM/抢占；
  长作业要谈的是 checkpoint 与可重算性，不是"加个 PDB 就稳了"。

## 8. 多租户、调度与成本

- 隔离层次从弱到强：namespace + ResourceQuota + LimitRange → 优先级与 PriorityClass/抢占 →
  独立节点池/taint-toleration/亲和 → 独立集群。取舍是**噪声邻居、成本、运维复杂度、弹性**。
- 队列与公平：Spark 侧没有 YARN 那套 queue，要靠**上层调度器/平台**（自定义 scheduler、
  capacity 隔离、或直接接队列系统）来给"作业排队与优先级"，principal 面试会问
  "K8s 上没有 YARN queue，你的批作业公平性从哪来" —— 答案要落在具体机制上。
- 成本口径：单位是 `$/TB 扫描` 与 `$/作业`，不是 `$/核时`；
  allocatable 要给系统组件与短时并行副本留余量，**不要把 allocatable 全卖给应用**。

## 9. Spark Operator / CRD 与 GitOps

- `spark-submit` 是**命令式**：一次提交一个作业，平台不好回答"当前应有的作业集合"；
  Spark Operator + `SparkApplication` CRD 把它变成**声明式 + 控制器**：期望态、reconcile、重试、
  与 `SparkApplication` 的状态机（NEW/SUBMITTED/RCRUNNING/RUNNING/COMPLETED/FAILED 系列，
  具体集合以所用 operator 版本为准，**需核实**）。
- 迁移要小心的三件事：CRD 版本升级的兼容（operator 与 Spark 版本对不上会出现"提交成功但没 Pod"）、
  image tag 与依赖镜像仓库、以及"作业参数进 YAML"之后的密钥管理（Secret 挂载 vs env，
  不要把长期凭据写进 Git）。
- GitOps 的形状：作业定义在仓库里、由 CD 同步；Spark 应用侧的 driver ServiceAccount 与
  RBAC 也在同一份声明里 review。
- Spark Connect 与 K8s 组合的卖点是"客户端与引擎版本解耦 + 每客户端独立 session"，
  代价是 UDF 必须服务端可加载、不是所有 RDD 路径都等价。

## 10. 本仓库能验到哪一层（诚实版，也是这一族只出 `rubric` 的原因）

在**这台机器 / 这个镜像**里实测过的事实（2026-10-11，容器内 `arena-pyspark` kernel）：

- 容器里**没有任何 K8s 工具链**：`kubectl / kind / k3s / docker / helm` 全部不存在，
  也没有 `/var/run/docker.sock` ⇒ Pod、事件、conditions、`terminationReason` 这些观测面**全都不存在**。
- cgroup 是 **v2**，`/sys/fs/cgroup/memory.max` = `max`（连读三次稳定）⇒ **这个容器没设内存 limit**，
  所以 `OOMKilled` 这条路径在本机不可复现；`memory.events` 里 `oom_kill 0`。
- kernel 是 `local[2]` + `--driver-memory 512m`，实测 `Runtime.maxMemory() = 536,870,912`（恰好 512 MiB），
  而 `availableProcessors() = 16`、`sc.defaultParallelism = 2`
  ⇒ **CPU 那本账在本机也只能"看见"，不能"管"**（这也是 WI-95 记的那笔"第二个 JVM 抢 CPU"的根）。
- 没有 executor 这本账：`spark.conf.get("spark.executor.memory")` 抛异常、
  `sc.getConf()` 里也没有这个键 —— **local 模式下 executor 内存不是"很大"，是"不存在"**。
- `spark.conf.set("spark.driver.memory", …)` 抛 `AnalysisException: [CANNOT_MODIFY_CONFIG]`，
  堆上限一字不变 ⇒ 进程级边界都在启动期锁定，运行时改的是**计划层**（`spark.sql.*`），不是进程层。

⇒ 结论：这一族知识的**判分形式只能是 `rubric` / `llm-rubric`**，与本文开头的既有硬约束
（"Spark JVM 内部机制类题不做真跑判分"）同一口径；能在本机真跑判分的那一小半
（§1 的第 5 本账、§10 全部读数）已经落在教程 `content/notebooks/04-memory-accounts-and-the-boot-time-ceiling.ipynb`
里由 WI-90 那道容器闸门看着。

## 11. Senior / principal 追问清单（答不出第 3 层就还不是 senior）

1. `OOMKilled` 与 `java.lang.OutOfMemoryError` 分别看什么证据？各自的修法为什么会互相误伤？
2. driver 的 RBAC 为什么要最小化？给出"这个作业需要哪些动词与资源"的推导，而不是背 `cluster-admin`。
3. Pod 全是 `Running` 但没有任何 stage 在推进 —— 你的前三步查什么，为什么不是先加内存？
4. `requests` 调大 vs `limits` 调大，对调度、对伸缩、对被杀概率各有什么影响？
5. 动态分配 + shuffle 为什么会互相拆台？三种解法各自的运维代价？
6. 把 shuffle 放 `tmpfs` 省的是什么钱、花的是哪本账？
7. `--py-files` 和"在镜像里装依赖"的分界在哪？只给 driver 装依赖为什么在 executor 上会失败？
8. Spark 的 heap / overhead / off-heap 与 container limit 之间怎么留余量？为什么"heap 调大反而更容易被杀"？
9. operator 模式下 retry/升级怎么不丢状态？CRD 版本与 Spark 版本错配会长成什么样？
10. K8s 上没有 YARN queue，你们的多租户公平性与优先级从哪来？
11. 一份 `apply` 下去，你怎么证明"它真的在跑"而不是"提交成功"？（status / conditions / events 各自说什么）
12. 本机（无集群）你能验证这一族的哪些事实、不能验证哪些？为什么这个分界本身是面试答案的一部分？
