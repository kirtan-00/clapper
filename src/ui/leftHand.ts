// Left-hand mode: for an operator holding the phone in their left hand, thumb
// crossing in from the left edge instead of the right.
//
// Same shape as theme.ts / cutsize.ts: a tiny persisted pub-sub, guarded
// storage, default resolved on any failure. STAMPED AT MODULE LOAD rather
// than from an effect - same reasoning cutsize.ts gives for UiSize: this
// module is imported through SettingsScreen.tsx, which App.tsx imports
// statically, so it resolves well before React's first render and there is
// no flash to prevent by waiting for an effect.
//
// WHERE THE ATTRIBUTE ACTUALLY LANDS: `data-lefthand` on <html>, read by
// src/skin/shell.css. Off is the absence of the attribute, so the shipped
// layout is never even branched on for the operator who has not opened this
// control - the same contract `standard` gets in cutsize.ts.

export const LEFTHAND_KEY = 'clapper.leftHand';

function read(): boolean {
  try {
    return localStorage.getItem(LEFTHAND_KEY) === '1';
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(LEFTHAND_KEY, on ? '1' : '0');
  } catch {
    /* the toggle still works for this session, it just will not survive it */
  }
}

function paint(on: boolean): void {
  if (typeof document === 'undefined') return; // unit tests run without a DOM
  const root = document.documentElement;
  if (on) root.setAttribute('data-lefthand', '');
  else root.removeAttribute('data-lefthand');
}

let current = read();
const listeners = new Set<() => void>();

paint(current);

export function getLeftHand(): boolean {
  return current;
}

export function subscribeLeftHand(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setLeftHand(on: boolean): void {
  if (on === current) return;
  current = on;
  write(on);
  paint(on);
  for (const fn of listeners) fn();
}
