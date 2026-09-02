/**
 * Error and 404 handling — the last stop before a response leaves.
 *
 * The contract for every failure is the same JSON shape, so the clients
 * have exactly one error path to implement:
 *   { error: { code, message, details?, requestId } }
 */

import { AppError, fromPostgresError, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

const log = logger.child('http');

export const notFoundHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.originalUrl}`));
};

// eslint-disable-next-line max-params -- Express identifies error middleware by arity
export const errorHandler = (error, req, res, _next) => {
  // A malformed JSON body surfaces from body-parser as a SyntaxError.
  let appError =
    error instanceof AppError
      ? error
      : error?.type === 'entity.parse.failed'
        ? new AppError('Request body is not valid JSON', { status: 400, code: 'bad_json' })
        : error?.type === 'entity.too.large'
          ? new AppError('Request body is too large', { status: 413, code: 'payload_too_large' })
          : fromPostgresError(error);

  if (!appError) {
    appError = new AppError(error?.message ?? 'Unexpected error', {
      status: Number(error?.status) || Number(error?.statusCode) || 500,
      code: error?.code && typeof error.code === 'string' ? error.code : 'internal_error',
      cause: error,
    });
  }

  const status = appError.status ?? 500;

  if (status >= 500) {
    log.error('Request failed', {
      method: req.method,
      url: req.originalUrl,
      requestId: req.id,
      userId: req.user?.id,
      error,
    });
  } else {
    log.debug('Request rejected', {
      method: req.method,
      url: req.originalUrl,
      status,
      code: appError.code,
    });
  }

  const body = {
    error: {
      code: appError.code ?? 'internal_error',
      // Never leak an internal failure's message to the client; 4xx
      // messages are written for users and are safe to pass through.
      message: status >= 500 ? 'Something went wrong on our end' : appError.message,
      requestId: req.id,
    },
  };
  if (appError.details) body.error.details = appError.details;
  // Stack traces only outside production, and only for genuine 500s.
  if (!config.isProd && status >= 500 && error?.stack) body.error.stack = error.stack;

  res.status(status).json(body);
};
