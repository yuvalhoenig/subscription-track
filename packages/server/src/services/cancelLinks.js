/**
 * One-click subscription cancellation links.
 *
 * A signed, single-use, expiring token scoped to exactly one subscription
 * — the same hashed-token pattern already used for e-mail verification and
 * password reset, just with an extra `subscription_id` column so the
 * token can only ever cancel the one thing it names.
 *
 * The critical safety property: **resolving a token (GET) never cancels
 * anything.** Mail clients and link-safety scanners (Outlook Safe Links,
 * Gmail's image/link proxy) fetch every URL in an e-mail automatically,
 * often before a human ever opens it — a GET that performed the
 * cancellation would fire from a spam filter, not a person. Only an
 * explicit POST, triggered by a button the user clicks on the preview
 * page, performs the action.
 */

import { cancelHelpFor } from '@subtrack/shared';
import { randomToken, hashToken } from '../lib/tokens.js';
import { one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { cancelSubscription, getSubscription } from './subscriptions.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child('cancel-link');

/** Long enough to still be useful if someone reads the e-mail weeks late. */
const CANCEL_LINK_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Issue a fresh cancellation link for a subscription the caller owns. */
export async function createCancelLink(userId, subscriptionId) {
  const subscription = await getSubscription(userId, subscriptionId); // throws 404 if not owned
  if (subscription.status === 'cancelled') {
    throw badRequest('This subscription is already cancelled.');
  }

  const token = randomToken(32);
  await query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, subscription_id, expires_at)
     VALUES ($1, 'cancel_subscription', $2, $3, $4)`,
    [userId, hashToken(token), subscriptionId, new Date(Date.now() + CANCEL_LINK_TTL_MS)],
  );
  log.info('Cancel link issued', { userId, subscriptionId });
  return `${config.appUrl}/cancel/${token}`;
}

async function loadToken(token) {
  return one(
    `SELECT at.id, at.user_id, at.subscription_id, at.expires_at, at.used_at,
            s.name, s.vendor_id, s.cost, s.currency, s.billing_cycle, s.status
       FROM auth_tokens at
       JOIN subscriptions s ON s.id = at.subscription_id
      WHERE at.token_hash = $1 AND at.kind = 'cancel_subscription'`,
    [hashToken(token)],
  );
}

/**
 * Where to actually go to stop the real charge. Computed server-side (not
 * left to the client) so the one piece of logic deciding "do we have a
 * verified direct link, or does this fall back to a search" lives in
 * exactly one place — the shared catalogue — reachable the same way from
 * every surface that needs it.
 */
function cancelHelp(record) {
  return cancelHelpFor(record.vendor_id ?? record.name);
}

/** Side-effect-free lookup, safe for a GET / link-scanner prefetch. */
export async function previewCancelLink(token) {
  const record = await loadToken(token);
  if (!record) throw notFound('This cancellation link is not valid.');
  if (new Date(record.expires_at) <= new Date()) throw badRequest('This link has expired.');

  return {
    name: record.name,
    cost: Number(record.cost),
    currency: record.currency,
    billingCycle: record.billing_cycle,
    alreadyCancelled: record.status === 'cancelled',
    cancelHelp: cancelHelp(record),
  };
}

/** The actual cancellation. Only ever called from a POST. */
export async function confirmCancelLink(token) {
  const record = await loadToken(token);
  if (!record) throw notFound('This cancellation link is not valid.');
  if (new Date(record.expires_at) <= new Date()) throw badRequest('This link has expired.');

  if (record.status === 'cancelled') {
    // Idempotent: a double click, or the subscription was already
    // cancelled some other way. Report success rather than an error.
    return {
      name: record.name,
      cost: Number(record.cost),
      currency: record.currency,
      alreadyCancelled: true,
      cancelHelp: cancelHelp(record),
    };
  }

  // Marked used for a clean audit trail, though the cancellation itself is
  // already idempotent above — replaying a used token just reports
  // "already cancelled" rather than erroring.
  await query('UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [record.id]);

  const updated = await cancelSubscription(record.user_id, record.subscription_id);
  log.info('Subscription cancelled via link', { userId: record.user_id, subscriptionId: record.subscription_id });

  return {
    name: updated.name,
    cost: Number(updated.cost),
    currency: updated.currency,
    monthlySaving: updated.monthlyCost,
    alreadyCancelled: false,
    cancelHelp: cancelHelp(record),
  };
}
