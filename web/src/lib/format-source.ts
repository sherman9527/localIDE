import type { Language } from '@arena/shared';

/** 答题输入形态：文本/Markdown 纯文本，或带语法高亮的代码。 */
export type AnswerMode = 'text' | 'code';

export const CODE_LANGUAGES: { value: Language; label: string }[] = [
  { value: 'java', label: 'Java' },
  { value: 'typescript', label: 'TypeScript / React' },
  { value: 'sql', label: 'SQL' },
  { value: 'python', label: 'Python' },
  { value: 'scala', label: 'Scala (Spark)' },
  { value: 'markdown', label: 'Markdown' },
];

export interface FormatOutcome {
  text: string;
  /** 用哪种方式格式化的，给 UI 如实说明 */
  how: 'sql-formatter' | 'prettier' | 'whitespace';
  note?: string;
}

/**
 * 空白整理：没有浏览器端格式化器的语言（Java/Python）至少去掉行尾空格、
 * 把制表符换成 2 空格、合并多余空行。这不是语法格式化，UI 必须如实说明。
 */
export function normalizeWhitespace(code: string): string {
  return code
    .replace(/\t/g, '  ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '\n');
}

export async function formatSource(language: Language, code: string): Promise<FormatOutcome> {
  if (!code.trim()) return { text: code, how: 'whitespace' };

  if (language === 'sql') {
    const { format } = await import('sql-formatter');
    return {
      text: format(code, { language: 'mysql', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 }),
      how: 'sql-formatter',
    };
  }

  if (language === 'typescript') {
    const [prettier, typescript, estree] = await Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/typescript'),
      import('prettier/plugins/estree'),
    ]);
    try {
      const text = await prettier.format(code, {
        parser: 'typescript',
        plugins: [typescript.default ?? typescript, estree.default ?? estree],
        printWidth: 120,
        semi: true,
        singleQuote: true,
      });
      return { text, how: 'prettier' };
    } catch {
      // TS 片段常不完整（只写了一个方法体），格式化失败时退回空白整理
      return { text: normalizeWhitespace(code), how: 'whitespace', note: '代码不完整，prettier 解析失败，已只做空白整理' };
    }
  }

  return {
    text: normalizeWhitespace(code),
    how: 'whitespace',
    note: language === 'markdown' ? undefined : '该语言没有浏览器端格式化器，这里只整理了缩进与空行，未改动语法结构',
  };
}

export function modeOf(question: { judgeKind: string; language?: string }): { mode: AnswerMode; language: Language } {
  if (question.judgeKind === 'llm-rubric') {
    return { mode: 'text', language: 'markdown' };
  }
  const language = (question.language ?? 'typescript') as Language;
  return { mode: 'code', language: language === 'markdown' ? 'typescript' : language };
}

const KEY_PREFIX = 'arena.answerMode.';

export function loadMode(questionId: string, fallback: { mode: AnswerMode; language: Language }) {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + questionId);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { mode?: AnswerMode; language?: Language };
    const mode = parsed.mode === 'code' || parsed.mode === 'text' ? parsed.mode : fallback.mode;
    const language = CODE_LANGUAGES.some((l) => l.value === parsed.language) ? (parsed.language as Language) : fallback.language;
    return { mode, language };
  } catch {
    return fallback;
  }
}

export function saveMode(questionId: string, value: { mode: AnswerMode; language: Language }): void {
  try {
    localStorage.setItem(KEY_PREFIX + questionId, JSON.stringify(value));
  } catch {
    // 隐私模式下 localStorage 会抛，不影响作答
  }
}

