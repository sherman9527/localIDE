import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IDE_ENV_ROOT, envFamilyOf, envUnsupportedReason, familyDir, sumBytes, type IdeEnvFamily } from './env.js';
import type { IdeLanguage } from './languages.js';

/**
 * IDE 环境的包清单。
 *
 * 唯一来源是**环境本身**（dist-info / package.json+node_modules / lib 下的 jar），
 * 不是"装过什么"的记录。记录会漂移：手工塞一个 jar、装到一半崩了、容器重建后目录还在
 * 而记录没了 —— 任何一种都会让界面显示的和现实不一致。
 *
 * 推论很省事：**"哪些是用户自装的"由物理位置回答**。venv 继承了系统 site-packages
 * （为了保住镜像预装的 pandas），但清单只扫 venv 自己那一层，所以不需要维护 diff 表。
 */

// 类型只有一份真相：契约在 shared，服务端实现它，不另立一个"看起来一样"的版本。
import type { IdeEnvInventory as IdeEnvContract, IdeEnvPackage } from '@arena/shared';

export interface IdeEnvInventory extends IdeEnvContract {
  /** 环境按运行时家族分（js/ts 同属 node 家族）；契约里不给前端，只服务内部用 */
  family?: IdeEnvFamily;
}

const NOTE = '这些包只影响 IDE 的运行 / REPL / 调试；判题器看不到它们。';

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * dist-info 目录只有几十字节的元数据，包的体积在**模块目录**里。
 * 只算 dist-info 会让"这个环境占多少磁盘"永远报出接近 0 的假数。
 */
async function readDistInfo(siteDir: string, entry: string): Promise<IdeEnvPackage | null> {
  const dir = join(siteDir, entry);
  const metadata = await readFile(join(dir, 'METADATA'), 'utf8').catch(() => '');
  const name = /^\s*Name:\s*(.+)$/im.exec(metadata)?.[1]?.trim();
  const version = /^\s*Version:\s*(.+)$/im.exec(metadata)?.[1]?.trim();
  const fromMeta = name && version ? { name, version } : null;
  // 退到目录名：`<name>-<version>.dist-info`，版本以数字开头，所以按最后一个"数字前缀"切
  const m = /^(.+?)-(\d[^-]*)\.(?:dist|egg)-info$/.exec(entry);
  if (!fromMeta && !m) return null;
  const resolved = fromMeta ?? { name: m?.[1] ?? entry, version: m?.[2] ?? '' };
  let sizeBytes = await sumBytes(dir);
  for (const candidate of moduleDirCandidates(resolved.name)) {
    sizeBytes += await sumBytes(join(siteDir, candidate));
  }
  return { name: resolved.name, version: resolved.version, sizeBytes };
}

/** `pip install zope.interface` 落地的目录叫 `zope`，所以两种写法都要试。 */
function moduleDirCandidates(name: string): string[] {
  const underscored = name.replace(/-/g, '_');
  const top = name.split('.')[0] ?? name;
  const topUnderscored = underscored.split('.')[0] ?? underscored;
  return [...new Set([name, underscored, top, topUnderscored])];
}

async function pythonPackages(root: string): Promise<IdeEnvPackage[]> {
  const libDir = join(familyDir(root, 'python'), 'lib');
  const out: IdeEnvPackage[] = [];
  // 小版本号不写死：升基础镜像后 venv 会是 lib/python3.11，写死就变成"清单永远空且不报错"
  const versions = await readdir(libDir).catch(() => [] as string[]);
  for (const v of versions) {
    const site = join(libDir, v, 'site-packages');
    const entries = await readdir(site).catch(() => [] as string[]);
    for (const e of entries) {
      if (!/\.(dist|egg)-info$/.test(e)) continue;
      const pkg = await readDistInfo(site, e);
      if (pkg) out.push(pkg);
    }
  }
  return out;
}

/** node_modules 里 @scope 是一层目录，要再展开一次。 */
async function installedNodeModules(modRoot: string): Promise<Map<string, { version: string; sizeBytes: number }>> {
  const found = new Map<string, { version: string; sizeBytes: number }>();
  const top = await readdir(modRoot, { withFileTypes: true }).catch(() => []);
  const visit = async (name: string): Promise<void> => {
    const dir = join(modRoot, name);
    const pkg = await readJson(join(dir, 'package.json'));
    const version = typeof pkg?.version === 'string' ? pkg.version : '?';
    found.set(name, { version, sizeBytes: await sumBytes(dir) });
  };
  for (const entry of top) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(join(modRoot, entry.name), { withFileTypes: true }).catch(() => []);
      for (const s of scoped) if (s.isDirectory()) await visit(`${entry.name}/${s.name}`);
    } else {
      await visit(entry.name);
    }
  }
  return found;
}

async function nodeInventory(root: string): Promise<Pick<IdeEnvInventory, 'packages' | 'drift'>> {
  const nodeRoot = familyDir(root, 'node');
  const manifest = await readJson(join(nodeRoot, 'package.json'));
  const declared = Object.keys((manifest?.dependencies as Record<string, string> | undefined) ?? {});
  const installed = await installedNodeModules(join(nodeRoot, 'node_modules'));
  const packages: IdeEnvPackage[] = [...installed.entries()].map(([name, v]) => ({
    name,
    version: v.version,
    sizeBytes: v.sizeBytes,
  }));
  // 声明了却不在 node_modules 里 ⇒ 装坏了。这种现场必须显示出来，藏起来等于骗人。
  const drift = declared.filter((d) => !installed.has(d));
  return { packages, drift };
}

async function jarPackages(root: string, family: IdeEnvFamily): Promise<IdeEnvPackage[]> {
  const lib = join(familyDir(root, family), 'lib');
  const names = await readdir(lib).catch(() => [] as string[]);
  const out: IdeEnvPackage[] = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.jar')) continue;
    const st = await stat(join(lib, n)).catch(() => null);
    out.push({ name: n, version: '', sizeBytes: st?.size ?? 0 });
  }
  return out;
}

export async function readInventory(language: IdeLanguage, root: string = IDE_ENV_ROOT): Promise<IdeEnvInventory> {
  const family = envFamilyOf(language);
  if (!family) {
    return {
      language: language.id,
      supported: false,
      reason: envUnsupportedReason(language),
      packages: [],
      totalBytes: 0,
      drift: [],
      note: NOTE,
    };
  }

  let packages: IdeEnvPackage[] = [];
  let drift: string[] = [];
  if (family === 'python') {
    packages = await pythonPackages(root);
  } else if (family === 'node') {
    // 只算一次：调两遍会读到两个时刻的磁盘状态，drift 与 packages 可能对不上
    const inv = await nodeInventory(root);
    packages = inv.packages;
    drift = inv.drift;
  } else {
    packages = await jarPackages(root, family);
  }

  // 体积按整个环境目录量，而不是把各包相加：venv 自带的 pip/setuptools 也真实占盘，
  // 面板要说的是"这个环境吃掉多少磁盘"，不是"用户包的元数据合计"。
  const totalBytes = await sumBytes(familyDir(root, family));
  return { language: language.id, family, supported: true, packages, totalBytes, drift, note: NOTE };
}
