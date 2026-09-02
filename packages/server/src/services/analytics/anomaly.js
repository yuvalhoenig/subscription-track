/**
 * Anomaly detection over spending history.
 *
 * Uses the median and Median Absolute Deviation rather than mean and
 * standard deviation. That choice matters here: an anomaly detector built
 * on the mean is dragged towards the very outlier it is meant to catch, so
 * one $400 annual renewal inflates the standard deviation enough to mask
 * every subsequent spike. MAD is unaffected by up to half the data being
 * extreme, which is the right property for a series that legitimately
 * contains occasional large annual charges.
 *
 * The 0.6745 factor rescales MAD to be comparable with a standard
 * deviation for normally distributed data, so the familiar "3 sigma"
 * intuition still applies to the scores reported here.
 */

import { round2, monthlyCost } from '@subtrack/shared';
import { many } from '../../db/pool.js';
import { spendTimeline } from './reports.js';

const MAD_TO_SIGMA = 0.6745;
/** Robust z above which a point is reported. 3.5 is the Iglewicz-Hoaglin default. */
const OUTLIER_THRESHOLD = 3.5;

export function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation from the median. */
export function mad(values) {
  if (values.length < 2) return 0;
  const med = median(values);
  return median(values.map((value) => Math.abs(value - med)));
}

/**
 * Robust z-scores for a series.
 * When MAD is zero — a perfectly steady series, which is common for
 * subscriptions — we fall back to a relative-deviation measure so that a
 * genuinely new value is still flagged instead of dividing by zero.
 */
export function robustScores(values) {
  const med = median(values);
  const deviation = mad(values);

  if (deviation === 0) {
    return values.map((value) => {
      if (med === 0) return 0;
      const relative = Math.abs(value - med) / med;
      // Any departure from a previously constant series is notable; scale
      // so a 25% change lands near the reporting threshold.
      return round2(relative * 14);
    });
  }

  return values.map((value) => round2((MAD_TO_SIGMA * (value - med)) / deviation));
}

/**
 * Months whose total spend is out of line with the rest of the history.
 * Needs at least 4 months, below which "unusual" is meaningless.
 */
export async function detectSpendAnomalies(userId, { months = 12, reportWindow = 6 } = {}) {
  // Exclude the current month: it is incomplete, and would reliably be
  // flagged as an "unusually low spend" anomaly every time.
  const history = await spendTimeline(userId, { months, includeCurrentMonth: false });
  const nonEmpty = history.filter((point) => point.total > 0);
  if (nonEmpty.length < 4) {
    return { anomalies: [], baseline: null, insufficientData: true, history };
  }

  const totals = nonEmpty.map((point) => point.total);
  const scores = robustScores(totals);
  const med = median(totals);

  // The baseline uses the whole history — more data makes a better median —
  // but only recent months are *reported*. An unusual month from last year
  // is a curiosity, not something the user can act on, and a growing
  // subscription portfolio makes its early months look anomalously cheap.
  const oldestReported = nonEmpty
    .slice(-reportWindow)
    .map((point) => point.month)[0];

  const anomalies = [];
  nonEmpty.forEach((point, index) => {
    const score = scores[index];
    if (Math.abs(score) < OUTLIER_THRESHOLD) return;
    if (oldestReported && point.month < oldestReported) return;
    const direction = score > 0 ? 'spike' : 'drop';
    const delta = round2(point.total - med);
    anomalies.push({
      type: 'anomaly',
      severity: Math.abs(score) > 6 ? 'high' : 'medium',
      month: point.month,
      amount: point.total,
      baseline: round2(med),
      delta,
      percentFromBaseline: med > 0 ? round2((delta / med) * 100) : null,
      score,
      direction,
      title:
        direction === 'spike'
          ? `Unusually high spend in ${point.month}`
          : `Unusually low spend in ${point.month}`,
      detail:
        direction === 'spike'
          ? `You paid ${point.total} in ${point.month}, ${round2(Math.abs(delta))} more than your typical ${round2(med)} a month. ${point.payments} payment${point.payments === 1 ? '' : 's'} were recorded.`
          : `You paid ${point.total} in ${point.month}, ${round2(Math.abs(delta))} less than your typical ${round2(med)} a month.`,
    });
  });

  return {
    anomalies: anomalies.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
    baseline: round2(med),
    baselineMonths: nonEmpty.length,
    reportWindow,
    insufficientData: false,
    history,
  };
}

/**
 * Individual charges that don't match what the subscription should cost.
 * Compared against the subscription's own expected amount rather than a
 * global baseline, so a $400 annual renewal is normal for that plan and a
 * $400 charge on a $10 plan is not.
 */
export async function detectChargeAnomalies(userId, { sinceDays = 120 } = {}) {
  const rows = await many(
    `SELECT p.id, p.payment_date, p.amount, p.status, p.currency,
            s.id AS subscription_id, s.name, s.cost, s.billing_cycle, s.status AS sub_status
       FROM payment_history p
       JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.user_id = $1
        AND p.payment_date > CURRENT_DATE - make_interval(days => $2::int)
      ORDER BY p.payment_date DESC`,
    [userId, sinceDays],
  );

  const findings = [];
  for (const row of rows) {
    const expected = Number(row.cost);
    const actual = Number(row.amount);

    // A failed payment is an operational problem the user should see.
    if (row.status === 'failed') {
      findings.push({
        type: 'anomaly',
        severity: 'high',
        subscriptionIds: [row.subscription_id],
        title: `Payment for ${row.name} failed`,
        detail: `A ${actual} ${row.currency} charge for ${row.name} on ${row.payment_date} did not go through. Services are usually suspended after a few failed attempts.`,
        data: { paymentId: row.id, amount: actual, date: row.payment_date },
      });
      continue;
    }

    // Money leaving for something the user believes they cancelled.
    if (row.sub_status === 'cancelled' && row.status === 'paid') {
      findings.push({
        type: 'anomaly',
        severity: 'high',
        subscriptionIds: [row.subscription_id],
        title: `You were charged for ${row.name} after cancelling`,
        detail: `${row.name} is marked cancelled but a ${actual} ${row.currency} payment was recorded on ${row.payment_date}. Worth checking with the provider.`,
        data: { paymentId: row.id, amount: actual, date: row.payment_date },
      });
      continue;
    }

    if (expected <= 0) continue;
    const ratio = actual / expected;
    // 10% tolerance absorbs tax, FX and proration.
    if (ratio <= 1.1) continue;

    findings.push({
      type: 'anomaly',
      severity: ratio >= 1.5 ? 'high' : 'medium',
      subscriptionIds: [row.subscription_id],
      title: `${row.name} charged ${round2(actual - expected)} more than expected`,
      detail: `The recorded plan is ${expected} ${row.currency} (${row.billing_cycle}) but the charge on ${row.payment_date} was ${actual}. That is ${round2((ratio - 1) * 100)}% above plan — a price rise, an added seat, or tax.`,
      data: {
        paymentId: row.id,
        expected,
        actual,
        overagePercent: round2((ratio - 1) * 100),
        date: row.payment_date,
      },
    });
  }
  return findings;
}

/**
 * Budget pressure check.
 * Compares committed spend against the user's stated monthly budget and
 * reports how close they are, so notifications can fire before the money
 * is gone rather than after.
 */
export async function checkBudgetPressure(userId) {
  const [row] = await many(
    `SELECT u.monthly_budget, u.currency,
            COALESCE(sum(
              CASE s.billing_cycle
                WHEN 'weekly'     THEN s.cost * 52 / 12
                WHEN 'biweekly'   THEN s.cost * 26 / 12
                WHEN 'monthly'    THEN s.cost
                WHEN 'quarterly'  THEN s.cost / 3
                WHEN 'semiannual' THEN s.cost / 6
                WHEN 'yearly'     THEN s.cost / 12
              END
            ) FILTER (WHERE s.status = 'active'), 0)::numeric(12,2) AS committed
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.monthly_budget, u.currency`,
    [userId],
  );

  if (!row?.monthly_budget) return null;

  const budget = Number(row.monthly_budget);
  const committed = Number(row.committed);
  const usedPercent = budget > 0 ? round2((committed / budget) * 100) : 0;

  // Only speak up when it's actionable: at 80% there's still time to act.
  if (usedPercent < 80) return null;

  return {
    type: 'anomaly',
    severity: usedPercent >= 100 ? 'high' : 'medium',
    title:
      usedPercent >= 100
        ? `You are ${round2(committed - budget)} over your monthly budget`
        : `You have used ${usedPercent}% of your monthly budget`,
    detail:
      usedPercent >= 100
        ? `Your committed subscriptions total ${committed} ${row.currency} a month against a ${budget} budget.`
        : `Committed subscriptions total ${committed} ${row.currency} of your ${budget} monthly budget, leaving ${round2(budget - committed)}.`,
    data: { budget, committed, usedPercent },
  };
}

/**
 * Subscriptions whose cost is wildly out of step with the rest of the
 * user's portfolio — useful for catching a typo'd amount at entry
 * (e.g. 1599 instead of 15.99).
 */
export function detectCostOutliers(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  if (active.length < 4) return [];

  const monthlies = active.map((s) => monthlyCost(s.cost, s.billing_cycle));
  const scores = robustScores(monthlies);
  const med = median(monthlies);

  return active
    .map((sub, index) => ({ sub, score: scores[index], monthly: monthlies[index] }))
    .filter(({ score }) => score > OUTLIER_THRESHOLD * 2)
    .map(({ sub, score, monthly }) => ({
      type: 'anomaly',
      severity: 'medium',
      subscriptionIds: [sub.id],
      title: `${sub.name} is far more expensive than your other subscriptions`,
      detail: `At ${monthly}/month it is well above your typical ${round2(med)}/month. If that figure is wrong, correcting it will fix your totals.`,
      data: { monthly, median: round2(med), score },
    }));
}
