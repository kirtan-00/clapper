// Reduce motion, forced.
//
// The OS preference already governs every animation in the app - see the
// single `@media (prefers-reduced-motion: reduce)` block in styles.css that
// nukes animations and pins transitions to opacity-only, everywhere, in one
// rule. This module does not duplicate that mechanism in JS; it gives the
// operator a way to trigger the SAME CSS from a phone whose OS setting
// nobody has touched - a borrowed iPad on set, a browser profile that never
// had it turned on.
//
// A ONE-WAY force, not a tri-state, which is why there is no "system" value
// to store: Off here does not mean "motion always on", it means "keep
// following the phone", which the OS media query already does with zero help
// from this file. Only "on" is a fact this module ever has to assert, and it
// asserts it the same way cutsize.ts asserts UiSize - stamped at module load,
// before React's first render, because this module is imported through
// SettingsScreen.tsx which App.tsx imports statically.
//
// WHERE IT LANDS: `data-motion="reduce"` on <html>. shell.css restates the
// exact same rule styles.css's media query already runs, scoped to that
// attribute instead of the media feature - see shell.css for why an
// attribute selector's specificity makes that safe regardless of import order.

export const REDUCE_MOTION_KEY = 'clapper.reduceMotion';

function read(): boolean {
  try {
    return localStorage.getItem(REDUCE_MOTION_KEY) === '1';
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(REDUCE_MOTION_KEY, on ? '1' : '0');
  } catch {
    /* the toggle still works for this session, it just will not survive it */
  }
}

function paint(on: boolean): void {
  if (typeof document === 'undefined') return; // unit tests run without a DOM
  const root = document.documentElement;
  if (on) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');
}

let current = read();
const listeners = new Set<() => void>();

paint(current);

export function getReduceMotion(): boolean {
  return current;
}

export function subscribeReduceMotion(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setReduceMotion(on: boolean): void {
  if (on === current) return;
  current = on;
  write(on);
  paint(on);
  for (const fn of listeners) fn();
}
