/**
 * Vercel serverless entrypoint.
 *
 * `src/index.js` is the traditional entrypoint: it calls `app.listen()`,
 * starts the `node-cron` scheduler and wires signal handlers for a
 * process that is expected to keep running. None of that applies on
 * Vercel — there is no persistent process to listen on a port or keep a
 * cron timer alive between requests — so this file exports the bare
 * Express app instead, which is all Vercel's Node.js runtime needs to
 * turn every request into a function invocation. Background jobs run via
 * the HTTP routes in `src/routes/cron.js`, triggered by Vercel Cron
 * (see the root `vercel.json`) instead of an in-process timer.
 */

import { createApp } from '../src/app.js';
import { assertProductionConfig } from '../src/config/index.js';

// Same fail-fast check the traditional entrypoint runs before listening:
// a misconfigured secret should break every request loudly, not silently
// accept e.g. the dev JWT secret in production.
assertProductionConfig();

export default createApp();
