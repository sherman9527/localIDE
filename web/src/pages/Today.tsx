import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CategorySummary, StackHealth, TodayResponse } from '@arena/shared';
import { CATEGORY_LIST, DAILY_PLAN, DAILY_STREAK_THRESHOLD_XP, XP_RULES } from '@arena/shared';
import { api } from '../api';
import { useAsync } from '../lib/hooks';
import { Empty, ErrorState, Loading, Badge } from '../components/AsyncState';
import { dateLabel, isSubjective, questionsToStreak, stackState } from '../lib/format';
import { navigate, toHref } from '../router';

interface TodayData {
  today: TodayResponse;
  progress: Awaited<ReturnType<typeof api.progress>> | null;
  byCategory: Map<string, CategorySummary>;
  health: StackHealth | null;
}

export default function Today() {
  const { data, loading, error, reload } = useAsync<TodayData>(async (signal) => {
    const [today, progress, categories, health] = await Promise.allSettled([
      api.today(undefined, { signal }),
      api.progress({ signal }),
      api.categories({ signal }),
      api.health({ signal }),
    ]);
    if (today.status === 'rejected') throw today.reason;
    return {
      today: today.value,
      progress: progress.status === 'fulfilled' ? progress.value : null,
      byCategory: new Map((categories.status === 'fulfilled' ? categories.value.categories : []).map((c) => [c.id, c])),
      health: health.status === 'fulfilled' ? health.value : null,
    };
  }, []);

  const set = useMemo(() => {
    if (!data) return null;
    const total = data.today.plan.main.count + data.today.plan.side.count;
    const answered = Math.min(data.today.progress.answered, total);
    return {
      total,
      answered,
      xpToday: data.today.progress.xpToday,
      streakSafe: data.today.progress.streakSafe,
      streakDays: data.progress?.streakDays ?? null,
      // 完成态只认服务端权威值：answered 是"作答过"，答错也算；用它判"已完成"会谎报奖励已发放
      done: data.progress?.today.done ?? false,
      ratio: total === 0 ? 0 : answered / total,
    };
  }, [data]);

  if (loading && !data) return <Loading label="正在取今天的题…" cards={2} />;
  if (error) return <ErrorState title="今日挑战加载失败" reason={error} onRetry={reload} />;
  if (!data || !set) return <Loading label="正在取今天的题…" cards={2} />;

  const { today, byCategory, health } = data;
  const main = CATEGORY_LIST.find((c) => c.id === today.plan.main.category);
  const side = CATEGORY_LIST.find((c) => c.id === today.plan.side.category);
  const answeredIds = new Set(data.progress?.today.answered ?? []);
  const passedIds = new Set(data.progress?.today.passed ?? []);
  const gap = questionsToStreak(set.xpToday, DAILY_STREAK_THRESHOLD_XP, XP_RULES.pass);
  // 主菜 / 副菜分成两个 flex 组：宽度与左边条都表达"今天哪一栈是主菜"
  // 分组按槽位顺序，不按类别：复习题可能来自别的类别，按类别分会把它错填进"副菜"
  const mainQs = today.questions.slice(0, today.plan.main.count);
  const sideQs = today.questions.slice(today.plan.main.count);
  const reviewIds = new Set(today.reviewIds ?? []);

  return (
    <div>
      <section aria-label="今日套餐">
        <div className="today-hero">
          <h2 className="hero-date">今日挑战 · {dateLabel(today.date)}</h2>
          <p className="hero-sub">
            <span>
              主栈 <b>{main?.label ?? today.plan.main.category}</b> {today.plan.main.count} 道代码题
              {mainQs.some((q) => reviewIds.has(q.id)) ? (
                <span className="muted">（其中 {mainQs.filter((q) => reviewIds.has(q.id)).length} 道是复习）</span>
              ) : null}
            </span>
            <span>
              副栈 <b>{side?.label ?? today.plan.side.category}</b> {today.plan.side.count} 道主观题
            </span>
            <span>目标约 {DAILY_PLAN.targetMinutes} 分钟</span>
            {today.plan.main.reason !== 'default' ? (
              <span className="muted" data-testid="adaptive-hint">
                {today.plan.main.reason === 'adaptive-low'
                  ? `最近正确率偏低，今天主栈降到 ${today.plan.main.count} 题`
                  : `最近稳定全对，今天主栈加到 ${today.plan.main.count} 题`}
              </span>
            ) : null}
          </p>
          <div className="hero-metrics" data-testid="set-progress">
            <span>
              完成 {set.answered}/{set.total}
            </span>
            <span>今日 XP {set.xpToday}</span>
            <span>{set.streakDays === null ? '连续 — 天' : `连续 ${set.streakDays} 天`}</span>
          </div>
        </div>
        <div className="meter" aria-hidden="true">
          <i style={{ '--ratio': set.ratio } as CSSProperties} />
        </div>
        <div className="row row-wrap" style={{ marginTop: 'var(--space-3)' }}>
          {set.done ? (
            <div className="banner banner-success banner-inline" data-testid="today-done">
              <strong>今日已完成</strong>
              <span className="small">套餐奖励已计入 XP，明天见。</span>
            </div>
          ) : null}
          {set.streakSafe ? (
            <div className="banner banner-primary banner-inline">
              <strong>今日 XP 已够续签</strong>
              <span className="small">再做题只加 XP，不会掉签。</span>
            </div>
          ) : (
            <div className="banner banner-inline">
              <strong>再完成 {gap} 题即可续签</strong>
              <span className="small">续签门槛是当日 XP {DAILY_STREAK_THRESHOLD_XP}，只做 1 题不够。</span>
            </div>
          )}
        </div>
      </section>

      <h3 className="section-title">今日套餐的 {today.questions.length} 道题</h3>
      {today.questions.length === 0 ? (
        <Empty
          title="今天没有可出的题"
          hint="题库可能还没刷新，或这个类别的题都被移除了。去题库看看可用题。"
          action={
            <a className="btn btn-sm" href={toHref('/bank')}>
              打开题库
            </a>
          }
        />
      ) : (
        <div className="plan-row">
          {(
            [
              ['main', '主菜', '代码题', mainQs],
              ['side', '副菜', '主观题', sideQs],
            ] as const
          )
            .filter(([, , , items]) => items.length > 0)
            .map(([role, label, kind, items]) => (
              <ul className="plan-list plan-group" data-role={role} key={role}>
                <li className="plan-group-head">
                  <span>{label}</span>
                  <span className="tiny">
                    {kind} {items.length} 道
                  </span>
                </li>
                {items.map((question) => {
                  const meta = CATEGORY_LIST.find((c) => c.id === question.category);
                  const state = passedIds.has(question.id) ? '已通过' : answeredIds.has(question.id) ? '已作答' : '未开始';
                  return (
                    <li key={question.id}>
                      <button
                        type="button"
                        className="plan-item"
                        style={{ '--cat-accent': meta?.accent } as CSSProperties}
                        data-testid="plan-item"
                        onClick={() => navigate(`/q/${question.id}`)}
                      >
                        <span className="plan-body">
                          {/* title 是给窄屏省略号兜底的：标题被裁时 hover 至少能看到全文 */}
                          <span className="plan-title" title={question.title}>{question.title}</span>
                          <span className="row-wrap row tiny muted">
                            <span className="swatch" aria-hidden="true" />
                            {meta?.label ?? question.category}
                            <Badge>{question.difficulty}</Badge>
                            {reviewIds.has(question.id) ? <Badge tone="primary">复习</Badge> : null}
                            <Badge>{isSubjective(question) ? '主观题' : `${question.cases?.length ?? 0} 个用例`}</Badge>
                          </span>
                        </span>
                        <Badge tone={state === '已通过' ? 'success' : state === '已作答' ? 'primary' : 'plain'}>{state}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      )}

      <h3 className="section-title">按类别刷</h3>
      <div className="cat-strip">
        {CATEGORY_LIST.map((meta) => {
          const summary = byCategory.get(meta.id);
          const stack = stackState(meta.id, health);
          const planned =
            today.plan.main.category === meta.id
              ? `今日主栈 ${today.plan.main.count} 题`
              : today.plan.side.category === meta.id
                ? `今日副栈 ${today.plan.side.count} 题`
                : null;
          const available = summary ? Math.max(summary.total - summary.hidden, 0) : null;
          return (
            <a
              key={meta.id}
              className="cat-chip"
              data-testid="category-card"
              data-category={meta.id}
              style={{ '--cat-accent': meta.accent } as CSSProperties}
              href={toHref(`/bank?category=${meta.id}`)}
            >
              <span className="cat-chip-row">
                <span className="swatch" aria-hidden="true" />
                <span className="cat-name">{meta.label}</span>
                {available !== null ? <span className="cat-count">{available} 题可刷</span> : null}
              </span>
              <span className="cat-chip-row cat-chip-sub">
                <span className="cat-stack">{meta.stack}</span>
              </span>
              {planned || stack === 'down' || (summary && summary.hidden > 0) ? (
                <span className="cat-chip-row cat-chip-badges">
                  {planned ? <Badge tone="primary">{planned}</Badge> : null}
                  {stack === 'down' ? <Badge tone="danger">暂不可判分</Badge> : null}
                  {summary && summary.hidden > 0 ? <Badge tone="plain">已移除 {summary.hidden}</Badge> : null}
                </span>
              ) : null}
            </a>
          );
        })}
      </div>
    </div>
  );
}
