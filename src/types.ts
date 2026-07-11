// Clapper shared contract. Every module codes against THIS file only.
// Do not import UI code from store/engine/export; they are UI-free.

export type Fps = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

export interface Project {
  id: string;
  name: string;
  fps: Fps;
  clipPrefix: string;      // e.g. "C" or "A001_"
  nextClipNumber: number;  // incremented on every CUT and DISCARD
  clipPadding: number;     // C0042 -> padding 4
  clipSuffix?: string;     // static tail after the counter, e.g. "_*" (RED) or "_D" (DJI)
  camera?: string;         // camera preset id the clip format came from, e.g. "sony"
  tags: string[];          // quick-tag chips, default ["FLUB","GOLD","PICKUP","NOISE"]
  createdAt: number;
  updatedAt: number;
}

export interface Slate {
  id: string;
  projectId: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type TakeStatus = 'good' | 'discarded';

export interface Take {
  id: string;
  slateId: string;
  projectId: string;
  number: number;          // per-slate, auto-increment
  clipName: string;        // e.g. "C0042", assigned at CUT
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

  listTakes(slateId: string): Promise<Take[]>; // ordered by .number
  /**
   * Create the take at CUT time: assigns per-slate take number AND consumes
   * the project clip counter (nextClipNumber++), returning the take with
   * clipName already formatted (prefix + padded number). Atomic.
   */
  createTake(input: {
    slateId: string;
    projectId: string;
    startedAt: number;
    durationMs: number;
    cameraTC?: string;
    note?: string;
  }): Promise<Take>;
  updateTake(id: string, patch: Partial<Take>): Promise<Take>;

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
