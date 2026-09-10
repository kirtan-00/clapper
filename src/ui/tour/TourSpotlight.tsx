// THE SPOTLIGHT — dims the screen, cuts a hole around whatever `data-tour`
// id the current step names, and floats a caption card near it without
// covering it.
//
// THE HOLE IS A SHADOW, NOT A SHAPE. `.tour-hole` is a transparent box sized
// and positioned exactly over the target's own `getBoundingClientRect()`,
// and everything outside it is dimmed with `box-shadow: 0 0 0 9999px
// var(--scrim-bg)` — the same dim colour every Sheet already uses. A
// box-shadow is never a hit target, so `pointer-events: none` on this whole
// overlay is enough to let every real tap through to the real element
// underneath it, on EVERY step — there is no separate "let this one step's
// target through" mode to get wrong. Only the caption card opts back into
// `pointer-events: auto`, for its own two buttons.
//
// ON-ACTION STEPS ARE WATCHED, NOT WIRED. This component never reaches into
// RollingScreen's or ProjectScreen's state — it listens for a real DOM
// `click` bubbling up to `document` and checks whether it landed inside the
// CURRENT step's target. The real screen never has to know the tour exists,
// which is the whole point of driving the actual UI instead of a fake one.
//
// TARGET NOT FOUND — OR NOT REACHABLE — RENDERS NOTHING. If the step's
// `data-tour` id is not on the page right now (the operator is
// mid-navigation, or backed out of a sheet the step wanted open), this draws
// nothing at all rather than a spotlight around empty air. The same is true
// when the element IS still there but something else has been stacked on top
// of it without unmounting it — a gated tap under the target opening a
// SignInSheet over an already-open export sheet, say: the target's rect is
// still real, but a ring drawn there would float over whatever now owns that
// screen area, which reads as the tour pointing at the wrong thing.
// `useTargetRect`'s own `isReachable` check is what catches that second case.
// The polling loop below keeps looking every 250ms plus on every
// resize/scroll, so the moment the real element is back on top the spotlight
// picks it back up — no separate "waiting" state to manage, and nothing
// stranded: whatever opened over the target closes on its own terms, same as
// every other sheet in this app.
//
// REDUCED MOTION NEEDS NO CODE HERE. styles.css's global
// `@media (prefers-reduced-motion: reduce)` block (and shell.css's
// `[data-motion="reduce"]` twin, for the in-app force) already rewrites
// EVERY element's `transition-property` to `opacity` and kills every
// `animation` outright — see reduceMotion.ts's header for why that is a
// deliberate global rule and not a per-component opt-in. This file only has
// to use ordinary CSS transitions and keyframes and both overrides apply for
// free.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { advancesOnAction } from './tourRules';
import type { TourStep } from './tourSteps';
import * as haptics from '../haptics';

/** Space kept between the hole's edge and the real element it wraps. */
const HOLE_PAD = 6;
/** Space kept between the hole and the caption card. */
const CARD_GAP = 14;
/** Never closer than this to a viewport edge. */
const EDGE_MARGIN = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** Is the target actually the thing sitting at its own centre point right
 *  now, or does something newer occupy that pixel? `elementFromPoint`
 *  ignores `pointer-events: none` (this overlay's own hole and ring, so
 *  those never self-trigger a false negative), which is exactly the
 *  property that makes it the right check: only a REAL, tappable layer on
 *  top counts as occluding. See the file header's "TARGET NOT FOUND — OR NOT
 *  REACHABLE" note for the regression this exists to catch. */
function isReachable(el: Element, r: Rect): boolean {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  if (!top) return false;
  return el.contains(top) || top.contains(el);
}

/** Find the step's target and keep its rect current. null = not on the page
 *  right now. Polls rather than relying only on resize/scroll — a step
 *  change, a sheet opening, a tag pad's MORE tile paging: none of those fire
 *  either event, and this is one small overlay, not a hot loop on a heavy
 *  tree, so a quarter-second poll costs nothing worth guarding. */
function useTargetRect(targetId: string): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    let alive = true;
    // Once per step, not once per poll: a fresh `nav.pop()`/`nav.push()`
    // lands the new screen at scrollTop 0 (nav.ts is explicit that scroll
    // position never persists across a navigation), and the target this step
    // wants can easily sit below the fold - the export tile under seven scene
    // cards on a short phone, or KEEP under a tall PostCutSheet. A spotlight
    // drawn around an element nobody can see is worse than the pre-scroll
    // flash `scrollIntoView` costs once.
    let scrolledIntoView = false;
    function recompute() {
      if (!alive) return;
      const el = document.querySelector(`[data-tour="${targetId}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      if (!scrolledIntoView) {
        scrolledIntoView = true;
        const outOfView = r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth;
        if (outOfView) {
          // Instant, not smooth - no `scroll-behavior: smooth` is set
          // anywhere in this app, so this is already the reduced-motion-safe
          // form. The capture-phase `scroll` listener below (this same
          // effect) recomputes the rect the instant it lands.
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
          return;
        }
      }
      const next: Rect = { top: r.top, left: r.left, width: r.width, height: r.height };
      if (!isReachable(el, next)) {
        // Something real (not this overlay - see isReachable's own header) is
        // stacked on top of the target. Same answer as "not on the page at
        // all": draw nothing, keep polling, pick it back up the moment it's
        // clear.
        setRect(null);
        return;
      }
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    }
    recompute();
    const interval = window.setInterval(recompute, 250);
    window.addEventListener('resize', recompute);
    // Capture phase: an inner scroller (the tag pad, a sheet body) fires
    // `scroll` on itself, which never bubbles - capture is the only phase
    // that sees it on the way down.
    window.addEventListener('scroll', recompute, true);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [targetId]);

  return rect;
}

interface CardPos {
  top: number;
  left: number;
}

/** Where the card lands: above or below the hole per `placement` ('auto'
 *  picks off which half of the screen the target is in), flipped to the
 *  other side if there is not enough room, then clamped so it never runs off
 *  a narrow phone. */
function placeCard(hole: Rect, cardW: number, cardH: number, placement: TourStep['placement']): CardPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wantsTop = placement === 'top' || (placement === 'auto' && hole.top > vh / 2);

  let top = wantsTop ? hole.top - CARD_GAP - cardH : hole.top + hole.height + CARD_GAP;
  const noRoomAbove = wantsTop && top < EDGE_MARGIN;
  const noRoomBelow = !wantsTop && top + cardH > vh - EDGE_MARGIN;
  if (noRoomAbove) top = hole.top + hole.height + CARD_GAP; // flip down
  else if (noRoomBelow) top = hole.top - CARD_GAP - cardH; // flip up
  top = Math.min(Math.max(top, EDGE_MARGIN), Math.max(EDGE_MARGIN, vh - cardH - EDGE_MARGIN));

  let left = hole.left + hole.width / 2 - cardW / 2;
  left = Math.min(Math.max(left, EDGE_MARGIN), Math.max(EDGE_MARGIN, vw - cardW - EDGE_MARGIN));

  return { top, left };
}

export function TourSpotlight(props: {
  step: TourStep;
  stepNumber: number;
  totalSteps: number;
  onAdvance: () => void;
  onSkip: () => void;
}) {
  const { step } = props;
  const targetRect = useTargetRect(step.target);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardPos, setCardPos] = useState<CardPos | null>(null);

  // Advance/skip read through refs so the click listener and the resize
  // measurement below never have to list a freshly-created function prop as
  // a dependency and re-subscribe every render.
  const onAdvanceRef = useRef(props.onAdvance);
  onAdvanceRef.current = props.onAdvance;

  // ON-ACTION: listen for the real tap, on the real element, and never touch
  // anything else about it. Bubble phase, after the app's own handlers have
  // already run - this only ever OBSERVES, it never intercepts.
  useEffect(() => {
    if (!advancesOnAction(step.advance)) return;
    function onClick(e: MouseEvent) {
      const el = e.target;
      if (!(el instanceof Element)) return;
      if (el.closest(`[data-tour="${step.target}"]`)) {
        haptics.tap();
        onAdvanceRef.current();
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [step.target, step.advance]);

  // Position the card once its own size is known - it has to render (even if
  // only off-glass) before offsetWidth/Height mean anything, so this is a
  // layout effect keyed on the rect and the card's own presence, not a
  // one-time measurement.
  useLayoutEffect(() => {
    if (!targetRect) {
      setCardPos(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const hole = {
      top: targetRect.top - HOLE_PAD,
      left: targetRect.left - HOLE_PAD,
      width: targetRect.width + HOLE_PAD * 2,
      height: targetRect.height + HOLE_PAD * 2,
    };
    setCardPos(placeCard(hole, card.offsetWidth, card.offsetHeight, step.placement));
  }, [targetRect, step.placement]);

  // Nothing to wrap right now - see the file header on why this is silent
  // rather than a spotlight around empty air.
  if (!targetRect) return null;

  const hole = {
    top: Math.max(0, targetRect.top - HOLE_PAD),
    left: Math.max(0, targetRect.left - HOLE_PAD),
    width: targetRect.width + HOLE_PAD * 2,
    height: targetRect.height + HOLE_PAD * 2,
  };

  const onAction = advancesOnAction(step.advance);
  const last = props.stepNumber === props.totalSteps;

  return (
    <div className="tour-overlay" aria-live="polite">
      <div
        className="tour-hole"
        aria-hidden="true"
        style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
      />
      <div
        ref={cardRef}
        className="tourcard"
        role="dialog"
        aria-label={step.title}
        // Invisible until placeCard has something real to put it at - a card
        // pinned at 0,0 for one frame reads as a glitch, not a tour.
        style={cardPos ? { top: cardPos.top, left: cardPos.left, opacity: 1 } : { top: 0, left: 0, opacity: 0 }}
      >
        <span className="tourcard__step">
          Step {props.stepNumber} of {props.totalSteps}
        </span>
        <h3 className="tourcard__title">{step.title}</h3>
        <p className="tourcard__body">{step.body}</p>
        {onAction && <p className="tourcard__hint">Do it for real — that's what moves this on.</p>}
        <div className="tourcard__actions">
          <button type="button" className="btn btn--ghost tourcard__skip" onClick={props.onSkip}>
            Skip tour
          </button>
          {!onAction && (
            <button type="button" className="btn btn--go" onClick={props.onAdvance}>
              {last ? 'Done' : 'Next'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
