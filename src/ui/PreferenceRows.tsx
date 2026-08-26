// Small "how the app behaves in the hand" rows: Haptics, Sound, Keep screen
// awake, Left-hand mode, Reduce motion. The first four were ported from the
// approved pitch (clapper-ui-pitch-v2, "Fine · Standard · Glove"), which
// draws them as title-plus-sublabel rows rather than the icon-led `.grow`
// shape the rest of Settings uses - so this file does not reuse `.grow`, it
// defines its own row (`.mprow` in shell.css) rather than force a two-line
// label into a shape built for one. SoundRow was added later, next to
// HapticsRow, and follows the exact same shape.
//
// MOUNTING: each component renders ONE ROW, same contract as ThemeToggleRow
// and CutSizeRow - drop straight into a `.glist-card`:
//
//   <Section title="Controls">
//     <HapticsRow />
//     <SoundRow />
//     <WakeLockRow />
//     <LeftHandRow />
//     <ReduceMotionRow />
//   </Section>
//
// Every row takes no props and needs no provider - each reads and writes
// through its own module (haptics.ts, clapsound.ts, engine/wakeLock.ts,
// leftHand.ts, reduceMotion.ts), the same "mount anywhere, once" contract
// every other settings row in this app already follows.

import { useSyncExternalStore } from 'react';
import {
  HAPTIC_STRENGTHS,
  HAPTIC_STRENGTH_LABEL,
  getHapticStrength,
  setHapticStrength,
  subscribeHaptics,
  type HapticStrength,
} from './haptics';
import { getWakeLockSetting, setWakeLockSetting, subscribeWakeLockSetting } from '../engine/wakeLock';
import { getLeftHand, setLeftHand, subscribeLeftHand } from './leftHand';
import { getReduceMotion, setReduceMotion, subscribeReduceMotion } from './reduceMotion';
import { isSoundOn, setSoundOn, subscribeSound } from './clapsound';
import * as haptics from './haptics';

/** Title-plus-sublabel left half, shared by all four rows below. */
function Body(props: { title: string; sub: string }) {
  return (
    <span className="mprow__body">
      <span className="mprow__t">{props.title}</span>
      <span className="mprow__s">{props.sub}</span>
    </span>
  );
}

/** The trailing switch, same picture `ThemeToggleRow` draws - one track, one
 *  knob, so a toggle reads as the same idiom everywhere it appears. */
function Switch(props: { on: boolean }) {
  return (
    <span className={`tswitch${props.on ? ' tswitch--on' : ''}`} aria-hidden>
      <span className="tswitch__knob" />
    </span>
  );
}

/**
 * HAPTICS — Off / Soft / Firm.
 *
 * A row, not a control: the row itself is `data-static` because the tappable
 * surface is the segmented control beside it, same division CutSizeRow draws
 * between its label and its `.cutsize` group.
 *
 * The tap AFTER `setHapticStrength` is deliberate, not an oversight: haptics.ts
 * reads its module-level setting synchronously, so choosing Off is confirmed
 * by staying silent, and choosing Soft or Firm is confirmed by immediately
 * feeling that strength - the row proves the setting took effect the same
 * press it was changed on.
 */
export function HapticsRow() {
  const strength = useSyncExternalStore(subscribeHaptics, getHapticStrength, () => 'firm' as const);

  return (
    <div className="mprow" data-static="">
      <Body title="Haptics" sub="Every press confirms in the hand" />
      <div className="mseg" role="radiogroup" aria-label="Haptics">
        {HAPTIC_STRENGTHS.map((s: HapticStrength) => {
          const on = s === strength;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              className={`mseg__opt${on ? ' mseg__opt--on' : ''}`}
              onClick={() => {
                if (on) return;
                setHapticStrength(s);
                haptics.tap();
              }}
            >
              {HAPTIC_STRENGTH_LABEL[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** KEEP SCREEN AWAKE — on by default, honoured inside `useWakeLock` itself
 *  (see engine/wakeLock.ts); this row only flips the persisted flag. */
export function WakeLockRow() {
  const on = useSyncExternalStore(subscribeWakeLockSetting, getWakeLockSetting, () => true);

  return (
    <button
      type="button"
      className="mprow"
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptics.tap();
        setWakeLockSetting(!on);
      }}
    >
      <Body title="Keep screen awake" sub="While a project is open" />
      <Switch on={on} />
    </button>
  );
}

/** LEFT-HAND MODE — off by default. See shell.css for exactly which rows this
 *  mirrors and, in the PR notes, which real screen controls it does not
 *  reach because they belong to another agent's files. */
export function LeftHandRow() {
  const on = useSyncExternalStore(subscribeLeftHand, getLeftHand, () => false);

  return (
    <button
      type="button"
      className="mprow"
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptics.tap();
        setLeftHand(!on);
      }}
    >
      <Body title="Left-hand mode" sub="Mirrors steppers and the mark keys" />
      <Switch on={on} />
    </button>
  );
}

/** REDUCE MOTION — off by default, meaning "keep following the phone". The
 *  OS preference already runs the app's one reduced-motion rule; this row
 *  only forces the same rule on regardless of what the OS says. */
export function ReduceMotionRow() {
  const on = useSyncExternalStore(subscribeReduceMotion, getReduceMotion, () => false);

  return (
    <button
      type="button"
      className="mprow"
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptics.tap();
        setReduceMotion(!on);
      }}
    >
      <Body title="Reduce motion" sub="Follows the phone; can be forced here" />
      <Switch on={on} />
    </button>
  );
}

/** SOUND - off by default. See clapsound.ts's file header for the full case;
 *  short version: a clap the first time someone opens the app on a live,
 *  hushed set with no warning is exactly the failure this app exists to
 *  avoid, so this stays silent until a crew member opts in here. The clap
 *  itself is also hard-blocked from ever firing while a take is rolling,
 *  regardless of this setting - see clapsound.ts's playClap. */
export function SoundRow() {
  const on = useSyncExternalStore(subscribeSound, isSoundOn, () => false);

  return (
    <button
      type="button"
      className="mprow"
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptics.tap();
        setSoundOn(!on);
      }}
    >
      <Body title="Sound" sub="A clap on new project and finished export" />
      <Switch on={on} />
    </button>
  );
}
