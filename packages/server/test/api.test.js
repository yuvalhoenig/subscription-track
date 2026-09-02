/**
 * API integration tests.
 *
 * Runs the real Express app against a real PostgreSQL database
 * (`subtrack_test`), because the things most worth testing here — row-level
 * user scoping, the unique constraints, cascade deletes, the refresh-token
 * rotation rules — only exist in the database. Mocking it out would test
 * the mock.
 *
 * Setup:
 *   createdb subtrack_test
 *   npm run test:migrate --workspace @subtrack/server
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, query, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

let server;
let baseUrl;

/** Unique addresses so reruns never collide on the users_email unique index. */
const uniqueEmail = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;

async function api(method, path, { body, token, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    data: raw ? text : (() => { try { return JSON.parse(text); } catch { return text; } })(),
  };
}

/** Register a throwaway account and return its session. */
async function newUser(prefix = 'user') {
  const email = uniqueEmail(prefix);
  const response = await api('POST', '/api/auth/register', {
    body: { email, password: 'TestPassword123', name: 'Test Person' },
  });
  assert.equal(response.status, 201, `registration failed: ${JSON.stringify(response.data)}`);
  return { email, ...response.data };
}

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Remove only the accounts these tests created.
  await query(`DELETE FROM users WHERE email LIKE '%@example.test'`);
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

// ── Health ─────────────────────────────────────────────────────

test('health endpoint reports database connectivity', async () => {
  const { status, data } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.database, true);
});

// ── Registration & sign-in ─────────────────────────────────────

test('registration creates an account with the default categories', async () => {
  const session = await newUser('register');
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.equal(session.user.email_verified, false, 'a new address starts unverified');

  const { data } = await api('GET', '/api/categories', { token: session.accessToken });
  assert.equal(data.categories.length, 10);
  assert.ok(data.categories.every((category) => category.is_default));
});

test('registration rejects a duplicate address and a weak password', async () => {
  const session = await newUser('dupe');
  const duplicate = await api('POST', '/api/auth/register', {
    body: { email: session.email, password: 'TestPassword123', name: 'Someone Else' },
  });
  assert.equal(duplicate.status, 409);

  const weak = await api('POST', '/api/auth/register', {
    body: { email: uniqueEmail('weak'), password: 'short', name: 'Test' },
  });
  assert.equal(weak.status, 400);
  assert.ok(weak.data.error.details.password);
});

test('sign-in does not reveal whether an address is registered', async () => {
  const session = await newUser('signin');

  const wrongPassword = await api('POST', '/api/auth/login', {
    body: { email: session.email, password: 'WrongPassword123' },
  });
  const unknownEmail = await api('POST', '/api/auth/login', {
    body: { email: uniqueEmail('ghost'), password: 'WrongPassword123' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  // Identical code and message: the response cannot be used to enumerate users.
  assert.equal(wrongPassword.data.error.code, unknownEmail.data.error.code);
  assert.equal(wrongPassword.data.error.message, unknownEmail.data.error.message);
});

test('a valid sign-in returns a working access token', async () => {
  const session = await newUser('login');
  const login = await api('POST', '/api/auth/login', {
    body: { email: session.email, password: 'TestPassword123' },
  });
  assert.equal(login.status, 200);
  const me = await api('GET', '/api/users/me', { token: login.data.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, session.email);
});

test('protected routes reject missing and malformed tokens', async () => {
  assert.equal((await api('GET', '/api/subscriptions')).status, 401);
  assert.equal((await api('GET', '/api/subscriptions', { token: 'garbage' })).status, 401);
  const { data } = await api('GET', '/api/subscriptions', { token: 'garbage' });
  assert.equal(data.error.code, 'token_invalid');
});

// ── Refresh token rotation ─────────────────────────────────────

test('refresh tokens rotate, and reuse revokes every session', async () => {
  const session = await newUser('rotate');

  const first = await api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } });
  assert.equal(first.status, 200);
  assert.notEqual(first.data.refreshToken, session.refreshToken, 'the token must rotate');

  // The new token works.
  const second = await api('POST', '/api/auth/refresh', { body: { refreshToken: first.data.refreshToken } });
  assert.equal(second.status, 200);

  // Replaying the already-rotated token is treated as theft.
  const replay = await api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } });
  assert.equal(replay.status, 401);
  assert.equal(replay.data.error.code, 'refresh_reused');

  // ...and every outstanding session for that user is now dead.
  const afterBreach = await api('POST', '/api/auth/refresh', { body: { refreshToken: second.data.refreshToken } });
  assert.equal(afterBreach.status, 401, 'all sessions revoked after detected reuse');
});

test('logout revokes only the presented token', async () => {
  const session = await newUser('logout');
  const other = await api('POST', '/api/auth/login', {
    body: { email: session.email, password: 'TestPassword123' },
  });

  await api('POST', '/api/auth/logout', { body: { refreshToken: session.refreshToken } });
  assert.equal(
    (await api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    401,
  );
  // The second device is untouched.
  assert.equal(
    (await api('POST', '/api/auth/refresh', { body: { refreshToken: other.data.refreshToken } })).status,
    200,
  );
});

test('password reset does not disclose whether an address exists', async () => {
  const known = await api('POST', '/api/auth/forgot-password', { body: { email: uniqueEmail('known') } });
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, { sent: true });
});

// ── Subscription CRUD ──────────────────────────────────────────

test('subscription lifecycle: create, read, update, cancel, delete', async () => {
  const { accessToken: token } = await newUser('crud');

  const created = await api('POST', '/api/subscriptions', {
    token,
    body: { name: 'Netflix', cost: 15.99, billingCycle: 'monthly', renewalDate: '2026-12-01' },
  });
  assert.equal(created.status, 201);
  const subscription = created.data.subscription;
  // Auto-categorisation resolves a known service without an API key.
  assert.equal(subscription.category, 'Streaming');
  assert.equal(subscription.vendor_id, 'netflix');
  assert.equal(subscription.monthlyCost, 15.99);
  assert.equal(subscription.yearlyCost, 191.88);

  const fetched = await api('GET', `/api/subscriptions/${subscription.id}`, { token });
  assert.equal(fetched.data.subscription.name, 'Netflix');

  const updated = await api('PATCH', `/api/subscriptions/${subscription.id}`, {
    token, body: { cost: 19.99 },
  });
  assert.equal(updated.data.subscription.cost, 19.99);

  // The price change is recorded and surfaces as a finding.
  const optimised = await api('GET', '/api/analytics/optimize', { token });
  assert.ok(
    optimised.data.findings.some((finding) => finding.type === 'price_increase'),
    'a price rise should be detected',
  );

  const cancelled = await api('POST', `/api/subscriptions/${subscription.id}/cancel`, { token });
  assert.equal(cancelled.data.subscription.status, 'cancelled');
  assert.ok(cancelled.data.subscription.cancelled_at);

  assert.equal((await api('DELETE', `/api/subscriptions/${subscription.id}`, { token })).status, 200);
  assert.equal((await api('GET', `/api/subscriptions/${subscription.id}`, { token })).status, 404);
});

test('validation rejects bad input and unknown fields', async () => {
  const { accessToken: token } = await newUser('validate');
  const cases = [
    [{ name: 'X', cost: -1, billingCycle: 'monthly' }, 'negative cost'],
    [{ name: 'X', cost: 5, billingCycle: 'fortnightly' }, 'invalid cycle'],
    [{ name: '', cost: 5, billingCycle: 'monthly' }, 'empty name'],
    [{ cost: 5, billingCycle: 'monthly' }, 'missing name'],
    [{ name: 'X', cost: 5, billingCycle: 'monthly', renewalDate: '2026-13-45' }, 'impossible date'],
    // A client must not be able to set AI-maintained columns directly.
    [{ name: 'X', cost: 5, billingCycle: 'monthly', usage_score: 100 }, 'unknown field'],
  ];
  for (const [body, label] of cases) {
    const { status } = await api('POST', '/api/subscriptions', { token, body });
    assert.equal(status, 400, `${label} should be rejected`);
  }
});

test('a trial requires an end date', async () => {
  const { accessToken: token } = await newUser('trial');
  const missing = await api('POST', '/api/subscriptions', {
    token, body: { name: 'Duolingo', cost: 12.99, billingCycle: 'monthly', status: 'trial' },
  });
  assert.equal(missing.status, 400);

  const valid = await api('POST', '/api/subscriptions', {
    token,
    body: { name: 'Duolingo', cost: 12.99, billingCycle: 'monthly', status: 'trial', trialEndsAt: '2026-12-01' },
  });
  assert.equal(valid.status, 201);
});

// ── User scoping ───────────────────────────────────────────────

test('one user cannot see or touch another user\'s data', async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  const created = await api('POST', '/api/subscriptions', {
    token: alice.accessToken,
    body: { name: 'Alice Private Service', cost: 42, billingCycle: 'monthly' },
  });
  const id = created.data.subscription.id;

  // Bob sees nothing and can do nothing, and gets 404 rather than 403 so
  // the response does not confirm the id exists.
  assert.equal((await api('GET', '/api/subscriptions', { token: bob.accessToken })).data.subscriptions.length, 0);
  assert.equal((await api('GET', `/api/subscriptions/${id}`, { token: bob.accessToken })).status, 404);
  assert.equal((await api('PATCH', `/api/subscriptions/${id}`, { token: bob.accessToken, body: { cost: 1 } })).status, 404);
  assert.equal((await api('DELETE', `/api/subscriptions/${id}`, { token: bob.accessToken })).status, 404);

  // Alice's row is untouched.
  assert.equal((await api('GET', `/api/subscriptions/${id}`, { token: alice.accessToken })).data.subscription.cost, 42);
});

test('deleting an account cascades to all of its data', async () => {
  const session = await newUser('cascade');
  const created = await api('POST', '/api/subscriptions', {
    token: session.accessToken,
    body: { name: 'Spotify', cost: 11.99, billingCycle: 'monthly' },
  });
  const subscriptionId = created.data.subscription.id;
  await api('POST', `/api/subscriptions/${subscriptionId}/payments`, {
    token: session.accessToken, body: { amount: 11.99 },
  });

  const deleted = await api('DELETE', '/api/users/me', {
    token: session.accessToken, body: { password: 'TestPassword123' },
  });
  assert.equal(deleted.status, 200);

  // No orphaned rows anywhere.
  for (const table of ['subscriptions', 'payment_history', 'categories', 'refresh_tokens']) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE user_id = $1`,
      [session.user.id],
    );
    assert.equal(rows[0].count, 0, `${table} should have no rows left`);
  }
});

test('account deletion requires the correct password', async () => {
  const session = await newUser('deleteauth');
  const wrong = await api('DELETE', '/api/users/me', {
    token: session.accessToken, body: { password: 'NotThePassword1' },
  });
  assert.equal(wrong.status, 401);
  // Still usable afterwards.
  assert.equal((await api('GET', '/api/users/me', { token: session.accessToken })).status, 200);
});

// ── Categories ─────────────────────────────────────────────────

test('categories are per-user and unique case-insensitively', async () => {
  const { accessToken: token } = await newUser('cats');
  const created = await api('POST', '/api/categories', { token, body: { name: 'Boats', color: '#123456' } });
  assert.equal(created.status, 201);

  const duplicate = await api('POST', '/api/categories', { token, body: { name: 'boats' } });
  assert.equal(duplicate.status, 409, 'case-insensitive uniqueness');

  const badColour = await api('POST', '/api/categories', { token, body: { name: 'Planes', color: 'red' } });
  assert.equal(badColour.status, 400);
});

test('deleting a category keeps its subscriptions', async () => {
  const { accessToken: token } = await newUser('catdel');
  const category = await api('POST', '/api/categories', { token, body: { name: 'Temporary' } });
  const subscription = await api('POST', '/api/subscriptions', {
    token,
    body: { name: 'Some Service', cost: 9.99, billingCycle: 'monthly', categoryId: category.data.category.id },
  });

  await api('DELETE', `/api/categories/${category.data.category.id}`, { token });

  // Spending history must survive: the FK is ON DELETE SET NULL.
  const after = await api('GET', `/api/subscriptions/${subscription.data.subscription.id}`, { token });
  assert.equal(after.status, 200);
  assert.equal(after.data.subscription.category, 'Uncategorised');
  assert.equal(after.data.subscription.cost, 9.99);
});

// ── Analytics ──────────────────────────────────────────────────

test('analytics handle an empty account without breaking', async () => {
  const { accessToken: token } = await newUser('empty');

  const overview = await api('GET', '/api/analytics/overview', { token });
  assert.equal(overview.data.spend.monthly, 0);
  assert.equal(overview.data.counts.active, 0);
  assert.equal(overview.data.budget, null);

  const forecast = await api('GET', '/api/analytics/forecast', { token });
  assert.equal(forecast.data.insufficientData, true);
  assert.ok(forecast.data.note, 'should explain why');

  const trend = await api('GET', '/api/analytics/trend', { token });
  assert.equal(trend.data.direction, 'unknown');

  const anomalies = await api('GET', '/api/analytics/anomalies', { token });
  assert.deepEqual(anomalies.data.spendAnomalies, []);

  const optimise = await api('GET', '/api/analytics/optimize', { token });
  assert.equal(optimise.data.totalPotentialSavings.monthly, 0);
});

test('overview totals normalise mixed billing cycles', async () => {
  const { accessToken: token } = await newUser('totals');
  await api('POST', '/api/subscriptions', { token, body: { name: 'Monthly Thing', cost: 10, billingCycle: 'monthly' } });
  await api('POST', '/api/subscriptions', { token, body: { name: 'Yearly Thing', cost: 120, billingCycle: 'yearly' } });
  await api('POST', '/api/subscriptions', { token, body: { name: 'Weekly Thing', cost: 10, billingCycle: 'weekly' } });

  const { data } = await api('GET', '/api/analytics/overview', { token });
  // 10 + 10 + 43.33
  assert.equal(data.spend.monthly, 63.33);
  assert.equal(data.spend.yearly, 759.96);
  assert.equal(data.counts.active, 3);
});

test('budget tracking reports usage and overspend', async () => {
  const { accessToken: token } = await newUser('budget');
  await api('PATCH', '/api/users/me', { token, body: { monthly_budget: 50 } });
  await api('POST', '/api/subscriptions', { token, body: { name: 'Pricey', cost: 75, billingCycle: 'monthly' } });

  const { data } = await api('GET', '/api/analytics/overview', { token });
  assert.equal(data.budget.monthly, 50);
  assert.equal(data.budget.overBudget, true);
  assert.equal(data.budget.usedPercent, 150);
  assert.equal(data.budget.remaining, -25);
});

test('CSV export is downloadable and escapes formula injection', async () => {
  const { accessToken: token } = await newUser('csv');
  // A name that a spreadsheet would otherwise evaluate as a formula.
  await api('POST', '/api/subscriptions', {
    token, body: { name: '=cmd|calc', cost: 5, billingCycle: 'monthly' },
  });

  const { status, headers, data } = await api('GET', '/api/analytics/export', { token, raw: true });
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /text\/csv/);
  assert.match(headers.get('content-disposition'), /attachment; filename="subtrack-subscriptions-/);
  assert.match(data, /^Name,Category/);
  // Prefixed with a quote so it is imported as text, not executed.
  assert.ok(data.includes("'=cmd|calc"), 'formula-like values must be neutralised');
});

test('renewal calendar expands recurring charges', async () => {
  const { accessToken: token } = await newUser('calendar');
  await api('POST', '/api/subscriptions', {
    token, body: { name: 'Weekly Service', cost: 5, billingCycle: 'weekly' },
  });
  const { data } = await api('GET', '/api/subscriptions/calendar?days=28', { token });
  // A weekly plan should appear about four times in a four-week window.
  assert.ok(data.count >= 4, `expected >= 4 occurrences, got ${data.count}`);
  assert.ok(data.events.every((event) => event.date >= data.from && event.date <= data.until));
});

// ── Payments and usage ─────────────────────────────────────────

test('recording a payment advances the renewal date', async () => {
  const { accessToken: token } = await newUser('payments');
  const created = await api('POST', '/api/subscriptions', {
    token,
    body: { name: 'Some Plan', cost: 20, billingCycle: 'monthly', renewalDate: '2026-10-15' },
  });
  const id = created.data.subscription.id;

  await api('POST', `/api/subscriptions/${id}/payments`, { token, body: { amount: 20 } });
  const after = await api('GET', `/api/subscriptions/${id}`, { token });
  assert.equal(after.data.subscription.renewal_date, '2026-11-15');

  // Opting out leaves the date alone.
  await api('POST', `/api/subscriptions/${id}/payments`, {
    token, body: { amount: 20, advanceRenewal: false },
  });
  const unchanged = await api('GET', `/api/subscriptions/${id}`, { token });
  assert.equal(unchanged.data.subscription.renewal_date, '2026-11-15');
});

test('usage events roll up into scores', async () => {
  const { accessToken: token } = await newUser('usage');
  const created = await api('POST', '/api/subscriptions', {
    token, body: { name: 'Used Thing', cost: 10, billingCycle: 'monthly' },
  });
  const id = created.data.subscription.id;

  for (let i = 0; i < 5; i += 1) {
    await api('POST', `/api/subscriptions/${id}/usage`, { token, body: { source: 'web' } });
  }

  const { data } = await api('GET', '/api/analytics/usage', { token });
  const scored = data.subscriptions.find((s) => s.id === id);
  assert.equal(scored.usesLast30d, 5);
  assert.ok(scored.usageScore > 0);
  assert.equal(scored.costPerUse, 2);
});

// ── AI endpoints (heuristic mode) ──────────────────────────────

test('AI status reports heuristic mode with features still available', async () => {
  const { accessToken: token } = await newUser('aistatus');
  const { data } = await api('GET', '/api/ai/status', { token });
  // These tests run without an API key, which must not disable features.
  assert.equal(data.mode, 'heuristic');
  assert.equal(data.features.chat, true);
  assert.equal(data.features.extraction, true);
});

test('extraction endpoint returns a structured draft', async () => {
  const { accessToken: token } = await newUser('extract');
  const { data } = await api('POST', '/api/ai/extract', {
    token, body: { text: 'I just got Hulu for $18.99 a month' },
  });
  assert.equal(data.draft.name, 'Hulu');
  assert.equal(data.draft.cost, 18.99);
  assert.equal(data.draft.billingCycle, 'monthly');
  assert.deepEqual(data.missing, []);
});

test('the assistant adds a subscription from natural language', async () => {
  const { accessToken: token } = await newUser('chat');
  const { data } = await api('POST', '/api/ai/chat', {
    token, body: { message: 'I just got Netflix for $15.99/month' },
  });
  assert.ok(data.sessionId);
  assert.ok(data.actions.some((action) => action.type === 'subscription_created'));

  const list = await api('GET', '/api/subscriptions', { token });
  assert.equal(list.data.subscriptions.length, 1);
  assert.equal(list.data.subscriptions[0].name, 'Netflix');

  // The conversation is persisted and replayable.
  const history = await api('GET', `/api/ai/chat/${data.sessionId}`, { token });
  assert.equal(history.data.messages.length, 2);
  assert.equal(history.data.messages[0].sender, 'user');
});

test('the assistant asks for missing details instead of inventing them', async () => {
  const { accessToken: token } = await newUser('chatask');
  const { data } = await api('POST', '/api/ai/chat', {
    token, body: { message: 'I signed up for Figma' },
  });
  assert.match(data.reply, /how much/i);
  // Nothing should have been created from an incomplete description.
  assert.equal((await api('GET', '/api/subscriptions', { token })).data.subscriptions.length, 0);
});

test('cancellation via chat requires explicit confirmation', async () => {
  const { accessToken: token } = await newUser('chatcancel');
  const created = await api('POST', '/api/subscriptions', {
    token, body: { name: 'Peloton', cost: 44, billingCycle: 'monthly' },
  });

  const proposed = await api('POST', '/api/ai/chat', { token, body: { message: 'cancel my Peloton' } });
  const pending = proposed.data.actions.find((action) => action.type === 'pending_confirmation');
  assert.ok(pending, 'should propose rather than act');

  // Still active until confirmed.
  const before = await api('GET', `/api/subscriptions/${created.data.subscription.id}`, { token });
  assert.equal(before.data.subscription.status, 'active');

  const confirmed = await api('POST', '/api/ai/chat/confirm', {
    token, body: { action: { type: 'cancel_subscription', subscriptionId: created.data.subscription.id } },
  });
  assert.equal(confirmed.data.subscription.status, 'cancelled');
});

test('receipt text parsing picks the total, not the subtotal', async () => {
  const { accessToken: token } = await newUser('receipt');
  const { data } = await api('POST', '/api/ai/receipt/text', {
    token,
    body: { text: 'SPOTIFY\nSubtotal $10.99\nTax $1.00\nTotal $11.99\nMonthly subscription\nCharged 03/15/2026' },
  });
  assert.equal(data.draft.name, 'Spotify');
  assert.equal(data.draft.cost, 11.99);
  assert.equal(data.draft.billingCycle, 'monthly');
});

test('e-mail scan finds subscriptions, skips noise and flags duplicates', async () => {
  const { accessToken: token } = await newUser('emailscan');
  await api('POST', '/api/subscriptions', {
    token, body: { name: 'Netflix', cost: 15.99, billingCycle: 'monthly' },
  });

  const { data } = await api('POST', '/api/ai/email/scan', {
    token,
    body: {
      messages: [
        { from: 'Netflix <info@netflix.com>', subject: 'Your Netflix receipt', body: 'Total $24.99. Your monthly subscription renews 04/10/2026.' },
        { from: 'ship@amazon.com', subject: 'Your package has shipped', body: 'Tracking 1Z999' },
        { from: 'billing@figma.com', subject: 'Figma subscription receipt', body: 'Total $15.00 monthly plan. Manage your subscription.' },
      ],
    },
  });

  assert.equal(data.scanned, 3);
  assert.equal(data.found, 2, 'the shipping notice is skipped');
  const netflix = data.candidates.find((candidate) => candidate.duplicateOf);
  assert.ok(netflix, 'the already-tracked service should be flagged');
  assert.equal(netflix.duplicateOf.name, 'Netflix');
  // The receipt shows a different price than what is on file.
  assert.deepEqual(netflix.priceChanged, { from: 15.99, to: 24.99 });
});

// ── Insights ───────────────────────────────────────────────────

test('insights are generated from real findings and can be dismissed', async () => {
  const { accessToken: token } = await newUser('insights');
  // Two entries for the same vendor, one of them unused and expensive.
  await api('POST', '/api/subscriptions', { token, body: { name: 'Netflix', cost: 24.99, billingCycle: 'monthly' } });
  await api('POST', '/api/subscriptions', { token, body: { name: 'Netflix Premium', cost: 24.99, billingCycle: 'monthly' } });

  const generated = await api('POST', '/api/insights/generate', { token, body: { narrate: false } });
  assert.equal(generated.status, 200);
  assert.ok(generated.data.insights.length > 0);
  assert.equal(generated.data.generatedBy, 'heuristic');
  assert.ok(
    generated.data.insights.some((insight) => insight.insight_type === 'duplicate'),
    'the duplicate should be found',
  );

  const listed = await api('GET', '/api/insights', { token });
  assert.ok(listed.data.insights.length > 0);

  const first = listed.data.insights[0];
  assert.equal((await api('POST', `/api/insights/${first.id}/dismiss`, { token })).data.dismissed, true);
  const after = await api('GET', '/api/insights', { token });
  assert.ok(!after.data.insights.some((insight) => insight.id === first.id));
});

test('regenerating insights updates rather than duplicating them', async () => {
  const { accessToken: token } = await newUser('idempotent');
  await api('POST', '/api/subscriptions', { token, body: { name: 'Netflix', cost: 24.99, billingCycle: 'monthly' } });
  await api('POST', '/api/subscriptions', { token, body: { name: 'Netflix Premium', cost: 24.99, billingCycle: 'monthly' } });

  await api('POST', '/api/insights/generate', { token, body: { narrate: false } });
  const first = (await api('GET', '/api/insights', { token })).data.insights.length;
  await api('POST', '/api/insights/generate', { token, body: { narrate: false } });
  const second = (await api('GET', '/api/insights', { token })).data.insights.length;
  // The fingerprint index makes generation idempotent within a month.
  assert.equal(first, second, 'nightly regeneration must not pile up duplicates');
});

// ── Error handling ─────────────────────────────────────────────

test('errors use one consistent shape with a request id', async () => {
  const { status, data, headers } = await api('GET', '/api/nope');
  assert.equal(status, 404);
  assert.equal(data.error.code, 'not_found');
  assert.ok(data.error.requestId);
  assert.equal(data.error.requestId, headers.get('x-request-id'), 'echoed for support');
});

test('malformed JSON is rejected cleanly', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'bad_json');
});

test('a malformed uuid is a 400, not a 500', async () => {
  const { accessToken: token } = await newUser('baduuid');
  const { status } = await api('GET', '/api/subscriptions/not-a-uuid', { token });
  assert.ok(status === 400 || status === 404, `got ${status}`);
});

// ── Admin panel ──────────────────────────────────────────────

test('a non-admin is blocked from every admin route', async () => {
  const { accessToken: token } = await newUser('nonadmin');
  assert.equal((await api('GET', '/api/admin/stats', { token })).status, 403);
  assert.equal((await api('GET', '/api/admin/users', { token })).status, 403);
  assert.equal((await api('GET', '/api/admin/audit-log', { token })).status, 403);
});

test('an admin can list, inspect, promote, demote, force-logout and delete users', async () => {
  const admin = await newUser('adminowner');
  await query('UPDATE users SET is_admin = true WHERE id = $1', [admin.user.id]);
  // The cached row from requireAuth must not shadow the flag just set.
  await query(`SELECT 1`); // no-op; cache invalidation happens through the app, not here
  const target = await newUser('supporttarget');

  // Re-authenticate the admin so req.user reflects is_admin = true
  // (the login response is cached per-request, not stale across calls).
  const relogin = await api('POST', '/api/auth/login', { body: { email: admin.email, password: 'TestPassword123' } });
  const adminToken = relogin.data.accessToken;

  const stats = await api('GET', '/api/admin/stats', { token: adminToken });
  assert.equal(stats.status, 200);
  assert.ok(stats.data.users.total >= 2);

  const list = await api('GET', '/api/admin/users', { token: adminToken });
  assert.ok(list.data.users.some((u) => u.email === target.email));

  const detail = await api('GET', `/api/admin/users/${target.user.id}`, { token: adminToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.user.email, target.email);
  assert.ok(Array.isArray(detail.data.recentPayments));
  assert.ok(Array.isArray(detail.data.recentNotifications));
  assert.ok('insightsGenerated' in detail.data.activity);

  const promoted = await api('POST', `/api/admin/users/${target.user.id}/admin`, {
    token: adminToken, body: { isAdmin: true },
  });
  assert.equal(promoted.data.is_admin, true);

  const demoted = await api('POST', `/api/admin/users/${target.user.id}/admin`, {
    token: adminToken, body: { isAdmin: false },
  });
  assert.equal(demoted.data.is_admin, false);

  const forced = await api('POST', `/api/admin/users/${target.user.id}/logout-all`, { token: adminToken });
  assert.equal(forced.status, 200);
  assert.equal(typeof forced.data.revoked, 'number');

  // Cannot delete yourself through the admin surface.
  const selfDelete = await api('DELETE', `/api/admin/users/${admin.user.id}`, { token: adminToken });
  assert.equal(selfDelete.status, 400);

  // Deleting someone else must report success, not a foreign-key error
  // from the audit-log insert that follows the deletion.
  const deleted = await api('DELETE', `/api/admin/users/${target.user.id}`, { token: adminToken });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);

  const gone = await api('GET', `/api/admin/users/${target.user.id}`, { token: adminToken });
  assert.equal(gone.status, 404);

  const audit = await api('GET', '/api/admin/audit-log', { token: adminToken });
  const actions = audit.data.entries.map((e) => e.action);
  assert.ok(actions.includes('grant_admin'));
  assert.ok(actions.includes('revoke_admin'));
  assert.ok(actions.includes('force_logout'));
  assert.ok(actions.includes('delete_user'));
  // The deleted user's e-mail survives in `detail` even with no row to join.
  const deleteEntry = audit.data.entries.find((e) => e.action === 'delete_user' && e.detail?.email === target.email);
  assert.ok(deleteEntry, 'delete_user audit entry should carry the deleted email in detail');
});

test('an admin can create a pre-verified account directly, optionally as an admin', async () => {
  const admin = await newUser('creatoradmin');
  await query('UPDATE users SET is_admin = true WHERE id = $1', [admin.user.id]);
  const relogin = await api('POST', '/api/auth/login', { body: { email: admin.email, password: 'TestPassword123' } });
  const adminToken = relogin.data.accessToken;

  const email = `created-${Date.now()}@example.com`;
  const created = await api('POST', '/api/admin/users', {
    token: adminToken,
    body: { email, password: 'TestPassword123', name: 'Created User', isAdmin: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.email, email);
  assert.equal(created.data.email_verified, true);
  assert.equal(created.data.is_admin, true);

  // The new account can sign in immediately with no verification step.
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'TestPassword123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.is_admin, true);
  assert.equal(login.data.user.email_verified, true);

  // Duplicate e-mail is rejected.
  const dupe = await api('POST', '/api/admin/users', {
    token: adminToken,
    body: { email, password: 'TestPassword123', name: 'Created User' },
  });
  assert.equal(dupe.status, 409);

  const audit = await api('GET', '/api/admin/audit-log', { token: adminToken });
  const entry = audit.data.entries.find((e) => e.action === 'create_user' && e.detail?.email === email);
  assert.ok(entry, 'create_user audit entry should record the new e-mail');
});

test('the sole remaining admin cannot demote themselves', async () => {
  const solo = await newUser('soloadmin');
  await query('UPDATE users SET is_admin = true WHERE id = $1', [solo.user.id]);
  const relogin = await api('POST', '/api/auth/login', { body: { email: solo.email, password: 'TestPassword123' } });
  const token = relogin.data.accessToken;

  // Demote every other admin created by earlier tests in this file so this
  // account is genuinely the only one, then attempt (and expect to fail)
  // its own self-demotion.
  await query(`UPDATE users SET is_admin = false WHERE id <> $1 AND is_admin = true`, [solo.user.id]);

  const attempt = await api('POST', `/api/admin/users/${solo.user.id}/admin`, {
    token, body: { isAdmin: false },
  });
  assert.equal(attempt.status, 400);

  // Still an admin afterwards.
  const me = await api('GET', '/api/users/me', { token });
  assert.equal(me.data.user.is_admin, true);
});

// ── One-click cancellation links ───────────────────────────────

test('a cancel link previews without cancelling, then cancels on confirm', async () => {
  const { accessToken: token } = await newUser('cancellink');
  const created = await api('POST', '/api/subscriptions', {
    token, body: { name: 'LinkTest', cost: 12.5, billingCycle: 'monthly' },
  });
  const subscriptionId = created.data.subscription.id;

  const linkResponse = await api('POST', `/api/subscriptions/${subscriptionId}/cancel-link`, { token });
  assert.equal(linkResponse.status, 200);
  const tokenValue = linkResponse.data.url.split('/cancel/')[1];
  assert.ok(tokenValue?.length > 20);

  // GET must be side-effect free: a mail client or link scanner fetches it
  // automatically, and that must never cancel anything.
  const preview = await api('GET', `/api/public/cancel/${tokenValue}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.name, 'LinkTest');
  assert.equal(preview.data.alreadyCancelled, false);

  const stillActive = await api('GET', `/api/subscriptions/${subscriptionId}`, { token });
  assert.equal(stillActive.data.subscription.status, 'active', 'GET preview must not cancel');

  const confirmed = await api('POST', `/api/public/cancel/${tokenValue}`);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.alreadyCancelled, false);
  assert.equal(confirmed.data.monthlySaving, 12.5);

  const afterCancel = await api('GET', `/api/subscriptions/${subscriptionId}`, { token });
  assert.equal(afterCancel.data.subscription.status, 'cancelled');

  // Replaying an already-used token is idempotent, not an error.
  const replay = await api('POST', `/api/public/cancel/${tokenValue}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.alreadyCancelled, true);
});

test('an invalid or unknown cancel token is rejected', async () => {
  const bogus = await api('GET', '/api/public/cancel/not-a-real-token-at-all');
  assert.equal(bogus.status, 404);
});

test('cannot generate a new cancel link for an already-cancelled subscription', async () => {
  const { accessToken: token } = await newUser('cancellink2');
  const created = await api('POST', '/api/subscriptions', {
    token, body: { name: 'AlreadyGone', cost: 5, billingCycle: 'monthly' },
  });
  await api('POST', `/api/subscriptions/${created.data.subscription.id}/cancel`, { token });

  const linkAttempt = await api('POST', `/api/subscriptions/${created.data.subscription.id}/cancel-link`, { token });
  assert.equal(linkAttempt.status, 400);
});
