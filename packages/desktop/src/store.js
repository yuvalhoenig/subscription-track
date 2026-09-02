/**
 * On-disk store for the desktop app.
 *
 * Holds three things:
 *   - the session tokens, so the app stays signed in across restarts;
 *   - a cache of the last successful GET responses, which is what makes
 *     the app readable offline;
 *   - a queue of mutations made while offline, replayed on reconnect.
 *
 * Writes are atomic (temp file + rename) because the alternative — a
 * truncated JSON file after a crash or a forced quit — would silently sign
 * the user out and lose their queued changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const FILE = () => path.join(app.getPath('userData'), 'subtrack-store.json');

const EMPTY = { tokens: {}, cache: {}, queue: [], meta: {} };

let state = null;

function load() {
  if (state) return state;
  try {
    state = { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch {
    // Missing or corrupt: start clean rather than crashing on boot.
    state = { ...EMPTY };
  }
  return state;
}

function persist() {
  const target = FILE();
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
    // rename is atomic on the same filesystem, so a reader never sees a
    // half-written file.
    fs.renameSync(temp, target);
  } catch (error) {
    process.stderr.write(`[store] write failed: ${error.message}\n`);
  }
}

export const store = {
  getTokens() {
    return load().tokens ?? {};
  },

  setTokens(tokens) {
    load().tokens = tokens ?? {};
    persist();
  },

  clearTokens() {
    load().tokens = {};
    persist();
  },

  /** Cached response for a GET path, with the time it was stored. */
  readCache(key) {
    return load().cache[key] ?? null;
  },

  writeCache(key, value) {
    const current = load();
    current.cache[key] = { value, at: Date.now() };
    // Keep the cache bounded: 200 entries is far more than the app reads.
    const keys = Object.keys(current.cache);
    if (keys.length > 200) {
      const oldest = keys.sort(
        (a, b) => (current.cache[a].at ?? 0) - (current.cache[b].at ?? 0),
      )[0];
      delete current.cache[oldest];
    }
    persist();
  },

  clearCache() {
    load().cache = {};
    persist();
  },

  /** Queue a mutation made while offline. */
  enqueue(entry) {
    const current = load();
    current.queue.push({ ...entry, id: `${Date.now()}-${current.queue.length}`, queuedAt: Date.now() });
    persist();
    return current.queue.length;
  },

  peekQueue() {
    return [...load().queue];
  },

  dequeue(id) {
    const current = load();
    current.queue = current.queue.filter((entry) => entry.id !== id);
    persist();
  },

  clearQueue() {
    load().queue = [];
    persist();
  },

  getMeta(key) {
    return load().meta[key];
  },

  setMeta(key, value) {
    load().meta[key] = value;
    persist();
  },
};

export default store;
