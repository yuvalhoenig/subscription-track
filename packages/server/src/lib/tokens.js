/**
 * Token handling: short-lived access JWTs, long-lived opaque refresh
 * tokens, and single-use e-mail/reset tokens.
 *
 * Design notes:
 *  - Access tokens are stateless JWTs (15 min) so the hot path needs no
 *    database round trip.
 *  - Refresh tokens are random opaque strings stored as SHA-256 hashes and
 *    rotated on every use, so a stolen token is usable at most once and
 *    reuse is detectable. Opaque rather than JWT because they must be
 *    revocable, which a stateless JWT can't be.
 *  - Verification / reset tokens are also stored hashed, so a database
 *    dump cannot be replayed to seize accounts.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { unauthorized } from './errors.js';

/** URL-safe random string with 256 bits of entropy. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Tokens are only ever persisted as this hash. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Length-independent comparison for secrets we compare in code.
 * Hashing both sides first keeps timingSafeEqual's equal-length
 * requirement satisfied without leaking length.
 */
export function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      // Claim used by routes that require a verified address.
      ev: Boolean(user.email_verified),
    },
    config.auth.accessSecret,
    {
      expiresIn: config.auth.accessTtl,
      issuer: config.auth.issuer,
      audience: 'subtrack-api',
    },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.auth.accessSecret, {
      issuer: config.auth.issuer,
      audience: 'subtrack-api',
    });
  } catch (error) {
    // Surface expiry distinctly: the web client uses this code to decide
    // whether to attempt a silent refresh or bounce the user to /login.
    if (error.name === 'TokenExpiredError') {
      throw unauthorized('Access token expired', 'token_expired');
    }
    throw unauthorized('Invalid access token', 'token_invalid');
  }
}

/** Parse a TTL like "30d" / "15m" / "3600" into milliseconds. */
export function ttlToMs(ttl) {
  const match = /^(\d+)\s*([smhdw])?$/.exec(String(ttl).trim());
  if (!match) throw new TypeError(`Invalid TTL: ${ttl}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * multipliers[unit];
}

export function refreshTokenExpiry(from = new Date()) {
  return new Date(from.getTime() + ttlToMs(config.auth.refreshTtl));
}

export const REFRESH_COOKIE = 'subtrack_refresh';

/**
 * Cookie options for the refresh token.
 * httpOnly keeps it away from XSS; sameSite=lax survives the redirect back
 * from an e-mail link while still blocking cross-site form posts. The web
 * client can also hold the refresh token in memory (Electron does), so the
 * cookie is a convenience rather than the only supported transport.
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: ttlToMs(config.auth.refreshTtl),
  };
}
