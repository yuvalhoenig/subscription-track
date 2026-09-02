/** Subscription list: filter, sort, edit, cancel, delete, export. */

import { useMemo, useState } from 'react';
import { formatCurrency, formatRelativeDays, CYCLE_LABELS } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import {
  Button, Input, Select, Empty, Loading, ErrorState, StatusBadge, Meter,
  ServiceMark, ConfirmDialog, Segmented,
} from '../components/ui.jsx';
import { SubscriptionForm } from '../components/SubscriptionForm.jsx';
import { api } from '../lib/api.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

export function SubscriptionsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const currency = user?.currency ?? 'USD';

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sort, setSort] = useState('renewal');
  const [order, setOrder] = useState('asc');
  const [view, setView] = useState('table');
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const debouncedSearch = useDebounced(search, 250);

  const categories = useAsync(() => api.categories.list(), []);
  const subscriptions = useAsync(
    () => api.subscriptions.list({
      search: debouncedSearch || undefined,
      status: status || undefined,
      categoryId: categoryId || undefined,
      sort,
      order,
      // "Cancelled" is only in the working set when explicitly asked for.
      includeCancelled: status === 'cancelled' ? true : undefined,
    }),
    [debouncedSearch, status, categoryId, sort, order],
  );

  const rows = subscriptions.data?.subscriptions ?? [];

  const totals = useMemo(() => {
    const active = rows.filter((row) => row.status === 'active');
    return {
      count: rows.length,
      monthly: active.reduce((sum, row) => sum + row.monthlyCost, 0),
      yearly: active.reduce((sum, row) => sum + row.yearlyCost, 0),
    };
  }, [rows]);

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setOrder(key === 'cost' ? 'desc' : 'asc');
    }
  };

  const runAction = async (action, label) => {
    setBusy(true);
    try {
      await action();
      toast.success(label);
      subscriptions.reload();
      setConfirming(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const markUsed = (row) =>
    runAction(() => api.subscriptions.recordUsage(row.id), `Logged a use of ${row.name}.`);

  const SortHeader = ({ label, sortKey, align }) => (
    <th
      className="sortable"
      onClick={() => toggleSort(sortKey)}
      style={align ? { textAlign: align } : undefined}
      aria-sort={sort === sortKey ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="row gap-1" style={{ display: 'inline-flex' }}>
        {label}
        {sort === sortKey ? (
          <Icon name={order === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />
        ) : null}
      </span>
    </th>
  );

  return (
    <AppShell
      title="Subscriptions"
      actions={(
        <>
          <a
            className="btn btn-secondary desktop-only"
            href={api.analytics.exportUrl('subscriptions')}
            download
          >
            <Icon name="download" size={15} />
            Export CSV
          </a>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => { setEditing(null); setShowForm(true); }}
          >
            <span className="desktop-only">Add</span>
          </Button>
        </>
      )}
    >
      <div className="stack gap-5">
        {/* ── Summary strip ── */}
        <div className="grid grid-stats">
          <div className="card stat">
            <div className="stat-label">Showing</div>
            <div className="stat-value">{totals.count}</div>
            <div className="stat-meta">subscription{totals.count === 1 ? '' : 's'}</div>
          </div>
          <div className="card stat">
            <div className="stat-label">Monthly (active)</div>
            <div className="stat-value">{formatCurrency(totals.monthly, currency)}</div>
            <div className="stat-meta">{formatCurrency(totals.yearly, currency)} a year</div>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="card">
          <div className="row gap-3 wrap">
            <div className="input-group grow" style={{ minWidth: 200 }}>
              <span className="input-prefix"><Icon name="search" size={15} /></span>
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name…"
                aria-label="Search subscriptions"
              />
            </div>

            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              placeholder="All statuses"
              aria-label="Filter by status"
              style={{ width: 'auto', minWidth: 140 }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'trial', label: 'Trial' },
                { value: 'paused', label: 'Paused' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />

            <Select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              placeholder="All categories"
              aria-label="Filter by category"
              style={{ width: 'auto', minWidth: 150 }}
              options={(categories.data?.categories ?? []).map((category) => ({
                value: category.id,
                label: category.name,
              }))}
            />

            <div className="desktop-only">
              <Segmented
                value={view}
                onChange={setView}
                options={[{ value: 'table', label: 'Table' }, { value: 'cards', label: 'Cards' }]}
              />
            </div>

            {(search || status || categoryId) ? (
              <Button
                variant="ghost"
                size="sm"
                icon="x"
                onClick={() => { setSearch(''); setStatus(''); setCategoryId(''); }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {/* ── Results ── */}
        {subscriptions.error ? (
          <ErrorState error={subscriptions.error} onRetry={subscriptions.reload} />
        ) : subscriptions.loading && !subscriptions.data ? (
          <Loading label="Loading your subscriptions…" />
        ) : rows.length === 0 ? (
          <div className="card">
            <Empty
              icon="layers"
              title={search || status || categoryId ? 'Nothing matches those filters' : 'No subscriptions yet'}
              message={
                search || status || categoryId
                  ? 'Try clearing the filters.'
                  : 'Add your first subscription, or describe it to the assistant in plain English.'
              }
              action={(
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => { setEditing(null); setShowForm(true); }}
                >
                  Add a subscription
                </Button>
              )}
            />
          </div>
        ) : view === 'cards' ? (
          <div className="grid grid-3 stagger">
            {rows.map((row) => (
              <div key={row.id} className="card card-hover">
                <div className="row gap-3" style={{ marginBottom: 'var(--space-4)' }}>
                  <ServiceMark name={row.name} color={row.category_color} />
                  <div className="grow truncate">
                    <div className="semibold truncate">{row.name}</div>
                    <div className="tiny muted">{row.category}</div>
                  </div>
                  <StatusBadge status={row.status} />
                </div>

                <div className="between" style={{ marginBottom: 'var(--space-3)' }}>
                  <div>
                    <div className="stat-value" style={{ fontSize: 'var(--text-xl)', marginTop: 0 }}>
                      {formatCurrency(row.cost, row.currency)}
                    </div>
                    <div className="tiny muted">{CYCLE_LABELS[row.billing_cycle]}</div>
                  </div>
                  <div className="right">
                    <div className="small nums">{formatCurrency(row.monthlyCost, currency)}</div>
                    <div className="tiny muted">per month</div>
                  </div>
                </div>

                <div className="between tiny" style={{ paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border)' }}>
                  <span className="muted">
                    {row.status === 'cancelled' ? 'Cancelled' : `Renews ${formatRelativeDays(row.nextRenewal)}`}
                  </span>
                  <span className="row gap-1">
                    <Button variant="ghost" size="sm" onClick={() => markUsed(row)} title="Log a use">
                      <Icon name="check" size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditing(row); setShowForm(true); }}
                      title="Edit"
                    >
                      <Icon name="edit" size={13} />
                    </Button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card card-flush">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <SortHeader label="Service" sortKey="name" />
                    <SortHeader label="Cost" sortKey="cost" align="right" />
                    <th className="desktop-only">Cycle</th>
                    <th className="desktop-only right">Monthly</th>
                    <SortHeader label="Renews" sortKey="renewal" />
                    <th>Status</th>
                    <th className="desktop-only">Value</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="service-cell">
                          <ServiceMark name={row.name} color={row.category_color} size={30} />
                          <div className="truncate">
                            <div className="semibold truncate">{row.name}</div>
                            <div className="tiny muted truncate">
                              {row.category}
                              {row.subcategory ? ` · ${row.subcategory}` : ''}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="right nums semibold">{formatCurrency(row.cost, row.currency)}</td>
                      <td className="desktop-only small muted">{CYCLE_LABELS[row.billing_cycle]}</td>
                      <td className="desktop-only right nums">{formatCurrency(row.monthlyCost, currency)}</td>
                      <td className="small">
                        {row.status === 'cancelled' ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <div>{formatRelativeDays(row.nextRenewal)}</div>
                            <div className="tiny muted mono">{row.nextRenewal}</div>
                          </>
                        )}
                      </td>
                      <td><StatusBadge status={row.status} /></td>
                      <td className="desktop-only" style={{ minWidth: 96 }}>
                        <Meter value={row.value_score != null ? Number(row.value_score) : null} label="Value" />
                      </td>
                      <td>
                        <div className="row gap-1" style={{ justifyContent: 'flex-end' }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => markUsed(row)}
                            title="Log a use — improves the value score"
                          >
                            <Icon name="check" size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setEditing(row); setShowForm(true); }}
                            title="Edit"
                          >
                            <Icon name="edit" size={14} />
                          </Button>
                          {row.status !== 'cancelled' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirming({ mode: 'cancel', row })}
                              title="Cancel"
                            >
                              <Icon name="pause" size={14} />
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirming({ mode: 'delete', row })}
                            title="Delete"
                            style={{ color: 'var(--danger)' }}
                          >
                            <Icon name="trash" size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <SubscriptionForm
        open={showForm}
        onClose={() => { setShowForm(false); setEditing(null); }}
        onSaved={subscriptions.reload}
        subscription={editing}
        categories={categories.data?.categories ?? []}
      />

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        loading={busy}
        danger={confirming?.mode === 'delete'}
        title={confirming?.mode === 'delete' ? 'Delete this subscription?' : 'Cancel this subscription?'}
        confirmLabel={confirming?.mode === 'delete' ? 'Delete permanently' : 'Mark as cancelled'}
        message={
          confirming?.mode === 'delete'
            ? `${confirming?.row.name} and its payment history will be removed for good. To keep the history and just stop counting the spend, cancel it instead.`
            : `${confirming?.row.name} will stop counting towards your spend, but its payment history is kept.`
        }
        onConfirm={() => {
          const { mode, row } = confirming;
          return mode === 'delete'
            ? runAction(() => api.subscriptions.remove(row.id), `${row.name} deleted.`)
            : runAction(() => api.subscriptions.cancel(row.id), `${row.name} cancelled.`);
        }}
      />
    </AppShell>
  );
}

export default SubscriptionsPage;
