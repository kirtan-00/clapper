// Crash recovery for an IN-FLIGHT take. See RollingScreen.tsx's own comments
// on RollSnapshot for the sibling feature this borrows its shape from (undo
// after a mis-cut) — this file exists because that one only survives a
// re-render, not a killed tab.
//
// THE BUG THIS FIXES: a take is written to IndexedDB at CUT, not at ROLL.
// Everything between ROLL and CUT — start time, every tag tap, every
// MARK IN/OUT, buffered moments — lives only in React state, in RAM. If iOS
// reclaims the tab mid-take (a call, the camera app, memory pressure), the
// take is gone. Cloud sync cannot help: src/net/sync.ts only drains records
// already committed to IndexedDB, and a take that never reached CUT never
// reached the outbox either.
//
// WHY LOCALSTORAGE, NOT INDEXEDDB: IndexedDB is asynchronous — a transaction
// opened moments before the tab dies may never commit. localStorage.setItem
// is synchronous; the write is done before the next line of JS runs. An
// in-flight take is a few hundred bytes, well inside what a synchronous write
// can afford on every tag tap. This is the entire reason the approach works —
// do not "upgrade" it to an async store.
//
// WHY WALL-CLOCK (Date.now()), NOT ELAPSED OR performance.now(): both of
// those reset (or stop meaning anything) across the exact kind of restart
// this file exists to survive. A wall-clock start lets elapsed time be
// recomputed as `now - takeStartedAt` from any later moment, gap included.
//
// LAYERING: this module lives in src/engine, which — like the rest of
// src/engine — depends only on src/types, never on src/store or src/ui (see
// src/engine/speech.ts and rollTimer.ts for the existing precedent). Shapes
// that structurally mirror a store or UI type (CheckpointMoment mirrors
// RollingScreen's `Buffered`; CheckpointUnitRoll mirrors store/util.ts's
// `TakeUnitRoll`) are duplicated here on purpose rather than imported, so
// this file — the thing standing between a crash and a lost take — never
// grows a dependency on the modules most likely to change underneath it.

import type { CameraUnitLetter, MomentKind } from '../types';

export const CHECKPOINT_KEY = 'clapper.rollCheckpoint';
const CHECKPOINT_VERSION = 1 as const;

/**
 * A staleness threshold, not a correctness one — it only decides whether
 * "Still rolling" is offered, never whether the checkpoint is trusted.
 *
 * 45 minutes: longer than the interruptions this feature actually targets
 * (an incoming call, checking a frame in the camera app, the phone locking
 * itself) so a real still-rolling take is never wrongly refused its own
 * option — and short enough that past it, no camera battery or card is
 * plausibly still turning on a take nobody has touched. Past this window the
 * honest assumption is that the shoot moved on without this device, not that
 * a single take ran 45+ minutes untouched (no tag, no mark) with the phone
 * unreachable the entire time.
 */
export const STALE_MS = 45 * 60 * 1000;

/** One not-yet-persisted moment. Mirrors RollingScreen's `Buffered` shape
 *  field-for-field (see the layering note above for why this is a duplicate,
 *  not an import). */
export interface CheckpointMoment {
  kind: MomentKind;
  atMs: number;
  endMs?: number;
  label: string;
  tag?: string;
}

/** One camera (or the recorder)'s own roll timing within the take. Mirrors
 *  store/util.ts's `TakeUnitRoll`. */
export interface CheckpointUnitRoll {
  unit: CameraUnitLetter;
  startOffsetMs: number;
  durationMs: number;
}

/**
 * Everything needed to reconstruct an in-flight take across a killed tab.
 *
 * Deliberately NOT a 1:1 copy of RollingScreen's internal RollSnapshot: this
 * is written on every tag tap, so it stays cheap (a few hundred bytes) while
 * still carrying enough to (a) show an honest recovery banner, (b) resume
 * rolling exactly where it left off, and (c) write the take with correct
 * per-unit timing if the operator says it already ended.
 */
export interface RollCheckpoint {
  v: typeof CHECKPOINT_VERSION;
  projectId: string;
  slateId: string;
  /** Absent for a scene with no breakdown — the take belongs to the scene itself. */
  shotId?: string;
  /** Display only — the store mints the REAL number at recovery time, off
   *  whatever the project's live counters say then, exactly like every other
   *  take creation in the app. Never trust this for anything but a banner. */
  takeNumber: number;
  /** Wall-clock ms (Date.now()) the take's FIRST unit rolled. */
  takeStartedAt: number;
  /** Wall-clock ms this checkpoint was written. Staleness is measured against
   *  THIS, not takeStartedAt — a three-hour interview checkpoints every few
   *  hundred ms and stays fresh; what matters is how long the app was dead,
   *  not how long the take has been running. */
  savedAt: number;
  /** Multi-cam / single-cam-with-sound only: units currently rolling, letter
   *  -> the wall-clock ms each one started. Empty for a plain single-cam
   *  take (no multi-cam, no sound), which carries its own clock via the
   *  timer engine instead — see RollingScreen's `useEngine` split. */
  camRolls: Partial<Record<CameraUnitLetter, number>>;
  /** Units that already cut once this take, while others kept rolling. */
  finishedRolls: CheckpointUnitRoll[];
  soundStartedAt: number | null;
  soundFinished: { startOffsetMs: number; durationMs: number } | null;
  buffered: CheckpointMoment[];
  markInMs: number | null;
  /** Per-chip tap tallies (the small ×N badge on a tag key). Cosmetic, not
   *  data — every tap it counts is already durable via `buffered` above with
   *  or without this — but it is a few bytes and RollSnapshot (the sibling
   *  mis-cut-undo feature, see RollingScreen.tsx) already carries it, so
   *  "Still rolling" restores it too rather than resetting every key's
   *  visible count to zero on a resumed take. */
  flashes: Record<string, number>;
  /** Display only, captured at write time — what the recovery banner reads
   *  off without a store round-trip. The take's REAL clip name(s) are
   *  reminted by store.createTake from the project's live counters, the same
   *  as any other CUT (see buildRecoveredTake). */
  clips: { unit: CameraUnitLetter; clipName: string }[];
  soundFile?: string;
}

// ============================================================================
// STORAGE. Every read/write is wrapped so a localStorage failure (private
// mode, quota, blocked storage) is a silent no-op — never an exception
// reaching the roll screen. Purely additive: if every part of this fails,
// behaviour is exactly what it was before this file existed.
// ============================================================================

/**
 * Narrow, not exhaustive: catches garbage (wrong types, truncated JSON, a
 * future/older schema version) rather than trusting anything shaped
 * approximately right. Same rule analytics.ts's resolveVisitorId applies to
 * a corrupted vid — replace-don't-trust, because the alternative is silently
 * acting on a value nothing actually wrote.
 */
function isRollCheckpoint(value: unknown): value is RollCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== CHECKPOINT_VERSION) return false;
  if (typeof v.projectId !== 'string' || typeof v.slateId !== 'string') return false;
  if (v.shotId !== undefined && typeof v.shotId !== 'string') return false;
  if (typeof v.takeNumber !== 'number' || typeof v.takeStartedAt !== 'number') return false;
  if (typeof v.savedAt !== 'number') return false;
  if (typeof v.camRolls !== 'object' || v.camRolls === null) return false;
  if (!Array.isArray(v.finishedRolls)) return false;
  if (v.soundStartedAt !== null && typeof v.soundStartedAt !== 'number') return false;
  if (v.soundFinished !== null && typeof v.soundFinished !== 'object') return false;
  if (!Array.isArray(v.buffered)) return false;
  if (v.markInMs !== null && typeof v.markInMs !== 'number') return false;
  if (typeof v.flashes !== 'object' || v.flashes === null) return false;
  if (!Array.isArray(v.clips)) return false;
  if (v.soundFile !== undefined && typeof v.soundFile !== 'string') return false;
  return true;
}

/** Safe write. Never throws. */
export function writeCheckpoint(cp: RollCheckpoint): void {
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(cp));
  } catch {
    /* private mode, quota, blocked storage — the take still runs, it just
       will not survive a killed tab this one time. */
  }
}

/** Safe read + validate. Never throws. Garbage in storage reads as absent. */
export function readCheckpoint(): RollCheckpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRollCheckpoint(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Safe clear. Never throws. */
export function clearCheckpoint(): void {
  try {
    localStorage.removeItem(CHECKPOINT_KEY);
  } catch {
    /* nothing to do — worst case a future launch re-offers a stale/consumed
       checkpoint, and the store-level exactly-once check in RollRecovery
       catches that before anything is shown. */
  }
}

// ============================================================================
// PURE DECISIONS. DOM-less and store-less on purpose (this repo's vitest has
// no jsdom — see vite.config.ts), so the actual logic is testable without
// mounting anything, the same split RollingScreen.tsx already uses for
// isSoleRollingUnit / rollHeadForm / moreTileCopy.
// ============================================================================

/** Past STALE_MS since the last checkpoint write, "Still rolling" is no
 *  longer offered — see STALE_MS's own comment for the threshold and why. */
export function isStale(checkpoint: RollCheckpoint, now: number): boolean {
  return now - checkpoint.savedAt > STALE_MS;
}

/** Wall-clock elapsed since the take started, clamped so a clock skew or a
 *  malformed checkpoint can never show as negative time. */
export function elapsedSince(checkpoint: RollCheckpoint, now: number): number {
  return Math.max(0, now - checkpoint.takeStartedAt);
}

/**
 * The armed-MARK-IN fold: an operator who tapped MARK IN and never closed it
 * still marked a moment, it just gets closed by whatever ends the take
 * instead of a second tap. Mirrors doCut's and closeMultiTake's own inline
 * copies of this exact fold — pulled out here so the recovery doors (which
 * run OUTSIDE the mounted RollingScreen, see RollRecovery.tsx) get it right
 * without re-deriving it, and so it has one test instead of three.
 */
export function foldMarkIn(
  buffered: CheckpointMoment[],
  markInMs: number | null,
  durationMs: number,
): CheckpointMoment[] {
  if (markInMs === null) return buffered;
  return [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }];
}

/**
 * True when no camera unit ever rolled (or finished rolling) in this
 * checkpoint - the "sound rolled solo and the camera never joined" shape.
 *
 * Why this matters: store/util.ts's buildTakeClips has a SINGLE-CAM path
 * that ignores `units` entirely and unconditionally mints a top-level
 * camera clip (see its own "Single-cam: untouched legacy path" comment) -
 * `units` is documented as multi-cam-only, "meaningless there and ignored".
 * So calling store.createTake for a single-cam project in this shape would
 * fabricate a clip name for a camera that never physically rolled and burn
 * its counter for nothing. RollingScreen's own soundSoloCut already refuses
 * this (calling abortPendingTake() instead of closeMultiTake()) for exactly
 * this reason - RollRecovery.tsx's two take-writing doors check this first
 * and mirror that refusal rather than writing anything.
 *
 * Multi-cam is exempt: an empty camRolls/finishedRolls there is the
 * legitimate sound-only "wild line" (see bigCutMulti's own comment), which
 * createTake honours correctly via an explicit empty `units` array.
 */
export function noCameraEverJoined(checkpoint: RollCheckpoint): boolean {
  return Object.keys(checkpoint.camRolls).length === 0 && checkpoint.finishedRolls.length === 0;
}

/** "A C0002 · B C0002", or a lone "C0042", or "a take" if somehow neither a
 *  camera nor sound is on the checkpoint (should not happen, but the banner
 *  must never render blank). */
export function formatClipsLabel(checkpoint: RollCheckpoint): string {
  const cameraPart =
    checkpoint.clips.length > 1
      ? checkpoint.clips.map((c) => `${c.unit} ${c.clipName}`).join(' · ')
      : (checkpoint.clips[0]?.clipName ?? '');
  const parts = [cameraPart, checkpoint.soundFile].filter((s): s is string => !!s);
  return parts.length ? parts.join(' · ') : 'a take';
}

/** "5s" / "12 min" / "2h 05m" — the recovery banner's "started N ago" line. */
export function formatElapsedAgo(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** The exact inputs createTake (and the moments loop after it) needs to log
 *  the checkpoint's take as of `now` — used by the recovery prompt's "Cut it
 *  now" and "Discard" doors. Follows bigCutMulti/closeMultiTake's own timing
 *  math: every still-rolling unit gets startOffsetMs from its own start
 *  against takeStartedAt and durationMs against `now`; a unit that already
 *  cut once (finishedRolls) keeps its already-computed timing untouched.
 *
 *  `units`/`sound` are omitted entirely for a plain single-cam-no-sound
 *  checkpoint (nothing in camRolls/finishedRolls/soundStartedAt/soundFinished)
 *  — createTake's own contract says both are "meaningless there and
 *  ignored" for that shape, the same as every other single-cam CUT. */
export function buildRecoveredTake(
  checkpoint: RollCheckpoint,
  now: number,
): {
  slateId: string;
  shotId?: string;
  projectId: string;
  startedAt: number;
  durationMs: number;
  units?: CheckpointUnitRoll[];
  sound?: { startOffsetMs: number; durationMs: number };
  moments: CheckpointMoment[];
} {
  const durationMs = elapsedSince(checkpoint, now);
  const isEngineTake =
    Object.keys(checkpoint.camRolls).length > 0 ||
    checkpoint.finishedRolls.length > 0 ||
    checkpoint.soundStartedAt !== null ||
    checkpoint.soundFinished !== null;

  let units: CheckpointUnitRoll[] | undefined;
  let sound: { startOffsetMs: number; durationMs: number } | undefined;

  if (isEngineTake) {
    units = [...checkpoint.finishedRolls];
    for (const letter of Object.keys(checkpoint.camRolls) as CameraUnitLetter[]) {
      const startedAt = checkpoint.camRolls[letter];
      if (startedAt === undefined) continue;
      units.push({
        unit: letter,
        startOffsetMs: Math.max(0, startedAt - checkpoint.takeStartedAt),
        durationMs: Math.max(0, now - startedAt),
      });
    }
    if (checkpoint.soundFinished) {
      sound = checkpoint.soundFinished;
    } else if (checkpoint.soundStartedAt !== null) {
      sound = {
        startOffsetMs: Math.max(0, checkpoint.soundStartedAt - checkpoint.takeStartedAt),
        durationMs: Math.max(0, now - checkpoint.soundStartedAt),
      };
    }
  }

  return {
    slateId: checkpoint.slateId,
    ...(checkpoint.shotId !== undefined ? { shotId: checkpoint.shotId } : {}),
    projectId: checkpoint.projectId,
    startedAt: checkpoint.takeStartedAt,
    durationMs,
    ...(units ? { units } : {}),
    ...(sound ? { sound } : {}),
    moments: foldMarkIn(checkpoint.buffered, checkpoint.markInMs, durationMs),
  };
}

// ============================================================================
// PENDING RESUME MAILBOX. Only one take can ever be in flight app-wide, and
// the "Still rolling" door needs to hand a checkpoint to a RollingScreen that
// does not exist yet (cold launch always lands on Home — see ui/nav.ts — so
// recovery is offered before any 'rolling' route is ever pushed). A
// module-level mailbox rather than a new Route/Nav field: this fires at most
// once in the app's lifetime and threading a recovery payload through every
// App.tsx call site for that would outweigh the one place that needs it.
// ============================================================================

let pendingResume: RollCheckpoint | null = null;

/** Set by the recovery prompt's "Still rolling" door just before navigating
 *  to the rolling screen it names. */
export function setPendingResume(cp: RollCheckpoint): void {
  pendingResume = cp;
}

/** Consumed exactly once, by the RollingScreen mount that matches it — a
 *  mismatch (wrong slate/shot) leaves the mailbox alone rather than
 *  discarding a payload meant for a screen that has not mounted yet. */
export function takePendingResume(slateId: string, shotId: string | undefined): RollCheckpoint | null {
  if (!pendingResume) return null;
  if (pendingResume.slateId !== slateId || pendingResume.shotId !== shotId) return null;
  const cp = pendingResume;
  pendingResume = null;
  return cp;
}
