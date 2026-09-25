import { describe, expect, it } from 'vitest';
import { loadBank } from '../../src/bank/loader.js';
import { config } from '../../src/config.js';

/**
 * 答案与用例备注里**写出来的算式**必须算得对（全库，不只某一家）。
 *
 * 为什么要有它：出题时最容易写错的就是"顺手手算一步"。
 * `100.00 + 120.50 + 99.99 + 250.00 = 570.49`、`(570.49 + 85.00) × 0.14 = 91.77`
 * 这类式子是给人核对用的中间步骤，它错了整道题的说服力就没了 —— 而判题矩阵永远不看文案。
 *
 * 三条"宁可少查，不许冤枉"的取舍：
 * - **整条链一起算**（`a + b + c = d`）。只取最后两项会把 `1+2+3=6` 看成 `2+3=6` 而误报；
 * - **加减混合乘除的链跳过**（没有优先级信息，判不了）；
 * - **除法只认写成小数的结果**：`11/12=2` 是"这两条 span ⇒ 深度 2"的散文记号不是除法，
 *   而 `3/6 = 50.00` 是百分数写法 —— 所以比率允许"小数 or ×100"两种解释，命中任一即算对。
 * 抽不到算式的题不受影响 —— 这条闸门只负责"写了就得对"。
 */
const bank = await loadBank(config.bankDir);

/**
 * 允许 `**粗体**` 包住结果，允许减号写成 U+2212。
 * 前面的 `(?<![A-Za-z_0-9])` 是"不许从标识符尾巴上起算"：`kucun0-0=100` 里的
 * 第一个 0 是列名的一部分，抓它会报出一条谁都没写过的伪等式。
 */
const EQUATION =
  /(?<![A-Za-z_0-9])(\d+(?:\.\d+)?(?:\s*[+\-−*×/]\s*\d+(?:\.\d+)?)+)\s*=\s*\*{0,2}(-?\d+(?:\.\d+)?)\*{0,2}/g;
const NUMBER_OR_OP = /\d+(?:\.\d+)?|[+\-−*×/]/g;

interface Claim {
  where: string;
  text: string;
  terms: number[];
  ops: string[];
  written: string;
}

function claimsFrom(where: string, text: string): Claim[] {
  const out: Claim[] = [];
  for (const m of text.matchAll(EQUATION)) {
    const lhs = m[1];
    const rhs = m[2];
    if (!lhs || !rhs) continue;
    const terms: number[] = [];
    const ops: string[] = [];
    for (const part of lhs.match(NUMBER_OR_OP) ?? []) {
      if (/^\d/.test(part)) terms.push(Number(part));
      else ops.push(part);
    }
    if (terms.length !== ops.length + 1) continue;         // 解析不出来就不下结论
    out.push({ where, text: m[0], terms, ops, written: rhs });
  }
  return out;
}

/** 写出来的那个数保留了几位小数（用来复现出题人的四舍五入）。 */
function decimals(written: string): number {
  const dot = written.indexOf('.');
  return dot < 0 ? 0 : written.length - dot - 1;
}

function within(exact: number, claim: Claim): boolean {
  const written = Number(claim.written);
  const places = decimals(claim.written);
  const scale = 10 ** places;
  return Math.abs(Math.round(exact * scale) / scale - written) < 1e-9
    || Math.abs(exact - written) < 0.5 / scale;
}

/** 返回 null 表示"这条判不了"（不是错，是不该由闸门下结论）。 */
function verdict(claim: Claim): 'ok' | 'wrong' | 'skip' {
  const additive = claim.ops.every((op) => op === '+' || op === '-' || op === '−');
  const multiplicative = claim.ops.every((op) => op === '*' || op === '×' || op === '/');
  if (!additive && !multiplicative) return 'skip';        // 混合优先级，没有括号信息
  if (claim.ops.includes('/') || claim.ops.includes('*') || claim.ops.includes('×')) {
    if (!claim.written.includes('.')) return 'skip';      // 整数结果的乘除多半是散文记号（`11/12=2`）
  }
  let acc = claim.terms[0] ?? 0;
  for (let i = 0; i < claim.ops.length; i += 1) {
    const next = claim.terms[i + 1] ?? 0;
    switch (claim.ops[i]) {
      case '+':
        acc += next;
        break;
      case '-':
      case '−':
        acc -= next;
        break;
      case '*':
      case '×':
        acc *= next;
        break;
      case '/':
        if (next === 0) return 'skip';
        acc /= next;
        break;
      default:
        return 'skip';
    }
  }
  if (within(acc, claim)) return 'ok';
  // 比率常被写成百分数：`3/6 = 50.00` 里的 50.00 是 ×100 的结果
  if ((claim.ops.includes('/') || claim.ops.includes('×') || claim.ops.includes('*')) && within(acc * 100, claim)) return 'ok';
  return 'wrong';
}

const allClaims = bank.questions.flatMap((q) => [
  ...claimsFrom(`${q.id} 答案`, q.answer ?? ''),
  ...claimsFrom(`${q.id} 题面`, q.statement ?? ''),
  ...(q.cases ?? []).flatMap((c) => claimsFrom(`${q.id} 用例「${c.name}」备注`, c.note ?? '')),
]);

describe('答案里的算式必须算得对（全库）', () => {
  it('确实扫到了算式（一条都没有等于这条闸门是空的）', () => {
    expect(allClaims.length).toBeGreaterThanOrEqual(10);
    console.log(`[算式] 全库扫到 ${allClaims.length} 条 a op b … = c 形式的等式`);
  });

  it('每条等式两边相等（比率允许百分数写法）', () => {
    const wrong = allClaims.filter((claim) => verdict(claim) === 'wrong');
    expect(
      wrong.map((c) => `${c.where}: ${c.text}`),
      `算错的等式：\n${wrong.map((c) => `  ${c.where}: ${c.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('判不了的（混合优先级、散文记号）必须很少，否则这条闸门在自我空转', () => {
    const skipped = allClaims.filter((claim) => verdict(claim) === 'skip');
    console.log(`[算式] 判不了而放过 ${skipped.length} 条：${skipped.map((c) => c.text).join(' | ')}`);
    expect(skipped.length).toBeLessThan(allClaims.length);
  });
});

/**
 * 解析器本身也要被门禁。它一旦把列名尾巴上的数字当成算式项，
 * 报出来的就是 `0-0=100` 这种伪等式 —— 而伪等式会让"改文案"变成"改不动"：
 * 出题人被一条自己没写过的算式绊住，下次就直接绕开这条闸门。
 */
describe('算式解析本身（不误抓标识符尾巴，也不漏抓真算式）', () => {
  it('列名以数字结尾时，不许把它尾巴上的 0 当成算式左端', () => {
    expect(claimsFrom('测试', '2001 账面 90 而 kucun0-0=100 ⇒ 仍报 ledger-mismatch')).toEqual([]);
    expect(claimsFrom('测试', '口径见 col2-3=9，不是算式')).toEqual([]);
  });

  it('正常写法的算式照样要抓到（否则上面那条"不许误抓"是靠不抓实现的）', () => {
    const hits = claimsFrom('测试', '净扣减按 0 算就是 100 − 0 − 90 = 10');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.terms).toEqual([100, 0, 90]);
    expect(hits[0]?.written).toBe('10');
  });
});
