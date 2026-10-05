import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * kernelspec 有三条各自会咬人的判据：
 * ① 必须装在**镜像级**目录 —— 装进 venv 的话，WI-87 的「重置环境」会把 kernel 一起删掉，
 *    而界面只显示"打不开"，不解释为什么；
 * ② argv[0] 必须等于 compose 里 ARENA_IDE_ENV_DIR 派生出来的解释器路径 —— 写死字面量就是
 *    第二处真相，compose 一改就悄悄不成立（本仓库对这类"两处各写一遍"栽过很多次）；
 * ③ Spark 的配置只能待在 PYSPARK_SUBMIT_ARGS 里，且必须以 `pyspark-shell` 收尾：
 *    写成普通环境变量**完全没效果**，少了尾缀则 --conf 会被当成应用参数。
 */

const root = config.repoRoot;
const kernel = JSON.parse(
  readFileSync(join(root, 'docker', 'jupyter', 'kernels', 'arena-pyspark', 'kernel.json'), 'utf8'),
) as { argv: string[]; display_name: string; env?: Record<string, string> };
const compose = readFileSync(join(root, 'compose.yml'), 'utf8');
const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8');

describe('arena-pyspark kernelspec', () => {
  it('argv 指向 venv 解释器，且 venv 根与 compose 的 ARENA_IDE_ENV_DIR 一致', () => {
    const dir = /ARENA_IDE_ENV_DIR:\s*(\S+)/.exec(compose)?.[1];
    expect(dir, 'compose 没设 ARENA_IDE_ENV_DIR ⇒ 没法核对 kernel 路径').toBeTruthy();
    expect(kernel.argv[0]).toBe(`${dir}/python/bin/python`);
    expect(kernel.argv).toEqual(expect.arrayContaining(['-m', 'ipykernel_launcher', '{connection_file}']));
  });

  it('display_name 不写死 Spark 版本（版本号只在 Dockerfile 的 ARG 里）', () => {
    expect(kernel.display_name).toBe('PySpark (arena)');
    expect(kernel.display_name).not.toMatch(/3\.\d+\.\d+/);
  });

  it('Spark 配置走 PYSPARK_SUBMIT_ARGS：含 --master、pyspark-shell 尾缀、独立 warehouse 与 Derby', () => {
    const args = kernel.env?.PYSPARK_SUBMIT_ARGS ?? '';
    expect(args).toContain('pyspark-shell');
    expect(args).toContain('--master local[2]');
    expect(args).toContain('spark.sql.warehouse.dir=/app/data/notebook-warehouse/wh');
    expect(args).toContain('-Dderby.system.home=/app/data/notebook-warehouse/derby');
    expect(kernel.env?.SPARK_LOCAL_IP).toBe('127.0.0.1');
  });

  it('Dockerfile 把它 COPY 进镜像级目录并当场断言，且没有 ipykernel install --user 这类写法', () => {
    const copy = dockerfile.split('\n').find((l) => l.includes('arena-pyspark/kernel.json'));
    expect(copy, 'Dockerfile 没把 kernel.json COPY 进镜像').toBeTruthy();
    expect(copy).toContain('/usr/local/share/jupyter/kernels/arena-pyspark/');
    expect(copy).not.toContain('arena-ide-env');
    expect(dockerfile).not.toMatch(/ipykernel install[^\n]*(--user|arena-ide-env)/);
  });
});
