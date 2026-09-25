import { describe, expect, it } from 'vitest';
import type { JudgeResult, RubricVerdict } from '../src/judge.js';
import {
  ATTEMPT_DETAIL_BUDGET_BYTES,
  detailFromGrade,
  detailFromJudge,
  parseAttemptDetail,
  serializeAttemptDetail,
} from '../src/attempt.js';

const judgeResult = (over: Partial<JudgeResult>): JudgeResult => ({
  status: 'fail',
  passed: 1,
  failed: 1,
  total: 2,
  failedCases: [{ name: '空输入', passed: false, expected: '[]', actual: '抛异常 NullPointerException', message: 'boom' }],
  passedCases: ['常规输入'],
  durationMs: 1200,
  ...over,
});

const verdict = (over: Partial<RubricVerdict>): RubricVerdict => ({
  score: 6,
  maxScore: 10,
  bonus: ['提到了反压'],
  gaps: ['没说要怎么保证 exactly-once'],
  rubricBreakdown: [
    { label: '说清 checkpoint 机制', hit: true, earned: 3 },
    { label: '说明状态后端取舍', hit: false, earned: 0, nextStep: '补一句 RocksDB vs 内存的差别' },
  ],
  provider: 'qodercli',
  durationMs: 8000,
  raw: '{}',
  ...over,
});

describe('detailFromJudge — 代码题留档（N-05）', () => {
  it('失败用例带上期望/实际/报错，通过用例只留名字', () => {
    const detail = detailFromJudge(judgeResult({}), 'class Solution {}');
    expect(detail.kind).toBe('judge');
    expect(detail.failedCases?.[0]).toMatchObject({ name: '空输入', passed: false });
    expect(detail.failedCases?.[0]?.actual).toContain('NullPointerException');
    expect(detail.passedCaseNames).toEqual(['常规输入']);
  });

  it('提交正文与判题日志都进档；errorKind 带上才能复盘"挂在编译还是挂在用例"', () => {
    const detail = detailFromJudge(judgeResult({ errorKind: 'compile', logs: 'Main.java:3: error: ; expected' }), 'bad code');
    expect(detail.errorKind).toBe('compile');
    expect(detail.logs).toContain('; expected');
    expect(detail.submission).toBe('bad code');
  });

  it('全对的提交也留档（复盘时要能看到"哪次是一次过的"）', () => {
    const detail = detailFromJudge(
      judgeResult({ status: 'pass', failed: 0, failedCases: [], passedCases: ['a', 'b'] }),
      'ok',
    );
    expect(detail.failedCases).toEqual([]);
    expect(detail.passedCaseNames).toEqual(['a', 'b']);
  });
});

describe('detailFromGrade — 主观题留档（N-05）', () => {
  it('逐评分点命中情况、加分项、不足项都进档', () => {
    const detail = detailFromGrade(verdict({}), '我的答案……');
    expect(detail.kind).toBe('grade');
    expect(detail.rubric).toHaveLength(2);
    expect(detail.rubric?.[1]).toMatchObject({ hit: false, nextStep: '补一句 RocksDB vs 内存的差别' });
    expect(detail.gaps).toEqual(['没说要怎么保证 exactly-once']);
    expect(detail.provider).toBe('qodercli');
    expect(detail.submission).toBe('我的答案……');
  });
});

describe('serializeAttemptDetail / parseAttemptDetail', () => {
  it('往返一致：写出去读回来形状不变', () => {
    const detail = detailFromJudge(judgeResult({}), 'x = 1');
    expect(parseAttemptDetail(serializeAttemptDetail(detail))).toEqual(detail);
  });

  it('再大的输入也不会超过体积预算', () => {
    const huge = detailFromJudge(
      judgeResult({
        errorKind: 'runtime',
        logs: 'traceback\n'.repeat(5000),
        failedCases: Array.from({ length: 60 }, (_, i) => ({
          name: `用例${i}`,
          passed: false,
          expected: 'e'.repeat(2000),
          actual: 'a'.repeat(2000),
          message: 'm'.repeat(2000),
        })),
        passedCases: Array.from({ length: 60 }, (_, i) => `通过${i}`),
      }),
      'class Big { void f() {} }'.repeat(2000),
    );
    const json = serializeAttemptDetail(huge);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(ATTEMPT_DETAIL_BUDGET_BYTES);
    const back = parseAttemptDetail(json);
    // 超预算时先丢日志，正文必须还在（但要标出被截断过）
    expect(back?.logs).toBeUndefined();
    expect(back?.submission).toBeTruthy();
    expect(back?.submissionChars).toBeGreaterThan(String(back?.submission).length);
    // 失败用例的名字不能丢，否则"挂在哪"这条需求就废了
    expect(back?.failedCases?.length).toBeGreaterThan(0);
    expect(back?.failedCases?.[0]?.name).toBeTruthy();
  });

  it('中文按字节裁剪，不能裁出半个字符', () => {
    const detail = detailFromJudge(judgeResult({}), '链'.repeat(4000));
    const back = parseAttemptDetail(serializeAttemptDetail(detail));
    expect(back?.submission).toBeDefined();
    expect(back?.submission).not.toContain('\uFFFD');
    expect(Buffer.byteLength(String(back?.submission), 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('读侧宽容：null / 坏 JSON / 不认识的版本都当"没有留档"，不抛', () => {
    expect(parseAttemptDetail(null)).toBeNull();
    expect(parseAttemptDetail('')).toBeNull();
    expect(parseAttemptDetail('not json')).toBeNull();
    expect(parseAttemptDetail('{"v":99,"kind":"judge"}')).toBeNull();
    expect(parseAttemptDetail('{"v":1}')).toBeNull();
    expect(parseAttemptDetail('[]')).toBeNull();
  });
});
