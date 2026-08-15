// A small, dismissible, non-nagging nudge toward installing Clapper as a home
// screen app. The pitch is SAFETY, not features: an installed PWA is exempt
// from iOS Safari's ~7-day IndexedDB eviction that can silently wipe a shot
// log (see src/net/persist.ts). Shown at most once — dismissal (or a
// successful/declined install) is remembered in localStorage for good.
//
// Best-effort throughout: any failure here degrades to "nudge doesn't show",
// never to a broken app.

import { useEffect, useState } from 'react';
import { track } from '../net/analytics';
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

  useEffect(() => {
    try {
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
    <div className="installnudge" role="status">
      <div className="installnudge__body">
        <p className="installnudge__title">Keep your shot log safe</p>
        {/* One line, and on iOS it is an instruction rather than an
            explanation: the title above already says why. */}
        {platform === 'ios' ? (
          <p className="installnudge__msg">
            Tap <ShareGlyph /> <b>Share</b>, then <b>Add to Home Screen</b>.
          </p>
        ) : (
          <p className="installnudge__msg">Install it, and the browser cannot clear it.</p>
        )}
      </div>
      <div className="installnudge__actions">
        {platform === 'android' && (
          <button
            type="button"
            className="btn btn--go installnudge__install"
            onClick={() => void onInstallClick()}
          >
            Install
          </button>
        )}
        <button
          type="button"
          className="installnudge__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <CloseMark />
        </button>
      </div>
    </div>
  );
}
