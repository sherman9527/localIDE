# WI-94：把 Jupyter notebook 内嵌进第五页 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第五页不再"跳出去开 7789 的独立 Jupyter 标签页"，而是在**同源**的 `/jupyter/*` 反代里内嵌 notebook（左文件树 + 右 notebook），并且这棵子树自带 fail-closed 守卫。

**Architecture:** Jupyter 仍以独立进程跑在 arena 容器里（entrypoint 拉起，监听 8888），但它被配上 `--ServerApp.base_url=/jupyter/`，于是它自己发出的所有链接/资源/ws 地址都带这个前缀。宿主 7788 上那棵同源子树 `/jupyter/*` 由 `server/src/notebooks/proxy.ts` 做**手写**反代：HTTP 走 `node:http` 原始管道、WebSocket 走 `app.server.on('upgrade')` + `net` 双向管道，token **只在服务端注入**（HTTP 加 `Authorization: token …`，ws 握手加 `?token=…`，并把客户端自带的 `token` 查询参数一律摘掉），因此**页面上任何地方都不再出现凭据**。放行判据是 `Host` 本机字面量 ∧ socket 对端本机 ∧ `Sec-Fetch-Site ∈ {same-origin, 缺席}` 的**合取**，任一不成立就 fail-closed。

**Tech Stack:** Fastify 5（`node:http` 原生 `reply.raw`/`reply.hijack()`、`addContentTypeParser('*')`、`removeContentTypeParser`）、`node:http` + `node:net`（无新依赖）、React 18 + 既有 `web/src/styles/base.css` token、Vitest、Playwright（宿主 Edge）。

**Spec:** `HANDOVER.md` 的 WI-94 条目（设计已在会话中批准并记在那里，含 2026-10-08 终审 N1 的更正）；父项目设计见 `docs/superpowers/specs/2026-10-05-jupyter-notebook-runtime-design.md`；A1 的实施计划 `docs/superpowers/plans/2026-10-16-jupyter-notebook-runtime-a1.md` 的 Task 5-10 是本轮要接的上一档。

## Global Constraints

这些是每一任务隐含都要满足的，逐字来自仓库规则（`.qoder/rules/dev_verify_workflow.md`、`rule.md`）与既有闸门：

- **不引入任何新依赖**（package.json 一个字节都不许多）。`ws` 只是被 hoist 上来的传递包，不是 `server` 声明的依赖 ⇒ 隧道一律用 `node:http` / `node:net` / `app.server.on('upgrade')` 手写。
- **凭据纪律**：`ARENA_JUPYTER_TOKEN` 与 `ARENA_LLM_BRIDGE_TOKEN` 只躺在 `.env`（已 gitignore）。绝不 commit / 读取 / 打印 / `cat .env`；日志与响应里不许出现 token 值；错误消息不许回显客户端自报的头/地址字面量（`app.ts` 那条 origin 钩子已经立了先例："收到的那个值不打印在这里 —— 它是外部输入，会进日志"）。
- **前缀只有一份真相**：`/jupyter` 这个字面量不许在 shell、TS、页面、测试里各长一遍。单一来源 = `shared/src/notebook.ts` 的 `NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL`，其余全部派生或由闸门按派生的期望值去查文本。
- **fail-closed 的方向**：判据不确定时**拒绝**，但"拒绝"不许表现为静默 —— 每个否决都要有自己的状态码 + `error` 码 + 一句"该去修什么"的话（本项目最恨的是"点了没反应"）。
- **红线①不许碰**：本轮不新增/修改任何判题环境的执行路径；notebook 的 shell（`!pip3`）仍必须解析到 IDE venv（闸门 `notebook-env-isolation.test.ts`），反代不得改变 kernel 的解释器归属。
- **`start.sh` 与 `start.ps1` 是同一套判据的两个实现**：改了其中一个就要把另一个改到一致，`start.ps1` 必须保留 **UTF-8 BOM**。
- **`.sh` 必须是 LF**（判据是字节不是语法，闸门 `scripts-syntax.test.ts`），且 `bash -n` 抓不到 CR。
- **验证三档**：宿主 `npm run verify:fast`；容器 `./start.sh --verify`（判题矩阵必须报 `跳过 0`，且 notebook 那一阶段必须在）；宿主 `npm run e2e`。**前端改动必须在真浏览器里看过**：console 的 error 与 warning 都为 0、换一次状态再看 DOM、故意停顿 ~60 秒再看服务还在不在。
- **破坏性验证**：每条新闸门都要做一次"把被测物删掉/改坏，看它是不是真的红"，并把实测结果（哪几条红、报什么）写进代码注释 —— 不写没测过的推测。
- **提交身份**逐条通过环境变量传 noreply 身份；**不改 git config**；不 push（除非用户要求）。
- **门禁自己也要被门禁**：新增 `*.test.ts` 必须被 `scripts/verify.sh` 某阶段认领，且**门控变量必须被那个阶段全部设置**（判据 `x.vars.every(v => s.vars.includes(v))`，闸门 `verify-coverage.test.ts:129`）。
- **跨 session 记忆**：收尾要写 `memo.md` 里程碑 + `HANDOVER.md` 移动 WI-94。

---

## 文件结构（先定边界，再拆任务）

| 文件 | 这一轮它负责什么 |
| --- | --- |
| `shared/src/notebook.ts` | 前缀这份真相（`NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL` / `NOTEBOOK_TREE_PATH` / `notebookDocPath()`）+ 新的 `NotebookFilesResponse` 契约。**服务端与页面共用的形状一律住这里**（既有纪律，WI-86 的学费） |
| `docker/entrypoint.sh` | jupyter 启动行加 `--ServerApp.base_url=/jupyter/` |
| `server/src/notebooks/status.ts` | 探活 URL 与给页面的链接都改成带前缀；把 `missingTokenReason()` 导出给守卫复用（"为什么没 token"的两句话只写一遍） |
| `server/src/notebooks/proxyGuard.ts`（新） | "这个请求能不能走这棵子树"的**纯函数**判据（合取 + Sec-Fetch-Site）。纯函数是因为它要在宿主档被逐组合判住 —— 走 HTTP 的话外层钩子会遮住内层（A1 已实测过一次这个遮挡） |
| `server/src/notebooks/proxy.ts`（新） | HTTP 隧道 + WebSocket 隧道 + 路由/`upgrade` 挂载。唯一写"上游请求头怎么拼"的地方 |
| `server/src/notebooks/files.ts`（新） | 读 workDir 里的 `.ipynb`（左栏那棵树的数据源）。只 stat/readDir，绝不做重活 |
| `server/src/api/app.ts` | `AppDeps` 两个注入点 + 挂载反代 + `GET /api/notebook/files` |
| `web/src/api.ts` | `notebookFiles()` |
| `web/src/pages/Notebook.tsx` | 两栏（左树 + 右 iframe）、去掉没用的内核徽章行、边界卡折成 `<details>` |
| `web/src/styles/base.css` | `.nb-split` / `.nb-tree` / `.nb-frame` 三个类，沿用既有 token |
| `scripts/verify.sh` | 容器档 notebook 阶段认领新闸门文件；单元测试阶段 `--exclude` 同步 |
| `start.sh` / `start.ps1` | 探测与横幅的路径改成 `${JUPYTER_BASE_URL}login` / `${JUPYTER_BASE_URL}tree` |
| 测试 | `server/test/notebooks/proxyGuard.test.ts`（新，宿主）／`server/test/notebooks/proxy.test.ts`（新，宿主：假上游 + 真 socket）／`server/test/notebooks/embed.test.ts`（新，容器门控）／改 `notebook-contract.test.ts`、`kernel.test.ts`、`status.test.ts`、`notebook-api.test.ts`、`web/test/notebook.test.tsx`、`tests/e2e/notebook-page.spec.ts` |

任务顺序是依赖顺序：1（前缀）→ 2（守卫纯函数）→ 3（HTTP 隧道）→ 4（WS 隧道）→ 5（文件列表）→ 6（页面）→ 7（三档 + 浏览器 + 记忆）。**3 与 4 都不许并行做**（同一个文件、同一组容器闸门）。

---

## Task 1：`/jupyter/` 这个前缀只有一份真相

**为什么先做这一件**：反代的前提是 Jupyter 把自己挂在 `/jupyter/` 下 —— 否则它回话里的 `/static/...`、`/api/...`、`/login?next=...` 全都会打到 7788 自己的树上，与 SPA 与 `/api` 直接撞名。而这一改动会**顺着路径打穿所有已经存在的闸门**（`kernel.test.ts` 里 4 处 `/tree`、`start.sh`/`start.ps1` 的 `/login`、`status.ts` 的探活与拼链接、`web`/`api` 测试里的 url 字面量），所以必须单独成一档：先让"带前缀"这件事在**现有**三档里全绿，才谈得上往上加隧道。

**Files:**
- Modify: `shared/src/notebook.ts`（文件末尾追加导出）
- Modify: `docker/entrypoint.sh:93-98`（jupyter 启动行）
- Modify: `server/src/notebooks/status.ts:126-131`（`jupyterApi`）与 `:328-338`（拼链接）
- Modify: `start.sh:348-361`（`report_notebook`）与 `start.ps1:336`、`:347`
- Modify: `server/test/regression/notebook-contract.test.ts`（新增三条判据）
- Test-Modify: `server/test/notebooks/kernel.test.ts`（4 处 `path`/URL）、`server/test/notebooks/status.test.ts`、`server/test/api/notebook-api.test.ts`、`web/test/notebook.test.tsx`（url 字面量）

**Interfaces:**
- Consumes: 无（这是第一档）
- Produces: `NOTEBOOK_PREFIX: '/jupyter'`、`JUPYTER_BASE_URL: '/jupyter/'`、`NOTEBOOK_TREE_PATH: '/jupyter/tree'`、`notebookDocPath(file: string): string` —— Task 3/4/5/6 与所有新闸门都从这几个符号派生期望值。

- [ ] **Step 1: 先在契约闸门里写红的判据（三条）**

`server/test/regression/notebook-contract.test.ts` 复用文件里已有的 `flagValues(text, flag)`（:77，它已经在读**代码视图**而不是注释 —— 这条很重要，否则"在注释里写一句 base_url"就能骗绿）。在该文件 `describe` 内追加：

```ts
  /**
   * WI-94 的前提：Jupyter 自己就挂在 `/jupyter/` 下。判的是**取值等于 shared 里那份真相**，
   * 不是"启动行里出现过 base_url"—— 后者在有人把值改成 `/nb/` 时照样绿，而那时页面上的
   * 反代前缀与 jupyter 的 base_url 分家，症状是"iframe 里全 404"，一片绿。
   */
  it('entrypoint 的 --ServerApp.base_url 必须就是 shared 的 JUPYTER_BASE_URL（不多不少、恰好一处）', () => {
    const values = flagValues(entrypointText(), 'base_url');
    expect(values, '启动行里没有 --ServerApp.base_url ⇒ jupyter 挂在根路径上，同源反代 `/jupyter/*` 会把它的 /static、/api、/login 全撞进 7788 自己的树里').toHaveLength(1);
    expect(values[0], `entrypoint 里的 base_url 是 "${values[0]}" 而前缀的真相是 "${JUPYTER_BASE_URL}"（shared/src/notebook.ts）⇒ 两边分家时症状是 iframe 里每个资源都 404，而三档验证谁都不会红`).toBe(JUPYTER_BASE_URL);
  });

  it('给页面的链接与探活都带前缀：config.notebook.publicUrl + JUPYTER_BASE_URL 派生，不许写死 /tree', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', tokenOverride: 'x', fetchImpl: fakeUp(), gatewayAddresses: [] });
    expect(res.url, '链接没带前缀 ⇒ 用户点开的还是 7789 的根路径，而 jupyter 已经不在那儿了').toBe(`${config.notebook.publicUrl}${NOTEBOOK_TREE_PATH}`);
  });

  it('start.sh 与 start.ps1 里那条探测也带前缀（同一套判据的两个实现）', () => {
    const probe = `7789${JUPYTER_BASE_URL}login`;      // 期望值派生，不写死 '/jupyter/login'
    const sh = readFileSync(join(config.repoRoot, 'start.sh'), 'utf8');
    const ps = readFileSync(join(config.repoRoot, 'start.ps1'), 'utf8');
    expect(sh, 'start.sh 的 report_notebook 还在探 /login ⇒ base_url一改它就永远 000，横幅会说"未就绪"而功能其实是好的（假阴性）').toContain(probe);
    expect(ps, 'start.ps1 与 start.sh 不同步 ⇒ 两个人照着不同的一句话修不同的东西').toContain(probe);
  });
```

顶部 import 补 `NOTEBOOK_TREE_PATH, JUPYTER_BASE_URL`（`@arena/shared`）。`fakeUp()` / `notebookStatus` 的调用形状照 `server/test/notebooks/status.test.ts` 里那份假 fetch（返回 `{status:200, json: async()=>…}`）—— 本文件若不已在测 `notebookStatus`，就照 `notebook-api.test.ts:66-82` 的 `jupyterUp()` 复制**同一形状**的假上游（`kernelspecs` 那个键名，别写成 `kernels`）。

- [ ] **Step 2: 跑，确认三条都因为"缺功能"而红**

Run: `cd server && npx vitest run test/regression/notebook-contract.test.ts`
Expected: 编译期先红在 `JUPYTER_BASE_URL` 未导出 —— 这是"缺功能而红"，不是"写错测试而红"（下一步就补上）。**不许**用 `try/catch` 把 import 失败吞掉。

- [ ] **Step 3: 在 shared 里落这份真相**

`shared/src/notebook.ts` 末尾追加：

```ts
/**
 * WI-94：同源反代的前缀**唯一真相**（`/jupyter`）。
 * 它是"三处各写一遍"的高危形状：`docker/entrypoint.sh` 的 `--ServerApp.base_url`、
 * 服务端反代的挂载点、`start.sh` / `start.ps1` 的探测路径、`status.ts` 给页面的链接、
 * 前端 iframe 的 src —— 任一处对不上，症状都不是报错而是"iframe 里全 404"或"横幅永远说未就绪"，
 * 而三档验证全是绿的（本项目在桥 token 与 kernel id 上各付过一次学费，见 WI-86 与
 * `notebook-contract.test.ts` 的「kernel id 只有一份真相」）。
 * shell 侧带不回这个常量 ⇒ 那边用字面量，由闸门按派生的期望值去查它的文本。
 */
export const NOTEBOOK_PREFIX = '/jupyter' as const;

/**
 * jupyter 侧的 base_url：`NOTEBOOK_PREFIX` + **尾斜杠**。
 * 尾斜杠不是风格：jupyter 拼资源用的是 `${base_url}static/…`，少一个斜杠它就成了 `/jupyterstatic/…`。
 */
export const JUPYTER_BASE_URL = `${NOTEBOOK_PREFIX}/` as const;

/** 文件列表页（7789 那把"逃生链接"与第五页 iframe 的默认落点）。 */
export const NOTEBOOK_TREE_PATH = `${NOTEBOOK_PREFIX}/tree` as const;

/**
 * 一份笔记在同源那棵树上的路径。**逐段 encode**：文件名里能出现空格、中文、`#`、`?`，
 * 整串 encode 会把 `/` 也吃掉（变成 %2F ⇒ jupyter 当成一段路径，找不到文件）。
 */
export function notebookDocPath(file: string): string {
  return `${NOTEBOOK_PREFIX}/notebooks/${file.split('/').map(encodeURIComponent).join('/')}`;
}
```

- [ ] **Step 4: 启动行加 base_url**

`docker/entrypoint.sh`，在那条 `jupyter notebook …` 里、与 `--ServerApp.root_dir` 同一组的位置加一行（**单独占一行**，因为 `flagValues` 之外还有 `serverAppIpValues` 一类按行解析的判据，挤在同一行会让将来的读取变脆）：

```bash
    --ServerApp.base_url=/jupyter/ \
```

紧邻上方写两句注释（这是"为什么"，不是"做了什么"）：为什么是 jupyter 自己带前缀而不是代理剥前缀（它的 HTML 里的 `/static`、`/api` 是绝对路径，不剥就会与 SPA 与 `/api` 撞名）；以及这条一改就连带 `start.sh` / `start.ps1` / `kernel.test.ts` 的探测路径（闸门 `notebook-contract.test.ts`）。

- [ ] **Step 5: 服务端两处路径**

`server/src/notebooks/status.ts`：

```ts
async function jupyterApi(subPath: string, token: string, doFetch: typeof fetch, timeoutMs: number): Promise<Response> {
  // subPath 是**相对 base_url** 的（`api/status`），前缀在这里加、只在这里加。
  return doFetch(`http://127.0.0.1:${config.notebook.port}${JUPYTER_BASE_URL}${subPath}`, {
```

两个调用点从 `'/api/status'` / `'/api/kernelspecs'` 改成 `'api/status'` / `'api/kernelspecs'`。拼链接那一行：

```ts
    const u = new URL(`${config.notebook.publicUrl}${NOTEBOOK_TREE_PATH}`);
```

`import { JUPYTER_BASE_URL, NOTEBOOK_TREE_PATH, … } from '@arena/shared'`。

- [ ] **Step 6: 两个实现一起改（`start.sh` 与 `start.ps1`）**

`start.sh:355` 探测改 `http://127.0.0.1:7789/jupyter/login`；`:360` 那句 `say` 里的链接改 `http://127.0.0.1:7789/jupyter/tree`。`start.ps1:336` 的 `Invoke-WebRequest -Uri` 与 `:347` 的 `Write-Host` 同改。
两处"未就绪"长消息里那句 `curl http://127.0.0.1:7789/tree` 的举例**也要**跟着改成 `/jupyter/tree`（那是给人照抄的命令，写旧路径等于教人一条必 404 的排查动作）。
改完自检：`bash -n start.sh`、`grep -c $'\r' start.sh`（必须 0，且判据是**字节**）、`start.ps1` 的前三个字节仍是 `EF BB BF`（BOM）。

- [ ] **Step 7: 把连带打穿的既有测试字面量改到派生值**

`server/test/notebooks/kernel.test.ts`：4 处路径改成 `${JUPYTER_BASE_URL}tree`（`:579`、`:606`、`:609` 的 `probeHttp` URL，以及 `:757`、`:780` 那两处 `probeWithHostHeader({ path: … })`）。
⚠ 这一步不能跳：base_url 一改，`/tree` 变成 404，而那条 rebinding 闸门判的是 `HOST_REFUSED_STATUS = 403` —— 404 会被读成"请求没走到守卫那一层"，于是**功能没坏而闸门红了**（这个文件的注释早就写过"401/404 说明请求没走到守卫那一层，判不了这条"）。
`web/test/notebook.test.tsx` 的 9 处 url 字面量改成 `${…}/jupyter/tree` 形状；`server/test/notebooks/status.test.ts`、`server/test/api/notebook-api.test.ts` 里断言 url 的期望值同改（假 fetch 用 `.includes('/api/kernelspecs')` 的那些**不用**改 —— `/jupyter/api/kernelspecs` 仍然包含它，这正是"前缀只在一处加"的好处）。

- [ ] **Step 8: 宿主档验证**

Run: `npm run verify:fast > /tmp/wi94-t1-fast.log 2>&1; echo "FAST_EXIT=$?"` 然后 `tail -40 /tmp/wi94-t1-fast.log`
Expected: `FAST_EXIT=0`，`notebook-contract.test.ts` 的新三条全过。**不许**用管道直接吞退出码（`| tail` 的 `$?` 是 tail 的）。

- [ ] **Step 9: 破坏性验证（每条新闸门各来一次）**

1. 把 entrypoint 那行改成 `--ServerApp.base_url=/nb/` → 第一条必须红，且红的那句话里出现两个值；
2. 把 `status.ts` 的 `NOTEBOOK_TREE_PATH` 换回 `/tree` → 第二条红；
3. 只改 `start.sh` 不改 `start.ps1` → 第三条红（这一条同时证明"两个实现"的判据不是装饰）；
4. 全部还原，再跑一次 Step 8 确认 `FAST_EXIT=0`。
把实测的"哪几条红 + 报的什么"写回这三条判据上方的注释里（不要写推测）。

- [ ] **Step 10: 容器档验证（这一档才是这一任务的真验收）**

Run: `./start.sh --verify > /tmp/wi94-t1-verify.log 2>&1; echo "CV_EXIT=$?"; grep -n "Notebook 运行时\|跳过\|passed" /tmp/wi94-t1-verify.log | tail -30`
Expected: `CV_EXIT=0`；容器档 notebook 阶段出现；判题矩阵 `跳过 0`；`kernel.test.ts` 那 30 条（含 base_url 后的 `/jupyter/tree` 探测）全过。
若 `jupyter` 用的是旧镜像：`./start.sh --rebuild`（改的是 entrypoint，必须重建；`docker cp` 只活在当前容器实例，不算数）。

- [ ] **Step 11: Commit**

```bash
git add shared/src/notebook.ts docker/entrypoint.sh server/src/notebooks/status.ts start.sh start.ps1 \
        server/test/regression/notebook-contract.test.ts server/test/notebooks/kernel.test.ts \
        server/test/notebooks/status.test.ts server/test/api/notebook-api.test.ts web/test/notebook.test.tsx
GIT_AUTHOR_NAME=Qcode GIT_AUTHOR_EMAIL=qcode@users.noreply.github.com \
GIT_COMMITTER_NAME=Qcode GIT_COMMITTER_EMAIL=qcode@users.noreply.github.com \
git commit -m "feat(notebook): WI-94 Task 1 —— /jupyter 前缀只有一份真相（base_url + 探活/链接/横幅四处连带）"
```

---

## Task 2：守卫是个纯函数（合取 + Sec-Fetch-Site）

**为什么单独一档**：A1 学过的一课 —— "走 HTTP 的判据会被外层遮住"（`notebook-api.test.ts` 那 4 条与 `status.test.ts` 那条合取表就是为这个而分的）。反代的放行判据是**三**个输入的组合，其中"对端本机 + Host 外来"这一态在真实 HTTP 路径上**根本造不出来**（外层 origin 钩子先 403），所以它必须能在函数层面被逐组合判住。

**Files:**
- Create: `server/src/notebooks/proxyGuard.ts`
- Create: `server/test/notebooks/proxyGuard.test.ts`
- Modify: `server/src/notebooks/status.ts`（`missingTokenReason` 改为导出）

**Interfaces:**
- Consumes: `isLoopbackHostHeader`（`server/src/net/localOrigin.ts`）、`isLocalPeer` / `localGatewayAddresses` / `missingTokenReason`（`server/src/notebooks/status.ts`）、`config.notebook.token` / `tokenKeyPresent`
- Produces:

```ts
export type ProxyVerdict = { ok: true } | { ok: false; status: number; error: string; message: string };
export function guardNotebookProxy(input: {
  peerAddress: string;
  hostHeader: string | undefined;
  secFetchSite: string | undefined;
  gatewayAddresses?: string[];
  token?: string;
  tokenKeyPresent?: boolean;
}): ProxyVerdict;
```

Task 3 的 HTTP handler 与 Task 4 的 `upgrade` 处理者**只**调这一个函数（不许在隧道里再判一遍任何一条 —— 那是"两处各写一遍"）。

- [ ] **Step 1: 写红的真值表测试**

`server/test/notebooks/proxyGuard.test.ts`，宿主档、无 Docker：

```ts
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { guardNotebookProxy } from '../../src/proxyGuard…';  // ← 实际路径 ../../src/notebooks/proxyGuard.js

const TOK = 'canary-token-not-printed-4a1b';
const LOCAL = { peerAddress: '127.0.0.1', hostHeader: '127.0.0.1:7788', secFetchSite: 'same-origin' };

describe('反代守卫：三个输入的合取', () => {
  it('三条都点头 ⇒ 放行', () => {
    expect(guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  /**
   * 表里每一行只坏一件事。每行都给出**该红的那个 error 码**，因为"红了"不够 ——
   * 三态共一句话的写法会把"这台机器上没有 Jupyter"说成"你不许用"（评审 T34 那句双重误导的同形）。
   */
  const TABLE: Array<[string, Partial<Parameters<typeof guardNotebookProxy>[0]>, string, number]> = [
    ['Host 是外来域名（rebinding 那一半）', { hostHeader: 'evil.example:7788' }, 'notebook_proxy_refused', 403],
    ['Host 是 127.0.0.1.evil.example（以本机字面量开头的域名）', { hostHeader: '127.0.0.1.evil.example' }, 'notebook_proxy_refused', 403],
    ['Host 缺席（HTTP/1.0 或被摘掉）', { hostHeader: undefined }, 'notebook_proxy_refused', 403],
    ['Host 是裸 IPv6 的歧义写法 ::1:7788', { hostHeader: '::1:7788' }, 'notebook_proxy_refused', 403],
    ['对端是局域网地址（伪造 Host 也没用）', { peerAddress: '192.168.1.20' }, 'notebook_proxy_refused', 403],
    ['对端是 TEST-NET（永不可能是任何机器的网关）', { peerAddress: '203.0.113.9' }, 'notebook_proxy_refused', 403],
    ['对端是网桥网关（compose 里宿主浏览器那一支）⇒ 放行，所以这里反过来测它被摘掉 Host 时仍红', { peerAddress: '172.18.0.1', hostHeader: 'evil.example' }, 'notebook_proxy_refused', 403],
    ['Sec-Fetch-Site: cross-site（别人的页面里嵌我们）', { secFetchSite: 'cross-site' }, 'notebook_cross_site', 403],
    ['Sec-Fetch-Site: same-site（同站不同源，localhost 与 127.0.0.1 之间）', { secFetchSite: 'same-site' }, 'notebook_cross_site', 403],
    ['Sec-Fetch-Site 有两个值（浏览器不会这么发 ⇒ 不可信）', { secFetchSite: 'same-origin, cross-site' }, 'notebook_cross_site', 403],
    ['这个实例没有 token ⇒ 503，且**不是** 403', { token: '' }, 'notebook_not_configured', 503],
  ];
  for (const [name, patch, wantError, wantStatus] of TABLE) {
    it(name, () => {
      const v = guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: ['172.18.0.1'], ...patch });
      expect(v.ok, JSON.stringify(v)).toBe(false);
      const bad = v as Extract<ProxyVerdict, { ok: false }>;
      expect(bad.error).toBe(wantError);
      expect(bad.status).toBe(wantStatus);
    });
  }

  it('Sec-Fetch-Site 缺席 = 不是浏览器发的 ⇒ 放行（本机 curl 与测试探针还要活着）', () => {
    expect(guardNotebookProxy({ ...LOCAL, secFetchSite: undefined, token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  it('Host 是 localhost 这个名字也放行（判据与 token 那一半同源，不许在这里另写一套）', () => {
    expect(guardNotebookProxy({ ...LOCAL, hostHeader: 'localhost:7788', token: TOK, gatewayAddresses: [] })).toEqual({ ok: true });
  });

  /** 凭据纪律：否决消息里不许出现它读到的任何外部输入值，也不许出现 token。 */
  it('三种否决的 message 里都没有 token，也没有客户端自报的头/地址', () => {
    for (const patch of [{ hostHeader: `evil.example` }, { peerAddress: '192.168.9.9' }, { token: '' }] as const) {
      const v = guardNotebookProxy({ ...LOCAL, token: TOK, gatewayAddresses: [], ...patch });
      const message = (v as Extract<ProxyVerdict, { ok: false }>).message ?? '';
      expect(message.includes(TOK), message).toBe(false);
      expect(message.includes('192.168.9.9'), message).toBe(false);
      expect(message.includes('evil.example'), message).toBe(false);
    }
  });

  it('没 token 那句话区分"从没生成"与"按设计不给"（复用 status.ts 那份，不再写第二份）', () => {
    const never = guardNotebookProxy({ ...LOCAL, token: '', tokenKeyPresent: true, gatewayAddresses: [] });
    const byDesign = guardNotebookProxy({ ...LOCAL, token: '', tokenKeyPresent: false, gatewayAddresses: [] });
    expect((never as { message: string }).message).toContain('从没生成');
    expect((byDesign as { message: string }).message).toContain('按设计');
    expect((byDesign as { message: string }).message).not.toContain('从没生成');
  });
});
```

Run: `cd server && npx vitest run test/notebooks/proxyGuard.test.ts` → 红在"模块不存在"（缺功能而红）。

- [ ] **Step 2: 把 `missingTokenReason` 导出**

`server/src/notebooks/status.ts`：`function missingTokenReason(` → `export function missingTokenReason(`，并在 doc 注释里加一句"WI-94：反代守卫复用这同一段话（'从没生成'与'按设计不给'修的是相反的东西，写两遍迟早只有一遍更新）"。

- [ ] **Step 3: 写实现**

`server/src/notebooks/proxyGuard.ts`：

```ts
import { config } from '../config.js';
import { isLoopbackHostHeader } from '../net/localOrigin.js';
import { isLocalPeer, localGatewayAddresses, missingTokenReason } from './status.js';

/**
 * 见 `HANDOVER.md` 的 WI-94：7788 一旦注入 token，"谁能把报文发到 7788"就等价于
 * "谁能在容器里以 root 执行代码"。所以这一层是**三条的合取**，任一缺席即否决：
 * ① `isLocalPeer(对端)` —— 内核给的地址，客户端改不动；compose 里宿主浏览器经网桥 NAT 进来
 *    对端是**网关**而非回环，所以"网关"这一支必须留着，否则功能在唯一启用它的部署里恒关。
 * ② `isLoopbackHostHeader(Host)` —— 拦 DNS rebinding（那一战里对端**就是**回环）。
 * ③ `Sec-Fetch-Site ∈ {same-origin, 缺席}` —— ①② 都拦不住"别人页面里的 iframe 直接把
 *    `http://127.0.0.1:7788/jupyter/…` 嵌进去"：那种请求 Host 是真的本机字面量、对端真的是
 *    受害者自己，只有这个头还认得出"发起它的是另一个站点"。
 *
 * 三件否决各一个 error 码 + 各一个状态码：503 = 这台机器上根本没有 notebook 服务（该去启动），
 * 403 `notebook_proxy_refused` = 不是本机（该去查访问来源），403 `notebook_cross_site` = 页面
 * 是别人家的（该去查谁在嵌这个 iframe）。把它们并成一句就是把三种修法写成同一件事（本项目的老账）。
 *
 * 消息里**绝不回显**读到的头值 / 地址：它们是外部输入、会进日志（`api/app.ts` 那条 origin 钩子
 * 立了同一个先例）。也绝不出现 token。
 */

const ALLOWED_SEC_FETCH_SITE = new Set(['same-origin', 'none']);

export type ProxyVerdict = { ok: true } | { ok: false; status: number; error: string; message: string };

const REFUSED = '这个服务的边界历来是"只绑宿主回环"（compose-ports.test.ts），不是鉴权；' +
  '要把别的机器也接进来，得先给它加一套真正的鉴权，而不是把这一层关掉。';

export function guardNotebookProxy(input: {
  peerAddress: string;
  hostHeader: string | undefined;
  secFetchSite: string | undefined;
  gatewayAddresses?: string[];
  token?: string;
  tokenKeyPresent?: boolean;
}): ProxyVerdict {
  const token = input.token ?? config.notebook.token;
  if (!token) {
    return {
      ok: false,
      status: 503,
      error: 'notebook_not_configured',
      message: `这条同源反代不起作用，因为${missingTokenReason(input.tokenKeyPresent ?? config.notebook.tokenKeyPresent)}`,
    };
  }
  const gateways = input.gatewayAddresses ?? localGatewayAddresses();
  const localPeer = isLocalPeer(input.peerAddress, gateways);
  const localHost = isLoopbackHostHeader(input.hostHeader);
  if (!localPeer || !localHost) {
    const which = !localPeer
      ? 'socket 对端地址不是本机（既不是回环，也不是这个进程自己的默认网关）'
      : 'Host 头不是本机字面量（本机形状只有 localhost 与 127.0.0.0/8 四段齐全的地址与 [::1]）';
    return { ok: false, status: 403, error: 'notebook_proxy_refused', message: `反代不给这个请求注入凭据：${which}。${REFUSED}` };
  }
  const site = input.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== '') {
    if (site.includes(',')) {
      return { ok: false, status: 403, error: 'notebook_cross_site', message: `Sec-Fetch-Site 带了不止一个值 —— 浏览器不会这么发，叠加出来的不可信。${REFUSED}` };
    }
    if (!ALLOWED_SEC_FETCH_SITE.has(site)) {
      return { ok: false, status: 403, error: 'notebook_cross_site', message: `Sec-Fetch-Site 说这个请求不是从本页面发起的（${site}）。${REFUSED}` };
    }
  }
  return { ok: true };
}
```

⚠ 上面那条 `site` 的分支顺序是判据的一部分：**先**判"多值"再判集合（`'same-origin, cross-site'` 既包含允许值也包含禁止值，按集合判会放行）。测试里那一行就是为它存在的。

- [ ] **Step 4: 跑绿 + 全量宿主档**

Run: `cd server && npx vitest run test/notebooks/proxyGuard.test.ts` → 全过。
Run: `npm run verify:fast > /tmp/wi94-t2-fast.log 2>&1; echo "FAST_EXIT=$?"` → `FAST_EXIT=0`。

- [ ] **Step 5: 破坏性验证**

1. 把 `!localPeer || !localHost` 改成 `!localPeer`（只留对端）→ 4 行 Host 相关的必须红；
2. 把 `ALLOWED_SEC_FETCH_SITE` 改成 `new Set(['same-origin','none','cross-site'])` → 那两行 cross-site/same-site 必须红；
3. 把"先判多值"那两行删掉 → 多值那行必须红（这条最容易"顺手写成" `site.split(',')[0]`）；
4. 还原并确认 `proxyGuard.test.ts` 全绿。实测结果写回测试文件顶部的注释。

- [ ] **Step 6: Commit**（`feat(notebook): WI-94 Task 2 —— 反代守卫（对端 ∧ Host ∧ Sec-Fetch-Site 的合取）住在纯函数里`，只加这三个文件）

---

## Task 3：HTTP 隧道（`/jupyter/*` 上真正的反代）

**Files:**
- Create: `server/src/notebooks/proxy.ts`
- Create: `server/test/notebooks/proxy.test.ts`（宿主，假上游 + 真 socket）
- Create: `server/test/notebooks/embed.test.ts`（容器门控，真 Jupyter）
- Modify: `server/src/api/app.ts`（`AppDeps` 加 `notebookUpstream?`、末尾挂载 `registerNotebookProxy`）
- Modify: `scripts/verify.sh:61`（`--exclude server/test/notebooks/embed.test.ts`）与 `:82`（容器档阶段把新文件一起跑）

**Interfaces:**
- Consumes: `guardNotebookProxy`（Task 2）、`NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL`（Task 1）、`config.notebook.{port,token}`
- Produces:

```ts
export interface NotebookUpstream { host: string; port: number }
export function registerNotebookProxy(app: FastifyInstance, deps: {
  upstream?: NotebookUpstream;
  gatewayAddresses?: string[];
}): void;
export function proxiedPath(rawUrl: string, token: string, viaQuery: boolean): string;  // Task 4 用同一份
export function buildUpstreamHeaders(client: IncomingHttpHeaders, upstreamAuthority: string, token: string): Record<string, string | string[]>;  // Task 4 用同一份
```

`app.server.on('upgrade')` 的挂载也在 `registerNotebookProxy` 里（Task 4 只往这个函数里补处理者，不改 `app.ts`）。

- [ ] **Step 1: 写红的宿主档判据**

`server/test/notebooks/proxy.test.ts` 的骨架（`injectApp` 照 `server/test/api/notebook-api.test.ts:104-140` 那份：临时 `ARENA_DATA_DIR` + `vi.resetModules()` + 注入 env，本文件里写全，见下）：

```ts
/**
 * 假上游 = 一个真正的 node:http 服务器，它把"我收到了什么"回显成 JSON。
 * 为什么必须真发 HTTP 而不是 mock `http.request`：这一层的全部风险都在**字节与头的搬运**上
 * （token 注入在哪、客户端自报的 token 有没有被摘掉、body 是不是原样、101 之后谁 pipe 谁），
 * mock 掉它等于把被测对象换成自己的猜测（本项目在 kernelspecs 键名上付过一次这个学费）。
 */
let echo: http.Server;
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; bodyBase64: string }> = [];

/** 按路径分三种回话：回显 / 302+Location / 无 CSP 的 HTML —— 响应方向的搬运要有被测对象。 */
async function startEcho(): Promise<number> {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/redir')) {
      res.writeHead(302, { location: `${JUPYTER_BASE_URL}login?next=${JUPYTER_BASE_URL}redir` });
      return res.end();
    }
    if (url.includes(`${JUPYTER_BASE_URL}tree`)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end('<html><body>tree</body></html>');
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url, headers: req.headers, bodyBase64: Buffer.concat(chunks).toString('base64') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  echo = srv;
  return (srv.address() as AddressInfo).port;
}

const CANARY = 'proxy-test-token-7d3a';   // 永不打印；只在断言里比对
let madeDirs: string[] = [];

/**
 * 每个用例一套临时数据目录 + 显式 env + 指向上面那个假上游。
 * 骨架照 `server/test/api/notebook-api.test.ts:104-140` 的 `injectApp`（临时 ARENA_DATA_DIR、
 * `vi.resetModules()`、mkdtemp 进 `data/test-tmp/`、afterEach 里先 `flushLogs()` 再 `rm` ——
 * 顺序反了会 ENOTEMPTY，那条学费在 A1 记过），差别只有两处：
 * ① 这里要 `app.listen` 而不是只用 `inject()` —— 守卫读的是**内核给的对端地址**，
 *    `inject` 造不出"对端是 127.0.0.1"这件事（那正是本层最要紧的一条判据）；
 * ② opts.upstreamPort 透传给 `notebookUpstream`。
 */
async function injectApp(opts: { token?: string; upstreamPort: number; gatewayAddresses?: string[] }): Promise<{ app: FastifyInstance; port: number }> {
  const dataDir = await mkdtemp(join(process.cwd(), 'data', 'test-tmp', 'proxy-'));
  madeDirs.push(dataDir);
  for (const key of ['ARENA_DATA_DIR', 'ARENA_JUPYTER_TOKEN', 'ARENA_NOTEBOOK_PUBLIC_URL'] as const) delete process.env[key];
  process.env.ARENA_DATA_DIR = dataDir;
  if (opts.token !== undefined) process.env.ARENA_JUPYTER_TOKEN = opts.token;
  vi.resetModules();
  const { buildApp } = await import('../../src/api/app.js');
  const { flushLogs } = await import('../../src/log.js');
  logHandles.push(flushLogs);
  const app = await buildApp({
    judge: stubJudge,
    grade: stubGrade,
    bank: new FakeBank(seedQuestions()),
    store: new FakeStore(),
    clock: fixedClock('2026-10-09'),
    notebookUpstream: { host: '127.0.0.1', port: opts.upstreamPort },
    ...(opts.gatewayAddresses === undefined ? {} : { notebookGatewayAddresses: opts.gatewayAddresses }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('listen 之后拿不到端口');
  return { app, port: address.port };
}
```

用例（每一条都判一件具体的事，`await app.listen({ port: 0, host: '127.0.0.1' })` 之后用真 socket 打 —— 因为 `guardNotebookProxy` 读的是**内核给的对端**，`inject` 伪造不出来）：

```ts
it('GET /jupyter/ 到上游：路径带前缀原样送到、Authorization 是我们注入的、Host/Origin 重写成上游自己的', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(res.status).toBe(200);
  const got = seen.at(-1)!;
  expect(got.url).toBe(`${JUPYTER_BASE_URL}`);
  expect(got.headers['authorization']).toBe(`token ${CANARY}`);
  expect(got.headers.host).toBe(`127.0.0.1:${upstreamPort}`);   // upstreamPort = startEcho() 的返回值
  expect(got.headers.origin).toBe(`http://127.0.0.1:${upstreamPort}`);
});

it('客户端自己在查询串里塞 token ⇒ 被摘掉，只用我们注入的那一份（两个凭据同时在场时 jupyter 读哪个是未定义行为）', async () => {
  await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}api/contents?token=attacker-supplied`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(seen.at(-1)!.url).not.toContain('attacker-supplied');
});

it('POST 的 body **逐字节**原样送到上游（key 顺序 + 非 ASCII 是探针：JSON.parse→stringify 会改这两样）', async () => {
  const payload = '{"b":1,"a":"é中"}';
  await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}api/contents/x`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: payload,
  });
  expect(Buffer.from(seen.at(-1)!.bodyBase64, 'base64').toString('utf8')).toBe(payload);
});

it('Sec-Fetch-Site: cross-site ⇒ 403 + notebook_cross_site，而且**一个字节都没发给上游**', async () => {
  const before = seen.length;
  const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'cross-site' } });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe('notebook_cross_site');
  expect(seen.length).toBe(before);   // 这条是本任务的"硬前提"判据：否决发生在注入之前
});

it('这台实例没有 token ⇒ 503 + notebook_not_configured（不是 403：那句"你不许"是谎）', async () => {
  const noTok = await injectApp({ token: '' });
  const res = await fetch(`http://127.0.0.1:${noTok.port}${JUPYTER_BASE_URL}tree`);
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe('notebook_not_configured');
});

it('响应方向也搬运：上游回 text/html 时我们给它补上 frame-ancestors，并原样搬 302 的 Location', async () => {
  // echo 服务器按 URL 分两种回话：…/redir 回 302 + Location，其余回一个没有 CSP 的 HTML
  const res = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}redir`, {
    headers: { 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(`${JUPYTER_BASE_URL}login?next=${JUPYTER_BASE_URL}redir`); // 上游自己带前缀，我们不重写
  const doc = await fetch(`http://127.0.0.1:${appPort}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(doc.headers.get('content-type')).toContain('text/html');
  expect(doc.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(doc.headers.get('x-frame-options')).toBe('SAMEORIGIN');
});

it('上游没在听（ECONNREFUSED）⇒ 502 + 一句"容器里的 Jupyter 没起来"，而不是把 socket 挂死', async () => {
  const down = await injectApp({ token: CANARY, upstreamPort: 1 });   // 1 端口没人听
  const res = await fetch(`http://127.0.0.1:${down.port}${JUPYTER_BASE_URL}tree`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(res.status).toBe(502);
});

it('反代不抢 SPA 的地盘：/jupyter 之外的路径仍走原来的路由（`/` 是 index.html，`/api/health` 照常）', async () => {
  expect((await fetch(`http://127.0.0.1:${appPort}/api/health`)).status).toBe(200);
});
```

Run: `cd server && npx vitest run test/notebooks/proxy.test.ts` → 红在 `registerNotebookProxy` 不存在。

- [ ] **Step 2: 写实现**

`server/src/notebooks/proxy.ts`（完整文件；注释按下面这几段的话写，别多写装饰）：

```ts
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JUPYTER_BASE_URL, NOTEBOOK_PREFIX } from '@arena/shared';
import { config } from '../config.js';
import { guardNotebookProxy, type ProxyVerdict } from './proxyGuard.js';

export interface NotebookUpstream { host: string; port: number }

/**
 * 为什么手写而不引 `http-proxy` / `@fastify/http-proxy`：**不引新依赖**这条是硬约束
 * （传递包 `ws` 不算依赖 —— 把它当直接依赖用，下次装包树一变就静默没掉）。
 * 代价是这一层只有 ~120 行、只做"搬运"，任何"聪明"的改写（改 body、猜路径、拼 URL）都不许有。
 */

/** RFC 7230 的逐跳头：这些**不许**转发到上游，也不许从上游搬回浏览器。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * 摘掉客户端查询里的 token，再按 `viaQuery` 决定要不要把我们那份附上。
 * `viaQuery=false` 走 header（HTTP 请求），`true` 走查询串（**websocket 握手只能走这条** ——
 * 浏览器给原生 WebSocket 设不了请求头）。两种通道共用同一个函数，是为了让"客户端塞的 token 一定被摘"
 * 这件事只有一处实现。`_xsrf` 不动：那是 jupyter 自己给页面的字段，摘了会把 POST 全打死。
 */
export function proxiedPath(rawUrl: string, token: string, viaQuery: boolean): string {
  const cut = rawUrl.indexOf('?');
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? '' : rawUrl.slice(cut + 1));
  params.delete('token');
  if (viaQuery) params.set('token', token);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * 上游看到的那份头。三件重写各有必要，都不是"整理一下"：
 * - `host`：jupyter 的 `check_host()` 在 `allow_remote_access=False` 下只放"回环形状"，
 *   而浏览器给 7788 的那个 Host（`127.0.0.1:7788`）到上游看就成了"别的服务"。
 * - `origin`：**保留这一条重写，但它的必要性已在真容器里读过源码（2026-10-09，jupyter_server 2.21.1），
 *   结论与直觉相反** —— `auth/login.py:243-257` 的 `get_user_token` 认 URL 参数与 `Authorization` 头两种，
 *   命中就把这一次请求标成 token 认证；`auth/identity.py:533-542`（`should_check_origin`）与
 *   `base/handlers.py:530-542`（`check_xsrf_cookie`）都对 token 认证的请求**直接放行**，
 *   于是 `check_origin()` 的"Origin 的 netloc 必须等于 Host"（`base/handlers.py:437-465`）根本不会被问到。
 *   ⇒ 内嵌这条路**不需要**给镜像加 `c.ServerApp.allowed_origins`，也不需要把 `_xsrf` 供成对。
 *   ⇒ 那也就不该把这条重写当"必须"来写注释：它是**纵深防御**（万一哪天 token 不再每次注入，
 *   症状会是一整片 403 "Blocking Cross Origin"，而不是一个能读的错误），不是当前功能的前提。
 * - `authorization`：凭据只在这一行出现，且**只在服务端**（页面上任何链接都不含 token）。
 */
export function buildUpstreamHeaders(client: IncomingHttpHeaders, upstreamAuthority: string, token: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(client)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin') continue;
    out[lower] = value;
  }
  out['host'] = upstreamAuthority;
  out['origin'] = `http://${upstreamAuthority}`;
  out['authorization'] = `token ${token}`;
  return out;
}

/** 响应方向：搬头部 + 把"能不能被嵌"这条自己写掉（上游若已经限了 frame-ancestors 就不重复 —— 重复 directive 会让整条 CSP 失效）。 */
function responseHeaders(inbound: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (v === undefined || k === 'set-cookie') continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k === 'content-security-policy' || k === 'x-frame-options') continue;
    out[k] = v;
  }
  const cookies = inbound['set-cookie'];
  if (cookies !== undefined) out['set-cookie'] = cookies;
  const csp = inbound['content-security-policy'];
  const has = typeof csp === 'string' && /frame-ancestors/i.test(csp);
  out['content-security-policy'] = has ? (csp as string) : `${typeof csp === 'string' && csp ? `${csp}; ` : ''}frame-ancestors 'self'`;
  out['x-frame-options'] = 'SAMEORIGIN';
  return out;
}

const asHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function refuse(reply: FastifyReply, verdict: Extract<ProxyVerdict, { ok: false }>): void {
  void reply.code(verdict.status).send({ error: verdict.error, message: verdict.message } satisfies { error: string; message: string });
}

/** 守卫的三个输入从这里取：对端是内核给的，Host/Sec-Fetch-Site 是头 —— 见 proxyGuard.ts 顶部。 */
function verdictFor(request: FastifyRequest, gatewayAddresses?: string[]): ProxyVerdict {
  return guardNotebookProxy({
    peerAddress: request.raw.socket.remoteAddress ?? '',
    hostHeader: asHeader(request.headers.host),
    secFetchSite: asHeader(request.headers['sec-fetch-site']),
    ...(gatewayAddresses === undefined ? {} : { gatewayAddresses }),
  });
}

export function registerNotebookProxy(app: FastifyInstance, deps: { upstream?: NotebookUpstream; gatewayAddresses?: string[] } = {}): void {
  const upstream: NotebookUpstream = deps.upstream ?? { host: '127.0.0.1', port: config.notebook.port };
  const authority = `${upstream.host}:${upstream.port}`;

  // `/jupyter`（不带尾斜杠）不在 `/*` 的匹配里。补一条纯跳转，别把它 404 掉 —— 人会手敲它。
  app.get(NOTEBOOK_PREFIX, (_request, reply) => {
    void reply.redirect(JUPYTER_BASE_URL);
  });

  app.register(
    async (scope) => {
      // body 一律**不解析**：原样搬运。Fastify 的内容类型表在封装层是**克隆**的
      // （`node_modules/fastify/lib/content-type-parser.js`：建子上下文时 `new Map(c.customParsers.entries())`），
      // 所以这里删掉继承来的 json/text 不影响根实例。
      // 为什么非删不可：默认的 JSON 解析会把 body 变成对象，代理再 stringify 就改了字节
      // （键顺序、非 ASCII、`1.0` 这种数字写法），而 jupyter 的 contents API 收的就是这种"看起来一样"的 body。
      scope.removeContentTypeParser(['application/json', 'text/plain']);
      scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload as unknown as Record<string, never>));

      const handler = (request: FastifyRequest, reply: FastifyReply): void => {
        const verdict = verdictFor(request, deps.gatewayAddresses);
        if (!verdict.ok) return refuse(reply, verdict);
        const token = config.notebook.token;
        reply.hijack(); // 从这里往后的字节归我们，Fastify 不再碰这条响应
        const upstreamReq = httpRequest(
          { host: upstream.host, port: upstream.port, method: request.method ?? 'GET', path: proxiedPath(request.url ?? '/', token, false), headers: buildUpstreamHeaders(request.headers, authority, token) },
          (ures) => {
            reply.raw.writeHead(ures.statusCode ?? 502, responseHeaders(ures.headers));
            ures.pipe(reply.raw);
            ures.on('error', () => reply.raw.destroy());
          },
        );
        upstreamReq.on('error', (err) => {
          if (reply.raw.headersSent) return reply.raw.destroy();
          const payload = JSON.stringify({
            error: 'notebook_upstream_unreachable',
            message: `同源反代打不到容器里的 Jupyter（127.0.0.1:${upstream.port}）：${err.message}。` +
              '这与"你不许用"是两件事 —— 前者是那个进程没起来（缺 token / 镜像没带 Jupyter / 跑过又掉了）。',
          });
          reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) });
          reply.raw.end(payload);
        });
        const body = request.body as unknown;
        if (body instanceof Readable) {
          body.pipe(upstreamReq);
          body.on('error', () => upstreamReq.destroy());
        } else {
          upstreamReq.end();
        }
        // 浏览器断开（切页、关 iframe）⇒ 上游也断。反过来上游断，pipe 会把 reply.raw 收尾。
        reply.raw.on('close', () => upstreamReq.destroy());
      };

      scope.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/*', handler });
      // 挂在这个 scope 里而不是 app 上：`app.server` 在实例化时就存在（实测 `!!f.server === true`），
      // 而 upgrade 不走路由 —— 守卫必须在两个通道上各判一次，注入点在同一个函数里才不会漏一个。
      attachNotebookUpgrade(app, { upstream, authority, gatewayAddresses: deps.gatewayAddresses });
    },
    { prefix: NOTEBOOK_PREFIX },
  );
}
```

Task 4 之前 `attachNotebookUpgrade` 还不存在 —— **Step 2 里先不要那一行**（本任务的测试全绿之后再进 Task 4）。这是刻意的：每个任务结束时仓库是可用的。

- [ ] **Step 3: `app.ts` 接线**

`AppDeps`（:97-115）加：

```ts
  /**
   * WI-94：`/jupyter/*` 反代的**上游**。生产路径永远是"同一个容器里的 jupyter"
   * （`127.0.0.1:config.notebook.port`），这个口子只为测试开（宿主档要在临时端口上跑一个假上游）。
   * 它不是请求参数 ⇒ 客户端碰不到它，也指不了别处（把上游做成可配 = 给一个没鉴权的服务加一条 SSRF）。
   */
  notebookUpstream?: NotebookUpstream;
```

`buildApp` 里静态注册之前（靠近 `:957` 那一段）：

```ts
  // WI-94：同源反代。必须**先于** `@fastify/static` 注册？不 —— 路由匹配优先于 static 的 `/*`
  // （find-my-way 的 `/jupyter/*` 比根 `/*` 更具体），这条实测过；但顺序仍然放在 static 之前，
  // 是为了让"把这条注释删了以后仍看不出什么"的那种读者少一个理由。
  registerNotebookProxy(app, {
    ...(deps.notebookUpstream === undefined ? {} : { upstream: deps.notebookUpstream }),
    ...(deps.notebookGatewayAddresses === undefined ? {} : { gatewayAddresses: deps.notebookGatewayAddresses }),
  });
```

`import { registerNotebookProxy, type NotebookUpstream } from '../notebooks/proxy.js';`

- [ ] **Step 4: 让新文件被门禁认领**

`scripts/verify.sh`：
- 第 61 行那条 `run "单元测试…" npx vitest run --exclude server/test/notebooks/kernel.test.ts …` 再加一个 `--exclude server/test/notebooks/embed.test.ts`（它要在容器里才有判据对象；同时在那 55-60 行已有的"已知弱点"注释里补一句：新文件走的是同一条被登记的路）；
- 第 82 行 `run "Notebook 运行时（kernel 真跑）" env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run server/test/notebooks/kernel.test.ts` 追加 `server/test/notebooks/embed.test.ts`。

Run: `cd server && npx vitest run test/regression/verify-coverage.test.ts` → 必须绿（这一条就是"新闸门没接线"的探测器；改之前它应当是红的 —— **先跑一次确认它红**，再改 verify.sh）。

- [ ] **Step 5: 容器档闸门（真 Jupyter，这是"硬前提"的实测处）**

`server/test/notebooks/embed.test.ts`，门控与 `kernel.test.ts` 完全一致（`describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)`）+ 一条常驻的"门控本身"用例（照 `kernel.test.ts:796` 那一组）：

```ts
/**
 * 打到自己（宿主回环那半：容器里 curl 自己的 7788）与打到自己但**从非回环地址**（eth0）：
 * 前者应当放行，后者应当 403 —— 这一对是"守卫真的在位"的**唯一**证明形状。
 * 为什么不能用 fetch：fetch 会把你给的 Host 换掉（`kernel.test.ts:301-310` 实测过），
 * 所以这里复用同一形状的 `probeWithHostHeader`，并另加一条"能不能读到 body"的探针。
 */
const APP_PORT = config.port; // 7788：容器内自己的 API
```

要判的这几条（①②⑤ 三条的形状是 Task 3 实施时按实测改过的，原稿那版会常驻红，理由写在每条后面；
落地时还多了两条原稿没列的：一条在 HTTP 层判住守卫"对端那一半"的"对端外来 + Host 本机"组合，
一条**不注入** `gatewayAddresses`、用真 `/proc/net/route` 的网关当对端 ⇒ 200，那是上一档遗留的 I-3 那笔账）：
1. `GET /jupyter/tree`（对端 127.0.0.1，Host `127.0.0.1:7788`，`Sec-Fetch-Site: same-origin`）⇒ **200**，body 里含 `<html`。
   ⚠ 原稿这里写的是"且 body 不含 token（注入式而非透传的证据）"—— **判据前提被实测推翻**：
   Notebook 7 自己就把 token 写进树页的内嵌 PageConfig，直连上游、不经反代也一样有。
   改成判**差分**：经隧道那份"含不含凭据"必须与直连那份**一致**，加上**我们自己写的响应头**里没有凭据。
   （另见"完成判据 #3"那条收窄，以及"不许 `not.toContain(token)`"这条实现纪律。）
2. 同一条**不带** `Sec-Fetch-Site`（curl 形状）⇒ 200（缺席=非浏览器，放行；红在这里说明把'none'那一支写错了）。
3. `Sec-Fetch-Site: cross-site` ⇒ 403 + `notebook_cross_site`。
4. Host 写 `rebinding.example:7788` ⇒ **403**，而且是**我们**那层的 403（`error` 字段是 `bad_host` —— origin 钩子先拦；这条判"整个 origin 的钩子确实盖住了 `/jupyter/*` 这棵树"）。
5. 一次**真**写操作穿过隧道：`POST /jupyter/api/contents/smoke-<ts>.ipynb`（body 是 `{"type":"notebook","content":{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}}`）⇒ 2xx，然后 `GET` 同一份 ⇒ 200，最后 `DELETE` ⇒ 2xx。**这一条不许省**：它判的是"body 逐字节搬运真的没坏"（上游 `base/handlers.py:698-710` 的 `get_json_body` 要 `json.loads` 得动）。顺带钉住两件事**不需要**做：不需要 `_xsrf`、不需要给镜像加 `allowed_origins` —— 注入 token 之后这被算成 token 认证请求（三处源码位置记在 Step 2 的注释里，2026-10-09 在真容器里读的是 jupyter_server 2.21.1）。
   **所以这条测试里不许出现 `_xsrf`**：一次带着 `_xsrf` 的 201 同时被"代理剥了它"与"jupyter 本来就跳过检查"两种解释满足 ⇒ 什么都不判（本项目付过"mock 与 bug 同形"的学费，同一个形状）。红在这里该查的是 body 有没有被 Fastify 的解析器改过字节。
6. 从**非回环**的容器地址打自己的 7788（`http://${eth0}:7788/jupyter/tree`，Host 就是那个 eth0 地址）⇒ 403（`isLoopbackHostHeader` 那一半）；并把"回环上同一个请求是 200"作为对照一起断（`kernel.test.ts` 里"两条各判一件事，缺一条会把故障说错"的写法）。

Run: `./start.sh --verify > /tmp/wi94-t3-verify.log 2>&1; echo "CV_EXIT=$?"` → 全绿；`grep -c "skip" ` 在那一段区域内为 0。

- [ ] **Step 6: 破坏性验证**

1. 把 `guardNotebookProxy` 调用整块换成 `{ ok: true } as const` → 容器档的 3/4/6 与宿主档的 cross-site 那条必须一起红；
2. 把 `out['authorization']` 那行删掉 → 容器档第 1 与第 5 条必须红（红在 302/403 而不是"没人听"）；
3. 把 `proxiedPath` 里 `params.delete('token')` 删掉 → 宿主档"客户端塞 token"那条红；
4. 把 `removeContentTypeParser`/`'*'` 解析那两行删掉 → 宿主档"逐字节 body"那条必须红（它红的方式是键顺序变了 —— 如果它不红，这条测试是空的，重写它）；
5. 全部还原，`npm run verify:fast` + `./start.sh --verify` 再各跑一次，两个退出码都当场贴进注释与提交信息。

- [ ] **Step 7: Commit**（`feat(notebook): WI-94 Task 3 —— /jupyter 同源反代的 HTTP 隧道（守卫在注入之前）`）

---

## Task 4：WebSocket 隧道（内核与页面之间的第二条通道）

**为什么单独一档**：notebook 的"运行"按钮走的是 `/jupyter/api/kernels/<id>/channels` 上的 websocket。这一条不通，内嵌就是个只能看不能跑的截图；而它**结构上**测试不到 —— 它不在路由表里，浏览器又给不了 ws 握手加请求头，所以 token 只能走查询串。这两件事都必须有实测撑着。

**Files:**
- Modify: `server/src/notebooks/proxy.ts`（新增 `attachNotebookUpgrade` + `rejectUpgrade`，并在 `registerNotebookProxy` 里调用）
- Modify: `server/test/notebooks/proxy.test.ts`（宿主档：字节级双向管道 + 守卫否决）
- Modify: `server/test/notebooks/embed.test.ts`（容器档：真 kernel + 真 ws 帧往返）

**Interfaces:**
- Consumes: `proxiedPath(url, token, true)`、`buildUpstreamHeaders`、`guardNotebookProxy`（全部来自 Task 3，不新写判据）
- Produces: `attachNotebookUpgrade(server: http.Server, deps: { upstream: NotebookUpstream; authority: string; gatewayAddresses?: string[] }): void`

- [ ] **Step 1: 宿主档写红**

在 `proxy.test.ts` 里加一组"隧道层"的用例。这里**故意不做真的 websocket 帧**：隧道判的是 101 之后的**字节搬运**，字节级测试才是它的单元测试；真 ws 语义归容器档那条（Step 3）。

```ts
/** 上游先完成 101 握手，然后把收到的字节原样吐回来（echo）。握手那次也记进 seen。 */
let upgradeCount = 0;
async function startWsEcho(): Promise<number> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  srv.on('upgrade', (req, socket, head) => {
    upgradeCount++;
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, bodyBase64: '' });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    if (head && head.length) socket.write(head);
    socket.on('data', (b) => socket.write(b)); // echo：证明这条 socket 是双向 pipe 的
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as AddressInfo).port;
}

it('ws 握手：上游拿到 ?token=（我们那份），客户端塞的那份被摘，101 之后双向字节都到得了', async () => {
  const port = await startWsEcho();
  const wsApp = await injectApp({ token: CANARY, upstreamPort: port });
  const sock = net.connect(wsApp.port, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(
    `GET ${JUPYTER_BASE_URL}api/kernels/deadbeef/channels?session_id=1&token=injected-by-client HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${wsApp.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
      `Sec-Fetch-Site: same-origin\r\n\r\n`,
  );
  const head = await readUntil(sock, '\r\n\r\n');            // 本文件自写的工具：累积到分隔符为止
  expect(head.startsWith('HTTP/1.1 101')).toBe(true);
  expect(head.toLowerCase()).toContain('sec-websocket-accept');
  // 隧道建好之后按字节 echo：证明 socket 是**双向** pipe 的，不是只把客户端那半连上
  sock.write(Buffer.from([0x01, 0x02, 0xaa, 0xbb]));
  const echoed = await readBytes(sock, 4);
  expect([...echoed]).toEqual([0x01, 0x02, 0xaa, 0xbb]);
  sock.destroy();
  // 上游那一侧收到的握手：我们的 token 在、客户端塞的那份没了
  const got = seen.at(-1)!;
  expect(got.method).toBe('UPGRADE');
  expect(got.url).toContain(`token=${CANARY}`);
  expect(got.url).not.toContain('injected-by-client');
});

it('ws 也要过守卫：cross-site 的握手被拒，且上游一个 upgrade 都没收到', async () => {
  const before = upgradeCount;
  const sock = net.connect(...); // 同上但 `Sec-Fetch-Site: cross-site`
  const head = await readUntil(sock, '\r\n\r\n');
  expect(head).toMatch(/^HTTP\/1\.1 403/);
  expect(head.toLowerCase()).toContain('content-type: application/json');
  expect(upgradeCount).toBe(before);
});

it('不是 /jupyter/ 那棵子树的 upgrade 我们不接管（今天没有别人在听 ⇒ 连接被正常关掉，而不是被我们劫走）', async () => {
  const sock = net.connect(appPort, '127.0.0.1');
  sock.write(`GET /api/ide/repl HTTP/1.1\r\nHost: 127.0.0.1:${appPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  const head = await readUntil(sock, '\r\n\r\n');
  expect(head.startsWith('HTTP/1.1 101')).toBe(false);
});
```

- [ ] **Step 2: 实现 `attachNotebookUpgrade`**

```ts
/**
 * 第二条通道：内核↔页面的 websocket。`jupyter_server` 在这一条上跑的是**执行**，
 * 而它的握手有两个HTTP 隧道没有的性质：
 * ① 浏览器给原生 WebSocket 加不了请求头 ⇒ token 只能走 `?token=`（`proxiedPath(…, true)`）；
 * ② 它不走路由，所以 Fastify 的 onRequest 钩子与我们的 handler 都碰不到它 ——
 *    **守卫必须在 `upgrade` 事件里再判一次同一个函数**，否则"能打开页面"就变成了"能绕过页面执行代码"。
 * `head`（握手之后已到的一截字节）在隧道建好后写进对侧 socket，不写进 upstreamReq：
 * 那个请求没有 content-length，往它身上写字节会变成 chunked，把握手打成乱码。
 */
export function attachNotebookUpgrade(
  server: http.Server,
  deps: { upstream: NotebookUpstream; authority: string; gatewayAddresses?: string[] },
): void {
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith(JUPYTER_BASE_URL)) return; // 不归我们这棵树：交回给别的处理者（今天没有）
    const verdict = guardNotebookProxy({
      peerAddress: socket.remoteAddress ?? '',
      hostHeader: asHeader(req.headers.host),
      secFetchSite: asHeader(req.headers['sec-fetch-site']),
      ...(deps.gatewayAddresses === undefined ? {} : { gatewayAddresses: deps.gatewayAddresses }),
    });
    if (!verdict.ok) return rejectUpgrade(socket, verdict.status, verdict);
    const token = config.notebook.token;
    const upstreamReq = httpRequest(
      { host: deps.upstream.host, port: deps.upstream.port, method: 'GET', path: proxiedPath(url, token, true), headers: buildUpstreamHeaders(req.headers, deps.authority, token) },
      () => { /* 没有 'upgrade' 的回话走下面那个 'response' */ },
    );
    upstreamReq.on('upgrade', (ures, usocket, uhead) => {
      // 101 这一条**不能**照搬 HOP_BY_HOP 那一套：`Upgrade: websocket` 与 `Connection: Upgrade`
      // 正是"这是一个 101"的组成部分（RFC 6455 的握手回话必须带它们；Firefox 缺 Connection 会判失败）。
      // 逐跳头"不许转发"讲的是**已建立的普通请求**之间，握手例外。
      const lines = Object.entries(ures.headers)
        .filter(([k, v]) => v !== undefined && k !== ':status' && (!HOP_BY_HOP.has(k.toLowerCase()) || k === 'upgrade' || k === 'connection'))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) usocket.write(head);
      if (uhead && uhead.length) socket.write(uhead);
      usocket.pipe(socket);
      socket.pipe(usocket);
      usocket.on('error', () => socket.destroy());
      socket.on('error', () => usocket.destroy());
      socket.on('close', () => usocket.destroy());
    });
    upstreamReq.on('response', (res) => {
      // 上游不肯升级（403/404/503）：把状态码原样回给客户端再断 —— 静默断连最难查
      socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}\r\nconnection: close\r\n\r\n`);
      res.resume();
      socket.destroy();
    });
    upstreamReq.on('error', () => socket.destroy());
    upstreamReq.end();
  });
}

function rejectUpgrade(socket: Duplex, status: number, body: { error: string; message: string }): void {
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\n` +
      `content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
  );
  socket.destroy();
}
```

然后在 `registerNotebookProxy` 的末尾（Task 3 Step 2 留的那个位置）加上 `attachNotebookUpgrade(app, { upstream, authority, gatewayAddresses: deps.gatewayAddresses })`。
`import { once } from 'node:events'` / `type Duplex` 按需补。

- [ ] **Step 3: 容器档那条"真的跑起来一次"**

`embed.test.ts` 里加：

```ts
/**
 * 这条是整个 WI-94 的功能判据：隧道建起来之后，**在浏览器会用同一条地址上**把一个内核跑起来并执行一行。
 * 为什么用 `python3` 而不是 `arena-pyspark`：这一条判的是**通道**，与哪个 kernel 无关；
 * Spark 那一份要 ~180 秒的 JVM 启动，把它放进每条容器判据里会让整个阶段变成分钟级
 * （arena-pyspark 的真跑归 kernel.test.ts 那条 smoke，已经有）。
 * 为什么不是"打开一个 notebook 文件让它跑"：那要 `_xsrf` + contents + sessions 三件全对，
 * 一次红了分不清是哪一件。这里的顺序是显式的：POST sessions ⇒ 拿 model.id ⇒ ws 连 channels ⇒
 * 发一帧 execute_request ⇒ 收到 iopub stream/execute_reply。
 */
```

要做的：① `POST /jupyter/api/sessions`（JSON body `{"path":"smoke-session.ipynb","type":"notebook","kernel":{"name":"python3"}}`，**不带 `_xsrf`** —— 理由与实测的源码位置都记在 Task 3 Step 2 的注释里：注入 token 之后这是 token 认证请求，xsrf 与 origin 两道检查都被跳过）→ 断言 2xx 且 `json.model.kernel.execution_state` 最终为 `idle`/`starting`；
② 对该 session 的内核 `GET /jupyter/api/kernels/<id>/channels` 做**手工 ws 握手 + 手工帧编解码**（约 45 行：`maskKey = crypto.randomBytes(16)`、`Sec-WebSocket-Key: base64(…)`、客户端帧必须 `FIN|text + mask + 4 字节 mask key`，解析服务端那帧只需去掉 opcode 0x1 的长度与前 2/4/10 字节头）—— 发
`{"header":{"msg_id":"m1","msg_type":"execute_request","version":"5.3","username":"","session":"s1"},"parent_header":{},"metadata":{},"content":{"code":"print(6*7)","silent":false},"buffers":[]}`，
读若干帧直到 `content.text` 里出现 `42` 或收到 `execute_reply`；
③ `DELETE /jupyter/api/sessions/<id>` 收尾（别把内核留在跑着的状态里 —— WI-93 记过"Jupyter 无守护"，而它的反面是"容器档留下 10 个活内核"）。
断言失败消息必须区分三种故障：握手没 101 / 101 了但一帧都没回 / 回了但里面是 403。
④ 顺带一条：**跑完这条之后 7788 与 7789 都还活着**（再打一次 `/api/health`）—— 这是"隧道不会把宿主进程带走"的判据（本项目有过一条 `void` 掉的 async 逃逸把整个服务带走的事故）。

- [ ] **Step 4: 破坏性验证**

1. 删掉 `attachNotebookUpgrade(...)` 那一行（接线摘掉）→ 容器档 ws 那条必须红在"握手没 101"，宿主档那两条也红；
2. 把 `guardNotebookProxy` 在 upgrade 里那次调用摘掉 → cross-site 的握手那条必须红（**这条最重要**：它证明"HTTP 上拦住了"不等于"另一条通道也拦住了"）；
3. 把 `usocket.pipe(socket); socket.pipe(usocket)` 中的任意一行注释掉 → 宿主档 echo 那条红；
4. 还原并跑 `npm run verify:fast` + `./start.sh --verify`。

- [ ] **Step 5: Commit**（`feat(notebook): WI-94 Task 4 —— websocket 隧道（token 走查询串，守卫在 upgrade 里再判一次）`）

---

## Task 5：左栏的数据源 —— `GET /api/notebook/files`

**为什么走服务端读目录而不是透传 `/jupyter/api/contents`**：那棵树上的列目录要求 Jupyter 在跑；而页面在 Jupyter 没起来时**也必须**如实显示"目录里有 3 份笔记，服务没起"（这是本项目最恨的静默降级的反面）。`seedNotebooks()` 本来就在读同一个 `workDir`，readdir 是唯一一个在宿主档也能判的形状。

**Files:**
- Modify: `shared/src/notebook.ts`（`NotebookFilesResponse`）
- Create: `server/src/notebooks/files.ts`
- Modify: `server/src/api/app.ts`（路由）
- Modify: `web/src/api.ts`（客户端）
- Create: `server/test/api/notebook-files.test.ts`

**Interfaces:**
- Consumes: `config.notebook.workDir`
- Produces: `listNotebookFiles(dir?: string): NotebookFilesResponse`；`GET ${API_PREFIX}/notebook/files` → `NotebookFilesResponse`；`api.notebookFiles(opts?)`

- [ ] **Step 1: 契约 + 红的测试**

`shared/src/notebook.ts`：

```ts
/**
 * `GET /api/notebook/status` 的 `notebooks` 说的是"**这一次**铺了什么"（seed 的动作结果），
 * 而这一条说的是"工作目录里**现在**有什么"（左栏那棵树）。两个语义不许合并成一个字段：
 * 合并之后"铺过 3 份"与"目录里还剩 3 份"在改过文件的用户那儿会分家。
 */
export interface NotebookFilesResponse {
  /** 相对 workDir 的 .ipynb 文件名（不含路径），已排序 */
  files: string[];
  /** 「这一次读不到」的原因 —— 与"目录里就是没有"是两句话（`seedError` 那条纪律的同一条） */
  error?: string;
}
```

`server/test/api/notebook-files.test.ts`（宿主，用 `injectApp` 那套临时 `ARENA_DATA_DIR`）：

```ts
it('目录里有两份笔记 ⇒ 只列 .ipynb，按名字排，别的文件不出现', async () => {
  await writeFile(join(dir, 'b.ipynb'), '{}');
  await writeFile(join(dir, 'a.ipynb'), '{}');
  await writeFile(join(dir, 'checkpoint.txt'), 'x');
  const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` });
  expect(res.statusCode).toBe(200);
  expect(res.json().files).toEqual(['a.ipynb', 'b.ipynb']);
});
it('目录是空的 ⇒ files:[] 且没有 error（"没有"与"读不到"必须两句话）', async () => {
  const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` });
  const body = res.json() as NotebookFilesResponse;
  expect(body.files).toEqual([]);
  expect(body.error, '空目录不是故障；这里一旦出现 error 就是"把没有说成坏了"').toBeUndefined();
});
it('目录不存在 ⇒ files:[] 且没有 error：那是还没铺过示例，不是故障（铺失败的判据是 status 那条 seedError）', async () => {
  await rm(dir, { recursive: true, force: true });
  const body = (await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` })).json() as NotebookFilesResponse;
  expect(body).toEqual({ files: [] });
});
it('工作目录读不了 ⇒ files:[] + error，且那句说的是"读不到"', async () => {
  // chmod 000 在 Windows 上拦不住任何东西（ACL 不是 mode bits）⇒ 这一条用"名字是一个文件而不是目录"
  // 来造一个必然会失败的 readdir：跨平台、且不需要提权。skipIf 不用 try/catch（报告会写 skipped）。
  const filePath = join(dir, 'not-a-dir');
  await writeFile(filePath, 'x');
  const body = listNotebookFiles(filePath);
  expect(body.files).toEqual([]);
  expect(body.error, 'readdir 一个文件必须给 error，而不是空表').toContain('读不到 notebook 工作目录');
  expect(body.error).toMatch(/ENOTDIR|EINVAL|EPERM/);   // 平台差异只落在错误码上，不落在"有没有这句话"上
});
it('路由真的在（行首判据，不是 indexOf）', async () => {
  const src = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');
  expect(/^  app\.get\(`\$\{api\}\/notebook\/files`/m.test(src), 'WI-87 的学费：一条编辑把路由并进注释，indexOf 断言照样绿').toBe(true);
  expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/notebook/files` })).statusCode).toBe(200);
});
```

- [ ] **Step 2: 实现**

`server/src/notebooks/files.ts`：

```ts
import { readdirSync } from 'node:fs';
import { config } from '../config.js';
import type { NotebookFilesResponse } from '@arena/shared';

/**
 * 只读列目录：一次 readdirSync，不 stat 内容、不解析 ipynb。
 * 这个接口会被前端在每次进页面时调用，重活不许挂在读路径上（与 `status.ts` 顶部那条纪律同一条）。
 * ENOENT 归"没有"而非"坏了"：一个从没铺过示例的实例里那个目录本来就不存在，
 * 把它说成故障会让人去查磁盘，而该发生的事是"铺一份示例"（那正是同一个 GET 顺带做的 seed）。
 */
export function listNotebookFiles(dir: string = config.notebook.workDir): NotebookFilesResponse {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ipynb'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en'));
    return { files };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ⚠ 只豁免 ENOENT（Task 5 实测订正）。计划原稿在这里把 ENOTDIR 一起豁免了，
    // 而同一档第四条测试正是要判"workDir 指向一个普通文件 ⇒ 必须有 error"—— 两条不可能同时成立
    // （本机实测 readdir 一个普通文件给的就是 ENOTDIR）。实现者按"测试是契约"收窄成仅 ENOENT：
    // ENOENT = 那个目录本来就还没建（"没有"，不是故障）；ENOTDIR = 配置指错了地方，必须有自己的一句话。
    if (code === 'ENOENT') return { files: [] };
    return { files: [], error: `读不到 notebook 工作目录（${code ?? '未知原因'}）：${(err as Error).message}` };
  }
}
```

`server/src/api/app.ts` 里紧挨 `/api/notebook/prepare-env` 加：

```ts
  // MARK: /api/notebook/files（第五页左栏那棵树；读目录不读内容，Jupyter 没起来也照答）
  app.get(`${api}/notebook/files`, async (): Promise<NotebookFilesResponse> => listNotebookFiles());
```

`web/src/api.ts`：

```ts
  notebookFiles: (opts?: RequestOptions) => get<NotebookFilesResponse>('/notebook/files', { ...opts, label: '读取 notebook 列表' }),
```

- [ ] **Step 3: 宿主档 + 接线**

`verify-coverage` 会自动认领 `server/test/api/notebook-files.test.ts`（`server/test/api` 已被某阶段认领）—— 跑 `cd server && npx vitest run test/regression/verify-coverage.test.ts` 确认。
`npm run verify:fast > /tmp/wi94-t5.log 2>&1; echo "FAST_EXIT=$?"` → 0。

- [ ] **Step 4: 破坏性验证**（把路由整行注释掉 → 5 条里至少"路由真的在"与那 4 条功能用例都红；把 ENOENT 那一支删掉 → "目录不存在"那条红。还原再跑一次。）

- [ ] **Step 5: Commit**（`feat(notebook): WI-94 Task 5 —— /api/notebook/files（左栏数据源，与"这次铺了什么"分开）`）

---

## Task 6：第五页改成两栏（左树 + 右 notebook）

**Files:**
- Modify: `web/src/pages/Notebook.tsx`
- Modify: `web/src/styles/base.css`
- Modify: `web/test/notebook.test.tsx`
- Modify: `tests/e2e/notebook-page.spec.ts`

**Interfaces:**
- Consumes: `NOTEBOOK_PREFIX` / `JUPYTER_BASE_URL` / `notebookDocPath` / `NOTEBOOK_TREE_PATH`（shared）、`api.notebookFiles`、既有 `.card` / `.badge` / `.banner` / `--line` / `--radius-lg` token
- Produces: 新的 `data-testid`：`notebook-tree`、`notebook-tree-item`、`notebook-frame`、`notebook-manage`（"文件管理"入口）

- [ ] **Step 1: 先把单元层的判据改成"内嵌"的形状（红）**

`web/test/notebook.test.tsx` 里改/加（`api.notebookFiles` 需要在测试的 api 替身里补一个 mock）：

```ts
it('running:true 时页面渲染同源 iframe，默认落在"文件管理"，src 是 `/jupyter/` 且**不含 token**', () => {
  status.mockResolvedValue({ ...up, url: `http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}?token=x`, kernels: [], notebooks: [] });
  files.mockResolvedValue({ files: ['01-skew.ipynb'] });
  render(<Notebook />);
  const frame = await screen.findByTestId('notebook-frame');
  expect(frame.getAttribute('src')).toBe(JUPYTER_BASE_URL);
  expect(frame.getAttribute('src')).not.toContain('token');                 // 凭据不进页面（这一条是整个 WI-94 的目的）
  expect(screen.getByTestId('notebook-open').getAttribute('href')).toBe(`http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}?token=x`);
});

it('左栏点一份笔记 ⇒ iframe 的 src 换过去（换一次状态再看 DOM，不看首屏就算白测）', async () => {
  status.mockResolvedValue({ ...up, url: `http://127.0.0.1:7789${NOTEBOOK_TREE_PATH}`, kernels: [], notebooks: [] });
  files.mockResolvedValue({ files: ['01-skew.ipynb', '02-partitions.ipynb'] });
  render(<Notebook />);
  const frame = await screen.findByTestId('notebook-frame');
  expect(frame.getAttribute('src')).toBe(`${JUPYTER_BASE_URL}`);            // 默认落在文件管理
  const items = screen.getAllByTestId('notebook-tree-item');
  expect(items).toHaveLength(2);
  fireEvent.click(items[1]);
  expect(screen.getByTestId('notebook-frame').getAttribute('src')).toBe(notebookDocPath('02-partitions.ipynb'));
  expect(screen.getByTestId('notebook-frame')).toBe(frame);                 // 同一个 iframe 节点换 src，不重挂（重挂=每次点击都重启 jupyter 页面）
  fireEvent.click(screen.getByTestId('notebook-manage'));
  expect(screen.getByTestId('notebook-frame').getAttribute('src')).toBe(`${JUPYTER_BASE_URL}`);
});

it('文件列表读不到时补一句"读不到"，不把空列表说成"没有笔记"（seedError 那条纪律的孪生）', async () => {
  status.mockResolvedValue({ ...up, kernels: [], notebooks: [] });
  files.mockResolvedValue({ files: [], error: '读不到 notebook 工作目录（EPERM）：permission denied' });
  render(<Notebook />);
  expect(await screen.findByTestId('notebook-tree-error')).toHaveTextContent('读不到 notebook 工作目录');
  expect(screen.queryByTestId('notebook-tree-empty'), '读不到时说"目录里没有"就是第二条谎').not.toBeInTheDocument();
});

it('running:false 时**没有** iframe、没有树 —— 那棵子树结构上到不了，写一个空 iframe 就是谎', async () => {
  status.mockResolvedValue({ running: false, reason: '这个实例没有被给予 ARENA_JUPYTER_TOKEN …', kernels: [], notebooks: [] });
  render(<Notebook />);
  expect(await screen.findByTestId('notebook-down')).toBeInTheDocument();
  expect(screen.queryByTestId('notebook-frame')).not.toBeInTheDocument();
  expect(screen.queryByTestId('notebook-tree')).not.toBeInTheDocument();
  expect(files).not.toHaveBeenCalled();      // 服务没起时连那次 readdir 都不必发
});

it('文件列表读不到时补一句"读不到"，不把空列表说成"没有笔记"（seedError 那条纪律的孪生）', async () => {
  files.mockResolvedValue({ files: [], error: '读不到 notebook 工作目录（EACCES）：…' });
  /* 断言出现 data-testid="notebook-tree-error"，且不出现"目录里现在没有笔记"那句 */
});

it('内核徽章那一排没了，但「准备环境」与「spec 没注册」两条还在（前者修 venv，后者修镜像）', async () => {
  expect(screen.queryByTestId('notebook-kernels')).not.toBeInTheDocument();
  /* blocked / missingSpec 两条用例保持原样，仍要过 */
});
```

Run: `cd web && npx vitest run test/notebook.test.tsx` → 红在"iframe 不存在"。

- [ ] **Step 2: 页面结构**

`web/src/pages/Notebook.tsx` 的 return 顶部加两个 state 与一次读：

```tsx
  const [selected, setSelected] = useState<string | null>(null);
  const { data: listing } = useAsync(
    (signal) => (data?.running ? api.notebookFiles({ signal }) : Promise.resolve({ files: [] as string[] })),
    [data?.running],
  );
```

状态卡之后插入两栏（状态卡、`notebook-open` 那把逃生链接、`missingSpec`/`blocked`/`prepare`/`seedError` 各块**全部保留原位**，只删 `notebook-kernels` 那一排徽章）：

```tsx
      {view.kind === 'open' ? (
        <section className="card" data-testid="notebook-embed">
          <div className="nb-split">
            <div className="nb-tree" data-testid="notebook-tree">
              <div className="nb-tree-head small">笔记</div>
              <button type="button" className="nb-tree-item" data-testid="notebook-manage" onClick={() => setSelected(null)}>
                文件管理
              </button>
              {(listing?.files ?? []).map((f) => (
                <button
                  type="button"
                  key={f}
                  className={`nb-tree-item${selected === f ? ' is-active' : ''}`}
                  data-testid="notebook-tree-item"
                  aria-current={selected === f ? 'true' : undefined}
                  onClick={() => setSelected(f)}
                >
                  {f.replace(/\.ipynb$/i, '')}
                </button>
              ))}
              {listing?.error ? (
                <p className="tiny faint" data-testid="notebook-tree-error">{listing.error}</p>
              ) : (listing?.files ?? []).length === 0 ? (
                <p className="tiny faint" data-testid="notebook-tree-empty">目录里现在没有笔记：那是<span className="mono">没有</span>，不是读不到（读不到上面会单独点名）。</p>
              ) : null}
            </div>
            <iframe
              className="nb-frame"
              data-testid="notebook-frame"
              title="Jupyter notebook"
              src={selected === null ? `${JUPYTER_BASE_URL}` : notebookDocPath(selected)}
            />
          </div>
        </section>
      ) : null}
```

删掉 `notebook-kernels` 那一块（:176-185）并把 `kernels` 的用法留给 `blocked`/`missingSpec`；`tokenless` 那一块保留但措辞改指向"在新标签页打开"那条链接（内嵌这条路**没有** tokenless 这一态了 —— 守卫不过就是 403，页面会显示那个 403 的 JSON）。文件顶部的文档注释要重写这四态那一段并加第五件："内嵌这一路不带凭据，守卫不过就在隧道里回 403"。

- [ ] **Step 3: 边界卡折成 `<details>`**

把 `notebook-boundary` 那一块的 5 段 `<p>` 原样搬进：

```tsx
      <section className="card" data-testid="notebook-boundary">
        <details>
          <summary className="card-title">这页跟判题有什么关系（5 条边界，点开看）</summary>
          <div className="col small">
            {/* 原来那 5 个 <p> 逐字搬进来：措辞由 web/test/notebook.test.tsx 的 boundarySentences 钉着，不要顺手改写 */}
          </div>
        </details>
      </section>
```

`tests/e2e/notebook-page.spec.ts` 里"5 个 `<p>` + 含 127.0.0.1"那两条**先 `page.getByText('这页跟判题有什么关系').click()` 展开再断**（折叠着的元素 `toBeVisible` 必假 ⇒ 直接改断言会让它静默通过或冤红，两种都测不到东西）。

- [ ] **Step 4: CSS（三个类，沿用既有 token）**

`web/src/styles/base.css` 末尾：

```css
/* WI-94 第五页两栏。宽度给 220px 是"文件名不折行"的经验值，窄屏直接改成上下堆叠 ——
   内嵌的 iframe 永远不该把左栏挤没（320px 那次教训：Task 9 的第 5 个导航项把页头撞崩，
   判据在 tests/e2e/responsive.spec.ts）。 */
.nb-split {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--space-md, 12px);
  align-items: start;
}
@media (max-width: 900px) {
  .nb-split { grid-template-columns: minmax(0, 1fr); }
}
.nb-tree { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--line); border-radius: var(--radius-md); padding: 8px; }
.nb-tree-head { color: var(--muted, inherit); }
.nb-tree-item { text-align: left; background: none; border: 0; padding: 6px 8px; border-radius: var(--radius-sm); color: inherit; font: inherit; cursor: pointer; }
.nb-tree-item:hover { background: var(--hover, rgba(0, 0, 0, 0.04)); }
.nb-tree-item.is-active { font-weight: 600; text-decoration: underline; }
.nb-tree-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.nb-frame { width: 100%; height: clamp(480px, 78vh, 1100px); border: 1px solid var(--line-strong); border-radius: var(--radius-md); background: #fff; }
```

⚠ 写之前先 grep 一遍已有变量名（`--space-md` / `--hover` / `--muted` 未必存在）：**只用文件里真的定义过的变量**，没有就用字面量，别造一个没人定义的 token（它会静默 fallback 成 `inherit`/空值）。

- [ ] **Step 5: 单元 + 构建 + E2E**

```bash
cd web && npx vitest run test/notebook.test.tsx && cd .. 
npm run verify:fast > /tmp/wi94-t6-fast.log 2>&1; echo "FAST_EXIT=$?"
npm run e2e > /tmp/wi94-t6-e2e.log 2>&1; echo "E2E_EXIT=$?"
```
Expected: 三个都 0；`E2E` 那一档跑在 e2e 独立实例上（`127.0.0.1:7798`），它的 `running:false`  ⇒ 页面**不该**有 iframe。
⚠ **绝不占 7799**（宿主 CLI 桥的端口）。

- [ ] **Step 6: Commit**（`feat(notebook): WI-94 Task 6 —— 第五页两栏内嵌（同源 iframe），去掉内核徽章，边界卡折叠`）

---

## Task 7：三档 + 真浏览器实测 + 跨 session 记忆

这一档不是"收尾打磨"，而是本仓库对"前端改动"的最低验收（`dev_verify_workflow.md`「前端改动的额外一条」）。它可以在其它任务都批准之后单独被打回。

- [ ] **Step 1: 容器起来（entrypoint 改过 ⇒ 必须重建镜像）**

```bash
./start.sh --rebuild > /tmp/wi94-t7-build.log 2>&1; echo "BUILD_EXIT=$?"
```
Expected: `BUILD_EXIT=0`。**不许**用 `docker cp` 代替重建（那只活在当前容器实例里）。

- [ ] **Step 2: 容器档全量**

`./start.sh --verify > /tmp/wi94-t7-verify.log 2>&1; echo "CV_EXIT=$?"`
逐条核对并把实测值写下来：`CV_EXIT=0`；`grep -n "Notebook 运行时" /tmp/wi94-t7-verify.log` 命中**恰好一次**；那一段区域非空且区域里 `skip` 计数为 0（判据是**字节/行数**，`grep -c` 打在一个空的 `awk` 区间上会给出骗人的 0）；判题矩阵 `158 道全部可判、跳过 0`（题量若变，报矩阵自己的数）；`embed.test.ts` 的条数出现在汇总里。

- [ ] **Step 3: 宿主档全量 + E2E**

`npm run verify:fast > /tmp/wi94-t7-fast.log 2>&1; echo "FAST_EXIT=$?"` → 0
`npm run e2e > /tmp/wi94-t7-e2e.log 2>&1; echo "E2E_EXIT=$?"` → 全过（上一档是 `74 passed`，本轮会多 notebook 页那几条）。

- [ ] **Step 4: 真浏览器（Playwright MCP，打真人实例 `http://127.0.0.1:7788`）**

顺序与判据都是硬的，一条都不许省：
1. `browser_navigate` → `http://127.0.0.1:7788/#/notebook`；
2. `browser_console_messages` ⇒ **error 与 warning 都为 0**（warning 也算：本项目那次"切到 mysql 之后 python 的调试面板还赖在页面上"就是只在 warning 里出现的）；
3. `browser_snapshot` / `browser_evaluate` 断：`notebook-frame` 存在、它的 `src` 是 `/jupyter/…`、**整页 HTML 里不含 token 字符串**（从页面里读 `document.documentElement.innerHTML`，与 `.env` 的值比对，比对结果只报"含/不含"，**绝不打印 token**）；
4. 点左栏第一份示例笔记 ⇒ `src` 变成 `/jupyter/notebooks/<它>`；
5. **在 iframe 里真跑一次**：`browser_evaluate` 取 iframe 的 `contentDocument`（同源，读得到）确认 notebook UI 已加载、cell 计数 > 0；再用 Playwright 在 frame 里点 cell → `Enter` → `Shift+Enter`，等 `Out[ ]` 里出现结果。**这一步是"内嵌真能用"的唯一判据**，前四步都判不到它。若 `arena-pyspark` 起不来（venv 未建）就先点页面上的「准备环境」，等它完成再看 —— 那一条路径本来就在页面上；
6. **换一次状态再看 DOM**：切到 `#/`（今日）再切回 `#/notebook` ⇒ 只有一个 `notebook-frame`、没有残留的第二块面板；
7. **故意停顿 ~60 秒**（不碰它），再看：`/api/health` 仍 200、`/jupyter/api/status` 经隧道仍 200、console 仍 0 error/0 warning。这一条是为"按时间才爆"的故障准备的（本项目那条 unhandled rejection 把整个进程带走就是这样发现的）；
8. `browser_take_screenshot`（宽 1440 与 480 各一张）存到仓库外，人眼确认窄屏时两栏堆叠、iframe 不被挤没。

把 4-8 的实测值写进提交信息与 `memo.md`。任何一步做不到（例如 frame 里按键打不进 cell），**如实报告**并登记成新的 WI，不要把"页面渲染出来了"当成"能跑"。

- [ ] **Step 5: 记忆与工作板**

- `memo.md` 追加一个里程碑：做了什么 / 三档验证表（带真实退出码与计数）/ 已知问题 / 教训。教训至少要把这两条写进去：① 改 base_url 会打穿**所有**假设 jupyter 在根路径上的判据（本轮实际红的是哪几条）；② HTTP 上拦住了不等于另一条通道拦住了 —— `upgrade` 是一次独立判据的机会。
- `HANDOVER.md`：WI-94 → COMPLETED，附验证命令与实测结果；把 WI-94 那段"设计"文字改成"已实施的形状"（尤其别留下"7788 还没有 Host 白名单"那种已被终审 N1 作废的句子）；新增/更新这几条：`start.sh`/`start.ps1` 的探测路径、7789 那条"逃生链接"仍在（base_url 之下它是 `7789/jupyter/tree`）、以及 A2 现在能从哪一处接手（`NOTEBOOK_KERNELS` 加一条即可，`needsVenv` 那条坑见 WI-96）。

- [ ] **Step 6: Commit**（`docs+verify: WI-94 收尾 —— 三档实测值 + 真浏览器内嵌跑通 + memo/HANDOVER`）

---

## 完成判据（全部满足才算 WI-94 做完）

1. 三个退出码 `CV_EXIT=0` / `FAST_EXIT=0` / `E2E_EXIT=0`，且容器档 notebook 阶段确实跑了、区域里 `skip` 为 0、判题矩阵 `跳过 0`。
2. 真浏览器里：console error 与 warning 都为 0；iframe 里那份 notebook **真的执行了一行代码并出了结果**；切走再切回没有残留面板；停顿 60 秒服务还在。
3. **凭据只住在一个地方**（Task 3 落地后按实测收窄，原稿那句"页面上任何链接、任何响应体都不含 token"是**假的**）：
   ① **由我们生成**的东西 —— 自己拼的链接、响应头、错误消息、日志 —— 不含凭据；
   ② 上游 HTML 里那份 PageConfig token 是 jupyter 自己的既有形状（直连 7789 也一样有），由一条**差分断言**
   钉住"经隧道与直连含不含凭据必须一致"；把它列成"反代泄漏"是把既有事实记在新代码账上（裁定见台账 Ruling(4)，
   减暴露的后续动作登记为 WI-98）。
   ③ 附带一条实现纪律：**不许写 `expect(body).not.toContain(config.notebook.token)`** ——
   vitest 在失败时会把"期望不包含的那一串"印进报告，一次失败就把长期凭据写进测试输出（Task 3 实测撞到过一次）。
   统一走只返回布尔的 helper（`embed.test.ts` 的 `holdsToken()`），失败消息里只出现 `true`/`false`。
4. `/jupyter` 这个字面量只在 `shared/src/notebook.ts` 出现一次，其余全为派生或由闸门按派生值查文本。
5. `package.json`（server/web/shared 三处）一个字节都没变。
6. `memo.md` 里程碑 + `HANDOVER.md` 已移动 WI-94；每条新闸门的破坏性验证结果写在代码注释里而不是"应该会被抓到"。
