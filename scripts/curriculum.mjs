#!/usr/bin/env node
/**
 * 30 天排课（WI-21）：产出 content/curriculum/<YYYY-MM>.json。
 *
 *   node scripts/curriculum.mjs                       # 默认 2026-10，30 天
 *   node scripts/curriculum.mjs --month 2026-11 --days 30
 *   node scripts/curriculum.mjs --min-code 6 --relax   # 没有类别够 6 道代码题时，退而用可判分题最多的类别
 *
 * 规则：
 *   - 每天 1 主栈（2 道可判分/代码题）+ 1 副栈（1 道主观题）。
 *   - 主栈资格线：该类别"可判分代码题（带 referenceSolution）"≥ --min-code（默认 6），
 *     这样 shared 的 pickForDay(pool, date, category, 2) 才必然能取出 2 道不同的题。
 *   - 轮转按题量加权（题多的类别出现的天数多），并尽量让 7 个类别都在 30 天里出现；
 *     出现不了的类别写进 gaps，并给出具体的补题命令（脚本不会为了"覆盖全"而排出一天无题可做）。
 *   - 选题逻辑不自己实现，直接调 @arena/shared 的 pickForDay（与游戏后端同一套确定性算法）。
 *
 * 退出码：0=排课覆盖全部类别；1=有类别无法排入（题库缺口，需先补题）；2=用法错误。
 */
import { join } from 'node:path';
import { ROOT, UsageError, isMain, parseArgs, readPositiveInt, rel, writeTextAtomic } from './jd/lib.mjs';
import { loadShared } from './kb/kit.mjs';
import { BANK_DIR, isExecutable, loadQuestions, statsByCategory } from './bank/kit.mjs';

const CURRICULUM_DIR = join(ROOT, 'content', 'curriculum');

function monthLength(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayList(month, count) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let d = 1; d <= count; d++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return out;
}

/** Hamilton（最大余数）配额：slots 个位置按 weights 分配，权重>0 的类别至少拿 1 个。 */
export function allocate(weights, slots, { pick } = {}) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const quota = {};
  if (total === 0 || slots <= 0) return quota;
  const remainders = [];
  let used = 0;
  for (const [key, w] of entries) {
    const exact = (slots * w) / total;
    quota[key] = Math.floor(exact);
    used += quota[key];
    remainders.push({ key, frac: exact - Math.floor(exact), w });
  }
  remainders.sort((a, b) => b.frac - a.frac || b.w - a.w || a.key.localeCompare(b.key));
  let i = 0;
  while (used < slots) {
    quota[remainders[i % remainders.length].key] += 1;
    used += 1;
    i += 1;
  }
  for (const { key } of remainders) {
    if (quota[key] === 0 && used > 0) {
      const donor = Object.entries(quota).sort((a, b) => b[1] - a[1])[0];
      if (donor && donor[1] > 1) {
        quota[donor[0]] -= 1;
        quota[key] = 1;
        used = Object.values(quota).reduce((s, v) => s + v, 0);
      }
    }
  }
  void pick;
  return quota;
}

/** 用 quota 生成长度固定的序列：优先"不与昨天/前天同类别"，其次剩余配额多的先上，最后用确定性抖动兜底。 */
export function spread(quota, length, rand) {
  const remaining = { ...quota };
  const out = [];
  for (let day = 0; day < length; day++) {
    const prev1 = out[out.length - 1];
    const prev2 = out[out.length - 2];
    const keys = Object.entries(remaining).filter(([, n]) => n > 0);
    if (keys.length === 0) break;
    const scored = keys.map(([k, n]) => ({
      k,
      n,
      penalty: (k === prev1 ? 2 : 0) + (k === prev2 ? 1 : 0),
      jitter: rand(),
    }));
    scored.sort((a, b) => a.penalty - b.penalty || b.n - a.n || a.jitter - b.jitter || a.k.localeCompare(b.k));
    out.push(scored[0].k);
    remaining[scored[0].k] -= 1;
  }
  while (out.length < length) {
    // 配额用尽但还有天：按原始配额比例重复出现（配额最大的类别兜底），保证天数正确
    const fallback = Object.entries(quota).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!fallback) break;
    out.push(fallback);
    quota[fallback] += 1; // 防止下面同类别无限优先（等价于"该类再多一天"）
  }
  return out;
}

export function buildCurriculum({ questions, shared, month, days, minCodeForMain, relax, seed = 'arena-curriculum' }) {
  const stats = statsByCategory(questions);
  const categories = [...shared.CATEGORY_IDS];
  const perCategory = {};
  for (const category of categories) {
    const s = stats.get(category);
    const catQuestions = questions.filter((q) => q.category === category);
    const solvableCode = catQuestions.filter((q) => isExecutable(q.judgeKind) && q.runner?.referenceSolution);
    const rubric = catQuestions.filter((q) => !isExecutable(q.judgeKind));
    perCategory[category] = {
      total: s?.total ?? 0,
      solvableCode: solvableCode.length,
      rubric: rubric.length,
      code: s?.code ?? 0,
      kinds: s?.kinds ?? {},
      mainEligible: solvableCode.length >= minCodeForMain,
      sideEligible: rubric.length >= 1,
    };
  }

  const mains = categories.filter((c) => perCategory[c].mainEligible);
  let relaxed = false;
  let mainPool = mains;
  if (mainPool.length === 0) {
    relaxed = true;
    const ranked = [...categories]
      .filter((c) => perCategory[c].solvableCode > 0)
      .sort((a, b) => perCategory[b].solvableCode - perCategory[a].solvableCode);
    mainPool = relax || ranked.length > 0 ? ranked.slice(0, 3) : [];
  }
  const sidePool = categories.filter((c) => perCategory[c].sideEligible);

  const mainWeights = Object.fromEntries(mainPool.map((c) => [c, perCategory[c].solvableCode]));
  const sideWeights = Object.fromEntries(sidePool.map((c) => [c, perCategory[c].rubric]));
  const mainQuota = allocate(mainWeights, days);
  const sideQuota = allocate(sideWeights, days);

  const rand = shared.mulberry32(shared.hashSeed(`${seed}|${month}`));
  const mainSeq = spread(mainQuota, days, rand);
  const sideSeq = spread(sideQuota, days, rand);

  const dates = dayList(month, days);
  const dayRows = [];
  for (let i = 0; i < days; i++) {
    const date = dates[i];
    let main = mainSeq[i];
    let side = sideSeq[i];
    if (main === side) {
      const alt = sideSeq.find((c, j) => j !== i && c !== main) ?? sidePool.find((c) => c !== main);
      if (alt) side = alt;
      else side = main; // 只剩一个类别有主观题，副栈同主栈（会在 warnings 里点名）
    }
    const mainPicks = main ? shared.pickForDay(questions, date, main, 2).map((q) => q.id) : [];
    const sidePicks = side ? shared.pickForDay(questions, date, side, 1).map((q) => q.id) : [];
    const minutes = [...mainPicks, ...sidePicks].reduce((sum, id) => {
      const q = questions.find((item) => item.id === id);
      return sum + (q?.estimatedMinutes ?? 0);
    }, 0);
    dayRows.push({
      date,
      main: main ?? null,
      side: side ?? null,
      mainPicks,
      sidePicks,
      minutes,
      mainShortfall: main ? 2 - mainPicks.length : 2,
      sideShortfall: side ? 1 - sidePicks.length : 1,
    });
  }

  const mainByCategory = {};
  const sideByCategory = {};
  for (const row of dayRows) {
    if (row.main) mainByCategory[row.main] = (mainByCategory[row.main] ?? 0) + 1;
    if (row.side) sideByCategory[row.side] = (sideByCategory[row.side] ?? 0) + 1;
  }
  const appeared = new Set([...Object.keys(mainByCategory), ...Object.keys(sideByCategory)]);
  const gaps = categories
    .filter((c) => !appeared.has(c))
    .map((c) => ({
      category: c,
      reason:
        perCategory[c].total === 0
          ? '题库里这 0 题'
          : perCategory[c].solvableCode > 0 && perCategory[c].solvableCode < minCodeForMain
            ? `只有 ${perCategory[c].solvableCode} 道可判分题（主栈资格线 ${minCodeForMain}），也没有主观题`
            : `可判分题 0 且主观题 ${perCategory[c].rubric}（无法排进任何一天）`,
      fix: `npm run bank:refresh -- --categories ${c} --n 4`,
    }));

  const warnings = [];
  if (relaxed) {
    warnings.push(
      `没有任何类别达到主栈资格线（可判分代码题 ≥${minCodeForMain}）。` +
        (mainPool.length > 0 ? `本轮退而使用 ${mainPool.join(' / ')} 作主栈；` : '本轮没有主栈可排；') +
        `先跑 npm run bank:refresh -- --categories ${categories.filter((c) => perCategory[c].solvableCode < minCodeForMain).join(',')} 补题`,
    );
  }
  if (sidePool.length < 2) {
    warnings.push(
      `有主观题的类别只有 ${sidePool.length ? sidePool.join(', ') : '(无)'} —— 副栈可能和主栈同类别，起不到换脑作用。补题：npm run bank:refresh -- --categories system-design,agent-design,hot-interviews`,
    );
  }
  const shortfallDays = dayRows.filter((r) => r.mainShortfall > 0 || r.sideShortfall > 0);
  if (shortfallDays.length > 0) {
    warnings.push(`${shortfallDays.length} 天的题目不足定额（主 2 + 副 1），例如 ${shortfallDays.slice(0, 3).map((r) => `${r.date}:${r.main ?? '-'}/${r.side ?? '-'}`).join(' ')} —— pickForDay 拿不出那么多题`);
  }

  return {
    version: 1,
    month,
    generatedAt: new Date().toISOString(),
    policy: {
      days,
      mainCodeQuota: 2,
      sideRubricQuota: 1,
      minCodeForMain,
      relaxed,
      pickAlgorithm: '@arena/shared pickForDay(date|category 确定性洗牌)',
      weighting: '主栈按可判分代码题数、副栈按主观题数做最大余数分配',
    },
    bankSnapshot: perCategory,
    weights: { main: mainWeights, side: sideWeights },
    days: dayRows,
    stats: {
      mainByCategory,
      sideByCategory,
      daysWithFullMain: dayRows.filter((r) => r.mainShortfall === 0).length,
      daysWithSide: dayRows.filter((r) => r.sideShortfall === 0).length,
      coveredCategories: [...appeared].sort(),
      uncoveredCategories: gaps.map((g) => g.category),
      totalMinutes: dayRows.reduce((s2, r) => s2 + r.minutes, 0),
    },
    gaps,
    warnings,
  };
}

function printReport(plan) {
  console.log(`\n每日排课（${plan.days.length} 天，${plan.month}）`);
  console.log('日期          主栈(2 代码题)                 副栈(1 主观题)             题量/分钟');
  for (const row of plan.days) {
    const mainIds = row.mainPicks.length ? row.mainPicks.join(',') : '(无题)';
    const sideIds = row.sidePicks.length ? row.sidePicks[0] : '(无题)';
    console.log(
      `${row.date}  ${(row.main ?? '-').padEnd(15)}${mainIds.padEnd(28)} ${(row.side ?? '-').padEnd(15)}${sideIds.padEnd(26)} ${row.minutes}min${row.mainShortfall ? ` ⚠主缺${row.mainShortfall}` : ''}${row.sideShortfall ? ' ⚠副缺' : ''}`,
    );
  }
  console.log('\n类别轮转统计（天数 / 该类别现有题数 / 可判分代码题 / 主观题）：');
  for (const [category, snap] of Object.entries(plan.bankSnapshot)) {
    const mainDays = plan.stats.mainByCategory[category] ?? 0;
    const sideDays = plan.stats.sideByCategory[category] ?? 0;
    console.log(
      `  ${category.padEnd(15)} 主 ${String(mainDays).padStart(2)} 天  副 ${String(sideDays).padStart(2)} 天  共 ${String(mainDays + sideDays).padStart(2)} 天 | 现有 ${snap.total}（代码 ${snap.solvableCode} / 主观 ${snap.rubric}）${snap.mainEligible ? ' 主栈OK' : ''}${snap.sideEligible ? ' 副栈OK' : ''}`,
    );
  }
  console.log(
    `\n覆盖：${plan.stats.coveredCategories.length}/7 类｜满额主栈天数 ${plan.stats.daysWithFullMain}/${plan.days.length}` +
      `｜有副栈天数 ${plan.stats.daysWithSide}/${plan.days.length}｜总预计用时 ${(plan.stats.totalMinutes / 60).toFixed(1)} 小时`,
  );
  if (plan.stats.uncoveredCategories.length > 0) {
    console.error(`\n✗ 这些类别排不进 30 天：${plan.stats.uncoveredCategories.join(', ')}`);
    for (const gap of plan.gaps) console.error(`  - ${gap.category}：${gap.reason}｜修复：${gap.fix}`);
  }
  for (const w of plan.warnings) console.warn(`⚠ ${w}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { booleans: ['relax', 'help'] });
    if (args.help) {
      console.log('用法：node scripts/curriculum.mjs [--month YYYY-MM] [--days N] [--min-code N] [--relax] [--out <file>]');
      return;
    }
  } catch (err) {
    console.error(`${err.message}\n用法：node scripts/curriculum.mjs [--month YYYY-MM] [--days N] [--min-code N] [--relax]`);
    process.exit(2);
    return;
  }
  try {
    const shared = await loadShared();
    const month = String(args.month ?? '2026-10');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new UsageError(`--month 需要 YYYY-MM，收到 "${month}"`);
    const [, m] = month.split('-').map(Number);
    if (m < 1 || m > 12) throw new UsageError(`--month 的月份非法：${month}`);
    const days = args.days === undefined ? Math.min(30, monthLength(month)) : readPositiveInt(args.days, '--days', 30);
    if (days > 92) throw new UsageError(`--days=${days} 太大（最多 92）`);
    const minCode = readPositiveInt(args['min-code'], '--min-code', 6);
    const { questions, errors, hiddenIds } = await loadQuestions(BANK_DIR);
    if (errors.length > 0) {
      console.warn(`⚠ 题库有 ${errors.length} 个坏文件被跳过（先跑 npm run bank:check 修掉，否则排出来的题可能少）：`);
      for (const err of errors.slice(0, 5)) console.warn(`    - ${rel(err.file)}：${err.message}`);
    }
    const visible = questions.filter((q) => !hiddenIds.has(q.id));
    if (visible.length === 0) {
      throw new UsageError(`content/questions 里没有可排的题目（可见题 0）。先跑 npm run bank:refresh 补题。`);
    }
    console.log(
      `读题库：${questions.length} 题（可见 ${visible.length}，软删除 ${hiddenIds.size}）；` +
        `可判分代码题 ${visible.filter((q) => isExecutable(q.judgeKind) && q.runner?.referenceSolution).length}，主观题 ${visible.filter((q) => !isExecutable(q.judgeKind)).length}`,
    );
    const plan = buildCurriculum({
      questions: visible,
      shared,
      month,
      days,
      minCodeForMain: minCode,
      relax: Boolean(args.relax),
    });
    const out = args.out
      ? args.out.startsWith('/') || /^[A-Za-z]:[\\/]/.test(args.out)
        ? args.out
        : join(ROOT, args.out)
      : join(CURRICULUM_DIR, `${month}.json`);
    await writeTextAtomic(out, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`排课已生成 → ${rel(out)}（${plan.days.length} 天，每天主栈 2 代码题 + 副栈 1 主观题）`);
    printReport(plan);
    if (plan.stats.uncoveredCategories.length > 0) {
      console.error(`\n文件已写出，但覆盖不完整；补齐后重跑本命令即可（本脚本不修改题库）。`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
      return;
    }
    console.error(`✗ 排课失败：${err?.stack ?? err}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
