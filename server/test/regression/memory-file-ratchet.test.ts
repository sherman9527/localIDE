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
 * ② **绝对下限**（永远判，包括镜像里）：`.dockerignore` 排掉了 `.git` ⇒ 镜像里 `git show` 直接 fatal。
 *    本仓库对这类门的规矩是白纸黑字写着的（`dev_verify_workflow.md` 第 3 条）：跳过要用 `it.skipIf`
 *    让报告显形，而且**必须另起一条永远会跑的断言**解释"为什么会是 null"。所以下面那组下限
 *    在镜像里仍然守住"这两个文件没被清空"这件事 —— 它拦不住"少了一行"，但拦得住"只剩 20 行"。
 *
 * ## 容差为什么不是 0
 *
 * 这两个文件允许合法地缩小（把一条做完的 WI 从 TODO 挪进 COMPLETED、删掉一段过期句子）。
 * 0 容差会把正常编辑挡下来，然后第一条被绕过的就是它自己。所以按**比例 + 绝对值取大**给一个宽口子：
 * 一次正常改动的量级是个位数到几十行，而事故的量级是 3813 行。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  /**
   * 判据本身不许悄悄失效：拿不到 HEAD 的 blob（镜像里、或 git 不可用）时，
   * 这条以 skip 的形态显形，而不是"跑过了"—— 下面那条下限网仍然会跑。
   */
  const sizes = MEMORY_FILES.map((rel) => ({ rel, head: headBlobSize(rel) }));
  const haveGit = sizes.every((s) => s.head !== null);

  it.skipIf(!haveGit)(
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
   * ⚠ 这一条在**镜像里也跑**（没有 .git 也跑）。它判的是"文件还在、没被截断成骨架"，
   * 正是上一条拿不到 git 时唯一还立着的网 —— 所以它的消息必须把"为什么这里可能是 null"说清：
   * 上面那条在镜像里 skip，看不见 skip 本身就是缺陷（`publish-identity.test.ts` 同一条课）。
   */
  it('绝对下限永远判（镜像里没有 .git 时，它是唯一还立着的那张网）', () => {
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
  it.skipIf(!haveGit)('里程碑数量与 COMPLETED 条目数量不许低于上一版（只增不减的东西不许被编辑掉）', () => {
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
