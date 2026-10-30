import type { Question } from '../../pod-store';
import { itemTitle } from '../shared/items';
import { podName } from '../shared/podName';
import type { PodSummary, TimeSummary } from '../shared/types';
import { formatDuration } from './useActiveTime';

/**
 * Where the planning time went: today / this week / all time, a bar per day
 * for the last two weeks, and every pod broken down by item. Opened from the
 * stopwatch; time spent here doesn't count.
 */

const DAYS_SHOWN = 14;

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(date.getDate()).padStart(2, '0')}`;

/** The last `count` days ending on `today` ("YYYY-MM-DD"), oldest first. */
const lastDays = (today: string, count: number): string[] => {
  const [year, month, day] = today.split('-').map(Number);
  const end = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);

  return Array.from({ length: count }, (_unused, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (count - 1 - index));

    return dayKey(date);
  });
};

const weekday = (key: string): string => {
  const [year, month, day] = key.split('-').map(Number);

  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString(
    undefined,
    { weekday: 'short', day: 'numeric' }
  );
};

/** Short form for the chart labels: "1h 05m" / "12m" / "40s". */
const compact = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);

  if (ms < 60_000) {
    return ms === 0 ? '' : `${Math.round(ms / 1000)}s`;
  }

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
    : `${minutes}m`;
};

export const TimePage = ({
  time,
  todayMs,
  pods,
  questions,
  onOpenItem,
  onClose,
}: {
  time: TimeSummary | undefined;
  /** Today including time not yet reported. */
  todayMs: number;
  pods: PodSummary[];
  questions: Record<string, Question[]>;
  onOpenItem: (podId: string, qid: string) => void;
  onClose: () => void;
}) => {
  if (time === undefined) {
    return <p className="muted">No time recorded yet.</p>;
  }

  const days = lastDays(time.day, DAYS_SHOWN);
  const daily = days.map((key) => ({
    key,
    ms: key === time.day ? todayMs : time.days[key] ?? 0,
  }));
  const week = daily.slice(-7).reduce((sum, day) => sum + day.ms, 0);
  const allTime =
    Object.entries(time.days).reduce(
      (sum, [key, ms]) => sum + (key === time.day ? 0 : ms),
      0
    ) + todayMs;
  const peak = Math.max(1, ...daily.map((day) => day.ms));
  const podRows = Object.entries(time.pods)
    .map(([podId, entry]) => {
      const summary = pods.find((candidate) => candidate.pod.id === podId);
      const podQuestions = questions[podId] ?? [];
      const items = Object.entries(entry.items)
        .map(([qid, ms]) => {
          const question = podQuestions.find(
            (candidate) => candidate.id === qid
          );

          return {
            qid,
            ms,
            title: question === undefined ? qid : itemTitle(question),
            exists: question !== undefined,
          };
        })
        .sort((a, b) => b.ms - a.ms);

      return {
        podId,
        name:
          summary === undefined ? `${podId} (deleted)` : podName(summary.pod),
        exists: summary !== undefined,
        totalMs: entry.totalMs,
        items,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
  const itemCount = podRows.reduce((sum, pod) => sum + pod.items.length, 0);
  const podTotal = podRows.reduce((sum, pod) => sum + pod.totalMs, 0);

  return (
    <section className="time-page">
      <button type="button" className="link-button back" onClick={onClose}>
        ← Back
      </button>
      <h2>Planning time</h2>
      <p className="muted">
        Active time only — scrolling, typing, clicking, listening, or waiting on
        a live reply. Time on this page doesn't count.
      </p>

      <div className="time-stats">
        <div>
          <span className="time-stats__label">Today</span>
          <strong>{formatDuration(todayMs)}</strong>
        </div>
        <div>
          <span className="time-stats__label">Last 7 days</span>
          <strong>{formatDuration(week)}</strong>
        </div>
        <div>
          <span className="time-stats__label">All time</span>
          <strong>{formatDuration(allTime)}</strong>
        </div>
        <div>
          <span className="time-stats__label">Per item, on average</span>
          <strong>
            {itemCount === 0 ? '—' : formatDuration(podTotal / itemCount)}
          </strong>
        </div>
      </div>

      <h3 className="time-page__heading">Last {DAYS_SHOWN} days</h3>
      <div className="time-chart" role="img" aria-label="Active time per day">
        {daily.map((day) => (
          <div
            key={day.key}
            className="time-chart__day"
            title={`${weekday(day.key)} · ${formatDuration(day.ms)}`}
          >
            <span className="time-chart__value">{compact(day.ms)}</span>
            <span
              className={`time-chart__bar${
                day.key === time.day ? ' time-chart__bar--today' : ''
              }`}
              style={{ height: `${(day.ms / peak) * 100}%` }}
            />
            <span className="time-chart__label">{weekday(day.key)}</span>
          </div>
        ))}
      </div>

      <h3 className="time-page__heading">By Lambda</h3>
      {podRows.length === 0 && (
        <p className="muted">
          Nothing yet — time on a Lambda's items shows up here.
        </p>
      )}
      {podRows.map((pod) => (
        <details
          key={pod.podId}
          className="time-pod"
          open={podRows.length <= 3}
        >
          <summary>
            <span>{pod.name}</span>
            <strong>{formatDuration(pod.totalMs)}</strong>
          </summary>
          <ul>
            {pod.items.map((item) => (
              <li key={item.qid}>
                {item.exists && pod.exists ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenItem(pod.podId, item.qid)}
                  >
                    {item.title}
                  </button>
                ) : (
                  <span>{item.title}</span>
                )}
                <span className="time-pod__ms">{formatDuration(item.ms)}</span>
              </li>
            ))}
            {pod.totalMs >
              pod.items.reduce((sum, item) => sum + item.ms, 0) && (
              <li className="muted">
                <span>On its own page</span>
                <span className="time-pod__ms">
                  {formatDuration(
                    pod.totalMs -
                      pod.items.reduce((sum, item) => sum + item.ms, 0)
                  )}
                </span>
              </li>
            )}
          </ul>
        </details>
      ))}
    </section>
  );
};
