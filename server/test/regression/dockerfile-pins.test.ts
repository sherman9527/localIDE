import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 镜像构建的"可复现性"闸门（GitHub 归档的前提）。
 *
 * 为什么这条要有测试钉着：这些约束全是"写在 Dockerfile 注释里、下次改的人顺手删掉"的东西。
 * 2026-09-25 实测过一次没有它们的样子：Redis 7 源码两个下载源同时挂掉，旧 Dockerfile 的
 * "失败就退回 apt 版本，不阻塞构建"让镜像静默拿到 6.0.16，栈健康照报 `redis:true`（只 PING），
 * 四道题一路判到"参考解没过"才炸 —— 报错形状还最容易读成"题目写坏了"。
 * ⇒ 构建期的断言与"不许静默降级"这两件事，必须比人的记性长。
 */

const dockerfile = readFileSync(join(config.repoRoot, 'docker', 'Dockerfile'), 'utf8');
const buildinfo = readFileSync(join(config.repoRoot, 'docker', 'BUILDINFO.md'), 'utf8');

/** 从 `FROM repo:tag@sha256:...` 里取 digest；没钉就返回 null。 */
function baseDigest(text: string): string | null {
  return /FROM\s+\S+@(sha256:[a-f0-9]{64})/.exec(text)?.[1] ?? null;
}

it('base 镜像按 digest 钉住（tag 会跟着 point release 动，digest 不会）', () => {
  expect(baseDigest(dockerfile), 'docker/Dockerfile 的 FROM 必须带 @sha256:…').toBeTruthy();
});

it('BUILDINFO.md 里写的 digest 与 Dockerfile 用的是同一个（文档不许比构建超前或落后）', () => {
  const pinned = baseDigest(dockerfile);
  expect(pinned).toBeTruthy();
  expect(buildinfo, `BUILDINFO.md 里找不到 ${pinned}`).toContain(pinned ?? '');
});

it('三个会改判题语义的主版本都有构建期断言：JDK 17 / MySQL 8 / Redis 7', () => {
  expect(dockerfile, 'JDK 主版本没断言').toMatch(/version "17/);
  expect(dockerfile, 'MySQL 主版本没断言').toMatch(/Ver 8\\\./);
  expect(dockerfile, 'Redis 版本没断言').toMatch(/redis-server --version \| grep -q/);
});

it('Redis 不许"下载失败就退回 apt"（那次静默降级就是这么来的）', () => {
  expect(dockerfile, '这条兜底必须删掉：退回 apt 的 6.x 会让判题静默变坏').not.toMatch(/保留 apt 版本/);
  expect(dockerfile, '取不到源码必须让构建失败').toMatch(/exit 1/);
});

it('apt 那层把解析出的版本落进镜像（查"这次到底装了什么"不用猜）', () => {
  expect(dockerfile).toContain('/opt/arena-apt-resolved.txt');
});

it('选版本的 ARG 都有默认值（空默认会让构建悄悄装到镜像站当前的最新版）', () => {
  const args = [...dockerfile.matchAll(/^ARG ([A-Z_]+)(?:=(.*))?$/gm)];
  expect(args.length, '一个 ARG 都没找到，大概是写法变了').toBeGreaterThan(3);
  for (const [, name, value] of args) {
    expect(value, `ARG ${name} 没有默认版本`).toBeTruthy();
  }
});

it('npm 依赖有 lockfile 且被 git 跟踪（镜像里 `npm install` 靠它）', () => {
  expect(existsSync(join(config.repoRoot, 'package-lock.json'))).toBe(true);
  expect(readFileSync(join(config.repoRoot, 'package-lock.json'), 'utf8')).toContain('"lockfileVersion"');
});
