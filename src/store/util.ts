// Shared helpers for both store backends (idb + localStorage).

import type {
  CameraUnit,
  CameraUnitLetter,
  Project,
  ShootDay,
  Slate,
  SoundUnit,
  Take,
  TakeClip,
  WrapUndoSnapshot,
} from '../types';

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

/**
 * How many files camera `unit` wrote on `take` - normally 1, but 2+ when it
 * cut and rejoined mid-take (see buildTakeClips). This is the amount its
 * counter moved, so it is also the amount a DELETE gives back.
 */
function takeClipCount(take: Take, unit: CameraUnit): number {
  if (take.clips && take.clips.length) return take.clips.filter((c) => c.unit === unit.letter).length;
  return unit.letter === 'A' ? 1 : 0;
}

/**
 * The counter baked into `take` for camera `unit`, single- or multi-cam. Where
 * the unit wrote several files this is the FIRST of them: corrections are
 * expressed as "this take's number for B was really N", and the rest of B's
 * files on the take ride the same shift (withClipNumber below).
 */
function takeClipNumber(take: Take, unit: CameraUnit): number {
  const name =
    take.clips && take.clips.length
      ? (take.clips.find((c) => c.unit === unit.letter)?.clipName ?? take.clipName)
      : take.clipName;
  return parseClipNumber(name, unit.clipPrefix, unit.clipSuffix ?? '');
}

/**
 * Rewrite `take` so camera `unit`'s FIRST clip carries counter `n`, sliding any
 * further clips that unit wrote on the same take by the identical delta.
 *
 * The shift-never-resequence doctrine applies inside a take exactly as it does
 * across takes: if B rolled twice and its first file was really C0020, its
 * second is C0021, and any gap the operator deliberately left between them is
 * preserved rather than closed up.
 */
function withClipNumber(take: Take, unit: CameraUnit, n: number): Take {
  const name = formatClip(unit.clipPrefix, n, unit.clipPadding, unit.clipSuffix);
  if (!take.clips || take.clips.length === 0) {
    return unit.letter === 'A' ? { ...take, clipName: name } : take;
  }
  const delta = n - takeClipNumber(take, unit);
  const clips = take.clips.map((c) => {
    if (c.unit !== unit.letter) return c;
    const own = parseClipNumber(c.clipName, unit.clipPrefix, unit.clipSuffix ?? '');
    return { ...c, clipName: formatClip(unit.clipPrefix, Math.max(0, own + delta), unit.clipPadding, unit.clipSuffix) };
  });
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
  // B-cam rolled, A/C/D never advanced and must not slide. A unit that cut and
  // rejoined wrote SEVERAL files on this one take and gives back that many.
  const consumed = units
    .map((u) => ({ unit: u, count: takeClipCount(doomed, u) }))
    .filter((c) => c.count > 0);
  // Sound is one more stream that may have consumed a number on this take. It
  // slides down exactly like a camera: DELETE means the recorder never wrote
  // that file, so later sound files reclaim the gap.
  const sound = project.sound;
  const doomedHadSound = !!(sound && doomed.sound);
  if (consumed.length === 0 && !doomedHadSound) return { takes: [], project };

  const changed: Take[] = [];
  for (let i = at + 1; i < ordered.length; i++) {
    let take = ordered[i];
    for (const { unit: u, count } of consumed) {
      take = withClipNumber(take, u, Math.max(0, takeClipNumber(take, u) - count));
    }
    if (doomedHadSound && take.sound) {
      take = withSoundNumber(take, sound!, Math.max(0, takeSoundNumber(take, sound!) - 1));
    }
    if (take !== ordered[i]) changed.push({ ...take, updatedAt: now });
  }

  const given = new Map(consumed.map((c) => [c.unit.letter, c.count]));
  let nextProject: Project = project;
  if (consumed.length > 0) {
    nextProject =
      project.cameras && project.cameras.length > 0
        ? {
            ...nextProject,
            cameras: project.cameras.map((u) => {
              const back = given.get(u.letter);
              return back === undefined ? u : { ...u, nextClipNumber: Math.max(0, u.nextClipNumber - back) };
            }),
            updatedAt: now,
          }
        : {
            ...nextProject,
            nextClipNumber: Math.max(0, project.nextClipNumber - (given.get('A') ?? 1)),
            updatedAt: now,
          };
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
  // The shot being rolled, when the scene carries a breakdown. ABSENT = the
  // take belongs to the bare scene and numbers per scene, exactly as every
  // take built before shots existed. `slateId` above is populated either way.
  shotId?: string;
  projectId: string;
  startedAt: number;
  durationMs: number;
  cameraTC?: string;
  note?: string;
  // Multi-cam only: which units actually rolled, and each one's own timing.
  //
  // ABSENT = we were not told, so assume every configured unit rolled together
  // for the whole take (the big-ROLL common case) - matches every take built
  // before this field existed.
  //
  // EMPTY ARRAY = we WERE told, and the answer is that no camera rolled: a
  // sound-only wild line. These two are NOT the same, and conflating them
  // burned a clip number on every camera for every wild line, drifting each
  // body's counter permanently out of step with its card.
  //
  // ONE UNIT MAY APPEAR MORE THAN ONCE. A camera that cuts and rejoins while
  // the others keep rolling (a card swap, a battery, a B-cam grabbing an
  // insert) closed one file and opened another WITHIN the same take, and each
  // entry here is one of those files. See buildTakeClips.
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
 *
 * A unit that rolled MORE THAN ONCE inside the take gets one clip per roll and
 * burns one counter per roll. A camera counts files, not takes: if B cut and
 * rejoined while A stayed rolling, B's card holds two files, so B's counter
 * must land two ahead. Collapsing them into one clip is what silently drifts a
 * body's numbering for the rest of the day.
 */
export function buildTakeClips(
  project: Project,
  number: number,
  input: TakeInput,
  now: number,
): { take: Take; project: Project } {
  // Fold in the take's day-tracking side effects BEFORE anything else: lazily
  // open day 1 if none is open yet, stamp firstTakeAt on the day's own first
  // touch and lastTakeAt on every touch (what shouldPromptForgottenWrap reads),
  // and carry the day's own label AND index onto the take itself — the index
  // is what actually disambiguates two different days sharing one date string
  // (see Take.shootDayIndex in types.ts). See the "shoot day / wrap" section
  // below for why this is never a bulk migration onto old rows.
  const { project: dayProject, shootDay, shootDayIndex } = noteTakeLogged(project, now);
  const units = dayProject.cameras;

  if (units && units.length > 0) {
    // `units: []` is a STATEMENT — "no camera rolled this take" — and must be
    // honoured. Only an ABSENT `units` means "we were not told, assume they all
    // rolled", which is the legacy single-path behaviour.
    //
    // Treating the empty array as "not told" is what burned clip numbers on set:
    // a sound-only wild line (`closeMultiTake([], ...)`) fabricated a clip name
    // on every camera and advanced every counter, so each body's next clip
    // silently drifted one ahead of what the card actually wrote — and stayed
    // wrong for the rest of the day.
    const given: TakeUnitRoll[] =
      input.units ??
      units.map((u) => ({ unit: u.letter, startOffsetMs: 0, durationMs: input.durationMs }));

    // Rolls per unit, each in the order that unit actually turned over, so the
    // clip numbers we hand out below run the same way the card wrote them.
    const rolls = new Map<CameraUnitLetter, TakeUnitRoll[]>();
    for (const r of given) {
      const list = rolls.get(r.unit);
      if (list) list.push(r);
      else rolls.set(r.unit, [r]);
    }
    for (const list of rolls.values()) list.sort((a, b) => a.startOffsetMs - b.startOffsetMs);

    // Camera-letter order across units, roll order within one - so clips[0] is
    // still the earliest-lettered participating camera's first file, which is
    // what `clipName` mirrors for legacy readers.
    const clips: TakeClip[] = [];
    for (const u of units) {
      const list = rolls.get(u.letter);
      if (!list) continue;
      list.forEach((roll, i) => {
        clips.push({
          unit: u.letter,
          clipName: formatClip(u.clipPrefix, u.nextClipNumber + i, u.clipPadding, u.clipSuffix),
          startOffsetMs: roll.startOffsetMs,
          durationMs: roll.durationMs,
        });
      });
    }
    // One number per FILE the card wrote, not one per unit that appeared.
    const advanced = units.map((u) => {
      const burnt = rolls.get(u.letter)?.length ?? 0;
      return burnt > 0 ? { ...u, nextClipNumber: u.nextClipNumber + burnt } : u;
    });
    const take: Take = {
      id: newId(),
      slateId: input.slateId,
      // Written only when the take actually names a shot — a stored
      // `shotId: undefined` would read as "has the field, empty", which is a
      // different thing from a legacy scene-level take that never had it.
      ...(input.shotId !== undefined ? { shotId: input.shotId } : {}),
      projectId: input.projectId,
      number,
      clipName: clips[0]?.clipName ?? '',
      clips,
      shootDay,
      shootDayIndex,
      status: 'good',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return applySound({ ...dayProject, cameras: advanced, updatedAt: now }, take, input, now);
  }

  // Single-cam: untouched legacy path (aside from the day-tracking folded in above).
  const clipNumber = dayProject.nextClipNumber;
  const clipName =
    dayProject.clipPrefix + String(clipNumber).padStart(dayProject.clipPadding, '0') + (dayProject.clipSuffix ?? '');
  const take: Take = {
    id: newId(),
    slateId: input.slateId,
    ...(input.shotId !== undefined ? { shotId: input.shotId } : {}),
    projectId: input.projectId,
    number,
    clipName,
    shootDay,
    shootDayIndex,
    status: 'good',
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return applySound({ ...dayProject, nextClipNumber: clipNumber + 1, updatedAt: now }, take, input, now);
}

// --------------------------------------------------------- bundle order ---
// Every exporter reads `bundle.takes` in the order getBundle hands them over,
// so that order is the timeline. Both backends build it through the helpers
// below rather than each writing their own comparator, the same way they share
// buildTakeClips — the two must stay byte-identical.

/**
 * Flatten every scene's breakdown into one `shotId -> order` lookup, so a take
 * can be ranked by the shot it rolled without walking `slate.shots` on every
 * comparison. Empty for every project with no shots — every take then takes the
 * scene-level rank below and the sort collapses to exactly what it was before.
 */
export function shotOrderIndex(slates: Slate[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const s of slates) {
    if (!s.shots) continue;
    for (const shot of s.shots) index.set(shot.id, shot.order);
  }
  return index;
}

/**
 * Where a take sits among its scene's setups. Scene-level takes (no `shotId` —
 * every legacy take) rank ahead of every shot-scoped one, so a scene that grew
 * a breakdown mid-shoot still lists what was already logged against it first.
 * A `shotId` we can't resolve (the shot was dropped from the breakdown) ranks
 * last rather than colliding with order 0. Both sentinels are finite on
 * purpose: the comparator subtracts, and Infinity - Infinity is NaN.
 */
function takeShotRank(take: Take, shotOrder: Map<string, number>): number {
  if (take.shotId === undefined) return -1;
  return shotOrder.get(take.shotId) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Bundle take order: scene story order, then shot order, then take number.
 * The middle key is not optional decoration — `Take.number` is per SHOT now, so
 * take 1 exists once per setup and sorting on it alone interleaves 5.31 and
 * 5.32 into a nonsense timeline. With no shots in play every rank is the same
 * sentinel and this reduces to the original `slate order || take number`.
 */
export function bundleTakeComparator(
  slateOrder: Map<string, number>,
  shotOrder: Map<string, number>,
): (a: Take, b: Take) => number {
  return (a, b) =>
    (slateOrder.get(a.slateId) ?? 0) - (slateOrder.get(b.slateId) ?? 0) ||
    takeShotRank(a, shotOrder) - takeShotRank(b, shotOrder) ||
    a.number - b.number;
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

// ----------------------------------------------------------- take numbers ---
// `Take.number` is per-PARENT: per shot when the take names one, per scene when
// it does not (see types.ts). Both backends compute it through the two helpers
// below rather than each writing the reduce themselves, so CUT-time numbering
// and reassignment numbering can never drift apart.

/**
 * The next free take number in one parent. `siblings` must already be the
 * parent's takes and nothing else — one shot's takes, or one scene's
 * shot-less takes — because the two sequences are independent.
 *
 * Deliberately max+1, not count+1: a hole in the sequence (a deleted take, or
 * a take moved out to another setup) is left alone. Numbers that have been
 * spoken on set and written on a camera report are never reissued.
 */
export function nextTakeNumber(siblings: Take[]): number {
  return siblings.reduce((max, t) => Math.max(max, t.number), 0) + 1;
}

/** Where a take is being moved to. `shotId` absent = the bare scene itself. */
export interface TakeDestination {
  slateId: string;
  // The shot to file the take under. ABSENT means the destination scene has no
  // breakdown (or the user chose the scene itself), and the take goes back to
  // numbering per scene — the same "absent means legacy" rule as everywhere
  // else. Never stored as an explicit `undefined` key; see below.
  shotId?: string;
}

/**
 * Re-file one take under a different scene/shot, with the take number the
 * destination would have handed it at CUT time.
 *
 * WHAT MOVES: `slateId`, `shotId` and `number`. That is the whole correction.
 *
 * WHAT NEVER MOVES: the clip name(s) and the sound file name. A clip name is a
 * physical fact about what the camera wrote to the card — renaming it here
 * would make Clapper disagree with the media, which is the one thing an editor
 * cannot recover from. Reassignment fixes the ASSOCIATION only. (`rebaseClips`
 * is the tool for a wrong clip NUMBER; the two never overlap.)
 *
 * THE GAP LEFT BEHIND IS DELIBERATE. Moving take 2 of 5.30 away leaves 5.30
 * with takes 1 and 3, and we do NOT close that up. Renumbering the source's
 * survivors would silently rewrite numbers that were called on set, written on
 * the camera report and typed into the editor's bin — a gap is a question
 * someone can answer ("2 went to 5.31"), a shifted number is a wrong answer
 * nobody notices. Same doctrine as `rebaseClipNumbers`: shift/leave, never
 * resequence.
 *
 * `destSiblings` is every take already living in the destination parent; the
 * moved take is filtered out of it, so re-filing a take to where it already is
 * cannot renumber it against itself. Returns the take UNCHANGED (same
 * reference) when the destination is where it already lives, so callers can
 * skip the write entirely — the same "only touch what moved" discipline as
 * `reorderSlateList`.
 */
export function reassignTakeTo(
  take: Take,
  destSiblings: Take[],
  destination: TakeDestination,
  now: number,
): Take {
  if (take.slateId === destination.slateId && take.shotId === destination.shotId) return take;

  const siblings = destSiblings.filter((t) => t.id !== take.id);
  // Strip `shotId` off first: spreading `take` and then writing
  // `shotId: undefined` would leave the KEY present with an empty value, which
  // reads as "has a shot, unknown" to every `!== undefined` check in the app
  // (and lands in IndexedDB's byShot index differently from a legacy row). An
  // absent field is the only way to say "this take belongs to the scene".
  const { shotId: _wasShot, ...rest } = take;
  return {
    ...rest,
    slateId: destination.slateId,
    ...(destination.shotId !== undefined ? { shotId: destination.shotId } : {}),
    number: nextTakeNumber(siblings),
    updatedAt: now,
  };
}

// ------------------------------------------------------- shoot day / wrap ---
// A shoot day is a HUMAN signal, never a clock guess: the operator presses
// WRAP DAY once the day's cards are formatted, and THAT stamps the boundary
// (see the Shoot day section on the project screen). Nothing below ever
// resets a counter off the clock alone: shouldPromptForgottenWrap only
// ANSWERS whether the gap looks like a forgotten wrap; RollingScreen decides
// what to do with that answer, and only ever off the operator's own tap.

/** Local "YYYY-MM-DD" for a moment in time — a day's own label, never a guess about when it ends. */
export function shootDayLabel(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The project's open shoot day, opening day 1 on first touch if none exists
 * yet. Every project gets one lazily this way — a legacy project simply never
 * had one before now, and its PAST takes carry no `shootDay` either way
 * (nothing here ever rewrites them; see buildTakeClips above and the
 * migration note in export/order.ts).
 */
export function openShootDayIfNeeded(project: Project, now: number): Project {
  if (project.openShootDay) return project;
  return { ...project, openShootDay: { index: 1, date: shootDayLabel(now) } };
}

/**
 * Fold in a take's day-tracking side effects: lazily open day 1 if none is
 * open yet, stamp `firstTakeAt` on the day's own first touch and
 * `lastTakeAt` on every touch (what shouldPromptForgottenWrap reads below),
 * and hand back the day's own label AND its own index so the take can carry
 * both. The label alone is not a stable day identity (see Take.shootDayIndex
 * in types.ts — a night shoot can wrap into a next day dated today, then that
 * day wraps again before midnight, landing two different days on one date);
 * the index is what actually tells them apart, and it must be stamped every
 * time the date is.
 */
function noteTakeLogged(
  project: Project,
  now: number,
): { project: Project; shootDay: string; shootDayIndex: number } {
  const opened = openShootDayIfNeeded(project, now);
  const day = opened.openShootDay!;
  const touched: ShootDay = {
    ...day,
    ...(day.firstTakeAt === undefined ? { firstTakeAt: now } : {}),
    lastTakeAt: now,
  };
  return {
    project: { ...opened, openShootDay: touched },
    shootDay: touched.date,
    shootDayIndex: touched.index,
  };
}

const HOUR_MS = 60 * 60 * 1000;
/**
 * Gap since the open day's last take past which logging a NEW take should
 * prompt "forgotten wrap?" rather than silently reusing today's numbers.
 * Named so the prompt copy and this threshold can never drift apart.
 */
export const FORGOTTEN_WRAP_GAP_MS = 6 * HOUR_MS;

/**
 * Does it look like the operator forgot to press WRAP DAY? Pure yes/no — the
 * caller (RollingScreen) decides what to do with the answer and NEVER resets
 * anything off this alone. A day with no take logged yet has nothing to be
 * "late" against, so a project's very first take never fires this.
 */
export function shouldPromptForgottenWrap(
  project: Project,
  now: number,
  gapMs: number = FORGOTTEN_WRAP_GAP_MS,
): boolean {
  const last = project.openShootDay?.lastTakeAt;
  return last !== undefined && now - last > gapMs;
}

/**
 * What a fresh day's counter starts from: the last explicitly configured
 * start, or 1 — "every day restarts at C0001" is the on-set convention this
 * whole feature automates, and a project can override it via the counter
 * screen (see ClipCounterSection/SoundSection in ProjectScreen.tsx).
 */
function resetNumber(configuredStart: number | undefined): number {
  return configuredStart ?? 1;
}

/**
 * WRAP DAY: stamp the wrap time on the day that just closed, reset every
 * counter (camera units, sound, single-cam) back to its configured start, and
 * open the next day. Returns the WHOLE next project — the caller persists it
 * with one `updateProject`, same as every other atomic project mutation here.
 * The reset happens immediately in the object this returns, so the very next
 * read sees C0001 waiting.
 *
 * Only ever called from the operator's own tap: WRAP DAY itself, or their
 * "New day" choice on the forgotten-wrap prompt. Never on a timer.
 */
export function wrapShootDay(project: Project, now: number): { project: Project } {
  const opened = openShootDayIfNeeded(project, now);
  const wrappedDay: ShootDay = { ...opened.openShootDay!, wrappedAt: now };

  const undo: WrapUndoSnapshot = {
    previousDay: wrappedDay,
    ...(opened.cameras && opened.cameras.length > 0
      ? {
          cameras: Object.fromEntries(
            opened.cameras.map((u) => [u.letter, u.nextClipNumber]),
          ) as Partial<Record<CameraUnitLetter, number>>,
        }
      : { nextClipNumber: opened.nextClipNumber }),
    ...(opened.sound ? { soundNextFileNumber: opened.sound.nextFileNumber } : {}),
  };

  const next: Project = {
    ...opened,
    ...(opened.cameras && opened.cameras.length > 0
      ? { cameras: opened.cameras.map((u) => ({ ...u, nextClipNumber: resetNumber(u.clipStart) })) }
      : { nextClipNumber: resetNumber(opened.clipStart) }),
    ...(opened.sound ? { sound: { ...opened.sound, nextFileNumber: resetNumber(opened.sound.fileStart) } } : {}),
    openShootDay: { index: wrappedDay.index + 1, date: shootDayLabel(now) },
    pendingWrapUndo: undo,
    updatedAt: now,
  };
  return { project: next };
}

export type WrapUndoResult = { ok: true; project: Project } | { ok: false; reason: string };

/**
 * Undo the most recent WRAP DAY. Refuses — with a reason to show — once a
 * take has been logged against the new day's counters: by then the numbers
 * mean something, and un-writing them would make Clapper disagree with a clip
 * a camera already wrote. Otherwise restores the exact previous counters and
 * reopens the day that was closed, byte-for-byte.
 */
export function undoWrapShootDay(project: Project, now: number): WrapUndoResult {
  const pending = project.pendingWrapUndo;
  if (!pending) return { ok: false, reason: 'Nothing to undo.' };
  if (project.openShootDay?.firstTakeAt !== undefined) {
    return {
      ok: false,
      reason: 'A take has already been logged on the new day, so its counters are already real.',
    };
  }

  // Reopen the closed day exactly as it was BEFORE the wrap — dropping
  // `wrappedAt` via destructure, not by writing it as an explicit undefined
  // (that would leave the key present-but-empty on a freshly built object,
  // the same trap reassignTakeTo's `shotId` strip avoids above).
  const { wrappedAt: _wrappedAt, ...reopenedDay } = pending.previousDay;

  const restored: Project = {
    ...project,
    // Both halves matter: no snapshot means nothing to restore, and an ABSENT
    // `project.cameras` means the operator dropped back to single-cam between
    // the wrap and the undo. Restoring into `[]` there would state "multi-cam
    // with no units" on a project that no longer has any — a statement nobody
    // made (see the `units: []` note in buildTakeClips).
    ...(pending.cameras && project.cameras
      ? {
          cameras: project.cameras.map((u) =>
            pending.cameras![u.letter] !== undefined ? { ...u, nextClipNumber: pending.cameras![u.letter]! } : u,
          ),
        }
      : {}),
    ...(pending.nextClipNumber !== undefined ? { nextClipNumber: pending.nextClipNumber } : {}),
    ...(project.sound && pending.soundNextFileNumber !== undefined
      ? { sound: { ...project.sound, nextFileNumber: pending.soundNextFileNumber } }
      : {}),
    openShootDay: reopenedDay,
    // Clearing a field through the update-patch merge (`{...existing,
    // ...patch}` in idb.ts/local.ts) needs an EXPLICIT undefined here — the
    // same convention ClipCounterSection/SoundSection already rely on to drop
    // `cameras`/`sound` back out on the very same Project type. Omitting the
    // key would leave the stale snapshot sitting in storage forever.
    pendingWrapUndo: undefined,
    updatedAt: now,
  };
  return { ok: true, project: restored };
}
