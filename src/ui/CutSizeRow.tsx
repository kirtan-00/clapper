// CUT button size, as one settings row.
//
// MOUNTING: renders the ROW ONLY, same contract as ThemeToggleRow - drops
// straight into a `.glist-card` next to it:
//
//   <section className="glist">
//     <h2 className="glist-hdr">Appearance</h2>
//     <div className="glist-card">
//       <ThemeToggleRow />
//       <CutSizeRow />
//     </div>
//   </section>
//
// It takes no props and needs no provider: it reads and writes the size
// itself through src/ui/cutsize.ts. Mount it anywhere, once.
//
// SHAPE: a segmented control (three named stops), not a slider. This is set
// once in the van before call time and is not something to be fine-tuned
// mid-shot - the same "set once, not fiddled with" reasoning ThemeToggleRow's
// header comment gives for staying a single row. A slider would also imply
// every point on its range was checked against the CUT-never-off-screen
// contract, which only the three stops here actually are (see cutsize.ts).
//
// A `.grow` row is one line by contract (list.css), and "CUT button size"
// plus three tap targets does not fit one line at 375px without either
// ellipsising the label or shrinking targets under 44px. So this is a
// two-line row instead: label on top, the control full-width below, the same
// stacked shape iOS Settings uses for Text Size. `growstack` is the one
// override that lets a `.grow` grow taller than --tap for this row only.

import { useSyncExternalStore, type CSSProperties } from 'react';
import {
  CUT_SIZE_LABEL,
  getCutSize,
  setCutSize,
  subscribe,
  type CutSize,
  CUT_SIZES,
  UI_SIZES,
  UI_SIZE_LABEL,
  UI_SIZE_NOTE,
  UI_SCALE,
  getUiSize,
  setUiSize,
  subscribeUiSize,
} from './cutsize';
import * as haptics from './haptics';


// Same house rules as ThemeToggleRow's moon: 24 viewBox, 1.75 stroke, round
// caps and joins, stroke="currentColor", no fill. A button glyph with a
// bigger outer ring than inner face - "the target got bigger", read at a glance.
function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" width="24" height="24">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={1.75} />
      <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth={1.75} />
    </svg>
  );
}

export function CutSizeRow() {
  const size = useSyncExternalStore(subscribe, getCutSize, () => 'standard' as const);

  return (
    <div className="grow growstack" data-icon="" data-static="">
      <div className="growstack__head">
        <span className="grow-icon">
          <TargetIcon />
        </span>
        <span className="grow-label">CUT button size</span>
      </div>
      <div className="cutsize" role="radiogroup" aria-label="CUT button size">
        {CUT_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === size}
            className={`cutsize__opt${s === size ? ' cutsize__opt--on' : ''}`}
            onClick={() => {
              if (s === size) return;
              haptics.tap();
              setCutSize(s);
            }}
          >
            {CUT_SIZE_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

// A specimen, not a symbol: the two letters a type ramp is always judged on.
// It sits in the row head at the CURRENT scale, so the icon column is itself
// the "before" against the three cards below it.
function TypeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" width="24" height="24">
      {/* An A and an a as strokes, on the house 24 grid at 1.75, so this sits
          in the same icon column as the moon and the target without arriving
          as a piece of live text at a different weight. */}
      <path d="M3 19 8 5l5 14" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.7 14.6h6.6" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" />
      <circle cx="17.4" cy="15.7" r="3.4" fill="none" stroke="currentColor" strokeWidth={1.75} />
      <path d="M20.8 12.3V19" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" />
    </svg>
  );
}

/**
 * INTERFACE SIZE — Fine 0.9x / Standard / Glove 1.25x.
 *
 * Same mounting contract as the two rows above it: no props, no provider,
 * drops into a `.glist-card`. It reads and writes through ui/cutsize.ts, which
 * stamps `data-uiscale` on <html>; src/skin/shell.css turns that into the type
 * ramp and the tap floor. Nothing here knows a pixel value.
 *
 * THREE CARDS, EACH AT ITS OWN SCALE, per the approved control. The point is
 * that the control demonstrates itself: "Fine" is a word, but an "Aa" rendered
 * at 0.9 next to one at 1.25 is a decision you can actually make. The scale
 * rides in as a custom property rather than an inline font-size, so the
 * multiplication stays in CSS with every other size in the app.
 *
 * A radiogroup, not a set of buttons: three mutually exclusive stops is what
 * `role="radio"` means, and it is what gets a screen reader "2 of 3" instead
 * of three unrelated presses.
 *
 * BELOW THE CARDS: a live preview of the shot pill and ROLL, the two controls
 * that matter most while a take is actually being shot. It needs no scale of
 * its own to demonstrate one - `data-uiscale` lands on <html>, and
 * `.shotstrip`/`.bigbtn.hw` already read `--ui-scale` through it (see
 * shell.css), so tapping a card resizes this preview the same instant it
 * resizes the row above it. That is the whole point: judge the choice without
 * leaving Settings, on the exact controls the choice is about, not a
 * fabricated stand-in. Sample data, because Settings has no shot in progress
 * to show; `aria-hidden` because it repeats what the three cards already say
 * to a screen reader and adds nothing a live shot pill would not also need a
 * real destination for.
 */
export function UiSizeRow() {
  const size = useSyncExternalStore(subscribeUiSize, getUiSize, () => 'standard' as const);

  return (
    <div className="grow growstack msize" data-icon="" data-static="">
      <div className="growstack__head">
        <span className="grow-icon">
          <TypeIcon />
        </span>
        <span className="grow-label">Interface size</span>
      </div>
      <div className="msize__set" role="radiogroup" aria-label="Interface size">
        {UI_SIZES.map((s) => {
          const on = s === size;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              className={`msize__opt${on ? ' msize__opt--on' : ''}`}
              style={{ '--opt-scale': UI_SCALE[s] } as CSSProperties}
              onClick={() => {
                if (on) return;
                haptics.tap();
                setUiSize(s);
              }}
            >
              <span className="msize__aa" aria-hidden="true">
                Aa
              </span>
              <span className="msize__name">
                {UI_SIZE_LABEL[s]}
                {/* The multiplier belongs on the two stops that ARE one. Saying
                    "Standard 1.0x" would make the default look like a setting
                    somebody chose rather than the ground everything else is
                    measured from. */}
                {s !== 'standard' && <span className="msize__x"> {UI_SCALE[s]}&#215;</span>}
              </span>
              <span className="msize__note">{UI_SIZE_NOTE[s]}</span>
            </button>
          );
        })}
      </div>

      <div className="mprev">
        <span className="mprev__cap">Preview · live</span>
        <div className="mprev__demo" aria-hidden="true">
          <div className="shotstrip">
            <div className="shotstrip__now">
              <span className="shotstrip__code tnum">5.31</span>
              <span className="shotstrip__spec">MCU · push-in</span>
              <span className="shotstrip__pos tnum">3/7</span>
            </div>
          </div>
          <div className="bigbtn hw">
            <span className="hw__well" />
            {/* Literal 'ROLL', not 'Roll' + text-transform: the real button
                (RollingScreen.tsx) renders the literal string uppercase -
                .hw__face carries no text-transform of its own - so a preview
                that lowercases it differs from the control it exists to
                preview in the one property a size comparison is about. */}
            <span className="hw__face">ROLL</span>
          </div>
        </div>
      </div>
    </div>
  );
}
