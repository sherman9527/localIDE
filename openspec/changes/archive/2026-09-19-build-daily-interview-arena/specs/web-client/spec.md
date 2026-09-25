## ADDED Requirements

### Requirement: React 浅色高流畅界面（场景 5/17）
前端 SHALL 使用 React + Vite + TypeScript 实现，主色板 MUST 为浅色（页面底色亮度 L* ≥ 85，正文对比度 ≥ 7:1），并 MUST 使用代码编辑器组件（CodeMirror 6）支持 Java / TypeScript / SQL / Python 语法高亮与 `Ctrl/Cmd+Enter` 提交。交互反馈（按键、点击、提交）SHALL 在 100ms 内给出视觉响应；动画 MUST 只使用 `transform`/`opacity`。

#### Scenario: 提交后立即进入运行态
- **WHEN** 用户按 `Ctrl+Enter` 提交代码
- **THEN** 100ms 内按钮进入 loading 且显示"编译/运行中"，判题返回后展示用例级结果

#### Scenario: 浅色主题可断言
- **WHEN** 读取 `web/src/styles/tokens.css` 的 `--bg`
- **THEN** 其亮度 L* ≥ 85（由样式单元测试断言）

### Requirement: 题面必须支持 Markdown 与代码块
senior/principal 题面必然包含代码片段、表格与多段说明，题目页与评分结果页 SHALL 渲染 Markdown（含代码块、表格、列表），并 MUST 对渲染内容做 sanitize；题面中的代码块 SHALL 提供"复制到编辑器"操作。

#### Scenario: 带代码骨架的题面正常渲染
- **WHEN** 题目 `statement` 含 ```java 代码骨架与一张表格
- **THEN** 页面渲染出高亮代码块与表格，且不执行其中任何脚本

### Requirement: 作答形态可选（文本 / 代码）与一键美化
答题输入区 SHALL 支持两种形态并可在题目间记忆（按题目 id 存 localStorage）：`文本 / Markdown`（纯文本输入）与 `代码`（CodeMirror 高亮，语言可选 Java / TypeScript / SQL / Python）。代码题 MUST 锁死为代码形态（判题器只接受源码），主观题默认文本形态但允许切到代码形态以便贴 DDL / 配置 / 伪代码。两种形态间切换 MUST 不丢失已输入内容。
输入区 SHALL 提供"美化代码"按钮：SQL 用 `sql-formatter`、TypeScript 用 prettier（按需动态加载），没有浏览器端格式化器的语言（Java / Python）MUST 只做空白整理并在界面上如实说明"未改动语法结构"。

#### Scenario: 主观题切到代码形态后按 SQL 高亮
- **WHEN** 用户在主观题点击"代码"并把语言选为 SQL
- **THEN** 输入区换成带 SQL 高亮的编辑器，"文本 / Markdown"仍可选，离开再回来时保持代码 + SQL 形态

#### Scenario: 美化按钮对 SQL 生效、对 Java 如实降级
- **WHEN** 在 SQL 形态下点"美化代码"
- **THEN** 关键字被大写、子句换行；而当语言为 Java 时按钮提示"只整理了缩进与空行，未改动语法结构"，代码内容语义不变

### Requirement: 用例级结果面板（场景 3/4）
答题页 SHALL 在提交前展示全部测试用例（输入/期望），提交后 SHALL 展示"通过 N / 失败 M"，失败用例可展开查看 `expected` vs `actual`；`status:'error'` 时 MUST 展示日志原文与"这不是答案错误而是运行失败"的区分提示。

#### Scenario: 部分失败可见失败用例
- **WHEN** 判题返回 `passed:1, failed:2`
- **THEN** 面板顶部显示"通过 1 / 失败 2"，两条失败用例名可见且可展开期望/实际值

### Requirement: 题目移除入口（场景 10/22）
每道题的详情页与题库列表项 SHALL 提供"移除"按钮，点击后调用软删除接口并即时从列表消失；题库列表 SHALL 提供"显示已移除"开关以便恢复。

#### Scenario: 列表内一键移除
- **WHEN** 用户在题库列表点击某题的"移除"
- **THEN** 该题立即从列表消失，`content/hidden.json` 含其 id；打开"显示已移除"后该题以灰色态出现且可恢复

### Requirement: 题库浏览与今日挑战分离
`/bank` SHALL 支持按 7 个类别、难度、技术栈标签筛选与关键字搜索，用于自由练习；`/`（今日挑战）与 `/bank` MUST 使用同一套题目契约但互不共享筛选状态。

#### Scenario: 筛选不影响今日挑战
- **WHEN** 用户在 `/bank` 把筛选设为 `big-data` 后返回今日挑战
- **THEN** 今日挑战仍展示其自身按日期确定的类别选择，不被筛选污染
