/**
 * Application menu.
 *
 * Follows the macOS conventions Electron does not give you for free: a
 * proper app menu named after the bundle, Edit/Window/Help in the expected
 * order, and standard shortcuts. Menu items that act on the app send a
 * named action to the renderer rather than manipulating it directly.
 */

import { app, Menu, shell, dialog } from 'electron';
import { config } from './config.js';

const send = (window, channel, payload) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

export function buildMenu({ getWindow, showWindow, onScanMail }) {
  const navigate = (route) => () => {
    showWindow();
    send(getWindow(), 'navigate', route);
  };

  const template = [
    ...(config.isMac
      ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'Cmd+,',
            click: navigate('/settings'),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),

    {
      label: 'File',
      submenu: [
        {
          label: 'New Subscription…',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            showWindow();
            send(getWindow(), 'action', 'new-subscription');
          },
        },
        {
          label: 'Scan Mail for Subscriptions…',
          accelerator: 'CmdOrCtrl+Shift+M',
          enabled: config.isMac,
          click: onScanMail,
        },
        { type: 'separator' },
        {
          label: 'Export Subscriptions (CSV)…',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            showWindow();
            send(getWindow(), 'action', 'export-csv');
          },
        },
        { type: 'separator' },
        config.isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(config.isMac
          ? [
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            // Gives the app system-wide dictation, on top of the in-app
            // speech recognition.
            { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
          ]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },

    {
      label: 'View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: navigate('/') },
        { label: 'Subscriptions', accelerator: 'CmdOrCtrl+2', click: navigate('/subscriptions') },
        { label: 'Calendar', accelerator: 'CmdOrCtrl+3', click: navigate('/calendar') },
        { label: 'AI Insights', accelerator: 'CmdOrCtrl+4', click: navigate('/insights') },
        { label: 'Assistant', accelerator: 'CmdOrCtrl+5', click: navigate('/assistant') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        // The inspector is genuinely useful for a user reporting a bug, so
        // it stays available in release builds too.
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(config.isMac
          ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
          : [{ role: 'close' }]),
      ],
    },

    {
      role: 'help',
      submenu: [
        {
          label: 'SubTrack on GitHub',
          click: () => shell.openExternal('https://github.com/yuvalhoenig/subscription-track'),
        },
        {
          label: 'Diagnostics…',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'SubTrack diagnostics',
              message: `SubTrack ${app.getVersion()}`,
              detail: [
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Node ${process.versions.node}`,
                `API ${config.apiUrl}`,
                `Platform ${process.platform} ${process.arch}`,
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export default buildMenu;
