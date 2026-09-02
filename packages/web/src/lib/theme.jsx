/**
 * Theme context.
 *
 * Three states rather than two: 'light', 'dark', and 'system' (follow the
 * OS). 'system' is the default and stays live — changing the OS appearance
 * updates the app without a reload.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);
const STORAGE_KEY = 'subtrack.themePreference';

function readPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS setting so 'system' is not a one-time read.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return undefined;
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    try {
      // The pre-paint script in index.html reads this key, so it must hold
      // the *resolved* theme to avoid a flash on next load.
      localStorage.setItem('subtrack.theme', resolved);
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* storage unavailable */
    }
  }, [resolved, preference]);

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved]);

  const value = useMemo(
    () => ({ theme: resolved, preference, setPreference, toggle, isDark: resolved === 'dark' }),
    [resolved, preference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider');
  return context;
}
