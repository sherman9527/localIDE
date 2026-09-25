#!/usr/bin/env node
/**
 * 前端产物预算（WI-28）。
 * 拆包是一次性的，"以后又被拖回首屏"是持续的 —— 所以这里钉死三件事：
 *   1) 首屏必须只有 1 个 JS + 1 个 CSS，且 gzip 不超过预算；
 *   2) zod 与 CodeMirror 不许出现在首屏那份 JS 里（它们各自 13KB/248KB gzip，是历史上进过首屏的常客）；
 *   3) 判题页那份 chunk 必须**确实**带着 CodeMirror —— 否则说明切分假了，而不是变好了。
 * 先跑 npm run build -w web（脚本不替你构建，避免"校验的却是旧 dist"）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'web', 'dist');
const ASSETS = join(DIST, 'assets');

/** 首屏 JS 的 gzip 预算（当前实测 ~77KB：react-dom + 应用代码 + shared 常量）。 */
const ENTRY_GZIP_BUDGET = 86_000;
/** 只要这些串出现在首屏 JS，就说明对应的重依赖没被切出去。 */
const FORBIDDEN_IN_ENTRY = {
  ZodError: 'zod（shared 的 schema 不该被浏览器端拉进来）',
  'cm-editor': 'CodeMirror（判题页才需要）',
};

const fail = (msg) => {
  console.error(`\n✗ 产物预算未通过：${msg}`);
  process.exitCode = 1;
};

if (!existsSync(join(DIST, 'index.html'))) {
  fail('web/dist 不存在 —— 先跑 npm run build -w web');
  process.exit(1);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const eagerJs = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
const eagerCss = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);

const sizeOf = (href) => {
  const file = join(DIST, href.replace(/^\//, ''));
  const buf = readFileSync(file);
  return { name: href.split('/').pop(), raw: buf.length, gzip: gzipSync(buf).length, text: buf.toString('utf8') };
};

const chunks = readdirSync(ASSETS)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ ...sizeOf(`/assets/${f}`), name: f }));
const byName = new Map(chunks.map((c) => [c.name, c]));

const entry = eagerJs.map((h) => byName.get(h.split('/').pop())).filter(Boolean);
if (entry.length !== 1) fail(`首屏应当只有 1 个 JS，实际 ${entry.length} 个：${JSON.stringify(eagerJs)}`);
// 文档承诺的是"1 个 JS + 1 个 CSS"，那 CSS 这一半也得断：懒加载组件里 import css
// 会让首屏多带一份样式表（多一次阻塞请求），而没人会去看打印出来的那行。
if (eagerCss.length !== 1) fail(`首屏应当只有 1 个 CSS，实际 ${eagerCss.length} 个：${JSON.stringify(eagerCss)}`);
if (preloads.length > 0) fail(`首屏不该有 modulepreload（等于把懒加载又拉回关键路径）：${JSON.stringify(preloads)}`);

let entryGzip = 0;
for (const chunk of entry) {
  entryGzip += chunk.gzip;
  console.log(`首屏 ${chunk.name}  ${(chunk.raw / 1024).toFixed(1)}KB → gzip ${(chunk.gzip / 1024).toFixed(1)}KB`);
  for (const [marker, what] of Object.entries(FORBIDDEN_IN_ENTRY)) {
    if (chunk.text.includes(marker)) fail(`${chunk.name} 里有 "${marker}" —— ${what}`);
  }
  // 预算只对生产产物有意义：dev 版 react-dom 自己就多 60KB gzip
  if (chunk.text.includes('Download the React DevTools')) {
    fail(`${chunk.name} 打进了 dev 版 React —— 构建时 NODE_ENV 不是 production，这次预算不作数`);
  }
}
if (entryGzip > ENTRY_GZIP_BUDGET) {
  fail(`首屏 JS gzip ${(entryGzip / 1024).toFixed(1)}KB 超预算 ${(ENTRY_GZIP_BUDGET / 1024).toFixed(1)}KB`);
}
console.log(`首屏合计 JS gzip ${(entryGzip / 1024).toFixed(1)}KB（预算 ${(ENTRY_GZIP_BUDGET / 1024).toFixed(0)}KB）` +
  `，CSS ${eagerCss.map((c) => `${(gzipSync(readFileSync(join(DIST, c.replace(/^\//, '')))).length / 1024).toFixed(1)}KB`).join(' ') || '无'}`);

const lazy = chunks.filter((c) => !entry.includes(c));
const carrier = lazy.find((c) => c.text.includes('cm-editor'));
if (!carrier) {
  fail('没有任何**懒加载** chunk 带 CodeMirror —— 判题页的切分没生效（要么丢了 lazy()，要么又被静态 import 拉回首屏）');
}

console.log('\n按需加载的部分：');
for (const chunk of lazy.sort((a, b) => b.gzip - a.gzip)) {
  console.log(`  ${chunk.name.padEnd(28)} gzip ${(chunk.gzip / 1024).toFixed(1).padStart(6)}KB`);
}

if (!process.exitCode) console.log('\n✓ 产物预算通过');
else console.log('\n（修不好就在 memo.md 记一笔为什么放宽预算，别直接把阈值改掉）');
