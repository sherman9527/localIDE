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
