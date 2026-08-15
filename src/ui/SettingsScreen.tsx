// SETTINGS — the app itself, as opposed to the work in it.
//
// Everything here was previously welded to the bottom of the projects list,
// where it competed with the one thing that screen is for. This is a MOVE, not
// a rewrite: the guide's prose, the restore flow and the feedback mailto are
// the same code, at a new address, re-dressed as grouped inset lists.
//
// Layout furniture comes from ui/list.css via ui/glist.tsx. Colour is signal
// only and arrives from semantic tokens — no raw hex anywhere on this screen,
// because the app is being repainted dark to light underneath it.

import { useEffect, useState, type ChangeEvent } from 'react';
import type { Project } from '../types';
import { restoreBackup } from '../store/restore';
import { parseBackupText } from '../export';
import { Sheet } from './common';
import { Section, Row, LinkRow, ReadRow, ScreenHeader } from './glist';
import { HowToScreen } from './HowToScreen';
import { ThemeToggleRow } from './ThemeToggleRow';
import type { Nav } from './nav';
import { track } from '../net/analytics';
import * as haptics from './haptics';

// Kept in step with package.json by hand. A build-time define would be tidier
// but would mean editing vite.config.ts, and the PWA manifest in there is
// actively being repainted by another change — not worth the merge surface for
// one string.
const APP_VERSION = '0.1.0';

// Feedback goes straight to the maker's inbox — Clapper is an early beta, so a
// prefilled mailto is enough. The body seeds the prompt; the trailing newlines
// drop the cursor onto a blank line ready to type.
const FEEDBACK_MAILTO =
  'mailto:purohit.krick@gmail.com?subject=' +
  encodeURIComponent('Clapper feedback') +
  '&body=' +
  encodeURIComponent(
    "Clapper is an early beta version for testing. Please share your feedback, and tell us: would you use a tool like this? What's missing?\n\n\n",
  );

export function SettingsScreen(props: { nav: Nav }) {
  const [showHelp, setShowHelp] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // ---- the guide's BACK button -------------------------------------------
  // The guide is a `position: fixed` full-window overlay, not a route, which is
  // why Android's hardware BACK used to leave the whole app instead of closing
  // it. It gets its own history entry now, and closing ALWAYS goes through
  // history.back() — the ← button, the tail button and Esc alike — so the
  // history stack and the open/closed state can never drift apart.
  //
  // pushState fires in the HANDLER, not an effect: StrictMode double-invokes
  // effects and would push the entry twice, so the first BACK would do nothing.
  function openGuide() {
    haptics.tap();
    history.pushState({ clapperGuide: true }, '');
    setShowHelp(true);
  }

  useEffect(() => {
    if (!showHelp) return;
    function onPop() {
      setShowHelp(false);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [showHelp]);

  return (
    <div className="app">
      <ScreenHeader title="Settings" />

      {/* First, above Help, on purpose: this is the one setting a crew member
          changes on the day, so it must not sit under documentation. */}
      <Section
        title="Appearance"
        note="Light is the default. Night is for a call time before sunrise, not for a dark room at noon."
      >
        <ThemeToggleRow />
      </Section>

      <Section title="Help">
        <Row label="How to use" value="9 sections" push onClick={openGuide} />
      </Section>

      <Section
        title="Your work"
        note="A backup comes back as a brand new project. Nothing already on this phone is touched."
      >
        <Row
          label="Restore from backup"
          push
          onClick={() => {
            haptics.tap();
            setRestoring(true);
          }}
        />
      </Section>

      <Section
        title="Clapper"
        note="Clapper is an early beta. Tell us what broke and what is missing. It is read by the person who builds it."
      >
        <Row
          label="Send feedback"
          push
          onClick={() => {
            haptics.tap();
            window.location.href = FEEDBACK_MAILTO;
          }}
        />
        <ReadRow label="Version" value={APP_VERSION} mono />
      </Section>

      <Section title="Legal">
        <LinkRow label="Terms" href="/legal/#terms" />
        <LinkRow label="Privacy" href="/legal/#privacy" />
      </Section>

      {showHelp && <HowToScreen onClose={() => history.back()} />}

      {restoring && (
        <RestoreSheet
          onClose={() => setRestoring(false)}
          onRestored={(project) => {
            setRestoring(false);
            // A restored project is work, and work lives on the Projects tab.
            // Reset that stack first so BACK out of the new project lands on
            // the list rather than on whatever was open there before.
            props.nav.switchTab('projects', { reset: true });
            props.nav.push({ name: 'project', project });
          }}
        />
      )}
    </div>
  );
}

// Restore: pick a Backup file (see export/backup.ts) and stand it back up as
// a brand new project. This is the ONLY place a project can enter the app
// without a store.createProject() call directly in view — it goes through
// store/restore.ts instead, because it has to remap ids across four tables,
// not just fill in the create form. Deliberately reachable with no account
// and no network — restoring is exactly what you need when everything else
// has already gone wrong.
function RestoreSheet(props: { onClose: () => void; onRestored: (project: Project) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const text = await file.text();
      const result = parseBackupText(text);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      const project = await restoreBackup(result.envelope.bundle);
      track('project_restored', { takes: result.envelope.bundle.takes.length });
      haptics.tap();
      props.onRestored(project);
    } catch {
      setError('Could not restore that backup. Nothing on this phone was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Restore from backup" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Pick a Backup file (.json) made by this app's Backup button. It comes back as a brand new
        project — nothing already on this phone is touched.
      </p>
      <label className={`btn btn--go btn--full sp-upload${busy ? ' btn--disabled' : ''}`}>
        {busy ? 'Restoring…' : 'Choose backup file'}
        <input type="file" accept="application/json,.json" hidden disabled={busy} onChange={onPickFile} />
      </label>
      {error && <span className="tnum tnum--bad sp-error">{error}</span>}
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose} disabled={busy}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
