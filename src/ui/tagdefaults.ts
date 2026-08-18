// The quick-tag chips a NEW project starts with, per mode, set once in Settings.
//
// Kirtan's request (2026-08-15): "in setting they can set their tags too for all
// projects so they wont have to write them eveeysingle time." A crew has a house
// vocabulary — the same six words every shoot — and retyping them into the New
// project sheet on every job is exactly the kind of ceremony this app exists to
// delete.
//
// SCOPE, deliberately narrow: this sets the DEFAULT a new project is born with.
// It is not a live binding. Changing it here never reaches back into a project
// that already exists, because a project's tags are its own — they are stamped
// into logged takes (`Take.tag`), and silently rewriting the vocabulary under a
// shoot that is half-logged would orphan chips on takes already in the can.
// Editing an existing shoot's tags is a separate, explicit act on the project
// screen (see TagEditor.tsx's two mounts).
//
// Same shape as cutsize.ts and theme.ts: read/write guarded so Safari private
// mode cannot take the app down over a preference, a tiny pub-sub instead of
// context so a row can mount anywhere, and ONE exported list per mode so no
// second copy can drift (the lesson from CUT_SIZES).

import type { ProjectMode } from './newRoll';

// The two shipped vocabularies. They used to live in newRoll.ts, beside the
// scratch-project creators that were their only reader; they moved here when
// those creators started reading the OPERATOR's set instead, so the dependency
// runs one way (newRoll -> tagdefaults) and there is no cycle to reason about.
// `ProjectMode` still comes from newRoll, but as a type — that erases.

/** What a scratch VIDEO project starts with: the standard coverage a crew
 *  notes, plus the usual take-quality flags. The same set the New project
 *  sheet offers, so a scratch shoot is not a lesser project. */
export const SCRATCH_TAGS = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE'];

/**
 * What a scratch PODCAST project starts with. Coverage-size tags (WIDE/MCU/
 * OTS…) describe a camera setup and mean nothing on a single continuous take,
 * so podcast mode gets its own vocabulary: the things worth flagging live, by
 * ear, while a conversation runs long. GOLD stays — it is the one tag with its
 * own brass grading button beside MARK IN (see RollingScreen.tsx), and "best
 * clip in the episode" is exactly as useful here as "best take of the scene"
 * is on a shoot.
 */
export const PODCAST_TAGS = ['STORY', 'QUOTE', 'LAUGH', 'TANGENT', 'REDO', 'GOLD'];

export const TAGS_KEY_VIDEO = 'clapper.tags.video';
export const TAGS_KEY_PODCAST = 'clapper.tags.podcast';

/** What each mode falls back to when the operator has never set anything —
 *  the same two lists a scratch project has always been born with, so the
 *  factory state of this feature changes nothing about the app. */
export const BUILTIN_TAGS: Record<ProjectMode, readonly string[]> = {
  video: SCRATCH_TAGS,
  podcast: PODCAST_TAGS,
};

/**
 * Ceilings, and both are about the roll screen rather than about storage.
 *
 * MAX_TAGS: `project.tags` renders as the keypad under the take counter. The
 * deck scrolls now, so a 40-chip set degrades rather than breaking — but a set
 * that needs scrolling has already failed at the only job a quick tag has,
 * which is to be hit without looking. 16 is two full rows plus a little.
 *
 * MAX_TAG_LEN: a chip is a fixed-height pill on a 375px screen. Past ~12
 * characters it either wraps inside the pill or squeezes its neighbours off
 * the row. Longer thoughts belong in the take NOTE, which is unbounded.
 */
export const MAX_TAGS = 16;
export const MAX_TAG_LEN = 12;

/**
 * The one place a raw string becomes a tag. Upper-cases (chips are drawn in
 * caps either way, so a lower-case entry would only ever look like a bug),
 * strips the characters that would collide with the CSV and XML exporters,
 * clamps the length, and drops anything left empty.
 */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[",;\n\r\t<>&]/g, '')
    .slice(0, MAX_TAG_LEN)
    .trim();
}

/** Normalise a whole set: clean each, drop empties and duplicates, cap the
 *  count. Every path into storage goes through this, so nothing downstream
 *  has to defend itself against a hand-edited localStorage value. */
export function normaliseTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const tag = normaliseTag(t);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function keyFor(mode: ProjectMode): string {
  return mode === 'podcast' ? TAGS_KEY_PODCAST : TAGS_KEY_VIDEO;
}

function read(mode: ProjectMode): string[] {
  try {
    const raw = localStorage.getItem(keyFor(mode));
    if (!raw) return [...BUILTIN_TAGS[mode]];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...BUILTIN_TAGS[mode]];
    const clean = normaliseTags(parsed.filter((v): v is string => typeof v === 'string'));
    // An empty stored set is a legitimate choice (a crew that wants no chips
    // at all), but an empty set that came from CORRUPTION looks identical. A
    // deliberate empty is stored as [] and honoured; only a value that failed
    // to parse at all falls back above.
    return clean;
  } catch {
    return [...BUILTIN_TAGS[mode]];
  }
}

function write(mode: ProjectMode, tags: readonly string[]): void {
  try {
    localStorage.setItem(keyFor(mode), JSON.stringify(tags));
  } catch {
    /* the set still applies for this session, it just will not survive it */
  }
}

const current: Record<ProjectMode, string[]> = {
  video: read('video'),
  podcast: read('podcast'),
};

const listeners = new Set<() => void>();

/** The default set for a mode. Always a fresh array — callers hand this
 *  straight to `store.createProject`, which must not alias the live one. */
export function getDefaultTags(mode: ProjectMode): string[] {
  return [...current[mode]];
}

/** True when this mode is still on the shipped list, which is what lets the
 *  Settings row say "Default" instead of listing eight words it did not
 *  choose. Compared by value, not by reference. */
export function isBuiltinTags(mode: ProjectMode): boolean {
  const a = current[mode];
  const b = BUILTIN_TAGS[mode];
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Cache key for useSyncExternalStore. getDefaultTags returns a new array
 *  every call, so a component subscribing to it directly would re-render on
 *  every tick; subscribe to this string and read the array in the body. */
export function tagsVersion(): string {
  return `${current.video.join(',')}|${current.podcast.join(',')}`;
}

export function setDefaultTags(mode: ProjectMode, tags: readonly string[]): void {
  const clean = normaliseTags(tags);
  if (clean.length === current[mode].length && clean.every((t, i) => t === current[mode][i])) return;
  current[mode] = clean;
  write(mode, clean);
  for (const fn of listeners) fn();
}

/** Put a mode back on the shipped list, and forget the override entirely so a
 *  later change to BUILTIN_TAGS reaches this phone. */
export function resetDefaultTags(mode: ProjectMode): void {
  try {
    localStorage.removeItem(keyFor(mode));
  } catch {
    /* nothing to undo */
  }
  current[mode] = [...BUILTIN_TAGS[mode]];
  for (const fn of listeners) fn();
}
