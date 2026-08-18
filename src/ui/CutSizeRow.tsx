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

import { useSyncExternalStore } from 'react';
import { CUT_SIZE_LABEL, getCutSize, setCutSize, subscribe, type CutSize } from './cutsize';
import * as haptics from './haptics';

const SIZES: CutSize[] = ['standard', 'large', 'xl'];

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
        {SIZES.map((s) => (
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
