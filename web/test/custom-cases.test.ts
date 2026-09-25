import { describe, expect, it } from 'vitest';
import { parseCustomCases, splitTopLevel } from '../src/lib/custom-cases';

describe('自测用例解析（一行一组）', () => {
  it('多入参按顶层逗号切分', () => {
    const { cases, errors } = parseCustomCases('1, 2 => 3');
    expect(errors).toEqual([]);
    expect(cases).toEqual([{ input: [1, 2], expected: 3 }]);
  });

  it('数组入参里的逗号不算分隔', () => {
    const { cases } = parseCustomCases('[1,2,1,3] => 3');
    expect(cases[0]?.input).toEqual([[1, 2, 1, 3]]);
    expect(cases[0]?.expected).toBe(3);
  });

  it('行首可给用例名', () => {
    const { cases } = parseCustomCases('空输入: [] => 0');
    expect(cases[0]).toMatchObject({ name: '空输入', input: [[]], expected: 0 });
  });

  it('字符串、null、布尔、负数、对象都能解析', () => {
    const { cases, errors } = parseCustomCases(['" paid " => "paid"', 'null => null', 'true => false', '-7 => 2', '{"a":1,"b":[2,3]} => 1'].join('\n'));
    expect(errors).toEqual([]);
    expect(cases.map((c) => c.input[0])).toEqual([' paid ', null, true, -7, { a: 1, b: [2, 3] }]);
    expect(cases.map((c) => c.expected)).toEqual(['paid', null, false, 2, 1]);
  });

  it('注释与空行被忽略', () => {
    const { cases, errors } = parseCustomCases('# 说明\n\n1 => 1\n');
    expect(errors).toEqual([]);
    expect(cases).toHaveLength(1);
  });

  it('缺 => 与坏 JSON 会指明行号（不静默丢用例）', () => {
    const { cases, errors } = parseCustomCases('1, 2\n@@@ => 3\n[1, => 2');
    expect(cases).toHaveLength(0);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(errors[0]!.msg).toContain('=>');
  });

  it('splitTopLevel 会跳过引号与括号内部', () => {
    expect(splitTopLevel('a, "b,c", [1,2], {x:","}', ',').map((s) => s.trim())).toEqual(['a', '"b,c"', '[1,2]', '{x:","}']);
  });
});
