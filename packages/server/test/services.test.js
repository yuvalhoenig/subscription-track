/**
 * Unit tests for the pure analytical functions.
 * No database, no network — these are the functions that decide what the
 * app tells a user about their money, so they get tested directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDuplicates, findOverlaps, findUnused, comparePrices,
  findBundles, findFamilyPlanOpportunities, findRenewalAlerts, findAlternatives,
} from '../src/services/analytics/optimizer.js';
import {
  holtLinear, fitHolt, dampedTrendFactor, seasonalIndices,
} from '../src/services/analytics/forecast.js';
import {
  median, mad, robustScores, detectCostOutliers,
} from '../src/services/analytics/anomaly.js';
import {
  frequencyScore, valueScore, churnRisk, recommendationFor,
} from '../src/services/analytics/usage.js';
import { contentCandidates } from '../src/services/analytics/recommend.js';
import { extractHeuristically, missingFields } from '../src/services/ai/nlp.js';
import { categoriseLocally } from '../src/services/ai/categorize.js';
import {
  findTotal, findDate, findMerchant, parseReceiptHeuristically,
} from '../src/services/ai/receipts.js';
import {
  htmlToText, senderDomain, looksLikeSubscriptionEmail, parseEmailHeuristically,
} from '../src/services/ai/emailParser.js';
import { localHourToUtc, reminderLeadDays } from '../src/services/notifications/index.js';
import { extractJson, sanitiseOutput, looksLikeRefusalOrEcho } from '../src/services/ai/claude.js';

/** Build a subscription row shaped like `decorate()` output. */
const sub = (overrides = {}) => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  name: 'Thing',
  vendor_id: null,
  status: 'active',
  cost: 10,
  monthlyCost: 10,
  billing_cycle: 'monthly',
  currency: 'USD',
  nextRenewal: '2026-10-01',
  ...overrides,
});

// ── Optimiser ──────────────────────────────────────────────────

test('findDuplicates catches the same vendor tracked twice', () => {
  const findings = findDuplicates([
    sub({ id: 'a', name: 'Netflix', vendor_id: 'netflix', cost: 24.99, monthlyCost: 24.99 }),
    sub({ id: 'b', name: 'Netflix Premium', vendor_id: 'netflix', cost: 15.99, monthlyCost: 15.99 }),
    sub({ id: 'c', name: 'Spotify', vendor_id: 'spotify' }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  // The saving is the cheaper of the pair, not the sum.
  assert.equal(findings[0].monthlySaving, 15.99);
  assert.deepEqual(findings[0].subscriptionIds.sort(), ['a', 'b']);
});

test('findDuplicates does not flag genuinely different services', () => {
  const findings = findDuplicates([
    sub({ name: 'Netflix', vendor_id: 'netflix' }),
    sub({ name: 'Hulu', vendor_id: 'hulu' }),
    sub({ name: 'Disney+', vendor_id: 'disney-plus' }),
  ]);
  assert.equal(findings.length, 0);
});

test('findOverlaps groups interchangeable services without calling them duplicates', () => {
  const findings = findOverlaps([
    sub({ id: 'n', name: 'Netflix', vendor_id: 'netflix', monthlyCost: 24.99, uses_last_30d: 8 }),
    sub({ id: 'h', name: 'Hulu', vendor_id: 'hulu', monthlyCost: 18.99, uses_last_30d: 0 }),
    sub({ id: 'd', name: 'Disney+', vendor_id: 'disney-plus', monthlyCost: 15.99, uses_last_30d: 3 }),
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /3 video streaming services/);
  // Suggests dropping the least-used, not the cheapest.
  assert.equal(findings[0].monthlySaving, 18.99);
  assert.match(findings[0].detail, /Hulu is the least used/);
});

test('findUnused distinguishes "no usage data" from "not used"', () => {
  const noData = findUnused([sub({ name: 'Unknown', uses_last_90d: null })]);
  assert.equal(noData.length, 0, 'absent usage data must not be reported as unused');

  const unused = findUnused(
    [sub({ name: 'Peloton', cost: 44, monthlyCost: 44, uses_last_30d: 0, uses_last_90d: 0, last_used_at: null })],
    { now: new Date('2026-09-02') },
  );
  assert.equal(unused.length, 1);
  assert.equal(unused[0].severity, 'high');
  assert.equal(unused[0].monthlySaving, 44);

  const active = findUnused([
    sub({ uses_last_30d: 12, uses_last_90d: 30, last_used_at: '2026-09-01' }),
  ], { now: new Date('2026-09-02') });
  assert.equal(active.length, 0);
});

test('comparePrices only flags spend above the top of the market band', () => {
  // Netflix band is 7.99–24.99; 24.99 is at the top, so not a finding.
  assert.equal(comparePrices([sub({ name: 'Netflix', vendor_id: 'netflix', monthlyCost: 24.99 })]).length, 0);
  const over = comparePrices([sub({ name: 'Netflix', vendor_id: 'netflix', monthlyCost: 45 })]);
  assert.equal(over.length, 1);
  assert.ok(over[0].monthlySaving > 0);
});

test('findBundles spots a cheaper multi-service bundle', () => {
  const findings = findBundles([
    sub({ id: '1', name: 'Disney+', vendor_id: 'disney-plus', monthlyCost: 15.99 }),
    sub({ id: '2', name: 'Hulu', vendor_id: 'hulu', monthlyCost: 18.99 }),
    sub({ id: '3', name: 'ESPN+', vendor_id: 'espn-plus', monthlyCost: 11.99 }),
  ]);
  assert.equal(findings.length, 1);
  // 46.97 separately vs 26.99 bundled.
  assert.equal(findings[0].monthlySaving, 19.98);
});

test('family plan opportunities are not counted as banked savings', () => {
  const findings = findFamilyPlanOpportunities([
    sub({ name: 'Spotify', vendor_id: 'spotify', monthlyCost: 11.99 }),
  ]);
  assert.equal(findings.length, 1);
  // Sharing requires other people, so it must not inflate the savings total.
  assert.equal(findings[0].monthlySaving, 0);
  assert.ok(findings[0].potentialPerSeatSaving > 0);
});

test('renewal alerts prioritise trials and expensive plans', () => {
  const now = new Date('2026-09-02');
  const alerts = findRenewalAlerts([
    sub({ id: 't', name: 'Duolingo', status: 'trial', cost: 12.99, nextRenewal: '2026-09-04' }),
    sub({ id: 'c', name: 'Adobe', cost: 59.99, nextRenewal: '2026-09-06' }),
    sub({ id: 's', name: 'Small', cost: 3, nextRenewal: '2026-09-05' }),
    sub({ id: 'f', name: 'Far off', cost: 20, nextRenewal: '2026-12-01' }),
  ], { now, withinDays: 7 });
  assert.equal(alerts.length, 3, 'the December renewal is outside the window');
  assert.equal(alerts[0].severity, 'high', 'the trial is most urgent');
  assert.match(alerts[0].title, /trial ends in 2 days/);
  assert.equal(alerts.find((a) => a.subscriptionIds[0] === 'c').severity, 'medium');
  assert.equal(alerts.find((a) => a.subscriptionIds[0] === 's').severity, 'low');
});

test('findAlternatives returns cheaper services in the same group', () => {
  const alternatives = findAlternatives({
    id: 'max', overlapGroup: 'video-streaming', market: { typical: 16.99 },
  });
  assert.ok(alternatives.length > 0);
  assert.ok(alternatives.every((a) => a.market.typical < 16.99));
  // Cheapest first.
  assert.ok(alternatives[0].market.typical <= alternatives[alternatives.length - 1].market.typical);
});

// ── Forecasting ────────────────────────────────────────────────

test('holtLinear tracks level and trend on a clean ramp', () => {
  const model = holtLinear([100, 110, 120, 130, 140, 150], 0.8, 0.2);
  assert.ok(Math.abs(model.level - 150) < 8, `level ${model.level}`);
  assert.ok(model.trend > 5 && model.trend < 15, `trend ${model.trend}`);
  assert.equal(model.residuals.length, 5);
});

test('damped trend converges instead of extrapolating without bound', () => {
  // Undamped, 12 steps of trend would be 12x. Damped, it converges to
  // phi/(1-phi) = 5.67 at phi=0.85, which is what stops a two-month bump
  // becoming a doubling of forecast spend.
  assert.ok(dampedTrendFactor(1) < 1);
  assert.ok(dampedTrendFactor(12) < 6);
  assert.ok(dampedTrendFactor(100) < 5.7);
  // Monotonically increasing but bounded.
  assert.ok(dampedTrendFactor(5) > dampedTrendFactor(4));
});

test('fitHolt caps beta so it cannot chase spikes', () => {
  // A series with two large spikes; an unconstrained fit would pick a high
  // beta and read the spikes as a steep trend.
  const spiky = [400, 390, 410, 700, 395, 405, 880, 400];
  const fit = fitHolt(spiky);
  assert.ok(fit.beta <= 0.3, `beta ${fit.beta} must stay within the cap`);
  assert.ok(fit.alpha >= 0.1 && fit.alpha <= 0.9);
});

test('seasonalIndices requires two full cycles before claiming a pattern', () => {
  // 14 months is not enough, even with a clear December effect.
  const short = Array.from({ length: 14 }, (_, i) => ({
    month: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
    total: (i % 12) === 11 ? 400 : 100,
  }));
  assert.equal(seasonalIndices(short), null);

  // 24 months of a repeating December spike is a pattern.
  const long = Array.from({ length: 24 }, (_, i) => ({
    month: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
    total: (i % 12) === 11 ? 400 : 100,
  }));
  const indices = seasonalIndices(long);
  assert.ok(indices, 'two cycles should yield indices');
  assert.ok(indices[12] > 1.5, `December index ${indices[12]}`);
  assert.ok(indices[6] < 1);
});

test('seasonalIndices returns null for a flat series', () => {
  const flat = Array.from({ length: 24 }, (_, i) => ({
    month: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
    total: 100,
  }));
  assert.equal(seasonalIndices(flat), null);
});

// ── Anomaly detection ──────────────────────────────────────────

test('median and MAD', () => {
  assert.equal(median([1, 3, 2, 10]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([]), 0);
  assert.equal(mad([10, 10, 10, 10]), 0);
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
});

test('robust scores flag an outlier a mean-based z-score would miss', () => {
  const values = [100, 102, 98, 101, 400];
  const scores = robustScores(values);
  assert.ok(scores[4] > 3.5, `robust z ${scores[4]} should exceed the threshold`);

  // The same point under a classic z-score: the outlier inflates the
  // standard deviation it is measured against, so it scores under 2.
  const mu = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mu) ** 2, 0) / (values.length - 1));
  assert.ok((400 - mu) / sd < 2, 'classic z fails to detect it');
});

test('robust scores handle a constant series without dividing by zero', () => {
  const scores = robustScores([50, 50, 50, 65]);
  assert.ok(Number.isFinite(scores[3]));
  assert.ok(scores[3] > 3.5, 'a departure from a constant series is notable');
  assert.equal(scores[0], 0);
});

test('detectCostOutliers catches a likely data-entry error', () => {
  const subs = [
    sub({ cost: 10, monthlyCost: 10 }), sub({ cost: 12, monthlyCost: 12 }),
    sub({ cost: 9, monthlyCost: 9 }), sub({ cost: 11, monthlyCost: 11 }),
    // 1599 instead of 15.99
    sub({ name: 'Typo', cost: 1599, monthlyCost: 1599 }),
  ];
  const findings = detectCostOutliers(subs);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /Typo/);
});

// ── Usage scoring ──────────────────────────────────────────────

test('frequencyScore rewards volume and recency', () => {
  const daily = frequencyScore({ usesLast30d: 20, usesLast90d: 60, lastUsedAt: new Date(Date.now() - 86_400_000) });
  const never = frequencyScore({ usesLast30d: 0, usesLast90d: 0, lastUsedAt: null });
  const stale = frequencyScore({ usesLast30d: 0, usesLast90d: 2, lastUsedAt: new Date(Date.now() - 40 * 86_400_000) });
  assert.equal(never, 0);
  assert.ok(daily > 90, `daily ${daily}`);
  assert.ok(stale > 0 && stale < 30, `stale ${stale}`);
  assert.ok(daily > stale);
});

test('valueScore weighs usage against cost', () => {
  const goodValue = valueScore({ monthly: 15.99, usesLast30d: 20 });
  const expensiveUnused = valueScore({ monthly: 50, usesLast30d: 0 });
  const cheapUnused = valueScore({ monthly: 3, usesLast30d: 0 });
  const expensiveBarelyUsed = valueScore({ monthly: 60, usesLast30d: 1 });

  assert.ok(goodValue > 80, `good value ${goodValue}`);
  assert.equal(expensiveUnused, 0, 'expensive and unused is the worst case');
  // A cheap unused app is a small leak, not a crisis: it must score above
  // an expensive unused one.
  assert.ok(cheapUnused > expensiveUnused, `${cheapUnused} > ${expensiveUnused}`);
  assert.ok(expensiveBarelyUsed < 20, `barely used ${expensiveBarelyUsed}`);
  assert.equal(valueScore({ monthly: 0, usesLast30d: 0 }), 100, 'free is always good value');
});

test('churnRisk responds to the signals that precede cancellation', () => {
  const high = churnRisk({ usesLast30d: 0, usesLast90d: 0, monthly: 55, hadPriceIncrease: true, daysToRenewal: 3 });
  const low = churnRisk({ usesLast30d: 25, usesLast90d: 70, monthly: 4 });
  assert.ok(high > 0.85, `high ${high}`);
  assert.ok(low < 0.15, `low ${low}`);
  assert.equal(churnRisk({ status: 'cancelled' }), 1);
  assert.equal(churnRisk({ status: 'paused' }), 0.8);
  // Bounded to a probability-like range.
  assert.ok(churnRisk({ usesLast30d: 0, monthly: 1000, hadPriceIncrease: true, daysToRenewal: 0 }) <= 0.99);
});

test('recommendationFor gives an actionable verdict', () => {
  assert.equal(recommendationFor({ monthly: 16, usesLast30d: 20, value: 90 }).action, 'keep');
  assert.equal(recommendationFor({ monthly: 44, usesLast30d: 0, value: 3, daysSinceUse: 96 }).action, 'cancel');
  assert.equal(recommendationFor({ monthly: 3, usesLast30d: 0, value: 22 }).action, 'review');
  assert.equal(recommendationFor({ monthly: 60, usesLast30d: 2, value: 20 }).action, 'downgrade');
});

// ── Recommendations ────────────────────────────────────────────

test('contentCandidates finds gaps and cheaper substitutes', () => {
  const result = contentCandidates([
    sub({ name: 'Netflix', vendor_id: 'netflix', monthlyCost: 24.99, category: 'Streaming' }),
  ]);
  // No password manager or cloud storage held.
  assert.ok(result.gaps.some((g) => g.group === 'password-manager'));
  assert.ok(result.substitutes.length > 0);
  assert.ok(result.substitutes[0].estimatedSaving > 0);
});

// ── NLP ────────────────────────────────────────────────────────

test('extractHeuristically reads the common phrasings', () => {
  const now = new Date('2026-09-02');
  const cases = [
    ['I just got Netflix for $15.99/month', { name: 'Netflix', cost: 15.99, billingCycle: 'monthly' }],
    ['add my Adobe subscription for $52.99 per month', { name: 'Adobe Creative Cloud', cost: 52.99, billingCycle: 'monthly' }],
    ['Coursera Plus costs 399 annually', { name: 'Coursera Plus', cost: 399, billingCycle: 'yearly' }],
    ['I pay for a Todoist plan, 5 a month', { name: 'Todoist', cost: 5, billingCycle: 'monthly' }],
    ['netflx 15.99', { name: 'Netflix', cost: 15.99 }],
  ];
  for (const [input, expected] of cases) {
    const draft = extractHeuristically(input, { now });
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(draft[key], value, `${input} -> ${key}`);
    }
  }
});

test('extraction resolves relative and named dates', () => {
  const now = new Date('2026-09-02');
  assert.equal(extractHeuristically('Netflix $16/mo renews tomorrow', { now }).renewalDate, '2026-09-03');
  assert.equal(extractHeuristically('Netflix $16/mo renews in 10 days', { now }).renewalDate, '2026-09-12');
  assert.equal(extractHeuristically('Netflix $16/mo renews on the 14th', { now }).renewalDate, '2026-09-14');
  // A day already past this month rolls to next month.
  assert.equal(extractHeuristically('Netflix $16/mo renews on the 1st', { now }).renewalDate, '2026-10-01');
  // A named month with no year takes the next occurrence.
  assert.equal(extractHeuristically('Notion $12/mo starting March 15', { now }).renewalDate, '2027-03-15');
});

test('extraction detects trials and flags assumed cycles', () => {
  const trial = extractHeuristically('started a free trial of Notion, $12 monthly', { now: new Date('2026-09-02') });
  assert.equal(trial.status, 'trial');
  const assumed = extractHeuristically('Netflix costs 15.99', { now: new Date('2026-09-02') });
  assert.equal(assumed.billingCycle, 'monthly');
  assert.equal(assumed.assumedCycle, true, 'a guessed cycle must be marked as such');
});

test('extraction never invents a price', () => {
  const draft = extractHeuristically('I subscribed to something', { now: new Date('2026-09-02') });
  assert.equal(draft.cost, null);
  assert.equal(draft.billingCycle, null);
  assert.deepEqual(missingFields(draft).sort(), ['billingCycle', 'cost']);
});

// ── Categorisation ─────────────────────────────────────────────

test('categoriseLocally cascades catalogue then keywords', () => {
  assert.deepEqual(
    { ...categoriseLocally('Netflix'), vendorId: undefined },
    { category: 'Streaming', subcategory: 'Video', confidence: 0.95, method: 'catalog', vendorId: undefined },
  );
  assert.equal(categoriseLocally('Corner Street Gym').category, 'Health & Fitness');
  assert.equal(categoriseLocally('My Local Newspaper').category, 'News & Reading');
  assert.equal(categoriseLocally('Village Dental Clinic').category, 'Health & Fitness');
  assert.equal(categoriseLocally('Bob Random Thing'), null, 'unknown names escalate rather than guessing');
});

// ── Receipts ───────────────────────────────────────────────────

const RECEIPT = `NETFLIX
Thank you for your payment
Subtotal      $14.99
Tax            $1.00
Total         $15.99
Charged on 03/15/2026
Your monthly subscription renews automatically`;

test('findTotal prefers the total over subtotal and tax', () => {
  const { amount, currency } = findTotal(RECEIPT);
  assert.equal(amount, 15.99);
  assert.equal(currency, 'USD');
});

test('findTotal handles both decimal conventions', () => {
  assert.equal(findTotal('Total: $1,234.56').amount, 1234.56);
  assert.equal(findTotal('Total: €1.234,56').amount, 1234.56);
});

test('receipt date and merchant extraction', () => {
  assert.equal(findDate(RECEIPT), '2026-03-15');
  assert.equal(findDate('Invoice date 2026-04-01'), '2026-04-01');
  assert.equal(findDate('Billed 5 January 2026'), '2026-01-05');
  assert.equal(findMerchant(RECEIPT).name, 'Netflix');
});

test('parseReceiptHeuristically produces a usable draft', () => {
  const parsed = parseReceiptHeuristically(RECEIPT);
  assert.equal(parsed.merchant, 'Netflix');
  assert.equal(parsed.amount, 15.99);
  assert.equal(parsed.billingCycle, 'monthly');
  assert.equal(parsed.isSubscription, true);
  assert.equal(parsed.category, 'Streaming');
});

// ── E-mail parsing ─────────────────────────────────────────────

test('htmlToText strips markup and decodes entities', () => {
  const text = htmlToText('<p>Total&nbsp;$11.99</p><script>evil()</script><br>Renews &amp; repeats');
  assert.match(text, /Total \$11\.99/);
  assert.doesNotMatch(text, /evil|script/);
  assert.match(text, /Renews & repeats/);
});

test('senderDomain parses From headers', () => {
  assert.equal(senderDomain('Spotify <no-reply@spotify.com>'), 'spotify.com');
  assert.equal(senderDomain('billing@figma.com'), 'figma.com');
  assert.equal(senderDomain('not an address'), null);
});

test('e-mail pre-filter accepts receipts and rejects noise', () => {
  assert.equal(
    looksLikeSubscriptionEmail({
      from: 'no-reply@spotify.com',
      subject: 'Your Spotify Premium receipt',
      body: 'Total $11.99. Your monthly subscription renews on 04/12/2026.',
    }).likely,
    true,
  );
  assert.equal(
    looksLikeSubscriptionEmail({
      from: 'ship@amazon.com', subject: 'Your package has shipped', body: 'Tracking 1Z999',
    }).likely,
    false,
  );
  assert.equal(
    looksLikeSubscriptionEmail({ from: 'a@b.com', subject: 'Verify your email address', body: 'click here' }).likely,
    false,
  );
});

test('parseEmailHeuristically prefers the sender domain for identity', () => {
  const parsed = parseEmailHeuristically({
    from: 'Spotify <no-reply@spotify.com>',
    subject: 'Your receipt',
    body: 'Total $11.99 monthly subscription. Renews 04/12/2026.',
  });
  assert.equal(parsed.serviceName, 'Spotify');
  assert.equal(parsed.amount, 11.99);
  assert.equal(parsed.vendorId, 'spotify');
});

// ── Notification timing ────────────────────────────────────────

test('localHourToUtc converts a local send hour to an instant', () => {
  // 09:00 in New York during DST is 13:00 UTC.
  assert.equal(localHourToUtc('2026-07-15', 9, 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z');
  // 09:00 in Tokyo is 00:00 UTC the same day.
  assert.equal(localHourToUtc('2026-07-15', 9, 'Asia/Tokyo').toISOString(), '2026-07-15T00:00:00.000Z');
  // Winter, so EST rather than EDT: 14:00 UTC.
  assert.equal(localHourToUtc('2026-01-15', 9, 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
  // An unknown zone falls back to UTC instead of throwing.
  assert.equal(localHourToUtc('2026-07-15', 9, 'Not/AZone').toISOString(), '2026-07-15T09:00:00.000Z');
});

test('reminderLeadDays gives more notice for expensive commitments', () => {
  assert.equal(reminderLeadDays({ cost: 60, billingCycle: 'monthly', status: 'active' }), 7);
  assert.equal(reminderLeadDays({ cost: 25, billingCycle: 'monthly', status: 'active' }), 5);
  assert.equal(reminderLeadDays({ cost: 5, billingCycle: 'monthly', status: 'active' }), 3);
  // A yearly plan at $600 normalises to $50/month, so it gets the long lead.
  assert.equal(reminderLeadDays({ cost: 600, billingCycle: 'yearly', status: 'active' }), 7);
});

// ── Claude client helpers ──────────────────────────────────────

test('extractJson survives fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"b":[1,2]} hope that helps'), { b: [1, 2] });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});

test('sanitiseOutput strips anything executable and caps length', () => {
  assert.equal(sanitiseOutput('hi <script>alert(1)</script>there'), 'hi there');
  assert.doesNotMatch(sanitiseOutput('<iframe src=x></iframe>ok'), /iframe/);
  assert.doesNotMatch(sanitiseOutput('click javascript:alert(1)'), /javascript:/);
  assert.ok(sanitiseOutput('x'.repeat(20_000)).length <= 12_001);
  assert.equal(sanitiseOutput(null), '');
});

test('looksLikeRefusalOrEcho catches unusable narration', () => {
  assert.equal(looksLikeRefusalOrEcho('I cannot help with that request'), true);
  assert.equal(looksLikeRefusalOrEcho('As an AI language model, I...'), true);
  assert.equal(looksLikeRefusalOrEcho(''), true);
  assert.equal(looksLikeRefusalOrEcho('You could save $45 a month by consolidating streaming.'), false);
});
