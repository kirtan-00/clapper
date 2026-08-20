// A small, dismissible, non-nagging nudge toward installing Clapper as a home
// screen app. The pitch is SAFETY, not features: an installed PWA is exempt
// from iOS Safari's ~7-day IndexedDB eviction that can silently wipe a shot
// log (see src/net/persist.ts). Shown at most once — dismissal (or a
// successful/declined install) is remembered in localStorage for good.
//
// Best-effort throughout: any failure here degrades to "nudge doesn't show",
// never to a broken app.
//
// ---------------------------------------------------------------------------
// THE REPAINT (round 3, §03). "This phone only" is the one status in the app
// that earns a card rather than a pill, and this is that card. Two things
// changed and the TRIGGER LOGIC DID NOT — the same standalone check, the same
// iOS-Safari detection, the same `beforeinstallprompt` gate, the same
// once-ever dismissal:
//
//   THE NUMBER IS REAL. "41 takes live in this browser and nowhere else" is a
//   sentence somebody acts on; "your data could be lost" is one they have read
//   a hundred times and stopped seeing. The count is read once, only after the
//   nudge has already decided it is showing, so nothing is spent on the far
//   more common path where it never appears. If the read fails the card simply
//   says it without a number rather than inventing one.
//
//   IT OFFERS BOTH DOORS. Installing exempts the origin from eviction; signing
//   in backs the log up off the phone entirely. They fix the same problem at
//   different depths, so a card about that problem shows both — and SIGN IN
//   only while signed out, because to someone already signed in it is noise.

import { useEffect, useState } from 'react';
import { track } from '../net/analytics';
import { store } from '../store';
import { useSession, signInWithGoogle } from '../net/auth';
import { CloseMark } from './marks';

const DISMISS_KEY = 'clapper.installNudgeDismissed';

// `beforeinstallprompt` is a real, widely-shipped (Chromium) event, but it's
// non-standard and TypeScript's lib.dom doesn't type it.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type Platform = 'ios' | 'android';

/** Same standalone-display check `analytics.ts::trackAppOpen` uses. */
function isStandalone(): boolean {
  try {
    return (
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/**
 * iOS + Safari specifically (not Chrome/Firefox/Edge-on-iOS — those are all
 * WebKit under the hood but tag their UA distinctly, and only Safari exposes
 * the Share-sheet "Add to Home Screen" action this copy points at).
 */
function isIosSafari(): boolean {
  try {
    const ua = window.navigator.userAgent;
    const isIos =
      /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports as "Macintosh" but is touch-capable; real Macs aren't.
      (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    if (!isIos) return false;
    return !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  } catch {
    return false;
  }
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode / storage blocked: nudge may just show again next load */
  }
}

/**
 * How many takes are on this phone. Walks projects -> scenes -> takes, which is
 * the only path the store offers for a whole-device count, and does it exactly
 * once per appearance of the card. Returns null rather than 0 on failure: zero
 * is a claim, and "no number" is the truth when the read did not happen.
 */
async function countTakes(): Promise<number | null> {
  try {
    const projects = await store.listProjects();
    const perProject = await Promise.all(
      projects.map(async (p) => {
        const slates = await store.listSlates(p.id);
        const perSlate = await Promise.all(slates.map((sl) => store.listTakes(sl.id)));
        return perSlate.reduce((n, list) => n + list.length, 0);
      }),
    );
    return perProject.reduce((n, c) => n + c, 0);
  } catch {
    return null;
  }
}

/** Tiny inline share-icon (box + up arrow) — avoids relying on a Unicode glyph. */
function ShareGlyph() {
  return (
    <svg
      className="installnudge__glyph"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M7.5 7.5 12 3l4.5 4.5" />
      <rect x="4" y="11" width="16" height="10" rx="2" />
    </svg>
  );
}

export default function InstallNudge() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [takes, setTakes] = useState<number | null>(null);
  const { session, loading } = useSession();

  useEffect(() => {
    try {
      // A seam for screenshots. DEV ONLY — `import.meta.env.DEV` is a
      // compile-time constant, so this block is dropped from the bundle, and
      // the shipped card still appears only when the browser says it can be
      // installed. Neither trigger fires in a headless run, and a state that
      // is never looked at is a state nobody designed.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__clapperInstallNudge = (p: Platform | null) =>
          setPlatform(p);
      }
      if (isStandalone() || isDismissed()) return;

      if (isIosSafari()) {
        setPlatform('ios');
        track('install_nudge', { platform: 'ios', action: 'shown' });
        return;
      }

      // Android/Chrome: rely on the browser's own installability signal
      // (fires only once it has decided the manifest + service worker
      // qualify) rather than guessing from UA.
      function onBeforeInstallPrompt(e: Event) {
        try {
          e.preventDefault();
          setDeferred(e as BeforeInstallPromptEvent);
          setPlatform('android');
          track('install_nudge', { platform: 'android', action: 'shown' });
        } catch {
          /* best-effort */
        }
      }

      window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    } catch {
      /* nudge is best-effort UI chrome; never block app boot */
    }
  }, []);

  // Counted only once the card has decided it is appearing, so the common path
  // (installed, or already dismissed) costs nothing at all.
  useEffect(() => {
    if (!platform) return;
    let alive = true;
    void countTakes().then((n) => {
      if (alive) setTakes(n);
    });
    return () => {
      alive = false;
    };
  }, [platform]);

  function onDismiss() {
    try {
      track('install_nudge', { platform: platform ?? 'unknown', action: 'dismiss' });
    } catch {
      /* best-effort */
    } finally {
      markDismissed();
      setPlatform(null);
      setDeferred(null);
    }
  }

  async function onInstallClick() {
    try {
      if (deferred) {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        track('install_nudge', {
          platform: 'android',
          action: choice.outcome === 'accepted' ? 'install_accepted' : 'install_declined',
        });
      }
    } catch {
      /* the native prompt failing must not break the app */
    } finally {
      markDismissed();
      setPlatform(null);
      setDeferred(null);
    }
  }

  if (!platform) return null;

  return (
    <div className="mnudge" role="status">
      <div className="mnudge__head">
        <span className="mnudge__cap">This phone only</span>
        <button
          type="button"
          className="mnudge__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <CloseMark />
        </button>
      </div>

      {/* The headline is the FACT, with the real number in it. No number until
          the count lands, and none at all if it failed - a card about not
          losing your work is the last place to round something off. */}
      <p className="mnudge__say">
        {takes === null
          ? 'Everything you have logged lives in this browser and nowhere else.'
          : `${takes} ${takes === 1 ? 'take lives' : 'takes live'} in this browser and nowhere else.`}
      </p>
      <p className="mnudge__note">
        A browser under storage pressure can clear a site's data after about a week unused.
        Installing exempts Clapper. Signing in backs the log up.
      </p>

      <div className="mnudge__acts">
        {platform === 'android' ? (
          <button type="button" className="mnudge__act" onClick={() => void onInstallClick()}>
            Install
          </button>
        ) : (
          // iOS has no programmatic install, so the "button" is the
          // instruction. Not a control - it is a static step, and dressing it
          // as a button would be a button that does nothing when pressed.
          <span className="mnudge__act mnudge__act--say">
            <ShareGlyph /> Share, then Add to Home Screen
          </span>
        )}
        {/* Only while signed out. To someone already signed in this is noise
            about a thing they have already done. */}
        {!loading && !session && (
          <button
            type="button"
            className="mnudge__act"
            onClick={() => {
              void signInWithGoogle().catch(() => {
                /* the redirect never started; the card stays as it was */
              });
            }}
          >
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}
