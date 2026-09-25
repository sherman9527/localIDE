import type { CategoryId, WeekSummary } from '@arena/shared';
import { CATEGORY_IDS, CATEGORY_META } from '@arena/shared';

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const shortDate = (date: string): string => date.slice(5);

/**
 * 本周小结：雷达图回答"你整体是什么样"，这张卡回答"这一周怎么样、下一步先看哪类"。
 * 类别按正确率从低到高排 —— 该先看的排最前，不是按字母或按题量讨好地排。
 */
export default function WeekSummaryCard({ week }: { week: WeekSummary }) {
  const practiced: { id: CategoryId; answered: number; passed: number; accuracy: number }[] = CATEGORY_IDS.filter(
    (id) => week.byCategory[id] !== undefined,
  )
    .map((id) => ({ id, ...week.byCategory[id]! }))
    .sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered);
  const idle = week.answered === 0;

  return (
    <section className="card week-card" data-testid="week-card" aria-label="本周小结">
      <div className="card-head">
        <h3 className="card-title">本周</h3>
        <span className="spacer" />
        <span className="faint small">
          {shortDate(week.start)} ~ {shortDate(week.end)}
        </span>
      </div>

      {idle ? (
        <p className="muted small" data-testid="week-empty">
          这周还没开始。做完今天的套餐，这里就有内容了。
        </p>
      ) : (
        <>
          <p className="week-total">
            做了 <strong>{week.answered}</strong> 题 · 通过 <strong>{week.passed}</strong> · 计入{' '}
            <strong>{week.xp}</strong> XP
          </p>
          <div className="week-days">
            {week.days.map((day, index) => (
              <div
                key={day.date}
                className={`week-day${day.answered > 0 ? ' week-day-active' : ''}`}
                data-testid={`week-day-${day.date}`}
                aria-label={
                  day.answered > 0
                    ? `${day.date} 周${WEEKDAY_NAMES[index]}：做了 ${day.answered} 题，通过 ${day.passed} 题，${day.xp} XP`
                    : `${day.date} 周${WEEKDAY_NAMES[index]}：没做`
                }
              >
                <span className="week-day-name" aria-hidden="true">
                  {WEEKDAY_NAMES[index]}
                </span>
                <span className="week-day-count" aria-hidden="true">
                  {day.answered > 0 ? day.answered : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="tiny faint">
            "计入 XP"与顶部累计同一口径（每题只算最好那次，所以本周不会大于累计）；格子里是当天的提交次数。
          </p>

          {practiced.length > 0 ? (
            <ul className="week-cats">
              {practiced.map((item) => (
                <li key={item.id} className="week-cat" data-testid={`week-cat-${item.id}`} data-category={item.id}>
                  <span>{CATEGORY_META[item.id].label}</span>
                  <span className="spacer" />
                  <span className="muted small">
                    {pct(item.accuracy)}（{item.answered} 题）
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {week.weakest ? (
            <p className="faint small" data-testid="week-weakest">
              这周最弱的是 {CATEGORY_META[week.weakest.category].label}：{pct(week.weakest.accuracy)}，
              {week.weakest.answered} 题里过了 {week.weakest.passed} 题 —— 它会先进错题本等你。
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
