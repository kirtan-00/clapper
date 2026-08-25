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
/**
 * A THIRD SOURCE FOR THE GLASS HEIGHT, because on a real iPhone the other two
 * are both wrong in the same direction.
 *
 * Measured off the owner's 390x844pt screenshot AFTER `--glassh` shipped as
 * `max(visualViewport.height, window.innerHeight)`: the band of bare ground
 * under the rolling screen was still 81.3pt, bit-for-bit what it was before.
 * The tally ring sat 47.0..762.7, and 762.7 is 797 minus 34
 * (safe-area-inset-bottom), so `--glassh` had resolved to 797 on an 844pt
 * screen. `max()` only helps when the two metrics disagree; installed on iOS
 * they BOTH report 797, one status bar short of the glass, so no combination
 * of them can find the missing 47pt. It needs a number that does not come
 * from the layout viewport at all.
 *
 * `screen` is that number, and it is ONLY safe to use when running as an
 * installed app. In a browser tab `screen.height` is still the whole display
 * while the visible area is smaller by however much chrome is showing, and
 * `.roll` bottom-anchors CUT - so trusting it in Safari would push the one
 * button you press without looking off the bottom of the screen. Installed,
 * there is no chrome to subtract and the screen IS the glass.
 *
 * ORIENTATION, the trap in using `screen` at all: iOS reports `screen.width`
 * and `screen.height` in the DEVICE's natural orientation and does not swap
 * them when the phone turns. Reading `.height` blind would hand landscape an
 * 844pt height for a 390pt-tall glass, and every control below the fold. So
 * the dimension is chosen by comparing the viewport's own aspect instead of
 * trusting which property is which.
 *
 * Returns 0 - not a height - when this is not an installed app or anything is
 * unavailable, so it simply drops out of the `max()` and behaviour is exactly
 * what it was before.
 */
function installedGlass(): number {
  try {
    const standalone =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      // iOS Safari's legacy flag, still the only signal on older versions.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (!standalone) return 0;

    const sw = Number(window.screen?.width) || 0;
    const sh = Number(window.screen?.height) || 0;
    if (!sw || !sh) return 0;

    // Portrait glass is the LONGER screen dimension, landscape the shorter -
    // decided from the viewport we can actually see, never from which property
    // iOS happens to call "height".
    const portrait = window.innerHeight >= window.innerWidth;
    return portrait ? Math.max(sw, sh) : Math.min(sw, sh);
  } catch {
    // Never let a viewport probe break boot: the app must render even if every
    // one of these APIs is missing.
    return 0;
  }
}

function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.setProperty('--vvh', window.innerHeight + 'px');
    root.style.setProperty('--glassh', Math.max(window.innerHeight, installedGlass()) + 'px');
    return;
  }
  const apply = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--vvh', vv.height + 'px');
    root.style.setProperty('--kb', kb + 'px');
    root.style.setProperty('--glassh', Math.max(vv.height, window.innerHeight, installedGlass()) + 'px');
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
