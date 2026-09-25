---
name: handover
description: 维护项目交接工作板。完成工作项时从 TODO 移到 COMPLETED 并附验证命令与结果；开发中新出现的需求新增 WI 条目；砍掉功能则删除对应 WI 并在 memo.md 记录原因。当用户说"交接""handover""整理 work item""记录完成项""更新进度""收尾"，或每完成一个开发里程碑时使用。
---

# Handover — 工作板维护

配套文件（三者构成项目的"外部记忆"，缺一不可）：

| 文件 | 作用 | 更新时机 |
| --- | --- | --- |
| `HANDOVER.md` | work item 板：`COMPLETED` / `IN PROGRESS` / `TODO` / `新增需求池` | 每个状态变化即时 |
| `memo.md` | 开发/测试结果的按里程碑追加记录（做了什么 / 验证 / 已知问题 / 下一步） | 每个里程碑结束 |
| `rule.md` | 红线 + 变更自检清单 | 用户新增红线时；做 change 前必读 |

## 执行流程

1. **读状态**：依次 Read `rule.md`、`HANDOVER.md`、`memo.md` 顶部一段；若仓库有 openspec，跑 `openspec status --change <id>` 对照进度。
2. **判定动作**（三类，互斥时全部执行）：
   - **完成**：把 WI 从 `TODO`/`IN PROGRESS` **删除**，在 `COMPLETED` 追加一行：
     `- [x] WI-NN <标题>（plan Task N）｜验证：\`<命令>\` → <结果摘要>`
     验证命令必须真实跑过；没有命令与输出的完成项不许写。
   - **新需求**：在 `TODO` 末尾**新增** `WI-NN`（编号取当前最大 +1），标题一句话 + 括号注明来自哪个 change 或哪条用户诉求；同时把它补进对应 plan 的 checkbox 列表。若还不到排期粒度，放进 `新增需求池` 用 `N-NN` 编号。
   - **砍功能**：**删除**该 WI，并在 `memo.md` 当次里程碑的 `已知问题` 或新起一段写明：砍了什么、为什么、影响面（是否有代码/文档残留需清理）。残留清理属于该动作的一部分，不留悬空引用。
3. **同步 memo.md**：在 `memo.md` 顶部（最新在上）追加/更新当次记录，四字段齐全。
4. **一致性自检**（必做，任一不通过就修完再收尾）：
   - `HANDOVER.md` 的 WI 与 `docs/superpowers/plans/*.md` 的 Task checkbox 一一对应，无重复编号、无孤儿条目；
   - `COMPLETED` 每条都能被一条命令复现；
   - `TODO` 为空时明确写 `(无)`，不留空白段落；
   - 不违反 `rule.md` 的任何红线。

## 硬规则

- 不允许"只在 chat 里说完成了"而不写板 —— 板是唯一事实来源。
- 不允许把完成项继续留在 `TODO` 打勾了事（那是 plan 文件的用法，`HANDOVER.md` 用移动表达状态）。
- 不允许删除 `COMPLETED` 历史行（除纠错外），历史是回归排查的线索。
- 每次写板后随代码一起 commit，commit message 用 `docs(handover): <变化>`；若与工作项实现同批提交，可并入该 feat/fix commit。
