#!/usr/bin/env node
/**
 * Entrypoint.
 *
 * Validates configuration, checks the database, starts the HTTP server and
 * the background scheduler, and shuts all of it down cleanly on a signal —
 * draining in-flight requests before exiting so a deploy does not sever
 * live connections.
 */

import { createApp } from './app.js';
import { config, assertProductionConfig, aiEnabled } from './config/index.js';
import { healthcheck, closePool } from './db/pool.js';
import { cache, cacheReady } from './lib/cache.js';
import { startScheduler, stopScheduler } from './services/notifications/scheduler.js';
import { shutdownOcr } from './services/ai/receipts.js';
import { logger } from './lib/logger.js';

const log = logger.child('boot');

async function main() {
  assertProductionConfig();

  if (!(await healthcheck())) {
    throw new Error(
      `Cannot reach PostgreSQL at ${config.db.url.replace(/:[^:@/]+@/, ':***@')}. ` +
        'Start it (docker compose up -d) and run: npm run db:migrate',
    );
  }
  // Give Redis its one connection attempt before reporting the backend.
  await cacheReady();

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`SubTrack API listening on http://localhost:${config.port}`, {
      env: config.env,
      cache: cache.backend,
      ai: aiEnabled() ? `claude (${config.ai.fastModel} / ${config.ai.smartModel})` : 'heuristic mode (no ANTHROPIC_API_KEY)',
    });
    if (!aiEnabled()) {
      log.warn(
        'ANTHROPIC_API_KEY is not set. AI features are running on deterministic ' +
          'heuristics: extraction, categorisation, insights and chat all work, ' +
          'with rule-based rather than model-generated results.',
      );
    }
  });

  // Node's default of 0 (no timeout) leaves sockets open indefinitely.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  startScheduler();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    // A second Ctrl-C should not start a parallel shutdown.
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);

    // Force-exit if a hung connection stops the drain from completing.
    const timer = setTimeout(() => {
      log.error('Shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    timer.unref();

    stopScheduler();
    server.close(async () => {
      try {
        await Promise.allSettled([shutdownOcr(), cache.close(), closePool()]);
        log.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error('Error during shutdown', { error: error.message });
        process.exit(1);
      }
    });
  };

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => void shutdown(signal));
  }

  // A crash with an open database pool is worse than a fast exit: log the
  // reason, then let the supervisor restart us.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception; exiting', { error });
    process.exit(1);
  });
}

main().catch((error) => {
  log.error('Failed to start', { error: error.message });
  process.exit(1);
});
