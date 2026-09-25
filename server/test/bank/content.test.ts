import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicBankRow, publicQuestion } from '@arena/shared';
import { loadBank } from '../../src/bank/loader.js';
import { statementHash } from '../../src/bank/ingest.js';
import { config } from '../../src/config.js';
import { registeredKinds } from '../../src/judge/registry.js';
import { registerOptionalRunners } from '../../src/judge/runners/index.js';

/**
 * A 段（结构校验）任何时刻都必须为绿：出题 agent 每加一批题就跑它。
 * B 段（覆盖度闸门）只在最终验收时打开（ARENA_FULL_GATE=1），
 * 否则内容还没写完时会因为"题数不够"报红，误导排查。
 */
const FULL_GATE = process.env.ARENA_FULL_GATE === '1';

/** 与 PM 定下的 30 天配比一致（96 题 ≈ 30 天 × 3 题 + 冗余）。 */
const MINIMUMS: Record<string, number> = {
  'big-data': 20,
  algorithms: 18,
  sql: 16,
  'system-design': 14,
  frontend: 12,
  'agent-design': 10,
  'hot-interviews': 6,
};

const bank = await loadBank(config.bankDir);

describe('题库结构（必须始终通过）', () => {
  it(`没有解析失败的题目文件（实际 ${bank.errors.length} 个错）`, () => {
    expect(
      bank.errors.map((e) => `${e.file}: ${e.message}`).slice(0, 20),
      '题库里有非法题目',
    ).toEqual([]);
  });

  it('id 唯一且题面不重复', () => {
    const ids = bank.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hashes = bank.questions.map((q) => statementHash(q.statement));
    expect(new Set(hashes).size, `重复题面：${hashes.length - new Set(hashes).size} 个`).toBe(hashes.length);
  });

  it('每题都有入库时间与来源', () => {
    for (const q of bank.questions) {
      expect(q.source.ingestedAt, `${q.id} 缺 ingestedAt`).toBeTruthy();
      expect(q.source.origin, `${q.id} 缺 origin`).toBeTruthy();
      expect(new Date(q.source.ingestedAt).getTime(), `${q.id} 的 ingestedAt 不是合法时间`).not.toBeNaN();
    }
  });

  it('代码题至少 3 个用例、有参考解，其中至少 1 个边界用例', () => {
    for (const q of bank.questions.filter((item) => item.judgeKind !== 'llm-rubric')) {
      const names = (q.cases ?? []).map((c) => c.name).join(' ');
      expect(q.cases?.length ?? 0, `${q.id} 用例不足`).toBeGreaterThanOrEqual(3);
      expect(q.runner?.referenceSolution, `${q.id} 缺参考解`).toBeTruthy();
      expect(/空|边界|极大|超大|并列|单|零|null|重复|无序|极长|退化/.test(names), `${q.id} 没有边界用例：${names}`).toBe(true);
    }
  });

  it('每道代码题的 judgeKind 都得有已实现的判题器（防"排进套餐却永远判不了分"）', async () => {
    await registerOptionalRunners();
    const kinds = new Set(registeredKinds());
    const orphans = bank.questions
      .filter((q) => q.judgeKind !== 'llm-rubric' && !kinds.has(q.judgeKind))
      .map((q) => `${q.id}:${q.judgeKind}`);
    expect(orphans).toEqual([]);
  });

  it('主观题 rubric 合计 10 分且至少 3 个考点', () => {
    for (const q of bank.questions.filter((item) => item.judgeKind === 'llm-rubric')) {
      expect(q.rubric?.points.length ?? 0, `${q.id} 考点太少`).toBeGreaterThanOrEqual(3);
      expect(
        (q.rubric?.points ?? []).reduce((sum, p) => sum + p.weight, 0),
        `${q.id} 权重合计不是 10`,
      ).toBe(10);
    }
  });

  it('标签是 kebab-case 且每题不超过 6 个', () => {
    for (const q of bank.questions) {
      expect(q.tags.length, `${q.id} 标签过多`).toBeLessThanOrEqual(6);
      for (const tag of q.tags) {
        expect(/^[a-z0-9][a-z0-9:._-]*$/.test(tag), `${q.id} 标签不规范：${tag}`).toBe(true);
      }
      expect(new Set(q.tags).size, `${q.id} 标签有重复`).toBe(q.tags.length);
    }
  });

  it('答案里点名的『用例「X」』必须真存在（用例改名后文案不会自己跟上）', () => {
    const stale: string[] = [];
    for (const q of bank.questions) {
      const names = (q.cases ?? []).map((c) => c.name);
      const text = `${q.answer ?? ''}\n${q.statement ?? ''}`;
      for (const m of text.matchAll(/用例「([^」]+)」/g)) {
        const ref = m[1];
        if (!ref) continue;
        // 允许答案把长用例名缩写（或反过来引用得更细），两个方向的包含都算命中
        if (!names.some((name) => name === ref || name.includes(ref) || ref.includes(name))) {
          stale.push(`${q.id}: 答案点名「${ref}」，现有用例 ${JSON.stringify(names)}`);
        }
      }
    }
    expect(stale, `对不上号的用例引用：\n${stale.join('\n')}`).toEqual([]);
  });
});

/**
 * 答案里写死的数字必须有来源。
 * 容器判题矩阵只证明"朴素解整体不通过"，不证明答案里那句"三口径在基线上是 1 / 1 / 2"
 * 或"按上游那个错窗口算会被丢掉"对得上**已入库的那份数据**。
 * 探针（`scripts/bank/drafts/<公司>/probe_naive.py`）负责量这些数字，
 * 这里负责让"改了答案没人复算"这件事当天变红 —— 写在文档里的"记得跑"不是闸门。
 */
const python = ['python3', 'python']
  .map((cmd) => ({ cmd, res: spawnSync(cmd, ['--version'], { encoding: 'utf8' }) }))
  .find(({ res }) => res.status === 0)?.cmd ?? null;

const draftRoot = join(config.repoRoot, 'scripts', 'bank', 'drafts');
const probes = existsSync(draftRoot)
  ? readdirSync(draftRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(draftRoot, entry.name, 'probe_naive.py'))
      .filter((file) => existsSync(file))
      .map((file) => file.slice(config.repoRoot.length + 1).split(sep).join('/'))
      .sort()
  : [];

describe('列表响应的体积（N-15：整表一次拉回，但只拉够筛够渲染的字段）', () => {
  // 用**真题库**量，不用假题库：假题库的题面是一行句子，量出来的比例会骗人
  // （实测在假题库上是 28%，在真题库上是 7.3%：252 题 full 980KB → slim 72KB）。
  const fullBytes = JSON.stringify(bank.questions.map((q) => publicQuestion(q))).length;
  const slimBytes = JSON.stringify(bank.questions.map(publicBankRow)).length;

  it('真实题库上，列表行比完整题面小一个量级', () => {
    expect(bank.questions.length, '题库为空的话这两条都是空转').toBeGreaterThan(100);
    const ratio = slimBytes / fullBytes;
    // 阈值留到 15%（实测 7.3%）：为的是"以后有人往行里塞回正文"会先红，而不是把数字钉死
    expect(ratio, `slim ${slimBytes}B / full ${fullBytes}B`).toBeLessThan(0.15);
  });

  it('列表行里没有题面、没有用例内容、也没有答案', () => {
    const raw = JSON.stringify(bank.questions.map(publicBankRow));
    for (const forbidden of ['"statement"', '"cases"', '"answer"', 'referenceSolution', '"rubric"']) {
      expect(raw.includes(forbidden), `列表响应里出现了 ${forbidden}`).toBe(false);
    }
  });
});

describe('答案里的具体数字（草稿探针）', () => {
  it('至少有一个探针在跑（空清单等于这条闸门是装饰）', () => {
    expect(probes.length).toBeGreaterThanOrEqual(1);
  });

  // 宿主机与容器都有 python；真没有时明确 skip，而不是"看起来绿了"
  it.skipIf(!python)('每个探针都退出 0，且确实量到了东西', () => {
    for (const probe of probes) {
      const res = spawnSync(python as string, [probe], {
        cwd: config.repoRoot,
        encoding: 'utf8',
        // 不指定就按 Windows 的 cp936 输出，探针里的 `⇒`/`✗` 会直接把 print 炸掉，
        // 于是这里只看到"空输出"而不是真错。容器里本来就是 UTF-8。
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      // 探针的契约是"退出码即结论"（apple 那份把不一致记成 exit 1，deepseek 那份同理），
      // 这里只再要求它真的报了东西 —— 一个什么都不比的探针不该看起来像通过。
      expect(res.stdout.trim().length, `${probe} 没有任何输出`).toBeGreaterThan(50);
      expect(res.status, `${probe} 失败：\n${res.stdout}\n${res.stderr}`).toBe(0);
    }
  });
});

/**
 * 公司维度（N-12）。这里刻意**不是**目标门禁：目标定成"每家 50"会在题没写完时天天红，
 * 红久了就没人看，等于没有。地板记的是"已达到的进度"，只用来拦"某家变少了"。
 * `code` 单独记一条地板：WI-56 的教训是"靠主观题凑满 30 等于没达标"，
 * 只看总数会把这种退步报成绿灯。
 * ｜地板里的数一律取本闸门实测值，不取交接文档里人肉数过的数 ——
 * ｜第一次跑就把 WI-56 写的"代码 10 / 15 / 16"纠成 9 / 14 / 16（三种独立数法一致）。
 */
const COMPANY_FLOORS: Record<string, { total: number; code: number }> = {
  // 2026-09-25 各抬一格：Airbnb 多了 `sql-mysql-0036`（预订占用对账），
  // DeepSeek 多了 `alg-java-0059`（epoll LT/ET 的唤醒计数）。都是"有出处 + 容器判过 + 朴素解会挂"的题。
  Airbnb: { total: 31, code: 10 },
  Apple: { total: 30, code: 14 },
  DeepSeek: { total: 31, code: 17 },
  PDD: { total: 30, code: 18 },
  ByteDance: { total: 30, code: 18 },
  // 阿里：32 题里 20 道可机器判（java 7 / mysql 6 / redis 2 / pyspark 2 / spark-scala 1 / react-vitest 2）。
  // 到 30 题收口时 frontend 一度是 0（两份公司向素材都明写阿里前端/客户端栈无可核查的机制文档，
  // 为凑类别去开 react-vitest 题等于把"凭猜"写进题库）。后来补了专门的向素材
  // `content/knowledge/hot-interviews/alibaba-frontend-and-open-source.md`（29 条来源逐条给 URL＋tag＋访问日期），
  // 两道题只建在能抓到原文的机制上（qiankun 沙箱降级与样式改写、useRequest 竞态与轮询），
  // 所以现在**七类全覆盖**：frontend=2 这个地板是"有出处才有一题"的结果，别拿它当凑数的先例。
  Alibaba: { total: 32, code: 20 },
};

describe('公司维度（报告 + 只减不许，N-12）', () => {
  const companyRows = () =>
    Object.entries(COMPANY_FLOORS).map(([company, floor]) => {
      const items = bank.questions.filter((q) => q.source.company === company);
      const code = items.filter((q) => q.judgeKind !== 'llm-rubric').length;
      const byCategory = new Map<string, number>();
      for (const q of items) byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
      const weakest = [...byCategory.entries()].sort((a, b) => a[1] - b[1])[0];
      return { company, total: items.length, code, floor, weakest };
    });

  it('报出每家的题数、可机器判数与最弱类别（进度不该只靠人记得去数）', () => {
    const rows = companyRows();
    for (const row of rows) {
      const behind =
        row.total > row.floor.total || row.code > row.floor.code
          ? `｜地板还停在 总${row.floor.total}/代码${row.floor.code}，该抬`
          : '';
      console.log(
        `[公司] ${row.company}：${row.total} 题（可机器判 ${row.code}）` +
          `｜最弱类别 ${row.weakest ? `${row.weakest[0]} 只有 ${row.weakest[1]}` : '无'}${behind}`,
      );
    }
    const untagged = bank.questions.filter((q) => !q.source.company).length;
    console.log(`[公司] 无 company 标签：${untagged} 题（早期按类别出的，不回填 —— 回填等于伪造出处）`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('任何一家的题数不得少于地板（C5 的追加式在公司粒度上也不许破）', () => {
    const below = companyRows().flatMap((row) => [
      ...(row.total < row.floor.total ? [`${row.company} 总数只剩 ${row.total}（地板 ${row.floor.total}）`] : []),
      ...(row.code < row.floor.code ? [`${row.company} 可机器判只剩 ${row.code}（地板 ${row.floor.code}）`] : []),
    ]);
    expect(below, below.join('; ')).toEqual([]);
  });

  it('地板只能由真实进度抬升（写一个够不着的数等于把闸门调成常亮）', () => {
    const inflated = companyRows()
      .filter((row) => row.floor.total > row.total || row.floor.code > row.code)
      .map((row) => `${row.company} 地板 总${row.floor.total}/代码${row.floor.code} > 实际 总${row.total}/代码${row.code}`);
    expect(inflated, inflated.join('; ')).toEqual([]);
  });
});

/**
 * 出处的可核查性。写 `knowledgeRef` 的意义是"下次有人怀疑这道题时，能翻回原文"——
 * 指到一个不存在的路径，比空着更坏（空着至少不假装查得到）。
 * 锚点（`#考点 7（…）`）是人写的说明，不判；只判**路径**与**前缀**。
 */
describe('出处可核查（knowledgeRef）', () => {
  /** ref 的常见写法：`content/knowledge/x.md#4 考点 7（…）` 或 `data/kb-txt/y.txt §16.2（…）`。 */
  const pathOf = (ref: string) => ref.split(/[\s#（(]/)[0] ?? '';
  const refs = bank.questions.map((q) => ({ id: q.id, company: q.source.company, ref: q.source.knowledgeRef ?? '' }));

  it('有公司标签的题必须写 knowledgeRef（回填等于伪造出处，空着才是"我知道这题没出处"）', () => {
    const bare = refs.filter((r) => r.company && !r.ref).map((r) => r.id);
    expect(bare, `带 company 却没出处：${bare.join(', ')}`).toEqual([]);
  });

  it('ref 指向的仓库内路径必须真实存在', () => {
    const bad = refs
      .filter((r) => r.ref)
      .map((r) => ({ ...r, path: pathOf(r.ref) }))
      .filter((r) => !r.path.startsWith('content/') && !r.path.startsWith('data/'))
      .map((r) => `${r.id} 的前缀不是 content/ 也不是 data/：${r.path}`);
    const missing = refs
      .filter((r) => r.ref)
      .map((r) => ({ ...r, path: pathOf(r.ref) }))
      .filter((r) => !existsSync(join(config.repoRoot, r.path)))
      .map((r) => `${r.id} → ${r.path}`);
    expect(bad, bad.join('; ')).toEqual([]);
    expect(missing, `出处指向不存在的文件：${missing.join('; ')}`).toEqual([]);
  });

  it('报一下有多少出处指向 gitignore 掉的抓取产物（N-13：换台机器就查不到）', () => {
    const inData = refs.filter((r) => pathOf(r.ref).startsWith('data/')).map((r) => r.id);
    console.log(
      `[出处] ${refs.filter((r) => r.ref).length} 道题有 knowledgeRef，其中 ${inData.length} 道指向 data/（未跟踪）。` +
        (inData.length ? ' 这批在干净 clone 里查不到原文，见 HANDOVER N-13。' : ''),
    );
    expect(refs.filter((r) => r.ref).length).toBeGreaterThan(0);
  });
});

/**
 * 知识库的语料不许变孤儿。
 * 为什么要管：`scripts/kb/kit.mjs` 早就把每类别目录下的 .md 列成 `topicFiles` 却没人消费，
 * 于是"新写一份语料放进来"等于没写 —— 出题时没人知道它存在（实测 34 篇里有 17 篇没被
 * 任何 README 链接，包括阿里/字节/拼多多三家全部新素材与 sql/frontend/algorithms 整类别）。
 * 判据用"文件名有没有出现在同类别 README 里"，而不是链接语法 —— 简单、且改个措辞不会误报。
 */
describe('知识库语料必须被该类别 README 收录', () => {
  // 知识库是出题素材、不是运行时依赖，所以路径在这里拼（config 里不留字段，免得又被当成服务配置）
  const kbRoot = join(config.repoRoot, 'content', 'knowledge');

  it('每类别目录下的 .md 都要在 README 里有入口', () => {
    const orphans: string[] = [];
    let counted = 0;
    for (const category of readdirSync(kbRoot, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const dir = join(kbRoot, category.name);
      const readmePath = join(dir, 'README.md');
      if (!existsSync(readmePath)) continue;
      const readme = readFileSync(readmePath, 'utf8');
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
        counted += 1;
        if (!readme.includes(file)) orphans.push(`${category.name}/${file}`);
      }
    }
    expect(counted, '一篇语料都没扫到（等于闸门失效）').toBeGreaterThan(20);
    expect(orphans, `这些语料没有任何入口，出题时没人会发现它：${orphans.join(', ')}`).toEqual([]);
  });
});

describe.skipIf(!FULL_GATE)('覆盖度闸门（最终验收）', () => {
  it('每个类别达到约定题量', () => {
    const low = Object.entries(MINIMUMS)
      .map(([category, minimum]) => {
        const count = bank.questions.filter((q) => q.category === category).length;
        return count < minimum ? `${category} 只有 ${count}（需 ${minimum}）` : null;
      })
      .filter((line): line is string => line !== null);
    expect(low, low.join('; ')).toEqual([]);
  });

  it('每类至少 40% 的题目带当年技术标记', () => {
    const weak = Object.keys(MINIMUMS)
      .map((category) => {
        const items = bank.questions.filter((q) => q.category === category);
        if (items.length === 0) return `${category} 空`;
        const modern = items.filter(
          (q) => Number(q.source.era ?? 0) >= 2025 || q.tags.some((t) => t.startsWith('modern:')),
        ).length;
        return modern / items.length >= 0.4 ? null : `${category} 新题占比 ${(modern / items.length) * 100}%`;
      })
      .filter(Boolean);
    expect(weak, weak.join('; ')).toEqual([]);
  });

  it('算法题里经典重复题不超过 15%', () => {
    const items = bank.questions.filter((q) => q.category === 'algorithms');
    const classic = items.filter((q) => q.tags.includes('classic:true') || q.tags.includes('classic')).length;
    expect(items.length).toBeGreaterThan(0);
    expect(classic / items.length, `经典老题 ${(classic / items.length) * 100}%`).toBeLessThanOrEqual(0.15);
  });
});
