// Shared helpers for both store backends (idb + localStorage).

import type { CameraUnit, CameraUnitLetter, Project, Take, TakeClip } from '../types';

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

  // The edited take always takes the typed number verbatim, even where the
  // delta is 0 (reformatting to the unit's current prefix/padding).
  const changed = new Map<string, Take>();
  let edited = ordered[editedAt];
  for (const u of units) {
    const target = newNumbers[u.letter];
    if (target === undefined) continue;
    edited = withClipNumber(edited, u, Math.max(0, Math.trunc(target)));
  }
  changed.set(edited.id, { ...edited, updatedAt: now });

  if (deltas.size === 0) {
    return { takes: [...changed.values()], project };
  }

  for (let i = editedAt + 1; i < ordered.length; i++) {
    let take = ordered[i];
    for (const u of units) {
      const delta = deltas.get(u.letter);
      if (delta === undefined) continue;
      take = withClipNumber(take, u, Math.max(0, takeClipNumber(take, u) + delta));
    }
    if (take !== ordered[i]) changed.set(take.id, { ...take, updatedAt: now });
  }

  // The live counter is just "the next file this camera will write" — it rides
  // the same shift, or the very next CUT reintroduces the error.
  let nextProject: Project;
  if (project.cameras && project.cameras.length > 0) {
    nextProject = {
      ...project,
      cameras: project.cameras.map((u) => {
        const delta = deltas.get(u.letter);
        return delta === undefined ? u : { ...u, nextClipNumber: Math.max(0, u.nextClipNumber + delta) };
      }),
      updatedAt: now,
    };
  } else {
    const delta = deltas.get('A') ?? 0;
    nextProject = { ...project, nextClipNumber: Math.max(0, project.nextClipNumber + delta), updatedAt: now };
  }

  return { takes: [...changed.values()], project: nextProject };
}

/** The CUT-time inputs a take is built from (mirrors Store.createTake's arg). */
export interface TakeInput {
  slateId: string;
  projectId: string;
  startedAt: number;
  durationMs: number;
  cameraTC?: string;
  note?: string;
}

/**
 * Build the take (and the project with its clip counter(s) advanced) at CUT.
 * Pure and backend-agnostic so idb + localStorage stay byte-identical.
 *
 * Single-cam (no `project.cameras`): consumes the top-level `nextClipNumber`,
 * exactly as before — one clip in `clipName`, no `clips` array.
 * Multi-cam: consumes EACH camera unit's own counter, records one clip per unit
 * in `clips`, mirrors unit A's clip into `clipName`, and advances every unit.
 */
export function buildTakeClips(
  project: Project,
  number: number,
  input: TakeInput,
  now: number,
): { take: Take; project: Project } {
  const units = project.cameras;

  if (units && units.length > 0) {
    const clips: TakeClip[] = units.map((u) => ({
      unit: u.letter,
      clipName: formatClip(u.clipPrefix, u.nextClipNumber, u.clipPadding, u.clipSuffix),
    }));
    const advanced = units.map((u) => ({ ...u, nextClipNumber: u.nextClipNumber + 1 }));
    const take: Take = {
      id: newId(),
      slateId: input.slateId,
      projectId: input.projectId,
      number,
      clipName: clips[0].clipName,
      clips,
      status: 'good',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return { take, project: { ...project, cameras: advanced, updatedAt: now } };
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
  return { take, project: { ...project, nextClipNumber: clipNumber + 1, updatedAt: now } };
}
