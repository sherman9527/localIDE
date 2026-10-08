import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, consumeIdeEnvDir, consumeJupyterToken } from '../../src/config.js';
import { runProcess } from '../../src/judge/process.js';

/**
 * 红线一：IDE 的依赖环境（`data/ide-env/`）绝不允许出现在判题进程里。
 *
 * 为什么风险是真实的而不是理论上的：判题的 env 构造是
 * `judge/process.ts:31` 与 `exec/spark-pool.ts:191` 两处的 `{ ...process.env, ...opts.env }`。
 * 于是"给 IDE 注入环境"有一条极其顺手、又正好毁掉判题可复现性的写法 ——
 * 在服务端启动时写一句 `process.env.PYTHONPATH = ...`。它不会报错，只会让
 * "用户今天在 IDE 里装的包"改变"明天判题的结果"，而 `docker/BUILDINFO.md` 承诺的是
 * 重建镜像即可复现。⇒ 这条闸门必须在功能存在之前先立住。
 *
 * 四条断言各守一层，缺一不可：
 *   A 行为：真的走一次 runProcess，看子进程拿到的 env 里有没有 ide-env。
 *   B 全局：服务进程自己的 process.env 必须干净（A 之所以成立是因为 B）。
 *   B2 机制：B 在容器里成立是因为 config 把 ARENA_IDE_ENV_DIR 读完就摘掉 —— 那个动作本身要能验，
 *            否则 B 只是在赌"这台机器没设过这个变量"（容器里就是设过的，见下）。
 *   C 源码：判题目录不许引用 ide-env；IDE 目录不许写 process.env。
 *   D 凭据（终审 I-2 补的一层）：**键名**像凭据的 compose env 键，要么被 config 消费掉、要么显式列管写原因。
 *      B/A 原来只按**值**找 `ide-env`，于是对一个随机 token 值天生瞎 —— 那一层若不同样按键名判，
 *      "下一个凭据"就会顺着同一条路进来而门禁一片绿（这正是 I-2 要堵的形状）。
 *
 * 红线一的原话是"IDE 的依赖环境不许出现在判题进程里"，D 组把它读回本来的意思：
 * **服务进程里的东西会经由 `{ ...process.env }` 传给每一道提交的代码**，IDE 环境只是第一个撞上的样本，
 * 凭据是第二个。
 *
 * B 为什么不能只靠"宿主上没这个变量"就算通过：compose 给 arena / dev / e2e 三个服务都显式设了
 * `ARENA_IDE_ENV_DIR=/opt/arena-ide-env`（venv 建在 bind mount 上要 87s，必须指到命名卷），
 * 所以容器里服务进程的 process.env 天生带它，而它会被每一个判题子进程继承。
 * 这条闸门第一次在容器交付档跑红（宿主全绿），修法是把变量在 config 里消费掉，而不是在判题层过滤
 * —— 后者要求判题层知道 IDE 有这套东西，那正是红线一不想要的。
 */

const IDE_ENV_MARKER = 'ide-env';

/**
 * **第二套标记：键名形状**（终审 I-2 补的，`IDE_ENV_MARKER` 那套判的是"值里有没有 ide-env"）。
 *
 * 为什么"标记集要扩展"是这条闸门的重点而不是顺手一改：`ARENA_JUPYTER_TOKEN` 的害处与
 * `ARENA_IDE_ENV_DIR` 一模一样（都是 `{ ...process.env }` 把服务进程的东西送给每一个判题子进程），
 * 但它的值**不长这样** —— 它是一串随机凭据，永不含 `ide-env`。于是只按值匹配的旧判据对这个键
 * 天生瞎：把 token 原样留给判题层，B 与 A 两条都会绿。⇒ 判**键名**。
 *
 * 只认 `ARENA_` 前缀是本仓库自己的地盘（rule.md C1：一切配置在自己目录内），
 * 不去扫 `PATH`/`npm_*` 这类别人的键，免得闸门变成噪音源。
 */
const CREDENTIAL_KEY_RE = /^ARENA_[A-Z0-9_]*(?:_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_KEY)$/;

/**
 * "compose 给了、但**没有**在 config 里消费掉"的凭据键 —— 每一条都要写原因，白名单不是免责声明。
 * 加了新凭据又不想写原因 ⇒ D1 红，这就是"下一个凭据会被同一条闸门抓到"的具体形状。
 */
const CREDENTIAL_NOT_CONSUMED: Record<string, string> = {
  ARENA_LLM_BRIDGE_TOKEN:
    '已知未摘除（早于 I-2 存在，不在本轮范围）：宿主 CLI 桥的凭据，判题子进程同样能读到它。' +
    '留在这里是为了让"新增凭据必须做一次显式决定"这条判据继续有效，不是给它发通行证 —— 处理它的人请照 ' +
    'consumeJupyterToken() 的形状做，然后删掉这一行（D2 会在容器档替你确认键真的没了）。',
};

function envLooksClean(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && v.includes(IDE_ENV_MARKER))
    .map(([k]) => k);
}

/** 环境里"长得像凭据、又没被显式列管"的键名（只回名字，绝不回值 —— 值可能真是凭据）。 */
function credentialKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => CREDENTIAL_KEY_RE.test(k) && !(k in CREDENTIAL_NOT_CONSUMED));
}

/**
 * compose.yml 里**配置行上**出现的凭据形状键（整行注释与行尾随行注释都不算 ——
 * 与 `notebook-compose.test.ts` 的 `configLine` 同一条纪律：判配置不判注释，
 * 否则"在注释里写一句 ARENA_JUPYTER_TOKEN"就能骗过判据）。
 * 扫整个文件而不是逐服务解析：这条判据问的是"这个仓库有没有引入一个新凭据"，与它给哪几台无关。
 * 正文拆成纯函数是为了让"注释不算"这一半能被反例判住（判真实文件时，那条反例永远无从制造）。
 */
function credentialKeysInComposeText(yaml: string): string[] {
  const found = new Set<string>();
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const kv = /^([A-Z0-9_]+)\s*:/.exec(line.replace(/\s+#.*$/, ''));
    if (kv && CREDENTIAL_KEY_RE.test(kv[1] as string)) found.add(kv[1] as string);
  }
  return [...found].sort();
}

function composeCredentialKeys(): string[] {
  return credentialKeysInComposeText(readFileSync(join(config.repoRoot, 'compose.yml'), 'utf8'));
}

/**
 * config.ts 里是不是**真的**把这个键从 process.env 摘掉了。
 * 认三种写法：`delete process.env.ARENA_X`、`delete process.env['ARENA_X']`、
 * 以及本文件实际用的常量间接形态（`const X_KEY = 'ARENA_X'` + `delete process.env[X_KEY]`）。
 * 收正文而不是内部读文件：反例要能喂样本进去 —— 判据本身没人判过，就等于它是装饰
 * （本仓库的规矩，见 `verify-coverage.test.ts` 那一组守门闸门的闸门）。
 */
function consumedInConfigSrc(src: string, key: string): boolean {
  const q = "[\"'`]";
  if (new RegExp(`delete\\s+process\\.env\\.${key}\\b`).test(src)) return true;
  if (new RegExp(`delete\\s+process\\.env\\[\\s*${q}${key}${q}\\s*\\]`).test(src)) return true;
  for (const m of src.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*${q}${key}${q}`, 'g'))) {
    const name = m[1] as string;
    if (new RegExp(`delete\\s+process\\.env\\[\\s*${name}\\s*\\]`).test(src)) return true;
  }
  return false;
}

/** 生产那份 config.ts 的正文（每次调用都重读：测试跑的是磁盘上的实现，不是 import 时的快照）。 */
function consumedInConfig(key: string): boolean {
  return consumedInConfigSrc(readFileSync(join(config.repoRoot, 'server', 'src', 'config.ts'), 'utf8'), key);
}

describe('红线一：IDE 依赖环境不许污染判题', () => {
  it('B 服务进程自己的 env 里没有任何 ide-env 路径（两处 ...process.env 的根）', () => {
    expect(
      envLooksClean(process.env),
      'IDE 的环境被写进了服务进程全局 —— 判题子进程会经由 `{...process.env}` 继承它',
    ).toEqual([]);
  });

  /**
   * B1 = 同一个 B，但判**键名**（终审 I-2）。上面那条按值找 `ide-env`，对一串随机 token 天生瞎。
   * 容器档里这条是真判据：compose 确实把 `ARENA_JUPYTER_TOKEN` 给了这个进程（`docker compose exec`
   * 起的新进程按服务 env 注入），而它此刻不在 process.env 里 ⇒ 唯一可能是 config 把它摘了。
   * 宿主档里它是**空转但不错**的（宿主从没设过 ARENA_* 凭据，服务端也从不加载 .env）——
   * 所以"摘这个动作有效"由 B3 判，"下一个凭据逃进来"由 D 组判，三条各覆盖一档。
   */
  it('B1 服务进程自己的 env 里没有"没被消费掉的凭据键"（I-2：按键名判，不按值）', () => {
    expect(
      credentialKeys(process.env),
      '这些键名像凭据、又没被 config 摘掉 ⇒ 每一道提交的代码都能从继承来的 env 里读到它们',
    ).toEqual([]);
  });

  /**
   * B3 = `consumeJupyterToken()` 这个动作本身（与 B2 对 `ARENA_IDE_ENV_DIR` 的判法同形）。
   * 三件事缺一不可，而且各有各的坏法：
   * ① 读得到值（摘之前读）——坏法是"token 永远为空"，症状是第五页一片"Jupyter 没在跑"；
   * ② 摘得干净——坏法是凭据被判题子进程继承（红线一当场作废）；
   * ③ **键在不在要在摘之前记下来**——坏法是 `missingTokenReason()` 永远漂成"按设计不给"，
   *    于是"接上了但从没生成"那个真故障不再给修复指令（评审 T34 那句双重误导的复活）。
   * 探针值用的是**假** token：这条断言的消息里可能出现它，所以它不许长得像真凭据，也不打印。
   */
  it('B3 config 把 ARENA_JUPYTER_TOKEN 读完就摘、且摘之前记下"键在不在"（B1 靠的是这个动作）', () => {
    const key = 'ARENA_JUPYTER_TOKEN';
    const original = process.env[key];
    const probe = 'probe-not-a-real-token';
    try {
      process.env[key] = probe;
      const got = consumeJupyterToken();
      expect(got.token, '没读到刚设的值 ⇒ 摘的动作跑在读之前，容器里 token 会被静默换成空串').toBe(probe);
      expect(got.tokenKeyPresent, '键明明设过却记成不存在 ⇒ missingTokenReason() 会说"按设计不给"，让人不去修坏了的东西').toBe(true);
      expect(process.env[key], '读完没摘掉 ⇒ 每一个判题子进程都会继承这个凭据，红线一当场作废').toBeUndefined();

      // 键不在的时候：值必须是空串、presence 必须是 false（dev / e2e 那一支的形状）
      const absent = consumeJupyterToken();
      expect(absent.token).toBe('');
      expect(absent.tokenKeyPresent, '键都没设过却记成存在 ⇒ 按设计不给的那些实例会被喊去"跑一次 ./start.sh"').toBe(false);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('B2 config 把 ARENA_IDE_ENV_DIR 读完就摘掉（B 靠的是这个动作，不是"这台机器没设过"）', () => {
    const key = 'ARENA_IDE_ENV_DIR';
    const original = process.env[key];
    try {
      process.env[key] = join(config.dataDir, 'ide-env-probe');
      expect(consumeIdeEnvDir(), '没读到刚设的值 ⇒ 容器里卷路径会被静默换成默认值（venv 创建要 87s）').toContain('ide-env-probe');
      expect(process.env[key], '读完没摘掉 ⇒ 每一个判题子进程都会继承它，红线一当场作废').toBeUndefined();
      // 摘掉之后必须回到默认值：IDE 与判题必须算出同一个根，否则面板列的包和 IDE 用的包不是一份
      expect(consumeIdeEnvDir()).toBe(join(config.dataDir, 'ide-env'));
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('A 真的起一个判题子进程，它看到的 env 里没有 ide-env', async () => {
    // 走真实路径而不是复述常量：runProcess 就是判题所有 runner 的那个出口。
    // 用 node 是因为它在宿主与容器里都在，这条断言要能在快档跑。
    const res = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { cwd: config.repoRoot, timeoutMs: 20_000, env: { ARENA_JUDGE_PROBE: '1' } },
    );
    expect(res.timedOut, '探测进程超时').toBe(false);
    const seen = JSON.parse(res.stdout || '{}') as Record<string, string | undefined>;
    expect(
      envLooksClean(seen),
      `判题子进程从 process.env 继承了带 ide-env 的变量：${envLooksClean(seen).join(', ')}`,
    ).toEqual([]);
    // 同一个子进程 env，换**另一套标记**（终审 I-2）：键名像凭据的那些。
    // 消息里只列键名不列值 —— 值可能就是真凭据，而失败消息会进日志、进终端、进截图。
    expect(
      credentialKeys(seen),
      '判题子进程继承了"没被消费的凭据形状"的环境变量 ⇒ 提交的代码读得到它（只列键名，不列值）',
    ).toEqual([]);
  });

  const walkTs = (absDir: string, out: string[]): string[] => {
    for (const name of readdirSync(absDir)) {
      const p = join(absDir, name);
      if (statSync(p).isDirectory()) walkTs(p, out);
      else if (/\.ts$/.test(name)) out.push(p);
    }
    return out;
  };
  const srcFiles = (dir: string): string[] => walkTs(join(config.repoRoot, dir), []);

  it('C1 判题与执行层的源码里不许出现 ide-env（要注入也只许注入 IDE 那三条路径）', () => {
    const offenders: string[] = [];
    for (const dir of ['server/src/judge', 'server/src/exec']) {
      for (const f of srcFiles(dir)) {
        if (readFileSync(f, 'utf8').includes(IDE_ENV_MARKER)) offenders.push(relative(config.repoRoot, f));
      }
    }
    expect(offenders, `判题/执行层引用了 IDE 环境目录：${offenders.join(', ')}`).toEqual([]);
  });

  it('C2 IDE 侧不许写 process.env（那是经由继承漏进判题的唯一通路）', () => {
    const offenders: string[] = [];
    for (const f of srcFiles('server/src/ide')) {
      const text = readFileSync(f, 'utf8');
      // 只抓赋值形态；读取（process.env.X）是合法的，比如 ARENA_PYTHON
      for (const line of text.split(/\r?\n/)) {
        if (/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test(line) || /process\.env\[[^\]]+\]\s*=[^=]/.test(line)) {
          offenders.push(`${relative(config.repoRoot, f)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, `IDE 代码在往全局 process.env 写值：\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * D 组（终审 I-2）：**"下一个凭据"要顺着 `{ ...process.env }` 走进判题层的话，必须先过这一条。**
 *
 * 为什么这一层必须存在：B/B2/A/C 全是围绕 `ARENA_IDE_ENV_DIR` 这一个键写的（判的是值里含不含
 * `ide-env`）。照着同样的路子加第二个凭据（`ARENA_JUPYTER_TOKEN`）时，那些闸门一个都看不见它 ——
 * 于是"红线一"的实际覆盖面只有"当时撞上的那一个变量"。D 组把判据从**值**换成**键名形状**，
 * 并且判的是 compose（配置侧）而不是运行中的进程 —— 所以它在**宿主档每次提交**都有效，
 * 不必等一次容器交付档。
 */
describe('D 凭据形状的 compose env 键：要么被 config 消费，要么显式列管写原因', () => {
  it('D1 compose 里每个凭据形状的键都在 config.ts 被摘掉，或在带原因的白名单里', () => {
    const keys = composeCredentialKeys();
    // 判住"扫到了空表"这种假绿：compose 读不到、或者解析对不上缩进，都会让这条看起来通过
    expect(keys.length, 'compose.yml 里一个凭据形状的键都没扫到 ⇒ 要么解析坏了，要么文件不在（本条会空转）').toBeGreaterThan(0);
    const undecided = keys.filter((k) => !consumedInConfig(k) && !(k in CREDENTIAL_NOT_CONSUMED));
    expect(
      undecided,
      `这些键名像凭据、compose 给了、而 config 既没摘也没在白名单里列管：${undecided.join(', ')} ⇒ ` +
        '判题子进程会经由 `{...process.env}` 继承到它们（红线一）。二选一：照 consumeJupyterToken() 的形状读完就摘，' +
        '或在 CREDENTIAL_NOT_CONSUMED 里写清为什么不摘',
    ).toEqual([]);
  });

  /** 白名单不是免责声明：条目坏了（compose 里已经没有这个键）要能被发现，否则它会慢慢变成万能通行证。 */
  it('D2 白名单里的每一条都还对应 compose 里真存在的那个键（没有死条目）', () => {
    const live = new Set(composeCredentialKeys());
    const dead = Object.keys(CREDENTIAL_NOT_CONSUMED).filter((k) => !live.has(k));
    expect(dead, `白名单里这些键在 compose 里已经找不到了，请删掉条目（留着会让下一个同名凭据免检）：${dead.join(', ')}`).toEqual([]);
    // 每条都必须写了原因（空字符串 = 把"决定"降级成"消音"）
    for (const [k, why] of Object.entries(CREDENTIAL_NOT_CONSUMED)) {
      expect(why.trim(), `白名单条目 ${k} 没写原因 ⇒ 列管变成了免责声明`).not.toBe('');
    }
  });
});

/**
 * 反向对照：上面那几条如果"天生就绿"，它们可能只是在什么也没看。
 * 这里主动制造污染，确认闸门真的会拦 —— 这是本仓库"破坏性验证"要求的一部分。
 */
describe('红线的守卫自身也要被验（反向对照）', () => {
  it('把 ide-env 写进 process.env 之后，B 那条判据必须判为脏', () => {
    const key = 'ARENA_PROBE_CONTAMINATE';
    process.env[key] = join(config.dataDir, 'ide-env', 'python', 'site-packages');
    try {
      expect(envLooksClean(process.env)).toContain(key);
    } finally {
      delete process.env[key];
    }
    // 撤掉之后必须重新变干净，否则 B 的断言是在赌执行顺序
    expect(envLooksClean(process.env)).toEqual([]);
  });

  it('C2 的正则真的抓得住赋值写法（给它一个样本必须命中）', () => {
    const sample = '  process.env.PYTHONPATH = "/app/data/ide-env/python";';
    expect(/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test(sample)).toBe(true);
    // 而合法的读取不许误报，否则这条闸门会变成没人敢碰的噪音源
    expect(/process\.env\.[A-Za-z0-9_]+\s*=[^=]/.test('  const py = process.env.ARENA_PYTHON ?? "python3";')).toBe(false);
  });

  /** D 组的判据自己也要被判（同上一组的纪律）：三个原语各给一个"必须命中 + 必须不命中"的样本。 */
  it('D 的键名判据抓得住凭据形状、且不冤枉普通配置键', () => {
    const dirty = credentialKeys({
      ARENA_SOMETHING_TOKEN: 'x',
      ARENA_DB_PASSWORD: 'x',
      ARENA_SIGNING_KEY: 'x',
      ARENA_JUPYTER_TOKEN: 'x',
    });
    expect(dirty, '这些形状都不算凭据的话，"下一个凭据"就永远抓不到').toEqual(expect.arrayContaining([
      'ARENA_SOMETHING_TOKEN',
      'ARENA_DB_PASSWORD',
      'ARENA_SIGNING_KEY',
      'ARENA_JUPYTER_TOKEN',
    ]));
    // 反向：普通配置键不许被卷进来（噪音源会让整条闸门被人删掉）
    expect(credentialKeys({ ARENA_DATA_DIR: 'x', ARENA_NOTEBOOK_PUBLIC_URL: 'x', PATH: 'x', npm_config_token: 'x' })).toEqual([]);
    // 白名单里的键不许被 B1/A 当成泄漏（否则容器档会红在一条与判题无关的既有事实上）
    expect(credentialKeys({ ...Object.fromEntries(Object.keys(CREDENTIAL_NOT_CONSUMED).map((k) => [k, 'x'])) })).toEqual([]);
  });

  it('D 的"有没有真摘掉"判据认得常量间接写法，也不会被"文件里提过这个键"糊弄', () => {
    const KEY = 'ARENA_PROBE_TOKEN';
    const indirect = `const X_KEY = '${KEY}';\nexport function consumeProbe() { const v = process.env[X_KEY]; delete process.env[X_KEY]; return v; }`;
    const directDot = `delete process.env.${KEY};`;
    const directBracket = `delete process.env['${KEY}'];`;
    const mentionOnly = `// 将来要摘 ${KEY}\nexport const t = process.env.${KEY} ?? '';`;
    expect(consumedInConfigSrc(indirect, KEY), '常量间接形态认不出 ⇒ 本仓库的实际写法会被判成"没摘"，D1 变成噪音').toBe(true);
    expect(consumedInConfigSrc(directDot, KEY), '直接点号写法认不出 ⇒ 有人照最顺手的写法摘，闸门却说没摘').toBe(true);
    expect(consumedInConfigSrc(directBracket, KEY), '直接方括号写法认不出 ⇒ 同上').toBe(true);
    expect(consumedInConfigSrc(mentionOnly, KEY), '只是文件里提过这个键也算"摘过" ⇒ D1 是装饰').toBe(false);
    // 反向对照的第二半：这条原语对**生产文件**给出的三个答案都得是当下那句真话
    expect(consumedInConfig('ARENA_JUPYTER_TOKEN'), 'config.ts 里读不出"摘掉 ARENA_JUPYTER_TOKEN"这个动作 ⇒ B1 的前提没了').toBe(true);
    expect(consumedInConfig('ARENA_IDE_ENV_DIR'), 'B2 那半边同理').toBe(true);
    expect(consumedInConfig('ARENA_LLM_BRIDGE_TOKEN'), '白名单里那条**本该**是"没摘"：它若被判成"已摘"，白名单就白写了').toBe(false);
  });

  /** B1 的反向对照：往服务进程里塞一个新凭据形状的键，判据必须当场判脏（否则 B1 只是在赌环境干净）。 */
  it('把凭据写进 process.env 之后，B1 那条键名判据必须判为脏', () => {
    const key = 'ARENA_PROBE_NEXT_TOKEN';
    process.env[key] = 'probe-value-not-a-real-credential';
    try {
      expect(credentialKeys(process.env), 'compose 之外新加一个凭据而 B1 没反应 ⇒ "下一个凭据"根本没被管').toContain(key);
    } finally {
      delete process.env[key];
    }
    expect(credentialKeys(process.env), '撤掉之后仍然脏 ⇒ B1 的通过是在赌执行顺序').toEqual([]);
  });

  it('D 的 compose 扫描只认配置行：把凭据名写进注释不许被算成"compose 给了这个键"', () => {
    const sample = [
      'services:',
      '  arena:',
      '    environment:',
      '      # ARENA_COMMENTED_TOKEN: 整行注释不算配置（⑤⑥ 的同一条纪律）',
      '      ARENA_REAL_TOKEN: ${ARENA_REAL_TOKEN:-}',
      '      ARENA_TRAILED_TOKEN: x  # 行尾随行注释不改变"这行给了这个键"',
      '      ARENA_DATA_DIR: /app/data',
    ].join('\n');
    expect(credentialKeysInComposeText(sample), '注释里的键名被算进来了 ⇒ 有人在注释里提一句就能改变判据').toEqual([
      'ARENA_REAL_TOKEN',
      'ARENA_TRAILED_TOKEN',
    ]);
    // 真文件必须扫得出 arena 那一行透传（扫不出来 = 解析坏了 = D1 在空转）
    const keys = composeCredentialKeys();
    expect(keys, `compose 里凭据形状的键应当包含 arena 那一行透传：${keys.join(', ')}`).toContain('ARENA_JUPYTER_TOKEN');
  });

  it('C1 的扫描真的读到了东西（扫空目录等于这条闸门在空转）', () => {
    const judgeDir = join(config.repoRoot, 'server', 'src', 'judge');
    const walked: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n)) walked.push(p);
      }
    };
    walk(judgeDir);
    expect(walked.length, `没在 ${relative(config.repoRoot, judgeDir)} 扫到任何 .ts，说明 C1 在空转`).toBeGreaterThan(5);
    // 顺带确认 execFileSync 可用（下面的 git 断言依赖它，坏环境要在这里早暴露）
    expect(() => execFileSync('git', ['--version'], { encoding: 'utf8' })).not.toThrow();
  });
});
