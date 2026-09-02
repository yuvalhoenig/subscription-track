#!/usr/bin/env node
/**
 * Create (or promote) a specific admin account, non-interactively.
 *
 * This is the intended way to provision a named admin login — it never
 * touches source control, so real credentials never end up committed to
 * the repository the way a hardcoded seed-script account would.
 *
 * Idempotent: if the address already exists, its password is reset to the
 * one given and it is promoted to admin; if not, a fresh, pre-verified
 * admin account is created with the default category set.
 *
 *   node src/db/create-admin.js you@example.com 'a-strong-password' ["Display Name"]
 */

import { DEFAULT_CATEGORIES } from '@subtrack/shared';
import { one, tx, closePool } from './pool.js';
import { hashPassword } from '../services/accounts.js';
import { logger } from '../lib/logger.js';

const log = logger.child('create-admin');
const [, , email, password, name] = process.argv;

if (!email || !password) {
  process.stderr.write("Usage: node src/db/create-admin.js <email> <password> [\"Display Name\"]\n");
  process.exit(1);
}
if (password.length < 10) {
  process.stderr.write('Password must be at least 10 characters.\n');
  process.exit(1);
}

async function seedDefaultCategories(db, userId) {
  const values = [];
  const params = [];
  DEFAULT_CATEGORIES.forEach((category, index) => {
    const base = index * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true)`);
    params.push(userId, category.name, category.color, category.icon, index);
  });
  await db.query(
    `INSERT INTO categories (user_id, name, color, icon, sort_order, is_default)
     VALUES ${values.join(', ')}`,
    params,
  );
}

try {
  const passwordHash = await hashPassword(password);
  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);

  if (existing) {
    await tx(async (db) => {
      await db.query(
        'UPDATE users SET password_hash = $1, is_admin = true, email_verified = true WHERE id = $2',
        [passwordHash, existing.id],
      );
    });
    process.stdout.write(`Updated existing account: ${email} is now an admin with the given password.\n`);
  } else {
    await tx(async (db) => {
      const user = await db.one(
        `INSERT INTO users (email, password_hash, name, email_verified, is_admin)
         VALUES ($1, $2, $3, true, true)
         RETURNING id`,
        [email, passwordHash, name || email.split('@')[0]],
      );
      await seedDefaultCategories(db, user.id);
    });
    process.stdout.write(`Created a new admin account: ${email}\n`);
  }

  await closePool();
  process.exit(0);
} catch (error) {
  log.error('Failed to create admin', { error: error.message });
  await closePool().catch(() => {});
  process.exit(1);
}
