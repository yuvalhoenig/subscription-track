/** Authentication routes: register, sign in, refresh, verify, reset. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate, email, password, locale, currency, shortText } from '../lib/validate.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../lib/tokens.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import * as accounts from '../services/accounts.js';

export const authRouter = Router();

const registerSchema = z
  .object({
    email,
    password,
    name: z.string().trim().min(1, 'Tell us your name').max(120),
    timezone: shortText(64).optional(),
    locale: locale.optional(),
    currency: currency.optional(),
  })
  .strict();

// Sign-in intentionally does not apply the password policy: an existing
// account may predate a policy change, and rejecting a valid password
// here would lock people out.
const loginSchema = z
  .object({ email, password: z.string().min(1, 'Enter your password').max(200) })
  .strict();

/** Read the refresh token from the cookie or the body. */
function refreshTokenFrom(req) {
  return req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken ?? null;
}

/**
 * Send a session. The refresh token goes in an httpOnly cookie for
 * browsers *and* in the body for the desktop app, which stores it in the
 * OS keychain rather than a cookie jar.
 */
function sendSession(res, session, status = 200) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  res.status(status).json(session);
}

authRouter.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const session = await accounts.register(req.body, { userAgent: req.headers['user-agent'] });
    sendSession(res, session, 201);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await accounts.login(req.body, { userAgent: req.headers['user-agent'] });
    sendSession(res, session);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const session = await accounts.rotateRefreshToken(refreshTokenFrom(req), {
      userAgent: req.headers['user-agent'],
    });
    sendSession(res, session);
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await accounts.revokeRefreshToken(refreshTokenFrom(req));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const revoked = await accounts.revokeAllSessions(req.user.id);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    res.json({ ok: true, revoked });
  }),
);

authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ sessions: await accounts.listSessions(req.user.id) });
  }),
);

authRouter.post(
  '/verify-email',
  validate(z.object({ token: z.string().min(10).max(400) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await accounts.verifyEmail(req.body.token));
  }),
);

authRouter.post(
  '/resend-verification',
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await accounts.resendVerification(req.user.id));
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate(z.object({ email }).strict()),
  asyncHandler(async (req, res) => {
    // Always the same response, whether or not the address is registered.
    res.json(await accounts.requestPasswordReset(req.body.email));
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validate(z.object({ token: z.string().min(10).max(400), password }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await accounts.resetPassword(req.body));
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  validate(
    z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json(await accounts.changePassword(req.user.id, req.body));
  }),
);
