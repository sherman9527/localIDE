# Jupyter Notebook 运行时（A1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有单镜像里加一个常驻 Jupyter Notebook 服务 + 一个复用 IDE venv 的 PySpark kernel，并在前端新开第五页作为入口。

**Architecture:** Jupyter 由 `docker/entrypoint.sh` 与 mysqld/redis 同级拉起，只听容器内 `127.0.0.1:8888`，宿主机经 `127.0.0.1:7789:8888` 访问；服务端新增 `server/src/notebooks/`（探活 + 示例复制），前端 `web/src/pages/Notebook.tsx` 只做入口不嵌 iframe。PySpark kernel 的解释器指向 IDE 的命名卷 venv，于是"IDE 里装的包 notebook 能 import"成立，而判题仍然看不到那份环境（红线一不变）。

**Tech Stack:** Docker/Ubuntu 22.04、bash、Jupyter Notebook 7.x + ipykernel、PySpark 3.5.5（pip 包，非独立发行版）、Fastify、TypeScript、React 19 + Vite、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-05-jupyter-notebook-runtime-design.md`（执行时两份都读。本计划只覆盖 **A1**；A2 与 B 各在自己开工前单独出计划 —— A2 现在写就只能是占位符，它的内容取决于 spike 回来的事实）

## Global Constraints

- **只有一份 Spark**：`pyspark==3.5.5`（`docker/Dockerfile:16` 的 `ARG SPARK_VERSION`）。不引入第二份、不降级。
- **红线一（IDE 环境绝不注入判题）不变**，并新增一条延伸：notebook 的 shell（`!pip3 install`）必须解析到 IDE venv，不许写系统 site-packages。
- **每个发布端口都必须以 `127.0.0.1:` 开头**（`server/test/regression/compose-ports.test.ts:17` 的判据）；新增 7789 不得改判据。
- **kernelspec 只装镜像级目录** `/usr/local/share/jupyter/kernels/arena-pyspark/`，绝不装进 venv（venv 会被「重置环境」整个删掉）。
- **notebook 与判题各有自己的 warehouse / Derby**：`/app/data/notebook-warehouse/{wh,derby}`。
- **token 只有一个来源**（`.env` 的 `ARENA_JUPYTER_TOKEN`，与 `ARENA_LLM_BRIDGE_TOKEN` 共用同一套 helper），**且不得进日志**。
- **依赖真 Jupyter 的断言只在容器档跑**；跳过一律用 `it.skipIf` + 一条永远会跑的解释断言（`publish-identity.test.ts` 的形状），不许 `try/catch → return`。
- **提交身份逐条传**（WI-88 的署名闸门会拦本机 config 的默认身份）：
  `GIT_AUTHOR_NAME=sherman9527 GIT_AUTHOR_EMAIL=sherman9527@users.noreply.github.com GIT_COMMITTER_NAME=sherman9527 GIT_COMMITTER_EMAIL=sherman9527@users.noreply.github.com git commit ...`
- **任何改动都要跑验证**：TS/脚本 → `npm run verify:fast`；镜像/容器 → `./start.sh --verify`；前端 → 宿主 `npm run e2e` + 真浏览器（console error 与 warning 均 0，换一次状态，故意停一次）。
- **前置条件**：Task 2-4、10 需要 Docker Desktop 在跑（写本计划时它没起）。

---

### Task 1: 先立"notebook 不许把包写进系统环境"这条闸门

**Files:**
- Create: `server/test/regression/notebook-env-isolation.test.ts`

**Interfaces:**
- Consumes: `config.repoRoot`（`server/src/config.ts:51`）
- Produces: 无（纯测试）。它守的是 Task 2/3 的实现方向 —— 功能不存在时必须先红。

- [ ] **Step 1: 写结构断言（读 entrypoint，不依赖容器）**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 红线一的延伸：notebook 里的 `!pip3 install X` 跑的是 **shell**，而 shell 的 PATH 上默认那个
 * pip3 是**系统** pip ⇒ 包写进系统 site-packages ⇒ 判题用的正是那个解释器。
 * IDE 的命令窗口当初是靠"改写成 venv 的 python -m pip"堵掉的（ide/env-command.ts），
 * notebook 是同一件事的第二个入口。它坏掉的表征不是报错，是"某天判题结果变了" ——
 * 跟 notebook 隔了十万八千里，所以必须在功能存在之前先立住。
 */

const entrypoint = readFileSync(join(config.repoRoot, 'docker', 'entrypoint.sh'), 'utf8');

describe('notebook 的 shell 必须落进 IDE 的 venv（红线一延伸）', () => {
  it('entrypoint 有一行把 venv 的 bin 前置到 PATH', () => {
    // 判据取"这一行同时有 PATH= / ARENA_IDE_ENV_DIR / python/bin"，不要求 `jupyter notebook`
    // 在同一行 —— 实现里那是一个行尾续行符，两行写法才是 bash 的正常形状（Task 3）。
    // "是不是真给了 jupyter"由下面那条顺序断言管，两条合起来才闭合。
    const line = entrypoint
      .split('\n')
      .find((l) => l.includes('PATH=') && l.includes('ARENA_IDE_ENV_DIR') && l.includes('/python/bin'));
    expect(line, 'entrypoint 里没有"PATH 前置 venv"这一行 ⇒ notebook 里的 pip3 会命中系统 pip').toBeTruthy();
  });

  it('前置的 PATH 排在 jupyter 命令之前（写在后面等于没写）', () => {
    const atPath = entrypoint.search(/PATH="?\$\{?ARENA_IDE_ENV_DIR/);
    const atCmd = entrypoint.search(/jupyter notebook/);
    expect(atPath, '找不到 PATH 那一行').toBeGreaterThanOrEqual(0);
    expect(atCmd, '找不到起 jupyter 的那一行').toBeGreaterThanOrEqual(0);
    expect(atPath, 'PATH 必须出现在 `jupyter notebook` 之前').toBeLessThan(atCmd);
  });
});

describe('这条闸门的判据本身', () => {
  // 常驻反例：判据若退化成"提到过就行"，它会一直绿到出事那天。
  it('认得"PATH 写反位置"这种假实现', () => {
    const bad = 'exec jupyter notebook --allow-root\nPATH="${ARENA_IDE_ENV_DIR}/python/bin:$PATH"';
    expect(bad.search(/PATH="?\$\{?ARENA_IDE_ENV_DIR/) > bad.search(/jupyter notebook/)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑它，确认红是因为缺功能**

Run: `npx vitest run server/test/regression/notebook-env-isolation.test.ts`
Expected: 前两条 FAIL（消息含"找不到"），第三条 PASS。
若第一条就绿 ⇒ 判据命中了别的东西，收紧正则再往下走（别放行）。

- [ ] **Step 3: 确认它被快档认领**

`server/test/regression/` 已被 `scripts/verify.sh:35` 整目录认领（`verify-coverage` 会替你核）。

Run: `npm run verify:fast`
Expected: FAIL 在"单元测试"，红点名 notebook-env-isolation —— 这是**预期**的红。

- [ ] **Step 4: 提交**

```bash
git add server/test/regression/notebook-env-isolation.test.ts
GIT_AUTHOR_NAME=sherman9527 GIT_AUTHOR_EMAIL=sherman9527@users.noreply.github.com \
GIT_COMMITTER_NAME=sherman9527 GIT_COMMITTER_EMAIL=sherman9527@users.noreply.github.com \
git commit --no-verify -m "test(notebook): 先立住 notebook 的 shell 必须落进 IDE venv 这条延伸红线"
```

`--no-verify` 是故意的：这条 commit 只带一个明知为红的测试，跑快档只浪费 45s。Task 3 把它转绿。

---

### Task 2: 镜像层 —— Jupyter 依赖与 arena-pyspark kernelspec

**Files:**
- Modify: `docker/Dockerfile:62-74`
- Create: `docker/jupyter/kernels/arena-pyspark/kernel.json`
- Create: `server/test/regression/notebook-image.test.ts`

**Interfaces:**
- Consumes: compose 设的 `ARENA_IDE_ENV_DIR`（当前 `/opt/arena-ide-env`）
- Produces: 镜像里的 `/usr/local/share/jupyter/kernels/arena-pyspark/kernel.json`（Task 10 读它）

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * kernelspec 有三条各自会咬人的判据：
 * ① 必须装在**镜像级**目录 —— 装进 venv 的话，WI-87 的「重置环境」会把 kernel 一起删掉，
 *    而界面只显示"打不开"，不解释为什么；
 * ② argv[0] 必须等于 compose 里 ARENA_IDE_ENV_DIR 派生出来的解释器路径 —— 写死字面量就是
 *    第二处真相，compose 一改就悄悄不成立（本仓库对这类"两处各写一遍"栽过很多次）；
 * ③ Spark 的配置只能待在 PYSPARK_SUBMIT_ARGS 里，且必须以 `pyspark-shell` 收尾：
 *    写成普通环境变量**完全没效果**，少了尾缀则 --conf 会被当成应用参数。
 */

const root = config.repoRoot;
const kernel = JSON.parse(
  readFileSync(join(root, 'docker', 'jupyter', 'kernels', 'arena-pyspark', 'kernel.json'), 'utf8'),
) as { argv: string[]; display_name: string; env?: Record<string, string> };
const compose = readFileSync(join(root, 'compose.yml'), 'utf8');
const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8');

describe('arena-pyspark kernelspec', () => {
  it('argv 指向 venv 解释器，且 venv 根与 compose 的 ARENA_IDE_ENV_DIR 一致', () => {
    const dir = /ARENA_IDE_ENV_DIR:\s*(\S+)/.exec(compose)?.[1];
    expect(dir, 'compose 没设 ARENA_IDE_ENV_DIR ⇒ 没法核对 kernel 路径').toBeTruthy();
    expect(kernel.argv[0]).toBe(`${dir}/python/bin/python`);
    expect(kernel.argv).toEqual(expect.arrayContaining(['-m', 'ipykernel_launcher', '{connection_file}']));
  });

  it('display_name 不写死 Spark 版本（版本号只在 Dockerfile 的 ARG 里）', () => {
    expect(kernel.display_name).toBe('PySpark (arena)');
    expect(kernel.display_name).not.toMatch(/3\.\d+\.\d+/);
  });

  it('Spark 配置走 PYSPARK_SUBMIT_ARGS：含 --master、pyspark-shell 尾缀、独立 warehouse 与 Derby', () => {
    const args = kernel.env?.PYSPARK_SUBMIT_ARGS ?? '';
    expect(args).toContain('pyspark-shell');
    expect(args).toContain('--master local[2]');
    expect(args).toContain('spark.sql.warehouse.dir=/app/data/notebook-warehouse/wh');
    expect(args).toContain('-Dderby.system.home=/app/data/notebook-warehouse/derby');
    expect(kernel.env?.SPARK_LOCAL_IP).toBe('127.0.0.1');
  });

  it('Dockerfile 把它 COPY 进镜像级目录并当场断言，且没有 ipykernel install --user 这类写法', () => {
    const copy = dockerfile.split('\n').find((l) => l.includes('arena-pyspark/kernel.json'));
    expect(copy, 'Dockerfile 没把 kernel.json COPY 进镜像').toBeTruthy();
    expect(copy).toContain('/usr/local/share/jupyter/kernels/arena-pyspark/');
    expect(copy).not.toContain('arena-ide-env');
    expect(dockerfile).not.toMatch(/ipykernel install[^\n]*(--user|arena-ide-env)/);
  });
});
```

- [ ] **Step 2: 跑它确认红在"文件不存在"**

Run: `npx vitest run server/test/regression/notebook-image.test.ts`
Expected: FAIL —— `ENOENT ... kernel.json`。

- [ ] **Step 3: 写 `docker/jupyter/kernels/arena-pyspark/kernel.json`**

```json
{
  "argv": [
    "/opt/arena-ide-env/python/bin/python",
    "-m",
    "ipykernel_launcher",
    "-f",
    "{connection_file}"
  ],
  "display_name": "PySpark (arena)",
  "language": "python",
  "interrupt_mode": "signal",
  "env": {
    "PYSPARK_SUBMIT_ARGS": "--conf spark.sql.warehouse.dir=/app/data/notebook-warehouse/wh --conf spark.driver.extraJavaOptions=-Dderby.system.home=/app/data/notebook-warehouse/derby --master local[2] --driver-memory 512m pyspark-shell",
    "SPARK_LOCAL_IP": "127.0.0.1",
    "PYSPARK_DRIVER_PYTHON": "/opt/arena-ide-env/python/bin/python"
  }
}
```

- [ ] **Step 4: 改 Dockerfile**

把 `docker/Dockerfile:66` 那条 pip 扩成（沿用 mirrors.sh 已配的国内源，不新增源）：

```dockerfile
    && pip3 install --no-cache-dir "pyspark==${SPARK_VERSION}" "pandas>=2.2,<3" \
         "notebook>=7,<8" "ipykernel>=6,<7" "nbformat>=5.9,<6" "nbclient>=0.8" \
    && python3 -c "import pyspark, os; print('pyspark', pyspark.__version__)"
```

在 jar 软链那段之后加 COPY + 构建期自检（自检失败就让 build 红，而不是等用户点开才发现 kernel 没了）：

```dockerfile
# kernel 的解释器是 venv（IDE 那份），但 kernelspec 本体必须在镜像级目录：
# venv 会被 IDE 的「重置环境」整个删掉（server/src/ide/reset.ts），装在里面等于让用户一键删掉 kernel。
COPY docker/jupyter/kernels/arena-pyspark/kernel.json /usr/local/share/jupyter/kernels/arena-pyspark/kernel.json
RUN test -s /usr/local/share/jupyter/kernels/arena-pyspark/kernel.json \
    && jupyter kernelspec list 2>/dev/null | grep -q arena-pyspark
```

- [ ] **Step 5: 验证**

Run: `npx vitest run server/test/regression/notebook-image.test.ts`
Expected: 4 passed。`npm run verify:fast` 仍在 Task 1 那两条上红（预期）。

- [ ] **Step 6: 提交**（身份逐条传，`--no-verify`）

---

### Task 3: entrypoint —— 起 Jupyter、PATH 前置、缺 token 不起

**Files:**
- Modify: `docker/entrypoint.sh`（`start_redis` 之后、`exec "$@"` 之前）
- Test: `server/test/regression/notebook-env-isolation.test.ts`（Task 1 写的，本任务让它绿）

**Interfaces:**
- Consumes: 镜像里的 `jupyter` CLI、`$ARENA_IDE_ENV_DIR`、`$ARENA_JUPYTER_TOKEN`
- Produces: 容器内 `127.0.0.1:8888` 的 Jupyter（Task 4 映射它，Task 7 探它）

- [ ] **Step 1: 实现**

```bash
# Jupyter 是"可以不起"的服务：起不来不许拖垮做题与判题（它跟 mysqld/redis 的关键性不同），
# 所以失败只 log 一行，由 /api/notebook/status 如实报 running:false + reason。
start_jupyter() {
  mkdir -p /app/data/notebooks /app/data/notebook-warehouse/wh /app/data/notebook-warehouse/derby

  # 没有 token 就**不起**，而不是起一个无鉴权的：.env 是唯一来源（start.sh 首启生成）。
  # 静默降级成空 token 会让"回环 + 无鉴权"这个本来已经说清楚的例外，再多一个没人知道的口子。
  if [ -z "${ARENA_JUPYTER_TOKEN:-}" ]; then
    log "Jupyter 未启动：缺 ARENA_JUPYTER_TOKEN（用 ./start.sh 启动会自动生成到 .env）"
    return 0
  fi

  # venv 前置到 PATH：notebook 里 `!pip3 install X` 走 shell，命中哪个 pip 由 PATH 决定。
  # 不加这一句包会写进系统 site-packages —— 而判题用的正是那个解释器（红线一延伸，判据见
  # server/test/regression/notebook-env-isolation.test.ts）。必须写在命令之前。
  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \
  jupyter notebook --allow-root --no-browser \
    --ServerApp.ip=127.0.0.1 --ServerApp.port=8888 \
    --ServerApp.token="${ARENA_JUPYTER_TOKEN}" \
    --ServerApp.root_dir=/app/data/notebooks \
    >/var/log/jupyter.log 2>&1 &

  log "Jupyter 已拉起（容器内 127.0.0.1:8888）"
  return 0
}

start_jupyter
```

插入位置：紧接现有 `start_redis || exit 1` 之后、`mkdir -p /app/data/judge /app/data/spark-warehouse` 之前；`exec "$@"` 保持最后。

- [ ] **Step 2: 跑闸门转绿**

Run: `npx vitest run server/test/regression/notebook-env-isolation.test.ts` → 3 passed。

- [ ] **Step 3: 脚本自检（`bash -n` + CR 字节，仓库硬规矩）**

Run: `bash -n docker/entrypoint.sh && npx vitest run server/test/regression/scripts-syntax.test.ts`
Expected: `bash -n` 无输出；语法闸门 9 passed。

- [ ] **Step 4: 破坏性验证（两次都要亲眼看到红）**

① 删掉 `PATH=` 那一行前缀 ⇒ Task 1 第 1 条红；② 把 `PATH=` 那行挪到 `jupyter notebook` 之后 ⇒ 第 2 条红。各还原一次。

- [ ] **Step 5: 提交**（`--no-verify`；message 写明"把 Task 1 的红转绿"）

---

### Task 4: token 管线与端口 —— start.sh / start.ps1 / compose

**Files:**
- Modify: `start.sh:45-55`（把 `read_env_token` / `write_env_token` 泛化成按 key 的通用函数，桥与 notebook 共用）
- Modify: `start.ps1:45-66`（同一套判据的 PowerShell 实现）
- Modify: `compose.yml`（arena 加端口 + `ARENA_JUPYTER_TOKEN` 透传；e2e/tools 不加）
- Create: `server/test/regression/notebook-compose.test.ts`

**Interfaces:**
- Consumes: `.env`
- Produces: 容器内 `ARENA_JUPYTER_TOKEN`（Task 3 用）、宿主机 `127.0.0.1:7789`、服务端 `process.env.ARENA_JUPYTER_TOKEN`（Task 7 读）

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 三条各守一个真出过事的形状：
 * ① 7789 必须绑回环（compose-ports 整仓管，这里补"这条存在 + 端口号没被复用作别的"）；
 * ② token 是 `${VAR:-}` 透传而不是字面量 —— WI-86 的教训：判形状不判值；
 * ③ e2e 服务不许映射 7789：E2E 不该依赖一个真 notebook 服务器，也不该跟真人实例抢同一端口号。
 */
const compose = readFileSync(join(config.repoRoot, 'compose.yml'), 'utf8');
const arena = compose.slice(compose.indexOf('  arena:'), compose.indexOf('  tools:'));
const e2e = compose.slice(compose.indexOf('  e2e:'));

describe('notebook 的端口与 token 接线', () => {
  it('arena 发布了 127.0.0.1:7789:8888', () => {
    expect(arena).toMatch(/- "127\.0\.0\.1:7789:8888"/);
    expect(arena, 'notebook 端口没写"为什么绑回环 / 手机打不开"的注释').toContain('手机');
  });

  it('token 是透传形状，不是字面量', () => {
    const line = arena.split('\n').find((l) => l.includes('ARENA_JUPYTER_TOKEN'));
    expect(line, 'arena 没透传 ARENA_JUPYTER_TOKEN ⇒ entrypoint 永远缺 token，notebook 起不来').toBeTruthy();
    expect(line).toMatch(/\$\{ARENA_JUPYTER_TOKEN:-\}/);
    expect(line).not.toMatch(/:\s*[A-Za-z0-9_-]{16,}/);
  });

  it('e2e 不发布 7789', () => {
    expect(e2e).not.toContain('7789');
  });

  it('宿主端口号没有重复使用（两个服务抢同一个端口是最难查的一类"起不来"）', () => {
    const ports = [...compose.matchAll(/- "127\.0\.0\.1:(\d+):/g)].map((m) => m[1]);
    expect(ports.length, '一条端口映射都没扫到 ⇒ 本条在空转').toBeGreaterThanOrEqual(3);
    const dup = ports.filter((p, i) => ports.indexOf(p) !== i);
    expect(dup, `重复的宿主端口：${dup.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它确认红**（7789 与 token 都还没有）

- [ ] **Step 3: 泛化 start.sh 的 .env helper**

`start.sh:45-55` 换成通用版 + 两组 wrapper（**一处实现两处用**，否则将来一定有一处说假话）：

```bash
read_env_key() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

write_env_key() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

read_env_token() { read_env_key ARENA_LLM_BRIDGE_TOKEN; }
write_env_token() { write_env_key ARENA_LLM_BRIDGE_TOKEN "$1"; }

# notebook 的 token 与桥同一纪律：唯一来源是 .env（已 gitignore），只在本机之间传递，不进日志。
read_env_jupyter_token() { read_env_key ARENA_JUPYTER_TOKEN; }
write_env_jupyter_token() { write_env_key ARENA_JUPYTER_TOKEN "$1"; }
```

在 `start_bridge` 生成桥 token 的同一处补上（**缺才生成**：每次换 token 而容器还在跑，就会得到桥/服务端 token 与 entrypoint 不一致的错配）：

```bash
  if [ -z "$(read_env_jupyter_token)" ]; then
    write_env_jupyter_token "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    say "已生成 notebook 的 Jupyter token（.env → ARENA_JUPYTER_TOKEN）"
  fi
```

并在 `report_health` 之后把它说给人看（只打印到终端，不写日志文件）：

```bash
say "Notebook：http://127.0.0.1:7789/tree?token=$(read_env_jupyter_token)（页面第五项 Notebook 也能拿到）"
```

- [ ] **Step 4: compose**

`arena.ports` 追加：

```yaml
      # notebook 同样只绑回环：它等于"任意代码执行 + 能读题库文件"，开到局域网比 /api/bank 严重。
      # 代价一样：手机 / iPad 打不开（已确认不需要）。闸门：notebook-compose.test.ts
      - "127.0.0.1:7789:8888"
```

`arena.environment` 追加 `ARENA_JUPYTER_TOKEN: ${ARENA_JUPYTER_TOKEN:-}`。`e2e` 与 `tools` 都不加端口、但要加这个 env（`tools`/`dev` 里跑容器档测试时 Task 10 需要它）。

- [ ] **Step 5: start.ps1 镜像同一套判据**

`Read-EnvKey` / `Write-EnvKey` + 两组 wrapper（桥与 jupyter 各一对）、生成一处、打印一处。
**必须保留 UTF-8 BOM**；改完跑：
`powershell -NoProfile -Command "$t=[IO.File]::ReadAllText('start.ps1');$e=$null;[Management.Automation.PSParser]::Tokenize($t,[ref]$e)|Out-Null;$e.Count"` → `0`。

- [ ] **Step 6: 验证**

Run: `npx vitest run server/test/regression/notebook-compose.test.ts server/test/regression/compose-ports.test.ts server/test/regression/scripts-syntax.test.ts && bash -n start.sh`
Expected: 全绿（compose-ports 仍绿 = 新端口绑回环被认可）。

- [ ] **Step 7: 破坏性验证**

① 端口写成 `7789:8888` ⇒ `compose-ports` 红；② token 写成字面量 ⇒ notebook-compose 第 2 条红；③ 在 e2e 里也加 7789 ⇒ 第 3 条红。各还原。

- [ ] **Step 8: 提交**（`--no-verify`）

---

### Task 5: shared 契约与 config 键

**Files:**
- Create: `shared/src/notebook.ts`；Modify: `shared/src/index.ts`
- Modify: `server/src/config.ts`（`config` 对象加 `notebook` 段）
- Create: `server/test/regression/notebook-contract.test.ts`

**Interfaces（Task 7/8/9 全按这个形状写，名字必须一致）:**
- Produces:

```ts
export interface NotebookKernel { id: string; label: string; ready: boolean; reason?: string }
export interface NotebookFile { file: string; seeded: boolean }
export interface NotebookStatusResponse {
  running: boolean;
  url?: string;          // url 是本机地址；带不带 token 判的是 socket 对端地址：回环或本进程默认网关 ⇒ 带（compose 里宿主浏览器经网桥 NAT 进来，对端是网关而非回环），其余对端拿到的不含；网关那一半的安全性是派生的，前提是发布端口全绑 127.0.0.1（闸门 compose-ports.test.ts）
  reason?: string;       // running:false 时必填
  kernels: NotebookKernel[];
  notebooks: NotebookFile[];
}
export interface NotebookPrepareResponse { ok: boolean; reason?: string }
export const NOTEBOOK_KERNELS = { pyspark: 'arena-pyspark' } as const;
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';

describe('notebook 契约与配置', () => {
  it('config.notebook 各字段都在 dataDir 下，且不碰判题沙箱目录', () => {
    expect(config.notebook.publicUrl).toBe('http://127.0.0.1:7789');
    expect(config.notebook.port).toBe(8888);
    expect(config.notebook.workDir).toBe(`${config.dataDir}/notebooks`);
    expect(config.notebook.warehouseDir).toBe(`${config.dataDir}/notebook-warehouse`);
    expect(config.notebook.warehouseDir, '混进判题沙箱目录就会互删（判题跑完要清空 data/judge）').not.toContain('judge');
  });

  it('kernel id 只有一份真相（entrypoint、镜像、前端、测试都用这个常量）', () => {
    expect(NOTEBOOK_KERNELS.pyspark).toBe('arena-pyspark');
  });
});
```

- [ ] **Step 2: 跑它确认红**（`config.notebook` 不存在、`NOTEBOOK_KERNELS` 未导出）

- [ ] **Step 3: 写 `shared/src/notebook.ts`**（上面那段类型与常量，加一句 doc：为什么 `seeded` 是"这次铺了"而不是"文件存在"）
并在 `shared/src/index.ts` 末尾加 `export * from './notebook.js';`

- [ ] **Step 4: config 加一段**（形状照 `config.mysql` / `config.redis`）

```ts
  notebook: {
    port: Number(process.env.ARENA_JUPYTER_PORT ?? 8888),
    // 宿主机上的地址：compose 把 8888 发布到 127.0.0.1:7789，前端拿它拼链接
    publicUrl: process.env.ARENA_NOTEBOOK_PUBLIC_URL ?? 'http://127.0.0.1:7789',
    token: process.env.ARENA_JUPYTER_TOKEN ?? '',
    workDir: join(dataDir, 'notebooks'),
    warehouseDir: join(dataDir, 'notebook-warehouse'),
    seedDir: join(repoRoot, 'content', 'notebooks'),
  },
```

- [ ] **Step 5: 验证**：`npx vitest run server/test/regression/notebook-contract.test.ts && npm run typecheck` → 2 passed、0 错。

- [ ] **Step 6: 提交**（正常跑快档）

---

### Task 6: seed —— 示例只补缺，绝不覆盖用户改过的

**Files:**
- Create: `server/src/notebooks/seed.ts`
- Create: `content/notebooks/00-smoke-pyspark.ipynb`
- Create: `server/test/notebooks/seed.test.ts`

**Interfaces:**
- Consumes: `config.notebook.seedDir` / `workDir`（Task 5）
- Produces: `export async function seedNotebooks(opts?: { srcDir?: string; dstDir?: string }): Promise<NotebookFile[]>`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { seedNotebooks } from '../../src/notebooks/seed.js';

/**
 * 唯一的硬规矩是**不许覆盖**：用户写的内容只在 data/notebooks（bind mount），
 * 而 content/notebooks 每次 build 都进镜像 —— 无条件复制的话，一次 `--rebuild` 就吃掉人家的改动，
 * 而且一声不响。所以"改了还在"必须是断言，不能靠实现记得判断。
 */
async function dirs(): Promise<{ src: string; dst: string }> {
  const base = await mkdtemp(join(tmpdir(), 'arena-seed-'));
  const src = join(base, 'src');
  await mkdir(src, { recursive: true });
  return { src, dst: join(base, 'dst') };
}

describe('seedNotebooks', () => {
  it('目标缺失时复制并报告复制了哪几份', async () => {
    const { src, dst } = await dirs();
    await writeFile(join(src, 'a.ipynb'), '{"cells":[],"metadata":{"kernelspec":{"name":"arena-pyspark"}}}', 'utf8');
    const out = await seedNotebooks({ srcDir: src, dstDir: dst });
    expect(out).toEqual([{ file: 'a.ipynb', seeded: true }]);
    await expect(readFile(join(dst, 'a.ipynb'), 'utf8')).resolves.toContain('arena-pyspark');
  });

  it('用户改过的文件不许被还原', async () => {
    const { src, dst } = await dirs();
    await mkdir(dst, { recursive: true });
    await writeFile(join(src, 'a.ipynb'), '{"cells":[],"metadata":{}}', 'utf8');
    await writeFile(join(dst, 'a.ipynb'), '{"cells":[{"cell_type":"markdown","source":"我写的东西"}],"metadata":{}}', 'utf8');
    const out = await seedNotebooks({ srcDir: src, dstDir: dst });
    expect(out).toEqual([{ file: 'a.ipynb', seeded: false }]);
    await expect(readFile(join(dst, 'a.ipynb'), 'utf8')).resolves.toContain('我写的东西');
  });

  it('只认 .ipynb，别的文件不搬', async () => {
    const { src, dst } = await dirs();
    await writeFile(join(src, 'README.md'), 'x', 'utf8');
    await writeFile(join(src, 'b.ipynb'), '{"cells":[]}', 'utf8');
    expect(await seedNotebooks({ srcDir: src, dstDir: dst })).toEqual([{ file: 'b.ipynb', seeded: true }]);
  });
});
```

- [ ] **Step 2: 跑它确认红**（模块不存在）

- [ ] **Step 3: 实现（用 `stat` 先判存在，再 `copyFile`）**

```ts
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import type { NotebookFile } from '@arena/shared';

/**
 * 把仓库里的示例 notebook 铺进工作目录，**只补缺**。
 * `seeded` 说的是"这一次复制了它"，不是"文件存在" —— 前端用它区分"新铺的示例"与"你已有的那一份"。
 * 已存在的目标一律不碰：覆盖用户写的东西这件事不会报错，是本仓库最恨的那类静默损坏。
 */
export async function seedNotebooks(opts: { srcDir?: string; dstDir?: string } = {}): Promise<NotebookFile[]> {
  const srcDir = opts.srcDir ?? config.notebook.seedDir;
  const dstDir = opts.dstDir ?? config.notebook.workDir;
  await mkdir(dstDir, { recursive: true });

  const entries = await readdir(srcDir).catch(() => [] as string[]); // 没有示例目录不算错
  const out: NotebookFile[] = [];
  for (const name of entries.filter((n) => n.endsWith('.ipynb')).sort()) {
    const dstPath = join(dstDir, name);
    const already = await stat(dstPath).then(() => true).catch(() => false);
    if (already) {
      out.push({ file: name, seeded: false });
      continue;
    }
    await copyFile(join(srcDir, name), dstPath);
    out.push({ file: name, seeded: true });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试转绿** → `npx vitest run server/test/notebooks/seed.test.ts` → 3 passed。

- [ ] **Step 5: 写 `content/notebooks/00-smoke-pyspark.ipynb`**

nbformat v4 骨架，`metadata.kernelspec = { name: "arena-pyspark", display_name: "PySpark (arena)", language: "python" }`，**不含 outputs**（outputs 属于执行产物；抄进 git 会让"教程里的数字"不可追）。四个 cell：

```python
# cell 1 (markdown): 这份 notebook 只回答一个问题 —— arena-pyspark kernel 真能起 Spark 吗？
#   （cell 里不许出现里程碑编号或验证命令名：它是用户会打开看的东西，描述"该做什么"而不是"第几步"。评审 M11）
#   四个 cell 都带 `id` 字段（nbformat 4.5 声明它；不带的话 nbconvert 只能现场回填。评审 M10）
# cell 2 (code):
import sys
print("python", sys.executable)
# cell 3 (code): 打的是 **id 之和**，不是行数 —— 与 Task 10 那条 `/rows 15/` 判据同一个数（评审 I-1）
from pyspark.sql import SparkSession, functions as f
spark = SparkSession.builder.appName("arena-smoke").getOrCreate()
print("rows", int(spark.range(6).agg(f.sum("id")).collect()[0][0]))  # 0+1+2+3+4+5 = 15
# cell 4 (code): 红线一延伸的正面证据 —— 解释器必须在 IDE 的 venv 里
assert sys.executable.startswith("/opt/arena-ide-env/"), sys.executable
print("venv ok")
```

- [ ] **Step 6: 提交**（正常跑快档）

---

### Task 7: status —— 探活、kernelspecs、token 只给本机对端

> **更正（实施时 · 评审 M-1）**：本节原稿把"链接里附不附 token"判在 **Host 头**上，而那个头是客户端自己写的 ——
> 局域网里任何请求把 `Host:` 填成 `127.0.0.1:7788` 就换到一条带凭据的链接。现在写进代码的判据是**内核给的对端地址**
> （`request.raw.socket.remoteAddress`），Host 头只用于展示、不参与判定。"本机"有两种形状：宿主直跑 = 对端是回环；
> compose（唯一拿到 token 的实例）里宿主浏览器经 docker-proxy / NAT 从网桥进来，对端是**本进程自己的默认网关**
> （读 `/proc/net/route`，不是猜网段 +1）—— 只认回环不会报错，它让这功能在唯一启用它的部署里静默失效。
> 也不拿正则扫地址串：`::1:7788` 是合法 IPv6 而非"回环+端口"，`'localhost'` 是名字不是地址，按地址族逐条判。
> 下面各段已按此改写；钉住它的是 `server/test/notebooks/status.test.ts`（那句 `@ts-expect-error` 让 `hostHeader`
> 再也进不了入参）与 `server/test/api/notebook-api.test.ts`。

**Files:**
- Create: `server/src/notebooks/status.ts`
- Create: `server/test/notebooks/status.test.ts`

**Interfaces:**
- Consumes: `config.notebook.{port,publicUrl,token}`、Jupyter 的 `/api/status` 与 `/api/kernelspecs`
- Produces: `export async function notebookStatus(input: { peerAddress: string; fetchImpl?: typeof fetch; timeoutMs?: number; tokenOverride?: string; gatewayAddresses?: string[] }): Promise<NotebookStatusResponse>`（`peerAddress` 是唯一决定要不要附 token 的输入；没有 `hostHeader` 这个参数）

- [ ] **Step 1: 写失败测试（注入 fetch，宿主可跑，不依赖真 Jupyter）**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { notebookStatus } from '../../src/notebooks/status.js';

const fake = () =>
  vi.fn(async (u: string | URL) =>
    String(u).includes('/api/kernelspecs')
      ? { status: 200, json: async () => ({ default: 'python', kernels: { 'arena-pyspark': { name: 'arena-pyspark', spec: { display_name: 'PySpark (arena)' } } } }) }
      : { status: 200, json: async () => ({ version: '7.2.0', ready: true }) }) as unknown as typeof fetch;

// 每条用例都显式给 tokenOverride：宿主上 config.notebook.token 是空的（compose 才设它），
// 不显式覆盖的话第 1 条会在"没配 token 就 running:false"那条早退分支上红 —— 那是环境差，不是实现错。
const TOK = { tokenOverride: 'test-token' };

describe('notebookStatus', () => {
  it('服务在跑：running + 带 token 的本机地址 + kernel 就绪', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), ...TOK });
    expect(res.running).toBe(true);
    expect(res.url).toContain('http://127.0.0.1:7789/tree?token=test-token');
    expect(res.kernels).toEqual([{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }]);
  });

  it('探不到 ⇒ running:false，且 reason 能区分"没起"与"超时"（修的是不同东西）', async () => {
    const res = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: (vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown) as typeof fetch,
    });
    expect(res.running).toBe(false);
    expect(res.reason).toContain('ECONNREFUSED');
    expect(res.kernels).toEqual([]);
  });

  it('非本机对端拿不到 token（链接照给，token 不外泄）', async () => {
    const res = await notebookStatus({ peerAddress: '192.168.1.20', fetchImpl: fake(), ...TOK });
    expect(res.url).toBeDefined();
    expect(res.url).not.toContain('token=');
  });

  // 实施时补的两条（评审 M-1 / I-3a）：判据的两半各要一条，缺任何一半都不会有人发现。
  it('对端是本容器自己的默认网关（docker 网桥）⇒ 视为本机，给 token', async () => {
    const gw = { gatewayAddresses: ['172.18.0.1'] };
    const via = await notebookStatus({ peerAddress: '172.18.0.1', fetchImpl: fake(), ...TOK, ...gw });
    expect(via.url).toContain('token=test-token');
    // 同网段里别的容器地址不是网关 ⇒ 不给（这条判据不是"172.x 都算本机"）
    const sibling = await notebookStatus({ peerAddress: '172.18.0.7', fetchImpl: fake(), ...TOK, ...gw });
    expect(sibling.url).not.toContain('token=');
  });

  it('Host 头不再是 notebookStatus 的入参：想按头说话也说不成', async () => {
    const spoofed = await notebookStatus({
      peerAddress: '203.0.113.9',
      fetchImpl: fake(),
      ...TOK,
      // @ts-expect-error 这个键已经不在契约里；它不该编译，更不该改变结论
      hostHeader: '127.0.0.1:7788',
    });
    expect(spoofed.url).not.toContain('token=');
  });

  it('超时与"没起"给的 reason 必须不同（同一个 reason 会让人去查错的地方）', async () => {
    const res = await notebookStatus({
      peerAddress: '127.0.0.1',
      ...TOK,
      fetchImpl: (vi.fn(async () => { throw new Error('This operation was aborted'); }) as unknown) as typeof fetch,
    });
    expect(res.reason).toMatch(/超时/);
  });

  it('没配 token 时如实报，不假装能用', async () => {
    const res = await notebookStatus({ peerAddress: '127.0.0.1', fetchImpl: fake(), tokenOverride: '' });
    expect(res.running).toBe(false);
    expect(res.reason).toMatch(/ARENA_JUPYTER_TOKEN/);
  });

  it('token 不进日志（它出现在本机 URL 里是点开用的，进日志就留痕了）', async () => {
    // 实现里不许有任何 console.* 或 logInfo 带 token；这条用源码级判据兜住，因为
    // 真日志要起服务才拿得到，而"忘了打这行"的代价是不可撤回的历史日志。
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'notebooks', 'status.ts'), 'utf8');
    expect(src).not.toMatch(/logInfo\([^)]*token/);
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*token/);
  });
});
```

- [ ] **Step 2: 跑它确认红**（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { config } from '../config.js';
import type { NotebookKernel, NotebookStatusResponse } from '@arena/shared';

/**
 * 「这个请求是不是这台机器自己发的」—— 判据只能是内核给的对端地址，不是客户端自报的 Host 头。
 * 两半缺一不可：宿主直跑是对端为回环（`::1`、`127.0.0.0/8` 整段、双栈时的 `::ffff:127.0.0.1`），
 * compose 里宿主浏览器经 docker-proxy / NAT 从网桥进来 ⇒ 对端是**本进程自己的默认网关**（`/proc/net/route` 读的），
 * 永远不会是 127.0.0.1。只认回环不报错，它只会让这功能在唯一启用了它的部署里静默失效。
 * 不拿正则扫地址串：`::1:7788` 是合法 IPv6 字面量（旧 LOOPBACK 会把它当"回环+端口"⇒ 外来者换到 token），
 * 而 `'localhost'` 是名字不是地址。`gateways` 做成参数是为了判据可注入、可测。
 * 完整实现（含 `parseProcNetRoute` 的 fail-closed 那一半）见 `server/src/notebooks/status.ts`。
 */
export function isLocalPeer(rawAddress: string | undefined, gateways: string[] = localGatewayAddresses()): boolean {
  const addr = (rawAddress ?? '').trim().toLowerCase();
  if (!addr) return false;
  // 双栈监听时 Node 把 IPv4 对端写成 `::ffff:127.0.0.1`
  const ip = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  if (ip === '::1') return true;
  const n = ipv4ToInt(ip); // 四段不齐 / 非四段 → null（宁可不给 token，也不给错人）
  // 127.0.0.0/8 整段都是回环（`127.1`、`127.0.0.2` 都到本机），但四段必须齐全
  if (n !== null && (n >>> 24) === 127) return true;
  return gateways.some((gw) => gw.toLowerCase() === ip);
}

async function jupyterApi(path: string, token: string, doFetch: typeof fetch, timeoutMs: number): Promise<Response> {
  return doFetch(`http://127.0.0.1:${config.notebook.port}${path}`, {
    headers: token ? { Authorization: `token ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * 只做"读"：探 `/api/status` + 列 `/api/kernelspecs`。
 * 重活（建 venv）不挂在这里 —— 这个接口会被前端轮询，把分钟级的创建塞进读路径是错的
 * （IDE 同样把 ensureIdeEnv 挂在显式动作上，不挂在语言列表上）。
 */
export async function notebookStatus(input: {
  /** 真实对端地址（Fastify 的 `request.raw.socket.remoteAddress`）—— token 释放判据的唯一输入 */
  peerAddress: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  tokenOverride?: string;
  /** 注入点：默认取本容器自己的默认网关；测试靠它把"网桥网关"那一类判住而不依赖机器 */
  gatewayAddresses?: string[];
}): Promise<NotebookStatusResponse> {
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1500;
  const token = input.tokenOverride ?? config.notebook.token;
  const empty: NotebookStatusResponse = { running: false, kernels: [], notebooks: [] };

  if (!token) return { ...empty, reason: '没有 ARENA_JUPYTER_TOKEN ⇒ entrypoint 不会起 Jupyter' };

  let kernels: NotebookKernel[] = [];
  try {
    const status = await jupyterApi('/api/status', token, doFetch, timeoutMs);
    if (!status.ok) {
      return { ...empty, reason: `Jupyter 返回 ${status.status}${status.status === 403 ? '（token 不匹配）' : ''}` };
    }
    const ks = await jupyterApi('/api/kernelspecs', token, doFetch, timeoutMs);
    const body = (await ks.json()) as { kernels?: Record<string, { spec?: { display_name?: string } }> };
    kernels = Object.entries(body.kernels ?? {}).map(([id, v]) => ({ id, label: v.spec?.display_name ?? id, ready: true }));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { ...empty, reason: msg.toLowerCase().includes('timeout') ? 'Jupyter 无响应（探活超时）' : `Jupyter 未在监听：${msg}` };
  }

  const url = new URL(`${config.notebook.publicUrl}/tree`);
  if (isLocalPeer(input.peerAddress, input.gatewayAddresses)) url.searchParams.set('token', token);
  return { running: true, url: url.toString(), kernels, notebooks: [] };
}
```

- [ ] **Step 4: 跑测试转绿** → 8 passed（原稿 6 条 + 实施时补的网关那一半与 Host 头那一半）。

- [ ] **Step 5: 破坏性验证**：`isLocalPeer` 改成恒真 ⇒ 第 3 条红（新加的那两条各守它的另一半：网关那一半、Host 头那一半，恒真时一起红）；删掉 `AbortSignal.timeout` ⇒ 第 2 条红（reason 变成 reject 的其它文案）。各还原。

- [ ] **Step 6: 提交**

---

### Task 8: 两个路由与接线形状断言

**Files:**
- Modify: `server/src/api/app.ts`（`MARK: /api/ide/env` 那段附近，`:491`）
- Create: `server/test/api/notebook-api.test.ts`

**Interfaces:**
- Consumes: `notebookStatus`（Task 7）、`seedNotebooks`（Task 6）、`ensureIdeEnv`（`server/src/ide/env.js`）、`findLanguage`（`server/src/ide/languages.js`）
- Produces: `GET /api/notebook/status` → `NotebookStatusResponse`；`POST /api/notebook/prepare-env` → `NotebookPrepareResponse`

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * WI-87 的学费：一次编辑把注释和 `app.post(...)` 并到同一行，整条路由被注释吞掉 ——
 * 接口根本不存在，而"切片里 indexOf 到路径字符串"的接线断言照样通过。
 * 所以这里的判据是行首，不是包含。
 */
describe('notebook 路由接线', () => {
  const app = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');

  for (const path of ['/notebook/status', '/notebook/prepare-env']) {
    it(`${path} 以独立一行的 app.get/app.post 注册`, () => {
      const hit = app
        .split('\n')
        .some((l) => /^\s*app\.(get|post)\(`\$\{api\}\/notebook\//.test(l) && l.includes(path));
      expect(hit, `${path} 没有被注册成独立一行的路由（被同行注释吞掉就是这个形状）`).toBe(true);
    });
  }
});
```

- [ ] **Step 2: 跑它确认红**

- [ ] **Step 3: 加路由**

```ts
  // MARK: /api/notebook/status（第五页的唯一事实来源：服务在不在、kernel 就绪没有）
  // 对端地址取 `request.raw.socket.remoteAddress` —— **不是** Host 头（评审 M-1）：头是客户端写的，
  // `Host: 127.0.0.1:7788` 就能换到一条带 token 的链接；socket 地址由三次握手决定。
  app.get(`${api}/notebook/status`, async (request): Promise<NotebookStatusResponse> => {
    const base = await notebookStatus({ peerAddress: request.raw.socket.remoteAddress ?? '' });
    // 顺带铺示例：打开页面这件事本身就该保证示例在位，而不是另加一个 POST
    return { ...base, notebooks: await seedNotebooks() };
  });

  // MARK: /api/notebook/prepare-env（显式建 IDE 的 venv —— kernel 的 argv 指着它）
  // 不挂在 GET 上：status 会被轮询，分钟级的 venv 创建塞进读路径是错的。
  app.post(`${api}/notebook/prepare-env`, async (): Promise<NotebookPrepareResponse> => {
    try {
      const lang = findLanguage('python');
      if (!lang) return { ok: false, reason: '语言表里没有 python' };
      await ensureIdeEnv(lang);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });
```

- [ ] **Step 4: 补一条真行为测试**（同文件，用仓库现有的 `app.inject` 那套）

```ts
it('没起 Jupyter 时 status 仍是 200 + running:false（页面不许白屏，也不许 500）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/notebook/status', headers: { host: '127.0.0.1:7788' } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as NotebookStatusResponse;
  expect(typeof body.running).toBe('boolean');
  expect(Array.isArray(body.kernels)).toBe(true);
});
```

- [ ] **Step 5: 验证**：`npx vitest run server/test/api/notebook-api.test.ts && npm run verify:fast`
Expected: 全绿；**Task 1 的闸门此时必须已绿**（Task 3 干的）。

- [ ] **Step 6: 破坏性验证**：把 status 那行注册并进前面的注释 ⇒ Step 1 必红。还原。

- [ ] **Step 7: 提交**

---

### Task 9: 第五页（前端）

**Files:**
- Create: `web/src/pages/Notebook.tsx`、`web/test/notebook.test.tsx`
- Modify: `web/src/router.tsx:3`（`RouteName`）、`:47`（解析 `/notebook`）
- Modify: `web/src/App.tsx`（`lazy` 一片、`PAGE_TITLE`、`NAV` 第 5 项、switch 分支）
- Modify: `web/src/api.ts`（两条方法）、`web/src/lib/prefetch.ts`
- Modify: `web/src/styles/base.css`（复用现有 `.card` / `.badge` / `.banner`；**不新增 token** —— WI-87 写过 `--sunken` 这种不存在的 token，静默失效不报错）

**Interfaces:**
- Consumes: `api.notebookStatus()` → `NotebookStatusResponse`
- Produces: `data-testid`：`notebook-page`、`notebook-status`、`notebook-open`、`notebook-prepare`

- [ ] **Step 1: 写失败测试（三态）**

```tsx
// @vitest-environment jsdom
import './dom-shim';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const status = vi.fn();
vi.mock('../src/api', () => ({ api: { notebookStatus: () => status(), notebookPrepareEnv: vi.fn() } }));

import Notebook from '../src/pages/Notebook';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Notebook 第五页', () => {
  it('服务在跑：给可点开的地址 + kernel 徽章', async () => {
    status.mockResolvedValue({
      running: true, url: 'http://127.0.0.1:7789/tree?token=x',
      kernels: [{ id: 'arena-pyspark', label: 'PySpark (arena)', ready: true }],
      notebooks: [{ file: '00-smoke-pyspark.ipynb', seeded: true }],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-open')).toBeTruthy());
    expect(screen.getByTestId('notebook-status').textContent).toContain('运行中');
  });

  it('没在运行：说清"做题不受影响"，并且不给死链接', async () => {
    status.mockResolvedValue({ running: false, reason: 'Jupyter 未在监听：ECONNREFUSED', kernels: [], notebooks: [] });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-status').textContent).toContain('没在运行'));
    expect(screen.getByTestId('notebook-page').textContent).toContain('做题不受影响');
    expect(screen.queryByTestId('notebook-open')).toBeNull();
  });

  it('kernel 没就绪（venv 还没建）：给「准备环境」按钮，而不是让人对着报错猜', async () => {
    status.mockResolvedValue({
      running: true, url: 'http://127.0.0.1:7789/tree',
      kernels: [{ id: 'python3', label: 'Python 3', ready: false, reason: '解释器不存在' }],
      notebooks: [],
    });
    render(<Notebook />);
    await waitFor(() => expect(screen.getByTestId('notebook-prepare')).toBeTruthy());
  });
});
```

- [ ] **Step 2: 跑它确认红**（页面与路由都不存在）

- [ ] **Step 3: 路由与导航**

```ts
// web/src/router.tsx
export type RouteName = 'today' | 'question' | 'bank' | 'progress' | 'ide' | 'notebook' | 'unknown';
  if (path === '/notebook') return { name: 'notebook', path, query, questionId: null };
```

```tsx
// web/src/App.tsx —— lazy 那组之后
const Notebook = lazy(() => import('./pages/Notebook'));   // 与 Bank/Progress 同一片：不许进首屏
const PAGE_TITLE: Record<RouteName, string> = { /* … */ notebook: 'Notebook', /* … */ };
const NAV = [ /* … */ { href: '/notebook', label: 'Notebook', name: 'notebook' } ];
// switch： case 'notebook': return <Notebook />;
```

`web/src/api.ts`：

```ts
  notebookStatus: (opts?: RequestOptions) => get<NotebookStatusResponse>('/notebook/status', { ...opts, label: '读取 notebook 状态' }),
  notebookPrepareEnv: (opts?: RequestOptions) =>
    post<NotebookPrepareResponse>('/notebook/prepare-env', {}, { ...opts, label: '准备依赖环境' }),
```

- [ ] **Step 4: 写页面。** 三句话一条都不能省：
① **"这些包与 IDE 共用同一份环境，判题器看不到"**（沿用 WI-87 那句话）；
② **"notebook 里能读到题库的参考答案 —— 这不是安全边界"**；
③ **"只在浏览器本机打开：地址是 127.0.0.1，手机 / iPad 访问不了"**。

- [ ] **Step 5: 验证**

Run: `npx vitest run web/test/notebook.test.tsx && NODE_ENV=production npm run build -w web && node scripts/check-bundle.mjs`
Expected: 3 passed；产物预算仍绿（首屏仍 1 JS + 1 CSS）。
**预算红了不要抬预算** —— 那说明 Notebook 被写进了首屏（多半是漏了 `lazy`）。

- [ ] **Step 6: 破坏性验证**：把 `lazy` 改成静态 import ⇒ 预算必须红；还原。

- [ ] **Step 7: 提交**

---

### Task 10: 容器档接线 —— 新阶段 + kernel 真跑

**Files:**
- Modify: `scripts/verify.sh`（`run "网页 IDE…"` 之后）
- Create: `server/test/notebooks/kernel.test.ts`
- Modify: `compose.yml`（arena / dev / tools 加 `ARENA_IN_CONTAINER: "1"`）

**Interfaces:**
- Consumes: 容器里真跑着的 Jupyter（Task 3+4）、`content/notebooks/00-smoke-pyspark.ipynb`（Task 6）
- Produces: `--verify` 里的一条阶段；子项目 B 的"每篇真跑"闸门复用这里的执行器

- [ ] **Step 1: 写断言（真跑 notebook，而不是只对环境形状）**

```ts
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { ensureIdeEnv } from '../../src/ide/env.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * Task 1 的结构断言说的是"entrypoint 写了那行 PATH"；这里说的是"它真的生效"：
 * 用 kernel 的解释器把 smoke notebook 真跑一遍，cell 4 的 assert 必须成立。
 * 只有结构那条的话，PATH 前缀写错位置、或后面的 export 把它覆盖掉，都看不出来。
 */

const KERNEL = '/usr/local/share/jupyter/kernels/arena-pyspark/kernel.json';
const inContainer = process.env.ARENA_IN_CONTAINER === '1';

// kernel 的 argv 指着 venv，而 venv 是**懒创建**的：全新卷上它还不存在，nbconvert 会挂在
// "解释器文件找不到" —— 症状长得像 kernel 坏了，其实是前置条件没满足。先建出来（幂等）。
beforeAll(async () => {
  if (!inContainer) return;
  const lang = findLanguage('python');
  expect(lang, '语言表里没有 python ⇒ 本文件的前置条件不成立').toBeTruthy();
  await ensureIdeEnv(lang!);
}, 200_000);

describe('arena-pyspark kernel 在容器里真能起 Spark', () => {
  it('kernel 文件在镜像级目录', () => {
    expect(existsSync(KERNEL), `${KERNEL} 不存在 —— 本条只在容器里成立（宿主没有它）`).toBe(true);
  });

  it('venv 的解释器真的在（缺它就是"kernel 起不来"的假象来源）', () => {
    expect(existsSync(`${config.ideEnvDir}/python/bin/python`)).toBe(true);
  });

  it('smoke notebook 跑完并打出 venv ok（证明解释器落在 IDE venv，Spark 起得来）', () => {
    const out = execFileSync(
      'jupyter',
      ['nbconvert', '--to', 'notebook', '--execute', '--stdout', 'content/notebooks/00-smoke-pyspark.ipynb'],
      { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
    );
    expect(out).toContain('venv ok');
    expect(out).toMatch(/rows 15/); // cell 3 打的是 spark.range(6) 的 id **之和** = 0+1+2+3+4+5 = 15（行数会是 6 —— 评审 I-1 把两边对齐成同一个算式）
    expect(out).not.toMatch(/Traceback/);
  }, 200_000);

  /**
   * 这条才是"PATH 前缀真的生效"的行为证据，nbconvert 给不了它：
   * nbconvert 是**测试进程**自己起的子进程，继承的是测试的 env；而 Task 3 那条
   * `PATH=... jupyter notebook ...` 是命令前缀，只进 notebook 服务那个进程。
   * 于是"结构断言写了但没人守"的风险就在这里 —— 直接读那个活进程的 environ。
   * 内核起的所有 kernel 都从它 fork，所以 PATH 首项对了，`!pip3 install` 就落在 venv。
   */
  it('运行中的 jupyter 进程，PATH 的第一项就是 venv 的 python/bin', () => {
    const pids = execFileSync('bash', ['-c', "pgrep -f 'jupyter notebook' || true"], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    expect(pids.length, '容器里没有正在跑的 jupyter ⇒ 前置条件不成立（Task 3/4 没落地或 token 缺失）').toBeGreaterThan(0);
    const paths = pids.map((pid) =>
      execFileSync('bash', ['-c', `tr '\\0' '\\n' < /proc/${pid}/environ | sed -n 's/^PATH=//p'`], { encoding: 'utf8' }).trim(),
    );
    for (const p of paths) {
      const first = (p.split(':')[0] ?? '').replace(/\/$/, '');
      expect(first, `jupyter 进程的 PATH 首项不是 venv：${p.slice(0, 120)}`).toMatch(/\/python\/bin$/);
    }
  });

  // 常驻解释断言：没有容器标记时上面几条根本不该跑，但"为什么没跑"必须有人管。
  it('不在容器里 ⇒ 上面的断言不该跑；容器里 ⇒ 必须跑（形状同 publish-identity）', () => {
    if (inContainer) return;
    expect(existsSync(KERNEL), '有 ARENA_IN_CONTAINER=1 却没有 kernel 文件 ⇒ 镜像没按 Dockerfile 构建').toBe(false);
  });
});
```

- [ ] **Step 2: 宿主跑一次，确认状态是清晰的**

Run: `npx vitest run server/test/notebooks/kernel.test.ts`
Expected: 前两条 FAIL（宿主既没有 kernel 文件也没有 jupyter CLI）—— 所以 Step 3 的接线要让它**只在容器阶段跑**，不是让它 skip。
把 `describe.skip` 之类的做法当场否掉：一条永远不会在容器里跑绿的闸门就是装饰（`dev_verify_workflow` 第 3 条）。

- [ ] **Step 3: verify.sh 加阶段（只在容器里点名这个目录）**

```bash
# notebook：只在容器里跑（宿主既没有 arena-pyspark kernel，也没起 Jupyter）。
# 不给它单开 SKIP_ 开关；漏跑由"整片 skip 也算失败"那条守卫兜。
if [ "${ARENA_IN_CONTAINER:-0}" = "1" ]; then
  run "Notebook 运行时（kernel 真跑）" npx vitest run server/test/notebooks/kernel.test.ts
else
  printf '\n\033[33m跳过 notebook kernel 真跑（宿主无 Jupyter）—— ./start.sh --verify 必须补跑\033[0m\n'
fi
```

compose 的 arena / dev / tools 各加 `ARENA_IN_CONTAINER: "1"`（宿主永不设）。
`server/test/regression/verify-coverage.test.ts` 会核 `server/test/notebooks/kernel.test.ts` 被认领 ——
它若要求"env 门控的阶段必须真设了那个变量"，照它的报错接线，别绕过。

- [ ] **Step 4: 三档验证（Docker 必须在跑）**

```bash
npm run verify:fast > /tmp/vf.log 2>&1; echo VF=$?
./start.sh --verify > /tmp/cv.log 2>&1; echo CV=$?; grep -E "CONTAINER|Notebook|矩阵" /tmp/cv.log | tail -5
```
Expected: 两个都是 0；容器日志里 notebook 阶段绿，判题矩阵仍 `158 道全部可判、跳过 0`。
**退出码不能被管道吞**（这条坑记过：`| tail` 之后的 `$?` 是 tail 的）。

- [ ] **Step 5: 宿主 E2E**

先写 `tests/e2e/notebook-page.spec.ts`：打开 `#/notebook`，断言①有 `notebook-status` 文本、②服务没起（`running:false`）与 `ARENA_NOTEBOOK_PUBLIC_URL` 配坏这两态下不出现 `notebook-open`、③console error 与 warning 均为 0。
**更正（实施时 · 对齐已经落地的页面）**：原稿②里的"非回环"不是一条会成立的条件 —— 无 token 但服务在跑时页面**照样渲染** `notebook-open`（钉住它的是 `web/test/notebook.test.tsx:65-72`；另两态各有一条 `queryByTestId('notebook-open')).toBeNull()`：`:87` 是 `running:false`、`:117` 是 publicUrl 配坏），而容器里非回环的那个对端正是**拿得到 token** 的一支（判据 = 回环或本进程默认网关，`server/src/notebooks/status.ts:101-119`；e2e 实例本来就没被给予 token ⇒ 它坏在 `running:false` 那一半，不是坏在对端）。照原稿把"非回环"写成断言它会红，而最省事的"修法"是给非本机用户把链接藏掉 —— 那正是前面那三条断言守着不许发生的静默降级。
Run: `npm run e2e` → 全绿。

- [ ] **Step 6: 真浏览器（改了前端必须看过）**

```
./start.sh → http://127.0.0.1:7788/#/notebook
browser_console_messages(level=warning, all=true) → 0 error / 0 warning
browser_evaluate → notebook-open 的 href 端口是 7789；notebook-status 文案
换一次状态：docker exec daily-arena pkill -f "jupyter notebook" → 刷页面 → running:false + reason 出现，
            页面不白屏、notebook-open 消失
再 ./start.sh 起回来 → 真点开 smoke notebook → Run All → 看见 python 路径行、rows 15、venv ok
故意停 60s 不碰 → /api/health 仍 200，/api/notebook/status 仍 running:true
```

- [ ] **Step 7: 破坏性验证**：把 `kernel.json` 的 argv[0] 改成 `/usr/bin/python3` 重建 ⇒ Step 4 的容器档必红（`venv ok` 那格挂）；还原。

- [ ] **Step 8: 提交**

---

### Task 11: 文档与跨 session 记忆

**Files:**
- Modify: `README.md`（命令表加 notebook；IDE 段之后加一节「Notebook」；已知边界加"答案可读不是安全边界"）
- Modify: `docs/ARCHITECTURE.md`（路由表 + 两段：notebook 运行时 / 已知边界）
- Modify: `docs/JUDGING.md`（红线那段补一句：notebook 是红线一的第二个入口，以及它怎么被堵住）
- Modify: `docs/superpowers/specs/2026-10-05-jupyter-notebook-runtime-design.md`（回填 §11 待实测清单；若实现与 §2 的 token 来源决定不同，就地标注修正而不是悄悄改实现）
- Modify: `docker/BUILDINFO.md`（实测镜像增量与新增层）
- Modify: `memo.md`（新里程碑 BA）、`HANDOVER.md`（WI-89 完成条目 + A2/B 挂成 WI-90/WI-91）

- [ ] **Step 1: 回填实测数字**：spec §11 的五个预估逐个换成实测量值，或写"量不出来 + 为什么"。**没有实测值就不写数字。**

- [ ] **Step 2: 文档里每条断言都问一遍"有没有闸门在报"**（README 那三次"44 处 / 45s / 3-4GB"式错误的教训）：
写"5 个页面"就去数 `NAV`，写"7789"就去读 compose。

- [ ] **Step 3: HANDOVER 的 WI-89 条目带验证命令与实测输出**（三档 + 真浏览器 + 破坏性），
并新开两条：**WI-90 = 教程 3 篇（子项目 B）**、**WI-91 = Scala kernel（A2，含 spike 与三条路）**。

- [ ] **Step 4: 跑一遍 `npm run verify:fast` 确认文档改动没碰到代码，然后提交。**

---

## 计划自查（写完对照 spec 跑一遍）

- **spec 覆盖**：A §3 架构 → Task 2/3/4；§4-C1 → Task 2；C2 → Task 3；C3 → Task 4；C4 → Task 6/7/8；C5 → Task 9；C6（A2）→ 明确排除，另出计划；§6 错误处理六态 → Task 7 的测试 + Task 9 的三态 + Task 10 的状态翻转手测；§7 四条红线 → Task 1/3（延伸）、Task 4（端口）、Task 9（答案可读文案）、Task 6（reset 交互）；§8 T1-T7 → Task 8 / 1 / 2 / 6 / 4 / 9+10 / verify-coverage；§11 待实测 → Task 11 Step 1。
- **缺口一处，故意的**：spec §4-C4 的契约里写了 `notebooks` 由 status 报告，Task 8 用"GET 里顺手 seed"实现它 —— 读路径做 I/O 复制这件事很轻（几个文件的 `stat` + 偶发 `copyFile`），但**不是零成本**。若实测发现轮询放大成问题，改法是把 seed 挪到 entrypoint（一处 I/O，不依赖前端打开页面），并同步删掉 status 里的调用；这条决定要在 Task 10 的浏览器停 60s 那一步用数据判，不要凭感觉留。
- **类型一致性**：`NotebookStatusResponse.notebooks` 全程 `NotebookFile[]`；kernel id 一律经 `NOTEBOOK_KERNELS.pyspark`，不允许出现第二处 `'arena-pyspark'` 字面量（Task 2/7/10 里的字面量是**读镜像文件路径**与测试期望，属于允许的那类）。
