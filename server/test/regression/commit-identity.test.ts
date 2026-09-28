import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 提交署名闸门：commit 的作者/提交者必须是**发布要用的那个身份**。
 *
 * 为什么文件内容的发布闸门拦不住这件事：`publish-identity.test.ts` 扫的是**被跟踪的文件**，
 * 而身份写在 commit 元数据里 —— 推上去就进了公开历史，收不回来。
 * 上一轮脱敏把历史压成一个 noreply 署名的提交，随后仍有 5 个 commit 直接用本机
 * `git config` 提了出去（作者邮箱 = 个人 QQ 邮箱），靠推送前手动复扫才发现。
 * 本仓库的规矩是"不改 git config、身份逐条命令传"，而**"记得传"是靠不住的** ⇒ 变成机器判。
 *
 * 被测物是一个 bash 脚本，所以这里全部走**行为**：在临时仓库里造判据、用环境变量喂身份、
 * 看退出码与 stderr。结构断言只补一条真正抓不住的：接线顺序（跳过校验的那条早退必须在闸门之后）。
 */

const CHECKER = join(config.repoRoot, '.githooks', 'check-commit-identity.sh');
const IDENTITY_FILE = join(config.repoRoot, '.githooks', 'publish-identity');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

/** 造一个干净的 git 仓库（不继承本机 config：身份全部由 env 显式给）。 */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arena-identity-'));
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init 失败：${r.stderr}`);
  return dir;
}

function runChecker(cwd: string, env: Record<string, string | undefined>) {
  return spawnSync('bash', [CHECKER], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  });
}

function writeExpected(cwd: string, identity: string): void {
  mkdirSync(join(cwd, '.githooks'), { recursive: true });
  writeFileSync(join(cwd, '.githooks', 'publish-identity'), `${identity}\n`, 'utf8');
}

const PUBLISH = { name: 'Publisher', email: 'publisher@users.noreply.github.com' };
const FOREIGN = { name: 'Someone Else', email: 'someone@qq.com' };

function identEnv(who: 'AUTHOR' | 'COMMITTER', v: { name: string; email: string }) {
  return {
    [`GIT_${who}_NAME`]: v.name,
    [`GIT_${who}_EMAIL`]: v.email,
    // git 还要一个日期才肯认 ident；固定值，别让它随时钟漂
    [`GIT_${who}_DATE`]: '2026-01-01T00:00:00 +0800',
  };
}

describe('提交署名闸门（行为）', () => {
  it('判据文件带着一个像样的身份（空文件/没文件都必须判红，不许"没配就放行"）', () => {
    expect(existsSync(IDENTITY_FILE), '.githooks/publish-identity 不存在 ⇒ 这条闸门没在守任何东西').toBe(true);
    const text = readFileSync(IDENTITY_FILE, 'utf8').trim();
    expect(text, '判据是空的 ⇒ 闸门在空转').not.toBe('');
    expect(/^[^<]+<[^<@]+@[^<@]+>$/.test(text), `要写成 Name <email>，实际是：${text}`).toBe(true);
  });

  it.skipIf(!hasBash)('署名就是发布身份时放行', () => {
    const dir = freshRepo();
    writeExpected(dir, `${PUBLISH.name} <${PUBLISH.email}>`);
    const res = runChecker(dir, {
      ...identEnv('AUTHOR', PUBLISH),
      ...identEnv('COMMITTER', PUBLISH),
    });
    expect(res.status, `应当 exit 0，实际 ${res.status}：${res.stderr}`).toBe(0);
  });

  it.skipIf(!hasBash)('作者或提交者不是发布身份时判红，并把"该用的那条命令"说出口', () => {
    const dir = freshRepo();
    writeExpected(dir, `${PUBLISH.name} <${PUBLISH.email}>`);
    // 只坏提交者：作者对了也一样要拦 —— GitHub 上两个都显示，两个都会公开
    for (const broken of ['AUTHOR', 'COMMITTER'] as const) {
      const good = broken === 'AUTHOR' ? 'COMMITTER' : 'AUTHOR';
      const res = runChecker(dir, {
        ...identEnv(good, PUBLISH),
        ...identEnv(broken, FOREIGN),
      });
      expect(res.status, `${broken} 用了外来邮箱还放行 ⇒ 闸门没生效`).not.toBe(0);
      expect(res.stderr).toContain(FOREIGN.email);
      // 只说"不行"等于把人推向 ARENA_SKIP_HOOK；必须给出可用的写法
      expect(res.stderr, '报错要给出逐条传身份的命令形状').toContain('GIT_AUTHOR_EMAIL=');
    }
  });

  it.skipIf(!hasBash)('反向对照：没有判据文件时必须红（放行等于闸门在空转）', () => {
    const dir = freshRepo(); // 故意不写 publish-identity
    const res = runChecker(dir, {
      ...identEnv('AUTHOR', PUBLISH),
      ...identEnv('COMMITTER', PUBLISH),
    });
    expect(res.status, '缺判据却放行 ⇒ 这条闸门在没配的时候什么都不守').not.toBe(0);
    expect(res.stderr).toContain('publish-identity');
  });

  it.skipIf(!hasBash)('本机默认身份若与发布身份不同，仓库里真实跑一次要能红（证明它接的是 git var）', () => {
    // 直接在真仓库上跑一次：只读不写，验的是"脚本确实在读这个仓库的身份"而不是恒真。
    const dir = freshRepo();
    writeExpected(dir, `${PUBLISH.name} <${PUBLISH.email}>`);
    const notSet = { ...process.env };
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete notSet[k];
    // 临时仓库里 git var 取到的是 git 自己算出来的身份（本机 config 或 GIT_* env）：
    // 本机 git config 的邮箱不是发布邮箱，所以这条应该红；若是，就应当绿 —— 两种都要如实断言。
    const ident = spawnSync('bash', ['-c', 'git var GIT_AUTHOR_IDENT'], { cwd: dir, encoding: 'utf8' });
    const currentEmail = /<([^>]+)>/.exec(ident.stdout ?? '')?.[1] ?? '';
    const res = runChecker(dir, notSet);
    expect(res.status === 0, `本机身份 ${currentEmail} 的判定结果应当与"它等不等于发布身份"一致`).toBe(
      currentEmail === PUBLISH.email,
    );
  });
});

describe('接线：闸门必须在"跳过校验"那条早退之前', () => {
  const hook = readFileSync(join(config.repoRoot, '.githooks', 'pre-commit'), 'utf8');

  it('pre-commit 里真的调了这个脚本', () => {
    expect(hook, '.githooks/pre-commit 没调用 check-commit-identity.sh ⇒ 闸门形同虚设').toContain('check-commit-identity.sh');
  });

  it('ARENA_SKIP_HOOK 也不能绕过署名闸门（它绕的是测试套件，不是发布纪律）', () => {
    const gateAt = hook.indexOf('check-commit-identity.sh');
    // 比"早退那条语句"，不是比 'ARENA_SKIP_HOOK' 这个词 —— 文件头的注释里也提它，
    // 拿词当锚点会先命中注释，于是这条断言永远在比错的位置（第一版就是这样，红了才发现）。
    const skipAt = hook.indexOf('"${ARENA_SKIP_HOOK:-0}" = "1"');
    expect(gateAt, '找不到署名闸门').toBeGreaterThanOrEqual(0);
    expect(skipAt, '找不到 ARENA_SKIP_HOOK 那条早退语句（改写法的话请同步这条断言的锚点）').toBeGreaterThanOrEqual(0);
    expect(gateAt, '署名闸门必须排在跳过早退之前 —— 排在后面就等于给人留了绕过发布纪律的口子').toBeLessThan(skipAt);
  });
});
