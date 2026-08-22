import { describe, expect, it } from 'vitest';
import { pickStages, type FirstOpen } from './onboardingRules';

/** A cold first open on a signed-out phone browser: everything to ask. */
function firstOpen(over: Partial<FirstOpen> = {}): FirstOpen {
  return {
    signedIn: false,
    standalone: false,
    installDismissed: false,
    done: false,
    rolling: false,
    ...over,
  };
}

describe('pickStages', () => {
  it('asks both questions on a cold first open', () => {
    expect(pickStages(firstOpen())).toEqual(['signin', 'install']);
  });

  it('asks in order: the account first, the home screen second', () => {
    const stages = pickStages(firstOpen());
    expect(stages.indexOf('signin')).toBeLessThan(stages.indexOf('install'));
  });

  // THE ESCAPE HATCH. Dismissing writes the key; the key has to be the end of
  // it, regardless of what else is still true.
  it('asks nothing once dismissed, however much is still unanswered', () => {
    expect(pickStages(firstOpen({ done: true }))).toEqual([]);
  });

  // NEVER MID-SHOOT. Not deferred, not queued behind the cut - nothing.
  it('asks nothing while a roll is up, even on a cold first open', () => {
    expect(pickStages(firstOpen({ rolling: true }))).toEqual([]);
  });

  it('asks nothing mid-roll even when everything else says to ask', () => {
    expect(
      pickStages({
        signedIn: false,
        standalone: false,
        installDismissed: false,
        done: false,
        rolling: true,
      }),
    ).toEqual([]);
  });

  it('drops the account stage for someone already signed in', () => {
    expect(pickStages(firstOpen({ signedIn: true }))).toEqual(['install']);
  });

  it('drops the install stage when already running installed', () => {
    expect(pickStages(firstOpen({ standalone: true }))).toEqual(['signin']);
  });

  // The card this flow replaced wrote `clapper.installNudgeDismissed`. Someone
  // who closed it has answered this question; a new component is not a licence
  // to ask again.
  it('honours an install ask that was already declined', () => {
    expect(pickStages(firstOpen({ installDismissed: true }))).toEqual(['signin']);
  });

  it('asks nothing of a signed-in user who has already installed', () => {
    expect(pickStages(firstOpen({ signedIn: true, standalone: true }))).toEqual([]);
  });

  it('asks nothing of a signed-in user who declined the install', () => {
    expect(pickStages(firstOpen({ signedIn: true, installDismissed: true }))).toEqual([]);
  });
});
