/** Authentication context: the session, and the actions that change it. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setTokens, clearTokens, hasSession, onAuthLost } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
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
    () => ({ user, loading, login, register, logout, patchUser, refreshUser, isAuthenticated: Boolean(user) }),
    [user, loading, login, register, logout, patchUser, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
