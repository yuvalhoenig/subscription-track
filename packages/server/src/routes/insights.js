/** AI insight feed: generation, listing and dismissal. */

import { Router } from 'express';
import { z } from 'zod';
import { INSIGHT_TYPES } from '@subtrack/shared';
import { asyncHandler } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/rateLimit.js';
import { generateInsights, listInsights, dismissInsight } from '../services/ai/insights.js';

export const insightsRouter = Router();
insightsRouter.use(requireAuth);

insightsRouter.get(
  '/',
  validate(
    z
      .object({
        includeDismissed: z.coerce.boolean().default(false),
        type: z.enum(INSIGHT_TYPES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    res.json({ insights: await listInsights(req.user.id, req.query) });
  }),
);

/**
 * Regenerate the feed on demand.
 * Rate-limited with the AI budget because narration costs a model call;
 * the underlying analysis is free and always runs.
 */
insightsRouter.post(
  '/generate',
  aiLimiter,
  validate(z.object({ narrate: z.boolean().default(true) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await generateInsights(req.user.id, { narrate: req.body.narrate }));
  }),
);

insightsRouter.post(
  '/:id/dismiss',
  asyncHandler(async (req, res) => {
    res.json(await dismissInsight(req.user.id, req.params.id));
  }),
);
