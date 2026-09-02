#!/usr/bin/env node
/**
 * Seed a demo account.
 *
 * The data is deliberately shaped to exercise every analytical feature, so
 * that a fresh install shows a populated, believable dashboard rather than
 * empty states:
 *
 *   - four overlapping video services, three of which form the Disney
 *     Bundle → overlap + bundle findings
 *   - Netflix at the top of its market band → price-comparison finding
 *   - a duplicate Netflix entry → duplicate finding
 *   - Peloton and MasterClass with no usage in months → unused findings
 *   - two AI assistants → overlap finding
 *   - a recorded Netflix price rise → price-increase finding
 *   - 14 months of payment history with a summer dip → trend + seasonality
 *   - one anomalous month and one failed payment → anomaly findings
 *   - a Duolingo trial ending soon → renewal/trial alert
 *   - usage events across a realistic range → usage and value scores
 *
 * Idempotent: re-running deletes and rebuilds the demo user.
 *
 *   node src/db/seed.js              seed the demo account
 *   node src/db/seed.js --reset      wipe all users first
 */

import { addDays, addMonths, addCycles, today } from '@subtrack/shared';
import { pool, query, one, tx, closePool } from './pool.js';
import { hashPassword } from '../services/accounts.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { scoreSubscriptions } from '../services/analytics/usage.js';
import { generateInsights } from '../services/ai/insights.js';

const log = logger.child('seed');
const NOW = new Date();
const TODAY = today(NOW);

/** Category definitions, keyed for reference by the subscription list. */
const CATEGORIES = [
  { key: 'streaming', name: 'Streaming', color: '#e0245e', icon: 'play-circle' },
  { key: 'productivity', name: 'Productivity', color: '#4f46e5', icon: 'check-square' },
  { key: 'software', name: 'Software', color: '#0ea5e9', icon: 'code' },
  { key: 'health', name: 'Health & Fitness', color: '#10b981', icon: 'heart' },
  { key: 'news', name: 'News & Reading', color: '#f59e0b', icon: 'book-open' },
  { key: 'gaming', name: 'Gaming', color: '#8b5cf6', icon: 'gamepad' },
  { key: 'utilities', name: 'Utilities', color: '#64748b', icon: 'zap' },
  { key: 'education', name: 'Education', color: '#14b8a6', icon: 'graduation-cap' },
  { key: 'finance', name: 'Finance', color: '#22c55e', icon: 'trending-up' },
  { key: 'other', name: 'Other', color: '#94a3b8', icon: 'more-horizontal' },
];

/**
 * `renewalOffset` is days from today, so the calendar and reminder views
 * always have something in them however long after seeding you look.
 * `usesPerMonth` drives synthetic usage events.
 */
const SUBSCRIPTIONS = [
  // ── Streaming: overlap, bundle and price-comparison material ──
  {
    name: 'Netflix', vendorId: 'netflix', category: 'streaming', subcategory: 'Video',
    cost: 24.99, cycle: 'monthly', renewalOffset: 6, startedMonthsAgo: 26,
    usesPerMonth: 9, notes: 'Premium plan, 4 screens. Shared with family.',
    // Recorded price rise → price_increase insight.
    priceHistory: [{ monthsAgo: 4, from: 22.99, to: 24.99 }],
  },
  {
    // Deliberate duplicate entry → duplicate detection.
    name: 'Netflix Premium', vendorId: 'netflix', category: 'streaming', subcategory: 'Video',
    cost: 24.99, cycle: 'monthly', renewalOffset: 6, startedMonthsAgo: 3,
    usesPerMonth: 0, notes: 'Added twice by mistake during import.',
    skipPayments: true,
  },
  {
    name: 'Hulu', vendorId: 'hulu', category: 'streaming', subcategory: 'Video',
    cost: 18.99, cycle: 'monthly', renewalOffset: 13, startedMonthsAgo: 14, usesPerMonth: 3,
  },
  {
    name: 'Disney+', vendorId: 'disney-plus', category: 'streaming', subcategory: 'Video',
    cost: 15.99, cycle: 'monthly', renewalOffset: 19, startedMonthsAgo: 11, usesPerMonth: 2,
  },
  {
    name: 'ESPN+', vendorId: 'espn-plus', category: 'streaming', subcategory: 'Sports',
    cost: 11.99, cycle: 'monthly', renewalOffset: 24, startedMonthsAgo: 8, usesPerMonth: 1,
  },
  {
    name: 'Spotify', vendorId: 'spotify', category: 'streaming', subcategory: 'Music',
    cost: 19.99, cycle: 'monthly', renewalOffset: 2, startedMonthsAgo: 38,
    usesPerMonth: 26, notes: 'Premium Family — six accounts.',
  },
  {
    name: 'YouTube Premium', vendorId: 'youtube-premium', category: 'streaming', subcategory: 'Video',
    cost: 13.99, cycle: 'monthly', renewalOffset: 9, startedMonthsAgo: 16, usesPerMonth: 14,
  },

  // ── Software: two AI assistants → overlap ──
  {
    name: 'Adobe Creative Cloud', vendorId: 'adobe-cc', category: 'software', subcategory: 'Design',
    cost: 59.99, cycle: 'monthly', renewalOffset: 11, startedMonthsAgo: 22, usesPerMonth: 7,
  },
  {
    name: 'Claude Pro', vendorId: 'claude-pro', category: 'software', subcategory: 'AI Tools',
    cost: 20, cycle: 'monthly', renewalOffset: 4, startedMonthsAgo: 9, usesPerMonth: 22,
  },
  {
    name: 'ChatGPT Plus', vendorId: 'chatgpt-plus', category: 'software', subcategory: 'AI Tools',
    cost: 20, cycle: 'monthly', renewalOffset: 17, startedMonthsAgo: 12, usesPerMonth: 2,
  },
  {
    name: 'GitHub', vendorId: 'github', category: 'software', subcategory: 'Developer Tools',
    cost: 100, cycle: 'yearly', renewalOffset: 96, startedMonthsAgo: 30, usesPerMonth: 20,
  },
  {
    name: '1Password', vendorId: '1password', category: 'software', subcategory: 'Security',
    cost: 59.88, cycle: 'yearly', renewalOffset: 41, startedMonthsAgo: 25, usesPerMonth: 18,
  },

  // ── Unused, expensive: the headline savings findings ──
  {
    name: 'Peloton', vendorId: 'peloton', category: 'health', subcategory: 'Gym',
    cost: 44, cycle: 'monthly', renewalOffset: 8, startedMonthsAgo: 15,
    usesPerMonth: 0, lastUsedDaysAgo: 96, notes: 'Signed up in January. Used it twice.',
  },
  {
    name: 'MasterClass', vendorId: 'masterclass', category: 'education', subcategory: 'Courses',
    cost: 240, cycle: 'yearly', renewalOffset: 58, startedMonthsAgo: 18,
    usesPerMonth: 0, lastUsedDaysAgo: 130,
  },

  // ── Reasonable, well-used ──
  {
    name: 'iCloud+', vendorId: 'icloud', category: 'utilities', subcategory: 'Cloud',
    cost: 2.99, cycle: 'monthly', renewalOffset: 15, startedMonthsAgo: 45, usesPerMonth: 30,
  },
  {
    name: 'The New York Times', vendorId: 'nyt', category: 'news', subcategory: 'Newspapers',
    cost: 17, cycle: 'monthly', renewalOffset: 21, startedMonthsAgo: 20, usesPerMonth: 16,
  },
  {
    name: 'Xbox Game Pass', vendorId: 'xbox-game-pass', category: 'gaming', subcategory: 'Console',
    cost: 19.99, cycle: 'monthly', renewalOffset: 26, startedMonthsAgo: 7, usesPerMonth: 11,
  },
  {
    name: 'YNAB', vendorId: 'ynab', category: 'finance', subcategory: 'Banking',
    cost: 109, cycle: 'yearly', renewalOffset: 133, startedMonthsAgo: 24, usesPerMonth: 12,
  },
  {
    name: 'Local Yoga Studio', vendorId: null, category: 'health', subcategory: 'Gym',
    cost: 85, cycle: 'monthly', renewalOffset: 3, startedMonthsAgo: 6, usesPerMonth: 8,
  },

  // ── Trial ending soon → trial alert ──
  {
    name: 'Duolingo', vendorId: 'duolingo', category: 'education', subcategory: 'Language',
    cost: 12.99, cycle: 'monthly', renewalOffset: 3, startedMonthsAgo: 0,
    status: 'trial', trialOffset: 3, usesPerMonth: 9, skipPayments: true,
  },

  // ── Cancelled: shows in history, not in current spend ──
  {
    name: 'Dropbox', vendorId: 'dropbox', category: 'utilities', subcategory: 'Cloud',
    cost: 11.99, cycle: 'monthly', renewalOffset: -20, startedMonthsAgo: 28,
    status: 'cancelled', cancelledMonthsAgo: 2, usesPerMonth: 0, paymentsUntilMonthsAgo: 2,
  },
  // ── Paused ──
  {
    name: 'Crunchyroll', vendorId: 'crunchyroll', category: 'streaming', subcategory: 'Video',
    cost: 11.99, cycle: 'monthly', renewalOffset: 30, startedMonthsAgo: 10,
    status: 'paused', usesPerMonth: 0, paymentsUntilMonthsAgo: 3,
  },
];

/** Deterministic pseudo-random so seeded data is reproducible. */
function makeRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

async function wipeDemoUser(email) {
  const { rowCount } = await query('DELETE FROM users WHERE email = $1', [email]);
  if (rowCount) log.info('Removed previous demo account');
}

async function seed({ resetAll = false } = {}) {
  if (resetAll) {
    if (config.isProd) throw new Error('--reset is refused when NODE_ENV=production');
    await query('DELETE FROM users');
    log.warn('Deleted all users (--reset)');
  }

  const email = config.demo.email;
  await wipeDemoUser(email);

  const random = makeRandom(20260902);
  const passwordHash = await hashPassword(config.demo.password);

  const { userId, categoryIds, subscriptionIds } = await tx(async (db) => {
    const user = await db.one(
      `INSERT INTO users
         (email, password_hash, name, currency, locale, timezone, email_verified,
          is_admin, monthly_budget, preferences, last_login_at)
       VALUES ($1,$2,$3,'USD','en','America/New_York',true,true,325,$4,now())
       RETURNING id`,
      [
        email,
        passwordHash,
        'Demo User',
        JSON.stringify({
          theme: 'system',
          aiTone: 'friendly',
          insightFrequency: 'weekly',
          notifications: { email: true, renewalReminders: true, budgetAlerts: true, hour: 9 },
          dashboard: { defaultRange: '12m', hiddenCards: [] },
        }),
      ],
    );

    // Categories
    const ids = {};
    for (const [index, category] of CATEGORIES.entries()) {
      const row = await db.one(
        `INSERT INTO categories (user_id, name, color, icon, sort_order, is_default)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [user.id, category.name, category.color, category.icon, index],
      );
      ids[category.key] = row.id;
    }

    // Subscriptions
    const subIds = {};
    for (const spec of SUBSCRIPTIONS) {
      const status = spec.status ?? 'active';
      const row = await db.one(
        `INSERT INTO subscriptions
           (user_id, category_id, name, description, vendor_id, subcategory, cost, currency,
            billing_cycle, renewal_date, started_at, status, trial_ends_at, cancelled_at,
            auto_renew, notes, reminder_days_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          user.id,
          ids[spec.category],
          spec.name,
          spec.description ?? null,
          spec.vendorId,
          spec.subcategory ?? null,
          spec.cost,
          spec.cycle,
          addDays(TODAY, spec.renewalOffset),
          addMonths(TODAY, -spec.startedMonthsAgo),
          status,
          spec.trialOffset != null ? addDays(TODAY, spec.trialOffset) : null,
          spec.cancelledMonthsAgo != null ? addMonths(TODAY, -spec.cancelledMonthsAgo) : null,
          status !== 'cancelled' && status !== 'paused',
          spec.notes ?? null,
          spec.cost >= 40 ? 7 : 3,
        ],
      );
      subIds[spec.name] = row.id;

      // Recorded price changes
      for (const change of spec.priceHistory ?? []) {
        await db.query(
          `INSERT INTO price_history
             (subscription_id, user_id, old_cost, new_cost, old_cycle, new_cycle, changed_at)
           VALUES ($1,$2,$3,$4,$5,$5,$6)`,
          [
            row.id,
            user.id,
            change.from,
            change.to,
            spec.cycle,
            addMonths(TODAY, -change.monthsAgo),
          ],
        );
      }
    }

    return { userId: user.id, categoryIds: ids, subscriptionIds: subIds };
  });

  // ── Payment history ──
  // Generated by walking backwards from each subscription's renewal date
  // one billing cycle at a time — exactly how real billing works. This
  // matters for more than realism: generating annual renewals by a naive
  // "every 12th month" rule lands every yearly plan in the same calendar
  // month, which creates a fake spike big enough to skew the forecast and
  // trip the anomaly detector.
  let paymentCount = 0;
  const HISTORY_MONTHS = 14;
  const historyStart = addMonths(TODAY, -HISTORY_MONTHS);

  for (const spec of SUBSCRIPTIONS) {
    if (spec.skipPayments) continue;
    const subscriptionId = subscriptionIds[spec.name];
    const startedAt = addMonths(TODAY, -spec.startedMonthsAgo);
    // Payments stop when a subscription was cancelled or paused.
    const stopAfter =
      spec.paymentsUntilMonthsAgo != null ? addMonths(TODAY, -spec.paymentsUntilMonthsAgo) : TODAY;

    let date = addDays(TODAY, spec.renewalOffset);
    for (let step = 0; step < 200; step += 1) {
      date = addCycles(date, spec.cycle, -1);
      if (date < historyStart || date < startedAt) break;
      if (date >= stopAfter) continue;

      // The price in force at that time, before any recorded rise.
      const priceChange = (spec.priceHistory ?? []).find(
        (change) => date < addMonths(TODAY, -change.monthsAgo),
      );
      const amount = priceChange ? priceChange.from : spec.cost;

      // One failed payment, to give the anomaly detector something real.
      const failed = spec.name === 'Hulu' && date.slice(0, 7) === addMonths(TODAY, -5).slice(0, 7);

      await query(
        `INSERT INTO payment_history
           (subscription_id, user_id, payment_date, amount, currency, status, method)
         VALUES ($1,$2,$3,$4,'USD',$5,$6)`,
        [
          subscriptionId,
          userId,
          date,
          amount,
          failed ? 'failed' : 'paid',
          random() > 0.75 ? 'PayPal' : 'Visa •••• 4242',
        ],
      );
      paymentCount += 1;
    }
  }

  // An unusually expensive month three months back: an annual renewal plus
  // a one-off, which is exactly the shape MAD-based detection should catch
  // while a mean-based detector would miss it.
  await query(
    `INSERT INTO payment_history
       (subscription_id, user_id, payment_date, amount, currency, status, method, note)
     VALUES ($1,$2,$3,$4,'USD','paid','Visa •••• 4242',$5)`,
    [
      subscriptionIds['Adobe Creative Cloud'],
      userId,
      addDays(addMonths(TODAY, -3), 12),
      299.88,
      'Annual plan paid up front (in addition to the monthly charge)',
    ],
  );
  paymentCount += 1;

  // ── Usage events ──
  let usageCount = 0;
  for (const spec of SUBSCRIPTIONS) {
    const subscriptionId = subscriptionIds[spec.name];
    const uses = spec.usesPerMonth ?? 0;

    if (uses === 0) {
      // Dormant but previously used: gives the "unused for N days" finding
      // real data to work from rather than an absent usage row.
      if (spec.lastUsedDaysAgo != null) {
        for (let i = 0; i < 3; i += 1) {
          await query(
            `INSERT INTO usage_events (subscription_id, user_id, occurred_at, source)
             VALUES ($1,$2,$3,'import')`,
            [subscriptionId, userId, `${addDays(TODAY, -(spec.lastUsedDaysAgo + i * 4))}T18:00:00Z`],
          );
          usageCount += 1;
        }
      }
    } else {
      // Spread events over the last 90 days at roughly the stated rate.
      const total = Math.round(uses * 3);
      for (let i = 0; i < total; i += 1) {
        const daysAgo = Math.floor(random() * 90);
        const hour = 7 + Math.floor(random() * 15);
        await query(
          `INSERT INTO usage_events (subscription_id, user_id, occurred_at, source)
           VALUES ($1,$2,$3,$4)`,
          [
            subscriptionId,
            userId,
            `${addDays(TODAY, -daysAgo)}T${String(hour).padStart(2, '0')}:00:00Z`,
            random() > 0.5 ? 'desktop' : 'web',
          ],
        );
        usageCount += 1;
      }
    }

    // Roll the events up, matching what recordUsage() maintains at runtime.
    await query(
      `INSERT INTO usage_analytics (subscription_id, user_id, last_used_at, uses_last_30d, uses_last_90d)
       SELECT $1, $2, max(occurred_at),
              count(*) FILTER (WHERE occurred_at > now() - interval '30 days'),
              count(*) FILTER (WHERE occurred_at > now() - interval '90 days')
         FROM usage_events WHERE subscription_id = $1
       ON CONFLICT (subscription_id) DO UPDATE SET
         last_used_at = EXCLUDED.last_used_at,
         uses_last_30d = EXCLUDED.uses_last_30d,
         uses_last_90d = EXCLUDED.uses_last_90d`,
      [subscriptionId, userId],
    );
  }

  // ── A short assistant conversation, so the chat view isn't empty ──
  const sessionId = (await one('SELECT gen_random_uuid() AS id')).id;
  const conversation = [
    ['user', 'I just got Netflix for $24.99/month', {}],
    [
      'assistant',
      'Added Netflix at $24.99 monthly under Streaming. Heads up: you already track Netflix at the same price, so you may now have it twice.',
      { actions: [{ type: 'subscription_created' }] },
    ],
    ['user', 'How much do I spend on streaming?', {}],
    [
      'assistant',
      'Streaming is your largest category. Netflix, Hulu, Disney+, ESPN+, Spotify and YouTube Premium come to about $105 a month — roughly a third of your total subscription spend.',
      {},
    ],
    ['user', "What am I not using?", {}],
    [
      'assistant',
      'Peloton stands out: no recorded use in over three months at $44 a month, which is $528 a year. MasterClass is similar at $240 a year with nothing logged since spring.',
      {},
    ],
  ];
  for (const [sender, message, context] of conversation) {
    await query(
      `INSERT INTO chat_history (user_id, session_id, sender, message, context, model, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(mins => $7::int))`,
      [userId, sessionId, sender, message, JSON.stringify(context), 'seed', conversation.length * 3],
    );
  }

  // ── Derived data: scores, insights, forecasts ──
  // Runs the real production code paths, so the demo's insights are
  // genuinely computed rather than hard-coded.
  const scored = await scoreSubscriptions(userId, { now: NOW });
  const { insights, totalPotentialSavings, forecast } = await generateInsights(userId, {
    now: NOW,
    // Narration would need an API key; the templated text is used here so
    // seeding works offline and produces identical output every run.
    narrate: false,
  });

  // Persist the forecast so the predictions table isn't empty.
  for (const prediction of forecast.predictions ?? []) {
    await query(
      `INSERT INTO spending_predictions
         (user_id, predicted_amount, lower_bound, upper_bound, confidence,
          period_start, period_end, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, model)
       DO UPDATE SET predicted_amount = EXCLUDED.predicted_amount,
                     lower_bound = EXCLUDED.lower_bound,
                     upper_bound = EXCLUDED.upper_bound,
                     generated_at = now()`,
      [
        userId,
        prediction.predicted,
        prediction.lower,
        prediction.upper,
        forecast.confidence,
        `${prediction.month}-01`,
        addMonths(`${prediction.month}-01`, 1),
        forecast.model,
      ],
    );
  }

  const totals = await one(
    `SELECT count(*)::int AS subs,
            (SELECT count(*)::int FROM payment_history WHERE user_id = $1) AS payments,
            (SELECT count(*)::int FROM usage_events WHERE user_id = $1) AS usage_events,
            (SELECT count(*)::int FROM ai_insights WHERE user_id = $1) AS insights
       FROM subscriptions WHERE user_id = $1`,
    [userId],
  );

  // `insights.length` counts findings generated; `totals.insights` counts rows
  // that survived fingerprint de-duplication. They differ when two findings
  // of the same type target the same subscriptions in the same month.
  log.info('Demo account seeded', {
    email,
    subscriptions: totals.subs,
    payments: totals.payments,
    usageEvents: totals.usage_events,
    insights: totals.insights,
    scored: scored.length,
    potentialMonthlySavings: totalPotentialSavings.monthly,
  });

  process.stdout.write(
    `\n  Demo account ready (admin access included)\n` +
      `    e-mail:    ${email}\n` +
      `    password:  ${config.demo.password}\n\n` +
      `    ${totals.subs} subscriptions, ${totals.payments} payments, ` +
      `${totals.usage_events} usage events, ${totals.insights} insights\n` +
      `    identified savings: $${totalPotentialSavings.monthly}/month ` +
      `($${totalPotentialSavings.yearly}/year)\n\n`,
  );

  return { userId, categoryIds, subscriptionIds, paymentCount, usageCount };
}

export { seed };

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  try {
    await seed({ resetAll: args.has('--reset') });
    await closePool();
    process.exit(0);
  } catch (error) {
    log.error('Seed failed', { error: error.message, stack: error.stack });
    await closePool().catch(() => {});
    process.exit(1);
  }
}
