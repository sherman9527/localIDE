# 加题 / 移题 / 刷新题库（ADD_QUESTIONS）

## 加一道题

1. 先看知识库缺什么：`content/knowledge/<类别>/README.md`（考点矩阵）与 `content/knowledge/INDEX.md`
   （考点 × 已出题数）。`npm run kb:index` 重新汇总。
2. 把草稿写成一个 JSON 文件放在**仓库外**或 `data/` 下（不要直接放进 `content/questions/`）。
   id 规则：**别手写，留给 `ingest()` 自动分配**。它按 `server/src/bank/ingest.ts` 里
   `CATEGORY_PREFIX`（fe/alg/sql/sys/bd/ag/hot）+ `KIND_SHORT`（java/react/mysql/redis/pyspark/scala/rubric）
   拼前缀、取该前缀下的下一个四位序号，例如 `alg-java-0001`、`sql-redis-0014`、`sys-rubric-0023`。
   要手写就必须撞这个规则 —— 库里现存 13 个前缀族，其中 `sys-design-rubric-*`、`ag-design-rubric-*`、
   `hot-interviews-rubric-*` 是早期手写留下的**长写法**（自动分配器不会再生成它们），
   新题别再制造第 14 个族。

   **批量出题请走已入库的草稿生成器**，别手写裸 JSON：`scripts/bank/drafts/<公司>/gen.py`
   用 Python 字面量写题、`json.dump` 负责转义（题面里的中文引号手写 JSON 会炸），
   生成到 `data/drafts-ds/out/`（生成物不入库，`content/questions` 是唯一真相）。
   配套的本地闸门同目录：
   - `precheck.py`：用 Python 把 Java 参考解**逐行等价重写**一遍并跑所有用例，
     在提交容器之前先筛掉"expected 手算错 / 用例自相矛盾"（未登记的草稿标 SKIP，不假装通过）；
   - `probe_naive.py`：把题面/答案里"朴素解会给 N"这类断言逐用例算出来 ——
     容器矩阵只证明朴素解**整体**不过，不证明我们写在答案里的那个具体数字。
     **判据方向：数字要从答案里用正则抠出来再和数据比**。在探针里重写一遍 `1 / 1 / 2`
     只能证明"数据给 1/1/2"，答案被改成 `1/2/2` 它照样绿 —— 这条是破坏性验证打回来的。
     顺带查两件事：答案点名的「用例『X』」必须真存在（已经抓到一个引用了不存在的用例），
     以及每条用例的 expected 与独立重写一致。
   三道闸门的分工：**precheck 保证题能做对，probe 保证说明没瞎写，容器矩阵保证判题器真判。**
   另有两条全库的文案闸门（都在 `server/test/bank/`，`verify:fast` 会跑）：
   - `content.test.ts > 答案里点名的『用例「X」』必须真存在` —— 用例改名后文案不会自己跟上，
     编译器、schema、判题矩阵都不管这件事（第一次扫就抓到 6 处陈旧引用）；
   - `answer-arithmetic.test.ts` 把答案/题面/用例备注里 **写出来的等式** 逐条重算
     （`100.00 + 120.50 + 99.99 + 250.00 = 570.49` 这类手算步骤）。
     它刻意"宁可少查、不许冤枉"：整条链一起算、混合优先级跳过、
     除法只认写成小数的结果（`11/12=2` 是散文记号不是除法）、比率允许小数或百分数两种写法。
     判题器永远不看文案，所以手算写错只有这条会红。
   probe 现在**接进了题库闸门**（`server/test/bank/content.test.ts` 会跑所有
   `scripts/bank/drafts/*/probe_naive.py` 并要求退出 0），所以"改了答案没人复算"当天就红，
   不靠出题的人记得手动跑。
   另有条款级约束（都出过事，别绕过）：
   - **`case()` 助手里的 `throws` 是声明，不是推断。** 助手的写法必须是
     "模型抛错但没声明 throws ⇒ 当场 `AssertionError`"、"声明了 throws 但模型返回 ⇒ 同样炸"。
     反例是本仓库真实发生过的：`非法：RELEASE 带了 arg` 这条实际发的 `LOCK` 并且正常返回，
     名字说 A、内容做 B，而矩阵全绿（矩阵只比"参考解 vs 朴素解结果是否不同"，看不见用例命名）。
   - **契约型用例要断言到消息**（`throwMessage`）。只判"抛了没抛"时，
     两条语义不同的用例会收敛成同一条 —— 本仓库的一次 `input` 多包一层数组，
     让"整个入参为 null"与"某个元素为 null"测了同一条代码路径。
     注意 `react-vitest` 题的判分事实来源是**生成的测试文件**，所以消息断言要写进测试文件里。
   - **期望值与 SQL 必须同源生成。** 一条用例只描述一次"与基线的差异"，
     由同一个 helper 同时产出 `runner.setup` 的变异语句和 `expected`；
     分两处写必然漂移（price-grid 那题就是这么算错带 DELETE 的用例的）。
   - **测试文件本身也要从模型生成**，不要手抄期望值 —— 这是同一类漂移的第二个入口。
3. 字段与判题约定见 `docs/JUDGING.md`；schema 强制规则：
   - `difficulty` 只能是 `senior` / `principal`；
   - `category` 与 `judgeKind` 必须匹配（算法题只能 `java-junit`；大数据允许 `pyspark`/`spark-scala`/`llm-rubric`…）；
   - 代码题必须 ≥1 个用例 + `runner.referenceSolution`（闸门要求 ≥3 个用例且含 1 个边界）；
   - 主观题必须有 `rubric`，`points[].weight` 合计 = 10、至少 3 个考点，且不得带 `cases`；
   - `hot-interviews` 必须填 `source.company`；
   - `source.origin = "jd"` 时必须至少一条 `source.jds[]`（url + title + crawledAt）。
4. **SQL 题在 `bank:add` 之前先把参考解对真 MySQL 跑一遍**：
   ```bash
   docker compose exec -T arena bash -lc \
     "cd /app && python3 scripts/bank/drafts/probe_sql_draft.py data/drafts-airbnb/out/<key>.json"
   ```
   入库是 append-only 的（C5），参考解写错只能靠"隐藏"收尾；而 SQL 的错误几乎都在
   setup 与语义上（这次真撞上：`strftime` 里写了 MySQL 的 `%i:%s`，`as_of` 变成
   `'12:%i:1789444800'`，七条用例全在 setup 炸 —— 这一步 30 秒就能查出来，不用等一轮矩阵）。
   它还报告朴素解在哪几条用例上不挂：全都不挂说明这题没有判别力。
5. 入库走 `bank:add`（**别把文件直接丢进 `content/questions/`** —— 那样这两步就全靠人记得跑）：
   ```bash
   npm run bank:add -- 我的题.json --dry-run   # 与真实入库同一段代码，只是写进临时副本
   npm run bank:add -- 我的题.json             # 真入库：ingest 之后自动接跑 bank:check
   ```
   坏题会被拒并给出 zod 的具体路径；同 id / 同题面（排版不同也算）自动跳过，**已有题目永不覆盖**。
   **要改一道已入库的题**（本仓库是 append-only 的题库，红线 C5）：`bank:add` 撞到同 id 只会
   "跳过"，所以**不存在"再 add 一次就同步了"**，也不许手改 JSON —— 手改必漏（本批就漏过一次：
   改了库里的 `expected`，没改与之矛盾的用例名）。正规出口是**该题所在公司的生成器**：
   ```bash
   python scripts/bank/drafts/<公司>/gen.py --check        # 草稿与库逐字段比对（先看清差在哪）
   python scripts/bank/drafts/<公司>/gen.py --sync <key>   # 只覆盖这一道，保留 ingest 补的字段
   ```
   `--sync` 只认"题面已存在"的题（绝不新建、绝不换 id），写完立刻用 `--check` 的同一段判据复验。
   没有生成器的早期题目（`source.company` 为空的那 70 道）只能原地精修：
   先按 `source.company` + 建表语句/`runner` 核对"这道题确实是我要改的那道"，再只改需要改的那一个字段
   —— 按文件名猜出处然后整块覆盖 `cases`，会毁掉一道好题（本仓库真发生过一次，
   被矩阵以"表不存在"拦下）。
   单独校验：`npx vitest run server/test/bank/content`。
6. **代码题必须在容器里判一遍参考解**（宿主机没有 JDK/MySQL/Spark，矩阵会整片 skip）：
   ```bash
   ./start.sh --verify
   ```
   矩阵要报 `0 skipped`，否则等于没验。只想跑某一类：
   ```bash
   docker compose exec -T -e ARENA_REQUIRE_STACKS=1 arena bash -lc \
     'ARENA_CATEGORY=algorithms npx vitest run server/test/regression/reference-solutions'
   ```
   `ARENA_REQUIRE_STACKS=1` 把"有题因栈不可用被跳过"直接判红 ——
   那句 `[matrix] ... 跳过（栈不可用）N 道` 以前只能靠人盯着看，而人会看成"跑了，只是慢"。
   `./start.sh --verify` 与 `./start.ps1 -Verify` 已经带上这个开关。
   **别用 `docker compose run --rm tools` 跑矩阵**：`tools` 覆盖了 entrypoint，
   镜像里自管的 `mysqld` / `redis-server` 没起来 ⇒ 栈探测报 `mysql:false, redis:false`，
   于是全部 mysql/redis 题被**静默跳过**，vitest 仍然全绿。
   （`scripts/assert-ran.mjs` 只断言"至少跑到过一条"，抓不住这种"跳掉一半"——
   所以那条静默降级曾经一路绿灯过。现在带 `ARENA_REQUIRE_STACKS=1` 就会判红。）
7. 建议同时写 `runner.naiveSolution`（能编译/能跑但必然错的解）。矩阵会断言它**不通过** ——
   这是防止"判题器悄悄永远返回 pass"的唯一手段。

## 生成器侧的四份自检（`scripts/bank/drafts/<公司>/`）

判题矩阵证明"题能做对、朴素解会挂"，它**不看文案**。而库里最常见的真缺陷恰恰在文案与数据之间：
用例名说"删不掉别人的，返回 0"，答案却引用了一个不存在的用例名；答案说"基线八行"，`expected` 只有五行。
所以每家出题目录配四份东西，各司其职：

| 文件 | 判什么 | 什么时候跑 |
| --- | --- | --- |
| `gen.py --check` | 生成器算出的草稿与**已入库那份**逐字段一致（防"改了题库、模型还是老的"） | 改过题或改过生成器之后 |
| `gen.py --sync <key>` | 纠正一道已入库的题的**正规出口**（`bank:add` 撞同 id 只会跳过，手改 JSON 必漏） | 需要改已入库题时 |
| `probe_naive.py` | 文案里点名的数字，从**同一份题文件的种子与 expected** 里量出来再比（数字用正则从文案抠，不在探针里重写常量） | 每次入库后；已接进题库闸门 |
| `precheck.py` | 用另一份**不同算法**的实现跑同一批用例（证明"题能做对"不依赖模型自证） | 与 `gen.py` 同一轮 |

全库层面还有一条 `python scripts/bank/drafts/check_provenance.py`（已接进 `ARENA_FULL_GATE`，
且由 `verify-coverage` 保证"那条阶段真的开了这个变量"）：
六家生成器都要能逐字段复现已入库的题 —— **代码题没有草稿就是出处丢了**（判红）。

早期手写入库的主观题（Airbnb 18 + Apple 11）确实没有手稿，但"没有手稿"不等于"可以静默改"：
它们按 `scripts/bank/drafts/no_draft_baseline.json` 的**内容指纹**核查，改了内容而基线没跟上就判红。
新入库一道这样的题会先报"没登记指纹"（不算失败），登记动作是显式的一条：

```bash
python scripts/bank/drafts/check_provenance.py --bless    # 写基线；diff 里能看清改了哪道题
```

**别把 `--bless` 当成"红了我就不红了"的开关**：它只该用于"这道题本来就该长这样"——
所以它会留下一条 JSON diff，评审时看得见。

## 移一道题

页面上点**移除这题**（题目详情页与题库列表都有）。效果：
- id 写进 `content/hidden.json`，今日挑战 / 题库列表 / 排课都不再出现；
- 题目 JSON 文件**不删**（需求：题库只增不减），题库页打开"显示已移除"可恢复；
- 手工恢复：从 `content/hidden.json` 的 `items` 里删掉那条 id，或直接 `DELETE /api/questions/<id>/hide`。

## 批量刷新

```bash
npm run bank:refresh -- --offline              # 用 content/jd-cache 里的样本跑通全流程
npm run bank:refresh -- --company Airbnb       # 真抓 JD（Greenhouse 公开接口已验证可用）
npm run bank:generate -- --category big-data --n 5 --dry-run   # 先看要出什么
npm run bank:generate -- --category big-data --n 5             # 用本机 qodercli 出题并入库
```

- 刷新永远**只增不减**：同 id 或题面归一化后同 hash 的候选会被跳过，已有文件不会被覆盖。
- 覆盖度闸门（题量配比、当年新技术占比 ≥40%、经典重复算法题 ≤15%）：`npm run bank:check -- --full`。
- 30 天排课：`node scripts/curriculum.mjs` → `content/curriculum/2026-10.json`；
  想改某天的主/副栈，直接改那个 JSON（`daily.ts` 优先读排课，读不到才用日期确定性算法选题）。

## 什么不该进题库

- 八股与纯记忆题（"什么是虚拟 DOM"）—— 系统对标 senior/principal，且需求明确拒绝。
- 没有可判定答案的主观题：rubric 的 `criteria` 必须能让人一致地判"命中/未命中"。
- 依赖容器里没有的能力：Redis 是 7.2.7（不是 8.x）、MySQL 是 8.0.x、Python 有 pandas+pyspark、
  Node 有 vitest+jsdom+react；超出的命令/库会在判题时以 `error` 暴露，别当答案写。
