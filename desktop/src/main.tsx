import './web-bridge';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './state/AuthContext';
import { InvitationsProvider } from './state/InvitationsContext';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// A rejected promise with no .catch() (e.g. a fire-and-forget `load()` in a useEffect)
// otherwise fails silently in the console with no visible effect on the UI; logging it
// loudly here at least makes the failure discoverable instead of invisible.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[insightest] unhandled promise rejection', event.reason);
});
window.addEventListener('error', (event) => {
  console.error('[insightest] unhandled error', event.error ?? event.message);
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <InvitationsProvider>
          <App />
        </InvitationsProvider>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
