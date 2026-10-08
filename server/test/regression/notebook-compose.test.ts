import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 七条各守一个真出过事（或真会静默降级）的形状：
 * ① 7789 必须绑回环（compose-ports 整仓管全局，这里补"这条映射确实存在 + 端口号没被复用作别的"）；
 * ② token 是 `${VAR:-}` 透传而不是字面量 —— WI-86 的教训：判形状不判值；
 * ③ e2e 服务不许出现 notebook 端口（7789 与容器内 8888 都算）：E2E 不该依赖一个真 notebook 服务器，
 *    也不该跟真人实例抢同一端口号；
 * ④ 宿主端口不许被两个**可能同时在跑**的服务抢（理由见 MUTUALLY_EXCLUSIVE_GROUPS 那段）；
 * ⑤ arena 与 tools 必须透传 token —— 服务端要读同一个值（Task 7 的 status；tools 那份是
 *    "同一台机器只有一个 token"，不是"kernel 那一组会在 tools 跑"，见 ⑤ 本体旁边那条订正）；
 * ⑥ e2e 与 dev 必须**拿不到** token —— entrypoint 是镜像级的，"谁拿到谁起 jupyter"，而这两个服务
 *    挂的都是真人的 `./data`（读写）。
 * ⑤⑥ 是同一条裁决的两半：**"不透传给隔离实例"是 WI-40 的隔离规则本身，不是漏接线**。
 * 只写 ⑤（"每个服务都得有"）会把这条隔离判据反着钉死 —— 那才是 review 抓到的地方：e2e 拿到 token
 * ⇒ 起一个 root_dir 指向真人笔记的 server，而现有的隔离判据只 hash data/arena.db-wal，看不见 notebooks。
 * 今天它没有发布端口所以进不去，但 Task 8 一加服务端代理就变成真路径，所以现在就堵在 token 上。
 * ⑦ Task 10 补的两个容器标记的**分布**（评审 I-2 之后是两条 key，不是一条）：
 *    `ARENA_IN_CONTAINER`（"这是一个容器"）arena / dev / tools 有、e2e 没有；
 *    `ARENA_NOTEBOOK_SERVICE`（"这就是那个跑着 notebook 服务的实例"）**只有 arena 有**。
 *    少给 arena 任何一条，`server/test/notebooks/kernel.test.ts` 整组会**静默降级成 skip** ——
 *    那个文件自己有一条常驻解释断言会在容器档跑时撞红，但它要等一次 `./start.sh --verify` 才看得见；
 *    compose 档是每天跑的那一侧，所以这里也钉一份。多给 dev / tools / e2e 第二条，
 *    等于让那一组在没有 jupyter、没有 token、IDE 环境不在卷上的实例里承诺自己会跑（理由见 ⑦ 本体）。
 * ⑧（终审 I-3）arena **不许**设 `ARENA_DATA_DIR`：`docker/jupyter/kernels/arena-pyspark/kernel.json:13`
 *    那份 warehouse/Derby 是构建期 COPY 的**绝对字面量**，而 entrypoint 与 config 都从这个变量派生 ——
 *    三处只在"arena 没设它"时才重合。`notebook-contract.test.ts` 比的是**叶子名**，
 *    对"根目录换了"天生瞎，所以这条等式过去只有注释撑着（坏法与实证写在 ⑧ 本体）。
 */

/**
 * 服务名 → 它的整段配置文本。只在顶格键是 `services:` 时把缩进 2 的键当服务，
 * 否则文件末尾的顶层 `volumes:` 里那两条（`arena-ide-env:` / `arena-ide-env-e2e:`）
 * 会被当成"两个服务"，把 ①（服务清单必须恰好是这四个）撞成与判题无关的假红。
 */
function serviceBlocks(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  let topKey = '';
  let name = '';
  let buf: string[] = [];
  const flush = () => {
    if (name) out.set(name, buf.join('\n'));
    buf = [];
  };
  for (const raw of yaml.split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):/.exec(raw);
    if (top) {
      flush();
      topKey = top[1] as string;
      name = '';
      continue;
    }
    const def = /^ {2}([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(raw);
    if (def && topKey === 'services') {
      flush();
      name = def[1] as string;
      continue;
    }
    if (name) buf.push(raw);
  }
  flush();
  return out;
}

const compose = readFileSync(join(config.repoRoot, 'compose.yml'), 'utf8');
const blocks = serviceBlocks(compose);
const arena = blocks.get('arena') ?? '';
const e2e = blocks.get('e2e') ?? '';
const dev = blocks.get('dev') ?? '';
const tools = blocks.get('tools') ?? '';

/**
 * 这个服务**真的**有没有那一行透传（丢掉整行注释再找）。
 * 判据只看配置行、不看注释，否则"在注释里写一句 ARENA_JUPYTER_TOKEN"就能同时骗过 ⑤ 与 ⑥ ——
 * 而 ⑥ 的整个用处就是"这个服务不许起 jupyter"，那是 compose 里的一行 env，不是文档里的措辞。
 */
function tokenPassThrough(block: string): string | undefined {
  return configLine(block, 'ARENA_JUPYTER_TOKEN');
}

/**
 * 同上（判配置行不判注释）：给 ⑦ 用的通用版。
 * ⚠ 还要把**行尾的随行注释**剥掉（`KEY: "1"  # 说明` 在 YAML 里是真配置行）：
 * 只滤掉整行注释的话，`KEY: "1" # ...` 会被下面的值判据当成"这一行不是 1"⇒「这个服务不许有」
 * 那半变成假绿（本仓库的 mutation m5 实测撞到的：给 tools 加上 `ARENA_NOTEBOOK_SERVICE: "1" # ...`
 * 之后 ⑦ 全绿，而容器那一组在那个服务里**真的会跑起来**）。剥注释统一在这一个原语里做，
 * 免得每个调用方各自再记一遍"要剥注释"。形状判据钉在下面那条「configLine 的原语本身」。
 */
function configLine(block: string, key: string): string | undefined {
  return block
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+#.*$/, '')) // 行尾随行注释不是值的一部分（前面必须有空白，避免切进值里的 #）
    .filter((l) => l !== '' && !l.startsWith('#'))
    .find((l) => new RegExp(`^${key}\\s*:`).test(l));
}

/**
 * 这个服务**真的**把 `<key>: "1"` 写上了吗（值不是 1 也算没有）。
 * key 从同一个参数进来，定位与判值用的是**同一个** key（评审 I-7 minor）：
 * 判据若写成 `configLine(block, KEY)` 定位、却拿一条写死的 `/^ARENA_IN_CONTAINER:/` 判值，
 * 那么这个 helper 换 key 时两边会各说一套 —— 加第二条标记时正好是这种形状。
 */
function markerIsOne(key: string, block: string): boolean {
  return new RegExp(`^${key}:\\s*"?1"?\\s*$`).test(configLine(block, key) ?? '');
}

/**
 * 判据④取"同一个宿主端口不许被两个可能同时在跑的服务抢"，不是"不许出现重复端口号"。
 * 后者天生不成立：arena 与 dev 是同一镜像、同一个服务的两种模式（dev 带 `profiles: ["dev"]`，
 * 与 arena 互斥启动），故意共用 7788 —— 而 web/vite.config.ts 的 /api 代理目标就是
 * `http://127.0.0.1:7788`，把 dev 那份端口改掉等于直接改坏 ./start.sh --dev。
 * 所以这里把"互斥服务组"写成显式白名单：新端口想跟别人共用必须先挤进这个列表，
 * 而挤进来就得回答"这两个服务真的互斥吗"。（计划里那版是全局查重，一跑就红在 7788 上。）
 * 白名单是**按组**判的，不是按服务判的：抢同一个端口的那些服务必须整个落在同一个组里
 * （判据本体下面写了为什么按服务判等于没判）。
 */
const MUTUALLY_EXCLUSIVE_GROUPS: string[][] = [['arena', 'dev']];

describe('notebook 的端口与 token 接线', () => {
  it('compose 被真的解析出了服务（任何一条判据都建立在"读到了东西"之上）', () => {
    expect([...blocks.keys()].sort(), `扫到的服务：${[...blocks.keys()].join(', ')}`).toEqual([
      'arena',
      'dev',
      'e2e',
      'tools',
    ]);
  });

  it('arena 发布了 127.0.0.1:7789:8888', () => {
    expect(arena).toMatch(/- "127\.0\.0\.1:7789:8888"/);
    expect(arena, 'notebook 端口没写"为什么绑回环 / 手机打不开"的注释').toContain('手机');
  });

  it('token 是透传形状，不是字面量', () => {
    const line = tokenPassThrough(arena);
    expect(line, 'arena 没透传 ARENA_JUPYTER_TOKEN ⇒ entrypoint 永远缺 token，notebook 起不来').toBeTruthy();
    expect(line).toMatch(/\$\{ARENA_JUPYTER_TOKEN:-\}/);
    expect(line).not.toMatch(/:\s*[A-Za-z0-9_-]{16,}/);
  });

  it('e2e 不发布 notebook 端口（宿主 7789 与容器内 8888 都不许出现在它的块里）', () => {
    expect(e2e).not.toContain('7789');
    // 光禁 7789 会漏掉"把 8888 直接发出去"这个更糟的形状（同一个 server、换个宿主端口号而已）。
    // 判据是纯文本包含、连注释一起算，钝是故意的：端口号出现在 e2e 块里就该被看一眼。
    expect(e2e).not.toContain(':8888');
  });

  it('宿主端口号没有被两个会同时跑的服务抢（互斥服务组内共用除外）', () => {
    const owners = new Map<string, string[]>();
    for (const [svc, text] of blocks) {
      for (const m of text.matchAll(/^\s*- "127\.0\.0\.1:(\d+):\d+"/gm)) {
        const port = m[1] as string;
        owners.set(port, [...(owners.get(port) ?? []), svc]);
      }
    }
    // 空转防护：现在共有 7788 / 7789 / 5173 / 7798 四个不同端口号，扫到 0 个就是解析坏了
    expect(owners.size, '一个宿主端口都没解析到 ⇒ 本条在空转（先修 serviceBlocks）').toBeGreaterThanOrEqual(4);

    const conflicts: string[] = [];
    for (const [port, svcs] of owners) {
      const uniq = [...new Set(svcs)];
      if (svcs.length !== uniq.length) {
        conflicts.push(`${port} 在 ${uniq.join('、')} 里映射了两次`);
        continue;
      }
      // 关键：必须是"**同一个**组里装着所有这些服务"。写成 uniq.every(s => GROUPS.some(g => g.includes(s)))
      // 的话，arena（组 1）与 tools（组 2）各被自己的组认领、于是 every 通过 ⇒ 两个会同时跑的
      // 服务抢同一个宿主端口而这条判据是绿的。共用端口的前提是它们本来就不可能并存，
      // 这个前提只在"整组都在同一个互斥集合里"时才成立。
      const allAliasable = MUTUALLY_EXCLUSIVE_GROUPS.some((g) => uniq.every((s) => g.includes(s)));
      if (uniq.length > 1 && !allAliasable) conflicts.push(`${port} ← ${uniq.join('、')}`);
    }
    expect(conflicts, `抢同一个宿主端口、又不在互斥服务组里：${conflicts.join('; ')}`).toEqual([]);
  });

  it('arena 与 tools 都透传了 ARENA_JUPYTER_TOKEN（漏一处 = 那个实例读不到同一个 token）', () => {
    // arena：服务端与 entrypoint 要用同一个值；tools：同一个人、同一台机器上只该有一份 token，
    // 在这里跑的服务端代码读的也是同一个值。
    // ⚠ 这一行原来写的理由是"Task 10 的容器档 kernel 测试要在 tools 里读它"—— 那个前提在评审 I-2
    //   之后不成立了（那一组读的是合取门控，tools 里没有 ARENA_NOTEBOOK_SERVICE ⇒ 干净跳过），
    //   判据本身不变（⑤ 仍是"arena 与 tools 必须有"），但别再拿 kernel 测试给它当理由。
    const mustHave: Array<[string, string]> = [['arena', arena], ['tools', tools]];
    const missing = mustHave
      .filter(([, block]) => !/\$\{ARENA_JUPYTER_TOKEN:-\}/.test(tokenPassThrough(block) ?? ''))
      .map(([svc]) => svc);
    expect(missing, `这些服务没透传 token：${missing.join(', ')}`).toEqual([]);
  });

  it('e2e 与 dev 拿不到 token ⇒ entrypoint 的守卫让它们不起 jupyter（这是隔离规则，不是漏接线）', () => {
    // 这一条看起来像"接线接反了"，所以把裁决写在断言旁边：透传给谁 = 让谁起一个 jupyter，
    // 而 e2e/dev 挂的都是真人的 ./data（读写）。少给不是 bug，是多给才是 bug。
    // 另一半见上面那条 ⑤：arena/tools 少给才是真的漏接线。
    const mustNotHave: Array<[string, string]> = [['e2e', e2e], ['dev', dev]];
    for (const [svc, block] of mustNotHave) {
      expect(tokenPassThrough(block), `${svc} 拿到了 ARENA_JUPYTER_TOKEN ⇒ 那个实例会起一个 jupyter，root_dir 指向真人挂载进来的 data/（WI-40 要堵的正是这类"隔离实例能写进真人数据"）`).toBeUndefined();
    }
    // 空转防护：dev/e2e 两个块都得真的扫到过，否则上面两条断言在 blocks 解析坏掉时会一起绿
    expect(dev, 'dev 块没扫到 ⇒ 上面那条断言在空转（先修 serviceBlocks）').toContain('ARENA_PORT');
    expect(e2e, 'e2e 块没扫到 ⇒ 上面那条断言在空转（先修 serviceBlocks）').toContain('ARENA_DATA_DIR');
  });

  /**
   * ⑦ 两个标记的分布。方向两边都要判，而且现在判的是**两条 key**：
   * - **arena 少给任何一条** ⇒ `server/test/notebooks/kernel.test.ts` 那一整组（真跑 smoke notebook、读运行中的
   *   jupyter 进程的 PATH、token 键、/proc/net/route）在容器档里也只是"被跳过"，而容器档的默认 reporter
   *   会把这一行和别的跳过混在一起 —— 那条闸门就变成装饰（本仓库为这类形状记过一次：provenance.test.ts
   *   躺在被认领的目录里但那一条阶段从没设过它的变量）。compose 这一侧每天跑，所以在这里钉住。
   * - **dev / tools / e2e 多给 `ARENA_NOTEBOOK_SERVICE`** ⇒ 那一组会在"按设计不是 notebook 服务"的实例里
   *   承诺自己会跑。两台各有各的坏法（compose 的 arena 块那段把这两种都写了）：
   *   tools 连 `ARENA_IDE_ENV_DIR` 都没有（那三处 = arena / dev / e2e，`notebook-image.test.ts` 钉着）
   *   ⇒ `config.ideEnvDir` 退回 `dataDir/ide-env` = Windows 的 bind mount（compose.yml 自己记的 87.2s vs 1.76s）
   *   ⇒ 先在真人的 `./data` 上试建 venv、再红一句"venv 创建失败"，而真正的毛病是"跑错了服务"
   *   （评审 I-2 说的 misattributed red，预算也是从这里被吃掉的）；
   *   dev 有卷、也是 arena 那个镜像（kernel 文件在），但它按 ⑥ 拿不到 token ⇒ 没有跑着的 jupyter
   *   ⇒ PATH / token 键 / 路由表那三条红在"错服务"上。
   * ⚠ 分辨"是不是那个服务"**不能**用「`/proc` 里有没有带 `--ServerApp.root_dir=` 的进程」：
   *   那正是容器那一组要**找**的东西，拿它当门控会让断言自我循环（控制器追加的裁决）。
   * `ARENA_IN_CONTAINER` 对 dev / tools 照给：它得说的是"这是容器"，不是"jupyter 在跑"，
   * 那一组在那两个容器里按合取条件干净跳过（`kernel.test.ts` 顶部那段写了为什么不再红）。
   */
  it('容器标记 ARENA_IN_CONTAINER 给 arena / dev / tools，notebook 服务标记 ARENA_NOTEBOOK_SERVICE 只给 arena（少给 arena = 容器档静默 skip）', () => {
    const DISTRIBUTION: Array<{ key: string; yes: string[]; no: string[] }> = [
      { key: 'ARENA_IN_CONTAINER', yes: ['arena', 'dev', 'tools'], no: ['e2e'] },
      { key: 'ARENA_NOTEBOOK_SERVICE', yes: ['arena'], no: ['dev', 'tools', 'e2e'] },
    ];
    for (const { key, yes, no } of DISTRIBUTION) {
      // 空转防护：表里的服务名写错 = 那条断言在空气上判（blocks 里查不到就会被 `?? ''` 洗成"没有这一行"）。
      const unknown = [...new Set([...yes, ...no])].filter((svc) => !blocks.has(svc));
      expect(unknown, `判据表里的服务名在 compose 里不存在（写错名字等于没判）：${unknown.join(', ')}`).toEqual([]);

      const missing = yes.filter((svc) => !markerIsOne(key, blocks.get(svc) ?? ''));
      expect(missing, `这些服务没有 ${key}: "1"（或值不是 1）：${missing.join(', ')} ⇒ 容器档那一组会在该跑的地方只是被跳过`).toEqual([]);

      for (const svc of no) {
        expect(
          markerIsOne(key, blocks.get(svc) ?? ''),
          `${svc} 拿到了 ${key}: "1" ⇒ 它按设计不是那个跑 notebook 服务的实例（没有 token / entrypoint 被覆盖 / 隔离实例），` +
            '容器档那一组却会在这里 promise 自己会跑，并先在 bind mount 上试建 venv',
        ).toBe(false);
      }
    }
  });

  /**
   * ⑧（终审 I-3）：**arena 这一侧不许设 `ARENA_DATA_DIR`**。
   *
   * 这不是一条风格要求，是一条**承重等式**：`docker/jupyter/kernels/arena-pyspark/kernel.json:13`
   * 里的 `PYSPARK_SUBMIT_ARGS` 把 warehouse 与 Derby 写成**绝对字面量**
   * `/app/data/notebook-warehouse/{wh,derby}` —— kernelspec 是构建期 COPY 进镜像的静态文件，
   * 运行时没人能改它（那一段自己写了这一点）。而另外两处是从 env 派生的：
   * `docker/entrypoint.sh:81-82`（`${ARENA_DATA_DIR:-/app/data}`）与
   * `server/src/config.ts:93` 那条链（`dataDir = process.env.ARENA_DATA_DIR ?? join(repoRoot,'data')`
   * ⇒ `config.notebook.warehouseDir`）。**今天**三处重合，只因为 compose 没给 arena 设那个变量。
   *
   * 哪天有人给它设上（比如想换个盘、或把 notebook 数据挪出 bind mount），坏法是：
   * entrypoint 在 `<新目录>` 下建好目录、`/api/notebook/status` 列的也是那边的示例，
   * 而 spark 把表写进 `/app/data/notebook-warehouse` —— 界面"铺了示例但没有表"，
   * 且不报错（Spark 会自己建它指着的目录，所以连"目录不存在"都不会成为线索）。
   *
   * 为什么必须在这里钉、而不是靠 kernel.json 那段注释：`notebook-contract.test.ts` 比较的是
   * **叶子名**（`notebooks` / `notebook-warehouse` 这两个名字在三处一致），它对"根目录换了"天生瞎；
   * 而这段等式的另一头（compose）没有任何一条闸门看过。改 compose 的人看不见 kernel.json 的注释。
   * 反向也判一眼（别把这条做成"读不到就行"的空判）： arena 块必须真的被解析出来了（上面那条
   * 「compose 被真的解析出了服务」已经判过 blocks 非空，这里再判 arena 这一条存在）。
   */
  it('arena 不设 ARENA_DATA_DIR（kernel.json:13 那份绝对字面量与它派生的两处只在今天重合）', () => {
    expect(blocks.has('arena'), 'arena 这个服务没被解析出来 ⇒ 这一条会在空气上判').toBe(true);
    expect(
      configLine(arena, 'ARENA_DATA_DIR'),
      'compose 给 arena 设了 ARENA_DATA_DIR ⇒ 三处立刻分叉：kernel.json:13 的 PYSPARK_SUBMIT_ARGS 还是'
        + ' /app/data/notebook-warehouse（构建期 COPY 的静态文件，运行时改不了），而 entrypoint.sh:81-82 与'
        + ' config.notebook.warehouseDir 都跟着这个变量走 ⇒ 症状是"示例铺了、表却不在那边"，而且不报错。'
        + ' 真要换数据目录，得先把 kernel.json 那一行变成运行时生成的 kernelspec（不是改 compose）',
    ).toBeUndefined();
    // 同一条等式的另一半：**容器里**仓库根确实是 /app，所以 kernel.json:13 那份绝对字面量今天确实
    // 等于 config.notebook.warehouseDir。这一档只能在容器里判（宿主档 repoRoot 是检出路径，
    // 那个字面量在宿主上压根不存在）—— 本文件在**两侧都跑**（verify.sh 的「单元测试」阶段扫
    // server/test/regression），所以判据按档位分岔，而不是照抄容器假设写死一条：
    // 写死 `/app` 会在宿主撞红，写死「不是 /app」会在容器撞红（上一版就是这个方向反了）。
    if (process.env.ARENA_IN_CONTAINER === '1') {
      expect(
        config.notebook.warehouseDir,
        '容器里仓库根不再是 /app ⇒ kernel.json:13 那份构建期 COPY 的绝对字面量连今天都不对，'
          + ' 只能把 kernelspec 改成运行时生成（见上一条的说明）',
      ).toBe('/app/data/notebook-warehouse');
    } else {
      expect(
        config.repoRoot,
        '宿主档的仓库根竟然就是 /app ⇒ 这一档已经是容器了，上面那条容器判据不该被跳过（检查 ARENA_IN_CONTAINER）',
      ).not.toBe('/app');
    }
  });

  /**
   * ⑦ 用的那**两个原语**自己也要判住（mutation m5 撞出来的：`ARENA_NOTEBOOK_SERVICE: "1" # 说明`
   * 这种带随行注释的写法在 YAML 里是真配置行，而 `configLine` 当时只滤整行注释 ⇒ 值判据看到的还是
   * 带注释的原文 ⇒ `markerIsOne` 判 false ⇒「dev / tools / e2e 不许有这一行」那半**假绿**，
   * 而容器那一组在那个服务里真的会跑（正是 I-2 要拦的形状）。
   * 这类"判据的判据"写在这里而不是只在注释里说"记得剥注释"：下一位加第三条 key 的人
   * 不会重读这段历史，但他一定会复用这两个函数。
   */
  it('configLine / markerIsOne 的原语形状（随行注释不算值、整行注释不算配置、定位与判值用同一个 key）', () => {
    expect(configLine('  KEY: "1" # 随行注释', 'KEY'), '随行注释没剥掉 ⇒ 「这个服务不许有」那半会假绿').toBe('KEY: "1"');
    expect(configLine('  KEY: "a#b"', 'KEY'), '值里的 # 前面没有空白 ⇒ 不许被当成注释切掉').toBe('KEY: "a#b"');
    expect(configLine('# KEY: "1"', 'KEY'), '整行注释被当成了配置行 ⇒ 在注释里写一句就能骗过 ⑤⑥').toBeUndefined();
    expect(configLine('  OTHER: "1"', 'KEY')).toBeUndefined();
    expect(configLine('  KEYX: "1"', 'KEY'), '前缀匹配：KEYX 不是 KEY').toBeUndefined();

    expect(markerIsOne('KEY', '  KEY: "1" # 给 tools 也加一份'), 'm5 的形状必须判成"这一行真的设了"').toBe(true);
    expect(markerIsOne('KEY', '  KEY: 1')).toBe(true);
    expect(markerIsOne('KEY', '  KEY: "0"'), '值不是 1 ⇒ 不算设过').toBe(false);
    expect(markerIsOne('KEY', '  KEY: yes'), 'YAML 的 yes 不是这一档用的写法（compose 里两条标记都写成 "1"）').toBe(false);
    // minor 7 的正题：定位与判值用的是**同一个** key —— 传错 key 时不许"碰巧"判中另一条
    expect(markerIsOne('ARENA_IN_CONTAINER', 'ARENA_NOTEBOOK_SERVICE: "1"')).toBe(false);
    expect(markerIsOne('ARENA_NOTEBOOK_SERVICE', 'ARENA_IN_CONTAINER: "1"')).toBe(false);
  });

});
