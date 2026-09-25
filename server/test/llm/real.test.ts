import { describe, expect, it } from 'vitest';
import { Question } from '@arena/shared';
import { grade } from '../../src/llm/rubric.js';
import { resolveProviders } from '../../src/llm/provider.js';

/**
 * 真实调用测试：会 spawn 本机已登录的 `qodercli`（单次 10-20s，且依赖登录态与外网），
 * 所以**默认 skip**，否则 CI / `npm run verify` 会变慢且不稳定。
 * 手动开启：`ARENA_LLM_REAL=1 npx vitest run server/test/llm`
 * （需求 tasks.md 6.1 的"三次漂移 ≤1"就在这里跑，跑完把极差写进 memo.md。）
 * verify-gate: manual —— 这条闸门故意不进 verify.sh：它要登录态、外网和 10-20s 一次的真机调用。
 */
const REAL = !!process.env.ARENA_LLM_REAL;

const question = Question.parse({
  id: 'sys-design-real-0004',
  category: 'system-design',
  difficulty: 'senior',
  title: '设计 Apple 设备遥测 ingestion 管道',
  statement:
    '为 Apple 设计每日 200 亿条设备遥测事件的 ingestion 与查询链路：给出容量估算、存储格式、以及实时看板与离线批处理的读路径取舍。',
  judgeKind: 'llm-rubric',
  tags: ['streaming', 'olap'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '容量估算', weight: 3, criteria: '从 2e10/天 推出峰值 QPS、写入带宽与年存量' },
      { label: '存储与格式', weight: 4, criteria: '列式格式 + 分区/排序键 + schema 演进' },
      { label: '读写路径取舍', weight: 3, criteria: '实时链路（秒级）与 OLAP（分钟级）如何分工与降级' },
    ],
  },
  source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19' },
});

const GOOD_ANSWER = [
  '估算：2e10 事件/天 ≈ 231k events/s 均值，按 3x 峰值约 700k events/s；平均 1KB → 入站 700MB/s，年存量约 7.3PB（未压缩）。',
  '写入：边缘网关做 batching + 压缩（zstd），Kafka 按 device_id 哈希分区，配 24h 保留当缓冲。',
  '存储：对象存储 + Parquet/ORC，分区键 date + region，排序键 (device_model, event_time)，用 Iceberg 管 schema 演进（新增字段不重写历史）。',
  '读路径：实时看板走流式预聚合（Flink 1 分钟窗口 → Redis/OLAP 物化表），明细查询走 Trino/ClickHouse；看板只查预聚合，避免扫全量。',
  '降级：流链路挂了自动回退到「5 分钟延迟的 OLAP 结果 + 明显的数据延迟水印」，而不是把过期数字当实时。',
].join('\n');

const WEAK_ANSWER = '我会用 Kafka 把数据收进来，然后存到 MySQL 里，前端定时刷新查询。';

describe.skipIf(!REAL)('真实 CLI 评分（ARENA_LLM_REAL=1 才跑）', () => {
  it(
    'qodercli 能给出 10 分制 + 加分点 + 不足点 + 逐项 breakdown',
    async () => {
      const providers = resolveProviders();
      console.log('provider chain:', providers.map((p) => p.kind).join(' → '));
      const v = await grade(question, GOOD_ANSWER, providers);
      console.log(JSON.stringify(v, null, 2));
      expect(v.provider).not.toBe('manual');
      expect(v.maxScore).toBe(10);
      expect(v.score).toBeGreaterThan(0);
      expect(v.rubricBreakdown).toHaveLength(3);
      expect(v.bonus.length + v.gaps.length).toBeGreaterThan(0);
      expect(v.raw.length).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    '空洞答案不该拿高分，且三次评分极差 ≤1（稳定性抽样，漂移记 memo）',
    async () => {
      const providers = resolveProviders();
      const scores: number[] = [];
      for (let i = 0; i < 3; i++) {
        const v = await grade(question, WEAK_ANSWER, providers);
        scores.push(v.score);
      }
      console.log('weak answer scores:', scores.join(', '));
      expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(1);
    },
    600_000,
  );
});
