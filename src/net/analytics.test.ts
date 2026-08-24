// This suite runs under the repo's default (DOM-less) vitest environment —
// see vite.config.ts, no jsdom. That is deliberate here: it is the same
// environment `track()` runs under off the live site (no `window`), and the
// module-scope `visibilitychange` listener at the bottom of analytics.ts must
// survive importing this file with no `document` at all. If that guard ever
// regresses, THIS import throws and the whole suite goes red, not just this
// file — which is the point: analytics must never be able to take anything
// else down with it.

import { describe, expect, it } from 'vitest';
import { currentScreen, restoreScreen, shouldFireSessionEnd, trackScreenView } from './analytics';

describe('shouldFireSessionEnd', () => {
  it('fires when the tab goes hidden and a screen has been recorded', () => {
    expect(shouldFireSessionEnd('hidden', 'rolling')).toBe(true);
  });

  it('does not fire when the tab becomes visible', () => {
    expect(shouldFireSessionEnd('visible', 'rolling')).toBe(false);
  });

  it('does not fire on hidden with no screen recorded yet - nothing navigated before the tab backgrounded', () => {
    expect(shouldFireSessionEnd('hidden', null)).toBe(false);
  });
});

describe('screen tracking', () => {
  it('trackScreenView records the screen and never throws with no window/document', () => {
    expect(() => trackScreenView('home')).not.toThrow();
    expect(currentScreen()).toBe('home');
  });

  it('restoreScreen updates the marker without needing a prior trackScreenView call to have "committed" anything visible', () => {
    trackScreenView('settings');
    restoreScreen('how_to'); // simulate HowToScreen recording itself directly
    expect(currentScreen()).toBe('how_to');
    restoreScreen('settings'); // simulate the guide closing and restoring the underlying screen
    expect(currentScreen()).toBe('settings');
  });

  it('is a plain last-write-wins marker, not a stack', () => {
    trackScreenView('project');
    trackScreenView('rolling');
    expect(currentScreen()).toBe('rolling');
  });
});
