import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Question } from '@arena/shared';
import { config } from '../../src/config.js';
import { resolveProviders } from '../../src/llm/provider.js';
import { locateBin, modelFromArgs, renderArgs } from '../../src/llm/cli.js';
import { QODER_ARGS_TEMPLATE, createQoderCliProvider, qoderArgs } from '../../src/llm/providers/qodercli.js';
import { createCopilotProvider } from '../../src/llm/providers/copilot.js';
import { manualProvider, manualVerdict } from '../../src/llm/providers/manual.js';

/**
 * provider 层的两个关注点：
 * 1) resolveProviders 的顺序语义（配置驱动，未知名字不炸）；
 * 2) CLI 型 provider 的 args 模板替换 / 超时 / 非零退出（**用 node 当替身 bin，绝不真调 qodercli**）。
 */

const question = Question.parse({
  id: 'sys-design-timeout-0003',
  category: 'system-design',
  difficulty: 'senior',
  title: '设计跨区域的对象存储网关',
  statement: '设计一个跨区域对象存储网关，说明一致性、成本与故障域隔离。',
  judgeKind: 'llm-rubric',
  tags: ['object-storage'],
  rubric: {
    maxScore: 10,
    points: [
      { label: '一致性', weight: 5, criteria: '强一致 vs 最终一致的取舍' },
      { label: '故障域', weight: 5, criteria: 'region 失效时的切换' },
    ],
  },
  source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19' },
});

/** 替身 CLI：把 argv 与 cwd 原样回显成 JSON，用来证明 prompt 是「单个 argv」且 cwd 是空临时目录。 */
const ECHO_SCRIPT =
  "import('node:fs').then((fs)=>process.stdout.write(JSON.stringify({argv: process.argv.slice(1), cwd: process.cwd(), entries: fs.readdirSync(process.cwd())})))";
const SLEEP_SCRIPT = 'setTimeout(()=>{}, 30_000)';
const FAIL_SCRIPT = 'process.stderr.write("boom: 未登录"); process.exit(4)';

const llmCfg = config.llm as unknown as Record<string, unknown>;
const mutableConfig = config as unknown as { dataDir: string };
let snapshot: Record<string, unknown>;
let dataDir: string;

beforeEach(async () => {
  snapshot = { ...llmCfg };
  dataDir = join(config.repoRoot, 'data', 'test-tmp', 'llm');
  await mkdir(dataDir, { recursive: true });
  mutableConfig.dataDir = dataDir;
  Object.assign(llmCfg, {
    qoderBin: process.execPath,
    copilotBin: process.execPath,
    qoderArgs: ['-e', ECHO_SCRIPT, '%PROMPT%'],
    copilotArgs: ['-e', ECHO_SCRIPT, '%PROMPT%'],
    timeoutMs: 20_000,
  });
});

afterEach(async () => {
  Object.assign(llmCfg, snapshot);
  mutableConfig.dataDir = join(config.repoRoot, 'data');
  await rm(dataDir, { recursive: true, force: true });
});

describe('resolveProviders', () => {
  it('需求场景 8 的优先顺序：本机 qodercli 先于 copilot，manual 永远兜底', () => {
    expect(resolveProviders(['qodercli', 'copilot', 'manual']).map((p) => p.kind)).toEqual([
      'qodercli',
      'copilot',
      'manual',
    ]);

    // 容器里 ARENA_LLM_PROVIDERS 会带上 bridge（宿主 CLI 桥自己先试 qodercli 再试 copilot，
    // 所以 bridge 在最前仍然是"本机 CLI 优先"的语义）。这里只断言不变式，不写死清单。
    const configured = resolveProviders().map((p) => p.kind);
    expect(configured.at(-1)).toBe('manual');
    expect(configured.filter((k) => k === 'qodercli' || k === 'copilot')).toEqual(['qodercli', 'copilot']);
  });

  it('按传入顺序，不擅自重排；manual 缺省时补到末尾', () => {
    expect(resolveProviders(['copilot', 'qodercli']).map((p) => p.kind)).toEqual(['copilot', 'qodercli', 'manual']);
    expect(resolveProviders(['copilot']).map((p) => p.kind)).toEqual(['copilot', 'manual']);
  });

  it('manual 永远最后（它是终态兜底，放前面会把 LLM 档短路掉）', () => {
    expect(resolveProviders(['manual', 'qodercli']).map((p) => p.kind)).toEqual(['qodercli', 'manual']);
  });

  it('未知名字与重复项被忽略；全未知也仍有 manual（接口层不得 5xx）', () => {
    expect(resolveProviders(['copilot', 'copilot']).map((p) => p.kind)).toEqual(['copilot', 'manual']);
    expect(resolveProviders(['gpt-Http-api', 'nope']).map((p) => p.kind)).toEqual(['manual']);
    expect(resolveProviders([]).map((p) => p.kind)).toEqual(['manual']);
  });

  it('不传参数时读 config.llm.providers', () => {
    Object.assign(llmCfg, { providers: ['copilot'] });
    expect(resolveProviders().map((p) => p.kind)).toEqual(['copilot', 'manual']);
  });
});

describe('args 模板（纯函数）', () => {
  it('默认 qodercli 模板是实测形态（-p --tools "" --output-format text "<prompt>"）', () => {
    Object.assign(llmCfg, { qoderArgs: undefined });
    expect(qoderArgs()).toEqual(['-p', '--tools', '', '--output-format', 'text', '%PROMPT%']);
    expect(qoderArgs()).toEqual([...QODER_ARGS_TEMPLATE]);
  });

  it('%PROMPT% 只替换成一个 argv 元素，位置随模板', () => {
    expect(renderArgs(QODER_ARGS_TEMPLATE, 'hi\nthere')).toEqual([
      '-p',
      '--tools',
      '',
      '--output-format',
      'text',
      'hi\nthere',
    ]);
    expect(renderArgs(['a', '%PROMPT%', 'b'], 'P')).toEqual(['a', 'P', 'b']);
    // 模板里没有 %PROMPT% 时把 prompt 追加到末尾，避免静默丢答案
    expect(renderArgs(['-p'], 'P')).toEqual(['-p', 'P']);
  });

  it('model 从 args 里能取到就取，取不到 undefined', () => {
    expect(modelFromArgs(['-p', '-m', 'claude-x'])).toBe('claude-x');
    expect(modelFromArgs(['--model=gpt-5'])).toBe('gpt-5');
    expect(modelFromArgs(['-p', '--tools', ''])).toBeUndefined();
  });
});

describe('qodercli provider（node 替身 bin）', () => {
  it('prompt 作为单个 argv 传入，绝不拼 shell 字符串', async () => {
    const provider = createQoderCliProvider();
    // 若被拼进 shell：$(rm -rf) 会被替换、& | > 会断开参数 → 断言"原样一个 argv"即证伪
    const nasty = '{"score":1} & echo PWNED | whoami > NUL "$(rm -rf)" \\ backslash\\';
    const out = await provider.complete(nasty);
    expect(out.trim().startsWith('{')).toBe(true); // 只有 stub 的 JSON，没有 shell 的额外输出
    const echoed = JSON.parse(out) as { argv: string[] };
    expect(echoed.argv).toEqual([nasty]);
  });

  it.runIf(process.platform === 'win32')(
    'win32：bin 只有 .cmd 垫片（npm 全局安装的典型形态）时**拒绝**经 cmd 传答案，并给出可执行指引',
    async () => {
      const shimDir = join(dataDir, 'shim');
      await mkdir(shimDir, { recursive: true });
      const shim = join(shimDir, 'fakecli.cmd');
      await writeFile(shim, '@echo off\r\nnode -e "process.stdout.write(String(process.argv.slice(2)))" %*\r\n');
      Object.assign(llmCfg, { qoderBin: shim });
      const provider = createQoderCliProvider();
      // 宁可降级 manual，也不把候选人答案拼进 cmd 命令行（cmd 的引号规则挡不住 & | >）
      await expect(provider.available()).resolves.toBe(false);
      await expect(provider.complete('hi & echo PWNED')).rejects.toThrow(/\.cmd 垫片|原生 exe/);
    },
  );

  it.runIf(process.platform === 'win32')(
    'win32：PATH 上同时有 .cmd 垫片与原生 exe 时优先原生 exe（本机 copilot 就是这种分布）',
    async () => {
      const shimDir = join(dataDir, 'path-shim');
      const exeDir = join(dataDir, 'path-exe');
      await mkdir(shimDir, { recursive: true });
      await mkdir(exeDir, { recursive: true });
      await writeFile(join(shimDir, 'arena-fake-cli.cmd'), '@echo off\r\n');
      await writeFile(join(exeDir, 'arena-fake-cli.exe'), '');
      const savedPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${exeDir}${delimiter}${savedPath ?? ''}`;
      try {
        expect(await locateBin('arena-fake-cli')).toBe(join(exeDir, 'arena-fake-cli.exe'));
      } finally {
        process.env.PATH = savedPath;
      }
    },
  );

  it('cwd 是 dataDir/llm-tmp 下的空临时目录（不是仓库根），调用后清理', async () => {
    const provider = createQoderCliProvider();
    const echoed = JSON.parse(await provider.complete('x')) as { cwd: string; entries: string[] };
    expect(echoed.cwd.startsWith(join(dataDir, 'llm-tmp'))).toBe(true);
    expect(echoed.cwd).not.toBe(config.repoRoot);
    expect(echoed.entries).toEqual([]);
    await expect(readdir(join(dataDir, 'llm-tmp'))).resolves.toEqual([]);
  });

  it('通过 config.llm.qoderArgs 覆盖整个模板即可换 CLI 版本', async () => {
    Object.assign(llmCfg, { qoderArgs: ['-e', 'process.stdout.write("OVERRIED:%PROMPT%")'] });
    expect(await createQoderCliProvider().complete('hi')).toBe('OVERRIED:hi');
  });

  it('超时 → 抛错（调用方据此降级），且真的杀掉了进程', async () => {
    Object.assign(llmCfg, { qoderArgs: ['-e', SLEEP_SCRIPT, '%PROMPT%'], timeoutMs: 400 });
    const t0 = Date.now();
    await expect(createQoderCliProvider().complete('slow')).rejects.toThrow(/timeout|超时/i);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('非零退出 → 抛错并带上 stderr 片段', async () => {
    Object.assign(llmCfg, { qoderArgs: ['-e', FAIL_SCRIPT, '%PROMPT%'] });
    await expect(createQoderCliProvider().complete('x')).rejects.toThrow(/未登录|exit 4/);
  });

  it('bin 不存在 → available()=false 且 complete 抛错（触发降级）', async () => {
    Object.assign(llmCfg, { qoderBin: 'definitely-not-installed-arena-cli-xyz' });
    const provider = createQoderCliProvider();
    await expect(provider.available()).resolves.toBe(false);
    await expect(provider.complete('x')).rejects.toThrow(/definitely-not-installed/);
  });

  it('model 取自 args 模板', () => {
    Object.assign(llmCfg, { qoderArgs: ['-p', '--model', 'qoder-max', '--output-format', 'text', '%PROMPT%'] });
    expect(createQoderCliProvider().model).toBe('qoder-max');
  });
});

describe('copilot provider', () => {
  it('可用时回显输出；探测失败即 available()=false', async () => {
    const provider = createCopilotProvider();
    expect(await provider.available()).toBe(true);
    const echoed = JSON.parse(await provider.complete('hello')) as { argv: string[] };
    expect(echoed.argv).toEqual(['hello']);

    Object.assign(llmCfg, { copilotArgs: ['-e', FAIL_SCRIPT] });
    await expect(createCopilotProvider().available()).resolves.toBe(false);
  });
});

describe('manual provider（终态兜底：不发进程也不发网络）', () => {
  it('available 恒 true，complete 给出 score=null 的自检表', async () => {
    expect(await manualProvider.available()).toBe(true);
    const parsed = JSON.parse(await manualProvider.complete('任意 prompt')) as { score: number | null };
    expect(parsed.score).toBeNull();
  });

  it('manualVerdict 把每个考点变成"待你自查"，nextStep 引用判据', () => {
    const v = manualVerdict(question, 'qodercli timeout');
    expect(v.provider).toBe('manual');
    expect(v.score).toBeNull();
    expect(v.maxScore).toBe(10);
    expect(v.rubricBreakdown.map((b) => b.earned)).toEqual([0, 0]);
    expect(v.rubricBreakdown[0]?.nextStep).toContain('强一致');
    expect(v.raw).toContain('qodercli timeout');
    expect(v.gaps.length).toBe(2);
  });

  it('无 rubric 时返回空自检表而不是崩', () => {
    const v = manualVerdict({ ...question, rubric: undefined } as typeof question);
    expect(v.rubricBreakdown).toEqual([]);
    expect(v.score).toBeNull();
  });
});
