/**
 * Glue between the Electron main process and the React app.
 *
 * Renders nothing. Mounted once inside the router so it can navigate, and
 * inside the toast provider so it can report what happened.
 *
 * Everything here is inert in a browser: `window.subtrack` only exists in
 * the desktop build, so each effect returns early.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, flushOfflineQueue, pendingOfflineWrites, isDesktop } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { useAuth } from '../lib/auth.jsx';

export function DesktopBridge() {
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthenticated } = useAuth();
  const [pending, setPending] = useState(0);
  // Avoids two flushes racing (e.g. an `online` event and a wake at once).
  const flushing = useRef(false);

  // ── Navigation from the app menu and the tray ──
  useEffect(() => {
    const bridge = window.subtrack;
    if (!bridge?.onNavigate) return undefined;
    return bridge.onNavigate((route) => {
      if (typeof route === 'string') navigate(route);
    });
  }, [navigate]);

  // ── Menu / tray actions ──
  useEffect(() => {
    const bridge = window.subtrack;
    if (!bridge?.onAction) return undefined;

    return bridge.onAction(async (action) => {
      // Simple actions arrive as a string, richer ones as an object.
      const name = typeof action === 'string' ? action : action?.type;

      switch (name) {
        case 'new-subscription':
          navigate('/subscriptions');
          // The page listens for this to open its form.
          window.dispatchEvent(new CustomEvent('subtrack:new-subscription'));
          break;

        case 'export-csv':
          // Let the main process' download handling take over.
          window.location.href = api.analytics.exportUrl('subscriptions');
          break;

        case 'mail-scan-started':
          toast.info('Reading recent mail…');
          break;

        case 'mail-scan-failed':
          break; // the main process already showed a dialog

        case 'mail-scan-empty':
          toast.info('No subscription confirmations found.');
          break;

        case 'mail-scan-results': {
          // The main process read the messages; parsing and the import UI
          // belong to the server and the assistant page respectively.
          try {
            const result = await api.ai.scanEmails(action.messages.slice(0, 100));
            navigate('/assistant');
            window.dispatchEvent(
              new CustomEvent('subtrack:mail-candidates', { detail: result }),
            );
            toast.success(
              result.newCandidates > 0
                ? `Found ${result.newCandidates} subscription${result.newCandidates === 1 ? '' : 's'} you are not tracking yet.`
                : `Scanned ${result.scanned} messages — everything found is already tracked.`,
            );
          } catch (error) {
            toast.error(error.message);
          }
          break;
        }

        default:
          break;
      }
    });
  }, [navigate, toast]);

  // ── Offline queue ──
  const flush = useCallback(async () => {
    if (flushing.current || !isDesktop()) return;
    flushing.current = true;
    try {
      const before = await pendingOfflineWrites();
      if (!before) {
        setPending(0);
        return;
      }
      const result = await flushOfflineQueue();
      setPending(result.remaining ?? 0);
      if (result.flushed > 0) {
        toast.success(`Synced ${result.flushed} change${result.flushed === 1 ? '' : 's'} made offline.`);
        window.dispatchEvent(new CustomEvent('subtrack:data-changed'));
      }
      if (result.failed > 0) {
        toast.warning(
          `${result.failed} offline change${result.failed === 1 ? '' : 's'} could not be applied and were discarded.`,
        );
      }
    } finally {
      flushing.current = false;
    }
  }, [toast]);

  // Flush when the browser reports connectivity, and when the main process
  // says it already replayed the queue after a wake from sleep.
  useEffect(() => {
    if (!isDesktop()) return undefined;

    const onOnline = () => flush();
    window.addEventListener('online', onOnline);

    const unsubscribe = window.subtrack?.offline?.onSynced?.((result) => {
      setPending(result?.remaining ?? 0);
      if (result?.flushed > 0) {
        toast.success(`Synced ${result.flushed} change${result.flushed === 1 ? '' : 's'} made offline.`);
        window.dispatchEvent(new CustomEvent('subtrack:data-changed'));
      }
    });

    // Also check once on mount, in case the app starts up already online
    // with a queue left from last session.
    flush();

    return () => {
      window.removeEventListener('online', onOnline);
      unsubscribe?.();
    };
  }, [flush, toast]);

  // ── Keep the tray and dock badge in step with what the app knows ──
  useEffect(() => {
    if (!isDesktop() || !isAuthenticated) return undefined;

    let cancelled = false;
    const push = async () => {
      try {
        const [overview, calendar, optimise] = await Promise.all([
          api.analytics.overview(),
          api.subscriptions.calendar(14),
          api.analytics.optimize(),
        ]);
        if (cancelled) return;
        await window.subtrack.updateTray({
          currency: overview.currency,
          monthly: overview.spend?.monthly,
          yearly: overview.spend?.yearly,
          activeCount: overview.counts?.active ?? 0,
          budget: overview.budget,
          savings: optimise.totalPotentialSavings?.monthly ?? 0,
          upcoming: calendar.events ?? [],
        });
        const urgent = (calendar.events ?? []).filter((event) => event.daysUntil <= 3).length;
        await window.subtrack.notifications.setBadge(urgent);
      } catch {
        // The main process polls independently; a failure here is cosmetic.
      }
    };

    push();
    // Re-push whenever the app changes data, so the menu bar is never stale.
    const onChange = () => push();
    window.addEventListener('subtrack:data-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('subtrack:data-changed', onChange);
    };
  }, [isAuthenticated]);

  // A small persistent indicator while writes are waiting to sync.
  if (!pending) return null;
  return (
    <div
      className="badge badge-warning"
      style={{
        position: 'fixed', bottom: 'var(--space-6)', left: 'var(--space-6)', zIndex: 80,
        boxShadow: 'var(--shadow-md)',
      }}
      role="status"
    >
      {pending} change{pending === 1 ? '' : 's'} waiting to sync
    </div>
  );
}

export default DesktopBridge;
