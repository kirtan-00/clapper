// Best-effort persistent-storage request. iOS Safari (and other browsers under
// storage pressure) can silently EVICT a web app's IndexedDB after ~7 days of
// non-use, wiping local shot logs — Clapper's entire offline core. The Storage
// Manager API lets a page ask the browser to exempt its origin from that
// eviction policy. Support is spotty (no iOS Safari support as of writing,
// Chrome/Android grants it heuristically), so this is defense in depth, not a
// guarantee — the real backstop is `InstallNudge` steering users to an
// installed PWA, which iOS already exempts from the 7-day wipe.
//
// NEVER throws. No-ops wherever `navigator.storage` (or its methods) don't
// exist, so this is safe to call unconditionally at boot on any browser.

import { track } from './analytics';

/**
 * Thin, safe wrapper over `navigator.storage.persisted()`. Resolves `false`
 * (rather than rejecting) whenever the API is missing or the call throws.
 */
export async function isPersisted(): Promise<boolean> {
  try {
    if (!navigator.storage || typeof navigator.storage.persisted !== 'function') {
      return false;
    }
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Request durable ("persistent") storage so the browser won't evict Clapper's
 * IndexedDB under storage pressure. Call once at boot. Best-effort:
 *  - no-ops silently if the Storage Manager API isn't available at all
 *  - no-ops (skips the request) if persistence is already granted
 *  - never throws, whatever the browser does
 * Logs the outcome via analytics so we can see real-world grant rates across
 * devices — `already` distinguishes "was already persisted" from "we asked
 * just now", and `granted` is the resulting persisted state either way.
 */
export function initPersist(): void {
  void (async () => {
    try {
      if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
        return; // API unsupported on this browser (e.g. iOS Safari today) — nothing to do
      }

      const already = await isPersisted();
      if (already) {
        track('persist', { granted: true, already: true });
        return;
      }

      const granted = await navigator.storage.persist();
      track('persist', { granted, already: false });
    } catch {
      /* storage persistence is best-effort; never surface or block boot */
    }
  })();
}
