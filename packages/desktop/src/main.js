/**
 * Electron main process.
 *
 * Responsibilities:
 *   - own the window and the macOS chrome (menu bar item, dock badge, app menu)
 *   - hold the session so the app stays signed in across launches
 *   - poll a lightweight summary for the tray and the dock badge, which is
 *     what lets the app be useful without a window open
 *   - surface renewals as native notifications
 *   - bridge the two macOS integrations (Mail.app, speech recognition)
 *   - replay mutations queued while offline
 */

import {
  app, BrowserWindow, Menu, ipcMain, Notification, shell, nativeTheme, dialog, powerMonitor,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { store } from './store.js';
import { cachedGet, flushQueue, request } from './api.js';
import { buildMenu } from './menu.js';
import { createTray, updateTray, destroyTray } from './tray.js';
import { speechAvailable, listen } from './speech.js';
import { mailAvailable, readSubscriptionMail } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let pollTimer = null;
let quitting = false;
/** Renewal notifications already shown, so a poll cannot repeat them. */
const notified = new Set();

// ── Single instance ────────────────────────────────────────────
// A second launch should focus the existing window, not start a second
// copy with its own tray icon and poller.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'SubTrack',
    // Blends the traffic lights into the app's own header on macOS.
    titleBarStyle: config.isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: config.isMac ? { x: 16, y: 18 } : undefined,
    // Matches the app's own background so the window doesn't flash white
    // before the renderer paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f6f7fb',
    vibrancy: config.isMac ? 'under-window' : undefined,
    webPreferences: {
      // .cjs because an Electron preload script must be CommonJS.
      preload: path.join(here, 'preload.cjs'),
      // The renderer runs untrusted-ish content (it renders AI output), so
      // it gets no Node integration and its own isolated context. All
      // native capability goes through the named preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require('electron')`
      webviewTag: false,
      spellcheck: true,
    },
  });

  // Avoid a visible unstyled flash: wait for the first paint.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (config.rendererUrl) {
    mainWindow.loadURL(config.rendererUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(config.rendererFile);
  }

  // External links open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-app navigation away from our own origin: a link in AI output
  // must not be able to replace the app with an arbitrary page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = config.rendererUrl
      ? url.startsWith(config.rendererUrl)
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // On macOS, closing the window hides the app (the tray keeps it alive)
  // rather than quitting, which is the platform convention.
  mainWindow.on('close', (event) => {
    if (!quitting && config.isMac) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (config.isMac) app.dock?.show();
}

const navigateTo = (route, action) => {
  showWindow();
  if (!mainWindow) return;
  mainWindow.webContents.send('navigate', route);
  if (action) {
    // Give the route a moment to mount before asking it to do something.
    setTimeout(() => mainWindow?.webContents.send('action', action), 400);
  }
};

// ── Tray / dock summary ────────────────────────────────────────

/**
 * Fetch the numbers the tray and dock badge need.
 * Falls back to the disk cache when offline, so the menu bar still shows
 * the last known figures rather than going blank.
 */
async function refreshSummary({ notify = true } = {}) {
  if (!store.getTokens().accessToken) {
    updateTray(null, trayHandlers);
    if (config.isMac) app.dock?.setBadge('');
    return null;
  }

  const [overview, calendar, optimise] = await Promise.all([
    cachedGet('/analytics/overview', { maxAgeMs: 24 * 60 * 60 * 1000 }),
    cachedGet('/subscriptions/calendar?days=14', { maxAgeMs: 24 * 60 * 60 * 1000 }),
    cachedGet('/analytics/optimize', { maxAgeMs: 24 * 60 * 60 * 1000 }),
  ]);

  if (!overview.ok) return null;

  const summary = {
    currency: overview.data.currency,
    monthly: overview.data.spend?.monthly,
    yearly: overview.data.spend?.yearly,
    activeCount: overview.data.counts?.active ?? 0,
    budget: overview.data.budget,
    savings: optimise.ok ? optimise.data.totalPotentialSavings?.monthly ?? 0 : 0,
    upcoming: calendar.ok ? calendar.data.events ?? [] : [],
    fromCache: overview.fromCache,
  };

  updateTray(summary, trayHandlers);

  // The dock badge counts what needs attention: renewals inside 3 days.
  if (config.isMac) {
    const urgent = summary.upcoming.filter((event) => event.daysUntil <= 3).length;
    app.dock?.setBadge(urgent > 0 ? String(urgent) : '');
  }

  if (notify) notifyUpcoming(summary);
  return summary;
}

/** Native notifications for imminent renewals and expiring trials. */
function notifyUpcoming(summary) {
  if (!Notification.isSupported()) return;

  for (const event of summary.upcoming) {
    // Only the next two days, and only once per subscription per date.
    if (event.daysUntil > 2) continue;
    const key = `${event.subscriptionId}:${event.date}`;
    if (notified.has(key)) continue;
    notified.add(key);

    const when = event.daysUntil === 0 ? 'today' : event.daysUntil === 1 ? 'tomorrow' : `in ${event.daysUntil} days`;
    const isTrial = event.status === 'trial';

    const notification = new Notification({
      title: isTrial ? `${event.name} trial ends ${when}` : `${event.name} renews ${when}`,
      body: isTrial
        ? `It starts charging ${summary.currency} ${event.cost}. Cancel before then if you don't want it.`
        : `${summary.currency} ${event.cost} on ${event.date}`,
      silent: false,
      // Trials converting is the case worth interrupting for.
      urgency: isTrial ? 'critical' : 'normal',
    });
    notification.on('click', () => navigateTo('/calendar'));
    notification.show();
  }
}

function startPolling() {
  stopPolling();
  refreshSummary();
  pollTimer = setInterval(() => refreshSummary(), config.pollIntervalMs);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── Mail scan ──────────────────────────────────────────────────

/**
 * Read Mail.app and hand the messages to the renderer, which posts them to
 * the parser and shows the candidates for the user to confirm. Nothing is
 * imported automatically.
 */
async function scanMail() {
  if (!mailAvailable()) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Not available',
      message: 'Mail integration is only available on macOS.',
    });
    return;
  }
  showWindow();
  mainWindow?.webContents.send('action', 'mail-scan-started');

  const { messages, error } = await readSubscriptionMail({ limit: 60, daysBack: 180 });

  if (error) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Could not read Mail',
      message: error,
      buttons: ['OK'],
    });
    mainWindow?.webContents.send('action', 'mail-scan-failed');
    return;
  }
  if (!messages.length) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Nothing found',
      message: 'No subscription confirmations were found in the last six months.',
    });
    mainWindow?.webContents.send('action', 'mail-scan-empty');
    return;
  }

  // The renderer owns the import UI; it posts these to /api/ai/email/scan.
  mainWindow?.webContents.send('action', { type: 'mail-scan-results', messages });
}

const trayHandlers = {
  showWindow,
  navigate: navigateTo,
  onRefresh: () => refreshSummary({ notify: false }),
  onScanMail: scanMail,
  onQuit: () => { quitting = true; app.quit(); },
};

// ── IPC ────────────────────────────────────────────────────────

// Synchronous handlers, so the preload can expose plain values.
ipcMain.on('app:version', (event) => { event.returnValue = app.getVersion(); });
ipcMain.on('mail:available', (event) => { event.returnValue = mailAvailable(); });
// Resolved lazily but cached: the preload needs a value immediately, and
// the honest answer before the first check is "only on macOS".
let speechReady = config.isMac;
ipcMain.on('speech:available', (event) => { event.returnValue = speechReady; });

ipcMain.handle('session:get', () => store.getTokens());
ipcMain.handle('session:set', (_event, tokens) => {
  store.setTokens(tokens);
  // A fresh sign-in should populate the tray straight away.
  startPolling();
  return true;
});
ipcMain.handle('session:clear', () => {
  store.clearTokens();
  store.clearCache();
  store.clearQueue();
  notified.clear();
  stopPolling();
  updateTray(null, trayHandlers);
  if (config.isMac) app.dock?.setBadge('');
  return true;
});

ipcMain.handle('offline:read', (_event, key) => store.readCache(key));
ipcMain.handle('offline:write', (_event, { key, value }) => {
  store.writeCache(key, value);
  return true;
});
ipcMain.handle('offline:enqueue', (_event, entry) => store.enqueue(entry));
ipcMain.handle('offline:pending', () => store.peekQueue().length);
ipcMain.handle('offline:flush', async () => {
  const result = await flushQueue();
  if (result.flushed) await refreshSummary({ notify: false });
  return result;
});

ipcMain.handle('speech:listen', async (_event, options) => listen(options ?? {}));
ipcMain.handle('mail:scan', async (_event, options) => readSubscriptionMail(options ?? {}));

ipcMain.handle('notify:show', (_event, { title, body, route } = {}) => {
  if (!Notification.isSupported() || !title) return false;
  const notification = new Notification({ title, body: body ?? '' });
  if (route) notification.on('click', () => navigateTo(route));
  notification.show();
  return true;
});

ipcMain.handle('notify:badge', (_event, count) => {
  if (!config.isMac) return false;
  app.dock?.setBadge(Number(count) > 0 ? String(count) : '');
  return true;
});

ipcMain.handle('tray:update', (_event, summary) => {
  updateTray(summary, trayHandlers);
  return true;
});

// ── Lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (config.isMac) app.setName('SubTrack');

  createWindow();
  createTray(trayHandlers);
  buildMenuNow();

  // Resolve native speech support in the background; the preload's cached
  // value is corrected before the renderer is likely to ask.
  speechReady = await speechAvailable();

  startPolling();

  // Coming back from sleep is the most common way to find a stale tray and
  // a queue waiting to be replayed.
  powerMonitor.on('resume', async () => {
    const result = await flushQueue();
    if (result.flushed) mainWindow?.webContents.send('offline:synced', result);
    refreshSummary();
  });

  // Repaint the window chrome when the OS theme flips.
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f6f7fb');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

function buildMenuNow() {
  Menu.setApplicationMenu(
    buildMenu({ getWindow: () => mainWindow, showWindow, onScanMail: scanMail }),
  );
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // On macOS the app lives on in the menu bar; elsewhere closing the last
  // window means quitting.
  if (!config.isMac) app.quit();
});

app.on('will-quit', () => {
  stopPolling();
  destroyTray();
});
