/**
 * 网页 IDE 的语言注册表（WI-64）。
 *
 * 只列**容器镜像里真有工具链**的语言 —— 这个应用是离线的单机系统，
 * "能选但一跑就 command not found" 比少一门语言糟糕得多。
 * 每条都靠 `ideAvailability()` 现探，不写死"我们装了 JDK"。
 */
import type { IdeDebugKind, IdeExecution, Language } from '@arena/shared';

export type IdeLanguageId =
  | 'java' | 'python' | 'javascript' | 'typescript' | 'c' | 'cpp'
  | 'mysql' | 'redis'
  | 'pyspark' | 'spark-scala';

export interface IdeCommand {
  command: string;
  args: readonly string[];
}

/** 非命令型语言的四种可用性判据（每种都在 executors 里对着真实的后端/栈探）。 */
export type IdeNonCommandProbe = 'mysql' | 'redis' | 'pyspark' | 'spark-scala';

export interface IdeLanguage {
  id: IdeLanguageId;
  label: string;
  /** 落盘用的文件名；Java 必须是 Main.java（public class 名要与文件名一致） */
  fileName: string;
  /** 编辑器高亮：直接用 shared 的 `Language`，前端不再自己按 id 猜（那等于第二份真相） */
  editorLanguage: Language;
  /** 这门语言"怎么被跑起来"。新增执行形态时改这里 + runner 的分发表。 */
  execution: IdeExecution;
  /** 有值 = 前端显示"预置语句"框 */
  setupLabel?: string;
  /**
   * 这门语言的运行预算。命令型 10s 够用，Spark 不够：**实测一次 PySpark 跑 0.3~6.7s、
   * Spark Scala 15.4s（含 scalac）**，而排队排在判题后面还要更久 —— 所以预算必须按语言给，
   * 全局那个只当兜底。
   */
  timeoutMs?: number;
  sample: string;
  /**
   * 沙箱里除用户代码外还要落盘的文件（见 `CJS_PACKAGE_JSON`）。
   * 判题与 IDE 的沙箱目录都在仓库内，所以语言运行时看得到仓库自己的配置 ——
   * 需要就近盖回去的不止 ESM 这一处，写在这里比藏在 runner 里清楚。
   */
  scaffold?: Readonly<Record<string, string>>;
  /** 没有 compile 的语言直接跑 */
  compile?: IdeCommand;
  /** execution='command' 的语言才有；其余形态由 ide/executors.ts 执行 */
  run?: IdeCommand;
  /** 探测可用性用的命令与参数（通常是 --version）。命令型语言必填。 */
  probe?: IdeCommand;
  /**
   * 非命令型语言的可用性判据（实现在 `ide/executors.ts`，底层与判题共用）。
   *
   * 这类语言探的都不是"客户端二进制在不在"：mysql/redis 探**连不连得上实例**，
   * spark-* 探**镜像里的 Spark 栈（worker 脚本 / jars / java）全不全**。
   * 客户端在但后端没起、jar 不在，运行起来照样失败，那种"可用"是假的。
   */
  probeKind?: IdeNonCommandProbe;
  /**
   * 这门语言在 IDE 里有常驻 REPL 会话（WI-77）。判据是"镜像里真有交互式运行时"：
   * TypeScript 没有 —— 离线镜像里没有 ts-node，标上就是一个"选了却起不来"的语言。
   */
  replKind?: true;
  /**
   * 行断点由哪种机制实现（WI-81）。与 `replKind` 分开：能逐句求值 ≠ 能停在某一行看变量。
   * 只给"机制当场实测过且适配器真写了"的语言 —— 给了就是界面上一个能点的行号槽。
   */
  debugKind?: IdeDebugKind;
  hint: string;
}

export const IDE_LIMITS = {
  maxCodeChars: 20_000,
  maxStdinChars: 20_000,
  maxSetupChars: 20_000,
  timeoutMs: 10_000,
  /** 任何语言的硬上限（Spark Scala 一遍实测 15.4s，还要留出排在判题后面的余量） */
  maxTimeoutMs: 120_000,
  stdoutCapChars: 64_000,
  /** 表格只给前 N 行：一次 SELECT 可能几十万行，全塞进响应只会让页面卡住。 */
  tableRowLimit: 200,
  /** 单机工具：超过这个数就排队，而不是拒绝 —— 拒绝会让人以为是自己跑挂了 */
  maxConcurrentRuns: 3,
} as const;

const SAMPLE_PYTHON = `import sys

name = sys.stdin.readline().strip() or "world"
print(f"hello, {name}!")

for i in range(1, 4):
    print(i, "x 2 =", i * 2)
`;

const SAMPLE_JAVASCRIPT = `const nums = [3, 1, 2];
console.log("sorted:", nums.sort((a, b) => a - b).join(","));

const stdin = require("fs").readFileSync(0, "utf8").trim();
if (stdin) console.log("你输入了:", stdin);
`;

const SAMPLE_TYPESCRIPT = `interface Point {
  x: number;
  y: number;
}

function manhattan(p: Point): number {
  return Math.abs(p.x) + Math.abs(p.y);
}

const points: Point[] = [{ x: 3, y: -4 }, { x: -1, y: 1 }];
console.log(points.map(manhattan).join(", "));
`;

const SAMPLE_JAVA = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String name = sc.hasNextLine() ? sc.nextLine().trim() : "world";
        System.out.println("hello, " + name + "!");

        int sum = 0;
        for (int i = 1; i <= 4; i++) {
            sum += i;
        }
        System.out.println("sum(1..4) = " + sum);
    }
}
`;

const SAMPLE_C = `#include <stdio.h>

int main(void) {
    int n = 0;
    if (scanf("%d", &n) != 1) n = 21;
    printf("c says: %d\\n", n * 2);
    return 0;
}
`;

const SAMPLE_CPP = `#include <iostream>
#include <vector>
#include <numeric>

int main() {
    std::vector<int> v{1, 2, 3, 4};
    int total = std::accumulate(v.begin(), v.end(), 0);
    std::cout << "cpp total = " << total << std::endl;
}
`;

const SAMPLE_PYSPARK = `# 常驻 SparkSession 里跑一段脚本：print 与最后一个 DataFrame 都会回给你。
data = [(1, "paid", 100.0), (2, "paid", 250.5), (3, "refunded", 99.99)]
df = spark.createDataFrame(data, ["id", "status", "amount"])
df.createOrReplaceTempView("orders")

summary = spark.sql("SELECT status, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM orders GROUP BY status")
print("按状态汇总：")
summary.show(truncate=False)
result = summary
`;

const SAMPLE_SPARK_SCALA = `// 必须是 object Solution + def main；scalac 每次真编译（实测一次约 15s）
import org.apache.spark.sql.SparkSession

object Solution {
  def main(args: Array[String]): Unit = {
    val spark = SparkSession.builder().master("local[2]").appName("arena-ide").getOrCreate()
    import spark.implicits._
    val rows = Seq((1, "paid", 100.0), (2, "paid", 250.5), (3, "refunded", 99.99)).toDF("id", "status", "amount")
    rows.createOrReplaceTempView("orders")
    spark.sql("SELECT status, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total FROM orders GROUP BY status").show(false)
    spark.stop()
  }
}
`;

const SAMPLE_MYSQL = `-- 每次运行都在一个**全新的一次性库**里执行：前置的建表/灌数要一起贴在这里。
-- 最后一个结果集会显示成表格。
CREATE TABLE order_items (
  id INT PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL
);

INSERT INTO order_items VALUES
  (1, 'paid', 100.00),
  (2, 'paid', 250.50),
  (3, 'refunded', 99.99),
  (4, 'paid', 250.50);

SELECT status, COUNT(*) AS n, ROUND(SUM(amount), 2) AS total
FROM order_items
GROUP BY status
ORDER BY total DESC;
`;

const SAMPLE_REDIS = `# 每行一条命令，# 开头是注释。每次运行都在专用 db index 的空库里开始。
ZADD leaderboard 10 a
ZADD leaderboard 30 b
ZADD leaderboard 20 c
ZREVRANGE leaderboard 0 -1 WITHSCORES
HSET user:1 name cole age 30
HGETALL user:1
`;

/**
 * 沙箱目录在仓库内，仓库根 package.json 写着 "type": "module"，于是 main.js 会被 Node
 * 当成 ES Module —— require/exports 一律 ReferenceError。盖一个就近的 commonjs 声明才解得开。
 */
const CJS_PACKAGE_JSON = '{\n  "type": "commonjs"\n}\n';

/**
 * tsc 只自动装 `@types/node`：不写 `--types` 的话它会从沙箱一路向上找到仓库的
 * `node_modules/@types/*`，把 react-dom 那套 DOM 依赖也拖进编译（我们只给 es2020 的 lib，
 * 于是满屏 TS2304，用户看到的是"我的代码没报错但编译失败"）。
 * `--skipLibCheck` 是同一件事的兜底：别人的 .d.ts 里的报错不该算在用户头上。
 */
const TSC_ARGS = ['--no-install', 'tsc',
                  '--target', 'es2020', '--module', 'commonjs', '--lib', 'es2020',
                  '--types', 'node', '--skipLibCheck',
                  '--outDir', '.', 'main.ts'];

export const IDE_LANGUAGES: readonly IdeLanguage[] = [
  {
    id: 'python',
    execution: 'command',
    label: 'Python 3',
    fileName: 'main.py',
    editorLanguage: 'python',
    sample: SAMPLE_PYTHON,
    run: { command: 'python3', args: ['main.py'] },
    probe: { command: 'python3', args: ['--version'] },
    replKind: true,
    debugKind: 'python',
    hint: 'stdin 从下面的输入框读；想逐句试就用右侧 REPL 会话，变量在会话里留着；' +
      '想看"走到这一行时变量长什么样"就点行号下断点，再按 调试（调试时 input() 读不到东西）',
  },
  {
    id: 'java',
    execution: 'command',
    label: 'Java',
    fileName: 'Main.java',
    editorLanguage: 'java',
    sample: SAMPLE_JAVA,
    compile: { command: 'javac', args: ['-encoding', 'UTF-8', 'Main.java'] },
    run: { command: 'java', args: ['-cp', '.', 'Main'] },
    probe: { command: 'javac', args: ['-version'] },
    replKind: true,
    debugKind: 'java',
    hint: '类名必须是 public class Main（文件名与类名要一致才能编译）',
  },
  {
    id: 'javascript',
    execution: 'command',
    label: 'JavaScript (Node)',
    fileName: 'main.js',
    editorLanguage: 'typescript',
    sample: SAMPLE_JAVASCRIPT,
    scaffold: { 'package.json': CJS_PACKAGE_JSON },
    run: { command: 'node', args: ['main.js'] },
    probe: { command: 'node', args: ['--version'] },
    replKind: true,
    debugKind: 'javascript',
    hint: 'CommonJS；读 stdin 用 require("fs").readFileSync(0, "utf8")',
  },
  {
    id: 'typescript',
    execution: 'command',
    label: 'TypeScript',
    fileName: 'main.ts',
    editorLanguage: 'typescript',
    sample: SAMPLE_TYPESCRIPT,
    // 不引新依赖：镜像里已有 typescript 包，npx --no-install 探不到就把这门语言标成不可用。
    // tsc 产出 main.js，所以这门语言同样需要上面的 commonjs 声明。
    scaffold: { 'package.json': CJS_PACKAGE_JSON },
    compile: { command: 'npx', args: TSC_ARGS },
    run: { command: 'node', args: ['main.js'] },
    probe: { command: 'npx', args: ['--no-install', 'tsc', '--version'] },
    hint: '类型错误在编译阶段报出来；console/process 可用（只装了 @types/node）',
  },
  {
    id: 'c',
    execution: 'command',
    label: 'C',
    fileName: 'main.c',
    editorLanguage: 'typescript',
    sample: SAMPLE_C,
    compile: { command: 'gcc', args: ['-std=c17', '-O1', '-o', 'a.out', 'main.c'] },
    run: { command: './a.out', args: [] },
    probe: { command: 'gcc', args: ['--version'] },
    hint: 'gcc -std=c17；scanf 从 stdin 读',
  },
  {
    id: 'cpp',
    execution: 'command',
    label: 'C++',
    fileName: 'main.cpp',
    editorLanguage: 'typescript',
    sample: SAMPLE_CPP,
    compile: { command: 'g++', args: ['-std=c++17', '-O1', '-o', 'a.out', 'main.cpp'] },
    run: { command: './a.out', args: [] },
    probe: { command: 'g++', args: ['--version'] },
    hint: 'g++ -std=c++17',
  },
  {
    id: 'mysql',
    label: 'MySQL 8（一次性库）',
    fileName: 'main.sql',
    editorLanguage: 'sql',
    execution: 'sql',
    setupLabel: '预置语句（每次运行都从这里开始：建表、灌数……）',
    probeKind: 'mysql',
    sample: SAMPLE_MYSQL,
    hint: '跑在临时库里，最后一个结果集显示成表格；DDL/DML 都允许，但 INTO OUTFILE / LOAD_FILE / GRANT / SHUTDOWN / SET GLOBAL / 系统库 / /*! 版本注释仍被拒',
  },
  {
    id: 'redis',
    label: 'Redis 7（专用 db）',
    fileName: 'commands.txt',
    editorLanguage: 'markdown',
    execution: 'redis',
    setupLabel: '预置命令（先造好键空间，再看正文命令的效果）',
    probeKind: 'redis',
    sample: SAMPLE_REDIS,
    hint: '每行一条命令，逐条回回复；跑在专用 db index 上，每次运行前先 FLUSHDB。FLUSHALL / CONFIG / KEYS / EVAL 等按判题同一份白名单被拒',
  },
  {
    id: 'pyspark',
    label: 'PySpark（常驻会话）',
    fileName: 'main.py',
    editorLanguage: 'python',
    execution: 'spark-python',
    setupLabel: '预置 SQL（建表、灌数……每次运行都在同一个常驻会话里执行）',
    timeoutMs: 120_000,
    probeKind: 'pyspark',
    sample: SAMPLE_PYSPARK,
    hint: '跑在判题同款常驻 SparkSession 上（冷启动 3~10s，复用后 <1s）；print 与最后一个 DataFrame 都会回给你。判题在跑时你会排在它后面（不抢占）',
  },
  {
    id: 'spark-scala',
    label: 'Spark Scala（每次真编译）',
    fileName: 'Solution.scala',
    editorLanguage: 'scala',
    execution: 'spark-scala',
    timeoutMs: 120_000,
    probeKind: 'spark-scala',
    sample: SAMPLE_SPARK_SCALA,
    // 没有预置框：每次都是一个新 JVM、由你自己的 main 建 SparkSession，
    // 前置 SQL 根本没有地方执行 —— 与其偷偷丢掉，不如不给这个框。
    hint: '必须写成 `object Solution { def main(args: Array[String]): Unit = ... }`；scalac 每次真编译，实测一遍约 15s（编译与运行共用同一个预算）',
  },
];

export function findLanguage(id: string): IdeLanguage | undefined {
  return IDE_LANGUAGES.find((l) => l.id === id);
}
