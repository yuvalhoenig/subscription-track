/**
 * Unauthenticated routes reachable from outside the app — currently just
 * the one-click cancellation link embedded in renewal reminder e-mails.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { previewCancelLink, confirmCancelLink } from '../services/cancelLinks.js';

export const publicRouter = Router();

// GET must stay side-effect free — see cancelLinks.js for why.
publicRouter.get(
  '/cancel/:token',
  asyncHandler(async (req, res) => {
    res.json(await previewCancelLink(req.params.token));
  }),
);

publicRouter.post(
  '/cancel/:token',
  asyncHandler(async (req, res) => {
    res.json(await confirmCancelLink(req.params.token));
  }),
);
