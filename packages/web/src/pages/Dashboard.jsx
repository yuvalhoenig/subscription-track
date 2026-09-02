/** Dashboard: headline spend, breakdowns, forecast and the top insights. */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatCurrency, formatPercent, formatDate } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import {
  Button, Progress, Empty, SkeletonCard, ErrorState, Badge, Segmented, Alert,
} from '../components/ui.jsx';
import { CategoryPie, SpendAreaChart, ForecastChart } from '../components/Charts.jsx';
import { RenewalTimeline } from '../components/RenewalTimeline.jsx';
import { InsightCard } from '../components/InsightCard.jsx';
import { SubscriptionForm } from '../components/SubscriptionForm.jsx';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

function StatCard({ label, value, meta, icon, gradient, delta, children }) {
  return (
    <div className="card stat card-hover">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta ? (
        <div className="stat-meta">
          <span className={`stat-delta ${delta.direction}`}>
            <Icon name={delta.direction === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />
            {delta.label}
          </span>{' '}
          <span className="muted">{delta.suffix}</span>
        </div>
      ) : meta ? (
        <div className="stat-meta">{meta}</div>
      ) : null}
      {children}
      {icon ? (
        <div className="stat-icon" style={{ background: gradient ?? 'var(--gradient-brand)' }}>
          <Icon name={icon} size={18} />
        </div>
      ) : null}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [range, setRange] = useState(12);
  const [showForm, setShowForm] = useState(false);

  const overview = useAsync(() => api.analytics.overview(), []);
  const breakdown = useAsync(() => api.analytics.categories(), []);
  /**
   * Complete months only. Including the current, part-way-through month
   * makes the chart end in a plunge to near zero, which reads as a
   * collapse in spending rather than a month that hasn't finished.
   * Unwrapped to the array here so the chart props stay simple.
   */
  const timeline = useAsync(
    () => api.analytics.timeline(range, false).then((response) => response.timeline),
    [range],
  );
  const forecast = useAsync(() => api.analytics.forecast({ horizon: 4 }), []);
  const calendar = useAsync(() => api.subscriptions.calendar(30), []);
  const insights = useAsync(() => api.insights.list({ limit: 4 }), []);
  const categories = useAsync(() => api.categories.list(), []);

  const reloadAll = useCallback(() => {
    overview.reload();
    breakdown.reload();
    timeline.reload();
    forecast.reload();
    calendar.reload();
    insights.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The chat widget fires this after it changes data, so the dashboard
  // behind it stays in step.
  useEffect(() => {
    window.addEventListener('subtrack:data-changed', reloadAll);
    return () => window.removeEventListener('subtrack:data-changed', reloadAll);
  }, [reloadAll]);

  const currency = user?.currency ?? 'USD';
  const data = overview.data;
  const loading = overview.loading && !data;

  const dismissInsight = async (insight) => {
    try {
      await api.insights.dismiss(insight.id);
      insights.reload();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const timelineAverage = timeline.data?.length
    ? timeline.data.reduce((sum, point) => sum + point.total, 0) / timeline.data.filter((p) => p.total > 0).length
    : null;

  return (
    <AppShell
      title="Dashboard"
      actions={(
        <Button variant="primary" icon="plus" onClick={() => setShowForm(true)}>
          <span className="desktop-only">Add subscription</span>
        </Button>
      )}
    >
      {overview.error ? <ErrorState error={overview.error} onRetry={reloadAll} /> : null}

      {loading ? (
        <div className="grid grid-stats">
          {Array.from({ length: 4 }, (_, index) => <SkeletonCard key={index} lines={1} />)}
        </div>
      ) : null}

      {data ? (
        <div className="stack gap-6">
          {/* Nudge an unverified user once, where they will see it. */}
          {user && !user.email_verified ? (
            <Alert tone="warning">
              Confirm your e-mail address to switch on renewal reminders.{' '}
              <button
                type="button"
                style={{ textDecoration: 'underline', fontWeight: 600 }}
                onClick={async () => {
                  try {
                    await api.auth.resendVerification();
                    toast.success('Confirmation e-mail sent.');
                  } catch (error) {
                    toast.error(error.message);
                  }
                }}
              >
                Resend the link
              </button>
            </Alert>
          ) : null}

          {/* ── Headline numbers ── */}
          <section className="grid grid-stats stagger">
            <StatCard
              label="Monthly spend"
              value={formatCurrency(data.spend.monthly, currency)}
              icon="wallet"
              // A "0.0%" delta with an arrow implies movement where there is
              // none, so it is omitted entirely.
              delta={data.monthOverMonth && Math.abs(data.monthOverMonth.changePercent) >= 0.1 ? {
                direction: data.monthOverMonth.changePercent > 0 ? 'up' : 'down',
                label: formatPercent(Math.abs(data.monthOverMonth.changePercent), 1),
                suffix: 'vs last month',
              } : undefined}
              meta={`${formatCurrency(data.spend.daily, currency)} a day`}
            />

            <StatCard
              label="Yearly commitment"
              value={formatCurrency(data.spend.yearly, currency)}
              icon="calendar"
              gradient="var(--gradient-teal)"
              meta={
                data.spend.trialsIfConverted > 0
                  ? `+${formatCurrency(data.spend.trialsIfConverted * 12, currency)} if trials convert`
                  : `${formatCurrency(data.spend.weekly, currency)} a week`
              }
            />

            <StatCard
              label="Active subscriptions"
              value={data.counts.active}
              icon="layers"
              gradient="var(--gradient-brand)"
              meta={
                [
                  data.counts.trial ? `${data.counts.trial} trial${data.counts.trial === 1 ? '' : 's'}` : null,
                  data.counts.paused ? `${data.counts.paused} paused` : null,
                ].filter(Boolean).join(' · ') || 'All active'
              }
            />

            <StatCard
              label="Due in 30 days"
              value={formatCurrency(data.upcoming.next30Days, currency)}
              icon="clock"
              gradient="var(--gradient-amber)"
              meta={
                data.upcoming.next
                  ? `Next: ${data.upcoming.next.name} on ${formatDate(data.upcoming.next.date, 'en-US', { year: undefined })}`
                  : 'Nothing scheduled'
              }
            />
          </section>

          {/* ── Budget ── */}
          {data.budget ? (
            <section className="card animate-rise">
              <div className="card-header">
                <div>
                  <div className="card-title">Monthly budget</div>
                  <div className="card-subtitle">
                    {formatCurrency(data.budget.used, currency)} of{' '}
                    {formatCurrency(data.budget.monthly, currency)} committed
                  </div>
                </div>
                <Badge tone={data.budget.overBudget ? 'danger' : data.budget.usedPercent >= 80 ? 'warning' : 'success'}>
                  {data.budget.overBudget
                    ? `${formatCurrency(Math.abs(data.budget.remaining), currency)} over`
                    : `${formatCurrency(data.budget.remaining, currency)} left`}
                </Badge>
              </div>
              <Progress value={data.budget.used} max={data.budget.monthly} />
              <div className="between small muted" style={{ marginTop: 'var(--space-2)' }}>
                <span>{data.budget.usedPercent}% used</span>
                <Link to="/settings" className="tiny">Change budget</Link>
              </div>
            </section>
          ) : (
            <section className="card animate-rise">
              <div className="row gap-3 wrap">
                <Icon name="target" size={18} style={{ color: 'var(--brand)' }} />
                <span className="grow small secondary">
                  Set a monthly budget and SubTrack will warn you before you cross it.
                </span>
                <Button size="sm" onClick={() => navigate('/settings')}>Set a budget</Button>
              </div>
            </section>
          )}

          {/* ── Trials about to convert ── */}
          {data.expiringTrials.length > 0 ? (
            <section className="card animate-rise" style={{ borderColor: 'var(--warning)' }}>
              <div className="card-header">
                <div className="row gap-2">
                  <Icon name="clock" size={17} style={{ color: 'var(--warning)' }} />
                  <span className="card-title">Trials ending soon</span>
                </div>
              </div>
              <div className="stack gap-2">
                {data.expiringTrials.map((trial) => (
                  <div key={trial.id} className="between small">
                    <span className="semibold">{trial.name}</span>
                    <span className="row gap-3">
                      <span className="muted">
                        {trial.daysLeft <= 0 ? 'today' : trial.daysLeft === 1 ? 'tomorrow' : `in ${trial.daysLeft} days`}
                      </span>
                      <strong className="nums">
                        {formatCurrency(trial.cost, currency)}
                      </strong>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ── Charts ── */}
          <section className="grid grid-charts">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Where the money goes</div>
                  <div className="card-subtitle">Monthly spend by category</div>
                </div>
                <Link to="/subscriptions" className="tiny">View all</Link>
              </div>
              {breakdown.data?.categories?.length ? (
                <CategoryPie data={breakdown.data.categories} currency={currency} />
              ) : (
                <Empty
                  icon="pie-chart"
                  title="No active subscriptions"
                  message="Add one and the breakdown appears here."
                />
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Spending history</div>
                  <div className="card-subtitle">What you actually paid, per month</div>
                </div>
                <Segmented
                  value={range}
                  onChange={setRange}
                  options={[
                    { value: 6, label: '6m' },
                    { value: 12, label: '1y' },
                    { value: 24, label: '2y' },
                  ]}
                />
              </div>
              {timeline.data?.some((point) => point.total > 0) ? (
                <SpendAreaChart data={timeline.data} currency={currency} average={timelineAverage} />
              ) : (
                <Empty
                  icon="bar-chart"
                  title="No payment history yet"
                  message="Log payments as they happen, and this chart fills in."
                />
              )}
            </div>
          </section>

          {/* ── Forecast ── */}
          <section className="card">
            <div className="card-header">
              <div>
                <div className="card-title row gap-2">
                  Spending forecast
                  <Badge tone="brand" icon="sparkles">ML</Badge>
                </div>
                <div className="card-subtitle">
                  {forecast.data?.insufficientData
                    ? 'Based on current commitments — not enough history for a fitted trend yet'
                    : `${forecast.data?.model ?? ''} · ${Math.round((forecast.data?.confidence ?? 0.8) * 100)}% confidence interval`}
                </div>
              </div>
              <Link to="/insights" className="tiny">More analysis</Link>
            </div>
            {forecast.loading ? (
              <SkeletonCard lines={4} />
            ) : forecast.data ? (
              <>
                <ForecastChart
                  history={forecast.data.history?.slice(-9) ?? []}
                  predictions={forecast.data.predictions}
                  currency={currency}
                />
                {forecast.data.note ? (
                  <p className="tiny muted" style={{ marginTop: 'var(--space-3)' }}>
                    {forecast.data.note}
                  </p>
                ) : null}
              </>
            ) : null}
          </section>

          {/* ── Insights + renewals ── */}
          <section className="grid grid-charts">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title row gap-2">
                    <Icon name="sparkles" size={16} style={{ color: 'var(--brand)' }} />
                    Top insights
                  </div>
                  <div className="card-subtitle">What stood out in your spending</div>
                </div>
                <Link to="/insights" className="tiny">See all</Link>
              </div>

              {insights.loading ? (
                <SkeletonCard lines={2} />
              ) : insights.data?.insights?.length ? (
                <div className="stack gap-3">
                  {insights.data.insights.map((insight) => (
                    <InsightCard
                      key={insight.id}
                      insight={insight}
                      currency={currency}
                      onDismiss={dismissInsight}
                      onAction={() => navigate('/subscriptions')}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon="sparkles"
                  title="No insights yet"
                  message="Add a few subscriptions and SubTrack will start finding patterns."
                  action={(
                    <Button
                      size="sm"
                      variant="soft"
                      icon="refresh"
                      onClick={async () => {
                        try {
                          await api.insights.generate();
                          insights.reload();
                          toast.success('Insights refreshed.');
                        } catch (error) {
                          toast.error(error.message);
                        }
                      }}
                    >
                      Generate now
                    </Button>
                  )}
                />
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Coming up</div>
                  <div className="card-subtitle">
                    {calendar.data?.count
                      ? `${calendar.data.count} renewals worth ${formatCurrency(calendar.data.total, currency)}`
                      : 'Next 30 days'}
                  </div>
                </div>
                <Link to="/calendar" className="tiny">Full calendar</Link>
              </div>
              {calendar.loading ? (
                <SkeletonCard lines={3} />
              ) : (
                <RenewalTimeline
                  events={calendar.data?.events ?? []}
                  currency={currency}
                  limit={5}
                  onSelect={() => navigate('/calendar')}
                />
              )}
            </div>
          </section>

          {/* ── Biggest commitments ── */}
          {data.topSubscriptions.length > 0 ? (
            <section className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Biggest commitments</div>
                  <div className="card-subtitle">Where most of your subscription budget goes</div>
                </div>
              </div>
              <div className="stack gap-4">
                {data.topSubscriptions.map((subscription) => (
                  <div key={subscription.id}>
                    <div className="between small" style={{ marginBottom: 6 }}>
                      <span className="semibold truncate">{subscription.name}</span>
                      <span className="row gap-3">
                        <span className="muted tiny">{subscription.category}</span>
                        <strong className="nums">
                          {formatCurrency(subscription.monthlyCost, currency)}/mo
                        </strong>
                      </span>
                    </div>
                    <Progress value={subscription.shareOfSpend} max={100} tone="" />
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {subscription.shareOfSpend}% of your monthly spend
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      <SubscriptionForm
        open={showForm}
        onClose={() => setShowForm(false)}
        onSaved={reloadAll}
        categories={categories.data?.categories ?? []}
      />
    </AppShell>
  );
}

export default DashboardPage;
