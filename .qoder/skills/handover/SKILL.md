---
name: handover
description: 维护项目交接工作板。完成工作项时从 TODO 移到 COMPLETED 并附验证命令与结果；开发中新出现的需求新增 WI 条目；砍掉功能则删除对应 WI 并在 memo.md 记录原因。当用户说"交接""handover""整理 work item""记录完成项""更新进度""收尾"，或每完成一个开发里程碑时使用。
---

# Handover — 工作板维护

配套文件（构成项目的"外部记忆"，缺一不可）：

| 文件 | 作用 | 更新时机 |
| --- | --- | --- |
| `HANDOVER.md` | work item 板：`速览` / `COMPLETED`（只留最近 20 条）/ `IN PROGRESS` / `TODO` / `已决定（推迟 / 不做）` / `新增需求池` | 每个状态变化即时 |
| `docs/HANDOVER-archive.md` | `COMPLETED` 的历史附录：从板上**搬**下来的旧条目（整条、一字不改） | 板上超过 20 条时 |
| `memo.md` | 开发/测试结果的按里程碑追加记录（做了什么 / 验证 / 已知问题 / 下一步） | 每个里程碑结束 |
| `rule.md` | 红线 + 变更自检清单 | 用户新增红线时；做 change 前必读 |

> 为什么拆：2026-10-19 时 `HANDOVER.md` 长到 227 KB / 107 条已完成项 —— **读不完的记忆文件等于没有记忆文件**。
> 拆档不是删：三份文件（板 + 归档 + memo）由 `server/test/regression/memory-file-ratchet.test.ts` 按**并集**判"只增不减"，
> 所以"把条目从板上搬进归档"是中性的，而"少一条"会红。搬移动机、顺序规则与踩过的坑都写在那份文件的头部注释里。

## 执行流程

1. **读状态**：依次 Read `rule.md`、`HANDOVER.md`、`memo.md` 顶部一段；若仓库有 openspec，跑 `openspec status --change <id>` 对照进度。
2. **判定动作**（三类，互斥时全部执行）：
   - **完成**：把 WI 从 `TODO`/`IN PROGRESS` **删除**，在 `COMPLETED` 追加一行：
     `- [x] WI-NN <标题>（plan Task N）｜验证：\`<命令>\` → <结果摘要>`
     验证命令必须真实跑过；没有命令与输出的完成项不许写。
   - **新需求**：在 `TODO` 末尾**新增** `WI-NN`（编号取当前最大 +1），标题一句话 + 括号注明来自哪个 change 或哪条用户诉求；同时把它补进对应 plan 的 checkbox 列表。若还不到排期粒度，放进 `新增需求池` 用 `N-NN` 编号。
   - **砍功能 / 决定不做**：**删除**该 WI，并在 `memo.md` 当次里程碑的 `已知问题` 或新起一段写明：砍了什么、为什么、影响面（是否有代码/文档残留需清理）。残留清理属于该动作的一部分，不留悬空引用。
     如果结论是"推迟做"或"评估后不做"而条目本身有参考价值（含计划文件路径、核过的事实），把它放进 `## 已决定（推迟 / 不做，带日期与理由）`：
     写清**谁、哪天、依据什么**，并把原文整条降为缩进的"原文"附在下面 —— 这不是待办，但也不该被重新发现一遍。
3. **保持板面可读**：`## COMPLETED` 超过 20 条时，把最旧的整条搬进 `docs/HANDOVER-archive.md`（**搬移，不删，一字不改**），
   两份文件用同一条排序规则（条目正文里出现的最近日期倒序），搬完必须"条目行数合计不减少"。
   ⚠ 棘轮**拦不住"把一条旧条目压短"**（它按并集的字节与条数判，压短一条既不减条数也不够撞容差）——
   2026-10-19 我压短 WI-56 就是靠逐行比对才发现的。所以搬移/重写后跑一次这个，它列出"HEAD 里有而现在没有"的行：

   ```bash
   python - <<'PY'
   import subprocess, io, collections
   old = subprocess.run(['git','show','HEAD:HANDOVER.md'],capture_output=True).stdout.decode('utf-8').replace('\r\n','\n').split('\n')
   now = set(l for l in (io.open('HANDOVER.md',encoding='utf-8',newline='').read() + io.open('docs/HANDOVER-archive.md',encoding='utf-8',newline='').read()).replace('\r\n','\n').split('\n') if l.strip())
   lost = [l for l in collections.Counter(l for l in old if l.strip()).elements() if l not in now]
   print('丢失行数:', len(lost))
   for l in lost[:20]: print('  *', l[:90])
   PY
   ```

   预期只列出"被故意降成缩进原文"的那几行；出现别的行就说明内容没了，先补回去再谈提交。
4. **同步 memo.md**：在 `memo.md` **末尾**（本文件自己的首行写明"持续追加，**最新在下**"）追加/更新当次记录，四字段齐全。
   ⚠ 顺序的真相以 `memo.md` 首行为准（2026-10-20 订正：这一条从前写的是"顶部追加/最新在上"，与本文件的实际约定和实践相反 —— 两个人各按一半做就是第三个顺序，那才是事故）。要改顺序得先改 `memo.md` 首行并整篇迁一次，不是顺手换方向。
   ⚠ 追加写法不许写成 `open(p,'w').write(open(p).read() + add)`：Python 会**先清空文件再去读**（2026-10-12 就这样丢过 3813 行）。
   先把整份读进变量，再开文件写。
5. **一致性自检**（必做，任一不通过就修完再收尾）：
   - `HANDOVER.md` 的 WI 与 `docs/superpowers/plans/*.md` 的 Task checkbox 一一对应，无重复编号、无孤儿条目；
   - `COMPLETED` 每条都能被一条命令复现；
   - `TODO` 为空时明确写 `(无)`，不留空白段落；
   - `- [x]` 只出现在 `## COMPLETED` 段、`- [ ]` 只出现在 `IN PROGRESS` / `TODO` 段（住错段会被按段切片的脚本静默丢弃，`WI-90/91/114` 都犯过）；
   - 跑 `npx vitest run server/test/regression/memory-file-ratchet.test.ts` 与 `server/test/regression/bank-baseline.test.ts`，两者都必须绿；
   - 不违反 `rule.md` 的任何红线。

## 硬规则

- 不允许"只在 chat 里说完成了"而不写板 —— 板是唯一事实来源。
- 不允许把完成项继续留在 `TODO` 打勾了事（那是 plan 文件的用法，`HANDOVER.md` 用移动表达状态）。
- 不允许删除 `COMPLETED` 历史行（除纠错外），历史是回归排查的线索；**为了"精简"而压缩旧条目也不允许** ——
  2026-10-19 把 WI-56 从 80 行压成 5 行时，候选清单、已否掉的死路与"顺序别倒"那课一起没了，那次是靠
  "逐行比对 HEAD 与现在"才发现的；判"丢没丢"要看**行**，不是看条目数。
- 长条目要搬，不要删；搬完 `HANDOVER.md` + `docs/HANDOVER-archive.md` + `memo.md` 的并集必须仍然判得住。
- 每次写板后随代码一起 commit，commit message 用 `docs(handover): <变化>`；若与工作项实现同批提交，可并入该 feat/fix commit。
