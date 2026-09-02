/**
 * Usage scoring, value scoring and churn prediction.
 *
 * All three scores are deliberately simple, monotonic functions of
 * observable facts. A subscription tracker has no training labels — we
 * never learn whether the user actually cancelled on our advice — so a
 * fitted classifier here would be fitting noise. Transparent scores can
 * instead be explained to the user ("scored low because 0 uses in 30 days
 * at $24.99/month"), which is what makes the advice actionable.
 *
 * Scores are 0..100 so the UI can render them directly as a bar.
 */

import { round2, monthlyCost, costPerUse, findService, daysUntil } from '@subtrack/shared';
import { many, query } from '../../db/pool.js';
import { listForAnalysis } from '../subscriptions.js';

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

/**
 * How much the subscription is used, 0..100.
 *
 * Saturating at 20 uses/month: past roughly daily use, more use doesn't
 * make the subscription meaningfully more valuable, and a linear scale
 * would push everything else towards zero.
 */
export function frequencyScore({ usesLast30d = 0, usesLast90d = 0, lastUsedAt = null, now = new Date() }) {
  const recent = Number(usesLast30d) || 0;
  const quarter = Number(usesLast90d) || 0;

  // Logarithmic so the first few uses count for the most.
  const volume = clamp((Math.log10(recent + 1) / Math.log10(21)) * 70, 0, 70);

  // Recency: full marks inside a week, decaying to zero at 60 days.
  let recency = 0;
  if (lastUsedAt) {
    const days = Math.max(0, Math.floor((now - new Date(lastUsedAt)) / 86_400_000));
    recency = days <= 7 ? 30 : days >= 60 ? 0 : round2(30 * (1 - (days - 7) / 53));
  } else if (quarter > 0) {
    // Used at some point in the quarter but no timestamp: partial credit.
    recency = 10;
  }

  return round2(clamp(volume + recency));
}

/**
 * Value for money, 0..100: usage weighed against what it costs.
 *
 * Cost per use is the anchor, benchmarked against $2/use as "good value"
 * and $25/use as "poor". A cheap subscription used rarely can still score
 * respectably, which is correct — a $2/month app used twice is fine.
 */
export function valueScore({ monthly, usesLast30d = 0, frequency = null }) {
  const cost = Number(monthly) || 0;
  const uses = Number(usesLast30d) || 0;

  if (cost === 0) return 100;

  if (uses === 0) {
    // Unused: the score is driven purely by how much it costs to keep.
    // $5/month unused is a small leak; $50/month unused is a real problem.
    return round2(clamp(25 - Math.min(25, cost / 2), 0, 25));
  }

  const perUse = cost / uses;
  // Log-scaled between the two benchmarks.
  const ratio = (Math.log10(perUse) - Math.log10(2)) / (Math.log10(25) - Math.log10(2));
  const affordability = clamp(100 - ratio * 100, 0, 100);

  // Blend in raw frequency so a heavily used service isn't marked down
  // purely for being expensive.
  const freq = frequency ?? frequencyScore({ usesLast30d: uses });
  return round2(clamp(0.7 * affordability + 0.3 * freq));
}

/**
 * Probability-shaped churn risk, 0..1.
 *
 * Not a calibrated probability — it is an ordered risk score built from the
 * signals that actually precede a cancellation: no recent use, high cost,
 * a recent price rise, and a renewal coming up (the moment people act).
 */
export function churnRisk({
  usesLast30d = 0,
  usesLast90d = 0,
  monthly = 0,
  hadPriceIncrease = false,
  daysToRenewal = null,
  status = 'active',
}) {
  if (status === 'cancelled') return 1;
  if (status === 'paused') return 0.8;

  let risk = 0.1; // everyone has some baseline chance of cancelling

  const uses = Number(usesLast30d) || 0;
  const quarter = Number(usesLast90d) || 0;
  if (uses === 0 && quarter === 0) risk += 0.4;
  else if (uses === 0) risk += 0.25;
  else if (uses <= 2) risk += 0.1;

  // Cost amplifies everything: people scrutinise expensive line items.
  const cost = Number(monthly) || 0;
  if (cost >= 50) risk += 0.2;
  else if (cost >= 20) risk += 0.1;
  else if (cost < 5) risk -= 0.05;

  if (hadPriceIncrease) risk += 0.15;

  // Renewal proximity is a trigger, not a cause.
  if (daysToRenewal != null && daysToRenewal >= 0 && daysToRenewal <= 7) risk += 0.1;

  return round2(Math.min(0.99, Math.max(0.01, risk)));
}

/** One-line verdict + suggested action for a scored subscription. */
export function recommendationFor({ name, monthly, usesLast30d, value, frequency, daysSinceUse }) {
  const uses = Number(usesLast30d) || 0;
  const perUse = uses > 0 ? round2(monthly / uses) : null;

  if (value >= 70) {
    return {
      action: 'keep',
      text: `Good value — ${uses} uses this month at about ${perUse} per use.`,
    };
  }
  if (uses === 0 && monthly >= 15) {
    return {
      action: 'cancel',
      text: `No recorded use${daysSinceUse ? ` in ${daysSinceUse} days` : ''} and ${round2(monthly * 12)} a year. Strong candidate to cancel.`,
    };
  }
  if (uses === 0) {
    return {
      action: 'review',
      text: `Not used recently. It is only ${monthly}/month, but it is still a leak if you never use it.`,
    };
  }
  if (perUse != null && perUse > 15) {
    return {
      action: 'downgrade',
      text: `${perUse} per use is expensive. A cheaper tier may cover how you actually use it.`,
    };
  }
  return {
    action: 'monitor',
    text: `Moderate value at ${perUse ?? monthly} per use. Worth watching next month.`,
  };
}

/**
 * Score every subscription for a user and persist the results.
 * Called nightly by the scheduler and on demand from the insights route.
 */
export async function scoreSubscriptions(userId, { now = new Date(), persist = true } = {}) {
  const subscriptions = await listForAnalysis(userId);
  if (!subscriptions.length) return [];

  // Which subscriptions saw a price rise recently — a churn signal.
  const increases = new Set(
    (
      await many(
        `SELECT DISTINCT subscription_id FROM price_history
          WHERE user_id = $1 AND changed_at > now() - interval '90 days'
            AND new_cost > old_cost`,
        [userId],
      )
    ).map((row) => row.subscription_id),
  );

  const scored = subscriptions.map((sub) => {
    const monthly = monthlyCost(sub.cost, sub.billing_cycle);
    const usesLast30d = Number(sub.uses_last_30d ?? 0);
    const usesLast90d = Number(sub.uses_last_90d ?? 0);
    const hasUsageData = sub.uses_last_90d != null;

    const frequency = frequencyScore({
      usesLast30d,
      usesLast90d,
      lastUsedAt: sub.last_used_at,
      now,
    });
    const value = hasUsageData ? valueScore({ monthly, usesLast30d, frequency }) : null;
    const daysSinceUse = sub.last_used_at
      ? Math.floor((now - new Date(sub.last_used_at)) / 86_400_000)
      : null;

    const risk = churnRisk({
      usesLast30d,
      usesLast90d,
      monthly,
      hadPriceIncrease: increases.has(sub.id),
      daysToRenewal: daysUntil(sub.nextRenewal ?? sub.renewal_date, now),
      status: sub.status,
    });

    const recommendation = hasUsageData
      ? recommendationFor({ name: sub.name, monthly, usesLast30d, value, frequency, daysSinceUse })
      : { action: 'track', text: 'No usage recorded yet — log a few uses to get a value score.' };

    return {
      id: sub.id,
      name: sub.name,
      category: sub.category,
      monthly,
      usesLast30d,
      // Only meaningful with usage data; null keeps the UI honest.
      usageScore: hasUsageData ? frequency : null,
      valueScore: value,
      costPerUse: costPerUse(sub.cost, sub.billing_cycle, usesLast30d),
      churnRisk: risk,
      daysSinceUse,
      recommendation,
      marketRate: findService(sub.vendor_id ?? sub.name)?.market ?? null,
    };
  });

  if (persist) {
    // One statement for the whole batch rather than a query per row.
    const rows = scored.filter((s) => s.usageScore != null);
    if (rows.length) {
      await query(
        `UPDATE subscriptions AS s SET
           usage_score = v.usage_score,
           value_score = v.value_score,
           ai_recommendation = v.recommendation,
           ai_confidence = v.confidence,
           ai_reviewed_at = now()
         FROM (
           SELECT * FROM unnest(
             $2::uuid[], $3::numeric[], $4::numeric[], $5::text[], $6::numeric[]
           ) AS t(id, usage_score, value_score, recommendation, confidence)
         ) AS v
         WHERE s.id = v.id AND s.user_id = $1`,
        [
          userId,
          rows.map((s) => s.id),
          rows.map((s) => s.usageScore),
          rows.map((s) => s.valueScore),
          rows.map((s) => `${s.recommendation.action}: ${s.recommendation.text}`),
          rows.map((s) => round2(1 - s.churnRisk)),
        ],
      );
      await query(
        `UPDATE usage_analytics AS u SET
           frequency_score = v.frequency_score,
           value_score = v.value_score,
           cost_per_use = v.cost_per_use,
           churn_risk = v.churn_risk,
           updated_at = now()
         FROM (
           SELECT * FROM unnest(
             $2::uuid[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[]
           ) AS t(id, frequency_score, value_score, cost_per_use, churn_risk)
         ) AS v
         WHERE u.subscription_id = v.id AND u.user_id = $1`,
        [
          userId,
          rows.map((s) => s.id),
          rows.map((s) => s.usageScore),
          rows.map((s) => s.valueScore),
          rows.map((s) => s.costPerUse),
          rows.map((s) => s.churnRisk),
        ],
      );
    }
  }

  return scored.sort((a, b) => (a.valueScore ?? 101) - (b.valueScore ?? 101));
}

/**
 * Best and worst value subscriptions — the "ROI analysis" view.
 * Only ranks subscriptions that have usage data, since ranking on absent
 * data would just sort by price.
 */
export async function valueRanking(userId, { now = new Date() } = {}) {
  const scored = await scoreSubscriptions(userId, { now, persist: false });
  const rated = scored.filter((s) => s.valueScore != null);

  return {
    best: rated.slice().sort((a, b) => b.valueScore - a.valueScore).slice(0, 5),
    worst: rated.slice().sort((a, b) => a.valueScore - b.valueScore).slice(0, 5),
    unrated: scored.filter((s) => s.valueScore == null).map((s) => ({ id: s.id, name: s.name })),
    atRisk: scored
      .filter((s) => s.churnRisk >= 0.6)
      .sort((a, b) => b.churnRisk - a.churnRisk)
      .slice(0, 5),
    averageValueScore: rated.length
      ? round2(rated.reduce((sum, s) => sum + s.valueScore, 0) / rated.length)
      : null,
  };
}
