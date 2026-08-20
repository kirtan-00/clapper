// Thin React furniture over the SHARED grouped-inset list CSS in ui/list.css.
//
// The CSS is owned centrally and deliberately not re-implemented here — this
// file only stops Settings and Account from spelling the same class soup two
// slightly different ways. Structure, hairline inset, 44px floor and the
// tabular-numeral value column all live in list.css.
//
// Two marks, hand-drawn on the house grid: 24 viewBox, 1.75 stroke, round caps
// and joins, one corner-radius family, `stroke="currentColor"` so the colour
// arrives from the row and both themes work with no extra code. A chevron for
// anything that pushes, an arrow leaving a box for anything that leaves the
// app. No third glyph — a column of decorative icons is exactly the noise the
// brief rules out, so rows carry an icon only where it earns its place.

import { useEffect, useState, type ReactNode } from 'react';

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Pushes deeper. Optically centred: the ink is drawn left of 12 so the gap to
 *  the row's right edge reads even rather than measuring even. */
export function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="13" height="13">
      <path d="M9.5 5.5 16 12l-6.5 6.5" {...STROKE} />
    </svg>
  );
}

/** Leaves the app. Same weight and corner family as the chevron. */
export function ExternalMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="13" height="13">
      <path d="M13.5 4.5H19.5V10.5" {...STROKE} />
      <path d="M19.5 4.5 11 13" {...STROKE} />
      <path d="M17 14v4a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4 18v-8A2.5 2.5 0 0 1 6.5 7.5h4" {...STROKE} />
    </svg>
  );
}

/**
 * True once the document has scrolled past a thumb's worth of drift (12px:
 * before the title has really moved, after a resting finger has stopped
 * counting). Every `data-scrolled` in the app comes from here, so the hairline
 * under a large title, a nav bar and the home masthead all appear on the same
 * beat rather than three screens each picking their own threshold.
 *
 * The document IS the scroller on every screen that uses this; the rolling
 * screen, which scrolls inside itself, has no material chrome at all.
 */
export function useScrolled(threshold = 12) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > threshold);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  return scrolled;
}

/**
 * The large title, in a sticky material bar that it shrinks into on scroll —
 * the iOS idiom, and the tab roots' half of the material chrome. The type ramp
 * and the timing live in ui/list.css (`.ltitle` and `[data-scrolled] .ltitle`);
 * this only decides WHEN.
 *
 * The hairline under the bar appears only once there is content behind it, so
 * a screen at rest is a title on paper rather than a title in a box.
 */

/**
 * THE MARK — the wordmark and a copyright notice, right side of the large
 * title. It is a NOTICE, not a control: no href, no tap target, no hover. The
 * title it shares a line with is the thing being read, so the mark sits a
 * weight and a size below it and takes --ink-faint, which is the one colour in
 * the ramp reserved for text nobody needs.
 *
 * The icon is inline SVG rather than an <img> of the favicon, because the
 * favicon is a 1024px app tile with a rounded-square ground and it would read
 * as a button at 15px. This is the slate alone.
 */
export function ScreenMark() {
  return (
    <span className="lmark" aria-label="Clapper, copyright 2026">
      <svg className="lmark__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="2" y="9" width="20" height="13" rx="2.5" fill="currentColor" opacity="0.32" />
        <path
          d="M2.6 3.9 21 2l.5 4.4L3.1 8.3z"
          fill="currentColor"
        />
        <path d="M7.4 3.4 5.9 7.9M12.6 2.9l-1.5 4.5M17.8 2.4l-1.5 4.5" stroke="var(--paper)" strokeWidth="1.5" />
      </svg>
      <span aria-hidden="true">CLAPPER</span>
      <span className="lmark__c" aria-hidden="true">\u00a9</span>
    </span>
  );
}

export function ScreenHeader(props: { title: string }) {
  const scrolled = useScrolled();

  return (
    <header className="ltop" data-scrolled={scrolled ? '' : undefined}>
      <h1 className="ltitle">{props.title}</h1>
      <ScreenMark />
    </header>
  );
}

/** One group: header outside the card, rows inside it, footnote under it. */
export function Section(props: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="glist">
      {props.title && <h2 className="glist-hdr">{props.title}</h2>}
      <div className="glist-card">{props.children}</div>
      {props.note && <p className="glist-note">{props.note}</p>}
    </section>
  );
}

interface RowFace {
  label: string;
  /** Muted right-hand text. */
  value?: ReactNode;
  /**
   * Set on every value that is a NUMBER. The shared `.grow-value` is already
   * tabular, but tabular in the UI face is not the house style: every number in
   * this app is mono, so a quota counting down from 5 changes its digit and
   * nothing else. Words ("Unlimited", an email) stay in the UI face, which is
   * what makes the numbers read as numbers.
   */
  mono?: boolean;
  icon?: ReactNode;
}

function Face(props: RowFace & { trailing?: ReactNode }) {
  return (
    <>
      {props.icon && <span className="grow-icon">{props.icon}</span>}
      <span className="grow-label">{props.label}</span>
      {props.value !== undefined && (
        <span className={`grow-value${props.mono ? ' tnum' : ''}`}>{props.value}</span>
      )}
      {props.trailing && <span className="grow-chev">{props.trailing}</span>}
    </>
  );
}

/** A row that acts. `push` adds the chevron; only rows that go somewhere get one. */
export function Row(
  props: RowFace & {
    onClick: () => void;
    push?: boolean;
    /** The one row on a screen that is the reason you came to it. */
    primary?: boolean;
    destructive?: boolean;
    disabled?: boolean;
  },
) {
  return (
    <button
      type="button"
      className="grow"
      data-icon={props.icon ? '' : undefined}
      data-primary={props.primary ? '' : undefined}
      data-destructive={props.destructive ? '' : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Face
        label={props.label}
        value={props.value}
        mono={props.mono}
        icon={props.icon}
        trailing={props.push ? <Chevron /> : undefined}
      />
    </button>
  );
}

/** A row that leaves the app. An anchor, so it behaves like one. */
export function LinkRow(props: RowFace & { href: string }) {
  return (
    <a
      className="grow grow--link"
      data-icon={props.icon ? '' : undefined}
      href={props.href}
      target="_blank"
      rel="noopener"
    >
      <Face label={props.label} value={props.value} mono={props.mono} icon={props.icon} trailing={<ExternalMark />} />
    </a>
  );
}

/** A row that only reports. No press state, no chevron, not a control. */
export function ReadRow(props: RowFace) {
  return (
    <div className="grow" data-static="" data-icon={props.icon ? '' : undefined}>
      <Face label={props.label} value={props.value} mono={props.mono} icon={props.icon} />
    </div>
  );
}
