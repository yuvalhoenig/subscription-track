/**
 * Account lifecycle: registration, sign-in, token rotation, e-mail
 * verification, password reset and profile management.
 *
 * Two security decisions worth calling out:
 *
 *  1. Refresh tokens rotate on every use. Presenting a token that has
 *     already been rotated is treated as theft, and every session for that
 *     user is revoked (see `rotateRefreshToken`).
 *  2. Endpoints that take an e-mail address never reveal whether it is
 *     registered. Sign-in and password reset both behave identically for
 *     known and unknown addresses, which stops the API being used to
 *     enumerate accounts.
 */

import bcrypt from 'bcryptjs';
import { DEFAULT_CATEGORIES } from '@subtrack/shared';
import { one, many, tx, query } from '../db/pool.js';
import { config } from '../config/index.js';
import {
  randomToken,
  hashToken,
  signAccessToken,
  refreshTokenExpiry,
} from '../lib/tokens.js';
import { badRequest, conflict, unauthorized, notFound } from '../lib/errors.js';
import { invalidateUser } from '../middleware/auth.js';
import { mailer } from './mailer.js';
import { logger } from '../lib/logger.js';

const log = logger.child('accounts');

const PUBLIC_USER_COLUMNS = `id, email, name, avatar_url, currency, locale, timezone,
  email_verified, is_admin, monthly_budget, preferences, created_at, last_login_at`;

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * A bcrypt hash of a throwaway value, used to equalise timing on sign-in
 * attempts for addresses that don't exist. Without it, "unknown e-mail"
 * returns markedly faster than "wrong password", which leaks which
 * addresses are registered.
 */
const DUMMY_HASH = bcrypt.hashSync('subtrack-timing-equaliser', config.auth.bcryptRounds);

export const hashPassword = (plain) => bcrypt.hash(plain, config.auth.bcryptRounds);

/** Seed a new account with the default category set. */
export async function createDefaultCategories(db, userId) {
  const values = [];
  const params = [];
  DEFAULT_CATEGORIES.forEach((category, index) => {
    const base = index * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true)`);
    params.push(userId, category.name, category.color, category.icon, index);
  });
  await db.query(
    `INSERT INTO categories (user_id, name, color, icon, sort_order, is_default)
     VALUES ${values.join(', ')}`,
    params,
  );
}

/** Issue a refresh token, storing only its hash. */
async function issueRefreshToken(db, userId, userAgent) {
  const token = randomToken(48);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), userAgent?.slice(0, 300) ?? null, refreshTokenExpiry()],
  );
  return token;
}

async function createAuthToken(db, userId, kind, ttlMs) {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, kind, hashToken(token), new Date(Date.now() + ttlMs)],
  );
  return token;
}

/**
 * Shape the user object returned to the client.
 *
 * Deliberately snake_case, matching the raw column names GET /users/me
 * returns from middleware/auth.js's loadUser query. Those two previously
 * disagreed (this function returned camelCase like `emailVerified` while
 * /users/me returned `email_verified`), which meant a component reading
 * `user.email_verified` saw `undefined` — and therefore treated the address
 * as unverified — until the next full page load refreshed the session from
 * /users/me. Using one shape everywhere removes that gap, and is what lets
 * `is_admin` be trusted immediately after login/register/refresh too.
 */
function sessionFor(user, refreshToken) {
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
      is_admin: Boolean(user.is_admin),
      monthly_budget: user.monthly_budget,
      preferences: user.preferences ?? {},
      created_at: user.created_at,
    },
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: config.auth.accessTtl,
  };
}

// ── Registration ───────────────────────────────────────────────

export async function register({ email, password, name, timezone, locale, currency }, { userAgent } = {}) {
  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
  // Registration is the one place we must reveal that an address is taken,
  // because the alternative is silently not creating the account.
  if (existing) throw conflict('An account with that e-mail already exists');

  const passwordHash = await hashPassword(password);

  const { user, refreshToken, verifyToken } = await tx(async (db) => {
    let created;
    try {
      created = await db.one(
        `INSERT INTO users (email, password_hash, name, timezone, locale, currency)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PUBLIC_USER_COLUMNS}`,
        [email, passwordHash, name, timezone ?? 'UTC', locale ?? 'en', currency ?? 'USD'],
      );
    } catch (error) {
      // Two simultaneous signups for the same address: the unique index is
      // the real guard, the SELECT above is just a friendlier fast path.
      if (error.code === '23505') throw conflict('An account with that e-mail already exists');
      throw error;
    }
    await createDefaultCategories(db, created.id);
    return {
      user: created,
      refreshToken: await issueRefreshToken(db, created.id, userAgent),
      verifyToken: await createAuthToken(db, created.id, 'verify_email', VERIFY_TTL_MS),
    };
  });

  // Sent outside the transaction: a mail failure must not roll back a
  // perfectly good account. Users can always request a new link.
  await mailer.verificationEmail({ to: user.email, name: user.name, token: verifyToken });
  log.info('Account registered', { userId: user.id });

  return sessionFor(user, refreshToken);
}

// ── Sign in ────────────────────────────────────────────────────

export async function login({ email, password }, { userAgent } = {}) {
  const user = await one(
    `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email],
  );

  // Always run a bcrypt comparison, even with no user, so the response
  // time does not disclose whether the address exists.
  const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    throw unauthorized('That e-mail or password is not correct', 'invalid_credentials');
  }

  const refreshToken = await tx(async (db) => {
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return issueRefreshToken(db, user.id, userAgent);
  });

  delete user.password_hash;
  await invalidateUser(user.id);
  return sessionFor(user, refreshToken);
}

// ── Refresh rotation ───────────────────────────────────────────

export async function rotateRefreshToken(token, { userAgent } = {}) {
  if (!token) throw unauthorized('No refresh token supplied', 'refresh_missing');
  const tokenHash = hashToken(token);

  const record = await one(
    `SELECT id, user_id, expires_at, revoked_at, revoked_reason
       FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  if (!record) throw unauthorized('Session not recognised', 'refresh_invalid');

  if (record.revoked_at) {
    /**
     * Why the token was revoked decides how alarmed to be.
     *
     * 'rotated' means the legitimate client already exchanged this token
     * for a new one. Someone presenting it now is replaying a token they
     * should not have, so we revoke every session for the account — the
     * standard response to refresh-token replay.
     *
     * Any other reason (an explicit logout, a password change) is a stale
     * client presenting a token that was retired on purpose. Rejecting it
     * is correct; signing the user out of their other devices is not.
     */
    if (record.revoked_reason === 'rotated') {
      log.warn('Replay of a rotated refresh token; revoking all sessions', {
        userId: record.user_id,
      });
      await query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'breach'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [record.user_id],
      );
      throw unauthorized('Session expired, please sign in again', 'refresh_reused');
    }
    throw unauthorized('Session has ended, please sign in again', 'refresh_revoked');
  }

  if (new Date(record.expires_at) <= new Date()) {
    throw unauthorized('Session expired, please sign in again', 'refresh_expired');
  }

  return tx(async (db) => {
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
      [record.id],
    );
    const user = await db.one(
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`,
      [record.user_id],
    );
    if (!user) throw unauthorized('Account no longer exists', 'account_missing');
    const refreshToken = await issueRefreshToken(db, user.id, userAgent);
    return sessionFor(user, refreshToken);
  });
}

export async function revokeRefreshToken(token) {
  if (!token) return;
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

export async function revokeAllSessions(userId, reason = 'logout_all') {
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return rowCount;
}

// ── E-mail verification ────────────────────────────────────────

/** Consume a single-use token, returning its user id. */
async function consumeAuthToken(db, token, kind) {
  const record = await db.one(
    `SELECT id, user_id, expires_at, used_at
       FROM auth_tokens
      WHERE token_hash = $1 AND kind = $2`,
    [hashToken(token), kind],
  );
  if (!record || record.used_at) throw badRequest('That link is no longer valid');
  if (new Date(record.expires_at) <= new Date()) throw badRequest('That link has expired');
  await db.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [record.id]);
  return record.user_id;
}

export async function verifyEmail(token) {
  const userId = await tx(async (db) => {
    const id = await consumeAuthToken(db, token, 'verify_email');
    await db.query('UPDATE users SET email_verified = true WHERE id = $1', [id]);
    return id;
  });
  await invalidateUser(userId);
  log.info('E-mail verified', { userId });
  return { verified: true };
}

export async function resendVerification(userId) {
  const user = await one('SELECT id, email, name, email_verified FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('Account not found');
  if (user.email_verified) return { alreadyVerified: true };
  const token = await tx((db) => createAuthToken(db, user.id, 'verify_email', VERIFY_TTL_MS));
  await mailer.verificationEmail({ to: user.email, name: user.name, token });
  return { sent: true };
}

// ── Password reset ─────────────────────────────────────────────

export async function requestPasswordReset(email) {
  const user = await one('SELECT id, email, name FROM users WHERE email = $1', [email]);
  // Deliberately identical response for unknown addresses.
  if (!user) {
    log.info('Password reset requested for unknown address');
    return { sent: true };
  }
  const token = await tx((db) => createAuthToken(db, user.id, 'reset_password', RESET_TTL_MS));
  await mailer.passwordResetEmail({ to: user.email, name: user.name, token });
  return { sent: true };
}

export async function resetPassword({ token, password }) {
  const passwordHash = await hashPassword(password);
  const userId = await tx(async (db) => {
    const id = await consumeAuthToken(db, token, 'reset_password');
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    // Whoever prompted the reset may have had a live session; end them all.
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_change'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    return id;
  });
  log.info('Password reset', { userId });
  return { reset: true };
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await one('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('Account not found');
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw unauthorized('Your current password is not correct', 'invalid_credentials');
  }
  const passwordHash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await revokeAllSessions(userId, 'password_change');
  return { changed: true };
}

// ── Profile & preferences ──────────────────────────────────────

export async function updateProfile(userId, patch) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'avatar_url', 'currency', 'locale', 'timezone', 'monthly_budget'];
  for (const column of allowed) {
    if (patch[column] !== undefined) {
      params.push(patch[column]);
      fields.push(`${column} = $${params.length}`);
    }
  }
  if (patch.preferences !== undefined) {
    // Shallow-merge so a client can PATCH one preference without having to
    // send the whole object back and risk clobbering another device's write.
    params.push(JSON.stringify(patch.preferences));
    fields.push(`preferences = preferences || $${params.length}::jsonb`);
  }
  if (!fields.length) throw badRequest('No changes supplied');

  params.push(userId);
  const user = await one(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}
     RETURNING ${PUBLIC_USER_COLUMNS}`,
    params,
  );
  if (!user) throw notFound('Account not found');
  await invalidateUser(userId);
  return user;
}

export async function listSessions(userId) {
  return many(
    `SELECT id, user_agent, created_at, expires_at
       FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId],
  );
}

export async function deleteAccount(userId, password) {
  const user = await one('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('Account not found');
  // Deleting an account is irreversible, so re-authenticate first.
  if (!(await bcrypt.compare(password, user.password_hash))) {
    throw unauthorized('Password confirmation failed', 'invalid_credentials');
  }
  // ON DELETE CASCADE clears subscriptions, insights, chat history and the
  // rest in one statement — no orphaned personal data left behind.
  await query('DELETE FROM users WHERE id = $1', [userId]);
  await invalidateUser(userId);
  log.info('Account deleted', { userId });
  return { deleted: true };
}
