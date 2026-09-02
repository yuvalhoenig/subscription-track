/** Desktop configuration, resolved from the environment with defaults. */

import path from 'node:path';
import { app } from 'electron';

const isDev = process.argv.includes('--dev') || !app.isPackaged;

export const config = {
  isDev,
  isMac: process.platform === 'darwin',
  /** Where the API lives. Overridable so a build can point at production. */
  apiUrl: process.env.SUBTRACK_API_URL || 'http://localhost:4000',
  /**
   * In development the renderer is served by Vite (hot reload). In a
   * packaged build it is the static bundle inside the app.
   */
  rendererUrl: isDev
    ? process.env.SUBTRACK_WEB_URL || 'http://localhost:5173'
    : null,
  rendererFile: path.join(app.getAppPath(), 'renderer', 'index.html'),
  /** How often the tray refreshes its snapshot of upcoming renewals. */
  pollIntervalMs: 15 * 60 * 1000,
};

export default config;
