# IDE 依赖环境设计：命令窗口 + 用户包清单 + reset

日期：2026-09-26 ｜ 状态：待评审 ｜ 范围：**只谈网页 IDE，不碰判题器与题库契约**

## 1. 问题与现状（实测，不是推测）

IDE 现在只支持"镜像预装"，没有任何"依赖"这个概念：

| 事实 | 出处 |
| --- | --- |
| python 一次性运行是 `python3 main.py`，无 venv、无 `PYTHONPATH` | `server/src/ide/languages.ts:235`；`PYTHONPATH` 全仓零命中 |
| java 编译**完全没有 `-cp`**（`javac -encoding UTF-8 Main.java`），运行时只有 `-cp .` | `languages.ts:249-250` |
| 判题侧的 java 却有 `-cp config.junitJar` ⇒ **同一道题 IDE 里 import org.junit 编译不过、交上去能过** | `server/src/judge/runners/java-junit.ts:102-103` |
| node 沙箱建在 `<data>/judge/ide-*`，向上逐级查找命中 `/app/node_modules` ⇒ `require('react')` **碰巧能过**，没人设计过也没人保证 | `server/src/config.ts:42` + `languages.ts:263-265` |
| 镜像里 pip 只装了 `pyspark` + `pandas`；装了 maven 但**没有任何 runner 调用 mvn**；`--packages`/`--jars`/`spark-submit` 全仓零使用 | `docker/Dockerfile:66,76-83`、`docker/mirrors.sh:62-76` |
| `RunnerConfig` 是 `.strict()`，题目 JSON 塞 `dependencies` 会直接校验失败 | `shared/src/question.ts:116` |
| 用户写 `import requests` 得到的是一条裸 `ModuleNotFoundError` 原样回显，既不说能用什么、也不说怎么加 | `server/src/ide/runner.ts:178` |

**结论**：要解决的不是"缺一个安装钩子"，而是"IDE 里没有环境这个对象"。所以先造它，再给它三个入口（装、看、复原）。

## 2. 三条红线

### 红线一：IDE 环境绝不注入判题

容器里 IDE 与判题器是同一个 root、同一个系统 `site-packages`。如果 `pip install` 直接写进系统包目录，用户今天装的包会改变明天判题的结果 —— 那正好废掉"重建镜像即可复现"这条今天刚验过的承诺（`docker/BUILDINFO.md`）。

⇒ 所有用户装的包只落在 `data/ide-env/` 下，这些路径**只注入 IDE 的三条执行路径，判题侧一行都不改**。
⇒ 这条要有闸门（§7 T2），不能靠"我没写进去"。

### 红线二：命令窗口不是 shell

全仓的进程创建纪律是 `shell:false` + argv 数组，今天的审计结论还写着"没有任何用户输入进得去"（`HANDOVER.md` WI-86）。一个叫 install 的输入框如果实现成 `sh -c <输入>`，那句话当场作废。

⇒ 前端输入按空白切成 argv 数组；`argv[0]` 必须命中程序白名单，`argv[1]` 必须命中该语言的子命令白名单，其余参数原样进 argv 交给 `runProcess`。
⇒ 用户照样能写 `pip3 install requests==2.31`，但拿不到 `;` `|` `$()`。这不损失手感 —— "任意代码执行"本来就在它该在的地方（跑代码），不必再开到进程创建这一层。

### 红线三：清单必须读环境本身，不读安装日志

日志会漂移：手工往 `lib/` 塞一个 jar、装到一半崩了、容器重建后目录还在但记录没了。任何一种都会让界面显示的列表与现实不一致，而"界面说假话"是本项目的老毛病。

⇒ python 扫 venv 的 `*.dist-info` 目录名，node 读 `package.json` + `node_modules/*/package.json`，jar 列文件。
⇒ 推论：**"哪些是用户自装的"这个问题，物理位置就是答案**，不需要维护任何 diff 表。

## 3. 架构

```
data/ide-env/                    ← 持久；bind mount 进容器；不参与 judge 沙箱清扫
  python/                        ← python3 -m venv --system-site-packages
    lib/python3.*/site-packages/     ← 用户装的包在这里；预装的在系统目录，继承而来
  node/
    package.json                 ← 用户主动装的声明
    node_modules/
  java/lib/*.jar                 ← 本期不填充（见 §6 支持矩阵），目录先占位
  scala/lib/*.jar
```

路径里的 `python3.*` 是**通配而不是写死小版本**：镜像现在是 3.10，将来升基础镜像时写死的 `lib/python3.10/site-packages` 会变成"清单永远读不到东西"的静默故障（venv 建在 3.11 下、扫描只认 3.10 ⇒ 空清单 + 不报错）。同理 `executable` 用 `bin/python` 而不是 `bin/python3.10`。

`--system-site-packages` 是必需的而不是可省的：不开它，镜像预装的 pandas 在 IDE 里反而 import 不到了，那是**倒退**。开了它之后，清单用"只扫 venv 自己的 site-packages"来区分，天然干净。

### 唯一出口：`ideEnvFor()`

新增 `server/src/ide/env.ts`：

```ts
export interface IdeEnv {
  /** 覆盖注册表里的解释器路径（python 指向 venv 的 bin/python） */
  executable?: string;
  env: NodeJS.ProcessEnv;      // PATH / PYTHONPATH / NODE_PATH
  classpath: string[];         // java / scala；空数组表示"只有默认"
  nodeModulesDir?: string;     // node：把沙箱建在它下面，让向上查找变成成文设计而非巧合
  totalBytes: number;          // 面板显示体积，也用于"该 reset 了"
}
export function ideEnvFor(language: IdeLanguage): IdeEnv;   // 纯函数，不建目录
export async function ensureIdeEnv(language: IdeLanguage): Promise<IdeEnv>;  // 懒建
```

**run（`runner.ts`）、REPL（`repl.ts:68`）、行断点（`debug-python.ts:66`）三处必须从这里取。** 这是本设计最容易做错的地方：一门语言在 IDE 里有三条执行路径，只给 run 注入环境，用户就会撞上"我明明装了，REPL 里 import 不到" —— 而且它不报错，只是行为不一致，属于本项目栽过三次的那类静默降级。

注意 `debug-python.ts:66` 走的是裸 `spawn` 而不是 `runProcess`，注入点不同，改的时候要单独确认它的 env 真的传下去了。

## 4. 组件

### C1 环境存储（`server/src/ide/env.ts`）
懒建：第一次用到才 `python3 -m venv`（首次约 1-2s）。不做启动期预建，避免每次起容器都付 venv 成本。

### C2 命令窗口（`POST /api/ide/env/command`）
- 入参 `{language, argv: string[]}`，服务端做白名单校验（红线二）。
- **独立超时** `IDE_ENV_COMMAND_TIMEOUT_MS = 180_000`。运行是 10s（`languages.ts:78`，硬上限 120s），装包塞不进去。
- **流式输出**：复用判题已有的 SSE 基建，边装边吐 stdout。否则用户看到的是"点了没反应"。
- **同一语言同时只许一个安装**：两个 `pip install` 并发写同一个 `site-packages` 会装坏。一把 per-language 互斥锁，第二个请求直接返回"正在装，等它完成"，不排队也不合并。
- 失败形状：非零退出 ⇒ `status:'install_failed'` + 原样回显（截到 `stdoutCapChars`）。**不许把"装失败"显示成"装完了但清单里怎么没有"**。

### C3 包清单（`GET /api/ide/env`）
每语言返回 `{installed:[{name,version,sizeBytes}], totalBytes, supported:boolean}`。
- python：扫 `venv/lib/*/site-packages/*.dist-info`，目录名即 `name-version`。不 shell 出去调 pip（省一次解释器启动，且没有"pip 本身坏了"这条干扰路径）。
- node：`package.json.dependencies` 与 `node_modules/*/package.json` **两份都读**；不一致时把不一致本身显示出来 —— 那是"装坏了"的现场，藏起来等于骗人。
- java/scala：列 `lib/*.jar` 文件名 + 大小 + mtime。
- 面板顶部常驻一行标注：**"这些只影响 IDE，判题器看不到"**。这句话不该等用户交题撞了才发现。

### C4 reset（`POST /api/ide/env/reset`）
顺序不能反：

1. **先作废该语言活的 REPL / 调试会话**（走现有 manager 的 dispose），并交回名额（`IDE_SESSION_LIMITS.replMaxSessions=2` / `debugMaxSessions=1`）。
2. 再删目录，**复用 `judge/workspace.ts` 的 `removeWithRetry`** —— Windows 上刚停的进程句柄可能还没释放，直接 rm 会 EBUSY/EPERM。
3. 重建空环境。

为什么第 1 步在最前：会话的 `sys.path` 是启动时算好的长驻状态。只删目录不停会话，表现就是"界面显示已重置、REPL 里 import 还在用旧包" —— 又是一个零报错的静默降级，而且这次是界面在说谎。

### C5 前端（`web/src/pages/Ide.tsx` + 新组件）
IDE 结果区下方一个"环境"面板：清单（按语言分组）+ 命令行输入 + reset 按钮 + 体积。沿用仓库既有 design token 与 `.btn`/`.badge`/`.banner` 类，不引新依赖。
不支持的语言显示"这门语言只能靠镜像预装"，并给一句为什么 —— 比给一个装了也没用的输入框诚实。

## 5. 数据流

```
装：输入 pip3 install requests → 白名单校验 → 拿锁 → 180s 预算内跑 → SSE 吐输出
    → 退出 0 → 前端重拉 GET /api/ide/env → 清单出现 requests 2.31
跑：run/REPL/debug → ideEnvFor(lang) → executable + env + classpath → 子进程
复：reset → dispose 会话 → removeWithRetry(目录) → 重建 → 清单空
```

## 6. 语言支持矩阵（本期）

| 语言 | 命令窗口 | 清单 | 理由 |
| --- | --- | --- | --- |
| python | ✅ `pip3 install/uninstall/list/freeze/show` | ✅ dist-info | venv 是一等公民，`--system-site-packages` 保住预装 |
| javascript / typescript | ✅ `npm install/ls/uninstall`（`--prefix` 由服务端注入，用户不许写 `--prefix`/`-C`/`-g`） | ✅ package.json + node_modules | 顺带把"碰巧能过"的 node_modules 查找变成成文设计 |
| java / scala | ❌ | 只列 `lib/*.jar`（本期为空） | jar 要连**传递依赖**一起解析成 classpath；`mvn dependency:get` 只下进 `~/.m2` 不给你 classpath，做对要 `copy-dependencies` + 生成 pom —— 那是另一个量级的功能，不塞进本期 |
| c / cpp | ❌ |  | 只能 apt，运行期装不了 |
| sql / redis / pyspark / spark-scala | ❌ |  | 它们的"依赖"是服务端与镜像，不是包 |

**明确不做**（避免下次重新讨论）：题目级依赖声明（用户说了只谈 IDE）、import 失败→猜包名（`yaml`→pyyaml、`cv2`→opencv-python 这类映射猜错就得设计回落，而命令窗口把这整块复杂度删掉了）、网络/uid/rlimit 隔离、包版本锁定与 lockfile。

## 7. 测试策略

主断言（端到端，任何一环断掉都红）：

```
T1  装 requests → 清单出现 requests → IDE 里 import 成功
    → reset → 清单空 → 同一个 import 必须失败
```

其余必须有的：

- **T2 隔离红线**：往 venv 放一个哨兵包，断言判题侧执行时 `import` 它**失败**；再加一条结构断言 —— 判题的 env 与 argv 里不得出现 `ide-env` 字样。行为 + 结构两条都要，只有行为那条的话，将来有人给判题加了个 `...process.env` 就静默破了。
- **T3 三条路径同源**：run / REPL / debug 都能 import 到刚装的包。这条最容易被"只改了 run"糊过去。
- **T4 结构闸门**：`server/src/ide/*.ts` 里除 `env.ts`/`languages.ts` 外不得再出现字面量 `'python3'`（现在 `repl.ts:68` 与 `debug-python.ts:66` 各有一份）。这是防"下次有人图省事又写一遍"。
- **T5 白名单**：`sh -c`、带 `;` 的输入、`npm i -g`、`--prefix /` 全部被拒并给出可读理由；`pip3 install requests==2.31` 必须放过（否则白名单就是负担而不是保护）。
- **T6 并发安装**：同语言两个 install ⇒ 第二个立刻拿到"正在装"，不出现两个 pip 同时写。
- **T7 reset 会停会话**：开着 REPL 时 reset ⇒ 会话被作废、名额交回、`replMaxSessions` 不被幽灵会话占死。

每条都要做**破坏性验证**（把被测物删掉/改坏，看门禁是否真的红），这是 `dev_verify_workflow.md` 的第二条，不是仪式。

三档验证全跑：`npm run verify:fast` → 容器 `./start.sh --verify`（**判题矩阵必须仍 0 skipped 且结果与改动前逐条一致** —— 这是红线一的现实证明）→ 宿主 `npm run e2e` + 真浏览器看面板（console error 与 warning 均 0、换一次状态再看 DOM、故意停顿一次）。

## 8. 已知代价（说清楚，别等等下才发现）

- **磁盘**：`data/ide-env/` 会涨，且不在 judge 沙箱的 `SWEEP_MAX_AGE_MS` 清扫范围内（那是刻意的）。所以面板必须显示体积、reset 必须一键可达。
- **首次 venv 创建**落在第一次用到环境的那次请求上（1-2s），会给一次"点了稍等"的体验；换来的是起容器不用付这笔钱。
- **它不新增攻击面，但确实把"能装任意包"变成事实**：`pip install` 会执行 setup.py / build backend，等价于任意代码执行。在"本机、单人、绑回环"的威胁模型下这不是新问题（用户本来就能跑任意代码），但**一旦这工具哪天变成多租户，这里和 `ide/runner.ts:10` 自陈的那句"不是多租户沙箱"要一起补**。
- **IDE 跑通 ≠ 题目判过**：这是隔离换来的必然结果，界面上用一行常驻标注承担，不假装能消除。
