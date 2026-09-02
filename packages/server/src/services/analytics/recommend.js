/**
 * Recommendations and peer benchmarking.
 *
 * Combines two classic approaches:
 *
 *  - **Content-based**: the shared service catalogue. If you hold three
 *    Streaming services and no password manager, the catalogue knows what
 *    a password manager is and what it costs.
 *  - **Collaborative**: item-to-item co-occurrence computed over all users'
 *    vendor ids. "People who track Spotify also track Notion."
 *
 * Privacy constraints on the collaborative half:
 *   - only `vendor_id` is read, never names, amounts or user ids;
 *   - a cohort must contain at least MIN_COHORT distinct users before it
 *     contributes, so a recommendation can never reveal one person's data;
 *   - benchmarks report percentile bands, not individual figures.
 *
 * On a fresh single-user install the collaborative half returns nothing and
 * the content-based half carries the feature. That is by design rather than
 * a failure — it's the cold-start path.
 */

import { round2, SERVICE_CATALOG, findService, overlapLabel } from '@subtrack/shared';
import { many, one } from '../../db/pool.js';
import { listForAnalysis } from '../subscriptions.js';

/** Minimum distinct users before an aggregate is allowed to be reported. */
const MIN_COHORT = 5;

/**
 * Services commonly held alongside the user's, from co-occurrence.
 * Returns [] rather than weak noise when the dataset is too small.
 */
export async function collaborativeCandidates(userId, heldVendorIds) {
  if (!heldVendorIds.length) return [];

  const rows = await many(
    `WITH peers AS (
       -- Other users who share at least one vendor with this user.
       SELECT DISTINCT user_id
         FROM subscriptions
        WHERE vendor_id = ANY($2::text[])
          AND user_id <> $1
          AND status <> 'cancelled'
     ),
     candidate_counts AS (
       SELECT s.vendor_id,
              count(DISTINCT s.user_id) AS holders
         FROM subscriptions s
         JOIN peers p ON p.user_id = s.user_id
        WHERE s.vendor_id IS NOT NULL
          AND NOT (s.vendor_id = ANY($2::text[]))
          AND s.status <> 'cancelled'
        GROUP BY s.vendor_id
     ),
     cohort AS (SELECT count(*) AS size FROM peers)
     SELECT c.vendor_id, c.holders, (SELECT size FROM cohort) AS cohort_size
       FROM candidate_counts c
      WHERE c.holders >= $3
      ORDER BY c.holders DESC
      LIMIT 10`,
    [userId, heldVendorIds, MIN_COHORT],
  );

  // Suppress the whole result if the peer cohort itself is too small to
  // be anonymous.
  if (!rows.length || Number(rows[0].cohort_size) < MIN_COHORT) return [];

  return rows.map((row) => ({
    vendorId: row.vendor_id,
    holders: Number(row.holders),
    cohortSize: Number(row.cohort_size),
    affinity: round2(Number(row.holders) / Number(row.cohort_size)),
  }));
}

/**
 * Catalogue-driven suggestions: gaps in the user's coverage, and cheaper
 * substitutes for what they already pay for.
 */
export function contentCandidates(subscriptions) {
  const held = new Set();
  const heldGroups = new Set();
  const categoryTotals = new Map();

  for (const sub of subscriptions) {
    if (sub.status === 'cancelled') continue;
    const service = findService(sub.vendor_id ?? sub.name);
    if (service) {
      held.add(service.id);
      if (service.overlapGroup) heldGroups.add(service.overlapGroup);
    }
    const category = sub.category ?? 'Uncategorised';
    categoryTotals.set(category, round2((categoryTotals.get(category) ?? 0) + sub.monthlyCost));
  }

  // Cheaper substitutes within a group the user already buys into.
  const substitutes = [];
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const service = findService(sub.vendor_id ?? sub.name);
    if (!service?.market || !service.overlapGroup) continue;
    const cheaper = SERVICE_CATALOG.filter(
      (candidate) =>
        candidate.overlapGroup === service.overlapGroup &&
        !held.has(candidate.id) &&
        candidate.market &&
        candidate.market.typical < sub.monthlyCost * 0.75,
    ).sort((a, b) => a.market.typical - b.market.typical);

    if (cheaper.length) {
      substitutes.push({
        kind: 'substitute',
        replaces: { id: sub.id, name: sub.name, monthly: sub.monthlyCost },
        service: cheaper[0],
        estimatedSaving: round2(sub.monthlyCost - cheaper[0].market.typical),
      });
    }
  }

  // Categories the user's peers commonly hold but this user has no
  // coverage for at all. Restricted to genuinely broadly-useful groups
  // rather than recommending everything in the catalogue.
  const usefulGaps = ['password-manager', 'cloud-storage', 'budgeting'];
  const gaps = usefulGaps
    .filter((group) => !heldGroups.has(group))
    .map((group) => {
      const options = SERVICE_CATALOG.filter((s) => s.overlapGroup === group && s.market)
        .sort((a, b) => a.market.typical - b.market.typical)
        .slice(0, 2);
      return options.length ? { kind: 'gap', group, label: overlapLabel(group), options } : null;
    })
    .filter(Boolean);

  return { substitutes: substitutes.slice(0, 3), gaps, categoryTotals };
}

/**
 * Combined recommendation set.
 * Content-based results are always available; collaborative ones are
 * added when the dataset is large enough to be both useful and anonymous.
 */
export async function recommendations(userId) {
  const subscriptions = await listForAnalysis(userId);
  const heldVendorIds = [
    ...new Set(subscriptions.map((s) => s.vendor_id).filter(Boolean)),
  ];

  const content = contentCandidates(subscriptions);
  const collaborative = await collaborativeCandidates(userId, heldVendorIds);

  const peerPicks = collaborative
    .map((candidate) => {
      const service = findService(candidate.vendorId);
      if (!service) return null;
      return {
        kind: 'peer',
        service,
        affinity: candidate.affinity,
        detail: `${Math.round(candidate.affinity * 100)}% of people tracking a similar mix also track ${service.name}.`,
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  return {
    substitutes: content.substitutes,
    gaps: content.gaps,
    peerPicks,
    // Tells the client why the peer section may be empty.
    collaborativeAvailable: peerPicks.length > 0,
    cohortSize: collaborative[0]?.cohortSize ?? 0,
  };
}

/**
 * Anonymous benchmarking against other users.
 *
 * Reports the user's percentile within the population for total spend and
 * per category. Suppressed entirely below MIN_COHORT users, and only ever
 * derived from aggregates.
 */
export async function benchmark(userId) {
  const population = await one(
    `SELECT count(DISTINCT user_id)::int AS users FROM subscriptions WHERE status = 'active'`,
  );
  if (!population || population.users < MIN_COHORT) {
    return {
      available: false,
      reason: `Benchmarks need at least ${MIN_COHORT} active users to stay anonymous (currently ${population?.users ?? 0}).`,
      population: population?.users ?? 0,
    };
  }

  const monthlyExpr = `
    CASE s.billing_cycle
      WHEN 'weekly'     THEN s.cost * 52 / 12
      WHEN 'biweekly'   THEN s.cost * 26 / 12
      WHEN 'monthly'    THEN s.cost
      WHEN 'quarterly'  THEN s.cost / 3
      WHEN 'semiannual' THEN s.cost / 6
      WHEN 'yearly'     THEN s.cost / 12
    END`;

  const totals = await one(
    `WITH per_user AS (
       SELECT user_id, sum(${monthlyExpr})::numeric(12,2) AS monthly
         FROM subscriptions s
        WHERE status = 'active'
        GROUP BY user_id
     )
     SELECT
       (SELECT monthly FROM per_user WHERE user_id = $1) AS user_monthly,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY monthly)::numeric(12,2) AS p25,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY monthly)::numeric(12,2) AS median,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY monthly)::numeric(12,2) AS p75,
       count(*)::int AS users,
       -- The user's own percentile rank in the population.
       (SELECT count(*)::numeric FROM per_user pu
         WHERE pu.monthly < (SELECT monthly FROM per_user WHERE user_id = $1)
       ) / GREATEST(count(*), 1) AS percentile
       FROM per_user`,
    [userId],
  );

  const userMonthly = totals?.user_monthly == null ? 0 : Number(totals.user_monthly);
  const percentile = totals?.percentile == null ? null : round2(Number(totals.percentile) * 100);

  const categories = await many(
    `WITH per_user_category AS (
       SELECT s.user_id,
              COALESCE(c.name, 'Uncategorised') AS category,
              sum(${monthlyExpr})::numeric(12,2) AS monthly
         FROM subscriptions s
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.status = 'active'
        GROUP BY 1, 2
     )
     SELECT category,
            count(*)::int AS users,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY monthly)::numeric(12,2) AS median,
            max(CASE WHEN user_id = $1 THEN monthly END)::numeric(12,2) AS user_monthly
       FROM per_user_category
      GROUP BY category
      -- Drop thin categories so no single user's spend is inferable.
      HAVING count(*) >= $2
      ORDER BY median DESC NULLS LAST`,
    [userId, MIN_COHORT],
  );

  return {
    available: true,
    population: Number(totals?.users ?? 0),
    total: {
      userMonthly,
      median: Number(totals?.median ?? 0),
      p25: Number(totals?.p25 ?? 0),
      p75: Number(totals?.p75 ?? 0),
      percentile,
      // Phrasing the UI can use directly.
      summary:
        percentile == null
          ? null
          : percentile >= 50
            ? `You spend more on subscriptions than ${Math.round(percentile)}% of SubTrack users.`
            : `You spend less on subscriptions than ${Math.round(100 - percentile)}% of SubTrack users.`,
    },
    categories: categories
      .filter((row) => row.user_monthly != null)
      .map((row) => ({
        category: row.category,
        userMonthly: Number(row.user_monthly),
        median: Number(row.median),
        users: row.users,
        ratio: Number(row.median) > 0
          ? round2(Number(row.user_monthly) / Number(row.median))
          : null,
      })),
  };
}
