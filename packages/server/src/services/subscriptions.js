/**
 * Subscription CRUD and the read models the dashboard depends on.
 *
 * Everything here is scoped by user_id in the SQL itself rather than
 * filtered after the fact, so a mismatched id returns "not found" instead
 * of leaking another account's row.
 */

import {
  nextRenewalDate,
  monthlyCost,
  yearlyCost,
  renewalsBetween,
  daysUntil,
  round2,
  addCycles,
  addDays,
  today,
  findService,
} from '@subtrack/shared';
import { one, many, query, tx } from '../db/pool.js';
import { notFound, badRequest } from '../lib/errors.js';
import { cache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const log = logger.child('subscriptions');

const SELECT_COLUMNS = `
  s.id, s.user_id, s.category_id, s.name, s.description, s.vendor_id, s.subcategory,
  s.cost, s.currency, s.billing_cycle, s.renewal_date, s.started_at, s.status,
  s.trial_ends_at, s.cancelled_at, s.auto_renew, s.url, s.notes,
  s.reminder_days_before, s.usage_score, s.value_score, s.ai_recommendation,
  s.ai_confidence, s.ai_reviewed_at, s.created_at, s.updated_at,
  c.name AS category_name, c.color AS category_color, c.icon AS category_icon`;

const FROM_CLAUSE = `FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id`;

/** Analytics reads are cached per user; any write clears the whole namespace. */
export async function invalidateUserCaches(userId) {
  await cache.delPattern(`analytics:${userId}:*`);
  await cache.delPattern(`insights:${userId}:*`);
}

/**
 * Decorate a raw row with the derived values every client needs, so the
 * normalisation rules live in exactly one place.
 */
export function decorate(row, now = new Date()) {
  if (!row) return null;
  const projectedRenewal =
    row.status === 'active' || row.status === 'trial'
      ? nextRenewalDate(row.renewal_date, row.billing_cycle, now)
      : row.renewal_date;
  return {
    ...row,
    cost: Number(row.cost),
    monthlyCost: monthlyCost(row.cost, row.billing_cycle),
    yearlyCost: yearlyCost(row.cost, row.billing_cycle),
    // The stored renewal_date can be stale if nobody has opened the app;
    // nextRenewal is always the next real charge.
    nextRenewal: projectedRenewal,
    daysUntilRenewal: daysUntil(projectedRenewal, now),
    category: row.category_name ?? 'Uncategorised',
  };
}

/** Resolve a free-text name against the shared catalogue. */
function resolveVendor(name) {
  const service = findService(name);
  return service ? { vendorId: service.id, subcategory: service.subcategory } : {};
}

/** Look up a category by name for this user, creating nothing. */
async function categoryIdByName(userId, name) {
  if (!name) return null;
  const row = await one(
    'SELECT id FROM categories WHERE user_id = $1 AND lower(name) = lower($2)',
    [userId, name],
  );
  return row?.id ?? null;
}

// ── Queries ────────────────────────────────────────────────────

export async function listSubscriptions(userId, filters = {}) {
  const clauses = ['s.user_id = $1'];
  const params = [userId];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`s.status = $${params.length}`);
  } else if (!filters.includeCancelled) {
    // Cancelled subscriptions are history, not part of the working set.
    clauses.push(`s.status <> 'cancelled'`);
  }
  if (filters.categoryId) {
    params.push(filters.categoryId);
    clauses.push(`s.category_id = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    clauses.push(`(s.name ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
  }

  // Sort keys are mapped through an allow-list; the client never supplies
  // raw SQL fragments.
  const sortColumns = {
    name: 's.name',
    cost: 's.cost',
    renewal: 's.renewal_date',
    created: 's.created_at',
    usage: 's.usage_score',
  };
  const sortColumn = sortColumns[filters.sort] ?? 's.renewal_date';
  const direction = filters.order === 'desc' ? 'DESC' : 'ASC';

  params.push(filters.limit ?? 200, filters.offset ?? 0);
  const rows = await many(
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE}
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${sortColumn} ${direction} NULLS LAST, s.name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((row) => decorate(row));
}

export async function getSubscription(userId, id) {
  const row = await one(
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  if (!row) throw notFound('Subscription not found');
  return decorate(row);
}

/** Lightweight rows for the AI/analytics services (no category join). */
export async function listForAnalysis(userId) {
  const rows = await many(
    `SELECT ${SELECT_COLUMNS},
            u.uses_last_30d, u.uses_last_90d, u.last_used_at,
            u.frequency_score, u.cost_per_use, u.churn_risk
       ${FROM_CLAUSE}
       LEFT JOIN usage_analytics u ON u.subscription_id = s.id
      WHERE s.user_id = $1 AND s.status <> 'cancelled'
      ORDER BY s.cost DESC`,
    [userId],
  );
  return rows.map((row) => decorate(row));
}

// ── Mutations ──────────────────────────────────────────────────

export async function createSubscription(userId, input) {
  const vendor = resolveVendor(input.name);
  const categoryId =
    input.categoryId ?? (input.category ? await categoryIdByName(userId, input.category) : null);

  // A trial with no explicit renewal date renews when the trial ends.
  const renewalDate =
    input.renewalDate ?? (input.status === 'trial' ? input.trialEndsAt : null) ?? today();

  const row = await one(
    `INSERT INTO subscriptions
       (user_id, category_id, name, description, vendor_id, subcategory, cost, currency,
        billing_cycle, renewal_date, started_at, status, trial_ends_at, auto_renew,
        url, notes, reminder_days_before)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      userId,
      categoryId,
      input.name,
      input.description ?? null,
      input.vendorId ?? vendor.vendorId ?? null,
      input.subcategory ?? vendor.subcategory ?? null,
      input.cost,
      input.currency ?? 'USD',
      input.billingCycle,
      renewalDate,
      input.startedAt ?? today(),
      input.status ?? 'active',
      input.trialEndsAt ?? null,
      input.autoRenew ?? true,
      input.url ?? null,
      input.notes ?? null,
      input.reminderDaysBefore ?? 3,
    ],
  );

  await invalidateUserCaches(userId);
  log.info('Subscription created', { userId, subscriptionId: row.id, name: input.name });
  return getSubscription(userId, row.id);
}

const UPDATABLE = {
  name: 'name',
  description: 'description',
  categoryId: 'category_id',
  subcategory: 'subcategory',
  cost: 'cost',
  currency: 'currency',
  billingCycle: 'billing_cycle',
  renewalDate: 'renewal_date',
  startedAt: 'started_at',
  status: 'status',
  trialEndsAt: 'trial_ends_at',
  autoRenew: 'auto_renew',
  url: 'url',
  notes: 'notes',
  reminderDaysBefore: 'reminder_days_before',
  vendorId: 'vendor_id',
};

export async function updateSubscription(userId, id, patch) {
  const existing = await one(
    'SELECT id, cost, billing_cycle, status FROM subscriptions WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!existing) throw notFound('Subscription not found');

  // Allow `category` by name as a convenience for the AI assistant, which
  // works in names rather than ids.
  if (patch.category && !patch.categoryId) {
    patch.categoryId = await categoryIdByName(userId, patch.category);
  }

  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      fields.push(`${column} = $${params.length}`);
    }
  }
  // Cancelling stamps the date so reports can show when spend stopped.
  if (patch.status === 'cancelled') {
    fields.push(`cancelled_at = COALESCE(cancelled_at, CURRENT_DATE)`);
  } else if (patch.status && patch.status !== 'cancelled') {
    fields.push('cancelled_at = NULL');
  }
  if (!fields.length) throw badRequest('No changes supplied');

  params.push(id, userId);

  const updated = await tx(async (db) => {
    const row = await db.one(
      `UPDATE subscriptions SET ${fields.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}
        RETURNING id, cost, billing_cycle`,
      params,
    );
    // Record price movements so the optimiser can flag increases later.
    const costChanged = patch.cost !== undefined && Number(patch.cost) !== Number(existing.cost);
    const cycleChanged = patch.billingCycle !== undefined && patch.billingCycle !== existing.billing_cycle;
    if (costChanged || cycleChanged) {
      await db.query(
        `INSERT INTO price_history
           (subscription_id, user_id, old_cost, new_cost, old_cycle, new_cycle)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, userId, existing.cost, row.cost, existing.billing_cycle, row.billing_cycle],
      );
      log.info('Price change recorded', { subscriptionId: id, from: existing.cost, to: row.cost });
    }
    return row;
  });

  await invalidateUserCaches(userId);
  return getSubscription(userId, updated.id);
}

export async function deleteSubscription(userId, id) {
  const { rowCount } = await query('DELETE FROM subscriptions WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (!rowCount) throw notFound('Subscription not found');
  await invalidateUserCaches(userId);
  return { deleted: true };
}

/**
 * Cancel rather than delete: keeps payment history and lets reports show
 * the saving. This is what the "cancel" action in the UI calls.
 */
export async function cancelSubscription(userId, id) {
  return updateSubscription(userId, id, { status: 'cancelled', autoRenew: false });
}

// ── Payments ───────────────────────────────────────────────────

export async function recordPayment(userId, subscriptionId, input) {
  const sub = await one(
    'SELECT id, cost, currency, billing_cycle, renewal_date FROM subscriptions WHERE id = $1 AND user_id = $2',
    [subscriptionId, userId],
  );
  if (!sub) throw notFound('Subscription not found');

  const payment = await tx(async (db) => {
    const row = await db.one(
      `INSERT INTO payment_history
         (subscription_id, user_id, payment_date, amount, currency, status, method, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        subscriptionId,
        userId,
        input.paymentDate ?? today(),
        input.amount ?? sub.cost,
        input.currency ?? sub.currency,
        input.status ?? 'paid',
        input.method ?? null,
        input.note ?? null,
      ],
    );
    // A successful payment moves the renewal date to the next period.
    if ((input.status ?? 'paid') === 'paid' && input.advanceRenewal !== false) {
      await db.query(
        'UPDATE subscriptions SET renewal_date = $1 WHERE id = $2',
        [addCycles(sub.renewal_date, sub.billing_cycle, 1), subscriptionId],
      );
    }
    return row;
  });

  await invalidateUserCaches(userId);
  return payment;
}

export async function listPayments(userId, { subscriptionId, limit = 100, offset = 0 } = {}) {
  const params = [userId];
  let filter = '';
  if (subscriptionId) {
    params.push(subscriptionId);
    filter = `AND p.subscription_id = $${params.length}`;
  }
  params.push(limit, offset);
  return many(
    `SELECT p.*, s.name AS subscription_name, s.billing_cycle
       FROM payment_history p
       JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.user_id = $1 ${filter}
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

// ── Calendar / upcoming ────────────────────────────────────────

/**
 * Every renewal falling in the next `days`, expanded per occurrence — a
 * weekly subscription appears four or five times in a 30-day window, which
 * is what a calendar needs.
 */
export async function upcomingRenewals(userId, { days = 30, now = new Date() } = {}) {
  const subs = await listSubscriptions(userId);
  const from = today(now);
  const horizon = addDays(from, days);

  const events = [];
  for (const sub of subs) {
    if (sub.status !== 'active' && sub.status !== 'trial') continue;
    for (const date of renewalsBetween(sub.renewal_date, sub.billing_cycle, now, horizon)) {
      events.push({
        subscriptionId: sub.id,
        name: sub.name,
        category: sub.category,
        categoryColor: sub.category_color,
        cost: sub.cost,
        currency: sub.currency,
        billingCycle: sub.billing_cycle,
        status: sub.status,
        date,
        daysUntil: daysUntil(date, now),
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.cost - a.cost));
  return {
    from,
    until: horizon,
    total: round2(events.reduce((sum, event) => sum + event.cost, 0)),
    count: events.length,
    events,
  };
}

// ── Usage tracking ─────────────────────────────────────────────

/**
 * Record that a subscription was used, and refresh its rollup.
 * The desktop app calls this when it detects app activity; the web app
 * exposes it as an "I used this" button.
 */
export async function recordUsage(userId, subscriptionId, { occurredAt, source = 'manual', weight = 1 } = {}) {
  const sub = await one(
    'SELECT id, cost, billing_cycle FROM subscriptions WHERE id = $1 AND user_id = $2',
    [subscriptionId, userId],
  );
  if (!sub) throw notFound('Subscription not found');

  await tx(async (db) => {
    await db.query(
      `INSERT INTO usage_events (subscription_id, user_id, occurred_at, source, weight)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5)`,
      [subscriptionId, userId, occurredAt ?? null, source, weight],
    );
    // Recompute the rollup from the events table so it can never drift
    // away from the underlying facts.
    await db.query(
      `INSERT INTO usage_analytics (subscription_id, user_id, last_used_at, uses_last_30d, uses_last_90d)
       SELECT $1, $2, max(occurred_at),
              count(*) FILTER (WHERE occurred_at > now() - interval '30 days'),
              count(*) FILTER (WHERE occurred_at > now() - interval '90 days')
         FROM usage_events WHERE subscription_id = $1
       ON CONFLICT (subscription_id) DO UPDATE SET
         last_used_at = EXCLUDED.last_used_at,
         uses_last_30d = EXCLUDED.uses_last_30d,
         uses_last_90d = EXCLUDED.uses_last_90d,
         updated_at = now()`,
      [subscriptionId, userId],
    );
  });

  await invalidateUserCaches(userId);
  return { recorded: true };
}
