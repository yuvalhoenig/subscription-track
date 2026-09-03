/**
 * Admin panel.
 *
 * Three tabs: platform-wide stats, a searchable/paginated user list with
 * a detail drawer for troubleshooting a specific account, and the audit
 * log every admin action writes to.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCurrency, formatDate } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import {
  Button, Input, Badge, Empty, Loading, ErrorState, Segmented,
  ConfirmDialog, Modal, Switch, Field, Alert,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

function StatBlock({ label, value, meta }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 'var(--text-2xl)' }}>{value}</div>
      {meta ? <div className="stat-meta">{meta}</div> : null}
    </div>
  );
}

function OverviewTab() {
  const stats = useAsync(() => api.admin.stats(), []);

  if (stats.loading && !stats.data) return <Loading label="Loading platform stats…" />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const d = stats.data;

  return (
    <div className="stack gap-5">
      <div className="grid grid-stats">
        <StatBlock label="Total users" value={d.users.total} meta={`${d.users.verified} verified · ${d.users.admins} admin${d.users.admins === 1 ? '' : 's'}`} />
        <StatBlock label="New signups" value={d.users.newLast7Days} meta={`${d.users.newLast30Days} in the last 30 days`} />
        <StatBlock label="Active subscriptions" value={d.subscriptions.active} meta={`${d.subscriptions.total} tracked total, ${d.subscriptions.usersWithSubscriptions} users`} />
        <StatBlock label="Tracked monthly spend" value={formatCurrency(d.subscriptions.totalMonthlyTracked, 'USD')} meta={`${formatCurrency(d.subscriptions.totalYearlyTracked, 'USD')} a year, across every user`} />
      </div>
      <div className="grid grid-stats">
        <StatBlock label="AI insights generated" value={d.content.totalInsights} />
        <StatBlock label="Chat messages exchanged" value={d.content.totalChatMessages} />
        <StatBlock label="Payments recorded" value={d.content.totalPayments} />
        <StatBlock
          label="AI mode"
          value={d.ai.mode === 'claude' ? 'Claude' : 'Heuristic'}
          meta={d.ai.mode === 'claude' ? d.ai.models?.smart : 'No ANTHROPIC_API_KEY set'}
        />
      </div>
    </div>
  );
}

function UserDetailModal({ userId, onClose, onChanged }) {
  const { user: me, impersonate } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useAsync(() => api.admin.userDetail(userId), [userId]);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const logInAsUser = async () => {
    setBusy(true);
    try {
      await impersonate(userId);
      onClose();
      navigate('/');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action, label) => {
    setBusy(true);
    try {
      await action();
      toast.success(label);
      onChanged();
      if (confirming?.mode === 'delete') onClose();
      else detail.reload();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="User detail" size="lg">
      {detail.loading && !detail.data ? (
        <Loading label="Loading…" />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : detail.data ? (
        <div className="stack gap-5">
          <div className="row gap-3 wrap">
            <div className="grow">
              <div className="row gap-2">
                <strong>{detail.data.user.name}</strong>
                {detail.data.user.is_admin ? <Badge tone="brand">Admin</Badge> : null}
                {detail.data.user.email_verified ? (
                  <Badge tone="success" icon="check-circle">Verified</Badge>
                ) : (
                  <Badge tone="warning">Unverified</Badge>
                )}
              </div>
              <div className="small muted">{detail.data.user.email}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>
                Joined {formatDate(detail.data.user.created_at)}
                {detail.data.user.last_login_at ? ` · last seen ${formatDate(detail.data.user.last_login_at)}` : ' · never signed in'}
              </div>
            </div>
            <div className="right">
              <div className="stat-value" style={{ fontSize: 'var(--text-xl)', marginTop: 0 }}>
                {formatCurrency(detail.data.monthlySpend, detail.data.user.currency)}/mo
              </div>
              <div className="tiny muted">{detail.data.activeCount} active subscriptions</div>
            </div>
          </div>

          <div className="row gap-2 wrap">
            <Switch
              checked={detail.data.user.is_admin}
              onChange={(value) => act(
                () => api.admin.setAdmin(userId, value),
                value ? 'Granted admin access.' : 'Revoked admin access.',
              )}
              label="Admin access"
            />
            <span className="small secondary">Admin access</span>
            <div className="grow" />
            {userId !== me?.id && !detail.data.user.is_admin ? (
              <Button
                size="sm"
                variant="soft"
                icon="eye"
                onClick={logInAsUser}
                disabled={busy}
              >
                Log in as user
              </Button>
            ) : null}
            <Button
              size="sm"
              icon="logout"
              onClick={() => act(() => api.admin.forceLogout(userId), 'Signed out of every device.')}
              disabled={busy}
            >
              Force logout ({detail.data.activeSessions.length})
            </Button>
            {userId !== me?.id ? (
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                onClick={() => setConfirming({ mode: 'delete' })}
                disabled={busy}
              >
                Delete account
              </Button>
            ) : null}
          </div>

          <div className="grid grid-2">
            <div>
              <div className="card-subtitle" style={{ marginBottom: 8 }}>Subscriptions ({detail.data.subscriptions.length})</div>
              <div className="stack gap-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {detail.data.subscriptions.length ? detail.data.subscriptions.map((s) => (
                  <div className="row gap-2 small" key={s.id}>
                    <span className="grow truncate">{s.name}</span>
                    <Badge tone={s.status === 'active' ? 'success' : s.status === 'trial' ? 'info' : 'neutral'}>{s.status}</Badge>
                    <span className="nums muted">{formatCurrency(s.cost, s.currency)}</span>
                  </div>
                )) : <p className="tiny muted">No subscriptions.</p>}
              </div>
            </div>
            <div>
              <div className="card-subtitle" style={{ marginBottom: 8 }}>Recent payments ({detail.data.recentPayments.length})</div>
              <div className="stack gap-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {detail.data.recentPayments.length ? detail.data.recentPayments.map((p) => (
                  <div className="row gap-2 small" key={p.id}>
                    <span className="grow truncate">{p.subscription_name}</span>
                    <Badge tone={p.status === 'paid' ? 'success' : p.status === 'failed' ? 'danger' : 'neutral'}>{p.status}</Badge>
                    <span className="nums muted">{formatCurrency(p.amount, p.currency)}</span>
                  </div>
                )) : <p className="tiny muted">No payments recorded.</p>}
              </div>
            </div>
          </div>

          <div className="row gap-6 small muted">
            <span>{detail.data.activity.insightsGenerated} insights generated</span>
            <span>{detail.data.activity.chatMessages} chat messages</span>
            {detail.data.activity.lastChatAt ? <span>last chat {formatDate(detail.data.activity.lastChatAt)}</span> : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={() => act(() => api.admin.deleteUser(userId), 'Account deleted.')}
        loading={busy}
        danger
        title={`Delete ${detail.data?.user.email}?`}
        confirmLabel="Delete permanently"
        message="This removes their subscriptions, payment history, insights and chat history immediately. This cannot be undone."
      />
    </Modal>
  );
}

function randomPassword() {
  // Meets the same policy the sign-up form enforces (8+ chars, mixed case,
  // a digit and a symbol) so the admin never hits a validation error just
  // for using the generated value.
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const body = Array.from(bytes, (b) => b.toString(36)).join('').slice(0, 10);
  return `${body.slice(0, 5)}A1${body.slice(5)}!`;
}

function CreateUserModal({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: randomPassword(), isAdmin: false });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      const created = await api.admin.createUser(form);
      toast.success(`Account created for ${created.email}.`);
      onCreated();
      onClose();
    } catch (error) {
      if (error.isValidationError) {
        setErrors(error.details);
        toast.error('Please fix the highlighted fields.');
      } else {
        toast.error(error.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Create user">
      <form className="stack gap-4" onSubmit={submit}>
        <Alert tone="info">
          Creates a pre-verified account directly — no e-mail loop to close. Share the
          password with them yourself; SubTrack won't show it again after this.
        </Alert>
        <Field label="Name" error={errors.name} required htmlFor="admin-new-name">
          <Input id="admin-new-name" value={form.name} onChange={set('name')} placeholder="Jane Doe" autoComplete="off" error={errors.name} />
        </Field>
        <Field label="E-mail" error={errors.email} required htmlFor="admin-new-email">
          <Input id="admin-new-email" type="email" value={form.email} onChange={set('email')} placeholder="jane@example.com" autoComplete="off" error={errors.email} />
        </Field>
        <Field label="Password" error={errors.password} required htmlFor="admin-new-password">
          <div className="row gap-2">
            <Input id="admin-new-password" value={form.password} onChange={set('password')} autoComplete="off" error={errors.password} />
            <Button type="button" size="sm" onClick={() => setForm((f) => ({ ...f, password: randomPassword() }))}>
              Regenerate
            </Button>
          </div>
        </Field>
        <Switch
          checked={form.isAdmin}
          onChange={(value) => setForm((f) => ({ ...f, isAdmin: value }))}
          label="Grant admin access"
        />
        <div className="row gap-2" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>Create account</Button>
        </div>
      </form>
    </Modal>
  );
}

function UsersTab() {
  const { user: me } = useAuth();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const limit = 25;
  const debouncedSearch = useDebounced(search, 250);

  const list = useAsync(
    () => api.admin.users({ search: debouncedSearch || undefined, limit, offset }),
    [debouncedSearch, offset],
  );

  return (
    <div className="stack gap-4">
      <div className="row gap-3 wrap">
        <div className="input-group" style={{ maxWidth: 340 }}>
          <span className="input-prefix"><Icon name="search" size={15} /></span>
          <Input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
            placeholder="Search by name or e-mail…"
          />
        </div>
        <div className="grow" />
        <Button icon="plus" onClick={() => setCreating(true)}>Create user</Button>
      </div>

      {list.loading && !list.data ? (
        <Loading label="Loading users…" />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data?.users.length ? (
        <Empty icon="users" title="No users match" message="Try a different search." />
      ) : (
        <div className="card card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="right">Subscriptions</th>
                  <th className="right">Monthly spend</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="semibold">{u.name}</div>
                      <div className="tiny muted truncate">{u.email}</div>
                    </td>
                    <td className="right nums">{u.subscription_count}</td>
                    <td className="right nums">{formatCurrency(u.monthly_spend, 'USD')}</td>
                    <td className="small muted">{formatDate(u.created_at)}</td>
                    <td>
                      <div className="row gap-1 wrap">
                        {u.is_admin ? <Badge tone="brand">Admin</Badge> : null}
                        {u.email_verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}
                        {u.id === me?.id ? <Badge tone="neutral">You</Badge> : null}
                      </div>
                    </td>
                    <td>
                      <Button size="sm" variant="soft" onClick={() => setSelected(u.id)}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="between" style={{ padding: 'var(--space-4)' }}>
            <span className="tiny muted">
              {offset + 1}–{Math.min(offset + limit, list.data.total)} of {list.data.total}
            </span>
            <div className="row gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Previous
              </Button>
              <Button size="sm" disabled={offset + limit >= list.data.total} onClick={() => setOffset(offset + limit)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      )}

      {selected ? (
        <UserDetailModal userId={selected} onClose={() => setSelected(null)} onChanged={list.reload} />
      ) : null}
      {creating ? (
        <CreateUserModal onClose={() => setCreating(false)} onCreated={list.reload} />
      ) : null}
    </div>
  );
}

function AuditLogTab() {
  const log = useAsync(() => api.admin.auditLog(), []);

  if (log.loading && !log.data) return <Loading label="Loading audit log…" />;
  if (log.error) return <ErrorState error={log.error} onRetry={log.reload} />;
  if (!log.data?.entries.length) {
    return <Empty icon="clock" title="No admin actions yet" message="Every grant, revoke, force-logout and deletion will show up here." />;
  }

  return (
    <div className="card card-flush">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {log.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="small muted mono">{new Date(entry.created_at).toLocaleString()}</td>
                <td className="small">{entry.admin_email}</td>
                <td><Badge tone="neutral">{entry.action.replace(/_/g, ' ')}</Badge></td>
                {/* A deleted user has no row left to join against, so their
                    e-mail (saved at delete time) comes from `detail` instead. */}
                <td className="small muted">{entry.target_email ?? entry.detail?.email ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState('overview');
  return (
    <AppShell title="Admin Panel">
      <div className="stack gap-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'users', label: 'Users' },
            { value: 'audit', label: 'Audit Log' },
          ]}
        />
        {tab === 'overview' ? <OverviewTab /> : null}
        {tab === 'users' ? <UsersTab /> : null}
        {tab === 'audit' ? <AuditLogTab /> : null}
      </div>
    </AppShell>
  );
}

export default AdminPage;
