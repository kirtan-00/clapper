// Matching a logged take to the file the camera actually wrote.
//
// THE CONSTRAINT THIS MODULE IS BUILT AROUND: a browser never hands out an
// absolute filesystem path. `<input webkitdirectory>` gives every File a
// `webkitRelativePath` — a path relative to the folder the user picked, and
// nothing above it. `showDirectoryPicker()` gives real directory handles and
// still no absolute path. That is a privacy boundary, not an oversight, and
// there is no trick around it that isn't a lie.
//
// So a location in the CSV is built out of two halves, each from the only
// source that can honestly supply it:
//
//   the RELATIVE path   — from walking the folder the user picked (here)
//   the ABSOLUTE root   — from the user, typed/confirmed once (Project.mediaRoot)
//
// With no root set we still write the relative path, because we genuinely
// received it. What we never do is synthesise the absolute half.
//
// LAYOUT-AGNOSTIC BY CONSTRUCTION. Every card vendor buries clips at a
// different depth, and there is no point teaching this file about any of
// them:
//
//   Sony        PRIVATE/M4ROOT/CLIP/C0012.MP4
//   Panasonic   PRIVATE/AVCHD/BDMV/STREAM/00000.MTS
//   Canon       DCIM/100CANON/MVI_0012.MOV
//   RED         A001_C012_0808XX.RDC/A001_C012_0808XX_001.R3D
//   ARRI        A001R2EC/A001C012_260808_R2EC.mxf
//   Blackmagic  A001_08081200_C012.braw          (flat, no folders at all)
//   GoPro       DCIM/100GOPRO/GX010012.MP4
//
// A plain recursive walk plus matching on the BASENAME handles all seven
// without a single vendor branch — the folders above a clip carry no
// information we need, so we simply don't read them.
//
// THE WILDCARD. Clapper's own clip names already carry a '*' for the parts of
// a filename the phone cannot predict — a record-time stamp, a date, a camera
// ID (see the RED / ARRI / Blackmagic / DJI presets in ui/cameras.ts, whose
// notes literally say "match files by the C-number"). So a logged
// "A001_C012_*" is not a broken name to be worked around: it is already a
// pattern, authored by the app, and matching it as a glob is what its author
// meant. That is why there is no vendor-specific suffix heuristic here.

import { joinPath } from './paths';

/**
 * What counts as footage. Deliberately a fixed list rather than "anything
 * that isn't a folder": a card is full of .THM thumbnails, .XML sidecars,
 * .CPI clip-info and .BIM files that share the clip's basename exactly, and
 * indexing those would turn every single take into an ambiguous match.
 *
 * `.wav` earns its place because a Sound unit's recorder files are logged
 * alongside picture (Take.sound), and a DIT copies both trees together.
 */
export const MEDIA_EXTENSIONS: readonly string[] = [
  '.mp4',
  '.mov',
  '.mxf',
  '.braw',
  '.r3d',
  '.ari',
  '.arx',
  '.avi',
  '.mts',
  '.m2ts',
  '.dng',
  '.wav',
];

/**
 * A folder walk, reduced to the only thing an export needs. Serialisable on
 * purpose — this is what gets persisted so a re-export doesn't force a
 * re-pick (see store/medialink.ts).
 *
 * `byBase` maps a normalised basename to EVERY relative path that carries it.
 * A list, not a single path, because two cards genuinely do both contain a
 * C0012.MP4 — that is the normal state of a two-camera shoot, not an edge
 * case, and collapsing it to one entry would relink an editor to the wrong
 * physical file while looking perfectly successful.
 */
export interface MediaIndex {
  /** The picked folder's own name, for showing the user what they picked. */
  rootName: string;
  pickedAt: number; // epoch ms
  fileCount: number; // media files kept, after the extension filter
  byBase: Record<string, string[]>;
}

export type MediaMatchStatus =
  // Exactly one file in the picked tree carries this clip's name.
  | 'matched'
  // Two or more do. We refuse to pick one; both are reported instead.
  | 'ambiguous'
  // The tree was walked and this clip is not in it.
  | 'missing'
  // No folder has been picked, or the take carries no clip name — we have not
  // looked, which is a different thing from having looked and found nothing.
  | 'unindexed';

export interface MediaMatch {
  status: MediaMatchStatus;
  /** The one location, ONLY when status is 'matched'. Empty otherwise — a
   *  guessed path is worse than a blank cell, because a blank cell is
   *  obviously blank and a wrong path takes an afternoon to disprove. */
  path: string;
  /** Every location that matched: 0 for missing/unindexed, 1 for matched,
   *  2+ for ambiguous. Root-joined the same way `path` is. */
  candidates: string[];
}

/** Extension of `name`, lowercased and including the dot, or '' if it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function isMediaFile(name: string): boolean {
  return MEDIA_EXTENSIONS.includes(extensionOf(name));
}

/**
 * The key both sides of the match are reduced to: the file name with any
 * media extension removed, lowercased.
 *
 * Case-insensitive because the two sides come from different machines. A card
 * formatted in-camera writes C0012.MP4; the same card copied through a
 * Windows share, a NAS, or a rename script comes back c0012.mp4, and macOS
 * hands both to the browser as-is. An operator who typed the clip prefix in
 * lower case has the same problem from the other end.
 *
 * Only a KNOWN media extension is stripped, never "everything after the last
 * dot" — a real clip name can contain one ("A001_C012_08.08.MP4"), and
 * chopping at the last dot would silently shorten it.
 */
export function baseKey(fileName: string): string {
  const name = fileName.trim();
  const ext = extensionOf(name);
  const stem = MEDIA_EXTENSIONS.includes(ext) ? name.slice(0, name.length - ext.length) : name;
  return stem.toLowerCase();
}

/**
 * Build the index from relative paths, dropping non-media and normalising the
 * one place the two picker APIs disagree.
 *
 * `webkitRelativePath` INCLUDES the picked folder's own name as its first
 * segment ("fixture/CARD_A/C0012.MP4"); a `showDirectoryPicker()` walk yields
 * paths you assemble yourself, which naturally exclude it. Left alone, that
 * one segment turns the editor's root into "/Volumes/SSD/fixture/fixture/…"
 * on one browser and not the other. The convention here is the second one —
 * `mediaRoot` IS the picked folder, so a relative path starts below it — and
 * the leading segment is stripped when every path agrees it is there.
 */
export function buildMediaIndex(
  relativePaths: readonly string[],
  rootName: string,
  pickedAt: number = Date.now(),
): MediaIndex {
  const prefix = rootName ? `${rootName}/` : '';
  const stripRoot =
    prefix.length > 0 && relativePaths.length > 0 && relativePaths.every((p) => p.startsWith(prefix));

  const byBase: Record<string, string[]> = {};
  let fileCount = 0;

  for (const raw of relativePaths) {
    const rel = (stripRoot ? raw.slice(prefix.length) : raw).replace(/^\/+/, '');
    const fileName = rel.slice(rel.lastIndexOf('/') + 1);
    if (!fileName || !isMediaFile(fileName)) continue;
    fileCount += 1;
    const key = baseKey(fileName);
    (byBase[key] ??= []).push(rel);
  }

  // Sorted so a re-pick of the same tree produces byte-identical output and
  // an ambiguous take reports its candidates in a stable order.
  for (const key of Object.keys(byBase)) byBase[key].sort();

  return { rootName, pickedAt, fileCount, byBase };
}

/**
 * Turn a clip name carrying '*' into a regex over normalised basenames.
 * Everything that is not the wildcard is escaped literally, because clip
 * names legitimately carry the characters a regex would otherwise read as
 * syntax — a project prefix with a '(' in it, an operator's '+', the '.' in
 * a date. (paths.test.ts already pins the same class of problem for URLs.)
 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** Every relative path in `index` whose basename matches `clipName`. */
function candidatePaths(index: MediaIndex, clipName: string): string[] {
  const key = baseKey(clipName);
  if (!key) return [];
  if (!key.includes('*')) return index.byBase[key] ?? [];
  const re = globToRegExp(key);
  const hits: string[] = [];
  for (const base of Object.keys(index.byBase).sort()) {
    if (re.test(base)) hits.push(...index.byBase[base]);
  }
  return hits;
}

/**
 * Where the file for `clipName` lives, given a walked folder and the absolute
 * root the user confirmed for it. Either half may be absent; the status says
 * which.
 *
 * A note on the days: this index has no idea what a shoot day is, and every
 * camera restarts at C0001 every morning. Copy day 1 and day 5 into one
 * folder and C0001 legitimately matches twice — reported as 'ambiguous' with
 * both paths, which is the truthful answer. Picking one would be a coin flip
 * dressed up as a result. (The exporters solve their own version of this by
 * folding the shoot day into a folder segment — see fcpxml.ts / resolve.ts —
 * but that is a path they INVENT, and this module only reports paths it was
 * handed.)
 */
export function matchClip(
  index: MediaIndex | undefined,
  clipName: string | undefined,
  mediaRoot?: string,
): MediaMatch {
  if (!index || !clipName || !clipName.trim()) {
    return { status: 'unindexed', path: '', candidates: [] };
  }
  const hits = candidatePaths(index, clipName).map((rel) => joinPath(mediaRoot, rel));
  if (hits.length === 0) return { status: 'missing', path: '', candidates: [] };
  if (hits.length === 1) return { status: 'matched', path: hits[0], candidates: hits };
  return { status: 'ambiguous', path: '', candidates: hits };
}

/** How many of `clipNames` resolve to exactly one file. What the picker UI
 *  reports back the moment a folder is chosen, so nobody discovers at wrap
 *  that they pointed at the wrong disk. */
export function countMatched(index: MediaIndex, clipNames: readonly string[]): number {
  let n = 0;
  for (const name of clipNames) {
    if (matchClip(index, name).status === 'matched') n += 1;
  }
  return n;
}
