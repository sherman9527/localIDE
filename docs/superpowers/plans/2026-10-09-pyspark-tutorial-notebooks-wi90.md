# 子项目 B（WI-90）：三篇 senior PySpark 教程 notebook 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 3 篇能**当场量出差异**的 senior 级 PySpark 教程 notebook，并把"可运行"变成一道**容器里真执行的闸门**（结论反了闸门就红，不是"没报错就算过"）。

**Architecture:** 教程住在 `content/notebooks/<篇名>.ipynb`（进 git，A1 的 `seed.ts` 负责"缺失才复制"到 `data/notebooks/`）；新增一道容器档闸门 `server/test/notebooks/tutorials.test.ts` 用 `jupyter nbconvert --execute` 逐篇执行，判两层：执行层（无 cell 异常、kernel 是 `arena-pyspark`）与**结论层**（每篇的方向性结论在 notebook 里写成真 `assert`，并各自打一行 `WI90[<篇>][<结论>] OK` 标记；闸门按注册表核对**每条标记都出现了**）。

**Tech Stack:** PySpark 3.5.5（镜像现有版本，**不降到 3.4**，见 A1 规格那条裁定）、`jupyter nbconvert`、Vitest、`scripts/verify.sh` 的容器档阶段。

**Spec:** `docs/superpowers/specs/2026-10-05-pyspark-enterprise-notebooks-design.md`（五段结构、主题清单、纪律四条、闸门设计、§8"明确不做"全在里头）。依赖的前置：`docs/superpowers/plans/2026-10-09-jupyter-notebook-embed-wi94.md`（同源反代与两栏页面必须**先落地**，因为本计划第三篇起就要用它交付）。

## Global Constraints

- **数据不落 git**：一律 `spark.range(...)` + 确定性表达式；不引外部数据集（离线构建与可复现两条都要求）。
  ⚠ **"固定 seed"那句在本篇的写法下是空的**（2026-10-10 篇 1 实测顶回）：PySpark 的
  `SparkSession.range(start, end, step, numPartitions)` **没有 `seed` 参数**，写 `spark.range(N, seed=7)`
  直接 `TypeError`（seed 属于 `sample()` / `F.rand(seed)` 那一族）。而这里要的从来不是"seed"，是**可复现**：
  `id % 5 < 2` 这类确定性表达式没有任何随机，换 seed 也换不出新形状 ⇒ 判据写成"确定性表达式"，
  **不许为了照抄这句话去加一个不存在的参数，也不许改成 `F.rand(7)` 引入真随机**（那才需要 seed，且会把"每桶行数"变成每次不同的数）。
- **单篇预算**：执行 ≤ 90s、峰值内存 ≤ 1GB —— **这是目标不是实测**，写完第一篇就用真实数字校准，超了先缩数据量（倾斜与文件数的现象在 50 万行上一样看得出来，"跑不完"才是真问题）。
- **`local[2]` 的边界要写破**（**不是 `local[*]`** —— 篇 1 实测：`docker/jupyter/kernels/arena-pyspark/kernel.json`
  把 argv 钉成 `--master local[2] --driver-memory 512m`，所以 `defaultParallelism=2`，而"200 个 shuffle 分区开 AQE 只落 2 个文件"
  这类数字**只有按 `local[2]` 讲才对得上**；写 `local[*]` 就是一句和不上任何数的话）。
  凡涉及"分布式才有的失效模式"（节点级 shuffle、fetch failed、executor 被 broadcast 撑爆），文档里标"本机只能演示到这一层"，**不写成已验证**（纪律 2）。
- **不教没验证过的东西**：不写 RDD 演化史/宽窄依赖背诵/DataFrame vs RDD 八股；不教生产集群 YARN/K8s 调参；不演示 Delta/Iceberg（镜像里没有）。
- **题库指针必须是具体题 id**：`bd-pyspark-0001`、`bd-pyspark-0002`、`bd-pyspark-0005`、`bd-pyspark-0010` 四道都在 `content/questions/big-data/`（已核实存在）。留"哪道题"这种描述就是留占位符。
- **文档里的每个数字**：要么是本篇当场量出来的（读者跑一遍就能看到），要么带来源标注。**不提交 outputs**（见下面的 Ruling(B0)）。
- **闸门断言只押确定性量**：分区行数占比、文件数、`getNumPartitions()`、计划里的算子名。**耗时只打印、不断言** —— 时间断言在 CI 上必抖，那是给下一颗假阳性埋雷（Ruling(B1)）。
- 仓库四条不可跳过：任何改动都要跑验证且没看到通过输出前不许说"完成"；TDD 红必须"因缺功能而红"+ 破坏性验证；门禁自己也要被门禁（`verify-coverage`）；跨 session 记忆更新。
- 不引新依赖；`.env` 不读不打印；提交身份逐条 env 传 noreply，不许 `--no-verify`/amend/push；不占 7799。

### Ruling(B0)：教程 notebook **不提交 outputs**（与 A1 的 smoke 同一形状）

规格 §7.4 那句"要么本篇当场量出来（可点开看输出）"有两种读法。取"当场量"这一种：
`content/notebooks/00-smoke-pyspark.ipynb` 已立了先例并写了理由 —— 执行产物属于执行的那一刻，
把结果抄进 git 只会让"教程里的数字"变得不可追（不知道哪天、哪个镜像跑出来的），
而"哪个镜像"这件事在本仓库是可验证的（`docker/BUILDINFO.md` 承诺重建即可复现）。
⇒ 读者点开看到的是**待运行的**代码，跑一遍就有数；闸门跑的是同一份。
代价照实写：页面上的教程在**没运行之前没有数字**，所以⑤段速查表里的结论必须是**不依赖具体数字**的定性表述。

### Ruling(B1)：结论层用 **marker**，不只是"没报错"

只看 `output_type == 'error'` 的闸门有一种坏法抓不到：**有人把 `assert` 那行删了**。
删掉之后照样"零异常"，而教程的结论那一半已经没人管了。
⇒ 每篇在每条方向性结论之后 `print("WI90[<篇>][<结论 slug>] OK")`，闸门按一份**注册表**核对每条标记都出现。
配套判据：注册表里的结论集合 = notebook 里实际出现的标记集合（多一条、少一条都红），
所以"新增一条结论忘了登记"与"删一条结论"都会红。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `content/notebooks/01-skew-and-hot-keys.ipynb` | 篇 1：倾斜与热点 key（现象→取证→三种解法→量差异→速查+追问） |
| `content/notebooks/02-small-files-and-partitioning.ipynb` | 篇 2：小文件与物理设计 |
| `content/notebooks/03-reading-the-plan-and-aqe.ipynb` | 篇 3：计划解读与 AQE |
| `server/test/notebooks/tutorials.test.ts` | 容器档闸门：逐篇执行 + 两层断言 + 清单完整性 + 常驻门控解释 |
| `server/test/notebooks/tutorial-claims.ts` | 结论注册表（每篇该出现哪些标记）。与 notebook 分文件，是因为闸门要**独立于被测物**声明期望 |
| `scripts/verify.sh` | 新增一条容器档阶段（与「Notebook 运行时」同级），并把新文件从「单元测试」的目录扫描里排除 |
| `README.md` / `docs/ARCHITECTURE.md` / `HANDOVER.md` / `memo.md` | 数字校准与 WI-90 落板 |

`server/test/notebooks/tutorials.test.ts` 复用 `kernel.test.ts` 里已经打磨过的两件工具：`executedNotebookEvidence(raw)`（从 `--stdout` 那份 notebook JSON 里只取 stdout 行与 error 条目）与 `nbconvertCrashEvidence(err)`（非 0 退出时说清**是哪一种**坏法，含 `timeout` 那一支）。**不要**在第二个文件里重写第三份解析。

---

## Task 1：闸门骨架 + 注册表 + 接线（先让"跑一篇 smoke"成立）

**为什么闸门排在写教程之前**：这一档的交付物是"可运行的教程"，而"可运行"必须是一条会红的判据。
先把闸门立在一篇已有 notebook 上（`00-smoke-pyspark.ipynb`），后面每加一篇就少一处不确定性。
反过来先写教程再补闸门，症状是"教程写完发现跑不完 90 秒"——那时返工的是内容。

**Files:**
- Create: `server/test/notebooks/tutorial-claims.ts`
- Create: `server/test/notebooks/tutorials.test.ts`
- Modify: `scripts/verify.sh`（新增阶段 + `--exclude`）
- Test-Modify: 无（新文件）

**Interfaces:**
- Consumes: `config.notebook.seedDir`（= `content/notebooks`）、`config.notebook.port`、`config.ideEnvDir`、`venvPythonPath()`（`server/src/ide/env.js`）、`NOTEBOOK_KERNELS.pyspark`
- Produces:
  ```ts
  /** 每篇教程必须出现的结论标记（slug，不含 `WI90[` 前缀）。新增结论必须在这里登记，否则闸门红。 */
  export const TUTORIAL_CLAIMS: Record<string, string[]>;   // key = notebook 文件名（不含目录）
  export const TUTORIAL_TIMEOUT_MS = 120_000;
  export function markerOf(file: string, slug: string): string;   // `WI90[<file 去 .ipynb>][<slug>] OK`
  ```

- [ ] **Step 1: 写红的判据**

`server/test/notebooks/tutorials.test.ts`：

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTEBOOK_KERNELS } from '@arena/shared';
import { config } from '../../src/config.js';
import { venvPythonPath } from '../../src/ide/env.js';
import { TUTORIAL_CLAIMS, TUTORIAL_TIMEOUT_MS, markerOf } from './tutorial-claims.js';
import { executedNotebookEvidence, nbconvertCrashEvidence } from './kernel.test-helpers.js'; // ← 见 Step 2 的说明

const IN_CONTAINER = process.env.ARENA_IN_CONTAINER === '1';
const NOTEBOOK_SERVICE = process.env.ARENA_NOTEBOOK_SERVICE === '1';

/**
 * 教程 notebook 的**可运行性**闸门（子项目 B）。只在"那个跑着 notebook 服务的容器"里有判据对象：
 * 门控写在**文件里**（合取两个变量），形状照 `kernel.test.ts` / `embed.test.ts`，理由也相同 ——
 * 只靠阶段名点是挡不住的（评审 T10-1），`server/test/notebooks/` 这个目录本来就被「单元测试」阶段扫。
 *
 * 两层判据，缺任何一层都会放过一种真实的坏法：
 * ① 执行层：`output_type === 'error'` 的 cell 数必须为 0，且 kernel 是 `arena-pyspark`。
 *    ⚠ kernel 那条不是装饰：`metadata.kernelspec.name` 写成 `python3` 的教程照样能跑绿，
 *    而它跑在**镜像自带的系统解释器**上 —— 那正是红线①要拦在判题环境外面的那个，
 *    于是"教程里 `!pip3 install` 装进哪套环境"从教学变成了踩线示范。
 * ② 结论层（`TUTORIAL_CLAIMS`）：每篇声明的方向性结论都必须打出 marker。
 *    只看"没报错"抓不到**有人把 assert 删了**（Ruling(B1)）：删掉之后零异常、结论那一半没人管。
 */
describe.skipIf(!IN_CONTAINER || !NOTEBOOK_SERVICE)('教程 notebook 容器里真执行', () => {
  /** 全新卷上 IDE venv 还不存在 ⇒ nbconvert 会挂在"解释器文件找不到"，那不是教程坏了。
   *  这一条把那种前提**说成前提**（`kernel.test.ts:351` 同一课），并让常驻那一组去判"该不该跑"。 */
  it('IDE venv 必须已存在（否则这一档的判据对象不成立，先按页面「准备环境」）', () => {
    expect(existsSync(venvPythonPath(config.ideEnvDir)), `venv 解释器不在 ${venvPythonPath(config.ideEnvDir)} ⇒ arena-pyspark kernel 起不来。这一条不是教程坏了，是这一档还没有判据对象`).toBe(true);
  });

  for (const [file, claims] of Object.entries(TUTORIAL_CLAIMS)) {
    it(`${file}：跑通、kernel 对、每条方向性结论都打出 marker`, () => {
      const notebook = join(config.notebook.seedDir, file);
      expect(existsSync(notebook), `注册表里有 ${file} 而 ${config.notebook.seedDir} 里没有这个文件 ⇒ 有人删了教程没删注册表（或写错文件名）`).toBe(true);

      let raw: string;
      try {
        raw = execFileSync(
          'jupyter',
          ['nbconvert', '--to', 'notebook', '--execute', '--stdout', '--ExecutePreprocessor.allow_errors=True', `--ExecutePreprocessor.timeout=${Math.floor(TUTORIAL_TIMEOUT_MS / 1000)}`, notebook],
          { encoding: 'utf8', timeout: TUTORIAL_TIMEOUT_MS + 15_000, maxBuffer: 32 * 1024 * 1024 },
        );
      } catch (err) {
        throw new Error(nbconvertCrashEvidence(err));
      }
      const { stdout, errors } = executedNotebookEvidence(raw);
      expect(errors, `${file} 有 cell 抛异常：\n${errors.join('\n')}`).toEqual([]);

      const nb = JSON.parse(raw) as { metadata?: { kernelspec?: { name?: string } } };
      expect(nb.metadata?.kernelspec?.name, `${file} 跑在内核 ${nb.metadata?.kernelspec?.name} 上而不是 ${NOTEBOOK_KERNELS.pyspark} ⇒ 它可能在系统解释器上跑，教程里装的包会进判题那套环境（红线①）`).toBe(NOTEBOOK_KERNELS.pyspark);

      for (const slug of claims) {
        const marker = markerOf(file, slug);
        expect(stdout.some((line) => line.includes(marker)), `${file} 没打出结论标记 ${marker} ⇒ 那条结论被删了、被改跑了，或 assert 根本没执行（Ruling(B1)）`).toBe(true);
      }
    });
  }

  /** 清单完整性：注册表必须覆盖 `content/notebooks/` 里**每一篇**（`00-smoke` 除外，它归 `kernel.test.ts` 判）。
   *  少了这一条，"新写一篇忘了接闸门"是完全静默的 —— 页面看得到、文件列表看得到，只有没人跑它。 */
  it('content/notebooks 里的每篇教程都必须在注册表里（新写一篇忘了登记 ⇒ 红在这里）', () => {
    const files = readdirSync(config.notebook.seedDir)
      .filter((f) => f.endsWith('.ipynb') && !f.startsWith('00-'))
      .sort();
    const registered = Object.keys(TUTORIAL_CLAIMS).sort();
    expect(registered, '注册表与目录不一致：加了教程没登记，或登记了不存在/已删的文件名').toEqual(files);
  });
});

/** 常驻：门控本身在宿主也要被判住（形状照 `kernel.test.ts:796` 那一组 —— 合取的两半各自能红）。 */
describe('教程闸门的门控本身（常驻，宿主也跑）', () => {
  it('注册表非空且每条 slug 形状合法（marker 拼错 ⇒ 那条判据永远只能靠人肉看）', () => {
    expect(Object.keys(TUTORIAL_CLAIMS).length).toBeGreaterThan(0);
    for (const [file, claims] of Object.entries(TUTORIAL_CLAIMS)) {
      expect(file.endsWith('.ipynb'), `注册表的 key 必须是文件名：${file}`).toBe(true);
      expect(new Set(claims).size, `${file} 的 slug 有重复 ⇒ marker 核对做了两遍同一件事`).toBe(claims.length);
      for (const slug of claims) expect(slug, `${file} 的 slug 形状不合：${slug}`).toMatch(/^[a-z0-9][a-z0-9-]{2,60}$/);
    }
  });
});
```

- [ ] **Step 2: 把 `kernel.test.ts` 的两件工具抽成可共享模块**

`executedNotebookEvidence` / `nbconvertCrashEvidence` 现在住在 `kernel.test.ts` 里（未导出）。
**不要**复制第三份，也不要从测试文件 import 测试文件（`kernel.test.ts` 一 import 就带着它那些 `describe.skipIf` 跑一遍）。
做法：把两个函数原样搬到新文件 `server/test/notebooks/notebook-evidence.ts`（**只搬实现，注释跟着走**，
包括那段"枚举里必须有 `timeout` 这一条自己"的教训），`kernel.test.ts` 改成 `import { … } from './notebook-evidence.js'`，
`tutorials.test.ts` 也 import 它。搬完必须确认 `kernel.test.ts` 在容器档里**条数与结果一字不变**（30 条），
因为这两个函数是它的一部分判据的实现。

- [ ] **Step 3: 写注册表（本任务只登记 smoke 之外的东西 ⇒ 先给一篇都没有的空表）**

`server/test/notebooks/tutorial-claims.ts`：

```ts
/**
 * 每篇教程必须打出的**结论 slug**（闸门按这份表核对 marker，Ruling(B1)）。
 * 它故意住在 notebook **外面**：期望值若由被测文件自己声明，"删一条结论"就同时删掉了判据。
 * slug 的形状 `[a-z0-9-]`：它要出现在 marker 里、也要出现在失败消息里，别放空格与中文。
 */
export const TUTORIAL_CLAIMS: Record<string, string[]> = {};

export const TUTORIAL_TIMEOUT_MS = 120_000;

export function markerOf(file: string, slug: string): string {
  return `WI90[${file.replace(/\.ipynb$/, '')}][${slug}] OK`;
}
```

Run: `npx vitest run server/test/notebooks/tutorials.test.ts`（宿主）⇒ 常驻那一组**必须红**在
`expect(Object.keys(...).length).toBeGreaterThan(0)` —— 这是"因缺功能而红"（还没写教程）。
`describe.skipIf` 那一组在宿主是 skip，符合设计。

- [ ] **Step 4: verify.sh 接线**

`scripts/verify.sh`：
- 在 `NB_SERVICE = 1` 那条 `run "单元测试（…）"` 的 `--exclude` 列表里补第三个：`--exclude server/test/notebooks/embed.test.ts` 之后加 `--exclude server/test/notebooks/tutorials.test.ts`，并在紧邻注释里补一句：**同一登记路径**，排除的理由与 `embed.test.ts` 相同（每条都真起 Spark，在目录扫描里会与专门阶段各跑一遍）。
- 在「Notebook 运行时（kernel 真跑）」那条**之后**新增一条同级阶段：
  ```bash
  run "教程 notebook 可运行（结论层）" env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run server/test/notebooks/tutorials.test.ts
  ```
  两个变量都在命令行显式设一遍不是冗余：`verify-coverage` 那条"env 门控的闸门必须被'设了那个变量'的阶段认领"读的是**阶段命令文本**（实测过它先红后绿的接线形状，见 `kernel.test.ts` 与 `embed.test.ts` 那两处注释）。

Run: `npx vitest run server/test/regression/verify-coverage.test.ts` ⇒ 必须绿（它现在是红的，因为新文件还没被认领）。

- [ ] **Step 5: 破坏性验证（闸门也要被门禁）**

1. 注册表里塞一条不存在的 slug（`{ '00-x.ipynb': ['ghost'] }`）⇒ 清单完整性那条必须红；
2. 把 `tutorials.test.ts` 从阶段命令里删掉 ⇒ `verify-coverage` 必须红；
3. 把 `kernel.test.ts` 里 `executedNotebookEvidence` 的调用改成返回 `{stdout: [], errors: []}` ⇒ `kernel.test.ts` 必须红（证明 Step 2 那次搬运**没有把它的判据搬空**）；
4. 手工 `cp` 一份带一条真 `assert False` 的临时 notebook 进 seedDir、登记、跑 ⇒ 必须红在"有 cell 抛异常"；把它改成 `assert True` 但**不打 marker** ⇒ 必须红在"没打出结论标记"（这一条是 Ruling(B1) 的正面证据）；
5. 全部还原，`npx vitest run server/test/notebooks/tutorials.test.ts server/test/notebooks/kernel.test.ts`（宿主）⇒ 常驻那一组绿、容器那一组 skip。

- [ ] **Step 6: 三档**

`npm run verify:fast > /tmp/wi90-t1-fast.log 2>&1; echo "FAST_EXIT=$?"` ⇒ 0；
容器档这一档先不跑全量（还没有教程可跑），但要跑一次**单点**确认搬运没坏：
`docker compose up -d --build arena` + 容器内 `npx vitest run server/test/notebooks/kernel.test.ts` ⇒ `30 passed`。
（⚠ `up -d --build` 可能报 `Container … Running` 而**没重建**：验之前先核对容器里那份文件与宿主一致 —— WI-94 Task 4c 就是这么抓到并做了 md5 核对。）

- [ ] **Step 7: Commit**（`test(notebooks): WI-90 Task 1 —— 教程可运行闸门（执行层 + 结论 marker）与两件工具抽出共享`）

---

## Task 2：篇 1 `01-skew-and-hot-keys`（倾斜与热点 key）

**Files:**
- Create: `content/notebooks/01-skew-and-hot-keys.ipynb`
- Modify: `server/test/notebooks/tutorial-claims.ts`（登记本篇 slug）

**Interfaces:**
- Consumes: Task 1 的闸门与 `markerOf`
- Produces: 一篇能在容器里被 `nbconvert --execute` 跑通的 notebook，slug 集合 =
  `['hot-key-dominates', 'salting-halves-max-partition', 'salting-preserves-result', 'broadcast-changes-plan']`

- [ ] **Step 1: 先把注册表登记上（让它红）**

`TUTORIAL_CLAIMS` 加：

```ts
  '01-skew-and-hot-keys.ipynb': ['hot-key-dominates', 'salting-halves-max-partition', 'salting-preserves-result', 'broadcast-changes-plan'],
```

- [ ] **Step 2: 写 notebook（4 段结构 + 代码单元逐个如下）**

JSON 骨架（`metadata` 必须是这个形状，kernel 那条判据读它）：

```json
{"cells": [ /* 见下 */ ],
 "metadata": {"kernelspec": {"display_name": "PySpark (arena)", "language": "python", "name": "arena-pyspark"},
              "language_info": {"name": "python"}},
 "nbformat": 4, "nbformat_minor": 5}
```

单元按顺序（`md` = markdown，`code` = code）：

1. `md` 标题与本篇要回答的问题：**"一个 task 跑了 90% 时间"这个坏结果，怎么用本地这台机器量出来、三种解法各治哪一半**。写破边界：本机是 `local[*]`，没有节点级 shuffle 与 fetch failed，"某台机器被拖垮"这类失效模式本机演示不了，凡涉及它都标未验证。
2. `code` 建立 session（**不预设 shuffle 分区**，配置在①里显式设，读者看得见）：
   ```python
   import time
   from pyspark.sql import SparkSession, functions as f

   spark = SparkSession.builder.appName("wi90-01-skew").getOrCreate()
   spark.conf.set("spark.sql.shuffle.partitions", 8)
   spark.conf.set("spark.sql.adaptive.enabled", False)   # 先关掉 AQE：① 要量的是"没有它时"的坏形状
   print("spark", spark.version)
   ```
3. `code` ① 现象 —— 确定性造一个 40% 落在同一个 key 上的事实表：
   ```python
   N = 1_000_000
   events = (
       spark.range(N)
       .withColumn("user_id",
           f.when(f.col("id") % 5 < 2, f.lit("HOT"))                       # 恰好 40% 落到一个 key
            .otherwise(f.concat(f.lit("u"), (f.col("id") % 199_000).cast("string"))))
       .withColumn("amount", (f.col("id") % 100).cast("long"))              # long：两种聚合顺序之和必须逐位相等
   )
   events.createOrReplaceTempView("events")
   print("行数", events.count())
   ```
4. `code` ② 取证 —— 把"一个分区占大头"量成一个数（**分区行数占比**，不靠耗时）：
   ```python
   def max_partition_share(df):
       """聚合后每个分区（≈每个 hash 桶）的行数占比，降序。这是"倾斜"最便宜也最可复现的量法：
       它不看耗时，因此在同一镜像上每次都给同一个数。"""
       counts = df.rdd.mapPartitions(lambda it: iter([sum(1 for _ in it)])).collect()
       total = sum(counts)
       return sorted((c / total for c in counts), reverse=True), total

   plain = events.groupBy("user_id").agg(f.sum("amount").alias("amount"), f.count().alias("n"))
   shares_before, _ = max_partition_share(plain)
   hot_share = (events.filter(f.col("user_id") == "HOT").count()) / N
   print("每个分区的行数占比（前 5）", [round(s, 4) for s in shares_before[:5]])
   print("HOT 这个 key 占全表比例", round(hot_share, 4))

   assert hot_share > 0.35, hot_share
   assert shares_before[0] > 0.30, shares_before
   print(marker := "WI90[01-skew-and-hot-keys][hot-key-dominates] OK")
   ```
   ⚠ `explain` 里的算子名随版本变（3.5 是 `Scan parquet`，4.x 起有 `FileScanCompute` 一类）。所以②里**以本篇实际跑出的文本为准**贴，不写"你也会看到这行"；本篇只做一件脆弱性最低的计划解读：
   ```python
   plan = df._jdf.queryExecution().simpleString()   # ⚠ 唯一在本镜像可用的取计划写法，见下面那条实测
   print(plan)                                     # 教学用：让人看见 Exchange hashpartitioning 那一行
   assert "hashpartitioning(user_id, 8)" in plan, "计划里没有那次 shuffle ⇒ 前提不成立，别改断言，改数据/配置"
   ```
   ⚠⚠ 这一段原计划写的是 `plain._jdf.executedPlan()` 与 `assert "Exchange" in plain.explain()`，
   **两条都是坏的 API 用法，篇 1 落地时实测顶回**（2026-10-10）：
   `df._jdf` 是 Java `Dataset`，它**没有** `executedPlan()` / `physicalPlan()`（`Py4JError: Method executedPlan([]) does not exist`，
   要取执行计划得走 `df._jdf.queryExecution().executedPlan()`）；`DataFrame.explainString` 在 3.5.5 不存在；
   而 `df.explain()` 是 **print 到 stdout 然后返回 `None`** —— 原写法 `assert "Exchange" in plain.explain()` 实际是 `in None`，
   直接 `TypeError`（红是红了，但红的原因是"用错了 API"，不是"结论不成立"，这种红会把人引去改断言）。
   ⇒ 三篇教程取计划文本一律 `df._jdf.queryExecution().simpleString()`（执行后的计划才需要 `queryExecution().executedPlan()`）；
   `explain()` 只用来打印给读者看。
5. `code` ③ 解法 A —— 加盐两阶段聚合（治**聚合**那一半）：
   ```python
   SALT = 16
   salted = (
       events.withColumn("salt", f.col("id") % SALT)
       .groupBy("user_id", "salt")
       .agg(f.sum("amount").alias("amount"), f.count().alias("n"))
   )
   unsalted = salted.groupBy("user_id").agg(f.sum("amount").alias("amount"), f.sum("n").alias("n"))
   shares_after, _ = max_partition_share(unsalted)
   print("加盐后每个分区行数占比（前 5）", [round(s, 4) for s in shares_after[:5]])

   assert shares_after[0] < shares_before[0] / 2, (shares_before[0], shares_after[0])
   print("WI90[01-skew-and-hot-keys][salting-halves-max-partition] OK")
   ```
6. `code` ④ 量差异 —— 加盐**不许改变答案**（这条最硬，也最容易被"看起来更快"盖过去）：
   ```python
   only_plain = plain.join(unsalted, ["user_id"], "left_anti").count()
   only_salted = unsalted.join(plain, ["user_id"], "left_anti").count()
   mismatch = (
       plain.join(unsalted, ["user_id"], "inner")
       .filter((plain.amount != unsalted.amount) | (plain.n != unsalted.n))
       .count()
   )
   print("只在一侧的 key", only_plain, only_salted, "值不一致的 key", mismatch)
   assert (only_plain, only_salted, mismatch) == (0, 0, 0), (only_plain, only_salted, mismatch)
   print("WI90[01-skew-and-hot-keys][salting-preserves-result] OK")
   ```
7. `code` ③ 解法 B/C —— 广播绕开 shuffle join（治 join 那一半）。断言押在**计划里的算子名**上：
   ```python
   dim = (spark.range(50)
          .select(f.concat(f.lit("u"), f.col("id").cast("string")).alias("user_id"),
                  f.col("id").alias("dim_v")))
   keys = events.select("user_id").distinct()
   smj = keys.join(dim, "user_id", "left")
   spark.conf.set("spark.sql.autoBroadcastJoinThreshold", -1)
   plan_smj = smj.explainString() if hasattr(smj, "explainString") else smj._jdf.queryExecution().toString()
   spark.conf.set("spark.sql.autoBroadcastJoinThreshold", 10 * 1024 * 1024)
   plan_bcast = smj._jdf.queryExecution().toString()
   print("关掉广播阈值：", [ln for ln in plan_smj.splitlines() if "Join" in ln][:4])
   print("放开广播阈值：", [ln for ln in plan_bcast.splitlines() if "Join" in ln][:4])
   assert "SortMergeJoin" in plan_smj, "阈值关了还不走 sort-merge ⇒ 本机数据形状与假设不符，别改断言，看上面的计划行"
   assert "BroadcastHashJoin" in plan_bcast
   print("WI90[01-skew-and-hot-keys][broadcast-changes-plan] OK")
   ```
   ⚠ 上面那份 `hasattr` 试探是**给你手测用的脚手架**，落地时删掉：先用一次性脚本跑出两种阈值下的真实计划文本，**按实测算子名写断言**，把没用的分支删干净。
   ⚠ ③ 解法 C（`hint("skew")` + `spark.sql.adaptive.skewJoin.enabled`）**不断言**：AQE 的 skew join 只在 shuffle 统计真倾斜时才生效，`local[*]` 上小数据常常不触发。写成"跑一遍看计划与 `explain()` 里有没有 skew 痕迹，把实测文本贴在这里"，并明确一句：**skew hint 救 join、救不了聚合**（这是本篇最值钱的一句话，不需要时间也能成立）。
8. `code` 计时对照（只打印，不断言）：三种写法各跑一次 `count()` 与真实聚合，打印耗时与 `shares_before/shares_after`。
9. `md` ⑤ 速查表（`spark.sql.shuffle.partitions`、`advisoryPartitionSizeThreshold`、`adaptive.*`、`skewJoin.*`：默认值 / 什么时候动 / 动错的表征）+ 追问链（count distinct 为什么更容易倾斜、空 key 怎么处理、**为什么 skew hint 救不了聚合**——这条要推到机制层：聚合的倾斜发生在 hash 分区那一步，而 skew join 的改写只针对 join 的 key）。
10. `md` 题库指针：`bd-pyspark-0001`（匿名流量占九成的 UV：热点 key 拆分 + 两阶段精确去重 —— 本篇面试题的本体）与 `bd-pyspark-0002`（join 右表多版本导致行数膨胀：先收敛维度再广播 —— 广播绕开倾斜那一解）。
11. `code` 收尾：`spark.stop()`（**最后一个单元**；闸门据此不往容器里丢活内核，WI-93 那条"没守护"的反面是"闸门跑完攒一核"）。

- [ ] **Step 3: 手测 → 落闸门 → 校准**

```bash
docker compose up -d --build arena
docker compose exec -T arena env ARENA_IN_CONTAINER=1 ARENA_NOTEBOOK_SERVICE=1 npx vitest run server/test/notebooks/tutorials.test.ts > /tmp/wi90-t2-gate.log 2>&1; echo "GATE_EXIT=$?"
```
Expected: `GATE_EXIT=0`，本篇用时 ≤ 90s（超了就缩 `N`，并同步改①里那两条阈值 —— 阈值与数据量必须一起校准）。
**把本篇真实跑出来的数字**（行数、`hot_share`、`shares_before[0]`、`shares_after[0]`、三种写法的耗时、spark 版本）写进⑤段与提交信息。

- [ ] **Step 4: 破坏性验证（这一篇要给结论层一次真的反证）**

1. 把①里 `id % 5 < 2` 改成 `id % 5 == 0`（20% 而非 40%）⇒ `hot-key-dominates` 那条 marker 之前的 `assert` 必须红，且红在**断言**不是异常栈丢失；
2. 把⑤的 `assert shares_after[0] < shares_before[0] / 2` **删掉**（结论被删的坏法）⇒ 闸门必须红在"没打出结论标记"（这就是 Ruling(B1) 存在的理由，实测输出贴进注释）；
3. 把 `metadata.kernelspec.name` 改成 `python3` ⇒ 必须红在 kernel 那条（红线①的教学版示范）；
4. 全部还原，`GATE_EXIT=0`。

- [ ] **Step 5: 宿主档 + Commit**

`npm run verify:fast > /tmp/wi90-t2-fast.log 2>&1; echo "FAST_EXIT=$?"` ⇒ 0（常驻那一组要能判住注册表形状与清单一致性）。
Commit：`feat(notebooks): WI-90 Task 2 —— 篇 1 倾斜与热点 key（加盐不改变答案是硬证据）`

---

## Task 3：篇 2 `02-small-files-and-partitioning`（小文件与物理设计）

**Files:**
- Create: `content/notebooks/02-small-files-and-partitioning.ipynb`
- Modify: `server/test/notebooks/tutorial-claims.ts` → `['file-count-is-what-you-write', 'small-files-get-merged-on-read', 'open-cost-drives-partitions', 'coalesce-not-shuffle', 'coalesce-cuts-files-not-rows']`
  （第三条纹许按实测改名，见 Step 2 ② 那条 ⚠：注册表与 notebook 里的 marker 必须同时改，改一边就红在双向相等那条）

- [ ] **Step 1: 登记 slug**（同上形状）

- [ ] **Step 2: 写 notebook**

结构同篇 1。关键单元（scratch 目录必须在**容器内可写、且不在 `data/notebooks`**，否则用户文件列表里会长出一堆 `wi90-*`）：

```python
import glob, os, shutil, tempfile, time
from pyspark.sql import SparkSession, functions as f

spark = SparkSession.builder.appName("wi90-02-small-files").getOrCreate()
# ⚠ `spark.range` 没有 seed 参数（见上面的全局约束，篇 1 实测顶回）—— 这里没有任何随机，确定性来自 range 本身
df = spark.range(200_000)
SCRATCH = tempfile.mkdtemp(prefix="wi90-02-")          # 不进 data/notebooks：那是读者的工作区
```

（篇 1 落地时把 `f"/tmp/wi90-xx-{os.getpid()}"` 换成了 `tempfile.mkdtemp(prefix=...)`：同一个理由
（不许写进 `data/notebooks`），但 `mkdtemp` 会**自己挑一个不冲突的路径**，而按 pid 拼的名字
在 kernel 复用同一个 pid 时会撞上上一篇的残留。沿用篇 1 的形状，别再回退成手拼 `/tmp` 路径。）

① 现象 —— 默认 `shuffle.partitions=200` 的 `append` 反复写，是"目录爆炸"最常见的真实来源；这里用 `repartition(2000)` 一次性把它做出来：

```python
many = f"{SCRATCH}/many"
spark.conf.set("spark.sql.adaptive.enabled", False)   # ⚠ 见下面那条"篇 1 实测顶回"
spark.conf.set("spark.sql.shuffle.partitions", 2000)  # 与 repartition(2000) 同一个数：教的是"你写多少分区就有多少文件"
df.repartition(2000).write.mode("overwrite").parquet(many)
files = glob.glob(f"{many}/part-*.parquet")
sizes = sorted(os.path.getsize(p) for p in files)
print("文件数", len(files), "最小/中位/最大字节", sizes[0], sizes[len(sizes)//2], sizes[-1])
assert len(files) == 2000, len(files)
assert sizes[-1] < 1_000_000, sizes[-1]
print("WI90[02-small-files-and-partitioning][file-count-is-what-you-write] OK")
```

⚠⚠ **这一条在 AQE 开着的时候必然红，而原因正是本篇要教的东西之一**（2026-10-10 由篇 1 实测确定，
不是推测）：篇 1 量到 `shuffle.partitions=200` + AQE 开 ⇒ 落盘只有 **2 个文件**（`local[2]` 的
`defaultParallelism`），因为 `coalescePartitions` 在写侧就把分区合掉了。
所以这一节**必须显式关掉 AQE** 才能得到"2000 个分区 = 2000 个文件"那个现象；
而"为什么开着 AQE 就合成了 2 个文件"本身就值得写进 ① 的 markdown（它是"你设的分区数只是上限"这一课的现成数字）。
关掉 AQE 这件事要写成**前提断言**（与篇 1 ② 同一形状：红话要说得出"是配置没了，不是现象消失了"）。

⚠ `len(files) == 2000` 与 `sizes[-1] < 1_000_000` 这两个数**都是写计划时的推测，不是实测**。
先手测把真实数字量出来再落地：若空分区不产文件导致真实文件数 < 2000，那要改的是**这一条教的那句话**
（"你写多少分区就有多少文件"在有空分区时不成立 —— 这本身就是一个值得写进教程的坑），
不许改成 `>= 1500` 这种"总能过"的松弛判据。实测的两个数写进注释与提交信息。

② 取证 —— 读侧把小文件**合并成输入分区**，量的是 `getNumPartitions()`（确定性）：

```python
spark.conf.set("spark.sql.files.maxPartitionBytes", 128 * 1024 * 1024)
spark.conf.set("spark.sql.files.openCostInBytes", 4 * 1024 * 1024)
merged = spark.read.parquet(many)
n_merged = merged.rdd.getNumPartitions()
print("2000 个文件读回来 ⇒ 输入分区数", n_merged)
assert n_merged < len(files) // 2, (n_merged, len(files))
print("WI90[02-small-files-and-partitioning][small-files-get-merged-on-read] OK")
```

把"合并"这个默认行为**关掉**，分区数就会爬回文件数量级 —— 这一条是 `openCostInBytes` 的正面证据：

```python
spark.conf.set("spark.sql.files.openCostInBytes", 0)
spark.conf.set("spark.sql.files.maxPartitionBytes", 1024 * 1024)
n_split = spark.read.parquet(many).rdd.getNumPartitions()
print("openCost=0 且每分区预算 1MB ⇒ 输入分区数", n_split)
assert n_split > n_merged, (n_merged, n_split)
print("WI90[02-small-files-and-partitioning][open-cost-drives-partitions] OK")
```

⚠ **上面这两行配置的方向很可能是反的，落地前必须先量**（写计划时我以为 `openCost=0` 会让分区数爬回文件数量级，
但决定读侧打包的是"每个分区的预算 `maxPartitionBytes`"对"单个文件的真实字节数"的比值：
篇 2 的文件每个只有几百字节到几 KB，`maxPartitionBytes=1MB` 时一个分区照样装得下上千个文件 ⇒ 分区数可能**比 `n_merged` 更少**）。
真要得到"每个文件自己一个分区"，是把 `maxPartitionBytes` 压到**小于单文件字节数**那一侧。
⇒ 做法：先跑一次把三组配置的**实测分区数**打出来（默认 / 只改 openCost / 只改 maxPartitionBytes 到小于文件大小），
再据此定这一节教的那句话与断言方向。**marker 的名字也必须跟着实测结论改**
（如果量出来是"`maxPartitionBytes` 才主导、`openCostInBytes` 在这种文件尺寸下几乎不动"，
那 slug 就该叫 `max-bytes-not-open-cost-decides-it` —— 这一条按事实写反而是本篇最有价值的纠正，
因为"小文件多就一定是 openCost 的锅"是网上流传的口径）。**不许为了保住我原来的 slug 把断言改成恒真。**

③ 解法 —— `coalesce` 不 shuffle、`repartition` 全 shuffle，断言押在计划文本：

```python
spark.conf.set("spark.sql.shuffle.partitions", 200)
plan_coalesce = df.coalesce(8)._jdf.queryExecution().simpleString()
plan_repart  = df.repartition(8)._jdf.queryExecution().simpleString()
print(plan_coalesce); print(plan_repart)
assert "Exchange" not in plan_coalesce, plan_coalesce          # coalesce 不引入 shuffle
assert "Exchange" in plan_repart, plan_repart                   # repartition 一定走 shuffle
print("WI90[02-small-files-and-partitioning][coalesce-not-shuffle] OK")
```

④ 量差异 —— 三种写法落盘的文件数与读回耗时（**耗时只打印**），断言只押"文件数下降、行数守恒"：

```python
few = f"{SCRATCH}/few"
t0 = time.perf_counter(); df.coalesce(8).write.mode("overwrite").parquet(few); t_write = time.perf_counter() - t0
few_files = glob.glob(f"{few}/part-*.parquet")
t1 = time.perf_counter(); rows_many = spark.read.parquet(many).count(); t_read_many = time.perf_counter() - t1
t2 = time.perf_counter(); rows_few  = spark.read.parquet(few).count();   t_read_few  = time.perf_counter() - t2
bytes_many = sum(os.path.getsize(p) for p in files)
bytes_few = sum(os.path.getsize(p) for p in few_files)
print("many:", len(files), "文件 /", bytes_many, "字节 / 读回", round(t_read_many, 2), "s")
print("few :", len(few_files), "文件 /", bytes_few, "字节 / 读回", round(t_read_few, 2), "s")
assert len(few_files) == 8, len(few_files)
assert rows_many == rows_few == 200_000, (rows_many, rows_few)
assert bytes_few <= bytes_many, (bytes_few, bytes_many)   # 每文件 footer 那份固定开销，合并后确实省下来
print("WI90[02-small-files-and-partitioning][coalesce-cuts-files-not-rows] OK")
```

⚠ 这一条原来写的是 `assert t_read_few <= t_read_many * 2`（"读回不慢于对照 2 倍"），**按 Ruling(B1) 删掉了**：
它名义上是"护栏不是结论"，但一条押耗时的断言就是会把闸门撞红的东西，而"护栏"这个词不改变它的性质。
删掉之后 slug 也不许再留 `fewer-files-not-slower-read` —— 那个说法没有任何确定量在判它，
留着就是"marker 宣称了一件没被证明的事"（正是这道闸门要拦的形状）。换成 `coalesce-cuts-files-not-rows`，
押三件当场可判的：文件数、行数守恒、合并后总字节不增。
**"更少文件不等于更快读"这句结论进 markdown**，带上上面打印的两个耗时，并按纪律 2 写清本机测不到真实集群那部分
（kernel 是 `local[2]`：一个 JVM 两个线程，open 成本被同进程的 CPU 掩盖）。

⑤ 收尾（最后一个单元）：

```python
shutil.rmtree(SCRATCH, ignore_errors=True)
assert not os.path.exists(SCRATCH), "scratch 没清干净 ⇒ 闸门每跑一次就在 /tmp 里留一份 parquet"
spark.stop()
```

- [ ] **Step 3: 手测、跑闸门、校准**（同 Task 2 Step 3；把真实的文件数/大小/分区数/耗时写进⑤与提交信息；**若 `openCostInBytes` 那一对阈值在本机给不出方向差**，就改用能给出差的预算组合，并把实测两组数字写进注释 —— 不许把断言改成恒真）

- [ ] **Step 4: 破坏性验证**：① 把 `repartition(2000)` 改成 `coalesce(2000)`（落盘文件数变少）⇒ `file-count-is-what-you-write` 必须红；② 把 `openCostInBytes` 那一段的两行删掉 ⇒ `open-cost-drives-partitions` 必须红；③ 删掉收尾的 `shutil.rmtree` ⇒ 那条 `assert not exists` 必须红，且**跑两次之后 /tmp 里出现残留**（把 ls 输出贴进报告，这条判据的价值就在这）；④ 还原 ⇒ `GATE_EXIT=0`。

- [ ] **Step 5: markdown ②/⑤ 段**：分区键选高基数列会发生什么（目录数量 = 基数 × 每次写入的文件数，正是 `bd-pyspark-0005` 那道"目录爆炸"的量法）；增量覆盖写怎么避免小文件（`partitionOverwriteMode` 的口径 + 一次合并写的取舍）；题库指针 `bd-pyspark-0005`。

- [ ] **Step 6: 宿主档 + Commit**（`feat(notebooks): WI-90 Task 3 —— 篇 2 小文件与物理设计（读侧合并用 getNumPartitions 量）`）

### Task 3 落地后按实测订正（2026-10-10；上面那些"推测值"有六处被量出来的数字否掉，留原文作为论证过程）

1. **`openCostInBytes` 是加在每个文件上的字节成本（加性项）**，调小 ⇒ 打包更狠 ⇒ 分区**更少**。
   `maxPartitionBytes` 钉 128MB 时实测阶梯：`0→3 / 1MB→16 / 2MB→32 / 出厂 4MB→63 / 64MB→1000`。
   ⇒ 本节原来那对配置（`openCost=0` + `maxBytes=1MB`）实测给 **3**，断言 `n_split > n_merged` 会红；
   "每文件一个分区"要靠把 `maxPartitionBytes` 压到 1MB（实测恰好 2000），压到 512B（低于单文件字节）⇒ **4000 > 文件数**
   （parquet 在输入分区规划这一层按字节可切）。slug 因此改名 **`open-cost-is-additive`**。
   ⚠ 我给的另一个候选名 `max-bytes-not-open-cost-decides-it` **也不成立**（主导项恰恰是 openCost）—— 实现者按实测拒了两个候选名、用了机制名，这是对的。
2. **① 的现象不依赖关掉 AQE**：显式 `repartition(200/2000)` 两档都落 200/2000 个文件，
   **AQE 的 `coalescePartitions` 只合它自己推导出来的那个分区数**（聚合那一路实测 199→1）。
   ⇒ 上面那条"⚠⚠ 不开 AQE 就必然红"是我从篇 1 的**聚合**数字推广到**显式 repartition** 得到的错误结论；
   前提断言仍保留（形状对），但红话改成"配置被删了，不是现象消失了"。**教训：一个算子族量出来的数不许推广到另一个族。**
3. **`coalesce` 不能提升并行度**：`spark.range(200_000)` 在 `local[2]` 上只有 **2** 个分区（= `defaultParallelism`，不是 200），
   所以 ④ 那句 `df.coalesce(8).write ⇒ 8 个文件`实测落 **2** 个文件。⇒ 合并写的源改成 ② 读回来的 63 个输入分区（恰好 8），
   并把"2 分区的源 coalesce(8) 还是 2"本身断言出来。
4. **空分区不产文件，连 `.crc` 都不留**：`len(files)==2000` 侥幸成立（round-robin 无空分区），但聚合那族实测 **199/200**；
   目录条目账目实测 `199 数据 + 199 crc + _SUCCESS + ._SUCCESS.crc = 400` ⇒ 正文写成"文件数 = **非空 writer** 数"。
5. **合并写的总字节不逐次稳定**（950,484 ↔ 950,544 / 978,523 ↔ 978,615，漂约 0.01%）
   ⇒ 断言里只留不等式与计数（`bytes_few < bytes_many`、`avg_few > 100 × avg_many`、文件数、行数），正文表格标注漂移。
6. **`SET -v` 不列某些键**（`spark.sql.files.openCostInBytes` 查不到；`spark.sql.maxRecordsPerFile` 这一版 `conf.get` 读不到；
   整型键传非数字 default 会抛 `IllegalArgumentException` 而不是返回 default）⇒ "出厂值怎么读"这件事在篇 3 的派发里已单独提醒。

成本实测：本篇 56-66s（篇 1 是 34s），其中 **20.3s 花在"写出 2000 个文件"那一步** —— 那是现象本体，缩不掉。
三篇排队时 `TUTORIAL_TIMEOUT_MS=120s` 那对预算要在交付档再确认一次。

---

## Task 4：篇 3 `03-reading-the-plan-and-aqe`（计划解读与 AQE）

**Files:**
- Create: `content/notebooks/03-reading-the-plan-and-aqe.ipynb`
- Modify: `server/test/notebooks/tutorial-claims.ts` → `['broadcast-threshold-changes-join', 'shuffle-partitions-is-a-plan-number', 'aqe-coalesces-shuffle-read', 'aqe-coalescing-is-one-switch']`

- [ ] **Step 1: 登记 slug**

- [ ] **Step 1b: cell 清单（篇 1/篇 2 落地后补齐这一节 —— 前两档的简报都有一张"每格判什么"的清单，
  原来这一档只给了三段代码骨架，那就等于让实现者自己决定一篇 senior 教程的结构。按前两篇已定的形状补齐）**

  1. `markdown` 标题格：这一篇要回答的坏结果是**"给了你一份 plan，你先读哪三行"**（与前两篇的"一个 task 跑了 40 分钟"、
     "目录爆炸"各自分工，不许互相复述）。开头就写破三件事：本机能演示到哪一层（`local[2]` 不是 `local[*]`，
     没有节点、没有 fetch failed、driver 512MB）、结论押在确定量而耗时只打印、内核必须选 `arena-pyspark` 以及为什么（红线①）。
  2. `code` 会话格：`getOrCreate()` + 打印 `spark.version` / `master` / `defaultParallelism`，
     并**先 `SET -v` 读一遍本篇要改的那几个键的出厂值**（篇 1 的形状：默认值不许背，要当场读）。
  3. `code` 数据格：`big = spark.range(N)` 加确定性表达式造两列 —— `k = id % 50`（聚合键，50 个键 ⇒ 不倾斜，
     这一篇讲的是**计划形状**不是倾斜，别把篇 1 的现象搬过来）、`v = (id % 100).cast("long")`（long，理由同篇 1：
     整数加法与顺序无关）。维表 `dim = spark.range(50)` 上一格已给形状。**N 先按 ≤ 90s 预算定，量完再调**（篇 2 用 200,000，
     本篇要跑好几次 200 分区的聚合，`local[2]` 上可能更慢 —— 超了就减 N，不许减判据）。
  4. `markdown` ① 现象：逐节读 `simpleString()` —— `Exchange hashpartitioning(...)` 是那次 shuffle、
     `HashAggregate` 的输入分区数从哪来、`WholeStageCodegen` 被什么打断（Exchange / `AQEShuffleRead` /
     `ColumnarToRow`），以及**为什么 `explain()` 不能当判据**（它 print 然后返回 None，篇 1 实测过）。
  5. `code` ①：把那张表按"每一行是什么"讲完，只 print 不断言（这是给读者看的地图）。
  6. `code` ② `shuffle-partitions-is-a-plan-number`：`adaptive=False` + `shuffle.partitions=200` ⇒
     `agg.rdd.getNumPartitions() == 200`（配置说话），再换成 8 量一次证明那个数**是被配置写的、不是猜的**。
  7. `code` ③ `broadcast-threshold-changes-join`：两个阈值**各新建一个 DataFrame**取计划（篇 1 的 lazy val 坑），
     断言两头各自的算子名，并把"关掉阈值不许出现 Broadcast / 放开不许残留 SortMergeJoin"两条反向断言一起带上（篇 1 已立的形状）。
  8. `code` ④ `aqe-coalesces-shuffle-read` + `aqe-coalescing-is-one-switch`：见下面 Step 2 那两段（**先手测 executedPlan 的文本形状**）。
  9. `code` ⑤ 耗时对照：AQE 开 / 关各跑一次 `count()`，**只 print 两个数**；这里就是"更少分区 ≠ 更快"那句话的现场，
     但它不进任何 assert。
  10. `markdown` ⑥ 速查表 + 追问链 + 本篇没验的东西（逐条列，纪律 2），并**必须**含一条把答案推到机制层的追问
      （规格 §7.3 要求的就是这一条）。
  11. `markdown` 题库指针格：`bd-pyspark-0002` 与 `bd-pyspark-0010`，各自说清"对应本篇哪一节"。
  12. `code` 收尾：`spark.stop()`（**必须是最后一个 code cell** —— `tutorials.test.ts` 现在有一条结构性判据判它，m6）。

  ⚠ **三条从前两篇的评审里定下来的写法纪律，这一篇从第一天就按它写**（前两篇都返了工）：
  ① **每个打 marker 的 cell 里必须有语句级 `assert`**（宿主档有牙，删 assert 留 print 会直接红，别再制造一次）；
  ② **一条 slug 只挂一句结论**：同一 cell 里多条 assert 若是"同一结论的不同侧面"（前提 / 对照）可以在注册表注释里写明后搭车，
     否则拆 slug（拆就要同时改注册表与 marker，改一边红在双向相等）；
  ③ **"实测"两个字只能用在真的打印过的东西上**（篇 1 有条"（实测）"其实全篇没打印那个配置键，被抓到）；
  跨版本史实本镜像量不到的，写"未逐版本核实，迁移以官方配置页为准"，**不要编版本号**。

- [ ] **Step 2: 写 notebook**（要点与判据形状；**AQE 那两处的计划文本形状必须先手测**，本篇是四道判据里最容易"照猜写断言"的一篇）

① 建一张会 shuffle 的表，`explain('formatted')` 逐节读（`Exchange` / `HashJoin` vs `BroadcastHashJoin` / `WholeStageCodegen` 被什么打断）。
③ 三段 AQE 各管一件事：`coalescePartitions` / 动态 join 策略 / `skewJoin`。逐段量：

```python
spark.conf.set("spark.sql.adaptive.enabled", False)
spark.conf.set("spark.sql.shuffle.partitions", 200)
agg = big.groupBy("k").count()
parts_planned = agg.rdd.getNumPartitions()
assert parts_planned == 200, parts_planned     # 计划里那个数是配置说了算
```

AQE 打开后**触发一次执行**，再读 executedPlan 里那个被合并出来的分区数（形状要实测；下面是 3.5 上常见的写法，落地前用一次性脚本确认，别照抄）：

```python
spark.conf.set("spark.sql.adaptive.enabled", True)
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", True)
import re
_ = agg.count()                                  # AQE 只在 shuffle 物化之后才有统计可决策
plan_txt = agg._jdf.queryExecution().executedPlan().toString()
print("\n".join(ln for ln in plan_txt.splitlines() if "AQE" in ln or "ShufflePartitions" in ln))
m = re.search(r"AQEShuffleRead\s*(?:coalesced|partitioning\s+([\w ]+))?\s*(?:\(\d+\)\s*)?(\d+)\s*partition", plan_txt)
assert m, f"没从 executedPlan 里认出 AQEShuffleRead ⇒ 这台镜像的回话形状与假设不同，把上面打印的计划行读一遍再改解析，别放宽断言"
coalesced = int(m.group(2))
assert coalesced < parts_planned, (coalesced, parts_planned)
print("WI90[03-reading-the-plan-and-aqe][aqe-coalesces-shuffle-read] OK")
```

`aqe-coalescing-is-one-switch` 是这一篇最值钱的一条，也是原计划写得最虚的一条。
原文那条 slug 叫 `aqe-not-always-faster`，押的是 `assert coalesced < parts_planned and t_aqe_on > 0` ——
两处毛病：**前半与 `aqe-coalesces-shuffle-read` 判的是同一个事实**（两条 marker、一件事，第二条什么都没加），
**后半 `t_aqe_on > 0` 恒真**（一次 count 的耗时永远大于 0，这条断言不判任何东西，而"aqe-not-always-faster"
这个名字宣称的东西没有任何东西在判它）。按 Ruling(B1) 与"marker 不许宣称未被证明的事"，改成：

```python
# 换一个开关，判"是谁把读侧合并的"：coalescePartitions 关掉 ⇒ 合并这件事就没了
# ⚠ 必须重新构造一个 agg 再执行：复用上一个已经产过 executedPlan 的 DataFrame，读到的可能是缓存的那份计划
small = big.groupBy("k").agg(f.sum("v").alias("s"))
spark.conf.set("spark.sql.adaptive.enabled", True)
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", False)
_ = small.count()
plan_txt2 = small._jdf.queryExecution().executedPlan().toString()
print("\n".join(ln for ln in plan_txt2.splitlines() if "AQEShuffleRead" in ln))
m2 = re.search(r"AQEShuffleRead", plan_txt2)
merged2 = parse_executed_read_partitions(plan_txt2)   # 与上面同一个解析函数，落地时抽成一个本地 helper，不要复制两份正则
print(f"关掉 coalescePartitions ⇒ 读侧分区数 {merged2}（计划里是 {parts_planned}）")
assert merged2 == parts_planned, (merged2, parts_planned)
print("WI90[03-reading-the-plan-and-aqe][aqe-coalescing-is-one-switch] OK")
```

**"更少分区 ≠ 更快"这句结论降级到 markdown**，并带上当场打印的两个耗时（AQE 开 / 关各一次 `count()`）——
数字来自本篇实测，符合纪律四；但它**不进断言**，因为一条押耗时的断言就是把闸门交给机器负载
（`local[2]` 上 CPU 抢不过判题池时它先红，而红出来的话是"教程坏了"）。
markdown 里那句要按纪律 2 收口：本机能量到的是"AQE 把读侧合并了、并多出一层 stage 边界"，
"因此在真实集群上更慢/更快"**标未验证**。

- [ ] **Step 3: 手测 + 闸门 + 校准**（同上。若 `AQEShuffleRead` 在本镜像的文本形状不同，改解析并**把实测原文贴进注释**，不许放宽断言）

- [ ] **Step 4: 破坏性验证**：① `autoBroadcastJoinThreshold` 两段调换顺序 ⇒ `broadcast-threshold-changes-join` 必须红；② **（2026-10-10 按实测改写：原来这条不成立）** 只删 `_ = agg.count()` 在本镜像**不会红** ——
   `df.rdd` 自己就会 finalize 计划（什么都没跑时它给 1），所以"顺序依赖"要用**三条文本互不相同**来判：
   执行前 / 只 `count()` 之后 / 读过 `rdd` 之后，各取一次计划文本互不相等；验证动作改成**同时删掉那两步物化**，
   实测红在"`AQEShuffleRead` 认不出来"那一条（红话要说得出"是物化那两步没了，不是结论错了"）；
   ③ 把 `shuffle.partitions` 从 200 改成 8 ⇒ `shuffle-partitions-is-a-plan-number` 必须红（实测红话里带出 `PLANNED=(8,8)`）；
   ④ 把 `coalescePartitions.enabled` 那行删掉（= 让它保持默认 true）⇒ `aqe-coalescing-is-one-switch` 必须红在"读侧被合并了"
   （这一条同时证明"这一篇真的在判那个开关"，而不是判 AQE 大开关；实测消息带出 `(200,1,1)`）。

⚠ **Step 2 里那两段 executedPlan 的写法也被实测否掉了**（同一档实现者顶回，全部有据）：
① **`executedPlan().toString()` 里根本没有 `AQEShuffleRead`**（实测 0 次，它仍打 `Exchange hashpartitioning(k#22L, 200)`），
   那个算子只出现在 `explain("formatted")` 的文本里、**而且不带分区数** ⇒
   判据必须拆成两半：formatted 文本里认算子 + **数字走 `df.rdd.getNumPartitions()`**（实测 1 vs 200）。
② `ColumnarToRow` **不打断** `WholeStageCodegen`（实测 `*(1)` 同时罩住 HashAggregate / ColumnarToRow / FileScan）
   ⇒ "计划地图"那句要改成"**只有 Exchange 打断**"。
③ 广播阈值那格：`assert est[dim] < 10MB < est[big]` 在容器里当场红 —— `big` 的**编译期估计只有 3,200,000 B**，
   远小于 10MB ⇒ 改成 `-1 / 512 / 4096` **三档把那个 600 B 夹住**，并新增篇 1 没量过的一维：`Exchange` 条数 `2→2→0`。
④ "更少分区 ≠ 更快"本机量出来**方向相反**（AQE 开 0.05s 级、关 0.41~0.47s 级）⇒ 那句结论在 markdown 里
   只能写"本机既没证明也没证伪"，**不进断言、不进 marker**（Ruling(B1) 与"marker 不许宣称未被证明的事"同一把尺子）。

- [ ] **Step 5: markdown**：⑤ 追问链"怎么证明 broadcast 把 executor 撑爆了"（本机标未验证：kernel 是 `local[2]`，一个 JVM 里两个线程，没有独立 executor 内存这条线，只能看 `BroadcastExchange` 的 size 估计）、"AQE 为什么看不到 CBO"；题库指针 `bd-pyspark-0002` 与 `bd-pyspark-0010`（非等值时间窗 join 换不了 BroadcastHashJoin，计划退化最典型）。

- [ ] **Step 6: 宿主档 + Commit**（`feat(notebooks): WI-90 Task 4 —— 篇 3 计划解读与 AQE（合并读侧归 coalescePartitions，"不总是更快"降级到 markdown）`）

---

## Task 5：三篇一起收口 —— 全量验证、数字校准、记忆与工作板

**Files:** Modify `README.md`、`docs/ARCHITECTURE.md`、`HANDOVER.md`、`memo.md`

- [ ] **Step 1: 全量三档**
  ```bash
  ./start.sh --verify > /tmp/wi90-t5-verify.log 2>&1; echo "CV_EXIT=$?"
  npm run verify:fast > /tmp/wi90-t5-fast.log 2>&1; echo "FAST_EXIT=$?"
  npm run e2e > /tmp/wi90-t5-e2e.log 2>&1; echo "E2E_EXIT=$?"
  ```
  核对（逐项贴实测）：`CV_EXIT=0`；新增那条阶段出现**恰好 1 次**、区域内 `skip` 计数 0（**判据用行/字节，先证明区间非空**）；`tutorials.test.ts` 的条数与 `3 passed/0 failed`（三篇 + 清单完整性 + 常驻组）；`kernel.test.ts` 仍 `30 passed`；`embed.test.ts` 条数不减；判题矩阵 `跳过 0`。
  E2E 跑在 e2e 独立实例（宿主 `127.0.0.1:7798`），它**没有 token ⇒ 不起 jupyter**，所以那里能诚实判的只有"文件列表在 Jupyter 没起来时也要如实显示"——这一条若 WI-94 Task 6 已覆盖就写"已覆盖，见 `tests/e2e/notebook-page.spec.ts`"，**不要**为了凑绿伪造一次带 Jupyter 的 e2e 实例。
- [ ] **Step 2: 真浏览器（如果 WI-94 已内嵌，这一步在真页面上看这三篇）**：`#/notebook` 左栏出现三个文件、点开其中一篇能进编辑器、console error 与 warning 都 0、故意停 ~60 秒再看服务还在。**任何一步做不到就如实报告并登记 WI，不许把"页面渲染出来了"当成"能跑"。**
- [ ] **Step 3: 数字校准**：把三篇的真实执行用时写进 `README.md` 的 notebook 一节（"单篇实测 Xs，闸门预算 120s"），并核对每篇的⑤段里出现的每个数字都能在本篇跑一遍后看见（来源标注或当场量），**不留 outputs**。
- [ ] **Step 4: 记忆与工作板**：`memo.md` 里程碑（做了什么/验证表带真实退出码/已知问题/教训 —— 教训至少含"耗时不能当结论层判据"与"`getNumPartitions()` 这类确定量能把教学结论钉死"两条）；`HANDOVER.md` WI-90 → COMPLETED 附验证命令与结果，并把后续批次（v2/v3 的 9 类主题）作为新 WI 或保留在规格的引用上写清。
- [ ] **Step 5: Commit**（`docs+verify: WI-90 三篇教程收口 —— 实测用时 + 三档 + 记忆`）

---

## 完成判据

1. `CV_EXIT=0` / `FAST_EXIT=0` /（如 WI-94 已交付）`E2E_EXIT=0`；容器档新增阶段出现恰好 1 次且区域内 `skip` 为 0；判题矩阵 `跳过 0`。
2. 三篇各自被容器档真执行过，**每条注册结论都有 marker**，且 §Step 4 那三次破坏性验证各自实测红过（数字写在注释/报告里，不写推测）。
3. 每篇都满足规格的 senior 口径：一个不了解这段代码的人能只靠⑤段速查表回答"先查哪三个数、两种根因怎么验证"；至少一条追问推到**机制层**。
4. `content/notebooks/` 里每篇 `.ipynb`（`00-` 开头除外）都在注册表里；注册表里没有不存在的文件。
5. 三篇都不含 outputs；`metadata.kernelspec.name == "arena-pyspark"`；scratch 目录跑完不残留。
6. `package.json`（三处）一个字节都没变。
