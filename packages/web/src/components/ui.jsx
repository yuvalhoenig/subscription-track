/** Shared UI primitives. */

import { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';

export function Button({
  variant = 'secondary', size, icon, iconRight, loading, block, children, className = '', ...rest
}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size ? `btn-${size}` : '',
    block ? 'btn-block' : '',
    !children ? 'btn-icon' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button type="button" className={classes} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
}

export function Field({ label, error, hint, required, children, htmlFor }) {
  return (
    <div className="field">
      {label ? (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required ? <span style={{ color: 'var(--danger)' }} aria-hidden="true"> *</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span className="field-error" role="alert">
          <Icon name="alert-circle" size={12} />
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input({ error, prefix, className = '', ...rest }) {
  const input = (
    <input
      className={`input ${error ? 'input-error' : ''} ${className}`}
      // Ties the message to the field for assistive tech.
      aria-invalid={error ? 'true' : undefined}
      {...rest}
    />
  );
  if (!prefix) return input;
  return (
    <div className="input-group">
      <span className="input-prefix">{prefix}</span>
      {input}
    </div>
  );
}

export function Select({ error, options = [], placeholder, className = '', children, ...rest }) {
  return (
    <select className={`select ${error ? 'input-error' : ''} ${className}`} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value ?? option} value={option.value ?? option}>
          {option.label ?? option}
        </option>
      ))}
      {children}
    </select>
  );
}

export function Textarea({ error, className = '', ...rest }) {
  return <textarea className={`textarea ${error ? 'input-error' : ''} ${className}`} {...rest} />;
}

export function Switch({ checked, onChange, label, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-on={checked ? 'true' : 'false'}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Badge({ tone = 'neutral', icon, children }) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

/** Status pill with the tone and icon each subscription state deserves. */
export function StatusBadge({ status }) {
  const map = {
    active: { tone: 'success', icon: 'check-circle', label: 'Active' },
    trial: { tone: 'info', icon: 'clock', label: 'Trial' },
    paused: { tone: 'warning', icon: 'pause', label: 'Paused' },
    cancelled: { tone: 'neutral', icon: 'x', label: 'Cancelled' },
  };
  const config = map[status] ?? { tone: 'neutral', label: status };
  return <Badge tone={config.tone} icon={config.icon}>{config.label}</Badge>;
}

export function Progress({ value, max = 100, tone }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  // Over budget reads red, close to it amber.
  const cls = tone ?? (percent >= 100 ? 'over' : percent >= 80 ? 'warn' : '');
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`progress-bar ${cls}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** 0-100 score bar, coloured by band. */
export function Meter({ value, label }) {
  if (value == null) return <span className="muted tiny">No data</span>;
  const colour =
    value >= 70 ? 'var(--success)' : value >= 40 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="meter" title={label ? `${label}: ${value}/100` : `${value}/100`}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${value}%`, background: colour }} />
      </div>
      <span className="tiny nums muted" style={{ minWidth: 22 }}>{Math.round(value)}</span>
    </div>
  );
}

/**
 * Modal dialog.
 *
 * Handles the accessibility basics a hand-rolled modal usually misses:
 * Escape closes, focus moves in on open and returns to the trigger on
 * close, background scrolling is locked, and Tab is trapped inside.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, size }) {
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Wrap focus at both ends so Tab cannot escape the dialog.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    // Focus the first control rather than the dialog itself.
    const timer = setTimeout(() => {
      const target = dialogRef.current?.querySelector(
        'input:not([type="hidden"]), select, textarea, button',
      );
      target?.focus();
    }, 40);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      clearTimeout(timer);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="overlay"
      // Clicking the backdrop closes; clicks inside must not bubble to it.
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className={`modal ${size === 'lg' ? 'modal-lg' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <p className="secondary">{message}</p>
    </Modal>
  );
}

export function Empty({ icon = 'layers', title, message, action }) {
  return (
    <div className="empty">
      <div className="empty-art"><Icon name={icon} size={30} /></div>
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      {action ? <div style={{ marginTop: 'var(--space-3)' }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', radius, style }) {
  return (
    <div
      className="skeleton"
      style={{ height, width, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

/** Card-shaped placeholder used while a panel loads. */
export function SkeletonCard({ lines = 3 }) {
  return (
    <div className="card">
      <Skeleton height={12} width="35%" />
      <Skeleton height={30} width="55%" style={{ marginTop: 12 }} />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={10} width={`${85 - index * 15}%`} style={{ marginTop: 10 }} />
      ))}
    </div>
  );
}

export function Loading({ label = 'Loading…', size = 'lg' }) {
  return (
    <div className="stack gap-3" style={{ alignItems: 'center', padding: 'var(--space-12)' }}>
      <span className={size === 'lg' ? 'spinner spinner-lg' : 'spinner'} style={{ color: 'var(--brand)' }} />
      <span className="muted small">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const isNetwork = error?.isNetworkError;
  return (
    <Empty
      icon="alert-circle"
      title={isNetwork ? 'Cannot reach the server' : 'Something went wrong'}
      message={error?.message ?? 'An unexpected error occurred.'}
      action={onRetry ? <Button variant="secondary" icon="refresh" onClick={onRetry}>Try again</Button> : null}
    />
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => {
        const optionValue = option.value ?? option;
        return (
          <button
            key={optionValue}
            type="button"
            role="tab"
            aria-selected={value === optionValue}
            className={value === optionValue ? 'active' : ''}
            onClick={() => onChange(optionValue)}
          >
            {option.label ?? option}
          </button>
        );
      })}
    </div>
  );
}

export function Alert({ tone = 'info', icon, children }) {
  const defaultIcon = {
    info: 'info', error: 'alert-circle', success: 'check-circle', warning: 'alert-triangle',
  }[tone];
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon ?? defaultIcon} size={16} style={{ marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

/** Coloured square with initials, used as a service/category mark. */
export function ServiceMark({ name, color, size = 34 }) {
  const initials = String(name ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase() || '?';
  return (
    <div
      className="service-mark"
      style={{
        width: size,
        height: size,
        // A soft tint of the category colour rather than the full-strength
        // hue, which would fight with the rest of the row.
        background: color ? `linear-gradient(135deg, ${color}, ${color}cc)` : 'var(--gradient-brand)',
        fontSize: size <= 28 ? 10 : 12,
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
