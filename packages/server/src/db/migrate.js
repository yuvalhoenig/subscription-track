#!/usr/bin/env node
/**
 * Forward-only migration runner.
 *
 * Applies every .sql file in ./migrations in filename order, inside a
 * transaction, recording each one in the `schema_migrations` table so
 * reruns are no-ops. Deliberately dependency-free: one fewer thing to
 * break during a deploy.
 *
 *   node src/db/migrate.js            apply pending migrations
 *   node src/db/migrate.js --reset    drop the public schema first
 *   node src/db/migrate.js --status   list applied / pending
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

const log = logger.child('migrate');
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureRegistry(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrations() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function reset(client) {
  log.warn('Dropping the public schema (--reset)');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
}

export async function migrate({ resetFirst = false, statusOnly = false } = {}) {
  const client = await pool.connect();
  try {
    if (resetFirst) {
      if (config.isProd) throw new Error('--reset is refused when NODE_ENV=production');
      await reset(client);
    }
    await ensureRegistry(client);

    const migrations = await loadMigrations();
    const { rows: applied } = await client.query('SELECT name, checksum FROM schema_migrations');
    const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));

    if (statusOnly) {
      for (const migration of migrations) {
        const state = appliedByName.has(migration.name) ? 'applied' : 'pending';
        process.stdout.write(`${state.padEnd(8)} ${migration.name}\n`);
      }
      return { applied: [], pending: migrations.filter((m) => !appliedByName.has(m.name)) };
    }

    const ran = [];
    for (const migration of migrations) {
      const previous = appliedByName.get(migration.name);
      if (previous) {
        // A changed checksum means someone edited an applied migration.
        // That silently diverges environments, so warn loudly rather than
        // re-running (which would usually fail anyway).
        if (previous !== migration.checksum) {
          log.warn('Applied migration has changed on disk; skipping', { name: migration.name });
        }
        continue;
      }
      log.info(`Applying ${migration.name}`);
      // Each migration is its own transaction: a failure leaves earlier
      // migrations applied and the failing one fully rolled back.
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        ran.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${migration.name} failed: ${error.message}`);
      }
    }

    if (ran.length) log.info(`Applied ${ran.length} migration(s)`, { migrations: ran });
    else log.info('Database already up to date');
    return { applied: ran, pending: [] };
  } finally {
    client.release();
  }
}

// Only run when invoked directly, so tests can import migrate().
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  try {
    await migrate({ resetFirst: args.has('--reset'), statusOnly: args.has('--status') });
    await closePool();
    process.exit(0);
  } catch (error) {
    log.error('Migration failed', { error: error.message });
    await closePool().catch(() => {});
    process.exit(1);
  }
}
