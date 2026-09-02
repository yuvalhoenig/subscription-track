/**
 * Typed application errors.
 *
 * Handlers throw these; the error middleware turns them into a JSON body.
 * Anything that isn't an AppError is treated as an unexpected failure and
 * reported as a 500 with its details withheld from the client.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
    // Distinguishes "the client did something wrong" from "we broke", which
    // decides whether the message is safe to return and whether we log it
    // at error level.
    this.expected = status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message = 'Invalid request', details) =>
  new AppError(message, { status: 400, code: 'bad_request', details });

export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(message, { status: 401, code });

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(message, { status: 403, code: 'forbidden' });

export const notFound = (message = 'Not found') =>
  new AppError(message, { status: 404, code: 'not_found' });

export const conflict = (message = 'Already exists', details) =>
  new AppError(message, { status: 409, code: 'conflict', details });

export const payloadTooLarge = (message = 'Upload too large') =>
  new AppError(message, { status: 413, code: 'payload_too_large' });

export const unprocessable = (message = 'Could not process request', details) =>
  new AppError(message, { status: 422, code: 'unprocessable', details });

export const tooManyRequests = (message = 'Too many requests', details) =>
  new AppError(message, { status: 429, code: 'rate_limited', details });

export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError(message, { status: 503, code: 'service_unavailable' });

/**
 * Wrap an async route handler so rejected promises reach Express's error
 * pipeline. Express 4 does not await handlers, so without this an async
 * throw becomes an unhandled rejection and the request hangs.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Map Postgres error codes onto sensible HTTP responses. */
export function fromPostgresError(error) {
  switch (error?.code) {
    case '23505': // unique_violation
      return conflict('That value is already taken');
    case '23P01': // exclusion_violation
      return conflict('That value conflicts with an existing record');
    case '23503': // foreign_key_violation
      return badRequest('Referenced record does not exist');
    case '23502': // not_null_violation
      return badRequest('A required field was missing');
    case '23514': // check_violation
      return badRequest('A value failed a database constraint');
    case '22P02': // invalid_text_representation, e.g. a malformed uuid
      return badRequest('Malformed identifier');
    case '22003': // numeric_value_out_of_range
      return badRequest('A numeric value was out of range');
    default:
      return null;
  }
}
