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
// Track the visual viewport and expose three CSS vars:
//   --vvh    : the height actually visible RIGHT NOW, keyboard included in the
//              subtraction (so a sheet never exceeds it)
//   --kb     : how far the keyboard overlaps the bottom (so we lift the sheet
//              above it)
//   --glassh : the height of the glass this app owns, keyboard EXCLUDED - the
//              number a full-screen screen (the rolling screen) fills
//
// WHY --glassh IS NOT JUST --vvh. Two reasons, and the second is the one that
// cost real debugging.
//
//   1. SEMANTICS. A sheet must shrink when the keyboard comes up; the rolling
//      screen behind it must not. One number cannot mean both, and --vvh's
//      meaning is already spoken for by the sheets.
//   2. visualViewport.height AND window.innerHeight DO NOT ALWAYS AGREE, and
//      when they disagree the smaller one is not automatically the truth. The
//      rolling screen shipped with a band of bare ground under it on the
//      owner's iPhone, measured off his own screenshot at 390x844pt: the red
//      tally ring ended 81pt above the bottom of the glass where 34pt
//      (safe-area-inset-bottom) is the whole designed clearance. The missing
//      47pt is exactly safe-area-inset-top on that device - the fingerprint of
//      a viewport metric that is one status bar short. Taking the LARGER of the
//      two closes that gap when it is visualViewport under-reporting, and is a
//      no-op when the two agree (every desktop engine, and the emulator this
//      repo's harness runs in, where they are always identical - see the note
//      on assertion 10 in scripts/shoot-roll.mjs: the phone is the oracle here,
//      not Chrome).
//
// It cannot make the screen taller than the glass in the case that matters:
// on iOS both numbers track the visible area as the toolbar settles, so max()
// picks the same number either way and CUT still does not move mid-gesture.
// The one place they diverge on purpose is the keyboard, and there the larger
// number is the one the rolling screen wants.
function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.setProperty('--vvh', window.innerHeight + 'px');
    root.style.setProperty('--glassh', window.innerHeight + 'px');
    return;
  }
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--vvh', vv.height + 'px');
    root.style.setProperty('--kb', kb + 'px');
    root.style.setProperty('--glassh', Math.max(vv.height, window.innerHeight) + 'px');
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
