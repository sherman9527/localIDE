import { describe, expect, it } from 'vitest';
import { countJudgeWorkspaces } from '../../src/judge/workspace.js';
import { parseTsv, runSql } from '../../src/exec/mysql.js';
import { IDE_DB_INDEX, JUDGE_DBS } from '../../src/exec/redis.js';
import { IDE_LANGUAGES, IDE_LIMITS, ideAvailability, runIdeCode, takeIdePeakConcurrency } from '../../src/ide/runner.js';
import { foldSparkInfoLogs, SPARK_SCALA_COMPILE_CAP_MS } from '../../src/ide/executors.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * 网页 IDE 的执行契约（WI-64）。
 *
 * 与判题矩阵同样的纪律：宿主机没有 JDK/gcc/Spark/mysqld，缺工具链的用例会 skip，
 * 所以"全绿"必须在容器里看（./start.sh --verify）。
 */

const available = await ideAvailability();
const have = (id: string) => available[id] === true;
const guarded = (id: string) => (have(id) ? it : it.skip);

const OK = { status: 'ok' as const, exitCode: 0, timedOut: false };

describe('ideAvailability / IDE_LANGUAGES', () => {
  it('注册了十种语言且 id 唯一', () => {
    const ids = IDE_LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([
      'c', 'cpp', 'java', 'javascript', 'mysql', 'pyspark', 'python', 'redis', 'spark-scala', 'typescript',
    ]);
  });

  it('每种语言的 sample 与执行形态自洽（可用性判据必须对得上执行形态）', () => {
    for (const lang of IDE_LANGUAGES) {
      expect(lang.sample.length, lang.id).toBeGreaterThan(10);
      expect(lang.fileName.includes('.'), lang.id).toBe(true);
      if (lang.execution === 'command') {
        expect(lang.run?.command, lang.id).toBeTruthy();
        expect(lang.probe?.command, `${lang.id} 是命令型却没有探测命令 —— 可用性会变成假的`).toBeTruthy();
        expect(lang.setupLabel, `${lang.id} 是命令型，不该有预置框`).toBeUndefined();
        continue;
      }
      // 非命令型一律不起"用户语言的进程"：探的必须是后端/栈本身（executors 里实现）
      expect(lang.run, `${lang.id} 不是命令型，不该有 run`).toBeUndefined();
      expect(lang.probe, `${lang.id} 不是命令型，不该用命令探可用性（那探到的是客户端，不是后端）`).toBeUndefined();
      expect(lang.probeKind, `${lang.id} 必须声明 probeKind`).toBeTruthy();
    }
    // 预置框只在"后端真能先执行前置语句"的语言上出现：spark-scala 每次都是新 JVM，
    // 前置 SQL 没有落点，给个框再悄悄丢掉等于骗人。
    expect(findLanguage('spark-scala')?.setupLabel, 'spark-scala 没有执行预置语句的地方').toBeUndefined();
    for (const id of ['mysql', 'redis', 'pyspark'] as const) {
      expect(findLanguage(id)?.setupLabel, `${id} 必须有预置语句框`).toBeTruthy();
    }
  });

  it('java 与 python 在容器镜像里必须可用（缺了就是镜像坏了）', () => {
    // 这两条不 skip：宿主上会红，那正是"这条闸门必须在容器里跑"的提醒。
    // 判据来自 compose 镜像里真装了 openjdk 与 python3，不是"希望它装了"。
    if (process.platform !== 'linux') return;
    expect(available.java, '容器里 javac 不可用').toBe(true);
    expect(available.python, '容器里 python3 不可用').toBe(true);
  });
});

describe('runIdeCode：正常执行', () => {
  guarded('python')('print 与 stdin 都到位，exit 0', async () => {
    const result = await runIdeCode({
      language: 'python',
      code: 'import sys\nname = sys.stdin.readline().strip()\nprint("hi", name or "world")\n',
      stdin: 'cole\n',
    });
    expect(result).toMatchObject({ ...OK, status: 'ok' });
    expect(result.stdout.trim()).toBe('hi cole');
    expect(result.stderr).toBe('');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  guarded('python')('非零退出码要如实报出来，不许折算成"成功但没输出"', async () => {
    const result = await runIdeCode({ language: 'python', code: 'import sys\nsys.exit(3)\n' });
    expect(result.exitCode).toBe(3);
    expect(result.status).toBe('runtime_error');
  });

  guarded('python')('stderr 与 stdout 分开返回（IDE 里混成一块就分不清报错来自哪）', async () => {
    const result = await runIdeCode({
      language: 'python',
      code: 'import sys\nprint("out")\nsys.stderr.write("err\\n")\n',
    });
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  guarded('javascript')('node 跑 commonjs 风格的脚本', async () => {
    const result = await runIdeCode({
      language: 'javascript',
      code: 'const a = [3, 1, 2];\nconsole.log(a.sort((x, y) => x - y).join(","));\n',
    });
    expect(result.status).toBe('ok');
    expect(result.stdout.trim()).toBe('1,2,3');
  });

  guarded('typescript')('TS 会被编译后再跑：类型错误不该让整条链路变成"没有输出"', async () => {
    const result = await runIdeCode({
      language: 'typescript',
      code: 'const greet = (who: string): string => `hello ${who}`;\nconsole.log(greet("ts"));\n',
    });
    expect(result.status).toBe('ok');
    expect(result.stdout.trim()).toBe('hello ts');
  });

  guarded('typescript')('类型检查仍在：把 --types 收窄不等于关掉检查', async () => {
    const result = await runIdeCode({
      language: 'typescript',
      code: 'const n: number = "不是数字";\nconsole.log(n);\n',
    });
    expect(result).toMatchObject({ status: 'compile_error', stage: 'compile' });
    // tsc 把诊断写到 stdout，别只盯 stderr 然后得出"报错丢了"
    expect(`${result.stdout}\n${result.stderr}`).toContain('TS2322');
  });

  guarded('typescript')('Node 全局可用（console/process）—— 这条把 --types node 钉住', async () => {
    const result = await runIdeCode({ language: 'typescript', code: 'console.log(typeof process.exit);\n' });
    expect(result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(result.stdout.trim()).toBe('function');
  });

  guarded('javascript')('require 可用（沙箱落在 type:module 的仓库里，必须显式按 CJS 解释）', async () => {
    const result = await runIdeCode({
      language: 'javascript',
      code: 'const fs = require("fs");\nconsole.log(typeof fs.readFileSync);\n',
      stdin: 'cole\n',
    });
    expect(result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(result.stdout.trim()).toBe('function');
  });

  guarded('javascript')('空 stdin 不许把 readFileSync(0) 弄崩（示例代码就是这么读的）', async () => {
    const result = await runIdeCode({
      language: 'javascript',
      code: 'const s = require("fs").readFileSync(0, "utf8").trim();\nconsole.log("[" + s + "]");\n',
    });
    expect(result).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(result.stdout.trim()).toBe('[]');
  });

  guarded('java')('编译 + 运行两段都要有阶段标记，报错要指到 compile 而不是"没输出"', async () => {
    const good = await runIdeCode({
      language: 'java',
      code: 'public class Main { public static void main(String[] a) { System.out.println("java ok"); } }\n',
    });
    expect(good.status).toBe('ok');
    expect(good.stdout.trim()).toBe('java ok');
    expect(good.stage).toBe('run');

    const bad = await runIdeCode({ language: 'java', code: 'public class Main { void main( }' });
    expect(bad.status).toBe('compile_error');
    expect(bad.stage).toBe('compile');
    expect(bad.stderr.length).toBeGreaterThan(0);
  });

  guarded('c')('gcc 编译并运行，stdin 可读', async () => {
    const result = await runIdeCode({
      language: 'c',
      code: '#include <stdio.h>\nint main(void){int n;scanf("%d",&n);printf("c %d\\n",n*2);return 0;}\n',
      stdin: '21\n',
    });
    expect(result.status).toBe('ok');
    expect(result.stdout.trim()).toBe('c 42');
  });

  guarded('cpp')('g++ 编译并运行', async () => {
    const result = await runIdeCode({
      language: 'cpp',
      code: '#include <iostream>\nint main(){std::cout << "cpp " << 1 + 1 << std::endl;}\n',
    });
    expect(result.status).toBe('ok');
    expect(result.stdout.trim()).toBe('cpp 2');
  });
});

describe('注册表里的 sample 必须原样跑得通', () => {
  // 用户点开的第一个程序就是这份 sample。之前 sample 用了 require 而测试用了
  // 一段不带 require 的代码 —— 闸门绿、界面坏，正是"测试没测产品实际给的东西"。
  for (const lang of IDE_LANGUAGES) {
    guarded(lang.id)(`${lang.id}：示例代码 + stdin 跑通`, async () => {
      const result = await runIdeCode({ language: lang.id, code: lang.sample, stdin: 'cole\n' });
      expect(
        result,
        `${lang.id} status=${result.status} stage=${result.stage} exit=${result.exitCode}\n` +
          `[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`,
      ).toMatchObject({ status: 'ok', exitCode: 0, timedOut: false });
      expect(result.stdout.trim().length, lang.id).toBeGreaterThan(0);
    });
  }
});

describe('并发排队与沙箱回收（只测过单发运行等于没测这条队列）', () => {
  const busy = (ms: number) => `const t = Date.now();\nwhile (Date.now() - t < ${ms}) {}\nconsole.log("done");\n`;

  guarded('javascript')(`同时发 ${IDE_LIMITS.maxConcurrentRuns + 3} 个：都要成功，且真的排过队`, async () => {
    // 只数自己这一类：判题/调试的沙箱同住一个目录，而测试文件并行跑，
    // 数"一共几个"等于让别的用例随时能把这条断言弄红
    const before = await countJudgeWorkspaces('ide-');
    takeIdePeakConcurrency();          // 清零，测的是这一批的并发
    const results = await Promise.all(
      Array.from({ length: IDE_LIMITS.maxConcurrentRuns + 3 }, () =>
        runIdeCode({ language: 'javascript', code: busy(600) }),
      ),
    );
    const peak = takeIdePeakConcurrency();

    // 排队而不是拒绝：任何一条变成 rejected/超时，就说明并发闸把用户挡在了外面
    expect(results.map((r) => [r.status, r.exitCode])).toEqual(
      results.map(() => ['ok', 0]),
    );
    // 两条**互相独立**的断言：把判据写成 `peak <= IDE_LIMITS.maxConcurrentRuns` 是自指的 ——
    // 上限被抬到 99 时两边一起变，永远验不红（前两版就是这么假绿的）。
    expect(IDE_LIMITS.maxConcurrentRuns, '并发上限是设计值，要改就连这条一起改').toBe(3);
    // demand 是 6 个 > 3 个名额 ⇒ "同时只有 3 个在跑"这个数只能由队列产生
    expect(peak, `实测同时跑了 ${peak} 个`).toBe(3);
    // 跑完不能留沙箱目录（异常路径同样要收，否则 data/judge 会无限长）
    expect(await countJudgeWorkspaces('ide-')).toBeLessThanOrEqual(before);
  });

  guarded('javascript')('一条跑飞（超时被杀）之后，队列必须还能继续服务', async () => {
    const stuck = await runIdeCode({ language: 'javascript', code: busy(600_000), timeoutMsOverride: 1500 });
    expect(stuck.status).toBe('timeout');
    // 名额没还得被下一个拿到；拿不到就是永久卡死，后面每个请求都会挂到超时
    const next = await runIdeCode({ language: 'javascript', code: 'console.log("alive");\n' });
    expect(next).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(next.stdout.trim()).toBe('alive');
  });
});

describe('runIdeCode：限额与失败路径', () => {
  guarded('python')('超时会被杀掉并标记 timedOut，而不是把请求挂住', async () => {
    const result = await runIdeCode({
      language: 'python',
      code: 'import time\nwhile True:\n    time.sleep(0.05)\n',
      timeoutMsOverride: 1500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('timeout');
  });

  guarded('python')('无限 print 的输出被截断，且 truncated 明确为 true', async () => {
    const result = await runIdeCode({
      language: 'python',
      code: 'while True:\n    print("x" * 200)\n',
      timeoutMsOverride: 2000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(result.stdoutCapChars);
  });

  it('代码超长直接拒，不起进程', async () => {
    const before = Date.now();
    const result = await runIdeCode({ language: 'python', code: '#'.padStart(10, 'a') + 'x'.repeat(200_000) });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('代码过长');
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('stdin 超长直接拒', async () => {
    const result = await runIdeCode({ language: 'python', code: 'print(1)', stdin: 'a'.repeat(200_000) });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('输入过长');
  });

  it('未注册的语言被拒而不是抛未捕获异常', async () => {
    const result = await runIdeCode({ language: 'brainfuck', code: '++,+' } as never);
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('不支持的语言');
  });

  it('空代码不当成"运行成功且无输出"', async () => {
    const result = await runIdeCode({ language: 'python', code: '   \n' });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('没有代码');
  });
});

/**
 * SQL / Redis 两种执行形态（IDE 扩语言那批的第一步）。
 * 这三条的重点不是"能跑"，而是**共用底座没被绕过**：同一份白名单、跑完不留痕迹。
 */
describe('IDE 的 SQL 执行形态', () => {
  guarded('mysql')('预置语句建表灌数 → 最后一个结果集变表格，且跑完不留临时库', async () => {
    const res = await runIdeCode({
      language: 'mysql',
      setup: "CREATE TABLE t (id INT, status VARCHAR(8) NOT NULL);\n" + "INSERT INTO t VALUES (1,'paid'),(2,'paid'),(3,'refunded');",
      code: 'SELECT status, COUNT(*) AS n FROM t GROUP BY status ORDER BY status;',
    });
    expect(res.status, res.stderr || res.message || '').toBe('ok');
    expect(res.table?.columns).toEqual(['status', 'n']);
    expect(res.table?.rows).toEqual([['paid', '2'], ['refunded', '1']]);
    expect(res.table?.truncated).toBe(false);

    const left = await runSql("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'arena\\_%';");
    expect(parseTsv(left.stdout).rows, 'IDE 跑完留下了临时库').toEqual([]);
  });

  guarded('mysql')('INTO OUTFILE 与 /*! 版本注释被拒，而且 mysqld 还活着', async () => {
    const outfile = await runIdeCode({ language: 'mysql', code: "SELECT 'x' INTO OUTFILE '/tmp/arena-ide-pwned';" });
    expect(outfile.status).toBe('rejected');
    expect(outfile.message).toMatch(/OUTFILE/);

    const versioned = await runIdeCode({ language: 'mysql', code: '/*!50000 SHUTDOWN */;' });
    expect(versioned.status).toBe('rejected');
    expect(versioned.message).toMatch(/版本注释/);

    const alive = await runIdeCode({ language: 'mysql', code: 'SELECT 1 AS ok;' });
    expect(alive.status, '被拒的语句把 mysqld 关掉了').toBe('ok');
  });

  guarded('mysql')('结果集超过展示上限时只回前 N 行，并如实标 truncated', async () => {
    const res = await runIdeCode({
      language: 'mysql',
      code: 'WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 250) SELECT i FROM s;',
    });
    expect(res.status, res.stderr || res.message || '').toBe('ok');
    expect(res.table?.rows).toHaveLength(IDE_LIMITS.tableRowLimit);
    expect(res.table?.truncated).toBe(true);
  });
});

describe('IDE 的 Redis 执行形态', () => {
  guarded('redis')('预置命令造键空间，正文逐条回回复；跑完库是空的（下一次看不见上一次的键）', async () => {
    const res = await runIdeCode({
      language: 'redis',
      setup: `ZADD lb 10 a
ZADD lb 20 b
SET k v`,
      code: `ZREVRANGE lb 0 -1 WITHSCORES
GET k`,
    });
    expect(res.status, res.message || '').toBe('ok');
    expect(res.replies?.map((r) => r.command)).toEqual(['ZREVRANGE lb 0 -1 WITHSCORES', 'GET k']);
    expect(res.replies?.map((r) => r.reply)).toEqual(['["b","20","a","10"]', '"v"']);

    const again = await runIdeCode({ language: 'redis', code: 'GET k' });
    expect(again.replies?.[0]?.reply, '上一次运行的键留下来了').toBe('(nil)');
  });

  guarded('redis')('FLUSHALL / KEYS 与判题用同一份白名单', async () => {
    const flush = await runIdeCode({ language: 'redis', code: 'FLUSHALL' });
    expect(flush.status).toBe('rejected');
    expect(flush.message).toMatch(/FLUSHALL/);
    const keys = await runIdeCode({ language: 'redis', code: 'KEYS *' });
    expect(keys.status).toBe('rejected');
    expect(keys.message).toMatch(/KEYS/);
  });

  it('IDE 用的 db index 不在判题轮转池里（否则会互相 flushdb 掉对方的数据）', () => {
    expect(JUDGE_DBS).not.toContain(IDE_DB_INDEX);
    expect(IDE_DB_INDEX).toBeGreaterThan(0);
  });
});

/**
 * Spark 两种执行形态（IDE 扩能 ①）。
 *
 * 这一批的重点不是"能跑"（示例代码那条已经覆盖），而是三件容易悄悄坏掉的事：
 * 预置 SQL 真的先执行了、用户的 print 回在 stdout 而不是被判题那侧改道到 stderr、
 * 以及**该拒的快拒**（不合规的 Scala 结构不许先烧 15s 再告诉你不行）。
 */
describe('IDE 的 Spark 执行形态', () => {
  guarded('pyspark')('预置 SQL 建的临时视图能被正文查到，print 回到 stdout', async () => {
    const res = await runIdeCode({
      language: 'pyspark',
      setup: "CREATE OR REPLACE TEMP VIEW vw_seed AS SELECT 1 AS id UNION ALL SELECT 2 AS id",
      code: `print("setup 建的视图能查到")
df = spark.sql("SELECT COUNT(*) AS n FROM vw_seed")
result = df
`,
    });
    expect(res.status, res.stderr || res.message || '').toBe('ok');
    expect(res.stdout).toContain('setup 建的视图能查到');
    // 判题模式把 print 改道到 stderr 保住行分隔 JSON；IDE 要的就是它，所以走进程内收集
    expect(res.stderr).toBe('');
    expect(res.table?.columns).toEqual(['n']);
    expect(res.table?.rows).toEqual([['2']]);
  });

  guarded('pyspark')('这次运行建的临时视图不会留给下一次（常驻会话不攒脏状态，也不污染判题）', async () => {
    const first = await runIdeCode({
      language: 'pyspark',
      setup: 'CREATE OR REPLACE TEMP VIEW vw_leftover AS SELECT 1 AS id',
      code: 'print(f"rows={spark.table(\'vw_leftover\').count()}")\n',
    });
    expect(first.status, first.stderr || first.message || '').toBe('ok');
    expect(first.stdout).toContain('rows=1');

    // 每次运行都在自己的 newSession() 里（见 spark_worker.run_ide_mode）：这张视图随那次会话消失，
    // 于是 A 次运行建的 vw_* 既影响不到 B 次运行，也影响不到同一池子里跑的判题。
    // 探针必须带 count() 这种**动作** —— spark.table() 本身惰性，不触发解析就不会报错，
    // 拿它当"视图还在不在"的探针会得到一个假的通过（第一版就是这么假绿的）。
    const second = await runIdeCode({ language: 'pyspark', code: 'spark.table("vw_leftover").count()\n' });
    expect(second.status, '视图该被清掉，脏状态不该留给下一次运行').toBe('runtime_error');
    expect(second.stderr).toMatch(/TABLE_OR_VIEW_NOT_FOUND|vw_leftover/);
  });

  guarded('pyspark')('用户代码报错：报错进 stderr、stdout 保留已打印的部分，且下一次运行不受影响', async () => {
    const bad = await runIdeCode({
      language: 'pyspark',
      code: `print("before boom")
raise ValueError("boom")
`,
    });
    expect(bad.status).toBe('runtime_error');
    expect(bad.message).toContain('boom');
    expect(bad.stdout).toContain('before boom');
    expect(bad.stderr).toContain('ValueError');

    const next = await runIdeCode({ language: 'pyspark', code: 'print("alive")\n' });
    expect(next.status, next.stderr || next.message || '').toBe('ok');
    expect(next.stdout.trim()).toBe('alive');
  });

  guarded('pyspark')('语法错误标成 compile 阶段，而不是笼统的运行失败', async () => {
    const res = await runIdeCode({ language: 'pyspark', code: 'def broken(:\n    pass\n' });
    expect(res.status).toBe('compile_error');
    expect(res.stage).toBe('compile');
  });

  guarded('spark-scala')('结构不对就当场拒，不去烧那 15s 的编译', async () => {
    const before = Date.now();
    const res = await runIdeCode({ language: 'spark-scala', code: 'object Other { def go(): Unit = () }\n' });
    expect(res.status).toBe('rejected');
    expect(res.message).toContain('object Solution');
    expect(Date.now() - before, '被拒的提交不该等编译').toBeLessThan(3_000);
  });

  guarded('spark-scala')('编译不过：status=compile_error、stage=compile，报错指到 scalac 的输出', async () => {
    const res = await runIdeCode({
      language: 'spark-scala',
      code: 'object Solution { def main(args: Array[String]): Unit = { val x: Int = "不是数字" } }\n',
    });
    expect(res).toMatchObject({ status: 'compile_error', stage: 'compile' });
    expect(`${res.stderr}\n${res.stdout}`).toMatch(/type mismatch|Int/i);
  });

  it('Spark 两门语言的预算必须比命令型语言的 10s 大（实测一遍约 15s，用小预算等于全判成超时）', () => {
    for (const id of ['pyspark', 'spark-scala'] as const) {
      const budget = findLanguage(id)?.timeoutMs ?? 0;
      expect(budget, `${id} 没声明 timeoutMs`).toBeGreaterThan(IDE_LIMITS.timeoutMs);
      expect(budget, `${id} 超过硬上限`).toBeLessThanOrEqual(IDE_LIMITS.maxTimeoutMs);
    }
  });

  it('IDE 与判题探的是同一件事：Spark 语言的可用性不许退回"探一个客户端二进制"', () => {
    // 判据写在 exec/ 里（pysparkAvailable / scalaSparkAvailable），注册表只留一个 kind。
    // 这条断言防的是"有人图省事给 spark-* 塞回一条 probe 命令"——那会探出不存在的二进制。
    for (const id of ['pyspark', 'spark-scala'] as const) {
      const lang = findLanguage(id);
      expect(lang?.probe, `${id} 不许用命令探可用性`).toBeUndefined();
      expect(lang?.probeKind, id).toBe(id);
    }
  });

  it('spark-scala 的预算要容得下"编译 + 运行"两段 JVM（实测一遍 15.4s，编译失败 1.4s）', () => {
    const budget = findLanguage('spark-scala')?.timeoutMs ?? 0;
    expect(budget, '预算必须至少是"编译封顶 + 运行封顶"').toBeGreaterThanOrEqual(SPARK_SCALA_COMPILE_CAP_MS * 2);
    expect(budget, '预算不许超过 runner 会 clamp 的硬上限，否则界面显示的数是假的').toBeLessThanOrEqual(IDE_LIMITS.maxTimeoutMs);
  });

  it('Spark Scala 的 stderr 折叠掉 INFO 噪声，但 WARN / ERROR / 异常栈必须留下', () => {
    const noisy = [
      'Using Spark\'s default log4j profile: org/apache/spark/log4j2-defaults.properties',
      '26/09/24 18:11:37 INFO SparkContext: Running Spark version 3.5.5',
      '26/09/24 18:11:37 INFO SparkContext: Successfully started SparkContext',
      '26/09/24 18:11:40 WARN SQLConf: The SQL config "spark.sql.shuffle.partitions" is deprecated',
      'Exception in thread "main" org.apache.spark.sql.AnalysisException: [UNRESOLVED_VIEW] Table or view not found: nope',
      '\tat org.apache.spark.sql.catalyst.analysis.package$AnalysisErrorAt.failAnalysis(package.scala:42)',
    ].join('\n');
    const folded = foldSparkInfoLogs(noisy);
    expect(folded.text).toContain('WARN SQLConf');
    expect(folded.text).toContain('AnalysisException');
    expect(folded.text).toContain('\tat org.apache.spark');
    expect(folded.text).not.toContain('Running Spark version');
    expect(folded.text).not.toContain('default log4j profile');
    expect(folded.folded).toBe(3);
    expect(folded.text).toMatch(/已折叠 3 行/); // 折叠这件事要如实说出来，不能装作 stderr 本来就短

    expect(foldSparkInfoLogs('')).toEqual({ text: '', folded: 0 });
    const allInfo = foldSparkInfoLogs('26/09/24 18:11:37 INFO SparkContext: only noise');
    expect(allInfo.folded).toBe(1);
    expect(allInfo.text).toContain('无其他输出');
  });
});
