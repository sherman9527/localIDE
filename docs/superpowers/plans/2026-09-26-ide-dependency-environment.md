# IDE 依赖环境 Implementation Plan

设计文档：`docs/superpowers/specs/2026-09-26-ide-dependency-environment-design.md`
日期：2026-09-26

## Global Constraints

- **范围只到 IDE**：不碰 `server/src/judge/**` 的执行逻辑，不碰 `shared/src/question.ts` 的 `RunnerConfig`（它是 `.strict()`，本期不需要扩）。
- **红线一**：`data/ide-env/**` 的任何路径不得出现在判题的 env / argv / classpath 里。Task 1 先把这条变成闸门，后面所有任务在它的保护下做。
- **红线二**：命令窗口不开 shell。`runProcess` 保持 `shell:false`，程序名与子命令走枚举，其余参数原样进 argv。
- **红线三**：包清单读环境本身（dist-info / package.json / jar 文件），不引入"安装日志"这种会漂移的状态。
- **分支**：实现全部开在 `ide-deps` 分支上，每个 Task 一个 commit。做不好就**不合并**（比事后 revert 干净），设计文档与计划在 main 上单独一个 commit。
- **新测试文件的认领**：放 `server/test/ide/` 下的会被"网页 IDE"阶段认领，放 `server/test/regression/` 下的被"单元测试"阶段认领；`verify-coverage` 会拒绝没被任何阶段认领的测试文件，加目录时要一起接。
- **每步都要破坏性验证**：把被测物删掉/改坏，确认门禁真的红。红了不算数，**因为缺功能而红**才算数。

## 文件结构

```
server/src/ide/env.ts                      ← 新增：环境对象 + ideEnvFor / ensureIdeEnv + 白名单
server/src/ide/env-command.ts              ← 新增：命令窗口（校验、锁、SSE）
server/src/ide/env-inventory.ts            ← 新增：读 dist-info / package.json / lib/*.jar
server/src/ide/reset.ts                    ← 新增：停会话 → removeWithRetry → 重建
server/src/ide/runner.ts                   ← 改：executable/env/classpath 来自 ideEnvFor
server/src/ide/repl.ts:68                  ← 改：裸 'python3' 换掉
server/src/ide/debug-python.ts:66          ← 改：裸 spawn('python3') 换掉（注意它不走 runProcess）
server/src/ide/languages.ts                ← 改：新增 IDE_ENV_* 常量；java 的 -cp 与判题对齐
shared/src/ide.ts                          ← 改：契约加 IdeEnvResponse / IdeEnvCommandRequest / …
web/src/pages/Ide.tsx + web/src/components/IdeEnvPanel.tsx  ← 新增面板
server/test/ide/env.test.ts                ← 新增
server/test/ide/env-command.test.ts        ← 新增
server/test/ide/env-inventory.test.ts      ← 新增
server/test/ide/env-reset.test.ts          ← 新增
server/test/regression/ide-env-isolation.test.ts  ← 新增（红线一的行为 + 结构双断言）
tests/e2e/ide-env.spec.ts                  ← 新增
```

---

## Task 1: 先立红线闸门（这一轮必须是红的，因为功能还不存在）

**Files:**
- Create: `server/test/regression/ide-env-isolation.test.ts`

**Interfaces:**
- Produces: 无（纯测试）。它守的是"以后所有任务都不许把 ide-env 漏进判题"。

- [ ] Step 1: 写行为断言 —— 在 `data/ide-env/python/lib/python3.*/site-packages/`（路径通配，别写死小版本）手工造一个哨兵包目录（`sentinel_pkg/__init__.py` + `sentinel-1.0.dist-info/`），然后走**判题的 python 执行路径**跑 `import sentinel_pkg`，断言失败。
- [ ] Step 2: 写结构断言 —— 遍历判题侧构造的 env 与 argv，断言没有任何一项含 `ide-env` 字样。两条都要：只有行为那条时，将来有人给判题加一句 `...process.env` 就静默破了。
- [ ] Step 3: 跑 `npm run verify:fast` 确认这两条**现在是红的还是绿的**。
  - 若已经绿（判题本来就读不到那个目录）⇒ 这不算失败，但要做**反向对照**：临时把哨兵包放进系统 site-packages，确认断言会红。否则"闸门通过"可能只是"它没在看任何东西"。
- [ ] Step 4: 确认 `verify-coverage` 认领了这个新文件（不认领就接进 `scripts/verify.sh`）。
- [ ] Step 5: 提交 `test(ide): 立住"IDE 环境不许污染判题"这条红线`

---

## Task 2: 环境对象 `ideEnvFor()`

**Files:**
- Create: `server/src/ide/env.ts`, `server/test/ide/env.test.ts`

**Interfaces:**
- Produces:
  - `ideEnvFor(language): IdeEnv` —— 纯函数，不建目录
  - `ensureIdeEnv(language): Promise<IdeEnv>` —— 懒建（python 首次 `python3 -m venv --system-site-packages`）
  - `interface IdeEnv { executable?: string; env: NodeJS.ProcessEnv; classpath: string[]; nodeModulesDir?: string; totalBytes: number }`
  - `IDE_ENV_ROOT = join(config.dataDir, 'ide-env')`

- [ ] Step 1: 写失败测试 —— 断言 `ideEnvFor(python).executable` 指向 `data/ide-env/python/bin/python`；断言 `ideEnvFor(java).classpath` 含 `data/ide-env/java/lib/*` 但**不含** junit jar 之外的判题专用路径。
- [ ] Step 2: 跑测试确认失败（模块不存在）。
- [ ] Step 3: 实现 `env.ts`。venv 创建要幂等（目录已存在且 `bin/python` 在就跳过），且**并发首次调用不能建两次**（一把 per-language 建锁）。
- [ ] Step 4: 加一条断言并验证：venv 必须带 `--system-site-packages`，否则镜像预装的 pandas 在 IDE 里 import 不到 —— 那是倒退。测试写法：`ideEnvFor(python)` 跑 `import pandas` 必须成功。
- [ ] Step 5: `npm run verify:fast` 绿。破坏性：去掉 `--system-site-packages` ⇒ Step 4 那条必须红。
- [ ] Step 6: 提交 `feat(ide): 环境对象（venv + classpath + 体积）`

---

## Task 3: 三条执行路径同源

**Files:**
- Modify: `server/src/ide/runner.ts`, `repl.ts:68`, `debug-python.ts:66`, `languages.ts:249-250`
- Test: `server/test/ide/env.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `ideEnvFor` / `ensureIdeEnv`

- [ ] Step 1: 写失败测试 T3 —— 往 venv 装一个真包（用 `venv/bin/pip install` 直装，不经命令窗口），然后**分别**用 run、REPL、debug 三条路径 `import` 它，三条都要成功。这条测试是防止"只改了 run"。
- [ ] Step 2: 确认它因缺功能而红（现在 REPL/debug 用裸 `python3`，读不到 venv）。
- [ ] Step 3: 改 `runner.ts` 用 `ensureIdeEnv` 的 executable/env/classpath。
- [ ] Step 4: 改 `repl.ts` 与 `debug-python.ts`。**`debug-python.ts:66` 走裸 `spawn` 不走 `runProcess`**，要单独确认 env 真的传进去并在那条路径上生效（用 T3 的 debug 分支验）。
- [ ] Step 5: 顺手修 java IDE 没有 `-cp` 的既有 bug：`languages.ts:249` 补 `-cp`，让 IDE 与判题（`java-junit.ts:102`）至少都能引用到 `/opt/junit`。加一条断言：IDE 里写 `import org.junit.jupiter.api.Test` 能编译过。
- [ ] Step 6: 写 T4 结构闸门 —— 断言 `server/src/ide/*.ts` 中除 `env.ts`/`languages.ts` 外不得再出现字面量 `'python3'`。破坏性：把 `repl.ts` 改回裸 `python3` ⇒ 必须红。
- [ ] Step 7: `npm run verify:fast` 绿；提交 `refactor(ide): run/REPL/debug 三条路径共用同一环境`

---

## Task 4: 命令窗口（白名单 + 锁 + 独立超时 + SSE）

**Files:**
- Create: `server/src/ide/env-command.ts`, `server/test/ide/env-command.test.ts`
- Modify: `server/src/api/app.ts`（挂 `POST /api/ide/env/command`）、`shared/src/ide.ts`（契约）

**Interfaces:**
- Produces:
  - `parseEnvCommand(language, argv): {ok:true, command, args} | {ok:false, reason}` —— 纯函数，好测
  - `runEnvCommand(language, argv, onChunk): Promise<{status, exitCode, output}>`
  - `IDE_ENV_COMMAND_TIMEOUT_MS = 180_000`
  - 白名单：python `pip3 install|uninstall|list|freeze|show`；node `npm install|ls|uninstall|add|remove`（服务端注入 `--prefix`，拒绝用户写 `--prefix`/`-C`/`-g`/`--global`）

- [ ] Step 1: 先测纯函数 T5 —— `['sh','-c','rm -rf /']` 被拒；`['pip3','install','requests==2.31']` 放过；`['npm','i','-g','x']` 被拒并给可读理由；`['pip3','download','x']` 被拒（不在子命令白名单）。**"放过合法输入"和"拒绝非法输入"要各占一半断言**，否则白名单写成黑名单也测不出来。
- [ ] Step 2: 测 T6 并发 —— 同语言两个 install，第二个必须立刻拿到"正在装"，不许排队成两个 pip 同时写同一目录。
- [ ] Step 3: 实现 `runEnvCommand`：`runProcess(shell:false)`、180s 预算、per-language 互斥锁、stdout/stderr 流式回调。
- [ ] Step 4: 接 SSE 端点（复用判题已有的流式基建，别新造一套协议）。
- [ ] Step 5: 失败形状 —— 装一个不存在的包，断言 `status:'install_failed'` + 原样 stderr，**不许显示成成功**。破坏性：把状态映射改错 ⇒ 该断言红。
- [ ] Step 6: `npm run verify:fast` 绿；提交 `feat(ide): 环境命令窗口（argv 白名单，不开 shell）`

---

## Task 5: 包清单

**Files:**
- Create: `server/src/ide/env-inventory.ts`, `server/test/ide/env-inventory.test.ts`
- Modify: `server/src/api/app.ts`（`GET /api/ide/env`）、`shared/src/ide.ts`

**Interfaces:**
- Produces: `readInventory(language): {installed:[{name,version,sizeBytes}], totalBytes, supported, drift?:string[]}`

- [ ] Step 1: 写失败测试 —— 空 venv 的清单必须是 `installed: []`（**不是**"系统 site-packages 那一堆"）。这条断言直接检验红线三：只扫 venv 自己的目录。
- [ ] Step 2: 装 `requests` 后清单出现 `requests` + 版本；且 `urllib3`（它的传递依赖）也在 —— 断言清单列的是"实际存在的包"而不是"用户敲过命令的那些"，并在界面文案上如实这么说（见 Step 5）。
- [ ] Step 3: 实现 dist-info 扫描（不 shell 调 pip）。**site-packages 路径用 `lib/python3.*/site-packages` 通配**，不写死小版本 —— 写死了会在基础镜像升版后变成"清单永远空且不报错"。
- [ ] Step 4: node 侧读 `package.json.dependencies` 与 `node_modules/*/package.json` 两份；**不一致时填 `drift`**，并断言 drift 会被序列化出去（不许被吞）。
- [ ] Step 5: java / scala 侧列 `lib/*.jar`（文件名、大小、mtime）—— 目录为空时返回空数组而不是报错。加一条断言：往 `java/lib/` 手工放一个 `foo-1.0.jar`，清单必须出现它（这条同时验红线三：读文件即答案，不需要任何安装记录）。
- [ ] Step 6: c/cpp 与 sql/redis 系列返回 `supported:false`，理由字段非空。
- [ ] Step 7: `npm run verify:fast` 绿；提交 `feat(ide): 用户包清单（读环境本身，不读日志）`

---

## Task 6: reset（先停会话，再删目录）

**Files:**
- Create: `server/src/ide/reset.ts`, `server/test/ide/env-reset.test.ts`
- Modify: `server/src/api/app.ts`（`POST /api/ide/env/reset`）

**Interfaces:**
- Consumes: `repl.ts` / `debug.ts` 的会话 manager；`judge/workspace.ts` 的 `removeWithRetry`

- [ ] Step 1: 写失败测试 T7 —— 开一个 python REPL 会话 → reset → 断言会话已作废、`replMaxSessions` 名额已交回（再开两个仍能开）。
- [ ] Step 2: 写 T1 的后半 —— reset 后清单为空，且**同一个 `import requests` 必须失败**。这条是"界面说已重置"与现实的唯一绑定。
- [ ] Step 3: 实现顺序：dispose 会话 → `removeWithRetry(目录)` → 重建空环境。**不许先删再停**：Windows 上句柄未释放会 EBUSY，而且删完再停会话会让那个会话在已消失的路径上继续跑一会儿。
- [ ] Step 4: 破坏性 —— 把 dispose 挪到删除之后，看 T7 是否红。若两条测试都还绿，说明它们没在测真东西。
- [ ] Step 5: `npm run verify:fast` 绿；提交 `feat(ide): reset environment（先作废会话再删目录）`

---

## Task 7: 前端面板

**Files:**
- Create: `web/src/components/IdeEnvPanel.tsx`
- Modify: `web/src/pages/Ide.tsx`, `web/src/styles/base.css`
- Test: `web/test/ide-env.test.tsx`

- [ ] Step 1: 写失败测试 —— 面板渲染清单三行（名字/版本/体积）+ 命令行输入 + reset 按钮 + "这些只影响 IDE，判题器看不到"这行标注存在。
- [ ] Step 2: 断言不支持的语言显示"只能靠镜像预装"而不是一个空输入框。
- [ ] Step 3: 实现，沿用既有 design token 与 `.btn`/`.badge`/`.banner`，不引新依赖。
- [ ] Step 4: 装包期间输入框禁用 + 流式输出可见（不许"点了没反应"）。
- [ ] Step 5: reset 要有确认（它是破坏性动作），文案说清会停掉活的 REPL。
- [ ] Step 6: `npm run verify:fast` 绿；提交 `feat(web): IDE 环境面板`

---

## Task 8: E2E 与真浏览器

**Files:**
- Create: `tests/e2e/ide-env.spec.ts`

- [ ] Step 1: 端到端 T1 在真浏览器里跑一遍：装 `requests` → 面板出现 → 运行 `import requests` 成功 → reset → 清单空 → 运行失败。**这六步是一条测试，不许拆成六个各测各的**（拆开就测不到"界面与现实脱节"这一类）。
- [ ] Step 2: 几何/状态断言：换一次语言再看面板是否跟着换（本项目有过"切到 mysql 后 python 的调试面板还赖着"的先例，同一个 key 陷阱）。
- [ ] Step 3: `npm run e2e` 宿主全绿。
- [ ] Step 4: 真浏览器手看：console **error 与 warning 均 0**；故意停顿一次（等 REPL 空闲回收真的发生）再看界面是否还说谎。
- [ ] Step 5: 提交 `test(e2e): 装包→可用→reset→不可用 的端到端闭环`

---

## Task 9: 文档与交付档验证

**Files:**
- Modify: `README.md`, `docs/JUDGING.md`, `docs/ARCHITECTURE.md`, `memo.md`, `HANDOVER.md`

- [ ] Step 1: README「已知边界」加一条：IDE 可以现装依赖，但**判题器看不到 `data/ide-env/`**，这是刻意的隔离，代价是"IDE 跑通 ≠ 题目判过"。
- [ ] Step 2: `docs/JUDGING.md` 加一行同一事实（判题侧读者也要知道），并写明 `data/ide-env/` 不参与 judge 沙箱清扫。
- [ ] Step 3: 容器交付档 `./start.sh --verify` —— **判题矩阵必须仍 0 skipped，且结果与改动前逐条一致**（这是红线一的现实证明，不是可选项）。
- [ ] Step 4: 宿主 `npm run e2e` 全绿。
- [ ] Step 5: `memo.md` 追加里程碑（含踩坑与教训），`HANDOVER.md` 开 WI 条目并带验证命令与实测输出。
- [ ] Step 6: 提交 `docs: IDE 依赖环境的边界与验证`

---

## 回退方案

`ide-deps` 分支上每个 Task 一个 commit。整体做坏了：**不合并**，main 上只有设计文档与计划这一个 commit（可单独 `git revert`）。
若已合并后要退：`git revert` 覆盖 Task 1→9 的区间即可，因为本期**没有数据迁移、没有改题库 JSON、没有改判题逻辑** —— 唯一的外部状态是 `data/ide-env/`，它 gitignore 且可被 reset 删掉。
