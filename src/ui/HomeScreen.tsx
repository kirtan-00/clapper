// HOME — the gateway tab. PLACEHOLDER: the shell wires it, the next agent
// writes it.
//
// What belongs here (from docs/specs/2026-08-14-shell-and-shot-division.md):
//   - New roll as the primary action. One tap from a cold app to a rolling
//     screen, no project-setup ceremony: resume the open shoot day if there is
//     one, otherwise make a scratch project and drop straight in.
//   - Shot division (upload a shotlist), currently buried on the projects list
//     as ScriptPackSheet in ProjectsScreen.
//   - Podcast mode, hidden until Phase 4 rather than shown greyed out.
//   - A resume strip: last project, open shoot day, take count.
//   - InstallNudge, which currently renders at the top of ProjectsScreen.
//
// It has the whole `nav` API: `nav.push({ name: 'rolling', project, slate })`
// puts the roll screen on the HOME stack (the tray unmounts there on its own),
// and `nav.switchTab('projects')` hands off to the list.

import type { Nav } from './nav';
import { Stub } from './Stub';

export function HomeScreen(props: { nav: Nav }) {
  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div>
          <h1>Clapper</h1>
          <p>On-set shot log</p>
        </div>
      </header>

      <Stub
        title="Home"
        lede="The one-tap way into a roll. Nothing on this tab works yet."
        coming={[
          'New roll: cold app to rolling in one tap',
          'Shotlist import, off the projects list',
          'Resume strip: last project, open day, take count',
          'The install prompt',
        ]}
      />

      <button
        type="button"
        className="newproject newproject--ghost"
        style={{ marginTop: 18 }}
        onClick={() => props.nav.switchTab('projects')}
      >
        <span aria-hidden="true">→</span> Go to Projects
      </button>
    </div>
  );
}
