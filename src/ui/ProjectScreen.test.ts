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
import { exportBuildFailureMessage, exportFailureMessage } from './ProjectScreen';

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
