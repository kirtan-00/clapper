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

/**
 * A FLOOR UNDER `safe-area-inset-bottom`, because on iOS that inset is not a
 * property of the device, it is a property of the moment.
 *
 * The owner filmed the tab tray at two different heights on the same phone in
 * the same session a minute apart: Home floating clear of the bottom, Projects
 * sitting roughly a hundred device pixels lower and covering a project row.
 * The tray is ONE fixed element at the shell level with no route-dependent
 * rule anywhere in its chain, and Chrome measures it pixel-identical on Home,
 * on a short Projects list, on a long one, and on a long one scrolled to the
 * end, in both themes. So it is not the route and not the page flow.
 *
 * It is the inset. Measured in the harness by toggling nothing else: with
 * `--safe-bottom: 34px` the pod's top is 746 and it sits 44px off the bottom;
 * with `0px` it is 780 and sits 10px off. That 34pt delta is 102 device pixels
 * at 3x - "roughly a hundred", in the direction filmed - and 34pt is exactly
 * this phone's home-indicator inset. The chain applies it once, never twice.
 * What changed between his two screenshots was therefore the inset itself, and
 * iOS moves it: it drops to zero while the software keyboard is up and is
 * restored on its own schedule afterwards, which leaves a window where `--kb`
 * has already returned to 0 (that one is driven by a visualViewport resize and
 * lands immediately) and the tray is back on screen but 34pt too low.
 *
 * So the tray gets a high-water mark rather than the live reading: the largest
 * inset this orientation has reported. A transient zero cannot move furniture,
 * and on any device whose inset never moves this is exactly a no-op, because
 * the maximum of a constant is that constant.
 *
 * THE MARK IS DROPPED WHEN THE ORIENTATION FLIPS, and it is dropped LATE, not
 * on the flip event. Landscape's home indicator is a genuinely different inset
 * (21pt against portrait's 34 on the same phone), so carrying the portrait
 * number across would hold the tray up on nothing - a stuck-high tray is the
 * same defect as a dropped one. Measured in the harness: resetting on the
 * resize event alone does NOT work, because that event fires while the old
 * inset is still being reported and the mark simply re-latches the stale
 * number (the check printed "STUCK: landscape kept portrait floor 44px"). So
 * the flip clears the mark and re-reads once the rotation has settled, and
 * that re-read ASSIGNS rather than maximises - it has to be able to go down.
 *
 * Deliberately published as its own token and consumed only by the tray (see
 * `.mnav` in skin/shell.css): every other reader of `--safe-bottom` - the
 * rolling screen's own height among them - keeps the live value it was
 * measured against.
 */
function trackSafeBottomFloor() {
  const root = document.documentElement;
  let floor = 0;
  let wide = window.innerWidth > window.innerHeight;

  const readInset = (): number => {
    // `--safe-bottom` is `env(safe-area-inset-bottom, 0px)`, substituted at
    // computed-value time, so this reads the resolved pixels. An engine that
    // hands back the unresolved function instead yields NaN here, which floors
    // at 0 and makes the max in the sheet a no-op - the failure mode is
    // "behaves exactly as it did before", never a wrong number.
    const px = parseFloat(getComputedStyle(root).getPropertyValue('--safe-bottom'));
    return Number.isFinite(px) && px > 0 ? px : 0;
  };
  const publish = () => root.style.setProperty('--safe-bottom-floor', floor + 'px');

  const latch = () => {
    floor = Math.max(floor, readInset());
    publish();
  };

  // 350ms then 900ms: iOS's rotation settles inside the first and the second
  // is the net under it, in case the inset lands later than the geometry. Both
  // windows take the larger of what they find, so a keyboard that opens during
  // a rotation still cannot leave the mark at zero.
  const resettle = () => {
    floor = 0;
    publish();
    window.setTimeout(() => {
      floor = readInset();
      publish();
    }, 350);
    window.setTimeout(latch, 900);
  };

  const onResize = () => {
    const nowWide = window.innerWidth > window.innerHeight;
    if (nowWide !== wide) {
      wide = nowWide;
      resettle();
      return;
    }
    latch();
  };

  latch();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  // The keyboard is a visual-viewport event, never a window resize on iOS, and
  // it is the moment the inset is most likely to read zero. Latch, never
  // resettle: the orientation has not changed.
  window.visualViewport?.addEventListener('resize', latch);
}
trackSafeBottomFloor();

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
