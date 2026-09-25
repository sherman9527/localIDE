/**
 * 判题器注册入口。可选栈（react/pyspark/spark-scala）在宿主机或裁剪过的镜像里可能缺失，
 * 因此用动态 import + catch，缺谁就少注册谁，/api/health 会如实报 false。
 */
import './java-junit.js';
import './mysql.js';
import './redis.js';

const OPTIONAL_RUNNERS = ['react-vitest.js', 'pyspark.js', 'spark-scala.js'];

export async function registerOptionalRunners(): Promise<string[]> {
  const loaded: string[] = [];
  for (const file of OPTIONAL_RUNNERS) {
    try {
      await import(/* @vite-ignore */ `./${file}`);
      loaded.push(file);
    } catch {
      // 该 runner 尚未实现或依赖缺失
    }
  }
  return loaded;
}

