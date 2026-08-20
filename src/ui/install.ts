// WHAT THE BROWSER WILL TELL US ABOUT BEING INSTALLED, and nothing else.
//
// This is the platform half of the old InstallNudge, MOVED rather than copied.
// The card is gone (the first-open flow in Onboarding.tsx asks the same two
// questions in one place, and asking twice about one thing is the bug we were
// avoiding), but its trigger logic was the part that had been debugged against
// real phones and there was no reason for it to die with the card:
//
//   the standalone check     is Clapper already installed
//   the iOS-Safari check     is the Share-sheet route the one to describe
//   the beforeinstallprompt  has Chromium decided we qualify, and can we fire
//   gate                     its own install prompt
//
// TWO THINGS CHANGED IN THE MOVE.
//
// THE PROMPT EVENT IS CAUGHT AT MODULE SCOPE, not inside a component effect.
// `beforeinstallprompt` fires once, early, and it does not replay for a
// listener that arrives late — so a component that only starts listening when
// it mounts is racing the browser and losing on any load where React is not
// first. Catching it here, at import, means the answer is already sitting in a
// variable by the time anything asks. A tiny pub-sub (the shape haptics.ts and
// theme.ts already use) wakes whatever is on screen when it lands.
//
// BEST-EFFORT THROUGHOUT. Every read is guarded and every failure resolves to
// the quiet answer — "we cannot tell, so do not claim anything". Nothing in
// this file is allowed to take the app down; the worst outcome permitted is
// that an install ask does not appear.

import { useEffect, useState } from 'react';

/**
 * Once-ever dismissal of the INSTALL ask. Deliberately still the nudge's key.
 * Someone who already closed that card has already answered this question, and
 * a new component is not a licence to ask it again.
 */
export const INSTALL_DISMISS_KEY = 'clapper.installNudgeDismissed';

// `beforeinstallprompt` is a real, widely-shipped (Chromium) event, but it's
// non-standard and TypeScript's lib.dom doesn't type it.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Same standalone-display check `analytics.ts::trackAppOpen` uses. */
export function isStandalone(): boolean {
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
export function isIosSafari(): boolean {
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

export function isInstallDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function markInstallDismissed(): void {
  try {
    localStorage.setItem(INSTALL_DISMISS_KEY, '1');
  } catch {
    /* private mode / storage blocked: the ask may just come back next load */
  }
}

// ------------------------------------------------- the deferred prompt -----

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

try {
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      try {
        // Preventing the default is what keeps Chromium's own mini-infobar off
        // the screen, so the ask happens where we designed it and not in two
        // places at once. It also hands us the event to fire later.
        e.preventDefault();
        deferred = e as BeforeInstallPromptEvent;
        emit();
      } catch {
        /* best-effort */
      }
    });
    // A successful install invalidates the event and answers the question for
    // good, so stop offering a button that would now do nothing.
    window.addEventListener('appinstalled', () => {
      deferred = null;
      markInstallDismissed();
      emit();
    });
  }
} catch {
  /* no window, or a browser that refuses the listener: no prompt, no crash */
}

/** True when Chromium has decided we qualify AND handed us its prompt. */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

/**
 * React hook: whether a native install prompt is available RIGHT NOW. Re-renders
 * when the event lands, which is the whole reason this is a hook and not a call
 * — the event routinely arrives after first paint.
 */
export function useCanPromptInstall(): boolean {
  const [can, setCan] = useState(canPromptInstall);
  useEffect(() => {
    const fn = () => setCan(canPromptInstall());
    listeners.add(fn);
    // The event can land between the initial state and this effect running.
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return can;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * Fire the browser's own install prompt. Never throws: a prompt that fails is
 * reported as 'unavailable', which is what the caller would do with a throw
 * anyway. The event is single-use, so it is dropped either way.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = deferred;
  if (!event) return 'unavailable';
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  } finally {
    deferred = null;
    emit();
  }
}
