/**
 * Minimal structured logger. JSON in production so log aggregators can
 * parse it; colourised single lines in development so humans can read it.
 */

import { config } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (config.isTest ? LEVELS.warn : LEVELS.info);

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

/** Values that must never reach a log line, however they are nested. */
const REDACT = new Set([
  'password', 'password_hash', 'passwordhash', 'token', 'token_hash', 'accesstoken',
  'refreshtoken', 'access_token', 'refresh_token', 'authorization', 'apikey',
  'api_key', 'secret', 'cookie',
]);

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const payload = meta ? redact(meta) : undefined;
  if (config.isProd) {
    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), message, ...payload })}\n`,
    );
    return;
  }
  const stamp = new Date().toISOString().slice(11, 23);
  const tail = payload ? ` ${JSON.stringify(payload)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${COLORS[level]}${stamp} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${tail}\n`);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
  /** Namespaced child logger: logger.child('ai').info(...) */
  child(namespace) {
    return {
      debug: (m, meta) => emit('debug', `[${namespace}] ${m}`, meta),
      info: (m, meta) => emit('info', `[${namespace}] ${m}`, meta),
      warn: (m, meta) => emit('warn', `[${namespace}] ${m}`, meta),
      error: (m, meta) => emit('error', `[${namespace}] ${m}`, meta),
    };
  },
};

export default logger;
