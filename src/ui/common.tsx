import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ClipParts } from './cameras';
import { AlertMark, CheckMark, UpMark } from './marks';
import { useSession } from '../net/auth';
import { getSyncStatus, onSyncStatusChange, type SyncStatus } from '../net/sync';

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
 * How long after a dismiss the sheet stays mounted so its exit can play. Must
 * outlast the longer of the sheet's 180ms slide and the scrim's 160ms fade;
 * these live in styles.css under "ENTER, AND EXIT" and move together.
 */
const SHEET_UNMOUNT_MS = 190;

/**
 * The sheet's own dismiss, published to whatever it wraps.
 *
 * A sheet cannot animate itself out if the thing that closes it is a button
 * whose onClick flips the PARENT's state: React unmounts the tree in the same
 * frame and there is nothing left to transition. Anything rendered inside a
 * Sheet can call this instead of the raw close handler and get the exit for
 * free. Null outside a Sheet, so a caller can fall back.
 */
export const SheetDismiss = createContext<(() => void) | null>(null);

/** The sheet's dismiss if there is one, else the raw handler passed in. */
export function useSheetDismiss(fallback: () => void) {
  const dismiss = useContext(SheetDismiss);
  return dismiss ?? fallback;
}

/**
 * The Cancel / Close button every sheet ends with, wired to the sheet's exit.
 *
 * This exists because the hook alone could not reach the buttons that needed
 * it. Context is read where the hook RUNS, and every sheet's footer button is
 * written inside the component that renders `<Sheet>` — one level ABOVE the
 * provider — so `useSheetDismiss` there returns the fallback and the sheet
 * blinks out in a single frame exactly as before. A component is the fix: this
 * one renders where it is written, which is inside the sheet, so it reads the
 * dismiss the same way `ConfirmActions` does.
 *
 * BACKOUTS ONLY. Cancel and Close come through here; Save, Create and Set do
 * not, on the same reasoning as Confirm — the thing they trigger replaces what
 * is underneath, and holding a dead sheet over it for 190ms reads as lag.
 */
export function SheetClose(props: {
  onClose: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const dismiss = useSheetDismiss(props.onClose);
  return (
    <button type="button" className={props.className} disabled={props.disabled} onClick={dismiss}>
      {props.children}
    </button>
  );
}

/** The toast's exit is 120ms, --dur-state on --ease-in. */
const TOAST_EXIT_MS = 130;

// ===========================================================================
// BACKGROUND SCROLL LOCK - filmed on a real iPhone: with a sheet open over
// Home, the "New roll" card and "Where you were" list behind it jumped up and
// down between frames while nothing was touching the screen. The page itself
// was still the document that scrolls, and iOS Safari's own chrome (the URL
// bar) collapsing and expanding as it does resizes the layout viewport and
// silently repositions that scroll - the sheet, pinned by `position: fixed`,
// held still while everything drawn behind it slid.
//
// `overflow: hidden` on <body> does NOT stop this on iOS Safari - it is a
// documented no-op there. The only technique that actually holds: pin body to
// `position: fixed` at its current scroll offset for as long as a sheet is
// mounted, then hand the offset back on the way out.
//
// A COUNTER, NOT A BOOLEAN. HomeScreen swaps the mode-pick sheet straight into
// ShotlistSheet in one state update (see HomeScreen.tsx's pickDirector) - one
// Sheet unmounts and another mounts in the same commit. If this were a
// boolean, whichever effect runs last decides the lock, and an unlock
// sandwiched between two locks would flash the body back into normal flow for
// a frame. The counter only ever unlocks when the last sheet standing closes.
let sheetLockCount = 0;
let sheetLockScrollY = 0;

function lockBackgroundScroll() {
  if (sheetLockCount === 0) {
    sheetLockScrollY = window.scrollY;
    const s = document.body.style;
    s.position = 'fixed';
    s.top = `-${sheetLockScrollY}px`;
    s.left = '0';
    s.right = '0';
  }
  sheetLockCount++;
}

function unlockBackgroundScroll() {
  sheetLockCount = Math.max(0, sheetLockCount - 1);
  if (sheetLockCount === 0) {
    const s = document.body.style;
    s.position = '';
    s.top = '';
    s.left = '';
    s.right = '';
    // Restore AFTER the fixed positioning is gone, or the browser has nothing
    // to scroll - it would land back at 0 instead of where the sheet found it.
    window.scrollTo(0, sheetLockScrollY);
  }
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
  // Enter and EXIT. The sheet used to animate in and then vanish in a single
  // frame, which reads as a dialog being switched off rather than put away.
  //
  // Class-toggled, not a keyframe: a dismiss that lands mid-rise retargets the
  // transform from wherever it currently is instead of queueing a second
  // animation behind the first. `enter` is the pre-paint state, flipped to
  // `open` on the next frame so the browser has something to transition FROM.
  //
  // The exit is subtler and faster than the entrance by contract: 240ms up on
  // --ease-out, 180ms back down on --ease-in, with the scrim fading out in
  // parallel over 160ms. UNMOUNT_MS is the longer of the two plus a frame.
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
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

  useEffect(() => {
    const id = requestAnimationFrame(() => setPhase((p) => (p === 'enter' ? 'open' : p)));
    return () => cancelAnimationFrame(id);
  }, []);

  // Locked for the Sheet's whole mounted life, exit slide included - a sheet
  // still sliding down is still a sheet on screen, and the background must
  // not start moving again a frame before it's gone. useLayoutEffect, not
  // useEffect: HomeScreen swaps one sheet directly into another in the same
  // React commit, and running this before paint keeps the counter (above)
  // from ever letting the browser paint an unlocked frame in between.
  useLayoutEffect(() => {
    lockBackgroundScroll();
    return unlockBackgroundScroll;
  }, []);

  const exitRef = useRef<number | null>(null);
  useEffect(() => () => { if (exitRef.current) window.clearTimeout(exitRef.current); }, []);

  function dismiss() {
    if (!closeRef.current || phase === 'closing') return;
    setPhase('closing');
    exitRef.current = window.setTimeout(() => closeRef.current?.(), SHEET_UNMOUNT_MS);
  }

  return (
    <div
      className="scrim"
      role="presentation"
      data-open={phase === 'open' ? '' : undefined}
      data-closing={phase === 'closing' ? '' : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <SheetDismiss.Provider value={dismiss}>
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
          {/* THE WAY OUT. Until now the head drew only the grabber, which is
              aria-hidden and has no drag handler: it LOOKS like swipe to
              dismiss and is not, which is worse than drawing nothing. The only
              real exits were the scrim and whatever action the CONTENT chose to
              render, so a sheet whose content is a list of sections and no
              action row was a dead end. Setup was exactly that, and the owner
              found it: "from there we cant come back".
              The scrim was never a fair fallback either. The sheet is
              max-height vvh minus 12px, so on a phone the tappable scrim is a
              sliver a few dozen pixels tall above a full height sheet, which is
              not a target anyone hits in gloves at 3am.
              It lives HERE rather than in each caller so every sheet gets it at
              once, and so no future sheet can be built without one. Sheets that
              already carry their own Cancel or Done keep it; two ways out of a
              modal is correct, one is the bug. */}
          {onClose && (
            <button
              type="button"
              className="sheet__close"
              aria-label="Close"
              onClick={dismiss}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
        <div
          className="sheet__body"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 12)}
        >
          {lede && <p className="sheet__lede">{lede}</p>}
          {children}
        </div>
      </div>
      </SheetDismiss.Provider>
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
      <ConfirmActions {...props} />
    </Sheet>
  );
}

/**
 * Split out so it sits INSIDE the Sheet and can read its dismiss. Cancel goes
 * through the sheet, so backing out of a destructive confirmation gets the
 * exit; Confirm does not, because the thing it triggers replaces the screen
 * anyway and holding a dead sheet on top of it for 190ms would read as lag.
 */
function ConfirmActions(props: { confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useSheetDismiss(props.onCancel);
  return (
    <div className="sheet__actions">
      <button type="button" className="btn btn--ghost" onClick={cancel}>
        Cancel
      </button>
      <button type="button" className="btn btn--danger" onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
    </div>
  );
}

/**
 * Transient confirmation toast that dismisses itself.
 *
 * It rises and fades in over --dur-move and leaves over --dur-state on
 * --ease-in, travelling 4px out against the 10px it came in on: an exit is
 * always subtler and faster than its entrance. It used to animate in and then
 * disappear between two frames.
 */
export function Toast(props: { message: string; onDone: () => void }) {
  const doneRef = useRef(props.onDone);
  doneRef.current = props.onDone;
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter');
  useEffect(() => {
    setPhase('enter');
    const raf = requestAnimationFrame(() => setPhase('open'));
    const goOut = window.setTimeout(() => setPhase('closing'), 1400);
    const gone = window.setTimeout(() => doneRef.current(), 1400 + TOAST_EXIT_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(goOut);
      window.clearTimeout(gone);
    };
  }, [props.message]);
  return (
    <div
      className="toast"
      role="status"
      data-open={phase === 'open' ? '' : undefined}
      data-closing={phase === 'closing' ? '' : undefined}
    >
      {props.message}
    </div>
  );
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

// ===========================================================================
// THE SYNC PILL — four states, all of them quiet.
// ===========================================================================
//
// Clapper writes to the phone first and sync is an outbox that drains when it
// can. So OFFLINE IS NOT AN ERROR: on a basement set it is Tuesday, and it
// must never wear red, because red in this app means recording and a colour
// that means two things means neither. No spinner, no progress bar, no
// "reconnecting…" theatre either — the outbox drains itself and the pill
// counts down.
//
// The four faces are read off what the engine ACTUALLY does (src/net/sync.ts,
// src/store/outbox.ts), not off a wish:
//
//   this phone only        no session. `flush()` returns early with no token,
//                          so nothing is queued because nothing is syncing.
//   offline · logging      a session, but navigator says offline or the engine
//   locally                last set state 'offline' for the same reason.
//   n queued               `pendingCount()` — dirty projects plus queued
//                          tombstones — is above zero. INCLUDES the engine's
//                          'error' state on purpose: a failed push leaves
//                          every row queued and retries with backoff, so
//                          "queued" is the true and quiet rendering of it.
//                          Deliberately "3 queued" and not "3 takes queued":
//                          the count is projects and tombstones, not takes.
//   synced                 a session, online, nothing pending.
//
// The one loud state in the whole system is NOT here. It is a failed LOCAL
// write, which is a row that holds the take's slot in the list — see
// HeldWriteRow below.

export type SyncFace = 'synced' | 'queued' | 'offline' | 'local';

// A seam for screenshots and for anyone who has to look at the other three
// faces without a Supabase session. DEV ONLY: `import.meta.env.DEV` is a
// compile-time constant, so the whole block is dropped from the bundle.
let devFace: { face: SyncFace; queued: number } | null = null;
const devFaceListeners = new Set<() => void>();
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clapperSyncFace = (
    face: SyncFace | null,
    queued = 0,
  ) => {
    devFace = face ? { face, queued } : null;
    for (const fn of devFaceListeners) fn();
  };
}

/** The face to show, or null while the session is still being resolved — one
 *  frame of "this phone only" before the session lands would be a lie told
 *  quickly, which is the worst kind. */
export function useSyncFace(): { face: SyncFace; queued: number } | null {
  const { session, loading } = useSession();
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  const [, bump] = useState(0);

  useEffect(() => onSyncStatusChange(setStatus), []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const fn = () => bump((n) => n + 1);
    devFaceListeners.add(fn);
    return () => {
      devFaceListeners.delete(fn);
    };
  }, []);

  if (devFace) return devFace;
  if (loading) return null;
  if (!session) return { face: 'local', queued: 0 };
  if (!online || status.state === 'offline') return { face: 'offline', queued: status.pending };
  if (status.pending > 0) return { face: 'queued', queued: status.pending };
  return { face: 'synced', queued: 0 };
}

/**
 * The pill itself. Presentational and exported separately so a screen can
 * render a face it is not currently in (and so this is drawable in a
 * screenshot without a session).
 */
export function SyncPillFace(props: { face: SyncFace; queued?: number }) {
  const { face, queued = 0 } = props;
  const label =
    face === 'synced'
      ? 'Synced'
      : face === 'queued'
        ? `${queued} queued`
        : face === 'offline'
          ? 'Offline · logging locally'
          : 'This phone only';
  return (
    <span className={`mpill mpill--${face}`} role="status">
      {face === 'synced' && <CheckMark />}
      {face === 'queued' && <UpMark />}
      <span className="mpill__t">{label}</span>
    </span>
  );
}

/** The live pill. Renders nothing until the session is known. */
export function SyncPill() {
  const state = useSyncFace();
  if (!state) return null;
  return <SyncPillFace face={state.face} queued={state.queued} />;
}

// ===========================================================================
// A HELD WRITE — the one thing in this app allowed to be loud.
// ===========================================================================
//
// A failed LOCAL write is the single moment the log and reality can diverge:
// the camera rolled, the operator saw a take number, and the phone did not
// keep it. So this one wears amber (never red — red is recording), it HOLDS
// THE SLOT where it happened rather than vanishing so the gap is visible, it
// says what is actually true, and it never dismisses itself. It offers the one
// action that helps.
//
// AN OPEN API, ON PURPOSE. Any screen that has just failed a local write calls
// `reportHeldWrite` with its OWN two lines, because only the call site knows
// what is true there: a take that failed to save is "held in memory, nothing
// lost yet"; a delete that failed to commit left the take exactly where it
// was and must say so instead. Copy that is nearly true is worse here than no
// copy at all.

export interface HeldWrite {
  /** Stable per failed operation, so a retry that fails again replaces its own
   *  row rather than stacking a second one under it. */
  id: string;
  /** What did not happen. "Take 3 didn't write". */
  title: string;
  /** What is therefore still true. "Held in memory, nothing lost yet". */
  detail: string;
  /** The one action that helps. */
  onRetry: () => void;
}

let heldList: readonly HeldWrite[] = [];
const heldListeners = new Set<() => void>();

function emitHeld(): void {
  for (const fn of heldListeners) fn();
}

export function reportHeldWrite(write: HeldWrite): void {
  heldList = [write, ...heldList.filter((w) => w.id !== write.id)];
  emitHeld();
}

export function clearHeldWrite(id: string): void {
  const next = heldList.filter((w) => w.id !== id);
  if (next.length === heldList.length) return;
  heldList = next;
  emitHeld();
}

function subscribeHeld(fn: () => void): () => void {
  heldListeners.add(fn);
  return () => {
    heldListeners.delete(fn);
  };
}

function heldSnapshot(): readonly HeldWrite[] {
  return heldList;
}

/** Every write currently being held, newest first. */
export function useHeldWrites(): readonly HeldWrite[] {
  return useSyncExternalStore(subscribeHeld, heldSnapshot, heldSnapshot);
}

/** One held write, as the row that holds its slot. */
export function HeldWriteRow(props: { write: HeldWrite }) {
  const { write } = props;
  return (
    <div className="mheld" role="alert">
      <span className="mheld__mark" aria-hidden="true">
        <AlertMark />
      </span>
      <span className="mheld__say">
        <b className="mheld__title">{write.title}</b>
        <span className="mheld__detail">{write.detail}</span>
      </span>
      <button type="button" className="mheld__retry" onClick={write.onRetry}>
        Retry
      </button>
    </div>
  );
}
