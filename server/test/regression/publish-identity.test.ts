import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';

/**
 * 发布闸门：库里不许写进本机身份。
 *
 * 判据故意不硬编码任何具体人名/邮箱 —— 那等于把要防的东西再抄一遍进仓库，
 * 而且换个人就失效。改成从**当前机器**取身份（家目录名、git 配置的邮箱），
 * 断言它没出现在任何被跟踪的文件里：换台机器、换个人，守的还是他自己的身份。
 *
 * 为什么非要有这条：修绝对路径那次，修完之后**记录"我修了什么"的日志里又把原串抄了一遍**，
 * 于是已清掉的东西从文档里漏了回来。人写复盘天然会引用原文，所以这道检查不能靠人。
 */

/** 只按"路径成分"的形态匹配，免得把常见词（admin、test、data）误判成账户名。 */
function identityPatterns(): Array<{ label: string; re: RegExp }> {
  const user = homedir().split(/[\\/]/).filter(Boolean).pop();
  const out: Array<{ label: string; re: RegExp }> = [];
  if (user && user.length > 3) {
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push({
      label: `本机账户名以路径成分出现`,
      re: new RegExp(`(?:[A-Za-z]:[\\\\/]|/c/|/Users/|/home/|\\\\Users\\\\)${esc}[\\\\/]`, 'i'),
    });
  }
  let email = '';
  try {
    email = execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    email = '';
  }
  // noreply 邮箱本来就是为公开准备的，不防。
  if (email && email.includes('@') && !/@users\.noreply\.github\.com$/.test(email)) {
    const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push({ label: 'git 配置里的个人邮箱出现在文件内容中', re: new RegExp(esc, 'i') });
  }
  return out;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|zip|wasm|pdf|bundle)$/i;

/**
 * 这条闸门只能在**有 git 元数据**的地方跑，而容器里恰好没有：`.dockerignore` 排掉了 `.git`，
 * 于是 `git ls-files` 直接 `fatal: not a git repository`。
 * 第一版没管它，结果 `./start.sh --verify` 整个交付档被这条"跟判题无关"的闸门撞红
 * （容器测的是镜像里那份源码，它不知道也不该知道自己会不会被发布）。
 *
 * 但"没 git 就跳过"不能写成无条件 `try/catch → return`：那等于宿主上 git 一坏，
 * 这条闸门就静默变成装饰品（正是 `dev_verify_workflow.md` 第 3 条要点名的故障）。
 * ⇒ 跳过必须**同时**满足"确实在镜像里"，这一条单独占一个永远会跑的 it。
 */
const inImage = existsSync('/.dockerenv');

function trackedTextFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', cwd: config.repoRoot })
      .split('\0')
      .filter(Boolean)
      .filter((p) => !BINARY.test(p));
  } catch {
    return null;
  }
}

const tracked = trackedTextFiles();

describe('发布闸门：库里不许有本机身份', () => {
  const patterns = identityPatterns();

  it('身份判据真的取到了东西（取不到等于这条闸门在空转）', () => {
    expect(
      patterns.length,
      '既没拿到家目录名也没拿到 git 邮箱 —— 这条检查没在守任何东西，去查 homedir() 与 git config user.email',
    ).toBeGreaterThan(0);
  });

  it('在镜像里跳过只能因为镜像里没有 .git，不能因为宿主仓库坏了', () => {
    if (tracked !== null) return; // 拿得到文件清单 ⇒ 本条无需判据，正常跑主用例
    expect(inImage, 'git ls-files 失败了，但这里不是镜像（/.dockerenv 不存在）⇒ 宿主仓库出问题，不许当"跳过"混过去').toBe(true);
  });

  it.skipIf(tracked === null)('被跟踪的文件里不许出现本机账户名或个人邮箱', () => {
    // skipIf 而不是 return：跑出来的那一行会写 "1 skipped"，看不见跳过这件事本身就是缺陷
    const files = tracked ?? []; // 走到这里 tracked 必然非 null（上面那两条 it 负责"为什么会是 null"）
    expect(files.length, '一个文件都没扫到，说明 git ls-files 跑空了').toBeGreaterThan(50);
    const hits: string[] = [];
    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(join(config.repoRoot, rel), 'utf8');
      } catch {
        continue; // 列出来却读不到（刚被删）：不是本条要管的事
      }
      for (const { label, re } of patterns) if (re.test(text)) hits.push(`${rel} ← ${label}`);
    }
    expect(hits, `这些文件里出现了本机身份：\n${hits.join('\n')}`).toEqual([]);
  });
});
