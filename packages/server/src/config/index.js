/**
 * Central configuration.
 *
 * Everything the app can be tuned with is resolved here, once, at import
 * time — so a missing or malformed setting fails at boot with a clear
 * message instead of surfacing as a confusing runtime error later.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

// Load .env from the repo root (monorepo-wide) then the package, so a
// package-local file can override shared defaults during development.
for (const candidate of [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'packages/server/.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false });
}

const bool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback = []) =>
  value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : fallback;

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// Dev/test fall back to a known-insecure secret so `npm run dev` works with
// no setup. Production refuses to boot without real ones (checked below).
const DEV_ACCESS_SECRET = 'subtrack-dev-access-secret-do-not-use-in-production';
const DEV_REFRESH_SECRET = 'subtrack-dev-refresh-secret-do-not-use-in-production';

export const config = Object.freeze({
  env: NODE_ENV,
  isProd,
  isTest,
  isDev: !isProd && !isTest,
  port: int(process.env.PORT, 4000),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  corsOrigins: list(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:4173',
  ]),

  db: {
    url:
      process.env.DATABASE_URL ||
      (isTest
        ? 'postgres://postgres:postgres@localhost:5432/subtrack_test'
        : 'postgres://postgres:postgres@localhost:5432/subtrack'),
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
    poolMax: int(process.env.PGPOOL_MAX, isTest ? 4 : 12),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    // Redis is a pure accelerator here; an in-process LRU takes over when
    // it is absent so single-node deployments need no extra service.
    enabled: bool(process.env.REDIS_ENABLED, true) && !isTest,
  },

  auth: {
    accessSecret: process.env.JWT_ACCESS_SECRET || DEV_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET || DEV_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, isTest ? 4 : 12),
    issuer: 'subtrack',
  },

  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // Two tiers: a cheap model for the high-volume parsing/classification
    // calls, a stronger one for narrative insight generation.
    fastModel: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001',
    smartModel: process.env.CLAUDE_MODEL_SMART || 'claude-sonnet-5',
    maxOutputTokens: int(process.env.AI_MAX_OUTPUT_TOKENS, 2048),
    rateLimitPerHour: int(process.env.AI_RATE_LIMIT_PER_HOUR, 60),
    cacheTtlSeconds: int(process.env.AI_CACHE_TTL_SECONDS, 900),
    requestTimeoutMs: int(process.env.AI_TIMEOUT_MS, 45_000),
    maxRetries: int(process.env.AI_MAX_RETRIES, 2),
  },

  voice: {
    provider: process.env.VOICE_PROVIDER || 'native',
    openaiKey: process.env.OPENAI_API_KEY || '',
  },

  ocr: {
    provider: process.env.OCR_PROVIDER || 'tesseract',
    maxUploadBytes: int(process.env.OCR_MAX_UPLOAD_MB, 8) * 1024 * 1024,
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'SubTrack <no-reply@subtrack.app>',
  },

  scheduler: {
    enabled: bool(process.env.ENABLE_SCHEDULER, true) && !isTest,
    reminders: process.env.CRON_REMINDERS || '*/15 * * * *',
    nightlyInsights: process.env.CRON_NIGHTLY_INSIGHTS || '0 3 * * *',
  },

  /**
   * Shared secret for the HTTP cron-trigger endpoints (`/api/cron/*`),
   * used on serverless deploys where nothing keeps a `node-cron` process
   * alive — Vercel Cron Jobs calls these routes on a schedule instead, and
   * sends this value back as `Authorization: Bearer <secret>` so the route
   * can tell a real cron firing from an internet rando's guess at the URL.
   */
  cron: {
    secret: process.env.CRON_SECRET || '',
  },

  demo: {
    email: process.env.DEMO_EMAIL || 'demo@subtrack.app',
    password: process.env.DEMO_PASSWORD || 'DemoPass123!',
  },
});

/** True when Claude-backed features are live rather than heuristic. */
export const aiEnabled = () => Boolean(config.ai.apiKey);

/**
 * Fail fast on unsafe production configuration. Called from the entrypoint
 * rather than at import time so tests and CLI scripts stay importable.
 */
export function assertProductionConfig() {
  if (!config.isProd) return;
  const problems = [];
  if (config.auth.accessSecret === DEV_ACCESS_SECRET) {
    problems.push('JWT_ACCESS_SECRET must be set in production');
  }
  if (config.auth.refreshSecret === DEV_REFRESH_SECRET) {
    problems.push('JWT_REFRESH_SECRET must be set in production');
  }
  if (config.auth.accessSecret === config.auth.refreshSecret) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  }
  for (const [name, secret] of [
    ['JWT_ACCESS_SECRET', config.auth.accessSecret],
    ['JWT_REFRESH_SECRET', config.auth.refreshSecret],
  ]) {
    if (secret.length < 32) problems.push(`${name} must be at least 32 characters`);
  }
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL must be set in production');
  // Only meaningful on a serverless deploy (nothing else calls this route),
  // so an empty secret is a warning rather than a hard boot failure here.
  if (!config.cron.secret) {
    // eslint-disable-next-line no-console -- config boots before the logger exists
    console.warn(
      '[config] CRON_SECRET is not set. The /api/cron/* endpoints will reject ' +
        'every request until it is — fine if a long-running process handles ' +
        'scheduling instead (ENABLE_SCHEDULER=true), a problem on a ' +
        'serverless deploy where that is the only way jobs run.',
    );
  }
  if (problems.length) {
    throw new Error(`Refusing to start with unsafe configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

export default config;
