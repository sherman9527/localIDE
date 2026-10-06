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
 * ⑤ arena 与 tools 必须透传 token —— 服务端要读同一个值（Task 7 的 status、Task 10 的容器档 kernel 测试）；
 * ⑥ e2e 与 dev 必须**拿不到** token —— entrypoint 是镜像级的，"谁拿到谁起 jupyter"，而这两个服务
 *    挂的都是真人的 `./data`（读写）。
 * ⑤⑥ 是同一条裁决的两半：**"不透传给隔离实例"是 WI-40 的隔离规则本身，不是漏接线**。
 * 只写 ⑤（"每个服务都得有"）会把这条隔离判据反着钉死 —— 那才是 review 抓到的地方：e2e 拿到 token
 * ⇒ 起一个 root_dir 指向真人笔记的 server，而现有的隔离判据只 hash data/arena.db-wal，看不见 notebooks。
 * 今天它没有发布端口所以进不去，但 Task 8 一加服务端代理就变成真路径，所以现在就堵在 token 上。
 * ⑦ Task 10 补的容器标记 `ARENA_IN_CONTAINER`（arena / dev / tools 有、e2e 没有）：
 *    少给 arena 那一半，`server/test/notebooks/kernel.test.ts` 整组会**静默降级成 skip** ——
 *    那个文件自己有一条常驻解释断言会在容器档跑时撞红，但它要等一次 `./start.sh --verify` 才看得见；
 *    compose 档是每天跑的那一侧，所以这里也钉一份。理由与 e2e 不许有它，见 ⑦ 那条断言旁边。
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

/** 同上（判配置行不判注释）：给 ⑦ 用的通用版。 */
function configLine(block: string, key: string): string | undefined {
  return block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .find((l) => new RegExp(`^${key}\\s*:`).test(l));
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
    // arena：服务端与 entrypoint 要用同一个值；tools：Task 10 的容器档 kernel 测试在这个容器里跑。
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
   * ⑦ Task 10 的容器标记。方向两边都要判：
   * - **arena 少给** ⇒ `server/test/notebooks/kernel.test.ts` 那一整组（真跑 smoke notebook、读运行中的
   *   jupyter 进程的 PATH、token 键、/proc/net/route）在容器档里也只是"被跳过"，而容器档的默认 reporter
   *   会把这一行和别的跳过混在一起 —— 那条闸门就变成装饰（本仓库为这类形状记过一次：provenance.test.ts
   *   躺在被认领的目录里但那一条阶段从没设过它的变量）。compose 这一侧每天跑，所以在这里钉住。
   * - **e2e 多给** ⇒ 那个实例按设计没有 token、按设计不起 jupyter（⑥），标上"这是容器、容器档可以在这里跑"
   *   等于让那一组在一个必然撞前置条件的地方承诺自己会跑；而 e2e 是宿主 Playwright 打的隔离实例，
   *   容器档从来不该在那里跑（真跑走 `./start.sh --verify`，exec 进 arena）。
   * dev / tools 照给：标记得准的事实是"这是容器"，不是"jupyter 在跑"，
   * 那两个容器里那一组会红在"前置条件不成立"那两句上 —— 那是实情，不是要瞒的东西。
   */
  it('容器标记 ARENA_IN_CONTAINER 只给 arena / dev / tools，不给 e2e（少给 arena = 容器档静默 skip）', () => {
    const KEY = 'ARENA_IN_CONTAINER';
    const mustHave: Array<[string, string]> = [['arena', arena], ['dev', dev], ['tools', tools]];
    const missing = mustHave
      .filter(([, block]) => !/^ARENA_IN_CONTAINER:\s*"?1"?\s*$/.test(configLine(block, KEY) ?? ''))
      .map(([svc]) => svc);
    expect(missing, `这些服务没有 ARENA_IN_CONTAINER: "1"（或值不是 1）：${missing.join(', ')}`).toEqual([]);
    expect(configLine(e2e, KEY), 'e2e 拿到了容器标记 ⇒ 容器档那一组会以为可以在这个没有 token、没有 jupyter 的隔离实例里跑').toBeUndefined();
  });
});
