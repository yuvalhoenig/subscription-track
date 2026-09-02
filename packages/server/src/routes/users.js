/** Profile, preferences and account deletion. */

import { Router } from 'express';
import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@subtrack/shared';
import { asyncHandler } from '../lib/errors.js';
import { validate, shortText, currency, money } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as accounts from '../services/accounts.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    avatar_url: z.string().url().max(500).nullable().optional(),
    currency: currency.optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    timezone: shortText(64).optional(),
    monthly_budget: money.nullable().optional(),
    /**
     * Free-form personalisation, shallow-merged server-side. Bounded to a
     * known key set so a client cannot use it as unlimited storage.
     */
    preferences: z
      .object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        aiTone: z.enum(['concise', 'friendly', 'detailed']).optional(),
        insightFrequency: z.enum(['daily', 'weekly', 'off']).optional(),
        notifications: z
          .object({
            email: z.boolean().optional(),
            renewalReminders: z.boolean().optional(),
            budgetAlerts: z.boolean().optional(),
            insightDigest: z.boolean().optional(),
            hour: z.number().int().min(0).max(23).optional(),
          })
          .strict()
          .optional(),
        dashboard: z
          .object({
            defaultRange: z.enum(['30d', '90d', '12m']).optional(),
            hiddenCards: z.array(z.string().max(40)).max(20).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

usersRouter.get('/me', (req, res) => {
  res.json({ user: req.user });
});

usersRouter.patch(
  '/me',
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await accounts.updateProfile(req.user.id, req.body) });
  }),
);

usersRouter.delete(
  '/me',
  validate(z.object({ password: z.string().min(1).max(200) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await accounts.deleteAccount(req.user.id, req.body.password));
  }),
);
