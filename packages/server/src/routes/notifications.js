/** In-app notification feed. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate, uuid } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  listNotifications,
  markRead,
  unreadCount,
} from '../services/notifications/index.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validate(
    z
      .object({
        unreadOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const [notifications, unread] = await Promise.all([
      listNotifications(req.user.id, req.query),
      unreadCount(req.user.id),
    ]);
    res.json({ notifications, unread });
  }),
);

notificationsRouter.post(
  '/read',
  // No ids = mark everything read.
  validate(z.object({ ids: z.array(uuid).max(200).optional() }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await markRead(req.user.id, req.body.ids));
  }),
);
