import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { resetIdeEnv } from '../../src/ide/reset.js';
import { findLanguage } from '../../src/ide/languages.js';

/**
 * reset 的**不碰共享状态**的那一半：接线顺序与参数语义。
 *
 * 会真的删 venv 的行为用例都在 `env-lifecycle.test.ts` 里串行跑 ——
 * vitest 默认并行跑不同文件，把 reset 放在这里会和装包用例互删（实测红过）。
 *
 * 为什么顺序还要单独钉：行为测试在 Linux 上即使"先删后停"也照样通过
 * （删得掉，且没人立刻去 import 那个已删目录），所以只有源码级断言拦得住它。
 */

const resetSrc = (): string => readFileSync(join(config.repoRoot, 'server', 'src', 'ide', 'reset.ts'), 'utf8');

const scala = findLanguage('spark-scala')!;
const c = findLanguage('c')!;

describe('resetIdeEnv 的参数语义（不碰 python 环境）', () => {
  it('不支持的语言直接拒绝并说明原因（不是"重置成功"然后什么也没发生）', async () => {
    const res = await resetIdeEnv(c);
    expect(res.ok).toBe(false);
    expect((res.reason ?? '').length).toBeGreaterThan(6);
  });

  it('环境本来就不存在时是幂等的成功，不是报错', async () => {
    const first = await resetIdeEnv(scala);
    expect(first.ok, first.reason ?? '').toBe(true);
    const again = await resetIdeEnv(scala);
    expect(again.ok, again.reason ?? '').toBe(true);
  });
});

describe('reset 的接线顺序：先停会话，再删目录', () => {
  it('dispose 出现在 removeWithRetry 之前', () => {
    const src = resetSrc();
    const stops = [src.indexOf('stopRepl('), src.indexOf('stopDebug(')].filter((i) => i >= 0);
    expect(stops.length, 'reset 里没有停会话的调用').toBeGreaterThan(0);
    const removeAt = src.indexOf('removeWithRetry(');
    expect(removeAt, 'reset 里没有删目录的调用').toBeGreaterThan(-1);
    expect(Math.min(...stops), '顺序反了：先删后停会留下读旧路径的活会话').toBeLessThan(removeAt);
  });

  it('删目录走 removeWithRetry，不裸 rm（Windows 上刚停的进程句柄可能还没释放）', () => {
    const src = resetSrc();
    expect(src).toContain('removeWithRetry');
    expect(src, '裸 rm 会撞 EBUSY；复用判题沙箱那套重试才对').not.toMatch(/\brm\(/);
  });

  it('路径全部来自 env.ts，reset 里不许自己再拼一份 venv 结构', () => {
    const src = resetSrc();
    expect(src).toContain('familyDir');
    expect(src, '自己拼 site-packages / bin 这类路径 ⇒ 与 env.ts 漂移，升版时只坏一处').not.toMatch(/['"]site-packages['"]/);
    expect(src).not.toMatch(/['"]bin['"]/);
  });

  it('要停的会话按**家族**挑，不按语言 id（js 与 ts 共用同一个 node 环境）', () => {
    const src = resetSrc();
    expect(src, '按 s.language === language.id 过滤会漏掉同家族的另一门语言').toContain('envFamilyOf');
    expect(src).toContain('sessionsOfSameFamily');
  });
});
