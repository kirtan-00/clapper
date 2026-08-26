// The clapperboard "clap" sound. Plays at exactly two moments in the app: a
// new project created, an export finished successfully. Nowhere else.
//
// ============================================================================
// WHY <audio>, NOT THE WEB AUDIO API - read this before "improving" it.
// ============================================================================
//
// This app is used ON A FILM SET, DURING TAKES, by a script supervisor
// standing feet from a boom mic. That person flips their phone's HARDWARE
// SILENT SWITCH before a take specifically so the phone cannot make a noise.
// A stray sound mid-take ruins the take, costs real money, and gets the app
// banned from set.
//
// On iOS, the Web Audio API (AudioContext, an AudioBufferSourceNode, a
// library like Howler or Tone that wraps either) IGNORES the hardware
// silent switch and plays at full volume regardless of it. An
// HTMLMediaElement - a plain <audio> tag, or `new Audio(...)` - DOES respect
// the silent switch. This has been WebKit's documented behaviour for years
// (Web Audio is treated as an "interactive" sound category that bypasses the
// ringer switch; <audio>/<video> are treated as "media playback" and honour
// it) and is the reason this file is built on `new Audio(...)` and never
// imports AudioContext or any wrapper around it. If a future iOS release
// changes this, that is a fact to re-verify against real WebKit release
// notes before touching this file - not something to assume away.
//
// Do not swap this for howler.js, Tone.js, or any other audio library
// without re-checking the same claim for it: most of them exist precisely to
// get lower latency out of Web Audio, which on iOS means silently
// reintroducing the exact bug this file exists to avoid.
//
// ============================================================================
// THE DEFAULT: OFF.
// ============================================================================
//
// On-by-default is friendlier and is arguably "the point" of a fun little
// clap sound - but the guard above only stops the sound from firing mid-take.
// It does nothing for the case that actually worries this app: someone opens
// Clapper for the very first time on a live, hushed set, taps "New Project"
// to get set up, and the phone claps - loud, unexpected, with no warning and
// no chance to have found the Settings row first. Both trigger moments here
// happen away from the camera, true, but "away from the camera" is not the
// same thing as "a moment when a surprise noise is welcome" on a set that
// runs on quiet between setups. The safe failure mode for a feature nobody
// has configured yet is silence, not sound. So: OFF until a crew member
// opts in from Settings. See setSoundOn/isSoundOn below, and the Sound row
// in PreferenceRows.tsx.
//
// ============================================================================
// THE HARD GUARD: NEVER DURING A ROLL.
// ============================================================================
//
// Neither trigger site (project creation, a finished export) is reachable
// while the Rolling screen is mounted and a take is open - but a killed tab,
// a second browser tab/window on the same origin, or a future call site that
// does not know this history could put those two facts in the same moment.
// So playClap() re-checks a fact that is already the app's own definition of
// "a take is in flight app-wide": src/engine/rollCheckpoint.ts's checkpoint.
// It is written (debounced ~300ms) the moment a take starts rolling and is
// cleared the instant it is cut - see rollCheckpoint.ts's own header for why
// that file, not React state, is the source of truth here. React state
// inside RollingScreen only exists while that screen is mounted; the
// checkpoint is the one signal this app already trusts to answer "is a take
// open right now" from anywhere, including a tap handler on a completely
// different screen. A checkpoint present (even a stale one from a crashed
// tab nobody has cleaned up) is treated as "do not risk it" - the two
// trigger moments here are rare enough that erring toward silence never
// costs anything real.
//
// ============================================================================
// THE FILE ITSELF, NOT YET SHIPPED.
// ============================================================================
//
// public/clap.mp3 does not exist yet - the owner supplies it later. Every
// path below has to treat that as a normal, silent outcome: no thrown
// error, no unhandled rejection, no console noise, no broken UI. This is
// not defensive paranoia for a file that will always be there; it is the
// actual, currently-true state of this deploy.

import { readCheckpoint } from '../engine/rollCheckpoint';

export const SOUND_KEY = 'clapper.sound';

// Storage throws outright in Safari private mode and with cookies blocked -
// same rule every other preference module in this file's family (haptics.ts,
// leftHand.ts, reduceMotion.ts) follows: a preference is never worth taking
// a press down for, so read/write are both wrapped and never throw.
function read(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* the toggle still works for this session, it just will not survive it */
  }
}

let current = read();
const listeners = new Set<() => void>();

export function isSoundOn(): boolean {
  return current;
}

/** For a Settings row built on useSyncExternalStore, same shape every other
 *  toggle in this file's family exposes (subscribeHaptics, subscribeLeftHand,
 *  subscribeReduceMotion). */
export function subscribeSound(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setSoundOn(on: boolean): void {
  if (on === current) return;
  current = on;
  write(on);
  for (const fn of listeners) fn();
}

// Built on first use, never at module load - fetching clap.mp3 on app boot
// would be bandwidth spent on a phone tethered to a hotspot on location, for
// a sound that may never play this session. Cached and reused after that so
// a second clap (a second project, a second export) does not re-request the
// file.
let clapEl: HTMLAudioElement | null = null;

/** True app-wide the instant a take is rolling anywhere, false the instant
 *  it is cut - see the file header for why this, and not any React state,
 *  is the guard. */
function takeInFlight(): boolean {
  return readCheckpoint() !== null;
}

/**
 * Play the clap, if the preference is on and nothing is rolling.
 *
 * Both real call sites (create-project's confirm tap, an export button's
 * tap) invoke this synchronously from inside a click handler, which is what
 * makes `.play()` legal on iOS at all - a media element's play() call needs
 * to trace back to a user gesture on iOS Safari, or the returned promise
 * rejects. Keep it that way: no awaiting anything before this call on either
 * call site, or the gesture is spent before playClap() ever runs.
 */
export function playClap(): void {
  if (!current) return;
  if (takeInFlight()) return; // hard guard: never during a roll, full stop.
  if (typeof Audio === 'undefined') return; // vitest runs DOM-less; no window.Audio here
  try {
    if (!clapEl) clapEl = new Audio('/clap.mp3');
    clapEl.currentTime = 0;
    // .play() returns a promise that rejects (never throws synchronously) in
    // two cases this file must treat identically: no user gesture behind the
    // call, and clap.mp3 not existing yet (a 404 rejects the same as an
    // unsupported/missing source). Both are swallowed here - the alternative
    // is an unhandled rejection logged to the console on every project
    // created and every export finished, on every device, until the owner
    // drops the file in.
    void clapEl.play().catch(() => {});
  } catch {
    /* new Audio() or the currentTime reset threw - missing file, unsupported
       format, or an element that never finished loading metadata. Same
       silent no-op as the two cases above. */
  }
}
