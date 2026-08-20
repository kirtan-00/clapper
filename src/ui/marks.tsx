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
 * Sound — the recorder's own driver-and-cone glyph, replacing the 🔊 emoji
 * that stood in for it. An emoji is the loudest "nobody designed this" tell
 * there is: it renders differently per platform and carries a fixed colour no
 * `currentColor` can touch, so a "live" sound row and a discarded one drew
 * identically. This is closed (fill:none, stroked outline) rather than the
 * usual filled speaker glyph, so it reads as ONE weight with every other mark
 * in this file instead of a heavier borrowed icon dropped in beside them.
 */
export function SpeakerMark() {
  return (
    <svg {...SVG} className="mark mark--speaker">
      <path d="M11 5 7 8.8H3v6.4h4l4 3.8z" {...STROKE} />
      <path d="M14.5 9a4.2 4.2 0 0 1 0 6" {...STROKE} />
      <path d="M17.5 6.5a8 8 0 0 1 0 11" {...STROKE} />
    </svg>
  );
}

/**
 * Edit. The pen the app has been spelling as the literal character U+270E, in
 * five places, inside 44px boxes — which is exactly the failure the header of
 * this file describes: a glyph with its own side bearings, sitting on a
 * baseline, centred as though it were a box. It also renders as a different
 * pen on every platform and as a colour EMOJI on some, which no `currentColor`
 * can reach.
 *
 * Drawn as the nib and the barrel, plus the short rule the nib sits on, so it
 * reads as "write on this" rather than as a generic diagonal at 17px.
 */
export function EditMark() {
  return (
    <svg {...SVG} className="mark mark--edit">
      <path d="M16.2 4.6a2 2 0 0 1 2.8 2.8L9.4 17H6.6v-2.8z" {...STROKE} />
      <path d="M13.9 6.9 16.7 9.7" {...STROKE} />
      <path d="M5 20.2h14" {...STROKE} />
    </svg>
  );
}

/**
 * Done / in step. The one mark in this file drawn HEAVIER than the house 1.75,
 * for the same reason the back chevron is: it renders at 11px inside a status
 * pill beside 11px caps, and a 1.75 tick at that size lands under one device
 * pixel and greys out while the word next to it stays solid.
 */
export function CheckMark() {
  return (
    <svg {...SVG} className="mark mark--check">
      <path d="M5 12.8 9.8 17.6 19 6.9" {...STROKE} strokeWidth={2.4} />
    </svg>
  );
}

/** Queued to leave. An arrow standing on the line it is waiting to cross —
 *  the outbox, drawn, rather than a spinner pretending something is happening
 *  right now. Same heavier weight as CheckMark and for the same reason. */
export function UpMark() {
  return (
    <svg {...SVG} className="mark mark--up">
      <path d="M12 18.5V6" {...STROKE} strokeWidth={2.4} />
      <path d="M6.4 11.6 12 6l5.6 5.6" {...STROKE} strokeWidth={2.4} />
    </svg>
  );
}

/**
 * The one loud mark in the app. A held write is the single moment the log and
 * reality could diverge, and it is the only thing besides the tally ring
 * allowed to raise its voice — in amber, never in red, because red is
 * recording and nothing else is ever allowed to borrow it.
 */
export function AlertMark() {
  return (
    <svg {...SVG} className="mark mark--alert">
      <path d="M12 4.2 21.2 20H2.8z" {...STROKE} strokeWidth={1.9} />
      <path d="M12 10v4.4" {...STROKE} strokeWidth={2.2} />
      <path d="M12 17.4h.01" {...STROKE} strokeWidth={2.4} />
    </svg>
  );
}

/**
 * The Pro spark. Replaces the literal U+2605 BLACK STAR the CTA was setting in
 * live text, which arrives at a different size and weight in every font the
 * app might fall back to and cannot be given a stroke.
 *
 * Four points, not five: a five-pointed star is a RATING, and nothing here is
 * being rated. Four is the sparkle idiom - "there is more of this" - and it is
 * drawn on the house grid so it sits in a row of other marks without shouting.
 */
export function SparkMark() {
  return (
    <svg {...SVG} className="mark mark--spark">
      <path d="M12 3.5c0 4.7 3.8 8.5 8.5 8.5-4.7 0-8.5 3.8-8.5 8.5 0-4.7-3.8-8.5-8.5-8.5 4.7 0 8.5-3.8 8.5-8.5Z" {...STROKE} />
    </svg>
  );
}

/**
 * How many characters of previous-screen name fit beside a title before the
 * title starts losing words. Measured on an iPhone 14 viewport against the
 * longest real title in the app ("SC 1 · EXT. GIFT CITY — LATE NIGHT"): at 18
 * characters of label the title truncated at "EXT. GIFT CIT...".
 */
const BACK_LABEL_MAX = 14;

/**
 * The labelled back button, in the iOS idiom: a chevron and the NAME of the
 * screen you are going back to, not a bare arrow.
 *
 * The fallback to the word "Back" when the name is too long is iOS's own rule,
 * not a shortcut around it. UIKit measures the previous title against the space
 * left over and substitutes "Back" when it will not fit, because the title of
 * the screen you are ON matters more than the name of the one behind it. A
 * character count is the cheap version of that measurement and lands in the
 * same place for every screen this app has. The accessible name always carries
 * the real destination.
 */
export function BackButton(props: { label: string; onClick: () => void }) {
  const shown = props.label.length > BACK_LABEL_MAX ? 'Back' : props.label;
  return (
    <button
      type="button"
      className="backbtn"
      aria-label={`Back to ${props.label}`}
      onClick={props.onClick}
    >
      <BackMark />
      <span className="backbtn__label">{shown}</span>
    </button>
  );
}
