// A FLOOR UNDER `safe-area-inset-bottom`, because on iOS that inset is not a
// property of the device, it is a property of the moment.
//
// EXTRACTED FROM main.tsx (was `trackSafeBottomFloor()`, called once at boot)
// because a boot-only latch turned out not to be enough. THE ACTUAL BUG THIS
// FILE FIXES, found chasing the owner's four-screenshot report (Home/Projects
// centre ~1719, Account ~1780, Settings ~1830 - the tray sitting LOWER, not
// higher, on the two screens with focusable inputs):
//
// A high-water mark can only ever hold the tray UP. It cannot explain a tray
// that DROPS within one session on a phone that never rotated - `resettle()`
// (below) is the only thing that ever lowers `floor`, and it only runs on an
// orientation flip. So a dropping tray means the floor was never carrying a
// correct number in the first place on those two routes: it was latching 0,
// not 34, and `max(live, floor)` in skin/shell.css and styles.css then had
// nothing to fall back on when `live` (the raw `env()` reading) was ALSO bad
// at that exact instant - which iOS's own documented behaviour (inset drops
// to zero around a keyboard, restored on some unstated schedule) makes likely
// to happen right as someone taps into a field on Account or Settings.
//
// THE FIX IS NOT A BIGGER OR SMARTER MAX(). It is giving the floor far more
// chances to have already caught the correct number BEFORE a screen with an
// input ever renders, so it is not depending on a lucky reading at the exact
// moment a keyboard is opening. Boot-only latching left long gaps - open the
// app, sit on Home doing nothing, tap into Account - where the only events
// that ever call `latch()` are `resize`, `orientationchange` and a
// keyboard's own `visualViewport` resize, none of which necessarily fire
// between boot and that first tap. `bumpSafeBottomFloor()` is exported so
// AppShell.tsx can call it on every route change too - a tab switch is a
// cheap, frequent, always-safe moment to force one more `getComputedStyle`
// read (which is a synchronous style flush: it cannot return a value more
// stale than "right now", unlike a `.mnav` padding value derived once at some
// earlier paint and never re-painted because nothing since has forced a
// reflow). By the time the owner reaches Settings, the floor has had a
// latching opportunity on every tab he crossed to get there, not just
// whatever fired near boot.
//
// This is deliberately a MODULE, not still a function inside main.tsx: the
// old shape had no way for anything outside main.tsx to trigger a fresh
// latch, and AppShell.tsx (which owns route changes) cannot import from
// main.tsx without a cycle (main.tsx -> App.tsx -> AppShell.tsx -> main.tsx).
// A third file both sides import breaks that.

let floor = 0;
let started = false;

function readInset(): number {
  // `--safe-bottom` is `env(safe-area-inset-bottom, 0px)`, substituted at
  // computed-value time, so this reads the resolved pixels. An engine that
  // hands back the unresolved function instead yields NaN here, which floors
  // at 0 and makes the max in the consumers a no-op - the failure mode is
  // "behaves exactly as it did before", never a wrong number.
  const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'));
  return Number.isFinite(px) && px > 0 ? px : 0;
}

function publish(): void {
  document.documentElement.style.setProperty('--safe-bottom-floor', floor + 'px');
}

/**
 * Force one fresh reading and raise the mark if it is higher. Safe to call
 * as often as anyone likes - `getComputedStyle` forces a synchronous style
 * recalculation, so this can never be answering an older question than the
 * one asked right now, and the `Math.max` means a bad reading (mid-keyboard,
 * pre-layout, whatever) can only ever no-op, never lower the mark. Exported
 * so AppShell.tsx can call it on every route change - see the file header.
 */
export function bumpSafeBottomFloor(): void {
  floor = Math.max(floor, readInset());
  publish();
}

/**
 * Call once, at boot. Wires the three events that can legitimately move the
 * inset (rotation, a resize that is not a rotation, and the keyboard) on top
 * of the route-change latching AppShell does. THE MARK IS DROPPED WHEN THE
 * ORIENTATION FLIPS, and it is dropped LATE, not on the flip event.
 * Landscape's home indicator is a genuinely different inset (21pt against
 * portrait's 34 on the same phone), so carrying the portrait number across
 * would hold the tray up on nothing - a stuck-high tray is the same defect as
 * a dropped one. Measured in the harness: resetting on the resize event alone
 * does NOT work, because that event fires while the old inset is still being
 * reported and the mark simply re-latches the stale number (the check
 * printed "STUCK: landscape kept portrait floor 44px"). So the flip clears
 * the mark and re-reads once the rotation has settled (350ms then 900ms:
 * iOS's rotation settles inside the first and the second is the net under
 * it), and that re-read ASSIGNS rather than maximises - it has to be able to
 * go down.
 */
export function initSafeBottomFloor(): void {
  if (started) return;
  started = true;

  let wide = window.innerWidth > window.innerHeight;

  const resettle = () => {
    floor = 0;
    publish();
    window.setTimeout(() => {
      floor = readInset();
      publish();
    }, 350);
    window.setTimeout(bumpSafeBottomFloor, 900);
  };

  const onResize = () => {
    const nowWide = window.innerWidth > window.innerHeight;
    if (nowWide !== wide) {
      wide = nowWide;
      resettle();
      return;
    }
    bumpSafeBottomFloor();
  };

  bumpSafeBottomFloor();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  // The keyboard is a visual-viewport event, never a window resize on iOS, and
  // it is the moment the inset is most likely to read zero. Bump, never
  // resettle: the orientation has not changed.
  window.visualViewport?.addEventListener('resize', bumpSafeBottomFloor);
}
