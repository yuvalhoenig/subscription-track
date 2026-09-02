/**
 * Authentication pages: sign in, register, forgot/reset password, verify.
 *
 * All five share one layout and are kept in one file because they are
 * variations on the same 40-line form.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon.jsx';
import { Button, Field, Input, Alert, Loading } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sidebar-logo">
            <Icon name="dollar-sign" size={19} strokeWidth={2.5} />
          </span>
          SubTrack
        </div>
        <div className="auth-title">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Turn an ApiError into either field errors or a page-level message. */
function useFormErrors() {
  const [fieldErrors, setFieldErrors] = useState({});
  const [message, setMessage] = useState(null);

  const handle = (error) => {
    if (error?.isValidationError) {
      setFieldErrors(error.details);
      setMessage(null);
    } else {
      setFieldErrors({});
      setMessage(error?.message ?? 'Something went wrong. Please try again.');
    }
  };

  const clear = () => {
    setFieldErrors({});
    setMessage(null);
  };

  return { fieldErrors, message, handle, clear, setMessage };
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const { fieldErrors, message, handle, clear } = useFormErrors();

  const submit = async (event) => {
    event.preventDefault();
    clear();
    setBusy(true);
    try {
      await login(form);
      navigate('/', { replace: true });
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  /** One-click sign-in for the seeded demo account. */
  const useDemo = async () => {
    clear();
    setBusy(true);
    try {
      await login({ email: 'demo@subtrack.app', password: 'DemoPass123!' });
      navigate('/', { replace: true });
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to see where your money is going."
      footer={<>New here? <Link to="/register">Create an account</Link></>}
    >
      <form className="stack gap-4" onSubmit={submit} noValidate>
        {message ? <Alert tone="error">{message}</Alert> : null}

        <Field label="E-mail" error={fieldErrors.email} htmlFor="login-email">
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            error={fieldErrors.email}
            placeholder="you@example.com"
          />
        </Field>

        <Field label="Password" error={fieldErrors.password} htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            error={fieldErrors.password}
            placeholder="••••••••••"
          />
        </Field>

        <div className="right">
          <Link to="/forgot-password" className="small">Forgot your password?</Link>
        </div>

        <Button type="submit" variant="primary" size="lg" loading={busy} block>
          Sign in
        </Button>
      </form>

      <div className="demo-hint">
        <div className="row gap-2" style={{ marginBottom: 6 }}>
          <Icon name="sparkles" size={13} style={{ color: 'var(--brand)' }} />
          <strong>Try the demo</strong>
        </div>
        A seeded account with 20+ subscriptions, a year of payment history and
        AI insights already generated.
        <Button
          variant="secondary"
          size="sm"
          onClick={useDemo}
          disabled={busy}
          style={{ marginTop: 'var(--space-3)' }}
          block
        >
          Sign in as demo user
        </Button>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const { fieldErrors, message, handle, clear } = useFormErrors();

  const submit = async (event) => {
    event.preventDefault();
    clear();
    setBusy(true);
    try {
      await register(form);
      navigate('/', { replace: true });
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Track every subscription and let AI find the waste."
      footer={<>Already have an account? <Link to="/login">Sign in</Link></>}
    >
      <form className="stack gap-4" onSubmit={submit} noValidate>
        {message ? <Alert tone="error">{message}</Alert> : null}

        <Field label="Your name" error={fieldErrors.name} htmlFor="reg-name">
          <Input
            id="reg-name"
            autoComplete="name"
            autoFocus
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            error={fieldErrors.name}
            placeholder="Alex Morgan"
          />
        </Field>

        <Field label="E-mail" error={fieldErrors.email} htmlFor="reg-email">
          <Input
            id="reg-email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            error={fieldErrors.email}
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="Password"
          error={fieldErrors.password}
          hint="At least 10 characters, with a number or symbol."
          htmlFor="reg-password"
        >
          <Input
            id="reg-password"
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            error={fieldErrors.password}
            placeholder="••••••••••"
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" loading={busy} block>
          Create account
        </Button>

        <p className="tiny muted center">
          We will send a confirmation link to switch on renewal reminders.
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const { message, handle, clear } = useFormErrors();

  const submit = async (event) => {
    event.preventDefault();
    clear();
    setBusy(true);
    try {
      await api.auth.forgotPassword(email);
      setSent(true);
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout title="Check your inbox" footer={<Link to="/login">Back to sign in</Link>}>
        <Alert tone="success">
          If an account exists for {email}, a reset link is on its way. The link
          expires in one hour.
        </Alert>
        <p className="tiny muted center" style={{ marginTop: 'var(--space-4)' }}>
          Running locally without SMTP configured? The link is printed in the API
          server console.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will e-mail you a link to choose a new one."
      footer={<Link to="/login">Back to sign in</Link>}
    >
      <form className="stack gap-4" onSubmit={submit} noValidate>
        {message ? <Alert tone="error">{message}</Alert> : null}
        <Field label="E-mail" htmlFor="forgot-email">
          <Input
            id="forgot-email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} block>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const { fieldErrors, message, handle, clear, setMessage } = useFormErrors();

  const submit = async (event) => {
    event.preventDefault();
    clear();
    if (password !== confirm) {
      setMessage('Those passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.auth.resetPassword({ token, password });
      toast.success('Password changed. Sign in with your new password.');
      navigate('/login', { replace: true });
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout title="Link not valid" footer={<Link to="/forgot-password">Request a new link</Link>}>
        <Alert tone="error">This reset link is missing its token. Request a fresh one.</Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      <form className="stack gap-4" onSubmit={submit} noValidate>
        {message ? <Alert tone="error">{message}</Alert> : null}
        <Field
          label="New password"
          error={fieldErrors.password}
          hint="At least 10 characters, with a number or symbol."
          htmlFor="reset-password"
        >
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
          />
        </Field>
        <Field label="Confirm password" htmlFor="reset-confirm">
          <Input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} block>
          Set new password
        </Button>
        <p className="tiny muted center">
          Changing your password signs you out on every device.
        </p>
      </form>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState(token ? 'verifying' : 'missing');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        await api.auth.verifyEmail(token);
        setState('done');
      } catch (caught) {
        setError(caught.message);
        setState('failed');
      }
    })();
  }, [token]);

  return (
    <AuthLayout
      title={
        state === 'done' ? 'E-mail confirmed'
          : state === 'verifying' ? 'Confirming your e-mail'
            : 'Could not confirm'
      }
      footer={<Link to="/">Go to your dashboard</Link>}
    >
      {state === 'verifying' ? <Loading label="One moment…" /> : null}
      {state === 'done' ? (
        <Alert tone="success">
          Your address is confirmed. Renewal reminders and the weekly digest are now on.
        </Alert>
      ) : null}
      {state === 'failed' ? <Alert tone="error">{error}</Alert> : null}
      {state === 'missing' ? (
        <Alert tone="error">This confirmation link is missing its token.</Alert>
      ) : null}
    </AuthLayout>
  );
}
