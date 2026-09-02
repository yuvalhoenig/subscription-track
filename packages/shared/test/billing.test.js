import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyCost, yearlyCost, addMonths, addDays, addCycles, nextRenewalDate,
  renewalsBetween, daysBetween, daysUntil, totalMonthly, spendByCategory,
  costPerUse, round2, toDateString, assertCycle,
} from '../src/billing.js';
import { findService, nameSimilarity, normaliseName, marketRateFor } from '../src/catalog.js';
import { titleCase, formatCurrency, formatRelativeDays } from '../src/format.js';
import { colorForCategory } from '../src/categories.js';

test('monthlyCost normalises every cycle to a month', () => {
  assert.equal(monthlyCost(10, 'monthly'), 10);
  assert.equal(monthlyCost(120, 'yearly'), 10);
  assert.equal(monthlyCost(30, 'quarterly'), 10);
  assert.equal(monthlyCost(60, 'semiannual'), 10);
  // 52 weeks / 12 months, not a flat 4 weeks: this is the figure that
  // actually leaves the account over a year.
  assert.equal(monthlyCost(10, 'weekly'), 43.33);
  assert.equal(monthlyCost(10, 'biweekly'), 21.67);
});

test('yearlyCost is the annual total, not monthly x 12 of a rounded figure', () => {
  assert.equal(yearlyCost(10, 'weekly'), 520);
  assert.equal(yearlyCost(15.99, 'monthly'), 191.88);
  assert.equal(yearlyCost(100, 'yearly'), 100);
});

test('addMonths clamps to the end of a short month', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'leap year February');
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28', 'non-leap February');
  assert.equal(addMonths('2025-03-31', -1), '2025-02-28', 'backwards too');
  assert.equal(addMonths('2025-05-31', 1), '2025-06-30');
  assert.equal(addMonths('2025-12-15', 1), '2026-01-15', 'crosses the year');
  assert.equal(addMonths('2025-01-15', -1), '2024-12-15');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2025-01-01', -1), '2024-12-31');
});

test('addCycles advances by whole billing periods', () => {
  assert.equal(addCycles('2026-01-15', 'weekly', 2), '2026-01-29');
  assert.equal(addCycles('2026-01-15', 'biweekly', 1), '2026-01-29');
  assert.equal(addCycles('2026-01-15', 'quarterly', 1), '2026-04-15');
  assert.equal(addCycles('2026-01-15', 'yearly', 1), '2027-01-15');
  assert.equal(addCycles('2026-01-15', 'yearly', -1), '2025-01-15');
});

test('nextRenewalDate rolls a stale date forward to the next real charge', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  // Anchored 2.5 years in the past; must land on the coming 15th.
  assert.equal(nextRenewalDate('2024-01-15', 'monthly', now), '2026-09-15');
  // Already in the future: left alone.
  assert.equal(nextRenewalDate('2026-12-01', 'monthly', now), '2026-12-01');
  // Today counts as due, not past.
  assert.equal(nextRenewalDate('2026-09-02', 'monthly', now), '2026-09-02');
  assert.equal(nextRenewalDate('2025-03-10', 'yearly', now), '2027-03-10');
});

test('renewalsBetween expands each occurrence in a window', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const weekly = renewalsBetween('2026-09-03', 'weekly', now, '2026-09-30');
  assert.deepEqual(weekly, ['2026-09-03', '2026-09-10', '2026-09-17', '2026-09-24']);
  // A yearly plan renewing outside the window appears zero times.
  assert.deepEqual(renewalsBetween('2026-11-01', 'yearly', now, '2026-09-30'), []);
});

test('day arithmetic is signed and timezone-free', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-10'), 9);
  assert.equal(daysBetween('2026-09-10', '2026-09-01'), -9);
  // Across a DST boundary in local time; UTC dates must not drift.
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysUntil('2026-09-05', new Date('2026-09-02T23:00:00Z')), 3);
});

test('totalMonthly excludes trials by default and includes them on request', () => {
  const subs = [
    { cost: 10, billing_cycle: 'monthly', status: 'active' },
    { cost: 120, billing_cycle: 'yearly', status: 'active' },
    { cost: 50, billing_cycle: 'monthly', status: 'trial' },
    { cost: 99, billing_cycle: 'monthly', status: 'cancelled' },
    { cost: 20, billing_cycle: 'monthly', status: 'paused' },
  ];
  assert.equal(totalMonthly(subs), 20, 'active only: 10 + 10');
  assert.equal(totalMonthly(subs, { includeTrials: true }), 70, 'plus the trial');
});

test('spendByCategory groups active spend, highest first', () => {
  const result = spendByCategory([
    { cost: 10, billing_cycle: 'monthly', status: 'active', category: 'Streaming' },
    { cost: 5, billing_cycle: 'monthly', status: 'active', category: 'Streaming' },
    { cost: 240, billing_cycle: 'yearly', status: 'active', category: 'Software' },
    { cost: 99, billing_cycle: 'monthly', status: 'cancelled', category: 'Gaming' },
  ]);
  assert.deepEqual(result, [
    { category: 'Software', monthly: 20, yearly: 240 },
    { category: 'Streaming', monthly: 15, yearly: 180 },
  ]);
});

test('costPerUse returns null rather than Infinity with no usage', () => {
  assert.equal(costPerUse(16, 'monthly', 8), 2);
  assert.equal(costPerUse(120, 'yearly', 5), 2);
  assert.equal(costPerUse(16, 'monthly', 0), null);
  assert.equal(costPerUse(16, 'monthly', null), null);
});

test('round2 avoids binary floating-point artefacts', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(15.994), 15.99);
});

test('toDateString takes UTC components so dates never shift a day', () => {
  assert.equal(toDateString('2026-09-02'), '2026-09-02');
  assert.equal(toDateString('2026-09-02T23:59:59Z'), '2026-09-02');
  assert.equal(toDateString(new Date('2026-09-02T00:00:00Z')), '2026-09-02');
});

test('invalid input is rejected loudly', () => {
  assert.throws(() => assertCycle('fortnightly'), /Unsupported billing cycle/);
  assert.throws(() => monthlyCost('abc', 'monthly'), /Invalid cost/);
  assert.throws(() => toDateString('not-a-date'), /Invalid date/);
});

test('catalogue resolves names, aliases and typos', () => {
  assert.equal(findService('Netflix')?.id, 'netflix');
  assert.equal(findService('netflix.com')?.id, 'netflix');
  assert.equal(findService('NETFLIX premium')?.id, 'netflix');
  assert.equal(findService('Netflx')?.id, 'netflix', 'one-character typo');
  assert.equal(findService('adobe creative suite')?.id, 'adobe-cc', 'alias');
  assert.equal(findService('Some Local Business')?.id, undefined);
});

test('short words do not match long service names by containment', () => {
  // Regression: "to" (from "subscribe to") scored 0.9 against "todoist",
  // which categorised a gym membership as a task manager.
  assert.ok(nameSimilarity('to', 'todoist') < 0.5);
  assert.equal(findService('to'), null);
  assert.equal(nameSimilarity('netflix premium', 'netflix'), 1);
  assert.ok(nameSimilarity('netflx', 'netflix') > 0.8);
});

test('normaliseName strips noise words and domains', () => {
  assert.equal(normaliseName('Spotify Premium'), 'spotify');
  assert.equal(normaliseName('  NETFLIX.COM  '), 'netflix');
  assert.equal(normaliseName('GitHub Pro Subscription'), 'github');
});

test('market rates are returned as a band', () => {
  const rate = marketRateFor('Spotify');
  assert.ok(rate.low <= rate.typical && rate.typical <= rate.high);
  assert.equal(marketRateFor('Nonexistent Service'), null);
});

test('formatting helpers', () => {
  assert.equal(titleCase('  netflix   PREMIUM '), 'Netflix Premium');
  assert.equal(formatCurrency(15.99, 'USD'), '$15.99');
  assert.equal(formatCurrency(16, 'USD'), '$16');
  assert.equal(formatCurrency(null), '—');
  assert.equal(formatRelativeDays('2026-09-03', new Date('2026-09-02')), 'tomorrow');
  assert.equal(formatRelativeDays('2026-09-02', new Date('2026-09-02')), 'today');
  assert.equal(formatRelativeDays('2026-09-09', new Date('2026-09-02')), 'in 7 days');
});

test('category colours are stable for unknown names', () => {
  assert.equal(colorForCategory('Streaming'), '#e0245e');
  assert.equal(colorForCategory('My Custom Thing'), colorForCategory('My Custom Thing'));
});
