// The shot-card deck. Replaces the old .shotstrip (a flat prev/now/next pill)
// and .roll__summary (the action line duplicated under it) with the mockup's
// stacked cards: the current setup as a filled mass carrying its own spec,
// take count and description, with the next setup peeking dimmed beneath it,
// and a tick rail down the side standing in for "N of M" at a glance.
//
// NAME: this is `.shotdeck`, never `.roll__deck` — that class already belongs
// to the ROLL/CUT/tag-pad region lower on the screen (see roll.css). Two
// "decks" on one screen would be a name collision waiting to bite the next
// person who greps for it.
//
// R3 added the drag: this is the same object the pitch's "Descriptions ride
// an up/down wheel" section describes, not a second widget. Drag anywhere on
// the stack and it tracks the finger 1:1; release and it snaps to the
// nearest shot with a settle, same as the pitch's own detent rail. Rubber-
// bands past the first and last shot rather than stopping dead, at the
// pitch's own 0.35x travel. Tapping the current card still opens the full
// jump sheet; tapping a card that is not current jumps straight to it — the
// same act a settled drag ends in, just without the travel.
//
// THE INDEX STAYS CONTROLLED BY THE PARENT throughout: this component never
// owns "which shot is current", only the in-flight pixel offset of a drag
// that has not yet been committed. `onAdvance` fires once, at the END of a
// settle, and only if the settle actually landed on a different shot — a
// tap that bounces back to the same card never calls it. That keeps this
// component's contract identical to R1's (a controlled shotIndex + a single
// commit callback), so nothing downstream had to change to gain the wheel.

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TransitionEvent as ReactTransitionEvent,
} from 'react';
import type { Shot } from '../types';
import { sizeInWords } from './shotlist';

/** Card height and the gap below it, in one place because the drag math and
 *  the CSS have to agree on exactly the same number or a settled drag lands
 *  a few pixels off the card it just chose. Fixed rather than measured — the
 *  pitch's own dcard is a fixed 196px for the same reason: a wheel whose
 *  step size changes with each card's description length cannot have
 *  reliable detents. Short descriptions leave a little air in the card
 *  instead, which is the trade the mockup itself makes. */
const CARD_H = 172;
const CARD_GAP = 12;
const STEP = CARD_H + CARD_GAP;
/** How much of the next card peeks under the current one, at rest. 96 was
 *  tall enough to show the row (code/spec/takes) and not one pixel more - the
 *  approved pitch's own peek shows the start of the next setup's DESCRIPTION
 *  fading out, which is what earns the peek its vertical space at all (it
 *  previews what you are about to shoot, not just proves another card
 *  exists). At 96 the description's own first line starts past where the
 *  viewport's mask has already faded it to nothing, so it never became
 *  visible in the first place - not a fade, an absence. 128 buys back enough
 *  room for that first line or two before the mask (below) takes over. */
const PEEK = 128;
const VIEWPORT_H = CARD_H + PEEK;
/** WHILE A CAMERA IS ROLLING THE WHEEL IS DEAD, so it stops paying rent.
 *  `locked` already disables every card, so the peek previews a setup nobody
 *  can move to and the wheel has no detents to find - 300px of the screen
 *  spent on chrome for a gesture that cannot happen. What is still worth
 *  having is the FACT: which setup this is and what it is. So live, the deck
 *  is one card of code, spec and two lines of description.
 *  The number is the budget: at 667px - the shortest phone this has to hold -
 *  the three zones plus a 300px wheel do not fit, and the two things that must
 *  never yield are the clock block and CUT. Measured: 116 is the card's own
 *  content height at a 2-line clamp (16 padding + 27 code row + 11 + 46 of
 *  text + 15 padding), so nothing is cut through the middle of a glyph. */
const LIVE_CARD_H = 116;
/** Past the first or last shot, the drag still moves but at this fraction of
 *  finger travel — the pitch's own "rubber-band at 0.35x travel". */
const RUBBER = 0.35;
/** Same threshold TagEditor's long-press uses for entering edit mode; here
 *  it is what tells a drag apart from a tap so a tap does not get read as a
 *  zero-distance drag that happens to settle back on the same card. */
const DRAG_SLOP = 6;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function ShotDeckFace(props: { shot: Shot; takes: number }) {
  const { shot, takes } = props;
  return (
    <>
      <div className="shotdeck__row">
        <span className="shotdeck__code tnum">{shot.code}</span>
        <span className="shotdeck__spec">
          {[sizeInWords(shot.size), shot.move].filter(Boolean).join(' · ') || '—'}
        </span>
        <span className="shotdeck__takes tnum">
          {takes === 0 ? 'no takes' : `${takes} take${takes === 1 ? '' : 's'}`}
        </span>
      </div>
      {shot.action && <div className="shotdeck__text">{shot.action}</div>}
    </>
  );
}

export function ShotDeck(props: {
  shotList: Shot[];
  shotIndex: number;
  shot: Shot;
  nextShot: Shot | null;
  /** Kept takes logged against a shot, looked up by id — see refreshMeta's
   *  allTakes in RollingScreen.tsx. A function rather than a Map so the
   *  caller can memoise however it likes. */
  takeCountFor: (shotId: string) => number;
  locked: boolean;
  onOpenJump: () => void;
  onAdvance: (shot: Shot) => void;
}) {
  const { shotList, shotIndex, locked } = props;

  // The live drag offset, in pixels, applied to the whole stack. Zero except
  // during and immediately after a drag gesture - the settled state always
  // reflects the parent's shotIndex with dragPx back at 0.
  const [dragPx, setDragPx] = useState(0);
  const [settling, setSettling] = useState(false);

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const startYRef = useRef(0);
  const dragOriginRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const pendingTargetRef = useRef<number | null>(null);

  function clampProjected(projected: number): number {
    const max = shotList.length - 1;
    if (projected < 0) return projected * RUBBER;
    if (projected > max) return max + (projected - max) * RUBBER;
    return projected;
  }

  function commit(target: number) {
    const clamped = Math.max(0, Math.min(shotList.length - 1, target));
    if (clamped !== shotIndex) props.onAdvance(shotList[clamped]);
    setDragPx(0);
    setSettling(false);
    pendingTargetRef.current = null;
  }

  function onStackPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (locked || !e.isPrimary || e.button !== 0 || shotList.length < 2) return;
    pointerIdRef.current = e.pointerId;
    draggingRef.current = true;
    movedRef.current = false;
    startYRef.current = e.clientY;
    dragOriginRef.current = dragPx;
    setSettling(false);
  }

  function onStackPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
    const dy = e.clientY - startYRef.current;
    if (!movedRef.current && Math.abs(dy) > DRAG_SLOP) {
      movedRef.current = true;
      // Only claim the gesture once it is provably a drag, not a tap - a
      // captured pointer stops roll__body's own scroller from also reading
      // it, and a tap must never do that.
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (!movedRef.current) return;
    const raw = dragOriginRef.current + dy;
    // Up = next (the card below comes up to meet the thumb), down = previous
    // - the same direction a real deck of cards moves under a dragging thumb.
    const projected = clampProjected(shotIndex - raw / STEP);
    setDragPx((shotIndex - projected) * STEP);
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    if (!movedRef.current) {
      // A tap, not a drag - leave it to the card's own onClick.
      return;
    }
    const projected = shotIndex - dragPx / STEP;
    const target = Math.max(0, Math.min(shotList.length - 1, Math.round(projected)));
    if (prefersReducedMotion()) {
      commit(target);
      return;
    }
    pendingTargetRef.current = target;
    setSettling(true);
    setDragPx((shotIndex - target) * STEP);
  }

  function onStackTransitionEnd(e: ReactTransitionEvent<HTMLDivElement>) {
    if (e.propertyName !== 'transform' || pendingTargetRef.current === null) return;
    commit(pendingTargetRef.current);
  }

  // Render a window around the current shot rather than every shot in the
  // scene - a 47-shot breakdown is a lot of DOM for five that can ever be on
  // screen. Radius 2 (not 1) because a fast drag can cover more than one
  // step before release; the rubber band still stops it from reaching a
  // card this window does not carry.
  const windowRadius = 2;
  const lo = Math.max(0, shotIndex - windowRadius);
  const hi = Math.min(shotList.length - 1, shotIndex + windowRadius);
  const cards: { shot: Shot; i: number }[] = [];
  for (let i = lo; i <= hi; i++) cards.push({ shot: shotList[i], i });

  return (
    <div className={`shotdeck${locked ? ' shotdeck--live' : ''}`}>
      <div
        className="shotdeck__viewport"
        style={{ height: locked ? LIVE_CARD_H : shotList.length > 1 ? VIEWPORT_H : CARD_H }}
      >
        <div
          className={`shotdeck__wheelstack${settling ? ' is-settling' : ''}`}
          style={{ transform: `translateY(${-shotIndex * STEP + dragPx}px)` }}
          onPointerDown={onStackPointerDown}
          onPointerMove={onStackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onTransitionEnd={onStackTransitionEnd}
        >
          {/* Which card reads as "current" tracks the DRAG, not just the
              settled shotIndex - so the dark/light swap happens exactly at
              the halfway point of the finger's travel, before the gesture
              even ends. Falls back to the plain shotIndex the instant the
              drag is not live (dragPx is always 0 then), so nothing about
              idle rendering changes. */}
          {cards.map(({ shot: s, i }) => {
            const liveCurrent = Math.round(shotIndex - dragPx / STEP);
            const isCurrent = i === liveCurrent;
            return (
              <button
                key={s.id}
                type="button"
                className={`shotdeck__card${isCurrent ? ' shotdeck__card--now' : ' shotdeck__card--off'}`}
                style={{ top: i * STEP }}
                disabled={locked}
                aria-label={
                  isCurrent
                    ? `Shot ${s.code} of ${shotList.length}. Tap to jump to another shot.`
                    : `Shot ${s.code}. Tap to make it current.`
                }
                onClick={() => {
                  if (movedRef.current) return; // the drag already decided this
                  if (isCurrent) props.onOpenJump();
                  else props.onAdvance(s);
                }}
              >
                <ShotDeckFace shot={s} takes={props.takeCountFor(s.id)} />
              </button>
            );
          })}
        </div>
      </div>
      {shotList.length > 1 && (
        // The rail states "you are the Nth of M" as a shape - reads at a
        // glance for the five or six shots most scenes carry. Past that a
        // shape stops being countable on its own (the approved pitch itself
        // pairs its rail with a "1 / 7" numeral), so the digits ride along
        // too rather than replacing the rail - position AND count, the same
        // pairing a scrollbar-with-page-number gives you. Tracks the drag
        // the same live way the lit tick does, so the two never disagree
        // mid-gesture.
        <div className="shotdeck__rail" aria-hidden="true">
          <span className="shotdeck__count tnum">
            {Math.round(shotIndex - dragPx / STEP) + 1}/{shotList.length}
          </span>
          <div className="shotdeck__ticks">
            {shotList.map((s, i) => (
              <span
                key={s.id}
                className={`shotdeck__tick${
                  i === Math.round(shotIndex - dragPx / STEP) ? ' is-cur' : ''
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
