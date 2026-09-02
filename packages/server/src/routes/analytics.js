/** Dashboard analytics, forecasts, optimisation and CSV export. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  overview,
  categoryBreakdown,
  spendTimeline,
  categoryTimeline,
  projections,
  exportSubscriptionsCsv,
  exportPaymentsCsv,
} from '../services/analytics/reports.js';
import { forecastSpending, analyseTrend, forecastByCategory } from '../services/analytics/forecast.js';
import { optimize } from '../services/analytics/optimizer.js';
import {
  detectSpendAnomalies,
  detectChargeAnomalies,
  checkBudgetPressure,
} from '../services/analytics/anomaly.js';
import { scoreSubscriptions, valueRanking } from '../services/analytics/usage.js';
import { recommendations, benchmark } from '../services/analytics/recommend.js';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json(await overview(req.user.id));
  }),
);

analyticsRouter.get(
  '/categories',
  asyncHandler(async (req, res) => {
    res.json(await categoryBreakdown(req.user.id));
  }),
);

analyticsRouter.get(
  '/timeline',
  validate(
    z
      .object({
        months: z.coerce.number().int().min(1).max(36).default(12),
        /**
         * The current month is still accumulating charges, so including it
         * makes a chart look like spending collapsed. Callers plotting
         * history ask for complete months; callers reporting "so far this
         * month" leave it in.
         */
        includeCurrentMonth: z.coerce.boolean().default(true),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    res.json({
      timeline: await spendTimeline(req.user.id, {
        months: req.query.months,
        includeCurrentMonth: req.query.includeCurrentMonth,
      }),
    });
  }),
);

analyticsRouter.get(
  '/timeline/categories',
  validate(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    res.json(await categoryTimeline(req.user.id, { months: req.query.months }));
  }),
);

analyticsRouter.get(
  '/projections',
  validate(z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    res.json(await projections(req.user.id, { months: req.query.months }));
  }),
);

analyticsRouter.get(
  '/forecast',
  validate(
    z
      .object({
        horizon: z.coerce.number().int().min(1).max(12).default(6),
        confidence: z.coerce.number().min(0.5).max(0.95).default(0.8),
      })
      .strip(),
    'query',
  ),
  asyncHandler(async (req, res) => {
    res.json(await forecastSpending(req.user.id, req.query));
  }),
);

analyticsRouter.get(
  '/forecast/categories',
  asyncHandler(async (req, res) => {
    res.json({ forecasts: await forecastByCategory(req.user.id) });
  }),
);

analyticsRouter.get(
  '/trend',
  asyncHandler(async (req, res) => {
    res.json(await analyseTrend(req.user.id));
  }),
);

analyticsRouter.get(
  '/optimize',
  asyncHandler(async (req, res) => {
    res.json(await optimize(req.user.id));
  }),
);

analyticsRouter.get(
  '/anomalies',
  asyncHandler(async (req, res) => {
    const [spend, charges, budget] = await Promise.all([
      detectSpendAnomalies(req.user.id),
      detectChargeAnomalies(req.user.id),
      checkBudgetPressure(req.user.id),
    ]);
    res.json({
      spendAnomalies: spend.anomalies,
      baseline: spend.baseline,
      insufficientData: spend.insufficientData,
      chargeAnomalies: charges,
      budgetPressure: budget,
    });
  }),
);

analyticsRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json({ subscriptions: await scoreSubscriptions(req.user.id) });
  }),
);

analyticsRouter.get(
  '/value',
  asyncHandler(async (req, res) => {
    res.json(await valueRanking(req.user.id));
  }),
);

analyticsRouter.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    res.json(await recommendations(req.user.id));
  }),
);

analyticsRouter.get(
  '/benchmark',
  asyncHandler(async (req, res) => {
    res.json(await benchmark(req.user.id));
  }),
);

/**
 * CSV export.
 * Content-Disposition makes the browser download rather than render, and
 * the filename is server-generated so it cannot be influenced by input.
 */
analyticsRouter.get(
  '/export',
  validate(z.object({ type: z.enum(['subscriptions', 'payments']).default('subscriptions') }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    const isPayments = req.query.type === 'payments';
    const csv = isPayments
      ? await exportPaymentsCsv(req.user.id)
      : await exportSubscriptionsCsv(req.user.id);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="subtrack-${isPayments ? 'payments' : 'subscriptions'}-${stamp}.csv"`,
    );
    // Stops a browser from sniffing the response as something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
  }),
);

/** Force a rescore, e.g. after a bulk import. */
analyticsRouter.post(
  '/rescore',
  asyncHandler(async (req, res) => {
    const scored = await scoreSubscriptions(req.user.id);
    res.json({ scored: scored.length, subscriptions: scored });
  }),
);
