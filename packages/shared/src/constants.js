/**
 * Enumerations shared by the API, the web client and the desktop client.
 * These strings are persisted in Postgres (see the enum-like CHECK
 * constraints in the migrations), so treat them as a stable contract.
 */

export const BILLING_CYCLES = Object.freeze([
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'semiannual',
  'yearly',
]);

/** How many times each cycle bills in a single year. */
export const CYCLES_PER_YEAR = Object.freeze({
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
});

/** Human labels, used in the UI and in AI prompts. */
export const CYCLE_LABELS = Object.freeze({
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 months',
  yearly: 'Yearly',
});

export const SUBSCRIPTION_STATUSES = Object.freeze([
  'active',
  'trial',
  'paused',
  'cancelled',
]);

export const PAYMENT_STATUSES = Object.freeze([
  'paid',
  'pending',
  'failed',
  'refunded',
]);

export const INSIGHT_TYPES = Object.freeze([
  'savings',
  'duplicate',
  'unused',
  'anomaly',
  'forecast',
  'trend',
  'price_increase',
  'bundle',
  'renewal',
  'summary',
  'benchmark',
  'recommendation',
]);

/** Insight priority drives ordering and notification urgency. */
export const INSIGHT_SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high']);

export const CHAT_SENDERS = Object.freeze(['user', 'assistant', 'system']);

export const SUPPORTED_LOCALES = Object.freeze([
  'en',
  'es',
  'fr',
  'de',
  'pt',
  'he',
  'ja',
]);

export const CURRENCY_DEFAULT = 'USD';
