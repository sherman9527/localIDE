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
