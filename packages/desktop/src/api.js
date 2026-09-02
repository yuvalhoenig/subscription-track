/**
 * Minimal API client for the main process.
 *
 * The renderer has its own (richer) client; this one exists because the
 * tray, the dock badge and the notification scheduler need data while no
 * window is necessarily open. It shares the session tokens the renderer
 * stored, and refreshes them the same way.
 */

import { store } from './store.js';
import { config } from './config.js';

let refreshing = null;

async function refresh() {
  // One refresh at a time: refresh tokens rotate, and two simultaneous
  // rotations would look like replay and revoke every session.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { refreshToken } = store.getTokens();
    if (!refreshToken) return null;
    try {
      const response = await fetch(`${config.apiUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return null;
      const session = await response.json();
      store.setTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken });
      return session;
    } catch {
      return null;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

/**
 * Issue an authenticated request, refreshing once on a 401.
 * @returns {Promise<{ok: boolean, status: number, data: any, offline?: boolean}>}
 */
export async function request(path, { method = 'GET', body, retry = true } = {}) {
  const { accessToken } = store.getTokens();

  let response;
  try {
    response = await fetch(`${config.apiUrl}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // No connection: the caller decides whether to fall back to cache.
    return { ok: false, status: 0, offline: true, data: { error: { message: error.message } } };
  }

  if (response.status === 401 && retry) {
    const session = await refresh();
    if (session) return request(path, { method, body, retry: false });
    store.clearTokens();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

/** GET with a disk-cache fallback, which is what makes the app readable offline. */
export async function cachedGet(path, { maxAgeMs } = {}) {
  const result = await request(path);
  if (result.ok) {
    store.writeCache(path, result.data);
    return { ...result, fromCache: false };
  }
  const cached = store.readCache(path);
  if (cached && (!maxAgeMs || Date.now() - cached.at < maxAgeMs)) {
    return { ok: true, status: 200, data: cached.value, fromCache: true, cachedAt: cached.at };
  }
  return { ...result, fromCache: false };
}

/**
 * Replay mutations queued while offline, oldest first.
 * Stops at the first network failure so ordering is preserved; a request
 * the server rejects outright (4xx) is dropped, because retrying it
 * forever would block the queue.
 */
export async function flushQueue() {
  const queue = store.peekQueue();
  if (!queue.length) return { flushed: 0, remaining: 0, failed: 0 };

  let flushed = 0;
  let failed = 0;

  for (const entry of queue) {
    const result = await request(entry.path, { method: entry.method, body: entry.body });
    if (result.ok) {
      store.dequeue(entry.id);
      flushed += 1;
      continue;
    }
    if (result.offline) break; // still offline; keep the rest for later
    if (result.status >= 400 && result.status < 500) {
      // The server will never accept this; drop it rather than blocking.
      store.dequeue(entry.id);
      failed += 1;
      continue;
    }
    break; // server error: try again next time
  }

  return { flushed, failed, remaining: store.peekQueue().length };
}

export default { request, cachedGet, flushQueue };
