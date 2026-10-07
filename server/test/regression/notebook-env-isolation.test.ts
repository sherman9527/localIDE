import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 红线一的延伸：notebook 里的 `!pip3 install X` 跑的是 **shell**，而 shell 的 PATH 上默认那个
 * pip3 是**系统** pip ⇒ 包写进系统 site-packages ⇒ 判题用的正是那个解释器。
 * IDE 的命令窗口当初是靠"改写成 venv 的 python -m pip"堵掉的（ide/env-command.ts），
 * notebook 是同一件事的第二个入口。它坏掉的表征不是报错，是"某天判题结果变了" ——
 * 跟 notebook 隔了十万八千里，所以必须在功能存在之前先立住。
 *
 * 判据为什么长这样（review 之后收紧的，四种"看着实现了其实什么都没做"各对应一条）：
 * ① 只看代码视图：丢掉整行注释（`^\s*#`）以后再判 ⇒ 挡住"一句 TODO 注释写着 PATH=… 就骗绿"。
 *    行尾的尾随注释不剥（`"#fff"`、`--foo=#bar` 这类引号里的 `#` 剥了会误伤真实现）。
 * ② 命令锚定：必须是"这一行真的在跑 jupyter notebook"（去缩进后允许 exec/env 与若干 `VAR=值 `
 *    前缀）⇒ 挡住文件更早处的注释或日志字符串把顺序判据撞红（收紧前它是反着坏的）。
 * ③ 前缀位置：PATH 赋值必须是那条启动语句的**前缀** —— 同一行，或紧邻上一行且行尾带续行符。
 *    ⇒ 挡住"写在没人调用的 setup_path() 里""写在提前 return 的分支里"，也挡住独立成行的
 *    `export PATH=…`：那种写法虽然能让 jupyter 拿到 venv，但会把 venv 漏给 `exec "$@"` 之后的
 *    应用进程与判题（正是红线一本身），所以不许绿。
 * ④ 前置 vs 追加各自一条判据、各自一条消息 ⇒ `PATH="${PATH}:${…}/python/bin"` 会说"这是追加"，
 *    而不是骗作者"找不到 PATH 那一行"。
 * 另加一条 ⑤：启动语句所在函数若从没被调用，整段都是死的 ⇒ 也红。
 *
 * 代价（写在这里，也写在失败消息里，别让人自己猜）：③ 的"紧邻"就是"前置"的字面语义，所以
 * **任何在 PATH 行与命令行之间插行的重构都会变红**。修法是把赋值挪回命令行紧邻的上一行并保留
 * 行尾 `\`；不要改成独立 export（那是 ③ 末段说的那个漏洞）。顺带一提，"`VAR=… \` 后面跟了别的
 * 命令"在 bash 里会被续行符拼成**给那条命令的前缀**，赋值根本到不了 jupyter —— 所以这条红通常
 * 就是真 bug，不是判据苛刻。
 *
 * 本闸门只验**结构**，不验效果：真正证明"notebook 的 shell 拿到的是 venv 的 pip3"由 Task 10 在
 * 容器档里读运行中的 jupyter 进程 /proc/<pid>/environ 来做 —— 这里保持纯宿主可跑。
 */

type Line = { no: number; raw: string };

/** 'ok' 之外的每个 code 都是一种具体的失败形状，消息与之一对一（见上面的 ①–⑤）。 */
type FailCode = 'no-jupyter-cmd' | 'no-path-assign' | 'path-not-prefix' | 'path-appended' | 'launch-unreachable';
type Verdict = { ok: boolean; code: FailCode | 'ok'; message: string };

const fail = (code: FailCode, message: string): Verdict => ({ ok: false, code, message });
const pass = (): Verdict => ({ ok: true, code: 'ok', message: '结构判据成立' });

/** ① 代码视图：丢掉整行注释，但保留**原始行号**（失败消息要指得到行）。 */
function codeView(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .map((raw, i): Line => ({ no: i + 1, raw }))
    .filter((l) => !/^\s*#/.test(l.raw));
}

/**
 * 这一行是不是"把 IDE venv 的 bin 放进 PATH"的赋值。
 * 命中则返回从 `PATH=` 起的文本（供 ④ 判断前后次序）。前置字符类避免误伤 `PYTHONPATH=`。
 */
function venvPathAssign(line: string): string | null {
  const m = /(?:^|[\s;&(])PATH=/.exec(line);
  if (!m) return null;
  const assign = line.slice(m.index + m[0].indexOf('PATH='));
  if (!assign.includes('ARENA_IDE_ENV_DIR') || !assign.includes('/python/bin')) return null;
  return assign;
}

/** ② 找到"真的在执行 jupyter notebook"的那一行；找不到返回 -1。 */
function jupyterLaunchIndex(lines: Line[]): number {
  const re = /^\s*(?:exec\s+|env\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*jupyter\s+notebook\b/;
  return lines.findIndex((l) => re.test(l.raw));
}

/** ⑤ 命令所处的函数：取它之前最后一个 `name() {`，遇到独占一行的 `}` 就出栈（本仓库的书写风格）。 */
function enclosingFn(lines: Line[], cmdIdx: number): { name: string; defIdx: number } | null {
  let fn: { name: string; defIdx: number } | null = null;
  for (let i = 0; i < cmdIdx; i++) {
    const raw = lines[i]?.raw ?? '';
    const def = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{?\s*$/.exec(raw);
    if (def) {
      fn = { name: def[1] as string, defIdx: i };
      continue;
    }
    if (/^\s*\}\s*$/.test(raw)) fn = null;
  }
  return fn;
}

/** ⑤ 有没有哪里把它当命令调用（定义行本身不算）。 */
function isCalled(lines: Line[], defIdx: number, name: string): boolean {
  const re = new RegExp(`^\\s*${name}\\b(?!\\s*\\()`);
  return lines.some((l, i) => i !== defIdx && re.test(l.raw));
}

/**
 * 判据本体。入口断言与下面的常驻反例**都调这一个函数** —— 否则"自检"验的是它自己的副本，
 * 判据退化时它照样绿（review Important #2）。
 */
function judge(text: string, where: string): Verdict {
  const lines = codeView(text);
  const cmdIdx = jupyterLaunchIndex(lines);
  if (cmdIdx < 0) return fail('no-jupyter-cmd', `${where}：代码里找不到"真的在执行 jupyter notebook"的那一行（注释或日志字符串里提一句不算）`);
  const cmd = lines[cmdIdx] as Line;

  // ③ 前缀位置：同一行的 VAR= 前缀，或紧邻上一行且行尾带续行符
  let assignLine = cmd;
  let assign = venvPathAssign(cmd.raw);
  if (assign === null) {
    const prev = lines[cmdIdx - 1];
    const prevAssign = prev ? venvPathAssign(prev.raw) : null;
    if (prev && prevAssign && /\\\s*$/.test(prev.raw)) {
      assignLine = prev;
      assign = prevAssign;
    } else {
      const stray = lines.find((l) => l !== cmd && venvPathAssign(l.raw) !== null);
      if (!stray) {
        return fail(
          'no-path-assign',
          `${where}：没有任何把 IDE venv 的 bin 放进 PATH 的**代码**行（整行注释不算）⇒ notebook 里的 !pip3 install 会命中系统 pip，包写进判题用的那个解释器`,
        );
      }
      return fail(
        'path-not-prefix',
        `${where}:${stray.no} 有 venv 的 PATH 赋值，但它不是启动语句（${where}:${cmd.no}）的前缀。只在两种位置算前置：命令行同一行的 VAR= 前缀，或紧邻上一行且行尾带 \\。` +
          `写成独立一行的 export PATH=… 会把 venv 漏给 exec "$@" 之后的应用与判题进程（红线一），不算；` +
          `写在没人调用的函数里、写在提前 return 的分支里、或中间隔了别的命令（续行符会把前缀给那条命令而不是 jupyter）都不算。把赋值挪成启动语句的前缀`,
      );
    }
  }

  // ④ 前置 vs 追加
  const venvAt = assign.indexOf('ARENA_IDE_ENV_DIR');
  const inheritAt = assign.search(/\$\{?PATH\b/);
  if (inheritAt >= 0 && inheritAt < venvAt) {
    return fail(
      'path-appended',
      `${where}:${assignLine.no} 的 PATH 写成了**追加**（$PATH 排在 venv 之前）而不是前置 ⇒ 系统 pip 仍先被命中。应为 PATH="\${ARENA_IDE_ENV_DIR…}/python/bin:\${PATH}"（venv 在前）`,
    );
  }

  // ⑤ 可达性：启动语句所在函数必须真被调用，否则整段是死的
  const fn = enclosingFn(lines, cmdIdx);
  if (fn && /^\s+\S/.test(cmd.raw) && !isCalled(lines, fn.defIdx, fn.name)) {
    return fail('launch-unreachable', `${where}:${cmd.no} 在 ${fn.name}() 里，但 ${where} 没有任何地方调用 ${fn.name} ⇒ 这段 PATH 与 jupyter 都不会执行，前缀写得再对也是死的。在文件里调用它`);
  }

  return pass();
}

const ENTRYPOINT_REL = join('docker', 'entrypoint.sh');
const ENTRYPOINT = () => readFileSync(join(config.repoRoot, ENTRYPOINT_REL), 'utf8');

describe('notebook 的 shell 必须落进 IDE 的 venv（红线一延伸）', () => {
  it('entrypoint 里有一行真的在跑 jupyter notebook（注释/日志字符串里提一句不算）', () => {
    const cmdIdx = jupyterLaunchIndex(codeView(ENTRYPOINT()));
    expect(cmdIdx, `${ENTRYPOINT_REL} 里还没有真正执行 jupyter notebook 的那一行（Task 3 要加的启动语句）`).toBeGreaterThanOrEqual(0);
  });

  it('venv 的 PATH 前置就在那条启动语句的前缀位置（判据见 judge）', () => {
    const v = judge(ENTRYPOINT(), ENTRYPOINT_REL);
    expect(v.ok, v.message).toBe(true);
  });
});

/**
 * 常驻反例：全部喂给**同一个 judge**。
 * 这一块的职责是"判据退化时它必须跟着红"——把 `^\s*#` 的过滤去掉、把命令锚定退回"文件里出现过
 * jupyter notebook"、或把判据松成 `/PATH=/`，下面立刻有用例翻脸。
 * 样本一律内联（不在仓库里留坏形状文件）：闸门扫的是 docker/entrypoint.sh，留个坏脚本反而会被
 * 别的阶段（scripts-syntax / bash -n）认领，制造与判题无关的红。
 */
type Fixture = { name: string; text: string; expect: FailCode | 'ok' };

/**
 * 这份 fixture 里的 `--ServerApp.ip` 写的是 **0.0.0.0**，不是当初计划里的 `127.0.0.1`。
 * 一句话为什么：那个旧字面量是个陷阱 —— 发布端口是 DNAT 到**容器的 eth0 地址**的，
 * 只听容器回环 = 宿主打不开（Task 10 实测：容器内 302、eth0 与宿主 7789 都是 000）。
 * 本闸门判的是 **PATH 前缀的结构**，从不看 ip 的值（judge() 里没有这条判据），
 * 所以这里改的只是"别让下一位照抄一个错的启动行"；ip 的不变量钉在
 * `notebook-contract.test.ts`（不许监听在容器回环）与 `notebooks/kernel.test.ts`
 * （DNAT 目标上必须有人在听）那两处。
 */
const PLAN_SHAPE = [
  '# venv 前置到 PATH：notebook 里 !pip3 install X 走 shell，命中哪个 pip 由 PATH 决定。',
  'start_jupyter() {',
  '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \\',
  '  jupyter notebook --allow-root --no-browser \\',
  '    --ServerApp.ip=0.0.0.0 --ServerApp.port=8888 \\',
  '    >/var/log/jupyter.log 2>&1 &',
  '  return 0',
  '}',
  '',
  'start_jupyter',
].join('\n');

const FIXTURES: Fixture[] = [
  {
    // Task 3 的计划形状（判据必须为它而绿 —— 这条同时也是"别把对的实现判红"的锚）
    name: '计划形状：PATH 前缀带续行符，紧贴 jupyter 命令行，函数被调用',
    text: PLAN_SHAPE,
    expect: 'ok',
  },
  {
    // 同行前缀同样是前缀，不许因为"不在上一行"就判红
    name: '同一行的 VAR= 前缀写法',
    text: '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" jupyter notebook --allow-root &\n',
    expect: 'ok',
  },
  {
    // Minor #4 的镜像故障：更早处的注释/日志字符串不许把对的实现撞红
    name: '正确实现，但文件更早处有注释与日志字符串提到 jupyter notebook',
    text:
      'log "准备起 jupyter notebook（可以不起）"\n' +
      '# 老写法里 jupyter notebook 之前什么 PATH 都没有，那是错的\n' +
      PLAN_SHAPE,
    expect: 'ok',
  },
  {
    // ①（只有"剥整行注释"这条拦得住它：PATH= 前面是空格，锚定与续行符都齐了）
    name: '整行注释本身就是一个合法的 PATH 前缀形状（注释过滤是它唯一的拦截）',
    text: '# PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \\\njupyter notebook --allow-root &\n',
    expect: 'no-path-assign',
  },
  {
    // Important #1 复现②：注释骗绿
    name: '只有 TODO 注释写着 PATH 前置，命令行光着',
    text: '# TODO Task 3 要加：PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \\\nexec jupyter notebook --allow-root\n',
    expect: 'no-path-assign',
  },
  {
    // Important #1 复现③：赋值在没人调用的函数里
    name: 'PATH 写在 setup_path() 里，但该函数从没被调用，jupyter 在顶层裸跑',
    text:
      'setup_path() {\n' +
      '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}"\n' +
      '  export PATH\n' +
      '}\n' +
      'exec jupyter notebook --allow-root\n',
    expect: 'path-not-prefix',
  },
  {
    // Important #1 复现④：提前 return 的分支里给的 PATH
    name: 'PATH 在提前 return 的 if 分支里，jupyter 在分支之后裸跑',
    text:
      'if [ -z "${ARENA_JUPYTER_TOKEN:-}" ]; then\n' +
      '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}"\n' +
      '  log "缺 token，直接退"\n' +
      '  return 0\n' +
      'fi\n' +
      'exec jupyter notebook --allow-root\n',
    expect: 'path-not-prefix',
  },
  {
    // ⑤：前缀与命令都写对了，但整段函数没人调
    name: 'PATH 与 jupyter 都在从未调用的函数里',
    text:
      'start_jupyter() {\n' +
      '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \\\n' +
      '  jupyter notebook --allow-root &\n' +
      '}\n',
    expect: 'launch-unreachable',
  },
  {
    // Important #1 复现⑤ + Minor #3：必须是"追加"这条专属消息，不许退化成"找不到 PATH 那一行"
    name: '值写反：追加而不是前置',
    text: 'PATH="${PATH}:${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin" \\\njupyter notebook --allow-root &\n',
    expect: 'path-appended',
  },
  {
    // ③ 末段：能用但会污染 exec "$@" 之后进程的写法，故意不许绿
    name: '独立成行的 export PATH=…（没有续行符前缀语义）',
    text: 'export PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}"\njupyter notebook --allow-root &\n',
    expect: 'path-not-prefix',
  },
  {
    // 相邻规则的代价，作为常驻记录（重构插行时会撞这条，消息里写了怎么办）
    name: 'PATH 行与命令行之间插了一行（续行符会把前缀给 mkdir，不是 jupyter）',
    text:
      'start_jupyter() {\n' +
      '  PATH="${ARENA_IDE_ENV_DIR:-/opt/arena-ide-env}/python/bin:${PATH}" \\\n' +
      '  mkdir -p /app/data/notebooks\n' +
      '  jupyter notebook --allow-root &\n' +
      '}\n' +
      'start_jupyter\n',
    expect: 'path-not-prefix',
  },
  {
    // 当前仓库的真实状态：确认入口那两条红是"缺功能"，不是"判据没接线"
    name: '根本没有 jupyter 启动语句（Task 3 之前的现状）',
    text: 'log "启动应用：$*"\nexec "$@"\n',
    expect: 'no-jupyter-cmd',
  },
];

describe('这条闸门的判据本身（常驻反例，喂的就是 judge 本体）', () => {
  for (const f of FIXTURES) {
    it(`${f.expect === 'ok' ? '认得' : `拦下 ${f.expect}`}：${f.name}`, () => {
      const v = judge(f.text, f.name);
      expect(v.code, v.message).toBe(f.expect);
      expect(v.ok, v.message).toBe(f.expect === 'ok');
    });
  }

  it('五种失败各有各的 code 与消息（Minor #3：不许把作者指向错的方向）', () => {
    const byCode = new Map<string, Verdict>();
    for (const f of FIXTURES) {
      if (f.expect === 'ok') continue;
      const v = judge(f.text, f.name);
      expect(v.code, v.message).toBe(f.expect);
      byCode.set(v.code, v);
    }
    expect([...byCode.keys()].sort()).toEqual([
      'launch-unreachable',
      'no-jupyter-cmd',
      'no-path-assign',
      'path-appended',
      'path-not-prefix',
    ]);
    // "追加而非前置"这一条不能再被说成"找不到 PATH 那一行"：那行明明在，错的是次序
    expect(byCode.get('path-appended')?.message).toContain('追加');
    expect(byCode.get('path-appended')?.message).not.toMatch(/找不到|没有任何/);
    expect(byCode.get('no-path-assign')?.message).toContain('代码');
    expect(byCode.get('path-not-prefix')?.message).toContain('前缀');
    expect(byCode.get('launch-unreachable')?.message).toContain('调用');
    expect(byCode.get('no-jupyter-cmd')?.message).toContain('jupyter notebook');
  });

  it('judge 对同一个正确形状是幂等的，且不会因为多一个空行而翻脸（相邻规则的边界）', () => {
    const a = judge(PLAN_SHAPE, 'plan');
    const b = judge(PLAN_SHAPE + '\n\n', 'plan + 尾部空行');
    expect(a.ok, a.message).toBe(true);
    expect(b.ok, b.message).toBe(true);
    // 但在 PATH 与命令之间插空行确实该红 —— 这是相邻规则明写的代价，不是判据不稳定
    const inserted = judge(PLAN_SHAPE.replace('  jupyter notebook', '  sleep 1\n  jupyter notebook'), 'plan + 中间插行');
    expect(inserted.ok, inserted.message).toBe(false);
    expect(inserted.code).toBe('path-not-prefix');
  });
});
