/** Sidebar + topbar layout for the authenticated app. */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from './Icon.jsx';
import { Button } from './ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.jsx';
import { useIsMobile, useAsync, useDismissable } from '../lib/hooks.js';
import { api } from '../lib/api.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/subscriptions', label: 'Subscriptions', icon: 'list' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/insights', label: 'AI Insights', icon: 'sparkles' },
  { to: '/assistant', label: 'Assistant', icon: 'chat' },
];

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const options = [
    { value: 'light', icon: 'sun', label: 'Light' },
    { value: 'dark', icon: 'moon', label: 'Dark' },
    { value: 'system', icon: 'monitor', label: 'System' },
  ];
  const next = options[(options.findIndex((o) => o.value === preference) + 1) % options.length];
  const current = options.find((o) => o.value === preference) ?? options[2];

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setPreference(next.value)}
      title={`Theme: ${current.label}. Click for ${next.label}.`}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
    >
      <Icon name={current.icon} size={16} />
    </Button>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const { data, reload } = useAsync(() => api.notifications.list({ limit: 12 }), []);
  useDismissable(panelRef, () => setOpen(false), open);

  const unread = data?.unread ?? 0;
  const notifications = data?.notifications ?? [];

  const markAllRead = async () => {
    await api.notifications.markRead();
    reload();
  };

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { setOpen((value) => !value); if (!open) reload(); }}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        style={{ position: 'relative' }}
      >
        <Icon name="bell" size={16} />
        {unread > 0 ? (
          <span
            style={{
              position: 'absolute', top: 2, right: 2, width: 8, height: 8,
              borderRadius: '50%', background: 'var(--danger)',
              border: '2px solid var(--surface)',
            }}
          />
        ) : null}
      </Button>

      {open ? (
        <div
          className="card animate-pop"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340,
            maxHeight: 420, overflowY: 'auto', zIndex: 50, padding: 0,
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div className="between" style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border)' }}>
            <strong className="small">Notifications</strong>
            {unread > 0 ? (
              <button type="button" className="tiny" style={{ color: 'var(--brand-text)' }} onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>
          {notifications.length === 0 ? (
            <p className="muted small" style={{ padding: 'var(--space-5)', textAlign: 'center' }}>
              Nothing yet. Renewal reminders will appear here.
            </p>
          ) : (
            notifications.map((notification) => (
              <div
                key={notification.id}
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--border)',
                  background: notification.read_at ? 'transparent' : 'var(--brand-soft)',
                }}
              >
                <div className="row gap-2">
                  <Icon
                    name={notification.priority === 'high' ? 'alert-triangle' : 'bell'}
                    size={13}
                    style={{ color: notification.priority === 'high' ? 'var(--warning)' : 'var(--text-muted)', marginTop: 3 }}
                  />
                  <div className="grow">
                    <div className="small semibold">{notification.title}</div>
                    <div className="tiny muted" style={{ marginTop: 2 }}>{notification.body}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  useDismissable(menuRef, () => setOpen(false), open);

  const initials = (user?.name ?? user?.email ?? '?')
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join('');

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        type="button"
        className="row gap-2"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ padding: 4, borderRadius: 'var(--radius)' }}
      >
        <span className="avatar">{initials}</span>
        <Icon name="chevron-down" size={14} className="desktop-only" style={{ color: 'var(--text-muted)' }} />
      </button>

      {open ? (
        <div
          className="card animate-pop"
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 236,
            zIndex: 50, padding: 'var(--space-2)', boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border)', marginBottom: 'var(--space-2)' }}>
            <div className="small semibold truncate">{user?.name}</div>
            <div className="tiny muted truncate">{user?.email}</div>
            {!user?.email_verified ? (
              <span className="badge badge-warning" style={{ marginTop: 6 }}>E-mail unverified</span>
            ) : null}
          </div>
          <Link to="/settings" className="nav-item" role="menuitem" onClick={() => setOpen(false)}>
            <Icon name="settings" size={15} /> Settings
          </Link>
          <button type="button" className="nav-item" role="menuitem" onClick={logout} style={{ width: '100%' }}>
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ title, actions, children }) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();

  // Navigating on mobile should close the drawer, or it covers the page
  // the user just asked for.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  return (
    <div className="shell">
      {drawerOpen && isMobile ? (
        <div className="sidebar-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      ) : null}

      <aside className="sidebar" data-open={drawerOpen ? 'true' : 'false'}>
        <Link to="/" className="sidebar-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="sidebar-logo">
            <Icon name="dollar-sign" size={19} strokeWidth={2.5} />
          </span>
          SubTrack
        </Link>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {user?.is_admin ? (
          <>
            <div className="nav-section">Admin</div>
            <nav className="nav">
              <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Icon name="users" size={17} />
                Admin Panel
              </NavLink>
            </nav>
          </>
        ) : null}

        <div className="nav-section">Account</div>
        <nav className="nav">
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Icon name="settings" size={17} />
            Settings
          </NavLink>
        </nav>

        <div className="grow" />

        {/* Upsell-free footer: just a note about where the AI stands. */}
        <AiModeNote />
      </aside>

      <div className="main">
        <header className="topbar">
          {isMobile ? (
            <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
              <Icon name="menu" size={18} />
            </Button>
          ) : null}
          <h1 className="grow truncate">{title}</h1>
          <div className="row gap-2">
            {actions}
            <ThemeToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}

/**
 * Shows whether Claude is configured. Without a key the app runs on
 * heuristics, and saying so up front is better than letting the user
 * wonder why the assistant is terse.
 */
function AiModeNote() {
  const { data } = useAsync(() => api.ai.status(), []);
  if (!data) return null;
  const isClaude = data.mode === 'claude';
  return (
    <div
      className="tiny"
      style={{
        padding: 'var(--space-3)',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)',
      }}
    >
      <div className="row gap-2" style={{ marginBottom: 4 }}>
        <span className="dot" style={{ background: isClaude ? 'var(--success)' : 'var(--warning)' }} />
        <strong style={{ color: 'var(--text-secondary)' }}>
          {isClaude ? 'Claude connected' : 'Heuristic mode'}
        </strong>
      </div>
      {isClaude
        ? 'Insights and chat are generated by Claude.'
        : 'Set ANTHROPIC_API_KEY for AI-written insights. Everything works meanwhile.'}
    </div>
  );
}

export default AppShell;
