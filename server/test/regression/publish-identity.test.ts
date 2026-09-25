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

describe('发布闸门：库里不许有本机身份', () => {
  const patterns = identityPatterns();

  it('身份判据真的取到了东西（取不到等于这条闸门在空转）', () => {
    expect(
      patterns.length,
      '既没拿到家目录名也没拿到 git 邮箱 —— 这条检查没在守任何东西，去查 homedir() 与 git config user.email',
    ).toBeGreaterThan(0);
  });

  it('被跟踪的文件里不许出现本机账户名或个人邮箱', () => {
    const files = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      cwd: config.repoRoot,
    })
      .split('\0')
      .filter(Boolean)
      .filter((p) => !BINARY.test(p));
    expect(files.length, '一个文件都没扫到，说明 git ls-files 跑空了').toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const f of files) {
      const full = join(config.repoRoot, f);
      if (!existsSync(full)) continue; // 只在历史里存在、工作树已删的，交给发布前的全量扫描
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const p of patterns) if (p.re.test(text)) offenders.push(`${p.label}  ->  ${f}`);
    }
    expect(offenders, `这些文件会把本机身份公开：\n${offenders.join('\n')}`).toEqual([]);
  });
});
