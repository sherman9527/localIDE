/**
 * 跨 session 记忆文件不许被"改小"（WI-112）。
 *
 * ## 为什么这条门存在（不是抽象的"以防万一"，是一次真实损失）
 *
 * 2026-10-12 追加里程碑时，一段脚本写成一行：
 *
 * ```python
 * io.open(p, 'w').write(io.open(p).read() + add)   # 错
 * ```
 *
 * Python 的求值顺序是**先把目标文件开成写模式（当场清空），再去读那个已经空掉的文件** ⇒
 * `memo.md` 从 3833 行变成 20 行。`npm run verify:fast` 当时 **EXIT=0**，pre-commit 也放行了：
 * 这两个文件不被任何运行时读，也没有任何判据读它们 —— 它坏了不会有任何功能红，
 * 只有下一个读它的人（人或 agent）会拿到一份残缺的世界模型。那是本项目最贵的一种坏法
 * （"记忆里的谎"），而它当时**完全裸奔**。
 *
 * 发现它靠的不是测试，是 `git show --stat` 里那行 `memo.md | 3843 ---------`。
 * 所以这条门做的事就是把"删除量远大于新增"这个形状，从"有人恰好去看了 --stat"
 * 变成"每次提交都会判"。
 *
 * ## 两条网，缺一不可
 *
 * ① **相对 HEAD 的 ratchet**（只有拿得到 git 时判）：pre-commit 是在提交**之前**跑的，
 *    那一刻的 `HEAD` 就是上一版 —— 正好是这次事故的作案时刻。工作树里这两个文件不许显著变小，
 *    `## 里程碑` 与 `- [x]` 的数量一个都不许减少。
 * ② **绝对下限**（宿主永远判）：拦不住"少了一行"，但拦得住"只剩 20 行"。
 *    ⚠ 这一条原本写的是"永远判，包括镜像里"—— **那是错的**，2026-10-16 容器档实测撞红：
 *    `.dockerignore` 排掉 `.git` 那一族时，把 `memo.md` / `HANDOVER.md` 自己也排掉了
 *    （与 docs / 会话笔记同族，见 `.dockerignore:12-13`）⇒ 镜像里 `readFileSync` 直接 ENOENT，
 *    这条门在容器档红成"文件不存在"而不是"文件被截断"。正确的形状是下面那条永远跑的判据：
 *    它判的不再是内容，而是**这张网还在不在** —— 文件在就判非空，文件不在就必须同时满足
 *    "在容器里"与"`.dockerignore` 里真写了这条排除"，两个理由缺一个就红。
 *    本仓库对这类门的规矩白纸黑字（`dev_verify_workflow.md` 第 3 条）：跳过要用 `it.skipIf`
 *    让报告显形，而且必须另起一条永远会跑的断言解释"为什么会是 null"。
 *
 * ## 容差为什么不是 0
 *
 * 这两个文件允许合法地缩小（把一条做完的 WI 从 TODO 挪进 COMPLETED、删掉一段过期句子）。
 * 0 容差会把正常编辑挡下来，然后第一条被绕过的就是它自己。所以按**比例 + 绝对值取大**给一个宽口子：
 * 一次正常改动的量级是个位数到几十行，而事故的量级是 3813 行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

const ROOT = config.repoRoot;

/** 判的文件就是这两个：跨 session 记忆的全部载体。 */
const MEMORY_FILES = ['memo.md', 'HANDOVER.md'] as const;

/**
 * 绝对下限（字节）。它们**是棘轮不是常数**：低于它就意味着文件被清空或大幅截断，
 * 要往上改只在"有意把文件拆分成多份"时 —— 那是另一次里程碑，不是顺手调参数。
 */
const BYTE_FLOORS: Record<(typeof MEMORY_FILES)[number], number> = {
  'memo.md': 100_000,
  'HANDOVER.md': 40_000,
};

/** 里程碑与已完成条数的下限（只增不减的东西，因此可以直接当棘轮；数字是 2026-10-12 实测）。 */
const COUNT_FLOORS: Record<(typeof MEMORY_FILES)[number], { marker: RegExp; floor: number; label: string }> = {
  // ⚠ 两个正则都要 `m` 标志：没有 multiline 时 `^` 只匹配**整个字符串的开头**，
  //    于是这条"下限门"只数到 1 个 ⇒ 它不是变松，是变成一条永远红着的装饰。
  'memo.md': { marker: /^## 里程碑/gm, floor: 19, label: '里程碑标题' },
  'HANDOVER.md': { marker: /^- \[x\] /gm, floor: 95, label: 'COMPLETED 条目' },
};

/** 允许相对 HEAD 缩小的量：max(绝对值, 比例)。事故是 3813 行，正常编辑是几十行。 */
const SHRINK_ALLOWANCE_ABS = 4_096;
const SHRINK_ALLOWANCE_RATIO = 0.05;

/** HEAD 里那份的字节数；拿不到（镜像无 .git / 路径未跟踪 / 浅历史）就是 null，**不是 0**。 */
function headBlobSize(rel: string): number | null {
  try {
    const out = execFileSync('git', ['cat-file', '-s', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }).trim();
    const size = Number(out);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null; // 上面那段文件头注释解释了这种情况由哪条网守（绝对下限那条永远跑）
  }
}

/**
 * 工作树里这份的字节数，按 **LF 归一**后再量 —— 不这么做的化，Windows 工作树里可能是 CRLF、
 * 而库里存的是 LF（`.gitattributes`：`* text=auto eol=lf`），两个数差着行数的字节，
 * ratchet 就会去判一件与内容无关的事。判"有没有被截断"要两边同一口径。
 */
function workTreeSize(rel: string): number {
  const text = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  // 用 Buffer.byteLength 而不是 .length：这两个文件几乎全是中文，字符数与字节数差 3 倍
  return Buffer.byteLength(text, 'utf8');
}

function countMatches(rel: string, re: RegExp): number {
  return (readFileSync(join(ROOT, rel), 'utf8').match(re) ?? []).length;
}

describe('跨 session 记忆文件不许被改小（WI-112）', () => {
  /** 两份文件在不在仓库根 —— 镜像里 `.dockerignore` 故意不带上它们（见文件头 ②）。 */
  const present = MEMORY_FILES.filter((rel) => existsSync(join(ROOT, rel))).length;
  const allPresent = present === MEMORY_FILES.length;
  const allAbsent = present === 0;

  /**
   * **永远跑**的那条，而且它不读记忆文件的内容 —— 它判"这张网还在不在"。
   * 上一版在这里判的是字节下限，而镜像里根本没有那两个文件 ⇒ 红成 ENOENT，
   * 报出来的错与"记忆被截断"毫无关系，正是本仓库点名的"与判题无关的一条闸门把整档撞红"。
   * 三种合法状态只有两种：全在（宿主）或全不在（容器，且 `.dockerignore` 里真写了这条排除）。
   * "一份在一份不在"不是任何一种能自圆其说的状态 —— 那是有人挪走了其中一个。
   */
  it('记忆文件可以不在镜像里，但"不在"必须是被声明过的原因（不许是改名/挪走让闸门消失）', () => {
    if (allPresent) {
      for (const rel of MEMORY_FILES) {
        expect(workTreeSize(rel), `${rel} 在仓库根却几乎为空 ⇒ 下面的下限会退化成判一个空文件`).toBeGreaterThan(1_000);
      }
      expect(existsSync(join(ROOT, '.dockerignore')), '.dockerignore 不见了 ⇒ 本条"容器里为什么没有这两个文件"的解释失去依据').toBe(true);
      return;
    }
    expect(
      allAbsent,
      `两份记忆文件只找到 ${present} 份 ⇒ 不是"镜像整体排掉"能解释的，去看是不是有人改名/挪走了其中一个`,
    ).toBe(true);
    expect(
      process.env.ARENA_IN_CONTAINER,
      '仓库根没有这两份文件、又不是跑在容器里 ⇒ 记忆文件是真的丢了（赖以判据的文件消失 = 这条闸门消失，必须响亮）',
    ).toBe('1');
    const di = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    for (const rel of MEMORY_FILES) {
      expect(di, `${rel} 不在仓库根，但 .dockerignore 里没有这一行 ⇒ "它是被排掉的"这个理由是编出来的`).toMatch(new RegExp(`^${rel}$`, 'm'));
    }
  });

  /**
   * 判据本身不许悄悄失效：拿不到 HEAD 的 blob（镜像里、或 git 不可用）时，
   * 这条以 skip 的形态显形，而不是"跑过了"—— 上面那条永远跑的那条负责解释为什么。
   */
  const sizes = MEMORY_FILES.map((rel) => ({ rel, head: headBlobSize(rel) }));
  const haveGit = sizes.every((s) => s.head !== null);

  it.skipIf(!haveGit || !allPresent)(
    '工作树里的记忆文件不许相对 HEAD 显著缩小（ratchet 判的是"这次提交会删掉多少"）',
    () => {
      for (const { rel, head } of sizes) {
        if (head === null) continue; // 上面那条 skipIf 已经保证到不了这里；留着是为了别有人改了 skipIf 让它静默
        const now = workTreeSize(rel);
        const allowance = Math.max(SHRINK_ALLOWANCE_ABS, Math.floor(head * SHRINK_ALLOWANCE_RATIO));
        expect(
          now,
          `${rel} 从 ${head} 字节变成 ${now} 字节（少了 ${head - now}，容差只有 ${allowance}）。` +
            ' 如果是有意拆分/精简这份记忆，请改本文件的下限并在提交信息里说明；' +
            ' 如果不知道它怎么少的 —— 停下来看 git diff，别先绕过这条。',
        ).toBeGreaterThan(head - allowance);
      }
    },
  );

  /**
   * 绝对下限：拦得住"只剩 20 行"。它只在文件在场时判（镜像里由上面那条负责说清为什么没判），
   * 而"文件在不在"这件事本身已经有一条永远跑的判据兜着 —— 两条合起来才是完整的网。
   */
  it.skipIf(!allPresent)('绝对下限：字节数与"只增不减"的计数都不许掉到底（文件在场时判）', () => {
    for (const rel of MEMORY_FILES) {
      expect(workTreeSize(rel), `${rel} 低于字节下限 ${BYTE_FLOORS[rel]} —— 记忆文件被清空/截断`).toBeGreaterThanOrEqual(
        BYTE_FLOORS[rel],
      );
      const { marker, floor, label } = COUNT_FLOORS[rel];
      expect(countMatches(rel, marker), `${rel} 的${label}少于 ${floor} 个 —— 只增不减的东西变少了`).toBeGreaterThanOrEqual(floor);
    }
  });

  /**
   * 里程碑与 COMPLETED 条数不许比 HEAD 少。这两个是"只增"的语义承诺，不是体积，
   * 所以不放容差：删掉一条已完成记录就是删掉一次交付的证据（本仓库明确不收的形状）。
   */
  it.skipIf(!haveGit || !allPresent)('里程碑数量与 COMPLETED 条目数量不许低于上一版（只增不减的东西不许被编辑掉）', () => {
    for (const rel of MEMORY_FILES) {
      const { marker, label } = COUNT_FLOORS[rel];
      const text = readFileSync(join(ROOT, rel), 'utf8');
      let previous: string;
      try {
        previous = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      } catch {
        continue;
      }
      const before = (previous.match(marker) ?? []).length;
      const after = text.match(marker)?.length ?? 0;
      expect(after, `${rel} 的${label}从 ${before} 个变成 ${after} 个 —— 这条记录是"只增不减"的语义本体`).toBeGreaterThanOrEqual(before);
    }
  });
});
