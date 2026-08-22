// Regression coverage for the last-rolling-camera guard. The owner's report
// on this exact pill was "tapping this cuts the scene" - a solo tap on the
// only camera still rolling was silently closing the whole take. The render
// itself is exercised by scripts/shoot-roll.mjs and a live CDP drive (see the
// task notes); this file pins the pure decision the tap handler asks before
// it fires, the same question soloCut already asks itself (see
// isSoleRollingUnit's own comment in RollingScreen.tsx).

import { describe, expect, it } from 'vitest';
import { isSoleRollingUnit, rollHeadForm } from './RollingScreen';
import type { CameraUnitLetter } from '../types';

describe('isSoleRollingUnit', () => {
  it('ONE camera rolling: cutting it would end the take, so it is guarded', () => {
    expect(isSoleRollingUnit('A', { A: 1000 }, null)).toBe(true);
  });

  it('TWO rolling: cutting one leaves the other going, so it is not guarded', () => {
    const camRolls: Partial<Record<CameraUnitLetter, number>> = { A: 1000, B: 1000 };
    expect(isSoleRollingUnit('A', camRolls, null)).toBe(false);
    expect(isSoleRollingUnit('B', camRolls, null)).toBe(false);
  });

  it('one camera rolling but sound is too: cutting the camera does not end the take', () => {
    // Sound rides its own state, never a key in camRolls (see the state
    // comment in RollingScreen.tsx) - a camera alone in camRolls is only the
    // last THING rolling when sound is not also going.
    expect(isSoleRollingUnit('A', { A: 1000 }, 1000)).toBe(false);
  });

  it('the letter asked about is not the one rolling: never guarded', () => {
    expect(isSoleRollingUnit('B', { A: 1000 }, null)).toBe(false);
  });

  it('nothing rolling at all: never guarded (nothing to cut)', () => {
    expect(isSoleRollingUnit('A', {}, null)).toBe(false);
  });
});

// Regression coverage for the reported "header still says Recording / take 2
// after a cut" bug. The screenshot it came from turned out to be the podcast
// quick-start slate (literally named "Recording" - see startPodcastRoll in
// newRoll.ts), read as a stuck state word. That is a real risk worth pinning:
// whoever next touches this header could easily gate it on `postCut` instead
// of `rolling`, which WOULD reintroduce a stuck-live header after a cut, and
// a slate that happens to be named "Recording" is exactly the case that would
// hide the regression from a casual look at the screen.
describe('rollHeadForm', () => {
  it('rolling: always the live pill, whatever the slate is named', () => {
    expect(rollHeadForm(true, 'Scene 1', 3)).toEqual({ kind: 'live' });
  });

  it('resting before the first take: the slate name and take 1', () => {
    expect(rollHeadForm(false, 'Scene 1', 1)).toEqual({
      kind: 'resting',
      name: 'Scene 1',
      take: 1,
    });
  });

  it('resting right after a cut: the SAME form, take incremented - never the live pill', () => {
    expect(rollHeadForm(false, 'Scene 1', 2)).toEqual({
      kind: 'resting',
      name: 'Scene 1',
      take: 2,
    });
  });

  it('a slate literally named "Recording" (podcast mode) rests as its own name, not a stuck state word', () => {
    expect(rollHeadForm(false, 'Recording', 1)).toEqual({
      kind: 'resting',
      name: 'Recording',
      take: 1,
    });
    expect(rollHeadForm(false, 'Recording', 2)).toEqual({
      kind: 'resting',
      name: 'Recording',
      take: 2,
    });
    // The one thing that must never happen: rolling=false rendering the live
    // form just because the slate's name reads like one.
    expect(rollHeadForm(false, 'Recording', 2)).not.toEqual({ kind: 'live' });
  });
});
