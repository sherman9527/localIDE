#!/usr/bin/env node
/**
 * 日志查看器（需求：出故障要能 trace）。
 *   npm run logs                                   最近 50 条
 *   npm run logs -- --trace judge-1a2b3c4d         按追踪号捞整条链路
 *   npm run logs -- --q sql-mysql-0001 --level warn,error
 *   npm run logs -- --module judge --tail 200
 *   npm run logs -- --since 30m | 6h | 2d
 *   npm run logs -- --purge                        立刻按 28 天保留期清理
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'data', 'logs');
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const has = (name) => args.includes(`--${name}`);
const trace = flag('trace');
const question = flag('q');
const module_ = flag('module');
const levels = flag('level')?.split(',').filter(Boolean);
const since = flag('since');
const tailN = Number(flag('tail') ?? 50);
const raw = has('raw');

function sinceMs(text) {
  if (!text) return 0;
  const m = /^(\d+)([smhd])$/.exec(text);
  if (!m) throw new Error(`--since 只接受 30s/10m/6h/2d 这种形式，收到 "${text}"`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Date.now() - Number(m[1]) * unit;
}

function files() {
  try {
    return readdirSync(ROOT)
      .filter((name) => name.startsWith('arena-') && name.endsWith('.log'))
      .sort();
  } catch {
    return [];
  }
}

if (has('purge')) {
  // 与 server/src/log.ts 同口径：坏值不许把"最多存 28 天"悄悄关掉
  const requested = Number(flag('days') ?? process.env.ARENA_LOG_RETENTION_DAYS ?? 28);
  const days = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 28;
  const cutoff = Date.now() - days * 86_400_000;
  const removed = [];
  for (const name of files()) {
    const full = join(ROOT, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      removed.push(name);
    }
  }
  console.log(`保留期 ${days} 天：删除 ${removed.length} 个文件${removed.length ? `（${removed.join(', ')}）` : ''}`);
  process.exit(0);
}

const cutoff = sinceMs(since);
const lines = [];
for (const name of files()) {
  for (const line of readFileSync(join(ROOT, name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      lines.push({ event: 'unparseable', msg: line.slice(0, 200), file: name });
      continue;
    }
    if (cutoff && Date.parse(record.time ?? '') < cutoff) continue;
    if (trace && record.traceId !== trace) continue;
    if (question && record.questionId !== question) continue;
    if (module_ && record.module !== module_) continue;
    if (levels?.length && !levels.includes(record.level)) continue;
    lines.push(record);
  }
}

const picked = lines.slice(-tailN);
if (raw) {
  for (const r of picked) console.log(JSON.stringify(r));
} else {
  for (const r of picked) {
    const extras = Object.entries(r)
      .filter(([k]) => !['time', 'level', 'module', 'event', 'traceId', 'msg'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.log(`${(r.time ?? '').slice(11, 23)} ${String(r.level ?? 'info').padEnd(5)} ${r.module ?? '-'} ${r.event ?? '-'} ${r.traceId ? `[${r.traceId}]` : ''} ${r.msg ?? ''} ${extras}`.trimEnd());
  }
}
console.log(`\n共 ${lines.length} 条匹配，显示最后 ${picked.length} 条${trace ? `（trace=${trace}）` : ''}`);
if (lines.length === 0) {
  console.log(`日志目录：${ROOT}（还没有日志？先跑 ./start.sh 并在页面上操作一遍）`);
}
