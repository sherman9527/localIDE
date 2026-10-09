#!/usr/bin/env node
/**
 * 断言"这一阶段真的执行了测试"。
 * 判题套件在栈不可用时会整片 it.skip，vitest 照样 exit 0 —— 于是宿主机上一次都没真判过题的
 * "全绿"会被当成通过（memo.md 记过这个坑）。用 vitest 的 json reporter 产物把这件事挑明。
 *
 *   npx vitest run server/test/judge --reporter=json --outputFile=data/verify-judge.json
 *   node scripts/assert-ran.mjs data/verify-judge.json 判题矩阵
 *
 * `--require-no-skips`（WI-90 Task 5）：把判据从"至少跑到过一条"收紧成"**一条都不许跳**"。
 * 为什么要它：矩阵那一档整片 skip 是"一条都没跑"，而**教程那一档不是** —— `tutorials.test.ts` 里
 * 常驻那一组（清单完整性 / 注册表形状 / marker 字面量…）在任何机器都跑，所以"容器那一组整片被跳掉"
 * 时报出来的是 `10 passed / 4 skipped / 14 total`，`total - skipped === 0` 那一支根本不会触发 ⇒
 * 只接默认判据的闸门对新那一档是**装饰**。要拦的坏法是"容器那一组整片被跳掉"（条件写反、
 * `describe.skipIf` 的合取被改坏、`process.env` 的变量名写错），不是"跑得太慢"。
 * 只给"这一档没有任何合法 skip"的阶段用：教程档由「那个跑着 notebook 服务的容器」独占（门控是合取、
 * 两个变量都在命令行上显式设过），在那里跳掉一条就是门控漂了，不是"环境不允许"。
 * ⚠ 它判的是**"有没有真的执行"**，不是"门控写得对不对"：把 `const IN_CONTAINER` 改名成 camelCase 而
 * `process.env.X` 读的还是对的变量 ⇒ 容器那一组照跑、这一条不红（那是 `gateVars()` 的盲区，
 * 由 `tutorials.test.ts` 顶部"大小写是承重的"那段记着账）。它拦得住的是"整片被跳掉"那几种形状：
 * 条件写反、`process.env` 的名字一起被改错、`describe.skipIf` 被换成恒真。
 *
 *   node scripts/assert-ran.mjs data/verify-tutorials.json "教程 notebook" --require-no-skips
 */
import { readFileSync } from 'node:fs';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const noSkips = process.argv.includes('--require-no-skips');
const [file, label = '该阶段'] = positional;
if (!file) {
  console.error('用法：node scripts/assert-ran.mjs <vitest-json> [阶段名] [--require-no-skips]');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`${label}：读不到 vitest 报告 ${file}（${err.message}）`);
  process.exit(1);
}

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const skipped = report.numPendingTests ?? 0;
const failed = report.numFailedTests ?? 0;

if (failed > 0) {
  console.error(`${label}：${failed} 条失败`);
  // json reporter 的 message 里带断言差异，直接打出来，省得再人肉复跑一遍
  for (const suite of report.testResults ?? []) {
    for (const t of suite.assertionResults ?? []) {
      if (t.status === 'failed') console.error(`  ✗ ${t.fullName ?? t.title}\n    ${(t.messages ?? []).join('\n    ').slice(0, 600)}`);
    }
  }
  process.exit(1);
}
if (total - skipped === 0) {
  console.error(
    `${label}：一条都没执行（total=${total}, skipped=${skipped}）。` +
      '多半是判题栈不可用被整片 skip —— 请在容器里跑：./start.sh --verify，或显式 SKIP_JUDGE=1 说明你知道这件事。',
  );
  process.exit(1);
}
if (noSkips && skipped > 0) {
  const names = [];
  for (const suite of report.testResults ?? []) {
    for (const t of suite.assertionResults ?? []) {
      if (t.status !== 'passed' && t.status !== 'failed') names.push(t.fullName ?? t.title);
    }
  }
  console.error(
    `${label}：--require-no-skips —— 有 ${skipped} 条被跳过（total=${total}）：${names.slice(0, 12).join(' | ')}` +
      (names.length > 12 ? ` …（共 ${names.length} 条）` : '') +
      '\n这一档不许有合法跳过：它只在"那个跑着对应栈/服务的容器"里跑，门控的两个变量都写在阶段命令行上。' +
      '\n跳了一条就是门控漂了（条件写反、`describe.skipIf` 的合取被改坏、`process.env.X` 的名字被改错' +
      ' —— 连同标识符一起改成 camelCase 时常常顺手错到这里，那时 `verify-coverage.test.ts` 的 `gateVars()`' +
      ' 也解不出变量名，env 那条判据会一起静默退出）。' +
      '\n改的是**门控与被测物**，不是把这一条判据摘掉。',
  );
  process.exit(1);
}
console.log(`${label}：${passed} passed / ${skipped} skipped / ${total} total ✓`);
