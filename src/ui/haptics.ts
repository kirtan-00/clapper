// Best-effort haptics, scaled by a persisted strength the operator picks once.
// navigator.vibrate is absent on iOS Safari; guard it.
//
// Same shape as theme.ts / cutsize.ts: a tiny persisted pub-sub, guarded
// storage, a default that survives any failure. Firm is that default and it
// is exactly the durations this file always used (12 / 28 / [20,40,40]), so
// nobody who has never opened Settings feels anything change underneath them.
//
// Off is not "smaller vibrations" - it is silence. fire() returns before it
// ever touches navigator, so it is also the branch that is guaranteed never
// to throw or misbehave, which matters because it is the ONE setting that has
// to keep working, unchanged, on a device that never had vibrate to begin
// with: Off there is not a fallback, it is just correct.

export type HapticStrength = 'off' | 'soft' | 'firm';

export const HAPTICS_KEY = 'clapper.haptics';

/** Every stop, quietest first, and the ONLY list of them. */
export const HAPTIC_STRENGTHS: readonly HapticStrength[] = ['off', 'soft', 'firm'];

export const HAPTIC_STRENGTH_LABEL: Record<HapticStrength, string> = {
  off: 'Off',
  soft: 'Soft',
  firm: 'Firm',
};

// Firm is 1x, unscaled - see the file header. Soft is deliberately far enough
// below it to feel like a different setting rather than a rounding error; a
// row that changes a number nobody can feel is decoration, not a control.
const SCALE: Record<HapticStrength, number> = {
  off: 0,
  soft: 0.5,
  firm: 1,
};

function isStrength(v: unknown): v is HapticStrength {
  return typeof v === 'string' && (HAPTIC_STRENGTHS as readonly string[]).includes(v);
}

// Storage throws outright in Safari private mode and with cookies blocked. A
// haptics preference is never worth taking a press down for.
function read(): HapticStrength {
  try {
    const v = localStorage.getItem(HAPTICS_KEY);
    return isStrength(v) ? v : 'firm';
  } catch {
    return 'firm';
  }
}

function write(strength: HapticStrength): void {
  try {
    localStorage.setItem(HAPTICS_KEY, strength);
  } catch {
    /* the picker still works for this session, it just will not survive it */
  }
}

let current: HapticStrength = read();
const listeners = new Set<() => void>();

export function getHapticStrength(): HapticStrength {
  return current;
}

export function subscribeHaptics(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setHapticStrength(strength: HapticStrength): void {
  if (strength === current) return;
  current = strength;
  write(strength);
  for (const fn of listeners) fn();
}

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

// Every call in this file funnels through here, so Off is one early return
// rather than three separate guards, and every duration is rounded to the
// integer ms vibrate() actually wants - a fractional value is silently
// dropped on some Android versions rather than rounded for you.
function fire(ms: number | number[]): void {
  if (current === 'off') return;
  if (!canVibrate()) return; // iOS Safari and the like: the setting holds, the call is just a no-op
  const scale = SCALE[current];
  navigator.vibrate(Array.isArray(ms) ? ms.map((n) => Math.round(n * scale)) : Math.round(ms * scale));
}

export function tap(): void {
  fire(12);
}

export function thump(): void {
  fire(28);
}

export function doubleThump(): void {
  fire([20, 40, 40]);
}
