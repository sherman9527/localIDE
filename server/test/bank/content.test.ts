import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAG_FACET_MIN_COUNT, buildTagAliasMap, canonicalTag, countQuestionsByCanonicalTag, publicBankRow, publicQuestion } from '@arena/shared';
import { loadBank } from '../../src/bank/loader.js';
import { statementHash } from '../../src/bank/ingest.js';
import { loadTagAliases } from '../../src/bank/tagAliases.js';
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

/**
 * 标签词表：闸门读它用的是**运行时的同一条路径**（`loadTagAliases()` + `config.tagsAliasesFile`），
 * 不是自己再拼一次文件名 —— 否则"容器里读不到 bind mount 的词表"这种故障会躲过闸门。
 */
const tagAliases = await loadTagAliases();

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

describe('标签词表的同义归并（N-17 的另一半：只在读时归并，题目数据一字不动）', () => {
  /**
   * 词表为什么能存在而不撞红线 C5：它**不在 `content/questions/**` 里**，
   * 两条出处指纹路径（`scripts/bank/drafts/check_provenance.py` 与 `server/src/bank/ingest.ts`）
   * 都只看题目文件，所以它既不改题目也不需要复核出处。这条判据本身也要被钉住（下面那条）。
   */
  const TAG_RE = /^[a-z0-9][a-z0-9:._-]*$/;
  const groups = tagAliases;
  const map = buildTagAliasMap(groups);

  it('词表读得出、且不是空的（两档共用同一条读取路径：config.tagsAliasesFile）', () => {
    expect(existsSync(config.tagsAliasesFile), `词表文件不存在：${config.tagsAliasesFile}`).toBe(true);
    // loadTagAliases() 对"读不到 / 不是合法 JSON / 形状不对"一律给空表（不炸启动），
    // 所以**空表就是它坏掉的信号** —— 这一条把"静默降级成不归并"判红（本仓库最怕的那种绿）。
    expect(groups.length, `词表里一条组都没有（文件坏了？路径 ${config.tagsAliasesFile}）`).toBeGreaterThan(0);
    // content/ 是 bind mount、server/ 是烤进镜像的：两档都必须在这里读到同一批组
    console.log(`[词表] ${config.tagsAliasesFile} 读出 ${groups.length} 组，${groups.reduce((n, g) => n + g.aliases.length, 0)} 条别名`);
  });

  it('词表不在题库目录里（在里面的话两条出处指纹路径都会看见它，C5 就被绕开了）', () => {
    const rel = config.tagsAliasesFile.startsWith(config.bankDir + sep) || config.tagsAliasesFile.startsWith(config.bankDir + '/');
    expect(rel, `词表落在了题库目录 ${config.bankDir} 里`).toBe(false);
    // 而且 loader 只认 `<类别>/<文件>.json`，落在 content/ 根上就不会被当成题目
    const filesInBankDir = readdirSync(config.bankDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json'));
    expect(filesInBankDir.map((e) => e.name), '题库目录根部出现了裸 JSON 文件，loader 会把它们当题目').toEqual([]);
  });

  it('每条 canonical 与 alias 都过题目用的那张标签正则', () => {
    const bad: string[] = [];
    for (const g of groups) {
      if (!TAG_RE.test(g.canonical)) bad.push(`${g.canonical}（canonical）`);
      for (const a of g.aliases) if (!TAG_RE.test(a)) bad.push(`${a}（alias of ${g.canonical}）`);
    }
    expect(bad, `不合法的词表项：${bad.join(', ')}`).toEqual([]);
  });

  it('形状规矩：每组至少一条别名、至少一行 reason，且 alias 不重复', () => {
    const bad = groups.flatMap((g) => [
      ...(g.aliases.length === 0 ? [`组 ${g.canonical} 一条别名都没有（不合并的登记是装饰）`] : []),
      ...(!g.reason || g.reason.trim().length < 4 ? [`组 ${g.canonical} 没有 reason（为什么这三个写法是同一件事）`] : []),
      ...(new Set(g.aliases).size !== g.aliases.length ? [`组 ${g.canonical} 组内有重复别名：${g.aliases.join(', ')}`] : []),
      ...(g.aliases.includes(g.canonical) ? [`组 ${g.canonical} 把自己列成了别名`] : []),
    ]);
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('没有链、没有一个别名属于两组、没有两组共用一个 canonical', () => {
    const canonicalOf = new Map<string, string>();
    const ownerOfAlias = new Map<string, string>();
    const bad: string[] = [];
    for (const g of groups) {
      if (canonicalOf.has(g.canonical)) bad.push(`${g.canonical} 是两组的 canonical（${canonicalOf.get(g.canonical)} 与 ${g.canonical}）`);
      canonicalOf.set(g.canonical, g.canonical);
      for (const a of g.aliases) {
        if (canonicalOf.has(a)) bad.push(`别名 ${a}（属于 ${g.canonical}）同时是另一组 ${canonicalOf.get(a)} 的 canonical —— 链`);
        if (ownerOfAlias.has(a)) bad.push(`别名 ${a} 同时登记在 ${ownerOfAlias.get(a)} 与 ${g.canonical} 两组`);
        ownerOfAlias.set(a, g.canonical);
      }
    }
    // 再核一遍"链"的另一半：canonical 自己不能是别人的别名（上面按登记顺序查，正反各来一次才不漏最后一组）
    for (const g of groups) {
      if (ownerOfAlias.has(g.canonical)) bad.push(`${g.canonical} 既是本组的 canonical，又是 ${ownerOfAlias.get(g.canonical)} 组的别名 —— 链`);
    }
    expect(bad, [...new Set(bad)].join('; ')).toEqual([]);
  });

  it('没有死别名：词表里的每条 alias 都真的出现在至少一道题上', () => {
    const used = new Set(bank.questions.flatMap((q) => q.tags));
    const dead = groups.flatMap((g) => g.aliases.filter((a) => !used.has(a)).map((a) => `${a}（→ ${g.canonical}）`));
    expect(dead, `这些别名没有任何一道题在用，删掉它们：${dead.join(', ')}`).toEqual([]);
  });

  it('归并真的在归并：从真题库算，同组写法收拢成一个名字，且 facet 只增不减', () => {
    const rawTags = new Set(bank.questions.flatMap((q) => q.tags));
    const canonTags = new Set(bank.questions.flatMap((q) => q.tags.map((t) => canonicalTag(t, map))));
    expect(
      canonTags.size,
      `归并没有收拢任何写法：归并前 ${rawTags.size} 种写法 → 归并后 ${canonTags.size} 个规范名`,
    ).toBeLessThan(rawTags.size);
    console.log(`[词表] 不同标签数：归并前 ${rawTags.size} 种写法 → 归并后 ${canonTags.size} 个规范名（并掉 ${rawTags.size - canonTags.size} 个）`);

    // facet 口径：两个数都走**交付里那一份** `countQuestionsByCanonicalTag`（空表 = 归并前）。
    // 这里刻意不再自己写一遍计数：自己写的那份永远不会因为"实现算错了"而红
    // —— 破坏性验证 D11b 就是这样撞出来的：把共享函数里的"一题只数一次"删掉，
    // 只调它的那条会红，自己另算一份的那条照样绿。
    const tagLists = bank.questions.map((q) => q.tags);
    const before = countQuestionsByCanonicalTag(tagLists, new Map());
    const after = countQuestionsByCanonicalTag(tagLists, map);
    const facetsBefore = new Set([...before.entries()].filter(([, c]) => c >= TAG_FACET_MIN_COUNT).map(([n]) => n));
    const facetsAfter = new Set([...after.entries()].filter(([, c]) => c >= TAG_FACET_MIN_COUNT).map(([n]) => n));
    expect(facetsAfter.size, `归并后 facet 反而变少（${facetsBefore.size} → ${facetsAfter.size}）：合并绝不会让一个已有筛选项消失`).toBeGreaterThanOrEqual(facetsBefore.size);
    console.log(`[词表] 出现 ≥${TAG_FACET_MIN_COUNT} 次的筛选项：归并前 ${facetsBefore.size} 个 → 归并后 ${facetsAfter.size} 个`);

    // 存在"靠归并才成为 facet"的组：组里每一种写法单独都不够门槛，合起来才够
    const born = groups
      .map((g) => ({ g, members: [g.canonical, ...g.aliases], merged: after.get(g.canonical) ?? 0 }))
      .filter(({ members, merged }) => merged >= TAG_FACET_MIN_COUNT && members.every((m) => (before.get(m) ?? 0) < TAG_FACET_MIN_COUNT));
    expect(
      born.length,
      `没有任何一组是"靠归并才凑满 ≥${TAG_FACET_MIN_COUNT} 次"的 —— 那词表就没在合并同义词，只是在改名`,
    ).toBeGreaterThan(0);
    console.log(
      `[词表] 因为归并才成为筛选项的组：` +
        born.map(({ g, members, merged }) => `${g.canonical}（${members.map((m) => `${m}:${before.get(m) ?? 0}`).join(' + ')} = ${merged}）`).join('；'),
    );
  });

  it('同一道题挂了同组两种写法时，题数只加一次（不是拼法的数量）', () => {
    // 真题里就有这个形状：sql-mysql-0019 同时写了 data-quality 与 dqc
    const coTagged = bank.questions.filter((q) => {
      const set = new Set(q.tags.map((t) => canonicalTag(t, map)));
      return set.size < q.tags.length;
    });
    console.log(`[词表] 同题共挂同组写法的题目：${coTagged.map((q) => q.id).join(', ') || '（无）'}`);
    const counts = countQuestionsByCanonicalTag(bank.questions.map((q) => q.tags), map);
    // 判据对**每一个规范名**都成立：facet 的 count 必须等于"挂了这一组任一写法的题目数"。
    // 写成"只查 data-quality 那一条"也行，但它抓不到"以后有人新加的组正好踩中另一个形状"。
    const wrong = [...counts.entries()].map(([name, count]) => {
      const members = new Set([name, ...(groups.find((g) => g.canonical === name)?.aliases ?? [])]);
      const holders = bank.questions.filter((q) => q.tags.some((t) => members.has(t))).length;
      return count === holders ? null : `${name}：facet 报 ${count}，实际挂了这组任一写法的题是 ${holders} 道`;
    }).filter((line): line is string => line !== null);
    expect(wrong, wrong.join('; ')).toEqual([]);
    const dq = counts.get('data-quality') ?? 0;
    const dqRaw = bank.questions.filter((q) => q.tags.includes('data-quality')).length;
    expect(dq, 'sql-mysql-0019 同时挂 data-quality 与 dqc，归并后题数不该变成 13').toBe(dqRaw);
  });

  it('归并判据只有一份：服务端与 web 都从 @arena/shared 引，不许各自再写一遍', () => {
    const read = (rel: string) => readFileSync(join(config.repoRoot, rel), 'utf8');
    const serverSide = read(join('server', 'src', 'api', 'app.ts'));
    const clientSide = read(join('web', 'src', 'pages', 'Bank.tsx'));
    for (const [name, src] of [['app.ts', serverSide], ['Bank.tsx', clientSide]] as const) {
      expect(src, `${name} 没有引入 shared 的归并判据`).toMatch(/tagMatches/);
      // 旧的两份各自实现：服务端 tags.some(tag => tag.toLowerCase() === ...)、客户端 q.tags.includes(tag)
      expect(src, `${name} 还留着自己写的精确匹配`).not.toMatch(/tags\.some\(\s*\(tag\)\s*=>\s*tag\.toLowerCase\(\)/);
      expect(src, `${name} 还留着 includes 精确匹配`).not.toMatch(/q\.tags\.includes\(tag\)/);
    }
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
