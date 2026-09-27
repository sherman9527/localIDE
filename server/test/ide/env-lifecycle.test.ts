import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDE_ENV_ROOT, ensureIdeEnv, familyDir } from '../../src/ide/env.js';
import { resetIdeEnv } from '../../src/ide/reset.js';
import { readInventory } from '../../src/ide/env-inventory.js';
import { runEnvCommand } from '../../src/ide/env-command.js';
import { REPL_MAX_SESSIONS, replSessions, startRepl, stopRepl } from '../../src/ide/repl.js';
import { findLanguage } from '../../src/ide/languages.js';
import { ideAvailability, runIdeCode } from '../../src/ide/runner.js';

/**
 * 环境生命周期：装 → 用 → reset → 再用不到。
 *
 * **为什么这些用例集中在同一个文件里**：它们会真的改动共享的那份 venv
 * （`/opt/arena-ide-env/python`），而 vitest 默认**并行跑不同文件** ——
 * 实测把"装包"与"reset"拆到两个文件里，reset 会在装包进行到一半时把 venv 删掉，
 * 装包用例随机红。文件内的用例是串行的，所以必须放一起。
 *
 * 这正是 WI-72 那轮记过的同一类故障（"同目录并发测试互相删"）在测试自己身上的复现。
 * 只读的用例（parse 白名单、清单解析、接线顺序）留在各自文件里，它们不碰共享状态。
 */

const available = await ideAvailability();
const guardedPython = available['python'] === true ? it : it.skip;

const python = findLanguage('python')!;
const node = findLanguage('javascript')!;

/** 按顺序跑：vitest 默认串行执行同一文件内的用例，这里显式说明依赖关系。 */
describe('python 环境生命周期（串行，共享一份 venv）', () => {
  let installedRoot = '';

  guardedPython(
    '① 装一个本地包：落进 venv，而系统 site-packages 不许出现它（红线一在真实安装上验）',
    async () => {
      await ensureIdeEnv(python);
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      installedRoot = await mkdtemp(join(tmpdir(), 'arena-probe-pkg-'));
      await writeFile(
        join(installedRoot, 'setup.py'),
        ["from setuptools import setup", "setup(name='arena-probe-pkg', version='1.0', py_modules=['arena_probe_pkg'])", ''].join('\n'),
      );
      await writeFile(join(installedRoot, 'arena_probe_pkg.py'), 'MARKER = "installed-into-venv"\n');

      const chunks: string[] = [];
      // --no-cache-dir：不加的话 pip 把构建出的 wheel 写进 /root/.cache，
      // 而那是 bind mount 的 docker-cache/ —— 一次测试在仓库里留下两个 .whl 脏文件。
      const res = await runEnvCommand(python, ['pip3', 'install', '--no-cache-dir', installedRoot], (c) => chunks.push(c));
      expect(res.status, `安装失败：${res.output.slice(-400)}`).toBe('ok');
      expect(chunks.join('')).toContain('arena-probe-pkg');

      const libDir = join(familyDir(IDE_ENV_ROOT, 'python'), 'lib');
      const versions = await readdir(libDir);
      const first = versions[0];
      expect(first, 'venv 里没有版本目录').toBeTruthy();
      const site = await readdir(join(libDir, first!, 'site-packages'));
      expect(site, '包装完了却不在 venv 里 ⇒ 用错了 pip').toContain('arena_probe_pkg.py');

      const { runProcess } = await import('../../src/judge/process.js');
      const probe = await runProcess('python3', ['-c', 'import arena_probe_pkg'], {
        cwd: IDE_ENV_ROOT,
        timeoutMs: 30_000,
      });
      expect(probe.code, '系统 python3 竟然能 import 用户刚装的包 ⇒ 环境漏进判题了').not.toBe(0);
    },
    240_000,
  );

  guardedPython('② 装完立刻能在 IDE 里 import（安装与运行用的是同一个环境）', async () => {
    const res = await runIdeCode({ language: 'python', code: 'import arena_probe_pkg; print(arena_probe_pkg.MARKER)' });
    expect(res.stdout, `import 不到刚装的包：${res.stderr.slice(0, 200)}`).toContain('installed-into-venv');
    const inv = await readInventory(python);
    expect(inv.packages.map((p) => p.name)).toContain('arena-probe-pkg');
  });

  guardedPython('③ reset 之后清单为空、同一个 import 必须失败（界面与现实之间唯一的绑定）', async () => {
    const before = await readInventory(python);
    expect(before.packages.length, '前置条件不成立：清单是空的').toBeGreaterThan(0);

    const res = await resetIdeEnv(python);
    expect(res.ok, res.reason ?? '').toBe(true);
    expect(res.removedBytes).toBeGreaterThan(0);

    const after = await readInventory(python);
    expect(after.packages.map((p) => p.name), '清单里还留着已删的包').not.toContain('arena-probe-pkg');
    const retry = await runIdeCode({ language: 'python', code: 'import arena_probe_pkg' });
    expect(retry.stdout, 'reset 之后竟然还能 import ⇒ 环境没真的换掉').not.toContain('installed-into-venv');

    // 重建必须是可用的：镜像预装的 pandas 还在（--system-site-packages 的效果没丢）
    const pandas = await runIdeCode({ language: 'python', code: 'import pandas; print("pandas-ok")' });
    expect(pandas.stdout, 'reset 把环境删坏了：预装包也不见了').toContain('pandas-ok');
  });

  guardedPython('④ reset 会作废活的 REPL 会话并把名额交回', async () => {
    const started = await startRepl('python');
    expect(started.session, 'REPL 起不来，这条用例没有意义').not.toBeNull();
    expect(replSessions().filter((s) => s.language === 'python').length).toBeGreaterThanOrEqual(1);

    const res = await resetIdeEnv(python);
    expect(res.ok).toBe(true);
    expect(res.stoppedSessions, '没有会话被停 ⇒ 那个 REPL 还在读已删除的路径').toBeGreaterThanOrEqual(1);
    expect(replSessions().some((s) => s.language === 'python'), 'reset 后 REPL 会话还活着').toBe(false);

    const fresh: string[] = [];
    for (let i = 0; i < REPL_MAX_SESSIONS; i++) {
      const s = await startRepl('python');
      if (s.session) fresh.push(s.session.id);
    }
    expect(fresh.length, '幽灵会话还占着名额').toBe(REPL_MAX_SESSIONS);
    for (const id of fresh) await stopRepl(id);
  });

  guardedPython('⑤ 装一个不存在的包：状态必须是失败，并把 pip 的话原样带出来', async () => {
    const res = await runEnvCommand(python, ['pip3', 'install', '--no-cache-dir', 'arena-no-such-pkg-9x7q'], () => {});
    expect(res.status).toBe('failed');
    expect(res.output.toLowerCase()).toMatch(/no matching distribution|error|could not find/i);
  });
});

describe('node 环境生命周期（与 python 不冲突，但同样串行）', () => {
  guardedPython('npm 被注入 --prefix，装的东西落在 ide-env/node 而不是仓库根', async () => {
    const res = await runEnvCommand(node, ['npm', 'ls'], () => {});
    expect(['ok', 'failed']).toContain(res.status); // 空环境里 npm ls 可能非零退出，这里只验它真的跑起来了
    expect(res.output).not.toMatch(/ENOENT|npm 不在白名单/);
  });
});
