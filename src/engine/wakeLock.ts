import { useEffect, useRef } from 'react';

/**
 * Holds a screen wake lock while `active` is true.
 * - Re-acquires on visibilitychange when the document becomes visible again
 *   (the browser auto-releases the lock when the page is hidden).
 * - Releases on !active and on unmount.
 * - Silently no-ops where the Wake Lock API is unsupported or denied.
 */
export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
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
  }, [active]);
}
