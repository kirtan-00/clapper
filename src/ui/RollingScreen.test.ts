// Regression coverage for the last-rolling-camera guard. The owner's report
// on this exact pill was "tapping this cuts the scene" - a solo tap on the
// only camera still rolling was silently closing the whole take. The render
// itself is exercised by scripts/shoot-roll.mjs and a live CDP drive (see the
// task notes); this file pins the pure decision the tap handler asks before
// it fires, the same question soloCut already asks itself (see
// isSoleRollingUnit's own comment in RollingScreen.tsx).

import { describe, expect, it } from 'vitest';
import { isSoleRollingUnit } from './RollingScreen';
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
