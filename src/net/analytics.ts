// Fire-and-forget product analytics. Inserts into the `events` table via the
// anon/authenticated client (RLS lets anon insert null-user rows, and lets a
// signed-in user insert rows tagged with their own id). NEVER throws — a failed
// insert must not break any user action.

import { supabase } from './supabase';

/**
 * Record an analytics event. Attaches the current user's id when signed in,
 * otherwise inserts a null-user row. Uses `return=minimal` (no `.select()`) so
 * the client never needs read access to `events`. Swallows every error.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user.id ?? null;
      await supabase
        .from('events')
        .insert({ name, props: props ?? {}, user_id: userId });
    } catch {
      /* analytics is best-effort; never surface */
    }
  })();
}

let appOpenFired = false;

/**
 * Fire the `app_open` event once per page load, capturing the `?ref=` acquisition
 * source and whether we're running as an installed PWA (standalone display mode).
 */
export function trackAppOpen(): void {
  if (appOpenFired) return;
  appOpenFired = true;

  let ref: string | null = null;
  try {
    ref = new URLSearchParams(window.location.search).get('ref');
  } catch {
    ref = null;
  }

  const standalone =
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    // iOS Safari legacy flag
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;

  track('app_open', { ref, standalone });
}
