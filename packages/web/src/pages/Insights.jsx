/**
 * AI Insights: the analysis surface.
 *
 * Insights, savings, forecast, value ranking, anomalies, recommendations
 * and a written report — all of it computed server-side, this page just
 * arranges it.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCurrency, formatPercent } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import {
  Button, Empty, Loading, SkeletonCard, ErrorState, Badge, Segmented, Meter, Alert,
} from '../components/ui.jsx';
import { ForecastChart, CategoryBarChart, StackedCategoryChart } from '../components/Charts.jsx';
import { InsightCard } from '../components/InsightCard.jsx';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

const TABS = [
  { value: 'insights', label: 'Insights' },
  { value: 'savings', label: 'Savings' },
  { value: 'forecast', label: 'Forecast' },
  { value: 'value', label: 'Value' },
  { value: 'report', label: 'Report' },
];

export function InsightsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const currency = user?.currency ?? 'USD';
  const [tab, setTab] = useState('insights');
  const [generating, setGenerating] = useState(false);

  const insights = useAsync(() => api.insights.list({ limit: 40 }), []);
  const optimize = useAsync(() => api.analytics.optimize(), []);
  const forecast = useAsync(() => api.analytics.forecast({ horizon: 6 }), []);
  const trend = useAsync(() => api.analytics.trend(), []);
  const value = useAsync(() => api.analytics.value(), []);
  const anomalies = useAsync(() => api.analytics.anomalies(), []);
  const recommendations = useAsync(() => api.analytics.recommendations(), []);
  const benchmark = useAsync(() => api.analytics.benchmark(), []);
  const categoryTimeline = useAsync(() => api.analytics.categoryTimeline(6), []);
  const categoryForecast = useAsync(() => api.analytics.categoryForecast(), []);
  // The written report costs a model call, so it loads only on demand.
  const report = useAsync(() => api.ai.report('month'), [], { immediate: false });

  const regenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const result = await api.insights.generate(true);
      insights.reload();
      optimize.reload();
      toast.success(
        result.generatedBy === 'claude'
          ? 'Insights refreshed and rewritten by Claude.'
          : 'Insights refreshed.',
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setGenerating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const dismiss = async (insight) => {
    try {
      await api.insights.dismiss(insight.id);
      insights.reload();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const savings = optimize.data?.totalPotentialSavings;

  return (
    <AppShell
      title="AI Insights"
      actions={(
        <Button variant="primary" icon="refresh" onClick={regenerate} loading={generating}>
          <span className="desktop-only">Refresh</span>
        </Button>
      )}
    >
      <div className="stack gap-5">
        {/* ── Savings headline ── */}
        {savings?.monthly > 0 ? (
          <div
            className="card animate-rise"
            style={{
              background: 'var(--gradient-brand)',
              color: '#fff',
              border: 'none',
              boxShadow: 'var(--shadow-brand)',
            }}
          >
            <div className="row gap-4 wrap">
              <div
                style={{
                  width: 52, height: 52, borderRadius: 'var(--radius-md)',
                  background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center',
                }}
              >
                <Icon name="scissors" size={24} />
              </div>
              <div className="grow">
                <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.85 }}>
                  Identified savings
                </div>
                <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 700, letterSpacing: '-.03em' }}>
                  {formatCurrency(savings.monthly, currency)}
                  <span style={{ fontSize: 'var(--text-md)', fontWeight: 500, opacity: 0.85 }}> /month</span>
                </div>
                <div style={{ fontSize: 'var(--text-sm)', opacity: 0.9, marginTop: 4 }}>
                  {formatCurrency(savings.yearly, currency)} a year across{' '}
                  {optimize.data.findings.length} finding{optimize.data.findings.length === 1 ? '' : 's'}
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => setTab('savings')}
                style={{ background: 'rgba(255,255,255,.16)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}
              >
                See how
              </Button>
            </div>
          </div>
        ) : null}

        <Segmented value={tab} onChange={setTab} options={TABS} />

        {/* ── Insights feed ── */}
        {tab === 'insights' ? (
          insights.error ? (
            <ErrorState error={insights.error} onRetry={insights.reload} />
          ) : insights.loading && !insights.data ? (
            <Loading label="Loading insights…" />
          ) : insights.data?.insights?.length ? (
            <div className="stack gap-3 stagger">
              {insights.data.insights.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  currency={currency}
                  onDismiss={dismiss}
                  onAction={() => navigate('/subscriptions')}
                />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty
                icon="sparkles"
                title="No insights right now"
                message="Either everything looks reasonable, or there is not enough data yet. Add subscriptions and log some usage, then refresh."
                action={<Button variant="primary" icon="refresh" onClick={regenerate} loading={generating}>Generate insights</Button>}
              />
            </div>
          )
        ) : null}

        {/* ── Savings detail ── */}
        {tab === 'savings' ? (
          optimize.loading && !optimize.data ? (
            <Loading label="Analysing your subscriptions…" />
          ) : optimize.data?.findings?.length ? (
            <div className="stack gap-3 stagger">
              {optimize.data.findings.map((finding, index) => (
                <div className="insight" data-severity={finding.severity} key={`${finding.type}-${index}`}>
                  <div
                    className="insight-icon"
                    style={{
                      background: finding.monthlySaving > 0 ? 'var(--success-soft)' : 'var(--brand-soft)',
                      color: finding.monthlySaving > 0 ? 'var(--success)' : 'var(--brand)',
                    }}
                  >
                    <Icon
                      name={
                        finding.type === 'duplicate' ? 'copy'
                          : finding.type === 'unused' ? 'eye'
                            : finding.type === 'bundle' ? 'layers'
                              : finding.type === 'price_increase' ? 'arrow-up'
                                : 'scissors'
                      }
                      size={18}
                    />
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row gap-2 wrap" style={{ marginBottom: 2 }}>
                      <Badge tone="neutral">{finding.type.replace('_', ' ')}</Badge>
                      <span className="tiny muted">
                        {Math.round((finding.confidence ?? 0) * 100)}% confidence
                      </span>
                    </div>
                    <h4 className="insight-title">{finding.title}</h4>
                    <p className="insight-body">{finding.detail}</p>
                    {finding.monthlySaving > 0 ? (
                      <div className="row gap-2" style={{ marginTop: 'var(--space-2)' }}>
                        <Icon name="trending-down" size={14} style={{ color: 'var(--success)' }} />
                        <span className="small">
                          <span className="insight-savings">
                            {formatCurrency(finding.monthlySaving, currency)}/month
                          </span>
                          <span className="muted"> ({formatCurrency(finding.yearlySaving, currency)}/year)</span>
                        </span>
                      </div>
                    ) : finding.potentialPerSeatSaving ? (
                      <div className="tiny muted" style={{ marginTop: 'var(--space-2)' }}>
                        Up to {formatCurrency(finding.potentialPerSeatSaving, currency)}/month per person if shared.
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}

              <p className="tiny muted center" style={{ marginTop: 'var(--space-2)' }}>
                Savings are counted once per subscription, so overlapping findings do not
                inflate the total.
              </p>
            </div>
          ) : (
            <div className="card">
              <Empty
                icon="check-circle"
                title="Nothing obvious to cut"
                message="No duplicates, unused subscriptions or above-market prices found. Log usage to sharpen the analysis."
              />
            </div>
          )
        ) : null}

        {/* ── Forecast ── */}
        {tab === 'forecast' ? (
          <div className="stack gap-5">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title">Projected spending</div>
                  <div className="card-subtitle">
                    {forecast.data?.insufficientData
                      ? 'Based on current commitments'
                      : `${forecast.data?.model} · ${Math.round((forecast.data?.confidence ?? 0.8) * 100)}% interval`}
                  </div>
                </div>
              </div>
              {forecast.loading ? <SkeletonCard lines={4} /> : forecast.data ? (
                <>
                  <ForecastChart
                    history={forecast.data.history ?? []}
                    predictions={forecast.data.predictions}
                    currency={currency}
                    height={320}
                  />
                  {forecast.data.parameters ? (
                    <div className="row gap-4 wrap tiny muted" style={{ marginTop: 'var(--space-4)' }}>
                      <span>α {forecast.data.parameters.alpha}</span>
                      <span>β {forecast.data.parameters.beta}</span>
                      <span>φ {forecast.data.parameters.phi} (trend damping)</span>
                      <span>σ {formatCurrency(forecast.data.parameters.sigma, currency)}</span>
                      {forecast.data.committedMonthly ? (
                        <span>anchored to {formatCurrency(forecast.data.committedMonthly, currency)} committed</span>
                      ) : null}
                    </div>
                  ) : null}
                  {forecast.data.note ? (
                    <Alert tone="info" >{forecast.data.note}</Alert>
                  ) : null}
                </>
              ) : null}
            </div>

            {trend.data && trend.data.direction !== 'unknown' ? (
              <div className="grid grid-stats">
                <div className="card stat">
                  <div className="stat-label">Direction</div>
                  <div className="stat-value capitalize" style={{ fontSize: 'var(--text-2xl)' }}>
                    {trend.data.direction}
                  </div>
                  <div className="stat-meta">
                    {formatPercent(trend.data.percentPerMonth, 1)} a month
                  </div>
                </div>
                <div className="card stat">
                  <div className="stat-label">Monthly average</div>
                  <div className="stat-value" style={{ fontSize: 'var(--text-2xl)' }}>
                    {formatCurrency(trend.data.average, currency)}
                  </div>
                  <div className="stat-meta">over {trend.data.months} months</div>
                </div>
                <div className="card stat">
                  <div className="stat-label">Volatility</div>
                  <div className="stat-value capitalize" style={{ fontSize: 'var(--text-2xl)' }}>
                    {trend.data.volatility}
                  </div>
                  <div className="stat-meta">{trend.data.volatilityPercent}% of average</div>
                </div>
              </div>
            ) : null}

            {categoryForecast.data?.forecasts?.length ? (
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Next month by category</div>
                    <div className="card-subtitle">Each category forecast separately</div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th className="right">Forecast</th>
                        <th className="right desktop-only">Range</th>
                        <th className="desktop-only">Model</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categoryForecast.data.forecasts.map((row) => (
                        <tr key={row.category}>
                          <td className="semibold">{row.category}</td>
                          <td className="right nums">{formatCurrency(row.nextMonth, currency)}</td>
                          <td className="right nums small muted desktop-only">
                            {formatCurrency(row.lower, currency)} – {formatCurrency(row.upper, currency)}
                          </td>
                          <td className="desktop-only tiny muted mono">{row.model}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {categoryTimeline.data?.series?.length ? (
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Category spend over time</div>
                    <div className="card-subtitle">Actual payments, stacked by category</div>
                  </div>
                </div>
                <StackedCategoryChart
                  categories={categoryTimeline.data.categories}
                  series={categoryTimeline.data.series}
                  currency={currency}
                />
              </div>
            ) : null}

            {anomalies.data?.spendAnomalies?.length || anomalies.data?.chargeAnomalies?.length ? (
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Unusual activity</div>
                    <div className="card-subtitle">
                      Detected against a median baseline of{' '}
                      {formatCurrency(anomalies.data.baseline ?? 0, currency)} a month
                    </div>
                  </div>
                </div>
                <div className="stack gap-3">
                  {[...(anomalies.data.spendAnomalies ?? []), ...(anomalies.data.chargeAnomalies ?? [])].map(
                    (anomaly, index) => (
                      <div className="row gap-3" key={`${anomaly.title}-${index}`}>
                        <Icon
                          name={anomaly.direction === 'drop' ? 'trending-down' : 'alert-triangle'}
                          size={16}
                          style={{ color: anomaly.severity === 'high' ? 'var(--danger)' : 'var(--warning)', marginTop: 2 }}
                        />
                        <div className="grow">
                          <div className="small semibold">{anomaly.title}</div>
                          <div className="tiny muted">{anomaly.detail}</div>
                        </div>
                        {anomaly.score ? (
                          <span className="badge badge-neutral mono" title="Robust z-score (median/MAD)">
                            z {Math.abs(anomaly.score).toFixed(1)}
                          </span>
                        ) : null}
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── Value ranking ── */}
        {tab === 'value' ? (
          value.loading && !value.data ? (
            <Loading label="Scoring your subscriptions…" />
          ) : (
            <div className="stack gap-5">
              {value.data?.averageValueScore != null ? (
                <div className="grid grid-stats">
                  <div className="card stat">
                    <div className="stat-label">Average value score</div>
                    <div className="stat-value">{value.data.averageValueScore}</div>
                    <div className="stat-meta">out of 100</div>
                  </div>
                  <div className="card stat">
                    <div className="stat-label">At risk of cancellation</div>
                    <div className="stat-value">{value.data.atRisk?.length ?? 0}</div>
                    <div className="stat-meta">based on usage and cost</div>
                  </div>
                </div>
              ) : null}

              {value.data?.worst?.length ? (
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Weakest value for money</div>
                      <div className="card-subtitle">Usage weighed against cost</div>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Subscription</th>
                          <th className="right">Monthly</th>
                          <th className="right">Uses (30d)</th>
                          <th className="right desktop-only">Cost / use</th>
                          <th style={{ minWidth: 110 }}>Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {value.data.worst.map((row) => (
                          <tr key={row.id ?? row.name}>
                            <td>
                              <div className="semibold">{row.name}</div>
                              <div className="tiny muted">{row.recommendation}</div>
                            </td>
                            <td className="right nums">{formatCurrency(row.monthly, currency)}</td>
                            <td className="right nums">{row.usesLast30d}</td>
                            <td className="right nums desktop-only">
                              {row.costPerUse != null ? formatCurrency(row.costPerUse, currency) : '—'}
                            </td>
                            <td><Meter value={row.valueScore} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {value.data?.best?.length ? (
                <div className="card">
                  <div className="card-header">
                    <div>
                      <div className="card-title">Best value</div>
                      <div className="card-subtitle">Earning their keep</div>
                    </div>
                  </div>
                  <div className="stack gap-3">
                    {value.data.best.map((row) => (
                      <div className="row gap-3" key={row.id ?? row.name}>
                        <span className="grow truncate small semibold">{row.name}</span>
                        <span className="tiny muted">{row.usesLast30d} uses</span>
                        <span className="nums small">{formatCurrency(row.monthly, currency)}</span>
                        <div style={{ width: 96 }}><Meter value={row.valueScore} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {value.data?.unrated?.length ? (
                <Alert tone="info">
                  {value.data.unrated.length} subscription
                  {value.data.unrated.length === 1 ? ' has' : 's have'} no usage data yet, so
                  they are not scored. Tap the check mark on the Subscriptions page when you use one.
                </Alert>
              ) : null}

              {!value.data?.worst?.length && !value.data?.best?.length ? (
                <div className="card">
                  <Empty
                    icon="target"
                    title="No usage data yet"
                    message="Value scores need usage. Log a few uses and the ranking appears here."
                  />
                </div>
              ) : null}
            </div>
          )
        ) : null}

        {/* ── Written report ── */}
        {tab === 'report' ? (
          <div className="stack gap-5">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title row gap-2">
                    <Icon name="sparkles" size={16} style={{ color: 'var(--brand)' }} />
                    Your spending report
                  </div>
                  <div className="card-subtitle">A plain-English summary of the numbers</div>
                </div>
                <Button
                  variant="soft"
                  size="sm"
                  icon={report.data ? 'refresh' : 'sparkles'}
                  onClick={report.reload}
                  loading={report.loading}
                >
                  {report.data ? 'Regenerate' : 'Write it'}
                </Button>
              </div>

              {report.loading ? (
                <SkeletonCard lines={5} />
              ) : report.error ? (
                <ErrorState error={report.error} onRetry={report.reload} />
              ) : report.data ? (
                <>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 'var(--leading-relaxed)' }}>
                    {report.data.report}
                  </div>
                  <div className="row gap-2 tiny muted" style={{ marginTop: 'var(--space-4)' }}>
                    <Icon name="info" size={12} />
                    {report.data.generatedBy === 'claude'
                      ? 'Written by Claude from figures computed by SubTrack.'
                      : 'Generated from a template — set ANTHROPIC_API_KEY for a written version.'}
                  </div>
                </>
              ) : (
                <Empty
                  icon="receipt"
                  title="Generate a report"
                  message="A short written summary of what you spend, where it goes, and the single most useful thing to do next."
                  action={<Button variant="primary" icon="sparkles" onClick={report.reload}>Write my report</Button>}
                />
              )}
            </div>

            {benchmark.data?.available ? (
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">How you compare</div>
                    <div className="card-subtitle">
                      Anonymous, across {benchmark.data.population} users
                    </div>
                  </div>
                </div>
                <p className="secondary">{benchmark.data.total.summary}</p>
                <div className="row gap-6 wrap" style={{ marginTop: 'var(--space-4)' }}>
                  <div>
                    <div className="tiny muted">You</div>
                    <strong className="nums">{formatCurrency(benchmark.data.total.userMonthly, currency)}</strong>
                  </div>
                  <div>
                    <div className="tiny muted">Median</div>
                    <strong className="nums">{formatCurrency(benchmark.data.total.median, currency)}</strong>
                  </div>
                  <div>
                    <div className="tiny muted">Middle 50%</div>
                    <strong className="nums">
                      {formatCurrency(benchmark.data.total.p25, currency)} – {formatCurrency(benchmark.data.total.p75, currency)}
                    </strong>
                  </div>
                </div>
                {benchmark.data.categories?.length ? (
                  <div style={{ marginTop: 'var(--space-5)' }}>
                    <CategoryBarChart
                      data={benchmark.data.categories.map((row) => ({
                        category: row.category,
                        monthly: row.userMonthly,
                      }))}
                      currency={currency}
                      height={Math.max(160, benchmark.data.categories.length * 34)}
                    />
                  </div>
                ) : null}
              </div>
            ) : benchmark.data ? (
              <Alert tone="info">{benchmark.data.reason}</Alert>
            ) : null}

            {recommendations.data ? (
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">Suggestions</div>
                    <div className="card-subtitle">Cheaper alternatives and gaps in your coverage</div>
                  </div>
                </div>
                <div className="stack gap-4">
                  {recommendations.data.substitutes?.map((item) => (
                    <div className="row gap-3" key={item.service.id}>
                      <Icon name="refresh" size={16} style={{ color: 'var(--brand)', marginTop: 2 }} />
                      <div className="grow">
                        <div className="small semibold">
                          {item.service.name} instead of {item.replaces.name}
                        </div>
                        <div className="tiny muted">
                          About {formatCurrency(item.service.market.typical, currency)}/month against the{' '}
                          {formatCurrency(item.replaces.monthly, currency)} you pay now — roughly{' '}
                          {formatCurrency(item.estimatedSaving, currency)} a month.
                        </div>
                      </div>
                    </div>
                  ))}

                  {recommendations.data.gaps?.map((gap) => (
                    <div className="row gap-3" key={gap.group}>
                      <Icon name="plus" size={16} style={{ color: 'var(--text-muted)', marginTop: 2 }} />
                      <div className="grow">
                        <div className="small semibold">No {gap.label} tracked</div>
                        <div className="tiny muted">
                          Commonly held: {gap.options.map((option) => `${option.name} (~${formatCurrency(option.market.typical, currency)}/mo)`).join(', ')}.
                        </div>
                      </div>
                    </div>
                  ))}

                  {recommendations.data.peerPicks?.map((pick) => (
                    <div className="row gap-3" key={pick.service.id}>
                      <Icon name="users" size={16} style={{ color: 'var(--info)', marginTop: 2 }} />
                      <div className="grow">
                        <div className="small semibold">{pick.service.name}</div>
                        <div className="tiny muted">{pick.detail}</div>
                      </div>
                    </div>
                  ))}

                  {!recommendations.data.substitutes?.length
                    && !recommendations.data.gaps?.length
                    && !recommendations.data.peerPicks?.length ? (
                      <p className="small muted">Nothing to suggest right now.</p>
                    ) : null}
                </div>
                {!recommendations.data.collaborativeAvailable ? (
                  <p className="tiny muted" style={{ marginTop: 'var(--space-4)' }}>
                    Peer suggestions need at least five users with overlapping subscriptions
                    before they can be shown anonymously.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

export default InsightsPage;
