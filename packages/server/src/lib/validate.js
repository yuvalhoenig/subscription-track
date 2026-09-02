/**
 * Request validation built on zod.
 *
 * Every mutating endpoint validates its input here, which gives us three
 * things at once: a 400 with per-field messages instead of a 500 from
 * Postgres, coercion of the loose types that arrive over JSON, and a hard
 * boundary that strips unknown keys so a client cannot smuggle a column
 * (say `usage_score`) into an insert.
 */

import { z } from 'zod';
import {
  BILLING_CYCLES,
  SUBSCRIPTION_STATUSES,
  PAYMENT_STATUSES,
  SUPPORTED_LOCALES,
} from '@subtrack/shared';
import { badRequest } from './errors.js';

/** Turn a ZodError into `{ field: message }`. */
function fieldErrors(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Build middleware that validates `req[source]` and replaces it with the
 * parsed result, so handlers only ever see clean, typed data.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(badRequest('Validation failed', fieldErrors(result.error)));
    }
    req[source] = result.data;
    return next();
  };
}

/** Validate a value directly (used by AI code paths that aren't HTTP). */
export function parseOrThrow(schema, value, message = 'Validation failed') {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(message, fieldErrors(result.error));
  return result.data;
}

// ── Reusable primitives ────────────────────────────────────────

export const uuid = z.string().uuid('Must be a valid id');

export const email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .toLowerCase()
  .email('Enter a valid e-mail address');

/**
 * Password policy: length is the dominant factor in real-world strength,
 * so we require 10+ characters with some variety rather than a thicket of
 * symbol rules that push people towards "P@ssw0rd!".
 */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That password is too long')
  .refine((value) => /[a-z]/i.test(value), 'Include at least one letter')
  .refine((value) => /\d/.test(value) || /[^\w\s]/.test(value),
    'Include at least one number or symbol');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real date');

export const money = z.coerce
  .number({ message: 'Enter an amount' })
  .min(0, 'Cost cannot be negative')
  .max(1_000_000, 'That amount looks too large')
  // Guard against 3+ decimal places arriving from a parsed receipt.
  .transform((value) => Math.round(value * 100) / 100);

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #4f46e5');

export const billingCycle = z.enum(BILLING_CYCLES);
export const subscriptionStatus = z.enum(SUBSCRIPTION_STATUSES);
export const paymentStatus = z.enum(PAYMENT_STATUSES);
export const locale = z.enum(SUPPORTED_LOCALES);
export const currency = z.string().trim().length(3).toUpperCase();

/** Trimmed, bounded free text. Empty strings become undefined. */
export const shortText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters`)
    .transform((value) => (value === '' ? undefined : value));

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export { z };
