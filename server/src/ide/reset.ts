import { removeWithRetry } from '../judge/workspace.js';
import { debugSessions, stopDebug } from './debug.js';
import { envFamilyOf, envUnsupportedReason, familyDir, IDE_ENV_ROOT, sumBytes, ensureIdeEnv } from './env.js';
import { findLanguage, type IdeLanguage } from './languages.js';
import { replSessions, stopRepl } from './repl.js';

/**
 * 一键把某门语言的依赖环境退回镜像默认。
 *
 * 顺序不能反，而且理由有两层：
 * ① Windows 上刚停的进程句柄可能还没释放，先删会 EBUSY —— 所以删这一步走
 *    `removeWithRetry`（判题沙箱早就为此踩过，复用它的重试而不是重写一遍）。
 * ② 更要紧的是 Linux：**删得掉，但活着的 REPL 不会因此改变 `sys.path`** ——
 *    那是启动时算好的。于是界面显示"已重置"，而那个会话还能 import 刚被删掉的包。
 *    这条在 Linux 上不会自然报错，所以另有一条接线断言钉住顺序。
 */

export interface IdeEnvResetResult {
  ok: boolean;
  /** 被删掉的环境占了多少盘（0 表示本来就是空的，那是幂等成功不是失败） */
  removedBytes: number;
  stoppedSessions: number;
  reason?: string;
}

/**
 * 要停的会话按**家族**挑，不按语言 id：javascript 与 typescript 共用同一个 node 环境，
 * 只 reset javascript 却留着 typescript 的 REPL，等于留下一个还在读已删目录的活进程。
 */
function sessionsOfSameFamily(family: string): string[] {
  const ids: string[] = [];
  for (const list of [replSessions(), debugSessions()]) {
    for (const s of list) {
      const lang = findLanguage(s.language);
      if (lang && envFamilyOf(lang) === family) ids.push(s.id);
    }
  }
  return ids;
}

export async function resetIdeEnv(language: IdeLanguage): Promise<IdeEnvResetResult> {
  const family = envFamilyOf(language);
  if (!family) {
    return { ok: false, removedBytes: 0, stoppedSessions: 0, reason: envUnsupportedReason(language) };
  }

  let stopped = 0;
  for (const id of sessionsOfSameFamily(family)) {
    const closed = (await stopRepl(id)) || (await stopDebug(id));
    if (closed) stopped++;
  }

  const dir = familyDir(IDE_ENV_ROOT, family);
  const removedBytes = await sumBytes(dir);
  await removeWithRetry(dir);

  try {
    await ensureIdeEnv(language);
  } catch (err) {
    // 目录已经删了却重建失败：必须说实话，否则下一次 import 的报错会被读成"用户代码有问题"
    return {
      ok: false,
      removedBytes,
      stoppedSessions: stopped,
      reason: `环境已清空但重建失败：${(err as Error).message}`,
    };
  }
  return { ok: true, removedBytes, stoppedSessions: stopped };
}
