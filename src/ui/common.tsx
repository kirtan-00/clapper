import { useEffect, useRef, type ReactNode } from 'react';

/** Full-bleed bottom sheet on a scrim. Tapping the scrim dismisses. */
export function Sheet(props: {
  title?: string;
  lede?: string;
  onClose?: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  const { title, lede, onClose, children } = props;
  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grab" aria-hidden="true" />
        {title && <h2 className="sheet__title">{title}</h2>}
        {lede && <p className="sheet__lede">{lede}</p>}
        {children}
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
