/**
 * PostgreSQL access layer.
 *
 * Exposes a small surface — query / one / many / tx — so route handlers
 * never touch a raw client and connections can't leak. All SQL in this
 * codebase is parameterised; there is no string interpolation of user
 * input anywhere.
 */

import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child('db');

// node-postgres hands back numeric/decimal as strings to avoid silent
// precision loss on bigints. Money in this app is numeric(12,2), well
// inside the safe-integer range once scaled, so parsing to Number here
// keeps arithmetic straightforward in the services above.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) =>
  value === null ? null : Number.parseFloat(value),
);
// Dates come back as plain "YYYY-MM-DD" strings rather than Date objects,
// matching how @subtrack/shared/billing treats calendar dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// An idle client erroring out (e.g. the database restarted) would otherwise
// be an unhandled 'error' event and take the process down.
pool.on('error', (error) => {
  log.error('Idle client error', { error: error.message });
});

const SLOW_QUERY_MS = 400;

/** Run a parameterised query. Logs anything slower than 400ms. */
export async function query(text, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    return await pool.query(text, params);
  } catch (error) {
    log.error('Query failed', { error: error.message, code: error.code, sql: text.slice(0, 160) });
    throw error;
  } finally {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms > SLOW_QUERY_MS) log.warn('Slow query', { ms: Math.round(ms), sql: text.slice(0, 160) });
  }
}

/** First row, or null. */
export async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** All rows. */
export async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Run a function inside a transaction, committing on success and rolling
 * back on any throw. The callback receives an object with the same
 * query/one/many helpers bound to the transaction's client.
 */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      query: (text, params) => client.query(text, params),
      one: async (text, params) => (await client.query(text, params)).rows[0] ?? null,
      many: async (text, params) => (await client.query(text, params)).rows,
      client,
    };
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Rollback is best-effort: if the connection itself died there is
    // nothing to roll back and the original error is the useful one.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** True when the database answers. Used by /health and by boot. */
export async function healthcheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool() {
  await pool.end();
}
