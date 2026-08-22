// Export-error copy tests. `exportFailureMessage` and `exportBuildFailureMessage`
// are the two pure functions `exportGated` (in ProjectScreen.tsx) calls to turn
// a gate failure or a builder throw into a sentence — pulled out specifically so
// the copy can be pinned here without rendering the component. The bug this
// guards against: a bare `catch {}` around the whole export path used to report
// "You're offline" for every failure, including ones where the user plainly
// was not offline.
//
// ProjectScreen.tsx pulls in a lot of unrelated UI (store, exporter, folder
// pickers) at module scope, none of which this file touches — importing it
// exercises only that module-eval path, not any of it.

import { describe, expect, it } from 'vitest';
import {
  exportBuildFailureMessage,
  exportFailureMessage,
  fpsChangeNeedsConfirm,
  fpsChangeWarning,
} from './ProjectScreen';

describe('exportFailureMessage', () => {
  it('offline: navigator says no connection -> the offline sentence, regardless of reason', () => {
    expect(exportFailureMessage({ reason: 'unreachable' }, false)).toBe(
      "You're offline. PDF, Premiere, Resolve and CSV export need a connection. Logging takes and Backup work offline.",
    );
    expect(exportFailureMessage({ reason: 'http_error', status: 500 }, false)).toBe(
      "You're offline. PDF, Premiere, Resolve and CSV export need a connection. Logging takes and Backup work offline.",
    );
  });

  it('unreachable: online, but the request never reached the function -> names likely causes, not "offline"', () => {
    const msg = exportFailureMessage({ reason: 'unreachable' }, true);
    expect(msg).not.toMatch(/offline/i);
    expect(msg).toMatch(/VPN|ad blocker|firewall/i);
  });

  it('HTTP error: online, the function answered with a bad status -> reports the status, not "offline"', () => {
    const msg = exportFailureMessage({ reason: 'http_error', status: 500 }, true);
    expect(msg).not.toMatch(/offline/i);
    expect(msg).toContain('500');
  });

  it('HTTP error with no status still names the server, not the connection', () => {
    const msg = exportFailureMessage({ reason: 'http_error' }, true);
    expect(msg).not.toMatch(/offline/i);
    expect(msg).toMatch(/export server/i);
  });
});

describe('exportBuildFailureMessage', () => {
  it('builder throw: keys the message to the format that actually failed', () => {
    expect(exportBuildFailureMessage('pdf')).toBe('Could not build the PDF file.');
    expect(exportBuildFailureMessage('xml')).toBe('Could not build the Premiere file.');
    expect(exportBuildFailureMessage('resolve')).toBe('Could not build the Resolve file.');
    expect(exportBuildFailureMessage('csv')).toBe('Could not build the CSV file.');
  });
});

// Frame rate used to be write-once, at project creation, in NewProjectSheet.tsx
// / ShotlistSheet.tsx - a gap that had teeth once PODCAST mode started
// skipping the question and inheriting a guess (see newRoll.ts). FpsSection
// (in ProjectScreen.tsx) makes it editable from Setup; these two pure
// functions are the gate and the copy that change carries, pulled out so both
// are pinned here rather than only visible by opening the sheet.
describe('fpsChangeNeedsConfirm', () => {
  it('no pick made yet (draft equals current): never needs a confirm, whatever the take count', () => {
    expect(fpsChangeNeedsConfirm(24, 24, 0)).toBe(false);
    expect(fpsChangeNeedsConfirm(24, 24, 40)).toBe(false);
  });

  it('a real pick, zero takes logged: commits straight off Set - nothing exists yet to reinterpret', () => {
    expect(fpsChangeNeedsConfirm(24, 25, 0)).toBe(false);
  });

  it('a real pick, at least one take logged: needs the named Confirm', () => {
    expect(fpsChangeNeedsConfirm(24, 25, 1)).toBe(true);
    expect(fpsChangeNeedsConfirm(24, 25, 214)).toBe(true);
  });
});

describe('fpsChangeWarning', () => {
  it('names the real fact (durations are real time, not frames) and never says "are you sure"', () => {
    const w = fpsChangeWarning(12, 24, 25);
    expect(w.title).toBe('Change frame rate to 25 fps?');
    expect(w.confirmLabel).toBe('Change to 25 fps');
    expect(w.message).toContain('12 takes already logged');
    // The claim this whole warning rests on: Take.durationMs (types.ts) is
    // milliseconds, not a frame count, so no take is rewritten.
    expect(w.message).toMatch(/won't touch any of them/i);
    expect(w.message).toMatch(/real time, not frame counts/i);
    // What DOES change - every export/*.ts module that reads project.fps -
    // named, not summarised as a vague "everything".
    expect(w.message).toContain('Premiere');
    expect(w.message).toContain('Resolve');
    expect(w.message).toContain('PDF');
    expect(w.message).toContain('CSV');
    // Old rate named too, and what already happened at it is unaffected.
    expect(w.message).toContain('24 fps');
    expect(w.message).not.toMatch(/are you sure/i);
  });

  it('singular take count reads "1 take", not "1 takes"', () => {
    expect(fpsChangeWarning(1, 24, 25).message).toContain('1 take already logged');
    expect(fpsChangeWarning(1, 24, 25).message).not.toContain('1 takes');
  });
});
