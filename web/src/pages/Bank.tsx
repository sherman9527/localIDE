import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BankRow, CategoryId } from '@arena/shared';
import { CATEGORY_LIST, TAG_FACET_MIN_COUNT, isCategoryId } from '@arena/shared';
import { api } from '../api';
import { errorMessage } from '../lib/errors';
import { useAsync, useDebounced } from '../lib/hooks';
import { Badge, Empty, ErrorState, Loading } from '../components/AsyncState';
import { DIFFICULTY_LABEL, JUDGE_KIND_LABEL, accentOf, isSubjective } from '../lib/format';
import { navigate } from '../router';

type CategoryFilter = CategoryId | 'all';

/** 题库浏览：筛选状态只活在这个组件里，不会污染今日挑战（web-client spec）。 */
export default function Bank({ initialCategory }: { initialCategory?: string | null }) {
  const [category, setCategory] = useState<CategoryFilter>(() =>
    initialCategory && isCategoryId(initialCategory) ? initialCategory : 'all',
  );
  const [difficulty, setDifficulty] = useState<'all' | 'senior' | 'principal'>('all');
  const [tag, setTag] = useState('all');
  /** 'all' | 公司名 | '(none)'（早期按类别出的那批没有公司标签，必须还能被筛出来） */
  const [company, setCompany] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [extraHidden, setExtraHidden] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const debouncedKeyword = useDebounced(keyword, 150);
  const needle = debouncedKeyword.trim();

  /**
   * 整表一次拉回、除关键词外全在客户端筛（切换类别/标签零延迟，这是有意的设计）。
   * 关键词例外：列表响应里没有题面正文（N-15），所以那一路得回服务端问 ——
   * useAsync 在重取期间保留上一批结果，所以不会出现"输入时整页闪一下"。
   */
  const { data, loading, error, reload } = useAsync(
    (signal) => api.bank({ includeHidden: true, ...(needle ? { q: needle } : {}) }, { signal }),
    [needle],
  );
  const refreshing = loading && Boolean(data);

  const hiddenIds = useMemo(() => {
    const set = new Set(data?.hiddenIds ?? []);
    for (const id of extraHidden) set.add(id);
    return set;
  }, [data, extraHidden]);

  /** 下拉的候选来自服务端的**全库**统计，不是当前筛选结果 —— 否则一搜索选项就自己缩水。 */
  const tags = data?.tags ?? [];
  const tagTotal = data?.tagCount ?? 0;
  const companies = data?.companies ?? [];
  const unlabeled = data?.unlabeled ?? 0;

  const rows = useMemo(() => {
    const list: BankRow[] = [];
    for (const q of data?.rows ?? []) {
      if (category !== 'all' && q.category !== category) continue;
      if (difficulty !== 'all' && q.difficulty !== difficulty) continue;
      if (tag !== 'all' && !q.tags.includes(tag)) continue;
      if (company === '(none)' ? Boolean(q.company) : company !== 'all' && q.company !== company) continue;
      if (hiddenIds.has(q.id) && !showHidden) continue;
      list.push(q);
    }
    return list;
  }, [data, category, difficulty, tag, company, showHidden, hiddenIds]);

  const toggleHide = useCallback(async (question: BankRow, hide: boolean) => {
    setBusyId(question.id);
    setActionError(null);
    try {
      if (hide) {
        await api.hide(question.id);
        setExtraHidden((prev) => new Set(prev).add(question.id));
      } else {
        await api.unhide(question.id);
        setExtraHidden((prev) => {
          const next = new Set(prev);
          next.delete(question.id);
          return next;
        });
      }
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  if (loading && !data) return <Loading label="正在读题库…" cards={3} />;
  if (!data) {
    if (error) return <ErrorState title="题库加载失败" reason={error} onRetry={reload} />;
    return <Loading label="正在读题库…" cards={3} />;
  }

  const visibleHiddenCount = [...hiddenIds].length;

  return (
    <div>
      <div className="page-head">
        <h2>题库</h2>
        <span className="muted small">
          共 {data.rows.length} 题{visibleHiddenCount ? ` · 已移除 ${visibleHiddenCount} 题` : ''}
          {needle ? ` · 搜索「${needle}」` : ''}
          {refreshing ? ' · 更新中…' : ''}
        </span>
        <span className="spacer" />
        <label className="switch">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          显示已移除
        </label>
      </div>

      <section className="card filters" aria-label="题库筛选">
        <label className="col tiny">
          类别
          <select value={category} onChange={(e) => setCategory(e.target.value as CategoryFilter)} aria-label="按类别筛选">
            <option value="all">全部类别</option>
            {CATEGORY_LIST.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="col tiny">
          公司
          <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="按公司筛选">
            <option value="all">全部公司</option>
            {companies.map(({ name, count }) => (
              <option key={name} value={name}>
                {name}（{count}）
              </option>
            ))}
            {unlabeled > 0 ? (
              <option value="(none)">未标公司（{unlabeled}）</option>
            ) : null}
          </select>
        </label>
        <label className="col tiny">
          难度
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as 'all' | 'senior' | 'principal')}
            aria-label="按难度筛选"
          >
            <option value="all">全部难度</option>
            <option value="senior">senior</option>
            <option value="principal">principal</option>
          </select>
        </label>
        <label className="col tiny">
          标签
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="按标签筛选">
            <option value="all">全部标签</option>
            {tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}（{t.count}）
              </option>
            ))}
          </select>
        </label>
        <label className="col tiny" style={{ flex: '1 1 220px' }}>
          关键词
          <input
            type="search"
            value={keyword}
            placeholder="标题 / 题面 / 公司"
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="按关键词搜索题库"
          />
        </label>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setCategory('all');
            setDifficulty('all');
            setTag('all');
            setCompany('all');
            setKeyword('');
          }}
        >
          清空筛选
        </button>
        {/*
          挡住的是下拉的位置，不是题目：稀有标签照样能用关键词搜到（服务端 haystack 含 tags）。
          这一句必须放在这一行的**外面**：它原先长在标签那一列里，把那一列撑高一行，
          `align-items: center` 就把整个标签控件顶得比旁边几个高（用户截图指的就是这个）。
        */}
        {tagTotal > tags.length && (
          <p className="tiny muted" data-testid="bank-tag-hint">
            标签只列出现 ≥{TAG_FACET_MIN_COUNT} 次的 {tags.length} 个；另有 {tagTotal - tags.length} 个只出现一两次，
            在"关键词"里搜得到
          </p>
        )}
      </section>

      {error ? (
        <div className="banner banner-warning" role="status">
          这一次没取到（{error}），下面显示的是上一次的结果。
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}
      {actionError ? <ErrorState title="操作没生效" reason={actionError} /> : null}

      <h3 className="section-title">
        {rows.length} 题
        {category !== 'all' || difficulty !== 'all' || tag !== 'all' || company !== 'all' || debouncedKeyword
          ? '（筛选后）'
          : ''}
      </h3>
      {rows.length === 0 ? (
        <Empty
          title="没有符合条件的题"
          hint={needle ? '换个关键词，或者清空筛选试试。' : '换个类别或清空筛选试试。'}
        />
      ) : (
        <ul className="bank-list">
          {rows.map((question) => {
            const isHidden = hiddenIds.has(question.id);
            return (
              <li key={question.id} className={isHidden ? 'bank-row is-hidden' : 'bank-row'}>
                <span className="row">
                  <span className="swatch" style={{ background: accentOf(question.category) } as CSSProperties} />
                </span>
                <span className="bank-body">
                  <button type="button" className="bank-title" onClick={() => navigate(`/q/${question.id}`)}>
                    {question.title}
                  </button>
                  <span className="row-wrap row tiny muted">
                    <Badge>{DIFFICULTY_LABEL[question.difficulty]}</Badge>
                    <Badge>{JUDGE_KIND_LABEL[question.judgeKind]}</Badge>
                    <Badge>{isSubjective(question) ? '主观题' : `${question.caseCount} 个用例`}</Badge>
                    {question.company ? <Badge tone="warning">{question.company}</Badge> : null}
                    {question.tags.slice(0, 4).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    {isHidden ? <Badge tone="danger">已移除</Badge> : null}
                  </span>
                </span>
                <button
                  type="button"
                  className={isHidden ? 'btn btn-sm' : 'btn btn-sm btn-danger'}
                  disabled={busyId === question.id}
                  onClick={() => void toggleHide(question, !isHidden)}
                  aria-label={isHidden ? `恢复 ${question.title}` : `移除 ${question.title}`}
                >
                  {busyId === question.id ? '处理中…' : isHidden ? '恢复' : '移除'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
