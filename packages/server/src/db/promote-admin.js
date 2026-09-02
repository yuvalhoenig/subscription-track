#!/usr/bin/env node
/**
 * Grant (or check) admin access for an existing account by e-mail.
 *
 * This is the bootstrapping path: the admin panel can promote further
 * users once at least one admin exists, but the very first admin has to
 * come from somewhere with direct database access, and running a script
 * against the production database is safer than granting SQL access to a
 * human to run one UPDATE by hand.
 *
 *   node src/db/promote-admin.js you@example.com
 */

import { query, one, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

const log = logger.child('promote-admin');
const email = process.argv[2];

if (!email) {
  process.stderr.write('Usage: node src/db/promote-admin.js <email>\n');
  process.exit(1);
}

try {
  const user = await one('SELECT id, email, is_admin FROM users WHERE email = $1', [email]);
  if (!user) {
    process.stderr.write(`No account found for ${email}\n`);
    await closePool();
    process.exit(1);
  }
  if (user.is_admin) {
    process.stdout.write(`${email} is already an admin.\n`);
  } else {
    await query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
    process.stdout.write(
      `${email} is now an admin. They may need to sign out and back in to see the Admin Panel.\n`,
    );
  }
  await closePool();
  process.exit(0);
} catch (error) {
  log.error('Failed to promote user', { error: error.message });
  await closePool().catch(() => {});
  process.exit(1);
}
