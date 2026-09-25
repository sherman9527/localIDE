import { useMemo } from 'react';
import { ACHIEVEMENTS, CATEGORY_LIST, LEAGUES } from '@arena/shared';
import { api } from '../api';
import { useAsync } from '../lib/hooks';
import { Badge, ErrorState, Loading } from '../components/AsyncState';
import { StackRadar } from '../components/StackRadar';
import WeekSummaryCard from '../components/WeekSummaryCard';
import { dateLabel, pct } from '../lib/format';

/** 30 天热力：浅底 + 主色渐深，格子数固定 30，不需要虚拟列表。 */
function heatColor(xp: number, maxXp: number): string {
  if (xp <= 0) return '#eff3f9';
  const ratio = maxXp <= 0 ? 0 : Math.min(1, Math.sqrt(xp / maxXp));
  const from = [239, 243, 249];
  const to = [59, 130, 246];
  const mix = from.map((f, i) => Math.round(f + ((to[i] ?? 246) - f) * ratio));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

export default function Progress() {
  const { data, loading, error, reload } = useAsync((signal) => api.progress({ signal }), []);

  const maxXp = useMemo(() => Math.max(10, ...(data?.calendar ?? []).map((d) => d.xp)), [data]);

  if (loading && !data) return <Loading label="正在读进度…" cards={2} />;
  if (error) return <ErrorState title="进度加载失败" reason={error} onRetry={reload} />;
  if (!data) return <Loading label="正在读进度…" cards={2} />;

  const nextXp = data.league.nextAt;
  const toNext = nextXp === null ? null : Math.max(nextXp - data.xp, 0);

  return (
    <div>
      <div className="page-head">
        <h2>进度</h2>
        <span className="muted small">段位与成就只读，不会改动题目难度</span>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <b>{data.xp}</b>
          <span>累计 XP</span>
        </div>
        <div className="stat">
          <b>{data.xpToday}</b>
          <span>今日 XP</span>
        </div>
        <div className="stat">
          <b>{data.streakDays}</b>
          <span>连续天数（最长 {data.streakLongest}）</span>
        </div>
        <div className="stat">
          <b>{data.league.label}</b>
          <span>
            当前段位{toNext === null ? ' · 已到顶' : ` · 距段位还需 ${toNext} XP`}
          </span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">段位阶梯</h3>
          <span className="spacer" />
          <span className="faint small">{nextXp === null ? '已是最高段位' : `下一段位 ${nextXp} XP`}</span>
        </div>
        <ol className="league-steps">
          {LEAGUES.map((league) => (
            <li key={league.id} className={league.id === data.league.id ? 'is-current' : undefined}>
              {league.label}
              <div className="tiny faint">{league.minXp}+ XP</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">成就</h3>
          <span className="spacer" />
          <span className="faint small">
            {data.achievements.filter((a) => a.unlocked).length}/{ACHIEVEMENTS.length} 已点亮
          </span>
        </div>
        <div className="grid grid-cards">
          {data.achievements.map((achievement) => (
            <div key={achievement.id} className={achievement.unlocked ? 'ach' : 'ach is-locked'}>
              <span className="ach-mark" aria-hidden="true">
                {achievement.unlocked ? '✓' : '·'}
              </span>
              <span>
                <strong>{achievement.label}</strong>
                <div className="small muted">{achievement.hint}</div>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">近 30 天</h3>
          <span className="spacer" />
          <span className="faint small">格子越蓝当日 XP 越高</span>
        </div>
        <div className="heat">
          {data.calendar.map((day) => (
            <span
              key={day.date}
              className="heat-cell"
              style={{ background: heatColor(day.xp, maxXp) }}
              data-tip={`${dateLabel(day.date)}：XP ${day.xp} · 答 ${day.answered} · 通过 ${day.passed}`}
              title={day.date}
              aria-label={`${dateLabel(day.date)}：XP ${day.xp}，答 ${day.answered} 题，通过 ${day.passed} 题`}
            />
          ))}
        </div>
      </section>

      <WeekSummaryCard week={data.week} />

      <section className="card" data-testid="review-card">
        <div className="card-head">
          <h3 className="card-title">错题本</h3>
          <span className="spacer" />
          <span className="faint small">错过的题按 1 / 3 / 7 / 14 / 30 / 60 天回到每日套餐</span>
        </div>
        {data.review.tracked === 0 ? (
          <p className="small muted">还没有待复习的题。答错或判失败的题会自动进这里。</p>
        ) : (
          <div className="row-wrap row tiny">
            <Badge tone="plain">在册 {data.review.tracked} 题</Badge>
            <Badge tone={data.review.dueToday > 0 ? 'primary' : 'plain'}>今日到期 {data.review.dueToday} 题</Badge>
            <Badge tone="plain">最久没碰 {data.review.oldestDays ?? 0} 天</Badge>
            <span className="faint tiny">复习会顶掉当天一个槽位，所以每天仍是 3 题。</span>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">按类别正确率</h3>
          <span className="spacer" />
          <span className="faint small">凹进去的那一角就是下一步</span>
        </div>
        <StackRadar
          points={CATEGORY_LIST.map((meta) => {
            const row = data.byCategory[meta.id];
            return { id: meta.id, label: meta.label, accuracy: row?.accuracy ?? 0, answered: row?.answered ?? 0 };
          })}
        />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">类别</th>
                <th scope="col">已答</th>
                <th scope="col">通过</th>
                <th scope="col">正确率</th>
                <th scope="col">XP</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_LIST.map((meta) => {
                const row = data.byCategory[meta.id];
                return (
                  <tr key={meta.id}>
                    <th scope="row">{meta.label}</th>
                    <td>{row?.answered ?? 0}</td>
                    <td>{row?.passed ?? 0}</td>
                    <td>{row ? pct(row.accuracy) : '—'}</td>
                    <td>{row?.xp ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
