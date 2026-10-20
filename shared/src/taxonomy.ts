/**
 * 题库与游戏共用 taxonomy —— 改这里等于改契约，必须同步 openspec/specs/question-bank。
 */
export const CATEGORY_IDS = [
  'frontend',
  'algorithms',
  'sql',
  'system-design',
  'big-data',
  'agent-design',
  'hot-interviews',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export const JUDGE_KINDS = [
  'java-junit',
  'react-vitest',
  'mysql',
  'redis',
  'pyspark',
  'spark-scala',
  'llm-rubric',
] as const;

export type JudgeKind = (typeof JUDGE_KINDS)[number];

export const LANGUAGES = ['java', 'typescript', 'sql', 'python', 'scala', 'markdown'] as const;

export type Language = (typeof LANGUAGES)[number];

/** 每个类别允许的判分方式；schema 用它拒绝"算法题用 python 判"这类错配。 */
export const CATEGORY_JUDGE_KINDS: Record<CategoryId, readonly JudgeKind[]> = {
  frontend: ['react-vitest', 'llm-rubric'],
  algorithms: ['java-junit'],
  sql: ['mysql', 'redis', 'llm-rubric'],
  'system-design': ['llm-rubric'],
  'big-data': ['pyspark', 'spark-scala', 'llm-rubric'],
  'agent-design': ['llm-rubric'],
  'hot-interviews': ['llm-rubric'],
};

export interface CategoryMeta {
  label: string;
  stack: string;
  editorLanguage: Language;
  accent: string;
}

export const CATEGORY_META: Record<CategoryId, CategoryMeta> = {
  frontend: { label: '前端工程', stack: 'TypeScript / React', editorLanguage: 'typescript', accent: '#0ea5e9' },
  algorithms: { label: '算法', stack: 'Java', editorLanguage: 'java', accent: '#8b5cf6' },
  sql: { label: 'SQL 与存储', stack: 'MySQL / Redis', editorLanguage: 'sql', accent: '#f59e0b' },
  'system-design': { label: '系统设计', stack: '分布式 / 架构', editorLanguage: 'markdown', accent: '#10b981' },
  'big-data': { label: '大数据处理', stack: 'PySpark / Flink / OLAP', editorLanguage: 'python', accent: '#f43f5e' },
  'agent-design': { label: 'Agent 设计', stack: 'LLM Agent / MCP / RAG', editorLanguage: 'markdown', accent: '#14b8a6' },
  'hot-interviews': { label: '高频面试题', stack: '企业真题', editorLanguage: 'markdown', accent: '#6366f1' },
};

export const CATEGORY_LIST: (CategoryMeta & { id: CategoryId })[] = CATEGORY_IDS.map((id) => ({ id, ...CATEGORY_META[id] }));

export const isCategoryId = (v: string): v is CategoryId => (CATEGORY_IDS as readonly string[]).includes(v);

/**
 * 题库里真实出现过的出处公司（N-11 第一发把它从两份字面量收成一份）。
 *
 * 这里原来是**两处各抄一遍**：`server/test/bank/content.test.ts` 的 `COMPANY_FLOORS` 键、
 * 以及报告侧"这个标签是不是公司名"的判断。抄第三份是迟早的事（本仓库为同一族问题反复付账），
 * 而分叉的代价不对称：清单少一家 ⇒ 那一家的 `airbnb-*` 之类标签被报成"考点缺口"，
 * 报表就在一件不存在的事情上催补矩阵行。
 * ⚠ 这一份**不是** `scripts/jd/sources.json` 的替代：那是抓取目标（含查询与 adapter），
 * 这是"题目出处点名过的公司"。两边要对齐时改的是这里，sources.json 只增目标不增名字。
 */
export const QUESTION_COMPANIES = ['Airbnb', 'Apple', 'DeepSeek', 'PDD', 'ByteDance', 'Alibaba'] as const;

export type QuestionCompany = (typeof QUESTION_COMPANIES)[number];
