import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { runProcess } from '../judge/process.js';

/**
 * Spark + Scala 的 classpath 与 JVM 参数（判题与网页 IDE 共用）。
 *
 * 搬进 `exec/` 的理由和 mysql/redis 一样：IDE 也要真编译真跑，而这里最容易出
 * "两边各写一份、只有一边修好"的地方就是**编译器与运行期用了不同版本的 Scala 库**。
 */

/** Spark 3.5 在 JDK 17 上必须开这些反射口子，否则运行时 Kryo/Unsafe 直接 InaccessibleObjectException。 */
export const SPARK_JVM_FLAGS = [
  '-Xmx1g',
  '--add-opens=java.base/java.lang=ALL-UNNAMED',
  '--add-opens=java.base/java.lang.invoke=ALL-UNNAMED',
  '--add-opens=java.base/java.lang.reflect=ALL-UNNAMED',
  '--add-opens=java.base/java.io=ALL-UNNAMED',
  '--add-opens=java.base/java.net=ALL-UNNAMED',
  '--add-opens=java.base/java.nio=ALL-UNNAMED',
  '--add-opens=java.base/java.util=ALL-UNNAMED',
  '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED',
  '--add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED',
  '--add-opens=java.base/sun.nio.ch=ALL-UNNAMED',
  '--add-opens=java.base/sun.nio.cs=ALL-UNNAMED',
  '--add-opens=java.base/sun.security.action=ALL-UNNAMED',
  '--add-opens=java.base/sun.util.calendar=ALL-UNNAMED',
];

export async function listJars(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.jar'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 编译器与运行期必须用**同一套** Scala 标准库：Spark 3.5 是 2.12 构建的，
 * 而 /opt/scala 里放的是独立下载的 2.13 三件套 —— 混用会编译通过但运行期
 * `NoSuchMethodError: scala.collection.GenTraversable`。所以优先用 Spark 自带的
 * scala-compiler/library/reflect，只有它缺失时才退回 /opt/scala。
 */
export async function scalaClasspath(): Promise<string[]> {
  const sparkJars = await listJars(config.sparkJarsDir);
  if (sparkJars.some((jar) => /scala-compiler-\d/.test(jar))) return sparkJars;
  return [...(await listJars(config.scalaJarDir)), ...sparkJars];
}

let jarCache: { at: number; compile: string[]; run: string[] } | null = null;
const JAR_CACHE_MS = 10 * 60_000;

export async function scalaClasspaths(): Promise<{ compile: string[]; run: string[] }> {
  if (jarCache && Date.now() - jarCache.at < JAR_CACHE_MS) return jarCache;
  const jars = await scalaClasspath();
  jarCache = { at: Date.now(), compile: jars, run: jars };
  return jarCache;
}

/**
 * 这台机器上的 Spark Scala 栈是否可用（判题与 IDE 共用这一条判据）。
 *
 * 不许用 `npx … scala-compiler -version` 这类命令探测：Scala 编译器是 spark jars 里的
 * `scala.tools.nsc.Main`，不是 npm 包 —— 探一个不存在的二进制，只会把能用的语言永远标成不可用。
 */
export async function scalaSparkAvailable(): Promise<boolean> {
  if (!existsSync(config.sparkJarsDir) && !existsSync(config.scalaJarDir)) return false;
  const jars = await scalaClasspath();
  // 编译器与 Spark 必须在同一套标准库上，缺一即判"这台机器跑不了 Scala Spark"
  if (!jars.some((jar) => /scala-compiler(-\d[^/]*)?\.jar$/.test(jar))) return false;
  if (!jars.some((jar) => /spark-sql/.test(jar))) return false;
  const java = await runProcess('java', ['-version'], { timeoutMs: 15_000 });
  return java.code === 0;
}
