/** Route table. */

import { Router } from 'express';
import { authRouter } from './auth.js';
import { usersRouter } from './users.js';
import { subscriptionsRouter } from './subscriptions.js';
import { categoriesRouter } from './categories.js';
import { analyticsRouter } from './analytics.js';
import { aiRouter } from './ai.js';
import { insightsRouter } from './insights.js';
import { notificationsRouter } from './notifications.js';
import { adminRouter } from './admin.js';
import { publicRouter } from './public.js';
import { cronRouter } from './cron.js';
import { healthcheck } from '../db/pool.js';
import { cache } from '../lib/cache.js';
import { aiEnabled } from '../config/index.js';

export const apiRouter = Router();

/**
 * Liveness/readiness. Reports degraded rather than failing when Redis is
 * down, because the app runs correctly without it.
 */
apiRouter.get('/health', async (_req, res) => {
  const database = await healthcheck();
  const status = database ? 'ok' : 'error';
  res.status(database ? 200 : 503).json({
    status,
    database,
    cache: cache.backend,
    ai: aiEnabled() ? 'claude' : 'heuristic',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/categories', categoriesRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/insights', insightsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/public', publicRouter);
apiRouter.use('/cron', cronRouter);
