/**
 * API client.
 *
 * Three jobs beyond wrapping fetch:
 *
 *  1. **Transparent token refresh.** A 401 with `token_expired` triggers
 *     one refresh and a single retry. Concurrent 401s share the same
 *     refresh promise, so ten parallel requests produce one refresh call
 *     rather than ten — which matters because refresh tokens rotate, and
 *     ten simultaneous rotations would look like token replay and log the
 *     user out of everything.
 *  2. **Uniform errors.** Every failure becomes an `ApiError` carrying the
 *     server's code, message and per-field details, so forms can render
 *     validation errors without special-casing transport failures.
 *  3. **Token storage that suits both clients.** The browser keeps the
 *     refresh token in an httpOnly cookie; Electron hands us one from the
 *     OS keychain instead. Both paths go through `setTokens`.
 */

const RAW_BASE = import.meta.env?.VITE_API_URL ?? '';
/**
 * In development Vite proxies /api, so a relative base keeps everything
 * same-origin. A configured absolute URL wins (production, Electron).
 */
export const API_BASE = RAW_BASE ? `${RAW_BASE.replace(/\/$/, '')}/api` : '/api';

const ACCESS_KEY = 'subtrack.access';
const REFRESH_KEY = 'subtrack.refresh';

let accessToken = null;
let refreshToken = null;
let refreshPromise = null;
const listeners = new Set();

/** Called when the session ends unrecoverably, so the app can redirect. */
export function onAuthLost(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyAuthLost() {
  for (const listener of listeners) listener();
}

function readStorage(key) {
  try {
    return sessionStorage.getItem(key) ?? localStorage.getItem(key);
  } catch {
    // Private browsing, or storage blocked by policy.
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value == null) {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    /* Non-fatal: the session simply won't survive a reload. */
  }
}

export function setTokens({ accessToken: access, refreshToken: refresh } = {}) {
  if (access !== undefined) {
    accessToken = access;
    writeStorage(ACCESS_KEY, access);
  }
  if (refresh !== undefined) {
    refreshToken = refresh;
    writeStorage(REFRESH_KEY, refresh);
  }
  syncSessionToDesktop();
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  writeStorage(ACCESS_KEY, null);
  writeStorage(REFRESH_KEY, null);
  syncSessionToDesktop();
}

export function getAccessToken() {
  if (accessToken === null) accessToken = readStorage(ACCESS_KEY);
  return accessToken;
}

function getRefreshToken() {
  if (refreshToken === null) refreshToken = readStorage(REFRESH_KEY);
  return refreshToken;
}

export function hasSession() {
  return Boolean(getAccessToken() || getRefreshToken());
}

export class ApiError extends Error {
  constructor(message, { status, code, details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** True for a lost connection or an unreachable server. */
  get isNetworkError() {
    return this.code === 'network_error';
  }

  /** True when the desktop app accepted a write to replay later. */
  get isQueuedOffline() {
    return this.code === 'queued_offline';
  }

  get isValidationError() {
    return this.status === 400 && Boolean(this.details);
  }
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return response.text();
}

/** Exchange the refresh token for a new session. Deduplicated. */
async function refreshSession() {
  // Any caller arriving mid-refresh waits on the in-flight promise.
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Sends the httpOnly cookie in the browser; the body covers
        // Electron, where there is no cookie jar.
        credentials: 'include',
        body: JSON.stringify({ refreshToken: getRefreshToken() ?? undefined }),
      });
      if (!response.ok) return null;
      const session = await response.json();
      setTokens(session);
      return session;
    } catch {
      return null;
    } finally {
      // Cleared on the next tick so late arrivals still see this result.
      setTimeout(() => { refreshPromise = null; }, 0);
    }
  })();

  return refreshPromise;
}

/**
 * The Electron preload bridge, when running inside the desktop app.
 * Absent in a browser, so every use is guarded.
 */
const desktop = () => (typeof window !== 'undefined' ? window.subtrack : undefined);

export const isDesktop = () => Boolean(desktop()?.isDesktop);

/**
 * Mirror the session into the desktop store.
 *
 * The main process needs the tokens independently of any open window: the
 * menu bar item and the notification poller keep working after the window
 * is closed.
 */
function syncSessionToDesktop() {
  const bridge = desktop();
  if (!bridge?.session) return;
  const tokens = { accessToken, refreshToken };
  if (!tokens.accessToken && !tokens.refreshToken) bridge.session.clear().catch(() => {});
  else bridge.session.set(tokens).catch(() => {});
}

/**
 * Adopt a session the main process already holds.
 * Called once at startup so relaunching the desktop app does not require
 * signing in again.
 */
export async function adoptDesktopSession() {
  const bridge = desktop();
  if (!bridge?.session) return false;
  try {
    const tokens = await bridge.session.get();
    if (tokens?.accessToken || tokens?.refreshToken) {
      setTokens(tokens);
      return true;
    }
  } catch {
    /* bridge unavailable */
  }
  return false;
}

/** Replay anything queued while offline. Safe to call repeatedly. */
export async function flushOfflineQueue() {
  const bridge = desktop();
  if (!bridge?.offline) return { flushed: 0 };
  try {
    return await bridge.offline.flush();
  } catch {
    return { flushed: 0 };
  }
}

export async function pendingOfflineWrites() {
  const bridge = desktop();
  if (!bridge?.offline) return 0;
  try {
    return await bridge.offline.pending();
  } catch {
    return 0;
  }
}

/**
 * Issue an API request.
 *
 * @param {string} path      Path under /api, e.g. '/subscriptions'.
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {any}    [options.body]     JSON-serialised unless FormData.
 * @param {boolean}[options.auth]     Attach the access token (default true).
 * @param {boolean}[options.raw]      Return the raw Response.
 */
export async function request(path, { method = 'GET', body, auth = true, raw = false, signal, retry = true } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = {};
  if (body && !isFormData) headers['Content-Type'] = 'application/json';
  const token = auth ? getAccessToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      signal,
      // FormData must be passed through untouched so the browser sets the
      // multipart boundary.
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;

    /**
     * Offline. In the desktop app this is recoverable rather than fatal:
     *  - reads fall back to the on-disk cache, so the app stays readable;
     *  - writes are queued in order and replayed on reconnect.
     * In a browser there is nowhere to fall back to, so it stays an error.
     */
    const bridge = desktop();
    if (bridge?.offline) {
      if (method === 'GET') {
        const cached = await bridge.offline.readCache(path).catch(() => null);
        if (cached) {
          return { ...cached.value, __fromCache: true, __cachedAt: cached.at };
        }
      } else if (!isFormData) {
        // FormData (receipt uploads) cannot be serialised into the queue,
        // so those still fail rather than silently disappearing.
        const pending = await bridge.offline.enqueue({ path, method, body }).catch(() => 0);
        throw new ApiError(
          `Saved locally. ${pending} change${pending === 1 ? '' : 's'} will sync when you are back online.`,
          { code: 'queued_offline', status: 0, details: { pending } },
        );
      }
    }

    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      { code: 'network_error', status: 0 },
    );
  }

  if (response.status === 401 && auth && retry) {
    const payload = await parseResponse(response);
    const code = payload?.error?.code;
    // Only an expired token is worth refreshing. A revoked or reused one
    // means the session is genuinely over.
    if (code === 'token_expired' || code === 'unauthorized') {
      const session = await refreshSession();
      if (session) {
        return request(path, { method, body, auth, raw, signal, retry: false });
      }
    }
    clearTokens();
    notifyAuthLost();
    throw new ApiError(payload?.error?.message ?? 'Your session has ended. Please sign in again.', {
      status: 401,
      code: code ?? 'unauthorized',
      requestId: payload?.error?.requestId,
    });
  }

  if (raw) return response;

  const payload = await parseResponse(response);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
      details: error.details,
      requestId: error.requestId,
    });
  }

  // Keep the desktop cache warm on every successful read.
  if (method === 'GET') {
    desktop()?.offline?.writeCache(path, payload)?.catch?.(() => {});
  }

  return payload;
}

const get = (path, options) => request(path, { ...options, method: 'GET' });
const post = (path, body, options) => request(path, { ...options, method: 'POST', body });
const patch = (path, body, options) => request(path, { ...options, method: 'PATCH', body });
const del = (path, body, options) => request(path, { ...options, method: 'DELETE', body });

/** Serialise a query object, dropping empty values. */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const string = search.toString();
  return string ? `?${string}` : '';
}

export const api = {
  ApiError,

  auth: {
    register: (body) => post('/auth/register', body, { auth: false }),
    login: (body) => post('/auth/login', body, { auth: false }),
    logout: () => post('/auth/logout', { refreshToken: getRefreshToken() ?? undefined }, { auth: false }),
    logoutAll: () => post('/auth/logout-all'),
    sessions: () => get('/auth/sessions'),
    verifyEmail: (token) => post('/auth/verify-email', { token }, { auth: false }),
    resendVerification: () => post('/auth/resend-verification'),
    forgotPassword: (email) => post('/auth/forgot-password', { email }, { auth: false }),
    resetPassword: (body) => post('/auth/reset-password', body, { auth: false }),
    changePassword: (body) => post('/auth/change-password', body),
  },

  users: {
    me: () => get('/users/me'),
    update: (body) => patch('/users/me', body),
    remove: (password) => del('/users/me', { password }),
  },

  subscriptions: {
    list: (params) => get(`/subscriptions${qs(params)}`),
    get: (id) => get(`/subscriptions/${id}`),
    create: (body) => post('/subscriptions', body),
    update: (id, body) => patch(`/subscriptions/${id}`, body),
    cancel: (id) => post(`/subscriptions/${id}/cancel`),
    remove: (id) => del(`/subscriptions/${id}`),
    calendar: (days = 30) => get(`/subscriptions/calendar${qs({ days })}`),
    payments: (params) => get(`/subscriptions/payments${qs(params)}`),
    addPayment: (id, body) => post(`/subscriptions/${id}/payments`, body),
    recordUsage: (id, body = { source: 'web' }) => post(`/subscriptions/${id}/usage`, body),
  },

  categories: {
    list: () => get('/categories'),
    create: (body) => post('/categories', body),
    update: (id, body) => patch(`/categories/${id}`, body),
    remove: (id) => del(`/categories/${id}`),
    suggestions: () => get('/categories/suggestions'),
  },

  analytics: {
    overview: () => get('/analytics/overview'),
    categories: () => get('/analytics/categories'),
    timeline: (months = 12, includeCurrentMonth = true) =>
      get(`/analytics/timeline${qs({ months, includeCurrentMonth })}`),
    categoryTimeline: (months = 6) => get(`/analytics/timeline/categories${qs({ months })}`),
    projections: (months = 12) => get(`/analytics/projections${qs({ months })}`),
    forecast: (params) => get(`/analytics/forecast${qs(params)}`),
    categoryForecast: () => get('/analytics/forecast/categories'),
    trend: () => get('/analytics/trend'),
    optimize: () => get('/analytics/optimize'),
    anomalies: () => get('/analytics/anomalies'),
    usage: () => get('/analytics/usage'),
    value: () => get('/analytics/value'),
    recommendations: () => get('/analytics/recommendations'),
    benchmark: () => get('/analytics/benchmark'),
    rescore: () => post('/analytics/rescore'),
    /** Absolute URL for the CSV download link. */
    exportUrl: (type = 'subscriptions') =>
      `${API_BASE}/analytics/export${qs({ type, access_token: getAccessToken() })}`,
  },

  insights: {
    list: (params) => get(`/insights${qs(params)}`),
    generate: (narrate = true) => post('/insights/generate', { narrate }),
    dismiss: (id) => post(`/insights/${id}/dismiss`),
  },

  notifications: {
    list: (params) => get(`/notifications${qs(params)}`),
    markRead: (ids) => post('/notifications/read', ids ? { ids } : {}),
  },

  ai: {
    status: () => get('/ai/status'),
    chat: (message, sessionId) => post('/ai/chat', { message, sessionId }),
    chatSessions: () => get('/ai/chat/sessions'),
    chatHistory: (sessionId) => get(`/ai/chat/${sessionId}`),
    confirm: (action) => post('/ai/chat/confirm', { action }),
    extract: (text) => post('/ai/extract', { text }),
    categorise: (body) => post('/ai/categorise', body),
    receiptText: (text) => post('/ai/receipt/text', { text }),
    receiptImage: (file) => {
      const form = new FormData();
      form.append('receipt', file);
      return post('/ai/receipt/image', form);
    },
    scanEmails: (messages) => post('/ai/email/scan', { messages }),
    report: (period = 'month') => get(`/ai/report${qs({ period })}`),
    transcribe: (blob) => {
      const form = new FormData();
      form.append('audio', blob, 'recording.webm');
      return post('/ai/voice/transcribe', form);
    },
  },

  health: () => get('/health', { auth: false }),
};

export default api;
