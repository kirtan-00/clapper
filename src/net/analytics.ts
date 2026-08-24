// Fire-and-forget product analytics. Inserts into the `events` table via the
// anon/authenticated client (RLS lets anon insert null-user rows, and lets a
// signed-in user insert rows tagged with their own id). NEVER throws — a failed
// insert must not break any user action.

import { supabase } from './supabase';
import { pixel } from './pixel';

/**
 * The hosts the real product is served from. Everything else - a dev server, a
 * LAN address on someone's phone, a preview build, an HTML file opened straight
 * off disk - is NOT the product and must not write to the product's numbers.
 */
// clapper.in is the canonical home as of 2026-08-24. clapboard.duckdns.org
// stays in this set on purpose and is NOT to be removed on a tidy-up pass:
// an installed PWA keeps whatever origin it was added from, so a phone that
// installed Clapper before the move goes on opening the old host for as long
// as that person keeps the icon. Dropping it here would not stop dev traffic
// (that is what this gate is for) - it would silently delete real users from
// our own numbers and make the move look like a crash. www is listed because
// the apex and www both resolve; whichever one someone lands on is live.
const LIVE_HOSTS = new Set([
  'clapper.in',
  'www.clapper.in',
  'clapboard.duckdns.org',
  'kirtan-00.github.io',
]);

/**
 * ANALYTICS FIRE FROM THE LIVE SITE AND NOWHERE ELSE.
 *
 * They did not, and it cost us the ability to read our own data. On
 * 2026-08-20, 452 of 465 `app_open` rows came from automated browser sessions
 * against a dev server; 18 Aug was 422 of 425, and 15 Aug 268 of 268. Roughly
 * 79 percent of every event ever recorded is development traffic. Ten
 * `landing_view` rows even carry a `file://` path, because opening the landing
 * page off disk to look at it fired a beacon at production.
 *
 * A number nobody trusts is worse than no number: you cannot tell a quiet week
 * from a busy one, and you cannot tell whether a change worked. The gate is a
 * hostname check rather than an env flag deliberately - a flag is a thing
 * somebody forgets to set, and the failure is silent and invisible for a month.
 */
function isLiveSite(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  // A file:// page has no meaningful hostname; it is somebody looking at a
  // build on their own disk.
  if (window.location.protocol === 'file:') return false;
  return LIVE_HOSTS.has(window.location.hostname);
}

/**
 * Record an analytics event. Attaches the current user's id when signed in,
 * otherwise inserts a null-user row. Uses `return=minimal` (no `.select()`) so
 * the client never needs read access to `events`. Swallows every error.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  // Off the live site this is a no-op, including the ad pixel: a dev session
  // must not appear in the product's numbers OR in Meta's attribution.
  if (!isLiveSite()) return;

  // Ad attribution rides along here rather than at each call site, so there's
  // exactly one list of what we send Meta and no way to forget it. It's
  // synchronous, silent, and can't throw, so the insert below is unaffected —
  // and it filters both the event names and the props itself (see pixel.ts).
  pixel(name, props);

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

// ============================================================================
// SCREEN TRACKING. What is on top right now, kept for two things: firing
// `screen_view` the moment it changes, and remembering it so a later
// `session_end` (below) can say where the person actually was.
//
// This is a plain module-level variable, not React state — AppShell already
// re-renders on every route change, so a second subscription mechanism here
// would just be a duplicate of information the router already has. The only
// thing missing from the router is "what was on screen right before the tab
// went away", which is exactly what this file is for.
// ============================================================================

let screen: string | null = null;

/** The screen currently on top, or `null` before the first navigation. */
export function currentScreen(): string | null {
  return screen;
}

/**
 * Record a screen change and fire `screen_view` for it. Call once per
 * distinct screen NAME — AppShell's route-change effect keys on `route.name`
 * rather than the route object, so replacing a project/shot in place (an
 * edit, not a navigation) never double-counts a view. HowToScreen calls this
 * too: it is a full-window overlay reached from Settings, not a nav route
 * (see AppShell.tsx's UNMOUNT-DO-NOT-HIDE comment), so nothing else would
 * ever record it.
 */
export function trackScreenView(name: string): void {
  screen = name;
  track('screen_view', { screen: name });
}

/**
 * Put the screen marker back WITHOUT firing an event. For an overlay like
 * HowToScreen: it is not a nav route, so AppShell's effect never runs again
 * when the overlay closes (`route.name` never changed underneath it) —
 * without this, a `session_end` fired minutes later would still say "how_to"
 * long after the guide was dismissed. This only ever affects what a LATER
 * session_end reports; it is not itself a measurement of anything.
 */
export function restoreScreen(name: string): void {
  screen = name;
}

// ============================================================================
// SESSION END. Answers "which screen was last seen before a session ends" —
// approximated as "which screen was showing the moment the tab went to the
// background", via the Page Visibility API rather than `beforeunload`/
// `pagehide`: on a phone, backgrounding (screen lock, app switch, a call
// coming in) is how almost every session actually ends, and visibilitychange
// fires reliably for that where unload-family events do not on mobile Safari.
//
// TRADE-OFF, on purpose: on set the phone locks between takes constantly, so
// one real sitting throws off several `session_end` rows, not one. This is
// fine for the question this answers ("what screen do people fall out on",
// a distribution) and WRONG for "how many sessions" — the dashboard must
// never total this as a session count. See its own comment for why.
//
// Also on purpose: a `track()` fired at hide-time is a normal fetch, not
// `navigator.sendBeacon`. If the OS kills the page before that fetch lands,
// the event is silently lost — same trade-off `roll`/`cut` already accept
// (this file has never used sendBeacon), and adding it here only would give
// this one event a reliability guarantee nothing else in the table has.
// ============================================================================

/**
 * Pure decision, split out so it is testable without a DOM: fire only on the
 * transition INTO hidden, and only once a screen has actually been recorded
 * (a tab backgrounded before the first navigation — e.g. a bot fetching the
 * page — has nothing meaningful to report).
 */
export function shouldFireSessionEnd(
  visibilityState: string,
  screenName: string | null,
): screenName is string {
  return visibilityState === 'hidden' && screenName !== null;
}

// Installed once, at module load, guarded so importing this file under a
// DOM-less test runner (this repo's vitest config has no jsdom — see
// vite.config.ts) never throws and never takes the rest of the suite down
// with it. Every branch inside is itself best-effort, same contract as the
// rest of this file.
try {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      try {
        if (shouldFireSessionEnd(document.visibilityState, screen)) {
          track('session_end', { screen });
        }
      } catch {
        /* best-effort; never surface, never throw */
      }
    });
  }
} catch {
  /* best-effort; never surface, never throw */
}
