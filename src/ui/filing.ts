// PROJECT FOLDERS — Clapper Studio Plus.
//
// A real filing system for the Projects list, kept entirely on the device and
// entirely OUT of the Project record. Originally built as a free feature
// (folders + the 30-day Archive); this file is that logic pulled out of
// ProjectsScreen.tsx and turned into the paid Studio Plus product: `Folder`
// create/rename/delete and folder MEMBERSHIP now need an entitlement (see
// `canManageFolders` below). Archive is untouched and stays free — it
// predates this work order, it is not a `Folder`, and nothing here asked for
// it to move tier.
//
// WHY NOT A FIELD ON `Project`. Which folder a shoot sits in is not a fact
// about the shoot — it is a fact about how one person likes their list. It
// never exports, never reaches a PDF, and two people looking at the same
// backup should be free to file it differently. Putting it in the store would
// also mean a schema migration and a write on every drag, which is a lot of
// machinery to move a card six inches.
//
// SYNC — DELIBERATELY DEVICE-LOCAL, not folded into the outbox. Spelled out
// because the brief for this feature explicitly asked "why not":
//   1. Every entity the sync engine actually moves (src/net/sync.ts,
//      src/store/outbox.ts's SYNC_TABLES) is a `projects` | `slates` |
//      `takes` | `moments` row with a matching Supabase table, an RLS
//      policy, and a migration that is CONFIRMED live. A `folders` table
//      would need all three, and this project's `schema_migrations` is
//      empty and unreliable (see feedback_supabase_untracked_migrations) —
//      there is no way to know from inside this codebase whether a
//      migration I write has actually been applied. Shipping sync code
//      against a table that might not exist yet is exactly the half-wired
//      state the brief forbids: it would push silently into a black hole on
//      some devices and work on others, and because sync swallows its own
//      errors (see sync.ts's header) nobody would ever see the failure.
//   2. A folder isn't owned by one project the way a dirty-mark or a
//      tombstone is (outbox.ts's `dirty` store is keyed by projectId) — it
//      is its own top-level entity with its own lifecycle, which the outbox
//      shape does not currently have a slot for at all.
//   3. Precedent: src/ui/studio.ts (the studio name/identity) made the same
//      call for the same reason and says so in its own header. This file
//      follows it.
// The honest cost, same as studio.ts's: a folder made on the phone does not
// appear on the tablet. If that ever stops being acceptable the fix is a
// `folders` Supabase table + migration + a fifth SYNC_TABLE, applied and
// confirmed live first — not a half-measure bolted on here.
//
// BACKUP/RESTORE — deliberately NOT carried. src/export/backup.ts serialises
// one project's IndexedDB bundle; src/store/restore.ts always mints a BRAND
// NEW project id on restore (see its own header: "every id in the incoming
// bundle is thrown away and reissued fresh") — a restored project is a new
// entity, on a device that may not even have the source folder any more.
// There is nothing to "carry across": `filed` is keyed by project id, a
// restored project's id was never in that map, and `placeOf` below already
// treats an absent (or dangling) key as unfiled — the safe, correct default,
// not a bug. This is not silent data loss: nothing that existed is deleted,
// the restored project simply starts where every never-filed project starts.
// See filing.test.ts's restore-shaped test for the pin.
//
// THE SOFT GATE, and no pretending otherwise: this is a static site with
// local-first data and no server that owns `folders` at all, so there is no
// request this code could make that a browser's devtools couldn't forge a
// "yes" to. `canManageFolders` below is a CLIENT-SIDE convenience gate, not
// enforcement — the same posture net/quota.ts's own header takes ("DISPLAY
// ONLY... nothing here is enforced"), except here there is no companion
// server check at all, because there is nothing server-side to check. The
// worst case of someone bypassing it is a free user organising their own
// projects into folders that never leave their own device — not a
// meaningfully exploitable outcome, which is the only reason a soft gate is
// an acceptable place to leave this rather than a reason to fake a hard one.
//
// LAPSED SUBSCRIPTION. `canManageFolders` is read fresh every render off
// live entitlements; `readFiling`/`placeOf` never consult it. That split is
// the whole guarantee: the moment a subscription lapses, the gate flips and
// every CONTROL (new folder, rename, delete, drag a project in or out) locks
// — but the folders and the `filed` map that already exist on disk are never
// touched by that flip, so the grouped view keeps rendering exactly as it
// did the day before. Nothing here ever deletes a folder or unfiles a
// project because an entitlement read came back false. See
// filing.test.ts's "survives a lapsed subscription" case.

import type { Entitlements } from '../net/quota';

const FILING_KEY = 'clapper.folders.v1';

/** The one non-folder destination. Never a folder id, so it can never
 *  collide — and it stays a FREE action regardless of Studio Plus (see the
 *  header above: Archive predates this feature and is not a `Folder`). */
export const ARCHIVE = '__archive__';

export interface Folder {
  id: string;
  name: string;
  order: number;
}

export interface Filing {
  folders: Folder[];
  /** projectId -> folder id, or ARCHIVE. Absent = unfiled. */
  filed: Record<string, string>;
}

export const EMPTY_FILING: Filing = { folders: [], filed: {} };

export function readFiling(): Filing {
  try {
    const raw = localStorage.getItem(FILING_KEY);
    if (!raw) return EMPTY_FILING;
    const parsed = JSON.parse(raw) as Partial<Filing>;
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      filed: parsed.filed && typeof parsed.filed === 'object' ? parsed.filed : {},
    };
  } catch {
    return EMPTY_FILING;
  }
}

export function writeFiling(next: Filing): void {
  try {
    localStorage.setItem(FILING_KEY, JSON.stringify(next));
  } catch {
    /* the filing still works for this session, it just will not survive it */
  }
}

/** A short, collision-resistant enough folder id — this never leaves the
 *  device and is never compared against anything but itself, so a
 *  timestamp plus a few random base36 characters is all the uniqueness this
 *  needs (two folders created by the same human in the same millisecond is
 *  not a real risk, but costs nothing to cover). */
export function newFolderId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * AUTO-ARCHIVE, implemented as a READ, not a write.
 *
 * The pitch asks for "auto-files 30 days after wrap, because on-set apps
 * never get housekeeping time". A background job cannot be the answer: this
 * app is offline-first and is opened on a set, in a hurry, weeks apart —
 * there is no moment it can be trusted to run, and a sweep that fires on
 * launch would rewrite the user's list while they are looking for something
 * in it.
 *
 * So archive is DERIVED. A project nobody has filed and nobody has touched
 * for thirty days is in the Archive, and the instant it is touched again it
 * walks straight back out. An EXPLICIT filing always wins — a decision a
 * person made is never overridden by a rule about time.
 */
const DAY_MS = 86400000;
export const ARCHIVE_AFTER_MS = 30 * DAY_MS;

export function isAutoArchived(now: number, lastActivityMs: number): boolean {
  return now - lastActivityMs >= ARCHIVE_AFTER_MS;
}

/** Where a project lives: a folder id, ARCHIVE, or '' for the unfiled bands.
 *  A folder id that no longer exists (deleted out from under a project, or a
 *  stale id from before a rename/delete) resolves to '' — unfiled, never
 *  invisible. This is the single choke point `deleteFolder` below relies on
 *  for its "never deletes a project" guarantee: it does not even need to
 *  scrub every reference for the UI to be correct, though it does anyway
 *  (see `deleteFolder`) so `filed` never accumulates dangling ids. */
export function placeOf(filing: Filing, now: number, projectId: string, lastActivityMs: number): string {
  const explicit = filing.filed[projectId];
  if (explicit) {
    if (explicit === ARCHIVE) return ARCHIVE;
    return filing.folders.some((f) => f.id === explicit) ? explicit : '';
  }
  return isAutoArchived(now, lastActivityMs) ? ARCHIVE : '';
}

/** A real folder — not ARCHIVE and not the unfiled sentinel. The line every
 *  gate in this file and in ProjectsScreen.tsx checks against: Archive and
 *  Unfiled are free movements, moving into or out of an actual folder is the
 *  Studio Plus action. */
export function isFolderPlace(place: string): boolean {
  return place !== '' && place !== ARCHIVE;
}

/** True exactly when a move between `from` and `to` touches a real folder —
 *  either end. `''` <-> `ARCHIVE` (archiving/unarchiving, either direction)
 *  is never gated; anything that enters or leaves an actual folder is. */
export function moveNeedsFolders(from: string, to: string): boolean {
  return isFolderPlace(from) || isFolderPlace(to);
}

/**
 * Create a folder — pure, so ProjectsScreen's `commitFiling` is the only
 * thing that ever touches storage. Order is append-only creation order; the
 * screen re-sorts by name for ties, same as before.
 */
export function createFolder(filing: Filing, name: string): { filing: Filing; folder: Folder } {
  const folder: Folder = { id: newFolderId(), name: name.trim(), order: filing.folders.length };
  return { filing: { ...filing, folders: [...filing.folders, folder] }, folder };
}

/** Rename a folder in place. Membership (`filed`) is untouched — renaming
 *  where a project already lives changes nothing about whether it lives
 *  there. A name that trims to empty is rejected by the caller before this
 *  ever runs (see ProjectsScreen's rename sheet); this function trusts a
 *  non-empty trimmed name was already checked. */
export function renameFolder(filing: Filing, folderId: string, name: string): Filing {
  const trimmed = name.trim();
  if (!trimmed) return filing;
  return {
    ...filing,
    folders: filing.folders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)),
  };
}

/**
 * Delete a folder. THE HARD RULE THIS ENFORCES: no project is ever deleted,
 * or even touched outside `filed` — every project that pointed at this
 * folder simply loses that one entry and falls through to unfiled, exactly
 * the same fallback `placeOf` already gives a dangling reference. Scrubbing
 * `filed` here (rather than leaving it to `placeOf`'s fallback) is belt and
 * braces: it keeps the stored map from silently accumulating references to
 * folders that no longer exist.
 */
export function deleteFolder(filing: Filing, folderId: string): Filing {
  const filed: Record<string, string> = {};
  for (const [projectId, place] of Object.entries(filing.filed)) {
    if (place !== folderId) filed[projectId] = place;
  }
  return { folders: filing.folders.filter((f) => f.id !== folderId), filed };
}

// ============================================================ THE GATE =====

/**
 * The Studio Plus entitlement check for folder CONTROLS — create, rename,
 * delete, and moving a project into or out of a real folder (see
 * `moveNeedsFolders`). Archive and Unfiled are never gated; VIEWING whatever
 * is already on disk is never gated either — only the write path runs
 * through this.
 *
 * A `Pick`, not the full `Entitlements` shape: the only two fields this
 * decision has ever needed, spelled out at the call site (net/quota.ts) as
 * THE gate for this product — `subscriptionProduct === 'studio_plus'` while
 * `subscriptionActive`. `null` (signed out, or the read hasn't resolved yet)
 * reads as not-entitled, which is also the fail-safe default: this function
 * never returns true on an absence of information.
 */
export function canManageFolders(
  entitlements: Pick<Entitlements, 'subscriptionProduct' | 'subscriptionActive'> | null,
): boolean {
  return !!entitlements && entitlements.subscriptionActive && entitlements.subscriptionProduct === 'studio_plus';
}
