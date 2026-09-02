/**
 * Cron trigger endpoints.
 *
 * The traditional entrypoint (`src/index.js`) runs these jobs itself via
 * `node-cron`, an in-process scheduler that only works on a server that
 * stays running. A serverless platform has no such process — Vercel Cron
 * Jobs instead makes an HTTP request to a path on a schedule, so the same
 * job functions need a route to be invoked from.
 *
 * Every request must carry the secret Vercel is configured to send, or
 * anyone who finds the URL could trigger (and repeatedly re-trigger) a
 * job that sends e-mail and burns AI budget.
 */

import { Router } from 'express';
import { jobs } from '../services/notifications/scheduler.js';
import { config } from '../config/index.js';
import { forbidden } from '../lib/errors.js';
import { asyncHandler } from '../lib/errors.js';

export const cronRouter = Router();

function requireCronSecret(req, _res, next) {
  const expected = config.cron.secret;
  if (!expected) return next(forbidden('CRON_SECRET is not configured'));
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return next(forbidden('Invalid cron secret'));
  }
  return next();
}

cronRouter.use(requireCronSecret);

cronRouter.get(
  '/notifications',
  asyncHandler(async (_req, res) => {
    res.json(await jobs.notifications());
  }),
);

cronRouter.get(
  '/nightly-insights',
  asyncHandler(async (_req, res) => {
    res.json(await jobs.nightlyInsights());
  }),
);
