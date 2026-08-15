import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ClipParts } from './cameras';

/**
 * A clip name with its running number driven bright and the boilerplate around
 * it dimmed: "A001_C" quiet, "0191" loud.
 *
 * WHY: this is the string an operator reads ALOUD to the loader, mid-take,
 * glancing. Only the tail changes between takes, so making the eye re-parse
 * eleven flat characters every time is wasted work at the one moment there is
 * none to spare. Screen readers and copy-paste still get the whole name — the
 * split is purely visual, and `parts.full` is the same string renderClip
 * produces.
 */
export function ClipNum(props: { parts: ClipParts; className?: string }) {
  const { parts } = props;
  return (
    <span className={props.className ? `clipnum ${props.className}` : 'clipnum'} title={parts.full}>
      {parts.prefix && <span className="clipnum__fix">{parts.prefix}</span>}
      <span className="clipnum__n">{parts.digits}</span>
      {parts.suffix && <span className="clipnum__fix">{parts.suffix}</span>}
    </span>
  );
}

/**
 * Full-bleed bottom sheet on a scrim. Tapping the scrim dismisses.
 *
 * Two boxes, not one: a MATERIAL cap carrying the grabber and the title, and a
 * body that scrolls UNDER it. The cap is a sibling of the scroller rather than
 * a sticky child of it — `backdrop-filter` inside a scroll container repaints
 * the blur every frame, and this app is used one-handed on old phones. The cap
 * therefore has to be told how tall it is: `--sheet-head-h` is measured once
 * per title (and on resize, for a title that rewraps) and becomes the body's
 * top padding, so no content can ever start underneath it.
 */
export function Sheet(props: {
  title?: string;
  lede?: string;
  onClose?: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  const { title, lede, onClose, children } = props;
  const headRef = useRef<HTMLDivElement | null>(null);
  // Seeded with the two heights the cap actually takes, so the very first
  // paint is already right and nothing jumps once the measurement lands.
  const [headH, setHeadH] = useState(title ? 56 : 34);
  const [scrolled, setScrolled] = useState(false);

  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const measure = () => setHeadH(el.offsetHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [title]);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-scrolled={scrolled ? '' : undefined}
        style={{ '--sheet-head-h': `${headH}px` } as CSSProperties}
      >
        <div className="sheet__head" ref={headRef}>
          <div className="sheet__grab" aria-hidden="true" />
          {title && <h2 className="sheet__title">{title}</h2>}
        </div>
        <div
          className="sheet__body"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 12)}
        >
          {lede && <p className="sheet__lede">{lede}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Destructive confirmation dialog. */
export function Confirm(props: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet title={props.title} lede={props.message} onClose={props.onCancel}>
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

/** Transient confirmation toast that dismisses itself. */
export function Toast(props: { message: string; onDone: () => void }) {
  const doneRef = useRef(props.onDone);
  doneRef.current = props.onDone;
  useEffect(() => {
    const id = window.setTimeout(() => doneRef.current(), 1400);
    return () => window.clearTimeout(id);
  }, [props.message]);
  return <div className="toast" role="status">{props.message}</div>;
}

/** The clapper-stick stripe rail (the app signature motif). */
export function Rail(props: { thin?: boolean; clap?: boolean }) {
  return (
    <div
      className={`rail${props.thin ? ' rail--thin' : ''}${props.clap ? ' rail--clap' : ''}`}
      aria-hidden="true"
    />
  );
}
