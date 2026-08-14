// SETTINGS — PLACEHOLDER: the shell wires it, the next agent writes it.
//
// What moves here (from docs/specs/2026-08-14-shell-and-shot-division.md), all
// of it currently welded to the bottom of ProjectsScreen:
//   - "How to use", the full-window guide (HowToScreen, ProjectsScreen 1115+).
//     Keep its useFullScreenClaim() call — that is what unmounts the tray
//     under it.
//   - Restore from backup (RestoreSheet, ProjectsScreen 866+).
//   - Feedback (FEEDBACK_MAILTO, ProjectsScreen 38+).
//   - App version and the legal links.
//
// Those blocks stay live on the Projects tab until they are moved, so nothing
// is unreachable in the meantime. Move them, do not copy them.

import type { Nav } from './nav';
import { Stub } from './Stub';

export function SettingsScreen(_props: { nav: Nav }) {
  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Settings</h1>
          <p>The app itself</p>
        </div>
      </header>

      <Stub
        title="Settings"
        lede="Still on the Projects tab, at the bottom of the list. Moving here next."
        coming={[
          'How to use, the full guide',
          'Restore from backup',
          'Feedback',
          'App version and legal',
        ]}
      />
    </div>
  );
}
