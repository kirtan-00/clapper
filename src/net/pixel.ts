// Meta Pixel bridge. The base snippet lives in the app shell's <head> (owned
// elsewhere); this module only decides WHICH of our own analytics events are
// worth mirroring to Meta, and with what — if any — parameters.
//
// Everything here is best-effort and silent. The pixel is an ad-attribution
// nicety; a blocked script, a dev build, or a malformed payload must never
// cost someone a take on set. Same contract as analytics.ts: NEVER throws.

/** The only two fbq verbs we use: standard events, and our own custom ones. */
type PixelMethod = 'track' | 'trackCustom';

/**
 * Parameters we are willing to hand Meta. Deliberately narrow — scalars only,
 * so nothing structured (a project object, a parsed shotlist) can slip through
 * by accident.
 */
type PixelParams = Record<string, string | number>;

interface Fbq {
  (method: PixelMethod, eventName: string, params?: PixelParams): void;
}

declare global {
  interface Window {
    fbq?: Fbq;
    /** Set by the base snippet. Absent, or the unreplaced token, in dev builds. */
    __CLAPPER_PIXEL_ID__?: string;
  }
}

// The build substitutes a real id for `__META_PIXEL_ID__` in the shell. We
// compare against that token so local/dev builds stay silent instead of
// reporting conversions against a literal placeholder.
//
// Split on purpose: if the id substitution is ever a blind text pass over build
// OUTPUT rather than an edit of the HTML source, a whole spelling of the token
// sitting in this bundle would be rewritten too — the guard would quietly
// become `id === id`, and every conversion would stop firing in production
// only, where nobody would notice. Concatenation survives that.
const UNREPLACED_ID = '__META_PIXEL' + '_ID__';

/**
 * How our event names map onto Meta's vocabulary.
 *
 * Standard events only where the semantics genuinely line up — a wrong standard
 * event teaches Meta's optimiser the wrong thing, which is worse than a custom
 * event it treats as opaque. Anything absent from this table is intentionally
 * not sent: `error`/`persist` are diagnostics, `cap_hit`/`cut`/`install_nudge`/
 * `project_restored` are in-app noise, and `app_open` would double-count the
 * base snippet's automatic PageView.
 */
const EVENT_MAP: Record<string, { method: PixelMethod; event: string }> = {
  // The primary conversion: someone actually started a production in Clapper.
  project_created: { method: 'track', event: 'Lead' },
  // The real value moment — they got a file out of the app and into an edit.
  export: { method: 'track', event: 'CompleteRegistration' },
  pro_interest: { method: 'track', event: 'InitiateCheckout' },
  shotlist_parsed: { method: 'trackCustom', event: 'ShotlistParsed' },
  roll: { method: 'trackCustom', event: 'Roll' },
  example_loaded: { method: 'trackCustom', event: 'ExampleLoaded' },
};

/**
 * Per-event parameter allowlist, checked by NAME and by VALUE.
 *
 * Our `events` table can hold whatever a call site passes; Meta gets almost
 * none of it. Nothing that names a person, a project, a file, a script, or a
 * user id ever leaves — those are the fields most likely to churn as the app
 * changes, and an ad platform is the last place you want a client's unreleased
 * project title showing up.
 *
 * So each entry validates the value too, not just the key. `format` is matched
 * against the closed set of export kinds rather than "any short string", so a
 * future call site that passes a filename through the same key is dropped
 * instead of forwarded. Counts must be finite non-negative numbers. Everything
 * else, including every prop on the primary `Lead` conversion, is omitted —
 * when in doubt, send no props.
 */
const EXPORT_FORMATS = new Set(['premiere', 'resolve', 'csv']);

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function allowedParams(name: string, props?: Record<string, unknown>): PixelParams | undefined {
  if (!props) return undefined;

  if (name === 'export') {
    const format = props.format;
    if (typeof format === 'string' && EXPORT_FORMATS.has(format)) {
      return { format };
    }
    return undefined;
  }

  if (name === 'shotlist_parsed') {
    const out: PixelParams = {};
    const scenes = safeCount(props.scenes);
    const shots = safeCount(props.shots);
    if (scenes !== null) out.scenes = scenes;
    if (shots !== null) out.shots = shots;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return undefined;
}

/**
 * Mirror one analytics event to the Meta Pixel. A no-op when the pixel isn't
 * there (ad blocker, offline, script never loaded), when the id is missing or
 * still the build placeholder, or when the event isn't one we've chosen to
 * send. Swallows every error.
 */
export function pixel(name: string, props?: Record<string, unknown>): void {
  try {
    if (typeof window === 'undefined') return;

    const fbq = window.fbq;
    if (typeof fbq !== 'function') return;

    const id = window.__CLAPPER_PIXEL_ID__;
    if (!id || id === UNREPLACED_ID) return;

    const mapped = EVENT_MAP[name];
    if (!mapped) return;

    const params = allowedParams(name, props);
    if (params) {
      fbq(mapped.method, mapped.event, params);
    } else {
      fbq(mapped.method, mapped.event);
    }
  } catch {
    /* the pixel is decoration; never surface, never throw */
  }
}
