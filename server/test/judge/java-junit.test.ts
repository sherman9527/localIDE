import { readdir } from 'node:fs/promises';
import { Question, type JudgeResult, type Question as BankQuestion } from '@arena/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { probeStacks, runJudge } from '../../src/judge/registry.js';
import '../../src/judge/runners/java-junit.js';

/**
 * 算法题只允许 Java（需求 场景 2）。这里钉死判题器的四件事：
 * 正确解 pass、错误解 fail 到用例粒度、编译失败归类 error 而非 fail、跑完不留沙箱。
 * 依赖镜像内的 JDK17 + /opt/junit，宿主机没有时整个 suite 跳过。
 */

const CORRECT = `public class Solution {
  public static int longestUniqueRange(int[] events) {
    java.util.Map<Integer, Integer> last = new java.util.HashMap<>();
    int best = 0, left = 0;
    for (int i = 0; i < events.length; i++) {
      Integer prev = last.get(events[i]);
      if (prev != null && prev >= left) left = prev + 1;
      last.put(events[i], i);
      best = Math.max(best, i - left + 1);
    }
    return best;
  }
}`;

// 一遇到重复值就直接返回 0：边界用例侥幸通过，真正的滑动窗口用例必挂
const WRONG = `public class Solution {
  public static int longestUniqueRange(int[] events) {
    java.util.Set<Integer> seen = new java.util.HashSet<>();
    for (int v : events) {
      if (!seen.add(v)) return 0;
    }
    return events.length;
  }
}`;

const HANGING = `public class Solution {
  public static int longestUniqueRange(int[] events) {
    long acc = 0;
    while (true) { acc += events.length; }
  }
}`;

const BROKEN = `public class Solution {
  public static int longestUniqueRange(int[] events) {
    return events.length   // 少了分号
  }
}`;

function makeQuestion(overrides: Record<string, unknown> = {}): BankQuestion {
  return Question.parse({
    id: 'alg-java-harness-0001',
    category: 'algorithms',
    difficulty: 'senior',
    title: '事件流中最长的无重复 user_id 连续区间',
    statement: '给定按到达顺序排列的 user_id 事件流，求最长的、内部 user_id 不重复的连续区间长度。',
    judgeKind: 'java-junit',
    language: 'java',
    tags: ['sliding-window', 'java'],
    cases: [
      { name: '空事件流返回 0', input: [[]], expected: 0 },
      { name: '全部不重复时返回全长', input: [[1, 2, 3]], expected: 3 },
      { name: '中间重复需要滑动窗口截断', input: [[1, 2, 1, 3]], expected: 3 },
      { name: '尾部出现重复', input: [[7, 7, 7, 7]], expected: 1 },
    ],
    runner: {
      className: 'Solution',
      signature: 'int longestUniqueRange(int[] events)',
      referenceSolution: CORRECT,
      timeoutMs: 20_000,
    },
    source: { origin: 'manual', jds: [], ingestedAt: '2026-09-19T00:00:00.000Z', era: '2026' },
    ...overrides,
  }) as BankQuestion;
}

/**
 * 判题依赖镜像内的 JDK17 + /opt/junit。
 * 注意必须用顶层 await：describe 回调在 collect 阶段执行，beforeAll 里再赋值就来不及了。
 */
const stacks = await probeStacks();
const javaAvailable = stacks['java-junit'] === true;
if (!javaAvailable) console.warn('[judge] 本机无 JDK/JUnit，java-junit 判题测试跳过（容器内会跑）');

/**
 * 只检查"本 suite 那道 harness 题目"的工作区有没有留下残留：
 * data/judge 是共享挂载目录，容器里同时跑别的判题（app 服务、其他 suite）会往里写，
 * 断言整个目录为空必然互相误伤。
 */
const leakedHarnessDirs = async (): Promise<string[]> => {
  const names = await readdir(config.judgeWorkDir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith('alg-java-harness-'));
};

afterAll(async () => {
  const leaked = await leakedHarnessDirs();
  expect(leaked, `本 suite 的判题沙箱未清理：${leaked.join(', ')}`).toEqual([]);
});

const guarded = javaAvailable ? it : it.skip;

describe('java-junit runner', () => {
  guarded('参考解全部用例通过', async () => {
    const result = await runJudge({ questionId: 'x', submission: CORRECT }, makeQuestion());
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.failedCases).toEqual([]);
    expect(result.passedCases).toContain('空事件流返回 0');
  }, 90_000);

  guarded('错误解只挂掉的用例被点名（需求 场景 4）', async () => {
    const result = await runJudge({ questionId: 'x', submission: WRONG }, makeQuestion());
    expect(result.status).toBe('fail');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.failedCases.map((c) => c.name)).toEqual([
      '中间重复需要滑动窗口截断',
      '尾部出现重复',
    ]);
    const mismatch = result.failedCases.find((c) => c.name === '尾部出现重复') as JudgeResult['failedCases'][number];
    expect(mismatch.expected).toBe('1');
    expect(mismatch.actual).toBe('0');
  }, 90_000);

  guarded('编译失败归类 error 而不是 fail', async () => {
    const result = await runJudge({ questionId: 'x', submission: BROKEN }, makeQuestion());
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('compile');
    expect(result.logs).toMatch(/error|错误/);
    expect(result.failed).toBe(0);
  }, 90_000);

  guarded('死循环被判超时并杀掉进程', async () => {
    const result = await runJudge(
      { questionId: 'x', submission: HANGING },
      makeQuestion({ runner: { ...makeQuestion().runner, timeoutMs: 6_000 } }),
    );
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('timeout');
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(30_000);
  }, 120_000);

  guarded('方法签名与实现不一致时给出可读错误', async () => {
    const result = await runJudge(
      { questionId: 'x', submission: CORRECT },
      makeQuestion({ runner: { ...makeQuestion().runner, signature: 'int notExist(int[] events)' } }),
    );
    expect(result.status).toBe('error');
    expect(result.logs).toMatch(/notExist/);
  }, 90_000);
});

/** 契约型用例（必须抛异常）与大整数：这两类以前只能写进题面、判不了分。 */
const CONTRACT_OK = `public class Solution {
  public static int divide(int a, int b) {
    if (b == 0) throw new ArithmeticException("divide by zero");
    return a / b;
  }
}`;

const CONTRACT_SWALLOW = `public class Solution {
  public static int divide(int a, int b) {
    return b == 0 ? 0 : a / b;
  }
}`;

describe('java-junit 契约用例与大整数', () => {
  guarded('expectThrow 用例能判分：抛出指定异常才算通过', async () => {
    const question = makeQuestion({
      id: 'alg-java-contract-01',
      title: '整型除法的错误契约（除零必须抛错而不是返回 0）',
      statement: '实现 divide(a, b)：正常返回商，除数为 0 时必须抛 ArithmeticException，不得吞掉错误。',
      cases: [
        { name: '正常相除', input: [6, 3], expected: 2 },
        { name: '负数向零截断', input: [-7, 2], expected: -3 },
        { name: '除零必须抛异常', input: [1, 0], expected: null, expectThrow: 'ArithmeticException' },
        { name: '被除数为零', input: [0, 5], expected: 0 },
      ],
      runner: { className: 'Solution', signature: 'int divide(int a, int b)', referenceSolution: CONTRACT_OK, timeoutMs: 20_000 },
    });
    const ok = await runJudge({ questionId: question.id, submission: CONTRACT_OK }, question);
    expect(ok.status, ok.logs ?? '').toBe('pass');
    expect(ok.passed).toBe(4);

    const swallowed = await runJudge({ questionId: question.id, submission: CONTRACT_SWALLOW }, question);
    expect(swallowed.status).toBe('fail');
    expect(swallowed.failedCases.map((c) => c.name)).toContain('除零必须抛异常');
    expect(String(swallowed.failedCases.find((c) => c.name === '除零必须抛异常')?.expected)).toContain('ArithmeticException');
  }, 120_000);

  guarded('long 用字符串表达也能判（避开 JS 2^53 精度坑）', async () => {
    const solution = `public class Solution {
  public static long nextId(long current) {
    return current + 1;
  }
}`;
    const question = makeQuestion({
      id: 'alg-java-long-0001',
      title: '雪花 ID 的下一个值（超过 2 的 53 次方）',
      statement: '实现 nextId(current)：返回下一个 id。数值会超过 JS 安全整数范围，因此用例里用字符串表示。',
      language: 'java',
      cases: [
        { name: '超过 2^53 的递增', input: ['9007199254740992'], expected: '9007199254740993' },
        { name: '负侧边界', input: ['-9223372036854775808'], expected: '-9223372036854775807' },
        { name: '零值起点', input: [0], expected: 1 },
        { name: '接近上界', input: ['9223372036854775806'], expected: '9223372036854775807' },
      ],
      runner: { className: 'Solution', signature: 'long nextId(long current)', referenceSolution: solution, timeoutMs: 20_000 },
    });
    const result = await runJudge({ questionId: question.id, submission: solution }, question);
    expect(result.status, result.logs ?? '').toBe('pass');
    expect(result.passed).toBe(4);
  }, 120_000);

  guarded('List<String> / List<Long> 泛型参数要真的按元素类型转换（不能退化成 List<Integer>）', async () => {
    const solution = `public class Solution {
  public static int totalLen(java.util.List<String> words) {
    int sum = 0;
    for (String w : words) sum += w.length();
    return sum;
  }
}`;
    const question = makeQuestion({
      id: 'alg-java-harness-0002',
      title: '字符串列表总长度（泛型入参）',
      statement: '实现 totalLen(words)：返回所有字符串长度之和。用于验证判题器对 List<String> 的入参转换。',
      language: 'java',
      cases: [
        { name: '空列表返回 0', input: [[]], expected: 0 },
        { name: '两个词', input: [['ab', 'cde']], expected: 5 },
        { name: '含空串', input: [['', 'a', 'bb']], expected: 3 },
      ],
      runner: { className: 'Solution', signature: 'int totalLen(List<String> words)', referenceSolution: solution, timeoutMs: 20_000 },
    });
    const result = await runJudge({ questionId: question.id, submission: solution }, question);
    expect(result.status, result.logs ?? '').toBe('pass');
    expect(result.passed).toBe(3);
  }, 120_000);

  guarded('int[][] 嵌套原始数组入参要真的转成二维数组（之前会被当 List 丢给反射）', async () => {
    const solution = `public class Solution {
  public static int sumMatrix(int[][] grid) {
    int total = 0;
    for (int[] row : grid) for (int cell : row) total += cell;
    return total;
  }
}`;
    const question = makeQuestion({
      id: 'alg-java-harness-0003',
      title: '二维矩阵所有元素之和（嵌套原始数组入参）',
      statement: '实现 sumMatrix(grid)：返回二维 int 矩阵所有元素之和。用于验证判题器对 int[][] 的入参转换。',
      language: 'java',
      cases: [
        { name: '空矩阵返回 0', input: [[]], expected: 0 },
        { name: '常规 2x3', input: [[[1, 2, 3], [4, 5, 6]]], expected: 21 },
        { name: '含负数与单行', input: [[[-7]]], expected: -7 },
      ],
      runner: { className: 'Solution', signature: 'int sumMatrix(int[][] grid)', referenceSolution: solution, timeoutMs: 20_000 },
    });
    const right = await runJudge({ questionId: question.id, submission: solution }, question);
    expect(right.status, right.logs ?? '').toBe('pass');
    expect(right.passed).toBe(3);

    // 只加第一行：必须挂，且失败信息落到具体用例
    const wrong = solution.replace(
      'for (int[] row : grid)',
      'for (int[] row : (grid.length > 0 ? new int[][] { grid[0] } : grid))',
    );
    const failed = await runJudge({ questionId: question.id, submission: wrong }, question);
    expect(failed.status).toBe('fail');
    expect(failed.failedCases.map((c) => c.name)).toContain('常规 2x3');
  }, 120_000);
});

/** N-04：链表/树这类指针结构题（LeetCode 口径的序列化为 `[1,2,3]` 与层序 `[3,9,20,null,null,15,7]`）。 */
describe('java-junit 的 ListNode / TreeNode 入参与返回', () => {
  const LIST_CORRECT = `public class Solution {
  public ListNode partitionList(ListNode head, int pivot) {
    ListNode loH = new ListNode(0), loT = loH;
    ListNode eqH = new ListNode(0), eqT = eqH;
    ListNode hiH = new ListNode(0), hiT = hiH;
    for (ListNode n = head; n != null; ) {
      ListNode next = n.next;
      n.next = null;
      if (n.val < pivot) { loT.next = n; loT = n; }
      else if (n.val > pivot) { hiT.next = n; hiT = n; }
      else { eqT.next = n; eqT = n; }
      n = next;
    }
    loT.next = eqH.next != null ? eqH.next : hiH.next;
    eqT.next = hiH.next;
    return loH.next != null ? loH.next : (eqH.next != null ? eqH.next : hiH.next);
  }
}`;

  // 段内改成"头插"：结果按段反转，稳定划分这条用例必挂
  const LIST_UNSTABLE = LIST_CORRECT
    .replace('{ loT.next = n; loT = n; }', '{ n.next = loH.next; loH.next = n; if (loT == loH) loT = n; }')
    .replace('{ hiT.next = n; hiT = n; }', '{ n.next = hiH.next; hiH.next = n; if (hiT == hiH) hiT = n; }');

  const listQuestion = () =>
    makeQuestion({
      id: 'alg-java-harness-list-0001',
      title: '按枢轴把请求链做稳定三段划分',
      statement: '实现 partitionList(head, pivot)：< pivot 的段、== pivot 的段、> pivot 的段依次拼接，段内保持原相对顺序，且必须复用原节点。',
      language: 'java',
      cases: [
        { name: '空链返回空', input: [[], 3], expected: [] },
        { name: '全部小于枢轴时原序返回', input: [[1, 2], 3], expected: [1, 2] },
        { name: '三段划分且段内保持相对顺序', input: [[3, 5, 2, 1, 4], 3], expected: [2, 1, 3, 5, 4] },
        { name: '全部等于枢轴', input: [[7, 7], 7], expected: [7, 7] },
      ],
      runner: { className: 'Solution', signature: 'ListNode partitionList(ListNode head, int pivot)', referenceSolution: LIST_CORRECT, timeoutMs: 20_000 },
    });

  guarded('ListNode 入参：判题器按数组造好链表，返回再比回数组', async () => {
    const question = listQuestion();
    const result = await runJudge({ questionId: question.id, submission: LIST_CORRECT }, question);
    expect(result.status, result.logs ?? '').toBe('pass');
    expect(result.passed).toBe(4);
    expect(result.failedCases).toEqual([]);
  }, 120_000);

  guarded('ListNode 结果不是橡皮图章：段内顺序错了要挂，并点名那条用例', async () => {
    const question = listQuestion();
    const result = await runJudge({ questionId: question.id, submission: LIST_UNSTABLE }, question);
    expect(result.status).toBe('fail');
    expect(result.failedCases.map((c) => c.name)).toContain('三段划分且段内保持相对顺序');
    const mismatch = result.failedCases.find((c) => c.name === '三段划分且段内保持相对顺序')!;
    expect(String(mismatch.expected)).toBe('[2,1,3,5,4]');
    expect(String(mismatch.actual)).toBe('[1,2,3,4,5]');
  }, 120_000);

  const TREE_CORRECT = `public class Solution {
  private int best;
  public int longestUnivaluePath(TreeNode root) {
    best = 0;
    depth(root);
    return best;
  }
  private int depth(TreeNode node) {
    if (node == null) return 0;
    int l = depth(node.left);
    int r = depth(node.right);
    int ll = 0, rr = 0;
    if (node.left != null && node.left.val == node.val) ll = l + 1;
    if (node.right != null && node.right.val == node.val) rr = r + 1;
    best = Math.max(best, ll + rr);
    return Math.max(ll, rr);
  }
}`;

  // 只取单边最长：漏掉"经过根"的双边路径
  const TREE_ONE_SIDE = TREE_CORRECT.replace('best = Math.max(best, ll + rr);', 'best = Math.max(best, Math.max(ll, rr));');

  guarded('TreeNode 入参：层序数组（含 null 占位）能建成二叉树', async () => {
    const question = makeQuestion({
      id: 'alg-java-harness-tree-0001',
      title: '二叉树中最长的同值路径（按边数）',
      statement: '实现 longestUnivaluePath(root)：返回任意两点之间路径上最长的"节点值全相同"的边数；路径可以经过根，不必落到叶子。',
      language: 'java',
      cases: [
        { name: '空树返回 0', input: [null], expected: 0 },
        { name: '单节点返回 0', input: [[1]], expected: 0 },
        { name: '单边同值', input: [[1, 1, 2]], expected: 1 },
        { name: '经过根的双边同值', input: [[1, 1, 1]], expected: 2 },
        { name: '跨不同值不计数', input: [[2, 2, 2, 1, 1, null, 3]], expected: 2 },
      ],
      runner: { className: 'Solution', signature: 'int longestUnivaluePath(TreeNode root)', referenceSolution: TREE_CORRECT, timeoutMs: 20_000 },
    });
    const right = await runJudge({ questionId: question.id, submission: TREE_CORRECT }, question);
    expect(right.status, right.logs ?? '').toBe('pass');
    expect(right.passed).toBe(5);

    const wrong = await runJudge({ questionId: question.id, submission: TREE_ONE_SIDE }, question);
    expect(wrong.status).toBe('fail');
    expect(wrong.failedCases.map((c) => c.name)).toContain('经过根的双边同值');
  }, 120_000);

  const MIRROR = `public class Solution {
  public TreeNode mirrorTree(TreeNode root) {
    if (root == null) return null;
    TreeNode left = mirrorTree(root.left);
    root.left = mirrorTree(root.right);
    root.right = left;
    return root;
  }
}`;

  guarded('TreeNode 返回值：比回层序数组，尾部 null 写法不同也算等价', async () => {
    const question = makeQuestion({
      id: 'alg-java-harness-tree-0002',
      title: '整棵树做镜像（原地交换左右子树）',
      statement: '实现 mirrorTree(root)：返回镜像后的树。判题按层序数组比较，尾部 null 占位可有可无。',
      language: 'java',
      cases: [
        { name: '空树镜像还是空', input: [null], expected: null },
        { name: '满二叉树左右互换', input: [[1, 2, 3]], expected: [1, 3, 2] },
        // 期望值写成带尾部 null 的等价形式，也要判过
        { name: '只有左子链的树', input: [[1, 2, null, 3]], expected: [1, null, 2, null, 3, null, null] },
      ],
      runner: { className: 'Solution', signature: 'TreeNode mirrorTree(TreeNode root)', referenceSolution: MIRROR, timeoutMs: 20_000 },
    });
    const right = await runJudge({ questionId: question.id, submission: MIRROR }, question);
    expect(right.status, JSON.stringify(right.failedCases)).toBe('pass');
    expect(right.passed).toBe(3);

    const identity = MIRROR.replace('root.right = left;', 'root.right = root.left; root.left = left;');
    const wrong = await runJudge({ questionId: question.id, submission: identity }, question);
    expect(wrong.status).toBe('fail');
    expect(wrong.failedCases.map((c) => c.name)).toContain('满二叉树左右互换');
  }, 120_000);

  guarded('签名里没有指针类型时，判题器不许塞同名类进沙箱（会撞用户自己的定义）', async () => {
    const solution = `class ListNode {
  int val;
  ListNode next;
}

public class Solution {
  public static int sizeOf(int n) {
    ListNode head = null;
    for (int i = 0; i < n; i++) {
      ListNode node = new ListNode();
      node.val = i;
      node.next = head;
      head = node;
    }
    int count = 0;
    for (ListNode c = head; c != null; c = c.next) count++;
    return count;
  }
}`;
    // 签名是普通 int 入参 → 判题器不该写 ListNode.java，否则这里会 duplicate class 编译不过
    const question = makeQuestion({
      id: 'alg-java-harness-list-0002',
      title: '自建链表节点类不该被判题器覆盖',
      statement: '用考生自己定义的 ListNode 统计节点数，验证判题器只在签名声明指针类型时才注入内置类。',
      language: 'java',
      cases: [
        { name: '空链返回 0', input: [0], expected: 0 },
        { name: '五个节点返回 5', input: [5], expected: 5 },
      ],
      runner: { className: 'Solution', signature: 'int sizeOf(int n)', referenceSolution: solution, timeoutMs: 20_000 },
    });
    const result = await runJudge({ questionId: question.id, submission: solution }, question);
    expect(result.status, result.logs ?? '').toBe('pass');
    expect(result.passed).toBe(2);
  }, 120_000);

  guarded('考生自己又定义了一遍 ListNode 时，报错要说人话', async () => {
    const question = listQuestion();
    const duplicated = `class ListNode { int val; ListNode next; }\n${LIST_CORRECT}`;
    const result = await runJudge({ questionId: question.id, submission: duplicated }, question);
    expect(result.status).toBe('error');
    expect(result.errorKind).toBe('compile');
    expect(result.logs).toContain('内置');
  }, 120_000);
});
