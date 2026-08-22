// Regression coverage for the last-rolling-camera guard. The owner's report
// on this exact pill was "tapping this cuts the scene" - a solo tap on the
// only camera still rolling was silently closing the whole take. The render
// itself is exercised by scripts/shoot-roll.mjs and a live CDP drive (see the
// task notes); this file pins the pure decision the tap handler asks before
// it fires, the same question soloCut already asks itself (see
// isSoleRollingUnit's own comment in RollingScreen.tsx).

import { describe, expect, it } from 'vitest';
import { fitTagGroup, isSoleRollingUnit, rollHeadForm } from './RollingScreen';
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

// Regression coverage for the moments-log guillotine: "0:01 She turns to
// camera" sliced clean through the middle by the clip card underneath it,
// twice reported on this screen in other components and shipped a third
// time here (see .momentlog / .roll--live .momentlog in styles.css). The
// live moments list now reuses this EXACT function - the same one the tag
// pad already used with `cols: 3` / `cols: 1` for its own groups - with
// `cols: 1`, so this suite pins the one guarantee the whole fix rests on:
// a row that does not fit whole never renders at all. The render path
// itself (measuring the real box and the real row) is exercised live by
// `scripts/shoot-roll.mjs --assert`'s bug5 check; this file pins the pure
// decision underneath it.
describe('fitTagGroup (the moments log at cols: 1)', () => {
  const ROW_H = 44; // an arbitrary but representative row height, gap 8
  const GAP = 8;

  it('nothing to show: zero rows, no MORE tile, regardless of budget', () => {
    expect(fitTagGroup(0, 1000, ROW_H, 1, GAP)).toEqual({ visible: 0, moreCount: 0, consumedPx: 0 });
  });

  it('the budget cannot hold even one row: NOTHING renders - not a clipped one', () => {
    // This is the exact case the bug shipped: given a sub-row budget, the
    // old code rendered the row anyway and let `overflow: hidden` crop it
    // mid-glyph. The fix's contract is "whole rows or none", and this is
    // the "none" half of it.
    expect(fitTagGroup(5, ROW_H - 1, ROW_H, 1, GAP)).toEqual({ visible: 0, moreCount: 0, consumedPx: 0 });
  });

  it('every moment fits whole: all visible, no MORE tile spent on nothing', () => {
    // Budget for exactly 3 rows (3*44 + 2*8), only 3 moments logged.
    const budget = 3 * ROW_H + 2 * GAP;
    expect(fitTagGroup(3, budget, ROW_H, 1, GAP)).toEqual({ visible: 3, moreCount: 0, consumedPx: budget });
  });

  it('more moments than fit: the LAST whole row is spent on a "+N more" tile, never a partial one', () => {
    // Budget for exactly 3 rows, 8 moments logged (the count this fix's own
    // shoot-roll.mjs bug5 check taps). One of the 3 rows that fit becomes
    // the MORE tile, so 2 real moments show and the tile says +6 - never a
    // 4th row rendered half-height.
    const budget = 3 * ROW_H + 2 * GAP;
    expect(fitTagGroup(8, budget, ROW_H, 1, GAP)).toEqual({
      visible: 2,
      moreCount: 6,
      consumedPx: budget,
    });
  });

  it('the budget fits one row and a sliver more (not a whole second row): still exactly one whole row', () => {
    // rowH + gap + 1px is one pixel short of a second row's top edge -
    // rowsThatFit must not round that sliver up into a row that would
    // then get cropped.
    const budget = ROW_H + GAP + 1;
    expect(fitTagGroup(5, budget, ROW_H, 1, GAP)).toEqual({
      visible: 0, // 1 row fits, but with 5 items that 1 row is spent on the MORE tile
      moreCount: 5,
      consumedPx: ROW_H,
    });
  });

  it('exactly one row fits and there is exactly one moment: no MORE tile needed', () => {
    expect(fitTagGroup(1, ROW_H, ROW_H, 1, GAP)).toEqual({ visible: 1, moreCount: 0, consumedPx: ROW_H });
  });
});
