/**
 * JD 抓取/题库刷新脚本的公共件。
 *
 * 设计约束（来自 rule.md 与需求 9）：
 * - C1 产物不出仓库：所有读写路径都从本仓库根算起。
 * - C5 只增不减：缓存合并只 union，绝不删条目；写文件用原子替换且先断言"不会变少"。
 * - 网络不可靠是常态：任何 adapter 失败都必须留下 fetchFailed 痕迹并继续，绝不抛未捕获异常。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCES_FILE = join(ROOT, 'scripts', 'jd', 'sources.json');

const DEFAULT_CACHE_DIR = join(ROOT, 'content', 'jd-cache');

/** 每个请求的默认策略：20s 超时 + 2 次重试，退避 1s / 3s（需求"失败重试 2 次退避 1s/3s"）。 */
export const HTTP_DEFAULTS = { timeoutMs: 20_000, retries: 2, backoffMs: [1_000, 3_000] };

export function isMain(url) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return url === pathToFileURL(resolve(argv1)).href;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class UsageError extends Error {}

/** 极简 argv 解析：`--flag value` / `--flag=value` / `--bool-flag`。 */
export function parseArgs(argv, { booleans = [], repeatables = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // 裸 `--` 是"后面都不是选项"的约定（`npm run x -- -- foo` 会把它原样传进来）。
    // 不特殊处理的话它会被当成一个名叫空串的选项，顺手把下一个位置参数吃掉当值。
    if (token === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else if (booleans.includes(name)) {
      value = true;
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`缺少 --${name} 的参数值（用 --help 看用法）`);
      }
      i += 1;
    }
    if (repeatables.includes(name)) {
      out[name] = [...(out[name] ?? []), ...String(value).split(/[,\s]+/).filter(Boolean)];
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function readPositiveInt(value, flagName, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(String(value));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flagName} 需要正整数，收到 "${value}"`);
  return n;
}

/** sources.json 是唯一的目标公司/查询配置来源。 */
export async function loadSources(file = SOURCES_FILE) {
  if (!existsSync(file)) {
    throw new UsageError(`找不到配置文件 ${file.slice(ROOT.length + 1)}；需要先创建 scripts/jd/sources.json`);
  }
  const raw = await readFile(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`${file.slice(ROOT.length + 1)} 不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new UsageError(`${file.slice(ROOT.length + 1)} 缺少非空的 targets[]`);
  }
  return {
    targets: parsed.targets,
    userAgent:
      parsed.userAgent ??
      'daily-interview-arena/0.1 (personal interview prep; local use)',
    cacheDir: join(ROOT, parsed.cacheDir ?? 'content/jd-cache'),
    historyDir: join(ROOT, parsed.historyDir ?? 'content/jd-cache/history'),
    http: { ...HTTP_DEFAULTS, ...(parsed.http ?? {}) },
  };
}

export function companySlug(company) {
  return String(company).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function cacheFileName(company, date = new Date()) {
  return `${companySlug(company)}-${todayStamp(date)}.json`;
}

/** 统一 JD 形状校验：adapter 必须产出这些字段。 */
export function normalizeJdEntry(entry) {
  const url = String(entry?.url ?? '').trim();
  const title = String(entry?.title ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (title.length < 3) return null;
  return {
    company: String(entry.company ?? '').trim() || 'unknown',
    url,
    title,
    location: String(entry.location ?? '').trim() || 'unspecified',
    locationScope: entry.locationScope ?? classifyLocation(entry.location),
    crawledAt: entry.crawledAt ?? new Date().toISOString(),
    excerpt: String(entry.excerpt ?? '').trim(),
    adapter: entry.adapter ?? 'unknown',
    sourceType: entry.sourceType ?? 'live-crawl',
    ...(entry.postedAt ? { postedAt: entry.postedAt } : {}),
  };
}

const US_TOKENS = [
  'united states', 'usa', 'u.s.', 'america', 'remote - usa', 'remote, usa',
  'san francisco', 'sunnyvale', 'cupertino', 'california', 'new york', 'austin', 'texas',
  'seattle', 'washington', 'san diego', 'los angeles', 'culver city', 'chicago', 'illinois',
  'boston', 'massachusetts', 'atlanta', 'georgia', 'north carolina', 'research triangle',
  'palo alto', 'mountain view', 'redmond', 'bellevue', 'denver', 'colorado', 'miami', 'florida',
];
const SHANGHAI_TOKENS = ['shanghai', '上海', 'china', '中国', 'beijing', 'hangzhou', 'shenzhen'];

/** 把任意地点字符串折成 shared schema 认的四值 locationScope。 */
export function classifyLocation(location) {
  const text = String(location ?? '').toLowerCase();
  if (!text) return 'other';
  if (SHANGHAI_TOKENS.some((t) => text.includes(t))) return 'shanghai';
  if (/\bremote\b/.test(text) && !US_TOKENS.some((t) => text.includes(t))) return 'remote';
  if (US_TOKENS.some((t) => text.includes(t))) return 'us';
  return 'other';
}

/**
 * HTML → 纯文本。
 * 注意顺序：Greenhouse 的 `content` 字段是**被实体转义过的 HTML**（`&lt;div&gt;`），
 * 所以必须先解实体、再去标签，否则会留一堆尖括号在 excerpt 里。
 */
export function htmlToText(html) {
  const decoded = String(html ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return point > 31 && point < 127 ? String.fromCharCode(point) : ' ';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // 双重转义的实体（&amp;nbsp;）解一遍后会剩 &nbsp;，再清一次
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&');
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/**  excerpt 质量打分：纯文本 > 原始 HTML；同类比长度。用于"同一条 JD 的两个版本谁留下"。 */
export function excerptQuality(entry) {
  const text = String(entry?.excerpt ?? '');
  const raw = /<div|<p>|&lt;|<span|<br/i.test(text);
  return (raw ? 0 : 1_000_000) + text.length;
}

function httpError(status, url, bodyHint) {
  const hint = bodyHint ? `｜响应片段：${bodyHint.slice(0, 200).replace(/\s+/g, ' ')}` : '';
  return new Error(`HTTP ${status} ${url}${hint}`);
}

async function fetchWithPolicy(url, { userAgent, timeoutMs, retries, backoffMs, accept }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1_000;
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': userAgent, accept: accept ?? '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastError = httpError(res.status, url, body);
        // 4xx 是确定性失败（除了 408/429 这类限流），不再浪费重试
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        continue;
      }
      return res;
    } catch (err) {
      const cause = err?.cause?.code ?? err?.cause?.message;
      lastError =
        err.name === 'TimeoutError'
          ? new Error(`超时 ${timeoutMs}ms：${url}`)
          : new Error(`${url} 请求失败：${err.message}${cause ? `（${cause}）` : ''}`);
    }
  }
  throw lastError ?? new Error(`请求失败：${url}`);
}

/** 带 userAgent / 20s 超时 / 2 次退避重试的 GET JSON。 */
export async function getJson(url, opts = {}) {
  const res = await fetchWithPolicy(url, { ...httpOpts(opts), accept: 'application/json' });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${url} 返回的不是 JSON：${err.message}`);
  }
}

/** 带同样策略的 GET 文本（Apple 搜索页只有 HTML）。 */
export async function getText(url, opts = {}) {
  const res = await fetchWithPolicy(url, { ...httpOpts(opts), accept: 'text/html,application/xhtml+xml' });
  return { body: await res.text(), finalUrl: res.url, status: res.status };
}

function httpOpts(opts) {
  return {
    userAgent: opts.userAgent,
    timeoutMs: opts.timeoutMs ?? HTTP_DEFAULTS.timeoutMs,
    retries: opts.retries ?? HTTP_DEFAULTS.retries,
    backoffMs: opts.backoffMs ?? HTTP_DEFAULTS.backoffMs,
  };
}

export function describeNetworkError(err) {
  const msg = err?.message ?? String(err);
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'DNS 解析失败（可能断网或被墙）';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(msg)) return '连接被拒/被重置';
  if (/超时/.test(msg)) return msg;
  if (/HTTP 401|HTTP 403/.test(msg)) return '被拒绝访问（可能需要换 UA 或接口改版）';
  if (/HTTP 301|HTTP 302|HTTP 30/.test(msg)) return '重定向后失败（接口路径已变更）';
  return msg;
}

/**
 * 读全部可用 JD 数据（缓存 json + history/*.md 人工样本），按 url 去重（excerpt 更长的胜出）。
 * history/*.md 也要计入 —— 这样断网时 extract-skills / generate-with-cli 仍有技术栈输入。
 */
export async function readCachedJds(dir = DEFAULT_CACHE_DIR) {
  const entries = [];
  const files = listCacheFiles(dir);
  for (const file of files.json) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[jd] 忽略坏缓存 ${rel(file)}：${err.message}`);
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : (parsed?.entries ?? []);
    for (const item of items) {
      const norm = normalizeJdEntry(item);
      if (norm) entries.push(norm);
      else console.warn(`[jd] ${rel(file)} 里有缺 url/title 的条目，已跳过`);
    }
  }
  for (const file of files.history) {
    try {
      const norm = parseHistoryMarkdown(readFileSync(file, 'utf8'), file);
      if (norm) entries.push(norm);
      else console.warn(`[jd] history/${file.split(/[\\/]/).pop()} 缺 company/title，无法作为 JD 输入`);
    } catch (err) {
      console.warn(`[jd] 忽略坏 history 样本 ${rel(file)}：${err.message}`);
    }
  }
  return dedupeBy_url(entries);
}

export function listCacheFiles(dir = DEFAULT_CACHE_DIR) {
  const json = [];
  const history = [];
  if (!existsSync(dir)) return { json, history };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'history' && existsSync(full)) {
        for (const h of readdirSync(full)) if (h.endsWith('.md')) history.push(join(full, h));
      }
      continue;
    }
    if (entry.name.endsWith('.json') && entry.name !== 'skills.json' && entry.name !== 'report.json') json.push(full);
  }
  json.sort();
  history.sort();
  return { json, history };
}

/**
 * 缓存条目合并：只增不减。
 * 同 url 视为同一条目 —— 保留质量更高的那份（excerptQuality：纯文本优先于原始 HTML，其次更长），
 * crawledAt 取更早的（=首次发现时间，入库题目的"JD 来源时间"用它才有意义）。
 */
export function mergeEntries(existing, incoming) {
  const map = new Map(existing.map((e) => [e.url, e]));
  let added = 0;
  let enriched = 0;
  for (const raw of incoming) {
    const entry = normalizeJdEntry(raw);
    if (!entry) continue;
    const prev = map.get(entry.url);
    if (!prev) {
      map.set(entry.url, entry);
      added += 1;
      continue;
    }
    const crawledAt = prev.crawledAt && (!entry.crawledAt || prev.crawledAt < entry.crawledAt) ? prev.crawledAt : entry.crawledAt;
    const better = excerptQuality(entry) > excerptQuality(prev) ? { ...entry, crawledAt } : { ...prev, crawledAt };
    if (JSON.stringify(better) !== JSON.stringify(prev)) enriched += 1;
    map.set(entry.url, better);
  }
  const merged = [...map.values()].sort((a, b) => a.url.localeCompare(b.url));
  if (merged.length < existing.length) {
    // 理论上不可达（Map 只增），保留断言以防未来改坏
    throw new Error(`内部错误：合并后条目从 ${existing.length} 变成 ${merged.length}`);
  }
  return { merged, added, enriched, kept: existing.length };
}

function dedupeBy_url(entries) {
  const map = new Map();
  for (const entry of entries) {
    const prev = map.get(entry.url);
    if (!prev || excerptQuality(entry) > excerptQuality(prev)) map.set(entry.url, entry);
  }
  return [...map.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/** history/*.md → 统一 JD 条目。这些是人工整理的公开信息样本，用于断网时仍能出题。 */
export function parseHistoryMarkdown(text, file) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const company = meta.company ?? companyFromFilename(file);
  const url = meta.url ?? meta.source ?? `file://${rel(file)}`;
  return normalizeJdEntry({
    company,
    url,
    title: meta.title ?? heading ?? `${company} ${meta.role ?? ''}`.trim(),
    location: meta.location ?? 'unspecified',
    excerpt: body,
    adapter: 'history-markdown',
    sourceType: 'history-manual',
    crawledAt: meta.crawledAt ?? '1970-01-01T00:00:00.000Z',
  });
}

function companyFromFilename(file) {
  const base = file.split(/[\\/]/).pop().toLowerCase();
  if (base.includes('apple')) return 'Apple';
  if (base.includes('airbnb')) return 'Airbnb';
  return 'history';
}

export async function writeJsonAtomic(file, payload) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

export function rel(pathLike) {
  return String(pathLike).replace(/\\/g, '/').slice(ROOT.length + 1);
}

export function which(name) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(checker, [name], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  const lines = found.stdout.split(/\r?\n/).filter(Boolean);
  return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0] ?? null;
}

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  return false;
}

export { DEFAULT_CACHE_DIR };
