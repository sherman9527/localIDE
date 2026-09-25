import type { CustomCase } from '@arena/shared';

export interface ParsedCases {
  cases: CustomCase[];
  errors: { line: number; msg: string }[];
}

/**
 * 自测用例文本 → CustomCase[]。一行一组：
 *   1, 2 => 3          多个入参用逗号分隔，值是 JSON
 *   [1,2,1,3] => 3     一个数组入参（方括号内的逗号不算分隔）
 *   名字: 输入 => 期望   冒号前可选，给结果面板当用例名
 *   # 开头是注释
 */
export function parseCustomCases(text: string): ParsedCases {
  const cases: CustomCase[] = [];
  const errors: ParsedCases['errors'] = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const no = index + 1;
    if (!line || line.startsWith('#')) return;
    const arrow = line.indexOf('=>');
    if (arrow < 0) {
      errors.push({ line: no, msg: '缺少 =>（应为「输入 => 期望」）' });
      return;
    }
    let left = line.slice(0, arrow).trim();
    let name: string | undefined;

    const colon = splitTopLevel(left, ':').length > 1 ? left.indexOf(':') : -1;
    if (colon > 0) {
      name = left.slice(0, colon).trim();
      left = left.slice(colon + 1).trim();
    }

    const inputTokens = left.length === 0 ? [] : splitTopLevel(left, ',');
    const input: unknown[] = [];
    for (const token of inputTokens) {
      const parsed = parseValue(token);
      if (parsed.error) {
        errors.push({ line: no, msg: `输入 "${token.trim()}" 不是合法 JSON：${parsed.error}` });
        return;
      }
      input.push(parsed.value);
    }

    const expected = parseValue(line.slice(arrow + 2));
    if (expected.error) {
      errors.push({ line: no, msg: `期望值不是合法 JSON：${expected.error}` });
      return;
    }
    cases.push({ input, expected: expected.value, ...(name ? { name } : {}) });
  });

  return { cases, errors };
}

/** 按分隔符切，但跳过引号与括号内部。 */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      current += ch;
      if (ch === '\\') current += text[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    if (ch === ']' || ch === '}' || ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseValue(token: string): { value?: unknown; error?: string } {
  const text = token.trim();
  if (!text) return { error: '空值' };
  // 允许裸字符串（不带引号）与 JS 风格数组元素，但先按 JSON 试
  try {
    return { value: JSON.parse(text) };
  } catch {
    /* 继续按宽松形式处理 */
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return { value: Number(text) };
  if (text === 'null') return { value: null };
  if (text === 'true' || text === 'false') return { value: text === 'true' };
  // 单引号字符串与未加引号的标识符都当作字符串
  if (/^'.*'$/.test(text)) return { value: text.slice(1, -1) };
  if (/^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5 -]*$/.test(text)) return { value: text };
  return { error: `无法解析 "${text}"（请用 JSON：数字、"字符串"、[1,2]、null、true/false）` };
}
