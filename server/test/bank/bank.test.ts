import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hide, loadHidden, unhide } from '../../src/bank/hide.js';
import { ingest, statementHash } from '../../src/bank/ingest.js';
import { loadBank, visibleQuestions } from '../../src/bank/loader.js';
import type { Question } from '@arena/shared';

let dir: string;
let hiddenFile: string;

const draftOf = (over: Partial<Question> = {}) =>
  ({
    id: 'alg-java-0001',
    category: 'algorithms',
    difficulty: 'senior',
    title: '定位最长无重复 user_id 的连续事件区间',
    statement: '给定按时间排序的事件流，找出最长连续区间使区间内 user_id 不重复，用 Java 实现。',
    judgeKind: 'java-junit',
    tags: ['sliding-window'],
    cases: [
      { name: '空输入返回 0', input: [], expected: 0 },
      { name: '全不重复', input: [1, 2, 3], expected: 3 },
      { name: '中间重复', input: [1, 2, 1, 3], expected: 3 },
    ],
    runner: { referenceSolution: 'class Solution{}', className: 'Solution' },
    source: { origin: 'manual', jds: [], era: '2026' },
    ...over,
  }) as unknown as Parameters<typeof ingest>[0][number];

beforeEach(async () => {
  // 临时目录也留在仓库内（rule.md C1：产物不出本目录）
  const base = join(process.cwd(), 'data', 'test-tmp');
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, 'bank-'));
  hiddenFile = join(dir, 'hidden.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadBank', () => {
  it('空目录返回空题库而不报错', async () => {
    const bank = await loadBank(dir);
    expect(bank.questions).toEqual([]);
    expect(bank.errors).toEqual([]);
  });

  it('一个坏文件不影响其它题目加载（题库可持续刷新的前提）', async () => {
    await mkdir(join(dir, 'algorithms'), { recursive: true });
    await mkdir(join(dir, 'frontend'), { recursive: true });
    await writeFile(join(dir, 'algorithms', 'bad.json'), '{ not json');
    await writeFile(join(dir, 'frontend', 'empty.json'), '[]');
    const bank = await loadBank(dir);
    expect(bank.errors).toHaveLength(1);
    expect(bank.errors[0]!.file).toContain('bad.json');
  });

  it('题库目录里的 hidden.json 不被当题目解析', async () => {
    await ingest([draftOf()], { dir, hiddenFile });
    await hide('alg-java-0001', { file: hiddenFile });
    const bank = await loadBank(dir);
    expect(bank.errors).toEqual([]);
    expect(bank.questions).toHaveLength(1);
  });

  it('重复 id 视为错误而不是静默覆盖', async () => {
    const res = await ingest([draftOf(), draftOf()], { dir, hiddenFile });
    expect(res.added).toHaveLength(1);
    expect(res.skippedDuplicate[0]?.reason).toBe('duplicate-id');
    const bank = await loadBank(dir);
    expect(bank.questions).toHaveLength(1);
  });
});

describe('ingest — append-only（需求 场景 9）', () => {
  it('目标文件已存在但 loader 不认它（坏文件）→ 记 rejected，绝不谎报 added', async () => {
    await mkdir(join(dir, 'algorithms'), { recursive: true });
    await writeFile(join(dir, 'algorithms', 'alg-java-0001.json'), JSON.stringify({ id: 'alg-java-0001', difficulty: 'junior' }));
    const res = await ingest([draftOf({ statement: '需要在线性时间内合并区间并返回结果，注意空输入与边界。' })], { dir, hiddenFile });
    expect(res.added).toHaveLength(0);
    expect(res.rejected.at(-1)?.id).toBe('alg-java-0001');
    expect(String(res.rejected.at(-1)?.errors)).toContain('已存在');
  });

  it('入库补齐 ingestedAt 并按类别落文件', async () => {
    const res = await ingest([draftOf()], { dir, hiddenFile });
    expect(res.added).toHaveLength(1);
    const raw = JSON.parse(await readFile(join(dir, 'algorithms', 'alg-java-0001.json'), 'utf8'));
    expect(typeof raw.source.ingestedAt).toBe('string');
    expect(raw.source.ingestedAt.length).toBeGreaterThan(8);
  });

  it('缺 id 的草稿自动生成可排序 id', async () => {
    const draft = draftOf();
    delete (draft as { id?: string }).id;
    const res = await ingest([draft], { dir, hiddenFile });
    expect(res.added[0]?.id).toMatch(/^alg-java-\d{4}$/);
  });

  it('题面归一化后相同视为重复题（防刷新产生近似重复）', () => {
    const a = statementHash('给定 事件流， 找最长区间');
    const b = statementHash('  给定 事件流,找最长区间  ');
    expect(a).toBe(b);
  });

  it('两次刷新：只增不减，且不覆盖已有文件', async () => {
    await ingest([draftOf()], { dir, hiddenFile });
    const before = await readFile(join(dir, 'algorithms', 'alg-java-0001.json'), 'utf8');
    const second = await ingest([draftOf(), draftOf({ id: 'alg-java-0002', statement: '另一道题，要求在线性时间内完成区间合并并返回合并结果。' })], {
      dir,
      hiddenFile,
    });
    expect(second.added).toHaveLength(1);
    expect(second.skippedDuplicate).toHaveLength(1);
    expect(await readFile(join(dir, 'algorithms', 'alg-java-0001.json'), 'utf8')).toBe(before);
    const bank = await loadBank(dir);
    expect(bank.questions.length).toBeGreaterThanOrEqual(2);
  });

  it('结构非法的草稿被拒绝而不是写坏文件', async () => {
    const bad = draftOf({ difficulty: 'junior' as never });
    const res = await ingest([bad], { dir, hiddenFile });
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.errors.join(' ')).toContain('difficulty');
    const bank = await loadBank(dir);
    expect(bank.questions).toHaveLength(0);
  });
});

describe('hide — 软删除（需求 场景 10）', () => {
  it('hide 后题目从可见题库消失，但文件仍在', async () => {
    await ingest([draftOf()], { dir, hiddenFile });
    await hide('alg-java-0001', { file: hiddenFile, reason: '已掌握' });
    const visible = await visibleQuestions({ dir, hiddenFile });
    expect(visible.map((q) => q.id)).not.toContain('alg-java-0001');
    const bank = await loadBank(dir);
    expect(bank.questions).toHaveLength(1);
    const hidden = await loadHidden(hiddenFile);
    expect(hidden.items[0]).toMatchObject({ id: 'alg-java-0001', reason: '已掌握' });
  });

  it('hide 幂等，unhide 可恢复', async () => {
    await ingest([draftOf()], { dir, hiddenFile });
    await hide('alg-java-0001', { file: hiddenFile });
    await hide('alg-java-0001', { file: hiddenFile });
    expect((await loadHidden(hiddenFile)).items).toHaveLength(1);
    await unhide('alg-java-0001', { file: hiddenFile });
    expect((await visibleQuestions({ dir, hiddenFile })).map((q) => q.id)).toContain('alg-java-0001');
  });

  it('hidden.json 缺失时按空集合处理（首次运行不崩）', async () => {
    await expect(loadHidden(join(dir, 'nope.json'))).resolves.toEqual({ version: 1, items: [] });
  });

  it('hidden.json 是合法 JSON 但形状不对 → 留证据并拒绝再写，绝不静默清空软删除账本', async () => {
    await writeFile(hiddenFile, '[{"id":"alg-java-0001"}]', 'utf8'); // 根是数组：读得出 JSON，读不出条目
    await expect(hide('sql-mysql-0001', { file: hiddenFile })).rejects.toThrow(/hidden\.json/);
    expect(await readFile(hiddenFile, 'utf8')).toBe('[{"id":"alg-java-0001"}]');
    const backups = await readdir(dirname(hiddenFile));
    expect(backups.some((name) => name.includes('hidden.json.corrupt-'))).toBe(true);
  });

  it('自己写出来的"空账本"不算损坏：恢复完最后一题后仍能继续移除', async () => {
    // saveHidden 写的是带缩进的 JSON + 结尾换行；守卫若拿紧凑字面量比对，
    // 空账本就会被判成"读不出条目" → 每次读都留一个 .corrupt 备份，之后 hide/unhide 全部抛错。
    await ingest([draftOf()], { dir, hiddenFile });
    await hide('alg-java-0001', { file: hiddenFile });
    await unhide('alg-java-0001', { file: hiddenFile });

    const raw = await readFile(hiddenFile, 'utf8');
    expect(raw).not.toContain('"items":[]'); // 确实是多行形态，不是紧凑单行

    const loaded = await loadHidden(hiddenFile);
    expect(loaded).toEqual({ version: 1, items: [] });
    await expect(hide('alg-java-0001', { file: hiddenFile })).resolves.toMatchObject({
      items: [{ id: 'alg-java-0001' }],
    });
    const names = await readdir(dirname(hiddenFile));
    expect(names.filter((n) => n.includes('hidden.json.corrupt-'))).toEqual([]);
  });

  it('空账本反复读也不会生成备份文件', async () => {
    await writeFile(hiddenFile, '{\n  "version": 1,\n  "items": []\n}\n', 'utf8');
    await loadHidden(hiddenFile);
    await loadHidden(hiddenFile);
    const names = await readdir(dirname(hiddenFile));
    expect(names.filter((n) => n.includes('hidden.json.corrupt-'))).toEqual([]);
  });
});
