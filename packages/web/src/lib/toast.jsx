/** Toast notifications. */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';

const ToastContext = createContext(null);

const ICONS = {
  success: 'check-circle',
  error: 'alert-circle',
  warning: 'alert-triangle',
  info: 'info',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message, { type = 'info', duration = 4500 } = {}) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [...current, { id, message, type }]);
      // Errors stay until dismissed: they usually need reading, and often
      // acting on.
      if (duration > 0 && type !== 'error') {
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  const toast = useMemo(
    () => ({
      show: push,
      success: (message, options) => push(message, { ...options, type: 'success' }),
      error: (message, options) => push(message, { ...options, type: 'error' }),
      warning: (message, options) => push(message, { ...options, type: 'warning' }),
      info: (message, options) => push(message, { ...options, type: 'info' }),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* aria-live so screen readers announce toasts as they arrive. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.type}`}>
            <Icon
              name={ICONS[item.type]}
              size={16}
              style={{ flexShrink: 0, marginTop: 2, color: `var(--${item.type === 'error' ? 'danger' : item.type === 'success' ? 'success' : item.type === 'warning' ? 'warning' : 'info'})` }}
            />
            <span className="grow">{item.message}</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss"
              style={{ padding: 2, borderRadius: 4, color: 'var(--text-muted)' }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
