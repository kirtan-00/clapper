// WHAT THE NEW PROJECT FLOW IS BUILDING, as a value with no React in it.
//
// The staged sheet (NewProjectSheet.tsx) is five screens over ONE draft, and
// the only interesting thing it does is turn that draft into the argument
// `store.createProject` takes. That turn is here, on its own, because it is
// the part that can be WRONG in a way nobody sees: a fourth camera that never
// made it onto the object, an operator lost to a stray space, a Sound unit
// written for a project whose owner said no. A screenshot cannot catch any of
// those. A test on a plain object can, and does — see projectdraft.test.ts.
//
// TWO INVARIANTS, LIFTED VERBATIM FROM THE FOURTEEN-FIELD SHEET THIS REPLACES:
//
//   ONE CAMERA WRITES NO `cameras` ARRAY. A single-cam project carries its
//   clip pattern in the top-level fields and nothing else, which is what every
//   legacy code path already expects (see isMultiCam in types.ts).
//
//   MULTI-CAM STILL POPULATES THE TOP LEVEL, from unit A. The Project contract
//   promises those fields on every project; unit A is the one whose numbers
//   they mirror.
//
// UNITS DO NOT CARRY THEIR LETTER IN THE DRAFT. The letter is POSITION — A is
// the first unit, D is the fourth (types.ts: "auto-assigned by position") — so
// the draft holds an ordered list and the letters are derived at build time.
// That is also the only correct removal semantics: drop B from A,B,C and the
// old C becomes B, because there is no such rig as A, C.

import type { Fps, Project } from '../types';
import { MAX_CAMERAS } from '../types';
import { clampClipNumber, findPreset, makeCameraUnit, renderClip, UNIT_LETTERS } from './cameras';

/** One camera the operator has set up, before it knows which letter it is. */
export interface UnitDraft {
  /** CameraPreset id, e.g. "sony". */
  camera: string;
  /** Free text; empty means nobody was named, which is allowed. */
  operator: string;
  /**
   * The number this unit's next clip will carry, as TYPED. A string so the
   * field can sit empty mid-edit, exactly the shape ProjectScreen's own clip
   * counter uses. Validated with clampClipNumber (cameras.ts) at every read,
   * never at every keystroke, so a stray character does not fight the person
   * typing it.
   */
  startNumber: string;
}

/** The recorder, when the shoot has one. Null on the project means no sound. */
export interface SoundDraft {
  recorder: string;
  operator: string;
  filePrefix: string;
}

export interface ProjectDraft {
  name: string;
  fps: Fps;
  /** 1..MAX_CAMERAS, in letter order. Index 0 is unit A and always exists. */
  units: UnitDraft[];
  /** null = this project logs no sound. */
  sound: SoundDraft | null;
  tags: string[];
}

export const DEFAULT_UNIT_CAMERA = 'sony';
export const DEFAULT_START_NUMBER = '1';
export const DEFAULT_SOUND_PREFIX = 'SND_';
export const DEFAULT_SOUND_EXT = '.WAV';
export const DEFAULT_SOUND_PADDING = 4;

/** A fresh draft: one camera, no sound, nothing typed. */
export function emptyDraft(tags: string[]): ProjectDraft {
  return {
    name: '',
    fps: 24,
    units: [{ camera: DEFAULT_UNIT_CAMERA, operator: '', startNumber: DEFAULT_START_NUMBER }],
    sound: null,
    tags,
  };
}

export function newSoundDraft(): SoundDraft {
  return { recorder: '', operator: '', filePrefix: DEFAULT_SOUND_PREFIX };
}

/** The letter this position gets. Position IS the letter. */
export function letterAt(index: number): (typeof UNIT_LETTERS)[number] {
  return UNIT_LETTERS[Math.min(Math.max(0, index), UNIT_LETTERS.length - 1)];
}

export function canAddUnit(draft: ProjectDraft): boolean {
  return draft.units.length < MAX_CAMERAS;
}

/** A new unit on the end, copying nothing from the one before it. Capped. */
export function addUnit(draft: ProjectDraft): ProjectDraft {
  if (!canAddUnit(draft)) return draft;
  return {
    ...draft,
    units: [...draft.units, { camera: DEFAULT_UNIT_CAMERA, operator: '', startNumber: DEFAULT_START_NUMBER }],
  };
}

/** Drop one unit. A (index 0) is the shoot itself and cannot go. */
export function removeUnit(draft: ProjectDraft, index: number): ProjectDraft {
  if (index <= 0 || index >= draft.units.length) return draft;
  return { ...draft, units: draft.units.filter((_, i) => i !== index) };
}

export function setUnit(draft: ProjectDraft, index: number, patch: Partial<UnitDraft>): ProjectDraft {
  return { ...draft, units: draft.units.map((u, i) => (i === index ? { ...u, ...patch } : u)) };
}

/** The clip name a unit's camera writes on its NEXT take, extension included.
 *  Driven by the starting clip number actually typed for this unit, not a
 *  fixed 1, so the preview is what the camera body will really write. */
export function unitExample(unit: UnitDraft): string {
  const p = findPreset(unit.camera);
  if (!p) return '';
  return renderClip(p.prefix, clampClipNumber(unit.startNumber), p.digits, p.suffix) + p.ext;
}

/** The recorder's first file name, extension included. */
export function soundExample(sound: SoundDraft): string {
  const prefix = sound.filePrefix.trim() || DEFAULT_SOUND_PREFIX;
  return renderClip(prefix, 1, DEFAULT_SOUND_PADDING, '') + DEFAULT_SOUND_EXT;
}

/** A draft can be created once it has been named. Everything else has a default. */
export function isReady(draft: ProjectDraft): boolean {
  return draft.name.trim().length > 0;
}

/**
 * The draft as the argument `store.createProject` takes.
 *
 * The numbering details (padding, suffix, extension) come from the camera
 * preset and are not asked for here: they are editable on the project screen
 * a second after this closes, and asking for four cameras' worth of padding
 * on a phone is the fourteen-field form again wearing a rail. The START
 * NUMBER is the one exception: it is what the operator actually typed per
 * unit (clamped, never a bare preset guess), because that number is the one
 * thing a preset genuinely cannot know: it is whatever the camera body
 * already shows.
 */
export function buildProjectConfig(draft: ProjectDraft): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
  const units = draft.units.slice(0, MAX_CAMERAS);
  // Built for every unit including A, because A's numbers are what the
  // top-level fields mirror — deriving them twice from the same preset is how
  // the two copies drift.
  const built = units.map((u, i) =>
    makeCameraUnit(letterAt(i), u.camera, clampClipNumber(u.startNumber), u.operator),
  );
  const a = built[0];
  const sound = draft.sound;
  const soundPrefix = sound ? sound.filePrefix.trim() || DEFAULT_SOUND_PREFIX : '';

  return {
    name: draft.name.trim(),
    fps: draft.fps,
    camera: a.camera ?? DEFAULT_UNIT_CAMERA,
    clipPrefix: a.clipPrefix,
    clipSuffix: a.clipSuffix ?? '',
    clipExt: a.clipExt ?? '',
    clipPadding: a.clipPadding,
    nextClipNumber: a.nextClipNumber,
    // ONE camera is single-cam and writes no array at all.
    ...(built.length >= 2 ? { cameras: built } : {}),
    ...(sound
      ? {
          sound: {
            filePrefix: soundPrefix,
            nextFileNumber: 1,
            filePadding: DEFAULT_SOUND_PADDING,
            fileExt: DEFAULT_SOUND_EXT,
            ...(sound.recorder.trim() ? { recorder: sound.recorder.trim() } : {}),
            ...(sound.operator.trim() ? { operator: sound.operator.trim() } : {}),
          },
        }
      : {}),
    tags: draft.tags,
  };
}

/**
 * The same build, plus the one thing a Podcast-flow draft needs that
 * `buildProjectConfig` cannot know on its own: the `mode: 'podcast'` marker.
 * Kept as a thin wrapper rather than a flag on `buildProjectConfig` so a
 * caller building a normal project can never forget to pass "no": there is
 * no argument to forget.
 */
export function buildPodcastProjectConfig(draft: ProjectDraft): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
  return { ...buildProjectConfig(draft), mode: 'podcast' };
}
