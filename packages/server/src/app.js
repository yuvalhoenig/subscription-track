/** Express application assembly. */

import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { logger } from './lib/logger.js';

const log = logger.child('http');

export function createApp() {
  const app = express();

  // Behind a load balancer or reverse proxy, rate limiting and logging
  // need the real client IP rather than the proxy's.
  app.set('trust proxy', config.isProd ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON, so a restrictive CSP costs nothing here. The
      // web client is served separately by Vite/your CDN with its own.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      /**
       * Electron loads the renderer from `file://`, which browsers send as
       * a null/absent Origin. Requests with no Origin are allowed (they
       * cannot be CSRF from a web page), everything else must be on the
       * allow-list.
       */
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        log.warn('Blocked CORS origin', { origin });
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  // 1MB is generous for JSON here; receipt images come through multer,
  // which has its own limit.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Correlation id, echoed in error bodies so a user can quote it in a
  // support request and we can find the exact log line.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id']?.toString().slice(0, 64) ?? crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // Access log. Skipped for /health so a monitor polling every 5s does
  // not drown out real traffic.
  if (!config.isTest) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        log.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
          ms: Math.round(ms),
          requestId: req.id,
          userId: req.user?.id,
        });
      });
      return next();
    });
  }

  app.use('/api', apiLimiter, apiRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'SubTrack API',
      version: '1.0.0',
      docs: '/api/health',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
