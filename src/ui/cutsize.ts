// The CUT/ROLL button's size, as a scale factor the operator picks once.
//
// Kirtan's explicit request (2026-08-15): he shoots this one-handed, sometimes
// in gloves, and the stock button is not always enough target. Three NAMED
// sizes, not a slider — a slider is a fiddly control for a thing set once in
// the van, not fiddled with while a camera is rolling, exactly the reasoning
// ThemeToggleRow already uses for staying a single row instead of a live
// control. Three stops also means every value in CUT_SCALE below was actually
// measured against the worst case (see scripts note in RollingScreen.tsx
// around the CUT-never-off-screen contract) rather than trusted on eyeball -
// a slider's continuous range cannot make that same claim for every point on it.
//
// Same shape as theme.ts on purpose - read/write guarded, default on any
// failure, a tiny pub-sub instead of context so the row can mount anywhere.
// The one thing this module does NOT copy from theme.ts is the DOM paint: the
// theme needs an inline pre-paint script because it is visible at first load
// (index.html) and flashing the wrong theme reads as a bug. The rolling screen
// is never first paint - you always route to it through a project - so there
// is no flash to prevent, and the scale is applied as an inline custom
// property by whichever component renders the button (see RollingScreen.tsx),
// not stamped onto <html> from here.

export type CutSize = 'small' | 'standard' | 'large' | 'xl';

export const CUTSIZE_KEY = 'clapper.cutSize';

/** Every stop, smallest first, and the ONLY list of them. CutSizeRow used to
 *  keep a second copy; adding 'small' to this one left the row still rendering
 *  three buttons, because the two had quietly drifted. Exported so there is
 *  nothing left to drift from. */
export const CUT_SIZES: readonly CutSize[] = ['small', 'standard', 'large', 'xl'];

/**
 * The scale multiplier for `.bigbtn`'s min-height, font-size and internal
 * gap - one token, one rule, per docs/specs/2026-08-15-premium-standard.md.
 * `xl` is the number the hard constraint is actually about: measured with
 * scripts against 4 cameras, Script Mode's wide keypad, the range-label
 * keyboard open, on a 375x667 iPhone SE. Raise it only after re-measuring
 * that exact corner, never on the strength of the idle screen looking fine.
 *
 * `small` is the other end, added at Kirtan's request. It is bounded by the
 * 44px tap floor, not by taste: 104px * 0.72 is 75px, still comfortably the
 * largest target on the screen, and shrinking it further would start trading
 * away the one control that has to be hit without looking.
 */
export const CUT_SCALE: Record<CutSize, number> = {
  small: 0.72,
  standard: 1,
  large: 1.12,
  xl: 1.22,
};

export const CUT_SIZE_LABEL: Record<CutSize, string> = {
  small: 'S',
  standard: 'Standard',
  large: 'Large',
  xl: 'XL',
};

function isCutSize(v: unknown): v is CutSize {
  return typeof v === 'string' && (CUT_SIZES as readonly string[]).includes(v);
}

// Storage throws outright in Safari private mode and with cookies blocked. A
// button-size preference is never worth taking the roll screen down for.
function read(): CutSize {
  try {
    const v = localStorage.getItem(CUTSIZE_KEY);
    return isCutSize(v) ? v : 'standard';
  } catch {
    return 'standard';
  }
}

function write(size: CutSize): void {
  try {
    localStorage.setItem(CUTSIZE_KEY, size);
  } catch {
    /* the picker still works for this session, it just will not survive it */
  }
}

let current: CutSize = read();
const listeners = new Set<() => void>();

export function getCutSize(): CutSize {
  return current;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setCutSize(size: CutSize): void {
  if (size === current) return;
  current = size;
  write(size);
  for (const fn of listeners) fn();
}
