// This suite runs under the repo's default (DOM-less) vitest environment —
// see vite.config.ts, no jsdom. That is deliberate here: it is the same
// environment `track()` runs under off the live site (no `window`), and the
// module-scope `visibilitychange` listener at the bottom of analytics.ts must
// survive importing this file with no `document` at all. If that guard ever
// regresses, THIS import throws and the whole suite goes red, not just this
// file — which is the point: analytics must never be able to take anything
// else down with it.

import { describe, expect, it } from 'vitest';
import {
  currentScreen,
  resolveVisitorId,
  restoreScreen,
  shouldFireSessionEnd,
  trackScreenView,
  visitorId,
} from './analytics';

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

// The anonymous visitor id — the field that turns "how many views" into "how
// many people". Its decision logic is split out as a pure function precisely
// so it can be tested here, with no DOM and no localStorage to fake.
describe('resolveVisitorId', () => {
  const mint = () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('keeps a well-formed id so a returning visitor stays one visitor', () => {
    const existing = '11111111-2222-4333-8444-555555555555';
    expect(resolveVisitorId(existing, mint)).toEqual({ id: existing, isNew: false });
  });

  it('mints one when storage is empty', () => {
    expect(resolveVisitorId(null, mint)).toEqual({ id: mint(), isNew: true });
  });

  it('replaces a truncated or corrupted entry rather than counting it forever', () => {
    // The failure this guards: a half-written value would otherwise be treated
    // as a valid id by every future page load, quietly collapsing many people
    // into one immortal visitor and undercounting uniques with no error.
    for (const junk of ['', 'null', 'undefined', '11111111-2222', 'not-a-uuid-at-all-x']) {
      expect(resolveVisitorId(junk, mint).isNew).toBe(true);
    }
  });

  it('accepts either case, since a hand-edited entry may be upper case', () => {
    const upper = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    expect(resolveVisitorId(upper, mint).isNew).toBe(false);
  });
});

describe('visitorId', () => {
  it('returns null rather than inventing one when storage is unavailable', () => {
    // No `window` in this environment at all. Returning a fresh id here would
    // inflate the unique count by one per page load — the same class of bug
    // that made 79% of this table dev traffic. Null means UNATTRIBUTED.
    expect(visitorId()).toBeNull();
  });
});
