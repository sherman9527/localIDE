#!/usr/bin/env node
/**
 * 抓 JD → content/jd-cache/<company>-<YYYY-MM-DD>.json（只增不减）。
 *
 *   node scripts/jd/fetch.mjs                        # 全公司真抓一次
 *   node scripts/jd/fetch.mjs --company Airbnb       # 只抓 Airbnb
 *   node scripts/jd/fetch.mjs --company Apple --limit 10
 *   node scripts/jd/fetch.mjs --offline              # 只读缓存，不写盘（断网/CI 用）
 *   node scripts/jd/fetch.mjs --dry-run              # 真抓但不写缓存
 *
 * 退出码：0=成功（含"离线但有缓存"）；1=有公司一条 JD 都没拿到；2=用法错误。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  UsageError,
  cacheFileName,
  isMain,
  loadSources,
  mergeEntries,
  normalizeJdEntry,
  parseArgs,
  readCachedJds,
  readPositiveInt,
  rel,
  writeJsonAtomic,
  ROOT,
} from './lib.mjs';
import { ADAPTERS } from './adapters.mjs';

export const USAGE = '用法：node scripts/jd/fetch.mjs [--offline] [--company Apple|Airbnb|all] [--limit N] [--out content/jd-cache] [--dry-run]';

/** 把命令行给的相对路径落到仓库根里算（rule.md C1：产物不出仓库）。 */
export function resolveOutDir(given) {
  if (!given) return null;
  const abs = isAbsolute(given) ? given : resolve(process.cwd(), given);
  const insideRepo = abs === ROOT || abs.startsWith(ROOT + '/') || abs.startsWith(ROOT + '\\');
  if (!insideRepo) {
    throw new UsageError(`--out 必须在仓库内（rule.md C1），收到 ${abs}`);
  }
  return abs;
}

function readExisting(file) {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const items = Array.isArray(raw) ? raw : (raw.entries ?? []);
    return items.map(normalizeJdEntry).filter(Boolean);
  } catch (err) {
    console.warn(`⚠ 缓存文件 ${rel(file)} 读不动（${err.message}）；本次不会覆盖它，请先手工修或删`);
    return [];
  }
}

export async function runFetch(opts = {}) {
  const cfg = await loadSources(opts.sourcesFile);
  const cacheDir = opts.outDir ?? cfg.cacheDir;
  const report = { offline: Boolean(opts.offline), cacheDir, companies: [], generatedAt: new Date().toISOString() };

  const wanted = String(opts.company ?? 'all').toLowerCase();
  const targets = cfg.targets.filter((t) => wanted === 'all' || String(t.company).toLowerCase() === wanted);
  if (targets.length === 0) {
    throw new UsageError(
      `scripts/jd/sources.json 里没有 company="${opts.company}" 的 target；已有：${[...new Set(cfg.targets.map((t) => t.company))].join(', ')}`,
    );
  }

  if (report.offline) {
    console.log('离线模式：使用 content/jd-cache 缓存');
    const cached = await readCachedJds(cacheDir);
    for (const company of new Set(targets.map((t) => t.company))) {
      const entries = cached.filter((e) => String(e.company).toLowerCase() === String(company).toLowerCase());
      report.companies.push({
        company,
        adapter: '(cache)',
        cached: entries.length,
        added: 0,
        fetchFailed: false,
        notes: entries.length === 0 ? [`缓存里没有 ${company} 的 JD；补一份 content/jd-cache/history/${String(company).toLowerCase()}-*.md 样本即可离线出题`] : [],
      });
      console.log(`  ${company}：缓存 ${entries.length} 条 JD（含 history/*.md 人工样本）`);
    }
    report.totals = summarize(report);
    return report;
  }

  const enabled = targets.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    console.warn(`⚠ company="${opts.company}" 的所有 target 都被标了 enabled:false：`);
    for (const t of targets) console.warn(`    - ${t.company}/${t.adapter}：${t.disabledReason ?? 'sources.json 里未写 disabledReason'}`);
  }

  for (const target of enabled) {
    const adapter = ADAPTERS[target.adapter];
    if (!adapter) {
      const msg = `sources.json 里 adapter="${target.adapter}" 未实现；可用：${Object.keys(ADAPTERS).join(', ')}`;
      console.error(`✗ ${msg}`);
      report.companies.push({ company: target.company, adapter: target.adapter, added: 0, cached: 0, fetchFailed: true, notes: [msg] });
      continue;
    }
    const perTargetLimit = Number.isFinite(Number(target.limit)) ? Number(target.limit) : 25;
    let result;
    try {
      result = await adapter(target, {
        userAgent: cfg.userAgent,
        timeoutMs: cfg.http.timeoutMs,
        limit: Math.min(opts.limit ?? perTargetLimit, perTargetLimit),
        excerptChars: target.excerptChars ?? 4000,
      });
    } catch (err) {
      result = { entries: [], fetchFailed: true, notes: [`${target.adapter} 抛异常：${err.message}`], stats: {} };
    }
    const entries = result.entries.map(normalizeJdEntry).filter(Boolean);
    const file = join(cacheDir, cacheFileName(target.company));
    const existing = readExisting(file);
    const { merged, added, enriched } = mergeEntries(existing, entries);

    for (const note of result.notes) console.log(`  · ${target.company}/${target.adapter}：${note}`);
    if (!opts.dryRun && merged.length > 0) {
      await writeJsonAtomic(file, {
        company: target.company,
        adapter: target.adapter,
        generatedAt: new Date().toISOString(),
        count: merged.length,
        previousCount: existing.length,
        entries: merged,
      });
    }
    console.log(
      opts.dryRun
        ? `  ${target.company} [${target.adapter}]：命中 ${entries.length} 条（--dry-run 不写缓存；当前缓存 ${existing.length} 条）`
        : `  ${target.company} [${target.adapter}]：新增 ${added} 条 / 补强 ${enriched} 条 → ${rel(file)}（缓存 ${existing.length} → ${merged.length} 条）`,
    );
    report.companies.push({
      company: target.company,
      adapter: target.adapter,
      fetched: entries.length,
      added,
      enriched,
      cached: opts.dryRun ? existing.length : merged.length,
      cacheFile: rel(file),
      fetchFailed: entries.length === 0 ? Boolean(result.fetchFailed) : false,
      notes: result.notes,
    });
  }

  for (const target of targets.filter((t) => t.enabled === false)) {
    console.log(`  - ${target.company} [${target.adapter}]：已跳过（${target.disabledReason ?? 'sources.json 标了 enabled:false'}）`);
    report.companies.push({
      company: target.company,
      adapter: target.adapter,
      added: 0,
      cached: 0,
      fetchFailed: false,
      disabled: true,
      notes: [target.disabledReason ?? 'disabled'],
    });
  }

  report.totals = summarize(report);
  return report;
}

function summarize(report) {
  return {
    added: report.companies.reduce((s, c) => s + (c.added ?? 0), 0),
    cached: report.companies.reduce((s, c) => s + (c.cached ?? 0), 0),
    failedCompanies: [...new Set(report.companies.filter((c) => c.fetchFailed && !c.disabled).map((c) => c.company))],
    disabled: report.companies.filter((c) => c.disabled).map((c) => `${c.company}/${c.adapter}`),
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { booleans: ['offline', 'dry-run', 'help'] });
    if (args.help) {
      console.log(USAGE);
      return;
    }
    const limit = args.limit === undefined ? undefined : readPositiveInt(args.limit, '--limit', 25);
    const outDir = resolveOutDir(args.out);
    const report = await runFetch({ offline: Boolean(args.offline), company: args.company, limit, outDir, dryRun: Boolean(args['dry-run']) });
    console.log(
      `JD 汇总：本次新增 ${report.totals.added} 条、缓存 ${report.totals.cached} 条` +
        (report.totals.disabled.length ? `；已禁用：${report.totals.disabled.join(', ')}` : ''),
    );
    if (report.offline && report.totals.cached === 0) {
      console.error('✗ 离线模式且缓存为空：先跑 node scripts/jd/fetch.mjs --company Airbnb 生成缓存，或补 content/jd-cache/history/*.md 样本');
      process.exit(1);
    }
    if (report.totals.failedCompanies.length > 0) {
      console.error(`✗ 这些公司一条 JD 都没拿到：${report.totals.failedCompanies.join(', ')}（缓存里的旧数据仍然可用；原因见上面的 · 行）`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}\n${USAGE}`);
      process.exit(2);
      return;
    }
    console.error(`✗ JD 抓取失败：${err?.stack ?? err}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
