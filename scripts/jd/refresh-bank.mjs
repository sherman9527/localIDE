#!/usr/bin/env node
/**
 * 题库刷新编排（需求 9：靠公开 JD + 历史高频问答整理题库，**只增不减**，题目带入库时间与 JD 来源）。
 *
 *   npm run bank:refresh -- --dry-run                       # 全流程试跑，一题都不写
 *   npm run bank:refresh                                    # fetch → skills → 按缺口逐类别生成并入库
 *   npm run bank:refresh -- --categories big-data,sql --n 3
 *   npm run bank:refresh -- --offline --company Airbnb      # 不联网：用 content/jd-cache 缓存 + drafts
 *
 * 步骤：
 *   1) scripts/jd/fetch.mjs     真抓 JD 进 content/jd-cache（缓存合并只增不减）
 *   2) extract-skills           JD → 技术栈权重 skills.json
 *   3) 逐类别算缺口（目标题量读 server/test/bank/content.test.ts 的 MINIMUMS）→ generate-with-cli 补题
 *
 * 退出码：0=全部成功；1=有类别失败/有步骤降级。**任何情况下都不会改动或删除已有题目**（写题只走 ingest()）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, UsageError, isMain, parseArgs, readPositiveInt, rel } from './lib.mjs';
import { runFetch } from './fetch.mjs';
import { runExtractSkills } from './extract-skills.mjs';
import { runGenerate } from '../bank/generate-with-cli.mjs';
import { loadQuestions, statsByCategory } from '../bank/kit.mjs';
import { loadShared } from '../kb/kit.mjs';

/** 兜底目标题量：与 server/test/bank/content.test.ts 的 MINIMUMS 保持一致（那里是权威，解析失败才用它）。 */
const FALLBACK_TARGETS = {
  'big-data': 20,
  algorithms: 18,
  sql: 16,
  'system-design': 14,
  frontend: 12,
  'agent-design': 10,
  'hot-interviews': 6,
};

export function loadTargets() {
  const testFile = join(ROOT, 'server', 'test', 'bank', 'content.test.ts');
  if (!existsSync(testFile)) return { targets: { ...FALLBACK_TARGETS }, source: '内置兜底（server/test/bank/content.test.ts 不存在）' };
  const text = readFileSync(testFile, 'utf8');
  const block = /const MINIMUMS[^=]*=\s*{([\s\S]*?)}/.exec(text);
  if (!block) return { targets: { ...FALLBACK_TARGETS }, source: '内置兜底（解析不到 MINIMUMS 块，检查 server/test/bank/content.test.ts）' };
  const targets = {};
  // MINIMUMS 里 key 有的带引号（'big-data': 20）有的不带（algorithms: 18），两种都要吃到
  for (const m of block[1].matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_-]+))\s*:\s*(\d+)/g)) {
    const key = m[1] ?? m[2] ?? m[3];
    if (key) targets[key] = Number(m[4]);
  }
  if (Object.keys(targets).length === 0) return { targets: { ...FALLBACK_TARGETS }, source: '内置兜底（MINIMUMS 块里没有条目）' };
  return { targets, source: rel(testFile) };
}

const USAGE =
  '用法：node scripts/jd/refresh-bank.mjs [--dry-run] [--offline] [--categories a,b|all] [--n N] [--company Apple|Airbnb|all] [--limit N] [--skip-fetch] [--skip-skills]';

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), {
      booleans: ['dry-run', 'offline', 'help', 'skip-fetch', 'skip-skills'],
    });
    if (args.help) {
      console.log(USAGE);
      return;
    }
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
    return;
  }
  const dryRun = Boolean(args['dry-run']);
  const offline = Boolean(args.offline);
  const perCategory = readPositiveInt(args.n, '--n', 4);
  let fetchReport = null;
  let skillReport = null;
  const failures = [];

  try {
    const shared = await loadShared();
    const allCategories = [...shared.CATEGORY_IDS];
    const wanted = String(args.categories ?? 'all')
      .split(/[,\s]+/)
      .filter(Boolean);
    const categories = wanted.length === 0 || wanted.includes('all') ? allCategories : wanted.filter((c) => {
      if (!allCategories.includes(c)) {
        console.error(`✗ --categories 里有未知类别 "${c}"；可用：${allCategories.join(', ')}`);
        return false;
      }
      return true;
    });
    if (categories.length === 0) throw new UsageError(`没有可处理类别\n${USAGE}`);

    console.log(`== 步骤 1/3 JD 抓取（${offline ? '离线' : dryRun ? '真抓但不写缓存(--dry-run)' : '真抓并合并进缓存'}）==`);
    if (!args['skip-fetch']) {
      fetchReport = await runFetch({ offline, company: args.company ?? 'all', limit: args.limit ? readPositiveInt(args.limit, '--limit', 25) : undefined, dryRun });
      for (const c of fetchReport.companies) {
        if (c.disabled) continue;
        if (c.fetchFailed) failures.push(`jd:${c.company}（没拿到 JD，缓存里 ${c.cached ?? 0} 条继续可用）`);
      }
    } else {
      console.log('  跳过（--skip-fetch）');
    }

    console.log('\n== 步骤 2/3 JD → 技术栈权重 ==');
    if (!args['skip-skills']) {
      skillReport = await runExtractSkills({ offline });
    } else {
      console.log('  跳过（--skip-skills）');
    }

    console.log(`\n== 步骤 3/3 按类别缺口补题（每类别最多 ${perCategory} 题，provider：qodercli → bridge → copilot）==`);
    const { questions } = await loadQuestions();
    const before = statsByCategory(questions);
    const { targets, source } = loadTargets();
    console.log(`  目标题量来源：${source}`);
    const missingTargets = categories.filter((c) => targets[c] === undefined);
    if (missingTargets.length > 0) {
      console.warn(`⚠ 这些类别在目标题量表里没有条目（本轮按 0 处理，不会补题）：${missingTargets.join(', ')}；检查 content.test.ts 的 MINIMUMS`);
    }
    const rows = [];

    for (const category of categories) {
      const current = before.get(category)?.total ?? 0;
      const target = targets[category] ?? 0;
      const gap = Math.max(0, target - current);
      const n = Math.min(gap, perCategory);
      console.log(`\n-- ${category}：现有 ${current} / 目标 ${target}${gap > 0 ? `（缺 ${gap}，本轮补 ${n}）` : '（已达标）'}`);
      if (gap === 0) {
        rows.push({ category, current, target, gap, asked: 0, drafts: 0, added: 0, skipped: 0, rejected: 0, status: 'ok（无需补题）' });
        continue;
      }
      const summary = await runGenerate({ category, n, offline, dryRun, timeoutMs: args['timeout-ms'] === undefined ? undefined : readPositiveInt(args['timeout-ms'], '--timeout-ms', 180_000), skipDraftArchive: dryRun });
      const status = summary.error ? `FAIL：${summary.error}` : dryRun ? `dry-run ok（${summary.drafts} 草稿）` : `ok（+${summary.added}${summary.skipped ? ` 跳过${summary.skipped}` : ''}${summary.rejected ? ` 拒${summary.rejected}` : ''}）`;
      if (summary.error) failures.push(`${category}：${summary.error}`);
      rows.push({ category, current, target, gap, asked: n, drafts: summary.drafts, added: summary.added, skipped: summary.skipped, rejected: summary.rejected, status });
    }

    const after = dryRun ? before : (await loadQuestions()).questions;
    const afterStats = dryRun ? before : statsByCategory(after);
    console.log('\n== 刷新汇总 ==');
    console.log('类别             现有→预计   目标   请求  草稿  入库  跳过  拒绝  状态');
    for (const row of rows) {
      const projected = afterStats.get(row.category)?.total ?? row.current;
      console.log(
        `${row.category.padEnd(16)} ${String(row.current).padStart(2)}→${String(projected).padStart(3)}    ${String(row.target).padStart(4)}  ${String(row.asked).padStart(4)} ${String(row.drafts).padStart(5)} ${String(row.added).padStart(5)} ${String(row.skipped).padStart(5)} ${String(row.rejected).padStart(5)}  ${row.status}`,
      );
    }
    if (skillReport) {
      console.log(`\nskills.json：${skillReport.skills.length} 个技术栈标签，JD ${skillReport.corpus.jdEntries} 条（来源 ${Object.keys(skillReport.corpus.companyCounts).join('/')}）`);
    }
    console.log(dryRun ? '（--dry-run：题库与缓存均未被修改）' : '题库写入只走 ingest()（append-only）；已有题目不会被改动。');
    console.log('下一步：npm run bank:check && npm run kb:index && node scripts/curriculum.mjs');

    if (failures.length > 0) {
      console.error(`\n✗ ${failures.length} 个环节失败：`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}\n${USAGE}`);
      process.exit(2);
      return;
    }
    console.error(`✗ 刷新流程中断：${err?.stack ?? err}`);
    console.error('  注意：已有题目不受影响（ingest 是唯一写入口，且 append-only）。');
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
