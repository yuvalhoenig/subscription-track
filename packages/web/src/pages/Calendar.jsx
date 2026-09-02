/** Renewal calendar: month grid plus a chronological list. */

import { useMemo, useState } from 'react';
import { formatCurrency, today, daysUntil } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Button, Loading, ErrorState, Segmented, Empty, ServiceMark } from '../components/ui.jsx';
import { RenewalTimeline } from '../components/RenewalTimeline.jsx';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';

/** Calendar cells for a month, padded to whole weeks (Monday start). */
function buildMonthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  // getUTCDay() is 0=Sunday; shift so Monday is column 0.
  const leading = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
  }
  // Pad the tail so the grid is a clean rectangle.
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarPage() {
  const { user } = useAuth();
  const currency = user?.currency ?? 'USD';
  const [days, setDays] = useState(90);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);

  // Fetch far enough ahead to cover whichever month is being viewed.
  const calendar = useAsync(() => api.subscriptions.calendar(Math.max(days, 120)), [days]);

  const events = calendar.data?.events ?? [];

  const viewed = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  }, [offset]);

  const grid = useMemo(
    () => buildMonthGrid(viewed.getUTCFullYear(), viewed.getUTCMonth()),
    [viewed],
  );

  /** Renewals bucketed by date, for O(1) cell lookup. */
  const byDate = useMemo(() => {
    const map = new Map();
    for (const event of events) {
      if (!map.has(event.date)) map.set(event.date, []);
      map.get(event.date).push(event);
    }
    return map;
  }, [events]);

  const monthTotal = useMemo(() => {
    const prefix = viewed.toISOString().slice(0, 7);
    return events
      .filter((event) => event.date.startsWith(prefix))
      .reduce((sum, event) => sum + Number(event.cost), 0);
  }, [events, viewed]);

  const windowEvents = useMemo(
    () => events.filter((event) => event.daysUntil >= 0 && event.daysUntil <= days),
    [events, days],
  );

  const currentDate = today();
  const selectedEvents = selected ? byDate.get(selected) ?? [] : [];

  return (
    <AppShell
      title="Renewal calendar"
      actions={(
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: 30, label: '30d' },
            { value: 90, label: '90d' },
            { value: 180, label: '6m' },
          ]}
        />
      )}
    >
      {calendar.error ? (
        <ErrorState error={calendar.error} onRetry={calendar.reload} />
      ) : calendar.loading && !calendar.data ? (
        <Loading label="Loading renewals…" />
      ) : (
        <div className="stack gap-5">
          <div className="grid grid-stats">
            <div className="card stat">
              <div className="stat-label">Next {days} days</div>
              <div className="stat-value">
                {formatCurrency(
                  windowEvents.reduce((sum, event) => sum + Number(event.cost), 0),
                  currency,
                )}
              </div>
              <div className="stat-meta">
                {windowEvents.length} renewal{windowEvents.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="card stat">
              <div className="stat-label">This month view</div>
              <div className="stat-value">{formatCurrency(monthTotal, currency)}</div>
              <div className="stat-meta">
                {viewed.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
              </div>
            </div>
          </div>

          {/* ── Month grid ── */}
          <div className="card">
            <div className="card-header">
              <div className="row gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOffset(offset - 1)} aria-label="Previous month">
                  <Icon name="chevron-left" size={16} />
                </Button>
                <strong style={{ minWidth: 148, textAlign: 'center' }}>
                  {viewed.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
                </strong>
                <Button variant="ghost" size="sm" onClick={() => setOffset(offset + 1)} aria-label="Next month">
                  <Icon name="chevron-right" size={16} />
                </Button>
              </div>
              {offset !== 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>Today</Button>
              ) : null}
            </div>

            {/* minmax(0, 1fr) rather than 1fr: a plain `1fr` track refuses to
                shrink below its content's min-content width, so the currency
                label in a busy cell pushes the whole grid wider than the
                viewport on a phone. */}
            <div
              className="grid calendar-grid"
              style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 'var(--space-1)' }}
            >
              {WEEKDAYS.map((weekday) => (
                <div key={weekday} className="tiny muted center semibold" style={{ paddingBottom: 4 }}>
                  {weekday}
                </div>
              ))}

              {grid.map((date, index) => {
                if (!date) {
                  // Padding cell from the adjacent month.
                  return <div key={`pad-${index}`} style={{ minHeight: 68 }} />;
                }
                const dayEvents = byDate.get(date) ?? [];
                const total = dayEvents.reduce((sum, event) => sum + Number(event.cost), 0);
                const isToday = date === currentDate;
                const isPast = date < currentDate;
                const isSelected = date === selected;

                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => setSelected(isSelected ? null : date)}
                    className="stack gap-1"
                    style={{
                      minHeight: 68,
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius)',
                      border: `1px solid ${isSelected ? 'var(--brand)' : isToday ? 'var(--brand-300)' : 'var(--border)'}`,
                      background: isSelected
                        ? 'var(--brand-soft)'
                        : dayEvents.length
                          ? 'var(--surface-sunken)'
                          : 'transparent',
                      // Past days are de-emphasised but still readable.
                      opacity: isPast ? 0.5 : 1,
                      textAlign: 'left',
                      cursor: dayEvents.length ? 'pointer' : 'default',
                    }}
                    aria-label={`${date}${dayEvents.length ? `, ${dayEvents.length} renewals` : ''}`}
                  >
                    <span className={`tiny ${isToday ? 'semibold' : ''}`} style={isToday ? { color: 'var(--brand-text)' } : undefined}>
                      {Number(date.slice(8, 10))}
                    </span>
                    {dayEvents.length ? (
                      <>
                        <span className="row gap-1 wrap" style={{ gap: 2 }}>
                          {dayEvents.slice(0, 4).map((event) => (
                            <span
                              key={`${event.subscriptionId}-${event.date}`}
                              className="dot"
                              style={{ background: event.categoryColor ?? 'var(--brand)', width: 6, height: 6 }}
                              title={event.name}
                            />
                          ))}
                        </span>
                        <span
                          className="tiny nums semibold truncate calendar-amount"
                          style={{ color: 'var(--text-secondary)', maxWidth: '100%' }}
                        >
                          {formatCurrency(total, currency)}
                        </span>
                      </>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* ── Selected day detail ── */}
            {selected ? (
              <div
                className="stack gap-2 animate-rise"
                style={{
                  marginTop: 'var(--space-4)',
                  paddingTop: 'var(--space-4)',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div className="between">
                  <strong className="small">
                    {new Date(`${selected}T00:00:00Z`).toLocaleDateString('en-US', {
                      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
                    })}
                  </strong>
                  <span className="tiny muted">
                    {selectedEvents.length
                      ? `${daysUntil(selected) >= 0 ? 'in' : ''} ${Math.abs(daysUntil(selected))} days`
                      : ''}
                  </span>
                </div>
                {selectedEvents.length === 0 ? (
                  <p className="small muted">Nothing renews on this day.</p>
                ) : (
                  selectedEvents.map((event) => (
                    <div key={`${event.subscriptionId}-${event.date}`} className="row gap-3">
                      <ServiceMark name={event.name} color={event.categoryColor} size={28} />
                      <span className="grow truncate small semibold">{event.name}</span>
                      <span className="tiny muted">{event.category}</span>
                      <strong className="nums small">{formatCurrency(event.cost, currency)}</strong>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>

          {/* ── Chronological list ── */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Next {days} days</div>
                <div className="card-subtitle">Every charge in date order</div>
              </div>
            </div>
            {windowEvents.length === 0 ? (
              <Empty
                icon="calendar"
                title="Nothing due"
                message={`No renewals in the next ${days} days.`}
              />
            ) : (
              <RenewalTimeline events={windowEvents} currency={currency} />
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default CalendarPage;
