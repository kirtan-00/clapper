// THE HOUSE MARKS — one hand, drawn once, used everywhere.
//
// These replace font glyphs (‹ › ✕ ▲ ▼ ↓ + ≡) that were being centred
// GEOMETRICALLY inside 44px boxes. A text glyph carries its own side bearings
// and sits on a baseline, so a box that is mathematically centred puts the ink
// high and slightly left, and forty-four pixels of nothing around a glyph that
// is not where the eye expects it is most of what "sloppy" means on a phone.
// An SVG has no baseline: the viewBox IS the ink's frame, so centring the box
// centres the mark.
//
// The grid is the one TabTray, HomeScreen and glist already draw on, so a back
// arrow, a row chevron and a tab icon read as one set:
//
//   - 24px viewBox, 1.75px stroke, round caps and joins.
//   - `stroke="currentColor"` and never a hardcoded fill, so the colour arrives
//     from the token on the parent and both themes work with no extra code.
//   - Optically centred, not mathematically: a chevron's ink is drawn a little
//     off 12 so the gap reads even rather than measuring even.
//
// NOT SF Symbols (Apple licenses those for Apple-platform UI only), not an icon
// font (this is an offline PWA), not emoji.

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const SVG = { viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false' as const };

/**
 * Back. Heavier than the 1.75 house weight for the same reason the list chevron
 * is: it renders small (17px) beside 17px type, and 1.75 at that size lands
 * near one device pixel and goes to a hairline while the label next to it stays
 * solid. iOS does exactly this - its back chevron is a heavier weight at a
 * smaller point size than the symbols above it.
 *
 * Drawn from x=15.5 to x=9, half a unit right of centre: a left-pointing
 * chevron's mass sits at its apex, so the mathematical centre reads too far
 * left inside a 44px target.
 */
export function BackMark() {
  return (
    <svg {...SVG} className="mark mark--back">
      <path d="M15.5 4.5 9 12l6.5 7.5" {...STROKE} strokeWidth={2.2} />
    </svg>
  );
}

/** Deeper: the mirror of BackMark, at the same weight, for a row or a card. */
export function ForwardMark() {
  return (
    <svg {...SVG} className="mark mark--fwd">
      <path d="M8.5 4.5 15 12l-6.5 7.5" {...STROKE} strokeWidth={2.2} />
    </svg>
  );
}

/** Dismiss. Two strokes crossing on 12,12, so it is centred by construction. */
export function CloseMark() {
  return (
    <svg {...SVG} className="mark mark--close">
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" {...STROKE} />
    </svg>
  );
}

/** Add. Same two-stroke construction as CloseMark, unrotated. */
export function PlusMark() {
  return (
    <svg {...SVG} className="mark mark--plus">
      <path d="M12 5.5v13M5.5 12h13" {...STROKE} />
    </svg>
  );
}

/** A page of numbered rows: a shot division as it comes off the printer. Same
 *  mark HomeScreen draws for the shotlist row, so the two entry points to the
 *  feature carry one icon. */
export function ListMark() {
  return (
    <svg {...SVG} className="mark mark--list">
      <path d="M6.5 3.5h8L19 8v12.5H6.5z" {...STROKE} />
      <path d="M14 3.5V8h5" {...STROKE} />
      <path d="M9.5 12h6M9.5 15.5h6" {...STROKE} />
    </svg>
  );
}

/** Down: the one-time "tap a scene" nudge points at the list under it. */
export function DownMark() {
  return (
    <svg {...SVG} className="mark mark--down">
      <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" {...STROKE} />
    </svg>
  );
}

/**
 * The labelled back button, in the iOS idiom: a chevron and the NAME of the
 * screen you are going back to, not a bare arrow. The label ellipsizes rather
 * than wrapping or being dropped, because a project called "Let's Meet Dobaara"
 * must not push the title out of the bar.
 */
export function BackButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="backbtn"
      aria-label={`Back to ${props.label}`}
      onClick={props.onClick}
    >
      <BackMark />
      <span className="backbtn__label">{props.label}</span>
    </button>
  );
}
