import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readInventory } from '../../src/ide/env-inventory.js';
import { VENV_BASELINE_FILENAME } from '../../src/ide/env.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * 包清单：界面上"用户自己装了什么"的唯一来源。
 *
 * 核心纪律是**读环境本身，不读安装日志** —— 日志会漂移（手工塞一个 jar、装到一半崩了、
 * 容器重建后目录还在但记录没了），任何一种都会让界面与现实不一致，而"界面说假话"
 * 是本项目反复栽的那一类。
 *
 * 所有用例都往一个临时 root 里造结构，因此不需要真 venv，宿主也能跑。
 */

const python = findLanguage('python')!;
const node = findLanguage('javascript')!;
const java = findLanguage('java')!;
const c = findLanguage('c')!;

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'arena-inv-'));
}

/** 造一个 venv 形状的目录树（lib/pythonX.Y/site-packages/<name>-<ver>.dist-info）。 */
async function plantDistInfo(root: string, name: string, version: string, bytes = 2048): Promise<void> {
  const site = join(root, 'python', 'lib', 'python3.10', 'site-packages');
  await mkdir(join(site, `${name}-${version}.dist-info`), { recursive: true });
  await writeFile(join(site, `${name}-${version}.dist-info`, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
  await mkdir(join(site, name), { recursive: true });
  await writeFile(join(site, `${name}`, '__init__.py'), Buffer.alloc(bytes));
}

describe('python 清单', () => {
  it('空环境给空列表，而不是报错或 undefined', async () => {
    const inv = await readInventory(python, await freshRoot());
    expect(inv.supported).toBe(true);
    expect(inv.packages).toEqual([]);
    expect(inv.totalBytes).toBe(0);
  });

  it('从 dist-info 目录名解析出名字与版本（不 shell 调 pip：省一次解释器启动，也少一条"pip 自己坏了"的干扰路径）', async () => {
    const root = await freshRoot();
    await plantDistInfo(root, 'requests', '2.31.0');
    await plantDistInfo(root, 'urllib3', '2.0.7');
    const inv = await readInventory(python, root);
    const names = inv.packages.map((p) => `${p.name}@${p.version}`).sort();
    expect(names).toEqual(['requests@2.31.0', 'urllib3@2.0.7']);
  });

  it('每条带体积，且 totalBytes 是它们之和（面板要据此提醒"该 reset 了"）', async () => {
    const root = await freshRoot();
    await plantDistInfo(root, 'requests', '2.31.0', 4096);
    const inv = await readInventory(python, root);
    const one = inv.packages.find((p) => p.name === 'requests');
    expect(one?.sizeBytes).toBeGreaterThanOrEqual(4096);
    expect(inv.totalBytes).toBeGreaterThanOrEqual(one?.sizeBytes ?? 0);
  });

  it('带连字符的包名不许被版本解析截断（typing_extensions / zope-interface 这类）', async () => {
    const root = await freshRoot();
    await plantDistInfo(root, 'zope-interface', '6.1');
    const inv = await readInventory(python, root);
    expect(inv.packages.map((p) => p.name)).toEqual(['zope-interface']);
    expect(inv.packages[0]?.version).toBe('6.1');
  });

  it('小版本号目录不写死：python3.11 的 venv 也要能读到', async () => {
    const root = await freshRoot();
    const site = join(root, 'python', 'lib', 'python3.11', 'site-packages');
    await mkdir(join(site, 'rich-13.0.0.dist-info'), { recursive: true });
    const inv = await readInventory(python, root);
    expect(inv.packages.map((p) => p.name)).toEqual(['rich']);
  });

  /**
   * pip 会把 dist-info 目录名里的连字符写成下划线（PEP 427），所以"照目录名切"
   * 会给用户看 `typing_extensions` 这种它自己没写过的名字。METADATA 里的 Name 才是权威。
   */
  it('目录名与 METADATA 不一致时以 METADATA 为准（pip 实际写的是下划线形式）', async () => {
    const root = await freshRoot();
    const info = join(root, 'python', 'lib', 'python3.10', 'site-packages', 'typing_extensions-4.9.0.dist-info');
    await mkdir(info, { recursive: true });
    await writeFile(join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: typing-extensions\nVersion: 4.9.0\n');
    const inv = await readInventory(python, root);
    expect(inv.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['typing-extensions@4.9.0']);
  });

  /**
   * `python3 -m venv` 会把 pip 与 setuptools 装进 **venv 自己的** site-packages，
   * 所以"只扫 venv 目录 = 只列用户装的"是错的。真浏览器里量到过：面板把
   * pip 22.0.2（11.1MB）+ setuptools 59.6.0（3.4MB）报成用户包，合计 47.7MB。
   * 修法是减去"建好那一刻的基线"，而不是硬编码一个包名集合 ——
   * 硬编码会把"用户自己 pip install -U pip"这件事也藏掉。
   */
  it('减去 venv 自带的引导包，但用户后来装的仍然要显示', async () => {
    const root = await freshRoot();
    await plantDistInfo(root, 'pip', '22.0.2');
    await plantDistInfo(root, 'setuptools', '59.6.0');
    await plantDistInfo(root, 'requests', '2.31.0');
    await mkdir(join(root, 'python'), { recursive: true });
    await writeFile(
      join(root, 'python', VENV_BASELINE_FILENAME),
      JSON.stringify({ entries: ['pip-22.0.2.dist-info', 'setuptools-59.6.0.dist-info'] }),
    );
    const inv = await readInventory(python, root);
    expect(inv.packages.map((p) => p.name)).toEqual(['requests']);
  });

  it('没有基线文件时不猜：全部列出（宁可多列，也不许把用户真装的藏掉）', async () => {
    const root = await freshRoot();
    await plantDistInfo(root, 'pip', '22.0.2');
    await plantDistInfo(root, 'requests', '2.31.0');
    const inv = await readInventory(python, root);
    expect(inv.packages.map((p) => p.name).sort()).toEqual(['pip', 'requests']);
  });
});

describe('node 清单', () => {
  it('package.json 声明了但 node_modules 里没有 ⇒ 把不一致本身报出来，不许吞', async () => {
    const root = await freshRoot();
    const nodeRoot = join(root, 'node');
    await mkdir(nodeRoot, { recursive: true });
    await writeFile(join(nodeRoot, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.3.0' } }));
    const inv = await readInventory(node, root);
    expect(inv.packages).toEqual([]);
    expect(inv.drift ?? [], '声明与实装不一致时必须点名').toContain('left-pad');
  });

  it('两边都有 ⇒ 正常列出且无 drift', async () => {
    const root = await freshRoot();
    const nodeRoot = join(root, 'node');
    await mkdir(join(nodeRoot, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(nodeRoot, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.3.0' } }));
    await writeFile(join(nodeRoot, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }));
    const inv = await readInventory(node, root);
    expect(inv.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['left-pad@1.3.0']);
    expect(inv.drift ?? []).toEqual([]);
  });
});

describe('java / scala 与不支持的语言', () => {
  it('java 直接列 lib 下的 jar —— 文件即答案，不需要任何安装记录', async () => {
    const root = await freshRoot();
    await mkdir(join(root, 'java', 'lib'), { recursive: true });
    await writeFile(join(root, 'java', 'lib', 'guava-33.jar'), Buffer.alloc(1024));
    const inv = await readInventory(java, root);
    expect(inv.packages.map((p) => p.name)).toEqual(['guava-33.jar']);
    expect(inv.packages[0]?.sizeBytes).toBe(1024);
  });

  it('本期不开命令窗口的语言也要如实说明原因，而不是给一个空列表让人以为"装了没生效"', async () => {
    const inv = await readInventory(c, await freshRoot());
    expect(inv.supported).toBe(false);
    expect((inv.reason ?? '').length).toBeGreaterThan(6);
    expect(inv.packages).toEqual([]);
  });

  it('每个清单都带"判题器看不到"这句话（用户不该等交题撞了才发现这道缝）', async () => {
    for (const lang of [python, node, java]) {
      const inv = await readInventory(lang, await freshRoot());
      expect(inv.note).toContain('判题');
    }
  });

  it('清单要带上"这门语言怎么加包"，否则面板只能自己按语言 id 猜（Java 挂 pip 输入框就是这么来的）', async () => {
    const root = await freshRoot();
    expect((await readInventory(python, root)).commandWindow).toEqual({ open: true, example: 'pip3 install requests' });
    expect((await readInventory(node, root)).commandWindow).toEqual({ open: true, example: 'npm install left-pad' });
    const jv = await readInventory(java, root);
    expect(jv.supported, 'java 有环境：lib 下的 jar 会进 classpath').toBe(true);
    expect(jv.commandWindow?.open, '但没有安装器').toBe(false);
    // 没有环境的语言不给 commandWindow：面板那条 reason 已有出处，两处说同一件事就是重复
    expect((await readInventory(c, root)).commandWindow).toBeUndefined();
  });
});
