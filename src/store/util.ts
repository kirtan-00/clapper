// Shared helpers for both store backends (idb + localStorage).

import type { CameraUnit, CameraUnitLetter, Project, Slate, SoundUnit, Take, TakeClip } from '../types';

export function newId(): string {
  // crypto.randomUUID is available on http(s) AND on file:// in modern
  // browsers; fall back to a manual v4 for any context that lacks it.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

export function notFound(entity: string, id: string): never {
  throw new Error(`${entity} not found: ${id}`);
}

/** prefix + zero-padded number + optional static suffix, e.g. "A001_C" 1 3 "_*" -> "A001_C001_*". */
export function formatClip(prefix: string, n: number, padding: number, suffix?: string): string {
  return prefix + String(Math.max(0, n)).padStart(padding, '0') + (suffix ?? '');
}

/**
 * Recover the counter value baked into a recorded clip name. Clip names are
 * always `prefix + padded number + suffix`, so strip the known ends and parse
 * the middle.
 */
export function parseClipNumber(clipName: string, prefix: string, suffix: string): number {
  let mid = clipName;
  if (prefix && mid.startsWith(prefix)) mid = mid.slice(prefix.length);
  if (suffix && mid.endsWith(suffix)) mid = mid.slice(0, mid.length - suffix.length);
  const n = parseInt(mid, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * The camera units a project logs against, as a uniform list. Multi-cam returns
 * the real units; single-cam returns one synthetic 'A' unit built from the
 * top-level clip fields, so callers have exactly one shape to reason about.
 */
export function clipUnits(project: Project): CameraUnit[] {
  if (project.cameras && project.cameras.length > 0) return project.cameras;
  return [
    {
      letter: 'A',
      clipPrefix: project.clipPrefix,
      nextClipNumber: project.nextClipNumber,
      clipPadding: project.clipPadding,
      ...(project.clipSuffix !== undefined ? { clipSuffix: project.clipSuffix } : {}),
      ...(project.clipExt !== undefined ? { clipExt: project.clipExt } : {}),
    },
  ];
}

/** The counter baked into `take` for camera `unit`, single- or multi-cam. */
function takeClipNumber(take: Take, unit: CameraUnit): number {
  const name =
    take.clips && take.clips.length
      ? (take.clips.find((c) => c.unit === unit.letter)?.clipName ?? take.clipName)
      : take.clipName;
  return parseClipNumber(name, unit.clipPrefix, unit.clipSuffix ?? '');
}

/** Rewrite `take` so camera `unit`'s clip carries counter `n`. */
function withClipNumber(take: Take, unit: CameraUnit, n: number): Take {
  const name = formatClip(unit.clipPrefix, n, unit.clipPadding, unit.clipSuffix);
  if (!take.clips || take.clips.length === 0) {
    return unit.letter === 'A' ? { ...take, clipName: name } : take;
  }
  const clips = take.clips.map((c) => (c.unit === unit.letter ? { ...c, clipName: name } : c));
  return { ...take, clips, clipName: clips[0].clipName };
}

/** The sound-file counter baked into `take`, or 0 if it recorded no sound. */
function takeSoundNumber(take: Take, sound: SoundUnit): number {
  if (!take.sound) return 0;
  return parseClipNumber(take.sound.fileName, sound.filePrefix, sound.fileSuffix ?? '');
}

/** Rewrite `take` so its sound file carries counter `n` (no-op if it has none). */
function withSoundNumber(take: Take, sound: SoundUnit, n: number): Take {
  if (!take.sound) return take;
  const fileName = formatClip(sound.filePrefix, n, sound.filePadding, sound.fileSuffix);
  if (fileName === take.sound.fileName) return take;
  return { ...take, sound: { ...take.sound, fileName } };
}

/** Chronological (CUT order) = the order the camera actually wrote its files. */
function inCutOrder(takes: Take[]): Take[] {
  return [...takes].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Correct a mis-logged clip number and carry the correction forward.
 *
 * A camera counts its own files monotonically, so if this take's number was
 * wrong by some delta, EVERY later file it wrote is wrong by that same delta —
 * and so is the live counter waiting for the next CUT. We therefore shift, not
 * resequence: deliberate gaps (camera rolled without Clapper) are preserved.
 *
 * Discarded takes count exactly like kept ones — the camera wrote that file
 * either way, which is the whole reason the counter advances on DISCARD.
 *
 * Per camera unit: each unit has its own counter, so a fix on B never disturbs
 * A/C/D. Earlier takes are never touched.
 *
 * Returns ONLY the takes whose clip names changed, plus the updated project.
 */
export function rebaseClipNumbers(
  project: Project,
  allTakes: Take[],
  editedTakeId: string,
  newNumbers: Partial<Record<CameraUnitLetter, number>>,
  now: number,
  soundNumber?: number,
): { takes: Take[]; project: Project } {
  const ordered = inCutOrder(allTakes);
  const editedAt = ordered.findIndex((t) => t.id === editedTakeId);
  if (editedAt < 0) notFound('take', editedTakeId);

  const units = clipUnits(project);
  const deltas = new Map<CameraUnitLetter, number>();
  for (const u of units) {
    const target = newNumbers[u.letter];
    if (target === undefined) continue;
    const delta = Math.max(0, Math.trunc(target)) - takeClipNumber(ordered[editedAt], u);
    if (delta !== 0) deltas.set(u.letter, delta);
  }

  // Sound rides the SAME "shift, never resequence" doctrine as a camera: the
  // recorder counts its own files monotonically, so a correction on this take
  // shifts every later sound file by the same delta. Only meaningful when the
  // project has a Sound unit and this take actually recorded sound.
  const sound = project.sound;
  let soundDelta = 0;
  if (soundNumber !== undefined && sound && ordered[editedAt].sound) {
    soundDelta = Math.max(0, Math.trunc(soundNumber)) - takeSoundNumber(ordered[editedAt], sound);
  }

  // The edited take always takes the typed number(s) verbatim, even where a
  // delta is 0 (reformatting to the current prefix/padding).
  const changed = new Map<string, Take>();
  let edited = ordered[editedAt];
  for (const u of units) {
    const target = newNumbers[u.letter];
    if (target === undefined) continue;
    edited = withClipNumber(edited, u, Math.max(0, Math.trunc(target)));
  }
  if (soundNumber !== undefined && sound && edited.sound) {
    edited = withSoundNumber(edited, sound, Math.max(0, Math.trunc(soundNumber)));
  }
  changed.set(edited.id, { ...edited, updatedAt: now });

  const hasCameraShift = deltas.size > 0;
  const hasSoundShift = soundDelta !== 0 && !!sound;
  if (!hasCameraShift && !hasSoundShift) {
    return { takes: [...changed.values()], project };
  }

  for (let i = editedAt + 1; i < ordered.length; i++) {
    let take = ordered[i];
    for (const u of units) {
      const delta = deltas.get(u.letter);
      if (delta === undefined) continue;
      take = withClipNumber(take, u, Math.max(0, takeClipNumber(take, u) + delta));
    }
    if (hasSoundShift && take.sound) {
      take = withSoundNumber(take, sound!, Math.max(0, takeSoundNumber(take, sound!) + soundDelta));
    }
    if (take !== ordered[i]) changed.set(take.id, { ...take, updatedAt: now });
  }

  // The live counters are just "the next file this unit will write" — each rides
  // its own shift, or the very next CUT reintroduces the error.
  let nextProject: Project = project;
  if (hasCameraShift) {
    if (project.cameras && project.cameras.length > 0) {
      nextProject = {
        ...nextProject,
        cameras: project.cameras.map((u) => {
          const delta = deltas.get(u.letter);
          return delta === undefined ? u : { ...u, nextClipNumber: Math.max(0, u.nextClipNumber + delta) };
        }),
        updatedAt: now,
      };
    } else {
      const delta = deltas.get('A') ?? 0;
      nextProject = { ...nextProject, nextClipNumber: Math.max(0, project.nextClipNumber + delta), updatedAt: now };
    }
  }
  if (hasSoundShift) {
    nextProject = {
      ...nextProject,
      sound: { ...sound!, nextFileNumber: Math.max(0, sound!.nextFileNumber + soundDelta) },
      updatedAt: now,
    };
  }

  return { takes: [...changed.values()], project: nextProject };
}

/**
 * Give a deleted shot's clip number back to the camera count.
 *
 * DELETE means that file never existed: the app rolled but the camera did not.
 * So every later shot on each unit the phantom consumed slides DOWN one, and
 * the live counter with it. (DISCARD is the opposite case - the camera DID
 * write the file, it was just no good, so the number stays spent.)
 *
 * Returns the takes to rewrite (the doomed take is NOT included; the caller
 * deletes that row) and the updated project.
 */
export function reclaimClipNumbers(
  project: Project,
  allTakes: Take[],
  deletedTakeId: string,
  now: number,
): { takes: Take[]; project: Project } {
  const ordered = inCutOrder(allTakes);
  const at = ordered.findIndex((t) => t.id === deletedTakeId);
  if (at < 0) notFound('take', deletedTakeId);

  const doomed = ordered[at];
  const units = clipUnits(project);
  // Only units that actually recorded a clip on the doomed take gave up a
  // number, so only those get one back. On a multi-cam take where just the
  // B-cam rolled, A/C/D never advanced and must not slide.
  const consumed = units.filter((u) =>
    doomed.clips && doomed.clips.length
      ? doomed.clips.some((c) => c.unit === u.letter)
      : u.letter === 'A',
  );
  // Sound is one more stream that may have consumed a number on this take. It
  // slides down exactly like a camera: DELETE means the recorder never wrote
  // that file, so later sound files reclaim the gap.
  const sound = project.sound;
  const doomedHadSound = !!(sound && doomed.sound);
  if (consumed.length === 0 && !doomedHadSound) return { takes: [], project };

  const changed: Take[] = [];
  for (let i = at + 1; i < ordered.length; i++) {
    let take = ordered[i];
    for (const u of consumed) {
      take = withClipNumber(take, u, Math.max(0, takeClipNumber(take, u) - 1));
    }
    if (doomedHadSound && take.sound) {
      take = withSoundNumber(take, sound!, Math.max(0, takeSoundNumber(take, sound!) - 1));
    }
    if (take !== ordered[i]) changed.push({ ...take, updatedAt: now });
  }

  const letters = new Set(consumed.map((u) => u.letter));
  let nextProject: Project = project;
  if (consumed.length > 0) {
    nextProject =
      project.cameras && project.cameras.length > 0
        ? {
            ...nextProject,
            cameras: project.cameras.map((u) =>
              letters.has(u.letter) ? { ...u, nextClipNumber: Math.max(0, u.nextClipNumber - 1) } : u,
            ),
            updatedAt: now,
          }
        : { ...nextProject, nextClipNumber: Math.max(0, project.nextClipNumber - 1), updatedAt: now };
  }
  if (doomedHadSound) {
    nextProject = {
      ...nextProject,
      sound: { ...sound!, nextFileNumber: Math.max(0, sound!.nextFileNumber - 1) },
      updatedAt: now,
    };
  }

  return { takes: changed, project: nextProject };
}

/** One participating unit's own roll timing within a take (mirrors Store.createTake's arg). */
export interface TakeUnitRoll {
  unit: CameraUnitLetter;
  startOffsetMs: number; // ms after the take started that this unit began rolling
  durationMs: number;    // how long this unit rolled
}

/** The CUT-time inputs a take is built from (mirrors Store.createTake's arg). */
export interface TakeInput {
  slateId: string;
  projectId: string;
  startedAt: number;
  durationMs: number;
  cameraTC?: string;
  note?: string;
  // Multi-cam only: which units actually rolled, and each one's own timing.
  // ABSENT/empty = every configured unit rolled together for the whole take
  // (the big-ROLL common case) - matches every take built before this existed.
  units?: TakeUnitRoll[];
  // Sound (orthogonal to cameras): present when the recorder rolled this take,
  // with its own timing. ABSENT = sound did not roll. Ignored if no `sound` unit.
  sound?: { startOffsetMs: number; durationMs: number };
}

/**
 * Layer the sound file onto a freshly built take: if the project has a Sound
 * unit AND sound rolled this take, stamp its file name and advance the sound
 * counter. Orthogonal to cameras, so it runs identically for single- and
 * multi-cam takes. A no-op (returns the picture take unchanged) otherwise.
 */
function applySound(
  project: Project,
  take: Take,
  input: TakeInput,
  now: number,
): { take: Take; project: Project } {
  const s = project.sound;
  if (!s || !input.sound) return { take, project };
  const fileName = formatClip(s.filePrefix, s.nextFileNumber, s.filePadding, s.fileSuffix);
  return {
    take: {
      ...take,
      sound: {
        fileName,
        startOffsetMs: input.sound.startOffsetMs,
        durationMs: input.sound.durationMs,
      },
    },
    project: { ...project, sound: { ...s, nextFileNumber: s.nextFileNumber + 1 }, updatedAt: now },
  };
}

/**
 * Build the take (and the project with its clip counter(s) advanced) at CUT.
 * Pure and backend-agnostic so idb + localStorage stay byte-identical.
 *
 * Single-cam (no `project.cameras`): consumes the top-level `nextClipNumber`,
 * exactly as before — one clip in `clipName`, no `clips` array. `input.units`
 * is meaningless here and ignored.
 *
 * Multi-cam: consumes ONLY the counters of units that actually rolled
 * (`input.units`, or - absent - every configured unit, full take duration, no
 * offset). Only those units get a clip in `clips`. `clipName` mirrors the
 * first participating unit in camera-letter order, so a legacy reader that
 * only looks at `clipName` still sees a real clip whether or not A rolled.
 */
export function buildTakeClips(
  project: Project,
  number: number,
  input: TakeInput,
  now: number,
): { take: Take; project: Project } {
  const units = project.cameras;

  if (units && units.length > 0) {
    const rolls = new Map<CameraUnitLetter, TakeUnitRoll>(
      input.units && input.units.length > 0
        ? input.units.map((r) => [r.unit, r])
        : units.map((u) => [u.letter, { unit: u.letter, startOffsetMs: 0, durationMs: input.durationMs }]),
    );

    const rollingUnits = units.filter((u) => rolls.has(u.letter));
    const clips: TakeClip[] = rollingUnits.map((u) => {
      const roll = rolls.get(u.letter)!;
      return {
        unit: u.letter,
        clipName: formatClip(u.clipPrefix, u.nextClipNumber, u.clipPadding, u.clipSuffix),
        startOffsetMs: roll.startOffsetMs,
        durationMs: roll.durationMs,
      };
    });
    const advanced = units.map((u) =>
      rolls.has(u.letter) ? { ...u, nextClipNumber: u.nextClipNumber + 1 } : u,
    );
    const take: Take = {
      id: newId(),
      slateId: input.slateId,
      projectId: input.projectId,
      number,
      clipName: clips[0]?.clipName ?? '',
      clips,
      status: 'good',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return applySound({ ...project, cameras: advanced, updatedAt: now }, take, input, now);
  }

  // Single-cam: untouched legacy path.
  const clipNumber = project.nextClipNumber;
  const clipName =
    project.clipPrefix + String(clipNumber).padStart(project.clipPadding, '0') + (project.clipSuffix ?? '');
  const take: Take = {
    id: newId(),
    slateId: input.slateId,
    projectId: input.projectId,
    number,
    clipName,
    status: 'good',
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return applySound({ ...project, nextClipNumber: clipNumber + 1, updatedAt: now }, take, input, now);
}

// ---------------------------------------------------------- shoot order ---
// Two independent orders live on a Slate: `order` (story/script order — what
// every exporter sorts by, and what Script Mode assigns) and `shootOrder`
// (on-set running order, set only once someone drags a scene). These helpers
// are pure and shared by both store backends, same as the clip-number helpers
// above.

/**
 * The order the on-set scene list displays in: `shootOrder` if the slate has
 * one, else its story `order`. A project where nobody has ever dragged has no
 * `shootOrder` anywhere, so this is byte-identical to sorting by `.order`
 * alone — no migration, no behaviour change until the first drag.
 */
export function sortForDisplay<T extends { order: number; shootOrder?: number }>(slates: T[]): T[] {
  return [...slates].sort((a, b) => {
    const av = a.shootOrder ?? a.order;
    const bv = b.shootOrder ?? b.order;
    return av - bv || a.order - b.order;
  });
}

/** Pure array move: pull the item at `from` out and reinsert it at `to`, clamped. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items.slice();
  const clamped = Math.max(0, Math.min(items.length - 1, to));
  if (clamped === from) return items.slice();
  const copy = items.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(clamped, 0, moved);
  return copy;
}

/**
 * Stamp `shootOrder` across a project's scenes to match a new on-set running
 * order. `orderedSlateIds` is expected to be the project's FULL current scene
 * set, in the order the UI wants to persist — each id's index becomes its
 * `shootOrder`. Returns ONLY the slates whose `shootOrder` actually changed
 * (a reorder that lands back where it started, or an id we don't recognise,
 * writes nothing) — the same "only touch what moved" discipline as
 * `rebaseClipNumbers`. Never touches `.order`.
 */
export function reorderSlateList(
  allSlates: Slate[],
  orderedSlateIds: string[],
  now: number,
): Slate[] {
  const byId = new Map(allSlates.map((s) => [s.id, s]));
  const changed: Slate[] = [];
  orderedSlateIds.forEach((id, index) => {
    const existing = byId.get(id);
    if (!existing) return; // unknown id: never invent or corrupt a row
    if (existing.shootOrder !== index) {
      changed.push({ ...existing, shootOrder: index, updatedAt: now });
    }
  });
  return changed;
}
