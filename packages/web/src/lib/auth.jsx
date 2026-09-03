/** Authentication context: the session, and the actions that change it. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  api, setTokens, clearTokens, hasSession, onAuthLost,
  beginImpersonation, endImpersonation, onImpersonationEnded,
} from './api.js';

const AuthContext = createContext(null);
const IMPERSONATION_META_KEY = 'subtrack.impersonating_meta';

function readImpersonationMeta() {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeImpersonationMeta(meta) {
  try {
    if (meta) sessionStorage.setItem(IMPERSONATION_META_KEY, JSON.stringify(meta));
    else sessionStorage.removeItem(IMPERSONATION_META_KEY);
  } catch {
    /* Non-fatal: the banner just won't survive a reload. */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [impersonating, setImpersonating] = useState(readImpersonationMeta);
  // `loading` covers the initial "do we have a valid session?" check, so
  // the router can hold off deciding between the app and the login page.
  const [loading, setLoading] = useState(hasSession());

  useEffect(() => {
    if (!hasSession()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { user: me } = await api.users.me();
        if (!cancelled) setUser(me);
      } catch {
        // An expired or revoked session: the api client has already
        // cleared the tokens.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The api client tells us when a refresh failed, so a token that dies
  // while the app is open drops the user to the login screen rather than
  // leaving a broken UI.
  useEffect(() => onAuthLost(() => setUser(null)), []);

  // An impersonation token expiring mid-session restores the admin's own
  // access token under the hood; reload the admin's own user here so the
  // UI (banner included) reflects that rather than keeping stale state.
  useEffect(() => onImpersonationEnded(() => {
    writeImpersonationMeta(null);
    setImpersonating(null);
    api.users.me().then(({ user: me }) => setUser(me)).catch(() => setUser(null));
  }), []);

  const applySession = useCallback((session) => {
    setTokens(session);
    setUser(session.user);
    return session.user;
  }, []);

  const login = useCallback(
    async (credentials) => applySession(await api.auth.login(credentials)),
    [applySession],
  );

  const register = useCallback(
    async (details) => applySession(await api.auth.register({
      ...details,
      // Saves the user a settings trip: their reminders land at a sensible
      // local hour from the first day.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })),
    [applySession],
  );

  /** Admin-only: swap into a support session that sees the app as `targetUserId` does. */
  const impersonate = useCallback(async (targetUserId) => {
    const session = await api.admin.impersonate(targetUserId);
    beginImpersonation({ accessToken: session.accessToken });
    const meta = {
      adminEmail: session.impersonating.adminEmail,
      targetEmail: session.user.email,
      targetId: session.user.id,
    };
    writeImpersonationMeta(meta);
    setImpersonating(meta);
    setUser(session.user);
    return session.user;
  }, []);

  /** Return from an impersonated session to the admin's own. */
  const stopImpersonating = useCallback(async () => {
    const restored = endImpersonation();
    writeImpersonationMeta(null);
    setImpersonating(null);
    if (!restored) {
      setUser(null);
      return;
    }
    try {
      const { user: me } = await api.users.me();
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Even if the call fails, drop the local session.
    }
    clearTokens();
    setUser(null);
  }, []);

  /** Merge a server-returned user into state after a profile change. */
  const patchUser = useCallback((updates) => {
    setUser((current) => (current ? { ...current, ...updates } : current));
  }, []);

  const refreshUser = useCallback(async () => {
    const { user: me } = await api.users.me();
    setUser(me);
    return me;
  }, []);

  const value = useMemo(
    () => ({
      user, loading, login, register, logout, patchUser, refreshUser,
      isAuthenticated: Boolean(user),
      impersonating, impersonate, stopImpersonating,
    }),
    [user, loading, login, register, logout, patchUser, refreshUser, impersonating, impersonate, stopImpersonating],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
