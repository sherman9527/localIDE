import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { IDE_ENV_ROOT, envFamilyOf, venvPythonPath } from '../../src/ide/env.js';
import { parseEnvCommand, runEnvCommand, envCommandBusy } from '../../src/ide/env-command.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * 命令窗口：让用户自己在 IDE 里装依赖。
 *
 * 它叫"命令窗口"，但**不是 shell**。全仓库的进程纪律是 `shell:false` + argv 数组，
 * 审计结论还写着"没有任何用户输入进得去"（HANDOVER WI-86）。如果这里图省事写成
 * `sh -c <输入>`，那句话当场作废。所以下面第一批测试验的就是这条边界：
 * 程序名与子命令走枚举，其余参数原样进 argv —— 用户照样能写 `pip3 install requests==2.31`，
 * 但拿不到 `;`、`|`、`$()`。
 */

const python = findLanguage('python')!;
const node = findLanguage('javascript')!;
const java = findLanguage('java')!;
const c = findLanguage('c')!;

describe('parseEnvCommand：白名单，不是 shell', () => {
  it('放过得手的写法（白名单如果连正常输入都挡，它就是负担而不是保护）', () => {
    for (const argv of [
      ['pip3', 'install', 'requests'],
      ['pip3', 'install', 'requests==2.31'],
      ['pip3', 'install', '-r', 'requirements.txt'],
      ['pip', 'uninstall', '-y', 'requests'],
      ['pip3', 'list'],
      ['python3', '-m', 'pip', 'install', 'rich'],
    ]) {
      const r = parseEnvCommand(python, argv);
      expect(r.ok, `应当放过 ${argv.join(' ')}｜${!r.ok ? r.reason : ''}`).toBe(true);
    }
  });

  it('挡住拿不到 shell 才能做的事', () => {
    const rejected: Array<[string[], string]> = [
      [['sh', '-c', 'rm -rf /'], '程序不在白名单'],
      [['bash', '-lc', 'curl evil'], '程序不在白名单'],
      [['pip3', 'download', 'x'], '子命令不在白名单'],
      [['pip3', 'config', 'set', 'global.index-url', 'http://evil'], '改 pip 配置等于换安装源'],
      [['pip3', 'install'], 'install 至少要给一个包名'],
    ];
    for (const [argv, why] of rejected) {
      const r = parseEnvCommand(python, argv);
      expect(r.ok, `${argv.join(' ')} 应当被拒（${why}）`).toBe(false);
    }
  });

  it('npm 不许写到全局或别的目录（--prefix 由服务端注入，用户写就是越权）', () => {
    for (const argv of [
      ['npm', 'i', '-g', 'left-pad'],
      ['npm', 'install', '--prefix', '/etc', 'x'],
      ['npm', 'install', '-C', '/app', 'x'],
      ['npm', 'install', '--global', 'x'],
    ]) {
      const r = parseEnvCommand(node, argv);
      expect(r.ok, `${argv.join(' ')} 应当被拒`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/全局|prefix|目录/);
    }
  });

  it('分号不是命令分隔符，只是一个包名参数（argv 安全性的正面证明）', () => {
    const r = parseEnvCommand(python, ['pip3', 'install', 'a;rm -rf /']);
    expect(r.ok, '没有 shell，带分号的参数只是个字面量').toBe(true);
    if (r.ok) expect(r.args).toContain('a;rm -rf /');
  });

  it('本期没有环境的语言直接拒绝，并说明原因', () => {
    for (const lang of [java, c]) {
      const r = parseEnvCommand(lang, ['pip3', 'list']);
      expect(r.ok, `${lang.id} 不该有命令窗口`).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(4);
    }
    expect(envFamilyOf(java)).toBe('java'); // java 有环境目录，但没有命令窗口（传递依赖另说）
  });

  it('pip 被改写成 venv 自己的解释器（跑系统 pip3 会把包装进系统目录 = 撞红线一）', () => {
    const r = parseEnvCommand(python, ['pip3', 'install', 'requests']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command).toBe(venvPythonPath(IDE_ENV_ROOT));
      expect(r.args.slice(0, 2)).toEqual(['-m', 'pip']);
      expect(r.args).toContain('requests');
    }
  });
});

describe('runEnvCommand：一把 per-family 锁 + 独立超时', () => {
  it('同一语言并发安装时，第二个立刻拿到"正在装"（两个 pip 同写一个目录会装坏）', async () => {
    const gate = runEnvCommand(python, ['pip3', 'list'], () => {});
    try {
      expect(envCommandBusy(envFamilyOf(python)!), '锁没生效：第二个请求会并发跑 pip').toBe(true);
      const second = await runEnvCommand(python, ['pip3', 'list'], () => {});
      expect(second.status).toBe('busy');
    } finally {
      await gate;
    }
    expect(envCommandBusy(envFamilyOf(python)!)).toBe(false);
  });

  it('非法 argv 根本不会起进程', async () => {
    const res = await runEnvCommand(python, ['sh', '-c', 'echo hi'], () => {});
    expect(res.status).toBe('rejected');
    expect(res.output).toMatch(/白名单/);
  });
});

/**
 * 需要真 venv 的"装包"用例都在 `env-lifecycle.test.ts` 里，不在这里。
 *
 * 原因不是整理，是正确性：vitest 默认并行跑不同文件，而 reset 会把共享的 venv 删掉重建。
 * 实测把两者拆在两个文件里时，装包用例会随机红 —— 这是 WI-72 那轮记过的
 * "同目录并发测试互相删"同一类故障，在测试自己身上复现了一次。
 * 本文件只留不碰共享状态的用例（白名单解析、锁、接线顺序）。
 */

/**
 * 接线顺序断言（不是测逻辑，是测"别把校验挪到流里"）。
 *
 * SSE 端点一旦 hijack，HTTP 状态码就救不回来了 —— 所以参数校验必须在 hijack 之前。
 * 这条挪一挪不会让任何行为测试变红（逻辑测试测的是 parseEnvCommand，不看路由），
 * 所以要单独钉住。仓库里已有同类先例：判题的 stat 必须在最后一次 write 之后。
 */
describe('路由接线：校验必须在 hijack 之前', () => {
  const route = (() => {
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');
    const start = src.indexOf('/api/ide/env/command');
    expect(start, '找不到 env/command 路由').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('// MARK:', start + 10));
  })();

  it('hijack 之前先做了 language 与 argv 校验', () => {
    const hijackAt = route.indexOf('reply.hijack()');
    expect(hijackAt, '路由里没有 hijack').toBeGreaterThan(-1);
    expect(route.slice(0, hijackAt)).toContain('notFound');
    expect(route.slice(0, hijackAt)).toContain('badRequest');
  });

  it('无论成功还是异常，都以一条 done 事件收尾（缺了界面就悬在半空）', () => {
    expect(route.split("type: 'done'").length - 1, 'done 事件至少要在成功与异常两条路径上各发一次').toBeGreaterThanOrEqual(2);
  });

  /**
   * 这条是被自己坑出来的：一次编辑把注释和 `app.post(...)` 并到了同一行，
   * 于是**整条路由注册被注释吞掉** —— 接口直接不存在，而上面那条切片断言照样通过
   * （它只 indexOf 字符串，不看那行是不是注释）。
   */
  it('两条 env 路由都是真语句，没被同行注释吞掉', () => {
    const src = readFileSync(join(config.repoRoot, 'server', 'src', 'api', 'app.ts'), 'utf8');
    const lines = src.split('\n');
    for (const needle of ['api}/ide/env`', 'api}/ide/env/reset', 'api}/ide/env/command']) {
      const hits = lines.filter((l) => l.includes(needle) && !l.trim().startsWith('//'));
      expect(hits.length, `找不到注册了 ${needle} 的行`).toBeGreaterThanOrEqual(1);
      for (const l of hits) {
        expect(l.trim().startsWith('app.'), `路由注册行不是语句：${l.trim().slice(0, 80)}`).toBe(true);
      }
    }
  });
});
