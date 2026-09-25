#!/usr/bin/env node
/**
 * JD 文本 → 技术栈标签（skills.json）。这是"该出什么题"的信号，不是给人读的散文。
 *
 *   node scripts/jd/extract-skills.mjs                 # 读全部缓存 + history/*.md
 *   node scripts/jd/extract-skills.mjs --offline       # 明确只用本地数据
 *   node scripts/jd/extract-skills.mjs --min-mentions 2
 *
 * 输出（按 mentions 降序）：
 *   { generatedAt, corpus, weightsByCategory, skills: [{ tag, label, category, mentions, jdCount, companies[], sampleUrls[] }] }
 *
 * 同义词表在 SKILL_RULES 里成文维护：一个 tag 一条规则，别名覆盖大小写、全称/缩写与带边界的短词。
 */
import { isAbsolute, join, resolve } from 'node:path';
import {
  UsageError,
  isMain,
  listCacheFiles,
  loadSources,
  parseArgs,
  readCachedJds,
  rel,
  writeJsonAtomic,
} from './lib.mjs';

const ESC = /[.*+?^${}()|[\]\\/]/g;
const BEFORE = '(?<![A-Za-z0-9_])';
const AFTER = '(?![A-Za-z0-9_])';

/** 别名可以是字符串（自动加词边界）或现成的 RegExp（自己控制边界，必须带 i 与 g）。 */
function rule(patterns, category, label) {
  return {
    label,
    category,
    regexes: patterns.map((p) =>
      p instanceof RegExp
        ? p
        : new RegExp(`${BEFORE}${p.replace(ESC, '\\$&')}${AFTER}`, 'gi'),
    ),
  };
}

/**
 * tag → 别名 + 归属类别。类别用于 refresh-bank 把"JD 热度"折成"该给哪个类别加题"。
 * 需求点名的 flink/beam/kafka/spark/pyspark/clickhouse/trino/iceberg/dbt/airflow/mysql/redis/react/typescript/java/grpc/kubernetes 全在表内。
 */
export const SKILL_RULES = {
  /* ---------------- big-data ---------------- */
  flink: rule(['apache flink', 'flink', 'flink sql', 'blink planner'], 'big-data', 'Apache Flink'),
  beam: rule(['apache beam', 'beam sdk', 'beam'], 'big-data', 'Apache Beam（批流统一模型）'),
  kafka: rule(['kafka', 'kstreams', 'kafka streams', 'schema registry', 'confluent'], 'big-data', 'Kafka / 事件总线'),
  spark: rule(['apache spark', 'spark sql', 'sparksession', 'databricks', 'spark'], 'big-data', 'Apache Spark'),
  pyspark: rule(['pyspark', 'py spark'], 'big-data', 'PySpark'),
  scala: rule(['scala'], 'big-data', 'Scala / Spark JVM 内部机制'),
  'pandas-on-spark': rule(['pandas api on spark', 'koalas', 'pandas udf', 'arrow udf'], 'big-data', 'Pandas UDF / pandas API on Spark'),
  hive: rule(['hive', 'hiveserver', 'hcatalog', 'hadoop', 'mapreduce', 'hdfs'], 'big-data', 'Hadoop / Hive 体系'),
  clickhouse: rule(['clickhouse'], 'big-data', 'ClickHouse'),
  trino: rule(['trino', 'presto', 'prestodb', 'starburst'], 'big-data', 'Trino / Presto'),
  olap: rule(['druid', 'apache doris', 'doris', 'starrocks', 'pinot', 'kylin', 'olap'], 'big-data', 'OLAP 引擎'),
  iceberg: rule(['apache iceberg', 'iceberg'], 'big-data', 'Apache Iceberg'),
  paimon: rule(['paimon'], 'big-data', 'Apache Paimon'),
  hudi: rule(['hudi'], 'big-data', 'Apache Hudi'),
  'delta-lake': rule(['delta lake', 'deltalake'], 'big-data', 'Delta Lake'),
  'data-lake': rule(['data lake', 'datalake', 'lakehouse', 'object storage', 'parquet', 'orc', 'avro'], 'big-data', '湖仓 / 列式文件格式'),
  dbt: rule(['dbt', 'data build tool'], 'big-data', 'dbt 分层建模'),
  airflow: rule(['airflow', 'apache airflow'], 'big-data', 'Airflow 编排'),
  dagster: rule(['dagster', 'prefect'], 'big-data', 'Dagster / 现代编排'),
  etl: rule(['etl', 'elt', 'data pipeline', 'data ingestion', 'ingestion', 'batch processing', 'stream processing', 'real[- ]time pipeline'], 'big-data', 'ETL / 数据管道'),
  streaming: rule(['streaming', 'real[- ]time', 'event[- ]driven', 'watermark', 'exactly[- ]once', '\\bcdc\\b', 'change data capture'], 'big-data', '流处理 / CDC 语义'),
  'data-modeling': rule(['data model', 'data modeling', 'dimensional model', 'star schema', 'schema design', 'data warehouse', 'warehouse', 'semantic layer', 'metrics layer', 'metrics store', 'data mesh'], 'big-data', '数据建模 / 数仓 / 语义层'),
  'data-quality': rule(['data quality', 'data integrity', 'data validation', 'data contract', 'great expectations', '\\bdqc\\b', 'anomaly detection'], 'big-data', '数据质量与契约'),
  'data-governance-privacy': rule(['data governance', 'differential privacy', 'de[- ]identif', 'anonymi[sz]ation', '\\bpii\\b', 'personally identifiable', 'data lineage', '\\bgdpr\\b', '\\bccpa\\b', 'privacy'], 'big-data', '数据治理与隐私'),
  'feature-store': rule(['feature store', 'feature engineering', 'chronon', 'point[- ]in[- ]time'], 'big-data', '特征平台'),
  'ml-platform': rule(['machine learning platform', 'ml platform', 'mlops', 'data science', 'machine learning'], 'big-data', 'ML / 数据科学协作'),
  'cost-optimization': rule(['cost optimization', 'cost management', 'finops', 'cost reduction', 'unit cost', 'capacity planning'], 'big-data', '成本与容量治理'),
  'sql-analytics': rule(['advanced sql', 'complex sql', 'window function', 'analytical quer', 'query tuning', 'query optimization', 'performance tuning'], 'big-data', '分析型 SQL / 查询调优'),

  /* ---------------- sql（存储与检索） ---------------- */
  mysql: rule(['mysql', 'mariadb', 'innodb', 'aurora', '\\brds\\b'], 'sql', 'MySQL'),
  redis: rule(['redis', 'memcached', 'valkey'], 'sql', 'Redis / 缓存存储'),
  postgresql: rule(['postgresql', 'postgres'], 'sql', 'PostgreSQL'),
  nosql: rule(['cassandra', 'scylla', 'hbase', 'mongo', 'dynamodb', 'elasticsearch', 'opensearch', 'solr'], 'sql', 'NoSQL / 检索引擎'),
  sql: rule(['\\bsql\\b', 'ansi sql', 't[- ]sql'], 'sql', 'SQL 基础'),
  'storage-engine': rule(['database engine', 'database internals', 'replication', 'sharding', 'partitioning', '\\bindex\\b', 'indexing', 'isolation level', 'transaction', 'mvcc', 'backup', 'disaster recovery database'], 'sql', '存储引擎 / 事务与复制'),

  /* ---------------- frontend ---------------- */
  react: rule(['react', 'reactjs', 'react native', 'next\\.js', 'nextjs', 'remix'], 'frontend', 'React'),
  typescript: rule(['typescript', '\\btsx\\b'], 'frontend', 'TypeScript'),
  javascript: rule(['javascript', 'ecmascript', 'es2022', 'es2023', 'node\\.js', 'nodejs', '\\bnpm\\b', 'webpack', 'vite', 'rollup'], 'frontend', 'JavaScript / Node 工具链'),
  'web-performance': rule(['core web vitals', 'lighthouse', 'web performance', 'lazy loading', 'virtuali[sz]ation', 'code splitting', 'rendering performance'], 'frontend', 'Web 性能'),
  css: rule(['\\bcss\\b', 'sass', 'tailwind', 'styled-components', 'responsive design'], 'frontend', 'CSS / 样式体系'),
  accessibility: rule(['accessibility', '\\ba11y\\b', 'wcag', 'screen reader'], 'frontend', '无障碍'),
  'frontend-testing': rule(['jest', 'vitest', 'testing library', 'cypress', 'playwright', 'storybook'], 'frontend', '前端测试'),

  /* ---------------- algorithms（编码轮 / 语言功底） ---------------- */
  java: rule(['java', 'java 17', 'java 21', 'spring boot', 'spring framework', '\\bjvm\\b', 'hotspot', 'kotlin'], 'algorithms', 'Java / JVM'),
  python: rule(['python', 'python3', 'pytest'], 'algorithms', 'Python'),
  go: rule(['golang', 'go engineer', 'go developer', 'go service', 'go language'], 'algorithms', 'Go'),
  cpp: rule(['c\\+\\+'], 'algorithms', 'C++'),
  concurrency: rule(['concurrenc', 'multithreading', 'thread[- ]safety', 'lock[- ]free', 'actor model', 'coroutine', 'virtual thread'], 'algorithms', '并发 / 多线程'),
  algorithms: rule(['data structure', 'algorithm', 'big[- ]o', 'dynamic programming', 'graph algorithm'], 'algorithms', '数据结构与算法'),
  'jvm-performance': rule(['garbage collection', 'gc tuning', 'memory leak', 'profiling', '\\bjmh\\b', 'benchmark'], 'algorithms', 'JVM / 性能工程'),

  /* ---------------- system-design ---------------- */
  kubernetes: rule(['kubernetes', '\\bk8s\\b', 'openshift', 'helm', 'container orchestration'], 'system-design', 'Kubernetes'),
  docker: rule(['docker', 'containeri[sz]ation', 'podman'], 'system-design', '容器化'),
  grpc: rule(['grpc', 'protobuf', 'protocol buffers', 'thrift'], 'system-design', 'gRPC / Thrift'),
  'api-design': rule(['rest api', 'restful', '\\brest\\b', 'api design', 'graphql', 'openapi', 'api versioning', 'backward compatible'], 'system-design', 'API 契约设计'),
  microservices: rule(['microservice', 'service oriented', 'distributed system', 'service mesh', 'envoy', 'consensus', '\\braft\\b', 'service discovery', 'load balanc', 'rate limit', 'circuit breaker', 'backpressure'], 'system-design', '微服务 / 分布式'),
  scalability: rule(['scalab', 'high availability', 'fault tolerance', 'disaster recovery', 'multi[- ]region', 'active[- ]active', 'large[- ]scale', 'high traffic', 'throughput'], 'system-design', '可扩展性与可用性'),
  caching: rule(['caching', 'cache layer', '\\bcdns?\\b', 'stale[- ]while[- ]revalidate', 'cache invalidation'], 'system-design', '缓存架构'),
  observability: rule(['observability', 'prometheus', 'grafana', 'opentelemetry', 'distributed tracing', 'opentracing', '\\bslo\\b', '\\bsla\\b', 'monitoring', 'logging'], 'system-design', '可观测性与 SLO'),
  cloud: rule(['\\baws\\b', 'amazon web services', '\\bgcp\\b', 'google cloud', 'azure', 'private cloud', 'serverless', '\\blambda\\b'], 'system-design', '云平台'),
  iac: rule(['terraform', 'infrastructure as code', 'cloudformation', 'pulumi', 'ansible'], 'system-design', 'IaC'),
  cicd: rule(['ci/cd', 'continuous integration', 'continuous delivery', 'jenkins', 'github actions', 'canary', 'blue[- ]green', 'feature flag', 'trunk[- ]based'], 'system-design', 'CI/CD 与发布'),
  security: rule(['oauth', 'openid', '\\bjwt\\b', 'single sign', 'zero trust', '\\bpci\\b', 'mtls', 'encrypti', 'secrets management', 'threat model'], 'system-design', '安全与授权'),
  monorepo: rule(['monorepo', 'bazel', 'gradle', 'maven', 'pnpm'], 'system-design', '构建系统与仓库形态'),

  /* ---------------- agent-design ---------------- */
  llm: rule(['\\bllms?\\b', 'large language model', 'gpt[-45o]+', 'foundation model', 'generative ai', 'genai'], 'agent-design', 'LLM'),
  rag: rule(['retrieval[- ]augmented', '\\brag\\b', 'vector database', 'vector search', 'embedding', 'ann index', 'semantic search'], 'agent-design', 'RAG 与向量检索'),
  agent: rule(['ai agent', 'agentic', 'multi[- ]agent', 'tool calling', 'function calling', '\\bmcp\\b', 'model context protocol', 'autonomous agent'], 'agent-design', 'Agent 与工具调用'),
  'llm-evals-guardrails': rule(['llm evaluation', 'eval harness', 'guardrail', 'prompt injection', 'hallucination', 'red[- ]team'], 'agent-design', '评测与护栏'),
  'context-engineering': rule(['prompt engineering', 'context engineering', 'fine[- ]tun', '\\blora\\b', 'kv[- ]cache', 'distillation'], 'agent-design', '上下文工程与微调'),

  /* ---------------- hot-interviews（公司/业务画像） ---------------- */
  marketplace: rule(['marketplace', 'two[- ]sided', 'booking', '\\bhost\\b', '\\bguest\\b', 'listing', 'travel', 'supply and demand', 'pricing', 'search ranking', 'personalization', 'recommendation'], 'hot-interviews', 'Marketplace / 搜索排序（Airbnb 画像）'),
  telemetry: rule(['telemetry', 'on[- ]device', 'device[- ]side', 'edge comput', 'instrumentation', 'event tracking', 'log pipeline', 'firmware', '\\bswift\\b'], 'hot-interviews', '端侧遥测与隐私管道（Apple 画像）'),
  'apple-ecosystem': rule(['\\bapple\\b', 'iphone', 'icloud', 'app store', 'siri', 'objective[- ]c', 'swiftui'], 'hot-interviews', 'Apple 生态'),
  'airbnb-ecosystem': rule(['airbnb'], 'hot-interviews', 'Airbnb 生态'),
};

const JD_FILE_RE = /^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.json$/;

export function countMatches(text) {
  const hits = new Map();
  for (const [tag, def] of Object.entries(SKILL_RULES)) {
    let count = 0;
    for (const re of def.regexes) {
      re.lastIndex = 0;
      count += (text.match(re) ?? []).length;
    }
    if (count > 0) hits.set(tag, count);
  }
  return hits;
}

export function buildSkillRows(entries, { minMentions = 1 } = {}) {
  const perTag = new Map();
  for (const entry of entries) {
    const haystack = `${entry.title}\n${entry.excerpt}`;
    for (const [tag, count] of countMatches(haystack)) {
      let row = perTag.get(tag);
      if (!row) {
        row = { tag, mentions: 0, jdCount: 0, companies: new Map(), urls: new Map() };
        perTag.set(tag, row);
      }
      row.mentions += count;
      row.jdCount += 1;
      row.companies.set(entry.company, (row.companies.get(entry.company) ?? 0) + 1);
      row.urls.set(entry.url, (row.urls.get(entry.url) ?? 0) + count);
    }
  }
  return [...perTag.values()]
    .filter((row) => row.mentions >= minMentions)
    .map((row) => ({
      tag: row.tag,
      label: row.label ?? SKILL_RULES[row.tag].label,
      category: SKILL_RULES[row.tag].category,
      mentions: row.mentions,
      jdCount: row.jdCount,
      companies: [...row.companies.keys()].sort(),
      sampleUrls: [...row.urls.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([url]) => url),
    }))
    .sort((a, b) => b.mentions - a.mentions || a.tag.localeCompare(b.tag));
}

export function categoryWeights(skills) {
  const out = {};
  for (const s of skills) out[s.category] = (out[s.category] ?? 0) + s.mentions;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export async function runExtractSkills(opts = {}) {
  const cfg = await loadSources(opts.sourcesFile);
  const cacheDir = opts.cacheDir ?? cfg.cacheDir;
  const files = listCacheFiles(cacheDir);
  const entries = opts.entries ?? (await readCachedJds(cacheDir));
  if (entries.length === 0) {
    throw new UsageError(
      'content/jd-cache 里没有任何 JD 条目（缓存 json 与 history/*.md 都为空）。先跑 node scripts/jd/fetch.mjs --company Airbnb，或补一份 history/*.md 离线样本。',
    );
  }

  const skills = buildSkillRows(entries, { minMentions: opts.minMentions ?? 1 });
  const payload = {
    generatedAt: new Date().toISOString(),
    offline: Boolean(opts.offline),
    corpus: {
      jdEntries: entries.length,
      companies: [...new Set(entries.map((e) => e.company))].sort(),
      companyCounts: countBy(entries, (e) => e.company),
      sourceTypes: countBy(entries, (e) => e.sourceType ?? 'live-crawl'),
      cacheFiles: files.json.filter((f) => JD_FILE_RE.test(f.split(/[\\/]/).pop())).map(rel),
      historyFiles: files.history.map(rel),
      chars: entries.reduce((s, e) => s + e.excerpt.length + e.title.length, 0),
      newestCrawl: entries.reduce((max, e) => (e.crawledAt > max ? e.crawledAt : max), ''),
    },
    weightsByCategory: categoryWeights(skills),
    skills,
  };

  const out = opts.out ?? join(cacheDir, 'skills.json');
  await writeJsonAtomic(out, payload);
  console.log(`skills.json：${skills.length} 个技术栈标签（JD ${entries.length} 条 / ${payload.corpus.chars} 字符）→ ${rel(out)}`);
  console.log(`  类别权重：${Object.entries(payload.weightsByCategory).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  Top 10：${skills.slice(0, 10).map((s) => `${s.tag}(${s.mentions})`).join('  ')}`);
  console.log(`  数据源：${Object.entries(payload.corpus.sourceTypes).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  if (opts.offline) console.log('  离线模式：只用 content/jd-cache 缓存与 history/*.md，不联网');
  return payload;
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { booleans: ['offline', 'help'] });
  } catch (err) {
    console.error(`${err.message}\n用法：node scripts/jd/extract-skills.mjs [--offline] [--min-mentions N] [--out <file>]`);
    process.exit(2);
    return;
  }
  if (args.help) {
    console.log('用法：node scripts/jd/extract-skills.mjs [--offline] [--min-mentions N] [--out content/jd-cache/skills.json]');
    return;
  }
  try {
    const out = args.out ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)) : undefined;
    if (args.minMentions !== undefined && !(Number(args.minMentions) >= 1)) {
      throw new UsageError(`--min-mentions 需要 ≥1 的整数，收到 "${args.minMentions}"`);
    }
    await runExtractSkills({ offline: Boolean(args.offline), out, minMentions: args.minMentions === undefined ? 1 : Number(args.minMentions) });
  } catch (err) {
    console.error(`✗ ${err instanceof UsageError ? err.message : `技术栈抽取失败：${err.message}`}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();
