// WHO IS SHOOTING THIS - the person's name and the production house they work
// for, asked once and then stamped onto every export.
//
// WHY THIS IS A LOCAL PREFERENCE AND NOT A COLUMN ON `profiles`, which is the
// obvious place to put it and the wrong one:
//
//   1. SignInSheet says "We only receive your email; your projects stay on
//      your device" and AccountScreen says "your email address and nothing
//      else". Both are TRUE while this lives in localStorage. The day this
//      syncs to Supabase, those two strings have to change in the same commit
//      or the app is lying on the screen where it asks for trust.
//   2. PDF export is free and works signed out, so the studio name has to be
//      readable with no session at all.
//   3. A server column needs a migration, and the migration queue is already
//      waiting on the owner. A feature that ships behind someone else's SQL
//      is a feature that has not shipped.
//
// THE COST, recorded here rather than discovered later: backup.ts serialises
// IndexedDB, not localStorage, so restoring onto a new phone brings every
// project across and NOT this. The prompt simply reappears and takes four
// seconds. Acceptable for v1; if it ever stops being acceptable, the fix is
// backup.ts, not a server table.
//
// FUTURE (enterprise): a studio logo lands next to `studio` - stored as a data
// URI, drawn in place of the Clapper mark on the PDF cover (see drawMark in
// export/pdf.ts) and in place of the masthead in-app. Deliberately NOT stubbed
// as an empty field today: a column nothing writes is a column everything has
// to defend against.

const STUDIO_KEY = 'clapper.studio.v1';

export interface StudioIdentity {
  /** The person. Prefilled from Google, never printed on an export. */
  name: string;
  /** The production house. THIS is what the exports carry. */
  studio: string;
}

const EMPTY: StudioIdentity = { name: '', studio: '' };

/** Trim and cap. A studio name is a masthead line, not a paragraph: 80 chars
 *  is wider than the PDF cover can set at 9.5pt and wider than any real
 *  company name, and it stops a hand-edited value from running off the page. */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 80) : '';
}

/**
 * Read the stored identity. Never throws and never returns undefined fields:
 * every caller can treat the result as two strings, one of which may be empty.
 * A hand-edited or half-written value degrades to blank rather than reaching
 * the PDF writer as a number or an object.
 */
export function getStudio(): StudioIdentity {
  try {
    const raw = localStorage.getItem(STUDIO_KEY);
    if (!raw) return { ...EMPTY };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const rec = parsed as Record<string, unknown>;
    return { name: clean(rec.name), studio: clean(rec.studio) };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist. Storage being full or blocked must not break the sheet that calls
 *  this: the identity is a nicety, the shoot is not. */
export function setStudio(next: StudioIdentity): void {
  try {
    localStorage.setItem(
      STUDIO_KEY,
      JSON.stringify({ name: clean(next.name), studio: clean(next.studio) }),
    );
  } catch {
    // Private mode, quota, disabled storage. The value is lost, nothing else is.
  }
}

/**
 * Has this device been asked yet? TRUE once anything has been written,
 * INCLUDING a skip that wrote two blanks - the prompt is one-time, and
 * "answered nothing" is an answer. Distinguishing the two is what
 * `hasStudio` is for.
 */
export function studioAsked(): boolean {
  try {
    return localStorage.getItem(STUDIO_KEY) !== null;
  } catch {
    // Storage unreadable: treat as asked, so a browser that cannot remember
    // the answer is not asked the same question on every single load.
    return true;
  }
}

/** Is there a production house name to actually print? */
export function hasStudio(): boolean {
  return getStudio().studio.length > 0;
}
