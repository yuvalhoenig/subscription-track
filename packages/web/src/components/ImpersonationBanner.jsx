/** Persistent banner shown while an admin is viewing the app as another user. */

import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { Icon } from './Icon.jsx';

export function ImpersonationBanner() {
  const { impersonating, stopImpersonating } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!impersonating) return null;

  const back = async () => {
    setBusy(true);
    try {
      await stopImpersonating();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="impersonation-banner" role="status">
      <Icon name="eye" size={15} />
      <span>
        Viewing as <strong>{impersonating.targetEmail}</strong> — Admin ({impersonating.adminEmail})
      </span>
      <button type="button" className="impersonation-banner-return" onClick={back} disabled={busy}>
        {busy ? 'Returning…' : 'Return to admin'}
      </button>
    </div>
  );
}

export default ImpersonationBanner;
