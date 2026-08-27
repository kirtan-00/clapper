import type { StudioLogo } from '../types';

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
// THE LOGO (shipped): a studio logo lives next to `studio` in this same
// record, stored as a resized data URI, drawn in place of the Clapper mark on
// the PDF cover (see drawMark/drawLogo in export/pdf.ts) and in place of the
// masthead in-app (see ScreenMark in ui/glist.tsx). Same local-only posture as
// the rest of this file, for the same three reasons above - and the same cost:
// backup.ts does not carry it either, so a restored project's PDFs go back to
// the Clapper mark until the logo is re-uploaded on the new phone.
//
// THE GATE IS SOFT, and deliberately so - there is nowhere on this
// architecture for it to be anything else. `logoEligible` below is a CLIENT-
// SIDE read of the caller's own cached entitlements, used to decide whether to
// SHOW the upload control and whether to ATTACH the stored logo to an export.
// It is not enforcement: this is a static site, the value lives in this
// user's own browser storage, and nothing stops someone with a debugger open
// from calling `setStudioLogo` directly or editing `subscriptionProduct` in
// memory. The single thing that is genuinely server-enforced on a PDF export
// is the project-unlock check `gateExport` makes (see net/quota.ts and
// ProjectScreen.tsx) - that gate decides whether the export happens at all.
// Whether the export that DOES happen carries a subscriber's own logo instead
// of Clapper's is not something any request on this stack asks a server
// about. Shipping the honest version of that: gated in the UI, not gated in
// truth, rather than pretending a client-side check is a wall.

const STUDIO_KEY = 'clapper.studio.v1';

export interface StudioIdentity {
  /** The person. Prefilled from Google, never printed on an export. */
  name: string;
  /** The production house. THIS is what the exports carry. */
  studio: string;
  /** Studio Plus only. Absent below that plan and for every account that has
   *  not uploaded one - see `logoEligible` for the (soft) gate. */
  logo?: StudioLogo;
}

const EMPTY: StudioIdentity = { name: '', studio: '' };

/**
 * Longest side a stored logo may measure, in CSS pixels. 320.
 *
 * WHY 320: the PDF cover draws it inside roughly a 46pt-tall, up to ~130pt-
 * wide box (see MARK/LOGO_MAX_W in export/pdf.ts). At a generous 300dpi print
 * resolution that box tops out around 540px on its long side, but a phone
 * screen and a printed call sheet are not held under a loupe - 320px already
 * oversamples the in-app masthead (never taller than ~28px, even at 3x
 * device pixel ratio) and reads perfectly crisp on paper at normal reading
 * distance. The number that actually matters here is the OTHER end: an
 * untouched phone photo is 3000-4000px on its long side and 3-8MB, and
 * dropped straight into localStorage it can blow that origin's entire quota
 * (shared with theme, onboarding and every other small key this app keeps
 * there) and take the whole identity module down with it - see the header
 * above. Resized to 320px and re-encoded, even a busy logo lands at a few
 * hundred KB at the worst, comfortably inside that shared budget.
 */
export const MAX_LOGO_DIM = 320;

/**
 * pdf-lib embeds PNG and JPEG only (`PDFDocument.embedPng` / `embedJpg` - see
 * export/pdf.ts). Anything else is refused here, before it is ever decoded,
 * and the file picker's own `accept` attribute says the same thing - decoding
 * an unsupported format just to throw it away at export time would be a
 * worse failure than refusing it up front.
 */
export const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg'] as const;

export function isAcceptedLogoType(type: string): boolean {
  return (ACCEPTED_LOGO_TYPES as readonly string[]).includes(type);
}

/**
 * Scale (srcW, srcH) down to fit inside `cap` on its LONGER side, aspect
 * preserved, NEVER upscaled - a small logo stores at exactly its own size.
 * Degenerate input (zero or negative) resolves to {0,0} rather than NaN or a
 * divide-by-zero, so a corrupt image's dimensions cannot poison a caller that
 * forgets to check first.
 *
 * Pure and DOM-free on purpose: this is the one piece of the resize pipeline
 * that has to be unit-testable without a canvas, because it is the piece that
 * actually enforces MAX_LOGO_DIM.
 */
export function fitWithinCap(
  srcW: number,
  srcH: number,
  cap: number = MAX_LOGO_DIM,
): { width: number; height: number } {
  if (!(srcW > 0) || !(srcH > 0)) return { width: 0, height: 0 };
  const longest = Math.max(srcW, srcH);
  if (longest <= cap) return { width: Math.round(srcW), height: Math.round(srcH) };
  const scale = cap / longest;
  return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) };
}

/**
 * Decode `file`, resize it to fit MAX_LOGO_DIM and re-encode as PNG - ready
 * to hand to `setStudioLogo`. Always re-encodes to PNG regardless of the
 * source format: pdf-lib only embeds PNG and JPEG, and PNG stays lossless for
 * the flat colour and sharp edges most logos are made of, at a size the
 * dimension cap above already keeps small.
 *
 * REJECTS (never throws synchronously) rather than returning a fallback
 * value, because the caller - the upload control - is the only place that
 * knows how to tell a human "that didn't work"; this function's job is only
 * to fail cleanly, not to guess what to show. Every rejection reason:
 *   - a MIME type outside ACCEPTED_LOGO_TYPES (checked before any decoding)
 *   - no `document`/`Image` (a DOM-less environment - this module's own test
 *     suite included, see studio.test.ts)
 *   - the browser refusing to decode the bytes as an image
 *   - a canvas this browser refuses to read back (some in-app WebViews block
 *     canvas readback for privacy)
 * A caller anywhere in this codebase treats every one of these identically:
 * the same as "no logo" - see StudioLogoRow.tsx.
 */
export async function resizeLogoFile(file: File): Promise<StudioLogo> {
  if (!isAcceptedLogoType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || 'unknown'}`);
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('Image resizing requires a browser environment');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image'));
      el.src = objectUrl;
    });

    const { width, height } = fitWithinCap(img.naturalWidth, img.naturalHeight);
    if (!width || !height) throw new Error('Image has no size');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, width, height);

    return { dataUri: canvas.toDataURL('image/png'), width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * The (soft) gate itself - see the header above for why it can only ever be
 * this soft. `null` is "signed out" or "the entitlements read has not
 * settled/failed", both of which mean the same thing here: no confirmed
 * Studio Plus, no logo. One function so the upload row, the in-app masthead
 * and the PDF export call site all agree on the same rule instead of each
 * spelling it out.
 */
export function logoEligible(entitlements: { subscriptionActive: boolean; subscriptionProduct: string | null } | null): boolean {
  return !!entitlements && entitlements.subscriptionActive && entitlements.subscriptionProduct === 'studio_plus';
}

/** Trim and cap. A studio name is a masthead line, not a paragraph: 80 chars
 *  is wider than the PDF cover can set at 9.5pt and wider than any real
 *  company name, and it stops a hand-edited value from running off the page. */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 80) : '';
}

/**
 * Guard on a stored `logo` field the same way `clean` guards name/studio: a
 * hand-edited or half-written value degrades to ABSENT rather than reaching
 * pdf.ts as something that looks like a StudioLogo but is not one. Checks the
 * data URI's own prefix against ACCEPTED_LOGO_TYPES rather than trusting a
 * `type` field that does not exist on this shape - the URI IS the type.
 */
function cleanLogo(v: unknown): StudioLogo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const dataUri = typeof rec.dataUri === 'string' ? rec.dataUri : '';
  const width = typeof rec.width === 'number' && rec.width > 0 ? rec.width : 0;
  const height = typeof rec.height === 'number' && rec.height > 0 ? rec.height : 0;
  const okType = ACCEPTED_LOGO_TYPES.some((t) => dataUri.startsWith(`data:${t}`));
  if (!okType || !width || !height) return undefined;
  return { dataUri, width, height };
}

/**
 * Read the stored identity. Never throws and never returns undefined fields:
 * every caller can treat the result as two strings, one of which may be empty,
 * plus an optional logo. A hand-edited or half-written value degrades to
 * blank (or to no logo) rather than reaching the PDF writer as a number, an
 * object, or an image that is not really an image.
 */
export function getStudio(): StudioIdentity {
  try {
    const raw = localStorage.getItem(STUDIO_KEY);
    if (!raw) return { ...EMPTY };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const rec = parsed as Record<string, unknown>;
    const logo = cleanLogo(rec.logo);
    return { name: clean(rec.name), studio: clean(rec.studio), ...(logo ? { logo } : {}) };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Persist name + studio. Storage being full or blocked must not break the
 * sheet that calls this: the identity is a nicety, the shoot is not.
 *
 * READS BEFORE IT WRITES, and carries the CURRENT logo forward untouched.
 * This function's caller is StudioSheet, which only ever knows about name and
 * studio - it has no logo field to pass and never will (see StudioLogoRow.tsx
 * for the only place a logo is actually set). A naive
 * `JSON.stringify({name, studio})` here would silently erase a saved logo
 * every single time someone edited their production house name. `next` is
 * typed loosely (not `StudioIdentity`) specifically so it CANNOT carry a
 * `logo` field by accident - the only way to change the logo is
 * `setStudioLogo`, below.
 */
export function setStudio(next: { name: string; studio: string }): void {
  try {
    const current = getStudio();
    localStorage.setItem(
      STUDIO_KEY,
      JSON.stringify({
        name: clean(next.name),
        studio: clean(next.studio),
        ...(current.logo ? { logo: current.logo } : {}),
      }),
    );
  } catch {
    // Private mode, quota, disabled storage. The value is lost, nothing else is.
  }
}

/**
 * Set (or clear, with `null`) the logo, leaving name/studio exactly as they
 * are. The mirror image of `setStudio`'s own read-modify-write: this is the
 * ONLY function that touches the `logo` field, so the upload row never has to
 * reason about the name/studio half of the record at all.
 *
 * A quota failure here (the resized image still did not fit) is caught the
 * same way every other write in this file is - the caller re-reads
 * `getStudio()` afterward and shows whatever storage actually holds, rather
 * than trusting the value it just tried to write.
 */
export function setStudioLogo(logo: StudioLogo | null): void {
  try {
    const current = getStudio();
    localStorage.setItem(
      STUDIO_KEY,
      JSON.stringify({
        name: current.name,
        studio: current.studio,
        ...(logo ? { logo } : {}),
      }),
    );
  } catch {
    // Same posture as setStudio: the logo is lost, nothing else is.
  }
}

/** Is there a logo to actually draw? */
export function hasLogo(): boolean {
  return getStudio().logo !== undefined;
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
