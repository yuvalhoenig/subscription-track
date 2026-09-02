/**
 * Dashboard read models: totals, breakdowns, historical spend and
 * projections.
 *
 * Two different notions of "spend" appear here and they are deliberately
 * not mixed:
 *
 *   - **Committed spend** is derived from the current subscription list by
 *     normalising every cycle to a month. It answers "what am I signed up
 *     for right now" and is the headline figure.
 *   - **Actual spend** comes from payment_history. It answers "what did I
 *     really pay in March" and is what the forecasting models train on.
 *
 * A user who cancelled Netflix yesterday has it in last month's actual
 * spend but not in committed spend, and both numbers are correct.
 */

import {
  monthlyCost,
  round2,
  today,
  daysUntil,
  spendByCategory,
} from '@subtrack/shared';
import { many, one } from '../../db/pool.js';
import { cache } from '../../lib/cache.js';
import { listSubscriptions, upcomingRenewals } from '../subscriptions.js';

const OVERVIEW_TTL = 120; // seconds

/** SQL fragment normalising any billing cycle to a monthly amount. */
const MONTHLY_EXPR = `
  CASE s.billing_cycle
    WHEN 'weekly'     THEN s.cost * 52 / 12
    WHEN 'biweekly'   THEN s.cost * 26 / 12
    WHEN 'monthly'    THEN s.cost
    WHEN 'quarterly'  THEN s.cost / 3
    WHEN 'semiannual' THEN s.cost / 6
    WHEN 'yearly'     THEN s.cost / 12
  END`;

/** Headline numbers for the dashboard's overview cards. */
export async function overview(userId, { now = new Date() } = {}) {
  return cache.wrap(`analytics:${userId}:overview`, OVERVIEW_TTL, async () => {
    const subs = await listSubscriptions(userId, { includeCancelled: true });
    const active = subs.filter((s) => s.status === 'active');
    const trials = subs.filter((s) => s.status === 'trial');
    const paused = subs.filter((s) => s.status === 'paused');

    const committedMonthly = round2(active.reduce((sum, s) => sum + s.monthlyCost, 0));
    // What next month looks like if every running trial converts.
    const trialMonthly = round2(trials.reduce((sum, s) => sum + s.monthlyCost, 0));

    const user = await one('SELECT monthly_budget, currency FROM users WHERE id = $1', [userId]);
    const budget = user?.monthly_budget ? Number(user.monthly_budget) : null;

    const renewals = await upcomingRenewals(userId, { days: 30, now });

    // Compare the two most recent complete months of real payments.
    const trend = await many(
      `SELECT to_char(date_trunc('month', payment_date), 'YYYY-MM') AS month,
              sum(amount)::numeric(12,2) AS total
         FROM payment_history
        WHERE user_id = $1 AND status = 'paid'
          AND payment_date >= date_trunc('month', CURRENT_DATE) - interval '2 months'
          AND payment_date < date_trunc('month', CURRENT_DATE)
        GROUP BY 1 ORDER BY 1`,
      [userId],
    );
    let monthOverMonth = null;
    if (trend.length === 2) {
      const [previous, current] = trend.map((row) => Number(row.total));
      if (previous > 0) {
        monthOverMonth = {
          previous,
          current,
          changePercent: round2(((current - previous) / previous) * 100),
        };
      }
    }

    const expiringTrials = trials
      .map((s) => ({
        id: s.id,
        name: s.name,
        cost: s.cost,
        endsAt: s.trial_ends_at ?? s.nextRenewal,
        daysLeft: daysUntil(s.trial_ends_at ?? s.nextRenewal, now),
      }))
      .filter((t) => t.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    return {
      currency: user?.currency ?? 'USD',
      counts: {
        active: active.length,
        trial: trials.length,
        paused: paused.length,
        cancelled: subs.filter((s) => s.status === 'cancelled').length,
        total: subs.filter((s) => s.status !== 'cancelled').length,
      },
      spend: {
        monthly: committedMonthly,
        yearly: round2(committedMonthly * 12),
        weekly: round2((committedMonthly * 12) / 52),
        daily: round2((committedMonthly * 12) / 365),
        trialsIfConverted: trialMonthly,
        monthlyWithTrials: round2(committedMonthly + trialMonthly),
      },
      budget: budget
        ? {
            monthly: budget,
            used: committedMonthly,
            remaining: round2(budget - committedMonthly),
            usedPercent: round2((committedMonthly / budget) * 100),
            overBudget: committedMonthly > budget,
          }
        : null,
      upcoming: {
        next30Days: renewals.total,
        count: renewals.count,
        next: renewals.events[0] ?? null,
      },
      monthOverMonth,
      expiringTrials,
      // The five most expensive commitments — usually where savings live.
      topSubscriptions: active
        .slice()
        .sort((a, b) => b.monthlyCost - a.monthlyCost)
        .slice(0, 5)
        .map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          monthlyCost: s.monthlyCost,
          shareOfSpend: committedMonthly ? round2((s.monthlyCost / committedMonthly) * 100) : 0,
        })),
      generatedAt: new Date().toISOString(),
    };
  });
}

/** Monthly spend per category, for the dashboard pie chart. */
export async function categoryBreakdown(userId) {
  return cache.wrap(`analytics:${userId}:categories`, OVERVIEW_TTL, async () => {
    const rows = await many(
      `SELECT COALESCE(c.name, 'Uncategorised') AS category,
              COALESCE(c.color, '#94a3b8')      AS color,
              COALESCE(c.icon, 'tag')           AS icon,
              count(s.id)::int                  AS count,
              sum(${MONTHLY_EXPR})::numeric(12,2) AS monthly
         FROM subscriptions s
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.user_id = $1 AND s.status = 'active'
        GROUP BY c.name, c.color, c.icon
        ORDER BY monthly DESC NULLS LAST`,
      [userId],
    );
    const total = round2(rows.reduce((sum, row) => sum + Number(row.monthly ?? 0), 0));
    return {
      total,
      categories: rows.map((row) => ({
        category: row.category,
        color: row.color,
        icon: row.icon,
        count: row.count,
        monthly: round2(Number(row.monthly ?? 0)),
        yearly: round2(Number(row.monthly ?? 0) * 12),
        percent: total ? round2((Number(row.monthly ?? 0) / total) * 100) : 0,
      })),
    };
  });
}

/**
 * Actual spend per month from payment history, gap-filled so a month with
 * no payments shows as zero rather than being missing from the series —
 * charts and forecasting both need a continuous series.
 */
export async function spendTimeline(userId, { months = 12, includeCurrentMonth = true } = {}) {
  // The current month is still accumulating payments, so it is always an
  // undercount. Callers that *fit models* on this series (forecasting,
  // trend analysis, anomaly detection) must exclude it — a half-finished
  // month reads as a collapse in spending and drags the fitted level down.
  // Callers that merely *display* history keep it, because it is factual.
  const rows = await many(
    `WITH bounds AS (
       SELECT date_trunc('month', CURRENT_DATE)
                - make_interval(months => $2::int - 1 + CASE WHEN $3 THEN 0 ELSE 1 END)
              AS start_month,
              date_trunc('month', CURRENT_DATE)
                - make_interval(months => CASE WHEN $3 THEN 0 ELSE 1 END)
              AS end_month
     ),
     series AS (
       SELECT generate_series((SELECT start_month FROM bounds),
                              (SELECT end_month FROM bounds),
                              interval '1 month') AS month
     )
     SELECT to_char(series.month, 'YYYY-MM') AS month,
            COALESCE(sum(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric(12,2) AS total,
            count(p.id) FILTER (WHERE p.status = 'paid')::int AS payments
       FROM series
       LEFT JOIN payment_history p
         ON date_trunc('month', p.payment_date) = series.month
        AND p.user_id = $1
      GROUP BY series.month
      ORDER BY series.month`,
    [userId, months, includeCurrentMonth],
  );
  return rows.map((row) => ({
    month: row.month,
    total: round2(Number(row.total)),
    payments: row.payments,
  }));
}

/** Actual spend per month split by category, for stacked area charts. */
export async function categoryTimeline(userId, { months = 6 } = {}) {
  const rows = await many(
    `SELECT to_char(date_trunc('month', p.payment_date), 'YYYY-MM') AS month,
            COALESCE(c.name, 'Uncategorised') AS category,
            sum(p.amount)::numeric(12,2) AS total
       FROM payment_history p
       JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN categories c ON c.id = s.category_id
      WHERE p.user_id = $1 AND p.status = 'paid'
        AND p.payment_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC`,
    [userId, months],
  );
  // Pivot into one row per month with a column per category, which is the
  // shape Recharts wants for a stacked chart.
  const byMonth = new Map();
  const categories = new Set();
  for (const row of rows) {
    categories.add(row.category);
    if (!byMonth.has(row.month)) byMonth.set(row.month, { month: row.month });
    byMonth.get(row.month)[row.category] = round2(Number(row.total));
  }
  return { categories: [...categories], series: [...byMonth.values()] };
}

/**
 * Forward projection from current commitments.
 * Unlike the ML forecast in ./forecast.js this is deterministic — it just
 * walks the renewal schedule — so it's the right number for "what will I
 * be charged", while the forecast handles "what will I probably spend".
 */
export async function projections(userId, { months = 12, now = new Date() } = {}) {
  const subs = await listSubscriptions(userId);
  const billable = subs.filter((s) => s.status === 'active' || s.status === 'trial');
  const start = today(now);

  const series = [];
  for (let i = 0; i < months; i += 1) {
    const monthStart = new Date(
      Date.UTC(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)) - 1 + i,
        1,
      ),
    );
    const label = monthStart.toISOString().slice(0, 7);
    // Last calendar day of this month, used to decide whether a trial is
    // still free for its whole duration.
    const monthEnd = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);

    // Committed monthly cost is cycle-normalised, so a yearly plan spreads
    // evenly rather than spiking in its renewal month. That makes the
    // projection a budget line rather than a cash-flow forecast.
    const total = round2(
      billable.reduce((sum, sub) => {
        // A trial that runs past the end of this month costs nothing yet.
        if (sub.status === 'trial' && sub.trial_ends_at && sub.trial_ends_at > monthEnd) {
          return sum;
        }
        return sum + monthlyCost(sub.cost, sub.billing_cycle);
      }, 0),
    );
    series.push({ month: label, projected: total });
  }

  const monthlyCommitted = series[0]?.projected ?? 0;
  return {
    monthly: monthlyCommitted,
    yearly: round2(monthlyCommitted * 12),
    series,
    byCategory: spendByCategory(billable),
  };
}

/**
 * CSV export of the user's subscriptions.
 * Fields are escaped per RFC 4180 and any value that could be read as a
 * spreadsheet formula is prefixed with a quote, so an imported name like
 * `=cmd|...` cannot execute on open.
 */
export async function exportSubscriptionsCsv(userId) {
  const subs = await listSubscriptions(userId, { includeCancelled: true });

  const escape = (value) => {
    if (value == null) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const headers = [
    'Name', 'Category', 'Subcategory', 'Cost', 'Currency', 'Billing Cycle',
    'Monthly Equivalent', 'Yearly Equivalent', 'Status', 'Next Renewal',
    'Started', 'Auto Renew', 'Usage Score', 'Value Score', 'URL', 'Notes',
  ];

  const lines = [headers.join(',')];
  for (const sub of subs) {
    lines.push(
      [
        sub.name, sub.category, sub.subcategory, sub.cost, sub.currency,
        sub.billing_cycle, sub.monthlyCost, sub.yearlyCost, sub.status,
        sub.nextRenewal, sub.started_at, sub.auto_renew ? 'yes' : 'no',
        sub.usage_score, sub.value_score, sub.url, sub.notes,
      ]
        .map(escape)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** CSV export of payment history. */
export async function exportPaymentsCsv(userId) {
  const rows = await many(
    `SELECT p.payment_date, s.name, p.amount, p.currency, p.status, p.method, p.note
       FROM payment_history p JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.user_id = $1
      ORDER BY p.payment_date DESC`,
    [userId],
  );
  const escape = (value) => {
    if (value == null) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [['Date', 'Subscription', 'Amount', 'Currency', 'Status', 'Method', 'Note'].join(',')];
  for (const row of rows) {
    lines.push([
      row.payment_date, row.name, row.amount, row.currency, row.status, row.method, row.note,
    ].map(escape).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
