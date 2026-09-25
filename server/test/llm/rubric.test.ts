import { describe, expect, it } from 'vitest';
import { Question, type LlmProviderKind, type RubricVerdict } from '@arena/shared';
import type { LlmProvider } from '../../src/llm/provider.js';
import { config } from '../../src/config.js';
import { buildPrompt, createGrader, grade, parseModelOutput } from '../../src/llm/rubric.js';

/**
 * 主观题评分的行为测试：全部走**假 provider**（直接传 providers 数组），
 * 不 spawn 任何 CLI，因此可以断言降级链与解析健壮性而不依赖网络。
 */

const sysDesign = Question.parse({
  id: 'sys-design-feed-0001',
  category: 'system-design',
  difficulty: 'senior',
  title: '设计十亿日活的 Feed 排序服务',
  statement:
    '为 Apple News 设计一个支撑 10 亿日活的 Feed 生成与排序服务，给出容量估算、存储选型与降级策略。',
  judgeKind: 'llm-rubric',
  tags: ['feed', 'capacity-estimation'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '容量估算', weight: 3, criteria: '从 DAU 推到 QPS 与存储增量' },
      { label: '存储选型', weight: 4, criteria: 'fan-out 写扩散 vs 读扩散的取舍' },
      { label: '降级策略', weight: 3, criteria: '排序模型不可用时回退时间线' },
    ],
  },
  answer: '参考解：先给 QPS=11.6k，再谈写扩散。',
  source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19' },
});

const otherQuestion = Question.parse({
  id: 'agent-design-rag-0002',
  category: 'agent-design',
  difficulty: 'principal',
  title: '为客服场景设计带评测的 RAG Agent',
  statement: '设计一个客服 RAG Agent，说明检索、工具调用与离线评测如何闭环。',
  judgeKind: 'llm-rubric',
  tags: ['rag'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '检索质量', weight: 5, criteria: 'rerank + 覆盖率' },
      { label: '评测闭环', weight: 5, criteria: '线上 A/B 与离线回归' },
    ],
  },
  source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19' },
});

const CANDIDATE_ANSWER = '我会在接入层做写扩散，用 Cassandra 存时间线，QPS 大约 12k。';

function fakeProvider(opts: {
  kind: LlmProviderKind;
  reply?: string | (() => Promise<string>);
  available?: boolean;
  error?: Error;
  record?: string[];
  model?: string;
}): LlmProvider {
  return {
    kind: opts.kind,
    ...(opts.model ? { model: opts.model } : {}),
    async available() {
      opts.record?.push(`${opts.kind}:available`);
      return opts.available ?? true;
    },
    async complete(_prompt: string) {
      opts.record?.push(`${opts.kind}:complete`);
      if (opts.error) throw opts.error;
      const r = opts.reply ?? '';
      return typeof r === 'function' ? r() : r;
    },
  };
}

const json8 = JSON.stringify({
  score: 8,
  maxScore: 99,
  bonus: ['给出了写扩散的具体分片键'],
  gaps: ['没算存储增量'],
  rubricBreakdown: [
    { label: '容量估算', hit: true, earned: 3, nextStep: '补 QPS 到存储层换算' },
    { label: '存储选型', hit: true, earned: 3 },
    { label: '降级策略', hit: false, earned: 0, nextStep: '说明回退时间线的触发条件' },
  ],
});

describe('buildPrompt', () => {
  it('只含题面、rubric 判据与候选人答案', () => {
    const p = buildPrompt(sysDesign, CANDIDATE_ANSWER);
    expect(p).toContain(sysDesign.statement);
    expect(p).toContain('容量估算');
    expect(p).toContain('从 DAU 推到 QPS 与存储增量');
    expect(p).toContain(CANDIDATE_ANSWER);
    expect(p).toContain('JSON');
  });

  it('不含其他题目内容、不含参考解、不含本机路径（rule.md C7 + 规格「提示词与题目内容边界」）', () => {
    const p = buildPrompt(sysDesign, CANDIDATE_ANSWER);
    expect(p).not.toContain(otherQuestion.title);
    expect(p).not.toContain(otherQuestion.statement);
    expect(p).not.toContain(sysDesign.title);
    expect(p).not.toContain(sysDesign.id);
    expect(p).not.toContain('参考解');
    expect(p).not.toContain(config.repoRoot);
    expect(p).not.toContain(config.dataDir);
    expect(p).not.toMatch(/\/Users\/|[A-Za-z]:[\\/]{1,2}Users/);
  });
});

describe('parseModelOutput', () => {
  it('剥 ```json fence 并取第一个平衡对象（字符串里的花括号不干扰）', () => {
    const raw = '好的，这是我的评分：\n```json\n{"score":7,"bonus":["a] }b"],"gaps":[],"rubricBreakdown":[]}\n```\n希望有用';
    const v = parseModelOutput(raw, sysDesign);
    expect(v?.score).toBe(7);
    expect(v?.bonus).toEqual(['a] }b']);
  });

  it('score 越界被 clamp 到 0..maxScore', () => {
    expect(parseModelOutput('{"score":14}', sysDesign)?.score).toBe(10);
    expect(parseModelOutput('{"score":-3}', sysDesign)?.score).toBe(0);
    expect(parseModelOutput('{"score":8.6}', sysDesign)?.score).toBe(9);
  });

  it('label 不在题面 rubric 内的条目被丢弃；earned 归一到 weight 或 0', () => {
    const v = parseModelOutput(
      '{"score":6,"rubricBreakdown":[{"label":"幻觉考点","hit":true,"earned":10},{"label":"容量估算","hit":true,"earned":2},{"label":"存储选型","hit":false,"earned":0}]}',
      sysDesign,
    );
    expect(v?.rubricBreakdown.map((b) => b.label)).toEqual(['容量估算', '存储选型', '降级策略']);
    expect(v?.rubricBreakdown[0]?.earned).toBe(3);
    expect(v?.rubricBreakdown[1]?.earned).toBe(0);
    // 题面里没提到的考点自动补 0 分未命中，保证反馈密度
    expect(v?.rubricBreakdown[2]).toMatchObject({ hit: false, earned: 0 });
  });

  it('breakdown 之和与 score 差异 >1 时以 score 为准、保留 breakdown', () => {
    const v = parseModelOutput(
      '{"score":9,"rubricBreakdown":[{"label":"容量估算","hit":false,"earned":0},{"label":"存储选型","hit":false,"earned":0},{"label":"降级策略","hit":false,"earned":0}]}',
      sysDesign,
    );
    expect(v?.score).toBe(9);
    expect(v?.rubricBreakdown.reduce((s, b) => s + b.earned, 0)).toBe(0);
  });

  it('不含 JSON 或 score 非法 → null（调用方据此降级）', () => {
    expect(parseModelOutput('这道题答得不错，给 8 分吧。', sysDesign)).toBeNull();
    expect(parseModelOutput('{"score":"八"}', sysDesign)).toBeNull();
    expect(parseModelOutput('{"score":8', sysDesign)).toBeNull();
    expect(parseModelOutput('{"score":null}', sysDesign)).toBeNull();
  });

  it('模型把候选人答案里的英文引号原样塞进字符串 → 仍然解析出来（不白等 70 秒）', () => {
    // 真实翻车样本（2026-09-19，评分跑了 72s 后因为 JSON 非法被整条丢掉）
    const raw =
      '{"score":3,"bonus":["用"展示价≠成交价差异率 < 0.1%"作为红线 SLI，方向正确"],"gaps":[],"rubricBreakdown":[{"label":"容量估算","hit":true,"earned":3,"nextStep":"补一句"20% 日热"的口径"}]}';
    const v = parseModelOutput(raw, sysDesign);
    expect(v?.score).toBe(3);
    expect(v?.bonus).toEqual(['用"展示价≠成交价差异率 < 0.1%"作为红线 SLI，方向正确']);
    expect(v?.rubricBreakdown[0]?.nextStep).toContain('"20% 日热"');
  });

  it('已转义的引号不被二次破坏，结构性引号不误判', () => {
    const v = parseModelOutput('{"score":6,"bonus":["他说\\"够了\\"就停"],"gaps":[],"rubricBreakdown":[]}', sysDesign);
    expect(v?.bonus).toEqual(['他说"够了"就停']);
  });

  it('模型回显了 prompt 里的示例 JSON 时，取"真正在评本题"的那个对象', () => {
    // 示例本体长这样（buildPrompt 会把它写进提示词）：label「容量估算」恰好也是本题考点，
    // 只认第一个 { 就会把没人评过的 8/10 当成结论。
    const echoed = '{"score":8,"bonus":["..."],"gaps":["..."],"rubricBreakdown":[{"label":"容量估算","hit":true,"earned":3,"nextStep":"..."}]}';
    const real = '{"score":4,"bonus":[],"gaps":[],"rubricBreakdown":[{"label":"容量估算","hit":true,"earned":3},{"label":"存储选型","hit":true,"earned":1},{"label":"降级策略","hit":false,"earned":0}]}';
    const v = parseModelOutput(`按格式要求先来一份示例：\n${echoed}\n以下是我的评分：\n${real}`, sysDesign);
    expect(v?.score).toBe(4);
    expect(v?.rubricBreakdown[2]?.hit).toBe(false);
  });

  it('第一个对象残缺时继续往后找，而不是整条判为不可解析', () => {
    const v = parseModelOutput('{"score":,}\n真正的：{"score":7,"rubricBreakdown":[{"label":"容量估算","hit":true,"earned":3}]}', sysDesign);
    expect(v?.score).toBe(7);
  });
});

describe('grade：provider 降级链', () => {
  it('正常 JSON → provider qodercli、满分 10、加分/不足点、耗时与 raw 齐全', async () => {
    const calls: string[] = [];
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', reply: json8, record: calls }),
      fakeProvider({ kind: 'copilot', reply: '{"score":1}', record: calls }),
    ]);
    expect(calls).toEqual(['qodercli:available', 'qodercli:complete']);
    expect(v.provider).toBe('qodercli');
    expect(v.score).toBe(8);
    expect(v.maxScore).toBe(10);
    expect(v.bonus).toEqual(['给出了写扩散的具体分片键']);
    expect(v.gaps).toEqual(['没算存储增量']);
    expect(v.rubricBreakdown).toHaveLength(3);
    expect(v.durationMs).toBeGreaterThanOrEqual(0);
    expect(v.raw).toContain('"score":8');
  });

  it('maxScore 由题目决定，不接受模型给的 maxScore', async () => {
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [fakeProvider({ kind: 'qodercli', reply: json8 })]);
    expect(v.maxScore).toBe(sysDesign.rubric!.maxScore);
  });

  it('fence / 前后废话 / 越界分数都能兜住', async () => {
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', reply: `评分如下：\n\`\`\`json\n${json8.replace('"score":8', '"score":13')}\n\`\`\`\n以上。` }),
    ]);
    expect(v.score).toBe(10);
    expect(v.provider).toBe('qodercli');
  });

  it('provider 输出无法解析 → 降级下一档', async () => {
    const calls: string[] = [];
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', reply: '我觉得这题答得挺好', record: calls }),
      fakeProvider({ kind: 'copilot', reply: json8, record: calls }),
    ]);
    expect(v.provider).toBe('copilot');
    expect(v.score).toBe(8);
    expect(calls).toEqual([
      'qodercli:available',
      'qodercli:complete',
      'copilot:available',
      'copilot:complete',
    ]);
  });

  it('provider 抛错（CLI 超时/非零退出）→ 降级下一档', async () => {
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', error: new Error('qodercli 超时被杀死'), available: true }),
      fakeProvider({ kind: 'copilot', reply: json8 }),
    ]);
    expect(v.provider).toBe('copilot');
  });

  it('available()=false 的档直接跳过（不发 complete）', async () => {
    const calls: string[] = [];
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', available: false, reply: json8, record: calls }),
      fakeProvider({ kind: 'copilot', reply: json8, record: calls }),
    ]);
    expect(calls).toEqual(['qodercli:available', 'copilot:available', 'copilot:complete']);
    expect(v.provider).toBe('copilot');
  });

  it('全部失败 → provider manual 的自检表：全 0 命中 + raw 说明原因，不抛异常', async () => {
    const v: RubricVerdict = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', error: new Error('spawn qodercli ENOENT') }),
      fakeProvider({ kind: 'copilot', available: false }),
    ]);
    expect(v.provider).toBe('manual');
    expect(v.score).toBe(0);
    expect(v.maxScore).toBe(10);
    expect(v.rubricBreakdown.map((b) => [b.label, b.hit, b.earned])).toEqual([
      ['容量估算', false, 0],
      ['存储选型', false, 0],
      ['降级策略', false, 0],
    ]);
    expect(v.raw).toContain('spawn qodercli ENOENT');
    expect(v.rubricBreakdown.every((b) => !!b.nextStep)).toBe(true);
  });

  it('available() 自己抛错也不 5xx', async () => {
    const boom = fakeProvider({ kind: 'qodercli', reply: '' });
    boom.available = async () => {
      throw new Error('探测炸了');
    };
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [boom]);
    expect(v.provider).toBe('manual');
  });

  it('model 透传，raw 截断到 4000 字符', async () => {
    const v = await grade(sysDesign, CANDIDATE_ANSWER, [
      fakeProvider({ kind: 'qodercli', model: 'qoder-max', reply: json8 + 'x'.repeat(10_000) }),
    ]);
    expect(v.model).toBe('qoder-max');
    expect(v.raw.length).toBeLessThanOrEqual(4100);
    expect(v.raw).toContain('[truncated]');
  });

  it('题目没有 rubric 时不崩，落到 manual', async () => {
    const bare = { ...sysDesign, rubric: undefined } as typeof sysDesign;
    const v = await grade(bare, CANDIDATE_ANSWER, [fakeProvider({ kind: 'qodercli', reply: json8 })]);
    expect(v.provider).toBe('manual');
    expect(v.rubricBreakdown).toEqual([]);
    expect(v.raw).toContain('rubric');
  });

  it('空答案也照走评分（由模型给 0 分），provider 失败时同样兜底', async () => {
    const v = await grade(sysDesign, '', [fakeProvider({ kind: 'qodercli', reply: '{"score":0,"bonus":[],"gaps":[],"rubricBreakdown":[]}' })]);
    expect(v.score).toBe(0);
  });
});

describe('createGrader().available()：评分链可用性探测', () => {
  it('任一 LLM 档可用即 true，并短路后续档（不逐档等 CLI）', async () => {
    const record: string[] = [];
    const grader = createGrader([
      fakeProvider({ kind: 'qodercli', available: false, record }),
      fakeProvider({ kind: 'copilot', available: true, record }),
      fakeProvider({ kind: 'qodercli', available: true, record }),
    ]);
    await expect(grader.available()).resolves.toBe(true);
    expect(record).toEqual(['qodercli:available', 'copilot:available']);
  });

  it('只剩 manual 兜底档 = 拿不到本机模型 → false（不把"接口不报错"当"能评分"）', async () => {
    const grader = createGrader([
      fakeProvider({ kind: 'qodercli', available: false }),
      fakeProvider({ kind: 'manual' }),
    ]);
    await expect(grader.available()).resolves.toBe(false);
  });

  it('某档探测抛错 → 跳过该档继续下一档，不整体炸', async () => {
    const throwing: LlmProvider = {
      kind: 'qodercli',
      async available() {
        throw new Error('spawn 失败');
      },
      async complete() {
        return json8;
      },
    };
    await expect(createGrader([throwing, fakeProvider({ kind: 'copilot', available: true })]).available()).resolves.toBe(true);
    await expect(createGrader([throwing]).available()).resolves.toBe(false);
  });
});
