/**
 * Menu bar item.
 *
 * Shows monthly spend and the next few renewals without opening the app —
 * the main reason to have a desktop build at all. Uses a template image so
 * macOS tints it correctly in both light and dark menu bars.
 */

import { Tray, Menu, nativeImage } from 'electron';
import { config } from './config.js';

let tray = null;
let latest = null;

/**
 * The menu bar icon, drawn as a template image.
 *
 * A "$" glyph at 16pt, black-on-transparent. macOS inverts template
 * images automatically for dark menu bars, which is why this is not a
 * coloured icon.
 */
function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <path d="M8 1.4v13.2M11 4.2H6.8a2.1 2.1 0 000 4.2h2.6a2.1 2.1 0 010 4.2H4.6"
      stroke="black" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
  image.setTemplateImage(true);
  return image;
}

const money = (value, currency = 'USD') => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)}`;
  }
};

function buildTrayMenu({ showWindow, navigate, onRefresh, onScanMail, onQuit }) {
  const summary = latest;

  const items = [];

  if (!summary) {
    items.push({ label: 'Not signed in', enabled: false });
  } else {
    items.push(
      { label: `${money(summary.monthly, summary.currency)} per month`, enabled: false },
      { label: `${money(summary.yearly, summary.currency)} per year`, enabled: false },
      {
        label: `${summary.activeCount} active subscription${summary.activeCount === 1 ? '' : 's'}`,
        enabled: false,
      },
    );

    if (summary.budget) {
      items.push({
        label: summary.budget.overBudget
          ? `⚠︎ ${money(Math.abs(summary.budget.remaining), summary.currency)} over budget`
          : `${money(summary.budget.remaining, summary.currency)} left this month`,
        enabled: false,
      });
    }

    if (summary.upcoming?.length) {
      items.push({ type: 'separator' }, { label: 'Coming up', enabled: false });
      for (const event of summary.upcoming.slice(0, 5)) {
        const when = event.daysUntil === 0
          ? 'today'
          : event.daysUntil === 1 ? 'tomorrow' : `in ${event.daysUntil}d`;
        items.push({
          label: `${event.name} · ${money(event.cost, summary.currency)} ${when}`,
          click: () => navigate('/calendar'),
        });
      }
    }

    if (summary.savings > 0) {
      items.push(
        { type: 'separator' },
        {
          label: `Save up to ${money(summary.savings, summary.currency)}/mo`,
          click: () => navigate('/insights'),
        },
      );
    }
  }

  items.push(
    { type: 'separator' },
    { label: 'Open SubTrack', accelerator: 'Cmd+O', click: showWindow },
    { label: 'Add Subscription…', click: () => navigate('/subscriptions', 'new-subscription') },
    { label: 'Ask the Assistant…', click: () => navigate('/assistant') },
  );

  if (config.isMac) {
    items.push({ label: 'Scan Mail for Subscriptions…', click: onScanMail });
  }

  items.push(
    { type: 'separator' },
    { label: 'Refresh now', click: onRefresh },
    { label: 'Quit SubTrack', accelerator: 'Cmd+Q', click: onQuit },
  );

  return Menu.buildFromTemplate(items);
}

export function createTray(handlers) {
  if (tray) return tray;
  tray = new Tray(trayIcon());
  tray.setToolTip('SubTrack');
  tray.setContextMenu(buildTrayMenu(handlers));
  // Clicking the icon opens the app; the menu is on right-click, matching
  // how most macOS menu bar apps with a primary action behave.
  tray.on('click', () => handlers.showWindow());
  return tray;
}

/** Refresh the tray's title and menu from a new summary. */
export function updateTray(summary, handlers) {
  latest = summary;
  if (!tray) return;

  // A compact monthly figure beside the icon; the full picture is in the
  // menu. Only shown when there is something to show.
  tray.setTitle(summary?.monthly != null ? ` ${money(summary.monthly, summary.currency)}` : '');
  tray.setToolTip(
    summary
      ? `SubTrack — ${money(summary.monthly, summary.currency)}/month across ${summary.activeCount} subscriptions`
      : 'SubTrack',
  );
  tray.setContextMenu(buildTrayMenu(handlers));
}

export function destroyTray() {
  tray?.destroy();
  tray = null;
}

export default { createTray, updateTray, destroyTray };
