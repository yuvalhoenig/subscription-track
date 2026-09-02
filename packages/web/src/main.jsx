import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

import { adoptDesktopSession } from './lib/api.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

function mount() {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/**
 * In the desktop app the session lives in the main process, so it is
 * adopted before React mounts — otherwise the auth provider would decide
 * the user is signed out and flash the login screen on every launch.
 * In a browser this resolves immediately to false.
 */
adoptDesktopSession().then(mount, mount);
