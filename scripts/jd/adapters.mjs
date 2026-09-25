/**
 * JD 抓取 adapter。每个 adapter 返回统一形状（见 lib.mjs 的 normalizeJdEntry）：
 *   { company, url, title, location, locationScope, crawledAt, excerpt, adapter }
 *
 * 约定：**任何网络/解析问题都不抛异常**，而是返回 { entries, fetchFailed, notes }，
 * 让 refresh-bank 在断网环境里仍能靠缓存/history 跑完（需求 9 的离线降级路径）。
 */
import { getJson, getText, htmlToText, classifyLocation, describeNetworkError } from './lib.mjs';

/** query term 命中岗位标题的正向词（不配上的直接丢，缓存里不堆无关岗位） */
const ROLE_POSITIVE =
  /(data|backend|back-end|full[- ]?stack|software|platform|machine learning|ml|analytics|pipeline|warehouse|warehouse|big data|distributed|infra|reliability|sre|search|recommendation)/i;
const ROLE_NEGATIVE =
  /(intern|student|graduate|apprentice|retail|genius|specialist|store|sales|account manager|recruiter|marketing|financial analyst|content|writer|translator|nurse|physical|security officer|program manager, supply|supply chain|supplier)/i;

function titleMatchesTerm(title, term) {
  const text = String(title).toLowerCase();
  const tokens = String(term)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !['the', 'and', 'senior', 'staff', 'with'].includes(t));
  if (tokens.length === 0) return false;
  return tokens.some((t) => text.includes(t));
}

function passesRoleFilter(entry, term) {
  if (ROLE_NEGATIVE.test(entry.title)) return false;
  if (!ROLE_POSITIVE.test(entry.title)) return false;
  return titleMatchesTerm(entry.title, term);
}

/* ------------------------------------------------------------------ Greenhouse (Airbnb) */

export async function greenhouse(target, ctx) {
  const board = target.board ?? 'airbnb';
  const url = target.url ?? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  const result = { entries: [], fetchFailed: false, notes: [], stats: {} };
  let payload;
  try {
    payload = await getJson(url, { userAgent: ctx.userAgent, timeoutMs: ctx.timeoutMs });
  } catch (err) {
    result.fetchFailed = true;
    result.notes.push(`${target.adapter} 抓取失败：${describeNetworkError(err)}`);
    return result;
  }
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  if (jobs.length === 0) {
    result.fetchFailed = true;
    result.notes.push(`${target.adapter} 返回 jobs[] 为空（接口改版或 board 名称不对：${board}）`);
    return result;
  }
  result.stats.totalJobs = jobs.length;

  for (const job of jobs) {
    const rawContent = job.content ?? '';
    const content = htmlToText(rawContent);
    const haystack = `${job.title ?? ''}\n${content}`.toLowerCase();
    for (const query of target.queries ?? []) {
      if (!passesRoleFilter({ title: job.title ?? '' }, query.term)) continue;
      const scope = classifyLocation(job.location?.name);
      if (query.location && query.location !== 'any' && scope !== query.location) continue;
      const entry = {
        company: target.company,
        url: job.absolute_url ?? `https://boards.greenhouse.io/${board}/jobs/${job.id}`,
        title: String(job.title).trim(),
        location: job.location?.name ?? 'unspecified',
        locationScope: scope,
        crawledAt: new Date().toISOString(),
        excerpt: content.slice(0, ctx.excerptChars ?? 4000),
        adapter: 'greenhouse',
        postedAt: job.first_published ?? job.updated_at ?? undefined,
      };
      entry.keywords = hitKeywords(haystack);
      result.entries.push(entry);
      break; // 一个岗位只按第一个命中的 query 计一次
    }
    if (ctx.limit && result.entries.length >= ctx.limit) break;
  }
  if (ctx.limit && result.entries.length > ctx.limit) result.entries.length = ctx.limit;
  result.notes.push(`greenhouse：${jobs.length} 个在招岗位里筛出 ${result.entries.length} 个目标岗位`);
  return result;
}

/* ------------------------------------------------------------------ SmartRecruiters (通用兜底) */

export async function smartrecruiters(target, ctx) {
  const slug = target.companySlug ?? target.company;
  const result = { entries: [], fetchFailed: false, notes: [], stats: {} };
  let total = 0;
  let content = [];
  for (let offset = 0; offset < (target.maxPages ?? 1) * 100; offset += 100) {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}`;
    let payload;
    try {
      payload = await getJson(url, { userAgent: ctx.userAgent, timeoutMs: ctx.timeoutMs });
    } catch (err) {
      result.fetchFailed = true;
      result.notes.push(`smartrecruiters 抓取失败：${describeNetworkError(err)}`);
      return result;
    }
    total = payload?.totalFound ?? 0;
    content = content.concat(payload?.content ?? []);
    if (content.length >= total || (payload?.content ?? []).length === 0) break;
  }
  result.stats.totalFound = total;
  if (total === 0) {
    result.fetchFailed = true;
    result.notes.push(`smartrecruiters companies/${slug}/postings 返回 totalFound=0（该公司不用 SmartRecruiters）`);
    return result;
  }
  for (const posting of content) {
    if (!passesRoleFilter({ title: posting.name ?? '' }, (target.queries ?? [])[0]?.term ?? 'engineer')) continue;
    const location = posting.location?.city ? [posting.location.city, posting.location.country].filter(Boolean).join(', ') : (posting.location?.country ?? 'unspecified');
    const scope = classifyLocation(location);
    const excerpt = htmlToText([posting.jobDescription ?? '', posting.qualifications ?? ''].join('\n'));
    result.entries.push({
      company: target.company,
      url: posting.refId ? `https://jobs.smartrecruiters.com/${slug}/${posting.refId}` : (posting.applyUrl ?? `https://careers.${slug.toLowerCase()}.com/`),
      title: String(posting.name).trim(),
      location,
      locationScope: scope,
      crawledAt: new Date().toISOString(),
      excerpt: excerpt.slice(0, ctx.excerptChars ?? 4000),
      adapter: 'smartrecruiters',
      postedAt: posting.date ?? undefined,
      keywords: hitKeywords(`${posting.name ?? ''}\n${excerpt}`.toLowerCase()),
    });
  }
  result.notes.push(`smartrecruiters：totalFound=${total}，筛出 ${result.entries.length} 个`);
  return result;
}

/* ------------------------------------------------------------------ Apple（jobs.apple.com 搜索页） */

/**
 * Apple 的两个已知坑（实测 2026-09-19）：
 * 1. `https://jobs.apple.com/api/en-us/search` 301 → pagenotfound，没有可用 JSON API；
 * 2. `https://jobs.apple.com/en-us/search?...` 返回 Remix/React Router 渲染的 HTML，
 *    结果不在 `href="/en-us/job/details/..."` 里，而在页面内嵌的
 *    `window.__staticRouterHydrationData = JSON.parse("…")` 里：
 *    `loaderData.search.searchResults[]` = { positionId, postingTitle, locations[], jobSummary, team, postDateInGMT }。
 * 因此优先解析 hydration JSON；解析不出来再退回正则抓链接；再不行返回空列表 + fetchFailed。
 */
export async function appleWeb(target, ctx) {
  const result = { entries: [], fetchFailed: false, notes: [], stats: {} };
  const locale = target.locale ?? 'en-us';
  const pageSize = 20;
  const wanted = ctx.limit ?? target.limit ?? 25;
  const seen = new Set();
  let failures = 0;
  let requests = 0;

  for (const query of target.queries ?? []) {
    if (result.entries.length >= wanted) {
      result.notes.push(`apple-web "${query.term}"：已达 limit=${wanted}，跳过该 query`);
      continue;
    }
    const pages = Math.max(1, Math.min(target.maxPages ?? 5, Math.ceil((wanted - result.entries.length) / pageSize) + 1));
    for (let page = 1; page <= pages; page++) {
      const term = /"[^"]+"/.test(query.term) ? query.term : `"${query.term}"`;
      const url = `https://jobs.apple.com/${locale}/search?search=${encodeURIComponent(term)}&page=${page}`;
      let html;
      try {
        const res = await getText(url, { userAgent: ctx.userAgent, timeoutMs: ctx.timeoutMs });
        html = res.body;
        requests += 1;
        if (/<title[^>]*>[^<]*(page not found|notfound)/i.test(html)) {
          result.notes.push(`apple-web ${url} 落到 pagenotfound 页，放弃该 query`);
          failures += 1;
          break;
        }
      } catch (err) {
        failures += 1;
        result.notes.push(`apple-web 抓取失败（${url}）：${describeNetworkError(err)}`);
        break;
      }
      let rows = extractAppleFromHydration(html);
      let via = 'hydration';
      if (rows.length === 0) {
        rows = extractAppleFromAnchors(html, locale);
        via = 'anchor';
      }
      if (rows.length === 0) {
        failures += 1;
        result.notes.push(`apple-web ${url} 拿到 HTML 但解析不出职位（页面结构可能又变了；已尝试 hydration + anchor 两条路）`);
        break;
      }
      for (const row of rows) {
        const entry = {
          ...row,
          company: target.company,
          locationScope: classifyLocation(row.location),
          crawledAt: new Date().toISOString(),
          adapter: 'apple-web',
        };
        if (seen.has(entry.url)) continue;
        if (query.location && query.location !== 'any' && entry.locationScope !== query.location) continue;
        if (!passesRoleFilter(entry, query.term)) continue;
        seen.add(entry.url);
        entry.keywords = hitKeywords(`${entry.title}\n${entry.excerpt}`.toLowerCase());
        result.entries.push(entry);
      }
      if (rows.length < pageSize) break; // 最后一页
      if (via === 'anchor') break; // 退化路径拿不到分页语义，别继续空转
      if (result.entries.length >= wanted) break;
    }
  }
  if (result.entries.length > wanted) result.entries.length = wanted;
  if (result.entries.length === 0) result.fetchFailed = failures > 0;
  result.stats.requests = requests;
  result.notes.push(`apple-web：${requests} 次请求，筛出 ${result.entries.length} 个目标岗位${failures ? `，${failures} 次失败` : ''}`);
  return result;
}

function hydrationLiteral(html) {
  const marker = html.indexOf('__staticRouterHydrationData');
  if (marker < 0) return null;
  const m = /JSON\.parse\("((?:[^"\\]|\\.)*)"\)/.exec(html.slice(marker, marker + 4_000_000));
  if (!m) return null;
  try {
    return JSON.parse(JSON.parse(`"${m[1]}"`));
  } catch {
    return null;
  }
}

function extractAppleFromHydration(html) {
  const data = hydrationLiteral(html);
  const rows = data?.loaderData?.search?.searchResults ?? [];
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const positionId = String(row.positionId ?? '').trim();
    const slug = String(row.transformedPostingTitle ?? '').trim();
    if (!positionId || !row.postingTitle) continue;
    const teamCode = row.team?.teamCode ? `?team=${encodeURIComponent(row.team.teamCode)}` : '';
    out.push({
      url: `https://jobs.apple.com/en-us/details/${positionId}/${slug || positionId}${teamCode}`,
      title: String(row.postingTitle).trim(),
      location: (row.locations ?? []).map((l) => l.name || [l.city, l.region, l.countryName].filter(Boolean).join(', ')).filter(Boolean).join(' / ') || 'unspecified',
      excerpt: htmlToText([row.jobSummary ?? '', ...(row.locations ?? []).map((l) => `Location: ${l.name ?? l.countryName ?? ''}`)].join('\n')).slice(0, 4000),
      postedAt: row.postDateInGMT ?? row.postingDate ?? undefined,
    });
  }
  return out;
}

function extractAppleFromAnchors(html, locale) {
  const out = [];
  const re = new RegExp(`href="/(?:${locale}|[a-z]{2}-[a-z]{2})/(?:job/)?details/(\\d+)/([^"?#]+)([^"]*)"[^>]*>([^<]{3,})<`, 'gi');
  for (const m of html.matchAll(re)) {
    out.push({
      url: `https://jobs.apple.com/${locale}/details/${m[1]}/${m[2].trim()}${(m[3] ?? '').replace(/^&/, '?')}`,
      title: htmlToText(m[4]).trim(),
      location: 'unspecified',
      excerpt: '',
    });
  }
  return out;
}

/** 关键词粗筛（skills.json 会做更细的同义词归一，这里只是省流量/噪音） */
function hitKeywords(haystack) {
  const hits = [];
  for (const kw of ['flink', 'kafka', 'spark', 'clickhouse', 'trino', 'iceberg', 'dbt', 'airflow', 'mysql', 'redis', 'react', 'typescript', 'grpc', 'kubernetes']) {
    if (haystack.includes(kw)) hits.push(kw);
  }
  return hits;
}

export const ADAPTERS = { greenhouse, smartrecruiters, 'apple-web': appleWeb, 'apple-careers': appleWeb };
