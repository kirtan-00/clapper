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
  // The recorder's blue survives on the TAKE REPORT, where a sound file name
  // sits in a list beside camera clip names and the colour is the fastest way
  // to tell one string from the other. It is gone from the live deck: sound is
  // a pill among the unit pills there, told apart by the speaker mark on its
  // badge rather than by a colour a set light can eat.
  soundTextStyle,
  unitClipParts,
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

/**
 * THE TAKE BAR — sixty ticks, one per second of the current minute.
 *
 * A take has no end until somebody presses CUT, so a percentage-to-done bar
 * would be a lie drawn to three decimal places. What an operator actually
 * tracks is the SWEEP: how far into this minute we are, and whether the thing
 * is still moving. So the bar fills left to right across a minute, empties,
 * and goes again - a second hand unrolled into a strip, which is also what
 * every meter on a cart already looks like.
 *
 * Sixty ticks is not decoration: it means one tick lights per second, so the
 * bar is visibly ALIVE from the corner of an eye that is on the actors. The
 * minute count it is inside of is on the clock directly above; between the
 * two there is nothing about the take's length you cannot read at a glance.
 */
const TAKE_BAR_TICKS = 60;
function TakeBar(props: { elapsedMs: number }) {
  const seconds = Math.max(0, Math.floor(props.elapsedMs / 1000));
  const lit = seconds % TAKE_BAR_TICKS;
  return (
    <div className="takebar" aria-hidden="true">
      {Array.from({ length: TAKE_BAR_TICKS }, (_, i) => (
        <span key={i} className={`takebar__tick${i < lit ? ' is-on' : ''}`} />
      ))}
    </div>
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

/**
 * THE TAG PAD, DETERMINISTICALLY FIT - NEVER SCROLLED.
 *
 * The owner measured it himself, twice: night theme, 2 cameras + sound + a
 * 3-shot breakdown, 10 tags, while rolling. `.roll__pads` scrolled at every
 * height from 844 down to 664, and at 620 (an iPhone SE in Safari with the
 * toolbar showing - not hypothetical, the phone he named) `.roll__deck`
 * itself scrolled too. His words, twice: "the rolling screen is divided into
 * multiple scrollables."
 *
 * The fix is not a smaller scrollbar. `.roll__pads`'s own `clientHeight` is
 * set by flexbox from its FIXED siblings (camstack, the mark row, CUT) and is
 * independent of how much is rendered inside it - proved by clearing the box
 * out entirely and re-measuring: same clientHeight, empty or full. So the
 * budget can be read ONCE per layout (see the ResizeObserver below) and the
 * content clamped to it, rather than rendered in full and left to overflow.
 *
 * Truncation is never silent. A tag key the operator cannot reach is worse
 * than one behind an extra tap, so the row that would have overflowed
 * becomes a "+N MORE" tile instead of simply vanishing, and tapping it PAGES
 * - swaps which chunk of the same group is shown, in the SAME box, at the
 * SAME height, wrapping back to the first page. Every tag stays reachable;
 * none of them cost a scroll to get to.
 */
// Exported (not just module-scoped) because RollingScreen.test.ts now pins
// this exact math for the moments log too (`cols: 1`, see `momentFit` below)
// - the same reason `isSoleRollingUnit`/`rollHeadForm` are exported above:
// the render is exercised by scripts/shoot-roll.mjs's live CDP drive, but the
// DECISION of how many whole rows fit a budget is a pure function and belongs
// pinned here, not only proven by a screenshot.
export function rowsThatFit(budgetPx: number, rowH: number, gapPx: number): number {
  if (budgetPx < rowH) return 0;
  return 1 + Math.floor((budgetPx - rowH) / (rowH + gapPx));
}

/** One group's tag pad (the coverage grid, the key-moment list, or the flat
 *  quick-tag grid): how many of `count` items fit in `budgetPx` at `rowH`
 *  tall / `cols` wide, and how many rows that spends. When a row would spill,
 *  the LAST cell of the last row is given back to a MORE tile - it costs one
 *  real tag's worth of space to keep every hidden one reachable. */
export function fitTagGroup(
  count: number,
  budgetPx: number,
  rowH: number,
  cols: number,
  gapPx: number,
): { visible: number; moreCount: number; consumedPx: number } {
  // ZERO ROWS FIT means nothing renders - NOT a MORE tile reporting the
  // count. A MORE tile is a real row (rowH tall) like any other; returning a
  // non-zero moreCount here while consumedPx stays 0 is exactly the bug this
  // comment is now here to stop reintroducing: the caller renders the tile
  // regardless (moreCount > 0 is its only gate), so the group's real height
  // and the height this function told the budget math about would disagree -
  // which is a scrollHeight > clientHeight deficit by another name. Measured
  // live: 390x780, this rig's key-moment group had a 9px remainder after
  // coverage, well under a 44px row, and reporting moreCount=6 there put a
  // 44px tile in a box the budget thought cost nothing.
  if (count <= 0 || budgetPx < rowH) return { visible: 0, moreCount: 0, consumedPx: 0 };
  const naturalRows = Math.ceil(count / cols);
  const rows = Math.min(naturalRows, rowsThatFit(budgetPx, rowH, gapPx));
  let visible = rows * cols;
  let moreCount = 0;
  if (visible < count) {
    moreCount = count - (visible - 1);
    visible -= 1;
  }
  return { visible: Math.max(0, visible), moreCount, consumedPx: rows * rowH + (rows - 1) * gapPx };
}

/**
 * The moments log's own "+N more" tile, in words - a pure decision same as
 * `fitTagGroup` above it, so it is pinned by a unit test here rather than
 * only proven by scripts/shoot-roll.mjs's live `bug6` check.
 *
 * `fit.visible === 0` is the case that shipped wrong: a real take at a short
 * viewport logged moments, the box's whole one-row budget went to the tile
 * itself (see the comment on `moreCopy` at its one call site), and the tile
 * still read "+7 more" with no row above it to be more than. "+N more"
 * promises a list it is the tail of; when there is no list, it is just
 * wrong, not merely terse. Read as a fact instead ("7 moments"), which is
 * true whether zero moments show above the tile or several thousand do.
 */
export function moreTileCopy(fit: { visible: number; moreCount: number }): { text: string; ariaLabel: string } {
  const { visible, moreCount } = fit;
  const s = moreCount === 1 ? '' : 's';
  return visible === 0
    ? { text: `${moreCount} moment${s}`, ariaLabel: `${moreCount} moment${s} logged this take, not shown here` }
    : { text: `+${moreCount} more`, ariaLabel: `${moreCount} earlier moment${s} logged this take, not shown here` };
}

/** The MORE tile's page: which slice of `items` to show right now, wrapping
 *  at the end back to the start. `pageSize` is `visible` from fitTagGroup
 *  above - the same box, every time, never a size that could overflow it. */
function tagPageSlice<T>(items: T[], pageSize: number, page: number): T[] {
  if (pageSize <= 0 || items.length === 0) return [];
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = ((page % totalPages) + totalPages) % totalPages;
  return items.slice(p * pageSize, p * pageSize + pageSize);
}

// Fixed geometry the tiering math above measures against - kept in sync with
// the CSS by hand (see .keypad .keycap / .keypad--list .keycap / .roll__pads
// in styles.css). GRID_ROW_H_COMPACT is 44 (var(--tap)) rather than the
// sheet's 52 because @media (max-height: 700px) drops `.keypad .keycap`'s
// own min-height to match - see that rule for the measurement that motivated
// it (664px could not fit even ONE row of the OWNER's own 3-coverage +
// 6-keyMoment rig at 52px).
const GRID_ROW_H = 52;
const GRID_ROW_H_COMPACT = 44;
const LIST_ROW_H = 44; // var(--tap) - unchanged at every height
const TAG_ROW_GAP = 8; // var(--sp-2)
const TAG_GROUP_GAP = 12; // var(--sp-3) - gap between the two .keypad groups

/**
 * Would cutting `letter` right now leave nothing else rolling? Same question
 * soloCut already asks itself to decide whether to close the take - lifted
 * out so the rolling pill can ask it too, BEFORE the tap fires, instead of
 * discovering the answer by closing the shot. Sound is a parallel roll that
 * never lives in `camRolls` (see its own state comment above), so a camera
 * rolling alongside sound is never "the last thing" even when it is the only
 * key left in this object.
 *
 * Owner's own words on the bug this guards: "tapping this cuts the scene."
 */
export function isSoleRollingUnit(
  letter: CameraUnitLetter,
  camRolls: Partial<Record<CameraUnitLetter, number>>,
  soundStartedAt: number | null,
): boolean {
  const rolling = Object.keys(camRolls);
  return rolling.length === 1 && rolling[0] === letter && soundStartedAt === null;
}

/**
 * THE HEAD'S OWN STATE DECISION, pulled out pure so "the header still says
 * REC after a cut" can be pinned in a test without mounting the screen.
 *
 * `rolling` is the only input that matters. A take that has been cut, kept
 * and had its sheet dismissed is `rolling: false` by the time this runs -
 * same as the screen before the very first take of the setup ever happened -
 * so both moments have to answer with the SAME resting form, never the live
 * one. This is what a bad merge of that condition (e.g. gating on `postCut`
 * instead of `rolling`) would break.
 *
 * The resting form carries the slate's own name verbatim. That matters
 * because podcast mode's quick-start slate is literally named "Recording"
 * (see startPodcastRoll in newRoll.ts) - a screen showing "Recording / take
 * 2" at rest is that slate's name and the next take number, not a stuck
 * state word, and this function must not special-case that string away.
 */
export function rollHeadForm(
  rolling: boolean,
  slateName: string,
  nextTakeNumber: number,
): { kind: 'live' } | { kind: 'resting'; name: string; take: number } {
  return rolling ? { kind: 'live' } : { kind: 'resting', name: slateName, take: nextTakeNumber };
}

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

  /**
   * THE TAG PAD'S OWN BUDGET, MEASURED, NOT GUESSED.
   *
   * `.roll__pads` is the only element left on this screen whose CSS still
   * says `overflow-y: auto` for real (see the block comment above this
   * component) - this ref and observer are what stop that from ever firing.
   * `clientHeight` here already reflects everything ELSE in the deck
   * (camstack's row count, the mark row, CUT, every gap and the compact
   * media queries) because flexbox sized the box BEFORE looking at what's
   * inside it - proved empirically: clearing the box's content and
   * re-measuring gave the identical number. So one read, on resize, is
   * enough; there is no feedback loop to guard against; the content this
   * component renders next never changes the number this effect reads.
   */
  // The ResizeObserver that fills padsBudgetPx in from `rolling` lives further
  // down, right after `rolling` itself is derived (useEngine ? anyRolling :
  // timer.rolling) - a hook cannot read a const declared below it.
  const padsRef = useRef<HTMLDivElement | null>(null);
  const [padsBudgetPx, setPadsBudgetPx] = useState<number | null>(null);

  /**
   * THE MOMENTS LOG'S OWN BUDGET, MEASURED THE SAME WAY AS THE TAG PAD'S.
   *
   * `.roll--live .momentlog` sits in the middle grid's own row 3 with
   * `contain: size` (see styles.css) - its clientHeight comes from the grid
   * track, never from what is rendered inside it, same proof as `padsRef`
   * above. Before this, the row rendered every buffered moment and let
   * `overflow: hidden` crop whatever did not fit, which sliced the last row
   * mid-glyph rather than dropping it whole - the third time this exact
   * defect has shipped on this screen (see .roll__stage and .roll__pads'
   * own comments for the first two). `momentlogRef` measures the box;
   * `momentRowProbeRef` measures one real row (its height depends on
   * `--t-secondary`, which the interface-size setting scales, so it cannot
   * be a constant the way `--tap`-backed `LIST_ROW_H` is) via a row rendered
   * off-glass on purpose - see the probe in the JSX below.
   */
  const momentlogRef = useRef<HTMLDivElement | null>(null);
  const [momentlogBudgetPx, setMomentlogBudgetPx] = useState<number | null>(null);
  const momentRowProbeRef = useRef<HTMLDivElement | null>(null);
  const [momentRowH, setMomentRowH] = useState<number | null>(null);

  // `.keypad .keycap`'s own min-height drops from 52 to 44 (var(--tap)) under
  // the SAME `@media (max-height: 700px)` compact tier the camstack and reach
  // row already use - reactive here (not a one-time read) because rotating a
  // tablet or a Safari toolbar collapsing mid-take crosses the boundary
  // without a remount.
  const [compactRows, setCompactRows] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-height: 700px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-height: 700px)');
    const onChange = () => setCompactRows(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // The MORE tile's page, per group. Reset at the top of every fresh take
  // (see openMultiTake/doRoll) so a scene switch or a new take never opens on
  // a stale page from the take before it.
  const [coveragePage, setCoveragePage] = useState(0);
  const [keyPage, setKeyPage] = useState(0);
  const [flatPage, setFlatPage] = useState(0);

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
    setCoveragePage(0); // the MORE tile opens on page 1 for every fresh take
    setKeyPage(0);
    setFlatPage(0);
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
    setCoveragePage(0); // the MORE tile opens on page 1 for every fresh take
    setKeyPage(0);
    setFlatPage(0);
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
    // NO TOAST. It used to say "WIDE marked" over the deck for a couple of
    // seconds; the owner: "tapping a button makes a message of it pressed,
    // dont have it, we have the count x shower of that button press." The line
    // above is that count - it lights the key and puts xN on it - and the
    // count is the better receipt: it persists for the whole take, it is
    // countable, and it does not cover the controls to say so. The haptic
    // already answers the thumb. The clip-fix toast stays: "N later takes
    // moved too" reports something no count on a key can.
    setFlashes((prev) => ({ ...prev, [tag]: (prev[tag] ?? 0) + 1 }));
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

  /**
   * THE TAG PAD'S OWN BUDGET, MEASURED, NOT GUESSED.
   *
   * `.roll__pads` is the only element left on this screen whose CSS still
   * says `overflow-y: auto` for real (see the block comment above this
   * component) - this observer is what stops that from ever firing.
   * `clientHeight` here already reflects everything ELSE in the deck
   * (camstack's row count, the mark row, CUT, every gap and the compact
   * media queries) because flexbox sized the box BEFORE looking at what's
   * inside it - proved empirically: clearing the box's content and
   * re-measuring gave the identical number. So one read, on resize, is
   * enough; there is no feedback loop to guard against, because the content
   * this component renders next never changes the number this effect reads.
   */
  useEffect(() => {
    const el = padsRef.current;
    if (!el) {
      setPadsBudgetPx(null);
      return;
    }
    function recompute() {
      if (!el) return;
      const cs = getComputedStyle(el);
      const verticalPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setPadsBudgetPx(Math.max(0, el.clientHeight - verticalPadding));
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rolling]);

  /** `momentlogBudgetPx`: the moments box's own clientHeight, read the exact
   *  same way as `padsBudgetPx` above and for the same reason - the grid
   *  track sizes it independent of what is rendered inside (see the
   *  `.roll--live .momentlog` comment in styles.css for the `contain: size`
   *  that makes this true). */
  useEffect(() => {
    const el = momentlogRef.current;
    if (!el) {
      setMomentlogBudgetPx(null);
      return;
    }
    function recompute() {
      if (!el) return;
      const cs = getComputedStyle(el);
      const verticalPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setMomentlogBudgetPx(Math.max(0, el.clientHeight - verticalPadding));
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rolling]);

  /** `momentRowH`: one real `.momentrow`'s rendered height, read off a copy
   *  that carries realistic content (a clock plus a tag) but is positioned
   *  off-glass - `position: fixed` takes it out of every ancestor's layout,
   *  so it costs the live screen nothing and cannot itself be the thing that
   *  gets clipped. Observed continuously (not read once) because the row's
   *  height depends on `--t-secondary`, which the interface-size setting
   *  scales at any point, mid-take included. */
  useEffect(() => {
    const el = momentRowProbeRef.current;
    if (!el) {
      setMomentRowH(null);
      return;
    }
    function recompute() {
      if (!el) return;
      setMomentRowH(el.getBoundingClientRect().height || null);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rolling]);

  const elapsedMs = useEngine
    ? takeStartedAt !== null
      ? Math.max(0, nowTick - takeStartedAt)
      : 0
    : // Still derived, never accumulated: the offset only supplies the part of
      // a resumed take's clock that ran before this roll began.
      timer.elapsedMs + resumeOffsetMs;
  const rangeArmedMs = markInMs !== null ? Math.max(0, elapsedMs - markInMs) : 0;
  const rollingLetters = (Object.keys(camRolls) as CameraUnitLetter[]).sort();
  /**
   * WHAT IS ROLLING, said the way a 1st AC says it: "A and sound, rolling".
   * The units come FIRST and the state comes after them, because on a set the
   * question is never "is something rolling" - the ring, the pill and the
   * dots have already answered that three times at three distances. The
   * question is WHICH, and it was the last word on a line that opened with
   * the word everybody already knew.
   *
   * Single-cam has no per-camera slot to read the letter off (see the
   * clipUnits comment above), so it states 'A' here - it is still camera A
   * that is running, and "A + SOUND" is the line an operator is checking
   * against the recorder.
   */
  const rollingUnits = [
    ...(multi ? rollingLetters : anyCamRolling || (!useEngine && timer.rolling) ? ['A'] : []),
    ...(soundRolling ? ['SOUND'] : []),
  ];
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
  /**
   * IS THE ONE CAMERA ACTUALLY TURNING OVER. The unit strip renders a pill for
   * camera A on a single-camera project (see the camstack below), and the pill
   * says REC and runs a clock, so it may only exist while that is true. Two
   * different facts answer it depending on which engine is driving: with sound
   * in play the roll/join engine owns camera A and `camRolls` is the truth
   * (sound commonly rolls FIRST and alone, and a pill claiming REC while only
   * the recorder is running would be a lie the loader pays for); without it,
   * the plain single-cam timer is.
   */
  const singleCamRolling =
    !multi && (useEngine ? camRolls[cameras[0].letter] !== undefined : timer.rolling);

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

  // THE TAG PAD'S TIER, computed from the measured budget (see padsBudgetPx
  // above). Coverage keeps its 3-across grid (short, stable vocabulary -
  // WIDE/CU/OTS - see .keypad--tags); key moments stay their own full-width
  // list (long, scene-specific lines - "Rides into night" - which is why they
  // were never in the 3-col grid to begin with, see .keypad--list). Flat
  // quick-tags (no breakdown) reuse the grid's own math. `null` budget (the
  // one frame before the ResizeObserver's first measurement lands, corrected
  // in a useLayoutEffect-timed re-render before paint - see padsBudgetPx)
  // renders everything; a real device never shows that frame.
  const gridRowH = compactRows ? GRID_ROW_H_COMPACT : GRID_ROW_H;
  const coverageFit =
    padsBudgetPx === null
      ? { visible: coverageChips.length, moreCount: 0, consumedPx: 0 }
      : fitTagGroup(coverageChips.length, padsBudgetPx, gridRowH, 3, TAG_ROW_GAP);
  const keyListBudget =
    padsBudgetPx === null
      ? null
      : Math.max(
          0,
          padsBudgetPx -
            coverageFit.consumedPx -
            (coverageFit.consumedPx > 0 && keyChips.length > 0 ? TAG_GROUP_GAP : 0),
        );
  const keyFit =
    keyListBudget === null
      ? { visible: keyChips.length, moreCount: 0, consumedPx: 0 }
      : fitTagGroup(keyChips.length, keyListBudget, LIST_ROW_H, 1, TAG_ROW_GAP);
  const flatTags = project.tags.filter((tag) => tag !== 'GOLD');
  const flatFit =
    padsBudgetPx === null
      ? { visible: flatTags.length, moreCount: 0, consumedPx: 0 }
      : fitTagGroup(flatTags.length, padsBudgetPx, gridRowH, 3, TAG_ROW_GAP);

  const coverageVisible = tagPageSlice(coverageChips, coverageFit.visible, coveragePage);
  const keyVisible = tagPageSlice(keyChips, keyFit.visible, keyPage);
  const flatVisible = tagPageSlice(flatTags, flatFit.visible, flatPage);

  /**
   * THE MOMENTS LOG'S OWN TIER, same `fitTagGroup` math the tag pad uses
   * above with `cols: 1` (one full-width row per moment, same shape as the
   * key-moment list). `null` while either measurement has not landed yet
   * renders NOTHING rather than everything: the tag pad can afford one frame
   * of "show it all, correct before paint" because that frame is still a
   * WHOLE row set (`overflow-y` was the thing scrolling it, not a clip). This
   * box's failure mode is a mid-glyph slice, so the safer default on an
   * unmeasured frame is the same one the stage itself uses when it cannot
   * show a whole readout (see `@container stage` in styles.css): blank,
   * never partial.
   *
   * Newest first, oldest dropped: `buffered` already renders reversed (most
   * recent moment on top), and that ordering is deliberate upstream of this
   * fix too, not just kept by accident. The take's own full list is always
   * on the take card after CUT; what this box is FOR, mid-take, is "what did
   * I just log" - the operator confirming the tap that just fired, not
   * auditing the whole take. That is what stays on screen when it cannot
   * hold everything, with a `+N more` row (itself one more real row, same
   * height, same budget) standing in for the older marks that do not fit -
   * so "there is more" is always stated, never silently dropped.
   */
  const momentFit =
    momentlogBudgetPx === null || momentRowH === null
      ? { visible: 0, moreCount: 0, consumedPx: 0 }
      : fitTagGroup(buffered.length, momentlogBudgetPx, momentRowH, 1, TAG_ROW_GAP);
  const momentsVisible = [...buffered].reverse().slice(0, momentFit.visible);
  // "+N MORE" ONLY MAKES SENSE ABOVE A LIST. `fitTagGroup` is a 1-col fit
  // here, so a budget that fits exactly one row still hands that whole row
  // to the MORE tile once the moment count exceeds 1 (rows=1, visible=1*1,
  // which is < count, so the truncation branch takes the tile's own row
  // back and `visible` lands on 0) - not a bug in the fit, `rowsThatFit` /
  // `fitTagGroup` are still whole-rows-or-none, this box just asked for a
  // count with nothing above it to be "more" than. `moreTileCopy` (below,
  // exported so scripts/shoot-roll.mjs's live check and this file's own
  // unit tests both pin the same decision) reads `visible === 0` as exactly
  // that state and states the count as a fact instead - same box, same
  // height, same gate (`moreCount > 0`), only the words change.
  const moreCopy = momentFit.moreCount > 0 ? moreTileCopy(momentFit) : null;

  /** One tag key, shared by every tier above - a plain function rather than a
   *  component so the long-press handlers below (already bound to `this`
   *  render's closures) do not have to be threaded through props. */
  function renderTagKey(tag: string) {
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
  }

  /** THE MORE TILE. Reserves the last visible cell of a truncated group and
   *  PAGES on tap - the explicit, always-visible control the brief asks for
   *  in place of a scroll. Never fires a tag itself, so it can never be
   *  mistaken for tapping one: same keycap shape, a chevron instead of a
   *  label, so it reads as "more of these" rather than as a tag with a
   *  strange name. */
  function renderMoreTile(hiddenCount: number, onTap: () => void, label: string) {
    return (
      <button
        type="button"
        className="chip keycap keycap--more"
        aria-label={`${hiddenCount} more ${label} - tap to see the next`}
        onClick={() => {
          haptics.tap();
          onTap();
        }}
      >
        <span className="keycap__label">+{hiddenCount}</span>
        <span className="keycap__more" aria-hidden="true">&rsaquo;</span>
      </button>
    );
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
  // See rollHeadForm's own comment: pulled out pure so the resting-state form
  // (never the live pill, whatever the slate is named) is a decision that can
  // be pinned in a test independent of this render.
  const headForm = rollHeadForm(rolling, slate.name, nextTakeNumber);

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
        {headForm.kind === 'live' ? (
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
            <div className="name">{headForm.name}</div>
            <div className="roll__nextline">
              <span>
                take <span className="tnum">{headForm.take}</span>
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
        {/* THE READOUT BLOCK, and it is ONE box on purpose. The clock, the
            state line and the take bar are a single unit that must never move
            relative to each other or to the screen: while rolling they are the
            middle zone's `auto` grid row, centred between two rows that
            collapse instead of pushing them (see .roll--live .roll__stage).
            Before this they were three loose flex items in a `safe center`
            column with the moments list beside them, so every tag tapped
            during a take re-centred the clock and moved the take bar - which
            is what the owner filmed. */}
        {(rolling || postCut) && (
        <div className="stage__now">
          <div className={`readout${rolling ? ' readout--live' : ' readout--idle'}`}>
            {/* Post-cut the drums hold the take that just closed, not zero:
                the number the screen is holding IS the take you just finished,
                and it is the one the sheet below is asking about. */}
            <DrumClock value={clockMMSS(rolling ? elapsedMs : (postCut?.take.durationMs ?? 0))} />
          </div>
        <div className="stage__hint">
          {rolling ? (
            <span className="stage__reclabel">
              {/* The DOT is red because shape plus colour is how this app has
                  always stated "rolling" under red set-lighting and to a
                  red/green-blind operator. */}
              <span className="recdot" aria-hidden="true" />
              {rollingUnits.length > 0 && (
                <span className="stage__units">{rollingUnits.join(' + ')}</span>
              )}
              {' ROLLING'}
              {/* The frame rate belongs on the live line, not only on the
                  pre-roll slate: it is the one setting that silently ruins a
                  take, and this is the line the operator's eye is already on. */}
              {` · ${project.fps} FPS`}
            </span>
          ) : (
            'Take saved'
          )}
        </div>

        {/* THE SEGMENT BAR. Sixty ticks, one per second, filling across the
            current minute and starting again on the next - see TakeBar. */}
        {rolling && <TakeBar elapsedMs={elapsedMs} />}
        </div>
        )}

        {rolling ? (
          <>
            {/* THE ROW PROBE. One real `.momentrow`, positioned off every
                ancestor's layout so it costs the live screen nothing and can
                never itself be the thing that gets clipped - see
                `momentRowH` above for why this has to be measured live
                rather than assumed. Rendered whenever `rolling` is, not only
                once a moment exists, so the very first tap already has a
                real number to fit against. */}
            <div
              ref={momentRowProbeRef}
              className="momentrow"
              aria-hidden="true"
              style={{ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden', pointerEvents: 'none' }}
            >
              <span className="at">0:00</span>
              <span className="tag">TAG</span>
            </div>
            {/* THE BOX ITSELF, always mounted while rolling - never gated on
                `buffered.length`. `momentlogRef` has to point at a stable
                node for `momentlogBudgetPx`'s effect (keyed on `rolling`,
                same as `padsBudgetPx`'s) to find on the frame it runs: a box
                that only appears once the first moment lands would still be
                unmounted the one time that effect fires, and the budget
                would stay `null` - which reads as "nothing ever fits" -
                forever, not just for a frame. Empty, it renders nothing
                (no padding, no children, `contain: size` in the live grid),
                so this costs the idle-of-moments case no pixels. */}
            <div className="momentlog" aria-label="Moments this take" ref={momentlogRef}>
              {momentsVisible.map((m, i) => (
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
              {moreCopy && (
                <div className="momentrow momentrow--more" aria-label={moreCopy.ariaLabel}>
                  <span>{moreCopy.text}</span>
                </div>
              )}
            </div>
          </>
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
              //
              // AND IT HAS TO FIT. That 448px void is gone: on a scene with a
              // breakdown the shot wheel takes ~300px of the middle zone and
              // leaves this box ~206px, so the second sentence — the one
              // itemising clip name, duration and tags — was being sliced
              // through its own last line. An empty state that cannot finish
              // its sentence reads as a crash, which is the exact impression
              // the longer copy was written to avoid.
              //
              // So it says the one thing that is useful BEFORE a take exists:
              // which two buttons, in which order, and where the result shows
              // up. The itemising was describing a table that appears, fully
              // labelled, the instant the first CUT lands — explaining it in
              // advance was telling someone what a receipt looks like while
              // they are still holding the money.
              <div className="lasttake">
                <div className="lasttake__k">
                  <span>Nothing rolled yet</span>
                </div>
                <p className="lasttake__first">
                  Hit ROLL, then CUT. Your first take lands here.
                </p>
              </div>
            )}

            {report?.last ? (
              // THIS SETUP and DAY N are one mass, split by a hairline. It
              // used to be a slot of ground cut down between them with flared
              // mouths, so it would read as machined metal rather than as two
              // cards with a gap. On a true-black ground the slot is the same
              // colour as the page, so the flare stopped reading as a mouth
              // and started reading as a curve floating between two numbers.
              <div className="statpair">
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

      {/* THE SHOT DECK. Last thing in the top band, directly above the deck.
          It is `flex: 0 0 auto` in a box that no longer scrolls, so its height
          is part of the screen's fixed geometry - which is why it renders as
          ONE card while rolling rather than a 300px wheel (see LIVE_CARD_H in
          ShotDeck.tsx). Absent for a scene with no shot breakdown; that case
          keeps the scene pager above. */}
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
            {/* THE WAY OUT, and it has to READ as one. It said "Scenes"
                always, which is true of a project with a scene list and says
                nothing at all on a one-scene project - the owner, looking at
                exactly that screen: "can't go back from here to back menu."
                The destination was never wrong (it pops to the project, which
                is where he wanted to be); the word was. So the word names the
                place when there is a list to go back to, and is plainly BACK
                when there is not. Idle only, as before: a way off this screen
                beside CUT during a take is how a take gets lost. */}
            <button
              type="button"
              className="reachbtn"
              aria-label={siblings.length > 1 ? 'Back to scenes' : `Back to ${project.name}`}
              onClick={props.onExit}
            >
              <BackMark />
              <span>{siblings.length > 1 ? 'Scenes' : 'Back'}</span>
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
                className="reachbtn reachbtn--log"
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
        {/* THE UNIT ROW. Every camera AND sound, as compact pills in one wrap
            grid. Sound used to sit below the cameras inside its own titled,
            blue-edged panel, which is what made it read as a different KIND of
            thing that had to be handled separately - it took a heading, a
            hint line and a border to say "this is also a unit". It is a pill
            among the pills now, told apart by the speaker mark on its badge:
            a SHAPE, which survives red set-lighting and a colour-blind
            operator, where the blue never did. */}
        {(multi || (hasSoundUnit && soundUnit) || singleCamRolling) && (
          <div className="camstack" aria-label="Every unit - tap one to roll, join, or cut it alone">
            {/* ONE CAMERA IS A STACK OF ONE. The whole strip used to be gated on
                multi-cam-or-sound and the camera map gated on multi again, so a
                single-camera project rendered no unit pill at all - and the clip
                number and the running per-unit clock live ON that pill. The
                owner's words: "in single camera rooling mode i cannot see the
                clip number, in multicam i can see cameras but in single not
                even single is not visible." The clip name is the string he
                reads aloud to the loader, so it cannot be the one thing missing
                from the screen he is holding while the camera turns over.

                Same markup, same classes, same component as a multi-cam pill -
                deliberately not a second readout, which would drift.

                It renders WHILE THE CAMERA IS ROLLING and not before, and that
                is a statement of fact rather than a saving: idle, the reach row
                below already carries this project's next clip with the pencil
                that fixes it, and two clip numbers on one idle screen is a
                worse screen. It is also not a button: with one camera there is
                nothing to solo-cut - CUT ends the take - and a tappable pill
                beside CUT mid-take is how a take gets lost. */}
            {singleCamRolling && (
              <div
                className="camslot camslot--rolling"
                aria-label={`Camera A rolling ${renderUnitClip(liveUnit(cameras[0]))}`}
              >
                <span className="camslot__top">
                  <span className="camslot__badge">{cameras[0].letter}</span>
                  {cameras[0].operator && (
                    <span className="camslot__operator">{cameras[0].operator}</span>
                  )}
                  <span className="camslot__elapsed tnum">
                    <span className="recdot" aria-hidden="true" /> REC{' '}
                    {tc.msToClock(useEngine ? elapsedForCam(cameras[0].letter) : elapsedMs)}
                  </span>
                </span>
                <ClipNum parts={unitClipParts(liveUnit(cameras[0]))} className="camslot__clip tnum" />
              </div>
            )}
            {multi && cameras.map((u) => {
              const camIsRolling = camRolls[u.letter] !== undefined;
              // What this camera's card is actually on right now - past any
              // file it already closed and reopened inside this same take.
              const live = liveUnit(u);
              if (camIsRolling) {
                // This unit is rolling: tap it to cut just this camera.
                // UNLESS it is the last thing still rolling - see
                // isSoleRollingUnit above. Cutting it there would silently
                // close the whole shot, and the owner's own report on this
                // exact pill was "tapping this cuts the scene." A solo pill
                // has no business ending a take: CUT is the one control this
                // screen ever confirms past a wrap prompt, and it stays the
                // only one, so a guarded tap does nothing destructive and
                // says where to go instead, off-screen text and all -
                // there is nowhere left ON this pill to put a second label
                // without it competing with the clip number underneath it.
                // State is never colour-only: the dot shape + "REC" text next
                // to the running clock reads the same under red set-lighting
                // or to a red/green colour-blind operator.
                const guarded = isSoleRollingUnit(u.letter, camRolls, soundStartedAt);
                return (
                  <button
                    key={u.letter}
                    type="button"
                    className="camslot camslot--rolling"
                    data-guarded={guarded ? '' : undefined}
                    aria-label={
                      guarded
                        ? `Camera ${u.letter} rolling ${renderUnitClip(live)}, the only unit left - use CUT to end the take`
                        : `Camera ${u.letter} rolling ${renderUnitClip(live)}, tap to cut it`
                    }
                    onClick={() => {
                      if (guarded) {
                        haptics.tap();
                        setToast('Only unit left rolling - CUT ends the take');
                        return;
                      }
                      void soloCut(u.letter);
                    }}
                  >
                    <span className="camslot__top">
                      <span className="camslot__badge">{u.letter}</span>
                      {u.operator && <span className="camslot__operator">{u.operator}</span>}
                      <span className="camslot__elapsed tnum">
                        <span className="recdot" aria-hidden="true" /> REC {tc.msToClock(elapsedForCam(u.letter))}
                      </span>
                      {/* THE STOP AFFORDANCE. This pill used to be a badge, a
                          clip name and a clock - the vocabulary of a readout,
                          not a control, on top of this app's one destructive
                          action. One small square earns its keep without
                          turning the whole pill into a second CUT button: a
                          stop-square is the one glyph a set already reads as
                          "this ends something" off a hundred other decks.
                          Hollow when guarded, matching the unlit "not joined"
                          treatment above rather than the fully faded opacity
                          this file already rejected once - the tap still
                          lands, it just does not cut. */}
                      <span className="camslot__stopicon" aria-hidden="true" />
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
            {hasSoundUnit && soundUnit && (
            <>
            {soundRolling ? (
              // Rolling: tap to cut just sound. If the cameras are already
              // done, this is the LAST thing going and the shot closes.
              <button
                type="button"
                className="camslot camslot--rolling"
                aria-label={`Sound rolling ${renderSoundFile(soundUnit)}, tap to cut it`}
                onClick={() => void soundSoloCut()}
              >
                <span className="camslot__top">
                  <span className="camslot__badge camslot__badge--sound" aria-hidden="true"><SpeakerMark /></span>
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
                  <span className="camslot__badge camslot__badge--sound" aria-hidden="true"><SpeakerMark /></span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  <span className="camslot__join">DONE</span>
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
                  <span className="camslot__badge camslot__badge--sound" aria-hidden="true"><SpeakerMark /></span>
                  {soundUnit.operator && <span className="camslot__operator">{soundUnit.operator}</span>}
                  <span className="camslot__join">JOIN</span>
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
                    <span className="camslot__badge camslot__badge--sound" aria-hidden="true"><SpeakerMark /></span>
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
            </>
            )}
          </div>
        )}

        {rolling && (
          <>
            {/* THE PADS DO NOT SCROLL. They used to be the one part of the
                deck allowed to - the owner filmed it, twice, on a real
                phone, and asked for it to stop both times. `padsBudgetPx`
                (measured above) is the box's own real height; every group
                below renders only as many rows as that number allows, and a
                truncated group gets a MORE tile instead of an overflow - see
                the block comment above the component for the mechanism and
                the measurement that motivated it. */}
            <div className="roll__pads" ref={padsRef}>
            {editingTags ? (
              // Long-press landed. Same box, a different job: this project's
              // live vocabulary instead of the keys that tap it. TagEditor
              // owns add/remove/GOLD-lock; this screen only owns persistence
              // ("saves as you go" - every change commits, DONE below only
              // closes) and the heading the mockup asks for. Not put through
              // the same MORE-tile clamp as the tiers below - see
              // .rolltagsdeck's own compact rule in roll.css for what keeps
              // MAX_TAGS=16 inside .roll__pads's measured budget instead.
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
                {/* Tier 1: sizes, THE THREE-ACROSS TAG GRID - unchanged shape,
                    now clamped to `coverageFit.visible` rows instead of every
                    coverage tag the scene carries. Guarded on length, same as
                    tier 2 below it: GOLD used to sit in this grid and kept it
                    non-empty even when a scene carried no coverage tags of its
                    own, so an empty grid never had to be a case. Now that GOLD
                    lives by MARK IN, an ungated map() left a stray empty bar
                    behind for exactly that scene. */}
                {coverageChips.length > 0 && (
                  <div className="keypad keypad--tags" aria-label="Coverage">
                    {coverageVisible.map(renderTagKey)}
                    {coverageFit.moreCount > 0 &&
                      renderMoreTile(coverageFit.moreCount, () => setCoveragePage((p) => p + 1), 'coverage tags')}
                  </div>
                )}
                {keyChips.length > 0 && (
                  // Tier 2: moments, a scannable list - full-width rows,
                  // because a key moment is a scene-specific sentence
                  // ("Rides into night"), not a keycap word, and a fixed grid
                  // cell would either clamp it to two lines of nothing or (at
                  // three columns) never fit it at all. Same clamp as tier 1:
                  // rows past `keyFit.visible` become a MORE tile rather than
                  // an overflow.
                  <div className="keypad keypad--list" aria-label="Key moments">
                    {keyVisible.map(renderTagKey)}
                    {keyFit.moreCount > 0 &&
                      renderMoreTile(keyFit.moreCount, () => setKeyPage((p) => p + 1), 'key moments')}
                  </div>
                )}
              </>
            ) : (
              // No breakdown: the flat quick-tag set is THE SAME TAG GRID the
              // coverage tier above uses, now under the same clamp. GOLD is
              // filtered out here too: it moved to its own grade action by
              // MARK IN, see goldAvailable below.
              <div className="keypad keypad--tags" aria-label="Quick tags">
                {flatVisible.map(renderTagKey)}
                {flatFit.moreCount > 0 &&
                  renderMoreTile(flatFit.moreCount, () => setFlatPage((p) => p + 1), 'tags')}
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
            <span className="camslot__badge camslot__badge--sound" aria-hidden="true"><SpeakerMark /></span>
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
