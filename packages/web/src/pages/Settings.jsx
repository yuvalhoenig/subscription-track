/** Settings: profile, AI personalisation, notifications, categories, security. */

import { useEffect, useState } from 'react';
import { SUPPORTED_LOCALES, CATEGORY_PALETTE } from '@subtrack/shared';
import { AppShell } from '../components/AppShell.jsx';
import { Icon } from '../components/Icon.jsx';
import {
  Button, Field, Input, Select, Switch, Alert, Loading, ConfirmDialog, Badge, Segmented,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.jsx';
import { useToast } from '../lib/toast.jsx';

const LOCALE_LABELS = {
  en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
  pt: 'Português', he: 'עברית', ja: '日本語',
};

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'ILS', 'INR', 'CHF', 'SEK'];

function Section({ title, description, children, footer }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <div className="card-title">{title}</div>
          {description ? <div className="card-subtitle">{description}</div> : null}
        </div>
      </div>
      <div className="stack gap-4">{children}</div>
      {footer ? (
        <div className="row gap-2" style={{ marginTop: 'var(--space-5)', justifyContent: 'flex-end' }}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function ProfileSection() {
  const { user, patchUser } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', currency: 'USD', locale: 'en', timezone: 'UTC', monthly_budget: '',
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  // Seed from the loaded user, and re-seed if it changes elsewhere.
  useEffect(() => {
    if (!user) return;
    setForm({
      name: user.name ?? '',
      currency: user.currency ?? 'USD',
      locale: user.locale ?? 'en',
      timezone: user.timezone ?? 'UTC',
      monthly_budget: user.monthly_budget != null ? String(user.monthly_budget) : '',
    });
  }, [user]);

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const payload = {
        name: form.name.trim(),
        currency: form.currency,
        locale: form.locale,
        timezone: form.timezone,
        // An empty budget field clears the budget rather than sending "".
        monthly_budget: form.monthly_budget === '' ? null : Number(form.monthly_budget),
      };
      const { user: updated } = await api.users.update(payload);
      patchUser(updated);
      toast.success('Profile saved.');
    } catch (error) {
      if (error.isValidationError) setErrors(error.details);
      else toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Profile"
      description="Your name, currency and budget"
      footer={<Button variant="primary" onClick={save} loading={saving}>Save changes</Button>}
    >
      <Field label="Name" error={errors.name} htmlFor="set-name">
        <Input
          id="set-name"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          error={errors.name}
        />
      </Field>

      <div className="row gap-3">
        <span className="grow small secondary">{user?.email}</span>
        {user?.email_verified ? (
          <Badge tone="success" icon="check-circle">Verified</Badge>
        ) : (
          <>
            <Badge tone="warning">Unverified</Badge>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api.auth.resendVerification();
                  toast.success('Confirmation e-mail sent.');
                } catch (error) {
                  toast.error(error.message);
                }
              }}
            >
              Resend
            </Button>
          </>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
        <Field label="Currency" htmlFor="set-currency">
          <Select
            id="set-currency"
            value={form.currency}
            onChange={(event) => setForm({ ...form, currency: event.target.value })}
            options={CURRENCIES}
          />
        </Field>
        <Field label="Language" hint="Used for AI replies" htmlFor="set-locale">
          <Select
            id="set-locale"
            value={form.locale}
            onChange={(event) => setForm({ ...form, locale: event.target.value })}
            options={SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] ?? code }))}
          />
        </Field>
      </div>

      <Field
        label="Monthly budget"
        error={errors.monthly_budget}
        hint="Leave blank for no budget. SubTrack warns you at 80% and again when you cross it."
        htmlFor="set-budget"
      >
        <Input
          id="set-budget"
          type="number"
          min="0"
          step="1"
          inputMode="decimal"
          value={form.monthly_budget}
          onChange={(event) => setForm({ ...form, monthly_budget: event.target.value })}
          placeholder="e.g. 250"
          error={errors.monthly_budget}
          prefix={<Icon name="dollar-sign" size={14} />}
        />
      </Field>

      <Field label="Timezone" hint="Reminders are sent in the morning, your time" htmlFor="set-tz">
        <Input
          id="set-tz"
          value={form.timezone}
          onChange={(event) => setForm({ ...form, timezone: event.target.value })}
          placeholder="America/New_York"
        />
      </Field>
    </Section>
  );
}

function PreferencesSection() {
  const { user, patchUser } = useAuth();
  const { preference, setPreference } = useTheme();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const preferences = user?.preferences ?? {};
  const notifications = preferences.notifications ?? {};

  const savePreferences = async (patch) => {
    setSaving(true);
    try {
      const { user: updated } = await api.users.update({ preferences: patch });
      patchUser(updated);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleNotification = (key) => (value) =>
    savePreferences({ notifications: { [key]: value } });

  return (
    <>
      <Section title="Appearance" description="How SubTrack looks on this device">
        <Field label="Theme">
          <Segmented
            value={preference}
            onChange={setPreference}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Field>
      </Section>

      <Section
        title="AI personalisation"
        description="How the assistant and insights are written for you"
      >
        <Field label="Tone" hint="Applied to insight text and chat replies">
          <Segmented
            value={preferences.aiTone ?? 'friendly'}
            onChange={(value) => savePreferences({ aiTone: value })}
            options={[
              { value: 'concise', label: 'Concise' },
              { value: 'friendly', label: 'Friendly' },
              { value: 'detailed', label: 'Detailed' },
            ]}
          />
        </Field>

        <Field label="Insight digest" hint="How often to summarise your spending">
          <Segmented
            value={preferences.insightFrequency ?? 'weekly'}
            onChange={(value) => savePreferences({ insightFrequency: value })}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Field>
      </Section>

      <Section title="Notifications" description="What SubTrack tells you about, and when">
        {!user?.email_verified ? (
          <Alert tone="warning">
            E-mail notifications need a confirmed address. Until then, reminders appear
            in the app only.
          </Alert>
        ) : null}

        {[
          ['renewalReminders', 'Renewal reminders', 'Ahead of each charge — earlier for expensive plans'],
          ['budgetAlerts', 'Budget alerts', 'At 80% of your budget and again when you cross it'],
          ['insightDigest', 'Insight digest', 'A periodic summary of what changed'],
          ['email', 'Send by e-mail', 'Otherwise notifications stay in the app'],
        ].map(([key, label, description]) => (
          <div className="row gap-4" key={key}>
            <div className="grow">
              <div className="small semibold">{label}</div>
              <div className="tiny muted">{description}</div>
            </div>
            <Switch
              checked={notifications[key] !== false}
              onChange={toggleNotification(key)}
              label={label}
            />
          </div>
        ))}

        <Field label="Preferred delivery hour" hint="In your timezone" htmlFor="set-hour">
          <Select
            id="set-hour"
            value={String(notifications.hour ?? 9)}
            onChange={(event) => savePreferences({ notifications: { hour: Number(event.target.value) } })}
            options={Array.from({ length: 24 }, (_, hour) => ({
              value: String(hour),
              label: `${String(hour).padStart(2, '0')}:00`,
            }))}
          />
        </Field>

        {saving ? <span className="tiny muted">Saving…</span> : null}
      </Section>
    </>
  );
}

function CategoriesSection() {
  const toast = useToast();
  const categories = useAsync(() => api.categories.list(), []);
  const [name, setName] = useState('');
  const [color, setColor] = useState(CATEGORY_PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.categories.create({ name: name.trim(), color });
      setName('');
      categories.reload();
      toast.success('Category added.');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.categories.remove(deleting.id);
      categories.reload();
      toast.success('Category deleted. Its subscriptions were kept.');
      setDeleting(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Categories"
      description="The AI categoriser learns whichever set you keep here"
    >
      {categories.loading && !categories.data ? (
        <Loading label="Loading categories…" size="sm" />
      ) : (
        <div className="stack gap-2">
          {(categories.data?.categories ?? []).map((category) => (
            <div className="row gap-3" key={category.id}>
              <span className="dot" style={{ background: category.color, width: 10, height: 10 }} />
              <span className="grow small semibold">{category.name}</span>
              <span className="tiny muted">
                {category.subscription_count} sub{category.subscription_count === 1 ? '' : 's'}
                {Number(category.monthly_spend) > 0 ? ` · $${category.monthly_spend}/mo` : ''}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleting(category)}
                title="Delete category"
                style={{ color: 'var(--danger)' }}
              >
                <Icon name="trash" size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="row gap-2 wrap" style={{ paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New category name"
          style={{ flex: 1, minWidth: 160 }}
          onKeyDown={(event) => { if (event.key === 'Enter') create(); }}
        />
        <div className="row gap-1">
          {CATEGORY_PALETTE.slice(0, 8).map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => setColor(swatch)}
              aria-label={`Use colour ${swatch}`}
              style={{
                width: 22, height: 22, borderRadius: 'var(--radius-sm)',
                background: swatch,
                border: color === swatch ? '2px solid var(--text)' : '2px solid transparent',
              }}
            />
          ))}
        </div>
        <Button variant="primary" icon="plus" onClick={create} loading={busy}>Add</Button>
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        loading={busy}
        danger
        title={`Delete "${deleting?.name}"?`}
        confirmLabel="Delete category"
        message="Its subscriptions are kept and become uncategorised — no spending history is lost."
      />
    </Section>
  );
}

function SecuritySection() {
  const { logout } = useAuth();
  const toast = useToast();
  const sessions = useAsync(() => api.auth.sessions(), []);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  const changePassword = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.auth.changePassword(form);
      toast.success('Password changed. Signing you out of every device…');
      // Changing the password revokes every session, including this one.
      setTimeout(logout, 1200);
    } catch (error) {
      if (error.isValidationError) setErrors(error.details);
      else toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    try {
      await api.users.remove(deletePassword);
      toast.success('Account deleted.');
      setTimeout(logout, 800);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Password"
        description="Changing it signs you out everywhere"
        footer={(
          <Button
            variant="primary"
            onClick={changePassword}
            loading={busy}
            disabled={!form.currentPassword || !form.newPassword}
          >
            Change password
          </Button>
        )}
      >
        <Field label="Current password" error={errors.currentPassword} htmlFor="sec-current">
          <Input
            id="sec-current"
            type="password"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
            error={errors.currentPassword}
          />
        </Field>
        <Field
          label="New password"
          error={errors.newPassword}
          hint="At least 10 characters, with a number or symbol."
          htmlFor="sec-new"
        >
          <Input
            id="sec-new"
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
            error={errors.newPassword}
          />
        </Field>
      </Section>

      <Section title="Active sessions" description="Devices currently signed in">
        {sessions.loading ? (
          <Loading size="sm" label="" />
        ) : (
          <div className="stack gap-2">
            {(sessions.data?.sessions ?? []).map((session) => (
              <div className="row gap-3" key={session.id}>
                <Icon name="monitor" size={15} style={{ color: 'var(--text-muted)' }} />
                <span className="grow small truncate">
                  {session.user_agent?.slice(0, 60) ?? 'Unknown device'}
                </span>
                <span className="tiny muted">
                  {new Date(session.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
        <Button
          variant="secondary"
          icon="logout"
          onClick={async () => {
            try {
              const { revoked } = await api.auth.logoutAll();
              toast.success(`Signed out of ${revoked} session(s).`);
              setTimeout(logout, 900);
            } catch (error) {
              toast.error(error.message);
            }
          }}
        >
          Sign out everywhere
        </Button>
      </Section>

      <Section title="Delete account" description="Irreversible, and takes everything with it">
        <Alert tone="error">
          Deleting your account removes your subscriptions, payment history, insights and
          chat history immediately. This cannot be undone.
        </Alert>
        <Button variant="danger" icon="trash" onClick={() => setConfirmingDelete(true)}>
          Delete my account
        </Button>

        <ConfirmDialog
          open={confirmingDelete}
          onClose={() => { setConfirmingDelete(false); setDeletePassword(''); }}
          onConfirm={deleteAccount}
          loading={busy}
          danger
          title="Delete your account?"
          confirmLabel="Delete everything"
          message="Confirm your password to permanently delete your account and all of its data."
        />
        {confirmingDelete ? (
          <Field label="Confirm your password" htmlFor="del-password">
            <Input
              id="del-password"
              type="password"
              value={deletePassword}
              onChange={(event) => setDeletePassword(event.target.value)}
            />
          </Field>
        ) : null}
      </Section>
    </>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState('profile');

  return (
    <AppShell title="Settings">
      <div className="stack gap-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'preferences', label: 'Preferences' },
            { value: 'categories', label: 'Categories' },
            { value: 'security', label: 'Security' },
          ]}
        />

        <div className="stack gap-5" style={{ maxWidth: 720 }}>
          {tab === 'profile' ? <ProfileSection /> : null}
          {tab === 'preferences' ? <PreferencesSection /> : null}
          {tab === 'categories' ? <CategoriesSection /> : null}
          {tab === 'security' ? <SecuritySection /> : null}
        </div>
      </div>
    </AppShell>
  );
}

export default SettingsPage;
