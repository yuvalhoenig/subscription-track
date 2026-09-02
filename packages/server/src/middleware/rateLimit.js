/**
 * Rate limiting.
 *
 * Three tiers, because the endpoints have very different risk profiles:
 *  - `apiLimiter`   generous, protects against runaway clients
 *  - `authLimiter`  strict, blunts credential stuffing and reset spam
 *  - `aiLimiter`    protects the Claude budget (real money per request)
 *
 * All three key on the authenticated user when there is one, falling back
 * to IP, so one abusive account cannot exhaust a shared office IP's quota.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config/index.js';
import { cache } from '../lib/cache.js';
import { tooManyRequests } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child('ratelimit');

// ipKeyGenerator normalises IPv6 addresses into /64 subnets, so a client
// cannot cycle through addresses in its own prefix to reset the counter.
const keyByUserOrIp = (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req)}`);

const handler = (message) => (req, _res, next) => {
  log.warn('Rate limit hit', { key: keyByUserOrIp(req), url: req.originalUrl });
  next(tooManyRequests(message));
};

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  // Tests would otherwise trip limits while exercising endpoints in a loop.
  skip: () => config.isTest,
};

export const apiLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  handler: handler('Slow down a moment and try again.'),
});

export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 20,
  // Only failures count, so a user with many browser tabs refreshing
  // valid sessions is never locked out of their own account.
  skipSuccessfulRequests: true,
  handler: handler('Too many attempts. Try again in a few minutes.'),
});

export const uploadLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60_000,
  limit: 40,
  handler: handler('Upload limit reached for this hour.'),
});

/**
 * Per-user hourly ceiling on Claude calls.
 *
 * Separate from the express-rate-limit tiers because it is a budget
 * control rather than an abuse control: it lives in Redis so the limit is
 * shared across every API instance, and it reports how long until reset so
 * the UI can say something useful instead of just failing.
 */
export async function consumeAiBudget(userId, cost = 1) {
  const limit = config.ai.rateLimitPerHour;
  if (!Number.isFinite(limit) || limit <= 0) return { remaining: Infinity, limit: 0 };

  const key = `ai:budget:${userId}:${new Date().toISOString().slice(0, 13)}`;
  let used = 0;
  for (let i = 0; i < cost; i += 1) {
    used = await cache.incr(key, 3600);
  }

  if (used > limit) {
    const ttl = await cache.ttl(key);
    const retryAfter = ttl > 0 ? ttl : 3600;
    throw tooManyRequests(
      `You have used all ${limit} AI requests for this hour. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      { retryAfterSeconds: retryAfter, limit },
    );
  }
  return { remaining: Math.max(0, limit - used), limit };
}

/** Express wrapper around consumeAiBudget for AI routes. */
export const aiLimiter = async (req, _res, next) => {
  try {
    if (!req.user) return next();
    const budget = await consumeAiBudget(req.user.id);
    req.aiBudget = budget;
    return next();
  } catch (error) {
    return next(error);
  }
};
