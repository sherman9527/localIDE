/**
 * 题库闸门入口（`npm run bank:check`，加 `--full` 打开覆盖度闸门）。
 * 真正的断言在 server/test/bank/content.test.ts —— 用 vitest 当断言引擎，
 * 免得 scripts/ 里再写一份 zod 校验导致两边规则漂移。
 * 这里额外只做一件事：题库总数不得比基线少（需求 场景 9 / 硬约束 C5 的"只增不减"）——
 * 基线三选一：git 已跟踪数 → 镜像烤入的 /opt/arena-bank-baseline.txt → 本机 .bank-count；
 * **三路都没有就响亮失败**，不许退成 0（N-18：上一版退成 0，于是交付档里这条一直是空的）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = process.env.ARENA_BANK_ROOT ? resolve(process.env.ARENA_BANK_ROOT) : resolve(import.meta.dirname, '..');
const counterFile = process.env.ARENA_BANK_COUNTER_FILE ? resolve(process.env.ARENA_BANK_COUNTER_FILE) : join(root, '.bank-count');
/**
 * 镜像里烤入的基线清单（N-18 的治法，见 resolveBaseline 第②路）。默认路径由 docker/Dockerfile 在
 * `COPY . .` 之后生成；判据用 ARENA_BANK_BASELINE_FILE 指到临时文件，不需要往 /opt 写东西。
 */
const imageBaselineFile = process.env.ARENA_BANK_BASELINE_FILE ?? '/opt/arena-bank-baseline.txt';
const fullGate = process.argv.includes('--full');

const NON_QUESTION_FILES = new Set(['hidden.json', 'package.json', 'schema.json']);

function countQuestions(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countQuestions(full);
    else if (entry.name.endsWith('.json') && !NON_QUESTION_FILES.has(entry.name)) count += 1;
  }
  return count;
}

/**
 * git 已跟踪的题目数（宿主上这是最新的真相）。容器里 `.dockerignore` 排掉了 `.git` ⇒ 直接返回 null，
 * 由 resolveBaseline 往下走第②路 —— 上一版在这里退回 `.bank-count`，而那个文件是 gitignored 的，
 * 于是"只增不减"在交付档里悄悄变成 baseline=0（N-18）。
 */
function trackedQuestions() {
  const r = spawnSync('git', ['ls-files', '--', 'content/questions'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((line) => line.endsWith('.json') && !NON_QUESTION_FILES.has(basename(line)))
    .length;
}

/**
 * 三路基线，取第一个可用读数（N-18 的治法；顺序与理由写在这里，别只看函数名）：
 * ① **git 跟踪数** —— 宿主上它是最新的真相；
 * ② **镜像烤入的清单** —— 容器里既没有 `.git` 也没有本机状态文件，这条路是交付档唯一用得上的基线。
 *    它是**构建期**那棵 content 树的题数；运行期 content 是 bind-mount ⇒ "比构建时少"这件事照样判得住；
 * ③ `.bank-count` —— gitignored 的本机辅助文件，只在前两路都拿不到时兜底，且用之前会印一行它为什么不可信。
 * 三路全空 ⇒ value=null，由调用方**响亮失败**。把 null 当 0 通过就是 N-18 那个病本身。
 * `ARENA_BANK_SKIP_GIT=1` 是给判据用的缝（在宿主上走出"容器里没有 git"那一支），生产路径不会设它。
 */
function resolveBaseline() {
  const git = process.env.ARENA_BANK_SKIP_GIT === '1' ? null : trackedQuestions();
  let image = null;
  if (existsSync(imageBaselineFile)) {
    const n = Number(readFileSync(imageBaselineFile, 'utf8').trim() || 'NaN');
    image = Number.isFinite(n) ? n : null;
  }
  const counter = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8').trim() || '0') : null;
  const sources = { git, image, counter };
  for (const key of ['git', 'image', 'counter']) {
    const v = sources[key];
    if (typeof v === 'number' && v > 0) return { value: v, source: key, sources };
  }
  return { value: null, source: null, sources };
}

const SOURCE_LABEL = { git: 'git 已跟踪', image: '镜像清单 /opt/arena-bank-baseline.txt', counter: '.bank-count 记录（本机、gitignored）' };

const total = countQuestions(join(root, 'content', 'questions'));
const resolved = resolveBaseline();
const previous = resolved.sources.counter ?? 0;

/** 判据用的读数出口（`server/test/regression/bank-baseline.test.ts` 靠它验三路基线与优先级）。 */
if (process.argv.includes('--baseline-info')) {
  console.log(JSON.stringify({ total, baseline: resolved.value, source: resolved.source, sources: resolved.sources }));
  process.exit(0);
}

if (resolved.value === null) {
  console.error(
    `✗ 没有任何可信基线可判"只增不减"：git 跟踪 / 镜像清单（${imageBaselineFile}）/ .bank-count 三路都拿不到读数。\n` +
      '   这不是噪音 —— 把"没有基线"当 baseline=0 通过，就是 N-18 记录的那个"闸门在容器交付档里空转一个月"。\n' +
      '   该修的是可用性：宿主要在 git 仓库里跑；容器档要用镜像里烤入的 /opt/arena-bank-baseline.txt（见 docker/Dockerfile）。',
  );
  process.exit(1);
}

if (resolved.source === 'counter') {
  console.warn('! 基线取自本机 .bank-count（gitignored，换台机器就归零）—— 只在既没有 git 也没有镜像清单时才允许走到这一路');
}

if (total < resolved.value) {
  console.error(
    `✗ 题库从 ${resolved.value}（${SOURCE_LABEL[resolved.source]}）减少到 ${total} 题，违反"只增不减"（需求 场景 9 / 硬约束 C5）。` +
      '已删除的题目请恢复；确需减少请按 rule.md 走人工确认（移除=软删除写 content/hidden.json）。',
  );
  process.exit(1);
}

if (process.argv.includes('--count-only')) {
  console.log(`✓ 题库 ${total} 题，未少于基线 ${resolved.value}（来源：${resolved.source}；另见 git ${resolved.sources.git ?? '?'} / 镜像 ${resolved.sources.image ?? '?'} / .bank-count ${resolved.sources.counter ?? '?'}）`);
  process.exit(0);
}

const result = spawnSync('npx', ['vitest', 'run', 'server/test/bank/content'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ...(fullGate ? { ARENA_FULL_GATE: '1' } : {}) },
});

if (result.status !== 0) {
  console.error('✗ 题库校验未通过');
  process.exit(result.status ?? 1);
}

writeFileSync(counterFile, `${total}\n`, 'utf8');
console.log(`✓ 题库 ${total} 题通过校验${fullGate ? '（含覆盖度闸门）' : ''}（上次记录 ${previous}）`);
