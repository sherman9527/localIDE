import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 端口暴露闸门（N-16 的落地）。
 *
 * 为什么要有这条：把发布端口从 `7788:7788` 改成 `127.0.0.1:7788:7788` 是一次**决定**，
 * 而不是一行配置 —— 它意味着"这工具只在本机用"。没有闸门的话，
 * 哪天有人为了从平板点开页面把它改回去，这件事不会在任何一次测试里留下痕迹。
 *
 * 判据取"每一条端口映射都必须以 127.0.0.1: 开头"，而不是"检查那一条已知的"：
 * 新增服务默认就被管，得显式想清楚才加得进去。
 */

const ROOT = join(__dirname, '..', '..', '..');
const LOOPBACK = /^127\.0\.0\.1:\d+:\d+(?:\/(?:tcp|udp))?$/;

function publishedMappings(yaml: string): string[] {
  const out: string[] = [];
  let inPorts = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'ports:') {
      inPorts = true;
      continue;
    }
    if (!inPorts) continue;
    if (!line.startsWith('- ')) {
      inPorts = false;      // ports 块结束（遇到下一个键）
      continue;
    }
    out.push(line.slice(2).replaceAll('"', ''));
  }
  return out;
}

const composeYaml = await readFile(join(ROOT, 'compose.yml'), 'utf8');
const mappings = publishedMappings(composeYaml);

describe('compose.yml 的端口暴露', () => {
  it('确实读到了端口映射（否则下面那条断言就是空转的）', () => {
    expect(mappings.length, 'compose.yml 里一个 ports 条目都没解析到，先修这个测试自己').toBeGreaterThanOrEqual(3);
  });

  it('每个发布到宿主的端口都必须绑在回环上', () => {
    const open = mappings.filter((m) => !LOOPBACK.test(m));
    expect(
      open,
      `这些端口对局域网开放：${open.join(', ')}。` +
        '本工具没有鉴权，/api/bank 会把整个题库（含被移除的题）发出去 —— 要开出去请先想清楚是谁在用。',
    ).toEqual([]);
  });

  it('7799 仍然空着（那是宿主 CLI 桥的端口，撞上会让两边 llm-rubric 一起变 false）', () => {
    expect(mappings.some((m) => m.includes(':7799:')), 'compose 里出现了 7799').toBe(false);
  });
});

describe('启动脚本不许绕过 compose 的端口绑定', () => {
  it('没有 --publish / -p 之类的临时端口覆盖', async () => {
    const [sh, ps1] = await Promise.all([
      readFile(join(ROOT, 'start.sh'), 'utf8'),
      readFile(join(ROOT, 'start.ps1'), 'utf8'),
    ]);
    for (const [name, text] of [['start.sh', sh], ['start.ps1', ps1]] as const) {
      expect(text.includes('--publish'), `${name} 里出现了 --publish（会绕过 compose 的绑卡决定）`).toBe(false);
    }
  });
});
