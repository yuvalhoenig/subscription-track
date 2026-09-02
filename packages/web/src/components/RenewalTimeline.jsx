/** Upcoming renewals grouped by date. */

import { formatCurrency, formatRelativeDays } from '@subtrack/shared';
import { Icon } from './Icon.jsx';
import { ServiceMark, Badge, Empty } from './ui.jsx';

/** Group flat renewal events into one row per calendar date. */
function groupByDate(events = []) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.date)) groups.set(event.date, []);
    groups.get(event.date).push(event);
  }
  return [...groups.entries()].map(([date, items]) => ({
    date,
    items,
    total: items.reduce((sum, item) => sum + Number(item.cost), 0),
    daysUntil: items[0].daysUntil,
  }));
}

export function RenewalTimeline({ events = [], currency = 'USD', limit, onSelect }) {
  const groups = groupByDate(events);
  const shown = limit ? groups.slice(0, limit) : groups;

  if (!shown.length) {
    return (
      <Empty
        icon="calendar"
        title="Nothing due"
        message="No renewals are coming up in this window."
      />
    );
  }

  return (
    <div className="timeline">
      {shown.map((group) => {
        const parsed = new Date(`${group.date}T00:00:00Z`);
        // Imminent renewals get a warmer rail than distant ones.
        const railColor =
          group.daysUntil <= 2 ? 'var(--danger)'
            : group.daysUntil <= 7 ? 'var(--warning)'
              : 'var(--border-strong)';

        return (
          <div className="timeline-row" key={group.date}>
            <div className="timeline-date">
              <div className="timeline-day">
                {parsed.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })}
              </div>
              <div className="timeline-month">
                {parsed.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
              </div>
            </div>

            <div className="timeline-rail" style={{ background: railColor }} />

            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row gap-2 wrap" style={{ marginBottom: 6 }}>
                <span className="small semibold">{formatRelativeDays(group.date)}</span>
                {group.items.length > 1 ? (
                  <span className="muted tiny">{group.items.length} renewals</span>
                ) : null}
              </div>

              <div className="stack gap-2">
                {group.items.map((item) => (
                  <button
                    key={`${item.subscriptionId}-${item.date}`}
                    type="button"
                    className="row gap-3"
                    onClick={() => onSelect?.(item)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius)',
                      cursor: onSelect ? 'pointer' : 'default',
                    }}
                  >
                    <ServiceMark name={item.name} color={item.categoryColor} size={28} />
                    <span className="grow truncate">
                      <span className="small semibold">{item.name}</span>
                      <span className="tiny muted" style={{ display: 'block' }}>
                        {item.category}
                      </span>
                    </span>
                    {item.status === 'trial' ? <Badge tone="info" icon="clock">Trial ends</Badge> : null}
                    <strong className="nums small">{formatCurrency(item.cost, item.currency ?? currency)}</strong>
                  </button>
                ))}
              </div>
            </div>

            {group.items.length > 1 ? (
              <div className="right desktop-only" style={{ minWidth: 68 }}>
                <div className="tiny muted">Total</div>
                <strong className="nums">{formatCurrency(group.total, currency)}</strong>
              </div>
            ) : null}
          </div>
        );
      })}

      {limit && groups.length > limit ? (
        <div className="row gap-2 muted tiny" style={{ paddingTop: 'var(--space-3)', justifyContent: 'center' }}>
          <Icon name="more-horizontal" size={14} />
          {groups.length - limit} more {groups.length - limit === 1 ? 'date' : 'dates'} ahead
        </div>
      ) : null}
    </div>
  );
}

export default RenewalTimeline;
