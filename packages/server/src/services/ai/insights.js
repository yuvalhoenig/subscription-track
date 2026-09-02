/**
 * Insight generation.
 *
 * The division of labour here is deliberate and worth stating plainly:
 *
 *   **Deterministic code computes every number.** The optimiser, the
 *   forecaster and the anomaly detector produce the findings, the savings
 *   figures and the confidence values. Nothing financial is ever generated
 *   by the model.
 *
 *   **Claude writes the prose.** It turns those findings into readable
 *   summaries and prioritises what to say first.
 *
 * That split means a hallucination can make an insight badly *worded* but
 * never numerically wrong, and every insight remains fully explainable
 * from the structured `data` payload stored alongside it. Without an API
 * key the templated text below is used, which is why the demo account
 * still shows a full insights feed offline.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { round2, formatCurrency } from '@subtrack/shared';
import { complete, completeJson, withFallback, looksLikeRefusalOrEcho } from './claude.js';
import { query, many, one } from '../../db/pool.js';
import { optimize, findRenewalAlerts } from '../analytics/optimizer.js';
import { forecastSpending, analyseTrend } from '../analytics/forecast.js';
import {
  detectSpendAnomalies,
  detectChargeAnomalies,
  checkBudgetPressure,
  detectCostOutliers,
} from '../analytics/anomaly.js';
import { valueRanking } from '../analytics/usage.js';
import { benchmark } from '../analytics/recommend.js';
import { overview } from '../analytics/reports.js';
import { listForAnalysis } from '../subscriptions.js';
import { logger } from '../../lib/logger.js';

const log = logger.child('insights');

/**
 * Stable identity for an insight, so re-running generation nightly updates
 * rather than duplicating. Deliberately excludes the prose (which varies
 * between model calls) and includes only the substance.
 */
function fingerprint({ insightType, subscriptionIds = [], bucket = '' }) {
  return crypto
    .createHash('sha256')
    .update([insightType, [...subscriptionIds].sort().join(','), bucket].join('|'))
    .digest('hex')
    .slice(0, 32);
}

/** Month bucket, so the same finding can recur in a later month. */
const monthBucket = (now = new Date()) => now.toISOString().slice(0, 7);

// ── Templated (heuristic) narration ────────────────────────────

/**
 * Turn structured findings into insight rows without an LLM.
 * These templates are what the app ships with when no API key is set.
 */
function templateInsights({ findings, forecast, trend, anomalies, ranking, budget, currency }) {
  const insights = [];

  for (const finding of findings) {
    insights.push({
      insightType: finding.type,
      severity: finding.severity,
      title: finding.title,
      content: finding.detail,
      potentialSavings: finding.monthlySaving || null,
      relatedSubscriptionIds: finding.subscriptionIds ?? [],
      data: finding.data ?? {},
    });
  }

  for (const anomaly of anomalies) {
    insights.push({
      insightType: 'anomaly',
      severity: anomaly.severity ?? 'medium',
      title: anomaly.title,
      content: anomaly.detail,
      potentialSavings: null,
      relatedSubscriptionIds: anomaly.subscriptionIds ?? [],
      data: anomaly.data ?? { month: anomaly.month, score: anomaly.score },
    });
  }

  if (budget) {
    insights.push({
      insightType: 'anomaly',
      severity: budget.severity,
      title: budget.title,
      content: budget.detail,
      potentialSavings: null,
      relatedSubscriptionIds: [],
      data: budget.data,
    });
  }

  if (forecast && !forecast.insufficientData && forecast.predictions.length) {
    const next = forecast.predictions[0];
    insights.push({
      insightType: 'forecast',
      severity: 'info',
      title: `Next month is projected at ${formatCurrency(next.predicted, currency)}`,
      content: `Based on ${forecast.history.length} months of payment history, spending for ${next.month} is projected at ${formatCurrency(next.predicted, currency)}, likely between ${formatCurrency(next.lower, currency)} and ${formatCurrency(next.upper, currency)} (${Math.round(forecast.confidence * 100)}% interval).`,
      potentialSavings: null,
      relatedSubscriptionIds: [],
      data: { predictions: forecast.predictions, model: forecast.model },
    });
  }

  if (trend && trend.direction !== 'unknown' && trend.direction !== 'stable') {
    const rising = trend.direction === 'rising';
    insights.push({
      insightType: 'trend',
      severity: rising && Math.abs(trend.percentPerMonth) > 5 ? 'medium' : 'info',
      title: `Your spending is ${trend.direction} by about ${Math.abs(trend.percentPerMonth)}% a month`,
      content: `Over the last ${trend.months} months your subscription spend has ${rising ? 'grown' : 'fallen'} by roughly ${formatCurrency(Math.abs(trend.slopePerMonth), currency)} a month, averaging ${formatCurrency(trend.average, currency)}. Volatility is ${trend.volatility}.`,
      potentialSavings: null,
      relatedSubscriptionIds: [],
      data: { trend: trend.direction, percentPerMonth: trend.percentPerMonth, seasonal: trend.seasonal },
    });
  }

  if (ranking?.worst?.length) {
    const worst = ranking.worst[0];
    if (worst.valueScore != null && worst.valueScore < 40) {
      insights.push({
        insightType: 'unused',
        severity: 'medium',
        title: `${worst.name} is your weakest value for money`,
        content: `${worst.name} scores ${worst.valueScore}/100 on value: ${worst.usesLast30d} uses in the last 30 days at ${formatCurrency(worst.monthly, currency)} a month${worst.costPerUse ? `, about ${formatCurrency(worst.costPerUse, currency)} per use` : ''}. ${worst.recommendation.text}`,
        potentialSavings: worst.recommendation.action === 'cancel' ? worst.monthly : null,
        relatedSubscriptionIds: [worst.id],
        data: { valueScore: worst.valueScore, costPerUse: worst.costPerUse },
      });
    }
  }

  return insights;
}

// ── Claude narration ───────────────────────────────────────────

const NarrationSchema = z.object({
  insights: z
    .array(
      z.object({
        // Index into the findings array we supplied, so the model selects
        // and orders rather than inventing content.
        findingIndex: z.number().int().min(0),
        title: z.string().trim().min(4).max(110),
        content: z.string().trim().min(10).max(600),
      }),
    )
    .max(12),
});

const NARRATION_SYSTEM = `You write short, concrete insight cards for a subscription-tracking app.

You are given a JSON array of findings that were computed by the app's analytics engine. Your job is to rewrite each one as a clear, friendly insight card, and to order them by how much the user would care.

Rules:
- Use ONLY the numbers present in the finding. Never invent, recompute, round differently, or extrapolate a figure.
- Refer to each finding by its index so the app can match your text back to the data.
- Titles: under 90 characters, specific, no clickbait, no emoji.
- Body: 1-2 sentences. Say what was found and what the user could do about it.
- Address the user as "you". Be direct and warm, never salesy or alarmist.
- Skip any finding that would not be useful to a normal person; simply omit its index.
- Do not mention that you are an AI, and do not describe your own reasoning.

Return JSON: { "insights": [ { "findingIndex": number, "title": string, "content": string } ] }`;

async function narrateWithClaude({ findings, context }) {
  const payload = findings.map((finding, index) => ({
    index,
    type: finding.insightType,
    severity: finding.severity,
    computedTitle: finding.title,
    computedDetail: finding.content,
    monthlySaving: finding.potentialSavings,
  }));

  const { data } = await completeJson({
    system: NARRATION_SYSTEM,
    schema: NarrationSchema,
    tier: 'smart',
    temperature: 0.4,
    messages: [
      {
        role: 'user',
        content: `Account context: ${JSON.stringify(context)}\n\nFindings:\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  // Re-attach the model's prose to the original computed rows. Anything
  // the model invented (an out-of-range index) is dropped rather than
  // trusted, and all numeric fields come from our own findings.
  const narrated = [];
  for (const item of data.insights) {
    const original = findings[item.findingIndex];
    if (!original) {
      log.warn('Model referenced a finding index that does not exist', { index: item.findingIndex });
      continue;
    }
    if (looksLikeRefusalOrEcho(item.content)) continue;
    narrated.push({ ...original, title: item.title, content: item.content, model: 'claude' });
  }
  // If narration produced nothing usable, keep the computed text.
  return narrated.length ? narrated : findings;
}

// ── Persistence ────────────────────────────────────────────────

/**
 * Upsert insights, keyed on fingerprint so nightly runs refresh existing
 * cards instead of piling up duplicates. Dismissed insights stay dismissed
 * within their month bucket.
 */
export async function persistInsights(userId, insights, { now = new Date(), model } = {}) {
  if (!insights.length) return [];
  const bucket = monthBucket(now);
  const saved = [];

  for (const insight of insights) {
    const print = fingerprint({
      insightType: insight.insightType,
      subscriptionIds: insight.relatedSubscriptionIds,
      bucket,
    });
    const row = await one(
      `INSERT INTO ai_insights
         (user_id, insight_type, severity, title, content, data, potential_savings,
          related_subscription_ids, model, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, fingerprint) WHERE fingerprint IS NOT NULL
       DO UPDATE SET
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         data = EXCLUDED.data,
         severity = EXCLUDED.severity,
         potential_savings = EXCLUDED.potential_savings,
         model = EXCLUDED.model,
         generated_at = now()
       RETURNING *`,
      [
        userId,
        insight.insightType,
        insight.severity ?? 'info',
        insight.title,
        insight.content,
        JSON.stringify(insight.data ?? {}),
        insight.potentialSavings ?? null,
        insight.relatedSubscriptionIds ?? [],
        insight.model ?? model ?? 'heuristic',
        print,
      ],
    );
    saved.push(row);
  }
  return saved;
}

/**
 * Full insight generation run.
 * Computes everything deterministically, optionally narrates with Claude,
 * then persists.
 */
export async function generateInsights(userId, { now = new Date(), persist = true, narrate = true } = {}) {
  const [report, forecast, trend, spendAnomalies, chargeAnomalies, budget, ranking, summary, subs] =
    await Promise.all([
      optimize(userId, { now }),
      forecastSpending(userId, { horizon: 3, now }),
      analyseTrend(userId),
      detectSpendAnomalies(userId),
      detectChargeAnomalies(userId),
      checkBudgetPressure(userId),
      valueRanking(userId, { now }),
      overview(userId, { now }),
      listForAnalysis(userId),
    ]);

  const renewals = findRenewalAlerts(subs, { now, withinDays: 5 });
  const costOutliers = detectCostOutliers(subs);

  let insights = templateInsights({
    findings: [...report.findings, ...renewals],
    forecast,
    trend,
    anomalies: [...spendAnomalies.anomalies, ...chargeAnomalies, ...costOutliers],
    ranking,
    budget,
    currency: summary.currency,
  });

  // Keep the feed readable: a user with 40 subscriptions could otherwise
  // generate 60 cards.
  const severityRank = { high: 3, medium: 2, low: 1, info: 0 };
  insights.sort(
    (a, b) =>
      severityRank[b.severity] - severityRank[a.severity] ||
      (b.potentialSavings ?? 0) - (a.potentialSavings ?? 0),
  );
  insights = insights.slice(0, 12);

  let model = 'heuristic';
  if (narrate && insights.length) {
    const result = await withFallback(
      async () => ({ insights: await narrateWithClaude({
        findings: insights,
        context: {
          monthlySpend: summary.spend.monthly,
          currency: summary.currency,
          activeSubscriptions: summary.counts.active,
          potentialMonthlySavings: report.totalPotentialSavings.monthly,
        },
      }) }),
      async () => ({ insights }),
      { label: 'insights.narrate' },
    );
    insights = result.insights;
    model = result.source === 'claude' ? 'claude' : 'heuristic';
  }

  const persisted = persist ? await persistInsights(userId, insights, { now, model }) : [];

  return {
    insights: persist ? persisted : insights,
    totalPotentialSavings: report.totalPotentialSavings,
    forecast,
    trend,
    generatedBy: model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * A short natural-language spending report — the "narrative report"
 * feature. Falls back to a templated summary without an API key.
 */
export async function narrativeReport(userId, { period = 'month', now = new Date() } = {}) {
  const [summary, report, trend, forecast, ranking, peers] = await Promise.all([
    overview(userId, { now }),
    optimize(userId, { now }),
    analyseTrend(userId),
    forecastSpending(userId, { horizon: 1, now }),
    valueRanking(userId, { now }),
    benchmark(userId),
  ]);

  const facts = {
    period,
    currency: summary.currency,
    monthlySpend: summary.spend.monthly,
    yearlySpend: summary.spend.yearly,
    activeSubscriptions: summary.counts.active,
    trials: summary.counts.trial,
    topSubscriptions: summary.topSubscriptions,
    potentialMonthlySavings: report.totalPotentialSavings.monthly,
    topFindings: report.findings.slice(0, 5).map((f) => ({ title: f.title, saving: f.monthlySaving })),
    trend: { direction: trend.direction, percentPerMonth: trend.percentPerMonth },
    nextMonthProjection: forecast.predictions[0]?.predicted ?? null,
    budget: summary.budget,
    worstValue: ranking.worst[0] ? { name: ranking.worst[0].name, valueScore: ranking.worst[0].valueScore } : null,
    peerComparison: peers.available ? peers.total.summary : null,
  };

  const result = await withFallback(
    async () => {
      const response = await complete({
        system: `You write a brief spending report for a subscription-tracking app.

You will receive a JSON object of pre-computed facts. Write 3 short paragraphs in plain prose:
  1. What the user currently spends and how it is trending.
  2. Where the money goes and anything notable about it.
  3. The single most valuable thing they could do next.

Rules:
- Use only the figures given. Never invent or recompute a number.
- Currency amounts should be written naturally (e.g. "$142.50 a month").
- No headings, no bullet points, no markdown. Warm, direct, specific.
- Under 220 words total.`,
        tier: 'smart',
        temperature: 0.5,
        maxTokens: 700,
        messages: [{ role: 'user', content: JSON.stringify(facts, null, 2) }],
      });
      if (looksLikeRefusalOrEcho(response.text)) {
        throw new Error('Unusable narrative response');
      }
      return { text: response.text };
    },
    async () => ({ text: templateNarrative(facts) }),
    { label: 'insights.narrative' },
  );

  return { report: result.text, facts, generatedBy: result.source };
}

/** Templated equivalent of the narrative report. */
function templateNarrative(facts) {
  const money = (value) => formatCurrency(value, facts.currency);
  const parts = [];

  parts.push(
    `You are currently tracking ${facts.activeSubscriptions} active subscription${facts.activeSubscriptions === 1 ? '' : 's'} costing ${money(facts.monthlySpend)} a month, or ${money(facts.yearlySpend)} a year.${
      facts.trend.direction === 'rising'
        ? ` Your spending has been rising by roughly ${Math.abs(facts.trend.percentPerMonth)}% a month.`
        : facts.trend.direction === 'falling'
          ? ` Your spending has been falling by roughly ${Math.abs(facts.trend.percentPerMonth)}% a month.`
          : ' Your spending has been broadly stable.'
    }${facts.nextMonthProjection != null ? ` Next month is projected at ${money(facts.nextMonthProjection)}.` : ''}`,
  );

  if (facts.topSubscriptions?.length) {
    const top = facts.topSubscriptions[0];
    parts.push(
      `Your largest commitment is ${top.name} at ${money(top.monthlyCost)} a month, ${top.shareOfSpend}% of your total. ${
        facts.topSubscriptions
          .slice(1, 3)
          .map((s) => `${s.name} (${money(s.monthlyCost)})`)
          .join(' and ') || ''
      }${facts.topSubscriptions.length > 1 ? ' follow behind.' : ''}${
        facts.peerComparison ? ` ${facts.peerComparison}` : ''
      }`,
    );
  }

  if (facts.potentialMonthlySavings > 0) {
    parts.push(
      `There is about ${money(facts.potentialMonthlySavings)} a month (${money(round2(facts.potentialMonthlySavings * 12))} a year) of identified savings available. The clearest opportunity: ${facts.topFindings[0]?.title ?? 'review your least-used subscriptions'}.`,
    );
  } else {
    parts.push(
      `Nothing obvious stands out as waste right now.${facts.worstValue ? ` The subscription earning its keep least is ${facts.worstValue.name}, scoring ${facts.worstValue.valueScore}/100 on value.` : ''} Keep logging usage and the value scores will sharpen.`,
    );
  }

  return parts.join('\n\n');
}

// ── Reads ──────────────────────────────────────────────────────

export async function listInsights(userId, { includeDismissed = false, limit = 50, type } = {}) {
  const params = [userId];
  const clauses = ['user_id = $1'];
  if (!includeDismissed) clauses.push('dismissed = false');
  if (type) {
    params.push(type);
    clauses.push(`insight_type = $${params.length}`);
  }
  params.push(limit);
  return many(
    `SELECT * FROM ai_insights
      WHERE ${clauses.join(' AND ')}
      ORDER BY CASE severity
                 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
               generated_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

export async function dismissInsight(userId, id) {
  const { rowCount } = await query(
    `UPDATE ai_insights SET dismissed = true, dismissed_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return { dismissed: rowCount > 0 };
}
