import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 四条各守一个真出过事的形状，加一条"别漏服务"：
 * ① 7789 必须绑回环（compose-ports 整仓管全局，这里补"这条映射确实存在 + 端口号没被复用作别的"）；
 * ② token 是 `${VAR:-}` 透传而不是字面量 —— WI-86 的教训：判形状不判值；
 * ③ e2e 服务不许映射 7789：E2E 不该依赖一个真 notebook 服务器，也不该跟真人实例抢同一端口号；
 * ④ 宿主端口不许被两个**可能同时在跑**的服务抢（理由见 MUTUALLY_EXCLUSIVE_GROUPS 那段）；
 * ⑤ 每个服务都透传了 token —— ENTRYPOINT 是镜像级的，漏一个服务就等于那个实例的 notebook 永远起不来，
 *    而症状（"页面第五项说没起来"）离原因（compose 少一行）隔着两个子系统。
 */

/**
 * 服务名 → 它的整段配置文本。只在顶格键是 `services:` 时把缩进 2 的键当服务，
 * 否则文件末尾的顶层 `volumes:` 里那两条（`arena-ide-env:` / `arena-ide-env-e2e:`）
 * 会被当成"两个没有 token 的服务"，把 ⑤ 撞成与判题无关的假红。
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

/**
 * 判据④取"同一个宿主端口不许被两个可能同时在跑的服务抢"，不是"不许出现重复端口号"。
 * 后者天生不成立：arena 与 dev 是同一镜像、同一个服务的两种模式（dev 带 `profiles: ["dev"]`，
 * 与 arena 互斥启动），故意共用 7788 —— 而 web/vite.config.ts 的 /api 代理目标就是
 * `http://127.0.0.1:7788`，把 dev 那份端口改掉等于直接改坏 ./start.sh --dev。
 * 所以这里把"互斥服务组"写成显式白名单：新端口想跟别人共用必须先挤进这个列表，
 * 而挤进来就得回答"这两个服务真的互斥吗"。（计划里那版是全局查重，一跑就红在 7788 上。）
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
    const line = arena.split('\n').find((l) => l.includes('ARENA_JUPYTER_TOKEN'));
    expect(line, 'arena 没透传 ARENA_JUPYTER_TOKEN ⇒ entrypoint 永远缺 token，notebook 起不来').toBeTruthy();
    expect(line).toMatch(/\$\{ARENA_JUPYTER_TOKEN:-\}/);
    expect(line).not.toMatch(/:\s*[A-Za-z0-9_-]{16,}/);
  });

  it('e2e 不发布 7789', () => {
    expect(e2e).not.toContain('7789');
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
      const allAliasable = uniq.every((s) => MUTUALLY_EXCLUSIVE_GROUPS.some((g) => g.includes(s)));
      if (uniq.length > 1 && !allAliasable) conflicts.push(`${port} ← ${uniq.join('、')}`);
    }
    expect(conflicts, `抢同一个宿主端口、又不在互斥服务组里：${conflicts.join('; ')}`).toEqual([]);
  });

  it('每一个服务都透传了 ARENA_JUPYTER_TOKEN（漏一处 = 那个实例的 notebook 永远起不来）', () => {
    const missing = [...blocks.keys()].filter((svc) => !/\bARENA_JUPYTER_TOKEN: \$\{ARENA_JUPYTER_TOKEN:-\}/.test(blocks.get(svc) ?? ''));
    expect(missing, `这些服务没透传 token：${missing.join(', ')}`).toEqual([]);
  });
});
