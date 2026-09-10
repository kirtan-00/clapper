import { describe, expect, it } from 'vitest';
import {
  advancesOnAction,
  canStartTour,
  clampStepIndex,
  nextStepIndex,
  shouldOfferTour,
  type TourOfferState,
} from './tourRules';

describe('advancesOnAction', () => {
  it('is true only for on-action steps', () => {
    expect(advancesOnAction('on-action')).toBe(true);
    expect(advancesOnAction('next-button')).toBe(false);
  });
});

describe('nextStepIndex', () => {
  it('steps forward by one', () => {
    expect(nextStepIndex(0, 7)).toBe(1);
    expect(nextStepIndex(5, 7)).toBe(6);
  });

  it('is null past the last step - finished, not an error', () => {
    expect(nextStepIndex(6, 7)).toBeNull();
  });

  it('is null on an already out-of-range index', () => {
    expect(nextStepIndex(7, 7)).toBeNull();
  });
});

describe('clampStepIndex', () => {
  it('leaves an in-range index untouched', () => {
    expect(clampStepIndex(3, 7)).toBe(3);
  });

  it('clamps a negative or out-of-range index into range', () => {
    expect(clampStepIndex(-1, 7)).toBe(0);
    expect(clampStepIndex(99, 7)).toBe(6);
  });

  it('degrades a corrupt (non-finite) value to step zero', () => {
    expect(clampStepIndex(NaN, 7)).toBe(0);
    expect(clampStepIndex(Infinity, 7)).toBe(0);
    expect(clampStepIndex(Number.NaN, 0)).toBe(0);
  });

  it('never returns a negative index when there are no steps', () => {
    expect(clampStepIndex(3, 0)).toBe(0);
  });
});

// NEVER MID-SHOOT. Same promise onboardingRules.test.ts pins for the
// first-open flow, spent here for the tour's own start gate.
describe('canStartTour', () => {
  it('allows starting when nothing is rolling', () => {
    expect(canStartTour(false)).toBe(true);
  });

  it('refuses to start while a real roll is up', () => {
    expect(canStartTour(true)).toBe(false);
  });
});

function offerState(over: Partial<TourOfferState> = {}): TourOfferState {
  return {
    autostart: true,
    tourDone: false,
    onboardingDone: true,
    rolling: false,
    takeCount: 3,
    ...over,
  };
}

describe('shouldOfferTour', () => {
  it('offers when every condition is met', () => {
    expect(shouldOfferTour(offerState())).toBe(true);
  });

  // THE FLAG WINS OVER EVERYTHING. This is the one that keeps
  // TOUR_AUTOSTART = false honest: every other condition can be perfect and
  // the offer still never shows while the constant is off.
  it('never offers while TOUR_AUTOSTART is false, however ready everything else is', () => {
    expect(shouldOfferTour(offerState({ autostart: false }))).toBe(false);
  });

  it('never offers while a real roll is up', () => {
    expect(shouldOfferTour(offerState({ rolling: true }))).toBe(false);
  });

  it('never offers once the tour is already done', () => {
    expect(shouldOfferTour(offerState({ tourDone: true }))).toBe(false);
  });

  it('never offers before onboarding has settled - no stacked prompts', () => {
    expect(shouldOfferTour(offerState({ onboardingDone: false }))).toBe(false);
  });

  it('never offers before the take count is known - conservative on an unread world', () => {
    expect(shouldOfferTour(offerState({ takeCount: null }))).toBe(false);
  });

  it('never offers before the operator has logged a single take - after value, not before it', () => {
    expect(shouldOfferTour(offerState({ takeCount: 0 }))).toBe(false);
  });

  it('offers once at least one real take exists', () => {
    expect(shouldOfferTour(offerState({ takeCount: 1 }))).toBe(true);
  });
});
