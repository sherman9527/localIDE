#!/usr/bin/env node
/**
 * 断言"这一阶段真的执行了测试"。
 * 判题套件在栈不可用时会整片 it.skip，vitest 照样 exit 0 —— 于是宿主机上一次都没真判过题的
 * "全绿"会被当成通过（memo.md 记过这个坑）。用 vitest 的 json reporter 产物把这件事挑明。
 *
 *   npx vitest run server/test/judge --reporter=json --outputFile=data/verify-judge.json
 *   node scripts/assert-ran.mjs data/verify-judge.json 判题矩阵
 */
import { readFileSync } from 'node:fs';

const [file, label = '该阶段'] = process.argv.slice(2);
if (!file) {
  console.error('用法：node scripts/assert-ran.mjs <vitest-json> [阶段名]');
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
console.log(`${label}：${passed} passed / ${skipped} skipped / ${total} total ✓`);
