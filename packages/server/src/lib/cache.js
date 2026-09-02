/**
 * Cache + counter abstraction backed by Redis, degrading to an in-process
 * store when Redis is absent or unreachable.
 *
 * Redis is an accelerator here, never a source of truth: it holds cached
 * Claude responses, AI rate-limit counters and computed analytics. Losing
 * it makes the app slower and rate limits per-process, but never wrong —
 * so a connection failure logs a warning and carries on rather than
 * failing requests.
 */

import { config } from '../config/index.js';
import { logger } from './logger.js';

const log = logger.child('cache');

/** Bounded TTL map. The cap stops a busy process from growing without end. */
class MemoryStore {
  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  #evictIfNeeded() {
    if (this.entries.size <= this.maxEntries) return;
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = this.entries.keys().next().value;
    this.entries.delete(oldest);
  }

  #live(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  get(key) {
    return this.#live(key)?.value ?? null;
  }

  set(key, value, ttlSeconds) {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    this.#evictIfNeeded();
  }

  del(key) {
    this.entries.delete(key);
  }

  /** Increment a counter, seeding its TTL on first write. */
  incr(key, ttlSeconds) {
    const entry = this.#live(key);
    const next = (Number(entry?.value) || 0) + 1;
    this.entries.set(key, {
      value: next,
      // Preserve the original window so the limit is a fixed window, not a
      // sliding one that never expires under sustained traffic.
      expiresAt: entry?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null),
    });
    this.#evictIfNeeded();
    return next;
  }

  ttl(key) {
    const entry = this.#live(key);
    if (!entry?.expiresAt) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  clear() {
    this.entries.clear();
  }
}

const memory = new MemoryStore();
let redis = null;
let redisReady = false;

/**
 * Connect to Redis lazily and without blocking boot. If it never connects
 * we simply keep using the memory store.
 */
async function initRedis() {
  if (!config.redis.enabled) {
    log.info('Redis disabled; using in-process cache');
    return;
  }
  try {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(config.redis.url, {
      lazyConnect: true,
      // Don't retry forever on a host that isn't there; fall back instead.
      maxRetriesPerRequest: 2,
      retryStrategy: (attempt) => (attempt > 5 ? null : Math.min(attempt * 200, 2000)),
      enableOfflineQueue: false,
    });
    redis.on('ready', () => {
      redisReady = true;
      log.info('Redis connected');
    });
    redis.on('error', (error) => {
      if (redisReady) log.warn('Redis error; falling back to memory', { error: error.message });
      redisReady = false;
    });
    redis.on('end', () => {
      redisReady = false;
    });
    await redis.connect();
  } catch (error) {
    log.warn('Redis unavailable; using in-process cache', { error: error.message });
    redis = null;
    redisReady = false;
  }
}

const ready = initRedis();

/** Await the initial Redis connection attempt (used by boot and tests). */
export const cacheReady = () => ready;

const usable = () => redisReady && redis;

export const cache = {
  /** Deserialised value, or null on a miss. */
  async get(key) {
    if (usable()) {
      try {
        const raw = await redis.get(key);
        return raw == null ? null : JSON.parse(raw);
      } catch (error) {
        log.warn('Redis GET failed', { error: error.message });
      }
    }
    return memory.get(key);
  },

  async set(key, value, ttlSeconds = 300) {
    if (usable()) {
      try {
        const raw = JSON.stringify(value);
        if (ttlSeconds > 0) await redis.set(key, raw, 'EX', ttlSeconds);
        else await redis.set(key, raw);
        return;
      } catch (error) {
        log.warn('Redis SET failed', { error: error.message });
      }
    }
    memory.set(key, value, ttlSeconds);
  },

  async del(key) {
    if (usable()) {
      try {
        await redis.del(key);
      } catch (error) {
        log.warn('Redis DEL failed', { error: error.message });
      }
    }
    memory.del(key);
  },

  /** Delete every key matching a glob pattern (e.g. `analytics:<user>:*`). */
  async delPattern(pattern) {
    if (usable()) {
      try {
        // SCAN rather than KEYS: KEYS blocks the Redis event loop.
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
          cursor = next;
          if (keys.length) await redis.del(...keys);
        } while (cursor !== '0');
      } catch (error) {
        log.warn('Redis SCAN failed', { error: error.message });
      }
    }
    const prefix = pattern.replace(/\*$/, '');
    for (const key of [...memory.entries.keys()]) {
      if (key.startsWith(prefix)) memory.del(key);
    }
  },

  /** Increment a fixed-window counter and return its new value. */
  async incr(key, ttlSeconds) {
    if (usable()) {
      try {
        const value = await redis.incr(key);
        // Only set the expiry on the first increment so the window is fixed.
        if (value === 1 && ttlSeconds) await redis.expire(key, ttlSeconds);
        return value;
      } catch (error) {
        log.warn('Redis INCR failed', { error: error.message });
      }
    }
    return memory.incr(key, ttlSeconds);
  },

  /** Seconds until `key` expires, or -1 when it has no expiry. */
  async ttl(key) {
    if (usable()) {
      try {
        return await redis.ttl(key);
      } catch (error) {
        log.warn('Redis TTL failed', { error: error.message });
      }
    }
    return memory.ttl(key);
  },

  /**
   * Read-through cache. Runs `producer` only on a miss.
   * A producer that throws is not cached, so transient failures don't get
   * pinned for the whole TTL.
   */
  async wrap(key, ttlSeconds, producer) {
    const hit = await this.get(key);
    if (hit !== null) return hit;
    const value = await producer();
    if (value !== undefined && value !== null) await this.set(key, value, ttlSeconds);
    return value;
  },

  get backend() {
    return usable() ? 'redis' : 'memory';
  },

  async close() {
    memory.clear();
    if (redis) {
      await redis.quit().catch(() => redis.disconnect());
      redis = null;
      redisReady = false;
    }
  },
};

export default cache;
