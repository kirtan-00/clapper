import { useEffect, useRef, useSyncExternalStore } from 'react';

// The persisted half of "Keep screen awake, while a project is open" - same
// shape as theme.ts / haptics.ts, a tiny guarded pub-sub, default resolved on
// any failure. ON is the default: this app exists to be glanced at across a
// set without the phone dimming mid-scene, and an operator who never opens
// Settings should get exactly the behaviour this hook always had.
//
// Deliberately just a value, never painted to the DOM: unlike the theme or
// the interface size, nothing about this setting is visible before the hook
// itself decides whether to hold the lock, so there is no flash to prevent by
// stamping it early.

export const WAKELOCK_KEY = 'clapper.wakeLock';

function read(): boolean {
  try {
    const v = localStorage.getItem(WAKELOCK_KEY);
    return v === null ? true : v === '1'; // unset means never opened -> the shipped default
  } catch {
    return true;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(WAKELOCK_KEY, on ? '1' : '0');
  } catch {
    /* the toggle still works for this session, it just will not survive it */
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getWakeLockSetting(): boolean {
  return current;
}

export function subscribeWakeLockSetting(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setWakeLockSetting(on: boolean): void {
  if (on === current) return;
  current = on;
  write(on);
  for (const fn of listeners) fn();
}

/**
 * Holds a screen wake lock while `active` is true AND the operator has not
 * turned the setting off.
 * - Re-acquires on visibilitychange when the document becomes visible again
 *   (the browser auto-releases the lock when the page is hidden).
 * - Releases when either input goes false, and on unmount.
 * - Silently no-ops where the Wake Lock API is unsupported or denied.
 *
 * THE SETTING IS READ IN HERE, not passed in. RollingScreen calls
 * `useWakeLock(true)` - `active` is about WHETHER a project is open, the only
 * thing that call site actually knows - and the setting is a preference the
 * hook itself is responsible for honouring. Combining them here means the one
 * caller in the app never has to change, in either direction, if this setting
 * is ever removed or the call site grows a second one.
 */
export function useWakeLock(active: boolean): void {
  const settingOn = useSyncExternalStore(subscribeWakeLockSetting, getWakeLockSetting, () => true);
  const wantLock = active && settingOn;
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!wantLock) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let cancelled = false;

    const release = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel !== null) {
        sentinel.release().catch(() => {
          /* already released; ignore */
        });
      }
    };

    const request = async () => {
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          sentinel.release().catch(() => {
            /* ignore */
          });
          return;
        }
        release(); // drop any stale sentinel before storing the fresh one
        sentinelRef.current = sentinel;
      } catch {
        // Unsupported, denied, or page not visible: silently no-op.
      }
    };

    const onVisibilityChange = () => {
      if (!cancelled && document.visibilityState === 'visible') {
        void request();
      }
    };

    void request();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    };
  }, [wantLock]);
}
