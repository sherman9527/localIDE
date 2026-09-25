#!/usr/bin/env node
/**
 * 手写题的正式入库入口（`npm run bank:add -- <文件或目录> [...]`）。
 *
 *   npm run bank:add -- drafts/my-question.json          # 单题（或一个数组）
 *   npm run bank:add -- drafts/ --dry-run                # 整目录试跑，一题都不写
 *   npm run bank:add -- q.json --no-check                # 只入库，不接着跑题库闸门
 *
 * 为什么要有这个脚本：`bank:refresh` 只服务"让 CLI 生成题目"那条路，手写一道题的人
 * 只能自己拼 JSON、自己知道该跑哪些闸门 —— 漏跑一次就把不合规的题留在库里。
 * 这里把顺序钉死：**校验与落盘只走服务端那个 append-only 的 ingest()**（不另写一套规则，
 * 否则两边规则一定会漂移），入库后自动跑 `bank:check`，代码题再提醒"参考解要在容器里判"。
 *
 * 退出码：0=全部入库成功；1=有草稿被拒或有文件读不出来；2=用法错误。
 * 任何情况下都不会覆盖或删除已有题目（ingest 是唯一写入口，写文件用 wx 标志）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, UsageError, isMain, parseArgs, rel } from '../jd/lib.mjs';
import { BANK_DIR } from './kit.mjs';

const USAGE = [
  '用法：npm run bank:add -- <题目.json|目录> [...] [选项]',
  '  --dry-run        与真实入库走同一段代码（写进临时副本），只报告结果，不动 content/questions',
  '  --bank-dir DIR   写到指定题库目录（默认 content/questions；测试与演练用）',
  '  --no-check       入库后不自动跑 npm run bank:check',
  '  --help           看这份用法',
].join('\n');

const DIST_INGEST = join(ROOT, 'server', 'dist', 'bank', 'ingest.js');

/** 一个 JSON 文件 → 草稿数组。接受单题、数组、或 `{ questions: [...] }` 三种写法。 */
function draftsFrom(payload) {
  if (Array.isArray(payload)) return payload.map(stripIngestFields);
  if (payload && typeof payload === 'object' && Array.isArray(payload.questions)) return payload.questions.map(stripIngestFields);
  if (payload && typeof payload === 'object') return [stripIngestFields(payload)];
  throw new UsageError('题目 JSON 要是一句话题对象、对象数组，或 { questions: [...] }');
}

/**
 * `source.ingestedAt` 是写入口自己盖的时间戳，草稿不允许带它（SourceDraft 是 strict 的）。
 * 不抹掉的话，"把 content/questions 里已有的题再喂一次"会报一条看不懂的 schema 错，
 * 而不是它真正该说的话：库里已有同 id，跳过。
 */
function stripIngestFields(draft) {
  if (!draft || typeof draft !== 'object' || !draft.source || draft.source.ingestedAt === undefined) return draft;
  const { ingestedAt: _ingestedAt, ...source } = draft.source;
  return { ...draft, source };
}

function jsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

/** 收集输入：坏文件只作废它自己，不拖垮整批（一箱草稿里一个手滑不该让其余九题白写）。 */
function collectInputs(paths) {
  const drafts = [];
  const fileErrors = [];
  for (const input of paths) {
    const abs = resolve(ROOT, input);
    if (!existsSync(abs)) throw new UsageError(`输入不存在：${rel(abs)}\n${USAGE}`);
    const files = statSync(abs).isDirectory() ? jsonFiles(abs) : [abs];
    if (files.length === 0) fileErrors.push({ file: rel(abs), reason: '目录里没有任何 .json' });
    for (const file of files) {
      try {
        const items = draftsFrom(JSON.parse(readFileSync(file, 'utf8')));
        items.forEach((draft, index) => {
          drafts.push({ ...draft, __from: `${rel(file)}${items.length > 1 ? `#${index + 1}` : ''}` });
        });
      } catch (err) {
        fileErrors.push({ file: rel(file), reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { drafts, fileErrors };
}

function copyBank(from, to) {
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyBank(src, dst);
    else if (entry.name.endsWith('.json')) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

async function loadIngest() {
  if (!existsSync(DIST_INGEST)) {
    throw new UsageError(
      `找不到题库唯一写入口 ${rel(DIST_INGEST)}。先跑 npm run build -w server（bank:add 故意不自己实现一套校验，` +
        '否则脚本与服务的规则一定会漂移）。',
    );
  }
  const mod = await import(pathToFileURL(DIST_INGEST).href);
  if (typeof mod.ingest !== 'function') throw new UsageError(`${rel(DIST_INGEST)} 没有导出 ingest()，重跑 npm run build -w server`);
  return mod;
}

export async function runAdd(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs, { booleans: ['dry-run', 'no-check', 'help'] });
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args._.length === 0) throw new UsageError(`至少要给一个题目文件或目录\n${USAGE}`);

  const bankDir = resolve(ROOT, String(args['bank-dir'] ?? BANK_DIR));
  const dryRun = Boolean(args['dry-run']);
  const { drafts, fileErrors } = collectInputs(args._);
  const origins = drafts.map((d) => d.__from);
  const clean = drafts.map(({ __from, ...rest }) => rest);

  console.log(`读到 ${clean.length} 份草稿（${fileErrors.length} 个文件读不出来）；目标题库：${rel(bankDir)}${dryRun ? '（--dry-run：写进临时副本）' : ''}`);
  for (const bad of fileErrors) console.log(`  ✗ ${bad.file}：${bad.reason}`);
  if (clean.length === 0) {
    console.error('✗ 没有任何可入库的草稿');
    return 1;
  }

  const mod = await loadIngest();
  const scratch = dryRun ? join(ROOT, 'data', 'test-tmp', `bank-add-dry-${Date.now()}`) : bankDir;
  let report;
  try {
    if (dryRun) copyBank(bankDir, scratch);
    report = await mod.ingest(clean, { dir: scratch });
  } finally {
    if (dryRun) rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n入库报告：新增 ${report.added.length}、跳过 ${report.skippedDuplicate.length}、拒绝 ${report.rejected.length}`);
  for (const item of report.added) console.log(`  ✓ ${item.id} → ${rel(item.file)}`);
  for (const item of report.skippedDuplicate) {
    // duplicate-id 时 existingId 就是它自己，再念一遍只是噪音；题面撞车才需要指出撞了谁
    const note = item.reason === 'duplicate-id' ? '库里已有同 id（不覆盖）' : `题面与已有题等价（撞上 ${item.existingId}）`;
    console.log(`  ⏭ 跳过 ${item.id}：${note}`);
  }
  for (const item of report.rejected) {
    const from = origins[item.index] ? `（来自 ${origins[item.index]}）` : '';
    console.log(`  ✗ 拒绝 ${item.id ?? `草稿 #${item.index + 1}`}${from}：${item.errors.join('; ')}`);
  }

  const codeQuestions = clean.filter((d) => d.judgeKind && d.judgeKind !== 'llm-rubric');
  if (codeQuestions.length > 0 && report.added.length > 0) {
    console.log(
      `\n⚠ 这批里有代码题：参考解与朴素解必须**在容器里真判一遍**才算数（宿主机没有 JDK/MySQL/Spark）。\n` +
        '   跑：./start.sh --verify（或容器内 npm run verify，判题矩阵必须报 0 skipped）',
    );
  }
  if (dryRun) console.log('\n（--dry-run：真实题库一个字节都没动）');

  if (!dryRun && report.added.length > 0 && !args['no-check']) {
    console.log('\n跑题库闸门 npm run bank:check …');
    const check = spawnSync('npm', ['run', 'bank:check'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (check.status !== 0) {
      console.error('✗ 题目已落盘但没通过题库闸门 —— 按报告改文件后重跑（已入库的题不会被覆盖，需要人工修正或删除该新文件）。');
      return check.status ?? 1;
    }
  }

  if (report.rejected.length > 0 || fileErrors.length > 0) {
    console.error(`\n✗ ${report.rejected.length + fileErrors.length} 个条目没能入库`);
    return 1;
  }
  if (!dryRun) console.log(`\n✓ 完成。下一步：npm run kb:index && node scripts/curriculum.mjs`);
  return 0;
}

async function main() {
  try {
    process.exitCode = await runAdd();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`✗ 入库中断：${err?.stack ?? err}`);
      console.error('  已有题目不受影响（ingest 是唯一写入口，且 append-only）。');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) void main();
