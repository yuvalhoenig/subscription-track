/**
 * Preload bridge.
 *
 * Exposes a deliberately narrow, named surface on `window.subtrack` via
 * contextBridge. The renderer never gets `require`, `ipcRenderer`, or any
 * ability to name an arbitrary IPC channel — each capability below is an
 * explicit function backed by a specific handler in the main process. That
 * keeps a compromised renderer (or a prompt injection that reaches the
 * page) from reaching the filesystem or shell.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtrack', {
  /** Marks the desktop build so the web app can light up native features. */
  isDesktop: true,
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version'),

  /** Session tokens are kept by the main process so they survive restarts. */
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    set: (tokens) => ipcRenderer.invoke('session:set', tokens),
    clear: () => ipcRenderer.invoke('session:clear'),
  },

  /** Offline cache and the replay queue. */
  offline: {
    readCache: (key) => ipcRenderer.invoke('offline:read', key),
    writeCache: (key, value) => ipcRenderer.invoke('offline:write', { key, value }),
    enqueue: (entry) => ipcRenderer.invoke('offline:enqueue', entry),
    pending: () => ipcRenderer.invoke('offline:pending'),
    flush: () => ipcRenderer.invoke('offline:flush'),
    /** Fires when connectivity returns and the queue has been replayed. */
    onSynced: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('offline:synced', listener);
      return () => ipcRenderer.removeListener('offline:synced', listener);
    },
  },

  /** Native macOS speech recognition, with a Web Speech API fallback. */
  speech: {
    // Resolved at preload so the renderer can branch synchronously.
    available: ipcRenderer.sendSync('speech:available'),
    listen: (options) => ipcRenderer.invoke('speech:listen', options),
  },

  /** Mail.app reading (macOS, behind the OS Automation consent prompt). */
  mail: {
    available: ipcRenderer.sendSync('mail:available'),
    scan: (options) => ipcRenderer.invoke('mail:scan', options),
  },

  /** Native notifications and the dock badge. */
  notifications: {
    show: (options) => ipcRenderer.invoke('notify:show', options),
    setBadge: (count) => ipcRenderer.invoke('notify:badge', count),
  },

  /** Let the main process keep the tray menu in step with the app. */
  updateTray: (summary) => ipcRenderer.invoke('tray:update', summary),

  /** Navigation requests from the tray or the app menu. */
  onNavigate: (callback) => {
    const listener = (_event, route) => callback(route);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },

  /** Menu actions (New Subscription, Scan Mail, …). */
  onAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('action', listener);
    return () => ipcRenderer.removeListener('action', listener);
  },
});
