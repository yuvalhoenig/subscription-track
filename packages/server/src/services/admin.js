/**
 * Admin panel service.
 *
 * Every mutating action here is logged to `admin_audit_log` — who did it,
 * what, and to whom — so "an admin deleted a user" is always answerable
 * after the fact, including once the acting admin's own account is gone
 * (the audit row survives; only its `admin_user_id` foreign key allows
 * that account to be deleted).
 *
 * Two guardrails worth calling out:
 *   - An admin cannot demote themselves if they are the only admin left,
 *     which would otherwise lock everyone out of the panel with no way in
 *     except direct database access.
 *   - An admin cannot delete their own account through this surface;
 *     that stays in account settings, which requires a password.
 */

import { many, one, query, tx } from '../db/pool.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { revokeAllSessions, hashPassword, createDefaultCategories } from './accounts.js';
import { invalidateUser } from '../middleware/auth.js';
import { aiEnabled, config } from '../config/index.js';
import { signAccessToken } from '../lib/tokens.js';
import { logger } from '../lib/logger.js';

const log = logger.child('admin');

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

async function logAdminAction(adminUserId, action, { targetUserId = null, detail = {} } = {}) {
  await query(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, detail)
     VALUES ($1, $2, $3, $4)`,
    [adminUserId, action, targetUserId, JSON.stringify(detail)],
  );
  log.info(`Admin action: ${action}`, { adminUserId, targetUserId });
}

/** Platform-wide numbers for the panel's overview tab. */
export async function systemStats() {
  const [userStats, subStats, contentStats] = await Promise.all([
    one(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE email_verified)::int AS verified,
             count(*) FILTER (WHERE is_admin)::int AS admins,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d,
             count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d
        FROM users
    `),
    one(`
      SELECT count(DISTINCT user_id)::int AS users_with_subs,
             count(*)::int AS total_subscriptions,
             count(*) FILTER (WHERE status = 'active')::int AS active_subscriptions,
             count(*) FILTER (WHERE status = 'trial')::int AS trial_subscriptions,
             COALESCE(sum(${MONTHLY_EXPR}) FILTER (WHERE status = 'active'), 0)::numeric(14,2)
               AS total_monthly_tracked
        FROM subscriptions s
    `),
    one(`
      SELECT
        (SELECT count(*)::int FROM ai_insights)     AS total_insights,
        (SELECT count(*)::int FROM chat_history)    AS total_chat_messages,
        (SELECT count(*)::int FROM payment_history) AS total_payments
    `),
  ]);

  return {
    users: {
      total: userStats.total,
      verified: userStats.verified,
      admins: userStats.admins,
      newLast7Days: userStats.new_7d,
      newLast30Days: userStats.new_30d,
    },
    subscriptions: {
      usersWithSubscriptions: subStats.users_with_subs,
      total: subStats.total_subscriptions,
      active: subStats.active_subscriptions,
      trial: subStats.trial_subscriptions,
      totalMonthlyTracked: Number(subStats.total_monthly_tracked),
      totalYearlyTracked: Number(subStats.total_monthly_tracked) * 12,
    },
    content: {
      totalInsights: contentStats.total_insights,
      totalChatMessages: contentStats.total_chat_messages,
      totalPayments: contentStats.total_payments,
    },
    ai: {
      mode: aiEnabled() ? 'claude' : 'heuristic',
      models: aiEnabled() ? { fast: config.ai.fastModel, smart: config.ai.smartModel } : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Paginated, searchable user list with each user's subscription footprint. */
export async function listUsers({ search, limit = 50, offset = 0 } = {}) {
  const filterParams = [];
  let where = '';
  if (search) {
    filterParams.push(`%${search}%`);
    where = 'WHERE u.email ILIKE $1 OR u.name ILIKE $1';
  }

  const rows = await many(
    `SELECT u.id, u.email, u.name, u.is_admin, u.email_verified, u.created_at, u.last_login_at,
            count(s.id) FILTER (WHERE s.status <> 'cancelled')::int AS subscription_count,
            COALESCE(sum(${MONTHLY_EXPR}) FILTER (WHERE s.status = 'active'), 0)::numeric(12,2)
              AS monthly_spend
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
    [...filterParams, limit, offset],
  );

  const totalRow = await one(`SELECT count(*)::int AS total FROM users u ${where}`, filterParams);

  return { users: rows, total: totalRow.total, limit, offset };
}

/**
 * Everything a support admin needs to help one user: profile, their
 * subscriptions, active sessions, recent payments, recent notifications,
 * and how much they've used the AI features — one call instead of the
 * admin having to guess which table holds the answer to "what's going on
 * with this account".
 */
export async function getUserDetail(userId) {
  const user = await one(
    `SELECT id, email, name, is_admin, email_verified, currency, locale, timezone,
            monthly_budget, created_at, last_login_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!user) throw notFound('User not found');

  const [subscriptions, sessions, overview, recentPayments, recentNotifications, activity] =
    await Promise.all([
      many(
        `SELECT id, name, cost, currency, billing_cycle, status, renewal_date, created_at
           FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId],
      ),
      many(
        `SELECT id, user_agent, created_at, expires_at FROM refresh_tokens
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC`,
        [userId],
      ),
      one(
        `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS active_count,
                COALESCE(sum(${MONTHLY_EXPR}) FILTER (WHERE s.status = 'active'), 0)::numeric(12,2)
                  AS monthly_spend
           FROM subscriptions s WHERE s.user_id = $1`,
        [userId],
      ),
      many(
        `SELECT p.id, p.payment_date, p.amount, p.currency, p.status, s.name AS subscription_name
           FROM payment_history p JOIN subscriptions s ON s.id = p.subscription_id
          WHERE p.user_id = $1
          ORDER BY p.payment_date DESC LIMIT 20`,
        [userId],
      ),
      many(
        `SELECT id, type, title, body, channel, sent_at, read_at, created_at
           FROM notifications WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      one(
        `SELECT
           (SELECT count(*)::int FROM ai_insights WHERE user_id = $1) AS insights,
           (SELECT count(*)::int FROM chat_history WHERE user_id = $1) AS chat_messages,
           (SELECT max(created_at) FROM chat_history WHERE user_id = $1) AS last_chat_at`,
        [userId],
      ),
    ]);

  return {
    user,
    subscriptions,
    activeSessions: sessions,
    activeCount: overview.active_count,
    monthlySpend: Number(overview.monthly_spend),
    recentPayments,
    recentNotifications,
    activity: {
      insightsGenerated: activity.insights,
      chatMessages: activity.chat_messages,
      lastChatAt: activity.last_chat_at,
    },
  };
}

/** Grant or revoke admin access. */
export async function setUserAdmin(actingAdminId, targetUserId, isAdmin) {
  if (actingAdminId === targetUserId && !isAdmin) {
    const { admins } = await one('SELECT count(*) FILTER (WHERE is_admin)::int AS admins FROM users');
    if (admins <= 1) {
      throw badRequest('You are the only admin. Promote someone else before removing your own access.');
    }
  }

  const user = await one(
    'UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING id, email, is_admin',
    [isAdmin, targetUserId],
  );
  if (!user) throw notFound('User not found');

  await invalidateUser(targetUserId);
  await logAdminAction(actingAdminId, isAdmin ? 'grant_admin' : 'revoke_admin', { targetUserId });
  return user;
}

/**
 * Issue a short-lived access token that lets a support admin see the app
 * exactly as one user sees it, without ever touching that user's password.
 *
 * Deliberately narrower than a real sign-in:
 *  - No refresh token is issued, so the session cannot outlive the access
 *    token's normal TTL (`config.auth.accessTtl`) — it expires on its own,
 *    there is nothing to revoke.
 *  - The token carries an `act` claim naming the acting admin, which
 *    `requireAdmin` uses to refuse admin-panel access on an impersonation
 *    token even if the impersonated account is itself an admin.
 *  - Impersonating another admin is refused outright: the whole point is
 *    "see what a user sees to help them", not "borrow a peer admin's
 *    session".
 */
export async function impersonateUser(actingAdminId, targetUserId) {
  if (actingAdminId === targetUserId) {
    throw badRequest('You are already signed in as yourself.');
  }
  const user = await one(
    `SELECT id, email, name, avatar_url, currency, locale, timezone,
            email_verified, is_admin, monthly_budget, preferences, created_at
       FROM users WHERE id = $1`,
    [targetUserId],
  );
  if (!user) throw notFound('User not found');
  if (user.is_admin) throw badRequest('Cannot impersonate another admin account.');

  const admin = await one('SELECT email FROM users WHERE id = $1', [actingAdminId]);

  await logAdminAction(actingAdminId, 'impersonate_start', { targetUserId, detail: { email: user.email } });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url ?? null,
      currency: user.currency,
      locale: user.locale,
      timezone: user.timezone,
      email_verified: user.email_verified,
      is_admin: false,
      monthly_budget: user.monthly_budget,
      preferences: user.preferences ?? {},
      created_at: user.created_at,
    },
    accessToken: signAccessToken(user, { impersonatedBy: actingAdminId }),
    expiresIn: config.auth.accessTtl,
    impersonating: { adminId: actingAdminId, adminEmail: admin?.email ?? null },
  };
}

/** Sign a user out of every device. Useful for a compromised or abusive account. */
export async function forceLogoutUser(actingAdminId, targetUserId) {
  const revoked = await revokeAllSessions(targetUserId, 'logout_all');
  await logAdminAction(actingAdminId, 'force_logout', { targetUserId, detail: { revoked } });
  return { revoked };
}

/**
 * Delete a user's account without requiring their password.
 * Cascades through every table via the schema's ON DELETE CASCADE chain,
 * same as self-service deletion.
 */
export async function deleteUserAsAdmin(actingAdminId, targetUserId) {
  if (actingAdminId === targetUserId) {
    throw badRequest('Use account settings to delete your own account.');
  }
  const user = await one('SELECT id, email FROM users WHERE id = $1', [targetUserId]);
  if (!user) throw notFound('User not found');

  await query('DELETE FROM users WHERE id = $1', [targetUserId]);
  await invalidateUser(targetUserId);
  // target_user_id is omitted (not the id we just deleted): the column has
  // a foreign key to users, and inserting a reference to a row that no
  // longer exists violates that constraint — which previously surfaced as
  // a 400 on this request even though the deletion itself had already
  // committed, wrongly telling the caller the delete had failed. The
  // e-mail is preserved in `detail` instead, so the audit trail is no less
  // informative.
  await logAdminAction(actingAdminId, 'delete_user', { detail: { deletedUserId: targetUserId, email: user.email } });
  return { deleted: true };
}

/**
 * Admin-created account: pre-verified (no e-mail loop to close), created
 * without the caller ever knowing the password if the admin generates one
 * on the user's behalf, and optionally granted admin access outright.
 */
export async function createUserAsAdmin(actingAdminId, { email, password, name, isAdmin = false }) {
  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) throw conflict('An account with that e-mail already exists');

  const passwordHash = await hashPassword(password);

  const user = await tx(async (db) => {
    let created;
    try {
      created = await db.one(
        `INSERT INTO users (email, password_hash, name, email_verified, is_admin)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id, email, name, is_admin, email_verified, created_at`,
        [email, passwordHash, name, isAdmin],
      );
    } catch (error) {
      if (error.code === '23505') throw conflict('An account with that e-mail already exists');
      throw error;
    }
    await createDefaultCategories(db, created.id);
    return created;
  });

  await logAdminAction(actingAdminId, 'create_user', {
    targetUserId: user.id,
    detail: { email: user.email, isAdmin: user.is_admin },
  });
  return user;
}

export async function listAuditLog({ limit = 100 } = {}) {
  return many(
    `SELECT a.id, a.action, a.detail, a.created_at,
            admin.email AS admin_email,
            target.email AS target_email
       FROM admin_audit_log a
       JOIN users admin ON admin.id = a.admin_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit],
  );
}
