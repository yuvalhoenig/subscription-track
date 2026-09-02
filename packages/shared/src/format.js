/** Presentation helpers shared by the web and desktop clients. */

import { CURRENCY_DEFAULT } from './constants.js';
import { daysUntil } from './billing.js';

/**
 * True for values that should render as "—" rather than a number.
 * `Number(null)` and `Number('')` are both 0, so a Number.isFinite check
 * alone would display a missing amount as "$0" — misleading in a spending
 * app, where 0 and "not recorded" mean very different things.
 */
function isMissing(value) {
  return value == null || value === '' || !Number.isFinite(Number(value));
}

export function formatCurrency(amount, currency = CURRENCY_DEFAULT, locale = 'en-US') {
  if (isMissing(amount)) return '—';
  const value = Number(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCompactCurrency(amount, currency = CURRENCY_DEFAULT, locale = 'en-US') {
  if (isMissing(amount)) return '—';
  const value = Number(amount);
  if (Math.abs(value) < 10_000) return formatCurrency(value, currency, locale);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(date, locale = 'en-US', options) {
  if (!date) return '—';
  const parsed = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(parsed);
}

/** "in 3 days", "tomorrow", "5 days ago" — for renewal timelines. */
export function formatRelativeDays(date, now = new Date()) {
  const days = daysUntil(date, now);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  return `${Math.abs(days)} days ago`;
}

export function formatPercent(value, digits = 0) {
  if (isMissing(value)) return '—';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}%`;
}

/** Title-case a raw service name typed by a user or extracted by the AI. */
export function titleCase(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\p{L}[\p{L}'’]*/gu, (word) =>
      word.length <= 2 && word === word.toUpperCase()
        ? word
        : word[0].toUpperCase() + word.slice(1).toLowerCase(),
    );
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
