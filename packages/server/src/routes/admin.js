/** Admin panel routes. Every route here requires an authenticated admin. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate, email, password } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import * as admin from '../services/admin.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await admin.systemStats());
  }),
);

adminRouter.get(
  '/users',
  validate(
    z
      .object({
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    res.json(await admin.listUsers(req.query));
  }),
);

adminRouter.post(
  '/users',
  validate(
    z
      .object({
        email,
        password,
        name: z.string().trim().min(1, "Give them a name").max(120),
        isAdmin: z.boolean().default(false),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.status(201).json(await admin.createUserAsAdmin(req.user.id, req.body));
  }),
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    res.json(await admin.getUserDetail(req.params.id));
  }),
);

adminRouter.post(
  '/users/:id/admin',
  validate(z.object({ isAdmin: z.boolean() }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await admin.setUserAdmin(req.user.id, req.params.id, req.body.isAdmin));
  }),
);

adminRouter.post(
  '/users/:id/impersonate',
  asyncHandler(async (req, res) => {
    res.json(await admin.impersonateUser(req.user.id, req.params.id));
  }),
);

adminRouter.post(
  '/users/:id/logout-all',
  asyncHandler(async (req, res) => {
    res.json(await admin.forceLogoutUser(req.user.id, req.params.id));
  }),
);

adminRouter.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    res.json(await admin.deleteUserAsAdmin(req.user.id, req.params.id));
  }),
);

adminRouter.get(
  '/audit-log',
  validate(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    res.json({ entries: await admin.listAuditLog(req.query) });
  }),
);
