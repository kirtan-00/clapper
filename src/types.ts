// Clapper shared contract. Every module codes against THIS file only.
// Do not import UI code from store/engine/export; they are UI-free.

export type Fps = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

/** A/B/C/D camera unit letters, auto-assigned by position. */
export type CameraUnitLetter = 'A' | 'B' | 'C' | 'D';

/**
 * One camera in a multi-cam shoot. Each unit carries its OWN independent clip
 * counter (same shape as the project's single-cam fields) that advances on its
 * own at every CUT. Two units of the same type natively write identical
 * filenames — that is expected; the UNIT LETTER (carried as the FCP7 reel/tape
 * name on export) is what disambiguates them, never a filename change.
 */
export interface CameraUnit {
  letter: CameraUnitLetter;
  camera?: string;         // camera preset id the clip format came from, e.g. "sony"
  clipPrefix: string;
  nextClipNumber: number;  // advances on this unit's own CUTs
  clipPadding: number;
  clipSuffix?: string;
  clipExt?: string;
  operator?: string;       // who is running this camera; shown on its slot while shooting
}

export interface Project {
  id: string;
  name: string;
  fps: Fps;
  clipPrefix: string;      // e.g. "C" or "A001_"
  nextClipNumber: number;  // incremented on every CUT and DISCARD
  clipPadding: number;     // C0042 -> padding 4
  clipSuffix?: string;     // static tail after the counter, e.g. "_*" (RED) or "_D" (DJI)
  clipExt?: string;        // media file extension incl. dot, e.g. ".MP4" / ".R3D" — lets Premiere relink
  camera?: string;         // camera preset id the clip format came from, e.g. "sony"
  // Multi-cam: 2-4 camera units, A..D by position. ABSENT for single-cam
  // projects, which keep behaving EXACTLY through the top-level clip fields
  // above. Present (length >= 2) switches the app into multi-cam mode.
  cameras?: CameraUnit[];
  tags: string[];          // quick-tag chips, default ["FLUB","GOLD","PICKUP","NOISE"]
  createdAt: number;
  updatedAt: number;
}

export const MAX_CAMERAS = 4;

/**
 * Multi-cam is active only when a project carries 2+ camera units. A missing
 * `cameras` array (every legacy/saved project) or a single unit is single-cam
 * and runs every original code path untouched.
 */
export function isMultiCam(p: Pick<Project, 'cameras'>): boolean {
  return !!(p.cameras && p.cameras.length >= 2);
}

/**
 * A tap chip attached to a scene. Two tiers, rendered as two rows on the
 * rolling screen: `coverage` (WIDE/CU/OTS…, cool/neutral, roughly the same on
 * every scene) and `keyMoment` (script-derived beats an editor cares about,
 * amber). Populated by Script Mode from a script pack; a hand-made scene just
 * has none and falls back to the project's quick tags.
 */
export type SlateTagTier = 'coverage' | 'keyMoment';

export interface SlateTag {
  id: string;
  label: string;           // chip text; keep short-ish, one line on a phone
  tier: SlateTagTier;
  order: number;           // display order within its tier
}

export interface Slate {
  id: string;
  projectId: string;
  name: string;
  order: number;
  /**
   * On-set shooting order, set only once someone drags a scene in the scene
   * list. Absent for every slate until then — including every slate saved
   * before this feature existed — so a project nobody has reordered behaves
   * exactly as it always has. Story order (`order`) is what every exporter
   * sorts by and is NEVER touched by dragging; `shootOrder` exists purely so
   * the on-set list can show shooting chronology without disturbing it.
   */
  shootOrder?: number;
  summary?: string;        // Script Mode: one-line recognizer for the operator
  scriptRef?: string;      // Script Mode: source scene id, e.g. "SC 12"
  tags?: SlateTag[];       // Script Mode: per-scene tap chips (both tiers)
  createdAt: number;
  updatedAt: number;
}

export type TakeStatus = 'good' | 'discarded';

/** One camera unit's clip within a multi-cam take. */
export interface TakeClip {
  unit: CameraUnitLetter;  // A/B/C/D
  clipName: string;        // that camera's native clip name captured at roll time
  // Independent per-camera rolling: this unit may have started after the take
  // did (joined mid-take) and stopped before the take closed. Both optional so
  // every take saved before this feature keeps loading/exporting unchanged:
  // missing = "started with the take" (0) / "ran the whole take" (take.durationMs).
  startOffsetMs?: number;  // ms after Take.startedAt that THIS unit began rolling
  durationMs?: number;     // how long THIS unit rolled, in ms
}

export interface Take {
  id: string;
  slateId: string;
  projectId: string;
  number: number;          // per-slate, auto-increment
  clipName: string;        // e.g. "C0042", assigned at CUT. Multi-cam: unit A's clip
  // Multi-cam: one clip per camera unit (incl. A), captured together at CUT.
  // ABSENT for single-cam takes, which carry their single clip in clipName only.
  clips?: TakeClip[];
  status: TakeStatus;
  startedAt: number;       // epoch ms
  durationMs: number;
  cameraTC?: string;       // "HH:MM:SS:FF" at take start, optional
  note?: string;           // one-liner added at cut
  createdAt: number;
  updatedAt: number;
}

export type MomentKind = 'point' | 'range';

export interface Moment {
  id: string;
  takeId: string;
  kind: MomentKind;
  atMs: number;            // ms into the take
  endMs?: number;          // ranges only
  label: string;           // "" for bare tag taps
  tag?: string;            // one of project.tags, optional
  createdAt: number;
  updatedAt: number;
}

/** Everything belonging to one project, denormalized for exports. */
export interface ProjectBundle {
  project: Project;
  slates: Slate[];
  takes: Take[];
  moments: Moment[];
}

// ---------------------------------------------------------------- store ---

export interface Store {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  createProject(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<void>; // cascades slates/takes/moments

  listSlates(projectId: string): Promise<Slate[]>; // ordered by .order
  createSlate(projectId: string, name: string): Promise<Slate>;
  updateSlate(id: string, patch: Partial<Slate>): Promise<Slate>;
  deleteSlate(id: string): Promise<void>; // cascades takes/moments
  /**
   * Stamp the on-set shooting order onto a project's scenes as ONE atomic
   * write. `orderedSlateIds` must be the project's full current scene list,
   * in the new on-set order the UI wants to persist — each id's index becomes
   * its `shootOrder`. Never touches `.order` (story order). Returns only the
   * slates whose `shootOrder` actually changed (a drag that lands back where
   * it started writes nothing). Follows the same "atomic, minimal-diff" shape
   * as `rebaseClips` — never N separate `updateSlate` calls from the UI.
   */
  reorderSlates(projectId: string, orderedSlateIds: string[]): Promise<Slate[]>;

  listTakes(slateId: string): Promise<Take[]>; // ordered by .number
  /**
   * Create the take at CUT time: assigns per-slate take number AND consumes
   * the project clip counter (nextClipNumber++), returning the take with
   * clipName already formatted (prefix + padded number). Atomic.
   */
  createTake(input: {
    slateId: string;
    projectId: string;
    startedAt: number;      // when the FIRST camera rolled
    durationMs: number;     // first roll to last cut, across every participating unit
    cameraTC?: string;
    note?: string;
    // Multi-cam only: which units actually rolled this take, and each one's own
    // timing. ABSENT (or omitted) means "every configured unit rolled together,
    // full take duration, no offset" - the big-ROLL common case, and also what a
    // single-cam project always gets (units is meaningless there and ignored).
    units?: { unit: CameraUnitLetter; startOffsetMs: number; durationMs: number }[];
  }): Promise<Take>;
  updateTake(id: string, patch: Partial<Take>): Promise<Take>;
  /**
   * Correct a mis-logged clip number on one take and carry the correction
   * forward: every LATER take on that camera unit shifts by the same delta, and
   * so does the unit's live counter. Atomic. Returns the updated project.
   */
  rebaseClips(
    projectId: string,
    takeId: string,
    newNumbers: Partial<Record<CameraUnitLetter, number>>,
  ): Promise<{ project: Project; shifted: number }>;
  deleteTake(id: string): Promise<void>; // cascades the take's moments

  listMoments(takeId: string): Promise<Moment[]>; // ordered by atMs
  createMoment(m: Omit<Moment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Moment>;
  updateMoment(id: string, patch: Partial<Moment>): Promise<Moment>;
  deleteMoment(id: string): Promise<void>;

  getBundle(projectId: string): Promise<ProjectBundle>;
}

// --------------------------------------------------------------- engine ---

/** Timer derives from Date.now() - startedAt; never interval accumulation. */
export interface RollTimer {
  rolling: boolean;
  startedAt: number | null;
  elapsedMs: number;       // live, updated ~10fps while rolling
  start(): void;
  /** returns {startedAt, durationMs} of the finished roll */
  stop(): { startedAt: number; durationMs: number };
}

export type SpeechCommand = 'roll' | 'cut';

export interface SpeechListener {
  supported: boolean;
  listening: boolean;
  start(): void;
  stop(): void;
  /** fires on recognized keyword; UI decides what to do with it */
  onCommand(cb: (cmd: SpeechCommand) => void): () => void;
  onStateChange(cb: (listening: boolean) => void): () => void;
}

// --------------------------------------------------------------- export ---

export interface Exporter {
  /** Editor-facing PDF. */
  toPdf(bundle: ProjectBundle): Promise<Blob>;
  /** FCP7 xmeml Premiere imports natively; markers per moment. */
  toFcpXml(bundle: ProjectBundle): Blob;
  /** FCPXML (Final Cut Pro X format) DaVinci Resolve imports natively. */
  toResolveXml(bundle: ProjectBundle): Blob;
  /** Flat CSV of all moments/takes. */
  toCsv(bundle: ProjectBundle): Blob;
}

// timecode.ts contract
export interface TimecodeUtil {
  /** ms -> "MM:SS" or "H:MM:SS" for UI display */
  msToClock(ms: number): string;
  /** ms offset -> "HH:MM:SS:FF" at fps (drop-frame for 29.97/59.94) */
  msToTimecode(ms: number, fps: Fps): string;
  /** "HH:MM:SS:FF" -> frame count at fps; throws on malformed input */
  timecodeToFrames(tc: string, fps: Fps): number;
  framesToTimecode(frames: number, fps: Fps): string;
  /** cameraTC start + ms offset -> camera TC string at fps */
  addMsToTimecode(tc: string, ms: number, fps: Fps): string;
  isValidTimecode(tc: string): boolean;
}
