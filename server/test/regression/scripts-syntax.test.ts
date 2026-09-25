import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 仓库自己写的脚本也要有闸门。`.qoder/rules/dev_verify_workflow.md` 要求
 * `node --check scripts/*.mjs`、`bash -n <脚本>`、ps1 必须带 UTF-8 BOM —— 但这条一直只写在文档里，
 * 没有任何东西执行它：scripts/ 下两千多行编排代码（增题、JD 抓取、判题桥、产物预算）坏了只能等下次手动跑才发现。
 */

const ROOT = config.repoRoot;

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match(entry.name)) out.push(full.slice(ROOT.length + 1).split(sep).join('/'));
  }
  return out.sort();
}

// 只扫脚本会待的地方：整仓 walk 会爬进 docker-cache / data/judge，白等十几秒
const rootLevel = (dir: string, ext: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => e.name);

const mjsFiles = [...rootLevel(ROOT, '.mjs'), ...walk(join(ROOT, 'scripts'), (name) => name.endsWith('.mjs'))].sort();
const shFiles = [...rootLevel(ROOT, '.sh'), ...walk(join(ROOT, 'scripts'), (name) => name.endsWith('.sh')), ...walk(join(ROOT, 'docker'), (name) => name.endsWith('.sh'))].sort();

describe('scripts/*.mjs 语法自检（node --check）', () => {
  it('确实扫到了脚本文件（空清单等于闸门失效）', () => {
    expect(mjsFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('每个 .mjs 都能被 node --check 解析', () => {
    const broken = mjsFiles
      .map((file) => ({ file, res: spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' }) }))
      .filter(({ res }) => res.status !== 0)
      .map(({ file, res }) => `${file}: ${(res.stderr || '').split('\n').slice(0, 3).join(' / ')}`);
    expect(broken, `语法不过的脚本：\n${broken.join('\n')}`).toEqual([]);
  });
});

describe('shell 脚本语法自检（bash -n）', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  const hasBash = bash.status === 0;

  it('确实扫到了 .sh 文件', () => {
    expect(shFiles.length).toBeGreaterThanOrEqual(3);
  });

  // 宿主与容器都有 bash（verify.sh 自己就是 bash 跑的）；真没有时这条明确 skip 而不是假装通过
  it.skipIf(!hasBash)('每个 .sh 都能被 bash -n 解析', () => {
    const broken = shFiles
      .filter((file) => existsSync(join(ROOT, file)))
      .map((file) => ({ file, res: spawnSync('bash', ['-n', file], { cwd: ROOT, encoding: 'utf8' }) }))
      .filter(({ res }) => res.status !== 0)
      .map(({ file, res }) => `${file}: ${(res.stderr || '').trim()}`);
    expect(broken, `语法不过的脚本：\n${broken.join('\n')}`).toEqual([]);
  });

  it('start.ps1 保留 UTF-8 BOM（Windows PowerShell 5.1 读无 BOM 的中文脚本会解析失败）', () => {
    const file = resolve(ROOT, 'start.ps1');
    const bytes = readFileSync(file);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    // 恰好一个 BOM：曾长期是"EF BB BF EF BB BF"。PowerShell 只吞第一个，
    // 第二个变成行首的 `?`，于是第 1 行的注释被当命令执行 —— `powershell -File start.ps1`
    // 直接炸，而只查前 3 个字节的旧断言完全看不出来。
    expect(bytes.subarray(3, 6).toString('hex'), 'start.ps1 开头有第二个 BOM（PS 会把第 1 行当命令）').not.toBe('efbbbf');
    const firstLine = bytes.subarray(3).toString('utf8').split(/\r?\n/)[0] ?? '';
    expect(firstLine.startsWith('#'), `BOM 之后第一行应当是注释，实际：${firstLine.slice(0, 40)}`).toBe(true);
    // 空文件同样"带 BOM"，所以再钉一个下限：ps1 是 sh 的对等实现，不可能只有几十字节
    expect(bytes.length).toBeGreaterThan(2000);
  });
});

/**
 * 行尾单独一条，因为 `bash -n` 抓不到它：Git Bash 容忍 CRLF，于是宿主上"语法没问题"，
 * 而 `docker compose build` 把 worktree 原样拷进镜像 —— 一个 \r 就让 verify.sh 的
 * `set -eu -o pipefail` 变成无效选项，容器里整轮验证一行都没跑（git 因 eol=lf 还显示"无改动"，
 * 所以看起来像"镜像是新的、验证是绿的"）。真实踩过，判据只能是字节。
 */
describe('shell 脚本行尾（不许有 CR）', () => {
  it('每个 .sh 都不含 CR 字节', () => {
    const crlf = shFiles
      .filter((file) => existsSync(join(ROOT, file)))
      .map((file) => ({ file, cr: countCr(join(ROOT, file)) }))
      .filter(({ cr }) => cr > 0)
      .map(({ file, cr }) => `${file}: ${cr} 个 CR`);
    expect(crlf, `带 CRLF 的 shell 脚本（进镜像即失效）：\n${crlf.join('\n')}`).toEqual([]);
  });
});

/**
 * `start.sh` 与 `start.ps1` 是同一套判据的两个实现 —— 文档里写了"改了其中一个要想另一个"，
 * 但一直靠人记得（历史上漂移过一次：sh 侧修了 hook 检测，ps1 还在说假话）。
 * 这里只比对**开关集合**：两边行为是否等价仍要靠人，但"加了个入口忘了另一侧"这种最便宜的漂移，
 * 不该依赖记性。
 */
describe('start.sh 与 start.ps1 的开关集合必须一致', () => {
  const sh = readFileSync(join(ROOT, 'start.sh'), 'utf8');
  const ps = readFileSync(join(ROOT, 'start.ps1'), 'utf8');

  /** `--bridge-logs` / `$BridgeLogs` 归一到同一个键。 */
  const canonical = (name: string) => name.toLowerCase().replace(/-/g, '');
  // 只认用法注释里的入口（`#   ./start.sh --e2e --in-container` 这种一行两个的都算）：
  // 用法没写的入口等于没有
  const shNames = new Set(
    [...sh.matchAll(/^#\s+\.\/start\.sh\s+(.*)$/gm)]
      .flatMap((line) => [...(line[1] ?? '').matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => canonical(m[1] ?? '')))
      .filter((name) => name.length > 0),
  );
  const psNames = new Set(
    [...ps.matchAll(/^\s*\[switch\]\$(\w+)/gm)]
      .map((m) => canonical(m[1] ?? ''))
      .filter((name) => name.length > 0),
  );

  it('两侧都扫到了入口（空清单等于闸门失效）', () => {
    expect(shNames.size).toBeGreaterThanOrEqual(6);
    expect(psNames.size).toBeGreaterThanOrEqual(6);
  });

  it('sh 有的入口 ps1 必须有，反之亦然', () => {
    const onlySh = [...shNames].filter((name) => !psNames.has(name));
    const onlyPs = [...psNames].filter((name) => !shNames.has(name));
    expect({ onlySh, onlyPs }, '两侧入口不一致').toEqual({ onlySh: [], onlyPs: [] });
  });
});

function countCr(absFile: string): number {
  const buf = readFileSync(absFile);
  let n = 0;
  for (const byte of buf) if (byte === 0x0d) n += 1;
  return n;
}
