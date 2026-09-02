/** Subscription CRUD, payments, usage and the renewal calendar. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import {
  validate,
  uuid,
  money,
  isoDate,
  billingCycle,
  subscriptionStatus,
  paymentStatus,
  currency,
  shortText,
} from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as subs from '../services/subscriptions.js';
import { categorise, userCategoryNames } from '../services/ai/categorize.js';
import { ensureCategory } from '../services/categories.js';
import { createCancelLink } from '../services/cancelLinks.js';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

/**
 * Base field set. `createSchema` adds a cross-field rule on top and
 * `updateSchema` is the partial form — both derive from this one object so
 * the field definitions never drift apart. (A refined schema cannot be
 * made partial directly, hence the split.)
 */
const subscriptionFields = z
  .object({
    name: z.string().trim().min(1, 'Give the subscription a name').max(120),
    description: shortText(500).optional(),
    cost: money,
    currency: currency.optional(),
    billingCycle,
    renewalDate: isoDate.optional(),
    startedAt: isoDate.optional(),
    status: subscriptionStatus.optional(),
    trialEndsAt: isoDate.optional(),
    categoryId: uuid.nullable().optional(),
    category: shortText(60).optional(),
    subcategory: shortText(60).optional(),
    autoRenew: z.boolean().optional(),
    url: z.string().url().max(500).optional(),
    notes: shortText(2000).optional(),
    reminderDaysBefore: z.coerce.number().int().min(0).max(60).optional(),
    /** Let the server pick a category when the client has not. */
    autoCategorise: z.boolean().optional().default(true),
  })
  .strict();

const createSchema = subscriptionFields.refine(
  (value) => value.status !== 'trial' || value.trialEndsAt || value.renewalDate,
  {
    message: 'A trial needs either a trial end date or a renewal date',
    path: ['trialEndsAt'],
  },
);

const updateSchema = subscriptionFields.partial();

const listQuerySchema = z
  .object({
    status: subscriptionStatus.optional(),
    categoryId: uuid.optional(),
    search: shortText(120).optional(),
    sort: z.enum(['name', 'cost', 'renewal', 'created', 'usage']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    includeCancelled: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strip();

subscriptionsRouter.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json({ subscriptions: await subs.listSubscriptions(req.user.id, req.query) });
  }),
);

subscriptionsRouter.get(
  '/calendar',
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    res.json(await subs.upcomingRenewals(req.user.id, { days: req.query.days }));
  }),
);

subscriptionsRouter.get(
  '/payments',
  validate(
    z
      .object({
        subscriptionId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    res.json({ payments: await subs.listPayments(req.user.id, req.query) });
  }),
);

subscriptionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ subscription: await subs.getSubscription(req.user.id, req.params.id) });
  }),
);

subscriptionsRouter.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const input = { ...req.body };

    // Fill in a category when the client did not choose one. The AI
    // categoriser degrades to catalogue and keyword rules with no API key,
    // so this path never fails for want of a model.
    if (!input.categoryId && !input.category && input.autoCategorise) {
      const result = await categorise({
        name: input.name,
        description: input.description,
        userCategories: await userCategoryNames(req.user.id),
      });
      const category = await ensureCategory(req.user.id, result.category);
      input.categoryId = category?.id ?? null;
      input.subcategory ??= result.subcategory ?? undefined;
    } else if (input.category && !input.categoryId) {
      // A category supplied by name is created if the user does not have it.
      const category = await ensureCategory(req.user.id, input.category);
      input.categoryId = category?.id ?? null;
    }
    delete input.autoCategorise;

    res.status(201).json({ subscription: await subs.createSubscription(req.user.id, input) });
  }),
);

subscriptionsRouter.patch(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const patch = { ...req.body };
    delete patch.autoCategorise;
    if (patch.category && !patch.categoryId) {
      const category = await ensureCategory(req.user.id, patch.category);
      patch.categoryId = category?.id ?? null;
    }
    res.json({ subscription: await subs.updateSubscription(req.user.id, req.params.id, patch) });
  }),
);

subscriptionsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json({ subscription: await subs.cancelSubscription(req.user.id, req.params.id) });
  }),
);

subscriptionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await subs.deleteSubscription(req.user.id, req.params.id));
  }),
);

subscriptionsRouter.post(
  '/:id/payments',
  validate(
    z
      .object({
        amount: money.optional(),
        currency: currency.optional(),
        paymentDate: isoDate.optional(),
        status: paymentStatus.optional(),
        method: shortText(60).optional(),
        note: shortText(500).optional(),
        /** Set false to log a payment without moving the renewal date. */
        advanceRenewal: z.boolean().optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.status(201).json({
      payment: await subs.recordPayment(req.user.id, req.params.id, req.body),
    });
  }),
);

subscriptionsRouter.post(
  '/:id/cancel-link',
  asyncHandler(async (req, res) => {
    res.json({ url: await createCancelLink(req.user.id, req.params.id) });
  }),
);

subscriptionsRouter.post(
  '/:id/usage',
  validate(
    z
      .object({
        occurredAt: z.coerce.date().optional(),
        source: z.enum(['manual', 'desktop', 'web', 'import', 'estimate']).optional(),
        weight: z.coerce.number().min(0).max(10).optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json(await subs.recordUsage(req.user.id, req.params.id, req.body));
  }),
);
