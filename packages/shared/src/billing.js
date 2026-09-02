/**
 * Billing-cycle arithmetic.
 *
 * Every date in SubTrack is stored and manipulated as a calendar date
 * ("YYYY-MM-DD") in UTC. Renewal dates are inherently timezone-free — a
 * subscription that renews on the 14th renews on the 14th wherever you are —
 * and keeping them as plain strings avoids the classic off-by-one-day bugs
 * that come from round-tripping through local-time Date objects.
 */

import { BILLING_CYCLES, CYCLES_PER_YEAR } from './constants.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Throws on anything that isn't a supported billing cycle. */
export function assertCycle(cycle) {
  if (!BILLING_CYCLES.includes(cycle)) {
    throw new TypeError(
      `Unsupported billing cycle "${cycle}". Expected one of: ${BILLING_CYCLES.join(', ')}`,
    );
  }
  return cycle;
}

/**
 * Coerce a Date, ISO timestamp or "YYYY-MM-DD" string into "YYYY-MM-DD".
 * Uses the UTC components so a value never shifts a day under a negative
 * timezone offset.
 */
export function toDateString(value) {
  if (value == null) throw new TypeError('A date is required');
  if (typeof value === 'string') {
    const bare = value.slice(0, 10);
    if (DATE_RE.test(bare)) return bare;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${String(value)}`);
  }
  return date.toISOString().slice(0, 10);
}

/** Parse "YYYY-MM-DD" into a UTC-midnight Date. */
export function parseDate(value) {
  const [, y, m, d] = DATE_RE.exec(toDateString(value));
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/** Today's calendar date in UTC. */
export function today(now = new Date()) {
  return toDateString(now);
}

function fromParts(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return toDateString(new Date(parseDate(date).getTime() + days * MS_PER_DAY));
}

/**
 * Add whole months, clamping to the end of the target month.
 * Jan 31 + 1 month === Feb 28 (or Feb 29 in a leap year) rather than Mar 3,
 * which is what naive `setMonth` arithmetic would give you.
 */
export function addMonths(date, months) {
  const d = parseDate(date);
  const year = d.getUTCFullYear();
  const monthIndex = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return fromParts(targetYear, targetMonth, Math.min(day, lastDay));
}

/** Advance a date by `count` billing periods of the given cycle. */
export function addCycles(date, cycle, count = 1) {
  assertCycle(cycle);
  switch (cycle) {
    case 'weekly':
      return addDays(date, 7 * count);
    case 'biweekly':
      return addDays(date, 14 * count);
    case 'monthly':
      return addMonths(date, count);
    case 'quarterly':
      return addMonths(date, 3 * count);
    case 'semiannual':
      return addMonths(date, 6 * count);
    case 'yearly':
      return addMonths(date, 12 * count);
    default:
      throw new TypeError(`Unhandled cycle ${cycle}`);
  }
}

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / MS_PER_DAY);
}

/** Days until a renewal date, relative to today (negative = overdue). */
export function daysUntil(date, now = new Date()) {
  return daysBetween(today(now), date);
}

/**
 * Roll a renewal date forward until it is on or after `from`.
 *
 * Renewal dates drift into the past whenever nobody opens the app for a
 * while, so read paths project them forward instead of trusting the stored
 * value. Capped at 500 iterations so a corrupt row can never spin forever.
 */
export function nextRenewalDate(anchorDate, cycle, from = new Date()) {
  assertCycle(cycle);
  const start = today(from);
  let candidate = toDateString(anchorDate);
  for (let i = 0; i < 500 && candidate < start; i += 1) {
    candidate = addCycles(candidate, cycle, 1);
  }
  return candidate;
}

/** Every renewal date in [from, until], inclusive. Useful for calendars. */
export function renewalsBetween(anchorDate, cycle, from, until) {
  assertCycle(cycle);
  const end = toDateString(until);
  const dates = [];
  let candidate = nextRenewalDate(anchorDate, cycle, from);
  for (let i = 0; i < 500 && candidate <= end; i += 1) {
    dates.push(candidate);
    candidate = addCycles(candidate, cycle, 1);
  }
  return dates;
}

function toAmount(cost) {
  const value = typeof cost === 'number' ? cost : Number.parseFloat(cost);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid cost: ${String(cost)}`);
  }
  return value;
}

/** Round to cents without the usual floating-point surprises. */
export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Normalise any cycle to an equivalent monthly amount.
 * Weekly plans use 52/12 weeks per month rather than a flat 4, so a
 * $10/week plan is $43.33/month — the number that actually leaves your
 * account over a year — not $40.
 */
export function monthlyCost(cost, cycle) {
  assertCycle(cycle);
  return round2((toAmount(cost) * CYCLES_PER_YEAR[cycle]) / 12);
}

/** Normalise any cycle to an equivalent yearly amount. */
export function yearlyCost(cost, cycle) {
  assertCycle(cycle);
  return round2(toAmount(cost) * CYCLES_PER_YEAR[cycle]);
}

/** True when the subscription contributes to current spend. */
export function isBillable(subscription) {
  return subscription?.status === 'active' || subscription?.status === 'trial';
}

function cycleOf(sub) {
  return sub.billing_cycle ?? sub.billingCycle;
}

/**
 * Total monthly spend across a set of subscriptions.
 * Only `active` rows count by default: a trial costs nothing today, and
 * rolling it into the headline number would overstate current spend. Pass
 * `includeTrials` for the "what happens if every trial converts" figure.
 */
export function totalMonthly(subscriptions = [], { includeTrials = false } = {}) {
  return round2(
    subscriptions
      .filter((s) => (includeTrials ? isBillable(s) : s.status === 'active'))
      .reduce((sum, s) => sum + monthlyCost(s.cost, cycleOf(s)), 0),
  );
}

export function totalYearly(subscriptions = [], options) {
  return round2(totalMonthly(subscriptions, options) * 12);
}

/** Group monthly spend by category, highest spend first. */
export function spendByCategory(subscriptions = []) {
  const buckets = new Map();
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const key = sub.category ?? sub.category_name ?? 'Uncategorised';
    const amount = monthlyCost(sub.cost, cycleOf(sub));
    buckets.set(key, round2((buckets.get(key) ?? 0) + amount));
  }
  return [...buckets.entries()]
    .map(([category, monthly]) => ({ category, monthly, yearly: round2(monthly * 12) }))
    .sort((a, b) => b.monthly - a.monthly);
}

/**
 * Estimated cost per use, the headline number behind "is this worth it?".
 * Returns null when there is no usage signal at all, so the UI can show
 * "not enough data" instead of a misleading Infinity.
 */
export function costPerUse(cost, cycle, usesPerMonth) {
  const uses = Number(usesPerMonth);
  if (!Number.isFinite(uses) || uses <= 0) return null;
  return round2(monthlyCost(cost, cycle) / uses);
}
