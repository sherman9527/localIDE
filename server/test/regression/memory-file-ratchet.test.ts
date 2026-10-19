/**
 * 跨 session 记忆文件不许被"改小"（WI-112；2026-10-19 起按**并集**判）。
 *
 * ## 为什么这条门存在（不是抽象的"以防万一"，是一次真实损失）
 *
 * 2026-10-12 追加里程碑时，一段脚本写成一行：
 *
 * ```python
 * io.open(p, 'w').write(io.open(p).read() + add)   # 错
 * ```
 *
 * Python 的求值顺序是**先把目标文件开成写模式（当场清空），再去读那个已经空了的文件** ⇒
 * `memo.md` 从 3833 行变成 20 行。`npm run verify:fast` 当时 **EXIT=0**，pre-commit 也放行了：
 * 这几个文件不被任何运行时读，也没有任何判据读它们 —— 它坏了不会有任何功能红，
 * 只有下一个读它的人（人或 agent）会拿到一份残缺的世界模型。那是本项目最贵的一种坏法
 * （"记忆里的谎"），而它当时**完全裸奔**。
 *
 * 发现它靠的不是测试，是 `git show --stat` 里那行 `memo.md | 3843 ---------`。
 * 所以这条门做的事就是把"删除量远大于新增"这个形状，从"有人恰好去看了 --stat"变成"每次提交都会判"。
 *
 * ## 2026-10-19：判的对象从"单文件"换成"这一堆文件的并集"
 *
 * `HANDOVER.md` 长到 227 KB / 107 条已完成项 —— 一个读不完的工作板等于没有工作板，
 * 于是把旧批次整条搬进 `docs/HANDOVER-archive.md`（**搬移不删**，板上只留最近 20 条）。
 * 如果棘轮仍按单文件判，这次合法的搬移会被判成"记忆被截断"；按并集判才对：
 * **知识总量不许变小，但可以在几份文件之间挪。** 搬完之后同一批判据必须仍然绿，
 * 而"删掉一条 COMPLETED"必须红 —— 两种情况都真跑过（见下面的破坏性）。
 *
 * ## 三条网，缺一不可
 *
 * ① **并集的相对 ratchet**（要 git）：三份记忆文件的字节合计不许比 HEAD 少超过 `max(4096, 5%)`；
 *    `- [x]` 与 `## 里程碑` 的合计一条都不许少（那是"只增不减"的语义本体，不给容差）。
 * ② **并集与各文件的绝对下限**（在场就判）：拦得住"整个文件被清空"，也拦得住"某一份被搬空"。
 * ③ **永远跑的那条判"这张网还在不在"**：文件不在 ⇒ 必须是容器 + `.dockerignore` 声明过的排除；
 *    只少一份 ⇒ 红（那是挪走了一个，不是镜像能解释的状态）。镜像里 `.git` 也被排掉，
 *    所以 ① 在容器里 skip，而 skip 的理由由 ③ 负责说清（本仓库点名过"看不见 skip 本身就是缺陷"）。
 * ④ 板上条目的**段落归属**也判：`- [x] ` 只许住在 `## COMPLETED` 段里。这条是搬移当天撞出来的 ——
 *    `WI-90`/`WI-91` 早已完成却住在 `## IN PROGRESS` 段，任何按段落切的脚本都会把它们当段外内容丢掉。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

const ROOT = config.repoRoot;

/** 判的文件就是这三份：跨 session 记忆的全部载体。 */
const MEMO = 'memo.md';
const BOARD = 'HANDOVER.md';
const ARCHIVE = 'docs/HANDOVER-archive.md';
const MEMORY_FILES = [MEMO, BOARD, ARCHIVE] as const;

/**
 * 每份文件的字节下限（它们是棘轮不是常数：低于它就意味着这份被清空或大幅截断；
 * 要往上改只在"有意拆分/精简"时，那是一次里程碑，不是顺手调参数）。
 */
const BYTE_FLOORS: Record<(typeof MEMORY_FILES)[number], number> = {
  [MEMO]: 100_000,
  [BOARD]: 25_000,
  [ARCHIVE]: 100_000,
};

/** 并集下限：拦"把内容搬来搬去最后丢了"这种整体退化（数字是 2026-10-19 实测往下留了很大余量）。 */
const UNION_BYTE_FLOOR = 400_000;

/** 只增不减的计数（按并集判；`m` 标志必须有，否则 `^` 只数到字符串开头那一次 = 装饰品）。 */
const UNION_COUNT_FLOORS = [
  { file: MEMO, marker: /^## 里程碑/gm, floor: 21, label: '里程碑标题' },
  { files: [BOARD, ARCHIVE], marker: /^- \[x\] /gm, floor: 100, label: 'COMPLETED 条目' },
] as const;

/** 允许相对 HEAD 缩小的量：max(绝对值, 比例)。事故是 3813 行，正常编辑是几十行。 */
const SHRINK_ALLOWANCE_ABS = 4_096;
const SHRINK_ALLOWANCE_RATIO = 0.05;

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const has = (rel: string): boolean => existsSync(join(ROOT, rel));

/** HEAD 里某份的字节数；拿不到（镜像无 .git / 未跟踪 / 浅历史）就是 null，**不是 0**。 */
function headBlobSize(rel: string): number | null {
  try {
    const out = execFileSync('git', ['cat-file', '-s', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }).trim();
    const size = Number(out);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/** HEAD 里某份的文本（并集计数要用）；拿不到就是 null。 */
function headText(rel: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/**
 * 工作树字节按 **LF 归一**后再量：Windows 工作树里这些文件是 CRLF，而库里存的是 LF
 * （`.gitattributes`：`* text=auto eol=lf`）—— 不归一的话 ratchet 判的是行尾而不是内容。
 */
function workTreeSize(rel: string): number {
  // 用 Buffer.byteLength 而不是 .length：这几份文件几乎全是中文，字符数与字节数差 3 倍
  return Buffer.byteLength(read(rel), 'utf8');
}

function countIn(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** 并集计数：跨几份文件加在一起，这样"搬移"中性而"删除"会红。 */
function unionCount(files: readonly string[], re: RegExp): number {
  return files.reduce((sum, rel) => sum + (has(rel) ? countIn(read(rel), re) : 0), 0);
}

const present = MEMORY_FILES.filter(has);
const allPresent = present.length === MEMORY_FILES.length;
const allAbsent = present.length === 0;

describe('跨 session 记忆文件不许被改小（WI-112，按并集判）', () => {
  /**
   * **永远跑**的那条，而且它不读内容 —— 判"这张网还在不在"。
   * 上一版在这里判字节下限，而镜像里根本没有这几份文件 ⇒ 红成 ENOENT，
   * 报的错与"记忆被截断"毫无关系（那正是"与判题无关的一条闸门把整轮容器验证撞红"）。
   */
  it('记忆文件可以不在镜像里，但"不在"必须是被声明过的原因（不许是改名/挪走让闸门消失）', () => {
    expect(
      allPresent || allAbsent,
      `${present.length}/${MEMORY_FILES.length} 份记忆文件在仓库里 ⇒ 既不是"宿主全在"也不是"镜像整体排掉"，` +
        '那是有人挪走了其中一份（本闸门赖以判的文件消失 = 闸门消失）',
    ).toBe(true);
    if (allPresent) {
      for (const rel of MEMORY_FILES) {
        expect(workTreeSize(rel), `${rel} 在场却几乎为空 ⇒ 下面的下限会退化成判一个空文件`).toBeGreaterThan(1_000);
      }
      expect(has('.dockerignore'), '.dockerignore 不见了 ⇒ "容器里为什么没有这几份"这个解释失去依据').toBe(true);
      return;
    }
    expect(process.env.ARENA_IN_CONTAINER, '仓库根没有这些记忆文件、又不是跑在容器里 ⇒ 记忆是真的丢了').toBe('1');
    const di = read('.dockerignore');
    for (const rel of [MEMO, BOARD]) {
      expect(di, `${rel} 不在仓库根，但 .dockerignore 里没有这一行 ⇒ "它是被排掉的"这个理由是编出来的`).toMatch(new RegExp(`^${rel}$`, 'm'));
    }
    expect(di, `${ARCHIVE} 不在仓库根，但 .dockerignore 里没有排掉它所在的目录 ⇒ 理由同样是编的`).toMatch(/^docs\/?$/m);
  });

  const headBytes = MEMORY_FILES.map((rel) => headBlobSize(rel));
  const haveGit = headBytes.every((v) => v !== null);

  it.skipIf(!haveGit || !allPresent)('三份记忆文件的**并集**不许相对 HEAD 显著缩小（搬移中性，删内容才会红）', () => {
    const headSum = (headBytes as number[]).reduce((a, b) => a + b, 0);
    const nowSum = MEMORY_FILES.reduce((a, rel) => a + workTreeSize(rel), 0);
    const allowance = Math.max(SHRINK_ALLOWANCE_ABS, Math.floor(headSum * SHRINK_ALLOWANCE_RATIO));
    expect(
      nowSum,
      `记忆文件合计从 ${headSum} 字节变成 ${nowSum} 字节（少了 ${headSum - nowSum}，容差只有 ${allowance}）。` +
        '搬移（例如把 COMPLETED 挪进 docs/HANDOVER-archive.md）不该触发这条 —— 触发了就说明并集里有文件真的少了内容。' +
        '如果是有意的拆分/精简，请改本文件的下限并在提交信息里说明；如果不知道它怎么少的，停下来看 git diff，别先绕过这条。',
    ).toBeGreaterThan(headSum - allowance);
  });

  it.skipIf(!haveGit || !allPresent)('只增不减的**计数**按并集不许低于上一版（COMPLETED 与里程碑一条都不许被编辑掉）', () => {
    for (const spec of UNION_COUNT_FLOORS) {
      const files = 'file' in spec ? [spec.file] : (spec.files as readonly string[]);
      const before = files.reduce((a, rel) => a + countIn(headText(rel) ?? '', spec.marker), 0);
      const after = unionCount(files, spec.marker);
      if (before === 0) continue; // 归档文件在 HEAD 里还不存在的第一次提交：没有基准可比
      expect(
        after,
        `${spec.label}（并集）从 ${before} 条变成 ${after} 条 —— 这条记录是"只增不减"的语义本体，` +
          `搬进 ${ARCHIVE} 可以，少一条不行（要真删请改本文件的下限并写明理由）`,
      ).toBeGreaterThanOrEqual(before);
    }
  });

  it.skipIf(!allPresent)('绝对下限：并集与每一份文件各自都不许掉到底（文件在场时判）', () => {
    let sum = 0;
    for (const rel of MEMORY_FILES) {
      const size = workTreeSize(rel);
      sum += size;
      expect(size, `${rel} 低于字节下限 ${BYTE_FLOORS[rel]} —— 记忆文件被清空/截断`).toBeGreaterThanOrEqual(BYTE_FLOORS[rel]);
    }
    expect(sum, `三份记忆文件合计 ${sum} < ${UNION_BYTE_FLOOR} —— 单份都没见底但整体瘦了，通常是搬移时漏搬或重复搬`).toBeGreaterThanOrEqual(UNION_BYTE_FLOOR);
    for (const spec of UNION_COUNT_FLOORS) {
      const files = 'file' in spec ? [spec.file] : (spec.files as readonly string[]);
      const n = unionCount(files, spec.marker);
      expect(n, `${spec.label}（并集 ${files.join(' + ')}）只有 ${n} 条，低于下限 ${spec.floor}`).toBeGreaterThanOrEqual(spec.floor);
    }
  });

  /**
   * 板上条目的段落归属（2026-10-19 搬移当天撞出来的）：`WI-90` / `WI-91` 早已完成却住在
   * `## IN PROGRESS` 段里 —— 后果不是难看，是**任何按段落切文件的脚本都会把它们当段外内容丢掉**，
   * 这次就差点在我自己的搬移里丢两条。所以"住对段"从今天起是判据，不是默契。
   */
  it.skipIf(!allPresent)('`- [x]` 只许住在 COMPLETED 段；`- [ ]` 只许住在 IN PROGRESS / TODO 段（住错段会被按段切片的脚本丢掉）', () => {
    const board = read(BOARD);
    const sections: { name: string; from: number; to: number }[] = [];
    const heads = [...board.matchAll(/^## (.+)$/gm)];
    heads.forEach((h, i) => {
      sections.push({ name: (h[1] ?? '').trim(), from: h.index ?? 0, to: heads[i + 1]?.index ?? board.length });
    });
    const owner = (pos: number) => sections.find((s) => pos >= s.from && pos < s.to)?.name ?? '(标题之前)';
    const doneSection = sections.find((s) => s.name === 'COMPLETED');
    expect(doneSection, `${BOARD} 里没有 ## COMPLETED 段 ⇒ 本条判据要跟着板子的结构同步（不许静默空转）`).toBeDefined();

    for (const m of board.matchAll(/^- \[x\] .*/gm)) {
      const where = owner(m.index ?? 0);
      expect(where, `板上有一行 "- [x] ${m[0].slice(6, 40)}…" 住在 "${where}" 段里 —— 按段落切片的脚本会把这类行当段外内容丢掉（WI-90/91 就是这么差点丢的）`).toBe('COMPLETED');
    }
    for (const m of board.matchAll(/^- \[ \] WI-\d+/gm)) {
      const where = owner(m.index ?? 0);
      expect(
        ['IN PROGRESS', 'TODO'],
        `板上有一行待办 "- [ ] WI-…" 住在 "${where}" 段里 —— 已决定的条目请写进"已决定"段并把前缀改成非待办形式，否则下一轮会被当成漏做的`,
      ).toContain(where);
    }
  });
});
