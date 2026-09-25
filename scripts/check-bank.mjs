/**
 * 题库闸门入口（`npm run bank:check`，加 `--full` 打开覆盖度闸门）。
 * 真正的断言在 server/test/bank/content.test.ts —— 用 vitest 当断言引擎，
 * 免得 scripts/ 里再写一份 zod 校验导致两边规则漂移。
 * 这里额外只做一件事：题库总数不得比基线少（需求 场景 9 的"只增不减"）——
 * 基线取 git 已跟踪的题目数（换机器/新 clone 也不会丢），.bank-count 只作辅助。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const counterFile = join(root, '.bank-count');
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
 * 基线用 git 已跟踪的题目数，而不是 .bank-count 这种"本机才有的状态文件"：
 * 后者没进版本库，换台机器/新 clone 就归零，于是"只增不减"这条断言实际上是死的。
 */
function trackedQuestions() {
  const r = spawnSync('git', ['ls-files', '--', 'content/questions'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((line) => line.endsWith('.json') && !NON_QUESTION_FILES.has(basename(line)))
    .length;
}

const total = countQuestions(join(root, 'content', 'questions'));
const previous = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8').trim() || 0) : 0;
const baseline = trackedQuestions();

for (const [label, count] of [['git 已跟踪', baseline], ['.bank-count 记录', previous]]) {
  if (count === null || count === 0) continue;
  if (total < count) {
    console.error(
      `✗ 题库从 ${count}（${label}）减少到 ${total} 题，违反"只增不减"（需求 场景 9）。已删除的题目请恢复；确需减少请按 rule.md 走人工确认。`,
    );
    process.exit(1);
  }
}

if (process.argv.includes('--count-only')) {
  console.log(`✓ 题库 ${total} 题，未少于基线（git 跟踪 ${baseline ?? '?'} / .bank-count ${previous}）`);
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
