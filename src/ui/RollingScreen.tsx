import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  CameraUnit,
  CameraUnitLetter,
  MomentKind,
  Project,
  Shot,
  Slate,
  SoundUnit,
  Take,
} from '../types';
import { hasSound, isMultiCam } from '../types';
import { store } from '../store';
import {
  clipUnits,
  formatClip,
  shouldPromptForgottenWrap,
  sortForDisplay,
  wrapShootDay,
  type TakeUnitRoll,
} from '../store/util';
import { tc } from '../export/timecode';
import {
  clipParts,
  renderUnitClip,
  soundBadgeStyle,
  soundTextStyle,
  soundRollingStyle,
  unitClipParts,
  SOUND_TEXT,
  SOUND_EDGE,
  SOUND_TINT,
  type ClipParts,
} from './cameras';
import { ClipNumberRows, TakeEditSheet } from './TakeEditSheet';
import { sizeInWords } from './shotlist';
import { ShotDeck } from './ShotDeck';
import { TagEditor } from './TagEditor';
import { useRollTimer, useWakeLock, createSpeechListener } from '../engine';
import { ClipNum, Sheet, SheetClose, Rail, Toast, Confirm } from './common';
import { BackMark, ForwardMark, SpeakerMark } from './marks';
import { track } from '../net/analytics';
import * as haptics from './haptics';
import { CUT_SCALE, getCutSize, subscribe as subscribeCutSize } from './cutsize';

/**
 * Jump anywhere in the scene's shot list without leaving the rolling screen.
 * A 47-shot scene is a lot of thumb, so the current setup is marked and the
 * list opens scrolled to it rather than at the top.
 */
function ShotJumpSheet(props: {
  shots: Shot[];
  current: Shot;
  onPick: (shot: Shot) => void;
  onClose: () => void;
}) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <Sheet title="Jump to shot" onClose={props.onClose}>
      <div className="shotjump">
        {props.shots.map((s) => {
          const isCurrent = s.id === props.current.id;
          return (
            <button
              key={s.id}
              ref={isCurrent ? currentRef : undefined}
              type="button"
              className={`shotjump__row${isCurrent ? ' shotjump__row--now' : ''}`}
              aria-current={isCurrent || undefined}
              onClick={() => props.onPick(s)}
            >
              <span className="shotjump__code tnum">{s.code}</span>
              <span className="shotjump__spec">
                {[sizeInWords(s.size), s.move].filter(Boolean).join(' · ') || '—'}
              </span>
              {s.action && <span className="shotjump__action">{s.action}</span>}
            </button>
          );
        })}
      </div>
      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Close
        </SheetClose>
      </div>
    </Sheet>
  );
}

interface Buffered {
  kind: MomentKind;
  atMs: number;
  endMs?: number;
  label: string;
  tag?: string;
}

/**
 * A CUT inside this many ms is almost always a mis-roll - but only almost, so
 * the sheet ASKS rather than assumes. Past it, the false-start sheet never
 * appears at all.
 *
 * WAS 5000, cut to 2000 on 2026-08-20. Five seconds is a real take: a reaction
 * shot, an insert, a slate-and-go pickup all land inside it, and the sheet was
 * interrupting work that had gone right to ask whether it had gone wrong. Two
 * seconds is short enough that a human could not have called action and cut in
 * between - the only thing that fits is a thumb.
 */
const FALSE_START_MS = 2000;

/**
 * Everything a running take is, captured the instant CUT lands so RESUME can
 * put it back. Not the CLOSED take - the OPEN one: the moment buffer before an
 * armed MARK IN was folded into a range, the per-unit epoch starts, the chip
 * tallies. Resuming from the closed form would silently end a range at the
 * point of the mis-cut, which is the one thing the operator is undoing.
 */
interface RollSnapshot {
  takeStartedAt: number;
  camRolls: Partial<Record<CameraUnitLetter, number>>;
  finishedRolls: TakeUnitRoll[];
  soundStartedAt: number | null;
  soundFinished: { startOffsetMs: number; durationMs: number } | null;
  buffered: Buffered[];
  markInMs: number | null;
  flashes: Record<string, number>;
}

function clipName(p: Project): string {
  return (
    p.clipPrefix +
    String(Math.max(0, p.nextClipNumber)).padStart(p.clipPadding, '0') +
    (p.clipSuffix ?? '')
  );
}

/** Display-only MM:SS (zero-padded) clock for the big rolling readout and the
 * tally band. Deliberately NOT tc.msToClock (which is shared with exports and
 * shows M:SS): this pad is a screen concern only and must never touch the
 * export/timecode formatting. Rolls over to H:MM:SS past an hour. */
function clockMMSS(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const s = totalSeconds % 60;
  if (totalSeconds < 3600) {
    const min = Math.floor(totalSeconds / 60);
    return `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const min = Math.floor(totalSeconds / 60) % 60;
  return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The clock as a set of drums.
 *
 * A digit is a COLUMN of 0-9 that rolls to its new value and settles; only the
 * column whose digit actually changed moves. That is the whole difference
 * between a clock that ticks with weight and a number that is swapped out
 * underneath you, and on the one screen an operator glances at rather than
 * reads, weight is what says the take is still running.
 *
 * Digits are addressed by translating the column -n em. The column forces its
 * own line-height so the step is exactly one glyph box no matter what the host
 * text sets (.readout runs 0.95 and would creep a pixel per digit). Separators
 * and an hour rollover's extra digits are plain spans, so "01:23" growing into
 * "1:00:05" just re-renders with one more drum.
 */
function DrumClock(props: { value: string; className?: string }) {
  return (
    <span className={`drum${props.className ? ` ${props.className}` : ''}`} aria-hidden="true">
      {props.value.split('').map((ch, i) => {
        if (ch < '0' || ch > '9') {
          return (
            <span key={i} className="drum__sep">
              {ch}
            </span>
          );
        }
        const n = Number(ch);
        return (
          <span key={i} className="drum__digit">
            <span className="drum__col" style={{ transform: `translateY(${-n}em)` }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** A saved take's clip(s) for a compact row: single name, or all units joined. */
function takeClipLabel(t: Take): string {
  return t.clips && t.clips.length ? t.clips.map((c) => `${c.unit} ${c.clipName}`).join(' · ') : t.clipName;
}

/**
 * OFF for now, and the reason matters.
 *
 * The forgotten-wrap prompt holds a CUT take unwritten inside a Promise while
 * it waits for the operator's answer. Between CUT and that answer nothing is
 * persisted - no take, no moments, no counter advance - so if the phone locks
 * or iOS reclaims the tab in that window, the take is gone. Before the prompt
 * existed the take was written the instant CUT landed. It fires at most once a
 * day, but the take it puts at risk is the FIRST take of a new shoot day.
 *
 * The right shape is to write the take under the current day and THEN offer
 * "looked like a new day - renumber?" against a take that already exists on
 * disk. That is a restructure, not a flag, so until it is built this stays
 * off: with it off, forgetting to press WRAP DAY simply continues yesterday's
 * numbering, which is exactly what the app did before any of this existed.
 * WRAP DAY itself (the button on the project screen) is unaffected and works.
 */
const FORGOTTEN_WRAP_PROMPT_ENABLED = false;

/** This unit's next sound file name, e.g. "SND_0012" (no extension, matching renderUnitClip). */
function renderSoundFile(s: SoundUnit): string {
  return formatClip(s.filePrefix, s.nextFileNumber, s.filePadding, s.fileSuffix);
}

/** The same name split for display, so the recorder's running number reads like a camera's. */
function soundFileParts(s: SoundUnit): ClipParts {
  return clipParts(s.filePrefix, s.nextFileNumber, s.filePadding, s.fileSuffix ?? '');
}


// Sound accent + reusable .camslot/.camunit style overrides now live in
// cameras.ts (imported above) - shared with TakeEditSheet, which needs the
// same badge styling for the sound row in its own sheet.

export function RollingScreen(props: {
  project: Project;
  slate: Slate;
  /**
   * The setup being rolled. Absent for a scene with no breakdown, which logs
   * takes against the scene itself and numbers them per scene, exactly as
   * before shots existed.
   */
  shot?: Shot;
  onExit: () => void;
  onNavigate?: (slate: Slate) => void;
  onNavigateShot?: (shot: Shot) => void;
  /**
   * Open the project-wide clip log. This is the RECOVERY path - the screen you
   * need the moment someone says "camera B's counter was off two takes ago" -
   * so it belongs one tap from where the operator already is, not three taps
   * back through the project screen. It is deliberately absent while rolling:
   * you cannot fix a past take mid-shot, and the rolling screen has no space
   * to spare (see scripts/measure-roll.mjs).
   */
  onOpenClipLog?: () => void;
}) {
  const { slate, shot } = props;
  const timer = useRollTimer();
  useWakeLock(true);
  // The CUT/ROLL scale (Settings > Appearance > CUT button size), applied as
  // ONE custom property on the screen's own root so `.bigbtn` stays one rule
  // (see cutsize.ts for why this is read live here instead of stamped onto
  // <html> the way the theme is — the roll screen is never first paint).
  const cutSize = useSyncExternalStore(subscribeCutSize, getCutSize, () => 'standard' as const);
  // Set when ROLL/CUT fired from pointerdown, so the click the browser
  // synthesises afterwards is swallowed instead of firing the take twice. A
  // ref rather than state: it is read and cleared inside the same gesture and
  // must never cost a render mid-take.
  const firedByPointer = useRef(false);

  const [project, setProject] = useState<Project>(props.project);
  const [nextTakeNumber, setNextTakeNumber] = useState(1);
  const [recentTakes, setRecentTakes] = useState<Take[]>([]);
  /**
   * The idle report's numbers. Kept as ONE object so the whole panel changes
   * in a single render — three useStates would let the tally update a frame
   * before the headline and flicker on a slow phone. Null until the first
   * read; the panel renders its first-run copy while it is.
   */
  const [report, setReport] = useState<{
    last?: Take;
    setupCount: number;
    setupMs: number;
    dayCount: number;
    dayMs: number;
    dayIndex?: number;
    /** GOLD taps on the last take. The one judgement a camera report carries. */
    lastGold: number;
  } | null>(null);
  const [siblings, setSiblings] = useState<Slate[]>([]);
  /** Every take logged against this SLATE (every shot in it, not just the one
   *  being rolled) — refreshMeta already fetches this list to work out the
   *  current shot's next take number; the shot deck reuses it to show a take
   *  count on the peeked next card without a second read. */
  const [allTakes, setAllTakes] = useState<Take[]>([]);
  /**
   * The idle stage (see .roll__stage below) already scrolls — it always has,
   * `overflow-y: auto` was never missing. What was missing is any sign of
   * that from the resting state: a tall report (the first-run slate spec, or
   * a kept take with a note and a sound file) rests with scrollTop 0 and its
   * last row sliced clean through by the box's own edge, which reads as a
   * rendering fault rather than "there is more, scroll for it". `stageRef` +
   * this flag turn that hard edge into the same bottom fade the shot deck's
   * peeked card already uses (see .shotdeck__stack's mask-image) — one fade
   * language for "there is more below" everywhere on this screen, and the
   * fade is OFF the instant scrolling reaches the true end, so the actual
   * last line is never the thing being faded.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageClipped, setStageClipped] = useState(false);

  const multi = isMultiCam(project);
  // clipUnits() is the same "one shape either way" helper the store uses:
  // multi-cam's real units, or a synthetic single 'A' unit built from the
  // top-level clip fields. That synthetic unit is what lets a single-cam
  // project ride the SAME roll/join engine as multi-cam once sound is
  // involved (see `useEngine` below) without ever rendering a camera slot.
  const cameras = clipUnits(project);
  const soundUnit = project.sound;
  const hasSoundUnit = hasSound(project);

  // Two-tier tap chips. Coverage stays on the scene (the sizes it needs); key
  // moments come from the SHOT when we're rolling one, because a beat worth
  // tapping belongs to a single setup, not to the whole scene. A shot with no
  // beats of its own falls back to the scene's, and a hand-made scene with
  // neither falls back to the project's quick tags (FLUB/GOLD/…).
  const coverageChips = (slate.tags ?? [])
    .filter((t) => t.tier === 'coverage')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const shotKeyTags = shot?.tags?.filter((t) => t.tier === 'keyMoment') ?? [];
  const keyChips = (shotKeyTags.length ? shotKeyTags : (slate.tags ?? []).filter((t) => t.tier === 'keyMoment'))
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const scriptMode = coverageChips.length > 0 || keyChips.length > 0;

  // Scene pager (flip, don't scroll). Only enabled while stopped.
  const sceneIndex = siblings.findIndex((s) => s.id === slate.id);
  const prevScene = sceneIndex > 0 ? siblings[sceneIndex - 1] : null;
  const nextScene =
    sceneIndex >= 0 && sceneIndex < siblings.length - 1 ? siblings[sceneIndex + 1] : null;

  // Shot strip: step through the scene's setups without leaving this screen.
  // Same rule as the scene pager — disabled while anything is rolling.
  const shotList = [...(slate.shots ?? [])].sort((a, b) => a.order - b.order);
  const shotIndex = shot ? shotList.findIndex((s) => s.id === shot.id) : -1;
  const prevShot = shotIndex > 0 ? shotList[shotIndex - 1] : null;
  const nextShot =
    shotIndex >= 0 && shotIndex < shotList.length - 1 ? shotList[shotIndex + 1] : null;
  const [showShotJump, setShowShotJump] = useState(false);
  /**
   * The tag-edit deck (see TagEditor.tsx's `deck` variant): long-press any
   * quick-tag key while rolling and the pad swaps in place for an editable
   * grid, CUT's own slot holding DONE instead - same element, same box, so
   * there is never a frame where both CUT and a delete control are on
   * screen. Reset effect lives below `rolling`'s own definition - see there.
   */
  const [editingTags, setEditingTags] = useState(false);
  // Long-press-to-edit bookkeeping. Refs, not state: a 450ms timer and a
  // "did it fire" flag are read and cleared within one gesture and must
  // never cost a render, the same reasoning as `firedByPointer` on the big
  // button above.
  const tagHoldTimer = useRef<number | null>(null);
  const tagHoldFired = useRef(false);
  const tagHoldOrigin = useRef<{ x: number; y: number } | null>(null);
  // Kept takes per shot, for the deck's "N takes" line — same "not discarded"
  // rule refreshMeta already applies to report.setupCount, so the two numbers
  // never disagree about what counts as a take.
  function takeCountFor(shotId: string): number {
    return allTakes.filter((t) => t.shotId === shotId && t.status !== 'discarded').length;
  }

  const [buffered, setBuffered] = useState<Buffered[]>([]);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [rangeLabelTarget, setRangeLabelTarget] = useState<number | null>(null);
  const [postCut, setPostCut] = useState<{ take: Take; falseStart: boolean } | null>(null);
  /**
   * The open take, frozen at CUT, waiting to be handed back by RESUME. A ref
   * rather than state: it is written inside the CUT gesture and read inside the
   * RESUME gesture, and must never cost a render in between.
   */
  const resumeRef = useRef<RollSnapshot | null>(null);
  /**
   * How much of a RESUMED take's clock already ran before this roll started.
   *
   * useRollTimer always starts from Date.now() and derives elapsed from that,
   * which is exactly right for a fresh take and one number short for a resumed
   * one. Carrying the difference here keeps the clock DERIVED - the resumed
   * readout is still `now - startedAt`, just with the real startedAt - rather
   * than turning it into an accumulator that a locked screen could drift.
   * Zero at every other moment. The multi-cam/sound engine needs none of this:
   * its startedAt is state on this screen and is simply restored.
   */
  const [resumeOffsetMs, setResumeOffsetMs] = useState(0);
  const [deletingTake, setDeletingTake] = useState<Take | null>(null);
  const [editingTake, setEditingTake] = useState<Take | null>(null);
  const [editingClip, setEditingClip] = useState(false);
  // A single camera unit whose NEXT clip number is being fixed inline (idle only).
  const [editingUnit, setEditingUnit] = useState<CameraUnit | null>(null);
  // The Sound unit's NEXT file number being fixed inline (idle only) - same
  // escape hatch as `editingUnit`, just for the one recorder instead of a camera.
  const [editingSoundUnit, setEditingSoundUnit] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const [clapKey, setClapKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  // Forgotten-wrap fallback: a take is ABOUT to be logged and the gap since
  // the open day's last one looks like the operator forgot to press WRAP DAY.
  // Holds the take that's waiting on the operator's New day / Same day
  // answer - createTakeChecked() below never resets anything off the clock
  // alone, it only ever asks.
  //
  // While this is set, a take that was already CUT has not been written yet,
  // so ROLL and CUT are both gated on it (see doRoll/doCut/bigRollMulti/
  // bigCutMulti). The sheet's scrim stops taps, but VOICE does not go through
  // the scrim - a spoken "roll camera" would open a second take on top of the
  // held one, and a spoken "cut" would replace this prompt outright, dropping
  // the held take and every moment tapped during it on the floor.
  const [wrapPrompt, setWrapPrompt] = useState<{
    input: Parameters<typeof store.createTake>[0];
    gapHours: number; // for the prompt copy only ("Last take was 9 hours ago...")
    resolve: (take: Take) => void;
  } | null>(null);

  // voice
  const [listener] = useState(() => createSpeechListener());
  const [micOn, setMicOn] = useState(false);
  const [listening, setListening] = useState(false);
  // The mic switch is off at the OS level. Round 3's rule: this is a STATE the
  // chip wears, never a dialog thrown at an operator mid-take.
  const [micBlocked, setMicBlocked] = useState(false);
  const [showVoiceHelp, setShowVoiceHelp] = useState(false);

  const doRollRef = useRef<() => void>(() => {});
  const doCutRef = useRef<() => void>(() => {});

  // ---- multi-cam: each unit rolls and cuts independently ----------------
  // `camRolls` holds ONLY the units currently rolling (letter -> the epoch ms
  // it started); a unit not in here never rolled, or already cut. The take
  // opens the instant the FIRST unit rolls and closes the instant the LAST
  // rolling unit cuts, so `finishedRolls` carries the timing of units that
  // already cut while others kept going.
  const [camRolls, setCamRolls] = useState<Partial<Record<CameraUnitLetter, number>>>({});
  const [finishedRolls, setFinishedRolls] = useState<TakeUnitRoll[]>([]);
  const [takeStartedAt, setTakeStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Sound rides the SAME take-open/close orchestration as the camera units
  // above, but stays in its OWN parallel state - never a key in `camRolls` -
  // because it is not a CameraUnitLetter and never a picture angle.
  // `soundStartedAt` is the epoch ms it started (null = not rolling);
  // `soundFinished` holds its timing once it cuts, in case a camera is still
  // going and the take has not closed yet.
  const [soundStartedAt, setSoundStartedAt] = useState<number | null>(null);
  const [soundFinished, setSoundFinished] = useState<{ startOffsetMs: number; durationMs: number } | null>(
    null,
  );

  const anyCamRolling = Object.keys(camRolls).length > 0;
  const soundRolling = soundStartedAt !== null;
  const anyRolling = anyCamRolling || soundRolling;
  // Single-cam gains the multi-cam join/cut engine the moment it also has a
  // Sound unit, since there are now two independent roll targets (camera +
  // sound) instead of one. Single-cam with no sound is completely untouched:
  // `useEngine` stays false there and every original doRoll/doCut path runs.
  const useEngine = multi || hasSoundUnit;

  // Repaint every 100ms while any unit is rolling, same cadence as the
  // single-cam timer, so the readout and per-camera elapsed times stay live.
  useEffect(() => {
    if (!anyRolling) return;
    setNowTick(Date.now());
    const id = window.setInterval(() => setNowTick(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [anyRolling]);

  function elapsedForCam(letter: CameraUnitLetter): number {
    const startedAt = camRolls[letter];
    return startedAt === undefined ? 0 : Math.max(0, nowTick - startedAt);
  }

  /**
   * `u` with its counter wound forward past every file it has ALREADY closed
   * inside the take still running.
   *
   * A camera that cuts and rejoins while the others keep rolling writes a
   * SECOND file on its card, and the operator has to read that second number
   * aloud the moment it turns over again. The stored counter cannot help: it
   * only moves at CUT, when the whole take is written. So the slot adds the
   * rolls this camera has already banked this take - one per file - and shows
   * the number the card is actually on. Idle, `finishedRolls` is empty and
   * this is the stored unit unchanged.
   */
  function liveUnit(u: CameraUnit): CameraUnit {
    let burnt = 0;
    for (const r of finishedRolls) if (r.unit === u.letter) burnt += 1;
    return burnt === 0 ? u : { ...u, nextClipNumber: u.nextClipNumber + burnt };
  }

  function elapsedForSound(): number {
    return soundStartedAt === null ? 0 : Math.max(0, nowTick - soundStartedAt);
  }

  /** First roll of a fresh take: reset the moment buffer, same as doRoll(). */
  function openMultiTake(now: number) {
    if (takeStartedAt !== null) return; // a take is already running
    setTakeStartedAt(now);
    setFinishedRolls([]);
    setBuffered([]);
    setFlashes({}); // per-chip tap counts are scoped to THIS take
    setMarkInMs(null);
    setRangeLabelTarget(null);
    bumpClap();
  }

  /** Tap ONE camera's own ROLL. Starts a take if none is running, else joins it. */
  function soloRoll(letter: CameraUnitLetter) {
    if (postCut || camRolls[letter] !== undefined) return;
    haptics.thump();
    track('roll');
    const now = Date.now();
    openMultiTake(now);
    setCamRolls((prev) => ({ ...prev, [letter]: now }));
  }

  /** The big ROLL: starts (or joins) every configured unit not already rolling,
   * AND the Sound unit if it has not rolled yet this take. */
  function bigRollMulti() {
    if (postCut || wrapPrompt) return;
    haptics.thump();
    track('roll');
    const now = Date.now();
    openMultiTake(now);
    setCamRolls((prev) => {
      const next = { ...prev };
      for (const u of cameras) if (next[u.letter] === undefined) next[u.letter] = now;
      return next;
    });
    // Only starts sound that has never rolled this take - if it already rolled
    // and cut (soundFinished set), the big ROLL bringing in more cameras must
    // not silently restart a file that already closed.
    if (hasSoundUnit && soundStartedAt === null && soundFinished === null) setSoundStartedAt(now);
  }

  function finishCam(letter: CameraUnitLetter, startedAt: number, now: number): TakeUnitRoll {
    const takeStart = takeStartedAt ?? startedAt;
    return {
      unit: letter,
      startOffsetMs: Math.max(0, startedAt - takeStart),
      durationMs: Math.max(0, now - startedAt),
    };
  }

  /** Same timing math as finishCam, for the one Sound unit. */
  function finishSound(startedAt: number, now: number): { startOffsetMs: number; durationMs: number } {
    const takeStart = takeStartedAt ?? startedAt;
    return {
      startOffsetMs: Math.max(0, startedAt - takeStart),
      durationMs: Math.max(0, now - startedAt),
    };
  }

  /**
   * The forgotten-wrap fallback. A take is about to be logged: if the gap
   * since the open day's last one looks like the operator forgot to press
   * WRAP DAY, this NEVER resets anything off the clock alone - it holds the
   * take and waits for the operator's own New day / Same day answer (the
   * <WrapPromptSheet/> below), then either wraps first or just logs it,
   * exactly as they chose. When the gap is unremarkable this is a no-op
   * pass-through, same cost as the plain store.createTake call it replaces.
   */
  async function createTakeChecked(input: Parameters<typeof store.createTake>[0]): Promise<Take> {
    const now = Date.now();
    if (FORGOTTEN_WRAP_PROMPT_ENABLED && shouldPromptForgottenWrap(project, now)) {
      const last = project.openShootDay?.lastTakeAt ?? now;
      const gapHours = Math.max(1, Math.round((now - last) / (60 * 60 * 1000)));
      return new Promise<Take>((resolve) => setWrapPrompt({ input, gapHours, resolve }));
    }
    return store.createTake(input);
  }

  /** The operator's answer to the forgotten-wrap prompt. "New day" wraps
   * (resetting every counter, exactly like the project screen's WRAP DAY
   * button) BEFORE logging the held take, so it's the first thing filed
   * under the fresh day; "Same day" just logs it as-is. Either way the take
   * that was waiting gets created and handed back to whichever call site
   * asked for it. */
  async function resolveWrapPrompt(newDay: boolean) {
    if (!wrapPrompt) return;
    const { input, resolve } = wrapPrompt;
    setWrapPrompt(null);
    if (newDay) {
      const { project: wrapped } = wrapShootDay(project, Date.now());
      const updated = await store.updateProject(project.id, wrapped);
      setProject(updated);
    }
    resolve(await store.createTake(input));
  }

  /** Every rolling unit accounted for: write the take and reset for the next one. */
  async function closeMultiTake(
    units: TakeUnitRoll[],
    endedAt: number,
    soundRoll?: { startOffsetMs: number; durationMs: number },
  ) {
    const start = takeStartedAt ?? endedAt;
    const durationMs = Math.max(0, endedAt - start);
    // Freeze the OPEN take before any of it is folded or cleared. See
    // RollSnapshot, and doResume() below for what puts it back.
    resumeRef.current = {
      takeStartedAt: start,
      camRolls: { ...camRolls },
      finishedRolls: [...finishedRolls],
      soundStartedAt,
      soundFinished,
      buffered: [...buffered],
      markInMs,
      flashes: { ...flashes },
    };
    const finalBuffer: Buffered[] =
      markInMs !== null
        ? [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }]
        : buffered;
    setMarkInMs(null);
    setRangeLabelTarget(null);

    const take = await createTakeChecked({
      slateId: slate.id,
      // Absent for a scene with no breakdown: the take then belongs to the
      // scene and numbers per scene, exactly as it always has.
      ...(shot ? { shotId: shot.id } : {}),
      projectId: project.id,
      startedAt: start,
      durationMs,
      units,
      ...(soundRoll ? { sound: soundRoll } : {}),
    });
    for (const m of finalBuffer) {
      await store.createMoment({
        takeId: take.id,
        kind: m.kind,
        atMs: m.atMs,
        ...(m.endMs !== undefined ? { endMs: m.endMs } : {}),
        label: m.label,
        ...(m.tag !== undefined ? { tag: m.tag } : {}),
      });
    }
    setBuffered([]);
    setCamRolls({});
    setFinishedRolls([]);
    setSoundStartedAt(null);
    setSoundFinished(null);
    setTakeStartedAt(null);
    setPostCut({ take, falseStart: durationMs < FALSE_START_MS });
    await refreshMeta();
  }

  /** Abandon a take that opened but never got a picture clip - a single-cam
   * project has no way to represent a camera-less shot (there is always
   * exactly one clip), so if sound rolled solo and gets cut before the camera
   * ever joins, there is nothing to save. Clears the slate rather than
   * fabricate a clip number the camera never wrote. */
  function abortPendingTake() {
    setCamRolls({});
    setFinishedRolls([]);
    setSoundStartedAt(null);
    setSoundFinished(null);
    setTakeStartedAt(null);
    setBuffered([]);
    setMarkInMs(null);
    setRangeLabelTarget(null);
    setResumeOffsetMs(0);
    resumeRef.current = null;
  }

  /** Tap ONE camera's own CUT. Closes the take only if it was the last thing
   * rolling - a camera and sound rolling simultaneously never gets cut alone. */
  async function soloCut(letter: CameraUnitLetter) {
    const startedAt = camRolls[letter];
    if (startedAt === undefined) return;
    haptics.doubleThump();
    track('cut');
    bumpClap();
    const now = Date.now();
    const clip = finishCam(letter, startedAt, now);
    const remaining = { ...camRolls };
    delete remaining[letter];
    const allFinished = [...finishedRolls, clip];
    if (Object.keys(remaining).length === 0 && soundStartedAt === null) {
      await closeMultiTake(allFinished, now, soundFinished ?? undefined);
    } else {
      setCamRolls(remaining);
      setFinishedRolls(allFinished);
    }
  }

  /** Tap Sound's own CUT. Closes the take only once every camera is done too. */
  async function soundSoloCut() {
    if (soundStartedAt === null) return;
    haptics.doubleThump();
    track('cut');
    bumpClap();
    const now = Date.now();
    const roll = finishSound(soundStartedAt, now);
    if (anyCamRolling) {
      // A camera is still going - sound is done, but the take stays open.
      setSoundFinished(roll);
      setSoundStartedAt(null);
      return;
    }
    if (finishedRolls.length > 0) {
      // Every camera already finished; sound was the last thing running.
      await closeMultiTake(finishedRolls, now, roll);
      return;
    }
    if (!multi) {
      // Single-cam: the one picture clip never rolled this take - nothing to
      // save yet. Stop sound and wait; the take reopens the moment the
      // camera actually rolls (openMultiTake no-ops while takeStartedAt holds).
      abortPendingTake();
      return;
    }
    // Multi-cam CAN log a sound-only "wild line" with no camera at all.
    await closeMultiTake([], now, roll);
  }

  /** The big CUT: stops every unit still rolling (cameras and sound), always
   * closing the take - unless, single-cam, no camera ever rolled at all. */
  async function bigCutMulti() {
    if (!anyRolling || wrapPrompt) return;
    haptics.doubleThump();
    track('cut');
    bumpClap();
    const now = Date.now();
    const clips: TakeUnitRoll[] = [...finishedRolls];
    for (const letter of Object.keys(camRolls) as CameraUnitLetter[]) {
      clips.push(finishCam(letter, camRolls[letter]!, now));
    }
    const soundRoll = soundStartedAt !== null ? finishSound(soundStartedAt, now) : (soundFinished ?? undefined);
    if (!multi && clips.length === 0) {
      // Single-cam and the camera never joined this "take" - sound rolled
      // solo and CUT got pressed before it caught up. Nothing to save.
      abortPendingTake();
      return;
    }
    await closeMultiTake(clips, now, soundRoll);
  }

  /** Tap Sound's own ROLL. Starts a take if none is running (typically FIRST,
   * before any camera), else joins the one already open.
   *
   * Refuses once sound has already cut inside this take (`soundFinished`), the
   * same refusal the big ROLL has always made. A take carries ONE recorder
   * file, so restarting here would silently throw away the file that closed -
   * its timing AND its number - and leave the recorder's counter one behind
   * the card for the rest of the day. The slot renders as spent rather than as
   * a JOIN nobody can take. Cameras are the opposite case: they DO reopen, and
   * each reopen is a new file with its own number (see liveUnit). */
  function soundSoloRoll() {
    if (postCut || soundStartedAt !== null || soundFinished !== null) return;
    haptics.thump();
    track('roll');
    const now = Date.now();
    openMultiTake(now);
    setSoundStartedAt(now);
  }

  async function refreshMeta() {
    const [p, all] = await Promise.all([
      store.getProject(project.id),
      store.listTakes(slate.id),
    ]);
    if (p) setProject(p);
    setAllTakes(all);
    // Scope to the setup being rolled. Takes number per SHOT when there is one
    // — 5.31 gets takes 1,2,3 and 5.32 starts at 1 again, which is what the
    // slate in front of the lens says — and per scene when there isn't. The
    // store applies the same rule when it assigns the number at CUT; this is
    // only what we show beforehand, and the two must agree.
    const takes = shot ? all.filter((t) => t.shotId === shot.id) : all.filter((t) => !t.shotId);
    setNextTakeNumber(takes.reduce((m, t) => Math.max(m, t.number), 0) + 1);
    // 8, not 4. The list was capped for a stage that was 0px tall; it is the
    // thing that fills a real shoot day's idle screen now, and a scroller in
    // the stage is the correct overflow for a day with forty takes on it.
    setRecentTakes(takes.slice(-8).reverse());

    // The report's two tallies. SETUP comes free from the list already read
    // above; the DAY total needs the whole project, because a shoot day runs
    // across every scene in it and this screen only ever lists one slate's
    // takes. One extra read, on a screen that is idle by definition when the
    // panel is visible — never while rolling.
    const good = takes.filter((t) => t.status !== 'discarded');
    const sum = (list: Take[]) => list.reduce((n, t) => n + t.durationMs, 0);
    const dayIndex = p?.openShootDay?.index;
    let dayCount = 0;
    let dayMs = 0;
    if (dayIndex !== undefined) {
      const bundle = await store.getBundle(project.id);
      // shootDayIndex is stamped at CUT and is the only STABLE day identity —
      // a night shoot that wraps after midnight can open two different days
      // carrying the same date string (see types.ts). Takes logged before that
      // field existed carry neither, and are simply not counted toward today
      // rather than being guessed into it.
      const today = bundle.takes.filter(
        (t) => t.shootDayIndex === dayIndex && t.status !== 'discarded',
      );
      dayCount = today.length;
      dayMs = sum(today);
    }
    // GOLD on the last take. One extra read against ONE take, on a panel that
    // is idle by definition - never while rolling - so it costs nothing the
    // operator can feel. Counted from the moments rather than stored on the
    // take, because GOLD is a tap during a take and can happen more than once.
    const last = good.length ? good[good.length - 1] : undefined;
    let lastGold = 0;
    if (last) {
      const moments = await store.listMoments(last.id);
      lastGold = moments.filter((m) => m.tag === 'GOLD').length;
    }
    setReport({
      last,
      setupCount: good.length,
      setupMs: sum(good),
      dayCount,
      dayMs,
      dayIndex,
      lastGold,
    });
  }

  useEffect(() => {
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate.id, shot?.id]);

  useEffect(() => {
    // The Rolling screen's scene pager flips through scenes in the same
    // on-set (shooting) order as the scene list — sortForDisplay is a no-op
    // fallback to story order until a scene has ever been dragged.
    void store.listSlates(project.id).then((list) => setSiblings(sortForDisplay(list)));
  }, [project.id]);

  // voice wiring (once per listener)
  useEffect(() => {
    const offCmd = listener.onCommand((cmd) => {
      if (cmd === 'roll') doRollRef.current();
      else doCutRef.current();
    });
    const offState = listener.onStateChange(setListening);
    return () => {
      offCmd();
      offState();
      listener.stop();
    };
  }, [listener]);

  /**
   * Is the microphone switched off at the OS level?
   *
   * Asked up front rather than discovered by a failed start, because the whole
   * point of "blocked is a state" is that the chip is already amber BEFORE the
   * operator reaches for it. The Permissions API is the good answer and is
   * absent on Safari and throws for the 'microphone' name on Firefox, so every
   * step is guarded and the timeout below is the honest fallback. Nothing here
   * touches the network - the query is a local capability check.
   */
  useEffect(() => {
    if (!listener.supported) return;
    let live = true;
    let status: PermissionStatus | null = null;
    const read = () => {
      if (live && status) setMicBlocked(status.state === 'denied');
    };
    try {
      navigator.permissions
        ?.query({ name: 'microphone' as PermissionName })
        .then((s) => {
          if (!live) return;
          status = s;
          read();
          s.onchange = read;
        })
        .catch(() => {
          /* name unsupported: fall through to the timeout below */
        });
    } catch {
      /* no Permissions API at all */
    }
    return () => {
      live = false;
      if (status) status.onchange = null;
    };
  }, [listener]);

  /**
   * The fallback. If the mic was armed and the engine never reported that it
   * was listening, the permission prompt was refused (or the OS switch is off)
   * and no error ever reached us - the speech engine's own error path stops
   * cleanly and silently on 'not-allowed'. Long enough (2.5s) to sit through
   * the engine's restart backoff, so a session that merely blinked is not
   * mistaken for a denial.
   */
  useEffect(() => {
    if (!micOn || listening || micBlocked) return;
    const id = window.setTimeout(() => {
      if (listener.listening) return;
      listener.stop();
      setMicOn(false);
      setMicBlocked(true);
    }, 2500);
    return () => window.clearTimeout(id);
  }, [micOn, listening, micBlocked, listener]);

  function bumpClap() {
    setClapKey((k) => k + 1);
  }

  function doRoll() {
    if (useEngine || timer.rolling || postCut || wrapPrompt) return; // multi-cam/sound uses bigRollMulti/soloRoll instead
    haptics.thump();
    track('roll'); // fire-and-forget; never blocks or throws
    setBuffered([]);
    setFlashes({}); // per-chip tap counts are scoped to THIS take
    setMarkInMs(null);
    setRangeLabelTarget(null);
    setResumeOffsetMs(0); // a fresh take's clock starts where the timer does
    bumpClap();
    timer.start();
  }

  async function doCut() {
    if (useEngine || !timer.rolling || wrapPrompt) return; // multi-cam/sound uses bigCutMulti/soloCut instead
    haptics.doubleThump();
    track('cut'); // fire-and-forget; never blocks or throws
    bumpClap();
    const stopped = timer.stop();
    // A resumed take's real clock began before this roll did, so the offset is
    // folded back in here - once, at the only place the take becomes a fact.
    const startedAt = stopped.startedAt - resumeOffsetMs;
    const durationMs = stopped.durationMs + resumeOffsetMs;
    setResumeOffsetMs(0);
    resumeRef.current = {
      takeStartedAt: startedAt,
      camRolls: {},
      finishedRolls: [],
      soundStartedAt: null,
      soundFinished: null,
      buffered: [...buffered],
      markInMs,
      flashes: { ...flashes },
    };
    const finalBuffer: Buffered[] =
      markInMs !== null
        ? [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }]
        : buffered;
    setMarkInMs(null);
    setRangeLabelTarget(null);

    const take = await createTakeChecked({
      slateId: slate.id,
      // Absent for a scene with no breakdown: the take then belongs to the
      // scene and numbers per scene, exactly as it always has.
      ...(shot ? { shotId: shot.id } : {}),
      projectId: project.id,
      startedAt,
      durationMs,
    });
    for (const m of finalBuffer) {
      await store.createMoment({
        takeId: take.id,
        kind: m.kind,
        atMs: m.atMs,
        ...(m.endMs !== undefined ? { endMs: m.endMs } : {}),
        label: m.label,
        ...(m.tag !== undefined ? { tag: m.tag } : {}),
      });
    }
    setBuffered([]);
    setPostCut({ take, falseStart: durationMs < FALSE_START_MS });
    await refreshMeta();
  }

  /**
   * RESUME - the mis-cut eraser.
   *
   * CUT fires on touch-down, which is right (a director's "cut!" cannot wait
   * for a pointerup) and means a brushed button ends a take that is still
   * happening. The camera never stopped, so the honest repair is not an
   * apology - it is to un-write the take and hand the operator back the one
   * that was running: same clock, same moments, same chip tallies, same clip
   * number. deleteTake is what gives the number back and slides every later
   * take on that camera down one, which is the app's own wording for backing
   * the counter down.
   *
   * The take is deleted BEFORE the state is restored: a mis-cut take must
   * never coexist with the take it is being turned back into.
   */
  async function doResume() {
    const snap = resumeRef.current;
    const take = postCut?.take;
    if (!snap || !take) return;
    haptics.thump(); // the same one heavy hit a take starts with
    setPostCut(null);
    await store.deleteTake(take.id);
    setBuffered(snap.buffered);
    setMarkInMs(snap.markInMs);
    setFlashes(snap.flashes);
    setRangeLabelTarget(null);
    if (useEngine) {
      setTakeStartedAt(snap.takeStartedAt);
      setCamRolls(snap.camRolls);
      setFinishedRolls(snap.finishedRolls);
      setSoundStartedAt(snap.soundStartedAt);
      setSoundFinished(snap.soundFinished);
      setNowTick(Date.now());
    } else {
      setResumeOffsetMs(Math.max(0, Date.now() - snap.takeStartedAt));
      timer.start();
    }
    resumeRef.current = null;
    bumpClap();
    await refreshMeta();
  }

  /** The false start's own answer: the camera never rolled, so the take is not
   * a bad take - it is not a take. Deleting it (rather than discarding it)
   * hands the clip number back, which is the whole reason the sheet asks. */
  async function doScrap() {
    const take = postCut?.take;
    if (!take) return;
    haptics.tap();
    setPostCut(null);
    resumeRef.current = null;
    await store.deleteTake(take.id);
    await refreshMeta();
  }

  // keep refs pointing at the freshest closures for voice commands. Multi-cam
  // (and single-cam once it has sound) routes voice to the BIG roll/cut
  // (everyone together) - there is no way to say "just camera B" out loud.
  doRollRef.current = useEngine ? bigRollMulti : doRoll;
  doCutRef.current = useEngine ? () => void bigCutMulti() : doCut;

  function tapTag(tag: string) {
    if (!rolling) return;
    haptics.tap();
    setBuffered((prev) => [...prev, { kind: 'point', atMs: elapsedMs, label: '', tag }]);
    setFlashes((prev) => ({ ...prev, [tag]: (prev[tag] ?? 0) + 1 }));
    setToast(tag === 'GOLD' ? 'GOLD marked' : `${tag} marked`);
  }

  function markInOut() {
    if (!rolling) return;
    haptics.tap();
    if (markInMs === null) {
      setMarkInMs(elapsedMs);
    } else {
      const start = markInMs;
      const end = elapsedMs;
      setMarkInMs(null);
      setBuffered((prev) => {
        const next: Buffered[] = [...prev, { kind: 'range', atMs: start, endMs: end, label: '' }];
        setRangeLabelTarget(next.length - 1);
        return next;
      });
    }
  }

  function toggleMic() {
    // Acknowledged in the HAND, never in the room. A set is a live-audio
    // environment: the boom is open from "sound speed", so a UI click lands on
    // the recording. Clapper's entire non-visual layer is haptic.
    haptics.tap();
    if (micBlocked) {
      // Permission denied is a STATE, not a dialog - the chip already wears
      // amber and says so. Tapping it opens the one line that says where the
      // switch actually lives, because the app cannot flip it from here.
      setShowVoiceHelp(true);
      return;
    }
    if (micOn) {
      listener.stop();
      setMicOn(false);
    } else {
      listener.start();
      setMicOn(true);
    }
  }

  function tcValid(s: string): boolean {
    if (!tc.isValidTimecode(s)) return false;
    try {
      tc.timecodeToFrames(s, project.fps);
      return true;
    } catch {
      return false;
    }
  }

  // Single-cam with no sound: one global timer, unchanged. Everyone else
  // (multi-cam, or single-cam once it has a Sound unit) runs on the shared
  // engine: "rolling" means ANY participant - camera or sound - is currently
  // going, and the clock runs from whichever one started first to now, the
  // same number moments get timestamped against.
  const rolling = useEngine ? anyRolling : timer.rolling;
  const elapsedMs = useEngine
    ? takeStartedAt !== null
      ? Math.max(0, nowTick - takeStartedAt)
      : 0
    : // Still derived, never accumulated: the offset only supplies the part of
      // a resumed take's clock that ran before this roll began.
      timer.elapsedMs + resumeOffsetMs;
  const rangeArmedMs = markInMs !== null ? Math.max(0, elapsedMs - markInMs) : 0;
  const rollingLetters = (Object.keys(camRolls) as CameraUnitLetter[]).sort();
  // The big button's own ROLL/CUT state is NOT the same as `rolling`: sound
  // commonly rolls solo before any camera, and while that is the ONLY thing
  // going the big button must still say ROLL (its job is bringing the camera
  // in) rather than CUT (which would just stop sound with the camera never
  // having joined). So it tracks whether the CAMERA side has engaged this
  // take - currently rolling, or already finished - not "is anything at all
  // going". For single-cam-no-sound and multi-cam-no-sound this is always
  // identical to `rolling` (a camera finishing always closes the take
  // immediately when there is no sound to wait on), so neither is affected.
  const cameraActive = anyCamRolling || finishedRolls.length > 0;
  const bigButtonCutMode = useEngine ? cameraActive : timer.rolling;

  // Every path that ends a take (voice, a solo-cut that closes the last
  // camera, the big CUT) converges on `rolling` going false - one effect
  // here covers all of them, rather than remembering to clear editingTags
  // inside each. A stale DONE left standing over the next take's CUT would
  // be exactly the mis-tap this whole feature exists to prevent.
  useEffect(() => {
    if (!rolling) setEditingTags(false);
  }, [rolling]);

  /**
   * Keeps `stageClipped` honest. A ResizeObserver on the stage box ALONE
   * misses the case that actually bit this screen: the box's own flex size
   * does not change when its content grows a row (the Sound line, a note on
   * the last take) - only its scrollHeight does. So every direct child is
   * observed too, and scrolling itself re-checks on every event, which is
   * what turns the fade off the moment the operator actually scrolls to the
   * true bottom rather than leaving it lit over content that is now fully
   * in view.
   */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) {
      setStageClipped(false);
      return;
    }
    function recompute() {
      if (!el) return;
      setStageClipped(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    }
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [rolling, postCut, report, recentTakes]);

  /** 450ms is the pitch's own threshold - long enough that a frantic
   *  mid-take tap can never land in edit mode by accident, short enough
   *  that a deliberate hold does not feel ignored. Cancelled by any
   *  movement past a small slop (a real long-press does not travel) or by
   *  lifting early, same shape as a native context-menu gesture. */
  function beginTagHold(e: ReactPointerEvent) {
    if (!e.isPrimary || e.button !== 0 || !rolling || editingTags) return;
    tagHoldOrigin.current = { x: e.clientX, y: e.clientY };
    tagHoldFired.current = false;
    if (tagHoldTimer.current !== null) window.clearTimeout(tagHoldTimer.current);
    tagHoldTimer.current = window.setTimeout(() => {
      tagHoldFired.current = true;
      haptics.tap();
      setEditingTags(true);
    }, 450);
  }
  function moveTagHold(e: ReactPointerEvent) {
    const origin = tagHoldOrigin.current;
    if (!origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 8) cancelTagHold();
  }
  function cancelTagHold() {
    if (tagHoldTimer.current !== null) {
      window.clearTimeout(tagHoldTimer.current);
      tagHoldTimer.current = null;
    }
    tagHoldOrigin.current = null;
  }
  /** Wraps every keycap's own tap handler: swallows the click the browser
   *  still synthesises after the pointerup that follows a fired long-press,
   *  same swallow-one-click shape as `firedByPointer` on the big button. */
  function tagKeyClick(tag: string) {
    if (tagHoldFired.current) {
      tagHoldFired.current = false;
      return;
    }
    tapTag(tag);
  }

  function fireBigButton() {
    if (bigButtonCutMode) void (useEngine ? bigCutMulti() : doCut());
    else if (useEngine) bigRollMulti();
    else doRoll();
  }

  /**
   * THE VOICE CHIP, and it renders WHILE ROLLING - which is the point.
   *
   * A 2nd AC mid-take is one-handed and watching the camera, the slate and the
   * actor; the phone is the one thing they are not looking at. Voice is how a
   * take gets ended without breaking that, so a voice control that only exists
   * between takes is a voice control that does not exist.
   *
   * It sits at the TOP, opposite the REC pill, and that is a safety decision
   * rather than a layout one. This screen's rule is that everything you tap
   * lives by the thumb - but CUT is the consequential control down there and it
   * owns the whole arc. A mic toggle within a thumb's reach of CUT is a mis-tap
   * that either ends a take or silently opens a microphone on a live set.
   * Arming a mic should cost a deliberate second hand, so it is put where the
   * second hand is.
   *
   * Three states, straight from round 3: armed, listening, blocked. Voice is
   * always an EXTRA path to ROLL and CUT and never the only one, so none of
   * these states changes anything else on the screen.
   */
  const voiceChip = listener.supported ? (
    <button
      type="button"
      className={`voicechip${
        micBlocked ? ' voicechip--blocked' : micOn ? ' voicechip--on' : ''
      }${micOn && listening && !micBlocked ? ' voicechip--live' : ''}`}
      aria-pressed={micBlocked ? undefined : micOn}
      aria-label={
        micBlocked
          ? 'Microphone is off in your browser settings. Tap for how to turn it on.'
          : micOn
            ? listening
              ? 'Listening for roll and cut. Tap to disarm voice.'
              : 'Voice armed. Tap to disarm.'
            : 'Arm voice commands for roll and cut'
      }
      onClick={toggleMic}
    >
      <span className="voicechip__lamp" aria-hidden="true" />
      <span>{micBlocked ? 'mic off' : micOn ? (listening ? 'listening' : 'arming') : 'voice'}</span>
    </button>
  ) : null;

  return (
    <div
      className={`roll${rolling ? ' roll--live' : ''}`}
      style={{ '--cut-scale': CUT_SCALE[cutSize] } as CSSProperties}
    >
      {/* Two-pane wrapper — phone/portrait stack is unchanged; on a landscape
          tablet these split into clock/takes (left) + action deck (right).
          See the .roll__panes rules in styles.css. */}
      <div className="roll__panes">
      <div className="roll__body">
      {/* HEAD IS INFORMATION ONLY. Measured on a 430x932 phone, every control
          that used to live up here sat 848-918px from a right thumb — the back
          button worst at 918. On the one screen an operator holds all day,
          nothing you have to TAP is at the top any more; it is all in
          .roll__reach down by the thumb. What stays is what you READ. */}
      <div className="roll__head">
        {rolling ? (
          // THE REC PILL. It replaces a full-bleed red band, and the reason is
          // a defect rather than a preference: the band was a solid red header
          // with square corners tucked inside a solid red RING, and at night
          // the two were near-identical values meeting at the one place the eye
          // is least able to separate them - they merged into a single mass
          // with a hole in it. A pill is a different SHAPE on a different
          // GROUND (dark metal, not red), so the ring owns the perimeter alone
          // and the only red left up here is the dot.
          <span className="recpill" role="status" aria-label="Recording">
            <span className="recpill__dot" aria-hidden="true" />
            <span className="recpill__k">REC</span>
            <DrumClock value={clockMMSS(elapsedMs)} className="recpill__clock" />
          </span>
        ) : (
          <div className="roll__slate">
            <div className="name">{slate.name}</div>
            <div className="roll__nextline">
              <span>
                take <span className="tnum">{nextTakeNumber}</span>
              </span>
            </div>
          </div>
        )}
        <div className="roll__headside">
          {rolling && (
            // The take's identity, opposite the pill: outline, never fill,
            // because it is a fact you read and not a control you press.
            // The setup and the take, and deliberately not the scene name: the
            // scene is what you were already looking at when you pressed ROLL,
            // and a long one truncated to "RECORDIN…" says less than nothing
            // beside a pill that is already announcing the state.
            <span className="headpill tnum">
              {shot ? `${shot.code} · ` : ''}take {nextTakeNumber}
            </span>
          )}
          {voiceChip}
        </div>
      </div>

      {/* The dialogue line stays up here, under the head — it is scene
          reference text, read once on the way into a setup, not a control the
          thumb needs at the bottom. The shot's own spec/description moved
          into the deck (see shotdeck below): this is deliberately the ONLY
          reference to the shot left above the fold. */}
      {shot?.dialogue && <div className="roll__line">&ldquo;{shot.dialogue}&rdquo;</div>}
      {!shot && slate.summary && <div className="roll__summary">{slate.summary}</div>}

      {/* Scene stepper — ONE pager on this screen, never two. A scene with a
          shot breakdown already has its pager above (the shot strip); flipping
          scenes from here would be a second, competing "step through a list"
          control doing a coarser version of the same job, which read as
          assembled rather than designed. This renders ONLY when there is no
          shot breakdown, i.e. the shot strip above did not render — so it is
          the one and only pager whenever it shows at all. Same idiom as the
          shot strip (chevron / current / chevron) rather than a web "‹ Prev /
          1/10 / Next ›" row, and it stays inside .roll__body for the same
          reason the shot strip does — see that block's CSS comment. */}
      {!shot && props.onNavigate && siblings.length > 1 && (
        <div className="scenestrip">
          <button
            type="button"
            className="scenestrip__btn"
            aria-label="Previous scene"
            disabled={!prevScene || rolling || postCut !== null}
            onClick={() => prevScene && props.onNavigate?.(prevScene)}
          >
            <BackMark />
          </button>
          <div className="scenestrip__now">
            <span className="scenestrip__name">{slate.name}</span>
            <span className="scenestrip__pos tnum">
              {sceneIndex >= 0 ? sceneIndex + 1 : '-'}/{siblings.length}
            </span>
          </div>
          <button
            type="button"
            className="scenestrip__btn"
            aria-label="Next scene"
            disabled={!nextScene || rolling || postCut !== null}
            onClick={() => nextScene && props.onNavigate?.(nextScene)}
          >
            <ForwardMark />
          </button>
        </div>
      )}

      <div className="roll__rail">
        <Rail key={clapKey} thin clap={clapKey > 0} />
      </div>

      <div
        className={`roll__stage${stageClipped ? ' roll__stage--clipped' : ''}`}
        ref={stageRef}
      >
        {/* The clock is the LIVE readout. Idle it always read 00:00, which is
            the least informative thing this screen could put at its largest
            size, and it sat on 448px of measured void. Idle now carries the
            report instead (below); postCut keeps the clock, because the number
            it is holding is the take you just finished. */}
        {(rolling || postCut) && (
          <div className={`readout${rolling ? ' readout--live' : ' readout--idle'}`}>
            {/* Post-cut the drums hold the take that just closed, not zero:
                the number the screen is holding IS the take you just finished,
                and it is the one the sheet below is asking about. */}
            <DrumClock value={clockMMSS(rolling ? elapsedMs : (postCut?.take.durationMs ?? 0))} />
          </div>
        )}
        {(rolling || postCut) && (
        <div className="stage__hint">
          {rolling ? (
            <span className="stage__reclabel">
              <span className="recdot" aria-hidden="true" /> ROLLING
              {multi
                ? ` · ${rollingLetters.join(', ')}`
                : hasSoundUnit && soundRolling && !anyCamRolling
                  ? ' · SOUND'
                  : ''}
              {/* The frame rate belongs on the live line, not only on the
                  pre-roll slate: it is the one setting that silently ruins a
                  take, and this is the line the operator's eye is already on. */}
              {` · ${project.fps} FPS`}
            </span>
          ) : (
            'Take saved'
          )}
        </div>
        )}

        {rolling ? (
          buffered.length > 0 && (
            <div className="momentlog" aria-label="Moments this take">
              {[...buffered].reverse().map((m, i) => (
                <div
                  key={buffered.length - 1 - i}
                  className={`momentrow${m.kind === 'range' ? ' momentrow--range' : ''}${
                    m.tag === 'GOLD' ? ' momentrow--gold' : ''
                  }`}
                >
                  <span className="at">
                    {tc.msToClock(m.atMs)}
                    {m.kind === 'range' && m.endMs !== undefined ? ` - ${tc.msToClock(m.endMs)}` : ''}
                  </span>
                  {m.tag && <span className="tag">{m.tag}</span>}
                  {m.kind === 'range' && !m.tag && <span className="tag">RANGE</span>}
                  {m.label && <span className="lbl">{m.label}</span>}
                </div>
              ))}
            </div>
          )
        ) : (
          <>
          {/* THE IDLE REPORT — what a camera assistant writes down, in the
              order they would read it back: what just happened, how the setup
              and the day are running, then the list. It exists because this
              screen is the one an operator stares at between takes and it had
              nothing on it; see the .roll:not(.roll--live) rules in styles.css
              for the space it now gets. Deliberately NOT rendered while
              rolling — the rolling screen is the one his hands know. */}
          <div className="report">
            {report?.last ? (
              // LAST TAKE, as one block of mass. The number is the biggest
              // thing on the idle screen because it is the one figure an
              // operator is asked for out loud, and the line under it is the
              // rest of what a camera report row actually carries: the clip the
              // card wrote, the recorder's file, and the note.
              <div className="lasttake">
                <div className="lasttake__k">
                  <span>Last take</span>
                  <span>{report.last.status === 'discarded' ? 'discarded' : 'kept'}</span>
                </div>
                <div className="lasttake__hero">
                  <span className="lasttake__num tnum">{report.last.number}</span>
                  <span className="lasttake__dur tnum">
                    {tc.msToClock(report.last.durationMs)}
                  </span>
                  <span className="lasttake__spacer" />
                  {report.lastGold > 0 && (
                    <span className="lasttake__gold tnum">Gold &times;{report.lastGold}</span>
                  )}
                </div>
                <div className="lasttake__sub">
                  <span className="tnum">{takeClipLabel(report.last)}</span>
                  {report.last.sound && (
                    <span className="tnum" style={soundTextStyle}>
                      {report.last.sound.fileName}
                    </span>
                  )}
                  {report.last.note && (
                    <span className="lasttake__note">&ldquo;{report.last.note}&rdquo;</span>
                  )}
                </div>
              </div>
            ) : (
              // First run. The old copy here was the words "No takes yet" in a
              // 448px void, which reads as a screen that failed to load rather
              // than a shoot that has not started. Say what the button does and
              // what will appear, so the emptiness is an instruction.
              <div className="lasttake">
                <div className="lasttake__k">
                  <span>Nothing rolled yet</span>
                </div>
                <p className="lasttake__first">
                  Hit ROLL, then CUT. Each take lands here with its clip name,
                  how long it ran, and anything you tapped while it was running.
                </p>
              </div>
            )}

            {report?.last ? (
              // THIS SETUP and DAY N are one mass with a slot of ground cut
              // down between them - the notch. Two separate cards with a gap
              // would read as two cards with a gap; a cut reads as one piece of
              // metal that was machined, which is the whole language. See
              // .notch--v in skin/roll.css for how the mouth is flared without
              // a mask or an SVG.
              <div className="statpair">
                <span className="notch notch--v" aria-hidden="true" />
                <div className="statpair__cell">
                  <span className="statpair__k">This setup</span>
                  <span className="statpair__n">
                    <b className="tnum">{report.setupCount}</b> takes
                  </span>
                  <span className="statpair__s tnum">
                    {tc.msToClock(report.setupMs)} rolled
                  </span>
                </div>
                <div className="statpair__cell">
                  <span className="statpair__k">
                    {report.dayIndex ? `Day ${report.dayIndex}` : 'Today'}
                  </span>
                  <span className="statpair__n">
                    <b className="tnum">{report.dayCount}</b> takes
                  </span>
                  <span className="statpair__s tnum">{tc.msToClock(report.dayMs)} rolled</span>
                </div>
              </div>
            ) : (
              // Two rows of zeroes are not a report, they are furniture. Before
              // the first take the useful thing is the SLATE ITSELF — the
              // settings a 1st AC checks against the camera before anyone
              // rolls, which is exactly what the back of a clapperboard
              // carries. It disappears the moment there is real work to show.
              <dl className="report__tally">
                <div className="report__row report__row--spec">
                  <dt>Frame rate</dt>
                  <dd className="tnum">{project.fps} fps</dd>
                </div>
                <div className="report__row report__row--spec">
                  <dt>{multi ? 'Cameras' : 'Camera'}</dt>
                  <dd className="tnum">
                    {multi ? project.cameras?.map((c) => c.letter).join(' ') : 'A'}
                  </dd>
                </div>
                <div className="report__row report__row--spec">
                  <dt>Sound</dt>
                  <dd className="tnum">{hasSoundUnit ? renderSoundFile(project.sound!) : 'not logged'}</dd>
                </div>
                <div className="report__row report__row--spec">
                  <dt>First clip</dt>
                  <dd className="tnum">{clipName(project)}</dd>
                </div>
              </dl>
            )}
          </div>

          {recentTakes.length > 0 && (
            <span className="minitakes__k">Earlier on this setup</span>
          )}
          <div className="minitakes" aria-label="Recent takes">
            {recentTakes.length === 0 ? null : (
              recentTakes.map((t) => (
                <div
                  key={t.id}
                  className={`minitake${t.status === 'discarded' ? ' minitake--discarded' : ''}`}
                >
                  <button
                    type="button"
                    className="minitake__open"
                    aria-label={`Edit take ${t.number} (${takeClipLabel(t)}${
                      t.sound ? ` · sound ${t.sound.fileName}` : ''
                    })`}
                    onClick={() => setEditingTake(t)}
                  >
                    <span className="tnum">S{t.number}</span>
                    <span className="clip">{takeClipLabel(t)}</span>
                    {t.sound && (
                      // Reuses .clip (same as the camera clip span above) so a
                      // discarded take fades/strikes it identically via
                      // .minitake--discarded .clip - the accent color is only
                      // applied inline when the shot is still good. Overflow
                      // safety is inline too, since a phone-width row now has
                      // two names to fit instead of one.
                      <span
                        className="clip"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 'var(--sp-1)',
                          minWidth: 0,
                          ...(t.status === 'discarded' ? {} : soundTextStyle),
                        }}
                      >
                        <SpeakerMark />
                        <span
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t.sound.fileName}
                        </span>
                      </span>
                    )}
                    <span className="dur tnum">{tc.msToClock(t.durationMs)}</span>
                    <span className="minitake__pen" aria-hidden="true">✎</span>
                  </button>
                  <button
                    type="button"
                    className="minitake__del"
                    aria-label={`Delete take ${t.number} (${t.clipName})`}
                    onClick={() => setDeletingTake(t)}
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
          </>
        )}
      </div>

      {/* THE SHOT DECK. Last thing in the scrollable body, on purpose: it
          sits directly above ROLL/CUT, and .roll__body's own max-height +
          overflow (see styles.css) is what keeps that true no matter how
          tall the deck's description text runs — the deck is a child that
          SCROLLS, ROLL/CUT are a sibling that never does. Absent for a scene
          with no shot breakdown; that case keeps the scene pager above. */}
      {shot && (
        <ShotDeck
          shotList={shotList}
          shotIndex={shotIndex}
          shot={shot}
          nextShot={nextShot}
          takeCountFor={takeCountFor}
          locked={rolling || postCut !== null}
          onOpenJump={() => setShowShotJump(true)}
          onAdvance={(picked) => props.onNavigateShot?.(picked)}
        />
      )}
      </div>

      <div className="roll__deck">
        {/* THE REACH ROW. Everything the head used to hold, moved to where the
            thumb already is. IDLE ONLY, and that is a safety rule rather than a
            layout one: while rolling, this strip is MARK IN's, and a "back to
            scenes" target adjacent to CUT during a take is how you lose one.
            The controls here are all things you do BETWEEN takes anyway. */}
        {!rolling && (
          <div className="roll__reach">
            <button
              type="button"
              className="reachbtn"
              aria-label="Back to scenes"
              onClick={props.onExit}
            >
              <BackMark />
              <span>Scenes</span>
            </button>

            {multi ? (
              <button
                type="button"
                className="reachbtn"
                aria-label="Fix the camera clip numbers"
                onClick={() => setEditingClip(true)}
              >
                <span className="tnum">{cameras.length} cams</span>
                <span className="reachbtn__pen" aria-hidden="true">✎</span>
              </button>
            ) : (
              <button
                type="button"
                className="reachbtn"
                aria-label={`Clip ${clipName(project)}, tap to fix the number`}
                onClick={() => setEditingClip(true)}
              >
                <span className="tnum">{clipName(project)}</span>
                <span className="reachbtn__pen" aria-hidden="true">✎</span>
              </button>
            )}

            {props.onOpenClipLog && (
              <button
                type="button"
                className="reachbtn"
                aria-label="Open the clip log for every take of this shoot"
                onClick={props.onOpenClipLog}
              >
                <span>Log</span>
              </button>
            )}

            {/* Voice used to live here, idle-only. It moved to the head so it
                exists during a take too - see the voiceChip comment above. One
                voice control, one place, idle and live alike. */}
          </div>
        )}

        {/* Every camera's own roll/cut, ALWAYS reachable - idle or rolling.
            Lives in the deck (flex: 0 0 auto below), never in the stage, so
            the moment the keypad grows it is the stage that shrinks first,
            never this strip. This is the whole fix: on set, camera A rolling
            solo must never take B/C/D off screen with it. */}
        {multi && (
          <div className="camstack" aria-label="Every camera - tap one to roll, join, or cut it alone">
            {cameras.map((u) => {
              const camIsRolling = camRolls[u.letter] !== undefined;
              // What this camera's card is actually on right now - past any
              // file it already closed and reopened inside this same take.
              const live = liveUnit(u);
              if (camIsRolling) {
                // This unit is rolling: tap it to cut just this camera. If it
                // is the last one still rolling, the whole shot closes.
                // State is never colour-only: the dot shape + "REC" text next
                // to the running clock reads the same under red set-lighting
                // or to a red/green colour-blind operator.
                return (
                  <button
                    key={u.letter}
                    type="button"
                    className="camslot camslot--rolling"
                    aria-label={`Camera ${u.letter} rolling ${renderUnitClip(live)}, tap to cut it`}
                    onClick={() => void soloCut(u.letter)}
                  >
                    <span className="camslot__top">
                      <span className="camslot__badge">{u.letter}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                      <span className="camslot__elapsed tnum">
                        <span className="recdot" aria-hidden="true" /> REC {tc.msToClock(elapsedForCam(u.letter))}
                      </span>
                    </span>
                    <ClipNum parts={unitClipParts(live)} className="camslot__clip tnum" />
                  </button>
                );
              }
              if (rolling) {
                // A shot is running but this camera has not joined yet.
                return (
                  <button
                    key={u.letter}
                    type="button"
                    className="camslot camslot--join"
                    aria-label={`Join camera ${u.letter} into this shot, next clip ${renderUnitClip(live)}`}
                    onClick={() => soloRoll(u.letter)}
                  >
                    <span className="camslot__top">
                      <span className="camslot__badge">{u.letter}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                      <span className="camslot__join">JOIN</span>
                    </span>
                    <ClipNum parts={unitClipParts(live)} className="camslot__clip tnum" />
                  </button>
                );
              }
              // Fully idle: tap the slot to roll THIS camera alone; the pencil
              // fixes its next clip number without starting anything.
              return (
                <div key={u.letter} className="camslot camslot--edit">
                  <button
                    type="button"
                    className="camslot__main"
                    aria-label={`Roll camera ${u.letter} alone, next clip ${renderUnitClip(live)}`}
                    onClick={() => soloRoll(u.letter)}
                  >
                    <span className="camslot__top">
                      <span className="camslot__badge">{u.letter}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                    </span>
                    <ClipNum parts={unitClipParts(live)} className="camslot__clip tnum" />
                  </button>
                  <button
                    type="button"
                    className="camslot__penbtn"
                    aria-label={`Fix camera ${u.letter} next clip number`}
                    onClick={() => setEditingUnit(u)}
                  >
                    <span className="camslot__pen" aria-hidden="true">✎</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {hasSoundUnit && soundUnit && (
          // The box moved out of inline styles and into skin/roll.css, because
          // an inline background outranks every rule in the skin and this zone
          // has to change material with the rest of the deck. The recorder's
          // blue stays on the EDGE, where it does its one job: sound is never
          // a fifth camera.
          <div className="soundsection">
            {/* Its own labelled, tinted zone so the audio roll is unmistakable
                and never reads as a fifth camera. */}
            <div className="soundsection__head">
              <span className="soundsection__label" style={{ color: SOUND_TEXT }}>
                <SpeakerMark /> Sound
              </span>
              <span className="section__note" style={{ marginLeft: 'auto' }}>
                {soundRolling
                  ? 'tap to cut'
                  : soundFinished
                    ? 'done this shot'
                    : rolling
                      ? 'tap to join'
                      : 'tap to roll'}
              </span>
            </div>
            <div aria-label="Production sound - tap to roll, join, or cut it alone">
            {soundRolling ? (
              // Rolling: tap to cut just sound. If the cameras are already
              // done, this is the LAST thing going and the shot closes.
              <button
                type="button"
                className="camslot camslot--rolling"
                style={soundRollingStyle}
                aria-label={`Sound rolling ${renderSoundFile(soundUnit)}, tap to cut it`}
                onClick={() => void soundSoloCut()}
              >
                <span className="camslot__top">
                  <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  <span className="camslot__elapsed tnum">
                    <span className="recdot" aria-hidden="true" /> REC {tc.msToClock(elapsedForSound())}
                  </span>
                </span>
                <ClipNum parts={soundFileParts(soundUnit)} className="camslot__clip tnum" />
              </button>
            ) : soundFinished ? (
              // Sound already cut inside this shot while a camera kept
              // rolling. One recorder file per take, so there is nothing left
              // to join - show the file it wrote, spent, rather than a JOIN
              // that would refuse the tap (see soundSoloRoll).
              <div className="camslot camslot--spent" aria-label={`Sound recorded ${renderSoundFile(soundUnit)} for this shot`}>
                <span className="camslot__top">
                  <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  <span className="camslot__join" style={soundTextStyle}>DONE</span>
                </span>
                <ClipNum parts={soundFileParts(soundUnit)} className="camslot__clip tnum" />
              </div>
            ) : rolling ? (
              // A shot is running (typically sound rolled first) but sound
              // has not joined yet - or a camera opened it and sound is late.
              <button
                type="button"
                className="camslot camslot--join"
                aria-label={`Join sound into this shot, next file ${renderSoundFile(soundUnit)}`}
                onClick={soundSoloRoll}
              >
                <span className="camslot__top">
                  <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  <span className="camslot__join" style={soundTextStyle}>JOIN</span>
                </span>
                <ClipNum parts={soundFileParts(soundUnit)} className="camslot__clip tnum" />
              </button>
            ) : (
              // Fully idle: tap the slot to roll sound alone (typically
              // FIRST, before camera); the pencil fixes its next file number.
              <div className="camslot camslot--edit">
                <button
                  type="button"
                  className="camslot__main"
                  aria-label={`Roll sound alone, next file ${renderSoundFile(soundUnit)}`}
                  onClick={soundSoloRoll}
                >
                  <span className="camslot__top">
                    <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
                    {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  </span>
                  <ClipNum parts={soundFileParts(soundUnit)} className="camslot__clip tnum" />
                </button>
                <button
                  type="button"
                  className="camslot__penbtn"
                  aria-label="Fix sound's next file number"
                  onClick={() => setEditingSoundUnit(true)}
                >
                  <span className="camslot__pen" aria-hidden="true">✎</span>
                </button>
              </div>
            )}
            </div>
          </div>
        )}

        {rolling && (
          <>
            {/* The pads are the ONLY part of the deck allowed to scroll. MARK IN
                and the big CUT sit outside this box, so a scene with a tall
                keypad can never push CUT off the bottom of a phone. */}
            <div className="roll__pads">
            {editingTags ? (
              // Long-press landed. Same box, same scroll region, a different
              // job: this project's live vocabulary instead of the keys that
              // tap it. TagEditor owns add/remove/GOLD-lock; this screen only
              // owns persistence ("saves as you go" - every change commits,
              // DONE below only closes) and the heading the mockup asks for.
              <div className="rolltagsdeck">
                <div className="rolltagsdeck__head">
                  <span className="rolltagsdeck__title">Edit tags · this project</span>
                  <span className="rolltagsdeck__hint">Saves as you go</span>
                </div>
                <TagEditor
                  variant="deck"
                  tags={project.tags}
                  onChange={(next) => {
                    void store.updateProject(project.id, { tags: next }).then((updated) => {
                      setProject(updated);
                    });
                  }}
                />
              </div>
            ) : scriptMode ? (
              <>
                {/* Tier 1: sizes, a compact segmented control - the highest-
                    frequency, lowest-stakes tap, so it costs the least
                    visual weight. Still a fixed single row so a key never
                    changes position scene to scene. Guarded on length, same
                    as tier 2 below it: GOLD used to sit in this grid and kept
                    it non-empty even when a scene carried no coverage tags of
                    its own, so an empty segmented strip never had to be a
                    case. Now that GOLD lives by MARK IN, an ungated map()
                    left a stray empty bar behind for exactly that scene. */}
                {coverageChips.length > 0 && (
                  <div className="keypad keypad--segmented" aria-label="Coverage">
                    {coverageChips.map((tag) => {
                      const n = flashes[tag] ?? 0;
                      return (
                        <button
                          key={`${tag}:${n}`}
                          type="button"
                          className={`chip keycap keycap--coverage${n > 0 ? ' chip--flash' : ''}`}
                          onPointerDown={beginTagHold}
                          onPointerMove={moveTagHold}
                          onPointerUp={cancelTagHold}
                          onPointerCancel={cancelTagHold}
                          onClick={() => tagKeyClick(tag)}
                        >
                          <span className="keycap__label">{tag}</span>
                          {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {keyChips.length > 0 && (
                  // Tier 2: moments, a scannable list. These are the actual
                  // record of what happened in the take, so they keep the
                  // keycap hardware-key travel; greyscale now, not brass -
                  // brass is GOLD's alone (see .goldbtn by MARK IN below).
                  <div className="keypad keypad--list" aria-label="Key moments">
                    {keyChips.map((tag) => {
                      const n = flashes[tag] ?? 0;
                      return (
                        <button
                          key={`${tag}:${n}`}
                          type="button"
                          className={`chip keycap${n > 0 ? ' chip--flash' : ''}`}
                          onPointerDown={beginTagHold}
                          onPointerMove={moveTagHold}
                          onPointerUp={cancelTagHold}
                          onPointerCancel={cancelTagHold}
                          onClick={() => tagKeyClick(tag)}
                        >
                          <span className="keycap__label">{tag}</span>
                          {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              // No breakdown: the flat quick-tag set reads as the same tier 2
              // list. GOLD is filtered out here too - it moved to its own
              // grade action by MARK IN, see goldAvailable below.
              <div className="keypad keypad--list" aria-label="Quick tags">
                {project.tags.filter((tag) => tag !== 'GOLD').map((tag) => {
                  const n = flashes[tag] ?? 0;
                  return (
                    <button
                      key={`${tag}:${n}`}
                      type="button"
                      className={`chip keycap${n > 0 ? ' chip--flash' : ''}`}
                      onPointerDown={beginTagHold}
                      onPointerMove={moveTagHold}
                      onPointerUp={cancelTagHold}
                      onPointerCancel={cancelTagHold}
                      onClick={() => tagKeyClick(tag)}
                    >
                      <span className="keycap__label">{tag}</span>
                      {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            </div>

            {/* MARK IN sits beside GOLD rather than alone at full width -
                the width and the neutral chrome are what used to make it
                read as a second CUT stacked right above the real one. Tier 3
                (GOLD) lives here too: a grade action beside the controls
                that end a take, not buried in the tag grid above. Script
                Mode always offers it; the flat quick-tag set only if the
                project actually carries a GOLD tag (respects a project that
                removed it, same as the grid used to).

                While editing tags, this row holds only the notch - MARK IN
                and GOLD are both take-logging actions and neither belongs
                next to a control that is currently rewriting the vocabulary,
                so the mockup drops them for the duration rather than risk a
                mis-tap between "grade this take" and "delete this tag". */}
            <div className="roll__markrow">
              {!editingTags && (
                <>
                  <button
                    type="button"
                    className={`markbtn${markInMs !== null ? ' markbtn--armed' : ''}`}
                    onClick={markInOut}
                  >
                    {markInMs !== null ? (
                      <>
                        MARK OUT
                        <span className="markbtn__badge tnum">{tc.msToClock(rangeArmedMs)}</span>
                      </>
                    ) : (
                      'MARK IN'
                    )}
                  </button>
                  {(scriptMode || project.tags.includes('GOLD')) &&
                    (() => {
                      const n = flashes.GOLD ?? 0;
                      return (
                        <button
                          key={`GOLD:${n}`}
                          type="button"
                          // chip--gold reuses the existing brass tap-flash
                          // (chipflashgold) rather than the default green one -
                          // GOLD is the one chip allowed to carry colour.
                          className={`goldbtn chip--gold${n > 0 ? ' chip--flash' : ''}`}
                          onClick={() => tapTag('GOLD')}
                        >
                          GOLD
                          {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                        </button>
                      );
                    })()}
                </>
              )}
              {/* Where the deck's mass ends and CUT begins, the same cut turned
                  ninety degrees. It is decoration doing structural work: the
                  bite is what says the slab below is a DIFFERENT part, not more
                  of the deck - which is exactly the distinction a thumb needs
                  to make without looking. Always present, editing or not - the
                  edit-mode DONE button sits in CUT's exact slot, so the joint
                  that says "a different part starts here" still has to be true. */}
              <span className="notch notch--h" aria-hidden="true" />
            </div>

            {rangeLabelTarget !== null && (
              <div className="addline" style={{ marginTop: 0 }}>
                <input
                  className="field"
                  autoFocus
                  placeholder="Label this range (optional)"
                  value={buffered[rangeLabelTarget]?.label ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setBuffered((prev) =>
                      prev.map((m, i) => (i === rangeLabelTarget ? { ...m, label: value } : m)),
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setRangeLabelTarget(null);
                  }}
                />
                <button type="button" className="btn" onClick={() => setRangeLabelTarget(null)}>
                  Done
                </button>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          // DONE takes CUT's exact slot - same element, same class base, same
          // box - while tags are being edited. That is the whole mis-tap
          // defence: there is never a frame where both CUT and a delete
          // control are on screen, because CUT simply is not rendered.
          className={`bigbtn hw${editingTags ? ' hw--done' : bigButtonCutMode ? ' hw--cut' : ' hw--go'}`}
          aria-label={
            editingTags
              ? 'Done editing tags - the take keeps rolling'
              : bigButtonCutMode
                ? multi
                  ? 'Cut every camera still rolling and save the take'
                  : hasSoundUnit
                    ? 'Cut the camera and sound and save the take'
                    : 'Cut and save take'
                : multi
                  ? 'Roll every camera together'
                  : hasSoundUnit
                    ? 'Roll the camera and sound together'
                    : 'Roll, start rolling'
          }
          // FIRES ON POINTER-DOWN, not on click. The button's 3px of travel is
          // there to confirm a press the operator cannot look at; it is not
          // allowed to be the thing that starts or stops the take, because
          // pointerup is ~100ms of a good take away and CUT is pressed under
          // exactly the pressure where that is felt. The travel now trails the
          // action instead of gating it.
          //
          // THE GATE: editingTags is checked and returned on BEFORE
          // fireBigButton can be reached, in both handlers below. That one
          // branch is the entire safety property this feature promises - CUT
          // (and therefore doCut/bigCutMulti) is structurally unreachable
          // while the tag editor owns this slot, not just visually hidden.
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            firedByPointer.current = true;
            if (editingTags) {
              setEditingTags(false);
              return;
            }
            fireBigButton();
          }}
          // Keyboard only. A pointer press synthesises a click after its
          // pointerup, so the flag above swallows exactly that one; Enter and
          // Space arrive here with no pointer ahead of them and still work.
          onClick={() => {
            if (firedByPointer.current) {
              firedByPointer.current = false;
              return;
            }
            if (editingTags) {
              setEditingTags(false);
              return;
            }
            fireBigButton();
          }}
        >
          <span className="hw__well" aria-hidden="true" />
          <span className="hw__face">
            {!editingTags && bigButtonCutMode && <span className="hw__dot" aria-hidden="true" />}
            {editingTags ? 'DONE' : bigButtonCutMode ? 'CUT' : 'ROLL'}
          </span>
        </button>
      </div>
      </div>

      {showShotJump && shot && (
        <ShotJumpSheet
          shots={shotList}
          current={shot}
          onPick={(picked) => {
            setShowShotJump(false);
            if (picked.id !== shot.id) props.onNavigateShot?.(picked);
          }}
          onClose={() => setShowShotJump(false)}
        />
      )}

      {postCut && (
        <PostCutSheet
          take={postCut.take}
          tcValid={tcValid}
          falseStart={postCut.falseStart}
          // The snapshot is written inside the CUT gesture, before the sheet
          // exists, so this is never stale by the time the sheet reads it.
          canResume={resumeRef.current !== null}
          onResume={() => void doResume()}
          onScrap={() => void doScrap()}
          onKeep={async (cameraTC, note) => {
            const patch: Partial<Take> = {};
            if (cameraTC) patch.cameraTC = cameraTC;
            if (note) patch.note = note;
            if (Object.keys(patch).length > 0) await store.updateTake(postCut.take.id, patch);
            setPostCut(null);
            await refreshMeta();
          }}
          onDiscard={async (cameraTC, note) => {
            const patch: Partial<Take> = { status: 'discarded' };
            if (cameraTC) patch.cameraTC = cameraTC;
            if (note) patch.note = note;
            await store.updateTake(postCut.take.id, patch);
            setPostCut(null);
            await refreshMeta();
          }}
        />
      )}

      {editingUnit && (
        <MultiClipSheet
          cameras={[editingUnit]}
          onClose={() => setEditingUnit(null)}
          onSet={async (edited) => {
            const one = edited[0];
            // Merge just this unit back; other cameras' counters are untouched.
            const merged = cameras.map((u) => (u.letter === one.letter ? one : u));
            const updated = await store.updateProject(project.id, { cameras: merged });
            setProject(updated);
            setEditingUnit(null);
            haptics.tap();
          }}
        />
      )}

      {editingSoundUnit && soundUnit && (
        <SoundNumberSheet
          sound={soundUnit}
          onClose={() => setEditingSoundUnit(false)}
          onSet={async (n) => {
            const updated = await store.updateProject(project.id, {
              sound: { ...soundUnit, nextFileNumber: n },
            });
            setProject(updated);
            setEditingSoundUnit(false);
            haptics.tap();
          }}
        />
      )}

      {editingTake && (
        <TakeEditSheet
          project={project}
          slate={slate}
          take={editingTake}
          onClose={() => setEditingTake(null)}
          onSaved={async (updatedProject, shifted) => {
            setEditingTake(null);
            // The rebase may have moved this camera's live counter, so take the
            // project back from the store rather than keeping the stale copy.
            setProject(updatedProject);
            if (shifted > 0) {
              setToast(`Clip fixed - ${shifted} later take${shifted === 1 ? '' : 's'} moved too`);
            }
            await refreshMeta();
          }}
        />
      )}

      {deletingTake && (
        <Confirm
          title={`Delete take ${deletingTake.number}?`}
          message={`Only if the camera never rolled. This removes ${takeClipLabel(deletingTake)}${
            deletingTake.sound ? ` and sound ${deletingTake.sound.fileName}` : ''
          } and every moment tagged in it, hands the clip number back, and slides every later shot on that camera${
            deletingTake.sound ? ' (and every later sound file)' : ''
          } down one. If the camera DID roll and the take was simply no good, discard it instead so it keeps its number. Cannot be undone.`}
          confirmLabel="Delete shot"
          onCancel={() => setDeletingTake(null)}
          onConfirm={async () => {
            await store.deleteTake(deletingTake.id);
            setDeletingTake(null);
            await refreshMeta();
          }}
        />
      )}

      {editingClip &&
        (multi ? (
          <MultiClipSheet
            cameras={cameras}
            onClose={() => setEditingClip(false)}
            onSet={async (units) => {
              const updated = await store.updateProject(project.id, { cameras: units });
              setProject(updated);
              setEditingClip(false);
              haptics.tap();
            }}
          />
        ) : (
          <ClipNumberSheet
            project={project}
            onClose={() => setEditingClip(false)}
            onSet={async (n) => {
              const updated = await store.updateProject(project.id, { nextClipNumber: n });
              setProject(updated);
              setEditingClip(false);
              haptics.tap();
            }}
          />
        ))}

      {wrapPrompt && (
        <Sheet
          title="New shoot day?"
          lede={`Last take was ${wrapPrompt.gapHours} hour${wrapPrompt.gapHours === 1 ? '' : 's'} ago. Counters go back to ${
            project.cameras && project.cameras.length > 0
              ? formatClip(
                  project.cameras[0].clipPrefix,
                  project.cameras[0].clipStart ?? 1,
                  project.cameras[0].clipPadding,
                  project.cameras[0].clipSuffix,
                )
              : formatClip(project.clipPrefix, project.clipStart ?? 1, project.clipPadding, project.clipSuffix)
          } if this is a new day.`}
        >
          <div className="sheet__actions">
            <button type="button" className="btn btn--ghost" onClick={() => void resolveWrapPrompt(false)}>
              Same day
            </button>
            <button type="button" className="btn btn--go" onClick={() => void resolveWrapPrompt(true)}>
              New day
            </button>
          </div>
        </Sheet>
      )}

      {showVoiceHelp && (
        // One line, and it is the only thing the app can honestly offer: the
        // mic switch lives in the browser, not in here. No retry button that
        // would just fail again in front of an operator mid-shoot.
        <Sheet title="Voice needs the microphone" onClose={() => setShowVoiceHelp(false)}>
          <p className="voicehelp">
            The mic looks switched off for this site. Open your browser&rsquo;s site
            settings (the icon beside the address bar) and allow the microphone.
            ROLL and CUT keep working by thumb either way &mdash; voice is an extra
            path, never the only one.
          </p>
          <div className="sheet__actions">
            <SheetClose className="btn btn--ghost" onClose={() => setShowVoiceHelp(false)}>
              Close
            </SheetClose>
            {/* THE WAY OUT, and it is not optional. Blocked is inferred: the
                Permissions API is absent on Safari, so the fallback is "armed
                but never started listening", and a permission PROMPT sitting
                open while the operator decides looks exactly like a denial. An
                inferred state with no exit is a bug - on a browser with no
                permission events, a wrong amber would otherwise last until a
                reload. One tap re-arms and lets the engine answer for itself. */}
            <button
              type="button"
              className="btn btn--go"
              onClick={() => {
                setShowVoiceHelp(false);
                setMicBlocked(false);
                listener.start();
                setMicOn(true);
              }}
            >
              Try voice again
            </button>
          </div>
        </Sheet>
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// Fix the clip number on the fly — camera skipped one, a card change, a re-roll.
// The current shot takes the new number and the counter continues from it. Works
// mid-roll (the number is only baked onto the take at CUT).
function ClipNumberSheet(props: {
  project: Project;
  onClose: () => void;
  onSet: (n: number) => void;
}) {
  const [num, setNum] = useState(String(props.project.nextClipNumber));
  const n = Math.max(0, parseInt(num, 10) || 0);
  const preview =
    props.project.clipPrefix +
    String(n).padStart(props.project.clipPadding, '0') +
    (props.project.clipSuffix ?? '') +
    (props.project.clipExt ?? '');

  return (
    <Sheet title="Clip number" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Camera skipped or repeated a number? Set it right. This shot takes the new number and the
        count carries on from here.
      </p>
      <div className="clipset">
        <button
          type="button"
          className="clipset__step"
          aria-label="Lower"
          onClick={() => setNum(String(Math.max(0, n - 1)))}
        >
          &minus;
        </button>
        <input
          className="field field--mono clipset__input"
          inputMode="numeric"
          value={num}
          autoFocus
          onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          type="button"
          className="clipset__step"
          aria-label="Raise"
          onClick={() => setNum(String(n + 1))}
        >
          +
        </button>
      </div>
      <div className="clipset__preview">
        <span className="label">This shot becomes</span>
        <span className="tnum">{preview}</span>
      </div>
      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(n)}>
          Set clip
        </button>
      </div>
    </Sheet>
  );
}

// Same escape hatch as ClipNumberSheet, for the one Sound unit instead of a
// camera - the recorder's card got swapped, or its count drifted.
function SoundNumberSheet(props: {
  sound: SoundUnit;
  onClose: () => void;
  onSet: (n: number) => void;
}) {
  const [num, setNum] = useState(String(props.sound.nextFileNumber));
  const n = Math.max(0, parseInt(num, 10) || 0);
  const preview = formatClip(props.sound.filePrefix, n, props.sound.filePadding, props.sound.fileSuffix) +
    (props.sound.fileExt ?? '');

  return (
    <Sheet title="Sound file number" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Recorder skipped or repeated a number? Set it right. This shot's sound file takes the new
        number and the count carries on from here.
      </p>
      <div className="clipset">
        <button
          type="button"
          className="clipset__step"
          aria-label="Lower"
          onClick={() => setNum(String(Math.max(0, n - 1)))}
        >
          &minus;
        </button>
        <input
          className="field field--mono clipset__input"
          inputMode="numeric"
          value={num}
          autoFocus
          onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          type="button"
          className="clipset__step"
          aria-label="Raise"
          onClick={() => setNum(String(n + 1))}
        >
          +
        </button>
      </div>
      <div className="clipset__preview">
        <span className="label">This file becomes</span>
        <span className="tnum">{preview}</span>
      </div>
      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(n)}>
          Set number
        </button>
      </div>
    </Sheet>
  );
}

// Multi-cam counterpart to ClipNumberSheet: fix each camera unit's next clip
// number independently. The next shot takes these and each unit counts on.
function MultiClipSheet(props: {
  cameras: CameraUnit[];
  onClose: () => void;
  onSet: (cameras: CameraUnit[]) => void;
}) {
  const [nums, setNums] = useState(props.cameras.map((u) => String(u.nextClipNumber)));

  function setNum(i: number, value: string) {
    setNums((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  const parsed = props.cameras.map((u, i) => ({
    ...u,
    nextClipNumber: Math.max(0, parseInt(nums[i], 10) || 0),
  }));

  return (
    <Sheet title="Clip numbers" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        A camera skipped or repeated a number? Set each one right. The next shot takes these numbers
        and every camera counts on from there.
      </p>
      <ClipNumberRows units={props.cameras} nums={nums} onNum={setNum} />
      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(parsed)}>
          Set clips
        </button>
      </div>
    </Sheet>
  );
}

function PostCutSheet(props: {
  take: Take;
  tcValid: (s: string) => boolean;
  /** CUT landed inside FALSE_START_MS. Offered, never assumed. */
  falseStart: boolean;
  canResume: boolean;
  onResume: () => void;
  onScrap: () => void;
  onKeep: (cameraTC: string | undefined, note: string | undefined) => void;
  onDiscard: (cameraTC: string | undefined, note: string | undefined) => void;
}) {
  const [camTC, setCamTC] = useState('');
  const [note, setNote] = useState('');
  // The false-start question comes FIRST and is answerable in one tap either
  // way; answering "keep it" falls through to the normal sheet with nothing
  // lost. It is a gate, not a mode - past FALSE_START_MS it never renders.
  const [asking, setAsking] = useState(props.falseStart);

  if (asking) {
    return (
      <Sheet title={`Cut at ${tc.msToClock(props.take.durationMs)}`}>
        <p className="falsestart">
          A discarded take vanishes and <b>backs the clip counter down one</b>, so the
          count matches the card if the camera never rolled. If it did roll, stop
          rolling — the take keeps its number.
        </p>
        <div className="sheet__actions">
          <button type="button" className="btn btn--go" onClick={props.onScrap}>
            Discard take {props.take.number}
          </button>
        </div>
        <button type="button" className="resumerow" onClick={() => setAsking(false)}>
          Stop rolling &middot; {tc.msToClock(props.take.durationMs)} on the board
        </button>
      </Sheet>
    );
  }

  const trimmedTC = camTC.trim();
  const tcOk = trimmedTC === '' || props.tcValid(trimmedTC);
  const savedTC = trimmedTC !== '' && props.tcValid(trimmedTC) ? trimmedTC : undefined;
  const savedNote = note.trim() !== '' ? note.trim() : undefined;

  const clips = props.take.clips ?? [];
  return (
    <Sheet title={`Shot ${props.take.number} saved`}>
      {clips.length > 0 && (
        <div className="camstack camstack--sheet" aria-label="Clip on each camera">
          {/* Keyed by the clip NAME, not the unit letter: a camera that cut
              and rejoined wrote two files on this one shot and gets a slot
              each, so the letter is no longer unique down this list. */}
          {clips.map((c) => (
            <div key={`${c.unit}${c.clipName}`} className="camslot">
              <span className="camslot__badge">{c.unit}</span>
              <span className="camslot__clip tnum">{c.clipName}</span>
            </div>
          ))}
        </div>
      )}
      {props.take.sound && (
        <div
          className="camstack camstack--sheet"
          style={{ gridTemplateColumns: '1fr' }}
          aria-label="Sound file recorded"
        >
          <div className="camslot">
            <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
            <span className="camslot__clip tnum" style={soundTextStyle}>{props.take.sound.fileName}</span>
          </div>
        </div>
      )}
      <div className="takesummary">
        {clips.length === 0 && (
          <div className="takesummary__cell">
            <div className="label">Clip</div>
            <div className="val val--clip">{props.take.clipName}</div>
          </div>
        )}
        <div className="takesummary__cell">
          <div className="label">Shot</div>
          <div className="val">{props.take.number}</div>
        </div>
        <div className="takesummary__cell">
          <div className="label">Length</div>
          <div className="val">{tc.msToClock(props.take.durationMs)}</div>
        </div>
      </div>

      {/* Two labels both ended in "(OPTIONAL)", in caps, one under the other.
          Saying it twice makes it louder, not clearer, and neither field is
          gated: KEEP works with both empty, which is the real proof. The
          placeholders carry the format and the example. */}
      <div className="formrow">
        <label className="label" htmlFor="pc-tc">
          Camera timecode at shot start
        </label>
        <input
          id="pc-tc"
          className="field field--mono"
          inputMode="numeric"
          placeholder="HH:MM:SS:FF"
          value={camTC}
          onChange={(e) => setCamTC(e.target.value)}
        />
        {!tcOk && (
          <span className="tnum tnum--bad" style={{ fontSize: '0.78rem' }}>
            Not a valid timecode - it will not be saved
          </span>
        )}
      </div>

      <div className="formrow">
        <label className="label" htmlFor="pc-note">
          Note
        </label>
        <textarea
          id="pc-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {/* DISCARD and KEEP were the same width and the same weight, so the
          sheet gave equal billing to throwing the take away and to keeping it.
          A subordinate action has to LOOK subordinate: Keep takes the width,
          Discard keeps its red but gives the room up. Nothing else moves - the
          hit target is still well over 44px. */}
      <div className="sheet__actions sheet__actions--weighted">
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => props.onDiscard(savedTC, savedNote)}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn btn--go"
          onClick={() => props.onKeep(savedTC, savedNote)}
        >
          Keep
        </button>
      </div>

      {/* RESUME. Quiet on purpose - it is right perhaps once a day, and a
          control that un-writes a take must never compete with the two that
          file one. It is here rather than in a menu because the mis-cut is
          discovered in the second after CUT, with the sheet already open and
          the thumb already there. */}
      {props.canResume && (
        <button type="button" className="resumerow" onClick={props.onResume}>
          <BackMark />
          Mis-cut? Resume take {props.take.number}
        </button>
      )}
    </Sheet>
  );
}
