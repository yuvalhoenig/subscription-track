/**
 * Notifications: renewal reminders, trial warnings, budget alerts and
 * insight digests.
 *
 * Delivery model: rows are inserted into `notifications` with a
 * `scheduled_for` timestamp and a `dedupe_key`. A worker claims due rows,
 * sends them, and stamps `sent_at`. Two consequences worth noting:
 *
 *  - The unique index on `dedupe_key` makes scheduling idempotent, so the
 *    cron job can run every 15 minutes (or twice at once, on two
 *    instances) without ever double-notifying.
 *  - Claiming rows with `FOR UPDATE SKIP LOCKED` means multiple workers
 *    can drain the queue concurrently without sending the same reminder
 *    twice.
 *
 * "Intelligent timing" is a per-user quiet-hours model: reminders land in
 * the morning in the user's own timezone rather than whenever the cron
 * happens to fire, and high-value renewals get an earlier heads-up
 * because they take longer to decide about.
 */

import { daysUntil, formatCurrency, monthlyCost, round2 } from '@subtrack/shared';
import { many, one, query } from '../../db/pool.js';
import { mailer } from '../mailer.js';
import { logger } from '../../lib/logger.js';

const log = logger.child('notify');

/** Default local hour to deliver reminders. */
const DEFAULT_SEND_HOUR = 9;

/**
 * Convert "09:00 local" into a UTC instant for a given date.
 * Uses Intl rather than a timezone library: we only need the offset for
 * one instant, and Intl already ships the full tz database.
 */
export function localHourToUtc(dateIso, hour, timezone = 'UTC') {
  const naive = new Date(`${dateIso}T${String(hour).padStart(2, '0')}:00:00Z`);
  try {
    // Render the naive instant in the target zone, then measure the drift
    // between what we asked for and what that zone shows.
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(naive).filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    const asSeenLocally = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    const offsetMs = asSeenLocally - naive.getTime();
    return new Date(naive.getTime() - offsetMs);
  } catch {
    // Unknown timezone string: fall back to UTC rather than failing.
    log.warn('Unknown timezone; scheduling in UTC', { timezone });
    return naive;
  }
}

/**
 * When to send a reminder for a renewal.
 *
 * Expensive commitments get more notice: cancelling a $600/year plan is a
 * decision, while a $5/month app is a shrug. Trials always get the
 * earliest warning we can give, because the cost of missing one is the
 * whole first period.
 */
export function reminderLeadDays({ cost, billingCycle, status, reminderDaysBefore }) {
  if (status === 'trial') return Math.max(2, reminderDaysBefore ?? 3);
  const monthly = monthlyCost(cost, billingCycle);
  if (monthly >= 50) return Math.max(7, reminderDaysBefore ?? 3);
  if (monthly >= 20) return Math.max(5, reminderDaysBefore ?? 3);
  return reminderDaysBefore ?? 3;
}

/**
 * Queue reminders for everything renewing soon.
 * Idempotent: the dedupe key pins one notification per subscription per
 * renewal date.
 */
export async function scheduleRenewalReminders({ now = new Date(), horizonDays = 14 } = {}) {
  const rows = await many(
    `SELECT s.id, s.user_id, s.name, s.cost, s.currency, s.billing_cycle,
            s.renewal_date, s.status, s.trial_ends_at, s.reminder_days_before,
            u.email, u.name AS user_name, u.timezone, u.email_verified, u.preferences
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('active','trial')
        AND s.auto_renew = true
        AND s.renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + make_interval(days => $1::int)`,
    [horizonDays],
  );

  let queued = 0;
  for (const row of rows) {
    // Respect an explicit opt-out.
    if (row.preferences?.notifications?.renewalReminders === false) continue;

    const lead = reminderLeadDays({
      cost: row.cost,
      billingCycle: row.billing_cycle,
      status: row.status,
      reminderDaysBefore: row.reminder_days_before,
    });
    const days = daysUntil(row.renewal_date, now);
    // Only within the reminder window, and never for a past date.
    if (days < 0 || days > lead) continue;

    const isTrial = row.status === 'trial';
    const when = localHourToUtc(
      new Date(now).toISOString().slice(0, 10),
      row.preferences?.notifications?.hour ?? DEFAULT_SEND_HOUR,
      row.timezone,
    );
    // If today's slot has passed, send now rather than waiting a day —
    // a reminder that arrives after the charge is worthless.
    const scheduledFor = when <= now ? now : when;

    const amount = formatCurrency(row.cost, row.currency);
    const title = isTrial
      ? `${row.name} trial ends ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`
      : `${row.name} renews ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`;
    const body = isTrial
      ? `Your ${row.name} trial converts to a paid plan at ${amount} (${row.billing_cycle}) on ${row.renewal_date}. Cancel before then if you do not want it.`
      : `${row.name} will charge ${amount} on ${row.renewal_date}.`;

    const { rowCount } = await query(
      `INSERT INTO notifications
         (user_id, subscription_id, type, title, body, channel, priority, scheduled_for, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        row.user_id,
        row.id,
        isTrial ? 'trial_ending' : 'renewal',
        title,
        body,
        // Only mail verified addresses; everyone else gets it in-app.
        row.email_verified && row.preferences?.notifications?.email !== false ? 'email' : 'in_app',
        isTrial || Number(row.cost) >= 50 ? 'high' : 'normal',
        scheduledFor,
        `renewal:${row.id}:${row.renewal_date}`,
      ],
    );
    queued += rowCount;
  }

  if (queued) log.info(`Queued ${queued} renewal reminder(s)`);
  return { queued, considered: rows.length };
}

/** Queue an alert when committed spend crosses a budget threshold. */
export async function scheduleBudgetAlerts({ now = new Date() } = {}) {
  const rows = await many(
    `SELECT u.id AS user_id, u.email, u.name, u.currency, u.timezone,
            u.monthly_budget, u.email_verified, u.preferences,
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
      WHERE u.monthly_budget IS NOT NULL AND u.monthly_budget > 0
      GROUP BY u.id`,
  );

  let queued = 0;
  for (const row of rows) {
    if (row.preferences?.notifications?.budgetAlerts === false) continue;
    const budget = Number(row.monthly_budget);
    const committed = Number(row.committed);
    const percent = round2((committed / budget) * 100);
    // Two thresholds only, so a user hovering near a limit isn't pestered.
    const threshold = percent >= 100 ? 100 : percent >= 80 ? 80 : null;
    if (!threshold) continue;

    const { rowCount } = await query(
      `INSERT INTO notifications
         (user_id, type, title, body, channel, priority, scheduled_for, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        row.user_id,
        'budget',
        threshold === 100
          ? `You are over your ${formatCurrency(budget, row.currency)} monthly budget`
          : `You have used ${percent}% of your monthly budget`,
        `Committed subscriptions total ${formatCurrency(committed, row.currency)} a month against a budget of ${formatCurrency(budget, row.currency)}.`,
        'in_app',
        threshold === 100 ? 'high' : 'normal',
        now,
        // One alert per threshold per month.
        `budget:${threshold}:${new Date(now).toISOString().slice(0, 7)}`,
      ],
    );
    queued += rowCount;
  }
  if (queued) log.info(`Queued ${queued} budget alert(s)`);
  return { queued };
}

/**
 * Deliver due notifications.
 *
 * `FOR UPDATE SKIP LOCKED` lets several workers drain the queue in
 * parallel: each claims a disjoint set of rows, so a notification is never
 * sent twice even with multiple API instances running the scheduler.
 */
export async function deliverDueNotifications({ limit = 50 } = {}) {
  const due = await many(
    `WITH claimed AS (
       SELECT n.id
         FROM notifications n
        WHERE n.sent_at IS NULL AND n.scheduled_for <= now()
        ORDER BY n.priority DESC, n.scheduled_for
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n
        SET sent_at = now()
       FROM claimed
      WHERE n.id = claimed.id
      RETURNING n.*`,
    [limit],
  );

  let emailed = 0;
  for (const notification of due) {
    if (notification.channel !== 'email') continue;
    const user = await one('SELECT email, name, currency FROM users WHERE id = $1', [
      notification.user_id,
    ]);
    if (!user) continue;

    const subscription = notification.subscription_id
      ? await one(
          `SELECT id, name, cost, currency, billing_cycle, renewal_date
             FROM subscriptions WHERE id = $1`,
          [notification.subscription_id],
        )
      : null;

    if (subscription) {
      const totals = await one(
        `SELECT COALESCE(sum(
            CASE billing_cycle
              WHEN 'weekly'     THEN cost * 52 / 12
              WHEN 'biweekly'   THEN cost * 26 / 12
              WHEN 'monthly'    THEN cost
              WHEN 'quarterly'  THEN cost / 3
              WHEN 'semiannual' THEN cost / 6
              WHEN 'yearly'     THEN cost / 12
            END
          ), 0)::numeric(12,2) AS monthly
           FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
        [notification.user_id],
      );
      await mailer.renewalReminderEmail({
        to: user.email,
        name: user.name,
        subscription,
        daysUntil: daysUntil(subscription.renewal_date),
        monthlyTotal: formatCurrency(totals?.monthly ?? 0, user.currency),
      });
    } else {
      await mailer.send({
        to: user.email,
        subject: notification.title,
        html: `<p>${notification.body}</p>`,
      });
    }
    emailed += 1;
  }

  if (due.length) log.info(`Delivered ${due.length} notification(s)`, { emailed });
  return { delivered: due.length, emailed };
}

// ── Reads / user actions ───────────────────────────────────────

export async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  const clauses = ['user_id = $1'];
  if (unreadOnly) clauses.push('read_at IS NULL');
  return many(
    `SELECT id, subscription_id, type, title, body, channel, priority,
            scheduled_for, sent_at, read_at, created_at
       FROM notifications
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
}

export async function markRead(userId, ids) {
  const { rowCount } = await query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [userId, ids?.length ? ids : null],
  );
  return { updated: rowCount };
}

export async function unreadCount(userId) {
  const row = await one(
    'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return row?.count ?? 0;
}

/** Queue an in-app notification directly (used by the desktop app). */
export async function createNotification(userId, { type = 'custom', title, body, priority = 'normal', subscriptionId, dedupeKey }) {
  return one(
    `INSERT INTO notifications
       (user_id, subscription_id, type, title, body, channel, priority, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,'in_app',$6,$7)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [userId, subscriptionId ?? null, type, title, body, priority, dedupeKey ?? null],
  );
}
