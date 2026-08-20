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
import { Sheet, SheetClose, SyncPill } from './common';
import { Section, Row, LinkRow, ReadRow, ScreenHeader } from './glist';
import { HowToScreen } from './HowToScreen';
import { ThemeToggleRow } from './ThemeToggleRow';
import { CutSizeRow, UiSizeRow } from './CutSizeRow';
import { HapticsRow, WakeLockRow, LeftHandRow, ReduceMotionRow } from './PreferenceRows';
import { DefaultTagsRows } from './DefaultTagsRow';
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
    <div className="app mscreen">
      <ScreenHeader title="Settings" />

      {/* The write's status, at hairline volume, on its own line. It is NOT
          in the title bar: measured at 390px, "Offline · logging locally"
          beside a 34px large title overflows the screen inset by 10px, and
          at Glove (1.25x) it is not close. A status that has to be
          abbreviated to fit is a status that stopped saying anything. */}
      <div className="mstatusline">
        <SyncPill />
      </div>

      {/* First, above Help, on purpose: this is the one setting a crew member
          changes on the day, so it must not sit under documentation.

          Every group here used to carry a two-line footnote. They are gone. A
          toggle labelled Light/Night does not need a paragraph about sunrise,
          and the one note with a real consequence (a restore lands as a NEW
          project) now appears inside the restore sheet, where the file picker
          is - at the moment of need rather than on every visit. */}
      {/* Interface size leads the group, above the theme and the CUT key.
          It is the setting that changes every other row on this screen while
          you are looking at it, so it goes where it can be seen doing that. */}
      <Section title="Appearance">
        <UiSizeRow />
        <ThemeToggleRow />
        <CutSizeRow />
      </Section>

      {/* Four "how it behaves in the hand" rows, ported from the approved
          pitch's Settings screen. Its own section, not folded into
          Appearance: these are not about what the app looks like, they are
          about how it responds to a press - a real distinction the moment
          Haptics or Reduce motion sits beside a colour toggle instead of
          under one. */}
      <Section title="Controls">
        <HapticsRow />
        <WakeLockRow />
        <LeftHandRow />
        <ReduceMotionRow />
      </Section>

      {/* Under Appearance, above Help: like the CUT size this is set once and
          then forgotten, but unlike the CUT size it is about the WORK rather
          than the app, so it gets its own group rather than joining the two
          rows about how things look. */}
      <Section title="Quick tags">
        <DefaultTagsRows />
      </Section>

      <Section title="Help">
        <Row label="How to use" value="9 sections" push onClick={openGuide} />
      </Section>

      <Section title="Your work">
        <Row
          label="Restore from backup"
          push
          onClick={() => {
            haptics.tap();
            setRestoring(true);
          }}
        />
      </Section>

      {/* The beta note is not lost: FEEDBACK_MAILTO seeds the same words into
          the message body, where they are a prompt instead of an aside. */}
      <Section title="Clapper" note="© 2026 Clapper. All rights reserved.">
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
        A backup file comes back as a new project. Nothing on this phone is touched.
      </p>
      <label className={`btn btn--go btn--full sp-upload${busy ? ' btn--disabled' : ''}`}>
        {busy ? 'Restoring…' : 'Choose backup file'}
        <input type="file" accept="application/json,.json" hidden disabled={busy} onChange={onPickFile} />
      </label>
      {error && <span className="tnum tnum--bad sp-error">{error}</span>}
      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={busy}>
          Close
        </SheetClose>
      </div>
    </Sheet>
  );
}
