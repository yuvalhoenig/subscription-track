/**
 * Background jobs.
 *
 * Two cron jobs: a frequent one that queues and delivers notifications,
 * and a nightly one that regenerates scores and insights.
 *
 * Both are wrapped so that a job throwing can never take the process down,
 * and both refuse to overlap with themselves — a slow nightly run must not
 * be started again on top of itself.
 */

import cron from 'node-cron';
import { config } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { many } from '../../db/pool.js';
import {
  scheduleRenewalReminders,
  scheduleBudgetAlerts,
  deliverDueNotifications,
} from './index.js';
import { generateInsights } from '../ai/insights.js';
import { scoreSubscriptions } from '../analytics/usage.js';

const log = logger.child('cron');
const tasks = [];
const running = new Set();

/** Run a job at most once at a time, and never let it throw. */
function guarded(name, fn) {
  return async () => {
    if (running.has(name)) {
      log.warn(`Skipping ${name}: previous run still in progress`);
      return;
    }
    running.add(name);
    const started = Date.now();
    try {
      const result = await fn();
      log.info(`${name} finished`, { ms: Date.now() - started, ...(result ?? {}) });
    } catch (error) {
      log.error(`${name} failed`, { error: error.message, stack: error.stack });
    } finally {
      running.delete(name);
    }
  };
}

export const jobs = {
  /** Queue and deliver notifications. */
  notifications: guarded('notifications', async () => {
    const reminders = await scheduleRenewalReminders();
    const budgets = await scheduleBudgetAlerts();
    const delivered = await deliverDueNotifications();
    return {
      remindersQueued: reminders.queued,
      budgetAlertsQueued: budgets.queued,
      delivered: delivered.delivered,
    };
  }),

  /**
   * Nightly refresh of usage scores and AI insights.
   * Only for users with subscriptions — no point burning API budget on
   * empty accounts.
   */
  nightlyInsights: guarded('nightlyInsights', async () => {
    const users = await many(
      `SELECT DISTINCT user_id FROM subscriptions WHERE status IN ('active','trial')`,
    );
    let processed = 0;
    let failed = 0;
    for (const { user_id: userId } of users) {
      try {
        await scoreSubscriptions(userId);
        await generateInsights(userId);
        processed += 1;
      } catch (error) {
        // One bad account must not stop the batch.
        failed += 1;
        log.warn('Insight generation failed for user', { userId, error: error.message });
      }
    }
    return { users: users.length, processed, failed };
  }),
};

export function startScheduler() {
  if (!config.scheduler.enabled) {
    log.info('Scheduler disabled');
    return { started: false };
  }

  for (const [expression, job, name] of [
    [config.scheduler.reminders, jobs.notifications, 'notifications'],
    [config.scheduler.nightlyInsights, jobs.nightlyInsights, 'nightlyInsights'],
  ]) {
    if (!cron.validate(expression)) {
      log.error(`Invalid cron expression for ${name}; job not scheduled`, { expression });
      continue;
    }
    tasks.push(cron.schedule(expression, job, { timezone: 'UTC' }));
    log.info(`Scheduled ${name}`, { expression });
  }
  return { started: true, jobs: tasks.length };
}

export function stopScheduler() {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}
