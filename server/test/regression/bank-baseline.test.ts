import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * N-18：题库"只增不减"（红线 C5 的那半条）的**基线**在容器交付档里是死的。
 *
 * 病灶（2026-09-27 从容器日志里看见的，池里记了快一个月）：`check-bank.mjs` 的基线取 `git ls-files`，
 * 而 `.dockerignore` 排掉 `.git` ⇒ 容器里 `trackedQuestions()` 返回 null ⇒ 退到 `.bank-count`
 * （gitignored，镜像里通常没有）⇒ baseline=0 ⇒ `total < 0` 永不成立 ⇒ **这条闸门在交付档里一行都不判**，
 * 而 verify.sh 的阶段名还写着"基线取 git 跟踪数"，看起来像在工作。
 *
 * 治法（池里写的方向②）：构建期把"烤进镜像的那棵 content 树里有多少题"落到
 * `/opt/arena-bank-baseline.txt`（先例：`/opt/arena-apt-resolved.txt` —— 同一族"把构建期事实留在镜像里"的做法），
 * 运行期基线优先级 = git 跟踪数 → 镜像清单 → `.bank-count`；**三个都没有就响亮失败**，不再当 0 通过。
 *
 * 判据走 `--baseline-info`：把解析器输出成 JSON，三种形状各判一次，全部在临时目录里造，
 * 不碰仓库那份 content/ 与真 `.bank-count`。
 */

const SCRIPT = join(config.repoRoot, 'scripts', 'check-bank.mjs');
const scratch: string[] = [];

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'arena-baseline-'));
  scratch.push(d);
  return d;
}

/** 造一棵假题库：n 个 .json，外加"不算题目"的那三个文件名（判 countQuestions 的口径有没有跟着改）。 */
function fakeBank(n: number, extraNoise = true): string {
  const root = newDir();
  const q = join(root, 'content', 'questions', 'big-data');
  mkdirSync(q, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(q, `x-${String(i).padStart(4, '0')}.json`), '{"id":"x"}', 'utf8');
  if (extraNoise) {
    // 这三个是被排除的：hidden.json 是软删除表、schema.json 是校验器、package.json 是偶发文件
    for (const noise of ['hidden.json', 'schema.json', 'package.json']) writeFileSync(join(root, 'content', 'questions', noise), '{}', 'utf8');
  }
  return root;
}

type Info = { total: number; baseline: number | null; source: string | null; sources: Record<string, number | null> };

function readInfo(env: Record<string, string>): Info {
  const r = spawnSync(process.execPath, [SCRIPT, '--baseline-info'], {
    cwd: config.repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  });
  expect(r.status, `--baseline-info 退出 ${r.status}：${r.stderr || r.stdout}`).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as Info;
}

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('题库只增不减的基线解析（N-18）', () => {
  it('计数口径：只算 content/questions 下的 .json，且 hidden/schema/package 三个不算题目', () => {
    const i = readInfo({ ARENA_BANK_ROOT: fakeBank(7) });
    expect(i.total, '7 道题 + 3 个噪音文件应当数出 7').toBe(7);
    const i2 = readInfo({ ARENA_BANK_ROOT: fakeBank(0) });
    expect(i2.total, '空题库却数出东西 ⇒ 噪音文件被当成题目了').toBe(0);
  });

  /**
   * 真实环境下**不设任何缝**跑一次：基线必须拿到一个像样的读数。
   * 这一条同时是 Dockerfile 那段烤入的验收 —— 上一版在这里硬写了"来源必须是 git"，
   * 于是它在容器档里必红（`.dockerignore` 排掉 `.git` ⇒ git 那一路注定 null），
   * 正是本仓库点名的"换机器成立的闸门在镜像里必然跑不了"。现在两档都判，各自判它该判的东西。
   */
  it('不设缝时基线必须可用：宿主走 git，容器走镜像烤入的清单，两档都不许退成 0', () => {
    const i = readInfo({});
    const gitWorks = spawnSync('git', ['ls-files', '--', 'content/questions'], { cwd: config.repoRoot, encoding: 'utf8', shell: false }).status === 0;
    expect(['git', 'image'], `基线来源读到了 ${i.source} —— 只接受 git（宿主）或 image（容器里 Dockerfile 烤的那份）；counter 都不该在这种环境被选中`).toContain(i.source);
    expect(i.baseline, `基线只有 ${i.baseline} —— 退成 0/1 就是 N-18 的"闸门静默空转"复发`).not.toBeNull();
    expect(i.baseline as number, '基线必须是个像样的题数').toBeGreaterThan(100);
    expect(i.total, '现场题数不许少于基线（这条判据本身在真实仓库上必须是绿的，否则上面那行看不到）').toBeGreaterThanOrEqual(i.baseline as number);
    if (i.source === 'image') {
      expect(process.env.ARENA_IN_CONTAINER, '用到了镜像清单却不在容器里 ⇒ 是谁在宿主上写了 /opt/arena-bank-baseline.txt？').toBe('1');
      expect(gitWorks, '容器里本该没有 git；有 git 却走了 image ⇒ 优先级被写反了').toBe(false);
    } else {
      expect(gitWorks, '走到 git 这一路而 git 又不可用，说明 sources 里那一路是假的').toBe(true);
    }
  });

  it('没有 git（容器交付档的形状）：改用镜像烤入的清单，而不是退成 0', () => {
    const root = fakeBank(9);
    const manifest = join(root, 'opt-bank-baseline.txt');
    writeFileSync(manifest, '9\n', 'utf8');
    // 关键：git 那一路必须真的失败（临时目录不在任何仓库里），否则这条判的是"宿主恰好有 git"而不是"容器没有"
    const probe = spawnSync('git', ['ls-files', '--', 'content/questions'], { cwd: root, encoding: 'utf8', shell: false });
    expect(
      probe.status,
      `临时目录里 git 居然能用（status=${probe.status}）⇒ 下面这条判据的前提没了，需要换个更严的假容器`,
    ).not.toBe(0);
    const i = readInfo({ ARENA_BANK_ROOT: root, ARENA_BANK_BASELINE_FILE: manifest, ARENA_BANK_SKIP_GIT: '1' });
    expect(i.source, '容器档的基线来源必须是镜像清单，不是 git 也不是 .bank-count').toBe('image');
    expect(i.baseline).toBe(9);
  });

  it('清单比现场大 = 减少 ⇒ 判红，并且消息点名是哪一路基线', () => {
    const root = fakeBank(8);
    const manifest = join(root, 'opt-bank-baseline.txt');
    writeFileSync(manifest, '9\n', 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, '--count-only'], {
      cwd: config.repoRoot,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, ARENA_BANK_ROOT: root, ARENA_BANK_SKIP_GIT: '1', ARENA_BANK_BASELINE_FILE: manifest, ARENA_BANK_COUNTER_FILE: join(root, 'no-counter') },
    });
    expect(r.status, '从 9 减到 8 居然通过 ⇒ 镜像清单这一路没接上判定').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`, '报错要说是哪一路基线（镜像清单），否则排查的人会去找 git').toMatch(/镜像清单|image/);
  });

  it('三路皆空 = 响亮失败，不许当"基线 0"蒙过去（这正是 N-18 的病）', () => {
    const root = fakeBank(3);
    const r = spawnSync(process.execPath, [SCRIPT, '--count-only'], {
      cwd: config.repoRoot,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, ARENA_BANK_ROOT: root, ARENA_BANK_SKIP_GIT: '1', ARENA_BANK_BASELINE_FILE: join(root, 'does-not-exist.txt'), ARENA_BANK_COUNTER_FILE: join(root, 'no-counter') },
    });
    expect(r.status, `基线一路都没有却退 0 ⇒ 这道闸门又在静默空转：${r.stdout}${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`, '失败必须说清"没有任何可信基线"，而不是报一句看不出所以然的数字').toMatch(/没有任何可信基线/);
  });

  it('镜像烤入的清单、脚本的默认路径、两边的排除名单必须是同一份口径（否则这条又是死的）', () => {
    const dockerfile = readFileSync(join(config.repoRoot, 'docker', 'Dockerfile'), 'utf8');
    const script = readFileSync(SCRIPT, 'utf8');
    expect(
      /RUN find \/app\/content\/questions[\s\S]{0,500}> \/opt\/arena-bank-baseline\.txt/.test(dockerfile),
      'Dockerfile 不再烤 /opt/arena-bank-baseline.txt ⇒ 容器档的 C5 基线回到"三路皆空"（N-18 那个病会原地复发）',
    ).toBe(true);
    expect(script, '脚本默认的基线路径必须就是 Dockerfile 写进去的那个文件；两边各写一个数早晚会漂移').toContain("'/opt/arena-bank-baseline.txt'");
    const baked = new Set([...dockerfile.matchAll(/! -name ([A-Za-z.]+\.json)/g)].map((m) => m[1]));
    const excluded = new Set(
      [...(script.match(/NON_QUESTION_FILES = new Set\(\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    expect(baked.size, '从 Dockerfile 里读不到排除名单 ⇒ 本条判据空转（写法变了要同步改这里）').toBeGreaterThan(0);
    expect([...baked].sort(), '构建期排除的文件名与 countQuestions 用的那份不一致 ⇒ 镜像里烤的基线与运行期数的不是同一件事，' + '"只增不减"会去判一个不存在的差值').toEqual([...excluded].sort());
    expect(script, '三路皆空必须响亮失败：把 null 当 0 通过正是 N-18 本体').toMatch(/没有任何可信基线/);
    expect(readFileSync(join(config.repoRoot, 'scripts', 'verify.sh'), 'utf8'), 'verify.sh 的阶段名还写着"基线取 git 跟踪数" ⇒ 那是容器里的假话').not.toMatch(/基线取 git 跟踪数/);
  });
});
