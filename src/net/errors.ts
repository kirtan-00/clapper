// Global crash telemetry. Clapper runs on a phone on set with nobody watching
// a console — an uncaught exception is otherwise invisible. This wires the two
// window-level catch-alls (synchronous errors and unhandled promise
// rejections) to `trackError` so we at least see it happened.
//
// NEVER throws, and is idempotent — safe to call more than once (e.g. from a
// hot-reloading dev session) without double-registering listeners.

import { trackError } from './analytics';

let installed = false;

// Dedupe/debounce a storm: the same failing effect can throw hundreds of
// times a second (e.g. a broken render loop, a retry with no backoff). We
// bucket by message and only forward the first occurrence of a given message
// within a rolling window, so one storm produces one event instead of 500.
const STORM_WINDOW_MS = 10_000;
const seenMessages = new Map<string, number>();

function shouldForward(message: string): boolean {
  const now = Date.now();
  const last = seenMessages.get(message);
  if (last !== undefined && now - last < STORM_WINDOW_MS) {
    return false;
  }
  seenMessages.set(message, now);
  // Keep the dedupe map from growing unbounded over a long-running session.
  if (seenMessages.size > 200) {
    const cutoff = now - STORM_WINDOW_MS;
    for (const [key, ts] of seenMessages) {
      if (ts < cutoff) seenMessages.delete(key);
    }
  }
  return true;
}

function keyFor(err: unknown): string {
  try {
    if (err instanceof Error) return `${err.name}:${err.message}`.slice(0, 300);
    return String(err).slice(0, 300);
  } catch {
    return 'unknown';
  }
}

/**
 * Register `window.onerror` / `onunhandledrejection` handlers that route to
 * `trackError`. Call once at boot. Best-effort: if `window` isn't available
 * (non-browser context) or listener registration itself throws, this is a
 * silent no-op. Safe to call multiple times — only the first call installs
 * listeners.
 */
export function initErrorTracking(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;

  try {
    window.addEventListener('error', (event: ErrorEvent) => {
      try {
        // `event.error` is the thrown value when available (most cases); some
        // browsers omit it for cross-origin script errors, so fall back to
        // the message/location fields the event always carries.
        const err = event.error ?? event.message ?? 'window.onerror';
        const key = keyFor(err);
        if (!shouldForward(key)) return;
        trackError(err, {
          source: 'window.error',
          filename: event.filename || undefined,
          line: event.lineno || undefined,
          col: event.colno || undefined,
        });
      } catch {
        /* never let the handler itself throw */
      }
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      try {
        const err = event.reason ?? 'unhandledrejection';
        const key = keyFor(err);
        if (!shouldForward(key)) return;
        trackError(err, { source: 'unhandledrejection' });
      } catch {
        /* never let the handler itself throw */
      }
    });

    installed = true;
  } catch {
    /* crash telemetry is best-effort; a failure to install must not break boot */
  }
}
