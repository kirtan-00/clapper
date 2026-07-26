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

// Keep inserted error payloads small. `events.props` is JSON — an uncaught
// exception with a deep object attached (or a huge minified stack) shouldn't
// blow up the row. This is a generous ceiling, not a design target.
const MAX_STACK_CHARS = 2000;
const MAX_MESSAGE_CHARS = 500;

/**
 * Normalize an Error/unknown thrown value into a small, JSON-safe shape:
 * `{ message, stack, name }`. Handles the non-Error throw case (strings,
 * plain objects, etc.) without ever throwing itself. Stack/message are
 * truncated so a single event can't balloon in size.
 */
function normalizeError(err: unknown): { message: string; stack: string | null; name: string } {
  try {
    if (err instanceof Error) {
      return {
        name: err.name || 'Error',
        message: String(err.message ?? '').slice(0, MAX_MESSAGE_CHARS),
        stack: typeof err.stack === 'string' ? err.stack.slice(0, MAX_STACK_CHARS) : null,
      };
    }
    // Non-Error throw (string, number, plain object, etc.) — best-effort stringify.
    if (typeof err === 'string') {
      return { name: 'Error', message: err.slice(0, MAX_MESSAGE_CHARS), stack: null };
    }
    return {
      name: 'Error',
      message: JSON.stringify(err ?? null).slice(0, MAX_MESSAGE_CHARS),
      stack: null,
    };
  } catch {
    // Even stringifying failed (e.g. circular object) — fall back to a fixed label.
    return { name: 'Error', message: 'Unserializable error value', stack: null };
  }
}

/**
 * Record a crash/error event via the same best-effort `events` pipe as
 * `track()`. Never throws. `context` is optional caller-supplied metadata
 * (e.g. `{ boundary: 'RollingScreen' }`) — keep it free of PII; only the raw
 * error text itself is captured beyond that.
 */
export function trackError(err: unknown, context?: Record<string, unknown>): void {
  try {
    const { message, stack, name } = normalizeError(err);
    track('error', { message, stack, name, ...(context ?? {}) });
  } catch {
    /* error telemetry is best-effort; never surface, never throw */
  }
}
