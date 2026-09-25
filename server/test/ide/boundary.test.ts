import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * 解耦闸门（红线 C4 的延伸）。
 *
 * C4 原本只管"题库 ⊥ 游戏"。网页 IDE 是第三个子系统，
 * 它复用的只能是**通用执行底座**（judge/process.ts、judge/workspace.ts），
 * 不能复用判题语义 —— 一旦 import 了 runner/registry/bank/game，
 * "改判题器顺手改坏 IDE"或"IDE 里偷偷读到题目答案"就都只是时间问题。
 *
 * 这条测试本身就是 WI-64 的一部分：先有边界，再长功能。
 */

const ROOT = join(__dirname, '..', '..');   // server/

/**
 * IDE 后端**允许**引的东西（白名单，不是黑名单）。
 *
 * 为什么反过来写：黑名单会随目录演化悄悄漏 —— 2026-09-24 把白名单从 `judge/guards`
 * 搬到 `exec/guards` 时，`/\/judge\/guards/` 这条就变成了一条永远不成立的死规则，
 * 而"IDE 不许碰判题"这件事看起来还在被守着。白名单的做法是：新路径默认不许引，
 * 要引就得有人想清楚"这是执行底座还是判题逻辑"。
 */
const ALLOWED_IMPORTS: readonly RegExp[] = [
  /^@\//,                       // 别名（如果有）
  /^@arena\/shared/,            // 跨层只经 shared 契约（红线 C4）
  /^[a-z@]/,                    // npm 包：ioredis / fastify / …
  /^\.\//,                      // ide/ 内部
  /^\.\.\/(config|log|ports)\.js$/,
  /^\.\.\/judge\/(process|workspace)\.js$/,   // 通用执行底座：起进程、建沙箱目录
  /^\.\.\/exec\//,                            // 共享执行底座（mysql / redis / spark / 白名单）
];

/** 答案与评分判据是"只从详情端点出"的（红线 C7），IDE 一侧碰都不该碰。 */
const FORBIDDEN_SYMBOLS = ['questionReference', 'referenceSolution', 'visibleQuestions', 'rubric'];

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
}

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('WI-64 网页 IDE 的解耦边界', () => {
  it('server/src/ide 只引白名单里的模块（判题 runner / 题库 / 游戏一律不许）', async () => {
    const files = await tsFiles(join(ROOT, 'src', 'ide'));
    expect(files.length, 'server/src/ide 至少要有源文件，否则这条闸门是空转的').toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (!ALLOWED_IMPORTS.some((ok) => ok.test(spec))) violations.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    expect(violations, `IDE 引了白名单之外的模块：\n${violations.join('\n')}`).toEqual([]);
  });

  it('白名单本身不许退化成"什么都放进来"（守门人也要被守）', async () => {
    // 有人把这条改成 /./ 就把它自己废了 —— 那正是本仓库反复付过学费的那类"闸门变装饰"。
    expect(ALLOWED_IMPORTS.length).toBeLessThanOrEqual(10);
    const anyMatchAll = ALLOWED_IMPORTS.filter((re) => re.source === '\\.\\*').length;
    expect(anyMatchAll, '白名单里出现了通配所有相对路径的条目').toBe(0);
    for (const forbidden of ['judge/runners', 'judge/registry', 'bank/', 'game/']) {
      expect(
        ALLOWED_IMPORTS.some((re) => re.test(`../${forbidden}foo.js`)),
        `白名单竟然允许引 ${forbidden}`,
      ).toBe(false);
    }
  });

  it('server/src/ide 不引用答案与评分相关的符号', async () => {
    for (const file of await tsFiles(join(ROOT, 'src', 'ide'))) {
      const source = await readFile(file, 'utf8');
      for (const symbol of FORBIDDEN_SYMBOLS) {
        expect(source.includes(symbol), `${relative(ROOT, file)} 引用了 ${symbol}`).toBe(false);
      }
    }
  });

  it('IDE 的前端文件只走 /api/ide/*，不碰题目接口', async () => {
    // 逐个文件点名，而不是只查 Ide.tsx：IDE 的界面会长出子组件（REPL 面板就是第一个），
    // 只查入口文件等于给"在子组件里偷偷调题目接口"开门。
    const files = ['pages/Ide.tsx', 'components/ReplPanel.tsx'];
    for (const name of files) {
      const source = await readFile(join(ROOT, '..', 'web', 'src', name), 'utf8');
      for (const bad of ['getQuestionDetail', '/questions/', '/bank', 'submitAnswer', 'judgeStream']) {
        expect(source.includes(bad), `${name} 不该出现 "${bad}"（它必须独立于做题系统）`).toBe(false);
      }
    }
  });

  it('通用执行底座（process/workspace）自己不反向依赖 IDE', async () => {
    for (const name of ['process.ts', 'workspace.ts']) {
      const source = await readFile(join(ROOT, 'src', 'judge', name), 'utf8');
      expect(source.includes('/ide/'), `${name} 被 IDE 污染了`).toBe(false);
    }
  });

  it('Spark 的可用性判据只有一份（exec/ 里的同一个函数，IDE 与判题各自不拼命令）', async () => {
    // 注册表里只允许写 probeKind；真正"这台机器跑不跑了 Spark"的判据住在 exec/spark-*。
    // IDE 与判题 runner 必须都调它 —— 两份判据迟早变成"IDE 说可用、判题说 unavailable"。
    const ideSource = await readFile(join(ROOT, 'src', 'ide', 'executors.ts'), 'utf8');
    const judgePyspark = await readFile(join(ROOT, 'src', 'judge', 'runners', 'pyspark.ts'), 'utf8');
    const judgeScala = await readFile(join(ROOT, 'src', 'judge', 'runners', 'spark-scala.ts'), 'utf8');

    for (const [name, source] of [['IDE', ideSource], ['判题 pyspark', judgePyspark]] as const) {
      expect(source.includes('pysparkAvailable'), `${name} 的 pyspark 可用性判据没走 exec/`).toBe(true);
    }
    for (const [name, source] of [['IDE', ideSource], ['判题 spark-scala', judgeScala]] as const) {
      expect(source.includes('scalaSparkAvailable'), `${name} 的 scala 可用性判据没走 exec/`).toBe(true);
    }
  });
});
