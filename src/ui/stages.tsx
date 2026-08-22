// THE STAGED FLOW — one decision per screen, a position rail, and a footer.
//
// Extracted from ShotlistSheet, which built it first, because three more flows
// now want it (project creation, filing, backup) and three private copies of a
// progress rail is how an app ends up with three progress rails that disagree
// about what "step 2" looks like.
//
// It is deliberately DUMB. It owns the rail, the panel's enter animation and
// the footer; it owns nothing about what a stage contains, which stage is next,
// or whether you may leave one. Those belong to the flow, because they are the
// only interesting part and every flow answers them differently.
//
// WHY THE PANEL IS KEYED. React reuses a DOM node when only its children
// change, so the enter animation would play once and never again. Keying it on
// the stage forces a remount per stage, which is what makes the movement read
// as travel rather than as a repaint.

import type { ReactNode } from 'react';

/** Which way the last move went, so a stage can animate in from the side it
 *  came from. Back arriving from the same side as forward reads as a glitch. */
export type StageDir = 'fwd' | 'back';

export function StageRail(props: {
  /** 0-based position in `total`. */
  index: number;
  total: number;
  /** Named for the screen reader, which gets the only prose here. */
  title: string;
}) {
  return (
    <div className="sl-rail">
      <div className="sl-rail__bars" aria-hidden="true">
        {Array.from({ length: props.total }, (_, i) => (
          <span key={i} className="sl-rail__bar" data-on={i <= props.index ? '' : undefined} />
        ))}
      </div>
      <span className="sl-rail__step" aria-hidden="true">
        {props.index + 1} of {props.total}
      </span>
      {/* The rail is bars and a numeral, both of which are silent. This is the
          only thing a screen reader gets, so it carries the whole position. */}
      <p className="visually-hidden" role="status">
        Step {props.index + 1} of {props.total}: {props.title}
      </p>
    </div>
  );
}

/** The panel a stage's content sits in. Key it on the stage — see the header. */
export function StagePanel(props: { dir: StageDir; children: ReactNode }) {
  return (
    <div className="sl-panel" data-dir={props.dir}>
      {props.children}
    </div>
  );
}

/** The footer every stage ends with: back out on the left, go on the right.
 *  Sticky to the sheet's own scroller, because a stage tall enough to scroll
 *  would otherwise push the way forward off the bottom of the phone — which is
 *  a form again, just a taller one. */
export function StageActions(props: { children: ReactNode }) {
  return <div className="sheet__actions sl-actions">{props.children}</div>;
}
