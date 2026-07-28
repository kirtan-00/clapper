import { useEffect, useRef, useState } from 'react';
import type {
  CameraUnit,
  CameraUnitLetter,
  MomentKind,
  Project,
  Shot,
  Slate,
  SoundUnit,
  Take,
  TakeClip,
  TakeStatus,
} from '../types';
import { hasSound, isMultiCam } from '../types';
import { store } from '../store';
import {
  clipUnits,
  formatClip,
  parseClipNumber,
  rebaseClipNumbers,
  sortForDisplay,
  type TakeUnitRoll,
} from '../store/util';
import { tc } from '../export/timecode';
import { renderUnitClip } from './cameras';
import { useRollTimer, useWakeLock, createSpeechListener } from '../engine';
import { Sheet, Rail, Toast, Confirm } from './common';
import { track } from '../net/analytics';
import * as haptics from './haptics';

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
                {[s.size, s.move].filter(Boolean).join(' · ') || '—'}
              </span>
              {s.action && <span className="shotjump__action">{s.action}</span>}
            </button>
          );
        })}
      </div>
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Close
        </button>
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

/** A saved take's clip(s) for a compact row: single name, or all units joined. */
function takeClipLabel(t: Take): string {
  return t.clips && t.clips.length ? t.clips.map((c) => `${c.unit} ${c.clipName}`).join(' · ') : t.clipName;
}

/** This unit's next sound file name, e.g. "SND_0012" (no extension, matching renderUnitClip). */
function renderSoundFile(s: SoundUnit): string {
  return formatClip(s.filePrefix, s.nextFileNumber, s.filePadding, s.fileSuffix);
}

// Production sound accent - a cool blue, deliberately distinct from every
// camera-side color (green ROLL, red CUT/rolling, brass GOLD) so the Sound
// slot never reads as a fifth camera. Reuses the SAME .camslot/.camunit
// classes cameras already use (identical structure, spacing, tap targets),
// applied as inline overrides on the color-bearing bits only - styling stays
// scoped to src/ui/ rather than adding new selectors to the shared stylesheet.
// The shared --sound token (styles.css) carries the actual value now; kept as a
// JS handle so the inline color-mix overrides below stay in sync with the rest
// of the app instead of hard-coding a hex here.
const SOUND_ACCENT = 'var(--sound)';
const soundBadgeStyle = {
  color: SOUND_ACCENT,
  background: `color-mix(in srgb, ${SOUND_ACCENT} 16%, var(--ink-800))`,
  borderColor: `color-mix(in srgb, ${SOUND_ACCENT} 45%, transparent)`,
};
const soundTextStyle = { color: SOUND_ACCENT };
const soundRollingStyle = {
  borderColor: `color-mix(in srgb, ${SOUND_ACCENT} 45%, var(--line-soft))`,
  background: `color-mix(in srgb, ${SOUND_ACCENT} 10%, var(--ink-900))`,
};

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
}) {
  const { slate, shot } = props;
  const timer = useRollTimer();
  useWakeLock(true);

  const [project, setProject] = useState<Project>(props.project);
  const [nextTakeNumber, setNextTakeNumber] = useState(1);
  const [recentTakes, setRecentTakes] = useState<Take[]>([]);
  const [siblings, setSiblings] = useState<Slate[]>([]);

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

  const [buffered, setBuffered] = useState<Buffered[]>([]);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [rangeLabelTarget, setRangeLabelTarget] = useState<number | null>(null);
  const [postCut, setPostCut] = useState<{ take: Take } | null>(null);
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

  // voice
  const [listener] = useState(() => createSpeechListener());
  const [micOn, setMicOn] = useState(false);
  const [listening, setListening] = useState(false);

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
    if (postCut) return;
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

  /** Every rolling unit accounted for: write the take and reset for the next one. */
  async function closeMultiTake(
    units: TakeUnitRoll[],
    endedAt: number,
    soundRoll?: { startOffsetMs: number; durationMs: number },
  ) {
    const start = takeStartedAt ?? endedAt;
    const durationMs = Math.max(0, endedAt - start);
    const finalBuffer: Buffered[] =
      markInMs !== null
        ? [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }]
        : buffered;
    setMarkInMs(null);
    setRangeLabelTarget(null);

    const take = await store.createTake({
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
    setPostCut({ take });
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
    if (!anyRolling) return;
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
   * before any camera), else joins the one already open. */
  function soundSoloRoll() {
    if (postCut || soundStartedAt !== null) return;
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
    // Scope to the setup being rolled. Takes number per SHOT when there is one
    // — 5.31 gets takes 1,2,3 and 5.32 starts at 1 again, which is what the
    // slate in front of the lens says — and per scene when there isn't. The
    // store applies the same rule when it assigns the number at CUT; this is
    // only what we show beforehand, and the two must agree.
    const takes = shot ? all.filter((t) => t.shotId === shot.id) : all.filter((t) => !t.shotId);
    setNextTakeNumber(takes.reduce((m, t) => Math.max(m, t.number), 0) + 1);
    setRecentTakes(takes.slice(-4).reverse());
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

  function bumpClap() {
    setClapKey((k) => k + 1);
  }

  function doRoll() {
    if (useEngine || timer.rolling || postCut) return; // multi-cam/sound uses bigRollMulti/soloRoll instead
    haptics.thump();
    track('roll'); // fire-and-forget; never blocks or throws
    setBuffered([]);
    setFlashes({}); // per-chip tap counts are scoped to THIS take
    setMarkInMs(null);
    setRangeLabelTarget(null);
    bumpClap();
    timer.start();
  }

  async function doCut() {
    if (useEngine || !timer.rolling) return; // multi-cam/sound uses bigCutMulti/soloCut instead
    haptics.doubleThump();
    track('cut'); // fire-and-forget; never blocks or throws
    bumpClap();
    const { startedAt, durationMs } = timer.stop();
    const finalBuffer: Buffered[] =
      markInMs !== null
        ? [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }]
        : buffered;
    setMarkInMs(null);
    setRangeLabelTarget(null);

    const take = await store.createTake({
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
    setPostCut({ take });
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
    : timer.elapsedMs;
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

  return (
    <div className={`roll${rolling ? ' roll--live' : ''}`}>
      {rolling && (
        // Tally band: the PRIMARY recording tell. A committed solid-red fill at
        // the very top, daylight-legible and readable even when a thumb covers
        // the CUT button. Present only while live - a hard, binary switch, like
        // a camera tally light - with the running clock mirrored small.
        <div className="tally" role="status" aria-label="Recording">
          <span className="tally__rec">
            <span className="tally__dot" aria-hidden="true" /> REC
          </span>
          <span className="tally__clock tnum">{clockMMSS(elapsedMs)}</span>
        </div>
      )}
      {/* Two-pane wrapper — phone/portrait stack is unchanged; on a landscape
          tablet these split into clock/takes (left) + action deck (right).
          See the .roll__panes rules in styles.css. */}
      <div className="roll__panes">
      <div className="roll__body">
      <div className="roll__head">
        <button type="button" className="iconbtn" aria-label="Back to scenes" onClick={props.onExit}>
          &lsaquo;
        </button>
        <div className="roll__slate">
          <div className="name">{slate.name}</div>
          <div className="roll__nextline">
            <span>
              take <span className="tnum">{nextTakeNumber}</span>
            </span>
            <span aria-hidden="true">&middot;</span>
            {multi ? (
              <button
                type="button"
                className="clipedit"
                aria-label="Fix the camera clip numbers"
                onClick={() => setEditingClip(true)}
              >
                {cameras.length} cams
                <span className="clipedit__pen" aria-hidden="true">✎</span>
              </button>
            ) : (
              <button
                type="button"
                className="clipedit"
                aria-label={`Clip ${clipName(project)}, tap to fix the number`}
                onClick={() => setEditingClip(true)}
              >
                clip <span className="tnum">{clipName(project)}</span>
                <span className="clipedit__pen" aria-hidden="true">✎</span>
              </button>
            )}
          </div>
        </div>
        {listener.supported && (
          <button
            type="button"
            className={`mictoggle${micOn ? ' mictoggle--on' : ''}`}
            aria-label={micOn ? 'Turn voice commands off' : 'Turn voice commands on'}
            aria-pressed={micOn}
            onClick={toggleMic}
          >
            <span className="miclamp" aria-hidden="true" />
            {micOn ? (listening ? 'listening' : 'mic on') : 'voice'}
          </button>
        )}
      </div>

      {/* The shot strip. This is where the operator lives between setups: step
          with the arrows, or tap the middle to jump anywhere in the scene.
          Locked while rolling and while the post-cut sheet is open, the same
          rule as the scene pager — skidding onto the wrong setup mid-take
          would mis-number a take and mislabel the clip. */}
      {shot && (
        <div className="shotstrip">
          <button
            type="button"
            className="shotstrip__btn"
            aria-label="Previous shot"
            disabled={!prevShot || rolling || postCut !== null}
            onClick={() => prevShot && props.onNavigateShot?.(prevShot)}
          >
            &lsaquo;
          </button>
          <button
            type="button"
            className="shotstrip__now"
            aria-label={`Shot ${shot.code} of ${shotList.length}. Tap to jump to another shot.`}
            disabled={rolling || postCut !== null}
            onClick={() => setShowShotJump(true)}
          >
            <span className="shotstrip__code tnum">{shot.code}</span>
            <span className="shotstrip__spec">
              {[shot.size, shot.move].filter(Boolean).join(' · ') || '—'}
            </span>
            <span className="shotstrip__pos tnum">
              {shotIndex >= 0 ? shotIndex + 1 : '-'}/{shotList.length}
            </span>
          </button>
          <button
            type="button"
            className="shotstrip__btn"
            aria-label="Next shot"
            disabled={!nextShot || rolling || postCut !== null}
            onClick={() => nextShot && props.onNavigateShot?.(nextShot)}
          >
            &rsaquo;
          </button>
        </div>
      )}

      {shot?.action && <div className="roll__summary">{shot.action}</div>}
      {shot?.dialogue && <div className="roll__line">&ldquo;{shot.dialogue}&rdquo;</div>}
      {!shot && slate.summary && <div className="roll__summary">{slate.summary}</div>}

      {props.onNavigate && siblings.length > 1 && (
        <div className="scenepager">
          <button
            type="button"
            className="scenepager__btn"
            aria-label="Previous scene"
            disabled={!prevScene || rolling || postCut !== null}
            onClick={() => prevScene && props.onNavigate?.(prevScene)}
          >
            &lsaquo; Prev
          </button>
          <span className="scenepager__pos tnum">
            {sceneIndex >= 0 ? sceneIndex + 1 : '-'}/{siblings.length}
          </span>
          <button
            type="button"
            className="scenepager__btn"
            aria-label="Next scene"
            disabled={!nextScene || rolling || postCut !== null}
            onClick={() => nextScene && props.onNavigate?.(nextScene)}
          >
            Next &rsaquo;
          </button>
        </div>
      )}

      <div className="roll__rail">
        <Rail key={clapKey} thin clap={clapKey > 0} />
      </div>

      <div className="roll__stage">
        <div className={`readout${rolling ? ' readout--live' : ' readout--idle'}`}>
          {clockMMSS(elapsedMs)}
        </div>
        <div className="stage__hint">
          {rolling ? (
            <span className="stage__reclabel">
              <span className="recdot" aria-hidden="true" /> ROLLING
              {multi
                ? ` · ${rollingLetters.join(', ')}`
                : hasSoundUnit && soundRolling && !anyCamRolling
                  ? ' · SOUND'
                  : ''}
            </span>
          ) : postCut ? (
            'Take saved'
          ) : (
            'Tap ROLL' + (listener.supported ? ' or say "roll camera"' : '')
          )}
        </div>

        {multi && (
          <div className="camstack" aria-label="Every camera - tap one to roll, join, or cut it alone">
            {cameras.map((u) => {
              const camIsRolling = camRolls[u.letter] !== undefined;
              if (camIsRolling) {
                // This unit is rolling: tap it to cut just this camera. If it
                // is the last one still rolling, the whole shot closes.
                return (
                  <button
                    key={u.letter}
                    type="button"
                    className="camslot camslot--rolling"
                    aria-label={`Camera ${u.letter} rolling ${renderUnitClip(u)}, tap to cut it`}
                    onClick={() => void soloCut(u.letter)}
                  >
                    <span className="camslot__badge">{u.letter}</span>
                    <span className="camslot__body">
                      <span className="camslot__clip tnum">{renderUnitClip(u)}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                    </span>
                    <span className="camslot__elapsed tnum">{tc.msToClock(elapsedForCam(u.letter))}</span>
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
                    aria-label={`Join camera ${u.letter} into this shot, next clip ${renderUnitClip(u)}`}
                    onClick={() => soloRoll(u.letter)}
                  >
                    <span className="camslot__badge">{u.letter}</span>
                    <span className="camslot__body">
                      <span className="camslot__clip tnum">{renderUnitClip(u)}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                    </span>
                    <span className="camslot__join">JOIN</span>
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
                    aria-label={`Roll camera ${u.letter} alone, next clip ${renderUnitClip(u)}`}
                    onClick={() => soloRoll(u.letter)}
                  >
                    <span className="camslot__badge">{u.letter}</span>
                    <span className="camslot__body">
                      <span className="camslot__clip tnum">{renderUnitClip(u)}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                    </span>
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
          <div
            className="soundsection"
            style={{
              width: '100%',
              maxWidth: 420,
              marginTop: 20,
              padding: '9px 10px 11px',
              border: `1px solid color-mix(in srgb, ${SOUND_ACCENT} 32%, transparent)`,
              borderRadius: 14,
              background: `color-mix(in srgb, ${SOUND_ACCENT} 8%, transparent)`,
            }}
          >
            {/* Its own labelled, tinted zone so the audio roll is unmistakable
                and never reads as a fifth camera. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 2px 8px' }}>
              <span
                style={{
                  fontSize: '0.64rem',
                  fontWeight: 800,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: SOUND_ACCENT,
                }}
              >
                🔊 Sound
              </span>
              <span className="section__note" style={{ marginLeft: 'auto' }}>
                {soundRolling ? 'tap to cut' : rolling ? 'tap to join' : 'tap to roll'}
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
                <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true">🔊</span>
                <span className="camslot__body">
                  <span className="camslot__clip tnum" style={soundTextStyle}>{renderSoundFile(soundUnit)}</span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                </span>
                <span className="camslot__elapsed tnum">{tc.msToClock(elapsedForSound())}</span>
              </button>
            ) : rolling ? (
              // A shot is running (typically sound rolled first) but sound
              // has not joined yet - or a camera opened it and sound is late.
              <button
                type="button"
                className="camslot camslot--join"
                aria-label={`Join sound into this shot, next file ${renderSoundFile(soundUnit)}`}
                onClick={soundSoloRoll}
              >
                <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true">🔊</span>
                <span className="camslot__body">
                  <span className="camslot__clip tnum" style={soundTextStyle}>{renderSoundFile(soundUnit)}</span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                </span>
                <span className="camslot__join" style={soundTextStyle}>JOIN</span>
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
                  <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true">🔊</span>
                  <span className="camslot__body">
                    <span className="camslot__clip tnum" style={soundTextStyle}>{renderSoundFile(soundUnit)}</span>
                    {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  </span>
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
          <div className="minitakes" aria-label="Recent takes">
            {recentTakes.length === 0 ? (
              <div className="minitake minitakes__empty">No takes yet</div>
            ) : (
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
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          ...(t.status === 'discarded' ? {} : soundTextStyle),
                        }}
                      >
                        🔊 {t.sound.fileName}
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
        )}
      </div>
      </div>

      <div className="roll__deck">
        {rolling && (
          <>
            {scriptMode ? (
              <>
                {/* Coverage keypad: a FIXED 2-col grid so each key holds its
                    position scene to scene (muscle memory), never reflowing
                    like flex-wrap did. GOLD keeps a consistent trailing slot. */}
                <div className="keypad keypad--wide" aria-label="Coverage">
                  {coverageChips.map((tag) => {
                    const n = flashes[tag] ?? 0;
                    return (
                      <button
                        key={`${tag}:${n}`}
                        type="button"
                        className={`chip keycap keycap--coverage${n > 0 ? ' chip--flash' : ''}`}
                        onClick={() => tapTag(tag)}
                      >
                        <span className="keycap__label">{tag}</span>
                        {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                      </button>
                    );
                  })}
                  {(() => {
                    const n = flashes.GOLD ?? 0;
                    return (
                      <button
                        key={`GOLD:${n}`}
                        type="button"
                        className={`chip keycap keycap--gold${n > 0 ? ' chip--flash' : ''}`}
                        onClick={() => tapTag('GOLD')}
                      >
                        <span className="keycap__label">GOLD</span>
                        {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                      </button>
                    );
                  })()}
                </div>
                {keyChips.length > 0 && (
                  <div className="keypad keypad--wide" aria-label="Key moments">
                    {keyChips.map((tag) => {
                      const n = flashes[tag] ?? 0;
                      return (
                        <button
                          key={`${tag}:${n}`}
                          type="button"
                          className={`chip keycap keycap--key${n > 0 ? ' chip--flash' : ''}`}
                          onClick={() => tapTag(tag)}
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
              <div className="keypad" aria-label="Quick tags">
                {project.tags.map((tag) => {
                  const n = flashes[tag] ?? 0;
                  return (
                    <button
                      key={`${tag}:${n}`}
                      type="button"
                      className={`chip keycap${tag === 'GOLD' ? ' keycap--gold' : ''}${n > 0 ? ' chip--flash' : ''}`}
                      onClick={() => tapTag(tag)}
                    >
                      <span className="keycap__label">{tag}</span>
                      {n > 0 && <span className="keycap__count tnum">&times;{n}</span>}
                    </button>
                  );
                })}
              </div>
            )}

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
          className={`bigbtn${bigButtonCutMode ? ' bigbtn--cut' : ' bigbtn--go'}`}
          aria-label={
            bigButtonCutMode
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
          onClick={
            bigButtonCutMode
              ? () => void (useEngine ? bigCutMulti() : doCut())
              : useEngine
                ? () => bigRollMulti()
                : doRoll
          }
        >
          {bigButtonCutMode ? 'CUT' : 'ROLL'}
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
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
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
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(n)}>
          Set number
        </button>
      </div>
    </Sheet>
  );
}

// The per-unit clip-number stepper stack, shared by the save-time editor
// (MultiClipSheet) and the take editor (TakeEditSheet). Each row shows the unit
// letter (multi-cam), a live formatted preview, and a - / value / + control.
function ClipNumberRows(props: {
  units: CameraUnit[];
  nums: string[];
  showLetter?: boolean;
  onNum: (i: number, value: string) => void;
}) {
  const showLetter = props.showLetter !== false;
  return (
    <div className="stack">
      {props.units.map((u, i) => {
        const n = Math.max(0, parseInt(props.nums[i], 10) || 0);
        const preview = renderUnitClip({ ...u, nextClipNumber: n }) + (u.clipExt ?? '');
        const who = showLetter ? `camera ${u.letter}` : 'clip';
        return (
          <div key={u.letter} className="camunit">
            <div className="camunit__head">
              {showLetter && <span className="camunit__badge">{u.letter}</span>}
              <span className="camunit__eg tnum">{preview}</span>
            </div>
            <div className="clipset" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="clipset__step"
                aria-label={`Lower ${who}`}
                onClick={() => props.onNum(i, String(Math.max(0, n - 1)))}
              >
                &minus;
              </button>
              <input
                className="field field--mono clipset__input"
                inputMode="numeric"
                value={props.nums[i]}
                onChange={(e) => props.onNum(i, e.target.value.replace(/[^0-9]/g, ''))}
              />
              <button
                type="button"
                className="clipset__step"
                aria-label={`Raise ${who}`}
                onClick={() => props.onNum(i, String(n + 1))}
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
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
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(parsed)}>
          Set clips
        </button>
      </div>
    </Sheet>
  );
}

// Correct an already-logged take: the mis-typed clip number(s) first (the main
// ask, driven by the same ClipNumberRows stepper as the save-time editor), then
// the adjacent status / tags / note. This only rewrites THIS take's row - it
// never moves the live per-camera clip counter or renumbers other takes.
function TakeEditSheet(props: {
  project: Project;
  slate: Slate;
  take: Take;
  onClose: () => void;
  onSaved: (project: Project, shifted: number) => void;
}) {
  const { project, slate, take } = props;
  const multi = (take.clips?.length ?? 0) > 0;

  // Editable per-unit clip definitions rebuilt from the take's recorded clips,
  // using each unit's current prefix/padding/suffix so the stepper reformats
  // exactly like the save-time editor.
  const [units] = useState<CameraUnit[]>(() =>
    multi
      ? (take.clips ?? []).map((clip) => {
          const cam = project.cameras?.find((c) => c.letter === clip.unit);
          const clipPrefix = cam?.clipPrefix ?? project.clipPrefix;
          const clipPadding = cam?.clipPadding ?? project.clipPadding;
          const clipSuffix = cam?.clipSuffix ?? project.clipSuffix ?? '';
          const clipExt = cam?.clipExt ?? project.clipExt ?? '';
          return {
            letter: clip.unit,
            ...(cam?.camera ? { camera: cam.camera } : {}),
            clipPrefix,
            clipPadding,
            clipSuffix,
            clipExt,
            nextClipNumber: parseClipNumber(clip.clipName, clipPrefix, clipSuffix),
          };
        })
      : [
          {
            letter: 'A' as const,
            clipPrefix: project.clipPrefix,
            clipPadding: project.clipPadding,
            clipSuffix: project.clipSuffix ?? '',
            clipExt: project.clipExt ?? '',
            nextClipNumber: parseClipNumber(take.clipName, project.clipPrefix, project.clipSuffix ?? ''),
          },
        ],
  );

  const [nums, setNums] = useState(units.map((u) => String(u.nextClipNumber)));
  // This take's sound file number, editable the same way as a camera clip
  // number - only when BOTH the take actually recorded sound AND the project
  // still has a Sound unit (it may have been turned off since this was shot).
  const soundEditable = !!(take.sound && project.sound);
  const [soundNum, setSoundNum] = useState(() =>
    take.sound && project.sound
      ? String(parseClipNumber(take.sound.fileName, project.sound.filePrefix, project.sound.fileSuffix ?? ''))
      : '',
  );
  const [status, setStatus] = useState<TakeStatus>(take.status);
  const [note, setNote] = useState(take.note ?? '');
  // Tags live as tagged moments; we surface presence as toggle chips and
  // reconcile on save (add a point moment when turned on, delete the take's
  // moments of that tag when turned off).
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [origTags, setOrigTags] = useState<Set<string>>(new Set());
  const [momentIdsByTag, setMomentIdsByTag] = useState<Map<string, string[]>>(new Map());
  const [saving, setSaving] = useState(false);
  // Set when saving would renumber OTHER shots: holds the pending write and a
  // plain-language list of every shot that moves, pending the user's go-ahead.
  // `soundOnly` picks the confirmation copy: "the camera" vs "the sound file".
  const [pendingShift, setPendingShift] = useState<{
    newNumbers: Partial<Record<CameraUnitLetter, number>>;
    newSoundNumber?: number;
    moved: string[];
    soundOnly: boolean;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void store.listMoments(take.id).then((ms) => {
      if (!alive) return;
      const byTag = new Map<string, string[]>();
      for (const m of ms) {
        if (!m.tag) continue;
        const list = byTag.get(m.tag) ?? [];
        list.push(m.id);
        byTag.set(m.tag, list);
      }
      setMomentIdsByTag(byTag);
      setActiveTags(new Set(byTag.keys()));
      setOrigTags(new Set(byTag.keys()));
    });
    return () => {
      alive = false;
    };
  }, [take.id]);

  // Offered chips mirror the rolling deck: scene coverage + GOLD + key beats in
  // Script Mode, else the project quick tags. Any already-present tag outside
  // that set is appended so it stays visible and removable.
  const coverage = (slate.tags ?? [])
    .filter((t) => t.tier === 'coverage')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const keyBeats = (slate.tags ?? [])
    .filter((t) => t.tier === 'keyMoment')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const scriptMode = coverage.length > 0 || keyBeats.length > 0;
  const offered = scriptMode ? [...coverage, 'GOLD', ...keyBeats] : project.tags;
  const tagChips = [...offered, ...[...origTags].filter((t) => !offered.includes(t))];

  function setNum(i: number, value: string) {
    setNums((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function typedNumbers(): Partial<Record<CameraUnitLetter, number>> {
    const out: Partial<Record<CameraUnitLetter, number>> = {};
    units.forEach((u, i) => {
      out[u.letter] = Math.max(0, parseInt(nums[i], 10) || 0);
    });
    return out;
  }

  /**
   * Renumbering rewrites shots the user is not looking at, so never do it
   * silently. Dry-run the rebase against a copy of the project's takes, and if
   * anything downstream would move, show exactly what and make them agree.
   */
  async function requestSave() {
    if (saving) return;
    haptics.tap();

    const newNumbers = typedNumbers();
    const newSoundNumber = soundEditable ? Math.max(0, parseInt(soundNum, 10) || 0) : undefined;
    const bundle = await store.getBundle(project.id);
    const preview = rebaseClipNumbers(project, bundle.takes, take.id, newNumbers, Date.now(), newSoundNumber);
    const others = preview.takes.filter((t) => t.id !== take.id);

    if (others.length === 0) {
      void commit(newNumbers, newSoundNumber);
      return;
    }

    // List ONLY the clips (and sound file) that actually change. Echoing
    // every camera on a 4-cam take buries the one line that matters.
    const was = new Map(bundle.takes.map((t) => [t.id, t]));
    const moved = others
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => {
        const before = was.get(t.id);
        const pairs: string[] = [];
        if (before?.clips?.length && t.clips?.length) {
          for (const clip of t.clips) {
            const old = before.clips.find((c) => c.unit === clip.unit);
            if (old && old.clipName !== clip.clipName) {
              pairs.push(`${clip.unit} ${old.clipName} → ${clip.clipName}`);
            }
          }
        } else if (before && before.clipName !== t.clipName) {
          pairs.push(`${before.clipName} → ${t.clipName}`);
        }
        if (before?.sound && t.sound && before.sound.fileName !== t.sound.fileName) {
          pairs.push(`sound ${before.sound.fileName} → ${t.sound.fileName}`);
        }
        return `shot ${t.number}:  ${pairs.join(',  ')}`;
      });

    // Whether THIS take's camera number(s) actually changed - if not, whatever
    // triggered the shift was the sound file, so the confirmation talks about
    // the recorder instead of the camera.
    const cameraChanged = units.some((u, i) => Math.max(0, parseInt(nums[i], 10) || 0) !== u.nextClipNumber);
    setPendingShift({ newNumbers, newSoundNumber, moved, soundOnly: !cameraChanged });
  }

  async function commit(newNumbers: Partial<Record<CameraUnitLetter, number>>, soundNumber?: number) {
    if (saving) return;
    setSaving(true);
    setPendingShift(null);

    // A camera (and, if it recorded sound, the recorder) counts its own files
    // monotonically, so correcting THIS clip/file number means every later
    // one is off by the same delta, and so is the live counter. rebaseClips
    // carries the correction forward (per unit, later shots only) in one
    // atomic write.
    const rebased = await store.rebaseClips(project.id, take.id, newNumbers, soundNumber);

    const trimmedNote = note.trim();
    // Status/tags/note are this row's alone; the clip names were just written
    // by the rebase, so this patch must not carry them.
    await store.updateTake(take.id, {
      status,
      note: trimmedNote ? trimmedNote : undefined,
    });

    for (const tag of activeTags) {
      if (!origTags.has(tag)) {
        await store.createMoment({ takeId: take.id, kind: 'point', atMs: 0, label: '', tag });
      }
    }
    for (const tag of origTags) {
      if (!activeTags.has(tag)) {
        for (const id of momentIdsByTag.get(tag) ?? []) await store.deleteMoment(id);
      }
    }

    props.onSaved(rebased.project, rebased.shifted);
  }

  // Renumbering touches shots the user cannot see from here, so it gets its own
  // screen rather than a nested sheet: state below stays mounted, so STOP puts
  // them back on the edit form with every field exactly as they left it.
  if (pendingShift) {
    const n = pendingShift.moved.length;
    const title = pendingShift.soundOnly ? 'This renumbers later sound files' : 'This renumbers later shots';
    const lede = pendingShift.soundOnly
      ? `The recorder kept counting, so correcting this sound file number corrects every later sound file too, and the live counter with it. ${n} later shot${n === 1 ? '' : 's'} will change. If you did not mean to do this, press STOP.`
      : `The camera kept counting, so correcting this clip number corrects every later shot on that camera too, and the live counter with it. ${n} later shot${n === 1 ? '' : 's'} will change. If you did not mean to do this, press STOP.`;
    return (
      <Sheet title={title} lede={lede} onClose={() => setPendingShift(null)}>
        <ul
          style={{
            listStyle: 'none',
            margin: '0 0 4px',
            padding: 0,
            display: 'grid',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            color: 'var(--chalk-dim)',
          }}
        >
          {pendingShift.moved.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setPendingShift(null)}>
            STOP
          </button>
          <button
            type="button"
            className="btn btn--go"
            disabled={saving}
            onClick={() => void commit(pendingShift.newNumbers, pendingShift.newSoundNumber)}
          >
            Yes, renumber
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Edit shot ${take.number}`} onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Fix a mis-logged clip{soundEditable ? ' or sound file' : ''} number, status, tags or note.
        Correcting a number also shifts every LATER shot on that camera{soundEditable ? ' or recorder' : ''}{' '}
        by the same amount, and the live counter with them - it kept counting, so they are all off
        by the same gap. Earlier shots never move.
      </p>

      <ClipNumberRows units={units} nums={nums} showLetter={multi} onNum={setNum} />

      {soundEditable && (
        <div className="camunit" style={{ marginTop: 12 }}>
          <div className="camunit__head">
            <span className="camunit__badge" style={soundBadgeStyle} aria-hidden="true">🔊</span>
            <span className="camunit__eg tnum">
              {formatClip(
                project.sound!.filePrefix,
                Math.max(0, parseInt(soundNum, 10) || 0),
                project.sound!.filePadding,
                project.sound!.fileSuffix,
              ) + (project.sound!.fileExt ?? '')}
            </span>
          </div>
          <div className="clipset" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="clipset__step"
              aria-label="Lower sound file number"
              onClick={() => setSoundNum(String(Math.max(0, (Math.max(0, parseInt(soundNum, 10) || 0)) - 1)))}
            >
              &minus;
            </button>
            <input
              className="field field--mono clipset__input"
              inputMode="numeric"
              value={soundNum}
              onChange={(e) => setSoundNum(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <button
              type="button"
              className="clipset__step"
              aria-label="Raise sound file number"
              onClick={() => setSoundNum(String((Math.max(0, parseInt(soundNum, 10) || 0)) + 1))}
            >
              +
            </button>
          </div>
        </div>
      )}

      <div className="formrow" style={{ marginTop: 16 }}>
        <span className="label">Status</span>
        <div className="camcount" role="group" aria-label="Take status" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button
            type="button"
            className={`camcount__opt${status === 'good' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'good'}
            onClick={() => setStatus('good')}
          >
            Good
          </button>
          <button
            type="button"
            className={`camcount__opt${status === 'discarded' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'discarded'}
            onClick={() => setStatus('discarded')}
          >
            No good
          </button>
        </div>
      </div>

      <div className="formrow">
        <span className="label">Tags</span>
        <div className="chips">
          {tagChips.map((tag) => {
            const on = activeTags.has(tag);
            const gold = tag === 'GOLD';
            return (
              <button
                key={tag}
                type="button"
                className={`chip${gold ? ' chip--gold' : ''}${on ? ' chip--on' : ' chip--off'}`}
                aria-pressed={on}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <div className="formrow">
        <label className="label" htmlFor="te-note">
          Note
        </label>
        <textarea
          id="te-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" disabled={saving} onClick={() => void requestSave()}>
          Save shot
        </button>
      </div>

    </Sheet>
  );
}

function PostCutSheet(props: {
  take: Take;
  tcValid: (s: string) => boolean;
  onKeep: (cameraTC: string | undefined, note: string | undefined) => void;
  onDiscard: (cameraTC: string | undefined, note: string | undefined) => void;
}) {
  const [camTC, setCamTC] = useState('');
  const [note, setNote] = useState('');

  const trimmedTC = camTC.trim();
  const tcOk = trimmedTC === '' || props.tcValid(trimmedTC);
  const savedTC = trimmedTC !== '' && props.tcValid(trimmedTC) ? trimmedTC : undefined;
  const savedNote = note.trim() !== '' ? note.trim() : undefined;

  const clips = props.take.clips ?? [];
  return (
    <Sheet title={`Shot ${props.take.number} saved`}>
      {clips.length > 0 && (
        <div className="camstack camstack--sheet" aria-label="Clip on each camera">
          {clips.map((c) => (
            <div key={c.unit} className="camslot">
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
            <span className="camslot__badge" style={soundBadgeStyle} aria-hidden="true">🔊</span>
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

      <div className="formrow">
        <label className="label" htmlFor="pc-tc">
          Camera timecode at shot start (optional)
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
          Note (optional)
        </label>
        <textarea
          id="pc-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="sheet__actions">
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
    </Sheet>
  );
}
