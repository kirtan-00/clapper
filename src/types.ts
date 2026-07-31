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
  // The number WRAP DAY resets this unit's `nextClipNumber` back to. Set
  // whenever the counter is explicitly (re)configured on the project screen —
  // that is the human confirming "this is where this camera starts counting".
  // ABSENT defaults to 1: "every day restarts at C0001", the on-set
  // convention this whole feature automates.
  clipStart?: number;
}

/**
 * The production sound recorder — ONE per project, independent of camera count.
 * A single-cam doc shoot still has its own mixer, so sound is ORTHOGONAL to the
 * `cameras` array and to isMultiCam(). ABSENT = the project logs no sound (every
 * legacy project). PRESENT = a Sound unit rolls alongside the cameras with its
 * OWN monotonic file counter — advancing on every CUT and DISCARD it rolled,
 * exactly like a camera clip counter — and exports as the sync AUDIO track, not
 * as a picture angle. It is never a member of `cameras` and never a
 * CameraUnitLetter, so no picture-side code (isMultiCam, video export tracks,
 * the camera columns) ever mistakes it for an angle.
 */
export interface SoundUnit {
  filePrefix: string;      // e.g. "SND_"
  nextFileNumber: number;  // advances on every CUT/DISCARD the recorder rolled
  filePadding: number;     // SND_0042 -> padding 4
  fileSuffix?: string;     // static tail after the counter, if the recorder adds one
  fileExt?: string;        // media extension incl. dot, e.g. ".WAV" — lets the NLE relink
  recorder?: string;       // recorder model, optional (e.g. "MixPre-6")
  operator?: string;       // the sound mixer's name; shown on the sound slot + PDF header
  // Mirrors CameraUnit.clipStart for the recorder's own counter: what WRAP DAY
  // resets `nextFileNumber` back to. ABSENT defaults to 1.
  fileStart?: number;
}

/**
 * One shoot day's own bookkeeping. WHO decides a day ended is a human — the
 * operator presses WRAP DAY once the day's cards are formatted — never a
 * clock guess (see the design note on the project screen's Shoot day
 * section). Every field but `index`/`date` is optional: a day nothing has
 * been logged against yet has neither timestamp, and one still open has no
 * `wrappedAt`.
 */
export interface ShootDay {
  index: number;          // 1-based: day 1, day 2, day 3…
  date: string;            // "YYYY-MM-DD" — this day's own label, set when it opened
  firstTakeAt?: number;     // epoch ms of this day's first logged take
  lastTakeAt?: number;      // epoch ms of this day's most recent logged take — what the "forgotten wrap" gap check measures against
  wrappedAt?: number;       // epoch ms WRAP DAY was pressed; ABSENT while the day is still open
}

/**
 * Exactly what WRAP DAY reset, kept so the very next action can put it back.
 * Undo trusts this only until `openShootDay.firstTakeAt` gets set on the new
 * day — once a take has been logged against the fresh numbers, they mean
 * something, and undo must refuse rather than un-write something real.
 */
export interface WrapUndoSnapshot {
  previousDay: ShootDay;                                // the day that just closed, exactly as it was at that moment (wrappedAt included)
  nextClipNumber?: number;                               // single-cam project's own counter, pre-reset
  cameras?: Partial<Record<CameraUnitLetter, number>>;    // multi-cam: each unit's counter, pre-reset
  soundNextFileNumber?: number;                           // present only if the project carries a Sound unit
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
  // Production sound: a single independent recorder unit, orthogonal to camera
  // count. ABSENT = project logs no sound (every legacy project, untouched).
  sound?: SoundUnit;
  tags: string[];          // quick-tag chips, default ["FLUB","GOLD","PICKUP","NOISE"]
  // Shoot-day tracking (see WRAP DAY on the project screen): the currently
  // open day. ABSENT on every project this feature has never touched — the
  // very first take logged after it ships opens day 1 automatically (see
  // store/util.ts's buildTakeClips). Never bulk-migrated onto old projects;
  // their past takes simply carry no `Take.shootDay` (see the migration note
  // there and in export/order.ts).
  openShootDay?: ShootDay;
  // What the most recent WRAP DAY reset, kept only until it can no longer be
  // safely undone. ABSENT once nothing is pending (nobody has wrapped yet, or
  // the pending wrap was already undone).
  pendingWrapUndo?: WrapUndoSnapshot;
  // Mirrors CameraUnit.clipStart for a single-cam project's own top-level
  // counter. ABSENT defaults to 1.
  clipStart?: number;
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

/** A project logs production sound only when it carries a Sound unit. */
export function hasSound(p: Pick<Project, 'sound'>): boolean {
  return !!p.sound;
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

/**
 * One camera setup inside a scene — the middle level of Scene > Shot > Take.
 * A scene is a location+time; a SHOT is one setup within it ("5.31, MCU, push
 * in"); a TAKE is one roll of that setup. Shots come from a shotlist document
 * and carry the code exactly as printed there, so what the operator taps
 * matches what the AD is reading off paper.
 *
 * Shots live INSIDE their Slate (see `Slate.shots`) rather than in their own
 * table, the same way `Slate.tags` already does — so no sync table, no IndexedDB
 * version bump, and a scene with no shots keeps behaving exactly as it always
 * has.
 */
export interface Shot {
  id: string;
  code: string;            // "5.31" — as printed on the shotlist
  order: number;           // position within the scene
  size?: string;           // "MCU", "XWS", "OTS (over Ansh)"
  move?: string;           // "STATIC, low", "HANDHELD, drifting", "Slow PUSH IN"
  action?: string;         // one-line recognizer shown on the roll screen
  dialogue?: string;       // the line, when the shotlist carries one
  note?: string;           // the shotlist's NOTES column
  tags?: SlateTag[];       // per-shot chips; falls back to the scene's when absent
}

export interface Slate {
  id: string;
  projectId: string;
  name: string;
  order: number;
  /**
   * The scene's shot breakdown, in shooting-list order. ABSENT for every scene
   * made by hand and every project saved before shots existed — those log takes
   * straight against the scene, exactly as before. PRESENT means the rolling
   * screen scopes takes to the selected shot and numbers them per shot.
   */
  shots?: Shot[];
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
  // Call sheet: true when this scene was on the most recently loaded call
  // sheet (today's shoot). Absent/false for every other scene. Recomputed in
  // full each time a call sheet is loaded, so it always reflects the latest.
  today?: boolean;
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

/**
 * The sound recorder's file for a take. Sound typically rolls FIRST ("sound
 * speed" before "roll camera"), so its startOffsetMs is usually 0 and the
 * cameras carry the positive offsets — but the same per-unit timing model as
 * TakeClip applies, stored the same way. Missing timing fields mean "rolled
 * with the take, full duration", the same convention as TakeClip.
 */
export interface TakeSound {
  fileName: string;        // the recorder's file captured at roll, e.g. "SND_0042"
  startOffsetMs?: number;  // ms after Take.startedAt that the recorder began rolling
  durationMs?: number;     // how long the recorder rolled, in ms
}

export interface Take {
  id: string;
  slateId: string;
  /**
   * The shot this take rolled, when the scene has a shot breakdown. ABSENT for
   * takes logged against a bare scene (every legacy take, and every hand-made
   * scene) — those keep numbering per scene. `slateId` above stays populated
   * either way, so every exporter's scene lookup and every delete cascade works
   * unchanged whether or not shots are in play.
   */
  shotId?: string;
  projectId: string;
  /**
   * Auto-increment within the take's parent: per SHOT when `shotId` is set,
   * per SCENE when it is not. So 5.31 gets takes 1,2,3 and 5.32 starts at 1
   * again — correct slate practice, and why exporters must sort by shot order
   * before take number.
   */
  number: number;
  clipName: string;        // e.g. "C0042", assigned at CUT. Multi-cam: unit A's clip
  // Multi-cam: one clip per camera unit (incl. A), captured together at CUT.
  // ABSENT for single-cam takes, which carry their single clip in clipName only.
  clips?: TakeClip[];
  // Production sound: the recorder's file for this take. ABSENT if sound did not
  // roll (or the project has no Sound unit). Orthogonal to `clips`.
  sound?: TakeSound;
  status: TakeStatus;
  startedAt: number;       // epoch ms
  durationMs: number;
  cameraTC?: string;       // "HH:MM:SS:FF" at take start, optional
  note?: string;           // one-liner added at cut
  // The shoot day this take belongs to ("YYYY-MM-DD"), stamped from the
  // project's open day at CUT time — a human WRAP, never a clock guess (see
  // types.ts's ShootDay). ABSENT = a take logged before this feature existed;
  // exporters derive a DISPLAY-only date from `startedAt` for those instead
  // of bulk-rewriting this field in (see export/order.ts and the migration
  // note in store/util.ts).
  shootDay?: string;
  /**
   * The shoot day's own IDENTITY number (ShootDay.index), snapshotted at the
   * same CUT that stamps `shootDay` above. `shootDay` alone is NOT a stable
   * day identity: a night shoot that wraps at 00:30 opens the next day dated
   * the new calendar date, and if THAT day is also shot and wrapped before
   * midnight, it opens ANOTHER new day carrying the exact same date string —
   * two different physical days, one date. Exporters that keyed on `shootDay`
   * alone silently collapsed both days' C0001 into one file, relinking the
   * editor to the wrong physical card (see the dedupe keys in fcpxml.ts /
   * resolve.ts). ABSENT = a take logged before this field existed — every
   * take before this fix, same as every take before `shootDay` itself — and
   * those must keep colliding on `shootDay` alone exactly as they always have.
   */
  shootDayIndex?: number;
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
    /**
     * The shot being rolled, when the scene has a breakdown. Omitted = the take
     * belongs to the scene itself and numbers per scene, as it always has.
     */
    shotId?: string;
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
    // Sound (orthogonal to cameras): present when the Sound unit rolled this
    // take, carrying its own timing. ABSENT = sound did not roll. Ignored if the
    // project has no `sound` unit.
    sound?: { startOffsetMs: number; durationMs: number };
  }): Promise<Take>;
  updateTake(id: string, patch: Partial<Take>): Promise<Take>;
  /**
   * Correct a mis-logged clip number on one take and carry the correction
   * forward: every LATER take on that camera unit shifts by the same delta, and
   * so does the unit's live counter. Atomic. Returns the updated project.
   *
   * `soundNumber` corrects the take's SOUND file number the same way — later
   * takes that recorded sound shift by the same delta, and the sound counter
   * with them. Ignored if the project has no Sound unit or the take has no sound.
   */
  rebaseClips(
    projectId: string,
    takeId: string,
    newNumbers: Partial<Record<CameraUnitLetter, number>>,
    soundNumber?: number,
  ): Promise<{ project: Project; shifted: number }>;
  /**
   * Re-file a take under a different scene and/or shot — the fix for the take
   * that got rolled while the operator was still on the previous setup.
   *
   * Moves `slateId`, `shotId` and `number` and NOTHING else: the clip name(s)
   * and the sound file name are what the camera and the recorder actually
   * wrote, so they stay exactly as logged (use `rebaseClips` for a wrong clip
   * NUMBER). Moments follow for free — a Moment points at its `takeId`, never
   * at a scene or a shot.
   *
   * The take gets the next free number in its DESTINATION, computed inside the
   * same transaction that writes it, the way `createTake` does. The number it
   * vacates in the source is left as a gap on purpose (see `reassignTakeTo` in
   * store/util.ts): the source's other takes are never resequenced.
   *
   * Omit `shotId` to file the take against the scene itself — the destination
   * has no breakdown, or the take genuinely belongs to no setup. Atomic.
   * Returns the take as it now stands.
   */
  reassignTake(takeId: string, destination: { slateId: string; shotId?: string }): Promise<Take>;
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
