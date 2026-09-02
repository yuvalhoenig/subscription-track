/**
 * Cost optimisation engine.
 *
 * Pure functions over a subscription list plus a couple of database-backed
 * wrappers. Everything here is deterministic and testable — no LLM — which
 * matters because these are the numbers we put in front of a user as
 * "you could save $X". Claude is used later (in ./insights.js) to *narrate*
 * these findings, never to compute them.
 */

import {
  round2,
  monthlyCost,
  findService,
  nameSimilarity,
  overlapLabel,
  BUNDLES,
  SERVICE_CATALOG,
  daysUntil,
} from '@subtrack/shared';
import { many } from '../../db/pool.js';
import { listForAnalysis } from '../subscriptions.js';

/** Below this, a subscription counts as unused. */
const UNUSED_USES_30D = 1;
/** Days of silence before we call a subscription dormant. */
const DORMANT_DAYS = 30;
/** Name similarity above which two entries are probably the same service. */
const DUPLICATE_THRESHOLD = 0.85;

/**
 * Near-identical entries — the same service tracked twice.
 * Usually an import artefact or two people in a household adding the same
 * thing, and always worth flagging because it double-counts spend.
 */
export function findDuplicates(subscriptions) {
  const active = subscriptions.filter((s) => s.status !== 'cancelled');
  const findings = [];
  const seen = new Set();

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const pairKey = [a.id, b.id].sort().join(':');
      if (seen.has(pairKey)) continue;

      const sameVendor = a.vendor_id && b.vendor_id && a.vendor_id === b.vendor_id;
      const similarity = nameSimilarity(a.name, b.name);
      if (!sameVendor && similarity < DUPLICATE_THRESHOLD) continue;

      seen.add(pairKey);
      // The cheaper of the two is what you'd save by dropping one.
      const saving = Math.min(a.monthlyCost, b.monthlyCost);
      findings.push({
        type: 'duplicate',
        severity: sameVendor ? 'high' : 'medium',
        subscriptionIds: [a.id, b.id],
        title: `${a.name} looks like a duplicate of ${b.name}`,
        detail: sameVendor
          ? `Both entries point at the same service (${a.name}). You are being counted twice for it.`
          : `"${a.name}" and "${b.name}" are ${Math.round(similarity * 100)}% name-identical, so one may be a duplicate entry.`,
        monthlySaving: round2(saving),
        yearlySaving: round2(saving * 12),
        confidence: sameVendor ? 0.95 : round2(similarity),
      });
    }
  }
  return findings;
}

/**
 * Overlapping services — different products doing the same job.
 * Four video streamers is not a duplicate, but it is a consolidation
 * opportunity, so these are reported separately and more gently.
 */
export function findOverlaps(subscriptions) {
  const groups = new Map();
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const service = sub.vendor_id ? findService(sub.vendor_id) : findService(sub.name);
    const group = service?.overlapGroup;
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(sub);
  }

  const findings = [];
  for (const [group, members] of groups) {
    if (members.length < 2) continue;
    const sorted = members.slice().sort((a, b) => b.monthlyCost - a.monthlyCost);
    const total = round2(sorted.reduce((sum, s) => sum + s.monthlyCost, 0));
    // Assume you keep the most-used one and drop the cheapest of the rest —
    // a conservative estimate rather than "cancel everything but one".
    const dropCandidate = sorted
      .slice()
      .sort((a, b) => (a.uses_last_30d ?? 0) - (b.uses_last_30d ?? 0))[0];
    findings.push({
      type: 'duplicate',
      severity: members.length >= 3 ? 'medium' : 'low',
      subscriptionIds: sorted.map((s) => s.id),
      title: `You have ${members.length} ${overlapLabel(group)}`,
      detail: `${sorted.map((s) => s.name).join(', ')} together cost ${total}/month. ${
        dropCandidate
          ? `${dropCandidate.name} is the least used of them.`
          : 'Consider whether you need all of them.'
      }`,
      monthlySaving: round2(dropCandidate?.monthlyCost ?? 0),
      yearlySaving: round2((dropCandidate?.monthlyCost ?? 0) * 12),
      confidence: 0.7,
      data: { group, members: sorted.map((s) => ({ id: s.id, name: s.name, monthly: s.monthlyCost })) },
    });
  }
  return findings;
}

/**
 * Subscriptions the user is paying for but not using.
 * Requires actual usage signal — we never call something unused just
 * because no usage was ever recorded, which would flag every subscription
 * for a user who has not connected anything.
 */
export function findUnused(subscriptions, { now = new Date() } = {}) {
  const findings = [];
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    // No usage row at all means "unknown", not "unused".
    if (sub.uses_last_90d == null) continue;

    const uses30 = Number(sub.uses_last_30d ?? 0);
    const lastUsed = sub.last_used_at ? new Date(sub.last_used_at) : null;
    const daysSince = lastUsed
      ? Math.floor((now - lastUsed) / 86_400_000)
      : Number(sub.uses_last_90d) === 0
        ? 90
        : null;

    if (uses30 > UNUSED_USES_30D || daysSince == null || daysSince < DORMANT_DAYS) continue;

    findings.push({
      type: 'unused',
      severity: sub.monthlyCost >= 15 ? 'high' : 'medium',
      subscriptionIds: [sub.id],
      title: `${sub.name} has not been used in ${daysSince >= 90 ? '90+' : daysSince} days`,
      detail: `You are paying ${sub.monthlyCost}/month (${round2(sub.monthlyCost * 12)}/year) for ${sub.name} with ${uses30} recorded uses in the last 30 days.`,
      monthlySaving: sub.monthlyCost,
      yearlySaving: round2(sub.monthlyCost * 12),
      confidence: daysSince >= 60 ? 0.9 : 0.75,
      data: { daysSinceLastUse: daysSince, usesLast30d: uses30 },
    });
  }
  return findings.sort((a, b) => b.monthlySaving - a.monthlySaving);
}

/**
 * Compare each subscription against the catalogue's market band.
 * Only flags a genuine overpay — above the high end of the band — because
 * "you pay more than the cheapest tier" is noise when the user
 * deliberately bought a bigger plan.
 */
export function comparePrices(subscriptions) {
  const findings = [];
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const service = findService(sub.vendor_id ?? sub.name);
    if (!service?.market) continue;

    const { low, typical, high } = service.market;
    const paying = sub.monthlyCost;
    // A 5% tolerance stops rounding and regional pricing generating alerts.
    if (paying <= high * 1.05) continue;

    const saving = round2(paying - typical);
    if (saving < 1) continue;

    findings.push({
      type: 'savings',
      severity: saving >= 10 ? 'medium' : 'low',
      subscriptionIds: [sub.id],
      title: `${sub.name} costs more than the usual market rate`,
      detail: `You pay ${paying}/month. ${service.name} typically runs ${low}–${high}/month (commonly ${typical}). Switching to a standard plan could save about ${saving}/month.`,
      monthlySaving: saving,
      yearlySaving: round2(saving * 12),
      confidence: 0.6,
      data: { paying, market: service.market },
    });
  }
  return findings;
}

/** Family/multi-seat plans that beat the user's current per-seat spend. */
export function findFamilyPlanOpportunities(subscriptions) {
  const findings = [];
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const service = findService(sub.vendor_id ?? sub.name);
    const family = service?.familyPlan;
    if (!family) continue;

    // Only useful when the family tier costs less per seat than what they
    // pay now for one seat — i.e. there is headroom to share.
    const perSeat = round2(family.monthly / family.seats);
    if (perSeat >= sub.monthlyCost) continue;

    findings.push({
      type: 'bundle',
      severity: 'low',
      subscriptionIds: [sub.id],
      title: `${sub.name} has a family plan worth considering`,
      detail: `${family.name} is ${family.monthly}/month for ${family.seats} people — ${perSeat} each, against the ${sub.monthlyCost}/month you pay now. Worth it if you can share with ${family.seats - 1} other${family.seats - 1 === 1 ? '' : 's'}.`,
      // Sharing needs other people, so this is an opportunity rather than a
      // saving we can bank; report it without inflating the savings total.
      monthlySaving: 0,
      yearlySaving: 0,
      potentialPerSeatSaving: round2(sub.monthlyCost - perSeat),
      confidence: 0.5,
      data: { familyPlan: family, perSeat },
    });
  }
  return findings;
}

/** Multi-service bundles (Disney Bundle, Apple One, …) the user qualifies for. */
export function findBundles(subscriptions) {
  const active = subscriptions.filter((s) => s.status === 'active');
  const byVendor = new Map();
  for (const sub of active) {
    const service = findService(sub.vendor_id ?? sub.name);
    if (service) byVendor.set(service.id, sub);
  }

  const findings = [];
  for (const bundle of BUNDLES) {
    const held = bundle.members.filter((id) => byVendor.has(id));
    if (held.length < (bundle.minMembers ?? 2)) continue;

    const currentSpend = round2(held.reduce((sum, id) => sum + byVendor.get(id).monthlyCost, 0));
    const saving = round2(currentSpend - bundle.monthly);
    if (saving < 1) continue;

    findings.push({
      type: 'bundle',
      severity: saving >= 10 ? 'medium' : 'low',
      subscriptionIds: held.map((id) => byVendor.get(id).id),
      title: `${bundle.name} would cost less than your current plans`,
      detail: `${held.map((id) => byVendor.get(id).name).join(', ')} cost ${currentSpend}/month separately. ${bundle.name} is ${bundle.monthly}/month. ${bundle.note}`,
      monthlySaving: saving,
      yearlySaving: round2(saving * 12),
      confidence: 0.8,
      data: { bundle: bundle.id, currentSpend, bundlePrice: bundle.monthly },
    });
  }
  return findings;
}

/** Renewals close enough to act on, weighted by cost. */
export function findRenewalAlerts(subscriptions, { now = new Date(), withinDays = 7 } = {}) {
  return subscriptions
    .filter((sub) => {
      if (sub.status !== 'active' && sub.status !== 'trial') return false;
      const days = daysUntil(sub.nextRenewal ?? sub.renewal_date, now);
      return days >= 0 && days <= withinDays;
    })
    .map((sub) => {
      const days = daysUntil(sub.nextRenewal ?? sub.renewal_date, now);
      const isTrial = sub.status === 'trial';
      return {
        type: 'renewal',
        // A trial converting is the moment a user most wants a nudge.
        severity: isTrial ? 'high' : sub.cost >= 50 ? 'medium' : 'low',
        subscriptionIds: [sub.id],
        title: isTrial
          ? `Your ${sub.name} trial ends ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`
          : `${sub.name} renews ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
        detail: isTrial
          ? `${sub.name} starts charging ${sub.cost} ${sub.currency} (${sub.billing_cycle}) once the trial ends. Cancel before then if you do not want it.`
          : `${sub.name} will charge ${sub.cost} ${sub.currency} on ${sub.nextRenewal ?? sub.renewal_date}.`,
        monthlySaving: 0,
        yearlySaving: 0,
        confidence: 1,
        data: { daysUntil: days, isTrial, amount: sub.cost },
      };
    })
    .sort((a, b) => a.data.daysUntil - b.data.daysUntil);
}

/**
 * Price increases recorded in price_history.
 * Reads the database because a price rise is a historical fact, not
 * something derivable from the current row.
 */
export async function findPriceIncreases(userId, { sinceDays = 180 } = {}) {
  const rows = await many(
    `SELECT ph.subscription_id, s.name, s.billing_cycle, s.status,
            ph.old_cost, ph.new_cost, ph.old_cycle, ph.new_cycle, ph.changed_at
       FROM price_history ph
       JOIN subscriptions s ON s.id = ph.subscription_id
      WHERE ph.user_id = $1
        AND ph.changed_at > now() - make_interval(days => $2::int)
        AND s.status <> 'cancelled'
      ORDER BY ph.changed_at DESC`,
    [userId, sinceDays],
  );

  return rows
    .filter((row) => {
      // Compare like with like: a cycle change can look like a huge rise.
      const before = monthlyCost(row.old_cost, row.old_cycle ?? row.billing_cycle);
      const after = monthlyCost(row.new_cost, row.new_cycle ?? row.billing_cycle);
      return after > before;
    })
    .map((row) => {
      const before = monthlyCost(row.old_cost, row.old_cycle ?? row.billing_cycle);
      const after = monthlyCost(row.new_cost, row.new_cycle ?? row.billing_cycle);
      const delta = round2(after - before);
      const percent = before > 0 ? round2((delta / before) * 100) : null;
      const service = findService(row.name);
      const alternatives = service
        ? findAlternatives(service).slice(0, 3)
        : [];
      return {
        type: 'price_increase',
        severity: percent != null && percent >= 20 ? 'high' : 'medium',
        subscriptionIds: [row.subscription_id],
        title: `${row.name} went up ${percent != null ? `${percent}%` : `${delta}/month`}`,
        detail: `${row.name} rose from ${before} to ${after} per month on ${new Date(row.changed_at).toISOString().slice(0, 10)}, costing you an extra ${round2(delta * 12)} a year.${
          alternatives.length ? ` Comparable options: ${alternatives.map((a) => `${a.name} (~${a.market.typical}/mo)`).join(', ')}.` : ''
        }`,
        monthlySaving: 0,
        yearlySaving: 0,
        extraMonthlyCost: delta,
        confidence: 1,
        data: { before, after, percent, changedAt: row.changed_at, alternatives: alternatives.map((a) => a.id) },
      };
    });
}

/**
 * Cheaper catalogue entries serving the same need, cheapest first.
 * Used to suggest alternatives when a service raises its price.
 */
export function findAlternatives(service) {
  if (!service?.overlapGroup || !service.market) return [];
  return SERVICE_CATALOG.filter(
    (candidate) =>
      candidate.id !== service.id &&
      candidate.overlapGroup === service.overlapGroup &&
      candidate.market &&
      candidate.market.typical < service.market.typical,
  ).sort((a, b) => a.market.typical - b.market.typical);
}

/**
 * Run every optimiser and return one ranked report.
 * `totalPotentialSavings` deliberately counts each subscription only once,
 * so overlapping findings (unused *and* overpriced) can't inflate the
 * headline number into something the user will never actually save.
 */
export async function optimize(userId, { now = new Date() } = {}) {
  const subscriptions = await listForAnalysis(userId);

  const findings = [
    ...findDuplicates(subscriptions),
    ...findOverlaps(subscriptions),
    ...findUnused(subscriptions, { now }),
    ...comparePrices(subscriptions),
    ...findBundles(subscriptions),
    ...findFamilyPlanOpportunities(subscriptions),
    ...(await findPriceIncreases(userId)),
  ];

  const severityRank = { high: 3, medium: 2, low: 1, info: 0 };
  findings.sort(
    (a, b) =>
      severityRank[b.severity] - severityRank[a.severity] ||
      b.monthlySaving - a.monthlySaving,
  );

  // De-duplicate savings by subscription: the first (highest-severity)
  // finding for a subscription is the one whose saving we count.
  const counted = new Set();
  let totalMonthly = 0;
  for (const finding of findings) {
    if (!finding.monthlySaving) continue;
    const primary = finding.subscriptionIds[0];
    if (counted.has(primary)) continue;
    counted.add(primary);
    totalMonthly += finding.monthlySaving;
  }

  return {
    findings,
    totalPotentialSavings: {
      monthly: round2(totalMonthly),
      yearly: round2(totalMonthly * 12),
    },
    analysed: subscriptions.length,
    generatedAt: new Date().toISOString(),
  };
}
