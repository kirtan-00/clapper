import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initAuthReturn } from './net/supabase';
import { trackAppOpen } from './net/analytics';
import { initPersist } from './net/persist';
import { initErrorTracking } from './net/errors';
import { initSync } from './net/sync';

// Keyboard-aware layout for phones. The on-screen keyboard shrinks the *visual*
// viewport but not the layout viewport, so bottom sheets end up hidden behind it.
// Track the visual viewport and expose two CSS vars the sheet uses:
//   --vvh : the height actually visible (so a sheet never exceeds it)
//   --kb  : how far the keyboard overlaps the bottom (so we lift the sheet above it)
function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.setProperty('--vvh', window.innerHeight + 'px');
    return;
  }
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--vvh', vv.height + 'px');
    root.style.setProperty('--kb', kb + 'px');
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
trackViewport();

// Account/quota + durability layer bootstrap — all non-blocking and never throw,
// so they can't hold up first paint or break the offline core.
initErrorTracking(); // window.onerror + unhandledrejection -> crash telemetry (first, so it catches the rest of boot)
initPersist(); // ask the browser to keep IndexedDB non-evictable (dodges iOS's 7-day wipe)
initAuthReturn(); // finish a Google OAuth PKCE return + strip ?code= from the URL
trackAppOpen(); // one app_open analytics event per load
initSync(); // outbox flush + delta pull; gates on a session, safe to call pre-auth

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
