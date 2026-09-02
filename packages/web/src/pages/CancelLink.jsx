/**
 * Public one-click cancellation page.
 *
 * Reached from an e-mail link — no sign-in required, and deliberately
 * never triggers the cancellation itself on page load. The initial load
 * is a preview (GET) so a mail client's automatic link-scanner cannot
 * cancel anything just by fetching the URL; only clicking the button on
 * this page (a POST) does.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatCurrency, CYCLE_LABELS } from '@subtrack/shared';
import { Icon } from '../components/Icon.jsx';
import { Button, Alert, Loading } from '../components/ui.jsx';
import { api } from '../lib/api.js';

function Layout({ children }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sidebar-logo">
            <Icon name="dollar-sign" size={19} strokeWidth={2.5} />
          </span>
          SubTrack
        </div>
        {children}
      </div>
    </div>
  );
}

export function CancelLinkPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState('loading'); // loading | preview | confirming | done | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const preview = await api.public.previewCancel(token);
        if (cancelled) return;
        setData(preview);
        setState(preview.alreadyCancelled ? 'done' : 'preview');
      } catch (caught) {
        if (!cancelled) {
          setError(caught.message);
          setState('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const confirm = async () => {
    setState('confirming');
    try {
      const result = await api.public.confirmCancel(token);
      setData(result);
      setState('done');
    } catch (caught) {
      setError(caught.message);
      setState('error');
    }
  };

  if (state === 'loading') {
    return <Layout><Loading label="Checking your link…" /></Layout>;
  }

  if (state === 'error') {
    return (
      <Layout>
        <div className="auth-title"><h2>Link not valid</h2></div>
        <Alert tone="error">{error}</Alert>
        <p className="tiny muted center" style={{ marginTop: 'var(--space-4)' }}>
          <button type="button" onClick={() => navigate('/login')} style={{ color: 'var(--brand-text)', textDecoration: 'underline' }}>
            Sign in
          </button>{' '}
          to manage your subscriptions instead.
        </p>
      </Layout>
    );
  }

  if (state === 'done') {
    return (
      <Layout>
        <div className="auth-title">
          <h2>{data.alreadyCancelled ? 'Already marked cancelled' : 'Marked as cancelled in SubTrack'}</h2>
        </div>
        <Alert tone="success">
          {data.alreadyCancelled
            ? `${data.name} was already marked as cancelled in SubTrack — nothing further to do here.`
            : `${data.name} will no longer count towards your tracked spend (saving ${formatCurrency(data.monthlySaving, data.currency)} a month in your dashboard).`}
        </Alert>
        {data.cancelHelp ? (
          <>
            <Alert tone="warning">
              This only updates SubTrack's records. If you haven't already cancelled with{' '}
              {data.name} itself, you are still being charged.
            </Alert>
            <a
              href={data.cancelHelp.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-lg btn-block"
              style={{ textDecoration: 'none' }}
            >
              <Icon name="external" size={16} />
              {data.cancelHelp.isDirect ? `Cancel on ${data.name} ↗` : `Find out how to cancel ${data.name} ↗`}
            </a>
          </>
        ) : null}
        <p className="tiny muted center" style={{ marginTop: 'var(--space-4)' }}>
          <button type="button" onClick={() => navigate('/')} style={{ color: 'var(--brand-text)', textDecoration: 'underline' }}>
            Sign in
          </button>{' '}
          to see your updated spending.
        </p>
      </Layout>
    );
  }

  // preview / confirming
  return (
    <Layout>
      <div className="auth-title">
        <h2>Cancel {data.name}</h2>
        <p>
          {formatCurrency(data.cost, data.currency)} {CYCLE_LABELS[data.billingCycle]?.toLowerCase()}
        </p>
      </div>

      <Alert tone="info">
        SubTrack can't cancel this for you — it has no account or access with{' '}
        {data.name}. Only they can actually stop the charge.
      </Alert>

      <div className="stack gap-3" style={{ marginTop: 'var(--space-4)' }}>
        <a
          href={data.cancelHelp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary btn-lg btn-block"
          style={{ textDecoration: 'none' }}
        >
          <Icon name="external" size={16} />
          {data.cancelHelp.isDirect ? `Cancel on ${data.name}` : `Find out how to cancel ${data.name}`}
        </a>
        <p className="tiny muted center">
          {data.cancelHelp.isDirect
            ? 'Opens their real cancellation page in a new tab.'
            : "We don't have a direct link for this one — this searches for the right page."}
        </p>

        <div
          className="row gap-3"
          style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}
        >
          <span className="grow tiny secondary">
            Already cancelled it with {data.name}? Stop counting it in SubTrack too.
          </span>
        </div>
        <Button variant="secondary" onClick={confirm} loading={state === 'confirming'} block>
          I've cancelled it — also mark it cancelled in SubTrack
        </Button>
        <Button variant="ghost" block onClick={() => navigate('/')}>
          Not now
        </Button>
      </div>
    </Layout>
  );
}

export default CancelLinkPage;
