/**
 * Authentication middleware.
 *
 * `requireAuth` validates the bearer token and loads the user row, so
 * downstream handlers can trust `req.user` completely — including the case
 * where an account was deleted or deactivated after its token was issued.
 */

import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { one } from '../db/pool.js';
import { cache } from '../lib/cache.js';

const USER_CACHE_TTL = 60; // seconds

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // Electron's renderer can't always set headers on EventSource/streaming
  // requests, so a query token is accepted as a documented fallback.
  if (typeof req.query?.access_token === 'string') return req.query.access_token;
  return null;
}

async function loadUser(userId) {
  // Cached briefly: every authenticated request would otherwise re-read the
  // same row. 60s is short enough that a profile change shows up promptly.
  return cache.wrap(`user:${userId}`, USER_CACHE_TTL, async () =>
    one(
      `SELECT id, email, name, avatar_url, currency, locale, timezone,
              email_verified, is_admin, monthly_budget, preferences, created_at
         FROM users WHERE id = $1`,
      [userId],
    ),
  );
}

/** Invalidate the cached user row after a profile or preference change. */
export async function invalidateUser(userId) {
  await cache.del(`user:${userId}`);
}

export const requireAuth = async (req, _res, next) => {
  try {
    const token = bearerFrom(req);
    if (!token) throw unauthorized('Sign in to continue');
    const claims = verifyAccessToken(token);
    const user = await loadUser(claims.sub);
    // The token is cryptographically fine but the account is gone.
    if (!user) throw unauthorized('Account no longer exists', 'account_missing');
    req.user = user;
    req.tokenClaims = claims;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Gate for endpoints that need a confirmed address (e.g. e-mail reminders).
 * Reads the database row rather than the token claim so verifying an
 * address takes effect without waiting for the access token to roll over.
 */
export const requireVerifiedEmail = (req, _res, next) => {
  if (!req.user) return next(unauthorized('Sign in to continue'));
  if (!req.user.email_verified) {
    return next(forbidden('Verify your e-mail address to use this feature'));
  }
  return next();
};

/**
 * Attach `req.user` when a valid token is present, but never reject.
 * Used by endpoints that behave differently for signed-in users.
 */
export const optionalAuth = async (req, _res, next) => {
  const token = bearerFrom(req);
  if (!token) return next();
  try {
    const claims = verifyAccessToken(token);
    req.user = await loadUser(claims.sub);
    req.tokenClaims = claims;
  } catch {
    // An invalid token is treated as no token on optional routes.
  }
  return next();
};
