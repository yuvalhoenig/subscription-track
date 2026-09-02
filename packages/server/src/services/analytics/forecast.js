/**
 * Spending forecasts and trend analysis.
 *
 * Implements Holt's linear (double) exponential smoothing with an optional
 * multiplicative seasonal adjustment, plus prediction intervals derived
 * from in-sample residuals.
 *
 * Why not ARIMA or Prophet? Both need a Python runtime and a lot of data to
 * beat exponential smoothing, and subscription spend is a short, monthly,
 * strongly-trending series — typically 6–36 points. Holt's method is the
 * standard choice at that length, runs in microseconds with no extra
 * dependency, and is transparent enough to explain to a user. The smoothing
 * parameters are fitted by grid search rather than guessed.
 *
 * The forecast is also blended with *committed* spend (what the user has
 * actually signed up for), because unlike a generic time series we know a
 * large part of next month's value with certainty.
 */

import { round2 } from '@subtrack/shared';
import { spendTimeline, projections } from './reports.js';
import { many } from '../../db/pool.js';

/** Standard normal quantiles for the intervals we report. */
const Z = { 0.5: 0.674, 0.8: 1.282, 0.9: 1.645, 0.95: 1.96 };

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function stdDev(values) {
  if (values.length < 2) return 0;
  const mu = mean(values);
  // Sample standard deviation (n-1): we are estimating from a sample.
  const variance = values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Damping factor for the trend component.
 *
 * Fixed rather than fitted, and deliberately conservative. With only
 * 12-24 monthly observations — several of which are annual-renewal spikes
 * — an undamped trend happily extrapolates a two-month bump into a
 * doubling of spend within a quarter. Damping multiplies the trend by
 * phi^h at horizon h, so its contribution converges to a finite total
 * (trend * phi/(1-phi)) instead of growing without bound.
 *
 * Fitting phi by in-sample SSE does not work here: damping barely affects
 * one-step-ahead errors, so SSE gives almost no signal about it while the
 * long-horizon behaviour it controls is exactly what we care about.
 * 0.85 is the standard conservative default for automated forecasting.
 */
const TREND_DAMPING = 0.85;

/**
 * Upper bound on the trend-adaptation parameter.
 *
 * Unconstrained grid search on a short, spiky series picks a large beta,
 * because chasing every spike minimises in-sample error. That produces a
 * trend estimate dominated by noise. Capping beta keeps the fitted trend a
 * statement about the series' direction rather than about its last bump.
 */
const MAX_BETA = 0.3;

/**
 * Holt's method with a damped trend, for fixed (alpha, beta).
 *
 * Returns the final level/trend plus one-step-ahead fitted values, which
 * are what the residual-based prediction intervals are computed from.
 */
export function holtLinear(series, alpha = 0.5, beta = 0.2, phi = TREND_DAMPING) {
  if (series.length < 2) {
    return { level: series[0] ?? 0, trend: 0, phi, fitted: [], residuals: [], sse: 0 };
  }

  let level = series[0];
  let trend = series[1] - series[0];
  const fitted = [];
  const residuals = [];

  for (let t = 1; t < series.length; t += 1) {
    // Forecast for t using only information up to t-1.
    const prediction = level + phi * trend;
    fitted.push(prediction);
    residuals.push(series[t] - prediction);

    const previousLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - previousLevel) + (1 - beta) * phi * trend;
  }

  const sse = residuals.reduce((sum, r) => sum + r * r, 0);
  return { level, trend, phi, fitted, residuals, sse };
}

/**
 * Cumulative damped-trend multiplier for a forecast h steps ahead:
 * phi + phi^2 + ... + phi^h. Converges to phi/(1-phi) as h grows, which
 * is what stops long horizons running away.
 */
export function dampedTrendFactor(h, phi = TREND_DAMPING) {
  let total = 0;
  for (let i = 1; i <= h; i += 1) total += phi ** i;
  return total;
}

/**
 * Fit alpha and beta by grid search on in-sample SSE.
 * A coarse grid is plenty: the SSE surface is flat enough at these series
 * lengths that finer search buys nothing but overfitting. Beta is capped
 * (see MAX_BETA) so the fit cannot chase spikes.
 */
export function fitHolt(series) {
  let best = { alpha: 0.5, beta: 0.2, sse: Infinity, model: null };
  for (let alpha = 0.1; alpha <= 0.9; alpha += 0.1) {
    for (let beta = 0.05; beta <= MAX_BETA + 1e-9; beta += 0.05) {
      const model = holtLinear(series, alpha, beta);
      if (model.sse < best.sse) {
        best = { alpha: round2(alpha), beta: round2(beta), sse: model.sse, model };
      }
    }
  }
  return best;
}

/**
 * Multiplicative seasonal indices by calendar month.
 * Needs at least two observations for a month before it will claim that
 * month is systematically high or low, otherwise one unusual December
 * becomes a permanent "December is expensive" rule.
 */
export function seasonalIndices(points) {
  const overall = mean(points.map((p) => p.total));
  if (overall <= 0) return null;
  // Two full cycles before we will claim a calendar-month effect exists.
  // With 14 months, only one or two months have a repeat observation, and
  // "December is expensive" drawn from a single December is not a pattern.
  if (points.length < 24) return null;

  const byMonth = new Map();
  for (const point of points) {
    const month = Number(point.month.slice(5, 7));
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(point.total);
  }

  const indices = {};
  let anySeasonal = false;
  for (const [month, values] of byMonth) {
    if (values.length < 2) continue;
    const index = mean(values) / overall;
    indices[month] = round2(index);
    if (Math.abs(index - 1) > 0.1) anySeasonal = true;
  }
  return anySeasonal ? indices : null;
}

/**
 * Forecast the next `horizon` months of actual spend.
 *
 * Blends three sources of information:
 *   - the smoothed historical trend (Holt),
 *   - seasonal indices where the history supports them,
 *   - committed spend, which anchors the first month.
 */
export async function forecastSpending(userId, { horizon = 6, confidence = 0.8, now = new Date() } = {}) {
  // Complete months only: fitting on the current partial month would
  // read its undercount as a genuine drop in spending.
  const history = await spendTimeline(userId, { months: 18, includeCurrentMonth: false });
  const committed = await projections(userId, { months: horizon, now });

  // Drop leading zero months (before the user had any payments) so the
  // model isn't fitted to a flat run-up that never happened.
  const firstNonZero = history.findIndex((point) => point.total > 0);
  const usable = firstNonZero === -1 ? [] : history.slice(firstNonZero);
  const observed = usable.map((point) => point.total);

  const z = Z[confidence] ?? Z[0.8];
  const startMonth = (offset) => {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return base.toISOString().slice(0, 7);
  };

  // Not enough history to fit a trend: fall back to committed spend, with a
  // wide interval that honestly reflects how little we know.
  if (observed.length < 4) {
    const baseline = committed.monthly;
    return {
      model: 'committed-baseline',
      confidence,
      horizon,
      history: usable,
      insufficientData: true,
      note: `Only ${observed.length} month${observed.length === 1 ? '' : 's'} of payment history: this projection uses your current commitments rather than a fitted trend.`,
      predictions: Array.from({ length: horizon }, (_, i) => ({
        month: startMonth(i + 1),
        predicted: baseline,
        lower: round2(baseline * 0.85),
        upper: round2(baseline * 1.15),
      })),
    };
  }

  const { alpha, beta, model } = fitHolt(observed);
  const seasonal = seasonalIndices(usable);
  // Residual spread drives the interval width; it widens with the square
  // root of the horizon, as it should for a random-walk-with-drift error.
  const sigma = stdDev(model.residuals);

  const predictions = [];
  for (let h = 1; h <= horizon; h += 1) {
    const month = startMonth(h);
    // Damped trend: the multiplier converges rather than growing linearly.
    const raw = model.level + dampedTrendFactor(h, model.phi) * model.trend;
    const monthNumber = Number(month.slice(5, 7));
    const seasonalFactor = seasonal?.[monthNumber] ?? 1;

    let predicted = Math.max(0, raw * seasonalFactor);

    /**
     * Anchor against committed spend at every horizon, not just the first
     * month.
     *
     * This is the one place a subscription forecast has an advantage over a
     * generic time series: we know exactly what the user is signed up for,
     * so a large part of every future month is already determined. The
     * payment history contributes the irregular part (annual renewals,
     * one-offs, price changes) and the trend it implies.
     *
     * Confidence in the commitment figure decays with horizon — plans get
     * added and cancelled — so its weight tapers from 0.6 down to 0.3.
     */
    if (committed.monthly > 0) {
      const committedWeight = Math.max(0.3, 0.6 - 0.05 * (h - 1));
      predicted = committedWeight * committed.monthly + (1 - committedWeight) * predicted;
    }

    const spread = z * sigma * Math.sqrt(h);
    predictions.push({
      month,
      predicted: round2(predicted),
      lower: round2(Math.max(0, predicted - spread)),
      upper: round2(predicted + spread),
      seasonalFactor: seasonalFactor === 1 ? null : seasonalFactor,
    });
  }

  return {
    model: seasonal ? 'holt-linear+seasonal' : 'holt-linear',
    parameters: { alpha, beta, phi: model.phi, sigma: round2(sigma) },
    confidence,
    horizon,
    history: usable,
    seasonal,
    committedMonthly: committed.monthly,
    predictions,
    insufficientData: false,
  };
}

/**
 * Describe the shape of the user's spending history in plain terms:
 * direction, magnitude, volatility and any seasonal pattern.
 */
export async function analyseTrend(userId, { months = 12 } = {}) {
  const history = await spendTimeline(userId, { months, includeCurrentMonth: false });
  const totals = history.map((point) => point.total).filter((total) => total > 0);

  if (totals.length < 3) {
    return {
      direction: 'unknown',
      note: 'Not enough payment history yet to identify a trend.',
      history,
    };
  }

  // Least-squares slope over the series gives change per month.
  const n = totals.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(totals);
  const slope =
    xs.reduce((sum, x, i) => sum + (x - xMean) * (totals[i] - yMean), 0) /
    (xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0) || 1);

  const percentPerMonth = yMean > 0 ? round2((slope / yMean) * 100) : 0;
  const volatility = yMean > 0 ? round2((stdDev(totals) / yMean) * 100) : 0;

  // A 2%/month threshold keeps normal month-to-month noise from being
  // reported as a trend.
  const direction =
    Math.abs(percentPerMonth) < 2 ? 'stable' : percentPerMonth > 0 ? 'rising' : 'falling';

  const first = totals[0];
  const last = totals[n - 1];

  return {
    direction,
    slopePerMonth: round2(slope),
    percentPerMonth,
    totalChangePercent: first > 0 ? round2(((last - first) / first) * 100) : null,
    average: round2(yMean),
    volatilityPercent: volatility,
    // High volatility means the average is a poor summary — worth saying so.
    volatility: volatility > 30 ? 'high' : volatility > 15 ? 'moderate' : 'low',
    seasonal: seasonalIndices(history),
    months: n,
    history,
  };
}

/** Per-category forecasts, so the UI can show where growth is coming from. */
export async function forecastByCategory(userId, { horizon = 3 } = {}) {
  const rows = await many(
    `SELECT COALESCE(c.name, 'Uncategorised') AS category,
            to_char(date_trunc('month', p.payment_date), 'YYYY-MM') AS month,
            sum(p.amount)::numeric(12,2) AS total
       FROM payment_history p
       JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN categories c ON c.id = s.category_id
      WHERE p.user_id = $1 AND p.status = 'paid'
        AND p.payment_date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [userId],
  );

  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(Number(row.total));
  }

  const results = [];
  for (const [category, series] of byCategory) {
    if (series.length < 3) {
      // Too short to fit: report the recent average instead of pretending.
      const average = round2(mean(series));
      results.push({
        category,
        model: 'average',
        nextMonth: average,
        lower: round2(average * 0.8),
        upper: round2(average * 1.2),
        months: series.length,
      });
      continue;
    }
    const { model } = fitHolt(series);
    const sigma = stdDev(model.residuals);
    const predicted = Math.max(0, model.level + model.trend);
    results.push({
      category,
      model: 'holt-linear',
      nextMonth: round2(predicted),
      lower: round2(Math.max(0, predicted - 1.282 * sigma)),
      upper: round2(predicted + 1.282 * sigma),
      months: series.length,
      trendPerMonth: round2(model.trend),
    });
  }

  return results.sort((a, b) => b.nextMonth - a.nextMonth);
}
